//! The startup splash: the mark, the name, and the way in.
//!
//! Not a dialog — nothing is asked and nothing is answered. It stands for a
//! moment over the whole frame, and any key, click or paste ends it early, so
//! it is drawn *instead of* the interface rather than over it: the first frame
//! the interface gets is a whole one, not one that had a splash peeled off it.
//!
//! The rows are the same things the design puts on the mark everywhere else —
//! [`crate::logo`] supplies the picture, `bee` and the version say what is
//! running — and the theme comes from the capability the whole interface is
//! drawn with, so a `LINKR_LOGO` or `LINKR_TUI_COLOR` override reaches this
//! frame the same way it reaches every other one. The mark is transparent,
//! exactly as it is on the About card: no plate and no colour behind it, so
//! the terminal's own ground shows through, and the name and the hint below
//! sit on that same ground.

use ratatui::layout::{Alignment, Rect};
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::app::App;
use crate::logo;

/// Paint the splash over `area`.
pub fn draw(frame: &mut Frame, app: &App, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let theme = app.theme();
    let s = app.strings();

    // Five rows of text hang under the mark — a blank, the name, the label, a
    // blank and the hint — and the mark only takes the room they leave it.
    let mut lines: Vec<Line<'static>> = logo::fitted_lines_on(
        app.capability,
        (area.width, area.height.saturating_sub(5)),
        theme.bg,
    );
    if !lines.is_empty() {
        lines.push(Line::default());
    }
    lines.push(Line::from(vec![
        Span::styled("bee", theme.accent_strong().add_modifier(Modifier::BOLD)),
        Span::styled(format!(" {}", env!("CARGO_PKG_VERSION")), theme.muted()),
    ]));
    lines.push(Line::from(Span::styled(
        theme.fold(s.splash_label).into_owned(),
        theme.text(),
    )));
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        theme.fold(s.splash_hint).into_owned(),
        theme.muted(),
    )));

    // Centred both ways: the block in the middle of the height, and each row
    // in the middle of the width. A terminal shorter than the block clips it
    // from its bottom rather than moving the mark off the top.
    let height = (lines.len() as u16).min(area.height);
    let rect = Rect {
        x: area.x,
        y: area.y + area.height.saturating_sub(lines.len() as u16) / 2,
        width: area.width,
        height,
    };
    frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), rect);
}
