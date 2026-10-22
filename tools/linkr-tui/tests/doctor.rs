//! The checkup and the send-only mode, end to end on the offline loopback.
//!
//! `--doctor` is the one report about the bridge's *state* rather than about a
//! request, so its shape is the contract: one event carrying every check, each
//! check carrying one of the four words, and an exit code that means "nothing
//! contradicted this run" rather than "every question was answered" — a link
//! with no management channel cannot answer two of them, and that is by
//! design, not a failure.
#![cfg(feature = "cli")]

use std::io::Write;
use std::process::{Command, Output, Stdio};

fn bee(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bee"))
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("the binary runs")
}

/// One run with something on standard input, for `--send`.
fn linkr_fed(args: &[&str], input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bee"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary runs");
    child
        .stdin
        .take()
        .expect("standard input is piped")
        .write_all(input.as_bytes())
        .expect("standard input accepts the bytes");
    child.wait_with_output().expect("the run finishes")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Every check runs and is named, the loopback is proven, and the two
/// questions a stdio link cannot carry are reported as unanswered rather than
/// as failures. The exit code is 0: nothing contradicted the run.
#[test]
fn the_checkup_reports_every_check_it_ran() {
    let output = bee(&["--bridge", "-", "doctor", "--json", "--quiet"]);
    assert_eq!(output.status.code(), Some(0), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("\"what\":\"doctor\""), "{out}");
    assert!(out.contains("\"verdict\":\"indeterminate\""), "{out}");
    assert!(out.contains("\"ok\":true"), "{out}");
    assert!(out.contains("\"mismatch\":0"), "{out}");
    for name in ["link", "bridge", "uart", "loopback", "target"] {
        assert!(
            out.contains(&format!("\"name\":\"{name}\"")),
            "the {name} check is missing: {out}"
        );
    }
    // The loopback is the one proof that does not need the bridge to describe
    // itself, and the probe is a real command on the target.
    assert!(out.contains("\"state\":\"match\""), "{out}");
    assert!(out.contains("\"state\":\"indeterminate\""), "{out}");
}

/// The text form says the same thing in words a person reads, including the
/// tally, so a report pasted into an issue says how much was proven.
#[test]
fn the_checkup_reads_as_a_report() {
    let output = bee(&["--bridge", "-", "doctor", "--quiet"]);
    assert_eq!(output.status.code(), Some(0), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    for name in ["link", "bridge", "uart", "loopback", "target"] {
        assert!(out.contains(name), "the {name} check is missing: {out}");
    }
    assert!(out.contains("doctor: indeterminate"), "{out}");
    assert!(out.contains("contradicted"), "{out}");
}

/// `--send` forwards what is on standard input and says how much went out. The
/// loopback echoes it back, which is the "receive" half a person watches.
#[test]
fn a_send_forwards_every_line_and_reports_the_bytes() {
    let output = linkr_fed(
        &["--bridge", "-", "send", "--line", "--json", "--quiet"],
        "echo hi\n",
    );
    assert_eq!(output.status.code(), Some(0), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("\"what\":\"send\""), "{out}");
    assert!(out.contains("\"ok\":true"), "{out}");
    assert!(out.contains("bytes sent"), "{out}");
    assert!(out.contains("hi"), "the target's answer is missing: {out}");
}

/// A `--send` that sent nothing is a failure and not a quiet success, for the
/// same reason an empty `--exec` is: a run that did nothing must not report
/// that it worked.
#[test]
fn a_send_of_nothing_is_refused() {
    let output = bee(&["--bridge", "-", "send", "--line", "--json", "--quiet"]);
    assert_eq!(output.status.code(), Some(1), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("\"ok\":false"), "{out}");
    assert!(out.contains("empty"), "{out}");
}

/// The subcommand form reaches the same run as the flag it stands for: same
/// exit code, same event, same result. The two writings are one command line,
/// and this is the test that says so from outside the process.
#[test]
fn a_subcommand_reaches_the_same_run_as_its_flag() {
    for (by_word, by_flag, want) in [
        (
            &["--bridge", "-", "loopback", "AB", "--json", "--quiet"][..],
            &[
                "--bridge",
                "-",
                "--loopback-test",
                "AB",
                "--json",
                "--quiet",
            ][..],
            "\"what\":\"loopback\"",
        ),
        (
            // The spec's own writing: the flags first, then `--`, then the
            // command — everything after the `--` is the command, flags and
            // all, which is exactly what the `--` is for.
            &[
                "--bridge", "-", "exec", "--json", "--quiet", "--", "echo", "hi",
            ],
            &["--bridge", "-", "--exec", "echo hi", "--json", "--quiet"],
            "\"rc\":0",
        ),
    ] {
        let word = bee(by_word);
        let flag = bee(by_flag);
        assert_eq!(
            word.status.code(),
            flag.status.code(),
            "{by_word:?} vs {by_flag:?}\nstderr: {}",
            stderr(&word)
        );
        assert_eq!(word.status.code(), Some(0), "stderr: {}", stderr(&word));
        assert!(
            stdout(&word).contains(want),
            "{by_word:?}: {}",
            stdout(&word)
        );
        assert!(
            stdout(&flag).contains(want),
            "{by_flag:?}: {}",
            stdout(&flag)
        );
    }
}
