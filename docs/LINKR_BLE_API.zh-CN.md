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

- Complete Local Name：所有板型的默认名都是 `Linkr Bee XXXX`，其中 `XXXX`
  是硬件 MAC 最后四位十六进制（例如 `58:BF:25:33:07:8C` → `078C`）。
  `@n` 可将其替换为 1–29 字节的自定义名（可含中文）。当前固件的名称只用于
  显示，扫描仍必须按 Management Service UUID 过滤；改名后固件会重启一次
  广播，扫描响应随即带上新名字；
- Primary advertisement UUID：Management Service UUID；
- 当前固件必须按 Management Service UUID 扫描，不能依赖名称。仅为兼容没有
  Management Service、只有 NUS 且固定名为 `Linkr BLE UART...` 的旧固件，
  TUI 和 Web 允许这一种名称例外；新式 `Linkr Bee...` 名称不能替代服务校验。

BLE 地址是 settings 中持久化的 random-static identity。普通升级和重启不改变
地址；将板级恢复输入与 GND 短接并保持到上电后两秒会恢复出厂（C3 为 GPIO0，
C5 DevKitC 为 GPIO28/BOOT，WROOM 为 GPIO27），擦除 settings，并在下次启动
生成新地址。默认名来自硬件 MAC，不随 BLE 地址变化；恢复出厂会清除自定义名，
重新生成 `Linkr Bee XXXX`。

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

UART 自动波特率也是异步操作，但默认只在用户要求时运行：

1. Linkr 发送 `@a`，例如 request ID 43；固件响应
   `OK autobaud state=running baud=115200 timeout_ms=5000`。该 response
   **不带** `FINAL`，表示检测已接受但尚未完成；
2. 检测最多持续到出现结果、无有效捕获 5 秒或收到 `@a stop`；
3. 结果使用同一 request ID 的 type=3 Event 返回，并带 `FINAL`：

```text
@event autobaud state=applied old=115200 new=1500000
@event autobaud state=unchanged old=115200 new=115200
@event autobaud state=timeout old=115200 new=115200
@event autobaud state=stopped old=115200 new=115200
@event autobaud state=error old=115200 new=57600
```

`applied` 表示端口已切换到新速率；`unchanged` 表示线速率已与当前配置一致；
`timeout` 表示 5 秒内没有可测量的捕获（有捕获会重置计时）；`stopped` 表示被
`@a stop` 取消；`error` 带 `ERROR` flag，表示 `uart_configure()` 拒绝新速率。
检测状态可用 `@a?` 同步查询；WROOM 的 GPIO13 按键也可启动同一检测，但按键启动
没有 request ID，结果只写日志，不发送 Event。检测默认在启动时保持 idle，不会
自动跟随线速率。

## 6. 命令参考

| payload | 含义 |
| --- | --- |
| `@h` | 命令帮助 |
| `@n?` / `@linkr name?` | 查询当前广播名及是否为自定义名 |
| `@n=<name>` / `@linkr name=<name>` | 设置并持久化 1–29 字节 UTF-8 自定义名；支持中文和 emoji（按字节计，通常每个 emoji 4 字节） |
| `@n default` / `@linkr name default` | 删除自定义名，恢复 `Linkr Bee XXXX` |
| `@i?` | 多行设备诊断，以 `@info done` 结束 |
| `@u?` | 查询 UART 配置 |
| `@u=115200,8,n,1,n` | 设置 baud,data,parity,stop,flow |
| `@a?` | 查询按需自动波特率状态（`idle`/`running`、当前 baud、超时） |
| `@a` / `@a start` | 启动一次自动波特率检测（`CONFIG_LINKR_BLE_BRIDGE_UART_AUTOBAUD=y`） |
| `@a stop` | 取消当前检测；停止 Event 继续使用启动请求的 ID |
| `@w?` | 查询 WiFi 状态 |
| `@w scan` | 扫描 2.4 GHz 网络 |
| `@w=<ssid>,<password>` | 异步连接 WiFi |
| `@w off` | 断开并清除 WiFi 配置 |
| `@d?` | 查询完整 WebDAV 状态和 URL |
| `@d=http://host/path/` | 设置匿名 HTTP WebDAV URL |
| `@d off` | 禁用 WebDAV |
| `@s?` / `@s on` / `@s off` | 查询、启用或禁用 LAN WebSocket bridge；查询结果包含 `token=` |
| `@s token` | 生成并保存新的 32 位十六进制 LAN 访问令牌 |
| `@s token=<32 位小写十六进制>` | 指定 LAN 访问令牌 |
| `@s token off` | 关闭 LAN 鉴权，允许未认证客户端连接 |
| `@linkr target?` | 查询 Bee 保存的目标机 UUID，无关联时返回 `OK target=none` |
| `@linkr target=<UUID>` | 保存小写、带连字符的 36 字符 UUID；相同值不重复写入 |
| `@linkr target clear` | 清除 Bee 中的目标机关联，不删除目标机 ID 文件或浏览器档案 |

名称规则：固件只裁剪首尾的空格、Tab、CR、LF，拒绝 C0、DEL、C1 与
U+2028/U+2029，长度按 UTF-8 字节计（1–29）。只有 `@n` 后恰好一个空格时的
`@n default` 才是恢复默认；`@n=default`（以及两个空格的 `@n  default`）会设置
一个名字字面为 `default` 的自定义名。`@n?` 的回复是
`OK name=<name> custom=yes|no`；设置/恢复的回复是 `OK name=<name>`，不带
`custom=`，需要来源时客户端应再查询一次。名称允许零宽或格式字符（例如
U+200B、U+200E、U+FEFF），这类名字在扫描列表里可能看起来是空白；如果希望
用户一眼能认出板子，请不要只用这类字符。

长形式 `@linkr info?`、`@linkr wifi=...` 等仍可使用。WebDAV 查询响应使用完整
Management payload，不再受旧 NUS 128 字节响应缓冲区截断。

目标机 UUID 存储在 settings 的 `linkr_target/v1`，与 Bee 自身 Device ID、BLE
绑定密钥相互独立。写入成功返回 `OK target=<UUID>`，失败返回 `ERR target storage <code>`。
它仅用于关联档案；客户端仍须从当前 UART 目标机读取 ID 并比对，不能将缓存 UUID
作为目标机身份认证或本次连接已核实的证据。

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

## 8. LAN WebSocket 握手与访问令牌

`ws://<device-ip>/ws` 升格为 WebSocket 后，桥接器先发送一个 **文本帧** 声明是否需要
令牌，客户端据此决定下一步。串口数据始终使用 **二进制帧**，因此文本帧不会与串口
内容混淆。

```text
bridge -> client  "@ws auth=none\r\n"       不需要令牌，随即开始转发串口
bridge -> client  "@ws auth=required\r\n"   必须发送令牌
client -> bridge  "<32 位小写十六进制>"      单个文本帧
bridge -> client  "@ws auth=ok\r\n"         通过，随即开始转发串口
```

- 令牌不匹配时桥接器直接断开，不返回任何帧；3 秒内未收到令牌同样断开。
- 收到 `auth=ok` 之前，客户端不得发送串口数据；`auth=required` 之后的第一帧会被
  当作令牌消费，不会写入目标机。
- 令牌为 128 位随机数，首次启动时生成并保存到 settings 的 `linkr/ws/en`，因此
  同一次烧录在重启后保持稳定。`@s?` 会返回 `token=<值>`；`@s token` 重新生成，
  `@s token=<值>` 指定，`@s token off` 关闭鉴权。
- `@i?` 诊断输出 **不含** 令牌。令牌只经加密的 BLE 管理通道下发。
- 令牌是局域网访问控制，不是传输加密：`ws://` 为明文，同网段仍可嗅探串口内容。

## 9. 推荐接入顺序

1. 按 Management Service UUID 扫描；
2. 连接 GATT 并完成系统加密/绑定（新主机需先拉低 GPIO1），读取 Protocol Info，拒绝未知 major；
3. 读取 Device ID，完成配件绑定或核对；
4. 订阅 Management Response / Event；
5. 读取 Reliable UART State；
6. 可先订阅 NUS TX，再订阅 Reliable UART TX；后者成为默认可靠模式；
7. 管理命令走 Management，终端数据走 Reliable UART；
8. 配网收到 `ready + ip-ready` 后，读取 `@s?` 取得 LAN 令牌，再连接
   `ws://<device-ip>/ws` 完成第 8 节握手并切换到 LAN；
9. 断线后重新读取 Protocol Info、Device ID 和 Reliable State，不沿用未核对状态。

## 10. 安全模型

Management、Reliable UART、兼容 NUS 的值读写和 CCC 读写均要求加密连接，
通知/指示同样受加密权限保护。未绑定连接只可发现服务，不能使用数据或管理功能。
配对采用 LE Secure Connections Just Works，要求绑定。C3/C5 的 board conf
启用 GPIO1 物理授权，请求到达时 GPIO1 需为低。WROOM 默认
`CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=n`，不需要按 GPIO4；只有显式设为
`y` 时才要求 GPIO4 为低。启用授权检查时，替换旧绑定密钥同样受检查，已有密钥
的加密重连不触发它。

最多保留 8 个绑定，NVS 在正常重启后恢复。恢复出厂会清除绑定及其他设置。
配对 GPIO 低电平窗口允许附近主机申请配对，不能验证某一台主机的身份；Just Works
不提供 MITM 身份核验。Device ID 与浏览器的设备授权不能替代加密绑定。
详见 [配对说明](BLE_PAIRING.md)。

LAN WebSocket 默认要求访问令牌（见第 8 节），令牌只在加密的 BLE 通道上以 `@s?`
下发；只有显式执行 `@s token off` 才会回到无鉴权访问。无论是否启用令牌，`ws://`
均为明文传输，不要把端口暴露到不受信任的网络。

## 11. 验收清单

- 按 Management UUID 能发现设备，不依赖名称；
- Protocol Info 为 1.0，Device ID 长度为 16，重启后不变；
- 并行 UART 输出时，`@i?` response 仍完整且 UART 中不出现控制响应；
- 两个连续请求的 response ID 分别匹配；
- 长 WebDAV URL 查询完整、不截断；
- WiFi 初始 response 为 accepted，最终必须收到相同 ID 的 ready/failed Event；
- WiFi 扫描以 `@scan done` FINAL Event 结束；
- WROOM 上 `@a?` 启动时为 `idle`；`@a` 返回非 FINAL 的 running response，
  随后收到同 ID 的 `@event autobaud ...` FINAL；`@a stop` 和 5 秒无捕获超时
  都能结束检测；
- Reliable UART 重复 sequence 不会重复写 UART；
- indication 期间断线，重连订阅后相同 sequence 可重发并被客户端去重；
- NUS 写入 `@i?` 会原样到 UART，不触发管理命令；
- `@s?` 返回 32 位十六进制 `token=`，`@i?` 不含令牌；首次启动后该值在重启间保持；
- LAN 客户端收到 `@ws auth=none` 或 `@ws auth=ok` 后才开始收发串口；
- 用错误令牌连接会被断开且不写入目标机；`@s token off` 后连接收到 `auth=none`；
- 恢复出厂后 BLE 地址变化，Device ID 和默认名 `Linkr Bee XXXX` 保持不变；
  自定义名被清除并回到硬件 MAC 后缀。C3 使用 GPIO0，C5 DevKitC 使用
  GPIO28（BOOT），WROOM 使用 GPIO27，均在启动时接地保持两秒。

参考实现：网页端 `web/app.js`，Python/bleak 客户端
`tools/linkr_ble_terminal.py`。
