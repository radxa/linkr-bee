//! Where a LAN access token is kept between sessions, and which of the four
//! places a dial got its token from.
//!
//! A token is friction: it is 32 characters nobody can type from memory, it is
//! per bridge, and a session that has to be handed one every time is a session
//! nobody runs twice. So the host remembers the ones it has been given, keyed
//! by the host it was given for, and the command line can say where a token
//! came from when it has one to offer.
//!
//! Two rules shape this module.
//!
//! **A token is written down only if it was valid.** A store that accepted any
//! string would turn a typo into a stored token, and a stored token is one the
//! user has no reason to look at again — so every read and every write goes
//! through the same check the dial does. That check also fails a *corrupt*
//! file closed: a line that is not a host and a token is dropped, never
//! guessed at.
//!
//! **A token is never printed.** Notices, the sidebar and bug reports all
//! quote descriptions, and a token that reaches a screenshot is a token that
//! has to be rotated. [`redact`] is what a line goes through before it is
//! shown, and no path in this crate formats a token into text.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::transport::lan::{host_key, is_bridge_address, validate_token, TOKEN_ERROR, TOKEN_LEN};

/// The variable a token may be read from.
pub const TOKEN_ENV: &str = "LINKR_LAN_TOKEN";

/// Where a store lives when the environment does not say otherwise.
pub const DEFAULT_FILE: &str = "linkr/lan-tokens";

/// Which place a dial's token came from, so a refusal can name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `--lan-token`.
    Flag,
    /// `--lan-token-file`.
    File,
    /// `$LINKR_LAN_TOKEN`.
    Env,
    /// A token remembered for this host.
    Store,
}

impl Source {
    /// The name an error uses for the place it looked.
    pub fn describe(self) -> &'static str {
        match self {
            Source::Flag => "--lan-token",
            Source::File => "--lan-token-file",
            Source::Env => TOKEN_ENV,
            Source::Store => "the saved token for this bridge",
        }
    }
}

/// The tokens this host has been given, in memory.
///
/// Deliberately plain: a `BTreeMap` and a path. The file is the durable copy
/// and this is what a dial reads, so a session that never writes never pays
/// for the store being reachable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TokenStore {
    path: Option<PathBuf>,
    entries: BTreeMap<String, String>,
}

impl TokenStore {
    /// A store backed by `path`, with whatever is already in it.
    ///
    /// An unreadable or malformed file is treated as empty rather than as an
    /// error: a corrupt cache must not be the reason a user cannot connect to
    /// a bridge they have the token for. A file that *had* lines the format
    /// does not allow is written back clean on the spot — a dropped line stays
    /// dropped only if it is gone from the file, and the next session should
    /// not have to drop the same mistake again.
    pub fn at(path: impl Into<PathBuf>) -> TokenStore {
        let path = path.into();
        let (entries, dropped) = std::fs::read_to_string(&path)
            .map(|text| parse(&text))
            .unwrap_or_default();
        let store = TokenStore {
            path: Some(path),
            entries,
        };
        if dropped {
            let _ = store.save();
        }
        store
    }

    /// The store the environment points at, or one that remembers nothing when
    /// there is nowhere to put it.
    pub fn load() -> TokenStore {
        match default_path() {
            Some(path) => TokenStore::at(path),
            None => TokenStore::default(),
        }
    }

    /// The path the store writes to, if it has one.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// How many tokens are remembered.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether nothing is remembered.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The token remembered for `host`, if any.
    pub fn token_for(&self, host: &str) -> Option<&str> {
        let key = host_key(host);
        if key.is_empty() {
            return None;
        }
        self.entries.get(&key).map(String::as_str)
    }

    /// Remember `token` for `host`, refusing anything the bridge would refuse.
    pub fn remember(&mut self, host: &str, token: &str) -> Result<(), String> {
        let key = host_key(host);
        if key.is_empty() || !is_bridge_address(&key) {
            return Err("a token can only be saved for a bridge with an address".to_string());
        }
        validate_token(token)?;
        self.entries.insert(key, token.to_string());
        Ok(())
    }

    /// Forget `host`. `false` means nothing was remembered for it.
    pub fn forget(&mut self, host: &str) -> bool {
        self.entries.remove(&host_key(host)).is_some()
    }

    /// Write the store out. The directory is created if it is missing, and the
    /// file is given owner-only permissions, because a token is a key.
    ///
    /// Written beside the real file and renamed over it: the store is never on
    /// disk wearing the umask's permissions, and never half written — a partial
    /// store read back as an empty map is a bridge that will not authenticate.
    /// A second instance saving at the same moment writes its own temp rather
    /// than sharing one — see [`crate::private_file::write_private_atomically`].
    pub fn save(&self) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "there is nowhere to save LAN tokens on this machine",
            ));
        };
        crate::private_file::write_private_atomically(path, render(&self.entries).as_bytes())
    }
}

/// Which of the four places a dial's token comes from, checked in the order a
/// user would expect: what was typed, what was pointed at, what was exported,
/// what was remembered.
///
/// Validation happens here rather than at the socket, so a token that is the
/// wrong shape is refused with the name of the place it came from — "the access
/// token must be 32 lowercase hex characters" is not a useful sentence about a
/// file the user did not know was being read.
pub fn resolve(
    flag: Option<&str>,
    file: Option<&Path>,
    env: Option<&str>,
    store: &TokenStore,
    host: &str,
) -> Result<Option<(String, Source)>, String> {
    let candidate = if let Some(token) = flag {
        Some((token.to_string(), Source::Flag))
    } else if let Some(path) = file {
        let text =
            std::fs::read_to_string(path).map_err(|why| format!("{}: {why}", path.display()))?;
        Some((text.trim().to_string(), Source::File))
    } else if let Some(token) = env.filter(|token| !token.trim().is_empty()) {
        Some((token.trim().to_string(), Source::Env))
    } else {
        store
            .token_for(host)
            .map(|token| (token.to_string(), Source::Store))
    };

    match candidate {
        None => Ok(None),
        Some((token, source)) => match validate_token(&token) {
            Ok(()) => Ok(Some((token, source))),
            Err(_) => Err(format!("{}: {TOKEN_ERROR}", source.describe())),
        },
    }
}

/// A line with any token-shaped word replaced, for anything a user will read
/// or paste into a report.
///
/// Shape rather than membership: a redactor that only knew the tokens this host
/// has stored would leak the one that arrived in a log line from somewhere
/// else. The shape is exactly a run of [`TOKEN_LEN`] lowercase hex digits, so a
/// longer hex run — a hash, a MAC without its colons — is left alone rather
/// than half-replaced.
pub fn redact(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut at = 0;
    while at < bytes.len() {
        if is_hex_lower(bytes[at]) {
            let start = at;
            while at < bytes.len() && is_hex_lower(bytes[at]) {
                at += 1;
            }
            if at - start == TOKEN_LEN {
                out.push_str(TOKEN_MASK);
            } else {
                out.push_str(&line[start..at]);
            }
        } else {
            // Advanced by whole characters: a multi-byte glyph is never hex,
            // and one must not be cut in half on the way out.
            let glyph = line[at..]
                .chars()
                .next()
                .unwrap_or(char::REPLACEMENT_CHARACTER);
            out.push(glyph);
            at += glyph.len_utf8();
        }
    }
    out
}

/// What a scrubbed token reads as.
const TOKEN_MASK: &str = "«token»";

/// Whether `byte` is one of the sixteen digits a token is written in.
fn is_hex_lower(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

/// Where the store lives: `$LINKR_LAN_TOKEN_FILE`, then the platform's config
/// directory for this user, then nothing.
///
/// The token *file* variable is honoured here as well as on the command line so
/// that a scripted environment has one place to say where tokens are kept.
fn default_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("LINKR_LAN_TOKEN_FILE") {
        if !path.trim().is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        if !dir.trim().is_empty() {
            return Some(Path::new(&dir).join(DEFAULT_FILE));
        }
    }
    // `APPDATA` is the Windows configuration directory, and it is checked
    // before `HOME` because Windows does not define `HOME` and a `.config`
    // directory under `%USERPROFILE%` is a place nothing else on the machine
    // looks. The agent store resolves its own file the same way, so the two
    // files stay in one directory.
    #[cfg(windows)]
    if let Ok(dir) = std::env::var("APPDATA") {
        if !dir.trim().is_empty() {
            return Some(Path::new(&dir).join(DEFAULT_FILE));
        }
    }
    // `USERPROFILE` is the fallback for the same reason: it is the variable a
    // Windows environment sets, and without it a token saved on Windows would
    // never be found again.
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())?;
    if home.trim().is_empty() {
        return None;
    }
    #[cfg(target_os = "macos")]
    let base = Path::new(&home).join("Library/Application Support");
    #[cfg(not(target_os = "macos"))]
    let base = Path::new(&home).join(".config");
    Some(base.join(DEFAULT_FILE))
}

/// Read the store's format: one `host token` per line, `#` for a comment.
///
/// A line that is not exactly that is dropped, and the second value says
/// whether anything was: the caller writes a store that dropped something back
/// out, so the file heals instead of being re-dropped every session. Dropping
/// is what keeps a half-written file from becoming a token: the alternative,
/// taking the longest hex-shaped run on the line, would invent one.
fn parse(text: &str) -> (BTreeMap<String, String>, bool) {
    let mut entries = BTreeMap::new();
    let mut dropped = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((host, token)) = line.split_once(char::is_whitespace) else {
            dropped = true;
            continue;
        };
        let host = host_key(host);
        let token = token.trim();
        // A key that cannot name a bridge is dropped like any other bad line:
        // `down` and `ready` are the firmware's words for "no address", and a
        // token under one of them is a token that can never be used.
        if !is_bridge_address(&host) || validate_token(token).is_err() {
            dropped = true;
            continue;
        }
        entries.insert(host, token.to_string());
    }
    (entries, dropped)
}

/// The store's format, written the way [`parse`] reads it.
fn render(entries: &BTreeMap<String, String>) -> String {
    let mut out = String::from(
        "# linkr LAN access tokens, one per line: <host> <32 lowercase hex>\n\
         # Written by the host terminal; it is the only thing in this file that\n\
         # knows a token, and it is never printed.\n",
    );
    for (host, token) in entries {
        out.push_str(host);
        out.push(' ');
        out.push_str(token);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210";

    /// A directory of our own per test, so tests never share a store.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("linkr-token-store-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch directory");
        dir
    }

    /// A token remembered for a host comes back for every spelling of it: the
    /// user types the address, the URL is what gets dialled, and the key is
    /// neither.
    #[test]
    fn a_remembered_token_is_found_by_any_spelling_of_the_host() {
        let mut store = TokenStore::default();
        store.remember("192.168.0.44", TOKEN).expect("valid");
        assert_eq!(store.token_for("192.168.0.44"), Some(TOKEN));
        assert_eq!(store.token_for("ws://192.168.0.44/ws"), Some(TOKEN));
        assert_eq!(
            store.token_for("192.168.0.44:80"),
            Some(TOKEN),
            "the default port is the same bridge"
        );
        assert_eq!(
            store.token_for("ws://192.168.0.44:8080/ws"),
            None,
            "another port is another bridge"
        );
        assert_eq!(store.token_for("192.168.0.45"), None);
    }

    /// Only what the bridge would accept is remembered. A typo that was stored
    /// would be a typo nobody looks at again.
    #[test]
    fn only_a_valid_token_is_remembered() {
        let mut store = TokenStore::default();
        assert_eq!(
            store.remember("192.168.0.44", "nope"),
            Err(TOKEN_ERROR.to_string())
        );
        assert!(
            store.remember("", TOKEN).is_err(),
            "and a token needs a host"
        );
        assert!(
            store.remember("down", TOKEN).is_err(),
            "and a host needs to be an address, not the firmware's word for none"
        );
        assert!(store.is_empty());
    }

    /// What is written is what is read back — including after a restart, which
    /// is the only reason the file exists.
    #[test]
    fn a_store_survives_a_round_trip_through_the_file() {
        let dir = scratch("round-trip");
        let path = dir.join("lan-tokens");
        let mut store = TokenStore::at(&path);
        store.remember("192.168.0.44", TOKEN).expect("valid");
        store.remember("linkrbee.local", OTHER).expect("valid");
        store.save().expect("writable");

        let reloaded = TokenStore::at(&path);
        assert_eq!(reloaded.token_for("192.168.0.44"), Some(TOKEN));
        assert_eq!(reloaded.token_for("LINKRBEE.LOCAL"), Some(OTHER));
        assert_eq!(reloaded.len(), 2);
    }

    /// A file that is not the store's format loses the lines it cannot read and
    /// keeps the ones it can, rather than failing whole or inventing a token —
    /// and the lines it lost are gone from the file too, so the next session
    /// reads a clean one.
    #[test]
    fn a_damaged_line_is_dropped_not_guessed_at() {
        let dir = scratch("damaged");
        let path = dir.join("lan-tokens");
        std::fs::write(
            &path,
            format!(
                "# a comment\n\
                 \n\
                 192.168.0.44 {TOKEN}\n\
                 this line has no token\n\
                 192.168.0.45 uppercase\n\
                 192.168.0.46 {}\n\
                 down {OTHER}\n\
                 \n",
                TOKEN.to_uppercase()
            ),
        )
        .expect("fixture");
        let store = TokenStore::at(&path);
        assert_eq!(store.len(), 1);
        assert_eq!(store.token_for("192.168.0.44"), Some(TOKEN));
        assert_eq!(store.token_for("192.168.0.45"), None);
        assert_eq!(
            store.token_for("192.168.0.46"),
            None,
            "case is part of the token"
        );
        assert_eq!(
            store.token_for("down"),
            None,
            "a word the firmware uses for \"no address\" is not a bridge"
        );

        let healed = std::fs::read_to_string(&path).expect("still there");
        assert!(
            healed.contains(TOKEN) && !healed.contains("no token") && !healed.contains(OTHER),
            "the file was written back clean: {healed:?}"
        );
        let reloaded = TokenStore::at(&path);
        assert_eq!(reloaded.len(), 1, "and reads the same afterwards");
    }

    /// A store with nowhere to write says so instead of pretending to save.
    #[test]
    fn a_store_with_no_path_refuses_to_save() {
        let store = TokenStore::default();
        let why = store.save().expect_err("no path");
        assert_eq!(why.kind(), io::ErrorKind::Unsupported);
    }

    /// Forgetting is per host, and says whether there was anything to forget.
    #[test]
    fn forgetting_is_per_host() {
        let mut store = TokenStore::default();
        store.remember("192.168.0.44", TOKEN).expect("valid");
        assert!(store.forget("ws://192.168.0.44/ws"));
        assert!(!store.forget("192.168.0.44"));
        assert!(store.is_empty());
    }

    /// The four places are checked in the order a user would expect, and the
    /// winner is reported so an error can name it.
    #[test]
    fn a_token_is_resolved_in_the_documented_order() {
        let dir = scratch("precedence");
        let path = dir.join("token");
        std::fs::write(&path, format!("{OTHER}\n")).expect("fixture");
        let mut store = TokenStore::default();
        store.remember("192.168.0.44", TOKEN).expect("valid");
        let exported = "aaaabbbbccccddddeeeeffff00001111";

        // A flag beats everything.
        assert_eq!(
            resolve(
                Some(TOKEN),
                Some(&path),
                Some(exported),
                &store,
                "192.168.0.44"
            ),
            Ok(Some((TOKEN.to_string(), Source::Flag)))
        );
        // Then a file…
        assert_eq!(
            resolve(None, Some(&path), Some(exported), &store, "192.168.0.44"),
            Ok(Some((OTHER.to_string(), Source::File))),
            "and the file's newline is not part of the token"
        );
        // …then the environment…
        assert_eq!(
            resolve(None, None, Some(exported), &store, "192.168.0.44"),
            Ok(Some((exported.to_string(), Source::Env)))
        );
        // …and last what this host remembered for the bridge.
        assert_eq!(
            resolve(None, None, None, &store, "192.168.0.44"),
            Ok(Some((TOKEN.to_string(), Source::Store)))
        );
        assert_eq!(
            resolve(None, None, Some("   "), &store, "192.168.0.44"),
            Ok(Some((TOKEN.to_string(), Source::Store))),
            "an exported blank is not a token"
        );
        // Nothing anywhere is not an error: the bridge may not want a token.
        assert_eq!(resolve(None, None, None, &store, "10.0.0.9"), Ok(None));
    }

    /// A bad token is refused with the place it came from named, because "32
    /// lowercase hex" is not a useful sentence about a file.
    #[test]
    fn a_refused_token_names_where_it_came_from() {
        let why = resolve(
            Some("NOPE"),
            None,
            None,
            &TokenStore::default(),
            "192.168.0.44",
        )
        .expect_err("bad token");
        assert_eq!(why, format!("--lan-token: {TOKEN_ERROR}"));
        let why = resolve(
            None,
            None,
            Some("NOPE"),
            &TokenStore::default(),
            "192.168.0.44",
        )
        .expect_err("bad token");
        assert_eq!(why, format!("{TOKEN_ENV}: {TOKEN_ERROR}"));
    }

    /// A token file that cannot be read is a failure, not "no token": the user
    /// asked for a token to come from there.
    #[test]
    fn an_unreadable_token_file_is_an_error() {
        let missing = PathBuf::from("/nonexistent/linkr-token");
        let why = resolve(
            None,
            Some(&missing),
            None,
            &TokenStore::default(),
            "192.168.0.44",
        )
        .expect_err("missing file");
        assert!(why.starts_with("/nonexistent/linkr-token"), "{why}");
    }

    /// A line that quotes a token is scrubbed before it is shown, wherever the
    /// token came from.
    #[test]
    fn a_redacted_line_loses_every_token_shaped_word() {
        let upper = TOKEN.to_uppercase();
        let line = format!("bridge said token={TOKEN} and {upper} then fine");
        let scrubbed = redact(&line);
        assert!(!scrubbed.contains(TOKEN), "{scrubbed}");
        assert!(scrubbed.contains(TOKEN_MASK), "{scrubbed}");
        assert!(
            scrubbed.contains(&format!("and {upper} then")),
            "an upper-case spelling is not this token and is not scrubbed: {scrubbed}"
        );
        // Ordinary text is left exactly as it was.
        assert_eq!(redact("reboot at 115200 baud"), "reboot at 115200 baud");
        // A longer hexadecimal run is a hash or a MAC, not a token, and half a
        // replacement would be worse than none.
        let long = format!("{TOKEN}00");
        assert_eq!(redact(&long), long);
        // And a multi-byte glyph beside a token survives whole.
        let mixed = format!("令牌={TOKEN} 完成");
        assert_eq!(redact(&mixed), format!("令牌={TOKEN_MASK} 完成"));
    }
}
