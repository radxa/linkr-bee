//! Durable notes about a target (`web/agent_notes.js`).
//!
//! The observed profile and tool capabilities live in memory and are discarded
//! on reconnect; a note is the opposite — something the assistant verified once
//! and wants on hand the next time this target is connected. Notes are free
//! text, redacted like task summaries, and capped per device.

use super::config::Storage;
use super::redact::redact_task_text;

pub const NOTES_KEY: &str = "linkr-agent-notes-v1";
pub const NOTE_LIMIT: usize = 12;
pub const NOTE_MAX_CHARS: usize = 600;
pub const NOTE_EVIDENCE_MAX_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub id: String,
    pub text: String,
    pub evidence: String,
    pub created_at: u64,
}

/// A note store. Notes are keyed by device and capped oldest-first-out.
pub struct NoteStore<S: Storage> {
    storage: S,
}

#[derive(Debug, Clone)]
struct RawNote {
    id: String,
    device_key: String,
    text: String,
    evidence: String,
    created_at: u64,
}

impl<S: Storage> NoteStore<S> {
    pub fn new(storage: S) -> Self {
        NoteStore { storage }
    }

    fn read(&self) -> Vec<RawNote> {
        match self.storage.get(NOTES_KEY) {
            Some(raw) => parse_notes(&raw).unwrap_or_default(),
            None => Vec::new(),
        }
    }

    fn write(&mut self, notes: &[RawNote]) {
        self.storage.set(NOTES_KEY, &serialize_notes(notes));
    }

    pub fn list(&self, device_key: &str) -> Vec<Note> {
        if device_key.is_empty() {
            return Vec::new();
        }
        let mut notes: Vec<Note> = self
            .read()
            .into_iter()
            .filter(|n| n.device_key == device_key)
            .map(|n| Note {
                id: n.id,
                text: n.text,
                evidence: n.evidence,
                created_at: n.created_at,
            })
            .collect();
        notes.sort_by_key(|n| n.created_at);
        notes
    }

    /// Add a note. Returns the note plus a `duplicate` flag when an identical
    /// note for this device already exists.
    pub fn add(
        &mut self,
        device_key: &str,
        text: &str,
        evidence: &str,
        now_ms: u64,
    ) -> Result<(Note, bool), String> {
        if device_key.is_empty() {
            return Err("This target has no identity yet, so a note cannot be stored.".to_string());
        }
        let trimmed = text.trim();
        if trimmed.chars().count() > NOTE_MAX_CHARS {
            return Err(format!("A note is limited to {NOTE_MAX_CHARS} characters."));
        }
        let clean = redact_task_text(trimmed).trim().to_string();
        if clean.is_empty() {
            return Err("The note is empty after redaction.".to_string());
        }

        let notes = self.read();
        let existing: Vec<RawNote> = notes
            .iter()
            .filter(|n| n.device_key == device_key)
            .cloned()
            .collect();
        if let Some(dup) = existing.iter().find(|n| n.text == clean) {
            return Ok((
                Note {
                    id: dup.id.clone(),
                    text: dup.text.clone(),
                    evidence: dup.evidence.clone(),
                    created_at: dup.created_at,
                },
                true,
            ));
        }

        let note = RawNote {
            id: format!("note-{}-{}", now_ms, simple_random_id()),
            device_key: device_key.to_string(),
            text: clean,
            evidence: redact_task_text(evidence.trim())
                .chars()
                .take(NOTE_EVIDENCE_MAX_CHARS)
                .collect(),
            created_at: now_ms,
        };

        // Oldest first out: the newest observation matters most, and the cap
        // keeps the record bounded.
        let mut kept = notes;
        if existing.len() >= NOTE_LIMIT {
            let overflow = existing.len() - NOTE_LIMIT + 1;
            let dropped: Vec<String> = existing
                .iter()
                .take(overflow)
                .map(|n| n.id.clone())
                .collect();
            kept.retain(|n| !dropped.contains(&n.id));
        }
        kept.push(note.clone());
        let tail = kept.len().saturating_sub(NOTE_LIMIT * 4);
        self.write(&kept[tail..]);

        Ok((
            Note {
                id: note.id,
                text: note.text,
                evidence: note.evidence,
                created_at: note.created_at,
            },
            false,
        ))
    }

    pub fn remove(&mut self, device_key: &str, id: &str) {
        let kept: Vec<RawNote> = self
            .read()
            .into_iter()
            .filter(|n| !(n.device_key == device_key && n.id == id))
            .collect();
        self.write(&kept);
    }

    pub fn clear(&mut self, device_key: &str) {
        let kept: Vec<RawNote> = self
            .read()
            .into_iter()
            .filter(|n| n.device_key != device_key)
            .collect();
        self.write(&kept);
    }
}

fn simple_random_id() -> String {
    // A deterministic-but-distinct suffix; real entropy comes from now_ms.
    format!("{:06x}", now_micros() & 0xffffff)
}

fn now_micros() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

// A tiny fixed-schema JSON codec for `{id, deviceKey, text, evidence, createdAt}`.

fn serialize_notes(notes: &[RawNote]) -> String {
    let items: Vec<String> = notes
        .iter()
        .map(|n| {
            format!(
                "{{\"id\":{},\"deviceKey\":{},\"text\":{},\"evidence\":{},\"createdAt\":{}}}",
                json_string(&n.id),
                json_string(&n.device_key),
                json_string(&n.text),
                json_string(&n.evidence),
                n.created_at,
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn parse_notes(raw: &str) -> Option<Vec<RawNote>> {
    super::tasks::parse_json_array(raw).map(|entries| {
        entries
            .into_iter()
            .filter_map(|obj| {
                Some(RawNote {
                    id: obj.get("id")?.clone(),
                    device_key: obj.get("deviceKey")?.clone(),
                    text: obj.get("text")?.clone(),
                    evidence: obj.get("evidence").cloned().unwrap_or_default(),
                    created_at: obj.get("createdAt")?.parse().ok()?,
                })
            })
            .collect()
    })
}

fn json_string(s: &str) -> String {
    super::tasks::json_string(s)
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
    fn notes_round_trip_and_redact() {
        let mut store = NoteStore::new(MemStorage::default());
        let (note, dup) = store
            .add("k", "password: hunter2", "Bearer abc", 100)
            .unwrap();
        assert!(!dup);
        assert_eq!(note.text, "password: [redacted]");
        assert_eq!(note.evidence, "Bearer [redacted]");

        let list = store.list("k");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].text, "password: [redacted]");
    }

    #[test]
    fn an_identical_note_is_a_duplicate() {
        let mut store = NoteStore::new(MemStorage::default());
        store.add("k", "same", "", 100).unwrap();
        let (_, dup) = store.add("k", "same", "", 200).unwrap();
        assert!(dup);
    }

    #[test]
    fn an_empty_note_is_rejected() {
        let mut store = NoteStore::new(MemStorage::default());
        assert!(store.add("k", "   ", "", 0).is_err());
    }

    #[test]
    fn remove_and_clear_scope_to_a_device() {
        let mut store = NoteStore::new(MemStorage::default());
        let (a, _) = store.add("a", "note a", "", 1).unwrap();
        store.add("b", "note b", "", 2).unwrap();
        store.remove("a", &a.id);
        assert!(store.list("a").is_empty());
        assert_eq!(store.list("b").len(), 1);
        store.clear("b");
        assert!(store.list("b").is_empty());
    }
}
