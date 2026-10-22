//! The serial watch engine (`web/serial_watch.js`): an observation of untrusted
//! device text, never proof.
//!
//! A matched line says the target printed something that *looks like* a panic,
//! a reboot banner or a user pattern. It does not say the target is broken, that
//! a boot loop is running, or that a command failed. Callers show the raw
//! evidence and let the user judge. No function here is named "detect" or
//! "verify" for that reason.
//!
//! Pure by construction: no clock, no I/O. The caller feeds text and supplies a
//! timestamp, so behaviour is deterministic in tests and the engine can be
//! reused anywhere.

// --- bounds ----------------------------------------------------------------

/// The longest unfinished line kept before older characters are dropped.
const MAX_LINE_CHARS: usize = 1024;
/// The hard cap on retained findings.
const MAX_FINDINGS: usize = 200;
/// The hard cap on caller-supplied patterns.
const MAX_PATTERNS: usize = 64;
/// The cap on boot-banner observations in the loop window.
const MAX_BOOT_HISTORY: usize = 64;
/// The characters kept per finding's evidence line.
const MAX_EVIDENCE: usize = 240;

const DEFAULT_BOOT_LOOP_THRESHOLD: usize = 3;
const DEFAULT_BOOT_LOOP_WINDOW_MS: i64 = 120_000;

// --- rules ------------------------------------------------------------------

/// A built-in panic-like rule. Matching is a case-insensitive literal substring,
/// never a regex.
#[derive(Debug, Clone)]
pub struct Rule {
    pub id: String,
    pub text: String,
    pub label: String,
    pub kind: RuleKind,
}

/// Whether a rule reports a panic-like event or a boot banner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleKind {
    Panic,
    Boot,
}

/// The built-in panic rules, most specific first.
const PANIC_PATTERNS: [(&str, &str, &str); 10] = [
    ("watchdog-bug", "watchdog: BUG", "Watchdog reported a bug"),
    ("kernel-panic", "Kernel panic", "Kernel panic message"),
    ("oops", "Oops:", "Kernel oops report"),
    ("bug", "BUG: ", "Kernel BUG warning"),
    ("oom", "Out of memory", "Kernel out-of-memory report"),
    ("oom-kill", "oom-kill", "OOM killer invoked"),
    (
        "null-deref",
        "Unable to handle kernel NULL pointer dereference",
        "Kernel NULL pointer dereference",
    ),
    ("segfault", "segfault at", "Userspace segmentation fault"),
    ("hardware-error", "Hardware Error", "Hardware error report"),
    ("cpu-warning", "WARNING: CPU", "Kernel CPU warning"),
];

/// The boot-banner rules.
const BOOT_PATTERNS: [(&str, &str, &str); 4] = [
    ("u-boot", "U-Boot ", "Bootloader banner"),
    ("linux-version", "Linux version ", "Linux kernel banner"),
    ("booting-linux", "Booting Linux", "Linux boot message"),
    (
        "starting-kernel",
        "Starting kernel",
        "Kernel handoff message",
    ),
];

/// One observed finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// `panic`, `boot-loop` or `pattern`.
    pub kind: FindingKind,
    pub id: String,
    pub label: String,
    /// The 1-based line number the finding was raised on.
    pub line: usize,
    /// The timestamp supplied by the caller.
    pub at: i64,
    /// How many times the same finding has been observed.
    pub count: usize,
    /// The evidence excerpt.
    pub evidence: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FindingKind {
    Panic,
    BootLoop,
    Pattern,
}

/// A caller-supplied literal pattern. `id` de-duplicates; `text` is matched
/// case-insensitively; `label` falls back to `text`.
#[derive(Debug, Clone)]
pub struct Pattern {
    pub id: String,
    pub text: String,
    pub label: Option<String>,
}

/// The watch engine itself.
pub struct SerialWatch {
    rules: Vec<Rule>,
    caller_rules: Vec<Rule>,
    max_findings: usize,
    boot_loop_threshold: usize,
    boot_loop_window_ms: i64,
    findings: Vec<(Finding, String)>, // (finding, dedup key)
    buffered: String,
    /// Bytes of an incomplete character, held across reads: a chunk boundary
    /// in the middle of a multi-byte character is ordinary on every link.
    carry: Vec<u8>,
    lines: usize,
    dropped: usize,
    boot_count: usize,
    boot_loop: BootLoop,
}

#[derive(Default)]
struct BootLoop {
    times: Vec<i64>,
    banners: Vec<String>,
    bursts: std::collections::HashMap<String, bool>,
    failed: bool,
    last_at: Option<i64>,
}

/// Boot-loop options.
#[derive(Debug, Clone)]
pub struct BootLoopOptions {
    /// How many banners in the window before a boot loop is reported.
    pub threshold: usize,
    /// The window width in milliseconds.
    pub window_ms: i64,
}

impl Default for BootLoopOptions {
    fn default() -> Self {
        BootLoopOptions {
            threshold: DEFAULT_BOOT_LOOP_THRESHOLD,
            window_ms: DEFAULT_BOOT_LOOP_WINDOW_MS,
        }
    }
}

/// What a `{:?}` of the engine is worth: how much it has seen and what it
/// thinks is wrong. Hand-written rather than derived so that printing an
/// engine a hundred thousand lines into a session says something readable
/// about the target rather than dumping the whole evidence set.
impl std::fmt::Debug for SerialWatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SerialWatch")
            .field("lines", &self.lines)
            .field("findings", &self.findings.len())
            .field("boot_count", &self.boot_count)
            .finish()
    }
}

/// Watch configuration.
#[derive(Debug, Clone, Default)]
pub struct WatchOptions {
    pub patterns: Vec<Pattern>,
    pub boot_loop: BootLoopOptions,
    pub max_findings: usize,
}

/// A snapshot of the engine for the UI.
#[derive(Debug, Clone, Default)]
pub struct WatchSnapshot {
    pub findings: Vec<Finding>,
    pub lines: usize,
    pub boot_count: usize,
    pub buffered: usize,
    pub dropped: usize,
}

impl SerialWatch {
    pub fn new(options: WatchOptions) -> Self {
        let mut rules: Vec<Rule> = PANIC_PATTERNS
            .iter()
            .map(|(id, text, label)| Rule {
                id: id.to_string(),
                text: text.to_string(),
                label: label.to_string(),
                kind: RuleKind::Panic,
            })
            .collect();
        rules.extend(BOOT_PATTERNS.iter().map(|(id, text, label)| Rule {
            id: id.to_string(),
            text: text.to_string(),
            label: label.to_string(),
            kind: RuleKind::Boot,
        }));

        // Caller patterns, de-duplicated against built-in ids and each other.
        let built_in_ids: std::collections::HashSet<String> =
            rules.iter().map(|r| r.id.clone()).collect();
        let mut caller_rules: Vec<Rule> = Vec::new();
        let mut seen: std::collections::HashSet<String> = built_in_ids;
        for pattern in options.patterns {
            if caller_rules.len() >= MAX_PATTERNS {
                break;
            }
            let id = pattern.id.trim().to_string();
            let text = pattern.text.clone();
            if id.is_empty() || text.is_empty() || seen.contains(&id) {
                continue;
            }
            seen.insert(id.clone());
            let label = pattern
                .label
                .clone()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| text.clone());
            caller_rules.push(Rule {
                id,
                text,
                label,
                kind: RuleKind::Panic,
            });
        }

        let max_findings = options.max_findings.clamp(1, MAX_FINDINGS);
        SerialWatch {
            rules,
            caller_rules,
            max_findings,
            boot_loop_threshold: options.boot_loop.threshold.clamp(1, 1000),
            boot_loop_window_ms: options.boot_loop.window_ms.clamp(1, 3_600_000),
            findings: Vec::new(),
            buffered: String::new(),
            carry: Vec::new(),
            lines: 0,
            dropped: 0,
            boot_count: 0,
            boot_loop: BootLoop::default(),
        }
    }

    /// Feed decoded text. Incomplete lines are buffered; only complete lines are
    /// evaluated. Returns the findings produced by *this* call.
    pub fn feed(&mut self, text: &str, at: i64) -> Vec<Finding> {
        let mut produced = Vec::new();
        let mut start = 0;
        for (index, ch) in text.char_indices() {
            if ch != '\n' && ch != '\r' {
                continue;
            }
            // Treat CRLF as one terminator; a lone CR still ends a line.
            if ch == '\r' {
                if let Some(next) = text[index + ch.len_utf8()..].chars().next() {
                    if next == '\n' {
                        continue;
                    }
                }
            }
            let line: String = self
                .buffered
                .chars()
                .chain(text[start..index].chars())
                .collect();
            self.buffered.clear();
            start = index + ch.len_utf8();
            self.lines += 1;
            let findings = self.evaluate_line(&line, at);
            for f in findings {
                produced.push(f);
            }
        }
        if start < text.len() {
            let rest: String = self.buffered.chars().chain(text[start..].chars()).collect();
            let rest_len = rest.chars().count();
            if rest_len > MAX_LINE_CHARS {
                self.dropped += rest_len - MAX_LINE_CHARS;
                self.buffered = rest
                    .chars()
                    .rev()
                    .take(MAX_LINE_CHARS)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            } else {
                self.buffered = rest;
            }
        }
        produced
    }

    /// Feed raw bytes as UTF-8. Split multi-byte sequences are held across calls
    /// rather than turned into replacement characters.
    pub fn feed_bytes(&mut self, bytes: &[u8], at: i64) -> Vec<Finding> {
        // A multi-byte character can straddle two reads — BLE and LAN both hand
        // over whatever arrived, and a boundary inside a `…` is ordinary. The
        // unfinished tail waits here for the rest of itself, rather than
        // becoming two replacement characters that both mangle the text and
        // hide the line's real content from the rules.
        let mut chunk = std::mem::take(&mut self.carry);
        chunk.extend_from_slice(bytes);
        let text = match std::str::from_utf8(&chunk) {
            Ok(text) => {
                let text = text.to_string();
                chunk.clear();
                text
            }
            Err(error) if error.error_len().is_none() => {
                // Only the last character is incomplete: decode what is whole
                // and keep the rest for the next call.
                let (whole, rest) = chunk.split_at(error.valid_up_to());
                let text = String::from_utf8_lossy(whole).into_owned();
                self.carry = rest.to_vec();
                text
            }
            Err(_) => {
                // Genuinely invalid bytes: replacement characters are the
                // honest reading, and the one the web client shows too.
                let text = String::from_utf8_lossy(&chunk).into_owned();
                chunk.clear();
                text
            }
        };
        self.feed(&text, at)
    }

    /// Retained findings, oldest first.
    pub fn findings(&self) -> Vec<Finding> {
        self.findings.iter().map(|(f, _)| f.clone()).collect()
    }

    /// Drop findings and buffered input, keep counters and rules.
    pub fn clear(&mut self) -> WatchSnapshot {
        self.findings.clear();
        self.buffered.clear();
        self.carry.clear();
        self.dropped = 0;
        self.boot_loop = BootLoop::default();
        self.snapshot()
    }

    /// Full reset: findings, counters and buffered input.
    pub fn reset(&mut self) -> WatchSnapshot {
        // Rebuild from a fresh engine, keeping the configured rules.
        let rules = std::mem::take(&mut self.rules);
        let caller = std::mem::take(&mut self.caller_rules);
        let max = self.max_findings;
        let threshold = self.boot_loop_threshold;
        let window = self.boot_loop_window_ms;
        let mut fresh = SerialWatch {
            rules,
            caller_rules: caller,
            max_findings: max,
            boot_loop_threshold: threshold,
            boot_loop_window_ms: window,
            findings: Vec::new(),
            buffered: String::new(),
            carry: Vec::new(),
            lines: 0,
            dropped: 0,
            boot_count: 0,
            boot_loop: BootLoop::default(),
        };
        std::mem::swap(self, &mut fresh);
        self.snapshot()
    }

    /// A plain-data view for the UI.
    pub fn snapshot(&self) -> WatchSnapshot {
        WatchSnapshot {
            findings: self.findings(),
            lines: self.lines,
            boot_count: self.boot_count,
            buffered: self.buffered.chars().count(),
            dropped: self.dropped,
        }
    }

    /// Evaluate one complete line and return any new findings.
    fn evaluate_line(&mut self, line: &str, at: i64) -> Vec<Finding> {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let evidence = crate::text::tail_chars(line, MAX_EVIDENCE);
        let lower = line.to_lowercase();
        let mut found = Vec::new();
        let mut reported = false;
        let line_number = self.lines;

        let all_rules: Vec<Rule> = self
            .rules
            .iter()
            .cloned()
            .chain(self.caller_rules.iter().cloned())
            .collect();

        for rule in &all_rules {
            if !lower.contains(&rule.text.to_lowercase()) {
                continue;
            }
            if rule.kind == RuleKind::Boot {
                self.boot_count += 1;
                if let Some(f) = self.observe_boot(rule, line_number, at, &evidence) {
                    found.push(f);
                }
                continue;
            }
            // A finding other than a boot banner — a panic, or a caller
            // pattern — breaks the boot burst: the device got somewhere it
            // should not have, which is not a loop through its boots.
            self.boot_loop.failed = true;
            if reported {
                // One line answers once: the first rule that speaks for the
                // line does, and a second match is the same event told twice.
                continue;
            }
            let kind = if self.caller_rules.iter().any(|r| r.id == rule.id) {
                FindingKind::Pattern
            } else {
                FindingKind::Panic
            };
            if let Some(f) = self.observe_rule(rule, kind, line_number, at, &evidence) {
                reported = true;
                found.push(f);
            }
        }
        found
    }

    fn observe_rule(
        &mut self,
        rule: &Rule,
        kind: FindingKind,
        line_number: usize,
        at: i64,
        evidence: &str,
    ) -> Option<Finding> {
        let key = if kind == FindingKind::Pattern {
            format!("pattern:{}", rule.id)
        } else {
            format!("panic:{}:{}", rule.id, evidence)
        };
        if let Some((existing, _)) = self.findings.iter_mut().find(|(_, k)| k == &key) {
            existing.count += 1;
            existing.at = at;
            return None;
        }
        let finding = Finding {
            kind,
            id: rule.id.to_string(),
            label: rule.label.to_string(),
            line: line_number,
            at,
            count: 1,
            evidence: evidence.to_string(),
        };
        self.remember(finding.clone(), key);
        Some(finding)
    }

    fn observe_boot(
        &mut self,
        rule: &Rule,
        line_number: usize,
        at: i64,
        evidence: &str,
    ) -> Option<Finding> {
        if self.boot_loop.failed {
            self.boot_loop.times.clear();
            self.boot_loop.banners.clear();
            for v in self.boot_loop.bursts.values_mut() {
                *v = false;
            }
            self.boot_loop.failed = false;
        }
        let stale = self
            .boot_loop
            .last_at
            .is_some_and(|last| at - last > self.boot_loop_window_ms);
        if stale {
            for v in self.boot_loop.bursts.values_mut() {
                *v = false;
            }
        }
        self.boot_loop.last_at = Some(at);

        let dropped = push_banner(
            &mut self.boot_loop,
            at,
            &format!("{evidence} (line {line_number})"),
            self.boot_loop_window_ms,
        );
        if dropped {
            for v in self.boot_loop.bursts.values_mut() {
                *v = false;
            }
        }

        let reported = *self
            .boot_loop
            .bursts
            .entry(rule.id.to_string())
            .or_insert(false);
        if self.boot_loop.times.len() < self.boot_loop_threshold {
            return None;
        }
        if reported {
            return None;
        }
        let evidence_text = self
            .boot_loop
            .banners
            .iter()
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ");
        let key = format!("boot-loop:{}", rule.id);
        if let Some((existing, _)) = self.findings.iter_mut().find(|(_, k)| k == &key) {
            existing.count += 1;
            existing.at = at;
            if evidence_text != existing.evidence {
                existing.evidence = crate::text::tail_chars(&evidence_text, MAX_EVIDENCE);
            }
            self.boot_loop.bursts.insert(rule.id.to_string(), true);
            return None;
        }
        let finding = Finding {
            kind: FindingKind::BootLoop,
            id: rule.id.to_string(),
            label: rule.label.to_string(),
            line: line_number,
            at,
            count: self.boot_loop.times.len(),
            evidence: crate::text::tail_chars(&evidence_text, MAX_EVIDENCE),
        };
        self.remember(finding.clone(), key);
        self.boot_loop.bursts.insert(rule.id.to_string(), true);
        Some(finding)
    }

    fn remember(&mut self, finding: Finding, key: String) {
        self.findings.push((finding, key));
        if self.findings.len() > self.max_findings {
            let excess = self.findings.len() - self.max_findings;
            self.findings.drain(0..excess);
        }
    }
}

fn push_banner(loop_state: &mut BootLoop, at: i64, text: &str, window_ms: i64) -> bool {
    loop_state.times.push(at);
    loop_state.banners.push(text.to_string());
    if loop_state.times.len() > MAX_BOOT_HISTORY {
        let excess = loop_state.times.len() - MAX_BOOT_HISTORY;
        loop_state.times.drain(0..excess);
        loop_state.banners.drain(0..excess);
    }
    let mut dropped = false;
    while loop_state.times.len() > 1 && at - loop_state.times[0] > window_ms {
        loop_state.times.remove(0);
        loop_state.banners.remove(0);
        dropped = true;
    }
    dropped
}

/// A short status-line sentence per finding, in English or Chinese.
pub fn describe_findings(findings: &[Finding], lang: &str) -> Vec<String> {
    let chinese = lang.starts_with("zh");
    findings
        .iter()
        .map(|f| {
            let label = if chinese {
                zh_label(&f.id).unwrap_or(&f.label).to_string()
            } else {
                f.label.clone()
            };
            match f.kind {
                FindingKind::BootLoop => {
                    if chinese {
                        format!("观察窗口内出现 {} 次{}，设备可能在稳定前反复重启：{}", f.count, label, f.evidence)
                    } else {
                        format!("Observed {label} {} times within the watch window; the target may be restarting before it settles: {}", f.count, f.evidence)
                    }
                }
                _ => {
                    if chinese {
                        format!("第 {} 行出现{}：{}", f.line, label, f.evidence)
                    } else {
                        format!("Observed {label} at line {}: {}", f.line, f.evidence)
                    }
                }
            }
        })
        .collect()
}

/// Whether any retained finding is a boot-loop observation.
pub fn is_boot_loop_hint(findings: &[Finding]) -> bool {
    findings.iter().any(|f| f.kind == FindingKind::BootLoop)
}

fn zh_label(id: &str) -> Option<&'static str> {
    Some(match id {
        "kernel-panic" => "内核崩溃信息",
        "oops" => "内核 oops 报告",
        "bug" => "内核 BUG 警告",
        "oom" => "内核内存耗尽报告",
        "oom-kill" => "OOM 终止进程",
        "watchdog-bug" => "看门狗 BUG 报告",
        "null-deref" => "内核空指针解引用",
        "segfault" => "用户态段错误",
        "hardware-error" => "硬件错误报告",
        "cpu-warning" => "内核 CPU 警告",
        "u-boot" => "引导程序启动横幅",
        "linux-version" => "Linux 内核启动横幅",
        "booting-linux" => "Linux 启动信息",
        "starting-kernel" => "内核交接信息",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch() -> SerialWatch {
        SerialWatch::new(WatchOptions {
            max_findings: 20,
            ..WatchOptions::default()
        })
    }

    #[test]
    fn a_kernel_panic_line_is_observed() {
        let mut w = watch();
        let found = w.feed(
            "Kernel panic - not syncing: Attempted to kill init!\n",
            1000,
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, FindingKind::Panic);
        assert_eq!(found[0].id, "kernel-panic");
        assert_eq!(found[0].line, 1);
    }

    #[test]
    fn a_specific_rule_wins_over_a_general_one() {
        let mut w = watch();
        let found = w.feed("watchdog: BUG: soft lockup\n", 1000);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "watchdog-bug");
    }

    /// The bytes of a character can arrive in two reads, and the engine holds
    /// the unfinished tail and joins it. Decoded lossily instead, the two
    /// halves become two replacement characters — the text is mangled *and*
    /// the rule that was watching for the word stops matching it.
    #[test]
    fn a_character_split_across_reads_is_joined() {
        let mut w = SerialWatch::new(WatchOptions {
            max_findings: 20,
            patterns: vec![Pattern {
                id: "no-memory".to_string(),
                text: "mémoire".to_string(),
                label: None,
            }],
            ..WatchOptions::default()
        });
        let line = "réserve: mémoire insuffisante\n";
        let bytes = line.as_bytes();
        let cut = line.find('é').expect("the accent is there") + 1;
        let first = w.feed_bytes(&bytes[..cut], 1000);
        assert!(first.is_empty(), "half a character is not a finding yet");
        let second = w.feed_bytes(&bytes[cut..], 1001);
        assert_eq!(second.len(), 1, "the word was joined across the reads");
        assert_eq!(second[0].id, "no-memory");
    }

    #[test]
    fn repeats_collapse_into_count() {
        let mut w = watch();
        w.feed("Kernel panic\n", 1000);
        w.feed("Kernel panic\n", 2000);
        assert_eq!(w.findings().len(), 1);
        assert_eq!(w.findings()[0].count, 2);
    }

    #[test]
    fn a_boot_loop_is_observed_after_the_threshold() {
        let mut w = watch();
        assert!(w.feed("U-Boot 2024.01\n", 0).is_empty());
        assert!(w.feed("Linux version 6.1\n", 100).is_empty());
        let found = w.feed("U-Boot 2024.01\n", 200);
        assert_eq!(
            found.len(),
            1,
            "the third banner in the window reports a loop"
        );
        assert_eq!(found[0].kind, FindingKind::BootLoop);
        assert!(is_boot_loop_hint(&w.findings()));
    }

    #[test]
    fn banners_outside_the_window_do_not_loop() {
        let mut w = watch();
        w.feed("U-Boot 2024.01\n", 0);
        w.feed("U-Boot 2024.01\n", 130_000); // beyond the 120s window
        assert!(!is_boot_loop_hint(&w.findings()));
    }

    #[test]
    fn caller_patterns_match_literally() {
        let mut w = SerialWatch::new(WatchOptions {
            patterns: vec![Pattern {
                id: "my-error".to_string(),
                text: "FOO ERROR".to_string(),
                label: Some("Custom error".to_string()),
            }],
            ..WatchOptions::default()
        });
        let found = w.feed("a FOO ERROR happened\n", 1000);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "my-error");
        assert_eq!(found[0].kind, FindingKind::Pattern);
        assert_eq!(found[0].label, "Custom error");
    }

    #[test]
    fn caller_patterns_are_never_regex() {
        let mut w = SerialWatch::new(WatchOptions {
            patterns: vec![Pattern {
                id: "dots".to_string(),
                text: "a.b".to_string(),
                label: None,
            }],
            ..WatchOptions::default()
        });
        // "axb" would match /a.b/ but not the literal "a.b".
        assert!(w.feed("axb\n", 1000).is_empty());
        assert_eq!(w.feed("a.b\n", 1000).len(), 1);
    }

    #[test]
    fn incomplete_lines_are_buffered_across_calls() {
        let mut w = watch();
        assert!(w.feed("Kernel pan", 1000).is_empty());
        let found = w.feed("ic\n", 1001);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "kernel-panic");
    }

    #[test]
    fn the_line_buffer_is_bounded() {
        let mut w = watch();
        w.feed(&"x".repeat(2000), 1000); // no newline: an over-long unfinished line
        assert!(w.snapshot().buffered <= MAX_LINE_CHARS);
        assert!(w.snapshot().dropped > 0);
    }

    #[test]
    fn describe_findings_localises() {
        let mut w = watch();
        w.feed("Kernel panic - not syncing\n", 1000);
        let en = describe_findings(&w.findings(), "en");
        let zh = describe_findings(&w.findings(), "zh-CN");
        assert!(en[0].starts_with("Observed "));
        assert!(zh[0].contains("内核崩溃信息"));
    }

    #[test]
    fn clear_keeps_rules_and_drops_findings() {
        let mut w = watch();
        w.feed("Kernel panic\n", 1000);
        w.clear();
        assert!(w.findings().is_empty());
        // The rule still fires after clear.
        assert_eq!(w.feed("Kernel panic\n", 2000).len(), 1);
    }
}
