# WiFi / BLE 共存问题排查记录

> 最后更新: 2026-07-24

## 2026-07-24 WebSocket 闭环验证

在新板 MAC `9c:cc:01:65:26:54` 上刷入正式完整固件后，开放热点
`TY_2.4G` 完成关联与 DHCP，取得 IPv4 地址 `192.168.4.101`。局域网端
随后完成以下实机验证：

- `GET /ws` 升级请求返回 `HTTP/1.1 101 Switching Protocols`；
- RFC 6455 Ping 帧收到对应 Pong；
- BLE `@i?` 返回 `wifi state=connected ip=ready` 与
  `ws state=up port=80`。

WebSocket 服务此前虽编译成功但无法监听，实际包含两个独立根因：

1. 默认配置没有启用 `CONFIG_NET_TCP=y`，HTTP server 创建 TCP socket
   后以 `ENOTCONN (107)` 失败；
2. Zephyr 默认只提供一个 eventfd，已被 `NET_SOCKETS_SERVICE` 占用，
   HTTP server 初始化因 `eventfd failed (-12)` 退出。

项目默认配置现已显式启用 TCP，并将 `CONFIG_ZVFS_EVENTFD_MAX` 设为 2；
WebSocket 服务绑定 `0.0.0.0:80`，诊断只在监听 fd 有效时报告 `up`。
CI 与本地验证脚本也会检查这些配置，防止再次生成只能连 WiFi、却不能
提供局域网串口桥的固件。

## 2026-07-20 复查结论

实机复查后发现，原记录漏掉了三个可重现问题：

1. `CONFIG_ESP32_WIFI_STA_SCAN_ALL=y` 只出现在一个临时
   `build-scan-all` 目录中，没有写入 `prj.conf`。当前刷入的
   `build-hotspot` 实际仍使用 fast scan；手动扫描能看到
   `vms-visitor`，但连接时稳定返回 reason 201 (`AP Not found`)。
2. `CONFIG_ESP32_WIFI_STA_AUTO_DHCPV4=y` 时，ESP32 驱动在连接
   成功路径不会发送 `NET_EVENT_WIFI_CONNECT_RESULT`；但应用又依赖
   该事件设置 `wifi_connected` 并手动启动 DHCP。这会导致状态永远
   显示 `off`，也会阻断 WebDAV 上传。
3. WiFi 启动并连接失败后查询 `@i?`，实机在
   `bt_tx_processor` 触发 `mcause: 2, Illegal instruction`，`mepc=0`。
   这证明存在 BLE TX 路径在 WiFi 内存/射频压力下被破坏的第二个
   bug，不能只把问题归结为 AP 认证失败。

本次修复将 scan-all 和单一 DHCP 状态机写入项目默认配置，
同时限制 WiFi buffer 数量、通过 Zephyr `NET_REQUEST_WIFI_PS` 关闭省电，
并对多行 BLE 控制回复加入短间隔。仍需刷入新固件后分别验证
开放网络、WPA2 热点和 WiFi 失败后的 `@i?` 稳定性。

第一轮实机复测表明：BLE TX 节流后，WiFi 失败再查询 `@i?`
已可稳定返回全部 7 行诊断，未再崩溃；但即使开启 scan-all，
`vms-visitor` 仍返回 reason 201。曾尝试把手动扫描中同 SSID 最强
BSSID/信道固定到连接参数，结果仍为 201；而多 AP 网络与手机热点
可能动态切换 BSSID/信道，因此已撤销该策略，继续让驱动自行选 AP。

同时确认了一个前端协议回归：固件将扫描结果扩展为
`SSID security RSSI`后，网页仍将去掉 RSSI 后的整串当作 SSID，
例如实际提交的会是 `vms-visitor open`。前端现在会分离
`security` / `channel` 元数据，只把真实 SSID 填入连接表单。

第二轮用新开启的手机热点 `x` 复测，进一步得到以下结论：

- Zephyr 官方 WiFi shell（不含 Linkr、BLE 和网页）能扫描到 `x`
  （WPA2、约 -37 dBm），但连接后仍立即断开。
- Arduino/ESP-IDF 原厂 WiFi 栈能以约 -41 dBm 找到 `x`，连接时同样
  持续返回 reason 2 (`AUTH_EXPIRE`)，最终状态为 `WL_DISCONNECTED`。
  因此 `x` 的认证失败不在 Linkr 应用层；应先确认热点当前密码仍为
  `12345678`，再用关闭密码的纯 2.4 GHz 热点区分凭据/AP 兼容性与
  板端 WiFi TX 问题。
- Linkr 原扫描逻辑只转发驱动最先回调的 12 条记录；ESP32 回调基本
  按信道出现，导致后面信道上的强热点 `x` 被截掉。现在会先收集全部
  结果、按 SSID 去重并按 RSSI 排序，再返回最强 12 个。实机结果中
  `x` 以 -44 dBm 排名第 2，扫描列表问题已解决。

最终更换 ESP32-C3 Super Mini 后完成闭环验证：

- 旧板 MAC `44:b1:76:17:36:e8` 在 Linkr、Zephyr WiFi shell 和最小
  Arduino/ESP-IDF 固件中均无法关联热点；即使 `x` 已改为开放网络、
  RSSI 为 -41~-44 dBm，仍返回 reason 2。旧板 WiFi TX/天线/供电链路
  存在硬件异常。
- 新板 MAC `9c:cc:01:65:26:54` 刷入相同 Linkr 固件后成功关联开放热点
  `x`，随后完成 DHCP，诊断返回 `wifi state=connected ip=ready error=0`。
- WiFi 连接后的 BLE 多行诊断曾再次使 `bt_tx_processor` 非法指令崩溃。
  将 `CONFIG_BT_TX_PROCESSOR_STACK_SIZE` 从默认 1024 增至 2048 后，连续
  两轮 `@i?` + `@w?` 均完整返回且没有重启。
- DHCP 原先不启动，是因为同一个 `net_mgmt` 回调掩码混合了 WiFi 层与
  IPv4 层事件。拆成两个回调后，连接事件能设置应用状态并启动 DHCP，
  IPv4 地址事件也能独立更新 `ip=ready`。

因此扫描、开放热点连接、DHCP 和 WiFi 连接期间的 BLE 控制链路均已
在新板上通过实机验证。默认启用 WebSocket bridge 的完整固件也完成了
同一 BLE 长连接内的 `connect -> DHCP -> @i? -> @w off -> reconnect ->
DHCP -> @i?` 回归：两次均返回 `connected / ip=ready`，WebSocket 状态为
`up port=80`，BLE 断开后恢复广播。WPA2 仍建议在热点重新启用密码后
补一轮回归。

## 环境

- 硬件: ESP32-C3 Super Mini
- 固件: Zephyr v4.4.1
- WiFi 驱动: esp32 (ESP-IDF WiFi)
- BLE: Zephyr BLE controller
- 目标网络: vms-mi-wifi (authmode=4, WPA/WPA2 mixed)
- 热点测试: SSID="x"（先用 WPA2 定位，最终关闭密码完成连接验证）

## 问题 1: BLE 广播失败 -12 (ENOMEM)

**现象**
- BLE 断开后，重新开始广播时报 `BLE advertising failed: -12`
- 偶尔能恢复，继续广播

**根因**
- ESP32-C3 BLE/WiFi 共用射频和内存池
- 启动 WiFi 驱动后，内部分配了大量 buffer，BLE controller 内存不足
- libc heap 启动时 ~73 kB（WS 已关），WiFi init 后消耗进一步增大
- `CONFIG_BT_CONN_TX_MAX` 之前是 10，controller 报告 12，不匹配

**修复方向**
- 将 `CONFIG_BT_CONN_TX_MAX` 从 10 调整为 12（已在 prj.conf 中：`CONFIG_BT_BUF_ACL_TX_COUNT=12`）
- 减少 WiFi 内存占用（减小 TX buffer、关闭不必要功能）
- WS bridge 需要额外 ~20 kB，启动后 BLE 广播更容易 -12

---

## 问题 2: WiFi 认证失败（reason 2: AUTH_EXPIRE / STA Auth Error）

**现象**
- WiFi 扫描能找到所有 AP（含 vms-mi-wifi、手机热点 "x"）
- 连接命令 `@w=ssid,pass` 返回 0
- ESP32 driver 事件流:
  1. event 43 (WIFI_EVENT_STA_AUTHMODE_CHANGE)
  2. event 2  (WIFI_EVENT_STA_START)
  3. event 5  (WIFI_EVENT_STA_DISCONNECTED), reason=2 (AUTH_EXPIRE)
- 无论目标网络是 vms-mi-wifi（混合模式）还是手机热点 "x"（纯 WPA2），均相同
- BLE 先断开再连 WiFi，结果一样 → **排除 BLE 共存干扰**

**根因分析**

| 假设 | 验证结果 |
|------|---------|
| 密码错误 | ✗ 关闭密码后旧板仍失败 |
| PMF（802.11w）不匹配 | ✗ 打 patch 设 `pmf_cfg.capable=true`，无效 |
| authmode 阈值不对 | ✗ 尝试 WPA_PSK(2)/WPA2_PSK(3)/WPA_WPA2_PSK(4) 均不行 |
| BLE 共存干扰 TX | ✗ BLE 断开后再连，仍然 auth error |
| open 网络 | ✗ 旧板连接 `x` 和 `TY_2.4G` 均失败 |
| WPA3/SAE 模式 | ✗ 启用 CONFIG_ESP32_WIFI_ENABLE_WPA3_SAE 编译失败(mbedtls/hostap 依赖) |
| 板端 WiFi TX/天线/供电 | ✓ 新板使用相同固件和热点成功连接并取得 IPv4 地址 |

**当前结论**: reason 2 的主因是旧板硬件异常，而不是 Linkr、Zephyr、
BLE、密码或热点安全类型。扫描成功只能证明 WiFi RX 正常，不能证明
管理帧 TX 正常。

---

## 问题 3: net_mgmt 事件回调不被调用

**现象**
- driver disconnect handler 执行并 raise `NET_EVENT_WIFI_DISCONNECT_RESULT`
- 但 `wifi_event_handler`（注册为 `net_mgmt_event_callback`）从不被调用
- 即使设置 event mask = `UINT64_MAX` 也从不触发
- 但 scan done 事件 (`NET_EVENT_WIFI_SCAN_DONE`) 能正常触发 `wifi_scan_event_handler`
- 添加 `printk` 到 handler 顶部也看不到输出

**根因**: 回调掩码把 `NET_EVENT_WIFI_*` 与 `NET_EVENT_IPV4_*` 混在
同一个 `net_mgmt_event_callback` 中。两类事件属于不同 net_mgmt layer，
OR 后层标识无法正确匹配。

**修复**: WiFi connect/disconnect 与 IPv4 add/del 分别注册独立回调。
新板实测连接后收到 `WiFi connected to "x"` 和
`WiFi IPv4 address ready`，诊断状态为 `connected / ready`。

---

## 问题 4: WPA3/SAE 编译失败

**现象**
- 启用 `CONFIG_ESP32_WIFI_ENABLE_WPA3_SAE=y` 后编译错误
- 需要 `modules/lib/hostap/port/mbedtls/removed/ecdh.c`
- 添加 `hostap` 到 west.yml 后 `west update` 成功
- 但编译 mbedtls `extras/pkparse.c` 时报 `implicit declaration` 错误（`mbedtls_asn1_get_alg` 等）
- Zephyr v4.4.1 的 mbedtls/tf-psa-crypto 版本与 hostap/esp32 driver 不兼容

**解决方案**
- 升级到 Zephyr 4.4.2+ / 5.x（官方可能已修复 mbedtls 兼容性）
- 或手动 patch mbedtls 兼容层

---

## 问题 5: AP not found (reason 201)

**现象**
- open 网络 `vms-visitor` 和某些配置下 `vms-mi-wifi` 报 reason 201
- 但手动 scan 能找到这些 AP
- connect 内建 scan 找不到 AP

**根因**: 不能再归因于 connect scan。固定手动扫描得到的 BSSID/信道
后仍返回 201；Zephyr 官方 WiFi shell 连接开放网络也失败。

**当前处理**: 保留 `CONFIG_ESP32_WIFI_STA_SCAN_ALL=y`，但不固定 BSSID/
信道。扫描列表改为全量收集后返回信号最强的 12 个唯一 SSID。

---

## 已做的 Zephyr 驱动 Patch

文件: `drivers/wifi/esp32/src/esp_wifi_drv.c`

1. **PMF capable**: `wifi_config.sta.pmf_cfg.capable = true;`（PSK 连接时）
2. **省电模式关闭**: `esp_wifi_set_ps(WIFI_PS_NONE);`（在 `esp_wifi_start()` 之后）
3. **扫描 authmode 日志**: scan 时 `LOG_INF("scan: ssid=%s authmode=%d ...")` 打印原始 authmode（已还原）

---

## 后续回归建议

1. 给热点 `x` 重新开启 WPA2 密码，验证 PSK 连接与凭据持久化。
2. 将旧板标记为 WiFi TX/射频异常样品，不再用它判断固件连接能力。
