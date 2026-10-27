# Linkr Bee 开发指南

> [项目首页](../README.zh-CN.md) | [使用指南](USAGE.zh-CN.md) | [文档索引](README.zh-CN.md) | [English](DEVELOPMENT.md) | [BLE 配件 API 对接文档](LINKR_BLE_API.zh-CN.md)

本文集中说明固件构建与刷写、UART 集成、控制命令、测试模式、客户端工具、
通信协议和 Kconfig 配置。

基于 Zephyr 的 ESP32-C3/C5/WROOM BLE 串口桥应用。第一个里程碑是一个纯粹的蓝牙 LE UART 窗口：

- BLE 外设以 `Linkr Bee XXXX` 广播；`XXXX` 是硬件 MAC 最后四位十六进制
  （所有板型一致，可用 `@n` 改为自定义名）
- 兼容 Nordic UART Service 的 UUID
- BLE RX 特征写入转发到所选 UART
- UART RX 字节通过 BLE TX 通知转发出去

Linkr 端通过上方 BLE 配件 API 文档实现发现、串口、配网和局域网桥接功能；
本仓库负责配件固件及参考客户端。

---

## 目录

- [快速开始](#快速开始)
- [支持环境](#支持环境)
- [构建](#构建)
  - [GitHub Actions 构建与刷写](#github-actions-构建与刷写)
- [UART 选择](#uart-选择)
- [SBC UART 设置](#sbc-uart-设置)
  - [按需自动波特率（ESP32-WROOM）](#按需自动波特率esp32-wroom)
- [WiFi 与 WebDAV 日志上传](#wifi-与-webdav-日志上传)
  - [UART over WebSocket（局域网桥）](#uart-over-websocket局域网桥)
  - [配对 GPIO、持久化与恢复出厂](#配对-gpio持久化与恢复出厂)
- [控制命令参考](#控制命令参考)
- [测试选项](#测试选项)
- [BLE 协议](#ble-协议)
- [BLE 终端](#ble-终端)
  - [Linux 或 Linkr Buildroot 的 C 终端](#linux-或-linkr-buildroot-的-c-终端)
  - [Shell 补全](#shell-补全)
- [Web Bluetooth 终端](#web-bluetooth-终端)
- [手机 App](#手机-app)
- [看门狗与异常恢复](#看门狗与异常恢复)
- [验证状态](#验证状态)
- [配置参考](#配置参考)

---

## 快速开始

5 步完成固件构建和运行：

```sh
# 1. 克隆并进入工作区
git clone https://github.com/radxa/linkr-bee.git
cd linkr-bee

# 2. 构建 ESP32-C3 Super Mini 固件（默认 WiFi + BLE）
west build -b esp32c3_supermini linkr-bee

# 3. 刷写到设备
west flash

# 4. 通过 Python 终端连接
python3 tools/linkr_ble_terminal.py

# 5. 或启动 Web 终端
tools/serve_web.sh  # 打开 http://127.0.0.1:8765/
```

> **注意**：需要 Zephyr v4.4.1 west workspace，且 manifest 中包含 Espressif HAL blobs。详见[构建](#构建)章节。

## 支持环境

- 固件目标：ESP32-C3 DevKitM、DevKitC、Super Mini 与 ESP32-C5 DevKitC
- Zephyr：**v4.4.1**
- 同一份固件源码包含：BLE UART bridge、WiFi station 控制、匿名 HTTP WebDAV
  日志上传与 UART-over-WebSocket 局域网访问。WebDAV 在默认 C3/C5 构建中开启；
  ESP32-WROOM 因 DRAM 不足关闭（`CONFIG_LINKR_BLE_BRIDGE_WEBDAV=n`），主机端仍保留
  该命令并显示板子自己的拒绝原因。

## 构建

请使用 Zephyr v4.4.1 的 west workspace。默认的 WiFi 构建还要求 west manifest
内存在 Espressif HAL blobs（`modules/hal_espressif`）。

在该 workspace 中：

```sh
west build -b esp32c3_devkitm linkr-bee
```

或 DevKitC：

```sh
west build -b esp32c3_devkitc linkr-bee
```

ESP32-C3 Super Mini：

```sh
west build -b esp32c3_supermini linkr-bee
```

ESP32-C5 DevKitC：

```sh
west build -b esp32c5_devkitc/esp32c5/hpcore linkr-bee
```

ESP32-CAM（经典 ESP32，桥接使用 UART0）：

```sh
west build -b esp32_cam/esp32/procpu linkr-bee
```

### GitHub Actions 构建与刷写

`.github/workflows/build.yml` 使用矩阵构建六块板的默认 WiFi + BLE 配置：
`esp32c3_supermini`、`esp32c3_devkitm`、`esp32c3_devkitc`、
`esp32c5_devkitc/esp32c5/hpcore`、`esp32_devkitc/esp32/procpu`
（ESP32-WROOM-32）与 `esp32_cam/esp32/procpu`（ESP32-CAM）。它会在 `main` push、pull request 和手动触发时运行，
使用 Zephyr v4.4.1 与 Zephyr SDK 1.0.1；每个 job 只安装该板需要的工具链
（RISC-V 目标用 `riscv64-zephyr-elf`，WROOM 用
`xtensa-espressif_esp32_zephyr-elf`），不拉取完整 CI 镜像。

项目级发布由 `v*` tag 触发：`.github/workflows/release.yml` 复用本工作流和
桌面构建矩阵，再由 `tools/assemble_release.py` 校验每个产物自带的版本号，
组装固件 ZIP、Web 包、APK 与桌面压缩包。也可以在 tag 上手动词发一次
dry-run，只执行组装、不修改 GitHub release。

从完成的 Actions run 下载与目标板匹配的 artifact，解压后在 macOS 或 Linux 安装
[`esptool`](https://docs.espressif.com/projects/esptool/en/latest/)，
连接设备并执行：

```sh
./flash_firmware.sh
```

连接了多个串口设备时显式指定端口：

```sh
./flash_firmware.sh --port /dev/cu.usbmodemXXXX
```

脚本会按标准镜像名自动选择芯片，并将 C3 写入 `0x0`、C5 写入 `0x2000`、
WROOM / CAM 写入 `0x1000`，
但不执行整片擦除。它只重写镜像覆盖的扇区，因此普通升级会保留 BLE identity
和已保存配置；需要清除它们时使用板型对应的恢复出厂输入。artifact 还包含
`FLASHING.txt`、`firmware.json`、ELF、linker map、
最终 Kconfig、runner metadata 与 `SHA256SUMS`，便于调试和追溯。

## UART 选择

应用从 devicetree chosen 节点 `zephyr,linkr-ble-uart` 读取 UART。提供的
ESP32-C3 overlay 将其绑定到 `uart0`；ESP32-C5 DevKitC overlay 将其绑定到
GPIO11/12 上的 `uart1`。ESP32-CAM overlay 同样绑定 `uart0`：该板只引出
GPIO1 TX / GPIO3 RX 这一对串口，ROM 下载器和桥接共用它，因此烧录和运行使用
同一对线；芯片内部的 UART2 没有引出。若不存在桥专用 chosen 节点，应用回退到
`zephyr,shell-uart`，再回退到 `zephyr,console`。

在 `esp32c3_supermini` 上，`uart0` 用于桥流量：

- RX：GPIO20
- TX：GPIO21
- 活动 LED：GPIO8 蓝色 LED，在 UART 收发活动时闪烁
- 恢复出厂：GPIO0，固件启用内部上拉；启动时可与 GND 短接

## SBC UART 设置

桥在启动时应用 picocom/minicom 风格的 UART 配置。默认为：

- `115200,8,N,1,none`
- 波特率：`CONFIG_LINKR_BLE_BRIDGE_UART_BAUD_RATE`
- 数据位：`CONFIG_LINKR_BLE_BRIDGE_UART_DATA_BITS_*`
- 校验：`CONFIG_LINKR_BLE_BRIDGE_UART_PARITY_*`
- 停止位：`CONFIG_LINKR_BLE_BRIDGE_UART_STOP_BITS_*`
- 流控：`CONFIG_LINKR_BLE_BRIDGE_UART_FLOW_CONTROL_*`

ESP32-C3 Super Mini overlay 目前只接了 RX/TX，因此该板保持流控为 `none`。RTS/CTS 需要额外引脚和板级 pinctrl 支持。

当 `CONFIG_LINKR_BLE_BRIDGE_CONTROL_COMMANDS=y` 时，Management Service v1
接受以下 UART 配置 payload：

```text
@u?
@u=115200,8,n,1,n
@u=1500000,8,n,1,n
@u=115200,7,e,1,n
@h
```

长形式也可用：`@linkr uart?`、`@linkr uart=115200,8,n,1,none`、`@linkr help`。

响应通过独立的 Management Response indication 回传，并携带相同 request ID：

```text
OK uart=115200,8,N,1,none
ERR format: @u=115200,8,n,1,n
```

### 按需自动波特率（ESP32-WROOM）

WROOM 构建支持 `CONFIG_LINKR_BLE_BRIDGE_UART_AUTOBAUD`，但板级默认关闭
（`=n`），发布镜像不会自行改写串口参数。需要时在构建中显式打开；即使打开，
检测器启动后也保持 idle，不会自动跟随线速率，需要时再启动：

```text
@a?          查询：OK autobaud state=idle|running baud=... timeout_ms=5000
@a           启动一次检测（也接受 @a start）
@a stop      取消正在运行的检测
```

每次检测采样一个 400 ms 的 RMT 窗口，连续两个窗口一致后才调用
`uart_configure()`。检测在确认匹配（`applied` 或 `unchanged`）、重新配置失败
（`error`）、连续 5 秒没有可测量捕获（`timeout`）或收到 `@a stop`（`stopped`）
时结束。每次捕获，以及每次采样到线路处于活动电平，都会重置 5 秒计时，因此
仍在通信的线路不会因短时空闲被误停，即使它的间隔短到接收器无法开始捕获。
60 秒硬上限仍会终止一条始终不安静的线路。一次检测结束后不会自动重启。

启动命令的 response 不带 `FINAL`；结果稍后以同一 request ID 的 type=3
Management Event 返回，并带 `FINAL`：

```text
@event autobaud state=applied old=115200 new=1500000
@event autobaud state=unchanged old=115200 new=115200
@event autobaud state=timeout old=115200 new=115200
@event autobaud state=stopped old=115200 new=115200
@event autobaud state=error old=115200 new=57600
```

WROOM overlay 将低有效的 `linkr-autobaud` 按键映射到 GPIO13；按下按键启动同一
次检测，但没有 request ID，结果只写日志。GPIO2 继续作为板载低有效活动 LED，
LED 与按键不再共用引脚。GPIO2 现在是输出，不能再把按键或跳线接到 GND，否则会
短路 LED 输出；按键必须接 GPIO13。GPIO13 不是启动 strapping 引脚，但复位时不要
按住该键，否则固件启动后会立即触发一次检测。

## WiFi 与 WebDAV 日志上传

固件源码同时包含 WiFi、WebDAV 和 WebSocket。WebDAV 在默认 ESP32-C3/C5 构建中
开启；ESP32-WROOM 因 DRAM 预算不足关闭（`CONFIG_LINKR_BLE_BRIDGE_WEBDAV=n`）。
该功能仍属于协议的一部分，因此主机端保留命令，并在缺少该功能的板子上显示板子
自己的拒绝原因。WiFi 无线电默认关闭，直到用户发送 `@w=ssid,pass`；未配网设备仍可
直接作为 BLE UART bridge 使用，不再需要单独的纯 BLE 镜像。

WiFi 凭据默认只保存在 RAM，重启即丢失。仅在量产设备已经启用 secure boot 和 flash encryption 时，才应设置 `CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y`：该选项会将 PSK 写入 Zephyr settings/NVS；未加密 flash 上可被读取。启用后才会在重启时自动连接。匿名 WebDAV URL 和上传 boot 计数器独立持久化，避免重启后文件名冲突。

普通 C3 构建即包含：

```sh
west build -b esp32c3_supermini linkr-bee
```

ESP32-C3 SoC WiFi 驱动是 `CONFIG_WIFI_ESP32`（定义于 `drivers/wifi/esp32/Kconfig.esp32`），它会自动 select L2/ethernet/mgmt 层和 MBEDTLS。STA 模式由 `CONFIG_WIFI_USAGE_MODE_STA` choice 选择。

两个 workspace 前置条件（非 Kconfig）：

- west manifest 必须包含 `modules/hal_espressif` —— `CONFIG_WIFI_ESP32` 依赖 `ZEPHYR_HAL_ESPRESSIF_MODULE_BLOBS`。
- 板级 devicetree 必须启用 `wifi` 节点。`esp32c3_devkitm` 和 `esp32c3_devkitc` 已在板级 DTS 中 `&wifi { status = "okay"; };`；`boards/esp32c3_supermini.overlay` 为 Super Mini 补加。

`src/wifi.c` 中的应用代码使用标准 `net_mgmt` / `wifi_mgmt` API（`NET_REQUEST_WIFI_CONNECT`、`NET_EVENT_WIFI_CONNECT_RESULT`），并在连接成功时自行启动 DHCPv4，因此无需 `CONFIG_NET_CONFIG_AUTO_INIT`。

### UART over WebSocket(局域网桥)

WiFi 拿到 IP 地址后,固件还会把桥接 UART 暴露为 WebSocket 端点,局域网客户端可完全绕过 BLE 的距离与 MTU 限制:

- 端点:`ws://<设备 IP>/ws`(端口由 `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_PORT` 决定,默认 80)
- 协议:二进制 WebSocket 帧双向承载原始 UART 字节,没有任何额外封装——发什么就写进 UART,UART 收到什么就广播给所有已连接客户端
- 客户端数:最多 `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_MAX_CLIENTS` 个(默认 2),每个客户端独立 TX 环形缓冲;慢客户端丢弃最旧数据,不会拖慢桥
- 运行时控制:`@s on|off|?`、`@s token…`;开关状态与局域网访问令牌都持久化到 settings。`@i?` 诊断包含 `@info ws state=up port=80 clients=N tx=… rx=… dropped=…`（不含令牌;`dropped` 在客户端连接时清零）
- 局域网访问令牌:首次启动生成 128 位随机令牌并保存,默认不再对全网开放。`@s?` 经加密 BLE 通道返回,`@s token` 重新生成,`@s token=<32 位十六进制>` 指定,`@s token off` 回到无鉴权。握手协议见 [BLE 配件 API v1](LINKR_BLE_API.zh-CN.md) 第 8 节
- 兼容开关:`CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN`（32 位小写十六进制）用于产线固定令牌,优先级高于自动生成
- 可选门槛:`CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN` 要求客户端在 3 秒内把 token 作为首条文本帧发送
- 整体关闭:`-DCONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE=n`

Web 终端(`web/`)的「连接」卡片里有 BLE/局域网切换;局域网模式连接 `ws://<主机>/ws`,终端输入、快捷命令、计数器照常工作,仅 BLE 专属的控制按钮(`@u`/`@w`/`@d`/`@i?`)被禁用。当 BLE 诊断拿到 IP 时,局域网地址输入框会自动预填。WebDAV 日志上传并行运行不受影响。

出厂构建在所有板型上启用 `CONFIG_LINKR_BLE_BRIDGE_UART_RX_DROP_NO_CONN=y`。
BLE 会话断开后，UART 采集继续向 WebSocket 客户端和日志上传器转发；
BLE 路径丢弃的数据不会在重连后补发。

ESP32-CAM 构建启用
`CONFIG_LINKR_BLE_BRIDGE_BLE_TX_DECOUPLE=y`。原先唯一的 UART-to-BLE 线程会
阻塞在 Reliable UART indication 上，而它同时负责喂给局域网桥和日志环，所以
中心设备调度慢时，只用局域网的 TUI 或浏览器也会缺字节。解耦后该线程只把数据
送入日志、WebSocket 和一个小队列，BLE 副本由独立发送线程处理，indication
等待期间 UART 环照常排空。队列满时，发送线程会在当前 chunk 发完后断开中心
设备，让客户端重新同步，而不是静默跳过序号；局域网输出不受影响。该板型的
UART RX 环为 20480 字节，以便队列与它一起放下。ESP32-WROOM-32 保持上游的
同步路径和 16384 字节 RX 环不变，C3/C5 也不变。

### 配对 GPIO、持久化与恢复出厂

固件启用 LE Secure Connections Just Works 配对、绑定和加密 GATT 访问。
C3/C5 在新增主机或替换旧密钥时，需要在请求到达前将 GPIO1 拉低。WROOM 的
board conf 默认 `CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=n`，不需要按
GPIO4；只有把该选项设为 `y` 时，GPIO4 才作为物理授权输入。已有绑定的加密
重连无需操作配对 GPIO。默认最多保存 8 台主机，不自动淘汰旧绑定；满后通过
恢复出厂清空。接线、客户端操作和验收方法见[蓝牙配对](BLE_PAIRING.md)。

C5 DevKitC 需要在 GPIO1 外接按钮或跳线；板载 BOOT 和 RST 不能用于配对授权。
正式构建保留 GPIO 检查。仅在受控的 C5 台架测试中，才可显式加载独立开发配置，
并使用单独的构建目录：

```sh
west build -p always -d build-c5-open-pairing \
  -b esp32c5_devkitc/esp32c5/hpcore linkr-bee -- \
  -DEXTRA_CONF_FILE=dev_c5_open_pairing.conf
```

此镜像允许附近任何主机配对后访问串口和管理服务。加密、Secure Connections 和
绑定仍是必需的，但不能据此核验主机是否为授权所有者。不要分发此镜像，也不要
将其留在共享环境中上电。普通构建和发布 CI 不加载该片段。正式固件请使用不带
此片段的默认构建命令，且不要复用上述开发构建目录。

| 项目 | 默认值 / 持久化规则 | 清除或移交方式 |
| --- | --- | --- |
| BLE 绑定 | `CONFIG_BT_SETTINGS` 在 NVS 中保留最多 8 台主机密钥 | 板级恢复出厂同时清除全部绑定和其他设置 |
| BLE identity/address | 随机静态 Linkr identity 持久化在 NVS，正常重启继续复用 | 板级恢复出厂会生成新的 identity/address，避免系统沿用旧缓存；默认名 `Linkr Bee XXXX` 来自硬件 MAC，不随地址或恢复出厂变化 |
| WiFi SSID/PSK | 默认仅 RAM；`CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y` 才保存并在启动时重连 | `@w off` 停用并断开；恢复出厂会擦除 |
| WebDAV 目标 | 匿名 URL 独立于 WiFi 凭据持久化设置，默认也会保存 | `@d off` 停用；恢复出厂会擦除 |
| 上传 boot ID | 上传器分配新的 boot ID 时保存，避免重启后复用文件名 | 恢复出厂会擦除 |

保存的 WiFi 和 WebDAV 配置都是单条、带版本的 settings 记录；启动时会忽略无效或不安全的记录。凭据持久化 Kconfig 是量产前提，不是运行时检测：只有在 secure boot 与 flash encryption 确实已完成烧录时才能开启。未加密设备把 SSID/PSK 写入 NVS 后，仍可能被从 flash 读取。`@w off` 是功能性清除，不是经过验证的安全擦除；设备报废或重新配置时应使用恢复出厂。

恢复出厂时，在设备复位或上电后将恢复输入与 GND 短接并持续保持两秒：C3
使用 GPIO0，C5 DevKitC 使用 GPIO28/BOOT，WROOM 使用 GPIO27。固件会在 Bluetooth 与 settings
加载前擦除整个 `storage_partition`，清除 Bluetooth identity 数据、Linkr 的
WiFi/WebDAV 配置和上传 boot 计数器，并生成新的随机静态 BLE
identity/address。不要让恢复输入永久接地，并将该焊盘或按键的物理访问视为
恢复出厂权限。该操作不会擦除固件、测试 marker 分区或 coredump 存储。

Python、C 与 Web Bluetooth 客户端都会直接发送管理命令；`--pair` 仅作为兼容参数保留，当前是无操作。WebDAV 上传器也只接受匿名 HTTP，因此只能在可信局域网使用。

UART RX 字节（SBC console 输出）会被缓存，并定期 HTTP PUT 到 `<webdav_url>log-<boot-id>-<sequence>-<uptime>.txt`。上传会等待 IPv4 地址、重试连接失败、为失败批次保留稳定文件名；更改目标或停用时会丢弃已排队旧数据。

## 控制命令参考

所有命令支持短形式（可放进 MTU 交换前默认 20 字节 BLE 写入）和长形式（`@linkr ...`）。

### 诊断命令

| 短形式 | 长形式 | 说明 |
|--------|--------|------|
| `@i?` | `@linkr info?` | 读取设备诊断信息（固件版本、运行时间、UART 统计、WiFi 状态、WebDAV 计数器） |
| `@h` | `@linkr help` | 列出可用命令 |

### WiFi 命令

| 短形式 | 长形式 | 说明 |
|--------|--------|------|
| `@w scan` | `@linkr wifi scan` | 扫描附近 2.4 GHz WiFi（加密 BLE） |
| `@w?` | `@linkr wifi?` | 查询 WiFi 状态 |
| `@w=SSID,pass` | `@linkr wifi=SSID,pass` | 连接 WiFi（默认仅保存到 RAM） |
| `@w off` | `@linkr wifi off` | 清除 WiFi 配置并断开 |

### WebDAV 命令

| 短形式 | 长形式 | 说明 |
|--------|--------|------|
| `@d?` | `@linkr webdav?` | 查询 WebDAV 状态 |
| `@d=URL` | `@linkr webdav=URL` | 设置匿名 WebDAV 目标并启用上传 |
| `@d off` | `@linkr webdav off` | 停用 WebDAV 上传 |

### WebSocket 命令

| 短形式 | 长形式 | 说明 |
|--------|--------|------|
| `@s?` | `@linkr socket?` | 查询 WebSocket 桥状态（含局域网令牌） |
| `@s on` | `@linkr socket on` | 启用 WebSocket 桥 |
| `@s off` | `@linkr socket off` | 停用 WebSocket 桥 |
| `@s token` | `@linkr socket token` | 生成并保存新的局域网访问令牌 |
| `@s token=<32 位十六进制>` | `@linkr socket token=<32 位十六进制>` | 指定局域网访问令牌 |
| `@s token off` | `@linkr socket token off` | 关闭局域网鉴权（允许未认证访问） |

### BLE 名称命令（所有板型）

| 短形式 | 长形式 | 说明 |
|--------|--------|------|
| `@n?` | `@linkr name?` | 查询当前广播名及是否为自定义名 |
| `@n=<name>` | `@linkr name=<name>` | 设置并持久化 1–29 字节 UTF-8 名称；支持中文和 emoji（每个 emoji 通常 4 字节） |
| `@n default` | `@linkr name default` | 删除自定义名，恢复 `Linkr Bee XXXX` |

`XXXX` 是硬件 MAC 最后四位十六进制（例如 `58:BF:25:33:07:8C` → `078C`）。
名称限制按 UTF-8 字节数而不是字符数：可以使用中文，也可以使用 emoji（常见
emoji 占 4 字节，7 个正好 28 字节，8 个就会超过 29 字节上限）。控制字符和非法
UTF-8 会被拒绝。当前固件的名称只用于显示：主机必须按 Management Service UUID
发现，并在连接后校验 Device ID，不能按广播名匹配。TUI 和 Web 保留一个很窄的
兼容例外：没有 Management Service、只有 NUS 且固定名为 `Linkr BLE UART...` 的
旧固件按仅终端设备处理；新式 `Linkr Bee...` 名称没有服务时一律拒绝。

**地址是身份，名字是标签。** 名字随时可以被改，所以名字不能用来认板子：

- 板子靠它广播的 Management Service 被**找到**，靠 BLE 地址被**连上**；
- 板子的**名字**取自它自己对 `@n?` 的回答，客户端显示的就是这个。桌面终端
  在链路建立后立刻问一次板子，每次改名后也再问一次，所以在别的客户端里改
  过名的板子，下一次连上就显示新名字；
- 给了名字却没匹配上时，客户端会列出听到的板子，并说明怎么用地址连上；
- 改名后板子会立刻广播新名字：扫描响应在开始广播时被拷进控制器，所以固件
  在装上新名字后会重启一次广播。

每个主机客户端都提供同样的三个操作：

| 客户端 | 读取 | 设置 | 恢复默认 |
| --- | --- | --- | --- |
| `bee`（TUI） | 网络视图 → *读取名称* | 网络视图 → *修改名称* | 网络视图 → *恢复默认* |
| `bee-cli` | `--query-ble-name` / `query ble-name` | `--rename-ble NAME` / `set ble-name NAME` | `--reset-ble-name` / `set ble-name default` |
| `bee --serve` | `{"op":"ble-name"}` | `{"op":"ble-name","name":"…"}` | `{"op":"ble-name","default":true}` |
| `linkr_ble_terminal.py` | `--query-ble-name` | `--rename-ble NAME` | `--reset-ble-name` |
| `linkr_ble_terminal_c` | `--query-ble-name` | `--rename-ble NAME` | `--reset-ble-name` |
| Web / 手机 | 设备旁的 *BLE 名称* 控件 | 同左 | 同左 |

桌面与手机客户端先向板子查询（`@n?`），并区分 MAC 默认名与自定义名；写入后
由板子确认并回读。C 客户端把板子的回答打印到标准输出。

### UART 命令

| 短形式 | 长形式 | 说明 |
|--------|--------|------|
| `@u?` | `@linkr uart?` | 查询 UART 设置 |
| `@u=baud,data,parity,stop,flow` | `@linkr uart=...` | 设置 UART 模式 |

### 自动波特率命令（ESP32-WROOM）

| 短形式 | 长形式 | 说明 |
|--------|--------|------|
| `@a?` | `@linkr autobaud?` | 查询检测器状态和当前波特率 |
| `@a` / `@a start` | `@linkr autobaud` / `@linkr autobaud start` | 启动一次按需检测 |
| `@a stop` | `@linkr autobaud stop` | 取消正在运行的检测 |

启动 response 不带 `FINAL`；结果以同一 request ID 的 `FINAL` type=3
`@event autobaud ...` 返回。状态机和 GPIO13 按键说明见
[按需自动波特率](#按需自动波特率esp32-wroom)。

### 响应格式

响应通过 Management Response indication 回传：

```text
OK wifi=connected,ssid=MySSID
OK webdav=on,url=http://host/dav/
OK uart=115200,8,N,1,none
ERR format: @u=115200,8,n,1,n
```

诊断命令是只读操作。它会返回应用与 Zephyr 版本、运行时间、开放的 BLE
访问/安全状态、UART 缓冲区使用量和丢字节数、WiFi/IP 状态、WebSocket 客户端
与丢弃计数，以及 WebDAV 队列、丢弃、HTTP、失败和成功计数。queue 和 rel
分组分别提供 UART 发送队列丢弃和 BLE indication 耗时：

```text
@info fw version=0.1.2 zephyr=4.4.1
@info sys uptime_ms=123456 owner=0 security=1
@info uart dropped=0 dropped_no_conn=0 buffer=0/16384
@info wifi state=connected ip=ready error=0
@info upload state=on queue=0 dropped=0 http=201 failures=0 successes=4
@info ws state=up port=80 clients=1 tx=1234 rx=5678 dropped=0
@info queue dropped=0
@info rel ind=0 retry=0 busy=0 nomem=0 slept_ms=0 timeout=0 wait_max_ms=0
@info done
```

缓冲区大小和启用的服务以具体板级配置为准。

应用版本由 `CONFIG_LINKR_BLE_BRIDGE_FIRMWARE_VERSION` 设置。

从 Python 终端：

```sh
python3 tools/linkr_ble_terminal.py --query-info --no-terminal
python3 tools/linkr_ble_terminal.py --wifi-scan --no-terminal
python3 tools/linkr_ble_terminal.py --wifi MySSID,secret --query-wifi
python3 tools/linkr_ble_terminal.py --webdav http://host/dav/
```

广播名的读取与修改在所有主机上用法一致：

```sh
python3 tools/linkr_ble_terminal.py --query-ble-name --no-terminal
python3 tools/linkr_ble_terminal.py --rename-ble '测试😀' --no-terminal
python3 tools/linkr_ble_terminal.py --reset-ble-name --no-terminal
```

名称为 1–29 个 UTF-8 字节，主机先本地校验再发送，因此中文和 emoji 可用，
固件会拒绝的名称在接触射频之前就会失败。修改会写入板子的 settings，重启后
仍然保留；`--reset-ble-name` 恢复由硬件 MAC 生成的 `Linkr Bee XXXX`。

脚本化与安全注意事项：

- `--json` 把管理响应与事件按行输出为 JSON，例如
  `{"type":"response","requestId":1,"ok":true,"lines":["OK fw version=0.1.2"],"command":"@i?"}`；
  `@w=`/`@d=` 这类命令在 JSON 里的 `command` 字段始终是 `<redacted>`。
- `--quiet` 只抑制进度信息（`linkr: …`），错误与 `loopback PASS/FAIL` 仍然输出。
- `--help` 与 `--version` 不需要安装 bleak，只有真正访问设备时才导入它。
- 密码不进 argv：用 `--wifi SSID --wifi-key-file PATH`，或环境变量
  `LINKR_WIFI_PASSWORD`，或在终端上前提下交互输入。`--wifi SSID,PASSWORD` 仍然可用，
  但会出现在 `ps` 输出里。
- `--uart` 在本地校验（baud 300–3000000、data 5–8、parity n/o/e、stop 1/2、
  flow n/rtscts），不合法就直接报错退出，不发往设备。
- 退出码：`0` 正常、`1` 错误、`2` 参数问题、`3` 终端会话期间设备断开。

配置命令使用 Management Service v1 二进制帧，包含 API 版本、request ID、
逻辑长度、response ID 和 confirmed indication 分片。NUS 现在只转发原始 UART。
完整格式、WiFi 异步完成事件、Device ID 与 Reliable UART 序号见
[Linkr Bee 配件 API v1](LINKR_BLE_API.zh-CN.md)。

当前上传器只接受匿名 HTTP 端点。固件会拒绝 Basic Auth 凭据，避免密码通过明文 HTTP 暴露在网络上。该模式仅适用于可信局域网；需要认证或公网部署时，应使用后续支持 HTTPS 且预置 CA 信任锚的构建。

Web Bluetooth 终端提供独立的 SSID/密码输入框、WiFi 扫描列表、设备诊断和
WebDAV 控制。Python 客户端提供相同的 Management v1 自动化操作。

## 测试选项

所有测试选项默认关闭。

运行可重复执行的本地回归检查：

```sh
tools/verify.sh
```

它会构建全部受支持的固件板型、检查 Python 与 shell 语法，并在存在 `dbus-1`
开发文件时编译 C 参考终端；它不运行 Web/手机端测试套件，也不构建原生工程的
Web 资源——这些由 CI（`.github/workflows/build.yml`）覆盖。

启用 UART RX 回环：

```sh
west build -b esp32c3_devkitm linkr-bee -- \
  -DEXTRA_CONF_FILE=test_uart.conf
```

`test_uart.conf` 当前同时启用 UART RX 回环和周期性 UART TX 帧。若只想要其中一条路径，构建前复制该文件并删除不需要的选项：

- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_ECHO=y`
- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX=y`
- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_INTERVAL_MS=1000`
- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_PAYLOAD="linkr-ble-uart-test\r\n"`

将 UART0 TX（GPIO21）和 RX（GPIO20）短接后，可构建硬件回环验证镜像：

```sh
west build -p always -b esp32c3_devkitm linkr-bee -- \
  -DEXTRA_CONF_FILE=test_loopback.conf
```

使用同一完整固件功能集的 BLE NUS echo 诊断不需要 UART 接线：

```sh
west build -p always -b esp32c3_supermini linkr-bee -- \
  -DEXTRA_CONF_FILE=test_ble_echo.conf
```

两种诊断模式都使用独立的 `linkr-test-marker` flash 分区，不会写入 ESP32-C3 的
coredump 扇区。

## BLE 协议

### 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    主机端 (Python/Web/C)                      │
├─────────────────────────────────────────────────────────────┤
│  Management Service v1    │    Reliable UART Service v1     │
│  - API 版本管理           │    - 序号                        │
│  - Device ID (只读)       │    - 写确认                      │
│  - 请求/响应 ID           │    - 确认 indication             │
│  - 异步事件               │    - 重连去重                    │
├─────────────────────────────────────────────────────────────┤
│                    BLE GATT (ATT MTU 247)                    │
├─────────────────────────────────────────────────────────────┤
│             ESP32-C3/C5 固件 (Zephyr v4.4.1)                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  BLE 协议栈  │  │  UART 桥接  │  │  WiFi/WebSocket     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 服务 UUID

| 服务 | UUID | 说明 |
|------|------|------|
| Management Service v1 | `4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001` | API 版本、Device ID、配置命令 |
| Management Protocol | `4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001` | 读取协议版本和能力位 |
| Management Device ID | `4c4b0003-9a7e-4f4e-8b8a-3d6f12a0c001` | 读取稳定设备标识 |
| Management Command | `4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001` | 写入带帧请求 |
| Management Response | `4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001` | indication 带帧响应和事件 |
| Reliable UART Service v1 | `4c4b0010-9a7e-4f4e-8b8a-3d6f12a0c001` | 可检测丢包的串口传输 |
| Reliable UART RX | `4c4b0011-9a7e-4f4e-8b8a-3d6f12a0c001` | 主机 → 设备带帧写入 |
| Reliable UART TX | `4c4b0012-9a7e-4f4e-8b8a-3d6f12a0c001` | 设备 → 主机确认 indication |
| Reliable UART State | `4c4b0013-9a7e-4f4e-8b8a-3d6f12a0c001` | 读取序号和 payload 限制 |
| 兼容 Nordic UART Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | 兼容旧版客户端的串口服务 |
| 兼容 Nordic UART RX | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | 主机 → 设备无帧写入 |
| 兼容 Nordic UART TX | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | 设备 → 主机通知 |

### 数据流

```
┌──────────────┐     BLE 写入      ┌──────────────┐     UART TX     ┌──────────────┐
│  BLE 中心    │ ─────────────────> │  ESP32-C3    │ ──────────────> │  SBC/设备    │
│  (手机/PC)   │ <───────────────── │  桥接器      │ <────────────── │  (控制台)    │
└──────────────┘   BLE 通知        └──────────────┘    UART RX      └──────────────┘
```

### MTU 与帧格式

- **ATT MTU**: 247 字节（协商值）
- **LE Data Length**: 251 字节
- **Reliable UART 帧**: 12 字节帧头 + 最多 232 字节 UART 数据
- **回退**: 20 字节分片（用于较小 MTU 协商）

主机终端连接时会打印检测到的写入块大小。

## BLE 终端

`tools/linkr_ble_terminal.py` 是当前主机侧参考客户端。它连接 Linkr Bee，
核对 Management API v1 和 Device ID，使用 Reliable UART 传输终端字节，并将
管理响应与串口输出分开。广播名只用于显示；默认名为 `Linkr Bee XXXX`，其中
`XXXX` 是硬件 MAC 最后四位十六进制。

按需安装主机依赖（`--help` / `--version` 不需要）：

```sh
python3 -m pip install bleak
```

- `--scan` 列出**全部**附近设备（无名设备显示 `(unknown)`）并带上 RSSI；列完就退出，
  除非同时给了其它动作或 `--address`（这时会复用这份扫描结果去连接，不会重扫）。
- 终端模式下，CLI 在检测到**空闲 shell 提示符**时向目标机发送 `stty rows/cols`
  （判定规则与命令串和 Web 端 `web/terminal_geometry.js` 一致），并在窗口变化
  （SIGWINCH）后重发；提示符不空闲就不发，避免把这条命令喂给正在运行的程序。
- 终端会话中设备中途断开以退出码 `3` 结束；用户按退出键（默认 `Ctrl-]`，
  提示语跟随 `--escape`）是 `0`。

### Linux 或 Linkr Buildroot 的 C 终端

`tools/linkr_ble_terminal.c` 提供仅 Linux 的 C 参考实现。它通过系统 D-Bus 直接用 `libdbus-1` 与 BlueZ 通信，不依赖 GLib。这使用户态依赖很小，但仍需要底层可用的 Linux BLE 中心栈。该程序的终端部分仍是 legacy NUS，广播名则走 Management Service v1：`--query-ble-name`、`--rename-ble NAME`、`--reset-ble-name` 会先读取 Protocol Info 和 Device ID，在只有 NUS 的旧固件上会被拒绝。其余 Management v1 控制（WiFi、WebDAV、UART）和 Reliable UART 请使用 Python 或 Web 参考客户端。

运行时路径：

```text
linkr_ble_terminal_c
  -> libdbus-1
  -> dbus-daemon --system
  -> bluetoothd / org.bluez
  -> hci0
  -> AIC8800D80 BT UART/HCI
```

在装有 BlueZ 开发文件的桌面 Linux 上：

```sh
cd tools && make
./linkr_ble_terminal_c --help
./linkr_ble_terminal_c
```

参数面与 Python 客户端对齐，脚本可以同等对待两者：

- 退出码 `0` 正常、`1` 错误、`2` 参数问题、`3` 终端会话中设备断开；
  之前的参数错误也是 `1`，与"连不上设备"没法区分。
- `--version`；`--quiet` 只压进度信息，错误始终输出。
- 长短选项都接受 `--opt=value` 写法；缺值时报 `--opt requires a value`，
  不再是误导性的 `unknown option`。
- `--help` 走 stdout（错误与用法提示走 stderr）；参数错误会提示 `--help`。
- `--escape '^'` 这种不完整的转义被拒绝（以前被当成字面量 `^` 接受）；
  退出提示会跟着 `--escape` 变，不再永远写 `Ctrl-]`。
- `--scan` 列出**全部**附近设备（无名设备显示 `(unknown)`），列完就退出，
  除非同时给了其它动作或 `--address`。
- `--log-file` 打不开时在连蓝牙之前就失败（以前只是警告然后继续，日志静默丢失）。
- 名字匹配规则：精确名优先，其次前缀；同类里优先广播了 NUS 服务的设备。

对应的测试在 `tests/test_terminal_cli_c.py`：纯函数（参数校验、名字前缀、
转义命名、Enter 转换）由宿主 harness 直接编译源文件里的真实实现来断言，不需要
蓝牙或 D-Bus；参数面则用 `-Werror` 编译出真二进制再跑。

对 Linkr Buildroot，不要指望在目标 rootfs 上编译此二进制。当前 Linkr 镜像基于 uClibc，不含 `gcc`、`make`、`pkg-config` 或 `dbus/dbus.h`。用生成 Linkr rootfs 的同一 Buildroot SDK/工具链构建，并链接该 sysroot 的 `libdbus-1`。

用 Buildroot staging sysroot 交叉编译示例：

```sh
cd tools
make clean
make \
  CC=/path/to/buildroot-sdk/bin/arm-linux-gcc \
  SYSROOT=/path/to/buildroot/output/staging
```

若 SDK 提供目标侧 `pkg-config`，改用它：

```sh
cd tools
make clean
make \
  CC=/path/to/buildroot-sdk/bin/arm-linux-gcc \
  PKG_CONFIG=/path/to/buildroot-sdk/bin/pkg-config
```

Linkr 运行时最低要求：

- 系统 D-Bus 运行于 `/run/dbus/system_bus_socket`
- 目标 rootfs 有 `libdbus-1.so`
- BlueZ `bluetoothd` 已安装并在系统总线上运行
- 系统总线上可见 D-Bus 名 `org.bluez`
- 一个可用蓝牙控制器，如 `/sys/class/bluetooth/hci0`
- AIC8800D80 蓝牙固件已加载并通过 UART HCI 挂接

bring-up 期间检查的 Linkr 镜像已有 `dbus-daemon` 和 `/usr/lib/libdbus-1.so`，但还没有 `bluetoothd`、`org.bluez` 或 `hci0`。在此状态下，C 终端能启动到连接 D-Bus，随后以 `no BlueZ adapter found` 失败。

目标侧常用检查：

```sh
dbus-send --system --dest=org.freedesktop.DBus \
  --type=method_call --print-reply / org.freedesktop.DBus.ListNames

bluetoothd -n -d
bluetoothctl list
hciconfig -a
ls -l /sys/class/bluetooth
```

legacy C 终端支持原始 NUS 终端、扫描和回环流程，并通过 Management Service v1
读取和修改广播名。它的旧管理参数不兼容 API
v1；配置和诊断请使用 Python 客户端：

```sh
./linkr_ble_terminal_c --loopback-test A --no-terminal
./linkr_ble_terminal_c --scan
./linkr_ble_terminal_c --query-ble-name --no-terminal
./linkr_ble_terminal_c --rename-ble 'Bench Bee' --no-terminal
python3 tools/linkr_ble_terminal.py --query-info --no-terminal
```

查询桥 UART 设置后退出：

```sh
python3 tools/linkr_ble_terminal.py --query-uart --no-terminal
```

设置 SBC UART 模式后打开终端：

```sh
python3 tools/linkr_ble_terminal.py --uart 115200,8,n,1,n
```

不改动 UART 设置打开终端：

```sh
python3 tools/linkr_ble_terminal.py
```

构建独立 macOS 可执行文件：

```sh
tools/build_terminal_binary.sh
```

运行打包终端：

```sh
./dist/linkr-bee-terminal --uart 115200,8,n,1,n
```

查看原始 SBC console 字节并同时捕获：

```sh
./dist/linkr-bee-terminal --uart 115200,8,n,1,n --log-file sbc-console.log
```

若目标不回显输入字符，调试输入时用行模式或本地回显：

```sh
./dist/linkr-bee-terminal --uart 115200,8,n,1,n --line-mode --enter cr
./dist/linkr-bee-terminal --uart 115200,8,n,1,n --local-echo --debug-io
```

GPIO21 短接到 GPIO20 时，运行 BLE→UART→BLE 回环检查：

```sh
./dist/linkr-bee-terminal --loopback-test A --no-terminal
```

常用选项：

- `Ctrl-]`：退出终端
- `--query-info --no-terminal`：读取固件和运行时诊断
- `--query-ble-name --no-terminal`：读取广播名
- `--rename-ble NAME --no-terminal`：设置广播名
- `--reset-ble-name --no-terminal`：恢复由硬件 MAC 生成的默认广播名
- `--wifi-scan --no-terminal`：通过 bridge 列出附近 2.4 GHz WiFi
- `--loopback-test A --no-terminal`：发送 `A` 并要求收到 `A`
- `--scan --no-terminal`：列出附近 BLE 设备
- `--address <BLE-address-or-UUID>`：按地址连接，跳过名称扫描
- `--enter crlf`：将回车转为 CRLF，给需要的设备
- `--local-echo`：本地回显输入字节
- `--line-mode`：发送可见行而非原始按键
- `--debug-io`：显示 BLE TX/RX 字节跟踪
- `--log-file <path>`：将原始 BLE RX 字节追加到文件
- `--ble-write-size <n>`：覆盖自动检测的 BLE 写入块大小
- `--wifi SSID --wifi-key-file <path>`：连 WiFi 而密码不进 argv（也接受
  `$LINKR_WIFI_PASSWORD` 或终端上交互输入）
- `--json`：把管理响应与事件输出成 JSON 行，给脚本用
- `--quiet`：只输出错误与结果
- `--print-completion <shell>`：打印 bash / fish / zsh 补全脚本，见下

### Shell 补全

两个客户端都能生成 bash / fish / zsh 补全脚本，脚本由各自的选项定义生成，所以新加的选项不会漏掉：

```sh
# bash：只在当前会话生效
source <(tools/linkr_ble_terminal.py --print-completion bash)

# bash：装一次（需要 bash-completion）
tools/linkr_ble_terminal.py --print-completion bash > \
  ~/.local/share/bash-completion/completions/linkr_ble_terminal.py

# zsh：放进 $fpath 里的任意目录，文件名必须是 _linkr_ble_terminal
tools/linkr_ble_terminal.py --print-completion zsh > "${fpath[1]}/_linkr_ble_terminal"

# fish：文件名按命令名命名
tools/linkr_ble_terminal.py --print-completion fish > \
  ~/.config/fish/completions/linkr_ble_terminal.py.fish

# C 客户端同理，把命令名换成 linkr_ble_terminal_c
source <(./linkr_ble_terminal_c --print-completion zsh)
```

补全选项名、`--enter` 与 `--print-completion` 的取值，以及 `--log-file`、`--wifi-key-file` 的路径。
`--print-completion` 不加载 bleak，也不需要设备在场。

**补全只在以该名字调用时生效，所以命令本身要能被找到**（在 `PATH` 上）。装补全脚本不等于装
可执行文件：`python3 tools/linkr_ble_terminal.py <TAB>` 不会补全，那属于 `python3` 的范围。
要用补全就把客户端装成命令——PyInstaller 产物 `linkr-ble-terminal`、自己包一层 wrapper，
或把脚本放到 `PATH`。fish 尤其严格：命令不在 `PATH` 上时它根本不加载对应的补全文件。

## Web Bluetooth 终端

浏览器终端是额外选项，不替代 Python 终端。控制走 Management Service v1，
终端数据走 Reliable UART Service v1；NUS 仅保留给独立的 legacy 客户端。

从 localhost 提供服务：

```sh
tools/serve_web.sh
```

然后打开：

```text
http://127.0.0.1:8765/
```

使用 Chrome 或其他支持 Web Bluetooth 的 Chromium 浏览器。Web Bluetooth
要求安全上下文，因此用 `localhost` 或 HTTPS。首次授权设备仍须从页面的
`Connect` 按钮打开系统设备选择器；浏览器不允许网页静默扫描并连接。授权
完成后，支持 `navigator.bluetooth.getDevices()` 的浏览器会在刷新页面时恢复
上次设备，之后点击 `Connect` 或 `Reconnect` 即可快速重连，无需再次打开选择器。
如果保存的设备已不可用，页面会清除记录，并在下一次连接时回退到系统选择器；
不支持 `getDevices()` 的浏览器始终使用系统选择器。

固件将 Management Service UUID 放在主广播包中，将广播名放在扫描响应中。
所有板型默认名都是 `Linkr Bee XXXX`，其中 `XXXX` 是硬件 MAC 最后四位
十六进制；可用 `@n` 改为自定义名。页面按 Management Service UUID 过滤浏览器
设备选择器，这在 macOS Chromium 浏览器上比只按名称过滤更可靠。

页面可以：

- 连接广播 Linkr Management Service UUID 的设备
- 浏览器支持 `navigator.bluetooth.getDevices()` 时，在刷新后恢复上次已授权
  的 Linkr 设备并快速重连
- 读取 API 版本与稳定 Device ID，分别订阅管理 indication 和 Reliable UART indication
- 默认折叠固件/运行时诊断；展开时才查询设备，也可按需手动刷新
- 扫描附近 2.4 GHz WiFi，将结果填入独立的 SSID/密码输入框；密码不会写入
  应用的 `localStorage`
- 在 xterm.js 内直接捕获输入并写入 RX 特征，因此远端 shell 可使用系统原生
  Tab 补全、命令历史方向键、退格、Ctrl-C 和粘贴
- 用 `@u?` 和 `@u=...` 查询或设置 UART 模式
- 调整换行和 BLE 写入块大小
- 在系统等宽字体与常见本地 Nerd Font 之间切换，并预览 Powerline/Nerd
  字形；所选字体会按当前浏览器来源持久化，但网页不内置字体文件
- 通过 xterm.js 渲染终端控制序列，包括光标移动、行擦除、readline 重绘、16 色、256 色和真彩色 SGR
- 全屏显示终端，并在 viewport 或控制面板宽度变化时自动重新计算行列
- 识别常见 Bash/BusyBox 的 `$ ` 和 `# ` 提示符，登录后通过
  `stty rows <行数> cols <列数>` 同步远端串口 TTY；同步要求普通终端缓冲区中的
  空输入行，并检查待输入状态及光标右侧的命令内容。收到登录提示或 Linux 启动
  标识时，即使桥接器连接未断开也会使尺寸缓存失效。提示符识别属于启发式判断，
  支持常见纯文本 Linux 控制台，自定义提示符可能无法识别。原生手机壳在软键盘
  改变本地 viewport 时跳过这项远端同步
- 显示可选的本地回显和调试 I/O 跟踪
- 将接收字节保存为日志文件

这在已有 Chrome 的机器上便于快速访问。固定版本的 xterm.js 与 addon-fit 已
放在 `web/vendor`，因此终端也能在离线配网环境中使用。

---

## 手机 App

同一套终端 UI、Management v1 和 Reliable UART v1 实现也可以封装为手机 App，
网页端仍然作为独立入口保留。

| 平台 | 原生接入方式 | 当前仓库状态 |
| --- | --- | --- |
| Android | Capacitor 与原生 BLE 插件 | 已生成工程，已验证网页构建和插件同步 |
| iOS | Capacitor 与 CoreBluetooth 插件 | 已生成工程，已验证网页构建和插件同步 |
| HarmonyOS NEXT | ArkWeb UI，通过 `JavaScriptProxy` 连接 ArkTS BLE host | 已实现 API 26 Stage 工程；ArkTS 类型检查和未签名 HAP 构建已通过，待真机验证 |

各端的终端布局与触摸行为按运行环境分开处理：

| 运行环境 | 远端 TTY 尺寸 | 软键盘 | 历史与复制 |
| --- | --- | --- | --- |
| 浏览器 Web / Pages | 登录后和布局变化时通过 `stty` 同步 | 跟随浏览器 viewport | 滚轮、触控板或触摸拖动；选中后复制 |
| 桌面 Rust TUI | 在下一个空闲 shell 提示符发送同一条 `stty rows <rows> cols <cols>`；窗口、侧栏或助手面板改变窗格宽度后重发 | 窗格跟随终端窗口 | 窗格历史、拖动选择与复制快捷键；详见 `tools/linkr-tui/README.md` |
| Android / iOS / HarmonyOS 原生壳 | 安卓端完全不发送 `stty`；其他原生壳在键盘开合时也保持远端 tty 尺寸不变 | 只缩小本地 WebView 并在本地重算行数，关闭后恢复；设置侧栏滑入前先收起输入法，并用 GPU 合成层做动画 | 上下拖动滚动 `term.scrollLines()`；轻点呼出键盘；长按选中手指下的单词并显示两个可拖动圆点，分别精确调整选区两端，可按字符、跨行扩展；浮动复制按钮复制选区，且长按达到阈值后绝不呼出键盘。即使 WebView 清空自己的 DOM 选区，复制仍返回刚才选中的文字；复制不会抢走焦点。键盘已打开时长按/拖动照样选中并复制，上下拖动照样查看历史。键盘按钮跟随屏幕上实际出现的输入法 |

原生壳会有意跳过 `scheduleTerminalGeometrySync()`：软键盘引起的尺寸变化只是本地显示
状态，不应让远端控制台重新排版。安卓端因此完全不发送 `stty rows/cols`。浏览器构建仍保留
现有的 `stty rows <rows> cols <cols>` 同步。

桌面 TUI 发送的命令与 Web、Python 客户端逐字节一致，并且只在空闲 shell 提示符出现时发送：
本地有输入、行模式缓冲区里有未提交的内容，或目标输出看起来不是提示符，都会关闭发送闸门，
直到 shell 重新给出提示符。窗格按实际绘制出来的中心区域定尺寸，所以开关侧栏或助手面板会
改变模拟器宽度，并把同一尺寸排进队列。目标 tty 若仍保留旧宽度，readline 会把长
`user@host:~$` 提示符折回同一行，看起来就像那一行被覆盖了。

如果窗格出现 `�` 或进度条错乱，应先检查真实诊断计数，再区分传输丢失和渲染问题。
`@i?` 提供 UART RX 丢弃、BLE 断开期间丢弃、UART 发送队列丢弃，以及 Reliable UART
indication 的重试、超时和最大等待时间。BLE 发送跟不上时，持续高速输出可能写满 UART RX 环。
UART 转发、WebSocket 和日志采集仍共用一个工作线程；当前固件没有独立 BLE 发送线程，
不能保证慢速中心设备不会阻塞其他出口。丢弃计数增长时可降低目标控制台波特率；
TUI 的 legacy NUS 通道只是尽力而为，没有重传。

构建共享资源并同步 Android/iOS 原生工程：

```sh
cd mobile
npm install
npm run build
npm run cap:sync
npm run build:harmony:hap
```

Android/iOS 环境要求见 [`mobile/README.md`](../mobile/README.md)，HarmonyOS host
接口见 [`harmonyos/README.md`](../harmonyos/README.md) 和
[`harmonyos/BRIDGE_PROTOCOL.md`](../harmonyos/BRIDGE_PROTOCOL.md)，其中也包含调试
签名和无设备测试说明。首版手机 App 仅支持前台运行。固件要求加密并绑定的
BLE 连接。C3/C5 首次连接需要将 GPIO1 拉低完成物理授权；WROOM 默认关闭配对
检查，只有启用 `CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=y` 时才需要拉低
GPIO4。浏览器设备选择授权与 BLE 绑定是两种独立状态。

---

## 看门狗与异常恢复

默认固件启用 `CONFIG_LINKR_BLE_BRIDGE_WATCHDOG=y`。六个独立的任务看门狗通道
分别监控启动流程、系统工作队列、UART 收发、管理请求与管理发送。任一受监控任务
连续 60 秒未到达进度检查点，就会冷重启。空闲队列每秒唤醒一次报告存活，串口无
数据、BLE 未连接或 WiFi 断网不会因此触发重启。长回复在每个 BLE 分片确认后也
会报告进度；实际喂狗限制为每秒一次，避免给高吞吐 UART 增加过多开销。

板载 `watchdog0` 提供硬件兜底，配置窗口为 10 秒
（`TASK_WDT_MIN_TIMEOUT=5000` 加 `TASK_WDT_HW_FALLBACK_DELAY=5000`）。
即使内核定时器或中断路径卡死，也能触发芯片复位；实际复位时间取决于芯片驱动
的看门狗阶段。CPU 异常、内核 panic、已检测到的栈溢出会先尽量输出日志，再重启。
即使异常日志输出本身卡住，硬件看门狗仍然有效。硬件支持时，启动日志会记录复位
原因位掩码。

重启不会清除设置、BLE 配对、WiFi 凭据或目标机绑定 ID，但会中断正在进行的传输。
监控范围是上述任务是否继续运行，不能保证识别所有网络或应用故障；任务存活也
不代表远端服务一定可用。

调试时可在本地附加配置中关闭 `CONFIG_LINKR_BLE_BRIDGE_WATCHDOG`。
任务超时由 `CONFIG_LINKR_BLE_BRIDGE_WATCHDOG_TIMEOUT_MS` 调整，默认 `60000`，
最小 `30000`。主机测试覆盖独立心跳、启动监控结束、超时与致命异常重启，以及
初始化失败处理。2026-10-23 已在 ESP32-C3 AZ、4 MiB Flash 上完成一次性实机
故障注入：阻塞系统工作队列后约 59.0 秒重启；内核 panic 和 CPU 非法指令均在
约 0.04 秒进入重启；关中断死循环后约 20.0 秒触发 `TG0WDT_SYS_RST`。
后者是实测两阶段硬件复位时间，与配置的 10 秒窗口不同。四项测试均恢复到串口桥
就绪。测试后刷回无故障注入钩子的正式固件，镜像与 Flash 回读逐字节一致，并在
稳定运行超过 75 秒后完成加密 BLE 诊断。原有 BLE 身份、配对密钥、目标机绑定
记录的值保留；GATT 缓存元数据和新增默认设置正常更新。

C5 的硬件恢复已在该 devkit 上验证。用临时钩子在启动 15 秒后阻塞系统工作队列，
硬件看门狗约 13 秒后复位芯片：ROM 打印 `rst:0x7 (TG0_WDT_HPSYS)` 与
`PRO CPU has been reset by WDT`，应用侧记录的复位原因为 `0x00000010`
（`RESET_WATCHDOG`）。连续四次注入后，每次都在 1.3 秒内恢复到串口桥就绪，
BLE 身份、名称与配对记录保持不变。C5 在 60 秒任务通道触发之前就走到硬件兜底，
因此该任务看门狗路径仍由上面的 C3 一轮覆盖。测试后已刷回正式镜像，稳定运行
75 秒未再复位。WROOM 的复位行为仍需实机验证。

simple-boot 镜像现已补齐 ROM 可见部分的 SHA-256 摘要。Zephyr v4.4.1 的
`elf2image --ram-only-header` 输出没有这份摘要；项目构建模块会利用现有零填充
补齐摘要，并让启动代码正确跳过摘要后继续扫描 Flash 段。文件大小和隐藏 Flash
段的地址保持不变。构建时只复制并修正构建目录中的启动代码，不修改外部 Zephyr
仓库；上游代码不再匹配时会停止配置，要求重新审查。MCUboot 和不输出二进制
镜像的构建不使用此处理。

可执行 `python3 tools/esp_simpleboot_image.py --check build/zephyr/zephyr.bin`
检查 RAM 校验和与 ROM 摘要，CI 会检查每个待打包镜像。按
[ESP 镜像格式](https://docs.espressif.com/projects/esptool/en/latest/esp32c3/advanced-topics/firmware-image-format.html)，
这份摘要覆盖 ROM 可见的 RAM 镜像，不包括隐藏的 Flash 映射段；整个文件仍由
发布包 `SHA256SUMS` 和刷写回读检查。不能单独处理缺少配套启动代码的旧镜像。
C3、C5 已验证启动和故障恢复时无此告警；其他支持板型目前仅完成构建及镜像格式验证。

## 验证状态

各层次实际验证到什么程度。构建成功、主机测试通过或模拟器启动，都不等于目标硬件上
的端到端验收。

| 层次 | 本仓库已验证 | 仍需硬件验证 |
| --- | --- | --- |
| 固件构建 | `esp32c3_supermini`、`esp32c3_devkitm`、`esp32c3_devkitc`、`esp32c5_devkitc/esp32c5/hpcore`、`esp32_devkitc/esp32/procpu` 与 `esp32_cam/esp32/procpu` 在 CI 中以 Zephyr v4.4.1 构建，并断言各代控制器的安全符号 | ESP32-CAM 真机运行验证 |
| 协议主机测试 | `tests/` 编译并驱动生产代码中的管理协议、安全配对门禁、目标绑定、WebDAV 与 HCI 顺序逻辑，含 C3/C5 构建约束 | 真实 SMP 配对、NVS 持久化、射频行为 |
| BLE 终端 | Web、Python、C 三套客户端，以及浏览器回归套件覆盖 Reliable UART 序号、重组与会话边界 | 各平台的配对、MTU 协商与重连行为 |
| WiFi、局域网桥、WebDAV | 主机测试与浏览器套件；WS 令牌握手两侧均有覆盖 | 关联过程、BLE/WiFi 共存、真实端点上传 |
| 助手（Agent 模式） | Node 与浏览器套件覆盖执行策略、证据处理与任务恢复 | 真实目标机上的命令执行与设备档案恢复，详见 [AGENT_VALIDATION.zh-CN.md](AGENT_VALIDATION.zh-CN.md) |
| 手机 App | 共享 Web 资源可构建并通过类型检查；Android/iOS/HarmonyOS 工程已与终端界面同步；浏览器回归套件覆盖 Termux 式触摸滚动、轻点呼出键盘、原生壳长按选区并拖动两个圆点精确调整（键盘关闭和打开时都覆盖）、浮动复制按钮、WebView 清空选区后仍能复制、浏览器保留原生选择且不绘制自定义圆点、无选区时不复制、复制选区保留折行与边界空格、剪贴板回退不抢焦点和选区、长按绝不呼出键盘、键盘按钮与实际输入法状态同步，以及键盘本地布局（不发送远端 `stty`） | Android、iOS、HarmonyOS 真机 Bluetooth LE |

---

## 配置参考

### UART 配置

| 配置选项 | 默认值 | 说明 |
|----------|--------|------|
| `CONFIG_LINKR_BLE_BRIDGE_UART_BAUD_RATE` | `115200` | 波特率 |
| `CONFIG_LINKR_BLE_BRIDGE_UART_DATA_BITS_*` | `8` | 数据位 (5/6/7/8) |
| `CONFIG_LINKR_BLE_BRIDGE_UART_PARITY_*` | `none` | 校验 (none/odd/even) |
| `CONFIG_LINKR_BLE_BRIDGE_UART_STOP_BITS_*` | `1` | 停止位 (1/2) |
| `CONFIG_LINKR_BLE_BRIDGE_UART_FLOW_CONTROL_*` | `none` | 流控 (none/rtscts) |

### WiFi 配置

| 配置选项 | 默认值 | 说明 |
|----------|--------|------|
| `CONFIG_WIFI_ESP32` | `y` | 启用 ESP32 WiFi 驱动 |
| `CONFIG_WIFI_USAGE_MODE_STA` | `y` | Station 模式 |
| `CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS` | `n` | 保存 WiFi PSK 到 flash（需 secure boot + flash encryption） |

### WebSocket 桥配置

| 配置选项 | 默认值 | 说明 |
|----------|--------|------|
| `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE` | `y` | 启用 WebSocket 桥 |
| `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_PORT` | `80` | WebSocket 服务端口 |
| `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_MAX_CLIENTS` | `2` | 最大并发客户端数 |
| `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN` | *(空)* | 可选认证 token（首条文本帧） |

### BLE 配置

| 配置选项 | 默认值 | 说明 |
|----------|--------|------|
| `CONFIG_LINKR_BLE_BRIDGE_CONTROL_COMMANDS` | `y` | 启用管理命令（`@u`、`@w`、`@d` 等） |
| `CONFIG_LINKR_BLE_BRIDGE_FIRMWARE_VERSION` | `0.1.2` | 上报的固件版本 |

### 测试配置

| 配置选项 | 默认值 | 说明 |
|----------|--------|------|
| `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_ECHO` | `n` | 启用 UART RX 回环 |
| `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX` | `n` | 启用周期性 UART TX 帧 |
| `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_INTERVAL_MS` | `1000` | TX 帧间隔 (ms) |
| `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_PAYLOAD` | `linkr-ble-uart-test\r\n` | TX 帧载荷 |

### 板级引脚 (ESP32-C3 Super Mini)

| 功能 | GPIO | 说明 |
|------|------|------|
| UART RX | GPIO20 | 接收数据 |
| UART TX | GPIO21 | 发送数据 |
| 活动 LED | GPIO8 | 蓝色 LED，UART 收发时闪烁 |
| 恢复出厂 | GPIO0 | 启动时与 GND 短接 |
