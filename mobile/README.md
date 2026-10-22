# Linkr Bee mobile app

[User guide](../docs/USAGE.md) | [Project overview](../README.md) | [Documentation](../docs/README.md)

This directory packages the shared `web/` terminal for Android and iOS. The UI,
Management v1 protocol, and Reliable UART v1 implementation remain shared; only
the BLE transport is native.

## Touch terminal keys

The terminal has a two-row accessory keyboard on phones and tablets. Keyboard,
Esc, Tab and Shift/Ctrl/Alt stay on the left; the right side scrolls through an
inverted-T arrow cluster, Home/End, Paste, Enter, Page Up/Down, Backspace, symbols
and common Ctrl shortcuts. Tap a modifier before the next key; tap again to
cancel. Modifiers reset after use or disconnect. For example, Ctrl then C sends
an interrupt, Shift + Tab sends reverse Tab, and Alt + B moves back a word in
shells that support it. Paste uses the clipboard when available and otherwise
prompts you to long-press the terminal. Both rows stay above the soft keyboard
and are shared with the Web and HarmonyOS clients.

## About page

Settings -> **About** lists the open-source components the web and mobile builds
ship (versions and licences taken from the installed tree, not from the
`package.json` ranges), the firmware stack pinned by `west.yml`, the CC-BY-4.0
cursor attribution with its author and statement of changes, this project's
Apache-2.0 licence, and the contributors.

The component data is generated into `web/about-data.js`:

```sh
node tools/gen_about.mjs
```

Run it after changing dependencies. `mobile/test/about.test.mjs` regenerates the
data in memory and fails when the committed file differs, so a bumped package
cannot ship an About page that names the old version. Contributors are curated in
the generator: the real source is `git shortlog`, but CI checks out with depth 1.

## Built-in serial assistant (Pi)

Tap **AI** in the terminal toolbar to enter Agent mode. Narrow windows show the
terminal above the conversation. When the workspace has at least 960 CSS pixels
of available width, the terminal and conversation sit side by side. Resizing or
rotating the window adapts the layout without recreating the terminal or clearing
its logs. Terminal keys and the conversation remain independently usable.
Desktop Agent mode keeps the surrounding toolbar and the settings sidebar in
their original positions, including its expanded/collapsed state. Agent settings
opens that same sidebar. Touch devices and narrow windows use a settings sheet
over the compact Agent workspace.

When a soft keyboard opens while editing an AI question or model setting, the
terminal collapses to a **Show terminal** button. Dismissing the keyboard restores
the split. **Show terminal** moves input back to the UART and restores its shortcut
keys; received logs continue to accumulate while the terminal is collapsed.
**Exit** (or tapping **AI** again) returns to the terminal workspace and cancels
the active agent run. Entering Agent mode from terminal fullscreen exits fullscreen
so both panes are visible. These viewport behaviors need real-device verification
in addition to the browser regression tests.

Open **Settings → AI** in the main controls panel (also available through
**Settings** in the Agent header, without leaving the conversation).
Start with the **AI provider** list — OpenAI, Anthropic, Google Gemini, DeepSeek,
Moonshot Kimi, Zhipu GLM, Alibaba Cloud Bailian (Qwen), SiliconFlow, Volcengine
Ark (Doubao), Groq, OpenRouter, Mistral, xAI, or Ollama on this machine. Choosing
one fills the base URL, the protocol and a starting model ID; every field stays
editable, the model is only a suggestion, and **Custom** changes nothing so an
endpoint can be typed by hand. Then add your own API key (optional for keyless
local services) and select **Save configuration**.

Because provider model IDs churn, **Fetch model list** reads the list the service
currently offers, using the address, key and extra headers already in the form.
The ids become suggestions in the model field, which stays editable — a service
may not expose the endpoint, and a browser request can be blocked (CORS), in
which case the panel says so and keeps what you typed. Saving does not
send a model request. Endpoint, model and API key are restored after reloading
or restarting the app. Re-saving unchanged settings retains the current diagnostic
conversation; changing the endpoint, model or key resets its model context.
**Clear configuration** removes all three from this device.
The same panel selects the provider protocol — `openai-completions` (default,
covers OpenAI-compatible services), `anthropic-messages` or
`google-generative-ai` — and, optionally, a context window, an output token limit
and a reasoning level (`off` by default). Leave the numeric fields empty to use
the adapter defaults; an unsupported combination fails the request with the
provider's own error rather than silently changing the setting. Extra request
headers can be added one `Name: value` per line, which is how providers that need
a browser-access opt-in or an API version are configured.
Ask a question such as “Why did this board fail to
boot?” The app runs the Pi agent loop locally; model inference uses the configured
service. This is not an on-device/offline language model.

The implementation uses pi-mono's `@earendil-works/pi-agent-core` and `pi-ai`,
at the versions pinned in `package-lock.json`. It exposes these tools:

- `read_web_page`: reads an HTTP(S) text page and returns text plus links, without
  cookies or model credentials. Limited to 512 KiB per response, 16,000 characters
  of extracted text, and 15 seconds. Web content is untrusted evidence. Browser
  CORS/mixed-content rules still apply; this is not a search engine or binary
  download manager. When blocked, the agent may use an available target shell's
  `curl`/`wget` under the selected execution mode. Such downloads land on the
  target, not the phone or desktop. Downloading does not authorize flashing.

- `read_serial_log`: first reads the recent tail, then continues from its cursor.
  Use `recent: true` to reread the tail or `after` for an explicit range.
- `read_target_file`: pages through one target file (1 KiB per call by default)
  instead of `cat`, which floods the console. Results are wrapped in whole-line
  `LINKR_FILE:begin/end` markers so prompt echo cannot be mistaken for file
  content, and missing, directory, relative-path, permission and non-regular-file
  cases have distinct errors. It appears only after a probe shows the target has
  `dd` or `base64`, so the model is never offered a tool the board cannot run.
- `watch_serial_output`: watches the console for a bounded window and returns
  matching crash and boot-loop lines with their offsets, rather than a full log
  dump. It is still a foreground tool the model must call; there is no unattended
  background monitor.
- `get_device_status`: connection, transport, UART settings, execution mode and
  passive console-state hints, without WiFi credentials.
- `send_serial_input`: submits exact serial input under the selected execution mode.
- `wait_for_serial_output`: collects output until a quiet interval (400 ms by
  default) or a deadline; reports settled output, continued streaming or silence.
- `inspect_serial_execution`: waits for output to settle and retrieves a send
  record. Default evidence is its latest tail; `after` / `limit` page through
  earlier output, with `observedCursor` / `hasMore` indicating the next page.

Read-only tools run in parallel; every tool that changes the target or writes to
the console runs sequentially, so two commands never interleave on the UART. A
tool result longer than 16,000 characters is truncated and marked as truncated,
so one oversized output cannot consume the conversation's context.

The Agent header shows a compact gear selector with the current execution mode.
Tap it to open the vertical **M → A → F** gear track, then tap a mode to engage
it and close the selector. Tapping outside or pressing Escape dismisses it without
changing modes. Arrow keys move focus; Enter or Space selects the focused mode.
The selector remains available when the soft keyboard is open.

Terminal, Agent, settings and the gear picker share their window chrome through
`web/window.css` (`window-surface` / `window-header`). Update the shared tokens
there to keep both themes, headers and controls consistent across window sizes.

| Mode | Serial input behavior |
| --- | --- |
| Full Auto | Sends routine commands directly for up to 15 minutes; recognized destructive commands and Always ask rules still require approval. |
| Auto (recommended, default) | Sends recognized low-risk queries at a detected shell prompt; asks for approval for everything else. |
| Manual | Shows proposed input and waits for the user to click Send. |

The app enforces Auto with an exact local allowlist, not the model's risk rating.
Examples include `pwd`, `uname -a`, `free -h`, `ip addr show`, and
`cat /proc/version`. Unrecognized commands, flags, arbitrary paths, compound
commands, control characters, and partial input require approval. A pending
terminal input line also requires approval; intervening terminal input invalidates
an outstanding send. This is a conservative shell-query classification, not a
sandbox: aliases, custom consoles and running programs can interpret input
differently. The current log tail must match a supported shell prompt (for example,
`root@board:~# `). Login/password prompts, U-Boot, panic output, custom/unrecognized
prompts and missing output require approval in Auto. Console hints are passive
heuristics, never proof that a shell is running. The assistant must still inspect
the logs. A console-state change also invalidates a pending approval.
All modes can read logs and device status automatically, and show submitted input
and results in the conversation. Switching modes stops the current run and cancels
pending input while retaining the same device's diagnostic conversation. Ask again
to continue with the new policy; interrupted requests are not replayed. Mode
selection stays in memory for this app session; restarting the app defaults to Auto.
The Pi adapter requires an execution inspection result to reach a subsequent model
turn before another serial input is allowed, including Full Auto. This adds no
confirmation dialog; it prevents the model from batching dependent inputs before
it has received the preceding observation. Unresolved output still needs judgment.

Logs come from the receive path, separately from local echo, management messages
and AI answers. New connections clear the previous assistant journal before
accepting device output, preserving logs received during BLE subscription. They
also clear the conversation. Disconnects retain received logs for diagnosis but
cancel ongoing work. The
journal retains at most 128 Ki UTF-16 code units. Terminal control sequences are
filtered continuously on receipt, so split packets, pages and buffer eviction do
not expose control-sequence fragments as diagnostic evidence. Cursors still refer
to the original UTF-16 offsets. Each question is limited to 32 model turns,
96 tool calls and 15 minutes. Exhausting an execution budget shows a stop
notice; a completed answer on the final allowed turn does not. The adapter bounds model context to 24,000
serialized characters by abbreviating older evidence and then replacing complete
tool exchanges with mechanical history excerpts. It retains the current question,
marks omitted evidence, and keeps tool calls paired with their results. Excerpts
are not verified conclusions or complete durable memory; retained log ranges can
be reread until the journal evicts them. Log reads without an explicit cursor
continue from the last page returned by a read or wait, including historical
pages; `recent: true` returns to the latest tail. This is a character budget,
not a model tokenizer measurement.
Interrupted model responses remain labelled text history; incomplete tool drafts
and their placeholder results are not replayed as provider tool messages.

The system prompt lives in `mobile/src/agent-prompt.mjs`. It distinguishes analysis
from requested repair, adapts diagnostics to the observed console and available
commands, and asks for hypotheses, evidence and verification of the original symptom.
Context management lives in `mobile/src/agent-context.mjs`; neither module changes
the device executor's approval rules.

Press **Stop** to cancel model requests, pending approvals and unsent input.
Already transmitted bytes cannot be recalled. To interrupt a running target
program, use Ctrl-C in the terminal. Sending bytes does not prove a command
completed; the assistant must inspect subsequent output before claiming success.
Closing the assistant, backgrounding the app or reaching the time limit also
cancels its current run. These interruptions preserve the conversation in memory
for the next question, after the cancelled run finishes settling. New conversations,
cleared logs, changed AI configuration and device connection changes reset the
model context. Switching apps while the Agent is idle also preserves the conversation.
Escape during IME composition only cancels the input candidate; it does not close
the Agent or its settings.

### Device execution layer

`web/device_executor.js` owns execution modes, single-use approvals, cancellation,
session/input checks and the last 50 execution records independently of Pi and
the DOM. `web/agent_panel.js` renders its state and forwards user decisions;
`mobile/src/pi-agent.mjs` adapts the device interface to Pi tools. Another model
SDK can use the same executor without implementing its own permission gate.

Each record keeps the exact wire text, device session, mode, timestamps and up to
4,000 UTF-16 code units from the latest subsequent output. Inspection can page
through the retained command range, bounded before another input or session change.
The UI and inspection tool distinguish
no output, observed output, a returned shell prompt, and interrupted observation.
Another serial input or device session ends the association with subsequent output.
Output can still include unsolicited device messages; this is an observation
window, not a command protocol or an exit-code measurement. The structured
`executionStatus` remains `unknown`; a returned prompt is not a success signal.
Partial/uncertain delivery is recorded and never automatically replayed by the
executor. No probing or verification command is silently added to the wire text.
If a fragmented BLE transfer is interrupted or its delivery cannot be confirmed,
the affected UART or management channel blocks further writes until disconnect
and reconnect; received logs remain available. This prevents a new command from
being consumed as the remainder of an old frame. Queued management requests and
individual fragments are also bound to their original connection. Only an explicit
first-fragment ATT size rejection can trigger a smaller-size retry.

Execution records stay in memory. New conversations, cleared logs and new device
connections reset them. Restarting the app does not restore approvals or replay
unfinished actions; durable task recovery is not implemented. The conversation
transcript is the one exception and is stored per device, as described below.

Questions and requested serial logs are sent to the configured model endpoint.
Endpoint, model ID and API key are saved in this app / browser origin's
`localStorage` under `linkr-agent-model`, in plaintext; this is not an encrypted
OS credential vault. The key is **not uploaded to Linkr Bee, this site or any
server** — the app has no cloud account or backend, so there is no cloud copy —
and a request carries it from this device directly to the provider you chose.
Clearing the configuration or app / site data removes it. A conversation is stored per
device identity alongside the task summaries, so reloading the page brings the
transcript back, labelled as unverified history, and continues the same model
context. Restoring it sends nothing to the target: no command is replayed. **New
conversation** clears it, and so does changing the model configuration. This is a
local snapshot, not an encrypted or server-side session.
Unsaved edits do not change the active configuration, and configuration is
locked while the Agent is running. Execution mode remains session-only and
starts in recommended Auto mode. No shared service key is included in the app.
The endpoint must allow requests from the app's WebView origin
(CORS), or be accessed through a trusted compatible proxy. Prefer HTTPS outside
a trusted local development network. Subscription/OAuth login and native
secure credential storage are not part of this integration.

Full Auto is time-boxed: it reverts to Auto after fifteen minutes with a visible
countdown on the mode label, re-selecting it extends the window, and an
unanswered approval is cancelled when it ends. Per device you can also keep a
command policy — entries that must always be confirmed (Full Auto included) and
exact commands that Auto mode may send unattended — from the history section;
it stays on the device and never reaches the model or an exported report.

Facts the assistant verified about a target — console quirks, the UART format
that works, tools that are missing — can be stored as device notes
(`remember_target_note`). They are kept per device identity, redacted like task
summaries, capped per device, shown in the panel where the user can delete them,
and returned to the assistant through `get_device_status.notes` on later
sessions. The panel also shows the tokens each conversation used and an
estimated cost when you enter the endpoint's prices (display-only, stored apart
from the model configuration), and exports the goal, plan, executions and notes
as a Markdown report.

The assistant can also read Linkr Bee's own diagnostics and change its UART
format, WiFi and WebDAV configuration over the encrypted management channel.
`get_accessory_diagnostics` is read-only; every change waits for one explicit
approval in the conversation, in every execution mode, and the result is the
accessory's own reply plus a follow-up read. A WiFi password travels only
through that tool: it never appears in the approval card, the task history or
the assistant's answer.

Android/iOS load the Pi runtime when first needed. HarmonyOS includes it in the
inlined ArkWeb bundle so rawfile imports work. Vite dev/production web builds
also include the assistant, and directly serving the unbuilt `web/` directory
loads the prebuilt bundle from `web/vendor/agent/` — rebuild it with
`tools/build_agent_bundle.sh` after changing the runtime or upgrading the SDK.

## Regression tests

```sh
cd mobile
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Browser tests start Vite and use the shipped xterm and a fake UART transport to
check terminal replies, focus reports, touch input, IME, paste, and soft-keyboard
layout in normal and fullscreen modes. Agent tests run the real Pi loop and
provider SDK against a mocked streaming model endpoint, checking log evidence,
input approval, console-state gating, execution evidence, mode-change continuity,
cancellation and session isolation. Unit tests also cover long-log compaction,
fragmented output collection and observation-before-input ordering. The device
executor also has SDK-independent unit tests. These tests do
not call a paid model.
`web/terminal_input.js` uses the bundled xterm core's input-source event because
the public `onData` API also emits protocol replies; run these tests when
updating xterm. To use an existing Chrome installation, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path.

## Build web assets

```sh
cd mobile
npm install
npm run build
```

The output is written to `mobile/dist/`. In a normal browser the build continues
to use Web Bluetooth. Inside Capacitor it uses
`@capacitor-community/bluetooth-le`.

The native plugin accepts one filter shape, so the app scans by the Linkr
Management Service. That finds every current board whatever name the owner
gave it, but an old NUS-only board (fixed `Linkr BLE UART...` name, no
Management Service) is deliberately out of scope on native: reach it with the
Web build in Chrome/Edge or with the desktop TUI/CLI, which can scan for both
shapes.

## Generate native projects

```sh
npm run cap:add:android
npm run cap:add:ios
npm run cap:sync
```

Android requires Android Studio and a current Android SDK. iOS requires Xcode
and must be tested on a real device because the iOS simulator has no BLE support.

The generated projects already contain the required platform declarations:

- Android declares Bluetooth scan/connect permissions and limits legacy location
  permissions to Android 11 and earlier.
- iOS declares Bluetooth and local-network usage descriptions and permits local
  networking for the optional LAN terminal.

If either native project is regenerated, verify that
`android/app/src/main/AndroidManifest.xml` and `ios/App/App/Info.plist` still
contain these project-specific declarations before building.

The relevant iOS keys are:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Connect to Linkr Bee Bluetooth serial accessories.</string>
<key>NSLocalNetworkUsageDescription</key>
<string>Connect to a Linkr Bee terminal over the local network.</string>
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

The first release is intentionally foreground-only. Do not add iOS
`bluetooth-central` background mode until disconnect/reconnect and power behavior
have been tested on real hardware.

For a new host on C3/C5, hold GPIO1 to GND before connecting and accept OS
pairing. WROOM ships with pairing authorization disabled, so no GPIO4 press is
needed; GPIO4 is used only when
`CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=y`. Android checks the existing bond
and creates one only when absent; iOS handles pairing on encrypted GATT reads.
Existing bonds reconnect without the pairing GPIO.
See [pairing and recovery](../docs/BLE_PAIRING.md) for lost keys, the eight-host
limit, factory reset, and required real-device acceptance checks.

### Long-running shell tasks

The agent can use `run_shell_command` for standalone POSIX-shell commands. The
exact `sh -c` wrapper is subject to the current approval mode; subshell directory
and environment changes do not persist. A unique, newline-terminated exit marker
provides an observed exit code. Terminal echo, silence and prompt detection do
not count as completion, and exit zero still requires a separate goal check.

`monitor_serial_execution` observes the same execution id for up to 60 seconds,
including silent periods. It can be called again after an unresolved timeout.
Each question is bounded by 32 model turns, 96 tool calls and 15 minutes. Stop,
backgrounding and disconnect still cancel observation; they do not stop a target
process or authorize replay. Interactive consoles retain `send_serial_input`.

### Download destinations and verification

Downloads have separate tools and visible destinations:

- `probe_download_tools` probes the target for curl/wget and sha256sum/shasum/openssl.
  A successful, inspected probe from the current question is required by
  `download_to_target`; absence of tools is reported rather than assumed away.
- `download_to_target` requires an absolute target file path, reports native tool
  progress and SHA-256/byte-count evidence, and refuses to overwrite an existing
  destination. It downloads into a temporary file next to that path, checks an
  optional expected SHA-256, then publishes the destination. Failed transfers or
  mismatches can retain a `.part.*` file; its path is printed in serial evidence.
- `download_to_computer` shows a save card in the app. A user gesture chooses a
  file when the File System Access API is available; otherwise the checked bytes
  are offered through an explicit browser download link. Byte progress and
  SHA-256 are shown. No cookies/model credentials are sent to the file host.
  Browser CORS rules apply and this buffered path is limited to 128 MiB. The
  browser does not expose absolute local paths; fallback saves are reported as
  requested, not confirmed disk writes. Native WebView saving is not yet tested.

If destination is ambiguous, the agent must ask before downloading. A computed
hash without a trusted expected hash is labelled computed-only. After a download
starts, subsequent serial sends/downloads are blocked for that question: only
observation and reporting continue. Installing or flashing requires a new user
instruction. Cancellation stops local retrieval or target observation; it does
not silently kill a running target download.
