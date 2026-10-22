//! Task summaries (`web/agent_tasks.js`).
//!
//! Only task summaries persist: no model settings, live tool calls, permissions
//! or keys. Each task is keyed by a device identity so a board's history is
//! scoped to that board.

use super::config::Storage;
use super::redact::redact_task_text;

pub const TASKS_KEY: &str = "linkr-agent-tasks-v1";

/// How many tasks one device keeps: the newest this many, oldest dropped
/// first. Counted per device rather than across the shelf, because the shelf
/// is shared by every board the program has been pointed at.
pub const TASKS_PER_DEVICE: usize = 20;

/// The identity a task is stored under: the verified target id when bound,
/// otherwise the transport/device/uart triple.
pub fn device_identity(
    transport: &str,
    device_id: Option<&str>,
    uart: Option<&str>,
    target_id: Option<&str>,
    target_verified: bool,
) -> Option<String> {
    if target_verified {
        return target_id.map(|id| format!("target:{id}"));
    }
    device_id.map(|id| serde_json_like_array(&[transport, id, uart.unwrap_or("")]))
}

/// Emit the JSON array `[a, b, c]` the way the web client does, without a JSON
/// dependency: three plain strings joined with the escaping the upstream relies
/// on (`JSON.stringify`). Identifiers are device ids/transports, so quoting
/// only needs to handle embedded quotes.
fn serde_json_like_array(parts: &[&str]) -> String {
    let quoted: Vec<String> = parts.iter().map(|p| json_string(p)).collect();
    format!("[{}]", quoted.join(","))
}

/// Write a value as a JSON string literal, escaping what JSON requires.
///
/// Backslash and quote were the whole of this until the transport arrived, and
/// that was a latent bug rather than a harmless one: a control character — a
/// newline, a tab, a stray `\x01` from someone's serial log — was written
/// raw, which is invalid JSON. The store's reader would then fail to parse the
/// file and lose *every* task in it, not the one with the newline. A task
/// summary redacted for length is exactly the kind of text that can still carry
/// a control byte.
///
/// `\n`, `\r`, `\t` keep their short forms because every reader understands
/// those and a `\u000a` in a hand-edited file is noise. Everything else below
/// `0x20` becomes `\uXXXX`, which is the only portable spelling.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if (other as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", other as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Quote a string as a JSON string literal (shared by all stores).
pub fn json_string(s: &str) -> String {
    json_escape(s)
}

/// A task summary record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRecord {
    pub id: String,
    pub device_key: String,
    pub updated_at: u64,
    pub goal: String,
    pub summary: String,
    pub status: String,
}

/// A plan step within a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStep {
    pub title: String,
    pub status: String,
    pub verification: String,
    pub next_action: String,
}

/// A task store backed by `Storage`. All reads are defensive: corrupt or
/// non-array data yields an empty store.
pub struct TaskStore<S: Storage> {
    storage: S,
}

impl<S: Storage> TaskStore<S> {
    pub fn new(storage: S) -> Self {
        TaskStore { storage }
    }

    fn read(&self) -> Vec<RawTask> {
        match self.storage.get(TASKS_KEY) {
            Some(raw) => serde_json_like_parse_tasks(&raw).unwrap_or_default(),
            None => Vec::new(),
        }
    }

    pub fn list(&self, device_key: &str) -> Vec<TaskRecord> {
        self.read()
            .into_iter()
            .filter(|t| t.device_key == device_key)
            .rev()
            .map(|t| TaskRecord {
                id: t.id,
                device_key: t.device_key,
                updated_at: t.updated_at,
                goal: t.goal,
                summary: t.summary,
                status: if t.status == "running" {
                    "interrupted".to_string()
                } else {
                    t.status
                },
            })
            .collect()
    }

    pub fn save(&mut self, task: &TaskRecord) {
        if task.device_key.is_empty() {
            return;
        }
        let item = RawTask {
            id: task.id.clone(),
            device_key: task.device_key.clone(),
            updated_at: task.updated_at,
            goal: redact_task_text(&task.goal),
            summary: redact_task_text(&task.summary),
            status: task.status.clone(),
        };
        let mut data = self.read();
        data.retain(|t| t.id != item.id);
        data.push(item);
        // The cap is per device. One shelf holds every board's history, so a
        // cap on the shelf would let the twentieth task on the board in hand
        // push the oldest task of a board that is not even connected off the
        // end — history the user never asked to lose.
        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut kept: Vec<RawTask> = Vec::new();
        for task in data.into_iter().rev() {
            let count = seen.entry(task.device_key.clone()).or_default();
            if *count < TASKS_PER_DEVICE {
                *count += 1;
                kept.push(task);
            }
        }
        kept.reverse();
        self.storage.set(TASKS_KEY, &serde_json_like_tasks(&kept));
    }

    pub fn clear(&mut self, device_key: &str) {
        let data = self.read();
        let kept: Vec<RawTask> = data
            .into_iter()
            .filter(|t| t.device_key != device_key)
            .collect();
        self.storage.set(TASKS_KEY, &serde_json_like_tasks(&kept));
    }
}

// A minimal, field-scoped JSON codec for the task store. Full JSON is out of
// scope for a zero-dependency crate, so we store exactly the fields the panel
// round-trips: id, deviceKey, updatedAt, goal, summary, status.

#[derive(Debug, Clone)]
struct RawTask {
    id: String,
    device_key: String,
    updated_at: u64,
    goal: String,
    summary: String,
    status: String,
}

fn serde_json_like_tasks(tasks: &[RawTask]) -> String {
    let items: Vec<String> = tasks
        .iter()
        .map(|t| {
            format!(
                "{{\"id\":{},\"deviceKey\":{},\"updatedAt\":{},\"goal\":{},\"summary\":{},\"status\":{}}}",
                json_string(&t.id),
                json_string(&t.device_key),
                t.updated_at,
                json_string(&t.goal),
                json_string(&t.summary),
                json_string(&t.status),
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

/// Parse the task array back out. Returns `None` on any malformation, which the
/// caller treats as an empty store (matching the upstream `try { } catch {}`).
fn serde_json_like_parse_tasks(raw: &str) -> Option<Vec<RawTask>> {
    parse_json_array(raw).map(|entries| {
        entries
            .into_iter()
            .filter_map(|obj| {
                let id = obj.get("id")?.clone();
                let device_key = obj.get("deviceKey")?.clone();
                let goal = obj.get("goal")?.clone();
                let summary = obj.get("summary")?.clone();
                let status = obj.get("status")?.clone();
                let updated_at = obj
                    .get("updatedAt")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                Some(RawTask {
                    id,
                    device_key,
                    updated_at,
                    goal,
                    summary,
                    status,
                })
            })
            .collect()
    })
}

/// A tiny JSON-object parser for flat `{"k":"v","k2":n}` records, shared by the
/// task and note stores.
pub fn parse_json_array(raw: &str) -> Option<Vec<std::collections::BTreeMap<String, String>>> {
    let raw = raw.trim();
    if !raw.starts_with('[') || !raw.ends_with(']') {
        return None;
    }
    let inner = &raw[1..raw.len() - 1];
    if inner.trim().is_empty() {
        return Some(Vec::new());
    }
    let mut out = Vec::new();
    for obj_str in split_top_level(inner, ',') {
        let obj = parse_json_object(obj_str)?;
        out.push(obj);
    }
    Some(out)
}

pub fn split_top_level(s: &str, sep: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut escape = false;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        if in_str {
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' | '[' => depth += 1,
            // Saturating: a stray closer in a hand-written line must not read
            // as one level deeper, which is what a wrapped `0 - 1` amount to.
            '}' | ']' => depth = depth.saturating_sub(1),
            c if c == sep && depth == 0 => {
                parts.push(&s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
}

fn parse_json_object(s: &str) -> Option<std::collections::BTreeMap<String, String>> {
    let s = s.trim();
    if !s.starts_with('{') || !s.ends_with('}') {
        return None;
    }
    let inner = &s[1..s.len() - 1];
    if inner.trim().is_empty() {
        return Some(Default::default());
    }
    let mut map = std::collections::BTreeMap::new();
    for pair in split_top_level(inner, ',') {
        let colon = find_top_level_colon(pair)?;
        let key = parse_json_string_literal(pair[..colon].trim())?;
        let value = parse_json_scalar(pair[colon + 1..].trim())?;
        map.insert(key, value);
    }
    Some(map)
}

pub fn find_top_level_colon(s: &str) -> Option<usize> {
    let mut in_str = false;
    let mut escape = false;
    for (i, c) in s.char_indices() {
        if in_str {
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            ':' => return Some(i),
            _ => {}
        }
    }
    None
}

fn parse_json_scalar(s: &str) -> Option<String> {
    if s.starts_with('"') {
        parse_json_string_literal(s)
    } else {
        // A number or literal; store its text.
        Some(s.to_string())
    }
}

pub fn parse_json_string_literal(s: &str) -> Option<String> {
    let s = s.trim();
    if !s.starts_with('"') || !s.ends_with('"') || s.len() < 2 {
        return None;
    }
    let body = &s[1..s.len() - 1];
    let mut out = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next()? {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                // The writer escapes every other control character as
                // `\uXXXX`. Without this arm the six characters came back as
                // text, and the next save escaped the backslash: a note grew
                // by one escape per round trip.
                'u' => match read_hex_escape(&mut chars) {
                    Some(ch) => out.push(ch),
                    // A malformed escape is left as the writer wrote it, which
                    // is this reader's habit for everything it cannot read.
                    None => out.push_str("\\u"),
                },
                other => {
                    out.push('\\');
                    out.push(other);
                }
            }
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// The four hex digits of a `\u` escape, and the low half of a surrogate pair
/// when the value is a high surrogate — `json_escape` writes one escape per
/// UTF-16 unit, so a character above the BMP arrives as two.
///
/// `None` for anything malformed, including a `\u` with no digits behind it.
fn read_hex_escape(chars: &mut std::str::Chars) -> Option<char> {
    let mut code = 0u32;
    for _ in 0..4 {
        code = code * 16 + chars.next()?.to_digit(16)?;
    }
    if (0xd800..0xdc00).contains(&code) {
        // A pair arrives as `\uXXXX\uYYYY` and is one character; a lone high
        // surrogate is not a character at all. The lookahead runs on a clone,
        // so a `\` that turns out to be content is still there for the next
        // round of the caller's loop.
        let mut probe = chars.clone();
        if probe.next() != Some('\\') || probe.next() != Some('u') {
            return Some('\u{fffd}');
        }
        let mut low = 0u32;
        for _ in 0..4 {
            low = low * 16 + probe.next()?.to_digit(16)?;
        }
        if !(0xdc00..0xe000).contains(&low) {
            return Some('\u{fffd}');
        }
        *chars = probe;
        return char::from_u32(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00));
    }
    Some(char::from_u32(code).unwrap_or('\u{fffd}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MemStorage(std::collections::HashMap<String, String>);

    impl Storage for MemStorage {
        fn get(&self, key: &str) -> Option<String> {
            self.0.get(key).cloned()
        }
        fn set(&mut self, key: &str, value: &str) {
            self.0.insert(key.to_string(), value.to_string());
        }
        fn remove(&mut self, key: &str) {
            self.0.remove(key);
        }
    }

    #[test]
    fn device_identity_prefers_the_verified_target() {
        assert_eq!(
            device_identity("ble", Some("AA:BB"), Some("uart"), Some("t-1"), true),
            Some("target:t-1".to_string())
        );
        assert_eq!(
            device_identity("ble", Some("AA:BB"), Some("uart"), None, false),
            Some("[\"ble\",\"AA:BB\",\"uart\"]".to_string())
        );
        assert_eq!(device_identity("ble", None, None, None, false), None);
    }

    #[test]
    fn tasks_round_trip_and_are_redacted() {
        let mut store = TaskStore::new(MemStorage::default());
        store.save(&TaskRecord {
            id: "t1".to_string(),
            device_key: "target:t-1".to_string(),
            updated_at: 100,
            goal: "password: hunter2".to_string(),
            summary: "Bearer abc".to_string(),
            status: "done".to_string(),
        });
        let list = store.list("target:t-1");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].goal, "password: [redacted]");
        assert_eq!(list[0].summary, "Bearer [redacted]");
    }

    #[test]
    fn running_tasks_are_reported_interrupted() {
        let mut store = TaskStore::new(MemStorage::default());
        store.save(&TaskRecord {
            id: "t1".to_string(),
            device_key: "k".to_string(),
            updated_at: 0,
            goal: "g".to_string(),
            summary: "s".to_string(),
            status: "running".to_string(),
        });
        assert_eq!(store.list("k")[0].status, "interrupted");
    }

    /// The cap counts each board's tasks, not the shelf's: filling one board's
    /// history must not push another board's tasks off the end.
    #[test]
    fn the_cap_is_per_device() {
        let mut store = TaskStore::new(MemStorage::default());
        for i in 0..(TASKS_PER_DEVICE + 5) {
            store.save(&TaskRecord {
                id: format!("a{i}"),
                device_key: "board-a".to_string(),
                updated_at: i as u64,
                goal: format!("goal {i}"),
                summary: String::new(),
                status: "done".to_string(),
            });
        }
        store.save(&TaskRecord {
            id: "b1".to_string(),
            device_key: "board-b".to_string(),
            updated_at: 1,
            goal: "the other board's only task".to_string(),
            summary: String::new(),
            status: "done".to_string(),
        });
        let a = store.list("board-a");
        let b = store.list("board-b");
        assert_eq!(a.len(), TASKS_PER_DEVICE, "board a keeps its own cap");
        assert_eq!(
            a[0].id,
            format!("a{}", TASKS_PER_DEVICE + 4),
            "the newest of board a is first"
        );
        assert_eq!(
            a.last().map(|t| t.id.as_str()),
            Some("a5"),
            "oldest dropped"
        );
        assert_eq!(
            b.len(),
            1,
            "board b's task survived board a being filled: {b:?}"
        );
    }

    #[test]
    fn clear_scopes_to_a_device() {
        let mut store = TaskStore::new(MemStorage::default());
        for (id, key) in [("t1", "a"), ("t2", "b")] {
            store.save(&TaskRecord {
                id: id.to_string(),
                device_key: key.to_string(),
                updated_at: 0,
                goal: "g".to_string(),
                summary: "s".to_string(),
                status: "done".to_string(),
            });
        }
        store.clear("a");
        assert!(store.list("a").is_empty());
        assert_eq!(store.list("b").len(), 1);
    }

    /// The writer spells a control character `\uXXXX`; the reader has to read
    /// that spelling back. Read as six characters of text instead, the escape
    /// was escaped again on the next save and the text grew by one escape for
    /// every round trip through the store.
    #[test]
    fn a_control_character_survives_its_escaped_spelling() {
        let original = "line\u{1b}[31mred\u{7}bell\u{1f}\r\nnext";
        let quoted = json_escape(original);
        let read_back = parse_json_string_literal(&quoted).expect("the writer's own quoting");
        assert_eq!(read_back, original);
        // Twice, because the growth only showed on the second pass.
        let again = parse_json_string_literal(&json_escape(&read_back)).expect("again");
        assert_eq!(again, original, "the text must not grow a round trip");
    }

    /// A character above the BMP is two escapes and one character, and a lone
    /// surrogate is the replacement character rather than a panic.
    #[test]
    fn a_surrogate_pair_reads_as_one_character() {
        assert_eq!(
            parse_json_string_literal("\"\\ud83d\\ude00\"").expect("a pair"),
            "😀"
        );
        assert_eq!(
            parse_json_string_literal("\"\\ud83dx\"").expect("a lone high half"),
            "\u{fffd}x"
        );
        assert_eq!(
            parse_json_string_literal("\"\\udc00\"").expect("a lone low half"),
            "\u{fffd}"
        );
        assert_eq!(
            parse_json_string_literal("\"\\u0041\"").expect("plain ASCII"),
            "A"
        );
    }
}
