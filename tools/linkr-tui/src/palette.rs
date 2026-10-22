//! The command palette (`Ctrl+P`): everything the interface can do, in one
//! searchable list — opened on the rows the user reaches for all day, with the
//! rest gathered into a window per category rather than buried under a single
//! "more".
//!
//! The registry is a plain `&'static [Action]`, so a test can assert its
//! completeness and its order without building an `App`. An action is a
//! function pointer rather than a message: the palette runs the same code the
//! keyboard shortcut runs, so the two can never diverge — a palette entry that
//! only *described* an action would be a second, untested implementation of it.
//!
//! Only actions that do something are listed. A registry padded out with
//! features that are not built is worse than a short one: the user cannot tell
//! a stubbed entry from a broken one.

use std::borrow::Cow;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

use crate::app::{App, Focus};
use crate::event::View;
use crate::i18n::{entry, Entry, Lang};
use crate::text::{self, fill};

/// The overlay's own vocabulary, next to the code that paints it.
const TITLE: Entry = [" Command palette (Ctrl+P) ", " 命令面板（Ctrl+P） "];
const NO_MATCH: Entry = ["No matching action.", "无匹配动作。"];
const SHORTCUT_HINT: Entry = ["run", "执行"];
const KEYS: Entry = [
    "↑↓ choose · Enter run · Esc close",
    "↑↓ 选择 · Enter 执行 · Esc 关闭",
];
/// The legend in a section's window, where Esc steps back up rather than out.
const KEYS_BACK: Entry = [
    "↑↓ choose · Enter run · Esc back",
    "↑↓ 选择 · Enter 执行 · Esc 返回",
];
const MSG_SAVED_LOG: Entry = ["Saved {} bytes to {}", "已保存 {} 字节到 {}"];
const MSG_SAVE_FAILED: Entry = ["Save failed: {}", "保存失败：{}"];

// Categories.
const CAT_VIEW: Entry = ["View", "视图"];
const CAT_FOCUS: Entry = ["Focus", "焦点"];
const CAT_CONNECTION: Entry = ["Connection", "连接"];
const CAT_TERMINAL: Entry = ["Terminal", "终端"];
const CAT_APP: Entry = ["App", "应用"];
const CAT_AGENT: Entry = ["Assistant", "助手"];
const CAT_NETWORK: Entry = ["Network", "网络"];

const T_WIFI_CONFIG: Entry = ["Set the WiFi network", "设置无线网络"];
const T_WIFI_SCAN: Entry = ["Scan for WiFi networks", "扫描无线网络"];
const T_WIFI_STATUS: Entry = ["Read the WiFi status", "读取无线状态"];
const T_WIFI_OFF: Entry = ["Forget the WiFi network", "断开无线网络"];
const T_WEBDAV_CONFIG: Entry = ["Set the WebDAV upload URL", "设置 WebDAV 上传地址"];
const T_WEBDAV_STATUS: Entry = ["Read the WebDAV status", "读取 WebDAV 状态"];
const T_WEBDAV_OFF: Entry = ["Turn WebDAV upload off", "关闭 WebDAV 上传"];

const T_AGENT_CONFIG: Entry = ["Configure the assistant", "配置助手"];
const T_AGENT_ASK: Entry = ["Ask the assistant", "向助手提问"];
const T_AGENT_NOTE: Entry = ["Write a note", "写一条笔记"];
const T_AGENT_MODE: Entry = ["Change execution mode", "切换执行模式"];
const T_AGENT_REPORT: Entry = ["Export diagnostic report", "导出排查报告"];
const T_AGENT_PANEL: Entry = ["Show or hide the assistant panel", "显示或隐藏助手面板"];
const T_AGENT_NEW: Entry = ["New conversation", "新建对话"];
const T_AGENT_PREV: Entry = ["Previous conversation", "上一个对话"];
const T_AGENT_NEXT: Entry = ["Next conversation", "下一个对话"];
const T_AGENT_DELETE: Entry = ["Delete the conversation", "删除对话"];
const T_AGENT_COPY: Entry = ["Copy the conversation", "复制对话"];
const T_SIDEBAR: Entry = ["Show or hide the sidebar", "显示或隐藏侧栏"];
const T_COPY: Entry = ["Copy the screen", "复制屏幕"];

// Titles.
const T_VIEW_TERMINAL: Entry = ["Open terminal view", "打开终端视图"];
const T_VIEW_DIAGNOSTICS: Entry = ["Open diagnostics view", "打开诊断视图"];
const T_VIEW_NETWORK: Entry = ["Open network view", "打开网络视图"];
const T_VIEW_ASSISTANT: Entry = ["Open assistant view", "打开助手视图"];
const T_FOCUS_SIDEBAR: Entry = ["Focus the sidebar", "聚焦侧栏"];
const T_FOCUS_TERMINAL: Entry = ["Focus the terminal", "聚焦终端"];
const T_CONNECT: Entry = ["Connect", "连接"];
const T_DISCONNECT: Entry = ["Disconnect", "断开连接"];
const T_TRANSPORT: Entry = ["Switch the transport", "切换传输方式"];
const T_UART_SETTINGS: Entry = ["UART settings…", "UART 设置…"];
const T_AUTOSCROLL: Entry = ["Toggle autoscroll", "切换自动滚动"];
const T_ECHO: Entry = ["Toggle local echo", "切换本地回显"];
const T_ENTER_MODE: Entry = ["Cycle Enter mode", "循环切换回车模式"];
const T_DEBUG_IO: Entry = ["Toggle debug I/O", "切换调试 I/O"];
const T_CLEAR: Entry = ["Clear the terminal", "清屏"];
const T_SAVE_LOG: Entry = ["Save the terminal log", "保存终端日志"];
const T_SCROLL_BOTTOM: Entry = ["Scroll to the newest line", "滚动到最新一行"];
const T_HELP: Entry = ["Keyboard help", "键盘帮助"];
const T_CHEAT: Entry = ["Cheat sheet", "速查参考"];
const T_NOTICES: Entry = ["Notice log", "通知记录"];
const T_LANGUAGE: Entry = ["Switch language", "切换界面语言"];
const T_THEME: Entry = ["Choose theme", "选择主题"];
const T_ABOUT: Entry = ["About bee", "关于 bee"];
const T_LICENSES: Entry = ["Open-source components", "开源组件"];
const T_SPLASH: Entry = ["Toggle the startup splash", "切换启动闪屏"];
const T_QUIT: Entry = ["Quit the TUI", "退出 TUI"];

/// One entry in the palette.
pub struct Action {
    /// The protocol identifier. Stays English in both languages, the way a
    /// command name does, and it is what the search matches first — including
    /// for an action whose title has been translated past recognition. It is a
    /// search key rather than a column: see [`lines_in`].
    pub id: &'static str,
    pub title: Entry,
    pub category: Entry,
    /// The chord that runs it from anywhere, or `""` when the palette is the
    /// only way in.
    pub shortcut: &'static str,
    pub run: fn(&mut App),
}

// --- the actions -------------------------------------------------------------

fn view_terminal(app: &mut App) {
    app.set_view(View::Terminal);
}

fn view_diagnostics(app: &mut App) {
    app.set_view(View::Diagnostics);
}

fn view_network(app: &mut App) {
    app.set_view(View::Network);
}

fn view_assistant(app: &mut App) {
    app.set_view(View::Assistant);
}

fn focus_sidebar(app: &mut App) {
    app.focus = Focus::Sidebar;
}

/// Focus the pane *and* show it. Setting the focus without moving the view
/// would leave the keys on a panel the current view does not read, which is the
/// same as a dead keyboard.
fn focus_terminal(app: &mut App) {
    app.set_view(View::Terminal);
    app.focus = Focus::Terminal;
}

fn connect(app: &mut App) {
    app.reconnect();
}

fn disconnect(app: &mut App) {
    app.disconnect();
}

fn toggle_transport(app: &mut App) {
    let notice = app.toggle_transport();
    app.push_notice(notice);
}

fn open_uart(app: &mut App) {
    crate::dialogs::open_uart(app);
}

fn toggle_autoscroll(app: &mut App) {
    let on = !app.terminal.autoscroll;
    app.terminal.autoscroll = on;
    if on {
        app.terminal.scroll = 0;
    }
}

fn toggle_echo(app: &mut App) {
    app.terminal.echo = !app.terminal.echo;
}

/// The Enter key's spelling, cycled: the notice names the new mode, because
/// the notice is the only place it is ever named.
fn cycle_enter(app: &mut App) {
    let notice = app.cycle_enter_mode();
    app.push_notice(notice);
}

/// `#debugInput` of `web/index.html`: both directions traced to stderr, so an
/// I/O problem can be watched as it happens.
fn toggle_debug_io(app: &mut App) {
    let notice = app.toggle_debug_io();
    app.push_notice(notice);
}

/// The startup splash: off means the interface takes the screen at once, on is
/// the design's brief mark. Stored, so the answer outlives the run.
fn toggle_splash(app: &mut App) {
    let notice = app.toggle_splash();
    app.push_notice(notice);
}

fn clear_terminal(app: &mut App) {
    app.clear_terminal();
}

/// Save the pane to the default file and report it — the bytes and the name,
/// so the user knows where the log went rather than merely that it went.
fn save_log(app: &mut App) {
    let lang = app.lang;
    match app.save_terminal_log() {
        Ok((bytes, name)) => {
            let message = fill(entry(MSG_SAVED_LOG, lang), &[bytes.to_string(), name]);
            app.push_notice(crate::app::Notice {
                text: message,
                level: crate::event::NoticeLevel::Info,
            });
        }
        Err(err) => {
            let message = fill(entry(MSG_SAVE_FAILED, lang), &[err.to_string()]);
            app.push_notice(crate::app::Notice {
                text: message,
                level: crate::event::NoticeLevel::Error,
            });
        }
    }
}

fn scroll_bottom(app: &mut App) {
    app.scroll_terminal_to_bottom();
}

fn show_help(app: &mut App) {
    crate::dialogs::open_help(app);
}

fn show_cheat(app: &mut App) {
    crate::dialogs::open_cheat(app);
}

fn show_notices(app: &mut App) {
    crate::dialogs::open_notices(app);
}

fn toggle_language(app: &mut App) {
    let message = app.toggle_language();
    app.push_notice(message);
}

/// The theme picker, the same window `Ctrl+T` opens.
fn choose_theme(app: &mut App) {
    crate::dialogs::open_theme_pick(app);
}

/// The card about the program, the same one `--overlay about` paints.
fn show_about(app: &mut App) {
    crate::dialogs::open_about(app);
}

/// The component page `L` opens from the About card and `--licenses` prints in
/// full on a command line.
fn show_licenses(app: &mut App) {
    crate::dialogs::open_licenses(app);
}

/// The assistant's settings window, on the row that configures it.
///
/// The endpoint is where somebody lands who has just been told "set the endpoint
/// and model first", so it is the field the window opens on rather than the
/// composer: a notice that names a field should open on that field.
fn agent_configure(app: &mut App) {
    crate::views::assistant::open_settings(app, crate::views::assistant::AgentField::Endpoint);
}

fn agent_ask(app: &mut App) {
    crate::views::assistant::focus_composer(app);
}

fn agent_note(app: &mut App) {
    crate::views::assistant::open_settings(app, crate::views::assistant::AgentField::Notes);
}

/// Cycle the execution mode and say which one it landed on.
///
/// The mode decides what the assistant may send unattended, so it is a thing a
/// user changes by hand several times a session and should not have to find a
/// field for. The cycle lives in the assistant module, because the mode is its
/// mode; this is the palette's door to it.
fn cycle_agent_mode(app: &mut App) {
    crate::views::assistant::cycle_mode(app);
}

fn agent_report(app: &mut App) {
    crate::views::assistant::export_report(app);
}

/// Open or put away the docked assistant panel.
///
/// The panel is a layout state rather than a view: it narrows the terminal
/// instead of replacing it, which is why toggling it needs no notice — the
/// screen says which way it went. The one thing the screen cannot say is a
/// column with no room to appear, and [`App::toggle_assistant_panel`] answers
/// that case itself.
fn toggle_agent_panel(app: &mut App) {
    app.toggle_assistant_panel();
}

fn agent_new_chat(app: &mut App) {
    crate::views::assistant::new_conversation(app);
}

fn agent_prev_chat(app: &mut App) {
    crate::views::assistant::switch_conversation(app, -1);
}

fn agent_next_chat(app: &mut App) {
    crate::views::assistant::switch_conversation(app, 1);
}

fn agent_delete_chat(app: &mut App) {
    crate::dialogs::open_chat_pick(app);
}

fn agent_copy_chat(app: &mut App) {
    crate::views::assistant::copy_conversation(app);
}
/// The network bridge's own functions, as palette entries.
///
/// The network view is a form whose rows are entered from, and that is the right
/// shape for *reading* it — but joining a network, scanning for one and pointing
/// the log somewhere are things a user does before they have found the view, and
/// a palette entry for each is what makes them reachable without knowing which
/// F-key the form is on.
fn wifi_config(app: &mut App) {
    app.set_view(View::Network);
    crate::dialogs::prompt_wifi_ssid(app);
}

/// A scan is a read, and a read is not guarded — the same rule the network
/// view's own Scan row follows: a card asking permission to look at something
/// teaches people to press yes without reading, and this one said `@w scan`,
/// gadget talk nobody outside this codebase types.
fn wifi_scan(app: &mut App) {
    app.set_view(View::Network);
    if let Err(why) = app.scan_wifi() {
        app.push_notice(crate::app::Notice {
            text: why,
            level: crate::event::NoticeLevel::Error,
        });
    }
}

/// A status read is not guarded — it changes nothing, and a card asking
/// permission to look at something teaches people to press yes without reading.
fn wifi_status(app: &mut App) {
    app.set_view(View::Network);
    if let Err(why) = app.ask_device(crate::device::Query::Wifi) {
        app.push_notice(crate::app::Notice {
            text: why,
            level: crate::event::NoticeLevel::Error,
        });
    }
}

fn wifi_off(app: &mut App) {
    app.set_view(View::Network);
    crate::dialogs::ask(
        app,
        crate::dialogs::ConfirmAction::Accessory("@w off".to_string()),
    );
}

fn webdav_config(app: &mut App) {
    app.set_view(View::Network);
    crate::dialogs::prompt_webdav_url(app);
}

fn webdav_status(app: &mut App) {
    app.set_view(View::Network);
    if let Err(why) = app.ask_device(crate::device::Query::Webdav) {
        app.push_notice(crate::app::Notice {
            text: why,
            level: crate::event::NoticeLevel::Error,
        });
    }
}

fn webdav_off(app: &mut App) {
    app.set_view(View::Network);
    crate::dialogs::ask(
        app,
        crate::dialogs::ConfirmAction::Accessory("@d off".to_string()),
    );
}

fn toggle_sidebar(app: &mut App) {
    let notice = app.toggle_sidebar();
    app.push_notice(notice);
}

fn copy_screen(app: &mut App) {
    let notice = app.copy_screen();
    app.push_notice(notice);
}

fn quit(app: &mut App) {
    app.request_quit();
}

/// The registry, in render order. Grouped by category, and within a
/// group in the order the design lists them.
pub const ACTIONS: &[Action] = &[
    // Views
    Action {
        id: "view.terminal",
        title: T_VIEW_TERMINAL,
        category: CAT_VIEW,
        shortcut: "F2",
        run: view_terminal,
    },
    Action {
        id: "view.diagnostics",
        title: T_VIEW_DIAGNOSTICS,
        category: CAT_VIEW,
        shortcut: "F3",
        run: view_diagnostics,
    },
    Action {
        id: "view.network",
        title: T_VIEW_NETWORK,
        category: CAT_VIEW,
        shortcut: "F4",
        run: view_network,
    },
    Action {
        id: "view.assistant",
        title: T_VIEW_ASSISTANT,
        category: CAT_VIEW,
        shortcut: "F5",
        run: view_assistant,
    },
    // Focus
    Action {
        id: "focus.sidebar",
        title: T_FOCUS_SIDEBAR,
        category: CAT_FOCUS,
        shortcut: "Ctrl+Up",
        run: focus_sidebar,
    },
    Action {
        id: "focus.terminal",
        title: T_FOCUS_TERMINAL,
        category: CAT_FOCUS,
        shortcut: "Esc",
        run: focus_terminal,
    },
    // Connection
    Action {
        id: "connect",
        title: T_CONNECT,
        category: CAT_CONNECTION,
        shortcut: "",
        run: connect,
    },
    Action {
        id: "disconnect",
        title: T_DISCONNECT,
        category: CAT_CONNECTION,
        shortcut: "",
        run: disconnect,
    },
    Action {
        id: "transport.toggle",
        title: T_TRANSPORT,
        category: CAT_CONNECTION,
        shortcut: "",
        run: toggle_transport,
    },
    Action {
        id: "uart.settings",
        title: T_UART_SETTINGS,
        category: CAT_CONNECTION,
        shortcut: "",
        run: open_uart,
    },
    // Terminal
    Action {
        id: "term.autoscroll",
        title: T_AUTOSCROLL,
        category: CAT_TERMINAL,
        shortcut: "",
        run: toggle_autoscroll,
    },
    Action {
        id: "term.echo",
        title: T_ECHO,
        category: CAT_TERMINAL,
        shortcut: "",
        run: toggle_echo,
    },
    Action {
        id: "term.enter_mode",
        title: T_ENTER_MODE,
        category: CAT_TERMINAL,
        shortcut: "",
        run: cycle_enter,
    },
    Action {
        id: "term.debug_io",
        title: T_DEBUG_IO,
        category: CAT_TERMINAL,
        shortcut: "",
        run: toggle_debug_io,
    },
    Action {
        id: "term.clear",
        title: T_CLEAR,
        category: CAT_TERMINAL,
        shortcut: "Ctrl+L",
        run: clear_terminal,
    },
    Action {
        id: "term.save_log",
        title: T_SAVE_LOG,
        category: CAT_TERMINAL,
        shortcut: "",
        run: save_log,
    },
    Action {
        id: "term.scroll_bottom",
        title: T_SCROLL_BOTTOM,
        category: CAT_TERMINAL,
        shortcut: "Shift+End",
        run: scroll_bottom,
    },
    // App
    Action {
        id: "app.help",
        title: T_HELP,
        category: CAT_APP,
        shortcut: "F1",
        run: show_help,
    },
    Action {
        id: "app.cheat_sheet",
        title: T_CHEAT,
        category: CAT_APP,
        shortcut: "",
        run: show_cheat,
    },
    Action {
        id: "app.notices",
        title: T_NOTICES,
        category: CAT_APP,
        shortcut: "",
        run: show_notices,
    },
    Action {
        id: "app.language",
        title: T_LANGUAGE,
        category: CAT_APP,
        shortcut: "",
        run: toggle_language,
    },
    Action {
        id: "app.theme",
        title: T_THEME,
        category: CAT_APP,
        shortcut: "Ctrl+T",
        run: choose_theme,
    },
    Action {
        id: "app.about",
        title: T_ABOUT,
        category: CAT_APP,
        shortcut: "",
        run: show_about,
    },
    Action {
        id: "app.licenses",
        title: T_LICENSES,
        category: CAT_APP,
        shortcut: "",
        run: show_licenses,
    },
    Action {
        id: "app.splash",
        title: T_SPLASH,
        category: CAT_APP,
        shortcut: "",
        run: toggle_splash,
    },
    Action {
        id: "net.wifi_config",
        title: T_WIFI_CONFIG,
        category: CAT_NETWORK,
        shortcut: "",
        run: wifi_config,
    },
    Action {
        id: "net.wifi_scan",
        title: T_WIFI_SCAN,
        category: CAT_NETWORK,
        shortcut: "",
        run: wifi_scan,
    },
    Action {
        id: "net.wifi_status",
        title: T_WIFI_STATUS,
        category: CAT_NETWORK,
        shortcut: "",
        run: wifi_status,
    },
    Action {
        id: "net.wifi_off",
        title: T_WIFI_OFF,
        category: CAT_NETWORK,
        shortcut: "",
        run: wifi_off,
    },
    Action {
        id: "net.webdav_config",
        title: T_WEBDAV_CONFIG,
        category: CAT_NETWORK,
        shortcut: "",
        run: webdav_config,
    },
    Action {
        id: "net.webdav_status",
        title: T_WEBDAV_STATUS,
        category: CAT_NETWORK,
        shortcut: "",
        run: webdav_status,
    },
    Action {
        id: "net.webdav_off",
        title: T_WEBDAV_OFF,
        category: CAT_NETWORK,
        shortcut: "",
        run: webdav_off,
    },
    Action {
        id: "agent.configure",
        title: T_AGENT_CONFIG,
        category: CAT_AGENT,
        shortcut: "",
        run: agent_configure,
    },
    Action {
        id: "agent.ask",
        title: T_AGENT_ASK,
        category: CAT_AGENT,
        shortcut: "",
        run: agent_ask,
    },
    Action {
        id: "agent.note",
        title: T_AGENT_NOTE,
        category: CAT_AGENT,
        shortcut: "",
        run: agent_note,
    },
    Action {
        id: "agent.mode",
        title: T_AGENT_MODE,
        category: CAT_AGENT,
        shortcut: "",
        run: cycle_agent_mode,
    },
    Action {
        id: "agent.report",
        title: T_AGENT_REPORT,
        category: CAT_AGENT,
        shortcut: "",
        run: agent_report,
    },
    Action {
        id: "agent.panel",
        title: T_AGENT_PANEL,
        category: CAT_AGENT,
        shortcut: "F6",
        run: toggle_agent_panel,
    },
    Action {
        id: "agent.new_chat",
        title: T_AGENT_NEW,
        category: CAT_AGENT,
        shortcut: "Ctrl+N",
        run: agent_new_chat,
    },
    Action {
        id: "agent.prev_chat",
        title: T_AGENT_PREV,
        category: CAT_AGENT,
        shortcut: "",
        run: agent_prev_chat,
    },
    Action {
        id: "agent.next_chat",
        title: T_AGENT_NEXT,
        category: CAT_AGENT,
        shortcut: "",
        run: agent_next_chat,
    },
    Action {
        id: "agent.delete_chat",
        title: T_AGENT_DELETE,
        category: CAT_AGENT,
        shortcut: "",
        run: agent_delete_chat,
    },
    Action {
        id: "agent.copy_chat",
        title: T_AGENT_COPY,
        category: CAT_AGENT,
        shortcut: "",
        run: agent_copy_chat,
    },
    Action {
        id: "app.sidebar",
        title: T_SIDEBAR,
        category: CAT_APP,
        shortcut: "Ctrl+B",
        run: toggle_sidebar,
    },
    Action {
        id: "app.copy",
        title: T_COPY,
        category: CAT_APP,
        shortcut: "",
        run: copy_screen,
    },
    Action {
        id: "app.quit",
        title: T_QUIT,
        category: CAT_APP,
        shortcut: "Ctrl+Q",
        run: quit,
    },
];

/// Which window of the palette's list is on screen.
///
/// The registry is forty-odd rows and a user opens the palette to reach one of
/// a handful. Two levels keep that handful under the cursor: the menu, which
/// always shows the rows the window commands fill and one row per section, and
/// a section's own window. A query searches every level: these are depths of
/// the *list*, not of the search.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Level {
    /// What the palette opens on: the rows the user reaches for all day, and
    /// the sections the rest are gathered into.
    #[default]
    Menu,
    /// One section's own window: the actions of one category.
    Section(Section),
}

/// The categories the menu leads to.
///
/// Every action the menu does not always show belongs to exactly one, and its
/// window is the category's own: [`Section::category`] is the label the rows
/// already wear, so an action edited into another category moves window with
/// it — and a test keeps every action reachable from the menu and listed once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Connection,
    Terminal,
    App,
    Network,
    Agent,
}

impl Section {
    /// The sections in menu order: the order the registry first names each
    /// category below the always-shown rows, save the app's own window, which
    /// closes the list — the device's windows stand together above the
    /// program's own switches.
    pub const ALL: &[Section] = &[
        Section::Connection,
        Section::Terminal,
        Section::Network,
        Section::Agent,
        Section::App,
    ];

    /// The category this window is the actions of.
    fn category(self) -> Entry {
        match self {
            Section::Connection => CAT_CONNECTION,
            Section::Terminal => CAT_TERMINAL,
            Section::App => CAT_APP,
            Section::Network => CAT_NETWORK,
            Section::Agent => CAT_AGENT,
        }
    }

    /// Whether this window lists the action: its category is the window's, and
    /// it is not one of the rows the menu always shows — a row one keystroke
    /// from the menu is not also a row behind a window.
    fn holds(self, action: &Action) -> bool {
        !ALWAYS.contains(&action.id) && action.category == self.category()
    }
}

/// One row of the list a level shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Row {
    /// An index into [`ACTIONS`].
    Action(usize),
    /// A menu row: it opens this section's window rather than doing something
    /// and closing the overlay.
    Section(Section),
}

/// The rows the menu always shows: the window commands and the focus rows, in
/// the registry's own order. Everything the registry holds below them waits one
/// row down — and typing searches it all anyway.
///
/// Both focus rows are here rather than behind a window: once the rail's row
/// was shown here, the focus window held a single action, and a second level
/// for one row is a door for a room with one chair.
const ALWAYS: &[&str] = &[
    "view.terminal",
    "view.diagnostics",
    "view.network",
    "view.assistant",
    "focus.sidebar",
    "focus.terminal",
];

/// The open state of the palette.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaletteState {
    pub query: String,
    pub selected: usize,
    /// The first row the window shows.
    ///
    /// Kept here rather than derived from `selected`: the window must *hold*
    /// while the cursor moves inside it and only step when the cursor reaches
    /// an edge, and the same selection means different windows depending on
    /// which edge it came from.
    pub window: usize,
    /// Which list the palette is showing.
    pub level: Level,
}

impl PaletteState {
    /// A fresh overlay on an empty query.
    pub fn new() -> PaletteState {
        PaletteState::default()
    }

    /// Step to a level, starting its list over.
    ///
    /// The rows under the cursor are not the rows it was on, and a query typed
    /// for one list means nothing to the other, so the query and the cursor
    /// both go back to the head.
    pub fn set_level(&mut self, level: Level) {
        self.level = level;
        self.query.clear();
        self.selected = 0;
        self.window = 0;
    }

    /// Move the window so the selection is inside it, and no further.
    ///
    /// This is what makes the list hold still: a selection already between the
    /// window's first and last row leaves it alone, and only one that has
    /// walked off an edge pulls the window to itself — by the one row it went
    /// past, so the list walks rather than jumps.
    pub fn follow(&mut self, total: usize, visible: usize) {
        let last = total.saturating_sub(visible);
        self.window = self.window.min(last);
        if self.selected < self.window {
            self.window = self.selected;
        } else if visible > 0 && self.selected >= self.window + visible {
            self.window = self.selected + 1 - visible;
        }
    }

    /// Move down one match, wrapping past the last row back to the first.
    pub fn step_down(&mut self, total: usize) {
        self.selected = if self.selected + 1 >= total {
            0
        } else {
            self.selected + 1
        };
        self.clamp_to(total);
    }

    /// Move up one match, wrapping past the first row back to the last.
    pub fn step_up(&mut self, total: usize) {
        self.selected = if self.selected == 0 {
            total.saturating_sub(1)
        } else {
            self.selected - 1
        };
        self.clamp_to(total);
    }

    /// Keep the selection inside `total` — typing may have shrunk the list
    /// under it, and a selection past the end renders nothing at all.
    pub fn clamp_to(&mut self, total: usize) {
        self.selected = self.selected.min(total.saturating_sub(1));
    }
}

/// Indices of the actions matching `query`: a case-insensitive substring of the
/// id, either half of the title, or either half of the category. A Chinese
/// needle finds the Chinese labels; an English one still finds the same rows
/// through the English half.
pub fn matches(query: &str) -> Vec<usize> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return (0..ACTIONS.len()).collect();
    }
    let hit = |text: &str| text.to_ascii_lowercase().contains(&needle);
    ACTIONS
        .iter()
        .enumerate()
        .filter(|(_, action)| {
            action.id.to_ascii_lowercase().contains(&needle)
                || action.title.iter().any(|text| hit(text))
                || action.category.iter().any(|text| hit(text))
        })
        .map(|(index, _)| index)
        .collect()
}

/// The rows a level shows for a query.
///
/// A query is a search of *everything*, whichever level it is typed at: the
/// menu is how the palette opens, not a fence around the registry, and typing
/// is how an action no window keeps near the cursor is reached. With nothing
/// typed, the menu shows the rows it always shows and one row per section, and
/// a section's window shows that section's actions.
pub fn rows_in(level: Level, query: &str) -> Vec<Row> {
    let found = matches(query);
    if !query.trim().is_empty() {
        return found.into_iter().map(Row::Action).collect();
    }
    match level {
        Level::Menu => {
            let mut rows: Vec<Row> = found
                .iter()
                .copied()
                .filter(|index| ALWAYS.contains(&ACTIONS[*index].id))
                .map(Row::Action)
                .collect();
            // The menu asks the registry rather than trusting the enum: a
            // section whose actions the always-shown rows already carry opens
            // no window, instead of one that would be empty.
            rows.extend(
                Section::ALL
                    .iter()
                    .copied()
                    .filter(|section| found.iter().any(|index| section.holds(&ACTIONS[*index])))
                    .map(Row::Section),
            );
            rows
        }
        Level::Section(section) => found
            .into_iter()
            .filter(|index| section.holds(&ACTIONS[*index]))
            .map(Row::Action)
            .collect(),
    }
}

/// How many rows the overlay paints at once.
pub const MAX_VISIBLE: usize = 14;

/// First visible row: the window the state holds, pulled back so the selection
/// is inside it and the window stays full.
///
/// The window is adjusted here as well as in the key handler because the room
/// a terminal gives the overlay is not always [`MAX_VISIBLE`], and a selection
/// outside the painted rows would be a cursor the user cannot see.
pub fn window_start(state: &PaletteState, total: usize, visible: usize) -> usize {
    let mut start = state.window.min(total.saturating_sub(visible));
    if state.selected < start {
        start = state.selected;
    } else if visible > 0 && state.selected >= start + visible {
        start = state.selected + 1 - visible;
    }
    start
}

/// The overlay's border title, spaces included so the painter can pass it on
/// untouched.
pub fn panel_title(lang: Lang) -> &'static str {
    entry(TITLE, lang)
}

/// Columns of the padded title and category fields. Measured in *display*
/// columns: `{:<28}` counts characters, which walks the columns out of line as
/// soon as a label is Chinese and two columns wide per glyph.
const TITLE_WIDTH: usize = 28;
const CATEGORY_WIDTH: usize = 12;

/// The body lines, painted in `theme`. `visible` is how many rows there is room
/// for, so the painter's height and the key handler's arithmetic agree.
pub fn lines_in(
    state: &PaletteState,
    lang: Lang,
    visible: usize,
    theme: &crate::theme::Theme,
) -> Vec<Line<'static>> {
    let mut out = vec![Line::from(vec![
        Span::styled(
            theme.glyphs().prompt(),
            theme.focus().add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            state.query.clone(),
            theme.text().add_modifier(Modifier::BOLD),
        ),
    ])];
    out.push(Line::from(Span::styled(
        theme.glyphs().rule().to_string().repeat(56),
        theme.muted(),
    )));
    let rows = rows_in(state.level, &state.query);
    if rows.is_empty() {
        out.push(Line::from(Span::styled(
            entry(NO_MATCH, lang),
            theme.muted(),
        )));
        return out;
    }
    let visible = visible.clamp(1, MAX_VISIBLE);
    let start = window_start(state, rows.len(), visible);
    for (row, slot) in rows.iter().skip(start).take(visible).enumerate() {
        let here = start + row == state.selected;
        // The highlighted row is one chip: the ground and the ink that sits on
        // it, padding included, so the fill spans the whole line.
        let (title, category, key, marker) = if here {
            let ink = theme.selected();
            (ink, ink, ink, ink)
        } else {
            (theme.text(), theme.focus(), theme.focus(), theme.accent())
        };
        let (label, group, shortcut): (Cow<'static, str>, &'static str, String) = match slot {
            Row::Action(index) => {
                let action = &ACTIONS[*index];
                let shortcut = if action.shortcut.is_empty() {
                    String::new()
                } else {
                    format!("  {}", action.shortcut)
                };
                (
                    Cow::Borrowed(entry(action.title, lang)),
                    entry(action.category, lang),
                    shortcut,
                )
            }
            // A section row opens a window rather than running anything: it
            // wears its category's name with the ellipsis that says "there is
            // more" and carries no chord — Enter is how it is run, and Enter
            // always is. Its category column stays empty: the name is already
            // the label, and six rows repeating "Palette" is a column of noise.
            Row::Section(section) => (
                Cow::Owned(format!("{}…", entry(section.category(), lang))),
                "",
                String::new(),
            ),
        };
        // The id is the *search key*, not a column: the centre column of a
        // real terminal is about fifty columns, and a title, a category, a
        // shortcut and a protocol id do not fit in it. The title and the
        // shortcut are what a user reads; the id is what they can type.
        out.push(Line::from(vec![
            Span::styled(
                if here {
                    theme.glyphs().cursor()
                } else {
                    theme.glyphs().cursor_blank()
                },
                marker,
            ),
            Span::styled(
                text::pad_to(theme.fold(label.as_ref()).as_ref(), TITLE_WIDTH),
                title,
            ),
            Span::styled(
                text::pad_to(theme.fold(group).as_ref(), CATEGORY_WIDTH),
                category,
            ),
            Span::styled(shortcut, key),
        ]));
    }
    out
}

/// The key legend under the window, so the overlay is operable without the help
/// overlay to explain it. The legend names what Esc does *here*: it closes the
/// first level and steps back from the second.
pub fn legend(lang: Lang, theme: &crate::theme::Theme, level: Level) -> Line<'static> {
    let keys = match level {
        Level::Menu => KEYS,
        Level::Section(_) => KEYS_BACK,
    };
    // The legend is the interface's own line: `↑↓`, ` · ` and the `…` after a
    // verb fold for a terminal whose font is ASCII, like every other hint.
    let text = format!(
        "{}{}{}",
        entry(SHORTCUT_HINT, lang),
        theme.glyphs().dot_sep(),
        entry(keys, lang)
    );
    Line::from(Span::styled(theme.fold(&text).into_owned(), theme.muted()))
}

/// Handle a key while the palette is open. Returns true when the key was
/// consumed.
///
/// A control chord is deliberately *not* consumed — `Ctrl+T` must still repaint
/// and `Ctrl+Q` still quit with the palette in the way — except `Ctrl+U`, the
/// one control chord that means something *inside* a search box.
pub fn handle_key(app: &mut App, key: KeyEvent) -> bool {
    if app.palette.is_none() {
        return false;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        if key.code != KeyCode::Char('u') {
            return false;
        }
        if let Some(state) = app.palette.as_mut() {
            state.query.clear();
            state.selected = 0;
        }
        return true;
    }
    let Some(state) = app.palette.as_mut() else {
        return false;
    };
    let rows = rows_in(state.level, &state.query);
    let total = rows.len();
    match key.code {
        // The way out is the menu's: from a section's window, Esc steps back
        // up to the menu, which is where the palette was opened from.
        KeyCode::Esc => {
            if matches!(state.level, Level::Section(_)) {
                state.set_level(Level::Menu);
            } else {
                app.palette = None;
            }
        }
        KeyCode::Enter => match rows.get(state.selected).copied() {
            Some(Row::Action(index)) => {
                app.palette = None;
                (ACTIONS[index].run)(app);
            }
            // A section's row: it opens that window from its head rather than
            // doing something and closing the overlay.
            Some(Row::Section(section)) => state.set_level(Level::Section(section)),
            None => app.palette = None,
        },
        KeyCode::Up | KeyCode::BackTab => state.step_up(total),
        KeyCode::Down | KeyCode::Tab => state.step_down(total),
        KeyCode::Home => state.selected = 0,
        KeyCode::End => state.selected = total.saturating_sub(1),
        KeyCode::Backspace => {
            state.query.pop();
            state.selected = 0;
        }
        // A function key is the *view* rota's, not a query character: the user
        // who reaches for F2 with the palette open wants the view, not an `F2`
        // typed into a search box that cannot match it.
        KeyCode::F(_) => return false,
        // Anything else printable is a query character.
        KeyCode::Char(c) => {
            state.query.push(c);
            state.selected = 0;
        }
        _ => {}
    }
    // Typing may have shrunk the list under the selection; put it back in range
    // before the next frame paints nothing. The window follows the selection
    // here rather than inside each key arm, so every way the selection moves —
    // a step, Home/End, a query that rewrote the list — holds or scrolls by the
    // same rule.
    if let Some(state) = app.palette.as_mut() {
        let total = rows_in(state.level, &state.query).len();
        state.clamp_to(total);
        state.follow(total, MAX_VISIBLE);
    }
    true
}

/// Open the palette.
pub fn open(app: &mut App) {
    app.palette = Some(PaletteState::new());
}

/// Take a paste as query text.
///
/// A paste is typing that arrives at once: the query grows at its end, the
/// selection goes back to the top, and the window is settled by the same rule
/// a keystroke settles it. A newline has no meaning in a query, so it becomes
/// a space rather than cutting the query in half.
pub fn paste(app: &mut App, text: &str) {
    let Some(state) = app.palette.as_mut() else {
        return;
    };
    state
        .query
        .push_str(&text.replace("\r\n", " ").replace(['\r', '\n'], " "));
    state.selected = 0;
    let total = rows_in(state.level, &state.query).len();
    state.clamp_to(total);
    state.follow(total, MAX_VISIBLE);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::Theme;

    /// The registry is the contract: every id, in order. Adding an action means
    /// adding it here too, which is the point — the list is what the palette
    /// promises the user.
    const CANONICAL: &[&str] = &[
        "view.terminal",
        "view.diagnostics",
        "view.network",
        "view.assistant",
        "focus.sidebar",
        "focus.terminal",
        "connect",
        "disconnect",
        "transport.toggle",
        "uart.settings",
        "term.autoscroll",
        "term.echo",
        "term.enter_mode",
        "term.debug_io",
        "term.clear",
        "term.save_log",
        "term.scroll_bottom",
        "app.help",
        "app.cheat_sheet",
        "app.notices",
        "app.language",
        "app.theme",
        "app.about",
        "app.licenses",
        "app.splash",
        "net.wifi_config",
        "net.wifi_scan",
        "net.wifi_status",
        "net.wifi_off",
        "net.webdav_config",
        "net.webdav_status",
        "net.webdav_off",
        "agent.configure",
        "agent.ask",
        "agent.note",
        "agent.mode",
        "agent.report",
        "agent.panel",
        "agent.new_chat",
        "agent.prev_chat",
        "agent.next_chat",
        "agent.delete_chat",
        "agent.copy_chat",
        "app.sidebar",
        "app.copy",
        "app.quit",
    ];

    fn text_of(lines: &[Line<'static>]) -> String {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_registry_is_complete_ordered_and_unique() {
        let ids: Vec<&str> = ACTIONS.iter().map(|action| action.id).collect();
        assert_eq!(ids, CANONICAL, "the palette drifted from its contract");
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "two actions share an id");
    }

    /// The palette's view rows and the views themselves are the same list:
    /// every view has exactly one row that opens it, and every row that opens
    /// a view names one. The counts agreeing is the point — a view with no way
    /// in from the palette is an orphan, and a row that opens nothing is a
    /// dead key.
    #[test]
    fn every_view_has_its_palette_row() {
        for view in View::ALL {
            let wanted = format!("view.{}", view.as_str());
            let found: Vec<&str> = ACTIONS
                .iter()
                .filter(|action| action.id == wanted)
                .map(|action| action.id)
                .collect();
            assert_eq!(found, vec![wanted.as_str()], "{view:?} has {found:?}");
        }
        let view_rows = ACTIONS
            .iter()
            .filter(|action| action.id.starts_with("view."))
            .count();
        assert_eq!(
            view_rows,
            View::ALL.len(),
            "a `view.` row names no view in `View::ALL`"
        );
    }

    /// The menu's tree is a partition of the registry: every action is either
    /// one of the rows the menu always shows or held by exactly one section —
    /// nothing is stranded behind a window that never lists it, and nothing is
    /// listed twice — and the windows stand in the order the registry first
    /// names their categories, save the app's own, which closes the list.
    #[test]
    fn the_menu_partitions_the_registry() {
        for action in ACTIONS {
            let always = ALWAYS.contains(&action.id);
            let holders = Section::ALL.iter().filter(|s| s.holds(action)).count();
            assert!(
                always ^ (holders == 1),
                "{}: always={always}, in {holders} windows",
                action.id
            );
        }
        let mut seen: Vec<Entry> = Vec::new();
        for action in ACTIONS.iter().filter(|action| !ALWAYS.contains(&action.id)) {
            if !seen.contains(&action.category) {
                seen.push(action.category);
            }
        }
        let windows: Vec<Entry> = Section::ALL
            .iter()
            .map(|section| section.category())
            .collect();
        let mut expected = seen;
        expected.retain(|category| *category != CAT_APP);
        expected.push(CAT_APP);
        assert_eq!(expected, windows, "the menu order left the registry's");
    }

    /// A network action asks before it acts on the *link*, and asks nowhere
    /// else: joining a network is a command the board will carry out, and a
    /// click the user cannot take back is worth a card — while a read, a
    /// status one or a scan, changes nothing, and a card for it would only
    /// train people to press yes.
    #[test]
    fn network_actions_guard_the_ones_that_change_things() {
        // A status read goes straight out: no dialog, no notice of its own.
        let mut app = App::default();
        wifi_status(&mut app);
        assert!(app.dialog.is_none(), "a status read asked first");

        // And so does a scan: it is a read too, and the card it used to raise
        // said `@w scan` — gadget talk nobody outside this codebase types. It
        // is also the one the network view's Scan row opens, and the two must
        // not disagree about the guard.
        let mut scan = App::default();
        wifi_scan(&mut scan);
        assert!(scan.dialog.is_none(), "a scan asked first");

        // And each network action lands the user on the network view, because a
        // command issued from the palette should leave them looking at the thing
        // it changed.
        for name in ["config", "scan", "status"] {
            let mut app = App::default();
            app.set_view(View::Terminal);
            match name {
                "config" => wifi_config(&mut app),
                "scan" => wifi_scan(&mut app),
                _ => wifi_status(&mut app),
            }
            assert_eq!(app.view, View::Network, "{name} did not show the network");
        }
    }

    /// The assistant's actions land where the work is: configure and "write a
    /// note" raise the settings window on their own row, and asking closes it
    /// and hands the keyboard to the composer. A notice saying "set the
    /// endpoint" that opened on the composer would send the user somewhere
    /// else; the field it names is where the window opens.
    #[test]
    fn an_assistant_action_lands_on_its_field() {
        let mut app = App::default();
        agent_configure(&mut app);
        assert!(matches!(
            app.dialog,
            Some(crate::dialogs::Dialog::Settings(_))
        ));
        assert_eq!(
            app.assistant.focus,
            crate::views::assistant::AgentField::Endpoint
        );

        // Asking leaves the window shut rather than stranded under the view
        // with a caret on a row nobody is painting.
        agent_ask(&mut app);
        assert!(app.dialog.is_none(), "the window outlived the question");
        assert_eq!(
            app.assistant.focus,
            crate::views::assistant::AgentField::Composer
        );

        agent_note(&mut app);
        assert!(matches!(
            app.dialog,
            Some(crate::dialogs::Dialog::Settings(_))
        ));
        assert_eq!(
            app.assistant.focus,
            crate::views::assistant::AgentField::Notes
        );
    }

    /// The mode cycles Auto → Full Auto → Manual → Auto, and each step says
    /// which mode it landed on — which is the only way a user can tell a cycle
    /// apart from scroll.
    #[test]
    fn the_mode_cycles_and_announces() {
        let mut app = App::default();
        let seen: Vec<&str> = std::iter::from_fn(|| {
            cycle_agent_mode(&mut app);
            let mode = app.assistant.mode?;
            let last = app.notices.last()?;
            assert!(
                last.text.contains(app.strings().execution_mode(mode)),
                "the notice did not name the new mode: {:?}",
                last.text
            );
            Some(mode.as_str())
        })
        .take(3)
        .collect();
        // The unset default reads as Auto, so the first step off it is Full
        // Auto — and that is the point of defaulting to the mode that cannot
        // send anything.
        assert_eq!(seen, vec!["full-auto", "manual", "auto"]);
    }

    /// The Enter-mode action walks the reference client's four modes and says
    /// which one it landed on. The notice is the only place the mode is named,
    /// so it has to name it at every step.
    #[test]
    fn the_enter_action_cycles_and_announces() {
        let mut app = App::default();
        let seen: Vec<&str> = std::iter::from_fn(|| {
            cycle_enter(&mut app);
            let last = app.notices.last()?;
            assert!(
                last.text.contains(app.enter.label()),
                "the notice did not name the new mode: {:?}",
                last.text
            );
            Some(app.enter.label())
        })
        .take(5)
        .collect();
        assert_eq!(seen, vec!["CR", "LF", "CRLF", "Raw", "CR"]);
    }

    /// The debug-I/O switch flips the trace and says which way it now points.
    #[test]
    fn the_debug_io_action_flips_the_trace() {
        let mut app = App::default();
        assert!(!app.trace.tracing_stderr(), "off until asked for");
        let action = ACTIONS
            .iter()
            .find(|action| action.id == "term.debug_io")
            .expect("the switch is registered");
        (action.run)(&mut app);
        assert!(app.trace.tracing_stderr(), "flipped on");
        let last = app.notices.last().expect("it announced itself");
        let s = app.strings();
        assert!(last.text.contains(s.net_state_on), "{:?}", last.text);
        (action.run)(&mut app);
        assert!(!app.trace.tracing_stderr(), "and off again");
        let last = app.notices.last().expect("it announced itself");
        assert!(last.text.contains(s.net_state_off), "{:?}", last.text);
    }

    /// The switches outlive the run: a trace turned on to catch a problem that
    /// only shows up on the next dial has to still be on when it is dialled,
    /// and a splash put away once must stay away.
    #[test]
    fn the_switches_are_remembered() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "linkr-palette-switches-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mut app = App {
            settings: Some(crate::settings::SettingsStore::at(&path)),
            ..App::default()
        };
        cycle_enter(&mut app);
        toggle_debug_io(&mut app);
        toggle_splash(&mut app);
        let stored = crate::settings::SettingsStore::at(&path).read();
        assert_eq!(stored.enter, Some(app.enter));
        assert!(stored.debug_io);
        assert!(stored.no_splash, "the splash switch is remembered too");
        let _ = std::fs::remove_file(&path);
    }

    /// The splash switch is announced, and flipping it does not raise or drop
    /// a splash that is already up: the setting is about the next launch, the
    /// one on screen is a fact about this run.
    #[test]
    fn the_splash_switch_is_announced() {
        let mut app = App {
            splash_until: Some(std::time::Instant::now() + std::time::Duration::from_secs(60)),
            ..App::default()
        };
        let action = ACTIONS
            .iter()
            .find(|action| action.id == "app.splash")
            .expect("the switch is registered");
        (action.run)(&mut app);
        assert!(app.no_splash, "flipped off");
        let s = app.strings();
        let last = app.notices.last().expect("it announced itself");
        assert!(
            last.text.contains(s.splash_setting) && last.text.contains(s.net_state_off),
            "{:?}",
            last.text
        );
        assert!(app.splash_active(), "the switch is about the next launch");
        (action.run)(&mut app);
        assert!(!app.no_splash, "and on again");
        let last = app.notices.last().expect("it announced itself");
        assert!(last.text.contains(s.net_state_on), "{:?}", last.text);
    }

    /// Conversations come and go durably: a new one is a fresh page that keeps
    /// the last, deleting one reaches the store, and the store's list is what
    /// the panel shows. A chat that only lived in memory would come back after
    /// a restart, which is the one thing either action must not do.
    #[test]
    fn starting_and_deleting_conversations_is_durable() {
        use crate::agent::session::{load_chats, DisplayLine};
        let mut path = std::env::temp_dir();
        path.push(format!("linkr-palette-chat-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut app = App {
            agent_store: Some(crate::agent::store::JsonFile::at(&path)),
            ..App::default()
        };
        // A conversation with something in it, saved the way a turn saves it.
        app.assistant.chat_mut().display.push(DisplayLine {
            role: "user".into(),
            text: "hello".into(),
        });
        crate::views::assistant::persist_session(&mut app);
        assert_eq!(
            load_chats(
                app.agent_store.as_ref().expect("store"),
                &app.agent_device_key()
            )
            .map(|saved| saved.chats.len()),
            Some(1),
            "the turn did not reach the store"
        );

        // A new page: on screen, not in the store — a draft is not a
        // conversation, but it is not the store's to throw away either.
        agent_new_chat(&mut app);
        assert_eq!(app.assistant.chats.len(), 2, "a new chat is a new page");
        assert_eq!(
            load_chats(
                app.agent_store.as_ref().expect("store"),
                &app.agent_device_key()
            )
            .map(|saved| saved.chats.len()),
            Some(1),
            "the empty page was stored"
        );

        // Deleting the open (empty) page leaves the saved thread, on screen
        // and on disk. The palette's entry opens the picker rather than
        // deleting something the user was not shown: the cursor starts on the
        // conversation the panel is showing, and Enter is the delete.
        agent_delete_chat(&mut app);
        assert!(
            matches!(app.dialog, Some(crate::dialogs::Dialog::ChatPick(_))),
            "the delete asks which conversation: {:?}",
            app.dialog
        );
        crate::dialogs::handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.assistant.chats.len(), 1);
        assert_eq!(app.assistant.chats[0].display[0].text, "hello");
        assert_eq!(
            load_chats(
                app.agent_store.as_ref().expect("store"),
                &app.agent_device_key()
            )
            .map(|saved| saved.chats.len()),
            Some(1),
            "the delete did not leave the thread"
        );

        // Deleting the last one leaves a fresh blank page rather than none,
        // and the store forgets the thread for good.
        agent_delete_chat(&mut app);
        assert!(matches!(
            app.dialog,
            Some(crate::dialogs::Dialog::ChatPick(_))
        ));
        crate::dialogs::handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.assistant.chats.len(), 1, "a blank page takes its place");
        assert!(app.assistant.chats[0].display.is_empty());
        assert!(
            load_chats(
                app.agent_store.as_ref().expect("store"),
                &app.agent_device_key()
            )
            .is_none(),
            "the delete did not reach the store"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// Every action is labelled in both languages, and the ids and shorthands
    /// stay protocol / key literals — a translated id would break a script that
    /// searched for it.
    #[test]
    fn every_action_is_bilingual() {
        let mut entries = Vec::new();
        for action in ACTIONS {
            entries.push(action.title);
            entries.push(action.category);
            assert!(
                !action.id.is_empty() && action.id.is_ascii(),
                "{} is not a protocol literal",
                action.id
            );
        }
        crate::i18n::assert_bilingual(&entries);
        crate::i18n::assert_bilingual(&[
            TITLE,
            NO_MATCH,
            SHORTCUT_HINT,
            KEYS,
            KEYS_BACK,
            MSG_SAVED_LOG,
            MSG_SAVE_FAILED,
            CAT_VIEW,
            CAT_FOCUS,
            CAT_CONNECTION,
            CAT_TERMINAL,
            CAT_APP,
        ]);
    }

    /// The search matches the id, the title and the category, in both
    /// languages, and an empty query matches everything.
    #[test]
    fn the_search_matches_id_title_and_category() {
        assert_eq!(matches("").len(), ACTIONS.len());
        assert_eq!(
            matches("term.save_log"),
            vec![ACTIONS
                .iter()
                .position(|action| action.id == "term.save_log")
                .expect("the action exists")]
        );
        let found = matches("assistant");
        let ids: Vec<&str> = found.iter().map(|i| ACTIONS[*i].id).collect();
        assert!(ids.contains(&"view.assistant"), "{ids:?}");

        // Chinese finds the Chinese labels.
        assert_eq!(
            matches("清屏"),
            vec![ACTIONS
                .iter()
                .position(|action| action.id == "term.clear")
                .expect("the action exists")]
        );
        assert!(matches("nothing-matches-this-at-all").is_empty());
    }

    /// The window holds still while the cursor is inside it, and steps by the
    /// one row the cursor reached past when it is not — the list walks at the
    /// edge instead of scroll under a cursor parked in the middle.
    #[test]
    fn the_window_holds_until_the_cursor_reaches_an_edge() {
        let total = ACTIONS.len();
        let visible = MAX_VISIBLE;
        let mut state = PaletteState::new();

        // A first screenful of steps leaves the window where it was.
        for _ in 0..visible - 1 {
            state.step_down(total);
            state.follow(total, visible);
        }
        assert_eq!(state.selected, visible - 1);
        assert_eq!(
            state.window, 0,
            "the window moved with the cursor inside it"
        );

        // One more row is one row of list.
        state.step_down(total);
        state.follow(total, visible);
        assert_eq!(state.selected, visible);
        assert_eq!(
            state.window, 1,
            "the window follows by the row it went past"
        );

        // Up again: the cursor re-enters the window and it holds.
        state.step_up(total);
        state.follow(total, visible);
        state.step_up(total);
        state.follow(total, visible);
        assert_eq!(
            state.window, 1,
            "the window does not run ahead of the cursor"
        );
        assert!(state.window <= state.selected && state.selected < state.window + visible);

        // The ends hold the window full, and the cursor stays on screen.
        state.selected = total - 1;
        state.follow(total, visible);
        assert_eq!(state.window, total - visible);
        state.selected = 0;
        state.follow(total, visible);
        assert_eq!(state.window, 0);

        // A stale window — a query that grew the list under a scrolled one — is
        // pulled back into range rather than painting past the end.
        state.window = total + 5;
        state.selected = total - 1;
        assert_eq!(window_start(&state, total, visible), total - visible);

        // And a painted window smaller than MAX_VISIBLE still shows the
        // selection, whatever the state holds.
        state.window = 3;
        state.selected = 9;
        let start = window_start(&state, total, 5);
        assert!(start <= state.selected && state.selected < start + 5);
    }

    /// The selection wraps at both ends and survives a shrinking query.
    #[test]
    fn the_selection_wraps_and_clamps() {
        let total = ACTIONS.len();
        let mut state = PaletteState::new();
        state.step_up(total);
        assert_eq!(state.selected, total - 1);
        state.step_down(total);
        assert_eq!(state.selected, 0);

        let mut state = PaletteState {
            query: "term".to_string(),
            selected: 99,
            ..PaletteState::new()
        };
        state.clamp_to(matches(&state.query).len());
        assert!(state.selected < matches(&state.query).len());

        // An empty result set stays put rather than underflowing.
        let mut empty = PaletteState::new();
        empty.step_up(0);
        empty.step_down(0);
        assert_eq!(empty.selected, 0);
    }

    /// The rendered body has the prompt first (that is where the cursor goes),
    /// one marked row, and the same height at the top, middle and bottom — of a
    /// list longer than the window, which is where the shape can break.
    #[test]
    fn the_body_keeps_its_shape_and_marks_exactly_one_row() {
        let query = "e";
        let total = matches(query).len();
        assert!(total > MAX_VISIBLE, "the list must overflow the window");
        let mut state = PaletteState {
            query: query.to_string(),
            ..PaletteState::new()
        };
        let top = lines_in(&state, Lang::En, MAX_VISIBLE, &Theme::DARK);
        state.selected = total / 2;
        let middle = lines_in(&state, Lang::En, MAX_VISIBLE, &Theme::DARK);
        state.selected = total - 1;
        let bottom = lines_in(&state, Lang::En, MAX_VISIBLE, &Theme::DARK);

        // prompt, separator, then a full window (the list is longer than one).
        assert_eq!(top.len(), 2 + MAX_VISIBLE);
        assert_eq!(top.len(), middle.len());
        assert_eq!(bottom.len(), middle.len());
        for body in [&top, &middle, &bottom] {
            assert_eq!(body[0].spans[0].content, "› ");
            let marked = body.iter().filter(|l| l.spans[0].content == "▸ ").count();
            assert_eq!(marked, 1, "one row is the selection");
        }
    }

    /// The list the palette opens on is the rows it always shows — the four
    /// views and the two focus rows — and one row per section for everything
    /// else: no single "more" to descend through, and the whole menu fits the
    /// first screen without a scroll.
    #[test]
    fn the_palette_opens_on_the_window_commands_and_their_sections() {
        let state = PaletteState::new();
        let rows = rows_in(state.level, &state.query);
        assert!(
            rows.len() <= MAX_VISIBLE,
            "the menu needs a scroll: {} rows",
            rows.len()
        );
        let ids: Vec<&str> = rows
            .iter()
            .filter_map(|row| match row {
                Row::Action(index) => Some(ACTIONS[*index].id),
                Row::Section(_) => None,
            })
            .collect();
        assert_eq!(ids, ALWAYS.to_vec());
        let windows: Vec<Section> = rows
            .iter()
            .filter_map(|row| match row {
                Row::Section(section) => Some(*section),
                Row::Action(_) => None,
            })
            .collect();
        assert_eq!(windows.as_slice(), Section::ALL);

        let zh = text_of(&lines_in(&state, Lang::Zh, MAX_VISIBLE, &Theme::DARK));
        assert!(zh.contains("打开终端视图"), "{zh}");
        assert!(zh.contains("连接…"), "a window row is not labelled: {zh}");
        assert!(
            !zh.contains("保存终端日志"),
            "a section's rows leaked onto the menu: {zh}"
        );
        let en = text_of(&lines_in(&state, Lang::En, MAX_VISIBLE, &Theme::DARK));
        assert!(en.contains("Connection…"), "{en}");
        assert!(en.contains("Assistant…"), "{en}");
        assert!(
            !en.contains("Save the terminal log"),
            "a section's rows leaked onto the menu: {en}"
        );
        assert!(
            legend(Lang::En, &Theme::DARK, Level::Menu)
                .spans
                .first()
                .map(|span| span.content.as_ref())
                .unwrap_or_default()
                .contains("Esc close"),
            "the way out is named"
        );
    }

    /// A menu row opens its section's window and does nothing else; Esc steps
    /// back up from the window, and the menu's own Esc closes the palette.
    #[test]
    fn a_section_row_opens_its_window_and_esc_steps_back() {
        let mut app = App::default();
        let view = app.view;
        open(&mut app);
        let menu = rows_in(Level::Menu, "").len();
        for _ in 0..menu - 1 {
            handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert_eq!(
            app.palette.as_ref().map(|s| s.selected),
            Some(menu - 1),
            "the cursor sits on the last row"
        );

        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let state = app.palette.as_ref().expect("the palette is still up");
        assert_eq!(state.level, Level::Section(Section::App));
        assert!(state.query.is_empty(), "a new window starts unsearched");
        assert_eq!(state.selected, 0);
        assert_eq!(state.window, 0);
        assert_eq!(app.view, view, "a row ran on the way down");

        let en = text_of(&lines_in(state, Lang::En, MAX_VISIBLE, &Theme::DARK));
        assert!(en.contains("About bee"), "not the section: {en}");
        assert!(
            !en.contains("Open terminal view"),
            "the menu leaked into the window: {en}"
        );
        let expected = ACTIONS
            .iter()
            .filter(|action| Section::App.holds(action))
            .count();
        assert_eq!(
            rows_in(state.level, &state.query).len(),
            expected,
            "the window is not the section"
        );
        let back = legend(Lang::En, &Theme::DARK, Level::Section(Section::App));
        let back = back
            .spans
            .first()
            .map(|span| span.content.to_string())
            .unwrap_or_default();
        assert!(back.contains("Esc back"), "the way up is named: {back}");

        // Esc goes back up, and the palette is closed by the level it opened on.
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(
            app.palette.as_ref().map(|s| s.level),
            Some(Level::Menu),
            "Esc did not step back up"
        );
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.palette.is_none(), "the menu's Esc closes");
    }

    /// A query is a search of everything at either level — the menu is how the
    /// palette opens, not a fence around the registry — and it does not change
    /// what Esc does.
    #[test]
    fn a_query_searches_everything_from_the_first_level() {
        let mut app = App::default();
        open(&mut app);
        for c in "wifi".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE),
            );
        }
        let state = app.palette.as_ref().expect("the palette is up");
        assert_eq!(state.level, Level::Menu);
        assert_eq!(
            rows_in(state.level, &state.query).len(),
            matches("wifi").len()
        );
        let text = text_of(&lines_in(state, Lang::En, MAX_VISIBLE, &Theme::DARK));
        assert!(text.contains("Scan for WiFi networks"), "{text}");
        assert!(
            !text.contains("Connection…"),
            "the rows are the query's own: {text}"
        );
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(
            app.palette.is_none(),
            "a query does not change what Esc does"
        );
    }

    /// Enter in a section's window runs the row and closes the whole palette,
    /// rather than leaving the user a level down with nothing to run.
    #[test]
    fn enter_in_a_section_window_runs_and_closes() {
        let mut app = App::default();
        open(&mut app);
        let state = app.palette.as_mut().expect("the palette is up");
        state.set_level(Level::Section(Section::App));
        for c in "Keyboard help".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE),
            );
        }
        assert_eq!(
            app.palette.as_ref().map(|s| s.level),
            Some(Level::Section(Section::App)),
            "a query does not step back up"
        );
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.palette.is_none(), "the palette stayed open");
        assert!(app.dialog.is_some(), "the row under the cursor did not run");
    }

    /// Chinese reaches the rows and the categories; the key hints stay literal.
    #[test]
    fn the_overlay_follows_the_language() {
        let state = PaletteState::new();
        let zh = text_of(&lines_in(&state, Lang::Zh, MAX_VISIBLE, &Theme::DARK));
        assert!(zh.contains("打开终端视图"), "{zh}");
        assert!(zh.contains("视图"), "the category translates: {zh}");
        assert!(zh.contains("F2"), "key hints stay literal: {zh}");
        assert!(!zh.contains("Open terminal view"), "{zh}");
        assert!(!zh.contains("View "), "the English category is gone: {zh}");

        let en = text_of(&lines_in(&state, Lang::En, MAX_VISIBLE, &Theme::DARK));
        assert!(en.contains("Open terminal view"), "{en}");
        assert!(!en.contains("打开终端视图"), "{en}");

        assert_eq!(panel_title(Lang::En), " Command palette (Ctrl+P) ");
        assert_eq!(panel_title(Lang::Zh), " 命令面板（Ctrl+P） ");

        let none = text_of(&lines_in(
            &PaletteState {
                query: "no-such-action".into(),
                selected: 0,
                ..PaletteState::new()
            },
            Lang::Zh,
            MAX_VISIBLE,
            &Theme::DARK,
        ));
        assert!(none.contains("无匹配动作。"), "{none}");
    }

    /// The padded columns are measured in display columns, so a Chinese row
    /// lines its columns up with an English one; for ASCII labels the bytes are
    /// exactly what `format!("{:<28}")` would have produced.
    #[test]
    fn the_columns_are_measured_in_display_columns() {
        for action in ACTIONS {
            let en = entry(action.title, Lang::En);
            assert_eq!(text::pad_to(en, TITLE_WIDTH), format!("{en:<28}"), "{en}");
        }
        // A Chinese title is two columns per glyph, so the padding shrinks by
        // twice the character count — never to nothing, never negative.
        let zh = entry(T_VIEW_TERMINAL, Lang::Zh);
        assert_eq!(text::columns(&text::pad_to(zh, TITLE_WIDTH)), TITLE_WIDTH);
    }

    /// Every key the overlay claims to handle really does something, and a key
    /// it does not handle is not swallowed by accident.
    #[test]
    fn the_keys_edit_the_query_and_move_the_selection() {
        let mut app = App::default();
        open(&mut app);
        assert!(app.palette.is_some());

        for c in "term".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE),
            );
        }
        assert_eq!(app.palette.as_ref().map(|s| s.query.as_str()), Some("term"));
        assert_eq!(app.palette.as_ref().map(|s| s.selected), Some(0));

        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.palette.as_ref().map(|s| s.selected), Some(1));
        handle_key(&mut app, KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
        assert_eq!(app.palette.as_ref().map(|s| s.selected), Some(0));
        handle_key(&mut app, KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
        let last = matches("term").len() - 1;
        assert_eq!(app.palette.as_ref().map(|s| s.selected), Some(last));

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL),
        );
        assert_eq!(app.palette.as_ref().map(|s| s.query.as_str()), Some(""));

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
        );
        assert_eq!(app.palette.as_ref().map(|s| s.query.as_str()), Some(""));

        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.palette.is_none(), "Esc closes");
    }

    /// Enter runs the highlighted action and closes the overlay — the palette
    /// *does* the thing rather than describing it.
    #[test]
    fn enter_runs_the_highlighted_action() {
        let mut app = App::default();
        app.set_view(View::Network);
        open(&mut app);
        for c in "view.assistant".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE),
            );
        }
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.palette.is_none());
        assert_eq!(app.view, View::Assistant);
    }

    /// A Control chord is not a query character: `Ctrl+T` leaves the query
    /// alone and reaches the global handler, which opens the theme picker.
    #[test]
    fn a_control_chord_is_not_typed_into_the_query() {
        let mut app = App::default();
        open(&mut app);
        let handled = handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL),
        );
        assert!(!handled, "the global handler owns the chord");
        assert_eq!(app.palette.as_ref().map(|s| s.query.as_str()), Some(""));
    }

    /// `fill` substitutes in order and leaves a template with more placeholders
    /// than arguments readable rather than eating the text.
    #[test]
    fn fill_substitutes_in_order() {
        assert_eq!(fill("a {} b {}", &["1".into(), "2".into()]), "a 1 b 2");
        assert_eq!(fill("no placeholders", &[]), "no placeholders");
        assert_eq!(fill("{} and {}", &["1".into()]), "1 and {}");
        assert_eq!(
            fill("已保存 {} 字节到 {}", &["41".into(), "x.log".into()]),
            "已保存 41 字节到 x.log"
        );
    }
}
