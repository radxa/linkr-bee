//! The exec contract, locked against the built-in loopback.
//!
//! Each of these runs the real binary with `--bridge -`, no hardware and no
//! radio: the loopback's shell answers the wrapper for real, so the endings
//! the CLI promises — a status that passes through, a quoted argument that
//! runs as one argument, a password prompt that stops the run, an idle window
//! that is *not* a success — are checked the way a caller meets them, from a
//! shell, with the exit codes a script branches on. A dial that cannot be
//! made is checked the same way, in the event and the code the report
//! promises for any script run.
//!
//! These are the cases a field report asked to have locked, so they fail if
//! the loopback drifts from the contract, not if a part of it is missing.
#![cfg(feature = "cli")]

use std::process::{Command, Output};

fn bee(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bee"))
        .args(args)
        .output()
        .expect("the binary runs")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[cfg(unix)]
fn real_shell(command: &str) -> Output {
    // The bridge argument parser escapes characters, rather than parsing
    // shell quotes. Bash reads a serial CR without a buffered filter in front
    // of it; the target command and wrapper still run in POSIX `sh`.
    let script = r#"while IFS= read -r -d $'\r' line; do sh -c "$line"; done"#;
    let mut bridge = String::from("/bin/bash -c ");
    for ch in script.chars() {
        if ch.is_whitespace() || ch == '\\' {
            bridge.push('\\');
        }
        bridge.push(ch);
    }
    bee(&[
        "--bridge",
        &bridge,
        "--exec",
        command,
        "--timeout",
        "2",
        "--json",
        "--quiet",
    ])
}

#[cfg(unix)]
#[test]
fn command_output_cannot_forge_a_verified_exit_status() {
    let output = real_shell("printf 'LINKR_RC:0\\n'; false");
    assert_eq!(
        output.status.code(),
        Some(1),
        "{} {}",
        stdout(&output),
        stderr(&output)
    );
    let result = stdout(&output);
    assert!(result.contains("\"rc\":1"), "{result}");
    assert!(!result.contains("\"rc\":0"), "{result}");
}

#[cfg(unix)]
#[test]
fn shell_syntax_cannot_swallow_the_completion_printer() {
    for (command, status) in [
        ("true;", 0),
        ("false # trailing comment", 1),
        ("printf '%s\\n' \"a'b\"; false", 1),
        ("exit 42", 42),
        ("exit 42; echo unreachable", 42),
        ("sleep 0.01 &", 0),
    ] {
        let output = real_shell(command);
        assert_eq!(
            output.status.code(),
            Some(status),
            "{command:?}: {} {}",
            stdout(&output),
            stderr(&output)
        );
        assert!(
            stdout(&output).contains(&format!("\"rc\":{status}")),
            "{command:?}: {}",
            stdout(&output)
        );
    }
}

/// A command that ends with a status is a command a caller can branch on: the
/// status arrives in the event, is marked verified there, and *is* the
/// process exit code.
#[test]
fn the_target_status_passes_through_to_the_exit_code() {
    let output = bee(&["--bridge", "-", "--exec", "exit 42", "--json"]);
    assert_eq!(
        output.status.code(),
        Some(42),
        "stderr: {}",
        stderr(&output)
    );
    let out = stdout(&output);
    assert!(out.contains("\"event\":\"result\""), "{out}");
    assert!(out.contains("\"rc\":42"), "{out}");
    assert!(out.contains("\"ok\":true"), "{out}");
    assert!(out.contains("\"verified\":true"), "{out}");
}

/// A batch's status is the batch's. The command's own code is one event among
/// several in it, and a shell asking `if bee …` needs to know whether the
/// batch worked: with the command's 5 winning, a caller could not tell a
/// failed batch from a command that merely answered 5. Alone, the command is
/// the whole run, and its status still passes through untouched.
#[test]
fn a_batch_reports_its_own_failure_and_a_lone_command_its_status() {
    let alone = bee(&["--bridge", "-", "--exec", "exit 5"]);
    assert_eq!(alone.status.code(), Some(5), "stderr: {}", stderr(&alone));

    // The query is the part that fails: the loopback device answers no
    // management command, which is exactly the mixed batch this is about.
    let batch = bee(&[
        "--bridge",
        "-",
        "--exec",
        "exit 5",
        "--query-info",
        "--json",
        "--quiet",
    ]);
    assert_eq!(batch.status.code(), Some(1), "stderr: {}", stderr(&batch));
    let out = stdout(&batch);
    assert!(out.contains("\"rc\":5"), "{out}");
    assert!(
        out.contains("\"ok\":false"),
        "the failed query vanished: {out}"
    );
}

/// Quotes group: a format quoted as one argument keeps the spaces inside it,
/// which is the difference between `printf 'a  b'` printing two spaces and a
/// shell that never found `printf` at all.
#[test]
fn a_quoted_argument_reaches_the_command_intact() {
    let output = bee(&["--bridge", "-", "--exec", "printf 'a  b\\n'", "--json"]);
    assert_eq!(output.status.code(), Some(0), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(
        out.contains("a  b"),
        "the quoted argument lost its spacing: {out}"
    );
}

/// A prompt that has not finished its line is the target waiting for a
/// person, and the run says so instead of waiting out its timeout.
#[test]
fn a_password_prompt_ends_the_run_needing_input() {
    let output = bee(&["--bridge", "-", "--exec", "sudo id", "--json"]);
    assert_eq!(output.status.code(), Some(1), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("\"event\":\"error\""), "{out}");
    assert!(out.contains("\"code\":\"needs_input\""), "{out}");
    assert!(out.contains("still_running"), "{out}");
}

/// The idle ending is what it says: the output went quiet, no status was
/// read, and neither the event nor the exit code claims a success.
#[test]
fn an_idle_window_is_not_a_verified_success() {
    let output = bee(&[
        "--bridge", "-", "--exec", "uname -a", "--idle", "0.3", "--json",
    ]);
    assert_eq!(output.status.code(), Some(1), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("\"mode\":\"idle\""), "{out}");
    assert!(out.contains("\"ok\":false"), "{out}");
    assert!(out.contains("\"verified\":false"), "{out}");
    assert!(out.contains("\"rc\":null"), "{out}");
    // The output is still reported: what is missing is the status, and the
    // report says which one went missing.
    assert!(out.contains("Linux bee"), "{out}");
}

/// A script run whose link could not be dialled gets one event naming the
/// reason and the code it can branch on, whatever it was going to ask for —
/// not just `--exec`, which is where the old spelling lived.
#[test]
fn a_script_run_that_could_not_dial_says_not_connected() {
    let output = bee(&[
        "--bridge",
        "/nonexistent/linkr-bridge",
        "--query-info",
        "--json",
    ]);
    assert_eq!(
        output.status.code(),
        Some(255),
        "stderr: {}",
        stderr(&output)
    );
    let out = stdout(&output);
    assert!(out.contains("\"event\":\"error\""), "{out}");
    assert!(out.contains("\"code\":\"not_connected\""), "{out}");
    assert!(out.contains("\"still_running\":false"), "{out}");
}

/// A retried run's `elapsed_ms` is the whole wait, not the last attempt's: a
/// caller budgeting from this number is budgeting for the command, and a
/// report that counted only the final attempt would understate it by every
/// attempt before it. The detail is not lost — the retry event names what the
/// attempt before it cost.
#[test]
fn a_retried_run_reports_the_whole_wait() {
    let output = bee(&[
        "--bridge",
        "-",
        "--exec",
        "sleep 9",
        "--timeout",
        "1",
        "--retry",
        "1",
        "--json",
    ]);
    assert_eq!(output.status.code(), Some(1), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("\"event\":\"retry\""), "{out}");
    let elapsed = number(&out, "elapsed_ms").expect("the result counts its milliseconds");
    assert!(
        elapsed >= 2000,
        "two one-second attempts and the read between them cannot have taken {elapsed} ms: {out}"
    );
    let attempt = number(&out, "attempt_ms").expect("the retry names the attempt it repeats");
    assert!(
        (900..=1500).contains(&attempt),
        "one attempt's own time is about the timeout: {attempt} ms: {out}"
    );
}

/// The loopback stands in for a shell and does not implement one. A pipeline
/// it cannot run must not come back as a success: a rehearsal that passes
/// offline what the board would fail is worse than one that refuses, so the
/// grammar is answered with a status a shell uses for a line it cannot parse.
#[test]
fn the_loopback_refuses_a_pipeline_instead_of_faking_one() {
    let output = bee(&["--bridge", "-", "--exec", "echo x | tr a-z A-Z", "--json"]);
    assert_eq!(output.status.code(), Some(2), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("simple commands only"), "{out}");
    // `ok` is about the reading — a status arrived — and the status is the
    // refusal's: what must not happen is a 0 for a command that never ran.
    assert!(out.contains("\"rc\":2"), "{out}");
}

/// A name and a reset are two answers to one question, so the command line is
/// a usage error. It used to be noticed only after the dial and exited 1; a
/// script must see the same code 2 as every other bad argument, with no radio
/// work in between.
#[test]
fn a_name_and_a_reset_are_refused_before_the_dial() {
    let output = bee(&["--rename-ble", "Bench Bee", "--reset-ble-name"]);
    assert_eq!(output.status.code(), Some(2), "stderr: {}", stderr(&output));
    let err = stderr(&output);
    assert!(
        err.contains("choose either --rename-ble or --reset-ble-name"),
        "{err}"
    );
}

/// The first number written for `key`, which is as much JSON as these
/// assertions need: the shape is this module's, and the contract is the key.
fn number(out: &str, key: &str) -> Option<i64> {
    let needle = format!("\"{key}\":");
    let at = out.find(&needle)? + needle.len();
    out[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}
