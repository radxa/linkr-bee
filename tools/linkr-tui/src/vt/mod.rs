//! VT emulation: the serial pane as a terminal rather than a text buffer.
//!
//! A device's output is not a document to lay out — it is a screen being
//! painted. `ESC [ 2 J` means "erase", `ESC [ 31 m` means "the next glyph is
//! red", and a spinner repaints one cell in place. Showing those bytes as text
//! would print the escape sequences; showing them as lines would leave the
//! spinner's 400 frames stacked up the screen. So the pane emulates.
//!
//! The work splits three ways, and the split is the design:
//!
//! - [`parser`] recognises escape sequences and hands out semantic events.
//! - [`screen`] holds the grid: cells, cursor, scroll region, scrollback.
//! - this module ([`Vt`]) is the state machine that joins them, owns the
//!   alternate screen, and answers the handful of sequences that require
//!   talking *back* to the device (`ESC [ 6 n`, device attributes).
//!
//! Scope is honest rather than complete. What a shell, `less`, `top`, `vim` and
//! a coloured build log need is here: cursor addressing, erase, insert/delete,
//! scroll regions, the alternate screen, SGR (16 colours, 256, true colour),
//! wide glyphs, the window title and bracketed paste. Not here: mouse
//! reporting, sixel/kitty graphics, and DCS-driven sequences — each of them is
//! *consumed* rather than guessed at, so an unimplemented feature degrades to
//! "nothing happens" instead of corrupting the screen.

pub mod parser;
pub mod screen;

pub use parser::{Colour, Handler, Params, Parser};
pub use screen::{Ansi, Cell, CellStyle, Screen, SCROLLBACK_CELLS};

/// The reply to a primary device-attributes request: "I am a VT102". Claiming
/// something larger would invite the device to send sequences this emulator
/// does not implement.
const DEVICE_ATTRIBUTES: &[u8] = b"\x1b[?6c";

/// The reply to a secondary device-attributes request, in xterm's shape.
const DEVICE_ATTRIBUTES_SECONDARY: &[u8] = b"\x1b[>0;276;0c";

/// The size a fresh emulator assumes before the pane tells it better.
pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;

/// The terminal: a screen, an alternate screen, and the state that is neither.
#[derive(Debug, Clone)]
pub struct Vt {
    screen: Screen,
    /// The main screen, parked while a full-screen program owns the display.
    alt: Option<Screen>,
    title: String,
    /// Replies owed to the device, kept until something sends them.
    replies: Vec<Vec<u8>>,
    /// Non-zero when the device asked for mouse reporting. Remembered so the
    /// state is not silently lost; nothing is reported yet, and pretending
    /// otherwise would have the device wait for events that never come.
    mouse_mode: u16,
}

impl Default for Vt {
    fn default() -> Vt {
        Vt::new(DEFAULT_COLS, DEFAULT_ROWS)
    }
}

impl Vt {
    /// A blank emulator.
    pub fn new(cols: u16, rows: u16) -> Vt {
        Vt {
            screen: Screen::new(cols as usize, rows as usize),
            alt: None,
            title: String::new(),
            replies: Vec::new(),
            mouse_mode: 0,
        }
    }

    /// Reshape both screens. Called from the event loop, never from a paint:
    /// a frame is a pure function of state, so it may not resize what it draws.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.screen.resize(cols as usize, rows as usize);
        if let Some(alt) = self.alt.as_mut() {
            alt.resize(cols as usize, rows as usize);
        }
    }

    /// Feed decoded text. Convenient for a one-shot string — a sample frame —
    /// but a caller reading a live wire wants a [`Parser`] of its own, so that
    /// a sequence split across two reads is still one sequence.
    pub fn feed(&mut self, text: &str) {
        let mut parser = Parser::new();
        parser.feed_str(text, self);
    }

    pub fn screen(&self) -> &Screen {
        &self.screen
    }

    /// Whether a full-screen program has the display.
    pub fn on_alt_screen(&self) -> bool {
        self.alt.is_some()
    }

    /// The window title the device set, empty when it has not set one.
    pub fn title(&self) -> &str {
        &self.title
    }

    /// `ESC [ ? 1 h` — whether the program on the screen asked for the `SS3`
    /// arrow keys.
    ///
    /// The one screen mode the *input* side reads: whoever spells a keystroke
    /// for the device asks this first, because a program that turned it on
    /// (`vim`, `less`) reads `ESC [ A` as three literal characters.
    pub fn application_cursor_keys(&self) -> bool {
        self.screen.application_cursor_keys
    }

    /// The cursor's line counted from the oldest retained line, so it can be
    /// compared with [`Vt::line`] indices.
    pub fn cursor_line(&self) -> usize {
        self.screen.scrollback_len() + self.screen.cursor().0
    }

    /// How many lines there are to show: the history, then the screen.
    pub fn line_count(&self) -> usize {
        self.screen.scrollback_len() + self.screen.rows()
    }

    /// One line by absolute index, oldest first. `None` past either end.
    pub fn line(&self, index: usize) -> Option<&[screen::Cell]> {
        let history = self.screen.scrollback_len();
        if index < history {
            self.screen.scrollback_row(index)
        } else {
            let row = index - history;
            if row < self.screen.rows() {
                Some(self.screen.row(row))
            } else {
                None
            }
        }
    }

    /// Take the replies owed to the device. Whatever sends them is responsible
    /// for getting them onto the wire.
    pub fn take_replies(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.replies)
    }

    pub fn is_blank(&self) -> bool {
        self.screen.is_blank() && self.title.is_empty()
    }

    /// The whole retained text, for `save the log`.
    pub fn dump(&self) -> String {
        self.screen.dump()
    }

    /// `RIS` — everything back to power-on, including the title.
    pub fn reset(&mut self) {
        let (cols, rows) = (self.screen.cols() as u16, self.screen.rows() as u16);
        self.screen = Screen::new(cols as usize, rows as usize);
        self.alt = None;
        self.title.clear();
        self.mouse_mode = 0;
    }

    fn switch_screen(&mut self, to_alt: bool, with_cursor: bool) {
        let (cols, rows) = (self.screen.cols(), self.screen.rows());
        if to_alt {
            if self.alt.is_some() {
                return;
            }
            if with_cursor {
                self.screen.save_cursor();
            }
            let fresh = Screen::without_scrollback(cols, rows);
            let parked = std::mem::replace(&mut self.screen, fresh);
            self.alt = Some(parked);
        } else if let Some(mut parked) = self.alt.take() {
            // The program may have resized the window while it had the display,
            // so the main screen is brought back to the current size.
            parked.resize(cols, rows);
            self.screen = parked;
            if with_cursor {
                self.screen.restore_cursor();
            }
        }
    }

    fn private_modes(&mut self, params: &Params, on: bool) {
        for i in 0..params.len() {
            match params.at(i) {
                1 => self.screen.application_cursor_keys = on,
                6 => self.screen.origin = on,
                7 => self.screen.autowrap = on,
                25 => self.screen.cursor_visible = on,
                // The three spellings of "give me a private screen". They differ
                // in what they do on the way out; 1049 is the one that also
                // saves and restores the cursor, which is what `vim` and `less`
                // use and the only difference a user ever notices.
                47 => self.switch_screen(on, false),
                1047 => self.switch_screen(on, false),
                1049 => self.switch_screen(on, true),
                48 => {
                    if on {
                        self.screen.save_cursor();
                    } else {
                        self.screen.restore_cursor();
                    }
                }
                1000 | 1002 | 1003 | 1005 | 1006 | 1015 => {
                    self.mouse_mode = if on { params.at(i) as u16 } else { 0 };
                }
                2004 => self.screen.bracketed_paste = on,
                _ => {}
            }
        }
    }

    fn device_status(&mut self, params: &Params) {
        match params.at(0) {
            // "Are you there?" — the reply every terminal gives.
            5 => self.replies.push(b"\x1b[0n".to_vec()),
            6 => {
                let (row, col) = self.screen.cursor();
                let (row, col) = if self.screen.origin {
                    let (top, _) = self.screen.scroll_region();
                    (row.saturating_sub(top), col)
                } else {
                    (row, col)
                };
                self.replies
                    .push(format!("\x1b[{};{}R", row + 1, col + 1).into_bytes());
            }
            _ => {}
        }
    }

    /// The window-manipulation codes, of which only the *question* is answered.
    ///
    /// `CSI 18 t` asks how big the text area is, and a full-screen program asks
    /// it — `less` sizes its pager to the answer. The reply is xterm's:
    /// `CSI 8 ; rows ; cols t`. The rest of the family moves, resizes, raises
    /// and lowers the *host's* window, which is not a thing this pane has; they
    /// are recognised and ignored rather than mistaken for text.
    fn window_manipulation(&mut self, params: &Params) {
        if params.at(0) == 18 {
            let (rows, cols) = (self.screen.rows(), self.screen.cols());
            self.replies
                .push(format!("\x1b[8;{rows};{cols}t").into_bytes());
        }
    }
}

impl Handler for Vt {
    fn print(&mut self, ch: char) {
        self.screen.print(ch);
    }

    fn execute(&mut self, byte: u8) {
        self.screen.execute(byte);
    }

    fn esc(&mut self, final_byte: u8, _intermediates: &[u8]) {
        match final_byte {
            b'7' => self.screen.save_cursor(),
            b'8' => self.screen.restore_cursor(),
            b'D' => self.screen.linefeed(),
            b'E' => self.screen.next_line(),
            b'M' => self.screen.reverse_index(),
            b'c' => self.reset(),
            // `=`, `>` (keypad modes), `H` (tab stop) and the charset
            // designators are recognised and deliberately ignored: the pane
            // decodes UTF-8, so a shifted charset would be a lie, and the tab
            // stops are the fixed eight-column ones.
            _ => {}
        }
    }

    fn csi(&mut self, params: &Params, private: Option<u8>, _intermediates: &[u8], final_byte: u8) {
        match (private, final_byte) {
            (Some(b'?'), b'h') => self.private_modes(params, true),
            (Some(b'?'), b'l') => self.private_modes(params, false),
            (Some(b'>'), b'c') => self.replies.push(DEVICE_ATTRIBUTES_SECONDARY.to_vec()),
            (None, b'c') => self.replies.push(DEVICE_ATTRIBUTES.to_vec()),
            (None, b'n') => self.device_status(params),
            (None, b't') => self.window_manipulation(params),
            _ => self.screen.csi(params, private, final_byte),
        }
    }

    fn osc(&mut self, data: &[u8]) {
        // A malformed OSC is dropped: it cannot be text (the bytes are an
        // argument), and guessing at a broken UTF-8 title helps nobody.
        let Ok(text) = std::str::from_utf8(data) else {
            return;
        };
        let (code, argument) = match text.split_once(';') {
            Some((code, rest)) => (code, rest),
            None => (text, ""),
        };
        match code {
            // 0 and 2 are the window title; 1 is the icon name, which this pane
            // has nowhere separate to put, so it lands in the title too.
            "0" | "1" | "2" => self.title = argument.to_string(),
            // Hyperlinks (8), palette changes (4, 10–19), the clipboard (52) and
            // shell-integration marks (133, 633) are accepted and dropped.
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vt(text: &str) -> Vt {
        let mut vt = Vt::new(20, 6);
        vt.feed(text);
        vt
    }

    fn row(vt: &Vt, index: usize) -> String {
        let mut out = String::new();
        if let Some(line) = vt.line(index) {
            for cell in line {
                if !cell.spacer {
                    out.push_str(&cell.glyph());
                }
            }
        }
        out.trim_end().to_string()
    }

    /// Text lands on the screen and the screen counts its lines.
    #[test]
    fn text_lands_on_the_screen() {
        let vt = vt("hello");
        assert_eq!(row(&vt, 0), "hello");
        assert_eq!(vt.line_count(), 6, "six screen rows, no history yet");
        assert!(!vt.is_blank());
    }

    /// A cursor-positioning sequence moves where the next glyph goes rather
    /// than appearing as text — the difference between a terminal and a log.
    #[test]
    fn cursor_addressing_places_text() {
        let vt = vt("\x1b[3;5Hhere");
        assert_eq!(row(&vt, 2), "    here");
        assert!(
            !row(&vt, 0).contains("3;5"),
            "the parameters were printed: {:?}",
            row(&vt, 0)
        );
    }

    /// The alternate screen is a second display: the main screen is parked
    /// untouched and comes back exactly as it was.
    #[test]
    fn the_alternate_screen_parks_the_main_one() {
        let mut vt = vt("main text\r\n");
        assert_eq!(row(&vt, 0), "main text");
        vt.feed("\x1b[?1049h");
        assert!(vt.on_alt_screen());
        assert_eq!(row(&vt, 0), "", "the alternate screen starts blank");
        vt.feed("full screen program");
        assert_eq!(row(&vt, 0), "full screen program");
        vt.feed("\x1b[?1049l");
        assert!(!vt.on_alt_screen());
        assert_eq!(row(&vt, 0), "main text", "the main screen came back");
    }

    /// A resize while a program owns the alternate screen is carried back to
    /// the main screen when the program exits, so a window dragged while in
    /// `vim` does not leave a stale-sized shell behind.
    #[test]
    fn a_resize_survives_the_alternate_screen() {
        let mut vt = vt("main");
        vt.feed("\x1b[?1049h");
        vt.resize(40, 12);
        vt.feed("\x1b[?1049l");
        assert_eq!(vt.screen().cols(), 40);
        assert_eq!(vt.screen().rows(), 12);
        assert_eq!(row(&vt, 0), "main");
    }

    /// The private modes reach the screen: hiding the cursor, and origin mode
    /// making addressing relative to the scroll region.
    #[test]
    fn private_modes_reach_the_screen() {
        let mut vt = vt("\x1b[?25l");
        assert!(!vt.screen().cursor_visible);
        vt.feed("\x1b[?25h");
        assert!(vt.screen().cursor_visible);

        vt.feed("\x1b[2;5r\x1b[?6h\x1b[1;1H");
        assert!(vt.screen().origin);
        assert_eq!(vt.screen().cursor(), (1, 0), "row 1 of the region is row 2");
    }

    /// `ESC [ 6 n` is answered with the cursor's position, because a program
    /// that asks and gets nothing back will hang.
    #[test]
    fn a_cursor_position_report_is_answered() {
        let mut vt = vt("\x1b[4;7H\x1b[6n");
        assert_eq!(vt.take_replies(), vec![b"\x1b[4;7R".to_vec()]);
        assert!(vt.take_replies().is_empty(), "the reply is taken once");
    }

    /// `CSI 18 t` — "how big is the text area?" — is answered in xterm's shape,
    /// because a full-screen program sizes itself to the answer. The rest of the
    /// family (`CSI 2 t` to iconify the host's window, `CSI 8 ; rows ; cols t` to
    /// resize it) is recognised and ignored: this pane has no window to move, and
    /// printing the sequence as text would be a lie in the other direction.
    #[test]
    fn a_text_area_size_report_is_answered() {
        let mut vt = vt("\x1b[18t");
        assert_eq!(vt.take_replies(), vec![b"\x1b[8;6;20t".to_vec()]);
        vt.resize(100, 30);
        vt.feed("\x1b[18t");
        assert_eq!(vt.take_replies(), vec![b"\x1b[8;30;100t".to_vec()]);
        vt.feed("\x1b[1;2t\x1b[8;10;20t");
        assert!(vt.take_replies().is_empty(), "the setters are ignored");
        assert!(vt.is_blank(), "and none of them printed");
    }

    /// "Are you there?" gets the standard acknowledgement, and a device
    /// attributes request gets a VT102 answer — small enough to be true.
    #[test]
    fn the_status_and_attribute_reports_are_answered() {
        let mut vt = vt("\x1b[5n\x1b[c\x1b[>c");
        assert_eq!(
            vt.take_replies(),
            vec![
                b"\x1b[0n".to_vec(),
                DEVICE_ATTRIBUTES.to_vec(),
                DEVICE_ATTRIBUTES_SECONDARY.to_vec(),
            ]
        );
    }

    /// The window title is taken from OSC, and the pane can show it.
    #[test]
    fn the_title_comes_from_osc() {
        let bel = vt("\x1b]0;kickpi: ~\x07");
        assert_eq!(bel.title(), "kickpi: ~");
        let st = vt("\x1b]2;kickpi: ~\x1b\\");
        assert_eq!(st.title(), "kickpi: ~");
    }

    /// An OSC this emulator does not implement is dropped, and — crucially —
    /// its argument does not become text.
    #[test]
    fn an_unimplemented_osc_is_not_shown() {
        let vt = vt("\x1b]52;c;aGVsbG8=\x07after");
        assert_eq!(row(&vt, 0), "after");
        assert_eq!(vt.title(), "");
    }

    /// Colour reaches the cells, so a build log's red errors are red.
    #[test]
    fn colour_reaches_the_cells() {
        let vt = vt("\x1b[31merr\x1b[0m ok");
        let line = vt.line(0).expect("row");
        assert_eq!(line[0].style.fg, Ansi::Indexed(1));
        assert!(line[4].style.is_plain(), "reset applies from here on");
    }

    /// Lines scrolled off the top can be read back by absolute index, with the
    /// screen's rows following the history.
    #[test]
    fn history_and_screen_are_one_index_space() {
        let mut vt = Vt::new(20, 3);
        vt.feed("one\r\ntwo\r\nthree\r\nfour\r\nfive");
        // Three rows are visible, so the first two lines have scrolled off.
        assert_eq!(vt.line_count(), 5);
        assert_eq!(row(&vt, 0), "one");
        assert_eq!(row(&vt, 1), "two");
        assert_eq!(row(&vt, 4), "five", "the last line is the newest");
        assert_eq!(vt.cursor_line(), 4);
    }

    /// `RIS` clears the screen, the title and the alternate screen, so a device
    /// that asks for a full reset really gets one.
    #[test]
    fn reset_clears_screen_and_title() {
        let mut vt = vt("\x1b]0;title\x07hello\x1b[?1049h");
        vt.reset();
        assert!(vt.is_blank());
        assert_eq!(vt.title(), "");
        assert!(!vt.on_alt_screen());
    }

    /// The dump is plain text with no escape sequences in it, so a saved log
    /// can be read in any editor.
    #[test]
    fn the_dump_is_plain_text() {
        let vt = vt("\x1b[1;31;44mbold\x1b[0m\r\nplain\x1b]0;t\x07");
        let dump = vt.dump();
        assert!(dump.contains("bold"), "{dump:?}");
        assert!(dump.contains("plain"), "{dump:?}");
        assert!(!dump.contains('\u{1b}'), "{dump:?}");
    }

    /// Wide glyphs are counted in columns when addressing, so a CJK line and an
    /// ASCII line put the cursor in the same place.
    #[test]
    fn addressing_counts_wide_glyphs_as_two_columns() {
        let vt = vt("中文\x1b[1;5Hx");
        assert_eq!(row(&vt, 0), "中文x");
    }
}
