//! The session: one link, its state, and the counters the top bar shows.
//!
//! Everything that is *alive* lives here and nothing that is *painted* does.
//! `App` owns a `Session`, and once per tick it asks the session to fold
//! whatever the link produced into the frame's own fields. That is the whole
//! contract, and it is what keeps a frame a pure function of the state: the
//! event loop mutates, the pump observes, and the painters never see a channel
//! or a socket.

use std::io;
use std::time::Duration;

use crate::event::ConnectionState;
use crate::transport::ble::Selection;
use crate::transport::{Link, LinkEvent, LinkHandle, LinkKind, OpenedLink};

/// What the command line asked to dial.
///
/// The variants that need hardware are named here and refuse to open with a
/// message that says so, rather than being absent: a user who typed
/// `--transport ble` on a machine with no adapter gets told exactly that,
/// instead of a session that quietly does nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dial {
    /// A process bridge: the child's standard streams carry the device bytes.
    /// `-` is the built-in loopback device.
    Stdio(String),
    /// Bluetooth Low Energy. The [`Selection`] is which board to look for;
    /// [`Selection::Any`] takes the first Nordic UART service on the air, and
    /// a named or addressed one has to be found before anything is dialled.
    /// The second field is how long the whole dial may take: `None` is the
    /// radio's own patience, which is what an interface dial gets; a script
    /// that named `--connect-timeout` hands its own window down.
    Ble(Selection, Option<Duration>),
    /// The LAN socket, at `host`, with the token the bridge asks for. A token
    /// is optional because a bridge that was never given one does not ask; see
    /// `transport::lan`.
    Lan { host: String, token: Option<String> },
}

impl Dial {
    /// The link this dial describes, or the reason it cannot be built.
    pub fn open(&self) -> io::Result<Box<dyn Link>> {
        match self {
            Dial::Stdio(command) if command == "-" => {
                Ok(Box::new(crate::transport::stdio::StdioBridge::loopback()))
            }
            Dial::Stdio(command) => Ok(Box::new(crate::transport::stdio::StdioBridge::spawn(
                command.clone(),
            ))),
            // Checked before anything touches BlueZ: an address that cannot be
            // read is not the same event as a board that is switched off, and
            // turning one into the other would send the user to look at the
            // wrong thing. See `ble::Selection::reachable`.
            Dial::Ble(selection, within) => {
                if let Err(why) = selection.reachable() {
                    return Err(io::Error::new(io::ErrorKind::InvalidInput, why));
                }
                Ok(Box::new(
                    crate::transport::ble::BleLink::new(selection.clone()).within(*within),
                ))
            }
            // The token is part of the dial and never part of its description:
            // a description is shown and pasted, and a token that reaches a
            // screenshot has to be rotated.
            Dial::Lan { host, token } => {
                if let Err(why) = crate::transport::lan::validate_dial(host, token.as_deref()) {
                    return Err(io::Error::new(io::ErrorKind::InvalidInput, why));
                }
                Ok(Box::new(crate::transport::lan::LanLink::new(
                    host.clone(),
                    token.clone(),
                )))
            }
        }
    }

    /// The whole dial, on whatever thread calls it: the link is built *and*
    /// opened here, and what comes back is ready to be pumped.
    ///
    /// [`Dial::open`] stops one step short on purpose — the command line wants
    /// a description before anything touches a radio — but the interface wants
    /// the opposite: the wait paid where it can be afforded. See
    /// [`Session::adopt`].
    pub fn opened(&self) -> io::Result<OpenedLink> {
        OpenedLink::open(self.open()?)
    }

    /// The link kind this dial produces.
    pub fn kind(&self) -> LinkKind {
        match self {
            Dial::Stdio(_) => LinkKind::Stdio,
            Dial::Ble(..) => LinkKind::Ble,
            Dial::Lan { .. } => LinkKind::Lan,
        }
    }

    /// How the dial reads in a notice.
    pub fn describe(&self) -> String {
        match self {
            Dial::Stdio(command) => {
                crate::transport::stdio::StdioBridge::command_description(command)
            }
            Dial::Ble(selection, _) => format!("ble:{}", selection.label()),
            Dial::Lan { host, .. } => format!("lan:{}", crate::transport::lan::host_key(host)),
        }
    }
}

/// One live link, its state and its counters.
#[derive(Debug, Default)]
pub struct Session {
    handle: Option<LinkHandle>,
    state: Option<ConnectionState>,
    rx: u64,
    tx: u64,
    /// How the open link names itself, for the sidebar and the notices.
    describe: String,
    /// The LAN host behind a `Dial::Lan`, empty for any other link. Kept so the
    /// sidebar can show the address the bridge is actually on rather than the
    /// word "LAN", which is not a thing anybody can ping.
    lan_host: String,
    /// Whether the LAN link carries a token, which is the difference between a
    /// bridge that asks for one and one that would take anybody.
    lan_secured: bool,
    /// What kind of link is open. Kept because a management question is a
    /// question only one of the three can answer, and the caller that asks has
    /// no other way to know which.
    kind: LinkKind,
}

impl Session {
    /// A session with no link.
    pub fn new() -> Session {
        Session::default()
    }

    /// The connection state. `None` means "this session has never dialled", so
    /// a caller previewing a state (`--state`) is not overwritten by a session
    /// that has nothing to say.
    pub fn state(&self) -> Option<ConnectionState> {
        self.state
    }

    /// Bytes received.
    pub fn rx(&self) -> u64 {
        self.rx
    }

    /// Bytes sent.
    pub fn tx(&self) -> u64 {
        self.tx
    }

    /// Whether a link is open.
    pub fn is_live(&self) -> bool {
        self.handle.is_some()
    }

    /// How the open link names itself.
    pub fn describe(&self) -> &str {
        &self.describe
    }

    /// Whether this link can carry a management question at all.
    ///
    /// Only Bluetooth can, because only Bluetooth has a channel for it: the
    /// management service sits beside Nordic UART rather than inside it, and a
    /// WebSocket or a child process would have to tell a reply apart from
    /// whatever the target was printing. A caller that asks blindly gets
    /// `Unsupported` back, and the connect-time reads go through here first so
    /// that is not what happens three times in a row.
    pub fn can_manage(&self) -> bool {
        self.kind == LinkKind::Ble
    }

    /// The LAN address of the open link, empty for any other kind.
    pub fn lan_host(&self) -> &str {
        &self.lan_host
    }

    /// Whether the open link presented a LAN token.
    pub fn lan_secured(&self) -> bool {
        self.lan_secured
    }

    /// Open `link` and move to `connecting`. The link's threads report
    /// `Opened` on their own, so this only gets the session ready to listen.
    pub fn connect(&mut self, link: Box<dyn Link>) -> io::Result<()> {
        // Open here, on the calling thread, and take it: the command line and
        // the tests have nothing else on this thread to keep running. The
        // interface dials through [`Dial::opened`] and [`Session::adopt`]
        // instead, because its thread has a frame to draw.
        self.adopt(OpenedLink::open(link)?);
        Ok(())
    }

    /// Take a link that is already open.
    ///
    /// The same landing as [`Session::connect`], from halves that were paid for
    /// elsewhere — who pays is the caller's business, because the caller is the
    /// one who knows whether it can afford the wait. The link's own threads
    /// report `Opened` exactly as they do for a link this session opened
    /// itself.
    pub fn adopt(&mut self, opened: OpenedLink) {
        self.kind = opened.kind;
        self.lan_host = opened.lan_host.clone();
        self.lan_secured = opened.lan_secured;
        self.describe = opened.description.clone();
        let handle = LinkHandle::from_opened(opened);
        // Made reachable from *anywhere* on the way out, not just from this
        // session: the exits that most need the goodbye — a panic, a console
        // window being closed — never reach the session at all. See
        // [`crate::hangup`].
        crate::hangup::register(handle.ender());
        self.handle = Some(handle);
        self.state = Some(ConnectionState::Connecting);
    }

    /// Hang up. The session drops its own opinion of the state rather than
    /// recording a `Disconnected` of its own: hanging up is the *caller's*
    /// decision, and a session that kept claiming `Connected` after the handle
    /// was gone would drag the next frame back to a link that no longer exists.
    pub fn close(&mut self) {
        self.handle = None;
        self.state = None;
        self.describe.clear();
        // The link this session had is the one the last hang-up hook would
        // have ended; leaving it registered would point a later emergency exit
        // at a link that is already gone.
        crate::hangup::clear();
    }

    /// Hang up on the way out, and wait for the goodbye to land.
    ///
    /// [`Self::close`] drops the handle, which asks the transport to stop —
    /// and a process that exits in the same millisecond leaves the board
    /// connected to a client that no longer exists. This asks for the link
    /// itself to end where the bearer can end it, waits up to `grace` for the
    /// end to be *heard*, and only then lets the handle go. `true` means the
    /// link is down; `false` means the grace ran out with the reader still
    /// parked, which is as much as a blocking read can promise.
    pub fn hang_up(&mut self, grace: Duration) -> bool {
        let ended = match self.handle.as_ref() {
            Some(handle) => handle.hangup_and_wait(grace),
            None => true,
        };
        self.close();
        ended
    }

    /// Move the session to a state the caller decided (a failed dial).
    pub fn fail(&mut self) {
        self.state = Some(ConnectionState::Failed);
    }

    /// Take everything the link has produced since the last call. Folded into
    /// the counters and the state here; the payload events come back to be
    /// given to whatever shows the device's output.
    pub fn pump(&mut self) -> Vec<LinkEvent> {
        let Some(handle) = self.handle.take() else {
            return Vec::new();
        };
        let mut events = handle.drain();
        let mut ended = false;
        for event in &events {
            match event {
                LinkEvent::Opened => self.state = Some(ConnectionState::Connected),
                LinkEvent::Data(bytes) => self.rx += bytes.len() as u64,
                LinkEvent::Notice(_) => {}
                // Deliberately *not* counted. The receive counter is how much
                // the *target* has said, which is what the user asked to see
                // when they opened a terminal; folding the bridge's own
                // answers about itself into it would make the top bar drift
                // every time somebody asked for the firmware version.
                LinkEvent::Management(_) => {}
                LinkEvent::Closed(reason) => {
                    ended = true;
                    // A clean end is a hang-up; anything else is a failure.
                    // The session keeps whichever it was so the notice and the
                    // status dot agree.
                    self.state = Some(if reason == CLEAN_END {
                        ConnectionState::Disconnected
                    } else {
                        ConnectionState::Failed
                    });
                }
            }
        }
        if !ended {
            self.handle = Some(handle);
        } else {
            self.describe.clear();
        }
        // Only the payload events are the caller's business; the state and the
        // counters have already been folded in. A spoken `Notice` rides along
        // too: it changes nothing here, but it is something the user was told
        // and only the caller knows how to show it.
        events.retain(|event| !matches!(event, LinkEvent::Opened | LinkEvent::Closed(_)));
        events
    }

    /// Send bytes. `false` means there is no link, so the caller can say so
    /// instead of counting bytes that went nowhere.
    pub fn send(&mut self, bytes: &[u8]) -> bool {
        let Some(handle) = &self.handle else {
            return false;
        };
        if bytes.is_empty() {
            return true;
        }
        if handle.send(bytes.to_vec()) {
            self.tx += bytes.len() as u64;
            true
        } else {
            false
        }
    }

    /// Send one management frame — a question for the bridge rather than a
    /// keystroke for the target. `false` means there is no link.
    ///
    /// Not counted against `tx`, for the same reason a management answer is not
    /// counted against `rx`: the counters describe the target conversation, and
    /// a question sent to the bridge is not part of it.
    pub fn send_management(&mut self, frame: Vec<u8>) -> bool {
        let Some(handle) = &self.handle else {
            return false;
        };
        handle.send_management(frame)
    }
}

/// The reason the reader reports for an orderly end of stream. Kept as a
/// constant so the "clean hang-up" test cannot drift from the string the
/// transport sends.
pub const CLEAN_END: &str = "end of stream";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::testing::MemoryLink;
    use std::thread;
    use std::time::{Duration, Instant};

    /// Pump until `predicate` holds. The session only learns anything when it
    /// is pumped, so a test that waited on a field without pumping would wait
    /// for something that can never happen.
    fn pump_until(session: &mut Session, mut predicate: impl FnMut(&Session) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            session.pump();
            if predicate(session) {
                return true;
            }
            thread::sleep(Duration::from_millis(1));
        }
        session.pump();
        predicate(session)
    }

    /// Pump until `want` bytes have arrived, returning what did arrive.
    fn pump_bytes(session: &mut Session, want: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            for event in session.pump() {
                if let LinkEvent::Data(chunk) = event {
                    bytes.extend(chunk);
                }
            }
            if bytes.len() >= want {
                break;
            }
            thread::sleep(Duration::from_millis(1));
        }
        bytes
    }

    /// A session that has never dialled says nothing about the state, so a
    /// frame previewed with `--state` keeps the state it was asked for.
    #[test]
    fn a_fresh_session_has_no_state_of_its_own() {
        let mut session = Session::new();
        assert_eq!(session.state(), None);
        assert_eq!(session.rx(), 0);
        assert_eq!(session.tx(), 0);
        assert!(!session.is_live());
        assert!(session.pump().is_empty());
    }

    /// Dialling moves through connecting to connected, and the bytes that
    /// arrive are counted exactly once.
    #[test]
    fn dialling_reaches_connected_and_counts_what_arrives() {
        let link = MemoryLink::new();
        let mut session = Session::new();
        session.connect(link.link()).expect("opens");
        assert_eq!(session.state(), Some(ConnectionState::Connecting));
        assert!(session.is_live());
        assert_eq!(session.describe(), "memory");

        assert!(pump_until(&mut session, |s| s.state()
            == Some(ConnectionState::Connected)));

        link.feed(b"hello");
        let received = pump_bytes(&mut session, 5);
        assert_eq!(received, b"hello".to_vec());
        assert_eq!(session.rx(), 5, "the counter matches the payload");
        assert_eq!(session.tx(), 0);
    }

    /// Leaving the process ends the link, and the end is waited for: the
    /// messaging is what frees the board for the next client, so a session
    /// that only dropped its handle would leave a board connected to a client
    /// that no longer exists.
    #[test]
    fn hanging_up_ends_the_link_out_loud_and_is_heard() {
        let link = MemoryLink::new();
        let mut session = Session::new();
        session.connect(link.link()).expect("opens");
        assert!(pump_until(&mut session, |s| s.state()
            == Some(ConnectionState::Connected)));
        assert!(session.hang_up(Duration::from_millis(500)), "heard");
        assert!(link.hung_up(), "the transport was asked to end the link");
        assert!(!session.is_live());
        assert_eq!(session.state(), None, "no opinion survives a hang-up");
        // And a second hang-up is a session with nothing left to hang up.
        assert!(session.hang_up(Duration::from_millis(50)));
    }

    /// Sending moves the transmit counter by exactly the bytes handed over,
    /// and reports failure when there is no link instead of counting them.
    #[test]
    fn sending_counts_bytes_and_refuses_without_a_link() {
        let mut idle = Session::new();
        assert!(!idle.send(b"nope"), "no link, no send");
        assert_eq!(idle.tx(), 0, "nothing was counted");

        let link = MemoryLink::new();
        let mut session = Session::new();
        session.connect(link.link()).expect("opens");
        assert!(session.send(b"reboot\n"));
        assert_eq!(session.tx(), 7);
        // An empty send is a no-op that still succeeds: nothing to write is
        // not an error.
        assert!(session.send(b""));
        assert_eq!(session.tx(), 7);
    }

    /// A clean end of stream is a hang-up, not a failure — the two read very
    /// differently in the status dot and must not be conflated.
    #[test]
    fn a_clean_hang_up_is_disconnected_not_failed() {
        let link = MemoryLink::new();
        let mut session = Session::new();
        session.connect(link.link()).expect("opens");
        assert!(pump_until(&mut session, |s| s.state()
            == Some(ConnectionState::Connected)));

        link.close();
        assert!(pump_until(&mut session, |s| s.state()
            == Some(ConnectionState::Disconnected)));
        assert!(!session.is_live(), "the link is gone");
        assert_eq!(session.describe(), "", "and it no longer names itself");
        assert!(session.pump().is_empty());
        assert!(!session.send(b"anyone there?"));
    }

    /// Every dial can now be built. There was a time when most of them could
    /// not, and each of those answered `Unsupported` with "use --bridge for
    /// now" — a message that kept the product usable while there was one link
    /// and became wrong the day the others arrived.
    ///
    /// What is left of that is each link's own refusal of what it cannot dial:
    /// [`Self::an_unreadable_ble_address`] for Bluetooth,
    /// [`Self::a_lan_dial_without_an_address_is_refused_first`] for the socket,
    /// and `transport::serial`'s tests for the port. None of them pretend the
    /// link does not exist.
    #[test]
    fn every_dial_builds_into_a_link_it_can_describe() {
        let dials = [
            Dial::Stdio("cat".into()),
            Dial::Ble(Selection::Address("EE:C7:42:34:48:CF".into()), None),
            Dial::Lan {
                host: "192.168.0.44".into(),
                token: None,
            },
        ];
        for dial in dials {
            let describe = dial.describe();
            assert!(!describe.is_empty(), "{dial:?} has nothing to say");
            let expected = dial.kind();
            let link = dial.open().expect("every dial builds a link");
            assert_eq!(link.kind(), expected, "{describe}");
        }
    }

    /// A LAN dial with no address is refused before a socket is opened, and the
    /// refusal is about the address rather than about the network.
    #[test]
    fn a_lan_dial_without_an_address_is_refused_first() {
        // A `Result<Box<dyn Link>, _>` cannot be `expect_err`ed: a trait object
        // has no `Debug`, and making the link printable only so a test can fail
        // on it is the wrong way round.
        let open = Dial::Lan {
            host: "  ".to_string(),
            token: None,
        }
        .open();
        let err = match open {
            Ok(_) => panic!("no host, no dial"),
            Err(err) => err,
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("address"), "{err}");
    }

    /// A Bluetooth dial that names nothing readable is refused before the
    /// radio is touched. Otherwise a mistyped address becomes ten seconds of
    /// scanning followed by "no device found" — a report indistinguishable
    /// from the board being switched off, sending the user to the wrong end
    /// of the bench.
    #[test]
    fn an_unreadable_ble_address_is_refused_before_the_radio() {
        for dial in [
            Dial::Ble(Selection::Address("not-an-address".to_string()), None),
            Dial::Ble(Selection::Address("::".to_string()), None),
        ] {
            let err = match dial.open() {
                Ok(_) => panic!("{dial:?} dialled a radio for an address with no digits"),
                Err(err) => err,
            };
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{dial:?}");
            assert!(
                err.to_string().contains("not a Bluetooth address"),
                "the message does not say what is wrong: {err}"
            );
        }
    }

    /// The dials describe themselves the way the notices read.
    #[test]
    fn a_dial_describes_itself() {
        assert_eq!(Dial::Stdio("cat".into()).describe(), "stdio: cat");
        assert_eq!(Dial::Stdio("-".into()).describe(), "stdio: -");
        assert_eq!(Dial::Stdio("cat".into()).kind(), LinkKind::Stdio);
        assert_eq!(Dial::Ble(Selection::Any, None).kind(), LinkKind::Ble);
        // And a Bluetooth dial names the board it is looking for, which is
        // what makes two boards on one bench tellable apart.
        assert_eq!(
            Dial::Ble(Selection::Address("ee:c7:42:34:48:cf".into()), None).describe(),
            "ble:EE:C7:42:34:48:CF"
        );
    }

    /// A LAN dial describes the bridge it dials and never the token it dials
    /// with: the description goes into notices, the sidebar and bug reports.
    #[test]
    fn a_lan_dial_keeps_its_token_out_of_its_description() {
        let token = "0123456789abcdef0123456789abcdef";
        let dial = Dial::Lan {
            host: "ws://192.168.0.44/ws".into(),
            token: Some(token.into()),
        };
        assert_eq!(dial.describe(), "lan:192.168.0.44");
        assert!(!dial.describe().contains(token));
        assert_eq!(dial.kind(), LinkKind::Lan);
    }
}
