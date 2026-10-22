//! The interface's own choices, remembered between runs.
//!
//! Ten small facts a user would resent retyping: which transport the sidebar
//! stood on, the LAN host they dial, the address and the name of the board they
//! last dialled, the view they were reading, the theme, the language, how the
//! Enter key is spelled on the wire, whether both directions are traced, and
//! whether the startup splash shows.
//! They live in the shared JSON shelf the agent stores already use — the
//! `tui.*` keys — because that file already has the one thing this needs and
//! would otherwise have to grow: an atomic write.
//!
//! Everything here is deliberately lossy. A value that is missing, empty or
//! unrecognised reads as `None`, and the caller decides the default; a settings
//! file broken by a hand edit costs a user their remembered view, never their
//! startup. Nothing secret is ever written: the LAN *token* is not here, and
//! the fields are what the sidebar would show anyway.

use crate::agent::config::Storage;
use crate::agent::store::JsonFile;
use crate::app::Transport;
use crate::event::View;
use crate::i18n::Lang;
use crate::serial::keys::EnterMode;
use crate::theme::ThemeChoice;

/// The keys, one per field. Prefixed rather than bare so the shelf reads as
/// having more than one tenant, which it does.
const TRANSPORT: &str = "tui.transport";
const LAN_HOST: &str = "tui.lan_host";
const ADDRESS: &str = "tui.address";
const DEVICE_NAME: &str = "tui.device_name";
const VIEW: &str = "tui.view";
const THEME: &str = "tui.theme";
const LANG: &str = "tui.lang";
const ENTER: &str = "tui.enter";
const DEBUG_IO: &str = "tui.debug_io";
const NO_SPLASH: &str = "tui.no_splash";

/// What the last run left behind. All optional: `None` means the user has
/// never chosen, and the caller's own default stands.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Settings {
    /// The transport the sidebar stood on. `stdio` is never stored: it is a
    /// command line's link, not a place the sidebar can stand.
    pub transport: Option<Transport>,
    /// The LAN host as last typed or dialled. Empty when never given.
    pub lan_host: String,
    /// The address of the last board dialled over Bluetooth, so a bench with
    /// one board does not make the user find it again every morning.
    pub address: String,
    /// The name the board answered to — `Linkr Bee 078C` — which the Device
    /// row says beside the tail of the address. The address alone leaves the
    /// row a bare MAC: everything to a scanner, nothing to the person looking
    /// at the bench.
    pub device_name: String,
    /// The view the keyboard was on.
    pub view: Option<View>,
    pub theme: Option<ThemeChoice>,
    pub lang: Option<Lang>,
    /// How the Enter key is spelled on the wire. `None` is the reference
    /// client's own default.
    pub enter: Option<EnterMode>,
    /// Whether both directions were traced to standard error. Persisted, so a
    /// trace turned on to watch a problem is still on when it is reproduced
    /// after a restart.
    pub debug_io: bool,
    /// Whether the startup splash is skipped. Persisted, so a user who put it
    /// away once is not made to put it away every morning — and stored the
    /// second, unusual way round so that the default (a missing key) is the
    /// splash showing.
    pub no_splash: bool,
}

/// The settings, on disk.
///
/// A thin face over [`JsonFile`]: reads never fail and writes are one small
/// atomic file, which is the whole reason this did not grow a parser of its
/// own.
#[derive(Debug)]
pub struct SettingsStore {
    file: JsonFile,
}

impl SettingsStore {
    /// The store in the user's configuration directory.
    pub fn load() -> SettingsStore {
        SettingsStore {
            file: JsonFile::load(),
        }
    }

    /// The store at `path`, for a test that wants its own file.
    pub fn at(path: impl Into<std::path::PathBuf>) -> SettingsStore {
        SettingsStore {
            file: JsonFile::at(path),
        }
    }

    /// Read every field. Anything unreadable reads as "never chosen".
    pub fn read(&self) -> Settings {
        Settings {
            transport: self
                .file
                .get(TRANSPORT)
                .as_deref()
                .and_then(Transport::from_name)
                .filter(|kind| *kind != Transport::Stdio),
            lan_host: self.file.get(LAN_HOST).unwrap_or_default(),
            address: self.file.get(ADDRESS).unwrap_or_default(),
            device_name: self.file.get(DEVICE_NAME).unwrap_or_default(),
            view: self.file.get(VIEW).as_deref().and_then(View::from_name),
            theme: self
                .file
                .get(THEME)
                .as_deref()
                .and_then(ThemeChoice::from_name),
            lang: self.file.get(LANG).as_deref().and_then(Lang::from_name),
            enter: self
                .file
                .get(ENTER)
                .as_deref()
                .and_then(EnterMode::from_name),
            debug_io: self.file.get(DEBUG_IO).as_deref() == Some("true"),
            no_splash: self.file.get(NO_SPLASH).as_deref() == Some("true"),
        }
    }

    /// Write every field back, in one file.
    ///
    /// One pass over the file rather than one per key: the settings and the
    /// agent's own state share this JSON, and each pass is a chance to drop a
    /// key the other door has just written — see [`JsonFile::update`].
    pub fn write(&mut self, settings: &Settings) {
        // The transport is the one field with a third state: writing `stdio`
        // would pin the next run to a link only a command line can build, so
        // it is stored as nothing rather than as a lie.
        let transport = settings
            .transport
            .filter(|kind| *kind != Transport::Stdio)
            .map(Transport::as_str)
            .unwrap_or_default();
        self.file.update(|data| {
            let mut put = |key: &str, value: &str| {
                data.insert(key.to_string(), value.to_string());
            };
            put(TRANSPORT, transport);
            put(LAN_HOST, settings.lan_host.trim());
            put(ADDRESS, settings.address.trim());
            put(DEVICE_NAME, settings.device_name.trim());
            put(VIEW, settings.view.map(View::as_str).unwrap_or_default());
            put(
                THEME,
                settings.theme.map(ThemeChoice::as_str).unwrap_or_default(),
            );
            put(LANG, settings.lang.map(Lang::as_str).unwrap_or_default());
            put(
                ENTER,
                settings.enter.map(EnterMode::as_name).unwrap_or_default(),
            );
            // The booleans, spelled the one way: anything else, a hand edit
            // included, reads as off rather than as an error.
            put(DEBUG_IO, if settings.debug_io { "true" } else { "" });
            put(NO_SPLASH, if settings.no_splash { "true" } else { "" });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "linkr-tui-settings-{}-{name}.json",
            std::process::id()
        ))
    }

    /// What is written is what is read, field for field.
    #[test]
    fn a_round_trip_remembers_every_choice() {
        let path = tmp("round-trip");
        let _ = std::fs::remove_file(&path);
        let mut store = SettingsStore::at(&path);
        let settings = Settings {
            transport: Some(Transport::Lan),
            lan_host: "192.168.0.100".to_string(),
            address: "EE:C7:42:34:48:CF".to_string(),
            device_name: "Linkr BLE UART-1".to_string(),
            view: Some(View::Network),
            theme: Some(ThemeChoice::Light),
            lang: Some(Lang::En),
            enter: Some(EnterMode::Crlf),
            debug_io: true,
            no_splash: true,
        };
        store.write(&settings);
        assert_eq!(store.read(), settings);
        let _ = std::fs::remove_file(&path);
    }

    /// A file that is not there yet is not an error: every field reads as
    /// "never chosen" and the caller's defaults stand.
    #[test]
    fn nothing_chosen_reads_as_nothing() {
        let path = tmp("missing");
        let _ = std::fs::remove_file(&path);
        let store = SettingsStore::at(&path);
        assert_eq!(store.read(), Settings::default());
    }

    /// A hand-edited file with a word this build does not know costs the user
    /// that one field, not the whole startup.
    #[test]
    fn unrecognised_words_are_ignored() {
        let path = tmp("garbage");
        std::fs::write(
            &path,
            r#"{"tui.transport":"hovercraft","tui.lan_host":"192.168.0.100",
                "tui.view":"nowhere","tui.theme":"purple","tui.lang":"klingon",
                "tui.enter":"cr-lf","tui.debug_io":"yes","tui.no_splash":"yes"}"#,
        )
        .expect("the test writes its own file");
        let read = SettingsStore::at(&path).read();
        assert_eq!(read.transport, None);
        assert_eq!(read.view, None);
        assert_eq!(read.theme, None);
        assert_eq!(read.lang, None);
        assert_eq!(read.enter, None);
        assert!(!read.debug_io, "an unrecognised word is not an on");
        assert!(!read.no_splash, "an unrecognised word is not an on");
        assert_eq!(read.lan_host, "192.168.0.100");
        let _ = std::fs::remove_file(&path);
    }

    /// `stdio` is a command line's link: it is not written, and a file that
    /// names it anyway reads as "never chosen".
    #[test]
    fn stdio_is_not_a_place_the_sidebar_stands() {
        let path = tmp("stdio");
        std::fs::write(&path, r#"{"tui.transport":"stdio"}"#)
            .expect("the test writes its own file");
        assert_eq!(SettingsStore::at(&path).read().transport, None);

        let mut store = SettingsStore::at(&path);
        store.write(&Settings {
            transport: Some(Transport::Stdio),
            ..Settings::default()
        });
        assert_eq!(store.read().transport, None);
        let _ = std::fs::remove_file(&path);
    }
}
