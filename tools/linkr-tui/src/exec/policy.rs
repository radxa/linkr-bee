//! Per-target command policy (`web/command_policy.js`).
//!
//! Entries stay on the device: they are never part of a model request and never
//! appear in an exported report.

pub const POLICY_KEY: &str = "linkr-agent-command-policy-v1";
pub const POLICY_ENTRY_LIMIT: usize = 20;
pub const POLICY_ENTRY_MAX_CHARS: usize = 200;

/// A normalized command policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Policy {
    /// Commands that always need explicit approval, in every mode.
    pub always_ask: Vec<String>,
    /// Exact commands that may be sent unattended in Auto mode.
    pub allow: Vec<String>,
}

fn normalize_entry(value: &str) -> Result<String, String> {
    let text = value.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    if text.len() > POLICY_ENTRY_MAX_CHARS {
        return Err(format!(
            "A command policy entry is limited to {POLICY_ENTRY_MAX_CHARS} characters."
        ));
    }
    if text.chars().any(|c| c.is_control()) {
        return Err("A command policy entry must not contain control characters.".to_string());
    }
    Ok(text.to_string())
}

/// Normalize a policy: trim entries, drop empty and duplicate entries
/// (case-insensitively), and enforce the entry cap.
pub fn normalize_policy(policy: &Policy) -> Result<Policy, String> {
    let clean = |list: &[String]| -> Result<Vec<String>, String> {
        let mut entries: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for value in list {
            let text = normalize_entry(value)?;
            let key = text.to_lowercase();
            if text.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            entries.push(text);
        }
        if entries.len() > POLICY_ENTRY_LIMIT {
            return Err(format!(
                "A command policy list holds at most {POLICY_ENTRY_LIMIT} entries."
            ));
        }
        Ok(entries)
    };
    Ok(Policy {
        always_ask: clean(&policy.always_ask)?,
        allow: clean(&policy.allow)?,
    })
}

/// Parse a policy list from one-entry-per-line text (how the panel edits both
/// lists).
pub fn parse_policy_list(text: &str) -> Result<Vec<String>, String> {
    let lines: Vec<String> = text
        .split('\n')
        .map(|l| l.trim_end_matches('\r').to_string())
        .collect();
    let policy = Policy {
        always_ask: lines,
        allow: Vec::new(),
    };
    Ok(normalize_policy(&policy)?.always_ask)
}

/// Format a policy list as one entry per line.
pub fn format_policy_list(entries: &[String]) -> String {
    entries.join("\n")
}

/// Whether any entry is a (case-insensitive) substring of `text`.
pub fn policy_matches(entries: &[String], text: &str) -> bool {
    let value = text.to_lowercase();
    entries
        .iter()
        .any(|entry| !entry.is_empty() && value.contains(&entry.to_lowercase()))
}

/// Whether any of the given texts matches the `alwaysAsk` list.
pub fn is_always_ask(entries: &[String], texts: &[&str]) -> bool {
    texts.iter().any(|text| policy_matches(entries, text))
}

/// Whether a command is exactly present in the `allow` list.
pub fn is_pre_approved(entries: &[String], command: &str) -> bool {
    entries.iter().any(|entry| entry == command)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(always_ask: &[&str], allow: &[&str]) -> Policy {
        Policy {
            always_ask: always_ask.iter().map(|s| s.to_string()).collect(),
            allow: allow.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn normalizes_entries_and_drops_duplicates() {
        let p = normalize_policy(&policy(&[" reboot ", "REBOOT", "", "df -h"], &[])).unwrap();
        // "reboot " and "REBOOT" collapse to one entry (case-insensitive); the
        // empty entry is dropped; "df -h" is a distinct entry.
        assert_eq!(p.always_ask, vec!["reboot", "df -h"]);
    }

    #[test]
    fn enforces_the_entry_limit() {
        let many: Vec<String> = (0..25).map(|i| format!("cmd{i}")).collect();
        let p = Policy {
            always_ask: many,
            allow: Vec::new(),
        };
        assert!(normalize_policy(&p).is_err());
    }

    #[test]
    fn refuses_control_characters() {
        let p = policy(&["bad\x07cmd"], &[]);
        assert!(normalize_policy(&p).is_err());
    }

    #[test]
    fn parses_a_policy_list() {
        let list = parse_policy_list("rm -rf\n\n  reboot  \nrm -rf").unwrap();
        assert_eq!(list, vec!["rm -rf", "reboot"]);
        assert_eq!(format_policy_list(&list), "rm -rf\nreboot");
    }

    #[test]
    fn matches_are_case_insensitive_substrings() {
        assert!(policy_matches(&["reboot".to_string()], "sudo reboot now"));
        assert!(!policy_matches(&["reboot".to_string()], "echo hello"));
        assert!(is_always_ask(&["rm".to_string()], &["sudo rm -rf /"]));
        // Substring matching is deliberate (the web's `includes`): "echo rm"
        // still contains "rm", so it matches. That is the documented trade-off.
        assert!(is_always_ask(&["rm".to_string()], &["echo rm"]));
        assert!(!is_always_ask(&["rm -rf".to_string()], &["echo hello"]));
    }

    #[test]
    fn pre_approval_is_exact() {
        assert!(is_pre_approved(&["df -h".to_string()], "df -h"));
        assert!(!is_pre_approved(&["df -h".to_string()], "df -h /"));
        assert!(!is_pre_approved(&["df".to_string()], "df -h"));
    }
}
