//! Shared vocabulary: the small enums every other module names.

/// Where the session stands. Drives the status dot, the toast and the text in
/// the bars — one state, one meaning, everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Failed,
}

/// The glyphs that stand for the states, as the design draws them: a ring at
/// rest, a half-filled disc while dialling, a filled one when the link is up,
/// and a diamond when it broke.
///
/// Which mark goes with which state, in the set the terminal actually has, is
/// [`crate::capability::GlyphSet::state`] — the one place the bars ask, so the
/// top bar, the sidebar row and the bottom bar cannot disagree about what the
/// session is doing.
pub const STATE_GLYPHS: [&str; 4] = ["○", "◐", "●", "◆"];

/// How loud a notice is. Toasts, the notice log and inline messages all colour
/// themselves from this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
}

/// The centre-column views, in sidebar order. The F-key rota (`F2`–`F5`)
/// follows this order, so inserting a view in the middle shifts the rota with
/// it instead of leaving a gap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Terminal,
    Diagnostics,
    Network,
    Assistant,
}

impl View {
    /// Every view, in the order the sidebar lists them and the F-keys walk.
    pub const ALL: [View; 4] = [
        View::Terminal,
        View::Diagnostics,
        View::Network,
        View::Assistant,
    ];

    /// The function key that selects this view: `F2` for the serial terminal
    /// through `F5` for the assistant, matching the hint in the bottom bar.
    pub fn fkey(self) -> u8 {
        match self {
            View::Terminal => 2,
            View::Diagnostics => 3,
            View::Network => 4,
            View::Assistant => 5,
        }
    }

    /// The view asked for by an F-key, if any.
    pub fn from_fkey(key: u8) -> Option<View> {
        View::ALL.into_iter().find(|view| view.fkey() == key)
    }

    /// The spelling a command line or a settings file uses.
    pub fn as_str(self) -> &'static str {
        match self {
            View::Terminal => "terminal",
            View::Diagnostics => "diagnostics",
            View::Network => "network",
            View::Assistant => "assistant",
        }
    }

    /// The view a name refers to. Unknown names give `None`, so a caller can
    /// report the bad value instead of silently showing the wrong view.
    pub fn from_name(name: &str) -> Option<View> {
        View::ALL
            .into_iter()
            .find(|view| view.as_str() == name.trim().to_ascii_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The F-key rota is a bijection over the views: every key maps to exactly
    /// one view and every view is reachable, so no view is orphaned.
    #[test]
    fn the_fkey_rota_covers_every_view_exactly_once() {
        let keys: Vec<u8> = View::ALL.iter().map(|v| v.fkey()).collect();
        assert_eq!(keys, vec![2, 3, 4, 5]);
        for view in View::ALL {
            assert_eq!(View::from_fkey(view.fkey()), Some(view));
        }
        for key in [0, 1, 7, 12, 255] {
            assert_eq!(View::from_fkey(key), None);
        }
    }

    /// The sidebar order and the F-key order are the same list, so the hint in
    /// the bottom bar can never disagree with the sidebar.
    #[test]
    fn sidebar_order_is_the_fkey_order() {
        let mut sorted = View::ALL;
        sorted.sort_by_key(|v| v.fkey());
        assert_eq!(sorted, View::ALL);
    }

    /// Every view round-trips through its spelling, the names are distinct and
    /// a name that is not a view is refused rather than guessed at.
    #[test]
    fn every_view_round_trips_through_its_name() {
        let names: Vec<&str> = View::ALL.iter().map(|v| v.as_str()).collect();
        assert_eq!(
            names,
            vec!["terminal", "diagnostics", "network", "assistant"]
        );
        let mut unique = names.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), names.len(), "two views share a name");
        for view in View::ALL {
            assert_eq!(View::from_name(view.as_str()), Some(view));
        }
        assert_eq!(View::from_name(" NETWORK "), Some(View::Network));
        assert_eq!(View::from_name("files"), None);
        assert_eq!(View::from_name(""), None);
    }

    /// Every state mark is exactly one column wide and none of them is blank —
    /// the properties the bars depend on when they place one at column zero and
    /// the state's name after it. Which mark goes with which state is the glyph
    /// set's, and [`crate::capability::GlyphSet::state`] is tested there.
    #[test]
    fn every_state_mark_is_one_column_and_its_own() {
        for glyph in STATE_GLYPHS {
            assert_eq!(
                crate::text::columns(glyph),
                1,
                "{glyph:?} is not one column"
            );
        }
        let mut glyphs = STATE_GLYPHS.to_vec();
        glyphs.sort_unstable();
        let count = glyphs.len();
        glyphs.dedup();
        assert_eq!(glyphs.len(), count, "two states share a glyph");
        assert_eq!(STATE_GLYPHS, ["○", "◐", "●", "◆"]);
    }
}
