# opencode-linkr-bee

A [Linkr Bee](https://github.com/radxa/linkr-bee) wireless serial bridge as an
[OpenCode](https://opencode.ai) 2.x plugin: five agent tools and a shared live
serial-console panel for the TUI and the OpenCode desktop app, plus a
standalone local browser page, driven through
[`bee-cli`](https://github.com/radxa/linkr-bee/tree/main/tools/linkr-tui).
The agent and every panel see the same bytes, one resident link and one console.

The plugin only opens the board when a tool, a console panel or the browser page
asks for it. Load it in a project with
no board and no `bee-cli` installed: OpenCode starts normally, and each tool
reports what is missing when the agent calls it.

## What you get

| Tool | What it does |
| --- | --- |
| `linkr_bee_exec` | Run a shell command on the target board's UART console and return its output and exit status. Supports `idleSec` (finish after output has been quiet), `retry`, a per-call `timeoutMs`, and `dryRun` (print the exact bytes that would be sent; needs no board). Exit code 0 means the target command completed, not that the target state was verified. |
| `linkr_bee_query` | Read bridge and link state: `info`, `uart`, `wifi`, `webdav`, `ble-name`, `lan`, `state`, `doctor`, `scan` (nearby boards, no dial), `wifi-scan`. Management reads need the Bluetooth LE transport and answer with a clear error on a LAN or loopback link. |
| `linkr_bee_send` | Deliver text or raw bytes to the UART console without waiting for a command to finish, then capture the console output that arrives during the capture window. `line` (default) frames a newline, `raw` sends the bytes exactly as given. Delivery is not completion. |
| `linkr_bee_console` | Drive the shared console: `open`/`focus` (ask the UI panel to show itself), `clear`, `type` text, press a named `key`, `read` the console, `state` (link/session/geometry), `resize`. The same console a panel displays; typing is delivery, not completion. |
| `linkr_bee_set` | Change a bridge setting and read it back: `uart` (`115200,8,n,1,none`), `wifi`, `wifi-off`, `webdav`, `webdav-off`, `rename-ble` (1-29 UTF-8 bytes), `reset-ble-name`. These change the bridge, not the target board; WiFi credentials travel only over the Bluetooth LE management channel. |

| Part | What it does |
| --- | --- |
| **Shared console** | One resident `bee-cli --serve` session holds the board. Its `watch` stream feeds a 64 KiB raw ring and a *reading* view that hides the agent's probe/setup echoes and turns `LINKR_RC_*` completion markers into one `[Agent] exit=N` line. The agent tools borrow the same link for one-shot commands, so a panel and a tool never fight for the board. |
| **TUI panel** (`./tui`) | A live terminal inside OpenCode: type into the board, ANSI colour and cursor movement, resize, clear, reconnect. It speaks the console RPC below; OpenCode ships it as the plugin's TUI part. |
| **Desktop panel** (`./gui-experimental`) | The same console as a panel in OpenCode desktop app windows (the browser web UI served by `opencode serve` does not load GUI plugin parts). Same RPC, same ring, same session. |
| **Browser console page** (`webUrl`) | A plugin-served standalone page for any local browser: `http://127.0.0.1:<port>/?t=<token>`, printed by `state.webUrl` / the `webUrl` RPC. Same ring, same session; loopback-only and token-gated. See below. |
| **Console RPC** (`./rpc`) | Typed contract (`linkr_bee.console`) between the server part and the UI parts, usable by other plugins too: `state`, `read`, `write`, `key`, `resize`, `clear`, `reconnect`, with `output`/`state`/`request` events. |

Captured console/target output is untrusted device data. The tool descriptions
say so, and the plugin never treats device output as instructions.

## Requirements

- **OpenCode >= 2.2.0** (verified with **2.2.7**; the API package is pinned at `@opencode/plugin` 2.2.7).
  The package declares `engines.opencode`; OpenCode enforces that range when it
  installs a package plugin (`Plugin requires opencode <range> but running <version>`).
- **Node.js >= 22** for running the tests and the development tooling; the
  plugin itself runs inside OpenCode's runtime.
- **`bee-cli`**, the Linkr Bee command-line client, version **1.2.0 or newer**.
  The one-shot tools need only `--exec`/`--send`/query flags; the live console
  panels also need the `watch` (or `monitor`) and `resize` operations, and say
  so when the CLI is too old.

  ```sh
  npm install -g linkr-bee-cli     # fetches, verifies and caches the binary
  npx linkr-bee-cli --scan         # or run it without installing
  ```

  Or build it from source:

  ```sh
  git clone https://github.com/radxa/linkr-bee
  cd linkr-bee/tools/linkr-tui
  cargo build --release --no-default-features --features cli
  rm -f target/release/bee-cli && cp target/release/bee target/release/bee-cli
  ```

### How the plugin finds `bee-cli`

Same order as the DSH plugin, first win:

1. `cliPath` in the plugin options;
2. `$LINKR_BEE_CLI`;
3. the `linkr-bee-cli` npm launcher this package depends on (it fetches and
   checks the release binary);
4. `tools/linkr-tui/target/release/bee-cli` in the Linkr Bee source checkout
   this package is linked from;
5. `bee-cli` on `PATH`.

On Windows, point `cliPath` at a real `.exe`: Node cannot spawn the npm `.cmd`
shim directly, and the plugin refuses it with a message that says so.

## Install

OpenCode 2.x installs package plugins into the **global** configuration:

```sh
opencode plugin add opencode-linkr-bee          # latest
opencode plugin add opencode-linkr-bee@1.2.0    # pin a version
opencode plugin list                            # show installed plugins
opencode plugin update opencode-linkr-bee
opencode plugin remove opencode-linkr-bee
```

Then restart OpenCode (or reload the plugin entry). Verify with
`opencode plugin list`; on a running server,
`curl -u opencode:<password> http://127.0.0.1:<port>/api/plugin` lists
`{"id": "opencode-linkr-bee", "state": {"status": "active"}}`.

Or configure it by hand in any applicable `opencode.json(c)` — the project
root, `.opencode/opencode.json(c)`, or `~/.config/opencode/opencode.json(c)`.
The v2 key is **`plugins`** and an options-carrying entry is an **object**:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-linkr-bee",
    "opencode-linkr-bee@1.2.0",
    { "package": "opencode-linkr-bee", "options": { "transport": "ble" } }
  ]
}
```

The v2 configuration key is **`plugins`**. OpenCode 2.x still reads the older
v1 `plugin` **array** and folds it into `plugins`, so an existing entry keeps
working; the v1 tuple form (`["pkg", {...}]`) is not a v2 options carrier,
though — move such an entry under `plugins` and pass its options through the
object form above.

### Local development

A configured local path must point at a **directory** with a `package.json`
(a path to a single file is skipped). Relative paths resolve from the config
file that contains them; `file://` URLs and absolute paths work too:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/linkr-bee/linkr-bee-opencode",
      "options": { "transport": "ble", "timeoutMs": 30000 }
    }
  ]
}
```

OpenCode loads `.ts`/`.js` files and immediate package directories from
`.opencode/plugins/` automatically, but a directory discovered that way gets no
options (`ctx.options` is `{}`), so use a `plugins` entry when you need to pass
settings.

The published package depends on `@opencode/plugin`, so an npm install brings
the API package with it. For a bare checkout without `node_modules`, run
`npm install` in `linkr-bee-opencode/` first; a local plugin loaded from
`.opencode/plugins/` is resolved by OpenCode itself.

## Configuration

Options are read from the `plugins` entry's `options` object (`ctx.options` in
the plugin setup), then from the environment, then the defaults. Every setting
has an environment fallback, so a shell that already exports `LINKR_*` needs no
`opencode.json` change. Options are read once when the plugin loads; change the
config or environment and reload/restart OpenCode.

| Option | Env fallback | Default | Meaning |
| --- | --- | --- | --- |
| `cliPath` | `LINKR_BEE_CLI` | `''` | `bee-cli` executable; empty = auto-detect (see above) |
| `transport` | `LINKR_BEE_TRANSPORT` | `ble` | `ble` (nearby board), `lan` (the bridge's WebSocket), `loopback` (offline simulator, no hardware) |
| `bleName` | `LINKR_BLE_NAME` | `''` | Name fragment to dial; empty = scan, then dial the board found **by name** (macOS hides MACs, so address redials do not connect). The name is remembered for five minutes and forgotten after a failed dial |
| `bleAddress` | `LINKR_BLE_ADDRESS` | `''` | Board MAC, e.g. `EE:C7:42:34:48:CF`; empty = discover by name |
| `lanHost` | `LINKR_LAN_HOST` | `''` | Bridge address (`host`, `host:port` or `ws://…`). Required when `transport` is `lan`: without it the call is refused instead of silently falling back to BLE |
| `lanToken` | `LINKR_LAN_TOKEN` | `''` | 32-hex LAN token; sent to `bee-cli` through `LINKR_LAN_TOKEN`, never in argv or tool output |
| `timeoutMs` | `LINKR_BEE_TIMEOUT_MS` | `30000` | Per-call budget for one `bee-cli` request |
| `sendCaptureMs` | `LINKR_BEE_SEND_CAPTURE_MS` | `1500` | How long `linkr_bee_send` keeps the link open after delivery to capture the reply |
| `webConsole` | `LINKR_BEE_WEB_CONSOLE` | `true` | Serve the standalone local browser console page (loopback-only, token-gated). `false`/`0`/`off` disables it; `webUrl` then reports `{url:"", enabled:false}` |

Bridge notes from the firmware: management queries and settings are
Bluetooth-only; a LAN link carries serial bytes only; a board accepts one
Bluetooth connection at a time.

## Behaviour worth knowing

- **Tools are directly visible to the model.** Every tool is registered with
  `options: { codemode: false }`; without that, OpenCode files plugin tools under
  Code Mode and the model cannot call them directly.
- **Five tools, one console.** The four one-shot tools take a link lease: they
  retire the panel's resident session, run their `bee-cli` command, and resume
  the panel stream afterwards, so a command and the terminal never fight for
  the single BLE link. Their captured output is published into the same ring a
  panel reads.
- **The console session is resident.** A panel starts it with its first
  `state`/`read` call: one `bee-cli --serve` holds the board and pushes the
  target's bytes through `watch` (a `monitor` poll fallback covers older CLIs).
  It is released when the plugin unloads or a one-shot tool takes the link.
- **Reading vs raw.** The reading view hides the agent's dispatch wrapper and
  turns `LINKR_RC_*` completion markers into `[Agent] exit=N`; the raw view is
  every byte in order. Both are 64 KiB rings with monotonic byte counters, so a
  panel can reconnect and replay from its cursor without seeing bytes twice.
- **The host validates tool input, and the plugin validates it again.**
  OpenCode 2.2.7 checks the model's arguments against the advertised JSON
  Schema and rejects a bad enum or missing required field before the plugin
  runs; each `execute()` also coerces/clamps its own input so the unit tests and
  any future host change behave the same way.
- **One board, one link.** Tool calls are serialized inside the plugin, so two
  tools called at once do not race each other for the radio. A queued or running
  call can be cancelled; a command that may already have been delivered is
  reported as "delivery unknown", never replayed.
- **Captured answers have limits.** JSON event capture keeps at most 1 MiB and
  4096 frames per run, and truncation is labelled. Final result/error frames
  take precedence over older output; stdout/stderr tails are bounded separately.
- **BLE discovery is by name.** On macOS scans report a placeholder address, so
  the plugin scans first and dials the discovered name; the discovery result is
  cached for five minutes and forgotten after a failed dial or a settings
  change. `bleAddress` skips discovery when the address is stable.
- **A run that produced events is an answer.** Result frames keep their JSON
  Lines; the target's own bytes go under `--- target output ---`; diagnostics
  under `--- stderr ---`. Only an invocation that failed without any event
  throws, and a thrown error is reported to the model as a tool error.
- **Exit codes are the target's.** `bee-cli` maps a single `--exec` to the
  target command's own status; `255` means the link could not be opened. The
  plugin reports the status it observed rather than guessing.
- **`dryRun` is offline.** It asks `bee-cli` what it would send and dials
  nothing, so it also works with no board in range.
- **`send` is delivery, not completion.** A delivered line can print nothing.
  The plugin then returns `(delivered; no reply in the capture window)` rather
  than pretending the target answered.
- **No automatic resend.** A failed `send` says the input was not confirmed
  delivered; a cancelled or timed-out command says its outcome is unknown. Check
  the output (or the board) before retrying, or you may run the command twice.
- **No settings UI.** The TUI and desktop panels are read-only consoles; neither
  writes configuration. Use the `plugins` entry or the environment. UART
  settings go through `linkr_bee_set {target:"uart"}` /
  `linkr_bee_query {target:"uart"}`.

## Console RPC

The server part exposes the shared console as a typed RPC, id
**`linkr_bee.console`** (package export `./rpc`). Both UI parts use it, and
another plugin can too:

| Method | Input | Output |
| --- | --- | --- |
| `state` | `{}` | `{ connected, transport, target, cols, rows, bytes, epoch, readingBytes }` — starts the session lazily; `connected:false` + the last error instead of throwing when there is no board or `bee-cli` |
| `read` | `{ view?, since? }` | `{ view, text, bytes, epoch, truncated? }` — `bytes` is the cursor for the chosen view (`state.bytes` raw, `state.readingBytes` reading) |
| `write` | `{ data }` | `{ ok }` — raw keystrokes to the target |
| `key` | `{ key }` | `{ ok }` — enter/tab/esc/space/backspace/up/down/right/left/home/end/ctrl-c/ctrl-d/ctrl-z/ctrl-l |
| `resize` | `{ cols, rows }` | `{ applied, cols, rows, reason? }` |
| `clear` | `{}` | `{ ok }` — empties both rings, starts a new epoch, keeps the byte counters |
| `reconnect` | `{}` | `{ ok }` — redial after a drop |

Events: `output` `{ seq, epoch, kind: "data"|"meta"|"user", text, bytes, reading?, readingBytes? }`,
`state` `{ connected, transport, target, cols, rows }`, and `request`
`{ action: "open"|"focus"|"clear" }` (the agent's `linkr_bee_console` asks the
panels to act).

```ts
import LinkrBeeConsole from 'opencode-linkr-bee/rpc';

const serial = ctx.client.rpc(LinkrBeeConsole);
const state = await serial.state({});                 // start/ensure the session
const first = await serial.read({ view: 'reading' }); // current ring + cursor
const offOutput = serial.events.on('output', (event) => {
  // reading view: event.data.reading ?? event.data.text, cursor readingBytes ?? bytes
});
const offState = serial.events.on('state', (event) => { /* header */ });
const offRequest = serial.events.on('request', (event) => { /* open/focus/clear */ });
// ... serial.write({ data }), serial.key({ key }), serial.resize({ cols, rows }), serial.clear({}), serial.reconnect({})
```

## TUI panel

`./tui` is the package's TUI part (`src/tui.tsx`): a live, scrollable console
inside OpenCode's terminal UI. It is a `session.panel` contribution fed by the
same `linkr_bee.console` RPC, so it shows the same bytes as the agent tools and
the desktop panel.

### Open it

- Keybind **Ctrl+Shift+L** (command id `linkr-bee.console`, rebindable in the
  host's keybind configuration), or **Ctrl+L** on terminals that cannot send the
  shift modifier with a control key.
- Command palette: **Linkr Bee: open console**.
- Slash command **`/linkr-bee`** (alias `/bee`), which also accepts action
  arguments: `/linkr-bee send help`, `/linkr-bee ctrl-c`, `/linkr-bee clear`,
  `/linkr-bee raw` (toggle raw/reading), `/linkr-bee reconnect`; a bare
  `/linkr-bee` opens the panel.

### Connect a board and change settings

The TUI mirrors the desktop settings page with dialog flows, so a board can be
paired without leaving the terminal:

- Palette: **Linkr Bee: board / pair…** (also `/linkr-bee scan`, `/linkr-bee
  pair`, `/linkr-bee board`) opens a menu with **Scan and connect…** (BLE scan,
  pick a board, save its name and dial it), **Connect saved board**, **Show
  status**, and BLE name/address prompts.
- Palette: **Linkr Bee: settings…** (also `/linkr-bee settings` or
  `/linkr-bee config`) edits the transport (and only that transport's fields:
  BLE name/address, or LAN host/token), the bee-cli path, timeouts, the browser
  console page switch (with its URL) and the bridge UART (baud/data/parity/
  stop/flow + Apply, BLE only).
- `/linkr-bee status` shows the link state and browser page URL.

The same guard rails as the desktop page apply: the settings RPC is additive
(an older server shows an error toast instead of breaking the TUI), a scan
that hears nothing explains power/advertising/pairing-key causes, and every
saved value goes to the plugin's settings file, not `opencode.json`.

The panel is a *session* panel, so it needs an open session; the command shows a
toast when there is none.

### What it shows

Two views over the same RPC, toggled from the palette, `/linkr-bee raw`, or
**Ctrl+Y**:

- **reading** (the default) is the server's filtered text log, rendered by
  `src/tui/render.js`: agent probe/setup echoes are hidden, `LINKR_RC_*`
  completion markers become one `[Agent] exit=N` line, ANSI CSI/OSC/DCS
  sequences are stripped, `\r` overwrites the current line (progress bars
  collapse), backspace moves the cursor, and scrollback is bounded at 2000 lines
  / 64 KiB. It has a one-line editor: type a line and press Enter to write it
  plus `\r`; an empty line sends a bare Enter.
- **raw** is a true VT100 terminal — OpenTUI's embedded terminal renderable,
  fed the raw byte stream. Every key typed into the panel goes to the board
  verbatim, so full-screen programs, arrow-key menus and curses UIs work, and
  the terminal answers device queries the board's program sends. Typing and
  output are per-keystroke, not line-buffered.
- A header with the connected/offline dot, the active view, the bridge baud
  rate (when the board reports it), the size applied to the board, the byte
  cursor and the link target (or the last link error).
- Palette commands for the panel actions: **send line…** (dialog prompt),
  **send Ctrl-C**, **clear**, **toggle raw terminal / reading log**, and
  **reconnect**. Once the panel has reported link state, a `sidebar.content`
  line shows `Linkr Bee · <transport> · <target> · <connected|offline>` in the
  session sidebar.
- Size: the raw terminal reports its fitted size to the board through `resize`;
  the reading log forwards the panel width and an estimated 24 rows, because a
  slotted panel is given width but not height.

The chosen view is remembered with the host's durable TUI storage (and synced
across TUI instances), so reopening the panel keeps the view you used last; a
host that refuses storage simply falls back to the reading log.

If the host's OpenTUI predates the embedded terminal, the panel still works:
raw output then renders through the same text log (no per-keystroke VT100), and
the header says `raw log` instead of `raw terminal`.

### No board, no CLI

The panel opens regardless: with no board or no `bee-cli` the header says
`offline`, the body explains the last link error, and Reconnect retries. If the
server part or its RPC is unavailable, the panel renders a visible error line
instead of crashing the TUI.

### Verification status

The TUI part was loaded and driven in the real installed OpenCode **2.2.7** TUI
on macOS, with both views and the no-board path exercised. See
[TUI panel verification](#tui-panel-verification) under Development for the
evidence and for what could not be checked headlessly.

## Web UI / desktop panel

`./gui-experimental` is a prebuilt GUI plugin part: a Solid panel with an
[xterm.js](https://xtermjs.org/) terminal that shows the same console the TUI
panel and the agent share. The bundle is committed at
`dist/gui-experimental.cjs` (the `./gui-experimental` export), so installing the
package needs no build step.

### Where it appears

OpenCode 2.2.7 loads GUI plugin parts in **OpenCode desktop app windows**. The
server advertises and serves the bundle (`features: { gui: true }`;
`GET /api/plugin/gui?id=opencode-linkr-bee` returns the built file), but the
browser web UI served by `opencode serve` does not load GUI plugin parts: a
plain browser tab at the serve URL shows the web client without the plugin's
panel or command. Use the desktop app window for this panel, or the TUI part in
a terminal.

### Open it

- Command palette: **`Linkr Bee: toggle console`** (published id
  `opencode-linkr-bee.toggle`), default keybind **Ctrl+`** (rebindable in
  Settings > Shortcuts).
- The session side-panel **+** menu: **Linkr Bee console**.
- The agent's `linkr_bee_console` tool with `open`/`focus` asks the panel to show
  itself through the RPC `request` event.

The panel lives in a session's side region, so it needs an open session tab; the
command shows a toast when there is none.

### What it shows

- A live xterm.js terminal fed by the same `linkr_bee.console` RPC; the
  **Reading** view hides agent probe echoes by default, **Raw** shows the byte
  stream. Typing goes to the board through `write` (raw keystrokes/escape
  sequences), so the target terminal interprets them itself.
- A status row with link state, transport, terminal size and target (or the
  last error), plus **Reading/Raw**, **Clear** and **Reconnect** controls.
- Colors and mono font follow Settings > Appearance; the terminal is fitted to
  the panel, and its size is forwarded to the board with `resize`.

With no board or no `bee-cli`, the panel still opens and degrades to a visible
`disconnected` status with the last error and a working **Reconnect** button. If
the server part has no console RPC, it shows that error instead of crashing the
window.

### Build

The shipped bundle is prebuilt from `src/gui.tsx` + `src/gui/**` with the
preset from `@opencode/plugin/gui/vite`. Rebuild it after changing that source:

```sh
cd linkr-bee-opencode
npm install        # vite, vite-plugin-solid, solid-js, @xterm/xterm, @xterm/addon-fit
npm run build:gui  # vite build -> dist/gui-experimental.cjs
```

`dist/gui-experimental.cjs` is one CommonJS file (~350 KiB, xterm bundled); the
modules OpenCode provides (`@opencode/plugin/gui`, `@opencode/plugin/rpc`,
`solid-js`, `solid-js/web`) stay external. Keep it committed: the
`./gui-experimental` export points at it. `npm run build:gui:watch` rebuilds in
place while developing.

### Verification status

The bundle, registration and rendering were verified as follows. The real
OpenCode desktop app window was **not** driven in this checkout, and the
browser web UI cannot show the panel (see above) — do not read this section as a
desktop-app or browser-tab verification.

- `npm run build:gui` produces `dist/gui-experimental.cjs` whose only `require`
  calls are the app-provided modules (`@opencode/plugin/gui`,
  `@opencode/plugin/rpc`, `solid-js`, `solid-js/web`); xterm and the fit addon
  are bundled; the file default-exports `Plugin.define`.
- On a local 2.2.7 server the plugin reports
  `features: { server: true, rpc: true, gui: true }`, and
  `GET /api/plugin/gui?id=opencode-linkr-bee` returns the built file
  byte-for-byte.
- The styles, `Plugin.define` setup (side panel, palette command, side-panel `+`
  menu row) and the panel component were rendered in Chromium against the real
  `@opencode/plugin/gui` SDK with a stubbed host context and a fake console RPC:
  the panel mounts, the disconnected hint and Reconnect work, output events draw
  in the terminal, typing arrives as `write`, Reading/Raw and Clear/Reconnect
  call their RPC methods, and the fitted size reaches `resize`.
- The browser web UI was probed with Playwright on 2.2.7: it never requests the
  plugin GUI bundle and has no plugin-GUI bridge, which is why this panel is
  documented as desktop-only.

## Settings page

The desktop GUI part contributes a **Linkr Bee** page to OpenCode's Settings
(app palette: `Linkr Bee: settings`, or the ⚙ button in the console panel's
header). It is ordered around the task most people came for — connecting a
board — and everything applies immediately, without restarting OpenCode:

1. **Board** — link status with Refresh/Connect, **Find nearby boards** (BLE
   scan, about 8 s, no dial), the boards found with a one-click **Connect** per
   board (saves the name, then dials), and "Connect saved board" for a board
   that is already named. When a scan hears nothing, the page explains the
   likely reasons (board off, connected elsewhere, pairing key needed on a new
   host).
2. **Connection** — transport selector, then only that transport's fields:
   BLE name and address, or LAN host and token (the token is write-only: the
   page shows only whether one is stored, and Clear removes it). Shared
   `bee-cli` path, request timeout and send capture window follow, with Save.
3. **Bridge UART** — baud rate, data bits, parity, stop bits and flow control:
   appears only for Bluetooth LE, because LAN and loopback cannot configure the
   bridge. Apply writes the format and reads it back.
4. **Browser console page** — the `webConsole` switch and the page URL with a
   Copy button.

Saved values live in the plugin's own settings file, never in `opencode.json`:

```
$XDG_STATE_HOME/opencode/linkr-bee.json     # default ~/.local/state/opencode/linkr-bee.json
```

Precedence when the plugin starts: **settings file > plugin `options` >
environment > defaults**. Saving replaces the persisted layer only; the
`plugins` entry stays authoritative for everything the page does not expose.
The RPC surface is additive and documented in `src/rpc-schema.js`:
`settings`, `updateSettings`, `scan` and `applyUart` on `linkr_bee.console`.
API keys and tokens are never returned by `settings` (only `lanTokenSet`).

## Browser console page

OpenCode 2.2.7's browser web UI cannot load GUI plugin parts, so the plugin also
serves its own tiny console page for a normal browser — useful for a second
monitor, a tablet on the same machine, or when the desktop app is not in use.
It is the same console the agent, TUI and desktop panel use: same session, same
64 KiB rings, same reading view, same RPC-backed bytes.

### Open it

The page server starts with the plugin (`webConsole: true`, the default) and
the URL is available in two places:

- the `state` RPC output carries `webUrl` (additive field);
- the `webUrl({})` RPC method returns `{ url, enabled }`.

```bash
# ask the server for the page URL, e.g. from a script
curl -s -u "opencode:<server password>" -H 'content-type: application/json' \
  -d '{"input":{}}' http://127.0.0.1:<opencode-port>/api/rpc/linkr_bee.console/webUrl
# {"output":{"url":"http://127.0.0.1:59142/?t=db9b…","enabled":true}}
```

Open that URL in a local browser. The page is a full-window xterm.js terminal:
it backfills with `GET /read`, streams live `output` events over SSE, sends
keystrokes as `POST /input` (or named keys as `POST /key`), and has Reading/Raw
toggle, Clear, Reconnect and Copy URL. The page bundle is `dist/web-console.js`
(committed; `npm run build:web` rebuilds it, `npm run build` rebuilds both UI
bundles). It is a standalone page: it is not embedded in OpenCode's web UI.

### Endpoints (frozen contract)

| Request | Response |
| --- | --- |
| `GET /?t=` | HTML shell (`Linkr Bee console`), loads `/assets/web-console.js?t=`; injects `window.__LINKR_BEE_TOKEN__` / `window.__LINKR_BEE_WEB_URL__` |
| `GET /assets/web-console.js?t=` | the committed page bundle (`text/javascript`, no-store) |
| `GET /state?t=` | the RPC `state` object plus `webUrl` |
| `GET /read?t=&view=reading\|raw&since=<bytes>` | `{view,text,bytes,epoch,truncated?}` |
| `GET /events?t=` | SSE: `retry`, initial `state`, then `output`/`state`/`request` events (RPC payloads, including `reading`/`readingBytes`) |
| `POST /input?t=` `{data}` | `{ok:true}` or `{ok:false,error}` |
| `POST /key?t=` `{key}` | same |
| `POST /resize?t=` `{cols,rows}` | `{ok:true,applied,cols,rows,reason?}` |
| `POST /clear?t=` `{}` | `{ok:true}` |
| `POST /reconnect?t=` `{}` | `{ok:true}` or `{ok:false,error}` |

Every request needs the token as `?t=` (EventSource cannot set headers; an
`Authorization: Bearer <token>` header is also accepted). Missing/wrong token is
HTTP 401, a malformed body 400, an over-64 KiB body 413.

### Security

The page server is **local-only**: it binds `127.0.0.1` on an ephemeral port,
generates a fresh 32-hex token each start, sends no CORS headers, rejects
non-loopback sockets and caps request bodies. The token appears only in the URL
`webUrl`/`state.webUrl` returns — treat that URL as a local secret and do not
paste it into a remote page or chat. The server stops when the plugin unloads.
Set `webConsole: false` (or `LINKR_BEE_WEB_CONSOLE=0`) to not listen at all.

### How this differs from the desktop panel

Both show the same console over the same authority:
`./gui-experimental` is loaded inside OpenCode desktop app windows and is
addressable from the session (side panel, palette command); the browser page is
a plain HTTP page with no OpenCode dependency, opened by URL for a local
browser. They can be open at once — they share the ring, so each sees the same
bytes.

## Permissions and safety
 

OpenCode 2.x has a `permissions` configuration of ordered `action`/`resource`/
`effect` rules (`allow`, `deny` or `ask`). Every tool in this plugin declares the
stable permission action **`linkr_bee`**, so one rule controls all five board
tools:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "linkr_bee", "resource": "*", "effect": "deny" }
  ]
}
```

- **`deny` removes the five board tools from the model's tool list entirely**
  (verified on 2.2.7). The automatic tool gate matches `resource: "*"`; a
  narrower resource such as the tool name does not match, so use the wildcard.
- **`allow`** lets calls run without a prompt.
- **`ask`** prompts — but only because `linkr_bee_exec` (except `dryRun`),
  `linkr_bee_send` and `linkr_bee_set` call `ctx.permission.assert()` before
  changing the board or the bridge; the read-only `linkr_bee_query` does not ask,
  and `linkr_bee_console` is covered by the automatic deny gate but does not add
  its own prompt.
  In a non-interactive `opencode run` a prompt is rejected with "This
  non-interactive run cannot ask the user for permission, so the request was
  rejected" unless the run is allowed to answer (`--auto`); the tool call then
  fails rather than silently running.
- **No matching rule:** the built-in agents' default allow applies, so the
  plugin works out of the box without adding any permission rules.
- **Disable the plugin itself** with the `plugins` control syntax —
  `{ "plugins": ["*", "-opencode-linkr-bee"] }` — or `opencode plugin remove
  opencode-linkr-bee`. The `policies` `tool.use` rules are not a plugin-tool
  gate in 2.2.7; do not rely on them for board access.

What the tools do:

- A tool call spawns a local `bee-cli` process from the OpenCode host and talks
  to the board over Bluetooth LE or the LAN. The commands themselves run on the
  **target board**, not on the host; `linkr_bee_query`/`linkr_bee_set` change the
  **bridge**, not the target board.
- Console output is untrusted device data; it is returned as data and never
  interpreted as instructions by the plugin.
- The plugin never resends automatically when delivery is unknown.
- The LAN token is passed through the environment and is kept out of tool
  results.

## What differs from dsh-linkr-bee

The DSH plugin ([`../linkr-bee-dsh/README.md`](../linkr-bee-dsh/README.md)) runs
inside DeepSeek Harness and draws its xterm console in the Harness right
column. This package ships the same console authority as an OpenCode plugin,
with the UI delivered by OpenCode's own plugin parts:

- **two panels, one console**: a `./tui` part for the terminal UI and a
  `./gui-experimental` part for OpenCode desktop app windows, both speaking the
  `linkr_bee.console` RPC to the same resident session and rings;
- **five tools**, including the restored `linkr_bee_console` (open/focus asks
  the panels through the `request` event, the other actions act directly);
- **configuration** through the `plugins` entry or environment rather than a
  Harness settings dialog;
- the same CLI precedence, connection flags, BLE name discovery, capture
  limits, reading view and output rendering, so behaviour and error wording
  stay familiar.

## Development

The plugin is `index.js` (the only file importing `@opencode/plugin`), the
console authority `src/console.js`, the RPC contract `src/rpc.js` +
`src/rpc-schema.js`, the three tool/config modules, and the UI parts under
`src/gui*`/`src/tui*`. The unit tests need no `node_modules` at all:

```sh
node --test linkr-bee-opencode/test/*.test.mjs
```

The suite (83 server/console/browser tests, plus the TUI render tests) covers tool registration and JSON-Schema descriptors,
malformed-argument rejection, exec/query/send/set argv and framing, capture
windows, UART/name validation, config defaults and environment fallbacks, CLI
resolution precedence, report rendering/truncation, and run timeouts/aborts. It
also drives the console authority through a fake `bee-cli --serve`: ready/ops
framing, `watch` streaming, `monitor` polling, `send`/`resize` frames, the
reading-view filter and `LINKR_RC` collapsing, the 64 KiB ring and its byte
counters, clear/epoch, keys, reconnect, the link lease, and the
`linkr_bee_console` tool. The browser page suite covers token enforcement
(401s, bearer auth), the HTML shell and committed asset, `/state`, `/read`,
SSE state/output frames, every POST endpoint, the body cap, and that stopping
the page closes its listener. Fixtures are fake scripts in a temp directory
that record their arguments, stdin and frames and answer from scenario files.

For a real-server smoke test, the setup can name a file in
`LINKR_BEE_OPENCODE_MARKER`; the plugin then writes the board tool ids the host
accepted into that file during `setup()`. It is a diagnostics hook for
development and is off unless the variable is set; it never touches the board.

### TUI panel verification

`test/tui-render.test.mjs` is 33 `node:test` cases for the pure renderer (ANSI
CSI/OSC/DCS stripping, CR progress overwrite, backspace, tab stops, split escape
sequences across chunks, scrollback bounds by lines and bytes, wrapping by cell
width including CJK, reading/raw source selection and cursor selection).

The real TUI was then run headlessly against the installed **2.2.7** binary
(`opencode --standalone --session <id>`, XDG dirs under `/tmp`, a local-directory
`plugins` entry pointing at the package) with a fake `bee-cli --serve` that
streams a demo console. This sandbox blocks PTY allocation (`openpty` and
`script` fail with `Operation not permitted`), so stdin was fed keystrokes and
stdout captured as the rendered ANSI stream, which was replayed through a VT100
emulator (`pyte`) to produce the screen snapshots.

- `setup` ran with `HAS_TERMINAL: true`; the panel opened with **Ctrl+L**
  (`panel-mount`, width 80) after a session was created; `state({})` started the
  resident session (`watch on:true` recorded by the fake CLI) and `read`
  backfilled 81 bytes into the reading log.
- `output`, `state` and `request` events were subscribed; the reading log
  rendered `Linkr Bee TUI demo console / board> version / zephyr v4.5.0 …`,
  the header showed `● connected  reading log · 80×24 · 81 B · loopback`, and a
  typed `x` landed in the line editor.
- **Ctrl+Y** switched to raw: the embedded terminal mounted and focused
  (`term-mounted`, `term-focus`), its `screen()` returned the console text at
  80×24, and the geometry was forwarded to the board (`resize 80×24`). A typed
  `x` arrived as terminal input and became an RPC `write`: the fake CLI recorded
  `{"op":"send","data":"x"}` and its echo appeared on the terminal screen.
- The view preference persisted across two TUI processes sharing one XDG
  state: run 1 opened in the reading log, **Ctrl+Y** switched to raw
  (`view-persist raw`); run 2, a fresh process with no keystroke to toggle,
  mounted the panel directly in `raw` (`panel-mount … view:"raw"}`, raw reload
  drawn).
- A no-board run (missing `bee-cli`) kept the TUI alive: `connected:false` with
  the full "bee-cli was not found …" error rendered as the offline hint, and the
  panel closed cleanly (unmount + plugin cleanup).
- Markers come from the opt-in `LINKR_BEE_TUI_MARKER` file (same pattern as the
  server marker); artifacts: `/tmp/oc2tui-artifacts/` (`tui-{reading,raw,noboard}.log`,
  `markers-*.jsonl`, `fake-calls-*.jsonl`, `screen-*-panel.txt`).

The `sidebar.content` status line is registered (and its state was reported by
the panel), but the 80-column TUI in these runs hides the session sidebar, so
the line itself was not visible in the captured screens.

Not verified headlessly: a real outer-terminal resize of the TUI (the sandbox
cannot allocate a PTY, so no `SIGWINCH` path was exercised), mouse selection
inside the embedded terminal, and a physical board (the console came from the
fake `bee-cli`). The embedded-terminal branch itself was exercised end to end.
