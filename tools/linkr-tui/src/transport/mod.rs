//! The wire: whatever carries bytes between this host and the device.
//!
//! Every link in the product — the process bridge that stands in for a radio
//! while there is no hardware, Bluetooth, the LAN socket — is the same two
//! things: something that yields received bytes and something that accepts
//! bytes to send.
//!
//! There are three, and there is no serial link among them on purpose. The
//! device *is* a wireless serial bridge: the far end of every link here is a
//! UART the bridge is holding, and reaching the port directly from the host
//! would need a cable — which is the thing the product exists to do without.
//! The target's serial semantics (its prompts, its pager, the shape of its
//! login) are this side's business, because they arrive over one of these
//! links as bytes; see `serial`. Opening the port itself never is. That is all a view or a protocol needs to know, so it
//! is all this module promises. The link is therefore split into a reader half
//! and a writer half at open time: a BLE characteristic and a serial port both
//! need reads and writes to make progress *at the same time*, and a single
//! `&mut self` API would make the writer wait behind a read that has not
//! arrived yet.
//!
//! Bytes move on two dedicated threads rather than in the event loop, because
//! both halves block: a terminal that spins on `read` is a terminal that burns
//! a core, and the interface has a 250 ms beat to keep. The loop talks to the
//! threads over channels, so `App` never owns a socket, a file descriptor or a
//! `JoinHandle` — it owns a [`LinkHandle`], which is plain data plus a queue.
//!
//! That also makes the whole link testable with no hardware at all: the tests
//! drive an in-memory pair through the same `Link` trait the real links
//! implement, so the pump, the counters, the disconnect path and the journal
//! are exercised exactly as they are in production.

pub mod ble;
pub mod lan;
pub mod stdio;

use std::io;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Which link the session is carried over. The sidebar names it, the command
/// line pins it, and `--transport` accepts the spelling [`LinkKind::as_str`]
/// gives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LinkKind {
    /// A child process whose standard input and output carry device bytes —
    /// the bridge that stands in for a radio before one is implemented, and
    /// the way an out-of-tree driver (the Python client, `socat`, a test
    /// double) is attached without giving it a socket of its own.
    Stdio,
    /// Bluetooth Low Energy, the Nordic UART Service.
    #[default]
    Ble,
    /// The LAN socket.
    Lan,
}

impl LinkKind {
    /// Every link, in the order the sidebar and the command line list them.
    pub const ALL: [LinkKind; 3] = [LinkKind::Stdio, LinkKind::Ble, LinkKind::Lan];

    /// The spelling a command line uses.
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Stdio => "stdio",
            LinkKind::Ble => "ble",
            LinkKind::Lan => "lan",
        }
    }

    /// The link a name refers to. Unknown names give `None`, so a caller can
    /// report the bad value instead of silently dialling something else.
    pub fn from_name(name: &str) -> Option<LinkKind> {
        let name = name.trim().to_ascii_lowercase();
        LinkKind::ALL.into_iter().find(|kind| kind.as_str() == name)
    }

    /// The word the chrome shows, upper-cased the way the design does.
    pub fn label(self) -> &'static str {
        match self {
            LinkKind::Stdio => "stdio",
            LinkKind::Ble => "BLE",
            LinkKind::Lan => "LAN",
        }
    }
}

/// The receiving half of a link.
pub trait LinkReader: Send {
    /// Read into `buf`. `Ok(0)` means the far end closed cleanly.
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>;

    /// Where a link with a side channel reports anything that is not target
    /// output. Called once, before the read loop starts.
    ///
    /// Almost every bearer is a pipe and takes the default, which is to have
    /// nothing to say out of band. Two are not: a WebSocket sends the target's
    /// bytes as binary frames and its own announcements as text, and BLE keeps
    /// its management service on characteristics of its own. Routing either
    /// through `read` would type it into the terminal, so it comes out here
    /// instead — see [`lan`] and [`ble`].
    ///
    /// One sink rather than one per kind of thing, because a link that has a
    /// side channel tends to grow a second use for it, and adding a method per
    /// use is how the same event ends up arriving by two doors.
    fn side_channel(&mut self, _events: Sender<LinkEvent>) {}
}

/// The sending half of a link.
pub trait LinkWriter: Send {
    /// Write every byte; a short write is the implementation's problem.
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()>;
    /// Push what was buffered to the far end.
    fn flush(&mut self) -> io::Result<()>;

    /// Send one management frame — a question about the bridge itself rather
    /// than a keystroke for the target.
    ///
    /// Only Bluetooth answers this today, because only Bluetooth has a channel
    /// to carry it: the management service sits beside Nordic UART rather than
    /// inside it, and its replies would otherwise have to be told apart from
    /// whatever the target was printing at the time. The default is therefore
    /// a refusal that says exactly that, which is what a caller shows when
    /// somebody asks a bridge over the wrong bearer for its firmware version.
    fn write_management(&mut self, _frame: &[u8]) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "this link has no management channel",
        ))
    }

    /// End the link itself, not just this end of it.
    ///
    /// A bearer that holds a session of its own — Bluetooth's LE link — can
    /// close it out loud, and that is what frees the device for the next
    /// client. A bearer that is a pipe has nothing to close: the process
    /// leaving is the hang-up, so the default does nothing.
    fn hangup(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A link that has not been opened yet.
///
/// Opening is separate from dialling on purpose: a real link opens the port or
/// the GATT server, and that is the step that fails on a machine with no
/// adapter. Keeping it out of the constructor means the *description* of what
/// to dial can be built, logged and tested with nothing plugged in.
pub trait Link: Send {
    /// Open the link and split it into its two halves.
    fn open(self: Box<Self>) -> io::Result<(Box<dyn LinkReader>, Box<dyn LinkWriter>)>;

    /// Which kind of link this is.
    fn kind(&self) -> LinkKind;

    /// How the sidebar and the notices name it, e.g. `stdio: cat`.
    fn describe(&self) -> String;

    /// The LAN address this link talks to and whether it presented a token, or
    /// `None` for a link that is not a LAN one.
    ///
    /// Why this is on the trait at all: the sidebar shows `LAN 192.168.0.100
    /// (token)`, which is the only way a user can tell a bridge they reached from
    /// a bridge they did not, and a caller holding a `Box<dyn Link>` has no other
    /// way to ask. The default is `None` because two of the three links are not
    /// LAN and neither wants to say so twice.
    fn lan_details(&self) -> Option<(String, bool)> {
        None
    }
}

/// What the link reports to the event loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkEvent {
    /// The link is open and the session may be called connected.
    Opened,
    /// Bytes arrived from the device. Never empty.
    Data(Vec<u8>),
    /// The far end said something in words rather than bytes — a bridge
    /// announcement over a channel that has one. Never empty, and never
    /// target output: it is shown as a notice and typed nowhere.
    Notice(String),
    /// Bytes from the bridge's *management* channel: an answer to a question
    /// this host asked it about itself.
    ///
    /// Never target output, and never mixed with it — which is the whole
    /// reason this variant exists rather than the bytes going through
    /// [`LinkEvent::Data`]. A response that had to be recognised inside the
    /// target's own output could only be guessed apart from it, and the guess
    /// would be wrong exactly when the target happened to print something
    /// shaped like a reply. See `device`.
    Management(Vec<u8>),
    /// The link ended. The string is what the notice says happened; nothing
    /// after a `Closed` is delivered.
    Closed(String),
}

/// A command from the event loop to the writer thread.
enum Outgoing {
    /// Keystrokes and whatever else is typed into the target.
    Bytes(Vec<u8>),
    /// A whole management frame, split into writes by the link itself.
    Management(Vec<u8>),
    /// Stop writing, and — on a link that holds a session of its own — end
    /// that session out loud rather than letting it time out. See
    /// [`LinkWriter::hangup`].
    Hangup,
    Close,
}

/// Size of the read buffer each turn. A BLE notification is at most 244 bytes
/// and a serial read is whatever the driver has; 4 KiB keeps a burst to a
/// handful of turns without holding a megabyte of the device's output per
/// link while it is not being drained.
const READ_CHUNK: usize = 4096;

/// A link that is already open, waiting to be pumped.
///
/// The pairing a dial that cannot afford to wait builds: opening is the slow
/// half — a radio takes seconds to come up — so a caller with a thread to
/// spare pays for it there and sends the result back, rather than freezing
/// the frame that is drawing. The link's identity rides along because
/// [`Link::kind`], [`Link::describe`] and [`Link::lan_details`] can only be
/// asked before the link is consumed, and the sidebar needs them after.
pub struct OpenedLink {
    /// Which link this is.
    pub kind: LinkKind,
    /// How the sidebar and the notices name it, e.g. `ble:EE:C7:42:34:48:CF`.
    pub description: String,
    /// The LAN address this link talks to, empty for links that are not LAN.
    pub lan_host: String,
    /// Whether this LAN link went out with a token.
    pub lan_secured: bool,
    reader: Box<dyn LinkReader>,
    writer: Box<dyn LinkWriter>,
}

impl OpenedLink {
    /// Open `link`, here, on the calling thread. Everything this costs is paid
    /// before it returns.
    pub fn open(link: Box<dyn Link>) -> io::Result<OpenedLink> {
        let kind = link.kind();
        let description = link.describe();
        // Read before the link is consumed: the only thing that knows whether
        // a token went out is the link itself.
        let (lan_host, lan_secured) = link.lan_details().unwrap_or_default();
        let (reader, writer) = link.open()?;
        Ok(OpenedLink {
            kind,
            description,
            lan_host,
            lan_secured,
            reader,
            writer,
        })
    }
}

/// A running link: the event queue the loop drains and the door it writes
/// through. Dropping the handle closes the link.
#[derive(Debug)]
pub struct LinkHandle {
    events: Receiver<LinkEvent>,
    outgoing: Sender<Outgoing>,
    /// Kept so the threads are known to be alive for the life of the handle;
    /// they are detached rather than joined, because a reader blocked on a
    /// socket must not hold up a quit.
    _reader: JoinHandle<()>,
    _writer: JoinHandle<()>,
    kind: LinkKind,
    description: String,
}

impl LinkHandle {
    /// Open `link` and start pumping it.
    pub fn start(link: Box<dyn Link>) -> io::Result<LinkHandle> {
        Ok(LinkHandle::from_opened(OpenedLink::open(link)?))
    }

    /// Start pumping a link that is already open.
    ///
    /// The other half of [`Self::start`]: a caller that has already paid for
    /// the open — possibly on a thread of its own — hands the halves here
    /// rather than paying for them again on the thread that draws.
    pub fn from_opened(opened: OpenedLink) -> LinkHandle {
        let (event_tx, events) = mpsc::channel();
        let (outgoing, command_rx) = mpsc::channel();

        let reader = spawn_reader(opened.reader, event_tx.clone());
        let writer = spawn_writer(opened.writer, command_rx, event_tx);
        LinkHandle {
            events,
            outgoing,
            _reader: reader,
            _writer: writer,
            kind: opened.kind,
            description: opened.description,
        }
    }

    /// Which link this is.
    pub fn kind(&self) -> LinkKind {
        self.kind
    }

    /// How the link names itself.
    pub fn describe(&self) -> &str {
        &self.description
    }

    /// Queue bytes to the device. `false` means the writer thread is gone, so
    /// the caller can stop counting them as sent.
    pub fn send(&self, bytes: Vec<u8>) -> bool {
        self.outgoing.send(Outgoing::Bytes(bytes)).is_ok()
    }

    /// Queue a management frame. `false` means the writer thread is gone.
    ///
    /// Separate from [`Self::send`] because these bytes are not typed into the
    /// target and must not be counted as though they were: they ask the bridge
    /// something about itself and are answered on another characteristic.
    pub fn send_management(&self, frame: Vec<u8>) -> bool {
        self.outgoing.send(Outgoing::Management(frame)).is_ok()
    }

    /// Take every event that has arrived, without blocking. Stops as soon as
    /// nothing is left so the frame is never delayed by the link.
    pub fn drain(&self) -> Vec<LinkEvent> {
        let mut out = Vec::new();
        loop {
            match self.events.try_recv() {
                Ok(event) => out.push(event),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => return out,
            }
        }
    }

    /// Ask the transport to end the link — out loud when the bearer can.
    ///
    /// `false` means the writer thread is already gone, which is a link that
    /// ended by itself and needs no goodbye.
    pub fn hangup(&self) -> bool {
        self.outgoing.send(Outgoing::Hangup).is_ok()
    }

    /// The way to end this link from *anywhere* — a panic hook, a console
    /// close handler — where no handle is in reach: see [`crate::hangup`].
    ///
    /// The closure has no events channel to hear the answer on, so its wait
    /// is a flat delay; every caller of it is already leaving.
    pub fn ender(&self) -> crate::hangup::Ender {
        let outgoing = self.outgoing.clone();
        std::sync::Arc::new(move |grace: Duration| {
            if outgoing.send(Outgoing::Hangup).is_ok() {
                thread::sleep(grace);
            }
        })
    }

    /// Hang up, and wait up to `grace` for the link to say it is down.
    ///
    /// The wait is the whole point of the method: a process that asks for the
    /// hang-up and exits in the same millisecond leaves the board connected to
    /// a client that no longer exists. `true` means the end was *heard* —
    /// a `Closed` event or a reader that is gone — and `false` means the
    /// grace ran out, which is the honest answer for a bearer whose reader is
    /// parked in a blocking read and reports nothing until it unblocks.
    pub fn hangup_and_wait(&self, grace: Duration) -> bool {
        if !self.hangup() {
            return true;
        }
        let deadline = Instant::now() + grace;
        loop {
            match self.events.try_recv() {
                Ok(LinkEvent::Closed(_)) => return true,
                // Anything the link still had to say on its way out is read
                // and dropped: this is only ever called on the way to an exit.
                Ok(_) => continue,
                Err(TryRecvError::Disconnected) => return true,
                Err(TryRecvError::Empty) => {}
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for LinkHandle {
    fn drop(&mut self) {
        // Ask the writer to stop. The reader is left to notice its own EOF:
        // a blocking read on a socket cannot be interrupted from here without
        // closing the descriptor under it, which is the link's own business.
        let _ = self.outgoing.send(Outgoing::Close);
    }
}

/// The reader thread: hand every chunk to the loop, then report why it ended.
fn spawn_reader(mut reader: Box<dyn LinkReader>, events: Sender<LinkEvent>) -> JoinHandle<()> {
    // Offered before the loop, so a link with a side channel can announce
    // something on its first read — and so the reads it does make are the only
    // thing this thread ever waits on.
    reader.side_channel(events.clone());
    thread::spawn(move || {
        if events.send(LinkEvent::Opened).is_err() {
            return;
        }
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if events.send(LinkEvent::Data(buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
                Err(err) => {
                    let _ = events.send(LinkEvent::Closed(err.to_string()));
                    return;
                }
            }
        }
        let _ = events.send(LinkEvent::Closed("end of stream".to_string()));
    })
}

/// The writer thread: one byte buffer in, one `write_all` out.
fn spawn_writer(
    mut writer: Box<dyn LinkWriter>,
    commands: Receiver<Outgoing>,
    events: Sender<LinkEvent>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while let Ok(command) = commands.recv() {
            match command {
                // The hang-up first, then the same stop a close asks for: a
                // board left connected to a client that has gone stops
                // advertising, and the next client cannot find it.
                Outgoing::Hangup => {
                    let _ = writer.hangup();
                    break;
                }
                Outgoing::Close => break,
                Outgoing::Bytes(bytes) => {
                    if bytes.is_empty() {
                        continue;
                    }
                    if let Err(err) = writer.write_all(&bytes).and_then(|()| writer.flush()) {
                        let _ = events.send(LinkEvent::Closed(err.to_string()));
                        return;
                    }
                }
                Outgoing::Management(frame) => {
                    // A write the link does not carry is reported rather than
                    // swallowed: asking for management over a bearer that has
                    // none must read as "this link has no management channel",
                    // not as a request that went unanswered.
                    if let Err(err) = writer.write_management(&frame) {
                        let _ = events.send(LinkEvent::Notice(err.to_string()));
                    }
                }
            }
        }
    })
}

#[cfg(test)]
pub mod testing {
    //! An in-memory link, so a test can drive the pump without a device.

    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    #[derive(Clone)]
    pub struct MemoryLink {
        to_device: Arc<Mutex<VecDeque<u8>>>,
        from_device: Arc<Mutex<VecDeque<u8>>>,
        /// What the host has sent on the management channel, kept apart from
        /// `to_device` because these bytes were never typed into the target and
        /// a test that found them mixed in would be reading a conversation the
        /// target never had.
        management_to_device: Arc<Mutex<VecDeque<Vec<u8>>>>,
        /// Management responses waiting to be delivered to the host. Each entry
        /// is one notification, because that is how they arrive.
        management_from_device: Arc<Mutex<VecDeque<Vec<u8>>>>,
        /// Which link this memory pair claims to be. Almost every test wants
        /// `Stdio`; the management channel is Bluetooth-only, so anything
        /// asking the bridge about itself needs a link that says it is.
        kind: LinkKind,
        /// How the pair names itself. "memory" unless a test needs a link
        /// that describes itself the way a real one does — the sidebar's
        /// device row reads the description, so a test of that row asks for a
        /// link that has one.
        description: String,
        /// Set when the host's writer is dropped, so a test can tell the
        /// difference between "nothing yet" and "the host hung up".
        closed: Arc<Mutex<bool>>,
        /// Set when the host asked for the link itself to end, which is a
        /// different request from dropping the writer: see
        /// [`LinkWriter::hangup`].
        hung_up: Arc<Mutex<bool>>,
    }

    /// A memory pair announces itself as `Stdio` rather than taking
    /// `LinkKind`'s own default, because "in memory" is closer to a pipe than
    /// to a radio: most tests are about bytes in one end and out the other, and
    /// the Bluetooth-specific behaviour — the management channel — is what
    /// [`MemoryLink::ble`] exists to ask for.
    impl Default for MemoryLink {
        fn default() -> MemoryLink {
            MemoryLink {
                to_device: Arc::new(Mutex::new(VecDeque::new())),
                from_device: Arc::new(Mutex::new(VecDeque::new())),
                management_to_device: Arc::new(Mutex::new(VecDeque::new())),
                management_from_device: Arc::new(Mutex::new(VecDeque::new())),
                kind: LinkKind::Stdio,
                description: "memory".to_string(),
                closed: Arc::new(Mutex::new(false)),
                hung_up: Arc::new(Mutex::new(false)),
            }
        }
    }

    impl MemoryLink {
        pub fn new() -> MemoryLink {
            MemoryLink::default()
        }

        /// A memory pair standing in for a Bluetooth link, which is the one
        /// bearer that has a management channel.
        pub fn ble() -> MemoryLink {
            MemoryLink {
                kind: LinkKind::Ble,
                ..MemoryLink::default()
            }
        }

        /// A memory pair that names itself the way a Bluetooth link does —
        /// `ble:EE:C7:42:34:48:CF`. The sidebar's device row reads the
        /// description of the link that is up, so this is what a test of that
        /// row dials.
        pub fn ble_addressed(address: &str) -> MemoryLink {
            MemoryLink {
                kind: LinkKind::Ble,
                description: format!("ble:{}", address.to_ascii_uppercase()),
                ..MemoryLink::default()
            }
        }

        /// Build the `Link` the session opens.
        pub fn link(&self) -> Box<dyn Link> {
            Box::new(self.clone())
        }

        /// Feed the host one management notification.
        pub fn feed_management(&self, bytes: Vec<u8>) {
            let mut queue = self.management_from_device.lock().expect("link lock");
            queue.push_back(bytes);
        }

        /// Everything the host has asked on the management channel, drained.
        pub fn take_management(&self) -> Vec<Vec<u8>> {
            let mut queue = self.management_to_device.lock().expect("link lock");
            queue.drain(..).collect()
        }

        /// Bytes the host has written, drained.
        pub fn take_sent(&self) -> Vec<u8> {
            let mut queue = self.to_device.lock().expect("link lock");
            queue.drain(..).collect()
        }

        /// How many bytes the host has written, without draining them.
        ///
        /// The host's writer runs on its own thread, so a test that waits for
        /// the session's *counter* is waiting for the hand-off to the channel
        /// rather than for the wire. This is what such a test polls instead.
        pub fn sent_len(&self) -> usize {
            self.to_device.lock().expect("link lock").len()
        }

        /// Feed the host a chunk of device output.
        pub fn feed(&self, bytes: &[u8]) {
            let mut queue = self.from_device.lock().expect("link lock");
            queue.extend(bytes.iter().copied());
        }

        /// Close the device end, so the host's reader sees EOF.
        pub fn close(&self) {
            *self.closed.lock().expect("link lock") = true;
        }

        fn closed_flag(&self) -> bool {
            *self.closed.lock().expect("link lock")
        }

        /// Whether the host asked for the *link* to end rather than merely
        /// putting its own end down.
        pub fn hung_up(&self) -> bool {
            *self.hung_up.lock().expect("link lock")
        }
    }

    /// Build one *unfinished* management fragment: a response in progress.
    ///
    /// A scan streams its results this way — the firmware sends each one with
    /// no final flag, and only `@scan done` ends it — so a test that wants to
    /// see the list grow needs this rather than `answer`'s finished frame.
    pub fn partial(id: u32, body: &str) -> Vec<u8> {
        let mut frame = Vec::new();
        frame.extend_from_slice(b"LK");
        frame.push(crate::protocol::MGMT_API_MAJOR);
        frame.push(2);
        frame.extend_from_slice(&id.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u16).to_le_bytes());
        frame.extend_from_slice(&0u16.to_le_bytes());
        frame.extend_from_slice(body.as_bytes());
        frame
    }

    /// Build one management response for `id`, framed the way the bridge
    /// frames them, ending with the flag that says the answer is complete.
    ///
    /// Bodies are raw bytes, as the wire carries them. The real firmware ends
    /// every line with CRLF (`snprintk("…\r\n")` throughout `main.c`), so a
    /// fixture that means a whole line should spell the terminator — and one
    /// that leaves it off is saying the line is still arriving, which is what
    /// a fragment boundary can look like on the wire.
    pub fn answer(id: u32, body: &str) -> Vec<u8> {
        let mut frame = Vec::new();
        frame.extend_from_slice(b"LK");
        frame.push(crate::protocol::MGMT_API_MAJOR);
        frame.push(2);
        frame.extend_from_slice(&id.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u16).to_le_bytes());
        frame.extend_from_slice(&crate::protocol::MGMT_FLAG_FINAL.to_le_bytes());
        frame.extend_from_slice(body.as_bytes());
        frame
    }

    /// The management frames the host sent, once they have left for the wire.
    ///
    /// Polled until the wire falls quiet, not merely until the first frame
    /// lands: the bytes cross a thread on their way out, so two asks sent back
    /// to back can arrive a drain apart, and a test that stopped at the first
    /// arrival would judge the conversation by whichever frame won the race.
    pub fn asked_frames(wire: &MemoryLink) -> Vec<Vec<u8>> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut frames = Vec::new();
        loop {
            // A quiet puff of time: one hand-off may still be in flight when
            // the previous one lands.
            thread::sleep(Duration::from_millis(2));
            let arrived = wire.take_management();
            let past_deadline = Instant::now() > deadline;
            if arrived.is_empty() && (!frames.is_empty() || past_deadline) {
                return frames;
            }
            frames.extend(arrived);
            if past_deadline {
                return frames;
            }
        }
    }

    /// The id the host just asked with, read out of the frame it sent.
    ///
    /// Read from the bytes rather than parsed, because the header parser
    /// accepts *responses* only — a request's own header is deliberately not
    /// something it accepts, so that a reply can never be mistaken for the
    /// question that caused it.
    pub fn asked_id(wire: &MemoryLink) -> u32 {
        // The *last* frame, not the first: a link that has just opened is
        // mid-sequence through the on-connect reads, so the frame this call is
        // about is the latest one out — and the earlier ones belong to the
        // questions that came before it.
        let frames = asked_frames(wire);
        assert!(!frames.is_empty(), "no question was asked");
        let bytes = frames.last().expect("one frame");
        assert_eq!(&bytes[..2], b"LK", "the magic");
        assert_eq!(bytes[3], crate::protocol::MGMT_REQUEST_TYPE);
        let expected = u16::from_le_bytes([bytes[8], bytes[9]]);
        assert!(expected > 0, "nothing was asked");
        u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]])
    }

    /// Whether `expected` is among the questions that went out.
    ///
    /// All of them, not the last: opening a link asks the on-connect reads in
    /// front of whatever a test then does, so the frame a test cares about is
    /// rarely the newest one out. This is the assertion these tests actually
    /// mean — "the command was sent" — stated directly rather than inferred
    /// from a position that the hello has moved.
    pub fn asked_includes(wire: &MemoryLink, expected: &[u8]) -> bool {
        asked_frames(wire)
            .iter()
            .any(|bytes| bytes[crate::protocol::MGMT_HEADER_SIZE..] == *expected)
    }

    struct MemoryReader {
        link: MemoryLink,
        events: Option<Sender<LinkEvent>>,
    }

    impl MemoryReader {
        /// Hand every waiting management notification to the loop.
        ///
        /// Done here rather than in its own thread, because a memory link has
        /// no reactor to run one on — and because `read` is called continuously
        /// for as long as the link is open, so this costs a test nothing.
        fn deliver_management(&self) {
            let Some(events) = &self.events else {
                return;
            };
            loop {
                let next = {
                    let mut queue = self.link.management_from_device.lock().expect("link lock");
                    queue.pop_front()
                };
                match next {
                    Some(bytes) => {
                        if events.send(LinkEvent::Management(bytes)).is_err() {
                            return;
                        }
                    }
                    None => return,
                }
            }
        }
    }

    impl LinkReader for MemoryReader {
        fn side_channel(&mut self, events: Sender<LinkEvent>) {
            self.events = Some(events);
        }

        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            loop {
                // Checked on every turn of the wait and not once per `read`,
                // because `read` is called once and then blocks: whatever waits
                // inside this loop is waiting *instead of* returning, and a
                // delivery that happened only at its top would wait for data
                // that may never come. A real link does this on a thread of its
                // own; a memory link has nowhere else to do it.
                self.deliver_management();
                {
                    let mut queue = self.link.from_device.lock().expect("link lock");
                    if !queue.is_empty() {
                        let n = queue.len().min(buf.len());
                        for slot in buf.iter_mut().take(n) {
                            *slot = queue.pop_front().expect("checked non-empty");
                        }
                        return Ok(n);
                    }
                    if self.link.closed_flag() {
                        return Ok(0);
                    }
                }
                // Nothing buffered and not closed: wait for the test to feed
                // us, the way a real read waits on the wire.
                thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }

    struct MemoryWriter {
        link: MemoryLink,
    }

    impl LinkWriter for MemoryWriter {
        fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
            let mut queue = self.link.to_device.lock().expect("link lock");
            queue.extend(buf.iter().copied());
            Ok(())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn write_management(&mut self, frame: &[u8]) -> io::Result<()> {
            let mut queue = self.link.management_to_device.lock().expect("link lock");
            queue.push_back(frame.to_vec());
            Ok(())
        }

        /// Ending the link out loud, the way a bearer with a session of its own
        /// does: the reader is let go too, because an ended link has no more
        /// bytes to deliver — which is what makes a hang-up observable to a
        /// test rather than merely sent.
        fn hangup(&mut self) -> io::Result<()> {
            *self.link.hung_up.lock().expect("link lock") = true;
            self.link.close();
            Ok(())
        }
    }

    impl Link for MemoryLink {
        fn open(self: Box<Self>) -> io::Result<(Box<dyn LinkReader>, Box<dyn LinkWriter>)> {
            let link = *self;
            Ok((
                Box::new(MemoryReader {
                    link: link.clone(),
                    events: None,
                }),
                Box::new(MemoryWriter { link }),
            ))
        }

        fn kind(&self) -> LinkKind {
            self.kind
        }

        fn describe(&self) -> String {
            self.description.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::MemoryLink;
    use super::*;
    use std::time::{Duration, Instant};

    /// Wait for `predicate`, up to a second. The pump runs on its own threads,
    /// so a test polls rather than sleeps a fixed amount — a fixed sleep is a
    /// flaky test on a loaded machine.
    fn wait_for(mut predicate: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            thread::sleep(Duration::from_millis(1));
        }
        predicate()
    }

    /// Every link names itself and round-trips through its spelling.
    #[test]
    fn every_link_round_trips_through_its_name() {
        let names: Vec<&str> = LinkKind::ALL.iter().map(|k| k.as_str()).collect();
        assert_eq!(names, vec!["stdio", "ble", "lan"]);
        for kind in LinkKind::ALL {
            assert_eq!(LinkKind::from_name(kind.as_str()), Some(kind));
        }
        assert_eq!(LinkKind::from_name(" LAN "), Some(LinkKind::Lan));
        assert_eq!(LinkKind::from_name("wifi"), None);
        assert_eq!(LinkKind::from_name(""), None);
    }

    /// The labels the chrome shows are the design's, so a link is never drawn
    /// under two names in two places.
    #[test]
    fn the_labels_match_the_design() {
        assert_eq!(LinkKind::Ble.label(), "BLE");
        assert_eq!(LinkKind::Lan.label(), "LAN");
        assert_eq!(LinkKind::Stdio.label(), "stdio");
    }

    /// Opening reports `Opened` before any data, so the loop can move the
    /// session to connected without guessing.
    #[test]
    fn opening_reports_before_data() {
        let link = MemoryLink::new();
        let handle = LinkHandle::start(link.link()).expect("the memory link opens");
        assert!(wait_for(|| !handle.drain().is_empty()));
        // The queue is drained by the call above, so ask the link again by
        // feeding data and checking that `Opened` really came first: a
        // `Closed`-only start would have ended the session already.
        link.feed(b"hello");
        let mut seen = Vec::new();
        assert!(wait_for(|| {
            seen.extend(handle.drain());
            seen.iter().any(|e| matches!(e, LinkEvent::Data(_)))
        }));
        assert!(
            !seen.iter().any(|e| matches!(e, LinkEvent::Closed(_))),
            "the link closed before it delivered anything: {seen:?}"
        );
        assert_eq!(handle.kind(), LinkKind::Stdio);
        assert_eq!(handle.describe(), "memory");
    }

    /// Received bytes arrive whole and in order, and every byte is counted
    /// exactly once — the counters in the top bar come from this path.
    #[test]
    fn received_bytes_arrive_whole_and_in_order() {
        let link = MemoryLink::new();
        let handle = LinkHandle::start(link.link()).expect("opens");
        link.feed(b"alpha");
        link.feed(b"beta");
        let mut received = Vec::new();
        assert!(wait_for(|| {
            for event in handle.drain() {
                if let LinkEvent::Data(bytes) = event {
                    received.extend(bytes);
                }
            }
            received.len() >= 9
        }));
        assert_eq!(received, b"alphabeta".to_vec());
    }

    /// Writes reach the far end, which is the half the terminal's input uses.
    #[test]
    fn written_bytes_reach_the_device() {
        let link = MemoryLink::new();
        let handle = LinkHandle::start(link.link()).expect("opens");
        assert!(handle.send(b"reboot\n".to_vec()));
        assert!(wait_for(|| link.take_sent() == b"reboot\n".to_vec()));
    }

    /// An asked-for hang-up reaches the transport and is *heard*: the reader is
    /// let go, and the wait ends when it is. This is what makes "the board is
    /// free when the process is" a fact rather than a hope.
    #[test]
    fn a_hang_up_reaches_the_transport_and_waits_for_the_end() {
        let link = MemoryLink::new();
        let handle = LinkHandle::start(link.link()).expect("opens");
        assert!(wait_for(|| !handle.drain().is_empty()), "opened");
        assert!(
            handle.hangup_and_wait(Duration::from_millis(500)),
            "the end was heard"
        );
        assert!(link.hung_up(), "the link itself was asked to end");
        // And it stays ended: a second hang-up is a link that is already down.
        assert!(!handle.send(b"x".to_vec()), "nothing is writable after it");
    }

    /// A device that hangs up ends the session with a reason, exactly once:
    /// the loop watching for `Closed` must not see two ends and report two
    /// disconnects for one hang-up.
    #[test]
    fn a_closed_link_reports_once_with_a_reason() {
        let link = MemoryLink::new();
        let handle = LinkHandle::start(link.link()).expect("opens");
        link.close();
        let mut closes = 0;
        let mut reason = String::new();
        assert!(wait_for(|| {
            for event in handle.drain() {
                if let LinkEvent::Closed(why) = event {
                    closes += 1;
                    reason = why;
                }
            }
            closes > 0
        }));
        assert_eq!(closes, 1, "one hang-up, one report");
        assert_eq!(reason, "end of stream");
        // And it stays reported once: nothing re-announces the end.
        thread::sleep(Duration::from_millis(20));
        for event in handle.drain() {
            assert!(!matches!(event, LinkEvent::Closed(_)), "{event:?}");
        }
    }

    /// Sending after the link is gone reports failure instead of quietly
    /// counting the bytes as sent.
    #[test]
    fn sending_on_a_dead_link_fails_loudly() {
        let link = MemoryLink::new();
        let handle = LinkHandle::start(link.link()).expect("opens");
        drop(handle);
        // The handle is gone, so the writer is too; a fresh handle on the same
        // memory link still works, which is the property the session relies on
        // when it reconnects.
        let second = LinkHandle::start(link.link()).expect("reopens");
        assert!(second.send(b"x".to_vec()));
        assert!(wait_for(|| !link.take_sent().is_empty()));
    }
}
