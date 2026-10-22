//! The escape-sequence state machine: text in, semantic events out.
//!
//! A terminal's input is not a stream of lines, it is a stream of *effects*:
//! "move the cursor here", "paint the next glyph green", "erase the line". This
//! module does nothing with those effects — it recognises them, and hands each
//! one to a [`Handler`]. Keeping recognition separate from application is what
//! makes both halves testable: a [`Recorder`] handler can assert what a byte
//! string *means* without a screen in sight, and the screen can be exercised
//! without going through escape codes.
//!
//! The byte-after-byte shape follows the ECMA-48 / VT500 states. Two rules do
//! most of the work:
//!
//! - `ESC` always restarts a sequence, from any state. A truncated sequence is
//!   therefore harmless — the next `ESC` recovers.
//! - Anything unrecognised is *consumed*, never printed. A device that emits a
//!   sequence we do not implement must not spray its parameters across the
//!   screen as text, which is the classic failure of a naive parser.
//!
//! Only ASCII is structural. Anything else is a glyph, and if it turns up in
//! the middle of a sequence it ends the sequence (the device never meant it as
//! a parameter) rather than being silently swallowed.

/// The most parameters one CSI may carry. A sender that exceeds this keeps the
/// first `MAX_PARAMS` and the rest are dropped; no real device comes close, and
/// a bound is what stops a hostile stream from growing the parser.
pub const MAX_PARAMS: usize = 16;

/// A CSI's parameters, with "the sender left this one out" kept distinct from
/// "the sender wrote a zero".
///
/// The distinction is load-bearing: `ESC [ H` and `ESC [ 0 ; 0 H` both mean
/// home, but `ESC [ 5 H` means row five, and the default for an omitted
/// parameter differs by command (zero for erase, one for motion). Collapsing
/// the two at parse time would force every consumer to re-guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    values: [u32; MAX_PARAMS],
    given: [bool; MAX_PARAMS],
    len: usize,
    /// Set once more parameters arrived than there is room for. Kept apart from
    /// `len` so the count never exceeds the array — the arithmetic that would
    /// otherwise read past the end.
    overflow: bool,
}

impl Default for Params {
    fn default() -> Params {
        Params {
            values: [0; MAX_PARAMS],
            given: [false; MAX_PARAMS],
            len: 0,
            overflow: false,
        }
    }
}

impl Params {
    /// How many slots the sequence opened, whether or not each carried digits.
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The `i`-th parameter, or `None` when it was omitted.
    pub fn get(&self, i: usize) -> Option<u32> {
        if i < self.len && self.given[i] {
            Some(self.values[i])
        } else {
            None
        }
    }

    /// The `i`-th parameter with VT's usual "omitted means zero".
    pub fn at(&self, i: usize) -> u32 {
        self.get(i).unwrap_or(0)
    }

    /// The `i`-th parameter with the motion commands' "omitted or zero means
    /// one", so `ESC [ A` and `ESC [ 1 A` are the same move.
    pub fn at_least_one(&self, i: usize) -> usize {
        self.get(i).unwrap_or(0).max(1) as usize
    }

    /// Read the `i`-th parameter as an extended colour selector, the shape
    /// `38` and `48` take: `5 ; n` for the palette or `2 ; r ; g ; b` for true
    /// colour. Returns the value and how many further slots it consumed.
    pub fn extended_colour(&self, i: usize) -> Option<(Colour, usize)> {
        match self.get(i + 1)? {
            5 => {
                let index = self.get(i + 2)?;
                Some((Colour::Indexed(index.min(255) as u8), 2))
            }
            2 => {
                let r = self.get(i + 2)?.min(255) as u8;
                let g = self.get(i + 3)?.min(255) as u8;
                let b = self.get(i + 4)?.min(255) as u8;
                Some((Colour::Rgb(r, g, b), 4))
            }
            _ => None,
        }
    }

    fn clear(&mut self) {
        *self = Params::default();
    }

    fn push_digit(&mut self, digit: u32) {
        if self.overflow {
            return;
        }
        if self.len == 0 {
            self.len = 1;
        }
        let last = self.len - 1;
        if !self.given[last] {
            self.given[last] = true;
            self.values[last] = 0;
        }
        self.values[last] = self.values[last].saturating_mul(10).saturating_add(digit);
    }

    /// `;` or `:` — another parameter follows. Both are accepted as separators:
    /// `38;5;n` and `38:5:n` are the same colour to everything that matters
    /// here, and one flat list reads the same either way.
    ///
    /// A separator closes the slot before it, and closes it as a *stated* zero
    /// when no digits were written: `ESC [ ; 5 m` is parameter 0 followed by 5,
    /// and letting the separator advance past slot 0 would shift 5 into its
    /// place. Past the cap the rest are dropped, digits included: letting them
    /// fall into the last slot would report a parameter value the sender never
    /// sent.
    fn next(&mut self) {
        if self.len == 0 {
            self.len = 1;
        }
        let last = self.len - 1;
        if !self.given[last] {
            self.given[last] = true;
            self.values[last] = 0;
        }
        if self.len < MAX_PARAMS {
            self.len += 1;
        } else {
            self.overflow = true;
        }
    }
}

/// A colour as a sequence asks for it, before the theme gives it a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Colour {
    /// One of the 16 ANSI slots (or, for `38;5;n` above 15, the 256-colour
    /// cube — the screen keeps the index and the theme decides what it is).
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// What a parser recognises. Every method has a sensible empty default, so a
/// handler only implements the events it cares about.
pub trait Handler {
    /// A printable glyph.
    fn print(&mut self, ch: char);
    /// A C0 control (0x00–0x1f, 0x7f), passed through raw.
    fn execute(&mut self, byte: u8);
    /// `ESC x`, with any intermediates that came between, such as the `(` of a
    /// charset designation.
    fn esc(&mut self, final_byte: u8, intermediates: &[u8]);
    /// `ESC [ … x`, with parameters, an optional private prefix (`?`, `>`, `<`,
    /// `=`) and intermediates.
    fn csi(&mut self, params: &Params, private: Option<u8>, intermediates: &[u8], final_byte: u8);
    /// `ESC ] …` up to `BEL` or `ESC \`, the raw bytes in between.
    fn osc(&mut self, data: &[u8]);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Ground,
    Escape,
    EscIntermediate,
    CsiEntry,
    CsiParam,
    CsiIntermediate,
    CsiIgnore,
    Osc,
    /// Saw `ESC` inside an OSC string; waiting for the `\` that ends it.
    OscEsc,
    /// Inside a DCS string, which is consumed and discarded.
    Dcs,
    DcsEsc,
}

/// The recogniser. Feed it text; it drives a [`Handler`].
#[derive(Debug, Clone, Default)]
pub struct Parser {
    state: State,
    params: Params,
    private: Option<u8>,
    intermediates: Vec<u8>,
    osc: Vec<u8>,
    /// A cap on a single OSC argument, so an unterminated one cannot grow
    /// without bound on a stream that never sends `BEL`.
    max_osc: usize,
}

/// How long an OSC argument may get before the rest is dropped.
const DEFAULT_MAX_OSC: usize = 4096;

/// How many intermediate bytes a sequence may carry before the rest are
/// dropped. No real sequence uses more than two (`ESC ( B`), and the cap is
/// what keeps a stream that never sends a final byte from growing the list
/// without bound.
const MAX_INTERMEDIATES: usize = 4;

impl Parser {
    pub fn new() -> Parser {
        Parser {
            max_osc: DEFAULT_MAX_OSC,
            ..Parser::default()
        }
    }

    /// Feed a run of decoded text.
    pub fn feed_str(&mut self, text: &str, handler: &mut impl Handler) {
        for ch in text.chars() {
            self.feed(ch, handler);
        }
    }

    /// Feed one character.
    pub fn feed(&mut self, ch: char, handler: &mut impl Handler) {
        if !ch.is_ascii() {
            match self.state {
                // Inside a string a non-ASCII character is *content*: an OSC
                // title is text and can be in any script, so ending the string
                // on it would cut the title short at its first accented letter,
                // and printing it would spill the tail of the title into the
                // pane.
                State::Osc | State::OscEsc => {
                    if self.state == State::OscEsc {
                        // The ESC was literal content after all, exactly as the
                        // ASCII path decides for any other byte.
                        self.push_osc(0x1b);
                        self.state = State::Osc;
                    }
                    let mut utf8 = [0u8; 4];
                    for byte in ch.encode_utf8(&mut utf8).bytes() {
                        self.push_osc(byte);
                    }
                }
                // A DCS body is consumed and discarded, whatever it holds.
                State::Dcs | State::DcsEsc => {
                    if self.state == State::DcsEsc {
                        self.state = State::Dcs;
                    }
                }
                // Outside a string a non-ASCII character cannot be part of the
                // sequence (all structure is ASCII), so it ends the sequence
                // and is shown. Swallowing it would lose a glyph; reporting it
                // as a parameter would corrupt the sequence.
                _ => {
                    self.state = State::Ground;
                    self.params.clear();
                    self.intermediates.clear();
                    handler.print(ch);
                }
            }
            return;
        }
        let byte = ch as u8;
        match self.state {
            State::Ground => match byte {
                0x1b => self.begin_escape(),
                0x00..=0x1f | 0x7f => handler.execute(byte),
                _ => handler.print(ch),
            },
            State::Escape => self.escape(byte, handler),
            State::EscIntermediate => match byte {
                0x1b => self.begin_escape(),
                0x20..=0x2f => self.push_intermediate(byte),
                0x30..=0x7e => {
                    self.state = State::Ground;
                    handler.esc(byte, &self.intermediates);
                }
                // C0 controls still execute inside an escape sequence.
                _ => handler.execute(byte),
            },
            State::CsiEntry | State::CsiParam => self.csi_byte(byte, handler),
            State::CsiIntermediate => match byte {
                0x1b => self.begin_escape(),
                0x20..=0x2f => self.push_intermediate(byte),
                0x40..=0x7e => {
                    self.state = State::Ground;
                    handler.csi(&self.params, self.private, &self.intermediates, byte);
                }
                _ => handler.execute(byte),
            },
            // Ignore is a real state, not an error: it keeps consuming until the
            // final byte so the sequence's parameters cannot leak as text.
            State::CsiIgnore => {
                if byte == 0x1b {
                    self.begin_escape();
                } else if (0x40..=0x7e).contains(&byte) {
                    self.state = State::Ground;
                }
            }
            State::Osc => match byte {
                0x07 => self.end_osc(handler),
                0x1b => self.state = State::OscEsc,
                _ => self.push_osc(byte),
            },
            State::OscEsc => {
                if byte == b'\\' {
                    self.end_osc(handler);
                } else if byte == 0x1b {
                    // Two ESC in a row: still waiting for the terminator.
                } else {
                    // Not a terminator, so the ESC was literal content.
                    self.push_osc(0x1b);
                    self.state = State::Osc;
                    self.push_osc(byte);
                }
            }
            State::Dcs => {
                if byte == 0x1b {
                    self.state = State::DcsEsc;
                } else if byte == 0x07 {
                    self.state = State::Ground;
                }
            }
            State::DcsEsc => {
                self.state = if byte == b'\\' {
                    State::Ground
                } else {
                    State::Dcs
                };
            }
        }
    }

    fn begin_escape(&mut self) {
        self.state = State::Escape;
        self.params.clear();
        self.private = None;
        self.intermediates.clear();
    }

    fn push_osc(&mut self, byte: u8) {
        if self.osc.len() < self.max_osc {
            self.osc.push(byte);
        }
    }

    /// Add an intermediate byte, up to [`MAX_INTERMEDIATES`]: the list is only
    /// ever handed to a handler, and a sender that never sends a final byte must
    /// not be able to grow it without bound.
    fn push_intermediate(&mut self, byte: u8) {
        if self.intermediates.len() < MAX_INTERMEDIATES {
            self.intermediates.push(byte);
        }
    }

    fn end_osc(&mut self, handler: &mut impl Handler) {
        self.state = State::Ground;
        handler.osc(&self.osc);
        self.osc.clear();
    }

    fn escape(&mut self, byte: u8, handler: &mut impl Handler) {
        match byte {
            0x1b => self.begin_escape(),
            b'[' => {
                self.state = State::CsiEntry;
                self.params.clear();
                self.private = None;
                self.intermediates.clear();
            }
            b']' => {
                self.state = State::Osc;
                self.osc.clear();
            }
            // DCS, SOS, PM and APC all introduce a string that ends at ST; none
            // of them carries anything this terminal acts on.
            b'P' | b'X' | b'^' | b'_' => self.state = State::Dcs,
            0x20..=0x2f => {
                self.push_intermediate(byte);
                self.state = State::EscIntermediate;
            }
            0x30..=0x7e => {
                self.state = State::Ground;
                handler.esc(byte, &self.intermediates);
            }
            _ => handler.execute(byte),
        }
    }

    fn csi_byte(&mut self, byte: u8, handler: &mut impl Handler) {
        match byte {
            0x1b => self.begin_escape(),
            0x30..=0x39 => {
                self.state = State::CsiParam;
                self.params.push_digit(u32::from(byte - 0x30));
            }
            b';' | b':' => {
                self.state = State::CsiParam;
                self.params.next();
            }
            // `?` `>` `<` `=` — the private marker, which distinguishes `?25h`
            // (show the cursor) from a hypothetical `25h`.
            0x3c..=0x3f => {
                self.private = Some(byte);
                self.state = State::CsiParam;
            }
            0x20..=0x2f => {
                self.push_intermediate(byte);
                self.state = State::CsiIntermediate;
            }
            0x40..=0x7e => {
                self.state = State::Ground;
                handler.csi(&self.params, self.private, &self.intermediates, byte);
            }
            // A control character inside a CSI still executes.
            0x00..=0x1f => handler.execute(byte),
            // Nothing else is legal here; consume up to the final byte.
            _ => self.state = State::CsiIgnore,
        }
    }
}

/// A [`Handler`] that records what it was told. The tests use it to assert the
/// parser's reading of a byte string with no screen involved.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Recorder {
    pub events: Vec<String>,
}

impl Handler for Recorder {
    fn print(&mut self, ch: char) {
        self.events.push(format!("print {ch:?}"));
    }
    fn execute(&mut self, byte: u8) {
        self.events.push(format!("exec {byte:#04x}"));
    }
    fn esc(&mut self, final_byte: u8, intermediates: &[u8]) {
        self.events.push(format!(
            "esc {}{}",
            final_byte as char,
            quote(intermediates)
        ));
    }
    fn csi(&mut self, params: &Params, private: Option<u8>, intermediates: &[u8], final_byte: u8) {
        let listed: Vec<String> = (0..params.len())
            .map(|i| match params.get(i) {
                Some(value) => value.to_string(),
                None => "_".to_string(),
            })
            .collect();
        self.events.push(format!(
            "csi {}{} [{}] {}{}",
            private.map_or(String::new(), |b| (b as char).to_string()),
            final_byte as char,
            listed.join(" "),
            final_byte as char,
            quote(intermediates)
        ));
    }
    fn osc(&mut self, data: &[u8]) {
        self.events
            .push(format!("osc {:?}", String::from_utf8_lossy(data)));
    }
}

/// The intermediates as a readable suffix, and nothing at all when there are
/// none — so a plain sequence reads as `csi m [1 32] m`.
fn quote(intermediates: &[u8]) -> String {
    if intermediates.is_empty() {
        String::new()
    } else {
        format!(" +{:?}", String::from_utf8_lossy(intermediates))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Recorder {
        let mut parser = Parser::new();
        let mut recorder = Recorder::default();
        parser.feed_str(text, &mut recorder);
        recorder
    }

    /// Plain text is printed and nothing else happens.
    #[test]
    fn plain_text_is_printed() {
        assert_eq!(parse("hi").events, vec!["print 'h'", "print 'i'"]);
    }

    /// The sequence a shell sends most: colour on, colour off. The parameters
    /// are read, not printed.
    #[test]
    fn sgr_is_a_csi_not_text() {
        let r = parse("\x1b[1;32mgreen\x1b[0m");
        assert!(r.events[0].starts_with("csi m [1 32]"), "{:?}", r.events);
        assert_eq!(r.events[1], "print 'g'");
        assert!(r.events.last().unwrap().starts_with("csi m [0]"));
        assert!(
            !r.events.iter().any(|e| e.contains("print '1'")),
            "a parameter leaked as text: {:?}",
            r.events
        );
    }

    /// An omitted parameter is not the same as a written zero, so `ESC [ H`
    /// and `ESC [ 0 H` can still be told apart downstream.
    #[test]
    fn an_omitted_parameter_is_distinct_from_zero() {
        let r = parse("\x1b[H");
        assert_eq!(r.events, vec!["csi H [] H"]);
        let r = parse("\x1b[0;0H");
        assert_eq!(r.events, vec!["csi H [0 0] H"]);
    }

    /// The private prefix survives, because `?25h` and `25h` are different
    /// commands.
    #[test]
    fn the_private_prefix_is_kept() {
        let r = parse("\x1b[?25l");
        assert!(r.events[0].contains("?l [25]"), "{:?}", r.events);
        let r = parse("\x1b[25l");
        assert!(r.events[0].starts_with("csi l [25]"), "{:?}", r.events);
    }

    /// An unknown sequence is consumed whole. The failure this prevents is
    /// parameters spraying across the screen as text.
    #[test]
    fn an_unknown_sequence_is_consumed_not_printed() {
        let r = parse("a\x1b[>0;276;0cb");
        assert_eq!(
            r.events,
            vec!["print 'a'", "csi >c [0 276 0] c", "print 'b'"]
        );
    }

    /// A sequence we do not implement still ends at its final byte, so the text
    /// after it is text.
    #[test]
    fn an_unimplemented_final_byte_still_ends_the_sequence() {
        let r = parse("\x1b[1;2;3;4;5;6;7;8;9zok");
        assert_eq!(r.events[0].chars().next(), Some('c'));
        assert_eq!(r.events.last().unwrap(), "print 'k'");
    }

    /// C0 controls execute where they appear, including inside a sequence.
    #[test]
    fn controls_execute() {
        assert_eq!(parse("a\r\nb").events.len(), 4);
        let r = parse("\x1b[\rH");
        assert!(r.events.iter().any(|e| e == "exec 0x0d"), "{:?}", r.events);
    }

    /// `ESC` restarts from anywhere: a truncated sequence is not a trap.
    #[test]
    fn escape_restarts_a_truncated_sequence() {
        let r = parse("\x1b[12\x1b[31mX");
        assert!(r.events[0].contains("m [31]"), "{:?}", r.events);
        assert_eq!(r.events[1], "print 'X'");
        assert!(
            !r.events.iter().any(|e| e.contains("print '1'")),
            "{:?}",
            r.events
        );
    }

    /// An OSC string ends at `BEL` and at `ESC \`, and the payload is handed
    /// over intact.
    #[test]
    fn osc_ends_at_bel_or_st() {
        let r = parse("\x1b]0;title\x07");
        assert_eq!(r.events, vec!["osc \"0;title\""]);
        let r = parse("\x1b]0;title\x1b\\");
        assert_eq!(r.events, vec!["osc \"0;title\""]);
    }

    /// An `ESC` inside an OSC that is not a terminator is content, so a title
    /// containing an escape does not truncate the string at the wrong place.
    #[test]
    fn an_esc_inside_osc_is_content_unless_terminated() {
        let r = parse("\x1b]0;a\x1bXb\x07");
        assert_eq!(r.events, vec!["osc \"0;a\\u{1b}Xb\""]);
    }

    /// A DCS string is consumed and discarded — it must never print its payload.
    #[test]
    fn a_dcs_string_is_discarded() {
        let r = parse("\x1bPq#0;2;0;0;0\x1b\\after");
        assert_eq!(r.events[0], "print 'a'");
        assert!(
            !r.events.iter().any(|e| e.contains("print 'q'")),
            "{:?}",
            r.events
        );
    }

    /// An unterminated OSC stops growing at the cap: a stream that never sends
    /// `BEL` cannot grow the parser without bound.
    #[test]
    fn an_unterminated_osc_is_bounded() {
        let mut parser = Parser::new();
        let mut recorder = Recorder::default();
        parser.feed_str("\x1b]0;", &mut recorder);
        for _ in 0..(DEFAULT_MAX_OSC * 2) {
            parser.feed('x', &mut recorder);
        }
        assert!(recorder.events.is_empty(), "nothing reported yet");
        parser.feed('\x07', &mut recorder);
        let osc = &recorder.events[0];
        assert!(osc.len() <= DEFAULT_MAX_OSC + 16, "{} chars", osc.len());
    }

    /// A title can be in any script. A non-ASCII character inside an OSC is
    /// content, not the end of the string: cutting the title at its first
    /// accented letter — which is what "print it and go back to ground"
    /// amounted to — loses the rest of it and spills it into the pane.
    #[test]
    fn a_title_in_another_script_keeps_its_characters() {
        let r = parse("\x1b]0;温度计 20°C\x07");
        assert_eq!(r.events, vec!["osc \"0;温度计 20°C\""]);
    }

    /// And inside a DCS the same character is consumed with the rest of the
    /// payload rather than dropped out of the string and printed.
    #[test]
    fn a_non_ascii_dcs_payload_is_still_discarded() {
        let r = parse("\x1bP温度\x1b\\after");
        assert_eq!(r.events[0], "print 'a'", "the payload itself never shows");
        assert!(
            !r.events.iter().any(|event| event.contains(['温', '度'])),
            "{:?}",
            r.events
        );
    }

    /// An omitted parameter keeps its own slot: `ESC [ ; 5 m` is zero followed
    /// by five, and advancing the separator past slot zero — which is what the
    /// parser used to do — reads the five as the first parameter.
    #[test]
    fn an_omitted_parameter_stays_in_its_own_slot() {
        let r = parse("\x1b[;5m");
        assert_eq!(r.events, vec!["csi m [0 5] m"]);
        let r = parse("\x1b[;;5m");
        assert_eq!(r.events, vec!["csi m [0 0 5] m"]);
        let r = parse("\x1b[5;m");
        assert_eq!(r.events, vec!["csi m [5 _] m"]);
    }

    /// Intermediate bytes are bounded too: a sender that never sends a final
    /// byte can otherwise grow the list with every byte it sends.
    #[test]
    fn an_endless_run_of_intermediates_is_bounded() {
        /// A handler that only counts the intermediates it was handed.
        #[derive(Default)]
        struct Intermediates(usize);
        impl Handler for Intermediates {
            fn print(&mut self, _: char) {}
            fn execute(&mut self, _: u8) {}
            fn esc(&mut self, _: u8, intermediates: &[u8]) {
                self.0 = intermediates.len();
            }
            fn csi(&mut self, _: &Params, _: Option<u8>, intermediates: &[u8], _: u8) {
                self.0 = intermediates.len();
            }
            fn osc(&mut self, _: &[u8]) {}
        }

        let mut parser = Parser::new();
        let mut seen = Intermediates::default();
        parser.feed_str(&format!("\x1b[{}H", " ".repeat(1_000)), &mut seen);
        assert_eq!(seen.0, MAX_INTERMEDIATES, "a CSI run is capped");

        let mut parser = Parser::new();
        let mut seen = Intermediates::default();
        parser.feed_str(&format!("\x1b{}B", " ".repeat(1_000)), &mut seen);
        assert_eq!(seen.0, MAX_INTERMEDIATES, "and an ESC run too");
    }

    /// A non-ASCII character inside a sequence ends it and is still shown: the
    /// glyph is the device's, the sequence was malformed.
    #[test]
    fn a_non_ascii_glyph_ends_a_sequence_and_is_shown() {
        let r = parse("\x1b[1;中");
        assert_eq!(r.events, vec!["print '中'"]);
    }

    /// Intermediates are reported, so `ESC ( B` (charset) is recognised as what
    /// it is rather than mistaken for a final byte.
    #[test]
    fn intermediates_are_reported() {
        let r = parse("\x1b(Bx");
        assert_eq!(r.events[0], "esc B +\"(\"");
        assert_eq!(r.events[1], "print 'x'");
    }

    /// A colour selector reads as a colour, and reports how many slots it ate —
    /// the reason `38;5;196m` does not also emit a stray `5` and `196`.
    #[test]
    fn extended_colour_is_read_as_one_value() {
        let params = {
            let mut parser = Parser::new();
            let mut recorder = Recorder::default();
            parser.feed_str("\x1b[38;5;196m", &mut recorder);
            // Re-run to grab the parsed params through a handler that keeps them.
            struct Grab(Params);
            impl Handler for Grab {
                fn print(&mut self, _: char) {}
                fn execute(&mut self, _: u8) {}
                fn esc(&mut self, _: u8, _: &[u8]) {}
                fn csi(&mut self, params: &Params, _p: Option<u8>, _i: &[u8], final_byte: u8) {
                    if final_byte == b'm' {
                        self.0 = *params;
                    }
                }
                fn osc(&mut self, _: &[u8]) {}
            }
            let mut grab = Grab(Params::default());
            let mut parser = Parser::new();
            parser.feed_str("\x1b[38;5;196m", &mut grab);
            grab.0
        };
        assert_eq!(params.get(0), Some(38));
        assert_eq!(params.extended_colour(0), Some((Colour::Indexed(196), 2)));
        assert_eq!(
            params.extended_colour(0).map(|(_, eaten)| eaten),
            Some(2),
            "38;5;196 consumes two following slots"
        );
    }

    /// True colour takes four following slots.
    #[test]
    fn true_colour_takes_four_slots() {
        let mut parser = Parser::new();
        struct Grab(Params);
        impl Handler for Grab {
            fn print(&mut self, _: char) {}
            fn execute(&mut self, _: u8) {}
            fn esc(&mut self, _: u8, _: &[u8]) {}
            fn csi(&mut self, params: &Params, _p: Option<u8>, _i: &[u8], final_byte: u8) {
                if final_byte == b'm' {
                    self.0 = *params;
                }
            }
            fn osc(&mut self, _: &[u8]) {}
        }
        let mut grab = Grab(Params::default());
        parser.feed_str("\x1b[48;2;10;20;30m", &mut grab);
        assert_eq!(
            grab.0.extended_colour(0),
            Some((Colour::Rgb(10, 20, 30), 4))
        );
    }

    /// More parameters than the cap are dropped, not wrapped into the last slot.
    #[test]
    fn too_many_parameters_are_dropped() {
        let mut parser = Parser::new();
        let mut recorder = Recorder::default();
        let many = format!("\x1b[{}m", vec!["1"; MAX_PARAMS + 8].join(";"));
        parser.feed_str(&many, &mut recorder);
        let event = &recorder.events[0];
        let listed = event
            .split('[')
            .nth(1)
            .and_then(|s| s.split(']').next())
            .unwrap_or("");
        assert_eq!(listed.split(' ').count(), MAX_PARAMS, "{event}");
    }
}
