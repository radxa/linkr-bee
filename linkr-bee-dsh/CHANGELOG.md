# Changelog

## Unreleased (not published; version stays 1.1.4 until confirmed)

- Execution safety: cancellation covers connection startup and queued requests.
  An operation whose delivery or result is uncertain is never automatically
  replayed, and a failed send is reported as a failure rather than as delivery.
- Link ownership: tools return an idle connection when finished; an open panel
  keeps its stream. Queries wait for active operations, and closing the panel,
  stopping an old CLI poll or reloading the plugin cannot strand or steal a link.
- Console replay: atomic ring snapshots and Host epoch/sequence cursors prevent
  duplicate output after reconnect, restore gaps beyond the event backlog, and
  keep cleared output cleared. Late callbacks cannot revive a retired stream.
- UART results: reads and changes require BLE and an affirmative CLI result;
  failed commands never announce a successfully changed configuration.
- Selection/copy: xterm paints its selection on a canvas layer, not a DOM
  text selection, so a pane that cannot drag-select used to offer nothing.
  The header now has a **Copy** button (disabled until something is selected,
  briefly reads "Copied" after a successful write), and a right-click over a
  selection copies it. Both also work with Cmd/Ctrl+C, which xterm handles.
- Diagnostics: the terminal reports, once per mount, the element chain that
  receives a pointerdown when it is not the xterm screen — evidence for a
  pane overlay that swallows drag selection in some environments.
- Reading / Raw console views: matching the Web terminal, the panel now has
  a Reading view (default) that hides agent probe/setup echoes and replaces
  `LINKR_RC_<nonce>:<code>` completion markers with `[Agent] exit=N`, while
  keeping all device output; Raw shows every byte. The Host keeps two separate
  64 KiB histories, streams both texts, and the view switch replays the chosen
  history without sending serial input. The filter is best-effort and fail-open.
- UART card compacted: the settings card was ~241px tall (a 2-column grid of
  tall controls plus a separate button row). The five fields now sit in one
  row, with the Read/Apply buttons and the current spec sharing the title row,
  smaller labels and tighter spacing. Measured 90px tall, with every control
  still at the 36px touch-target floor and no text overflow.
- UART panel alignment: the five UART selects inherited `.lb-mode`'s
  `flex: 0 0 84px`, which stretched them to 84px (much taller than the other
  settings controls). They now use a 2-column grid with the same 36px height,
  padding and font as the transport/timeout fields, and the card no longer
  draws its own top border — it reads as part of the settings group.
- UART settings: the ⚙ panel now reads and changes the bridge's UART format
  (baud, data bits, parity, stop bits, flow) over the BLE management channel,
  with `GET`/`POST /linkr-bee/uart` behind it. LAN/loopback links show why the
  controls are unavailable rather than presenting dead ones. The bridge is
  read back after a change, and a bad spec is refused before dialing.
- Divider alignment: the panel header drew its own bottom border, but the
  shell clips the pane body, so that rule began at the right column's left edge
  while the left side had none (and at a slightly different height/colour).
  The header now draws no rule and shares the column's background, leaving the
  shell's tab strip as the single, continuous horizontal divider.
- Selection highlight: `selectionBackground` was bound to a token that is the
  same colour as the terminal background (pure white in light mode), so a drag
  selection was real but invisible. It now uses a translucent brand-coloured
  wash with a readable selected-text colour, a quieter unfocused variant and a
  thin brand-coloured edge, in both light and dark themes.

## 1.1.4

The published cut. Versions now follow the Linkr Bee main line: crate, tag,
CLI npm package and plugin all read 1.1.4.

- **One-step install.** The plugin depends on `linkr-bee-cli@^1.1.4`, so
  `dsh plugin add dsh-linkr-bee` also brings the client: the panel and the tools
  resolve `cliPath` → `$LINKR_BEE_CLI` → the launcher installed beside the
  plugin → `bee-cli` on `PATH`. The launcher downloads and verifies the platform
  binary on first use; a `cliPath` you set yourself still wins. The TUI stays a
  separate download — the plugin only needs the CLI.
- The launcher is resolved from `createRequire(import.meta.url)` and from the
  module's real path, so an ESM plugin behind a pnpm symlink still finds its
  sibling dependency. `linkr-bee-cli` runs **no install script** (nothing for a
  package manager that refuses build scripts to block).
- This release also includes the agent-operable console, panel polish and resize
  work shipped in 1.1.2. The plugin's 1.1.2 was published to npm; only its 1.1.3
  was skipped (`linkr-bee-cli` 1.1.3 was published separately).

## 1.1.2

The console is now something an agent can operate, not just watch. Versions
follow the Linkr Bee main line from here on, so this cut stays in 1.1.

- **`linkr_bee_console` tool**: `open`, `focus`, `clear`, `type`, `key` (enter,
  tab, arrows, ctrl-c/d/z/l, …), `read`, `state`, `resize`. The agent opens the
  pane in the right column, types into the shell the person is looking at, and
  reads back what the board said — one link, one console.
- **`POST /linkr-bee/exec` + `GET /linkr-bee/console/read`**: the tool, the route
  and the panel's own command line share one code path and one console, so an
  agent's command is visible in the pane and its output is readable afterwards.
  The Host keeps the last 64 KiB of console text, readable from a byte cursor.
- **`GET /linkr-bee/panel/stream` + `POST /linkr-bee/panel`**: a control channel
  separate from the terminal's byte stream, so a plugin-lifetime listener can
  open the pane while it is closed.
- **Panel polish**: header shows the link (`ble · board` / `lan` / `loopback` /
  `offline`, neutral while it settles) and the live tty size; a one-line
  reconnect banner with a *Reconnect* action that reports why it failed; an
  empty state instead of a blank screen; the last screen comes back after a tab
  remount or a page reload, and a *Clear* stays cleared.
- **Layout**: the terminal follows its box whatever moved it — beside the pane's
  ResizeObserver it watches the parent, the right column and the window, and
  polls the measured box slowly, so a right-column drag still refits the
  terminal and sends the new size to the target. A pane laid out wider than its
  column (clipped, not resized) is reported once to the Host log.

## 1.1.1

- Robustness: a resident session that dies (the CLI killed, a dropped radio) is
  no longer handed to the next request. Keystrokes sent across that moment are
  retried once on a fresh session, a dead session is dropped before a caller
  can use it, and the error a caller sees now carries the exit code and signal
  instead of a bare "not running". The panel also stops printing the same input
  failure for every keystroke and asks the Host to re-arm the stream.
- Docs only: the command-line client is published as `linkr-bee-cli` (no npm
  organization is in use yet), so the install line reads
  `npm install -g linkr-bee-cli` / `npx linkr-bee-cli`.

## 1.1.0

The current cut of the plugin, published from `radxa/linkr-bee`.

- The console is a real xterm.js terminal in the right column: keystrokes go
  straight to the board, there is no input row; ANSI colour, cursor movement,
  carriage-return progress, bracketed paste and CJK all render.
- The terminal **follows the Harness light/dark theme** live: the shell's theme
  stamp, the OS preference it may follow, and a slow poll for anything else,
  with a palette per mode (xterm's own on light, a tuned one on dark).
- Event-driven link: one resident `bee-cli --serve` session per open panel;
  `watch` pushes the console's **raw bytes** (escape sequences included, no
  polling), `send` forwards keystrokes, `resize` keeps the target's tty in step
  with the panel, and `exec` serves the agent tools on the same link.
- Connection settings in the panel (transport, board scan, LAN host/token,
  timeout, `bee-cli` path), persisted to the profile's `cordis.patch.yml`
  through the Harness config editor.
- Agent tools `linkr_bee_exec`, `linkr_bee_query`, `linkr_bee_send`,
  `linkr_bee_set`, sharing that console with the person typing.
- Local HTTP/SSE surface under `/linkr-bee` with a same-origin guard; the LAN
  token is never echoed back to the page.

## 1.0.0

First public cut of the plugin, published from the personal fork before the
repository moved to `radxa/linkr-bee`.
