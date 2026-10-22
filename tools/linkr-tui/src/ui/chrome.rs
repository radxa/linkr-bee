//! The two bars: what the session is doing on top, what the keys do below.
//!
//! Each bar is two lines rather than one, because the left and right halves are
//! placed in separate areas: a single line would need its own padding maths and
//! would overlap the moment a counter grew a digit.

use ratatui::style::Style;
use ratatui::symbols;
use ratatui::text::{Line, Span};
use ratatui::widgets::{RenderDirection, Sparkline};

use crate::app::App;
use crate::capability::GlyphSet;
use crate::event::ConnectionState;
use crate::theme::Theme;

/// The separator between the top bar's groups: ` · ` where the terminal has a
/// middle dot, ` . ` where it does not ([`GlyphSet::dot_sep`]).
fn dot(theme: &Theme) -> &'static str {
    theme.glyphs().dot_sep()
}

/// The top bar's left half: the state's glyph, the state's name, and the signal
/// the link is carrying. The signal is the only fact the device reports about
/// the link — the web client's strip carries RSSI too, and nothing carries a
/// negotiated level — so the placeholder is the one reading waiting on a dial,
/// and it fills as soon as there is one.
pub fn top_left(app: &App, theme: &Theme) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("{} ", app.state_glyph()),
            theme.state_dot(app.state),
        ),
        Span::styled(theme.fold(app.state_name()), theme.text()),
        Span::styled(dot(theme).to_string(), theme.muted()),
        // The reading wears the strength ladder rather than the strip's dim
        // grey — the same reason the meters do: in three of the six themes
        // that grey is all but the panel behind it, and a reading nobody can
        // see reads as a reading that is not there at all.
        Span::styled(
            app.signal_text(),
            match app.signal_dbm {
                Some(dbm) => theme.signal_style(dbm),
                None => theme.muted(),
            },
        ),
    ])
}

/// The top bar's right half: traffic counters, the link speed, autoscroll and
/// the clock, in that order — the web client's status strip. It ends flush with
/// the last column, so the strip's right edge does not move with the numbers.
///
/// The two counters wear the two graph colours — RX the accent, TX the focus
/// blue — which is what lets the graph's halves go without a legend of their
/// own.
pub fn top_right(app: &App, theme: &Theme) -> Line<'static> {
    let s = app.strings();
    Line::from(vec![
        Span::styled(format!("{} {}", s.rx, app.rx), theme.accent()),
        Span::styled(dot(theme).to_string(), theme.muted()),
        Span::styled(format!("{} {}", s.tx, app.tx), theme.focus()),
        Span::styled(dot(theme).to_string(), theme.muted()),
        Span::styled(app.baud_text(), theme.muted()),
        Span::styled(dot(theme).to_string(), theme.muted()),
        Span::styled(s.autoscroll.to_string(), theme.muted()),
        Span::styled(dot(theme).to_string(), theme.muted()),
        Span::styled(app.clock.clone(), theme.muted()),
    ])
}

/// The traffic unit's width at the right end of a `bar_width`-wide top bar:
/// the current rate and the graph behind it.
///
/// Zero when the bar is too narrow to spare the columns. The unit is the last
/// thing the bar gained and the first it gives up, because the counters and
/// the clock read without it — and a hijacked full-width strip would push the
/// session's own state off a small terminal.
///
/// Each size is the label's fixed width, thirteen cells, plus the graph's
/// room — four, nine and fifteen cells: the graph keeps the columns it was
/// given as the rate's digits come and go, so nothing in the unit moves but
/// the number itself.
pub fn traffic_unit(bar_width: u16) -> u16 {
    match bar_width {
        120.. => 28,
        104..=119 => 22,
        92..=103 => 17,
        _ => 0,
    }
}

/// The unit's label: the newest rate, in both directions together — the sum of
/// the two newest columns the graphs draw. The spaces are part of the label so
/// the rate is held off the clock's tail and the graphs' heads.
///
/// The number stands in a fixed, right-aligned field, so the label is one
/// width — `1023.9 KB`, the widest a serial line can read, and the widest
/// `human_bytes` spells — for every rate, and the graphs after it never move
/// as the digits do.
///
/// The graphs alone are shape, not scale: without this number a spike could
/// just as well be a megabyte as a byte.
pub fn traffic_label(app: &App, theme: &Theme) -> Line<'static> {
    Line::from(Span::styled(
        format!(" {:>9}/s ", crate::text::human_bytes(app.traffic.rate)),
        theme.accent(),
    ))
}

/// The two graphs: the sampled rates of one direction each, newest at the
/// right edge, RX in the accent and TX in the focus blue — the colours the
/// counters wear, because one series of the two directions together could only
/// ever show their sum.
///
/// The data is reversed with the direction so the widget's own rule — it draws
/// the first samples it is given and stops at the area's width — drops the
/// *oldest* overhang rather than the newest. A graph whose right edge went
/// stale would be worse than no graph.
pub fn rx_graph(app: &App, theme: &Theme) -> Sparkline<'static> {
    samples(
        app.traffic.rx_window.iter().rev().copied(),
        app.traffic.scale(),
        theme.accent(),
        theme.glyphs().bar(),
    )
}

/// The other direction's graph; see [`rx_graph`].
pub fn tx_graph(app: &App, theme: &Theme) -> Sparkline<'static> {
    samples(
        app.traffic.tx_window.iter().rev().copied(),
        app.traffic.scale(),
        theme.focus(),
        theme.glyphs().bar(),
    )
}

/// One direction's samples as the widget both graphs are built from, on the
/// one scale the two share and in the bars this terminal has
/// ([`GlyphSet::bar`]).
///
/// Any nonzero sample is lifted to at least one eighth of the shared scale.
/// The graph keeps one ruler so a torrent still stands above a trickle, but a
/// trickle no longer rounds all the way down to zero: the smallest bar is the
/// one-eighth mark, distinct from the baseline the idle graph draws. Without
/// that floor a TX rate a few bytes a second beside a large RX stream painted
/// exactly like an idle TX direction — the graph said the link had nothing to
/// send while the counters said it did.
fn samples(
    data: impl IntoIterator<Item = u64>,
    scale: u64,
    style: Style,
    bars: symbols::bar::Set<'static>,
) -> Sparkline<'static> {
    let floor = scale.saturating_add(7) / 8;
    Sparkline::default()
        .data(
            data.into_iter()
                .map(move |value| if value == 0 { 0 } else { value.max(floor) }),
        )
        .max(scale)
        .direction(RenderDirection::RightToLeft)
        .bar_set(bars)
        .style(style)
}

/// The glyph that heads the RX graph, in the colour that graph is drawn in.
pub fn rx_arrow(theme: &Theme) -> Span<'static> {
    Span::styled(theme.glyphs().arrow_down(), theme.accent())
}

/// The glyph that heads the TX graph; see [`rx_arrow`].
pub fn tx_arrow(theme: &Theme) -> Span<'static> {
    Span::styled(theme.glyphs().arrow_up(), theme.focus())
}

/// The bottom bar's left half: which region has the keyboard, which view is
/// showing, and the session state.
pub fn bottom_left(app: &App, theme: &Theme) -> Line<'static> {
    let s = app.strings();
    let focus = match app.focus {
        crate::app::Focus::Terminal => s.focus_terminal,
        crate::app::Focus::Sidebar => s.focus_sidebar,
        crate::app::Focus::Assistant => s.focus_assistant,
    };
    let state_style = theme.state_dot(app.state);
    let mut spans = vec![Span::styled(format!("[{focus}] "), theme.accent())];
    // The view's own name, then what the keyboard is on *inside* it. A rail
    // focused on a link the user has not picked says "link", because that is
    // the row under the cursor and that is what Enter will act on — a left
    // half that only ever said the view's name left the operator to count rows
    // to know what they were about to press.
    spans.push(Span::styled(app.view_name().to_string(), theme.text()));
    spans.push(Span::styled(
        format!(" / {}", focus_detail(app, s)),
        theme.muted(),
    ));
    spans.push(Span::styled(dot(theme).to_string(), theme.muted()));
    spans.push(Span::styled(theme.fold(app.state_name()), state_style));
    // The latch, while one is armed: the announcement times out, the chip
    // does not, so a user who looked away still sees what the next key will
    // carry. One span with its own separator, so the bar can give the whole
    // chip up when it runs out of room rather than leaving ` · ` behind.
    if app.latch.is_armed() {
        spans.push(Span::styled(
            format!("{}{} {}", dot(theme), app.latch.names(), s.latch_pending),
            theme.warn(),
        ));
    }
    // What the pane could not read as text. The device's bytes arrive as
    // *something* and the pane paints a replacement character for each byte
    // that was not UTF-8; the count is the part of that fact a user can act
    // on, so it rides the bar — where the state is — and not the pane, where
    // it would cover the very text it is talking about. One span, for the
    // same reason the latch chip is one.
    let lost = app.terminal.decode_lost();
    if lost > 0 {
        spans.push(Span::styled(
            format!("{}{} {lost}B", dot(theme), s.decode_loss),
            theme.warn(),
        ));
    }
    Line::from(spans)
}

/// The left half of a bar, cut down to the room it really has.
///
/// The right half is painted *over* the left, so a line that reaches past it is
/// not laid out around its neighbour — it is covered by it, mid-glyph: a chip
/// that needed one column more came out as `· 乱` with the rest of the row on
/// top of it, which reads as a broken frame rather than as a full bar. Chips
/// are given up whole instead, from the end, and the last span stays: a bar
/// with room for nothing else still says what the keyboard is on.
pub fn trim_to_width(line: Line<'static>, width: u16) -> Line<'static> {
    let mut line = line;
    while line.width() as u16 > width && line.spans.len() > 1 {
        line.spans.pop();
    }
    // A separator with nothing after it is not a fact either: `… · 已连接` had
    // its state given up, and the ` · ` in front of it is a mark with no word.
    // Both spellings count: the bar is drawn with the one this terminal has.
    while line.spans.len() > 1
        && line
            .spans
            .last()
            .is_some_and(|span| matches!(span.content.trim(), "·" | "."))
    {
        line.spans.pop();
    }
    line
}

/// What the keyboard is on inside the focused view, in the interface language.
///
/// A function of the focus rather than of the view, because a rail's rows are
/// the same rows whichever view is open — the transport, the two connection
/// actions, and the quick sends — and naming the row is what tells the user
/// what Enter is about to do.
fn focus_detail(app: &App, s: &crate::i18n::Strings) -> String {
    match app.focus {
        crate::app::Focus::Sidebar => {
            let targets = crate::ui::sidebar::targets(app);
            targets
                .get(app.sidebar_cursor)
                .cloned()
                .unwrap_or_else(|| s.focus_terminal.to_string())
        }
        crate::app::Focus::Terminal => s.term_input.to_string(),
        crate::app::Focus::Assistant => s.agent_field_composer.to_string(),
    }
}

/// The bottom bar's right half: the four key hints the design spells out.
pub fn bottom_right(app: &App, theme: &Theme) -> Line<'static> {
    let s = app.strings();
    Line::from(vec![
        Span::styled(s.hint_palette.to_string(), theme.muted()),
        Span::styled(dot(theme).to_string(), theme.muted()),
        Span::styled(s.hint_help.to_string(), theme.muted()),
        Span::styled(dot(theme).to_string(), theme.muted()),
        Span::styled(s.hint_views.to_string(), theme.muted()),
        Span::styled(dot(theme).to_string(), theme.muted()),
        Span::styled(s.hint_quit.to_string(), theme.muted()),
    ])
}

/// The bar ground: a panel, full width.
pub fn bar_style(theme: &Theme) -> Style {
    theme.panel()
}

/// The dot the status pill opens with. A filled circle in every state where the
/// font has one, so the pill reads as a state light and the colour is what
/// carries the state; where it does not, the state's own mark — the only thing
/// left to carry it.
fn pill_dot(glyphs: GlyphSet, state: ConnectionState) -> &'static str {
    match glyphs {
        GlyphSet::Unicode => "●",
        GlyphSet::Ascii => glyphs.state(state),
    }
}

/// The terminal pane's status pill: the live state, on a chip, for the pane's
/// head row.
///
/// The web client keeps this pill in its header — one dot, the state, and the
/// device it is on. The pane's head row is where the design puts it. The device
/// name is already a sidebar row of its own, so the pill carries the dot and
/// the state and nothing else.
///
/// The dot takes the state's colour from the same place the top bar's glyph and
/// the sidebar's do, so the three can never disagree about what the session is
/// doing — which is what the design's own screenshot does, painting the same
/// connecting state amber in two places and blue in this one.
pub fn status_pill(app: &App, theme: &Theme) -> Line<'static> {
    Line::from(vec![
        // The padding is part of the chip, so it carries the chip's ground.
        Span::styled(
            format!(" {} ", pill_dot(theme.glyphs(), app.state)),
            theme.pill_dot(app.state),
        ),
        Span::styled(theme.fold(app.state_name()), theme.pill()),
        Span::styled(" ", theme.pill()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::ConnectionState;
    use crate::i18n::Lang;
    use crate::text::columns;

    fn line_text(line: &Line<'_>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    /// The pill names the live state, opens with a filled dot in the state's own
    /// colour, and sits on the chip's ground — the design's `● 连接中…`.
    #[test]
    fn the_status_pill_names_the_state_with_a_state_coloured_dot() {
        let theme = Theme::DARK;
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        app.state = ConnectionState::Connecting;
        let pill = status_pill(&app, &theme);
        assert_eq!(line_text(&pill), " ● 连接中… ");
        assert_eq!(pill.spans[0].style.fg, Some(theme.warn));
        assert_eq!(pill.spans[0].style.bg, Some(theme.panel_3));
        assert_eq!(pill.spans[1].style, theme.pill());
        assert_eq!(pill.spans[2].style, theme.pill());

        app.state = ConnectionState::Connected;
        let connected = status_pill(&app, &theme);
        assert_eq!(line_text(&connected), " ● 已连接 ");
        // The dot is the only thing that moves with the state, and it is the
        // same colour the top bar's glyph and the sidebar's use.
        assert_eq!(connected.spans[0].style.fg, Some(theme.accent_strong));
        assert_eq!(connected.spans[1].content, app.state_name());
    }

    /// The pill's geometry is the design's: the dot, the state, and one column
    /// of padding each side. Its width is what puts its right edge in the
    /// designed column, so a change here moves the pill.
    #[test]
    fn the_pill_is_the_dot_the_state_and_its_padding() {
        let theme = Theme::DARK;
        let app = App {
            lang: Lang::En,
            state: ConnectionState::Connecting,
            ..App::default()
        };
        let pill = status_pill(&app, &theme);
        assert_eq!(line_text(&pill), " ● connecting… ");
        assert_eq!(pill.width(), 1 + 1 + 1 + columns("connecting…") + 1);
    }

    /// Both themes paint the pill: a light pane is not left without its state.
    #[test]
    fn the_pill_follows_the_theme() {
        let app = App::default();
        let dark = status_pill(&app, &Theme::DARK);
        let light = status_pill(&app, &Theme::LIGHT);
        assert_eq!(line_text(&dark), line_text(&light));
        assert_eq!(dark.spans[1].style, Theme::DARK.pill());
        assert_eq!(light.spans[1].style, Theme::LIGHT.pill());
    }

    /// The top bar names the state and the two facts about its link. Until the
    /// device reports either, both slots hold the placeholder — the frame the
    /// design's screenshots show.
    #[test]
    fn the_top_bar_names_the_state_and_its_link_facts() {
        let theme = Theme::DARK;
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        app.state = ConnectionState::Connecting;
        assert_eq!(line_text(&top_left(&app, &theme)), "◐ 连接中… · ─");

        app.state = ConnectionState::Connected;
        assert_eq!(line_text(&top_left(&app, &theme)), "● 已连接 · ─");

        app.signal_dbm = Some(-58);
        assert_eq!(line_text(&top_left(&app, &theme)), "● 已连接 · -58 dBm");

        app.lang = Lang::En;
        assert_eq!(line_text(&top_left(&app, &theme)), "● connected · -58 dBm");
    }

    /// The glyph changes with the state, and takes the state's colour.
    #[test]
    fn the_status_glyph_follows_the_state() {
        let theme = Theme::DARK;
        let mut app = App::default();
        let cases = [
            (ConnectionState::Connected, theme.accent_strong(), "●"),
            (ConnectionState::Connecting, theme.warn(), "◐"),
            (ConnectionState::Failed, theme.danger(), "◆"),
            (ConnectionState::Disconnected, theme.muted(), "○"),
        ];
        for (state, style, glyph) in cases {
            app.state = state;
            let line = top_left(&app, &theme);
            assert_eq!(line.spans[0].style.fg, style.fg, "{state:?}");
            assert_eq!(line.spans[0].content.trim_end(), glyph, "{state:?}");
        }
    }

    /// The traffic unit appears only where it fits: nothing on a classic
    /// 80-column bar, a wider slice for the graph as the bar grows.
    #[test]
    fn the_traffic_unit_grows_with_the_bar() {
        assert_eq!(traffic_unit(80), 0);
        assert_eq!(traffic_unit(91), 0);
        assert_eq!(traffic_unit(92), 17);
        assert_eq!(traffic_unit(103), 17);
        assert_eq!(traffic_unit(104), 22);
        assert_eq!(traffic_unit(119), 22);
        assert_eq!(traffic_unit(120), 28);
        assert_eq!(traffic_unit(200), 28);
    }

    /// The label is the rate in human bytes, held off its neighbours by a
    /// space each side, in the accent the unit has always worn — it names the
    /// scale both graphs share, not either direction on its own.
    #[test]
    fn the_traffic_label_names_the_rate_in_human_bytes() {
        let theme = Theme::DARK;
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        assert_eq!(line_text(&traffic_label(&app, &theme)), "       0 B/s ");
        app.traffic.rate = 1536;
        assert_eq!(line_text(&traffic_label(&app, &theme)), "    1.5 KB/s ");
        // The number stands in a fixed field, so what follows the label — the
        // graphs — never moves as the rate gains or loses a digit, not even at
        // the widest spelling `human_bytes` has.
        for rate in [0, 999, 5 * 1024, 640 * 1024, 1_047_552, 8 * 1024 * 1024] {
            app.traffic.rate = rate;
            assert_eq!(traffic_label(&app, &theme).width(), 13, "rate {rate}");
        }
        assert_eq!(
            traffic_label(&app, &theme).spans[0].style.fg,
            Some(theme.accent)
        );
        assert_eq!(
            traffic_label(&app, &Theme::LIGHT).spans[0].style.fg,
            Some(Theme::LIGHT.accent)
        );
    }

    /// The right half reads counters, speed, autoscroll and the clock, in that
    /// order — and reads the same in both languages, because the tokens in it
    /// are deliberately untranslated.
    #[test]
    fn the_top_bar_right_reads_the_counters_in_order() {
        for lang in [Lang::Zh, Lang::En] {
            let mut app = App {
                lang,
                ..App::default()
            };
            app.rx = 12;
            app.tx = 34;
            app.clock = "19:52:50".to_string();
            let text = line_text(&top_right(&app, &Theme::DARK));
            assert_eq!(
                text, "RX 12 · TX 34 · ─ · Auto · 19:52:50",
                "{lang:?} translates a token the design keeps Latin"
            );
            assert!(!text.ends_with(' '), "{text:?} carries a trailing space");
        }
    }

    /// The baud slot fills in once the device reports a speed, and the counters
    /// keep their places — the strip's width must not depend on the numbers.
    #[test]
    fn the_baud_slot_fills_in_without_moving_the_counters() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.baud = Some(115_200);
        app.clock = "19:52:50".to_string();
        let text = line_text(&top_right(&app, &Theme::DARK));
        assert_eq!(text, "RX 0 · TX 0 · 115200 · Auto · 19:52:50");
    }

    /// One frame names the session's state once and the same way: the top bar
    /// and the bottom bar both carry the state's own name, and neither carries
    /// another state's — a frame that said `连接中…` in one place and
    /// `connecting…` in the other would be showing two answers to one question.
    #[test]
    fn the_bars_name_the_state_the_same_way() {
        for lang in [Lang::Zh, Lang::En] {
            for state in [
                ConnectionState::Disconnected,
                ConnectionState::Connecting,
                ConnectionState::Connected,
                ConnectionState::Failed,
            ] {
                let app = App {
                    lang,
                    state,
                    ..App::default()
                };
                let theme = Theme::DARK;
                let top = top_left(&app, &theme);
                let bottom = bottom_left(&app, &theme);
                // The state's name is its own span, so the check is exact rather
                // than a search: `disconnected` contains `connected`.
                assert_eq!(top.spans[1].content.as_ref(), app.state_name());
                assert_eq!(
                    top.spans[0].content.trim_end(),
                    app.state_glyph(),
                    "{lang:?}/{state:?}"
                );
                assert_eq!(
                    bottom.spans.last().unwrap().content.as_ref(),
                    app.state_name()
                );
                assert_eq!(
                    bottom.spans.last().unwrap().style.fg,
                    theme.state_dot(state).fg
                );
            }
        }
    }

    /// The bottom bar's left half names the focus, the view and the state.
    #[test]
    fn the_bottom_bar_left_names_focus_view_and_state() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        app.view = crate::event::View::Network;
        app.state = ConnectionState::Connecting;
        let text = line_text(&bottom_left(&app, &Theme::DARK));
        assert_eq!(text, "[终端] 网络 / 输入 · 连接中…");

        // The rail names the row the cursor is on, not just the view: a left
        // half that says "侧栏 网络" tells the user which view they are in and
        // nothing about what Enter will do.
        app.focus = crate::app::Focus::Sidebar;
        let text = line_text(&bottom_left(&app, &Theme::DARK));
        assert!(text.starts_with("[侧栏] 网络 / "), "{text}");
        assert!(text.contains("传输"), "the row is named: {text}");
    }

    /// Bytes the pane could not read as text ride the bottom bar: the pane
    /// paints `�` for them, and a screenful of `�` with nothing said about it
    /// reads as the view's fault. The count is the part a user can carry to
    /// the device — how much of what it sent never arrived as text.
    #[test]
    fn the_bottom_bar_names_the_bytes_the_pane_could_not_read() {
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        let clean = line_text(&bottom_left(&app, &Theme::DARK));
        assert!(
            !clean.contains("乱码"),
            "nothing lost, nothing said: {clean}"
        );

        app.terminal.push(b"\xff\xff");
        let line = bottom_left(&app, &Theme::DARK);
        assert!(
            line_text(&line).ends_with(" · 乱码 2B"),
            "{}",
            line_text(&line)
        );
        assert_eq!(
            line.spans.last().expect("the marker is there").style.fg,
            Some(Theme::DARK.warn)
        );

        app.lang = Lang::En;
        let text = line_text(&bottom_left(&app, &Theme::DARK));
        assert!(text.ends_with(" · garbled 2B"), "{text}");
    }

    /// A line the bar has no room for is given up a chip at a time, not cut
    /// through the middle of one: the right half is painted *over* the left, so
    /// a chip that was one column too long came out as `· 乱`, which reads as a
    /// broken frame. And later, more important facts survive it — the state is
    /// what the user is looking at, the chip is a bonus.
    #[test]
    fn a_left_half_too_long_gives_up_chips_whole() {
        let theme = Theme::DARK;
        let mut app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        app.state = ConnectionState::Connected;
        app.terminal.push(&[0xffu8; 57]);
        app.latch.ctrl = true;
        let full = bottom_left(&app, &theme);
        let text = line_text(&full);
        assert!(text.ends_with(" · 乱码 57B"), "{text}");
        assert!(text.contains(" · Ctrl 待发 "), "{text}");

        // Room for both chips, and no more: nothing is given up.
        let width = full.width() as u16;
        assert_eq!(
            line_text(&trim_to_width(full.clone(), width)),
            line_text(&full)
        );
        let one_chip = line_text(&trim_to_width(full.clone(), width - 1));
        assert!(one_chip.ends_with(" · Ctrl 待发"), "{one_chip}");

        // The bar the screenshot came from: room for the core and nothing
        // else — the last chip goes whole, the state stays.
        let core = line_text(&trim_to_width(full.clone(), 37));
        assert!(core.ends_with("已连接"), "{core}");
        assert!(!core.contains("乱"), "a chip is not cut: {core}");
        assert!(!core.contains("待发"), "{core}");

        // Room for neither the state nor a chip: the focus and the view are
        // what a bar this narrow still says.
        let narrow = line_text(&trim_to_width(full.clone(), 12));
        assert!(narrow.starts_with("[终端]"), "{narrow}");
        assert!(narrow.len() < 30, "{narrow}");

        // A state given up takes the ` · ` in front of it: a mark with no word
        // after it is not a fact.
        let headless = line_text(&trim_to_width(full.clone(), 28));
        assert!(!headless.ends_with("· "), "{headless}");
        assert!(headless.ends_with("输入"), "{headless}");

        // And a bar with room for nothing at all still says what Enter will
        // act on: one span, never none.
        let nothing = trim_to_width(full, 0);
        assert_eq!(nothing.spans.len(), 1);
        assert_eq!(line_text(&nothing), "[终端] ");
    }

    /// The right half lists the four designed hints, in order, in both
    /// languages — the exact strings the screenshots show.
    #[test]
    fn the_bottom_bar_right_lists_the_four_hints() {
        let zh = line_text(&bottom_right(
            &App {
                lang: Lang::Zh,
                ..App::default()
            },
            &Theme::DARK,
        ));
        assert_eq!(zh, "Ctrl+P 面板 · F1 帮助 · F2-F5 视图 · Ctrl+Q 退出");
        let en = line_text(&bottom_right(
            &App {
                lang: Lang::En,
                ..App::default()
            },
            &Theme::DARK,
        ));
        assert_eq!(en, "Ctrl+P palette · F1 help · F2-F5 views · Ctrl+Q quit");
    }

    /// Every span in both bars takes its colour from the theme, so switching
    /// themes repaints the chrome with no other change.
    #[test]
    fn both_bars_take_their_colours_from_the_theme() {
        let app = App {
            lang: Lang::En,
            ..App::default()
        };
        let dark = [
            top_left(&app, &Theme::DARK),
            top_right(&app, &Theme::DARK),
            bottom_left(&app, &Theme::DARK),
            bottom_right(&app, &Theme::DARK),
        ];
        for line in &dark {
            for span in &line.spans {
                assert!(
                    span.style.fg.is_some() || span.content.trim().is_empty(),
                    "unstyled span {:?}",
                    span.content
                );
            }
        }
        // The counters wear the two graph colours, and both move with the
        // theme like everything else.
        let light_right = top_right(&app, &Theme::LIGHT);
        assert_eq!(light_right.spans[0].style.fg, Some(Theme::LIGHT.accent));
        assert_eq!(light_right.spans[2].style.fg, Some(Theme::LIGHT.focus));
        assert_ne!(
            light_right.spans[0].style.fg,
            top_right(&app, &Theme::DARK).spans[0].style.fg
        );
    }
}
