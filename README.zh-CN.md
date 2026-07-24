# Linkr BLE UART 桥

> English: [README.md](README.md)

基于 Zephyr 的 ESP32-C3 BLE 串口桥应用。第一个里程碑是一个纯粹的蓝牙 LE UART 窗口：

- BLE 外设以 `Linkr BLE UART-3` 广播
- 兼容 Nordic UART Service 的 UUID
- BLE RX 特征写入转发到所选 UART
- UART RX 字节通过 BLE TX 通知转发出去

Linkr 卡片/设备集成有意留到后续层。

## 支持环境

- 固件目标：ESP32-C3 DevKitM、DevKitC 与 Super Mini
- Zephyr：**v4.4.1**
- 唯一固件功能：BLE UART bridge、WiFi station 控制、匿名 HTTP WebDAV 日志上传
  与 UART-over-WebSocket 局域网访问

## 构建

请使用 Zephyr v4.4.1 的 west workspace。默认的 WiFi 构建还要求 west manifest
内存在 Espressif HAL blobs（`modules/hal_espressif`）。

在该 workspace 中：

```sh
west build -b esp32c3_devkitm /Users/xiangzelong/Dev/linkr-ble
```

或 DevKitC：

```sh
west build -b esp32c3_devkitc /Users/xiangzelong/Dev/linkr-ble
```

ESP32-C3 Super Mini：

```sh
west build -b esp32c3_supermini /Users/xiangzelong/Dev/linkr-ble
```

### Gitea Actions 构建与刷写

`.gitea/workflows/build.yml` 只构建一个量产固件：面向
`esp32c3_supermini` 的默认 WiFi + BLE 配置。它会在 `main` push、版本 tag、
pull request 和手动触发时运行，使用 Zephyr v4.4.1 与 Zephyr SDK 1.0.1。

从完成的 Actions run 下载 `linkr-ble-esp32c3-supermini` artifact，解压后在
macOS 或 Linux 安装
[`esptool`](https://docs.espressif.com/projects/esptool/en/latest/esp32c3/)，
连接设备并执行：

```sh
./flash_firmware.sh
```

连接了多个串口设备时显式指定端口：

```sh
./flash_firmware.sh --port /dev/cu.usbmodemXXXX
```

脚本会把合并后的 ESP32-C3 镜像写入 `0x0`，但不执行整片擦除。它只重写镜像
覆盖的扇区，不会触碰位于 `0x3b0000` 的 settings 分区，因此普通升级会保留
BLE identity 和已保存配置；需要清除它们时仍使用 GPIO0 + GND 恢复
出厂。artifact 还包含 `FLASHING.txt`、`firmware.json`、ELF、linker map、
最终 Kconfig、runner metadata 与 `SHA256SUMS`，便于调试和追溯。

## UART 选择

应用从 devicetree chosen 节点 `zephyr,linkr-ble-uart` 读取 UART。提供的 ESP32-C3 overlay 将其绑定到 `uart0`。若不存在桥专用 chosen 节点，应用回退到 `zephyr,shell-uart`，再回退到 `zephyr,console`。

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

当 `CONFIG_LINKR_BLE_BRIDGE_CONTROL_COMMANDS=y` 时，以 `@u`、`@h` 或 `@linkr ` 开头的 BLE 写入会在本地处理，不转发到 SBC UART。优先使用短形式，因为在 MTU 交换前它们能放进默认 20 字节 BLE 写入载荷：

```text
@u?
@u=115200,8,n,1,n
@u=1500000,8,n,1,n
@u=115200,7,e,1,n
@h
```

当 BLE 中心能发送更长报文时，长形式也可用：`@linkr uart?`、`@linkr uart=115200,8,n,1,none`、`@linkr help`。

响应通过 NUS TX 通知特征回传，例如：

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
west build -b esp32c3_supermini /Users/xiangzelong/Dev/linkr-ble
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

为保证当前开发流程稳定，固件暂时关闭 BLE 配对、bond 与 owner 门禁。附近任何能够连接 NUS 服务的中心设备，都可以使用 UART 数据流以及 WiFi、WebDAV、WebSocket 等全部管理命令。不要把含敏感信息的 console 接到此开发固件，也不要在不可信的无线环境中部署。

| 项目 | 默认值 / 持久化规则 | 清除或移交方式 |
| --- | --- | --- |
| BLE identity/address | 随机静态 Linkr identity 持久化在 NVS，正常重启继续复用 | GPIO0 恢复出厂会生成新的 identity/address，避免系统沿用旧名称缓存 |
| WiFi SSID/PSK | 默认仅 RAM；`CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y` 才保存并在启动时重连 | `@w off` 停用并断开；恢复出厂会擦除 |
| WebDAV 目标 | 匿名 URL 独立于 WiFi 凭据持久化设置，默认也会保存 | `@d off` 停用；恢复出厂会擦除 |
| 上传 boot ID | 上传器分配新的 boot ID 时保存，避免重启后复用文件名 | 恢复出厂会擦除 |

保存的 WiFi 和 WebDAV 配置都是单条、带版本的 settings 记录；启动时会忽略无效或不安全的记录。凭据持久化 Kconfig 是量产前提，不是运行时检测：只有在 secure boot 与 flash encryption 确实已完成烧录时才能开启。未加密设备把 SSID/PSK 写入 NVS 后，仍可能被从 flash 读取。`@w off` 是功能性清除，不是经过验证的安全擦除；设备报废或重新配置时应使用恢复出厂。

恢复出厂时，在设备复位或上电后将 **GPIO0 与 GND 短接**，并持续保持两秒。固件会在 Bluetooth 与 settings 加载前擦除整个 `storage_partition`，清除 Bluetooth identity 数据、Linkr 的 WiFi/WebDAV 配置和上传 boot 计数器，并生成新的随机静态 BLE identity/address。不要让 GPIO0 永久接地，并将该焊盘或按键的物理访问视为恢复出厂权限。该操作不会擦除固件、测试 marker 分区或 coredump 存储。

Python、C 与 Web Bluetooth 客户端都会直接发送管理命令；`--pair` 仅作为兼容参数保留，当前是无操作。WebDAV 上传器也只接受匿名 HTTP，因此只能在可信局域网使用。

UART RX 字节（SBC console 输出）会被缓存，并定期 HTTP PUT 到 `<webdav_url>log-<boot-id>-<sequence>-<uptime>.txt`。上传会等待 IPv4 地址、重试连接失败、为失败批次保留稳定文件名；更改目标或停用时会丢弃已排队旧数据。

控制命令（短形式可放进 MTU 交换前默认 20 字节 BLE 写入）：

```text
@i?                          读取设备诊断信息
@w scan                      扫描附近 2.4 GHz WiFi（无需配对）
@w?                          查询 WiFi 状态
@w=MySSID,secret             连接 WiFi（默认仅保存到 RAM）
@w off                       清除 WiFi 配置并断开
@d?                          查询 WebDAV 状态
@d=http://host/dav/          设置匿名 WebDAV 目标并启用上传
@d off                       停用 WebDAV 上传
```

长形式 `@linkr info?`、`@linkr wifi scan`、`@linkr wifi?`、
`@linkr wifi=...` 和 `@linkr webdav=...` 也被接受。响应通过 NUS TX
通知特征回传：

```text
OK wifi=connected,ssid=MySSID
OK webdav=on,url=http://host/dav/
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

随附的 Python、C 和网页客户端会使用带长度前缀的 `@!<字节数>:` 帧发送配置命令，
因此即使 BLE 将 SSID、PSK 或长 URL 拆成多个 ATT write，固件仍会把它们作为一条
原子命令处理。旧的短命令仍可直接发送。

当前上传器只接受匿名 HTTP 端点。固件会拒绝 Basic Auth 凭据，避免密码通过明文 HTTP 暴露在网络上。该模式仅适用于可信局域网；需要认证或公网部署时，应使用后续支持 HTTPS 且预置 CA 信任锚的构建。

Web Bluetooth 终端提供独立的 SSID/密码输入框、WiFi 扫描列表、设备诊断和
WebDAV 控制。C 参考终端接受 `--query-info`、`--wifi-scan`、`--wifi`、
`--wifi-off`、`--query-wifi`、`--webdav`、`--webdav-off` 和
`--query-webdav`。

## 测试选项

所有测试选项默认关闭。

可重复执行的本地回归检查只构建唯一的 WiFi + BLE 固件，并检查 Python 与 shell
语法：

```sh
tools/verify.sh
```

启用 UART RX 回环：

```sh
west build -b esp32c3_devkitm /Users/xiangzelong/Dev/linkr-ble -- \
  -DEXTRA_CONF_FILE=test_uart.conf
```

`test_uart.conf` 当前同时启用 UART RX 回环和周期性 UART TX 帧。若只想要其中一条路径，构建前复制该文件并删除不需要的选项：

- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_ECHO=y`
- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX=y`
- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_INTERVAL_MS=1000`
- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_PAYLOAD="linkr-ble-uart-test\r\n"`

将 UART0 TX（GPIO21）和 RX（GPIO20）短接后，可构建硬件回环验证镜像：

```sh
west build -p always -b esp32c3_devkitm /Users/xiangzelong/Dev/linkr-ble -- \
  -DEXTRA_CONF_FILE=test_loopback.conf
```

使用同一完整固件功能集的 BLE NUS echo 诊断不需要 UART 接线：

```sh
west build -p always -b esp32c3_supermini /Users/xiangzelong/Dev/linkr-ble -- \
  -DEXTRA_CONF_FILE=test_ble_echo.conf
```

两种诊断模式都使用独立的 `linkr-test-marker` flash 分区，不会写入 ESP32-C3 的
coredump 扇区。

## BLE 协议

使用 Zephyr 内置 Nordic UART Service：

- 服务：`6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- RX 写特征：`6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- TX 通知特征：`6e400003-b5a3-f393-e0a9-e50e24dcca9e`

当前仓库默认配置协商的 ATT/L2CAP MTU 为 65，ACL TX buffer 为 27，因此有效 NUS 载荷最多为**每次写/通知 62 字节**。固件会自动分段 UART 突发数据，随附的 Python、C 和 Web Bluetooth 客户端也会将写入限制为 62 字节。

最终包大小仍取决于 BLE 中心。主机终端在连接时打印协商的写入块大小。

## BLE 终端

`tools/linkr_ble_terminal.py` 是桥的主机侧终端。它扫描匹配 `Linkr BLE UART*` 名称前缀的设备，订阅 NUS TX 通知，并将本地键盘输入转发到 NUS RX 写特征。

按需安装主机依赖：

```sh
python3 -m pip install bleak
```

### Linux 或 Linkr Buildroot 的 C 终端

`tools/linkr_ble_terminal.c` 提供仅 Linux 的 C 参考实现。它通过系统 D-Bus 直接用 `libdbus-1` 与 BlueZ 通信，不依赖 GLib。这使用户态依赖很小，但仍需要底层可用的 Linux BLE 中心栈。

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
./linkr_ble_terminal_c --uart 115200,8,n,1,n
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

C 终端接受与 Python 终端相同的 Linkr BLE 默认值：

```sh
./linkr_ble_terminal_c --query-info --no-terminal
./linkr_ble_terminal_c --wifi-scan --no-terminal
./linkr_ble_terminal_c --query-uart --no-terminal
./linkr_ble_terminal_c --uart 115200,8,n,1,n
./linkr_ble_terminal_c --loopback-test A --no-terminal
./linkr_ble_terminal_c --scan
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
./dist/linkr-ble-terminal --uart 115200,8,n,1,n
```

查看原始 SBC console 字节并同时捕获：

```sh
./dist/linkr-ble-terminal --uart 115200,8,n,1,n --log-file sbc-console.log
```

若目标不回显输入字符，调试输入时用行模式或本地回显：

```sh
./dist/linkr-ble-terminal --uart 115200,8,n,1,n --line-mode --enter cr
./dist/linkr-ble-terminal --uart 115200,8,n,1,n --local-echo --debug-io
```

GPIO21 短接到 GPIO20 时，运行 BLE→UART→BLE 回环检查：

```sh
./dist/linkr-ble-terminal --loopback-test A --no-terminal
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

浏览器终端是额外选项，不替代 Python 终端。它使用相同的 BLE GATT/NUS 服务、RX 写特征、TX 通知特征和 UART 控制命令。

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

固件将 NUS 服务 UUID 放在主广播包中，将 `Linkr BLE UART-3` 名称放在扫描
响应中。页面按 NUS 服务 UUID 过滤浏览器设备选择器，这在 macOS Chromium
浏览器上比只按名称过滤更可靠。

页面可以：

- 连接广播 Linkr NUS 服务 UUID 的设备
- 浏览器支持 `navigator.bluetooth.getDevices()` 时，在刷新后恢复上次已授权
  的 Linkr 设备并快速重连
- 订阅 TX 通知
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

这在已有 Chrome 的机器上便于快速访问。页面从 jsDelivr 加载 xterm.js，因此 Python 终端仍是打包离线使用、自动化和回环测试的更好选择。
