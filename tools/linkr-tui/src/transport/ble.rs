//! Bluetooth Low Energy, speaking the Nordic UART Service.
//!
//! This is the link the product actually ships on: the Linkr Bee is an ESP32
//! that advertises one GATT profile and nothing else, and the bytes a user
//! types go down a single characteristic while the target's reply comes back
//! up another. There is no framing and no handshake on top — the radio is a
//! cable with a discoverable name, which is the entire point of the device.
//!
//! Two things about BLE shape this file more than the protocol does.
//!
//! **A radio needs a reactor, and the interface does not have one.** Every
//! GATT library worth using is async; `App` is a synchronous loop on a 250 ms
//! beat, deliberately, because half-drawn frames are worse than a late byte.
//! Rather than making the whole interface async — which would put every view,
//! every dialog and every test behind a runtime — the link builds its own
//! Tokio reactor on a thread of its own and meets the interface at a channel.
//! [`LinkReader::read`] is allowed to block, and it is called on a thread
//! dedicated to reading, so this costs nothing and changes nothing upstream.
//!
//! **Writes are sized, not streamed.** An ATT write is a single packet whose
//! size was agreed when the connection was made, and a payload longer than
//! that is refused rather than carried. So the write side segments every
//! payload into [`MTU_WRITE_LIMIT`] pieces. That number is deliberately
//! conservative: asking the stack for the negotiated MTU is possible, but an
//! answer that is wrong by a few bytes fails at every write rather than
//! nowhere, so a fixed ceiling we know fits is the safer default.

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Manager, Peripheral};
use futures::StreamExt;
use uuid::Uuid;

use super::{Link, LinkKind, LinkReader, LinkWriter};

/// The Nordic UART Service, and the two characteristics it is made of.
///
/// These are the numbers in every NUS implementation going; they are written
/// out in full rather than built from a 16-bit base because they are not
/// short form — there is no `0x0001` shortcut for this one — and a constant
/// that looks derived invites someone to "simplify" it.
pub const NUS_SERVICE: Uuid = Uuid::from_u128(0x6e400001_b5a3_f393_e0a9_e50e24dcca9e);
/// What this host writes: bytes going out to the target.
pub const NUS_RX: Uuid = Uuid::from_u128(0x6e400002_b5a3_f393_e0a9_e50e24dcca9e);
/// What this host subscribes to: bytes coming in from the target.
pub const NUS_TX: Uuid = Uuid::from_u128(0x6e400003_b5a3_f393_e0a9_e50e24dcca9e);

/// These five belong to the bridge's **management** service, and each is its
/// own characteristic rather than another byte inside Nordic UART.
///
/// That separation is the whole design. A management question — what firmware
/// is this, what speed is its UART running, has it joined a network — has to
/// be answered by the bridge *while the target keeps printing*, and an answer
/// delivered down the same pipe as the target's output could be told apart
/// from it only by guessing at the shape of the bytes. Guessing is exactly
/// what a log line containing `wifi=` would defeat. The reference client
/// (`tools/linkr_ble_terminal.py`) speaks to these same five.
pub const MGMT_SERVICE: Uuid = Uuid::from_u128(0x4c4b0001_9a7e_4f4e_8b8a_3d6f12a0c001);
/// Read: the negotiated protocol version, size limits and capability bits.
pub const MGMT_PROTOCOL: Uuid = Uuid::from_u128(0x4c4b0002_9a7e_4f4e_8b8a_3d6f12a0c001);
/// Read: this board's stable identifier.
pub const MGMT_DEVICE_ID: Uuid = Uuid::from_u128(0x4c4b0003_9a7e_4f4e_8b8a_3d6f12a0c001);
/// Write: one management request, framed as `protocol` encodes it.
pub const MGMT_COMMAND: Uuid = Uuid::from_u128(0x4c4b0004_9a7e_4f4e_8b8a_3d6f12a0c001);
/// Notify: the responses, as one `protocol::ManagementReassembler` stream.
pub const MGMT_RESPONSE: Uuid = Uuid::from_u128(0x4c4b0005_9a7e_4f4e_8b8a_3d6f12a0c001);

/// The advertised-name prefix used by firmware that predates per-device names.
///
/// Those units cannot be renamed, so their names are still `Linkr BLE UART`
/// (the original image) or `Linkr BLE UART-3` (later builds). They must remain
/// discoverable and diallable; the name is the only signal left on the oldest
/// NUS-only images, which do not carry the Management Service at all.
pub const LEGACY_NAME_PREFIX: &str = "Linkr BLE UART";

/// Whether a name belongs to the legacy Linkr BLE UART advertisement.
///
/// The comparison is case-insensitive and requires a boundary after the
/// prefix, so `Linkr BLE UART-3` and `Linkr BLE UART` match while an unrelated
/// `Linkr BLE UARTISH` does not. This is a compatibility path, not an identity:
/// devices that carry the Management Service are still verified through their
/// Device ID in [`wire`].
pub fn is_legacy_name(name: Option<&str>) -> bool {
    let Some(name) = name.map(str::trim) else {
        return false;
    };
    let Some(head) = name.get(..LEGACY_NAME_PREFIX.len()) else {
        return false;
    };
    if !head.eq_ignore_ascii_case(LEGACY_NAME_PREFIX) {
        return false;
    }
    name[LEGACY_NAME_PREFIX.len()..]
        .chars()
        .next()
        .is_none_or(|next| next == '-' || next == ' ')
}

/// Whether an advertisement describes a board this program can dial.
///
/// New firmware is recognised by the Linkr Management Service; [`wire`] then
/// reads the Device ID behind it before the link is accepted, so a device that
/// merely copied the UUID is still refused. NUS alone is shared with unrelated
/// UART bridges and is never enough.
///
/// Firmware from before the Management Service exists is the exception. It
/// advertised only NUS under a fixed `Linkr BLE UART...` name, so those names
/// remain a compatibility signal. That path only accepts the old prefix; a new
/// `Linkr Bee XXXX` name without the Management Service is not trusted.
pub fn is_board(services: &[Uuid], name: Option<&str>) -> bool {
    services.contains(&MGMT_SERVICE) || is_legacy_name(name)
}

/// The printable part of an advertised name.
///
/// Bluetooth names are arbitrary bytes on the air. A control character in a
/// terminal cell can move the cursor, clear the screen, or inject an escape
/// sequence, so the name is stripped of controls before it reaches the UI.
pub fn display_name(name: Option<&str>) -> Option<String> {
    let cleaned: String = name?
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

/// Whether a Device ID read from the management service belongs to Linkr Bee.
///
/// The first ten bytes are the fixed Linkr namespace (`LINKRBLE`, version 1);
/// the remaining six are the chip's hardware ID. Checking this is what makes
/// the service UUID a filter rather than a promise.
pub fn is_linkr_device_id(id: &[u8]) -> bool {
    const PREFIX: &[u8] = b"LINKRBLE\x01\x00";

    id.len() == 16 && id.starts_with(PREFIX)
}

/// Ceiling for one ATT write.
///
/// 250 is the largest attribute value BLE 4.2 can carry and 3 bytes of that
/// is write-command overhead. Every link the device opens negotiates at or
/// below 247, so 244 leaves room without ever asking. See the module note.
pub const MTU_WRITE_LIMIT: usize = 244;

/// A Bluetooth address is twelve hexadecimal digits, as in `EE:C7:42:34:48:CF`.
///
/// Twelve is a floor and not the expected length, because CoreBluetooth
/// answers with a UUID instead, which is longer — but anything shorter is not
/// an address. The check matters more than it looks: "not-an-address" contains
/// `a`, `d` and `e`, all of which are hexadecimal, so a rule that merely asked
/// "does this contain any digits at all" would accept it and spend ten
/// seconds scanning.
const ADDRESS_DIGITS: usize = 12;

/// How long to listen before deciding nothing is advertising.
///
/// Ten seconds is long enough to catch a device that advertises on a slow
/// interval — and these bridge firmwares do, to save power — and short enough
/// that "wrong board" is answered rather than waited out. The search ends the
/// moment a candidate answers, so this is a ceiling and not a delay: a board
/// in front of the user is dialled in the first second of it.
const SCAN_TIMEOUT: Duration = Duration::from_secs(10);

/// How often the adapter's results are looked at while listening.
///
/// BlueZ reports an advertisement as soon as it hears one, so a quarter of a
/// second is invisible to the user and kind to the radio.
const SCAN_POLL: Duration = Duration::from_millis(250);

/// How long `open` waits for the reactor to report one way or the other.
///
/// The reactor retries inside this window rather than the caller retrying the
/// link: the state of a failed attempt is known there, and the interface is
/// owed the real reason the moment there is one — not twenty seconds of
/// waiting for an answer that was never coming.
///
/// Sized to cover the worst dial the reactor will attempt — a scan that runs
/// out its window, one connect at its floor, and the moment the wiring needs
/// on top — written as the sum of those parts rather than as a number beside
/// them, so that a part which grows takes the window with it instead of
/// leaving a slow board looking like a missing one. A caller that would rather
/// wait less says `--connect-timeout`; a dial that outlives the window it was
/// given is hung up again rather than left on the radio.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(
    SCAN_TIMEOUT.as_secs() + DIAL_ATTEMPT.as_secs() + HANDSHAKE_ALLOWANCE.as_secs(),
);

/// The moment the wiring after a dial needs: discovering the characteristics
/// and turning the notifications on, once the link is up.
///
/// Reserved out of the caller's window before an attempt is given its own, so
/// that a connect which uses every second of its attempt still has this much
/// left to finish in — the difference between a link that comes up and a
/// caller that has already stopped waiting for it.
const HANDSHAKE_ALLOWANCE: Duration = Duration::from_secs(5);

/// How long one dial attempt may take before it counts as failed.
///
/// A floor, not a ceiling: a caller that named `--connect-timeout` raises it to
/// what it asked for, because a dial that gave up before its own window ran
/// out would answer "15 s" to a question about 40. Fifteen seconds and not
/// less, because a Windows connect builds a fresh GATT session every time
/// — WinRT keeps no service cache between sessions — and a first dial to a
/// board this machine has not seen this boot takes several of them; cutting at
/// eight read as a refusal on a board that was merely slow, while the host
/// tool this program replaces allowed for it.
const DIAL_ATTEMPT: Duration = Duration::from_secs(15);

/// The wall-clock budget every retry loop gets: three backoffs' worth.
const RETRY_BUDGET: Duration = Duration::from_millis(2250);

/// How long to wait between two attempts of the same operation.
const RETRY_BACKOFF: Duration = Duration::from_millis(750);

/// How often to look for a link somebody else is dialling, while a busy
/// answer says one is being dialled right now.
const RETRY_POLL: Duration = Duration::from_millis(250);

/// How long to give BlueZ to finish a disconnect before dialling again.
///
/// Asking for the disconnect is instant and being free of it is not: BlueZ
/// tears the link down on its own time, and a dial that starts inside that
/// window finds a device that is reported connected and cannot be wired. Two
/// and a half seconds is several times the teardown measured on a desktop
/// adapter, and it is only ever spent when a dial actually meets one.
const HANGUP_SETTLE: Duration = Duration::from_millis(2500);

/// How long a single BlueZ call may take before the adapter is called wedged.
///
/// Generous on purpose: a real GATT call completes in milliseconds, and only
/// an adapter that has stopped answering reaches this. A call that never
/// returned would hold the one reactor thread this link has forever, and a
/// link that is quietly wedged looks exactly like a board that went silent.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// How much data may be waiting to go out before the sender blocks.
///
/// Small on purpose. This channel is the only place write back-pressure can
/// be felt, and a deep one would let the interface queue a megabyte of typed
/// characters towards a device that has stopped listening.
const WRITE_BACKLOG: usize = 64;

/// Which device on the air to connect to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection {
    /// The first device advertising the Linkr Management Service. Right for a
    /// bench with one board on it, and the reason a desk with two is a
    /// problem to be named rather than guessed at.
    Any,
    /// Connect to the device whose advertised name contains this. Case is
    /// ignored, because names differ in it between firmware revisions of
    /// the same board.
    Name(String),
    /// Connect to the address printed by `bluetoothctl` as
    /// `EE:C7:42:34:48:CF`. Colons and case are ignored so a value copied
    /// out of a log works as it stands.
    Address(String),
}

impl Selection {
    /// Nothing filled in means "whichever one you find".
    pub fn any() -> Selection {
        Selection::Any
    }

    /// How the sidebar and the notices finish the sentence "ble:" with.
    pub fn label(&self) -> String {
        match self {
            Selection::Any => "find the nearest device".to_string(),
            Selection::Name(name) => name.clone(),
            Selection::Address(address) => address.to_ascii_uppercase(),
        }
    }

    /// Whether a device could ever be dialled with this.
    ///
    /// This is the cheap refusal, asked before anything touches BlueZ. It
    /// exists because an address that cannot be parsed must not be treated as
    /// "scan for ten seconds and find nothing" — that is indistinguishable
    /// from the board being switched off, which sends the user looking at the
    /// wrong thing.
    pub fn reachable(&self) -> Result<(), String> {
        match self {
            Selection::Address(address) => {
                let digits = normalise_address(address);
                if digits.len() < ADDRESS_DIGITS {
                    return Err(format!(
                        "“{address}” is not a Bluetooth address; those are twelve \
                         hexadecimal digits, as in EE:C7:42:34:48:CF"
                    ));
                }
                Ok(())
            }
            Selection::Name(name) if name.trim().is_empty() => Err(
                "a device was named by nothing — give --ble-name something to look for".to_string(),
            ),
            _ => Ok(()),
        }
    }

    /// Whether a candidate is the one being asked for.
    ///
    /// Split out from the async scan so the rules can be asserted without a
    /// radio. A device is named several ways depending on the platform — a
    /// BlueZ identifier is the MAC, a CoreBluetooth one is a UUID that says
    /// nothing about the address — so both are offered and any match counts.
    fn accepts(&self, name: Option<&str>, id: &str, address: Option<&str>) -> bool {
        match self {
            Selection::Any => true,
            Selection::Name(want) => {
                let want = want.to_ascii_lowercase();
                name.is_some_and(|found| found.to_ascii_lowercase().contains(&want))
            }
            Selection::Address(want) => {
                let want = normalise_address(want);
                // An empty filter would otherwise match every candidate and
                // silently dial whichever was seen first, which is how a typo
                // turns into a connection to the wrong board.
                if want.is_empty() {
                    return false;
                }
                normalise_address(id) == want
                    || address.is_some_and(|found| normalise_address(found) == want)
            }
        }
    }
}

/// An address reduced to what identifies it: the last twelve hexadecimal
/// digits, one case.
///
/// Kept as a function rather than done inline because it has to behave the
/// same on both sides of the comparison, and "the same" is easy to get wrong
/// once there are four call sites guessing about colons.
///
/// The *last* twelve and not all of them, because BlueZ names a device by the
/// path it keeps it under — `hci0/dev_FB_F6_91_14_33_3A` — and such a path
/// carries four digits of its own before the address (the `c0` in `hci0`, the
/// `de` in `dev_`). Reading from the end is what makes a path, a MAC, and a
/// shelf entry remembered from an older version all name the same board.
fn normalise_address(address: &str) -> String {
    let digits: String = address
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let start = digits.len().saturating_sub(ADDRESS_DIGITS);
    digits[start..].to_string()
}

/// Whether two ways of writing a device's address name the same device.
///
/// A device is written several ways — a MAC by the user, a path by BlueZ, a
/// UUID by CoreBluetooth — and one written down by an older version of this
/// program is a path where a MAC is expected now. Comparing what identifies
/// them is what lets the old spelling be recognised rather than quietly
/// dropped on the floor.
pub fn same_device(left: &str, right: &str) -> bool {
    let left = normalise_address(left);
    !left.is_empty() && left == normalise_address(right)
}

/// A device's address written the way people write MAC addresses:
/// `FB:F6:91:14:33:3A`.
///
/// BlueZ keeps a device under a path that ends in its address, and a shelf
/// written before this program kept addresses as MACs still holds one; a path
/// read out in the Device row names a device nobody can match against
/// anything. Anything that is not such a path — a MAC already, a UUID, a name
/// — keeps its own spelling, upper-cased like the rows are.
pub fn written_address(address: &str) -> String {
    match bluez_path_address(address) {
        Some(mac) => mac,
        None => address.to_ascii_uppercase(),
    }
}

/// `hci0/dev_FB_F6_91_14_33_3A` as `FB:F6:91:14:33:3A`. `None` for anything
/// that is not a BlueZ device path.
fn bluez_path_address(address: &str) -> Option<String> {
    let digits: String = address
        .rsplit('/')
        .next()?
        .strip_prefix("dev_")?
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if digits.len() != ADDRESS_DIGITS {
        return None;
    }
    Some(
        digits
            .as_bytes()
            .chunks(2)
            .map(|pair| String::from_utf8_lossy(pair).into_owned())
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// Split a payload into writes the bearer will accept.
///
/// An empty payload becomes no writes at all, which matters more than it
/// looks: a keep-alive that wrote a zero-length packet would be inventing
/// traffic the device never asked to see.
fn segment(payload: &[u8], limit: usize) -> Vec<Vec<u8>> {
    if payload.is_empty() || limit == 0 {
        return Vec::new();
    }
    payload.chunks(limit).map(|piece| piece.to_vec()).collect()
}

/// One thing the interface asks the radio to send.
///
/// Two variants rather than one, because management frames are not longer
/// keystrokes: they go to a different characteristic and the device answers
/// them on another. Keeping them apart here is what lets a bridge's answer
/// never be mistaken for the target's output — see the note above
/// [`MGMT_SERVICE`].
enum Frame {
    /// Characters typed into the target.
    Stream(Vec<u8>),
    /// A whole management request, already framed by `protocol`.
    Management(Vec<u8>),
    /// End the LE link itself. Nothing is written: the radio is asked to
    /// disconnect, which is what makes the board advertise again — a board
    /// left connected to a client that is gone is a board the next client
    /// cannot find.
    Hangup,
}

/// A BLE connection that has not been opened yet.
///
/// Nothing here touches the radio. Describing a connection has to be possible
/// with no adapter present — the command line builds one of these before it
/// has decided whether one can be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BleLink {
    selection: Selection,
    /// How long the whole dial may take. `None` is the radio's own patience,
    /// which is what an interface dial gets; a script that named
    /// `--connect-timeout` hands its own window down here.
    within: Option<Duration>,
}

impl BleLink {
    /// Look for `selection`. No radio is touched until [`Link::open`].
    pub fn new(selection: Selection) -> BleLink {
        BleLink {
            selection,
            within: None,
        }
    }

    /// Give the whole dial this much time at most.
    pub fn within(mut self, window: Option<Duration>) -> BleLink {
        self.within = window;
        self
    }

    /// Connect to whichever device turns up.
    pub fn discovering() -> BleLink {
        BleLink {
            selection: Selection::Any,
            within: None,
        }
    }

    /// Connect to a particular device, by name.
    pub fn named(name: impl Into<String>) -> BleLink {
        BleLink {
            selection: Selection::Name(name.into()),
            within: None,
        }
    }

    /// Connect to a particular device, by address.
    pub fn addressed(address: impl Into<String>) -> BleLink {
        BleLink {
            selection: Selection::Address(address.into()),
            within: None,
        }
    }

    /// The device this link is looking for.
    pub fn selection(&self) -> &Selection {
        &self.selection
    }
}

impl Link for BleLink {
    fn open(self: Box<Self>) -> io::Result<(Box<dyn LinkReader>, Box<dyn LinkWriter>)> {
        // Every channel here is synchronous except the outbound one, which has
        // to be a Tokio channel because the thing draining it lives in async
        // code. The bridge thread below meets those two halves.
        let (inbound_tx, inbound_rx) = mpsc::channel::<Option<Vec<u8>>>();
        let (outbound_tx, outbound_rx) = mpsc::channel::<Frame>();
        // Management responses ride here and nowhere else, so that the
        // interface can hand them to the pump as management and not as target
        // output. Their own channel, like their own characteristic.
        let (management_tx, management_rx) = mpsc::channel::<Vec<u8>>();
        let (ready_tx, ready_rx) = mpsc::channel::<io::Result<()>>();
        let (to_radio_tx, to_radio_rx) = tokio::sync::mpsc::channel::<Frame>(WRITE_BACKLOG);
        // What the board carries, shared between the reactor that finds out
        // and the writer that has to answer for it. See [`BleWriter`].
        let carries_management = Arc::new(AtomicBool::new(false));
        let found_by_the_reactor = Arc::clone(&carries_management);

        let selection = self.selection.clone();
        // Read before the thread starts, because the reactor needs it too: one
        // dial attempt is allowed to run for the whole window the caller named
        // (see `DIAL_ATTEMPT`), and a window that is only known to the half
        // that waits is a window the half that dials cannot honour.
        let window = self.within.unwrap_or(CONNECT_TIMEOUT);
        thread::spawn(move || {
            radio(
                &selection,
                window,
                ready_tx,
                inbound_tx,
                to_radio_rx,
                management_tx,
                found_by_the_reactor,
            );
        });
        // The bytes this interface writes out are handed across to the reactor
        // by their own thread, because the writer here is a synchronous one
        // sitting in `spawn_writer`'s loop and `blocking_send` may not be
        // called from inside a runtime — this thread is outside every runtime.
        thread::spawn(move || {
            while let Ok(bytes) = outbound_rx.recv() {
                if to_radio_tx.blocking_send(bytes).is_err() {
                    break;
                }
            }
        });

        // Open synchronously. `open` returning means "connected" everywhere
        // else in the product, and a link that reported itself open while the
        // stack was still turning over would have the interface painting
        // before there was anything to paint.
        match ready_rx.recv_timeout(window) {
            Err(why) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "the BLE link did not come up within {} s ({why})",
                    window.as_secs()
                ),
            )),
            Ok(Err(why)) => Err(why),
            Ok(Ok(())) => Ok((
                Box::new(BleReader {
                    inbound: inbound_rx,
                    management: Some(management_rx),
                    leftover: VecDeque::new(),
                    done: false,
                }),
                Box::new(BleWriter {
                    outbound: outbound_tx,
                    carries_management,
                }),
            )),
        }
    }

    fn kind(&self) -> LinkKind {
        LinkKind::Ble
    }

    fn describe(&self) -> String {
        format!("ble:{}", self.selection.label())
    }
}

/// The reactor thread: find, connect, subscribe, and then shuttle bytes until
/// something ends.
///
/// `window` is the caller's patience — the same one `open` waits on — and it
/// bounds the whole reaction rather than one piece of it: the scan is charged
/// against it, and the dial gets what is left rather than a fresh window of its
/// own. See [`dial_attempt`].
///
/// A format string rather than an error value, because the interesting
/// failures here are all of the "nothing like that on the air" shape and the
/// caller needs to say which nothing.
fn radio(
    selection: &Selection,
    window: Duration,
    ready: Sender<io::Result<()>>,
    inbound: Sender<Option<Vec<u8>>>,
    outbound: tokio::sync::mpsc::Receiver<Frame>,
    management: Sender<Vec<u8>>,
    carries_management: Arc<AtomicBool>,
) {
    // No attempt is worked out here: the window is the caller's, the clock on
    // it starts with the work below, and each dial asks for what is left of it
    // when it is about to run. See [`dial_attempt`].
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        // Every timer and every BlueZ socket the link uses wants one of these,
        // and there is nothing else on this runtime to fight with.
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(why) => {
            let _ = ready.send(Err(io::Error::other(format!(
                "the BLE runtime could not be started: {why}"
            ))));
            return;
        }
    };

    runtime.block_on(async move {
        // The caller's window, timed from here: every phase below is charged
        // against it, so that a scan and an attempt which each look within
        // their own rights add up to something the caller is still waiting for.
        let started = tokio::time::Instant::now();
        // Every failing path reports through `ready`: `open` is waiting on
        // exactly this channel, and a caller told "it took too long" when the
        // answer was "there is no board on the air" has been told nothing.
        let refuse = |why: String| {
            let _ = ready.send(Err(io::Error::other(why)));
        };
        let (peripheral, dialled_here) = match find(selection, window, started).await {
            Ok(found) => found,
            Err(why) => {
                refuse(why);
                return;
            }
        };
        let target = match peripheral
            .properties()
            .await
            .map_err(|why| format!("the device would not say what it is: {why}"))
        {
            Ok(properties) => properties
                .and_then(|p| p.local_name)
                .unwrap_or_else(|| "the device".to_string()),
            Err(why) => {
                refuse(why);
                return;
            }
        };

        // Joining a link that is already up is an optimization, and it has one
        // failure shape: BlueZ reports a device as connected for a second or
        // two after the client that dialled it asked to hang up, and a session
        // built on that remaining link cannot subscribe — the CCCD write lands
        // on a connection BlueZ is in the middle of taking down. So a *joined*
        // link that will not wire is cleared, waited out, and dialled for real
        // once. A link this dial made keeps its own refusal, which is about the
        // device rather than about what the last session left behind.
        let mut dialled_here = dialled_here;
        let mut wired = wire(&peripheral).await;
        if wired.is_err() && !dialled_here {
            let _ = peripheral.disconnect().await;
            wait_until_down(&peripheral).await;
            match dial(&peripheral, dial_attempt(window, started.elapsed())).await {
                Ok(made) => {
                    dialled_here = made;
                    wired = wire(&peripheral).await;
                }
                Err(why) => {
                    refuse(why);
                    return;
                }
            }
        }
        if let Err(why) = wired {
            // A refused link is still an up link as far as BlueZ is concerned,
            // and hanging it up is only ours to do when the dial was: a link
            // another client brought up has that client's session running
            // over it.
            if dialled_here {
                let _ = peripheral.disconnect().await;
            }
            refuse(format!(
                "connected to {target} but the link was refused: {why}"
            ));
            return;
        }
        // What the board carries, told to the writer before the caller can use
        // the link: a management frame queued for a board with no management
        // characteristic is a request nothing will ever answer, and the caller
        // is owed "this link has no management channel" rather than silence.
        // The wiring above has already discovered the characteristics, so this
        // is a lookup rather than a second round trip.
        carries_management.store(
            peripheral
                .characteristics()
                .iter()
                .any(|characteristic| characteristic.uuid == MGMT_COMMAND),
            Ordering::Release,
        );
        // Reported only once the subscription is live. A read that succeeds
        // and a notify that never arrives looks exactly like a dead target,
        // so "connected" means bytes can already flow both ways.
        if ready.send(Ok(())).is_err() {
            // The caller gave up (or went away) while this dial was still
            // working, so there is no reader for the bytes below and a link
            // left open is a radio the next dial has to fight for. Hanging it
            // up is ours to do only when the dial was.
            if dialled_here {
                let _ = peripheral.disconnect().await;
            }
            return;
        }
        carry(&peripheral, &inbound, outbound, &management).await;
        // The one signal that means "stop reading" to whoever is waiting on
        // us, sent once the loop above has decided the device went away.
        let _ = inbound.send(None);
    });

    // Kept alive to the last line so the connection outlives the loop that
    // used it; `runtime` dropping here is what hangs up anything the device
    // still has open.
    drop(runtime);
}

/// Dial the board, the way a bench with two clients needs it dialled.
///
/// * a link that is already up — from an earlier attempt, or because a second
///   client got there first — is joined instead of dialled again;
/// * `In Progress` means another client is dialling *right now*, and our own
///   `Connect` is exactly what makes BlueZ cancel theirs, so the loop stops
///   asking and watches for their link instead;
/// * a transient `br-connection-*` answer means our own attempt died with
///   nothing up, so the leftovers are cleared and it is tried again within
///   the budget;
/// * everything else is the answer, kept whole and worded by [`dial_error`].
///
/// An attempt that did not come up asks for a disconnect before it is given
/// up on. A `Connect` BlueZ is still running towards a board that is not there
/// keeps the adapter busy on its own account — the call outlives the caller's
/// patience by minutes, and the *next* session's connect then fails with
/// `In Progress` for two minutes over a board that is perfectly healthy. The
/// busy answer is the one case that must not: there the pending operation is
/// another client's dial, and cancelling it is exactly what this call just
/// learned not to do.
///
/// `Ok(true)` when this call dialled the link, `Ok(false)` when it joined one
/// that was already up: the difference is who may hang it up again.
async fn dial(peripheral: &Peripheral, attempt: Duration) -> Result<bool, String> {
    let deadline = tokio::time::Instant::now() + RETRY_BUDGET;
    loop {
        if is_up(peripheral).await {
            return Ok(false);
        }
        let error = match peripheral.connect_with_timeout(attempt).await {
            Ok(()) => return Ok(true),
            Err(error) => error,
        };
        let text = error.to_string();
        if is_busy(&text) {
            while tokio::time::Instant::now() < deadline {
                tokio::time::sleep(RETRY_POLL).await;
                if is_up(peripheral).await {
                    return Ok(false);
                }
            }
            return Err(dial_error(&text));
        }
        // Best effort, and deliberately after the busy case: nothing was up,
        // so what is still pending here is our own attempt's remains.
        let _ = peripheral.disconnect().await;
        if is_transient(&text) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(RETRY_BACKOFF).await;
            continue;
        }
        return Err(dial_error(&text));
    }
}

/// `true` when BlueZ already reports a link — whether this session dialled it
/// or another client did.
async fn is_up(peripheral: &Peripheral) -> bool {
    peripheral.is_connected().await.unwrap_or(false)
}

/// Wait for BlueZ to agree that the link is down, or for [`HANGUP_SETTLE`] to
/// run out.
///
/// Asking for a disconnect is not the same as the device being free again: the
/// property turns at the end of a teardown BlueZ runs on its own time, and a
/// dial that starts inside that window finds a link that is up and unusable.
async fn wait_until_down(peripheral: &Peripheral) {
    let deadline = tokio::time::Instant::now() + HANGUP_SETTLE;
    while is_up(peripheral).await && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(RETRY_POLL).await;
    }
}

/// A failed dial as a sentence: the two answers that have an action in them
/// name the action, and every other failure keeps its own words behind the
/// one thing this function knows and the failure does not — that the question
/// was "connect".
fn dial_error(text: &str) -> String {
    if is_busy(text) {
        format!(
            "the Bluetooth adapter is busy: {text} — another scan or connection is \
             still running; retry in a second"
        )
    } else if is_transient(text) {
        format!(
            "the BLE link dropped mid-dial: {text} — the board or another client let \
             go of the connection; retry in a second"
        )
    } else if is_timeout(text) {
        // The adapter itself is the thing to warn about here: BlueZ keeps a
        // connect that nobody is waiting for any more, and the next dial made
        // against it is refused with `In Progress` until it comes back. The
        // disconnect this module asks for on the way out is what shortens
        // that, but it is a request rather than a guarantee — a phone that
        // walked away mid-connect can leave the adapter holding the attempt.
        format!(
            "the board did not answer in time: {text} — if the next attempt says the \
             adapter is busy, give it a minute before trying again"
        )
    } else {
        format!("the connection was refused: {text}")
    }
}

/// How long one dial attempt gets: what is left of the caller's window, less
/// the moment the wiring needs — never less than [`DIAL_ATTEMPT`], because a
/// cold adapter needs its own moment whatever was asked for.
///
/// A floor above what is left is deliberate: the caller's timer is the
/// caller's, and a link that comes up to nobody is hung up again rather than
/// left on the radio. What the floor must not do is *add* a fresh window to
/// the one the caller named, which is why the scanner's own time is passed in
/// and charged against it — a scan that ate ten seconds of a thirty-second
/// window leaves twenty for the dial, not thirty.
fn dial_attempt(window: Duration, spent: Duration) -> Duration {
    window
        .saturating_sub(spent)
        .saturating_sub(HANDSHAKE_ALLOWANCE)
        .max(DIAL_ATTEMPT)
}

/// Whether the dial gave up waiting rather than being refused.
///
/// btleplug reports this in its own words (`Timed out after 15s`), and BlueZ in
/// its (`br-connection-timeout`); the second is caught by [`is_transient`]
/// first, which is why this is asked only after that.
fn is_timeout(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.contains("timed out") || text.contains("timeout")
}

/// `true` when BlueZ is saying somebody else owns the adapter: another scan or
/// connection is already running. The D-Bus message is `In Progress`, the
/// error name is `org.bluez.Error.InProgress`, and both have been seen in more
/// than one casing.
fn is_busy(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    lowered.contains("in progress") || lowered.contains("inprogress")
}

/// BlueZ's transient `Connect` answers: the attempt died before any link came
/// up — another client won the race, the controller gave up, or the board
/// stopped answering mid-handshake. Nothing succeeded, so starting over is
/// safe. The permanent refusals (`br-connection-rej-security`,
/// `br-connection-params-rejected`, …) are deliberately not here.
fn is_transient(text: &str) -> bool {
    const TRANSIENT: [&str; 5] = [
        "br-connection-canceled",
        "br-connection-timeout",
        "br-connection-failed",
        "br-connection-adv-timeout",
        "Not connected",
    ];
    TRANSIENT.iter().any(|needle| text.contains(needle))
}

/// Run `operation` again while BlueZ reports it busy and the budget lasts; the
/// last failure is handed up as text when it is not.
///
/// Only `In Progress` is retried, and only because it is the failure where the
/// operation demonstrably did **not** happen: BlueZ never started it, a second
/// client holds the adapter — a second `bee`, a phone app, or a session of
/// ours that never tore down. Everything else keeps its own words.
///
/// Each attempt is bounded by [`CALL_TIMEOUT`]; a timeout is never retried,
/// because the operation may have half landed and is reported instead.
pub(crate) async fn retry_busy<T, F, Fut>(mut operation: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, btleplug::Error>>,
{
    let deadline = tokio::time::Instant::now() + RETRY_BUDGET;
    loop {
        match tokio::time::timeout(CALL_TIMEOUT, operation()).await {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(error))
                if is_busy(&error.to_string()) && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(RETRY_BACKOFF).await;
            }
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_elapsed) => {
                return Err(format!(
                    "a Bluetooth call did not answer within {} s",
                    CALL_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

/// The radio's attention: discovery is running, and everything the adapter's
/// event stream says until [`stop`](Self::stop) was heard on the air just now.
///
/// BlueZ remembers every device it has ever met, and a board switched off a
/// week ago is still in that memory; reading the memory back is what a scan
/// must not mistake for a board being there. Hearing is the evidence — an
/// advertisement reported while discovery runs — and two things make that
/// evidence trustworthy, both settled here.
///
/// The stream itself opens with a replay of everything the daemon already
/// knows. That is the caller's to drain before discovery starts; the scan in
/// `cli::listen` is the one place the two halves meet.
///
/// And on Linux the scan is started by [`linux`] rather than by `btleplug`:
/// `btleplug` asks for a discovery with no RSSI field in its filter, and under
/// such a filter the daemon reports a device's signal only once it has moved
/// by 8 dBm. A board sitting on the bench says nothing for as long as it stays
/// put, which is indistinguishable from a board that is switched off. A filter
/// with the weakest reading in it turns every advertisement into a signal
/// update — the only per-advertisement signal the D-Bus API offers — and that
/// is what is asked for.
pub struct Listening {
    adapter: btleplug::platform::Adapter,
    /// Discovery started in a session of this program's own, when the daemon
    /// took the filter — see [`linux`].
    #[cfg(target_os = "linux")]
    own: Option<linux::Started>,
}

impl Listening {
    /// Start listening. The radio keeps listening until [`stop`](Self::stop).
    pub async fn begin(adapter: &btleplug::platform::Adapter) -> Result<Self, String> {
        #[cfg(target_os = "linux")]
        if let Some(own) = linux::start(adapter).await {
            return Ok(Self {
                adapter: adapter.clone(),
                own: Some(own),
            });
        }
        // A second client holding the adapter answers `In Progress`; the
        // retry gives it a moment to let go instead of failing a scan the
        // user just asked for.
        retry_busy(|| async { adapter.start_scan(ScanFilter::default()).await })
            .await
            .map_err(|why| format!("the scan would not start: {why}"))?;
        Ok(Self {
            adapter: adapter.clone(),
            #[cfg(target_os = "linux")]
            own: None,
        })
    }

    /// Stop listening; nothing more will be heard.
    pub async fn stop(&self) {
        #[cfg(target_os = "linux")]
        if let Some(own) = &self.own {
            own.stop().await;
            return;
        }
        let _ = self.adapter.stop_scan().await;
    }
}

/// A scan started through `bluetoothd` itself, for the one thing `btleplug`
/// does not ask for.
///
/// Everything here is about one field of one D-Bus call: the RSSI reading in
/// the discovery filter. It is what makes the daemon report every
/// advertisement (see [`Listening`]), and it is set from a session of this
/// program's own because a discovery filter belongs to the client that starts
/// the discovery — `btleplug` only ever sets its own.
#[cfg(target_os = "linux")]
mod linux {
    use bluez_async::{AdapterId, BluetoothSession, DiscoveryFilter, Transport};
    use btleplug::api::Central as _;

    /// The weakest reading the daemon accepts in a filter — it takes -127 to
    /// +20 — so a reading that filters nothing out and is still a reading.
    const EVERYTHING: i16 = -127;

    /// A discovery this program started, and the session keeping it alive.
    pub(super) struct Started {
        session: BluetoothSession,
        adapter: AdapterId,
    }

    /// Start discovery with every advertisement reported, or `None` when the
    /// daemon would not take the filter — the caller then falls back to
    /// `btleplug`'s own scan, which hears less but hears.
    pub(super) async fn start(adapter: &btleplug::platform::Adapter) -> Option<Started> {
        // The adapter `btleplug` is on, found again by address: two clients
        // list adapters the same way, but the address is the one thing that
        // cannot be argued with.
        let address = adapter.adapter_address().await.ok().flatten()?;
        let (_, session) = BluetoothSession::new().await.ok()?;
        let found = session
            .get_adapters()
            .await
            .ok()?
            .into_iter()
            .find(|info| {
                info.mac_address
                    .to_string()
                    .eq_ignore_ascii_case(&address.to_string())
            })?;
        let filter = DiscoveryFilter {
            rssi_threshold: Some(EVERYTHING),
            duplicate_data: Some(true),
            transport: Some(Transport::Auto),
            ..Default::default()
        };
        session
            .start_discovery_on_adapter_with_filter(&found.id, &filter)
            .await
            .ok()?;
        Some(Started {
            session,
            adapter: found.id,
        })
    }

    impl Started {
        /// Stop the discovery this session started. Dropping the session
        /// without this would end it too — the daemon cleans up after a client
        /// that hangs up — but a scan that ends when it said it would is
        /// easier to reason about.
        pub(super) async fn stop(&self) {
            let _ = self.session.stop_discovery_on_adapter(&self.adapter).await;
        }
    }
}

/// Scan for `selection` and connect to it, reporting whether the dial was
/// this session's own — see [`dial`].
///
/// `started` is when the caller's window began: the scan is charged against
/// that window, and the attempt gets what is left of it rather than a fresh
/// window of its own. See [`dial_attempt`].
async fn find(
    selection: &Selection,
    window: Duration,
    started: tokio::time::Instant,
) -> Result<(Peripheral, bool), String> {
    let manager = Manager::new()
        .await
        .map_err(|why| format!("no Bluetooth manager could be opened: {why}"))?;
    let adapters = manager
        .adapters()
        .await
        .map_err(|why| format!("no Bluetooth adapter could be listed: {why}"))?;
    let adapter = adapters.into_iter().next().ok_or_else(|| {
        "this machine has no Bluetooth adapter — one is needed to reach the \
         board, so try --transport serial or --bridge"
            .to_string()
    })?;

    // Whatever BlueZ already knows answers first: a board the system has seen
    // — by the startup scan, by an earlier session — needs no listening to be
    // dialled, and this is what makes a remembered address feel instant.
    let mut chosen = pick(&adapter, selection).await?;
    if chosen.is_none() {
        // Then the scan, which ends the moment the board answers rather than
        // at the end of a fixed window: waiting ten seconds for an answer
        // that arrived in the first one is ten seconds of the user watching a
        // screen that says "connecting".
        retry_busy(|| async { adapter.start_scan(ScanFilter::default()).await })
            .await
            .map_err(|why| format!("the scan would not start: {why}"))?;
        let deadline = tokio::time::Instant::now() + SCAN_TIMEOUT;
        loop {
            chosen = pick(&adapter, selection).await?;
            if chosen.is_some() || tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(SCAN_POLL).await;
        }
        let _ = adapter.stop_scan().await;
    }

    let chosen = match chosen {
        Some(chosen) => chosen,
        None => {
            let mut message = match selection {
                Selection::Any => "no board was found within {} s — is the board powered?"
                    .replace("{}", &SCAN_TIMEOUT.as_secs().to_string()),
                // The name is a label the owner can change, so a name that
                // matches nothing is a board that was renamed, not a board
                // that is missing.
                Selection::Name(name) => format!(
                    "no board named “{name}” was found — the advertised name is a label that can be changed, so a renamed board is dialled by its address (--ble-address)"
                ),
                Selection::Address(address) => {
                    format!("no board at {address} was found")
                }
            };
            // "Dial it by address" is only useful if the addresses heard are
            // on screen; a scan already paid for them.
            if matches!(selection, Selection::Name(_)) {
                let heard = heard_boards(&adapter).await;
                if !heard.is_empty() {
                    message.push_str("\nheard nearby: ");
                    message.push_str(&heard.join(", "));
                }
            }
            return Err(message);
        }
    };

    let dialled_here = dial(&chosen, dial_attempt(window, started.elapsed())).await?;
    Ok((chosen, dialled_here))
}

/// The boards the adapter has heard, as `name (address)`, for a message whose
/// next step is "dial one of these by address". At most six, like the scan
/// picker: a list longer than the screen is not an answer.
async fn heard_boards(adapter: &btleplug::platform::Adapter) -> Vec<String> {
    let Ok(peripherals) = adapter.peripherals().await else {
        return Vec::new();
    };
    let mut heard = Vec::new();
    for peripheral in peripherals {
        let Ok(Some(properties)) = peripheral.properties().await else {
            continue;
        };
        if !is_board(&properties.services, properties.local_name.as_deref()) {
            continue;
        }
        let name = display_name(properties.local_name.as_deref())
            .unwrap_or_else(|| "Linkr Bee".to_string());
        heard.push(format!("{name} ({})", peripheral.address()));
    }
    heard.sort();
    heard.truncate(6);
    heard
}

/// The first device that is a board this interface can talk to — see
/// [`is_board`] — and that `selection` accepts, or `None` while nobody like
/// that has answered yet.
///
/// The check is here and not in the scan's filter on purpose: a filtered scan
/// only hears devices whose advertisement names the filter's UUIDs, and a
/// board whose advertisement is (or reads as) partial is still a board this
/// bridge can dial. A device named by *address* is the exception, and is
/// dialled on BlueZ's word alone: a bonded board that is not advertising right
/// now has no UUIDs to check, and the characteristic check that matters happens
/// once the link is up (`wire`).
async fn pick(
    adapter: &btleplug::platform::Adapter,
    selection: &Selection,
) -> Result<Option<Peripheral>, String> {
    let candidates = adapter
        .peripherals()
        .await
        .map_err(|why| format!("the scan's results could not be read: {why}"))?;
    for candidate in candidates {
        // Reading properties can fail for a device that has just moved out of
        // range; that is not interesting and must not end the search.
        let Ok(Some(properties)) = candidate.properties().await else {
            continue;
        };
        let looks_like_a_board = is_board(&properties.services, properties.local_name.as_deref());
        let wanted = selection.accepts(
            properties.local_name.as_deref(),
            &candidate.id().to_string(),
            // BlueZ's identifier is a D-Bus path (`hci0/dev_EE_…`) while the
            // user names the board by its address, so the address property is
            // offered as well and either match counts.
            Some(&properties.address.to_string()),
        );
        let named_by_address = matches!(selection, Selection::Address(_));
        if wanted && (looks_like_a_board || named_by_address) {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// The identity gate that runs before the terminal is wired.
///
/// A device that advertises the Management Service must answer with the Linkr
/// Device ID namespace; a device without it is accepted only under the fixed
/// legacy NUS name. The checks take plain values instead of a `Peripheral` so
/// they can be exercised without a radio.
fn check_identity(
    has_management: bool,
    characteristics: &[Uuid],
    device_id: Option<&[u8]>,
    local_name: Option<&str>,
) -> Result<(), String> {
    if has_management {
        if !characteristics.contains(&MGMT_DEVICE_ID) {
            return Err(
                "the Linkr Management service does not expose a Device ID characteristic"
                    .to_string(),
            );
        }
        let id = device_id.ok_or_else(|| "the Linkr Device ID could not be read".to_string())?;
        if !is_linkr_device_id(id) {
            return Err(
                "the device's Device ID does not belong to the Linkr Bee namespace — refusing it"
                    .to_string(),
            );
        }
    } else if !is_legacy_name(local_name) {
        return Err(
            "the device does not offer the Linkr Management service and does not use the \
             legacy Linkr BLE UART name — it is not a Linkr Bee"
                .to_string(),
        );
    }
    Ok(())
}

/// Discover the service and subscribe to the characteristic that carries the
/// target's output.
async fn wire(peripheral: &Peripheral) -> Result<(), String> {
    retry_busy(|| async { peripheral.discover_services().await })
        .await
        .map_err(|why| format!("the services could not be enumerated: {why}"))?;

    let has_management = peripheral
        .services()
        .iter()
        .any(|service| service.uuid == MGMT_SERVICE);
    let characteristics = peripheral.characteristics();
    let characteristic_uuids: Vec<Uuid> = characteristics
        .iter()
        .map(|characteristic| characteristic.uuid)
        .collect();

    if has_management {
        let device_id = characteristics
            .iter()
            .find(|characteristic| characteristic.uuid == MGMT_DEVICE_ID)
            .ok_or_else(|| {
                "the Linkr Management service does not expose a Device ID characteristic"
                    .to_string()
            })?;
        // The characteristic is read-encrypted. BlueZ and WinRT negotiate the
        // bond as part of the read; a refusal is a refused link, not a device
        // that can be treated as a board by name alone.
        let id = retry_busy(|| async { peripheral.read(device_id).await })
            .await
            .map_err(|why| format!("the Linkr Device ID could not be read: {why}"))?;
        check_identity(true, &characteristic_uuids, Some(&id), None)?;
    } else {
        // Pre-Management-Service firmware is a terminal-only bridge. It never
        // had the Device ID to read, so its fixed legacy name is the only
        // signal available. Do not accept a new `Linkr Bee XXXX` name here:
        // that firmware always advertises the Management Service, and a
        // missing service on such a name is evidence of an impostor.
        let properties = retry_busy(|| async { peripheral.properties().await })
            .await
            .map_err(|why| format!("the device could not be identified: {why}"))?;
        let name = properties
            .as_ref()
            .and_then(|properties| properties.local_name.as_deref());
        check_identity(false, &characteristic_uuids, None, name)?;
    }

    for wanted in [NUS_TX, NUS_RX] {
        // Checked for both, because a firmware that advertises NUS but does
        // not lay out the standard characteristics is a real thing, and it is
        // better to say which end is missing than to fail on the first write.
        if !characteristics.iter().any(|c| c.uuid == wanted) {
            return Err(format!(
                "the device does not offer the Nordic UART characteristic {wanted}"
            ));
        }
    }
    let out = characteristics
        .iter()
        .find(|c| c.uuid == NUS_TX)
        .ok_or_else(|| "the notify characteristic vanished".to_string())?;
    retry_busy(|| async { peripheral.subscribe(out).await })
        .await
        .map_err(|why| format!("notify could not be subscribed to: {why}"))?;

    // The management service is optional and *must stay* optional: a bridge
    // without it is a bridge that can still carry a terminal, and refusing to
    // connect to one because it cannot answer `@i?` would turn a firmware
    // that predates the service into "the board is broken".
    if characteristics.iter().any(|c| c.uuid == MGMT_RESPONSE) {
        let responses = characteristics
            .iter()
            .find(|c| c.uuid == MGMT_RESPONSE)
            .ok_or_else(|| "the management notify characteristic vanished".to_string())?;
        retry_busy(|| async { peripheral.subscribe(responses).await })
            .await
            .map_err(|why| format!("the management channel could not be subscribed to: {why}"))?;
    }
    Ok(())
}

/// The first of a run of identical management notifications, and nothing of
/// the rest.
///
/// BlueZ re-broadcasts one GATT notification once per outstanding notify
/// session on the characteristic, so a client sees the same value several
/// times in a row whenever sessions from earlier clients have not been
/// cleaned up — and it kept happening, the count climbing from three to four
/// as more clients came and went. The radio sends each one once (checked on
/// the air with `btmon`: one indication, one confirmation), so the repeats
/// are the daemon's alone; passing them on turns one scan result into four
/// rows and one ending into several orphans.
///
/// The comparison is against the *immediately* previous notification rather
/// than a set of seen ones: what arrives is runs of repeats, and a value that
/// legitimately comes back later — a state that is published twice — is not
/// this function's to swallow. Terminal bytes never come through here, so
/// nothing a user types is ever suppressed.
fn keep_once(last: &mut Option<Vec<u8>>, value: Vec<u8>) -> Option<Vec<u8>> {
    if last.as_deref() == Some(value.as_slice()) {
        return None;
    }
    *last = Some(value.clone());
    Some(value)
}

/// Move bytes in both directions until one of them stops.
async fn carry(
    peripheral: &Peripheral,
    inbound: &Sender<Option<Vec<u8>>>,
    mut outbound: tokio::sync::mpsc::Receiver<Frame>,
    management: &Sender<Vec<u8>>,
) {
    let characteristics = peripheral.characteristics();
    let sink = characteristics.iter().find(|c| c.uuid == NUS_RX).cloned();
    let command = characteristics
        .iter()
        .find(|c| c.uuid == MGMT_COMMAND)
        .cloned();
    let Ok(mut notifications) = peripheral.notifications().await else {
        return;
    };
    // The last management notification, so its repeats can be told apart.
    // See `keep_once`.
    let mut last_response: Option<Vec<u8>> = None;

    loop {
        tokio::select! {
            notification = notifications.next() => {
                match notification {
                    Some(notification) => {
                        if notification.value.is_empty() {
                            continue;
                        }
                        // Two notify characteristics now feed this loop, and
                        // which one a packet came in on is the only reliable
                        // way to know what it is: both carry plain bytes and
                        // neither carries a hint. Sending a management
                        // response down the target's stream would type the
                        // bridge's answer into somebody's shell prompt.
                        if notification.uuid == MGMT_RESPONSE {
                            if let Some(bytes) = keep_once(&mut last_response, notification.value) {
                                if management.send(bytes).is_err() {
                                    return;
                                }
                            }
                        } else if notification.uuid == NUS_TX
                            && inbound.send(Some(notification.value)).is_err()
                        {
                            return;
                        }
                    }
                    // The stream ending is the device going away.
                    None => return,
                }
            }
            frame = outbound.recv() => {
                match frame {
                    Some(Frame::Stream(bytes)) => {
                        let Some(sink) = sink.as_ref() else { continue };
                        for piece in segment(&bytes, MTU_WRITE_LIMIT) {
                            // Without response is the throughput choice: NUS is
                            // handed to the Link Layer with whatever credit it
                            // has, and waiting for an acknowledgement per packet
                            // would cap the link well under the radio's rate.
                            // Busy retries stand in for the acknowledgement:
                            // an `In Progress` chunk is one BlueZ never sent.
                            if retry_busy(|| async {
                                peripheral
                                    .write(sink, &piece, WriteType::WithoutResponse)
                                    .await
                            })
                            .await
                            .is_err()
                            {
                                return;
                            }
                        }
                    }
                    // With response, unlike the stream above. A management
                    // request asks something worth waiting for and its answer
                    // is worth losing nothing of; there are a handful of these
                    // per session and none on the path a keystroke takes.
                    Some(Frame::Management(frame)) => {
                        let Some(command) = command.as_ref() else { continue };
                        for piece in segment(&frame, MTU_WRITE_LIMIT) {
                            if retry_busy(|| async {
                                peripheral
                                    .write(command, &piece, WriteType::WithResponse)
                                    .await
                            })
                            .await
                            .is_err()
                            {
                                return;
                            }
                        }
                    }
                    // The sender dropping is the interface closing the link.
                    None => return,
                    // Asked to end it: the disconnect is the answer, so it is
                    // made before the loop leaves. Best effort — a link the
                    // device has already dropped is a link that is already
                    // hung up, which is the state we wanted.
                    Some(Frame::Hangup) => {
                        let _ = peripheral.disconnect().await;
                        return;
                    }
                }
            }
        }
    }
}

/// Bytes from the device, in order.
struct BleReader {
    inbound: Receiver<Option<Vec<u8>>>,
    /// Responses from the bridge's management channel, until [`Self::
    /// side_channel`] takes them over. `Option` because that happens exactly
    /// once and must not be able to happen twice.
    management: Option<Receiver<Vec<u8>>>,
    /// What a notification that did not fit in the caller's buffer left over.
    leftover: VecDeque<u8>,
    done: bool,
}

impl LinkReader for BleReader {
    /// Management responses are not target output, so they leave by the side
    /// channel rather than by [`Self::read`].
    ///
    /// The forwarding thread exists because the radio speaks in Tokio time and
    /// this reader is read synchronously on a thread of its own: merging the
    /// two would mean polling for management bytes inside `read`, and a
    /// `read` that returns early looking for them would look exactly like a
    /// link that hung up.
    fn side_channel(&mut self, events: Sender<super::LinkEvent>) {
        let Some(management) = self.management.take() else {
            return;
        };
        thread::spawn(move || {
            while let Ok(bytes) = management.recv() {
                if events.send(super::LinkEvent::Management(bytes)).is_err() {
                    return;
                }
            }
        });
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done {
            return Ok(0);
        }
        // Drained first: the previous notification may have been longer than
        // the caller's buffer, and those bytes were promised before any later
        // ones were received.
        while self.leftover.is_empty() {
            match self.inbound.recv() {
                Ok(Some(bytes)) => self.leftover.extend(bytes),
                // `None` is the radio saying the device went away; a
                // disconnected channel means the loop already gave up. Either
                // way this is a clean end of stream, not an error.
                Ok(None) | Err(_) => {
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
}

/// Bytes towards the device.
struct BleWriter {
    outbound: Sender<Frame>,
    /// Whether the board carries the management characteristic, as the reactor
    /// found it. The queue cannot know what the board has, so the fact is
    /// written down where the reactor looked and read by the writer that has to
    /// answer for it — see [`LinkWriter::write_management`].
    carries_management: Arc<AtomicBool>,
}

impl LinkWriter for BleWriter {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        self.outbound
            .send(Frame::Stream(buf.to_vec()))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the BLE link is no longer up"))
    }

    /// End the LE link out loud: the radio disconnects, the board advertises
    /// again, and the next client — phone, tablet or another bench — can find
    /// it without waiting for a supervision timeout to guess we are gone.
    fn hangup(&mut self) -> io::Result<()> {
        self.outbound
            .send(Frame::Hangup)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the BLE link is no longer up"))
    }

    /// Queue a management frame for the bridge.
    ///
    /// Framing belongs to `protocol`, not here: this knows only which
    /// characteristic the bytes go to, which is the one piece of the answer a
    /// bearer cannot get from anywhere else.
    fn write_management(&mut self, frame: &[u8]) -> io::Result<()> {
        // A board without the characteristic would take the frame into the
        // queue and drop it in the reactor, which reads to the caller as a
        // bridge that never answered. The link does not carry it, and that is
        // the answer — the same one a bearer with no management channel at all
        // gives.
        if !self.carries_management.load(Ordering::Acquire) {
            return Err(io::Error::other("this link has no management channel"));
        }
        self.outbound
            .send(Frame::Management(frame.to_vec()))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the BLE link is no longer up"))
    }

    fn flush(&mut self) -> io::Result<()> {
        // Nothing is buffered here: each write goes straight to the radio, and
        // pretending otherwise would let a caller believe its bytes were held
        // when in fact they have already gone out.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The characteristics are named after their direction from the device's
    /// point of view, which is backwards from this host's, and getting it
    /// backwards is the single most likely bug in this module. Asserted here
    /// against the strings every NUS implementation publishes.
    #[test]
    fn the_uuids_are_the_nordic_ones() {
        assert_eq!(
            NUS_SERVICE.to_string(),
            "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
        );
        assert_eq!(NUS_RX.to_string(), "6e400002-b5a3-f393-e0a9-e50e24dcca9e");
        assert_eq!(NUS_TX.to_string(), "6e400003-b5a3-f393-e0a9-e50e24dcca9e");
    }

    /// "Any" is how a single board on a bench is dialled, and it has to accept
    /// even a device that told us nothing about itself.
    #[test]
    fn any_accepts_the_first_nus_device_whatever_it_is_called() {
        let any = Selection::any();
        assert!(any.accepts(Some("Linkr BLE UART-3"), "EE:C7:42:34:48:CF", None));
        assert!(any.accepts(None, "some-platform-uuid", None));
    }

    /// Names are matched on a substring ignoring case, because the same board
    /// advertises `Linkr BLE UART-3` in one firmware and something else in
    /// another, and the user types the part they recognise.
    #[test]
    fn a_name_matches_a_fragment_in_any_case() {
        let by_name = Selection::Name("linkr".to_string());
        assert!(by_name.accepts(Some("Linkr BLE UART-3"), "EE:C7:42:34:48:CF", None));
        assert!(!by_name.accepts(Some("Some Other Device"), "EE:C7:42:34:48:CF", None));
        // No name advertised at all cannot match a name asked for.
        assert!(!by_name.accepts(None, "EE:C7:42:34:48:CF", None));
    }

    /// An address is either the BlueZ identifier or the advertised address,
    /// and either spelling of it must work.
    #[test]
    fn an_address_matches_either_way_the_platform_reports_it() {
        let by_address = Selection::Address("ee:c7:42:34:48:cf".to_string());
        assert!(by_address.accepts(Some("Linkr BLE UART-3"), "EE:C7:42:34:48:CF", None));
        assert!(
            by_address.accepts(
                Some("Linkr BLE UART-3"),
                "some-uuid",
                Some("EE:C7:42:34:48:CF")
            ),
            "and by the advertised address when the id is not a MAC"
        );
        // The real failure on a Linux bench: BlueZ's id is a D-Bus path, and
        // only the address property says which board it is. A client that
        // offered only the id refused a board sitting in the cache under the
        // address the user had typed.
        assert!(
            by_address.accepts(
                Some("Linkr BLE UART-3"),
                "hci0/dev_EE_C7_42_34_48_CF",
                Some("EE:C7:42:34:48:CF")
            ),
            "a path-shaped id is matched by the address property"
        );
        assert!(
            !by_address.accepts(Some("Linkr BLE UART-3"), "AA:BB:CC:DD:EE:FF", None),
            "another board is not this board"
        );
    }

    /// A mistyped address that reduces to nothing must dial nothing. Without
    /// this a value like `":"` would match every candidate.
    #[test]
    fn an_empty_address_never_matches() {
        let empty = Selection::Address("::".to_string());
        assert!(!empty.accepts(Some("Linkr BLE UART-3"), "EE:C7:42:34:48:CF", None));
        assert!(!empty.accepts(Some("Anything"), "", None));
    }

    /// A board is written several ways — a MAC by the user, a path by BlueZ —
    /// and the two name the same board, because a shelf written before this
    /// program kept addresses as MACs still holds the path. Without this the
    /// remembered board would look like a board that is not there.
    #[test]
    fn a_path_and_a_mac_name_the_same_board() {
        assert!(same_device(
            "hci0/dev_FB_F6_91_14_33_3A",
            "fb:f6:91:14:33:3a"
        ));
        assert!(same_device(
            "/org/bluez/hci0/dev_FB_F6_91_14_33_3A",
            "FB:F6:91:14:33:3A"
        ));
        assert!(!same_device(
            "hci0/dev_FB_F6_91_14_33_3A",
            "AA:BB:CC:DD:EE:FF"
        ));
        // Nothing at all is not another name for nothing.
        assert!(!same_device("", ""));
        assert!(!same_device("::", "EE:C7:42:34:48:CF"));

        // And the dial that matters: a shelf address from an older version is
        // a path, while a fresh scan knows the board by its address property.
        let remembered = Selection::Address("hci0/dev_FB_F6_91_14_33_3A".to_string());
        assert!(remembered.accepts(
            Some("Linkr BLE UART-3"),
            "hci0/dev_FB_F6_91_14_33_3A",
            Some("FB:F6:91:14:33:3A")
        ));
    }

    /// A path is read back as the address it carries: a path shown where an
    /// address belongs is a device name nobody can match against anything.
    #[test]
    fn a_path_is_written_out_as_the_address_it_carries() {
        assert_eq!(
            written_address("hci0/dev_FB_F6_91_14_33_3A"),
            "FB:F6:91:14:33:3A"
        );
        assert_eq!(
            written_address("/org/bluez/hci0/dev_FB_F6_91_14_33_3A"),
            "FB:F6:91:14:33:3A"
        );
        assert_eq!(written_address("fb:f6:91:14:33:3a"), "FB:F6:91:14:33:3A");
        // A UUID is not a MAC and must not be read out as one.
        assert_eq!(
            written_address("5c3a1b2e-0000-1000-8000-00805f9b34fb"),
            "5C3A1B2E-0000-1000-8000-00805F9B34FB"
        );
    }

    /// New firmware is discovered by its Management Service. NUS is shared
    /// with unrelated UART bridges, and a new `Linkr Bee` name is only a
    /// display label, so neither may put a stranger in the picker.
    #[test]
    fn a_board_is_recognised_by_its_management_service() {
        assert!(is_board(&[MGMT_SERVICE], None), "the management service");
        assert!(
            !is_board(&[NUS_SERVICE], None),
            "another vendor's NUS device is not a Linkr Bee"
        );
        assert!(
            !is_board(&[], Some("Linkr Bee 078C")),
            "a new name without the service is not identity"
        );
        assert!(!is_board(&[], None), "no service and no name");
    }

    /// The oldest NUS-only firmware used fixed names that no owner could
    /// change. Those units must stay searchable and diallable even though they
    /// never carried the Management Service.
    #[test]
    fn legacy_uart_names_remain_searchable() {
        for name in ["Linkr BLE UART", "Linkr BLE UART-3", "linkr ble uart 7F2C"] {
            assert!(
                is_board(&[NUS_SERVICE], Some(name)),
                "{name} should remain discoverable"
            );
            assert!(is_legacy_name(Some(name)), "{name} should be a legacy name");
        }
        for name in ["Linkr BLE UARTISH", "Linkr Bee 078C", "UART-3", ""] {
            assert!(!is_legacy_name(Some(name)), "{name} is not legacy");
            assert!(
                !is_board(&[NUS_SERVICE], Some(name)),
                "{name} is not a board"
            );
        }
    }

    /// A device that copies the service UUID still has to answer with the
    /// Linkr Device ID namespace after the link is up.
    #[test]
    fn only_the_linkr_device_id_is_accepted() {
        assert!(is_linkr_device_id(
            b"LINKRBLE\x01\x00\x01\x02\x03\x04\x05\x06"
        ));
        assert!(!is_linkr_device_id(b"LINKRBLE\x01\x00\x01\x02\x03\x04\x05"));
        assert!(!is_linkr_device_id(
            b"OTHERBLE\x01\x00\x01\x02\x03\x04\x05\x06"
        ));
        assert!(!is_linkr_device_id(&[]));
    }

    /// The management path must carry the Device ID characteristic and answer
    /// in the Linkr namespace; a copied service UUID is not enough.
    #[test]
    fn the_identity_gate_requires_a_linkr_device_id_for_management() {
        let valid = [NUS_TX, NUS_RX, MGMT_DEVICE_ID];
        let good = b"LINKRBLE\x01\x00\x01\x02\x03\x04\x05\x06";
        assert!(check_identity(true, &valid, Some(good), None).is_ok());

        let without_id = [NUS_TX, NUS_RX];
        let error = check_identity(true, &without_id, None, None).unwrap_err();
        assert!(error.contains("does not expose a Device ID characteristic"));

        for wrong in [
            b"LINKRBLE\x01\x00\x01\x02\x03\x04\x05".as_slice(),
            b"OTHERBLE\x01\x00\x01\x02\x03\x04\x05\x06".as_slice(),
            b"".as_slice(),
        ] {
            let error = check_identity(true, &valid, Some(wrong), None).unwrap_err();
            assert!(error.contains("Device ID does not belong"), "{error}");
        }

        let error = check_identity(true, &valid, None, None).unwrap_err();
        assert!(error.contains("could not be read"), "{error}");
    }

    /// A board without the Management Service is a terminal only while it
    /// still uses a name from the pre-rename firmware. A new-style name on a
    /// NUS-only device is evidence of an impostor.
    #[test]
    fn the_identity_gate_keeps_legacy_nus_only_boards_and_rejects_impostors() {
        let nus_only = [NUS_TX, NUS_RX];
        for name in ["Linkr BLE UART", "Linkr BLE UART-3", "linkr ble uart 7F2C"] {
            assert!(
                check_identity(false, &nus_only, None, Some(name)).is_ok(),
                "{name} should be accepted"
            );
        }
        for name in [Some("Linkr Bee 078C"), Some("Other"), None] {
            let error = check_identity(false, &nus_only, None, name).unwrap_err();
            assert!(
                error.contains("legacy Linkr BLE UART name"),
                "{name:?}: {error}"
            );
        }
    }

    /// Control characters are removed before a scan result reaches a
    /// terminal cell. A valid UTF-8 custom name survives.
    #[test]
    fn advertised_names_are_made_printable() {
        assert_eq!(
            display_name(Some("Linkr Bee 078C")),
            Some("Linkr Bee 078C".into())
        );
        assert_eq!(display_name(Some("  测试 Bee  ")), Some("测试 Bee".into()));
        assert_eq!(
            display_name(Some("bad\nname\x1b[2J")),
            Some("badname[2J".into())
        );
        assert_eq!(display_name(Some("\x00\x1b")), None);
        assert_eq!(display_name(None), None);
    }

    /// Segmentation is what keeps a long write legal, and the thing it must
    /// never do is change or drop a byte.
    #[test]
    fn segmentation_preserves_every_byte_in_order() {
        let payload: Vec<u8> = (0..800).map(|i| (i % 251) as u8).collect();
        let pieces = segment(&payload, MTU_WRITE_LIMIT);
        assert_eq!(pieces.len(), 4, "800 bytes at 244 goes in four writes");
        assert!(pieces.iter().all(|p| p.len() <= MTU_WRITE_LIMIT));
        let rejoined: Vec<u8> = pieces.into_iter().flatten().collect();
        assert_eq!(rejoined, payload, "and every byte survives, in order");
    }

    /// Nothing to send is no write at all — a zero-length ATT packet is
    /// traffic the device did not ask for.
    #[test]
    fn nothing_to_send_is_no_packet() {
        assert!(segment(&[], MTU_WRITE_LIMIT).is_empty());
    }

    /// The sidebar has to say which board is being looked for, or an operator
    /// with two on the bench cannot tell them apart.
    #[test]
    fn the_description_names_the_target() {
        assert_eq!(
            BleLink::discovering().describe(),
            "ble:find the nearest device"
        );
        assert_eq!(
            BleLink::named("Linkr BLE UART-3").describe(),
            "ble:Linkr BLE UART-3"
        );
        assert_eq!(
            BleLink::addressed("ee:c7:42:34:48:cf").describe(),
            "ble:EE:C7:42:34:48:CF",
            "and the address is said the way the tooling prints it"
        );
    }

    /// The link must name itself as Bluetooth whatever else changes.
    #[test]
    fn the_kind_is_bluetooth() {
        assert_eq!(BleLink::discovering().kind(), LinkKind::Ble);
    }

    /// A reader whose radio has gone must say end-of-stream rather than an
    /// error, because a device that walked away is not a fault to report.
    #[test]
    fn a_reader_with_no_radio_behind_it_reads_end_of_stream() {
        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        let mut reader = BleReader {
            inbound: rx,
            management: None,
            leftover: VecDeque::new(),
            done: false,
        };
        let _ = tx.send(Some(vec![1, 2, 3]));
        let mut buf = [0u8; 8];
        assert_eq!(reader.read(&mut buf).unwrap(), 3);
        assert_eq!(&buf[..3], &[1, 2, 3]);

        // "The device went away".
        let _ = tx.send(None);
        assert_eq!(reader.read(&mut buf).unwrap(), 0, "then end of stream");
        assert_eq!(reader.read(&mut buf).unwrap(), 0, "and that stays true");
    }

    /// A notification longer than the caller's buffer is *not* truncated: the
    /// rest has to come back on the next read. Losing the tail of a long line
    /// would corrupt the very traffic this link exists to carry.
    #[test]
    fn bytes_that_do_not_fit_wait_for_the_next_read() {
        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        let mut reader = BleReader {
            inbound: rx,
            management: None,
            leftover: VecDeque::new(),
            done: false,
        };
        let sent: Vec<u8> = (0..10).collect();
        let _ = tx.send(Some(sent.clone()));

        let mut got = Vec::new();
        let mut small = [0u8; 4];
        for expected in [4, 4, 2] {
            let n = reader.read(&mut small).unwrap();
            assert_eq!(n, expected, "one read takes no more than it is offered");
            got.extend_from_slice(&small[..n]);
        }
        assert_eq!(got, sent, "ten bytes through a four-byte buffer, whole");
    }

    /// A notification the daemon repeated is passed on once, and its repeats
    /// are dropped — but only while they are *repeats*: the same value coming
    /// back after a different one is a new event and is not this link's to
    /// swallow.
    #[test]
    fn a_repeated_notification_is_passed_on_once() {
        let mut last = None;
        let line = b"@scan result BenchNet wpa2 ch=6 -54dBm".to_vec();

        for copy in 0..4 {
            let kept = keep_once(&mut last, line.clone());
            if copy == 0 {
                assert_eq!(kept.as_ref(), Some(&line), "the first copy is the event");
            } else {
                assert!(kept.is_none(), "copy {copy} is the daemon talking twice");
            }
        }

        // A different notification in between makes the same value new again.
        assert!(keep_once(&mut last, b"@scan done".to_vec()).is_some());
        assert!(
            keep_once(&mut last, line.clone()).is_some(),
            "after a different notification the same value is a new one"
        );
    }

    /// A second client holding the adapter is an answer BlueZ gives in more
    /// than one spelling, and every one of them means "try again in a moment",
    /// not "no".
    #[test]
    fn busy_failures_are_recognised_in_every_spelling() {
        assert!(is_busy("In Progress"), "the D-Bus message");
        assert!(is_busy("org.bluez.Error.InProgress"), "the error name");
        assert!(is_busy("IN PROGRESS"), "casing");
        assert!(!is_busy("device not found matching: AA:BB:CC:DD:EE:FF"));
        assert!(!is_busy("a Bluetooth call did not answer within 15 s"));
        assert!(!is_busy(""));
    }

    /// The transient `Connect` answers are the ones worth another dial; a
    /// permanent refusal is not, and retrying it would only delay the real
    /// message by the length of the budget.
    #[test]
    fn only_transient_refusals_are_worth_another_dial() {
        for transient in [
            "br-connection-canceled",
            "br-connection-timeout",
            "br-connection-failed",
            "br-connection-adv-timeout",
            "Not connected",
        ] {
            assert!(is_transient(transient), "{transient} is transient");
        }
        assert!(
            !is_transient("br-connection-rej-security"),
            "a refusal is the answer"
        );
        assert!(
            !is_transient("In Progress"),
            "busy is waited out, not redialled"
        );
        assert!(!is_transient("device not found"));
    }

    /// A dial that failed anyway says what to do about it, and anything else
    /// keeps BlueZ's own words behind the one thing the dial knows.
    #[test]
    fn a_failed_dial_names_the_next_step() {
        let busy = dial_error("org.bluez.Error.InProgress");
        assert!(busy.contains("adapter is busy"), "{busy}");
        assert!(busy.contains("retry in a second"), "{busy}");

        let dropped = dial_error("br-connection-canceled");
        assert!(dropped.contains("dropped mid-dial"), "{dropped}");
        assert!(dropped.contains("br-connection-canceled"), "{dropped}");

        let refused = dial_error("br-connection-rej-security");
        assert_eq!(
            refused, "the connection was refused: br-connection-rej-security",
            "a permanent refusal is not dressed up"
        );
    }

    /// A caller that named a long window gets a long attempt: the flag is the
    /// promise, and a dial that gave up at fifteen seconds while its caller was
    /// still due forty would answer a question nobody asked.
    ///
    /// What the attempt may not be is a *second* window on top of the one the
    /// caller named: the scan's own time is charged against it, and the wiring
    /// after it keeps its own moment — a scan and an attempt that each looked
    /// generous is how a board that was still connecting got reported as one
    /// that never answered.
    #[test]
    fn a_dial_attempt_follows_the_window_the_caller_named() {
        assert_eq!(
            dial_attempt(Duration::from_secs(40), Duration::ZERO),
            Duration::from_secs(35),
            "`--connect-timeout 40` governs the dial and leaves the wiring its moment"
        );
        assert_eq!(
            dial_attempt(Duration::from_secs(40), Duration::from_secs(12)),
            Duration::from_secs(23),
            "the scan's time is the caller's time too"
        );
        assert_eq!(
            dial_attempt(Duration::from_secs(5), Duration::ZERO),
            DIAL_ATTEMPT,
            "a window shorter than a cold dial is `open`'s timer, not this one"
        );
        assert_eq!(
            dial_attempt(CONNECT_TIMEOUT, SCAN_TIMEOUT),
            DIAL_ATTEMPT,
            "the default window less a scan that ran out is exactly one floor"
        );
        assert_eq!(
            dial_attempt(DIAL_ATTEMPT, DIAL_ATTEMPT),
            DIAL_ATTEMPT,
            "the floor is the floor"
        );
    }

    /// The window `open` waits covers every part the reactor may spend inside
    /// it: a scan that runs out its window, one connect at its floor, and the
    /// moment the wiring needs on top.
    #[test]
    fn the_default_window_covers_the_work_it_pays_for() {
        assert_eq!(
            CONNECT_TIMEOUT,
            SCAN_TIMEOUT + DIAL_ATTEMPT + HANDSHAKE_ALLOWANCE,
            "the window is written as the sum of what it has to cover"
        );
        // A default dial that scans its whole window and then hits the floor
        // still leaves the wiring its moment.
        assert_eq!(
            SCAN_TIMEOUT + dial_attempt(CONNECT_TIMEOUT, SCAN_TIMEOUT) + HANDSHAKE_ALLOWANCE,
            CONNECT_TIMEOUT,
        );
    }

    /// A board without the management characteristic answers for it: the frame
    /// is refused at the door rather than queued for a reactor that would drop
    /// it. Dropped there, it reads to the caller as a bridge that never
    /// answered.
    #[test]
    fn a_link_without_the_management_characteristic_says_so() {
        let (outbound, queue) = mpsc::channel::<Frame>();
        let mut writer = BleWriter {
            outbound,
            carries_management: Arc::new(AtomicBool::new(false)),
        };
        let refused = writer
            .write_management(b"ping")
            .expect_err("a board with no management characteristic");
        assert!(
            refused.to_string().contains("no management channel"),
            "the refusal names what is missing: {refused}"
        );
        assert!(
            queue.try_recv().is_err(),
            "nothing was queued for the reactor to drop"
        );

        // And a board that carries it takes the frame, as before.
        let (outbound, queue) = mpsc::channel::<Frame>();
        let mut writer = BleWriter {
            outbound,
            carries_management: Arc::new(AtomicBool::new(true)),
        };
        writer.write_management(b"ping").expect("accepted");
        let sent = queue
            .try_recv()
            .expect("the frame is on its way to the radio");
        assert!(
            matches!(sent, Frame::Management(frame) if frame == b"ping".as_slice()),
            "the management frame is what went to the radio"
        );
    }

    /// A dial that ran out of time is told apart from a refusal, and its
    /// message names the next attempt's hazard: the adapter can still be
    /// finishing with a board that never answered.
    #[test]
    fn a_timed_out_dial_warns_about_the_adapter() {
        let timed_out = dial_error("Timed out after 40s");
        assert!(timed_out.contains("did not answer in time"), "{timed_out}");
        assert!(timed_out.contains("give it a minute"), "{timed_out}");
        assert!(timed_out.contains("Timed out after 40s"), "{timed_out}");
        assert!(is_timeout("Timed out after 40s"));
        assert!(is_timeout("operation timeout"));
        assert!(!is_timeout("device not found"));
        // BlueZ's own timeout spelling is transient first: it is retried
        // in-budget, and only its expiry is reported — as a dropped link.
        let expired = dial_error("br-connection-timeout");
        assert!(expired.contains("dropped mid-dial"), "{expired}");
        assert!(!expired.contains("did not answer in time"), "{expired}");
    }
}
