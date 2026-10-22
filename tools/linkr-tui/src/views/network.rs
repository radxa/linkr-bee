//! Network view: WiFi and WebDAV management, as the design's
//! `tui_network_zh_dark.png` lays it out (WEB_UX_SPEC section 6).
//!
//! The model is the accessory layer's wire data — a WiFi status, a WebDAV
//! status, scan results — and the painter is the pure function from that data
//! plus a width to the pane's lines. Everything management-channel related is
//! BLE-only, so on a LAN session the view says so rather than showing controls
//! that cannot work.

use ratatui::text::{Line, Span};

use crate::accessory::{BleNameStatus, WebdavStatus, WifiStatus};
use crate::app::App;
use crate::dialogs::{self, ConfirmAction};
use crate::text;
use crate::theme::Theme;

/// One row the network view can be stood on.
///
/// Named rather than numbered because the view draws them in a fixed order but
/// hides the scan results when a network is already joined, and an index that
/// meant "a result" on an unconnected board and "the status row" on a
/// connected one would be a key that does something other than what the
/// highlighted row promises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkRow {
    /// The network's name.
    Ssid,
    /// `@w scan` — ask the board what it can see.
    Scan,
    /// `@w=<ssid>,<password>` — join.
    Connect,
    /// `@w off` — forget.
    WifiOff,
    /// `@w?` — read the status back.
    WifiStatus,
    /// The `index`th network in the scan results. Standing here and pressing
    /// Enter fills the name into the form and hands the keyboard to Connect —
    /// what joining needs next.
    ScanResult(usize),
    /// Where the log goes.
    Url,
    /// `@d=<url>`.
    WebdavSet,
    /// `@d off`.
    WebdavOff,
    /// `@d?`.
    WebdavStatus,
    /// The advertised BLE name, as the last `@n?` reported it.
    BleName,
    /// `@n=<name>`.
    BleNameRename,
    /// `@n default`.
    BleNameDefault,
    /// `@n?`.
    BleNameStatus,
}

/// Every row that is always there, in the order the view draws them.
pub const ROWS: [NetworkRow; 13] = [
    NetworkRow::Ssid,
    NetworkRow::Scan,
    NetworkRow::Connect,
    NetworkRow::WifiOff,
    NetworkRow::WifiStatus,
    NetworkRow::Url,
    NetworkRow::WebdavSet,
    NetworkRow::WebdavOff,
    NetworkRow::WebdavStatus,
    NetworkRow::BleName,
    NetworkRow::BleNameRename,
    NetworkRow::BleNameDefault,
    NetworkRow::BleNameStatus,
];

/// How many of [`ROWS`] come before the scan results. The results are drawn
/// between the WiFi section and the WebDAV one, and they stand there for the
/// keyboard too: the walk is the drawing's order.
const WIFI_ROWS: usize = 5;

impl NetworkRow {
    /// Whether the keyboard can stand here right now.
    ///
    /// A scan result is left out while a network is joined: picking one names
    /// the network to join, and with a network already joined there is nothing
    /// left to name it for.
    fn reachable(self, connected: bool, results: usize) -> bool {
        match self {
            NetworkRow::ScanResult(index) => !connected && index < results,
            _ => true,
        }
    }

    /// The next row down, wrapping.
    fn next(self, connected: bool, results: usize) -> NetworkRow {
        self.step(1, connected, results)
    }

    /// The next row up, wrapping.
    fn previous(self, connected: bool, results: usize) -> NetworkRow {
        self.step(-1, connected, results)
    }

    /// Walk `direction` rows, skipping the ones not reachable now.
    fn step(self, direction: isize, connected: bool, results: usize) -> NetworkRow {
        let count = ROWS.len() + results;
        let here = self.position(results).min(count - 1);
        let mut offset = 1;
        // Bounded by the walk's own length, so a walk with no reachable row
        // but this one comes back here rather than spinning.
        while offset <= count {
            let index =
                (here as isize + direction * offset as isize).rem_euclid(count as isize) as usize;
            let candidate = Self::at(index, results);
            if candidate.reachable(connected, results) {
                return candidate;
            }
            offset += 1;
        }
        self
    }

    /// Where a row stands in the walk, counting the scan results.
    ///
    /// A result that is no longer on the list — the next scan is already
    /// replacing it — stands where the first would have: the walk goes on
    /// from there rather than falling off the table.
    fn position(self, results: usize) -> usize {
        match self {
            NetworkRow::ScanResult(index) => WIFI_ROWS + index.min(results.saturating_sub(1)),
            row => {
                let base = ROWS
                    .iter()
                    .position(|candidate| *candidate == row)
                    .expect("every row is in the table");
                if base < WIFI_ROWS {
                    base
                } else {
                    base + results
                }
            }
        }
    }

    /// The row at a place in the walk.
    fn at(index: usize, results: usize) -> NetworkRow {
        if index < WIFI_ROWS {
            ROWS[index]
        } else if index < WIFI_ROWS + results {
            NetworkRow::ScanResult(index - WIFI_ROWS)
        } else {
            ROWS[index - results]
        }
    }
}

/// Everything the network view knows. Filled by the session layer; read here
/// as plain data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkState {
    /// The device's last reported WiFi status (`@w?`).
    pub wifi: Option<WifiStatus>,
    /// The device's last reported WebDAV status (`@d?`).
    pub webdav: Option<WebdavStatus>,
    /// The device's last reported advertised BLE name (`@n?`).
    pub ble_name: Option<BleNameStatus>,
    /// The SSID typed into the form, echoed back verbatim.
    pub ssid_input: String,
    /// Scan results, as the device reported them.
    pub scan_results: Vec<String>,
    /// A read or action is in flight.
    pub loading: bool,
    /// The last failure, already worded for the reader.
    pub error: Option<String>,
    /// The row the keyboard is on.
    pub focus: NetworkRow,
}

impl Default for NetworkState {
    fn default() -> NetworkState {
        NetworkState {
            wifi: None,
            webdav: None,
            ble_name: None,
            ssid_input: String::new(),
            scan_results: Vec::new(),
            loading: false,
            error: None,
            focus: NetworkRow::Ssid,
        }
    }
}

impl NetworkState {
    /// Whether the WiFi section shows a live connection.
    pub fn wifi_connected(&self) -> bool {
        self.wifi.as_ref().is_some_and(|w| w.state == "connected")
    }

    /// Move the focus down one reachable row.
    pub fn focus_next(&mut self) {
        let connected = self.wifi_connected();
        self.focus = self.focus.next(connected, self.scan_results.len());
    }

    /// Move the focus up one reachable row.
    pub fn focus_previous(&mut self) {
        let connected = self.wifi_connected();
        self.focus = self.focus.previous(connected, self.scan_results.len());
    }

    /// Keep the keyboard on a row that is still there.
    ///
    /// A scan result goes away when the list under the keyboard is replaced —
    /// a new scan clears it before it fills — and one is gone too once a
    /// network is joined, because there is nothing left to name it for. A
    /// keyboard left standing on a row that is no longer drawn takes the next
    /// arrow key somewhere the user did not come from, so it lands on the row
    /// that asked for the scan instead.
    pub fn settle_focus(&mut self) {
        let NetworkRow::ScanResult(index) = self.focus else {
            return;
        };
        if self.scan_results.is_empty() || self.wifi_connected() {
            self.focus = NetworkRow::Scan;
        } else if index >= self.scan_results.len() {
            self.focus = NetworkRow::ScanResult(self.scan_results.len() - 1);
        }
    }
}

/// One `label：value` row, in the design's inset style: two-space indent, the
/// label in focus colour, the value in body text.
fn field_row(label: &str, value: &str, selected: bool, width: u16, theme: &Theme) -> Line<'static> {
    let s = text_of_label_value(label, value);
    if selected {
        // The design paints the selected row as a full chip, marker included.
        let chip = format!("{}{s}", theme.glyphs().cursor());
        return Line::from(Span::styled(
            text::clip_to(&chip, width as usize),
            theme.selected(),
        ));
    }
    let budget = width as usize;
    // The indent never exceeds the row: a field row at width 0 or 1 paints the
    // columns it has, which is what the body's contract asks of every view.
    let indent = 2.min(budget);
    let label_style = theme.focus();
    let mut spans = vec![Span::styled(" ".repeat(indent), theme.text())];
    let label_cols = text::columns(label);
    if indent + label_cols >= budget {
        spans.push(Span::styled(
            text::clip_to(label, budget.saturating_sub(indent)),
            label_style,
        ));
        return Line::from(spans);
    }
    spans.push(Span::styled(label.to_string(), label_style));
    let rest = budget - indent - label_cols;
    spans.push(Span::styled(text::clip_to(value, rest), theme.text()));
    Line::from(spans)
}

fn text_of_label_value(label: &str, value: &str) -> String {
    format!("{label}{value}")
}

/// One `[action]（仅限 BLE）` row.
fn action_row(
    action: &str,
    ble_only: &str,
    selected: bool,
    width: u16,
    theme: &Theme,
) -> Line<'static> {
    let row = format!("  {action}{ble_only}");
    if selected {
        // The marker is added inside the clip rather than outside it: a chip
        // built first and clipped after would lose the action's own name at a
        // narrow width and keep the marker, which is the wrong thing to lose.
        // The chip itself is clipped to the pane in turn, because two columns
        // of marker in a one-column pane are a row wider than its column.
        let chip = format!(
            "{}{}",
            theme.glyphs().cursor(),
            text::clip_to(&row, width.saturating_sub(2) as usize)
        );
        return Line::from(Span::styled(
            text::clip_to(&chip, width as usize),
            theme.selected(),
        ));
    }
    Line::from(Span::styled(
        text::clip_to(&row, width as usize),
        theme.text(),
    ))
}

/// A section heading in the accent colour.
fn heading(text: &str, width: u16, theme: &Theme) -> Line<'static> {
    Line::from(Span::styled(
        text::clip_to(text, width as usize),
        theme.section_header(),
    ))
}

/// A muted note line.
fn note(text: &str, width: u16, theme: &Theme) -> Line<'static> {
    Line::from(Span::styled(
        text::clip_to(text, width as usize),
        theme.muted(),
    ))
}

/// One scan row, split where the colour changes.
struct ScanRow {
    /// The reading, when the firmware gave one. `None` means no dots are
    /// invented, and the name pulls two columns left of the ones below it —
    /// behind a meter that was not there, a gap between nothing and the name
    /// would read as a reading that failed to arrive.
    dbm: Option<i32>,
    /// The dots and the reading, or the blank the name lines up behind.
    meter: String,
    /// Between the meter and the name: two columns, except behind a meter
    /// that was not there.
    gap: &'static str,
    /// The name, and whatever the firmware wrote after it.
    tail: String,
}

/// One scan row: the meter and the reading in front, then the name, then the
/// radio's own notes.
///
/// The signal moves to the front because a list is read as a ranking — which
/// of these is worth joining — and a number at the end of a row that may be
/// clipped off is a number nobody sees.
///
/// Split into parts rather than painted as one string, because the meter is
/// the one piece that does not wear the muted grey: see
/// [`Theme::signal_style`] for why a meter in the dim colour disappears in
/// half the themes a user can pick.
fn scan_row(result: &str, glyphs: crate::capability::GlyphSet) -> ScanRow {
    let crate::accessory::WifiResult {
        name,
        signal_dbm,
        rest,
    } = crate::accessory::parse_wifi_result(result);
    let tail = if rest.is_empty() {
        name
    } else {
        format!("{name} {rest}")
    };
    match signal_dbm {
        Some(dbm) => ScanRow {
            dbm: Some(dbm),
            meter: format!(
                "{} {:>4}dBm",
                text::signal_bars_with(dbm, glyphs.dots()),
                dbm
            ),
            gap: "  ",
            tail,
        },
        None => ScanRow {
            dbm: None,
            meter: format!("{:12}", ""),
            gap: "",
            tail,
        },
    }
}

/// The whole body. The order is the design's: WiFi (note, ssid, password,
/// actions), then the scan results.
pub fn lines(app: &App, theme: &Theme, width: u16) -> Vec<Line<'static>> {
    document(app, theme, width).0
}

/// Keep the selected control visible even after a long WiFi scan.
pub fn visible_lines(app: &App, theme: &Theme, width: u16, height: u16) -> Vec<Line<'static>> {
    let (lines, focused_line) = document(app, theme, width);
    let height = usize::from(height);
    let offset = (focused_line + 1)
        .saturating_sub(height)
        .min(lines.len().saturating_sub(height));
    lines.into_iter().skip(offset).take(height).collect()
}

/// Build the rows and their focus position together, so status/error rows
/// cannot make scrolling point at a different control.
fn document(app: &App, theme: &Theme, width: u16) -> (Vec<Line<'static>>, usize) {
    let s = app.strings();
    let state = &app.network;
    let mut focused_line = 0;
    let mut lines = vec![
        Line::from(""),
        heading(
            app.lang.view_name(crate::event::View::Network),
            width,
            theme,
        ),
        Line::from(""),
        heading(s.net_wifi_section, width, theme),
        note(s.net_wifi_needs_ble, width, theme),
    ];

    if state.loading {
        lines.push(note(&theme.fold(s.diag_loading), width, theme));
    }
    if let Some(error) = &state.error {
        lines.push(Line::from(Span::styled(
            text::clip_to(error, width as usize),
            theme.danger(),
        )));
    }

    // A live connection replaces the form with the connected summary; a
    // connected network's name is shown where the input field was.
    let connected = state.wifi_connected();
    let results = state.scan_results.len();
    let on = |row: NetworkRow| state.focus == row && row.reachable(connected, results);
    // The placeholder is the rule the interface uses for "nothing here", in the
    // set the terminal has — the same mark the diagnostics grid shows.
    let empty = theme.glyphs().dash();
    let ssid_value = if connected {
        state
            .wifi
            .as_ref()
            .map(|w| {
                if w.ssid.is_empty() {
                    empty
                } else {
                    w.ssid.as_str()
                }
            })
            .unwrap_or(empty)
    } else if state.ssid_input.is_empty() {
        empty
    } else {
        state.ssid_input.as_str()
    };
    if on(NetworkRow::Ssid) {
        focused_line = lines.len();
    }
    lines.push(field_row(
        &format!("{}{}", s.net_ssid_label, s.label_separator),
        ssid_value,
        on(NetworkRow::Ssid),
        width,
        theme,
    ));
    for (row, label) in [
        (NetworkRow::Scan, s.net_scan),
        (NetworkRow::Connect, s.net_connect),
        (NetworkRow::WifiOff, s.net_wifi_off),
        (NetworkRow::WifiStatus, s.net_status),
    ] {
        if on(row) {
            focused_line = lines.len();
        }
        lines.push(action_row(label, s.net_ble_only, on(row), width, theme));
    }

    // The state row, once the device has answered `@w?`.
    if let Some(wifi) = &state.wifi {
        let state_word = if wifi.state == "connected" {
            s.net_state_on
        } else if wifi.state == "off" {
            s.net_state_off
        } else {
            &wifi.state
        };
        let ip = if wifi.ip.is_empty() { "-" } else { &wifi.ip };
        lines.push(note(
            &format!("WiFi: {state_word}{}IP {ip}", theme.glyphs().dot_sep()),
            width,
            theme,
        ));
    }

    lines.push(Line::from(""));
    lines.push(heading(s.net_results_section, width, theme));
    if state.scan_results.is_empty() {
        lines.push(note(&format!("  {}", s.net_no_results), width, theme));
    } else {
        for (index, result) in state.scan_results.iter().enumerate() {
            let row = scan_row(result, theme.glyphs());
            if on(NetworkRow::ScanResult(index)) {
                focused_line = lines.len();
                // The chip, as the form's fields wear it: the keyboard is
                // here, and what pressing Enter takes is the name inside the
                // line. One style throughout, selected: a chip is one surface,
                // and a meter painted a strength colour on it would be a smudge
                // on the highlight.
                let chip = format!(
                    "{}{}{}{}",
                    theme.glyphs().cursor(),
                    row.meter,
                    row.gap,
                    row.tail
                );
                lines.push(Line::from(Span::styled(
                    text::clip_to(&chip, width as usize),
                    theme.selected(),
                )));
            } else {
                // Two spans, one row: the meter wears the strength ladder, the
                // name stays muted. A row drawn in one dim colour is a row
                // whose signal is invisible in the themes where that colour is
                // nearly the panel. The meter is clipped first and the name
                // takes what is left, so the row still fits the pane.
                let meter_style = match row.dbm {
                    Some(dbm) => theme.signal_style(dbm),
                    None => theme.muted(),
                };
                let meter = text::clip_to(&format!("  {}", row.meter), width as usize);
                let room = (width as usize).saturating_sub(text::columns(&meter));
                let tail = text::clip_to(&format!("{}{}", row.gap, row.tail), room);
                lines.push(Line::from(vec![
                    Span::styled(meter, meter_style),
                    Span::styled(tail, theme.muted()),
                ]));
            }
        }
    }

    lines.push(Line::from(""));
    lines.push(heading(s.net_webdav_section, width, theme));
    let url = state
        .webdav
        .as_ref()
        .map(|d| d.url.as_str())
        .filter(|u| !u.is_empty())
        .unwrap_or(empty);
    if on(NetworkRow::Url) {
        focused_line = lines.len();
    }
    lines.push(field_row(
        &format!("{}{}", s.net_url_label, s.label_separator),
        url,
        on(NetworkRow::Url),
        width,
        theme,
    ));
    for (row, word) in [
        (NetworkRow::WebdavSet, s.net_set),
        (NetworkRow::WebdavOff, s.net_disable),
        (NetworkRow::WebdavStatus, s.net_webdav_status),
    ] {
        if on(row) {
            focused_line = lines.len();
        }
        lines.push(action_row(word, s.net_ble_only, on(row), width, theme));
    }
    if let Some(dav) = &state.webdav {
        let state_word = if dav.state == "off" {
            s.net_state_off
        } else {
            &dav.state
        };
        lines.push(note(&format!("WebDAV: {state_word}"), width, theme));
    }

    lines.push(Line::from(""));
    lines.push(heading(s.net_ble_name_section, width, theme));
    lines.push(note(s.net_ble_name_hint, width, theme));
    let ble_name = state
        .ble_name
        .as_ref()
        .map(|name| name.name.as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(empty);
    if on(NetworkRow::BleName) {
        focused_line = lines.len();
    }
    lines.push(field_row(
        &format!("{}{}", s.net_ble_name_label, s.label_separator),
        ble_name,
        on(NetworkRow::BleName),
        width,
        theme,
    ));
    for (row, word) in [
        (NetworkRow::BleNameRename, s.net_ble_name_rename),
        (NetworkRow::BleNameDefault, s.net_ble_name_default_action),
        (NetworkRow::BleNameStatus, s.net_ble_name_status_action),
    ] {
        if on(row) {
            focused_line = lines.len();
        }
        lines.push(action_row(word, s.net_ble_only, on(row), width, theme));
    }
    if let Some(name) = &state.ble_name {
        let source = match name.custom {
            Some(true) => s.net_ble_name_custom,
            Some(false) => s.net_ble_name_default,
            None => "",
        };
        lines.push(note(
            &if source.is_empty() {
                format!("BLE: {}", name.name)
            } else {
                format!("BLE: {} ({source})", name.name)
            },
            width,
            theme,
        ));
    }

    lines.push(Line::from(""));
    lines.push(note(&theme.fold(s.net_keys_hint), width, theme));
    (lines, focused_line)
}

/// Handle one key press while the network view has the keyboard.
///
/// The view is a form, so it takes the arrow keys for itself; everything else
/// it does not understand is left for the caller, which is what keeps the
/// global chords working here.
///
/// A row that would change how the bridge is set up does not do it directly: it
/// raises the approval card naming the change. Joining a network is not undoable
/// — the board drops off the old one before it is on the new one — and a form
/// that changed the device as you walked down it would be a form nobody dared
/// use.
pub fn handle_key(app: &mut App, key: crossterm::event::KeyEvent) -> bool {
    use crossterm::event::{KeyCode, KeyModifiers};
    let plain = key.modifiers == KeyModifiers::NONE || key.modifiers == KeyModifiers::SHIFT;
    if plain && key.code == KeyCode::Down {
        app.network.focus_next();
        return true;
    }
    if plain && key.code == KeyCode::Up {
        app.network.focus_previous();
        return true;
    }
    if key.code == KeyCode::Enter && key.modifiers == KeyModifiers::NONE {
        activate(app);
        return true;
    }
    false
}

/// Do what the focused row says.
fn activate(app: &mut App) {
    use crate::device::Query;
    // A scan result is not reachable while a network is joined, so a focus
    // left on one by an earlier state is moved rather than acted on: picking
    // one names the network to join, and with a network joined there is
    // nothing to name it for.
    let row = app.network.focus;
    if app.network.wifi_connected() && matches!(row, NetworkRow::ScanResult(_)) {
        app.network.focus = NetworkRow::Scan;
        return;
    }
    match row {
        NetworkRow::Ssid => crate::dialogs::prompt_wifi_ssid(app),
        // The name is in the form, so joining it is the password: asking for a
        // name the user can see on the row above would be asking twice. With no
        // name there is nothing to password, and the name is the question.
        NetworkRow::Connect => {
            if app.network.ssid_input.trim().is_empty() {
                dialogs::prompt_wifi_ssid(app);
            } else {
                dialogs::prompt_wifi_password(app);
            }
        }
        NetworkRow::ScanResult(index) => {
            // The line is the radio's note about a network; the name inside it
            // is what the form wants. The keyboard moves to Connect, because
            // joining is what is next — the name is now on the row above,
            // where the form shows it.
            if let Some(result) = app.network.scan_results.get(index) {
                app.network.ssid_input = crate::accessory::wifi_name_of(result);
                app.network.focus = NetworkRow::Connect;
            }
        }
        // A scan is a read, and the note above this match says why that
        // matters: a card asking permission to look at something is a card
        // that teaches people to press yes without reading. The command in
        // the card's prompt would have been `@w scan` — gadget talk nobody
        // outside this codebase types.
        NetworkRow::Scan => {
            if let Err(why) = app.scan_wifi() {
                app.push_notice(crate::app::Notice {
                    text: why,
                    level: crate::event::NoticeLevel::Error,
                });
            }
        }
        NetworkRow::WifiOff => dialogs::ask(app, ConfirmAction::Accessory("@w off".to_string())),
        NetworkRow::Url | NetworkRow::WebdavSet => dialogs::prompt_webdav_url(app),
        NetworkRow::WebdavOff => dialogs::ask(app, ConfirmAction::Accessory("@d off".to_string())),
        // Reads are not guarded: they change nothing, and a card asking
        // permission to look at something is a card that teaches people to
        // press yes without reading.
        NetworkRow::WifiStatus => {
            if let Err(why) = app.ask_device(Query::Wifi) {
                app.push_notice(crate::app::Notice {
                    text: why,
                    level: crate::event::NoticeLevel::Error,
                });
            }
        }
        NetworkRow::WebdavStatus => {
            if let Err(why) = app.ask_device(Query::Webdav) {
                app.push_notice(crate::app::Notice {
                    text: why,
                    level: crate::event::NoticeLevel::Error,
                });
            }
        }
        NetworkRow::BleName | NetworkRow::BleNameRename => dialogs::prompt_ble_name(app),
        NetworkRow::BleNameDefault => dialogs::ask(
            app,
            ConfirmAction::Accessory(crate::accessory::reset_ble_name_command()),
        ),
        NetworkRow::BleNameStatus => {
            if let Err(why) = app.ask_device(Query::BleName) {
                app.push_notice(crate::app::Notice {
                    text: why,
                    level: crate::event::NoticeLevel::Error,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Transport;
    use crate::dialogs::{Dialog, PromptAction};
    use crate::event::ConnectionState;
    use crate::i18n::Lang;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn app(lang: Lang) -> App {
        App {
            lang,
            state: ConnectionState::Connected,
            transport: Transport::Ble,
            ..App::default()
        }
    }

    fn body_text(rows: &[Line<'static>]) -> String {
        rows.iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<Vec<_>>()
            .join("")
    }

    /// The design's rows all appear, in its order, in Chinese.
    #[test]
    fn the_body_matches_the_designed_sections() {
        let theme = Theme::DARK;
        let mut a = app(Lang::Zh);
        a.network.wifi = Some(WifiStatus {
            state: "off".into(),
            ssid: String::new(),
            ip: String::new(),
        });
        let text = body_text(&lines(&a, &theme, 80));
        for needle in [
            "网络",
            "WiFi",
            "网络名称",
            "[扫描]",
            "[连接 WiFi]",
            "[WiFi 关闭]",
            "[WiFi 状态]",
            "扫描结果",
            "暂无结果",
            "仅限 BLE",
            "BLE 广播名",
            "[修改名称]",
            "[恢复默认]",
            "[读取名称]",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in {text:?}");
        }
    }

    /// The English wording differs and carries the same structure.
    #[test]
    fn the_body_is_translated() {
        let theme = Theme::DARK;
        let a = app(Lang::En);
        let text = body_text(&lines(&a, &theme, 80));
        assert!(text.contains("Network name"), "{text}");
        assert!(text.contains("[Scan]"), "{text}");
        assert!(text.contains("(BLE only)"), "{text}");
        assert!(text.contains("Scan results"), "{text}");
    }

    /// A connected network shows its live summary, and the form stops asking
    /// for a password it would have nothing to do with.
    #[test]
    fn a_connected_network_shows_its_summary() {
        let theme = Theme::DARK;
        let mut a = app(Lang::En);
        a.network.wifi = Some(WifiStatus {
            state: "connected".into(),
            ssid: "MyNet".into(),
            ip: "192.168.1.5".into(),
        });
        let text = body_text(&lines(&a, &theme, 80));
        assert!(text.contains("MyNet"), "{text}");
        assert!(text.contains("192.168.1.5"), "{text}");
        assert!(!text.contains("Password"), "{text}");
    }

    /// Scan results are listed, ranked by signal: the dots and the reading in
    /// front, then the name, then the radio's own notes.
    #[test]
    fn scan_results_are_listed() {
        let theme = Theme::DARK;
        let mut a = app(Lang::En);
        a.network.scan_results = vec!["Home wpa2 ch=6 -48dBm".into(), "Office".into()];
        let text = body_text(&lines(&a, &theme, 80));
        assert!(text.contains("Home"), "{text}");
        assert!(text.contains("Office"), "{text}");
        assert!(
            text.contains("●●●●  -48dBm  Home wpa2 ch=6"),
            "the row leads with the signal it was heard at: {text}"
        );
        assert!(!text.contains("no results yet"), "{text}");
    }

    /// The meter is not painted in the row's muted grey: in three of the six
    /// themes that grey sits within a whisker of the panel, and the meter then
    /// goes missing — which is the report this answers.
    #[test]
    fn the_scan_meter_is_painted_to_be_seen() {
        let theme = Theme::SOLARIZED;
        let mut a = app(Lang::En);
        a.network.scan_results = vec!["Home wpa2 ch=6 -48dBm".into()];
        let painted = lines(&a, &theme, 80);
        let row = painted
            .iter()
            .find(|line| line.spans.iter().any(|span| span.content.contains("Home")))
            .expect("the scan row");
        let meter = &row.spans[0];
        assert!(meter.content.contains("●●●●"), "{:?}", meter.content);
        assert_eq!(
            meter.style.fg,
            theme.signal_style(-48).fg,
            "the meter wears the strength ladder"
        );
        let ink = meter.style.fg.expect("a painted colour");
        let ratio = crate::theme::contrast_ratio(ink, theme.panel).expect("both are RGB");
        assert!(ratio >= 3.0, "the meter is {ratio:.2}:1 against its panel");
    }

    /// The focus walks the rows in the order they draw, and steps off what the
    /// state has taken away — a row that did nothing when pressed would be
    /// worse than a row that is not there.
    #[test]
    fn the_focus_walks_the_reachable_rows() {
        let mut state = NetworkState::default();
        assert_eq!(state.focus, NetworkRow::Ssid);
        for expected in [
            NetworkRow::Scan,
            NetworkRow::Connect,
            NetworkRow::WifiOff,
            NetworkRow::WifiStatus,
            NetworkRow::Url,
            NetworkRow::WebdavSet,
            NetworkRow::WebdavOff,
            NetworkRow::WebdavStatus,
            NetworkRow::BleName,
            NetworkRow::BleNameRename,
            NetworkRow::BleNameDefault,
            NetworkRow::BleNameStatus,
            NetworkRow::Ssid,
        ] {
            state.focus_next();
            assert_eq!(state.focus, expected);
        }
        state.focus_previous();
        assert_eq!(state.focus, NetworkRow::BleNameStatus);

        // With a network joined the results are unreachable, and the walk
        // never lands on one.
        state.scan_results = vec!["One open".into()];
        state.wifi = Some(WifiStatus {
            state: "connected".into(),
            ssid: "Up".into(),
            ip: "10.0.0.1".into(),
        });
        state.focus = NetworkRow::ScanResult(0);
        state.settle_focus();
        assert_eq!(state.focus, NetworkRow::Scan, "a vanished result steps off");
        state.focus_next();
        assert_eq!(
            state.focus,
            NetworkRow::Connect,
            "results are not walked into"
        );
    }

    /// The focus wraps, so walking up from the first row lands on the last and
    /// the keyboard never reaches a dead end.
    #[test]
    fn the_focus_wraps_at_both_ends() {
        let mut state = NetworkState::default();
        state.focus_previous();
        assert_eq!(state.focus, NetworkRow::BleNameStatus);
        state.focus_next();
        assert_eq!(state.focus, NetworkRow::Ssid);
    }

    /// A scan's results are rows the keyboard can stand on: they are drawn
    /// under the WiFi section, and the walk goes through them on its way round.
    #[test]
    fn the_focus_walks_the_scan_results() {
        let mut state = NetworkState {
            scan_results: vec!["One wpa2 ch=6 -48dBm".into(), "Two open".into()],
            focus: NetworkRow::WifiStatus,
            ..NetworkState::default()
        };
        state.focus_next();
        assert_eq!(state.focus, NetworkRow::ScanResult(0));
        state.focus_next();
        assert_eq!(state.focus, NetworkRow::ScanResult(1));
        state.focus_next();
        assert_eq!(
            state.focus,
            NetworkRow::Url,
            "and the walk comes back round to the form"
        );
        state.focus_previous();
        assert_eq!(state.focus, NetworkRow::ScanResult(1));
    }

    /// With a network joined there is nothing to pick a name for: the results
    /// are notes, and the walk steps over them as it steps over every row the
    /// joined state has taken away.
    #[test]
    fn a_joined_network_steps_over_the_results() {
        let mut state = NetworkState::default();
        state.scan_results = vec!["One open".into()];
        state.wifi = Some(WifiStatus {
            state: "connected".into(),
            ssid: "Up".into(),
            ip: "10.0.0.1".into(),
        });
        state.focus = NetworkRow::WifiStatus;
        state.focus_next();
        assert_eq!(state.focus, NetworkRow::Url);
        state.focus_previous();
        assert_eq!(state.focus, NetworkRow::WifiStatus);
    }

    /// A result that is gone is not a row to stand on: a new scan empties the
    /// list under the keyboard, and the keyboard lands on the row that asked
    /// for it rather than on nothing.
    #[test]
    fn the_focus_leaves_a_vanished_result() {
        let mut state = NetworkState {
            scan_results: vec!["One open".into(), "Two open".into()],
            focus: NetworkRow::ScanResult(0),
            ..NetworkState::default()
        };
        state.scan_results.clear();
        state.settle_focus();
        assert_eq!(state.focus, NetworkRow::Scan);
        // A shorter list keeps the keyboard on the last row that is there.
        state.scan_results = vec!["One open".into()];
        state.focus = NetworkRow::ScanResult(1);
        state.settle_focus();
        assert_eq!(state.focus, NetworkRow::ScanResult(0));
    }

    /// Pressing a scan result is the form's first half: the name goes into the
    /// network-name field and the keyboard moves on to Connect — which is what
    /// taking the name to the bridge needs.
    #[test]
    fn taking_a_scan_result_fills_the_name_and_moves_to_connect() {
        let mut a = app(Lang::En);
        a.network.scan_results = vec!["My Home Network wpa2 ch=6 -48dBm".into()];
        a.network.focus = NetworkRow::ScanResult(0);
        assert!(handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
        ));
        assert_eq!(a.network.ssid_input, "My Home Network");
        assert_eq!(a.network.focus, NetworkRow::Connect);
        // Enter there prompts for the password — the name is on the row above
        // the keyboard, and asking again would be asking twice.
        assert!(handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
        ));
        let Some(Dialog::Prompt(prompt)) = &a.dialog else {
            panic!("the password prompt came up: {:?}", a.dialog);
        };
        assert_eq!(prompt.action, PromptAction::WifiPassword);
    }

    /// A named form is not asked for the name again: joining is the password,
    /// and with no name there is nothing to join, so the name is the question.
    #[test]
    fn a_named_form_asks_for_the_password_not_the_name() {
        let mut a = app(Lang::En);
        a.network.ssid_input = "BenchNet".into();
        a.network.focus = NetworkRow::Connect;
        assert!(handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
        ));
        let Some(Dialog::Prompt(prompt)) = &a.dialog else {
            panic!("the password prompt came up: {:?}", a.dialog);
        };
        assert_eq!(prompt.action, PromptAction::WifiPassword);

        a.dialog = None;
        a.network.ssid_input.clear();
        assert!(handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
        ));
        let Some(Dialog::Prompt(prompt)) = &a.dialog else {
            panic!("the name prompt came up: {:?}", a.dialog);
        };
        assert_eq!(prompt.action, PromptAction::WifiSsid);
    }

    /// The keyboard's result row wears the chip, as the form's fields do: the
    /// list says which network pressing Enter would take.
    #[test]
    fn the_focused_scan_result_is_marked() {
        let theme = Theme::DARK;
        let mut a = app(Lang::En);
        a.network.scan_results = vec!["Home wpa2 ch=6 -48dBm".into(), "Office open".into()];
        a.network.focus = NetworkRow::ScanResult(1);
        let painted = lines(&a, &theme, 60);
        let chip = painted
            .iter()
            .flat_map(|line| line.spans.iter())
            .find(|span| span.content.contains("Office"))
            .expect("the row was painted");
        assert_eq!(chip.style, theme.selected(), "the chip marks the keyboard");
        let home = painted
            .iter()
            .flat_map(|line| line.spans.iter())
            .find(|span| span.content.contains("Home"))
            .expect("the other row was painted");
        assert_ne!(home.style, theme.selected(), "and only one row wears it");
    }

    /// Enter on a row that changes the bridge asks first, and the card names
    /// the change rather than the command — the command carries the password.
    #[test]
    fn a_change_row_asks_before_it_changes_anything() {
        let mut a = app(Lang::En);
        a.network.focus = NetworkRow::WifiOff;
        assert!(handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
        ));
        let Some(Dialog::Confirm(card)) = &a.dialog else {
            panic!("the approval card came up: {:?}", a.dialog);
        };
        assert!(
            card.prompt.contains("WiFi") && !card.prompt.contains("@w"),
            "the card words the change: {:?}",
            card.prompt
        );
        assert_eq!(card.action, ConfirmAction::Accessory("@w off".to_string()));
        assert!(!card.yes, "and defaults to not doing it");
    }

    /// Enter on a read asks the bridge at once: a read changes nothing, and a
    /// card asking permission to look at something teaches people to press yes
    /// without reading.
    #[test]
    fn a_read_row_just_reads() {
        let mut a = app(Lang::En);
        a.network.focus = NetworkRow::WifiStatus;
        assert!(handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
        ));
        // Not connected, so the refusal is the answer — but it is a refusal and
        // not a card, which is the point.
        assert!(a.dialog.is_none(), "no card for a read");
        assert!(
            a.network.error.is_none(),
            "and nothing was said to be wrong"
        );
    }

    /// The advertised-name section shows what `@n?` read, offers the three
    /// actions, and puts the name into the prompt so a correction is small.
    #[test]
    fn the_ble_name_section_shows_its_actions_and_prefills_the_prompt() {
        let theme = Theme::DARK;
        let mut a = app(Lang::Zh);
        a.network.ble_name = Some(BleNameStatus {
            name: "测试😀".into(),
            custom: Some(true),
        });
        let text = body_text(&lines(&a, &theme, 80));
        for needle in [
            "BLE 广播名",
            "测试😀",
            "[修改名称]",
            "[恢复默认]",
            "[读取名称]",
            "自定义",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in {text:?}");
        }
        a.network.focus = NetworkRow::BleNameRename;
        assert!(handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
        ));
        let Some(Dialog::Prompt(prompt)) = &a.dialog else {
            panic!("the name prompt came up: {:?}", a.dialog);
        };
        assert_eq!(prompt.action, PromptAction::BleName);
        assert_eq!(prompt.field.answer(), "测试😀");
    }

    /// The read action asks the bridge at once, and the default action asks
    /// first because it writes a persisted value.
    #[test]
    fn ble_name_reads_are_direct_and_changes_are_confirmed() {
        let mut a = app(Lang::En);
        a.network.focus = NetworkRow::BleNameStatus;
        assert!(handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
        ));
        assert!(a.dialog.is_none(), "no card for a read");

        a.network.focus = NetworkRow::BleNameDefault;
        assert!(handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
        ));
        let Some(Dialog::Confirm(card)) = &a.dialog else {
            panic!("the approval card came up: {:?}", a.dialog);
        };
        assert_eq!(
            card.action,
            ConfirmAction::Accessory("@n default".to_string())
        );
    }

    /// A key the view does not use is left for the caller, so the global chords
    /// and the device's own keystrokes still work here.
    #[test]
    fn keys_the_view_does_not_use_are_left_alone() {
        let mut a = app(Lang::En);
        assert!(!handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE)
        ));
        assert!(!handle_key(
            &mut a,
            KeyEvent::new(KeyCode::Down, KeyModifiers::CONTROL)
        ));
    }

    /// Every row fits the pane it was given, in both languages, at any width.
    #[test]
    fn every_row_fits_the_pane() {
        let theme = Theme::DARK;
        for width in [8u16, 20, 40, 60, 100] {
            for lang in [Lang::Zh, Lang::En] {
                let mut a = app(lang);
                a.network.wifi = Some(WifiStatus {
                    state: "connected".into(),
                    ssid: "Some-Net".into(),
                    ip: "10.0.0.4".into(),
                });
                a.network.scan_results = vec!["A-very-long-network-name-indeed".into()];
                for line in lines(&a, &theme, width) {
                    let joined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
                    assert!(
                        text::columns(&joined) <= width as usize,
                        "{lang:?} at {width}: {joined:?}"
                    );
                }
            }
        }
    }

    /// An error is painted in the danger colour; the notes are muted.
    #[test]
    fn colours_come_from_the_theme() {
        let theme = Theme::DARK;
        let mut a = app(Lang::En);
        a.network.error = Some("timed out".into());
        let painted = lines(&a, &theme, 60);
        let flat: Vec<(String, Option<ratatui::style::Color>)> = painted
            .iter()
            .flat_map(|l| l.spans.iter())
            .map(|s| (s.content.to_string(), s.style.fg))
            .collect();
        let err = flat.iter().find(|(t, _)| t == "timed out").unwrap();
        assert_eq!(err.1, Some(theme.danger));
        let head = flat.iter().find(|(t, _)| t == "WiFi").unwrap();
        assert_eq!(head.1, Some(theme.accent));
    }
}
