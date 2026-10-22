//! The Linkr Bee host terminal: a CLI and a TUI over one core.
//!
//! `main` does three things and nothing else: read the command line, set up or
//! hand over the terminal, and run the event loop. Everything else lives in the
//! library so it can be tested without a TTY.

#[cfg(feature = "tui")]
use std::io::Stdout;
use std::io::{self, IsTerminal};

// Only the build with a renderer installs a panic hook: a CLI build that fails
// prints its own error and exits, and a hook that restored a terminal nobody
// took over would be a hook doing nothing.
#[cfg(feature = "tui")]
use std::panic;
use std::path::PathBuf;
use std::time::Duration;

#[cfg(any(feature = "tui", test))]
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
// The terminal's own half of crossterm — reading events, taking the screen,
// raw mode, enhancement flags. A CLI-only build never does any of it, so the
// imports say so rather than sitting unused.
#[cfg(feature = "tui")]
use crossterm::event::{self, Event, KeyEventKind};
#[cfg(feature = "tui")]
use crossterm::event::{DisableBracketedPaste, EnableBracketedPaste};
#[cfg(feature = "tui")]
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
#[cfg(feature = "tui")]
use crossterm::event::{
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
#[cfg(feature = "tui")]
use crossterm::execute;
#[cfg(feature = "tui")]
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
#[cfg(feature = "tui")]
use ratatui::backend::CrosstermBackend;
#[cfg(any(feature = "tui", test))]
use ratatui::layout::Position;
use ratatui::layout::Rect;
#[cfg(feature = "tui")]
use ratatui::Terminal;

#[cfg(any(feature = "tui", test))]
use linkr_tui::app::Focus;
use linkr_tui::app::{App, Transport};
use linkr_tui::cli;
use linkr_tui::device;
use linkr_tui::event::{ConnectionState, View};
use linkr_tui::i18n::Lang;
use linkr_tui::lan_token_store::{self, TokenStore};
use linkr_tui::licenses;
use linkr_tui::serial::keys::EnterMode;
#[cfg(any(feature = "tui", test))]
use linkr_tui::serial::keys::{self, KeyModifiers as TerminalModifiers};
use linkr_tui::session::Dial;
use linkr_tui::settings::{Settings, SettingsStore};
use linkr_tui::theme::ThemeChoice;
use linkr_tui::transport::ble::Selection;
use linkr_tui::ui;
use linkr_tui::views;
use linkr_tui::{dialogs, palette};

#[cfg(feature = "tui")]
mod console;

/// How often a frame is repainted with no input: the clock and the busy
/// indicator move on this beat, and it is slow enough to cost nothing.
/// The interface's beat. Only the build with a renderer pings it: the CLI half
/// ends without a loop, so a tick constant there is a constant nobody reads.
#[cfg(feature = "tui")]
const TICK: Duration = Duration::from_millis(250);

/// What the tool is and does, in the first line of the help.
///
/// One line, because help is read at a glance: every option below it is the
/// long answer, and this is the short one — what the program is, what it can
/// be asked to do — a person needs to know they have opened the right one.
#[cfg(feature = "tui")]
const ABOUT: &str = "Run a Linkr Bee wireless serial bridge: scan for a board, query and configure it, run shell commands on its target, or open its terminal";

/// The same line for a build with no interface: it says what this one can be
/// asked for rather than promising a terminal it cannot open.
#[cfg(not(feature = "tui"))]
const ABOUT: &str = "Run a Linkr Bee wireless serial bridge: scan for a board, query and configure it, or run shell commands on its target";

/// The help text, generated from the one table `cli` keeps.
///
/// It used to be written out here by hand, which is how a flag comes to exist
/// in the parser but not in the help — the last flag added is the one nobody
/// can find out about.
fn usage(prog: &str) -> String {
    cli::usage(prog, ABOUT)
}

/// A modal to open on, so `--print-frame` can show one without a TTY.
///
/// The same reason `--view` exists: a surface that can only be looked at by
/// running the TUI cannot be reviewed, diffed or put in a test — and the modal
/// layer is exactly the kind of thing that looks right until it is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverlayPreview {
    Palette,
    Help,
    Notices,
    Confirm,
    /// The prompt the network form's SSID row opens, so the text field and its
    /// caret can be looked at without a device — which is the only way to look
    /// at a dialog that is normally raised to *do* something.
    WifiSsid,
    /// The WebDAV URL prompt, for the same reason.
    WebdavUrl,
    /// The assistant's settings: fields, a note list and a caret that has
    /// nowhere else to be looked at.
    Settings,
    /// The card about the program, whose mark depends on the frame's capability
    /// — the one surface that can only be reviewed with a frame to render in.
    About,
    /// The component page: the direct crates, the transitive count and the
    /// contributors, previewable like every other modal.
    Licenses,
    /// The startup splash, held open so a frame can show it: normally it is
    /// gone a moment after the first paint, and no flag can catch it in time.
    Splash,
}

impl OverlayPreview {
    /// The modal a name refers to. An unknown name gives `None`, so a caller
    /// can report the bad value instead of quietly showing nothing.
    fn from_name(name: &str) -> Option<OverlayPreview> {
        match name.trim().to_ascii_lowercase().as_str() {
            "palette" => Some(OverlayPreview::Palette),
            "help" => Some(OverlayPreview::Help),
            "notices" => Some(OverlayPreview::Notices),
            "confirm" => Some(OverlayPreview::Confirm),
            "wifi" => Some(OverlayPreview::WifiSsid),
            "webdav" => Some(OverlayPreview::WebdavUrl),
            "settings" => Some(OverlayPreview::Settings),
            "about" => Some(OverlayPreview::About),
            "licenses" => Some(OverlayPreview::Licenses),
            "splash" => Some(OverlayPreview::Splash),
            _ => None,
        }
    }

    /// Raise this modal on `app`, through the same doors the real keystrokes use.
    ///
    /// One function rather than a `match` in the run loop and another in the
    /// tests: a preview that opens a window a differently is a preview of
    /// something the user will never meet.
    fn raise(self, app: &mut App) {
        match self {
            OverlayPreview::Palette => palette::open(app),
            OverlayPreview::Help => dialogs::open_help(app),
            OverlayPreview::Notices => dialogs::open_notices(app),
            OverlayPreview::Confirm => {
                // The guarded preset this build ships, so the preview shows the
                // confirmation the user will really meet.
                let command = app
                    .quick_send
                    .last()
                    .map_or_else(|| "reboot".to_string(), |quick| quick.command.clone());
                dialogs::ask(app, dialogs::ConfirmAction::Send(command));
            }
            OverlayPreview::WifiSsid => dialogs::prompt_wifi_ssid(app),
            OverlayPreview::WebdavUrl => dialogs::prompt_webdav_url(app),
            // On the endpoint, which is the row a first-time user lands on.
            OverlayPreview::Settings => {
                views::assistant::open_settings(app, views::assistant::AgentField::Endpoint);
            }
            OverlayPreview::About => dialogs::open_about(app),
            OverlayPreview::Licenses => dialogs::open_licenses(app),
            // Held for an hour rather than a moment: a preview has to be
            // looking at the splash when the frame is printed, and the clock
            // that would have taken it down is not running yet. Any key still
            // ends it, so the interactive preview behaves like a launch.
            OverlayPreview::Splash => {
                app.splash_until = Some(std::time::Instant::now() + Duration::from_secs(3600));
            }
        }
    }
}

/// What the command line asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Args {
    /// Only when the flag named one: a flag is a fact about this run, and the
    /// settings file fills the gap when it did not.
    lang: Option<Lang>,
    theme: Option<ThemeChoice>,
    /// The previewed connection state, when the command line named one. Left
    /// unset so the default can depend on what else was asked for.
    state: Option<ConnectionState>,
    /// The view to open on, when the command line named one.
    view: Option<View>,
    /// Print the third-party components and exit, without opening anything.
    licenses: bool,
    print_frame: Option<(u16, u16)>,
    /// Dump the frame with true-colour escapes instead of plain text.
    ansi: bool,
    /// Load the documented sample reply, so an inspection shows content.
    sample: bool,
    /// A transport pinned on the command line: the sidebar then says `locked`,
    /// because the keyboard cannot switch what the flag decided.
    transport: Option<Transport>,
    /// The process bridge to dial, as `--bridge` names it.
    bridge: Option<String>,
    /// The advertised name of the board to look for, as `--ble-name` gives
    /// it. A label the owner can change, so it selects a board and never
    /// identifies one: the address does that.
    ble_name: Option<String>,
    /// The address of the board to dial, as `--ble-address` gives it. This
    /// wins over a name when both are given: a name finds a board *like* the
    /// one meant, and an address finds it.
    ble_address: Option<String>,
    /// The LAN bridge to dial, as `--lan-host` names it.
    lan_host: Option<String>,
    /// The token that bridge is to be given, as `--lan-token` names it.
    lan_token: Option<String>,
    /// A file that token is read from instead, for a token that would
    /// otherwise be visible to anyone who can read another user's processes.
    lan_token_file: Option<PathBuf>,
    /// The modal to open on, for inspection.
    overlay: Option<OverlayPreview>,
    /// Text handed to the terminal pane before the frame is drawn, for
    /// inspection: the emulator is the one view whose content comes from the
    /// wire, so without this it cannot be looked at without a device.
    feed: Option<String>,
    /// List the nearby boards and stop.
    scan: bool,
    /// How long a scan listens and how long a command may run, when the
    /// command line named one with `--timeout`: one number for both, because
    /// the two reads are the same request for patience, and one word with two
    /// flags is how a script comes to set the wrong one.
    timeout: Option<Duration>,
    /// `--connect-timeout`, when the command line named one: how long a
    /// dialled link gets to come up, and how long a script run waits for it.
    connect_timeout: Option<Duration>,
    /// Connect, do what was asked, hang up — no terminal is taken over.
    no_terminal: bool,
    /// Run the asked-for commands first, then take the terminal over. The
    /// middle of the three modes, and the one nothing had a way to ask for:
    /// the command line either exited when it was done or never ran anything.
    cli_then_tui: bool,
    /// Hold the link open and answer requests until the input ends. The
    /// resident-session mode: one dial, many questions, for a caller that
    /// works through a problem instead of asking one thing.
    serve: bool,
    /// Report what happened as JSON lines rather than as sentences.
    json: bool,
    /// Say nothing on stderr that is not an error.
    quiet: bool,
    /// What the bridge was asked to do or report, when it was asked anything.
    requests: cli::Requests,
    /// The command `--exec` asked the target to run.
    exec: Option<String>,
    /// `--idle`'s window: the ending where quiet means finished. `None` means
    /// the marker ending, which is the default.
    exec_idle: Option<Duration>,
    /// `--rc-marker` was named. The marker is the default; naming it says so
    /// out loud, and naming both endings is refused rather than ranked.
    rc_marker: bool,
    /// `--retry`: how many times a timed-out command may be sent again.
    retry: u32,
    /// Print what `--exec` would send, and exit without touching a link.
    dry_run: bool,
    /// `--capabilities`: describe this tool and exit.
    capabilities: bool,
    /// A file the WiFi password is read from, so it never reaches `argv` —
    /// where every other process on the machine can see it.
    wifi_key_file: Option<PathBuf>,
    /// How the Enter key is sent on the wire. `None` means the command line
    /// did not name one, so the settings file's or the reference client's own
    /// default stands.
    enter: Option<EnterMode>,
    /// Echo what is typed into the pane, for a link that does not echo.
    local_echo: bool,
    /// Hold a typed line until Enter arrives, rather than sending it a key at
    /// a time.
    line_mode: bool,
    /// The byte that ends the session when it is typed: the wire's own "get me
    /// out of here", which has to exist because a byte stream has no other way
    /// to say it.
    escape: u8,
    /// Where every byte the device sends is appended.
    log_file: Option<PathBuf>,
    /// Whether both directions are traced to standard error.
    debug_io: bool,
    /// `--loopback-test`: send these bytes and require the same back.
    loopback: Option<String>,
    /// How long that echo is waited for.
    loopback_timeout: Duration,
    /// `--link-state`: print what this link and its counters are doing, as the
    /// session's `state` request reports it — the one reading answered without
    /// asking the bridge anything, so it still says something when the bridge
    /// is what has gone quiet.
    link_state: bool,
    /// `--doctor`: one checkup of the whole run — the link, the bridge
    /// describing itself, the UART round trip, and the target's shell — with a
    /// word for each finding. See `linkr_tui::doctor`.
    doctor: bool,
    /// `--send`: forward standard input to the target without waiting for an
    /// ending. The framing is the value: `line` adds newlines, `raw` does not.
    send: Option<cli::Framing>,
}

impl Args {
    /// The link the command line asked to dial, if any, or the reason asking
    /// for it fails.
    ///
    /// Only a LAN dial can fail here: the token it was offered comes from one
    /// of four places and any of them may be unreadable or mis-shaped, which
    /// is worth saying before a socket is opened rather than after.
    ///
    /// `--bridge` wins over everything: a bridge is how a radio is reached
    /// today, and a command line that names two links is better read as "the
    /// bridge is the way in" than as an error.
    fn dial(&self) -> Result<Option<Dial>, String> {
        if let Some(command) = &self.bridge {
            return Ok(Some(Dial::Stdio(command.clone())));
        }
        if self.lan_host.is_some() || self.transport == Some(Transport::Lan) {
            return self.lan().map(Some);
        }
        Ok(self.ble())
    }

    /// The LAN dial, and the token it carries. The four places a token may
    /// come from are tried in [`lan_token_store::resolve`]'s order — the flag,
    /// the file, the environment, the store — so that what was typed beats
    /// what was remembered, and a bridge that never asked for a token gets
    /// none rather than a stale one from last year's board.
    fn lan(&self) -> Result<Dial, String> {
        let host = self.lan_host.clone().unwrap_or_default();
        let store = TokenStore::load();
        let token = lan_token_store::resolve(
            self.lan_token.as_deref(),
            self.lan_token_file.as_deref(),
            std::env::var(lan_token_store::TOKEN_ENV).ok().as_deref(),
            &store,
            &host,
        )?
        .map(|(token, _)| token);
        Ok(Dial::Lan { host, token })
    }

    /// The Bluetooth dial, when the command line asked for one.
    ///
    /// Reached in three ways, because a bench has three situations: the board
    /// is named (several are on the air and only one is wanted), it is
    /// addressed (a script dialling one specific MAC), or it is simply the
    /// only one advertising a serial service at all.
    fn ble(&self) -> Option<Dial> {
        let named = self.ble_name.is_some() || self.ble_address.is_some();
        if !named && self.transport != Some(Transport::Ble) {
            return None;
        }
        Some(Dial::Ble(
            if let Some(address) = &self.ble_address {
                Selection::Address(address.clone())
            } else if let Some(name) = &self.ble_name {
                Selection::Name(name.clone())
            } else {
                Selection::Any
            },
            self.connect_timeout,
        ))
    }

    /// How long a scan listens.
    ///
    /// Only the CLI asks: an interface launch scans on its own schedule, and
    /// this is the window a script gives the same scan.
    #[cfg(feature = "cli")]
    fn scan_window(&self) -> Duration {
        self.timeout.unwrap_or(cli::DEFAULT_SCAN_TIMEOUT)
    }

    /// How long a dialled link gets to come up: the window the link itself is
    /// given, and the window a script run waits for it.
    #[cfg(feature = "cli")]
    fn connect_window(&self) -> Duration {
        self.connect_timeout.unwrap_or(cli::DEFAULT_CONNECT_TIMEOUT)
    }

    /// The command `--exec` asked for, with the terms it was asked on.
    fn exec_run(&self) -> Option<linkr_tui::exec::cli::Run> {
        self.exec.as_ref().map(|command| linkr_tui::exec::cli::Run {
            command: command.clone(),
            ending: match self.exec_idle {
                Some(window) => linkr_tui::exec::cli::Ending::Idle(window),
                None => linkr_tui::exec::cli::Ending::RcMarker,
            },
            timeout: self
                .timeout
                .unwrap_or(linkr_tui::exec::cli::DEFAULT_TIMEOUT),
            retry: self.retry,
        })
    }
}

/// The ways the command line can be used, and the one thing that decides
/// between them.
///
/// A tool that is both a terminal and a script has to know which of the two it
/// is this time. The answer has always been one of three, but until now only
/// two were reachable: a command line that asked for something exited when it
/// was done, and one that asked for nothing opened the terminal. The middle —
/// configure the board, then *watch it* — had no spelling. The fourth is the
/// resident session: configure nothing, ask nothing, and answer whatever
/// arrives until the input ends.
#[cfg(feature = "cli")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Take the terminal over and stay there.
    Tui,
    /// Configure and report, then leave.
    Cli,
    /// Configure and report, then take the terminal over and stay there.
    CliThenTui,
    /// Hold the link and answer requests until the input ends.
    Serve,
}

/// Why this command line cannot be a resident session, if it cannot.
///
/// Apart from the mode decision so it can be asked *early*: `--capabilities`,
/// `--scan` and `--dry-run` are answered before a mode is worked out at all,
/// and a command line that named one of those with `--serve` would otherwise
/// watch the flag win silently — which is the one outcome the refusals exist
/// to prevent. `None` is a session that can open.
#[cfg(feature = "cli")]
fn serve_refusal(args: &Args) -> Option<String> {
    if args.cli_then_tui {
        return Some(
            "the resident session and the configure-then-watch mode ask \
             for opposite things; pick one"
                .to_string(),
        );
    }
    if args.scan {
        return Some(
            "the resident session and the scan each run to an end of \
             their own; ask the session for its state instead"
                .to_string(),
        );
    }
    for (named, what) in [
        (args.licenses, "--licenses"),
        (args.capabilities, "--capabilities"),
        (args.print_frame.is_some(), "--print-frame"),
        (args.exec.is_some(), "--exec"),
        (args.loopback.is_some(), "--loopback-test"),
        (args.link_state, "--link-state"),
        (args.doctor, "--doctor"),
        (args.send.is_some(), "--send"),
        (args.sample, "--sample"),
    ] {
        if named {
            return Some(format!(
                "the resident session answers what arrives on its \
                 input; {what} would be answered and would exit \
                 before the session opened"
            ));
        }
    }
    if !args.requests.is_empty() {
        return Some(
            "the resident session answers requests on its input; the \
             request flags would each be asked once and released, not \
             served. Send them as requests instead"
                .to_string(),
        );
    }
    if args.bridge.is_none()
        && args.ble_address.is_none()
        && args.ble_name.is_none()
        && args.lan_host.is_none()
    {
        return Some(
            "the resident session has no link to hold: name one with \
             --bridge, --ble-address, --ble-name or --lan-host"
                .to_string(),
        );
    }
    None
}

#[cfg(feature = "cli")]
impl Mode {
    /// Which mode the command line meant.
    ///
    /// `--no-terminal` and `--cli-then-tui` name a mode directly. The rest is
    /// inferred, because a command line that names `--query-info` is asking a
    /// question and not asking for an interface, and printing the answer and
    /// leaving is what it meant.
    fn from(args: &Args, prog: &str) -> Mode {
        if args.no_terminal && args.cli_then_tui {
            fail(
                prog,
                "the script mode and the configure-then-watch mode ask for \
                 opposite things; pick one",
            );
        }
        // The resident session is decided before the modes below, because
        // every flag it refuses would otherwise be *taken* by one of them and
        // answered once instead of being named as the contradiction it is.
        if args.serve {
            if let Some(why) = serve_refusal(args) {
                fail(prog, &why);
            }
            return Mode::Serve;
        }
        if args.no_terminal || args.cli_then_tui {
            return if args.cli_then_tui {
                Mode::CliThenTui
            } else {
                Mode::Cli
            };
        }
        // Nothing asked for, or a plain launch: the terminal is the answer.
        if args.requests.is_empty()
            && args.loopback.is_none()
            && args.exec.is_none()
            && args.send.is_none()
            && !args.doctor
            && !args.link_state
        {
            return Mode::Tui;
        }
        // Something was asked for, so the answer is the thing being asked
        // for. This is the inference that has always been made.
        Mode::Cli
    }
}

/// Refuse an interface-only flag in a build that has no interface.
///
/// `--enter`, `--local-echo`, `--line-mode` and `--escape` choose how the
/// terminal behaves while it is held — how Enter is sent, whether typed bytes
/// are echoed into the pane, whether a line waits for Enter, which byte ends
/// the session — and a build compiled without the interface answers every
/// command line from the script side instead. Parsing one there would accept a
/// command line and quietly do nothing about it, which is the one outcome a
/// caller cannot see: the flag is either true or it is refused, with the same
/// exit code as any other usage error.
///
/// In a build that has an interface this is a no-op and the parse carries on;
/// in one that has none the call does not come back. Written without a `!`
/// return type on purpose: the arms below still have to type-check in both
/// builds, and a diverging signature would make their bodies unreachable code
/// in the one that refuses.
#[cfg(not(feature = "tui"))]
fn refuse_without_interface(prog: &str, flag: &str) {
    fail(
        prog,
        &format!(
            "this build has no interface: {flag} configures one, and there is none to configure"
        ),
    )
}

#[cfg(feature = "tui")]
fn refuse_without_interface(_prog: &str, _flag: &str) {}

/// A command-line error, printed in the shape the rest of the toolchain uses.
fn fail(prog: &str, message: &str) -> ! {
    eprintln!("error: {message}\n");
    eprintln!("Usage: {prog} [OPTIONS]\n");
    eprintln!("For more information, try '--help'.");
    std::process::exit(2);
}

fn parse_args(prog: &str, argv: &[String]) -> Args {
    let mut args = Args {
        lang: None,
        theme: None,
        state: None,
        view: None,
        licenses: false,
        print_frame: None,
        ansi: false,
        sample: false,
        transport: None,
        bridge: None,
        ble_name: None,
        ble_address: None,
        lan_host: None,
        lan_token: None,
        lan_token_file: None,
        overlay: None,
        feed: None,
        scan: false,
        timeout: None,
        connect_timeout: None,
        no_terminal: false,
        cli_then_tui: false,
        serve: false,
        json: bool::default(),
        quiet: false,
        requests: cli::Requests::default(),
        exec: None,
        exec_idle: None,
        rc_marker: false,
        retry: 0,
        dry_run: false,
        capabilities: false,
        wifi_key_file: None,
        enter: None,
        local_echo: false,
        line_mode: false,
        escape: cli::parse_escape("^]").expect("the documented default parses"),
        log_file: None,
        debug_io: false,
        loopback: None,
        loopback_timeout: Duration::from_secs(3),
        link_state: false,
        doctor: false,
        send: None,
    };
    let mut i = 0;
    while i < argv.len() {
        let flag = argv[i].as_str();
        let mut value = |name: &str| -> String {
            i += 1;
            match argv.get(i) {
                Some(value) => value.clone(),
                None => fail(
                    prog,
                    &format!("a value is required for '{name}' but none was supplied"),
                ),
            }
        };
        match flag {
            "-h" | "--help" => {
                print!("{}", usage(prog));
                std::process::exit(0);
            }
            "-V" | "--version" => {
                // The name the caller invoked, not a compile-time product
                // name: the same build is installed as `bee` with the
                // interface and as `bee-cli` without it.
                println!("{prog} {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--licenses" => args.licenses = true,
            "--print-completion" => {
                let raw = value("--print-completion");
                let script = match cli::completion_script(&raw, prog) {
                    Some(script) => script,
                    None => fail(
                        prog,
                        &format!("invalid value '{raw}' for '--print-completion <SHELL>'"),
                    ),
                };
                print!("{script}");
                std::process::exit(0);
            }
            "--scan" => args.scan = true,
            "--timeout" => {
                let raw = value("--timeout");
                args.timeout = Some(parse_seconds(prog, "--timeout", &raw));
            }
            "--connect-timeout" => {
                let raw = value("--connect-timeout");
                args.connect_timeout = Some(parse_seconds(prog, "--connect-timeout", &raw));
            }
            "--exec" => args.exec = Some(value("--exec")),
            "--idle" => {
                let raw = value("--idle");
                args.exec_idle = Some(parse_span(prog, "--idle", &raw));
            }
            "--rc-marker" => args.rc_marker = true,
            "--retry" => {
                let raw = value("--retry");
                args.retry = raw.parse().unwrap_or_else(|_| {
                    fail(
                        prog,
                        &format!("invalid value '{raw}' for '--retry <COUNT>'"),
                    )
                });
            }
            "--dry-run" => args.dry_run = true,
            "--capabilities" => args.capabilities = true,
            "--no-terminal" => args.no_terminal = true,
            "--cli-then-tui" => args.cli_then_tui = true,
            "--serve" => args.serve = true,
            "--json" => args.json = true,
            "--quiet" => args.quiet = true,
            "--query-info" => args.requests.queries.push(device::Query::Diagnostics),
            "--query-uart" => args.requests.queries.push(device::Query::Uart),
            "--query-wifi" => args.requests.queries.push(device::Query::Wifi),
            "--query-webdav" => args.requests.queries.push(device::Query::Webdav),
            "--query-ble-name" => args.requests.queries.push(device::Query::BleName),
            "--query-lan" => args.requests.queries.push(device::Query::Lan),
            "--uart" => args.requests.uart = Some(value("--uart")),
            "--wifi" => {
                let raw = value("--wifi");
                // `SSID[,PASSWORD]`: the password is optional here so that it
                // can come from --wifi-key-file instead, and stay out of argv.
                let (ssid, password) = match raw.split_once(',') {
                    Some((ssid, password)) => (ssid.to_string(), password.to_string()),
                    None => (raw, String::new()),
                };
                args.requests.wifi = Some((ssid, password));
            }
            "--wifi-key-file" => args.wifi_key_file = Some(PathBuf::from(value("--wifi-key-file"))),
            "--wifi-off" => args.requests.wifi_off = true,
            "--wifi-scan" => args.requests.wifi_scan = true,
            "--webdav" => args.requests.webdav = Some(value("--webdav")),
            "--webdav-off" => args.requests.webdav_off = true,
            "--rename-ble" => args.requests.ble_name = Some(value("--rename-ble")),
            "--reset-ble-name" => args.requests.ble_name_default = true,
            "--loopback-test" => {
                // `nargs="?"` in the reference client: `--loopback-test` alone
                // sends `A`, which is the shortest thing that can fail in an
                // interesting way and the least likely to be swallowed by a
                // target that is doing something else.
                let mut payload = "A".to_string();
                if let Some(next) = argv.get(i + 1) {
                    if !next.starts_with('-') {
                        payload = next.clone();
                        i += 1;
                    }
                }
                args.loopback = Some(payload);
            }
            "--loopback-timeout" => {
                let raw = value("--loopback-timeout");
                let seconds: f64 = raw
                    .parse::<f64>()
                    .ok()
                    .filter(|s| s.is_finite() && *s > 0.0)
                    .unwrap_or_else(|| {
                        fail(
                            prog,
                            &format!("invalid value '{raw}' for '--loopback-timeout <SECONDS>'"),
                        )
                    });
                args.loopback_timeout = Duration::from_secs_f64(seconds);
            }
            "--link-state" => args.link_state = true,
            "--doctor" => args.doctor = true,
            "--send" => {
                let raw = value("--send");
                args.send = Some(cli::Framing::from_name(&raw).unwrap_or_else(|| {
                    fail(prog, &format!("invalid value '{raw}' for '--send <HOW>'"))
                }));
            }
            "--enter" => {
                refuse_without_interface(prog, "--enter");
                let raw = value("--enter");
                args.enter = Some(EnterMode::from_name(&raw).unwrap_or_else(|| {
                    fail(prog, &format!("invalid value '{raw}' for '--enter <MODE>'"))
                }));
            }
            "--local-echo" => {
                refuse_without_interface(prog, "--local-echo");
                args.local_echo = true;
            }
            "--line-mode" => {
                refuse_without_interface(prog, "--line-mode");
                args.line_mode = true;
            }
            "--escape" => {
                refuse_without_interface(prog, "--escape");
                let raw = value("--escape");
                args.escape = cli::parse_escape(&raw).unwrap_or_else(|why| {
                    fail(
                        prog,
                        &format!("invalid value '{raw}' for '--escape <BYTE>': {why}"),
                    )
                });
            }
            "--log-file" => args.log_file = Some(PathBuf::from(value("--log-file"))),
            "--debug-io" => args.debug_io = true,
            "--lang" => {
                let raw = value("--lang");
                args.lang = Some(Lang::from_name(&raw).unwrap_or_else(|| {
                    fail(prog, &format!("invalid value '{raw}' for '--lang <LANG>'"))
                }));
            }
            "--theme" => {
                let raw = value("--theme");
                args.theme = Some(ThemeChoice::from_name(&raw).unwrap_or_else(|| {
                    fail(
                        prog,
                        &format!("invalid value '{raw}' for '--theme <THEME>'"),
                    )
                }));
            }
            "--state" => {
                let raw = value("--state");
                args.state = Some(match raw.as_str() {
                    "disconnected" => ConnectionState::Disconnected,
                    "connecting" => ConnectionState::Connecting,
                    "connected" => ConnectionState::Connected,
                    "failed" => ConnectionState::Failed,
                    other => fail(
                        prog,
                        &format!("invalid value '{other}' for '--state <STATE>'"),
                    ),
                });
            }
            "--view" => {
                let raw = value("--view");
                args.view = Some(View::from_name(&raw).unwrap_or_else(|| {
                    fail(prog, &format!("invalid value '{raw}' for '--view <VIEW>'"))
                }));
            }
            "--print-frame" => {
                // The size is optional: `--print-frame 100x30` or bare.
                let mut size = (100u16, 30u16);
                if let Some(next) = argv.get(i + 1) {
                    if !next.starts_with('-') {
                        size = parse_size(prog, next);
                        i += 1;
                    }
                }
                args.print_frame = Some(size);
            }
            "--ansi" => args.ansi = true,
            "--sample" => args.sample = true,
            "--transport" => {
                let raw = value("--transport");
                args.transport = Some(Transport::from_name(&raw).unwrap_or_else(|| {
                    fail(
                        prog,
                        &format!("invalid value '{raw}' for '--transport <LINK>'"),
                    )
                }));
            }
            "--bridge" => args.bridge = Some(value("--bridge")),
            "--ble-name" => args.ble_name = Some(value("--ble-name")),
            "--ble-address" => args.ble_address = Some(value("--ble-address")),
            "--lan-host" => args.lan_host = Some(value("--lan-host")),
            "--lan-token" => args.lan_token = Some(value("--lan-token")),
            "--lan-token-file" => {
                args.lan_token_file = Some(PathBuf::from(value("--lan-token-file")))
            }
            "--overlay" => {
                let raw = value("--overlay");
                args.overlay = Some(OverlayPreview::from_name(&raw).unwrap_or_else(|| {
                    fail(
                        prog,
                        &format!("invalid value '{raw}' for '--overlay <NAME>'"),
                    )
                }));
            }
            "--feed" => args.feed = Some(value("--feed")),
            other => fail(prog, &format!("unrecognized option '{other}'")),
        }
        i += 1;
    }
    // The two endings are different answers to one question, and a command
    // line that asks both has not decided. The flags that only mean something
    // with `--exec` say so instead of being quietly ignored.
    if args.rc_marker && args.exec_idle.is_some() {
        fail(
            prog,
            "the marker ending and the idle ending ask for opposite things; pick one",
        );
    }
    if args.exec.is_none() {
        if args.exec_idle.is_some() {
            fail(prog, "--idle is the ending of a command; it needs --exec");
        }
        if args.retry > 0 {
            fail(prog, "--retry repeats a command; it needs --exec");
        }
        if args.dry_run {
            fail(
                prog,
                "a dry run shows what a command would send; --dry-run needs --exec",
            );
        }
    }
    // An empty command is not a command. The run would still carry its marker,
    // the marker would still come back, and the caller would read `rc: 0` and
    // `verified: true` off a line that ran nothing. The resident session
    // refuses the same request in these same words, because the two are one
    // decision.
    if let Some(command) = &args.exec {
        if command.trim().is_empty() {
            fail(prog, "exec wants a command to run");
        }
    }
    // A bridge *is* a stdio link; a different `--transport` beside it would be
    // overridden by it without a word, and the caller would believe the radio
    // it named was the one being talked to.
    if args.bridge.is_some() {
        if let Some(kind) = args.transport {
            if kind != linkr_tui::app::Transport::Stdio {
                fail(
                    prog,
                    &format!(
                        "the bridge is a stdio link, and --transport {} would be \
                         overridden by it; pick one",
                        kind.as_str()
                    ),
                );
            }
        }
    }
    // A join is a name and a password. Sent with an empty one, the firmware
    // reads it as an *open network* rather than as a password somebody forgot —
    // and the send that changed nothing comes back looking like success. The
    // password may arrive later through `--wifi-key-file`; the file's own
    // emptiness is checked when it is read.
    if let Some((ssid, password)) = &args.requests.wifi {
        if ssid.trim().is_empty() {
            fail(
                prog,
                "a join needs a network to name; --wifi-off forgets the saved one",
            );
        }
        if password.is_empty() && args.wifi_key_file.is_none() {
            fail(
                prog,
                "a join needs a password: pass it as SSID,PASSWORD or through --wifi-key-file",
            );
        }
    }
    // Setting a name and restoring the MAC-derived one are two answers to
    // one question. This used to be noticed only after the link came up, so
    // a bad command line still paid for the dial and exited 1; a usage error
    // is known before the radio is touched.
    if args.requests.ble_name.is_some() && args.requests.ble_name_default {
        fail(prog, "choose either --rename-ble or --reset-ble-name");
    }
    args
}

/// A number of seconds, as a person writes it.
///
/// Finite and positive before `Duration` sees it: `inf` and `1e300` are what a
/// script produces when a variable expanded to nothing, and a panic from
/// `from_secs_f64` would be a worse answer than a usage error.
fn parse_seconds(prog: &str, flag: &str, raw: &str) -> Duration {
    let seconds: f64 = raw
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or_else(|| {
            fail(
                prog,
                &format!("invalid value '{raw}' for '{flag} <SECONDS>'"),
            )
        });
    Duration::from_secs_f64(seconds)
}

/// A span of time, as a person writes it: bare seconds, or a suffix when the
/// window is short enough that seconds would be a fraction.
fn parse_span(prog: &str, flag: &str, raw: &str) -> Duration {
    let (number, scale) = if let Some(number) = raw.strip_suffix("ms") {
        (number, 0.001)
    } else if let Some(number) = raw.strip_suffix('s') {
        (number, 1.0)
    } else {
        (raw, 1.0)
    };
    let value: f64 = number
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or_else(|| {
            fail(
                prog,
                &format!("invalid value '{raw}' for '{flag} <SECONDS|MS>'"),
            )
        });
    Duration::from_secs_f64(value * scale)
}

/// What this tool is and can do: the document a caller reads before writing a
/// script against it.
///
/// The one operation, and the one help line, that a build without an interface
/// cannot offer. `--capabilities` is the contract a script reads, so it says
/// what *this* build can be asked for rather than what the other one can.
#[cfg(feature = "tui")]
const TUI_OPERATION: &str = ",\"tui\"";
#[cfg(not(feature = "tui"))]
const TUI_OPERATION: &str = "";
#[cfg(feature = "tui")]
const INTERFACE_CAPABILITY: &str = "interface   (no operation flags)       open the terminal\n";
#[cfg(not(feature = "tui"))]
const INTERFACE_CAPABILITY: &str = "";

/// The operations are named as the flags that ask for them, because that is
/// how they are asked for today; the numbers are the defaults a caller has to
/// plan around, and the exit codes are the contract that makes a script
/// possible at all. Written as one document rather than assembled from parts:
/// its shape is part of the answer, and interpolating a few numbers into it is
/// the whole of the work.
fn capabilities(prog: &str, json: bool) -> String {
    let version = env!("CARGO_PKG_VERSION");
    if json {
        format!(
            concat!(
                "{{\"version\":\"{}\",\"protocol\":{},",
                "\"operations\":[\"scan\",\"query-info\",\"query-uart\",\"query-wifi\",",
                "\"query-webdav\",\"query-ble-name\",\"query-lan\",\"wifi-scan\",\"uart\",\"wifi\",\"wifi-off\",",
                "\"webdav\",\"webdav-off\",\"rename-ble\",\"reset-ble-name\",",
                "\"exec\",\"send\",\"doctor\",\"loopback-test\",\"link-state\"{}],",
                // The subcommands are the same runs written as words, and a
                // caller that reads them here can write either form: the list
                // is the model as much as it is a list of names. `subcommands_json`
                // already brackets the array; another pair here would advertise
                // a list containing one list.
                "\"subcommands\":{},",
                "\"defaults\":{{\"scan_timeout_ms\":{},\"connect_timeout_ms\":{},",
                "\"exec_timeout_ms\":{}}},",
                "\"exec\":{{\"endings\":[\"rc-marker\",\"idle\"],",
                "\"marker\":\"per-attempt LINKR_RC_<nonce>:<status> line after sh -c\",",
                "\"codes\":[\"needs_input\",\"timeout\",\"link_lost\",\"not_connected\"],",
                "\"retry\":\"off; --retry N resends after a timeout, after reading state\"}},",
                "\"session\":{{\"flag\":\"--serve\",\"ops\":{},\"codes\":[\"bad_request\",",
                "\"not_connected\"],\"frame\":\"begin then the one-shot events then ",
                "end, per request, ids as sent\"}},",
                "\"exit_codes\":{{\"0-125\":\"a lone command's own status; in a batch 1 \
                 means something in it failed\",",
                "\"126-127\":\"reserved for the shell\",",
                "\"1\":\"executed but not as expected, needs input, or timed out\",",
                "\"2\":\"usage error\",",
                "\"255\":\"this tool could not send or hold the link\"}}}}\n"
            ),
            version,
            linkr_tui::protocol::MGMT_API_MAJOR,
            TUI_OPERATION,
            linkr_tui::cli::subcommands_json(),
            cli::DEFAULT_SCAN_TIMEOUT.as_millis(),
            cli::DEFAULT_CONNECT_TIMEOUT.as_millis(),
            linkr_tui::exec::cli::DEFAULT_TIMEOUT.as_millis(),
            linkr_tui::serve::operations_json(),
        )
    } else {
        format!(
            concat!(
                "{} {} — run a Linkr Bee bridge from the command line.\n",
                "\n",
                "scan        --scan                     list Linkr Bee boards on the air\n",
                "read        --query-info --query-uart  ask the bridge what it is doing\n",
                "            --query-wifi --query-webdav --query-ble-name --wifi-scan\n",
                "            --query-lan\n",
                "state       --link-state               this link: live, counters, transport\n",
                "configure   --uart --wifi --wifi-off   change that, then read it back\n",
                "            --webdav --webdav-off\n",
                "            --rename-ble NAME --reset-ble-name\n",
                "execute     --exec COMMAND             run a shell command on the target\n",
                "            --idle WINDOW              end it when the output goes quiet\n",
                "            --retry N                  resend it after a timeout\n",
                "            --dry-run                  show the bytes instead\n",
                "            --send line|raw            forward stdin without waiting\n",
                "wire test   --loopback-test [BYTES]    prove the target's UART round trip\n",
                "checkup     --doctor                   one report: link, bridge, UART,\n",
                "                                       loopback and the target's shell,\n",
                "                                       each with match/mismatch/observed/\n",
                "                                       indeterminate\n",
                "session     --serve                    hold the link, answer JSON requests on\n",
                "                                       stdin (one per line) until it ends\n",
                "{}",
                "\n",
                "The same runs can be written as subcommands: {}\n",
                "Exit codes: 0-125 a lone command's own status, then 1 executed\n",
                "but not as expected (or needs input, or timed out, or something\n",
                "else in the same batch failed), 2 usage, 255 the link or the send\n",
                "failed.\n",
            ),
            prog,
            version,
            INTERFACE_CAPABILITY,
            cli::subcommands_words(),
        )
    }
}

/// What `--exec` would put on the wire, and nothing else: no link is dialled
/// and no setting is read. A caller approving a command needs exactly this.
fn dry_run(run: &linkr_tui::exec::cli::Run, json: bool) -> String {
    let wire = run.wire();
    if json {
        let mut line = cli::json_event(&[
            ("event", cli::Json::Text("dry_run")),
            ("cmd", cli::Json::Text(&run.command)),
            ("wire", cli::Json::Text(&cli::lossy(&wire))),
            ("bytes", cli::Json::Number(wire.len() as i64)),
        ]);
        line.push('\n');
        line
    } else {
        format!("{}\n", linkr_tui::trace::debugged(&wire))
    }
}

fn parse_size(prog: &str, raw: &str) -> (u16, u16) {
    let (cols, rows) = raw
        .split_once('x')
        .unwrap_or_else(|| fail(prog, &format!("invalid value '{raw}' for '[<COLSxROWS>]'")));
    let parse = |part: &str| -> u16 {
        part.parse::<u16>()
            .ok()
            .filter(|size| *size > 0)
            .unwrap_or_else(|| fail(prog, &format!("invalid value '{raw}' for '[<COLSxROWS>]'")))
    };
    (parse(cols), parse(rows))
}

/// Restores the terminal however the program leaves: on a normal return, on an
/// error, and on a panic. Leaving a terminal in raw mode is the bug that makes
/// a TUI unshippable, so it is handled in one place rather than at each exit.
/// Entered when the interface takes the terminal over, undone however the
/// program leaves. Only the build with a renderer has one: a CLI build never
/// takes the terminal, so a guard would be guarding nothing.
#[cfg(feature = "tui")]
struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

#[cfg(feature = "tui")]
impl TerminalGuard {
    fn enter() -> io::Result<TerminalGuard> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(err) = execute!(stdout, EnterAlternateScreen) {
            // Raw mode is already on; undo it before giving up.
            let _ = disable_raw_mode();
            return Err(err);
        }
        // Bracketed paste, or the paste arrives as its keystrokes. Without this
        // a multi-line paste reaches the device's line editor as a burst of
        // separate edits — every newline an Enter the user never pressed, on a
        // shell that has already run the first half of it. With it, the whole
        // paste is one event carrying the whole payload, which is the only
        // shape in which a paste can be sent as one thing.
        if let Err(err) = execute!(stdout, EnableBracketedPaste).or_else(without_capability) {
            let _ = disable_raw_mode();
            let _ = execute!(stdout, LeaveAlternateScreen);
            return Err(err);
        }
        /* Mouse capture, or the wheel belongs to the terminal rather than to
         * this program. Without it a wheel notch is whatever the emulator
         * decides it is - a scrollback jump, a page, nothing - and the rail
         * under the cursor moves by an amount nobody chose. With it, one notch
         * is one row, which is what a wheel means.
         *
         * It is also the only way a drag can be seen at all, and a drag is how
         * text gets copied out of the pane: the terminal's own selection is
         * unreachable from inside an alternate screen, so the program has to
         * make its own. */
        if let Err(err) = execute!(stdout, EnableMouseCapture) {
            let _ = disable_raw_mode();
            let _ = execute!(stdout, LeaveAlternateScreen);
            let _ = execute!(stdout, DisableBracketedPaste);
            return Err(err);
        }
        /* The enhanced keyboard protocol, or a shifted chord is summed up by
         * the terminal before this program ever sees it: a terminal that
         * predates the protocol folds `Ctrl+Shift+letter` into
         * `Ctrl+letter`, and the shift-latch chords then arrive as the plain
         * ones. The protocol is how a terminal says which modifiers were
         * really pressed. One that does not speak it ignores the request
         * entirely, and the legacy Windows console cannot even receive it —
         * both are readings this interface has always lived with. */
        if let Err(err) = execute!(
            stdout,
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )
        .or_else(without_capability)
        {
            let _ = disable_raw_mode();
            let _ = execute!(stdout, LeaveAlternateScreen);
            let _ = execute!(stdout, DisableBracketedPaste);
            let _ = execute!(stdout, DisableMouseCapture);
            return Err(err);
        }
        let terminal = Terminal::new(CrosstermBackend::new(stdout))?;
        // The console's own encoding, taken last so that every early exit
        // above happens without having touched it: on a Chinese `cmd.exe`
        // this is the difference between the frame and a wall of mojibake, and
        // the value goes back when the guard is dropped.
        console::utf8();
        Ok(TerminalGuard { terminal })
    }

    fn restore(&mut self) {
        let _ = execute!(self.terminal.backend_mut(), PopKeyboardEnhancementFlags);
        let _ = execute!(self.terminal.backend_mut(), DisableMouseCapture);
        let _ = execute!(self.terminal.backend_mut(), DisableBracketedPaste);
        let _ = disable_raw_mode();
        let _ = execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
        let _ = self.terminal.show_cursor();
        console::restore();
    }
}

#[cfg(feature = "tui")]
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

/// The answer of a console that cannot take a capability request at all: the
/// legacy Windows console API reports `Unsupported` for every request it has
/// no console call behind — the keyboard protocol is one — and that is the
/// console saying "not here", not a failed write. The request was
/// best-effort: the program continues without the capability. Any other
/// error is real and stays one.
#[cfg(feature = "tui")]
fn without_capability(err: io::Error) -> io::Result<()> {
    match err.kind() {
        io::ErrorKind::Unsupported => Ok(()),
        _ => Err(err),
    }
}

/// Undo raw mode and the alternate screen without a handle, for the panic hook.
///
/// The guard's own `restore` does the same through its terminal; this copy
/// exists because a panicking process never runs `Drop` — the release profile
/// sets `panic = "abort"` — and a terminal left in raw mode with the mouse
/// reporting to a program that has died is a shell the user has to repair by
/// hand. Every capability the guard turned on is turned off here.
#[cfg(feature = "tui")]
fn restore_best_effort() {
    let _ = disable_raw_mode();
    let mut stdout = io::stdout();
    let _ = execute!(stdout, PopKeyboardEnhancementFlags);
    let _ = execute!(stdout, DisableMouseCapture);
    let _ = execute!(stdout, DisableBracketedPaste);
    let _ = execute!(stdout, LeaveAlternateScreen);
    console::restore();
}

/// Rust starts every process with SIGPIPE ignored, which turns a reader that
/// quits first into an I/O error — and, for a `println!`, into a panic printed
/// to nobody. The Unix convention for a CLI is the other one: stop talking the
/// moment there is nobody left listening. The default handler *is* that quiet
/// stop, so it goes back before any output can fail.
#[cfg(unix)]
fn restore_default_sigpipe() {
    // SAFETY: changing a signal disposition cannot violate any memory rule,
    // and this runs at the top of `main`, while the process is single-threaded.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
}

/// Nothing to restore where there is no SIGPIPE.
#[cfg(not(unix))]
fn restore_default_sigpipe() {}

fn main() -> io::Result<()> {
    // A reader that quits first must end this process quietly, not with a
    // panic — before any output exists to fail.
    restore_default_sigpipe();

    // The board goes free when this process does. Every ordinary exit hangs
    // the link up on its own way out; these two cover the exits that have no
    // "way out" — a panic, and a console window being closed — because a board
    // still connected to a client that is gone stops advertising, and the next
    // client cannot find it.
    linkr_tui::hangup::catch_panics();
    linkr_tui::hangup::catch_console_close();

    // Read as `OsString` and soften what cannot be text: `env::args()` panics
    // on an argument that is not UTF-8 — a byte-sequence path on Linux is the
    // ordinary case — and a crash is a worse answer than a file name that will
    // not open.
    let mut raw = std::env::args_os();
    let prog = raw
        .next()
        .and_then(|path| {
            std::path::Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "bee".to_string());
    let argv: Vec<String> = raw.map(|arg| arg.to_string_lossy().into_owned()).collect();
    // The subcommand form is a *writing* of the same command line and not a
    // second one: `bee exec -- df -h` becomes `bee --exec "df -h"` before
    // anything is parsed, so there is one grammar to read, one table behind the
    // help and the completion, and one place a bug can live. See
    // `cli::expand_subcommand`.
    let argv = match cli::expand_subcommand(argv) {
        Ok(argv) => argv,
        Err(why) => fail(&prog, &why),
    };

    let mut args = parse_args(&prog, &argv);
    // A session is refused here, *before* the flags that answer and exit: a
    // `--serve --capabilities` would otherwise print a capability list and
    // leave, and the caller would never learn that no session was opened.
    #[cfg(feature = "cli")]
    if args.serve {
        if let Some(why) = serve_refusal(&args) {
            fail(&prog, &why);
        }
    }
    // A licence page is an answer about the build, like `--capabilities`: it
    // needs no link, no settings and no terminal, but it does not get to hide
    // a `--serve` that could not open a session.
    if args.licenses {
        print!("{}", licenses::cli_report(&prog));
        return Ok(());
    }
    // Two answers need no link, and both ask to be given before anything is
    // dialled: a caller asking what this tool can do is not asking the radio
    // anything, and `--dry-run`'s whole point is to show the bytes *before*
    // anything is sent.
    if args.capabilities {
        print!("{}", capabilities(&prog, args.json));
        return Ok(());
    }
    if args.dry_run {
        // Refused without `--exec` at the parser, so one exists here.
        let run = args.exec_run().expect("--dry-run needs --exec");
        print!("{}", dry_run(&run, args.json));
        return Ok(());
    }
    // The password is read as late as possible and never put back: the point of
    // `--wifi-key-file` is that `argv` is visible to every process on the
    // machine, and a password copied from the command line into a struct is a
    // password that travelled anyway.
    if let Some(path) = &args.wifi_key_file {
        let password = match read_first_line(path) {
            Ok(password) => password,
            Err(why) => {
                eprintln!("error: {why}");
                std::process::exit(2);
            }
        };
        let ssid = args
            .requests
            .wifi
            .as_ref()
            .map_or("", |pair| pair.0.as_str());
        if ssid.trim().is_empty() {
            eprintln!("error: --wifi-key-file needs --wifi to name the network too");
            std::process::exit(2);
        }
        // The first line answered with nothing: the same refusal as never
        // having named a password at all, for the same reason.
        if password.trim().is_empty() {
            eprintln!("error: --wifi-key-file is empty; a join needs a password to send");
            std::process::exit(2);
        }
        args.requests.wifi = Some((ssid.to_string(), password));
    }

    // A scan answers a question nothing else can — is the board on the air at
    // all — so it runs before a dial is even considered and stops afterwards.
    //
    // Gated on `cli` because it is the one request that needs no interface at
    // all: in a build with the interface only, a `--scan` would have to open a
    // terminal to do something that takes three seconds and prints three lines.
    #[cfg(feature = "cli")]
    if args.scan {
        // Printed as they are heard rather than all at the end: the window is
        // ten seconds long, and a list that appears in the last of them reads
        // as a scan that found nothing until it found everything. `posted`
        // keeps a device from being printed twice when a later update still
        // carries it — an update is the whole list, not an increment.
        let stream = cli::scan_stream(args.scan_window(), cli::Until::TheWindowEnds);
        let mut posted: Vec<String> = Vec::new();
        let mut failure = None;
        while let Ok(event) = stream.recv() {
            let (devices, done) = match event {
                cli::ScanEvent::Seen(devices) => (devices, false),
                cli::ScanEvent::Done(devices) => (devices, true),
                cli::ScanEvent::Failed(why) => {
                    failure = Some(why);
                    break;
                }
            };
            for device in &devices {
                if posted.iter().any(|seen| seen == &device.address) {
                    continue;
                }
                posted.push(device.address.clone());
                if args.json {
                    // `board` is the same distinction the text row's mark
                    // makes: the one device here this program could dial, as
                    // opposed to everything else that happened to be on the
                    // air. `rssi` is null when the adapter has no reading yet,
                    // which is not the same as a weak one.
                    println!(
                        "{}",
                        cli::json_event(&[
                            ("event", cli::Json::Text("device")),
                            ("board", cli::Json::Bool(device.board)),
                            (
                                "name",
                                device
                                    .name
                                    .as_deref()
                                    .map(cli::Json::Text)
                                    .unwrap_or(cli::Json::Null)
                            ),
                            ("address", cli::Json::Text(&device.address)),
                            (
                                "rssi",
                                device
                                    .rssi
                                    .map(|rssi| cli::Json::Number(rssi as i64))
                                    .unwrap_or(cli::Json::Null)
                            ),
                        ])
                    );
                } else {
                    let name = device.name.as_deref().unwrap_or("(no name advertised)");
                    // Marked, because a row the scan could dial and a row it
                    // could not are two different answers to "is my board on":
                    // one is ready to connect to, the other is somebody else's
                    // device that happened to be on the air.
                    let kind = if device.board { "bee" } else { "-" };
                    println!("{kind:>3}  {name}  {}", device.address);
                }
            }
            if done {
                break;
            }
        }
        if let Some(why) = failure {
            eprintln!("error: {why}");
            std::process::exit(1);
        }
        if args.json {
            // A terminator, because a stream of device lines is not an answer
            // on its own: a script needs to know the window closed, and how
            // many rows to have expected. Without it the last line written is
            // indistinguishable from a scan that is still listening.
            println!(
                "{}",
                cli::json_event(&[
                    ("event", cli::Json::Text("result")),
                    ("what", cli::Json::Text("scan")),
                    ("ok", cli::Json::Bool(true)),
                    ("count", cli::Json::Number(posted.len() as i64)),
                ])
            );
        } else if posted.is_empty() && !args.quiet {
            eprintln!(
                "no Bluetooth device was seen in {} s",
                args.scan_window().as_secs()
            );
        }
        return Ok(());
    }

    // A dial that cannot be *asked for* — an unreadable token file, a
    // mis-shaped token — is said here rather than after a socket is opened:
    // it is a fact about the command line, not about the network.
    let dial = match args.dial() {
        Ok(dial) => dial,
        Err(why) => {
            eprintln!("error: {why}");
            std::process::exit(2);
        }
    };

    // Without `--state`, a *preview* shows the design's first frame — a link
    // being dialled. A live session starts from the truth instead: nothing is
    // connected until something has been dialled, and a frame that claimed
    // otherwise would be lying about a radio that may not exist.
    let preview_state = args.state.unwrap_or(if args.sample {
        ConnectionState::Connected
    } else {
        ConnectionState::Connecting
    });

    // The choices the last run left behind, read before the command line has
    // its say: a flag is a fact about this run, and the file only fills the
    // gaps. A preview reads none of it and keeps no store — the design's first
    // frame is not the user's settings, and a command that only prints frames
    // must not write to them either.
    let storing = args.print_frame.is_none();
    let settings = SettingsStore::load();
    let stored = if storing {
        settings.read()
    } else {
        Settings::default()
    };
    let mut app = App {
        lang: args.lang.or(stored.lang).unwrap_or_default(),
        theme: args.theme.or(stored.theme).unwrap_or_default(),
        state: preview_state,
        transport_locked: args.transport.is_some(),
        transport_pinned: args.transport.is_some(),
        ..App::default()
    };
    // What this terminal can draw, read once from the environment before the
    // first frame: the answer does not change while the program runs, and a
    // frame must not be painted two ways. `--print-frame` reads it too, which
    // is how a frame is printed for evidence of a lower capability.
    app.capability = linkr_tui::capability::Capability::detect();
    // The agent's durable state, opened once here rather than lazily per call:
    // one store file for tasks, notes and the session, so a task written by
    // this run and a note written by the last one are the same file.
    app.agent_store = Some(linkr_tui::agent::store::JsonFile::load());
    load_agent_state(&mut app);
    if let Some(transport) = args.transport {
        app.transport = transport;
    } else if let Some(transport) = stored.transport {
        app.transport = transport;
    }
    if let Some(view) = args.view {
        app.view = view;
    } else if let Some(view) = stored.view {
        app.view = view;
    }
    // The remembered half of a dial: the LAN host as typed, and the board
    // Connect should try before this run has dialled anything. A dial the
    // command line named replaces both below. The board is named by what the
    // last dial learned it was called — a bare address in the Device row says
    // everything to a scanner and nothing to the person at the bench.
    app.lan_host = stored.lan_host.clone();
    // The token row opens with what is remembered for that address, the way
    // the web fills its field on load: a bridge that has been here before
    // shows in hand before anything is dialled. A real session keeps the
    // store for its captures too; a preview never writes one.
    if storing {
        app.lan_store = Some(linkr_tui::lan_token_store::TokenStore::load());
    }
    app.seed_lan_token_from_store();
    if !stored.address.is_empty() {
        // A shelf written before addresses were kept as MACs holds BlueZ's
        // path for the board (`hci0/dev_FB_…`). The address is read back in
        // the one spelling that names the board everywhere; the next save
        // writes that spelling down.
        let address = linkr_tui::transport::ble::written_address(&stored.address);
        app.last_dial = Some(Dial::Ble(
            Selection::Address(address.clone()),
            args.connect_timeout,
        ));
        if !stored.device_name.is_empty() {
            app.remember_device_name(&address, &stored.device_name);
        }
    }
    if storing {
        app.settings = Some(settings);
        // A real session, drawn in a real terminal: the desktop's clipboard
        // tool joins OSC 52. A preview never copies, and a test must not
        // reach the machine's clipboard at all.
        app.desktop_clipboard = true;
    }
    // The splash is the design, so a missing key means it shows; the switch is
    // read here so the palette can turn it, and remembered for the launches
    // after this one.
    app.no_splash = stored.no_splash;
    app.clock = local_clock();
    if args.sample {
        app.diagnostics.apply(&views::sample_reply(), local_clock());
        app.terminal.push_text(views::terminal::SAMPLE);
        // A little traffic history for the top bar's graphs, so a previewed bar
        // shows the instrument and not a flat line — the shape a boot log
        // settles into: a burst coming back, keystrokes trickling out.
        app.traffic
            .rx_window
            .extend([0u64, 0, 40, 180, 640, 1200, 900, 500, 240, 120]);
        app.traffic
            .tx_window
            .extend([0u64, 60, 180, 480, 240, 120, 360, 180, 60, 30]);
        app.traffic.rate = 120;
        // Two announcements as well, so a previewed notice log has something to
        // show. They are the strings the notices really use, composed the way
        // the pump composes them, so the preview cannot show wording the
        // interface never produces.
        let s = app.strings();
        app.push_notice(linkr_tui::app::Notice {
            text: format!("{}{}", s.link_opened, Dial::Stdio("-".into()).describe()),
            level: linkr_tui::event::NoticeLevel::Info,
        });
        app.push_notice(linkr_tui::app::Notice {
            text: s.not_connected.to_string(),
            level: linkr_tui::event::NoticeLevel::Warn,
        });
    }
    if let Some(overlay) = args.overlay {
        overlay.raise(&mut app);
    }

    if let Some(text) = &args.feed {
        // Straight into the pane, through the same decoder and parser the wire
        // uses, so an inspection cannot show an emulator other than the one the
        // device talks to.
        app.terminal.push_text(text);
    }

    if let Some((cols, rows)) = args.print_frame {
        // The frame is drawn for a *sized* terminal, so the emulator is told the
        // size the paint will use — the same arithmetic the event loop runs
        // every tick. A preview drawn by an 80-column emulator inside a
        // 110-column frame would wrap the device's lines early and read as an
        // emulator bug when it is a preview bug.
        fit_pane_to(cols, rows, &mut app);
        if args.ansi {
            print!("{}", ui::render_to_ansi(&app, cols, rows));
        } else {
            print!("{}", ui::render_to_text(&app, cols, rows));
        }
        return Ok(());
    }

    // A resident session dials for itself — lazily, once per request that
    // needs the link — so the eager dial below is skipped for it: a session
    // started before the board is powered is a session that can still be
    // asked things, and the first request that needs the board dials it. What
    // the command line named is carried along either way, because that is
    // exactly what the session dials.
    if args.serve {
        app.state = ConnectionState::Disconnected;
        if let Some(Dial::Lan { host, token }) = dial.as_ref() {
            app.lan_host = host.clone();
            app.lan_token = token.clone().unwrap_or_default();
        }
    } else if let Some(dial) = dial.as_ref() {
        // The dial happens before the terminal is taken over, so a link that
        // cannot be opened prints an ordinary error instead of a corrupted
        // screen.
        if let Err(err) = app.dial(dial) {
            // A caller that asked for something gets the failure in the events
            // it would have read either way, with the code that names it and
            // the exit its one-shot shape has always had: a script run whose
            // link could not be made is this tool's own failure (255), and the
            // usage-shaped 2 is kept for a plain launch, where no command was
            // waiting on the link.
            let scripted = args.no_terminal
                || args.cli_then_tui
                || !args.requests.is_empty()
                || args.exec.is_some()
                || args.loopback.is_some()
                || args.send.is_some()
                || args.doctor
                || args.link_state;
            if args.json && scripted {
                println!(
                    "{}",
                    cli::json_event(&[
                        ("event", cli::Json::Text("error")),
                        // One code for every dial that could not be made:
                        // a caller branches on "there is no link", and the
                        // reason — board off, wrong address, radio busy —
                        // is the message's to carry.
                        ("code", cli::Json::Text("not_connected")),
                        ("message", cli::Json::Text(&err.to_string())),
                        ("still_running", cli::Json::Bool(false)),
                    ])
                );
            }
            eprintln!("error: {err}");
            std::process::exit(if scripted { 255 } else { 2 });
        }
        // What the command line dialled is also what the sidebar's LAN rows
        // describe from now on: an address named once must not have to be
        // typed again to reconnect.
        if let Dial::Lan { host, token } = dial {
            app.lan_host = host.clone();
            app.lan_token = token.clone().unwrap_or_default();
        }
        // `dial` already pinned it; a dial the command line decided cannot be
        // switched from the keyboard.
    } else {
        app.state = ConnectionState::Disconnected;
    }

    // Wire settings the command line named, applied to the state rather than
    // read back from it: the pane asks `app` what to do with a keystroke, and
    // a flag that only changed a variable here would leave the pane using its
    // own default.
    app.enter = args.enter.or(stored.enter).unwrap_or_default();
    app.escape = args.escape;
    app.line_mode = args.line_mode;
    if args.local_echo {
        app.terminal.echo = true;
    }
    // The trace is opened before anything is dialled, so the bytes of the dial
    // itself are in it: a log that starts after the handshake is a log missing
    // the part where the handshake is negotiated, which is the part that fails.
    if let Some(path) = &args.log_file {
        app.trace = match linkr_tui::trace::ByteTrace::to_file(path) {
            Ok(trace) => trace,
            Err(why) => {
                eprintln!(
                    "error: {} could not be opened for appending: {why}",
                    path.display()
                );
                std::process::exit(2);
            }
        };
    }
    // Where a trace goes is decided once, from what standard error is — not
    // from whether a trace was asked for yet. The palette's switch can ask
    // for one at any moment, and stderr being this terminal is a property of
    // the terminal, not of the flag: a trace written there would push lines
    // into the alternate screen behind the renderer's back, and the next
    // differential paint cannot repair what it never recorded — the screen
    // stays broken until it is repainted from scratch. So the decision is
    // made here and carried by the App, and the switch reads it.
    if io::stderr().is_terminal() {
        app.trace_file = Some(linkr_tui::trace::default_trace_path());
    }
    if args.debug_io || stored.debug_io {
        match app.trace_file.clone() {
            Some(path) => {
                if app.trace.set_trace_file(&path).is_ok() {
                    // The switch that turned this on named the file; a fresh
                    // launch writes a fresh one and owes the same sentence.
                    if let Some(notice) = app.tracing_notice() {
                        app.push_notice(notice);
                    }
                } else {
                    // The file could not be opened; a broken screen is still
                    // better than a silent switch that promised a trace and
                    // kept none.
                    app.trace.set_stderr(true);
                }
            }
            // Standard error is a file or a pipe: exactly where a trace
            // belongs, and where it has always gone.
            None => app.trace.set_stderr(true),
        }
    }

    // A script run: connect, ask, report, hang up. Reached for the two modes
    // that do the asking first, which is `--no-terminal` and
    // `--cli-then-tui` alike — what separates them is what happens *after*,
    // and that belongs below rather than in the condition here.
    //
    // Gated on `cli`. The mode is read with it, because in a build without it
    // there is no branch that reads the mode and an unused binding is a warning
    // the next reader has to explain.
    #[cfg(feature = "cli")]
    let mode = Mode::from(&args, &prog);
    // A build with no interface has no answer for "just open the terminal",
    // which is what a bare launch asks for. Say so, in the shape every other
    // unanswerable command line gets, instead of exiting with silence.
    #[cfg(all(feature = "cli", not(feature = "tui")))]
    if mode == Mode::Tui {
        eprintln!("error: this build has no interface; ask it to do something\n");
        eprintln!("Usage: {prog} [OPTIONS]\n");
        eprintln!("For more information, try '--help'.");
        std::process::exit(2);
    }
    // The middle mode asks for the terminal *after* the requests, and there is
    // none to open here: refuse it before the requests run, rather than run
    // them and stop as if the interface had been opened.
    #[cfg(all(feature = "cli", not(feature = "tui")))]
    if args.cli_then_tui {
        fail(
            &prog,
            "this build has no interface: --cli-then-tui has nothing to open, use --no-terminal",
        );
    }
    #[cfg(feature = "cli")]
    if mode != Mode::Tui {
        // The resident session: the link is held, the input is answered, and
        // there is no report to make on the way out — the caller reads each
        // answer as it arrives. It returns when its input ends or a request
        // asks it to quit, and that answer is the exit code.
        if mode == Mode::Serve {
            let code = linkr_tui::serve::run(&mut app, dial, args.connect_window(), &prog);
            // The session held the link for as long as its input asked it to;
            // the board is told it is over before the process is gone.
            app.hang_up(linkr_tui::hangup::EXIT_GRACE);
            std::process::exit(code);
        }
        if !args.quiet && app.session.is_live() {
            eprintln!("connected to {}", app.session.describe());
        }
        let format = if args.json {
            cli::Format::Json
        } else {
            cli::Format::Text
        };
        let mut failed = cli::run_requests(&mut app, &args.requests, format, args.connect_window());
        // The command is the last thing asked of the target before the wire
        // test, and its own status is the program's: a caller wiring this into
        // a script needs the target's answer, not a summary of it.
        let mut exec_code = 0;
        if let Some(run) = args.exec_run() {
            exec_code = linkr_tui::exec::cli::run(&mut app, &run, format);
        }
        // Standard input goes to the target with no ending rule: this is the
        // human-in-the-loop half, and it stands where `--exec` does — right
        // after the questions, before the wire test.
        if let Some(how) = args.send {
            if linkr_tui::cli::send_stdin(&mut app, how, format) != 0 {
                failed += 1;
            }
        }
        // The loopback goes after the questions and stands alone: it is
        // answered by the target's UART rather than by the bridge, so running
        // it before the management requests would put its echo in what they
        // read back.
        if let Some(payload) = &args.loopback {
            if !cli::loopback_test(&mut app, payload.as_bytes(), args.loopback_timeout, format) {
                failed += 1;
            }
        }
        // The checkup, when it was asked for: it runs after whatever else was
        // asked so that it describes the board those requests left behind —
        // and it is the same commands underneath (`@i?`, `@u?`, the round
        // trip, one `--exec`), so a checkup can never pass a bridge that a
        // plain query would have failed.
        if args.doctor {
            let expect_baud = args.requests.uart.as_deref().and_then(|spec| {
                linkr_tui::accessory::parse_uart_spec(spec)
                    .ok()
                    .map(|settings| settings.baud)
            });
            if linkr_tui::doctor::run(&mut app, format, expect_baud) != 0 {
                failed += 1;
            }
        }
        // The link's own state, last: it is a reading of the run that just
        // happened — the counters are the ones those requests moved — and it
        // is answered without asking the bridge anything, so it still answers
        // when the bridge is what has gone quiet. The session's `state`
        // request is the same report (`serve::report_state`), which is why it
        // is one function and not two.
        if args.link_state {
            linkr_tui::serve::report_state(&app, format);
        }
        // Only the pure script mode hangs up. The middle mode keeps the link
        // it just configured and takes the terminal over on it: a board whose
        // serial settings were just changed is exactly the board the user now
        // wants to watch.
        if mode == Mode::Cli {
            // Hung up out loud rather than merely dropped: the process is
            // about to go, and the board has to hear about it before it does.
            app.hang_up(linkr_tui::hangup::EXIT_GRACE);
            // The order the codes are decided in, and where a batch's own
            // status goes. A command that was the *only* thing asked for
            // answers with its own status: a script wrapping one `--exec`
            // needs the target's answer, not a summary of it. In a batch of
            // several actions the command's status is one event among others
            // — 5 and 1 are the same "not zero" to a shell — and letting it
            // win would hide whether the rest of the batch worked, which is
            // the one thing a batch is for. So the batch's code says whether
            // the batch worked, and the rc stays in the event the caller
            // reads it from.
            let exec_alone = exec_code != 0
                && args.exec.is_some()
                && args.requests.is_empty()
                && args.loopback.is_none()
                && args.send.is_none()
                && !args.doctor
                && !args.link_state;
            if exec_alone {
                std::process::exit(exec_code);
            }
            if failed > 0 || exec_code != 0 {
                std::process::exit(1);
            }
            return Ok(());
        }
        // The notes before the terminal opens, and only then: a build without
        // an interface does not say "opening the terminal" and then not open it.
        #[cfg(feature = "tui")]
        if exec_code != 0 {
            // A command that ran and answered with a status is not a reason to
            // keep the terminal away; it is a reason to say so before it opens.
            eprintln!(
                "note: the command exited with code {exec_code}; opening the terminal anyway"
            );
        }
        #[cfg(feature = "tui")]
        if failed > 0 {
            // The link stays up either way: a failed request is a report, not
            // a disconnection, and the terminal is still the better way to
            // find out what went wrong.
            eprintln!(
                "note: {} request{} failed; opening the terminal anyway",
                failed,
                if failed == 1 { "" } else { "s" }
            );
        }
    }

    // The interface half. Reached when the command line asked for it and the
    // asking half did not end the program; compiled out of a build with no
    // renderer, where there is nothing to hand `app` to. The result is bound
    // rather than returned so a build with the interface off still has
    // something to answer, and an error out of the event loop is not dropped
    // on the floor.
    // Open listening. A user who runs this on a bench has one board in front of
    // them and did not ask for a chooser; asking them to open a scan is asking
    // them to do the work the program can do itself. The scan runs, and one
    // that hears exactly one board that speaks the serial service dials it —
    // or, if two are in the air, the list is shown to pick from.
    //
    // A board an earlier run dialled is dialled again by its address instead:
    // the address is remembered precisely so the question "which board is
    // this" does not have to be asked twice, and scanning for it first would
    // make every launch as slow as the first one.
    //
    // Not on a link the command line already asked for: `--address` and
    // `--bridge` name a board, and scanning past a named one would replace a
    // deliberate choice with whatever else was advertising.
    #[cfg(feature = "tui")]
    if !app.session.is_live() && app.transport == linkr_tui::app::Transport::Ble {
        match app.last_dial.clone() {
            Some(dial @ Dial::Ble(..)) => {
                app.dial_async(&dial, true);
            }
            _ => {
                let _ = app.start_ble_scan_connecting_one();
            }
        }
    }

    #[cfg(feature = "tui")]
    let outcome = {
        // The interactive path is the one that paints for a person and the
        // only place the compatibility pass is decided: `--print-frame` and
        // every test paint the frame the design asks for, on every platform.
        app.legacy_console = ui::legacy::legacy_console();
        // The splash stands for a moment, unless the user turned it off — and
        // only on this path: a frame printed for evidence is not a launch, and
        // a splash over it would cover the surface that was asked for. An
        // `--overlay splash` preview has already raised its own and is left
        // alone.
        if !app.no_splash && app.splash_until.is_none() {
            app.splash_until = Some(std::time::Instant::now() + linkr_tui::app::SPLASH);
        }
        run(&mut app)
    };
    // The interface is over whichever way it ended — the quit key, Ctrl+C,
    // the terminal going away, a write that failed — and the board hears
    // about it here, before the process leaves: a link left standing is a
    // board the next client cannot find.
    #[cfg(feature = "tui")]
    app.hang_up(linkr_tui::hangup::EXIT_GRACE);
    #[cfg(not(feature = "tui"))]
    let outcome: io::Result<()> = Ok(());
    outcome
}

/// Bring the agent's durable state back into the view.
///
/// Without this the store is write-only: a task saved and a model configured
/// both survive on disk and neither is ever read back, so the view is blank
/// after every restart and the form asks for the endpoint it already has. The
/// stores were built for a `Storage` that nobody opened, and this is the other
/// half of opening it.
fn load_agent_state(app: &mut App) {
    linkr_tui::views::assistant::load_device_state(app);
    let saved = app
        .agent_store
        .as_ref()
        .map(linkr_tui::agent::config::load_agent_config)
        .unwrap_or_default();
    // The key is read once and copied, because it is used twice — into the form,
    // so a user can see there is one, and into the validation that decides
    // whether the model is configured at all.
    let mut input = linkr_tui::agent::config::AgentConfigInput::new();
    input.endpoint = saved.endpoint.clone();
    input.model = saved.model.clone();
    input.api_key = saved.api_key.clone();
    // The headers are parsed back the same way the Enter key parses them.
    // Dropping them here was a bug with a long tail: a gateway that needs a
    // header would validate, save, load, and then send every request without
    // it — a configured assistant that answers nothing, with nothing on
    // screen to say why.
    input.headers =
        linkr_tui::agent::config::parse_agent_headers(&saved.headers).unwrap_or_default();
    // The protocol and the reasoning level are already resolved to a value the
    // form can paint — `load_agent_config` answers with the default when the
    // store holds nothing or holds a name that no longer exists.
    input.provider = linkr_tui::agent::config::provider_or_default(&saved.provider);
    input.reasoning = linkr_tui::agent::config::reasoning_or_default(&saved.reasoning);
    // A stored number that no longer parses is the same failure as a bad
    // endpoint, and reads the same way: the model is not configured. A blank
    // one means the built-in default, which is what `0` means here.
    input.context_window = saved.context_window.trim().parse().unwrap_or(0);
    input.max_tokens = saved.max_tokens.trim().parse().unwrap_or(0);
    // A stored config that no longer validates must not leave the view claiming
    // a model it cannot use: the answer here is the same one the Enter key
    // gives, so a bad endpoint is caught the same way wherever it came from.
    app.assistant.config = linkr_tui::agent::config::validate_agent_config(&input).ok();
    app.assistant.configured = app.assistant.config.is_some();
    app.assistant.endpoint = input.endpoint;
    app.assistant.model = input.model;
    app.assistant.api_key = input.api_key;
    app.assistant.headers = saved.headers;
    app.assistant.provider = saved.provider;
    app.assistant.reasoning = saved.reasoning;
    app.assistant.context_window = saved.context_window;
    app.assistant.max_tokens = saved.max_tokens;
}

/// The first line of `path`, which is how a secret is handed over: a file the
/// shell cannot put in `argv` and `ps` cannot read back.
fn read_first_line(path: &std::path::Path) -> Result<String, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|why| format!("{} could not be read: {why}", path.display()))?;
    // The reference client takes the first line and ignores the rest, so a
    // file with a trailing newline behaves the way a key file is expected to.
    Ok(text.lines().next().unwrap_or("").trim().to_string())
}

/// The centre region — the terminal pane's area — for a frame of this size.
/// The pane the emulator is sized to: [`ui::pane_area`], the paint's own
/// arithmetic, so the grid ends exactly where the painted cells do.
fn pane_area(cols: u16, rows: u16) -> Rect {
    ui::pane_area(cols, rows)
}

/// The centre region as the *paint* lays it out, rail and panel and all.
///
/// Not [`pane_area`]: that is the emulator's width, which deliberately stays
/// put when a column appears or goes so a toggle does not rewrap the device's
/// whole history. A mouse point, though, is measured against what the user
/// sees — the rail and the assistant's panel both take their columns off it —
/// so the drag asks this one and clamps to the emulated screen afterwards.
// The interactive session's helpers. A CLI-only binary has no loop that calls
// them, so they leave the build rather than warn as dead code; the tests that
// drive them keep them under `test`.
#[cfg(any(feature = "tui", test))]
fn painted_centre(app: &App, cols: u16, rows: u16) -> Rect {
    ui::regions_for(
        Rect::new(0, 0, cols, rows),
        app.sidebar_visible,
        app.panel_wanted(),
    )
    .centre
}

/// The pane cell a mouse point is on, when it is on the pane at all: a point
/// on another view's document or on the rail is not text.
#[cfg(any(feature = "tui", test))]
fn pane_cell_at(app: &App, cols: u16, rows: u16, column: u16, row: u16) -> Option<(usize, usize)> {
    let centre = painted_centre(app, cols, rows);
    if column < centre.x
        || column >= centre.x + centre.width
        || row < centre.y
        || row >= centre.y + centre.height
    {
        return None;
    }
    let (screen_cols, _) = app.terminal.size();
    let col = (column - centre.x).min(screen_cols.saturating_sub(1));
    linkr_tui::views::terminal::cell_at(
        &app.terminal,
        centre.height as usize,
        (row - centre.y) as usize,
        col as usize,
    )
}

/// Size the emulator for a frame of `cols`×`rows`, and hand back the pane it
/// got.
///
/// Both callers go through here — the preview, which knows the size it was asked
/// to draw, and the event loop, which asks the terminal — so a preview cannot
/// size the pane differently from the live loop. The width the pane is sized
/// for is the width it is *painted* at: on the legacy console the frame gives
/// its right margin to the scrollbar, and an emulator sized for the whole
/// window would wrap the device's lines under it.
fn fit_pane_to(cols: u16, rows: u16, app: &mut App) -> Rect {
    let painted = ui::legacy::drawing_area(Rect::new(0, 0, cols, rows), app.legacy_console).width;
    let pane = pane_area(painted, rows);
    app.terminal.set_size(pane.width, pane.height);
    // A run the pointer drew names cells of the frame it was drawn on; a
    // window that moved those cells under it is a frame the run no longer
    // names, so the run goes with the size.
    if app.screen != Rect::new(0, 0, cols, rows) {
        views::assistant::clear_selection(app);
    }
    // The frame itself, kept where a key handler can read it: keys are handled
    // between two paints, and the settings window keeps its caret inside a
    // body whose height comes from these numbers.
    app.screen = Rect::new(0, 0, cols, rows);
    pane
}

/// Tell the emulator how big its pane is, from the terminal's own size.
///
/// The paint cannot do this: a frame is a pure function of the state, so it may
/// not reshape the screen it is drawing. The loop does it instead, from the same
/// layout arithmetic the paint uses — and it re-reads the size rather than
/// caching it, so a resize needs no path of its own.
#[cfg(feature = "tui")]
fn fit_pane(terminal: &Terminal<CrosstermBackend<Stdout>>, app: &mut App) -> io::Result<()> {
    let size = terminal.size()?;
    fit_pane_to(size.width, size.height, app);
    Ok(())
}

/// The event loop: paint, then wait for input or the next tick.
/// The interface half, which a build without a renderer has no call to.
#[cfg(feature = "tui")]
fn run(app: &mut App) -> io::Result<()> {
    // Entering raw mode fails on anything that is not a terminal, and the OS
    // error it gives for that is a number — ENXIO, ENOTTY — which is not a
    // sentence a user can act on. A user who pipes this into a file or runs it
    // from a service has done something ordinary and deserves to be told what
    // it was, not handed errno to interpret.
    let mut guard = match TerminalGuard::enter() {
        Ok(guard) => guard,
        Err(why) if !std::io::IsTerminal::is_terminal(&std::io::stdout()) => {
            eprintln!("bee: the TUI needs an interactive terminal ({why})");
            std::process::exit(2);
        }
        Err(why) => return Err(why),
    };

    // A panic must not leave the terminal in raw mode; the hook runs before the
    // process aborts, so the restore below is the last thing that happens.
    let fallback = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        restore_best_effort();
        fallback(info);
    }));

    let outcome = event_loop(&mut guard.terminal, app);
    guard.restore();
    outcome
}

/// The loop that drains the keyboard, on the same runtime the transport built.
#[cfg(feature = "tui")]
fn event_loop(terminal: &mut Terminal<CrosstermBackend<Stdout>>, app: &mut App) -> io::Result<()> {
    loop {
        // Resize before the pump: the bytes about to arrive are painted at the
        // size the pane is now, not the size it was when the user dragged the
        // window.
        fit_pane(terminal, app)?;
        app.pump();
        app.clock = local_clock();
        terminal.draw(|frame| ui::draw(frame, app))?;

        if event::poll(TICK)? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    // The splash is a screen, not a modal: any key puts it
                    // away and is spent doing that, so the key that dismissed
                    // the splash does not also reach the device behind it.
                    if app.splash_active() {
                        app.skip_splash();
                    } else if handle_key(app, key) || app.quit {
                        // A quit can arrive two ways: the chord says so
                        // directly, and a palette action sets the flag — both
                        // end the loop, so the two routes cannot diverge.
                        return Ok(());
                    }
                }
                // A paste arrives as one event carrying the whole payload, not
                // as the keystrokes that would have produced it. Bracketed
                // paste is enabled below, so the bytes in a paste never reach
                // the device's own line editor as stray keys — which is the
                // entire reason the terminal introduced the mode.
                Event::Paste(text) => {
                    // A paste goes where a field the user can see is asking
                    // for one — a dialog's box, the palette's query, the
                    // assistant's caret — and to the device only when the
                    // device's own view is the one on screen without one. The
                    // terminal's paste and the terminal being pasted *into*
                    // are different things, and only the second is this.
                    //
                    // A paste arriving at the splash is addressed to the
                    // splash: it puts it away and goes no further, the way a
                    // key does.
                    if app.splash_active() {
                        app.skip_splash();
                    } else if !paste_into_shown_field(app, &text)
                        && !app.overlay_open()
                        && app.focus == Focus::Terminal
                        && app.view == View::Terminal
                    {
                        // A paste is a *typing* gesture, so it goes through
                        // the door a keystroke uses: line mode holds it until
                        // Enter exactly as it would have held the characters,
                        // and the echo, the trace and the tx counter all see
                        // it. The text can span newlines, and a target that
                        // sees the whole block is what was asked for — what a
                        // paste must not be is chopped into per-line sends
                        // with an Enter guessed after each one.
                        app.paste(&text);
                    }
                }
                // The wheel and the drag. Both need the mouse captured by the
                // guard, and both are one gesture's worth of work: a notch
                // walks the rail one row and the pane three lines, and a drag
                // selects text because the terminal's own selection cannot be
                // read from inside an alternate screen.
                Event::Mouse(mouse) => {
                    if app.quit {
                        return Ok(());
                    }
                    if app.splash_active() {
                        // A click, a drag or a notch is a gesture and puts the
                        // splash away; a bare hover is not — most terminals
                        // report motion, and the splash must not be lost to a
                        // desk bump.
                        if !matches!(mouse.kind, crossterm::event::MouseEventKind::Moved) {
                            app.skip_splash();
                        }
                    } else {
                        let size = terminal.size().unwrap_or_default();
                        handle_mouse(app, mouse, size.width, size.height);
                    }
                }
                // A resize is picked up by the next draw; nothing to do.
                Event::Resize(_, _) => {}
                _ => {}
            }
        } else {
            // The beat that moves the busy indicator and the clock.
            app.tick = app.tick.wrapping_add(1);
        }
    }
}

/// Handle one key press. Returns true when the loop should stop.
///
/// The order matters and is the whole policy. The modals are one stack, and
/// the one opened last is the one that answers: the painter draws the palette
/// when both are up, so the palette is asked first to agree with it. A dialog
/// takes the keyboard by closing the palette when it opens — `Ctrl+P` over a
/// dialog is what raises the palette back on top. A *control* chord falls
/// through both, so `Ctrl+Q` still quits and `Ctrl+T` still repaints with an
/// overlay up. Then the global chords, then the sidebar, and only what is left
/// is the device's.
#[cfg(any(feature = "tui", test))]
fn handle_key(app: &mut App, key: KeyEvent) -> bool {
    // The two modals are a stack: whichever was opened last is on top, takes
    // the keys, and is the one painted. Dispatch has to agree with the
    // painter, and the painter puts the palette first — so the palette is
    // checked first. Before this, a dialog was checked first while the painter
    // also preferred the dialog, which made `Ctrl+P` look dead with a form
    // open: the palette *did* open, over the dialog, but it was painted under
    // it and fed no keys, so Escape was the only way to find it again.
    if app.palette.is_some() && palette::handle_key(app, key) {
        return app.quit;
    }
    if app.dialog.is_some() && dialogs::handle_key(app, key) {
        return app.quit;
    }

    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    // A chord that asks for Shift may arrive as the uppercase character or as
    // the lowercase one carrying the shift flag, depending on what the
    // terminal's keyboard protocol reports — `Ctrl+Shift+R` is `R` on some and
    // `r` plus SHIFT on others. The match below sees the uppercased spelling,
    // so both land in the same arm; the key itself is untouched, because that
    // is what a key falling through to the device sends.
    let chord = match key.code {
        KeyCode::Char(c) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            KeyCode::Char(c.to_ascii_uppercase())
        }
        code => code,
    };
    // Chords the interface owns, in every focus and every view.
    match (chord, ctrl) {
        (KeyCode::Char('q'), true) => {
            app.request_quit();
            return true;
        }
        // Ctrl+C is the key a serial console is for: it interrupts whatever
        // is running on the other end. It is also the key every program quits
        // with, and this is where those two duties meet — so the pane wins
        // whenever it holds the keyboard and a link is live, and everywhere
        // else (the rail, a form, no link at all) it still quits, as Ctrl+Q
        // does from anywhere.
        (KeyCode::Char('c'), true) => {
            if app.pane_has_the_keyboard() && app.session.is_live() {
                if let Some(bytes) =
                    key_bytes(key, app.enter, app.terminal.vt().application_cursor_keys())
                {
                    app.type_bytes(false, &bytes);
                }
                return false;
            }
            app.request_quit();
            return true;
        }
        // The palette's chord is a toggle: pressing it again puts the overlay
        // away, which is what a key that opened a window is expected to do.
        (KeyCode::Char('p'), true) => {
            if app.palette.is_some() {
                app.palette = None;
            } else {
                palette::open(app);
            }
            return false;
        }
        (KeyCode::Char('t'), true) => {
            // The picker's chord is a toggle, like the palette's: the key
            // that opens the window also puts it away — and putting it away
            // is cancel, because a preview nobody kept is not a choice.
            dialogs::toggle_theme_pick(app);
            return false;
        }
        // The one-shot latches: `Ctrl+Shift+R/C/A` arm Shift/Ctrl/Alt for the
        // very next key. This is the old interface's scheme, kept because it
        // is the only one that reaches *every* key — a mechanism that caught
        // keys by chord would always be missing the chord that caught them.
        // The same chord cancels what it armed. Arming needs the pane's
        // screen to be the one that acts on it, so an overlay blocks it: a
        // latch armed behind a form would go off somewhere the user is not
        // looking.
        (KeyCode::Char('R'), true) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            if app.overlay_open() {
                return false;
            }
            return toggle_latch(app, "Shift", |latch| &mut latch.shift);
        }
        (KeyCode::Char('C'), true) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            if app.overlay_open() {
                return false;
            }
            return toggle_latch(app, "Ctrl", |latch| &mut latch.ctrl);
        }
        (KeyCode::Char('A'), true) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            if app.overlay_open() {
                return false;
            }
            return toggle_latch(app, "Alt", |latch| &mut latch.alt);
        }
        // Ctrl+Shift+Y puts the screen on the terminal's clipboard. `Y` and
        // not `C`: `Ctrl+C` belongs to the device while the pane has the
        // keyboard, and `Ctrl+Shift+C` belongs to the Ctrl latch — the copy
        // chord had been one shift away from the quit chord, which is exactly
        // where a chord pressed in a hurry must not be.
        (KeyCode::Char('Y'), true) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            let notice = app.copy_screen();
            app.push_notice(notice);
            return false;
        }
        (KeyCode::Char('l'), true) => {
            app.clear_terminal();
            return false;
        }
        // Ctrl+Up puts the keyboard on the rail. Up alone is the cursor or
        // scrollback in every focus, so focusing needs a chord; and Esc takes
        // the keyboard back out again, which is why this is a one-way trip.
        //
        // The rail's *visibility* is a different thing and is not bound here:
        // a key that could hide the sidebar from under a user who is trying to
        // focus it is a key that fights them. It is in the palette.
        (KeyCode::Up, true) => {
            app.focus = Focus::Sidebar;
            return false;
        }
        // --- the layout ----------------------------------------------------
        // Ctrl+B hides and shows the rail. This is the chord every sidebar
        // has, and the layout needs it: the rail costs thirty columns, and a
        // user on a narrow window needs them back without a trip through the
        // palette. Hiding it while the keyboard is on it hands the keyboard
        // back, which `toggle_sidebar` decides.
        (KeyCode::Char('b'), true) => {
            let notice = app.toggle_sidebar();
            app.push_notice(notice);
            return false;
        }
        // Ctrl+Left and Ctrl+Right switch between the console and the
        // assistant. See [`focus_pane`] for what "the assistant" means here
        // and why the panel opens on the way in.
        (KeyCode::Left, true) => {
            focus_pane(app, -1);
            return false;
        }
        (KeyCode::Right, true) => {
            focus_pane(app, 1);
            return false;
        }
        // --- the assistant ---------------------------------------------------
        // The composer for a question or a paste, the settings window for a
        // setting, the mode cycle, and a new conversation — each landing where
        // the work is, and each scoped to the assistant rather than global.
        // That scoping is the point: every one of these is a key a shell also
        // wants — `Ctrl+N` is the next history line, `Ctrl+S` is flow control,
        // `Ctrl+V` is verbatim insert — and taking one away from the pane
        // behind the panel would break the terminal to serve a column the user
        // is not in. The Shift spellings below are kept as aliases for the
        // terminals that report the shift flag; the Ctrl spellings are for the
        // ones that do not, which is most of the consoles this is read on.
        (KeyCode::Char('k'), true) if agent_has_the_keyboard(app) => {
            views::assistant::focus_composer(app);
            return false;
        }
        (KeyCode::Char('s'), true) if agent_has_the_keyboard(app) => {
            views::assistant::open_settings(app, views::assistant::AgentField::Endpoint);
            return false;
        }
        (KeyCode::Char('o'), true) if agent_has_the_keyboard(app) => {
            views::assistant::cycle_mode(app);
            return false;
        }
        // A new conversation, on the screen the user is already looking at:
        // from the panel it is the panel's header that changes, which is the
        // whole announcement a switch needs.
        (KeyCode::Char('n'), true) if agent_has_the_keyboard(app) => {
            views::assistant::new_conversation(app);
            return false;
        }
        // The clipboard, pasted at the caret. Scoped for the same reason the
        // rest are: the device keeps its own `Ctrl+V`.
        (KeyCode::Char('v'), true) if agent_has_the_keyboard(app) => {
            if let Some(text) = views::assistant::take_clipboard(app) {
                views::assistant::paste_at_caret(app, &text);
            }
            return false;
        }
        // Alt+Up and Alt+Down walk the conversation list. Alt rather than
        // Ctrl: inside a field the arrows keep their meaning, and Alt is the
        // modifier the panel has to spare — a shell's own Alt+Up is rare
        // enough that scoping this to the assistant is the whole guard.
        (KeyCode::Up, false)
            if key.modifiers.contains(KeyModifiers::ALT) && agent_has_the_keyboard(app) =>
        {
            views::assistant::switch_conversation(app, -1);
            return false;
        }
        (KeyCode::Down, false)
            if key.modifiers.contains(KeyModifiers::ALT) && agent_has_the_keyboard(app) =>
        {
            views::assistant::switch_conversation(app, 1);
            return false;
        }
        (KeyCode::Char('K'), true) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            views::assistant::focus_composer(app);
            return false;
        }
        (KeyCode::Char('S'), true) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            views::assistant::open_settings(app, views::assistant::AgentField::Endpoint);
            return false;
        }
        (KeyCode::Char('M'), true) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            app.set_view(View::Assistant);
            views::assistant::cycle_mode(app);
            return false;
        }
        // The Shift spelling *shows* the assistant as well as starting a fresh
        // conversation: with the panel shut, a new thread would otherwise be
        // announced and not seen. The Ctrl spelling above does not, because
        // the user who pressed it was already in the panel.
        (KeyCode::Char('N'), true) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            if !app.panel_wanted() {
                app.set_view(View::Assistant);
            }
            views::assistant::new_conversation(app);
            return false;
        }
        // The clipboard, pasted as text. `V` is not a device key the way a
        // letter is, and a paste that reached the backend would be retyped by
        // it as so many keystrokes. A field the user can see takes it first;
        // with no field at all the assistant's caret is brought up, which has
        // been the chord's promise since before the fields existed.
        (KeyCode::Char('V'), true) if key.modifiers.contains(KeyModifiers::SHIFT) => {
            if let Some(text) = views::assistant::take_clipboard(app) {
                if !paste_into_shown_field(app, &text) && !app.overlay_open() {
                    views::assistant::paste_into_focus(app, &text);
                }
            }
            return false;
        }
        // F1 is the help, not a view: the view rota starts at F2.
        (KeyCode::F(1), _) => {
            dialogs::open_help(app);
            return false;
        }
        // F6 is the assistant's column, the other edge's `Ctrl+B`: the panel
        // costs a third of the window, and a user reading a wide trace needs
        // the columns back without a trip through the palette. A function key
        // rather than the chord family's `Ctrl+Shift+letter`, because a
        // console that predates the enhanced keyboard protocol folds that
        // spelling into the control code — `Ctrl+Shift+B` arrives as the
        // rail's `Ctrl+B` there and would toggle the wrong column. The rail's
        // toggle announces the *state*; this column announces itself by
        // appearing, so it only speaks when there is no room to appear at all.
        (KeyCode::F(6), _) => {
            app.toggle_assistant_panel();
            return false;
        }
        // Tab is deliberately not a chord here. It is the most-used key a
        // shell has — completion — so it belongs to the device whenever the
        // pane holds the keyboard, and the forms that want it (the assistant's
        // fields, the network rows) take it in their own handlers. The rail is
        // entered with Ctrl+Up and left with Esc, both of which predate this
        // and are what the help has listed all along.
        (KeyCode::F(number), _) => {
            if let Some(view) = View::from_fkey(number) {
                app.set_view(view);
            }
            return false;
        }
        _ => {}
    }

    // An overlay has already taken the keys it wants: the palette's handler
    // consumed them, the dialog's handler consumed them, and the global chords
    // above were matched before either. What is left is nobody's — and it must
    // not fall through, because the layer below is a live console: an unbound
    // control character reaching the pane would be typed into it, and PageDown
    // would walk the scrollback under a search box. Saying so once here is
    // what keeps every key from having to remember it, and it is what a
    // control chord falling through the palette *should* have meant all along.
    if app.overlay_open() {
        return false;
    }

    if app.focus == Focus::Sidebar {
        match key.code {
            KeyCode::Down => app.cursor_down(),
            KeyCode::Up => app.cursor_up(),
            // Enter does what the row says: change the transport, dial, open a
            // view, or send a preset — the guarded ones asking first.
            KeyCode::Enter => ui::sidebar::activate(app),
            // Esc hands the keyboard back to the centre column. It is the only
            // key that means "stop being in a pane" in every other layer of
            // this interface, so it means it here too — and it is consumed
            // here rather than falling through, because Esc is otherwise the
            // escape byte the wire carries and a focused rail must not type to
            // the target by accident.
            KeyCode::Esc => app.focus = Focus::Terminal,
            _ => {}
        }
        return false;
    }

    // The docked panel is a column of the terminal view with the keyboard in
    // it: the composer takes the text, Escape hands the keys back to the pane
    // — the panel is a place you visit, not a mode — and nothing left here is
    // the device's. A control character typed into a console behind a chat
    // column is what this dispatch exists to prevent.
    if app.assistant_panel_focused() {
        if key.code == KeyCode::Esc {
            app.focus = Focus::Terminal;
            return false;
        }
        views::assistant::handle_key(app, key);
        return false;
    }

    // The diagnostics view is a document with two keys of its own: `r` asks
    // the question the document is an answer to, and PgUp/PgDn walk it. Every
    // other key falls through to nothing — there is no field to type into and
    // no device listening on that screen.
    if app.view == View::Diagnostics && !ctrl {
        match key.code {
            KeyCode::Char('r') => {
                app.refresh_diagnostics();
                return false;
            }
            KeyCode::PageUp => {
                app.scroll_diagnostics_up(10);
                return false;
            }
            KeyCode::PageDown => {
                app.scroll_diagnostics_down(10);
                return false;
            }
            _ => {}
        }
    }

    // The network view is a form and takes the keyboard first: its rows are
    // what Enter means there, and falling through to "the device's" would type
    // a newline into the console every time somebody pressed an action.
    if app.view == View::Network && linkr_tui::views::network::handle_key(app, key) {
        return false;
    }

    // The assistant is a form too, and the same reasoning applies with more
    // force: it has a composer, and a composer that types a newline into the
    // console on every Enter is not a composer.
    if app.view == View::Assistant && views::assistant::handle_key(app, key) {
        return false;
    }

    // Only the terminal view is the device's keyboard. A key that reaches
    // another view and no handler there meant nothing by it, and typing it
    // blind into a console the user is not looking at is not what they meant
    // either — so what is left is the device's only when its screen is up.
    if app.view != View::Terminal {
        return false;
    }

    // The keyboard is on the pane: everything left is the device's.
    match key.code {
        // PageUp/PageDown walk the pane's own history rather than the device's
        // scroll buffer: without a VT screen there is no device scroll to walk.
        // They do not spend the latch: a latch is a modifier for the next key
        // sent, and a key that only scrolls the *view* is not sent.
        KeyCode::PageUp => app.scroll_terminal(10),
        KeyCode::PageDown => app.scroll_terminal_down(10),
        KeyCode::End => app.scroll_terminal_to_bottom(),
        _ => {
            let key = latch_key(app, key);
            if let Some(bytes) =
                key_bytes(key, app.enter, app.terminal.vt().application_cursor_keys())
            {
                // The escape byte is the wire's way out, and it is checked
                // before the keystroke is sent: sending it and *then* leaving
                // would put a stray control character into the device's input,
                // which is the one thing an escape key must never do.
                if bytes.as_bytes() == [app.escape] {
                    app.request_quit();
                    return true;
                }
                app.type_bytes(key.code == KeyCode::Enter, &bytes);
            }
        }
    }
    false
}

/// Whether the assistant's composer is the thing this keyboard would type
/// into.
///
/// Two paints hold a composer — the docked panel and the full-width view — and
/// the chords that belong to the assistant are scoped by this rather than bound
/// globally, because each of them is a key a shell also wants. A dialog over
/// the view is not the composer, so the full-width half of the test says so.
#[cfg(any(feature = "tui", test))]
fn agent_has_the_keyboard(app: &App) -> bool {
    app.assistant_panel_focused()
        || (app.view == View::Assistant && app.focus == Focus::Terminal && !app.overlay_open())
}

/// Walk the keyboard sideways: the console and the assistant, with the rail
/// past the console's other edge.
///
/// Rightward travel from the pane is "go to the assistant", and the assistant
/// is wherever its conversation is on screen: the docked panel when the window
/// has room for it, the full-width view otherwise. A panel that is shut is
/// *opened* on the way in — a focus moved into a column the painter then drops
/// is a keyboard the user has lost — and a window with no room is told so
/// rather than half-served. Leftward travel is the way back: panel to pane,
/// full-width view to terminal view, pane to rail.
#[cfg(any(feature = "tui", test))]
fn focus_pane(app: &mut App, direction: isize) {
    if direction > 0 {
        match app.focus {
            // The rail is the leftmost stop; the assistant is the one after
            // the pane, so rightward travel reaches it in two steps.
            Focus::Sidebar => app.focus = Focus::Terminal,
            Focus::Terminal => {
                if app.view == View::Assistant {
                    // The assistant is already the whole screen, and there is
                    // no keystroke to spend on saying so.
                    return;
                }
                if app.panel_fits() {
                    app.assistant_panel = true;
                    app.focus = Focus::Assistant;
                } else {
                    let text = app.strings().asst_panel_narrow.to_string();
                    app.push_notice(linkr_tui::app::Notice {
                        text,
                        level: linkr_tui::event::NoticeLevel::Info,
                    });
                }
            }
            // The panel is the rightmost stop: rightward travel ends here.
            Focus::Assistant => {}
        }
        return;
    }

    match app.focus {
        Focus::Assistant => app.focus = Focus::Terminal,
        Focus::Terminal => {
            if app.view == View::Assistant {
                app.set_view(View::Terminal);
            } else {
                app.focus = Focus::Sidebar;
            }
        }
        // Leftward travel ends at the rail.
        Focus::Sidebar => {}
    }
}

/// Put `text` where the caret the user can see is, and say whether a field
/// took it.
///
/// The stack is the painter's: the palette, then the dialog, then whatever
/// view is up. `false` means no field was on screen to paste into, and the
/// caller decides what else a paste can mean there.
#[cfg(any(feature = "tui", test))]
fn paste_into_shown_field(app: &mut App, text: &str) -> bool {
    if app.palette.is_some() {
        palette::paste(app, text);
        return true;
    }
    if matches!(app.dialog, Some(dialogs::Dialog::Settings(_))) {
        views::assistant::paste_at_caret(app, text);
        return true;
    }
    if let Some(dialogs::Dialog::Prompt(prompt)) = &mut app.dialog {
        // A prompt's box is one line; a paste is not.
        prompt
            .field
            .insert_str(&text.replace("\r\n", " ").replace(['\r', '\n'], " "));
        // A paste is typing that arrived at once, and the field shows it the
        // way it shows a keystroke: the last character in the clear until its
        // moment passes.
        prompt.show_last_char();
        return true;
    }
    // A dialog with no field has no caret of its own, and a paste must not
    // reach past it to whatever is behind.
    if app.dialog.is_none() && app.assistant_panel_focused() {
        views::assistant::paste_at_caret(app, text);
        return true;
    }
    if app.dialog.is_none() && app.view == View::Assistant && app.focus == Focus::Terminal {
        views::assistant::paste_at_caret(app, text);
        return true;
    }
    false
}

/// The key with whatever the latch armed merged into its modifiers, and the
/// latch spent. Called only for keys that are the device's: a latch is that
/// key's modifier and nothing more, which is what makes it one-shot by
/// construction rather than by remembering to clear it.
#[cfg(any(feature = "tui", test))]
fn latch_key(app: &mut App, key: KeyEvent) -> KeyEvent {
    let latch = app.latch.take();
    if !latch.is_armed() {
        return key;
    }
    let mut key = key;
    if latch.ctrl {
        key.modifiers |= KeyModifiers::CONTROL;
    }
    if latch.shift {
        key.modifiers |= KeyModifiers::SHIFT;
    }
    if latch.alt {
        key.modifiers |= KeyModifiers::ALT;
    }
    key
}

/// Arm or cancel one modifier of the latch, and say which: a latch is
/// invisible until the key it was armed for, so the announcement is the only
/// feedback the first press gets.
#[cfg(any(feature = "tui", test))]
fn toggle_latch(
    app: &mut App,
    name: &str,
    which: fn(&mut linkr_tui::app::Latch) -> &mut bool,
) -> bool {
    let armed = {
        let flag = which(&mut app.latch);
        *flag = !*flag;
        *flag
    };
    let s = app.strings();
    let template = if armed {
        s.latch_armed
    } else {
        s.latch_disarmed
    };
    let text = linkr_tui::text::fill(template, &[name.to_string()]);
    app.push_notice(linkr_tui::app::Notice {
        text,
        level: linkr_tui::event::NoticeLevel::Info,
    });
    false
}

/// The bytes a keystroke sends to the device, or `None` for a key the device
/// has no use for. The named keys go through the ported `terminal_keys.js`
/// table, so the two clients cannot drift apart on what `F5` or `ArrowUp`
/// means.
///
/// `application_cursor_keys` is the mode the program on the device turned on
/// (`ESC [ ? 1 h`), read from the pane's screen: an arrow is then `ESC O A`
/// rather than `ESC [ A`, and a program that asked for the first reads the
/// second as three literal characters.
#[cfg(any(feature = "tui", test))]
fn key_bytes(key: KeyEvent, enter: EnterMode, application_cursor_keys: bool) -> Option<String> {
    let modifiers = TerminalModifiers {
        shift: key.modifiers.contains(KeyModifiers::SHIFT),
        ctrl: key.modifiers.contains(KeyModifiers::CONTROL),
        alt: key.modifiers.contains(KeyModifiers::ALT),
    };
    let named = |name: &str| keys::terminal_key_sequence(name, application_cursor_keys, &modifiers);
    let bytes = match key.code {
        KeyCode::Char(c) => keys::apply_input_modifiers(&c.to_string(), &modifiers),
        // Enter is the one key the command line may re-wire, because a target
        // that wants `\r` and is given `\n` simply never answers — and the
        // symptom looks exactly like a dead link.
        KeyCode::Enter => match enter.bytes() {
            Some(bytes) => bytes.to_string(),
            None => named("Enter"),
        },
        KeyCode::Backspace => named("Backspace"),
        KeyCode::Tab => named("Tab"),
        KeyCode::BackTab => named("Tab"),
        KeyCode::Esc => named("Escape"),
        KeyCode::Up => named("ArrowUp"),
        KeyCode::Down => named("ArrowDown"),
        KeyCode::Left => named("ArrowLeft"),
        KeyCode::Right => named("ArrowRight"),
        KeyCode::Home => named("Home"),
        KeyCode::End => named("End"),
        KeyCode::Delete => named("Delete"),
        KeyCode::Insert => named("Insert"),
        _ => return None,
    };
    if bytes.is_empty() {
        None
    } else {
        Some(bytes)
    }
}

/// The wall clock in `HH:MM:SS`, local time.
fn local_clock() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// One mouse gesture, folded into whatever the focused thing wants.
///
/// A wheel notch is one row over the rail and three lines over the pane, never
/// a page and never "whatever the terminal felt like". The wheel turns the way
/// a wheel turns everywhere — away from the user is up, towards the user is
/// down — and the pane resumes following when the wheel brings it home. That
/// is the whole reason the mouse gets captured at all: without it the wheel
/// belongs to the emulator, and an emulator in an alternate screen has nothing
/// to scroll, so it either does nothing or jumps.
///
/// A modal takes the wheel too: while one is up, the pane and the rail behind
/// it are not what the user is scrolling.
#[cfg(any(feature = "tui", test))]
fn handle_mouse(app: &mut App, mouse: crossterm::event::MouseEvent, cols: u16, rows: u16) {
    use crossterm::event::{MouseButton, MouseEventKind};

    // The modal answers the keyboard, and the wheel is a gesture the same way a
    // key is. The box's own paging keys are how it moves; a notch over it does
    // nothing rather than move a view the box is covering — moving the rail's
    // cursor there would be half an action, since the Enter that follows would
    // go to the modal.
    if app.overlay_open() {
        return;
    }

    // The assistant's text comes first: a press on the panel or on the view's
    // thread begins a run there rather than reaching the pane behind it — and
    // a drag or a release that belongs to a run in flight is answered here
    // wherever the pointer has wandered, because the gesture has to end with
    // the button that started it.
    if assistant_mouse(app, &mouse, cols, rows) {
        return;
    }

    match mouse.kind {
        // Away from the user: the rail walks up, the pane reads back into its
        // history.
        MouseEventKind::ScrollUp => {
            if app.focus == linkr_tui::app::Focus::Sidebar {
                app.cursor_up();
            } else {
                app.scroll_terminal(3);
            }
        }
        // Towards the user: the rail walks down, the pane walks back towards
        // the tail.
        MouseEventKind::ScrollDown => {
            if app.focus == linkr_tui::app::Focus::Sidebar {
                app.cursor_down();
            } else {
                app.scroll_terminal_down(3);
            }
        }
        // The drag. Two paints hold text a run can name: the pane, whose
        // lines are the emulator's own, and the assistant, whose thread the
        // two assistant paints lay out row by row — [`assistant_mouse`]
        // answers for that one before this is reached. Every other view is a
        // form whose rows exist as a paint and nowhere else. Which is why the
        // guard is the *view* and not the focus: with the rail focused, the
        // pane is still text under the pointer.
        MouseEventKind::Down(MouseButton::Left) if app.view == View::Terminal => {
            match pane_cell_at(app, cols, rows, mouse.column, mouse.row) {
                Some((line, col)) => app.terminal.press(line, col),
                // Inside the pane but past its text — the blank ground under
                // the newest line — is a press on nothing: it clears.
                None if painted_centre(app, cols, rows)
                    .contains(Position::new(mouse.column, mouse.row)) =>
                {
                    app.terminal.deselect();
                }
                None => {}
            }
        }
        MouseEventKind::Drag(MouseButton::Left) if app.view == View::Terminal => {
            if let Some((line, col)) = pane_cell_at(app, cols, rows, mouse.column, mouse.row) {
                app.terminal.drag_to(line, col);
            }
        }
        // Whatever the gesture built, when the button comes up. A run — a drag,
        // or a double-click's word — comes back as the text it covered, and
        // goes on the clipboard; a bare click returns nothing and has already
        // cleared.
        MouseEventKind::Up(MouseButton::Left) if app.view == View::Terminal => {
            if let Some(text) = app.terminal.release() {
                if !text.trim().is_empty() {
                    let notice = app.copy_text(&text);
                    app.push_notice(notice);
                }
            }
        }
        _ => {}
    }
}

/// The assistant's side of the mouse: a press on its text begins a run, a drag
/// follows, and the release copies what the run covered — the pane's own
/// gesture, over the rows the two assistant paints lay out.
///
/// Returns whether the event was the assistant's to answer. A press is only
/// the assistant's when the pointer is over one of its paints; anywhere else
/// it belongs to the pane, or to nobody. A drag or a release with a run in
/// flight is the assistant's wherever the pointer is, because the gesture has
/// to end with the button that started it.
#[cfg(any(feature = "tui", test))]
fn assistant_mouse(
    app: &mut App,
    mouse: &crossterm::event::MouseEvent,
    cols: u16,
    rows: u16,
) -> bool {
    use crossterm::event::{MouseButton, MouseEventKind};
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            let Some((region, cell, area)) =
                assistant_cell(app, cols, rows, mouse.column, mouse.row)
            else {
                return false;
            };
            views::assistant::begin_selection(app, region, cell, area);
            true
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if app.assistant.select.is_none() {
                return false;
            }
            // A pointer that left the paint (or crossed to the other one)
            // leaves the run where it was: the pane's drag behaves the same
            // way, and a run that jumped to the pointer's new column would
            // copy text the drag never visited.
            if let Some((region, cell, _)) =
                assistant_cell(app, cols, rows, mouse.column, mouse.row)
            {
                views::assistant::drag_selection(app, region, cell);
            }
            true
        }
        MouseEventKind::Up(MouseButton::Left) => {
            let Some(selection) = app.assistant.select.as_ref() else {
                return false;
            };
            let (run, text) = (selection.is_run(), selection.text());
            if !run {
                // A click, not a drag: it clears, the way a bare click on the
                // pane's text does, and copies nothing.
                views::assistant::clear_selection(app);
                return true;
            }
            // The run is kept on screen after the copy, the way the pane keeps
            // its own, so the user can see what was taken.
            if !text.trim().is_empty() {
                let notice = app.copy_text(&text);
                app.push_notice(notice);
            }
            true
        }
        _ => false,
    }
}

/// Where the pointer is in the assistant, when it is over it at all: which
/// paint, the cell within that paint's text area, and the area itself.
///
/// The areas are the painter's own — [`ui::panel_text_area`] and
/// [`ui::body_text_area`] are the arithmetic `draw_assistant` and
/// `draw_centre` run — so the cell a run names is the cell the frame painted
/// there.
#[cfg(any(feature = "tui", test))]
fn assistant_cell(
    app: &App,
    cols: u16,
    rows: u16,
    x: u16,
    y: u16,
) -> Option<(views::assistant::SelectRegion, (u16, u16), Rect)> {
    let area = ui::legacy::drawing_area(Rect::new(0, 0, cols, rows), app.legacy_console);
    let regions = ui::regions_for(area, app.sidebar_visible, app.panel_wanted());
    // The dock first: it sits beside the centre, so a point can be in one
    // paint or the other and never both.
    if regions.assistant.width > 0 {
        let area = ui::panel_text_area(regions.assistant);
        if let Some(cell) = cell_within(area, x, y) {
            return Some((views::assistant::SelectRegion::Panel, cell, area));
        }
    }
    if app.view == View::Assistant {
        let area = ui::body_text_area(app, regions.centre);
        if let Some(cell) = cell_within(area, x, y) {
            return Some((views::assistant::SelectRegion::View, cell, area));
        }
    }
    None
}

/// A screen point, as a cell of `area` — `(row, column)`, the pane's own
/// order.
#[cfg(any(feature = "tui", test))]
fn cell_within(area: Rect, x: u16, y: u16) -> Option<(u16, u16)> {
    if area.contains(Position::new(x, y)) {
        Some((y - area.y, x - area.x))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only a test names a link by kind: the binary itself deals in `Dial`s.
    use linkr_tui::transport::LinkKind;

    fn args(list: &[&str]) -> Args {
        let owned: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        parse_args("bee", &owned)
    }

    /// The BLE name is read, set, and restored from the command line, and the
    /// three are separate requests: a name and a reset are not both asked for.
    #[test]
    fn the_ble_name_flags_reach_the_request_they_name() {
        let read = args(&["--query-ble-name"]);
        assert_eq!(
            read.requests.queries,
            vec![linkr_tui::device::Query::BleName]
        );

        let set = args(&["--rename-ble", "Bench Bee"]);
        assert_eq!(set.requests.ble_name.as_deref(), Some("Bench Bee"));
        assert!(!set.requests.ble_name_default);

        let reset = args(&["--reset-ble-name"]);
        assert!(reset.requests.ble_name_default);
        assert!(reset.requests.ble_name.is_none());
    }

    /// `--exec` and its terms travel together, because they are one request
    /// with several answers to the question "how does it end": the marker is
    /// the default, `--idle` names the other, and `--timeout` is the same word
    /// a scan uses with a longer default.
    #[test]
    fn exec_travels_with_the_terms_it_was_asked_on() {
        let run = args(&["--exec", "df -h"])
            .exec_run()
            .expect("the command line names a command");
        assert_eq!(run.command, "df -h");
        assert_eq!(run.ending, linkr_tui::exec::cli::Ending::RcMarker);
        assert_eq!(run.timeout, linkr_tui::exec::cli::DEFAULT_TIMEOUT);
        assert_eq!(run.retry, 0);

        let run = args(&[
            "--exec",
            "df -h",
            "--idle",
            "400ms",
            "--timeout",
            "7",
            "--retry",
            "2",
        ])
        .exec_run()
        .expect("the command line names a command");
        assert_eq!(
            run.ending,
            linkr_tui::exec::cli::Ending::Idle(Duration::from_millis(400))
        );
        assert_eq!(run.timeout, Duration::from_secs(7));
        assert_eq!(run.retry, 2);
        // An idle window in seconds reads the way every other span does.
        assert_eq!(
            args(&["--exec", "x", "--idle", "1.5"])
                .exec_run()
                .expect("a command")
                .ending,
            linkr_tui::exec::cli::Ending::Idle(Duration::from_millis(1500))
        );
        assert_eq!(args(&["--no-terminal"]).exec_run(), None);
    }

    /// A configuration that needs a header is still configured after a
    /// restart. Leaving the headers out of the load was a bug with a long
    /// tail: the assistant validated, saved, reloaded, and then sent every
    /// request without its header — a model the view said was configured,
    /// answering nothing, with nothing on screen to say why.
    #[test]
    fn the_headers_of_a_saved_model_come_back_with_it() {
        let mut path = std::env::temp_dir();
        path.push(format!("linkr-headers-load-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let mut app = App {
            agent_store: Some(linkr_tui::agent::store::JsonFile::at(&path)),
            ..App::default()
        };
        if let Some(store) = app.agent_store.as_mut() {
            linkr_tui::agent::config::save_agent_config(
                store,
                &linkr_tui::agent::config::StoredAgentConfig {
                    endpoint: "https://api.example.com/v1".to_string(),
                    model: "gpt".to_string(),
                    api_key: "sk-x".to_string(),
                    headers: "X-Tenant: acme".to_string(),
                    ..Default::default()
                },
            );
        }

        load_agent_state(&mut app);

        let config = app.assistant.config.clone().expect("still configured");
        assert_eq!(
            config.headers,
            vec![("X-Tenant".to_string(), "acme".to_string())],
            "the request will carry the header it was configured with"
        );
        assert_eq!(
            app.assistant.headers, "X-Tenant: acme",
            "and the form shows it again, editable as it was typed"
        );
        assert!(app.assistant.configured);
        let _ = std::fs::remove_file(&path);
    }

    /// The dry run is the byte-level half of the contract: what a caller
    /// approves is what would be typed, and the length is part of it.
    #[test]
    fn a_dry_run_shows_the_bytes_a_command_would_send() {
        let run = args(&["--exec", "df -h"]).exec_run().expect("a command");
        let text = dry_run(&run, false);
        assert!(text.contains("LINKR_RC"), "the wrapper is visible: {text}");
        assert!(text.ends_with('\n'));
        let json = dry_run(&run, true);
        assert!(json.contains("\"wire\":"), "{json}");
        assert!(json.contains(&format!("\"bytes\":{}", run.wire().len())));
        assert!(json.starts_with('{') && json.ends_with("}\n"));
    }

    /// Capabilities is the one answer a caller can check a script against
    /// before running it, so it has to name the parts a script depends on.
    #[test]
    fn capabilities_names_the_contract_a_script_depends_on() {
        let json = capabilities("bee", true);
        assert!(json.starts_with("{\"version\":\""), "{json}");
        assert!(json.ends_with("}\n"));
        assert!(json.contains("\"exec\""), "{json}");
        assert!(json.contains("rc-marker"), "{json}");
        assert!(json.contains("\"exit_codes\""), "{json}");
        // The exit-code line is what a script reads before deciding to branch
        // on a status, so the one thing that is not obvious about it — whose
        // status a batch answers with — has to be in the text and not only in
        // the README.
        assert!(json.contains("batch"), "{json}");
        // And the two local readings a one-shot caller can now ask for.
        assert!(json.contains("\"query-lan\""), "{json}");
        assert!(json.contains("\"link-state\""), "{json}");
        // The checkup and the send-only mode are operations too, and the
        // subcommand names are the same runs written as words: a caller that
        // reads either form here can write both.
        assert!(json.contains("\"doctor\""), "{json}");
        assert!(json.contains("\"send\""), "{json}");
        assert!(
            json.contains(&format!(
                "\"subcommands\":{},",
                linkr_tui::cli::subcommands_json()
            )),
            "the subcommand list is not a flat JSON array: {json}"
        );
        assert!(json.contains("\"loopback\""), "{json}");
        assert!(json.contains("\"capabilities\""), "{json}");
        // The interface is an operation of the build that has one, and not of
        // the build that does not: the list says what *this* binary can be
        // asked for, because it is the contract a script reads.
        #[cfg(feature = "tui")]
        assert!(json.contains("\"tui\""), "{json}");
        #[cfg(not(feature = "tui"))]
        assert!(!json.contains("\"tui\""), "{json}");
        assert!(json.contains(&format!(
            "\"exec_timeout_ms\":{}",
            linkr_tui::exec::cli::DEFAULT_TIMEOUT.as_millis()
        )));

        let text = capabilities("bee", false);
        assert!(text.starts_with("bee "), "{text}");
        assert!(text.contains("--exec COMMAND"), "{text}");
        assert!(text.contains("Exit codes"), "{text}");
        #[cfg(feature = "tui")]
        assert!(text.contains("open the terminal"), "{text}");
        #[cfg(not(feature = "tui"))]
        assert!(!text.contains("open the terminal"), "{text}");
    }

    /// The flag table is what the parser matches on and what the help is
    /// generated from, so every one of the exec flags has to be in both — the
    /// same bidirectional check the rest of the table gets, run on the new
    /// names by name.
    #[test]
    fn the_exec_flags_are_parsed_and_documented() {
        for flag in [
            "--exec",
            "--idle",
            "--rc-marker",
            "--retry",
            "--dry-run",
            "--capabilities",
            "--connect-timeout",
        ] {
            assert!(
                cli::FLAGS.iter().any(|entry| entry.name == flag),
                "{flag} is missing from the flag table"
            );
        }
        // And the endings conflict rather than rank: `--rc-marker` with
        // `--idle` is a command line that has not decided.
        assert_eq!(args(&["--exec", "x", "--rc-marker"]).exec_idle, None);
    }

    /// The checkup and the send-only mode are actions like any other: named in
    /// the table a caller reads, parsed into the fields the one-shot run reads,
    /// and refused by the resident session — which answers what arrives on its
    /// own input, and cannot have a second reader of it. The mode and the
    /// refusal belong to the request path, so they are judged in the build
    /// that has one; the flags themselves are every build's to name.
    #[test]
    fn the_checkup_and_send_flags_are_parsed_and_documented() {
        for flag in ["--doctor", "--send"] {
            assert!(
                cli::FLAGS.iter().any(|entry| entry.name == flag),
                "{flag} is missing from the flag table"
            );
        }
        assert!(!args(&[]).doctor);
        assert!(args(&["--doctor"]).doctor);
        assert!(args(&["--doctor"]).send.is_none());
        assert_eq!(
            args(&["--send", "line"]).send,
            Some(linkr_tui::cli::Framing::Line)
        );
        assert_eq!(
            args(&["--send", "raw"]).send,
            Some(linkr_tui::cli::Framing::Raw)
        );
        // Both are things to do, so a command line that names one is a run and
        // not a request to open the terminal.
        #[cfg(feature = "cli")]
        {
            assert_eq!(Mode::from(&args(&["--doctor"]), "bee"), Mode::Cli);
            assert_eq!(Mode::from(&args(&["--send", "line"]), "bee"), Mode::Cli);
            for refused in [
                &["--serve", "--bridge", "-", "--doctor"][..],
                &["--serve", "--bridge", "-", "--send", "line"],
                &["--serve", "--bridge", "-", "--licenses"],
            ] {
                let why = serve_refusal(&args(refused)).expect("the session refuses it");
                assert!(why.contains("resident session"), "{refused:?}: {why}");
            }
        }
    }

    /// The wire settings are read off the command line in the forms the
    /// reference client takes, and the escape byte defaults to the one it
    /// reserves.
    #[test]
    fn the_wire_settings_parse_and_default_to_the_reference_clients() {
        assert_eq!(args(&[]).escape, 0x1d, "^] by default");
        assert!(!args(&[]).line_mode);
        assert!(!args(&[]).debug_io);
        assert!(args(&["--debug-io"]).debug_io);
        assert_eq!(
            args(&[]).enter,
            None,
            "unnamed, so the settings file decides"
        );
        assert_eq!(
            args(&["--log-file", "/tmp/rx.log"]).log_file.as_deref(),
            Some(std::path::Path::new("/tmp/rx.log"))
        );
        // How the terminal sends what is typed — the escape byte, the line
        // discipline, what ends a line — is the interface's to configure: the
        // build without one refuses those flags rather than accepting a
        // command line and dropping it, which `tests/usage.rs` says from
        // outside. The defaults above are what every build starts from; the
        // flags are parsed where there is a terminal to set.
        #[cfg(feature = "tui")]
        {
            assert_eq!(args(&["--escape", "^]"]).escape, 0x1d);
            assert_eq!(args(&["--escape", "0x02"]).escape, 0x02);
            assert!(args(&["--line-mode"]).line_mode);
            assert_eq!(args(&["--enter", "lf"]).enter, Some(EnterMode::Lf));
            assert_eq!(args(&["--enter", "CRLF"]).enter, Some(EnterMode::Crlf));
        }
    }

    /// `--loopback-test` takes its payload or falls back to `A`, and the next
    /// flag is never eaten as a payload — `--loopback-test --json` is a test
    /// with the default payload.
    #[test]
    fn the_loopback_payload_is_optional_and_never_a_flag() {
        assert_eq!(args(&[]).loopback, None);
        assert_eq!(args(&["--loopback-test"]).loopback.as_deref(), Some("A"));
        assert_eq!(
            args(&["--loopback-test", "hello"]).loopback.as_deref(),
            Some("hello")
        );
        let parsed = args(&["--loopback-test", "--json"]);
        assert_eq!(parsed.loopback.as_deref(), Some("A"));
        assert!(parsed.json, "--json was still read as a flag");
        assert_eq!(
            args(&["--loopback-timeout", "1.5"])
                .loopback_timeout
                .as_millis(),
            1500
        );
    }

    /// A WiFi scan is one of the things the bridge can be asked for, and it is
    /// what makes a script run rather than a terminal.
    #[test]
    fn a_wifi_scan_is_a_request_and_not_a_view() {
        let parsed = args(&["--wifi-scan"]);
        assert!(parsed.requests.wifi_scan);
        assert!(!parsed.requests.is_empty(), "so it runs and exits");
        assert!(args(&[]).requests.is_empty());
    }

    /// The three modes, and the one thing that tells them apart.
    ///
    /// Nothing else in the tool has had three reachable states: a command line
    /// either exited when it was done or never ran anything, and the configure
    /// a board and then watch it case had no spelling at all.
    #[cfg(feature = "cli")]
    #[test]
    fn the_three_modes_are_reachable_and_distinguishable() {
        // A plain launch is the terminal.
        assert_eq!(Mode::from(&args(&[]), "bee"), Mode::Tui);

        // Asking a question is asking for an answer, so the answer is what
        // arrives and then the program leaves.
        assert_eq!(
            Mode::from(&args(&["--query-info"]), "bee"),
            Mode::Cli,
            "a query asked and left"
        );

        // The script mode says so.
        assert_eq!(Mode::from(&args(&["--no-terminal"]), "bee"), Mode::Cli);
        // And it wins even with nothing asked for, which is the point: a
        // dial with no questions is still a script run.
        assert_eq!(
            Mode::from(&args(&["--no-terminal"]), "bee"),
            Mode::Cli,
            "a bare --no-terminal is a script run"
        );

        // The middle mode: leave the terminal until the questions are
        // answered, then take it over on the link that answered them.
        assert_eq!(
            Mode::from(&args(&["--cli-then-tui", "--query-uart"]), "bee"),
            Mode::CliThenTui
        );
        // And with nothing asked for, it is still the middle mode — that is a
        // way to open the terminal only, which the terminal alone cannot say.
        assert_eq!(
            Mode::from(&args(&["--cli-then-tui"]), "bee"),
            Mode::CliThenTui
        );
    }

    /// The two flags that name a mode are mutually exclusive, and a user who
    /// typed both has two sessions in mind and would get the wrong one. Saying
    /// so beats guessing which — and saying so exits, so what is checked here
    /// is that neither flag on its own is treated as the conflict.
    #[cfg(feature = "cli")]
    #[test]
    fn the_two_mode_flags_are_not_a_conflict_on_their_own() {
        assert_eq!(Mode::from(&args(&["--no-terminal"]), "bee"), Mode::Cli);
        assert_eq!(
            Mode::from(&args(&["--cli-then-tui"]), "bee"),
            Mode::CliThenTui
        );
    }

    /// The resident session is a mode of its own: the link is held and the
    /// input is answered until it ends, which is neither "ask and leave" nor
    /// "ask and then watch".
    ///
    /// The refusals exit, so they are checked from outside, in
    /// `tests/serve.rs`; what is checked here is the mode and the two lists
    /// that have to agree about it — the ready line's operations and the ones
    /// `--capabilities` prints.
    #[cfg(feature = "cli")]
    #[test]
    fn the_resident_session_is_a_mode_of_its_own() {
        assert!(!args(&[]).serve, "a session is asked for, never assumed");
        let parsed = args(&["--bridge", "-", "--serve"]);
        assert!(parsed.serve);
        assert_eq!(Mode::from(&parsed, "bee"), Mode::Serve);
        // A session holds the link the command line named, so naming one is
        // what it takes; the same mode either way, because what it dials is
        // the same question and the session answers it lazily.
        assert_eq!(
            Mode::from(&args(&["--ble-name", "Linkr", "--serve"]), "bee"),
            Mode::Serve
        );

        let json = capabilities("bee", true);
        assert!(json.contains("\"session\""), "{json}");
        assert!(
            json.contains(&linkr_tui::serve::operations_json()),
            "the session's operations and the ready line's disagree: {json}"
        );
    }

    /// The defaults are the designed first frame: Chinese, dark, connecting.
    #[test]
    fn defaults_are_the_designed_first_frame() {
        let parsed = args(&[]);
        // Unset, not defaulted: the settings file fills these when no flag
        // named one, and `parse_args` is not the place that knows the file.
        assert_eq!(parsed.lang, None);
        assert_eq!(parsed.theme, None);
        assert_eq!(parsed.state, None);
        assert_eq!(parsed.print_frame, None);
        assert!(!parsed.sample);
        assert_eq!(
            parsed.dial().expect("the command line parses"),
            None,
            "nothing is dialled by default"
        );
    }

    /// `--licenses` is an answer about the build, not a run: it parses in both
    /// faces and its report is the generated notice rather than a second list.
    #[test]
    fn the_licence_flag_asks_for_no_link() {
        assert!(!args(&[]).licenses, "licences are asked for, never assumed");
        assert!(args(&["--licenses"]).licenses);
        let report = licenses::cli_report("bee");
        assert!(report.contains("ratatui"), "{report}");
        assert!(report.contains("Contributors"), "{report}");
        assert!(report.contains("Transitive dependencies"), "{report}");
    }

    /// Flags parse to the state they name.
    #[test]
    fn flags_parse_to_their_state() {
        let parsed = args(&["--lang", "en", "--theme", "light", "--state", "connected"]);
        assert_eq!(parsed.lang, Some(Lang::En));
        assert_eq!(parsed.theme, Some(ThemeChoice::Light));
        assert_eq!(parsed.state, Some(ConnectionState::Connected));
        for (raw, expected) in [
            ("disconnected", ConnectionState::Disconnected),
            ("connecting", ConnectionState::Connecting),
            ("connected", ConnectionState::Connected),
            ("failed", ConnectionState::Failed),
        ] {
            assert_eq!(args(&["--state", raw]).state, Some(expected), "{raw}");
        }
    }

    /// `--view` opens on the view it names, and a name that is not a view is
    /// refused rather than silently ignored.
    #[test]
    fn the_view_flag_selects_a_view_by_name() {
        assert_eq!(args(&[]).view, None);
        for view in View::ALL {
            assert_eq!(args(&["--view", view.as_str()]).view, Some(view));
        }
        assert_eq!(args(&["--view", "network"]).view, Some(View::Network));
    }

    /// `--sample` fills the frame, and it implies an answered link unless the
    /// command line named a state of its own.
    #[test]
    fn sample_fills_the_frame_and_implies_a_connected_link() {
        let mut app = App::default();
        let parsed = args(&["--sample", "--print-frame"]);
        assert!(parsed.sample);
        assert_eq!(parsed.state, None, "no state was named");

        // The resolution `main` performs, without a terminal.
        app.diagnostics
            .apply(&views::sample_reply(), "19:08:06".into());
        app.terminal.push_text(views::terminal::SAMPLE);
        assert!(app.diagnostics.has_data());
        assert!(app.diagnostics.done);
        assert_eq!(app.diagnostics.updated.as_deref(), Some("19:08:06"));
        assert!(
            !app.terminal.is_empty(),
            "the sample fills the pane as well as the grid"
        );

        // An explicit state still wins.
        assert_eq!(
            args(&["--sample", "--state", "failed"]).state,
            Some(ConnectionState::Failed)
        );
    }

    /// The frame size is optional and parses both ways.
    #[test]
    fn the_frame_size_is_optional() {
        assert_eq!(args(&["--print-frame"]).print_frame, Some((100, 30)));
        assert_eq!(
            args(&["--print-frame", "80x24"]).print_frame,
            Some((80, 24))
        );
        assert_eq!(args(&["--print-frame", "1x1"]).print_frame, Some((1, 1)));
        // A flag straight after --print-frame is not swallowed as a size.
        let parsed = args(&["--print-frame", "--theme", "light"]);
        assert_eq!(parsed.print_frame, Some((100, 30)));
        assert_eq!(parsed.theme, Some(ThemeChoice::Light));
    }

    /// The clock is always `HH:MM:SS`: eight characters, two colons.
    #[test]
    fn the_clock_is_well_formed() {
        let clock = local_clock();
        assert_eq!(clock.len(), 8, "{clock:?}");
        assert_eq!(clock.matches(':').count(), 2, "{clock:?}");
        for part in clock.split(':') {
            assert_eq!(part.len(), 2);
            assert!(part.chars().all(|c| c.is_ascii_digit()));
        }
    }

    /// F2–F5 select the views; F6 is the assistant panel's toggle and leaves
    /// the view be; any other function key changes nothing.
    #[test]
    fn the_view_keys_select_views() {
        let mut app = App::default();
        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::F(4), KeyModifiers::NONE)
        ));
        assert_eq!(app.view, View::Network);
        // F5 is the last view. F6 toggles the assistant's column instead of
        // moving the view, and F7 is still unbound and must leave it be.
        handle_key(&mut app, KeyEvent::new(KeyCode::F(5), KeyModifiers::NONE));
        assert_eq!(app.view, View::Assistant);
        handle_key(&mut app, KeyEvent::new(KeyCode::F(6), KeyModifiers::NONE));
        assert_eq!(
            app.view,
            View::Assistant,
            "the panel's key must not move the view"
        );
        assert!(!app.assistant_panel, "F6 did not toggle the panel");
        handle_key(&mut app, KeyEvent::new(KeyCode::F(7), KeyModifiers::NONE));
        assert_eq!(
            app.view,
            View::Assistant,
            "an unbound F-key must not move the view"
        );
        // F1 is help, not a view: it opens the overlay and leaves the view be.
        handle_key(&mut app, KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE));
        assert_eq!(app.view, View::Assistant, "F1 is help, not a view");
        assert!(
            matches!(app.dialog, Some(linkr_tui::dialogs::Dialog::Help(0))),
            "F1 opened the help: {:?}",
            app.dialog
        );
    }

    /// The diagnostics view hears the two keys its own hint names: `r` asks
    /// the bridge, and PgUp/PgDn walk the document — keys that mean nothing on
    /// any other screen.
    #[test]
    fn the_diagnostics_view_hears_its_own_keys() {
        let mut app = App::default();
        app.set_view(View::Diagnostics);
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
        );
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
        );
        assert_eq!(app.diagnostics.scroll, 20);
        handle_key(&mut app, KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
        assert_eq!(app.diagnostics.scroll, 10);
        // `r` with no link is not silence: the notice says why it could not ask.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE),
        );
        assert!(!app.notices.is_empty(), "the refusal is said out loud");

        // On any other view the keys are not the document's.
        app.set_view(View::Terminal);
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
        );
        assert_eq!(
            app.diagnostics.scroll, 10,
            "the terminal has its own scroll"
        );
    }

    /// Ctrl+Shift+K lands on the composer; Ctrl+Shift+S raises the settings
    /// window on the endpoint. Both are doors into the assistant, and a door
    /// that opened the view but left the keyboard elsewhere would save a
    /// keystroke and cost two.
    #[test]
    fn the_assistant_chords_land_where_the_work_is() {
        let mut app = App::default();
        handle_key(
            &mut app,
            KeyEvent::new(
                KeyCode::Char('K'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
        );
        assert_eq!(app.view, View::Assistant);
        assert_eq!(
            app.assistant.focus,
            linkr_tui::views::assistant::AgentField::Composer
        );
        assert!(app.dialog.is_none(), "the composer is not a window");

        handle_key(
            &mut app,
            KeyEvent::new(
                KeyCode::Char('S'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
        );
        assert!(
            matches!(app.dialog, Some(linkr_tui::dialogs::Dialog::Settings(_))),
            "Ctrl+Shift+S did not raise the window: {:?}",
            app.dialog
        );
        assert_eq!(
            app.assistant.focus,
            linkr_tui::views::assistant::AgentField::Endpoint,
            "the configure chord lands on the field the notice names"
        );

        // Escape from the window hands the caret back to the composer, or the
        // next keystroke would be typed into a row nothing is painting.
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "Escape did not close the window");
        assert_eq!(
            app.assistant.focus,
            linkr_tui::views::assistant::AgentField::Composer
        );
    }

    /// Ctrl+B hides the rail and brings it back, and the keyboard the rail was
    /// holding comes back with it. The rail costs thirty columns, and those
    /// columns are the difference between a console that fits a table and one
    /// that wraps it.
    #[test]
    fn ctrl_b_hides_and_shows_the_rail() {
        let mut app = App::default();
        assert!(app.sidebar_visible, "the rail starts shown");

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL),
        );
        assert!(!app.sidebar_visible, "Ctrl+B did not hide the rail");
        assert!(!app.notices.is_empty(), "hiding the rail said nothing");
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL),
        );
        assert!(app.sidebar_visible, "Ctrl+B did not bring it back");

        // Hiding it while the keyboard is on it hands the keyboard back: a
        // focus in a column nothing is painting is a keyboard the user lost.
        app.focus = Focus::Sidebar;
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL),
        );
        assert_eq!(
            app.focus,
            Focus::Terminal,
            "the keyboard stayed on the rail"
        );
    }

    /// Ctrl+Left and Ctrl+Right walk between the console and the assistant,
    /// past the rail on the way: rightward from the pane is "the
    /// conversation", leftward is the way back — and a panel that is shut is
    /// opened by the same chord rather than focused where nobody can see it.
    #[test]
    fn ctrl_left_and_right_walk_the_panes() {
        let mut app = App {
            // The frame the keys are handled in: the fit test reads it, and a
            // window with no size has no room for anything.
            screen: Rect::new(0, 0, 140, 30),
            ..App::default()
        };

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL),
        );
        assert_eq!(
            app.focus,
            Focus::Assistant,
            "right did not reach the assistant"
        );
        assert!(app.assistant_panel, "the panel was closed on arrival");

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL),
        );
        assert_eq!(app.focus, Focus::Terminal, "left did not come back");
        assert!(app.assistant_panel, "left closed the panel");

        // Left again reaches the rail, and right returns to the pane — the
        // assistant is the stop after that, not this one.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL),
        );
        assert_eq!(app.focus, Focus::Sidebar, "left did not reach the rail");
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL),
        );
        assert_eq!(app.focus, Focus::Terminal, "right skipped the pane");

        // A panel that is shut and has room is opened on the way in: asking
        // for the conversation with the keyboard is asking for it to be there.
        app.assistant_panel = false;
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL),
        );
        assert!(app.assistant_panel, "right did not open the panel");
        assert_eq!(app.focus, Focus::Assistant);

        // The full-width view is the assistant too: left comes back to the
        // terminal view, and right has nowhere further to go.
        let mut wide = App {
            screen: Rect::new(0, 0, 140, 30),
            ..App::default()
        };
        wide.set_view(View::Assistant);
        handle_key(
            &mut wide,
            KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL),
        );
        assert_eq!(wide.view, View::Assistant, "right left the assistant view");
        handle_key(
            &mut wide,
            KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL),
        );
        assert_eq!(wide.view, View::Terminal, "left did not leave the view");
    }

    /// An app with a live link and a frame's worth of screen: the loopback the
    /// other device tests use. A keystroke can only be counted as *sent* when
    /// there is something to send it over, so a test that watches the wire has
    /// to have one.
    fn linked_app(screen: Rect) -> App {
        let mut app = App {
            screen,
            ..App::default()
        };
        app.connect(Dial::Stdio("-".into()).open().expect("the loopback builds"))
            .expect("the loopback opens");
        for _ in 0..50 {
            app.pump();
            if app.connected() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(app.connected(), "the loopback came up");
        app
    }

    /// A window with no room for the panel says so rather than moving the
    /// keyboard into a column that is not painted.
    #[test]
    fn a_window_with_no_room_keeps_the_keyboard_in_the_pane() {
        let mut app = App {
            screen: Rect::new(0, 0, 80, 24),
            ..App::default()
        };
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL),
        );
        assert_eq!(app.focus, Focus::Terminal, "the keyboard left the pane");
        assert!(!app.notices.is_empty(), "the refusal was silent");
    }

    /// F6 is the assistant column's key, and it makes the same bargain
    /// `Ctrl+B` makes for the rail: it works wherever the keyboard is,
    /// closing hands the keyboard back, opening from another view brings the
    /// terminal with it — and a window with no room says so rather than
    /// flipping a state nothing paints.
    #[test]
    fn f6_toggles_the_assistant_panel() {
        let mut app = App {
            screen: Rect::new(0, 0, 140, 30),
            ..App::default()
        };
        assert!(app.assistant_panel, "the panel starts open");
        let chord = KeyEvent::new(KeyCode::F(6), KeyModifiers::NONE);

        handle_key(&mut app, chord);
        assert!(!app.assistant_panel, "F6 did not put it away");

        handle_key(&mut app, chord);
        assert!(app.assistant_panel, "the key did not bring it back");

        // Hiding it while the keyboard is on it hands the keyboard back, the
        // rule the rail's toggle follows too.
        app.focus = Focus::Assistant;
        handle_key(&mut app, chord);
        assert_eq!(app.focus, Focus::Terminal, "the keys stayed in the column");
        assert!(!app.assistant_panel);

        // The column belongs to the terminal view, so asking for it from the
        // full-width view brings the terminal back rather than opening it
        // where nothing paints it.
        app.set_view(View::Assistant);
        handle_key(&mut app, chord);
        assert_eq!(app.view, View::Terminal, "the view did not come back");
        assert!(app.assistant_panel, "the panel did not open with it");

        // A window with no room cannot show what was asked for: the toggle
        // refuses and says why, the same words the focus walk uses.
        app.screen = Rect::new(0, 0, 80, 24);
        assert!(!app.panel_fits(), "the narrow window still fits the panel");
        handle_key(&mut app, chord);
        assert!(!app.assistant_panel, "the panel closed, not opened");
        let noticed = app.notices.len();
        handle_key(&mut app, chord);
        assert!(!app.assistant_panel, "a column with no room was opened");
        assert!(app.notices.len() > noticed, "the refusal was silent");
    }

    /// The panel's keys are the panel's: a letter goes to the composer and not
    /// to the wire, Escape hands the keyboard back, and a control character
    /// with no chord of its own reaches nobody — least of all the live console
    /// behind a chat column.
    #[test]
    fn the_panel_keeps_the_console_off_the_keyboard() {
        let mut app = linked_app(Rect::new(0, 0, 140, 30));
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL),
        );
        assert_eq!(app.focus, Focus::Assistant);

        let typed = app.tx;
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE),
        );
        assert_eq!(app.assistant.chat().composer, "l", "the composer missed it");
        assert_eq!(app.tx, typed, "a letter reached the device");

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL),
        );
        assert_eq!(app.tx, typed, "Ctrl+D reached the device");

        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.focus, Focus::Terminal, "Escape did not hand back");
        assert!(app.assistant_panel, "Escape closed the panel");
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
        );
        assert!(app.tx > typed, "the pane took the keyboard back");

        // The palette opens over the console, and neither the query nor an
        // unbound control chord reaches the device behind it: an overlay is a
        // barrier, which is what falling through one should have meant all
        // along.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        );
        assert!(app.palette.is_some(), "Ctrl+P did not open the palette");
        let before = app.tx;
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL),
        );
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE),
        );
        assert_eq!(app.tx, before, "the overlay leaked to the device");
    }

    /// The assistant's own chords only answer when the assistant has the
    /// keyboard: `Ctrl+N` is a new conversation in the panel and the shell's
    /// next-history line in the pane, and both are what the user in front of
    /// them meant by it.
    #[test]
    fn the_assistant_chords_are_scoped_to_the_assistant() {
        let mut app = linked_app(Rect::new(0, 0, 140, 30));

        // The pane has the keyboard: the device gets the key.
        let before = app.tx;
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL),
        );
        assert_eq!(
            app.assistant.chats.len(),
            1,
            "a page was made from the pane"
        );
        assert!(app.tx > before, "Ctrl+N did not reach the device");

        // The panel has it: a new conversation, and nothing to the wire.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL),
        );
        let before = app.tx;
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL),
        );
        assert_eq!(app.assistant.chats.len(), 2, "Ctrl+N made no conversation");
        assert_eq!(app.tx, before, "Ctrl+N reached the device from the panel");

        // Alt+Up and Alt+Down walk the list from there.
        let open = app.assistant.chat().id;
        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::ALT));
        assert_ne!(app.assistant.chat().id, open, "Alt+Down did not switch");
        assert_eq!(app.tx, before, "the walk reached the device");
        handle_key(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));
        assert_eq!(app.assistant.chat().id, open, "Alt+Up did not switch back");
    }

    /// Ctrl+Q and Ctrl+C stop the loop while nothing is connected; a bare 'q'
    /// does not, so the terminal stays open while the user is typing to the
    /// device.
    #[test]
    fn only_the_control_keys_quit() {
        let mut app = App::default();
        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE)
        ));
        assert!(handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)
        ));
        assert!(handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
        ));
    }

    /// An open link and a pane holding the keyboard change Ctrl+C's meaning:
    /// it interrupts the device, exactly as it would in any serial console.
    /// The rail, a form and a dead link all keep the old one.
    #[test]
    fn ctrl_c_interrupts_the_device_while_the_pane_has_the_keyboard() {
        let mut app = App::default();
        app.connect(Dial::Stdio("-".into()).open().expect("the loopback builds"))
            .expect("the loopback opens");
        for _ in 0..50 {
            app.pump();
            if app.connected() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(app.connected(), "the loopback came up");

        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
        ));
        assert!(!app.quit, "the interrupt did not quit the interface");
        assert_eq!(app.tx, 1, "the interrupt byte left for the device");

        // The rail has the keyboard: the chord is the program's again.
        app.focus = Focus::Sidebar;
        assert!(handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
        ));
    }

    /// A key nothing claimed is the device's *only* in the terminal view: the
    /// other views show a screen those bytes would not land on, so a letter
    /// typed while looking at them goes nowhere.
    #[test]
    fn only_the_terminal_view_types_to_the_device() {
        let mut app = App::default();
        app.connect(Dial::Stdio("-".into()).open().expect("the loopback builds"))
            .expect("the loopback opens");
        for _ in 0..50 {
            app.pump();
            if app.connected() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(app.connected(), "the loopback came up");

        let letter = KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE);
        assert!(!handle_key(&mut app, letter));
        assert_eq!(app.tx, 1, "the terminal view sends what it does not claim");

        for view in [View::Diagnostics, View::Network] {
            app.set_view(view);
            assert!(!handle_key(&mut app, letter));
            assert_eq!(app.tx, 1, "{view:?} does not type into the console");
        }

        // The assistant keeps the letter for its composer, which is the
        // handler's own doing and not the device's.
        app.set_view(View::Assistant);
        assert!(!handle_key(&mut app, letter));
        assert_eq!(app.assistant.chat().composer, "x");
        assert_eq!(app.tx, 1, "the composer is not the wire");
    }

    /// A shifted chord is the same chord in either spelling a keyboard
    /// protocol reports: `Ctrl+Shift+R` arrives as `R` where the protocol
    /// reports the shifted character and as `r` carrying the shift flag where
    /// it reports the base one, and both arm the Shift latch.
    #[test]
    fn a_shifted_chord_matches_in_either_spelling() {
        let mut app = App::default();
        handle_key(
            &mut app,
            KeyEvent::new(
                KeyCode::Char('r'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
        );
        assert!(app.latch.shift, "the lowercase spelling armed Shift");
        handle_key(
            &mut app,
            KeyEvent::new(
                KeyCode::Char('R'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
        );
        assert!(
            !app.latch.shift,
            "the uppercase spelling cancels what it armed"
        );
    }

    /// A paste goes to the caret the user can see, in the painter's order: the
    /// palette's query, a dialog's box, the assistant's field — and a dialog
    /// with no field takes nothing rather than letting the paste reach past
    /// it.
    #[test]
    fn a_paste_goes_where_the_caret_is_painted() {
        let mut app = App::default();

        // Nothing is up and no view asked: the caller decides what a paste
        // means there, and for the terminal view that is the device.
        assert!(!paste_into_shown_field(&mut app, "ls\n-l"));

        palette::open(&mut app);
        assert!(paste_into_shown_field(&mut app, "the\nme"));
        assert_eq!(
            app.palette.as_ref().map(|state| state.query.as_str()),
            Some("the me"),
            "the query took it as one line"
        );
        app.palette = None;

        dialogs::prompt_wifi_ssid(&mut app);
        assert!(paste_into_shown_field(&mut app, "Home\nNet"));
        let Some(dialogs::Dialog::Prompt(prompt)) = &app.dialog else {
            panic!("the prompt is up: {:?}", app.dialog);
        };
        assert_eq!(prompt.field.text, "Home Net");
        app.dialog = None;

        app.set_view(View::Assistant);
        assert!(paste_into_shown_field(&mut app, "explain\nthe log"));
        assert_eq!(app.assistant.chat().composer, "explain the log");

        dialogs::open_help(&mut app);
        assert!(
            !paste_into_shown_field(&mut app, "x"),
            "a fieldless dialog is not a door past it"
        );

        // The docked panel is the composer's other paint, so the paste lands
        // on the caret the user can see there too.
        let mut docked = App {
            focus: Focus::Assistant,
            ..App::default()
        };
        assert!(paste_into_shown_field(&mut docked, "df\n-h"));
        assert_eq!(docked.assistant.chat().composer, "df -h");

        // And a dialog over the panel is a barrier, exactly as it is over the
        // view: neither caret is the one on screen.
        dialogs::open_help(&mut docked);
        assert!(
            !paste_into_shown_field(&mut docked, "x"),
            "the panel took a paste past a dialog"
        );
        assert_eq!(docked.assistant.chat().composer, "df -h");
    }

    /// Ctrl+T opens the theme picker — no more one-theme-per-press cycling —
    /// and moving on the list previews by moving the theme itself: the frame
    /// repaints under the cursor, and Escape puts back what was there.
    #[test]
    fn control_t_opens_the_theme_picker_and_the_arrows_preview() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL),
        );
        let Some(dialogs::Dialog::ThemePick(pick)) = &app.dialog else {
            panic!("Ctrl+T did not open the picker: {:?}", app.dialog);
        };
        assert_eq!(pick.cursor, 0, "the cursor starts on the live theme");
        assert_eq!(app.theme, ThemeChoice::Dark, "and nothing has moved yet");

        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.theme, ThemeChoice::Light, "the preview is the theme");
        assert!(app.notices.is_empty(), "a preview is not an announcement");

        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "Escape closed the window");
        assert_eq!(app.theme, ThemeChoice::Dark, "and put the old one back");
    }

    /// Enter keeps the theme under the cursor, says so once, and closes.
    #[test]
    fn the_picker_keeps_what_enter_lands_on() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL),
        );
        for _ in 0..2 {
            handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "Enter closed the window");
        assert_eq!(app.theme, ThemeChoice::Nord);
        assert_eq!(app.notices.len(), 1);
        assert_eq!(app.notices[0].text, "Theme: Nord");
    }

    /// The chord that opened the window closes it, and closing is *cancel*: a
    /// preview nobody kept is not a choice. A different window in the way is
    /// left alone rather than replaced.
    #[test]
    fn control_t_again_cancels_and_leaves_other_windows_alone() {
        let mut app = App::default();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL),
        );
        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.theme, ThemeChoice::Light);
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL),
        );
        assert!(app.dialog.is_none());
        assert_eq!(app.theme, ThemeChoice::Dark, "the preview was cancelled");

        dialogs::open_help(&mut app);
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL),
        );
        assert!(
            matches!(app.dialog, Some(dialogs::Dialog::Help(_))),
            "the help is still up"
        );
        assert_eq!(app.theme, ThemeChoice::Dark, "and the picker stayed away");
    }

    /// Ctrl+L clears the pane and nothing else — the device is not sent a
    /// character, and the counters are not moved.
    #[test]
    fn control_l_clears_the_pane() {
        let mut app = App::default();
        app.terminal.push_text("stale output\n");
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL),
        );
        assert!(app.terminal.is_empty());
        assert_eq!(app.tx, 0, "clear is local, not a keystroke");
    }

    /// Tab belongs to the device — completion is the most-used key a shell
    /// has — and the rail is entered with Ctrl+Up and left with Esc. The
    /// sidebar cursor never walks past the last selectable row.
    #[test]
    fn tab_reaches_the_device_and_ctrl_up_moves_the_focus() {
        let mut app = App::default();
        assert_eq!(app.focus, Focus::Terminal);
        handle_key(&mut app, KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.focus, Focus::Terminal, "Tab did not steal the focus");

        handle_key(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::CONTROL));
        assert_eq!(app.focus, Focus::Sidebar);
        for _ in 0..100 {
            handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        let last = linkr_tui::ui::sidebar::targets(&app).len() - 1;
        assert_eq!(app.sidebar_cursor, last, "the cursor ran past the last row");
        for _ in 0..100 {
            handle_key(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        }
        assert_eq!(app.sidebar_cursor, 0);
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.focus, Focus::Terminal, "Esc hands the keyboard back");
    }

    /// The one-shot latch: arming says which modifier, the next key carries it
    /// and spends it, and the same chord cancels instead.
    #[test]
    fn the_latch_arms_a_modifier_for_the_next_key() {
        let mut app = App::default();
        // Arm Ctrl for the next key.
        handle_key(
            &mut app,
            KeyEvent::new(
                KeyCode::Char('C'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
        );
        assert!(app.latch.ctrl, "Ctrl is armed");
        assert_eq!(app.log.last().map(|n| n.text.contains("Ctrl")), Some(true));

        // A plain 'c' goes out as Ctrl+C (0x03) — link or no link, the byte is
        // what the encoder builds — and the latch is spent by it.
        let key = latch_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::NONE),
        );
        assert!(key.modifiers.contains(KeyModifiers::CONTROL));
        assert!(!app.latch.is_armed(), "one key spends the latch");

        // The same chord again cancels what it would have armed.
        handle_key(
            &mut app,
            KeyEvent::new(
                KeyCode::Char('C'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
        );
        handle_key(
            &mut app,
            KeyEvent::new(
                KeyCode::Char('C'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
        );
        assert!(!app.latch.is_armed(), "the chord toggles");
    }

    /// The pane's keys are the device's, and they go out as the byte sequences
    /// `terminal_keys.js` specifies — the two clients cannot drift apart here.
    #[test]
    fn the_pane_keys_send_the_ported_sequences() {
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE),
                EnterMode::Raw,
                false,
            ),
            Some("a".into())
        );
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                EnterMode::Raw,
                false,
            ),
            Some("\r".into())
        );
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
                EnterMode::Raw,
                false,
            ),
            Some("\u{7f}".into())
        );
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
                EnterMode::Raw,
                false,
            ),
            Some("\t".into())
        );
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                EnterMode::Raw,
                false,
            ),
            Some("\u{1b}".into())
        );
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Up, KeyModifiers::NONE),
                EnterMode::Raw,
                false,
            ),
            Some("\u{1b}[A".into())
        );
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE),
                EnterMode::Raw,
                false,
            ),
            Some("\u{1b}[3~".into())
        );
        // Ctrl+C on the pane is the interrupt, not a quit: the chord is the
        // device's once the global binding has been checked.
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                EnterMode::Raw,
                false,
            ),
            Some("\u{3}".into())
        );
        // Shift+Tab is the back-tab the device expects.
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Tab, KeyModifiers::SHIFT),
                EnterMode::Raw,
                false,
            ),
            Some("\u{1b}[Z".into())
        );
        // A key the device has no use for sends nothing at all.
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::F(9), KeyModifiers::NONE),
                EnterMode::Raw,
                false,
            ),
            None
        );
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Null, KeyModifiers::NONE),
                EnterMode::Raw,
                false,
            ),
            None
        );
    }

    /// A program that turned application cursor keys on gets the `SS3` form:
    /// `vim` and `less` read `ESC O A` as an arrow and `ESC [ A` as three
    /// literal characters. The mode is the device's own, read from the pane's
    /// screen — see [`crate::vt::Vt::application_cursor_keys`].
    #[test]
    fn the_application_cursor_mode_reaches_the_keys() {
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Up, KeyModifiers::NONE),
                EnterMode::Raw,
                true
            ),
            Some("\u{1b}OA".into())
        );
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Up, KeyModifiers::NONE),
                EnterMode::Raw,
                false
            ),
            Some("\u{1b}[A".into())
        );
        // Home is spelled the same two ways; a key the mode does not reach is
        // unchanged.
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Home, KeyModifiers::NONE),
                EnterMode::Raw,
                true
            ),
            Some("\u{1b}OH".into())
        );
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE),
                EnterMode::Raw,
                true
            ),
            Some("\u{1b}[3~".into())
        );
    }

    /// A dial is what the command line asked for: `--bridge` reaches a process,
    /// `--bridge` names a process and nothing else names a link at all.
    #[test]
    fn the_dial_follows_the_command_line() {
        assert_eq!(
            args(&["--bridge", "cat"])
                .dial()
                .expect("the command line parses"),
            Some(Dial::Stdio("cat".into()))
        );
        assert_eq!(
            args(&["--bridge", "-"])
                .dial()
                .expect("the command line parses"),
            Some(Dial::Stdio("-".into())),
            "the loopback is spelled -"
        );
        // Both: the bridge is the way in, and it wins rather than erroring.
        assert_eq!(
            args(&["--ble-name", "Linkr", "--bridge", "cat"])
                .dial()
                .expect("the command line parses"),
            Some(Dial::Stdio("cat".into()))
        );
    }

    /// A Bluetooth dial is aimed either by address or by name, and an address
    /// is the stronger claim of the two: a name finds a board *like* the one
    /// meant, an address finds it. With neither, it takes whatever is on the
    /// air — right for a bench with one board, which most are.
    #[test]
    fn a_bluetooth_dial_is_aimed_by_address_then_by_name() {
        assert_eq!(
            args(&["--transport", "ble"])
                .dial()
                .expect("the command line parses"),
            Some(Dial::Ble(Selection::Any, None)),
            "pinned to Bluetooth and nothing named: whichever one it finds"
        );
        assert_eq!(
            args(&["--ble-name", "Linkr"])
                .dial()
                .expect("the command line parses"),
            Some(Dial::Ble(Selection::Name("Linkr".into()), None))
        );
        assert_eq!(
            args(&["--ble-address", "EE:C7:42:34:48:CF"])
                .dial()
                .expect("the command line parses"),
            Some(Dial::Ble(
                Selection::Address("EE:C7:42:34:48:CF".into()),
                None
            ))
        );
        assert_eq!(
            args(&[
                "--ble-name",
                "Linkr",
                "--ble-address",
                "EE:C7:42:34:48:CF",
                "--connect-timeout",
                "9"
            ])
            .dial()
            .expect("the command line parses"),
            Some(Dial::Ble(
                Selection::Address("EE:C7:42:34:48:CF".into()),
                Some(Duration::from_secs(9))
            )),
            "and the address wins when both are given, and the window travels with it"
        );
    }

    /// A LAN dial carries the bridge's address and, when one was offered, the
    /// token to answer with. Offering none is not a failure: a bridge that did
    /// not ask for one still gets dialled, and sending a token nobody wants is
    /// how a board comes to believe it is secured.
    #[test]
    fn a_lan_dial_carries_the_token_it_was_given() {
        const TOKEN: &str = "0123456789abcdef0123456789abcdef";

        // An invented host: nothing can have been remembered for it, so "no
        // token" here is the store contributing nothing rather than a lookup
        // that happened to miss.
        let bare = args(&["--lan-host", "lan-none.example.invalid"])
            .lan()
            .expect("a host alone is a complete dial");
        assert_eq!(
            bare,
            Dial::Lan {
                host: "lan-none.example.invalid".into(),
                token: None
            },
            "nothing was offered, so nothing is sent"
        );
        assert_eq!(bare.describe(), "lan:lan-none.example.invalid");

        let named = args(&["--lan-host", "192.168.0.44", "--lan-token", TOKEN])
            .lan()
            .expect("a real token");
        assert_eq!(
            named,
            Dial::Lan {
                host: "192.168.0.44".into(),
                token: Some(TOKEN.into())
            }
        );
    }

    /// A token that cannot be used is refused while the command line is being
    /// read, and the refusal names the place it came from — "not 32 lowercase
    /// hex" is not a sentence about a file the caller did not choose.
    #[test]
    fn an_unusable_token_is_refused_before_the_dial() {
        let why = args(&["--lan-host", "192.168.0.44", "--lan-token", "NOPE"])
            .dial()
            .expect_err("not a token");
        assert!(why.starts_with("--lan-token"), "{why}");

        let why = args(&[
            "--lan-host",
            "192.168.0.44",
            "--lan-token-file",
            "/nonexistent/linkr-token",
        ])
        .dial()
        .expect_err("no such file");
        assert!(why.starts_with("/nonexistent/linkr-token"), "{why}");
    }

    /// Pinning the LAN transport asks for the LAN link even before an address
    /// is named; what it cannot do is dial nowhere, which is the dial's own
    /// error rather than a usage failure.
    #[test]
    fn pinning_the_lan_transport_asks_for_the_lan_link() {
        let dial = args(&["--transport", "lan"])
            .dial()
            .expect("a pin is not an error")
            .expect("and it names a link");
        assert_eq!(dial.kind(), LinkKind::Lan);
    }

    /// `--transport` names a link, and now names all four: the pin is the
    /// sidebar's word for it, not a second list that can drift.
    #[test]
    fn the_transport_flag_takes_every_link() {
        for kind in Transport::ALL {
            assert_eq!(
                args(&["--transport", kind.as_str()]).transport,
                Some(kind),
                "{kind:?}"
            );
        }
        assert_eq!(
            args(&["--transport", "STDIO"]).transport,
            Some(Transport::Stdio)
        );
    }

    /// `--overlay` opens a modal by name, and a name that is not a modal is
    /// refused rather than silently showing nothing.
    #[test]
    fn the_overlay_flag_selects_a_modal_by_name() {
        assert_eq!(args(&[]).overlay, None);
        for (name, expected) in [
            ("palette", OverlayPreview::Palette),
            ("help", OverlayPreview::Help),
            ("notices", OverlayPreview::Notices),
            ("confirm", OverlayPreview::Confirm),
            ("wifi", OverlayPreview::WifiSsid),
            ("settings", OverlayPreview::Settings),
            ("about", OverlayPreview::About),
            ("licenses", OverlayPreview::Licenses),
            ("splash", OverlayPreview::Splash),
        ] {
            assert_eq!(args(&["--overlay", name]).overlay, Some(expected), "{name}");
        }
        assert_eq!(
            args(&["--overlay", "PALETTE"]).overlay,
            Some(OverlayPreview::Palette),
            "the name is case-blind"
        );
        assert_eq!(OverlayPreview::from_name("nope"), None);
    }

    /// `--feed` takes the text it is handed, escapes and all: it exists to look
    /// at the emulator without a device, so it must not mangle what it is given.
    #[test]
    fn the_feed_flag_takes_text_verbatim() {
        assert_eq!(args(&[]).feed, None);
        let parsed = args(&["--feed", "\x1b[31mred\x1b[0m"]);
        assert_eq!(parsed.feed.as_deref(), Some("\x1b[31mred\x1b[0m"));
    }

    /// A fed frame is painted by an emulator the size of the frame's pane.
    ///
    /// The pane's size is not the frame's: it is the centre region, after the
    /// bars, the sidebar *and* the assistant's panel. That is exactly the
    /// arithmetic the event loop runs every tick, so a preview cannot show a
    /// device wrapped at the default 80 columns inside a wider frame and read
    /// as an emulator bug.
    #[test]
    fn a_fed_frame_is_painted_by_a_pane_of_the_frames_size() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        // The default the emulator starts at, which is what a preview used to
        // keep however wide the frame was.
        assert_eq!(app.terminal.size(), (80, 24));

        // Wide enough that the pane is past the emulator's default even after
        // the assistant's panel has taken its share of the band.
        let pane = fit_pane_to(220, 30, &mut app);
        assert!(
            pane.width > 80,
            "the pane is wider than the default: {pane:?}"
        );
        assert_eq!(pane, pane_area(220, 30), "not the pane the paint uses");
        assert_eq!(app.terminal.size(), (pane.width, pane.height));

        app.terminal.push_text(&"x".repeat(pane.width as usize));
        // The whole screen, because a one-row window is the *bottom* of the
        // screen and the fed line is at the top of it.
        let rows = views::terminal::rows(&app.terminal, pane.width as usize, pane.height as usize);
        assert_eq!(
            rows[0].chars().count(),
            pane.width as usize,
            "a full-width line does not wrap early: {rows:?}"
        );
        assert_eq!(rows[1], "", "and it is one line, not two: {rows:?}");
    }

    /// The device is told the pane's size, and the panel is not the pane's
    /// business: opening or closing it must not change what the emulator
    /// thinks its grid is, or the device would reflow its history for a column
    /// of chat. The rail is the one that moves the pane, and always did.
    #[test]
    fn the_pane_keeps_its_size_when_the_panel_moves() {
        let mut shown = App::default();
        let pane = fit_pane_to(140, 30, &mut shown);
        let mut hidden = App {
            assistant_panel: false,
            ..App::default()
        };
        assert_eq!(fit_pane_to(140, 30, &mut hidden), pane);
        assert_eq!(hidden.terminal.size(), shown.terminal.size());
    }

    /// `--print-frame --overlay` draws the modal, in the language asked for —
    /// this is how the modal layer is reviewed without a terminal.
    #[test]
    fn a_previewed_overlay_reaches_the_frame() {
        for (overlay, needle) in [
            (OverlayPreview::Palette, "命令面板"),
            (OverlayPreview::Help, "键盘帮助"),
            (OverlayPreview::Notices, "通知记录"),
            (OverlayPreview::Confirm, "请确认"),
            (OverlayPreview::WifiSsid, "加入 WiFi 网络"),
            (OverlayPreview::Settings, "助手设置"),
            (OverlayPreview::Licenses, "开源组件"),
            (OverlayPreview::Splash, "按任意键跳过"),
        ] {
            let mut app = App::default();
            overlay.raise(&mut app);
            let frame = linkr_tui::ui::render_to_text(&app, 100, 30);
            assert!(frame.contains(needle), "{overlay:?}:\n{frame}");
        }
    }

    /// `--sample` fills the notice log as well as the grid and the pane, so a
    /// previewed log shows the *real* wording rather than a placeholder.
    #[test]
    fn sample_fills_the_notice_log() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        let s = app.strings();
        app.push_notice(linkr_tui::app::Notice {
            text: format!("{}{}", s.link_opened, Dial::Stdio("-".into()).describe()),
            level: linkr_tui::event::NoticeLevel::Info,
        });
        assert!(
            app.log[0].text.starts_with("link open: "),
            "{:?}",
            app.log[0].text
        );
        assert!(
            app.log[0].text.ends_with("stdio: -"),
            "{:?}",
            app.log[0].text
        );
        assert_eq!(
            app.log[0].text,
            format!("{}{}", s.link_opened, "stdio: -"),
            "the preview cannot show wording the pump would not produce"
        );
    }

    /// `Ctrl+P` opens the palette and opens it *again* to put it away, the way
    /// a key that opened a window is expected to behave. While it is up it owns
    /// the keyboard, so a plain letter is a query character and not a keystroke
    /// for the device.
    #[test]
    fn control_p_toggles_the_palette_and_it_takes_the_keyboard() {
        let mut app = App::default();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        );
        assert!(app.palette.is_some(), "Ctrl+P opened the palette");

        // A letter edits the query; the device hears nothing.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::NONE),
        );
        assert_eq!(
            app.palette.as_ref().map(|s| s.query.as_str()),
            Some("t"),
            "the letter went into the query"
        );
        assert_eq!(app.tx, 0, "and not to the device");

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        );
        assert!(app.palette.is_none(), "Ctrl+P again put it away");
    }

    /// With the palette open, a control chord is still the interface's: `Ctrl+Q`
    /// quits and `Ctrl+T` repaints rather than typing into the search box.
    #[test]
    fn a_control_chord_still_works_with_the_palette_open() {
        let mut app = App::default();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        );

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL),
        );
        assert!(app.palette.is_none(), "the picker took the palette's place");
        assert!(
            matches!(app.dialog, Some(dialogs::Dialog::ThemePick(_))),
            "Ctrl+T opened the picker"
        );
        assert_eq!(
            app.theme,
            ThemeChoice::Dark,
            "no theme moved without a pick"
        );

        // Ctrl+Q sets the flag the loop reads.
        assert!(handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)
        ));
        assert!(app.quit);
    }

    /// A function key reaches the view rota even with the palette up: the user
    /// who reaches for `F2` wants the view, not an unmatched search.
    #[test]
    fn a_function_key_reaches_the_view_rota_from_the_palette() {
        let mut app = App::default();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        );
        handle_key(&mut app, KeyEvent::new(KeyCode::F(4), KeyModifiers::NONE));
        assert_eq!(app.view, View::Network);
        assert!(app.palette.is_some(), "the palette stayed open");
    }

    /// A dialog owns the keyboard while it is up: the pane hears nothing, the
    /// global chords still work, and Escape gives the keyboard back.
    #[test]
    fn a_dialog_owns_the_keyboard_until_it_is_closed() {
        let mut app = App::default();
        handle_key(&mut app, KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE));
        assert!(app.dialog.is_some());

        // A letter that would otherwise be a device keystroke is consumed.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE),
        );
        assert_eq!(app.tx, 0, "the dialog swallowed the keystroke");
        assert!(app.dialog.is_some(), "and stayed open");

        // The global chords are not swallowed — but Ctrl+T is the one that
        // defers to a window already up: replacing a half-typed prompt to
        // show a theme would be a bad trade, so the picker stays away.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL),
        );
        assert_eq!(app.theme, ThemeChoice::Dark, "the picker stayed away");
        assert!(app.dialog.is_some(), "and the dialog is still up");

        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "Escape closed it");
        // Now a letter is the device's again — refused out loud, because there
        // is no link, rather than silently dropped.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE),
        );
        assert_eq!(app.tx, 0);
    }

    /// A palette opened over a dialog is *live*: the keys reach it and it can
    /// be closed again. It used to open behind the dialog and take no keys, so
    /// the chord read as dead until Escape cleared the box in front of it.
    #[test]
    fn control_p_wakes_the_palette_over_a_dialog() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        // The form's own modal: a prompt is what a network view raises, and
        // the state the report came from.
        linkr_tui::dialogs::prompt_wifi_ssid(&mut app);
        assert!(app.dialog.is_some(), "the prompt is up");

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        );
        assert!(app.palette.is_some(), "Ctrl+P woke the palette");
        assert!(app.dialog.is_some(), "the prompt is still underneath");

        // The keys are the palette's, not the prompt's: a letter is a query
        // character and the prompt's field does not move.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('z'), KeyModifiers::NONE),
        );
        assert_eq!(
            app.palette.as_ref().map(|p| p.query.as_str()),
            Some("z"),
            "the palette took the key"
        );

        // Escape closes the top of the stack, and the prompt comes back.
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.palette.is_none(), "Escape closed the palette");
        assert!(app.dialog.is_some(), "and the prompt is back");

        // Ctrl+P again, then Ctrl+P to close it: the chord is a toggle even
        // with a dialog up.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        );
        assert!(app.palette.is_some());
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        );
        assert!(app.palette.is_none(), "the chord put it away");
        assert!(app.dialog.is_some(), "the prompt never moved");
    }

    /// A dialog raised while the palette is open takes the keyboard: the two
    /// are a stack, and the one opened last is the one answering.
    #[test]
    fn a_dialog_raised_over_the_palette_takes_the_keys() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
        );
        assert!(app.palette.is_some());

        // F1 is the help, and it is legal with the palette up.
        handle_key(&mut app, KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE));
        assert!(app.dialog.is_some(), "the help is up");
        assert!(app.palette.is_none(), "and gave up the keyboard");

        // A letter now belongs to the dialog, not to a palette query.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE),
        );
        assert_eq!(app.tx, 0, "the dialog swallowed the keystroke");
    }

    /// Enter on a sidebar row does what the row says: it opens a view, sends a
    /// preset, or — for the guarded one — asks first. The index the cursor
    /// reaches is the index `activate` understands, which is the same list
    /// `targets` builds.
    #[test]
    fn enter_activates_the_sidebar_row_under_the_cursor() {
        let mut app = App {
            focus: Focus::Sidebar,
            ..App::default()
        };

        // Row 3 is the first view, in `View::ALL` order.
        for _ in 0..3 {
            handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert_eq!(app.sidebar_cursor, 3);
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.view, View::ALL[0], "the row opened its view");

        // Walk to the `reboot` row — the last one — and ask for it. It must not
        // fire: it must raise a confirmation.
        let last = app.sidebar_rows() - 1;
        while app.sidebar_cursor < last {
            handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert_eq!(
            app.quick_send[last - (3 + View::ALL.len())].command,
            "reboot"
        );
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.tx, 0, "reboot was not sent");
        assert!(
            matches!(app.dialog, Some(linkr_tui::dialogs::Dialog::Confirm(_))),
            "reboot asked first: {:?}",
            app.dialog
        );
    }

    /// Enter on `Switch device` is a no-op that says so, rather than a button
    /// that looks live and does nothing.
    #[test]
    fn enter_on_switch_device_says_there_is_nothing_to_switch_to() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.focus = Focus::Sidebar;
        for _ in 0..2 {
            handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert_eq!(app.sidebar_cursor, 2);
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        // Switching device now *looks* for one. It used to answer "no other
        // device to switch to" without ever having asked the radio — the one
        // action in the interface that answered a question it had not posed.
        // The row opens the scan, so what it leaves behind is a scan running.
        assert!(
            app.ble_scan.is_running(),
            "switch device did not start listening"
        );
        assert!(app.dialog.is_some(), "the scan's list is not open");
        assert!(
            app.log.last().map(|n| n.text.as_str()) != Some("No other device to switch to yet."),
            "the old warning is gone"
        );
    }

    /// A pane keystroke still reaches the device — the sidebar routing did not
    /// swallow it — and the palette's `clear` action is the same code `Ctrl+L`
    /// runs, so the two cannot drift.
    #[test]
    fn the_pane_still_gets_its_keystrokes() {
        use linkr_tui::session::Dial;
        let mut app = App::default();
        app.dial(&Dial::Stdio("-".into()))
            .expect("the loopback opens");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline
            && app.state != linkr_tui::event::ConnectionState::Connected
        {
            app.pump();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(app.connected());
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
        );
        assert_eq!(app.tx, 1, "the byte went out");
    }

    /// The wheel turns the way a wheel turns in both focuses: away from the
    /// user walks up — a row in the rail, three lines back into the pane — and
    /// towards the user walks back down, where reaching the tail resumes
    /// following.
    #[test]
    fn the_wheel_walks_the_rail_and_the_pane_the_way_wheels_walk() {
        use crossterm::event::{MouseEvent, MouseEventKind};

        fn wheel(app: &mut App, kind: MouseEventKind) {
            handle_mouse(
                app,
                MouseEvent {
                    kind,
                    column: 10,
                    row: 10,
                    modifiers: KeyModifiers::NONE,
                },
                100,
                30,
            );
        }

        // The rail: one row per notch.
        let mut app = App {
            focus: Focus::Sidebar,
            sidebar_cursor: 1,
            ..App::default()
        };
        wheel(&mut app, MouseEventKind::ScrollDown);
        assert_eq!(app.sidebar_cursor, 2);
        wheel(&mut app, MouseEventKind::ScrollUp);
        assert_eq!(app.sidebar_cursor, 1);

        // The pane: away from the user reads back, towards the user walks home.
        let mut app = App::default();
        app.terminal.push_text("one\ntwo\nthree\n");
        assert!(app.terminal.autoscroll);
        wheel(&mut app, MouseEventKind::ScrollUp);
        wheel(&mut app, MouseEventKind::ScrollUp);
        assert_eq!(app.terminal.scroll, 6, "two notches, three lines each");
        assert!(!app.terminal.autoscroll, "reading back stops following");
        wheel(&mut app, MouseEventKind::ScrollDown);
        assert_eq!(app.terminal.scroll, 3);
        wheel(&mut app, MouseEventKind::ScrollDown);
        assert_eq!(app.terminal.scroll, 0);
        assert!(
            app.terminal.autoscroll,
            "the tail is where following resumes"
        );
        wheel(&mut app, MouseEventKind::ScrollDown);
        assert_eq!(app.terminal.scroll, 0, "the walk stops at the tail");
    }

    /// A modal answers the mouse the way it answers the keyboard: the pane and
    /// the rail underneath it do not move while the user is answering the box.
    #[test]
    fn the_wheel_leaves_the_background_alone_under_a_modal() {
        use crossterm::event::{MouseEvent, MouseEventKind};

        fn wheel(app: &mut App, kind: MouseEventKind) {
            handle_mouse(
                app,
                MouseEvent {
                    kind,
                    column: 10,
                    row: 10,
                    modifiers: KeyModifiers::NONE,
                },
                100,
                30,
            );
        }

        // The rail's cursor under a dialog, and under the palette.
        let mut app = App {
            focus: Focus::Sidebar,
            sidebar_cursor: 3,
            ..App::default()
        };
        linkr_tui::dialogs::open_help(&mut app);
        wheel(&mut app, MouseEventKind::ScrollUp);
        assert_eq!(app.sidebar_cursor, 3, "the rail moved under a dialog");
        app.dialog = None;
        linkr_tui::palette::open(&mut app);
        wheel(&mut app, MouseEventKind::ScrollUp);
        assert_eq!(app.sidebar_cursor, 3, "the rail moved under the palette");

        // The pane, which was following its tail: still following, still on it.
        let mut app = App::default();
        app.terminal.push_text("one\ntwo\nthree\n");
        linkr_tui::dialogs::open_help(&mut app);
        wheel(&mut app, MouseEventKind::ScrollUp);
        assert_eq!(app.terminal.scroll, 0, "the pane read back under a modal");
        assert!(
            app.terminal.autoscroll,
            "the pane stopped following under a modal"
        );
        // The same notch without the box in the way reads back, which is what
        // makes the two assertions above mean something.
        app.dialog = None;
        wheel(&mut app, MouseEventKind::ScrollUp);
        assert_eq!(app.terminal.scroll, 3);
    }

    /// A drag over the pane selects the cells it crossed and the release
    /// copies them; a bare click on the pane clears; and with another view
    /// showing there is no pane under the pointer to drag on.
    #[test]
    fn a_drag_over_the_pane_selects_and_copies() {
        use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};

        fn at(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
            MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            }
        }

        let (cols, rows) = (100u16, 30u16);
        let mut app = App::default();
        app.terminal.push_text("hello world\r\nsecond line\r\n");
        // The pane starts at x = 30, one row down (the top bar); the session's
        // first line is its first row.
        handle_mouse(
            &mut app,
            at(MouseEventKind::Down(MouseButton::Left), 30, 1),
            cols,
            rows,
        );
        handle_mouse(
            &mut app,
            at(MouseEventKind::Drag(MouseButton::Left), 34, 1),
            cols,
            rows,
        );
        handle_mouse(
            &mut app,
            at(MouseEventKind::Up(MouseButton::Left), 34, 1),
            cols,
            rows,
        );
        assert_eq!(app.terminal.selected_text().as_deref(), Some("hello"));
        assert!(
            app.notices
                .last()
                .is_some_and(|notice| notice.text.contains('5')),
            "the copy announced how much went: {:?}",
            app.notices.last().map(|notice| &notice.text)
        );

        // A click on the text, no drag: it clears.
        handle_mouse(
            &mut app,
            at(MouseEventKind::Down(MouseButton::Left), 40, 1),
            cols,
            rows,
        );
        handle_mouse(
            &mut app,
            at(MouseEventKind::Up(MouseButton::Left), 40, 1),
            cols,
            rows,
        );
        assert_eq!(app.terminal.selected_text(), None);

        // The pane is not showing: the same gesture paints nothing, because
        // another view's document is not a buffer to select from.
        app.set_view(View::Network);
        handle_mouse(
            &mut app,
            at(MouseEventKind::Down(MouseButton::Left), 30, 1),
            cols,
            rows,
        );
        handle_mouse(
            &mut app,
            at(MouseEventKind::Drag(MouseButton::Left), 34, 1),
            cols,
            rows,
        );
        assert_eq!(app.terminal.selected_text(), None);
    }

    /// The assistant's text is selectable too: a drag over the view's thread
    /// copies the run it crossed, a bare click clears, and a new turn — or
    /// another view — drops the run rather than leaving it over rows it no
    /// longer names.
    #[test]
    fn a_drag_over_the_assistant_view_copies_the_run() {
        use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};

        fn at(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
            MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            }
        }

        let (cols, rows) = (100u16, 30u16);
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.set_view(View::Assistant);
        app.assistant
            .chat_mut()
            .display
            .push(linkr_tui::agent::session::DisplayLine {
                role: "user".into(),
                text: "hello world".into(),
            });

        // Where the painter wrote the question: the run is drawn over the
        // rows the paint is showing, asked for through the painter's own
        // builders.
        let centre = assistant_centre(&app, cols, rows);
        let text_area = ui::body_text_area(&app, centre);
        let painted =
            views::assistant::painted_rows(&app, views::assistant::SelectRegion::View, text_area);
        let row = painted
            .iter()
            .position(|row| row.contains("hello world"))
            .expect("the thread is painted");
        let col = painted[row].find("hello world").expect("the question") as u16;
        let (x, y) = (text_area.x + col, text_area.y + row as u16);

        handle_mouse(
            &mut app,
            at(MouseEventKind::Down(MouseButton::Left), x, y),
            cols,
            rows,
        );
        handle_mouse(
            &mut app,
            at(MouseEventKind::Drag(MouseButton::Left), x + 4, y),
            cols,
            rows,
        );
        handle_mouse(
            &mut app,
            at(MouseEventKind::Up(MouseButton::Left), x + 4, y),
            cols,
            rows,
        );
        let run = app
            .assistant
            .select
            .as_ref()
            .expect("the run stays on screen");
        assert_eq!(run.text(), "hello");
        assert!(
            app.notices
                .last()
                .is_some_and(|notice| notice.text.contains('5')),
            "the copy announced how much went: {:?}",
            app.notices.last().map(|notice| &notice.text)
        );

        // The frame paints the run over the rows it names, without tripping
        // over the cells at its edges.
        let painted = linkr_tui::ui::render_to_text(&app, cols, rows);
        assert!(painted.contains("hello world"), "the thread is painted");

        // A click on the text, no drag: it clears and copies nothing.
        let notices = app.notices.len();
        handle_mouse(
            &mut app,
            at(MouseEventKind::Down(MouseButton::Left), x, y),
            cols,
            rows,
        );
        handle_mouse(
            &mut app,
            at(MouseEventKind::Up(MouseButton::Left), x, y),
            cols,
            rows,
        );
        assert!(app.assistant.select.is_none(), "the click did not clear");
        assert_eq!(app.notices.len(), notices, "a click copied something");

        // Another view paints different rows, so the run cannot survive the
        // trip — and a turn rewrites the ones it named.
        app.assistant.select = Some(views::assistant::Selection::new(
            views::assistant::SelectRegion::View,
            vec!["hello".into()],
            (0, 0),
        ));
        app.set_view(View::Network);
        assert!(app.assistant.select.is_none(), "the run outlived the view");
    }

    /// The docked panel is the same conversation in a column, and it is just
    /// as draggable: the run comes back through the panel's own rows.
    #[test]
    fn a_drag_over_the_docked_panel_copies_the_run() {
        use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};

        fn at(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
            MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            }
        }

        let (cols, rows) = (110u16, 30u16);
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.assistant_panel = true;
        app.assistant
            .chat_mut()
            .display
            .push(linkr_tui::agent::session::DisplayLine {
                role: "user".into(),
                text: "hello world".into(),
            });

        let area = ui::legacy::drawing_area(Rect::new(0, 0, cols, rows), app.legacy_console);
        let regions = ui::regions_for(area, app.sidebar_visible, app.panel_wanted());
        assert!(regions.assistant.width > 0, "the panel does not fit");
        let text_area = ui::panel_text_area(regions.assistant);
        let painted =
            views::assistant::painted_rows(&app, views::assistant::SelectRegion::Panel, text_area);
        let row = painted
            .iter()
            .position(|row| row.contains("hello world"))
            .expect("the thread is painted");
        let col = painted[row].find("hello world").expect("the question") as u16;
        let (x, y) = (text_area.x + col, text_area.y + row as u16);

        handle_mouse(
            &mut app,
            at(MouseEventKind::Down(MouseButton::Left), x, y),
            cols,
            rows,
        );
        handle_mouse(
            &mut app,
            at(MouseEventKind::Drag(MouseButton::Left), x + 4, y),
            cols,
            rows,
        );
        handle_mouse(
            &mut app,
            at(MouseEventKind::Up(MouseButton::Left), x + 4, y),
            cols,
            rows,
        );
        let run = app
            .assistant
            .select
            .as_ref()
            .expect("the run stays on screen");
        assert_eq!(run.text(), "hello");
        assert_eq!(run.region, views::assistant::SelectRegion::Panel);

        // Hiding the panel takes the paint away with the run.
        app.toggle_assistant_panel();
        assert!(app.assistant.select.is_none(), "the run outlived the panel");
    }

    /// The centre region for the assistant view's own body, asked the way the
    /// mouse handler asks it.
    fn assistant_centre(app: &App, cols: u16, rows: u16) -> Rect {
        let area = ui::legacy::drawing_area(Rect::new(0, 0, cols, rows), app.legacy_console);
        ui::regions_for(area, app.sidebar_visible, app.panel_wanted()).centre
    }

    /// A press on the blank ground under the pane's text is a press on
    /// nothing: it clears a selection instead of anchoring one.
    #[test]
    fn a_press_below_the_text_clears_the_selection() {
        use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};

        let (cols, rows) = (100u16, 30u16);
        let mut app = App::default();
        app.terminal.push_text("hello\r\n");
        app.terminal.press(0, 0);
        app.terminal.drag_to(0, 3);
        assert!(app.terminal.selected_text().is_some());

        // The pane's last painted row is blank ground: the session's screen is
        // shorter than the pane the frame draws.
        let ground = 1 + 27;
        handle_mouse(
            &mut app,
            MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 32,
                row: ground,
                modifiers: KeyModifiers::NONE,
            },
            cols,
            rows,
        );
        assert_eq!(app.terminal.selected_text(), None, "the click cleared");
    }

    /// A capability request the console cannot take is answered with
    /// `Unsupported` — every Windows console answers the keyboard protocol
    /// that way — and that answer is the console saying "not here", not a
    /// failed write. Only a real error tears the setup down.
    #[cfg(feature = "tui")]
    #[test]
    fn a_capability_the_console_cannot_take_is_not_a_failure() {
        let absent = io::Error::new(io::ErrorKind::Unsupported, "not here");
        assert!(without_capability(absent).is_ok());

        let broken = io::Error::new(io::ErrorKind::BrokenPipe, "gone");
        assert!(matches!(
            without_capability(broken),
            Err(err) if err.kind() == io::ErrorKind::BrokenPipe
        ));
    }
}
