//! The compatibility pass for the old Windows console.
//!
//! Windows has two consoles behind the same window: Windows Terminal, which
//! is a modern terminal emulator and the one the interface was designed
//! against, and conhost — the host every console application got before it,
//! still what a plain `bee.exe` opens in. conhost is not a terminal
//! emulator in the same sense: it re-renders the screen itself, draws its own
//! scrollbar over the right edge, and decides on its own how wide a glyph is.
//!
//! Three of its decisions are what a frame painted the ordinary way runs
//! into, and each has one cheap, local answer:
//!
//! * **Synthetic bold.** conhost has no bold face for most of the fonts it
//!   can be given, so it fakes it by drawing the glyph twice, a pixel apart.
//!   On Latin text that reads as bold; on CJK it smears the strokes into the
//!   neighbouring cell — the "two characters drawn on top of each other" a
//!   screenshot showed. The pass takes `BOLD` off every cell: the console
//!   keeps its own idea of emphasis (the colour is still ours), and nothing
//!   bleeds.
//! * **Ambiguous widths.** In a console using a CJK font or code page, the
//!   characters Unicode marks "ambiguous" — box drawing, block elements,
//!   arrows, `…`, `·` — are drawn *two* cells wide, where the width tables
//!   ratatui uses put them in one. A frame is laid out by those tables, so
//!   every ambiguous glyph pushes the rest of its line a cell to the right:
//!   labels ride over their neighbours and the line's end is clipped. The
//!   pass replaces the glyphs this interface draws with one-cell stand-ins
//!   ([`STAND_INS`]) — the same shapes in ASCII, which no font renders wide —
//!   and every *other* ambiguous glyph with a `?` ([`UNKNOWN`]): the device's
//!   own text is full of them too (the replacement character a bad byte turns
//!   into, `℃`, `±`, `°`), and one of those widening in place walks the rest
//!   of the device's line to the right just as surely as a label's arrow did.
//! * **The right edge.** The console's scrollbar lies over the window's last
//!   column or two, and the frame's right edge — the counters, the tail of a
//!   line — is painted under it. [`RIGHT_MARGIN`] columns are kept free of
//!   *text* for it, and [`prepare`] carries the background of the cell beside
//!   them across: an unpainted margin is the terminal's own background, which
//!   on a light theme is a black band down the right edge — what one
//!   screenshot showed.
//!
//! All of this is off unless the process is talking to conhost: Windows
//! Terminal sets `WT_SESSION` in its environment, and a terminal that does
//! not is a terminal that gets the frame the design asks for. The pass is a
//! pure function of the buffer, so the tests can paint one and look.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use unicode_width::UnicodeWidthChar;

/// Columns kept free at the right edge under the legacy console, where the
/// scrollbar sits over the window's last cells.
///
/// Two, because conhost's scrollbar is one and the column behind it — the
/// one a wide glyph can bleed a pixel into — is the other.
pub const RIGHT_MARGIN: u16 = 2;

/// Whether this process is painting for the legacy console.
pub fn legacy_console() -> bool {
    legacy_console_for(cfg!(windows), std::env::var_os("WT_SESSION").is_some())
}

/// The rule itself, apart from the environment so it can be tested.
fn legacy_console_for(windows: bool, has_wt_session: bool) -> bool {
    windows && !has_wt_session
}

/// The area a frame is painted into.
///
/// The whole window but for the margin the scrollbar takes — and the whole
/// window when there is no legacy console to take it.
pub fn drawing_area(full: Rect, legacy: bool) -> Rect {
    if legacy {
        Rect {
            width: full.width.saturating_sub(RIGHT_MARGIN),
            ..full
        }
    } else {
        full
    }
}

/// Narrow one painted frame: stand-ins for the ambiguous glyphs, no bold, and
/// the margin wearing the row's own ground.
///
/// Painted frames only — inside the draw call, after every widget has run.
/// `--print-frame` and the tests paint through the same call with the pass
/// off, so what is inspected on a developer's machine is what the design
/// asks for, not what one console needs.
pub fn prepare(buffer: &mut Buffer) {
    for cell in &mut buffer.content {
        cell.modifier.remove(Modifier::BOLD);
        if let Some(stand_in) = narrow_symbol(cell.symbol()) {
            cell.set_symbol(stand_in);
        }
    }
    carry_background(buffer);
}

/// Carry each row's background across the margin the scrollbar sits over.
///
/// No widget paints the margin — that is what keeps the frame's text out from
/// under the scrollbar — but a cell nobody paints keeps the terminal's own
/// background, and on a light theme that is a black band down the window's
/// right edge, two columns of it, which is exactly what a screenshot showed.
/// The margin takes the background of the last cell the frame did paint and
/// nothing else: the symbol a blank was left as stays a blank.
fn carry_background(buffer: &mut Buffer) {
    let area = buffer.area;
    // The last column a widget painted: the drawing area is the window but
    // for the margin, and the margin is what this walks.
    let Some(source) = area.width.checked_sub(RIGHT_MARGIN + 1) else {
        return;
    };
    let source = area.x + source;
    for y in area.y..area.bottom() {
        let bg = buffer[(source, y)].bg;
        for x in (area.right() - RIGHT_MARGIN)..area.right() {
            buffer[(x, y)].set_bg(bg);
        }
    }
}

/// The stand-in for a symbol, when there is one.
///
/// Single-glyph symbols only: a cell holding a composed sequence (an emoji
/// with a modifier, a letter with a combining mark) is not one of this
/// interface's own glyphs, and guessing at its width is exactly the mistake
/// the pass exists to undo.
fn narrow_symbol(symbol: &str) -> Option<&'static str> {
    let mut chars = symbol.chars();
    let ch = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    narrow(ch)
}

/// The stand-ins, as a table so the test below can walk it.
///
/// Every second column is one ASCII cell, and that is the whole requirement:
/// a stand-in that were wider — or itself ambiguous — would move the text it
/// was meant to keep in place. The first column is every ambiguous-width
/// glyph this interface draws, found by walking the source; a glyph the
/// console renders wide that is not here is a line that walks right on the
/// old console, and adding it is one row.
const STAND_INS: [(char, &str); 36] = [
    // Dashes and the small punctuation the layout uses as separators.
    ('\u{2014}', "-"),  // — em dash
    ('\u{2013}', "-"),  // – en dash
    ('\u{b7}', "."),    // · middle dot
    ('\u{2026}', "."),  // … ellipsis
    ('\u{d7}', "x"),    // × multiplication sign
    ('\u{b0}', "o"),    // ° degree sign
    ('\u{2248}', "~"),  // ≈ almost equal
    ('\u{201c}', "\""), // “ left double quote
    ('\u{201d}', "\""), // ” right double quote
    // Arrows, as the hints and labels that use them.
    ('\u{2190}', "<"), // ←
    ('\u{2191}', "^"), // ↑
    ('\u{2192}', ">"), // →
    ('\u{2193}', "v"), // ↓
    // The circles and diamonds that mark state.
    ('\u{25cf}', "*"), // ● filled circle
    ('\u{25c6}', "+"), // ◆ filled diamond
    ('\u{25cb}', "o"), // ○ open circle
    ('\u{25d0}', "o"), // ◐ half-filled circle
    // Bars and blocks: the progress bar and the sparkline, graded so a
    // stand-in still carries the shape the block did.
    ('\u{2580}', "="), // ▀ upper half
    ('\u{2581}', "_"), // ▁ one eighth
    ('\u{2582}', "_"), // ▂ one quarter
    ('\u{2583}', "="), // ▃ three eighths
    ('\u{2584}', "="), // ▄ half
    ('\u{2585}', "#"), // ▅ five eighths
    ('\u{2586}', "#"), // ▆ three quarters
    ('\u{2587}', "#"), // ▇ seven eighths
    ('\u{2588}', "#"), // █ full
    ('\u{258c}', "|"), // ▌ left half
    ('\u{258f}', "|"), // ▏ left one eighth
    ('\u{2591}', "."), // ░ light shade
    // Box drawing: the divider and the corners around it.
    ('\u{2500}', "-"), // ─ horizontal
    ('\u{2502}', "|"), // │ vertical
    ('\u{2503}', "|"), // ┃ heavy vertical
    ('\u{256d}', ","), // ╭ top-left arc
    ('\u{256e}', "."), // ╮ top-right arc
    ('\u{256f}', "'"), // ╯ bottom-right arc
    ('\u{2570}', "`"), // ╰ bottom-left arc
];

/// The one-cell stand-in for a glyph the console would draw two cells wide.
///
/// ASCII returns early — it is most of every frame and none of it needs a
/// stand-in — and the table is walked only for the rest: this interface's own
/// glyphs have stand-ins chosen for the shape they keep. Anything else that
/// is ambiguous by Unicode's tables gets [`UNKNOWN`], because the *layout* is
/// the thing that must not give way: the device picks the glyphs in its own
/// text, and a `�` the console draws two cells wide would shove the rest of
/// that line into its neighbour.
///
/// A glyph that is wide in *every* context — CJK itself — is left alone: the
/// frame and the console agree about it, and the text stays readable.
fn narrow(ch: char) -> Option<&'static str> {
    if ch.is_ascii() {
        return None;
    }
    if let Some(stand_in) = STAND_INS
        .iter()
        .find(|(glyph, _)| *glyph == ch)
        .map(|(_, stand_in)| *stand_in)
    {
        return Some(stand_in);
    }
    let narrow = UnicodeWidthChar::width(ch);
    let cjk = UnicodeWidthChar::width_cjk(ch);
    (narrow != cjk).then_some(UNKNOWN)
}

/// The stand-in for ambiguous glyphs the table has no shape for.
///
/// `?` is the character a console writes for a glyph it cannot draw, which is
/// the truth about these cells on the old console: the byte arrived, the
/// glyph did not render the way the frame was laid out, and the pane still
/// has to be readable. The count in the bottom bar says how many there were;
/// the notice beside it says what to check.
const UNKNOWN: &str = "?";

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Style;
    use unicode_width::UnicodeWidthStr;

    #[test]
    fn windows_terminal_is_not_the_legacy_console() {
        assert!(!legacy_console_for(false, false), "not Windows at all");
        assert!(!legacy_console_for(false, true));
        assert!(
            legacy_console_for(true, false),
            "Windows outside Windows Terminal is the console this pass is for"
        );
        assert!(
            !legacy_console_for(true, true),
            "Windows Terminal says who it is"
        );
    }

    #[test]
    fn the_right_margin_is_kept_only_for_the_legacy_console() {
        let full = Rect::new(0, 0, 100, 30);
        assert_eq!(drawing_area(full, false), full);
        let legacy = drawing_area(full, true);
        assert_eq!(legacy.width, 100 - RIGHT_MARGIN);
        assert_eq!(legacy.height, full.height, "only the right edge gives way");
        // A window too narrow for the margin keeps what width it has.
        assert_eq!(drawing_area(Rect::new(0, 0, 1, 30), true).width, 0);
    }

    /// Every stand-in is one ASCII cell of width one: that is the whole
    /// contract, because a stand-in that were wider than its glyph would move
    /// the line it is in exactly where the glyph did.
    #[test]
    fn every_stand_in_is_one_ascii_cell() {
        for (glyph, stand_in) in STAND_INS {
            assert_eq!(
                stand_in.chars().count(),
                1,
                "{glyph:?} got {stand_in:?}, which is more than one glyph"
            );
            assert!(
                stand_in.is_ascii(),
                "{glyph:?} got {stand_in:?}, which a console could render wide"
            );
            assert_eq!(
                UnicodeWidthStr::width(stand_in),
                1,
                "{glyph:?} got {stand_in:?}, which is not one column"
            );
        }
    }

    /// The ambiguous glyphs themselves, so a glyph that *is* in the table
    /// with an ASCII spelling of its own cannot quietly leave it.
    #[test]
    fn the_tables_glyphs_are_the_ones_the_console_renders_wide() {
        for (glyph, _) in STAND_INS {
            assert!(!glyph.is_ascii(), "{glyph:?} needs no stand-in");
            assert_eq!(
                unicode_width::UnicodeWidthChar::width(glyph),
                Some(1),
                "{glyph:?} is not one column by the tables ratatui lays out with"
            );
            assert_eq!(narrow(glyph), narrow_symbol(&glyph.to_string()));
        }
    }

    /// Both halves of the mark's half-block cells have a stand-in. The logo
    /// is drawn as `▀`/`▄` with the two greens in the foreground and the
    /// background; a `▀` left out of the table fell through to `UNKNOWN`, and
    /// the old console's splash showed a field of question marks where the
    /// mark's upper half should have been.
    #[test]
    fn the_marks_half_blocks_keep_their_place() {
        assert_eq!(narrow('\u{2580}'), Some("="), "▀ has no stand-in");
        assert_eq!(narrow('\u{2584}'), Some("="), "▄ has no stand-in");
    }

    #[test]
    fn prepare_narrows_the_glyphs_and_takes_the_bold_off() {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 5, 1));
        buffer[(0, 0)]
            .set_symbol("│")
            .set_style(Style::default().add_modifier(Modifier::BOLD));
        buffer[(1, 0)]
            .set_symbol("中")
            .set_style(Style::default().add_modifier(Modifier::BOLD));
        buffer[(2, 0)].set_symbol("a");
        buffer[(3, 0)].set_symbol("→");
        buffer[(4, 0)].set_symbol("■");

        prepare(&mut buffer);

        assert_eq!(buffer[(0, 0)].symbol(), "|");
        assert!(
            !buffer[(0, 0)].modifier.contains(Modifier::BOLD),
            "the console would double-strike this"
        );
        // A glyph the console draws wide because it *is* wide stays: the
        // frame and the console agree about it, and the label means what it
        // says.
        assert_eq!(buffer[(1, 0)].symbol(), "中");
        assert!(
            !buffer[(1, 0)].modifier.contains(Modifier::BOLD),
            "synthetic bold on CJK is the smear the pass exists for"
        );
        assert_eq!(buffer[(2, 0)].symbol(), "a");
        assert_eq!(buffer[(3, 0)].symbol(), ">");
        // An ambiguous glyph the table has no shape for: the console would
        // draw it two cells wide, so it gets the one-cell `?` rather than a
        // line that walks right. `■` is ambiguous by the same table `℃` and
        // `±` are, and this interface never draws it — the device's text is
        // where it comes from.
        assert_eq!(buffer[(4, 0)].symbol(), "?");
    }

    /// The margin wears the row's own ground: it is never painted by a widget
    /// — which is the point — but left at the terminal's background it is a
    /// band of the wrong colour down the right edge of a light theme.
    #[test]
    fn the_margin_takes_the_background_of_the_cell_beside_it() {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 6, 2));
        let ground = Style::default().bg(ratatui::style::Color::Rgb(250, 250, 245));
        buffer[(3, 0)].set_style(ground).set_symbol("x");
        buffer[(3, 1)].set_style(ground).set_symbol("y");

        prepare(&mut buffer);

        for y in 0..2 {
            for x in 4..6 {
                assert_eq!(
                    buffer[(x, y)].bg,
                    ratatui::style::Color::Rgb(250, 250, 245),
                    "({x},{y}) kept the terminal's own background"
                );
            }
        }
        // The cell the background was read from is untouched, and a window
        // too narrow for a margin at all is left alone.
        assert_eq!(buffer[(3, 0)].symbol(), "x");
        assert_eq!(buffer[(3, 1)].symbol(), "y");
        let mut narrow = Buffer::empty(Rect::new(0, 0, 1, 1));
        prepare(&mut narrow);
        assert_eq!(narrow[(0, 0)].bg, ratatui::style::Color::Reset);
    }

    /// The replacement character most of all: it is what the pane paints for
    /// a byte that is not text, and a console with a CJK font draws it two
    /// cells wide — a whole row of them was the screenshot that asked for
    /// this rule.
    #[test]
    fn the_glyphs_a_device_paints_and_this_table_never_drew_are_narrowed_too() {
        // None of these is in [`STAND_INS`] — they are the device's text, not
        // this interface's — so the substitute is the generic one, which is
        // why the fallback has to exist at all.
        assert_eq!(narrow('\u{fffd}'), Some("?"), "U+FFFD, the lost byte");
        assert_eq!(narrow('\u{2103}'), Some("?"), "℃");
        assert_eq!(narrow('\u{b1}'), Some("?"), "±");
        assert_eq!(narrow('\u{25a0}'), Some("?"), "■");
    }

    /// Wide glyphs are not ambiguous: the frame and the console both count a
    /// CJK character as two cells, so the text stays as the device wrote it.
    #[test]
    fn a_wide_glyph_is_not_ambiguous() {
        assert_eq!(narrow('中'), None);
        assert_eq!(narrow('，'), None, "CJK punctuation is wide, not ambiguous");
        assert_eq!(narrow('한'), None, "Hangul is wide");
    }

    /// The invariant the pass exists for, over every character there is: no
    /// cell of a painted frame may hold a glyph the console would draw wider
    /// than the width tables the frame was laid out with.
    ///
    /// The ambiguous set is 138k code points — Unicode reserves whole planes
    /// for CJK — so the sweep runs a screenful at a time; the pass is a
    /// per-cell function, and every ambiguous glyph goes through it either
    /// way.
    #[test]
    fn no_ambiguous_glyph_survives_the_pass() {
        use unicode_width::UnicodeWidthChar;

        let ambiguous: Vec<char> = (0..=char::MAX as u32)
            .filter_map(char::from_u32)
            .filter(|ch| UnicodeWidthChar::width(*ch) != UnicodeWidthChar::width_cjk(*ch))
            .collect();
        assert!(
            ambiguous.len() > 100_000,
            "the sweep found {} glyphs, which is too few to be every ambiguous one",
            ambiguous.len()
        );

        const COLS: u16 = 200;
        const ROWS: u16 = 36;
        let mut swept = 0;
        for chunk in ambiguous.chunks(COLS as usize * ROWS as usize) {
            let mut buffer = Buffer::empty(Rect::new(0, 0, COLS, ROWS));
            for (i, ch) in chunk.iter().enumerate() {
                buffer[(i as u16 % COLS, i as u16 / COLS)].set_symbol(&ch.to_string());
            }

            prepare(&mut buffer);

            for cell in &buffer.content {
                let symbol = cell.symbol();
                let mut chars = symbol.chars();
                let Some(ch) = chars.next() else { continue };
                if chars.next().is_some() {
                    continue;
                }
                assert_eq!(
                    UnicodeWidthChar::width(ch),
                    UnicodeWidthChar::width_cjk(ch),
                    "{ch:?} (U+{:04X}) survived the pass, so the console would draw it wider than the frame did",
                    ch as u32
                );
            }
            swept += chunk.len();
        }
        assert_eq!(swept, ambiguous.len(), "every ambiguous glyph was painted");
    }

    #[test]
    fn a_composed_symbol_is_not_a_glyph_to_substitute() {
        // An emoji with its modifier, or a letter with a combining mark: one
        // cell, two chars, and not one of this interface's glyphs.
        assert_eq!(narrow_symbol("👍🏽"), None);
        assert_eq!(narrow_symbol("e\u{301}"), None);
        assert_eq!(narrow_symbol(""), None);
        assert_eq!(narrow_symbol("…"), Some("."));
    }
}
