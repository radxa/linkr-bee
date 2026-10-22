//! Application state: everything a frame needs, and nothing a frame does not.
//!
//! The state is plain data with small, total transitions. No view owns state
//! and no state knows about a view: `ui::*` reads `&App`, the event loop
//! mutates it, and every mutation is a method here so it can be tested without
//! a terminal.

use std::collections::VecDeque;
use std::io;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ratatui::layout::Rect;

use crate::accessory::{self, UartSettings};
use crate::capability::{self, Capability, GlyphSet};
use crate::clipboard::osc52_copy;
use crate::device::{Conversation, Query, Reply};
use crate::event::{ConnectionState, NoticeLevel, View};
use crate::i18n::Lang;
use crate::session::{Dial, Session};
use crate::settings::Settings;
use crate::theme::{Theme, ThemeChoice};
use crate::transport::{Link, LinkEvent, OpenedLink};
use crate::views::diagnostics::DiagnosticsState;
use crate::views::terminal::TerminalPane;
use crate::watch::{SerialWatch, WatchOptions};
use crate::{dialogs, palette};

/// Which link carries the session.
///
/// The sidebar names it and the command line pins it, and it is the same list
/// the transport module implements — re-exported rather than mirrored, so a
/// link cannot exist without the chrome having a word for it.
pub use crate::transport::LinkKind as Transport;

/// Whether this session has a LAN token in hand, for the sidebar to say.
///
/// Three states rather than a bool, because "no token" and "there is no token
/// because this bridge wants none" are different facts and a user needs to know
/// which one they are looking at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LanCapture {
    /// Nothing asked yet.
    #[default]
    Unknown,
    /// A token is in hand.
    Captured,
    /// The bridge said `token=none`: LAN access is open.
    None,
}

/// How long the interface listens for boards before showing what it heard.
///
/// Longer than `--scan`'s own default: a user who picks "find my board" from a
/// palette is looking at a screen and is willing to wait, where a shell command
/// is watched while it runs. Short enough that a bench with the board switched
/// off does not leave the dialog sitting there for half a minute.
pub const BLE_SCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// A Bluetooth scan running in the background, and where its answer lands.
///
/// Separate from the link because a scan has to keep running while the user
/// reads the console, and a scan that blocked the pump would be a scan that
/// froze the frame it is filling. The radio library is async and this program
/// is not, so the scan owns a thread of its own exactly as the BLE link does.
/// `Debug` by hand: `App` derives it, and the channel behind a scan does not
/// implement it and should not — what a scan is, in a diagnostic, is how many
/// devices it heard and whether it is still listening.
impl std::fmt::Debug for BleScan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BleScan")
            .field("devices", &self.devices.len())
            .field("running", &self.running)
            .finish()
    }
}

#[derive(Default)]
pub struct BleScan {
    /// What it has found so far. Replaced on every update, and filled while
    /// the scan is still listening, so a dialog built on it grows instead of
    /// arriving all at once when the window closes.
    pub devices: Vec<crate::cli::FoundDevice>,
    /// Whether the scan is still listening.
    running: bool,
    /// Where the scan posts what it hears, as it hears it.
    rx: Option<std::sync::mpsc::Receiver<crate::cli::ScanEvent>>,
}

impl BleScan {
    /// Start listening, unless one is already running.
    ///
    /// `Err` is a sentence rather than a panic because the three ways this
    /// fails — no adapter, no Bluetooth on the host, a library that refuses —
    /// are all ordinary facts about the machine and all things a user can act
    /// on, unlike a bug in this program. The failures that come *later*, once
    /// a scan is under way, arrive through [`BleScan::poll`] instead.
    pub fn start(&mut self, timeout: std::time::Duration) -> Result<(), String> {
        self.listen(timeout, false)
    }

    /// Start the startup scan: the same listener, with one difference — it
    /// stops at the first board that answers instead of at the end of the
    /// window, because a start that waits out a full scan for a board already
    /// in front of the user is a start that feels broken. See
    /// [`crate::cli::scan_first_board`].
    pub fn start_first_board(&mut self, timeout: std::time::Duration) -> Result<(), String> {
        self.listen(timeout, true)
    }

    fn listen(&mut self, timeout: std::time::Duration, first_board: bool) -> Result<(), String> {
        if self.running {
            return Err("a scan is already running".to_string());
        }
        let until = if first_board {
            crate::cli::Until::ABoardAnswers
        } else {
            crate::cli::Until::TheWindowEnds
        };
        self.running = true;
        self.devices.clear();
        self.rx = Some(crate::cli::scan_stream(timeout, until));
        Ok(())
    }

    /// Whether a scan is in flight.
    pub fn is_running(&self) -> bool {
        self.running
    }

    /// What the scan has seen since this was last asked, and whether there is
    /// news.
    ///
    /// `Ok(true)` while `is_running` means the list grew or shrank and the
    /// screen should be repainted from it; `Ok(true)` once it has stopped is
    /// the final list, the answer the scan was run for. `Ok(false)` is
    /// "nothing new". `Err` is a scan that could not run at all, carrying the
    /// sentence to show.
    ///
    /// The devices are replaced rather than appended because each update is
    /// the whole list: a device that went out of range then disappears from
    /// the list rather than sticking on the screen as a ghost.
    pub fn poll(&mut self) -> Result<bool, String> {
        let Some(rx) = self.rx.as_ref() else {
            self.running = false;
            return Ok(false);
        };
        let mut news = false;
        let mut failure = None;
        loop {
            match rx.try_recv() {
                Ok(crate::cli::ScanEvent::Seen(devices)) => {
                    self.devices = devices;
                    news = true;
                }
                Ok(crate::cli::ScanEvent::Done(devices)) => {
                    self.devices = devices;
                    self.running = false;
                    news = true;
                }
                Ok(crate::cli::ScanEvent::Failed(why)) => {
                    self.running = false;
                    failure = Some(why);
                    break;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    self.running = false;
                    break;
                }
            }
        }
        if !self.running {
            self.rx = None;
        }
        match failure {
            Some(why) => Err(why),
            None => Ok(news),
        }
    }

    /// Stop listening and forget what was heard.
    pub fn reset(&mut self) {
        self.running = false;
        self.devices.clear();
        self.rx = None;
    }
}

/// A dial running on a thread of its own, and where its link lands.
///
/// Opening a Bluetooth link takes seconds, which is the right contract for a
/// command line — `open` returning means connected everywhere else — and a
/// frozen frame for an interface. So a dial from the interface pays that wait
/// on a thread of its own and the pump collects the opened link a tick later:
/// the wait becomes a state the screen can show instead of a keyboard that
/// does not answer.
pub struct DialJob {
    /// The dial, kept so the link can be described when it fails.
    pub dial: Dial,
    /// Whether this dial was the startup scan's own; its arrival is not
    /// announced. See [`App::quiet_connect`].
    pub quiet: bool,
    /// Where the thread posts the opened link, or why it could not.
    rx: std::sync::mpsc::Receiver<io::Result<OpenedLink>>,
}

impl std::fmt::Debug for DialJob {
    /// Hand-written for the same reason [`BleScan`]'s is: the channel behind a
    /// dial is not something a diagnostic should try to print.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DialJob")
            .field("dial", &self.dial)
            .field("quiet", &self.quiet)
            .finish()
    }
}

/// What `@s?` reported: LAN access state and the token the bridge expects.
///
/// Deliberately *not* part of the network view's state. A token is a secret and
/// a secret belongs somewhere a frame will not paint it, so this is read by the
/// LAN dial and by the sidebar's "captured" marker and by nothing else.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LanStatus {
    pub ws: String,
    /// The token as the bridge spells it, or empty for `token=none`.
    pub token: String,
    pub loading: bool,
}

/// A shortcut in the sidebar's quick-send list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickSend {
    /// The line that is sent when the row is activated.
    pub command: String,
    /// Whether the row asks for confirmation first (`reboot` and friends).
    pub dangerous: bool,
}

impl QuickSend {
    /// A plain shortcut.
    pub fn new(command: impl Into<String>) -> QuickSend {
        QuickSend {
            command: command.into(),
            dangerous: false,
        }
    }

    /// A shortcut that must be confirmed before it goes out.
    pub fn guarded(command: impl Into<String>) -> QuickSend {
        QuickSend {
            command: command.into(),
            dangerous: true,
        }
    }
}

/// A message the interface is showing right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub text: String,
    pub level: NoticeLevel,
}

/// Which region the keyboard is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Focus {
    Sidebar,
    #[default]
    Terminal,
    /// The docked assistant panel beside the terminal.
    Assistant,
}

/// The one-shot modifier latch: modifiers a chord arms for the very next key,
/// so keys the interface owns the chord of — and any combination a keyboard
/// cannot easily produce — still reach the device.
///
/// The old interface armed the same three with `Ctrl+Shift+R/C/A`, and the
/// scheme survives because it is the only one that covers *every* key: a
/// mechanism that captured keys by chord would always be missing the chord it
/// captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Latch {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

impl Latch {
    /// Whether anything is armed.
    pub fn is_armed(&self) -> bool {
        self.ctrl || self.shift || self.alt
    }

    /// Hand back what was armed and disarm in one go: the latch belongs to
    /// one key, and that key is the one being encoded right now.
    pub fn take(&mut self) -> Latch {
        std::mem::take(self)
    }

    /// The names as the notice and the bottom bar show them, `Ctrl+Shift` the
    /// way a chord is spelled. The words stay Latin in both languages, like
    /// `RX` and `dBm`: they are what the key is called.
    pub fn names(&self) -> String {
        let mut names: Vec<&str> = Vec::new();
        if self.ctrl {
            names.push("Ctrl");
        }
        if self.shift {
            names.push("Shift");
        }
        if self.alt {
            names.push("Alt");
        }
        names.join("+")
    }
}

/// How many toasts stack at once before the oldest is dropped.
pub const MAX_NOTICES: usize = 3;

/// How long a toast stands before it takes itself off the screen.
///
/// The old interface gave every message the same 2.2 s, which is enough to
/// read a sentence and short enough that a stack of them cannot pile up in the
/// corner. Each notice keeps its own clock, so a stack empties one row at a
/// time and the box disappears with the last of them.
pub const TOAST_LIFETIME: std::time::Duration = std::time::Duration::from_millis(2200);

/// How long the startup splash stands before the interface takes the screen.
///
/// A moment, not a ceremony: long enough to read the mark, short enough that
/// nobody waits for it — and any key, click or paste ends it early anyway.
pub const SPLASH: std::time::Duration = std::time::Duration::from_millis(1500);

/// What a token in hand reads as in the sidebar: that one is there, never
/// which.
///
/// Thirty-two stars because that is exactly how long the thing under the mask
/// is — the protocol fixes a token at thirty-two hexadecimal characters — so
/// the run says nothing the wire format does not. A shorter one did: a reader
/// who knew the count saw a six-character secret, and a reader who did not
/// saw a tool that had lost most of one.
const LAN_TOKEN_MASK: &str = "********************************";

/// How many notices the *log* keeps. Deeper than the toast stack, because the
/// log dialog is where a user goes to find out what happened while they were
/// looking elsewhere, and three rows is not a history.
pub const MAX_LOG: usize = 200;

/// How long a WiFi action waits for its `@event wifi` ending before the
/// status is read back instead.
///
/// The bridge's own WiFi operation gives up at thirty seconds, and this adds
/// room for the radio's disconnect and recovery cycle — the web client sizes
/// its fallback the same way. A bridge that sends no phases is then answered
/// by the read rather than by waiting forever.
const WIFI_EVENT_FALLBACK: std::time::Duration = std::time::Duration::from_secs(45);

/// How many more times an `@w=` write refused with `-EBUSY` is sent.
///
/// The gate the firmware refuses on is held by whatever WiFi operation is in
/// flight — often the bridge's own background retry, which comes back every
/// few seconds — so a write that lands in the middle of one is not a user
/// mistake and not worth an error. It is worth waiting out. Bounded, because
/// a board that stays busy through every attempt is a board to hear about
/// rather than to keep asking.
///
/// A scan is turned away by the same gate, and spends the same allowance on
/// the same pauses: see [`ScanRetry`]. What differs is the shape of the
/// refusal — `ERR scan=-16` when the gate is another scan, and silence when
/// it is a join.
const WIFI_BUSY_RETRIES: u32 = 4;

/// The pause before the attempt that follows `spent` refused ones.
///
/// It lengthens: the first attempt is for the second or two a join takes to
/// clear the gate, and the last is for a bridge that is working through a
/// connect cycle of its own.
fn wifi_busy_pause(spent: u32) -> Duration {
    Duration::from_secs(2 * (u64::from(spent) + 1))
}

/// The longest a `@w=` write can be waited out end to end: every pause in
/// [`wifi_busy_pause`] one after another, with room for the round trips
/// between them.
///
/// The script mode waits this long for a join or a forget, because a write
/// still owed an attempt is a question still outstanding — see
/// [`App::waiting_on_device`] — and a wait sized for the first answer alone
/// would cut the process off in the middle of the retries. Nothing else
/// waits this long: an ordinary question ends with its own patience, and a
/// retry that goes early cuts the wait short like any other answer.
pub fn wifi_write_window() -> Duration {
    (0..=WIFI_BUSY_RETRIES)
        .map(wifi_busy_pause)
        .sum::<Duration>()
        + Duration::from_secs(10)
}

/// How long a caller waits for a WiFi write to end: the longer of the two
/// clocks the view itself runs on.
///
/// A join ends either with the ending the board sends (`@event wifi`) or with
/// the read-back the view performs once [`WIFI_EVENT_FALLBACK`] passes, and a
/// caller that stops before both has had their chance is a caller reading an
/// ack as an outcome. So this is the write window and that fallback, whichever
/// is longer — the answer may be slow, but it never arrives after this.
pub fn wifi_answer_window() -> Duration {
    wifi_write_window().max(WIFI_EVENT_FALLBACK)
}

/// How long a caller waits for a scan that keeps going unanswered.
///
/// Every attempt gets its patience and every pause between them is counted,
/// because that is what the app will spend: a scan nobody answers is asked
/// again (see [`ScanRetry`]), and a window sized for one attempt would have
/// the caller give up in the middle of the retries — reporting a busy board as
/// a silent one.
pub fn scan_answer_window() -> Duration {
    crate::device::Query::WifiScan.patience() * (WIFI_BUSY_RETRIES + 1)
        + (0..WIFI_BUSY_RETRIES)
            .map(wifi_busy_pause)
            .sum::<Duration>()
        + Duration::from_secs(10)
}

/// An `@w=` write the interface is not finished with: either its answer has
/// not arrived, or it was refused for busy and is owed another attempt.
///
/// It is the one place a WiFi password — the command carries it — outlives
/// the dialog that asked for it, and it outlives it by seconds: the buffer is
/// dropped when the answer arrives, when the attempts run out, or when the
/// link goes down, whichever comes first. Nothing writes it anywhere; the
/// latency is the whole of the concession, and it is what makes "the board
/// was busy" a wait rather than a failure the user has to retype a password
/// for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifiWrite {
    /// The command as it went out.
    pub command: String,
    /// Attempts still owed after a busy refusal.
    pub left: u32,
    /// When the next attempt is due, once one is owed.
    pub next: Option<Instant>,
}

impl WifiWrite {
    /// The record a fresh write opens, with every attempt still owed.
    fn new(command: &str) -> WifiWrite {
        WifiWrite {
            command: command.to_string(),
            left: WIFI_BUSY_RETRIES,
            next: None,
        }
    }
}

/// A scan whose answer never came, and which is owed another attempt.
///
/// A scan is the one question a busy board refuses with nothing at all. The
/// firmware turns a scan away while another scan owns the scan lock — with
/// `ERR scan=-16`, which is handled where replies are folded — and while a
/// join owns the radio it very often answers nothing: the request reaches a
/// management task that is busy with the operation, and no reply, no `ERR` and
/// no partial list comes back. Silence is therefore the shape this record
/// exists for, and the reason it is worth asking again rather than reporting:
/// the gate is the board finishing what it was doing, and it clears on its
/// own.
///
/// The attempts and the pauses are a busy write's, because it is the same gate
/// in the same firmware. Unlike [`WifiWrite`] the record holds no command and
/// no secret — the scan is the same `@w scan` every time — so the only thing a
/// retry costs is the wait itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanRetry {
    /// Attempts still owed after the unanswered one.
    pub left: u32,
    /// When the next attempt is due, once one is owed.
    pub due: Option<Instant>,
}

impl ScanRetry {
    /// The record a fresh scan opens, with every attempt still owed.
    fn new() -> ScanRetry {
        ScanRetry {
            left: WIFI_BUSY_RETRIES,
            due: None,
        }
    }
}

/// A WiFi action whose `@event wifi` ending the network view is waiting on.
///
/// `@w=` and `@w off` are answered twice: first with an `OK` that only means
/// the request was queued, and then with the phases of an asynchronous
/// operation whose ending — `ready`, `failed` or `off` — carries the `FINAL`
/// flag. The ending is the answer that matters, and remembering which
/// operation this view asked for is what keeps a background lease renewal
/// from claiming it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifiOperation {
    /// The request id the action went out with, which its phases repeat.
    pub id: u32,
    /// The network the command named — the ending does not repeat it. Empty
    /// for `@w off`, which names none.
    pub ssid: String,
    /// When to stop waiting for the ending and read the status back.
    pub until: Instant,
}

impl WifiOperation {
    /// The operation an accessory command starts, under the id it went out
    /// with and the window its ending has.
    ///
    /// `@w=<ssid>,<password>` names the network it is bringing up; the
    /// password is dropped right here and kept nowhere — only the frame has
    /// a use for it.
    fn new(id: u32, command: &str, until: Instant) -> WifiOperation {
        WifiOperation {
            id,
            ssid: command
                .strip_prefix("@w=")
                .and_then(|rest| rest.split(',').next())
                .unwrap_or("")
                .to_string(),
            until,
        }
    }
}

/// Everything one frame paints.
///
/// Not `Clone`: the session owns a live link, and a second copy of a session is
/// not a second session — it is a second handle on the same wire. A frame that
/// needs to be kept is a *rendering*, and `ui::render_to_text` is how one is
/// taken.
#[derive(Debug)]
pub struct App {
    pub lang: Lang,
    pub theme: ThemeChoice,
    pub view: View,
    pub state: ConnectionState,
    pub focus: Focus,
    /// The modifiers a latch chord armed for the next key. See [`Latch`].
    pub latch: Latch,
    /// Whether the rail occupies its column. Ctrl+Up closes it to give the
    /// centre the whole band, and opens it again. It starts open, which is the
    /// designed layout; closing it is the user's call, never a response to a
    /// narrow terminal — that case is handled inside [`crate::ui::regions`],
    /// which shrinks the rail rather than dropping it.
    pub sidebar_visible: bool,
    /// Whether the docked assistant panel takes its column in the terminal
    /// view.
    ///
    /// Open by default: the panel beside the pane is the layout the interface
    /// landed on, and closing it is the user's call — the same rule the rail
    /// follows. When the centre would be narrower than
    /// [`crate::ui::CENTRE_MIN`], the panel yields its column instead of
    /// squeezing the pane, and the full-width assistant view (F5) is where a
    /// small window reads a conversation.
    pub assistant_panel: bool,
    /// Whether frames are painted for the legacy Windows console (conhost).
    ///
    /// Set once by the event loop before the first paint, and false everywhere
    /// else — the tests and `--print-frame` paint the frame the design asks
    /// for. What the pass then does is [`crate::ui::legacy`]'s to say.
    pub legacy_console: bool,
    /// Whether the startup splash is skipped. Off by default — the splash is
    /// the design — and remembered between runs through the settings file.
    /// `main` reads it before the first frame; the palette's own switch
    /// toggles it for the next launch.
    pub no_splash: bool,
    /// When the splash stops standing, while it is up. Set by `main` at
    /// startup, and only where a screen is being drawn: `--print-frame` and
    /// the other batch modes never paint one. A deadline rather than a flag,
    /// so a loop that missed the keystroke still takes the splash down.
    pub splash_until: Option<Instant>,
    /// What this terminal can draw: how much colour, and which glyph set.
    ///
    /// Set once by `main` before the first frame, from the environment and
    /// nothing else — the tests and `--print-frame` keep the design
    /// ([`Capability::FULL`]) unless the environment says otherwise, which is
    /// also how a frame of evidence is printed. Read through [`App::theme`],
    /// which resolves the palette for it, and [`App::glyph`].
    pub capability: Capability,
    pub transport: Transport,
    /// True while switching the transport is refused: a dial took the link out
    /// on one kind, or a command-line flag named it.
    pub transport_locked: bool,
    /// True when the command line pinned the transport. A dial's lock is
    /// released with the link; this one is the operator's and outlives it.
    pub transport_pinned: bool,
    /// The device the session targets (or, once connected, the one it found).
    ///
    /// Empty until there is something true to put here: the row then falls
    /// back to the board the next dial is aimed at, and to the placeholder
    /// when even that is unknown — see [`Self::device_text`]. It is never a
    /// default name, because a name that never changes is a name that tells
    /// the user nothing about which board they are on.
    pub device_name: String,
    /// The name a scan heard for the board being dialled, when it heard one.
    ///
    /// Kept beside the address rather than inside it because the two answer
    /// different questions: the name is what a person recognizes, the address
    /// is what tells two boards flashed from one configuration apart.
    pub advertised_name: Option<String>,
    pub rx: u64,
    pub tx: u64,
    /// Traffic rates sampled off those counters: the top bar's graph and the
    /// number beside it. Sampled by the pump, read by the frame.
    pub traffic: crate::traffic::Traffic,
    /// The link speed once the device has reported one.
    pub baud: Option<u32>,
    /// The signal the link is carrying, in dBm. Unknown until connected.
    pub signal_dbm: Option<i32>,
    pub autoscroll: bool,
    /// `HH:MM:SS`, filled by the event loop so a frame is a pure function.
    pub clock: String,
    /// Which selectable sidebar row the keyboard is on. The rows are numbered
    /// by [`crate::ui::sidebar::targets`], so a cursor can never point at a row
    /// that is not selectable.
    pub sidebar_cursor: usize,
    /// Marches while an operation is in flight; drives the busy indicator in
    /// the top bar. The event loop advances it, a frame only reads it.
    pub tick: usize,
    /// The frame the interface is drawn into: the size the terminal last
    /// answered with. Kept because a key is handled *between* two paints — the
    /// settings window sizes its own scroll from the screen it sits on, and
    /// only the frame knows how tall that is.
    pub screen: Rect,
    pub quick_send: Vec<QuickSend>,
    /// Findings from the panic/reboot watch.
    pub watch: Vec<String>,
    pub notices: Vec<Notice>,
    /// When each toast in [`App::notices`] stops standing, parallel to it:
    /// entry *i* is the deadline of `notices[i]`. Two vectors rather than a
    /// stamped notice, so `Notice` stays what it always was — words and a
    /// level — and every reader of the stack keeps reading one thing.
    pub toast_until: Vec<Instant>,
    /// What the device last said when asked `@i?`, and whether a read is out.
    pub diagnostics: DiagnosticsState,
    /// WiFi management state for the network view.
    pub network: crate::views::network::NetworkState,
    /// The WiFi action whose `@event wifi` phases the view is still waiting
    /// on, if any. See [`WifiOperation`].
    pub wifi_operation: Option<WifiOperation>,
    /// The `@w=` write whose answer has not arrived, or that is owed another
    /// attempt after a busy refusal. See [`WifiWrite`].
    pub wifi_write: Option<WifiWrite>,
    /// The next BLE-name reply acknowledges a write. Its name may itself
    /// end in `custom=yes`, so only the following `@n?` supplies display state.
    pub ble_name_write_pending: bool,
    /// A link came up and the board's name has not been read yet. The read
    /// waits for a free slot: only one question is in flight at a time.
    pub ble_name_read_pending: bool,
    /// A link came up and the LAN token has not been asked for yet. It goes
    /// after the name, because only one question is in flight at a time.
    pub lan_token_read_pending: bool,
    /// The scan whose answer has not arrived, or that is owed another attempt
    /// after being refused. See [`ScanRetry`].
    pub scan_retry: Option<ScanRetry>,
    /// The LAN access state `@s?` reported, token included.
    pub lan_status: LanStatus,
    /// Whether a token is in hand, which is what the sidebar shows.
    pub lan_captured: LanCapture,
    /// The LAN host a dial goes to, as typed — or seeded by the command line.
    /// Empty means "ask the board's WiFi address", which is what the sidebar
    /// shows while it is blank.
    pub lan_host: String,
    /// The LAN token a dial carries: what was typed or seeded by the command
    /// line. A captured token lives in [`App::lan_status`] and the host's
    /// store is consulted last — see [`App::lan_token_for`] for the order.
    pub lan_token: String,
    /// A Bluetooth scan in flight, for the pick-a-board dialog.
    pub ble_scan: BleScan,
    /// Whether the scan in flight dials the board when one answers alone.
    ///
    /// Set by `start_ble_scan_connecting_one` — the startup scan — and taken
    /// back when its scan answers, because the intent belongs to one scan and
    /// not to the session: the next scan, however it was started, asks.
    pub scan_connects_one: bool,
    /// The dial in flight, when Connect was pressed. The open itself runs on
    /// its own thread — a Bluetooth link takes seconds to come up, and seconds
    /// of frozen keyboard is what this field exists to not have.
    pub dialing: Option<DialJob>,
    /// Whether the link now coming up was the startup scan's own. It is
    /// announced to nobody: a program that announces its own routine has a
    /// corner full of its own voice.
    pub quiet_connect: bool,
    /// The assistant's session state for the assistant view.
    pub assistant: crate::views::assistant::AssistantState,
    /// The agent's durable state: tasks, notes and the saved session.
    ///
    /// None until `main` opens it, which is also what the tests get. A store
    /// touches the filesystem, and a `Default` that writes to the user's home
    /// directory is not a default anyone can run a test suite against.
    pub agent_store: Option<crate::agent::store::JsonFile>,
    /// Owner of the loaded conversations, retained while disconnected.
    pub agent_device: String,
    /// Only bytes received from this connection, never local echo or UI text.
    pub agent_serial: crate::serial::journal::SerialJournal,
    pub agent_decoder: crate::views::terminal::Utf8Stream,
    /// Where the interface's own choices are kept between runs. `None` until
    /// `main` opens it — and `None` in a preview, which is what keeps a
    /// printed frame from writing to the user's real settings file. See
    /// [`App::save_settings`].
    pub settings: Option<crate::settings::SettingsStore>,
    /// Where tokens the bridge itself reported are remembered, keyed by the
    /// address a LAN dial would go to. `None` until `main` opens it, which is
    /// what keeps a test suite from writing a token into the user's real
    /// store — and what a test sets to a store with no path of its own to
    /// exercise the remembering without touching the disk.
    pub lan_store: Option<crate::lan_token_store::TokenStore>,
    /// Whether a copy also goes to the desktop's own clipboard tool (`xclip`
    /// and its kin), and not only through OSC 52. `false` until `main` asks for
    /// it, which is also what the tests get: a suite that spawned `wl-copy`
    /// would be a suite that quietly replaced the user's clipboard with its
    /// fixtures.
    pub desktop_clipboard: bool,
    /// The model transport, started on first use rather than at boot: a thread
    /// and a Tokio runtime are not something a `Default` should cost.
    pub agent_client: Option<crate::agent::runtime::AgentClient>,
    /// Where the replies the model is still thinking about arrive — one channel
    /// per question in flight, drained on the same beat as the serial link, so
    /// a slow model cannot freeze the interface and a reply lands in the task
    /// it belongs to.
    ///
    /// A vector, not a single slot. The slot was the first version, and it meant
    /// a second prompt submitted while the first was still being answered
    /// dropped the first one's channel — the reply the user was waiting for,
    /// lost silently.
    pub agent_replies: Vec<crate::agent::runtime::PendingReply>,
    /// The device's own output, as the serial pane shows it.
    pub terminal: TerminalPane,
    /// Whether the pane's first undecodable byte has already been announced.
    ///
    /// Said once, not once per read: a device that speaks something that is
    /// not UTF-8 produces a replacement character in nearly every burst, and a
    /// corner that repeats the same sentence forever is a corner nobody reads.
    /// The count in the bottom bar keeps saying it after the toast has gone.
    pub decode_loss_noticed: bool,
    /// The questions asked of the bridge about itself, and their answers.
    ///
    /// The bridge answers these on a channel of its own, so they are never
    /// mixed with the target's output — but something still has to remember
    /// which question is out, and what to do with an answer that never comes.
    /// See `device`.
    pub talk: Conversation,
    /// Management responses arrive as separately notified fragments, and one
    /// answer is often several; this is what puts them back together.
    ///
    /// Kept in the state rather than rebuilt per event for the same reason a
    /// `String` is: a fragment belonging to a message already half-read cannot
    /// survive a local variable.
    pub management: crate::protocol::ManagementReassembler,
    /// The watch that reads the target's output for a target that is not well:
    /// kernel panics, OOM kills, a board that boots and reboots before it ever
    /// settles. Held here rather than rebuilt per line because a reboot loop
    /// is only visible over a *window* of output, not at any one line of it.
    pub watch_engine: SerialWatch,
    /// How the Enter key is sent on the wire, when the command line named a
    /// translation. The pane asks for this per keystroke, so it belongs to the
    /// state and not to the event loop that set it.
    pub enter: crate::serial::keys::EnterMode,
    /// The byte that ends the session when it is typed, `^]` by default.
    ///
    /// A byte stream has no out-of-band signal, so one byte has to be reserved
    /// for "stop listening" — and it has to be a *byte* rather than a key,
    /// because what arrives at the device is bytes and the reservation has to
    /// hold on the far side of the wire too.
    pub escape: u8,
    /// Where the bytes on the wire are recorded, when the command line asked
    /// for them. See `trace`.
    pub trace: crate::trace::ByteTrace,
    /// Where a trace asked for from the interface goes *instead of* standard
    /// error, when standard error is the terminal this program is drawing in.
    ///
    /// Set by `main` once, before the first frame: the decision belongs to the
    /// terminal the program was handed, and the App only carries it to the
    /// palette's switch. `None` means stderr is the sink — a file, a pipe, or
    /// a test harness, none of which the trace can hurt.
    pub trace_file: Option<std::path::PathBuf>,
    /// Whether a typed line is held until Enter, as `--line-mode` asks.
    pub line_mode: bool,
    /// The line being held. Empty unless line mode is on, and cleared when the
    /// link goes down: a half-typed command belongs to the session that typed
    /// it, and carrying it into the next one would send a stranger your
    /// keystrokes.
    pub pending_line: String,
    /// Whether the target's output is kept as well as painted.
    ///
    /// Off by default, because a terminal pane is already a copy of everything
    /// the target has said and a second one is a leak. On for the script mode,
    /// which has no pane and would otherwise have no way to print what came
    /// back.
    pub collect_output: bool,
    /// What the target has said, kept only while [`Self::collect_output`] is on.
    pub output: VecDeque<Vec<u8>>,
    /// The live link, when one is open. Owns the threads and the counters; the
    /// frame only ever reads what the pump folded out of it.
    pub session: Session,
    /// The notice log: every announcement that has been made, oldest first.
    /// The toasts read [`App::notices`]; the log dialog reads this.
    pub log: Vec<Notice>,
    /// The command palette, when it has taken the keyboard.
    pub palette: Option<palette::PaletteState>,
    /// The modal that has taken the keyboard, if any. A dialog is at most one.
    pub dialog: Option<dialogs::Dialog>,
    /// The dial the session last opened, so `connect` has something to re-dial.
    /// Kept rather than re-derived from the command line, because the keyboard
    /// may have changed the transport since.
    pub last_dial: Option<Dial>,
    /// Set by `quit` (the palette action and the chord share it), read by the
    /// event loop. A flag rather than a return value, so an action run from the
    /// palette can end the session the same way a keypress does.
    pub quit: bool,
}

impl Default for App {
    fn default() -> App {
        App {
            lang: Lang::default(),
            theme: ThemeChoice::default(),
            view: View::Terminal,
            state: ConnectionState::Disconnected,
            focus: Focus::default(),
            latch: Latch::default(),
            sidebar_visible: true,
            assistant_panel: true,
            legacy_console: false,
            no_splash: false,
            splash_until: None,
            capability: Capability::FULL,
            transport: Transport::default(),
            transport_locked: false,
            transport_pinned: false,
            device_name: String::new(),
            advertised_name: None,
            rx: 0,
            tx: 0,
            traffic: crate::traffic::Traffic::default(),
            baud: None,
            signal_dbm: None,
            autoscroll: true,
            clock: "00:00:00".to_string(),
            sidebar_cursor: 0,
            tick: 0,
            // No frame has been drawn yet; the event loop fills this in on its
            // first tick, before any key can arrive.
            screen: Rect::default(),
            quick_send: vec![
                QuickSend::new("help"),
                QuickSend::new("version"),
                QuickSend::new("uname -a"),
                QuickSend::new("df -h"),
                QuickSend::guarded("reboot"),
            ],
            watch: Vec::new(),
            notices: Vec::new(),
            toast_until: Vec::new(),
            diagnostics: DiagnosticsState::default(),
            network: crate::views::network::NetworkState::default(),
            wifi_operation: None,
            wifi_write: None,
            ble_name_write_pending: false,
            ble_name_read_pending: false,
            lan_token_read_pending: false,
            scan_retry: None,
            lan_status: LanStatus::default(),
            lan_captured: LanCapture::default(),
            lan_host: String::new(),
            lan_token: String::new(),
            ble_scan: BleScan::default(),
            scan_connects_one: false,
            dialing: None,
            quiet_connect: false,
            assistant: crate::views::assistant::AssistantState::default(),
            agent_store: None,
            agent_device: "unknown".to_string(),
            agent_serial: crate::serial::journal::SerialJournal::new(
                crate::serial::journal::DEFAULT_CAPACITY,
            ),
            agent_decoder: crate::views::terminal::Utf8Stream::default(),
            settings: None,
            lan_store: None,
            desktop_clipboard: false,
            agent_client: None,
            agent_replies: Vec::new(),
            terminal: TerminalPane::new(),
            decode_loss_noticed: false,
            enter: crate::serial::keys::EnterMode::default(),
            escape: 0x1d,
            line_mode: false,
            pending_line: String::new(),
            trace: crate::trace::ByteTrace::none(),
            trace_file: None,
            collect_output: false,
            output: VecDeque::new(),
            talk: Conversation::new(),
            management: crate::protocol::ManagementReassembler::default(),
            watch_engine: SerialWatch::new(WatchOptions::default()),
            session: Session::new(),
            log: Vec::new(),
            palette: None,
            dialog: None,
            last_dial: None,
            quit: false,
        }
    }
}

impl App {
    /// The theme in force, resolved for what this terminal can show.
    pub fn theme(&self) -> Theme {
        Theme::for_capability(self.theme, self.capability)
    }

    /// The glyph set in force: the marks a view that has only an [`App`] asks
    /// for. A view that already has the theme asks `theme.glyphs()` instead —
    /// the two answer the same thing, from the same field.
    pub fn glyph(&self) -> GlyphSet {
        self.capability.glyphs
    }

    /// The key owning the loaded device state, even while disconnected.
    ///
    /// The link the app is on, spelled the way it dialled: `ble:EE:C7:…` names
    /// an address, `lan:host` a bridge, `stdio:…` a command. The interface's
    /// own display name is a default — two boards are both "Linkr Bee" —
    /// and a store they shared would answer a new board with the last one's
    /// tasks and notes.
    pub fn agent_device_key(&self) -> String {
        self.agent_device.clone()
    }

    /// Seconds since boot, for a timestamp that means something in a log and
    /// nothing to anyone trying to read one.
    ///
    /// The clock in the top bar is wall time, which is right for a person
    /// looking at a frame and wrong for a record that has to be ordered after
    /// a reboot across a timezone.
    pub fn environment_stamp(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    pub fn strings(&self) -> &'static crate::i18n::Strings {
        self.lang.strings()
    }

    /// A view's title in the current language.
    pub fn view_name(&self) -> &'static str {
        self.lang.view_name(self.view)
    }

    /// The connection state as text, in the current language.
    pub fn state_name(&self) -> &'static str {
        self.lang.state_name(self.state)
    }

    /// Whether management commands can go out at all. They travel the BLE
    /// management channel only, so a LAN session cannot reach them however
    /// connected it is — the diagnostics view says so instead of failing later.
    pub fn ble_connected(&self) -> bool {
        self.state == ConnectionState::Connected && self.transport == Transport::Ble
    }

    /// Whether the device can be written to.
    pub fn connected(&self) -> bool {
        self.state == ConnectionState::Connected && self.session.is_live()
    }

    /// The transport as the sidebar shows it: the link's name, then the `◂▸`
    /// that says Enter flips it — or the lock suffix when a dial or a flag has
    /// taken the choice away.
    pub fn transport_text(&self) -> String {
        let s = self.strings();
        if self.transport_locked {
            format!("{} {}", self.transport.label(), s.transport_locked)
        } else {
            format!(
                "{} {}",
                self.transport.label(),
                capability::fold(s.transport_switch_hint, self.glyph())
            )
        }
    }

    /// The placeholder a slot shows while the device has not reported a value.
    pub fn unknown(&self) -> &'static str {
        match self.glyph() {
            GlyphSet::Unicode => self.strings().value_unknown,
            // The placeholder is a rule; where the font has no rule, a hyphen
            // is the same idea in the ASCII set.
            GlyphSet::Ascii => "-",
        }
    }

    /// The baud slot: the speed once known, the placeholder before that.
    pub fn baud_text(&self) -> String {
        match self.baud {
            Some(baud) => baud.to_string(),
            None => self.unknown().to_string(),
        }
    }

    /// The signal reading, or the placeholder while there is none.
    pub fn signal_text(&self) -> String {
        match self.signal_dbm {
            Some(dbm) => format!("{dbm} {}", self.strings().signal_unit),
            None => self.unknown().to_string(),
        }
    }

    /// The glyph for the current state. The chrome and the sidebar row both ask
    /// this, so one frame can never show two different glyphs for one state.
    /// The glyph for the current connection state, in this terminal's set.
    pub fn state_glyph(&self) -> &'static str {
        self.glyph().state(self.state)
    }

    /// The theme's name in the interface language, so a notice, a picker row
    /// and a setting all call it the same word.
    pub fn theme_name(&self, choice: ThemeChoice) -> &'static str {
        let s = self.strings();
        match choice {
            ThemeChoice::Dark => s.theme_dark,
            ThemeChoice::Light => s.theme_light,
            ThemeChoice::Nord => s.theme_nord,
            ThemeChoice::Gruvbox => s.theme_gruvbox,
            ThemeChoice::Solarized => s.theme_solarized,
            ThemeChoice::Dracula => s.theme_dracula,
        }
    }

    /// Keep `choice` as the theme and remember it, returning the notice that
    /// announces it so the caller can log exactly one message.
    pub fn keep_theme(&mut self, choice: ThemeChoice) -> Notice {
        self.theme = choice;
        self.save_settings();
        let s = self.strings();
        Notice {
            text: format!("{}: {}", s.theme_switched_prefix, self.theme_name(choice)),
            level: NoticeLevel::Info,
        }
    }

    /// Open or close the rail, and say so.
    ///
    /// Closing it while the keyboard is on a sidebar row would leave the arrows
    /// driving a rail the user cannot see, so focus follows the rail to the
    /// terminal. Opening it leaves the focus alone: whichever pane was last used
    /// is usually the one being returned to.
    pub fn toggle_sidebar(&mut self) -> Notice {
        self.sidebar_visible = !self.sidebar_visible;
        let s = self.strings();
        let text = if self.sidebar_visible {
            s.sidebar_shown.to_string()
        } else {
            s.sidebar_hidden.to_string()
        };
        if !self.sidebar_visible && self.focus == Focus::Sidebar {
            self.focus = Focus::Terminal;
        }
        Notice {
            text,
            level: NoticeLevel::Info,
        }
    }

    /// Open or close the docked assistant panel.
    ///
    /// Closing it while the keyboard is in the panel would leave the keys
    /// typing into a column the user cannot see, so focus follows it back to
    /// the terminal — the same bargain [`Self::toggle_sidebar`] makes.
    ///
    /// Opening goes two ways beyond the plain flip. From another view it
    /// brings the terminal back, because the column belongs to that view and
    /// opening it anywhere else would put the screen in a state that says
    /// nothing. On a window with no room for the column it opens nothing and
    /// says why: the painter would drop what the key just opened, and a key
    /// that answers with an unchanged screen looks broken. A window that *has*
    /// the room still needs no notice — the column appears, and the screen is
    /// the announcement.
    pub fn toggle_assistant_panel(&mut self) {
        // A run of text the pointer drew belongs to a paint; the panel
        // appearing or going changes which paints are on screen, so the run
        // goes with it.
        crate::views::assistant::clear_selection(self);
        if self.assistant_panel {
            self.assistant_panel = false;
            if self.focus == Focus::Assistant {
                self.focus = Focus::Terminal;
            }
            return;
        }
        if !self.panel_fits() {
            let text = self.strings().asst_panel_narrow.to_string();
            self.push_notice(Notice {
                text,
                level: NoticeLevel::Info,
            });
            return;
        }
        if self.view != View::Terminal {
            self.set_view(View::Terminal);
        }
        self.assistant_panel = true;
    }

    /// Whether the keyboard is in the docked panel.
    ///
    /// Both halves have to hold: the panel is painted in the terminal view
    /// only, and a focus left on it after the view changed would be a caret
    /// nobody can see. [`Self::set_view`] hands the keys back, so this is a
    /// read rather than a second rule.
    pub fn assistant_panel_focused(&self) -> bool {
        self.assistant_panel && self.focus == Focus::Assistant && self.view == View::Terminal
    }

    /// Whether this frame wants the panel's column: open, and on the view it
    /// belongs to. Whether there is *room* for it is
    /// [`crate::ui::regions_for`]'s to say, because that is where the widths
    /// are known.
    pub fn panel_wanted(&self) -> bool {
        self.assistant_panel && self.view == View::Terminal
    }

    /// Whether the docked panel has room in the frame the keyboard is being
    /// handled in.
    ///
    /// The same arithmetic the painter uses, from the size `fit_pane_to` kept:
    /// the alternative is a focus moved into a column the painter then drops,
    /// which is a caret nobody can see and keys that look broken.
    pub fn panel_fits(&self) -> bool {
        crate::ui::regions_for(self.screen, self.sidebar_visible, true)
            .assistant
            .width
            > 0
    }

    /// Show a notice, dropping the oldest when either stack is full.
    ///
    /// One door for both: the toast stack is what is on screen and the log is
    /// what happened. Announcing through a second path would let the two
    /// disagree about the same event. Every toast is given its own deadline
    /// here, so the stack empties one row at a time rather than all at once.
    pub fn push_notice(&mut self, notice: Notice) {
        self.notices.push(notice.clone());
        self.toast_until.push(Instant::now() + TOAST_LIFETIME);
        while self.notices.len() > MAX_NOTICES {
            self.notices.remove(0);
            self.toast_until.remove(0);
        }
        self.log.push(notice);
        while self.log.len() > MAX_LOG {
            self.log.remove(0);
        }
    }

    /// Take every toast whose time is up off the screen, oldest first, so the
    /// last one leaving takes the box with it. The log keeps every word; this
    /// is only about the corner. Takes `now` so a test can watch a stack empty
    /// without sleeping through it.
    pub fn expire_notices(&mut self, now: Instant) {
        while self.toast_until.first().is_some_and(|until| *until <= now) {
            self.toast_until.remove(0);
            self.notices.remove(0);
        }
    }

    /// Close the unattended window when its time is up, and say so.
    ///
    /// The mode is a policy the agent is *told* about, so nothing else would
    /// notice the deadline passing; the pump is the one clock every caller
    /// ticks. Takes `now` so a test can watch it elapse without sleeping
    /// through the window.
    pub fn expire_full_auto(&mut self, now: Instant) {
        let Some(until) = self.assistant.full_auto_until else {
            return;
        };
        if now < until {
            return;
        }
        self.assistant.full_auto_until = None;
        if self.assistant.mode == Some(crate::exec::executor::Mode::FullAuto) {
            self.assistant.mode = Some(crate::exec::executor::Mode::Auto);
        }
        let text = self.strings().asst_full_auto_expired.to_string();
        self.push_notice(Notice {
            text,
            level: NoticeLevel::Warn,
        });
    }

    /// Whether a modal has taken the keyboard, so the event loop can route the
    /// key to the overlay instead of the pane.
    pub fn overlay_open(&self) -> bool {
        self.dialog.is_some() || self.palette.is_some()
    }

    /// Whether the startup splash is still standing.
    ///
    /// A wall-clock read rather than a pumped flag, because the question is
    /// asked by the paint — and a splash whose moment passed between two
    /// keystrokes has to be gone on the next frame whether or not the pump
    /// noticed. `splash_until` stays put once its time is up; nothing else
    /// reads it but this.
    pub fn splash_active(&self) -> bool {
        self.splash_until
            .is_some_and(|until| Instant::now() < until)
    }

    /// Put the splash away: the user pressed a key, or its moment is over.
    pub fn skip_splash(&mut self) {
        self.splash_until = None;
    }

    /// Turn the startup splash on or off, and remember it.
    pub fn toggle_splash(&mut self) -> Notice {
        self.no_splash = !self.no_splash;
        self.save_settings();
        let s = self.strings();
        let word = if self.no_splash {
            s.net_state_off
        } else {
            s.net_state_on
        };
        Notice {
            text: format!("{}: {word}", s.splash_setting),
            level: NoticeLevel::Info,
        }
    }

    /// Switch the interface language, and return the notice announcing it.
    pub fn toggle_language(&mut self) -> Notice {
        self.lang = match self.lang {
            Lang::Zh => Lang::En,
            Lang::En => Lang::Zh,
        };
        self.save_settings();
        let s = self.strings();
        let name = match self.lang {
            Lang::Zh => s.language_zh,
            Lang::En => s.language_en,
        };
        Notice {
            text: format!("{}: {}", s.language_switched_prefix, name),
            level: NoticeLevel::Info,
        }
    }

    /// Flip the transport between the two links a session can be carried over,
    /// and return the notice announcing it.
    ///
    /// Two, not every [`Transport`] there is: `stdio` is how a driver or a
    /// test attaches from a command line, and a session at a serial console is
    /// never one of those, so a row that cycled through it offered a choice
    /// the user could not mean. A locked transport cannot be switched at all:
    /// a command-line flag decided it, or a dial did, and a keypress that
    /// quietly overrode either would make the sidebar's `locked` suffix a lie.
    pub fn toggle_transport(&mut self) -> Notice {
        if self.transport_locked {
            return Notice {
                text: self.strings().transport_is_locked.to_string(),
                level: NoticeLevel::Warn,
            };
        }
        self.transport = match self.transport {
            Transport::Ble => Transport::Lan,
            // `Lan` flips back, and a `stdio` a command line named and a
            // hang-up released lands on the ordinary way in.
            _ => Transport::Ble,
        };
        // Switching to LAN is the same door the WiFi answer opens: the `@s?`
        // that finds the token is asked now, while the BLE link is still up,
        // so it is in hand by the time Connect is pressed — and a session
        // with no link to ask over starts from what the store remembers for
        // the address instead.
        if self.transport == Transport::Lan {
            let _ = self.ensure_lan_token();
            self.seed_lan_token_from_store();
        }
        self.save_settings();
        Notice {
            text: format!(
                "{}: {}",
                self.strings().transport_label,
                self.transport.label()
            ),
            level: NoticeLevel::Info,
        }
    }

    /// Ask the event loop to stop. A flag rather than a return value, so the
    /// palette's `quit` action and the `Ctrl+Q` chord end the session the same
    /// way.
    pub fn request_quit(&mut self) {
        self.quit = true;
    }

    /// Cycle the Enter mode and return the notice announcing it.
    ///
    /// The notice is the only place the mode is named — nothing on screen
    /// shows it — so it names the mode at every step, or a keystroke that
    /// silently changed what Enter sends would be one nobody could learn.
    pub fn cycle_enter_mode(&mut self) -> Notice {
        self.enter = self.enter.next();
        self.save_settings();
        let s = self.strings();
        Notice {
            text: format!("{}: {}", s.enter_mode_label, self.enter.label()),
            level: NoticeLevel::Info,
        }
    }

    /// Flip the I/O trace and return the notice announcing it.
    ///
    /// A runtime switch rather than a command-line flag only, because the
    /// question a trace answers — "did what I typed get there" — is usually
    /// asked after something already went wrong.
    ///
    /// Where the lines go is the terminal's decision, made once in `main`: to
    /// standard error when that is a place a trace can land, and to a file
    /// when standard error *is* the screen — a trace written into the frame
    /// being painted takes the frame with it. The notice names the file when
    /// there is one, because a trace nobody can find is a trace nobody reads.
    pub fn toggle_debug_io(&mut self) -> Notice {
        let on = !self.trace.tracing();
        if on {
            match self.trace_file.clone() {
                Some(path) => {
                    if self.trace.set_trace_file(&path).is_err() {
                        // The file could not be opened; a broken screen is
                        // still better than a silent switch that promised a
                        // trace and kept none.
                        self.trace.set_stderr(true);
                    }
                }
                None => self.trace.set_stderr(true),
            }
        } else {
            self.trace.stop_tracing();
        }
        self.save_settings();
        self.debug_io_notice(on)
    }

    /// The notice a launch owes a trace that was already on: the switch that
    /// turned it on named the file, and a fresh launch writes a fresh one.
    pub fn tracing_notice(&self) -> Option<Notice> {
        self.trace.tracing().then(|| self.debug_io_notice(true))
    }

    /// The words a trace's state is announced with: on or off, and where the
    /// lines go when they go to a file.
    fn debug_io_notice(&self, on: bool) -> Notice {
        let s = self.strings();
        let word = if on { s.net_state_on } else { s.net_state_off };
        let at = if on && self.trace.tracing() && !self.trace.tracing_stderr() {
            self.trace_file
                .as_ref()
                .map(|path| format!(" → {}", path.display()))
                .unwrap_or_default()
        } else {
            String::new()
        };
        Notice {
            text: format!("{}: {}{at}", s.debug_io_label, word),
            level: NoticeLevel::Info,
        }
    }

    /// The file a log save goes to when the user does not name one: the working
    /// directory and a stamp, so two saves never overwrite each other.
    pub fn terminal_log_path() -> String {
        format!(
            "linkr-terminal-{}.log",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        )
    }

    /// Write the pane's retained output to `path`, returning the bytes written
    /// and the name they went to.
    pub fn save_terminal_log_to(&self, path: &std::path::Path) -> io::Result<(usize, String)> {
        let bytes = self.terminal.save_log(path)?;
        Ok((bytes, path.display().to_string()))
    }

    /// Save the pane's log to the default path.
    pub fn save_terminal_log(&self) -> io::Result<(usize, String)> {
        let path = Self::terminal_log_path();
        self.save_terminal_log_to(std::path::Path::new(&path))
    }

    /// Select a view.
    pub fn set_view(&mut self, view: View) {
        // A run the pointer drew is a claim about the rows this view painted;
        // the next view paints different ones, so the run goes.
        if view != self.view {
            crate::views::assistant::clear_selection(self);
        }
        self.view = view;
        // The panel lives in the terminal view; a focus left in it would be a
        // caret the next keystroke lands in with nothing on screen to show it.
        if self.focus == Focus::Assistant && view != View::Terminal {
            self.focus = Focus::Terminal;
        }
        self.save_settings();
    }

    /// Whether a typed key belongs to the pane: the rail is not focused, and
    /// no form is up. The network and assistant views take the keyboard when
    /// they are open — a composer must not type into the console — so "the
    /// pane has the keyboard" is a question about the view as much as about
    /// the focus, and the chords that hand a key to the device ask it.
    pub fn pane_has_the_keyboard(&self) -> bool {
        self.focus == Focus::Terminal && matches!(self.view, View::Terminal | View::Diagnostics)
    }

    /// Take a new LAN host from the prompt and keep it: the row is what a
    /// later run should open with, so the write follows the edit rather than
    /// waiting for a dial that may never happen.
    pub fn set_lan_host(&mut self, host: String) {
        // The token row goes with the address: a bridge's token belongs to
        // that bridge, so a row that was only showing what was remembered for
        // the old one is re-read for the new one — while a token somebody
        // typed by hand stays theirs.
        if self.lan_token_is_the_remembered_copy() {
            self.lan_token.clear();
        }
        self.lan_host = host;
        // The bridge's own report outranks a remembered older one: written
        // first, so the seed below hands the row the current token rather
        // than a copy of the one it replaces.
        self.remember_captured_token();
        self.seed_lan_token_from_store();
        self.save_settings();
    }

    /// Keep the choices a user would resent retyping.
    ///
    /// Called after each change worth remembering rather than at exit, so a
    /// kill costs nothing; one small file write per user action, never per
    /// keystroke. A test or a preview holds no store and this is a no-op,
    /// which is what keeps the suite hermetic and `--print-frame` read-only.
    fn save_settings(&mut self) {
        let Some(store) = self.settings.as_mut() else {
            return;
        };
        let stored = store.read();
        // The remembered half of a Bluetooth dial: the address and the name
        // the board was dialled under. Either moves only with an *addressed*
        // dial — a LAN or a command-line link was not about a board and must
        // not forget the one that was — and the two move together, so a name
        // can never end up beside the address of a different board. A dial
        // that heard no name is not news that the name already kept for the
        // same address was wrong, so that one stays.
        let (address, device_name) = match &self.last_dial {
            Some(Dial::Ble(crate::transport::ble::Selection::Address(address), _)) => {
                let name = match &self.advertised_name {
                    Some(name) => name.clone(),
                    None if crate::transport::ble::same_device(&stored.address, address) => {
                        stored.device_name.clone()
                    }
                    None => String::new(),
                };
                (address.clone(), name)
            }
            _ => (stored.address.clone(), stored.device_name.clone()),
        };
        store.write(&Settings {
            // A `stdio` transport is a fact about this run — a flag built it
            // — and is left out rather than written as a choice.
            transport: match self.transport {
                Transport::Stdio => stored.transport,
                chosen => Some(chosen),
            },
            lan_host: self.lan_host.clone(),
            address,
            device_name,
            view: Some(self.view),
            theme: Some(self.theme),
            lang: Some(self.lang),
            enter: Some(self.enter),
            debug_io: self.trace.tracing(),
            no_splash: self.no_splash,
        });
    }

    /// How many sidebar rows the cursor can reach: the transport row, the
    /// connect row, then either the switch-device row or the LAN host and
    /// token rows, one per view, and one per quick send. This is the same
    /// number [`crate::ui::sidebar::targets`] produces, and a test pins the
    /// two together so navigation can never walk off the list.
    pub fn sidebar_rows(&self) -> usize {
        let connection = match self.transport {
            // The LAN block trades the switch-device row for two of its own:
            // an address and a token are what a LAN dial is built from.
            Transport::Lan => 4,
            _ => 3,
        };
        connection + View::ALL.len() + self.quick_send.len()
    }

    /// Move the sidebar cursor down one row, stopping on the last.
    pub fn cursor_down(&mut self) {
        self.sidebar_cursor = self
            .sidebar_cursor
            .saturating_add(1)
            .min(self.last_cursor());
    }

    /// Move the sidebar cursor up one row, stopping on the first.
    pub fn cursor_up(&mut self) {
        self.sidebar_cursor = self.sidebar_cursor.saturating_sub(1);
    }

    /// The index of the last selectable row; zero when the list is empty, so a
    /// degenerate sidebar still leaves a valid cursor.
    fn last_cursor(&self) -> usize {
        self.sidebar_rows().saturating_sub(1)
    }

    /// Step to the next view in the rota, wrapping at the end.
    pub fn next_view(&mut self) {
        let index = View::ALL.iter().position(|v| *v == self.view).unwrap_or(0);
        self.view = View::ALL[(index + 1) % View::ALL.len()];
    }

    /// Step to the previous view in the rota, wrapping at the start.
    pub fn prev_view(&mut self) {
        let index = View::ALL.iter().position(|v| *v == self.view).unwrap_or(0);
        let last = View::ALL.len() - 1;
        self.view = View::ALL[(index + last) % View::ALL.len()];
    }

    // --- the link ----------------------------------------------------------

    /// Open a link and start the session. The sidebar's transport follows the
    /// link that was actually opened, so the chrome can never name a link other
    /// than the one carrying the session.
    ///
    /// Opens on the calling thread. A caller that cannot afford the wait dials
    /// through [`App::dial_async`] instead, which lands the same way.
    pub fn connect(&mut self, link: Box<dyn Link>) -> io::Result<()> {
        self.adopt(OpenedLink::open(link)?);
        Ok(())
    }

    /// Take a link that is already open, and move the interface onto it.
    ///
    /// The landing half of [`App::connect`], for a dial that paid for the open
    /// on a thread of its own. The transport follows the link that was actually
    /// opened, and the state says `connecting` until the link's threads report
    /// it — the same beat-by-beat arrival a synchronous open gets.
    fn adopt(&mut self, opened: OpenedLink) {
        crate::views::assistant::switch_device(self, &opened.description);
        self.agent_serial =
            crate::serial::journal::SerialJournal::new(crate::serial::journal::DEFAULT_CAPACITY);
        self.agent_decoder = crate::views::terminal::Utf8Stream::default();
        let kind = opened.kind;
        self.session.adopt(opened);
        self.transport = kind;
        self.state = ConnectionState::Connecting;
        // The row names the board *this* link is on, from the moment there is
        // a link to name: a board whose name never changed would leave two
        // boards on one bench indistinguishable.
        self.device_name = self.device_name_for_link();
    }

    /// What the Device row calls the link that is up.
    ///
    /// The board's own name when the air carried one — a bench with several
    /// units suffixes it, which is what tells them apart — and then the tail
    /// of the address the link is actually on. Both, not either: two boards
    /// flashed from one configuration carry one name between them, and this
    /// row is the only place the user can see which of the two was dialled.
    /// A board heard only as an address is named by its address, because a
    /// name invented here would belong to a different board.
    fn device_name_for_link(&self) -> String {
        let described = self.session.describe().to_string();
        match self.transport {
            Transport::Ble => {
                let address = described.strip_prefix("ble:").unwrap_or(&described);
                // Hex groups, so an address is recognized as one and a
                // searched-for name is not mistaken for it. A platform that
                // identifies devices by UUID keeps its own spelling, and a
                // board that never named itself is named by its address.
                match &self.advertised_name {
                    Some(name) => Self::named_with_tail(name, address),
                    None => address.to_string(),
                }
            }
            // A bridge names itself by what it runs — "loopback", the command
            // — which is the whole of what it is.
            Transport::Stdio => described
                .strip_prefix("stdio: ")
                .unwrap_or(&described)
                .to_string(),
            // The LAN rows carry the host themselves, so this row is not shown
            // for a LAN link; the host is still the honest answer if it is.
            Transport::Lan => self.session.lan_host().to_string(),
        }
    }

    /// The tail of a Bluetooth address — its last two groups, `48:CF`.
    ///
    /// Short enough to sit beside a name in the sidebar, and long enough that
    /// two boards on one bench do not share it. `None` for anything that is
    /// not a colon-separated hex address: a UUID is not one, and neither is
    /// the word a name search dialled with.
    fn address_tail_of(address: &str) -> Option<&str> {
        let groups: Vec<&str> = address.split(':').collect();
        let looks_like_an_address = groups.len() >= 2
            && groups
                .iter()
                .all(|group| !group.is_empty() && group.chars().all(|c| c.is_ascii_hexdigit()));
        if !looks_like_an_address {
            return None;
        }
        let last_two = groups.len() - 2;
        let offset = groups[..last_two]
            .iter()
            .map(|g| g.len() + 1)
            .sum::<usize>();
        Some(&address[offset..])
    }

    /// A board's name with the tail of the address it belongs to: "Linkr Bee
    /// 078C" and `FB:F6:91:14:33:3A` read together as `Linkr Bee 078C 33:3A`.
    ///
    /// The one spelling of a named board, wherever a row has to write one: a
    /// scan result coming in, the link coming up, and the shelf being read at
    /// startup all name the same board the same way. The tail is upper-cased
    /// with the address, because the address rows show hex the way it is
    /// written down, not the way a platform happens to report it.
    fn named_with_tail(name: &str, address: &str) -> String {
        match Self::address_tail_of(&address.to_ascii_uppercase()) {
            Some(tail) => format!("{name} {tail}"),
            None => name.to_string(),
        }
    }

    /// Name the board a run starts aimed at, from what the last run learned.
    ///
    /// The shelf keeps the name and the address as a pair, and this is the
    /// pair put back: the name beside the dial — so a dial that comes up
    /// keeps calling the board by its name — and the row that says it, the
    /// same row a scan result paints.
    pub fn remember_device_name(&mut self, address: &str, name: &str) {
        let Some(name) = crate::transport::ble::display_name(Some(name)) else {
            // A shelf written by an older build can carry a name that is
            // nothing but controls. The address is still the board's name.
            self.advertised_name = None;
            self.device_name = address.to_ascii_uppercase();
            return;
        };
        self.device_name = Self::named_with_tail(&name, address);
        self.advertised_name = Some(name);
    }

    /// Name the target a dial is aimed at, for the row that shows the wait.
    ///
    /// The name the air carried is dropped with the last dial — it belonged
    /// to that target — unless this dial is aimed at the very same address: a
    /// name remembered for the address being dialled names this target
    /// exactly as much as it named the last one. The address is the name of
    /// last resort.
    fn aim_device_row_at(&mut self, dial: &Dial) {
        let same_address = matches!(
            (self.last_dial.as_ref(), dial),
            (
                Some(Dial::Ble(crate::transport::ble::Selection::Address(previous), _)),
                Dial::Ble(crate::transport::ble::Selection::Address(address), _),
            ) if previous.eq_ignore_ascii_case(address)
        );
        if !same_address {
            self.advertised_name = None;
        }
        self.device_name = match (dial, &self.advertised_name) {
            (Dial::Ble(crate::transport::ble::Selection::Address(address), _), Some(name)) => {
                Self::named_with_tail(name, address)
            }
            _ => match Self::dialed_device_name(dial) {
                Some(name) => name,
                None => self.device_name.clone(),
            },
        };
    }

    /// A remembered board the scan has now heard by name.
    ///
    /// A run can be aimed at an address whose name it does not know: the name
    /// is learned when a board is dialled from a scan result, and a run that
    /// only ever auto-dialled its remembered board has never had one — the
    /// Device row showed a MAC. The scan that fills the picker hears the name,
    /// and hearing it once is enough to name the row and to keep the name for
    /// the next run. Nothing else moves: the dial still goes where it went.
    ///
    /// A name that *changed* is news: the owner renamed the board, and the
    /// row that still showed the old label would be naming a board that no
    /// longer answers to it. The scan's name is only a label though, so the
    /// board's own answer is what settles it — see
    /// [`App::remember_the_board_name`].
    fn name_the_remembered_board(&mut self, devices: &[crate::cli::FoundDevice]) {
        let Some(address) = self.last_dial.as_ref().and_then(|dial| match dial {
            Dial::Ble(crate::transport::ble::Selection::Address(address), _) => {
                Some(address.as_str())
            }
            _ => None,
        }) else {
            return;
        };
        let Some(name) = devices
            .iter()
            .find(|device| crate::transport::ble::same_device(&device.address, address))
            .and_then(|device| device.name.clone())
        else {
            return;
        };
        if self.advertised_name.as_deref() == Some(name.as_str()) {
            return;
        }
        self.advertised_name = Some(name.clone());
        self.device_name = Self::named_with_tail(&name, address);
        self.save_settings();
    }

    /// The board's own name, and where it is shown.
    ///
    /// The board is asked once per link, and the answer is what every label
    /// in the interface is built from: the Device row, the remembered shelf,
    /// and the network view. The name in the air is a snapshot the owner can
    /// change from another client, so a host that keeps it shows a name the
    /// board no longer has.
    ///
    /// Only a BLE dial that names an address writes the shelf: a LAN or a
    /// stdio link is not about a board and must not put one on the shelf.
    fn remember_the_board_name(&mut self, name: &str) {
        let name = name.trim();
        if name.is_empty() {
            return;
        }
        let Some(address) = self.last_dial.as_ref().and_then(|dial| match dial {
            Dial::Ble(crate::transport::ble::Selection::Address(address), _) => {
                Some(address.clone())
            }
            _ => None,
        }) else {
            return;
        };
        self.advertised_name = Some(name.to_string());
        self.device_name = Self::named_with_tail(name, &address);
        self.save_settings();
    }

    /// What the Device row says: the board that is up, or the one the next
    /// dial is aimed at, or the placeholder when neither is known.
    pub fn device_text(&self) -> String {
        if !self.device_name.is_empty() {
            return self.device_name.clone();
        }
        match self.last_dial.as_ref().and_then(Self::dialed_device_name) {
            Some(name) if !name.is_empty() => name,
            _ => self.unknown().to_string(),
        }
    }

    /// A dial's target as a device name, or `None` when the dial does not
    /// name one — `find the nearest device` is a direction, not a board.
    fn dialed_device_name(dial: &Dial) -> Option<String> {
        match dial {
            Dial::Ble(crate::transport::ble::Selection::Address(address), _) => {
                Some(address.to_ascii_uppercase())
            }
            Dial::Ble(crate::transport::ble::Selection::Name(name), _) => Some(name.clone()),
            Dial::Ble(crate::transport::ble::Selection::Any, _) => None,
            Dial::Stdio(command) => Some(
                crate::transport::stdio::StdioBridge::command_description(command),
            ),
            Dial::Lan { host, .. } => Some(crate::transport::lan::host_key(host)),
        }
    }

    /// Dial what the command line asked for.
    pub fn dial(&mut self, dial: &Dial) -> io::Result<()> {
        // A LAN dial needs the token, and `@s?` is the only place there is to
        // get one. Asked while the old link is still up — before the new one
        // closes it — so a user who was on Bluetooth and picks LAN from the
        // palette has the field filled by the time the dial happens. A LAN
        // dial from a standing start has nothing to ask, and answers with the
        // token the operator typed; `ensure` is also a no-op when the session
        // already has its answer.
        if let Dial::Lan { .. } = dial {
            let _ = self.ensure_lan_token();
        }
        let opened = dial.opened()?;
        // Name the row before the dial is remembered: whether the row keeps
        // the name it already has is decided against the *previous* target.
        self.aim_device_row_at(dial);
        // Remembered only once the link opened: a dial that failed is not
        // something `connect` should try again behind the user's back.
        self.last_dial = Some(dial.clone());
        // Locked for as long as the link is up: a keypress that switched the
        // label under a live link would make the sidebar's `locked` suffix a
        // lie. Hanging up releases it — see `disconnect` — which is what makes
        // switching the transport and dialling again a sequence the user can
        // actually perform.
        self.transport_locked = true;
        self.adopt(opened);
        Ok(())
    }

    /// Open the link again, or say why there is nothing to open.
    ///
    /// This is the palette's `connect` and the sidebar's `Connect` row. A LAN
    /// dial is built from the rows the user is looking at; anything else
    /// re-dials the last link rather than inventing one, so the actions can
    /// never dial something the command line did not name. One dial at a time:
    /// a link takes seconds to come up, and a second press while the first is
    /// still in the air is answered with a sentence rather than a race.
    pub fn reconnect(&mut self) {
        if self.session.is_live() {
            return;
        }
        if self.dialing.is_some() {
            let text = self.strings().dialing.to_string();
            self.push_notice(Notice {
                text,
                level: NoticeLevel::Warn,
            });
            return;
        }
        let dial = match self.dial_for_connect() {
            Ok(dial) => dial,
            Err(text) => {
                self.push_notice(Notice {
                    text,
                    level: NoticeLevel::Warn,
                });
                return;
            }
        };
        self.dial_async(&dial, false);
    }

    /// The dial Connect would make.
    ///
    /// A LAN dial is built from the sidebar's rows rather than recalled from
    /// the last one, because the rows are what the user is looking at and
    /// changing before they press Connect.
    fn dial_for_connect(&self) -> Result<Dial, String> {
        if self.transport == Transport::Lan {
            return self.lan_dial();
        }
        // Anything but LAN is recalled, because a board is picked by the
        // scan's result and a bridge by its child process — neither can be
        // rebuilt from the rows. A *LAN* dial is not recalled onto a
        // Bluetooth row: that is the link the user just moved away from, and
        // connecting to it would flip the row they had chosen.
        match &self.last_dial {
            Some(dial) if !matches!(dial, Dial::Lan { .. }) => Ok(dial.clone()),
            _ => Err(self.strings().no_link.to_string()),
        }
    }

    /// The LAN dial the sidebar rows describe, or the sentence saying why they
    /// do not describe one.
    pub fn lan_dial(&self) -> Result<Dial, String> {
        let host = self.lan_host_effective();
        if host.is_empty() {
            return Err(self.strings().lan_needs_host.to_string());
        }
        let token = self.lan_token_for(&host);
        Ok(Dial::Lan { host, token })
    }

    /// The address a LAN dial goes to: what was typed, then the board's own
    /// WiFi address — the row the user would otherwise read off another view
    /// and retype. The address of a link that is already up is not consulted
    /// here: a dial and a live link cannot coexist on one session.
    fn lan_host_effective(&self) -> String {
        let typed = self.lan_host.trim();
        if !typed.is_empty() {
            return typed.to_string();
        }
        // The status's `ip` is the firmware's word and not always an address:
        // `down` and `ready` are what it says while there is nothing to dial,
        // and aiming a dial — or remembering a token — at one of those words
        // is how a junk key like `down <token>` got into the store.
        self.network
            .wifi
            .as_ref()
            .map(|wifi| wifi.ip.trim().to_string())
            .filter(|ip| crate::transport::lan::is_bridge_address(ip))
            .unwrap_or_default()
    }

    /// The host as the sidebar shows it. While a LAN link is up, that link's
    /// own address wins: the row reports the truth, and what Enter edits is
    /// the next dial.
    pub fn lan_host_text(&self) -> String {
        let live = self.session.lan_host();
        if !live.is_empty() {
            return live.to_string();
        }
        let host = self.lan_host_effective();
        if host.is_empty() {
            self.unknown().to_string()
        } else {
            host
        }
    }

    /// The token a LAN dial carries, looking where one can be, in the order a
    /// user would: the row they just typed into, the one the bridge reported
    /// (`@s?`), the one remembered for this host.
    fn lan_token_for(&self, host: &str) -> Option<String> {
        let typed = self.lan_token.trim();
        if !typed.is_empty() {
            return Some(typed.to_string());
        }
        if !self.lan_status.token.is_empty() {
            return Some(self.lan_status.token.clone());
        }
        self.lan_store.as_ref()?.token_for(host).map(str::to_string)
    }

    /// Whether a token is in hand. What the sidebar may say about one, and all
    /// it may say: never the token itself.
    pub fn lan_token_hand(&self) -> bool {
        !self.lan_token.trim().is_empty() || !self.lan_status.token.is_empty()
    }

    /// Write a captured token into the store, keyed by the address a LAN dial
    /// would go to: the row the user typed, or the board's own WiFi address —
    /// the same fallback [`App::lan_host_effective`] takes.
    ///
    /// Nothing is said about it: the session already has the token, and a
    /// notice about a cache would be noise over the link that works. A store
    /// that cannot be written, or no address at all, loses nothing this
    /// session needs.
    fn remember_lan_token(&mut self, token: &str) {
        let host = self.lan_host_effective();
        if host.is_empty() {
            return;
        }
        let Some(store) = self.lan_store.as_mut() else {
            return;
        };
        if store.remember(&host, token).is_ok() {
            let _ = store.save();
        }
    }

    /// Keep a token the bridge itself reported, now that an address for it is
    /// known.
    ///
    /// The store is keyed by the address a dial would go to, and the capture
    /// can happen while no address is knowable yet — a Bluetooth session
    /// starts without one and learns it from the WiFi status or from the row
    /// somebody types it into. Whichever comes first is the first moment the
    /// token can be kept.
    fn remember_captured_token(&mut self) {
        if self.lan_status.token.is_empty() {
            return;
        }
        let token = self.lan_status.token.clone();
        self.remember_lan_token(&token);
    }

    /// Whether the token row is only showing the copy remembered for the
    /// address a LAN dial would go to, rather than something typed by hand.
    ///
    /// This is the TUI's stand-in for the web's dirty flag: the store's copy
    /// may be replaced by what the bridge reports, and follows the address
    /// when it changes, while a hand-typed token is somebody's own. An empty
    /// row counts as replaceable, which is what lets a capture fill one.
    fn lan_token_is_the_remembered_copy(&self) -> bool {
        let typed = self.lan_token.trim();
        if typed.is_empty() {
            return true;
        }
        let host = self.lan_host_effective();
        !host.is_empty()
            && self
                .lan_store
                .as_ref()
                .is_some_and(|store| store.token_for(&host) == Some(typed))
    }

    /// Fill the token row from the store, when the row is empty and something
    /// is remembered for the address a dial would go to.
    ///
    /// The address, not the session: a token belongs to the bridge that
    /// issued it, so a row showing one is a row saying "this bridge has been
    /// here before".
    pub fn seed_lan_token_from_store(&mut self) {
        if !self.lan_token.trim().is_empty() {
            return;
        }
        let host = self.lan_host_effective();
        let Some(store) = self.lan_store.as_ref() else {
            return;
        };
        if let Some(token) = store.token_for(&host) {
            self.lan_token = token.to_string();
        }
    }

    /// Drop what the store remembers for the address a LAN dial would go to.
    ///
    /// `token=none` is the bridge saying its LAN door has no key, and a store
    /// that kept the old one would hand it to the next session's dial — where
    /// it reads as a wrong token and a broken bridge rather than a key that
    /// changed. A store that cannot be written loses nothing this session
    /// needs.
    fn forget_lan_token(&mut self) {
        let host = self.lan_host_effective();
        if host.is_empty() {
            return;
        }
        let Some(store) = self.lan_store.as_mut() else {
            return;
        };
        if store.forget(&host) {
            let _ = store.save();
        }
    }

    /// The token as the sidebar shows it: stars for one in hand, the bridge's
    /// own `off` when `@s?` said there is no key to hold, and the unknown
    /// placeholder otherwise. The store is not consulted — whether it holds a
    /// token is a file read, and a frame is not the place for one.
    pub fn lan_token_text(&self) -> String {
        if self.lan_token_hand() {
            LAN_TOKEN_MASK.to_string()
        } else if matches!(self.lan_captured, LanCapture::None) {
            self.strings().lan_token_off.to_string()
        } else {
            self.unknown().to_string()
        }
    }

    /// Open a link without stopping the interface.
    ///
    /// The whole dial — build and open — runs on a thread of its own and the
    /// pump collects the answer, because the open is where a Bluetooth dial
    /// spends its seconds. Returns whether the dial was started: a second
    /// Connect pressed while one is in flight is not a second dial.
    pub fn dial_async(&mut self, dial: &Dial, quiet: bool) -> bool {
        if self.dialing.is_some() {
            return false;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let opening = dial.clone();
        // The *whole* dial goes out here, open included: a Bluetooth link takes
        // seconds to come up, and the open is the seconds. All the frame sees
        // of it is `connecting` in the state row.
        std::thread::spawn(move || {
            let _ = tx.send(opening.opened());
        });
        // The lock goes on at the *press*, not at the catch: what it protects
        // is the choice the dial was built from, and a transport switched
        // under a dial in flight would leave the sidebar naming a link that is
        // not the one coming.
        //
        // The row names the target while it comes up, so the wait shows what
        // is being waited for.
        self.aim_device_row_at(dial);
        self.transport_locked = true;
        self.state = ConnectionState::Connecting;
        self.dialing = Some(DialJob {
            dial: dial.clone(),
            quiet,
            rx,
        });
        true
    }

    /// Fold a finished dial in: the link, or the sentence saying why not.
    ///
    /// Called from the pump, so the frame shows the link coming up on the same
    /// beat the rest of the session moves on.
    fn poll_dial(&mut self) {
        let Some(job) = self.dialing.as_ref() else {
            return;
        };
        let outcome = match job.rx.try_recv() {
            Ok(outcome) => outcome,
            Err(std::sync::mpsc::TryRecvError::Empty) => return,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                Err(io::Error::other("the dial thread ended without an answer"))
            }
        };
        let job = self.dialing.take().expect("checked just above");
        match outcome {
            Ok(opened) => {
                // Remembered only once the link opened: a dial that failed is
                // not something `reconnect` should try again behind the user's
                // back.
                self.last_dial = Some(job.dial);
                self.save_settings();
                self.quiet_connect = job.quiet;
                self.adopt(opened);
            }
            Err(why) => {
                // The lock went on at the press; a dial that failed gives it
                // back, the same way hanging up does.
                self.quiet_connect = false;
                self.transport_locked = self.transport_pinned;
                self.session.fail();
                let text = format!("{}{why}", self.strings().link_failed);
                self.push_notice(Notice {
                    text,
                    level: NoticeLevel::Error,
                });
            }
        }
    }

    /// Hang up, and say so once. Announcing it here rather than in the pump is
    /// what keeps a deliberate hang-up from reading as a dropped link.
    pub fn disconnect(&mut self) {
        if !self.session.is_live() {
            return;
        }
        let name = self.session.describe().to_string();
        // Ended *out loud* where the bearer can end it: a board left connected
        // to a client that has hung up stops advertising, and the next client
        // — a phone, a second bench — cannot find it. The wait is short,
        // because this is an interactive key and the link is being asked to
        // end, not audited.
        self.session.hang_up(Duration::from_millis(250));
        self.state = ConnectionState::Disconnected;
        self.wifi_write = None;
        self.scan_retry = None;
        // The lock a dial took out went with the dial: with the link down
        // there is nothing left for it to protect, and switching the transport
        // is exactly what hanging up is for. A transport the command line
        // named stays locked — that pin is the operator's, not a dial's.
        self.transport_locked = self.transport_pinned;
        let text = format!("{}{}", self.strings().link_closed, name);
        self.push_notice(Notice {
            text,
            level: NoticeLevel::Info,
        });
    }

    /// Hang up on the way out, and wait for the goodbye to land.
    ///
    /// Every exit from the interface calls this — the quit key, Ctrl+C, a
    /// terminal that went away, a paint that failed — because "the board is
    /// free the moment this process is" is a promise the next client depends
    /// on. No notice and no state: nobody is left to read one.
    pub fn hang_up(&mut self, grace: Duration) -> bool {
        let ended = self.session.hang_up(grace);
        self.state = ConnectionState::Disconnected;
        self.transport_locked = self.transport_pinned;
        self.wifi_write = None;
        self.scan_retry = None;
        ended
    }

    /// One pump: fold whatever the link produced into the frame, and announce
    /// the two transitions that are worth a toast.
    ///
    /// The session already folded the counters and the state; what is left is
    /// the *edge*: a link that came up and a link that went away. Announcing
    /// the state instead of the transition would raise a toast on every tick.
    /// File any answer the model has finished thinking about.
    ///
    /// A reply arrives as `(task_id, outcome)` so it can be matched to the goal
    /// it belongs to even when two prompts are in flight and answer out of
    /// order. Every live channel is drained, not just one — draining a single
    /// slot would leave the rest to arrive on a later beat with their task ids
    /// still matching, which is the same answer worked twice.
    ///
    /// A reply nobody is waiting for is dropped rather than applied to the
    /// newest task: a stale answer filed against the wrong question is worse
    /// than none, because it reads as though the model said it.
    pub fn drain_agent_replies(&mut self) {
        // Taken out so the store can be borrowed while the channels are read,
        // and so a channel that is still live goes back rather than being
        // replaced by the next one's.
        let live = std::mem::take(&mut self.agent_replies);
        let mut arrived: Vec<(String, crate::agent::runtime::Progress)> = Vec::new();
        for pending in live {
            // The channel is dropped only when the stream is over. Anything else
            // — nothing yet, or a delta in mid-answer — keeps it: a stream that
            // was cut off after its first chunk would otherwise lose the rest,
            // and the answer would stop half-way through without a `Done` to
            // close it.
            let mut closed = false;
            loop {
                match pending.receiver.try_recv() {
                    Ok(item) => {
                        if item.0 != pending.task_id {
                            continue;
                        }
                        closed = !matches!(item.1, crate::agent::runtime::Progress::Delta(_));
                        arrived.push(item);
                        if closed {
                            break;
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        arrived.push((
                            pending.task_id.clone(),
                            crate::agent::runtime::Progress::Failed(
                                crate::agent::runtime::Failure::Malformed,
                            ),
                        ));
                        closed = true;
                        break;
                    }
                }
            }
            if !closed {
                self.agent_replies.push(pending);
            }
        }

        for (task_id, progress) in arrived {
            let Some(found) = self
                .assistant
                .tasks
                .iter()
                .find(|task| task.id == task_id)
                .cloned()
            else {
                continue;
            };

            // A delta is the reply arriving, so it goes into the summary the
            // view already paints: the answer is typed out as the model writes
            // it, which is the whole point of asking for a stream.
            let crate::agent::runtime::Progress::Delta(delta) = &progress else {
                // `Done` and `Failed` are the end of the answer, and both go
                // through the closing path below.
                Self::finish(self, &found, progress);
                continue;
            };
            if let Some(slot) = self
                .assistant
                .tasks
                .iter_mut()
                .find(|task| task.id == task_id)
            {
                // The delta rewrites the answer the dock is showing, and the
                // dock trims its rows to what is newest — every row moves. A
                // run drawn over them no longer names what it highlighted.
                self.assistant.select = None;
                slot.summary.push_str(delta);
                // Not "answered" yet: a partial reply is not a reply, and `Done`
                // is what says the model finished.
                if slot.status == "asking" {
                    slot.status = "typing".to_string();
                }
            }
        }
    }

    /// Close one answer: file it, remember it, and say what it was.
    ///
    /// Both `Done` and `Failed` come here, because the difference between them is
    /// one field — the summary and the status — and everything else a finished
    /// answer does is the same for both.
    fn finish(
        app: &mut App,
        found: &crate::agent::tasks::TaskRecord,
        step: crate::agent::runtime::Progress,
    ) {
        // The task list and the thread are about to change; a run drawn over
        // either no longer names its rows.
        app.assistant.select = None;
        let (summary, status, usage) = match &step {
            crate::agent::runtime::Progress::Done(reported) => {
                (found.summary.clone(), "answered", *reported)
            }
            _ => {
                let failure = match &step {
                    crate::agent::runtime::Progress::Failed(failure) => failure.clone(),
                    _ => crate::agent::runtime::Failure::Malformed,
                };
                (
                    failure.describe(app.lang),
                    "failed",
                    crate::agent::usage::Usage::default(),
                )
            }
        };

        // Which conversation asked: the reply goes back to the thread that sent
        // the question, wherever the panel has moved since. A task whose chat is
        // gone — the store's cap forgot it — lands in the panel's current one
        // rather than nowhere, because an answer read in the wrong thread is
        // still better than an answer the user is told they never got.
        let chat_id = app
            .assistant
            .task_chat
            .iter()
            .find(|(task, _)| task == &found.id)
            .map(|(_, chat)| *chat);
        let index = chat_id
            .and_then(|id| app.assistant.chats.iter().position(|chat| chat.id == id))
            .unwrap_or_else(|| app.assistant.active.min(app.assistant.chats.len() - 1));
        // Stamped from the clock as it is now, read before the conversation is
        // borrowed: the stamp is what the store's cap orders conversations by,
        // so it belongs to the save below rather than to the paint above.
        let now = app.environment_stamp() * 1000;
        let chat = &mut app.assistant.chats[index];

        // The two numbers the view shows are a running total, so one more message is
        // folded in rather than replacing the count.
        let running = crate::agent::usage::Usage {
            input: chat.usage.0,
            output: chat.usage.1,
            ..crate::agent::usage::Usage::default()
        };
        let merged = crate::agent::usage::add_usage(&running, &usage);
        chat.usage = (merged.input, merged.output);

        // The reply is the assistant's turn in the conversation. A failure is a turn
        // too: the thread of what was asked and what came back is the record, and a
        // gap in it is worse than a turn that says the model did not answer.
        let turn = crate::agent::session::DisplayLine {
            role: "assistant".to_string(),
            text: summary.clone(),
        };
        chat.display.push(turn.clone());
        // A failure is shown but not remembered: the same contract `push_turn`
        // keeps for the question's path — the thread is the record of what
        // happened, and the messages are what the model is asked to continue.
        if status == "answered" {
            chat.messages.push(turn);
        }
        let keep = crate::agent::session::SESSION_MESSAGES;
        let keep_display = crate::agent::session::SESSION_DISPLAY;
        let from = chat.display.len().saturating_sub(keep_display);
        chat.display.drain(..from);
        let from = chat.messages.len().saturating_sub(keep);
        chat.messages.drain(..from);
        chat.updated_at = now;

        // Persisted here rather than only at the view's Enter: the reply arrives on
        // this beat, and a session saved on the question alone would lose every
        // answer if the program ended between the two.
        crate::views::assistant::persist_session(app);

        // Whatever happened, the answer is in the store: a task that says "failed"
        // is the record of a question that was asked.
        let saved = crate::agent::tasks::TaskRecord {
            summary,
            status: status.to_string(),
            ..found.clone()
        };
        if let Some(store) = app.agent_store.as_mut() {
            crate::agent::tasks::TaskStore::new(&mut *store).save(&saved);
        }
        if let Some(slot) = app
            .assistant
            .tasks
            .iter_mut()
            .find(|task| task.id == found.id)
        {
            slot.summary = saved.summary;
            slot.status = saved.status;
        }
    }

    pub fn pump(&mut self) {
        self.poll_ble_scan();
        // Before the session is read, so a link that has just landed is
        // already in `was_live` — the tick that catches a dial is the tick the
        // link came up on, not one that finds it already there.
        self.poll_dial();
        // The toasts' own clock, on the same beat as everything else. The
        // log keeps every word; the corner empties.
        self.expire_notices(Instant::now());
        // The unattended window's clock, on that same beat: Full Auto is a
        // promise that expires on time, not on the next keypress.
        self.expire_full_auto(Instant::now());

        self.drain_agent_replies();
        let was_live = self.session.is_live();
        let was_connected = self.state == ConnectionState::Connected;
        let describe = self.session.describe().to_string();
        let now = Instant::now();
        for event in self.session.pump() {
            match event {
                LinkEvent::Data(bytes) => {
                    self.agent_serial.append(&self.agent_decoder.push(&bytes));
                    self.terminal.push(&bytes);
                    self.note_decode_loss();
                    self.trace.rx(&bytes);
                    if self.collect_output {
                        self.output.push_back(bytes.clone());
                    }
                    {
                        // The same bytes, read a second time by the watch. It
                        // looks for a line saying `Kernel panic` or `Out of
                        // memory`, and where lines end is its own business — a
                        // bootloader that ends them with `\r` alone must not be
                        // invisible to it. The pane keeps the bytes whole.
                        let at = wall_clock_ms();
                        self.observe(&bytes, at);
                    }
                }
                // Something the far end said in words: a bridge announcement,
                // not target output. It is shown and never typed, and it is
                // scrubbed first because what a bridge says about itself is
                // where its access token would be.
                LinkEvent::Notice(text) => {
                    let notice = Notice {
                        text: crate::lan_token_store::redact(&text),
                        level: NoticeLevel::Info,
                    };
                    self.push_notice(notice);
                }
                // An answer from the bridge about itself. Reassembled here and
                // handed to whoever asked; nothing about it reaches the pane,
                // because it is not something the target said.
                LinkEvent::Management(fragment) => {
                    let decision = self.management.push(&fragment);
                    let outcome = match decision {
                        crate::protocol::Reassembly::Incomplete => None,
                        crate::protocol::Reassembly::Complete { payload, meta } => {
                            Some((meta, payload))
                        }
                        crate::protocol::Reassembly::Error(why) => {
                            let text = why.message(false).to_string();
                            self.push_notice(Notice {
                                text,
                                level: NoticeLevel::Error,
                            });
                            None
                        }
                    };
                    if let Some((header, payload)) = outcome {
                        // The answer is evidence too, and it is the half of the
                        // dialog a person cannot reconstruct from the questions.
                        // Redacted first, like everything else that leaves this
                        // app: a reply is where `token=…` shows up.
                        self.trace.rx_reply(&crate::lan_token_store::redact(
                            &String::from_utf8_lossy(&payload),
                        ));
                        if !self.talk.offer(&header, &payload) {
                            // Not an answer to a question in flight: the
                            // bridge talking on its own. WiFi provisioning is
                            // the one that keeps talking past its `OK` — the
                            // phases of `@event wifi` — and those belong to
                            // the view; anything else is left uninterpreted
                            // rather than guessed at.
                            self.apply_wifi_events(&String::from_utf8_lossy(&payload));
                        }
                        // A scan streams: the bridge answers one network at a
                        // time rather than once at the end, and the list is
                        // where the user watches it happen. Folded here rather
                        // than only at finalize, so a network appears as it is
                        // heard — the alternative is a view that reads "scanning"
                        // for eleven seconds and then fills at once, which is
                        // the same wait with nothing to watch.
                        //
                        // The last line may be half a name while its frame is
                        // still in flight. It is corrected by the next one,
                        // which is what a streaming list looks like on the wire.
                        if self.talk.waiting() == Some(Query::WifiScan) {
                            let partial = scan_results(self.talk.pending_lines());
                            if !partial.is_empty() {
                                self.network.scan_results = partial;
                            }
                        }
                    }
                }
                // A link coming up or going down is a new console. A write
                // still waiting on the board is dropped with the link
                // it belonged to — the record holds a password, and a board
                // that is gone is not owed the retry. A scan owed one goes the
                // same way: the next link is not the one that was busy.
                LinkEvent::Opened | LinkEvent::Closed(_) => {
                    self.wifi_write = None;
                    self.scan_retry = None;
                }
            }
        }
        // Answers are collected between ticks and read here, because the tick
        // that asked is never the tick that was answered. A timeout is not an
        // error until it is reported, and reporting it here is what stops a
        // grid reading "loading…" for want of a reply that is not coming.
        if let Some(reply) = self.talk.take_reply() {
            let stamp = App::clock_now();
            self.apply_reply(reply, &stamp);
        }
        if let Some(query) = self.talk.abandon(now) {
            self.report_unanswered(query, now);
        }
        // An `@event wifi` ending that never came is given up on the same
        // beat as an answer's own timeout, and the status is read back
        // instead.
        self.expire_wifi_operation(now);
        // A `@w=` write the board refused for busy is asked again on the beat
        // its pause is over.
        self.send_due_wifi_write(now);
        // And so is a scan nobody answered, for the same reason: the gate it
        // was refused by clears on its own.
        self.send_due_scan_retry(now);
        // A program that asks a question — where is the cursor, how wide is the
        // screen — blocks until it hears back, so the emulator's answers go out
        // on the tick that produced them. Always *after* the feed: an answer is
        // about the screen those bytes have just painted. With no link they are
        // dropped, which is the right way round — a cursor report delivered late
        // is worse than one never sent, because the program that asked has
        // already given up and moved on.
        for reply in self.terminal.take_replies() {
            self.session.send(&reply);
        }
        let now_live = self.session.is_live();
        if self.dialing.is_some() {
            // A dial in flight is what the screen is about to be: the open
            // waits on a radio, and the state the session last knew — the link
            // before this one, or nothing at all — would paint a calm
            // `disconnected` over a dial that is very much happening.
            self.state = ConnectionState::Connecting;
        } else if let Some(state) = self.session.state() {
            self.state = state;
        }
        if !was_connected && self.state == ConnectionState::Connected {
            if std::mem::take(&mut self.quiet_connect) {
                // The startup scan dialled this board itself: the link coming
                // up is not news the interface owes the user.
            } else {
                let text = format!("{}{}", self.strings().link_opened, describe);
                self.push_notice(Notice {
                    text,
                    level: NoticeLevel::Info,
                });
            }
            // The token is asked the moment there is a link to ask over, the
            // way the web asks on connect: a user who later switches to LAN
            // finds the row already in hand rather than learning a fetch is
            // needed. Links that cannot carry the question (and sessions that
            // already have their answer) are a no-op by design.
            //
            // The board's name is read on every link too, and the answer is
            // what the Device row shows from then on: the name in the air is
            // a snapshot, and the owner can change it from another client at
            // any time, so a host that trusted the snapshot would keep
            // showing a name the board no longer has. The name goes first and
            // the token follows it, because only one question is in flight at
            // a time.
            self.ble_name_read_pending = self.ble_connected();
            self.lan_token_read_pending = self.ble_connected();
        } else if was_live && !now_live {
            // A quiet dial that died before it was ever announced has nothing
            // left to be quiet about; the next connection is its own news.
            self.quiet_connect = false;
            let s = self.strings();
            let (prefix, level) = if self.state == ConnectionState::Failed {
                (s.link_failed, NoticeLevel::Error)
            } else {
                (s.link_closed, NoticeLevel::Warn)
            };
            let text = format!("{prefix}{describe}");
            self.push_notice(Notice { text, level });
        }
        if was_live && !now_live {
            // The last thing a target says very often has no newline after it —
            // a prompt waiting for a command that will not come — and the watch
            // holds such a line until one arrives. Ending it here is what lets
            // it report what happened at the moment the link died, which is
            // when a report matters most.
            self.observe(b"\n", wall_clock_ms());
            // Nothing else can arrive on this link, so a question left open
            // would otherwise be abandoned only at its timeout — reporting a
            // hang-up as a slow bridge. Its view slot is closed first, or the
            // pane it was asked for keeps spinning for a bridge that is gone.
            if let Some(question) = self.talk.waiting() {
                self.stop_waiting(question);
            }
            self.talk.reset();
            self.management.reset();
            self.ble_name_write_pending = false;
            self.ble_name_read_pending = false;
            self.lan_token_read_pending = false;
            // And the half-typed line goes with it.
            self.pending_line.clear();
        }
        // A signal reading belongs to a link that is up or on its way up: a
        // dial that failed, a board that died, the user's own hang-up — with
        // none of them is there a link the top bar should still be describing.
        if !now_live && self.dialing.is_none() {
            self.signal_dbm = None;
        }
        // Optional reads resume whenever the request slot becomes free,
        // including after a refusal, timeout, or intervening user request.
        self.ask_pending_reads();
        self.rx = self.session.rx();
        self.tx = self.session.tx();
        // The same beat the counters moved on: the graph is a clock, and this
        // is the clock.
        self.traffic.sample(self.rx, self.tx, now);
    }

    /// What the target has printed since the last call, for a caller with no
    /// pane of its own. See [`App::collect_output`].
    pub fn take_output(&mut self) -> Vec<Vec<u8>> {
        self.output.drain(..).collect()
    }

    /// Whether a question this view asked is still outstanding.
    ///
    /// Asked by the script mode, which has to know when to stop pumping; the
    /// frame never needs to, because a tick is always followed by another.
    ///
    /// A WiFi action counts from the moment it is sent until the board
    /// finishes with the radio, because its ack is not its answer: see
    /// [`App::apply_reply`] and [`WifiOperation`]. A caller waiting on this —
    /// the script mode, the resident session — therefore waits out the join
    /// itself and not the ack that starts it.
    ///
    /// A retry counts too, in both the shapes one takes: a write the board
    /// refused for busy is owed another attempt on a later beat, and a scan
    /// nobody answered is owed one for the same reason. A script that stopped
    /// pumping when the refusal arrived would exit in the middle of the retry —
    /// reporting a join, or a scan, that the board had not been asked for a
    /// second time.
    pub fn waiting_on_device(&self) -> bool {
        self.talk.waiting().is_some()
            || self.wifi_operation.is_some()
            || self
                .wifi_write
                .as_ref()
                .is_some_and(|write| write.next.is_some())
            || self
                .scan_retry
                .as_ref()
                .is_some_and(|retry| retry.due.is_some())
    }

    /// The wall clock, `HH:MM:SS`, local time.
    ///
    /// Free rather than a method, because it is not about the state: a read's
    /// stamp answers "when did the device tell you this", which is a question
    /// about the world and not about `App`.
    pub fn clock_now() -> String {
        let now = chrono::Local::now();
        now.format("%H:%M:%S").to_string()
    }

    /// Hand target output to everything that reads rather than paints.
    fn observe(&mut self, bytes: &[u8], at: i64) {
        if self.watch_engine.feed_bytes(bytes, at).is_empty() {
            return;
        }
        // Re-described from the whole set rather than appended to, because a
        // boot loop is one finding replacing several banners: what the sidebar
        // shows has to be the engine's current opinion and not a history of its
        // changing mind.
        let language = if self.lang == Lang::Zh { "zh" } else { "en" };
        self.watch = crate::watch::describe_findings(&self.watch_engine.findings(), language);
    }

    /// Look for boards, and open the list to pick from.
    ///
    /// The question this answers is the one nothing else can: which board is
    /// *this* one, when there are two on the bench and neither was named on a
    /// command line. `--scan` answers it for a shell and leaves the interface
    /// unable to act on the answer, so re-typing the MAC it just showed is the
    /// work it was supposed to save.
    pub fn start_ble_scan(&mut self) -> Result<(), String> {
        // A scan opened by hand asks; only the startup scan dials a lone
        // board, and that intent does not leak into this one.
        self.scan_connects_one = false;
        self.begin_ble_scan(false)?;
        self.dialog = Some(crate::dialogs::Dialog::DevicePick(
            crate::dialogs::DevicePick {
                devices: Vec::new(),
                cursor: 0,
                scanning: true,
                message: String::new(),
                scroll: 0,
            },
        ));
        Ok(())
    }

    /// Start the scan itself, with no window of its own.
    ///
    /// The list, when there is one, is the caller's business: a scan the user
    /// asked for opens it before the first advertisement arrives — the wait is
    /// the answer's other half — where the startup scan has nothing to say
    /// until it has heard something to say.
    fn begin_ble_scan(&mut self, first_board: bool) -> Result<(), String> {
        self.ble_scan.reset();
        if first_board {
            self.ble_scan.start_first_board(BLE_SCAN_TIMEOUT)?;
        } else {
            self.ble_scan.start(BLE_SCAN_TIMEOUT)?;
        }
        // A dialog is the top of the modal stack, so it takes the keyboard
        // from the palette rather than joining it underneath: the list is
        // what the next key is for.
        self.palette = None;
        Ok(())
    }

    /// Start the startup scan: the one that dials instead of asking.
    ///
    /// Same list as [`App::start_ble_scan`], with two differences. The scan
    /// ends at the first board that answers instead of at the end of the
    /// window, so a start on a bench where the board is already advertising
    /// does not sit through a full scan for an answer it has; and a scan that
    /// hears exactly one device advertising the Linkr Management Service dials it quietly
    /// — a user who runs this on a bench has one board in front of them and
    /// did not ask for a chooser or for a window announcing it — where two or
    /// more boards put the list up, because only then is there a choice to
    /// make.
    pub fn start_ble_scan_connecting_one(&mut self) -> Result<(), String> {
        self.scan_connects_one = true;
        self.begin_ble_scan(true)
    }

    /// Stop listening and close the list.
    ///
    /// Closing the dialog matters as much as stopping the thread: a dialog left
    /// open over a finished scan would offer Enter on a list nothing is adding
    /// to, and a user who cancels wants the screen back.
    pub fn cancel_ble_scan(&mut self) {
        self.scan_connects_one = false;
        self.ble_scan.reset();
        self.dialog = None;
    }

    /// Dial the board with this address.
    ///
    /// The address is what a scan result identifies a device by — a name is a
    /// substring, and two boards on a bench can both be called "Linkr Bee" —
    /// so the dial takes the id, and the click that picked it was the user's
    /// answer to "which one". `rssi` is the signal the scan heard it at, and
    /// `quiet` marks the startup scan's own dial: the hall is caught off the
    /// board coming up, and nothing announces it.
    pub fn connect_to_board(
        &mut self,
        address: &str,
        advertised_name: Option<&str>,
        rssi: Option<i16>,
        quiet: bool,
    ) {
        let selection = crate::transport::ble::Selection::Address(address.to_string());
        if !self.dial_async(&crate::session::Dial::Ble(selection, None), quiet) {
            return;
        }
        // Set *after* the dial, so the dial's own naming of its target cannot
        // undo it: the name the scan heard is a better answer than the address
        // the dial was aimed with, and it is not known to the dial. The name
        // is display-only, and controls from the air must not reach a cell.
        let advertised_name = crate::transport::ble::display_name(advertised_name);
        if let Some(name) = &advertised_name {
            self.advertised_name = Some(name.clone());
        }
        self.device_name = match advertised_name {
            Some(name) => Self::named_with_tail(&name, address),
            None => address.to_ascii_uppercase(),
        };
        // The signal the scan heard the board at. A connected board stops
        // advertising, so the reading taken while listening is the last one
        // there will be — and one taken from the air is worth more than the
        // placeholder. The pump takes it back if this dial never lands: a
        // reading belongs to a link that is up or on its way up.
        if let Some(dbm) = rssi {
            self.signal_dbm = Some(i32::from(dbm));
        }
        self.dialog = None;
        self.set_view(crate::event::View::Terminal);
        self.focus = crate::app::Focus::Terminal;
    }

    /// Fold whatever the background scan has seen into the open dialog.
    ///
    /// Called from `pump`, so the dialog fills on the same beat as the console:
    /// a scan whose results appeared only after the pump would look like a scan
    /// that had finished and then thought of something.
    fn poll_ble_scan(&mut self) {
        match self.ble_scan.poll() {
            // Devices while the scan is still listening: the list on screen is
            // refilled where the user is already looking, so a scan that takes
            // its time is a scan the user can watch working — the same way the
            // web's own chooser fills as devices answer.
            Ok(true) if self.ble_scan.is_running() => self.refresh_scan_list(),
            Ok(true) => {
                let devices = std::mem::take(&mut self.ble_scan.devices);
                self.settle_scan(devices);
            }
            Ok(false) => {}
            // A failure has a sentence, and a sentence is what the user is
            // owed: "no adapter" is not the same news as "no boards".
            Err(why) => self.report_scan_failure(why),
        }
        if !self.ble_scan.is_running() {
            // Finished, failed or never started: the one-shot intent goes with
            // it, and the dialog's "listening" flag clears so the legend stops
            // offering a cancel that would do nothing.
            self.scan_connects_one = false;
            if let Some(crate::dialogs::Dialog::DevicePick(pick)) = &mut self.dialog {
                pick.scanning = false;
            }
        }
    }

    /// Refill an open picker from the scan's live list.
    ///
    /// Only devices advertising the Linkr Management Service, as in
    /// [`App::settle_scan`]: a keyboard on the bench is noise a user does not
    /// want to wait through.
    /// The cursor follows the row it was on by device rather than by index,
    /// because a device that appears above the cursor would otherwise move
    /// the selection under the user's fingers.
    fn refresh_scan_list(&mut self) {
        let mut devices = std::mem::take(&mut self.ble_scan.devices);
        devices.retain(|device| device.board);
        self.name_the_remembered_board(&devices);
        if let Some(crate::dialogs::Dialog::DevicePick(pick)) = &mut self.dialog {
            let selected = pick.selected().map(|device| device.address.clone());
            pick.devices = devices;
            if let Some(address) = selected {
                if let Some(index) = pick
                    .devices
                    .iter()
                    .position(|device| device.address == address)
                {
                    pick.cursor = index;
                }
            }
            if pick.cursor >= pick.devices.len() {
                pick.cursor = pick.devices.len().saturating_sub(1);
            }
        }
    }

    /// Fold a finished scan in: list the boards, and dial a lone one when the
    /// scan was opened to connect.
    ///
    /// Only devices advertising the Linkr Management Service are listed. A
    /// keyboard on the bench is noise a user does not want to wait through,
    /// and the list this program can act on is the management one — everything
    /// else is a device this bridge has nothing to say to.
    ///
    /// One board and the scan was the startup one: dial it. A bench with one
    /// board on it is the common case, and making the user pick from a list of
    /// one is a click that answers nothing. Two or more and the list is up to
    /// pick from — the case where nothing on a command line says which. None,
    /// at startup, says nothing at all: no window appeared while the scan
    /// listened, so none is owed for its empty answer, and `Switch device` is
    /// where a user who wants the list goes and asks.
    ///
    /// A scan the user opened asks from the start: its list is already on
    /// screen, and it is filled here whether it found anything or not.
    fn settle_scan(&mut self, mut devices: Vec<crate::cli::FoundDevice>) {
        // Taken rather than read: the intent is the startup scan's alone, and a
        // scan that has answered cannot still hold it.
        let connect_single = std::mem::take(&mut self.scan_connects_one);
        devices.retain(|device| device.board);
        self.name_the_remembered_board(&devices);
        if connect_single {
            // A user who moved on while the scan listened — switched the
            // transport to LAN, dialled something by hand — is not waiting for
            // this answer any more.
            if self.session.is_live() || self.dialing.is_some() || self.transport != Transport::Ble
            {
                return;
            }
            match devices.as_slice() {
                [board] => {
                    // The link coming up is announced by the pump, which sees
                    // every dial's Connected edge — except a quiet one, which
                    // is what this is: nobody asked for this dial aloud.
                    let address = board.address.clone();
                    let name = board.name.clone();
                    self.connect_to_board(&address, name.as_deref(), board.rssi, true);
                }
                [] => {}
                _ => {
                    self.dialog = Some(crate::dialogs::Dialog::DevicePick(
                        crate::dialogs::DevicePick {
                            devices,
                            cursor: 0,
                            scanning: false,
                            message: String::new(),
                            scroll: 0,
                        },
                    ));
                }
            }
            return;
        }
        let glyphs = self.capability.glyphs;
        // The window's own arithmetic, taken before the picker is borrowed:
        // `panel_wanted` reads the app that `&mut self.dialog` is about to
        // hold, and a modal's geometry is the frame's, not the picker's.
        let (screen, sidebar, panel) = (self.screen, self.sidebar_visible, self.panel_wanted());
        if let Some(crate::dialogs::Dialog::DevicePick(pick)) = &mut self.dialog {
            pick.devices = devices;
            pick.cursor = pick.cursor.min(pick.devices.len().saturating_sub(1));
            // A fresh answer is not the old failure: what the scan said before
            // belongs to the scan before.
            pick.message.clear();
            // The window's own arithmetic, asked the way the key handler asks
            // it: a row the box is too narrow for is more than one row tall,
            // and the scroll counts the rows the paint will draw.
            let width = crate::ui::overlay::dialog_body_width(screen, sidebar, panel) as usize;
            let spans = pick.line_spans(width.max(1), glyphs);
            let rows = spans.iter().sum::<usize>().max(1);
            let room = crate::ui::overlay::dialog_body_room(screen, sidebar, panel, rows);
            pick.follow(room, &spans);
        }
    }

    /// Say why a scan could not run: in the picker when one is open, and as a
    /// notice when none is — every scan in the interface opens the picker, so
    /// the notice is the fallback rather than the usual side, but a failure is
    /// owed a sentence wherever it lands, and a dropped one would leave the
    /// user waiting for a board that will never be found.
    fn report_scan_failure(&mut self, why: String) {
        if let Some(crate::dialogs::Dialog::DevicePick(pick)) = &mut self.dialog {
            pick.message = why;
        } else {
            self.push_notice(Notice {
                text: why,
                level: crate::event::NoticeLevel::Error,
            });
        }
        self.ble_scan.reset();
    }

    /// Ask for the LAN access token if nobody has yet, and let the caller
    /// ignore the answer: the capture lands on whichever pump it arrives on.
    ///
    /// `@s?` is the only place the bridge reports its LAN access token, and a
    /// LAN dial without one is a dial that gets refused, so this is called
    /// wherever the LAN door opens — a link that has just come up, a network
    /// that has just joined, a transport switched to LAN. Asked once per
    /// session: the first answer is the session's, `token=none` (auth off)
    /// counts as one, and a question already in flight is left to come back.
    ///
    /// Asked rather than waited on because the alternative is a user who has
    /// to know the token exists before they can learn it.
    pub fn ensure_lan_token(&mut self) -> Result<(), String> {
        if !matches!(self.lan_captured, LanCapture::Unknown)
            || self.talk.waiting() == Some(Query::Lan)
        {
            return Ok(());
        }
        self.ask_device(Query::Lan)
    }

    /// Ask the bridge about itself. Returns why the question could not go out.
    ///
    /// The answers land in `self.diagnostics` and `self.network` on whichever
    /// pump they arrive on, so this does not block and does not return them:
    /// asking is one tick's work and being answered is another's.
    pub fn ask_device(&mut self, query: Query) -> Result<(), String> {
        if !self.connected() {
            return Err(self.strings().not_connected.to_string());
        }
        if !self.ble_connected() {
            // Asked of a LAN session this is not a failure to report later; it
            // is the wrong bearer, and the answer should say which before the
            // user waits for a reply that was never going to come.
            return Err(self.strings().diag_no_ble.to_string());
        }
        // Asking replaces whatever was outstanding, so the question being
        // replaced has its view slot closed first: without that, the spinner
        // of the read this ask just replaced spins until the *new* answer
        // lands — or for ever, if it never does.
        if let Some(previous) = self.talk.waiting() {
            self.stop_waiting(previous);
        }
        self.ble_name_write_pending = false;
        let (id, body) = self.talk.ask(query, Instant::now());
        let frame = match crate::protocol::encode_management_request(id, body.as_bytes()) {
            Ok(frame) => frame,
            Err(why) => {
                // The question was opened before the frame could be built;
                // dropping it is what keeps the view from waiting for an
                // answer to a request that never left — and blaming the bridge
                // for the silence.
                self.talk.reset();
                return Err(why.message(false).to_string());
            }
        };
        if !self.session.send_management(frame) {
            self.talk.reset();
            return Err(self.strings().not_connected.to_string());
        }
        // The question is evidence as much as its answer is: a record that
        // held the replies and not what was asked for would leave the reader
        // guessing which query each line belongs to. `body` is the command
        // itself, and it goes through the scrubber like every other one.
        self.trace.tx_command(&accessory::redact_command(body));
        // A read that has gone out owns its own view slot: nothing else will
        // fill it, and leaving it untouched would let a stale answer look like
        // the one just asked for.
        match query {
            Query::Diagnostics => {
                self.diagnostics.loading = true;
                self.diagnostics.error = None;
            }
            Query::Uart | Query::Wifi | Query::WifiScan | Query::Webdav | Query::BleName => {
                self.network.loading = true;
                self.network.error = None;
            }
            // The LAN read carries a secret, so its slot is the settings it
            // fills and not the network view: a token that appears on screen
            // next to a wifi name is a token in a screenshot.
            Query::Lan => self.lan_status.loading = true,
        }
        // A scan is the one question the app may ask again by itself, so it
        // carries the record of what it is owed. A fresh scan gets the whole
        // allowance; an attempt that is already owed keeps the attempts it has
        // left, because the count is what bounds the waiting — restarting it
        // per attempt would bound nothing.
        if query == Query::WifiScan {
            match self.scan_retry.as_mut() {
                Some(retry) => retry.due = None,
                None => self.scan_retry = Some(ScanRetry::new()),
            }
        }
        Ok(())
    }

    /// Change the bridge's UART — baud, framing, flow control.
    ///
    /// The write and its confirmation are one act: the bridge is asked again
    /// what it ended up at, so the frame's own baud comes from the bridge
    /// rather than from what we meant to set. A target that refuses the rate
    /// therefore shows the rate it kept.
    pub fn set_uart(&mut self, settings: &UartSettings) -> Result<(), String> {
        let command = accessory::set_uart_command(settings)?;
        self.send_accessory(&command, Query::Uart)
    }

    /// Join a network, or forget the one it joined (`@w off` with no SSID).
    pub fn set_wifi(&mut self, ssid: &str, password: &str) -> Result<(), String> {
        let action = if ssid.trim().is_empty() {
            "off"
        } else {
            "connect"
        };
        let command = accessory::wifi_command(action, ssid, password)?;
        self.send_accessory(&command, Query::Wifi)
    }

    /// Turn WebDAV log upload on at a nonempty `url`.
    ///
    /// The firmware decides whether the feature exists at all; a board built
    /// without it answers the command with an error, which is shown where it
    /// happened instead of being hidden behind a disabled control.
    pub fn set_webdav(&mut self, url: &str) -> Result<(), String> {
        let command = accessory::webdav_command("on", url)?;
        self.send_accessory(&command, Query::Webdav)
    }

    /// Disable upload only when the caller explicitly asks to do so.
    pub fn disable_webdav(&mut self) -> Result<(), String> {
        let command = accessory::webdav_command("off", "")?;
        self.send_accessory(&command, Query::Webdav)
    }

    /// Set the advertised BLE name and read it back.
    ///
    /// The read is the confirmation: the bridge advertises what it stored, and
    /// a write that was accepted is not a value the view can show until the
    /// bridge has repeated it.
    pub fn set_ble_name(&mut self, name: &str) -> Result<(), String> {
        let command = accessory::ble_name_command(name)?;
        self.ble_name_write_pending = true;
        let result = self.send_accessory(&command, Query::BleName);
        if result.is_err() {
            self.ble_name_write_pending = false;
        }
        result
    }

    /// Restore the MAC-derived advertised name and read it back.
    pub fn reset_ble_name(&mut self) -> Result<(), String> {
        self.ble_name_write_pending = true;
        let result = self.send_accessory(&accessory::reset_ble_name_command(), Query::BleName);
        if result.is_err() {
            self.ble_name_write_pending = false;
        }
        result
    }

    /// Send one management command the caller has already built, and wait for
    /// the read that confirms it.
    ///
    /// Which read follows is read off the command rather than passed in,
    /// because the command *is* the statement of what is being changed — and a
    /// caller that could name the read separately could name the wrong one.
    pub fn run_accessory(&mut self, command: &str) -> Result<(), String> {
        let query = match command.split([' ', '=']).next().unwrap_or("").as_bytes() {
            b"@u" => Query::Uart,
            b"@w" => Query::Wifi,
            b"@d" => Query::Webdav,
            b"@n" => Query::BleName,
            _ => return Err(self.strings().net_bad_command.to_string()),
        };
        self.ble_name_write_pending = query == Query::BleName;
        let result = self.send_accessory(command, query);
        if result.is_err() {
            self.ble_name_write_pending = false;
        }
        result
    }

    /// Ask the bridge what networks it can see.
    ///
    /// This is the bridge scanning, not this host: the radio on this machine
    /// and the one on the board are in different places, and a laptop's list
    /// of networks says nothing about what the board can reach from where it
    /// is bolted down.
    pub fn scan_wifi(&mut self) -> Result<(), String> {
        self.send_accessory(Query::WifiScan.command(), Query::WifiScan)?;
        // A new scan replaces the old list: rows left over from the last one
        // under a running scan read as networks this one has found.
        self.network.scan_results.clear();
        self.network.settle_focus();
        Ok(())
    }

    /// Send an accessory command and wait for the answer to the question that
    /// follows it.
    ///
    /// The write and the read are one operation on purpose. `OK` alone is not
    /// enough to put anything in a view: it says the bridge accepted the
    /// command, not what it is doing now, and the two disagree whenever the
    /// firmware clamps a value — which is exactly when showing the command you
    /// sent rather than the state the bridge is in would mislead.
    fn send_accessory(&mut self, command: &str, query: Query) -> Result<(), String> {
        if !self.connected() {
            return Err(self.strings().not_connected.to_string());
        }
        if !self.ble_connected() {
            return Err(self.strings().net_wifi_needs_ble.to_string());
        }
        // Secrets never leave this function unredeacted, but the command *is*
        // the thing going to the bridge: only what is remembered and shown
        // goes through the scrubber.
        let shown = accessory::redact_command(command);
        if query != Query::BleName {
            self.ble_name_write_pending = false;
        }
        let now = Instant::now();
        // The question this replaces loses its spinner here rather than when
        // the new answer arrives; see `ask_device`.
        if let Some(previous) = self.talk.waiting() {
            self.stop_waiting(previous);
        }
        let (id, _) = self.talk.ask(query, now);
        let frame = match crate::protocol::encode_management_request(id, command.as_bytes()) {
            Ok(frame) => frame,
            Err(why) => {
                self.talk.reset();
                return Err(why.message(false).to_string());
            }
        };
        if !self.session.send_management(frame) {
            self.talk.reset();
            return Err(self.strings().not_connected.to_string());
        }
        // A WiFi write is answered twice, and only the phases that follow its
        // `OK` carry the ending; remembering the operation is what lets them
        // land on this view. The deadline is for a bridge that never sends
        // them. See [`WifiOperation`].
        if query == Query::Wifi {
            self.wifi_operation = Some(WifiOperation::new(id, command, now + WIFI_EVENT_FALLBACK));
            // The command is kept for as long as its answer may take, because
            // a busy refusal is retried with it rather than re-asked of the
            // user. Anything else sent replaces the question this answer
            // belonged to, so the record — a password and all — goes with it.
            self.wifi_write = Some(WifiWrite::new(command));
        } else {
            self.wifi_write = None;
        }
        self.trace.tx_command(&shown);
        self.network.loading = true;
        self.network.error = None;
        // The label names what the command does, and a scan is not a status
        // read: `@w scan` may take twenty seconds and fills a list.
        let prefix = match query {
            Query::WifiScan => self.strings().net_scan,
            _ => self.strings().net_status,
        };
        self.push_notice(Notice {
            text: format!("{prefix} {shown}"),
            level: NoticeLevel::Info,
        });
        Ok(())
    }

    /// Fold one answer in, whatever it answered.
    fn apply_reply(&mut self, reply: Reply, stamp: &str) {
        // Whatever happened, nothing is waiting for it any more — and clearing
        // that first is what stops a failed read from leaving its view reading
        // "loading…" underneath an error.
        self.stop_waiting(reply.query);
        if !reply.status.ok {
            // A busy refusal is not a failure to report: the board's gate is
            // held by whatever WiFi work is in flight, and it clears on its
            // own. The question is owed another attempt instead. A write says
            // busy with `ERR wifi=-16` and a scan with `ERR scan=-16`; a scan
            // can also be refused by silence, which is handled where timeouts
            // are (see [`ScanRetry`]). Only when the attempts run out does it
            // arrive here as a failure.
            let code = if matches!(reply.query, Query::Wifi | Query::WifiScan) {
                accessory::wifi_error_code(&reply.status.error)
            } else {
                None
            };
            if code == Some(accessory::WIFI_BUSY) {
                let owed = match reply.query {
                    Query::Wifi => self.retry_wifi_write(),
                    _ => self.retry_scan(Instant::now()),
                };
                if owed {
                    return;
                }
            }
            if reply.query == Query::BleName {
                self.ble_name_write_pending = false;
            }
            // Whatever the refusal was, a scan it named is not owed anything
            // by it: the record goes, so that a scan asked later starts with
            // its whole allowance.
            if reply.query == Query::WifiScan {
                self.scan_retry = None;
            }
            // A `@w=` write that was answered is not owed anything any more,
            // whichever way the answer went. This is where the password the
            // record held stops being kept, and where a refused write stops
            // claiming to be an operation: the board never started one, so no
            // phase of it is coming.
            if reply.query == Query::Wifi {
                self.wifi_write = None;
                self.finish_wifi_operation();
            }
            // The board already holds the radio: that is a refusal like any
            // other — the write did not happen — but not a mysterious one. The
            // gate is the radio's state and not the name it was handed, so the
            // same code comes back whether the network asked for is the one
            // already up or another one entirely, and the sentence says both
            // what that means and what switching takes. Nothing to read back:
            // the row already says which network the board is on.
            // A scan that failed says so in its own words rather than an `ERR`
            // line, and those words are not a sentence to put in front of a
            // user: the failure gets one notice whichever shape it arrived in.
            let error = match reply.query {
                Query::WifiScan => self.strings().net_scan_failed.to_string(),
                // The bridge's refusals are `errno` values. A code this crate
                // knows becomes a sentence; one it does not keeps its line,
                // because the line and not the number is what has the words
                // in it.
                Query::Wifi => match code {
                    Some(code) => self.lang.wifi_failure(code),
                    None => reply.status.error.clone(),
                },
                _ => reply.status.error.clone(),
            };
            if matches!(reply.query, Query::Uart) {
                // The UART window shows the refusal where the user is looking;
                // the notice below is the log's copy of the same fact.
                crate::dialogs::uart_answered(self, &error, false);
            }
            match reply.query {
                Query::Diagnostics => self.diagnostics.error = Some(error.clone()),
                // Same reason as an unanswered `@s?`: the bridge saying "no"
                // to the token question is not news the user can act on, and
                // the capture is best effort either way.
                Query::Lan => return,
                _ => self.network.error = Some(error.clone()),
            }
            self.push_notice(Notice {
                text: error,
                level: NoticeLevel::Error,
            });
            return;
        }
        // The answer arrived, so the write is finished with as far as the
        // interface is concerned — including the copy of the command it was
        // holding for a retry. The operation, if the write started one, is
        // waited on separately; see [`WifiOperation`]. The same for a scan:
        // what was owed another attempt is not owed one any more.
        match reply.query {
            Query::Wifi => self.wifi_write = None,
            Query::WifiScan => self.scan_retry = None,
            _ => {}
        }
        let text = reply.lines.join("\n");
        match reply.query {
            Query::Diagnostics => self.diagnostics.apply(&reply.lines, stamp.to_string()),
            // A read is how the frame learns the wire's own rate. Asking the
            // target would be asking somebody who does not know: this is the
            // bridge's UART, not the target's console.
            Query::Uart => {
                if let Some(settings) = accessory::parse_uart_settings(&text) {
                    self.baud = Some(settings.baud);
                }
                // The UART window, when it is the one that asked, shows the
                // bridge's own answer and takes the rate from it.
                crate::dialogs::uart_answered(self, &text, true);
            }
            // `@w?` is a status: the one network the bridge joined, or none.
            Query::Wifi => {
                if let Some(status) = accessory::parse_wifi_status(&text) {
                    // `OK wifi=accepted` is the bridge saying the write was
                    // queued, which is not a state the row can wear: the
                    // ending arrives as `@event wifi` phases. The name it
                    // carries is kept, though — the ending does not repeat it.
                    if status.state == "accepted" {
                        if let Some(operation) = self.wifi_operation.as_mut() {
                            operation.ssid = status.ssid.clone();
                        }
                    } else {
                        self.network.wifi = Some(status);
                        // A keyboard standing on a scan result is moved off
                        // it: with a network joined there is nothing left to
                        // name.
                        self.network.settle_focus();
                    }
                }
                // Phases that arrived in the same breath as the `OK` were
                // folded into this reply rather than reaching the
                // notification path; they are this operation's ending too.
                self.apply_wifi_events(&text);
                self.note_wifi_connected();
            }
            // A scan goes to its own section of the view, filled as the
            // networks are heard — and it can fail *after* being accepted,
            // with `@scan error`, which is the failure the acceptance's `OK`
            // would otherwise hide from the status rule above.
            Query::WifiScan => {
                let refused = reply
                    .lines
                    .iter()
                    .any(|line| accessory::is_scan_error(line));
                if refused {
                    let text = self.strings().net_scan_failed.to_string();
                    self.network.error = Some(text.clone());
                    self.push_notice(Notice {
                        text,
                        level: NoticeLevel::Error,
                    });
                } else {
                    self.network.scan_results = scan_results(&reply.lines);
                    self.network.settle_focus();
                }
            }
            // `@d?` is a status: where the bridge uploads its logs, or off.
            // A board built without WebDAV answers with an error instead, and
            // the refusal path above puts that error on the same row.
            Query::Webdav => {
                if let Some(status) = accessory::parse_webdav_status(&text) {
                    self.network.webdav = Some(status);
                }
            }
            // A write confirms its name without a provenance suffix, making
            // it ambiguous when the name itself ends in `custom=yes` or
            // `custom=no`. Read it back before updating any saved labels.
            Query::BleName => {
                if std::mem::take(&mut self.ble_name_write_pending) {
                    if let Err(why) = self.ask_device(Query::BleName) {
                        self.network.error = Some(why.clone());
                        self.push_notice(Notice {
                            text: why,
                            level: NoticeLevel::Error,
                        });
                    }
                } else if let Some(status) = accessory::parse_ble_name(&text) {
                    self.remember_the_board_name(&status.name);
                    self.network.ble_name = Some(status);
                }
            }
            // `@s?` is the only place the bridge reports its LAN access
            // token, and a client that does not ask has no way to learn one.
            // Capturing it here — during the BLE session that is already open
            // — is what leaves the LAN dial filled in without anybody typing a
            // token. What the frame shows is *that* it has one, never what it
            // is.
            Query::Lan => {
                if let Some(status) = accessory::parse_lan_status(&text) {
                    // The row the user would type into is filled the way the
                    // web fills its field, unless it holds a token somebody
                    // typed: what was remembered for this address may be
                    // replaced by the bridge's answer, a hand-typed token may
                    // not. `token=none` is an answer too — the door has no key
                    // right now, so the remembered copy of the old one goes
                    // with it rather than being handed to the next dial as a
                    // wrong token.
                    let replaceable = self.lan_token_is_the_remembered_copy();
                    self.lan_status.ws = status.ws;
                    self.lan_status.token = status.token.clone();
                    if status.token.is_empty() {
                        self.lan_captured = LanCapture::None;
                        if replaceable {
                            self.lan_token.clear();
                        }
                        self.forget_lan_token();
                    } else {
                        self.lan_captured = LanCapture::Captured;
                        if replaceable {
                            self.lan_token = status.token.clone();
                        }
                        // The session has it now; the store keeps it for the
                        // sessions that have no BLE link to ask over.
                        self.remember_lan_token(&status.token);
                    }
                }
            }
        }
    }

    /// Ask the board the two things a link owes it, one after the other.
    ///
    /// The name comes first: it is what every label in the interface is built
    /// from, and the name in the air is a snapshot the owner can change from
    /// another client. The LAN token follows, because only one question can
    /// be in flight at a time and a question replaces whatever was
    /// outstanding.
    ///
    /// Nothing here displaces a question the user asked: the automatic reads
    /// wait for a free slot, and a link that never has one simply does not
    /// read the name until the next link.
    fn ask_pending_reads(&mut self) {
        if !self.ble_connected() || self.waiting_on_device() {
            return;
        }
        if self.ble_name_read_pending {
            self.ble_name_read_pending = false;
            let _ = self.ask_device(Query::BleName);
            return;
        }
        if self.lan_token_read_pending {
            self.lan_token_read_pending = false;
            let _ = self.ensure_lan_token();
        }
    }

    /// A network just came up: the LAN door is open.
    ///
    /// The token is asked for while the BLE session is still the bearer — the
    /// way the web asks on connect — and a token captured before an address
    /// was known is kept under the address that just arrived. Both calls know
    /// when they have nothing to do.
    fn note_wifi_connected(&mut self) {
        if !self.network.wifi_connected() {
            return;
        }
        let _ = self.ensure_lan_token();
        self.remember_captured_token();
    }

    /// Fold every `@event wifi` phase in `text` into the view.
    ///
    /// Phases reach here from the notification path when nothing claimed
    /// them, and from a reply's own lines when they arrived before its `OK`
    /// was read.
    fn apply_wifi_events(&mut self, text: &str) {
        for event in text.lines().filter_map(crate::protocol::parse_wifi_event) {
            self.apply_wifi_event(&event);
        }
    }

    /// Apply one `@event wifi` phase.
    ///
    /// Only the action this view asked for drives it — or, with nothing in
    /// flight, the bridge's own background lifecycle (`operation=0`):
    /// somebody else's operation must not claim the join a user is waiting
    /// on.
    fn apply_wifi_event(&mut self, event: &crate::protocol::WifiEvent) {
        // An ending is the bridge finishing with the radio, and an ending of
        // *anybody's* operation frees the gate a busy refusal was waiting on —
        // so a write owed another attempt goes out now rather than sitting out
        // the rest of its pause, and a scan owed one goes with it. The pauses
        // remain as the path for a host that never sees the ending.
        if event.is_final {
            self.ask_busy_write_again();
            self.ask_busy_scan_again();
        }
        let ours = match &self.wifi_operation {
            Some(operation) => event.operation == operation.id,
            None => event.operation == 0,
        };
        if !ours {
            return;
        }
        match event.phase.as_str() {
            // The radio still working: the row says loading rather than
            // wearing a state the bridge has not reached yet.
            "queued" | "connecting" | "dhcp" => {
                if self.wifi_operation.is_some() {
                    self.network.loading = true;
                }
            }
            "ready" => {
                let named = self.finish_wifi_operation();
                if crate::protocol::wifi_provisioning_complete(event) {
                    // A background ending does not repeat the name, so the
                    // one already on the row survives it.
                    let ssid = if named.is_empty() {
                        self.network
                            .wifi
                            .as_ref()
                            .map(|wifi| wifi.ssid.clone())
                            .unwrap_or_default()
                    } else {
                        named
                    };
                    self.network.wifi = Some(accessory::WifiStatus {
                        state: "connected".to_string(),
                        ssid,
                        ip: event.ip.clone(),
                    });
                    self.network.settle_focus();
                    self.note_wifi_connected();
                } else {
                    // Ready without an address yet: the truth about the row
                    // is in the status, so read it back rather than guess.
                    let _ = self.ask_device(Query::Wifi);
                }
            }
            // A failed operation leaves no network behind, and the code the
            // firmware gave is the one useful thing to say about it — as
            // words, because the number on its own is not one.
            "failed" => {
                self.finish_wifi_operation();
                self.network.wifi = Some(accessory::WifiStatus {
                    state: "off".to_string(),
                    ssid: String::new(),
                    ip: String::new(),
                });
                self.network.error = Some(self.lang.wifi_failure(event.result));
            }
            "off" => {
                self.finish_wifi_operation();
                self.network.wifi = Some(accessory::WifiStatus {
                    state: "off".to_string(),
                    ssid: String::new(),
                    ip: String::new(),
                });
            }
            _ => {}
        }
    }

    /// The operation is over: stop listening for its phases and stop showing
    /// the view as in flight. Returns the network it named, which the ending
    /// itself does not repeat.
    fn finish_wifi_operation(&mut self) -> String {
        self.network.loading = false;
        self.wifi_operation
            .take()
            .map(|operation| operation.ssid)
            .unwrap_or_default()
    }

    /// The last answer was a busy refusal: put the write back in the queue for
    /// its next attempt, and say what the wait is for. Returns whether an
    /// attempt was owed at all.
    ///
    /// The row is put back into "loading" on purpose: from the user's side a
    /// join that is being retried is still a join in progress, and a row that
    /// said "nothing is happening" for those seconds would be lying about it.
    fn retry_wifi_write(&mut self) -> bool {
        let Some(write) = self.wifi_write.take() else {
            return false;
        };
        if write.left == 0 {
            return false;
        }
        let pause = wifi_busy_pause(WIFI_BUSY_RETRIES - write.left);
        let text = self.lang.wifi_busy_wait(pause.as_secs());
        let next = Instant::now() + pause;
        self.wifi_write = Some(WifiWrite {
            left: write.left - 1,
            next: Some(next),
            ..write
        });
        self.network.loading = true;
        self.network.error = None;
        self.push_notice(Notice {
            text,
            level: NoticeLevel::Info,
        });
        true
    }

    /// Pull a waiting retry forward: the bridge has just finished with the
    /// radio, so the one-operation gate is free again.
    ///
    /// Only ever brings a moment closer — a write that is mid-question, or one
    /// with every attempt spent, is left exactly as it is.
    fn ask_busy_write_again(&mut self) {
        if let Some(write) = self.wifi_write.as_mut() {
            if write.next.is_some() {
                write.next = Some(Instant::now());
            }
        }
    }

    /// The same for a scan owed another attempt: the ending that frees the
    /// gate frees its pause too.
    fn ask_busy_scan_again(&mut self) {
        if let Some(retry) = self.scan_retry.as_mut() {
            if retry.due.is_some() {
                retry.due = Some(Instant::now());
            }
        }
    }

    /// The last attempt went unanswered: put the scan back in the queue for
    /// its next one, and say what the wait is for. Returns whether an attempt
    /// was owed at all.
    ///
    /// The row is put back into "loading" on purpose, exactly as a retried
    /// write's is: from the user's side a scan that is being asked again is
    /// still a scan in progress, and a row that said "nothing is happening"
    /// for those seconds would be lying about it.
    fn retry_scan(&mut self, now: Instant) -> bool {
        let Some(retry) = self.scan_retry.as_mut() else {
            return false;
        };
        if retry.left == 0 {
            return false;
        }
        let pause = wifi_busy_pause(WIFI_BUSY_RETRIES - retry.left);
        retry.left -= 1;
        retry.due = Some(now + pause);
        self.network.loading = true;
        self.network.error = None;
        let text = self.lang.wifi_busy_wait(pause.as_secs());
        self.push_notice(Notice {
            text,
            level: NoticeLevel::Info,
        });
        true
    }

    /// Send the `@w=` write that is owed another attempt, when `now` is the
    /// moment for it.
    ///
    /// The send builds a fresh record with every attempt counted, so the ones
    /// already spent are carried back onto it by hand — the alternative is a
    /// second sending path whose command never passed through the first one's
    /// checks.
    fn send_due_wifi_write(&mut self, now: Instant) {
        let Some(write) = &self.wifi_write else {
            return;
        };
        if !matches!(write.next, Some(at) if now >= at) {
            return;
        }
        let mut write = self.wifi_write.take().expect("just looked");
        let left = write.left;
        write.next = None;
        match self.send_accessory(&write.command, Query::Wifi) {
            Ok(()) => {
                if let Some(fresh) = self.wifi_write.as_mut() {
                    fresh.left = left;
                }
            }
            // The link went away under the retry. The record goes with it,
            // rather than waiting for a board that is no longer there.
            Err(why) => self.push_notice(Notice {
                text: why,
                level: NoticeLevel::Error,
            }),
        }
    }

    /// Send the scan that is owed another attempt, when `now` is the moment
    /// for it.
    ///
    /// `ask_device` is what clears `due` — one attempt is on the wire again —
    /// and what keeps the attempts that are left: it is the same record,
    /// because the count is what bounds the waiting. See [`App::ask_device`].
    fn send_due_scan_retry(&mut self, now: Instant) {
        let Some(retry) = &self.scan_retry else {
            return;
        };
        if !matches!(retry.due, Some(at) if now >= at) {
            return;
        }
        if let Err(why) = self.ask_device(Query::WifiScan) {
            // The link went away under the retry. The record goes with it
            // rather than waiting for a board that is no longer there, and the
            // reason is left where the scan's own failure would have gone —
            // the one-shot scan reports the row's words.
            self.scan_retry = None;
            self.network.error = Some(why.clone());
            self.push_notice(Notice {
                text: why,
                level: NoticeLevel::Error,
            });
        }
    }

    /// Give up on an `@event wifi` ending that never came, at `now`.
    ///
    /// Uncertain bridges are read, not waited out: when the window passes,
    /// the action stops claiming events and the status is read back, so a
    /// firmware that sends no phases still fills the row. The read is a
    /// question like any other, so it waits for the channel rather than
    /// replacing whatever is outstanding.
    fn expire_wifi_operation(&mut self, now: Instant) {
        let Some(operation) = &self.wifi_operation else {
            return;
        };
        if now < operation.until || self.talk.waiting().is_some() {
            return;
        }
        self.finish_wifi_operation();
        if self.ask_device(Query::Wifi).is_err() {
            // Nothing went out to clear the spinner against; stop it here.
            self.network.loading = false;
        }
    }

    /// Say that a question went unanswered, and stop the view waiting on it.
    fn report_unanswered(&mut self, query: Query, now: Instant) {
        self.stop_waiting(query);
        if query == Query::BleName {
            self.ble_name_write_pending = false;
        }
        // A scan is the one question a busy board refuses with nothing at all:
        // the request reaches a management task that is in the middle of
        // another WiFi operation, and no reply, no `ERR` and no partial list
        // comes back. Silence is therefore worth asking again about — the gate
        // is the board finishing what it was doing, and it clears on its own.
        if query == Query::WifiScan && self.retry_scan(now) {
            return;
        }
        let s = self.strings();
        // Every attempt was spent and the board stayed silent for all of them:
        // the plain sentence would tell the caller to try again, which is the
        // one thing that has just been done. (The `take` is what ends the
        // record — nothing is owed any more by the time this is said.)
        let retried = query == Query::WifiScan && self.scan_retry.take().is_some();
        let text = if retried {
            self.lang.mgmt_no_answer_after_retries(WIFI_BUSY_RETRIES)
        } else {
            s.mgmt_no_answer.to_string()
        };
        match query {
            Query::Diagnostics => self.diagnostics.error = Some(text.clone()),
            // A `@s?` nobody answered is not a failure the user did anything
            // about: the capture is best effort — the row still takes a token
            // by hand and the store may already have one — and firmware that
            // does not know the question should not get a toast per link.
            Query::Lan => return,
            _ => self.network.error = Some(text.clone()),
        }
        self.push_notice(Notice {
            text,
            level: NoticeLevel::Warn,
        });
    }

    /// Clear the in-flight flag this question set, whichever view it set it on.
    fn stop_waiting(&mut self, query: Query) {
        match query {
            Query::Diagnostics => self.diagnostics.loading = false,
            Query::Uart | Query::Wifi | Query::WifiScan | Query::Webdav | Query::BleName => {
                self.network.loading = false
            }
            Query::Lan => self.lan_status.loading = false,
        }
    }

    /// Paste a block of text, as one thing.
    ///
    /// A paste is a typing gesture that arrives whole, so it takes the same
    /// door a keystroke takes — `type_bytes` — and gets the same treatment:
    /// line mode holds it until Enter, and the echo, the trace and the `tx`
    /// counter all see it. It is not looped over as lines with an Enter
    /// guessed after each, because a paste of a shell script would then run
    /// each line as it was typed, which is the one thing a paste must never do
    /// to a device.
    ///
    /// Returns false when there is nothing to send, which is the same silence
    /// `send_bytes` gives a keystroke: a paste into a disconnected session is
    /// not worth a toast either.
    pub fn paste(&mut self, text: &str) -> bool {
        if text.is_empty() {
            return true;
        }
        // Newlines and tabs are what a paste carries and what a terminal sends:
        // \r\n, \n or \r all arrive as the newline a paste means, and a \r
        // inside the block is the shape every terminal actually emits.
        let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
        // The block's own newlines then take the Enter mode's spelling, so a
        // paste and the key that ends it agree about what a line ending is.
        // Whether the block *ended* a line is read off the normalised text: it
        // is the shape the user pasted, not the shape the wire wants.
        let spelled = self.enter.spell(&normalised);
        self.type_bytes(normalised.ends_with('\n'), &spelled)
    }

    /// Put the emulator's contents on the terminal's clipboard, and say so.
    ///
    /// Returns the notice rather than pushing it, so the wording stays in one
    /// place with every other notice this key produces — `toggle_sidebar()` and
    /// `keep_theme()` do the same, and a caller that formats its own is a
    /// caller whose wording can drift from the language table.
    pub fn copy_screen(&mut self) -> Notice {
        let text = self.terminal.visible_text();
        self.copy_text(&text)
    }

    /// Put `text` on the clipboards and return the notice counting what went.
    ///
    /// Both doors at once: OSC 52 through the terminal the interface is drawn
    /// in, and the desktop's own tool when the machine has one. The system
    /// write is best-effort and silent — the escape sequence is the door that
    /// works over SSH and in tmux, and a complaint about a missing `xclip` on
    /// the way to a copy that *did* happen is noise, not information.
    pub fn copy_text(&mut self, text: &str) -> Notice {
        // The cap keeps the *end*, and the arithmetic lives with the cap so
        // the test can read it: taking the beginning would throw away the
        // answer the user just watched arrive.
        let kept = crate::clipboard::copy_tail(text);
        let copied = kept.chars().count();
        if copied > 0 {
            osc52_copy(&kept);
            if self.desktop_clipboard {
                let _ = crate::clipboard::write_system_clipboard(&kept);
            }
        }
        let s = self.strings();
        Notice {
            text: format!("{} {} {}", s.copy_done_prefix, copied, s.copy_done_suffix),
            level: NoticeLevel::Info,
        }
    }

    /// Send raw bytes. Silent when there is no link, because this is the path a
    /// *keystroke* takes and a toast per character would bury the screen.
    pub fn send_bytes(&mut self, bytes: &[u8]) -> bool {
        if !self.connected() {
            return false;
        }
        if !self.session.send(bytes) {
            return false;
        }
        self.trace.tx(bytes);
        // The counter is part of the *frame*, so it moves here rather than at
        // the next pump: a keystroke's byte should show in the top bar on the
        // same repaint as the character it produced.
        self.tx = self.session.tx();
        if self.terminal.echo {
            self.terminal.push(bytes);
        }
        true
    }

    /// Type one keystroke, holding it until the line ends when line mode is on.
    ///
    /// Line mode is `--line-mode`, and it exists because a key at a time is not
    /// what every target wants: a shell with a line discipline reads a whole
    /// line, and a half-finished command sent a character at a time cannot be
    /// taken back by the time you notice the typo in it.
    ///
    /// Only the *stream* is held. Named keys — arrows, function keys, Tab —
    /// still go straight out, because holding an arrow key until Enter would
    /// make a target's own line editor unusable.
    pub fn type_bytes(&mut self, ends_line: bool, bytes: &str) -> bool {
        // Typing is a return to the command line. A terminal pulls the view
        // back to the tail on the first key (xterm's `scrollKey`, xterm.js's
        // `scrollOnUserInput`), and the echo of what was typed would otherwise
        // be written off-screen for the user to miss.
        self.scroll_terminal_to_bottom();
        if !self.line_mode {
            return self.send_bytes(bytes.as_bytes());
        }
        if !ends_line && !bytes.is_empty() {
            self.pending_line.push_str(bytes);
            // Echoed as it is held, so the line can be read back before it is
            // sent: local echo is the point of line mode, and a held line that
            // only appears once it is gone would be worse than neither.
            if self.terminal.echo {
                self.terminal.push(bytes.as_bytes());
            }
            return true;
        }
        let mut line = std::mem::take(&mut self.pending_line);
        line.push_str(bytes);
        self.send_bytes(line.as_bytes())
    }

    /// Send a whole command, and say so when there is nothing to send it over.
    ///
    /// One-shot commands go through this door: `send_bytes` refusing in
    /// silence is right for a keystroke and wrong for a preset, where the user
    /// pressed a button and is owed an answer. The line's own newlines and its
    /// ending are spelled the way the Enter mode asks, because a command sent
    /// from a button is as much a line on the wire as one typed into the pane.
    pub fn send_command(&mut self, text: &str) -> bool {
        if !self.connected() {
            let message = self.strings().not_connected.to_string();
            self.push_notice(Notice {
                text: message,
                level: NoticeLevel::Warn,
            });
            return false;
        }
        let mut payload = self.enter.spell(text).into_bytes();
        if !payload.ends_with(b"\n") && !payload.ends_with(b"\r") {
            payload.extend_from_slice(self.enter.bytes().unwrap_or("\r").as_bytes());
        }
        self.send_bytes(&payload)
    }

    /// Throw the pane's history away. The device is not told.
    pub fn clear_terminal(&mut self) {
        self.terminal.clear();
        // The screen the bar was describing is gone, so the next undecodable
        // byte gets to say so again.
        self.decode_loss_noticed = false;
    }

    /// Say the first time the pane could not read the device's bytes as text.
    ///
    /// The pane paints a replacement character for a byte that is not UTF-8 —
    /// that much a console can do — but a screenful of `�` with no
    /// explanation reads as the view's fault, and the fix is on the wire: the
    /// device is speaking something that is not UTF-8, or the serial link is
    /// not carrying what the device sent (a baud rate or a frame that does not
    /// match). Both are the user's to check, and neither can be found from the
    /// pane unless the sentence names them.
    ///
    /// Once per screen: see [`App::decode_loss_noticed`]. The count stays in
    /// the bottom bar, which is the part of the frame that keeps saying it
    /// after the toast has expired.
    fn note_decode_loss(&mut self) {
        if self.decode_loss_noticed {
            return;
        }
        let lost = self.terminal.decode_lost();
        if lost == 0 {
            return;
        }
        self.decode_loss_noticed = true;
        let text = crate::text::fill(self.strings().decode_loss_notice, &[lost.to_string()]);
        self.push_notice(Notice {
            text,
            level: NoticeLevel::Warn,
        });
    }

    /// Keep the pane pinned to the newest row again.
    pub fn scroll_terminal_to_bottom(&mut self) {
        self.terminal.autoscroll = true;
        self.terminal.scroll = 0;
    }

    /// Walk the pane back through its history. Leaving the bottom turns
    /// autoscroll off, which is what a terminal does: the user asked to stop
    /// following.
    pub fn scroll_terminal(&mut self, lines_up: usize) {
        if lines_up == 0 {
            return;
        }
        self.terminal.autoscroll = false;
        self.terminal.scroll = self.terminal.scroll.saturating_add(lines_up);
    }

    /// Walk the pane back down towards the tail. Landing on the tail resumes
    /// following, which is what a user who walked all the way down asked for.
    pub fn scroll_terminal_down(&mut self, lines_down: usize) {
        if lines_down == 0 {
            return;
        }
        let back = self.terminal.scroll.saturating_sub(lines_down);
        self.terminal.scroll = back;
        if back == 0 {
            self.scroll_terminal_to_bottom();
        }
    }

    /// Ask the bridge what it is, for the diagnostics view's own key. Why not
    /// is said out loud: a keystroke that does nothing is indistinguishable
    /// from one that was not heard.
    pub fn refresh_diagnostics(&mut self) {
        if let Err(why) = self.ask_device(Query::Diagnostics) {
            self.push_notice(Notice {
                text: why,
                level: NoticeLevel::Error,
            });
        }
    }

    /// Walk the diagnostics document towards its top.
    pub fn scroll_diagnostics_up(&mut self, lines_up: usize) {
        self.diagnostics.scroll = self.diagnostics.scroll.saturating_sub(lines_up);
    }

    /// Walk it towards its end. The painter pins a scroll past the last
    /// screenful to that last screenful, so the document never scrolls onto
    /// blank paper.
    pub fn scroll_diagnostics_down(&mut self, lines_down: usize) {
        self.diagnostics.scroll = self.diagnostics.scroll.saturating_add(lines_down);
    }
}

/// The networks out of a `@w scan` reply.
///
/// The status line is dropped rather than shown: `OK scan` is an answer to a
/// question nobody asked out loud, and listing it among the networks would put
/// a word where a network name belongs. Everything else is taken as it came,
/// which is the honest thing to do with a list whose shape is the firmware's
/// to choose.
/// The networks in a scan answer, as the list shows them.
///
/// Each network arrives enveloped — `@scan result <ssid> <security> ch=<n>
/// <rssi>dBm` — and the envelope is the wire's, not the user's: the list wants
/// what the radio found. The acceptance, the scan's own ending, and any
/// stray `OK`/`ERR` line that rode the same stream are not networks.
fn scan_results(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let body = line.strip_prefix("@scan result ").unwrap_or(line).trim();
            if body.is_empty() || accessory::is_scan_terminator(body) {
                return None;
            }
            let lower = body.to_ascii_lowercase();
            if accessory::starts_with_word(&lower, "ok")
                || accessory::starts_with_word(&lower, "err")
            {
                return None;
            }
            Some(body.to_string())
        })
        .collect()
}

/// Milliseconds since the epoch, which is the clock the watch measures a
/// reboot loop in.
///
/// Wall time rather than the process's own: a board that rebooted three times
/// before this program started is still rebooting, and restarting the window
/// at every launch would hide exactly the failure the watch exists to report.
fn wall_clock_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod multi_reply {
    use super::*;

    fn task(id: &str, goal: &str) -> crate::agent::tasks::TaskRecord {
        crate::agent::tasks::TaskRecord {
            id: id.to_string(),
            device_key: "board".to_string(),
            updated_at: 0,
            goal: goal.to_string(),
            summary: String::new(),
            status: "asking".to_string(),
        }
    }

    /// Two prompts in flight, both answered, each filed against its own task.
    ///
    /// The single-slot version of `agent_replies` dropped the first channel when
    /// the second prompt was submitted, so the reply the user was waiting for
    /// was lost silently and the task stayed "asking" for ever.
    #[test]
    fn two_in_flight_prompts_are_both_answered() {
        let mut app = App::default();
        app.assistant.tasks = vec![task("t1", "first"), task("t2", "second")];

        let (tx1, rx1) = std::sync::mpsc::channel();
        let (tx2, rx2) = std::sync::mpsc::channel();
        // Out of order, which is the case a slot cannot handle at all: t2
        // answers first and t1's channel has already been replaced.
        // The answer arrives as a delta and then a done, which is the shape a
        // stream really has: the text is written as it comes, and the `Done`
        // step is what says the model finished.
        tx2.send((
            "t2".to_string(),
            crate::agent::runtime::Progress::Delta("second answer".to_string()),
        ))
        .expect("send");
        tx2.send((
            "t2".to_string(),
            crate::agent::runtime::Progress::Done(crate::agent::usage::Usage::default()),
        ))
        .expect("send");
        tx1.send((
            "t1".to_string(),
            crate::agent::runtime::Progress::Delta("first answer".to_string()),
        ))
        .expect("send");
        tx1.send((
            "t1".to_string(),
            crate::agent::runtime::Progress::Done(crate::agent::usage::Usage::default()),
        ))
        .expect("send");
        app.agent_replies = vec![
            crate::agent::runtime::PendingReply::new("t1", rx1),
            crate::agent::runtime::PendingReply::new("t2", rx2),
        ];

        app.drain_agent_replies();

        let summaries: Vec<(&str, &str)> = app
            .assistant
            .tasks
            .iter()
            .map(|t| (t.id.as_str(), t.summary.as_str()))
            .collect();
        assert_eq!(summaries[0], ("t1", "first answer"));
        assert_eq!(summaries[1], ("t2", "second answer"));
        // And both channels are gone, so nothing is waited on for ever.
        assert!(
            app.agent_replies.is_empty(),
            "a channel nobody answers was left waiting"
        );
    }

    /// A channel still waiting keeps its place rather than being dropped.
    #[test]
    fn a_channel_still_waiting_is_kept() {
        let mut app = App::default();
        app.assistant.tasks = vec![task("t1", "first")];
        let (tx, rx) = std::sync::mpsc::channel();
        app.agent_replies = vec![crate::agent::runtime::PendingReply::new("t1", rx)];
        app.drain_agent_replies();
        assert_eq!(app.agent_replies.len(), 1, "the channel was dropped");
        assert_eq!(app.assistant.tasks[0].status, "asking");
        // It answers on a later beat and is filed then.
        tx.send((
            "t1".to_string(),
            crate::agent::runtime::Progress::Delta("late ".to_string()),
        ))
        .expect("send");
        app.drain_agent_replies();
        // The delta alone does not close the task: a partial reply is not a
        // reply, and this is what stops "typing" from reading as "answered".
        assert_eq!(app.assistant.tasks[0].summary, "late ");
        assert_eq!(app.assistant.tasks[0].status, "typing");
        tx.send((
            "t1".to_string(),
            crate::agent::runtime::Progress::Delta("answer".to_string()),
        ))
        .expect("send");
        tx.send((
            "t1".to_string(),
            crate::agent::runtime::Progress::Done(crate::agent::usage::Usage::default()),
        ))
        .expect("send");
        app.drain_agent_replies();
        assert_eq!(app.assistant.tasks[0].summary, "late answer");
        assert_eq!(app.assistant.tasks[0].status, "answered");
        assert!(app.agent_replies.is_empty());
    }

    /// A reply for a task that is not waiting is dropped rather than filed
    /// against whichever task is on screen.
    #[test]
    fn a_stale_reply_is_dropped_not_filed() {
        let mut app = App::default();
        app.assistant.tasks = vec![task("t9", "the one on screen")];
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send((
            "ghost".to_string(),
            crate::agent::runtime::Progress::Delta("an answer to something else".to_string()),
        ))
        .expect("send");
        app.agent_replies = vec![crate::agent::runtime::PendingReply::new("ghost", rx)];
        app.drain_agent_replies();
        assert!(
            app.assistant.tasks[0].summary.is_empty(),
            "a stale reply was filed against the wrong task"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::testing::{answer, asked_id, asked_includes, partial};
    use std::thread;
    use std::time::Duration;

    /// The defaults are the frame the screenshots show: the serial terminal
    /// selected, autoscroll on, the five quick sends with only `reboot` guarded.
    #[test]
    fn defaults_match_the_designed_first_frame() {
        let app = App::default();
        assert_eq!(app.view, View::Terminal);
        assert_eq!(app.focus, Focus::Terminal);
        assert_eq!(app.transport, Transport::Ble);
        assert!(!app.transport_locked);
        assert!(!app.transport_pinned);
        assert!(app.autoscroll);
        assert_eq!(app.baud, None);
        assert_eq!(app.signal_dbm, None);
        assert_eq!(app.rx, 0);
        assert_eq!(app.tx, 0);
        assert!(app.notices.is_empty());
        assert!(app.watch.is_empty());
        let commands: Vec<&str> = app.quick_send.iter().map(|q| q.command.as_str()).collect();
        assert_eq!(
            commands,
            vec!["help", "version", "uname -a", "df -h", "reboot"]
        );
        let guarded: Vec<&str> = app
            .quick_send
            .iter()
            .filter(|q| q.dangerous)
            .map(|q| q.command.as_str())
            .collect();
        assert_eq!(guarded, vec!["reboot"]);
    }

    /// The transport row shows the `◂▸` that says Enter flips it, and the lock
    /// suffix only when a flag or a dial took the choice away.
    #[test]
    fn the_transport_row_carries_its_lock() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        assert_eq!(app.transport_text(), "BLE ◂▸");
        app.transport_locked = true;
        assert_eq!(app.transport_text(), "BLE (locked)");
        app.transport = Transport::Lan;
        assert_eq!(app.transport_text(), "LAN (locked)");
    }

    /// The baud slot is the placeholder until a speed is known, then the speed.
    #[test]
    fn the_baud_slot_fills_in_once_known() {
        let mut app = App::default();
        assert_eq!(app.baud_text(), app.unknown());
        assert_eq!(app.baud_text(), "─");
        app.baud = Some(115_200);
        assert_eq!(app.baud_text(), "115200");
    }

    /// Keeping a theme sets it and returns the notice for it, in the current
    /// language — the one place the wording is written.
    #[test]
    fn keeping_a_theme_announces_it_by_name() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        let notice = app.keep_theme(ThemeChoice::Light);
        assert_eq!(app.theme, ThemeChoice::Light);
        assert_eq!(notice.text, "主题: 浅色");
        assert_eq!(notice.level, NoticeLevel::Info);
        assert_eq!(app.theme_name(ThemeChoice::Nord), "Nord");

        // The classics announce themselves by name, which is the same word in
        // either language.
        app.lang = Lang::En;
        let notice = app.keep_theme(ThemeChoice::Gruvbox);
        assert_eq!(notice.text, "Theme: Gruvbox");
        assert_eq!(app.theme_name(ThemeChoice::Solarized), "Solarized");
    }

    /// Closing the rail moves the focus with it. Otherwise the arrows would
    /// drive a rail the user cannot see, and the row they were on would still
    /// be highlighted somewhere off-screen.
    #[test]
    fn closing_the_rail_moves_the_focus_to_the_terminal() {
        let mut app = App::default();
        assert!(app.sidebar_visible, "the rail starts open");
        app.focus = Focus::Sidebar;
        app.sidebar_cursor = 2;

        let notice = app.toggle_sidebar();
        assert!(!app.sidebar_visible);
        assert_eq!(app.focus, Focus::Terminal);
        assert_eq!(notice.text, app.strings().sidebar_hidden);
        assert_eq!(notice.level, NoticeLevel::Info);
        // The cursor survives: reopening the rail should land back where it was.
        assert_eq!(app.sidebar_cursor, 2);

        // Opening it again leaves the focus wherever the user put it.
        app.focus = Focus::Sidebar;
        let notice = app.toggle_sidebar();
        assert!(app.sidebar_visible);
        assert_eq!(app.focus, Focus::Sidebar);
        assert_eq!(notice.text, app.strings().sidebar_shown);
    }

    /// A paste is a typing gesture, so line mode holds it until Enter exactly
    /// as it would have held the same characters typed one at a time. What a
    /// paste must never be is chopped at its newlines into per-line sends —
    /// pasting a shell script would then run each line as it was typed.
    #[test]
    fn a_paste_is_held_whole_in_line_mode() {
        let mut app = App {
            line_mode: true,
            ..App::default()
        };

        // No trailing newline: nothing is sent, the whole block is held.
        assert!(app.paste("echo one\necho two"));
        assert_eq!(app.pending_line, "echo one\necho two");
    }

    /// The three newline shapes every terminal actually emits all arrive as the
    /// one newline a paste means: \r\n, \n, and a lone \r. A \r left in place
    /// would be a carriage return the target reads as "start of line again".
    #[test]
    fn every_newline_shape_a_paste_can_carry_is_normalised() {
        for raw in ["a\r\nb", "a\nb", "a\rb"] {
            let mut app = App {
                line_mode: true,
                ..App::default()
            };
            assert!(app.paste(raw), "{raw:?} was refused");
            assert_eq!(
                app.pending_line, "a\nb",
                "{raw:?} did not arrive as one newline"
            );
        }
    }

    /// An empty paste is a no-op, not a send. Terminals emit it for an empty
    /// selection, and a keystroke-sized toast for it would be noise.
    #[test]
    fn an_empty_paste_is_a_no_op() {
        let mut app = App {
            line_mode: true,
            ..App::default()
        };
        assert!(app.paste(""), "an empty paste should be accepted");
        assert!(app.pending_line.is_empty(), "an empty paste held something");
    }

    /// The copy cap keeps the END of the screen, not the beginning.
    ///
    /// OSC 52 that is too long is discarded whole by the emulator rather than
    /// truncated, so a copy that cannot fit has to decide which end to keep.
    /// The end is where the thing the user just read lives; the beginning is
    /// hours-old boot noise they have long scrolled past.
    #[test]
    fn the_copy_keeps_the_end_of_the_screen() {
        let mut pane = TerminalPane::new();
        pane.set_size(40, 8);
        // More than the cap, so the trimming actually has to choose.
        let mut text = String::new();
        for _ in 0..(crate::clipboard::MAX_OSC52_CHARS + 64) {
            text.push('x');
        }
        text.push_str("TAIL");
        pane.push_text(&text);

        let app = &mut App {
            terminal: pane,
            ..App::default()
        };
        let notice = app.copy_screen();
        let copied = notice
            .text
            .split_whitespace()
            .nth(1)
            .and_then(|n| n.parse::<usize>().ok())
            .expect("the notice names the count");
        assert_eq!(
            copied,
            crate::clipboard::MAX_OSC52_CHARS,
            "the cap is what was copied"
        );
    }

    /// Copying a screen that has said nothing still reports — and reports the
    /// truth about what was on it, which for a fresh pane is its blank screen
    /// and not a lie about zero.
    #[test]
    fn copying_a_blank_screen_reports_what_was_there() {
        let mut app = App::default();
        let notice = app.copy_screen();
        let copied = notice
            .text
            .split_whitespace()
            .nth(1)
            .and_then(|n| n.parse::<usize>().ok())
            .expect("the notice names the count");
        // A fresh emulator dumps its blank screen, which is not zero, and
        // claiming otherwise would make the number meaningless.
        assert!(copied > 0, "a blank screen reported {copied}");
        assert_eq!(copied, app.terminal.visible_text().chars().count());
    }

    /// With no link the paste is refused in the same silence `send_bytes` gives
    /// a keystroke: the path is shared, so the behaviour cannot diverge.
    #[test]
    fn a_paste_with_no_link_is_refused_silently() {
        let mut app = App::default();
        assert!(!app.paste("anything"), "a paste went out with no link");
        assert!(app.notices.is_empty(), "a silent path announced itself");
    }

    /// Toasts are bounded: the stack never grows past the cap, and the oldest
    /// is the one dropped.
    #[test]
    fn notices_are_bounded_and_drop_the_oldest() {
        let mut app = App::default();
        for i in 0..MAX_NOTICES + 2 {
            app.push_notice(Notice {
                text: format!("n{i}"),
                level: NoticeLevel::Info,
            });
        }
        assert_eq!(app.notices.len(), MAX_NOTICES);
        let texts: Vec<&str> = app.notices.iter().map(|n| n.text.as_str()).collect();
        assert_eq!(texts, vec!["n2", "n3", "n4"]);
    }

    /// A toast lives its own 2.2 seconds and then takes itself off the stack,
    /// one at a time — the box goes with the last one, and the log keeps every
    /// word of all of them.
    #[test]
    fn toasts_expire_one_by_one() {
        let mut app = App::default();
        let now = Instant::now();
        app.push_notice(Notice {
            text: "first".into(),
            level: NoticeLevel::Info,
        });
        app.push_notice(Notice {
            text: "second".into(),
            level: NoticeLevel::Info,
        });
        assert_eq!(app.toast_until.len(), app.notices.len(), "a deadline each");
        assert!(
            app.toast_until.iter().all(|until| *until > now),
            "both are still standing"
        );

        // Time passes for the first toast and not for the second.
        app.toast_until[0] = now;
        app.toast_until[1] = now + TOAST_LIFETIME;
        app.expire_notices(now);
        let texts: Vec<&str> = app.notices.iter().map(|n| n.text.as_str()).collect();
        assert_eq!(texts, vec!["second"], "the oldest went, and only it");

        // Later still, the second one's time is up too.
        app.expire_notices(now + TOAST_LIFETIME + std::time::Duration::from_millis(1));
        assert!(
            app.notices.is_empty(),
            "and the box has nothing left to hold"
        );
        assert_eq!(app.log.len(), 2, "the log keeps them all");
    }

    /// The splash stands until its moment passes or input takes it down early;
    /// a default app never paints one, which is what keeps the tests and every
    /// printed frame splash-free.
    #[test]
    fn the_splash_ends_on_input_or_on_time() {
        let mut app = App::default();
        assert!(!app.splash_active(), "a default app never paints one");
        app.splash_until = Some(Instant::now() + SPLASH);
        assert!(app.splash_active(), "a deadline in the future stands");
        app.skip_splash();
        assert!(!app.splash_active(), "a key takes it down");
        app.splash_until = Some(Instant::now() - std::time::Duration::from_millis(1));
        assert!(
            !app.splash_active(),
            "a deadline that passed ends it with nobody asking"
        );
    }

    /// Full Auto is a window, not a mode: when its time is up the mode falls
    /// back to Auto and the log says why. The pump's tick, not a keypress, is
    /// what closes it.
    #[test]
    fn full_auto_reverts_when_its_window_elapses() {
        use crate::exec::executor::Mode;
        let mut app = App::default();
        crate::views::assistant::cycle_mode(&mut app); // Auto -> FullAuto
        assert_eq!(app.assistant.mode, Some(Mode::FullAuto));
        let until = app.assistant.full_auto_until.expect("the window is armed");

        // Before the deadline nothing moves.
        app.expire_full_auto(until - std::time::Duration::from_millis(1));
        assert_eq!(app.assistant.mode, Some(Mode::FullAuto));
        assert_eq!(app.assistant.full_auto_until, Some(until));

        app.expire_full_auto(until);
        assert_eq!(app.assistant.mode, Some(Mode::Auto), "the fallback");
        assert_eq!(app.assistant.full_auto_until, None, "and the window shut");
        let said = app.strings().asst_full_auto_expired;
        assert!(
            app.log.iter().any(|notice| notice.text == said),
            "it said why: {:?}",
            app.log
        );

        // And the pump is the clock that does it in the running app.
        crate::views::assistant::cycle_mode(&mut app); // Auto -> FullAuto
        assert_eq!(app.assistant.mode, Some(Mode::FullAuto));
        app.assistant.full_auto_until = Some(Instant::now() - std::time::Duration::from_millis(1));
        app.pump();
        assert_eq!(app.assistant.mode, Some(Mode::Auto));
        assert_eq!(app.assistant.full_auto_until, None);
    }

    /// The view rota walks all five and wraps in both directions: no view is
    /// unreachable and none is skipped.
    #[test]
    fn the_view_rota_wraps_both_ways() {
        let mut app = App::default();
        let mut seen = vec![app.view];
        for _ in 0..View::ALL.len() - 1 {
            app.next_view();
            seen.push(app.view);
        }
        assert_eq!(seen, View::ALL.to_vec());
        app.next_view();
        assert_eq!(app.view, View::ALL[0], "next wraps to the first view");
        app.prev_view();
        assert_eq!(
            app.view,
            View::ALL[View::ALL.len() - 1],
            "prev wraps to the last"
        );
    }

    /// The cursor stops at the last row and never walks past it — a cursor
    /// pointing at nothing would leave the sidebar with no highlighted row and
    /// the keyboard with nowhere to go.
    #[test]
    fn the_cursor_stops_at_both_ends() {
        let mut app = App::default();
        let last = app.sidebar_rows() - 1;
        for _ in 0..last + 10 {
            app.cursor_down();
        }
        assert_eq!(app.sidebar_cursor, last);
        for _ in 0..last + 10 {
            app.cursor_up();
        }
        assert_eq!(app.sidebar_cursor, 0);
    }

    /// The count the cursor clamps to is the count the sidebar actually
    /// offers: the two are computed apart, so a test holds them together.
    #[test]
    fn the_cursor_range_matches_the_sidebar() {
        let mut app = App::default();
        assert_eq!(app.sidebar_rows(), crate::ui::sidebar::targets(&app).len());
        app.quick_send.clear();
        assert_eq!(app.sidebar_rows(), crate::ui::sidebar::targets(&app).len());
        app.quick_send.push(QuickSend::new("ls"));
        assert_eq!(app.sidebar_rows(), crate::ui::sidebar::targets(&app).len());
    }

    /// A first frame has nothing from the device: the diagnostics grid starts
    /// empty, not with a stale read.
    #[test]
    fn the_diagnostics_grid_starts_empty() {
        let app = App::default();
        assert!(!app.diagnostics.has_data());
        assert!(!app.diagnostics.done);
        assert!(!app.diagnostics.loading);
        assert_eq!(app.diagnostics.updated, None);
    }

    /// Management commands are BLE-only: a LAN session is connected and still
    /// unable to reach them, which is what the diagnostics view reports.
    #[test]
    fn management_commands_need_the_ble_link() {
        let mut app = App {
            state: ConnectionState::Connected,
            ..App::default()
        };
        assert!(app.ble_connected(), "a connected BLE session can manage");
        app.transport = Transport::Lan;
        assert!(!app.ble_connected(), "a LAN session cannot");
        app.state = ConnectionState::Connecting;
        app.transport = Transport::Ble;
        assert!(!app.ble_connected(), "dialling is not connected");
        app.state = ConnectionState::Failed;
        assert!(!app.ble_connected());
        app.state = ConnectionState::Disconnected;
        assert!(!app.ble_connected());
    }

    /// The Device row names the board that is up — the name the air carried,
    /// and the address that tells two boards flashed from one configuration
    /// apart — so a bench with two boards shows two different rows.
    #[test]
    fn the_device_row_names_the_board_that_is_up() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        // Nothing dialled and nothing remembered: the row says so rather than
        // naming a board that is not there.
        assert_eq!(app.device_text(), app.unknown().to_string());

        // A remembered board names where the next dial is aimed.
        app.last_dial = Some(Dial::Ble(
            crate::transport::ble::Selection::Address("ee:c7:42:34:48:cf".into()),
            None,
        ));
        assert_eq!(app.device_text(), "EE:C7:42:34:48:CF");

        // The link comes up with the name the scan heard: the row carries the
        // name and the tail of the address, which is the pair that says *which*
        // board this is.
        app.advertised_name = Some("Linkr BLE UART-3".to_string());
        let wire = crate::transport::testing::MemoryLink::ble_addressed("EE:C7:42:34:48:CF");
        app.adopt(crate::transport::OpenedLink::open(wire.link()).expect("opens"));
        assert_eq!(app.device_name, "Linkr BLE UART-3 48:CF");
        assert_eq!(app.device_text(), app.device_name);

        // A second board that never named itself is named by its address, and
        // the two rows are not the same row.
        let first = app.device_text();
        app.advertised_name = None;
        let second = crate::transport::testing::MemoryLink::ble_addressed("FB:F6:91:14:33:3A");
        app.adopt(crate::transport::OpenedLink::open(second.link()).expect("opens"));
        assert_eq!(app.device_name, "FB:F6:91:14:33:3A");
        assert_ne!(app.device_text(), first);

        // A bridge names itself by what it runs, not by an address it has not
        // got.
        app.dial(&Dial::Stdio("-".to_string()))
            .expect("the loopback opens");
        assert_eq!(app.device_name, "loopback");
    }

    /// The tail of an address is its last two groups, and only an address has
    /// one: a name a dial searched for is not mistaken for a device.
    #[test]
    fn an_address_tail_is_the_last_two_groups() {
        assert_eq!(App::address_tail_of("EE:C7:42:34:48:CF"), Some("48:CF"));
        assert_eq!(App::address_tail_of("FB:F6:91:14:33:3A"), Some("33:3A"));
        assert_eq!(App::address_tail_of("48:CF"), Some("48:CF"));
        assert_eq!(App::address_tail_of("memory"), None);
        assert_eq!(App::address_tail_of(""), None);
        assert_eq!(App::address_tail_of("find the nearest device"), None);
        assert_eq!(
            App::address_tail_of("9C7B4E3A-2D1F-4E6B-8A3C-5F0E1D2C3B4A"),
            None,
            "a CoreBluetooth identifier is not an address"
        );
    }

    /// Theme and language shortcuts read the state, so a view never has to know
    /// which of the two enums is in force.
    #[test]
    fn shortcuts_read_the_current_selection() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        assert_eq!(app.view_name(), "Serial Terminal");
        assert_eq!(app.state_name(), "disconnected");
        app.lang = Lang::Zh;
        app.view = View::Network;
        app.state = ConnectionState::Connecting;
        assert_eq!(app.view_name(), "网络");
        assert_eq!(app.state_name(), "连接中…");
        assert_eq!(app.theme(), Theme::DARK);
        app.theme = ThemeChoice::Light;
        assert_eq!(app.theme(), Theme::LIGHT);
    }

    /// Pump until `predicate` holds, up to two seconds. The pump is what moves
    /// the session along, so a test has to keep calling it.
    fn pump_until(app: &mut App, mut predicate: impl FnMut(&App) -> bool) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            app.pump();
            if predicate(app) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        app.pump();
        predicate(app)
    }

    /// The whole non-terminal path, end to end: dial a bridge, watch the link
    /// come up, type a command, and read the answer out of the pane.
    ///
    /// This is the test that says the transport is *wired in* rather than
    /// merely written: every piece here — the dial, the reader thread, the
    /// session's counters, the pane's decoder and the notices — is the code the
    /// TUI runs, with only the terminal itself replaced by assertions.
    #[test]
    fn a_dialled_bridge_reaches_the_pane_and_the_counters() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.dial(&Dial::Stdio("-".to_string()))
            .expect("the loopback opens");

        assert_eq!(
            app.transport,
            Transport::Stdio,
            "the sidebar follows the link"
        );
        assert!(app.transport_locked, "a dialled link cannot be switched");
        assert_eq!(app.state, ConnectionState::Connecting);

        assert!(pump_until(&mut app, |app| app.state == ConnectionState::Connected));
        assert!(pump_until(&mut app, |app| !app.terminal.is_empty()));
        assert!(
            app.terminal.visible_text().contains("loopback device"),
            "the banner never reached the pane: {:?}",
            app.terminal.visible_text()
        );
        assert!(app.rx > 0, "the receive counter moved with the bytes");
        assert!(
            app.notices
                .iter()
                .any(|notice| notice.text.contains("link open")),
            "the link coming up is announced: {:?}",
            app.notices
        );

        // A keystroke goes out and the device's answer comes back. The count is
        // taken as a delta: what it is here for is the carriage return.
        let before = app.tx;
        assert!(app.send_command("uname -a"));
        assert_eq!(
            app.tx - before,
            9,
            "the carriage return is part of what was sent"
        );
        assert!(pump_until(&mut app, |app| app
            .terminal
            .visible_text()
            .contains("aarch64")));
    }

    /// Hanging up releases the lock a dial took out: with the link down there
    /// is nothing left for it to protect, and switching the transport to dial
    /// again is what hanging up is for.
    #[test]
    fn hanging_up_unlocks_the_transport_a_dial_locked() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.dial(&Dial::Stdio("-".to_string()))
            .expect("the loopback opens");
        assert!(app.transport_locked, "a dialled link cannot be switched");
        assert!(pump_until(&mut app, |app| app.state == ConnectionState::Connected));

        app.disconnect();
        assert!(!app.transport_locked, "the lock went when the link did");
        let notice = app.toggle_transport();
        assert_eq!(notice.level, NoticeLevel::Info, "switching works again");
        assert_ne!(app.transport, Transport::Stdio);
    }

    /// A transport the command line named stays locked through a hang-up: that
    /// pin is the operator's, not a dial's.
    #[test]
    fn hanging_up_keeps_a_transport_the_command_line_pinned_locked() {
        let mut app = App {
            lang: Lang::En,
            transport_pinned: true,
            ..App::default()
        };
        app.dial(&Dial::Stdio("-".to_string()))
            .expect("the loopback opens");
        assert!(pump_until(&mut app, |app| app.state == ConnectionState::Connected));

        app.disconnect();
        assert!(app.transport_locked, "a pinned transport stays pinned");
        let notice = app.toggle_transport();
        assert_eq!(notice.level, NoticeLevel::Warn);
    }

    /// The signal reading belongs to the link: a dial carries the reading the
    /// scan took of that board, and the pump takes it back once there is no
    /// link left for the top bar to describe.
    #[test]
    fn the_signal_reading_belongs_to_the_link() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        // A dial that never lands: the reading goes with the dial — the scan
        // heard the board, and that is a fact worth showing while it is being
        // reached — and the failure takes it back.
        app.connect_to_board("nonsense", None, Some(-52), true);
        assert_eq!(app.signal_dbm, Some(-52), "the reading went with the dial");
        assert!(pump_until(&mut app, |app| app.dialing.is_none()));
        assert_eq!(app.signal_dbm, None, "a failed dial leaves nothing showing");

        // A live link keeps it; hanging up drops it.
        app.dial(&Dial::Stdio("-".to_string()))
            .expect("the loopback opens");
        assert!(pump_until(&mut app, |app| app.state == ConnectionState::Connected));
        app.signal_dbm = Some(-40);
        app.pump();
        assert_eq!(app.signal_dbm, Some(-40), "a live link keeps its reading");
        app.disconnect();
        app.pump();
        assert_eq!(app.signal_dbm, None, "hanging up takes the reading with it");
    }

    /// A device's *questions* are answered on the wire.
    ///
    /// This is the half of a terminal that is easy to forget, and what it hides
    /// is a hang rather than a wrong pixel: `ESC [ 6 n` is a *blocking* read for
    /// the program that sends it, so an emulator that paints the screen and never
    /// replies leaves that program waiting forever.
    ///
    /// The memory link is what makes this testable. It is a link the test can
    /// also read back from, so the bytes that went out are asserted rather than
    /// inferred from a screen.
    #[test]
    fn a_devices_questions_are_answered_on_the_wire() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.terminal.set_size(80, 24);
        let wire = crate::transport::testing::MemoryLink::new();
        app.connect(wire.link()).expect("the memory link opens");
        assert!(pump_until(&mut app, |app| app.connected()));
        assert!(wire.take_sent().is_empty(), "nothing has been asked yet");

        // "Where is the cursor?" and "how big is the text area?" — six bytes of
        // answer for the first, ten for the second. The wait is on the *wire*,
        // not on the counter: the writer is its own thread, so the counter moves
        // at the hand-off.
        wire.feed(b"\x1b[6n\x1b[18t");
        assert!(pump_until(&mut app, |_| wire.sent_len() >= 16));
        assert_eq!(
            wire.take_sent(),
            b"\x1b[1;1R\x1b[8;24;80t".to_vec(),
            "the cursor report and the size report go back out"
        );
        assert_eq!(app.tx, 16, "and the byte counter counted them");
        assert!(app.terminal.vt().is_blank(), "a question is not text");
    }

    /// The console is the user's: the interface never types a size command
    /// into it.
    ///
    /// A shell sitting at an idle prompt is the one moment a line would be
    /// safe — and the moment the user may be about to type their own. Hiding
    /// the panel or resizing the window must not put a line on the line they
    /// are on, so an idle prompt stays untouched.
    #[test]
    fn the_interface_never_types_a_size_command_into_the_console() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        let wire = crate::transport::testing::MemoryLink::new();
        app.connect(wire.link()).expect("the memory link opens");
        assert!(pump_until(&mut app, |app| app.connected()));

        // A command running, then the shell back at its prompt: neither is a
        // place the interface writes down.
        wire.feed(b"apt update\r\nReading package lists...\r\n");
        app.pump();
        assert!(wire.take_sent().is_empty(), "the line is busy");
        wire.feed(b"root@linkr:~# ");
        app.pump();
        app.pump();
        assert!(
            wire.take_sent().is_empty(),
            "an idle prompt is not a place to type"
        );
    }

    /// The interface leaving takes the link with it — whichever exit it was —
    /// and the goodbye is waited for, because the board being free for the
    /// next client is the whole point of hanging up.
    #[test]
    fn the_interface_hangs_the_link_up_when_it_leaves() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        let wire = crate::transport::testing::MemoryLink::new();
        app.connect(wire.link()).expect("the memory link opens");
        assert!(pump_until(&mut app, |app| app.connected()));

        assert!(app.hang_up(Duration::from_millis(500)), "the end was heard");
        assert!(wire.hung_up(), "the link itself was ended");
        assert!(!app.connected());
        // Nothing is left to send on, and the try says so rather than counting
        // bytes into a link that is gone.
        assert!(!app.send_bytes(b"x"));
    }

    /// A command with no link is refused *out loud*: a preset that vanished
    /// into nothing reads as success, which for `reboot` is the worst lie the
    /// interface can tell.
    #[test]
    fn a_command_with_no_link_is_refused_out_loud() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        // Even a frame that *claims* connected cannot send: the link is what
        // decides, not the status dot.
        app.state = ConnectionState::Connected;

        assert!(!app.send_command("reboot"));
        assert_eq!(app.tx, 0, "nothing was counted");
        assert_eq!(
            app.notices.last().map(|notice| notice.text.as_str()),
            Some("Not connected — nothing was sent.")
        );
        // A keystroke, by contrast, is dropped without a word: a toast per
        // character would bury the screen.
        let before = app.notices.len();
        assert!(!app.send_bytes(b"x"));
        assert_eq!(app.notices.len(), before);
    }

    /// A dial that cannot be built changes nothing: the frame keeps its own
    /// state and no session appears behind it.
    #[test]
    fn a_failed_dial_leaves_the_frame_alone() {
        use crate::transport::ble::Selection;

        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.state = ConnectionState::Connecting;
        // An address made of nothing, so this fails without touching a radio:
        // the point of the test is what a refused dial does to the frame, not
        // whether BlueZ is reachable.
        assert!(app
            .dial(&Dial::Ble(Selection::Address("nonsense".to_string()), None))
            .is_err());
        assert!(!app.session.is_live());
        assert_eq!(app.state, ConnectionState::Connecting);
        assert_eq!(app.tx, 0);
    }

    /// The pane's scroll controls leave the bottom, which turns autoscroll off
    /// — a user who asked to read back did not ask to be dragged forward.
    #[test]
    fn scrolling_the_pane_leaves_the_bottom() {
        let mut app = App::default();
        app.terminal.push_text("one\ntwo\nthree\n");
        assert!(app.terminal.autoscroll);

        app.scroll_terminal(2);
        assert!(!app.terminal.autoscroll);
        assert_eq!(app.terminal.scroll, 2);
        app.scroll_terminal(3);
        assert_eq!(app.terminal.scroll, 5, "the scroll accumulates");

        app.scroll_terminal_to_bottom();
        assert!(app.terminal.autoscroll);
        assert_eq!(app.terminal.scroll, 0);
        // A zero scroll is not a scroll: it must not take the pane off the tail.
        app.scroll_terminal(0);
        assert!(app.terminal.autoscroll);
    }

    /// The diagnostics view's two keys do what its hint says: `r` asks the
    /// bridge, and PgUp/PgDn walk the document — which opens at its top again
    /// the moment a fresh read lands.
    #[test]
    fn the_diagnostics_view_refreshes_and_scrolls() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.refresh_diagnostics();
        assert_eq!(app.talk.waiting(), Some(Query::Diagnostics), "r asked");
        let id = asked_id(&wire);

        app.scroll_diagnostics_down(10);
        app.scroll_diagnostics_down(10);
        assert_eq!(app.diagnostics.scroll, 20);
        app.scroll_diagnostics_up(5);
        assert_eq!(app.diagnostics.scroll, 15);
        app.scroll_diagnostics_up(99);
        assert_eq!(app.diagnostics.scroll, 0, "the top is as high as it goes");

        app.scroll_diagnostics_down(10);
        wire.feed_management(answer(
            id,
            "@info fw version=0.1.2 zephyr=4.4.1\n@info done",
        ));
        assert!(pump_until(&mut app, |app| app.diagnostics.has_data()));
        assert_eq!(app.diagnostics.scroll, 0, "a new document opens at its top");
    }

    /// Walking back down is a step towards the tail, and reaching the tail
    /// resumes following — a user who scrolled all the way back asked for the
    /// bottom, which is the one place the console follows the device again.
    #[test]
    fn scrolling_back_down_resumes_following_at_the_tail() {
        let mut app = App::default();
        app.terminal.push_text("one\ntwo\nthree\n");
        app.scroll_terminal(5);
        assert!(!app.terminal.autoscroll);

        app.scroll_terminal_down(2);
        assert_eq!(app.terminal.scroll, 3, "a step comes off the offset");
        assert!(!app.terminal.autoscroll, "still off the tail");

        app.scroll_terminal_down(3);
        assert_eq!(app.terminal.scroll, 0);
        assert!(app.terminal.autoscroll, "the tail resumes following");

        // A zero step is not a step: it neither moves nor re-arms anything.
        app.scroll_terminal(4);
        app.scroll_terminal_down(0);
        assert_eq!(app.terminal.scroll, 4);
        assert!(!app.terminal.autoscroll);
    }

    /// Every announcement lands in the log as well as the toast stack, and the
    /// log is the deeper of the two — a dialog that showed only the three
    /// toasts already on screen would be a second view of the same three rows.
    #[test]
    fn an_announcement_lands_in_the_log_too() {
        let mut app = App::default();
        for i in 0..MAX_NOTICES + 5 {
            app.push_notice(Notice {
                text: format!("n{i}"),
                level: NoticeLevel::Info,
            });
        }
        assert_eq!(app.notices.len(), MAX_NOTICES);
        assert_eq!(app.log.len(), MAX_NOTICES + 5);
        assert_eq!(
            app.log.first().map(|n| n.text.as_str()),
            Some("n0"),
            "the log keeps the oldest"
        );
        // The log bounds itself as well, so a long session cannot grow forever.
        for i in 0..MAX_LOG + 10 {
            app.push_notice(Notice {
                text: format!("x{i}"),
                level: NoticeLevel::Info,
            });
        }
        assert_eq!(app.log.len(), MAX_LOG);
    }

    /// The transport flips between the two links a session can be carried
    /// over — `stdio` is a command line's way in, never a row's — and a pinned
    /// one refuses, and says so.
    #[test]
    fn the_transport_flips_between_the_two_links_a_session_has() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        assert_eq!(app.transport, Transport::Ble);
        let notice = app.toggle_transport();
        assert_eq!(notice.level, NoticeLevel::Info);
        assert_eq!(notice.text, "Transport: LAN");
        assert_eq!(app.transport, Transport::Lan);
        let notice = app.toggle_transport();
        assert_eq!(notice.text, "Transport: BLE");
        assert_eq!(app.transport, Transport::Ble, "and it flips back");

        // `stdio` never turns up in the cycle, however many presses it is
        // given: it takes a command line to name one, and a row that offered
        // it offered a link nobody had named. A `stdio` that was named and
        // then released lands on the ordinary way in.
        for _ in 0..4 {
            app.toggle_transport();
            assert_ne!(app.transport, Transport::Stdio);
        }
        app.transport = Transport::Stdio;
        app.toggle_transport();
        assert_eq!(app.transport, Transport::Ble);

        app.transport_locked = true;
        let before = app.transport;
        let notice = app.toggle_transport();
        assert_eq!(app.transport, before, "a pinned transport does not move");
        assert_eq!(notice.level, NoticeLevel::Warn);
        assert_eq!(
            notice.text,
            "The transport is pinned and cannot be switched."
        );
    }

    /// Switching the language flips it, says so in the *new* language, and the
    /// two names are each written in their own language — the way a language
    /// picker names a language.
    #[test]
    fn switching_the_language_says_so() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        let notice = app.toggle_language();
        assert_eq!(app.lang, Lang::En);
        assert_eq!(notice.text, "Interface language: English");
        let notice = app.toggle_language();
        assert_eq!(app.lang, Lang::Zh);
        assert_eq!(notice.text, "界面语言: 中文");
    }

    /// A save writes exactly what the pane shows, to the name it reports.
    #[test]
    fn a_save_writes_the_pane_to_disk() {
        let mut app = App::default();
        app.terminal.push_text("uname -a\r\nLinux bee\r\n");
        let path =
            std::env::temp_dir().join(format!("linkr-tui-save-test-{}.log", std::process::id()));
        let (bytes, name) = app.save_terminal_log_to(&path).expect("the save succeeds");
        let written = std::fs::read_to_string(&path).expect("the file exists");
        assert_eq!(bytes, written.len());
        assert_eq!(name, path.display().to_string());
        assert!(written.contains("Linux bee"), "{written}");
        let _ = std::fs::remove_file(&path);

        // The default name is a plain file in the working directory, stamped so
        // two saves cannot collide.
        let default = App::terminal_log_path();
        assert!(default.starts_with("linkr-terminal-"), "{default}");
        assert!(default.ends_with(".log"), "{default}");
        assert!(!default.contains('/'), "{default}");
    }

    /// `connect` with nothing to re-dial says so instead of doing nothing: a
    /// button that silently does nothing reads as broken.
    #[test]
    fn reconnect_without_a_dial_says_so() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.reconnect();
        assert_eq!(
            app.log.last().map(|notice| notice.text.as_str()),
            Some("No link configured — nothing to dial.")
        );
        assert!(app.last_dial.is_none());
    }

    /// A finished scan folds in the way that opened it: only devices with the
    /// Linkr Management Service count, a lone board at startup is dialled
    /// without a window, a pair leaves the list up to pick from, nothing heard
    /// says nothing, and a scan the user asked for is always a list.
    #[test]
    fn a_scan_lists_serial_boards_and_dials_a_lone_one() {
        use crate::cli::FoundDevice;

        fn board(name: &str, address: &str, board: bool) -> FoundDevice {
            FoundDevice {
                name: Some(name.to_string()),
                address: address.to_string(),
                board,
                // Signal is the picker's business; the scan's own tests are
                // about which boards get dialled, not how loudly they were
                // heard on the way.
                rssi: None,
            }
        }

        fn picker() -> crate::dialogs::Dialog {
            crate::dialogs::Dialog::DevicePick(crate::dialogs::DevicePick {
                devices: Vec::new(),
                cursor: 0,
                scanning: true,
                message: String::new(),
                scroll: 0,
            })
        }

        fn pick(app: &App) -> &crate::dialogs::DevicePick {
            match &app.dialog {
                Some(crate::dialogs::Dialog::DevicePick(pick)) => pick,
                other => panic!("the scan left a list: {other:?}"),
            }
        }

        // A keyboard on the bench is not a board this program can dial, and it
        // does not count as "one board": the lone serial board is the one that
        // gets the dial — and the startup scan dials it without ever putting a
        // window up. The id is not an address, so the attempt fails the instant
        // the dial thread makes it — a real board is the same code with a
        // different outcome — and the pump hands the sentence it leaves to the
        // log.
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.scan_connects_one = true;
        app.settle_scan(vec![
            board("Keyboard", "ad:1a:2b:3c:4d:5e", false),
            board("Linkr Bee", "nonsense", true),
        ]);
        assert!(app.dialog.is_none(), "the startup dial opens no window");
        assert!(
            pump_until(&mut app, |app| !app.log.is_empty()),
            "the dial answers"
        );
        let text = app.log.last().expect("a notice").text.clone();
        assert!(
            text.starts_with("connect failed: “nonsense” is not a Bluetooth address"),
            "the dial went out and failed, and said which address: {text}"
        );

        // Two boards: nothing in the scan can choose, so the list goes up with
        // both — the one case the startup scan has a question to ask — and no
        // link is dialled.
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.scan_connects_one = true;
        app.settle_scan(vec![
            board("First", "AA:BB:CC:DD:EE:01", true),
            board("Second", "AA:BB:CC:DD:EE:02", true),
        ]);
        assert_eq!(pick(&app).devices.len(), 2, "both boards are listed");
        assert!(app.log.is_empty(), "nothing was dialled: {:?}", app.log);

        // Nothing heard, and nobody asked aloud: no window, no notice. The row
        // that asks is `Switch device`.
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.scan_connects_one = true;
        app.settle_scan(vec![board("Keyboard", "ad:1a:2b:3c:4d:5e", false)]);
        assert!(app.dialog.is_none(), "an empty answer opens no window");
        assert!(app.log.is_empty(), "and says nothing");

        // A scan opened by hand is a question, not an errand: even one board is
        // left for the user to pick.
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.dialog = Some(picker());
        app.settle_scan(vec![board("Linkr Bee", "AA:BB:CC:DD:EE:FF", true)]);
        assert_eq!(pick(&app).devices.len(), 1, "the list is the answer here");
        assert!(app.log.is_empty(), "nothing was dialled: {:?}", app.log);
    }

    /// A dialled link is remembered, and `connect` opens it again rather than
    /// inventing one — the palette's `connect` and the command line name the
    /// same link.
    #[test]
    fn a_dialled_link_is_remembered_and_reopened() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.dial(&Dial::Stdio("-".into()))
            .expect("the loopback opens");
        assert_eq!(app.last_dial, Some(Dial::Stdio("-".into())));
        assert!(pump_until(&mut app, |app| app.state == ConnectionState::Connected));

        app.disconnect();
        assert!(!app.session.is_live());
        let before = app.log.len();
        app.reconnect();
        assert!(app.dialing.is_some(), "the dial is in the air");
        assert_eq!(app.log.len(), before, "the press itself is not a toast");
        assert!(
            pump_until(&mut app, |app| app.state == ConnectionState::Connected),
            "the link is open again"
        );
        assert!(app.session.is_live());
    }

    /// A dial runs on its own thread: the call returns at once with the dial
    /// still in the air, the pump collects the link a tick later, and the
    /// transport is held from the press so the choice cannot move under it.
    #[test]
    fn a_dial_lands_through_the_pump() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        assert!(app.dial_async(&Dial::Stdio("-".into()), false));
        assert!(app.dialing.is_some(), "the dial is in the air");
        assert!(app.transport_locked, "and the choice is held");
        assert_eq!(app.state, ConnectionState::Connecting);
        assert!(
            pump_until(&mut app, |app| app.state == ConnectionState::Connected),
            "the loopback comes up"
        );
        assert!(app.dialing.is_none(), "the dial is collected");
        assert_eq!(app.last_dial, Some(Dial::Stdio("-".into())));
        let text = app.log.last().expect("the link is announced").text.clone();
        assert!(text.starts_with("link open: "), "{text}");
    }

    /// The startup scan's own dial answers to nobody: the link comes up, and
    /// the log says nothing about it. The next link is its own news.
    #[test]
    fn a_quiet_dial_lands_without_a_word() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        assert!(app.dial_async(&Dial::Stdio("-".into()), true));
        assert!(pump_until(&mut app, |app| app.state == ConnectionState::Connected));
        assert!(
            app.notices.is_empty(),
            "nothing was said: {:?}",
            app.notices
        );

        app.disconnect();
        app.reconnect();
        assert!(pump_until(&mut app, |app| app.state == ConnectionState::Connected));
        assert!(
            app.notices
                .iter()
                .any(|n| n.text.starts_with("link open: ")),
            "the second link is announced"
        );
    }

    /// A dial that fails says why, gives the transport back, and does not
    /// remember itself: a failed dial is not something the next Connect should
    /// try again behind the user's back.
    #[test]
    fn a_failed_dial_reports_and_unlocks() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.dial_async(
            &Dial::Ble(
                crate::transport::ble::Selection::Address("nonsense".into()),
                None,
            ),
            false,
        );
        assert!(app.transport_locked, "the choice is held while it tries");
        assert!(
            pump_until(&mut app, |app| app.dialing.is_none()),
            "the dial comes back"
        );
        let text = app.log.last().expect("a notice").text.clone();
        assert!(
            text.starts_with("connect failed: “nonsense” is not a Bluetooth address"),
            "{text}"
        );
        assert!(!app.transport_locked, "the choice is given back");
        assert_eq!(app.state, ConnectionState::Failed);
        assert!(app.last_dial.is_none(), "nothing was remembered");
    }

    /// Connect pressed twice dials once: the second press is answered with a
    /// sentence, not a race for the same link.
    #[test]
    fn a_second_connect_while_dialling_says_so() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.dial_async(&Dial::Stdio("-".into()), false);
        let before = app.log.len();
        app.reconnect();
        assert_eq!(app.log.len(), before + 1, "the press was answered");
        assert_eq!(app.log.last().unwrap().text, "connecting…");
        assert!(app.dialing.is_some(), "and the first dial is untouched");
    }

    /// The sidebar's LAN rows describe the dial: what was typed wins, the
    /// board's own WiFi address is the fallback that saves retyping it, the
    /// token comes from the field or the capture, and the row shows that one
    /// exists and never which.
    #[test]
    fn the_lan_rows_describe_the_dial() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.transport = Transport::Lan;

        // Nothing typed and no board address heard: nothing to dial.
        assert!(app.lan_dial().is_err(), "an address is owed");
        assert_eq!(app.lan_host_text(), app.unknown());
        assert_eq!(app.lan_token_text(), app.unknown());

        // A token in hand is shown as stars, and the row never spells it.
        app.lan_status.token = "0123456789abcdef0123456789abcdef".into();
        assert_eq!(app.lan_token_text(), LAN_TOKEN_MASK);
        assert_eq!(
            LAN_TOKEN_MASK.chars().count(),
            32,
            "as long as a real token, so the run leaks no length"
        );
        assert!(!app.lan_token_text().contains("0123456789"));

        // The board's own address is the fallback.
        app.network.wifi = Some(crate::accessory::WifiStatus {
            state: "connected".into(),
            ssid: "Bench".into(),
            ip: "192.168.0.100".into(),
        });
        let Dial::Lan { host, token } = app.lan_dial().expect("the board's address is a dial")
        else {
            panic!("a LAN dial");
        };
        assert_eq!(host, "192.168.0.100");
        assert_eq!(token.as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(app.lan_host_text(), "192.168.0.100");

        // What was typed beats the fallback, trimmed.
        app.lan_host = " 192.168.1.50 ".into();
        let Dial::Lan { host, .. } = app.lan_dial().expect("a typed host is a dial") else {
            panic!("a LAN dial");
        };
        assert_eq!(host, "192.168.1.50");
        assert_eq!(app.lan_host_text(), "192.168.1.50");
    }

    /// A modal takes the keyboard, and closing it gives the keyboard back.
    #[test]
    fn an_overlay_takes_the_keyboard() {
        let mut app = App::default();
        assert!(!app.overlay_open());
        app.dialog = Some(crate::dialogs::Dialog::Help(0));
        assert!(app.overlay_open());
        app.dialog = None;
        palette::open(&mut app);
        assert!(app.overlay_open(), "the palette also takes the keyboard");
    }

    /// Quitting is a flag the event loop reads, so the palette's `quit` action
    /// and the chord end the session the same way.
    #[test]
    fn quitting_is_a_flag() {
        let mut app = App::default();
        assert!(!app.quit);
        app.request_quit();
        assert!(app.quit);
    }

    // --- the memory link -----------------------------------------------------

    /// A connected app on a memory link, which is what every test that puts
    /// bytes on the wire needs and none of them should re-derive.
    fn connected(lang: Lang) -> (App, crate::transport::testing::MemoryLink) {
        let mut app = App {
            lang,
            ..App::default()
        };
        let wire = crate::transport::testing::MemoryLink::new();
        app.connect(wire.link()).expect("the memory link opens");
        assert!(pump_until(&mut app, |app| app.connected()));
        (app, wire)
    }

    /// A session standing in for a Bluetooth one, because the management
    /// channel — and therefore diagnostics, UART and WiFi — exists on
    /// no other link.
    fn connected_over_ble(lang: Lang) -> (App, crate::transport::testing::MemoryLink) {
        let mut app = App {
            lang,
            ..App::default()
        };
        let wire = crate::transport::testing::MemoryLink::ble();
        app.connect(wire.link()).expect("the memory link opens");
        assert!(pump_until(&mut app, |app| app.connected()));
        assert_eq!(app.transport, Transport::Ble);
        // The board is asked its name as the link comes up, and the answer is
        // fed here so the tests that follow see the questions that come after
        // it. The answer is a *custom* name on purpose: a host that worked
        // only for the factory default would pass every other test and fail
        // on a board whose owner renamed it.
        if app.talk.waiting() == Some(Query::BleName) {
            let id = crate::transport::testing::asked_id(&wire);
            wire.feed_management(crate::transport::testing::answer(
                id,
                "OK name=Bench Bee custom=yes",
            ));
            assert!(pump_until(&mut app, |app| app.talk.waiting() == Some(Query::Lan)));
        }
        (app, wire)
    }

    /// Undecodable bytes are what a device speaking something that is not
    /// UTF-8 — or a serial frame that does not match what the device sends —
    /// looks like from inside the app: the pane paints `�` for each byte, and
    /// the fact is said once per screen, because saying it per burst would be
    /// saying it forever to a user whose device will not change.
    #[test]
    fn undecodable_bytes_are_announced_once_per_screen() {
        let (mut app, wire) = connected(Lang::En);

        wire.feed(b"ok\r\n");
        assert!(pump_until(&mut app, |app| app.rx > 0));
        assert_eq!(app.terminal.decode_lost(), 0);
        assert!(
            app.notices
                .iter()
                .all(|notice| !notice.text.contains("UTF-8")),
            "valid text is not announced: {:?}",
            app.notices
        );

        wire.feed(b"\xff\xfe");
        assert!(pump_until(&mut app, |app| app.terminal.decode_lost() == 2));
        let telling = |app: &App| {
            app.notices
                .iter()
                .filter(|notice| notice.text.contains("UTF-8"))
                .count()
        };
        assert_eq!(telling(&app), 1, "the loss is named: {:?}", app.notices);
        assert_eq!(
            app.notices.last().expect("the notice").level,
            NoticeLevel::Warn,
            "a device that cannot be read is a warning, not a progress report"
        );
        assert!(
            app.notices.last().expect("the notice").text.contains('2'),
            "and it carries the count: {:?}",
            app.notices.last()
        );

        // More of the same: the sentence has been said, and the bottom bar's
        // count keeps saying it.
        wire.feed(b"\xff\xff\xff\xff");
        assert!(pump_until(&mut app, |app| app.terminal.decode_lost() == 6));
        assert_eq!(telling(&app), 1, "once, not once per read");

        // Clearing the screen clears the count with it, so the next loss is a
        // new fact about the screen that is now in front of the user.
        app.clear_terminal();
        assert_eq!(app.terminal.decode_lost(), 0);
        wire.feed(b"\xfe");
        assert!(pump_until(&mut app, |app| app.terminal.decode_lost() == 1));
        assert_eq!(telling(&app), 2, "a fresh screen gets a fresh sentence");
    }

    /// Asking the bridge what it is must fill the grid it is drawn from.
    ///
    /// This is the whole point of the management channel, and it is worth an
    /// end-to-end test because every layer it touches — the ask, the frame, the
    /// reassembly, the parse, the grid — can be right alone and still leave the
    /// view empty.
    #[test]
    fn asking_the_bridge_about_itself_fills_the_diagnostics_grid() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.ask_device(Query::Diagnostics).expect("the link is up");
        assert!(app.diagnostics.loading, "the grid says it is waiting");

        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "@info fw version=0.1.2 zephyr=4.4.1\n@info sys uptime_ms=123456\n@info done",
        ));

        assert!(pump_until(&mut app, |app| app.diagnostics.has_data()));
        assert!(!app.diagnostics.loading);
        assert_eq!(
            app.diagnostics.groups["fw"]["version"], "0.1.2",
            "the firmware version came from the device, not from anywhere else"
        );
        assert_eq!(app.diagnostics.groups["sys"]["uptime_ms"], "123456");
        assert!(
            app.diagnostics.updated.is_some(),
            "and it is stamped with when it was read"
        );
        // And the answer is not also typed into the target's terminal.
        assert!(!app.terminal.visible_text().contains("@info"));
    }

    /// The UART read is where the top bar's own speed number comes from.
    #[test]
    fn reading_the_uart_fills_the_baud_the_chrome_shows() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.ask_device(Query::Uart).expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK uart=230400,8,N,1,none"));
        assert!(pump_until(&mut app, |app| app.baud == Some(230400)));
        // Not "the network view has stopped loading": opening a link asks the
        // on-connect reads, and the one after this is still in flight. What
        // this read itself left behind is the baud, and that is what landed.
        assert_eq!(app.baud, Some(230400));
    }

    /// A WiFi read lands in the network view rather than in a toast nobody
    /// asked for.
    #[test]
    fn reading_wifi_fills_the_network_view() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.ask_device(Query::Wifi).expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "OK wifi=connected,ssid=BenchNet,ip=192.168.1.44",
        ));
        assert!(pump_until(&mut app, |app| app.network.wifi_connected()));
        let wifi = app.network.wifi.clone().expect("reported");
        assert_eq!(wifi.ssid, "BenchNet");
        assert_eq!(wifi.ip, "192.168.1.44");
    }

    /// A joined network is a moment the LAN door opens: `@s?` is at the
    /// bridge on the BLE link that is already up — nobody has to know the
    /// token exists before they can learn it — and the answer leaves it in
    /// hand, and in the row a LAN dial is built from, for the dial that
    /// follows.
    #[test]
    fn a_joined_network_fetches_the_lan_token() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.ask_device(Query::Wifi).expect("asked");
        let id = asked_id(&wire);
        // No address in the answer: this is the session's capture, and
        // nothing is remembered for a bridge with no address to file it
        // under.
        wire.feed_management(answer(id, "OK wifi=connected,ssid=BenchNet"));
        assert!(pump_until(&mut app, |app| app.network.wifi_connected()));

        assert_eq!(
            app.talk.waiting(),
            Some(Query::Lan),
            "the token question is in the air"
        );
        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "OK ws=on token=0123456789abcdef0123456789abcdef",
        ));
        assert!(pump_until(&mut app, |app| app.lan_token_hand()));
        assert!(matches!(app.lan_captured, LanCapture::Captured));
        assert_eq!(app.lan_status.token, "0123456789abcdef0123456789abcdef");
        assert_eq!(
            app.lan_token, "0123456789abcdef0123456789abcdef",
            "the row a LAN dial is built from is filled too, the way the web \
             fills its field"
        );
        assert_eq!(
            app.lan_token_text(),
            LAN_TOKEN_MASK,
            "and the row still shows that one is in hand, never which"
        );
    }

    /// A join is answered twice: `OK wifi=accepted` only queues it, and the
    /// ending — whether the radio came up, and on which address — arrives as
    /// `@event wifi` phases. The row must follow the ending, not the ack.
    #[test]
    fn a_join_follows_its_events_past_the_ack() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.set_wifi("BenchNet", "hunter2").expect("sent");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK wifi=accepted,ssid=BenchNet"));
        assert!(pump_until(&mut app, |app| app.talk.waiting().is_none()));
        assert!(
            !app.network.wifi_connected(),
            "queued is not a state the row may wear"
        );
        assert_eq!(
            app.wifi_operation.as_ref().map(|operation| operation.id),
            Some(id),
            "the view is still waiting on that operation"
        );
        assert!(
            app.waiting_on_device(),
            "and a caller waiting on the join waits for the ending, not the ack"
        );

        // The radio working is the view saying loading, not the old state
        // getting a new name.
        wire.feed_management(partial(
            id,
            &format!("@event wifi operation={id} phase=connecting result=0"),
        ));
        assert!(pump_until(&mut app, |app| app.network.loading));
        assert!(!app.network.wifi_connected());

        wire.feed_management(answer(
            id,
            &format!(
                "@event wifi operation={id} phase=ready result=0 state=connected ip=192.168.4.20"
            ),
        ));
        assert!(pump_until(&mut app, |app| app.network.wifi_connected()));
        let wifi = app.network.wifi.clone().expect("the ending filled the row");
        assert_eq!(wifi.ssid, "BenchNet", "the name the command carried");
        assert_eq!(wifi.ip, "192.168.4.20");
        assert!(
            app.wifi_operation.is_none(),
            "the ending closes the operation"
        );
        assert!(!app.network.loading, "and stops the spinner");
        assert!(
            app.wifi_write.is_none(),
            "nothing about the join is outstanding any more"
        );
    }

    /// A failed join says which code the firmware gave and leaves no network
    /// behind — the row goes back to saying there is none.
    #[test]
    fn a_failed_join_says_which_code_the_bridge_gave() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.set_wifi("Nope", "hunter2").expect("sent");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK wifi=accepted,ssid=Nope"));
        assert!(pump_until(&mut app, |app| app.talk.waiting().is_none()));

        wire.feed_management(answer(
            id,
            &format!("@event wifi operation={id} phase=failed result=-5 error=no_ap"),
        ));
        assert!(pump_until(&mut app, |app| app.network.error.is_some()));
        let error = app.network.error.clone().expect("worded");
        assert!(error.contains("-5"), "{error} names the firmware's code");
        assert_eq!(
            app.network.wifi.as_ref().map(|wifi| wifi.state.as_str()),
            Some("off"),
            "a failed join leaves the row saying no network"
        );
        assert!(app.wifi_operation.is_none());
        assert!(!app.network.loading);
    }

    /// Another operation's phases — a different request id — do not drive a
    /// view that is waiting on its own join.
    #[test]
    fn another_operations_event_does_not_claim_the_join() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.set_wifi("BenchNet", "hunter2").expect("sent");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK wifi=accepted,ssid=BenchNet"));
        assert!(pump_until(&mut app, |app| app.talk.waiting().is_none()));

        wire.feed_management(answer(
            id + 1,
            &format!(
                "@event wifi operation={} phase=ready result=0 state=connected ip=10.9.9.9",
                id + 1
            ),
        ));
        // A beat for the event to be delivered and folded — into nothing.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
        while std::time::Instant::now() < deadline {
            app.pump();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(
            !app.network.wifi_connected(),
            "a stranger's ending is not this join's"
        );
        assert!(app.wifi_operation.is_some(), "and the join still waits");
    }

    /// With nothing of its own in flight the view still follows the bridge's
    /// background lifecycle (`operation=0`): a link coming up or dropping
    /// under it is the row's business either way.
    #[test]
    fn the_bridges_own_lifecycle_reaches_the_view() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        wire.feed_management(answer(
            0,
            "@event wifi operation=0 phase=ready result=0 state=connected ip=192.168.7.2",
        ));
        assert!(pump_until(&mut app, |app| app.network.wifi_connected()));
        assert_eq!(
            app.network.wifi.as_ref().map(|wifi| wifi.ip.as_str()),
            Some("192.168.7.2")
        );

        wire.feed_management(answer(0, "@event wifi operation=0 phase=off result=0"));
        assert!(pump_until(&mut app, |app| {
            app.network
                .wifi
                .as_ref()
                .is_some_and(|wifi| wifi.state == "off")
        }));
    }

    /// Phases that arrive before the ack was read are folded into its reply
    /// rather than dropped: the ending still lands.
    #[test]
    fn an_ending_folded_into_the_ack_still_lands() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.set_wifi("BenchNet", "hunter2").expect("sent");
        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            &format!(
                "OK wifi=accepted,ssid=BenchNet\n\
                 @event wifi operation={id} phase=ready result=0 state=connected ip=192.168.4.20"
            ),
        ));
        assert!(pump_until(&mut app, |app| app.network.wifi_connected()));
        let wifi = app.network.wifi.clone().expect("the ending filled the row");
        assert_eq!(wifi.ssid, "BenchNet");
        assert_eq!(wifi.ip, "192.168.4.20");
        assert!(app.wifi_operation.is_none());
    }

    /// A bridge that never sends the ending is read instead of waited out:
    /// when the window passes, the status is asked for and the row fills from
    /// that answer.
    #[test]
    fn a_join_without_an_ending_is_read_back_instead() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.set_wifi("BenchNet", "hunter2").expect("sent");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK wifi=accepted,ssid=BenchNet"));
        assert!(pump_until(&mut app, |app| app.talk.waiting().is_none()));

        // The window is a wall-clock one; this is the same pump with the
        // clock a second past it.
        app.expire_wifi_operation(
            std::time::Instant::now() + WIFI_EVENT_FALLBACK + std::time::Duration::from_secs(1),
        );
        assert!(app.wifi_operation.is_none(), "the action stopped waiting");
        assert_eq!(
            app.talk.waiting(),
            Some(Query::Wifi),
            "the status is read back instead"
        );
        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "OK wifi=connected,ssid=BenchNet,ip=192.168.4.20",
        ));
        assert!(pump_until(&mut app, |app| app.network.wifi_connected()));
        assert_eq!(
            app.network.wifi.as_ref().map(|wifi| wifi.ip.as_str()),
            Some("192.168.4.20")
        );
    }

    /// The store is keyed by the address a dial would go to, and a Bluetooth
    /// session starts without one: what the bridge reported is remembered the
    /// moment an address becomes known — here, the WiFi status naming it.
    #[test]
    fn a_captured_token_is_remembered_once_the_address_is_known() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.lan_store = Some(crate::lan_token_store::TokenStore::default());
        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "OK ws=on token=0123456789abcdef0123456789abcdef",
        ));
        assert!(pump_until(&mut app, |app| matches!(
            app.lan_captured,
            LanCapture::Captured
        )));
        assert!(
            app.lan_store.as_ref().is_some_and(|store| store.is_empty()),
            "no address yet, so nothing is filed under an empty one"
        );

        app.ask_device(Query::Wifi).expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "OK wifi=connected,ssid=BenchNet,ip=192.168.1.44",
        ));
        assert!(pump_until(&mut app, |app| {
            app.lan_store
                .as_ref()
                .is_some_and(|store| !store.is_empty())
        }));
        assert_eq!(
            app.lan_store
                .as_ref()
                .and_then(|store| store.token_for("192.168.1.44")),
            Some("0123456789abcdef0123456789abcdef"),
            "remembered under the address the dial would go to"
        );
    }

    /// The address the status reports is the firmware's word, and `ip=down` is
    /// its word for "none": a token filed under it — or a dial aimed at it —
    /// would be aimed at nothing at all. The user's store had exactly such a
    /// key (`down <token>`), which is why the shape is checked here.
    #[test]
    fn a_board_with_no_address_files_its_token_nowhere() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.lan_store = Some(crate::lan_token_store::TokenStore::default());
        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "OK ws=on token=0123456789abcdef0123456789abcdef",
        ));
        assert!(pump_until(&mut app, |app| matches!(
            app.lan_captured,
            LanCapture::Captured
        )));

        app.ask_device(Query::Wifi).expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK wifi=connecting,ssid=BenchNet,ip=down"));
        assert!(pump_until(&mut app, |app| {
            app.network
                .wifi
                .as_ref()
                .is_some_and(|wifi| wifi.state == "connecting")
        }));
        assert!(
            app.lan_store.as_ref().is_some_and(|store| store.is_empty()),
            "\"down\" is not an address to remember a token under"
        );
        assert!(app.lan_host_effective().is_empty(), "nor one to dial");
    }

    /// The management channel is recorded in both directions. A log holding
    /// the questions and not the answers is the half of the dialog nobody can
    /// reconstruct — and the answers are the half that carries a token, so
    /// they are scrubbed before they are written.
    #[test]
    fn the_management_dialog_reaches_the_log() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        let dir = std::env::temp_dir().join(format!("linkr-app-trace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let path = dir.join("session.log");
        let _ = std::fs::remove_file(&path);
        app.trace = crate::trace::ByteTrace::to_file(&path).expect("the log opens");

        app.ask_device(Query::Diagnostics).expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "OK fw=1.0.0 token=0123456789abcdef0123456789abcdef",
        ));
        assert!(pump_until(&mut app, |app| {
            app.diagnostics.error.is_none() && !app.diagnostics.loading
        }));

        let text = std::fs::read_to_string(&path).expect("the log reads back");
        assert!(text.contains("tx command: @i?"), "{text}");
        assert!(text.contains("rx reply: OK fw=1.0.0"), "{text}");
        assert!(
            !text.contains("0123456789abcdef0123456789abcdef"),
            "a token in a reply is redacted on its way into the log: {text}"
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The other moment the address becomes known: somebody types it into the
    /// row. The token the bridge reported goes in under it, so a later session
    /// with no Bluetooth has something to seed the row from.
    #[test]
    fn naming_the_address_remembers_a_captured_token() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.lan_store = Some(crate::lan_token_store::TokenStore::default());
        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "OK ws=on token=0123456789abcdef0123456789abcdef",
        ));
        assert!(pump_until(&mut app, |app| matches!(
            app.lan_captured,
            LanCapture::Captured
        )));

        app.set_lan_host("203.0.113.9".into());
        assert_eq!(
            app.lan_store
                .as_ref()
                .and_then(|store| store.token_for("203.0.113.9")),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert!(app.lan_token_hand(), "and the row is in hand for the dial");
    }

    /// The token is asked for the moment a Bluetooth link comes up, the way
    /// the web asks on connect: a user who switches to LAN later finds the row
    /// already filled rather than learning a fetch is needed. Once per link,
    /// not once per pump.
    #[test]
    fn a_bluetooth_link_asks_for_the_lan_token_as_it_comes_up() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        assert_eq!(
            app.talk.waiting(),
            Some(Query::Lan),
            "the link coming up is the moment the token is asked"
        );

        let id = asked_id(&wire);
        wire.feed_management(answer(
            id,
            "OK ws=on token=0123456789abcdef0123456789abcdef",
        ));
        assert!(pump_until(&mut app, |app| {
            matches!(app.lan_captured, LanCapture::Captured)
        }));
        assert_eq!(app.lan_token, "0123456789abcdef0123456789abcdef");
        assert!(
            wire.take_management().is_empty(),
            "asked once, not once per pump"
        );
    }

    /// `token=none` is the bridge saying its LAN door has no key: the session
    /// records that as an answer — not as "nothing heard yet" — and a LAN dial
    /// carries no token at all.
    #[test]
    fn a_bridge_without_a_lan_token_says_so() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK ws=off token=none"));
        assert!(pump_until(&mut app, |app| matches!(
            app.lan_captured,
            LanCapture::None
        )));
        assert!(app.lan_token.is_empty(), "there is no token to hold");
        assert!(!app.lan_token_hand());
        assert_eq!(
            app.lan_token_text(),
            app.strings().lan_token_off,
            "the row says the door is open, not that nobody asked"
        );

        app.lan_host = "203.0.113.7".into();
        let Dial::Lan { token, .. } = app.lan_dial().expect("an address is a dial") else {
            panic!("a LAN dial");
        };
        assert_eq!(token, None, "auth off means no token goes to the socket");
    }

    /// A link that cannot carry the question is not asked it: a stdio session
    /// has no management channel, and the capture stays quiet rather than
    /// filling a view with an error nobody can act on.
    #[test]
    fn a_link_without_a_management_channel_is_not_asked_for_a_token() {
        let (_app, wire) = connected(Lang::En);
        assert!(
            wire.take_management().is_empty(),
            "a plain link has nothing to ask over"
        );
    }

    /// A token somebody typed is theirs: setting a new address does not decide
    /// it was meant for the old bridge and drop it, while a row that was only
    /// showing the remembered copy follows the address.
    #[test]
    fn a_typed_token_survives_a_new_address() {
        let mut app = App {
            lan_token: "0123456789abcdef0123456789abcdef".into(),
            ..App::default()
        };
        app.set_lan_host("203.0.113.9".into());
        assert_eq!(
            app.lan_token, "0123456789abcdef0123456789abcdef",
            "an address change does not throw away what somebody typed"
        );
    }

    /// Setting the UART asks for the setting back, so the frame shows what the
    /// bridge is running rather than what was meant. A firmware that clamps
    /// 1000000 to something it can reach must therefore be believed.
    #[test]
    fn setting_the_uart_shows_the_rate_the_bridge_kept() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        let requested = accessory::UartSettings {
            baud: 1_000_000,
            data_bits: 8,
            parity: "n".to_string(),
            stop_bits: 1,
            flow: "none".to_string(),
        };
        app.set_uart(&requested).expect("sent");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK uart=921600,8,N,1,none"));
        assert!(pump_until(&mut app, |app| app.baud == Some(921_600)));
        assert_ne!(app.baud, Some(requested.baud), "the bridge wins");
    }

    /// An answer that never comes is reported as one, rather than leaving the
    /// view reading "loading…" until somebody notices.
    #[test]
    fn a_question_the_bridge_ignores_says_so() {
        let (mut app, _wire) = connected_over_ble(Lang::Zh);
        app.ask_device(Query::Diagnostics).expect("asked");
        assert!(app.diagnostics.loading);
        // Nothing answers. Wait past the conversation's own patience.
        thread::sleep(Query::Diagnostics.patience() + Duration::from_millis(50));
        app.pump();
        assert!(!app.diagnostics.loading, "it stopped waiting");
        assert!(app.diagnostics.error.is_some(), "and said why");
        assert!(app.notices.iter().any(|n| n.level == NoticeLevel::Warn));
    }

    /// A bridge that answers with an error keeps the last good grid: replacing
    /// a working reading with a failure puts numbers on screen that were never
    /// measured, which is worse than showing none.
    #[test]
    fn a_failed_read_leaves_the_last_good_reading_alone() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.ask_device(Query::Diagnostics).expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "@info fw version=0.1.2\n@info done"));
        assert!(pump_until(&mut app, |app| app.diagnostics.has_data()));

        app.ask_device(Query::Diagnostics).expect("asked again");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "ERR busy"));
        assert!(pump_until(&mut app, |app| app.diagnostics.error.is_some()));
        assert!(app.diagnostics.has_data(), "the earlier reading survives");
        assert_eq!(app.diagnostics.groups["fw"]["version"], "0.1.2");
    }

    /// Asking over a link with no management channel is refused here, with the
    /// reason, rather than sent nowhere: waiting three seconds to be told the
    /// bearer cannot do it is the wrong order.
    #[test]
    fn management_over_a_link_that_has_none_is_refused_by_name() {
        let (mut app, wire) = connected(Lang::Zh);
        let err = app
            .ask_device(Query::Diagnostics)
            .expect_err("stdio has none");
        assert!(
            err.contains("BLE"),
            "the refusal names the bearer it needs: {err}"
        );
        assert!(!app.diagnostics.loading, "so nothing is left waiting");
        assert!(wire.take_management().is_empty(), "and nothing went out");
    }

    /// A WiFi scan is the board's radio listening, not this host's — and the
    /// command is the third shape `@w` takes, which is why it has its own door
    /// rather than being `set_wifi` with an empty name.
    #[test]
    fn a_wifi_scan_is_asked_of_the_bridge_and_not_of_this_host() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.scan_wifi().expect("asked");
        // Among all the frames, not the last: the on-connect reads go out
        // first and this is asked after them.
        assert!(
            asked_includes(&wire, b"@w scan"),
            "the whole command, nothing guessed at"
        );
    }

    /// A scan's answer is a list, and it goes to the view's own list rather
    /// than into the status slot: squeezing nine networks into "the network you
    /// are on" would show one where the board saw nine.
    ///
    /// The wire shape is the firmware's: the request is accepted with `OK
    /// accepted`, a line per network follows with no final flag, and `@scan
    /// done` ends the stream. The list shows what is inside the wire's
    /// envelope, and nothing of the envelope itself.
    #[test]
    fn a_wifi_scan_answer_fills_the_results_list() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.scan_wifi().expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK accepted\r\n"));
        wire.feed_management(partial(id, "@scan result BenchNet wpa2 ch=6 -54dBm\r\n"));
        wire.feed_management(partial(id, "@scan result Guest open ch=11 -71dBm\r\n"));

        assert!(pump_until(&mut app, |app| !app
            .network
            .scan_results
            .is_empty()));
        assert!(
            app.waiting_on_device(),
            "an accepted scan is not a finished one"
        );
        wire.feed_management(answer(id, "@scan done\r\n"));
        assert!(pump_until(&mut app, |app| !app.waiting_on_device()));
        assert_eq!(
            app.network.scan_results,
            vec![
                "BenchNet wpa2 ch=6 -54dBm".to_string(),
                "Guest open ch=11 -71dBm".to_string(),
            ],
            "the envelope is the wire's and the networks are the list's"
        );
        assert!(!app.network.loading, "the scan said it is finished");
        assert!(app.network.error.is_none(), "and not with an error");
        assert!(app.network.wifi.is_none(), "a list is not a status");
    }

    /// A scan streams: the first network shows before the scan is over.
    ///
    /// The bridge answers one network at a time, so folding only at finalize
    /// would leave the view reading "scanning" for the whole scan and then fill
    /// at once — the same wait, with nothing to watch. This is the regression
    /// test for that: half an answer is fed, and the list already has a row.
    #[test]
    fn a_scan_fills_while_it_is_still_running() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.scan_wifi().expect("asked");
        let id = asked_id(&wire);

        // The real shape: an acceptance, then results with flags 0 — only
        // `@scan done` carries FINAL — so a body with an `OK` line in it would
        // be recognised as a finished answer by shape alone. The acceptance is
        // what says the rest is coming.
        wire.feed_management(answer(id, "OK accepted\r\n"));
        wire.feed_management(partial(id, "@scan result BenchNet wpa2 ch=6 -54dBm\r\n"));

        assert!(pump_until(&mut app, |app| !app
            .network
            .scan_results
            .is_empty()));
        assert_eq!(
            app.network.scan_results,
            vec!["BenchNet wpa2 ch=6 -54dBm".to_string()],
            "the first network is visible before the scan ends"
        );
        assert!(
            app.network.loading,
            "still waiting: the scan has not said it is finished"
        );
    }

    /// The acceptance carries FINAL because that *message* is whole, not
    /// because the answer is. Read as the answer's end — which it was — every
    /// network behind it fell to "an answer nobody asked for", and a bridge
    /// answering perfectly looked like a broken scan.
    #[test]
    fn a_scan_is_not_over_when_it_is_accepted() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.scan_wifi().expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK accepted\r\n"));
        wire.feed_management(partial(id, "@scan result BenchNet wpa2 ch=6 -54dBm\r\n"));
        wire.feed_management(answer(id, "@scan done\r\n"));

        assert!(pump_until(&mut app, |app| !app.network.loading));
        assert_eq!(
            app.network.scan_results,
            vec!["BenchNet wpa2 ch=6 -54dBm".to_string()],
            "the answer behind the acceptance is still this conversation's"
        );
        assert!(app.network.error.is_none());
        assert!(!app.waiting_on_device());
    }

    /// A scan can fail *after* it was accepted — the radio gives up and says
    /// `@scan error` — and what the user sees is a sentence, not the bridge's
    /// own line sitting in the list as if it were a network.
    #[test]
    fn a_scan_that_failed_says_so_instead_of_showing_the_line() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.scan_wifi().expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK accepted\r\n"));
        wire.feed_management(answer(id, "@scan error\r\n"));

        assert!(pump_until(&mut app, |app| !app.network.loading));
        assert_eq!(
            app.network.error,
            Some("the scan failed".to_string()),
            "the failure is a sentence, not `@scan error`"
        );
        assert!(
            app.network.scan_results.is_empty(),
            "no rows for a scan that found nothing"
        );
        assert!(
            app.notices
                .iter()
                .any(|notice| notice.text.contains("scan")),
            "the failure is announced wherever the user is: {:?}",
            app.notices
        );
    }

    /// A network's name is the radio's data, not ours: it can start with a
    /// multi-byte character, and reading it must not slice through one. This
    /// is the line that took the interface down live — a scan result whose
    /// SSID began with a three-byte character, read as a status.
    #[test]
    fn a_scan_result_with_a_multibyte_name_is_a_row() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.scan_wifi().expect("asked");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK accepted\r\n"));
        wire.feed_management(partial(id, "@scan result 非你莫属 wpa2 ch=6 -54dBm\r\n"));
        wire.feed_management(answer(id, "@scan done\r\n"));

        assert!(pump_until(&mut app, |app| !app.network.loading));
        assert_eq!(
            app.network.scan_results,
            vec!["非你莫属 wpa2 ch=6 -54dBm".to_string()],
            "the name is kept whole"
        );
        assert!(app.network.error.is_none());
    }

    /// An approved change is the command, and the read that confirms it follows
    /// from the command rather than from whoever asked for it.
    #[test]
    fn an_approved_change_sends_the_command_the_card_showed() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.run_accessory("@w=BenchNet,secret")
            .expect("the link is up");
        // Among all the frames, as above.
        assert!(
            asked_includes(&wire, b"@w=BenchNet,secret"),
            "the password goes to the wire"
        );
        assert!(
            app.waiting_on_device(),
            "and the read that confirms it is out"
        );
    }

    #[test]
    fn invalid_webdav_cli_requests_leave_existing_upload_configuration_alone() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        let current = accessory::WebdavStatus {
            state: "on".to_string(),
            url: "http://host/existing/".to_string(),
        };
        app.network.webdav = Some(current.clone());
        for (url, off) in [
            ("", false),
            (" \t ", false),
            ("https://host/new/", false),
            ("http://host/new/", true),
        ] {
            let requests = crate::cli::Requests {
                webdav: Some(url.to_string()),
                webdav_off: off,
                ..Default::default()
            };
            assert_eq!(
                crate::cli::run_requests(
                    &mut app,
                    &requests,
                    crate::cli::Format::Json,
                    Duration::from_millis(100),
                ),
                1
            );
            assert_eq!(app.network.webdav.as_ref(), Some(&current));
        }
        assert!(
            crate::transport::testing::asked_frames(&wire)
                .iter()
                .all(|frame| !frame[crate::protocol::MGMT_HEADER_SIZE..].starts_with(b"@d")),
            "an invalid enable request must never send a write or disable"
        );
        app.disable_webdav().expect("explicit disable");
        assert!(asked_includes(&wire, b"@d off"));
    }

    /// The command among the frames that went out, counted rather than merely
    /// found — a retry is the same bytes a second time.
    fn asked_times(wire: &crate::transport::testing::MemoryLink, command: &[u8]) -> usize {
        crate::transport::testing::asked_frames(wire)
            .iter()
            .filter(|frame| frame[crate::protocol::MGMT_HEADER_SIZE..] == *command)
            .count()
    }

    /// The id and body of the newest question to go out, read in one drain.
    ///
    /// `asked_id` and `asked_includes` each drain the wire, so a test that
    /// wants to know *which* command the id belongs to has to read both at
    /// once rather than ask twice and compare answers from different moments.
    fn newest_question(wire: &crate::transport::testing::MemoryLink) -> (u32, Vec<u8>) {
        let frames = crate::transport::testing::asked_frames(wire);
        let bytes = frames.last().expect("a question went out").clone();
        let id = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        (id, bytes[crate::protocol::MGMT_HEADER_SIZE..].to_vec())
    }

    /// A board that is busy is waited out. `-EBUSY` is the firmware's
    /// one-operation gate — often its own background retry mid-attempt — so the
    /// write is asked again rather than handed back to the user as `ERR
    /// wifi=-16`, and the wait is said without the password that is being held
    /// for it.
    #[test]
    fn a_busy_wifi_write_waits_its_turn_and_goes_again() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.run_accessory("@w=BenchNet,secret")
            .expect("the link is up");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "ERR wifi=-16\r\n"));

        assert!(pump_until(&mut app, |app| {
            app.wifi_write
                .as_ref()
                .is_some_and(|write| write.next.is_some())
        }));
        assert!(
            app.network.loading,
            "a write being retried is still a write in flight"
        );
        assert!(
            app.network.error.is_none(),
            "the gate's number is not an error to show"
        );
        assert!(app
            .wifi_write
            .as_ref()
            .is_some_and(|w| w.left < WIFI_BUSY_RETRIES));
        let notice = app.notices.last().expect("a notice about the wait");
        assert!(notice.text.contains("自动重试"), "{}", notice.text);
        assert!(
            app.notices
                .iter()
                .all(|notice| !notice.text.contains("secret")),
            "the wait is announced without the password"
        );
        // Nothing goes out before the pause is over: the gate is held by
        // somebody else, and asking again into it is the same refusal.
        assert!(
            wire.take_management().is_empty(),
            "the retry went out before its pause"
        );
        app.send_due_wifi_write(Instant::now() + Duration::from_secs(60));
        assert_eq!(
            asked_times(&wire, b"@w=BenchNet,secret"),
            1,
            "the write went out again, once"
        );
    }

    /// The pause is a fallback, not the clock a retry runs on: an ending the
    /// bridge publishes means it has finished with the radio, and the gate it
    /// held is free — so the write owed an attempt goes back out at once,
    /// inside the window before the bridge's own loop claims it again.
    #[test]
    fn the_boards_own_ending_lets_a_busy_write_go_early() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.run_accessory("@w=BenchNet,secret")
            .expect("the link is up");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "ERR wifi=-16\r\n"));
        assert!(pump_until(&mut app, |app| {
            app.wifi_write
                .as_ref()
                .is_some_and(|write| write.next.is_some())
        }));
        assert!(
            app.waiting_on_device(),
            "a write owed another attempt is a question still outstanding — \
             the script mode waits on this"
        );
        let owed = app
            .wifi_write
            .as_ref()
            .and_then(|write| write.next)
            .expect("a moment");
        assert!(
            owed > Instant::now() + Duration::from_secs(1),
            "the retry starts out waiting its pause"
        );

        wire.feed_management(answer(
            0,
            "@event wifi operation=0 phase=failed result=-116",
        ));
        assert!(pump_until(&mut app, |app| {
            app.wifi_write
                .as_ref()
                .is_some_and(|write| write.next.is_none())
        }));
        // The drain above took the first write with it, so one frame here is
        // the retry: the write went out again, without sitting out the pause.
        assert_eq!(asked_times(&wire, b"@w=BenchNet,secret"), 1);
    }

    /// Only an ending frees the gate: a phase in flight is the bridge *holding*
    /// it, and a write asked again there is the same refusal.
    #[test]
    fn a_phase_in_flight_leaves_a_waiting_retry_where_it_was() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.run_accessory("@w=BenchNet,secret")
            .expect("the link is up");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "ERR wifi=-16\r\n"));
        assert!(pump_until(&mut app, |app| {
            app.wifi_write
                .as_ref()
                .is_some_and(|write| write.next.is_some())
        }));
        let owed = app
            .wifi_write
            .as_ref()
            .and_then(|write| write.next)
            .expect("a moment");

        wire.feed_management(answer(
            0,
            "@event wifi operation=0 phase=connecting result=0",
        ));
        let deadline = Instant::now() + Duration::from_millis(150);
        while Instant::now() < deadline {
            app.pump();
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            app.wifi_write.as_ref().and_then(|write| write.next),
            Some(owed),
            "a phase in flight is not an ending"
        );
        assert_eq!(
            asked_times(&wire, b"@w=BenchNet,secret"),
            0,
            "nothing went out again (the drain above took the first write)"
        );
    }

    /// A scan is the question a busy board refuses with nothing at all: the
    /// request reaches a management task that is in the middle of another WiFi
    /// operation, and no reply, no `ERR` and no partial list comes back. The
    /// silence is therefore "busy" rather than "no", and the scan is asked
    /// again rather than handed back as unanswered — while the row keeps saying
    /// the scan is in flight, and the wait is said.
    #[test]
    fn a_silent_scan_is_asked_again() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.ask_device(Query::WifiScan).expect("the link is up");
        assert_eq!(asked_times(&wire, b"@w scan"), 1, "the scan went out");

        // Its patience passes with nothing at all on the wire.
        app.report_unanswered(Query::WifiScan, Instant::now());

        assert!(app.network.error.is_none(), "silence is not yet a failure");
        assert!(app.network.loading, "a scan being asked again is in flight");
        assert!(app.waiting_on_device(), "and a script waits with it");
        let retry = app.scan_retry.as_ref().expect("the scan is owed a retry");
        assert_eq!(retry.left, WIFI_BUSY_RETRIES - 1, "an attempt is spent");
        assert!(
            retry.due.is_some(),
            "the retry starts out waiting its pause"
        );
        let notice = app.notices.last().expect("a notice about the wait");
        assert!(notice.text.contains("自动重试"), "{}", notice.text);

        // The bridge finishing with the radio frees the gate, and the pause
        // with it: the same question goes out again without sitting it out.
        let started = Instant::now();
        wire.feed_management(answer(
            0,
            "@event wifi operation=0 phase=failed result=-116",
        ));
        assert!(pump_until(&mut app, |app| {
            app.scan_retry
                .as_ref()
                .is_some_and(|retry| retry.due.is_none())
        }));
        assert!(
            started.elapsed() < wifi_busy_pause(0),
            "the ending brought the retry forward rather than waiting the pause out"
        );
        let (id, body) = newest_question(&wire);
        assert_eq!(body, b"@w scan", "the scan went out again");
        let retry = app.scan_retry.as_ref().expect("still owed the rest");
        assert_eq!(retry.left, WIFI_BUSY_RETRIES - 1, "nothing else was spent");

        // And when the answer does come, nothing is owed any more.
        wire.feed_management(answer(
            id,
            "OK accepted\r\n@scan result BenchNet wpa2 ch=6 -54dBm\r\n@scan done\r\n",
        ));
        assert!(pump_until(&mut app, |app| app.scan_retry.is_none()));
        assert_eq!(
            app.network.scan_results,
            vec!["BenchNet wpa2 ch=6 -54dBm".to_string()],
            "the retried scan's answer is the answer"
        );
        assert_ne!(
            app.network.error.as_deref(),
            Some(Lang::Zh.strings().net_scan_failed),
            "and it is not reported as a failed scan"
        );
    }

    /// The gate has a second spelling for a scan: `ERR scan=-16` is the
    /// firmware's own "a scan is already in flight" from `linkr_wifi_scan_start`,
    /// and it is waited out exactly as silence is.
    #[test]
    fn a_scan_refused_for_busy_waits_its_turn() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.ask_device(Query::WifiScan).expect("the link is up");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "ERR scan=-16\r\n"));

        assert!(pump_until(&mut app, |app| {
            app.scan_retry
                .as_ref()
                .is_some_and(|retry| retry.due.is_some())
        }));
        assert!(app.network.loading, "a scan being retried is in flight");
        assert!(
            app.network.error.is_none(),
            "the gate's number is not an error to show"
        );
        assert_eq!(
            app.scan_retry.as_ref().map(|retry| retry.left),
            Some(WIFI_BUSY_RETRIES - 1),
            "the refusal spends an attempt"
        );
        let notice = app.notices.last().expect("a notice about the wait");
        assert!(notice.text.contains("自动重试"), "{}", notice.text);
    }

    /// A board that never answers is heard about at last: the attempts are
    /// bounded, the record is not left claiming anything, and the sentence says
    /// the retries were spent rather than telling the caller to try again —
    /// which is the one thing that has just been done.
    #[test]
    fn a_scan_that_stays_silent_is_reported_at_last() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.ask_device(Query::WifiScan).expect("the link is up");

        for spent in 0..WIFI_BUSY_RETRIES {
            app.report_unanswered(Query::WifiScan, Instant::now());
            assert_eq!(
                app.scan_retry.as_ref().map(|retry| retry.left),
                Some(WIFI_BUSY_RETRIES - 1 - spent),
                "the attempts are counted down"
            );
            assert!(
                app.scan_retry
                    .as_ref()
                    .is_some_and(|retry| retry.due.is_some()),
                "each silence owes another attempt"
            );
            // The pause is over: the attempt goes out.
            app.send_due_scan_retry(Instant::now() + Duration::from_secs(60));
            assert!(
                app.scan_retry
                    .as_ref()
                    .is_some_and(|retry| retry.due.is_none()),
                "one attempt is on the wire again"
            );
        }
        let (_, body) = newest_question(&wire);
        assert_eq!(body, b"@w scan", "the last attempt is the same question");

        // Silent through every attempt — including the last.
        app.report_unanswered(Query::WifiScan, Instant::now());

        assert!(app.scan_retry.is_none(), "nothing is owed any more");
        assert!(!app.network.loading, "and nothing is left spinning");
        assert_eq!(
            app.network.error.as_deref(),
            Some(
                Lang::Zh
                    .mgmt_no_answer_after_retries(WIFI_BUSY_RETRIES)
                    .as_str()
            ),
            "the row says the retries were spent, not that nothing happened"
        );
    }

    /// The script mode's wait for a scan covers every attempt its retries can
    /// make: a window sized for the first silence alone would end the process
    /// in the middle of them.
    #[test]
    fn the_scan_window_outlasts_the_retries() {
        let pauses: Duration = (0..WIFI_BUSY_RETRIES).map(wifi_busy_pause).sum();
        let patiences = crate::device::Query::WifiScan.patience() * (WIFI_BUSY_RETRIES + 1);
        assert!(
            scan_answer_window() > pauses + patiences,
            "the window has to outlast every attempt and every pause between"
        );
    }

    /// A stranger's ending frees the gate as surely as the bridge's own: the
    /// gate is the radio's, not the operation's, so the waiting write may go
    /// the moment *anything* the board was doing is done.
    #[test]
    fn a_strangers_ending_frees_the_gate_too() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.run_accessory("@w=BenchNet,secret")
            .expect("the link is up");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "ERR wifi=-16\r\n"));
        assert!(pump_until(&mut app, |app| {
            app.wifi_write
                .as_ref()
                .is_some_and(|write| write.next.is_some())
        }));

        wire.feed_management(answer(
            id + 1,
            &format!(
                "@event wifi operation={} phase=ready result=0 state=connected ip=10.9.9.9",
                id + 1
            ),
        ));
        assert!(pump_until(&mut app, |app| {
            app.wifi_write
                .as_ref()
                .is_some_and(|write| write.next.is_none())
        }));
        assert_eq!(
            asked_times(&wire, b"@w=BenchNet,secret"),
            1,
            "the retry went out; the drain above took the first write"
        );
        assert!(
            !app.network.wifi_connected(),
            "somebody else's address is still not this view's network"
        );
    }

    /// The script mode's wait for a join covers every attempt the retry chain
    /// can make: a window sized for the first answer alone would end the
    /// process in the middle of the retries.
    #[test]
    fn the_wifi_write_window_outlasts_the_retries() {
        let pauses: Duration = (0..WIFI_BUSY_RETRIES).map(wifi_busy_pause).sum();
        assert!(
            wifi_write_window() > pauses,
            "the window has to outlast the pauses it covers"
        );
    }

    /// A board that stays busy is heard about rather than asked forever: the
    /// attempts are bounded, and the last word is the sentence that says what
    /// was wrong instead of the number it came as.
    #[test]
    fn a_board_that_stays_busy_is_reported_at_last() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.run_accessory("@w=BenchNet,secret")
            .expect("the link is up");
        let (id, body) = newest_question(&wire);
        assert_eq!(body, b"@w=BenchNet,secret", "the write is the question");
        wire.feed_management(answer(id, "ERR wifi=-16\r\n"));
        assert!(pump_until(&mut app, |app| {
            app.wifi_write
                .as_ref()
                .is_some_and(|write| write.next.is_some())
        }));

        for owed in (1..WIFI_BUSY_RETRIES).rev() {
            app.send_due_wifi_write(Instant::now() + Duration::from_secs(60));
            assert_eq!(
                app.wifi_write.as_ref().map(|write| write.left),
                Some(owed),
                "the attempts are counted down"
            );
            let (id, body) = newest_question(&wire);
            assert_eq!(body, b"@w=BenchNet,secret", "the same write, again");
            wire.feed_management(answer(id, "ERR wifi=-16\r\n"));
            assert!(pump_until(&mut app, |app| {
                app.wifi_write
                    .as_ref()
                    .is_some_and(|write| write.next.is_some())
            }));
        }
        // The last attempt is owed, so it goes out — and is refused in turn.
        app.send_due_wifi_write(Instant::now() + Duration::from_secs(60));
        let (id, body) = newest_question(&wire);
        assert_eq!(body, b"@w=BenchNet,secret", "the last attempt is the same");
        wire.feed_management(answer(id, "ERR wifi=-16\r\n"));
        assert!(pump_until(&mut app, |app| app.network.error.is_some()));

        assert!(app.wifi_write.is_none(), "nothing is owed any more");
        assert!(
            app.wifi_operation.is_none(),
            "a refused write never started an operation"
        );
        assert!(!app.network.loading, "and nothing is left spinning");
        assert_eq!(
            app.network.error.as_deref(),
            Some(Lang::Zh.wifi_failure(-16).as_str()),
            "the row says what busy means, not the errno"
        );
    }

    /// A board whose radio is already up refuses a second join, and the code
    /// it refuses with is the firmware's own `-EALREADY` — 120 in the C library
    /// it is built with, where 114 would be "network unreachable". The refusal
    /// is real (the write did not happen, and a script that reads `ok` has to
    /// know), so it is said as a failure: what the words carry is the step a
    /// switch takes, which is the thing the number cannot.
    #[test]
    fn a_network_already_joined_is_said_rather_than_numbered() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.run_accessory("@w=BenchNet,secret")
            .expect("the link is up");
        let (id, _) = newest_question(&wire);
        wire.feed_management(answer(
            id,
            &format!("ERR wifi={}\r\n", accessory::WIFI_ALREADY),
        ));

        assert!(pump_until(&mut app, |app| !app.waiting_on_device()));
        assert_eq!(
            app.network.error.as_deref(),
            Some(Lang::Zh.wifi_failure(accessory::WIFI_ALREADY).as_str()),
            "the row says what the state means, not the errno"
        );
        assert!(app.wifi_write.is_none(), "nothing is owed any more");
        assert!(
            app.wifi_operation.is_none(),
            "a refused write never started an operation"
        );
        let notice = app.notices.last().expect("a notice");
        assert_eq!(notice.text, Lang::Zh.wifi_failure(accessory::WIFI_ALREADY));
        assert_eq!(notice.level, NoticeLevel::Error);
    }

    /// The code a refusal came as is only kept when nothing here has words for
    /// it: a line this does not know is shown as it arrived, because inventing
    /// a meaning for it would be inventing an error.
    #[test]
    fn an_unknown_refusal_keeps_the_bridges_own_line() {
        let (mut app, wire) = connected_over_ble(Lang::Zh);
        app.run_accessory("@w=BenchNet,secret")
            .expect("the link is up");
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "ERR wifi not configured\r\n"));

        assert!(pump_until(&mut app, |app| app.network.error.is_some()));
        assert_eq!(
            app.network.error.as_deref(),
            Some("ERR wifi not configured")
        );
    }

    /// A command that is not one the bridge takes is refused rather than sent;
    /// the refusal is what keeps a bug in a caller from becoming traffic on the
    /// wire.
    #[test]
    fn a_command_the_bridge_does_not_take_is_refused() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        let err = app
            .run_accessory("reboot")
            .expect_err("not a bridge command");
        assert!(!err.is_empty());
        let deadline = Instant::now() + Duration::from_millis(200);
        while wire.take_management().is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(wire.take_management().is_empty(), "nothing went out for it");
    }

    /// Line mode holds a typed line until Enter, which is what a target with a
    /// line discipline wants — and it is echoed as it is held, so the line can
    /// be read before it is sent.
    #[test]
    fn a_line_is_held_until_enter_and_only_then_written() {
        let (mut app, wire) = connected(Lang::Zh);
        app.line_mode = true;
        app.terminal.echo = true;

        assert!(app.type_bytes(false, "ls"));
        assert!(app.type_bytes(false, " -l"));
        // Nothing has gone out yet, but the line can be read back.
        assert_eq!(app.pending_line, "ls -l");
        assert!(
            app.terminal.visible_text().contains("ls -l"),
            "what was typed is on the screen"
        );
        let deadline = Instant::now() + Duration::from_millis(200);
        while wire.sent_len() == 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(wire.sent_len(), 0, "nothing went out before Enter");

        assert!(app.type_bytes(true, "\n"));
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut sent = Vec::new();
        while sent.len() < 6 && Instant::now() < deadline {
            sent.extend(wire.take_sent());
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(String::from_utf8_lossy(&sent), "ls -l\n");
        assert!(app.pending_line.is_empty(), "the line went with it");
    }

    /// Without line mode a keystroke goes out at once: holding it would break
    /// every target that is doing its own editing, which is most of them.
    #[test]
    fn without_line_mode_a_keystroke_goes_straight_out() {
        let (mut app, wire) = connected(Lang::Zh);
        assert!(app.type_bytes(false, "x"));
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut sent = Vec::new();
        while sent.is_empty() && Instant::now() < deadline {
            sent.extend(wire.take_sent());
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(sent, b"x");
    }

    /// Typing is a return to the command line: a pane reading history is
    /// pulled back to the tail by the first key, so what was just typed and
    /// what answers it are not written off-screen.
    #[test]
    fn typing_resumes_following_the_tail() {
        let (mut app, _wire) = connected(Lang::Zh);
        app.scroll_terminal(7);
        assert!(!app.terminal.autoscroll, "reading history");
        assert!(app.type_bytes(false, "x"));
        assert!(app.terminal.autoscroll, "typing brings the tail back");
        assert_eq!(app.terminal.scroll, 0);
    }

    /// The Enter mode is a fact about the wire rather than about one key: a
    /// command sent from a button is a line too, and it is spelled the same
    /// way a typed one is.
    #[test]
    fn a_command_is_spelled_the_way_the_enter_mode_asks() {
        use crate::serial::keys::EnterMode;
        for (mode, expected) in [
            (EnterMode::Raw, "version\r"),
            (EnterMode::Cr, "version\r"),
            (EnterMode::Lf, "version\n"),
            (EnterMode::Crlf, "version\r\n"),
        ] {
            let (mut app, wire) = connected(Lang::Zh);
            app.enter = mode;
            assert!(app.send_command("version"));
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut sent = Vec::new();
            while sent.len() < expected.len() && Instant::now() < deadline {
                sent.extend(wire.take_sent());
                thread::sleep(Duration::from_millis(2));
            }
            assert_eq!(String::from_utf8_lossy(&sent), expected, "{mode:?}");
        }
    }

    /// A paste's own newlines take the Enter mode's spelling too: a target
    /// that wants `\r` does not want `\n` lines just because they arrived in
    /// one gesture.
    #[test]
    fn a_paste_is_spelled_the_way_the_enter_mode_asks() {
        use crate::serial::keys::EnterMode;
        let (mut app, wire) = connected(Lang::Zh);
        app.enter = EnterMode::Cr;
        assert!(app.paste("a\nb\n"));
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut sent = Vec::new();
        while sent.len() < 4 && Instant::now() < deadline {
            sent.extend(wire.take_sent());
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(String::from_utf8_lossy(&sent), "a\rb\r");
    }

    /// A half-typed line belongs to the session that typed it: carrying it into
    /// the next session would send a stranger your keystrokes.
    #[test]
    fn a_half_typed_line_does_not_survive_the_link() {
        let (mut app, wire) = connected(Lang::Zh);
        app.line_mode = true;
        assert!(app.type_bytes(false, "rm -rf"));
        assert_eq!(app.pending_line, "rm -rf");
        wire.close();
        assert!(pump_until(&mut app, |app| !app.connected()));
        assert!(app.pending_line.is_empty(), "the wire took it with it");
    }

    /// The watch reads every line the target prints, including the ones that
    /// arrive without a newline — which is exactly how a board dies: mid-line,
    /// with its prompt half written.
    #[test]
    fn the_watch_reports_a_panic_and_a_hanging_prompt_alike() {
        let (mut app, wire) = connected(Lang::Zh);
        assert!(app.watch.is_empty());
        wire.feed(b"Booting Linux on physical CPU 0x0\nKernel panic - not syncing\n");
        assert!(pump_until(&mut app, |app| !app.watch.is_empty()));
        let joined = app.watch.join(" | ");
        assert!(joined.contains("panic"), "{joined}");
    }

    /// Binary must not be read as though it were text: the watch
    /// looking for a word cannot be the thing that corrupts a file.
    #[test]
    fn binary_output_is_not_mistaken_for_a_finding() {
        let (mut app, wire) = connected(Lang::Zh);
        wire.feed(&[0x00, 0xff, 0xfe, b'\n', 0x80, 0x81, b'\n']);
        app.pump();
        thread::sleep(Duration::from_millis(10));
        app.pump();
        assert!(app.watch.is_empty(), "{:?}", app.watch);
    }

    /// The choices a user would resent retyping are written the moment they
    /// change, so a kill after any of them costs nothing.
    #[test]
    fn choices_are_written_as_they_change() {
        let path = std::env::temp_dir().join(format!(
            "linkr-tui-settings-app-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        app.settings = Some(crate::settings::SettingsStore::at(&path));
        app.toggle_transport();
        app.set_view(View::Network);
        app.toggle_language();
        let read = crate::settings::SettingsStore::at(&path).read();
        assert_eq!(read.transport, Some(Transport::Lan));
        assert_eq!(read.view, Some(View::Network));
        assert_eq!(read.lang, Some(Lang::En));
        let _ = std::fs::remove_file(&path);
    }

    /// The board's address outlives the run that dialled it — and a LAN dial,
    /// which was never about a board, does not forget it.
    #[test]
    fn a_board_address_outlives_the_run() {
        use crate::transport::ble::Selection;

        let path = std::env::temp_dir().join(format!(
            "linkr-tui-settings-address-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.settings = Some(crate::settings::SettingsStore::at(&path));
        app.last_dial = Some(Dial::Ble(
            Selection::Address("EE:C7:42:34:48:CF".to_string()),
            None,
        ));
        app.set_view(View::Terminal);
        assert_eq!(
            crate::settings::SettingsStore::at(&path).read().address,
            "EE:C7:42:34:48:CF"
        );

        app.last_dial = Some(Dial::Lan {
            host: "192.168.0.100".to_string(),
            token: None,
        });
        app.set_view(View::Terminal);
        assert_eq!(
            crate::settings::SettingsStore::at(&path).read().address,
            "EE:C7:42:34:48:CF",
            "a LAN dial is not about a board"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// The board's name outlives the run beside its address: the Device row
    /// says what the board is called on the next start rather than a bare
    /// MAC — and a LAN dial, which was never about a board, does not forget
    /// either half.
    #[test]
    fn a_board_name_outlives_the_run() {
        use crate::transport::ble::Selection;

        let path = std::env::temp_dir().join(format!(
            "linkr-tui-settings-name-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.settings = Some(crate::settings::SettingsStore::at(&path));
        app.last_dial = Some(Dial::Ble(
            Selection::Address("FB:F6:91:14:33:3A".to_string()),
            None,
        ));
        app.advertised_name = Some("Linkr BLE UART-3".to_string());
        app.set_view(View::Terminal);
        let read = crate::settings::SettingsStore::at(&path).read();
        assert_eq!(read.address, "FB:F6:91:14:33:3A");
        assert_eq!(read.device_name, "Linkr BLE UART-3");

        // A dial that heard no name is not news that the name already kept
        // for the same address was wrong.
        app.advertised_name = None;
        app.set_view(View::Terminal);
        assert_eq!(
            crate::settings::SettingsStore::at(&path).read().device_name,
            "Linkr BLE UART-3"
        );

        // Dialling a different board moves the pair: the new address has no
        // name until the air carries one, and the old name is not it.
        app.last_dial = Some(Dial::Ble(
            Selection::Address("EE:C7:42:34:48:CF".to_string()),
            None,
        ));
        app.set_view(View::Terminal);
        let read = crate::settings::SettingsStore::at(&path).read();
        assert_eq!(read.address, "EE:C7:42:34:48:CF");
        assert_eq!(read.device_name, "", "a name belongs to one address");

        app.advertised_name = Some("Linkr BLE UART-1".to_string());
        app.set_view(View::Terminal);
        // A LAN dial names its host, which is not the board the next
        // Bluetooth dial is aimed at: neither the address nor the name moves.
        app.last_dial = Some(Dial::Lan {
            host: "192.168.0.100".to_string(),
            token: None,
        });
        app.set_view(View::Terminal);
        let read = crate::settings::SettingsStore::at(&path).read();
        assert_eq!(
            read.address, "EE:C7:42:34:48:CF",
            "a LAN dial is not about a board"
        );
        assert_eq!(
            read.device_name, "Linkr BLE UART-1",
            "nor does it rename one"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A run that starts aimed at a remembered board says the board's name,
    /// not its address — and the dial that follows cannot undo it, while a
    /// dial at another board does.
    #[test]
    fn a_remembered_board_is_named_by_its_name() {
        use crate::transport::ble::Selection;

        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        let remembered = || Dial::Ble(Selection::Address("fb:f6:91:14:33:3a".to_string()), None);
        // What `main` does with the shelf at startup: the address aims the
        // dial, the name names the row.
        app.last_dial = Some(remembered());
        app.remember_device_name("fb:f6:91:14:33:3a", "Linkr BLE UART-3");
        assert_eq!(app.device_text(), "Linkr BLE UART-3 33:3A");

        // The startup dial pressed against the same address keeps the name.
        app.aim_device_row_at(&remembered());
        assert_eq!(app.device_text(), "Linkr BLE UART-3 33:3A");

        // A dial at a *different* board drops it: the name belonged to the
        // board that carried it.
        app.aim_device_row_at(&Dial::Ble(
            Selection::Address("EE:C7:42:34:48:CF".to_string()),
            None,
        ));
        assert_eq!(app.advertised_name, None);
        assert_eq!(app.device_text(), "EE:C7:42:34:48:CF");

        // And that board coming up with a name of its own says so.
        app.advertised_name = Some("Linkr BLE UART-1".to_string());
        let wire = crate::transport::testing::MemoryLink::ble_addressed("EE:C7:42:34:48:CF");
        app.adopt(crate::transport::OpenedLink::open(wire.link()).expect("opens"));
        assert_eq!(app.device_text(), "Linkr BLE UART-1 48:CF");
    }

    /// A remembered board the scan hears by name is named in the Device row —
    /// the run that only ever auto-dialled has never seen a scan result, and
    /// the row showed a MAC — and the name is kept for the next run with it.
    #[test]
    fn a_scan_names_the_remembered_board() {
        use crate::cli::FoundDevice;
        use crate::transport::ble::Selection;

        let path = std::env::temp_dir().join(format!(
            "linkr-tui-settings-scan-name-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.settings = Some(crate::settings::SettingsStore::at(&path));
        app.last_dial = Some(Dial::Ble(
            Selection::Address("FB:F6:91:14:33:3A".to_string()),
            None,
        ));
        assert_eq!(app.device_text(), "FB:F6:91:14:33:3A");

        let heard = |name: Option<&str>, address: &str| FoundDevice {
            name: name.map(str::to_string),
            address: address.to_string(),
            board: true,
            rssi: Some(-60),
        };
        // A name heard for another board is not this board's name, and the
        // remembered board heard without one names nothing.
        app.name_the_remembered_board(&[
            heard(Some("Linkr BLE UART-1"), "DA:EB:CC:48:40:1A"),
            heard(None, "FB:F6:91:14:33:3A"),
        ]);
        assert_eq!(app.device_text(), "FB:F6:91:14:33:3A");

        app.name_the_remembered_board(&[
            heard(Some("Linkr BLE UART-1"), "DA:EB:CC:48:40:1A"),
            heard(Some("Linkr BLE UART-3"), "FB:F6:91:14:33:3A"),
        ]);
        assert_eq!(app.device_text(), "Linkr BLE UART-3 33:3A");
        assert_eq!(
            crate::settings::SettingsStore::at(&path).read().device_name,
            "Linkr BLE UART-3"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A link that comes up asks the board what it is called, before
    /// anything else: the name in the air is a snapshot, and the answer is
    /// what every label in the interface is built from.
    #[test]
    fn a_link_asks_the_board_its_name_as_it_comes_up() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        let wire = crate::transport::testing::MemoryLink::ble();
        app.connect(wire.link()).expect("the memory link opens");
        assert!(pump_until(&mut app, |app| app.connected()));
        assert_eq!(
            app.talk.waiting(),
            Some(Query::BleName),
            "the board is asked its name as the link comes up"
        );
    }

    #[test]
    fn a_refused_malformed_or_timed_out_name_read_does_not_block_lan() {
        for response in [Some("ERR unknown command"), Some("OK"), None] {
            let mut app = App::default();
            let wire = crate::transport::testing::MemoryLink::ble();
            app.connect(wire.link()).unwrap();
            assert!(pump_until(&mut app, |app| app.connected()));
            assert_eq!(app.talk.waiting(), Some(Query::BleName));
            let id = asked_id(&wire);
            if let Some(response) = response {
                wire.feed_management(answer(id, response));
            } else {
                let deadline = Instant::now() + Query::BleName.patience();
                assert_eq!(app.talk.abandon(deadline), Some(Query::BleName));
                app.report_unanswered(Query::BleName, deadline);
            }
            assert!(
                pump_until(&mut app, |app| app.talk.waiting() == Some(Query::Lan)),
                "LAN read must continue after {response:?}"
            );
            assert!(!app.lan_token_read_pending);
            let id = asked_id(&wire);
            wire.feed_management(answer(id, "OK ws=off token=none"));
            assert!(pump_until(&mut app, |app| app.lan_captured == LanCapture::None));
        }
    }

    #[test]
    fn an_intervening_user_query_does_not_block_the_pending_lan_read() {
        let mut app = App::default();
        let wire = crate::transport::testing::MemoryLink::ble();
        app.connect(wire.link()).unwrap();
        assert!(pump_until(&mut app, |app| app.connected()));
        app.ask_device(Query::Uart).unwrap();
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK uart=115200,8,N,1,none"));
        assert!(pump_until(&mut app, |app| app.talk.waiting() == Some(Query::Lan)));
        assert_eq!(app.baud, Some(115200));
    }

    #[test]
    fn name_writes_are_read_back_before_labels_change() {
        for (name, action, custom) in [
            ("Bench custom=yes", "set", true),
            ("Bench custom=no", "accessory", true),
            ("测试😀", "set", true),
            ("Linkr Bee 078C", "reset", false),
        ] {
            let (mut app, wire) = connected_over_ble(Lang::En);
            match action {
                "reset" => app.reset_ble_name().unwrap(),
                "accessory" => app.run_accessory(&format!("@n={name}")).unwrap(),
                _ => app.set_ble_name(name).unwrap(),
            }
            let id = asked_id(&wire);
            wire.feed_management(answer(id, &format!("OK name={name}")));
            assert!(pump_until(&mut app, |app| !app.ble_name_write_pending));
            assert_eq!(app.talk.waiting(), Some(Query::BleName));
            assert_eq!(app.network.ble_name.as_ref().unwrap().name, "Bench Bee");

            let frames = crate::transport::testing::asked_frames(&wire);
            assert_eq!(frames.len(), 1, "one read follows the write");
            let frame = &frames[0];
            assert_eq!(&frame[crate::protocol::MGMT_HEADER_SIZE..], b"@n?");
            let id = u32::from_le_bytes(frame[4..8].try_into().unwrap());
            let provenance = if custom { "yes" } else { "no" };
            wire.feed_management(answer(id, &format!("OK name={name} custom={provenance}")));
            assert!(pump_until(&mut app, |app| !app.waiting_on_device()));
            let status = app.network.ble_name.as_ref().unwrap();
            assert_eq!(status.name, name);
            assert_eq!(status.custom, Some(custom));
        }
    }

    #[test]
    fn a_failed_name_write_keeps_the_last_verified_label() {
        let (mut app, wire) = connected_over_ble(Lang::En);
        app.set_ble_name("Bench custom=yes").unwrap();
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "ERR name=-5"));
        assert!(pump_until(&mut app, |app| !app.waiting_on_device()));
        assert!(!app.ble_name_write_pending);
        assert_eq!(app.network.ble_name.as_ref().unwrap().name, "Bench Bee");
        assert_eq!(app.network.error.as_deref(), Some("ERR name=-5"));
    }

    /// The board's own answer is what the Device row shows, and what the
    /// shelf keeps: a board renamed from another client is named by the new
    /// name, not by the label the air carried when the run started.
    #[test]
    fn the_boards_own_name_replaces_the_label_the_air_carried() {
        use crate::transport::ble::Selection;

        let path = std::env::temp_dir().join(format!(
            "linkr-tui-settings-board-name-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.settings = Some(crate::settings::SettingsStore::at(&path));
        app.last_dial = Some(Dial::Ble(
            Selection::Address("FB:F6:91:14:33:3A".to_string()),
            None,
        ));
        // What the last run remembered: the name the board had then.
        app.remember_device_name("FB:F6:91:14:33:3A", "Linkr Bee 078C");
        assert_eq!(app.device_text(), "Linkr Bee 078C 33:3A");

        // The board says otherwise: it was renamed from another client.
        app.remember_the_board_name("测试😀");
        assert_eq!(app.device_text(), "测试😀 33:3A");
        assert_eq!(
            crate::settings::SettingsStore::at(&path).read().device_name,
            "测试😀",
            "the shelf keeps the name the board reports, not the old one"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A rename made here is confirmed by the board, and the answer is the
    /// new name: the row does not keep showing the name the board had before
    /// the write.
    #[test]
    fn a_rename_updates_the_name_the_row_shows() {
        use crate::transport::ble::Selection;

        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.last_dial = Some(Dial::Ble(
            Selection::Address("FB:F6:91:14:33:3A".to_string()),
            None,
        ));
        app.remember_device_name("FB:F6:91:14:33:3A", "Linkr Bee 078C");
        assert_eq!(app.device_text(), "Linkr Bee 078C 33:3A");

        // The write's confirmation carries the new name and no `custom=`.
        app.apply_reply(
            crate::device::Reply {
                query: Query::BleName,
                status: crate::accessory::reply_status("OK name=测试😀"),
                lines: vec!["OK name=测试😀".to_string()],
            },
            "",
        );
        assert_eq!(app.device_text(), "测试😀 33:3A");
    }

    /// A scan that hears a board under a new name corrects the remembered
    /// one: the old label belonged to the board before the rename.
    #[test]
    fn a_scan_corrects_a_name_that_changed() {
        use crate::cli::FoundDevice;
        use crate::transport::ble::Selection;

        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.last_dial = Some(Dial::Ble(
            Selection::Address("FB:F6:91:14:33:3A".to_string()),
            None,
        ));
        app.remember_device_name("FB:F6:91:14:33:3A", "Linkr Bee 078C");
        assert_eq!(app.device_text(), "Linkr Bee 078C 33:3A");

        let heard = |name: Option<&str>, address: &str| FoundDevice {
            name: name.map(str::to_string),
            address: address.to_string(),
            board: true,
            rssi: Some(-60),
        };
        app.name_the_remembered_board(&[heard(Some("Bench Bee"), "FB:F6:91:14:33:3A")]);
        assert_eq!(
            app.device_text(),
            "Bench Bee 33:3A",
            "a name that changed is news, and the row follows the board"
        );
    }

    /// The name is whatever the board says it is. A host that understood only
    /// the factory default would look right on a fresh board and wrong on
    /// every board whose owner renamed it, so the label follows the board
    /// through all the shapes a name can take.
    #[test]
    fn the_label_follows_the_board_through_every_shape_of_name() {
        use crate::transport::ble::Selection;

        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.last_dial = Some(Dial::Ble(
            Selection::Address("FB:F6:91:14:33:3A".to_string()),
            None,
        ));
        for name in [
            "Linkr Bee 078C",
            "Bench Bee",
            "测试",
            "测试😀",
            "Bee",
            "UART-3",
            "a",
        ] {
            app.remember_the_board_name(name);
            assert_eq!(
                app.device_text(),
                format!("{name} 33:3A"),
                "the row shows the name the board reported: {name:?}"
            );
        }
    }
}
