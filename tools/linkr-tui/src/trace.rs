//! Where the bytes on the wire are recorded, when somebody asked for them.
//!
//! Two switches, one shape. `--log-file` appends what the device sent to a
//! file, which is how a session is kept: a console log is evidence, and the
//! pane scrolls what it showed out of existence. `--debug-io` traces both
//! directions to stderr, which is how a wire is *debugged* — the question it
//! answers is not "what did the board say" but "did what I typed get there".
//!
//! The two are deliberately different sinks for the same reason they are
//! different flags. A log file is opened once and appended to for the whole
//! session, so it survives the program; a trace is read while the program runs
//! and is worthless afterwards. Nothing is buffered in either: a trace that
//! loses its last line because the process exited is a trace missing exactly
//! the moment that mattered.

use std::fs::File;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// The recording, for a session that may not have asked for one.
#[derive(Debug, Default)]
pub struct ByteTrace {
    /// Where received bytes are appended, when `--log-file` named one.
    file: Option<File>,
    /// Whether both directions are traced to standard error.
    stderr: bool,
    /// Where both directions are traced when standard error is the terminal
    /// being drawn in: a trace written into that terminal would push lines
    /// into the alternate screen behind the renderer's back, and the
    /// differential paint cannot repair what it never recorded — so the trace
    /// goes to a file the user can read instead.
    trace_file: Option<File>,
}

impl ByteTrace {
    /// A trace that records nothing, which is the default: a program that
    /// wrote a log file because nobody asked would be filling disks.
    pub fn none() -> ByteTrace {
        ByteTrace {
            file: None,
            stderr: false,
            trace_file: None,
        }
    }

    /// Append what the device sends to `path`, creating it when it is not
    /// there.
    ///
    /// Append rather than truncate on purpose: a log that lost yesterday's
    /// session when today's started is a log nobody can compare against, and
    /// comparing is the whole point of keeping one.
    pub fn to_file(path: &Path) -> std::io::Result<ByteTrace> {
        // Owner-only where the platform has permissions, asked for at
        // creation: a trace can carry what was typed, and what is typed can be
        // a secret.
        let file = crate::private_file::open_private_append(path)?;
        Ok(ByteTrace {
            file: Some(file),
            stderr: false,
            trace_file: None,
        })
    }

    /// Also trace both directions to standard error.
    pub fn with_stderr(mut self) -> ByteTrace {
        self.stderr = true;
        self
    }

    /// Whether anything is being recorded at all, which the caller asks so a
    /// session with no trace does not pay for one — and, more to the point, so
    /// a test can assert that it did not.
    pub fn is_active(&self) -> bool {
        self.file.is_some() || self.tracing()
    }

    /// Whether both directions are being traced anywhere — standard error or
    /// a file. The interface's switch reads this: the question it answers is
    /// "is a trace being kept", not where the lines land.
    pub fn tracing(&self) -> bool {
        self.stderr || self.trace_file.is_some()
    }

    /// Whether both directions are being traced to standard error, which a
    /// test reads to know which way the switch points there.
    pub fn tracing_stderr(&self) -> bool {
        self.stderr
    }

    /// Turn the standard-error trace on or off while the session runs.
    ///
    /// A switch rather than a constructor-only option because the question a
    /// trace answers — "did what I typed get there" — is usually asked *after*
    /// something went wrong, and a switch that needed a restart would make the
    /// user reproduce the problem to see it.
    pub fn set_stderr(&mut self, on: bool) {
        self.stderr = on;
    }

    /// Trace into `path` until told to stop, creating or appending to it.
    ///
    /// The sink for a trace asked for while standard error is the terminal
    /// being drawn in. Owner-only where the platform has permissions: a trace
    /// can carry what was typed, and what is typed can be a secret.
    pub fn set_trace_file(&mut self, path: &Path) -> std::io::Result<()> {
        let file = crate::private_file::open_private_append(path)?;
        // Again on a file that already existed: one written before the mode was
        // asked for at creation keeps the mode it was made with.
        let _ = crate::private_file::restrict(path);
        self.stderr = false;
        self.trace_file = Some(file);
        Ok(())
    }

    /// Stop tracing, wherever it was going.
    pub fn stop_tracing(&mut self) {
        self.stderr = false;
        self.trace_file = None;
    }

    /// One line of trace, to every sink that asked for one.
    fn trace_line(&mut self, line: String) {
        if self.stderr {
            eprintln!("{line}");
        }
        if let Some(file) = self.trace_file.as_mut() {
            // A full disk must not end the session: the trace is a record of
            // the session, not a condition of it.
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
    }

    /// Bytes that arrived from the device.
    pub fn rx(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if let Some(file) = self.file.as_mut() {
            // A full disk or a closed pipe must not end the session: the log is
            // a record of the session, not a condition of it.
            let _ = file.write_all(bytes);
            let _ = file.flush();
        }
        if self.tracing() {
            self.trace_line(format!("rx {} bytes: {}", bytes.len(), debugged(bytes)));
        }
    }

    /// Bytes that left for the device down the stream, keystrokes and all.
    pub fn tx(&mut self, bytes: &[u8]) {
        if self.tracing() && !bytes.is_empty() {
            self.trace_line(format!("tx {} bytes: {}", bytes.len(), debugged(bytes)));
        }
    }

    /// A management command that left for the bridge.
    ///
    /// Taken already redacted, because this is the one trace that would
    /// otherwise put a WiFi password on stderr — and stderr is scrollback, a
    /// terminal recording, or a CI log, none of which is a place a password
    /// belongs. See [`crate::accessory::redact_command`].
    pub fn tx_command(&mut self, command: &str) {
        if !command.is_empty() {
            self.management_line(format!("tx command: {command}"));
        }
    }

    /// A management reply that came back from the bridge.
    ///
    /// Taken already redacted for the reason the command direction is: a reply
    /// is where the bridge reports `token=…`, and the sinks here are
    /// scrollback, a file and a CI log. See
    /// [`crate::lan_token_store::redact`].
    ///
    /// A reply body is several lines as often as not — diagnostics are — and
    /// each keeps its own label so that none of them reads as target output in
    /// the log, which is the same device speaking in a different voice.
    pub fn rx_reply(&mut self, reply: &str) {
        for line in reply.lines() {
            if !line.is_empty() {
                self.management_line(format!("rx reply: {line}"));
            }
        }
    }

    /// One management-channel line: the log records both directions too.
    ///
    /// They are labelled because the log file is raw device bytes everywhere
    /// else, and the bridge talking about itself is the same device speaking
    /// in a different voice. A log holding the questions and not the answers
    /// is half a dialog, and the half that is missing is the one a reader
    /// cannot reconstruct.
    fn management_line(&mut self, line: String) {
        if let Some(file) = self.file.as_mut() {
            // A full disk or a closed pipe must not end the session: the log
            // is a record of the session, not a condition of it.
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
        self.trace_line(line);
    }
}

/// Where a trace goes when standard error is the terminal being drawn in: a
/// fresh file per process in the temporary directory, named by pid so two
/// sessions on one machine cannot write into each other's.
///
/// A file rather than stderr for the same reason the trace is a separate
/// switch from `--log-file`: a trace is read *while* the session runs, and one
/// that corrupts the screen it is meant to explain has explained nothing.
pub fn default_trace_path() -> PathBuf {
    std::env::temp_dir().join(format!("linkr-trace-{}.log", std::process::id()))
}

/// How bytes are shown: printable ones as themselves and the rest as `\xNN`,
/// which is the shape the reference client prints and the shape that makes a
/// mangled echo obvious at a glance. `A` and `\x41` are the same byte, but
/// only one of them looks like a wire problem.
pub fn debugged(bytes: &[u8]) -> String {
    let mut out = String::new();
    for byte in bytes {
        if byte.is_ascii_graphic() || *byte == b' ' {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("\\x{byte:02x}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Printable bytes read as themselves and the rest as escapes, which is
    /// what makes a mangled echo obvious: `A` and `\x41` are the same byte, but
    /// only one of them looks like a wire problem.
    #[test]
    fn bytes_are_shown_as_themselves_when_they_can_be() {
        assert_eq!(debugged(b"ok"), "ok");
        assert_eq!(debugged(b"a\nb"), "a\\x0ab");
        assert_eq!(debugged(b""), "");
    }

    /// A log file is appended to, not truncated: a log that lost yesterday's
    /// session when today's started is one nobody can compare against, and
    /// comparing is the point of keeping it.
    #[test]
    fn a_log_file_is_appended_to_and_not_truncated() {
        let dir = std::env::temp_dir().join(format!("linkr-trace-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("rx.log");
        let _ = std::fs::remove_file(&path);

        {
            let mut trace = ByteTrace::to_file(&path).expect("the file opens");
            assert!(trace.is_active(), "a file is being written");
            trace.rx(b"first");
        }
        {
            let mut trace = ByteTrace::to_file(&path).expect("the file opens again");
            trace.rx(b"-second");
        }
        let kept = std::fs::read(&path).expect("the file reads back");
        assert_eq!(String::from_utf8_lossy(&kept), "first-second");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A trace that is not active records nothing, so a session with no
    /// `--log-file` and no `--debug-io` does not touch the disk at all.
    #[test]
    fn a_trace_nobody_asked_for_is_inactive() {
        let mut trace = ByteTrace::none();
        assert!(!trace.is_active());
        // Called so that an inactive trace is proven not to panic rather than
        // merely not to open a file.
        trace.rx(b"ignored");
        trace.tx(b"ignored");
        trace.tx_command("@w=ssid,secret");
        trace.rx_reply("OK token=ignored");
        assert!(ByteTrace::none().with_stderr().is_active());
    }

    /// The management dialog goes into the log file too, labelled: the file is
    /// raw device bytes everywhere else, and a log holding the questions and
    /// not the answers is half a dialog — the answers being the half a reader
    /// cannot reconstruct.
    #[test]
    fn a_log_file_holds_the_management_dialog_too() {
        let dir = std::env::temp_dir().join(format!("linkr-trace-mgmt-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("mgmt.log");
        let _ = std::fs::remove_file(&path);

        let mut trace = ByteTrace::to_file(&path).expect("the file opens");
        trace.rx(b"shell output\r\n");
        trace.tx_command("@i?");
        trace.rx_reply("OK fw=1.0.0\r\nOK wifi state=connected");
        drop(trace);

        let text = std::fs::read_to_string(&path).expect("the file reads back");
        assert!(text.contains("shell output\r\n"), "{text:?}");
        assert!(text.contains("tx command: @i?"), "{text}");
        assert!(text.contains("rx reply: OK fw=1.0.0"), "{text}");
        assert!(
            text.contains("rx reply: OK wifi state=connected"),
            "every line of a multi-line reply keeps its label: {text}"
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The standard-error trace can be switched on and off while the session
    /// runs: the question it answers is asked after something already went
    /// wrong, and a switch that needed a restart would make the user reproduce
    /// the problem to watch it.
    #[test]
    fn the_stderr_trace_switches_at_runtime() {
        let mut trace = ByteTrace::none();
        assert!(!trace.tracing_stderr(), "off until asked for");
        trace.set_stderr(true);
        assert!(trace.tracing_stderr());
        assert!(trace.is_active(), "a trace without a file is still a trace");
        trace.set_stderr(false);
        assert!(!trace.tracing_stderr());
        assert!(!trace.is_active(), "and back to recording nothing");
    }

    /// A trace asked for while standard error is the terminal goes to a file,
    /// and the switch says so: this is the sink that keeps a trace from being
    /// painted into the screen it is meant to explain.
    #[test]
    fn a_trace_can_go_to_a_file_instead_of_the_screen() {
        let dir = std::env::temp_dir().join(format!("linkr-trace-file-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("trace.log");
        let _ = std::fs::remove_file(&path);

        let mut trace = ByteTrace::none();
        trace.set_trace_file(&path).expect("the file opens");
        assert!(trace.tracing(), "a trace is being kept");
        assert!(!trace.tracing_stderr(), "and the screen is not the sink");
        trace.tx(b"ls\r");
        trace.rx(b"ok\n");
        trace.tx_command("@w?");
        trace.stop_tracing();
        assert!(!trace.tracing(), "the switch goes back off");

        let text = std::fs::read_to_string(&path).expect("the trace was written");
        assert!(text.contains("tx 3 bytes: ls\\x0d"), "{text}");
        assert!(text.contains("rx 3 bytes: ok\\x0a"), "{text}");
        assert!(text.contains("tx command: @w?"), "{text}");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
