//! Frame composition: where every region goes, and how a frame is painted.
//!
//! The layout is fixed by the design: a one-line bar top and bottom, a fixed
//! sidebar on the left, and the centre column taking the rest. Composition is
//! the only place that knows those numbers, so a view never guesses its own
//! size.

pub mod body;
pub mod chrome;
pub mod legacy;
pub mod overlay;
pub mod scroll;
pub mod sidebar;
pub mod splash;
pub mod toast;

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use crate::app::App;

/// Height of the top and bottom bars, in rows.
pub const BAR_HEIGHT: u16 = 1;

/// Width of the sidebar rail, in columns — wide enough for the longest designed
/// row (`Transport: BLE (locked)` and the Chinese equivalent) with the cursor
/// marker and a margin. The rail's last column is its edge, so the rows
/// themselves have [`SIDEBAR_TEXT_WIDTH`].
pub const SIDEBAR_WIDTH: u16 = 30;

/// The rail's edge: one column of rule, so the sidebar reads as a column of its
/// own rather than as the left margin of the centre pane. The glyph is the
/// theme's ([`crate::capability::GlyphSet::divider`]), so a terminal without
/// box drawing gets the `|` it does have.
pub const DIVIDER_WIDTH: u16 = 1;

/// Columns the sidebar's own rows may use.
pub const SIDEBAR_TEXT_WIDTH: u16 = SIDEBAR_WIDTH - DIVIDER_WIDTH;

/// The regions of a frame, resolved once so tests can assert on them without
/// painting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Regions {
    pub top_bar: Rect,
    pub sidebar: Rect,
    pub centre: Rect,
    /// The docked assistant panel's column, zero-width when it does not show.
    pub assistant: Rect,
    pub bottom_bar: Rect,
}

/// The narrowest the centre may become before the panel gives up its column.
///
/// The pane keeps this many columns whatever the panel wants: below it the
/// device's output is too cramped to read, and the full-width assistant view
/// (F5) is where a small window reads a conversation anyway.
pub const CENTRE_MIN: u16 = 48;

/// The panel's column: a share of the band, kept inside what a conversation
/// needs and what a pane can spare. The left rule is part of the column, the
/// way the rail's edge is part of the rail's.
pub const ASSISTANT_WIDTH_MIN: u16 = 32;
pub const ASSISTANT_WIDTH_MAX: u16 = 64;

/// The panel's width for a band of `width`, or zero when there is no room.
///
/// `5/12` of the band — the web panel is a share of the timeline rather than a
/// fixed column, and a share keeps both sides in proportion as the window
/// grows — clamped to the two ends, and never at the expense of
/// [`CENTRE_MIN`] columns of pane. A width below the minimum is no width at
/// all: two columns of panel is not a panel, it is a pane with its edge worn
/// off, and the pane would rather have the columns back.
pub fn assistant_width(width: u16) -> u16 {
    let room = width.saturating_sub(CENTRE_MIN);
    if room < ASSISTANT_WIDTH_MIN {
        return 0;
    }
    (width * 5 / 12)
        .clamp(ASSISTANT_WIDTH_MIN, ASSISTANT_WIDTH_MAX)
        .min(room)
}

/// Resolve the designed layout for an area.
///
/// `sidebar` decides whether the rail takes its column. With it closed the
/// centre gets the whole middle band, so a narrow terminal or a user who
/// wants the view full width both get the same thing.
pub fn regions(area: Rect, sidebar: bool) -> Regions {
    regions_for(area, sidebar, false)
}

/// [`regions`], with the docked assistant panel as well.
///
/// The panel takes its column out of the centre, and yields it — zero width,
/// nothing painted — when there is no room for it. The yields are ordered: a
/// terminal too narrow for the rail *and* a usable centre gives the rail up
/// first, because the rail is chrome and the pane is the device.
pub fn regions_for(area: Rect, sidebar: bool, panel: bool) -> Regions {
    let [top_bar, middle, bottom_bar] = Layout::vertical([
        Constraint::Length(BAR_HEIGHT),
        Constraint::Min(0),
        Constraint::Length(BAR_HEIGHT),
    ])
    .areas(area);

    if !sidebar {
        return split_panel(
            top_bar,
            Rect { width: 0, ..middle },
            middle,
            panel,
            bottom_bar,
        );
    }

    // A terminal narrower than the sidebar plus a usable centre would leave the
    // centre at zero width; the sidebar yields instead, so a tiny window still
    // shows the view rather than a wall of sidebar.
    let sidebar_width = SIDEBAR_WIDTH.min(middle.width.saturating_sub(1));
    let [sidebar_area, centre] =
        Layout::horizontal([Constraint::Length(sidebar_width), Constraint::Min(0)]).areas(middle);

    split_panel(top_bar, sidebar_area, centre, panel, bottom_bar)
}

/// Take the panel's column out of the centre.
fn split_panel(
    top_bar: Rect,
    sidebar: Rect,
    centre: Rect,
    panel: bool,
    bottom_bar: Rect,
) -> Regions {
    let width = if panel {
        assistant_width(centre.width)
    } else {
        0
    };
    if width == 0 {
        return Regions {
            top_bar,
            sidebar,
            centre,
            assistant: Rect { width: 0, ..centre },
            bottom_bar,
        };
    }
    let [centre_area, assistant] =
        Layout::horizontal([Constraint::Min(0), Constraint::Length(width)]).areas(centre);
    Regions {
        top_bar,
        sidebar,
        centre: centre_area,
        assistant,
        bottom_bar,
    }
}

/// The cell grid the terminal pane's emulator is sized to, for a window of
/// `cols`×`rows`.
///
/// This is the design's arithmetic with everything counted: the rail and the
/// assistant panel, even when either is closed. Toggling one then moves the
/// paint, not the pane — and a pane whose grid moved would rewrap the device's
/// whole history, which is the one thing a layout toggle must not do. Every
/// column of the rect is one the paint fills when both are shown, which is
/// what keeps the device's own wrap between the pane's edges.
pub fn pane_area(cols: u16, rows: u16) -> Rect {
    regions_for(Rect::new(0, 0, cols, rows), true, true).centre
}

/// Paint one frame.
pub fn draw(frame: &mut Frame, app: &App) {
    let theme = app.theme();
    // The frame takes the window whole: the page is not shifted sideways as a
    // block — the only thing that looks worse in a terminal than a border one
    // column in is one column out, because every edge the user can see stops
    // lining up with the window's — so the air a pane wants lives *inside* the
    // pane, in the indent its own rows carry. On the old Windows console the
    // *window* gives up its last columns to the scrollbar first, which is what
    // `drawing_area` decides.
    let area = legacy::drawing_area(frame.area(), app.legacy_console);

    // The page ground first, so no cell keeps the emulator's default background.
    frame.render_widget(Block::default().style(Style::default().bg(theme.bg)), area);

    // The splash is a screen of its own while it stands: nothing else is
    // painted under it, so the interface's first frame is a whole one rather
    // than one with a splash peeled off it. The compatibility pass still has
    // the last word — on the old console there is no other way to paint.
    if app.splash_active() {
        splash::draw(frame, app, area);
        if app.legacy_console {
            legacy::prepare(frame.buffer_mut());
        }
        return;
    }

    let regions = regions_for(area, app.sidebar_visible, app.panel_wanted());

    draw_top_bar(frame, app, regions.top_bar);
    // Closed, the rail is a zero-width strip and the centre already owns the
    // band, so there is nothing to paint and no divider to draw.
    if app.sidebar_visible {
        draw_sidebar(frame, app, regions.sidebar);
    }
    draw_centre(frame, app, regions.centre);
    if regions.assistant.width > 0 {
        draw_assistant(frame, app, regions.assistant);
    }
    draw_selection(frame, app, &regions);
    draw_bar(
        frame,
        app,
        regions.bottom_bar,
        chrome::bottom_left(app, &theme),
        chrome::bottom_right(app, &theme),
    );
    draw_toasts(frame, app, area);
    // The modal layer last, so a palette or a dialog covers everything —
    // including the toasts, which the user is not reading while answering a
    // confirmation.
    overlay::paint(frame, app, area);
    // And the compatibility pass last of all, because it is about the cells
    // every widget has finished painting rather than about any one of them.
    if app.legacy_console {
        legacy::prepare(frame.buffer_mut());
    }
}

/// One bar: the left half flush left, the right half flush right, split so they
/// can never overlap however long the counters grow.
fn draw_bar(
    frame: &mut Frame,
    app: &App,
    area: Rect,
    left: ratatui::text::Line<'static>,
    right: ratatui::text::Line<'static>,
) {
    let theme = app.theme();
    let ground = chrome::bar_style(&theme);
    let right_width = right.width() as u16;
    // The left half is given the room the right one leaves, because the right
    // half is painted over it: a line that reaches past its neighbour is
    // covered mid-glyph, not laid out around it. See [`chrome::trim_to_width`].
    let left = chrome::trim_to_width(left, area.width.saturating_sub(right_width));
    frame.render_widget(Paragraph::new(left).style(ground), area);

    if right_width < area.width {
        let [_, right_area] =
            Layout::horizontal([Constraint::Min(0), Constraint::Length(right_width)]).areas(area);
        frame.render_widget(Paragraph::new(right).style(ground), right_area);
    } else {
        // Not enough room for both: the right half is the counters and the key
        // hints, so it wins the row and the left half is dropped rather than
        // truncated into nonsense.
        frame.render_widget(Paragraph::new(right).style(ground), area);
    }
}

/// The top bar: [`draw_bar`]'s split, plus the traffic unit at the right end —
/// the newest rate and the graph behind it.
///
/// The unit takes a slice of its own, so the counters' strip is laid out
/// against it rather than over it, and it is dropped whole when the bar cannot
/// hold it: a bar that let the unit eat into the counters would move the
/// numbers whenever the traffic changed. With the unit gone, the counters and
/// the left half fall back to exactly what [`draw_bar`] does with them.
fn draw_top_bar(frame: &mut Frame, app: &App, area: Rect) {
    let theme = app.theme();
    let left = chrome::top_left(app, &theme);
    let right = chrome::top_right(app, &theme);
    let right_width = right.width() as u16;
    // The counters win the row, then the unit, then the left half — the order
    // the information is missed in.
    let unit = chrome::traffic_unit(area.width);
    let unit = if right_width + unit < area.width {
        unit
    } else {
        0
    };
    if unit == 0 {
        draw_bar(frame, app, area, left, right);
        return;
    }

    let [bar_area, unit_area] =
        Layout::horizontal([Constraint::Min(0), Constraint::Length(unit)]).areas(area);
    draw_bar(frame, app, bar_area, left, right);

    // The unit's own ground, laid before anything in it. The arrows and the
    // graphs are drawn by widgets that carry no background of their own, and a
    // cell that nobody gave a ground keeps the console's — a darker rectangle
    // in the middle of the bar that moves with the traffic.
    frame.render_widget(Block::default().style(chrome::bar_style(&theme)), unit_area);

    let label = chrome::traffic_label(app, &theme);
    let label_width = (label.width() as u16).min(unit);
    let [label_area, graph_area] =
        Layout::horizontal([Constraint::Length(label_width), Constraint::Min(0)]).areas(unit_area);
    frame.render_widget(
        Paragraph::new(label).style(chrome::bar_style(&theme)),
        label_area,
    );
    // Both directions, side by side and each behind its own arrow: one graph
    // of the two together would be the same shape whether the bytes were
    // coming or going, and which way they went is half the fact.
    let [rx_half, tx_half] = Layout::horizontal([Constraint::Ratio(1, 2); 2]).areas(graph_area);
    let [rx_arrow, rx_area] =
        Layout::horizontal([Constraint::Length(1), Constraint::Fill(1)]).areas(rx_half);
    let [tx_arrow, tx_area] =
        Layout::horizontal([Constraint::Length(1), Constraint::Fill(1)]).areas(tx_half);
    frame.render_widget(
        Paragraph::new(Line::from(chrome::rx_arrow(&theme))),
        rx_arrow,
    );
    frame.render_widget(chrome::rx_graph(app, &theme), rx_area);
    frame.render_widget(
        Paragraph::new(Line::from(chrome::tx_arrow(&theme))),
        tx_arrow,
    );
    frame.render_widget(chrome::tx_graph(app, &theme), tx_area);
}

fn draw_sidebar(frame: &mut Frame, app: &App, area: Rect) {
    let theme = app.theme();
    // The rows get the rail minus its edge, so a row can never be laid out
    // against the rail's width and then paint over the rule.
    let text_area = Rect {
        width: area.width.saturating_sub(DIVIDER_WIDTH),
        ..area
    };
    // The rail is the rows, and only the rows: the mark that used to ride the
    // spare room at its top leads the splash now, so the column opens with the
    // first row at every height.
    let lines = sidebar::lines(app, &theme, text_area.width);
    frame.render_widget(Paragraph::new(lines).style(theme.panel()), text_area);
    draw_divider(frame, &theme, area);
}

/// The rule down the sidebar's right edge.
///
/// It spans the middle band only: the bars are full width and run across it, so
/// a rule through them would fence off the top bar's own status strip.
fn draw_divider(frame: &mut Frame, theme: &crate::theme::Theme, area: Rect) {
    if area.width < DIVIDER_WIDTH + 1 || area.height == 0 {
        // A rail with no room for both its text and its edge drops the edge:
        // the rows are what the user came for.
        return;
    }
    let column = Rect {
        x: area.x + area.width - DIVIDER_WIDTH,
        y: area.y,
        width: DIVIDER_WIDTH,
        height: area.height,
    };
    let rule: Vec<Line<'static>> = (0..column.height)
        .map(|_| Line::from(Span::styled(dividers(theme), theme.line())))
        .collect();
    frame.render_widget(Paragraph::new(rule).style(theme.panel()), column);
}

/// The glyph a column's edge is drawn with, in this terminal's set: one cell of
/// rule either way.
fn dividers(theme: &crate::theme::Theme) -> String {
    theme.glyphs().divider().to_string()
}

/// The docked assistant panel: the thread on the right of the pane.
///
/// Painted like the rail, because it is a column and not an overlay: the rule
/// on its left is what says the pane stops there, and the pane beside it is
/// *narrowed*, never covered. The rows are anchored at the bottom by
/// `panel_lines`, so the newest turn is the one on screen.
/// The text column of the docked panel: the column less its left rule.
pub fn panel_text_area(area: Rect) -> Rect {
    Rect {
        x: area.x + DIVIDER_WIDTH,
        width: area.width.saturating_sub(DIVIDER_WIDTH),
        ..area
    }
}

/// The area a centre view paints its body in: inside the frame for a framed
/// view, the whole rect for the pane.
///
/// The same arithmetic `draw_centre` runs, exposed so a mouse handler
/// resolving a drag and the painter writing the rows cannot disagree about
/// where the body starts.
pub fn body_text_area(app: &App, area: Rect) -> Rect {
    if body::is_framed(app.view) {
        app.theme().view_block(app.view_name()).inner(area)
    } else {
        area
    }
}

/// The assistant's run, painted on the cells it covers.
///
/// Under the toasts and the modal layer, over the text: the run is a claim
/// about rows the two assistant paints just wrote, so it goes on after them —
/// and before anything that is allowed to cover them.
fn draw_selection(frame: &mut Frame, app: &App, regions: &Regions) {
    use crate::views::assistant::SelectRegion;
    let Some(selection) = &app.assistant.select else {
        return;
    };
    let rect = match selection.region {
        SelectRegion::Panel if regions.assistant.width > 0 => panel_text_area(regions.assistant),
        SelectRegion::View if app.view == crate::event::View::Assistant => {
            body_text_area(app, regions.centre)
        }
        // The paint that held the run is not on screen: there is nothing to
        // highlight, and the run is dropped when that paint leaves.
        _ => return,
    };
    let theme = app.theme();
    let (start, end) = selection.ordered();
    let buffer = frame.buffer_mut();
    for row in start.0..=end.0 {
        let y = rect.y.saturating_add(row);
        if y >= rect.bottom() {
            break;
        }
        // The run takes the whole of every row between its ends, and each end
        // from its own column — columns the area holds, so a run past the
        // right edge paints what is there.
        let first = if row == start.0 { start.1 } else { 0 };
        let last = if row == end.0 { end.1 } else { u16::MAX };
        for col in first..=last.min(rect.width.saturating_sub(1)) {
            let x = rect.x.saturating_add(col);
            if x >= rect.right() {
                break;
            }
            if let Some(cell) = buffer.cell_mut((x, y)) {
                cell.set_style(cell.style().patch(theme.selection()));
            }
        }
    }
}

fn draw_assistant(frame: &mut Frame, app: &App, area: Rect) {
    let theme = app.theme();
    // The rows get the column minus its edge, so a row can never be laid out
    // against the panel's width and then paint over the rule.
    let text_area = panel_text_area(area);
    let lines =
        crate::views::assistant::panel_lines(app, &theme, text_area.width, text_area.height);
    frame.render_widget(Paragraph::new(lines).style(theme.panel()), text_area);
    // The rule down the panel's left edge, for the same reason the rail has
    // one: a column without an edge reads as part of the pane. A column too
    // narrow to hold both the rule and a character keeps the rule, because
    // there is no such column: `assistant_width` never hands out one.
    if area.width > DIVIDER_WIDTH && area.height > 0 {
        let column = Rect {
            width: DIVIDER_WIDTH,
            ..area
        };
        let rule: Vec<Line<'static>> = (0..column.height)
            .map(|_| Line::from(Span::styled(dividers(&theme), theme.line())))
            .collect();
        frame.render_widget(Paragraph::new(rule).style(theme.panel()), column);
    }
}

fn draw_centre(frame: &mut Frame, app: &App, area: Rect) {
    let theme = app.theme();
    let ground = body::ground(app, &theme);
    if body::is_framed(app.view) {
        let block = theme.view_block(app.view_name());
        let inner = block.inner(area);
        frame.render_widget(block, area);
        // The body is told the width the border left it, so a row can never be
        // laid out for the frame's width and then spill into the border.
        let lines = body::lines(app, &theme, inner);
        let offset = body::scroll_offset(app, lines.len(), inner.height as usize) as u16;
        frame.render_widget(
            Paragraph::new(lines).scroll((offset, 0)).style(ground),
            inner,
        );
    } else {
        frame.render_widget(
            Paragraph::new(body::lines(app, &theme, area)).style(ground),
            area,
        );
        draw_status_pill(frame, app, area);
        // The pane's own scrollbar, when the history runs past the window: the
        // bar rides the pane's right column, over the device's own output,
        // because a whole column of the terminal is worth more than a gutter
        // that is empty most of the time.
        let (total, top, viewport) =
            crate::views::terminal::scroll_position(&app.terminal, area.height as usize);
        scroll::draw(
            frame,
            area,
            total,
            top,
            viewport,
            theme.scrollbar(),
            theme.glyphs(),
        );
    }
}

/// Columns the status pill keeps between itself and the pane's right edge.
const PILL_MARGIN: u16 = 1;

/// The status pill, flush right on the pane's head row.
///
/// It rides the pane's own first row rather than the top bar: the design keeps
/// that row for it, and the top bar is already spoken for by the counters and
/// the clock. Only the unframed view reaches here — a framed view puts its
/// title on the border that row would otherwise carry.
fn draw_status_pill(frame: &mut Frame, app: &App, area: Rect) {
    if area.height == 0 {
        return;
    }
    let theme = app.theme();
    let pill = chrome::status_pill(app, &theme);
    let width = pill.width() as u16;
    let room = area.width.saturating_sub(PILL_MARGIN);
    if width > room {
        // A pane too narrow for its pill drops it: the pane is what the user
        // came for, and half a chip is worse than none.
        return;
    }
    let head = Rect {
        x: area.x + room - width,
        y: area.y,
        width,
        height: 1,
    };
    frame.render_widget(Paragraph::new(pill), head);
}

fn draw_toasts(frame: &mut Frame, app: &App, area: Rect) {
    if app.notices.is_empty() {
        return;
    }
    let theme = app.theme();
    let width = toast::width(&app.notices, theme.glyphs()).min(area.width);
    let height = app.notices.len() as u16 + 2;
    if width < 3 || area.height < BAR_HEIGHT + height {
        return;
    }
    // Just under the top bar, flush right — the web client's toast corner.
    let corner = Rect {
        x: area.x + area.width - width,
        y: area.y + BAR_HEIGHT,
        width,
        height,
    };
    let level = toast::border_level(&app.notices).unwrap_or(crate::event::NoticeLevel::Info);
    // The column before the box gives up anything wide to it first: see
    // [`toast::clear_the_edge`].
    toast::clear_the_edge(frame.buffer_mut(), corner);
    let block = Block::bordered()
        .border_style(Style::default().fg(theme.toast_border(level)))
        .style(theme.toast());
    let inner = block.inner(corner);
    frame.render_widget(block, corner);
    frame.render_widget(
        Paragraph::new(toast::lines(app, &theme)).style(theme.toast()),
        inner,
    );
}

/// Render a frame into a cell buffer without a terminal. `None` when the
/// terminal cannot be built at all, which the callers treat as an empty frame
/// rather than a panic.
fn render_buffer(app: &App, width: u16, height: u16) -> Option<ratatui::buffer::Buffer> {
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).ok()?;
    terminal.draw(|frame| draw(frame, app)).ok()?;
    Some(terminal.backend().buffer().clone())
}

/// Render a frame without a terminal, as text — for tests and for
/// `--print-frame`, which is how a frame is inspected without a TTY.
pub fn render_to_text(app: &App, width: u16, height: u16) -> String {
    let buffer = match render_buffer(app, width, height) {
        Some(buffer) => buffer,
        None => return String::new(),
    };
    let mut out = String::new();
    for y in 0..height {
        let mut x = 0;
        while x < width {
            let symbol = buffer[(x, y)].symbol();
            out.push_str(symbol);
            // A wide (CJK) glyph occupies two cells and ratatui blanks the
            // continuation cell. Stepping by the glyph's own width keeps the
            // text from growing a phantom space after every wide character —
            // which would also make the row look wider than the terminal.
            x += unicode_width::UnicodeWidthStr::width(symbol).max(1) as u16;
        }
        // Trailing blanks carry no information; trim so the golden text is
        // stable and readable.
        while out.ends_with(' ') {
            out.pop();
        }
        out.push('\n');
    }
    out
}

/// Render a frame with true-colour escape sequences, one line per row — what
/// `--print-frame --ansi` prints, so a frame can be looked at with its real
/// palette in any terminal (or piped into a viewer).
pub fn render_to_ansi(app: &App, width: u16, height: u16) -> String {
    let buffer = match render_buffer(app, width, height) {
        Some(buffer) => buffer,
        None => return String::new(),
    };
    let mut out = String::new();
    for y in 0..height {
        let mut x = 0;
        while x < width {
            let cell = &buffer[(x, y)];
            let symbol = cell.symbol();
            // Reset first, then the cell's own codes: no run tracking, so the
            // output cannot drift out of step with the buffer.
            out.push_str("\x1b[0m");
            out.push_str(&ansi_style(cell.style()));
            out.push_str(symbol);
            x += unicode_width::UnicodeWidthStr::width(symbol).max(1) as u16;
        }
        out.push_str("\x1b[0m\n");
    }
    out
}

/// The escape sequence for a style, if it needs one.
fn ansi_style(style: ratatui::style::Style) -> String {
    use ratatui::style::Modifier;
    let mut codes = String::new();
    if let Some(fg) = style.fg {
        codes.push_str(&ansi_colour(fg, false));
    }
    if let Some(bg) = style.bg {
        codes.push_str(&ansi_colour(bg, true));
    }
    if style.add_modifier.contains(Modifier::BOLD) {
        codes.push_str("\x1b[1m");
    }
    if style.add_modifier.contains(Modifier::DIM) {
        codes.push_str("\x1b[2m");
    }
    if style.add_modifier.contains(Modifier::REVERSED) {
        codes.push_str("\x1b[7m");
    }
    codes
}

/// A colour as a foreground (`38`) or background (`48`) escape.
fn ansi_colour(colour: ratatui::style::Color, background: bool) -> String {
    use ratatui::style::Color;
    let layer = if background { 48 } else { 38 };
    match colour {
        Color::Reset => format!("\x1b[{}m", if background { 49 } else { 39 }),
        Color::Rgb(r, g, b) => format!("\x1b[{layer};2;{r};{g};{b}m"),
        Color::Indexed(index) => format!("\x1b[{layer};5;{index}m"),
        // The sixteen named colours are palette entries 0–15.
        other => format!("\x1b[{layer};5;{}m", named_index(other)),
    }
}

/// The palette index of a named colour, so an ANSI-16 style still round-trips
/// through the dump.
fn named_index(colour: ratatui::style::Color) -> u8 {
    use ratatui::style::Color;
    match colour {
        Color::Black => 0,
        Color::Red => 1,
        Color::Green => 2,
        Color::Yellow => 3,
        Color::Blue => 4,
        Color::Magenta => 5,
        Color::Cyan => 6,
        Color::Gray => 7,
        Color::DarkGray => 8,
        Color::LightRed => 9,
        Color::LightGreen => 10,
        Color::LightYellow => 11,
        Color::LightBlue => 12,
        Color::LightMagenta => 13,
        Color::LightCyan => 14,
        Color::White => 15,
        // Reset, Rgb and Indexed are handled before this is reached.
        _ => 15,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{ConnectionState, NoticeLevel, View};
    use crate::i18n::Lang;
    use crate::theme::Theme;

    fn area(width: u16, height: u16) -> Rect {
        Rect {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    /// The layout is the designed one: bars one row high, sidebar fixed, centre
    /// taking the remainder, and the three regions tile the area exactly.
    #[test]
    fn the_regions_tile_the_area() {
        let regions = regions(area(120, 40), true);
        assert_eq!(regions.top_bar, area(120, 1));
        assert_eq!(
            regions.bottom_bar,
            Rect {
                x: 0,
                y: 39,
                width: 120,
                height: 1
            }
        );
        assert_eq!(regions.sidebar.height, 38);
        assert_eq!(regions.sidebar.width, SIDEBAR_WIDTH);
        assert_eq!(regions.centre.width, 120 - SIDEBAR_WIDTH);
        assert_eq!(regions.centre.x, SIDEBAR_WIDTH);
        // Sidebar and centre together are exactly the middle band.
        assert_eq!(regions.sidebar.width + regions.centre.width, 120);
        for region in [
            regions.top_bar,
            regions.sidebar,
            regions.centre,
            regions.bottom_bar,
        ] {
            assert!(
                region.right() <= 120 && region.bottom() <= 40,
                "{region:?} spills"
            );
        }
    }

    /// The emulator's grid ends exactly where the painted pane ends: no column
    /// of air is inside it, and the device's own wrap lands on the pane's last
    /// column rather than one column past the edge.
    #[test]
    fn the_pane_grid_ends_where_the_paint_does() {
        assert_eq!(
            pane_area(80, 24),
            Rect {
                x: SIDEBAR_WIDTH,
                y: 1,
                width: 80 - SIDEBAR_WIDTH,
                height: 22,
            }
        );
        // At every size the grid stays inside the frame, keeps both bars, and
        // never collapses to nothing.
        for (w, h) in [(40u16, 10u16), (32, 5), (10, 3)] {
            let pane = pane_area(w, h);
            assert!(pane.right() <= w && pane.bottom() <= h, "{w}x{h}: {pane:?}");
            assert_eq!(pane.height, h - 2, "{w}x{h}");
            assert!(pane.width >= 1, "{w}x{h}: the pane vanished");
        }
    }

    /// The docked panel takes its column out of the terminal view's band and
    /// gives it back everywhere else: the console keeps the device's screen,
    /// and the assistant rides beside it rather than over it.
    #[test]
    fn the_panel_docks_beside_the_console() {
        let app = App {
            lang: Lang::En,
            ..App::default()
        };
        let wide = area(140, 30);
        let regions = regions_for(wide, app.sidebar_visible, app.panel_wanted());
        assert!(regions.assistant.width > 0, "no panel at 140 columns");
        assert_eq!(
            regions.assistant.x,
            regions.centre.right(),
            "the panel does not start where the pane stops"
        );
        assert_eq!(
            regions.assistant.right(),
            wide.right(),
            "the panel is not flush with the window"
        );

        // The rule is what says the column is the panel's: without it the
        // panel's ground runs into the pane's.
        let buffer = render_buffer(&app, 140, 30).expect("a frame");
        assert_eq!(
            buffer[(regions.assistant.x, 10)].symbol(),
            dividers(&app.theme()),
            "no rule on the panel's edge"
        );
        // The composer and its key hint are painted: a panel with nowhere to
        // type is a panel the user will try to type into.
        let text = render_to_text(&app, 140, 30);
        assert!(text.contains('>'), "no composer marker: {text:?}");
        assert!(text.contains("Ctrl+N"), "no key hint: {text:?}");

        // Any other view gives the band back: the panel belongs to the
        // terminal, and a frame of Diagnostics is not a terminal.
        let elsewhere = App {
            view: View::Diagnostics,
            ..App::default()
        };
        let regions = regions_for(wide, elsewhere.sidebar_visible, elsewhere.panel_wanted());
        assert_eq!(regions.assistant.width, 0, "the panel followed the view");
        assert_eq!(
            regions.centre.right(),
            wide.right(),
            "the pane did not get the columns back"
        );
    }

    /// A window with no room for both gives the panel up rather than the pane:
    /// the device's output is the one thing on screen that cannot be scrolled
    /// smaller, and a share of a band that is too narrow for it is no panel at
    /// all — two columns of chat is a pane with its edge worn off.
    #[test]
    fn a_narrow_band_gives_the_panel_up() {
        let app = App::default();
        let regions = regions_for(area(80, 24), app.sidebar_visible, true);
        assert_eq!(regions.assistant.width, 0, "the panel squeezed the pane");
        assert_eq!(
            regions.centre.width,
            80 - SIDEBAR_WIDTH,
            "the pane did not keep the band"
        );
    }

    /// The panel's share of the band, from the clamps at both ends to the
    /// nothing it becomes when the pane would go below its own minimum.
    #[test]
    fn the_panel_takes_a_share_of_the_band() {
        assert_eq!(assistant_width(0), 0);
        assert_eq!(assistant_width(79), 0, "no room below the minimum");
        assert_eq!(
            assistant_width(80),
            ASSISTANT_WIDTH_MIN,
            "the smallest panel is the minimum"
        );
        assert_eq!(assistant_width(120), 50, "the share is five twelfths");
        assert_eq!(
            assistant_width(400),
            ASSISTANT_WIDTH_MAX,
            "the largest panel is the maximum"
        );
        // Whatever the width, the pane keeps its own minimum whenever the
        // panel is shown at all.
        for width in 0..400u16 {
            let panel = assistant_width(width);
            if panel > 0 {
                assert!(
                    width - panel >= CENTRE_MIN,
                    "{width} left the pane {} columns",
                    width - panel
                );
            }
        }
    }

    /// The page takes the window whole: no column is held back as air on
    /// either side.
    ///
    /// A page shifted sideways as a block is what a terminal shows up worst —
    /// every edge stops lining up with the window's own — and the small air a
    /// pane wants is already inside the pane, in the indent its rows carry.
    #[test]
    fn the_frame_takes_the_window_whole() {
        for (w, h) in [(110u16, 30u16), (80, 24), (40, 10)] {
            let regions = regions(area(w, h), true);
            assert_eq!(regions.top_bar.x, 0, "{w}x{h}");
            assert_eq!(regions.top_bar.width, w, "{w}x{h}");
            assert_eq!(regions.sidebar.x, 0, "{w}x{h}: the rail is not indented");
            assert_eq!(
                regions.centre.right(),
                w,
                "{w}x{h}: the last column is used"
            );
            // And the first column is ink, not a margin: the rail's ground is
            // painted there.
            let app = App::default();
            let buffer = render_buffer(&app, w, h).expect("a frame");
            let ground = buffer
                .cell((0, h / 2))
                .expect("the first column is painted");
            assert_eq!(
                ground.style().bg,
                Some(app.theme().panel),
                "{w}x{h}: column 0 is not the rail's ground"
            );
        }
    }

    /// The screenshot's frame, painted: a device whose bytes are not text, on
    /// the old console.
    ///
    /// The pane paints `U+FFFD` for every byte it could not decode, and conhost
    /// draws each of those two cells wide — a row of them walked the rest of
    /// the line off its own end. The compatibility pass is what stops that, and
    /// this is the invariant at the level the user saw it: *nothing in a
    /// painted frame is a glyph the old console would widen.*
    #[test]
    fn a_painted_frame_holds_no_glyph_the_old_console_would_widen() {
        use unicode_width::UnicodeWidthChar;

        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        app.legacy_console = true;
        // A line's worth of bytes that are not text, then the tail the
        // screenshot showed beside them.
        app.terminal.push(&[0xffu8; 57]);
        app.terminal.push(b" 25.3C");

        let painted = render_buffer(&app, 100, 30).expect("the frame paints");
        assert!(
            painted.content.iter().any(|cell| cell.symbol() == "?"),
            "the pane's lost bytes are painted as something"
        );
        for cell in &painted.content {
            let mut chars = cell.symbol().chars();
            let Some(ch) = chars.next() else { continue };
            if chars.next().is_some() {
                // A composed cell (none today) is not one glyph, and not what
                // this pass is about.
                continue;
            }
            assert_eq!(
                UnicodeWidthChar::width(ch),
                UnicodeWidthChar::width_cjk(ch),
                "{ch:?} survived into the painted frame: the old console would draw it two cells wide and walk the rest of the row"
            );
        }

        // And it was the pass that did it: with the pass off — the frame the
        // design asks for, on a terminal that agrees with it — the pane still
        // carries the replacement glyphs the device earned, and the bar still
        // counts the bytes behind them.
        app.legacy_console = false;
        let design = render_buffer(&app, 100, 30).expect("the frame paints");
        assert!(
            design
                .content
                .iter()
                .any(|cell| cell.symbol() == "\u{fffd}"),
            "the pane paints the device's bytes as they arrived"
        );
        let text = render_to_text(&app, 100, 30);
        assert!(
            text.contains("乱码 57B"),
            "and the bottom bar says how many bytes were lost:\n{text}"
        );

        // The window the screenshot came from: no room for the chip beside the
        // key hints, so it is given up whole rather than drawn half-way — and
        // the state, which is what that row is for, is still there.
        let narrow = render_to_text(&app, 85, 24);
        let bottom = narrow.lines().last().unwrap_or_default().to_string();
        assert!(bottom.contains(app.state_name()), "{bottom}");
        assert!(!bottom.contains("乱"), "the chip is not cut: {bottom}");
        assert!(!bottom.contains("待发"), "nor a chip that is not armed");
    }

    /// With the rail closed the centre takes the whole middle band: same bottom
    /// bar, same top bar, and the width the sidebar used to hold. Nothing is
    /// reserved for a rail the user asked to be rid of.
    #[test]
    fn a_closed_rail_gives_the_centre_the_band() {
        for (w, h) in [(120u16, 40u16), (80, 24), (40, 10), (10, 3)] {
            let open = regions(area(w, h), true);
            let closed = regions(area(w, h), false);
            assert_eq!(closed.top_bar, open.top_bar, "{w}x{h}: top bar moved");
            assert_eq!(
                closed.bottom_bar, open.bottom_bar,
                "{w}x{h}: bottom bar moved"
            );
            assert_eq!(closed.sidebar.width, 0, "{w}x{h}: rail kept width");
            assert_eq!(
                closed.centre.width,
                open.sidebar.width + open.centre.width,
                "{w}x{h}: centre did not gain the rail's column"
            );
            assert_eq!(
                closed.centre.height, open.centre.height,
                "{w}x{h}: height moved"
            );
        }
    }

    /// A closed rail leaves a zero-width strip at the origin, so a caller that
    /// still hands it to a painter draws nothing rather than panicking, and it
    /// never overlaps the centre it just gave up.
    #[test]
    fn a_closed_rail_is_a_zero_width_strip() {
        let r = regions(area(120, 40), false);
        assert_eq!(r.sidebar.width, 0);
        assert_eq!(r.sidebar.x, 0);
        assert_eq!(
            r.sidebar.right(),
            r.centre.x,
            "the strip reaches into the centre"
        );
    }

    /// The whole frame through the compatibility pass: the mark's half blocks
    /// become `=`, not the `?` an unmapped ambiguous glyph gets. A screenshot
    /// of the old console showed the mark as a field of question marks because
    /// `▀` was missing from the stand-in table while `▄` was already in it.
    #[test]
    fn the_old_console_keeps_the_marks_half_blocks() {
        let app = App {
            legacy_console: true,
            splash_until: Some(std::time::Instant::now() + std::time::Duration::from_secs(60)),
            ..App::default()
        };
        let buffer = render_buffer(&app, 60, 24).expect("a frame paints");
        let painted: String = buffer.content.iter().map(|cell| cell.symbol()).collect();
        assert!(
            painted.contains('='),
            "the mark lost its half blocks: {painted:?}"
        );
        assert!(
            !painted.contains('?'),
            "the mark kept the unknown stand-in: {painted:?}"
        );
    }

    /// The splash mark is transparent: the first frame a user sees has no
    /// white plate and no reset rectangle behind the picture, so the
    /// terminal's own ground shows through just as it does on the About card.
    #[test]
    fn the_splash_mark_has_no_plate() {
        let app = App {
            splash_until: Some(std::time::Instant::now() + std::time::Duration::from_secs(60)),
            ..App::default()
        };
        let buffer = render_buffer(&app, 120, 40).expect("a frame paints");
        let white = buffer
            .content
            .iter()
            .filter(|cell| cell.bg == ratatui::style::Color::Rgb(255, 255, 255))
            .count();
        assert_eq!(white, 0, "the splash mark has a white plate");
    }

    /// A window too narrow for both halves yields sidebar width to the centre:
    /// a view is never squeezed to nothing to keep an empty strip.
    #[test]
    fn a_narrow_window_gives_the_sidebar_less_room() {
        let wide = regions(area(20, 10), true);
        assert_eq!(wide.sidebar.width, 19);
        assert_eq!(wide.centre.width, 1);
        let narrow = regions(area(10, 10), true);
        assert_eq!(narrow.sidebar.width, 9);
        assert_eq!(narrow.centre.width, 1);
    }

    /// The rail is its rows and nothing else: the mark that used to ride the
    /// spare room at its top belongs to the splash now, so no rail at any
    /// height opens with picture glyphs. The rows never carry half blocks
    /// themselves — which is exactly what made the mark's `▀`/`▄` a mark a
    /// person could see in the first place.
    #[test]
    fn the_rail_is_rows_and_no_mark() {
        let app = App {
            lang: Lang::En,
            ..App::default()
        };
        for line in sidebar::lines(&app, &Theme::DARK, SIDEBAR_TEXT_WIDTH) {
            let text: String = line
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect();
            assert!(
                !text.contains('▀') && !text.contains('▄'),
                "the rail opened with a mark: {text:?}"
            );
        }
    }

    /// A degenerate area yields without panicking: zero-width and zero-height
    /// terminals happen while a window is being resized.
    #[test]
    fn degenerate_areas_do_not_panic() {
        for (w, h) in [(0, 0), (1, 1), (0, 20), (20, 0), (3, 2)] {
            let regions = regions(area(w, h), true);
            for region in [
                regions.top_bar,
                regions.sidebar,
                regions.centre,
                regions.bottom_bar,
            ] {
                assert!(
                    region.right() <= w && region.bottom() <= h,
                    "{w}x{h}: {region:?} spills out of the area"
                );
            }
        }
    }

    /// The rail's edge is drawn: one rule down the middle band, in the rail's
    /// last column, and never through the bars.
    #[test]
    fn the_divider_runs_down_the_middle_band_only() {
        let app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        let text = render_to_text(&app, 110, 30);
        let rows: Vec<&str> = text.lines().collect();
        assert_eq!(rows.len(), 30);
        let divider = dividers(&app.theme());
        for (y, row) in rows.iter().enumerate() {
            let carries = row.contains(&divider);
            if y == 0 || y == 29 {
                assert!(!carries, "row {y} runs the rule through a bar: {row:?}");
            } else {
                assert!(carries, "row {y} is missing the rule: {row:?}");
                let before = row.split(&divider).next().unwrap();
                assert_eq!(
                    crate::text::columns(before),
                    SIDEBAR_TEXT_WIDTH as usize,
                    "row {y} puts the rule in the wrong column: {row:?}"
                );
            }
        }
    }

    /// The two languages lay the sidebar out row for row: the same rows carry
    /// content, each starting in the same column.
    ///
    /// This is the property the design broke. Its English hint was one column
    /// too long for the sidebar, so it wrapped onto a second line and pushed
    /// `Watch` — and everything after it — one row below the Chinese one; and
    /// its English state row was drawn on top of the row beneath it. Neither
    /// can happen here: the plan is a function of the session state, and a row
    /// is fitted to its column rather than wrapped.
    #[test]
    fn the_sidebar_lays_out_the_same_in_both_languages() {
        for (width, height) in [(110u16, 30u16), (96, 24), (80, 20)] {
            let ink = |lang: Lang| -> Vec<(bool, Option<usize>)> {
                let app = App {
                    lang,
                    ..App::default()
                };
                let buffer = render_buffer(&app, width, height).expect("a frame");
                (0..height)
                    .map(|y| {
                        let filled: Vec<usize> = (0..SIDEBAR_TEXT_WIDTH)
                            .filter(|x| buffer[(*x, y)].symbol() != " ")
                            .map(|x| x as usize)
                            .collect();
                        (!filled.is_empty(), filled.first().copied())
                    })
                    .collect()
            };
            let zh = ink(Lang::Zh);
            let en = ink(Lang::En);
            assert_eq!(zh.len(), en.len(), "{width}x{height}");
            for (y, (zh, en)) in zh.iter().zip(&en).enumerate() {
                assert_eq!(
                    zh.0, en.0,
                    "{width}x{height}: row {y} has content in one language only"
                );
                assert_eq!(
                    zh.1, en.1,
                    "{width}x{height}: row {y} starts in a different column"
                );
            }
        }
    }

    /// The terminal pane carries its status pill, flush right on its head row
    /// with one column of margin — the same columns in every language, because
    /// the pill is right-aligned and only its width moves.
    #[test]
    fn the_terminal_pane_carries_its_status_pill() {
        for lang in [Lang::Zh, Lang::En] {
            let app = App {
                lang,
                ..App::default()
            };
            // The chip runs to here and stops: the pane's last column is the
            // margin. Which column that is comes from the one place that
            // decides it — the frame carries the assistant's panel too, and a
            // second copy of the width arithmetic here is what would drift.
            let centre = regions_for(area(110, 30), app.sidebar_visible, app.panel_wanted());
            let chip_right = centre.centre.right() - 1 - PILL_MARGIN;
            let theme = app.theme();
            let buffer = render_buffer(&app, 110, 30).expect("a frame");
            let row = 1;
            let chip = |x: u16| buffer[(x, row)].bg == theme.panel_3;
            assert!(chip(chip_right), "{lang:?} the pill stops short");
            assert!(!chip(chip_right + 1), "{lang:?} the pill has no margin");
            assert!(
                !(0..SIDEBAR_WIDTH).any(chip),
                "{lang:?} the pill covers the rail"
            );
            // The pill carries the live state, and the row carries nothing else.
            let text = render_to_text(&app, 110, 30);
            let head = text.lines().nth(1).unwrap_or_default();
            assert!(head.contains(app.state_name()), "{lang:?} {head:?}");
        }
    }

    /// A framed view puts its title on the border instead, so it grows no pill.
    #[test]
    fn a_framed_view_has_no_status_pill() {
        let app = App {
            view: View::Diagnostics,
            ..App::default()
        };
        let buffer = render_buffer(&app, 110, 30).expect("a frame");
        let tail: String = (SIDEBAR_WIDTH..110)
            .map(|x| buffer[(x, 1)].symbol())
            .collect();
        assert!(!tail.contains('●'), "a framed view grew a pill: {tail:?}");
    }

    /// A pane too narrow for its pill drops it rather than showing half a chip.
    #[test]
    fn a_narrow_pane_drops_its_status_pill() {
        let app = App::default();
        let text = render_to_text(&app, 40, 12);
        assert!(!text.contains('●'), "{text}");
        // Wide enough, and it is back.
        let wide = render_to_text(&app, 110, 30);
        assert!(wide.contains('●'), "{wide}");
    }

    /// The pane carries its scrollbar only when its history runs past the
    /// window, and the thumb walks up the right column as the user scrolls
    /// back — resting on the bottom row while the view follows the tail.
    #[test]
    fn the_terminal_pane_carries_a_scrollbar_when_the_history_runs_past_it() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        // The pane's last column — from the layout's own arithmetic, because
        // the assistant's panel takes its share off the right — and the pane's
        // rows: the middle band, minus the pill's own margin.
        let column = regions_for(area(110, 30), app.sidebar_visible, app.panel_wanted())
            .centre
            .right()
            - 1;
        let thumb = |app: &App| -> Vec<u16> {
            let buffer = render_buffer(app, 110, 30).expect("a frame");
            (1..29)
                .filter(|y| buffer[(column, *y)].symbol() == "┃")
                .collect()
        };

        assert!(thumb(&app).is_empty(), "a fresh pane drew a bar");

        // More rows than the pane can show: the bar appears, its thumb on the
        // bottom while the view follows the tail.
        app.terminal.push_text(&"row\n".repeat(200));
        let following = thumb(&app);
        assert!(!following.is_empty(), "no bar with 200 rows of history");
        assert_eq!(*following.last().unwrap(), 28, "the tail is not the bottom");

        // Scrolled back, the thumb sits above where it did: the same content,
        // walked up the track.
        app.scroll_terminal(150);
        let back = thumb(&app);
        assert!(
            !back.is_empty(),
            "the bar went away when it was needed most"
        );
        assert!(
            back[0] < following[0],
            "{back:?} did not move up from {following:?}"
        );

        // Back at the tail, `scroll_terminal_down` resumes following, and the
        // bar is on the bottom row again.
        app.scroll_terminal_down(usize::MAX / 2);
        assert_eq!(*thumb(&app).last().unwrap(), 28, "the tail did not resume");
    }

    /// The top bar's traffic unit shows when the bar has room: the rate's
    /// label and the block graph at the right end. A bar too narrow to spare
    /// the columns keeps its counters and nothing else.
    #[test]
    fn the_top_bar_shows_the_traffic_graph_when_it_fits() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.traffic.rate = 300;
        // Both directions carry history, and different history — the halves
        // must be told apart by their data as well as their colours — but RX
        // leads on the scale, which is the shape a terminal session has.
        app.traffic
            .rx_window
            .extend([0u64, 0, 120, 900, 6000, 2000, 300]);
        app.traffic
            .tx_window
            .extend([0u64, 900, 2400, 1600, 800, 400, 200]);
        app.clock = "19:52:50".to_string();

        let text = render_to_text(&app, 120, 30);
        let head = text.lines().next().unwrap_or_default().to_string();
        assert!(head.contains("300 B/s"), "no rate label: {head:?}");
        assert!(head.contains("RX 0 · TX 0"), "the counters left: {head:?}");
        let buffer = render_buffer(&app, 120, 30).expect("a frame");
        let blocks = (0..120u16)
            .filter(|x| "▁▂▃▄▅▆▇█".contains(buffer[(*x, 0)].symbol()))
            .count();
        assert!(blocks >= 3, "the graph did not paint: {blocks} cells");
        // One arrow per direction, in the colour its graph is drawn in — the
        // pair the counters wear, and what says which half is which.
        let arrow = |glyph: &str| {
            (0..120u16)
                .find(|x| buffer[(*x, 0)].symbol() == glyph)
                .unwrap_or_else(|| panic!("the bar carries no {glyph}"))
        };
        let theme = app.theme();
        let rx_head = arrow("↓");
        let tx_head = arrow("↑");
        assert_eq!(buffer[(rx_head, 0)].fg, theme.accent);
        assert_eq!(buffer[(tx_head, 0)].fg, theme.focus);
        assert!(rx_head < tx_head, "RX heads the left half and TX the right");
        // The halves share the unit evenly rather than one eating the other:
        // at this width the bar has 22 columns for the unit and both halves
        // must get their arrow and some graph behind it.
        assert!(
            tx_head - rx_head >= 4 && 120 - tx_head >= 4,
            "the halves are uneven: RX half {} cells, TX half {}",
            tx_head - rx_head,
            120 - tx_head
        );
        // And each half really paints in that colour: two series in two
        // colours, not one series wearing both arrows.
        let is_block = |x: u16| "▁▂▃▄▅▆▇█".contains(buffer[(x, 0)].symbol());
        assert!(
            (rx_head..tx_head).any(|x| is_block(x) && buffer[(x, 0)].fg == theme.accent),
            "the RX half painted no accent blocks"
        );
        assert!(
            (tx_head..120).any(|x| is_block(x) && buffer[(x, 0)].fg == theme.focus),
            "the TX half painted no focus blocks"
        );

        // The classic 80-column bar: the unit is the first thing given up.
        let narrow = render_to_text(&app, 80, 30);
        let head = narrow.lines().next().unwrap_or_default().to_string();
        assert!(
            !head.contains("B/s"),
            "the graph stayed on a narrow bar: {head:?}"
        );
        assert!(
            head.contains("RX 0 · TX 0"),
            "the counters went with it: {head:?}"
        );
    }

    #[test]
    fn network_focus_remains_visible_beyond_a_long_scan_list() {
        use crate::views::network::NetworkRow;

        for (width, height, results) in [(80, 24, 10), (120, 30, 20), (80, 12, 20)] {
            let mut app = App {
                lang: Lang::En,
                view: View::Network,
                ..App::default()
            };
            app.network.scan_results = (0..results)
                .map(|i| format!("Network-{i} wpa2 ch=6 -54dBm"))
                .collect();
            // Extra lines must not shift the focus out of the viewport.
            app.network.loading = true;
            app.network.error = Some("Previous request failed".to_string());
            for (focus, label) in [
                (
                    NetworkRow::ScanResult(results - 1),
                    format!("Network-{}", results - 1),
                ),
                (NetworkRow::Url, "Upload URL".to_string()),
                (NetworkRow::WebdavSet, "[Set WebDAV]".to_string()),
                (NetworkRow::WebdavOff, "[WebDAV off]".to_string()),
                (NetworkRow::WebdavStatus, "[WebDAV status]".to_string()),
                (NetworkRow::BleName, "Current name".to_string()),
                (NetworkRow::BleNameRename, "[Rename]".to_string()),
                (NetworkRow::BleNameDefault, "[Restore default]".to_string()),
                (NetworkRow::BleNameStatus, "[Read name]".to_string()),
            ] {
                app.network.focus = focus;
                let frame = render_to_text(&app, width, height);
                assert!(
                    frame.contains(&label),
                    "{width}x{height}, {focus:?}:\n{frame}"
                );
            }
            app.network.focus_next(); // Wrap from the final control to the form.
            let frame = render_to_text(&app, width, height);
            assert!(frame.contains("Network name"), "{frame}");
        }
    }

    /// A tiny TX rate beside a large RX one is still activity, not idle: the
    /// shared ruler lifts any nonzero sample to the smallest visible bar.
    /// Before that floor, a few bytes a second against a large receive stream
    /// rounded to zero and the TX graph looked like a link that had nothing to
    /// say.
    #[test]
    fn a_tiny_tx_rate_is_not_painted_as_an_idle_direction() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.traffic.rx_window.extend([800u64]);
        app.traffic.tx_window.extend([1u64]);

        let width = 120u16;
        let buffer = render_buffer(&app, width, 30).expect("a frame");
        let theme = app.theme();
        let tx_head = (0..width)
            .find(|x| buffer[(*x, 0)].symbol() == "↑")
            .expect("the bar carries a TX head");
        let tx_bars: Vec<u16> = (tx_head + 1..width)
            .filter(|x| buffer[(*x, 0)].symbol() == "▁")
            .collect();
        assert!(
            !tx_bars.is_empty(),
            "a nonzero TX rate painted no bar: {:?}",
            (tx_head + 1..width)
                .map(|x| buffer[(x, 0)].symbol())
                .collect::<Vec<_>>()
        );
        assert!(
            tx_bars.iter().any(|x| buffer[(*x, 0)].fg == theme.focus),
            "the TX bar is not in the TX colour"
        );
    }

    /// A quiet link is a shape, not a hole: with nothing in the windows the
    /// graphs draw their zero line — the baseline mark — where the stock
    /// symbol set would leave the strip blank, and every cell of the unit
    /// stands on the bar's own ground rather than on the console's.
    #[test]
    fn an_idle_traffic_unit_draws_a_zero_line_on_its_ground() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        // A session up long enough for both windows to fill, that has heard
        // nothing yet.
        app.traffic.rx_window.extend([0u64; 48]);
        app.traffic.tx_window.extend([0u64; 48]);

        let width = 120u16;
        let buffer = render_buffer(&app, width, 30).expect("a frame");
        let theme = app.theme();
        let unit = chrome::traffic_unit(width);
        let start = width - unit;
        // The whole unit is on the bar's ground: the console's own background
        // is what showed through as a moving patch before.
        for x in start..width {
            assert_eq!(
                buffer[(x, 0)].bg,
                theme.panel,
                "column {x} of the unit is not on the ground"
            );
        }
        // Both halves carry the zero line, each in its own colour.
        let zeros: Vec<u16> = (start..width)
            .filter(|x| buffer[(*x, 0)].symbol() == "_")
            .collect();
        assert!(zeros.len() >= 4, "the zero line is missing: {zeros:?}");
        assert!(
            zeros.iter().any(|x| buffer[(*x, 0)].fg == theme.accent),
            "the RX half's zero line is not in the RX colour"
        );
        assert!(
            zeros.iter().any(|x| buffer[(*x, 0)].fg == theme.focus),
            "the TX half's zero line is not in the TX colour"
        );
    }

    /// A rendered frame shows the designed chrome: the top bar's counters, every
    /// sidebar section and view, and the bottom bar's hints.
    #[test]
    fn a_rendered_frame_shows_the_designed_chrome() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        app.clock = "19:52:50".to_string();
        let text = render_to_text(&app, 120, 40);
        let lines: Vec<&str> = text.lines().collect();
        assert!(
            lines[0].contains("连接中…") || lines[0].contains("未连接"),
            "{}",
            lines[0]
        );
        assert!(
            lines[0].contains("RX 0") && lines[0].contains("19:52:50"),
            "{}",
            lines[0]
        );
        assert_eq!(lines.len(), 40);
        let last = lines[39];
        assert!(
            last.starts_with("[终端]"),
            "the bar starts at the window's edge, with no air column: {last:?}"
        );
        assert!(last.contains("Ctrl+Q 退出"), "{last:?}");
        for needle in ["连接", "视图", "快捷发送", "监控", "串口终端"] {
            assert!(text.contains(needle), "frame is missing {needle:?}\n{text}");
        }
        // The sidebar ends where the centre column begins.
        let sidebar_row = lines.iter().find(|l| l.contains("串口终端")).unwrap();
        assert!(!sidebar_row.contains("Ctrl"), "{sidebar_row:?}");
    }

    /// The frame's width is exactly the area's width: a row that ran long would
    /// wrap and shift every row below it — the layout bug the old TUI hit.
    #[test]
    fn no_row_ever_exceeds_the_area_width() {
        for width in [40u16, 60, 80, 120] {
            let app = App::default();
            let text = render_to_text(&app, width, 24);
            for line in text.lines() {
                assert!(
                    unicode_width::UnicodeWidthStr::width(line) <= width as usize,
                    "row wider than {width}: {line:?}"
                );
            }
        }
    }

    /// The terminal view paints its own ground and no frame; a framed view
    /// paints a border with its title on it.
    #[test]
    fn the_terminal_view_is_unframed_and_the_others_are_framed() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        let terminal = render_to_text(&app, 80, 12);
        assert!(
            !terminal.contains('╭'),
            "the terminal pane grew a frame:\n{terminal}"
        );

        app.view = View::Diagnostics;
        let framed = render_to_text(&app, 80, 12);
        assert!(framed.contains("Diagnostics"), "no title:\n{framed}");
        assert!(
            framed.contains('╭') && framed.contains('╯'),
            "no rounded frame:\n{framed}"
        );
    }

    /// A toast appears over the top-right corner, under the top bar, with its
    /// text intact — and a framed view behind it is not overwritten.
    #[test]
    fn a_toast_paints_in_the_corner() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        let without = render_to_text(&app, 100, 20);
        assert!(!without.contains("主题"));

        app.push_notice(crate::app::Notice {
            text: "主题: 浅色".to_string(),
            level: NoticeLevel::Info,
        });
        let with = render_to_text(&app, 100, 20);
        assert!(with.contains("主题: 浅色"), "{with}");
        let toast_row = with.lines().find(|l| l.contains("主题")).unwrap();
        assert!(
            unicode_width::UnicodeWidthStr::width(toast_row) > 80,
            "the toast is not in the right-hand corner: {toast_row:?}"
        );
        // The frame's row count is unchanged: the toast overlays, it does not
        // reflow the layout.
        assert_eq!(with.lines().count(), without.lines().count());
    }

    /// The column the toast's left border is in never holds a glyph wide
    /// enough to be drawn across it.
    ///
    /// A cell right after a wide glyph is taken for the glyph's own second
    /// half by the frame's diff and is then never sent to the terminal — the
    /// border written there is simply dropped, and the box comes up with a
    /// hole down the middle of its left side, which is what a screenshot
    /// showed. The box's own arithmetic decides where the edge lands, so the
    /// sweep is over a spread of widths rather than over anything found in the
    /// frame.
    #[test]
    fn nothing_wide_reaches_into_a_toast_border() {
        use ratatui::buffer::CellWidth;
        for width in 30..140u16 {
            let mut app = App {
                lang: Lang::Zh,
                ..App::default()
            };
            app.push_notice(crate::app::Notice {
                text:
                    "连接中：正在查找设备…（一条较长的中文通知，让边框左侧正好与背景的宽字符重叠）"
                        .to_string(),
                level: NoticeLevel::Info,
            });
            let toast_width = toast::width(&app.notices, app.glyph()).min(width);
            let height = app.notices.len() as u16 + 2;
            let edge = width - toast_width;
            let Some(buffer) = render_buffer(&app, width, 24) else {
                continue;
            };
            for row in 0..height {
                let symbol = match row {
                    0 => "┌",
                    row if row == height - 1 => "└",
                    _ => "│",
                };
                assert_eq!(
                    buffer[(edge, BAR_HEIGHT + row)].symbol(),
                    symbol,
                    "width {width}, row {row}: the box's left side went missing"
                );
                if edge > 0 {
                    assert!(
                        buffer[(edge - 1, BAR_HEIGHT + row)].cell_width() <= 1,
                        "width {width}, row {row}: a glyph wide enough to be drawn across the border was left beside it"
                    );
                }
            }
        }
    }

    /// A frame is a pure function of the state: the same state paints the same
    /// bytes every time.
    #[test]
    fn a_frame_is_deterministic() {
        let app = App {
            state: ConnectionState::Connected,
            rx: 1234,
            clock: "01:02:03".to_string(),
            ..App::default()
        };
        let first = render_to_text(&app, 100, 30);
        let second = render_to_text(&app, 100, 30);
        assert_eq!(first, second);
    }

    /// Switching the theme changes the bytes, so a light-mode frame cannot be
    /// the dark one — and the layout is identical, only the colours moved.
    #[test]
    fn switching_the_theme_repaints_the_same_layout() {
        let mut app = App::default();
        let dark = render_to_text(&app, 100, 30);
        app.theme = crate::theme::ThemeChoice::Light;
        let light = render_to_text(&app, 100, 30);
        assert_eq!(dark.lines().count(), light.lines().count());
        assert_eq!(dark, light, "text layout must not depend on the theme");
    }

    /// Strip every escape sequence, leaving the characters a terminal would
    /// show — what the ANSI dump and the plain dump must agree on.
    fn strip_ansi(text: &str) -> String {
        let mut out = String::new();
        let mut in_escape = false;
        for ch in text.chars() {
            if in_escape {
                if ch == 'm' {
                    in_escape = false;
                }
            } else if ch == '\u{1b}' {
                in_escape = true;
            } else {
                out.push(ch);
            }
        }
        out
    }

    /// The ANSI dump is the same frame as the text dump, with colour: the
    /// characters match row for row, so the two can never drift. Only trailing
    /// blanks differ — the ANSI dump keeps them because they carry the panel
    /// background, the text dump trims them so golden text stays readable.
    #[test]
    fn the_ansi_dump_and_the_text_dump_are_the_same_frame() {
        let app = App::default();
        let text: Vec<String> = render_to_text(&app, 80, 20)
            .lines()
            .map(|line| line.trim_end().to_string())
            .collect();
        let ansi: Vec<String> = strip_ansi(&render_to_ansi(&app, 80, 20))
            .lines()
            .map(|line| line.trim_end().to_string())
            .collect();
        assert_eq!(ansi, text);
    }

    /// The dump carries true colour: the accent chip's own RGB is in there, so
    /// a viewer sees the palette rather than the emulator's defaults.
    #[test]
    fn the_ansi_dump_carries_true_colour() {
        let app = App::default();
        let ansi = render_to_ansi(&app, 80, 20);
        let accent_bg = Theme::DARK.accent;
        let ratatui::style::Color::Rgb(r, g, b) = accent_bg else {
            panic!("the accent is not an RGB colour");
        };
        let chip = format!("48;2;{r};{g};{b}");
        assert!(
            ansi.contains(&chip),
            "no accent background {chip} in the dump"
        );
        // Every row ends with a reset, so colour cannot leak between rows.
        for line in ansi.lines() {
            assert!(
                line.ends_with("\u{1b}[0m"),
                "{line:?} does not end with a reset"
            );
        }
    }

    /// Switching the theme changes the dump's colours but not its text.
    #[test]
    fn the_ansi_dump_follows_the_theme() {
        let app = App::default();
        let dark = render_to_ansi(&app, 60, 12);
        let light = render_to_ansi(
            &App {
                theme: crate::theme::ThemeChoice::Light,
                ..App::default()
            },
            60,
            12,
        );
        assert_ne!(dark, light);
        let rows = |dump: &str| -> Vec<String> {
            strip_ansi(dump)
                .lines()
                .map(|line| line.trim_end().to_string())
                .collect()
        };
        assert_eq!(rows(&dark), rows(&light));
    }

    /// A degenerate area dumps nothing rather than panicking, so a dumped
    /// frame is safe to produce at any size.
    #[test]
    fn the_ansi_dump_survives_a_degenerate_area() {
        let app = App::default();
        for (w, h) in [(1u16, 1u16), (0, 0), (2, 3)] {
            let ansi = render_to_ansi(&app, w, h);
            assert_eq!(ansi.lines().count(), h as usize, "{w}x{h}");
        }
    }

    /// A tiny terminal renders without panicking and without a row longer than
    /// the area, which is the resize-storm case.
    #[test]
    fn tiny_terminals_render_without_panicking() {
        for (w, h) in [(1u16, 1u16), (2, 2), (5, 3), (12, 4), (30, 2)] {
            let app = App::default();
            let text = render_to_text(&app, w, h);
            assert_eq!(text.lines().count(), h as usize, "{w}x{h}");
            for line in text.lines() {
                assert!(
                    unicode_width::UnicodeWidthStr::width(line) <= w as usize,
                    "{w}x{h}: {line:?}"
                );
            }
        }
    }
}
