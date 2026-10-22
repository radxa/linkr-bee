//! The headless half of `exec`: one command in, a definite ending out.
//!
//! `exec` is the part of this program an agent actually uses: send a shell
//! command to the target behind the bridge, wait until it *ends*, and hand back
//! the target's own exit status. Everything else the CLI does is answered by
//! the bridge; a command is answered by the machine on the far side of it, so
//! the ending has to be decided by a rule the caller can check rather than by
//! reading the output and hoping.
//!
//! Two endings exist, and the caller picks one:
//!
//! * the **rc marker** (the default): the command is wrapped so the target
//!   prints a per-attempt `LINKR_RC_<nonce>:<code>` when it finishes, turning
//!   "did it end, and how" into one machine-checkable line. A run without the marker
//!   never reports success — sending is not finishing.
//! * an **idle window** (`--idle`): the output has been quiet for that long.
//!   Weaker by construction — a command that is thinking looks like one that is
//!   done — and offered because a wrapper is not always wanted on the wire. It
//!   never reports success: `ok` is false, `verified` is false and the exit
//!   code is 1, because nothing read the command's status. The output is still
//!   reported; the status is the thing that is missing, and saying so is the
//!   only honest way to end a run that cannot say how it ended.
//!
//! What this module deliberately does not have: any notion of approval (that is
//! the caller's, and `--dry-run` is what it is given to approve with), any
//! retry nobody asked for, and any answer to a prompt. A prompt ends the run as
//! [`Outcome::NeedsInput`] and stays on the target's console for a person.

use std::time::{Duration, Instant};

use crate::app::App;
use crate::cli::{self, Format};

/// How long one command may run when the command line did not say.
///
/// Longer than a scan, and longer than the link's own patience: a command is
/// the target's own work, and the distance between `df -h` and an update on a
/// device this small is minutes. A caller that wants a shorter leash has
/// `--timeout`.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a retry's state read may take, at most: a probe that has to be
/// waited out is a probe that has already answered "no".
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

const MARKER_PREFIX: &str = "LINKR_RC_";

/// How much of the tail is kept. Long enough to hold a marker split across two
/// reads and the unfinished line a prompt waits on; short enough that a command
/// printing for an hour costs nothing to watch.
const TAIL: usize = 512;

/// How often the loop looks, in the same shape as the rest of the CLI half.
const POLL: Duration = Duration::from_millis(5);

/// How the caller asked the run to end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    /// The wrapped command prints its own exit status when it finishes.
    RcMarker,
    /// The command's output has been quiet for this long.
    Idle(Duration),
}

/// One command, and the terms it was asked on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    /// The command line, as the caller typed it.
    pub command: String,
    /// How the ending is decided.
    pub ending: Ending,
    /// The deadline for one attempt.
    pub timeout: Duration,
    /// How many times a timed-out command may be sent again. Each retry is
    /// preceded by a state read; zero means the timeout is a result, not a
    /// reason to repeat a command that may still be running.
    pub retry: u32,
}

impl Run {
    /// The bytes that go on the wire for this run: the wrapper, and Enter.
    pub fn wire(&self) -> Vec<u8> {
        wire(&self.command, self.ending)
    }

    /// The ending, as the events spell it.
    fn mode(&self) -> &'static str {
        match self.ending {
            Ending::RcMarker => "rc-marker",
            Ending::Idle(_) => "idle",
        }
    }
}

/// The exact bytes `command` becomes on the wire.
///
/// Run the quoted command in its own shell so trailing separators, comments
/// and `exit` cannot consume the status printer in the console's outer shell.
pub fn wire(command: &str, ending: Ending) -> Vec<u8> {
    wire_with_marker(command, ending, &completion_marker())
}

fn completion_marker() -> String {
    format!("{MARKER_PREFIX}{}", uuid::Uuid::new_v4().simple())
}

fn wire_with_marker(command: &str, ending: Ending, token: &str) -> Vec<u8> {
    match ending {
        Ending::RcMarker => {
            let quoted = command.replace('\'', "'\"'\"'");
            format!("sh -c '{quoted}'; printf '\\n%s:%s\\n' '{token}' \"$?\"\r").into_bytes()
        }
        Ending::Idle(_) => format!("{command}\r").into_bytes(),
    }
}

/// What ended a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The marker answered with the target's own exit status.
    Rc(i32),
    /// The output went quiet, and nothing better can be said: `--idle` asked
    /// for exactly this and nothing more.
    Idle,
    /// A prompt is waiting on the target's console. Only a person answers it,
    /// so the run stops here with the command still on the wire.
    NeedsInput(String),
    /// The deadline passed. The command may still be running, and no answer
    /// about it exists yet.
    Timeout,
    /// The link went away mid-run.
    Lost,
    /// Nothing was sent: there was no link, or the write was refused.
    Refused(String),
}

/// What one attempt saw.
struct Attempt {
    outcome: Outcome,
    elapsed: Duration,
    bytes: usize,
}

/// The stable failure code for an outcome, or `None` when the run finished.
///
/// Part of the JSON contract: a caller acts on a class of failure, and the
/// sentences are free to change.
pub fn code(outcome: &Outcome) -> Option<&'static str> {
    match outcome {
        Outcome::Rc(_) | Outcome::Idle => None,
        Outcome::NeedsInput(_) => Some("needs_input"),
        Outcome::Timeout => Some("timeout"),
        Outcome::Lost => Some("link_lost"),
        Outcome::Refused(_) => Some("not_connected"),
    }
}

/// The status this program answers with when the run itself could not happen:
/// nothing was put on the wire, or the link went away holding the answer. It is
/// not a target's status, so it is not confused with one — no process exits
/// 255 by accident here.
pub const LINK_FAILED: i32 = 255;

/// The process exit code for an outcome.
///
/// The table, written once so `main` and the tests cannot disagree: a marker's
/// status passes through when it is a status a process can really have (0–127,
/// where 126/127 keep the shell's own meanings); above that the shell is
/// spelling a signal, which is "executed, not as expected" — 1. A run that
/// needed a person, or ran out of clock, is the same 1. A run that could not be
/// sent, or whose link died holding the answer, is this program's own failure:
/// [`LINK_FAILED`].
///
/// Idle is 1 and not 0 for the reason the module opens with: a run that never
/// saw a status has not reported success, and a `&&` in a script must not read
/// one into it. The output is still there to be read; the *status* is what is
/// missing, and 1 is what says so.
pub fn exit_code(outcome: &Outcome) -> i32 {
    match outcome {
        Outcome::Rc(status) if (0..=127).contains(status) => *status,
        Outcome::Rc(_) => 1,
        Outcome::Idle => 1,
        Outcome::NeedsInput(_) | Outcome::Timeout => 1,
        Outcome::Lost | Outcome::Refused(_) => LINK_FAILED,
    }
}

/// Run one command, report it, and return the process exit code it earns.
///
/// The output is printed as it arrives — once, on stdout, in the format asked
/// for — and the command is sent again only when `retry` counted a retry and
/// the state was read again first.
pub fn run(app: &mut App, run: &Run, format: Format) -> i32 {
    let execution_id = uuid::Uuid::new_v4().to_string();
    let link = app.session.describe();
    // The clock the report's `elapsed_ms` reads: the whole run as the caller
    // waited for it, retries and the state reads between them included. An
    // attempt's own time is a different number, and it is reported per attempt
    // (see the retry events below) rather than as the run's.
    let started = Instant::now();
    if format == Format::Json {
        println!(
            "{}",
            cli::json_event(&[
                ("event", cli::Json::Text("start")),
                ("execution_id", cli::Json::Text(&execution_id)),
                ("link", cli::Json::Text(link)),
                ("mode", cli::Json::Text(run.mode())),
                ("cmd", cli::Json::Text(&run.command)),
            ])
        );
    }

    let mut sent: u32 = 0;
    let mut previous: Option<Duration> = None;
    let last = loop {
        if sent > 0 && format == Format::Json {
            let mut fields = vec![
                ("event", cli::Json::Text("retry")),
                ("execution_id", cli::Json::Text(&execution_id)),
                ("attempt", cli::Json::Number(i64::from(sent))),
            ];
            if let Some(spent) = previous {
                // What the attempt that timed out cost, which is the detail
                // the run's own total cannot give back.
                fields.push(("attempt_ms", cli::Json::Number(spent.as_millis() as i64)));
            }
            println!("{}", cli::json_event(&fields));
        }
        let last = attempt_once(app, run, format, false);
        // Only a timeout is worth another try, and only the caller's count
        // gets one: a command that may still be running must never be repeated
        // behind the caller's back.
        if !matches!(last.outcome, Outcome::Timeout) || sent >= run.retry {
            break last;
        }
        // Read before repeating. A retry on a link that has gone would send
        // the same command into nothing and report a second timeout for it.
        if !recheck(app, run) {
            break Attempt {
                outcome: Outcome::Lost,
                elapsed: last.elapsed,
                bytes: last.bytes,
            };
        }
        previous = Some(last.elapsed);
        sent += 1;
    };

    report(app, run, format, &execution_id, &last, started.elapsed());
    exit_code(&last.outcome)
}

/// Send the command once and wait for one of the endings to happen.
///
/// `quiet` is for the retry probe: its output belongs to the probe and not to
/// the run the caller is reading.
fn attempt_once(app: &mut App, run: &Run, format: Format, quiet: bool) -> Attempt {
    // The command's bytes are read here rather than painted into the pane, so
    // the app is told to hand them over — set here rather than by the caller,
    // because the mode is this function's own requirement.
    app.collect_output = true;
    // Anything already buffered belongs to whoever spoke before this run; it
    // must not be counted as this command's output.
    app.take_output();
    let token = completion_marker();
    let wire = wire_with_marker(&run.command, run.ending, &token);
    if !app.send_bytes(&wire) {
        return Attempt {
            outcome: Outcome::Refused(app.strings().not_connected.to_string()),
            elapsed: Duration::ZERO,
            bytes: 0,
        };
    }

    let started = Instant::now();
    let deadline = started + run.timeout;
    let mut seen: usize = 0;
    let mut quiet_since = started;
    let mut tail: Vec<u8> = Vec::new();
    let outcome = loop {
        app.pump();
        for chunk in app.take_output() {
            seen += chunk.len();
            tail.extend_from_slice(&chunk);
            if tail.len() > TAIL {
                tail.drain(..tail.len() - TAIL);
            }
            if !quiet {
                emit_output(format, started.elapsed().as_millis(), &chunk);
            }
            quiet_since = Instant::now();
        }
        // The answer wins over the hang-up: a link that died after the marker
        // arrived still brought the marker.
        if run.ending == Ending::RcMarker {
            if let Some(status) = marker(&tail, &token) {
                break Outcome::Rc(status);
            }
        }
        if let Some(prompt) = prompt_waiting(&tail) {
            break Outcome::NeedsInput(prompt);
        }
        if !app.session.is_live() {
            break Outcome::Lost;
        }
        if let Ending::Idle(window) = run.ending {
            if quiet_since.elapsed() >= window {
                break Outcome::Idle;
            }
        }
        if Instant::now() >= deadline {
            break Outcome::Timeout;
        }
        std::thread::sleep(POLL);
    };
    Attempt {
        outcome,
        elapsed: started.elapsed(),
        bytes: seen,
    }
}

/// Read the target's state before a retry, the way the reference client does:
/// a retry that does not know whether the link still answers is a second
/// guess, not a second attempt.
///
/// The probe is a command with nothing to do, sent the way the run sends its
/// own: what a retry has to know is whether the *target* still answers its
/// shell, and that is asked in the one language every link carries. The
/// management channel answers questions about the bridge instead — and does
/// not exist on every link at all. Any status counts as an answer; the point
/// is the reply, not its number.
fn recheck(app: &mut App, run: &Run) -> bool {
    let probe = Run {
        command: "true".to_string(),
        ending: Ending::RcMarker,
        timeout: run.timeout.min(PROBE_TIMEOUT),
        retry: 0,
    };
    matches!(
        attempt_once(app, &probe, Format::Text, true).outcome,
        Outcome::Rc(_)
    )
}

/// The exit status the target printed, when the marker has arrived.
///
/// Require this attempt's complete marker line. A partial status such as the
/// first `1` of `127`, an echoed command, or an earlier run is not completion.
fn marker(tail: &[u8], token: &str) -> Option<i32> {
    tail.split_inclusive(|byte| *byte == b'\n')
        .find_map(|line| {
            let line = line.strip_suffix(b"\n")?;
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            let digits = line.strip_prefix(token.as_bytes())?.strip_prefix(b":")?;
            if digits.is_empty() || digits.len() > 3 || !digits.iter().all(u8::is_ascii_digit) {
                return None;
            }
            std::str::from_utf8(digits)
                .ok()?
                .parse::<u8>()
                .ok()
                .map(i32::from)
        })
}

/// The prompt the target is waiting on, when the line it has not finished
/// looks like one.
///
/// Only the *unfinished* tail — the text after the last newline — is read,
/// because that is the shape every prompt has: a console waiting for an answer
/// has not printed a newline yet, and a line that ends in one is a line the
/// console is already done with. That is also what keeps a command *about*
/// prompts (`cat README`) from tripping this: those words sit in finished lines
/// and never at the cursor.
fn prompt_waiting(tail: &[u8]) -> Option<String> {
    // A carriage return is the same statement as a newline here: the console
    // has moved on, and what follows is a fresh line.
    let pending = tail
        .rsplit(|byte| *byte == b'\n' || *byte == b'\r')
        .next()
        .unwrap_or(tail);
    let text = String::from_utf8_lossy(pending);
    let lower = text.to_ascii_lowercase();
    // English and Chinese, because the console on the other end is not
    // necessarily in the CLI's language and the promise is about the prompt,
    // not about its alphabet: a `密码：` that is not recognised costs the
    // caller the whole timeout and an answer of "it timed out" instead of the
    // one thing the run actually knows — the console is waiting for a person.
    const PROMPTS: [&str; 17] = [
        "[sudo] password",
        "password:",
        "password for",
        "passphrase",
        "login:",
        "username:",
        "login incorrect",
        "(yes/no)",
        "(y/n)",
        "[y/n",
        "press any key",
        "press enter",
        "--more--",
        "密码",
        "口令",
        "登录",
        "确认",
    ];
    if !PROMPTS.iter().any(|pattern| lower.contains(pattern)) {
        return None;
    }
    let line = text.trim();
    if line.is_empty() {
        return Some("a prompt".to_string());
    }
    let mut short: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        short.push('…');
    }
    Some(short)
}

/// Print one chunk of the target's output, as the format asked.
fn emit_output(format: Format, at_ms: u128, chunk: &[u8]) {
    match format {
        Format::Text => cli::print_raw(chunk),
        Format::Json => println!(
            "{}",
            cli::json_event(&[
                ("event", cli::Json::Text("output")),
                ("t", cli::Json::Number(at_ms as i64)),
                ("data", cli::Json::Text(&cli::lossy(chunk))),
            ])
        ),
    }
}

/// Say how the run ended: a sentence a person reads, or the event a caller
/// consumes.
///
/// `elapsed` is the whole run's wall clock, not the last attempt's: a caller
/// budgeting for a retried command — the reason `--retry` exists — reads a
/// number that deliberately includes every attempt and every state read
/// between them, because that is the time the caller spent waiting.
fn report(
    app: &App,
    run: &Run,
    format: Format,
    execution_id: &str,
    last: &Attempt,
    elapsed: Duration,
) {
    let still_running = matches!(last.outcome, Outcome::Timeout | Outcome::NeedsInput(_));
    let seconds = elapsed.as_secs_f64();
    match format {
        Format::Text => {
            let line = match &last.outcome {
                Outcome::Rc(0) => format!("exec: ok (rc 0, {seconds:.2} s, {} bytes)", last.bytes),
                Outcome::Rc(status) => {
                    format!("exec: rc {status} ({seconds:.2} s, {} bytes)", last.bytes)
                }
                Outcome::Idle => format!(
                    "exec: the output went quiet, no exit status was read \
                     ({seconds:.2} s, {} bytes)",
                    last.bytes
                ),
                Outcome::NeedsInput(prompt) => format!("exec: needs input — {prompt}"),
                Outcome::Timeout => format!(
                    "exec: no ending within {} s; the command may still be running ({} bytes)",
                    run.timeout.as_secs_f64(),
                    last.bytes
                ),
                Outcome::Lost => format!(
                    "exec: the link went away mid-command ({} bytes)",
                    last.bytes
                ),
                Outcome::Refused(why) => format!("exec: {why}"),
            };
            println!("{line}");
        }
        Format::Json => {
            let mut fields = vec![("execution_id", cli::Json::Text(execution_id))];
            let message = message(&last.outcome);
            match &last.outcome {
                Outcome::Rc(status) => {
                    fields.push(("event", cli::Json::Text("result")));
                    fields.push(("ok", cli::Json::Bool(true)));
                    // The target's own status was read, which is the whole
                    // difference between this ending and an idle one.
                    fields.push(("verified", cli::Json::Bool(true)));
                    fields.push(("rc", cli::Json::Number(i64::from(*status))));
                    fields.push(("mode", cli::Json::Text("rc-marker")));
                }
                Outcome::Idle => {
                    fields.push(("event", cli::Json::Text("result")));
                    // `ok` is false because nothing was verified: the output
                    // going quiet is what `--idle` asked for, but no status
                    // came back, and a caller that branches on `ok` alone —
                    // or a shell reading the exit code — must not read a
                    // success into it. The mode and the null rc say the same
                    // thing in a shape a fuller report can use.
                    fields.push(("ok", cli::Json::Bool(false)));
                    fields.push(("verified", cli::Json::Bool(false)));
                    fields.push(("rc", cli::Json::Null));
                    fields.push(("mode", cli::Json::Text("idle")));
                }
                other => {
                    fields.push(("event", cli::Json::Text("error")));
                    fields.push(("code", cli::Json::Text(code(other).unwrap_or("unknown"))));
                    fields.push(("message", cli::Json::Text(&message)));
                    fields.push(("still_running", cli::Json::Bool(still_running)));
                }
            }
            fields.push(("elapsed_ms", cli::Json::Number(elapsed.as_millis() as i64)));
            fields.push(("bytes", cli::Json::Number(last.bytes as i64)));
            fields.push(("bytes_rx", cli::Json::Number(app.rx as i64)));
            fields.push(("bytes_tx", cli::Json::Number(app.tx as i64)));
            println!("{}", cli::json_event(&fields));
        }
    }
}

/// The sentence an outcome carries into the events.
fn message(outcome: &Outcome) -> String {
    match outcome {
        Outcome::Rc(status) => format!("the command finished with status {status}"),
        Outcome::Idle => "the output went quiet, so no exit status was read".to_string(),
        Outcome::NeedsInput(prompt) => format!("the target is waiting for input: {prompt}"),
        Outcome::Timeout => "the command did not end within the timeout".to_string(),
        Outcome::Lost => "the link went away mid-command".to_string(),
        Outcome::Refused(why) => why.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Dial;
    use std::time::Instant;

    /// An app on the loopback device, which is the target this module's
    /// endings were written against: it runs the wrapper for real, answers
    /// with the status the segment left, and has a `sudo` that waits.
    fn loopback_app() -> App {
        let mut app = App::default();
        app.dial(&Dial::Stdio("-".into()))
            .expect("the loopback opens");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !app.connected() && Instant::now() < deadline {
            app.pump();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(app.connected(), "the loopback did not come up");
        app
    }

    /// A run of `command` on the marker ending, with a deadline a test can
    /// afford.
    fn shell(command: &str) -> Run {
        Run {
            command: command.to_string(),
            ending: Ending::RcMarker,
            timeout: Duration::from_secs(2),
            retry: 0,
        }
    }

    #[test]
    fn the_wrapper_is_one_line_and_ends_with_enter() {
        assert_eq!(
            wire_with_marker("df -h", Ending::RcMarker, "LINKR_RC_test"),
            b"sh -c 'df -h'; printf '\\n%s:%s\\n' 'LINKR_RC_test' \"$?\"\r"
        );
        assert_eq!(
            wire("df -h", Ending::Idle(Duration::from_millis(400))),
            b"df -h\r"
        );
    }

    #[test]
    fn the_marker_must_be_a_status_the_shell_could_have_said() {
        const TOKEN: &str = "LINKR_RC_this_attempt";
        assert_eq!(
            marker(b"ok\r\nLINKR_RC_this_attempt:0\r\nlinkr@bee:~$ ", TOKEN),
            Some(0)
        );
        assert_eq!(marker(b"LINKR_RC_this_attempt:127\n", TOKEN), Some(127));
        for text in [
            "LINKR_RC:0\n",
            "LINKR_RC_other_attempt:0\n",
            "prefix LINKR_RC_this_attempt:0\n",
            "LINKR_RC_this_attempt:1",
            "LINKR_RC_this_attempt:127",
            "LINKR_RC_this_attempt:256\n",
            "LINKR_RC_this_attempt:0junk\n",
            "LINKR_RC_this_attempt:0\r",
        ] {
            assert_eq!(marker(text.as_bytes(), TOKEN), None, "{text:?}");
        }
        let echo = wire_with_marker("printf 'LINKR_RC:0\\n'; false", Ending::RcMarker, TOKEN);
        assert_eq!(marker(&echo, TOKEN), None);
    }

    #[test]
    fn every_attempt_has_a_different_completion_marker() {
        assert_ne!(
            wire("true", Ending::RcMarker),
            wire("true", Ending::RcMarker)
        );
    }

    #[test]
    fn split_marker_status_waits_for_its_line_ending() {
        let line = b"\r\nLINKR_RC_fragmented:127\r\n";
        for end in 0..line.len() {
            assert_eq!(
                marker(&line[..end], "LINKR_RC_fragmented"),
                None,
                "prefix length {end}"
            );
        }
        assert_eq!(marker(line, "LINKR_RC_fragmented"), Some(127));
    }

    #[test]
    fn the_exit_table_is_the_one_a_script_can_count_on() {
        assert_eq!(exit_code(&Outcome::Rc(0)), 0);
        assert_eq!(exit_code(&Outcome::Rc(127)), 127);
        assert_eq!(exit_code(&Outcome::Rc(128)), 1, "a signal is not a status");
        // Idle is not a status either: the run ended because the output went
        // quiet, and 0 would let a script's `&&` read a success nothing
        // verified.
        assert_eq!(exit_code(&Outcome::Idle), 1);
        assert_eq!(exit_code(&Outcome::NeedsInput("x".into())), 1);
        assert_eq!(exit_code(&Outcome::Timeout), 1);
        assert_eq!(exit_code(&Outcome::Lost), 255);
        assert_eq!(exit_code(&Outcome::Refused("x".into())), 255);
    }

    #[test]
    fn a_prompt_is_only_read_from_the_line_the_console_has_not_finished() {
        assert_eq!(
            prompt_waiting(b"[sudo] password for root: ").as_deref(),
            Some("[sudo] password for root:")
        );
        // A line that ends in a newline is a line the console is done with:
        // a command whose output mentions `(yes/no)` is not a command that is
        // waiting for an answer.
        assert_eq!(prompt_waiting(b"the file says (yes/no)\r\n"), None);
        assert_eq!(prompt_waiting(b"Linux bee 6.6.0\r\n"), None);
        // And a prompt is a prompt in the console's own language: the board on
        // the bench prints `密码：`, and a run that does not recognise it waits
        // out its whole timeout to say "it timed out" — which is the one thing
        // the console was not doing.
        assert_eq!(
            prompt_waiting("密码： ".as_bytes()).as_deref(),
            Some("密码：")
        );
        assert_eq!(
            prompt_waiting("登录: ".as_bytes()).as_deref(),
            Some("登录:")
        );
        assert_eq!(
            prompt_waiting("确认？(y/n) ".as_bytes()).as_deref(),
            Some("确认？(y/n)")
        );
        assert_eq!(prompt_waiting("密码错误\r\n".as_bytes()), None);
    }

    #[test]
    fn a_command_reports_the_status_the_shell_gave_it() {
        let mut app = loopback_app();
        let attempt = attempt_once(&mut app, &shell("uname -a"), Format::Text, false);
        assert_eq!(attempt.outcome, Outcome::Rc(0));
        assert!(attempt.bytes > 0, "the command said something");

        let mut app = loopback_app();
        let attempt = attempt_once(&mut app, &shell("nosuch"), Format::Text, false);
        assert_eq!(
            attempt.outcome,
            Outcome::Rc(127),
            "the shell's own answer for a command it cannot find"
        );
    }

    #[test]
    fn a_command_that_never_ends_times_out_and_is_not_resent() {
        let mut app = loopback_app();
        let run = Run {
            timeout: Duration::from_millis(150),
            ..shell("sleep 30")
        };
        let attempt = attempt_once(&mut app, &run, Format::Text, false);
        assert_eq!(attempt.outcome, Outcome::Timeout);
        assert_eq!(exit_code(&attempt.outcome), 1);
    }

    #[test]
    fn a_prompt_stops_the_run_without_answering_it() {
        let mut app = loopback_app();
        // The deadline is not what this test is about: a machine under load can
        // take longer than the two seconds the other runs are priced at, and a
        // starved prompt arriving late must not read as a console that never
        // asked. What is being tested is the shape of the ending.
        let run = Run {
            timeout: Duration::from_secs(10),
            ..shell("sudo reboot")
        };
        let attempt = attempt_once(&mut app, &run, Format::Text, false);
        match attempt.outcome {
            Outcome::NeedsInput(prompt) => {
                assert!(
                    prompt.contains("password"),
                    "the prompt is named for the caller: {prompt}"
                );
            }
            other => panic!("expected a prompt, got {other:?}"),
        }
    }

    #[test]
    fn quiet_output_ends_an_idle_run_without_a_status() {
        let mut app = loopback_app();
        let run = Run {
            ending: Ending::Idle(Duration::from_millis(80)),
            ..shell("uname -a")
        };
        let attempt = attempt_once(&mut app, &run, Format::Text, false);
        assert_eq!(attempt.outcome, Outcome::Idle);
        // Not 0: the output went quiet, which is what `--idle` asked for, but
        // no status was read — and a script's `&&` must not read one into it.
        assert_eq!(exit_code(&attempt.outcome), 1);
    }

    #[test]
    fn idle_mode_never_reads_a_printed_status_marker() {
        let mut app = loopback_app();
        let run = Run {
            ending: Ending::Idle(Duration::from_millis(80)),
            ..shell("printf 'LINKR_RC:0\\n'")
        };
        assert_eq!(
            attempt_once(&mut app, &run, Format::Text, false).outcome,
            Outcome::Idle
        );
    }

    #[test]
    fn a_run_with_no_link_sends_nothing_and_says_so() {
        let mut app = App::default();
        let attempt = attempt_once(&mut app, &shell("uname -a"), Format::Text, false);
        let why = match &attempt.outcome {
            Outcome::Refused(why) => why.clone(),
            other => panic!("expected a refusal, got {other:?}"),
        };
        assert!(!why.is_empty());
        assert_eq!(
            exit_code(&attempt.outcome),
            255,
            "nothing was sent, so nothing about the command is known"
        );
    }
}
