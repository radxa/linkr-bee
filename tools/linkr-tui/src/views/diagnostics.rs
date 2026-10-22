//! Diagnostics view: the `@i?` read and the grid the web client draws from the
//! `@info` lines it answers with (WEB_UX_SPEC section 5.2).
//!
//! The model is the wire and nothing else: `@info <group> key=value …` parsed
//! into `groups[group][key]`, plus the six rows of the web `#diagnosticsGrid`,
//! formatted exactly the way the browser formats them. No socket, no clock and
//! no session — a whole view is exercised from a list of strings, which is why
//! the formatters can be pinned to the documented sample byte for byte.

use std::collections::BTreeMap;

use ratatui::text::{Line, Span};

use crate::app::App;
use crate::event::View;
use crate::i18n::Lang;
use crate::text;
use crate::theme::Theme;

/// The documented reply from `docs/DEVELOPMENT.md`, which the web client's own
/// tests use. `--sample` feeds exactly this to the grid.
pub const SAMPLE: [&str; 6] = [
    "@info fw version=0.1.2 zephyr=4.4.1",
    "@info sys uptime_ms=123456 owner=0 security=1",
    "@info uart dropped=0 buffer=0/16384",
    "@info wifi state=connected ip=ready error=0",
    "@info upload state=on queue=0 dropped=0 http=201 failures=0 successes=4",
    "@info done",
];

/// The label field of the grid, in columns. A CJK label is two columns per
/// glyph, so this field is built with [`text::pad_to`] and never `{:<14}`.
const LABEL_COLUMNS: usize = 14;

/// What sits between the two fields of a grid row: the rule between a row's
/// label field and its value, in this terminal's set — `│ ` where the font has
/// a box rule, `| ` where it does not ([`crate::capability::GlyphSet::divider`]).
fn separator(theme: &Theme) -> String {
    format!("{} ", theme.glyphs().divider())
}

/// The groups the six designed rows already show; any other group the firmware
/// reports is appended below them rather than dropped.
const DESIGNED_GROUPS: [&str; 5] = ["fw", "sys", "uart", "wifi", "upload"];

/// `groups[group][key] = value`, ordered so a frame is stable.
pub type InfoGroups = BTreeMap<String, BTreeMap<String, String>>;

/// Everything the diagnostics view knows. Filled by the session layer; read
/// here as plain data.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiagnosticsState {
    /// The `@info` data, by group then key — what the grid reads.
    pub groups: InfoGroups,
    /// Every line of the last reply, verbatim, so a formatter can never lose
    /// something the device said.
    pub raw: Vec<String>,
    /// Whether the device sent its `@info done` terminator.
    pub done: bool,
    /// A read is in flight.
    pub loading: bool,
    /// The last failure, already worded for the reader.
    pub error: Option<String>,
    /// `HH:MM:SS` of the last successful read. Stamped by the caller, so the
    /// state never reads a clock itself and a frame stays reproducible.
    pub updated: Option<String>,
    /// How far down the document the view is scrolled, in lines. `0` is the
    /// top; the painter pins a value past the last screenful to that last
    /// screenful rather than to blank paper.
    pub scroll: usize,
}

impl DiagnosticsState {
    /// Fold one reply in, exactly as a live read would: parse it, keep the raw
    /// lines, clear the in-flight flag and stamp the time.
    ///
    /// A reply that carries no `@info` line at all leaves the last good grid in
    /// place — a device that answers a management read with something else must
    /// not blank the pane.
    pub fn apply(&mut self, lines: &[String], stamp: String) {
        let borrowed: Vec<&str> = lines.iter().map(String::as_str).collect();
        let (groups, done) = parse_info_lines(borrowed);
        if !groups.is_empty() {
            self.groups = groups;
        }
        self.raw = lines.to_vec();
        self.done = done;
        self.loading = false;
        self.error = None;
        self.updated = Some(stamp);
        // A fresh read opens at its top: a scroll left where the last document
        // ended would hide both the new stamp and the row it describes.
        self.scroll = 0;
    }

    /// Whether the grid has anything to draw.
    pub fn has_data(&self) -> bool {
        !self.groups.is_empty()
    }
}

/// Parse one `@info <group> key=value …` line into `groups`. Returns whether
/// the line belonged to the protocol at all; `@info done` belongs to it and
/// carries no data.
pub fn parse_info_line(line: &str, groups: &mut InfoGroups) -> bool {
    let rest = match line.trim_end().strip_prefix("@info ") {
        Some(rest) => rest,
        None => return false,
    };
    let mut fields = rest.split_whitespace();
    let group = match fields.next() {
        Some(group) if group != "done" => group.to_string(),
        // `@info done`, or a bare `@info`: recognized, nothing to store.
        _ => return true,
    };
    let entry = groups.entry(group).or_default();
    for field in fields {
        if let Some((key, value)) = field.split_once('=') {
            entry.insert(key.to_string(), value.to_string());
        }
    }
    true
}

/// Parse a whole reply: the merged groups, and whether `@info done` arrived.
pub fn parse_info_lines<'a, I>(lines: I) -> (InfoGroups, bool)
where
    I: IntoIterator<Item = &'a str>,
{
    let mut groups = InfoGroups::new();
    let mut done = false;
    for line in lines {
        if line.trim_end() == "@info done" {
            done = true;
            continue;
        }
        parse_info_line(line, &mut groups);
    }
    (groups, done)
}

/// One field of the joined groups, or `None`.
fn get<'a>(groups: &'a InfoGroups, group: &str, key: &str) -> Option<&'a str> {
    groups
        .get(group)
        .and_then(|fields| fields.get(key))
        .map(String::as_str)
}

/// `<version> · Z<zephyr>`, or an em dash before the device has answered.
pub fn fmt_firmware(groups: &InfoGroups) -> String {
    match get(groups, "fw", "version") {
        Some(version) => match get(groups, "fw", "zephyr") {
            Some(zephyr) => format!("{version} · Z{zephyr}"),
            None => version.to_string(),
        },
        None => "—".to_string(),
    }
}

/// `1d 2h` | `2h 30m` | `12m 5s` | `5s` — the web client's uptime formatter.
pub fn fmt_uptime_ms(uptime_ms: u64) -> String {
    let total_secs = uptime_ms / 1000;
    let days = total_secs / 86_400;
    let hours = (total_secs % 86_400) / 3_600;
    let minutes = (total_secs % 3_600) / 60;
    let secs = total_secs % 60;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m {secs}s")
    } else {
        format!("{secs}s")
    }
}

/// The device's uptime, from `sys.uptime_ms`.
pub fn fmt_uptime(groups: &InfoGroups) -> String {
    match get(groups, "sys", "uptime_ms").and_then(|v| v.parse::<u64>().ok()) {
        Some(ms) => fmt_uptime_ms(ms),
        None => "–".to_string(),
    }
}

/// `open`/`scoped`, plus ` · link L<level>` when the device reports a security
/// level. Both words are interface text the web words through its own table, so
/// they follow the interface language rather than the wire.
pub fn fmt_ble_access(groups: &InfoGroups, lang: Lang) -> String {
    let s = lang.strings();
    let owner = match get(groups, "sys", "owner") {
        Some("0") => s.diag_access_open,
        Some(_) => s.diag_access_scoped,
        None => return "–".to_string(),
    };
    match get(groups, "sys", "security") {
        Some(level) => format!("{owner} · {}{level}", s.diag_link_level),
        None => owner.to_string(),
    }
}

/// `<buffer> · drop <n>`.
pub fn fmt_uart_buffer(groups: &InfoGroups) -> String {
    let buffer = get(groups, "uart", "buffer").unwrap_or("–");
    let dropped = get(groups, "uart", "dropped").unwrap_or("0");
    format!("{buffer} · drop {dropped}")
}

/// `<state> · IP <ip> · err <n>`.
pub fn fmt_wifi(groups: &InfoGroups) -> String {
    let state = get(groups, "wifi", "state").unwrap_or("–");
    let ip = get(groups, "wifi", "ip").unwrap_or("-");
    let error = get(groups, "wifi", "error").unwrap_or("0");
    format!("{state} · IP {ip} · err {error}")
}

/// `<queue> B · HTTP <n> · fail <n>`.
pub fn fmt_upload(groups: &InfoGroups) -> String {
    let queue = get(groups, "upload", "queue").unwrap_or("0");
    let http = get(groups, "upload", "http").unwrap_or("-");
    let failures = get(groups, "upload", "failures").unwrap_or("0");
    format!("{queue} B · HTTP {http} · fail {failures}")
}

/// The six rows of the web `#diagnosticsGrid`, in the web's order. `WiFi` reads
/// the same in both languages (the web's own `diagWifi`), so it is not a
/// translated label.
pub fn value_rows(groups: &InfoGroups, lang: Lang) -> [(&'static str, String); 6] {
    let s = lang.strings();
    [
        (s.diag_label_firmware, fmt_firmware(groups)),
        (s.diag_label_uptime, fmt_uptime(groups)),
        (s.diag_label_ble_access, fmt_ble_access(groups, lang)),
        (s.diag_label_uart_buffer, fmt_uart_buffer(groups)),
        ("WiFi", fmt_wifi(groups)),
        (s.diag_label_upload_queue, fmt_upload(groups)),
    ]
}

/// The `wifi.state` side effect the web client takes from the diagnostics
/// stream: `(connected, ip)` when the device reports a WiFi state at all.
pub fn wifi_from_info(groups: &InfoGroups) -> Option<(bool, String)> {
    let state = get(groups, "wifi", "state")?;
    let ip = get(groups, "wifi", "ip").unwrap_or("").to_string();
    Some((state == "connected", ip))
}

/// Whether a value looks like an IPv4 address — the web client's heuristic for
/// pre-filling the LAN host field from `wifi.ip`.
pub fn looks_like_ipv4(value: &str) -> bool {
    let mut parts = 0;
    for part in value.split('.') {
        if parts == 4 {
            return false;
        }
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        if part.parse::<u16>().map(|v| v > 255).unwrap_or(true) {
            return false;
        }
        parts += 1;
    }
    parts == 4
}

// --- rendering ---------------------------------------------------------------

/// One message line of the body, clipped to the pane.
///
/// Every line a view paints goes through a width-aware path, so the body's
/// contract — a body never paints past the width it was given — holds whether
/// or not the widget above it happens to wrap. The alternative is a message
/// that wraps inside a narrow pane and shifts every row below it, which is
/// exactly how a frame stops matching its own layout.
fn message(text: &str, style: ratatui::style::Style, width: u16) -> Line<'static> {
    Line::from(Span::styled(text::clip_to(text, width as usize), style))
}

/// One `label │ value` row of the grid.
///
/// The label field is [`LABEL_COLUMNS`] wide and measured in columns, and the
/// value takes what is left. A pane too narrow for both drops the value and
/// clips the label field instead of letting the row spill past the pane — a row
/// wider than its pane wraps, and a wrapped row shifts every row below it.
fn row_line(label: &str, value: &str, width: u16, theme: &Theme) -> Line<'static> {
    let budget = width as usize;
    let (label, head_columns) = label_field(label, theme);
    // The value is a line of the interface even when the numbers in it came
    // off the wire: the ` · ` this program put between two fields is folded for
    // a terminal that cannot show it, like every other mark in the frame. The
    // pane's own output is never folded — that text is the device's — but a
    // grid row is chrome, and it is clipped to the pane either way.
    let value = theme.fold(value);
    if head_columns >= budget {
        let head = format!("{label}{}", separator(theme));
        return Line::from(Span::styled(text::clip_to(&head, budget), theme.focus()));
    }
    let value = text::clip_to(value.as_ref(), budget - head_columns);
    Line::from(vec![
        Span::styled(label, theme.focus()),
        Span::styled(separator(theme), theme.muted()),
        Span::styled(value, theme.text()),
    ])
}

/// The label field of a grid row: padded to [`LABEL_COLUMNS`] *columns* — so a
/// CJK label pads the same as an English one — with the column count of the
/// field and the separator that follows it: what a value has left of the
/// pane's width.
fn label_field(label: &str, theme: &Theme) -> (String, usize) {
    let padded = text::pad_to(&text::clip_to(label, LABEL_COLUMNS), LABEL_COLUMNS);
    let head_columns = text::columns(&padded) + text::columns(&separator(theme));
    (padded, head_columns)
}

/// The meter's cells: enough to read a proportion off, short enough to ride a
/// row at the narrowest pane the grid still fits in.
const METER_CELLS: usize = 10;

/// The buffer occupancy that counts as "about to drop".
const METER_WARN_PERCENT: u64 = 80;

/// The UART buffer row: `<used>/<total> <meter> <pct>% · drop <n>` when the
/// reply carries a buffer pair and the pane has room for the extra columns,
/// the documented row otherwise.
///
/// The buffer is the one count in the grid with a ceiling, and the ceiling is
/// the interesting part: a rising meter is a pipeline backing up, and the far
/// end of it is drops. The share is taken from the same `used/total` the web
/// client prints, so a reply the browser understands is a reply this row
/// measures; anything else keeps the row exactly as it was.
fn uart_buffer_row(label: &str, groups: &InfoGroups, width: u16, theme: &Theme) -> Line<'static> {
    let raw = fmt_uart_buffer(groups);
    let pair = get(groups, "uart", "buffer")
        .and_then(|buffer| buffer.split_once('/'))
        .and_then(|(used, total)| Some((used.parse::<u64>().ok()?, total.parse::<u64>().ok()?)))
        .filter(|(_, total)| *total > 0);
    let Some((used, total)) = pair else {
        return row_line(label, &raw, width, theme);
    };

    let budget = width as usize;
    let (label, head_columns) = label_field(label, theme);
    if head_columns >= budget {
        return row_line(&label, &raw, width, theme);
    }

    let (fill, track) = text::meter_with(used, total, METER_CELLS, theme.glyphs().meter());
    // The share as the reader's own percentage: the meter shows it, the
    // number states it, and both come from the pair the device sent. In wide
    // arithmetic, like `text::meter` itself — the pair arrives verbatim from
    // the wire, and a `used` near `u64::MAX` must not wrap into a wrong
    // number or panic in a debug build.
    let wide_used = u128::from(used.min(total));
    let wide_total = u128::from(total);
    let percent = (wide_used * 100 + wide_total / 2) / wide_total.max(1);
    let dropped = get(groups, "uart", "dropped").unwrap_or("0");
    let value = format!(
        "{used}/{total} {fill}{track} {percent}%{}drop {dropped}",
        theme.glyphs().dot_sep()
    );
    if text::columns(&value) > budget - head_columns {
        // No room for the meter: the row is the documented one, unshrunk.
        return row_line(&label, &raw, width, theme);
    }

    let ink = if percent >= u128::from(METER_WARN_PERCENT) {
        theme.warn()
    } else {
        theme.accent()
    };
    Line::from(vec![
        Span::styled(label, theme.focus()),
        Span::styled(separator(theme), theme.muted()),
        Span::styled(format!("{used}/{total} "), theme.text()),
        Span::styled(fill, ink),
        Span::styled(track, theme.muted()),
        Span::styled(format!(" {percent}%"), theme.muted()),
        Span::styled(
            format!("{}drop {dropped}", theme.glyphs().dot_sep()),
            theme.text(),
        ),
    ])
}

/// The whole body: heading, the read's freshness, the six-row grid (or the
/// reason there is none), then the keys this view answers to.
pub fn lines(app: &App, theme: &Theme, width: u16) -> Vec<Line<'static>> {
    let s = app.strings();
    let state = &app.diagnostics;
    let mut lines = vec![
        message(
            app.lang.view_name(View::Diagnostics),
            theme.section_header(),
            width,
        ),
        message(
            theme
                .fold(&match &state.updated {
                    Some(at) => format!("{} {at}", s.diag_updated),
                    None => s.diag_not_read.to_string(),
                })
                .as_ref(),
            theme.muted(),
            width,
        ),
        Line::from(""),
    ];

    if !app.ble_connected() {
        lines.push(message(s.diag_no_ble, theme.warn(), width));
        lines.push(Line::from(""));
    }
    if let Some(error) = &state.error {
        lines.push(message(error, theme.danger(), width));
        lines.push(Line::from(""));
    }

    if state.has_data() {
        for (label, value) in value_rows(&state.groups, app.lang) {
            if label == s.diag_label_uart_buffer {
                lines.push(uart_buffer_row(label, &state.groups, width, theme));
            } else {
                lines.push(row_line(label, &value, width, theme));
            }
        }
        // Groups beyond the six designed rows stay visible, so a grid never
        // hides something the firmware reports.
        for (group, fields) in &state.groups {
            if DESIGNED_GROUPS.contains(&group.as_str()) {
                continue;
            }
            for (key, value) in fields {
                lines.push(row_line(&format!("{group}.{key}"), value, width, theme));
            }
        }
    } else if state.loading {
        lines.push(message(
            theme.fold(s.diag_loading).as_ref(),
            theme.muted(),
            width,
        ));
    } else {
        lines.push(message(s.diag_empty, theme.muted(), width));
    }

    lines.push(Line::from(""));
    lines.push(message(
        theme.fold(s.diag_keys_hint).as_ref(),
        theme.muted(),
        width,
    ));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Transport;
    use crate::event::ConnectionState;

    /// A frame's worth of the sample reply, parsed.
    fn sample_groups() -> InfoGroups {
        parse_info_lines(SAMPLE.iter().copied()).0
    }

    fn connected_app(lang: Lang) -> App {
        App {
            lang,
            state: ConnectionState::Connected,
            transport: Transport::Ble,
            ..App::default()
        }
    }

    /// The text of a rendered body, for assertions about what the pane shows.
    fn body_text(lines: &[Line<'static>]) -> String {
        lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<Vec<_>>()
            .join("")
    }

    /// The documented sample parses into the five groups the grid reads.
    #[test]
    fn parses_the_documented_sample() {
        let (groups, done) = parse_info_lines(SAMPLE.iter().copied());
        assert!(done);
        assert_eq!(groups.len(), 5);
        assert_eq!(groups["fw"]["version"], "0.1.2");
        assert_eq!(groups["fw"]["zephyr"], "4.4.1");
        assert_eq!(groups["sys"]["uptime_ms"], "123456");
        assert_eq!(groups["sys"]["owner"], "0");
        assert_eq!(groups["sys"]["security"], "1");
        assert_eq!(groups["uart"]["dropped"], "0");
        assert_eq!(groups["uart"]["buffer"], "0/16384");
        assert_eq!(groups["wifi"]["state"], "connected");
        assert_eq!(groups["wifi"]["ip"], "ready");
        assert_eq!(groups["upload"]["http"], "201");
        assert_eq!(groups["upload"]["failures"], "0");
        assert_eq!(groups["upload"]["successes"], "4");
    }

    /// Each field splits at its *first* `=` — a value may contain more.
    #[test]
    fn splits_each_key_at_the_first_equals() {
        let mut groups = InfoGroups::new();
        assert!(parse_info_line("@info net path=/a=b=c", &mut groups));
        assert_eq!(groups["net"]["path"], "/a=b=c");
        // A line that is not ours is reported as not ours.
        assert!(!parse_info_line("hello", &mut groups));
        assert!(!parse_info_line("@infodone", &mut groups));
        // A field with no '=' is skipped without corrupting the map.
        assert!(parse_info_line("@info net lone", &mut groups));
        assert!(!groups["net"].contains_key("lone"));
        // `@info done` is recognized and stores nothing.
        assert!(parse_info_line("@info done", &mut groups));
        assert!(!groups.contains_key("done"));
        // A trailing space is not part of the line.
        assert!(parse_info_line("@info fw version=1 \n", &mut groups));
        assert_eq!(groups["fw"]["version"], "1");
    }

    /// Only the terminator sets the flag, and an empty reply sets nothing.
    #[test]
    fn done_is_only_set_by_the_done_line() {
        assert!(!parse_info_lines(["@info fw version=1"]).1);
        assert!(parse_info_lines(["@info done"]).1);
        let (groups, done) = parse_info_lines(Vec::<&str>::new());
        assert!(groups.is_empty());
        assert!(!done);
    }

    /// The six values come out exactly as the web client prints them.
    #[test]
    fn renders_the_web_grid_values_exactly() {
        let groups = sample_groups();
        assert_eq!(fmt_firmware(&groups), "0.1.2 · Z4.4.1");
        assert_eq!(fmt_uptime(&groups), "2m 3s");
        assert_eq!(fmt_ble_access(&groups, Lang::En), "open · link L1");
        assert_eq!(fmt_uart_buffer(&groups), "0/16384 · drop 0");
        assert_eq!(fmt_wifi(&groups), "connected · IP ready · err 0");
        assert_eq!(fmt_upload(&groups), "0 B · HTTP 201 · fail 0");

        let rows = value_rows(&groups, Lang::En);
        assert_eq!(rows.len(), 6);
        assert_eq!(rows[0].0, "Firmware");
        assert_eq!(rows[4].0, "WiFi");
        assert_eq!(rows[5].0, "Upload Queue");

        // The Chinese grid labels reach the render; the values stay the
        // byte-for-byte web formatters.
        let zh = value_rows(&groups, Lang::Zh);
        assert_eq!(zh[0].0, "固件");
        assert_eq!(zh[1].0, "运行时间");
        assert_eq!(zh[2].0, "BLE 访问");
        assert_eq!(zh[2].1, "开放 · 链路 L1");
        assert_eq!(zh[4].0, "WiFi");
        assert_eq!(zh[5].0, "上传队列");
        assert_eq!(zh[0].1, rows[0].1);
    }

    /// The UART buffer row measures the pair the device sent: the meter fills
    /// in proportion, the percentage names the same share, and the drop count
    /// stays on the row.
    #[test]
    fn the_uart_buffer_row_measures_the_share_in_use() {
        let theme = Theme::DARK;
        let row_of = |reply: &[&str], width: u16| {
            let (groups, _) = parse_info_lines(reply.iter().copied());
            uart_buffer_row("UART Buffer", &groups, width, &theme)
        };
        let text_of = |line: &Line<'static>| -> String {
            line.spans.iter().map(|s| s.content.as_ref()).collect()
        };

        let half = row_of(&["@info uart buffer=8192/16384 dropped=2"], 60);
        assert!(
            text_of(&half).contains("8192/16384 █████░░░░░ 50% · drop 2"),
            "{:?}",
            text_of(&half)
        );

        // Full, empty and over-full all read as their own share.
        let full = text_of(&row_of(&["@info uart buffer=16384/16384"], 60));
        assert!(full.contains("100%"), "{full}");
        let empty = text_of(&row_of(&["@info uart buffer=0/16384"], 60));
        assert!(empty.contains("░░░░░░░░░░ 0%"), "{empty}");
        let over = text_of(&row_of(&["@info uart buffer=20000/16384"], 60));
        assert!(over.contains("██████████ 100%"), "{over}");

        // A share near the ceiling wears the warning colour: the bar is the
        // thing that has to catch an eye before the drops do.
        let nearly = row_of(&["@info uart buffer=14746/16384"], 60); // 90%
        let fill = nearly
            .spans
            .iter()
            .find(|span| span.content.contains('█'))
            .expect("the meter is on the row");
        assert_eq!(fill.style.fg, Some(theme.warn));
        let half_fill = half
            .spans
            .iter()
            .find(|span| span.content.contains('█'))
            .expect("the meter is on the row");
        assert_eq!(
            half_fill.style.fg,
            Some(theme.accent),
            "half is not a warning"
        );
    }

    /// A pane without room for the meter, a reply without a pair and a pair
    /// with no denominator all keep the documented row: the meter is an extra,
    /// never a substitute.
    #[test]
    fn the_uart_buffer_row_falls_back_to_the_documented_value() {
        let theme = Theme::DARK;
        let row_of = |reply: &[&str], width: u16| -> String {
            let (groups, _) = parse_info_lines(reply.iter().copied());
            uart_buffer_row("UART Buffer", &groups, width, &theme)
                .spans
                .iter()
                .map(|s| s.content.as_ref())
                .collect()
        };

        // The meter row wants 16 head columns and 34 of value: 40 is short on
        // purpose, and the pane gets the row it always had.
        let narrow = row_of(&["@info uart buffer=8192/16384 dropped=2"], 40);
        assert!(!narrow.contains('█') && !narrow.contains('░'), "{narrow}");
        assert!(narrow.contains("8192/16384 · drop 2"), "{narrow}");

        for reply in [
            &["@info uart dropped=2"][..],
            &["@info uart buffer=ready"][..],
            &["@info uart buffer=0/0"][..],
            &["@info uart buffer=1"][..],
        ] {
            let wide = row_of(reply, 60);
            assert!(
                !wide.contains('█') && !wide.contains('░'),
                "{reply:?} grew a meter: {wide}"
            );
        }
        assert_eq!(
            row_of(&["@info uart dropped=2"], 60),
            "UART Buffer   │ – · drop 2"
        );
    }

    /// The label field is 14 *columns*. A CJK label is two columns per glyph, so
    /// counting characters padded `运行时间` to 18 columns and shoved the
    /// separator four columns right of the English rows.
    #[test]
    fn the_label_field_is_measured_in_columns_not_characters() {
        let theme = Theme::DARK;
        for label in ["Firmware", "运行时间", "BLE 访问", "上传队列", "WiFi"] {
            let line = row_line(label, "value", 40, &theme);
            let width = text::columns(line.spans[0].content.as_ref());
            assert_eq!(width, LABEL_COLUMNS, "label {label:?} occupies {width}");
        }
    }

    /// A grid row carries its label, its value and the separator between them,
    /// and a value too long for the pane is marked rather than spilled.
    #[test]
    fn grid_rows_are_labelled_and_clipped_to_the_width() {
        let theme = Theme::DARK;
        let line = row_line("Firmware", "0.1.2 · Z4.4.1", 40, &theme);
        let joined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(joined.starts_with("Firmware"), "{joined}");
        assert!(joined.contains("│ "), "{joined}");
        assert!(joined.contains("0.1.2 · Z4.4.1"), "{joined}");
        assert!(text::columns(&joined) <= 40, "{joined}");

        let long = row_line("Firmware", &"x".repeat(200), 40, &theme);
        let joined: String = long.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(joined.contains('…'), "{joined}");
        assert_eq!(text::columns(&joined), 40, "{joined}");
    }

    /// A pane narrower than the label field still gets rows that fit it: the
    /// value is dropped and the label field clipped, rather than a row that
    /// spills and wraps.
    #[test]
    fn a_narrow_pane_gets_rows_that_fit_it() {
        let theme = Theme::DARK;
        for width in 0u16..40 {
            for (label, value) in [
                ("Firmware", "0.1.2 · Z4.4.1"),
                ("运行时间", "2m 3s"),
                ("上传队列", "0 B · HTTP 201 · fail 0"),
            ] {
                let line = row_line(label, value, width, &theme);
                let joined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
                assert!(
                    text::columns(&joined) <= width as usize,
                    "{label:?} at {width} came out {joined:?}"
                );
            }
        }
    }

    /// Every bracket of the uptime formatter, and the em dashes before the
    /// device has answered anything.
    #[test]
    fn uptime_formatting_covers_every_bracket() {
        assert_eq!(fmt_uptime_ms(0), "0s");
        assert_eq!(fmt_uptime_ms(5_000), "5s");
        assert_eq!(fmt_uptime_ms(75_000), "1m 15s");
        assert_eq!(fmt_uptime_ms(9_000_000), "2h 30m");
        assert_eq!(fmt_uptime_ms(90_060_000), "1d 1h");

        let empty = InfoGroups::new();
        assert_eq!(fmt_uptime(&empty), "–");
        assert_eq!(fmt_firmware(&empty), "—");
        assert_eq!(fmt_ble_access(&empty, Lang::En), "–");
        assert_eq!(fmt_uart_buffer(&empty), "– · drop 0");
        assert_eq!(fmt_wifi(&empty), "– · IP - · err 0");
        assert_eq!(fmt_upload(&empty), "0 B · HTTP - · fail 0");
    }

    /// A scoped link is worded as such, and a link with no security field keeps
    /// the owner word alone.
    #[test]
    fn ble_access_is_scoped_when_the_owner_is_not_zero() {
        let (groups, _) = parse_info_lines(["@info sys uptime_ms=1 owner=1 security=2"]);
        assert_eq!(fmt_ble_access(&groups, Lang::En), "scoped · link L2");
        assert_eq!(fmt_ble_access(&groups, Lang::Zh), "受限 · 链路 L2");
        let (groups, _) = parse_info_lines(["@info sys uptime_ms=1 owner=1"]);
        assert_eq!(fmt_ble_access(&groups, Lang::En), "scoped");
    }

    /// The WiFi side effect and the IPv4 heuristic the LAN field leans on.
    #[test]
    fn wifi_side_effect_and_ipv4_heuristic() {
        let groups = sample_groups();
        assert_eq!(wifi_from_info(&groups), Some((true, "ready".to_string())));
        assert_eq!(wifi_from_info(&InfoGroups::new()), None);
        let (down, _) = parse_info_lines(["@info wifi state=down ip=10.0.0.4"]);
        assert_eq!(wifi_from_info(&down), Some((false, "10.0.0.4".to_string())));

        assert!(looks_like_ipv4("192.168.1.50"));
        assert!(looks_like_ipv4("127.0.0.1"));
        assert!(!looks_like_ipv4("ready"));
        assert!(!looks_like_ipv4("192.168.1"));
        assert!(!looks_like_ipv4("192.168.1.256"));
        assert!(!looks_like_ipv4("192.168.1.1.1"));
        assert!(!looks_like_ipv4("host.local"));
        assert!(!looks_like_ipv4(""));
    }

    /// A fresh state is empty and needs no terminal, no clock and no session.
    #[test]
    fn a_fresh_state_is_empty() {
        let state = DiagnosticsState::default();
        assert!(!state.has_data());
        assert!(!state.loading);
        assert!(!state.done);
        assert!(state.raw.is_empty());
        assert_eq!(state.updated, None);
        assert_eq!(state.error, None);
    }

    /// Folding a reply in fills the grid, keeps the raw lines and stamps only
    /// the time it was handed.
    #[test]
    fn folding_a_reply_in_stamps_the_time_it_was_handed() {
        let mut state = DiagnosticsState {
            loading: true,
            scroll: 5,
            ..DiagnosticsState::default()
        };
        state.apply(&crate::views::sample_reply(), "19:08:06".to_string());
        assert!(state.has_data());
        assert!(state.done);
        assert!(!state.loading);
        assert_eq!(state.raw.len(), SAMPLE.len());
        assert_eq!(state.updated.as_deref(), Some("19:08:06"));
        assert_eq!(state.scroll, 0, "a fresh read opens at its top");
    }

    /// A reply with no `@info` line must not blank a good grid.
    #[test]
    fn a_reply_without_info_lines_leaves_the_grid_alone() {
        let mut state = DiagnosticsState::default();
        state.apply(&crate::views::sample_reply(), "19:08:06".to_string());
        let before = state.groups.clone();
        state.apply(&["warning: busy".to_string()], "19:08:07".to_string());
        assert_eq!(state.groups, before);
        assert_eq!(state.raw.len(), 1);
        assert!(
            !state.done,
            "no terminator arrived, so the read is unfinished"
        );
        assert_eq!(state.updated.as_deref(), Some("19:08:07"));
    }

    /// The body names itself, says how fresh the read is, and ends with the keys
    /// it answers to — in either language.
    #[test]
    fn the_body_names_itself_and_its_freshness() {
        let theme = Theme::DARK;
        let mut app = connected_app(Lang::En);
        app.diagnostics
            .apply(&crate::views::sample_reply(), "19:08:06".into());
        let text = body_text(&lines(&app, &theme, 60));
        assert!(text.contains("Diagnostics"), "{text}");
        assert!(text.contains("@i? · updated 19:08:06"), "{text}");
        assert!(text.contains("Firmware"), "{text}");
        assert!(text.contains("0.1.2 · Z4.4.1"), "{text}");
        assert!(text.contains("r refresh"), "{text}");

        app.lang = Lang::Zh;
        let text = body_text(&lines(&app, &theme, 60));
        assert!(text.contains("诊断"), "{text}");
        assert!(text.contains("@i? · 已更新 19:08:06"), "{text}");
        assert!(text.contains("固件"), "{text}");
        assert!(text.contains("r 刷新"), "{text}");
    }

    /// With no data the body says which of the three states it is in: never
    /// read, reading, or read and empty. And on a LAN session it says why the
    /// read is impossible, because management commands are BLE-only.
    #[test]
    fn an_empty_body_says_which_state_it_is_in() {
        let theme = Theme::DARK;
        let mut app = connected_app(Lang::En);

        let text = body_text(&lines(&app, &theme, 60));
        assert!(text.contains("@i? not read yet"), "{text}");
        assert!(text.contains("No device information yet."), "{text}");
        assert!(!text.contains("Connect over BLE"), "{text}");

        app.diagnostics.loading = true;
        let text = body_text(&lines(&app, &theme, 60));
        assert!(text.contains("reading @i?…"), "{text}");
        assert!(!text.contains("No device information yet."), "{text}");

        app.diagnostics.loading = false;
        app.diagnostics.error = Some("timed out".to_string());
        let text = body_text(&lines(&app, &theme, 60));
        assert!(text.contains("timed out"), "{text}");

        app.transport = Transport::Lan;
        let text = body_text(&lines(&app, &theme, 60));
        assert!(text.contains("Connect over BLE"), "{text}");
    }

    /// The freshness line is muted, a failure is danger, the missing-BLE
    /// warning is warn, the heading is a section header and the values are body
    /// text: no view ever picks a colour of its own.
    #[test]
    fn the_body_takes_every_colour_from_the_theme() {
        let theme = Theme::DARK;
        let mut app = connected_app(Lang::En);
        app.diagnostics.error = Some("timed out".to_string());
        let painted = lines(&app, &theme, 60);
        let flat: Vec<(String, Option<ratatui::style::Color>)> = painted
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| (span.content.to_string(), span.style.fg))
            .collect();

        let heading = flat.iter().find(|(t, _)| t == "Diagnostics").unwrap();
        assert_eq!(heading.1, Some(theme.accent));
        let freshness = flat
            .iter()
            .find(|(t, _)| t.starts_with("@i? not read"))
            .unwrap();
        assert_eq!(freshness.1, Some(theme.muted));
        let failure = flat.iter().find(|(t, _)| t == "timed out").unwrap();
        assert_eq!(failure.1, Some(theme.danger));
        let hint = flat
            .iter()
            .find(|(t, _)| t.starts_with("r refresh"))
            .unwrap();
        assert_eq!(hint.1, Some(theme.muted));
    }

    /// A group the six designed rows do not cover is still shown: the grid never
    /// hides what the firmware reports.
    #[test]
    fn groups_beyond_the_designed_six_are_still_shown() {
        let theme = Theme::DARK;
        let mut app = connected_app(Lang::En);
        let lines_in = vec![
            "@info fw version=0.1.2".to_string(),
            "@info radio mode=ble mtu=244".to_string(),
            "@info done".to_string(),
        ];
        app.diagnostics.apply(&lines_in, "10:00:00".into());
        let text = body_text(&lines(&app, &theme, 60));
        assert!(text.contains("radio.mode"), "{text}");
        assert!(text.contains("radio.mtu"), "{text}");
        assert!(text.contains("244"), "{text}");
    }

    /// Every row of the body fits the pane it was given, so a narrow centre
    /// column cannot push a row under the sidebar.
    #[test]
    fn every_body_row_fits_the_pane() {
        let theme = Theme::DARK;
        for width in [8u16, 16, 24, 40, 60, 100] {
            for lang in [Lang::Zh, Lang::En] {
                let mut app = connected_app(lang);
                app.diagnostics
                    .apply(&crate::views::sample_reply(), "19:08:06".into());
                for line in lines(&app, &theme, width) {
                    let joined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
                    assert!(
                        text::columns(&joined) <= width as usize,
                        "{width} col {lang:?} row {joined:?} is {} columns",
                        text::columns(&joined)
                    );
                }
            }
        }
    }

    /// The body is a pure function of the state: the same state paints the same
    /// lines every time, and the theme changes colour only.
    #[test]
    fn the_body_is_a_pure_function_of_the_state() {
        let mut app = connected_app(Lang::Zh);
        app.diagnostics
            .apply(&crate::views::sample_reply(), "19:08:06".into());
        let dark = lines(&app, &Theme::DARK, 60);
        let again = lines(&app, &Theme::DARK, 60);
        assert_eq!(dark, again);
        let light = lines(&app, &Theme::LIGHT, 60);
        assert_eq!(dark.len(), light.len());
        let text_of = |rows: &[Line<'static>]| body_text(rows);
        assert_eq!(text_of(&dark), text_of(&light));
    }
}
