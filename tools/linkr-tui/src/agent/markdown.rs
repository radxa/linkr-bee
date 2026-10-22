//! Markdown for the assistant's replies, as terminal lines.
//!
//! The web client hands its markdown to `marked` and sanitises the HTML it gets
//! back, because a browser has to parse the result. A terminal has no DOM and no
//! parser: what a model writes has to become `Line`s, and the only thing that
//! can go wrong is a line wider than the pane — which wraps, and shifts
//! everything under it, and looks exactly like an emulator bug.
//!
//! So this is a line-oriented renderer with one rule the tests enforce: nothing
//! it returns is ever wider than the width it was given. [`clip_line`] is where
//! that is decided, and it is column-aware rather than character-aware because a
//! CJK glyph is two columns and cutting between its halves is the one thing a
//! terminal cannot draw.
//!
//! What it covers is what a model actually emits: fenced code, ATX headings,
//! bold, emphasis, inline code, bullets and ordered lists, blockquotes and a
//! horizontal rule. What it does not cover — tables, link titles, reference
//! links, HTML — is passed through as text, which is the right failure: a table
//! read as its own pipes is ugly and correct.

use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

use crate::text;
use crate::theme::Theme;

/// Render markdown as terminal lines, none wider than `width`.
pub fn render(text: &str, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut fence: Option<&str> = None;
    let mut ordered = 0usize;

    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r');
        let indented = line.len() - line.trim_start().len();
        let body = line.trim_start();

        // A fence opens and closes on its own marker, and everything between
        // them is literal: a model quoting a shell transcript inside backticks
        // is the whole point of the block, and rendering its `**` as bold would
        // corrupt the transcript.
        if let Some(marker) = fence {
            if body.starts_with(marker) {
                fence = None;
            } else {
                out.push(Line::from(Span::styled(
                    text::clip_to(body, width),
                    code_style(theme),
                )));
            }
            continue;
        }
        if body.starts_with("```") || body.starts_with("~~~") {
            fence = Some(if body.starts_with("```") {
                "```"
            } else {
                "~~~"
            });
            ordered = 0;
            continue;
        }

        if body.is_empty() {
            ordered = 0;
            out.push(Line::from(""));
            continue;
        }

        let list = if let Some(rest) = body
            .strip_prefix("- ")
            .or_else(|| body.strip_prefix("* "))
            .or_else(|| body.strip_prefix("+ "))
        {
            ordered = 0;
            Some((format!("  {BULLET} "), rest))
        } else if let Some(at) = body.find(". ") {
            let head = &body[..at];
            if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
                let number: usize = head.parse().unwrap_or(0);
                ordered = if number <= 1 { 1 } else { ordered + 1 };
                Some((format!("{ordered:>2}. "), &body[at + 2..]))
            } else {
                ordered = 0;
                None
            }
        } else {
            ordered = 0;
            None
        };

        if let Some((marker, rest)) = list {
            let mut spans = vec![Span::styled(marker, theme.accent())];
            spans.extend(inline(rest, theme));
            out.push(clip_line(spans, width));
            continue;
        }

        if let Some(rest) = body.strip_prefix("> ") {
            let mut spans = vec![Span::styled("  | ", theme.muted())];
            spans.extend(inline(rest, theme));
            out.push(clip_line(spans, width));
            continue;
        }

        if body == "---" || body == "***" || body == "___" {
            let rule = RULE.repeat(width);
            out.push(Line::from(Span::styled(rule, theme.muted())));
            continue;
        }

        if body.starts_with('#') {
            let level = body.chars().take_while(|c| *c == '#').count();
            let heading = body[level..].trim();
            // A heading is one clipped line whatever the model wrote after it: a
            // reply is a paragraph, and a six-level heading is a paragraph with
            // a number in front of it.
            let style = if level <= 2 {
                heading_style(theme)
            } else {
                theme.muted()
            };
            out.push(Line::from(Span::styled(
                text::clip_to(heading, width),
                style,
            )));
            continue;
        }

        // Four leading spaces is literal, like a fence, and is how a model
        // writes a short command.
        if indented >= 4 {
            out.push(Line::from(Span::styled(
                text::clip_to(body, width),
                code_style(theme),
            )));
            continue;
        }

        out.push(clip_line(inline(body, theme), width));
    }

    if out.is_empty() {
        out.push(Line::from(""));
    }
    out
}

/// The bullet every unordered list item gets.
const BULLET: &str = "*";

/// What a `---` becomes. A repeated dash rather than a box-drawing character,
/// because a rule drawn with `─` depends on the font having it and a row of
/// ASCII dashes is a rule everywhere.
const RULE: &str = "-";

// --- styles ----------------------------------------------------------------

/// Code, which is never restyled by another construct.
fn code_style(theme: &Theme) -> ratatui::style::Style {
    theme.accent()
}

/// A heading, and the only thing in this module that uses `accent_strong`.
fn heading_style(theme: &Theme) -> ratatui::style::Style {
    theme.accent_strong()
}

/// Bold, as a modifier on the paragraph's own colour rather than a colour of
/// its own: emphasis is a weight change, and a theme that painted bold as a
/// different hue would be a theme whose bold colour disagreed with its text.
fn strong_style(theme: &Theme) -> ratatui::style::Style {
    theme
        .text()
        .patch(ratatui::style::Style::new().add_modifier(Modifier::BOLD))
}

fn emphasis_style(theme: &Theme) -> ratatui::style::Style {
    theme
        .text()
        .patch(ratatui::style::Style::new().add_modifier(Modifier::ITALIC))
}

// --- inline ----------------------------------------------------------------

/// A marker and the style it starts. Spelled out once because it appears in
/// two signatures, and a tuple of a string and a function pointer read twice in
/// a file this size is noise.
type Marker = (&'static str, fn(&Theme) -> ratatui::style::Style);

/// The markers, longest first, so `**` is read before `*`.
const MARKERS: [Marker; 4] = [
    ("**", strong_style),
    ("__", strong_style),
    ("*", emphasis_style),
    ("_", emphasis_style),
];

/// Parse the inline spans of one line of prose.
///
/// Nesting is not supported, because a model that writes `**bold with `code`
/// inside**` is rare enough that a recursive parser is not worth it — and the
/// fallback is that the markers show as text, which is legible rather than
/// wrong.
fn inline(body: &str, theme: &Theme) -> Vec<Span<'static>> {
    let chars: Vec<char> = body.chars().collect();
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut plain = String::new();
    let mut i = 0;

    while i < chars.len() {
        // Inline code is the one construct whose content is never styled again:
        // what is between the backticks is what the target would run.
        if chars[i] == '`' {
            if let Some(rel) = position(&chars[i + 1..], '`') {
                push(&mut plain, &mut spans, theme);
                let at = i + 1 + rel;
                let code: String = chars[i + 1..at].iter().collect();
                spans.push(Span::styled(code, code_style(theme)));
                i = at + 1;
                continue;
            }
        }

        if let Some((marker, style)) = marker_at(&chars, i) {
            let after = i + marker.chars().count();
            if let Some(rel) = find_close(&chars[after..], marker) {
                push(&mut plain, &mut spans, theme);
                let inner: String = chars[after..after + rel].iter().collect();
                spans.push(Span::styled(inner, style(theme)));
                i = after + rel + marker.chars().count();
                continue;
            }
        }

        // A backslash escapes what follows, which is how a model writes a
        // literal `*` without turning it into emphasis.
        if chars[i] == '\\' && i + 1 < chars.len() {
            plain.push(chars[i + 1]);
            i += 2;
            continue;
        }

        plain.push(chars[i]);
        i += 1;
    }
    push(&mut plain, &mut spans, theme);
    spans
}

/// The tail of the run, pushed as one span.
fn push(plain: &mut String, spans: &mut Vec<Span<'static>>, theme: &Theme) {
    if !plain.is_empty() {
        spans.push(Span::styled(std::mem::take(plain), theme.text()));
    }
}

/// The marker at `i`, if any.
fn marker_at(chars: &[char], i: usize) -> Option<Marker> {
    let rest: String = chars[i..(i + 2).min(chars.len())].iter().collect();
    MARKERS
        .into_iter()
        .find(|(marker, _)| rest.starts_with(marker))
}

/// The offset of a closing marker, or None when the run is never closed — an
/// unclosed `**` is text, not bold, and rendering it as bold would swallow the
/// rest of the line.
fn find_close(chars: &[char], marker: &str) -> Option<usize> {
    let want: Vec<char> = marker.chars().collect();
    (0..chars.len().saturating_sub(want.len() - 1)).find(|i| chars[*i..*i + want.len()] == want[..])
}

/// The offset of `needle` in `chars`, or None.
fn position(chars: &[char], needle: char) -> Option<usize> {
    chars.iter().position(|c| *c == needle)
}

/// Clip one line of spans to `width` columns.
///
/// The width is honoured across the *sum* of the spans, not per span: the test
/// that guards this file joins the spans and counts columns, and two separately
/// short-enough halves summing past the edge is exactly how a row wraps.
fn clip_line(spans: Vec<Span<'static>>, width: usize) -> Line<'static> {
    let mut used = 0usize;
    let mut kept: Vec<Span<'static>> = Vec::with_capacity(spans.len());
    for span in spans {
        let columns = span.content.width();
        if used + columns <= width {
            used += columns;
            kept.push(span);
            continue;
        }
        // Cut this span where the room runs out, counting columns so a wide
        // glyph that would straddle the edge is dropped rather than split. The
        // running total is not updated: nothing is pushed after this one.
        let mut taken = 0usize;
        let mut cut = String::new();
        for ch in span.content.chars() {
            let cell = ch.to_string().width();
            if used + taken + cell > width {
                break;
            }
            taken += cell;
            cut.push(ch);
        }
        if !cut.is_empty() {
            kept.push(Span::styled(cut, span.style));
        }
        break;
    }
    Line::from(kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nothing comes back wider than it was given, at any width, for any input —
    /// the one rule this module exists to keep, and the one the painting tests
    /// downstream enforce.
    #[test]
    fn nothing_is_ever_wider_than_the_pane() {
        let inputs = [
            "**bold** and *em* and `code`",
            "## A heading long enough to need clipping in a narrow pane",
            "- one\n- two\n- three",
            "> a blockquote long enough to wrap somewhere",
            "```\ncode with **markers** and 中文\n```",
            "1. first\n2. second\n1. third",
            "---",
            "一个很长很长很长的中文段落，一定会在某个宽度被截断",
            "",
            "a\r\nb",
            "**unclosed and *also* unclosed",
        ];
        for width in 4..40 {
            for input in inputs {
                for line in render(input, width, &Theme::DARK) {
                    let joined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
                    assert!(
                        joined.width() <= width,
                        "width {width}: {joined:?} is {} wide",
                        joined.width()
                    );
                }
            }
        }
    }

    /// A fence's contents are literal.
    #[test]
    fn a_fence_is_literal() {
        let lines = render("```sh\necho **bold**\n```", 40, &Theme::DARK);
        let joined: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.as_ref()))
            .collect();
        assert!(
            joined.contains("echo **bold**"),
            "the fence was styled: {joined}"
        );
    }

    /// The inline constructs a model actually emits.
    #[test]
    fn the_inline_constructs_render() {
        let spans = inline("**bold** __also__ *em* _too_ `code`", &Theme::DARK);
        let text: Vec<&str> = spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(
            text,
            vec!["bold", " ", "also", " ", "em", " ", "too", " ", "code"]
        );
    }

    /// An unclosed marker is text.
    #[test]
    fn an_unclosed_marker_is_text() {
        let spans = inline("**never closed", &Theme::DARK);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].content.as_ref(), "**never closed");
    }

    /// A backslash escapes.
    #[test]
    fn a_backslash_escapes() {
        let spans = inline("literal \\*star\\*", &Theme::DARK);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].content.as_ref(), "literal *star*");
    }

    /// An ordered list counts across items and restarts after prose.
    #[test]
    fn an_ordered_list_counts_and_restarts() {
        let lines = render("1. a\n2. b\n\nprose\n\n1. c", 40, &Theme::DARK);
        let joined: Vec<String> = lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect();
        assert!(joined[0].contains("1. a"), "{joined:?}");
        assert!(joined[1].contains("2. b"), "{joined:?}");
        assert!(joined[3].contains("prose"));
        assert!(
            joined[5].contains("1. c"),
            "the count did not restart: {joined:?}"
        );
    }

    /// A rule fills the width with something, and never more.
    #[test]
    fn a_rule_fills_the_width() {
        for width in [4usize, 10, 40] {
            let lines = render("---", width, &Theme::DARK);
            let joined: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
            assert_eq!(joined.width(), width, "width {width}: {joined:?}");
        }
    }
}
