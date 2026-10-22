//! The Linkr Bee wire protocols, carried over from `web/management_protocol.js`.
//!
//! Both framing schemes — the BLE management channel and the Reliable UART
//! stream — put their whole header in the first fragment and send the remaining
//! payload bytes bare, so reassembly is shared. Every function here is pure:
//! bytes in, a decision out, no socket, no clock, no session. That is what lets
//! the parser be pinned to the wire byte for byte in tests.
//!
//! The error vocabulary is deliberately user-visible: a frame rejection maps to
//! the message the terminal shows, so the reason strings are the same ones the
//! web client words through `MGMT_FRAME_ERRORS` / `RELIABLE_FRAME_ERRORS`.

// --- constants --------------------------------------------------------------

/// `MGMT_FLAG_FINAL` — the final fragment of a logical message.
pub const MGMT_FLAG_FINAL: u16 = 1 << 0;
/// `MGMT_FLAG_ERROR` — the message carries an error.
pub const MGMT_FLAG_ERROR: u16 = 1 << 1;

/// The management header is 12 bytes.
pub const MGMT_HEADER_SIZE: usize = 12;
/// The management API major version the host speaks.
pub const MGMT_API_MAJOR: u8 = 1;

/// The message type of a request: host to bridge.
///
/// Responses come back as `2` and unsolicited progress events as `3`, both of
/// which [`parse_management_header`] accepts. This side only ever *sends* the
/// one type, and naming it is what keeps the encoder from inventing another.
pub const MGMT_REQUEST_TYPE: u8 = 1;

/// The Reliable UART header is 12 bytes.
pub const RELIABLE_UART_HEADER_SIZE: usize = 12;
/// The Reliable UART API major version.
pub const RELIABLE_UART_API_MAJOR: u8 = 1;
/// The largest payload a single Reliable UART frame may declare.
pub const RELIABLE_UART_MAX_PAYLOAD: usize = 232;

/// `"LK"` — the management magic.
const MGMT_MAGIC: [u8; 2] = [0x4c, 0x4b];
/// `"LR"` — the Reliable UART magic.
const RELIABLE_MAGIC: [u8; 2] = [0x4c, 0x52];

// --- headers ----------------------------------------------------------------

/// The reason a frame was rejected. Each variant carries the user-visible
/// wording, matching the web client's error tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// Fewer bytes than a header arrived.
    ShortHeader,
    /// The magic bytes do not match.
    BadMagic,
    /// The API major version is not one the host understands.
    BadVersion,
    /// The message type is not a management response type.
    BadType,
    /// The declared length is zero, oversized, or otherwise untrustworthy.
    BadLength,
    /// A fragment pushed the reassembly past the declared length.
    Oversized,
}

impl FrameError {
    /// The sentence the terminal shows for this rejection.
    pub fn message(self, reliable: bool) -> &'static str {
        if reliable {
            match self {
                FrameError::ShortHeader => "orphaned Reliable UART fragment",
                FrameError::BadMagic => "orphaned Reliable UART fragment",
                FrameError::BadVersion => "unsupported Reliable UART version",
                FrameError::BadType => "unsupported Reliable UART frame",
                FrameError::BadLength => "invalid Reliable UART frame header",
                FrameError::Oversized => "oversized Reliable UART frame",
            }
        } else {
            match self {
                FrameError::ShortHeader => "orphaned management fragment",
                FrameError::BadMagic => "orphaned management fragment",
                FrameError::BadVersion => "unsupported management response",
                FrameError::BadType => "unsupported management response",
                FrameError::BadLength => "oversized management response header",
                FrameError::Oversized => "oversized management response",
            }
        }
    }
}

/// A parsed management header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagementHeader {
    /// `2` (a response) or `3` (a management notification). Parsing refuses any
    /// other type.
    pub kind: u8,
    /// The request id this response answers.
    pub request_id: u32,
    /// The total payload length, across all fragments.
    pub expected: u16,
    /// The flags word (`MGMT_FLAG_FINAL`, `MGMT_FLAG_ERROR`).
    pub flags: u16,
}

/// Parse a management header from the first bytes of a fragment.
pub fn parse_management_header(bytes: &[u8]) -> Result<ManagementHeader, FrameError> {
    if bytes.len() < MGMT_HEADER_SIZE {
        return Err(FrameError::ShortHeader);
    }
    if bytes[0] != MGMT_MAGIC[0] || bytes[1] != MGMT_MAGIC[1] {
        return Err(FrameError::BadMagic);
    }
    if bytes[2] != MGMT_API_MAJOR {
        return Err(FrameError::BadVersion);
    }
    if bytes[3] != 2 && bytes[3] != 3 {
        return Err(FrameError::BadType);
    }
    Ok(ManagementHeader {
        kind: bytes[3],
        request_id: u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        expected: u16::from_le_bytes([bytes[8], bytes[9]]),
        flags: u16::from_le_bytes([bytes[10], bytes[11]]),
    })
}

/// Encode one management request: header plus payload, as one logical frame.
///
/// The result is what the *bearer* then cuts into GATT writes; this function
/// knows nothing about MTUs, because the device's reassembly does not either —
/// it expects the header once, in the first write, and the payload to continue
/// across the writes that follow. Producing the whole frame here and segmenting
/// it elsewhere is what lets those two halves be tested apart.
pub fn encode_management_request(request_id: u32, body: &[u8]) -> Result<Vec<u8>, FrameError> {
    if body.is_empty() {
        return Err(FrameError::BadLength);
    }
    if body.len() > u16::MAX as usize {
        return Err(FrameError::Oversized);
    }
    let mut frame = Vec::with_capacity(MGMT_HEADER_SIZE + body.len());
    frame.extend_from_slice(&MGMT_MAGIC);
    frame.push(MGMT_API_MAJOR);
    frame.push(MGMT_REQUEST_TYPE);
    frame.extend_from_slice(&request_id.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u16).to_le_bytes());
    // No flags: a request is one message, and `FINAL` is the device's own word
    // for the last piece of a long *response*.
    frame.extend_from_slice(&0u16.to_le_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

/// Whether fragments carrying this header end the message they belong to.
///
/// A response may be split across several notifications, and while it is split
/// the answer is incomplete however much of it has arrived — printing half of
/// an `@info` blob as if it were the whole read is a wrong number rather than a
/// partial one.
pub fn management_fragment_is_final(header: &ManagementHeader) -> bool {
    header.flags & MGMT_FLAG_FINAL != 0
}

/// A parsed Reliable UART header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReliableHeader {
    /// The fragment sequence number.
    pub sequence: u32,
    /// The total payload length, across all fragments.
    pub expected: u16,
}

/// Parse a Reliable UART header. The sequence and length must both be non-zero
/// and the length must fit the payload budget, exactly as the web checks.
pub fn parse_reliable_header(bytes: &[u8]) -> Result<ReliableHeader, FrameError> {
    parse_reliable_header_bounded(bytes, RELIABLE_UART_MAX_PAYLOAD)
}

/// Parse a Reliable UART header against an explicit payload budget (used where
/// the caller raises or lowers the limit from the default).
pub fn parse_reliable_header_bounded(
    bytes: &[u8],
    max_payload: usize,
) -> Result<ReliableHeader, FrameError> {
    if bytes.len() < RELIABLE_UART_HEADER_SIZE {
        return Err(FrameError::ShortHeader);
    }
    if bytes[0] != RELIABLE_MAGIC[0] || bytes[1] != RELIABLE_MAGIC[1] {
        return Err(FrameError::BadMagic);
    }
    if bytes[2] != RELIABLE_UART_API_MAJOR {
        return Err(FrameError::BadVersion);
    }
    let sequence = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let expected = u16::from_le_bytes([bytes[8], bytes[9]]);
    if sequence == 0 || expected == 0 || expected as usize > max_payload {
        return Err(FrameError::BadLength);
    }
    Ok(ReliableHeader { sequence, expected })
}

// --- fragment reassembly ----------------------------------------------------

/// The outcome of feeding one fragment into a [`FragmentReassembler`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reassembly<T> {
    /// More fragments are needed before the logical message is whole.
    Incomplete,
    /// The logical message is whole: `meta` is the parsed header, `payload` the
    /// concatenated body.
    Complete { payload: Vec<u8>, meta: T },
    /// The stream cannot be trusted; the reassembler has dropped its state.
    Error(FrameError),
}

/// A streaming reassembler for a Linkr framing scheme.
///
/// The header is parsed once from the first fragment, the remaining bytes of
/// every fragment are appended, and a message is emitted only when the declared
/// length has arrived. The management and Reliable schemes differ only in the
/// header parser and the payload budget, so both share this one machine.
pub struct FragmentReassembler<T, F>
where
    F: Fn(&[u8]) -> Result<(T, usize), FrameError>,
{
    header_size: usize,
    max_payload: usize,
    parse_header: F,
    pending: Option<Pending<T>>,
}

struct Pending<T> {
    meta: T,
    expected: usize,
    chunks: Vec<Vec<u8>>,
    received: usize,
}

impl<T, F> FragmentReassembler<T, F>
where
    F: Fn(&[u8]) -> Result<(T, usize), FrameError>,
{
    /// Build a reassembler for a scheme. `header_size` is the fixed header
    /// length, `max_payload` the payload ceiling, and `parse_header` turns the
    /// first fragment's header into `(metadata, expected_payload_length)`.
    pub fn new(header_size: usize, max_payload: usize, parse_header: F) -> Self {
        FragmentReassembler {
            header_size,
            max_payload,
            parse_header,
            pending: None,
        }
    }

    /// Whether a message is mid-reassembly.
    pub fn pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Drop any in-flight message.
    pub fn reset(&mut self) {
        self.pending = None;
    }

    /// Feed one fragment. See [`Reassembly`] for the outcomes.
    pub fn push(&mut self, bytes: &[u8]) -> Reassembly<T> {
        if self.pending.is_none() {
            if bytes.len() < self.header_size {
                return Reassembly::Error(FrameError::ShortHeader);
            }
            let (meta, expected) = match (self.parse_header)(bytes) {
                Ok(pair) => pair,
                Err(e) => return Reassembly::Error(e),
            };
            if expected == 0 || expected > self.max_payload {
                return Reassembly::Error(FrameError::BadLength);
            }
            self.pending = Some(Pending {
                meta,
                expected,
                chunks: Vec::new(),
                received: 0,
            });
            self.push_payload(&bytes[self.header_size..])
        } else {
            self.push_payload(bytes)
        }
    }

    fn push_payload(&mut self, fragment: &[u8]) -> Reassembly<T> {
        let expected = self.pending.as_ref().expect("pending set above").expected;
        {
            let message = self.pending.as_mut().expect("pending set above");
            if message.received + fragment.len() > expected {
                self.pending = None;
                return Reassembly::Error(FrameError::Oversized);
            }
            message.chunks.push(fragment.to_vec());
            message.received += fragment.len();
        }
        if self.pending.as_ref().expect("pending").received != expected {
            return Reassembly::Incomplete;
        }
        let pending = self.pending.take().expect("pending");
        let mut payload = Vec::with_capacity(pending.received);
        for chunk in &pending.chunks {
            payload.extend_from_slice(chunk);
        }
        Reassembly::Complete {
            payload,
            meta: pending.meta,
        }
    }
}

/// The parsed header plus the declared payload length, ready for the machine.
type WithLength<H> = Result<(H, usize), FrameError>;

/// The generic machine specialised to the management header.
type ManagementFragmentReassembler =
    FragmentReassembler<ManagementHeader, fn(&[u8]) -> WithLength<ManagementHeader>>;

/// The generic machine specialised to the Reliable UART header.
type ReliableFragmentReassembler =
    FragmentReassembler<ReliableHeader, fn(&[u8]) -> WithLength<ReliableHeader>>;

/// A management-scheme reassembler, with the expected length carried out of the
/// header explicitly so the generic machine needs no header trait.
pub struct ManagementReassembler {
    inner: ManagementFragmentReassembler,
}

fn parse_management_with_len(bytes: &[u8]) -> Result<(ManagementHeader, usize), FrameError> {
    let header = parse_management_header(bytes)?;
    Ok((header, header.expected as usize))
}

impl Default for ManagementReassembler {
    fn default() -> Self {
        ManagementReassembler {
            inner: FragmentReassembler::new(
                MGMT_HEADER_SIZE,
                u16::MAX as usize,
                parse_management_with_len,
            ),
        }
    }
}

impl ManagementReassembler {
    /// The management scheme's payload budget is the full 16-bit field, since a
    /// management response may carry a whole `@info` blob.
    pub const MAX_PAYLOAD: usize = u16::MAX as usize;

    /// Build with an explicit payload ceiling.
    pub fn new(max_payload: usize) -> Self {
        ManagementReassembler {
            inner: FragmentReassembler::new(
                MGMT_HEADER_SIZE,
                max_payload,
                parse_management_with_len,
            ),
        }
    }

    /// Whether a message is mid-reassembly.
    pub fn pending(&self) -> bool {
        self.inner.pending()
    }

    /// Drop any in-flight message.
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    /// Feed one fragment; returns the reassembly decision with the header.
    pub fn push(&mut self, bytes: &[u8]) -> Reassembly<ManagementHeader> {
        match self.inner.push(bytes) {
            Reassembly::Incomplete => Reassembly::Incomplete,
            Reassembly::Complete { payload, meta } => Reassembly::Complete { payload, meta },
            Reassembly::Error(e) => Reassembly::Error(e),
        }
    }
}

/// A reassembler's whole interesting state is whether one is half-read, and
/// that is all a `{:?}` needs to say. Hand-written rather than derived because
/// the machine carries a parser function, and printing a function pointer
/// would tell a reader about this library rather than about the messages it
/// failed to finish.
impl std::fmt::Debug for ManagementReassembler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagementReassembler")
            .field("pending", &self.pending())
            .finish()
    }
}

/// A Reliable-UART-scheme reassembler.
pub struct ReliableReassembler {
    inner: ReliableFragmentReassembler,
}

fn parse_reliable_with_len(bytes: &[u8]) -> Result<(ReliableHeader, usize), FrameError> {
    let header = parse_reliable_header(bytes)?;
    Ok((header, header.expected as usize))
}

impl Default for ReliableReassembler {
    fn default() -> Self {
        ReliableReassembler {
            inner: FragmentReassembler::new(
                RELIABLE_UART_HEADER_SIZE,
                RELIABLE_UART_MAX_PAYLOAD,
                parse_reliable_with_len,
            ),
        }
    }
}

impl ReliableReassembler {
    /// Whether a message is mid-reassembly.
    pub fn pending(&self) -> bool {
        self.inner.pending()
    }

    /// Drop any in-flight message.
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    /// Feed one fragment; returns the reassembly decision with the header.
    pub fn push(&mut self, bytes: &[u8]) -> Reassembly<ReliableHeader> {
        match self.inner.push(bytes) {
            Reassembly::Incomplete => Reassembly::Incomplete,
            Reassembly::Complete { payload, meta } => Reassembly::Complete { payload, meta },
            Reassembly::Error(e) => Reassembly::Error(e),
        }
    }
}

// --- WiFi events ------------------------------------------------------------

/// The phases that end an asynchronous WiFi operation.
pub const WIFI_FINAL_PHASES: [&str; 3] = ["ready", "failed", "off"];

const WIFI_EVENT_PREFIX: &str = "@event wifi ";

/// One parsed `@event wifi …` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifiEvent {
    /// The operation id.
    pub operation: u32,
    /// The phase (`ready`, `failed`, `off`, …).
    pub phase: String,
    /// The result code.
    pub result: i64,
    /// The `state=` field, if present.
    pub state: String,
    /// The `ip=` field, if present.
    pub ip: String,
    /// The `error=` field, if present.
    pub error: String,
    /// Whether this phase ends the operation.
    pub is_final: bool,
    /// Whether this phase reports a failure.
    pub failed: bool,
}

/// Parse one `@event wifi operation=42 phase=ready result=0 state=… ip=…` line.
/// Returns `None` for anything that is not a WiFi lifecycle event.
pub fn parse_wifi_event(text: &str) -> Option<WifiEvent> {
    let value = text.trim();
    let rest = value.strip_prefix(WIFI_EVENT_PREFIX)?;
    // operation=(\d+) phase=([a-z]+) result=(-?\d+)(rest)
    let mut fields = rest.splitn(3, ' ');
    let operation = fields.next()?.strip_prefix("operation=")?.parse().ok()?;
    let phase = fields.next()?.strip_prefix("phase=")?.to_string();
    let result_part = fields.next()?;
    let result = result_part
        .split_whitespace()
        .next()?
        .strip_prefix("result=")?
        .parse()
        .ok()?;
    // Remaining tokens after `result=…`.
    let tail = result_part
        .split_whitespace()
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ");
    let mut state = String::new();
    let mut ip = String::new();
    let mut error = String::new();
    for token in tail.split_whitespace() {
        if let Some((key, value)) = token.split_once('=') {
            match key {
                "state" => state = value.to_string(),
                "ip" => ip = value.to_string(),
                "error" => error = value.to_string(),
                _ => {}
            }
        }
    }
    let is_final = WIFI_FINAL_PHASES.contains(&phase.as_str());
    let failed = phase == "failed";
    Some(WifiEvent {
        operation,
        phase,
        result,
        state,
        ip,
        error,
        is_final,
        failed,
    })
}

/// Whether a WiFi event represents completed provisioning: the `ready` phase
/// with a usable IPv4 address. `ip=ready`/`ip=down` only mean "no address yet".
pub fn wifi_provisioning_complete(event: &WifiEvent) -> bool {
    event.phase == "ready" && is_ipv4_address(&event.ip)
}

/// Whether a string looks like an IPv4 address — the web client's heuristic for
/// pre-filling the LAN host field from `wifi.ip`.
pub fn is_ipv4_address(value: &str) -> bool {
    let mut parts = 0;
    for part in value.split('.') {
        if parts == 4 {
            return false;
        }
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        if part.parse::<u16>().map(|v| v > 255).unwrap_or(true) {
            return false;
        }
        parts += 1;
    }
    parts == 4
}

// --- management response tracking -------------------------------------------

/// Tracks outstanding management requests by id, settling each exactly once
/// when its response (or an error) arrives. Timeout handling is the caller's:
/// the tracker records a request, matches a response, and settles it; nothing
/// here touches a clock.
///
/// This is the synchronous shape of the web's `ManagementResponseTracker` — the
/// TUI event loop drives the timeout itself, so the tracker owns only the map
/// and the settle logic, which is the part that has to match the wire.
#[derive(Debug, Default)]
pub struct ManagementResponseTracker {
    pending: std::collections::HashMap<u32, ()>,
}

impl ManagementResponseTracker {
    /// Register a request id as outstanding. Returns false if it is already
    /// pending (the web throws in that case; the TUI reports it).
    pub fn wait(&mut self, request_id: u32) -> bool {
        if self.pending.contains_key(&request_id) {
            return false;
        }
        self.pending.insert(request_id, ());
        true
    }

    /// Settle a response against a pending request. A management *response* has
    /// type `2`; notifications (`3`) never settle a request.
    ///
    /// Returns `Some(Ok(text))` for a successful settle, `Some(Err(text))` when
    /// the response carries an error flag or an `ERR` prefix, and `None` when
    /// the message is not a response or no such request is pending.
    pub fn settle(
        &mut self,
        kind: u8,
        request_id: u32,
        flags: u16,
        text: &str,
    ) -> Option<Result<String, String>> {
        if kind != 2 {
            return None;
        }
        self.pending.remove(&request_id)?;
        let text = text.trim().to_string();
        if (flags & MGMT_FLAG_ERROR) != 0 || text.starts_with("ERR ") || text == "ERR" {
            Some(Err(if text.is_empty() {
                format!("Management request {request_id} failed")
            } else {
                text
            }))
        } else {
            Some(Ok(text))
        }
    }

    /// Reject one pending request (e.g. on timeout or teardown).
    pub fn reject(&mut self, request_id: u32) -> bool {
        self.pending.remove(&request_id).is_some()
    }

    /// Reject every pending request, returning how many were outstanding.
    pub fn reject_all(&mut self) -> usize {
        let count = self.pending.len();
        self.pending.clear();
        count
    }

    /// How many requests are outstanding.
    pub fn outstanding(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mgmt_bytes(kind: u8, request_id: u32, expected: u16, flags: u16) -> Vec<u8> {
        let mut v = vec![0x4c, 0x4b, MGMT_API_MAJOR, kind];
        v.extend_from_slice(&request_id.to_le_bytes());
        v.extend_from_slice(&expected.to_le_bytes());
        v.extend_from_slice(&flags.to_le_bytes());
        v
    }

    #[test]
    fn parses_a_management_header() {
        let bytes = mgmt_bytes(2, 7, 4, MGMT_FLAG_FINAL);
        let h = parse_management_header(&bytes).unwrap();
        assert_eq!(h.kind, 2);
        assert_eq!(h.request_id, 7);
        assert_eq!(h.expected, 4);
        assert_eq!(h.flags, MGMT_FLAG_FINAL);
    }

    #[test]
    fn refuses_bad_magic_version_type() {
        // bad magic
        let mut b = mgmt_bytes(2, 1, 1, 0);
        b[0] = 0x00;
        assert_eq!(parse_management_header(&b), Err(FrameError::BadMagic));
        // bad version
        let mut b = mgmt_bytes(2, 1, 1, 0);
        b[2] = 9;
        assert_eq!(parse_management_header(&b), Err(FrameError::BadVersion));
        // bad type
        let b = mgmt_bytes(9, 1, 1, 0);
        assert_eq!(parse_management_header(&b), Err(FrameError::BadType));
        // short
        assert_eq!(
            parse_management_header(&[0x4c, 0x4b]),
            Err(FrameError::ShortHeader)
        );
    }

    #[test]
    fn error_messages_match_the_web_tables() {
        assert_eq!(
            FrameError::BadMagic.message(false),
            "orphaned management fragment"
        );
        assert_eq!(
            FrameError::BadVersion.message(false),
            "unsupported management response"
        );
        assert_eq!(
            FrameError::BadLength.message(false),
            "oversized management response header"
        );
        assert_eq!(
            FrameError::Oversized.message(false),
            "oversized management response"
        );
        assert_eq!(
            FrameError::ShortHeader.message(true),
            "orphaned Reliable UART fragment"
        );
        assert_eq!(
            FrameError::BadVersion.message(true),
            "unsupported Reliable UART version"
        );
        assert_eq!(
            FrameError::Oversized.message(true),
            "oversized Reliable UART frame"
        );
    }

    /// Build a 12-byte Reliable UART header: magic(2), version(1), reserved(1),
    /// sequence(4), expected(2), trailing(2), matching the web's offsets
    /// (`getUint32(4)`, `getUint16(8)`).
    fn reliable_bytes(seq: u32, expected: u16) -> Vec<u8> {
        let mut b = vec![0x4c, 0x52, RELIABLE_UART_API_MAJOR, 0];
        b.extend_from_slice(&seq.to_le_bytes());
        b.extend_from_slice(&expected.to_le_bytes());
        b.extend_from_slice(&[0u8, 0]);
        b
    }

    #[test]
    fn parses_a_reliable_header() {
        let b = reliable_bytes(3, 10);
        let h = parse_reliable_header(&b).unwrap();
        assert_eq!(h.sequence, 3);
        assert_eq!(h.expected, 10);
    }

    #[test]
    fn reliable_header_refuses_zero_sequence_or_length_and_oversize() {
        assert_eq!(
            parse_reliable_header(&reliable_bytes(0, 10)),
            Err(FrameError::BadLength)
        );
        assert_eq!(
            parse_reliable_header(&reliable_bytes(1, 0)),
            Err(FrameError::BadLength)
        );
        // over the default budget (232)
        assert_eq!(
            parse_reliable_header(&reliable_bytes(1, 233)),
            Err(FrameError::BadLength)
        );
        // but fine under a raised budget
        assert_eq!(
            parse_reliable_header_bounded(&reliable_bytes(1, 233), 1024)
                .unwrap()
                .expected,
            233
        );
    }

    #[test]
    fn a_management_message_reassembles_across_fragments() {
        let mut r = ManagementReassembler::new(64);
        assert!(!r.pending());
        let header = mgmt_bytes(2, 1, 5, MGMT_FLAG_FINAL);
        assert_eq!(r.push(&header), Reassembly::Incomplete);
        assert!(r.pending());
        assert_eq!(r.push(b"he"), Reassembly::Incomplete);
        assert_eq!(
            r.push(b"llo"),
            Reassembly::Complete {
                payload: b"hello".to_vec(),
                meta: ManagementHeader {
                    kind: 2,
                    request_id: 1,
                    expected: 5,
                    flags: 1
                },
            }
        );
        assert!(!r.pending());
    }

    #[test]
    fn an_oversized_fragment_drops_the_reassembler() {
        let mut r = ManagementReassembler::new(64);
        let header = mgmt_bytes(2, 1, 3, 0);
        assert_eq!(r.push(&header), Reassembly::Incomplete);
        assert_eq!(r.push(b"toolong"), Reassembly::Error(FrameError::Oversized));
        assert!(!r.pending());
    }

    #[test]
    fn reliable_reassembles_and_rejects_bad_magic() {
        let mut r = ReliableReassembler::default();
        let h = reliable_bytes(1, 3);
        assert_eq!(r.push(&h), Reassembly::Incomplete);
        assert_eq!(
            r.push(b"abc"),
            Reassembly::Complete {
                payload: b"abc".to_vec(),
                meta: ReliableHeader {
                    sequence: 1,
                    expected: 3
                }
            }
        );

        // A fresh, corrupt first fragment errors and leaves no pending state.
        let mut r2 = ReliableReassembler::default();
        assert_eq!(r2.push(b"xx"), Reassembly::Error(FrameError::ShortHeader));
        assert!(!r2.pending());
    }

    #[test]
    fn parses_a_wifi_event() {
        let e = parse_wifi_event(
            "@event wifi operation=42 phase=ready result=0 state=connected ip=10.0.0.4 error=0",
        )
        .unwrap();
        assert_eq!(e.operation, 42);
        assert_eq!(e.phase, "ready");
        assert_eq!(e.result, 0);
        assert_eq!(e.state, "connected");
        assert_eq!(e.ip, "10.0.0.4");
        assert!(e.is_final);
        assert!(!e.failed);

        let f = parse_wifi_event("@event wifi operation=1 phase=failed result=-1 error=timeout")
            .unwrap();
        assert!(f.failed);
        assert!(f.is_final);

        assert!(parse_wifi_event("not a wifi line").is_none());
        assert!(parse_wifi_event("@event wifi operation=bad").is_none());
    }

    #[test]
    fn provisioning_requires_a_real_ip() {
        let ready = parse_wifi_event("@event wifi operation=1 phase=ready result=0 ip=10.0.0.4")
            .expect("parses");
        assert!(wifi_provisioning_complete(&ready));
        let ip_ready = parse_wifi_event("@event wifi operation=1 phase=ready result=0 ip=ready")
            .expect("parses");
        assert!(!wifi_provisioning_complete(&ip_ready));
    }

    #[test]
    fn ipv4_heuristic_matches_the_web() {
        assert!(is_ipv4_address("192.168.1.50"));
        assert!(is_ipv4_address("127.0.0.1"));
        assert!(!is_ipv4_address("ready"));
        assert!(!is_ipv4_address("192.168.1"));
        assert!(!is_ipv4_address("192.168.1.256"));
        assert!(!is_ipv4_address("192.168.1.1.1"));
        assert!(!is_ipv4_address(""));
    }

    #[test]
    fn the_tracker_settles_each_request_once() {
        let mut t = ManagementResponseTracker::default();
        assert!(t.wait(5));
        assert!(!t.wait(5), "a second wait for the same id is refused");
        assert_eq!(t.outstanding(), 1);

        // A success settles to Ok(text).
        assert_eq!(t.settle(2, 5, 0, " ok "), Some(Ok("ok".to_string())));
        assert_eq!(t.outstanding(), 0);

        // A second settle for the same id finds nothing.
        assert_eq!(t.settle(2, 5, 0, "again"), None);
    }

    #[test]
    fn error_flags_and_err_prefix_settle_to_an_error() {
        let mut t = ManagementResponseTracker::default();
        t.wait(1);
        assert_eq!(
            t.settle(2, 1, MGMT_FLAG_ERROR, "boom"),
            Some(Err("boom".to_string()))
        );

        t.wait(2);
        assert_eq!(
            t.settle(2, 2, 0, "ERR something wrong"),
            Some(Err("ERR something wrong".to_string()))
        );

        t.wait(3);
        assert_eq!(t.settle(2, 3, 0, "ERR"), Some(Err("ERR".to_string())));
    }

    #[test]
    fn notifications_do_not_settle_and_reject_all_drains() {
        let mut t = ManagementResponseTracker::default();
        t.wait(1);
        // type 3 is a notification, not a response.
        assert_eq!(t.settle(3, 1, 0, "x"), None);
        assert_eq!(t.outstanding(), 1);
        // reject one
        assert!(t.reject(1));
        assert_eq!(t.outstanding(), 0);
        // reject_all drains
        t.wait(2);
        t.wait(3);
        assert_eq!(t.reject_all(), 2);
        assert_eq!(t.outstanding(), 0);
    }
}
