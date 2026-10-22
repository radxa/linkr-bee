# Linkr Bee development guide

> [Project overview](../README.md) | [User guide](USAGE.md) | [Documentation](README.md) | [中文开发指南](DEVELOPMENT.zh-CN.md) | [BLE accessory API guide (Chinese)](LINKR_BLE_API.zh-CN.md)

This guide covers firmware builds, flashing, UART integration, control commands,
test modes, client tooling, protocols, and Kconfig options.

Zephyr application for an ESP32-C3/C5/WROOM BLE serial bridge. The first milestone is a
plain Bluetooth LE UART window:

- BLE peripheral advertising as `Linkr Bee XXXX`, where `XXXX` is the last
  four hex digits of the hardware MAC (all boards; `@n` can replace it)
- Nordic UART Service compatible UUIDs
- BLE RX characteristic writes are forwarded to the selected UART
- UART RX bytes are forwarded through BLE TX notifications

The Linkr product integrates this accessory through the API guide above; this
repository owns the accessory firmware and reference clients.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Supported Environment](#supported-environment)
- [Build](#build)
  - [GitHub Actions Build](#github-actions-build)
- [UART Selection](#uart-selection)
- [SBC UART Settings](#sbc-uart-settings)
  - [On-demand UART Autobaud (ESP32-WROOM)](#on-demand-uart-autobaud-esp32-wroom)
- [WiFi and WebDAV Log Upload](#wifi-and-webdav-log-upload)
  - [UART over WebSocket (LAN Bridge)](#uart-over-websocket-lan-bridge)
  - [Pairing GPIO, Persistence, and Factory Reset](#pairing-gpio-persistence-and-factory-reset)
- [Control Commands Reference](#control-commands-reference)
- [Test Options](#test-options)
- [BLE Protocol](#ble-protocol)
- [BLE Terminal](#ble-terminal)
  - [C Terminal for Linux or Linkr Buildroot](#c-terminal-for-linux-or-linkr-buildroot)
  - [Shell completion](#shell-completion)
- [Web Bluetooth Terminal](#web-bluetooth-terminal)
- [Mobile Apps](#mobile-apps)
- [Validation Status](#validation-status)
- [Configuration Reference](#configuration-reference)

---

## Quick Start

Get the firmware running in 5 steps:

```sh
# 1. Clone and enter the workspace
git clone https://github.com/radxa/linkr-bee.git
cd linkr-bee

# 2. Build for ESP32-C3 Super Mini (default WiFi + BLE)
west build -b esp32c3_supermini linkr-bee

# 3. Flash to device
west flash

# 4. Connect via Python terminal
python3 tools/linkr_ble_terminal.py

# 5. Or serve Web terminal locally
tools/serve_web.sh  # Open http://127.0.0.1:8765/
```

> **Note**: Requires Zephyr v4.4.1 west workspace with Espressif HAL blobs. See [Build](#build) for details.

## Supported environment

- Firmware: ESP32-C3 DevKitM, DevKitC, Super Mini, and ESP32-C5 DevKitC
- Zephyr: **v4.4.1**
- One firmware source tree with BLE UART bridge, WiFi station control,
  anonymous HTTP WebDAV log upload, and UART-over-WebSocket LAN access.
  WebDAV is enabled in the default C3/C5 builds; the ESP32-WROOM build disables
  it for DRAM (`CONFIG_LINKR_BLE_BRIDGE_WEBDAV=n`), and the host reports the
  device's refusal on that board instead of hiding the command.

## Build

Use a Zephyr v4.4.1 west workspace. The default WiFi-enabled build also needs
the Espressif HAL blobs (`modules/hal_espressif`) present in the manifest.

The manifest allowlist also pulls in `hostap`. The ESP32-C5 controller
implements its BLE Security Manager crypto with
`CONFIG_ESP32_BT_LE_CRYPTO_STACK_MBEDTLS`, and Zephyr satisfies that from the
legacy mbedTLS modules vendored by hostap
(`zephyr/modules/mbedtls/legacy_support.cmake`). Without the module a C5 build
fails to configure; it never silently loses pairing. `tools/verify.sh` and the
CI workflow assert that the C3 (`ESP32_BT_CTLR_LE_SECURITY_ENABLE`) and C5
(`ESP32_BT_LE_SECURITY_ENABLE`, `…_SM_SC`, `…_LL_CFG_FEAT_LE_ENCRYPTION`,
`…_CRYPTO_STACK_MBEDTLS`) controller security symbols stay enabled.

From that workspace:

```sh
west build -b esp32c3_devkitm linkr-bee
```

or for DevKitC:

```sh
west build -b esp32c3_devkitc linkr-bee
```

For ESP32-C3 Super Mini:

```sh
west build -b esp32c3_supermini linkr-bee
```

For ESP32-C5 DevKitC:

```sh
west build -b esp32c5_devkitc/esp32c5/hpcore linkr-bee
```

### GitHub Actions build

The workflow in `.github/workflows/build.yml` builds each board's default
WiFi + BLE configuration for `esp32c3_supermini`, `esp32c3_devkitm`,
`esp32c3_devkitc`, `esp32c5_devkitc/esp32c5/hpcore`, and
`esp32_devkitc/esp32/procpu` (ESP32-WROOM-32). It runs on pushes to `main`,
pull requests, and manual dispatches using Zephyr v4.4.1 with Zephyr SDK
1.0.1. To keep runner disk usage bounded, each job installs only the
toolchain its board needs — `riscv64-zephyr-elf` for the RISC-V targets and
`xtensa-espressif_esp32_zephyr-elf` for the WROOM — instead of the full Zephyr
CI image.

A project release starts from a `v*` tag. `.github/workflows/release.yml`
reuses this workflow and the desktop matrix, then
`tools/assemble_release.py` checks the version carried by each artifact and
assembles the firmware ZIPs, Web package, APK and desktop archives. A manual
release dispatch can run the same assembly as a dry run from a tag without
touching the GitHub release.

Download the artifact matching the target from the completed GitHub Actions
run. The flashable images are:

```text
linkr-bee-esp32c3-supermini.bin
linkr-bee-esp32c3-devkitm.bin
linkr-bee-esp32c3-devkitc.bin
linkr-bee-esp32c5-devkitc.bin
linkr-bee-esp32-wroom-32.bin
```

On macOS or Linux, extract the artifact, install
[`esptool`](https://docs.espressif.com/projects/esptool/en/latest/),
connect the ESP32-C3 Super Mini, and run:

```sh
./flash_firmware.sh
```

If more than one serial device is connected, select it explicitly:

```sh
./flash_firmware.sh --port /dev/cu.usbmodemXXXX
```

The script infers the target from the standard image name and writes C3 at
`0x0`, C5 at `0x2000`, or WROOM at `0x1000` without a full-chip erase. Only
image sectors are rewritten, so normal upgrades preserve the BLE identity and
saved configuration. Use the board-specific factory-reset input when those settings
must be cleared. The artifact also contains `FLASHING.txt`,
`firmware.json`, the ELF, linker map, final Kconfig, runner metadata, and
`SHA256SUMS` for debugging and traceability. The workflow fails if the default
WiFi, networking, Bluetooth, or binary-output configuration is absent.

## UART selection

The app reads the UART from the devicetree chosen node
`zephyr,linkr-ble-uart`. The provided ESP32-C3 overlays bind it to `uart0`;
the ESP32-C5 DevKitC overlay binds it to `uart1` on GPIO11/12.
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

When `CONFIG_LINKR_BLE_BRIDGE_CONTROL_COMMANDS=y`, the Management Service v1
accepts these UART configuration payloads:

```text
@u?
@u=115200,8,n,1,n
@u=1500000,8,n,1,n
@u=115200,7,e,1,n
@h
```

The longer forms are also accepted:
`@linkr uart?`, `@linkr uart=115200,8,n,1,none`, and `@linkr help`.

Responses are returned on the separate Management Response indication with the
same request ID, for example:

```text
OK uart=115200,8,N,1,none
ERR format: @u=115200,8,n,1,n
```

### On-demand UART autobaud (ESP32-WROOM)

The WROOM build supports `CONFIG_LINKR_BLE_BRIDGE_UART_AUTOBAUD`, but its
board default leaves the option off (`=n`) so a release image never rewrites
the UART settings on its own. Enable it explicitly in the build; even then the
detector is idle at boot and does not follow the line rate until asked:

```text
@a?          query: OK autobaud state=idle|running baud=... timeout_ms=5000
@a           start one pass (also @a start)
@a stop      cancel the running pass
```

A pass samples one 400 ms RMT window at a time and requires two agreeing
windows before it calls `uart_configure()`. It ends on a confirmed match
(`applied` or `unchanged`), a failed reconfigure (`error`), no measurable
capture for 5 seconds (`timeout`), or `@a stop` (`stopped`). Every capture,
and every pin sample that finds the line active, resets the 5-second clock,
so a line that is still talking keeps the pass alive even when its gaps are
too short for the receiver to begin a capture. A 60-second hard deadline still
bounds a line that never goes quiet. A completed pass is never restarted
automatically.

The start response is non-final. The result arrives later as a type=3
Management event with the same request ID and `FINAL`:

```text
@event autobaud state=applied old=115200 new=1500000
@event autobaud state=unchanged old=115200 new=115200
@event autobaud state=timeout old=115200 new=115200
@event autobaud state=stopped old=115200 new=115200
@event autobaud state=error old=115200 new=57600
```

The WROOM overlay maps the active-low `linkr-autobaud` key to GPIO13. Pressing
it starts exactly the same one-shot pass, with no request ID; that pass only
logs its result. GPIO2 remains the board's active-low activity LED, so the LED
and key do not share a pin. Do not connect a key from GPIO2 to GND: GPIO2 is an
output, and the LED is still connected, so that would short the output. GPIO13
has no boot strapping function, but do not hold the key during reset: the pass
would start as soon as the firmware boots.

## WiFi and WebDAV log upload

The firmware source includes WiFi, WebDAV, and WebSocket support. WebDAV is
enabled in the default ESP32-C3/C5 builds; the ESP32-WROOM build disables it
because its DRAM budget is too small (`CONFIG_LINKR_BLE_BRIDGE_WEBDAV=n`). The
feature is still part of the protocol, so the host keeps the command and shows
the board's own refusal on a build where it is absent. The WiFi radio stays off
until the user sends `@w=ssid,pass`, so an unprovisioned unit still behaves as a
BLE UART bridge without requiring a separate image.

WiFi credentials are RAM-only by default and are discarded on reboot. Set
`CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y` only on production devices
that have both secure boot and flash encryption provisioned: the PSK is stored
in Zephyr settings/NVS and is otherwise recoverable from flash. With that
explicit option, saved credentials reconnect on boot. The anonymous WebDAV URL
and the upload boot counter are persisted independently so upload filenames do
not collide after reboot.

A normal C3 build already includes it:

```sh
west build -b esp32c3_supermini linkr-bee
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
- Runtime control: `@s on|off|?` plus `@s token…`; the enabled flag and the LAN
  access token are persisted in settings.
  `@i?` reports
  `@info ws state=up port=80 clients=N tx=… rx=… dropped=…` (no token)
- Protocol: after the upgrade the bridge sends a text frame announcing whether a
  token is required (`@ws auth=none` / `@ws auth=required`), and `@ws auth=ok`
  once access is granted. UART bytes always travel as binary frames. See
  [BLE accessory API v1](LINKR_BLE_API.zh-CN.md) section 8.
- Access token: a 128-bit token is generated on first boot and stored in
  settings, so the LAN port is not open to the whole network by default.
  `@s?` reports it over the encrypted BLE channel, `@s token` rotates it,
  `@s token=<32 hex>` sets one, and `@s token off` restores unauthenticated
  access. `@i?` never contains the token. The token gates access only: `ws://`
  traffic stays readable on the local network.
- Legacy override: `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN` pins a
  build-time token (32 lowercase hex) and takes precedence over the generated one
- Disable entirely with `-DCONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE=n`

The Web Bluetooth terminal (`web/`) has a BLE/LAN switch in the Connection
card; LAN mode connects to `ws://<host>/ws`, keeps terminal input, quick-send
chips and counters working, and disables management controls that require BLE
(`@u`/`@w`/`@d`/`@i?`). When BLE diagnostics report an IP, the LAN address
field is prefilled with it. The WebDAV log upload keeps running in parallel.

The shipped configuration enables
`CONFIG_LINKR_BLE_BRIDGE_UART_RX_DROP_NO_CONN=y` on every board. After a BLE
session disconnects, UART capture continues feeding WebSocket clients and the
log uploader; bytes discarded from BLE delivery are not replayed on reconnect.

### Pairing GPIO, persistence, and factory reset

BLE uses LE Secure Connections Just Works pairing, bonding and encrypted GATT
access. C3/C5 hold GPIO1 low before a new host requests pairing. WROOM ships
with `CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=n`, so no GPIO press is needed;
if that option is enabled, GPIO4 is the pairing input. Existing bonds restore
encryption without the pairing GPIO; replacing lost host keys requires it again
when the check is enabled. The default is eight bonds with no automatic
eviction. A full table requires factory reset before adding more hosts. See
[pairing and recovery](BLE_PAIRING.md).

| Item | Default / persistence rule | Clear or transfer |
| --- | --- | --- |
| BLE bonds | Up to eight host key records persisted by `CONFIG_BT_SETTINGS` | Board-specific factory reset clears all bonds and other settings |
| BLE identity/address | A random-static Linkr identity is persisted in NVS and reused across normal reboots | Board-specific factory reset generates a new identity/address so hosts do not reuse stale caches; the default `Linkr Bee XXXX` name stays tied to the hardware MAC and does not change |
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

To factory-reset a physical unit, reset or power-cycle it with the reset input
shorted to GND and keep the short in place for two seconds: GPIO0 on C3 boards,
or GPIO28/BOOT on the C5 DevKitC. The firmware erases the
entire `storage_partition` before Bluetooth or settings load, clearing Bluetooth
identity data, Linkr WiFi/WebDAV configuration, and the upload boot counter.
The device then advertises with a newly generated random-static BLE
identity/address. This makes macOS, Chrome, and other centrals create a fresh
device record instead of retaining stale cached metadata. Do not tie the reset
input to GND permanently, and treat
access to that pad or switch as access to factory reset. It does not erase
firmware, the test-marker partition, or coredump storage.

The Python, C, and Web Bluetooth clients send management commands directly;
`--pair` is retained only as a deprecated no-op. The current WebDAV uploader
also accepts anonymous HTTP only, so use it solely on a trusted local network.

UART RX bytes are buffered and periodically HTTP-PUT to
`<webdav_url>log-<boot-id>-<sequence>-<uptime>.txt`. Upload waits for an IPv4
address, retries connection failures, keeps a failed batch name stable, and
discards queued bytes if its target is changed or disabled.

## Control Commands Reference

All commands support short form (fits 20-byte BLE write before MTU exchange) and long form (`@linkr ...`).

### Diagnostic Commands

| Short Form | Long Form | Description |
|------------|-----------|-------------|
| `@i?` | `@linkr info?` | Read device diagnostics (firmware version, uptime, UART stats, WiFi state, WebDAV counters) |
| `@h` | `@linkr help` | List available commands |

### WiFi Commands

| Short Form | Long Form | Description |
|------------|-----------|-------------|
| `@w scan` | `@linkr wifi scan` | Scan nearby 2.4 GHz WiFi networks (encrypted BLE) |
| `@w?` | `@linkr wifi?` | Query WiFi status |
| `@w=SSID,pass` | `@linkr wifi=SSID,pass` | Join WiFi (RAM-only unless persistence enabled) |
| `@w off` | `@linkr wifi off` | Clear WiFi config and disconnect |

### WebDAV Commands

| Short Form | Long Form | Description |
|------------|-----------|-------------|
| `@d?` | `@linkr webdav?` | Query WebDAV status |
| `@d=URL` | `@linkr webdav=URL` | Set anonymous WebDAV target and enable upload |
| `@d off` | `@linkr webdav off` | Disable WebDAV upload |

### WebSocket Commands

| Short Form | Long Form | Description |
|------------|-----------|-------------|
| `@s?` | `@linkr socket?` | Query WebSocket bridge status (includes the LAN token) |
| `@s on` | `@linkr socket on` | Enable WebSocket bridge |
| `@s off` | `@linkr socket off` | Disable WebSocket bridge |
| `@s token` | `@linkr socket token` | Generate and store a new LAN access token |
| `@s token=<32 hex>` | `@linkr socket token=<32 hex>` | Set the LAN access token |
| `@s token off` | `@linkr socket token off` | Disable LAN auth (unauthenticated access) |

### BLE Name Commands (all boards)

| Short Form | Long Form | Description |
|------------|-----------|-------------|
| `@n?` | `@linkr name?` | Query the current advertised name and whether it is custom |
| `@n=<name>` | `@linkr name=<name>` | Set and persist a 1–29 byte UTF-8 name; Chinese and emoji are allowed (emoji are usually 4 bytes each) |
| `@n default` | `@linkr name default` | Delete the custom name and restore `Linkr Bee XXXX` |

`XXXX` is the last four hex digits of the factory hardware MAC (for example
`58:BF:25:33:07:8C` becomes `078C`). Names are limited by UTF-8 bytes, not
characters: Chinese is allowed, and emoji are valid too (a typical emoji uses
four bytes, so seven fit in 28 bytes while eight exceed the 29-byte limit).
The firmware trims only space, tab, CR and LF from the value, and rejects C0,
DEL, C1 and U+2028/U+2029; hosts apply the same rule and byte count before
sending. `@n default` is the reset form only with exactly one space after
`@n`; `@n=default` (and `@n  default` with two spaces) sets a custom name
literally called `default`. A query answers `OK name=<name> custom=yes|no`;
a set or reset answers `OK name=<name>` without the provenance field, so a
client that needs to know where the name came from queries again. For current firmware the
name is display-only: hosts must discover the Management Service UUID and
verify Device ID, never match on the advertised name. The TUI and Web clients
keep one narrow compatibility exception: a pre-service device with the fixed
`Linkr BLE UART...` name and only NUS is treated as a terminal-only legacy
board. A `Linkr Bee...` name without the service is always refused.

**The address identifies a board; the name labels it.** The owner can rename
a board at any time, so a name is never an identity:

- the board is *found* by the Management Service it advertises, and reached by
  its BLE address;
- the board is *named* by its own answer to `@n?`, which is what every client
  shows. The desktop terminal asks the board as soon as a link comes up and
  again after every rename, so a board renamed from another client is named
  correctly on the next connection;
- a client that is given a name that matches nothing says which boards were
  heard and how to reach one of them by address;
- a rename makes the board broadcast the new name: the scan response is
  copied into the controller when advertising starts, so the firmware restarts
  the advertising once the new name is installed.

Every host client exposes the same three operations:

| Host | Read | Set | Restore default |
| --- | --- | --- | --- |
| `bee` (TUI) | Network view → *Read name* | Network view → *Rename* | Network view → *Restore default* |
| `bee-cli` | `--query-ble-name` / `query ble-name` | `--rename-ble NAME` / `set ble-name NAME` | `--reset-ble-name` / `set ble-name default` |
| `bee --serve` | `{"op":"ble-name"}` | `{"op":"ble-name","name":"…"}` | `{"op":"ble-name","default":true}` |
| `linkr_ble_terminal.py` | `--query-ble-name` | `--rename-ble NAME` | `--reset-ble-name` |
| `linkr_ble_terminal_c` | `--query-ble-name` | `--rename-ble NAME` | `--reset-ble-name` |
| Web / mobile | *BLE name* controls next to the device | same | same |

The desktop and mobile clients ask the board first (`@n?`) and show whether the
name is the MAC-derived default or a custom one; a write is confirmed by the
board and read back. The C client prints the board's answer on stdout.

### UART Commands

| Short Form | Long Form | Description |
|------------|-----------|-------------|
| `@u?` | `@linkr uart?` | Query UART settings |
| `@u=baud,data,parity,stop,flow` | `@linkr uart=...` | Set UART mode |

### Autobaud Commands (ESP32-WROOM)

| Short Form | Long Form | Description |
|------------|-----------|-------------|
| `@a?` | `@linkr autobaud?` | Query detector state and current baud |
| `@a` / `@a start` | `@linkr autobaud` / `@linkr autobaud start` | Start one on-demand pass |
| `@a stop` | `@linkr autobaud stop` | Cancel the running pass |

The start response is non-final; the result is a `FINAL` type=3
`@event autobaud ...` on the same request ID. See
[on-demand autobaud](#on-demand-uart-autobaud-esp32-wroom) for the state
machine and GPIO13 trigger.

### Response Format

Responses come back over the Management Response indication:

```text
OK wifi=connected,ssid=MySSID
OK webdav=on,url=http://host/dav/
OK uart=115200,8,N,1,none
ERR format: @u=115200,8,n,1,n
```

The diagnostic command is read-only. It reports the application and Zephyr
versions, uptime, the open BLE access/security state, UART buffer usage and
dropped-byte count, WiFi/IP state, and WebDAV
queue, drop, HTTP, failure, and success counters:

```text
@info fw version=0.1.2 zephyr=4.4.1
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

The advertised BLE name is read and changed the same way on every host:

```sh
python3 tools/linkr_ble_terminal.py --query-ble-name --no-terminal
python3 tools/linkr_ble_terminal.py --rename-ble '测试😀' --no-terminal
python3 tools/linkr_ble_terminal.py --reset-ble-name --no-terminal
```

The name is 1–29 UTF-8 bytes and is checked on the host before anything is
sent, so Chinese and emoji are accepted and a name the firmware would refuse
fails without touching the radio. The change is persisted in the board's
settings and survives a reboot; `--reset-ble-name` restores the
MAC-derived `Linkr Bee XXXX`.

Scripting and safety notes:

- `--json` writes management responses and events to stdout as one JSON object
  per line, e.g.
  `{"type":"response","requestId":1,"ok":true,"lines":["OK fw version=0.1.2"],"command":"@i?"}`.
  `@w=`/`@d=` commands are always reported as `<redacted>` in that field.
- `--quiet` suppresses progress messages (`linkr: …`); errors and
  `loopback PASS/FAIL` still print.
- `--help` and `--version` do not need bleak installed; it is imported only
  when the device is actually accessed.
- Keep the WiFi password out of argv: use `--wifi SSID --wifi-key-file PATH`,
  or `$LINKR_WIFI_PASSWORD`, or the interactive prompt on a terminal.
  `--wifi SSID,PASSWORD` still works but is visible in `ps`.
- `--uart` is validated locally (baud 300–3000000, data 5–8, parity n/o/e,
  stop 1/2, flow n/rtscts) and fails before anything is sent to the device.
- `--rename-ble` is validated locally too: 1–29 UTF-8 bytes, no control
  characters, and the two name flags cannot both be given.
- Exit codes: `0` ok, `1` error, `2` bad arguments, `3` device disconnected
  during the terminal session.

Configuration commands use Management Service v1 binary frames with an API
version, request ID, logical payload length, response ID, and confirmed
indication fragmentation. NUS is now raw UART only. See the
[Linkr integration API](LINKR_BLE_API.zh-CN.md) for the wire format,
asynchronous WiFi completion events, Device ID, and Reliable UART sequencing.

The uploader accepts anonymous HTTP endpoints only. It rejects Basic Auth
credentials because sending them over plain HTTP would expose them on the
network. Use this mode only on a trusted local network; authenticated or
internet-facing deployments require a future HTTPS build with a provisioned CA
trust anchor.

The Web Bluetooth terminal exposes structured SSID/password fields, a WiFi
scan list, device diagnostics, and the same WebDAV controls. The Python client
exposes the same Management v1 operations for automation.

## Test options

All test options default to off.

Run the repeatable local regression check with:

```sh
tools/verify.sh
```

It builds every supported firmware board, checks the Python and shell helpers,
and compiles the C reference terminal when `dbus-1` development files are
available. It does not run the web/mobile test suites or the native-project
asset builds: those are covered by CI (`.github/workflows/build.yml`).

Enable UART RX echo loopback:

```sh
west build -b esp32c3_devkitm linkr-bee -- \
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
west build -p always -b esp32c3_devkitm linkr-bee -- \
  -DEXTRA_CONF_FILE=test_loopback.conf
```

For a BLE NUS echo diagnostic using the same full firmware feature set (no
UART wiring required):

```sh
west build -p always -b esp32c3_supermini linkr-bee -- \
  -DEXTRA_CONF_FILE=test_ble_echo.conf
```

Both diagnostic modes use the dedicated `linkr-test-marker` flash partition;
they do not write the ESP32-C3 coredump sector.

## BLE Protocol

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Host (Python/Web/C)                       │
├─────────────────────────────────────────────────────────────┤
│  Management Service v1    │    Reliable UART Service v1     │
│  - API versioning         │    - Sequence numbers           │
│  - Device ID (read-only)  │    - Write acknowledgements     │
│  - Request/Response IDs   │    - Confirmed indications      │
│  - Async events           │    - Reconnect deduplication    │
├─────────────────────────────────────────────────────────────┤
│                    BLE GATT (ATT MTU 247)                    │
├─────────────────────────────────────────────────────────────┤
│            ESP32-C3/C5 Firmware (Zephyr v4.4.1)              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  BLE Stack  │  │  UART Bridge│  │  WiFi/WebSocket     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Service UUIDs

| Service | UUID | Description |
|---------|------|-------------|
| Management Service v1 | `4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001` | API versioning, Device ID, config commands |
| Management Protocol | `4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001` | Read protocol version and capabilities |
| Management Device ID | `4c4b0003-9a7e-4f4e-8b8a-3d6f12a0c001` | Read stable device identifier |
| Management Command | `4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001` | Write framed requests |
| Management Response | `4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001` | Indicate framed responses and events |
| Reliable UART Service v1 | `4c4b0010-9a7e-4f4e-8b8a-3d6f12a0c001` | Loss-detecting UART transport |
| Reliable UART RX | `4c4b0011-9a7e-4f4e-8b8a-3d6f12a0c001` | Host → Device framed writes |
| Reliable UART TX | `4c4b0012-9a7e-4f4e-8b8a-3d6f12a0c001` | Device → Host confirmed indications |
| Reliable UART State | `4c4b0013-9a7e-4f4e-8b8a-3d6f12a0c001` | Read sequence and payload limits |
| Legacy Nordic UART Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Compatibility UART service |
| Legacy Nordic UART RX | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Host → Device unframed writes |
| Legacy Nordic UART TX | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Device → Host notifications |

### Data Flow

```
┌──────────────┐     BLE Write      ┌──────────────┐     UART TX     ┌──────────────┐
│  BLE Central │ ──────────────────> │  ESP32-C3    │ ──────────────> │  SBC/Device  │
│  (Phone/PC)  │ <────────────────── │  Bridge      │ <────────────── │  (Console)   │
└──────────────┘   BLE Notify       └──────────────┘    UART RX      └──────────────┘
```

### MTU and Frame Format

- **ATT MTU**: 247 bytes (negotiated)
- **LE Data Length**: 251 bytes
- **Reliable UART Frame**: 12-byte header + up to 232 UART bytes
- **Fallback**: 20-byte chunks for smaller MTU negotiations

The host terminal prints the detected write chunk size when it connects.

## BLE terminal

`tools/linkr_ble_terminal.py` is the current host reference client. It connects
to a Linkr Bee, verifies Management API v1 and Device ID, uses Reliable UART for
terminal bytes, and keeps management responses separate. The advertised name is
display-only; the default is `Linkr Bee XXXX`, where `XXXX` is the last four hex
digits of the hardware MAC.

Install the host dependency if needed (`--help`/`--version` do not need it):

```sh
python3 -m pip install bleak
```

- `--scan` lists **all** nearby devices (unnamed ones show `(unknown)`) with
  their RSSI, and exits unless another action or an explicit `--address` was
  given. When it continues, that scan result is reused instead of rescanning.
- In terminal mode the CLI sends `stty rows/cols` to the target when it sees an
  **idle shell prompt** (same rule and same command string as
  `web/terminal_geometry.js`), and re-sends it after a window resize
  (SIGWINCH). It stays quiet while the prompt is busy so the line cannot be fed
  to a running command.
- A device that disappears mid-session exits with code `3`; leaving the
  terminal with the escape key (default `Ctrl-]`, and the hint follows
  `--escape`) exits with `0`.

### C terminal for Linux or Linkr Buildroot

A Linux-only reference implementation written in C is provided in
`tools/linkr_ble_terminal.c`. It talks to BlueZ over the system D-Bus using
`libdbus-1` directly, without GLib. This keeps the userspace dependency small,
but it still requires a working Linux BLE central stack underneath it.
The C program speaks legacy NUS for the terminal, and Management Service v1
for the advertised BLE name: `--query-ble-name`, `--rename-ble NAME`, and
`--reset-ble-name` read Protocol Info and the Device ID first, and are refused
on legacy NUS-only firmware. Use the Python or Web client for the remaining
Management v1 controls (WiFi, WebDAV, UART) and for Reliable UART.

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
./linkr_ble_terminal_c
```

Its command line now matches the Python client, so scripts can treat both alike:

- Exit codes `0` ok, `1` error, `2` bad arguments, `3` device disconnected
  mid-session. Argument errors used to exit `1`, indistinguishable from a
  device that would not connect.
- `--version`; `--quiet` suppresses progress only, errors always print.
- Long options also accept `--option=value`; a missing value reports
  `--opt requires a value` instead of the misleading `unknown option`.
- `--help` writes to stdout (errors and the usage hint go to stderr), and
  argument errors point at `--help`.
- An incomplete escape such as `--escape '^'` is rejected (it used to be
  accepted as the literal byte `^`), and the exit hint follows `--escape`
  instead of always claiming `Ctrl-]`.
- `--scan` lists **all** nearby devices (unnamed ones show `(unknown)`) and
  exits unless another action or an explicit `--address` was given.
- A `--log-file` that cannot be opened fails before any Bluetooth work
  (it used to warn and continue, silently losing the log).
- Device matching prefers an exact name over a prefix, and NUS-advertising
  devices over others within each kind.

The tests live in `tests/test_terminal_cli_c.py`: the pure helpers (argument
validation, name prefixing, escape naming, Enter translation) are compiled
straight out of the C source into a host harness with no Bluetooth or D-Bus,
and the argument surface is driven against a real binary built with `-Werror`.

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

The legacy C terminal supports raw NUS terminal and scan/loopback workflows,
and it reads and renames the advertised BLE name over Management Service v1.
Its other management flags are not compatible with API v1; use the Python client
for configuration and diagnostics:

```sh
./linkr_ble_terminal_c --loopback-test A --no-terminal
./linkr_ble_terminal_c --scan
./linkr_ble_terminal_c --query-ble-name --no-terminal
./linkr_ble_terminal_c --rename-ble 'Bench Bee' --no-terminal
python3 tools/linkr_ble_terminal.py --query-info --no-terminal
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
./dist/linkr-bee-terminal --uart 115200,8,n,1,n
```

Capture raw SBC console bytes while viewing them:

```sh
./dist/linkr-bee-terminal --uart 115200,8,n,1,n --log-file sbc-console.log
```

If the target does not echo typed characters, use line mode or local echo while
debugging input:

```sh
./dist/linkr-bee-terminal --uart 115200,8,n,1,n --line-mode --enter cr
./dist/linkr-bee-terminal --uart 115200,8,n,1,n --local-echo --debug-io
```

With GPIO21 shorted to GPIO20, run a BLE-to-UART-to-BLE loopback check:

```sh
./dist/linkr-bee-terminal --loopback-test A --no-terminal
```

Useful options:

- `Ctrl-]`: exit the terminal
- `--query-info --no-terminal`: read firmware and runtime diagnostics
- `--query-ble-name --no-terminal`: read the advertised BLE name
- `--rename-ble NAME --no-terminal`: set the advertised BLE name
- `--reset-ble-name --no-terminal`: restore the MAC-derived BLE name
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
- `--wifi SSID --wifi-key-file <path>`: connect without the password in argv
  (`$LINKR_WIFI_PASSWORD` and a prompt work too)
- `--json`: write management responses and events as JSON lines, for scripts
- `--quiet`: print errors and results only
- `--print-completion <shell>`: print a bash / fish / zsh completion script,
  see below

### Shell completion

Both clients generate bash, fish and zsh completions. The scripts are produced
from each client's own option definitions, so a new option cannot be missed:

```sh
# bash, current session only
source <(tools/linkr_ble_terminal.py --print-completion bash)

# bash, installed once (needs bash-completion)
tools/linkr_ble_terminal.py --print-completion bash > \
  ~/.local/share/bash-completion/completions/linkr_ble_terminal.py

# zsh: any directory in $fpath, and the file name must be _linkr_ble_terminal
tools/linkr_ble_terminal.py --print-completion zsh > "${fpath[1]}/_linkr_ble_terminal"

# fish: the file is named after the command
tools/linkr_ble_terminal.py --print-completion fish > \
  ~/.config/fish/completions/linkr_ble_terminal.py.fish

# the C client works the same way
source <(./linkr_ble_terminal_c --print-completion zsh)
```

They complete option names, the values of `--enter` and `--print-completion`,
and paths for `--log-file` and `--wifi-key-file`. `--print-completion` does not
load bleak and does not need a device.

**Completion only applies when the client is invoked under that name, so the
command has to be findable** (on `PATH`). Installing a completion script is not
installing a program: `python3 tools/linkr_ble_terminal.py <TAB>` completes
nothing, because that is `python3`'s to complete. Install the client as a
command instead -- the PyInstaller build `linkr-ble-terminal`, a wrapper, or the
script on `PATH`. fish is the strictest of the three: it does not read the
completion file at all while the command is missing from `PATH`.

## Web Bluetooth terminal

The browser terminal is an additional option, not a replacement for the Python
terminal. It uses Management Service v1 for controls and Reliable UART Service
v1 for terminal data; NUS remains available to separate legacy clients.

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

The firmware places the Management Service UUID in the primary advertising
packet and the advertised name in the scan response. The default name is
`Linkr Bee XXXX` on every board, where `XXXX` is the last four hex digits of the
hardware MAC; `@n` can replace it with a custom name. The page filters the
browser device chooser by the Management Service UUID, which is more reliable
than name-only filtering on macOS Chromium browsers.

Plain static hosting has no bundler, so the assistant is shipped prebuilt in
`web/vendor/agent/`. Rebuild it after changing the agent runtime or upgrading the
SDK:

```sh
tools/build_agent_bundle.sh
```

`mobile/test/agent_bundle.test.mjs` fails when the committed bundle no longer
matches `BUILD.json`, the bundled sources or the installed package versions. The
Vite (Capacitor) and ArkWeb builds alias `web/agent_runtime.js` to the source
runtime and ignore this bundle.

A browser calls the configured model endpoint directly, so the endpoint must
answer the page's origin. Verified with an `OPTIONS` preflight from
`http://127.0.0.1:8765` (2026-09): DeepSeek, OpenAI, Moonshot, Zhipu,
SiliconFlow, Gemini and OpenRouter all return `access-control-allow-origin`
(echoing the origin or `*`), so they work without a proxy. Anthropic answers the
preflight only when the request carries
`anthropic-dangerous-direct-browser-access: true`, which the extra-headers field
in the AI settings sends. Groq refused both the preflight and the request from a
browser origin; an endpoint like that needs a proxy. A refusal is reported to the
user as a browser-side failure instead of a silent error.

The page can:

- connect to devices advertising the Linkr Management Service UUID
- restore the last authorized Linkr device after a page refresh for quick
  reconnect, when the browser supports `navigator.bluetooth.getDevices()`
- read API version and stable Device ID, and subscribe to separate management
  indications and Reliable UART indications
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
- detect common Bash/BusyBox `$ ` and `# ` prompts and synchronize the remote
  serial TTY with `stty rows <rows> cols <cols>` after login; synchronization
  waits for an empty input line in the normal terminal buffer, including checks
  for pending input and command text to the right of the cursor. Incoming login
  prompts and Linux boot banners invalidate the size cache even if the accessory
  stays connected. Prompt detection is heuristic and supports common plain-text
  Linux consoles; custom prompts may not be recognized
- show optional local echo and debug I/O traces
- save received bytes as a log file

After connecting, the page focuses the terminal automatically. Click or tap the
terminal whenever it loses focus, then type directly in it; there is no separate
line-input box. BLE writes are serialized so fast typing and paste operations do
not start overlapping GATT writes. The on-screen `Ctrl-C` button remains
available for touch devices.

This is useful for quick access on a machine that already has Chrome. The fixed
xterm.js and addon-fit versions are bundled under `web/vendor`, so the terminal
also works on an offline provisioning network.

---

## Mobile apps

The same terminal UI, Management v1 implementation, and Reliable UART v1
implementation can also be packaged as phone apps. The browser remains an
independent option.

| Platform | Native integration | Current repository state |
| --- | --- | --- |
| Android | Capacitor and native BLE plugin | Project generated; web assets and plugin sync verified |
| iOS | Capacitor and CoreBluetooth plugin | Project generated; web assets and plugin sync verified |
| HarmonyOS NEXT | ArkWeb UI and ArkTS BLE host over `JavaScriptProxy` | API 26 Stage project implemented; ArkTS type check and unsigned HAP build verified, device validation pending |

Build the shared assets and synchronize the generated Android/iOS projects:

```sh
cd mobile
npm install
npm run build
npm run cap:sync
npm run build:harmony:hap
```

See [`mobile/README.md`](../mobile/README.md) for Android/iOS requirements and
[`harmonyos/README.md`](../harmonyos/README.md) plus
[`harmonyos/BRIDGE_PROTOCOL.md`](../harmonyos/BRIDGE_PROTOCOL.md) for the HarmonyOS
host contract, debug signing, and host-side tests. The first mobile release is
foreground-only. The firmware requires an encrypted, bonded BLE link. C3/C5 gate
new pairings on GPIO1; WROOM ships with the pairing check off, and uses GPIO4
only when `CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=y`. See
[pairing and recovery](BLE_PAIRING.md) for the authorization and recovery rules.

---

## Validation status

What each layer has actually been exercised against. A successful build, a host
test run, or a simulator launch is not end-to-end acceptance on the target
hardware.

| Layer | Verified in this repository | Still requires hardware |
| --- | --- | --- |
| Firmware builds | `esp32c3_supermini`, `esp32c3_devkitm`, `esp32c3_devkitc`, and `esp32c5_devkitc/esp32c5/hpcore` build in CI under Zephyr v4.4.1, with the per-generation controller security symbols asserted | — |
| Host protocol tests | `tests/` compiles and drives the production management, security, target-binding, WebDAV, and HCI-order code paths, including the C3/C5 build guards | Real SMP pairing, NVS persistence, radio behaviour |
| BLE terminal | Web, Python, and C clients, plus the browser regression suite for Reliable UART sequencing, reassembly, and session boundaries | Pairing, MTU negotiation, and reconnect behaviour per platform |
| WiFi, LAN bridge, WebDAV | Host tests and the browser suite; the WS token handshake is covered on both sides | Association, BLE/WiFi coexistence, upload against a real endpoint |
| Assistant (Agent mode) | Node and browser suites cover the execution policy, evidence handling, and task recovery | Command execution and profile recovery on a real target; details in [AGENT_VALIDATION.zh-CN.md](AGENT_VALIDATION.zh-CN.md) |
| Phone apps | Shared web assets build and type-check; Android/iOS/HarmonyOS projects are synchronized with the terminal UI | Android, iOS, and HarmonyOS Bluetooth LE on physical devices |

---

## Configuration Reference

### UART Configuration

| Config Option | Default | Description |
|---------------|---------|-------------|
| `CONFIG_LINKR_BLE_BRIDGE_UART_BAUD_RATE` | `115200` | UART baud rate |
| `CONFIG_LINKR_BLE_BRIDGE_UART_DATA_BITS_*` | `8` | Data bits (5/6/7/8) |
| `CONFIG_LINKR_BLE_BRIDGE_UART_PARITY_*` | `none` | Parity (none/odd/even) |
| `CONFIG_LINKR_BLE_BRIDGE_UART_STOP_BITS_*` | `1` | Stop bits (1/2) |
| `CONFIG_LINKR_BLE_BRIDGE_UART_FLOW_CONTROL_*` | `none` | Flow control (none/rtscts) |

### WiFi Configuration

| Config Option | Default | Description |
|---------------|---------|-------------|
| `CONFIG_WIFI_ESP32` | `y` | Enable ESP32 WiFi driver |
| `CONFIG_WIFI_USAGE_MODE_STA` | `y` | Station mode |
| `CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS` | `n` | Save WiFi PSK to flash (requires secure boot + flash encryption) |

### WebSocket Bridge Configuration

| Config Option | Default | Description |
|---------------|---------|-------------|
| `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE` | `y` | Enable WebSocket bridge |
| `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_PORT` | `80` | WebSocket server port |
| `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_MAX_CLIENTS` | `2` | Max concurrent clients |
| `CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN` | *(empty)* | Optional auth token (first text frame) |

### BLE Configuration

| Config Option | Default | Description |
|---------------|---------|-------------|
| `CONFIG_LINKR_BLE_BRIDGE_CONTROL_COMMANDS` | `y` | Enable management commands (`@u`, `@w`, `@d`, etc.) |
| `CONFIG_LINKR_BLE_BRIDGE_FIRMWARE_VERSION` | `0.1.2` | Reported firmware version |

### Test Configuration

| Config Option | Default | Description |
|---------------|---------|-------------|
| `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_ECHO` | `n` | Enable UART RX echo loopback |
| `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX` | `n` | Enable periodic UART TX frames |
| `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_INTERVAL_MS` | `1000` | TX frame interval (ms) |
| `CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_PAYLOAD` | `linkr-ble-uart-test\r\n` | TX frame payload |

### Board Pinout (ESP32-C3 Super Mini)

| Function | GPIO | Description |
|----------|------|-------------|
| UART RX | GPIO20 | Receive data |
| UART TX | GPIO21 | Transmit data |
| Activity LED | GPIO8 | Blue LED, flashes on UART activity |
| Factory Reset | GPIO0 | Short to GND during boot to reset |
