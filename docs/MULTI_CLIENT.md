# Multi-Client Serial Sessions

[中文](MULTI_CLIENT.zh-CN.md) | [Development](DEVELOPMENT.md)

## Scope

The firmware defaults to two simultaneous BLE connections. All authenticated
clients receive the same UART output; exactly one session may submit UART
input or change accessory settings. BLE and authenticated LAN clients share
the same ownership arbiter. These are not independent shells or user accounts.
Only pair trusted devices: a read-only observer still sees the shared console.

Linkr firmware integration and trusted Linkr identity provisioning are deferred.
`linkr_reserved=0` explicitly reports that no Linkr-only slot is enforced yet.
Both BLE slots are usable by existing clients during this phase. Do not identify
a future privileged Linkr client by its advertising name or a caller-supplied
role string; reservation must eventually use an authorized bonded identity.

## Client Behavior

The shared Web/mobile terminal reads capability bit 7 (`MULTI_SESSION`). On new
firmware it queries ownership and claims control if idle. Other sessions remain
read-only for automatic work, but their terminal stays typable: the first
keystroke asks for an **idle hand-over** and becomes input when the current owner
has been quiet for `CONFIG_LINKR_BLE_BRIDGE_SESSION_IDLE_MS` (default 3 s). The
**Take control** button is the preemptive path and wins immediately, even while
the other session is typing. The controller can Release without disconnecting;
the next user input may take the released console. Status is refreshed every two
seconds. The same frontend is used by the HarmonyOS shell.

Only the controller sends terminal replies, AI commands, shortcuts and remote
terminal-size changes. A human keystroke is the exception: it may trigger the
idle hand-over described above. Observers can resize their local view without
sending `stty`. Losing control invalidates pending client writes.

Legacy clients that do not negotiate ownership can claim an idle console with
their first UART write or modifying management command; an owner that has been
quiet for the idle window is also taken over. They cannot write while another
session is actively writing. The Rust CLI/TUI negotiates ownership on both
bearers: it asks `@c?` over Bluetooth and reads the LAN bridge's announcement,
shows the same badge, claims a free console, and asks for an idle hand-over on
the first keystroke. A CLI without the feature benefits from the same idle rule.

## Management Protocol

Management v1 framing and request IDs are unchanged. Capability bit 7 indicates
the following commands are supported; check it before using them on old firmware.

| Command | Meaning |
| --- | --- |
| `@c?` | Read this session's ID, owner and capacity |
| `@c claim` | Take control immediately, preempting an active owner |
| `@c claim idle` | Take control only when the owner has been quiet for the idle window |
| `@c release` | Release control, controller only |
| `@c yield 2` | Transfer control to live session 2, controller only |
| `@c ai on <epoch>` / `@c ai off <epoch>` | Notify AI takeover/end, current controller only; does not claim control |

The long forms are `@linkr control?` and `@linkr control <action>`.

```text
OK control self=2 owner=1 mode=readonly epoch=3 peers=2 ble_max=2 linkr_reserved=0 agent_led=1
```

`mode` is `control`, `readonly` or `available`. IDs are assigned for each live
connection, not persistent host identities. `peers` includes BLE and LAN
sessions; `ble_max` is the separate BLE capacity. `epoch` changes whenever
ownership changes. Errors include `control=busy` (idle claim while the owner is
still typing), `not_owner`, `bad_peer`, `bad_action`, `disconnected` and
`readonly`. The idle window is the Kconfig option
`LINKR_BLE_BRIDGE_SESSION_IDLE_MS` (default 3000). Owner activity is refreshed by
every accepted UART write and management mutation; already queued bytes are
protected by the epoch either way.

LAN authentication is unchanged. New firmware sends an ownership status as a
text frame after successful authentication. Only after this feature announcement
may clients send text frames `@control ?`, `@control claim`, `@control release`
or `@control yield 2`. UART bytes use binary frames. Text frames are reserved for
control; fragmented or oversized control frames are rejected, never forwarded
to the SBC. Do not probe old LAN firmware with these text commands.

`agent_led=1` advertises AI status notifications. Send them only after this
field is advertised, with the current `epoch`; stale generations return
`stale_epoch`, and non-controllers receive `not_owner`. The shared
Web/mobile/HarmonyOS assistant and resident tasks send `ai on` on start,
renew every two seconds, and send `ai off` on completion or Stop. Heartbeats
do not refresh the console's ownership idle timer. Release, handover and
disconnect clear the indication immediately; a missing heartbeat expires after
15 seconds. An ordinary `claim` does not mean AI takeover. LAN uses equivalent
`@control ai on <epoch>` / `@control ai off <epoch>` text frames. Nothing is
persisted to NVS.

## Delivery Boundaries

Each BLE peer has independent receive reassembly, sequence numbers, subscription
selection, management indications, bounded UART output queues and a sender.
Explicit CCC writes select NUS/Reliable for that peer; restored bonded CCC state
does not override a later explicit choice. Disconnecting one peer does not
purge another peer's requests or output. A full output queue does **not**
disconnect the slow peer: the bridge drops that chunk for that peer, counts the
lost bytes (`linkr_ble_peer_dropped()`) and keeps the link, because dropping the
connection would turn a burst of shell output into a dead terminal. The loss is
logged at most once a second; the UART ring on the target side loses data the
same way.

UART input packets and queued mutating management commands carry an ownership
generation. Release, handover and disconnect invalidate old queued work. A
packet already committed to the single hardware transmitter cannot be recalled:
it finishes before the next packet. Already accepted asynchronous operations
may also finish. Handover does not inject Ctrl-C or clear the SBC's current
command line; the new controller is sharing that same serial session.

## Builds and Validation

Default builds select two BLE connections. `multi3.conf` is an experimental
three-connection profile with smaller per-peer output queues:

```sh
west build -d build-three -b esp32c3_supermini . -- -DEXTRA_CONF_FILE=multi3.conf
```

This profile is build-checked on C3 only. Full-featured C5 and WROOM builds
remain at two BLE clients because of tight internal SRAM; do not apply the
three-client profile to them without further memory work and validation.

The host arbiter harness (including preemptive `claim`, idle `claim idle` and
the seamless write hand-over) passes, and C3, C5 and `linkr_bee_x1_0` builds
succeed with the 3000 ms default. The X1.0 image used for this change was built
with the pinned `linkr_multipeer_zephyr` workspace because the default workspace's
simple-boot loader already contains the upstream digest change the shim guards.

Passing a build or host test is not hardware acceptance. Before shipping, test
two actual hosts, optional third-host admission, different MTUs/transports,
bonded reconnects, controller release/handover, slow peers, long UART bursts,
GPIO pairing authorization and simultaneous WiFi activity. Check stack watermarks,
runtime heap, queue losses and watchdog resets on each board. A three-client
profile must not be presented as stable solely because it links.
