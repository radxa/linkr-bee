# Changelog

## Unreleased

- Docs: the CLI is published as `linkr-bee-cli` (an npm organization is not in
  use yet), so the install line reads `npm install -g linkr-bee-cli`.


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
