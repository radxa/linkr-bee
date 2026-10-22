//! The command line's refusals, locked against the built binary.
//!
//! Each of these is a request that used to come back looking like success: an
//! empty `--exec` (a run marker and a status for a line that ran nothing), a
//! join with no password (the firmware reads an empty key as an *open*
//! network), and a `--transport` beside `--bridge` (overridden without a
//! word). A refusal is met from a shell the same way an answer is — `rc=2`,
//! the sentence on stderr, nothing sent — which is what these check.
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

/// The command the archives install is `bee`, not the crate's old internal
/// name: a script that pins `--version` must see the name it can invoke.
#[test]
fn the_version_names_the_command() {
    let output = bee(&["--version"]);
    assert_eq!(output.status.code(), Some(0), "stderr: {}", stderr(&output));
    assert_eq!(
        stdout(&output).trim(),
        format!("bee {}", env!("CARGO_PKG_VERSION"))
    );
}

/// `--exec ""` is not a run: the wrapper would still send its marker and the
/// shell would still print a status, so a line that ran nothing would come
/// back verified.
#[test]
fn an_empty_command_is_refused() {
    for empty in ["", "   ", "\t"] {
        let output = bee(&["--exec", empty]);
        assert_eq!(output.status.code(), Some(2), "stderr: {}", stderr(&output));
        assert!(
            stderr(&output).contains("exec wants a command to run"),
            "{}",
            stderr(&output)
        );
    }
}

/// A join is a name *and* a password; with an empty one the firmware would be
/// told to join an open network, and the change that did not happen would be
/// reported as one that did.
#[test]
fn a_join_without_a_password_is_refused() {
    let output = bee(&["--wifi", "BenchNet"]);
    assert_eq!(output.status.code(), Some(2), "stderr: {}", stderr(&output));
    assert!(
        stderr(&output).contains("a join needs a password"),
        "{}",
        stderr(&output)
    );
}

/// A join with no network named is a forget spelled sideways — `@w=,` is not
/// what anyone means, and `--wifi-off` is what they mean.
#[test]
fn a_join_without_a_network_is_refused() {
    let output = bee(&["--wifi", ""]);
    assert_eq!(output.status.code(), Some(2), "stderr: {}", stderr(&output));
    assert!(
        stderr(&output).contains("a join needs a network"),
        "{}",
        stderr(&output)
    );
}

/// The bridge *is* a stdio link whatever else the command line says, so
/// naming another transport beside it would be a statement the run quietly
/// discards.
#[test]
fn a_bridge_with_another_transport_is_refused() {
    let output = bee(&["--bridge", "-", "--transport", "ble", "--exec", "true"]);
    assert_eq!(output.status.code(), Some(2), "stderr: {}", stderr(&output));
    let said = stderr(&output);
    assert!(said.contains("--transport"), "{said}");
    assert!(said.contains("pick one"), "{said}");
}

/// The same two flags in the order that makes sense: a stdio transport *is*
/// what a bridge is, and the run goes through.
#[test]
fn a_bridge_with_the_stdio_transport_runs() {
    let output = bee(&[
        "--bridge",
        "-",
        "--transport",
        "stdio",
        "--exec",
        "true",
        "--json",
    ]);
    assert_eq!(output.status.code(), Some(0), "stderr: {}", stderr(&output));
}

/// The flags that configure an interface in a build that has none: `--enter`,
/// `--local-echo`, `--line-mode`, `--escape` and `--cli-then-tui` choose how
/// the terminal behaves while it is held, and a build compiled without it
/// answers every command line from the script side. Parsing them there would
/// accept a command line and quietly drop it, which is the one outcome a
/// caller cannot see — the run would look configured and behave unconfigured.
#[cfg(not(feature = "tui"))]
#[test]
fn an_interface_flag_with_no_interface_is_refused() {
    for (argv, flag) in [
        (&["--line-mode"][..], "--line-mode"),
        (&["--local-echo"][..], "--local-echo"),
        (&["--enter", "cr"][..], "--enter"),
        (&["--escape", "^]"][..], "--escape"),
        (&["--cli-then-tui"][..], "--cli-then-tui"),
    ] {
        let output = bee(argv);
        assert_eq!(output.status.code(), Some(2), "{flag}: {}", stderr(&output));
        let said = stderr(&output);
        assert!(said.contains("no interface"), "{flag}: {said}");
        assert!(said.contains(flag), "{flag}: {said}");
    }
}

/// WebDAV is part of the protocol, so the host keeps it discoverable even
/// though some firmware images are built without it. A board without the
/// feature answers the command itself; the command line does not pretend the
/// question does not exist.
#[test]
fn webdav_is_promised_and_documented() {
    let output = bee(&["--capabilities", "--json"]);
    assert_eq!(output.status.code(), Some(0), "stderr: {}", stderr(&output));
    let caps = stdout(&output);
    for wanted in ["query-webdav", "webdav-off", "webdav"] {
        assert!(caps.contains(wanted), "{wanted} missing from {caps}");
    }

    let help = bee(&["--help"]);
    assert_eq!(help.status.code(), Some(0), "stderr: {}", stderr(&help));
    let help = stdout(&help);
    for flag in ["--query-webdav", "--webdav", "--webdav-off"] {
        assert!(help.contains(flag), "{flag} missing from help: {help}");
    }
}
