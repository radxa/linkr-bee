<p align="center">
  <img src="assets/linkr-bee-logo.svg" alt="Linkr Bee" width="520">
</p>

> English: [README.md](README.md) | Linkr 端接入：[BLE 配件 API 对接文档](docs/LINKR_BLE_API.zh-CN.md)

基于 Zephyr 的 ESP32-C3/C5 BLE 串口桥应用。第一个里程碑是一个纯粹的蓝牙 LE UART 窗口：

- BLE 外设以 `Linkr BLE UART-3` 广播
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
- [WiFi 与 WebDAV 日志上传](#wifi-与-webdav-日志上传)
  - [UART over WebSocket（局域网桥）](#uart-over-websocket局域网桥)
  - [开放 BLE 访问、持久化与恢复出厂](#开放-ble-访问持久化与恢复出厂)
- [控制命令参考](#控制命令参考)
- [测试选项](#测试选项)
- [BLE 协议](#ble-协议)
- [BLE 终端](#ble-终端)
  - [Linux 或 Linkr Buildroot 的 C 终端](#linux-或-linkr-buildroot-的-c-终端)
- [Web Bluetooth 终端](#web-bluetooth-终端)
- [手机 App](#手机-app)
- [配置参考](#配置参考)

---

## 快速开始

5 步完成固件构建和运行：

```sh
# 1. 克隆并进入工作区
git clone https://github.com/radxa/linkr-bmc-lite.git
cd linkr-bmc-lite

# 2. 构建 ESP32-C3 Super Mini 固件（默认 WiFi + BLE）
west build -b esp32c3_supermini linkr-bmc-lite

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
- 唯一固件功能：BLE UART bridge、WiFi station 控制、匿名 HTTP WebDAV 日志上传
  与 UART-over-WebSocket 局域网访问

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

### GitHub Actions 构建与刷写

`.github/workflows/build.yml` 使用矩阵构建 `esp32c3_supermini` 与
`esp32c5_devkitc/esp32c5/hpcore` 的默认 WiFi + BLE 配置。它会在 `main`
push、版本 tag、pull request 和手动触发时运行，使用 Zephyr v4.4.1 与
Zephyr SDK 1.0.1。

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

脚本会按标准镜像名自动选择芯片，并将 C3 写入 `0x0`、C5 写入 `0x2000`，
但不执行整片擦除。它只重写镜像覆盖的扇区，因此普通升级会保留 BLE identity
和已保存配置；需要清除它们时使用板型对应的恢复出厂输入。artifact 还包含
`FLASHING.txt`、`firmware.json`、ELF、linker map、
最终 Kconfig、runner metadata 与 `SHA256SUMS`，便于调试和追溯。

## UART 选择

应用从 devicetree chosen 节点 `zephyr,linkr-ble-uart` 读取 UART。提供的
ESP32-C3 overlay 将其绑定到 `uart0`；ESP32-C5 DevKitC overlay 将其绑定到
GPIO11/12 上的 `uart1`。若不存在桥专用 chosen 节点，应用回退到
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

## WiFi 与 WebDAV 日志上传

项目只维护一个同时包含 WiFi、WebDAV 和 WebSocket 的固件。WiFi 无线电默认
关闭，直到用户发送 `@w=ssid,pass`；未配网设备仍可直接作为 BLE UART bridge
使用，不再需要单独的纯 BLE 镜像。

WiFi 凭据默认只保存在 RAM，重启即丢失。仅在量产设备已经启用 secure boot 和 flash encryption 时，才应设置 `CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y`：该选项会将 PSK 写入 Zephyr settings/NVS；未加密 flash 上可被读取。启用后才会在重启时自动连接。匿名 WebDAV URL 和上传 boot 计数器独立持久化，避免重启后文件名冲突。

普通构建即包含：

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
- 运行时控制:`@s on|off|?`;开关状态持久化到 settings。`@i?` 诊断包含 `@info ws state=up port=80 clients=N tx=… rx=… dropped=…`
- 可选门槛:`CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN` 要求客户端在 3 秒内把 token 作为首条文本帧发送
- 整体关闭:`-DCONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE=n`

Web 终端(`web/`)的「连接」卡片里有 BLE/局域网切换;局域网模式连接 `ws://<主机>/ws`,终端输入、快捷命令、计数器照常工作,仅 BLE 专属的控制按钮(`@u`/`@w`/`@d`/`@i?`)被禁用。当 BLE 诊断拿到 IP 时,局域网地址输入框会自动预填。WebDAV 日志上传并行运行不受影响。

### 开放 BLE 访问、持久化与恢复出厂

为保证当前开发流程稳定，固件暂时关闭 BLE 配对、bond 与 owner 门禁。附近任何能够连接 Management 或 UART 服务的中心设备，都可以使用 UART 数据流以及 WiFi、WebDAV、WebSocket 等全部管理命令。不要把含敏感信息的 console 接到此开发固件，也不要在不可信的无线环境中部署。

| 项目 | 默认值 / 持久化规则 | 清除或移交方式 |
| --- | --- | --- |
| BLE identity/address | 随机静态 Linkr identity 持久化在 NVS，正常重启继续复用 | 板级恢复出厂会生成新的 identity/address，避免系统沿用旧名称缓存 |
| WiFi SSID/PSK | 默认仅 RAM；`CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y` 才保存并在启动时重连 | `@w off` 停用并断开；恢复出厂会擦除 |
| WebDAV 目标 | 匿名 URL 独立于 WiFi 凭据持久化设置，默认也会保存 | `@d off` 停用；恢复出厂会擦除 |
| 上传 boot ID | 上传器分配新的 boot ID 时保存，避免重启后复用文件名 | 恢复出厂会擦除 |

保存的 WiFi 和 WebDAV 配置都是单条、带版本的 settings 记录；启动时会忽略无效或不安全的记录。凭据持久化 Kconfig 是量产前提，不是运行时检测：只有在 secure boot 与 flash encryption 确实已完成烧录时才能开启。未加密设备把 SSID/PSK 写入 NVS 后，仍可能被从 flash 读取。`@w off` 是功能性清除，不是经过验证的安全擦除；设备报废或重新配置时应使用恢复出厂。

恢复出厂时，在设备复位或上电后将恢复输入与 GND 短接并持续保持两秒：C3
使用 GPIO0，C5 DevKitC 使用 GPIO28/BOOT。固件会在 Bluetooth 与 settings
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
| `@w scan` | `@linkr wifi scan` | 扫描附近 2.4 GHz WiFi（无需配对） |
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
| `@s?` | `@linkr ws?` | 查询 WebSocket 桥状态 |
| `@s on` | `@linkr ws on` | 启用 WebSocket 桥 |
| `@s off` | `@linkr ws off` | 停用 WebSocket 桥 |

### UART 命令

| 短形式 | 长形式 | 说明 |
|--------|--------|------|
| `@u?` | `@linkr uart?` | 查询 UART 设置 |
| `@u=baud,data,parity,stop,flow` | `@linkr uart=...` | 设置 UART 模式 |

### 响应格式

响应通过 Management Response indication 回传：

```text
OK wifi=connected,ssid=MySSID
OK webdav=on,url=http://host/dav/
OK uart=115200,8,N,1,none
ERR format: @u=115200,8,n,1,n
```

诊断命令是只读操作。它会返回应用与 Zephyr 版本、运行时间、开放的 BLE
访问/安全状态、UART 缓冲区使用量和丢字节数、WiFi/IP 状态，以及
WebDAV 队列、丢弃、HTTP、失败和成功计数：

```text
@info fw version=0.2.0 zephyr=4.4.1
@info sys uptime_ms=123456 owner=0 security=1
@info uart dropped=0 buffer=0/16384
@info wifi state=connected ip=ready error=0
@info upload state=on queue=0 dropped=0 http=201 failures=0 successes=4
@info done
```

应用版本由 `CONFIG_LINKR_BLE_BRIDGE_FIRMWARE_VERSION` 设置。

从 Python 终端：

```sh
python3 tools/linkr_ble_terminal.py --query-info --no-terminal
python3 tools/linkr_ble_terminal.py --wifi-scan --no-terminal
python3 tools/linkr_ble_terminal.py --wifi MySSID,secret --query-wifi
python3 tools/linkr_ble_terminal.py --webdav http://host/dav/
```

配置命令使用 Management Service v1 二进制帧，包含 API 版本、request ID、
逻辑长度、response ID 和 confirmed indication 分片。NUS 现在只转发原始 UART。
完整格式、WiFi 异步完成事件、Device ID 与 Reliable UART 序号见
[Linkr Bee 配件 API v1](docs/LINKR_BLE_API.zh-CN.md)。

当前上传器只接受匿名 HTTP 端点。固件会拒绝 Basic Auth 凭据，避免密码通过明文 HTTP 暴露在网络上。该模式仅适用于可信局域网；需要认证或公网部署时，应使用后续支持 HTTPS 且预置 CA 信任锚的构建。

Web Bluetooth 终端提供独立的 SSID/密码输入框、WiFi 扫描列表、设备诊断和
WebDAV 控制。Python 客户端提供相同的 Management v1 自动化操作。

## 测试选项

所有测试选项默认关闭。

可重复执行的本地回归检查会构建 C3 与 C5 的 WiFi + BLE 固件，并检查 Python
与 shell 语法：

```sh
tools/verify.sh
```

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

`tools/linkr_ble_terminal.py` 是当前主机侧参考客户端。它连接
`Linkr BLE UART*` 设备，核对 Management API v1 和 Device ID，使用 Reliable
UART 传输终端字节，并将管理响应与串口输出分开。

按需安装主机依赖：

```sh
python3 -m pip install bleak
```

### Linux 或 Linkr Buildroot 的 C 终端

`tools/linkr_ble_terminal.c` 提供仅 Linux 的 C 参考实现。它通过系统 D-Bus 直接用 `libdbus-1` 与 BlueZ 通信，不依赖 GLib。这使用户态依赖很小，但仍需要底层可用的 Linux BLE 中心栈。该程序目前是 legacy NUS 终端；Management v1 与 Reliable UART 对接请使用 Python 或 Web 参考客户端。

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

legacy C 终端支持原始 NUS 终端、扫描和回环流程。它的旧管理参数不兼容 API
v1；配置和诊断请使用 Python 客户端：

```sh
./linkr_ble_terminal_c --loopback-test A --no-terminal
./linkr_ble_terminal_c --scan
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

固件将 Management Service UUID 放在主广播包中，将 `Linkr BLE UART-3` 名称放在扫描
响应中。页面按 Management Service UUID 过滤浏览器设备选择器，这在 macOS Chromium
浏览器上比只按名称过滤更可靠。

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

构建共享资源并同步 Android/iOS 原生工程：

```sh
cd mobile
npm install
npm run build
npm run cap:sync
npm run build:harmony:hap
```

Android/iOS 环境要求见 [`mobile/README.md`](mobile/README.md)，HarmonyOS host
接口见 [`harmonyos/README.md`](harmonyos/README.md) 和
[`harmonyos/BRIDGE_PROTOCOL.md`](harmonyos/BRIDGE_PROTOCOL.md)，其中也包含调试
签名和无设备测试说明。首版手机 App 仅支持前台运行。当前固件还允许开放 BLE
访问，因此对外发布前还需要定义设备所有权、配对或等价的授权机制。

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
| `CONFIG_LINKR_BLE_BRIDGE_FIRMWARE_VERSION` | `0.2.0` | 上报的固件版本 |

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
