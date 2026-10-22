//! Visual theme: every colour and piece of chrome the TUI paints, in one place.
//!
//! The tokens are the web client's design system (`web/style.css`) carried over
//! to ratatui true colour, so the terminal and the browser stay the same
//! product: near-black ground, panel surfaces, one green accent for everything
//! live, blue for focus, red for danger, amber for warnings. A view never asks
//! "is this the light theme?" — it asks for a *role* (accent, muted, danger…)
//! and gets the current theme's answer, which is why switching themes repaints
//! every surface on the next frame with no view aware of it.
//!
//! The theme is passed explicitly rather than kept in a global: render code
//! takes `&Theme`, so tests can paint either theme with no shared state and a
//! repaint can never observe a half-changed palette.
//!
//! Terminal emulators without true colour approximate the RGB values; every
//! token stays legible when they do, because each pair keeps its contrast role.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::{Block, BorderType, Borders};

use std::borrow::Cow;

use crate::capability::{self, Capability, ColorCap, GlyphSet, Role};
use crate::event::{ConnectionState, NoticeLevel};

/// Every colour the interface paints. Both themes carry the same roles; only
/// the values move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    /// Page ground behind every surface (`--bg`).
    pub bg: Color,
    /// Sidebar, bars and framed views (`--panel`).
    pub panel: Color,
    /// Secondary surface: table headers, the composer (`--panel-2`).
    pub panel_2: Color,
    /// Selected rows, toasts (`--panel-3`).
    pub panel_3: Color,
    /// Primary text (`--text`).
    pub text: Color,
    /// Secondary text: hints, separators, counters (`--muted`).
    pub muted: Color,
    /// Resting borders and separators (`--line`).
    pub line: Color,
    /// Borders of the window that has the keyboard (`--line-strong`).
    pub line_strong: Color,
    /// The one live colour: selection, connect, ready (`--accent`).
    pub accent: Color,
    /// Bright accent: the connected dot, bright markers (`--accent-strong`).
    pub accent_strong: Color,
    /// Text on an accent fill (`--accent-ink`).
    pub accent_ink: Color,
    /// Keyboard focus: labels, prompts, the caret (`--focus`).
    pub focus: Color,
    /// Errors and destructive actions (`--danger`).
    pub danger: Color,
    /// Warnings and the connecting state (the web amber family).
    pub warn: Color,
    /// The serial terminal's own ground, as xterm.js paints it (`--terminal`).
    pub terminal_bg: Color,
    /// The serial terminal's default foreground (xterm theme `fg`).
    pub terminal_fg: Color,
    /// The sixteen ANSI colours a device's output can name.
    ///
    /// These are the palette the browser's xterm.js instance resolves to, so a
    /// red error in the pane is the same red in both clients. The web client
    /// only overrides a handful of xterm's defaults and leaves the rest; the
    /// one it *does* override, `brightBlack`, is the one carried here — it is
    /// what a great many tools paint their comments and separators in.
    pub ansi: [Color; 16],
    /// What the terminal this frame is painted for can draw.
    ///
    /// Carried on the theme because the theme is the one thing every view
    /// already has: a mark is asked for the way a colour is, and a style whose
    /// distinction the colours can no longer make — a selected row under
    /// [`ColorCap::Mono`] — takes it from an attribute here rather than in
    /// every view. Set through [`Theme::with_capability`], which also resolves
    /// the colours it applies to.
    capability: Capability,
}

impl Theme {
    /// The web client's `:root` — the default, and the one the browser shows.
    pub const DARK: Theme = Theme {
        bg: Color::Rgb(0x09, 0x0d, 0x14),
        panel: Color::Rgb(0x11, 0x16, 0x1f),
        panel_2: Color::Rgb(0x15, 0x1b, 0x26),
        panel_3: Color::Rgb(0x1c, 0x23, 0x30),
        text: Color::Rgb(0xe8, 0xee, 0xf7),
        muted: Color::Rgb(0x8d, 0x9b, 0xb0),
        line: Color::Rgb(0x24, 0x2d, 0x3d),
        line_strong: Color::Rgb(0x33, 0x40, 0x5a),
        accent: Color::Rgb(0x3f, 0xc8, 0x8a),
        accent_strong: Color::Rgb(0x6f, 0xe0, 0xab),
        accent_ink: Color::Rgb(0x05, 0x25, 0x17),
        focus: Color::Rgb(0x7a, 0xa8, 0xf8),
        danger: Color::Rgb(0xf2, 0x77, 0x7c),
        warn: Color::Rgb(0xf2, 0xc9, 0x4c),
        terminal_bg: Color::Rgb(0x05, 0x08, 0x0d),
        terminal_fg: Color::Rgb(0xd8, 0xf3, 0xdc),
        ansi: [
            Color::Rgb(0x2e, 0x34, 0x36),
            Color::Rgb(0xcc, 0x00, 0x00),
            Color::Rgb(0x4e, 0x9a, 0x06),
            Color::Rgb(0xc4, 0xa0, 0x00),
            Color::Rgb(0x34, 0x65, 0xa4),
            Color::Rgb(0x75, 0x50, 0x7b),
            Color::Rgb(0x06, 0x98, 0x9a),
            Color::Rgb(0xd3, 0xd7, 0xcf),
            Color::Rgb(0x8d, 0x9b, 0xb0),
            Color::Rgb(0xef, 0x29, 0x29),
            Color::Rgb(0x8a, 0xe2, 0x34),
            Color::Rgb(0xfc, 0xe9, 0x4f),
            Color::Rgb(0x72, 0x9f, 0xcf),
            Color::Rgb(0xad, 0x7f, 0xa8),
            Color::Rgb(0x34, 0xe2, 0xe2),
            Color::Rgb(0xee, 0xee, 0xec),
        ],
        // What the terminal can draw: replaced by
        // [`Theme::with_capability`] at start-up. The
        // constants themselves are the full design.
        capability: Capability::FULL,
    };

    /// The web client's `[data-theme="light"]`. The terminal pair is the
    /// xterm.js `XTERM_LIGHT` theme, so the serial pane follows the chrome the
    /// way the browser's xterm instance does.
    pub const LIGHT: Theme = Theme {
        bg: Color::Rgb(0xee, 0xf2, 0xf7),
        panel: Color::Rgb(0xff, 0xff, 0xff),
        panel_2: Color::Rgb(0xf6, 0xf8, 0xfb),
        panel_3: Color::Rgb(0xe9, 0xee, 0xf5),
        text: Color::Rgb(0x0f, 0x1c, 0x2e),
        muted: Color::Rgb(0x5c, 0x6a, 0x82),
        line: Color::Rgb(0xdb, 0xe3, 0xee),
        line_strong: Color::Rgb(0xc3, 0xcf, 0xdf),
        accent: Color::Rgb(0x1f, 0x9d, 0x64),
        accent_strong: Color::Rgb(0x15, 0x7a, 0x4c),
        accent_ink: Color::Rgb(0xff, 0xff, 0xff),
        focus: Color::Rgb(0x3b, 0x82, 0xf6),
        danger: Color::Rgb(0xdc, 0x34, 0x34),
        // The web ships no `--warn`: toasts borrow the amber family. On a light
        // ground the dark amber is the one that keeps its contrast role.
        warn: Color::Rgb(0xb4, 0x53, 0x09),
        terminal_bg: Color::Rgb(0xf8, 0xfa, 0xfc),
        terminal_fg: Color::Rgb(0x1f, 0x6b, 0x43),
        // The same sixteen, with the light theme's own `brightBlack`. The rest
        // stay put because the browser's light terminal keeps them: changing
        // them here would make the pane disagree with xterm.js next to it.
        ansi: [
            Color::Rgb(0x2e, 0x34, 0x36),
            Color::Rgb(0xcc, 0x00, 0x00),
            Color::Rgb(0x4e, 0x9a, 0x06),
            Color::Rgb(0xc4, 0xa0, 0x00),
            Color::Rgb(0x34, 0x65, 0xa4),
            Color::Rgb(0x75, 0x50, 0x7b),
            Color::Rgb(0x06, 0x98, 0x9a),
            Color::Rgb(0xd3, 0xd7, 0xcf),
            Color::Rgb(0x5c, 0x6a, 0x82),
            Color::Rgb(0xef, 0x29, 0x29),
            Color::Rgb(0x8a, 0xe2, 0x34),
            Color::Rgb(0xfc, 0xe9, 0x4f),
            Color::Rgb(0x72, 0x9f, 0xcf),
            Color::Rgb(0xad, 0x7f, 0xa8),
            Color::Rgb(0x34, 0xe2, 0xe2),
            Color::Rgb(0xee, 0xee, 0xec),
        ],
        // What the terminal can draw: replaced by
        // [`Theme::with_capability`] at start-up. The
        // constants themselves are the full design.
        capability: Capability::FULL,
    };

    /// The constants of the user's terminal classics, carried in as *roles*:
    /// the same green-live/blue-focus/red-danger grammar as the web pair, with
    /// each palette's own values. The terminal's sixteen are the palettes the
    /// projects ship for xterm, so a device's own colours stay in character.
    pub const NORD: Theme = Theme {
        bg: Color::Rgb(0x2e, 0x34, 0x40),
        panel: Color::Rgb(0x3b, 0x42, 0x52),
        panel_2: Color::Rgb(0x40, 0x48, 0x59),
        panel_3: Color::Rgb(0x4c, 0x56, 0x6a),
        text: Color::Rgb(0xec, 0xef, 0xf4),
        muted: Color::Rgb(0x8b, 0x95, 0xa9),
        line: Color::Rgb(0x43, 0x4c, 0x5e),
        line_strong: Color::Rgb(0x5a, 0x66, 0x7d),
        accent: Color::Rgb(0xa3, 0xbe, 0x8c),
        accent_strong: Color::Rgb(0xbc, 0xd3, 0xa6),
        accent_ink: Color::Rgb(0x2e, 0x34, 0x40),
        focus: Color::Rgb(0x88, 0xc0, 0xd0),
        danger: Color::Rgb(0xbf, 0x61, 0x6a),
        warn: Color::Rgb(0xeb, 0xcb, 0x8b),
        terminal_bg: Color::Rgb(0x24, 0x29, 0x33),
        terminal_fg: Color::Rgb(0xd8, 0xde, 0xe9),
        ansi: [
            Color::Rgb(0x3b, 0x42, 0x52),
            Color::Rgb(0xbf, 0x61, 0x6a),
            Color::Rgb(0xa3, 0xbe, 0x8c),
            Color::Rgb(0xeb, 0xcb, 0x8b),
            Color::Rgb(0x81, 0xa1, 0xc1),
            Color::Rgb(0xb4, 0x8e, 0xad),
            Color::Rgb(0x88, 0xc0, 0xd0),
            Color::Rgb(0xe5, 0xe9, 0xf0),
            Color::Rgb(0x4c, 0x56, 0x6a),
            Color::Rgb(0xbf, 0x61, 0x6a),
            Color::Rgb(0xa3, 0xbe, 0x8c),
            Color::Rgb(0xeb, 0xcb, 0x8b),
            Color::Rgb(0x81, 0xa1, 0xc1),
            Color::Rgb(0xb4, 0x8e, 0xad),
            Color::Rgb(0x8f, 0xbc, 0xbb),
            Color::Rgb(0xec, 0xef, 0xf4),
        ],
        // What the terminal can draw: replaced by
        // [`Theme::with_capability`] at start-up. The
        // constants themselves are the full design.
        capability: Capability::FULL,
    };

    /// Warm and low-contrast, the way the Gruvbox project keeps it: the lime
    /// green is the live colour and the aqua the focus, over four browns.
    pub const GRUVBOX: Theme = Theme {
        bg: Color::Rgb(0x28, 0x28, 0x28),
        panel: Color::Rgb(0x32, 0x30, 0x2f),
        panel_2: Color::Rgb(0x3c, 0x38, 0x36),
        panel_3: Color::Rgb(0x50, 0x49, 0x45),
        text: Color::Rgb(0xeb, 0xdb, 0xb2),
        muted: Color::Rgb(0xa8, 0x99, 0x84),
        line: Color::Rgb(0x3c, 0x38, 0x36),
        line_strong: Color::Rgb(0x50, 0x49, 0x45),
        accent: Color::Rgb(0xb8, 0xbb, 0x26),
        accent_strong: Color::Rgb(0xd0, 0xd3, 0x4a),
        accent_ink: Color::Rgb(0x28, 0x28, 0x28),
        focus: Color::Rgb(0x83, 0xa5, 0x98),
        danger: Color::Rgb(0xfb, 0x49, 0x34),
        warn: Color::Rgb(0xfa, 0xbd, 0x2f),
        terminal_bg: Color::Rgb(0x1d, 0x20, 0x21),
        terminal_fg: Color::Rgb(0xeb, 0xdb, 0xb2),
        ansi: [
            Color::Rgb(0x28, 0x28, 0x28),
            Color::Rgb(0xcc, 0x24, 0x1d),
            Color::Rgb(0x98, 0x97, 0x1a),
            Color::Rgb(0xd7, 0x99, 0x21),
            Color::Rgb(0x45, 0x85, 0x88),
            Color::Rgb(0xb1, 0x62, 0x86),
            Color::Rgb(0x68, 0x9d, 0x6a),
            Color::Rgb(0xa8, 0x99, 0x84),
            Color::Rgb(0x92, 0x83, 0x74),
            Color::Rgb(0xfb, 0x49, 0x34),
            Color::Rgb(0xb8, 0xbb, 0x26),
            Color::Rgb(0xfa, 0xbd, 0x2f),
            Color::Rgb(0x83, 0xa5, 0x98),
            Color::Rgb(0xd3, 0x86, 0x9b),
            Color::Rgb(0x8e, 0xc0, 0x7c),
            Color::Rgb(0xeb, 0xdb, 0xb2),
        ],
        // What the terminal can draw: replaced by
        // [`Theme::with_capability`] at start-up. The
        // constants themselves are the full design.
        capability: Capability::FULL,
    };

    /// The Solarized dark set: one neutral ramp, one accent per meaning. The
    /// terminal's sixteen are exactly Solarized's own.
    pub const SOLARIZED: Theme = Theme {
        bg: Color::Rgb(0x00, 0x2b, 0x36),
        panel: Color::Rgb(0x07, 0x36, 0x42),
        panel_2: Color::Rgb(0x08, 0x40, 0x4f),
        panel_3: Color::Rgb(0x0e, 0x4c, 0x5c),
        text: Color::Rgb(0x93, 0xa1, 0xa1),
        muted: Color::Rgb(0x58, 0x6e, 0x75),
        line: Color::Rgb(0x0d, 0x46, 0x54),
        line_strong: Color::Rgb(0x1c, 0x5b, 0x68),
        accent: Color::Rgb(0x2a, 0xa1, 0x98),
        accent_strong: Color::Rgb(0x4c, 0xc4, 0xb8),
        accent_ink: Color::Rgb(0x00, 0x2b, 0x36),
        focus: Color::Rgb(0x26, 0x8b, 0xd2),
        danger: Color::Rgb(0xdc, 0x32, 0x2f),
        warn: Color::Rgb(0xb5, 0x89, 0x00),
        terminal_bg: Color::Rgb(0x00, 0x1f, 0x28),
        terminal_fg: Color::Rgb(0x93, 0xa1, 0xa1),
        ansi: [
            Color::Rgb(0x07, 0x36, 0x42),
            Color::Rgb(0xdc, 0x32, 0x2f),
            Color::Rgb(0x85, 0x99, 0x00),
            Color::Rgb(0xb5, 0x89, 0x00),
            Color::Rgb(0x26, 0x8b, 0xd2),
            Color::Rgb(0xd3, 0x36, 0x82),
            Color::Rgb(0x2a, 0xa1, 0x98),
            Color::Rgb(0xee, 0xe8, 0xd5),
            Color::Rgb(0x00, 0x2b, 0x36),
            Color::Rgb(0xcb, 0x4b, 0x16),
            Color::Rgb(0x58, 0x6e, 0x75),
            Color::Rgb(0x65, 0x7b, 0x83),
            Color::Rgb(0x83, 0x94, 0x96),
            Color::Rgb(0x6c, 0x71, 0xc4),
            Color::Rgb(0x93, 0xa1, 0xa1),
            Color::Rgb(0xfd, 0xf6, 0xe3),
        ],
        // What the terminal can draw: replaced by
        // [`Theme::with_capability`] at start-up. The
        // constants themselves are the full design.
        capability: Capability::FULL,
    };

    /// Dracula: a violet night with the project's own neon streaks, its
    /// sixteen as the project ships them.
    pub const DRACULA: Theme = Theme {
        bg: Color::Rgb(0x28, 0x2a, 0x36),
        panel: Color::Rgb(0x34, 0x37, 0x46),
        panel_2: Color::Rgb(0x3c, 0x3f, 0x52),
        panel_3: Color::Rgb(0x44, 0x47, 0x5a),
        text: Color::Rgb(0xf8, 0xf8, 0xf2),
        muted: Color::Rgb(0x62, 0x72, 0xa4),
        line: Color::Rgb(0x3d, 0x41, 0x55),
        line_strong: Color::Rgb(0x52, 0x5a, 0x7a),
        accent: Color::Rgb(0x50, 0xfa, 0x7b),
        accent_strong: Color::Rgb(0x7c, 0xff, 0xa0),
        accent_ink: Color::Rgb(0x10, 0x32, 0x1c),
        focus: Color::Rgb(0x8b, 0xe9, 0xfd),
        danger: Color::Rgb(0xff, 0x55, 0x55),
        warn: Color::Rgb(0xff, 0xb8, 0x6c),
        terminal_bg: Color::Rgb(0x21, 0x22, 0x2c),
        terminal_fg: Color::Rgb(0xf8, 0xf8, 0xf2),
        ansi: [
            Color::Rgb(0x21, 0x22, 0x2c),
            Color::Rgb(0xff, 0x55, 0x55),
            Color::Rgb(0x50, 0xfa, 0x7b),
            Color::Rgb(0xf1, 0xfa, 0x8c),
            Color::Rgb(0xbd, 0x93, 0xf9),
            Color::Rgb(0xff, 0x79, 0xc6),
            Color::Rgb(0x8b, 0xe9, 0xfd),
            Color::Rgb(0xf8, 0xf8, 0xf2),
            Color::Rgb(0x62, 0x72, 0xa4),
            Color::Rgb(0xff, 0x6e, 0x6e),
            Color::Rgb(0x69, 0xff, 0x94),
            Color::Rgb(0xff, 0xff, 0xa5),
            Color::Rgb(0xd6, 0xac, 0xff),
            Color::Rgb(0xff, 0x92, 0xdf),
            Color::Rgb(0xa4, 0xff, 0xff),
            Color::Rgb(0xff, 0xff, 0xff),
        ],
        // What the terminal can draw: replaced by
        // [`Theme::with_capability`] at start-up. The
        // constants themselves are the full design.
        capability: Capability::FULL,
    };

    /// Resolve a 256-colour palette index.
    ///
    /// The layout is the one the palette has had since xterm and every terminal
    /// shares: sixteen named colours, then a 6×6×6 cube, then a 24-step grey
    /// ramp. Keeping the arithmetic here means the serial pane only has to know
    /// *that* the device named a colour, not how the name becomes a value.
    pub fn indexed(&self, index: u8) -> Color {
        match index {
            0..=15 => self.ansi[index as usize],
            16..=231 => {
                // 16 + 36r + 6g + b, over the cube's six levels.
                const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
                let i = index as usize - 16;
                Color::Rgb(LEVELS[(i / 36) % 6], LEVELS[(i / 6) % 6], LEVELS[i % 6])
            }
            // 232..=255: a 24-step grey ramp from 8 to 238.
            _ => {
                let level = 8 + (index as u16 - 232) * 10;
                let value = level as u8;
                Color::Rgb(value, value, value)
            }
        }
    }

    /// The theme behind [`ThemeChoice`], the enum settings persist.
    pub fn for_choice(choice: ThemeChoice) -> Theme {
        match choice {
            ThemeChoice::Dark => Theme::DARK,
            ThemeChoice::Light => Theme::LIGHT,
            ThemeChoice::Nord => Theme::NORD,
            ThemeChoice::Gruvbox => Theme::GRUVBOX,
            ThemeChoice::Dracula => Theme::DRACULA,
            ThemeChoice::Solarized => Theme::SOLARIZED,
        }
    }

    /// [`Theme::for_choice`], resolved for what the terminal can draw: what
    /// the app asks for when it paints.
    pub fn for_capability(choice: ThemeChoice, capability: Capability) -> Theme {
        Theme::for_choice(choice).with_capability(capability)
    }

    /// The same theme, told what the terminal can show.
    ///
    /// A view keeps asking for *roles* — accent, muted, danger — and gets the
    /// nearest thing the terminal has, so nothing in the interface has to know
    /// that it is running on sixteen colours. What a role resolves to is
    /// decided by what it is *for* (`crate::capability::Role`): a surface takes
    /// its place in the grey ladder, text takes the readable ink, an accent
    /// keeps its hue. Under [`ColorCap::Mono`] every role becomes the
    /// terminal's own ink and the distinctions move into the styles below.
    ///
    /// The device's own sixteen ([`Theme::ansi`]) are never resolved: the pane
    /// passes the device's colours through, and a program that asked for bright
    /// red is owed the terminal's idea of bright red, not a neighbour of this
    /// theme's palette.
    pub fn with_capability(self, capability: Capability) -> Theme {
        if capability == self.capability {
            return self;
        }
        let cap = capability.color;
        let resolve = |color: Color, role: Role| capability::resolve(color, role, cap);

        let panel = resolve(self.panel, Role::Grey);
        // The borders are greys too, then lifted off the surface they are drawn
        // on: at sixteen colours every dark theme's hairline rounds to the same
        // grey as its own panel, and a frame drawn in the colour of its ground
        // is not a frame. Higher up the palettes keep the two apart by
        // themselves; in mono both are the terminal's ink, and there the glyph
        // is the frame.
        let resting = resolve(self.line, Role::Grey);
        let (line, line_strong) = if cap == ColorCap::Color16 {
            let dark = self.is_dark();
            let resting = capability::grey_step(resting, panel, dark);
            let focused = resolve(self.line_strong, Role::Grey);
            (resting, capability::grey_step(focused, resting, dark))
        } else {
            (resting, resolve(self.line_strong, Role::Grey))
        };

        Theme {
            bg: resolve(self.bg, Role::Grey),
            panel,
            panel_2: resolve(self.panel_2, Role::Grey),
            panel_3: resolve(self.panel_3, Role::Grey),
            text: resolve(self.text, Role::Ink),
            muted: resolve(self.muted, Role::Grey),
            line,
            line_strong,
            accent: resolve(self.accent, Role::Accent),
            accent_strong: resolve(self.accent_strong, Role::Accent),
            accent_ink: resolve(self.accent_ink, Role::Ink),
            focus: resolve(self.focus, Role::Accent),
            danger: resolve(self.danger, Role::Accent),
            warn: resolve(self.warn, Role::Accent),
            terminal_bg: resolve(self.terminal_bg, Role::Grey),
            terminal_fg: resolve(self.terminal_fg, Role::Ink),
            ansi: self.ansi,
            capability,
        }
    }

    /// What this theme was resolved for.
    pub fn capability(&self) -> Capability {
        self.capability
    }

    /// The glyph set this theme draws with: the marks a view places itself are
    /// asked for here, rather than chosen by the view.
    pub fn glyphs(&self) -> GlyphSet {
        self.capability.glyphs
    }

    /// [`crate::capability::fold`], in the set this theme draws with.
    ///
    /// The interface's own lines carry marks — ` · ` between two fields, `…` at
    /// the end of a truncated title, `↑↓` in a key hint — and a terminal
    /// without those glyphs gets the stand-ins the rest of the frame draws
    /// with. What the *device* prints never goes through here: folding it would
    /// be this program editing someone else's output.
    pub fn fold<'a>(&self, text: &'a str) -> Cow<'a, str> {
        crate::capability::fold(text, self.glyphs())
    }

    /// Whether this is one of the dark themes: the direction the borders step
    /// along the grey ladder, read from the ground the design itself declares.
    fn is_dark(&self) -> bool {
        match self.bg {
            Color::Rgb(red, green, blue) => capability::lightness(red, green, blue) < 0.5,
            _ => true,
        }
    }

    /// `style`, with `fallback` added when the terminal has no colour to carry
    /// the distinction.
    ///
    /// Under [`ColorCap::Mono`] every role resolves to the terminal's own ink,
    /// so what the design says with colour has to be said with an attribute:
    /// reverse for anything selected or filled, bold for the live colour and
    /// whatever must be seen, dim for whatever must not compete.
    fn when_mono(&self, style: Style, fallback: Modifier) -> Style {
        if self.capability.color == ColorCap::Mono {
            style.add_modifier(fallback)
        } else {
            style
        }
    }

    /// `block`, framed the way this terminal draws frames: rounded where the
    /// font has the arcs, plain `+-|` where it does not.
    pub fn framed(&self, block: Block<'static>) -> Block<'static> {
        match self.glyphs().border() {
            Some(set) => block.border_set(set),
            None => block.border_type(BorderType::Rounded),
        }
    }

    // --- base styles --------------------------------------------------------

    /// Body text on any surface.
    pub fn text(&self) -> Style {
        Style::default().fg(self.text)
    }

    /// Secondary text: hints, counters, anything that must not compete.
    pub fn muted(&self) -> Style {
        self.when_mono(Style::default().fg(self.muted), Modifier::DIM)
    }

    /// The live colour, for what the user can act on right now.
    pub fn accent(&self) -> Style {
        self.when_mono(Style::default().fg(self.accent), Modifier::BOLD)
    }

    /// Bright accent, for emphasis inside accent-coloured text.
    pub fn accent_strong(&self) -> Style {
        self.when_mono(Style::default().fg(self.accent_strong), Modifier::BOLD)
    }

    /// Focus colour: labels, prompts, the caret.
    pub fn focus(&self) -> Style {
        self.when_mono(Style::default().fg(self.focus), Modifier::BOLD)
    }

    /// Errors and destructive actions.
    pub fn danger(&self) -> Style {
        self.when_mono(Style::default().fg(self.danger), Modifier::BOLD)
    }

    /// Warnings.
    pub fn warn(&self) -> Style {
        Style::default().fg(self.warn)
    }

    /// Resting borders and separators.
    pub fn line(&self) -> Style {
        self.when_mono(Style::default().fg(self.line), Modifier::DIM)
    }

    /// The scrollbar's thumb: a touch stronger than the resting hairlines,
    /// because the bar has to be findable on a ground that is not a border.
    pub fn scrollbar(&self) -> Style {
        self.when_mono(Style::default().fg(self.line_strong), Modifier::BOLD)
    }

    /// A panel surface (`--panel`), the ground bars and the sidebar sit on.
    pub fn panel(&self) -> Style {
        Style::default().bg(self.panel)
    }

    /// The serial terminal's ground (`--terminal`), darker than every panel so
    /// the pane reads as a hole the device writes into.
    pub fn terminal(&self) -> Style {
        Style::default().bg(self.terminal_bg)
    }

    /// A window's ground: one step above the panel, so a box that took the
    /// keyboard reads as raised rather than as another pane.
    ///
    /// The middle of the three surfaces every palette steps through — pane,
    /// card, field — which is what gives a dialog and the field inside it two
    /// edges to be told apart by instead of one.
    pub fn card(&self) -> Style {
        Style::default().bg(self.panel_2)
    }

    /// The selected row of a list: accent fill with the ink the web puts on
    /// primary buttons. Used for the sidebar selection, list cursors and the
    /// command palette's highlighted action.
    pub fn selected(&self) -> Style {
        self.when_mono(
            Style::default()
                .bg(self.accent)
                .fg(self.accent_ink)
                .add_modifier(Modifier::BOLD),
            Modifier::REVERSED,
        )
    }

    /// A mouse selection over painted text: the same accent ground as the
    /// sidebar's selected row, so the two highlights read as one idea. The
    /// pane `patch`es this over the device's own colours rather than replacing
    /// their style, which is what keeps bold and underline in the text the
    /// selection covers.
    pub fn selection(&self) -> Style {
        self.when_mono(
            Style::default().bg(self.accent).fg(self.accent_ink),
            Modifier::REVERSED,
        )
    }

    /// A sidebar / panel section header: the web's uppercase drawer heads.
    pub fn section_header(&self) -> Style {
        Style::default()
            .fg(self.accent)
            .add_modifier(Modifier::BOLD)
    }

    /// Notice colouring, shared by toasts, the notice log and inline notices.
    pub fn level_style(&self, level: NoticeLevel) -> Style {
        match level {
            NoticeLevel::Info => self.focus(),
            NoticeLevel::Warn => self.warn(),
            NoticeLevel::Error => self.danger(),
        }
    }

    /// The connection dot, in the web's status-dot colours: green while
    /// connected, amber while dialling, red on failure, grey at rest.
    pub fn state_dot(&self, state: ConnectionState) -> Style {
        match state {
            ConnectionState::Connected => self.accent_strong(),
            ConnectionState::Connecting => self.warn(),
            ConnectionState::Failed => self.danger(),
            ConnectionState::Disconnected => self.muted(),
        }
    }

    /// The ink a signal meter draws in, by the strength of the reading.
    ///
    /// A ladder rather than one colour, because the meter is a ranking: the
    /// accent for a link that is carrying well, amber when it is not, danger
    /// when it is nearly gone. The dim grey a meter used to be drawn in is a
    /// grey that is nearly the background in three of the six themes, which is
    /// how a meter becomes invisible in exactly the themes a user has chosen.
    fn signal_ink(&self, dbm: i32) -> Color {
        match dbm {
            -55.. => self.accent_strong,
            -65..=-56 => self.accent,
            -75..=-66 => self.warn,
            _ => self.danger,
        }
    }

    /// The style a signal meter draws in: [`Self::signal_ink`], kept readable.
    pub fn signal_style(&self, dbm: i32) -> Style {
        Style::default().fg(self.legible(self.signal_ink(dbm)))
    }

    /// `color`, unless it cannot be read on this theme's panels — then the
    /// theme's own text colour, which every theme keeps legible on its own
    /// surfaces.
    ///
    /// The promise is the one a user needs and a view cannot make: a token is
    /// either the colour the design gave it or a colour that can be read,
    /// never one that has disappeared into the surface behind it. A role the
    /// design treats as "secondary" in one theme can land within a whisker of
    /// the background in another, and this is where that stops being every
    /// view's problem.
    pub fn legible(&self, color: Color) -> Color {
        /// The WCAG large-text floor. Below this a coloured glyph is a smudge
        /// rather than a glyph; above it, dim is a style choice.
        const READABLE: f32 = 3.0;
        match contrast_ratio(color, self.panel) {
            Some(ratio) if ratio < READABLE => self.text,
            _ => color,
        }
    }

    // --- chrome -------------------------------------------------------------

    /// A framed view in the centre column: panel surface, resting border, the
    /// view's name as an accent title. The serial terminal view does not take a
    /// frame — it is the pane the device writes into.
    pub fn view_block(&self, title: impl Into<String>) -> Block<'static> {
        self.framed(
            Block::default()
                .borders(Borders::ALL)
                .border_style(self.line())
                .style(self.panel())
                .title(Span::styled(
                    format!(" {} ", title.into()),
                    self.section_header(),
                )),
        )
    }

    /// A window that took the keyboard (command palette, dialogs): the stronger
    /// border the web gives a focused surface, a ground raised a step above the
    /// pane behind it, accent title.
    pub fn overlay_block(&self, title: impl Into<String>) -> Block<'static> {
        self.framed(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(self.line_strong))
                .style(self.card())
                .title(Span::styled(
                    format!(" {} ", title.into()),
                    self.section_header(),
                )),
        )
    }

    /// A toast's border: the web outlines `.toast` with the accent and
    /// `.toast-error` with danger.
    pub fn toast_border(&self, level: NoticeLevel) -> Color {
        match level {
            NoticeLevel::Info => self.accent,
            NoticeLevel::Warn => self.warn,
            NoticeLevel::Error => self.danger,
        }
    }

    /// A toast's text: panel-3 ground, primary text. The notice's colour is
    /// carried by [`Theme::toast_border`], the way the web borders its toasts.
    pub fn toast(&self) -> Style {
        self.when_mono(
            Style::default().bg(self.panel_3).fg(self.text),
            Modifier::REVERSED,
        )
    }

    /// The status pill on the centre pane's head row: a `--panel-3` chip with
    /// primary text, so it reads as a surface laid over the pane's own ground
    /// rather than as another line of the pane.
    pub fn pill(&self) -> Style {
        self.when_mono(
            Style::default().bg(self.panel_3).fg(self.text),
            Modifier::REVERSED,
        )
    }

    /// The pill's dot: a filled circle in the state's own colour, on the pill's
    /// ground. One style for every state — the colour is what carries the
    /// state, which is how the web client paints its `.status-dot`.
    pub fn pill_dot(&self, state: ConnectionState) -> Style {
        self.state_dot(state).bg(self.panel_3)
    }
}

/// Which theme the user chose, kept as the `tui.theme` key in the settings
/// shelf. The web remembers the same choice in `localStorage["linkr-theme"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThemeChoice {
    #[default]
    Dark,
    Light,
    /// Jim Schmitz's Nord.
    Nord,
    /// Pavel Pertsev's Gruvbox.
    Gruvbox,
    /// Ethan Schoonover's Solarized, the dark set.
    Solarized,
    /// Zeno Rocha's Dracula.
    Dracula,
}

/// Every theme the interface ships, in the order the picker lists them: the
/// web's own pair first, then the terminal classics.
pub const THEMES: [ThemeChoice; 6] = [
    ThemeChoice::Dark,
    ThemeChoice::Light,
    ThemeChoice::Nord,
    ThemeChoice::Gruvbox,
    ThemeChoice::Dracula,
    ThemeChoice::Solarized,
];

impl ThemeChoice {
    /// Lowercase name, the spelling used in settings files.
    pub fn as_str(self) -> &'static str {
        match self {
            ThemeChoice::Dark => "dark",
            ThemeChoice::Light => "light",
            ThemeChoice::Nord => "nord",
            ThemeChoice::Gruvbox => "gruvbox",
            ThemeChoice::Solarized => "solarized",
            ThemeChoice::Dracula => "dracula",
        }
    }

    /// The theme a name refers to: the settings-file spelling, case and
    /// padding forgiven. Unknown names give `None`, so a caller can fall back
    /// to its own default rather than to a guess.
    pub fn from_name(raw: &str) -> Option<ThemeChoice> {
        let raw = raw.trim().to_ascii_lowercase();
        THEMES.iter().copied().find(|choice| choice.as_str() == raw)
    }

    /// Parse the settings-file spelling. Unknown values fall back to the
    /// default rather than failing a whole settings load.
    pub fn from_str_lossy(raw: &str) -> ThemeChoice {
        ThemeChoice::from_name(raw).unwrap_or_default()
    }
}

/// How much light a colour puts out, 0.0 to 1.0 — the WCAG relative luminance.
///
/// `None` for a colour this theme did not name as RGB: a terminal's own
/// `Reset`, or an ANSI index the emulator owns, cannot be judged from here and
/// is left as the caller asked for it.
fn relative_luminance(color: Color) -> Option<f32> {
    let Color::Rgb(red, green, blue) = color else {
        return None;
    };
    fn channel(value: u8) -> f32 {
        let value = f32::from(value) / 255.0;
        if value <= 0.03928 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    }
    Some(0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue))
}

/// The contrast between two colours: 1.0 for identical, 21.0 for black on
/// white. `None` when either is not an RGB colour.
pub fn contrast_ratio(first: Color, second: Color) -> Option<f32> {
    let (first, second) = (relative_luminance(first)?, relative_luminance(second)?);
    let (lighter, darker) = if first >= second {
        (first, second)
    } else {
        (second, first)
    };
    Some((lighter + 0.05) / (darker + 0.05))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every theme a user can pick paints a signal meter that can be *read*:
    /// the ink of every strength stays clear of the panel behind it. Three of
    /// the six themes keep their muted grey within a whisker of the surface,
    /// which is how the meter used to disappear in exactly the themes a user
    /// had chosen.
    #[test]
    fn every_theme_keeps_its_signal_meter_readable() {
        for choice in THEMES {
            let theme = Theme::for_choice(choice);
            for dbm in [-30, -55, -60, -70, -80, -100] {
                let Style { fg, .. } = theme.signal_style(dbm);
                let Some(ink) = fg else {
                    panic!("{choice:?} paints the meter with no colour at all");
                };
                let ratio = contrast_ratio(ink, theme.panel)
                    .unwrap_or_else(|| panic!("{choice:?} has a colour that cannot be judged"));
                assert!(
                    ratio >= 3.0,
                    "{choice:?} paints {dbm} dBm at {ratio:.2}:1 against its panel"
                );
            }
        }
    }

    /// A colour that cannot be read on the panel is not used: the theme hands
    /// back its own text colour instead, so no view has to know which of the
    /// six themes it is painting.
    #[test]
    fn a_colour_too_close_to_the_panel_falls_back_to_text() {
        let theme = Theme::NORD;
        assert_eq!(theme.legible(theme.text), theme.text, "a readable colour");
        let invisible = Color::Rgb(0x2e, 0x34, 0x40);
        let ratio = contrast_ratio(invisible, theme.panel).expect("both are RGB");
        assert!(ratio < 3.0, "the fixture is meant to be unreadable");
        assert_eq!(theme.legible(invisible), theme.text);
        // A colour this theme did not name as RGB is left alone: the terminal
        // owns how it looks, and a guess here would repaint a user's palette.
        assert_eq!(theme.legible(Color::Reset), Color::Reset);
        assert_eq!(theme.legible(Color::Indexed(4)), Color::Indexed(4));
    }

    /// The contrast helper is the WCAG one: identical colours are 1:1, black
    /// on white is 21:1, and the order of the arguments does not matter.
    #[test]
    fn contrast_is_measured_the_wcag_way() {
        let black = Color::Rgb(0, 0, 0);
        let white = Color::Rgb(255, 255, 255);
        assert_eq!(contrast_ratio(black, black), Some(1.0));
        let extremes = contrast_ratio(black, white).expect("both are RGB");
        assert!((extremes - 21.0).abs() < 0.01, "{extremes}");
        assert_eq!(contrast_ratio(black, white), contrast_ratio(white, black));
        assert_eq!(contrast_ratio(black, Color::Reset), None);
    }

    /// The dark palette is the web `:root` block, value for value.
    #[test]
    fn dark_tokens_match_the_web_root() {
        let t = Theme::DARK;
        assert_eq!(t.bg, Color::Rgb(0x09, 0x0d, 0x14));
        assert_eq!(t.panel, Color::Rgb(0x11, 0x16, 0x1f));
        assert_eq!(t.panel_2, Color::Rgb(0x15, 0x1b, 0x26));
        assert_eq!(t.panel_3, Color::Rgb(0x1c, 0x23, 0x30));
        assert_eq!(t.text, Color::Rgb(0xe8, 0xee, 0xf7));
        assert_eq!(t.muted, Color::Rgb(0x8d, 0x9b, 0xb0));
        assert_eq!(t.line, Color::Rgb(0x24, 0x2d, 0x3d));
        assert_eq!(t.line_strong, Color::Rgb(0x33, 0x40, 0x5a));
        assert_eq!(t.accent, Color::Rgb(0x3f, 0xc8, 0x8a));
        assert_eq!(t.accent_strong, Color::Rgb(0x6f, 0xe0, 0xab));
        assert_eq!(t.accent_ink, Color::Rgb(0x05, 0x25, 0x17));
        assert_eq!(t.focus, Color::Rgb(0x7a, 0xa8, 0xf8));
        assert_eq!(t.danger, Color::Rgb(0xf2, 0x77, 0x7c));
        assert_eq!(t.warn, Color::Rgb(0xf2, 0xc9, 0x4c));
        assert_eq!(t.terminal_bg, Color::Rgb(0x05, 0x08, 0x0d));
        assert_eq!(t.terminal_fg, Color::Rgb(0xd8, 0xf3, 0xdc));
    }

    /// The light palette is the web `[data-theme="light"]` block; the terminal
    /// pair is xterm.js `XTERM_LIGHT`.
    #[test]
    fn light_tokens_match_the_web_light_block() {
        let t = Theme::LIGHT;
        assert_eq!(t.bg, Color::Rgb(0xee, 0xf2, 0xf7));
        assert_eq!(t.panel, Color::Rgb(0xff, 0xff, 0xff));
        assert_eq!(t.panel_2, Color::Rgb(0xf6, 0xf8, 0xfb));
        assert_eq!(t.panel_3, Color::Rgb(0xe9, 0xee, 0xf5));
        assert_eq!(t.text, Color::Rgb(0x0f, 0x1c, 0x2e));
        assert_eq!(t.muted, Color::Rgb(0x5c, 0x6a, 0x82));
        assert_eq!(t.line, Color::Rgb(0xdb, 0xe3, 0xee));
        assert_eq!(t.line_strong, Color::Rgb(0xc3, 0xcf, 0xdf));
        assert_eq!(t.accent, Color::Rgb(0x1f, 0x9d, 0x64));
        assert_eq!(t.accent_strong, Color::Rgb(0x15, 0x7a, 0x4c));
        assert_eq!(t.accent_ink, Color::Rgb(0xff, 0xff, 0xff));
        assert_eq!(t.focus, Color::Rgb(0x3b, 0x82, 0xf6));
        assert_eq!(t.danger, Color::Rgb(0xdc, 0x34, 0x34));
        assert_eq!(t.warn, Color::Rgb(0xb4, 0x53, 0x09));
        assert_eq!(t.terminal_bg, Color::Rgb(0xf8, 0xfa, 0xfc));
        assert_eq!(t.terminal_fg, Color::Rgb(0x1f, 0x6b, 0x43));
    }

    /// The two themes never agree on a ground: a light-mode screenshot must not
    /// be able to pass as the dark one by accident.
    #[test]
    fn the_themes_disagree_on_every_ground() {
        for (dark, light) in [
            (Theme::DARK.bg, Theme::LIGHT.bg),
            (Theme::DARK.panel, Theme::LIGHT.panel),
            (Theme::DARK.panel_2, Theme::LIGHT.panel_2),
            (Theme::DARK.panel_3, Theme::LIGHT.panel_3),
            (Theme::DARK.text, Theme::LIGHT.text),
            (Theme::DARK.accent, Theme::LIGHT.accent),
            (Theme::DARK.terminal_bg, Theme::LIGHT.terminal_bg),
        ] {
            assert_ne!(dark, light);
        }
    }

    /// Roles resolve to the current theme's values, so a switch is visible to
    /// every helper with no other change.
    #[test]
    fn roles_follow_the_theme_they_are_asked_of() {
        assert_eq!(Theme::DARK.text().fg, Some(Theme::DARK.text));
        assert_eq!(Theme::LIGHT.text().fg, Some(Theme::LIGHT.text));
        assert_eq!(Theme::DARK.card().bg, Some(Theme::DARK.panel_2));
        assert_eq!(Theme::LIGHT.card().bg, Some(Theme::LIGHT.panel_2));
        assert_eq!(Theme::DARK.selected().bg, Some(Theme::DARK.accent));
        assert_eq!(Theme::DARK.selected().fg, Some(Theme::DARK.accent_ink));
        assert_eq!(Theme::LIGHT.selected().bg, Some(Theme::LIGHT.accent));
        assert_eq!(Theme::LIGHT.selected().fg, Some(Theme::LIGHT.accent_ink));
    }

    /// A card sits on a pane and a field sits in the card: three surfaces, and
    /// a palette that lets any two of them agree would draw a dialog onto the
    /// screen and its fields onto nothing.
    #[test]
    fn every_palette_steps_through_three_surfaces() {
        for choice in THEMES {
            let theme = Theme::for_choice(choice);
            assert_ne!(
                theme.panel_2, theme.panel,
                "{choice:?}: the card is the pane"
            );
            assert_ne!(
                theme.panel_3, theme.panel_2,
                "{choice:?}: the field is the card"
            );
        }
    }

    /// A selected row is always an accent fill, in both themes: that is the
    /// "primary button" look the sidebar chip copies.
    #[test]
    fn selection_is_an_accent_chip_in_both_themes() {
        for theme in [Theme::DARK, Theme::LIGHT] {
            let style = theme.selected();
            assert_eq!(style.bg, Some(theme.accent));
            assert_eq!(style.fg, Some(theme.accent_ink));
            assert!(style.add_modifier.contains(Modifier::BOLD));
        }
    }

    /// Toasts borrow the notice's colour for their border, never for the text:
    /// the text stays on a panel ground so it is readable in both themes.
    #[test]
    fn toast_borders_carry_the_notice_level() {
        for theme in [Theme::DARK, Theme::LIGHT] {
            assert_eq!(theme.toast_border(NoticeLevel::Info), theme.accent);
            assert_eq!(theme.toast_border(NoticeLevel::Warn), theme.warn);
            assert_eq!(theme.toast_border(NoticeLevel::Error), theme.danger);
            assert_eq!(theme.toast().bg, Some(theme.panel_3));
            assert_eq!(theme.toast().fg, Some(theme.text));
        }
    }

    /// The status dot maps one state to one role, in both themes.
    #[test]
    fn the_status_dot_maps_states_to_roles() {
        for theme in [Theme::DARK, Theme::LIGHT] {
            assert_eq!(
                theme.state_dot(ConnectionState::Connected).fg,
                Some(theme.accent_strong)
            );
            assert_eq!(
                theme.state_dot(ConnectionState::Connecting).fg,
                Some(theme.warn)
            );
            assert_eq!(
                theme.state_dot(ConnectionState::Failed).fg,
                Some(theme.danger)
            );
            assert_eq!(
                theme.state_dot(ConnectionState::Disconnected).fg,
                Some(theme.muted)
            );
        }
    }

    /// The theme choice round-trips through its settings spelling, and an
    /// unknown value degrades to the default instead of failing.
    #[test]
    fn theme_choice_parses() {
        assert_eq!(ThemeChoice::default(), ThemeChoice::Dark);
        for choice in THEMES {
            assert_eq!(
                ThemeChoice::from_name(choice.as_str()),
                Some(choice),
                "{choice:?} does not parse back"
            );
            assert_eq!(
                ThemeChoice::from_str_lossy(&choice.as_str().to_uppercase()),
                choice
            );
        }
        assert_eq!(ThemeChoice::from_str_lossy(" LIGHT "), ThemeChoice::Light);
        assert_eq!(ThemeChoice::from_str_lossy("nonsense"), ThemeChoice::Dark);
        assert_eq!(ThemeChoice::from_name("nonsense"), None);
    }

    /// Every choice maps to a theme, and the pair stays in step with the
    /// constants the tests above pin.
    #[test]
    fn choices_resolve_to_the_shipped_themes() {
        assert_eq!(Theme::for_choice(ThemeChoice::Dark), Theme::DARK);
        assert_eq!(Theme::for_choice(ThemeChoice::Light), Theme::LIGHT);
        assert_eq!(Theme::for_choice(ThemeChoice::Nord), Theme::NORD);
        assert_eq!(Theme::for_choice(ThemeChoice::Gruvbox), Theme::GRUVBOX);
        assert_eq!(Theme::for_choice(ThemeChoice::Solarized), Theme::SOLARIZED);
        assert_eq!(Theme::for_choice(ThemeChoice::Dracula), Theme::DRACULA);
    }

    /// Each classic palette is the one it says it is: ground and live colour
    /// pinned, so a miscopied hex is caught here and not on the user's screen.
    #[test]
    fn the_classic_themes_are_the_ones_they_say() {
        assert_eq!(Theme::NORD.bg, Color::Rgb(0x2e, 0x34, 0x40));
        assert_eq!(Theme::NORD.accent, Color::Rgb(0xa3, 0xbe, 0x8c));
        assert_eq!(Theme::GRUVBOX.bg, Color::Rgb(0x28, 0x28, 0x28));
        assert_eq!(Theme::GRUVBOX.accent, Color::Rgb(0xb8, 0xbb, 0x26));
        assert_eq!(Theme::SOLARIZED.bg, Color::Rgb(0x00, 0x2b, 0x36));
        assert_eq!(Theme::SOLARIZED.accent, Color::Rgb(0x2a, 0xa1, 0x98));
        assert_eq!(Theme::DRACULA.bg, Color::Rgb(0x28, 0x2a, 0x36));
        assert_eq!(Theme::DRACULA.accent, Color::Rgb(0x50, 0xfa, 0x7b));
    }

    /// No two themes share a ground, and no palette loses a role into its own
    /// ground: a vanished role is a bug no single screenshot catches.
    #[test]
    fn every_theme_stands_apart() {
        for (index, choice) in THEMES.iter().enumerate() {
            let theme = Theme::for_choice(*choice);
            for other in THEMES.iter().skip(index + 1) {
                let other = Theme::for_choice(*other);
                assert_ne!(theme.bg, other.bg, "{choice:?} shares a ground");
            }
            for (role, value) in [
                ("panel", theme.panel),
                ("panel_2", theme.panel_2),
                ("panel_3", theme.panel_3),
                ("muted", theme.muted),
                ("line", theme.line),
                ("accent", theme.accent),
                ("terminal_bg", theme.terminal_bg),
            ] {
                assert_ne!(value, theme.bg, "{choice:?}: {role} is the ground");
                assert_ne!(value, theme.text, "{choice:?}: {role} is the text");
            }
        }
    }
}
