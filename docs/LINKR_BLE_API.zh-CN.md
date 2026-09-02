# Linkr Bee 配件 API v1 对接文档

本文档描述 Linkr 主机与 Linkr Bee 配件之间的当前固件接口。项目尚未发布，
本次不保留旧版“在 NUS 中识别控制字符串”的兼容行为；文中的接口即 API v1。

## 1. 设计边界

固件把三类流量拆成独立 GATT 服务：

| 通道 | 用途 | 可靠性 |
| --- | --- | --- |
| Management Service v1 | 查询、配置、异步状态事件 | Write With Response + Indicate，带 request ID |
| Reliable UART Service v1 | Linkr 默认使用的串口字节流 | 序号、写确认、Indicate ACK、重复帧去重 |
| Nordic UART Service（NUS） | 第三方串口工具兼容 | 尽力发送，无端到端恢复保证 |

Management 响应不会再出现在串口数据中，串口内容也不会被误解析为管理命令。

“Reliable UART 已确认”表示：

- Linkr → 配件：完整帧已被固件接收并进入 UART TX 队列；
- 配件 → Linkr：完整帧已由 BLE central 确认 GATT indication。

它不能证明 SBC 上的应用已经消费 UART 字节。若产品要求这个语义，仍需在 SBC
业务协议中增加应用层 ACK；Super Mini 当前只有 RX/TX，没有 RTS/CTS 引脚。

## 2. 发现、地址与 Device ID

设备广播：

- Complete Local Name：当前为 `Linkr BLE UART-3`，名称只用于显示；
- Primary advertisement UUID：Management Service UUID；
- 扫描必须按 Management Service UUID 过滤，不能依赖名称。

BLE 地址是 settings 中持久化的 random-static identity。普通升级和重启不改变
地址；将板级恢复输入与 GND 短接并保持到上电后两秒会恢复出厂（C3 为 GPIO0，
C5 DevKitC 为 GPIO28/BOOT），擦除 settings，并在下次启动生成新地址。

Device ID 是只读 16 字节值：前 10 字节是 Linkr 命名空间，后 6 字节来自芯片
硬件 ID。它与设备名和 BLE 地址无关，恢复出厂后仍保持不变。Linkr 应使用
Device ID 作为自动绑定键，BLE 地址只作为当前系统的连接定位信息。

## 3. UUID

### 3.1 Management Service v1

| 用途 | UUID | 属性 |
| --- | --- | --- |
| Service | `4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001` | Primary Service |
| Protocol Info | `4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001` | Read |
| Device ID | `4c4b0003-9a7e-4f4e-8b8a-3d6f12a0c001` | Read |
| Command | `4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001` | Write With Response |
| Response / Event | `4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001` | Indicate |

Protocol Info 固定 10 字节，全部多字节整数为 little-endian：

| 偏移 | 长度 | 含义 |
| ---: | ---: | --- |
| 0 | 1 | API major，当前 `1` |
| 1 | 1 | API minor，当前 `0` |
| 2 | 2 | 单条逻辑 payload 最大长度，当前 `512` |
| 4 | 4 | capability bitmap |
| 8 | 2 | 保留，必须忽略 |

capability bits：

- bit 0：WiFi；bit 1：WebDAV；bit 2：WebSocket；
- bit 3：Device ID；bit 4：异步事件；bit 5：Reliable UART。

连接后应先读取 Protocol Info 并检查 major，再读取 Device ID，最后订阅
Response / Event indication。不要在订阅完成前发送命令。

### 3.2 Reliable UART Service v1

| 用途 | UUID | 属性 |
| --- | --- | --- |
| Service | `4c4b0010-9a7e-4f4e-8b8a-3d6f12a0c001` | Primary Service |
| RX | `4c4b0011-9a7e-4f4e-8b8a-3d6f12a0c001` | Write With Response |
| TX | `4c4b0012-9a7e-4f4e-8b8a-3d6f12a0c001` | Indicate |
| State | `4c4b0013-9a7e-4f4e-8b8a-3d6f12a0c001` | Read |

### 3.3 NUS 兼容服务

| 用途 | UUID | 属性 |
| --- | --- | --- |
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Primary Service |
| RX | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write / Write Without Response |
| TX | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify |

NUS 只转发原始 UART 字节。`@i?`、`@w=...`、`@!3:@i?` 等内容写入 NUS
都会原样发送到 SBC，不再触发固件管理功能。

## 4. Management 帧

Command、Response 和 Event 使用相同的 12 字节头：

| 偏移 | 长度 | 字段 | 值 |
| ---: | ---: | --- | --- |
| 0 | 2 | magic | ASCII `LK` |
| 2 | 1 | version | `1` |
| 3 | 1 | type | request=`1`，response=`2`，event=`3` |
| 4 | 4 | request_id | little-endian，非零、由客户端生成 |
| 8 | 2 | payload_len | 整个逻辑 payload 长度，不含头 |
| 10 | 2 | flags | little-endian |

flags：bit 0 `FINAL`、bit 1 `ERROR`、bit 2 `ASYNC`。未知位必须忽略。

第一片必须包含完整 12 字节头，头后可带部分 payload。后续 ATT write 或
indication 只携带剩余 payload，不重复头。接收方按 `payload_len` 重组；超过
两秒仍未收完的 Command 会被固件丢弃。逻辑 payload 最大 512 字节。

固件每次只重组一条 Command，客户端必须串行执行各片 write。不同请求可在
前一请求收到 response 后继续发送。Response 与 Event 的每一片均使用 confirmed
indication，因此不会与 NUS TX 的 UART 数据混合。

当前 v1 payload 是 UTF-8 命令/响应文本。保留文本命令是为了调试可读性，通道
边界、版本、ID、分片和可靠性由二进制帧负责。

示例：request ID `0x12345678` 的 `@i?`：

```text
4c 4b 01 01 78 56 34 12 03 00 00 00 40 69 3f
```

## 5. 请求、响应和异步操作

每个 request 必须得到一个 type=2 response，`request_id` 与请求相同。同步错误
带 `ERROR` flag，payload 以 `ERR ` 开头。

WiFi 配置是异步操作：

1. Linkr 发送 `@w=<ssid>,<password>`，例如 request ID 42；
2. 固件响应 `OK wifi=accepted,ssid=...`，仅表示任务已入队；
3. 后续 type=3 Event 继续使用 operation/request ID 42；
4. `phase=ready`、`phase=failed` 或 `phase=off` 的 Event 带 `FINAL`。

事件格式：

```text
@event wifi operation=42 phase=queued result=0 state=... ip=... error=...
@event wifi operation=42 phase=connecting result=0 state=... ip=... error=...
@event wifi operation=42 phase=dhcp result=0 state=... ip=... error=...
@event wifi operation=42 phase=ready result=0 state=connected ip=ready error=0
```

Linkr 只有在 `phase=ready` 且 `ip=ready` 后才能认为配网完成。初始 `OK`、关联
成功、甚至 `state=connected` 都不能替代 DHCP/IP 就绪判定。

WiFi 扫描也使用异步 Event：先返回 `OK accepted`，再发送同一 ID 的：

```text
@scan result MySSID wpa2 ch=6 -48dBm
@scan result Guest open ch=11 -70dBm
@scan done
```

`@scan done` 或 `@scan error` 带 `FINAL`。

## 6. 命令参考

| payload | 含义 |
| --- | --- |
| `@h` | 命令帮助 |
| `@i?` | 多行设备诊断，以 `@info done` 结束 |
| `@u?` | 查询 UART 配置 |
| `@u=115200,8,n,1,n` | 设置 baud,data,parity,stop,flow |
| `@w?` | 查询 WiFi 状态 |
| `@w scan` | 扫描 2.4 GHz 网络 |
| `@w=<ssid>,<password>` | 异步连接 WiFi |
| `@w off` | 断开并清除 WiFi 配置 |
| `@d?` | 查询完整 WebDAV 状态和 URL |
| `@d=http://host/path/` | 设置匿名 HTTP WebDAV URL |
| `@d off` | 禁用 WebDAV |
| `@s?` / `@s on` / `@s off` | 查询、启用或禁用 LAN WebSocket bridge |

长形式 `@linkr info?`、`@linkr wifi=...` 等仍可使用。WebDAV 查询响应使用完整
Management payload，不再受旧 NUS 128 字节响应缓冲区截断。

## 7. Reliable UART 帧和恢复

RX write 与 TX indication 使用 12 字节头：

| 偏移 | 长度 | 字段 | 值 |
| ---: | ---: | --- | --- |
| 0 | 2 | magic | ASCII `LR` |
| 2 | 1 | version | `1` |
| 3 | 1 | flags | 当前为 `0` |
| 4 | 4 | sequence | little-endian，从 1 开始，`0xffffffff` 后回到 1 |
| 8 | 2 | payload_len | 1..232 |
| 10 | 2 | reserved | 发送 0，接收忽略 |

分片规则与 Management 相同：第一片包含头，后续片只有 payload。

Linkr → 配件：

- 每片必须使用 Write With Response；
- 完整帧成功返回后才递增 sequence；
- 固件只接受期望 sequence；上一 sequence 的重复帧会确认但不重复写 UART；
- UART 队列满时最后一片返回 ATT insufficient resources，客户端保持原 sequence
  重试。

配件 → Linkr：

- 每片使用 indication；固件收到全部确认后才递增 sequence；
- indication 失败或断线时，UART 转发线程保留当前 chunk 和 sequence；
- 重连并再次订阅 Reliable TX 后会重发，客户端用 sequence 去重。

State 固定 16 字节：

| 偏移 | 长度 | 含义 |
| ---: | ---: | --- |
| 0 | 1 | version=`1` |
| 1 | 1 | flags，bit0 表示当前选择 reliable mode |
| 2 | 2 | max payload=`232`；与 12 字节帧头合计 244 字节，可在 ATT MTU 247 时单包传输 |
| 4 | 4 | 固件期望收到的 RX sequence（Linkr 发送起点） |
| 8 | 4 | 固件下一条 TX sequence（Linkr 接收起点） |
| 12 | 4 | 最近完成 indication ACK 的 TX sequence |

每次连接后都读取 State，以偏移 4 和 8 的值初始化两个方向的 sequence，再订阅
TX。若应用发现 sequence gap，应停止转发并重连/重读 State，不能静默跳过。

## 8. 推荐接入顺序

1. 按 Management Service UUID 扫描；
2. 连接 GATT，读取 Protocol Info，拒绝未知 major；
3. 读取 Device ID，完成配件绑定或核对；
4. 订阅 Management Response / Event；
5. 读取 Reliable UART State；
6. 可先订阅 NUS TX，再订阅 Reliable UART TX；后者成为默认可靠模式；
7. 管理命令走 Management，终端数据走 Reliable UART；
8. 配网收到 `ready + ip-ready` 后，可连接 `ws://<device-ip>/ws` 切换到 LAN；
9. 断线后重新读取 Protocol Info、Device ID 和 Reliable State，不沿用未核对状态。

## 9. 安全模型

当前开发固件关闭 BLE pairing、bonding 和 owner 限制。任何附近的 BLE central
都能连接、读 UART、改 WiFi/WebDAV/WebSocket 配置。板级恢复出厂仍会清除
settings 并生成新 BLE identity，但它不是无线访问控制。

量产前必须另行确定配对/授权模型；API v1 的通道分离、Device ID、request ID
和可靠 UART 只解决协议正确性，不提供身份认证或机密性。

## 10. 验收清单

- 按 Management UUID 能发现设备，不依赖名称；
- Protocol Info 为 1.0，Device ID 长度为 16，重启后不变；
- 并行 UART 输出时，`@i?` response 仍完整且 UART 中不出现控制响应；
- 两个连续请求的 response ID 分别匹配；
- 长 WebDAV URL 查询完整、不截断；
- WiFi 初始 response 为 accepted，最终必须收到相同 ID 的 ready/failed Event；
- WiFi 扫描以 `@scan done` FINAL Event 结束；
- Reliable UART 重复 sequence 不会重复写 UART；
- indication 期间断线，重连订阅后相同 sequence 可重发并被客户端去重；
- NUS 写入 `@i?` 会原样到 UART，不触发管理命令；
- 恢复出厂后 BLE 地址变化，Device ID 保持不变。C3 使用 GPIO0，
  C5 DevKitC 使用 GPIO28（BOOT），均在启动时接地保持两秒。

参考实现：网页端 `web/app.js`，Python/bleak 客户端
`tools/linkr_ble_terminal.py`。
