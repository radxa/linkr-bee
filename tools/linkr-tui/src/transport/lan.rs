//! The LAN socket: the bridge's WebSocket, its access handshake, and the two
//! queues that keep it from being overrun.
//!
//! The same device that speaks Bluetooth also serves a WebSocket, and the bytes
//! are the same bytes: a binary frame is target traffic, in both directions,
//! with no framing of ours on top. That is the whole transport. What makes this
//! file long is the three things around it that a radio does not have.
//!
//! **A socket is reachable before it is trusted.** Anyone on the network can
//! open this bridge, so the firmware asks for a token before it starts
//! forwarding — and it *announces* which: `@ws auth=none` means streaming may
//! begin at once, `@ws auth=required` means one text frame and then it answers
//! `@ws auth=ok`. The announcement is what keeps a stale token from being typed
//! into the target console as UART input. [`Handshake`] is that dialogue as a
//! state machine with no socket in it, so the rule "nothing flows before
//! `auth=ok`" is asserted rather than hoped for.
//!
//! **The bridge drops whole chunks when its queue is full.** Its inbound UART
//! queue is a handful of fixed slots — eight of 244 bytes in the shipping
//! firmware — and the code that feeds it discards a chunk that does not fit
//! rather than blocking, while the queue itself only drains at the line rate
//! (115200 baud ≈ 11.5 KiB/s). A paste therefore arrives intact up to about
//! 1.4 KiB and loses its tail above that. [`Pacer`] is the fix: the uplink is
//! metered to 8 KiB/s, comfortably under the drain rate, with a burst that
//! still fits the queue, so the queue stays empty instead of filling.
//!
//! **A refused dial is usually not a broken host.** While the bridge is reaping
//! the client that just left it stops accepting, so the kernel answers a fresh
//! dial with RST — which reaches us as "connection refused" for a host that is
//! perfectly healthy. [`RETRY_DELAYS`] covers that window; anything that cannot
//! be fixed by waiting (an unroutable address, an HTTP answer, a rejected
//! token, a handshake that never comes) fails on the first attempt with the
//! reason it failed.

use std::collections::VecDeque;
use std::io;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;

use super::{Link, LinkEvent, LinkKind, LinkReader, LinkWriter};

/// The path the bridge serves. `ws://host` is the address a user types; the
/// path is ours to append.
pub const DEFAULT_PATH: &str = "/ws";

/// How long to wait for the TCP connection and the WebSocket upgrade.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the whole access handshake may take, including the token frame.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// The three frames the firmware sends or expects, quoted from `src/ws_bridge.c`.
///
/// The firmware writes them with CRLF and this host compares trimmed text, so
/// the two spellings cannot drift into disagreeing about a trailing newline.
pub const AUTH_NONE: &str = "@ws auth=none";
pub const AUTH_REQUIRED: &str = "@ws auth=required";
pub const AUTH_OK: &str = "@ws auth=ok";

/// How many characters a token has, and the alphabet it uses.
///
/// The firmware generates sixteen random bytes and prints them as lowercase
/// hex, so the width is a contract and not a convention: a token of the right
/// length in the wrong case is a token the bridge will not match.
pub const TOKEN_LEN: usize = 32;

/// What to say when a token is the wrong shape.
pub const TOKEN_ERROR: &str = "The access token must be 32 lowercase hex characters.";
/// What to say when there is no host.
pub const EMPTY_HOST_ERROR: &str = "Enter the device address first.";
/// What to say when the bridge wants a token and none is known.
pub const TOKEN_REQUIRED: &str =
    "This bridge requires an access token. Read it with @s? over BLE, or pass --lan-token.";
/// What to say when the bridge hung up instead of answering `auth=ok`.
pub const TOKEN_REJECTED: &str =
    "The bridge rejected the access token; check it against @s? and try again.";
/// What to say when the handshake never finishes.
pub const HANDSHAKE_TIMEOUT_MSG: &str =
    "The bridge did not finish its access handshake; it may not be a Linkr Bee.";

/// The largest single frame handed to the bridge.
///
/// Also the unit the pacer spends, so it has to stay under what the bridge
/// queue takes while empty — see the module note on dropped chunks.
const FRAME_MAX_BYTES: usize = 1024;

/// The uplink's average rate, in bytes per second.
///
/// 8 KiB/s is about 70% of a 115200-baud line, which is what the firmware
/// drains its queue at. Under the drain rate is the point: at or above it the
/// queue fills eventually and the next chunk is the one that is dropped.
const UPLINK_BYTES_PER_SEC: f64 = 8.0 * 1024.0;

/// What the pacer may spend at once, and therefore the largest burst that can
/// reach the queue before it is drained.
///
/// The firmware's inbound queue is eight chunks of 244 bytes, so 1536 leaves
/// room for a chunk already in flight without ever filling it.
const UPLINK_BURST_BYTES: usize = 1536;

// Not a runtime test: both sides are constants, so an assertion inside one
// would always have held by the time it ran. This one fails the *build*.
const _: () = assert!(
    UPLINK_BURST_BYTES <= 8 * 244,
    "the burst has to fit the firmware's inbound queue"
);

/// How many buffered bytes are held back from the socket before the sender
/// stops taking more. Bounded for the same reason the BLE write backlog is: an
/// unbounded one lets the interface queue a megabyte towards a bridge that has
/// stopped listening.
///
/// Bytes, not messages: one message from the interface can be a paste of any
/// size, so the cap is enforced where bytes wait — `pending` in [`carry`] — and
/// not on the channel between the writer thread and the reactor.
const UPLINK_BACKLOG: usize = 64 * 1024;

/// How many messages the hand-off channel between the writer thread and the
/// reactor holds. Small on purpose: the hand-off is a thread boundary, while
/// the backlog that matters is measured in bytes — see [`UPLINK_BACKLOG`].
const UPLINK_MESSAGES: usize = 64;

/// The waits between attempts at a dial that could succeed if tried again.
///
/// Three steps cover the firmware's three-second auth window with room to
/// spare, and they are deliberately short: this is a window, not an outage.
const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(300),
    Duration::from_millis(700),
    Duration::from_millis(1500),
];

/// The `ws://…/ws` URL a host argument names.
///
/// Anything already carrying a scheme is taken as written — a user who typed
/// `wss://` or added a path knows something we do not — and everything else
/// gets the scheme and the path the bridge serves.
pub fn normalize_url(host: &str) -> String {
    let host = host.trim();
    if host.starts_with("ws://") || host.starts_with("wss://") {
        return host.to_string();
    }
    format!("ws://{host}{DEFAULT_PATH}")
}

/// The `host:port` a URL is addressed by, in one case.
///
/// This is the identity a token is remembered against, so `192.168.0.44` and
/// `ws://192.168.0.44/ws` have to reduce to the same key — otherwise the token
/// captured in one spelling is not found under the other. A *default* port is
/// not part of that identity either: `192.168.0.44:80` reaches the same bridge
/// as `192.168.0.44`, so a token stored under one must be found under the
/// other. Any other port is kept: `:8080` is a different listener and may be a
/// different bridge.
pub fn host_key(host: &str) -> String {
    let url = normalize_url(host);
    // `normalize_url` writes the scheme, so the fallback is a shape the types
    // ask for rather than a case a caller can reach.
    let (scheme, rest) = url.split_once("://").unwrap_or(("ws", url.as_str()));
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let authority = authority.to_ascii_lowercase();
    let default_port = if scheme.eq_ignore_ascii_case("wss") {
        ":443"
    } else {
        ":80"
    };
    match authority.strip_suffix(default_port) {
        // Only the port goes: `:80` alone would leave nothing to address.
        Some(bare) if !bare.is_empty() => bare.to_string(),
        _ => authority,
    }
}

/// Whether a normalised key can name a bridge at all.
///
/// A key is what a dial wrote down: an address with a dot in it, or a name and
/// a port. A bare word is neither. The firmware reports its address as `down`
/// or `ready` while there is nothing to dial, and a token remembered under one
/// of those words is a token nobody can ever use — which is exactly the kind
/// of entry a hand-edited or once-broken store collects. Kept beside
/// [`host_key`], because the two together define what the store's keys are.
pub fn is_bridge_address(key: &str) -> bool {
    !key.is_empty() && (key.contains('.') || key.contains(':'))
}

/// Whether `token` is the token the bridge will accept.
///
/// Lowercase is not a style preference: `src/ws_bridge.c` compares the frame
/// byte for byte against what it printed, so an upper-case spelling of the same
/// bytes is a different token.
pub fn validate_token(token: &str) -> Result<(), String> {
    if token.len() == TOKEN_LEN
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(TOKEN_ERROR.to_string())
    }
}

/// Whether this dial is well formed enough to be worth a socket.
///
/// The shape is checked here, once, so that both the dial and the link refuse
/// the same thing for the same reason: an empty host would otherwise come back
/// as a connect timeout, and a mis-shaped token as a handshake timeout — both
/// saying much less than what is already known.
pub fn validate_dial(host: &str, token: Option<&str>) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err(EMPTY_HOST_ERROR.to_string());
    }
    match token {
        Some(token) => validate_token(token),
        None => Ok(()),
    }
}

/// Where an access handshake has got to.
///
/// The three states are the firmware's three frames from this side, and there
/// is deliberately no state for "authenticated but sending": nothing goes out
/// between them except the token itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handshake {
    /// Connected, and nothing heard yet. The bridge speaks first.
    Announced,
    /// `auth=required` was seen and our token is on its way.
    Sent,
    /// `auth=ok` was seen. Bytes may flow.
    Open,
}

/// What to do with a text frame that arrived in some state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The handshake is done; from here on text frames are notices.
    Open,
    /// The bridge wants the token: send it as one text frame.
    SendToken,
    /// Not a frame of this dialogue. Dropped, because a frame we do not
    /// recognise is a stranger's — and answering one would be worse than
    /// ignoring it.
    Ignore,
}

impl Handshake {
    /// Start waiting for the bridge's announcement.
    pub fn new() -> Handshake {
        Handshake::Announced
    }

    /// Fold one text frame into the dialogue.
    ///
    /// Trailing whitespace is trimmed, because the firmware's frames carry
    /// CRLF and comparing the raw text would make the newline part of the
    /// contract.
    pub fn step(self, text: &str) -> (Handshake, Step) {
        match text.trim() {
            AUTH_NONE => (Handshake::Open, Step::Open),
            AUTH_OK => (Handshake::Open, Step::Open),
            AUTH_REQUIRED => match self {
                // Asking twice is not an error: the answer is the same one,
                // and the token is already in flight.
                Handshake::Sent => (Handshake::Sent, Step::Ignore),
                _ => (Handshake::Sent, Step::SendToken),
            },
            _ => (self, Step::Ignore),
        }
    }

    /// The reason the connection ended in this state, or `None` when it ended
    /// where a session may legitimately finish.
    pub fn cut_short(self, sent_token: bool) -> Option<&'static str> {
        match self {
            Handshake::Open => None,
            Handshake::Sent => Some(TOKEN_REJECTED),
            Handshake::Announced if sent_token => Some(TOKEN_REJECTED),
            Handshake::Announced => Some(HANDSHAKE_TIMEOUT_MSG),
        }
    }
}

impl Default for Handshake {
    fn default() -> Self {
        Handshake::new()
    }
}

/// A metered uplink.
///
/// Tokens accumulate with time and a chunk may only go out once its own bytes
/// have accumulated, which is what turns a paste from "one burst the bridge
/// drops" into a stream it drains. The clock is passed in rather than read, so
/// the arithmetic is a pure function and testable without waiting.
#[derive(Debug, Clone, Copy)]
pub struct Pacer {
    capacity: f64,
    rate: f64,
    tokens: f64,
    last: Instant,
}

impl Pacer {
    /// A pacer that starts full, so the first chunk is not delayed.
    pub fn new(capacity: usize, rate: f64) -> Pacer {
        Pacer {
            capacity: capacity as f64,
            rate,
            tokens: capacity as f64,
            last: Instant::now(),
        }
    }

    /// The uplink's default pacer: the one the module note derives.
    pub fn uplink() -> Pacer {
        Pacer::new(UPLINK_BURST_BYTES, UPLINK_BYTES_PER_SEC)
    }

    /// Add whatever the elapsed time earned, capped at the burst.
    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.rate).min(self.capacity);
    }

    /// How long until `want` bytes may be sent.
    pub fn delay(&mut self, want: usize, now: Instant) -> Duration {
        self.refill(now);
        let want = want as f64;
        if want <= self.tokens || self.rate <= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64((want - self.tokens) / self.rate)
        }
    }

    /// Record that `want` bytes were sent.
    pub fn spend(&mut self, want: usize, now: Instant) {
        self.refill(now);
        self.tokens = (self.tokens - want as f64).max(0.0);
    }
}

/// A LAN bridge that has not been dialled yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanLink {
    host: String,
    token: Option<String>,
}

impl LanLink {
    /// Dial `host` with `token`. Nothing is opened until [`Link::open`], which
    /// is what lets the command line describe a bridge it has not reached.
    pub fn new(host: impl Into<String>, token: Option<String>) -> LanLink {
        LanLink {
            host: host.into(),
            token,
        }
    }

    /// The address as typed.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// Whether a token is available, without saying what it is.
    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }
}

impl Link for LanLink {
    fn open(self: Box<Self>) -> io::Result<(Box<dyn LinkReader>, Box<dyn LinkWriter>)> {
        let host = self.host.trim().to_string();
        validate_dial(&host, self.token.as_deref())
            .map_err(|why| io::Error::new(io::ErrorKind::InvalidInput, why))?;

        // Three channels meet here: the socket's bytes come back as `Inbound`
        // (so a notice can be told apart from target output), bytes to send go
        // out over the sync channel `spawn_writer` owns, and the dial reports
        // success or its reason once.
        let (inbound_tx, inbound_rx) = mpsc::channel::<Inbound>();
        let (outbound_tx, outbound_rx) = mpsc::channel::<Vec<u8>>();
        let (ready_tx, ready_rx) = mpsc::channel::<io::Result<()>>();
        let (to_socket_tx, to_socket_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(UPLINK_MESSAGES);

        let url = normalize_url(&host);
        let token = self.token.clone();
        thread::spawn(move || {
            serve(&url, token, ready_tx, inbound_tx, to_socket_rx);
        });
        // The interface's writer is synchronous and sits outside every runtime,
        // so the hand-off to the reactor gets a thread of its own: this is the
        // one place `blocking_send` is legal.
        thread::spawn(move || {
            while let Ok(bytes) = outbound_rx.recv() {
                if to_socket_tx.blocking_send(bytes).is_err() {
                    break;
                }
            }
        });

        // `open` returning means "connected" everywhere else in the product,
        // so it waits for the dial — handshake included — rather than handing
        // back a link that would fail on its first write.
        match ready_rx.recv_timeout(dial_budget()) {
            Err(why) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("the LAN bridge did not come up within {why}"),
            )),
            Ok(Err(why)) => Err(why),
            Ok(Ok(())) => Ok((
                Box::new(LanReader {
                    inbound: inbound_rx,
                    notices: None,
                    leftover: VecDeque::new(),
                    done: false,
                }),
                Box::new(LanWriter {
                    outbound: outbound_tx,
                }),
            )),
        }
    }

    fn kind(&self) -> LinkKind {
        LinkKind::Lan
    }

    fn describe(&self) -> String {
        // The token is never part of a description: descriptions end up in
        // notices, in the sidebar and in bug reports.
        format!("lan:{}", host_key(&self.host))
    }

    fn lan_details(&self) -> Option<(String, bool)> {
        Some((self.host.clone(), self.token.is_some()))
    }
}

/// How long a dial may take in total: connect, retries, handshake.
///
/// One number rather than three, because the caller's wait is the sum of them
/// either way and a link that reported itself open after its own deadline
/// would be worse than one that failed on time.
fn dial_budget() -> Duration {
    CONNECT_TIMEOUT
        + HANDSHAKE_TIMEOUT
        + RETRY_DELAYS.iter().sum::<Duration>()
        + Duration::from_millis(50)
}

/// One thing the socket produced.
///
/// The reader half has to be told which is which, because a notice is not
/// target output: a frame the bridge sends out of band is meant for the user's
/// eyes, and a frame it sends as binary is meant for the emulator.
enum Inbound {
    Data(Vec<u8>),
    Notice(String),
    /// The socket ended. The reader reports end-of-stream, as `LinkReader`
    /// promises, rather than an error: a bridge that walked away is a hang-up.
    End,
}

/// Why a dial failed, and whether trying again could help.
#[derive(Debug)]
enum Failure {
    /// The bridge said no for a reason that will be the same next time.
    Permanent(String),
    /// The bridge was mid-handshake with someone else and refused this dial.
    Transient(String),
}

/// The reactor thread: dial with retries, then pump until either end stops.
fn serve(
    url: &str,
    token: Option<String>,
    ready: Sender<io::Result<()>>,
    inbound: Sender<Inbound>,
    outbound: tokio::sync::mpsc::Receiver<Vec<u8>>,
) {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(why) => {
            let _ = ready.send(Err(io::Error::other(format!(
                "the LAN runtime could not be started: {why}"
            ))));
            return;
        }
    };

    runtime.block_on(async move {
        let mut attempt = 0;
        let socket = loop {
            match dial(url, token.as_deref()).await {
                Ok(socket) => break socket,
                Err(Failure::Permanent(why)) => {
                    let _ = ready.send(Err(io::Error::other(why)));
                    return;
                }
                Err(Failure::Transient(why)) => {
                    if attempt == RETRY_DELAYS.len() {
                        let _ = ready.send(Err(io::Error::new(
                            io::ErrorKind::ConnectionRefused,
                            format!("{why} (gave up after {} attempts)", attempt + 1),
                        )));
                        return;
                    }
                    // The bridge refuses a fresh dial while it is still
                    // reaping the client that just left. Waiting is the fix.
                    tokio::time::sleep(RETRY_DELAYS[attempt]).await;
                    attempt += 1;
                }
            }
        };

        if ready.send(Ok(())).is_err() {
            // Nobody is waiting for this socket any more — the caller gave up
            // while the dial was still retrying. Returning drops it and closes
            // the connection, instead of carrying a link whose reader has gone.
            return;
        }
        carry(socket, &inbound, outbound).await;
    });
    drop(runtime);
}

/// Connect and complete the access handshake.
async fn dial(
    url: &str,
    token: Option<&str>,
) -> Result<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, Failure> {
    let (mut socket, _response) =
        match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url)).await {
            Err(_) => {
                return Err(Failure::Permanent(format!(
                    "the bridge at {url} did not answer within {} s",
                    CONNECT_TIMEOUT.as_secs()
                )))
            }
            Ok(Err(why)) => return Err(classify(why, url)),
            Ok(Ok(pair)) => pair,
        };

    let mut handshake = Handshake::new();
    let mut sent_token = false;
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Failure::Permanent(HANDSHAKE_TIMEOUT_MSG.to_string()));
        }
        let frame = match tokio::time::timeout(remaining, socket.next()).await {
            Err(_) => return Err(Failure::Permanent(HANDSHAKE_TIMEOUT_MSG.to_string())),
            Ok(None) => {
                let why = handshake
                    .cut_short(sent_token)
                    .unwrap_or(HANDSHAKE_TIMEOUT_MSG)
                    .to_string();
                return Err(Failure::Permanent(why));
            }
            Ok(Some(Err(why))) => {
                let why = format!("the connection failed during the handshake: {why}");
                return Err(Failure::Permanent(why));
            }
            Ok(Some(Ok(frame))) => frame,
        };

        // Binary frames carry target output and cannot arrive before the
        // handshake: the firmware promotes a socket to UART-delivering only
        // after it authenticates it. Dropping one here is the safe reading of
        // a frame that should not exist.
        let Message::Text(text) = frame else {
            continue;
        };
        match handshake.step(text.as_str()) {
            (state, Step::Ignore) => {
                handshake = state;
            }
            (state, Step::Open) => {
                let _ = state;
                return Ok(socket);
            }
            (state, Step::SendToken) => {
                handshake = state;
                let Some(token) = token else {
                    return Err(Failure::Permanent(TOKEN_REQUIRED.to_string()));
                };
                if let Err(why) = validate_token(token) {
                    return Err(Failure::Permanent(why));
                }
                // Exactly the token, as one text frame: the firmware compares
                // the frame's length and its bytes, so a newline appended for
                // tidiness would be a mismatch.
                if socket
                    .send(Message::Text(token.to_string().into()))
                    .await
                    .is_err()
                {
                    return Err(Failure::Permanent(TOKEN_REJECTED.to_string()));
                }
                sent_token = true;
            }
        }
    }
}

/// Decide whether a dial failure is worth another attempt.
fn classify(why: tokio_tungstenite::tungstenite::Error, url: &str) -> Failure {
    use tokio_tungstenite::tungstenite::Error;

    match why {
        Error::Io(ref io_error)
            if matches!(
                io_error.kind(),
                io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
            ) =>
        {
            Failure::Transient(format!("the bridge at {url} refused the connection"))
        }
        Error::Http(response) => Failure::Permanent(format!(
            "the bridge at {url} answered HTTP {} rather than a WebSocket",
            response.status()
        )),
        other => Failure::Permanent(format!("the bridge at {url} could not be dialled: {other}")),
    }
}

/// Move bytes both ways until one end stops, metering the uplink as it goes.
async fn carry(
    mut socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    inbound: &Sender<Inbound>,
    mut outbound: tokio::sync::mpsc::Receiver<Vec<u8>>,
) {
    let mut pending: VecDeque<u8> = VecDeque::new();
    let mut pacer = Pacer::uplink();

    loop {
        // Send first, and outside the wait below, so the socket is never
        // borrowed by two futures at once.
        let chunk_len = pending.len().min(FRAME_MAX_BYTES);
        if chunk_len > 0 {
            let now = Instant::now();
            let wait = pacer.delay(chunk_len, now);
            if wait.is_zero() {
                let chunk: Vec<u8> = pending.drain(..chunk_len).collect();
                if socket.send(Message::Binary(chunk.into())).await.is_err() {
                    let _ = inbound.send(Inbound::End);
                    return;
                }
                pacer.spend(chunk_len, Instant::now());
                continue;
            }
            // Not yet: wait for whichever comes first — the pacer's time, more
            // bytes, or a frame from the bridge. More bytes only while there is
            // room under the cap; with the queue full they stay in their own
            // channel, which is the backpressure the cap exists for.
            tokio::select! {
                frame = socket.next() => {
                    if !absorb(frame, inbound) {
                        return;
                    }
                }
                bytes = outbound.recv(), if pending.len() < UPLINK_BACKLOG => {
                    if !queue(bytes, &mut pending, inbound) {
                        return;
                    }
                }
                () = tokio::time::sleep(wait) => {}
            }
            continue;
        }

        // Nothing is held back here — `chunk_len` was zero — so there is room
        // by definition, and the paced branch above is the only place
        // `pending` grows where the cap has to be consulted.
        tokio::select! {
            frame = socket.next() => {
                if !absorb(frame, inbound) {
                    return;
                }
            }
            bytes = outbound.recv() => {
                if !queue(bytes, &mut pending, inbound) {
                    return;
                }
            }
        }
    }
}

/// Fold one frame from the bridge. `false` means the pump is over.
fn absorb(
    frame: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
    inbound: &Sender<Inbound>,
) -> bool {
    match frame {
        None => {
            let _ = inbound.send(Inbound::End);
            false
        }
        Some(Err(_)) => {
            let _ = inbound.send(Inbound::End);
            false
        }
        // Control frames are tungstenite's business: it answers a ping and a
        // close itself, and neither is target output.
        Some(Ok(Message::Binary(bytes))) => {
            if bytes.is_empty() {
                return true;
            }
            inbound.send(Inbound::Data(bytes.to_vec())).is_ok()
        }
        Some(Ok(Message::Text(text))) => {
            if text.is_empty() {
                return true;
            }
            inbound.send(Inbound::Notice(text.to_string())).is_ok()
        }
        Some(Ok(_)) => true,
    }
}

/// Buffer bytes to send. `false` means the interface closed the link.
fn queue(bytes: Option<Vec<u8>>, pending: &mut VecDeque<u8>, inbound: &Sender<Inbound>) -> bool {
    match bytes {
        Some(bytes) => {
            pending.extend(bytes);
            true
        }
        None => {
            let _ = inbound.send(Inbound::End);
            false
        }
    }
}

/// Target output, in order, with the bridge's own frames routed around it.
struct LanReader {
    inbound: Receiver<Inbound>,
    /// Where a notice goes. Handed over by the reader thread before the first
    /// read, because a link with a side channel has to be able to speak without
    /// pretending a notice is bytes.
    notices: Option<Sender<LinkEvent>>,
    leftover: VecDeque<u8>,
    done: bool,
}

impl LinkReader for LanReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done {
            return Ok(0);
        }
        while self.leftover.is_empty() {
            match self.inbound.recv() {
                Ok(Inbound::Data(bytes)) => self.leftover.extend(bytes),
                Ok(Inbound::Notice(text)) => {
                    if let Some(notices) = &self.notices {
                        if notices.send(LinkEvent::Notice(text)).is_err() {
                            self.done = true;
                            return Ok(0);
                        }
                    }
                }
                Ok(Inbound::End) | Err(_) => {
                    self.done = true;
                    return Ok(0);
                }
            }
        }
        let n = buf.len().min(self.leftover.len());
        for slot in buf.iter_mut().take(n) {
            *slot = self.leftover.pop_front().unwrap_or(0);
        }
        Ok(n)
    }

    fn side_channel(&mut self, events: Sender<LinkEvent>) {
        self.notices = Some(events);
    }
}

/// Bytes towards the bridge.
struct LanWriter {
    outbound: Sender<Vec<u8>>,
}

impl LinkWriter for LanWriter {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        self.outbound
            .send(buf.to_vec())
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the LAN link is no longer up"))
    }

    fn flush(&mut self) -> io::Result<()> {
        // Nothing is buffered here: the pacer holds bytes on the reactor side,
        // and claiming otherwise would let a caller believe it had pushed them.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host typed three ways is one address, because the token is remembered
    /// against this key: two spellings that reduce to one key would otherwise
    /// be two devices.
    #[test]
    fn a_host_reduces_to_one_key() {
        assert_eq!(host_key("192.168.0.44"), "192.168.0.44");
        assert_eq!(host_key(" 192.168.0.44 "), "192.168.0.44");
        assert_eq!(host_key("ws://192.168.0.44/ws"), "192.168.0.44");
        assert_eq!(host_key("wss://LinkrBee.local/ws"), "linkrbee.local");
        assert_eq!(host_key("ws://192.168.0.44:81/ws"), "192.168.0.44:81");
    }

    /// The URL the transport dials is the one the bridge serves.
    #[test]
    fn a_bare_host_becomes_the_bridge_url() {
        assert_eq!(normalize_url("192.168.0.44"), "ws://192.168.0.44/ws");
        assert_eq!(
            normalize_url("ws://192.168.0.44:9001/other"),
            "ws://192.168.0.44:9001/other",
            "a scheme was typed, so the spelling is the user's"
        );
    }

    /// A token is exactly what the firmware printed: sixteen bytes as
    /// lowercase hex, and nothing else.
    #[test]
    fn only_thirty_two_lowercase_hex_characters_pass() {
        assert!(validate_token("0123456789abcdef0123456789abcdef").is_ok());
        assert!(validate_token("0123456789ABCDEF0123456789ABCDEF").is_err());
        assert!(validate_token("0123456789abcdef0123456789abcde").is_err());
        assert!(validate_token("0123456789abcdef0123456789abcdeff").is_err());
        assert!(validate_token("").is_err());
        assert!(validate_token("0123456789abcdef0123456789abcdeg").is_err());
    }

    /// The dialogue is the firmware's, frame for frame. Asserted against the
    /// literals `src/ws_bridge.c` defines, because a client that agreed with
    /// itself about a different spelling would fail on hardware only.
    #[test]
    fn the_three_frames_are_the_firmware_s() {
        assert_eq!(AUTH_NONE, "@ws auth=none");
        assert_eq!(AUTH_REQUIRED, "@ws auth=required");
        assert_eq!(AUTH_OK, "@ws auth=ok");
        assert_eq!(TOKEN_LEN, 32);
    }

    /// A bridge with no token invites the session straight in.
    #[test]
    fn auth_none_opens_without_a_token() {
        let (state, step) = Handshake::new().step("@ws auth=none");
        assert_eq!(step, Step::Open);
        assert_eq!(state, Handshake::Open);
    }

    /// The CRLF the firmware writes is not part of the contract.
    #[test]
    fn the_firmwares_line_ending_is_trimmed() {
        assert_eq!(
            Handshake::new().step("@ws auth=required\r\n").1,
            Step::SendToken
        );
        assert_eq!(Handshake::new().step("  @ws auth=ok  ").1, Step::Open);
    }

    /// The token is asked for once, and the answer is the token.
    #[test]
    fn auth_required_asks_for_the_token_once() {
        let (state, step) = Handshake::new().step(AUTH_REQUIRED);
        assert_eq!(step, Step::SendToken);
        assert_eq!(state, Handshake::Sent);
        let (state, step) = state.step(AUTH_OK);
        assert_eq!(step, Step::Open);
        assert_eq!(state, Handshake::Open);
    }

    /// Anything that is not part of the dialogue is dropped, and dropping it
    /// does not advance the dialogue.
    #[test]
    fn an_unexpected_frame_is_ignored() {
        let (state, step) = Handshake::new().step("hello");
        assert_eq!(step, Step::Ignore);
        assert_eq!(state, Handshake::Announced, "still waiting for the bridge");

        let (state, step) = Handshake::Sent.step("hello");
        assert_eq!(step, Step::Ignore);
        assert_eq!(state, Handshake::Sent, "and still waiting for auth=ok");
    }

    /// A hang-up before `auth=ok` is the rejected-token case, not a generic
    /// close: it is the one failure whose fix is in the user's hands.
    #[test]
    fn a_hang_up_before_auth_ok_names_the_right_cause() {
        assert_eq!(Handshake::Sent.cut_short(true), Some(TOKEN_REJECTED));
        assert_eq!(
            Handshake::Announced.cut_short(true),
            Some(TOKEN_REJECTED),
            "a token was sent, so its rejection is what the silence means"
        );
        assert_eq!(
            Handshake::Announced.cut_short(false),
            Some(HANDSHAKE_TIMEOUT_MSG)
        );
        assert_eq!(
            Handshake::Open.cut_short(true),
            None,
            "an authenticated bridge hanging up is an ordinary end"
        );
    }

    /// The pacer starts full, so a single chunk is not delayed by a meter that
    /// has not been earned yet.
    #[test]
    fn the_first_burst_goes_out_at_once() {
        let now = Instant::now();
        let mut pacer = Pacer::new(UPLINK_BURST_BYTES, UPLINK_BYTES_PER_SEC);
        assert_eq!(pacer.delay(FRAME_MAX_BYTES, now), Duration::ZERO);
        pacer.spend(FRAME_MAX_BYTES, now);
        // The bucket started full and a frame is smaller than the burst, so
        // only the part of the next frame the burst did not already cover has
        // to be earned.
        let left_over = (UPLINK_BURST_BYTES - FRAME_MAX_BYTES) as f64;
        let missing = FRAME_MAX_BYTES as f64 - left_over;
        assert_eq!(
            pacer.delay(FRAME_MAX_BYTES, now),
            Duration::from_secs_f64(missing / UPLINK_BYTES_PER_SEC),
            "and only then does the next chunk have to earn its time"
        );
    }

    /// The meter is a rate, not a delay: waiting long enough always pays for
    /// the next chunk, and the burst it may spend at once is bounded.
    #[test]
    fn time_buys_tokens_up_to_the_burst() {
        let start = Instant::now();
        let mut pacer = Pacer::new(UPLINK_BURST_BYTES, UPLINK_BYTES_PER_SEC);
        pacer.spend(UPLINK_BURST_BYTES, start);
        let later = start + Duration::from_secs(1);
        assert_eq!(
            pacer.delay(UPLINK_BURST_BYTES, later),
            Duration::ZERO,
            "a second at 8 KiB/s buys back the whole burst"
        );
        // But not more than the burst, however long the wait was: the cap is
        // what stops a bridge that went quiet from being handed a minute's
        // worth of paste in one write.
        let much_later = start + Duration::from_secs(60);
        pacer.spend(UPLINK_BURST_BYTES, much_later);
        assert!(
            pacer.delay(UPLINK_BURST_BYTES + 1, much_later) > Duration::ZERO,
            "a byte more than the bucket can hold is never free"
        );
        // Emptied again, the burst's own worth of time buys it back.
        let earned = UPLINK_BURST_BYTES as f64 / UPLINK_BYTES_PER_SEC;
        assert!(
            pacer.delay(
                UPLINK_BURST_BYTES,
                much_later + Duration::from_secs_f64(earned)
            ) <= Duration::from_millis(1),
            "the rate buys back what the rate spent"
        );
    }

    /// The uplink is metered below the line rate, or the queue fills and the
    /// bridge starts dropping whole chunks.
    #[test]
    fn the_uplink_is_slower_than_the_line_it_feeds() {
        let line_rate = 115_200.0 / 10.0; // 8N1: ten bits per byte
        assert!(
            UPLINK_BYTES_PER_SEC < line_rate,
            "{UPLINK_BYTES_PER_SEC} B/s must stay under {line_rate} B/s"
        );
        // The burst against the firmware's queue is asserted where it is
        // defined, because both of them are constants and a later engineer
        // changing one is who must hear about the other.
    }

    /// A description is shown to the user and pasted into reports, so the
    /// token must not be in it.
    #[test]
    fn the_description_names_the_host_and_not_the_token() {
        let token = "0123456789abcdef0123456789abcdef";
        let link = LanLink::new("192.168.0.44", Some(token.to_string()));
        assert_eq!(link.describe(), "lan:192.168.0.44");
        assert!(!link.describe().contains(token));
        assert!(link.has_token());
        assert_eq!(link.kind(), LinkKind::Lan);
    }

    /// Open a link that must be refused, and hand back the refusal.
    ///
    /// Not `expect_err`: `open()` returns boxed trait objects on its happy
    /// path, and those are not `Debug`.
    fn refuse(link: Box<dyn Link>) -> io::Error {
        match link.open() {
            Ok(_) => panic!("this dial was supposed to be refused"),
            Err(err) => err,
        }
    }

    /// An empty host is refused before anything is dialled, because a dial to
    /// nowhere answers with a timeout that says nothing.
    #[test]
    fn an_empty_host_is_refused_before_the_socket() {
        let link = Box::new(LanLink::new("   ", None));
        let why = refuse(link).to_string();
        assert_eq!(why, EMPTY_HOST_ERROR);
    }

    /// A token of the wrong shape is refused before the socket too: sending it
    /// would burn the handshake window to learn what we already know.
    #[test]
    fn a_malformed_token_is_refused_before_the_socket() {
        let link = Box::new(LanLink::new("192.168.0.44", Some("NOTATOKEN".to_string())));
        let why = refuse(link).to_string();
        assert_eq!(why, TOKEN_ERROR);
    }

    /// A notice is not target output: it comes back as a notice event and
    /// never as bytes for the emulator.
    #[test]
    fn a_notice_is_reported_as_a_notice() {
        let (tx, rx) = mpsc::channel::<Inbound>();
        let (events_tx, events_rx) = mpsc::channel::<LinkEvent>();
        let mut reader = LanReader {
            inbound: rx,
            notices: None,
            leftover: VecDeque::new(),
            done: false,
        };
        reader.side_channel(events_tx);
        let _ = tx.send(Inbound::Notice("the bridge is at 192.168.0.44".to_string()));
        let _ = tx.send(Inbound::Data(b"uptime\n".to_vec()));
        let _ = tx.send(Inbound::End);

        let mut buf = [0u8; 16];
        assert_eq!(reader.read(&mut buf).unwrap(), 7);
        assert_eq!(&buf[..7], b"uptime\n");
        assert_eq!(reader.read(&mut buf).unwrap(), 0, "then end of stream");

        let events: Vec<LinkEvent> = events_rx.try_iter().collect();
        assert_eq!(
            events,
            vec![LinkEvent::Notice(
                "the bridge is at 192.168.0.44".to_string()
            )]
        );
    }

    /// Nothing buffered and the socket gone reads as a clean end, not a fault.
    #[test]
    fn a_socket_that_ended_reads_end_of_stream() {
        let (tx, rx) = mpsc::channel::<Inbound>();
        let mut reader = LanReader {
            inbound: rx,
            notices: None,
            leftover: VecDeque::new(),
            done: false,
        };
        let _ = tx.send(Inbound::Data(vec![1, 2, 3]));
        let _ = tx.send(Inbound::End);
        let mut buf = [0u8; 8];
        assert_eq!(reader.read(&mut buf).unwrap(), 3);
        assert_eq!(reader.read(&mut buf).unwrap(), 0);
        assert_eq!(reader.read(&mut buf).unwrap(), 0, "and that stays true");
    }

    /// A frame longer than the caller's buffer is not truncated: the tail waits
    /// for the next read, or the pane loses the end of a long line.
    #[test]
    fn bytes_that_do_not_fit_wait_for_the_next_read() {
        let (tx, rx) = mpsc::channel::<Inbound>();
        let mut reader = LanReader {
            inbound: rx,
            notices: None,
            leftover: VecDeque::new(),
            done: false,
        };
        let sent: Vec<u8> = (0..10).collect();
        let _ = tx.send(Inbound::Data(sent.clone()));
        let mut got = Vec::new();
        let mut small = [0u8; 4];
        for expected in [4, 4, 2] {
            let n = reader.read(&mut small).unwrap();
            assert_eq!(n, expected);
            got.extend_from_slice(&small[..n]);
        }
        assert_eq!(got, sent);
    }

    /// A dial that failed for a reason waiting cannot fix must not be retried:
    /// the second attempt would produce the same answer and a later error.
    #[test]
    fn the_retry_window_is_short_and_bounded() {
        assert_eq!(RETRY_DELAYS.len(), 3);
        assert!(RETRY_DELAYS.iter().sum::<Duration>() < Duration::from_secs(3));
        assert!(dial_budget() > CONNECT_TIMEOUT + HANDSHAKE_TIMEOUT);
    }
}
