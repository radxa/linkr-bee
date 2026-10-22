//! The thin scrollbar the pane and the long lists carry when they do not fit.
//!
//! One helper rather than ratatui's widget painted five ways: a bar is three
//! numbers — how much there is, where the window starts, how much it shows —
//! and every caller computes them from its own state. What this module
//! decides is the look: a thumb and nothing else. A track and arrow heads down
//! the side of a terminal is a rule of box characters competing with the
//! device's own output, and the bar's job is to be noticed only when there is
//! something above or below to reach.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::{Scrollbar, ScrollbarOrientation, ScrollbarState};
use ratatui::Frame;

use crate::capability::GlyphSet;

/// Draw a thumb-only scrollbar down `area`'s right column.
///
/// `total` is the content's length in rows, `top` the first row the window
/// shows, and `viewport` how many rows it shows. Nothing is drawn when
/// everything fits: ratatui's widget fills the whole track in that case, which
/// reads as "there is more", the one thing it must never mean.
///
/// The thumb is half a box rule, so the bar reads as chrome rather than as
/// text the device sent — and `|` where the font has no half rules
/// ([`GlyphSet::thumb`]).
pub fn draw(
    frame: &mut Frame,
    area: Rect,
    total: usize,
    top: usize,
    viewport: usize,
    style: Style,
    glyphs: GlyphSet,
) {
    if total <= viewport || viewport == 0 || area.width == 0 || area.height == 0 {
        return;
    }
    // ratatui counts a scrollbar's length in *positions*: its `position` runs
    // to `content_length - 1`, and it sizes the thumb against
    // `content_length - 1 + viewport`. A window over `total` rows has exactly
    // `total - viewport + 1` positions, so handing the widget that count —
    // rather than the row count — makes its arithmetic and this module's window
    // model agree: the thumb is `viewport / total` of the track, flush with the
    // top when the window is at the top and with the bottom when it is at the
    // bottom. With the row count it stops one row short of the bottom, the one
    // place the eye checks it.
    let mut state = ScrollbarState::new(total - viewport + 1)
        .position(top.min(total - viewport))
        .viewport_content_length(viewport);
    let bar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
        .thumb_symbol(glyphs.thumb())
        .track_symbol(None)
        .begin_symbol(None)
        .end_symbol(None)
        .thumb_style(style);
    frame.render_stateful_widget(bar, area, &mut state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    /// The right-edge column of a frame drawn by `draw`, top to bottom.
    fn column(total: usize, top: usize, viewport: usize, height: u16) -> Vec<String> {
        let mut terminal =
            Terminal::new(TestBackend::new(3, height)).expect("a test terminal paints");
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    frame.area(),
                    total,
                    top,
                    viewport,
                    Style::default(),
                    GlyphSet::Unicode,
                );
            })
            .expect("the bar draws");
        let buffer = terminal.backend().buffer().clone();
        (0..height)
            .map(|y| buffer[(2, y)].symbol().to_string())
            .collect()
    }

    /// A bar with something to scroll is on screen, with the thumb at the top
    /// when the window is at the top — and at the bottom when it is at the
    /// bottom of the content.
    #[test]
    fn the_thumb_walks_down_the_track_with_the_window() {
        let top = column(100, 0, 10, 10);
        assert!(
            top.iter().any(|cell| cell == GlyphSet::Unicode.thumb()),
            "{top:?}"
        );
        assert_eq!(
            top[0],
            GlyphSet::Unicode.thumb(),
            "the window starts at the first row"
        );

        let bottom = column(100, 90, 10, 10);
        assert_eq!(
            bottom[9],
            GlyphSet::Unicode.thumb(),
            "and ends on the last one"
        );
        assert_ne!(bottom[0], GlyphSet::Unicode.thumb());
    }

    /// Everything fits: no bar at all. A full track would read as "there is
    /// more", which is exactly what there is not.
    #[test]
    fn nothing_is_drawn_when_the_content_fits() {
        for (total, viewport) in [(10, 10), (4, 10), (10, 0)] {
            let drawn = column(total, 0, viewport, 10);
            assert!(
                drawn.iter().all(|cell| cell != GlyphSet::Unicode.thumb()),
                "{total}/{viewport} drew a bar: {drawn:?}"
            );
        }
        // And a degenerate area is not a panic.
        let mut terminal = Terminal::new(TestBackend::new(1, 1)).expect("a test terminal paints");
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    Rect::new(0, 0, 1, 0),
                    100,
                    0,
                    10,
                    Style::default(),
                    GlyphSet::Unicode,
                );
            })
            .expect("a zero-height area draws nothing");
    }
}
