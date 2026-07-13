# Linkr BLE UART Bridge

> 中文文档：[README.zh-CN.md](README.zh-CN.md)

Zephyr application for an ESP32-C3 BLE serial bridge.  The first milestone is a
plain Bluetooth LE UART window:

- BLE peripheral advertising as `Linkr BLE UART-3`
- Nordic UART Service compatible UUIDs
- BLE RX characteristic writes are forwarded to the selected UART
- UART RX bytes are forwarded through BLE TX notifications

The Linkr card/device integration is intentionally left for a later layer.

## Supported environment

- Firmware: ESP32-C3 DevKitM, DevKitC, and Super Mini
- Zephyr: **v4.4.1**
- Default feature set: BLE UART bridge, WiFi station control, and anonymous
  HTTP WebDAV log upload
- BLE-only feature set: `CONFIG_LINKR_BLE_BRIDGE_WIFI=n`

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
v4.4.1 with Zephyr SDK 1.0.1.

Download the `linkr-ble-esp32c3-supermini` artifact from the completed Gitea
Actions run. Its flashable image is:

```text
linkr-ble-esp32c3-supermini.bin
```

The artifact also contains the ELF, linker map, final Kconfig, runner metadata,
and `SHA256SUMS` for debugging and traceability. The workflow fails if the
default WiFi, networking, Bluetooth, or binary-output configuration is absent.

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

The WiFi + WebDAV feature is **enabled by default** through
`CONFIG_LINKR_BLE_BRIDGE_WIFI=y`. The radio stays off until the user sends
`@w=ssid,pass`. Its Kconfig option selects the networking, WiFi, DNS, and HTTP
dependencies; a BLE-only build removes all of them:

```sh
west build -p always -b esp32c3_supermini /Users/xiangzelong/Dev/linkr-ble -- \
  -DCONFIG_LINKR_BLE_BRIDGE_WIFI=n
```

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

### BLE pairing, owner, persistence, and factory reset

Pairing protects the **management plane**, not the general NUS UART stream.
Every WiFi or WebDAV command, including `@w?` and `@d?`, requires BLE Security
Level 3 (encrypted and authenticated with MITM protection). If the connection
is below that level, the firmware starts a security upgrade, returns a pairing
required response, and the caller must complete pairing then retry the command.
Raw NUS UART traffic and `@u...` UART configuration are deliberately outside
this gate; do not attach a sensitive console unless that access model is
acceptable.

On the first pairing, a six-digit passkey is printed on the bridge's USB serial
console and must be entered on the central. The resulting BLE bond is stored in
Zephyr settings/NVS. The firmware treats the presence of *any* bond as an
owner: it accepts one bonded central and rejects every new pairing request.
This also means that deleting the device from the owner's phone or computer
does not release ownership on the bridge; use factory reset before moving to a
new owner.

| Item | Default / persistence rule | Clear or transfer |
| --- | --- | --- |
| BLE bond and owner | Always persisted by `CONFIG_BT_SETTINGS` in NVS | GPIO0 factory reset only; no BLE command unpairs the owner |
| BLE identity/address | A random-static Linkr identity is persisted in NVS and reused across normal reboots | GPIO0 factory reset generates a new identity/address so hosts do not reuse stale device-name or bond caches |
| WiFi SSID/PSK | RAM-only by default; `CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y` saves it and reconnects on boot | `@w off` disables it and disconnects; factory reset erases it |
| WebDAV target | Anonymous URL is persisted independently of WiFi credential persistence | `@d off` disables it; factory reset erases it |
| Upload boot ID | Persisted when the uploader reserves a new boot ID, preventing filename reuse after reboot | Factory reset erases it |

Saved WiFi and WebDAV configurations are single versioned settings records;
invalid or unsafe saved records are ignored at boot. The credential-persistence
Kconfig option is a deployment promise, not a runtime check: enable it only
after secure boot and flash encryption have actually been provisioned. On an
unencrypted device, an SSID/PSK written to NVS can be recovered from flash.
`@w off` is a functional clear, not a validated secure-flash wipe; use factory
reset before disposal or ownership transfer.

To factory-reset a physical unit, reset or power-cycle it with **GPIO0 shorted
to GND** and keep the short in place for two seconds. The firmware erases the
entire `storage_partition` before Bluetooth or settings load, clearing the BLE
owner/bond, Bluetooth identity data, Linkr WiFi/WebDAV configuration, and the
upload boot counter. The device then starts unowned and advertises with a newly
generated random-static BLE identity/address. This makes macOS, Chrome, and
other centrals create a fresh device record instead of retaining the old
owner's cached name or bond. Do not tie GPIO0 to GND permanently, and treat
access to that pad or switch as access to factory reset. It does not erase
firmware, the test-marker partition, or coredump storage.

The Python tool pairs automatically for WiFi/WebDAV actions (or use `--pair`);
the C tool needs a running BlueZ pairing agent; Web Bluetooth shows the
browser's native pairing prompt, then the action must be retried. BLE pairing
does not encrypt the subsequent WebDAV upload: the current uploader accepts
anonymous HTTP only, so use it solely on a trusted local network.

UART RX bytes are buffered and periodically HTTP-PUT to
`<webdav_url>log-<boot-id>-<sequence>-<uptime>.txt`. Upload waits for an IPv4
address, retries connection failures, keeps a failed batch name stable, and
discards queued bytes if its target is changed or disabled.

Control commands (short form fits the default 20-byte BLE write before MTU
exchange):

```text
@w?                          query WiFi status
@w=MySSID,secret             join WiFi (RAM-only unless persistence is enabled)
@w off                       clear WiFi configuration and disconnect
@d?                          query WebDAV status
@d=http://host/dav/             set anonymous WebDAV target and enable upload
@d off                       disable WebDAV upload
```

Long forms `@linkr wifi?`, `@linkr wifi=...`, `@linkr webdav=...` are also
accepted. Responses come back over the NUS TX notification characteristic:

```text
OK wifi=connected,ssid=MySSID
OK webdav=on,url=http://host/dav/
```

From the Python terminal:

```sh
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

The Web Bluetooth terminal exposes the same controls as `Set WiFi` /
`WiFi ?` / `Set WebDAV` / `WebDAV ?` buttons, and the C reference terminal
accepts `--wifi`, `--wifi-off`, `--query-wifi`, `--webdav`, `--webdav-off`,
`--query-webdav`.

## Test options

All test options default to off.

Run the repeatable local regression check (WiFi build, BLE-only build, Python
syntax, and shell syntax) with:

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

For a BLE-only NUS echo diagnostic (no UART wiring required):

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

The checked-in default configuration negotiates an ATT/L2CAP MTU of 65 with an
ACL TX buffer of 27. Its effective NUS payload is therefore at most **62 bytes
per write/notification**. The firmware segments UART bursts accordingly, and
the supplied Python, C, and Web Bluetooth clients cap their writes at 62 bytes.

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

The firmware places the NUS service UUID in the primary advertising packet and
the `Linkr BLE UART-3` name in the scan response.  The page filters the browser
device chooser by the NUS service UUID, which is more reliable than name-only
filtering on macOS Chromium browsers.

The page can:

- connect to devices advertising the Linkr NUS service UUID
- subscribe to TX notifications
- capture input directly inside xterm.js and write each keystroke to the RX
  characteristic; remote shells therefore receive native Tab completion,
  command-history arrows, backspace, Ctrl-C, and pasted text
- query or set UART mode with `@u?` and `@u=...`
- adjust line ending and BLE write chunk size
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
