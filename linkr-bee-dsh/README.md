# dsh-linkr-bee

A [Linkr Bee](https://github.com/radxa/linkr-bee) wireless serial bridge as a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: a live
serial console in the Web UI's right column, plus agent tools that run commands
on the target board — the person and the agent share one board and one link.

## What you get

| Part | What it does |
| --- | --- |
| **Serial console panel** | A real terminal (xterm.js) in the right column: click it and type, exactly like a local terminal. ANSI colour, cursor movement, `\r` progress and bracketed paste all work; dragging selects text and ⌘C/Ctrl+C copies it. It appears as a card next to *Workspace files* / *New terminal* on the start page, and as a tab in the right column. The agent can open, focus and clear it (`POST /linkr-bee/panel`), and the tab puts its last screen back after a remount or a page reload. |
| **Live link** | While the panel is open, one resident `bee-cli --serve` session holds the bridge and streams the target's own bytes (`watch`) — a boot log, a prompt, a service printing on its own — with no polling. The panel's size is sent with `resize`, so full-screen programs get the right tty. |
| **Agent tools** | `linkr_bee_console` (drive this console: `open`, `focus`, `clear`, `type` text, press a named `key`, `read` what the board said, `state`, `resize` — the same pane the person is looking at), `linkr_bee_exec` (run a shell command on the target console and return its output and exit code), `linkr_bee_query` (bridge diagnostics, UART/WiFi/WebDAV/BLE-name/LAN settings, link state, doctor, scans), `linkr_bee_send` (deliver input and capture the reply window), `linkr_bee_set` (change bridge settings over the BLE management channel). |
| **Connection settings** | The panel's ⚙: transport (BLE / LAN / loopback), scan for a nearby board, LAN host and token, per-call timeout. Saving writes the plugin's row in the active profile's `cordis.patch.yml` through the Harness config editor, so it survives restarts. |

## Requirements

- DeepSeek Harness `>=0.2.0-rc.1 <0.3.0` (`engines.dsh`).
- **`bee-cli`**, the Linkr Bee command-line client, version **0.1.2 or newer with
  the `watch` and `resize` operations** (this plugin's streaming depends on
  them; a build without them falls back to one dial per command and shows no
  unsolicited output). Install it from npm — the package fetches, verifies and
  caches the prebuilt binary for your platform:

  ```sh
  npm install -g linkr-bee-cli     # puts `bee-cli` on PATH
  npx linkr-bee-cli --scan         # or run it without installing
  ```

  Or build it from source:

  ```sh
  git clone https://github.com/radxa/linkr-bee
  cd linkr-bee/cliproxy-import/tools/linkr-tui
  cargo build --release --no-default-features --features cli
  # install it under the name the plugin looks for
  rm -f target/release/bee-cli && cp target/release/bee target/release/bee-cli
  ```

  The plugin resolves it as: `cliPath` (below) → `$LINKR_BEE_CLI` → `bee-cli` on
  `PATH` (which the global npm install provides). Keep the *same path* across
  restarts; replace the file with `rm`/`cp` rather than overwriting it in place
  (macOS may refuse to run a binary that was rewritten under the same inode).

## Install

From the Harness UI: **Plugins → install**, with the spec `dsh-linkr-bee`.
From a terminal:

```sh
dsh plugin --profile <profile> add dsh-linkr-bee
```

Then restart the app (or reload the page) so the new bundle layer loads.

## Use

1. Open the right column (**Open right sidebar**) and pick **Serial monitor**
   (or click its card on the start page).
2. Type. The panel sends every keystroke to the console as it is typed; the
   target's echo and output come back through the same link.
3. The header shows what the console is attached to (`ble · Linkr Bee 36E8`,
   `lan`, or `offline`), the live tty size (`86×45`), `Clear` and the ⚙
   connection settings. When the link drops, one compact banner says so and
   carries a **Reconnect** button that re-arms the session — and reports why if
   it cannot.

The console is raw: the board's own shell handles `Enter`, `Ctrl-C`, `Tab`, job
control and colour. If the board is sitting at a login prompt, log in by typing
in the panel.

## Configuration

The panel's ⚙ writes these fields; they can also be set by hand in the profile's
`cordis.patch.yml` under the `linkr-bee` row:

| Field | Meaning |
| --- | --- |
| `transport` | `ble` (a nearby board over Bluetooth), `lan` (the bridge's WebSocket), or `loopback` (offline simulator, no hardware) |
| `bleName` | name fragment to dial; empty = the plugin scans once, then dials the one board it finds **by name** (macOS hides real MACs, so address redials do not connect) |
| `bleAddress` | board MAC, e.g. `EE:C7:42:34:48:CF`; empty = discover by name |
| `lanHost` / `lanToken` | bridge WebSocket address (`host`, `host:port` or `ws://…`) and its 32-hex token, sent through `LINKR_LAN_TOKEN` |
| `cliPath` | `bee-cli` binary; empty = auto-detect as described above |
| `timeoutMs` | per-call budget for one `bee-cli` request (default 30000) |
| `sendCaptureMs` | how long `linkr_bee_send` keeps the link open to capture the reply (default 1500) |

Bridge notes from the firmware: management queries and settings are
Bluetooth-only; a LAN link carries serial bytes only; a board accepts two
concurrent WebSocket clients and one Bluetooth connection.

## Behaviour worth knowing

- **The panel holds the Bluetooth link while it is open.** Close the panel (or
  switch the tab away) to release it for your phone app or another tool.
- **The agent shares the console you are typing in.** A tool call injects its
  command into the same shell; a half-typed line can be disturbed. That is the
  cost of one board and one link. An agent can also open the pane itself
  (`linkr_bee_console {action:"open"}`), so a task that needs the console shows
  it instead of describing it.
- **The header tells you where the link stands.** `● ble · Linkr Bee 36E8` or
  `lan` / `loopback` / `offline`, the live tty size (`86×45`, the same number the
  target runs with), `Clear`, and ⚙. When the session drops the header turns
  amber and a one-line banner offers *Reconnect*; the reason is shown inline if
  reconnecting fails (a wrong `bee-cli` path, a board out of range).
- **The pane keeps its screen.** Switching tabs or reloading the page replays
  what the board said (`GET /linkr-bee/console/read`); a *Clear* — yours or an
  agent's — moves the cutoff so cleared output does not come back.
- **Console output is untrusted device data.** The tools say so explicitly: exit
  code 0 means the command completed, not that the target's state was verified,
  and a delivered command is not a completed one.
- **Local surface only.** The plugin serves `/linkr-bee/*` on the Harness web
  server (loopback) and refuses requests whose `Origin` is not the page's own
  host. The LAN token is never echoed back to the page — it is masked.
- If the terminal cannot start, the panel says so and falls back to a plain text
  renderer; the Host also records browser-side diagnostics in
  `$DSH_HOME/logs/linkr-bee-diag.jsonl`.

## Development

The plugin is two plain files: `index.js` (Host: tools, routes, the resident
session) and `client.js` (Web UI: xterm panel, generated as a CJS factory for the
Harness module loader). There is no build step. xterm.js and its fit addon are
inlined in `client.js` because the shell's shared module table exposes no
terminal library; both are MIT-licensed (see `THIRD_PARTY_NOTICES.md`).

## License

Apache-2.0. `client.js` embeds xterm.js 6.0.0 and `@xterm/addon-fit` 0.11.0
(MIT); their notices are in `THIRD_PARTY_NOTICES.md`.
