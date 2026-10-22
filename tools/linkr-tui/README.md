# bee — the host terminal for Linkr Bee

[Project overview](../../README.md) | [Documentation](../../docs/README.md) | [Web/mobile user guide](../../docs/USAGE.md)

A cross-platform host client for the Linkr Bee bridge: one binary, a CLI and a
TUI over a shared core. This crate is a **from-scratch rebuild** of the TUI that
PR #9 carried, built against the same interface design and the same web-client
palette, but structured so that every screen is testable without a terminal.

## Why a rebuild and not a patch

The previous TUI grew to ~55k lines across 48 files, and its review never
converged: defects kept surfacing in the hand-built panel skeleton and in the
protocol code that was rewritten module by module. The design was fine; the
structure was not. This crate keeps the design and starts the code again with
three rules:

1. **A frame is a pure function of state.** `ui::*` reads `&App`; nothing else
   mutates a widget during a draw. The same state always paints the same bytes,
   which a test asserts directly.
2. **Content and placement are separate.** Each region builds its content as
   plain `Line`s from a pure function; one thin layer places them. A test can
   therefore check a sidebar row, a bar or a toast without a terminal, and check
   the layout without re-testing the content.
3. **No literal colours in a view.** Every colour comes from `theme::Theme`,
   which carries the web client's design tokens. Views ask for a *role*
   (`accent`, `muted`, `danger`…), never for a hex value and never "is this the
   light theme?".

## What is built so far

| Module | What it holds |
|---|---|
| `theme.rs` | The design system: 16 tokens × two themes (the web client's `:root` and `[data-theme="light"]`, terminal pair from xterm.js), and every role-based style, block and colour helper |
| `event.rs` | `ConnectionState`, `NoticeLevel`, `View` — and the F2–F5 rota, which is derived from the view list rather than written out twice |
| `i18n.rs` | Every user-visible string, in Chinese and English, in two `const` tables so a missing translation cannot compile |
| `text.rs` | Display-width text: pad, clip and wrap measured in *columns*, because a CJK glyph is two of them and `{:<14}` is not |
| `app.rs` | The state a frame needs and its transitions (view rota, theme toggle, bounded notices, clamped sidebar cursor, `ble_connected`) |
| `ui/mod.rs` | Layout (`regions`) and composition (`draw`), plus headless rendering for tests and `--print-frame` |
| `ui/chrome.rs` | Top bar (state dot, busy indicator, counters, speed, autoscroll, clock) and bottom bar (focus, view, state, key hints) |
| `ui/sidebar.rs` | The four sidebar sections, the accent-chip selection, and the display-width wrap that keeps a long row inside its column |
| `ui/body.rs` | The centre column: which view's content goes in it, and the frame that does or does not wrap it |
| `ui/legacy.rs` | The compatibility pass for the old Windows console: no synthetic bold, one-cell stand-ins for the ambiguous-width glyphs, and the margin the scrollbar sits over |
| `ui/toast.rs` | The notice stack in the top-right corner |
| `ui/overlay.rs` | The modal layer: where a palette or a dialog is measured and centred, and the only place that knows a `Rect` |
| `views/diagnostics.rs` | The `@i?` read, end to end: `@info` parsing, the six web-client formatters, the read's state machine, and the grid |
| `transport/` | The wire: `LinkKind` (stdio, BLE, LAN), a `Link` split into a reader and a writer because the two must run at once, `LinkEvent`, and the threads that join them. There is deliberately no serial link: the device *is* the far end of every one of these — see `transport/mod.rs` |
| `transport/stdio.rs` | The process bridge — `--bridge <command>` — and the built-in loopback device, so the whole path runs on a laptop with no radio |
| `session.rs` | `Dial` (what the command line asked for) and `Session`: the counters, the connection state, and the pump that folds the link's events into the frame |
| `vt/parser.rs` | The escape-sequence state machine: CSI, OSC, ESC, and the parameter list |
| `vt/screen.rs` | The screen itself: a styled cell grid with a cursor, erase, insert/delete, a scroll region, the alternate screen and a bounded scrollback |
| `vt/mod.rs` | The emulator over the screen: which private modes do what, the alternate screen, the title, and the few sequences a host must *answer* |
| `views/terminal.rs` | The pane: a streaming UTF-8 decoder and a streaming parser in front of the emulator, plus the painter |
| `palette.rs` | The `Ctrl+P` command palette: the actions, each one a function pointer so the palette runs the same code the chord does |
| `dialogs.rs` | Help, the notice log, the guarded-command confirmation, the prompts that ask for a file, a network name, a password or an upload URL, the About card and the component page behind it |
| `licenses.rs` | The third-party notice: the direct Rust dependencies the About window shows, the contributors, and the full generated `THIRD_PARTY_LICENSES.md` that `--licenses` prints |
| `protocol.rs` | The management service's framing: request and response headers, the version and capability handshake, the Reliable UART scheme, and the reassembler that puts a fragmented answer back together |
| `device.rs` | The request/response bookkeeping over that service: one question at a time, an answer claimed only by the id that asked for it, and a timeout that reports a slow bridge as slow rather than as silent |
| `accessory.rs` | The bridge's own settings as commands and as parsed data: `@u=…`, `@w=…`, `@d=…`, their limits, and the redaction that keeps a password off every screen but the wire |
| `cli.rs` | One table of flags read twice — as usage text and as a completion script for bash, zsh and fish — plus the scanner, the script runner, the escape-byte parser and the loopback test |
| `serve.rs` | The resident session: the request grammar, the one-link loop, and the begin/end frame a caller correlates its answers by |
| `trace.rs` | `--log-file` and `--debug-io`: what the device said, appended; what went both ways, traced. Secrets are redacted before they reach either |
| `views/network.rs` | The WiFi, WebDAV and BLE-name form: thirteen rows the keyboard walks, each action raising an approval card that names the change rather than the command |

`views/` is where a view lives: a *model* (what the device said, as plain data)
and a *painter* (a pure function from `&App` plus a pane width to lines). The
split is the reason a whole view can be pinned to the documented sample reply
without a socket, a clock or a terminal.

The terminal pane is the exception, and deliberately so: it is not a document
but a *screen*. A device paints with escape sequences — it moves the cursor,
colours the next glyph, erases a line and repaints one cell for a spinner — so
the pane emulates rather than lays out. `vt/` holds the emulator and
`views/terminal.rs` the wiring around it; the pane's size is told to the
emulator by the event loop, never by a paint, because a frame is a pure function
of the state and may not reshape what it is drawing.

### Text, and the bytes that are not

The wire carries bytes and the pane has to say what they are. It says UTF-8,
and only UTF-8: a device that prints UTF-8 — this bridge does, and so does a
Zephyr console built to — arrives as the text it sent, split across reads
however the radio felt like splitting it, and nothing else needs to be
guessed at. There is no encoding detection, because a heuristic that guesses
wrong turns one device's Chinese into another device's mojibake and says
nothing about it.

A byte that is not part of a valid UTF-8 character becomes `U+FFFD` (`�`),
one per bad byte, and the pane keeps the bytes either side of it: one glitch
must not swallow the rest of a burst. The count of those bytes is kept, and a
non-zero count shows up in two places — `乱码 nB` in the bottom bar, beside
the state, and one warning notice the first time it happens (`Ctrl+L` clears
the screen, which re-arms it). Both exist because the pane's `�` is the only
thing that shows the problem and it does not say *whose* problem it is: on a
serial dial the usual cause is a UART whose framing does not match what the
device is sending — read it with `--query-uart`, set it with
`--uart <baud>,<data>,<parity>,<stop>,<flow>` — and the other cause is a
device that is not speaking UTF-8 at all.

On the old console the `�` is replaced by `?` by the pass above, because
conhost draws `U+FFFD` two cells wide and one `�` per cell would shove the
rest of the row sideways. The count is the same either way; only the glyph
the console can draw differs.

Network is a live form: `@w?`/`@w scan` fill it, `@w=…` and `@d=…` are raised
as approval cards that name the change, and a scan's answer goes to its own list
rather than into the status slot.


Assistant is the next view, and behind it the agent layer.

The assistant receives a bounded, credential-redacted snapshot of the current
connection's serial output and saved device notes with each question. Local
echo and interface messages are excluded. Notes are historical evidence; they
do not replace checking the target's current state. Conversations and notes
are keyed by the link identity (BLE address, LAN host or stdio bridge), so moving
one Bee to another target still requires the operator to distinguish those
targets. Changing the link identity saves the old conversations and loads the
new device's history before another question is sent.

Model replies accept both SSE streams and complete JSON responses. Protocol
end markers finish a stream immediately; a stream that ends without a finish
marker or reason is reported as incomplete rather than saved as an answer.

Every management question — `@i?`, `@u?`, `@w?`, `@d?` — is asked on the
bridge's own GATT service and not down the pipe the target prints to. That is
not a preference: an answer delivered on the same stream as the target's output
can be told apart from it only by guessing at the shape of the bytes, and a
guess that fails types the bridge's answer into somebody's shell prompt.

## Asking the bridge things from a shell

Everything the terminal can do to the bridge can also be done and exited:

```sh
cargo run -- --ble-name Linkr --query-info --query-uart --json
cargo run -- --ble-name Linkr --uart 921600,8,n,1,none
cargo run -- --ble-name Linkr --wifi BenchNet --wifi-key-file ~/.wifi
cargo run -- --ble-name Linkr --wifi-scan --loopback-test --no-terminal
cargo run -- --ble-name Linkr --query-ble-name --json
cargo run -- --ble-name Linkr --rename-ble "测试😀" --json
cargo run -- --ble-name Linkr --reset-ble-name --json
cargo run -- --print-completion zsh
cargo run -- --scan --timeout 5
cargo run -- --ble-name Linkr --serve
```

The advertised BLE name has an entry in the terminal as well: the network view
carries the current name, *Rename*, *Restore default* and *Read name*. A name
is 1–29 UTF-8 bytes; the prompt checks it in the firmware's own units before a
card asks for approval, so Chinese and emoji are accepted and a name the board
would refuse never leaves the host. The write is confirmed by the board and
read back, and the row then says whether the name is the MAC-derived default
or a custom one.

`--no-terminal` is implied by any flag that asks for something: a command line
naming `--query-info` wants an answer, not an interface. Each request is sent
and waited for rather than fired off together, because the bridge answers one
question at a time and two outstanding ones would have two `OK`s arriving in no
order anyone can rely on. `--wifi-scan` is given the long timeout on its own: a
scan is the board's radio working through every channel, and the ordinary reply
timeout would call a running scan a silent bridge.

`--loopback-test` is the one check that proves the round trip. Everything else
is answered by the bridge, so a board that accepts writes and never sends
anything looks healthy to all of them; the loopback is answered by the target's
own UART with its TX and RX joined.

`--log-file` appends what the device sent, and `--debug-io` traces both
directions on stderr. Neither is buffered, because a log missing its last line
is a log missing exactly the moment that mattered — and a management command is
traced redacted, since stderr is scrollback, a terminal recording or a CI log.

`--escape` reserves one byte for "stop" (`^]` by default, as `0x1d`, or the
byte itself). A byte stream has no out-of-band signal, so the reservation has to
be a byte — and it is checked *before* the keystroke is sent, because sending it
and then leaving would put a stray control character into the device's input.
`--line-mode` holds a typed line until Enter, which is what a target with a line
discipline wants, and `--enter` names what Enter actually puts on the wire
(`raw`, `cr`, `lf`, `crlf`) — a target that wants `\r` and is given `\n`
simply never answers, and the symptom looks exactly like a dead link.

## Licences and third-party components

`About` (`L`) lists the direct Rust crates the build resolves, their licences and
the project's contributors, and points at the full notice. The feature-resolved
normal-dependency closure is generated from `Cargo.lock`, `cargo metadata` and
`cargo tree` into `THIRD_PARTY_LICENSES.md`, which is shipped in every archive
and printed without a terminal:

```sh
bee --licenses
```

The notice carries the complete licence text for every component, not just an
SPDX identifier: licence files are read from the fetched crate sources, and the
few packages that omitted one get the standard text with the package's authors.
The generator is `dev/gen-licenses.py`; CI runs it with `--check`, so a
dependency bump that forgets to regenerate the notice fails the gates instead
of shipping a stale page. The list is the union across targets Cargo resolves,
so a crate used only on another platform is attributed too. Build and
development dependencies are deliberately not listed: they are outside the
normal-dependency closure.

## Keeping a session open

`--serve` holds one link and answers requests on standard input, one JSON object
a line, until the input ends — which is what a program with a dozen things to ask
wants, because every command line pays for the dial again and on Bluetooth the
dial is seconds:

```console
$ bee --ble-name Linkr --serve
{"event":"ready","program":"bee","version":"0.1.2","link":"ble:name:Linkr",
 "ops":["info","uart","wifi","wifi-off","wifi-scan","webdav","webdav-off",
        "ble-name","lan","exec","loopback-test","state","quit"]}
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

Every request is framed by a `begin` naming the `id` it was sent with and an
`end` carrying the exit code its one-shot equivalent would have had, so a caller
that has several requests in flight can tell the answers apart without counting
lines; between the two come the same events the corresponding `--json` command
line prints. `id` is echoed, not required. `"format":"text"` on a request gets
the events the text output would have printed instead; the frame lines stay JSON
either way.

The operations are the request flags, spelled as JSON: `info`, `uart` (a
`"value"` like `"921600,8,n,1,none"` writes, none reads), `wifi` (an `"ssid"`
and optional `"pass"` write, none reads), `wifi-off`, `wifi-scan`, `webdav` (a
`"url"` writes, none reads), `webdav-off`, `ble-name` (a `"name"` writes,
`"default": true` restores the MAC-derived name, neither reads), `lan`, `exec` (`"cmd"`, and optional
`"timeout_ms"`, `"idle_ms"`, `"retry"`), `loopback-test` (`"data"`, and optional
`"timeout_ms"`), `state` and `quit`. WebDAV is part of the protocol even though
a particular firmware build may leave it out (the ESP32-WROOM build disables it
for DRAM); that board answers the request with its own error, and the host
reports the error instead of hiding the operation. Nothing needs the link until
a request that does: `state`, `quit` and a line that is not a request are answered without one,
and the first request that needs a board dials it once and keeps it. A dial that
cannot be made answers `{"event":"error","code":"not_connected"}` with the code
`255` and leaves the session up, so a caller can wait for the board and ask
again; a line that is not a request, or an operation this build does not answer,
is `bad_request` with the code `2`, and the session keeps reading. End of input
is the caller hanging up, and the session exits `0`.

## Gates — all four must pass before a commit

```sh
python3 dev/gen-licenses.py --check                 # the licence page is current
cargo fmt --check                                   # style
cargo clippy --all-targets -- -D warnings           # lints, warnings are errors
cargo test                                          # headless
cargo clippy --all-targets --no-default-features --features cli -- -D warnings
cargo test --no-default-features --features cli     # the CLI face gets its own pass
cargo clippy --all-targets --no-default-features --features tui -- -D warnings
cargo test --no-default-features --features tui     # and so does the interface alone
for t in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu \
         i686-unknown-linux-gnu armv7-unknown-linux-gnueabihf \
         x86_64-pc-windows-msvc x86_64-pc-windows-gnu i686-pc-windows-gnu \
         aarch64-pc-windows-msvc x86_64-apple-darwin aarch64-apple-darwin; do
  cargo check --target "$t" --all-targets || exit 1  # 10 targets, cross-platform
done
```

Every target is checked because the crate ships to Linux, macOS and Windows on
x86-64 and ARM, and to 32-bit x86 as well. On Linux the Bluetooth link goes
through BlueZ over libdbus — the one library outside glibc's base set that a
binary needs, and the one the `.deb` declares.

The toolchain is declared, not assumed: `rust-toolchain.toml` names the channel,
the `clippy`/`rustfmt` components and those ten targets, so rustup installs
exactly what the gates need and a laptop, CI and the packaging script cannot
disagree about the compiler.

## Looking at a frame without a terminal

```sh
cargo run -- --print-frame 100x30                     # plain text
cargo run -- --print-frame 100x30 --ansi              # with true-colour escapes
cargo run -- --print-frame 100x30 --ansi --theme light --lang en
cargo run -- --print-frame 100x30 --ansi --transport ble   # transport reported as locked
cargo run -- --print-frame 110x32 --view diagnostics --state connected --sample
cargo run -- --print-frame 110x32 --overlay palette   # palette, help, notices, confirm, settings, about, licenses, splash
cargo run -- --print-frame 110x32 --feed $'\e[31mred\e[0m ok'   # the emulator, no device
```

`--view` opens on a named view, `--state` previews a connection state, and
`--sample` loads the documented `@info` reply, so a content view can be inspected
with real data instead of its empty state. `--overlay` opens the modal layer, and
`--feed` pushes text through the pane's own decoder and parser — escapes
included — which is how the emulator is reviewed with no device attached. All of
them are previews of *state*: `--print-frame` draws one frame and exits without
dialling, so a preview cannot start a session behind the user's back.

The frame is rendered through ratatui's test backend, so this works over SSH,
in CI, and with no TTY at all. `dev/frame-to-html.py` turns an `--ansi` dump
into a standalone HTML preview with exact column alignment (wide CJK glyphs span
two columns), and `dev/overlay-sheet.py` runs the real binary once per surface to
put a whole set on one page — `--sheet overlays` for the modal layer, `--sheet
vt` for the emulator:

```sh
python3 dev/overlay-sheet.py /tmp/vt.html --sheet vt --lang zh --theme dark
```

The previews are generated on demand and deliberately not committed: they are
large, and everything in them is reproducible from the source.

## Releasing

`dev/package.sh <target>` builds the release binary and lays the archive out —
the binary, the guide for that face (`README.md` here, or `README-cli.md` for a
CLI build), the licence and `THIRD_PARTY_LICENSES.md` — in the format the target's platform
reaches for: a `.zip` on Windows, a `.dmg` **and** a `.tar.gz` on macOS (a volume
image is a heavy thing to mount on a machine that only wants the binary), a
`.tar.gz` on Linux. The Linux packages are `dev/package-deb.sh <target>`, in the
four Debian architectures the crate ships to: `amd64`, `arm64`, `armhf`, `i386`.
The scripts are the *only* definition of those layouts: the CI matrix and a
developer's shell call the same ones, so a release cannot be assembled two ways.
A `--cli` before the target packs the same program built without the interface,
as `linkr-bee-cli-<version>-<target>.<ext>` — the archive an agent harness is handed,
and the smaller of the two. Every path written is printed, one per line.

```sh
cd tools/linkr-tui
dev/package.sh x86_64-unknown-linux-gnu           # → dist/linkr-bee-0.1.2-x86_64-unknown-linux-gnu.tar.gz
dev/package.sh --cli x86_64-pc-windows-gnu        # → dist/linkr-bee-cli-0.1.2-x86_64-pc-windows-gnu.zip
dev/package-deb.sh armv7-unknown-linux-gnueabihf  # → dist/linkr-bee_0.1.2_armhf.deb
```

A Linux target other than the host links *that* target's libdbus, which is not
in the runner's sources for ARM or i386: `dev/stage-cross-dbus.sh <target>`
fetches the matching packages, unpacks them and prints the environment the build
wants (`PKG_CONFIG_LIBDIR` and the cargo target's `RUSTFLAGS`), in the shape CI
appends to `$GITHUB_ENV`.

`.github/workflows/linkr-tui.yml` runs the gates, then packages both faces of all
ten targets — Linux on x86-64, ARM64, ARMv7 and i386 as tarballs and `.deb`s,
Windows on both ABIs and both architectures as `.zip`s, macOS on both
architectures as `.dmg`s and tarballs — and on a `linkr-tui-v<version>` tag it
attaches them all, with a `SHA256SUMS`. Every archive is read back entry by entry
before it is uploaded, and the archives for the host's own targets are *executed*
(`--version`, one frame or one loopback exec, a resident session answering one
request, and a bridge to a missing program that must exit `2`), because linking
is not the same as running. The tag is namespaced so it cannot collide with the
firmware's `v*` releases.

## Deliberate differences from the previous TUI

- **The theme is passed, not global.** The old code kept the palette in a
  `static RwLock`. Here `&Theme` flows into every render function, so tests can
  paint either theme with no shared state and a repaint can never observe a
  half-changed palette.
- **Wrapping is ours.** A row too wide for its column is wrapped by display
  width, with a break at whitespace when there is one and between glyphs when
  there is not — Chinese has no spaces, and the old panel ran off the column
  instead of wrapping. The arithmetic lives once, in `text.rs`, because a second
  copy is how two views come to disagree about what a column is.
- **A body is told how wide its pane is and never paints past it.** Every line
  goes through a width-aware path, so a message that would wrap in a narrow pane
  is clipped instead — a wrapped body line shifts every row below it and stops
  the frame matching its own layout. A test walks every view at six widths.
- **The sidebar cursor is clamped by the state**, and a test pins the cursor's
  range to the rows the sidebar actually offers, so the two cannot drift.
- **The status dot is filled whenever there is anything to report** (connected,
  dialling, failed) and hollow only at rest, which is what the design's frames
  show; the colour carries which state it is.
- **The emulator is ours, because upstream has none.** The web client hands its
  terminal pane to a bundled xterm.js, so there is no emulator in this repository
  to port: `vt/` is written against the VT sequences and xterm's behaviour, and
  it is tested the way a screen can be tested — cells, cursor, scroll region,
  scrollback — rather than by comparing screenshots.
- **The device is answered, not just drawn.** `ESC [ 6 n` is a *blocking* read
  for the program that sends it and `CSI 18 t` is how a pager sizes itself, so
  the emulator generates those replies and the pump puts them back on the wire on
  the same tick. An emulator that only paints looks right until a program hangs.
- **The link is split, not guarded.** Reading and writing run on their own
  threads and hand the frame events over a channel, so a device that stops
  answering cannot freeze the keyboard, and a repaint never waits on a `read`.

## Layout constants

`ui::BAR_HEIGHT` (1 row) and `ui::SIDEBAR_WIDTH` (30 columns) are the only
numbers the composition knows. The sidebar yields width to the centre column
when a window is too narrow for both, so a small terminal shows the view rather
than a wall of sidebar.
