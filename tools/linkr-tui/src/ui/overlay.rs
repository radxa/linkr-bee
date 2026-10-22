//! The modal layer: the command palette, and the dialogs that go over it.
//!
//! Painting lives here rather than in `palette`/`dialogs` so those two stay
//! headless — their state, their arithmetic and their keys are testable without
//! a terminal, and this is the only place that knows what a `Rect` is.
//!
//! A modal *covers* the frame rather than reflowing it: the design's layout is
//! the same whether or not an overlay is up, so the region under the box is
//! cleared first and everything else is left exactly where it was.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::{Clear, Paragraph};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

use crate::app::App;
use crate::{dialogs, palette};

use super::scroll;

/// How much of the region a dialog asks for.
const DIALOG_WIDTH_PERCENT: u16 = 78;

/// The palette asks for more of it: its rows are a table, and a table that has
/// to clip is a table the user cannot read.
const PALETTE_WIDTH_PERCENT: u16 = 92;

/// How much of the region a modal asks for vertically.
const HEIGHT_PERCENT: u16 = 76;

/// The room a modal needs before it is worth showing at all. Below this the box
/// would be its own border with nothing inside, which is worse than leaving the
/// view visible.
const MIN_WIDTH: u16 = 24;
const MIN_HEIGHT: u16 = 5;

/// The widest a modal grows, so a very wide terminal does not stretch the
/// palette's columns across the screen.
const MAX_WIDTH: u16 = 96;

/// Paint whichever modal is open.
///
/// The two modals are a stack, and only the top of it is painted. A dialog is
/// raised *over* the palette — `dialogs` closes the palette when it opens — so
/// a dialog wins; the palette is painted only when no dialog is up, which is
/// the state Ctrl+P leaves behind when it opens over one. Painting both was
/// what made Ctrl+P look dead: the palette was open but hidden under the
/// dialog, and the keyboard went to the dialog, so Escape was the only way to
/// find it again.
///
/// A modal is centred in the *centre column*, not over the whole frame: the
/// rail, the counters and the key hints stay visible, which is the point of a
/// palette that can be read while the session is still running. The docked
/// assistant panel yields the modal's rows the way the rail does: with the
/// panel up, the centre column is what is left of it, and the box is centred
/// in that.
pub fn paint(frame: &mut Frame, app: &App, area: Rect) {
    let region = super::regions_for(area, app.sidebar_visible, app.panel_wanted()).centre;
    if region.width < MIN_WIDTH || region.height < MIN_HEIGHT {
        return;
    }
    // Top of the stack first. A dialog closes the palette when it opens, so
    // the only way both are up is `Ctrl+P` raising the palette *over* a
    // dialog — and that is the one the keyboard answers to, so that is the
    // one that is painted.
    if let Some(state) = &app.palette {
        paint_palette(frame, app, state, region);
    } else if let Some(dialog) = &app.dialog {
        paint_dialog(frame, app, dialog, region);
    }
}

/// A `width`×`height` box centred in `area`, never larger than it.
fn centred(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect {
        x: area.x + (area.width - width) / 2,
        y: area.y + (area.height - height) / 2,
        width,
        height,
    }
}

/// Blank the half of a wide character that the modal's left edge would split.
///
/// A character that begins in the column left of `rect` is drawn by the
/// terminal across both of its cells. The box's `Clear` then writes into the
/// glyph's tail cell, the border over that — and the terminal keeps the glyph
/// and drops what was written into the tail, so the box's edge breaks and half
/// a character hangs beside it. The report was the empty pane's hint beside
/// the device picker: its first character sat exactly there, and the row it
/// crossed was the legend's, which is what made it read as `Esc` overhanging
/// the border.
///
/// Half a character is unreadable anyway, so the box may have it; a whole
/// border is not, so the half outside is blanked before the box is cleared.
/// The device's own text gets the same treatment wherever it meets an edge.
fn release_left_edge(buf: &mut Buffer, rect: Rect) {
    if rect.x == 0 {
        return;
    }
    for y in rect.top()..rect.bottom() {
        let x = rect.x - 1;
        if UnicodeWidthStr::width(buf[(x, y)].symbol()) >= 2 {
            buf[(x, y)].set_symbol(" ");
        }
    }
}

/// How tall a modal box may be in a region of `height` rows.
///
/// The floor is hardened against the region: a window shorter than
/// `MIN_HEIGHT` would make `clamp`'s own bounds cross, and the guard in
/// `paint` is a fragile place to keep that from happening.
fn ceiling_height(height: u16) -> u16 {
    // Wide arithmetic before the cast: a region taller than 862 rows is
    // reachable from the command line (`--print-frame`), and a percentage
    // multiplication that overflows is a panic where a clamp was meant.
    let share = (u32::from(height) * u32::from(HEIGHT_PERCENT) / 100) as u16;
    share.clamp(MIN_HEIGHT, height.max(MIN_HEIGHT))
}

/// The height of a dialog box for a body of `body_rows`: the body plus the two
/// border rows and the legend row, between the modal minimum and the region's
/// ceiling. `paint_dialog` and `dialog_body_room` must agree on this, and this
/// is what keeps them at it.
fn box_height(body_rows: usize, ceiling: u16) -> u16 {
    (body_rows as u16 + 3).clamp(MIN_HEIGHT, ceiling)
}

/// The size a modal asks for, given how much of the width it wants.
fn wanted(area: Rect, share: u16, max_height: u16) -> (u16, u16) {
    // Wide like the ceiling above: the frame's own width times a share of it
    // must not wrap before the clamp that was written for oversized values.
    let width = ((u32::from(area.width) * u32::from(share) / 100) as u16)
        .clamp(MIN_WIDTH, MAX_WIDTH)
        .min(area.width);
    let height = ceiling_height(area.height).min(max_height);
    (width, height)
}

/// How many rows of a dialog body a `screen`-sized frame shows.
///
/// For the one caller that has to ask *between* two paints: the settings
/// window follows its caret, and a key is handled outside any frame. The
/// arithmetic is `paint_dialog`'s own, through the same two helpers and the
/// same regions. Zero means the modal is not painted at this size — the
/// region is below the minimum, or no frame has been drawn yet — and the
/// caller keeps its scroll.
pub fn dialog_body_room(screen: Rect, sidebar: bool, panel: bool, body_rows: usize) -> usize {
    let region = super::regions_for(screen, sidebar, panel).centre;
    if region.width < MIN_WIDTH || region.height < MIN_HEIGHT {
        return 0;
    }
    box_height(body_rows, ceiling_height(region.height)).saturating_sub(3) as usize
}

/// How wide a dialog body is drawn at a `screen`-sized frame.
///
/// [`dialog_body_room`]'s other half, for the callers that have to measure
/// rows between two paints: the picker's scroll has to know the width a row
/// will be wrapped at before the frame that wraps it is painted. The
/// arithmetic is `paint_dialog`'s own; zero means the modal is not painted at
/// this size, the same as the room above.
pub fn dialog_body_width(screen: Rect, sidebar: bool, panel: bool) -> u16 {
    let region = super::regions_for(screen, sidebar, panel).centre;
    if region.width < MIN_WIDTH || region.height < MIN_HEIGHT {
        return 0;
    }
    wanted(region, DIALOG_WIDTH_PERCENT, region.height)
        .0
        .saturating_sub(2)
}

fn paint_dialog(frame: &mut Frame, app: &App, dialog: &dialogs::Dialog, area: Rect) {
    let theme = app.theme();
    // As tall as its content, up to the ceiling the region allows: the body
    // scrolls, so a box that is too tall wastes the pane behind it, and a box
    // that is too short would refuse to show a long notice.
    let (width, ceiling) = wanted(area, DIALOG_WIDTH_PERCENT, area.height);
    let body = dialogs::body_height(app, dialog, width.saturating_sub(2));
    let height = box_height(body, ceiling);
    let rect = centred(area, width, height);
    release_left_edge(frame.buffer_mut(), rect);
    frame.render_widget(Clear, rect);

    let block = theme.overlay_block(dialogs::title(dialog, app.lang));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);

    // The legend rides the box's bottom row, so it stays put however far the
    // body has been scrolled.
    let body_height = inner.height.saturating_sub(1) as usize;
    let mut lines = dialogs::lines(dialog, app, inner.width, body_height);
    lines.push(dialogs::legend(dialog, app.lang, &theme));
    frame.render_widget(Paragraph::new(lines).style(theme.card()), inner);

    // The bar rides the box's own right border rather than the body's last
    // column: a wrapped row may fill its width to the edge, and a bar over
    // the text would eat the last glyph of every such row. The border is
    // chrome already, so the thumb replaces a stretch of it.
    let window = Rect {
        x: inner.right(),
        width: 1,
        height: body_height as u16,
        ..inner
    };
    let top = dialog.scroll().min(body.saturating_sub(body_height));
    scroll::draw(
        frame,
        window,
        body,
        top,
        body_height,
        theme.scrollbar(),
        theme.glyphs(),
    );
}

fn paint_palette(frame: &mut Frame, app: &App, state: &palette::PaletteState, area: Rect) {
    let theme = app.theme();
    // prompt + separator + blank + legend, plus the box's own two rows: the
    // window is whatever is left, capped at the registry's own maximum — and
    // at the rows the level has, so the menu is a short box rather than
    // a tall one with empty air under it.
    const CHROME_ROWS: u16 = 6;
    let room = area.height.saturating_sub(CHROME_ROWS) as usize;
    let rows = palette::rows_in(state.level, &state.query);
    let visible = palette::MAX_VISIBLE.min(room).max(1).min(rows.len().max(1));
    let (width, _) = wanted(area, PALETTE_WIDTH_PERCENT, area.height);
    let rect = centred(area, width, visible as u16 + CHROME_ROWS);
    release_left_edge(frame.buffer_mut(), rect);
    frame.render_widget(Clear, rect);

    let block = theme.overlay_block(palette::panel_title(app.lang));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);

    let mut lines = palette::lines_in(state, app.lang, visible, &theme);
    lines.push(Line::default());
    lines.push(palette::legend(app.lang, &theme, state.level));
    frame.render_widget(Paragraph::new(lines).style(theme.card()), inner);

    // The list's own scrollbar, on the rows the list actually occupies: the
    // query line and the separator above it are chrome, and the legend below
    // it is too.
    let list = Rect {
        y: inner.y + 2,
        height: visible as u16,
        ..inner
    };
    let top = palette::window_start(state, rows.len(), visible);
    scroll::draw(
        frame,
        list,
        rows.len(),
        top,
        visible,
        theme.scrollbar(),
        theme.glyphs(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::View;
    use crate::i18n::Lang;
    use crate::theme::ThemeChoice;
    use crate::ui;

    fn area(width: u16, height: u16) -> Rect {
        Rect {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    /// The box is centred, fits inside the frame, and grows with the terminal
    /// but never past its own ceiling.
    #[test]
    fn a_modal_is_centred_and_bounded() {
        for (w, h) in [(80u16, 24u16), (120, 40), (200, 60), (26, 8)] {
            let frame = area(w, h);
            // Sized against the centre column, which is what the painter passes
            // in — the rail is not the modal's to use.
            let region = crate::ui::regions(frame, true).centre;
            let (bw, bh) = wanted(region, PALETTE_WIDTH_PERCENT, region.height);
            assert!(bw <= MAX_WIDTH.min(region.width), "{w}x{h}: width {bw}");
            assert!(
                bw <= region.width && bh <= region.height,
                "{w}x{h}: {bw}x{bh} spills"
            );
            let rect = centred(region, bw, bh);
            assert!(
                rect.right() <= region.right() && rect.bottom() <= region.bottom(),
                "{w}x{h}: {rect:?}"
            );
            // Centred: the margins on the two sides differ by at most one
            // column, which is as centred as an odd remainder allows.
            let left = rect.x - region.x;
            let right = region.right() - rect.right();
            assert!(left.abs_diff(right) <= 1, "{w}x{h}: {left} vs {right}");
        }
    }

    /// Below its own minimum the modal is not drawn at all: half a border with
    /// nothing in it is worse than the view it covers.
    #[test]
    fn a_frame_too_small_gets_no_modal() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        crate::palette::open(&mut app);
        for (w, h) in [(1u16, 1u16), (MAR_W, 2), (MAR_W, MIN_HEIGHT)] {
            let text = ui::render_to_text(&app, w, h);
            assert!(!text.contains("Command palette"), "{w}x{h}:\n{text}");
        }
        let text = ui::render_to_text(&app, 80, 24);
        assert!(text.contains("Command palette"), "{text}");
        const MAR_W: u16 = MIN_WIDTH - 1;
    }

    /// The palette paints over the frame without reflowing it: the row count is
    /// unchanged, the box carries its title and legend, and the view behind it
    /// is still where the layout put it.
    #[test]
    fn the_palette_paints_over_the_frame() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        let without = ui::render_to_text(&app, 100, 30);
        crate::palette::open(&mut app);
        let with = ui::render_to_text(&app, 100, 30);

        assert_eq!(with.lines().count(), without.lines().count());
        assert!(with.contains("Command palette (Ctrl+P)"), "{with}");
        assert!(
            with.contains("Open terminal view"),
            "the rows are listed:\n{with}"
        );
        // The window is a fixed number of rows from the highlighted one, opened
        // here at the top — so the shortcut looked for is one that window is
        // actually showing, not one further down the list.
        assert!(with.contains("Ctrl+Up"), "and their shortcuts:\n{with}");
        assert!(with.contains("run"), "the legend is there:\n{with}");
        assert!(
            with.contains('╭') && with.contains('╰'),
            "the box is drawn with its own corners:\n{with}"
        );
        // The chrome the modal did not cover is untouched.
        let head = with.lines().next().unwrap_or_default();
        assert!(head.contains("RX"), "the top bar survived: {head:?}");
        let rail = with.lines().nth(1).unwrap_or_default();
        assert!(rail.contains("Connection"), "the rail survived: {rail:?}");
    }

    /// The palette's list carries the bar when its rows run past the window,
    /// and drops it when a query narrows the list to what fits: a track with
    /// nothing to scroll reads as "there is more", the one thing it must not
    /// mean.
    #[test]
    fn the_palette_list_carries_a_scrollbar_only_when_it_overflows() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        crate::palette::open(&mut app);
        // The menu fits its box as it opens: no bar, no scroll.
        let text = ui::render_to_text(&app, 100, 30);
        assert!(!text.contains('┃'), "a bar down a list that fits:\n{text}");
        assert!(text.contains("Connection…"), "{text}");

        // A query wide enough to answer with more rows than the window holds:
        // a bar. A section's window is one category and cannot overflow — the
        // search is where the list grows past the box.
        let state = app.palette.as_mut().expect("the palette is up");
        state.query = "e".to_string();
        state.selected = 0;
        state.window = 0;
        let text = ui::render_to_text(&app, 100, 30);
        assert!(text.contains('┃'), "no bar down the full list:\n{text}");

        // A query with a handful of answers: nothing to scroll, so no bar.
        let state = app.palette.as_mut().expect("the palette is up");
        state.query = "uart".to_string();
        state.selected = 0;
        state.window = 0;
        let text = ui::render_to_text(&app, 100, 30);
        assert!(!text.contains('┃'), "a bar with nothing to scroll:\n{text}");
        assert!(text.contains("UART"), "the query matched nothing:\n{text}");
    }

    /// A dialog body longer than its box carries the bar down the box's right
    /// border, over the body rows only: the thumb starts flush with the body's
    /// first row, and the legend row stays chrome.
    #[test]
    fn a_dialog_body_that_overflows_carries_a_scrollbar() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        crate::dialogs::open_help(&mut app);

        // The box's own arithmetic, mirrored: the same helpers `paint_dialog`
        // puts the box and its bar where they are.
        let screen = area(80, 24);
        let region = crate::ui::regions(screen, true).centre;
        let (width, ceiling) = wanted(region, DIALOG_WIDTH_PERCENT, region.height);
        let dialog = app.dialog.as_ref().expect("the help is up");
        let body = dialogs::body_height(&app, dialog, width.saturating_sub(2));
        let rect = centred(region, width, box_height(body, ceiling));
        let inner = app.theme().overlay_block("").inner(rect);
        assert!(
            body > inner.height as usize - 1,
            "the help no longer overflows"
        );

        let buffer = ui::render_buffer(&app, 80, 24).expect("a frame");
        // The border column, not the body's last one: a wrapped row may fill
        // its width to the edge, and a bar over it would eat the last glyph.
        let bar = inner.right();
        assert_eq!(buffer[(bar, inner.y)].symbol(), "┃", "the top of the track");
        assert_ne!(
            buffer[(bar, inner.bottom() - 1)].symbol(),
            "┃",
            "the legend row grew a bar"
        );
    }

    /// The palette is the top of the modal stack: with a dialog under it the
    /// palette is what is painted, because it is also what takes the keys.
    /// Painting the dialog here was what made `Ctrl+P` look dead — the palette
    /// opened, stayed hidden, and Escape was the only way to find it.
    #[test]
    fn the_palette_paints_over_a_dialog() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        crate::dialogs::ask(
            &mut app,
            crate::dialogs::ConfirmAction::Send("reboot".into()),
        );
        assert!(app.dialog.is_some());

        crate::palette::open(&mut app);
        let text = ui::render_to_text(&app, 100, 30);
        assert!(
            text.contains("Command palette"),
            "the palette is on top:\n{text}"
        );
        assert!(
            !text.contains("to the device?"),
            "the dialog under it is not painted:\n{text}"
        );

        // Closing the top of the stack puts the dialog back, unharmed.
        app.palette = None;
        let text = ui::render_to_text(&app, 100, 30);
        assert!(text.contains("to the device?"), "{text}");
        assert!(app.dialog.is_some(), "the dialog survived");
    }

    /// A dialog raised while the palette is up takes the keyboard and the
    /// screen: the two are never both answering, and the one that was opened
    /// last is the one that is.
    #[test]
    fn a_dialog_raised_over_the_palette_is_the_one_painted() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        crate::palette::open(&mut app);
        crate::dialogs::open_help(&mut app);
        let text = ui::render_to_text(&app, 100, 30);
        assert!(text.contains("Keyboard help"), "{text}");
        assert!(
            !text.contains("Command palette (Ctrl+P)"),
            "the palette gave up the screen:\n{text}"
        );
    }

    /// The palette follows the language, title and rows alike.
    #[test]
    fn the_palette_follows_the_language() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        crate::palette::open(&mut app);
        let text = ui::render_to_text(&app, 100, 30);
        assert!(text.contains("命令面板"), "{text}");
        assert!(text.contains("打开终端视图"), "{text}");
    }

    /// A dialog paints with its own title and legend, and the palette's title
    /// is not on screen at the same time.
    #[test]
    fn a_dialog_paints_over_the_frame() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        crate::dialogs::open_help(&mut app);
        let text = ui::render_to_text(&app, 100, 30);
        assert!(text.contains("Keyboard help"), "{text}");
        assert!(
            text.contains("Command palette"),
            "the chord list is shown:\n{text}"
        );
        assert!(text.contains("Ctrl+Q"), "{text}");
        assert!(
            !text.contains("Command palette (Ctrl+P)"),
            "no palette title"
        );

        app.dialog = Some(crate::dialogs::Dialog::Confirm(crate::dialogs::Confirm {
            prompt: "Reboot the bridge?".into(),
            detail: "It will not come back on its own.".into(),
            action: crate::dialogs::ConfirmAction::Send("reboot".into()),
            yes: false,
        }));
        let text = ui::render_to_text(&app, 100, 30);
        assert!(text.contains("Reboot the bridge?"), "{text}");
        assert!(
            text.contains("It will not come back"),
            "the consequence is shown:\n{text}"
        );
        assert!(
            text.contains("Confirm") && text.contains("Cancel"),
            "both buttons are drawn:\n{text}"
        );
        assert!(!text.contains("Keyboard help"), "the help was replaced");
    }

    /// The notice log paints over the pane and shows the log's rows.
    #[test]
    fn the_notice_log_paints_over_the_frame() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        app.push_notice(crate::app::Notice {
            text: "链路已建立：stdio: -".into(),
            level: crate::event::NoticeLevel::Info,
        });
        crate::dialogs::open_notices(&mut app);
        let text = ui::render_to_text(&app, 100, 30);
        assert!(text.contains("通知记录"), "{text}");
        assert!(text.contains("链路已建立"), "{text}");
        assert!(text.contains("信息"), "the level is spelled out:\n{text}");
    }

    /// A modal never paints a row wider than the frame, and never panics on a
    /// degenerate area — the resize-storm case.
    #[test]
    fn a_modal_survives_every_size() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        crate::palette::open(&mut app);
        for (w, h) in [(24u16, 5u16), (40, 12), (120, 40), (1, 1), (3, 3), (0, 0)] {
            let text = ui::render_to_text(&app, w, h);
            assert_eq!(text.lines().count(), h as usize, "{w}x{h}");
            for line in text.lines() {
                assert!(
                    unicode_width::UnicodeWidthStr::width(line) <= w as usize,
                    "{w}x{h}: {line:?}"
                );
            }
        }
    }

    /// A modal is deterministic and follows the theme's ground: the same state
    /// paints the same bytes, and the two themes differ.
    #[test]
    fn a_modal_follows_the_theme() {
        let mut app = App::default();
        crate::palette::open(&mut app);
        assert_eq!(
            ui::render_to_text(&app, 100, 30),
            ui::render_to_text(&app, 100, 30)
        );
        let dark = ui::render_to_ansi(&app, 100, 30);
        app.theme = ThemeChoice::Light;
        let light = ui::render_to_ansi(&app, 100, 30);
        assert_ne!(dark, light);
    }

    /// The palette's window shrinks with the room it is given rather than
    /// running off the bottom of the box.
    #[test]
    fn the_palette_window_fits_its_room() {
        for height in [8u16, 16, 24, 40] {
            let mut app = App {
                lang: Lang::En,
                ..App::default()
            };
            crate::palette::open(&mut app);
            let text = ui::render_to_text(&app, 100, height);
            let rows: Vec<&str> = text.lines().collect();
            let box_top = rows
                .iter()
                .position(|line| line.contains("Command palette"))
                .expect("the title");
            let box_bottom = rows
                .iter()
                .rposition(|line| line.contains('╰'))
                .expect("the closing corner");
            assert!(box_bottom > box_top, "{height}: the box is closed");
            assert!(
                box_bottom < height as usize,
                "{height}: the box ran off the frame"
            );
            assert_eq!(rows.len(), height as usize, "{height}: the frame reflowed");
        }
    }

    /// A confirmation is as tall as its content, not as tall as the screen: an
    /// otherwise empty box reads as a broken dialog rather than a careful one.
    #[test]
    fn a_confirmation_box_fits_its_content() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        crate::dialogs::ask(
            &mut app,
            crate::dialogs::ConfirmAction::Send("reboot".into()),
        );
        let text = ui::render_to_text(&app, 110, 32);
        let rows: Vec<&str> = text.lines().collect();
        let top = rows
            .iter()
            .position(|line| line.contains("Confirm"))
            .expect("the title");
        let bottom = rows
            .iter()
            .rposition(|line| line.contains('╰'))
            .expect("the closing corner");
        let box_rows = bottom - top + 1;
        assert!(text.contains("reboot"), "the command is named:\n{text}");
        assert!(text.contains("Cancel"), "the buttons are drawn:\n{text}");
        assert!(
            (5..=10).contains(&box_rows),
            "the confirm box is {box_rows} rows, not a snug one:\n{text}"
        );
    }

    /// The notice log grows with its content up to the ceiling, then stops —
    /// the box is as tall as it can usefully be, not as tall as the log.
    #[test]
    fn the_notice_log_grows_to_its_ceiling() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        for i in 0..40 {
            app.push_notice(crate::app::Notice {
                text: format!("notice {i}"),
                level: crate::event::NoticeLevel::Info,
            });
        }
        crate::dialogs::open_notices(&mut app);
        let text = ui::render_to_text(&app, 110, 32);
        let rows: Vec<&str> = text.lines().collect();
        let top = rows
            .iter()
            .position(|line| line.contains("Notice log"))
            .expect("the title");
        let bottom = rows
            .iter()
            .rposition(|line| line.contains('╰'))
            .expect("the closing corner");
        assert!(
            bottom - top + 1 < rows.len(),
            "the log box took the whole frame:\n{text}"
        );
        assert!(text.contains("notice 39"), "the newest is shown:\n{text}");
    }

    /// The view under a modal is not moved: the sidebar's rows stay in their
    /// columns, so an overlay is an overlay and not a second layout.
    #[test]
    fn the_view_under_a_modal_does_not_move() {
        let app = App {
            lang: Lang::En,
            view: View::Network,
            ..App::default()
        };
        let without: Vec<String> = ui::render_to_text(&app, 110, 30)
            .lines()
            .map(|line| line.chars().take(ui::SIDEBAR_TEXT_WIDTH as usize).collect())
            .collect();
        let mut covered = app;
        crate::palette::open(&mut covered);
        let with: Vec<String> = ui::render_to_text(&covered, 110, 30)
            .lines()
            .map(|line| line.chars().take(ui::SIDEBAR_TEXT_WIDTH as usize).collect())
            .collect();
        assert_eq!(without, with, "the rail is painted identically");
    }

    /// A glyph the modal's edge would split is released before the box is
    /// cleared; one the edge does not reach is left exactly where it was.
    #[test]
    fn a_glyph_left_of_the_box_is_released_and_one_further_out_is_not() {
        let mut buf = Buffer::empty(area(12, 3));
        // Its tail lands in the box's first column.
        buf[(3, 0)].set_symbol("中");
        // A narrow glyph: the box does not touch it.
        buf[(2, 1)].set_symbol("x");
        // Whole, one column short of the edge: it stays.
        buf[(1, 2)].set_symbol("中");
        release_left_edge(&mut buf, Rect::new(4, 0, 6, 3));
        assert_eq!(buf[(3, 0)].symbol(), " ");
        assert_eq!(buf[(2, 1)].symbol(), "x");
        assert_eq!(buf[(1, 2)].symbol(), "中");
    }

    /// The report's geometry, made deliberate: a device line whose wide glyph
    /// begins in the column left of the box's edge — the empty pane's hint
    /// beside the device picker, except the device paints it. The box blanks
    /// that half before it clears its rows, so its edge is drawn whole on
    /// every row it covers, and the glyphs it does not cover are untouched.
    #[test]
    fn the_box_releases_the_glyph_its_edge_would_split() {
        let mut app = App {
            lang: Lang::En,
            assistant_panel: false,
            ..App::default()
        };
        // The box's own arithmetic, mirrored: the same helpers `paint_dialog`
        // puts the edges where they are. The left column is what matters
        // here, and it does not depend on the body.
        let screen = area(205, 30);
        let region = crate::ui::regions_for(screen, true, false).centre;
        let (width, ceiling) = wanted(region, DIALOG_WIDTH_PERCENT, region.height);
        let edge = centred(region, width, MIN_HEIGHT).x;
        assert_eq!(edge, 69, "the report's frame, and its edge");

        // The pane's text starts in the centre column's first cell, so the
        // glyph that meets the edge begins at the column just left of it.
        let mut text = String::new();
        for _ in 0..20 {
            text.push_str(&" ".repeat((edge - 1 - region.x) as usize));
            text.push('中');
            text.push_str("\r\n");
        }
        app.terminal.push_text(&text);
        let before = ui::render_buffer(&app, 205, 30).expect("a frame");
        let glyphs: Vec<u16> = (0..30u16)
            .filter(|&y| before[(edge - 1, y)].symbol() == "中")
            .collect();
        assert!(!glyphs.is_empty(), "the text landed in the edge's column");

        crate::dialogs::open_help(&mut app);
        let dialog = app.dialog.as_ref().expect("the help is up");
        let body = dialogs::body_height(&app, dialog, width.saturating_sub(2));
        let rect = centred(region, width, box_height(body, ceiling));

        let after = ui::render_buffer(&app, 205, 30).expect("a frame");
        let covered: Vec<u16> = glyphs
            .iter()
            .copied()
            .filter(|&y| rect.top() <= y && y < rect.bottom())
            .collect();
        assert!(!covered.is_empty(), "the box covers rows the text is on");
        for y in covered {
            assert_eq!(after[(edge - 1, y)].symbol(), " ", "row {y}");
            let corner = if y == rect.top() {
                "╭"
            } else if y == rect.bottom() - 1 {
                "╰"
            } else {
                "│"
            };
            assert_eq!(after[(edge, y)].symbol(), corner, "the edge at row {y}");
        }
        let above: Vec<u16> = glyphs.iter().copied().filter(|&y| y < rect.top()).collect();
        assert!(!above.is_empty(), "some rows stay above the box");
        for y in above {
            assert_eq!(after[(edge - 1, y)].symbol(), "中", "row {y} is free");
        }
    }

    /// A modal gives the docked panel its column the way it gives the rail
    /// one: the box is centred in what the panel left of the centre column,
    /// so it never covers the assistant — and the report's collision cannot
    /// happen from this side either, because the whole hint is under the box.
    #[test]
    fn a_modal_yields_the_panels_column() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        assert!(app.panel_wanted(), "the panel is docked beside the console");

        // The report's frame, and the hint's first character in it: found
        // rather than guessed, so the assertion below is about this glyph.
        let before = ui::render_buffer(&app, 205, 46).expect("a frame");
        let row = (0..46u16)
            .find(|&y| before[(68, y)].symbol() == "在")
            .expect("the hint's first character, at the report's column");

        crate::dialogs::open_help(&mut app);
        let screen = area(205, 46);
        let regions = crate::ui::regions_for(screen, true, true);
        assert!(regions.assistant.width > 0, "the panel has a column here");
        let (width, _) = wanted(regions.centre, DIALOG_WIDTH_PERCENT, regions.centre.height);
        let dialog = app.dialog.as_ref().expect("the help is up");
        let body = dialogs::body_height(&app, dialog, width.saturating_sub(2));
        let rect = centred(
            regions.centre,
            width,
            box_height(body, ceiling_height(regions.centre.height)),
        );
        assert_eq!(rect.x, 42, "the box is centred in the narrowed centre");
        assert!(
            rect.right() <= regions.assistant.x,
            "the box ends where the panel begins"
        );
        assert!(
            rect.top() <= row && row < rect.bottom(),
            "the box covers the hint's row"
        );

        let after = ui::render_buffer(&app, 205, 46).expect("a frame");
        assert_eq!(after[(68, row)].symbol(), " ", "the hint is under the box");
        // The paint agrees with the arithmetic: the box's own corners, in the
        // panel-aware column.
        assert_eq!(after[(rect.x, rect.y)].symbol(), "╭");
        assert_eq!(after[(rect.right() - 1, rect.y)].symbol(), "╮");
    }
}
