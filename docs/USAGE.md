# Linkr Bee user guide

[Project overview](../README.md) | [Documentation](README.md) | [中文使用指南](USAGE.zh-CN.md)

This guide covers the shared Web, Android/iOS, and HarmonyOS terminal interface.
For desktop CLI/TUI commands, use the [Rust host terminal guide](../tools/linkr-tui/README.md).
Build, signing, and integration instructions belong to the [development guide](DEVELOPMENT.md)
and the individual platform guides.

## First connection

1. Flash the firmware for your accessory and connect the target's 3.3 V UART:
   target TX to Bee RX, target RX to Bee TX, and common ground. On the C3 Super Mini,
   Bee RX is GPIO20 and Bee TX is GPIO21.
2. Open the client. For the Web terminal, run `tools/serve_web.sh` from the repository
   root and visit `http://127.0.0.1:8765/` in Chrome/Chromium.
3. For a new host on a board with pairing authorization enabled (C3/C5), hold
   **GPIO1** to GND, select **Connect**, and accept the operating system's pairing
   prompt. WROOM disables the physical check by default and needs no GPIO4 press.
   Release it once paired. An existing bond does not need the jumper again.
4. Open **Serial** in the settings rail. Match the target's baud, data bits, parity,
   stop bits, and flow control; the default is `115200,8,n,1,n`.
5. Reset the target or press Enter in the terminal to obtain its console prompt.

Only one BLE host can connect at a time. If another client owns the connection,
disconnect it before selecting the accessory here. Use the
[pairing and recovery guide (Chinese)](BLE_PAIRING.md) for lost bonds or a full bond list.

## Interface tour

![English desktop terminal preview](../assets/screenshots/linkr-bee-terminal-desktop-en.jpg)

*These captures use the English UI and sample UART output in a disconnected
retained-transcript view. They do not represent a live hardware session.*

| Area | Purpose |
| --- | --- |
| Top bar | Connection state, connect/disconnect, settings visibility, theme, and language |
| Left rail | Connection, serial, network, assistant, and About sections |
| Terminal | Target output, direct input when connected, selection, and scrollback |
| Terminal toolbar | Assistant workspace, font size, fullscreen, scroll-to-bottom, and copy |
| Accessory keys | Esc, Tab, modifiers, navigation, paste, Enter, and control combinations |
| Status bar | Received/sent byte counts, baud rate, and connection state |

### Serial settings

![English serial settings preview](../assets/screenshots/linkr-bee-terminal-controls-en.jpg)

- **UART** changes the accessory's actual serial format. Disable hardware flow
  control unless both CTS and RTS are wired and the target uses them.
- **Enter key** selects raw, CR, LF, or CRLF. Use the target's convention rather
  than enabling local echo to compensate for a wrong line ending.
- **Local echo** displays what you type locally. Leave it off for shells that
  already echo input, or each character may appear twice.
- **Chunk size** controls outgoing transfer chunks, not baud rate. Keep the
  default unless diagnosing a specific transport limit.
- **Terminal font** uses fonts installed on the host. A Nerd Font must be installed
  locally before its extra symbols can render.

Close settings when finished to return the space to the terminal. Serial settings
and bridge diagnostics use BLE management; they are not sent as commands to the
target shell and are not available over a LAN-only session.

### Phones and tablets

<p align="center">
  <img src="../assets/screenshots/linkr-bee-terminal-mobile-en.jpg" alt="English phone-width terminal preview" width="360">
</p>

The terminal remains the main workspace. Settings use a drawer on touch devices
and narrow windows. Scroll the accessory key row sideways for additional keys;
tap Ctrl, Alt, or Shift before the next key, and tap again to cancel the modifier.

The assistant stacks below the terminal in narrow windows and moves beside it
when enough width is available. When the system keyboard is editing an assistant
question or setting, the terminal can collapse to preserve the input area; return
to it with **Show terminal**. Logs continue to accumulate while it is collapsed.

These are shared responsive layouts. Native keyboard behavior and BLE support
still depend on the platform; check the [mobile](../mobile/README.md) and
[HarmonyOS](../harmonyos/README.md) validation notes before treating an emulator
preview as a real-device result.

## Serial input and display

- Click the terminal before typing. Use the accessory keys when a system keyboard
  does not offer Esc, Tab, arrows, or Ctrl combinations.
- The target must support ANSI sequences to produce colored or full-screen
  output. The Web terminal uses xterm.js for 256-color rendering and cursor control.
- The client synchronizes terminal rows/columns at supported shell prompts after
  login and on layout changes. This is best effort on a UART, not an SSH PTY;
  bootloaders and custom consoles may not support the shell resize command.
- If output is garbled, check UART framing and ground before changing fonts.
- If output works but input does not, check target RX to Bee TX and the flow-control
  setting. Local echo alone does not prove the target received a byte.

## Serial assistant

Select **AI** in the terminal toolbar, then **Settings** in the assistant header.
Choose a provider, check its base URL and protocol, enter your own API key when
required, and select a model. **Fetch model list** requests available IDs when the
provider supports listing; the model field remains editable.

Supported protocol adapters include OpenAI-compatible, Anthropic, and Gemini.
The browser calls the configured endpoint directly. Its CORS policy must allow
the page, and HTTPS pages cannot freely call insecure HTTP endpoints. Additional
provider headers can be entered in settings; see the
[platform assistant notes](../mobile/README.md#built-in-serial-assistant-pi).

| Mode | Serial input policy |
| --- | --- |
| Manual | Every proposed input waits for approval. |
| Auto (default) | Recognized low-risk queries at a detected shell prompt can run directly; other input requires approval. |
| Full Auto | Routine input can run directly for up to 15 minutes; recognized destructive commands and commands marked Always ask still need approval. |

Bridge configuration changes have a separate approval step. The serial policy
uses local rules, not the model's risk rating. It is not a sandbox: scripts,
aliases, and non-shell consoles may behave differently. Inspect the proposed
command and subsequent output; sending input or seeing a prompt is not proof of
success. **Stop** cancels pending assistant work, but cannot recall transmitted
bytes. Use terminal Ctrl-C to interrupt the target when appropriate.

### Data and privacy

- The API key is stored in plaintext in this browser/app's local storage
  (`linkr-agent-model`). It is used in requests to your selected provider, not
  uploaded to the Bee accessory or a Linkr relay. Clear configuration or site data
  to remove it; avoid saving credentials on shared hosts.
- Questions can include serial logs and saved device notes. Redaction is best
  effort; review sensitive output before sending it to a model service.
- Conversation history and device notes are local to the client. They are historical
  evidence, not proof of the target's current state.
- Model inference uses the selected service. A local Ollama endpoint is an option;
  the phone app does not bundle an offline language model.

## LAN and logging

1. While connected over BLE, open **Network** and provision the accessory onto a
   2.4 GHz WiFi network.
2. Obtain the accessory's address and access token. The Web client reads the token
   over encrypted BLE; `@s?` is the management query used by other clients.
3. Select **LAN** in connection settings and supply that address and token.

LAN carries UART data over WebSocket; BLE remains the configuration channel.
The token controls access but does not encrypt `ws://` traffic. Use a trusted LAN.

**Save Log** exports received serial data on the host. WebDAV is different: the
accessory uploads UART logs itself after its WiFi and upload target are configured.
The current firmware accepts anonymous **HTTP** upload endpoints only; it does not
support HTTPS or Basic Auth. Keep the endpoint on a trusted network. Some firmware
builds disable WebDAV to fit their memory budget; consult the build's configuration.

For troubleshooting, start with the [README checklist](../README.md#troubleshooting).
For firmware commands, counters, and persistence details, use the
[development guide](DEVELOPMENT.md#control-commands-reference).
