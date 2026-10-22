//! Toasts: the short-lived notices that float over the top-right corner.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};

use crate::app::{App, Notice};
use crate::theme::Theme;

/// How many columns of padding sit inside a toast's border.
const PADDING: usize = 2;

/// How long before its time a toast starts to dim. The last stretch of a
/// notice's life, which is warning enough to read it as leaving rather than as
/// gone.
const FADE: std::time::Duration = std::time::Duration::from_millis(700);

/// A toast's body: the notice text, one line per notice, in the current theme.
///
/// This is where a notice's text is folded: the stack is painted chrome, and
/// a notice built from an interface string — `connecting…`, `Not connected —
/// nothing was sent.` — carries marks a terminal without them cannot show. The
/// log keeps the words the notice was pushed with; only the box translates.
pub fn lines(app: &App, theme: &Theme) -> Vec<Line<'static>> {
    let now = std::time::Instant::now();
    app.notices
        .iter()
        .enumerate()
        .map(|(index, notice)| {
            // The dim belongs to the *stack*, not to the notice: the log
            // keeps every word at full strength, and a notice that outlives
            // its toast is read there.
            let style = match app.toast_until.get(index) {
                Some(until) if until.saturating_duration_since(now) < FADE => theme.muted(),
                _ => theme.toast(),
            };
            Line::from(Span::styled(theme.fold(&notice.text).into_owned(), style))
        })
        .collect()
}

/// The width a toast needs for its text, border and padding included, so the
/// box hugs its content instead of taking a guessed slice of the screen. An
/// empty stack needs no box at all, and says so with zero.
///
/// Measured on the folded text, which is what [`lines`] paints: `…` stands for
/// three cells once it is folded, and a box sized on the unfolded string would
/// be three columns short.
pub fn width(notices: &[Notice], glyphs: crate::capability::GlyphSet) -> u16 {
    if notices.is_empty() {
        return 0;
    }
    let widest = notices
        .iter()
        .map(|notice| {
            let text = crate::capability::fold(&notice.text, glyphs);
            unicode_width::UnicodeWidthStr::width(text.as_ref())
        })
        .max()
        .unwrap_or(0);
    // Two border columns plus the padding on each side.
    (widest + 2 * PADDING + 2) as u16
}

/// The level whose border a stack of toasts should wear: the loudest notice
/// present, so an error is never framed as a mere info.
pub fn border_level(notices: &[Notice]) -> Option<crate::event::NoticeLevel> {
    use crate::event::NoticeLevel;
    let mut level = None;
    for notice in notices {
        let candidate = notice.level;
        level = match (level, candidate) {
            (Some(NoticeLevel::Error), _) | (_, NoticeLevel::Error) => Some(NoticeLevel::Error),
            (Some(NoticeLevel::Warn), _) | (_, NoticeLevel::Warn) => Some(NoticeLevel::Warn),
            _ => Some(NoticeLevel::Info),
        };
    }
    level
}

/// Clear the column just left of a toast box of any glyph wide enough to be
/// drawn into the column the box's own left edge is in.
///
/// A terminal draws a glyph two cells wide across both of them — a CJK word in
/// the sidebar, an emoji in a device name — and the second cell is drawn over
/// whatever the frame put there. When that cell is the box's left edge, the
/// frame still says the border is there and the screen says otherwise: the box
/// comes up with a hole down the middle of its side, which is what a
/// screenshot showed. The column is therefore given up before the edge is
/// drawn, so that nothing reaches into it. Only wide glyphs go: the column
/// belongs to whatever is behind the toast, and a narrow glyph is not in the
/// edge's way.
pub fn clear_the_edge(buffer: &mut Buffer, corner: Rect) {
    use ratatui::buffer::CellWidth;
    let Some(x) = corner.x.checked_sub(1) else {
        return;
    };
    for y in corner.y..corner.bottom() {
        if let Some(cell) = buffer.cell_mut((x, y)) {
            if cell.cell_width() > 1 {
                cell.set_symbol(" ");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::NoticeLevel;

    fn notice(text: &str, level: NoticeLevel) -> Notice {
        Notice {
            text: text.to_string(),
            level,
        }
    }

    /// No notices, no toast: an empty stack paints nothing and asks for no box.
    #[test]
    fn an_empty_stack_paints_nothing() {
        let app = App::default();
        assert!(lines(&app, &Theme::DARK).is_empty());
        assert_eq!(width(&[], crate::capability::GlyphSet::Unicode), 0);
        assert_eq!(border_level(&[]), None);
    }

    /// One line per notice, each on the toast ground, whatever its level — the
    /// level shows in the border, never by recolouring the text.
    #[test]
    fn every_notice_gets_one_line_on_the_toast_ground() {
        let mut app = App::default();
        app.push_notice(notice("连接中…", NoticeLevel::Info));
        app.push_notice(notice("boom", NoticeLevel::Error));
        let painted = lines(&app, &Theme::DARK);
        assert_eq!(painted.len(), 2);
        assert_eq!(painted[0].spans[0].content, "连接中…");
        assert_eq!(painted[1].spans[0].content, "boom");
        for line in &painted {
            assert_eq!(line.spans[0].style.bg, Some(Theme::DARK.panel_3));
            assert_eq!(line.spans[0].style.fg, Some(Theme::DARK.text));
        }
    }

    /// A toast dims in its last stretch, and the dim is the stack's business
    /// only: the notice the log holds keeps its full-strength words.
    #[test]
    fn a_toast_dims_before_it_goes() {
        let mut app = App::default();
        app.push_notice(notice("going", NoticeLevel::Info));
        app.push_notice(notice("fresh", NoticeLevel::Info));
        let now = std::time::Instant::now();
        app.toast_until[0] = now;
        app.toast_until[1] = now + crate::app::TOAST_LIFETIME;

        let painted = lines(&app, &Theme::DARK);
        assert_eq!(
            painted[0].spans[0].style,
            Theme::DARK.muted(),
            "the one whose time is up dims"
        );
        assert_eq!(
            painted[1].spans[0].style,
            Theme::DARK.toast(),
            "and a fresh one does not"
        );
    }

    /// The box is as wide as the widest notice plus its chrome: a wide (CJK)
    /// notice must not be clipped by a box sized for a narrow one.
    #[test]
    fn the_box_hugs_the_widest_notice() {
        use crate::capability::GlyphSet;
        let narrow = notice("hi", NoticeLevel::Info);
        let wide = notice("主题: 浅色", NoticeLevel::Info);
        let narrow_width = width(&[narrow], GlyphSet::Unicode);
        let wide_width = width(std::slice::from_ref(&wide), GlyphSet::Unicode);
        assert!(wide_width > narrow_width);
        let widest = unicode_width::UnicodeWidthStr::width(wide.text.as_str()) as u16;
        assert_eq!(wide_width, widest + 6);
        // The folded text is what the box is measured on: `…` stands for three
        // cells in the ASCII set, and a box sized on one would be two short.
        let dotted = notice("connecting…", NoticeLevel::Info);
        assert_eq!(
            width(std::slice::from_ref(&dotted), GlyphSet::Ascii),
            width(std::slice::from_ref(&dotted), GlyphSet::Unicode) + 2
        );
    }

    /// The border wears the loudest level in the stack, so an error is never
    /// framed as an info just because an info arrived later.
    #[test]
    fn the_border_wears_the_loudest_level() {
        use NoticeLevel::*;
        assert_eq!(border_level(&[notice("a", Info)]), Some(Info));
        assert_eq!(
            border_level(&[notice("a", Info), notice("b", Warn)]),
            Some(Warn)
        );
        assert_eq!(
            border_level(&[notice("a", Warn), notice("b", Info)]),
            Some(Warn)
        );
        assert_eq!(
            border_level(&[notice("a", Warn), notice("b", Error)]),
            Some(Error)
        );
        assert_eq!(
            border_level(&[notice("a", Error), notice("b", Info)]),
            Some(Error)
        );
        assert_eq!(
            border_level(&[notice("a", Info), notice("b", Error), notice("c", Warn)]),
            Some(Error)
        );
    }

    /// The column before the box gives up its wide glyphs and keeps everything
    /// else: a glyph that would be drawn into the border's own column is the
    /// hole the sweep exists to prevent.
    #[test]
    fn the_column_before_the_box_gives_up_anything_wide() {
        use ratatui::style::{Color, Style};
        let mut buffer = Buffer::empty(Rect::new(0, 0, 8, 3));
        // A wide glyph reaching into the box's left edge at x = 4.
        buffer[(3, 0)]
            .set_symbol("中")
            .set_style(Style::default().fg(Color::Red));
        // A narrow one: not in the edge's way.
        buffer[(3, 1)].set_symbol("x");
        // A wide glyph whose second cell stops one short of the edge.
        buffer[(2, 2)].set_symbol("中");

        clear_the_edge(&mut buffer, Rect::new(4, 0, 4, 3));

        assert_eq!(buffer[(3, 0)].symbol(), " ", "nothing may reach the edge");
        assert_eq!(
            buffer[(3, 0)].fg,
            Color::Red,
            "and the column keeps the ink it was painted in"
        );
        assert_eq!(buffer[(3, 1)].symbol(), "x", "a narrow glyph stays");
        assert_eq!(
            buffer[(2, 2)].symbol(),
            "中",
            "a glyph that stops short stays"
        );
        assert_eq!(buffer[(3, 2)].symbol(), " ");

        // A box at the frame's own left edge has no column to give: it is
        // drawn as it is rather than carved out of the buffer's edge.
        clear_the_edge(&mut buffer, Rect::new(0, 0, 4, 3));
        assert_eq!(buffer[(0, 0)].symbol(), " ");
    }
}
