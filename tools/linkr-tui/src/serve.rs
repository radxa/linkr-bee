//! A resident session: one link, many requests, until it is told to stop.
//!
//! The command line's script modes answer one question per process, and the
//! link is dialled and hung up around each of them. That is the right shape
//! for a shell script and the wrong one for an agent working through a
//! problem: a Bluetooth dial is seconds of radio work, the board serves one
//! connection at a time, and a caller that has to reconnect for every
//! question spends its time waiting on the radio instead of asking.
//!
//! `--serve` is the other shape. One process holds the link and reads
//! requests — one JSON object per line on stdin — until its input ends or it
//! is asked to quit. Every request is answered on stdout, in the same JSON
//! event stream the one-shot modes speak, wrapped in a `begin`/`end` pair
//! that carries the request's own id and the exit code its one-shot
//! equivalent would have had:
//!
//! ```text
//! {"event":"ready","program":"bee","version":"0.1.2","link":"ble EE:…","ops":[…]}
//! (the `program` value is the name this copy was invoked as, so a CLI-only
//! install reports `bee-cli`).
//! {"id":1,"op":"query-uart"}                       →  {"event":"begin","id":1,"op":"uart"} … {"event":"end","id":1,"code":0}
//! {"id":2,"op":"exec","cmd":"uname -a"}            →  the exec events, then end with the command's own code
//! {"id":3,"op":"wifi"}                             →  a result event, then end
//! {"id":4,"op":"quit"}                             →  end, and the session hangs up
//! ```
//!
//! The stream between `begin` and `end` is exactly what the one-shot mode
//! would have printed for the same request, ids and all left as they are —
//! one request is answered at a time, so the frame is what tells two answers
//! apart. A request that cannot be served because the link is gone is retried
//! *after a dial*: a session outlives the board being switched off, so the
//! next request that needs the link dials it again, and only the requests
//! that edge touches hear about it.
//!
//! What this is not: a daemon, a socket, or a second protocol. It is the
//! existing one-shot machinery with the process held open around it, which is
//! what makes it small enough to trust with a board on the far end.

use std::io::{self, BufRead, BufReader, Read};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use crate::app::App;
use crate::cli::{self, Format, Json};
use crate::device::Query;
use crate::exec::cli::{Ending, Run};
use crate::session::Dial;
use crate::transport::LinkKind;

/// How long a `loopback-test` request waits when it did not say.
///
/// The same three seconds `--loopback-test` gets from the command line, kept
/// in step with it by hand: the request is the flag, spelled in JSON.
const DEFAULT_LOOPBACK_TIMEOUT: Duration = Duration::from_secs(3);
const IDLE_POLL: Duration = Duration::from_millis(20);

fn request_reader(input: impl Read + Send + 'static) -> Receiver<io::Result<String>> {
    let (sender, requests) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut input = BufReader::new(input);
        loop {
            let mut line = String::new();
            let result = match input.read_line(&mut line) {
                Ok(0) => return,
                Ok(_) => Ok(line),
                Err(error) => Err(error),
            };
            let failed = result.is_err();
            if sender.send(result).is_err() || failed {
                return;
            }
        }
    });
    requests
}

fn wait_for_request(
    app: &mut App,
    requests: &Receiver<io::Result<String>>,
) -> io::Result<Option<String>> {
    // Idle UART bytes belong in the bounded terminal/journal, not the last
    // command's output collector or an undrained transport queue.
    app.collect_output = false;
    app.take_output();
    loop {
        app.pump();
        match requests.recv_timeout(IDLE_POLL) {
            Ok(line) => return line.map(Some),
            Err(RecvTimeoutError::Disconnected) => return Ok(None),
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// The operations a session answers, in the order the ready line lists them.
///
/// Written out rather than derived from the dispatcher, because it is the
/// contract a caller reads *first*, before it knows anything else about this
/// build — a list generated at the same place `action_for` decides would
/// still be the list, but one a reader can check the dispatcher against is
/// what a caller arriving from the README needs. `--capabilities` names the
/// same list through [`operations_json`].
pub const OPERATIONS: &[&str] = &[
    "info",
    "uart",
    "wifi",
    "wifi-off",
    "wifi-scan",
    "webdav",
    "webdav-off",
    "ble-name",
    "lan",
    "exec",
    "loopback-test",
    "state",
    "quit",
];

/// The operations as a JSON array, for `--capabilities`.
///
/// Every operation this build has, in the build's own right: `--capabilities`
/// answers "what is in this program", which does not depend on what the caller
/// is about to dial. A *session* promises what its link can serve instead —
/// see [`operations_for`].
pub fn operations_json() -> String {
    json_ops(OPERATIONS)
}

/// The operations a session on this link can answer, as a JSON array.
pub fn operations_json_for(kind: Option<LinkKind>) -> String {
    json_ops(&operations_for(kind))
}

/// A list of operation names as the JSON array the ready line and
/// `--capabilities` both print.
fn json_ops(ops: &[&str]) -> String {
    let list: Vec<String> = ops.iter().map(|op| format!("\"{op}\"")).collect();
    format!("[{}]", list.join(","))
}

/// The operations a session on this kind of link can actually answer.
///
/// The management reads and writes are BLE-only by construction: `@i?` and its
/// neighbours are frames on the bridge's own characteristic, and a LAN socket
/// or a serial line has no such channel — the bridge there is a byte pipe.
/// A ready line that listed them anyway would promise twelve operations and
/// hold four, and the caller pays for the difference with a request it cannot use
/// (the answer to which is "management is BLE-only", exit 1).
///
/// A session with nothing to dial — which the command line refuses before a
/// session ever starts — falls back to the operations that need no link at
/// all: the same two its `not_connected` refusals would leave reachable.
pub fn operations_for(kind: Option<LinkKind>) -> Vec<&'static str> {
    OPERATIONS
        .iter()
        .copied()
        .filter(|op| match kind {
            Some(LinkKind::Ble) => true,
            Some(_) => !is_ble_only(op),
            None => !needs_a_link(op),
        })
        .collect()
}

/// Whether this operation is answered by the bridge's management channel.
///
/// Kept beside the list it explains rather than derived from `action_for`:
/// the reader this exists for is checking one against the other.
fn is_ble_only(op: &str) -> bool {
    matches!(
        op,
        "info"
            | "uart"
            | "wifi"
            | "webdav"
            | "webdav-off"
            | "wifi-off"
            | "wifi-scan"
            | "lan"
            | "ble-name"
    )
}

/// Whether this operation needs a link at all — the name-shaped twin of
/// [`needs_link`], kept beside the list it filters.
fn needs_a_link(op: &str) -> bool {
    !matches!(op, "state" | "quit")
}

/// Run the resident session until its input ends or it is told to stop.
///
/// Returns the process exit code: 0 for a clean hang-up (end of input, or a
/// `quit` request), 2 for an input that could not be read at all. The link is
/// not dialled here — a session that starts before the board is powered is a
/// session that can still be asked things — but every request that needs it
/// dials it if it is not up, so the first request pays for the radio and the
/// rest do not.
pub fn run(app: &mut App, dial: Option<Dial>, connect: Duration, program: &str) -> i32 {
    let link = dial
        .as_ref()
        .map(Dial::describe)
        .unwrap_or_else(|| "none".to_string());
    let ops = operations_json_for(dial.as_ref().map(Dial::kind));
    println!(
        "{}",
        cli::json_event(&[
            ("event", Json::Text("ready")),
            ("program", Json::Text(program)),
            ("version", Json::Text(env!("CARGO_PKG_VERSION"))),
            ("link", Json::Text(&link)),
            ("ops", Json::Raw(&ops)),
        ])
    );

    let requests = request_reader(std::io::stdin());
    loop {
        let line = match wait_for_request(app, &requests) {
            // End of input: the caller stopped listening. That is the
            // session's own hang-up — a caller that wanted an answer would
            // have kept the pipe open — and the link goes down with it.
            Ok(None) => break,
            Ok(Some(line)) => line,
            Err(why) => {
                eprintln!("error: the session could not read its input: {why}");
                // Ended out loud rather than merely dropped: the caller's pipe
                // broke, and the board must not be left holding a link to a
                // session that can no longer hear it.
                app.hang_up(crate::hangup::EXIT_GRACE);
                return 2;
            }
        };
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        let request = match parse_request(text) {
            Ok(request) => request,
            // A line that is not a request is not a reason to hang up: a
            // caller that sent one bad line wants the mistake named and the
            // session left where it was.
            Err(why) => {
                emit_error(None, "bad_request", &why);
                continue;
            }
        };
        let id = request.id;
        let op = request.op.clone();
        frame_begin(id, &op);
        let code = match action_for(&request) {
            Err(why) => {
                emit_error(id, "bad_request", &why);
                2
            }
            Ok(Action::Quit) => {
                println!(
                    "{}",
                    cli::json_event(&[
                        ("event", Json::Text("result")),
                        ("what", Json::Text("quit")),
                        ("ok", Json::Bool(true)),
                    ])
                );
                frame_end(id, 0);
                // The caller asked for the session to be over; the board is
                // told so before the answer is even read back, because a link
                // left standing is a board the next client cannot find.
                app.hang_up(crate::hangup::EXIT_GRACE);
                return 0;
            }
            Ok(action) => {
                // The one field that changes how the answer reads rather
                // than what is asked: text is for a person watching the
                // session by hand, JSON — the default — for everything
                // else. The frame's own two lines are JSON either way,
                // because they are what a caller reads to find the answer.
                let format = match request.text("format") {
                    Some("text") => Format::Text,
                    _ => Format::Json,
                };
                if needs_link(&action) && ensure_link(app, dial.as_ref(), connect, id).is_err() {
                    255
                } else {
                    handle(app, action, format, connect)
                }
            }
        };
        frame_end(id, code);
    }
    app.session.close();
    0
}

/// What one request asks the session to do.
#[derive(Debug)]
enum Action {
    /// The management requests, in the shape `--no-terminal` already speaks.
    Requests(cli::Requests),
    /// One command on the target, with the terms the request set.
    Exec(Run),
    /// The wire test, with its payload and its window.
    Loopback { data: String, timeout: Duration },
    /// What the session and its link are doing.
    State,
    /// Hang up and leave.
    Quit,
}

/// Whether answering this needs a link at all.
///
/// `state` is the one that does not, and deliberately so: a caller whose
/// board is off asks this to find out that it is, and an answer that
/// required a board would be no answer.
fn needs_link(action: &Action) -> bool {
    !matches!(action, Action::State | Action::Quit)
}

/// Make sure there is a link before a request that needs one.
///
/// Dialling lazily is the point of a resident session: a caller may start it
/// before the board is powered, and the board may drop or be switched off
/// between two questions. A dial that fails says so in the code a caller
/// branches on — `not_connected` — and the session goes on, so the request
/// after it can succeed once the board is back.
fn ensure_link(
    app: &mut App,
    dial: Option<&Dial>,
    connect: Duration,
    id: Option<i64>,
) -> Result<(), ()> {
    if app.session.is_live() {
        return Ok(());
    }
    let Some(dial) = dial else {
        emit_error(id, "not_connected", "the session has no link to dial");
        return Err(());
    };
    if let Err(err) = app.dial(dial) {
        emit_error(id, "not_connected", &err.to_string());
        eprintln!("error: {err}");
        return Err(());
    }
    // The dial opened the link; the session reports itself connected a pump
    // later, exactly as a script run's first request finds it.
    cli::wait_for_connected(app, connect);
    Ok(())
}

/// Answer one request with the machinery the one-shot modes use.
fn handle(app: &mut App, action: Action, format: Format, connect: Duration) -> i32 {
    match action {
        Action::Requests(requests) => {
            let failed = cli::run_requests(app, &requests, format, connect);
            if failed > 0 {
                1
            } else {
                0
            }
        }
        Action::Exec(run) => crate::exec::cli::run(app, &run, format),
        Action::Loopback { data, timeout } => {
            if cli::loopback_test(app, data.as_bytes(), timeout, format) {
                0
            } else {
                1
            }
        }
        Action::State => {
            report_state(app, format);
            0
        }
        // Answered before `handle` is reached; kept for exhaustiveness.
        Action::Quit => 0,
    }
}

/// What the session and its link are doing, for the one request that is
/// answered without a link.
///
/// Public because the one-shot `--link-state` is the same report: a session's
/// `state` request and a caller's flag must not describe the same link in two
/// different shapes.
pub fn report_state(app: &App, format: Format) {
    let live = app.session.is_live();
    let connected = app.connected();
    let dialing = app.dialing.is_some();
    // The session's counters, not the app's: `app.rx`/`app.tx` are the frame's
    // copies of them, refreshed on the terminal's beat, and a run with no
    // terminal has no beat — reading those would describe a link that just
    // carried a question and its answer as one that moved nothing.
    let rx = app.session.rx();
    let tx = app.session.tx();
    match format {
        Format::Text => println!(
            "state: live={live}, connected={connected}, dialing={dialing}, \
             link={}, rx={rx}, tx={tx}{}",
            app.session.describe(),
            app.baud
                .map(|baud| format!(", uart={baud}"))
                .unwrap_or_default()
        ),
        Format::Json => println!(
            "{}",
            cli::json_event(&[
                ("event", Json::Text("result")),
                ("what", Json::Text("state")),
                ("ok", Json::Bool(true)),
                ("live", Json::Bool(live)),
                ("connected", Json::Bool(connected)),
                ("dialing", Json::Bool(dialing)),
                ("link", Json::Text(app.session.describe())),
                ("rx", Json::Number(rx as i64)),
                ("tx", Json::Number(tx as i64)),
                (
                    "uart",
                    app.baud
                        .map(|baud| Json::Number(i64::from(baud)))
                        .unwrap_or(Json::Null)
                ),
            ])
        ),
    }
}

/// The fields one op takes, beside the three every request may carry.
///
/// `None` means the op is not one this session knows, and the op's own error
/// is the answer to it. Written out here — rather than read off the parsing of
/// each arm — so that the set a caller reads in the manual is the set the
/// parser enforces; a request is refused by name, never by silence.
fn accepted_fields(op: &str) -> Option<&'static [&'static str]> {
    match op {
        "info" | "lan" | "state" | "quit" | "wifi-off" | "wifi-scan" | "webdav-off" => Some(&[]),
        "uart" => Some(&["value"]),
        "wifi" => Some(&["ssid", "pass"]),
        "webdav" => Some(&["url"]),
        "ble-name" => Some(&["name", "default"]),
        "exec" => Some(&["cmd", "timeout_ms", "idle_ms", "retry"]),
        "loopback-test" => Some(&["data", "timeout_ms"]),
        _ => None,
    }
}

/// Refuse a request that carries a field this session does not read.
///
/// Silence here is what let `"timeout": 2` run with the thirty-second default:
/// the caller's intent was overridden by its own spelling and nothing said so,
/// while a field of the right name with the wrong type was refused. One
/// standard, then: everything that is not a field of this op is named. A near
/// miss is named *twice* — `timeout` is told about `timeout_ms` — because a
/// caller who spelled it almost right is worth one sentence.
fn check_fields(request: &Request) -> Result<(), String> {
    let Some(accepted) = accepted_fields(&request.op) else {
        return Ok(());
    };
    for (field, _) in &request.fields {
        // `id` and `op` are the frame's own; `format` is read for every
        // request, before the op is even looked at.
        if matches!(field.as_str(), "id" | "op" | "format") {
            continue;
        }
        if !accepted.contains(&field.as_str()) {
            let hint = closest_field(field, accepted)
                .map(|close| format!("; did you mean \"{close}\"?"))
                .unwrap_or_default();
            return Err(format!(
                "unknown field \"{field}\" for op \"{}\"{hint}",
                request.op
            ));
        }
    }
    Ok(())
}

/// The accepted field a spelling was reaching for, when one is obvious: a
/// prefix either way, the shortest such match (so `timeout` finds
/// `timeout_ms` and not everything else that starts the same way).
fn closest_field<'a>(given: &str, accepted: &[&'a str]) -> Option<&'a str> {
    accepted
        .iter()
        .filter(|candidate| candidate.starts_with(given) || given.starts_with(**candidate))
        .min_by_key(|candidate| candidate.len())
        .copied()
}

/// The operation one request names, or the sentence a caller is owed instead.
fn action_for(request: &Request) -> Result<Action, String> {
    check_fields(request)?;
    let mut requests = cli::Requests::default();
    match request.op.as_str() {
        "info" => requests.queries.push(Query::Diagnostics),
        "lan" => requests.queries.push(Query::Lan),
        // A read, and a write when a value rides along: the session's
        // spelling of `--query-uart` and `--uart <spec>`.
        "uart" => match request.value("value") {
            Some(_) => requests.uart = Some(request.string_wanted("value")?.to_string()),
            None => requests.queries.push(Query::Uart),
        },
        // A join is a name and a password, and each is wanted before the
        // request goes anywhere: an empty password reaches the firmware as
        // "open network", and an empty name reaches it as the *forget* it
        // never asked for. Both are refused here in the same words the command
        // line uses, because they are one decision.
        "wifi" => match request.value("ssid") {
            Some(_) => {
                let ssid = request.string_wanted("ssid")?.to_string();
                if ssid.trim().is_empty() {
                    return Err(
                        "wifi wants a network to join; use op \"wifi-off\" to forget the saved one"
                            .to_string(),
                    );
                }
                let pass = request.text("pass").unwrap_or_default().to_string();
                if pass.trim().is_empty() {
                    return Err(
                        "wifi wants a password: the bridge reads an empty one as an open network"
                            .to_string(),
                    );
                }
                requests.wifi = Some((ssid, pass));
            }
            None => requests.queries.push(Query::Wifi),
        },
        // The session's spelling of `--query-webdav` and `--webdav <url>`.
        "webdav" => match request.value("url") {
            Some(_) => {
                let url = request.string_wanted("url")?;
                crate::accessory::webdav_command("on", url)?;
                requests.webdav = Some(url.to_string());
            }
            None => requests.queries.push(Query::Webdav),
        },
        "webdav-off" => requests.webdav_off = true,
        // One op with three shapes, as `wifi` has two: no field reads, a
        // `name` sets, and `"default": true` restores the MAC-derived name.
        // A request with both is refused rather than ordered, because either
        // order is a surprise.
        "ble-name" => match (request.value("name"), request.value("default")) {
            (Some(_), Some(_)) => {
                return Err("ble-name takes either \"name\" or \"default\", not both".to_string())
            }
            (Some(_), None) => {
                let name = request.string_wanted("name")?.to_string();
                crate::accessory::ble_name_command(&name)?;
                requests.ble_name = Some(name);
            }
            (None, Some(Value::Bool(true))) => requests.ble_name_default = true,
            // `"default": false` asks for nothing; answering it as a
            // successful no-op would tell a caller its request was heard
            // when it was not a request at all.
            (None, Some(Value::Bool(false))) => {
                return Err(
                    "ble-name takes \"name\", \"default\": true, or neither to read".to_string(),
                )
            }
            (None, Some(_)) => return Err("default must be true or false".to_string()),
            (None, None) => requests.queries.push(Query::BleName),
        },
        "wifi-off" => requests.wifi_off = true,
        "wifi-scan" => requests.wifi_scan = true,
        "exec" => {
            let command = request.string_wanted("cmd")?.to_string();
            if command.trim().is_empty() {
                return Err("exec wants a command to run".to_string());
            }
            let timeout = request
                .millis("timeout_ms")?
                .unwrap_or(crate::exec::cli::DEFAULT_TIMEOUT);
            // An idle window is always priced and always weaker; a request
            // that does not price one gets the marker ending, the same way
            // the command line's default does.
            let ending = match request.millis("idle_ms")? {
                Some(window) => Ending::Idle(window),
                None => Ending::RcMarker,
            };
            let retry = match request.value("retry") {
                None | Some(Value::Null) => 0,
                Some(Value::Number(times)) if *times >= 0 => *times as u32,
                Some(_) => return Err("retry must be a number of times".to_string()),
            };
            return Ok(Action::Exec(Run {
                command,
                ending,
                timeout,
                retry,
            }));
        }
        "loopback-test" => {
            let data = request.string_wanted("data")?.to_string();
            let timeout = request
                .millis("timeout_ms")?
                .unwrap_or(DEFAULT_LOOPBACK_TIMEOUT);
            return Ok(Action::Loopback { data, timeout });
        }
        "state" => return Ok(Action::State),
        "quit" => return Ok(Action::Quit),
        other => {
            return Err(format!(
                "unknown op \"{other}\"; the ready line lists what a session answers"
            ))
        }
    }
    Ok(Action::Requests(requests))
}

fn frame_begin(id: Option<i64>, op: &str) {
    println!(
        "{}",
        cli::json_event(&[
            ("event", Json::Text("begin")),
            ("id", id_json(id)),
            ("op", Json::Text(op)),
        ])
    );
}

fn frame_end(id: Option<i64>, code: i32) {
    println!(
        "{}",
        cli::json_event(&[
            ("event", Json::Text("end")),
            ("id", id_json(id)),
            ("code", Json::Number(i64::from(code))),
        ])
    );
}

fn emit_error(id: Option<i64>, code: &str, message: &str) {
    println!(
        "{}",
        cli::json_event(&[
            ("event", Json::Text("error")),
            ("id", id_json(id)),
            ("code", Json::Text(code)),
            ("message", Json::Text(message)),
        ])
    );
}

fn id_json(id: Option<i64>) -> Json<'static> {
    match id {
        Some(id) => Json::Number(id),
        None => Json::Null,
    }
}

// --- reading a request --------------------------------------------------------

/// One request, as a line spelled it.
///
/// A flat map: keys and scalar values, which is all a request has ever needed
/// and all the reader has to understand. `id` and `op` are lifted out because
/// every request has them and every answer quotes them; everything else stays
/// a field for the operation's own reader.
#[derive(Debug, Default)]
struct Request {
    id: Option<i64>,
    op: String,
    fields: Vec<(String, Value)>,
}

/// One value in a request.
#[derive(Debug, Clone, PartialEq)]
enum Value {
    Text(String),
    Number(i64),
    Bool(bool),
    Null,
}

impl Request {
    fn value(&self, key: &str) -> Option<&Value> {
        self.fields
            .iter()
            .find(|(field, _)| field == key)
            .map(|(_, value)| value)
    }

    fn text(&self, key: &str) -> Option<&str> {
        match self.value(key) {
            Some(Value::Text(text)) => Some(text),
            _ => None,
        }
    }

    fn string_wanted(&self, key: &str) -> Result<&str, String> {
        match self.value(key) {
            None => Err(format!("{key} is missing")),
            Some(Value::Text(text)) => Ok(text),
            Some(_) => Err(format!("{key} must be a string")),
        }
    }

    fn millis(&self, key: &str) -> Result<Option<Duration>, String> {
        match self.value(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(number)) if *number > 0 => {
                Ok(Some(Duration::from_millis(*number as u64)))
            }
            Some(Value::Number(_)) => {
                Err(format!("{key} must be a positive number of milliseconds"))
            }
            Some(_) => Err(format!("{key} must be a number of milliseconds")),
        }
    }
}

/// Read one request line, or say what is wrong with it.
///
/// Strict on purpose, and the error is the point: a caller that sent
/// `"timeout_ms": 30000.0` or nested its fields gets a sentence naming the
/// problem instead of a request that half-ran. The shape is a flat object of
/// scalars; anything else is not a request this session knows.
fn parse_request(line: &str) -> Result<Request, String> {
    let mut reader = Reader { text: line, at: 0 };
    reader.space();
    reader.want('{')?;
    let mut fields = Vec::new();
    reader.space();
    if reader.peek() == Some('}') {
        reader.at += 1;
    } else {
        loop {
            reader.space();
            let key = reader.string()?;
            reader.space();
            reader.want(':')?;
            reader.space();
            let value = reader.value()?;
            fields.push((key, value));
            reader.space();
            match reader.peek() {
                Some(',') => reader.at += 1,
                Some('}') => {
                    reader.at += 1;
                    break;
                }
                _ => {
                    return Err(
                        "a request is one JSON object, with commas between its fields".to_string(),
                    )
                }
            }
        }
    }
    reader.space();
    if reader.at < line.len() {
        return Err(format!(
            "a request is one JSON object, and there is more after it: {:?}",
            &line[reader.at..]
        ));
    }
    let mut request = Request::default();
    for (key, value) in fields {
        match key.as_str() {
            "id" => match value {
                Value::Number(id) => request.id = Some(id),
                _ => return Err("id must be a number".to_string()),
            },
            "op" => match value {
                Value::Text(op) => request.op = op,
                _ => return Err("op must be a string".to_string()),
            },
            _ => request.fields.push((key, value)),
        }
    }
    if request.op.is_empty() {
        return Err("the request names no op".to_string());
    }
    Ok(request)
}

/// A cursor over one request line.
struct Reader<'a> {
    text: &'a str,
    at: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<char> {
        self.text[self.at..].chars().next()
    }

    fn space(&mut self) {
        while let Some(ch) = self.peek() {
            if ch.is_whitespace() {
                self.at += ch.len_utf8();
            } else {
                break;
            }
        }
    }

    fn want(&mut self, wanted: char) -> Result<(), String> {
        match self.peek() {
            Some(ch) if ch == wanted => {
                self.at += ch.len_utf8();
                Ok(())
            }
            Some(ch) => Err(format!("expected {wanted:?} where {ch:?} is")),
            None => Err(format!("expected {wanted:?} at the end of the line")),
        }
    }

    fn expect_word(&mut self, word: &str) -> Result<(), String> {
        if self.text[self.at..].starts_with(word) {
            self.at += word.len();
            Ok(())
        } else {
            Err(format!("expected {word}"))
        }
    }

    /// A JSON string, escapes and all.
    ///
    /// The full escape set, `\u` included, because the caller is not the
    /// only writer in the world: a language that escapes non-ASCII by
    /// default sends Chinese and emoji as surrogate pairs, and a reader that
    /// only understood `\"` would turn those into an error about nothing.
    fn string(&mut self) -> Result<String, String> {
        self.want('"')?;
        let mut out = String::new();
        loop {
            let ch = self
                .peek()
                .ok_or_else(|| "a string was never closed".to_string())?;
            self.at += ch.len_utf8();
            match ch {
                '"' => break,
                '\\' => {
                    let escape = self
                        .peek()
                        .ok_or_else(|| "a string ended in a backslash".to_string())?;
                    self.at += escape.len_utf8();
                    match escape {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let code = self.hex4()?;
                            let ch = if (0xD800..0xDC00).contains(&code) {
                                // A high surrogate: the low one must follow,
                                // which is how every JSON writer spells a
                                // character outside the basic plane.
                                self.expect_word("\\u")?;
                                let low = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&low) {
                                    return Err("a high surrogate must be followed by a low one"
                                        .to_string());
                                }
                                char::from_u32(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00))
                            } else {
                                char::from_u32(code)
                            };
                            out.push(
                                ch.ok_or_else(|| format!("\\u{code:04x} is not a character"))?,
                            );
                        }
                        other => return Err(format!("\\{other} is not an escape a request uses")),
                    }
                }
                ch if (ch as u32) < 0x20 => {
                    return Err("a string carries no raw control characters".to_string())
                }
                ch => out.push(ch),
            }
        }
        Ok(out)
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let ch = self
                .peek()
                .ok_or_else(|| "\\u wants four hexadecimal digits".to_string())?;
            let digit = ch
                .to_digit(16)
                .ok_or_else(|| format!("{ch:?} is not a hexadecimal digit"))?;
            self.at += ch.len_utf8();
            value = value * 16 + digit;
        }
        Ok(value)
    }

    fn number(&mut self) -> Result<i64, String> {
        let start = self.at;
        if self.peek() == Some('-') {
            self.at += 1;
        }
        while let Some(ch) = self.peek() {
            if ch.is_ascii_digit() {
                self.at += 1;
            } else {
                break;
            }
        }
        let text = &self.text[start..self.at];
        if text.is_empty() || text == "-" {
            return Err("expected a number".to_string());
        }
        text.parse()
            .map_err(|_| "the number does not fit in a request".to_string())
    }

    fn value(&mut self) -> Result<Value, String> {
        match self.peek() {
            Some('"') => Ok(Value::Text(self.string()?)),
            Some('{') | Some('[') => {
                Err("a request's fields are scalar values, not lists or objects".to_string())
            }
            Some('t') => {
                self.expect_word("true")?;
                Ok(Value::Bool(true))
            }
            Some('f') => {
                self.expect_word("false")?;
                Ok(Value::Bool(false))
            }
            Some('n') => {
                self.expect_word("null")?;
                Ok(Value::Null)
            }
            Some(ch) if ch == '-' || ch.is_ascii_digit() => {
                // A number is whole by the time it matters: a timeout is
                // spelled in milliseconds, and a request that sent a
                // fraction gets told the rule instead of it being rounded
                // quietly.
                let number = self.number()?;
                if self.peek() == Some('.') {
                    return Err(
                        "numbers in a request are whole; a timeout is in milliseconds".to_string(),
                    );
                }
                Ok(Value::Number(number))
            }
            Some(ch) => Err(format!("{ch:?} does not start a value")),
            None => Err("the line ended where a value was expected".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(line: &str) -> Request {
        parse_request(line).expect("the request parses")
    }

    #[test]
    fn idle_sessions_consume_uart_without_accumulating_command_output() {
        let wire = crate::transport::testing::MemoryLink::new();
        let mut app = App::default();
        app.session.connect(wire.link()).expect("memory link opens");
        app.collect_output = true;
        let (sender, requests) = mpsc::sync_channel(1);
        let device = wire.clone();
        let producer = std::thread::spawn(move || {
            for _ in 0..20 {
                device.feed(b"idle UART output\r\n");
                std::thread::sleep(Duration::from_millis(2));
            }
            std::thread::sleep(Duration::from_millis(80));
            sender
                .send(Ok("{\"op\":\"state\"}\n".to_string()))
                .expect("request");
        });
        let line = wait_for_request(&mut app, &requests)
            .expect("read request")
            .expect("one line");
        assert!(line.contains("state"));
        assert_eq!(app.session.rx(), 20 * b"idle UART output\r\n".len() as u64);
        assert!(!app.collect_output);
        assert!(app.take_output().is_empty());
        producer.join().expect("producer");
        wire.close();
    }

    #[test]
    fn request_reader_preserves_lines_and_reports_eof() {
        let requests = request_reader(io::Cursor::new(b"first\nsecond\n"));
        assert_eq!(requests.recv().unwrap().unwrap(), "first\n");
        assert_eq!(requests.recv().unwrap().unwrap(), "second\n");
        assert!(requests.recv().is_err());
    }

    #[test]
    fn a_request_is_one_flat_object_of_scalars() {
        let parsed = request(r#"{"id":7,"op":"exec","cmd":"uname -a","timeout_ms":30000}"#);
        assert_eq!(parsed.id, Some(7));
        assert_eq!(parsed.op, "exec");
        assert_eq!(parsed.text("cmd"), Some("uname -a"));
        assert_eq!(
            parsed.value("timeout_ms"),
            Some(&Value::Number(30000)),
            "a number reads as a number"
        );
        // Whitespace around the braces is a caller's formatting, not a
        // syntax error.
        assert_eq!(request("  {\"op\":\"state\"}  ").op, "state");
        assert_eq!(
            request(r#"{"id":1,"op":"wifi","pass":null}"#).value("pass"),
            Some(&Value::Null)
        );
    }

    #[test]
    fn a_request_reader_understands_the_escapes_a_writer_may_send() {
        let parsed = request(r#"{"op":"exec","cmd":"printf \"Password:\""}"#);
        assert_eq!(parsed.text("cmd"), Some(r#"printf "Password:""#));
        assert_eq!(
            request(r#"{"op":"exec","cmd":"a\nb"}"#).text("cmd"),
            Some("a\nb")
        );
        // A writer that escapes non-ASCII sends surrogate pairs; reading
        // them back is the difference between an agent's emoji and an error.
        let parsed = request(r#"{"op":"exec","cmd":"echo \ud83d\ude00"}"#);
        assert_eq!(parsed.text("cmd"), Some("echo 😀"));
        // And the `id`/`op` themselves survive an escape.
        assert_eq!(request(r#"{"op":"st\u0061te"}"#).op, "state");
    }

    #[test]
    fn a_request_that_is_not_one_is_refused_by_name() {
        for (line, needle) in [
            ("[1,2,3]", "expected '{'"),
            (r#"{"op":"exec","cmd":{"a":1}}"#, "scalar"),
            (r#"{"op":"exec","cmd":"ls","timeout_ms":1.5}"#, "whole"),
            (r#"{"op":"exec"} trailing"#, "more after it"),
            (r#"{"op":7}"#, "op must be a string"),
            (r#"{"id":"one","op":"state"}"#, "id must be a number"),
            (r#"{"id":1}"#, "names no op"),
            (r#"{"op":"exec","cmd":"a"#, "never closed"),
            (r#"{"op":"exec","cmd":"\q"}"#, "not an escape"),
        ] {
            let error = parse_request(line).expect_err(line);
            assert!(
                error.contains(needle),
                "{line:?} gave {error:?}, wanted {needle:?}"
            );
        }
    }

    #[test]
    fn every_operation_maps_to_the_request_the_one_shot_mode_would_have_built() {
        assert_eq!(
            match action_for(&request(r#"{"op":"info"}"#)) {
                Ok(Action::Requests(requests)) => requests.queries,
                other => panic!("{other:?}"),
            }
            .len(),
            1
        );
        match action_for(&request(r#"{"op":"uart","value":"115200,8,n,1,none"}"#)) {
            Ok(Action::Requests(requests)) => {
                assert_eq!(requests.uart.as_deref(), Some("115200,8,n,1,none"))
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"wifi","ssid":"lab","pass":"secret"}"#)) {
            Ok(Action::Requests(requests)) => {
                assert_eq!(
                    requests.wifi,
                    Some(("lab".to_string(), "secret".to_string()))
                )
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"wifi-off"}"#)) {
            Ok(Action::Requests(requests)) => {
                assert!(requests.wifi_off && !requests.wifi_scan && requests.wifi.is_none())
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"wifi-scan"}"#)) {
            Ok(Action::Requests(requests)) => assert!(requests.wifi_scan),
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"exec","cmd":"uname -a"}"#)) {
            Ok(Action::Exec(run)) => {
                assert_eq!(run.command, "uname -a");
                assert_eq!(run.ending, Ending::RcMarker);
                assert_eq!(run.timeout, crate::exec::cli::DEFAULT_TIMEOUT);
                assert_eq!(run.retry, 0);
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(
            r#"{"op":"exec","cmd":"ls","idle_ms":1500,"retry":2,"timeout_ms":4000}"#,
        )) {
            Ok(Action::Exec(run)) => {
                assert_eq!(run.ending, Ending::Idle(Duration::from_millis(1500)));
                assert_eq!(run.retry, 2);
                assert_eq!(run.timeout, Duration::from_millis(4000));
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"loopback-test","data":"414243"}"#)) {
            Ok(Action::Loopback { data, timeout }) => {
                assert_eq!(data, "414243");
                assert_eq!(timeout, DEFAULT_LOOPBACK_TIMEOUT);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            action_for(&request(r#"{"op":"state"}"#)),
            Ok(Action::State)
        ));
        assert!(matches!(
            action_for(&request(r#"{"op":"quit"}"#)),
            Ok(Action::Quit)
        ));
    }

    #[test]
    fn an_operation_that_cannot_run_says_why() {
        for (line, needle) in [
            (r#"{"op":"telnet"}"#, "unknown op"),
            (r#"{"op":"exec"}"#, "cmd is missing"),
            (r#"{"op":"exec","cmd":"   "}"#, "wants a command"),
            (r#"{"op":"exec","cmd":"ls","idle_ms":0}"#, "positive"),
            (r#"{"op":"exec","cmd":"ls","retry":-1}"#, "number of times"),
            (r#"{"op":"uart","value":7}"#, "must be a string"),
            (r#"{"op":"loopback-test"}"#, "data is missing"),
            // A field nobody reads is named, and a near miss is told the
            // spelling it wanted — the `timeout`/`timeout_ms` pair is the one
            // that was answered with a silent thirty-second wait.
            (r#"{"op":"exec","cmd":"ls","timeout":2}"#, "timeout_ms"),
            (r#"{"op":"exec","cmd":"ls","quiet":true}"#, "unknown field"),
            (r#"{"op":"uart","baud":115200}"#, "unknown field"),
            // A join needs a name and a password; neither may be blank.
            (r#"{"op":"wifi","ssid":"lab"}"#, "wants a password"),
            (
                r#"{"op":"wifi","ssid":"lab","pass":"  "}"#,
                "wants a password",
            ),
            (
                r#"{"op":"wifi","ssid":"  ","pass":"secret"}"#,
                "wants a network",
            ),
        ] {
            let error = action_for(&request(line)).expect_err(line);
            assert!(
                error.contains(needle),
                "{line:?} gave {error:?}, wanted {needle:?}"
            );
        }
    }

    /// WebDAV is part of the protocol even when a particular firmware build
    /// leaves it out: the host can ask, and a board without the feature
    /// answers with its own refusal rather than the host hiding the command.
    #[test]
    fn the_webdav_operations_are_read_and_write_through_one_name() {
        for op in ["webdav", "webdav-off"] {
            let line = format!(r#"{{"op":"{op}"}}"#);
            let action = action_for(&request(&line)).expect(&line);
            assert!(matches!(action, Action::Requests(_)), "{line}");
        }
        assert!(OPERATIONS.contains(&"webdav"));
        assert!(OPERATIONS.contains(&"webdav-off"));
        assert!(operations_json().contains("\"webdav\""));
        assert!(operations_json().contains("\"webdav-off\""));

        match action_for(&request(r#"{"op":"webdav"}"#)) {
            Ok(Action::Requests(requests)) => {
                assert_eq!(requests.queries, vec![Query::Webdav]);
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"webdav","url":"http://h/d/"}"#)) {
            Ok(Action::Requests(requests)) => {
                assert_eq!(requests.webdav.as_deref(), Some("http://h/d/"));
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"webdav-off"}"#)) {
            Ok(Action::Requests(requests)) => assert!(requests.webdav_off),
            other => panic!("{other:?}"),
        }
    }

    /// The advertised name is read, set, and restored through one op, and the
    /// name is checked in the firmware's own units before anything is sent.
    #[test]
    fn the_ble_name_op_reads_sets_and_restores() {
        assert!(OPERATIONS.contains(&"ble-name"));
        assert!(operations_json().contains("\"ble-name\""));

        match action_for(&request(r#"{"op":"ble-name"}"#)) {
            Ok(Action::Requests(requests)) => {
                assert_eq!(requests.queries, vec![Query::BleName]);
                assert!(requests.ble_name.is_none());
                assert!(!requests.ble_name_default);
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"ble-name","name":"Bench Bee"}"#)) {
            Ok(Action::Requests(requests)) => {
                assert_eq!(requests.ble_name.as_deref(), Some("Bench Bee"));
                assert!(!requests.ble_name_default);
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"ble-name","name":"测试😀"}"#)) {
            Ok(Action::Requests(requests)) => {
                assert_eq!(requests.ble_name.as_deref(), Some("测试😀"));
            }
            other => panic!("{other:?}"),
        }
        match action_for(&request(r#"{"op":"ble-name","default":true}"#)) {
            Ok(Action::Requests(requests)) => {
                assert!(requests.ble_name_default);
                assert!(requests.ble_name.is_none());
            }
            other => panic!("{other:?}"),
        }
    }

    /// A request that wants both a name and the default is refused rather
    /// than ordered, and a name the firmware would refuse is refused here.
    #[test]
    fn the_ble_name_op_refuses_what_it_cannot_do() {
        for (line, needle) in [
            (
                r#"{"op":"ble-name","name":"Bee","default":true}"#,
                "not both",
            ),
            (r#"{"op":"ble-name","name":""}"#, "1-29"),
            (r#"{"op":"ble-name","name":""}"#, "1-29"),
            (r#"{"op":"ble-name","name":"😀😀😀😀😀😀😀😀"}"#, "1-29"),
            (r#"{"op":"ble-name","name":"one\ntwo"}"#, "control"),
            (r#"{"op":"ble-name","default":false}"#, "default"),
            (r#"{"op":"ble-name","default":"yes"}"#, "true or false"),
        ] {
            let error = action_for(&request(line)).expect_err(line);
            assert!(
                error.contains(needle),
                "{line:?} gave {error:?}, wanted {needle:?}"
            );
        }
    }

    #[test]
    fn invalid_webdav_session_urls_are_refused_before_dialling() {
        for line in [
            r#"{"op":"webdav","url":""}"#,
            r#"{"op":"webdav","url":" \t "}"#,
            r#"{"op":"webdav","url":"https://host/logs/"}"#,
        ] {
            assert!(action_for(&request(line)).is_err(), "{line}");
        }
    }

    /// A session promises what its link can actually serve. The management
    /// reads and writes are frames on the bridge's own characteristic, so a
    /// LAN or serial session that listed them would answer its caller's first
    /// request with "management is BLE-only" — a request spent on a promise
    /// this program could see was empty (issue 21).
    #[test]
    fn a_session_promises_only_what_its_link_can_serve() {
        assert_eq!(
            operations_for(Some(LinkKind::Ble)),
            OPERATIONS.to_vec(),
            "the management channel serves every operation there is"
        );

        for kind in [LinkKind::Lan, LinkKind::Stdio] {
            let ops = operations_for(Some(kind));
            for gone in [
                "info",
                "uart",
                "wifi",
                "webdav",
                "webdav-off",
                "wifi-off",
                "wifi-scan",
                "lan",
            ] {
                assert!(!ops.contains(&gone), "{kind:?} cannot serve {gone}");
            }
            for kept in ["exec", "loopback-test", "state", "quit"] {
                assert!(ops.contains(&kept), "{kind:?} still serves {kept}");
            }
        }

        // A session with nothing to dial can only ever answer these two.
        assert_eq!(operations_for(None), vec!["state", "quit"]);

        // While the build's own list — what `--capabilities` answers — is
        // untouched by any of it: it is a claim about the program, not about
        // one session's link.
        assert!(operations_json().contains("\"info\""));
    }

    /// The two operations that must answer without a link, and the rest.
    #[test]
    fn state_and_quit_do_not_wait_for_a_link() {
        assert!(!needs_link(&Action::State));
        assert!(!needs_link(&Action::Quit));
        assert!(needs_link(&Action::Requests(cli::Requests::default())));
        assert!(needs_link(&Action::Exec(Run {
            command: "true".to_string(),
            ending: Ending::RcMarker,
            timeout: Duration::from_secs(1),
            retry: 0,
        })));
    }

    /// Every operation the ready line promises is one the dispatcher knows,
    /// and the promise is spelled the way `--capabilities` says it is.
    #[test]
    fn the_ready_line_promises_only_operations_that_are_dispatched() {
        for op in OPERATIONS {
            let parsed = request(&format!("{{\"op\":\"{op}\"}}"));
            if let Err(why) = action_for(&parsed) {
                assert!(!why.contains("unknown op"), "{op} was refused: {why}");
            }
        }
        assert_eq!(
            operations_json(),
            "[\"info\",\"uart\",\"wifi\",\"wifi-off\",\"wifi-scan\",\"webdav\",\
             \"webdav-off\",\"ble-name\",\"lan\",\"exec\",\"loopback-test\",\"state\",\"quit\"]"
        );
    }
}
