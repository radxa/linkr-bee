//! What this terminal can draw.
//!
//! The interface is designed in true colour and Unicode, and it has to be
//! usable on everything else: a serial console, a phone's SSH client, a
//! 256-colour `screen`, a Windows console that is not Windows Terminal, a
//! terminal whose locale is not UTF-8. None of those is a different program —
//! they are the same frame drawn with fewer colours and coarser glyphs.
//!
//! Two questions are asked once, at start-up, and carried on the theme so no
//! view has to ask again:
//!
//! * **How much colour?** [`ColorCap`] — 24-bit RGB, the 256-entry xterm
//!   palette, the sixteen names, or none at all. A theme under a lower
//!   capability is *quantised* ([`crate::theme::Theme::with_capability`]): the
//!   same roles, each resolved to the nearest colour the terminal has. Under
//!   [`ColorCap::Mono`] every role resolves to the terminal's own ink and the
//!   styles that need a distinction take it from an attribute instead —
//!   reverse for a selection, bold for the live colour.
//! * **Which glyphs?** [`GlyphSet`] — the designed set (box drawing, blocks,
//!   dots) or a pure-ASCII one, for a terminal that would mangle anything
//!   outside Latin-1. The set is drawn from [`GlyphSet`]'s own methods, so a
//!   view asks the theme for a mark rather than knowing which character it is.
//!
//! The rules read the environment and nothing else (no terminal queries: the
//! answer has to be the same on a pipe as on a tty, so `--print-frame` in a
//! test can be told what to draw). Both questions can be answered by hand with
//! `LINKR_TUI_COLOR` and `LINKR_TUI_GLYPH`, which is also how the tests pin
//! them; `LINKR_LOGO` forces a logo variant specifically (see `crate::logo`).
//!
//! Everything here is a pure function of the environment, so the rules — as
//! opposed to the environment they read — are what the tests below walk.

use std::borrow::Cow;

use ratatui::style::Color;
use ratatui::symbols;

use crate::event::ConnectionState;

/// How much colour the terminal can be trusted with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColorCap {
    /// No colour: the terminal's own ink, and attributes where a style needs a
    /// distinction.
    Mono,
    /// The sixteen ANSI names, addressed by name so the wire carries `31`
    /// rather than a 256-colour `38;5;1` an old cap would ignore.
    Color16,
    /// The 256-entry xterm palette.
    Color256,
    /// 24-bit RGB, the designed palette.
    #[default]
    TrueColor,
}

/// Which set of drawing glyphs the terminal can render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GlyphSet {
    /// `-|+`, `>`, `*`, `#`: one cell in any Latin-1 terminal, and the set a
    /// locale that is not UTF-8 asks for.
    Ascii,
    /// Box drawing, block elements, circles: the designed set.
    #[default]
    Unicode,
}

/// The two answers, carried together so a call can forward one value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Capability {
    pub color: ColorCap,
    pub glyphs: GlyphSet,
}

impl Capability {
    /// Everything the design asks for: what the tests paint with, and what a
    /// machine with nothing to go on gets.
    pub const FULL: Capability = Capability {
        color: ColorCap::TrueColor,
        glyphs: GlyphSet::Unicode,
    };

    /// Read the environment (see the module docs for the rules).
    pub fn detect() -> Capability {
        let windows = cfg!(windows);
        let wt = std::env::var_os("WT_SESSION").is_some();
        Capability {
            color: ColorCap::from_parts(
                var("LINKR_TUI_COLOR").as_deref(),
                no_color(),
                var("COLORTERM").as_deref(),
                var("TERM").as_deref(),
                windows,
                wt,
            ),
            glyphs: GlyphSet::from_parts(
                var("LINKR_TUI_GLYPH").as_deref(),
                locale().as_deref(),
                var("TERM").as_deref(),
                windows,
                wt,
            ),
        }
    }
}

/// One environment variable, when it is set to something.
fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// `NO_COLOR` as its convention defines it: present, and not the empty
/// string.
fn no_color() -> bool {
    std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty())
}

/// The locale variables in the order the C library reads them.
fn locale() -> Option<String> {
    var("LC_ALL")
        .or_else(|| var("LC_CTYPE"))
        .or_else(|| var("LANG"))
}

impl ColorCap {
    /// The rule, apart from the environment, so the tests can walk it.
    ///
    /// The order is the whole meaning: an explicit request wins over
    /// `NO_COLOR`, `NO_COLOR` wins over what the terminal claims about itself,
    /// and the claims are read in the order of how much they say — `COLORTERM`
    /// names the colour depth, `TERM` names the terminal.
    fn from_parts(
        forced: Option<&str>,
        no_color: bool,
        colorterm: Option<&str>,
        term: Option<&str>,
        windows: bool,
        wt_session: bool,
    ) -> ColorCap {
        if let Some(cap) = forced.and_then(forced_cap) {
            return cap;
        }
        if no_color {
            return ColorCap::Mono;
        }
        if windows {
            // Windows Terminal is a modern emulator; anything else on Windows
            // that can run this program at all is a Windows 10 console, which
            // understands the 256-colour form. A pre-VT console could not run
            // a full-screen interface in the first place.
            return if wt_session {
                ColorCap::TrueColor
            } else {
                ColorCap::Color256
            };
        }
        let colorterm = colorterm.unwrap_or_default().to_ascii_lowercase();
        if colorterm.contains("truecolor") || colorterm.contains("24bit") {
            return ColorCap::TrueColor;
        }
        let term = term.unwrap_or_default().to_ascii_lowercase();
        if term.contains("direct") {
            // `xterm-direct`, `tmux-direct`: the name states the depth.
            return ColorCap::TrueColor;
        }
        if term.contains("256color") {
            return ColorCap::Color256;
        }
        if term == "dumb" {
            return ColorCap::Mono;
        }
        // A name that says nothing about colour, or no name at all: the
        // sixteen are what every terminal since the VT100 has had.
        ColorCap::Color16
    }

    /// The capability as the interface spells it — the About window's line,
    /// and what `--print-frame` evidence is labelled with. A technical token,
    /// so the same word in either language.
    pub fn name(self) -> &'static str {
        match self {
            ColorCap::Mono => "Mono",
            ColorCap::Color16 => "Color16",
            ColorCap::Color256 => "Color256",
            ColorCap::TrueColor => "TrueColor",
        }
    }
}

/// The capability `LINKR_TUI_COLOR` names, when it names one.
fn forced_cap(raw: &str) -> Option<ColorCap> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "truecolor" | "24bit" | "rgb" => Some(ColorCap::TrueColor),
        "256" | "256color" => Some(ColorCap::Color256),
        "16" | "ansi" => Some(ColorCap::Color16),
        "mono" | "none" | "off" => Some(ColorCap::Mono),
        _ => None,
    }
}

impl GlyphSet {
    /// The rule, apart from the environment, so the tests can walk it.
    ///
    /// A locale that says UTF-8 means the terminal is expected to render the
    /// designed glyphs; a locale that says something else is a terminal that
    /// may be showing bytes as Latin-1, where a box-drawing character is
    /// mojibake. No locale at all is a modern default, not a warning: a
    /// container often has none, and its terminal is usually UTF-8.
    ///
    /// The bare Linux console and `dumb` are the other way a terminal says the
    /// same thing: the kernel's own font maps the box-drawing range, but the
    /// drawn mark's braille dots and much else are outside it, and `dumb`
    /// promises nothing at all. Both take the ASCII set — the zip's rule, and
    /// the one that keeps a console log-in usable.
    fn from_parts(
        forced: Option<&str>,
        locale: Option<&str>,
        term: Option<&str>,
        windows: bool,
        wt_session: bool,
    ) -> GlyphSet {
        if let Some(raw) = forced {
            match raw.trim().to_ascii_lowercase().as_str() {
                "ascii" => return GlyphSet::Ascii,
                "unicode" | "utf8" | "utf-8" => return GlyphSet::Unicode,
                _ => {}
            }
        }
        let term = term.unwrap_or_default().to_ascii_lowercase();
        if term == "linux" || term == "dumb" {
            return GlyphSet::Ascii;
        }
        if windows {
            // Every Windows console that can run this program draws box
            // drawing and blocks; where it disagrees about a glyph's *width*,
            // the compatibility pass narrows it (`crate::ui::legacy`).
            let _ = wt_session;
            return GlyphSet::Unicode;
        }
        match locale {
            None => GlyphSet::Unicode,
            Some(locale) => {
                if locale.to_ascii_lowercase().contains("utf") {
                    GlyphSet::Unicode
                } else {
                    GlyphSet::Ascii
                }
            }
        }
    }

    /// The glyph set as the interface spells it, in the About window's line.
    /// A technical token, like the colour depth's.
    pub fn name(self) -> &'static str {
        match self {
            GlyphSet::Ascii => "Ascii",
            GlyphSet::Unicode => "Unicode",
        }
    }

    // --- the marks the interface draws ------------------------------------
    //
    // Each one is one or two cells in both sets, and the ASCII spelling keeps
    // the *shape of the distinction* rather than the picture: an open circle
    // and a filled one become `o` and `*`, which no font renders wide.

    /// A connection state's mark, the way the top bar and the sidebar draw it.
    ///
    /// The Unicode spelling is [`crate::event::STATE_GLYPHS`], the design's own
    /// four, so the set and the design cannot drift apart.
    pub fn state(self, state: ConnectionState) -> &'static str {
        match self {
            GlyphSet::Unicode => match state {
                ConnectionState::Disconnected => crate::event::STATE_GLYPHS[0],
                ConnectionState::Connecting => crate::event::STATE_GLYPHS[1],
                ConnectionState::Connected => crate::event::STATE_GLYPHS[2],
                ConnectionState::Failed => crate::event::STATE_GLYPHS[3],
            },
            GlyphSet::Ascii => match state {
                ConnectionState::Disconnected => "o",
                ConnectionState::Connecting => "~",
                ConnectionState::Connected => "*",
                ConnectionState::Failed => "x",
            },
        }
    }

    /// The separator between facts in a row: `RX 0 · TX 0`.
    pub fn dot(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "·",
            GlyphSet::Ascii => ".",
        }
    }

    /// The same separator with its spaces, ready for a `format!` line:
    /// `{version} · Z{zephyr}`.
    pub fn dot_sep(self) -> &'static str {
        match self {
            GlyphSet::Unicode => " · ",
            GlyphSet::Ascii => " . ",
        }
    }

    /// The rule a title is underlined with, one cell.
    pub fn dash(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "—",
            GlyphSet::Ascii => "-",
        }
    }

    /// What carries a warning that is written, not drawn.
    pub fn warn_mark(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "⚠",
            GlyphSet::Ascii => "!",
        }
    }

    /// The cursor of a list row: two cells, the mark and a space.
    pub fn cursor(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "▸ ",
            GlyphSet::Ascii => "> ",
        }
    }

    /// What a row without the cursor shows: the same two cells, blank.
    pub fn cursor_blank(self) -> &'static str {
        "  "
    }

    /// The marker in front of a line the user is typing: the palette's search
    /// prompt, two cells wide like the cursor it sits a row above.
    pub fn prompt(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "› ",
            GlyphSet::Ascii => "> ",
        }
    }

    /// The pair that says "Enter flips this": the transport row's `◂▸`.
    pub fn flip(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "◂▸",
            GlyphSet::Ascii => "<>",
        }
    }

    /// The text caret drawn in a field the keyboard is on.
    pub fn caret(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "▌",
            GlyphSet::Ascii => "|",
        }
    }

    /// The horizontal rule drawn under a prompt's title.
    pub fn rule(self) -> char {
        match self {
            GlyphSet::Unicode => '─',
            GlyphSet::Ascii => '-',
        }
    }

    /// The vertical rule drawn between the columns of a field row.
    pub fn divider(self) -> char {
        match self {
            GlyphSet::Unicode => '│',
            GlyphSet::Ascii => '|',
        }
    }

    /// The scrollbar's thumb: one cell of the bar down a list that overflows.
    pub fn thumb(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "┃",
            GlyphSet::Ascii => "|",
        }
    }

    /// Up and down, as a key hint spells them.
    pub fn arrows_ud(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "↑↓",
            GlyphSet::Ascii => "^v",
        }
    }

    /// Left and right, as a key hint spells them.
    pub fn arrows_lr(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "←→",
            GlyphSet::Ascii => "<>",
        }
    }

    /// One arrow on its own: the legend beside a traffic graph, or a step in a
    /// path.
    pub fn arrow_up(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "↑",
            GlyphSet::Ascii => "^",
        }
    }

    /// Down, on its own.
    pub fn arrow_down(self) -> &'static str {
        match self {
            GlyphSet::Unicode => "↓",
            GlyphSet::Ascii => "v",
        }
    }

    /// The filled and empty dots of a signal reading.
    pub fn dots(self) -> (char, char) {
        match self {
            GlyphSet::Unicode => ('●', '○'),
            GlyphSet::Ascii => ('*', 'o'),
        }
    }

    /// The filled and empty cells of a meter: the pair ratatui's own `Gauge`
    /// draws, in the set this terminal has.
    pub fn meter(self) -> (char, char) {
        match self {
            GlyphSet::Unicode => ('█', '░'),
            GlyphSet::Ascii => ('#', '.'),
        }
    }

    /// The ninth-height bars a sparkline draws with, in this set.
    ///
    /// The zero level is *visible* in both sets — the underscore — rather than
    /// blank as ratatui's stock set leaves it: an idle link then draws as a
    /// baseline beside its `0 B/s` instead of as an empty strip, which a fresh
    /// session reads as a broken instrument rather than a quiet one, and the
    /// pauses between bursts stay visible too.
    ///
    /// The zero mark is deliberately *not* the lowest block. A row of only
    /// eight block glyphs is one short of nine levels, so using `▁` for both
    /// zero and one-eighth makes the first visible positive bar appear at a
    /// quarter of the scale. A baseline underscore and the eight blocks give
    /// every level its own mark: any positive sample at or above one-eighth of
    /// the scale is visible, which is what the TX graph needs beside a larger
    /// RX one.
    pub fn bar(self) -> symbols::bar::Set<'static> {
        match self {
            GlyphSet::Unicode => symbols::bar::Set {
                empty: "_",
                one_eighth: "▁",
                one_quarter: "▂",
                three_eighths: "▃",
                half: "▄",
                five_eighths: "▅",
                three_quarters: "▆",
                seven_eighths: "▇",
                full: "█",
            },
            GlyphSet::Ascii => symbols::bar::Set {
                full: "#",
                seven_eighths: "=",
                three_quarters: "=",
                five_eighths: "+",
                half: "+",
                three_eighths: "-",
                one_quarter: "-",
                one_eighth: ".",
                empty: "_",
            },
        }
    }

    /// The border of a box, in this set: rounded where the terminal draws
    /// arcs, plain `+-|` where it does not.
    pub fn border(self) -> Option<symbols::border::Set<'static>> {
        match self {
            GlyphSet::Unicode => None,
            GlyphSet::Ascii => Some(symbols::border::Set {
                top_left: "+",
                top_right: "+",
                bottom_left: "+",
                bottom_right: "+",
                vertical_left: "|",
                vertical_right: "|",
                horizontal_top: "-",
                horizontal_bottom: "-",
            }),
        }
    }
}

/// The interface's own glyphs inside a line of text, in this terminal's set.
///
/// Hint lines — the key stripes under a view, the marker on the transport row,
/// a title that ends in `…` — are written as text, and often carry a glyph the
/// terminal may not have. Under [`GlyphSet::Ascii`] those are translated to the
/// stand-ins the rest of the frame draws with, so a line of hints is not the
/// one place a terminal that is not UTF-8 shows mojibake.
///
/// Only the interface's own text goes through here. What the *device* prints is
/// the device's: folding it would be this program editing someone else's
/// output.
pub fn fold(text: &str, glyphs: GlyphSet) -> Cow<'_, str> {
    if glyphs == GlyphSet::Unicode {
        return Cow::Borrowed(text);
    }
    let mut changed = false;
    let mut folded = String::with_capacity(text.len());
    for glyph in text.chars() {
        match ascii_for(glyph) {
            Some(ascii) => {
                changed = true;
                folded.push_str(ascii);
            }
            None => folded.push(glyph),
        }
    }
    if changed {
        Cow::Owned(folded)
    } else {
        Cow::Borrowed(text)
    }
}

/// The ASCII stand-in for one of the interface's glyphs, when the character is
/// one. The table agrees with [`GlyphSet`]'s methods by construction, and the
/// tests hold it to that.
fn ascii_for(glyph: char) -> Option<&'static str> {
    Some(match glyph {
        '·' => ".",
        '…' => "...",
        '—' => "-",
        '–' => "-",
        '─' => "-",
        '│' => "|",
        '┃' => "|",
        '▌' => "|",
        '◂' => "<",
        '▸' => ">",
        '›' => ">",
        '←' => "<",
        '→' => ">",
        '↑' => "^",
        '↓' => "v",
        '●' => "*",
        '○' => "o",
        '◐' => "~",
        '◆' => "x",
        '×' => "x",
        '⌁' => "~",
        '▏' => "|",
        '█' => "#",
        '░' => ".",
        '⚠' => "!",
        _ => return None,
    })
}

// --- colour quantisation ----------------------------------------------------
//
// Above eight colours a palette is fine enough that matching a token to the
// nearest entry keeps the design; at sixteen it is not. The sixteen are six
// hues and four greys, and a designed token is one of the two — an accent
// *means* its hue, a surface *means* its place in the ladder — so a plain
// distance in RGB loses exactly what the token carries: the dark theme's mint
// accent is nearer `Cyan` than `Green` by the numbers and green by the design,
// and the pink danger lands on a grey. What a colour is *for* therefore decides
// how it resolves ([`Role`]), and `Theme::with_capability` is where that is
// known.

/// The four greys of the sixteen, dark to light.
pub const GREYS: [Color; 4] = [Color::Black, Color::DarkGray, Color::Gray, Color::White];

/// What a colour is *for*, when the terminal has only the sixteen names.
///
/// The role is not a label on the result — it is an input to the resolution,
/// because the same RGB value is a different thing as a panel and as an
/// accent, and only the caller knows which it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// A place in the ladder: a ground, a panel, a muted label, a border.
    Grey,
    /// Something that must be readable on whatever is behind it: body text,
    /// the terminal's default foreground, the ink on an accent fill.
    Ink,
    /// A colour whose hue *is* its meaning: the live accent, a warning, a
    /// focus colour.
    Accent,
}

/// `color` as this terminal can show it, given what the colour is for.
pub fn resolve(color: Color, role: Role, capability: ColorCap) -> Color {
    let Color::Rgb(red, green, blue) = color else {
        return color;
    };
    match capability {
        ColorCap::TrueColor => color,
        ColorCap::Color256 => Color::Indexed(rgb_to_256(red, green, blue)),
        ColorCap::Color16 => match role {
            Role::Grey => rgb_to_grey(red, green, blue),
            Role::Ink => rgb_to_ink(red, green, blue),
            Role::Accent => rgb_to_hue(red, green, blue),
        },
        ColorCap::Mono => Color::Reset,
    }
}

/// A colour's lightness, 0..1: the midpoint of its brightest and dimmest
/// channels, which is what `hsl()` means by it — and what the eye reads as
/// "how light is this" for the near-greys most of these tokens are.
pub fn lightness(red: u8, green: u8, blue: u8) -> f32 {
    (f32::from(red.max(green).max(blue)) + f32::from(red.min(green).min(blue))) / (2.0 * 255.0)
}

/// A colour's hue in degrees, 0..360, as `hsl()` computes it. A grey has no
/// hue to speak of and answers 0.
pub fn hue(red: u8, green: u8, blue: u8) -> f32 {
    let (red, green, blue) = (f32::from(red), f32::from(green), f32::from(blue));
    let chroma = red.max(green).max(blue) - red.min(green).min(blue);
    if chroma == 0.0 {
        return 0.0;
    }
    let sector = if red >= green && red >= blue {
        ((green - blue) / chroma).rem_euclid(6.0)
    } else if green >= blue {
        (blue - red) / chroma + 2.0
    } else {
        (red - green) / chroma + 4.0
    };
    sector * 60.0
}

/// The nearest of the four greys, by lightness.
///
/// A tie goes to the darker grey: of two greys, the darker is the one a
/// surface can still be read against.
pub fn rgb_to_grey(red: u8, green: u8, blue: u8) -> Color {
    /// Where each grey sits: the ends of the range, and the two midpoints the
    /// sixteen space them at.
    const STOPS: [f32; 4] = [0.0, 0.5, 0.9, 1.0];
    let lightness = lightness(red, green, blue);
    let mut best = 0;
    let mut best_distance = f32::MAX;
    for (index, stop) in STOPS.iter().enumerate() {
        let distance = (lightness - stop).abs();
        if distance < best_distance {
            best_distance = distance;
            best = index;
        }
    }
    GREYS[best]
}

/// The extreme grey: what a role that must be the most readable thing on its
/// ground resolves to — white ink for a light colour, black for a dark one.
pub fn rgb_to_ink(red: u8, green: u8, blue: u8) -> Color {
    if lightness(red, green, blue) < 0.5 {
        Color::Black
    } else {
        Color::White
    }
}

/// The nearest of the six hues, in the brightness the colour itself has.
///
/// The wheel is cut into the arcs a reader would cut it into, not into sixths:
/// orange belongs with yellow — it is the colour a warning is drawn in — and a
/// mint belongs with green, which is the whole reason this is matched by hue
/// and not by distance.
pub fn rgb_to_hue(red: u8, green: u8, blue: u8) -> Color {
    /// Each family and the pair of names it resolves to, the dark name first.
    const FAMILIES: [[Color; 2]; 6] = [
        [Color::Red, Color::LightRed],
        [Color::Yellow, Color::LightYellow],
        [Color::Green, Color::LightGreen],
        [Color::Cyan, Color::LightCyan],
        [Color::Blue, Color::LightBlue],
        [Color::Magenta, Color::LightMagenta],
    ];
    let family = match hue(red, green, blue) {
        // Red owns the arc across zero: from magenta's edge round to where
        // orange begins.
        h if !(20.0..330.0).contains(&h) => 0,
        h if h < 90.0 => 1,
        h if h < 165.0 => 2,
        h if h < 200.0 => 3,
        h if h < 270.0 => 4,
        _ => 5,
    };
    // The bright name above the middle of the lightness range: a pale token is
    // a pale name, a deep token a deep one, whatever its hue.
    let bright = usize::from(lightness(red, green, blue) >= 0.45);
    FAMILIES[family][bright]
}

/// `grey`, moved one step along the ladder if it is not already *beyond*
/// `floor` in the direction this theme's structure walks.
///
/// The borders use this, because at sixteen colours every dark theme's hairline
/// rounds to the same grey as the panel it is drawn on, and a frame drawn in
/// the colour of its own ground is not a frame. One step is the smallest honest
/// fix, and the ends of the ladder are left to the ink: a border never becomes
/// the brightest thing in the window.
pub fn grey_step(grey: Color, floor: Color, dark: bool) -> Color {
    let index = GREYS
        .iter()
        .position(|candidate| *candidate == grey)
        .unwrap_or(0);
    let floor = GREYS
        .iter()
        .position(|candidate| *candidate == floor)
        .unwrap_or(0);
    let beyond = if dark { index > floor } else { index < floor };
    if beyond {
        return grey;
    }
    let moved = if dark {
        (floor + 1).min(2)
    } else {
        floor.saturating_sub(1).max(1)
    };
    GREYS[moved]
}

/// The nearest entry of the 256-colour palette: the 6×6×6 cube on the levels
/// `0, 95, 135, 175, 215, 255`, or the twenty-four-step grey ramp, whichever
/// is nearer.
///
/// The greys are why this is not a cube lookup: a grey has to land on a grey,
/// and the cube rounds a mid grey to a coloured cell.
pub fn rgb_to_256(red: u8, green: u8, blue: u8) -> u8 {
    const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    /// The cube level nearest to a channel value.
    fn level(value: u8) -> usize {
        let mut best = 0;
        let mut best_distance = u32::MAX;
        for (index, candidate) in LEVELS.iter().enumerate() {
            let distance = u32::from(value).abs_diff(u32::from(*candidate));
            if distance < best_distance {
                best_distance = distance;
                best = index;
            }
        }
        best
    }
    /// The squared distance between a channel and a candidate value.
    fn distance(value: u8, candidate: u8) -> u32 {
        let d = u32::from(value).abs_diff(u32::from(candidate));
        d * d
    }

    let (r, g, b) = (level(red), level(green), level(blue));
    let cube = 16 + (36 * r + 6 * g + b) as u8;
    let cube_distance =
        distance(red, LEVELS[r]) + distance(green, LEVELS[g]) + distance(blue, LEVELS[b]);

    // The grey ramp: entry 232 is 8, and each step adds ten.
    let average = (u16::from(red) + u16::from(green) + u16::from(blue)) / 3;
    let step = ((i32::from(average) - 8).clamp(0, 230) / 10) as u8;
    let grey = 232 + step;
    let grey_value = 8 + 10 * step;
    let grey_distance =
        distance(red, grey_value) + distance(green, grey_value) + distance(blue, grey_value);

    if grey_distance < cube_distance {
        grey
    } else {
        cube
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use unicode_width::UnicodeWidthStr;

    /// The four connection states, in the order the enum declares them.
    const STATES: [ConnectionState; 4] = [
        ConnectionState::Disconnected,
        ConnectionState::Connecting,
        ConnectionState::Connected,
        ConnectionState::Failed,
    ];

    /// A theme resolved for a terminal that has only the sixteen names.
    fn sixteen(choice: crate::theme::ThemeChoice) -> crate::theme::Theme {
        crate::theme::Theme::for_choice(choice).with_capability(Capability {
            color: ColorCap::Color16,
            glyphs: GlyphSet::Unicode,
        })
    }

    /// The family a resolved colour belongs to: what the role has to keep.
    fn family(color: Color) -> &'static str {
        match color {
            Color::Black | Color::DarkGray | Color::Gray | Color::White => "grey",
            Color::Red | Color::LightRed => "red",
            Color::Yellow | Color::LightYellow => "yellow",
            Color::Green | Color::LightGreen => "green",
            Color::Cyan | Color::LightCyan => "cyan",
            Color::Blue | Color::LightBlue => "blue",
            Color::Magenta | Color::LightMagenta => "magenta",
            _ => "not one of the sixteen",
        }
    }

    /// Every capability and every glyph set has its own spelling — the words
    /// the About window shows, and the ones frame evidence is labelled with.
    #[test]
    fn the_capabilities_have_names() {
        assert_eq!(ColorCap::Mono.name(), "Mono");
        assert_eq!(ColorCap::Color16.name(), "Color16");
        assert_eq!(ColorCap::Color256.name(), "Color256");
        assert_eq!(ColorCap::TrueColor.name(), "TrueColor");
        assert_eq!(GlyphSet::Ascii.name(), "Ascii");
        assert_eq!(GlyphSet::Unicode.name(), "Unicode");
    }

    /// The explicit switch wins over everything, including `NO_COLOR`: a user
    /// who typed `LINKR_TUI_COLOR=256` on a terminal that claims to be
    /// monochrome asked for the nearest thing that works, not for the default.
    #[test]
    fn the_forced_capability_wins_over_every_other_claim() {
        for (raw, expected) in [
            ("truecolor", ColorCap::TrueColor),
            ("256", ColorCap::Color256),
            ("16", ColorCap::Color16),
            ("mono", ColorCap::Mono),
            ("ANSI", ColorCap::Color16),
            (" 24bit ", ColorCap::TrueColor),
        ] {
            assert_eq!(
                ColorCap::from_parts(
                    Some(raw),
                    true,
                    Some("truecolor"),
                    Some("xterm-256color"),
                    false,
                    false
                ),
                expected,
                "{raw}"
            );
        }
        // A spelling that names nothing is not a request: the rest of the
        // rules still apply.
        assert_eq!(
            ColorCap::from_parts(Some("mauve"), false, Some("truecolor"), None, false, false),
            ColorCap::TrueColor
        );
    }

    /// `NO_COLOR` is the convention: present, and not the empty string. The
    /// empty value is a script turning the convention off again.
    #[test]
    fn no_color_outranks_the_terminals_claims() {
        assert_eq!(
            ColorCap::from_parts(
                None,
                true,
                Some("truecolor"),
                Some("xterm-256color"),
                false,
                false
            ),
            ColorCap::Mono
        );
        assert_eq!(
            ColorCap::from_parts(
                None,
                false,
                Some("truecolor"),
                Some("xterm-256color"),
                false,
                false
            ),
            ColorCap::TrueColor
        );
    }

    /// The terminal's own claims, read in the order of how much they say:
    /// `COLORTERM` names the depth, `TERM` names the terminal.
    #[test]
    fn the_terminals_claims_are_read_in_that_order() {
        let cap =
            |colorterm, term| ColorCap::from_parts(None, false, colorterm, term, false, false);
        assert_eq!(
            cap(Some("24bit"), Some("xterm-256color")),
            ColorCap::TrueColor
        );
        assert_eq!(cap(None, Some("xterm-direct")), ColorCap::TrueColor);
        assert_eq!(cap(None, Some("screen-256color")), ColorCap::Color256);
        assert_eq!(cap(None, Some("tmux-256color")), ColorCap::Color256);
        assert_eq!(cap(None, Some("xterm")), ColorCap::Color16);
        assert_eq!(cap(None, Some("linux")), ColorCap::Color16);
        assert_eq!(
            cap(None, None),
            ColorCap::Color16,
            "a name that says nothing"
        );
        assert_eq!(cap(None, Some("dumb")), ColorCap::Mono);
    }

    /// Windows outside Windows Terminal is a Windows 10 console: no claim to
    /// read, but far past the sixteen.
    #[test]
    fn windows_is_read_by_its_own_rule() {
        let cap = |wt| ColorCap::from_parts(None, false, None, Some("xterm-256color"), true, wt);
        assert_eq!(cap(true), ColorCap::TrueColor);
        assert_eq!(cap(false), ColorCap::Color256);
        // And `NO_COLOR` still comes first.
        assert_eq!(
            ColorCap::from_parts(None, true, None, None, true, true),
            ColorCap::Mono
        );
    }

    /// The glyph set follows the locale and the terminal's own name: UTF-8
    /// means the designed set, an explicitly different encoding means the
    /// ASCII one, and no locale at all means a modern terminal. The bare Linux
    /// console and `dumb` are ASCII whatever the locale says, and the switch
    /// overrides all of it.
    #[test]
    fn the_glyph_set_follows_the_locale_and_the_terminal() {
        let glyphs =
            |forced, locale, term| GlyphSet::from_parts(forced, locale, term, false, false);
        assert_eq!(glyphs(None, Some("en_US.UTF-8"), None), GlyphSet::Unicode);
        assert_eq!(glyphs(None, Some("zh_CN.utf8"), None), GlyphSet::Unicode);
        assert_eq!(glyphs(None, Some("C"), None), GlyphSet::Ascii);
        assert_eq!(glyphs(None, Some("POSIX"), None), GlyphSet::Ascii);
        assert_eq!(
            glyphs(None, Some("en_US.ISO-8859-1"), None),
            GlyphSet::Ascii
        );
        assert_eq!(glyphs(None, None, None), GlyphSet::Unicode);
        // The terminal's name can say it too, and it beats the locale.
        assert_eq!(
            glyphs(None, Some("en_US.UTF-8"), Some("linux")),
            GlyphSet::Ascii
        );
        assert_eq!(
            glyphs(None, Some("en_US.UTF-8"), Some("dumb")),
            GlyphSet::Ascii
        );
        assert_eq!(
            glyphs(None, Some("en_US.UTF-8"), Some("xterm-256color")),
            GlyphSet::Unicode
        );
        // The switch overrides the locale either way, and the terminal's name
        // too.
        assert_eq!(
            glyphs(Some("ascii"), Some("en_US.UTF-8"), None),
            GlyphSet::Ascii
        );
        assert_eq!(glyphs(Some("unicode"), Some("C"), None), GlyphSet::Unicode);
        assert_eq!(glyphs(Some("utf8"), Some("C"), None), GlyphSet::Unicode);
        assert_eq!(
            glyphs(Some("unicode"), Some("en_US.UTF-8"), Some("linux")),
            GlyphSet::Unicode
        );
        assert_eq!(glyphs(Some("wat"), Some("C"), None), GlyphSet::Ascii);
    }

    /// Windows is Unicode in this program's own terms: any console that can
    /// run a full-screen interface draws box drawing, and where it disagrees
    /// about a glyph's width the compatibility pass narrows it.
    #[test]
    fn windows_draws_the_unicode_set() {
        assert_eq!(
            GlyphSet::from_parts(None, Some("C"), None, true, false),
            GlyphSet::Unicode
        );
        assert_eq!(
            GlyphSet::from_parts(None, None, None, true, true),
            GlyphSet::Unicode
        );
    }

    /// Every mark is one or two cells in both sets — a mark that were wider
    /// would move the line it is in, which is the whole risk of drawing one —
    /// and the four states stay four marks, because a monochrome terminal has
    /// no colour to tell them apart with.
    #[test]
    fn both_sets_draw_marks_of_the_same_width() {
        for set in [GlyphSet::Unicode, GlyphSet::Ascii] {
            let (filled_meter, track_meter) = set.meter();
            let (filled_dot, empty_dot) = set.dots();
            let marks: Vec<String> = STATES
                .iter()
                .map(|state| set.state(*state).to_string())
                .chain([
                    set.dot().to_string(),
                    set.cursor().to_string(),
                    set.cursor_blank().to_string(),
                    set.flip().to_string(),
                    set.caret().to_string(),
                    set.thumb().to_string(),
                    set.arrows_ud().to_string(),
                    set.arrows_lr().to_string(),
                    set.rule().to_string(),
                    set.divider().to_string(),
                    filled_meter.to_string(),
                    track_meter.to_string(),
                    filled_dot.to_string(),
                    empty_dot.to_string(),
                ])
                .collect();
            for mark in &marks {
                let width = UnicodeWidthStr::width(mark.as_str());
                assert!(
                    (1..=2).contains(&width),
                    "{mark:?} is {width} cells wide, and a mark is one or two"
                );
            }
            // The two-cell marks are exactly the pairs: a cursor, an arrow
            // hint, the flip hint.
            for (mark, cells) in [
                (set.cursor(), 2),
                (set.cursor_blank(), 2),
                (set.flip(), 2),
                (set.arrows_ud(), 2),
                (set.arrows_lr(), 2),
                (set.dot(), 1),
                (set.dot_sep(), 3),
                (set.caret(), 1),
                (set.thumb(), 1),
                (set.arrow_up(), 1),
                (set.arrow_down(), 1),
                (set.dash(), 1),
                (set.warn_mark(), 1),
            ] {
                assert_eq!(UnicodeWidthStr::width(mark), cells, "{mark:?}");
            }
            assert_eq!(UnicodeWidthStr::width(set.rule().to_string().as_str()), 1);
            assert_eq!(
                UnicodeWidthStr::width(set.divider().to_string().as_str()),
                1
            );
            for state in STATES {
                assert_eq!(UnicodeWidthStr::width(set.state(state)), 1, "{state:?}");
            }
            let mut seen: Vec<&str> = STATES.iter().map(|state| set.state(*state)).collect();
            seen.sort_unstable();
            seen.dedup();
            assert_eq!(
                seen.len(),
                4,
                "two states share a mark in {set:?}: {seen:?}"
            );
        }
    }

    /// Every sparkline level has its own mark, including zero. Sharing one
    /// between zero and one-eighth is what made a small TX rate paint as the
    /// idle baseline — the first visible positive bar was a quarter of the
    /// shared scale away, not an eighth.
    #[test]
    fn every_sparkline_level_has_its_own_mark() {
        // Unicode has a block for every level; ASCII intentionally reuses
        // marks because there are only so many printable characters, but it
        // still separates idle from the lowest positive bar.
        let bar = GlyphSet::Unicode.bar();
        let marks = [
            bar.empty,
            bar.one_eighth,
            bar.one_quarter,
            bar.three_eighths,
            bar.half,
            bar.five_eighths,
            bar.three_quarters,
            bar.seven_eighths,
            bar.full,
        ];
        let mut seen: Vec<&str> = marks.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 9, "two levels share a mark: {marks:?}");
        for set in [GlyphSet::Unicode, GlyphSet::Ascii] {
            let bar = set.bar();
            assert_ne!(bar.empty, bar.one_eighth, "{set:?}");
        }
    }

    /// The ASCII set is ASCII, down to the bars a sparkline draws with and the
    /// border a box is framed by — a locale that is not UTF-8 is not going to
    /// render a block element, whatever the font would do.
    #[test]
    fn the_ascii_set_is_ascii() {
        let set = GlyphSet::Ascii;
        let bar = set.bar();
        let border = set.border().expect("the ASCII set carries border glyphs");
        let marks = [
            set.state(ConnectionState::Connecting),
            set.dot(),
            set.dot_sep(),
            set.cursor(),
            set.prompt(),
            set.flip(),
            set.caret(),
            set.thumb(),
            set.arrows_ud(),
            set.arrows_lr(),
            set.arrow_up(),
            set.arrow_down(),
            set.dash(),
            set.warn_mark(),
            bar.full,
            bar.seven_eighths,
            bar.three_quarters,
            bar.five_eighths,
            bar.half,
            bar.three_eighths,
            bar.one_quarter,
            bar.one_eighth,
            bar.empty,
            border.top_left,
            border.top_right,
            border.bottom_left,
            border.bottom_right,
            border.vertical_left,
            border.vertical_right,
            border.horizontal_top,
            border.horizontal_bottom,
        ];
        for mark in marks {
            assert!(mark.is_ascii(), "{mark:?} is not ASCII");
        }
        assert!(set.rule().is_ascii() && set.divider().is_ascii());
        // The designed set keeps the arcs of the rounded border: it is the
        // default, and the ASCII border set is the fallback.
        assert!(GlyphSet::Unicode.border().is_none());
    }

    /// The fold speaks the ASCII set: every mark the interface draws as a glyph
    /// comes out of a line of hints as exactly what the ASCII set would have
    /// drawn, and text with no glyph in it is not rebuilt at all.
    #[test]
    fn the_fold_speaks_the_ascii_set() {
        let unicode = GlyphSet::Unicode;
        let ascii = GlyphSet::Ascii;
        let (filled_meter, track_meter) = unicode.meter();
        let (filled_dot, empty_dot) = unicode.dots();
        let pairs = [
            (
                unicode.state(ConnectionState::Disconnected).to_string(),
                ascii.state(ConnectionState::Disconnected).to_string(),
            ),
            (
                unicode.state(ConnectionState::Connecting).to_string(),
                ascii.state(ConnectionState::Connecting).to_string(),
            ),
            (
                unicode.state(ConnectionState::Connected).to_string(),
                ascii.state(ConnectionState::Connected).to_string(),
            ),
            (
                unicode.state(ConnectionState::Failed).to_string(),
                ascii.state(ConnectionState::Failed).to_string(),
            ),
            (unicode.dot().to_string(), ascii.dot().to_string()),
            (unicode.dot_sep().to_string(), ascii.dot_sep().to_string()),
            (unicode.cursor().to_string(), ascii.cursor().to_string()),
            (
                unicode.cursor_blank().to_string(),
                ascii.cursor_blank().to_string(),
            ),
            (unicode.prompt().to_string(), ascii.prompt().to_string()),
            (unicode.flip().to_string(), ascii.flip().to_string()),
            (unicode.caret().to_string(), ascii.caret().to_string()),
            (unicode.thumb().to_string(), ascii.thumb().to_string()),
            (
                unicode.arrows_ud().to_string(),
                ascii.arrows_ud().to_string(),
            ),
            (
                unicode.arrows_lr().to_string(),
                ascii.arrows_lr().to_string(),
            ),
            (unicode.arrow_up().to_string(), ascii.arrow_up().to_string()),
            (
                unicode.arrow_down().to_string(),
                ascii.arrow_down().to_string(),
            ),
            (unicode.rule().to_string(), ascii.rule().to_string()),
            (unicode.divider().to_string(), ascii.divider().to_string()),
            (unicode.dash().to_string(), ascii.dash().to_string()),
            (
                unicode.warn_mark().to_string(),
                ascii.warn_mark().to_string(),
            ),
            (filled_meter.to_string(), ascii.meter().0.to_string()),
            (track_meter.to_string(), ascii.meter().1.to_string()),
            (filled_dot.to_string(), ascii.dots().0.to_string()),
            (empty_dot.to_string(), ascii.dots().1.to_string()),
        ];
        for (glyphs, expected) in pairs {
            assert_eq!(fold(&glyphs, ascii), expected, "{glyphs:?}");
        }
        // A line of hints folds whole, in either language, and text that has no
        // glyph in it is handed back untouched.
        assert_eq!(fold("↑↓ 选择 · Enter 执行", ascii), "^v 选择 . Enter 执行");
        assert_eq!(
            fold("↑↓ scroll · Esc close", ascii),
            "^v scroll . Esc close"
        );
        assert_eq!(fold("Connection…", ascii), "Connection...");
        assert_eq!(fold("no glyphs here", ascii), "no glyphs here");
        assert!(matches!(fold("no glyphs here", ascii), Cow::Borrowed(_)));
        assert!(
            matches!(fold("○ ● ◆ ─", unicode), Cow::Borrowed(_)),
            "the design's own set folds nothing"
        );
    }

    /// Sixteen colours: every role keeps its family — an accent its hue, a
    /// surface its place in the ladder, text the readable ink — and the
    /// device's own palette is left alone.
    #[test]
    fn the_sixteen_keeps_each_role_in_its_family() {
        // What each theme's live colour comes to in sixteen colours: green for
        // the emeralds, the olive for Gruvbox and the teal for Solarized — the
        // hues those palettes actually are. A change here is a design change,
        // and this is where it gets said out loud.
        let live = [
            (crate::theme::ThemeChoice::Dark, "green"),
            (crate::theme::ThemeChoice::Light, "green"),
            (crate::theme::ThemeChoice::Nord, "green"),
            (crate::theme::ThemeChoice::Gruvbox, "yellow"),
            (crate::theme::ThemeChoice::Solarized, "cyan"),
            (crate::theme::ThemeChoice::Dracula, "green"),
        ];
        for choice in crate::theme::THEMES {
            let theme = sixteen(choice);
            let wanted = live
                .iter()
                .find(|(named, _)| *named == choice)
                .map(|(_, family)| *family)
                .expect("every theme is in the table above");
            assert_eq!(family(theme.accent), wanted, "{choice:?}: the live colour");
            assert_eq!(
                family(theme.accent_strong),
                wanted,
                "{choice:?}: the bright accent stays in the accent's family"
            );
            assert_eq!(family(theme.danger), "red", "{choice:?}: danger");
            assert_eq!(family(theme.warn), "yellow", "{choice:?}: a warning");
            // Focus is a hue of its own, and never the accent's: the two are
            // the window with the keyboard and the thing that is live.
            assert_ne!(family(theme.focus), "grey", "{choice:?}: focus is a hue");
            assert_ne!(
                family(theme.focus),
                wanted,
                "{choice:?}: focus and the live colour"
            );
            assert_eq!(family(theme.text), "grey", "{choice:?}: text is ink");
            for surface in [
                theme.bg,
                theme.panel,
                theme.panel_2,
                theme.panel_3,
                theme.muted,
                theme.terminal_bg,
            ] {
                assert_eq!(
                    family(surface),
                    "grey",
                    "{choice:?}: {surface:?} is a surface"
                );
            }
            // Text is never its own ground, whatever the terminal can show.
            assert_ne!(theme.text, theme.bg, "{choice:?}: text and ground");
            // The device's own sixteen are untouched: that palette is the
            // pane's, not the chrome's.
            let designed = crate::theme::Theme::for_choice(choice);
            assert_eq!(theme.ansi, designed.ansi, "{choice:?}");
            // And a full-capability terminal gets the design itself.
            assert_eq!(designed.with_capability(Capability::FULL), designed);
        }
    }

    /// A frame has to be visible on the surface it encloses: at sixteen
    /// colours the resting border is lifted off its own panel, and the focused
    /// window's border is never dimmer than the resting one.
    #[test]
    fn the_borders_stay_off_the_surfaces_they_are_drawn_on() {
        let ladder = |color: Color| {
            GREYS
                .iter()
                .position(|grey| *grey == color)
                .expect("a border is one of the greys")
        };
        for choice in crate::theme::THEMES {
            let theme = sixteen(choice);
            assert_ne!(
                theme.line, theme.panel,
                "{choice:?}: the frame is its own ground"
            );
            assert_ne!(
                theme.line_strong, theme.panel,
                "{choice:?}: the focused frame is its own ground"
            );
            let dark = match crate::theme::Theme::for_choice(choice).bg {
                Color::Rgb(red, green, blue) => lightness(red, green, blue) < 0.5,
                _ => true,
            };
            if dark {
                assert!(
                    ladder(theme.line_strong) >= ladder(theme.line),
                    "{choice:?}: the focused border is dimmer than the resting one"
                );
            } else {
                assert!(
                    ladder(theme.line_strong) <= ladder(theme.line),
                    "{choice:?}: the focused border is lighter than the resting one"
                );
            }
        }
    }

    /// The 256 palette is the cube and the grey ramp; a grey must land on a
    /// grey, which is the mistake a cube-only search makes.
    #[test]
    fn the_nearest_256_finds_the_greys() {
        assert_eq!(rgb_to_256(0, 0, 0), 16);
        assert_eq!(rgb_to_256(255, 255, 255), 231);
        // The exact cube levels are the cube entries.
        assert_eq!(rgb_to_256(95, 95, 95), 16 + 36 + 6 + 1);
        assert_eq!(rgb_to_256(255, 0, 0), 196);
        // The grey ramp: entry 232 is 8, and each step adds ten.
        assert_eq!(rgb_to_256(128, 128, 128), 232 + 12);
        // Near a grey but slightly warm: still a grey, rather than a cube
        // colour with a hue the token does not have.
        let warm = rgb_to_256(130, 128, 126);
        assert!((232..=255).contains(&warm), "{warm} is not the grey ramp");
        // Every colour a quantised theme names is inside the 256-palette
        // proper: the first sixteen are the terminal's own.
        for choice in crate::theme::THEMES {
            let theme = crate::theme::Theme::for_choice(choice).with_capability(Capability {
                color: ColorCap::Color256,
                glyphs: GlyphSet::Unicode,
            });
            for color in [theme.bg, theme.panel, theme.line, theme.text, theme.accent] {
                match color {
                    Color::Indexed(index) => assert!(index >= 16, "{index} is not 256-palette"),
                    other => panic!("{other:?} is not indexed"),
                }
            }
            // The greys stay apart, which is why the ramp is searched at all.
            assert_ne!(theme.bg, theme.panel, "{choice:?}");
        }
    }

    /// Mono is the terminal's own ink: every role resets, so the frame is
    /// drawn in whatever the terminal shows, and a selection is still visible
    /// because the theme's styles fall back on reverse.
    #[test]
    fn mono_resets_every_role_and_keeps_a_selection_visible() {
        let mono = crate::theme::Theme::DARK.with_capability(Capability {
            color: ColorCap::Mono,
            glyphs: GlyphSet::Unicode,
        });
        for color in [
            mono.bg,
            mono.panel,
            mono.line,
            mono.text,
            mono.muted,
            mono.accent,
            mono.danger,
            mono.warn,
        ] {
            assert_eq!(color, Color::Reset);
        }
        assert!(
            mono.selected()
                .add_modifier
                .contains(ratatui::style::Modifier::REVERSED),
            "a selected row must still be findable"
        );
        assert_eq!(mono.capability().color, ColorCap::Mono);
        // The device's palette is still the device's: the pane passes its
        // colours through whatever the chrome has to do.
        assert_eq!(mono.ansi, crate::theme::Theme::DARK.ansi);
    }

    /// The `FULL` default keeps everything the design asks for, so the tests
    /// and a machine with nothing to go on paint the same frame.
    #[test]
    fn full_is_the_design() {
        assert_eq!(Capability::FULL.color, ColorCap::TrueColor);
        assert_eq!(Capability::FULL.glyphs, GlyphSet::Unicode);
    }
}
