# bee-cli — the Linkr Bee command-line client

This archive is the **CLI-only** build of Linkr Bee. The executable is
`bee-cli`: the same protocol and command-line implementation as the interface
build, compiled without the terminal interface. It is meant for scripts and
agent harnesses that want one request, one answer and an exit code.

The GUI build is shipped separately as `bee`. Both builds speak the same
management protocol over Bluetooth LE or the LAN WebSocket bridge. There is no
interactive terminal in this archive, so `bee-cli` with no action reports that
this build has no interface and exits with status 2.

## Check the build

```sh
./bee-cli --version          # bee-cli 0.1.2
./bee-cli --capabilities     # operations, defaults and exit codes
./bee-cli --licenses         # third-party notice (also in THIRD_PARTY_LICENSES.md)
```

## Connect

| Transport | Flag |
|---|---|
| Bluetooth address | `--ble-address EE:C7:42:34:48:CF` (the board's identity) |
| Bluetooth name fragment | `--ble-name "Linkr Bee"` or any custom label (a display name the owner can change; use `--ble-address` when several boards are nearby) |
| LAN WebSocket | `--lan-host 192.168.0.102` |
| LAN token | `--lan-token <TOKEN>`, `--lan-token-file <FILE>` or `$LINKR_LAN_TOKEN` |
| Offline loopback | `--bridge -` |

Management commands (`@i?`, `@u?`, `@w?`, `@d?`, `@s?`) are available only over
BLE. On a LAN or stdio link they report that the management channel is absent
and exit with status 1.

## Common requests

```sh
bee-cli --scan                         # list nearby Linkr Bee boards
bee-cli --query-info                   # @i?
bee-cli --query-uart                   # @u?
bee-cli --query-wifi                   # @w?
bee-cli --query-webdav                 # @d?
bee-cli --query-ble-name               # @n?
bee-cli --query-lan                    # @s?
bee-cli --wifi "MySSID,MyPassword"     # join a network
bee-cli --wifi "MySSID" --wifi-key-file pw.txt
bee-cli --wifi-scan
bee-cli --wifi-off
bee-cli --webdav http://dav.example/logs/
bee-cli --webdav-off
bee-cli --uart 115200,8,n,1,none
bee-cli --rename-ble "测试😀"          # @n=测试😀
bee-cli --reset-ble-name               # @n default
bee-cli --loopback-test 414243
bee-cli --exec "uname -a"
```

The advertised BLE name is read and changed with the same three flags the
interactive terminal uses:

```sh
bee-cli query ble-name                 # --query-ble-name
bee-cli set ble-name "Bench Bee"       # --rename-ble
bee-cli set ble-name default           # --reset-ble-name
```

The name is 1–29 UTF-8 bytes and is checked on the host before anything is
sent, so Chinese and emoji are accepted and a name the firmware would refuse
fails without a round trip. A write is confirmed by the board and read back.
For a rename or reset the C reference client prints only the board's `@n?`
readback, not the write reply; a rename exits non-zero when the board reports
a different name.

A command line may contain several requests; they are sent one at a time
because the bridge answers one management question at a time. Add `--json` for
JSON Lines suitable for a program, and `--quiet` to suppress progress on stderr.
`--no-terminal` is accepted for compatibility; this build has no interface to
open.

WebDAV currently accepts only anonymous `http://host[:port]/path/` endpoints;
HTTPS, credentials, queries and fragments are unsupported. Empty URLs are
rejected; use `--webdav-off` explicitly to disable upload.

WebDAV upload is part of the protocol, but a particular firmware build may
leave it out (the ESP32-WROOM build disables it for DRAM). In that case the
board's own error is reported; the host does not hide the request.

`--exec` runs the command in a child POSIX `sh` and uses `printf` to emit a
unique completion marker for each attempt. Only a complete marker line for
that attempt confirms the exit status. Changes to the child shell's working
directory or variables do not persist in the serial console's parent shell.
With `--idle`, output is returned without a verified exit status.

## Keep a session open

`--serve` dials once and answers JSON requests from standard input until the
input ends or a request says `quit`:

```sh
bee-cli --ble-name "Linkr Bee" --serve
{"event":"ready","program":"bee-cli","version":"0.1.2","link":"ble:name:Linkr Bee","ops":[…]}
{"id":1,"op":"state"}
{"event":"begin","id":1,"op":"state"}
{"event":"result","what":"state","live":false,…}
{"event":"end","id":1,"code":0}
{"id":2,"op":"exec","cmd":"uname -a"}
{"event":"begin","id":2,"op":"exec"}
…
{"event":"end","id":2,"code":0}
{"id":3,"op":"quit"}
{"event":"end","id":3,"code":0}
```

The `ops` list in the ready event reports what the current transport can serve.
The same operations are available as flags; `--capabilities` lists the full set
for this build. Request fields are documented by the `capabilities` output and
the project repository.

## Exit codes

| Code | Meaning |
|---|---|
| 0–125 | With a single `--exec`, the target command's own status |
| 1 | The request ran but failed (timeout, refusal, missing management channel, or any failed request in a mixed batch) |
| 2 | Usage error: unknown or missing arguments, or a conflicting command line |
| 255 | The link could not be opened or was lost |

A mixed batch reports failure as 1; the target command's own status remains in
its `result` event.
