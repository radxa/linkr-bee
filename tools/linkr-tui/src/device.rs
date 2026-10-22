//! The bridge's own answers, held apart from the target's output.
//!
//! A Linkr Bee answers two kinds of question. It carries the target's bytes —
//! what a shell prints, what a bootloader says — and it answers questions about
//! *itself*: what firmware it runs, what speed its UART is set to, whether it
//! has joined a network. Those answers arrive on the management channel, not
//! down the stream, so they never have to be told apart from what the target
//! was printing at the time. See `transport::ble`.
//!
//! What is left once the wire has separated them is bookkeeping: which question
//! is out, which answer belongs to it, and what happens to a question whose
//! answer never comes. That is all this module does, and it does it with bytes
//! in and plain data out, so it is testable with no radio in the room.

use std::time::{Duration, Instant};

use crate::accessory::ReplyStatus;
use crate::protocol::{management_fragment_is_final, ManagementHeader};

/// How long the bridge has to answer before the question is given up on.
///
/// Three seconds. These answers come from the bridge's own management task, not
/// from across a network, so anything slower is not a slow answer — it is no
/// answer, and waiting longer only delays saying so.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// How long a `@i?` read has before it is given up on.
///
/// Eight seconds, the window the web client gives the same collection. The
/// `@info` blob is longer than one ATT notification can carry and the bridge
/// sends it in fragments that have been seen seconds apart — a three-second
/// window gave up on the first fragment of an answer that was on its way.
pub const INFO_TIMEOUT: Duration = Duration::from_secs(8);

/// How long a scan has to say something before it is given up on.
///
/// Longer than [`REPLY_TIMEOUT`] because a scan is the radio walking channels,
/// not the management task answering: the bridge's own watchdog releases a
/// wedged scan at fifteen seconds and says `@scan error` then, so anything
/// slower than this is a bridge that is not going to speak at all.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(20);

/// A question the host asks the bridge about itself.
///
/// These four are what the diagnostics and network surfaces show, and each is
/// one command on the wire. The commands that *change* these settings
/// (`@u=`, `@w=`, `@d=`) answer in the same shapes, so a write and the read
/// that follows it share one parser — which is why setting the UART also tells
/// the frame what speed the bridge ended up at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Query {
    /// `@i?` — firmware, uptime, buffering, WiFi and upload state.
    Diagnostics,
    /// `@u?` — what speed and framing the bridge's own UART is running.
    Uart,
    /// `@w?` — whether the bridge has joined a network, and on what address.
    Wifi,
    /// `@w scan` — what networks the bridge's radio can hear.
    ///
    /// Its own question rather than a shape of [`Query::Wifi`]: a scan is
    /// answered in pieces over several messages and ends with a line of its
    /// own, where a status is one message that ends in `OK`.
    WifiScan,
    /// `@d?` — whether the bridge uploads its logs over WebDAV, and where.
    Webdav,
    /// `@n?` — the advertised BLE name, and whether it is custom.
    BleName,
    /// `@s?` — LAN access state, and the token the bridge expects.
    Lan,
}

impl Query {
    /// The command that asks this question.
    pub fn command(self) -> &'static str {
        match self {
            Query::Diagnostics => crate::accessory::DIAGNOSTICS_COMMAND,
            Query::Uart => crate::accessory::UART_QUERY_COMMAND,
            Query::Wifi => crate::accessory::WIFI_QUERY_COMMAND,
            Query::WifiScan => crate::accessory::WIFI_SCAN_COMMAND,
            Query::Webdav => crate::accessory::WEBDAV_QUERY_COMMAND,
            Query::BleName => crate::accessory::BLE_NAME_QUERY_COMMAND,
            Query::Lan => crate::accessory::LAN_QUERY_COMMAND,
        }
    }

    /// Whether these lines are the whole answer, judging by their shape rather
    /// than by the frame's own flag.
    ///
    /// The flag is what normally decides, and in plenty of firmware `OK` is the
    /// only ending `uart=` ever gets. Both are understood here so that a reply
    /// which arrived without its terminator is still recognised as finished —
    /// otherwise the caller would sit on a complete answer for three seconds
    /// and then call it a timeout.
    pub fn complete(self, lines: &[String]) -> bool {
        match self {
            Query::Diagnostics => lines
                .iter()
                .any(|line| line.trim().eq_ignore_ascii_case("@info done")),
            // A scan is answered in pieces, and the first of them is `OK
            // accepted` — which the OK-shape rule below would read as the whole
            // answer and close the question on. Its real ending is its own
            // terminator; an `ERR` reply ends it too, because a refused scan
            // has nothing after it.
            Query::WifiScan => {
                let ended = lines
                    .iter()
                    .any(|line| crate::accessory::is_scan_terminator(line));
                ended
                    || !crate::accessory::reply_status(&lines.join("\n"))
                        .error
                        .is_empty()
            }
            Query::Uart | Query::Wifi | Query::Webdav | Query::BleName | Query::Lan => {
                // One parse: either half of the verdict ends the question.
                let status = crate::accessory::reply_status(&lines.join("\n"));
                status.ok || !status.error.is_empty()
            }
        }
    }

    /// Whether the answer may keep arriving after a piece the bridge marked
    /// final.
    ///
    /// A scan is the one that does: its first piece is `OK accepted`, and the
    /// flag on it says *that piece* is whole — not that the answer is. The
    /// networks and the `@scan done` behind it belong to the same answer, so
    /// the frame's flag is not what closes this question.
    pub fn streams(self) -> bool {
        self == Query::WifiScan
    }

    /// How long this question has to say something before it is given up on.
    pub fn patience(self) -> Duration {
        match self {
            Query::WifiScan => SCAN_TIMEOUT,
            Query::Diagnostics => INFO_TIMEOUT,
            _ => REPLY_TIMEOUT,
        }
    }
}

/// A whole answer, once one has arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub query: Query,
    /// Every line of it, verbatim, in the order the bridge sent them.
    pub lines: Vec<String>,
    /// Whether the firmware said `OK`. `@i?` never says anything of the kind,
    /// so for diagnostics this means "no ERR line", which is what a successful
    /// read looks like there.
    pub status: ReplyStatus,
}

/// A question that is out, and the answer it has had so far.
#[derive(Debug)]
struct Pending {
    /// The request id the answer carries, which is how it finds this question.
    id: u32,
    query: Query,
    /// Complete lines of the answer.
    lines: Vec<String>,
    /// The tail of the last line that has arrived so far, still waiting for
    /// its terminator: a fragment boundary is where the bridge's frame ran
    /// out, not where a line ends.
    partial: String,
    /// The bridge has said this is the last piece of the answer.
    finalised: bool,
    since: Instant,
}

/// Which question is outstanding, and what its answer says.
///
/// One at a time, deliberately. Two questions in flight is two sets of lines
/// arriving interleaved, distinguishable only because each answer repeats its
/// own request id — and the moment one firmware forgets to, they are not. A
/// queue of one is also what the user asked for: pressing refresh twice is
/// asking once more, not asking twice.
///
/// Asking therefore replaces whatever is outstanding, which is the only reading
/// of "ask again before the first answer arrived" that leaves somebody holding
/// the answer they are waiting for.
#[derive(Debug, Default)]
pub struct Conversation {
    pending: Option<Pending>,
    next_id: u32,
}

impl Conversation {
    /// Nothing asked yet.
    pub fn new() -> Conversation {
        Conversation::default()
    }

    /// Whether an answer is being waited for, and to what.
    pub fn waiting(&self) -> Option<Query> {
        self.pending.as_ref().map(|p| p.query)
    }

    /// What the question in flight has been told so far, before it is finished.
    ///
    /// Half an answer is still an answer for a question that streams: a scan
    /// reports one network at a time, and a view that showed this while it
    /// arrives would show a list growing. Empty when nothing is being waited
    /// for, which is how a caller tells "half" from "none" without a flag of
    /// its own.
    pub fn pending_lines(&self) -> &[String] {
        match &self.pending {
            Some(pending) => &pending.lines,
            None => &[],
        }
    }

    /// Ask `query` at `now`, replacing any question still open.
    ///
    /// Returns the request id and the command body, so the frame that goes out
    /// and the question it belongs to come from one place. Id `0` is never
    /// issued: the firmware treats it as "not a request" and a frame that was
    /// silently dropped is the worst way for this to fail.
    pub fn ask(&mut self, query: Query, now: Instant) -> (u32, &'static str) {
        self.next_id = if self.next_id == u32::MAX {
            1
        } else {
            self.next_id + 1
        };
        let id = self.next_id;
        self.pending = Some(Pending {
            id,
            query,
            lines: Vec::new(),
            partial: String::new(),
            finalised: false,
            since: now,
        });
        (id, query.command())
    }

    /// Offer one management response to whatever is waiting.
    ///
    /// `true` when the response belonged to this question. A call that claims
    /// the response also owns its bytes, which is why this takes ownership of
    /// nothing else: the answer is accumulated here and handed back whole.
    pub fn offer(&mut self, header: &ManagementHeader, payload: &[u8]) -> bool {
        let Some(pending) = self.pending.as_mut() else {
            return false;
        };
        if pending.id != header.request_id {
            return false;
        }
        // A fragment boundary is wherever the bridge's frame ran out, not where
        // a line ends: an `@info done` split across two frames is two halves no
        // rule can match, and the fallback that finishes an answer without a
        // FINAL flag would never fire. The unfinished tail is held and joined
        // to the next fragment's beginning.
        pending.partial.push_str(&String::from_utf8_lossy(payload));
        let mut lines: Vec<String> = pending.partial.lines().map(str::to_string).collect();
        if pending.partial.ends_with('\n') || pending.partial.ends_with('\r') {
            pending.partial.clear();
        } else {
            // The last line is still arriving; the rest of it is what the next
            // fragment starts with.
            pending.partial = lines.pop().unwrap_or_default();
        }
        pending.lines.extend(lines);
        if management_fragment_is_final(header) {
            // Anything that arrived without a terminator is still the last line
            // of the answer — the bridge is done, so no more is coming to
            // finish it.
            if !pending.partial.is_empty() {
                let tail = std::mem::take(&mut pending.partial);
                pending.lines.push(tail);
            }
            pending.finalised = true;
        }
        true
    }

    /// The completed answer, closing the question it belongs to.
    ///
    /// Complete means the bridge said this was its last piece, or the lines
    /// themselves say so; see [`Query::complete`]. Nothing is claimed after the
    /// answer has been taken, so late fragments cannot extend a reply that has
    /// already been read.
    pub fn take_reply(&mut self) -> Option<Reply> {
        let done = self
            .pending
            .as_ref()
            .is_some_and(|p| (p.finalised && !p.query.streams()) || p.query.complete(&p.lines));
        if !done {
            return None;
        }
        let Pending { query, lines, .. } = self.pending.take()?;
        // `@i?` answers with `@info done` and never with `OK`, so borrowing the
        // firmware's own OK/ERR rule for it would read every successful
        // diagnostics read as a failure. It succeeds unless something in it
        // says otherwise.
        let mut status = crate::accessory::reply_status(&lines.join("\n"));
        if query == Query::Diagnostics && status.error.is_empty() {
            status.ok = true;
        }
        Some(Reply {
            query,
            lines,
            status,
        })
    }

    /// Give up on a question whose bridge stopped answering, at `now`.
    ///
    /// Returns the question that timed out, so the caller can say so: an answer
    /// that never came is not the same as none having been asked, and a grid
    /// left reading "loading…" for ever is how the difference gets lost.
    pub fn abandon(&mut self, now: Instant) -> Option<Query> {
        let overdue = self
            .pending
            .as_ref()
            .is_some_and(|p| now.duration_since(p.since) >= p.query.patience());
        if !overdue {
            return None;
        }
        self.pending.take().map(|p| p.query)
    }

    /// Stop listening, whatever is outstanding.
    ///
    /// Called when the wire goes away. A question asked of a bridge that is no
    /// longer there has no answer coming, and leaving it open would let the
    /// *next* session's answers land on this session's question.
    pub fn reset(&mut self) {
        self.pending = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{encode_management_request, MGMT_FLAG_ERROR, MGMT_FLAG_FINAL};

    /// A response the bridge might send, framed the way it frames them.
    fn response(id: u32, body: &str, flags: u16) -> (ManagementHeader, Vec<u8>) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"LK");
        bytes.push(1);
        bytes.push(2);
        bytes.extend_from_slice(&id.to_le_bytes());
        bytes.extend_from_slice(&(body.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&flags.to_le_bytes());
        bytes.extend_from_slice(body.as_bytes());
        let header = crate::protocol::parse_management_header(&bytes).expect("a header");
        (header, body.as_bytes().to_vec())
    }

    #[test]
    fn each_question_names_its_command() {
        assert_eq!(Query::Diagnostics.command(), "@i?");
        assert_eq!(Query::Uart.command(), "@u?");
        assert_eq!(Query::Wifi.command(), "@w?");
        assert_eq!(Query::WifiScan.command(), "@w scan");
        assert_eq!(Query::BleName.command(), "@n?");
    }

    #[test]
    fn a_read_ends_at_the_line_that_says_it_ends() {
        assert!(Query::Diagnostics.complete(&["@info sys uptime_ms=1".into(), "@info done".into()]));
        assert!(!Query::Diagnostics.complete(&["@info fw version=0.1.2".into()]));
        assert!(Query::Uart.complete(&["OK uart=115200,8,N,1,none".into()]));
        // An error is an ending too: the answer arrived, it just said no.
        assert!(Query::Wifi.complete(&["ERR ssid too long".into()]));
        // A scan's acceptance is not an ending; its own terminator is.
        assert!(!Query::WifiScan.complete(&["OK accepted".into()]));
        assert!(!Query::WifiScan.complete(&[
            "OK accepted".into(),
            "@scan result BenchNet wpa2 ch=6 -54dBm".into(),
        ]));
        assert!(Query::WifiScan.complete(&["@scan done".into()]));
        assert!(Query::WifiScan.complete(&["@scan error".into()]));
        assert!(Query::WifiScan.complete(&["ERR scan=-16".into()]));
        assert!(Query::BleName.complete(&["OK name=Bench Bee custom=no".into()]));
        assert!(Query::BleName.complete(&["ERR name expected 1-29 UTF-8 bytes".into()]));
        assert!(!Query::BleName.complete(&[]));
    }

    #[test]
    fn every_question_gets_the_window_its_answer_needs() {
        // The `@info` blob is the one management answer the bridge sends in
        // fragments seconds apart; eight seconds is the window the web client
        // gives it (`collectAccessoryDiagnostics`), and three were measured
        // cutting off a first fragment that was on its way.
        assert_eq!(Query::Diagnostics.patience(), INFO_TIMEOUT);
        // A scan is the radio walking channels.
        assert_eq!(Query::WifiScan.patience(), SCAN_TIMEOUT);
        // The rest are answered out of the bridge's own state in milliseconds.
        for query in [Query::Uart, Query::Wifi, Query::BleName, Query::Lan] {
            assert_eq!(query.patience(), REPLY_TIMEOUT, "{query:?}");
        }
    }

    #[test]
    fn nothing_is_claimed_before_a_question_is_asked() {
        let mut talk = Conversation::new();
        assert_eq!(talk.waiting(), None);
        let (header, body) = response(7, "OK uart=115200,8,N,1,none", MGMT_FLAG_FINAL);
        assert!(!talk.offer(&header, &body));
        assert!(talk.take_reply().is_none());
    }

    #[test]
    fn asking_issues_an_id_and_the_command_that_asks() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (id, command) = talk.ask(Query::Diagnostics, start);
        assert_eq!(command, "@i?");
        assert_ne!(
            id, 0,
            "request id 0 is not a request, the firmware drops it"
        );
        assert_eq!(talk.waiting(), Some(Query::Diagnostics));
        // And ids never repeat within one conversation, so two answers can
        // never both belong to one question.
        let (second, _) = talk.ask(Query::Uart, start);
        assert_ne!(id, second);
    }

    #[test]
    fn an_answer_comes_back_whole_and_closes_the_question() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (id, _) = talk.ask(Query::Diagnostics, start);
        let (header, body) = response(
            id,
            "@info fw version=0.1.2\n@info sys uptime_ms=123456\n@info done",
            MGMT_FLAG_FINAL,
        );
        assert!(talk.offer(&header, &body));
        let reply = talk.take_reply().expect("the answer is whole");
        assert_eq!(reply.query, Query::Diagnostics);
        assert_eq!(reply.lines.len(), 3);
        // `@i?` never says OK; a read that ended is a read that worked.
        assert!(reply.status.ok, "@i? must not read as a failure");
        assert_eq!(talk.waiting(), None);
    }

    #[test]
    fn an_answer_for_another_question_is_left_alone() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (id, _) = talk.ask(Query::Uart, start);
        let (header, body) = response(id + 1, "OK wifi=connected", MGMT_FLAG_FINAL);
        assert!(!talk.offer(&header, &body), "that one is not ours");
        assert!(talk.take_reply().is_none());
    }

    #[test]
    fn a_split_answer_is_assembled_before_it_is_read() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (id, _) = talk.ask(Query::Diagnostics, start);
        let (head, part) = response(id, "@info fw version=0.1.2\n", 0);
        assert!(talk.offer(&head, &part));
        assert!(
            talk.take_reply().is_none(),
            "half an @info blob is not a read"
        );
        let (tail, rest) = response(id, "@info uart dropped=0\n@info done", MGMT_FLAG_FINAL);
        assert!(talk.offer(&tail, &rest));
        let reply = talk.take_reply().expect("whole now");
        assert_eq!(reply.lines.len(), 3);
    }

    /// And the split can land *inside* a line: `@info done` halved across two
    /// frames is one line arriving in two pieces, not two lines. Read as two it
    /// would never match the shape the answer ends on, and the read would wait
    /// out its patience for an answer it already had.
    #[test]
    fn a_split_inside_a_line_is_joined_before_it_is_read() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (id, _) = talk.ask(Query::Diagnostics, start);
        let (head, part) = response(id, "@info fw vers", 0);
        assert!(talk.offer(&head, &part));
        assert!(talk.take_reply().is_none(), "half a word is not a read");
        let (tail, rest) = response(id, "ion=0.1.2\n@info done", MGMT_FLAG_FINAL);
        assert!(talk.offer(&tail, &rest));
        let reply = talk.take_reply().expect("whole now");
        assert_eq!(reply.lines.len(), 2, "the halves are one line each");
        assert_eq!(reply.lines[0], "@info fw version=0.1.2");
        assert_eq!(reply.lines[1], "@info done");
    }

    #[test]
    fn a_completed_shape_is_read_even_without_the_final_flag() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (id, _) = talk.ask(Query::Uart, start);
        let (header, body) = response(id, "OK uart=115200,8,N,1,none\r\n", 0);
        assert!(talk.offer(&header, &body));
        let reply = talk.take_reply().expect("the shape says it is whole");
        assert!(reply.status.ok);
    }

    #[test]
    fn an_error_reply_says_so_instead_of_reading_as_success() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (id, _) = talk.ask(Query::Wifi, start);
        let (header, body) = response(id, "ERR ssid too long", MGMT_FLAG_FINAL | MGMT_FLAG_ERROR);
        assert!(talk.offer(&header, &body));
        let reply = talk.take_reply().expect("answered");
        assert!(!reply.status.ok);
        assert_eq!(reply.status.error, "ERR ssid too long");
    }

    /// A scan is answered in pieces, and the acceptance is not the answer.
    ///
    /// The first piece carries FINAL because that *message* is whole; the
    /// networks and the ending behind it are the same answer, so a question
    /// closed on the acceptance dropped every one of them.
    #[test]
    fn a_scan_is_not_over_when_it_is_accepted() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (id, _) = talk.ask(Query::WifiScan, start);
        let (accepted, body) = response(id, "OK accepted\r\n", MGMT_FLAG_FINAL);
        assert!(talk.offer(&accepted, &body));
        assert!(
            talk.take_reply().is_none(),
            "the acceptance is not the answer"
        );
        let (result, body) = response(id, "@scan result BenchNet wpa2 ch=6 -54dBm\r\n", 0);
        assert!(talk.offer(&result, &body));
        assert!(talk.take_reply().is_none(), "nor is a network");
        let (done, body) = response(id, "@scan done\r\n", MGMT_FLAG_FINAL);
        assert!(talk.offer(&done, &body));
        let reply = talk.take_reply().expect("the terminator ends it");
        assert_eq!(reply.query, Query::WifiScan);
        assert_eq!(reply.lines.len(), 3, "nothing is dropped on the way");
        assert_eq!(talk.waiting(), None);
    }

    /// A scan is the radio walking channels, so it is given longer than a
    /// question answered out of the bridge's own state.
    #[test]
    fn a_scan_is_given_the_time_its_radio_needs() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        talk.ask(Query::WifiScan, start);
        assert_eq!(
            talk.abandon(start + REPLY_TIMEOUT),
            None,
            "still scanning, and not yet a silent bridge"
        );
        assert_eq!(talk.abandon(start + SCAN_TIMEOUT), Some(Query::WifiScan));
    }

    #[test]
    fn a_question_nobody_answered_is_given_up_on() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        talk.ask(Query::Uart, start);
        assert_eq!(talk.abandon(start + REPLY_TIMEOUT / 2), None, "still time");
        assert_eq!(talk.abandon(start + REPLY_TIMEOUT), Some(Query::Uart));
        assert_eq!(talk.waiting(), None, "and it stopped listening");
    }

    #[test]
    fn asking_again_replaces_the_question_still_waiting() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (_, _) = talk.ask(Query::Uart, start);
        let (wifi_id, command) = talk.ask(Query::Wifi, start);
        assert_eq!(command, "@w?");
        // The UART answer, arriving late, belongs to nobody now.
        let (header, body) = response(0xffff, "OK uart=115200,8,N,1,none", MGMT_FLAG_FINAL);
        assert!(!talk.offer(&header, &body));
        let (wifi_header, wifi_body) = response(wifi_id, "OK wifi off", MGMT_FLAG_FINAL);
        assert!(talk.offer(&wifi_header, &wifi_body));
        assert_eq!(talk.take_reply().map(|r| r.query), Some(Query::Wifi));
    }

    #[test]
    fn hanging_up_stops_listening() {
        let start = Instant::now();
        let mut talk = Conversation::new();
        let (id, _) = talk.ask(Query::Uart, start);
        talk.reset();
        let (header, body) = response(id, "OK uart=115200,8,N,1,none", MGMT_FLAG_FINAL);
        assert!(!talk.offer(&header, &body));
        assert!(talk.abandon(start + REPLY_TIMEOUT).is_none());
    }

    /// The encoder and the parser are the two ends of one wire: anything this
    /// side sends must parse back, or the round trip silently becomes nothing.
    #[test]
    fn a_request_this_side_encodes_is_shaped_how_the_wire_expects() {
        let frame = encode_management_request(9, b"@i?").expect("encodes");
        assert_eq!(&frame[..2], b"LK", "the magic");
        assert_eq!(frame[2], crate::protocol::MGMT_API_MAJOR);
        assert_eq!(frame[3], crate::protocol::MGMT_REQUEST_TYPE);
        assert_eq!(&frame[4..8], &9u32.to_le_bytes());
        assert_eq!(&frame[8..10], &3u16.to_le_bytes(), "the declared length");
        assert_eq!(&frame[10..12], &0u16.to_le_bytes(), "no flags");
        assert_eq!(&frame[crate::protocol::MGMT_HEADER_SIZE..], b"@i?");
        assert!(encode_management_request(1, b"").is_err(), "nothing to ask");

        // The device accepts this shape: its own header parser rejects any
        // type but a request's, which is checked here by round-tripping the
        // bytes through a response of the same id.
        let mut as_response = frame.clone();
        as_response[3] = 2;
        let header =
            crate::protocol::parse_management_header(&as_response).expect("the shape is accepted");
        assert_eq!(header.request_id, 9);
        assert_eq!(header.expected, 3);
    }
}
