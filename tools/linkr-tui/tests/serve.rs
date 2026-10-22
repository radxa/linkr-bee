//! The resident session, end to end.
//!
//! A real process is started with `--serve` and fed requests on its standard
//! input. The point of the mode is that one link answers many requests — a
//! radio dial is the expensive part, and a caller working through a problem
//! should pay for it once — so the test asks several things in a row and
//! checks that the link is still up for the last of them, that each answer is
//! wrapped in the frame carrying the request's own id and the exit code its
//! one-shot equivalent would have had, and that a request the session cannot
//! serve leaves the session running.
#![cfg(feature = "cli")]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

/// How long any one line may take. Generous — a dial on a busy radio is
/// seconds — because a test that gets it wrong should fail an assertion, not
/// hang the suite.
const PATIENCE: Duration = Duration::from_secs(20);

/// One run of the binary, for the refusals that exit before a session opens.
fn bee(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_bee"))
        .args(args)
        .output()
        .expect("the binary runs")
}

/// A session under test, with its output read on a thread of its own.
struct Session {
    child: Child,
    input: ChildStdin,
    lines: Receiver<String>,
}

impl Session {
    fn start() -> Session {
        Session::start_with(&["--bridge", "-"])
    }

    /// A session dialling whatever the arguments say. Everything else — the
    /// pipes, the reader thread, the patience — is the same session.
    fn start_with(dial: &[&str]) -> Session {
        let mut child = Command::new(env!("CARGO_BIN_EXE_bee"))
            .args(dial)
            .args(["--serve"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Nothing here writes enough to a pipe to block on it, and a
            // session that dies with a filled stderr would hide the reason
            // behind a deadlock.
            .stderr(Stdio::null())
            .spawn()
            .expect("the binary starts");
        let input = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Session {
            child,
            input,
            lines,
        }
    }

    fn send(&mut self, request: &str) {
        writeln!(self.input, "{request}").expect("the request is written");
        self.input.flush().expect("the request is sent");
    }

    fn next(&self) -> String {
        self.lines
            .recv_timeout(PATIENCE)
            .expect("the session answers")
    }

    /// Read until a line contains `needle`, and return it.
    fn until(&self, needle: &str) -> String {
        loop {
            let line = self.next();
            if line.contains(needle) {
                return line;
            }
        }
    }

    /// Close the input — the signal a session hangs up on — and wait for the
    /// process, returning its exit code.
    fn finish(mut self) -> i32 {
        drop(self.input);
        self.child
            .wait()
            .expect("the session exits")
            .code()
            .expect("the session exits with a code")
    }
}

/// The whole number written for `key` in one event line — the shape is this
/// module's, and the contract is the key.
fn number(line: &str, key: &str) -> u64 {
    let at = line
        .find(&format!("\"{key}\":"))
        .unwrap_or_else(|| panic!("no {key} in {line}"));
    let rest = &line[at + key.len() + 3..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits
        .parse()
        .unwrap_or_else(|_| panic!("{key} is not a number in {line}"))
}

#[test]
fn a_session_answers_many_requests_on_one_link() {
    let mut session = Session::start();
    let ready = session.until("\"event\":\"ready\"");
    assert!(ready.contains("\"program\":\"bee\""), "{ready}");
    assert!(ready.contains("\"ops\":["), "{ready}");
    assert!(ready.contains("\"exec\""), "{ready}");

    // Before anything needs the board there is no link: dialling lazily is
    // what lets a session start before the board is powered.
    session.send(r#"{"id":1,"op":"state"}"#);
    let begin = session.until("\"event\":\"begin\"");
    assert!(
        begin.contains("\"id\":1") && begin.contains("\"op\":\"state\""),
        "{begin}"
    );
    let state = session.until("\"what\":\"state\"");
    assert!(state.contains("\"live\":false"), "{state}");
    assert!(
        session.until("\"event\":\"end\"").contains("\"code\":0"),
        "the state request ends clean"
    );

    // A command dials the link and runs on it.
    session.send(r#"{"id":2,"op":"exec","cmd":"uname -a"}"#);
    assert!(session.until("\"op\":\"exec\"").contains("\"id\":2"));
    let result = session.until("\"event\":\"result\"");
    assert!(
        result.contains("\"ok\":true") && result.contains("\"rc\":0"),
        "{result}"
    );
    assert!(session.until("\"event\":\"end\"").contains("\"code\":0"));

    // The link is still up for the request after it — the whole point of the
    // mode.
    session.send(r#"{"id":3,"op":"state"}"#);
    let state = session.until("\"what\":\"state\"");
    assert!(
        state.contains("\"live\":true") && state.contains("\"connected\":true"),
        "{state}"
    );
    // And its counters are the link's, counted off the bytes that just moved.
    // This is the assertion that catches a report reading the terminal's frame
    // copy of the counters: a session has no frame, and would answer zero.
    assert!(
        number(&state, "rx") > 0,
        "the reply came over the link: {state}"
    );
    assert!(number(&state, "tx") > 0, "the command went out: {state}");
    session.until("\"event\":\"end\"");

    // The status a one-shot `--exec` would have exited with arrives as the
    // frame's code, per request.
    session.send(r#"{"id":4,"op":"exec","cmd":"exit 42"}"#);
    session.until("\"op\":\"exec\"");
    let end = session.until("\"event\":\"end\"");
    assert!(end.contains("\"code\":42"), "{end}");

    // A line that is not a request is named and the session goes on.
    session.send("{not a request}");
    let error = session.until("\"event\":\"error\"");
    assert!(error.contains("\"code\":\"bad_request\""), "{error}");

    // As is an operation this build does not answer, framed like any other
    // request so a caller waiting on its id is not left waiting.
    session.send(r#"{"id":5,"op":"telnet"}"#);
    let error = session.until("\"event\":\"error\"");
    assert!(
        error.contains("\"id\":5") && error.contains("\"bad_request\""),
        "{error}"
    );
    assert!(session.until("\"event\":\"end\"").contains("\"code\":2"));

    // A field the operation does not have is named and refused, rather than
    // silently dropped and left to a default the caller never asked for.
    session.send(r#"{"id":6,"op":"exec","cmd":"uname -a","timeout":2}"#);
    let error = session.until("\"event\":\"error\"");
    assert!(
        error.contains("\"id\":6")
            && error.contains("unknown field \\\"timeout\\\"")
            && error.contains("timeout_ms"),
        "{error}"
    );
    assert!(session.until("\"event\":\"end\"").contains("\"code\":2"));

    session.send(r#"{"id":7,"op":"quit"}"#);
    let end = session.until("\"event\":\"end\"");
    assert!(end.contains("\"code\":0"), "{end}");
    assert_eq!(session.finish(), 0);
}

/// The ready line is a promise about the link in hand. A session on a LAN
/// socket has no management channel to answer `info` on, and listing it would
/// spend the caller's first request on an answer this program could have
/// given before the request was sent (issue 21). Nothing is dialled until a
/// request needs the link, so the ready line is read here without touching a
/// network — the host is a documentation address on purpose.
#[test]
fn a_session_offers_only_the_operations_its_link_can_serve() {
    let lan = Session::start_with(&["--lan-host", "192.0.2.9"]);
    let ready = lan.until("\"event\":\"ready\"");
    for gone in ["\"info\"", "\"uart\"", "\"wifi\"", "\"lan\""] {
        assert!(
            !ready.contains(gone),
            "a LAN session cannot answer {gone}: {ready}"
        );
    }
    for kept in ["\"exec\"", "\"loopback-test\"", "\"state\"", "\"quit\""] {
        assert!(
            ready.contains(kept),
            "a LAN session still serves {kept}: {ready}"
        );
    }

    // A board named but never dialled: the management channel is what a BLE
    // session is for, so its list is the whole build.
    let ble = Session::start_with(&["--ble-name", "Linkr BLE UART-1"]);
    let ready = ble.until("\"event\":\"ready\"");
    for op in ["\"info\"", "\"uart\"", "\"wifi\"", "\"lan\""] {
        assert!(ready.contains(op), "a BLE session answers {op}: {ready}");
    }

    // Neither session ever dialled; end of input closes both.
    assert_eq!(ble.finish(), 0);
    assert_eq!(lan.finish(), 0);
}

/// End of input is the session's hang-up: the caller closed the pipe because
/// it is done, and the process leaves with the code that says so.
#[test]
fn end_of_input_ends_the_session_cleanly() {
    let mut session = Session::start();
    session.until("\"event\":\"ready\"");
    session.send(r#"{"id":1,"op":"state"}"#);
    session.until("\"event\":\"end\"");
    assert_eq!(session.finish(), 0);
}

/// A session is a mode, and the flags that would be answered once and exit are
/// named as the contradiction they are: a caller passing `--scan` with
/// `--serve` wants two things, and neither silently winning is what this
/// checks. A session with no link named cannot serve anything that needs one
/// and says so rather than starting an empty one.
#[test]
fn a_session_that_names_something_else_to_do_is_a_usage_error() {
    for argv in [
        vec!["--bridge", "-", "--serve", "--scan"],
        vec!["--bridge", "-", "--serve", "--exec", "true"],
        vec!["--bridge", "-", "--serve", "--query-info"],
        vec!["--bridge", "-", "--serve", "--print-frame", "80x24"],
        vec!["--bridge", "-", "--serve", "--cli-then-tui"],
        vec!["--bridge", "-", "--serve", "--capabilities"],
        vec!["--serve"],
    ] {
        let output = bee(&argv);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{argv:?} was not refused: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let reported = String::from_utf8_lossy(&output.stderr);
        assert!(
            reported.starts_with("error:"),
            "{argv:?} was refused without saying why: {reported}"
        );
    }
}
