//! Accessory management (`web/accessory_control.js`).
//!
//! These commands configure Linkr Bee itself (UART, WiFi, WebDAV) over the
//! encrypted Bluetooth LE management channel. They never touch the target
//! UART, so they cannot be confused with terminal input. Builders and parsers
//! are pure so the tool layer, the panel and the tests share one definition of
//! every command and reply.

/// The firmware's own limits, mirrored so a command is refused here rather
/// than by the device after a round trip.
pub struct AccessoryLimits;

impl AccessoryLimits {
    pub const MIN_BAUD: u32 = 300;
    pub const MAX_BAUD: u32 = 3_000_000;
    pub const DATA_BITS: [u8; 4] = [5, 6, 7, 8];
    pub const PARITY: [&str; 3] = ["n", "e", "o"];
    pub const STOP_BITS: [u8; 2] = [1, 2];
    pub const FLOW: [&str; 2] = ["none", "rtscts"];
    pub const SSID_MAX: usize = 32;
    pub const PASSWORD_MAX: usize = 64;
    pub const WEBDAV_URL_MAX: usize = 256;
    /// The firmware stores the advertised name in this many UTF-8 bytes, not
    /// characters: a Chinese name is three bytes per ideograph and an emoji is
    /// usually four.
    pub const BLE_NAME_MAX: usize = 29;
}

pub const DIAGNOSTICS_COMMAND: &str = "@i?";
pub const UART_QUERY_COMMAND: &str = "@u?";
pub const WIFI_QUERY_COMMAND: &str = "@w?";
/// `@n?` — the advertised name, and whether it is a custom one.
pub const BLE_NAME_QUERY_COMMAND: &str = "@n?";
/// `@w scan` — the bridge's radio walks the channels. The answer streams: an
/// acceptance, a line per network, and `@scan done` (or `@scan error`) at the
/// end; see [`crate::device::Query::WifiScan`].
pub const WIFI_SCAN_COMMAND: &str = "@w scan";
pub const WEBDAV_QUERY_COMMAND: &str = "@d?";

/// `@s?` — the WebSocket/LAN settings, and the only place the bridge reports
/// its LAN access token. `@i?` deliberately omits it, so this is the one
/// command a client has to send to learn a token it does not already have.
pub const LAN_QUERY_COMMAND: &str = "@s?";

/// Build `@n=<name>`.
///
/// The bridge advertises the name verbatim and stores it in settings, so the
/// checks the firmware applies are applied on this side too: one to 29 UTF-8
/// bytes, no control characters. Trimming happens here because leading and
/// trailing spaces are invisible in a prompt and would otherwise be persisted
/// as part of the name.
pub fn ble_name_command(name: &str) -> Result<String, String> {
    // The four bytes the firmware trims, and only those: `str::trim` would
    // also drop NBSP and U+3000 and make the same command store a different
    // name depending on which host sent it.
    let name = name.trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n'));
    let bytes = name.len();
    if bytes == 0 {
        return Err("name must be 1-29 UTF-8 bytes".to_string());
    }
    if bytes > AccessoryLimits::BLE_NAME_MAX {
        return Err(format!(
            "name must be 1-{} UTF-8 bytes; this one is {bytes}",
            AccessoryLimits::BLE_NAME_MAX
        ));
    }
    // The firmware's reject set: C0, DEL, C1, and the two Unicode line
    // separators. `char::is_control` covers the first three, not U+2028/29.
    if name
        .chars()
        .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
    {
        return Err("name must not contain control characters".to_string());
    }
    Ok(format!("@n={name}"))
}

/// `@n default` — delete the custom name and go back to the MAC-derived one.
pub fn reset_ble_name_command() -> String {
    "@n default".to_string()
}

/// A UART settings set, as both the command builder and the parser use it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UartSettings {
    pub baud: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    pub flow: String,
}

impl UartSettings {
    /// The spec the way the wire and the settings field spell it:
    /// `baud,data,parity,stop,flow`, lower case.
    pub fn spec(&self) -> String {
        format!(
            "{},{},{},{},{}",
            self.baud,
            self.data_bits,
            self.parity.to_ascii_lowercase(),
            self.stop_bits,
            self.flow.to_ascii_lowercase()
        )
    }
}

/// Build `@u=<baud>,<data>,<parity>,<stop>,<flow>`.
pub fn set_uart_command(s: &UartSettings) -> Result<String, String> {
    if !(AccessoryLimits::MIN_BAUD..=AccessoryLimits::MAX_BAUD).contains(&s.baud) {
        return Err(format!(
            "baud must be an integer between {} and {}",
            AccessoryLimits::MIN_BAUD,
            AccessoryLimits::MAX_BAUD
        ));
    }
    if !AccessoryLimits::DATA_BITS.contains(&s.data_bits) {
        return Err("dataBits must be 5, 6, 7 or 8".to_string());
    }
    let parity = s.parity.to_ascii_lowercase();
    if !AccessoryLimits::PARITY.contains(&parity.as_str()) {
        return Err("parity must be n, e or o".to_string());
    }
    if !AccessoryLimits::STOP_BITS.contains(&s.stop_bits) {
        return Err("stopBits must be 1 or 2".to_string());
    }
    let flow = s.flow.to_ascii_lowercase();
    if !AccessoryLimits::FLOW.contains(&flow.as_str()) {
        return Err("flow must be none or rtscts".to_string());
    }
    Ok(format!("@u={}", s.spec()))
}

/// Parse `baud,data,parity,stop,flow` as a settings field or `--uart` spells
/// it.
///
/// Refused here rather than by the bridge, for the same reason
/// [`set_uart_command`] refuses: a value the firmware cannot take is a value
/// the user should be told about before a round trip and not after. This is
/// the shape only — the ranges are [`set_uart_command`]'s to enforce.
pub fn parse_uart_spec(spec: &str) -> Result<UartSettings, String> {
    let fields: Vec<&str> = spec.split(',').map(str::trim).collect();
    if fields.len() != 5 {
        return Err(format!(
            "'{spec}' is not baud,data,parity,stop,flow — five fields, as in 115200,8,n,1,none"
        ));
    }
    let baud: u32 = fields[0]
        .parse()
        .map_err(|_| format!("'{}' is not a baud rate", fields[0]))?;
    let data_bits: u8 = fields[1]
        .parse()
        .map_err(|_| format!("'{}' is not a data-bit count", fields[1]))?;
    let stop_bits: u8 = fields[3]
        .parse()
        .map_err(|_| format!("'{}' is not a stop-bit count", fields[3]))?;
    Ok(UartSettings {
        baud,
        data_bits,
        parity: fields[2].to_string(),
        stop_bits,
        flow: fields[4].to_string(),
    })
}

/// Build `@w=<ssid>,<password>`, `@w off` or `@w scan`. A comma in an SSID
/// would move the rest of the name into the password in the firmware parser,
/// so it is refused.
///
/// `scan` is a third shape rather than a `connect` with an empty name: the
/// firmware's parser reads `off` and `scan` as words and anything else as a
/// network to join, so "join the network called `scan`" is not expressible —
/// which is why an SSID is never silently turned into one.
pub fn wifi_command(action: &str, ssid: &str, password: &str) -> Result<String, String> {
    let mode = action.to_ascii_lowercase();
    if mode == "off" {
        return Ok("@w off".to_string());
    }
    if mode == "scan" {
        return Ok("@w scan".to_string());
    }
    if mode != "connect" {
        return Err("action must be connect, scan or off".to_string());
    }
    if ssid.trim().is_empty() {
        return Err("ssid is required".to_string());
    }
    if ssid.chars().count() > AccessoryLimits::SSID_MAX {
        return Err(format!(
            "ssid must be at most {} characters",
            AccessoryLimits::SSID_MAX
        ));
    }
    if ssid.contains(',') {
        return Err("ssid must not contain a comma".to_string());
    }
    if ssid.chars().any(|c| c.is_control()) {
        return Err("ssid must not contain control characters".to_string());
    }
    if password.chars().count() > AccessoryLimits::PASSWORD_MAX {
        return Err(format!(
            "password must be at most {} characters",
            AccessoryLimits::PASSWORD_MAX
        ));
    }
    Ok(format!("@w={ssid},{password}"))
}

/// Build `@d=<url>` or `@d off`.
///
/// The URL is for the bridge's own log uploader, not for the terminal.
/// Anonymous HTTP is the firmware's current contract (`src/wifi.c`).
/// Reject unsupported destinations before sending a configuration change.
pub fn webdav_command(action: &str, url: &str) -> Result<String, String> {
    let mode = action.to_ascii_lowercase();
    if mode == "off" {
        return Ok("@d off".to_string());
    }
    if mode != "on" {
        return Err("action must be on or off".to_string());
    }
    let target = url.trim();
    if target.is_empty() {
        return Err("url is required when enabling WebDAV upload".to_string());
    }
    if target.len() > AccessoryLimits::WEBDAV_URL_MAX {
        return Err(format!(
            "url must be at most {} UTF-8 bytes",
            AccessoryLimits::WEBDAV_URL_MAX
        ));
    }
    let rest = target
        .strip_prefix("http://")
        .ok_or("this firmware supports anonymous http:// upload URLs only")?;
    if target.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("url must not contain whitespace or control characters".to_string());
    }
    // Commas delimit the management command's legacy credential fields.
    if target.contains([',', '?', '#']) {
        return Err("url must not contain commas, a query or a fragment".to_string());
    }
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if host.is_empty()
        || host.len() >= 64
        || host.starts_with('.')
        || host.ends_with(['.', '-'])
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err("url needs a hostname or IPv4 address (no credentials or IPv6)".to_string());
    }
    if let Some(port) = port {
        if port.is_empty()
            || !port.bytes().all(|b| b.is_ascii_digit())
            || !matches!(port.parse::<u16>(), Ok(1..=u16::MAX))
        {
            return Err("url port must be between 1 and 65535".to_string());
        }
    }
    Ok(format!("@d={target}"))
}

/// The WiFi password travels in the command, so anything shown to the user or
/// returned to the model is redacted. A WebDAV URL may embed credentials too.
pub fn redact_command(command: &str) -> String {
    if let Some(rest) = command.strip_prefix("@w=") {
        return match rest.find(',') {
            Some(comma) => format!("@w={},<redacted>", &rest[..comma]),
            None => command.to_string(),
        };
    }
    if let Some(rest) = command.strip_prefix("@d=") {
        // `@d=<scheme>://<creds>@<host>…` -> credentials become `<redacted>`.
        if let Some(scheme_end) = rest.find("://") {
            let after_scheme = &rest[scheme_end + 3..];
            if let Some(at) = after_scheme.find('@') {
                let (creds, tail) = after_scheme.split_at(at);
                if !creds.is_empty() && !creds.contains('/') {
                    return format!("@d={}://<redacted>{tail}", &rest[..scheme_end]);
                }
            }
        }
        return command.to_string();
    }
    command.to_string()
}

/// Firmware replies begin with `OK` or `ERR`; an ERR line carries the reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyStatus {
    pub ok: bool,
    pub error: String,
}

/// Whether a line begins with `word` followed by a word boundary (`\b`): a
/// non-word character or the end of the line.
///
/// Judged through `get`, not by slicing: wire lines carry whatever SSIDs the
/// radio heard, and a name that starts with a multi-byte character does not
/// line up with an ASCII word's length — a slice there takes the whole
/// interface down over a network's name. A line that cannot even be split at
/// the word's length cannot begin with the word.
pub fn starts_with_word(line: &str, word: &str) -> bool {
    let Some(head) = line.get(..word.len()) else {
        return false;
    };
    if !head.eq_ignore_ascii_case(word) {
        return false;
    }
    match line[word.len()..].chars().next() {
        None => true,
        Some(c) => !c.is_alphanumeric() && c != '_',
    }
}

pub fn reply_status(text: &str) -> ReplyStatus {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if let Some(error) = lines.iter().find(|l| starts_with_word(l, "err")) {
        return ReplyStatus {
            ok: false,
            error: (*error).to_string(),
        };
    }
    ReplyStatus {
        ok: lines.iter().any(|l| starts_with_word(l, "ok")),
        error: String::new(),
    }
}

/// Whether a management line is the scan stream's own ending rather than a
/// network: `@scan done`, or `@scan error` when the radio gave up after the
/// request had been accepted. Both are events of the same stream the results
/// travel in, so whoever reads that stream has to know them apart.
pub fn is_scan_terminator(line: &str) -> bool {
    is_scan_error(line) || line.trim().eq_ignore_ascii_case("@scan done")
}

/// Whether the scan's ending says it failed.
pub fn is_scan_error(line: &str) -> bool {
    line.trim().eq_ignore_ascii_case("@scan error")
}

/// The network's own name, out of the line a scan reported for it.
///
/// The firmware writes `@scan result %.*s %s ch=%u %ddBm` (`src/wifi.c`): the
/// name first and whole — `%.*s` is the one field that may hold spaces — then
/// the security, the channel and the signal. So the known fields are peeled
/// off the *right*, one at a time, and all that is left is the name: picking
/// a network off the list has to bring its name, not the radio's note about
/// it.
///
/// Every peel is refused when it would leave nothing behind — a shorter or
/// older line puts its one word where this parser expects a field, and that
/// word is the name as far as the list can tell.
pub fn wifi_name_of(result: &str) -> String {
    let body = result.trim();
    let body = body.strip_prefix("@scan result ").unwrap_or(body).trim();
    let mut name = body.to_string();
    peel_signal(&mut name);
    peel_channel(&mut name);
    peel_security(&mut name);
    name.trim().to_string()
}

/// A scan line taken apart, in the shape a row can draw: the name, the signal
/// when the firmware wrote a readable one, and what sits between them — the
/// security and the channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifiResult {
    pub name: String,
    /// The signal, in dBm, when the line carried a readable one.
    pub signal_dbm: Option<i32>,
    /// The radio's other notes, `wpa2 ch=6` shaped, with the signal peeled
    /// off. Empty when the line had none.
    pub rest: String,
}

/// Take a scan result apart: `MyNet wpa2 ch=6 -54dBm` becomes the name, the
/// signal, and `wpa2 ch=6`.
///
/// The list wants the three separately — the dots go in front of the row, the
/// name is what joining takes, and the rest is context — which is why this
/// peels once and hands the pieces back rather than making every caller
/// re-find the same boundary.
pub fn parse_wifi_result(line: &str) -> WifiResult {
    let body = line.trim();
    let body = body.strip_prefix("@scan result ").unwrap_or(body).trim();
    let (without_signal, signal_dbm) = match signal_at(body) {
        Some((at, dbm)) => (body[..at].trim_end(), Some(dbm)),
        None => (body, None),
    };
    let name = wifi_name_of(without_signal);
    // Peeled by truncation, so the name's byte length is where the rest
    // starts; `get` rather than a slice because a name that was only
    // whitespace would put the index out of range.
    let rest = without_signal
        .get(name.len()..)
        .unwrap_or("")
        .trim()
        .to_string();
    WifiResult {
        name,
        signal_dbm,
        rest,
    }
}

/// The signal at the end of a scan line: where its text begins — the index of
/// the space before the number — and the number itself.
///
/// The firmware writes `@scan result <name> <security> ch=<n> <rssi>dBm`, and
/// the signal is always last. The name-peeler and the signal reader need the
/// same boundary, so it is found once.
fn signal_at(value: &str) -> Option<(usize, i32)> {
    let line = value.trim_end();
    let head = line
        .strip_suffix("dBm")
        .or_else(|| line.strip_suffix("dB"))?;
    let head = head.trim_end();
    let digits = head.trim_end_matches(|c: char| c.is_ascii_digit());
    let rest = digits.trim_end_matches(['+', '-']);
    let end = rest.trim_end().len();
    // A number has to be there, its sign at most one character, and the space
    // the firmware writes before it: `Foo54dBm` alone is a name that ends in a
    // number, not a signal with nothing to signal.
    if digits.len() == head.len() || rest.len() + 1 < digits.len() || end == rest.len() || end == 0
    {
        return None;
    }
    let number = line.get(end..)?.trim();
    let number = number
        .strip_suffix("dBm")
        .or_else(|| number.strip_suffix("dB"))?;
    Some((end, number.trim().parse::<i32>().ok()?))
}

/// Peel a trailing ` -54dBm` (or ` -54dB`) off `value`, when there is one.
fn peel_signal(value: &mut String) {
    if let Some((at, _)) = signal_at(value) {
        value.truncate(at);
    }
}

/// Peel a trailing ` ch=6` off `value`, when there is one.
fn peel_channel(value: &mut String) {
    let line = value.trim_end();
    let digits = line.trim_end_matches(|c: char| c.is_ascii_digit());
    if digits.len() == line.len() {
        return;
    }
    let Some(head) = digits.strip_suffix("ch=") else {
        return;
    };
    let end = head.trim_end().len();
    // The channel has to have a name in front of it, separated by the space
    // the firmware writes: `Foo2ch=6` is a name, not a channel.
    if end == 0 || end == head.len() {
        return;
    }
    value.truncate(end);
}

/// The security words the firmware writes between the name and the channel.
const SECURITY_WORDS: [&str; 9] = [
    "open",
    "wep",
    "wpa",
    "wpa2",
    "wpa2-sha256",
    "wpa3",
    "eap",
    "wapi",
    "unknown",
];

/// Peel a trailing ` wpa2` off `value` when the last word is one of the
/// security words the firmware writes there.
fn peel_security(value: &mut String) {
    let line = value.trim_end();
    // The firmware separates fields with a plain space; the name's own spaces
    // are the name's, and the word after the last one is where security goes.
    let Some(at) = line.rfind(' ') else {
        return; // one word: that word is the name, security word or not
    };
    if !SECURITY_WORDS
        .iter()
        .any(|word| word.eq_ignore_ascii_case(&line[at + 1..]))
    {
        return;
    }
    let end = line[..at].trim_end().len();
    if end > 0 {
        value.truncate(end);
    }
}

/// `OK uart=115200,8,N,1,none` -> settings.
pub fn parse_uart_settings(text: &str) -> Option<UartSettings> {
    // Find the `uart=` payload and split its five comma fields.
    let idx = text.find("uart=")?;
    let payload: &str = text[idx + 5..].split_whitespace().next()?;
    let mut parts = payload.split(',');
    let baud = parts.next()?.parse().ok()?;
    let data_bits = parts.next()?.parse().ok()?;
    let parity = parts.next()?.to_ascii_lowercase();
    let stop_bits = parts.next()?.parse().ok()?;
    let flow = parts.next()?.to_ascii_lowercase();
    Some(UartSettings {
        baud,
        data_bits,
        parity,
        stop_bits,
        flow,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifiStatus {
    pub state: String,
    pub ssid: String,
    pub ip: String,
}

/// The advertised BLE name, as `@n?` reports it.
///
/// `custom` is `Some(false)` for the MAC-derived default and `Some(true)` for
/// a name set with `@n=`. This parses a *query* reply; a write's
/// `OK name=...` has no `custom=` field and is deliberately not parsed — the
/// read that follows the write says what the board is doing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BleNameStatus {
    pub name: String,
    pub custom: Option<bool>,
}

/// Read `OK name=<name> custom=yes|no` from a query reply.
///
/// The name may contain spaces, so only the final ` custom=` suffix is peeled
/// off the right. Nothing else is trimmed: the firmware stores trailing
/// NBSP and U+3000 verbatim, and a host that strips them would report a name
/// the board never had.
pub fn parse_ble_name(text: &str) -> Option<BleNameStatus> {
    let line = text.lines().find(|line| {
        line.get(..8)
            .is_some_and(|head| head.eq_ignore_ascii_case("OK name="))
    })?;
    let mut name = line.get(8..)?;
    let mut custom = None;
    if let Some(at) = name.rfind(" custom=") {
        let flag = &name[at + 8..];
        if flag.eq_ignore_ascii_case("yes") || flag.eq_ignore_ascii_case("no") {
            custom = Some(flag.eq_ignore_ascii_case("yes"));
            name = &name[..at];
        }
    }
    Some(BleNameStatus {
        name: name.to_string(),
        custom,
    })
}

/// Another WiFi operation holds the bridge's gate (`-EBUSY`).
///
/// The firmware answers `@w=` and `@w off` with `ERR wifi=<errno>` when its
/// one-operation gate is taken — a join already in flight, or the bridge's own
/// background retry between attempts. It is the common refusal on a board that
/// has just been asked to do something else, and the one worth waiting out.
pub const WIFI_BUSY: i64 = -16;

/// The bridge already holds the radio (`-EALREADY`).
///
/// The arithmetic here is the C library's, the one the firmware is built with
/// and not the one Linux runs: there `EALREADY` is 120, and 114 is
/// `ENETUNREACH` — good news and a router to look at, respectively. The gate is
/// the radio's *state*, so a join is refused this way while any network is up,
/// whatever name it was handed: switching means dropping the one that is.
pub const WIFI_ALREADY: i64 = -120;

/// The network will not carry the board (`-ENETUNREACH`).
pub const WIFI_UNREACHABLE: i64 = -114;

/// The join, or the lease after it, ran out of time (`-ETIMEDOUT`).
pub const WIFI_TIMEOUT: i64 = -116;

/// A name or key the firmware will not take (`-EINVAL`).
pub const WIFI_BAD_ARGUMENT: i64 = -22;

/// The radio is not up yet (`-ENODEV`).
pub const WIFI_NO_RADIO: i64 = -19;

/// The board ran out of memory (`-ENOMEM`).
pub const WIFI_NO_MEMORY: i64 = -12;

/// A failed association, in the radio's own counting (`enum wifi_conn_status`).
///
/// A join is not a syscall: what the firmware publishes as the `result` of a
/// failure is one of these — small, positive — or the `net_mgmt` error the
/// request itself came back with. One table words both halves.
pub const WIFI_CONN_FAIL: i64 = 1;
pub const WIFI_CONN_WRONG_PASSWORD: i64 = 2;
pub const WIFI_CONN_TIMEOUT: i64 = 3;
pub const WIFI_CONN_AP_NOT_FOUND: i64 = 4;

/// The `errno` in a management line that reports one: `ERR wifi=-16`,
/// `ERR scan=-16`.
///
/// Only the two nouns the firmware uses are read. Anything else is a line to
/// show as it came: inventing a meaning for a word this does not know would be
/// inventing an error.
pub fn wifi_error_code(line: &str) -> Option<i64> {
    let line = line.trim();
    if !starts_with_word(line, "err") {
        return None;
    }
    let rest = line.get(3..)?.trim_start();
    let rest = rest
        .strip_prefix("wifi=")
        .or_else(|| rest.strip_prefix("scan="))?;
    rest.trim().parse().ok()
}

/// `OK wifi=connected,ssid=MyNet,ip=192.168.1.5` or `OK wifi off`. The address
/// is taken from the last `,ip=` because an SSID may itself contain a comma.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebdavStatus {
    pub state: String,
    pub url: String,
}

/// `OK webdav=on,url=http://host/dav/` or `OK webdav off`. Everything after
/// `url=` is the target, so a URL containing a comma or a query string
/// survives the parse.
pub fn parse_webdav_status(text: &str) -> Option<WebdavStatus> {
    let line = text.lines().find(|l| {
        let lower = l.to_ascii_lowercase();
        lower.contains("webdav=") || lower.contains("webdav ")
    })?;
    let lower = line.to_ascii_lowercase();
    if contains_word(&lower, "webdav off") {
        return Some(WebdavStatus {
            state: "off".to_string(),
            url: String::new(),
        });
    }
    let idx = lower.find("webdav=")?;
    let payload = &line[idx + 7..];
    let (state, url) = match payload.find(",url=") {
        Some(i) => (&payload[..i], payload[i + 5..].trim()),
        None => (payload, ""),
    };
    Some(WebdavStatus {
        state: state.to_ascii_lowercase(),
        url: url.to_string(),
    })
}

pub fn parse_wifi_status(text: &str) -> Option<WifiStatus> {
    let line = text.lines().find(|l| {
        let lower = l.to_ascii_lowercase();
        lower.contains("wifi=") || lower.contains("wifi ")
    })?;
    let lower = line.to_ascii_lowercase();
    if contains_word(&lower, "wifi off") {
        return Some(WifiStatus {
            state: "off".to_string(),
            ssid: String::new(),
            ip: String::new(),
        });
    }
    // IP from the last ",ip=".
    let lower = line.to_ascii_lowercase();
    let (payload, ip) = match lower.rfind(",ip=") {
        Some(i) => (&line[..i], line[i + 4..].trim().to_string()),
        None => (line, String::new()),
    };
    // `wifi=<state>` optionally followed by `,ssid=<ssid>`.
    let idx = lower.find("wifi=")?;
    let payload = &payload[idx + 5..];
    let (state, ssid) = match payload.find(',') {
        Some(i) => (
            &payload[..i],
            payload[i + 1..].strip_prefix("ssid=").unwrap_or(""),
        ),
        None => (payload, ""),
    };
    Some(WifiStatus {
        state: state.to_ascii_lowercase(),
        ssid: if ssid == "-" {
            String::new()
        } else {
            ssid.to_string()
        },
        ip,
    })
}

/// Word-delimited substring search, so `wifi off` does not match `twifi off`.
pub(crate) fn contains_word(haystack: &str, needle: &str) -> bool {
    let mut search = 0;
    while let Some(rel) = haystack[search..].find(needle) {
        let start = search + rel;
        let end = start + needle.len();
        let before_ok = haystack[..start]
            .chars()
            .next_back()
            .map(|c| !c.is_ascii_alphanumeric())
            .unwrap_or(true);
        let after_ok = haystack[end..]
            .chars()
            .next()
            .map(|c| !c.is_ascii_alphanumeric())
            .unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        search = start + 1;
    }
    false
}

/// What `@s?` reports: whether LAN access is on, and the token it expects.
///
/// `token=none` is a real answer and not a missing one: it is how the bridge
/// says LAN auth was switched off, and the LAN dial must then be attempted
/// without one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanStatus {
    pub ws: String,
    pub token: String,
}

/// Read a LAN status out of an `@s?` reply.
pub fn parse_lan_status(text: &str) -> Option<LanStatus> {
    let line = text.lines().find(|l| {
        let lower = l.to_ascii_lowercase();
        lower.contains("ws=") || lower.contains("ws ")
    })?;
    let lower = line.to_ascii_lowercase();
    let idx = lower.find("ws=")?;
    let payload = &line[idx + 3..];
    let token = payload
        .split_whitespace()
        .find_map(|part| part.strip_prefix("token="))
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Some(LanStatus {
        ws: payload
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase(),
        token: if token == "none" {
            String::new()
        } else {
            token
        },
    })
}

/// One-line summary for the approval card, worded in the interface language.
pub fn accessory_change_summary(command: &str, zh: bool) -> String {
    let text = command;
    if let Some(name) = text.strip_prefix("@n=") {
        return if zh {
            format!("把 BLE 广播名改为「{name}」")
        } else {
            format!("Set the BLE advertised name to \"{name}\"")
        };
    }
    if text == "@n default" {
        return if zh {
            "恢复由硬件 MAC 生成的默认 BLE 名称".to_string()
        } else {
            "Restore the MAC-derived default BLE name".to_string()
        };
    }
    if let Some(settings) = text.strip_prefix("@u=") {
        return if zh {
            format!("把桥接串口改为 {settings}")
        } else {
            format!("Set the bridge UART to {settings}")
        };
    }
    if let Some(rest) = text.strip_prefix("@w=") {
        let ssid = match rest.find(',') {
            Some(i) => &rest[..i],
            None => rest,
        };
        return if zh {
            format!("连接 WiFi「{ssid}」（密码不显示）")
        } else {
            format!("Join WiFi \"{ssid}\" (password hidden)")
        };
    }
    if text == "@w off" {
        return if zh {
            "断开 WiFi 并清除当前配置".to_string()
        } else {
            "Disconnect WiFi and clear the current configuration".to_string()
        };
    }
    if let Some(url) = text.strip_prefix("@d=") {
        let url = redact_command(command)
            .strip_prefix("@d=")
            .unwrap_or(url)
            .to_string();
        return if zh {
            format!("启用日志上传到 {url}")
        } else {
            format!("Enable log upload to {url}")
        };
    }
    if text == "@d off" {
        return if zh {
            "关闭 WebDAV 日志上传".to_string()
        } else {
            "Disable WebDAV log upload".to_string()
        };
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uart_settings_round_trip() {
        let cmd = set_uart_command(&UartSettings {
            baud: 115200,
            data_bits: 8,
            parity: "N".to_string(),
            stop_bits: 1,
            flow: "none".to_string(),
        })
        .unwrap();
        assert_eq!(cmd, "@u=115200,8,n,1,none");
        let parsed = parse_uart_settings("OK uart=115200,8,N,1,none").unwrap();
        assert_eq!(parsed.baud, 115200);
        assert_eq!(parsed.parity, "n");
        assert_eq!(parsed.flow, "none");
    }

    #[test]
    fn uart_bounds_are_enforced_here_not_on_the_device() {
        let mut s = UartSettings {
            baud: 299,
            data_bits: 8,
            parity: "n".into(),
            stop_bits: 1,
            flow: "none".into(),
        };
        assert!(set_uart_command(&s).is_err());
        s.baud = 3_000_001;
        assert!(set_uart_command(&s).is_err());
        s.baud = 115200;
        s.parity = "x".into();
        assert!(set_uart_command(&s).is_err());
    }

    #[test]
    fn wifi_commands_and_their_redaction() {
        assert_eq!(
            wifi_command("connect", "MyNet", "pw").unwrap(),
            "@w=MyNet,pw"
        );
        assert_eq!(wifi_command("off", "", "").unwrap(), "@w off");
        // `scan` is a word of its own and not a network called "scan": the
        // firmware reads the words `off` and `scan` before it reads anything
        // else, so an SSID is never silently turned into one.
        assert_eq!(wifi_command("scan", "", "").unwrap(), "@w scan");
        assert!(wifi_command("connect", "", "pw").is_err());
        assert!(wifi_command("connect", "a,b", "pw").is_err());
        assert!(wifi_command("connect", "x".repeat(33).as_str(), "").is_err());
        // The password is never shown.
        assert_eq!(redact_command("@w=MyNet,pw"), "@w=MyNet,<redacted>");
        assert_eq!(redact_command("@w=MyNet"), "@w=MyNet");
    }

    #[test]
    fn webdav_commands_and_url_credential_redaction() {
        assert_eq!(
            webdav_command("on", "http://host:8080/dav/").unwrap(),
            "@d=http://host:8080/dav/"
        );
        assert_eq!(webdav_command("off", "").unwrap(), "@d off");
        assert!(webdav_command("on", "ftp://host").is_err());
        assert!(webdav_command("on", "https://host/dav/ with space").is_err());
        assert_eq!(
            redact_command("@d=https://user:pw@host/dav/"),
            "@d=https://<redacted>@host/dav/"
        );
    }

    #[test]
    fn webdav_rejects_destinations_the_firmware_cannot_store() {
        for url in [
            "",
            " \t ",
            "https://host/dav/",
            "http://user:pw@host/dav/",
            "http://[::1]/dav/",
            "http://host/dav/?q=1",
            "http://host/dav/#part",
            "http://host/dav,other/",
            "http://host/with space",
            "http:///dav/",
            "http://host:0/dav/",
            "http://host:65536/dav/",
            "http://host:not-a-port/dav/",
        ] {
            assert!(webdav_command("on", url).is_err(), "accepted {url:?}");
        }
        let too_long = format!("http://host/{}", "中".repeat(85));
        assert!(too_long.chars().count() < AccessoryLimits::WEBDAV_URL_MAX);
        assert!(webdav_command("on", &too_long).is_err());
        assert!(webdav_command("on", "http://192.168.1.2:65535/logs/").is_ok());
    }

    #[test]
    fn reply_status_reads_ok_and_err() {
        assert!(reply_status("OK").ok);
        assert!(reply_status("ok wifi=connected").ok);
        let bad = reply_status("ERR ssid too long");
        assert!(!bad.ok);
        assert_eq!(bad.error, "ERR ssid too long");
        assert!(!reply_status("nothing here").ok);
    }

    /// The word check is read through `get`, so a line whose first character is
    /// multi-byte is a line that cannot begin with `ok` or `err` — never a
    /// slice through the middle of that character. This one, a scan result
    /// whose SSID began with a three-byte character, took the whole interface
    /// down when it was read as a status.
    #[test]
    fn a_word_boundary_is_read_on_any_text() {
        assert!(starts_with_word("OK accepted", "ok"));
        assert!(starts_with_word("ok", "ok"));
        assert!(starts_with_word("ERR scan=-16", "err"));
        assert!(!starts_with_word("okay", "ok"));
        assert!(!starts_with_word("非你莫属 wpa2 ch=6 -54dBm", "ok"));
        assert!(!starts_with_word("非你莫属 wpa2 ch=6 -54dBm", "err"));
        assert!(!reply_status("非你莫属 wpa2 ch=6 -54dBm").ok);
    }

    /// The `errno` a refusal came as is read only from the two nouns the
    /// firmware uses, and anything else — including a line that merely says
    /// `ERR` — is not a code at all.
    #[test]
    fn a_wifi_errno_is_read_from_the_bridges_own_line() {
        assert_eq!(wifi_error_code("ERR wifi=-16\r\n"), Some(-16));
        assert_eq!(wifi_error_code("ERR scan=-114"), Some(-114));
        assert_eq!(wifi_error_code("err wifi=-22"), Some(-22));
        assert_eq!(wifi_error_code("ERR wifi not configured"), None);
        assert_eq!(wifi_error_code("ERR format: @w=ssid,pass"), None);
        assert_eq!(wifi_error_code("ERR"), None);
        assert_eq!(wifi_error_code("OK wifi=-16"), None);
        assert_eq!(wifi_error_code("非你莫属 wpa2 ch=6 -16dBm"), None);
    }

    /// These are the firmware's own arithmetic — the C library it is built
    /// with, not Linux's — and each is worth a bell. Getting one wrong is not
    /// a typo a compiler catches: `-114` held here as "already connected"
    /// turned a board saying "I am fine" into a router fault, and it took live
    /// traffic to notice.
    #[test]
    fn the_wifi_codes_are_the_builds_own_errnos() {
        assert_eq!(WIFI_BUSY, -16); // EBUSY
        assert_eq!(WIFI_ALREADY, -120); // EALREADY
        assert_eq!(WIFI_UNREACHABLE, -114); // ENETUNREACH
        assert_eq!(WIFI_TIMEOUT, -116); // ETIMEDOUT
        assert_eq!(WIFI_BAD_ARGUMENT, -22); // EINVAL
        assert_eq!(WIFI_NO_RADIO, -19); // ENODEV
        assert_eq!(WIFI_NO_MEMORY, -12); // ENOMEM
                                         // The radio's own statuses, which are positive and not errnos at all.
        assert_eq!(WIFI_CONN_FAIL, 1);
        assert_eq!(WIFI_CONN_WRONG_PASSWORD, 2);
        assert_eq!(WIFI_CONN_TIMEOUT, 3);
        assert_eq!(WIFI_CONN_AP_NOT_FOUND, 4);
    }

    /// A scan result's line is the radio's note about a network; the name is
    /// what belongs in the form. The fields after it — security, channel,
    /// signal — are peeled off the right so a name with a space in it stays
    /// one name, and a name that reads like a field keeps its word when there
    /// is nothing else on the line.
    #[test]
    fn a_scan_result_line_gives_up_its_name() {
        assert_eq!(
            wifi_name_of("My Home Network wpa2 ch=6 -48dBm"),
            "My Home Network"
        );
        assert_eq!(wifi_name_of("SecondWifi unknown ch=4 -41dBm"), "SecondWifi");
        assert_eq!(wifi_name_of("OpenNet open"), "OpenNet");
        assert_eq!(wifi_name_of("非你莫属 wpa2 ch=6 -54dBm"), "非你莫属");
        assert_eq!(
            wifi_name_of("@scan result BenchNet wpa2 ch=6 -54dBm"),
            "BenchNet",
            "a whole wire line works too, not only the body"
        );
        // The one word there is the name, security word or not.
        assert_eq!(wifi_name_of("open"), "open");
        assert_eq!(wifi_name_of("unknown"), "unknown");
        // A name that ends in a number is a name: there is no signal without
        // a signal's other fields.
        assert_eq!(wifi_name_of("Foo54dBm"), "Foo54dBm");
    }

    /// A scan line comes apart into the three pieces a row draws: the name a
    /// join takes, the signal the dots are ranked by, and the radio's notes
    /// between them.
    #[test]
    fn a_scan_result_line_comes_apart_into_name_signal_and_notes() {
        let parsed = parse_wifi_result("@scan result My Home Network wpa2 ch=6 -48dBm");
        assert_eq!(parsed.name, "My Home Network");
        assert_eq!(parsed.signal_dbm, Some(-48));
        assert_eq!(parsed.rest, "wpa2 ch=6");

        // Both unit spellings, and a plus sign, are readable.
        assert_eq!(
            parse_wifi_result("BenchNet wpa2 ch=6 -54dB").signal_dbm,
            Some(-54)
        );
        assert_eq!(
            parse_wifi_result("BenchNet wpa2 ch=6 +54dBm").signal_dbm,
            Some(54)
        );

        // No signal on the line: no reading to report, notes kept as found.
        let open = parse_wifi_result("OpenNet open");
        assert_eq!(open.name, "OpenNet");
        assert_eq!(open.signal_dbm, None);
        assert_eq!(open.rest, "open");
        let bare = parse_wifi_result("Foo54dBm");
        assert_eq!(bare.name, "Foo54dBm");
        assert_eq!(bare.signal_dbm, None);
        assert_eq!(bare.rest, "");
    }

    #[test]
    fn wifi_status_parsing_including_commas_in_the_ssid() {
        let s = parse_wifi_status("OK wifi=connected,ssid=My,Net,ip=192.168.1.5").unwrap();
        assert_eq!(s.state, "connected");
        assert_eq!(s.ssid, "My,Net");
        assert_eq!(s.ip, "192.168.1.5");
        let off = parse_wifi_status("OK wifi off").unwrap();
        assert_eq!(off.state, "off");
        assert_eq!(off.ssid, "");
        let dash = parse_wifi_status("OK wifi=connected,ssid=-").unwrap();
        assert_eq!(dash.ssid, "");
    }

    #[test]
    fn approval_summaries_are_worded_per_language_and_never_show_a_password() {
        assert_eq!(
            accessory_change_summary("@w=MyNet,pw", true),
            "连接 WiFi「MyNet」（密码不显示）"
        );
        assert_eq!(
            accessory_change_summary("@w=MyNet,pw", false),
            "Join WiFi \"MyNet\" (password hidden)"
        );
        assert_eq!(
            accessory_change_summary("@w off", true),
            "断开 WiFi 并清除当前配置"
        );
        assert_eq!(
            accessory_change_summary("@d=https://h/d/", false),
            "Enable log upload to https://h/d/"
        );
        assert_eq!(
            accessory_change_summary("@d=https://user:pw@h/d/", false),
            "Enable log upload to https://<redacted>@h/d/"
        );
        assert_eq!(
            accessory_change_summary("@d off", true),
            "关闭 WebDAV 日志上传"
        );
    }

    #[test]
    fn webdav_status_parsing_keeps_the_whole_url() {
        let s = parse_webdav_status("OK webdav=on,url=https://host/dav/?a=1").unwrap();
        assert_eq!(s.state, "on");
        assert_eq!(s.url, "https://host/dav/?a=1");
        let off = parse_webdav_status("OK webdav off").unwrap();
        assert_eq!(off.state, "off");
        assert_eq!(off.url, "");
    }

    #[test]
    fn ble_name_commands_and_byte_limits() {
        assert_eq!(ble_name_command("Bench Bee").unwrap(), "@n=Bench Bee");
        assert_eq!(ble_name_command("测试😀").unwrap(), "@n=测试😀");
        assert_eq!(reset_ble_name_command(), "@n default");
        // The limit is bytes, not characters: seven four-byte emoji are 28.
        assert!(ble_name_command(&"😀".repeat(7)).is_ok());
        assert!(ble_name_command(&"😀".repeat(8)).is_err());
        assert!(ble_name_command("").is_err());
        assert!(ble_name_command("   ").is_err());
        assert!(ble_name_command("one\ntwo").is_err());
        // The firmware's full reject set, not only C0/DEL: C1 and the two
        // Unicode line separators are refused before the command is sent.
        assert!(ble_name_command("a\u{85}b").is_err());
        assert!(ble_name_command("a\u{2028}b").is_err());
        assert!(ble_name_command("a\u{2029}b").is_err());
        // Surrounding ASCII whitespace is trimmed rather than persisted;
        // NBSP and U+3000 are ordinary name bytes and survive.
        assert_eq!(ble_name_command("  Bee  ").unwrap(), "@n=Bee");
        assert_eq!(
            ble_name_command("\u{a0}Bee\u{3000}").unwrap(),
            "@n=\u{a0}Bee\u{3000}"
        );
    }

    #[test]
    fn ble_name_replies_keep_spaces_and_read_customness() {
        let queried = parse_ble_name("OK name=Bench Bee 078C custom=yes").unwrap();
        assert_eq!(queried.name, "Bench Bee 078C");
        assert_eq!(queried.custom, Some(true));
        let default = parse_ble_name("OK name=Linkr Bee 078C custom=no").unwrap();
        assert_eq!(default.name, "Linkr Bee 078C");
        assert_eq!(default.custom, Some(false));
        // A name that itself ends in the suffix text survives: only the final
        // ` custom=` field belongs to the reply.
        let tricky = parse_ble_name("OK name=Bee custom=yes custom=no").unwrap();
        assert_eq!(tricky.name, "Bee custom=yes");
        assert_eq!(tricky.custom, Some(false));
        assert_eq!(
            parse_ble_name("OK name=Bee custom=maybe").unwrap().name,
            "Bee custom=maybe"
        );
        // The parser strips the line ending, not Unicode whitespace the
        // firmware would have stored.
        let padded = parse_ble_name("OK name=Bee\u{3000} custom=no").unwrap();
        assert_eq!(padded.name, "Bee\u{3000}");
        assert!(parse_ble_name("ERR name expected 1-29 UTF-8 bytes").is_none());
    }

    #[test]
    fn ble_name_change_summaries_are_worded_per_language() {
        assert_eq!(
            accessory_change_summary("@n=测试😀", true),
            "把 BLE 广播名改为「测试😀」"
        );
        assert_eq!(
            accessory_change_summary("@n=Bench Bee", false),
            "Set the BLE advertised name to \"Bench Bee\""
        );
        assert_eq!(
            accessory_change_summary("@n default", true),
            "恢复由硬件 MAC 生成的默认 BLE 名称"
        );
    }
}

#[cfg(test)]
mod lan_tests {
    use super::*;

    /// `@s?` is the only place a token can be learned, and this is the shape it
    /// comes back in — from the real web client's own parser.
    #[test]
    fn a_socket_status_reports_its_token() {
        let status =
            parse_lan_status("OK ws=on token=0123456789abcdef0123456789abcdef").expect("parses");
        assert_eq!(status.ws, "on");
        assert_eq!(status.token, "0123456789abcdef0123456789abcdef");
    }

    /// `token=none` is an answer, not a blank: LAN auth was switched off and the
    /// dial must be attempted with nothing.
    #[test]
    fn a_socket_status_without_auth_says_none() {
        let status = parse_lan_status("OK ws=on token=none").expect("parses");
        assert_eq!(status.token, "");
    }

    /// Uppercase is what a user's own `@s token=` writes and what some firmware
    /// echoes; the wire is lowercase, so it is lowered here rather than rejected.
    #[test]
    fn a_token_is_lowered_because_the_wire_is() {
        let status =
            parse_lan_status("OK ws=on token=ABCDEF0123456789ABCDEF0123456789").expect("parses");
        assert_eq!(status.token, "abcdef0123456789abcdef0123456789");
    }

    /// A line that is not a socket status is not one — the diagnostics reply has
    /// plenty of `x=y` in it and none of them is a token.
    #[test]
    fn an_unrelated_line_is_not_a_socket_status() {
        assert!(parse_lan_status("OK info fw=1.2.3").is_none());
        assert!(parse_lan_status("").is_none());
    }
}
