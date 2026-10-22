//! The screen: a grid of styled cells, a cursor, a scroll region and a bounded
//! scrollback.
//!
//! This is the part of a terminal that *holds* content. It knows nothing about
//! bytes or escape sequences — [`super::parser`] turns those into calls here.
//! Splitting it that way is what lets the interesting cases be tested directly:
//! "writing past the last column wraps", "`ESC [ 2 J` clears but does not move
//! the cursor", "scrolling the top line off pushes it into the scrollback",
//! each is a few lines of setup rather than a byte string to decode.
//!
//! Two decisions shape everything else:
//!
//! - **A wide glyph owns two cells.** The second cell is a [`Cell::spacer`], a
//!   marker that painting skips. The alternative — reflowing on every write —
//!   would move text on screen every time a CJK character arrived, which a
//!   terminal must never do.
//! - **Wrapping is deferred.** Printing into the last column leaves the cursor
//!   *on* that column and sets a flag; the wrap happens when the next glyph
//!   arrives. Without this, a full-width row would scroll early and a
//!   cursor-positioning sequence after it would land on the wrong line — the
//!   bug that makes shell prompts ghost.

use std::collections::VecDeque;

use unicode_width::UnicodeWidthChar;

use super::parser::{Colour, Params};

/// How much scrolled-off history is kept, in cells. Bounded in cells rather
/// than lines so a wide pane keeps fewer lines than a narrow one for the same
/// memory, which is the honest way round.
pub const SCROLLBACK_CELLS: usize = 100_000;

/// A colour before the theme gives it a value: the terminal's own default, a
/// palette index, or a true-colour triple.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Ansi {
    /// Whatever the theme says the default is.
    #[default]
    Default,
    /// A palette slot. The 16 base colours are 0–15; the rest are the extended
    /// cube, which the theme resolves arithmetically.
    Indexed(u8),
    Rgb(u8, u8, u8),
}

impl From<Colour> for Ansi {
    fn from(colour: Colour) -> Ansi {
        match colour {
            Colour::Indexed(index) => Ansi::Indexed(index),
            Colour::Rgb(r, g, b) => Ansi::Rgb(r, g, b),
        }
    }
}

/// Everything SGR can set on a cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CellStyle {
    pub fg: Ansi,
    pub bg: Ansi,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub blink: bool,
    pub reverse: bool,
    pub hidden: bool,
    pub strike: bool,
}

impl CellStyle {
    /// Whether this is the untouched default — the test for "nothing to draw
    /// here" that lets a row of blanks be skipped whole.
    pub fn is_plain(&self) -> bool {
        *self == CellStyle::default()
    }
}

/// One cell of the grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    pub style: CellStyle,
    /// A combining mark that belongs to `ch`, so an accent is not lost.
    pub combining: Option<char>,
    /// The second half of a wide glyph: painted as nothing.
    pub spacer: bool,
}

impl Default for Cell {
    fn default() -> Cell {
        Cell {
            ch: ' ',
            style: CellStyle::default(),
            combining: None,
            spacer: false,
        }
    }
}

impl Cell {
    /// The marker for the trailing half of a wide glyph.
    pub fn spacer() -> Cell {
        Cell {
            spacer: true,
            ..Cell::default()
        }
    }

    /// A blank cell painted the way `pen` would paint — what erasing leaves
    /// behind.
    ///
    /// Erasing on a real terminal is *background colour erase*: the area takes
    /// the background the pen would paint, which is how a coloured banner
    /// survives a clear (`ESC [ 44 m` then `ESC [ 2 J` leaves a blue screen).
    /// The reverse-video flag comes along because reverse is part of what
    /// *colour* a cell is rather than a glyph attribute: `ESC [ 7 m` followed by
    /// `ESC [ K` fills the rest of the row in reverse, which is how a status line
    /// is painted without writing out its padding.
    ///
    /// Bold, underline and the rest do *not* come along. There is no glyph here
    /// to underline, and a real terminal does not leave a row of underlines
    /// behind an erase either.
    pub fn blank(pen: CellStyle) -> Cell {
        Cell {
            ch: ' ',
            style: CellStyle {
                bg: pen.bg,
                reverse: pen.reverse,
                ..CellStyle::default()
            },
            combining: None,
            spacer: false,
        }
    }

    /// Whether this cell draws nothing at all.
    pub fn is_blank(&self) -> bool {
        self.ch == ' ' && self.combining.is_none() && self.style.is_plain()
    }

    /// The glyph as it should be drawn, combining mark included.
    pub fn glyph(&self) -> String {
        match self.combining {
            Some(mark) => format!("{}{mark}", self.ch),
            None => self.ch.to_string(),
        }
    }
}

/// The cursor and pen saved by `ESC 7` / `ESC [ s`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SavedCursor {
    row: usize,
    col: usize,
    pen: CellStyle,
    origin: bool,
}

/// The grid itself.
#[derive(Debug, Clone)]
pub struct Screen {
    cols: usize,
    rows: usize,
    cells: Vec<Cell>,
    cursor_row: usize,
    cursor_col: usize,
    pen: CellStyle,
    saved: Option<SavedCursor>,
    scroll_top: usize,
    scroll_bottom: usize,
    wrap_pending: bool,
    /// `ESC [ ? 7 h` — autowrap, on by default.
    pub autowrap: bool,
    /// `ESC [ ? 6 h` — cursor addressing relative to the scroll region.
    pub origin: bool,
    /// `ESC [ ? 25 h` — whether the cursor is drawn.
    pub cursor_visible: bool,
    /// `ESC [ ? 1 h` — whether the arrow keys should send `SS3` sequences.
    pub application_cursor_keys: bool,
    /// `ESC [ ? 2004 h` — whether paste should be bracketed.
    pub bracketed_paste: bool,
    /// Whether lines scrolled off the top are kept. Off for the alternate
    /// screen, whose history belongs to the program that owns it.
    scrollback_enabled: bool,
    scrollback: VecDeque<Vec<Cell>>,
    scrollback_cells: usize,
}

impl Screen {
    /// A blank screen of the given size, ready for its first glyph.
    pub fn new(cols: usize, rows: usize) -> Screen {
        let mut screen = Screen {
            cols: cols.max(1),
            rows: rows.max(1),
            cells: Vec::new(),
            cursor_row: 0,
            cursor_col: 0,
            pen: CellStyle::default(),
            saved: None,
            scroll_top: 0,
            scroll_bottom: rows.max(1) - 1,
            wrap_pending: false,
            autowrap: true,
            origin: false,
            cursor_visible: true,
            application_cursor_keys: false,
            bracketed_paste: false,
            scrollback_enabled: true,
            scrollback: VecDeque::new(),
            scrollback_cells: 0,
        };
        screen.cells = vec![Cell::default(); screen.cols * screen.rows];
        screen
    }

    /// A screen that keeps no history — the alternate screen.
    pub fn without_scrollback(cols: usize, rows: usize) -> Screen {
        let mut screen = Screen::new(cols, rows);
        screen.scrollback_enabled = false;
        screen
    }

    pub fn cols(&self) -> usize {
        self.cols
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn cursor(&self) -> (usize, usize) {
        (self.cursor_row, self.cursor_col)
    }

    pub fn pen(&self) -> CellStyle {
        self.pen
    }

    pub fn scroll_region(&self) -> (usize, usize) {
        (self.scroll_top, self.scroll_bottom)
    }

    /// One cell, or a default when out of range — a reader should not have to
    /// bounds-check a screen it is only painting.
    pub fn cell(&self, row: usize, col: usize) -> Cell {
        if row >= self.rows || col >= self.cols {
            return Cell::default();
        }
        self.cells[row * self.cols + col]
    }

    /// A whole row's glyphs, trailing blanks trimmed — what a test asserts on
    /// and what a log dump writes.
    pub fn row_text(&self, row: usize) -> String {
        self.row_text_range(row, 0, self.cols)
    }

    fn row_text_range(&self, row: usize, from: usize, to: usize) -> String {
        if row >= self.rows {
            return String::new();
        }
        let to = to.min(self.cols);
        let mut out = String::new();
        for col in from..to {
            let cell = self.cell(row, col);
            if !cell.spacer {
                out.push_str(&cell.glyph());
            }
        }
        out.trim_end().to_string()
    }

    /// A whole row of cells, for the painter.
    pub fn row(&self, row: usize) -> &[Cell] {
        if row >= self.rows {
            return &[];
        }
        &self.cells[row * self.cols..(row + 1) * self.cols]
    }

    /// Whether nothing has been drawn — the empty pane the design's first frame
    /// shows.
    pub fn is_blank(&self) -> bool {
        self.cells.iter().all(Cell::is_blank)
    }

    // --- scrollback ---------------------------------------------------------

    pub fn scrollback_len(&self) -> usize {
        self.scrollback.len()
    }

    /// A line of scrolled-off history, oldest first.
    pub fn scrollback_row(&self, index: usize) -> Option<&[Cell]> {
        self.scrollback.get(index).map(Vec::as_slice)
    }

    fn push_scrollback(&mut self, row: Vec<Cell>) {
        if !self.scrollback_enabled {
            return;
        }
        self.scrollback_cells += row.len();
        self.scrollback.push_back(row);
        while self.scrollback_cells > SCROLLBACK_CELLS && self.scrollback.len() > 1 {
            if let Some(dropped) = self.scrollback.pop_front() {
                self.scrollback_cells -= dropped.len();
            }
        }
    }

    // --- sizing -------------------------------------------------------------

    /// Reshape the grid, keeping the text that still fits.
    ///
    /// There is deliberately no reflow: a resize re-cuts the rectangle and
    /// leaves every glyph where it was, so a line that was row 3 is still row 3.
    /// Reflowing would make a resize rewrite the screen, and a program that
    /// redraws on `SIGWINCH` would then be redrawing something it never drew.
    ///
    /// What shrinking must not do is eat the newest line. When the cursor sits
    /// below the new bottom the screen scrolls up first, the way a window being
    /// dragged shorter on a working shell does, and the rows that leave the top
    /// land in the scrollback instead of vanishing.
    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if cols == self.cols && rows == self.rows {
            return;
        }
        if rows < self.rows && self.cursor_row >= rows {
            let gone = self.cursor_row + 1 - rows;
            let old_cols = self.cols;
            if self.scrollback_enabled {
                for row in 0..gone {
                    let cells = self.cells[row * old_cols..(row + 1) * old_cols].to_vec();
                    self.push_scrollback(cells);
                }
            }
            self.cells
                .copy_within(gone * old_cols..self.rows * old_cols, 0);
            for row in self.rows - gone..self.rows {
                self.blank_row(row);
            }
            self.cursor_row -= gone;
        }
        let mut cells = vec![Cell::default(); cols * rows];
        let copy_rows = rows.min(self.rows);
        let copy_cols = cols.min(self.cols);
        for row in 0..copy_rows {
            for col in 0..copy_cols {
                cells[row * cols + col] = self.cells[row * self.cols + col];
            }
        }
        self.cells = cells;
        self.cols = cols;
        self.rows = rows;
        self.scroll_top = 0;
        self.scroll_bottom = rows - 1;
        self.cursor_row = self.cursor_row.min(rows - 1);
        self.cursor_col = self.cursor_col.min(cols - 1);
        self.wrap_pending = false;
    }

    // --- the pen ------------------------------------------------------------

    pub fn set_pen(&mut self, pen: CellStyle) {
        self.pen = pen;
    }

    pub fn reset_pen(&mut self) {
        self.pen = CellStyle::default();
    }

    /// Apply an SGR sequence (`ESC [ … m`).
    ///
    /// `ESC [ m` with no parameters is a reset, which is why the empty case is
    /// handled before the loop rather than as a missing parameter.
    pub fn sgr(&mut self, params: &Params) {
        if params.is_empty() {
            self.pen = CellStyle::default();
            return;
        }
        let mut i = 0;
        while i < params.len() {
            let code = params.at(i);
            match code {
                0 => self.pen = CellStyle::default(),
                1 => self.pen.bold = true,
                2 => self.pen.dim = true,
                3 => self.pen.italic = true,
                4 => self.pen.underline = true,
                5 | 6 => self.pen.blink = true,
                7 => self.pen.reverse = true,
                8 => self.pen.hidden = true,
                9 => self.pen.strike = true,
                // Both 21 and 22 turn the intensity attributes back off; 21 is
                // double-underline in xterm, but treating it as "not bold" is
                // the reading every other terminal has, and it is the one that
                // keeps `\e[1m…\e[21m` looking right.
                21 | 22 => {
                    self.pen.bold = false;
                    self.pen.dim = false;
                }
                23 => self.pen.italic = false,
                24 => self.pen.underline = false,
                25 => self.pen.blink = false,
                27 => self.pen.reverse = false,
                28 => self.pen.hidden = false,
                29 => self.pen.strike = false,
                30..=37 => self.pen.fg = Ansi::Indexed((code - 30) as u8),
                39 => self.pen.fg = Ansi::Default,
                40..=47 => self.pen.bg = Ansi::Indexed((code - 40) as u8),
                49 => self.pen.bg = Ansi::Default,
                90..=97 => self.pen.fg = Ansi::Indexed((code - 90 + 8) as u8),
                100..=107 => self.pen.bg = Ansi::Indexed((code - 100 + 8) as u8),
                38 | 48 => {
                    if let Some((colour, eaten)) = params.extended_colour(i) {
                        if code == 38 {
                            self.pen.fg = colour.into();
                        } else {
                            self.pen.bg = colour.into();
                        }
                        i += eaten;
                    }
                }
                // Underline colour (58/59) and anything else unknown are taken
                // and dropped: the sequence was well formed, it just says
                // nothing this screen draws.
                _ => {}
            }
            i += 1;
        }
    }

    // --- writing ------------------------------------------------------------

    /// The width a glyph claims, in columns: two for CJK and emoji, zero for a
    /// combining mark.
    fn width_of(ch: char) -> usize {
        ch.width().unwrap_or(0)
    }

    /// Put one glyph at the cursor and advance it.
    ///
    /// A control character is not a glyph and never takes a cell. The parser
    /// routes the ones it knows to [`Screen::execute`], so this is a guard for
    /// everything else — and it matters, because a control character reaching
    /// the grid would be stored as a cell: width zero sends it to
    /// [`Screen::attach_combining`], where a stray `\n` would ride around on the
    /// last glyph of a row and break the line it is painted in.
    pub fn print(&mut self, ch: char) {
        if ch.is_control() {
            return;
        }
        let width = Self::width_of(ch);
        if width == 0 {
            self.attach_combining(ch);
            return;
        }
        if self.wrap_pending {
            self.wrap_pending = false;
            // With autowrap off the cursor stays where it is and the glyph
            // overwrites the last cell: DECAWM off means the line never moves
            // by itself, and wrapping here is exactly that move.
            if self.autowrap {
                self.carriage_return();
                self.linefeed();
            }
        }
        // A wide glyph never straddles the edge: at the last column it moves to
        // the next row instead, which is what every terminal does and what keeps
        // a CJK line from leaving a one-column hole.
        if self.cursor_col + width > self.cols {
            if self.autowrap {
                self.carriage_return();
                self.linefeed();
            } else {
                self.cursor_col = self.cols.saturating_sub(width);
            }
        }
        let (row, col) = (self.cursor_row, self.cursor_col);
        self.set_cell(
            row,
            col,
            Cell {
                ch,
                style: self.pen,
                combining: None,
                spacer: false,
            },
        );
        if width == 2 && col + 1 < self.cols {
            self.set_cell(row, col + 1, Cell::spacer());
        }
        self.cursor_col += width;
        if self.cursor_col >= self.cols {
            self.cursor_col = self.cols - 1;
            self.wrap_pending = true;
        }
    }

    /// Hang a zero-width mark on the cell to the left of the cursor.
    fn attach_combining(&mut self, mark: char) {
        let (row, col) = if self.wrap_pending {
            // The cursor is parked on the last column after the glyph it shows.
            (self.cursor_row, self.cursor_col)
        } else if self.cursor_col > 0 {
            (self.cursor_row, self.cursor_col - 1)
        } else {
            return;
        };
        let index = row * self.cols + col;
        if index < self.cells.len() && !self.cells[index].spacer {
            self.cells[index].combining = Some(mark);
        }
    }

    fn set_cell(&mut self, row: usize, col: usize, cell: Cell) {
        if row < self.rows && col < self.cols {
            self.cells[row * self.cols + col] = cell;
        }
    }

    fn blank_row(&mut self, row: usize) {
        let pen = self.pen;
        let start = row * self.cols;
        for cell in &mut self.cells[start..start + self.cols] {
            *cell = Cell::blank(pen);
        }
    }

    /// A C0 control. Anything else is not a control and is ignored here.
    pub fn execute(&mut self, byte: u8) {
        match byte {
            0x08 => self.backspace(),
            0x09 => self.tab(),
            // LF, plus the two vertical-motion codes that behave like it.
            0x0a..=0x0c => self.linefeed(),
            0x0d => self.carriage_return(),
            // BEL (0x07) would ring the host's bell. Silently dropping it is the
            // honest choice: the TUI has no bell to ring, and writing to the
            // real one would leak the device's output into the interface.
            _ => {}
        }
    }

    pub fn linefeed(&mut self) {
        self.wrap_pending = false;
        if self.cursor_row == self.scroll_bottom {
            self.scroll_up(1);
        } else if self.cursor_row + 1 < self.rows {
            self.cursor_row += 1;
        }
    }

    pub fn reverse_index(&mut self) {
        self.wrap_pending = false;
        if self.cursor_row == self.scroll_top {
            self.scroll_down(1);
        } else {
            self.cursor_row = self.cursor_row.saturating_sub(1);
        }
    }

    pub fn next_line(&mut self) {
        self.carriage_return();
        self.linefeed();
    }

    pub fn carriage_return(&mut self) {
        self.cursor_col = 0;
        self.wrap_pending = false;
    }

    pub fn backspace(&mut self) {
        if self.wrap_pending {
            self.wrap_pending = false;
        } else {
            self.cursor_col = self.cursor_col.saturating_sub(1);
        }
    }

    /// Forward to the next eight-column stop, stopping at the last column.
    pub fn tab(&mut self) {
        let stop = ((self.cursor_col / 8) + 1) * 8;
        self.cursor_col = stop.min(self.cols - 1);
        self.wrap_pending = false;
    }

    // --- cursor motion ------------------------------------------------------

    /// `ESC [ row ; col H` — 1-based, and relative to the scroll region when
    /// origin mode is on.
    pub fn goto(&mut self, row: u32, col: u32) {
        let row = row.max(1) as usize - 1;
        let col = col.max(1) as usize - 1;
        self.cursor_row = if self.origin {
            (self.scroll_top + row).min(self.scroll_bottom)
        } else {
            row.min(self.rows - 1)
        };
        self.cursor_col = col.min(self.cols - 1);
        self.wrap_pending = false;
    }

    /// `ESC [ col G` — a column on the current row.
    pub fn set_column(&mut self, col: u32) {
        self.cursor_col = (col.max(1) as usize - 1).min(self.cols - 1);
        self.wrap_pending = false;
    }

    /// `ESC [ row d` — a row in the current column.
    pub fn set_row(&mut self, row: u32) {
        let row = row.max(1) as usize - 1;
        self.cursor_row = if self.origin {
            (self.scroll_top + row).min(self.scroll_bottom)
        } else {
            row.min(self.rows - 1)
        };
        self.wrap_pending = false;
    }

    fn margin_top(&self) -> usize {
        if self.cursor_row >= self.scroll_top {
            self.scroll_top
        } else {
            0
        }
    }

    fn margin_bottom(&self) -> usize {
        if self.cursor_row <= self.scroll_bottom {
            self.scroll_bottom
        } else {
            self.rows - 1
        }
    }

    pub fn cursor_up(&mut self, n: usize) {
        let stop = self.margin_top();
        self.cursor_row = self.cursor_row.saturating_sub(n).max(stop);
        self.wrap_pending = false;
    }

    pub fn cursor_down(&mut self, n: usize) {
        let stop = self.margin_bottom();
        // Saturating: `n` comes straight off the wire as a `u32`, and a 32-bit
        // build must not wrap the arithmetic into a panic on `ESC [ 4294967295 B`.
        self.cursor_row = self.cursor_row.saturating_add(n).min(stop);
        self.wrap_pending = false;
    }

    pub fn cursor_forward(&mut self, n: usize) {
        self.cursor_col = self
            .cursor_col
            .saturating_add(n)
            .min(self.cols.saturating_sub(1));
        self.wrap_pending = false;
    }

    pub fn cursor_back(&mut self, n: usize) {
        self.cursor_col = self.cursor_col.saturating_sub(n);
        self.wrap_pending = false;
    }

    /// `ESC [ n E` — down `n` rows, at the first column.
    pub fn next_lines(&mut self, n: usize) {
        self.cursor_down(n);
        self.cursor_col = 0;
    }

    /// `ESC [ n F` — up `n` rows, at the first column.
    pub fn previous_lines(&mut self, n: usize) {
        self.cursor_up(n);
        self.cursor_col = 0;
    }

    pub fn save_cursor(&mut self) {
        self.saved = Some(SavedCursor {
            row: self.cursor_row,
            col: self.cursor_col,
            pen: self.pen,
            origin: self.origin,
        });
    }

    pub fn restore_cursor(&mut self) {
        if let Some(saved) = self.saved {
            self.cursor_row = saved.row.min(self.rows - 1);
            self.cursor_col = saved.col.min(self.cols - 1);
            self.pen = saved.pen;
            self.origin = saved.origin;
        } else {
            self.cursor_row = 0;
            self.cursor_col = 0;
            self.pen = CellStyle::default();
        }
        self.wrap_pending = false;
    }

    // --- dispatch -----------------------------------------------------------

    /// Apply a CSI sequence.
    ///
    /// Only the sequences that are *entirely* about the grid live here. The few
    /// that need state this type does not own — the private modes that switch
    /// screens, and the device-status replies the host has to send back — are
    /// handled by [`super::Vt`] and never reach this.
    ///
    /// A private prefix this type does not implement is treated as if it were
    /// absent, which is the conservative reading: the sequence is still
    /// consumed, so nothing leaks as text.
    pub fn csi(&mut self, params: &Params, _private: Option<u8>, final_byte: u8) {
        match final_byte {
            b'A' => self.cursor_up(params.at_least_one(0)),
            b'B' => self.cursor_down(params.at_least_one(0)),
            b'C' => self.cursor_forward(params.at_least_one(0)),
            b'D' => self.cursor_back(params.at_least_one(0)),
            b'E' => self.next_lines(params.at_least_one(0)),
            b'F' => self.previous_lines(params.at_least_one(0)),
            // CHA and HPA both address a column; VPA addresses a row.
            b'G' | b'`' => self.set_column(params.at(0)),
            b'd' => self.set_row(params.at(0)),
            b'H' | b'f' => self.goto(params.at(0), params.at(1)),
            b'J' => self.erase_display(params.at(0)),
            b'K' => self.erase_line(params.at(0)),
            b'X' => self.erase_chars(params.at_least_one(0)),
            b'@' => self.insert_chars(params.at_least_one(0)),
            b'P' => self.delete_chars(params.at_least_one(0)),
            b'L' => self.insert_lines(params.at_least_one(0)),
            b'M' => self.delete_lines(params.at_least_one(0)),
            b'S' => self.scroll_up(params.at_least_one(0)),
            b'T' => self.scroll_down(params.at_least_one(0)),
            b'r' => self.set_scroll_region(params.get(0), params.get(1)),
            b'm' => self.sgr(params),
            b's' => self.save_cursor(),
            b'u' => self.restore_cursor(),
            // TBC (`g`), cursor style (`q`), window ops (`t`), tab stops and the
            // device attributes Vt answers are all well-formed and simply not
            // something this grid records.
            _ => {}
        }
    }

    // --- erasing ------------------------------------------------------------

    /// `ESC [ n J`. The cursor does not move; what an erased cell takes is the
    /// *pen*, which is how a program paints a full-width bar — the background
    /// and, with `ESC [ 7 m` in force, the reverse video too.
    pub fn erase_display(&mut self, mode: u32) {
        let pen = self.pen;
        let (row, col) = (self.cursor_row, self.cursor_col);
        match mode {
            0 => {
                for c in col..self.cols {
                    self.set_cell(row, c, Cell::blank(pen));
                }
                for r in (row + 1)..self.rows {
                    self.blank_row(r);
                }
            }
            1 => {
                for r in 0..row {
                    self.blank_row(r);
                }
                for c in 0..=col.min(self.cols - 1) {
                    self.set_cell(row, c, Cell::blank(pen));
                }
            }
            // 3 also drops the history: the program asking for 3 is asking for a
            // real clear, and leaving history behind would make scrolling back
            // show text the program believes it destroyed.
            2 | 3 => {
                for r in 0..self.rows {
                    self.blank_row(r);
                }
                if mode == 3 {
                    self.scrollback.clear();
                    self.scrollback_cells = 0;
                }
            }
            _ => {}
        }
    }

    /// `ESC [ n K`.
    pub fn erase_line(&mut self, mode: u32) {
        let pen = self.pen;
        let (row, col) = (self.cursor_row, self.cursor_col);
        match mode {
            0 => {
                for c in col..self.cols {
                    self.set_cell(row, c, Cell::blank(pen));
                }
            }
            1 => {
                for c in 0..=col.min(self.cols - 1) {
                    self.set_cell(row, c, Cell::blank(pen));
                }
            }
            2 => self.blank_row(row),
            _ => {}
        }
    }

    /// `ESC [ n X` — blanks `n` cells without moving anything.
    pub fn erase_chars(&mut self, n: usize) {
        let pen = self.pen;
        let (row, col) = (self.cursor_row, self.cursor_col);
        for c in col..col.saturating_add(n).min(self.cols) {
            self.set_cell(row, c, Cell::blank(pen));
        }
    }

    // --- editing ------------------------------------------------------------

    /// `ESC [ n @` — open a gap in the row, pushing cells right.
    pub fn insert_chars(&mut self, n: usize) {
        let (row, col) = (self.cursor_row, self.cursor_col);
        let n = n.min(self.cols - col);
        if n == 0 {
            return;
        }
        let pen = self.pen;
        let start = row * self.cols;
        for i in (col..self.cols - n).rev() {
            self.cells[start + i + n] = self.cells[start + i];
        }
        for i in col..col + n {
            self.cells[start + i] = Cell::blank(pen);
        }
    }

    /// `ESC [ n P` — close a gap, pulling cells left.
    pub fn delete_chars(&mut self, n: usize) {
        let (row, col) = (self.cursor_row, self.cursor_col);
        let n = n.min(self.cols - col);
        if n == 0 {
            return;
        }
        let pen = self.pen;
        let start = row * self.cols;
        for i in col..self.cols - n {
            self.cells[start + i] = self.cells[start + i + n];
        }
        for i in self.cols - n..self.cols {
            self.cells[start + i] = Cell::blank(pen);
        }
    }

    /// `ESC [ n L` — blank lines open below the cursor, inside the region.
    pub fn insert_lines(&mut self, n: usize) {
        let row = self.cursor_row;
        if row < self.scroll_top || row > self.scroll_bottom {
            return;
        }
        let bottom = self.scroll_bottom;
        let n = n.min(bottom - row + 1);
        if n == 0 {
            return;
        }
        let cols = self.cols;
        self.cells
            .copy_within(row * cols..(bottom + 1 - n) * cols, (row + n) * cols);
        for r in row..row + n {
            self.blank_row(r);
        }
        self.carriage_return();
    }

    /// `ESC [ n M` — remove lines from the cursor down, inside the region.
    pub fn delete_lines(&mut self, n: usize) {
        let row = self.cursor_row;
        if row < self.scroll_top || row > self.scroll_bottom {
            return;
        }
        let bottom = self.scroll_bottom;
        let n = n.min(bottom - row + 1);
        if n == 0 {
            return;
        }
        let cols = self.cols;
        self.cells
            .copy_within((row + n) * cols..(bottom + 1) * cols, row * cols);
        for r in bottom + 1 - n..=bottom {
            self.blank_row(r);
        }
        self.carriage_return();
    }

    // --- scrolling ----------------------------------------------------------

    /// `ESC [ n S` — scroll the region up, so content moves towards the top.
    pub fn scroll_up(&mut self, n: usize) {
        let (top, bottom) = (self.scroll_top, self.scroll_bottom);
        if top > bottom || bottom >= self.rows {
            return;
        }
        let n = n.min(bottom - top + 1);
        if n == 0 {
            return;
        }
        let cols = self.cols;
        if self.scrollback_enabled && top == 0 {
            for r in 0..n {
                let row = self.cells[r * cols..(r + 1) * cols].to_vec();
                self.push_scrollback(row);
            }
        }
        self.cells
            .copy_within((top + n) * cols..(bottom + 1) * cols, top * cols);
        for r in bottom + 1 - n..=bottom {
            self.blank_row(r);
        }
    }

    /// `ESC [ n T` — scroll the region down, so content moves towards the bottom.
    pub fn scroll_down(&mut self, n: usize) {
        let (top, bottom) = (self.scroll_top, self.scroll_bottom);
        if top > bottom || bottom >= self.rows {
            return;
        }
        let n = n.min(bottom - top + 1);
        if n == 0 {
            return;
        }
        let cols = self.cols;
        self.cells
            .copy_within(top * cols..(bottom + 1 - n) * cols, (top + n) * cols);
        for r in top..top + n {
            self.blank_row(r);
        }
    }

    /// `ESC [ top ; bottom r` — set the scroll region. Rows are 1-based, and
    /// the default is the whole screen.
    pub fn set_scroll_region(&mut self, top: Option<u32>, bottom: Option<u32>) {
        let top = top.map_or(1, |v| v.max(1)) as usize - 1;
        let bottom = bottom
            .map_or(self.rows, |v| v as usize)
            .min(self.rows)
            .saturating_sub(1);
        if top >= bottom {
            // A region that is not at least two rows tall is refused outright;
            // accepting it would leave every later scroll with nothing to move.
            self.scroll_top = 0;
            self.scroll_bottom = self.rows - 1;
        } else {
            self.scroll_top = top;
            self.scroll_bottom = bottom;
        }
        // Setting the region homes the cursor, per the VT spec — programs rely
        // on it (a pager sets the region then draws from the top).
        self.goto(1, 1);
    }

    /// `RIS` — everything back to power-on defaults.
    pub fn reset(&mut self) {
        let (cols, rows) = (self.cols, self.rows);
        *self = Screen::new(cols, rows);
    }

    /// The whole retained text: history, then the screen, trailing blanks
    /// trimmed. What "save the log" writes.
    pub fn dump(&self) -> String {
        let mut out = String::new();
        for row in self.scrollback.iter() {
            let mut line = String::new();
            for cell in row {
                if !cell.spacer {
                    line.push_str(&cell.glyph());
                }
            }
            out.push_str(line.trim_end());
            out.push('\n');
        }
        for row in 0..self.rows {
            out.push_str(&self.row_text(row));
            out.push('\n');
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vt::parser::{Handler, Parser};

    /// Feed text to an existing screen through the parser, the way the device's
    /// bytes arrive: a control character is a command, not a glyph.
    fn feed(screen: &mut Screen, text: &str) {
        struct Feed<'a>(&'a mut Screen);
        impl Handler for Feed<'_> {
            fn print(&mut self, ch: char) {
                self.0.print(ch);
            }
            fn execute(&mut self, byte: u8) {
                self.0.execute(byte);
            }
            fn esc(&mut self, _: u8, _: &[u8]) {}
            fn csi(&mut self, params: &Params, private: Option<u8>, _: &[u8], final_byte: u8) {
                self.0.csi(params, private, final_byte);
            }
            fn osc(&mut self, _: &[u8]) {}
        }
        Parser::new().feed_str(text, &mut Feed(screen));
    }

    /// Type text into a fresh screen.
    fn typed(cols: usize, rows: usize, text: &str) -> Screen {
        let mut screen = Screen::new(cols, rows);
        feed(&mut screen, text);
        screen
    }

    /// Writing past the last column wraps to the next row; the cursor does not
    /// scroll spuriously while it sits on the last column.
    #[test]
    fn text_wraps_at_the_edge() {
        let mut screen = Screen::new(4, 3);
        for ch in "abcdef".chars() {
            screen.print(ch);
        }
        assert_eq!(screen.row_text(0), "abcd");
        assert_eq!(screen.row_text(1), "ef");
        assert_eq!(screen.cursor(), (1, 2));
    }

    /// With autowrap off the line never moves by itself: the glyph that would
    /// have started the next row overwrites the last cell instead.
    #[test]
    fn autowrap_off_overwrites_the_last_cell() {
        let mut screen = Screen::new(4, 3);
        feed(&mut screen, "abcd");
        screen.autowrap = false;
        screen.print('X');
        assert_eq!(screen.row_text(0), "abcX", "the last cell took the glyph");
        assert_eq!(screen.row_text(1), "", "and no row was started");
        assert_eq!(screen.cursor().0, 0, "the cursor did not move down");
    }

    /// A parameter arrives as a `u32` off the wire. The arithmetic must
    /// saturate rather than wrap: a debug build panicking on
    /// `ESC [ 4294967295 B` is a hostile device crashing the interface.
    #[test]
    fn an_enormous_parameter_saturates() {
        let mut screen = Screen::new(4, 3);
        screen.cursor_forward(usize::MAX);
        screen.cursor_down(usize::MAX);
        screen.erase_chars(usize::MAX);
        assert_eq!(screen.cursor_col, 3, "forward stops at the last column");
        assert_eq!(screen.cursor_row, 2, "down stops at the last row");
    }

    /// A wide glyph takes two cells and never straddles the edge: at the last
    /// column it moves to the next row instead of leaving half a glyph.
    #[test]
    fn a_wide_glyph_never_straddles_the_edge() {
        let mut screen = Screen::new(4, 3);
        for ch in "中文中".chars() {
            screen.print(ch);
        }
        assert_eq!(screen.row_text(0), "中文");
        assert_eq!(screen.row_text(1), "中");
        // The second cell of `中` is a spacer, so the row is two glyphs wide.
        assert!(screen.cell(0, 1).spacer);
        assert_eq!(screen.cell(0, 0).glyph(), "中");
    }

    /// A combining mark joins the cell to its left instead of taking a column.
    #[test]
    fn a_combining_mark_joins_the_previous_cell() {
        let mut screen = Screen::new(8, 2);
        for ch in "e\u{0301}x".chars() {
            screen.print(ch);
        }
        assert_eq!(screen.row_text(0), "e\u{0301}x");
        assert_eq!(screen.cell(0, 0).combining, Some('\u{0301}'));
    }

    /// A newline at the bottom scrolls, and the line that leaves the top goes
    /// into the scrollback rather than being lost.
    #[test]
    fn a_line_scrolled_off_goes_to_the_scrollback() {
        let mut screen = Screen::new(8, 2);
        feed(&mut screen, "one\r\ntwo");
        assert_eq!(screen.scrollback_len(), 0, "nothing has scrolled yet");
        assert_eq!(screen.row_text(0), "one");
        assert_eq!(screen.row_text(1), "two");

        // A third line on a two-row screen: the oldest is pushed into the
        // history and the rest move up.
        feed(&mut screen, "\r\nthree");
        assert_eq!(screen.scrollback_len(), 1);
        let history: String = screen
            .scrollback_row(0)
            .unwrap_or(&[])
            .iter()
            .filter(|cell| !cell.spacer)
            .map(Cell::glyph)
            .collect::<String>()
            .trim_end()
            .to_string();
        assert_eq!(history, "one");
        assert_eq!(screen.row_text(0), "two");
        assert_eq!(screen.row_text(1), "three");
    }

    /// The scrollback is bounded in cells, not lines, so a long session cannot
    /// grow the process.
    #[test]
    fn the_scrollback_is_bounded() {
        let mut screen = Screen::new(80, 2);
        for _ in 0..(SCROLLBACK_CELLS / 80 * 3) {
            screen.linefeed();
        }
        let cells = screen.scrollback_len() * 80;
        assert!(cells <= SCROLLBACK_CELLS, "{cells} cells kept");
        assert!(screen.scrollback_len() > 100, "history is still kept");
    }

    /// The alternate screen keeps no history, so a full-screen program's
    /// scrolling does not fill the user's scrollback with its repaints.
    #[test]
    fn the_alternate_screen_keeps_no_history() {
        let mut screen = Screen::without_scrollback(8, 2);
        for _ in 0..10 {
            screen.linefeed();
        }
        assert_eq!(screen.scrollback_len(), 0);
    }

    /// Scrolling is confined to the region: rows outside it do not move, which
    /// is what makes a pager's status line stay put.
    #[test]
    fn scrolling_respects_the_region() {
        let mut screen = Screen::new(8, 5);
        feed(&mut screen, "keep\r\n");
        for (r, text) in [(1, "a"), (2, "b"), (3, "c")] {
            screen.goto(r + 1, 1);
            for ch in text.chars() {
                screen.print(ch);
            }
        }
        screen.goto(4, 1);
        // Region is rows 1..=3 and the bottom line loses its top.
        screen.set_scroll_region(Some(2), Some(4));
        screen.goto(4, 1);
        screen.linefeed();
        assert_eq!(screen.row_text(0), "keep");
        assert_eq!(screen.row_text(1), "b");
        assert_eq!(screen.row_text(2), "c");
        assert_eq!(screen.row_text(3), "");
    }

    /// Erasing to the end leaves the text before the cursor alone and does not
    /// move the cursor.
    #[test]
    fn erase_to_end_keeps_what_came_before() {
        let mut screen = Screen::new(8, 2);
        for ch in "abcdef".chars() {
            screen.print(ch);
        }
        screen.goto(1, 3);
        screen.erase_line(0);
        assert_eq!(screen.row_text(0), "ab");
        assert_eq!(screen.cursor(), (0, 2));
        screen.erase_display(0);
        // Erasing from the cursor only clears from the cursor, so the text
        // before it is still there and the cursor has not moved.
        assert_eq!(screen.row_text(0), "ab");
        assert_eq!(screen.cursor(), (0, 2));
        screen.erase_display(2);
        assert!(screen.is_blank(), "{:?}", screen.row_text(0));
    }

    /// An erased cell takes the pen's background, so a banner keeps its bar.
    #[test]
    fn an_erased_cell_takes_the_pen_background() {
        let mut screen = Screen::new(4, 1);
        screen.set_pen(CellStyle {
            bg: Ansi::Indexed(4),
            ..CellStyle::default()
        });
        screen.erase_line(2);
        assert_eq!(screen.cell(0, 0).style.bg, Ansi::Indexed(4));
        assert_eq!(screen.cell(0, 0).ch, ' ');
    }

    /// An erased cell takes the pen's reverse video as well as its background,
    /// so `ESC [ 7 m` then `ESC [ K` fills the rest of the row — which is how a
    /// status line is painted to the width of the screen without the program
    /// writing out its padding.
    ///
    /// The glyph attributes do not come along: there is nothing here to
    /// underline, and a real terminal does not leave a row of underlines behind
    /// an erase either.
    #[test]
    fn an_erased_cell_takes_the_pen_reverse_but_not_its_glyph_attributes() {
        let mut screen = Screen::new(10, 1);
        screen.set_pen(CellStyle {
            bg: Ansi::Indexed(4),
            reverse: true,
            ..CellStyle::default()
        });
        screen.erase_line(0);
        let erased = screen.cell(0, 9).style;
        assert_eq!(erased.bg, Ansi::Indexed(4), "the background filled");
        assert!(erased.reverse, "and it filled in reverse");

        let mut screen = Screen::new(10, 1);
        screen.set_pen(CellStyle {
            bold: true,
            underline: true,
            ..CellStyle::default()
        });
        screen.erase_line(0);
        let erased = screen.cell(0, 9).style;
        assert!(!erased.bold && !erased.underline, "{erased:?}");
        assert_eq!(erased, CellStyle::default(), "an erased cell is plain");
    }

    /// Inserting and deleting characters shift the row without disturbing the
    /// rows around it.
    #[test]
    fn insert_and_delete_characters_shift_one_row() {
        let mut screen = Screen::new(6, 2);
        for ch in "abcdef".chars() {
            screen.print(ch);
        }
        screen.goto(1, 2);
        screen.insert_chars(2);
        assert_eq!(screen.row_text(0), "a  bcd");
        screen.delete_chars(2);
        assert_eq!(screen.row_text(0), "abcd");
        screen.delete_chars(2);
        // `b` and `c` go, and `d` slides up to take their place.
        assert_eq!(screen.row_text(0), "ad");
    }

    /// Inserting a line opens a blank one and pushes the rest down, inside the
    /// region only.
    #[test]
    fn insert_lines_pushes_down_inside_the_region() {
        let mut screen = Screen::new(8, 4);
        for (r, text) in [(1, "one"), (2, "two"), (3, "three"), (4, "four")] {
            screen.goto(r, 1);
            for ch in text.chars() {
                screen.print(ch);
            }
        }
        screen.goto(2, 1);
        screen.insert_lines(1);
        assert_eq!(screen.row_text(0), "one");
        assert_eq!(screen.row_text(1), "");
        assert_eq!(screen.row_text(2), "two");
        assert_eq!(screen.row_text(3), "three");
        assert_eq!(screen.cursor(), (1, 0));
    }

    /// A save/restore round-trips the cursor and the pen, so a program can
    /// borrow the cursor and give it back.
    #[test]
    fn save_and_restore_round_trip() {
        let mut screen = Screen::new(10, 4);
        screen.goto(3, 5);
        screen.set_pen(CellStyle {
            fg: Ansi::Indexed(2),
            ..CellStyle::default()
        });
        screen.save_cursor();
        screen.goto(1, 1);
        screen.reset_pen();
        screen.restore_cursor();
        assert_eq!(screen.cursor(), (2, 4));
        assert_eq!(screen.pen().fg, Ansi::Indexed(2));
    }

    /// SGR reads a colour selector as one value, so the palette index does not
    /// also land in the pen as a separate attribute.
    #[test]
    fn sgr_reads_extended_colour_as_one_value() {
        let screen = typed(8, 2, "\x1b[38;5;196mX");
        assert_eq!(screen.cell(0, 0).style.fg, Ansi::Indexed(196));
        let screen = typed(8, 2, "\x1b[48;2;1;2;3mX");
        assert_eq!(screen.cell(0, 0).style.bg, Ansi::Rgb(1, 2, 3));
    }

    /// A bare `ESC [ m` is a reset, and `ESC [ 0 m` is the same reset.
    #[test]
    fn a_bare_sgr_is_a_reset() {
        let screen = typed(8, 2, "\x1b[1;31mA\x1b[mB");
        assert!(
            screen.cell(0, 1).style.is_plain(),
            "{:?}",
            screen.cell(0, 1)
        );
        let screen = typed(8, 2, "\x1b[1;31mA\x1b[0mB");
        assert!(screen.cell(0, 1).style.is_plain());
    }

    /// Cursor motion stops at the scroll region's edges, which is what keeps a
    /// program from walking its status line off the screen.
    #[test]
    fn cursor_motion_stops_at_the_margins() {
        let mut screen = Screen::new(10, 6);
        screen.set_scroll_region(Some(2), Some(5));
        screen.goto(3, 1);
        screen.cursor_up(9);
        assert_eq!(screen.cursor().0, 1, "stopped at the top margin");
        screen.cursor_down(9);
        assert_eq!(screen.cursor().0, 4, "stopped at the bottom margin");
        // Above the region, motion is not bounded by it.
        screen.goto(1, 1);
        screen.cursor_up(9);
        assert_eq!(screen.cursor().0, 0);
    }

    /// A resize keeps the text where it was rather than reflowing it.
    #[test]
    fn a_resize_keeps_the_text_in_place() {
        let mut screen = Screen::new(10, 4);
        for ch in "hello".chars() {
            screen.print(ch);
        }
        screen.resize(20, 8);
        assert_eq!(screen.row_text(0), "hello");
        screen.resize(3, 2);
        assert_eq!(screen.row_text(0), "hel");
        assert_eq!(screen.cursor().0, 0);
    }

    /// A shorter screen scrolls rather than bytes the newest line off the
    /// bottom: the last line a device printed is still on screen, and what no
    /// longer fits is history.
    #[test]
    fn a_shorter_screen_keeps_the_newest_line() {
        let mut screen = Screen::new(10, 4);
        for n in 0..6 {
            for ch in format!("line{n}").chars() {
                screen.print(ch);
            }
            if n < 5 {
                screen.next_line();
            }
        }
        assert_eq!(screen.row_text(3), "line5");
        let history = screen.scrollback_len();
        screen.resize(10, 2);
        assert_eq!(screen.row_text(0), "line4");
        assert_eq!(screen.row_text(1), "line5", "the newest line stays visible");
        assert_eq!(
            screen.scrollback_len(),
            history + 2,
            "the rows that no longer fit are kept as history"
        );
        assert_eq!(screen.cursor().0, 1, "the cursor rides down with the text");
    }

    /// Origin mode makes cursor addressing relative to the region, which is how
    /// a pager draws its page without knowing where the region starts.
    #[test]
    fn origin_mode_addresses_relative_to_the_region() {
        let mut screen = Screen::new(10, 6);
        screen.set_scroll_region(Some(3), Some(5));
        screen.origin = true;
        screen.goto(1, 1);
        assert_eq!(screen.cursor(), (2, 0));
        screen.goto(99, 1);
        assert_eq!(screen.cursor().0, 4, "clamped to the region");
    }

    /// `reset` returns the screen to defaults, so a device that sends `RIS`
    /// gets a clean one.
    #[test]
    fn reset_clears_everything() {
        let mut screen = typed(8, 3, "abc\x1b[31mdef");
        screen.set_scroll_region(Some(2), Some(3));
        screen.reset();
        assert!(screen.is_blank());
        assert_eq!(screen.cursor(), (0, 0));
        assert_eq!(screen.scroll_region(), (0, 2));
        assert!(screen.pen().is_plain());
    }

    /// The log dump is the history then the screen, and it is text — no
    /// escape sequences, no trailing padding.
    #[test]
    fn the_dump_is_plain_text() {
        let screen = typed(8, 3, "one\r\ntwo\x1b[31m!\x1b[0m");
        let dump = screen.dump();
        assert!(dump.starts_with("one\ntwo!"), "{dump:?}");
        assert!(!dump.contains('\u{1b}'), "{dump:?}");
    }
}
