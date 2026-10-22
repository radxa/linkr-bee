//! Execution approval (`web/agent_execution_policy.js`).
//!
//! The guard against destructive or irreversible operations, plus the exact
//! low-risk query allowlist and the three execution modes. This is a best-effort
//! guard for recognized shell forms, not a shell sandbox: indirect execution
//! through scripts or interpreters cannot be classified completely.

use super::policy::Policy;

/// The three execution modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    /// Only exact allowlisted low-risk queries are sent unattended.
    Auto,
    /// Nothing is sent without an explicit user action.
    Manual,
    /// Everything except destructive/irreversible commands is sent unattended,
    /// within a time window.
    FullAuto,
}

impl ExecutionMode {
    pub fn parse(value: &str) -> Option<ExecutionMode> {
        match value {
            "auto" => Some(ExecutionMode::Auto),
            "manual" => Some(ExecutionMode::Manual),
            "full-auto" => Some(ExecutionMode::FullAuto),
            _ => None,
        }
    }
}

/// The exact, deliberately small shell-query allowlist. Never trust a model's
/// risk label.
const QUERIES: &[&str] = &[
    "pwd",
    "whoami",
    "id",
    "uptime",
    "date",
    "uname",
    "uname -a",
    "uname -r",
    "uname -m",
    "ls",
    "ls -l",
    "ls -a",
    "ls -la",
    "ls -al",
    "ls -lh",
    "df",
    "df -h",
    "df -T",
    "free",
    "free -h",
    "free -m",
    "lsblk",
    "lsblk -f",
    "dmesg",
    "dmesg -T",
    "ip addr show",
    "ip link show",
    "ip route show",
    "cat /proc/version",
    "cat /proc/cpuinfo",
    "cat /proc/meminfo",
    "cat /proc/uptime",
    "cat /proc/cmdline",
    "cat /etc/os-release",
];

/// Whether a command is in the query allowlist.
pub fn is_query(command: &str) -> bool {
    QUERIES.contains(&command)
}

/// Decide whether input needs approval, matching `requiresInputApproval`.
///
/// `payload` is the exact wire text (including the trailing newline when
/// `append_enter` is true).
pub fn requires_input_approval(
    mode: ExecutionMode,
    text: &str,
    payload: &str,
    input_pending: bool,
    append_enter: bool,
    policy: Option<&Policy>,
) -> bool {
    // Destructive operations outrank the mode.
    if is_guarded_command(text) {
        return true;
    }
    // The user's "always ask" list outranks Full Auto too.
    if let Some(policy) = policy {
        if super::policy::is_always_ask(&policy.always_ask, &[text, payload]) {
            return true;
        }
    }
    if mode == ExecutionMode::FullAuto {
        return false;
    }
    if mode != ExecutionMode::Auto || input_pending || !append_enter {
        return true;
    }
    // Compare the exact wire text.
    let enters = ["\r", "\n", "\r\n"];
    if let Some(policy) = policy {
        if super::policy::is_pre_approved(&policy.allow, text)
            && enters.iter().any(|e| payload == format!("{text}{e}"))
        {
            return false;
        }
    }
    !is_query(text) || !enters.iter().any(|e| payload == format!("{text}{e}"))
}

// --- the destructive guard ---------------------------------------------------

/// Whether the wire text contains a guarded command at a command position, or a
/// guarded pipeline.
pub fn is_guarded_command(text: &str) -> bool {
    // Pipelines are position-independent.
    if guarded_pipeline_matches(text) {
        return true;
    }
    // Guarded commands must start a command position.
    for position in command_positions(text) {
        let rest = &text[position..];
        if guarded_command_at(rest) {
            return true;
        }
    }
    false
}

/// The command-start positions in a wire string: the beginning, after a shell
/// separator (`;`, `&`, `|`, backtick, `(`, `)` or newline), or after a
/// `sh -c '…'` wrapper.
fn command_positions(text: &str) -> Vec<usize> {
    let mut positions = vec![0];
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if matches!(b, b';' | b'&' | b'|' | b'`' | b'(' | b')' | b'\n' | b'\r') {
            positions.push(i + 1);
        }
    }
    // `sh -c '…'` / `bash -c "…"` open a command position after the quote.
    //
    // Searched in `text` itself, case-insensitively and one character at a
    // time: folding the whole string first (`to_lowercase`) moves every byte
    // after a character whose lowercase is longer than it is — `İ` is two
    // bytes and folds to three — so an offset found in the folded copy is not
    // an offset in the text, and slicing with it can cut a character in half.
    for sh in ["sh", "bash", "dash", "ash", "zsh"] {
        let needle = format!("{sh} -c");
        let mut start = 0;
        while let Some(abs) = find_ignore_case(text, &needle, start) {
            let after = &text[abs + needle.len()..];
            // Skip whitespace, then a single/double quote.
            let after_trim = after.trim_start();
            let skipped = after.len() - after_trim.len();
            if let Some(quote) = after_trim.chars().next() {
                if quote == '\'' || quote == '"' {
                    let cmd_start = abs + needle.len() + skipped + quote.len_utf8();
                    if cmd_start <= text.len() {
                        positions.push(cmd_start);
                    }
                }
            }
            start = abs + needle.len();
        }
    }
    positions
}

/// Find `needle` in `haystack` from `from`, ignoring ASCII case, and return a
/// byte index *of the haystack*.
///
/// The needle is always a shell's own name spelled with ASCII characters, so
/// an ASCII comparison is the whole of what is needed — and it is what keeps
/// every offset an offset in the text rather than in a folded copy of it.
fn find_ignore_case(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let width = needle.len();
    if width == 0 || from >= bytes.len() {
        return None;
    }
    let mut at = from;
    while at + width <= bytes.len() {
        if bytes[at..at + width].eq_ignore_ascii_case(needle.as_bytes()) {
            return Some(at);
        }
        // A match can only start on a character boundary, so the walk steps by
        // whole characters rather than by bytes.
        at += haystack[at..].chars().next().map_or(1, char::len_utf8);
    }
    None
}

/// Whether the text at a command position names a guarded command.
fn guarded_command_at(rest: &str) -> bool {
    let lower = rest.to_lowercase();
    let trimmed = lower.trim_start();
    // Strip a leading assignment (`X=Y `) or wrapper (`env/command/exec/busybox`).
    let candidate = strip_prefixes(trimmed);
    let candidate = candidate.trim_start();

    // Recursive or forced deletion.
    if candidate.starts_with("rm") && rm_has_force_recursive(candidate) {
        return true;
    }
    if candidate.starts_with("find") && find_is_deleting(candidate) {
        return true;
    }
    if candidate.starts_with("shred") {
        return true;
    }
    // Partition/filesystem tools.
    for tool in [
        "mkfs",
        "mke2fs",
        "fdisk",
        "sfdisk",
        "gdisk",
        "parted",
        "sgdisk",
        "wipefs",
        "blkdiscard",
    ] {
        if candidate.starts_with(tool) && is_command_word(candidate, tool) {
            return true;
        }
    }
    // Raw copies, flash/MTD and bootloader tooling.
    if candidate.starts_with("dd") && is_command_word(candidate, "dd") {
        return true;
    }
    for tool in [
        "flash_erase",
        "nandwrite",
        "ubiformat",
        "mtd_debug",
        "flashrom",
        "fw_setenv",
        "esptool",
        "openocd",
        "fastboot",
        "rkdeveloptool",
        "dfu-util",
        "stm32flash",
        "avrdude",
    ] {
        if candidate.starts_with(tool) && is_command_word(candidate, tool) {
            return true;
        }
    }
    // Privilege escalation.
    for tool in ["sudo", "doas", "su"] {
        if candidate.starts_with(tool) && is_command_word(candidate, tool) {
            return true;
        }
    }
    // Recursive permission/ownership or immutable-attribute changes.
    if (candidate.starts_with("chmod")
        || candidate.starts_with("chown")
        || candidate.starts_with("chgrp"))
        && chmod_is_recursive(candidate)
    {
        return true;
    }
    if candidate.starts_with("chattr") && is_command_word(candidate, "chattr") {
        return true;
    }
    if candidate.starts_with("setfacl") && is_command_word(candidate, "setfacl") {
        return true;
    }
    false
}

/// Strip assignment and wrapper prefixes (`X=Y `, `env `, `command `, `exec `,
/// `busybox `, with optional flags), matching the web's `COMMAND_START`.
fn strip_prefixes(s: &str) -> &str {
    let mut rest = s;
    loop {
        let changed = rest;
        // assignment: `name=value ` (no whitespace in the value token)
        if let Some((name, after)) = rest.split_once('=') {
            if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                if let Some((value, tail)) = after.split_once(char::is_whitespace) {
                    let _ = value;
                    rest = tail.trim_start();
                    continue;
                }
            }
        }
        // wrapper: `env`/`command`/`exec`/`busybox` with optional flags
        for wrapper in ["env", "command", "exec", "busybox"] {
            if let Some(after) = rest.strip_prefix(wrapper) {
                if after.starts_with(char::is_whitespace) {
                    rest = after.trim_start();
                    // Skip flags like `--` or `-x`.
                    while rest.starts_with('-') {
                        let token_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                        rest = rest[token_end..].trim_start();
                    }
                    continue;
                }
            }
        }
        if std::ptr::eq(changed, rest) {
            break;
        }
    }
    rest
}

/// Whether `candidate` begins with `word` as a whole command word (followed by
/// whitespace, a flag, or end).
fn is_command_word(candidate: &str, word: &str) -> bool {
    candidate.strip_prefix(word).is_some_and(|after| {
        after.is_empty() || after.starts_with(char::is_whitespace) || after.starts_with('-')
    })
}

/// `rm … -r` / `rm … -f` / `rm … --recursive` — the web's
/// `rm\b[^\n]*\s-{1,2}[a-z]*[rf]`.
///
/// Every flag token is looked at, not just the first: `rm --force -r /` and
/// `rm -i -rf /` are the same command as `rm -rf /`, and a guard that reads
/// only the first dash is a guard those spellings walk straight past.
fn rm_has_force_recursive(candidate: &str) -> bool {
    for token in candidate.split_whitespace() {
        let Some(flags) = token.strip_prefix('-') else {
            continue;
        };
        // A long flag spells the letter out and a short cluster is letters by
        // definition; either way the guard is looking for the two letters the
        // web regex is looking for.
        if flags.contains('r') || flags.contains('f') {
            return true;
        }
    }
    false
}

/// `find … -delete` / `find … -exec rm`.
fn find_is_deleting(candidate: &str) -> bool {
    candidate.contains("-delete") || candidate.contains("-exec") && candidate.contains("rm")
}

/// `chmod/chown/chgrp … -r` / `--recursive`.
fn chmod_is_recursive(candidate: &str) -> bool {
    if candidate.contains("--recursive") {
        return true;
    }
    // a flag cluster with `r`
    for token in candidate.split_whitespace() {
        if let Some(flags) = token.strip_prefix('-') {
            if !flags.is_empty()
                && flags.chars().all(|c| c.is_ascii_alphabetic())
                && flags.contains('r')
            {
                return true;
            }
        }
    }
    false
}

/// The position-independent pipeline guards.
fn guarded_pipeline_matches(text: &str) -> bool {
    let lower = text.to_lowercase();
    // > /dev/sdX|mmcblkX|nvmeX|mtdblockX|loopX|diskX (whitespace around `>`).
    let devices = ["sd", "mmcblk", "nvme", "mtdblock", "loop", "disk"];
    // Find `>` followed by optional spaces then `/dev/<device>`.
    for (i, _) in lower.match_indices('>') {
        let after = lower[i + 1..].trim_start();
        if let Some(rest) = after.strip_prefix("/dev/") {
            if devices.iter().any(|d| rest.starts_with(d)) {
                return true;
            }
        }
    }
    // curl|wget|fetch … | sh|bash|…
    if (lower.contains("curl") || lower.contains("wget") || lower.contains("fetch"))
        && lower.contains('|')
        && lower.split('|').next_back().is_some_and(|tail| {
            let t = tail.trim_start();
            ["sh", "bash", "ash", "dash", "zsh", "ksh"]
                .iter()
                .any(|sh| t.starts_with(sh) || t.starts_with(&format!("sudo {sh}")))
        })
    {
        return true;
    }
    // base64 -d … | sh|bash|…
    if lower.contains("base64")
        && (lower.contains("-d") || lower.contains("--decode"))
        && lower.contains('|')
        && lower.split('|').next_back().is_some_and(|tail| {
            let t = tail.trim_start();
            ["sh", "bash", "ash", "dash", "zsh"]
                .iter()
                .any(|sh| t.starts_with(sh))
        })
    {
        return true;
    }
    false
}

/// The mode prompt text, matching the web's `executionModePrompt`.
pub fn execution_mode_prompt(mode: ExecutionMode) -> &'static str {
    match mode {
        ExecutionMode::FullAuto => "Execution mode: Full Auto. The user authorizes direct serial execution without confirmation, except for destructive or irreversible commands, which always require their explicit approval: recursive or forced deletion, partition/filesystem tools, dd and raw device writes, flash/bootloader tooling, piping downloaded content into a shell, privilege escalation, and recursive permission changes. Unrelated text that merely mentions those tools is not affected. If such a command needs approval, ask the user instead of looking for a way around the rule.",
        ExecutionMode::Auto => "Execution mode: Auto (recommended). The app automatically sends only exact allowlisted low-risk queries on a clear input line with a currently recognized shell prompt. All other input requires user approval. Destructive or irreversible commands always require approval in every mode. Do not assume shell queries are suitable until logs establish the target console state.",
        ExecutionMode::Manual => "Execution mode: Manual. Propose commands with send_serial_input; nothing is sent until the user clicks Send.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destructive_commands_are_guarded_in_every_mode() {
        for mode in [
            ExecutionMode::Auto,
            ExecutionMode::Manual,
            ExecutionMode::FullAuto,
        ] {
            assert!(requires_input_approval(
                mode,
                "rm -rf /",
                "rm -rf /\r",
                false,
                true,
                None
            ));
            // The same command spelled the long way, and spelled with the
            // force flag second: a guard that reads only the first dash is a
            // guard these walk past.
            assert!(requires_input_approval(
                mode,
                "rm --force --recursive /",
                "rm --force --recursive /\r",
                false,
                true,
                None
            ));
            assert!(requires_input_approval(
                mode,
                "rm -i -rf /",
                "rm -i -rf /\r",
                false,
                true,
                None
            ));
            assert!(requires_input_approval(
                mode,
                "dd if=/dev/zero of=/dev/sda",
                "dd if=/dev/zero of=/dev/sda\r",
                false,
                true,
                None
            ));
            assert!(requires_input_approval(
                mode,
                "sudo reboot",
                "sudo reboot\r",
                false,
                true,
                None
            ));
        }
    }

    #[test]
    fn low_risk_queries_pass_in_auto() {
        assert!(!requires_input_approval(
            ExecutionMode::Auto,
            "df -h",
            "df -h\r",
            false,
            true,
            None
        ));
        assert!(!requires_input_approval(
            ExecutionMode::Auto,
            "uname -a",
            "uname -a\r",
            false,
            true,
            None
        ));
        assert!(!requires_input_approval(
            ExecutionMode::Auto,
            "ls -la",
            "ls -la\n",
            false,
            true,
            None
        ));
    }

    #[test]
    fn non_query_commands_need_approval_in_auto() {
        assert!(requires_input_approval(
            ExecutionMode::Auto,
            "echo hello",
            "echo hello\r",
            false,
            true,
            None
        ));
        assert!(requires_input_approval(
            ExecutionMode::Auto,
            "reboot",
            "reboot\r",
            false,
            true,
            None
        ));
    }

    #[test]
    fn pending_input_or_no_newline_forces_approval() {
        assert!(requires_input_approval(
            ExecutionMode::Auto,
            "df -h",
            "df -h\r",
            true,
            true,
            None
        ));
        assert!(requires_input_approval(
            ExecutionMode::Auto,
            "df -h",
            "df -h",
            false,
            false,
            None
        ));
    }

    #[test]
    fn full_auto_sends_non_destructive_unattended() {
        assert!(!requires_input_approval(
            ExecutionMode::FullAuto,
            "reboot",
            "reboot\r",
            false,
            true,
            None
        ));
        assert!(!requires_input_approval(
            ExecutionMode::FullAuto,
            "echo hi",
            "echo hi\r",
            false,
            true,
            None
        ));
    }

    #[test]
    fn manual_always_asks() {
        assert!(requires_input_approval(
            ExecutionMode::Manual,
            "df -h",
            "df -h\r",
            false,
            true,
            None
        ));
    }

    #[test]
    fn the_always_ask_list_outranks_full_auto() {
        let policy = Policy {
            always_ask: vec!["reboot".to_string()],
            allow: Vec::new(),
        };
        assert!(requires_input_approval(
            ExecutionMode::FullAuto,
            "reboot",
            "reboot\r",
            false,
            true,
            Some(&policy)
        ));
    }

    #[test]
    fn the_allow_list_grants_auto_for_exact_commands() {
        let policy = Policy {
            always_ask: Vec::new(),
            allow: vec!["git status".to_string()],
        };
        assert!(!requires_input_approval(
            ExecutionMode::Auto,
            "git status",
            "git status\r",
            false,
            true,
            Some(&policy)
        ));
        assert!(requires_input_approval(
            ExecutionMode::Auto,
            "git log",
            "git log\r",
            false,
            true,
            Some(&policy)
        ));
    }

    #[test]
    fn guarded_commands_match_at_command_positions_only() {
        // "rm" mentioned in an argument is not a command.
        assert!(!is_guarded_command("echo rm -rf /"));
        assert!(is_guarded_command("rm -rf /"));
        assert!(is_guarded_command("cd /tmp; rm -rf /"));
        assert!(is_guarded_command("sh -c 'rm -rf /'"));
    }

    /// The wrapper is found whatever case it was typed in, and the search
    /// never cuts a character in half to do it.
    ///
    /// The offsets used to come from a `to_lowercase` copy of the text, and a
    /// character whose lowercase is longer than itself — `İ`, two bytes
    /// folded to three — moved every offset after it, so a command the guard
    /// was asked about could panic it instead of answering.
    #[test]
    fn the_sh_c_wrapper_is_found_in_any_case_and_whole() {
        assert!(is_guarded_command("SH -c 'rm -rf /'"));
        assert!(is_guarded_command("Bash -C \"rm -rf /\""));
        assert!(
            !is_guarded_command("İsh -c"),
            "a command that only looks like a wrapper is not one"
        );
        assert!(!is_guarded_command("İİİİİİ sh -c x"));
        assert!(
            !is_guarded_command("echo ㄱsh -c x"),
            "a wide letter is not an s"
        );
    }

    #[test]
    fn guarded_pipelines_match_position_independently() {
        assert!(is_guarded_command("curl https://x | sh"));
        assert!(is_guarded_command("base64 -d payload | bash"));
        assert!(is_guarded_command("cat x > /dev/sda"));
    }

    #[test]
    fn mere_mentions_of_tools_are_not_guarded() {
        assert!(!is_guarded_command("echo sudo is useful"));
        assert!(!is_guarded_command("cat /proc/version"));
        // The profile probe runs `for t in … sudo systemctl …` and must stay unattended.
        assert!(!is_guarded_command(
            "for t in sh curl sudo systemctl; do command -v \"$t\"; done"
        ));
    }

    #[test]
    fn the_mode_prompts_exist() {
        assert!(execution_mode_prompt(ExecutionMode::FullAuto).contains("Full Auto"));
        assert!(execution_mode_prompt(ExecutionMode::Auto).contains("Auto"));
        assert!(execution_mode_prompt(ExecutionMode::Manual).contains("Manual"));
    }
}
