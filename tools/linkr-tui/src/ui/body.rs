//! The centre column: what sits beside the sidebar.
//!
//! The serial terminal is the exception among the views — it is a pane the
//! device writes into, not a framed document, so it takes the terminal ground
//! and no border. Every other view is a frame with a title. Views whose bodies
//! are still being built say so honestly instead of showing an empty frame.
//!
//! A body is a *pure function of the state plus the width it was given*: the
//! composition layer knows how wide the pane is and passes it down, so a view
//! never guesses its own size and never paints past it. That is the whole
//! contract, and it is why a body can be asserted on without a terminal.

use ratatui::layout::Rect;
use ratatui::text::Line;

use crate::app::App;
use crate::event::View;
use crate::theme::Theme;
use crate::views;

/// Whether a view is drawn as a framed document. The serial terminal is not.
pub fn is_framed(view: View) -> bool {
    !matches!(view, View::Terminal)
}

/// The ground the centre column sits on.
pub fn ground(app: &App, theme: &Theme) -> ratatui::style::Style {
    match app.view {
        View::Terminal => theme.terminal(),
        _ => theme.panel(),
    }
}

/// The first line a framed body starts painting at, for the views that keep a
/// scroll of their own.
///
/// Only the diagnostics document has one. A scroll past its last screenful is
/// pinned to that screenful rather than to blank paper, the way the pane's own
/// scroll arithmetic pins its window to the ends of the history.
pub fn scroll_offset(app: &App, total: usize, height: usize) -> usize {
    match app.view {
        View::Diagnostics => app.diagnostics.scroll.min(total.saturating_sub(height)),
        _ => 0,
    }
}

/// The body of a view, as lines for the area it was given.
///
/// The pane is handed the whole rectangle rather than a width because the
/// serial terminal is a *screen*: it shows a screenful of rows and wraps to the
/// width, so both numbers are part of what it paints. Every other view is a
/// document whose rows are laid out against the width alone, and it is given
/// exactly that so nothing in those views has to know the split exists.
pub fn lines(app: &App, theme: &Theme, area: Rect) -> Vec<Line<'static>> {
    let width = area.width;
    match app.view {
        // A pane, not a document: the device's output is the content, and until
        // it writes there is nothing — which is what the design's first frame
        // shows.
        View::Terminal => views::terminal::lines(app, theme, area),
        View::Diagnostics => views::diagnostics::lines(app, theme, width),
        View::Network => views::network::visible_lines(app, theme, width, area.height),
        View::Assistant => views::assistant::lines(app, theme, width),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Lang;

    /// An area for the tests: a pane `width` columns wide and 6 rows tall.
    fn area(width: u16) -> Rect {
        Rect::new(0, 0, width, 6)
    }

    /// The text of a body, for assertions about what a pane shows.
    fn text_of(rows: &[Line<'static>]) -> String {
        rows.iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect()
    }

    /// Only the diagnostics document scrolls, and a scroll past its last
    /// screenful is pinned to that screenful instead of to blank paper.
    #[test]
    fn only_the_diagnostics_document_scrolls() {
        let mut app = App::default();
        app.set_view(View::Diagnostics);
        app.diagnostics.scroll = 50;
        assert_eq!(scroll_offset(&app, 30, 10), 20, "pinned to the last screen");
        app.diagnostics.scroll = 3;
        assert_eq!(scroll_offset(&app, 30, 10), 3);
        app.diagnostics.scroll = 8;
        assert_eq!(
            scroll_offset(&app, 5, 10),
            0,
            "a short document cannot scroll"
        );
        app.set_view(View::Network);
        app.diagnostics.scroll = 50;
        assert_eq!(scroll_offset(&app, 30, 10), 0, "other views have no scroll");
    }

    /// The serial terminal is the only full-bleed view: it takes the terminal
    /// ground and no frame, so the device's output is not fenced in.
    #[test]
    fn the_serial_terminal_is_the_only_unframed_view() {
        for view in View::ALL {
            assert_eq!(is_framed(view), view != View::Terminal, "{view:?}");
        }
    }

    /// The ground follows the view: the terminal pane gets the terminal colour,
    /// every framed view gets the panel.
    #[test]
    fn the_ground_follows_the_view() {
        let theme = Theme::DARK;
        for view in View::ALL {
            let app = App {
                view,
                ..App::default()
            };
            let expected = if view == View::Terminal {
                theme.terminal_bg
            } else {
                theme.panel
            };
            assert_eq!(ground(&app, &theme).bg, Some(expected), "{view:?}");
        }
    }

    /// The terminal pane is a screen: it paints every row of its area. With a
    /// link open that is the device's screen; with nothing connected and
    /// nothing on the pane it is the empty state, which points at the
    /// sidebar. Every other view is a document that has something to say.
    #[test]
    fn the_terminal_pane_paints_a_screen_and_the_others_paint_documents() {
        let theme = Theme::DARK;
        for view in View::ALL {
            let app = App {
                view,
                ..App::default()
            };
            let rows = lines(&app, &theme, area(60));
            if view == View::Terminal {
                assert_eq!(rows.len(), 6, "{view:?} did not paint a screenful");
                assert!(
                    text_of(&rows).contains("还没有连接设备"),
                    "{view:?} painted neither a screen nor the empty state: {:?}",
                    text_of(&rows)
                );
            } else {
                assert!(
                    !text_of(&rows).trim().is_empty(),
                    "{view:?} painted nothing"
                );
            }
        }
    }

    /// Every view has a body that names itself, in either language. The
    /// terminal is the exception: it shows the device's bytes, not a title.
    #[test]
    fn every_view_names_itself() {
        let theme = Theme::DARK;
        for view in View::ALL {
            for lang in [Lang::Zh, Lang::En] {
                let mut app = App {
                    lang,
                    ..App::default()
                };
                app.view = view;
                if view == View::Terminal {
                    continue; // the pane carries the device's words, not its own
                }
                let text = text_of(&lines(&app, &theme, area(60)));
                assert!(
                    text.contains(lang.view_name(view)),
                    "{view:?} {lang:?}: {text:?}"
                );
            }
        }
    }

    /// A view's body is told how wide the pane is, and never paints past it —
    /// the contract the composition layer relies on.
    #[test]
    fn a_body_never_paints_past_the_width_it_was_given() {
        let theme = Theme::DARK;
        for width in [4u16, 12, 30, 80] {
            for view in View::ALL {
                let mut app = App {
                    view,
                    ..App::default()
                };
                // Give the terminal something to hold: an empty pane proves
                // nothing about wrapping.
                app.terminal
                    .push_text("a long line that has to fold somewhere\n中文也要折行\n");
                for line in lines(&app, &theme, area(width)) {
                    let joined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
                    assert!(
                        crate::text::columns(&joined) <= width as usize,
                        "{view:?} at {width}: {joined:?}"
                    );
                }
            }
        }
    }
}
