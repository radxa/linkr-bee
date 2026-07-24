# Linkr BLE UART Bridge

> 中文文档：[README.zh-CN.md](README.zh-CN.md)

> Linkr integration: [BLE accessory API guide (Chinese)](docs/LINKR_BLE_API.zh-CN.md)

Zephyr application for an ESP32-C3 BLE serial bridge.  The first milestone is a
plain Bluetooth LE UART window:

- BLE peripheral advertising as `Linkr BLE UART-3`
- Nordic UART Service compatible UUIDs
- BLE RX characteristic writes are forwarded to the selected UART
- UART RX bytes are forwarded through BLE TX notifications

The Linkr product integrates this accessory through the API guide above; this
repository owns the accessory firmware and reference clients.

## Supported environment

- Firmware: ESP32-C3 DevKitM, DevKitC, and Super Mini
- Zephyr: **v4.4.1**
- Single firmware feature set: BLE UART bridge, WiFi station control,
  anonymous HTTP WebDAV log upload, and UART-over-WebSocket LAN access

## Build

Use a Zephyr v4.4.1 west workspace. The default WiFi-enabled build also needs
the Espressif HAL blobs (`modules/hal_espressif`) present in the manifest.

From that workspace:

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

### Gitea Actions build

The workflow in `.gitea/workflows/build.yml` builds one production firmware:
the default WiFi + BLE configuration for `esp32c3_supermini`. It runs on pushes
to `main`, version tags, pull requests, and manual dispatches using Zephyr
v4.4.1 with Zephyr SDK 1.0.1. To keep runner disk usage bounded, it installs
only the `riscv64-zephyr-elf` toolchain instead of the full Zephyr CI image.

Download the `linkr-ble-esp32c3-supermini` artifact from the completed Gitea
Actions run. Its flashable image is:

```text
linkr-ble-esp32c3-supermini.bin
```

On macOS or Linux, extract the artifact, install
[`esptool`](https://docs.espressif.com/projects/esptool/en/latest/esp32c3/),
connect the ESP32-C3 Super Mini, and run:

```sh
./flash_firmware.sh
```

If more than one serial device is connected, select it explicitly:

```sh
./flash_firmware.sh --port /dev/cu.usbmodemXXXX
```

The script writes the merged ESP32-C3 image at `0x0` without a full-chip erase.
Only the image sectors are rewritten; the settings partition at `0x3b0000`
is left untouched, so normal upgrades preserve the BLE identity and saved
configuration. Use the GPIO0 + GND factory-reset procedure when those
settings must be cleared. The artifact also contains `FLASHING.txt`,
`firmware.json`, the ELF, linker map, final Kconfig, runner metadata, and
`SHA256SUMS` for debugging and traceability. The workflow fails if the default
WiFi, networking, Bluetooth, or binary-output configuration is absent.

## UART selection

The app reads the UART from the devicetree chosen node
`zephyr,linkr-ble-uart`.  The provided ESP32-C3 overlays bind it to `uart0`.
If no bridge-specific chosen node is present, the app falls back to
`zephyr,shell-uart`, then `zephyr,console`.

On `esp32c3_supermini`, `uart0` is enabled for bridge traffic:

- RX: GPIO20
- TX: GPIO21
- Activity LED: GPIO8 blue LED, flashed on UART RX and TX activity
- Factory reset: GPIO0, internally pulled up; short it to GND during boot

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

## WiFi and WebDAV log upload

The single supported firmware always includes WiFi, WebDAV, and WebSocket
support. The WiFi radio stays off until the user sends `@w=ssid,pass`, so an
unprovisioned unit still behaves as a BLE UART bridge without requiring a
separate image.

WiFi credentials are RAM-only by default and are discarded on reboot. Set
`CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y` only on production devices
that have both secure boot and flash encryption provisioned: the PSK is stored
in Zephyr settings/NVS and is otherwise recoverable from flash. With that
explicit option, saved credentials reconnect on boot. The anonymous WebDAV URL
and the upload boot counter are persisted independently so upload filenames do
not collide after reboot.

A normal build already includes it:

```sh
west build -b esp32c3_supermini /Users/xiangzelong/Dev/linkr-ble
```

The ESP32-C3 SoC WiFi driver is `CONFIG_WIFI_ESP32` (defined in
`drivers/wifi/esp32/Kconfig.esp32`), which auto-selects the L2/ethernet/mgmt
layers and MBEDTLS. STA mode is the `CONFIG_WIFI_USAGE_MODE_STA` choice.

Two workspace prerequisites (not Kconfig):

- `modules/hal_espressif` must be in the west manifest — `CONFIG_WIFI_ESP32`
  depends on `ZEPHYR_HAL_ESPRESSIF_MODULE_BLOBS`.
- The board's devicetree must enable the `wifi` node. `esp32c3_devkitm` and
  `esp32c3_devkitc` already do `&wifi { status = "okay"; };` in their board
  DTS; `boards/esp32c3_supermini.overlay` adds it for the Super Mini.

The application code in `src/wifi.c` uses the standard `net_mgmt` /
`wifi_mgmt` APIs (`NET_REQUEST_WIFI_CONNECT`, `NET_EVENT_WIFI_CONNECT_RESULT`)
and starts DHCPv4 itself on connect, so no `CONFIG_NET_CONFIG_AUTO_INIT` is
needed.

### UART over WebSocket (LAN bridge)

When WiFi holds an IP address, the firmware also serves the bridge UART over a
WebSocket endpoint so LAN clients bypass BLE range and MTU limits entirely:

- Endpoint: `ws://<device-ip>/ws` (port from
  `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_PORT`, default 80)
- Protocol: binary WebSocket frames carry raw UART bytes in both directions;
  there is no framing — what you send is written to the UART, what the UART
  receives is broadcast to every connected client
- Clients: up to `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_MAX_CLIENTS` (default 2),
  each with its own TX ring buffer; a slow client drops oldest data instead of
  stalling the bridge
- Runtime control: `@s on|off|?`; the enabled flag is persisted in settings.
  `@i?` reports
  `@info ws state=up port=80 clients=N tx=… rx=… dropped=…`
- Optional deterrent: `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN` requires
  clients to send the token as their first text frame within 3 s
- Disable entirely with `-DCONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE=n`

The Web Bluetooth terminal (`web/`) has a BLE/LAN switch in the Connection
card; LAN mode connects to `ws://<host>/ws`, keeps terminal input, quick-send
chips and counters working, and disables management controls that require BLE
(`@u`/`@w`/`@d`/`@i?`). When BLE diagnostics report an IP, the LAN address
field is prefilled with it. The WebDAV log upload keeps running in parallel.

### Open BLE access, persistence, and factory reset

BLE pairing, bonding, and owner enforcement are currently disabled to keep the
development workflow reliable. Any nearby central that connects to the NUS
service can use the UART stream and all management commands, including WiFi,
WebDAV, and WebSocket settings. Do not attach a sensitive console or deploy
this development build in an untrusted radio environment.

| Item | Default / persistence rule | Clear or transfer |
| --- | --- | --- |
| BLE identity/address | A random-static Linkr identity is persisted in NVS and reused across normal reboots | GPIO0 factory reset generates a new identity/address so hosts do not reuse stale device-name caches |
| WiFi SSID/PSK | RAM-only by default; `CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y` saves it and reconnects on boot | `@w off` disables it and disconnects; factory reset erases it |
| WebDAV target | Anonymous URL is persisted independently of WiFi credential persistence | `@d off` disables it; factory reset erases it |
| Upload boot ID | Persisted when the uploader reserves a new boot ID, preventing filename reuse after reboot | Factory reset erases it |

Saved WiFi and WebDAV configurations are single versioned settings records;
invalid or unsafe saved records are ignored at boot. The credential-persistence
Kconfig option is a deployment promise, not a runtime check: enable it only
after secure boot and flash encryption have actually been provisioned. On an
unencrypted device, an SSID/PSK written to NVS can be recovered from flash.
`@w off` is a functional clear, not a validated secure-flash wipe; use factory
reset before disposal or reprovisioning.

To factory-reset a physical unit, reset or power-cycle it with **GPIO0 shorted
to GND** and keep the short in place for two seconds. The firmware erases the
entire `storage_partition` before Bluetooth or settings load, clearing Bluetooth
identity data, Linkr WiFi/WebDAV configuration, and the upload boot counter.
The device then advertises with a newly generated random-static BLE
identity/address. This makes macOS, Chrome, and other centrals create a fresh
device record instead of retaining stale cached metadata. Do not tie GPIO0 to
GND permanently, and treat
access to that pad or switch as access to factory reset. It does not erase
firmware, the test-marker partition, or coredump storage.

The Python, C, and Web Bluetooth clients send management commands directly;
`--pair` is retained only as a deprecated no-op. The current WebDAV uploader
also accepts anonymous HTTP only, so use it solely on a trusted local network.

UART RX bytes are buffered and periodically HTTP-PUT to
`<webdav_url>log-<boot-id>-<sequence>-<uptime>.txt`. Upload waits for an IPv4
address, retries connection failures, keeps a failed batch name stable, and
discards queued bytes if its target is changed or disabled.

Control commands (short form fits the default 20-byte BLE write before MTU
exchange):

```text
@i?                          read device diagnostics
@w scan                      scan nearby 2.4 GHz WiFi networks (pairing-free)
@w?                          query WiFi status
@w=MySSID,secret             join WiFi (RAM-only unless persistence is enabled)
@w off                       clear WiFi configuration and disconnect
@d?                          query WebDAV status
@d=http://host/dav/          set anonymous WebDAV target and enable upload
@d off                       disable WebDAV upload
```

Long forms `@linkr info?`, `@linkr wifi scan`, `@linkr wifi?`,
`@linkr wifi=...`, and `@linkr webdav=...` are also accepted. Responses come
back over the NUS TX notification characteristic:

```text
OK wifi=connected,ssid=MySSID
OK webdav=on,url=http://host/dav/
```

The diagnostic command is read-only. It reports the application and Zephyr
versions, uptime, the open BLE access/security state, UART buffer usage and
dropped-byte count, WiFi/IP state, and WebDAV
queue, drop, HTTP, failure, and success counters:

```text
@info fw version=0.2.0 zephyr=4.4.1
@info sys uptime_ms=123456 owner=0 security=1
@info uart dropped=0 buffer=0/16384
@info wifi state=connected ip=ready error=0
@info upload state=on queue=0 dropped=0 http=201 failures=0 successes=4
@info done
```

The application version comes from
`CONFIG_LINKR_BLE_BRIDGE_FIRMWARE_VERSION`.

From the Python terminal:

```sh
python3 tools/linkr_ble_terminal.py --query-info --no-terminal
python3 tools/linkr_ble_terminal.py --wifi-scan --no-terminal
python3 tools/linkr_ble_terminal.py --wifi MySSID,secret --query-wifi
python3 tools/linkr_ble_terminal.py --webdav http://host/dav/
```

Configuration commands are carried in a length-prefixed `@!<bytes>:` frame by
the supplied Python, C, and web clients, so SSIDs, PSKs, and long URLs remain
one atomic command even when BLE splits them across ATT writes. Legacy short
commands are still accepted directly.

The uploader accepts anonymous HTTP endpoints only. It rejects Basic Auth
credentials because sending them over plain HTTP would expose them on the
network. Use this mode only on a trusted local network; authenticated or
internet-facing deployments require a future HTTPS build with a provisioned CA
trust anchor.

The Web Bluetooth terminal exposes structured SSID/password fields, a WiFi
scan list, device diagnostics, and the same WebDAV controls. The C reference
terminal accepts `--query-info`, `--wifi-scan`, `--wifi`, `--wifi-off`,
`--query-wifi`, `--webdav`, `--webdav-off`, and `--query-webdav`.

## Test options

All test options default to off.

Run the repeatable local regression check (the single WiFi + BLE firmware,
Python syntax, and shell syntax) with:

```sh
tools/verify.sh
```

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

Build the hardware loopback verifier after shorting UART0 TX (GPIO21) to RX
(GPIO20):

```sh
west build -p always -b esp32c3_devkitm /Users/xiangzelong/Dev/linkr-ble -- \
  -DEXTRA_CONF_FILE=test_loopback.conf
```

For a BLE NUS echo diagnostic using the same full firmware feature set (no
UART wiring required):

```sh
west build -p always -b esp32c3_supermini /Users/xiangzelong/Dev/linkr-ble -- \
  -DEXTRA_CONF_FILE=test_ble_echo.conf
```

Both diagnostic modes use the dedicated `linkr-test-marker` flash partition;
they do not write the ESP32-C3 coredump sector.

## BLE protocol

This uses Zephyr's built-in Nordic UART Service:

- Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- RX write characteristic: `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- TX notify characteristic: `6e400003-b5a3-f393-e0a9-e50e24dcca9e`

The checked-in production configuration uses the baseline ATT/L2CAP MTU of 23,
so every client must support **20-byte writes**. If the central explicitly
reports a larger write-without-response limit, a client may use
`min(platform_limit, 62)`. The firmware continues to segment UART notifications
to the actual ATT/ACL capacity, and the host terminal prints the detected write
chunk size when it connects.

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
./linkr_ble_terminal_c --query-info --no-terminal
./linkr_ble_terminal_c --wifi-scan --no-terminal
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
- `--query-info --no-terminal`: read firmware and runtime diagnostics
- `--wifi-scan --no-terminal`: list nearby 2.4 GHz WiFi networks through the bridge
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
allow a web page to scan and connect silently.  After the user authorizes a
device once, browsers that implement `navigator.bluetooth.getDevices()` let the
page restore that device after a refresh.  `Connect` or `Reconnect` can then
reuse the authorization without reopening the chooser.  If the saved device is
no longer available, the page clears it and falls back to the normal chooser on
the next attempt.  Browsers without `getDevices()` always use the chooser.

The firmware places the NUS service UUID in the primary advertising packet and
the `Linkr BLE UART-3` name in the scan response.  The page filters the browser
device chooser by the NUS service UUID, which is more reliable than name-only
filtering on macOS Chromium browsers.

The page can:

- connect to devices advertising the Linkr NUS service UUID
- restore the last authorized Linkr device after a page refresh for quick
  reconnect, when the browser supports `navigator.bluetooth.getDevices()`
- subscribe to TX notifications
- keep firmware/runtime diagnostics collapsed by default; expanding the panel
  queries the device, and the data can also be refreshed on demand
- scan nearby 2.4 GHz WiFi networks and fill separate SSID/password fields
  without writing the password to the application's `localStorage`
- capture input directly inside xterm.js and write each keystroke to the RX
  characteristic; remote shells therefore receive native Tab completion,
  command-history arrows, backspace, Ctrl-C, and pasted text
- query or set UART mode with `@u?` and `@u=...`
- adjust line ending and BLE write chunk size
- switch between the system monospace stack and common locally installed Nerd
  Fonts, with a Powerline/Nerd glyph preview; the selection is persisted for
  the current browser origin, but the font files themselves are not bundled
- render terminal control sequences through xterm.js, including cursor movement,
  line erasing, readline redraws, 16-color, 256-color, and truecolor SGR
- expand the terminal to fullscreen and automatically refit its rows and columns
  when the viewport or control-panel width changes
- show optional local echo and debug I/O traces
- save received bytes as a log file

After connecting, the page focuses the terminal automatically. Click or tap the
terminal whenever it loses focus, then type directly in it; there is no separate
line-input box. BLE writes are serialized so fast typing and paste operations do
not start overlapping GATT writes. The on-screen `Ctrl-C` button remains
available for touch devices.

This is useful for quick access on a machine that already has Chrome. The page
loads xterm.js from jsDelivr, so the Python terminal remains the better choice
for packaged offline use, automation, and loopback tests.
