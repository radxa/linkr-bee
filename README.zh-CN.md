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
- 默认功能：BLE UART bridge、WiFi station 控制、匿名 HTTP WebDAV 日志上传
- BLE-only 功能集：`CONFIG_LINKR_BLE_BRIDGE_WIFI=n`

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

WiFi + WebDAV 功能默认启用（`CONFIG_LINKR_BLE_BRIDGE_WIFI=y`），但无线电默认关闭，直到用户发送 `@w=ssid,pass`。该 Kconfig 开关会选择网络、WiFi、DNS 和 HTTP 依赖；构建 BLE-only 镜像时会一并移除：

```sh
west build -p always -b esp32c3_supermini /Users/xiangzelong/Dev/linkr-ble -- \
  -DCONFIG_LINKR_BLE_BRIDGE_WIFI=n
```

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

### BLE 配对、owner、持久化与恢复出厂

BLE 配对保护的是**管理面**，不是通用 NUS UART 数据流。所有 WiFi/WebDAV 命令（包括 `@w?` 和 `@d?`）都要求 BLE Security Level 3：链路已加密、已认证，并具有 MITM 防护。若当前连接低于该级别，固件会请求提升安全级别、返回“需要配对”的响应；完成配对后必须重试原命令。原始 NUS UART 数据和 `@u...` UART 配置刻意不在这个门禁内；若 SBC console 含敏感信息，必须确认这种访问模型可接受。

首次配对时，桥的 USB serial console 会显示六码，需要在中心设备上输入。成功后的 BLE bond 由 Zephyr settings/NVS 保存。固件将“存在任意 bond”视为已经有 owner：只接受一个已绑定中心设备，并拒绝之后所有新的配对请求。因此，在手机或电脑端“忽略/删除此设备”不会解除 bridge 上的 owner；移交给新 owner 前需要恢复出厂。

| 项目 | 默认值 / 持久化规则 | 清除或移交方式 |
| --- | --- | --- |
| BLE bond 与 owner | 始终由 `CONFIG_BT_SETTINGS` 持久化到 NVS | 仅 GPIO0 恢复出厂；没有可通过 BLE 调用的解除 owner 命令 |
| WiFi SSID/PSK | 默认仅 RAM；`CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y` 才保存并在启动时重连 | `@w off` 停用并断开；恢复出厂会擦除 |
| WebDAV 目标 | 匿名 URL 独立于 WiFi 凭据持久化设置，默认也会保存 | `@d off` 停用；恢复出厂会擦除 |
| 上传 boot ID | 上传器分配新的 boot ID 时保存，避免重启后复用文件名 | 恢复出厂会擦除 |

保存的 WiFi 和 WebDAV 配置都是单条、带版本的 settings 记录；启动时会忽略无效或不安全的记录。凭据持久化 Kconfig 是量产前提，不是运行时检测：只有在 secure boot 与 flash encryption 确实已完成烧录时才能开启。未加密设备把 SSID/PSK 写入 NVS 后，仍可能被从 flash 读取。`@w off` 是功能性清除，不是经过验证的安全擦除；设备报废或 owner 移交时应使用恢复出厂。

恢复出厂时，在设备复位或上电后将 **GPIO0 与 GND 短接**，并持续保持两秒。固件会在 Bluetooth 与 settings 加载前擦除整个 `storage_partition`，清除 BLE owner/bond、Bluetooth identity 数据、Linkr 的 WiFi/WebDAV 配置和上传 boot 计数器。设备将以未绑定状态启动，BLE identity 也可能重新生成。不要让 GPIO0 永久接地，并将该焊盘或按键的物理访问视为恢复出厂权限。该操作不会擦除固件、测试 marker 分区或 coredump 存储。

Python 工具对 WiFi/WebDAV 操作会自动配对（或使用 `--pair`）；C 工具需要运行中的 BlueZ pairing agent；Web Bluetooth 会显示浏览器原生配对提示，完成后需重新点击原操作。BLE 配对不会加密后续 WebDAV 上传：当前上传器仅接受匿名 HTTP，因此只能在可信局域网使用。

UART RX 字节（SBC console 输出）会被缓存，并定期 HTTP PUT 到 `<webdav_url>log-<boot-id>-<sequence>-<uptime>.txt`。上传会等待 IPv4 地址、重试连接失败、为失败批次保留稳定文件名；更改目标或停用时会丢弃已排队旧数据。

控制命令（短形式可放进 MTU 交换前默认 20 字节 BLE 写入）：

```text
@w?                          查询 WiFi 状态
@w=MySSID,secret             连接 WiFi（默认仅保存到 RAM）
@w off                       清除 WiFi 配置并断开
@d?                          查询 WebDAV 状态
@d=http://host/dav/             设置匿名 WebDAV 目标并启用上传
@d off                       停用 WebDAV 上传
```

长形式 `@linkr wifi?`、`@linkr wifi=...`、`@linkr webdav=...` 也被接受。响应通过 NUS TX 通知特征回传：

```text
OK wifi=connected,ssid=MySSID
OK webdav=on,url=http://host/dav/
```

从 Python 终端：

```sh
python3 tools/linkr_ble_terminal.py --wifi MySSID,secret --query-wifi
python3 tools/linkr_ble_terminal.py --webdav http://host/dav/
```

随附的 Python、C 和网页客户端会使用带长度前缀的 `@!<字节数>:` 帧发送配置命令，
因此即使 BLE 将 SSID、PSK 或长 URL 拆成多个 ATT write，固件仍会把它们作为一条
原子命令处理。旧的短命令仍可直接发送。

当前上传器只接受匿名 HTTP 端点。固件会拒绝 Basic Auth 凭据，避免密码通过明文 HTTP 暴露在网络上。该模式仅适用于可信局域网；需要认证或公网部署时，应使用后续支持 HTTPS 且预置 CA 信任锚的构建。

Web Bluetooth 终端以 `Set WiFi` / `WiFi ?` / `Set WebDAV` / `WebDAV ?` 按钮提供相同控制；C 参考终端接受 `--wifi`、`--wifi-off`、`--query-wifi`、`--webdav`、`--webdav-off`、`--query-webdav`。

## 测试选项

所有测试选项默认关闭。

可重复执行的本地回归检查会构建 WiFi 与 BLE-only 两种镜像，并检查 Python 和 shell
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

BLE-only NUS echo 诊断不需要 UART 接线：

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

使用 Chrome 或其他支持 Web Bluetooth 的 Chromium 浏览器。Web Bluetooth 要求安全上下文，因此用 `localhost` 或 HTTPS。设备选择必须从页面的 `Connect` 按钮触发；浏览器不允许网页静默扫描并连接。

页面可以：

- 连接匹配 `Linkr BLE UART*` 名称前缀的设备
- 订阅 TX 通知
- 将终端输入写入 RX 特征
- 用 `@u?` 和 `@u=...` 查询或设置 UART 模式
- 调整换行和 BLE 写入块大小
- 通过 xterm.js 渲染终端控制序列，包括光标移动、行擦除、readline 重绘、16 色、256 色和真彩色 SGR
- 显示可选的本地回显和调试 I/O 跟踪
- 将接收字节保存为日志文件

这在已有 Chrome 的机器上便于快速访问。页面从 jsDelivr 加载 xterm.js，因此 Python 终端仍是打包离线使用、自动化和回环测试的更好选择。
