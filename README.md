# Linkr BLE UART Bridge

Zephyr application for an ESP32-C3 BLE serial bridge.  The first milestone is a
plain Bluetooth LE UART window:

- BLE peripheral advertising as `Linkr BLE UART-3`
- Nordic UART Service compatible UUIDs
- BLE RX characteristic writes are forwarded to the selected UART
- UART RX bytes are forwarded through BLE TX notifications

The Linkr card/device integration is intentionally left for a later layer.

## Build

From a Zephyr workspace:

```sh
west build -b esp32c3_devkitm /Users/xiangzelong/Dev/linkr-ble
```

or for DevKitC:

```sh
west build -b esp32c3_devkitc /Users/xiangzelong/Dev/linkr-ble
```

For ESP32-C3 Super Mini:

```sh
west build -b esp32c3_supermini /Users/xiangzelong/Dev/linkr-ble
```

## UART selection

The app reads the UART from the devicetree chosen node
`zephyr,linkr-ble-uart`.  The provided ESP32-C3 overlays bind it to `uart0`.
If no bridge-specific chosen node is present, the app falls back to
`zephyr,shell-uart`, then `zephyr,console`.

On `esp32c3_supermini`, `uart0` is enabled for bridge traffic:

- RX: GPIO20
- TX: GPIO21
- Activity LED: GPIO8 blue LED, flashed on UART RX and TX activity

## SBC UART settings

The bridge applies a picocom/minicom-style UART configuration at startup.  The
default is:

- `115200,8,N,1,none`
- baud rate: `CONFIG_LINKR_BLE_BRIDGE_UART_BAUD_RATE`
- data bits: `CONFIG_LINKR_BLE_BRIDGE_UART_DATA_BITS_*`
- parity: `CONFIG_LINKR_BLE_BRIDGE_UART_PARITY_*`
- stop bits: `CONFIG_LINKR_BLE_BRIDGE_UART_STOP_BITS_*`
- flow control: `CONFIG_LINKR_BLE_BRIDGE_UART_FLOW_CONTROL_*`

The ESP32-C3 Super Mini overlay currently wires only RX/TX, so keep flow control
at `none` for that board.  RTS/CTS needs extra pins and board pinctrl support.

When `CONFIG_LINKR_BLE_BRIDGE_CONTROL_COMMANDS=y`, BLE writes beginning with
`@u`, `@h`, or `@linkr ` are handled locally and are not forwarded to the SBC
UART.  Prefer the short forms because they fit in the default 20-byte BLE write
payload before MTU exchange:

```text
@u?
@u=115200,8,n,1,n
@u=1500000,8,n,1,n
@u=115200,7,e,1,n
@h
```

The longer forms are also accepted when the BLE central can send them:
`@linkr uart?`, `@linkr uart=115200,8,n,1,none`, and `@linkr help`.

Responses are sent back over the NUS TX notification characteristic, for
example:

```text
OK uart=115200,8,N,1,none
ERR format: @u=115200,8,n,1,n
```

## Test options

All test options default to off.

Enable UART RX echo loopback:

```sh
west build -b esp32c3_devkitm /Users/xiangzelong/Dev/linkr-ble -- \
  -DEXTRA_CONF_FILE=test_uart.conf
```

`test_uart.conf` currently enables both UART RX echo loopback and periodic UART
TX frames.  To keep only one test path, copy that file and remove the unwanted
option before building:

- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_ECHO=y`
- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX=y`
- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_INTERVAL_MS=1000`
- `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_PAYLOAD="linkr-ble-uart-test\r\n"`

## BLE protocol

This uses Zephyr's built-in Nordic UART Service:

- Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- RX write characteristic: `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- TX notify characteristic: `6e400003-b5a3-f393-e0a9-e50e24dcca9e`

The firmware is configured for larger BLE packets:

- ATT/L2CAP MTU: 247
- ACL TX/RX size: 251
- LE Data Length Update: enabled
- effective NUS payload after MTU exchange: up to 244 bytes per write/notify

The final packet size still depends on the BLE central.  The host terminal
prints the negotiated write chunk size when it connects.

## BLE terminal

`tools/linkr_ble_terminal.py` is a host-side terminal for the bridge.  It scans
for devices matching the `Linkr BLE UART*` name prefix, subscribes to NUS TX
notifications, and forwards local keyboard input to the NUS RX write
characteristic.

Install the host dependency if needed:

```sh
python3 -m pip install bleak
```

### C terminal for Linux or Linkr Buildroot

A Linux-only reference implementation written in C is provided in
`tools/linkr_ble_terminal.c`. It talks to BlueZ over the system D-Bus using
`libdbus-1` directly, without GLib. This keeps the userspace dependency small,
but it still requires a working Linux BLE central stack underneath it.

Runtime path:

```text
linkr_ble_terminal_c
  -> libdbus-1
  -> dbus-daemon --system
  -> bluetoothd / org.bluez
  -> hci0
  -> AIC8800D80 BT UART/HCI
```

On a desktop Linux system with BlueZ development files installed:

```sh
cd tools && make
./linkr_ble_terminal_c --help
./linkr_ble_terminal_c --uart 115200,8,n,1,n
```

For Linkr Buildroot, do not expect to compile this binary on the target rootfs.
The current Linkr image is uClibc based and does not include `gcc`, `make`,
`pkg-config`, or `dbus/dbus.h`. Build it with the same Buildroot SDK/toolchain
that produced the Linkr rootfs, and link against that sysroot's `libdbus-1`.

Example cross build with a Buildroot staging sysroot:

```sh
cd tools
make clean
make \
  CC=/path/to/buildroot-sdk/bin/arm-linux-gcc \
  SYSROOT=/path/to/buildroot/output/staging
```

If the SDK provides a target-aware `pkg-config`, use it instead:

```sh
cd tools
make clean
make \
  CC=/path/to/buildroot-sdk/bin/arm-linux-gcc \
  PKG_CONFIG=/path/to/buildroot-sdk/bin/pkg-config
```

Minimum Linkr runtime requirements:

- system D-Bus running at `/run/dbus/system_bus_socket`
- `libdbus-1.so` in the target rootfs
- BlueZ `bluetoothd` installed and running on the system bus
- D-Bus name `org.bluez` visible on the system bus
- one usable Bluetooth controller such as `/sys/class/bluetooth/hci0`
- AIC8800D80 Bluetooth firmware loaded and attached through UART HCI

The Linkr image inspected during bring-up already had `dbus-daemon` and
`/usr/lib/libdbus-1.so`, but it did not yet have `bluetoothd`, `org.bluez`, or
`hci0`. In that state the C terminal can start far enough to connect to D-Bus,
then fails with `no BlueZ adapter found`.

Useful target-side checks:

```sh
dbus-send --system --dest=org.freedesktop.DBus \
  --type=method_call --print-reply / org.freedesktop.DBus.ListNames

bluetoothd -n -d
bluetoothctl list
hciconfig -a
ls -l /sys/class/bluetooth
```

The C terminal accepts the same Linkr BLE defaults as the Python terminal:

```sh
./linkr_ble_terminal_c --query-uart --no-terminal
./linkr_ble_terminal_c --uart 115200,8,n,1,n
./linkr_ble_terminal_c --loopback-test A --no-terminal
./linkr_ble_terminal_c --scan
```

Query the bridge UART settings and exit:

```sh
python3 tools/linkr_ble_terminal.py --query-uart --no-terminal
```

Set the SBC UART mode, then open the terminal:

```sh
python3 tools/linkr_ble_terminal.py --uart 115200,8,n,1,n
```

Open the terminal without changing UART settings:

```sh
python3 tools/linkr_ble_terminal.py
```

Build a standalone macOS executable:

```sh
tools/build_terminal_binary.sh
```

Run the packaged terminal:

```sh
./dist/linkr-ble-terminal --uart 115200,8,n,1,n
```

Capture raw SBC console bytes while viewing them:

```sh
./dist/linkr-ble-terminal --uart 115200,8,n,1,n --log-file sbc-console.log
```

If the target does not echo typed characters, use line mode or local echo while
debugging input:

```sh
./dist/linkr-ble-terminal --uart 115200,8,n,1,n --line-mode --enter cr
./dist/linkr-ble-terminal --uart 115200,8,n,1,n --local-echo --debug-io
```

With GPIO21 shorted to GPIO20, run a BLE-to-UART-to-BLE loopback check:

```sh
./dist/linkr-ble-terminal --loopback-test A --no-terminal
```

Useful options:

- `Ctrl-]`: exit the terminal
- `--loopback-test A --no-terminal`: send `A` and require `A` back
- `--scan --no-terminal`: list nearby BLE devices
- `--address <BLE-address-or-UUID>`: connect without scanning by name
- `--enter crlf`: translate Enter to CRLF for targets that need it
- `--local-echo`: echo typed bytes locally
- `--line-mode`: send visible lines instead of raw keystrokes
- `--debug-io`: show BLE TX/RX byte traces
- `--log-file <path>`: append raw BLE RX bytes to a file
- `--ble-write-size <n>`: override the auto-detected BLE write chunk size

## Web Bluetooth terminal

The browser terminal is an additional option, not a replacement for the Python
terminal.  It uses the same BLE GATT/NUS service, RX write characteristic, TX
notify characteristic, and UART control commands.

Serve it from localhost:

```sh
tools/serve_web.sh
```

Then open:

```text
http://127.0.0.1:8765/
```

Use Chrome or another Chromium browser with Web Bluetooth support.  Web
Bluetooth requires a secure context, so use `localhost` or HTTPS.  Device
selection must be triggered from the page's `Connect` button; browsers do not
allow a web page to scan and connect silently.

The page can:

- connect to devices matching the `Linkr BLE UART*` name prefix
- subscribe to TX notifications
- write terminal input to the RX characteristic
- query or set UART mode with `@u?` and `@u=...`
- adjust line ending and BLE write chunk size
- render terminal control sequences through xterm.js, including cursor movement,
  line erasing, readline redraws, 16-color, 256-color, and truecolor SGR
- show optional local echo and debug I/O traces
- save received bytes as a log file

This is useful for quick access on a machine that already has Chrome. The page
loads xterm.js from jsDelivr, so the Python terminal remains the better choice
for packaged offline use, automation, and loopback tests.
