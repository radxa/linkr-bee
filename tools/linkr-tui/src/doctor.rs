//! The checkup: what one run can prove about the bridge in front of it.
//!
//! `--doctor` asks the questions a first session asks — is there a link, does
//! the bridge describe itself, does its UART carry bytes, does the target
//! answer — and gives each answer a word, rather than leaving the reader to
//! compare four replies in their head. The words are the four a check can end
//! in:
//!
//! - `match`: an expectation was compared with an observation and they agreed;
//! - `mismatch`: they disagreed — the run is not what it claims to be;
//! - `observed`: a fact was read with nothing to compare it against, which is
//!   evidence and not a verdict;
//! - `indeterminate`: the question could not be answered at all (this link has
//!   no management channel, the probe never finished), which is neither a
//!   contradiction nor a pass.
//!
//! The exit code says only whether anything *contradicted* the run: 0 for no
//! mismatch, 1 for one. `indeterminate` is deliberately not a failure — a LAN
//! or stdio link has no management channel by design, and a checkup that called
//! that a failure would fail every time it does not apply.
//!
//! Nothing here is a second implementation of a command: `--doctor` waits
//! through [`crate::cli::ask_and_wait`] and [`crate::cli::loopback_round_trip`],
//! and the target probe *is* `--exec` — the same wrapper, the same ending rule,
//! the same events. The checkup adds the comparison and the words for it.

use std::time::Duration;

use crate::app::App;
use crate::cli::{self, Format, Json};
use crate::device::Query;
use crate::exec::cli::{Ending, Run};

/// The payload the UART round trip sends.
///
/// Short and unmistakable, and it ends the line: a payload that stops mid-line
/// leaves the next thing sent — the shell probe, and then whatever the *user*
/// types — joined to it, so the checkup would corrupt the very console it came
/// to report on. With the ending, a console that has nothing joined to its
/// transmitter reads the payload as one command line and carries on.
const LOOPBACK_PAYLOAD: &[u8] = b"LINKR-DOC\r";

/// How long the round trip waits for its own bytes back. Short on purpose —
/// this is a checkup, and a bridge with a *target* attached rather than a
/// joined UART is the ordinary case, not a reason to hold the run.
const LOOPBACK_WINDOW: Duration = Duration::from_secs(2);

/// The command sent to the target's shell. A builtin of every shell there is,
/// printing something the status marker can follow, and meaning nothing else.
const PROBE: &str = "echo LINKR-DOC";

/// How long the probe may take. Shorter than an ordinary `--exec`, because a
/// checkup that waits the full default for a console that is not answering has
/// spent the caller's minute to say one word.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// What one check found.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Match,
    Mismatch,
    Observed,
    Indeterminate,
}

impl State {
    /// The word the report uses.
    pub fn word(self) -> &'static str {
        match self {
            State::Match => "match",
            State::Mismatch => "mismatch",
            State::Observed => "observed",
            State::Indeterminate => "indeterminate",
        }
    }

    /// How a state weighs in the verdict: a contradiction outranks a question
    /// that could not be answered, which outranks an agreement, which outranks
    /// a fact with nothing to compare it against.
    fn rank(self) -> u8 {
        match self {
            State::Mismatch => 3,
            State::Indeterminate => 2,
            State::Match => 1,
            State::Observed => 0,
        }
    }
}

/// One line of the report.
struct Check {
    name: &'static str,
    state: State,
    detail: String,
}

impl Check {
    /// A check that ends in `state`, with its detail on one line: a report is
    /// read line by line, and a detail that wraps is a report with a hole in it.
    fn new(name: &'static str, state: State, detail: impl Into<String>) -> Check {
        Check {
            name,
            state,
            detail: one_line(&detail.into()),
        }
    }
}

/// Run the checkup, print it, and answer with the exit code.
///
/// `expect_baud` is the UART speed the caller asked for, if they asked for one
/// (`--uart 115200,… --doctor`): the read-back is then compared with it instead
/// of merely being reported. Nothing else is expected of the bridge, because
/// nothing else was told to it.
pub fn run(app: &mut App, format: Format, expect_baud: Option<u32>) -> i32 {
    // The device's greeting before the first check: the round trip discards
    // whatever is in flight, and a banner that appeared in every other run
    // should not go missing just because a checkup is looking.
    app.collect_output = true;
    cli::flush_output(app, format);
    let mut checks = vec![link_check(app)];
    checks.push(bridge_check(app, format));
    checks.push(uart_check(app, format, expect_baud));
    checks.push(loopback_check(app));
    checks.push(probe_check(app, format));

    let verdict = checks
        .iter()
        .map(|check| check.state)
        .max_by_key(|state| state.rank())
        .unwrap_or(State::Observed);
    let count = |state: State| checks.iter().filter(|c| c.state == state).count();
    let contradicted = count(State::Mismatch) > 0;

    match format {
        Format::Text => {
            let width = checks
                .iter()
                .map(|check| check.name.len())
                .max()
                .unwrap_or(0);
            for check in &checks {
                println!(
                    "{:<width$}  {:<14} {}",
                    check.name,
                    check.state.word(),
                    check.detail
                );
            }
            println!(
                "doctor: {} — {} matched, {} observed, {} contradicted, \
                 {} could not be established",
                verdict.word(),
                count(State::Match),
                count(State::Observed),
                count(State::Mismatch),
                count(State::Indeterminate),
            );
        }
        Format::Json => {
            let checks_json = format!(
                "[{}]",
                checks
                    .iter()
                    .map(|check| {
                        format!(
                            "{{\"name\":{},\"state\":{},\"detail\":{}}}",
                            cli::json_string(check.name),
                            cli::json_string(check.state.word()),
                            cli::json_string(&check.detail)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            );
            println!(
                "{}",
                cli::json_event(&[
                    ("event", Json::Text("result")),
                    ("what", Json::Text("doctor")),
                    ("ok", Json::Bool(!contradicted)),
                    ("verdict", Json::Text(verdict.word())),
                    ("match", Json::Number(count(State::Match) as i64)),
                    ("observed", Json::Number(count(State::Observed) as i64)),
                    ("mismatch", Json::Number(count(State::Mismatch) as i64)),
                    (
                        "indeterminate",
                        Json::Number(count(State::Indeterminate) as i64)
                    ),
                    ("checks", Json::Raw(&checks_json)),
                ])
            );
        }
    }
    if contradicted {
        1
    } else {
        0
    }
}

/// The link the dial opened: the first thing a checkup can be wrong about, and
/// the only check that needs no answer from anyone.
fn link_check(app: &App) -> Check {
    if app.session.is_live() && app.connected() {
        Check::new(
            "link",
            State::Match,
            format!(
                "the dial was made and the session is up ({})",
                app.session.describe()
            ),
        )
    } else {
        Check::new(
            "link",
            State::Mismatch,
            format!(
                "the dial opened {} but the session is not up",
                app.session.describe()
            ),
        )
    }
}

/// The bridge describing itself — `@i?`. The check is that an answer came and
/// that it is the bridge's kind of answer: `@info`, its own tag. A bridge that
/// answers something else to its own diagnostics question is a contradiction,
/// and one that cannot be asked (no management channel on this link) is not.
fn bridge_check(app: &mut App, format: Format) -> Check {
    match cli::ask_and_wait(app, Query::Diagnostics, format) {
        Ok(reply) if reply.contains("@info") => Check::new("bridge", State::Match, reply),
        Ok(reply) => Check::new(
            "bridge",
            State::Mismatch,
            format!("the answer is not the bridge's own: {reply}"),
        ),
        Err(why) => Check::new("bridge", State::Indeterminate, why),
    }
}

/// The UART settings the bridge reports — `@u?`. With a speed asked for on the
/// command line the report is compared with it (that read-back is the promise
/// `--uart` makes); without one it is a fact and nothing more.
fn uart_check(app: &mut App, format: Format, expect_baud: Option<u32>) -> Check {
    match cli::ask_and_wait(app, Query::Uart, format) {
        Ok(reply) => {
            let reported = reply
                .trim()
                .strip_prefix("uart=")
                .and_then(|baud| baud.trim().parse::<u32>().ok());
            match (reported, expect_baud) {
                (Some(reported), Some(expect)) if reported != expect => Check::new(
                    "uart",
                    State::Mismatch,
                    format!("the bridge reports {reported} baud after being set to {expect}"),
                ),
                (Some(_), Some(_)) => Check::new("uart", State::Match, reply),
                _ => Check::new("uart", State::Observed, reply),
            }
        }
        Err(why) => Check::new("uart", State::Indeterminate, why),
    }
}

/// The UART round trip: the payload out, the same bytes back.
///
/// An echo is a proof, so it is a `match`. Silence is *not* a contradiction:
/// a bridge with a target attached has nothing joined to its transmitter, and
/// bytes that reach a console do not come back — that is the ordinary bench,
/// and calling it a failure would fail every bench. A link that went away
/// during the test is the one failure this check can have, and it is a real
/// one: the loopback goes through the same link as everything else.
fn loopback_check(app: &mut App) -> Check {
    match cli::loopback_round_trip(app, LOOPBACK_PAYLOAD, LOOPBACK_WINDOW) {
        Ok(heard) => Check::new("loopback", State::Match, format!("echoed {heard}")),
        Err(why) if why == app.strings().not_connected => {
            Check::new("loopback", State::Mismatch, why)
        }
        Err(why) => Check::new("loopback", State::Indeterminate, why),
    }
}

/// The target's own shell — the thing all of this exists to reach.
///
/// The probe *is* an `--exec` run: the same wrapper, the same ending rule, the
/// same events, printed as they happen. What the checkup adds is the reading of
/// the status: the target's answer proves the shell is there, a status that is
/// not zero says something else is on that UART, and a run that did not finish
/// — a console waiting for a password, most often — proves nothing either way.
fn probe_check(app: &mut App, format: Format) -> Check {
    let probe = Run {
        command: PROBE.to_string(),
        ending: Ending::RcMarker,
        timeout: PROBE_TIMEOUT,
        retry: 0,
    };
    match crate::exec::cli::run(app, &probe, format) {
        0 => Check::new(
            "target",
            State::Match,
            "the shell answered, and the probe's own status is 0",
        ),
        1 => Check::new(
            "target",
            State::Indeterminate,
            "the probe did not report a status a live shell would have — the \
             console is waiting for input, the run timed out, or the probe was \
             killed by a signal; the event above says which",
        ),
        // The exec module's own failure: nothing went out, or the link went
        // away holding the answer. That contradicts the link check, which
        // called this session up a moment ago — the console never spoke, so
        // blaming it for a status would be a lie in the other direction.
        crate::exec::cli::LINK_FAILED => Check::new(
            "target",
            State::Mismatch,
            "the probe could not be sent, or the link went away while it was out",
        ),
        other => Check::new(
            "target",
            State::Mismatch,
            format!(
                "the console answered status {other} to a shell builtin — \
                 something that is not a shell is on that UART"
            ),
        ),
    }
}

/// One line, for a detail that has to stay on one: the report is read line by
/// line, and an answer with newlines in it would break the shape it is read in.
fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for ch in text.chars() {
        if ch == '\n' || ch == '\r' || ch == '\t' {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(ch);
    }
    out
}
