# Changelog

## 1.2.0

First published cut of the OpenCode plugin, targeting the OpenCode 2.x plugin
API (`@opencode/plugin` 2.2.7). Versions continue to follow the Linkr Bee main
line, together with `linkr-bee-cli` and the DSH plugin.

- Registers the Linkr Bee board tools on OpenCode 2.x:
  `linkr_bee_exec` (one-shot command on the target console, with idle/timeout/
  retry and an offline dry run), `linkr_bee_query` (bridge diagnostics,
  configuration, link state, doctor, scans), `linkr_bee_send` (deliver input and
  capture the reply window), and `linkr_bee_set` (BLE management settings, with
  UART normalisation and the 1-29 byte BLE-name check).
- The entry is a v2 `Plugin.define({ id, setup })` module: options come from the
  `plugins` config entry (`ctx.options`) with environment fallbacks, and the
  tools are added in one `ctx.tool.transform()` registration that the setup
  cleanup disposes.
- Tools are registered with `codemode: false` so they are offered to the model
  directly instead of only inside Code Mode, and they declare plain JSON Schema
  inputs (no zod dependency).
- Same `bee-cli` resolution order, connection flags and BLE name discovery as
  `dsh-linkr-bee` 1.2.0: options/environment first, then the installed launcher,
  this checkout's build, and `PATH`. Discovery results are cached for five
  minutes and forgotten after a failed dial.
- Bounded JSON Lines capture (1 MiB / 4096 events) with result/error frames
  taking precedence over older output, and the familiar
  `--- target output ---` / `--- stderr ---` rendering.
- One-shot calls are serialized so two tools cannot race for the single BLE
  link; cancellation before/after dispatch is reported distinctly and nothing
  is resent automatically.
- Every tool declares the stable `linkr_bee` permission action, so one v2
  `permissions` rule can deny (and `ask` can prompt for) board access;
  state-changing calls also call `ctx.permission.assert()`.
- Every tool validates and clamps its own arguments as well as advertising the
  schema to the host (defence in depth; the v2 host validates too).
- Adds the shared live serial console: one resident `bee-cli --serve` session
  (watch push with a monitor poll fallback), a 64 KiB raw ring and a reading
  view that hides the agent dispatch wrapper and collapses `LINKR_RC_*`
  completion markers into `[Agent] exit=N`. The one-shot tools take a link lease
  so an agent command and a live panel never fight over the board.
- Restores the `linkr_bee_console` tool (open/focus/clear/type/key/read/state/
  resize) on top of that console; open/focus are published as RPC `request`
  events so a panel can show itself.
- Adds the typed console RPC (`linkr_bee.console`, package export `./rpc`) with
  methods state/read/write/key/resize/clear/reconnect and events
  output/state/request, and registers it with the server plugin. The TUI
  (`./tui`) and desktop GUI (`./gui-experimental`) panels are clients of that RPC.
- No console tool was shipped in the previous cut because an OpenCode server
  plugin had no UI pane; this release adds the UI parts and the console
  authority they share with the agent tools.
- Adds the TUI part (`./tui`, `src/tui.tsx`): a live console session panel in
  OpenCode's terminal UI, opened from the `Ctrl+Shift+L` binding (or `Ctrl+L`),
  the palette (`Linkr Bee: open console`) or `/linkr-bee` (with `send`/
  `ctrl-c`/`clear`/`raw`/`reconnect` arguments). It backfills from `read`,
  follows `output`/`state`/`request` events, and has two views: a **reading**
  log rendered by `src/tui/render.js` (ANSI stripped, CR-overwrite, backspace,
  bounded 2000-line / 64 KiB scrollback, unit-tested with node:test) with a
  one-line editor, and a **raw** view on OpenTUI's embedded VT100 terminal where
  every keystroke goes to the board verbatim (full-screen programs work). The
  chosen view is remembered with the host's durable TUI storage. Both
  share palette actions for send line, Ctrl-C, clear, view toggle and reconnect,
  forward the panel/terminal size to the board, and show a visible offline hint
  (no board, no `bee-cli`, no RPC) instead of crashing the TUI. Verified by
  driving the installed OpenCode 2.2.7 TUI headlessly (loading, both views,
  keystroke-to-`write`, and the no-board path).
- Adds the prebuilt desktop GUI part (`./gui-experimental`,
  `dist/gui-experimental.cjs`): a Solid + xterm.js console panel in a session's
  side region of the OpenCode desktop app, with a palette command
  (`Linkr Bee: toggle console`, default Ctrl+`), a side-panel + menu row,
  Reading/Raw views, Clear/Reconnect, appearance theming and fit-to-panel
  resize, all over the `linkr_bee.console` RPC. With no board or no `bee-cli` it
  shows a disconnected status and a working Reconnect instead of failing. Built
  with the `@opencode/plugin/gui/vite` preset (one committed CommonJS file,
  xterm bundled); verified structurally and in a Chromium harness, while the
  2.2.7 browser web UI does not load GUI plugin parts (desktop-app windows
  only).
- Adds TUI dialog flows for the same settings and pairing work: palette
  commands **Linkr Bee: board / pair…** (scan → pick a board → save → dial,
  connect the saved board, status, BLE name/address) and **Linkr Bee:
  settings…** (transport-specific fields, bee-cli path, timeouts, browser page
  switch + URL, bridge UART apply), plus `/linkr-bee scan|pair|board|settings|
  config|status` slash arguments. Flows are plain functions over the host's
  dialog/toast and the console RPC, covered by fake-host tests.
- Adds a **Linkr Bee** page to the desktop app's Settings: transport / board /
  LAN token / `bee-cli` path / timeouts, nearby-board scan, bridge UART apply
  (BLE read-back), and the browser console page switch with its URL. Values are
  persisted by the plugin in `$XDG_STATE_HOME/opencode/linkr-bee.json`
  (precedence settings file > `options` > environment) and exposed through four
  additive `linkr_bee.console` RPC methods (`settings`, `updateSettings`,
  `scan`, `applyUart`); changes reconnect the console and start/stop the page
  server at once. The settings page uses the host's own `SettingsPage` /
  `SettingsLayout` components and degrades read-only when the RPC is missing.
- Shows the bridge UART baud rate in every status bar (desktop panel, TUI
  header and sidebar, browser page): the saved setting is used first, then the
  live session asks the bridge for its own UART settings and the `state` report
  (additive `baud` field) carries the real value; applying UART in the settings
  updates the bars immediately.
- Adds a standalone local browser console page for cases where the OpenCode
  browser web UI is used (it cannot load GUI plugin parts): the plugin serves a
  loopback-only HTTP page (`127.0.0.1`, ephemeral port, fresh 32-hex token on
  every request) with the page shell and `dist/web-console.js`, `/state`,
  `/read`, an `/events` SSE stream and POST `input`/`key`/`resize`/`clear`/
  `reconnect`. It runs on the same console authority as the agent tools and the
  other panels (no second `bee-cli` session). `webUrl({})` and an additive
  `state.webUrl` expose the URL; the new `webConsole` option (default true,
  env `LINKR_BEE_WEB_CONSOLE`) disables the listener, and it stops on unload.
