//! The byte sequences a keystroke sends to the device (`web/terminal_keys.js`).
//!
//! These are the wire bytes the web's accessory bar produces, carried over so
//! the terminal pane and any future accessory bar send identical sequences. A
//! composition or paste is multi-character and is never rewritten; only a
//! single ASCII keystroke gets control folding and modifier prefixes.

/// Modifier state for a keystroke.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KeyModifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
}

/// Fold a single control character the way a terminal does: `a`..`z` uppercase,
/// space becomes NUL, `?` becomes DEL, and `@`..`_` get their high bit cleared.
///
/// Returns the input unchanged when it is not a single character.
pub fn control_input(data: &str) -> String {
    let mut chars = data.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return data.to_string(),
    };
    if chars.next().is_some() {
        return data.to_string();
    }
    let mut code = first as u32;
    if (0x61..=0x7a).contains(&code) {
        code -= 0x20;
    } else if first == ' ' {
        return "\u{0}".to_string();
    } else if first == '?' {
        return "\u{7f}".to_string();
    }
    if (0x40..=0x5f).contains(&code) {
        char::from_u32(code & 0x1f)
            .map(|c| c.to_string())
            .unwrap_or_else(|| data.to_string())
    } else {
        data.to_string()
    }
}

/// Apply shift, ctrl and alt to a single ASCII keystroke. Multi-character text
/// (composition, paste) and non-ASCII is returned unchanged.
pub fn apply_input_modifiers(data: &str, modifiers: &KeyModifiers) -> String {
    let mut chars = data.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return data.to_string(),
    };
    if chars.next().is_some() || (first as u32) > 0x7f {
        return data.to_string();
    }
    let mut out = data.to_string();
    if modifiers.shift {
        const NORMAL: &str = "`1234567890-=[]\\;',./";
        const SHIFTED: &str = "~!@#$%^&*()_+{}|:\"<>?";
        if let Some(index) = NORMAL.find(first) {
            out = SHIFTED.chars().nth(index).unwrap().to_string();
        } else {
            out = first.to_ascii_uppercase().to_string();
        }
    }
    if modifiers.ctrl {
        out = control_input(&out);
    }
    if modifiers.alt {
        out = format!("\u{1b}{out}");
    }
    out
}

/// How the Enter key reaches the device.
///
/// `Raw` sends the byte the key produces and nothing else, which is right for
/// a shell that has already told the line discipline what it wants. A target
/// that wants a bare `\r`, or the pair, is a target whose prompt otherwise
/// never comes back — so this is a fact about the wire rather than a
/// preference, and the reference client offers the same four.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EnterMode {
    #[default]
    Raw,
    Cr,
    Lf,
    Crlf,
}

impl EnterMode {
    /// The mode a command line names, or `None` so the caller can report the
    /// bad value instead of quietly sending the wrong byte.
    pub fn from_name(name: &str) -> Option<EnterMode> {
        match name.trim().to_ascii_lowercase().as_str() {
            "raw" => Some(EnterMode::Raw),
            "cr" => Some(EnterMode::Cr),
            "lf" => Some(EnterMode::Lf),
            "crlf" => Some(EnterMode::Crlf),
            _ => None,
        }
    }

    /// The bytes Enter becomes. `None` means "leave the key alone", because
    /// raw is not a translation — it is the absence of one, and inventing a
    /// byte for it would change what a modified Enter (Ctrl+Enter) sends.
    pub fn bytes(self) -> Option<&'static str> {
        match self {
            EnterMode::Raw => None,
            EnterMode::Cr => Some("\r"),
            EnterMode::Lf => Some("\n"),
            EnterMode::Crlf => Some("\r\n"),
        }
    }

    /// The name the command line and the settings file spell it. The round
    /// partner of [`EnterMode::from_name`].
    pub fn as_name(self) -> &'static str {
        match self {
            EnterMode::Raw => "raw",
            EnterMode::Cr => "cr",
            EnterMode::Lf => "lf",
            EnterMode::Crlf => "crlf",
        }
    }

    /// The short label the palette shows. Four words in every language,
    /// because they are wire words rather than prose.
    pub fn label(self) -> &'static str {
        match self {
            EnterMode::Raw => "Raw",
            EnterMode::Cr => "CR",
            EnterMode::Lf => "LF",
            EnterMode::Crlf => "CRLF",
        }
    }

    /// The next mode in the cycle, in the order the palette walks them: raw
    /// first, because it is the absence of a translation rather than one of
    /// the three.
    pub fn next(self) -> EnterMode {
        match self {
            EnterMode::Raw => EnterMode::Cr,
            EnterMode::Cr => EnterMode::Lf,
            EnterMode::Lf => EnterMode::Crlf,
            EnterMode::Crlf => EnterMode::Raw,
        }
    }

    /// Spell a block's newlines the way this mode asks.
    ///
    /// A block — a paste, a preset — is as much a thing the wire sees as the
    /// Enter key that follows it, so its own newlines are endings too. `Raw`
    /// is the identity: the block is what it is, and only the key carries the
    /// mode.
    pub fn spell(self, text: &str) -> String {
        match self.bytes() {
            Some(ending) => text.replace('\n', ending),
            None => text.to_string(),
        }
    }
}

/// The byte sequence for a named key, with optional application-cursor mode and
/// modifiers. `key` is the browser `KeyboardEvent.key` spelling (`ArrowUp`,
/// `Tab`, `Enter`, `Backspace`, …).
pub fn terminal_key_sequence(
    key: &str,
    application_cursor_keys: bool,
    modifiers: &KeyModifiers,
) -> String {
    let modifier =
        1 + modifiers.shift as u8 + (modifiers.alt as u8) * 2 + (modifiers.ctrl as u8) * 4;
    if matches!(
        key,
        "ArrowUp" | "ArrowDown" | "ArrowRight" | "ArrowLeft" | "Home" | "End"
    ) {
        let code = match key {
            "ArrowUp" => "A",
            "ArrowDown" => "B",
            "ArrowRight" => "C",
            "ArrowLeft" => "D",
            "Home" => "H",
            _ => "F",
        };
        if modifier > 1 {
            return format!("\u{1b}[1;{modifier}{code}");
        }
        let bracket = if application_cursor_keys { "O" } else { "[" };
        return format!("\u{1b}{bracket}{code}");
    }
    if let Some(rest) = key.strip_prefix("Ctrl-") {
        if rest.len() == 1 && rest.chars().all(|c| c.is_ascii_uppercase()) {
            return control_input(rest);
        }
    }
    if key.len() == 1 && "/|~\\`-".contains(key) {
        return apply_input_modifiers(key, modifiers);
    }
    if key == "Tab" && modifiers.shift {
        return "\u{1b}[Z".to_string();
    }
    let tilde: Option<u8> = match key {
        "Delete" => Some(3),
        "PageUp" => Some(5),
        "PageDown" => Some(6),
        _ => None,
    };
    if let Some(n) = tilde {
        if modifier > 1 {
            return format!("\u{1b}[{n};{modifier}~");
        }
    }
    let base = match key {
        "Tab" => "\t",
        "Escape" => "\u{1b}",
        "Enter" => "\r",
        "Backspace" => "\u{7f}",
        "Delete" => "\u{1b}[3~",
        "PageUp" => "\u{1b}[5~",
        "PageDown" => "\u{1b}[6~",
        _ => "",
    };
    apply_input_modifiers(base, modifiers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_folding_matches_the_web() {
        assert_eq!(control_input("a"), "\u{1}");
        assert_eq!(control_input("A"), "\u{1}");
        assert_eq!(control_input("c"), "\u{3}");
        assert_eq!(control_input(" "), "\u{0}");
        assert_eq!(control_input("?"), "\u{7f}");
        assert_eq!(control_input("@"), "\u{0}");
        assert_eq!(control_input("["), "\u{1b}");
        assert_eq!(control_input("ab"), "ab", "multi-char is untouched");
    }

    #[test]
    fn modifiers_shift_and_alt() {
        let none = KeyModifiers::default();
        assert_eq!(
            apply_input_modifiers(
                "a",
                &KeyModifiers {
                    shift: true,
                    ..none
                }
            ),
            "A"
        );
        assert_eq!(
            apply_input_modifiers(
                "1",
                &KeyModifiers {
                    shift: true,
                    ..none
                }
            ),
            "!"
        );
        assert_eq!(
            apply_input_modifiers("c", &KeyModifiers { ctrl: true, ..none }),
            "\u{3}"
        );
        assert_eq!(
            apply_input_modifiers("x", &KeyModifiers { alt: true, ..none }),
            "\u{1b}x"
        );
        assert_eq!(
            apply_input_modifiers("中文", &none),
            "中文",
            "non-ASCII untouched"
        );
        assert_eq!(
            apply_input_modifiers("paste", &none),
            "paste",
            "multi-char untouched"
        );
    }

    #[test]
    fn cursor_keys_respect_application_mode() {
        let none = KeyModifiers::default();
        assert_eq!(terminal_key_sequence("ArrowUp", false, &none), "\u{1b}[A");
        assert_eq!(terminal_key_sequence("ArrowUp", true, &none), "\u{1b}OA");
        assert_eq!(terminal_key_sequence("ArrowLeft", false, &none), "\u{1b}[D");
        assert_eq!(terminal_key_sequence("Home", false, &none), "\u{1b}[H");
        // With a modifier, the extended form is used regardless of cursor mode.
        assert_eq!(
            terminal_key_sequence(
                "ArrowUp",
                false,
                &KeyModifiers {
                    shift: true,
                    ..none
                }
            ),
            "\u{1b}[1;2A"
        );
    }

    #[test]
    fn named_keys_map_to_wire_sequences() {
        let none = KeyModifiers::default();
        assert_eq!(terminal_key_sequence("Tab", false, &none), "\t");
        assert_eq!(terminal_key_sequence("Escape", false, &none), "\u{1b}");
        assert_eq!(terminal_key_sequence("Enter", false, &none), "\r");
        assert_eq!(terminal_key_sequence("Backspace", false, &none), "\u{7f}");
        assert_eq!(terminal_key_sequence("Delete", false, &none), "\u{1b}[3~");
        assert_eq!(terminal_key_sequence("PageDown", false, &none), "\u{1b}[6~");
        assert_eq!(
            terminal_key_sequence(
                "Tab",
                false,
                &KeyModifiers {
                    shift: true,
                    ..none
                }
            ),
            "\u{1b}[Z"
        );
        assert_eq!(terminal_key_sequence("Ctrl-C", false, &none), "\u{3}");
    }

    #[test]
    fn unknown_keys_send_nothing() {
        let none = KeyModifiers::default();
        assert_eq!(terminal_key_sequence("F1", false, &none), "");
    }

    /// The cycle, the names and the labels are the same four the reference
    /// client offers, and the round trip back to a name is exact — the
    /// settings file a user hand-edits is spelled in these words.
    #[test]
    fn the_enter_modes_cycle_and_spell_themselves() {
        let mut mode = EnterMode::default();
        assert_eq!(mode, EnterMode::Raw, "raw is the default");
        let mut seen = Vec::new();
        for _ in 0..4 {
            seen.push(mode.label());
            assert_eq!(EnterMode::from_name(mode.as_name()), Some(mode));
            mode = mode.next();
        }
        assert_eq!(seen, vec!["Raw", "CR", "LF", "CRLF"]);
        assert_eq!(mode, EnterMode::Raw, "four steps land where they started");
        assert_eq!(EnterMode::from_name("  CRLF "), Some(EnterMode::Crlf));
        assert_eq!(EnterMode::from_name("cr-lf"), None);
    }

    /// Spelling a block: the three named endings replace every newline in it,
    /// and `Raw` sends the block as it is — it names no ending to replace one
    /// with.
    #[test]
    fn a_block_is_spelled_the_way_the_mode_asks() {
        assert_eq!(EnterMode::Raw.spell("a\nb"), "a\nb");
        assert_eq!(EnterMode::Cr.spell("a\nb"), "a\rb");
        assert_eq!(EnterMode::Lf.spell("a\nb"), "a\nb");
        assert_eq!(EnterMode::Crlf.spell("a\nb"), "a\r\nb");
        assert_eq!(EnterMode::Raw.spell("one line"), "one line");
    }
}
