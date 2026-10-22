//! The passive console-state heuristic (`web/serial_console.js`).
//!
//! Device output is untrusted and prompts can be customized, so this never
//! decides anything — it only names what the *tail* of the output looks like it
//! is waiting for. It reads the current tail, never an earlier boot message,
//! and returns a `kind` plus a short `evidence` excerpt.

/// What the tail of the serial output looks like it is waiting for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleKind {
    /// Nothing recognised — the state is unknown.
    Unknown,
    /// A login prompt (`… login:`).
    Login,
    /// A `[sudo] password for …:` prompt.
    SudoPassword,
    /// A `[Y/n]` / `(yes/no)` / `continue?` confirmation.
    Confirmation,
    /// A pager prompt (`--More--`, `(END)`, `Press ENTER`).
    Pager,
    /// A bare `password:` prompt.
    Password,
    /// A bootloader prompt (`=>` or `U-Boot>`).
    Bootloader,
    /// A POSIX shell prompt (`user@host:path$` / `[user@host dir]#`).
    Shell,
    /// A `Kernel panic - not syncing:` line appeared in the window.
    Panic,
}

/// The result of inspecting the tail of a serial log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleState {
    /// The recognised kind, or [`ConsoleKind::Unknown`].
    pub kind: ConsoleKind,
    /// A short excerpt that justifies the kind (the matched line or tail).
    pub evidence: String,
    /// The cursor the inspection read up to.
    pub cursor: usize,
}

/// The number of trailing characters the heuristic considers, matching the
/// web's `slice(-4000)`.
const TAIL_CHARS: usize = 4000;

/// The length of an evidence excerpt.
const EVIDENCE_CHARS: usize = 240;

/// Inspect a serial log's tail and name the interaction it is waiting for.
///
/// `text` is the whole retained log; `latest_cursor` is the log's end cursor,
/// carried through so the caller can tell where the observation ended.
pub fn inspect_serial_console(text: &str, latest_cursor: usize) -> ConsoleState {
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(TAIL_CHARS);
    let tail: String = chars[start..].iter().collect();
    let normalized = tail.replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let last = lines.last().map(|l| l.trim_end()).unwrap_or("");

    let kind = classify(last, &lines);
    let evidence = if kind == ConsoleKind::Panic {
        // The panic line, not the tail, is the evidence.
        lines
            .iter()
            .rev()
            .find(|l| l.contains("Kernel panic - not syncing:"))
            .map(|l| crate::text::tail_chars(l, EVIDENCE_CHARS))
            .unwrap_or_default()
    } else if kind == ConsoleKind::Unknown {
        String::new()
    } else {
        crate::text::tail_chars(last, EVIDENCE_CHARS)
    };

    ConsoleState {
        kind,
        evidence,
        cursor: latest_cursor,
    }
}

/// Convenience: inspect with no cursor tracking.
pub fn inspect(text: &str) -> ConsoleState {
    inspect_serial_console(text, text.chars().count())
}

fn classify(last: &str, lines: &[&str]) -> ConsoleKind {
    // Order matters: more specific prompts first, mirroring the web's `if/else`.
    if is_login(last) {
        ConsoleKind::Login
    } else if is_sudo_password(last) {
        ConsoleKind::SudoPassword
    } else if is_confirmation(last) {
        ConsoleKind::Confirmation
    } else if is_pager(last) {
        ConsoleKind::Pager
    } else if is_password(last) {
        ConsoleKind::Password
    } else if is_bootloader(last) {
        ConsoleKind::Bootloader
    } else if is_shell(last) {
        ConsoleKind::Shell
    } else if lines
        .iter()
        .any(|l| l.contains("Kernel panic - not syncing:"))
    {
        ConsoleKind::Panic
    } else {
        ConsoleKind::Unknown
    }
}

/// `^(?:[^\s:]+\s+)?login:\s*$` — a bare `login:` or a hostname-prefixed one.
fn is_login(tail: &str) -> bool {
    let t = tail.trim_end();
    let Some(body) = t.strip_suffix("login:") else {
        return false;
    };
    // The optional prefix is a non-empty, colon-free token followed by
    // whitespace.
    body.is_empty() || {
        let trimmed = body.trim_end();
        !trimmed.is_empty() && !trimmed.contains(':') && !trimmed.chars().any(char::is_whitespace)
    }
}

/// `^\[sudo\] password for .+:\s*$`.
fn is_sudo_password(tail: &str) -> bool {
    let t = tail.trim_end().to_ascii_lowercase();
    let Some(body) = t.strip_suffix(':') else {
        return false;
    };
    body.starts_with("[sudo] password for ") && body.len() > "[sudo] password for ".len()
}

/// `(?:\[(?:Y/n|y/N|y/n|yes/no)\]|\((?:y/n|yes/no)\)|(?:continue|proceed)\?)\s*[:?]?\s*$`.
fn is_confirmation(tail: &str) -> bool {
    let t = tail.trim_end().to_ascii_lowercase();
    let t = t.trim_end_matches([':', '?']);
    let t = t.trim_end();
    // Bracketed yes/no forms.
    for inner in ["y/n", "y/n", "y/n", "yes/no"] {
        if t.ends_with(&format!("[{inner}]")) || t.ends_with(&format!("({inner})")) {
            return true;
        }
    }
    // The `continue?` / `proceed?` form (the `?` is already trimmed above).
    t.ends_with("continue") || t.ends_with("proceed")
}

/// `(?:--More--(?:\([^)]*\))?|\(END\)|Press (?:any key|ENTER|RETURN)(?: to [^.]+)?[.:]?)\s*$`.
fn is_pager(tail: &str) -> bool {
    let t = tail.trim_end().to_ascii_lowercase();
    t.starts_with("--more--")
        || t == "(end)"
        || t.starts_with("press any key")
        || t.starts_with("press enter")
        || t.starts_with("press return")
}

/// `^(?:[^\r\n]{0,80}\s)?password:\s*$`.
fn is_password(tail: &str) -> bool {
    let t = tail.trim_end();
    if !t.to_ascii_lowercase().ends_with("password:") {
        return false;
    }
    // The prefix before `password:` must be empty or end in whitespace and be at
    // most 80 characters.
    let body = &t[..t.len() - "password:".len()];
    if body.is_empty() {
        return true;
    }
    body.len() <= 80 && body.chars().last().is_some_and(char::is_whitespace)
}

/// `^(?:=>|U-Boot>)\s*$`.
fn is_bootloader(tail: &str) -> bool {
    let t = tail.trim_end();
    t == "=>" || t == "U-Boot>"
}

/// `^(?:[\w.-]+@[\w.-]+:[^\r\n]*|\[[\w.-]+@[\w.-]+ [^\]\r\n]*\])[$#]\s*$`.
fn is_shell(tail: &str) -> bool {
    let t = tail.trim_end();
    let body = t.strip_suffix('$').or_else(|| t.strip_suffix('#'));
    let Some(body) = body else { return false };
    let body = body.trim_end();
    if let Some(inner) = body.strip_prefix('[').and_then(|b| b.strip_suffix(']')) {
        // [user@host dir]
        inner.contains('@') && inner.contains(' ')
    } else {
        // user@host:path
        body.contains('@') && body.contains(':')
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_of(text: &str) -> ConsoleKind {
        inspect(text).kind
    }

    #[test]
    fn recognises_each_prompt_kind() {
        assert_eq!(kind_of("radxa login:"), ConsoleKind::Login);
        assert_eq!(kind_of("login:"), ConsoleKind::Login);
        assert_eq!(
            kind_of("[sudo] password for root:"),
            ConsoleKind::SudoPassword
        );
        assert_eq!(kind_of("Remove? [Y/n]"), ConsoleKind::Confirmation);
        assert_eq!(kind_of("--More--(12%)"), ConsoleKind::Pager);
        assert_eq!(kind_of("password:"), ConsoleKind::Password);
        assert_eq!(kind_of("=>"), ConsoleKind::Bootloader);
        assert_eq!(kind_of("U-Boot>"), ConsoleKind::Bootloader);
        assert_eq!(kind_of("root@radxa:/#"), ConsoleKind::Shell);
        assert_eq!(kind_of("[root@radxa ~]#"), ConsoleKind::Shell);
    }

    #[test]
    fn panic_is_detected_anywhere_in_the_window() {
        let text = "startup\n...\nKernel panic - not syncing: Attempted to kill init!\n";
        assert_eq!(kind_of(text), ConsoleKind::Panic);
        let state = inspect(text);
        assert!(state.evidence.contains("Kernel panic"));
    }

    #[test]
    fn unknown_for_unrecognised_tail() {
        assert_eq!(kind_of("some random output"), ConsoleKind::Unknown);
        assert_eq!(kind_of(""), ConsoleKind::Unknown);
    }

    #[test]
    fn the_evidence_is_a_bounded_tail_excerpt() {
        // A password prompt with a short prefix, then a very long evidence line.
        let state = inspect("some-host password:");
        assert_eq!(state.kind, ConsoleKind::Password);
        let long = format!("{} password:", "x".repeat(60));
        let state = inspect(&long);
        assert_eq!(state.kind, ConsoleKind::Password);
        assert!(state.evidence.chars().count() <= EVIDENCE_CHARS);
    }

    #[test]
    fn a_login_prompt_with_a_hostname_prefix_matches() {
        assert_eq!(kind_of("ubuntu login:"), ConsoleKind::Login);
        assert_eq!(kind_of("login:"), ConsoleKind::Login);
        // A leading-space-only prefix is not `[^\s:]+\s+`, so it is not a login
        // prompt — it is unknown, exactly as the web's regex reads it.
        assert_eq!(kind_of("   login:"), ConsoleKind::Unknown);
    }

    #[test]
    fn a_shell_prompt_with_cursor_path_matches() {
        assert_eq!(kind_of("pi@raspberrypi:~ $"), ConsoleKind::Shell);
        assert_eq!(kind_of("pi@raspberrypi:/var/log #"), ConsoleKind::Shell);
    }
}
