//! Conversation continuity across a reload (`web/agent_session.js`).
//!
//! Only the panel's own transcripts persist, keyed by device identity: the
//! display lines the user saw, and the model messages the runtime needs to
//! continue. Restored history is history, not evidence — the runtime compacts
//! it like an interrupted run.
//!
//! The web keeps one record per board. The TUI keeps a *list* of conversations
//! under the same key, because the panel offers a new-chat button and a way to
//! walk back to an earlier thread. The bounds are the web's, applied per
//! conversation, plus one of our own: how many conversations a board
//! remembers. A conversation that has nothing in it is not a conversation and
//! is not stored — that is what makes the web's "New chat" a clear as well as
//! a fresh start.

use super::config::Storage;

pub const SESSION_KEY: &str = "linkr-agent-session-v1";
pub const SESSION_MESSAGES: usize = 40;
pub const SESSION_DISPLAY: usize = 60;
pub const SESSION_ENTRY_CHARS: usize = 2000;
pub const SESSION_MAX_BYTES: usize = 96000;
/// How many conversations one device remembers, oldest first out. The web's
/// number for how many *devices* it remembers; the same reasoning, one level
/// down: a bench that starts a chat per question must not fill the store.
pub const SESSION_CHATS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayLine {
    pub role: String,
    pub text: String,
}

/// One conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chat {
    /// Stable across saves: the panel's cursor points at this, not at an
    /// index that shifts when an older conversation is forgotten.
    pub id: u64,
    /// What the panel shows in its header. Empty until the first question.
    pub title: String,
    pub display: Vec<DisplayLine>,
    pub messages: Vec<DisplayLine>,
    pub updated_at: u64,
}

/// Every conversation one device remembers, and which one was last open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceChats {
    pub active: u64,
    pub chats: Vec<Chat>,
}

fn trim_display(display: &[DisplayLine]) -> Vec<DisplayLine> {
    display
        .iter()
        .filter(|e| (e.role == "user" || e.role == "assistant") && !e.text.trim().is_empty())
        .map(|e| DisplayLine {
            role: e.role.clone(),
            text: e.text.chars().take(SESSION_ENTRY_CHARS).collect(),
        })
        .rev()
        .take(SESSION_DISPLAY)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn size(messages: &[DisplayLine]) -> usize {
    serialize_messages(messages).len()
}

/// Bound one conversation the way `save_session` bounded the single record:
/// the last N messages, and then the oldest turns dropped until the serialized
/// record fits. `None` means the conversation has nothing worth storing.
fn trim_chat(chat: &Chat) -> Option<Chat> {
    let mut kept: Vec<DisplayLine> = chat
        .messages
        .iter()
        .rev()
        .take(SESSION_MESSAGES)
        .cloned()
        .collect();
    kept.reverse();
    while kept.len() > 1 && size(&kept) > SESSION_MAX_BYTES {
        kept.remove(0);
    }
    let display = trim_display(&chat.display);
    if size(&kept) > SESSION_MAX_BYTES || (kept.is_empty() && display.is_empty()) {
        return None;
    }
    Some(Chat {
        id: chat.id,
        title: chat.title.chars().take(80).collect(),
        display,
        messages: kept,
        updated_at: chat.updated_at,
    })
}

/// Save the conversations held for a device, bounding each one and dropping
/// the oldest conversations when there are more than [`SESSION_CHATS`].
///
/// Returns what was actually stored, so a caller that keeps its own copy can
/// converge on the store's (trimmed) version rather than drift from it.
pub fn save_chats(
    storage: &mut dyn Storage,
    device_key: &str,
    active: u64,
    chats: &[Chat],
    now_ms: u64,
) -> Option<DeviceChats> {
    if device_key.is_empty() {
        return None;
    }
    let mut kept: Vec<Chat> = Vec::new();
    for chat in chats {
        // A conversation that has never been stamped takes the caller's clock;
        // one that carries a stamp keeps it, because the stamp is the age the
        // cap is ordered by and restamping every chat on every save would make
        // them all look equally old.
        let stamped = Chat {
            updated_at: if chat.updated_at == 0 {
                now_ms
            } else {
                chat.updated_at
            },
            ..chat.clone()
        };
        if let Some(trimmed) = trim_chat(&stamped) {
            kept.push(trimmed);
        }
    }
    // Newest first, so the cap keeps the conversations a user would miss.
    kept.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.id.cmp(&a.id)));
    kept.truncate(SESSION_CHATS);
    // Oldest first for the reader: the order the panel lists and walks them in.
    kept.sort_by(|a, b| a.updated_at.cmp(&b.updated_at).then(a.id.cmp(&b.id)));
    // The panel's cursor must point at something: when the thread the user was
    // reading was the one forgotten, it falls to the newest that survived —
    // the last of the oldest-first order this list is kept in.
    let active = if kept.iter().any(|c| c.id == active) {
        active
    } else {
        kept.last().map(|c| c.id).unwrap_or(active)
    };

    let mut data = load_all(storage);
    if kept.is_empty() {
        data.remove(device_key);
    } else {
        data.insert(
            device_key.to_string(),
            DeviceChats {
                active,
                chats: kept.clone(),
            },
        );
    }

    // One record per board seen, oldest first out — the web's rule for devices
    // is this store's rule for boards.
    let mut keys: Vec<(String, u64)> = data
        .iter()
        .map(|(k, v)| {
            let newest = v.chats.iter().map(|c| c.updated_at).max().unwrap_or(0);
            (k.clone(), newest)
        })
        .collect();
    keys.sort_by_key(|(_, ts)| *ts);
    let excess = keys.len().saturating_sub(SESSION_CHATS);
    for (key, _) in keys.into_iter().take(excess) {
        data.remove(&key);
    }

    save_all(storage, &data);
    if kept.is_empty() {
        return None;
    }
    Some(DeviceChats {
        active,
        chats: kept,
    })
}

/// Read the conversations held for a device, newest last.
pub fn load_chats(storage: &dyn Storage, device_key: &str) -> Option<DeviceChats> {
    if device_key.is_empty() {
        return None;
    }
    let data = load_all(storage);
    let stored = data.get(device_key)?.clone();
    let mut chats: Vec<Chat> = stored
        .chats
        .into_iter()
        .filter(|chat| !chat.display.is_empty() || !chat.messages.is_empty())
        .map(|chat| {
            let mut messages: Vec<DisplayLine> = chat
                .messages
                .into_iter()
                .rev()
                .take(SESSION_MESSAGES)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            messages.shrink_to_fit();
            Chat {
                display: trim_display(&chat.display),
                messages,
                ..chat
            }
        })
        .collect();
    if chats.is_empty() {
        return None;
    }
    // Oldest first: the order they are listed and walked in, so "previous" and
    // "next" mean the same thing in every session.
    chats.sort_by(|a, b| a.updated_at.cmp(&b.updated_at).then(a.id.cmp(&b.id)));
    let active = if chats.iter().any(|c| c.id == stored.active) {
        stored.active
    } else {
        // The thread the cursor stood on is not in the file — a hand edit, or
        // a shelf written before a cap existed. Where the user left off is the
        // newest thread there is, and the order here is oldest first.
        chats.last().map(|c| c.id).unwrap_or(0)
    };
    Some(DeviceChats { active, chats })
}

/// Forget every conversation held for a device.
pub fn clear_chats(storage: &mut dyn Storage, device_key: &str) {
    if device_key.is_empty() {
        return;
    }
    let mut data = load_all(storage);
    data.remove(device_key);
    save_all(storage, &data);
}

// A fixed-schema JSON codec: a top-level object mapping deviceKey -> record,
// where each record is `{active, chats:[{id,title,display,messages,updatedAt}]}`.
// The older single-session shape — `{display, messages, updatedAt}` with no
// `chats` — is read as one conversation, so a store written before the panel
// had a chat list opens with its thread intact.

fn load_all(storage: &dyn Storage) -> std::collections::BTreeMap<String, DeviceChats> {
    let raw = match storage.get(SESSION_KEY) {
        Some(r) => r,
        None => return Default::default(),
    };
    parse_devices(&raw).unwrap_or_default()
}

fn save_all(storage: &mut dyn Storage, data: &std::collections::BTreeMap<String, DeviceChats>) {
    storage.set(SESSION_KEY, &serialize_devices(data));
}

fn serialize_messages(messages: &[DisplayLine]) -> String {
    let items: Vec<String> = messages
        .iter()
        .map(|m| {
            format!(
                "{{\"role\":{},\"text\":{}}}",
                json_string(&m.role),
                json_string(&m.text)
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn serialize_chat(chat: &Chat) -> String {
    format!(
        "{{\"id\":{},\"title\":{},\"display\":{},\"messages\":{},\"updatedAt\":{}}}",
        chat.id,
        json_string(&chat.title),
        serialize_messages(&chat.display),
        serialize_messages(&chat.messages),
        chat.updated_at,
    )
}

fn serialize_devices(data: &std::collections::BTreeMap<String, DeviceChats>) -> String {
    let items: Vec<String> = data
        .iter()
        .map(|(key, record)| {
            let chats: Vec<String> = record.chats.iter().map(serialize_chat).collect();
            format!(
                "{}:{{\"active\":{},\"chats\":[{}]}}",
                json_string(key),
                record.active,
                chats.join(",")
            )
        })
        .collect();
    format!("{{{}}}", items.join(","))
}

fn parse_devices(raw: &str) -> Option<std::collections::BTreeMap<String, DeviceChats>> {
    let raw = raw.trim();
    if !raw.starts_with('{') || !raw.ends_with('}') {
        return None;
    }
    let inner = &raw[1..raw.len() - 1];
    if inner.trim().is_empty() {
        return Some(Default::default());
    }
    let mut map = std::collections::BTreeMap::new();
    for pair in super::tasks::split_top_level(inner, ',') {
        let colon = super::tasks::find_top_level_colon(pair)?;
        let key = parse_json_string_literal(pair[..colon].trim())?;
        let value = parse_device_record(pair[colon + 1..].trim())?;
        map.insert(key, value);
    }
    Some(map)
}

fn parse_device_record(s: &str) -> Option<DeviceChats> {
    let s = s.trim();
    if !s.starts_with('{') || !s.ends_with('}') {
        return None;
    }
    let inner = &s[1..s.len() - 1];
    let mut active = 0u64;
    let mut chats: Option<Vec<Chat>> = None;
    let mut display = Vec::new();
    let mut messages = Vec::new();
    let mut updated_at = 0u64;
    for pair in super::tasks::split_top_level(inner, ',') {
        let colon = super::tasks::find_top_level_colon(pair)?;
        let key = parse_json_string_literal(pair[..colon].trim())?;
        let value = pair[colon + 1..].trim();
        match key.as_str() {
            "active" => active = value.parse().ok()?,
            "chats" => chats = Some(parse_chats(value)?),
            "display" => display = parse_messages(value)?,
            "messages" => messages = parse_messages(value)?,
            "updatedAt" => updated_at = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    let chats = match chats {
        Some(chats) => chats,
        // The single-session shape: one conversation, and it is the active one.
        None if !display.is_empty() || !messages.is_empty() => vec![Chat {
            id: 0,
            title: String::new(),
            display,
            messages,
            updated_at,
        }],
        None => Vec::new(),
    };
    Some(DeviceChats { active, chats })
}

fn parse_chats(s: &str) -> Option<Vec<Chat>> {
    let objects = super::tasks::parse_json_array(s)?;
    objects
        .into_iter()
        .map(|obj| {
            Some(Chat {
                id: obj.get("id")?.parse().ok()?,
                title: obj.get("title")?.clone(),
                display: parse_messages(obj.get("display")?)?,
                messages: parse_messages(obj.get("messages")?)?,
                updated_at: obj.get("updatedAt")?.parse().unwrap_or(0),
            })
        })
        .collect()
}

fn parse_messages(s: &str) -> Option<Vec<DisplayLine>> {
    let arr = super::tasks::parse_json_array(s)?;
    arr.into_iter()
        .map(|obj| {
            Some(DisplayLine {
                role: obj.get("role")?.clone(),
                text: obj.get("text")?.clone(),
            })
        })
        .collect()
}

fn parse_json_string_literal(s: &str) -> Option<String> {
    super::tasks::parse_json_string_literal(s)
}

fn json_string(s: &str) -> String {
    super::tasks::json_string(s)
}

#[cfg(test)]
mod round_trip {
    use super::super::store::JsonFile;
    use super::*;

    fn line(role: &str, text: &str) -> DisplayLine {
        DisplayLine {
            role: role.into(),
            text: text.into(),
        }
    }

    /// A conversation survives a reopen, which is the whole point of a session
    /// store: without it the agent is amnesiac between restarts and the thread
    /// on screen has nothing behind it.
    #[test]
    fn a_conversation_survives_a_reopen() {
        let mut path = std::env::temp_dir();
        path.push(format!("linkr-session-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let turns = vec![
            line("user", "what is the uptime"),
            line("assistant", "up 4 hours"),
        ];
        let chat = Chat {
            id: 7,
            title: "uptime".into(),
            display: turns.clone(),
            messages: turns.clone(),
            updated_at: 0,
        };
        {
            let mut store = JsonFile::at(&path);
            let saved = save_chats(&mut store, "board", 7, &[chat], 1_000);
            assert!(saved.is_some(), "the session was not saved");
        }
        let loaded = load_chats(&JsonFile::at(&path), "board").expect("loaded");
        assert_eq!(loaded.active, 7);
        assert_eq!(loaded.chats.len(), 1);
        assert_eq!(loaded.chats[0].display, turns);
        assert_eq!(loaded.chats[0].title, "uptime");
        // A different device does not see it: the store is per target.
        assert!(load_chats(&JsonFile::at(&path), "other").is_none());
        let _ = std::fs::remove_file(&path);
    }

    /// A store written before the panel had a chat list opens with its thread
    /// intact, as the one conversation it always was.
    #[test]
    fn a_single_session_record_reads_as_one_chat() {
        let raw = format!(
            "{{\"board\":{{\"display\":{},\"messages\":{},\"updatedAt\":42}}}}",
            serialize_messages(&[line("user", "hi")]),
            serialize_messages(&[line("user", "hi")]),
        );
        let mut storage = MapStorage::default();
        storage.0.insert(SESSION_KEY.into(), raw);
        let loaded = load_chats(&storage, "board").expect("loaded");
        assert_eq!(loaded.chats.len(), 1);
        assert_eq!(loaded.chats[0].display[0].text, "hi");
        assert_eq!(loaded.chats[0].id, 0);
        // Its id is what the cursor points at, so a caller holding it keeps
        // pointing at the same conversation.
        assert_eq!(loaded.active, 0);
    }

    /// An empty store has no session rather than an error.
    #[test]
    fn an_empty_store_has_no_session() {
        let mut path = std::env::temp_dir();
        path.push(format!("linkr-session-empty-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        assert!(load_chats(&JsonFile::at(&path), "board").is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[derive(Default)]
    struct MapStorage(std::collections::HashMap<String, String>);

    impl Storage for MapStorage {
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

    fn chat(id: u64, text: &str) -> Chat {
        Chat {
            id,
            title: String::new(),
            display: vec![line("user", text)],
            messages: vec![line("user", text)],
            updated_at: 0,
        }
    }

    #[test]
    fn conversations_round_trip_in_order() {
        let mut storage = MapStorage::default();
        let chats = vec![chat(1, "first"), chat(2, "second"), chat(3, "third")];
        save_chats(&mut storage, "k", 3, &chats, 10);
        let loaded = load_chats(&storage, "k").unwrap();
        assert_eq!(
            loaded.chats.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(loaded.active, 3);
    }

    /// Every conversation is bounded on its own: one huge thread cannot push
    /// the others out, and the one that is too big is trimmed, not dropped.
    #[test]
    fn each_conversation_is_bounded_on_its_own() {
        let mut storage = MapStorage::default();
        let long = Chat {
            id: 1,
            title: String::new(),
            display: (0..100)
                .map(|i| line("user", &format!("turn {i}")))
                .collect(),
            messages: (0..100)
                .map(|i| line("user", &format!("turn {i}")))
                .collect(),
            updated_at: 0,
        };
        let short = chat(2, "short");
        save_chats(&mut storage, "k", 2, &[long, short], 10);
        let loaded = load_chats(&storage, "k").unwrap();
        assert_eq!(loaded.chats.len(), 2, "the short chat was pushed out");
        let long = loaded.chats.iter().find(|c| c.id == 1).unwrap();
        assert_eq!(long.display.len(), SESSION_DISPLAY);
        assert_eq!(long.messages.len(), SESSION_MESSAGES);
        assert_eq!(long.display.last().unwrap().text, "turn 99");
    }

    /// Beyond the cap the oldest conversation is forgotten, and the cursor
    /// falls to a conversation that still exists.
    #[test]
    fn the_oldest_conversation_is_forgotten_first() {
        let mut storage = MapStorage::default();
        // Distinct stamps: the cap is by age, and the ids are in age order.
        let chats: Vec<Chat> = (1..=SESSION_CHATS as u64 + 2)
            .map(|id| {
                let mut chat = chat(id, "hello");
                chat.updated_at = id;
                chat
            })
            .collect();
        let saved = save_chats(&mut storage, "k", 1, &chats, 500).unwrap();
        assert_eq!(saved.chats.len(), SESSION_CHATS);
        assert!(!saved.chats.iter().any(|c| c.id == 1), "the oldest stayed");
        assert!(
            saved.chats.iter().any(|c| c.id == saved.active),
            "the cursor points at nothing"
        );
    }

    #[test]
    fn an_empty_conversation_is_not_stored() {
        let mut storage = MapStorage::default();
        let empty = Chat {
            id: 1,
            title: "draft".into(),
            display: Vec::new(),
            messages: Vec::new(),
            updated_at: 0,
        };
        assert!(save_chats(&mut storage, "k", 1, &[empty], 100).is_none());
        assert!(load_chats(&storage, "k").is_none());
    }

    #[test]
    fn display_is_trimmed_to_role_and_chars() {
        let mut storage = MapStorage::default();
        let display = vec![
            line("system", "hidden"),        // wrong role, dropped
            line("user", "  "),              // blank, dropped
            line("user", &"x".repeat(2500)), // capped to 2000
        ];
        let chat = Chat {
            id: 1,
            title: String::new(),
            display,
            messages: vec![line("user", "hi")],
            updated_at: 0,
        };
        save_chats(&mut storage, "k", 1, &[chat], 100);
        let loaded = load_chats(&storage, "k").unwrap();
        assert_eq!(loaded.chats[0].display.len(), 1);
        assert_eq!(
            loaded.chats[0].display[0].text.chars().count(),
            SESSION_ENTRY_CHARS
        );
    }

    #[test]
    fn clear_removes_only_that_device() {
        let mut storage = MapStorage::default();
        save_chats(&mut storage, "a", 1, &[chat(1, "hi")], 1);
        save_chats(&mut storage, "b", 1, &[chat(1, "hi")], 1);
        clear_chats(&mut storage, "a");
        assert!(load_chats(&storage, "a").is_none());
        assert!(load_chats(&storage, "b").is_some());
    }
}
