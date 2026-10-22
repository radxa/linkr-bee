//! Modal dialogs: the keyboard help, the notice log, the confirmation a guarded
//! command asks for before it goes out, and the one-line prompt that a settings
//! value starts from.
//!
//! A dialog is *state*, not a widget. `App` holds an `Option<Dialog>` and this
//! module owns what each one means, what it says and which keys it answers to;
//! `ui::overlay` paints it. Keeping the two apart is what lets a dialog be
//! tested without a terminal, and it is why the scroll arithmetic below can be
//! asserted directly.
//!
//! The confirmation is the one that matters. `reboot` over a UART is not
//! undoable, and a quick-send row that fired on the first Enter would turn a
//! cursor slip into a rebooted bridge — so the guarded rows go through here,
//! once, with the exact command spelled out in the prompt. The highlighted
//! button starts on *Cancel* for the same reason: a dialog raised by one
//! keystroke must not be answerable by another.
//!
//! The prompt is the same idea with a text field: a value like a WiFi name or an
//! upload URL cannot be typed by a keystroke alone, because *which* value is not
//! a thing a key says. It carries its own labels as [`Entry`] pairs rather than
//! looking them up in the shared table, so a dialog's words stay next to the
//! dialog.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Alignment;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::app::App;
use crate::capability::GlyphSet;
use crate::event::NoticeLevel;
use crate::i18n::{entry, Entry, Lang};
use crate::text::{self, fill};
use crate::theme::Theme;
use crate::views::terminal::wrap_rows;

// --- the overlay's own vocabulary -------------------------------------------
//
// Next to the code that paints it, the way `palette` keeps its own: these are
// the modal layer's words, not the chrome's.

const HELP_TITLE: Entry = [" Keyboard help ", " 键盘帮助 "];
const NOTICES_TITLE: Entry = [" Notice log ", " 通知记录 "];
const CONFIRM_TITLE: Entry = [" Confirm ", " 请确认 "];
const SETTINGS_TITLE: Entry = [" Assistant settings ", " 助手设置 "];

const HELP_KEYS: Entry = [
    "↑↓ scroll · PgUp/PgDn page · Home/End · Esc close",
    "↑↓ 滚动 · PgUp/PgDn 翻页 · Home/End · Esc 关闭",
];
const NOTICES_KEYS: Entry = [
    "↑↓ scroll · PgUp/PgDn page · Home/End · Esc close",
    "↑↓ 滚动 · PgUp/PgDn 翻页 · Home/End · Esc 关闭",
];
const SETTINGS_KEYS: Entry = [
    "Tab/↑↓ field · Enter save · PgDn scroll · Esc close",
    "Tab/↑↓ 换字段 · Enter 保存 · PgDn 滚动 · Esc 关闭",
];
const CONFIRM_KEYS: Entry = [
    "←→ choose · Enter run the highlighted button · y confirm · n/Esc cancel",
    "←→ 选择 · Enter 执行高亮按钮 · y 确认 · n/Esc 取消",
];

const NOTICES_EMPTY: Entry = ["Nothing has been announced yet.", "暂无通知。"];
const BUTTON_YES: Entry = [" Confirm ", " 确认 "];
const BUTTON_NO: Entry = [" Cancel ", " 取消 "];
const CONFIRM_SEND: Entry = ["Send “{}” to the device?", "将“{}”发送到设备？"];
const CONFIRM_SEND_DETAIL: Entry = [
    "The device runs it at once, and there is no undo.",
    "设备会立即执行，且无法撤销。",
];

// --- the cheat sheet ---------------------------------------------------------

const CHEAT_TITLE: Entry = [" Cheat sheet ", " 速查参考 "];
const CHEAT_KEYS: Entry = [
    "↑↓ choose · Enter send · Esc close",
    "↑↓ 选择 · 回车发送 · Esc 关闭",
];
const CHEAT_GRP_FILES: Entry = ["Files & Dirs", "文件与目录"];
const CHEAT_GRP_SYS: Entry = ["System", "系统信息"];
const CHEAT_GRP_NET: Entry = ["Network", "网络"];
const CHEAT_GRP_PERM: Entry = ["Permissions & Processes", "权限与进程"];

/// The commands the sheet offers, in the four groups the web's chips use
/// (`web/app.js` `CHEATS`), in the same order.
///
/// Sent verbatim, placeholders included — `cd <dir>` goes out as `cd <dir>`,
/// because that is what the web's click handler does with `data-cmd`, and the
/// two clients must not disagree about what a row means. The placeholder is
/// edited on the target, where the user can also see what it cost.
const CHEAT_GROUPS: &[(Entry, &[(&str, Entry)])] = &[
    (
        CHEAT_GRP_FILES,
        &[
            ("ls -l", ["List in long format", "详细列表"]),
            ("cd <dir>", ["Change directory", "切换目录"]),
            ("pwd", ["Print working directory", "显示当前路径"]),
            ("mkdir <dir>", ["Make directory", "创建目录"]),
            ("cp -r a b", ["Copy recursively", "递归复制"]),
            ("mv a b", ["Move / rename", "移动或重命名"]),
            ("rm -rf <dir>", ["Force remove", "强制删除"]),
            ("cat <file>", ["Show file content", "查看文件内容"]),
            ("grep \"x\" <f>", ["Search text", "搜索文本"]),
            ("find . -name \"*.c\"", ["Find files", "查找文件"]),
        ],
    ),
    (
        CHEAT_GRP_SYS,
        &[
            ("uname -a", ["Kernel info", "内核信息"]),
            ("df -h", ["Disk usage", "磁盘使用"]),
            ("free -h", ["Memory usage", "内存使用"]),
            ("top", ["Process monitor", "进程监控"]),
            ("uptime", ["System uptime", "运行时长"]),
        ],
    ),
    (
        CHEAT_GRP_NET,
        &[
            ("ip a", ["Network interfaces", "网络接口"]),
            ("ping <host>", ["Ping a host", "连通测试"]),
            ("ssh u@host", ["Remote login", "远程登录"]),
            ("scp a u@h:", ["Secure copy", "安全拷贝"]),
            ("curl -I <url>", ["Fetch headers", "请求响应头"]),
        ],
    ),
    (
        CHEAT_GRP_PERM,
        &[
            ("chmod 755 <f>", ["Change mode", "修改权限"]),
            ("chown u:g <f>", ["Change owner", "修改属主"]),
            ("ps aux", ["List processes", "进程列表"]),
            ("kill -9 <pid>", ["Kill process", "终止进程"]),
            ("sudo <cmd>", ["Run as root", "提权执行"]),
        ],
    ),
];

// --- the UART window ---------------------------------------------------------

const UART_TITLE: Entry = [" UART settings ", " UART 设置 "];
const UART_PROMPT: Entry = [
    "Set the bridge UART: baud,data,parity,stop,flow",
    "设置桥接 UART：波特率,数据位,校验,停止位,流控",
];
const UART_KEYS: Entry = ["Enter send · Esc close", "回车发送 · Esc 关闭"];
const UART_QUERYING: Entry = ["querying uart…", "正在查询 uart…"];
const UART_SETTING: Entry = ["setting uart={}…", "正在设置 uart={}…"];

/// What the field starts at: the rate a bridge is most often at, and the shape
/// the firmware's own `ERR` line spells out. Corrected by the answer the query
/// brings, which is what makes the common case — change one number — a short
/// edit rather than a typing exercise.
const UART_DEFAULT: &str = "115200,8,n,1,none";

// --- the prompts ----------------------------------------------------

const PROMPT_KEYS: Entry = [
    "type the path · ←→ move · Enter start · Esc cancel",
    "输入路径 · ←→ 移动 · Enter 开始 · Esc 取消",
];

/// How long a character typed into a masked field stays in the clear before
/// its star takes it back.
///
/// The moment the assistant's key field gives its own characters: one
/// keystroke's worth of proof that the keyboard is reaching the field, and no
/// more — a password read off the screen is a password that has to be changed.
const PROMPT_REVEAL: Duration = Duration::from_millis(1500);
// --- the network prompts ----------------------------------------------------

const WIFI_TITLE: Entry = [" Join a WiFi network ", " 加入 WiFi 网络 "];
const WIFI_PASSWORD_TITLE: Entry = [" WiFi password ", " WiFi 密码 "];
const WEBDAV_TITLE: Entry = [" WebDAV log upload ", " WebDAV 日志上传 "];
const BLE_NAME_TITLE: Entry = [" BLE advertised name ", " BLE 广播名 "];
const LAN_HOST_TITLE: Entry = [" LAN host ", " 局域网主机 "];
const LAN_TOKEN_TITLE: Entry = [" LAN token ", " 局域网令牌 "];

const LEVEL_INFO: Entry = ["info", "信息"];
const LEVEL_WARN: Entry = ["warn", "警告"];
const LEVEL_ERROR: Entry = ["error", "错误"];

const HELP_NOTE: Entry = [
    "Every other key goes to the device while the terminal view is up: the letters, the cursor keys, Home/End, Delete — and Tab, which completes on the target. While the pane has the keyboard and a link is up, Ctrl+C interrupts the device too. The assistant's chords — Ctrl+N, Ctrl+V, Alt+↑/↓ — are the assistant's only while its panel or its view holds the keyboard; with the pane focused they go to the device like any other key.",
    "终端视图在前时，其余按键都会发送到设备：字母、方向键、Home/End、Delete，以及用于补全的 Tab。键盘在终端且已连接时，Ctrl+C 也发给设备（中断正在运行的程序）。助手的按键（Ctrl+N、Ctrl+V、Alt+↑/↓）只在面板或助手视图持有键盘时属于助手；焦点在终端时，它们和其他按键一样发给设备。",
];

/// The help overlay's chord list. The keys stay literal — they are what the
/// keyboard produces — and only the meaning is translated.
const HELP_ROWS: &[(&str, Entry)] = &[
    ("Ctrl+P", ["Command palette", "命令面板"]),
    ("F1", ["This help", "本帮助"]),
    ("F2–F5", ["Switch the view", "切换视图"]),
    (
        "F6",
        ["Hide or show the assistant panel", "显示或隐藏助手面板"],
    ),
    ("Ctrl+B", ["Hide or show the sidebar", "显示或隐藏侧栏"]),
    (
        "Ctrl+←/→",
        [
            "Move the keyboard: pane, rail, assistant",
            "移动焦点：终端、侧栏、助手",
        ],
    ),
    (
        "Ctrl+Up",
        ["Focus the sidebar (Esc returns)", "聚焦侧栏（Esc 返回）"],
    ),
    ("↑ / ↓", ["Walk the sidebar", "在侧栏中移动"]),
    ("Enter", ["Send the preset / activate", "发送预设 / 激活"]),
    (
        "Ctrl+C",
        [
            "Interrupt the device (pane focused, link up)",
            "中断设备（终端聚焦且已连接）",
        ],
    ),
    (
        "Ctrl+Shift+C",
        ["Arm Ctrl for the next key", "武装 Ctrl 给下一个键"],
    ),
    (
        "Ctrl+Shift+R",
        ["Arm Shift for the next key", "武装 Shift 给下一个键"],
    ),
    (
        "Ctrl+Shift+A",
        ["Arm Alt for the next key", "武装 Alt 给下一个键"],
    ),
    ("PgUp / PgDn", ["Scroll the pane", "滚动终端"]),
    ("End", ["Jump to the newest line", "跳到最新一行"]),
    (
        "Ctrl+N",
        [
            "New conversation (assistant focused)",
            "新建对话（助手聚焦时）",
        ],
    ),
    (
        "Alt+↑/↓",
        [
            "Switch conversation (assistant focused)",
            "切换对话（助手聚焦时）",
        ],
    ),
    (
        "Ctrl+V",
        [
            "Paste into the composer (assistant focused)",
            "粘贴到输入框（助手聚焦时）",
        ],
    ),
    ("Ctrl+L", ["Clear the pane", "清屏"]),
    ("Ctrl+Shift+Y", ["Copy the screen", "复制整屏"]),
    ("Ctrl+T", ["Choose the theme", "选择主题"]),
    ("Ctrl+Q", ["Quit", "退出"]),
];

/// Columns the help list gives the key before the meaning.
///
/// The longest chord is `Ctrl+Shift+C`, twelve columns; four columns of air
/// after it keep the two columns from reading as one word. A key is never
/// longer than this, and the meaning column is the same on every row.
const HELP_KEY_WIDTH: usize = 16;

// --- the dialog state --------------------------------------------------------

/// Which modal is open, and how far it has been scrolled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dialog {
    /// The keyboard help, scrolled to a row.
    Help(usize),
    /// The notice log, scrolled to a row.
    Notices(usize),
    /// A guarded action waiting for a yes.
    Confirm(Confirm),
    /// A one-line answer waiting to be typed.
    Prompt(Prompt),
    /// The boards a scan heard, waiting for a pick.
    DevicePick(DevicePick),
    /// The cheat sheet, cursor included.
    Cheat(Cheat),
    /// The bridge's UART: a settings field with the bridge's answer under it.
    Uart(Uart),
    /// The assistant's settings, scrolled to a row.
    ///
    /// Its own window rather than a section of the assistant view: the fields
    /// and the note list are what the view was showing *instead of* the
    /// conversation, and a form a user opens on purpose is easier to fill than
    /// one they scroll past. The caret is `assistant.focus` — one piece of
    /// state, so the paste chord and the painter agree about where the keys
    /// go — and this carries only how far the body has been scrolled.
    Settings(usize),
    /// The themes the interface ships, with the keyboard's cursor on one.
    ThemePick(ThemePick),
    /// The conversations this device remembers, waiting for a pick to delete.
    ChatPick(ChatPick),
    /// The card about the program itself: the mark, the version, the licence
    /// and the project's address. Nothing to answer, so any key puts it away —
    /// except `L`, which opens the component page.
    About,
    /// The third-party components and the people who built the program,
    /// scrolled to a row. The summary lives in About; this is the page a user
    /// opens from it, and the command line's `--licenses` is its full tail.
    Licenses(usize),
}

const T_PICK: Entry = ["Choose a board", "选择设备"];
const THEME_TITLE: Entry = ["Theme", "主题"];
/// The card about the program: its title, and the five facts on it. The
/// version, the licence and the addresses come from the crate's own manifest
/// and the project's people, so they cannot drift from what was built; only
/// the labels are words.
const ABOUT_TITLE: Entry = ["About", "关于"];
const ABOUT_KEYS: Entry = [
    "L components · Enter/Esc close",
    "L 开源组件 · 回车/Esc 关闭",
];
const ABOUT_VERSION: Entry = ["Version", "版本"];
const ABOUT_LICENSE: Entry = ["Licence", "许可证"];
const ABOUT_CONTRIBUTOR: Entry = ["Contributor", "贡献者"];
const ABOUT_PROJECT: Entry = ["Project", "项目"];
const ABOUT_RENDER: Entry = ["Rendering", "渲染"];
const ABOUT_COMPONENTS: Entry = ["Components", "开源组件"];
const ABOUT_COMPONENTS_VALUE: Entry = ["{} direct · {} total (L)", "直接 {} · 共 {}（L）"];
/// The label column the six facts are padded to, so their values line up
/// down the card in either language.
const ABOUT_LABEL: usize = 12;

/// The rows the facts need below the mark: the blank, the name, another
/// blank, and one row per fact. The mark is painted only when it leaves
/// these — a card that pushed its own version number out of a short window
/// would be a logo about itself.
const ABOUT_FACTS: u16 = 9;

const LICENSES_TITLE: Entry = [" Open-source components ", " 开源组件 "];
const LICENSES_KEYS: Entry = [
    "↑↓ scroll · PgUp/PgDn page · Home/End · Esc close",
    "↑↓ 滚动 · PgUp/PgDn 翻页 · Home/End · Esc 关闭",
];
const LICENSES_DIRECT: Entry = ["Direct dependencies ({})", "直接依赖（{}）"];
const LICENSES_TRANSITIVE: Entry = [
    "Plus {} transitive crates; the full list is in bee --licenses and THIRD_PARTY_LICENSES.md.",
    "另有 {} 个传递依赖；完整列表见 bee --licenses 和 THIRD_PARTY_LICENSES.md。",
];
const LICENSES_CONTRIBUTORS: Entry = ["Contributors", "贡献者"];
const LICENSES_LICENSE: Entry = ["Project licence", "项目许可证"];
const LICENSES_NOTE: Entry = [
    "Licence texts are reproduced in THIRD_PARTY_LICENSES.md and bee --licenses; the project licence is in LICENSE.",
    "许可证全文见 THIRD_PARTY_LICENSES.md 和 bee --licenses；本项目许可证见 LICENSE。",
];
/// The keys, in the order the window is used: move, keep, back out. "Keep"
/// rather than "apply" because the preview has already applied — Enter is what
/// makes the choice outlive the window.
const THEME_KEYS: Entry = [
    "↑↓ preview · Enter keep · Esc cancel",
    "↑↓ 预览 · 回车确定 · Esc 取消",
];
/// The picker's two outcomes say *what is happening*; the legend under them
/// says which keys are live. They are separate lines so that neither states
/// the other's business — a scanning window that read `Scanning… Esc cancels`
/// twice, once in the body and once above the keys, was saying it twice.
const PICK_SCANNING: Entry = ["Scanning…", "正在扫描…"];
const PICK_SCANNING_KEYS: Entry = ["Esc cancels", "Esc 取消"];
const PICK_EMPTY: Entry = ["No board answered.", "没有设备应答。"];
const PICK_EMPTY_KEYS: Entry = ["Enter scans again · Esc close", "回车重新扫描 · Esc 关闭"];
const PICK_KEYS: Entry = [
    "↑↓ move · Enter connect · Esc close",
    "↑↓ 选择 · 回车连接 · Esc 关闭",
];
const CHAT_PICK_TITLE: Entry = ["Delete a conversation", "删除对话"];
/// The picker's keys: move, delete, back out. "Delete" rather than "forget":
/// the row goes for good, and the legend is where that is said once.
const CHAT_PICK_KEYS: Entry = [
    "↑↓ move · Enter delete · Esc cancel",
    "↑↓ 选择 · 回车删除 · Esc 取消",
];
/// A conversation with no question yet has no name; the picker still has to
/// paint a row for it.
const CHAT_UNTITLED: Entry = ["(no messages)", "(空对话)"];
/// The mark beside the conversation the panel is showing.
const CHAT_SHOWN: Entry = [" · shown", " · 正在显示"];

/// The boards a Bluetooth scan heard, and which one the keyboard is on.
///
/// A list rather than a prompt, because the answer is a *choice* and not a
/// value: `--ble-address` can name one, but a user with two boards on the bench
/// has no way to tell which MAC is which, and a scan is the only thing that
/// knows. Keep the list in the dialog so the keyboard answers to it the way it
/// answers to every other dialog.
///
/// Whether a device speaks the serial service is marked beside its name, and
/// the scan hands the list only serial-service boards: everything else is a
/// device this bridge has nothing to say to, and a `--scan` on a shell is
/// where the full picture is, advertising-without-the-service included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevicePick {
    /// What has been heard so far, best first.
    pub devices: Vec<crate::cli::FoundDevice>,
    /// Which row the keyboard is on.
    pub cursor: usize,
    /// The first row the window shows. The cursor walks the list; this walks
    /// the window, so a bench with more boards than the modal has rows still
    /// shows the row the keyboard is on.
    pub scroll: usize,
    /// Whether the scan is still listening.
    pub scanning: bool,
    /// Why the scan could not run, when it could not.
    pub message: String,
}

impl DevicePick {
    /// The board under the cursor, which is what Enter dials.
    pub fn selected(&self) -> Option<&crate::cli::FoundDevice> {
        self.devices.get(self.cursor)
    }

    /// How many rows the keyboard can reach.
    pub fn rows(&self) -> usize {
        self.devices.len()
    }

    /// How many rows each device takes at `width`, in the glyph set the paint
    /// will use: the meter is four cells in either set, so the count is the
    /// painter's own.
    ///
    /// One when its row fits the box whole, more when the window is too
    /// narrow for it and the row wraps. The scroll counts *rows*, and this is
    /// the count the painter will use — the same helper, so the two cannot
    /// disagree about how tall one device is.
    pub fn line_spans(&self, width: usize, glyphs: GlyphSet) -> Vec<usize> {
        self.devices
            .iter()
            .map(|device| device_rows(device, width, glyphs).len())
            .collect()
    }

    /// Move the cursor, clamped to the list.
    pub fn move_cursor(&mut self, down: bool) {
        let last = self.devices.len().saturating_sub(1);
        if down {
            self.cursor = (self.cursor + 1).min(last);
        } else {
            self.cursor = self.cursor.saturating_sub(1);
        }
    }

    /// Move the window the least amount that keeps the cursor's own rows
    /// inside `room` visible rows.
    ///
    /// `room` is what the modal can show, which the key handler asks for the
    /// same way the painter does — through the painter's own arithmetic, so
    /// the two cannot disagree about how tall the box is. `line_spans` is
    /// [`DevicePick::line_spans`] at the width being painted: a device whose
    /// row wraps is more than one row of the box, and the window scrolls in
    /// the rows the box actually has. Zero means no paint has said (a
    /// headless test, the first tick): the window keeps what it had.
    pub fn follow(&mut self, room: usize, line_spans: &[usize]) {
        if room == 0 {
            return;
        }
        let top: usize = line_spans.iter().take(self.cursor).sum();
        let span = line_spans.get(self.cursor).copied().unwrap_or(1);
        if top < self.scroll {
            self.scroll = top;
        } else if top + span > self.scroll + room {
            self.scroll = top + span - room;
        }
    }

    /// The first row the window shows.
    pub fn scroll(&self) -> usize {
        self.scroll
    }
}

/// The themes the interface ships, waiting for a pick.
///
/// A list rather than a ring to walk: stepping one theme per press is fine for
/// the web's own dark/light pair and useless for six palettes — the way to
/// *choose* is to see them all at once. Moving the cursor previews by setting
/// the theme itself, so what is on screen is always what Enter would keep, and
/// `original` is what Escape puts back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemePick {
    /// Which theme the keyboard is on, an index into [`crate::theme::THEMES`].
    pub cursor: usize,
    /// The theme that was live when the window opened — Escape restores it.
    pub original: crate::theme::ThemeChoice,
}

/// The conversations the panel is holding, and which one Enter forgets.
///
/// The panel keeps a list of threads, a conversation that is deleted is
/// deleted for good, and the palette's delete used to mean "the one on
/// screen" — a choice nobody was shown. This is the list: a row per
/// conversation, the one the panel is showing marked, and the cursor is where
/// a delete lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatPick {
    /// Which row the keyboard is on.
    pub cursor: usize,
}

impl ChatPick {
    /// Move the cursor, clamped to the list.
    pub fn move_cursor(&mut self, down: bool, last: usize) {
        if down {
            self.cursor = (self.cursor + 1).min(last);
        } else {
            self.cursor = self.cursor.saturating_sub(1);
        }
    }
}

/// The cheat sheet: the commands the web's chips send, in four groups, with a
/// cursor over them.
///
/// A cursor rather than a scroll offset alone, because Enter sends the row the
/// cursor is on — so the row *is* the state. The sheet stays open after a send,
/// which is what makes it a sheet to work from rather than a menu to answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cheat {
    /// Which command the keyboard is on, counted over the commands only; the
    /// group headings are not rows the cursor lands on.
    pub selected: usize,
    /// How far the body has been scrolled, in rows.
    pub scroll: usize,
}

/// How many commands the cursor can point at (the group headings are not
/// rows).
fn cheat_count() -> usize {
    CHEAT_GROUPS.iter().map(|(_, items)| items.len()).sum()
}

/// The `selected`th command, or `None` past the end.
fn cheat_command(selected: usize) -> Option<&'static str> {
    CHEAT_GROUPS
        .iter()
        .flat_map(|(_, items)| items.iter())
        .map(|(command, _)| *command)
        .nth(selected)
}

/// The command column's width: as wide as the widest command, but never so
/// wide that the descriptions lose their room in a narrow box — and never so
/// narrow that a command is cut down to its first character.
fn cheat_command_col(width: usize) -> usize {
    let widest = CHEAT_GROUPS
        .iter()
        .flat_map(|(_, items)| items.iter())
        .map(|(command, _)| text::columns(command))
        .max()
        .unwrap_or(0);
    widest.min(width.saturating_sub(24).max(8))
}

/// The bridge UART window: the spec in a field, the bridge's answer below.
///
/// A window rather than a prompt because the write is a question and the
/// answer is the confirmation — a bridge that could not change rate keeps the
/// old one and says so — so the box has to stay up to be read. Enter therefore
/// sends and Escape closes, the way the cheat sheet's window works.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uart {
    /// The spec being edited: `baud,data,parity,stop,flow`.
    pub field: Field,
    /// The bridge's answer, once it arrives.
    pub status: Option<String>,
    /// Why nothing was changed: a spec that does not parse, a link that cannot
    /// carry the question, a bridge that refused. Under the field, not instead
    /// of it — the field is what the user is going to fix.
    pub error: Option<String>,
}

/// A one-line text field: what has been typed, and where the caret is.
///
/// The dialog owns what an answer *means*; this owns the editing, so the
/// prompt and the UART window move a caret by the same rules — one character
/// at a time, never mid-character.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Field {
    /// What has been typed.
    pub text: String,
    /// Where the caret is, as a byte offset into `text`. It only ever sits on
    /// a character boundary: every move here shifts it by a whole character.
    pub cursor: usize,
}

impl Field {
    /// A field already holding `text`, with the caret after it.
    pub fn new(text: &str) -> Field {
        Field {
            text: text.to_string(),
            cursor: text.len(),
        }
    }

    /// Insert `ch` at the caret.
    pub fn insert(&mut self, ch: char) {
        self.text.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
    }

    /// Insert `text` at the caret: a paste is typing that arrived at once.
    ///
    /// The text is taken as it comes; a field that is one line long is fixed
    /// by its caller before it gets here, because only the caller knows
    /// whether a newline means a line break or was just the clipboard's
    /// ending.
    pub fn insert_str(&mut self, text: &str) {
        self.text.insert_str(self.cursor, text);
        self.cursor += text.len();
    }

    /// Remove the character before the caret.
    pub fn backspace(&mut self) {
        if let Some(ch) = self.text[..self.cursor].chars().next_back() {
            let at = self.cursor - ch.len_utf8();
            self.text.remove(at);
            self.cursor = at;
        }
    }

    /// Remove the character under the caret.
    pub fn delete(&mut self) {
        if self.cursor < self.text.len() {
            self.text.remove(self.cursor);
        }
    }

    /// Move the caret one character left, stopping at the start.
    pub fn left(&mut self) {
        if let Some(ch) = self.text[..self.cursor].chars().next_back() {
            self.cursor -= ch.len_utf8();
        }
    }

    /// Move the caret one character right, stopping at the end.
    pub fn right(&mut self) {
        if let Some(ch) = self.text[self.cursor..].chars().next() {
            self.cursor += ch.len_utf8();
        }
    }

    /// Move the caret to the start.
    pub fn home(&mut self) {
        self.cursor = 0;
    }

    /// Move the caret to the end.
    pub fn end(&mut self) {
        self.cursor = self.text.len();
    }

    /// The field in three pieces: before the caret, the character under it, and
    /// after. The middle is a space at the end of the line, so the caret is
    /// always exactly one cell and the painter never has to special-case it.
    pub fn split(&self) -> (&str, &str, &str) {
        let at = self.cursor.min(self.text.len());
        let (before, rest) = self.text.split_at(at);
        match rest.chars().next() {
            Some(ch) => {
                let (under, after) = rest.split_at(ch.len_utf8());
                (before, under, after)
            }
            None => (before, " ", ""),
        }
    }

    /// The answer, without the whitespace around it. A trailing space at the end
    /// of a path is easy to type and never meant, and a leading one hides.
    pub fn answer(&self) -> &str {
        self.text.trim()
    }
}

/// A text field: a question, an answer, and what agreeing to it does.
///
/// A prompt rather than a second command line: the interface has no command
/// line, and a settings value needs exactly one argument. Keeping it a dialog means it
/// takes the keyboard the same way the others do, and that the answer is a
/// value the tests can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    /// The box's title, in both languages.
    pub title: Entry,
    /// The question, one line above the field.
    pub label: Entry,
    /// What the field shows while it is empty, so an empty box still says what
    /// shape of answer it wants.
    pub placeholder: Entry,
    /// What has been typed, and where the caret is.
    pub field: Field,
    /// Whether the field shows stars instead of what was typed. Starts on for
    /// an answer that is a secret — a password, or a token that reached a
    /// screenshot has to be rotated — and Ctrl+R flips it either way, for as
    /// long as it takes to check one character.
    pub masked: bool,
    /// The character of a masked field that is still in the clear, as its index
    /// among the field's characters, and when its star takes it back.
    ///
    /// Only ever the character an edit just put there. See [`PROMPT_REVEAL`].
    pub reveal: Option<(usize, Instant)>,
    /// What agreeing to it does.
    pub action: PromptAction,
}

/// What agreeing to a prompt does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptAction {
    /// Name the network to join. Answered by a second prompt for its password,
    /// because the two are one command on the wire and a half of that command
    /// is not a thing that can be sent.
    WifiSsid,
    /// The password for the network just named. Held nowhere: it goes straight
    /// from the field into the command and out of the process.
    WifiPassword,
    /// Where the bridge uploads its logs, using anonymous HTTP.
    WebdavUrl,
    /// The name the bridge advertises to BLE scanners.
    BleName,
    /// The address a LAN dial goes to, kept in the sidebar row it edits.
    LanHost,
    /// The token that dial carries. Held in the sidebar row and in the dial,
    /// never in a notice or a log.
    LanToken,
}

impl PromptAction {
    /// Whether the answer is a secret — the password to a network, the token a
    /// dial signs with.
    ///
    /// A secret is painted as stars, with one character in the clear for a
    /// moment after an edit put it there, and Ctrl+R shows the whole of it for
    /// as long as it takes to check. See [`PROMPT_REVEAL`].
    fn asks_for_a_secret(self) -> bool {
        matches!(self, PromptAction::WifiPassword | PromptAction::LanToken)
    }
}

impl Prompt {
    /// An empty prompt.
    pub fn new(title: Entry, action: PromptAction) -> Prompt {
        Prompt {
            title,
            label: Self::label(action),
            placeholder: Self::placeholder(action),
            field: Field::default(),
            masked: action.asks_for_a_secret(),
            reveal: None,
            action,
        }
    }

    /// A prompt already holding `text`, with the caret after it.
    ///
    /// Used when the answer is a change to one already given — renaming a
    /// network that is half typed — so that correcting one character does not
    /// mean typing the whole name again.
    pub fn with_text(title: Entry, action: PromptAction, text: &str) -> Prompt {
        let mut prompt = Prompt::new(title, action);
        prompt.field = Field::new(text);
        prompt
    }

    /// Text just landed in the field: its last character stays in the clear for
    /// its moment, the way the assistant's key field shows a character it was
    /// given. Called by both doors text can come through — a keystroke and a
    /// paste.
    ///
    /// An edit leaves the caret after what it put there, so the character that
    /// just arrived is the one before the caret — *not* the last character of
    /// the answer, which is a different character whenever the caret is in the
    /// middle of it. The second reading of an index is what a reveal on the end
    /// of the line would show: someone else's character, in the clear.
    pub fn show_last_char(&mut self) {
        let typed = self.field.text[..self.field.cursor].chars().count();
        self.reveal = Some((typed.saturating_sub(1), Instant::now() + PROMPT_REVEAL));
    }

    /// Text just left the field: the reveal goes out, because the index it
    /// holds is a place in the text and the edit moved the characters left
    /// into it.
    fn hide_the_char(&mut self) {
        self.reveal = None;
    }

    /// The character still in the clear, if its moment has not passed.
    fn revealed(&self) -> Option<usize> {
        match self.reveal {
            Some((at, until)) if Instant::now() < until => Some(at),
            _ => None,
        }
    }

    /// The question this action's field asks, in the interface language.
    fn label(action: PromptAction) -> Entry {
        match action {
            PromptAction::WifiSsid => ["Network to join (SSID)", "要加入的网络名称（SSID）"],
            PromptAction::WifiPassword => [
                "Its password (may be empty; Ctrl+R shows it)",
                "该网络的密码（可留空；Ctrl+R 显示）",
            ],
            PromptAction::WebdavUrl => [
                "Anonymous HTTP upload URL (http://)",
                "匿名 HTTP 上传地址（http://）",
            ],
            PromptAction::BleName => [
                "1-29 UTF-8 bytes; Chinese and emoji are allowed",
                "1–29 个 UTF-8 字节，支持中文和 emoji",
            ],
            PromptAction::LanHost => [
                "The bridge's LAN address (the board's WiFi IP)",
                "桥接的局域网地址（板子的 WiFi IP）",
            ],
            PromptAction::LanToken => [
                "32 hex characters, blank when LAN auth is off (Ctrl+R shows it)",
                "32 位十六进制，未启用鉴权时留空（Ctrl+R 切换显示）",
            ],
        }
    }

    /// What the empty field says, which is how it tells you the shape of
    /// answer it wants.
    fn placeholder(action: PromptAction) -> Entry {
        match action {
            PromptAction::WifiSsid => ["for example BenchNet", "例如 BenchNet"],
            PromptAction::WifiPassword => ["empty for an open network", "留空表示开放网络"],
            PromptAction::WebdavUrl => [
                "for example http://dav.example.com/logs/",
                "例如 http://dav.example.com/logs/",
            ],
            PromptAction::BleName => ["for example Bench Bee 078C", "例如 测试😀"],
            PromptAction::LanHost => ["for example 192.168.0.100", "例如 192.168.0.100"],
            PromptAction::LanToken => ["empty when the bridge wants none", "未启用鉴权时留空"],
        }
    }
}

impl Dialog {
    /// The row the dialog is scrolled to. The help, the log, the settings and
    /// the cheat sheet scroll; a confirmation and a prompt are the size of
    /// their content.
    pub fn scroll(&self) -> usize {
        match self {
            Dialog::Help(offset)
            | Dialog::Notices(offset)
            | Dialog::Settings(offset)
            | Dialog::Licenses(offset)
            | Dialog::Cheat(Cheat { scroll: offset, .. }) => *offset,
            // The list's window is its own: the cursor walks the devices and
            // the scroll keeps up with it, which a dialog-wide offset has no
            // way to know.
            Dialog::DevicePick(pick) => pick.scroll(),
            Dialog::Confirm(_)
            | Dialog::Prompt(_)
            | Dialog::Uart(_)
            | Dialog::ThemePick(_)
            | Dialog::ChatPick(_)
            | Dialog::About => 0,
        }
    }
}

/// The dialog's title, spaces included so the painter passes it on untouched.
pub fn title(dialog: &Dialog, lang: Lang) -> &'static str {
    match dialog {
        Dialog::Help(_) => entry(HELP_TITLE, lang),
        Dialog::Notices(_) => entry(NOTICES_TITLE, lang),
        Dialog::Confirm(_) => entry(CONFIRM_TITLE, lang),
        Dialog::Prompt(prompt) => entry(prompt.title, lang),
        Dialog::DevicePick(_) => entry(T_PICK, lang),
        Dialog::Cheat(_) => entry(CHEAT_TITLE, lang),
        Dialog::Uart(_) => entry(UART_TITLE, lang),
        Dialog::Settings(_) => entry(SETTINGS_TITLE, lang),
        Dialog::ThemePick(_) => entry(THEME_TITLE, lang),
        Dialog::ChatPick(_) => entry(CHAT_PICK_TITLE, lang),
        Dialog::About => entry(ABOUT_TITLE, lang),
        Dialog::Licenses(_) => entry(LICENSES_TITLE, lang),
    }
}

/// The key legend along the dialog's bottom row.
pub fn legend(dialog: &Dialog, lang: Lang, theme: &Theme) -> Line<'static> {
    let text = match dialog {
        Dialog::Help(_) => entry(HELP_KEYS, lang),
        Dialog::Notices(_) => entry(NOTICES_KEYS, lang),
        Dialog::Confirm(_) => entry(CONFIRM_KEYS, lang),
        Dialog::Prompt(_) => entry(PROMPT_KEYS, lang),
        Dialog::Cheat(_) => entry(CHEAT_KEYS, lang),
        Dialog::Uart(_) => entry(UART_KEYS, lang),
        Dialog::DevicePick(pick) => {
            if pick.scanning {
                entry(PICK_SCANNING_KEYS, lang)
            } else if pick.devices.is_empty() {
                entry(PICK_EMPTY_KEYS, lang)
            } else {
                entry(PICK_KEYS, lang)
            }
        }
        Dialog::Settings(_) => entry(SETTINGS_KEYS, lang),
        Dialog::ThemePick(_) => entry(THEME_KEYS, lang),
        Dialog::ChatPick(_) => entry(CHAT_PICK_KEYS, lang),
        Dialog::About => entry(ABOUT_KEYS, lang),
        Dialog::Licenses(_) => entry(LICENSES_KEYS, lang),
    };
    // The legend is the interface's own line: ` · ` between two keys, `↑↓` in
    // one, `…` after a verb — all folded for a terminal whose font is ASCII.
    Line::from(Span::styled(theme.fold(text), theme.muted()))
}

// --- opening -----------------------------------------------------------------

/// Put a dialog on the screen, taking the keyboard from whatever had it.
///
/// The palette is closed rather than left underneath: a dialog is the top of
/// the modal stack, and one painted over a palette that is still taking keys
/// would be a window the user can see but not answer. `Ctrl+P` is the other
/// direction and stays legal — the palette opens over a dialog and takes the
/// keys back — which is what `handle_key` in `main.rs` dispatches for.
fn raise(app: &mut App, dialog: Dialog) {
    app.palette = None;
    app.dialog = Some(dialog);
}

/// Raise the keyboard help.
pub fn open_help(app: &mut App) {
    raise(app, Dialog::Help(0));
}

/// Raise the notice log.
pub fn open_notices(app: &mut App) {
    raise(app, Dialog::Notices(0));
}

/// Raise the cheat sheet, on its first command.
pub fn open_cheat(app: &mut App) {
    raise(
        app,
        Dialog::Cheat(Cheat {
            selected: 0,
            scroll: 0,
        }),
    );
}

/// Raise the UART window, asking the bridge what it is running as it opens.
///
/// The question goes over the management channel, so a session without one —
/// a LAN dial, a dead link — gets its refusal on the window's own error line
/// rather than a box that silently never fills in.
pub fn open_uart(app: &mut App) {
    let mut uart = Uart {
        field: Field::new(UART_DEFAULT),
        status: Some(
            app.theme()
                .fold(entry(UART_QUERYING, app.lang))
                .into_owned(),
        ),
        error: None,
    };
    if let Err(why) = app.ask_device(crate::device::Query::Uart) {
        uart.status = None;
        uart.error = Some(why);
    }
    raise(app, Dialog::Uart(uart));
}

/// Raise the assistant's settings.
///
/// The caret is not decided here: it is the caller's field, because the window
/// is reached from three places that mean three different rows — configure, the
/// notice that names the endpoint, and "write a note".
pub fn open_settings(app: &mut App) {
    raise(app, Dialog::Settings(0));
}

/// Raise the theme picker, on the theme that is live right now.
/// Ask which conversation to forget.
///
/// The list the panel holds, the thread it is showing marked, and Enter
/// deletes the row under the cursor. The label the row carries is the one the
/// conversation earned from its first question
/// ([`crate::views::assistant::ChatState`] names it), so a delete can say
/// *which* thread it lands on.
pub fn open_chat_pick(app: &mut App) {
    let cursor = app
        .assistant
        .active
        .min(app.assistant.chats.len().saturating_sub(1));
    raise(app, Dialog::ChatPick(ChatPick { cursor }));
}

pub fn open_theme_pick(app: &mut App) {
    let cursor = crate::theme::THEMES
        .iter()
        .position(|choice| *choice == app.theme)
        .unwrap_or(0);
    raise(
        app,
        Dialog::ThemePick(ThemePick {
            cursor,
            original: app.theme,
        }),
    );
}

/// `Ctrl+T`: open the theme picker, or put it away.
///
/// The chord that opened the window closes it, the way the palette's does —
/// and closing is *cancel*: a preview nobody kept is not a choice, so the
/// theme the window opened on comes back. A different window in the way is
/// left alone rather than replaced; a theme is not worth somebody's
/// half-typed prompt.
pub fn toggle_theme_pick(app: &mut App) {
    match &app.dialog {
        Some(Dialog::ThemePick(pick)) => {
            app.theme = pick.original;
            app.dialog = None;
        }
        Some(_) => {}
        None => open_theme_pick(app),
    }
}

/// Raise the card about the program.
///
/// It answers no question, so it takes no state beyond itself: the version,
/// the licence and the project's address all come from the crate's manifest
/// at compile time, and the mark from the terminal's own capability. What it
/// is *for* is the two things a user asks a terminal program for and cannot
/// see anywhere else: what this is, and where to say something about it.
pub fn open_about(app: &mut App) {
    raise(app, Dialog::About);
}

/// Raise the component page, at its first row.
///
/// The About card and the palette both open it; `L` on the card is the short
/// road. It is a plain scrolled document, so the keyboard's paging keys are the
/// same ones the help and the notice log answer to.
pub fn open_licenses(app: &mut App) {
    raise(app, Dialog::Licenses(0));
}

/// Ask which network to join. The password is asked for next, by the prompt
/// this one's answer opens.
pub fn prompt_wifi_ssid(app: &mut App) {
    let prompt = Prompt::with_text(
        WIFI_TITLE,
        PromptAction::WifiSsid,
        &app.network.ssid_input.clone(),
    );
    raise(app, Dialog::Prompt(prompt));
}

/// Ask for the password of the network the form already names.
///
/// The name is on the row above the keyboard, so asking for it again would be
/// asking twice; joining a named network is the password, and this asks for
/// the half that is not on screen. The answer is held nowhere: it goes from
/// the field into the command and out of the process.
pub fn prompt_wifi_password(app: &mut App) {
    raise(
        app,
        Dialog::Prompt(Prompt::new(WIFI_PASSWORD_TITLE, PromptAction::WifiPassword)),
    );
}

/// Ask where the bridge should upload its logs. The field starts with the URL
/// already reported by `@d?`, so changing one part of it does not mean typing
/// the whole thing again.
pub fn prompt_webdav_url(app: &mut App) {
    let current = app
        .network
        .webdav
        .as_ref()
        .map(|status| status.url.as_str())
        .unwrap_or("");
    let prompt = Prompt::with_text(WEBDAV_TITLE, PromptAction::WebdavUrl, current);
    raise(app, Dialog::Prompt(prompt));
}

/// Ask for the advertised BLE name. The field starts with the name last read
/// from the bridge, so a small correction does not mean retyping it.
pub fn prompt_ble_name(app: &mut App) {
    // The name the board last reported, and the label the air carried when
    // the board has not been asked yet: a prompt that opens empty invites a
    // user to retype a name the interface already knows.
    let current = app
        .network
        .ble_name
        .as_ref()
        .map(|status| status.name.as_str())
        .or(app.advertised_name.as_deref())
        .unwrap_or("");
    let prompt = Prompt::with_text(BLE_NAME_TITLE, PromptAction::BleName, current);
    raise(app, Dialog::Prompt(prompt));
}

/// Ask for the address a LAN dial goes to. The sidebar row shows what the
/// field holds, so an empty answer is an answer: the board's own WiFi address
/// is the fallback a dial falls back to.
pub fn prompt_lan_host(app: &mut App) {
    let prompt = Prompt::with_text(LAN_HOST_TITLE, PromptAction::LanHost, &app.lan_host);
    raise(app, Dialog::Prompt(prompt));
}

/// Ask for the token a LAN dial carries. Masked while it is typed, because a
/// token that reached a screenshot has to be rotated; Ctrl+R shows it for as
/// long as it takes to check one character.
pub fn prompt_lan_token(app: &mut App) {
    let prompt = Prompt::with_text(LAN_TOKEN_TITLE, PromptAction::LanToken, &app.lan_token);
    raise(app, Dialog::Prompt(prompt));
}

/// A confirmation: what is about to happen, and what agreeing does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Confirm {
    /// The command or action, spelled out so the user confirms *what*, not just
    /// *that*.
    pub prompt: String,
    /// The consequence, in one line.
    pub detail: String,
    /// What agreeing does.
    pub action: ConfirmAction,
    /// Which button is highlighted. See the module note on why this starts off.
    pub yes: bool,
}

/// What agreeing to a confirmation does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfirmAction {
    /// Send this line to the device.
    Send(String),
    /// Change how the bridge itself is set up: `@u=…`, `@w=…`, `@d=…`.
    ///
    /// Kept as the command rather than as parsed fields because the command is
    /// what the card shows, what the wire takes, and what the summary words —
    /// and a password parsed into a struct here would be a password with a
    /// longer life than it needs.
    Accessory(String),
}

/// Ask before doing something that cannot be taken back.
pub fn ask(app: &mut App, action: ConfirmAction) {
    let lang = app.lang;
    let (prompt, detail) = match &action {
        ConfirmAction::Send(command) => (
            fill(entry(CONFIRM_SEND, lang), std::slice::from_ref(command)),
            entry(CONFIRM_SEND_DETAIL, lang).to_string(),
        ),
        // Summarised rather than quoted: the command carries the WiFi password,
        // and a card that showed it would put it on the screen in front of
        // whoever is looking. The summary names the network and hides the rest.
        ConfirmAction::Accessory(command) => (
            crate::accessory::accessory_change_summary(command, lang == Lang::Zh),
            app.strings().net_confirm_detail.to_string(),
        ),
    };
    raise(
        app,
        Dialog::Confirm(Confirm {
            prompt,
            detail,
            action,
            yes: false,
        }),
    );
}

// --- the body ----------------------------------------------------------------

/// The glyph and the word standing for a notice's level.
///
/// The three marks are drawn in the terminal's own set: a middle dot for news,
/// an ASCII `!` for a warning, and a cross — the one every font has, in one
/// spelling or the other — for an error.
fn level_badge(level: NoticeLevel, glyphs: GlyphSet) -> (&'static str, Entry) {
    match level {
        NoticeLevel::Info => (glyphs.dot(), LEVEL_INFO),
        NoticeLevel::Warn => ("!", LEVEL_WARN),
        NoticeLevel::Error => match glyphs {
            GlyphSet::Unicode => ("×", LEVEL_ERROR),
            GlyphSet::Ascii => ("x", LEVEL_ERROR),
        },
    }
}

/// The prompt's field: what has been typed, with a caret on the character the
/// next keystroke will go before — drawn as a place, not as a line of text.
///
/// The caret is drawn *in* the text rather than placed with the terminal's own
/// cursor. The box is painted by a `Paragraph`, which has no cursor to move, and
/// a caret that only existed in the live TUI would make the dialog unreadable in
/// a `--print-frame` preview — and untestable.
fn prompt_field(prompt: &Prompt, lang: Lang, theme: &Theme, width: usize) -> Vec<Line<'static>> {
    let spans = if prompt.field.text.is_empty() {
        // Nothing typed: the caret, then what shape of answer the field wants.
        let mut spans = field_spans(&prompt.field, theme);
        spans.push(Span::styled(entry(prompt.placeholder, lang), theme.muted()));
        spans
    } else if !prompt.masked {
        field_spans(&prompt.field, theme)
    } else {
        masked_spans(prompt, theme)
    };
    field_box(spans, theme, width)
}

/// A masked field's spans: one star per character, except the character a
/// keystroke or a paste just put there, which stays in the clear until its
/// moment passes. See [`PROMPT_REVEAL`].
///
/// The stars keep the caret where the text puts it — one cell per character —
/// so revealing a character does not move it, and neither does the character
/// the reveal is on: a character under the caret is one cell whatever it is,
/// and the split hands back a space at the end of the line.
fn masked_spans(prompt: &Prompt, theme: &Theme) -> Vec<Span<'static>> {
    let revealed = prompt.revealed();
    let (before, under, after) = prompt.field.split();
    let stars = |text: &str, from: usize| -> String {
        text.chars()
            .enumerate()
            .map(|(at, ch)| if revealed == Some(from + at) { ch } else { '*' })
            .collect()
    };
    let at = before.chars().count();
    vec![
        Span::styled(stars(before, 0), theme.text()),
        Span::styled(
            if under == " " {
                " ".to_string()
            } else {
                stars(under, at)
            },
            theme.selected(),
        ),
        Span::styled(stars(after, at + 1), theme.text()),
    ]
}

/// The three rows a dialog's field occupies: its top edge, what it holds, and
/// its bottom edge.
///
/// A field that is only its own text is a field nobody can see — on a dark
/// terminal the space between two labels and the place to type into look the
/// same — so the box is drawn: the dialog frame's own furniture one size down.
/// It is also what makes an *empty* field a place rather than a gap, which is
/// the state every prompt opens in, and a box is a place without the filled row
/// a highlight would paint — a background colour run edge to edge reads as a
/// line the user has *selected*, which is not what a field is saying.
fn field_box(spans: Vec<Span<'static>>, theme: &Theme, width: usize) -> Vec<Line<'static>> {
    const INDENT: &str = "  ";
    // What the box's own sides leave for text: the indent, the vertical, and
    // the vertical that closes it.
    let interior = width.saturating_sub(text::columns(INDENT) + 2);
    let mut row = vec![
        Span::styled(INDENT.to_string(), theme.card()),
        Span::styled(theme.glyphs().divider().to_string(), field_line(theme)),
    ];
    let mut room = interior;
    for span in spans {
        if room == 0 {
            break;
        }
        // Clipped to what is left of the interior: a line longer than the box
        // runs out through its own right side, and a box with an open side is
        // not a box.
        let taken = text::clip_to(&span.content, room);
        room -= text::columns(&taken);
        row.push(Span::styled(taken, span.style));
    }
    // Filled to the edge the box's own right side runs down, so the interior
    // reads as one surface rather than as a field that stops mid-air.
    if room > 0 {
        row.push(Span::styled(" ".repeat(room), theme.card()));
    }
    row.push(Span::styled(
        theme.glyphs().divider().to_string(),
        field_line(theme),
    ));
    vec![
        field_edge(theme, width, true),
        Line::from(row),
        field_edge(theme, width, false),
    ]
}

/// One of a field box's horizontal edges: a corner, the rule between, a corner.
/// Its indent is the card's own ground, so the edge does not sit on two columns
/// of another surface.
///
/// The corners are rounded where the font has arcs and `+` where it does not
/// ([`crate::capability::GlyphSet::border`]): a stand-in that keeps the box
/// closed, which is the one thing the shape is saying.
fn field_edge(theme: &Theme, width: usize, top: bool) -> Line<'static> {
    const INDENT: &str = "  ";
    let rule = width.saturating_sub(text::columns(INDENT) + 2);
    let (left, right) = match (theme.glyphs(), top) {
        (GlyphSet::Unicode, true) => ('╭', '╮'),
        (GlyphSet::Unicode, false) => ('╰', '╯'),
        (GlyphSet::Ascii, _) => ('+', '+'),
    };
    Line::from(vec![
        Span::styled(INDENT.to_string(), theme.card()),
        Span::styled(
            format!(
                "{left}{}{right}",
                theme.glyphs().rule().to_string().repeat(rule)
            ),
            field_line(theme),
        ),
    ])
}

/// The ink of a field box's own lines: the strong border, the colour the
/// dialog's frame is drawn in, so the two read as the same furniture.
fn field_line(theme: &Theme) -> Style {
    Style::default().fg(theme.line_strong)
}

/// A field's own spans: what has been typed, with a chip under the caret.
fn field_spans(field: &Field, theme: &Theme) -> Vec<Span<'static>> {
    let (before, under, after) = field.split();
    vec![
        Span::styled(before.to_string(), theme.text()),
        Span::styled(under.to_string(), theme.selected()),
        Span::styled(after.to_string(), theme.text()),
    ]
}

/// The cheat sheet's body: a heading per group, the commands under it, and a
/// chip under the cursor.
///
/// The two columns are the old sheet's: the command column is as wide as the
/// widest command but never eats the room the descriptions need, so the second
/// column starts in the same place in every group. The trailing blank after a
/// group is a row like any other — the scroll arithmetic counts it.
fn cheat_body(cheat: &Cheat, lang: Lang, theme: &Theme, width: usize) -> Vec<Line<'static>> {
    let command_col = cheat_command_col(width);
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut index = 0;
    for (group, items) in CHEAT_GROUPS {
        out.push(Line::from(Span::styled(
            entry(*group, lang),
            theme.accent_strong().add_modifier(Modifier::BOLD),
        )));
        for (command, meaning) in items.iter() {
            let here = index == cheat.selected;
            index += 1;
            // The cursor is one chip, the way the palette's rows are: the
            // marker, the command and the meaning all take the selection's
            // ink, so the row reads as one chosen thing.
            let (marker, ink, hint) = if here {
                (theme.selected(), theme.selected(), theme.selected())
            } else {
                (theme.accent(), theme.text(), theme.muted())
            };
            // The key names are the keyboard's own — `↑↓`, `PgUp` — so they are
            // folded with the rest of the interface: a font with no arrows gets
            // the `v` form the sidebar's hints already use.
            let command = theme.fold(command);
            let meaning = theme.fold(entry(*meaning, lang));
            out.push(Line::from(vec![
                Span::styled(
                    if here {
                        theme.glyphs().cursor()
                    } else {
                        theme.glyphs().cursor_blank()
                    },
                    marker,
                ),
                Span::styled(text::pad_to(command.as_ref(), command_col), ink),
                Span::styled(format!("  {}", meaning), hint),
            ]));
        }
        out.push(Line::default());
    }
    out
}

/// One device's rows at `width`: the table row whole when it fits, and the
/// same pieces laid out when the box is too narrow for it.
///
/// The row is the list's one table — board, signal, name, address — and at the
/// widths a terminal window actually has it fits whole, name in its own column
/// and the address in the one beside it. When the window is too narrow for
/// that, the row *breaks* rather than being cut with an ellipsis: the address
/// is the half a user checks against a board and the name the half they pick
/// by, so neither may be the part that disappears. Only the padding goes
/// first — air for the eye, not a thing said — and then the address drops to a
/// row of its own, under the name column: a MAC split across two lines is
/// neither readable nor copyable, which is what a plain wrap of the whole row
/// produces.
fn device_rows(device: &crate::cli::FoundDevice, width: usize, glyphs: GlyphSet) -> Vec<String> {
    let name = device.name.as_deref().unwrap_or("(no name)");
    let board = if device.board { "bee" } else { "-" };
    // The signal the scan heard it at, ranked by dots and named by the
    // number: a full column even when the adapter had no reading for a device
    // it heard, so the names stay in one line down the box.
    let signal = match device.rssi {
        Some(dbm) => format!(
            "{} {:>4}dBm",
            text::signal_bars_with(i32::from(dbm), glyphs.dots()),
            dbm
        ),
        None => format!("{:>12}", glyphs.dash()),
    };
    // Padded by columns, not by characters: a name in a wide script is wider
    // than it is long, and the id column is what would move.
    let laid_out = format!(
        "{board:>3} {signal} {} {}",
        text::pad_to(name, 24),
        device.address
    );
    if text::columns(&laid_out) <= width {
        return vec![laid_out];
    }
    // Without the padding when only the padding is what does not fit: the
    // addresses go ragged rather than the row going onto two lines for air.
    let compact = format!("{board:>3} {signal} {name} {}", device.address);
    if text::columns(&compact) <= width {
        return vec![compact];
    }
    // Narrower still, and the row comes apart at its seams: the head wraps
    // where it must, and the address keeps to a row of its own.
    let head = format!("{board:>3} {signal} {name}");
    let mut rows = wrap_rows(&head, width);
    let name_column = text::columns(&format!("{board:>3} {signal} "));
    let indent = if name_column + text::columns(&device.address) <= width {
        name_column
    } else {
        0
    };
    rows.extend(wrap_rows(
        &format!("{}{}", " ".repeat(indent), device.address),
        width,
    ));
    rows
}

/// Every row of the dialog's body, before the window is taken.
///
/// `width` matters to the confirmation, whose prompt wraps, and to the help,
/// whose meanings and note wrap to the box; the remaining bodies are one row
/// per item at any width, which is what lets the scroll keys work without
/// knowing the box they are scrolling in.
fn body(dialog: &Dialog, app: &App, width: usize, theme: &Theme) -> Vec<Line<'static>> {
    let lang = app.lang;
    match dialog {
        Dialog::Help(_) => {
            // Two columns, and both of them wrap: a meaning under the key
            // column it belongs to, and the note at the box's own edge. A
            // meaning longer than the box used to be cut at the border with
            // no sign that anything was missing; the note — the paragraph
            // that says where every other key goes — was cut on every frame
            // it was painted in. The key column is padded, the continuation
            // rows are indented to it, and nothing is dropped.
            let room = width.saturating_sub(HELP_KEY_WIDTH).max(1);
            let mut out: Vec<Line<'static>> = Vec::new();
            for (key, meaning) in HELP_ROWS {
                // The key names are the keyboard's own: `↑↓` folds to `^v`
                // for a terminal whose font has no arrows, like the hints
                // under every view. Folded before it is padded, so the
                // meaning column does not move with the glyph set.
                let key = theme.fold(key);
                let meaning = theme.fold(entry(*meaning, lang));
                for (row, line) in text::wrap_words(meaning.as_ref(), room)
                    .into_iter()
                    .enumerate()
                {
                    let head = if row == 0 {
                        Span::styled(text::pad_to(key.as_ref(), HELP_KEY_WIDTH), theme.focus())
                    } else {
                        Span::raw(" ".repeat(HELP_KEY_WIDTH))
                    };
                    out.push(Line::from(vec![head, Span::styled(line, theme.text())]));
                }
            }
            out.push(Line::default());
            out.extend(
                text::wrap_words(theme.fold(entry(HELP_NOTE, lang)).as_ref(), width.max(1))
                    .into_iter()
                    .map(|row| Line::from(Span::styled(row, theme.muted()))),
            );
            // A blank row keeps the note from reading as one paragraph with
            // the legend the painter puts under it.
            out.push(Line::default());
            out
        }
        Dialog::DevicePick(pick) => {
            if pick.scanning {
                return vec![Line::from(Span::styled(
                    theme.fold(entry(PICK_SCANNING, lang)),
                    theme.muted(),
                ))];
            }
            if pick.devices.is_empty() {
                // What the scan said, when it said anything: "no adapter" and
                // "nothing answered" are different news, and painting the
                // generic line over the first is how a user comes to chase a
                // board that was never being listened for. The generic line is
                // the interface's, so it folds; the scan's own words do not.
                let why = if pick.message.is_empty() {
                    theme.fold(entry(PICK_EMPTY, lang)).into_owned()
                } else {
                    pick.message.clone()
                };
                return vec![Line::from(Span::styled(why, theme.muted()))];
            }
            // One row per device — the box is a fixed height for a known list,
            // and the cursor stays on a row rather than somewhere inside a
            // paragraph — and a row the window cannot hold whole wraps onto
            // the rows below it rather than being cut with an ellipsis.
            pick.devices
                .iter()
                .enumerate()
                .flat_map(|(index, device)| {
                    let style = if index == pick.cursor {
                        theme.selected()
                    } else {
                        theme.text()
                    };
                    device_rows(device, width, theme.glyphs())
                        .into_iter()
                        .map(move |row| Line::from(Span::styled(row, style)))
                })
                .collect()
        }
        Dialog::ThemePick(pick) => crate::theme::THEMES
            .iter()
            .enumerate()
            .map(|(index, choice)| {
                // One row per theme, cursor included: the window is the list,
                // and moving on it repaints the frame in the theme under the
                // cursor — which is why the row's own style is as ordinary as
                // the others'.
                let style = if index == pick.cursor {
                    theme.selected()
                } else {
                    theme.text()
                };
                Line::from(Span::styled(app.theme_name(*choice), style))
            })
            .collect(),
        Dialog::ChatPick(pick) => app
            .assistant
            .chats
            .iter()
            .enumerate()
            .map(|(index, chat)| {
                // One row per conversation, the cursor chip on the row a
                // delete lands on. The panel's own thread is marked, because
                // that is the one the user may be reading — a list that could
                // not tell them apart would make every delete a gamble.
                let style = if index == pick.cursor {
                    theme.selected()
                } else {
                    theme.text()
                };
                let name = if chat.title.trim().is_empty() {
                    entry(CHAT_UNTITLED, lang).to_string()
                } else {
                    chat.title.trim().to_string()
                };
                let mark = if index == app.assistant.active {
                    // The ` · ` in the mark is the interface's, so it folds
                    // like every other separator in the frame.
                    theme.fold(entry(CHAT_SHOWN, lang)).into_owned()
                } else {
                    String::new()
                };
                Line::from(Span::styled(
                    text::clip_to(&format!("{}. {name}{mark}", index + 1), width),
                    style,
                ))
            })
            .collect(),
        Dialog::Cheat(cheat) => cheat_body(cheat, lang, theme, width),
        Dialog::Notices(_) => {
            if app.log.is_empty() {
                return vec![Line::from(Span::styled(
                    theme.fold(entry(NOTICES_EMPTY, lang)),
                    theme.muted(),
                ))];
            }
            // The log is shown newest last, the way it was announced — a log
            // that ran backwards would make "scroll down" mean "go back in
            // time". A long line is cut rather than wrapped, so one notice is
            // always one row and the scroll arithmetic stays exact.
            app.log
                .iter()
                .map(|notice| {
                    let (glyph, word) = level_badge(notice.level, theme.glyphs());
                    let head = format!("{glyph} {} ", entry(word, lang));
                    // Folded before it is measured: the notice is painted
                    // chrome, and the folded form is what the row actually
                    // holds.
                    let body = theme.fold(&notice.text);
                    Line::from(vec![
                        Span::styled(head.clone(), theme.level_style(notice.level)),
                        Span::styled(
                            text::clip_to(
                                body.as_ref(),
                                width.saturating_sub(text::columns(&head)),
                            ),
                            theme.text(),
                        ),
                    ])
                })
                .collect()
        }
        Dialog::Confirm(confirm) => {
            let mut out: Vec<Line<'static>> = wrap_rows(&confirm.prompt, width.max(1))
                .into_iter()
                .map(|row| Line::from(Span::styled(row, theme.text())))
                .collect();
            out.push(Line::default());
            out.extend(
                wrap_rows(&confirm.detail, width.max(1))
                    .into_iter()
                    .map(|row| Line::from(Span::styled(row, theme.muted()))),
            );
            out.push(Line::default());
            // The highlighted button takes the selection chip; the other one
            // keeps the accent ink, so the pair still reads as two buttons.
            let (yes_style, no_style) = if confirm.yes {
                (theme.selected(), theme.focus())
            } else {
                (theme.focus(), theme.selected())
            };
            out.push(Line::from(vec![
                Span::styled(entry(BUTTON_YES, lang), yes_style),
                Span::styled("    ", theme.text()),
                Span::styled(entry(BUTTON_NO, lang), no_style),
            ]));
            out
        }
        Dialog::Prompt(prompt) => {
            let mut out = vec![
                Line::from(Span::styled(entry(prompt.label, lang), theme.muted())),
                Line::default(),
            ];
            out.extend(prompt_field(prompt, lang, theme, width));
            out
        }
        // The bridge's window: the syntax named under the title, the spec in
        // a field, and the bridge's own words under it — its answer, or its
        // refusal — wrapped, because an `ERR` line is a sentence.
        Dialog::Uart(uart) => {
            let mut out = vec![
                Line::from(Span::styled(entry(UART_PROMPT, lang), theme.muted())),
                Line::default(),
            ];
            out.extend(field_box(field_spans(&uart.field, theme), theme, width));
            out.push(Line::default());
            match (&uart.error, &uart.status) {
                (Some(error), _) => out.extend(
                    wrap_rows(error, width.max(1))
                        .into_iter()
                        .map(|row| Line::from(Span::styled(row, theme.danger()))),
                ),
                (None, Some(status)) => out.extend(
                    wrap_rows(status, width.max(1))
                        .into_iter()
                        .map(|row| Line::from(Span::styled(row, theme.accent_strong()))),
                ),
                (None, None) => {}
            }
            out
        }
        // The assistant's form, painted by the module that owns it: the caret,
        // the hidden key and the note cursor all live in `assistant` state, and
        // a second painter would be a second opinion about what a field holds.
        Dialog::Settings(_) => crate::views::assistant::settings_lines(app, theme, width as u16),
        // The card about the program. Every fact on it comes either from the
        // crate's own manifest or from the capability this frame is painted
        // with, so none of them can drift from what is actually running.
        Dialog::About => {
            let mut out: Vec<Line<'static>> = Vec::new();
            let room = crate::ui::overlay::dialog_body_room(
                app.screen,
                app.sidebar_visible,
                app.panel_wanted(),
                10_000,
            );
            // The mark is transparent on the card as it is on the splash:
            // the dialog's own ground shows through its empty cells.
            let mark = crate::logo::fitted_lines_on(
                app.capability,
                (width as u16, (room as u16).saturating_sub(ABOUT_FACTS)),
                theme.card().bg.unwrap_or(Color::Reset),
            );
            if !mark.is_empty() {
                out.extend(mark.into_iter().map(|mut line| {
                    line.alignment = Some(Alignment::Center);
                    line
                }));
                out.push(Line::default());
            }
            out.push(
                Line::from(Span::styled(
                    "bee".to_string(),
                    theme.accent_strong().add_modifier(Modifier::BOLD),
                ))
                .alignment(Alignment::Center),
            );
            out.push(Line::default());
            let sep = app.strings().label_separator;
            let fact = |label: Entry, value: String| {
                Line::from(vec![
                    Span::styled(
                        text::pad_to(&format!("{}{sep}", entry(label, lang)), ABOUT_LABEL),
                        theme.muted(),
                    ),
                    Span::styled(value, theme.text()),
                ])
            };
            let facts = vec![
                fact(ABOUT_VERSION, env!("CARGO_PKG_VERSION").to_string()),
                fact(ABOUT_LICENSE, env!("CARGO_PKG_LICENSE").to_string()),
                fact(
                    ABOUT_CONTRIBUTOR,
                    "https://github.com/Novice-PG".to_string(),
                ),
                fact(ABOUT_PROJECT, env!("CARGO_PKG_REPOSITORY").to_string()),
                fact(
                    ABOUT_RENDER,
                    format!(
                        "{}{}{}",
                        app.capability.color.name(),
                        theme.glyphs().dot_sep(),
                        app.capability.glyphs.name()
                    ),
                ),
                fact(
                    ABOUT_COMPONENTS,
                    fill(
                        entry(ABOUT_COMPONENTS_VALUE, lang),
                        &[
                            crate::licenses::COMPONENTS.len().to_string(),
                            crate::licenses::TOTAL.to_string(),
                        ],
                    ),
                ),
            ];
            // The facts are one block, not five centred lines: their labels
            // are a column, and a column only stays a column if the block
            // moves as a whole. Centre the block, leave its insides alone.
            let block = facts.iter().map(Line::width).max().unwrap_or(0);
            let pad = width.saturating_sub(block) / 2;
            out.extend(facts.into_iter().map(|line| {
                if pad == 0 {
                    return line;
                }
                let mut spans = Vec::with_capacity(line.spans.len() + 1);
                spans.push(Span::raw(" ".repeat(pad)));
                spans.extend(line.spans);
                Line::from(spans)
            }));
            out
        }
        // The component page: the direct dependencies, the count of the
        // transitive tail, and the people who built the program. It is a
        // document rather than a form, so it scrolls; the full tail is kept in
        // `THIRD_PARTY_LICENSES.md` and printed by `bee --licenses`, because
        // a terminal modal should not pretend three hundred rows are a page a
        // person can read at a glance.
        Dialog::Licenses(_) => {
            let mut out: Vec<Line<'static>> = vec![
                Line::from(Span::styled(
                    "Linkr Bee Terminal".to_string(),
                    theme.accent_strong().add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    format!(
                        "{} · {}",
                        env!("CARGO_PKG_VERSION"),
                        crate::licenses::PROJECT_LICENSE
                    ),
                    theme.muted(),
                )),
                Line::from(Span::styled(
                    env!("CARGO_PKG_REPOSITORY").to_string(),
                    theme.muted(),
                )),
                Line::default(),
                Line::from(Span::styled(
                    fill(
                        entry(LICENSES_DIRECT, lang),
                        &[crate::licenses::COMPONENTS.len().to_string()],
                    ),
                    theme.focus(),
                )),
            ];
            for component in crate::licenses::COMPONENTS {
                out.extend(
                    wrap_rows(
                        &format!(
                            "{} {}  {}",
                            component.name, component.version, component.license
                        ),
                        width.max(1),
                    )
                    .into_iter()
                    .map(|row| Line::from(Span::styled(row, theme.text()))),
                );
            }
            out.push(Line::default());
            out.extend(
                text::wrap_words(
                    &fill(
                        entry(LICENSES_TRANSITIVE, lang),
                        &[crate::licenses::transitive_count().to_string()],
                    ),
                    width.max(1),
                )
                .into_iter()
                .map(|row| Line::from(Span::styled(row, theme.muted()))),
            );
            out.push(Line::default());
            out.push(Line::from(Span::styled(
                entry(LICENSES_CONTRIBUTORS, lang),
                theme.focus(),
            )));
            out.extend(
                wrap_rows(&crate::licenses::CONTRIBUTORS.join(" · "), width.max(1))
                    .into_iter()
                    .map(|row| Line::from(Span::styled(row, theme.text()))),
            );
            out.push(Line::default());
            out.push(Line::from(Span::styled(
                format!(
                    "{}: {}",
                    entry(LICENSES_LICENSE, lang),
                    crate::licenses::PROJECT_LICENSE
                ),
                theme.muted(),
            )));
            out.extend(
                text::wrap_words(entry(LICENSES_NOTE, lang), width.max(1))
                    .into_iter()
                    .map(|row| Line::from(Span::styled(row, theme.muted()))),
            );
            out
        }
    }
}

/// How many rows the body has. Derived from the body itself, so a row added to
/// the help list cannot leave the scroll keys behind.
fn row_count(app: &App, dialog: &Dialog) -> usize {
    // The help wraps its meanings and its note to the box it is painted in,
    // so how many rows it holds depends on the width. Ask the painter's own
    // helper, the way the device picker does, or End would stop short of the
    // tail the window cannot show. Before a paint has measured a screen
    // (a headless test), a width no line reaches keeps one row per item.
    let width = if matches!(dialog, Dialog::Help(_) | Dialog::Licenses(_)) {
        let width = crate::ui::overlay::dialog_body_width(
            app.screen,
            app.sidebar_visible,
            app.panel_wanted(),
        ) as usize;
        if width == 0 {
            10_000
        } else {
            width
        }
    } else {
        // The confirmation is never scrolled, and the log and the forms clip
        // one row per item; their wrapping is not this count's business.
        10_000
    };
    body(dialog, app, width, &app.theme()).len()
}

/// How many rows the body needs at `width`.
///
/// The painter asks this before it sizes the box, so a confirmation is as tall
/// as its prompt rather than as tall as the screen — a dialog that filled the
/// frame with blank ground would read as an empty box with a sentence in it.
pub fn body_height(app: &App, dialog: &Dialog, width: u16) -> usize {
    body(dialog, app, width as usize, &app.theme()).len()
}

/// The visible window of the dialog's body, padded to `height`.
pub fn lines(dialog: &Dialog, app: &App, width: u16, height: usize) -> Vec<Line<'static>> {
    if height == 0 {
        return Vec::new();
    }
    let theme = app.theme();
    let all = body(dialog, app, width as usize, &theme);
    // The offset can run past the end — the key handler clamps it to the body
    // rather than to a window it cannot see — so the *window* is what is
    // clamped here, and a scroll left over from a taller terminal still shows
    // the tail rather than blank space.
    let start = dialog.scroll().min(all.len().saturating_sub(height));
    let mut window: Vec<Line<'static>> = all.into_iter().skip(start).take(height).collect();
    while window.len() < height {
        window.push(Line::default());
    }
    window
}

// --- keys --------------------------------------------------------------------

/// The movement and editing keys a field answers to, if this is one of them.
///
/// A bool rather than a match over everything: the window around the field
/// keeps the keys that are its own — the prompt's Enter, the UART window's
/// Escape — and a key with no meaning here leaves the field exactly as it was.
fn field_key(field: &mut Field, key: KeyEvent) -> bool {
    match key.code {
        KeyCode::Backspace => field.backspace(),
        KeyCode::Delete => field.delete(),
        KeyCode::Left => field.left(),
        KeyCode::Right => field.right(),
        KeyCode::Home => field.home(),
        KeyCode::End => field.end(),
        // Tab is a *character* here, not a focus key: a path may want one,
        // where the dialog has nothing else for it to mean.
        KeyCode::Char(c) => field.insert(c),
        KeyCode::Tab => field.insert('\t'),
        _ => return false,
    }
    true
}

/// Handle a key while a dialog is open. Returns true when the key was consumed.
///
/// A control chord is deliberately *not* consumed: `Ctrl+Q` must still quit and
/// `Ctrl+T` still repaint with a modal in the way, so those fall through to the
/// global handler rather than being swallowed here.
pub fn handle_key(app: &mut App, key: KeyEvent) -> bool {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        // Ctrl+R flips a secret field between stars and text, and is answered
        // before the chord bail-out below because it belongs to the field.
        // Every other chord stays global: `Ctrl+Q` must still quit and
        // `Ctrl+T` still repaint with a modal in the way.
        if key.code == KeyCode::Char('r') {
            if let Some(Dialog::Prompt(prompt)) = &mut app.dialog {
                if prompt.action.asks_for_a_secret() {
                    prompt.masked = !prompt.masked;
                    return true;
                }
            }
        }
        return false;
    }
    let Some(dialog) = app.dialog.take() else {
        return false;
    };
    match dialog {
        Dialog::DevicePick(mut pick) => match key.code {
            // Escape closes without dialling. A user who opened a scan by
            // mistake wants out, not to answer a question nobody asked.
            KeyCode::Esc => app.cancel_ble_scan(),
            // Up and down walk the list, and the window follows the cursor so
            // a board past the bottom of the box is one the keyboard can
            // reach. Every moving key hands the picker back to the dialog:
            // what was taken must be put back, or a press of ↓ closes the
            // window the user was reading.
            KeyCode::Up | KeyCode::Down => {
                pick.move_cursor(key.code == KeyCode::Down);
                // The window's own arithmetic, asked the way the painter
                // asks it: a device whose row wraps is more than one row of
                // the box, so the scroll counts the rows the paint will draw
                // — through the painter's helpers, so the two cannot
                // disagree about how tall the box is.
                let width = crate::ui::overlay::dialog_body_width(
                    app.screen,
                    app.sidebar_visible,
                    app.panel_wanted(),
                ) as usize;
                let spans = pick.line_spans(width.max(1), app.glyph());
                let rows = spans.iter().sum::<usize>().max(1);
                let room = crate::ui::overlay::dialog_body_room(
                    app.screen,
                    app.sidebar_visible,
                    app.panel_wanted(),
                    rows,
                );
                pick.follow(room, &spans);
                app.dialog = Some(Dialog::DevicePick(pick));
            }
            // Enter dials the row under the cursor — by address, which is the
            // only part of a scan result that identifies a device exactly,
            // since a name is a substring and two boards can carry it. With
            // nothing heard it scans again, which is what a bench with the
            // board switched on mid-dialog needs.
            KeyCode::Enter => match pick.selected() {
                // The pick dials the board, and says so: a link the user
                // asked for by name is news; whether it caught is the log's.
                Some(device) => {
                    app.connect_to_board(
                        &device.address,
                        device.name.as_deref(),
                        device.rssi,
                        false,
                    );
                }
                None if !pick.scanning => {
                    let _ = app.start_ble_scan();
                }
                None => {}
            },
            _ => app.dialog = Some(Dialog::DevicePick(pick)),
        },
        Dialog::Confirm(mut confirm) => match key.code {
            // Cancel, by the key, by the button, or by Escape.
            KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => {}
            KeyCode::Char('y') | KeyCode::Char('Y') => run(app, confirm.action),
            KeyCode::Enter => {
                if confirm.yes {
                    run(app, confirm.action);
                }
            }
            KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab => {
                confirm.yes = !confirm.yes;
                app.dialog = Some(Dialog::Confirm(confirm));
            }
            _ => app.dialog = Some(Dialog::Confirm(confirm)),
        },
        Dialog::Prompt(mut prompt) => {
            if key.code == KeyCode::Esc {
                // Escape gives the keyboard back without starting anything.
            } else if key.code == KeyCode::Enter {
                start(app, prompt);
            } else {
                // Anything else leaves the field exactly as it was. The dialog
                // stays up, so a key with no meaning here is not a key that
                // cancels.
                let was = prompt.field.text.chars().count();
                field_key(&mut prompt.field, key);
                let now = prompt.field.text.chars().count();
                // A character that just landed stays in the clear for its
                // moment; one that was taken away puts the reveal out, because
                // the index it holds is a place in the text and the edit moved
                // the characters left into it. A key that only moved the caret
                // changes nothing. See [`PROMPT_REVEAL`].
                if now > was {
                    prompt.show_last_char();
                } else if now < was {
                    prompt.hide_the_char();
                }
                app.dialog = Some(Dialog::Prompt(prompt));
            }
        }
        Dialog::Uart(uart) => uart_key(app, uart, key),
        // The card about the program answers no question, so every key puts it
        // away — except `L`, which opens the component page. The dialog was
        // taken out of the app above; putting a new one back is the one
        // exception, and doing nothing is exactly "close".
        Dialog::About => {
            if matches!(key.code, KeyCode::Char('l') | KeyCode::Char('L'))
                && !key.modifiers.contains(KeyModifiers::ALT)
            {
                app.dialog = Some(Dialog::Licenses(0));
            }
        }
        Dialog::Licenses(offset) => {
            app.dialog = scrolled(app, Dialog::Licenses(offset), offset, key)
        }
        Dialog::Help(offset) => app.dialog = scrolled(app, Dialog::Help(offset), offset, key),
        Dialog::Notices(offset) => app.dialog = scrolled(app, Dialog::Notices(offset), offset, key),
        Dialog::Cheat(cheat) => cheat_key(app, cheat, key),
        // The assistant's window: Escape shuts it and hands the caret back to
        // the composer, the paging keys scroll the body, and every other key
        // belongs to the form — which re-puts the dialog here whatever it did
        // with the caret, because "not the form's key" and "close the window"
        // are two different answers and only Escape means the second. The
        // paging keys move the *window*, and a form key moves the caret, so
        // that key's window has to follow — a caret left on a row nothing
        // paints is a keystroke that lands where the user cannot see it.
        Dialog::ThemePick(mut pick) => match key.code {
            // Escape puts back the theme the window opened on: a preview is
            // not a choice until Enter makes it one.
            KeyCode::Esc => app.theme = pick.original,
            // Moving the cursor *is* the preview — the frame repaints in the
            // theme under it, so the six are compared on the screen rather
            // than from memory.
            KeyCode::Up => {
                pick.cursor = pick.cursor.saturating_sub(1);
                app.theme = crate::theme::THEMES[pick.cursor];
                app.dialog = Some(Dialog::ThemePick(pick));
            }
            KeyCode::Down => {
                let last = crate::theme::THEMES.len() - 1;
                pick.cursor = (pick.cursor + 1).min(last);
                app.theme = crate::theme::THEMES[pick.cursor];
                app.dialog = Some(Dialog::ThemePick(pick));
            }
            KeyCode::Enter => {
                let notice = app.keep_theme(crate::theme::THEMES[pick.cursor]);
                app.push_notice(notice);
            }
            _ => app.dialog = Some(Dialog::ThemePick(pick)),
        },
        // The list of conversations, with a delete on Enter. The cursor moves
        // by the arrows; every other key leaves the window up, because "not
        // this window's key" and "close the window" are different answers and
        // only Escape means the second.
        Dialog::ChatPick(mut pick) => match key.code {
            KeyCode::Esc => {}
            KeyCode::Up | KeyCode::Down => {
                let last = app.assistant.chats.len().saturating_sub(1);
                pick.move_cursor(key.code == KeyCode::Down, last);
                app.dialog = Some(Dialog::ChatPick(pick));
            }
            // Enter forgets the row under the cursor. The window closes on
            // the way out: the notice says what happened, and a list still up
            // would be a list one row stale.
            KeyCode::Enter => {
                crate::views::assistant::delete_conversation_at(app, pick.cursor);
            }
            _ => app.dialog = Some(Dialog::ChatPick(pick)),
        },
        Dialog::Settings(offset) => {
            if key.code == KeyCode::Esc {
                crate::views::assistant::close_settings(app);
            } else {
                let last = row_count(app, &Dialog::Settings(offset)).saturating_sub(1);
                let moved = match key.code {
                    KeyCode::PageUp => offset.saturating_sub(10),
                    KeyCode::PageDown => offset.saturating_add(10),
                    KeyCode::Home => 0,
                    KeyCode::End => last,
                    _ => {
                        let code = key.code;
                        let _ = crate::views::assistant::handle_settings_key(app, key);
                        followed(app, code, offset, last + 1)
                    }
                };
                app.dialog = Some(Dialog::Settings(moved.min(last)));
            }
        }
    }
    true
}

/// Do what the prompt's answer asked for.
///
/// An empty answer is a refusal, not a guess: a receive falls back to the
/// directory the user is standing in, because that is a place and not a name,
/// but a send has nothing to offer and says so rather than opening a file called
/// "".
fn start(app: &mut App, prompt: Prompt) {
    let answer = prompt.field.answer().to_string();
    match prompt.action {
        // A network name with no network to name is a refusal rather than a
        // guess: joining "" would send `@w=,` and the firmware would read it as
        // an empty SSID, which is a different failure and a much more confusing
        // one.
        PromptAction::WifiSsid => {
            if answer.trim().is_empty() {
                let text = app.strings().net_no_ssid.to_string();
                app.push_notice(crate::app::Notice {
                    text,
                    level: NoticeLevel::Warn,
                });
                return;
            }
            app.network.ssid_input = answer.trim().to_string();
            let prompt = Prompt::new(WIFI_PASSWORD_TITLE, PromptAction::WifiPassword);
            app.dialog = Some(Dialog::Prompt(prompt));
        }
        // The password is never stored: it goes from the field into the command
        // and out of the process, and the approval card that follows shows the
        // network's name and not its key.
        PromptAction::WifiPassword => {
            let command =
                match crate::accessory::wifi_command("connect", &app.network.ssid_input, &answer) {
                    Ok(command) => command,
                    Err(why) => {
                        app.push_notice(crate::app::Notice {
                            text: why,
                            level: NoticeLevel::Error,
                        });
                        return;
                    }
                };
            ask(app, ConfirmAction::Accessory(command));
        }
        // Validate the firmware's anonymous HTTP destination before approval.
        PromptAction::WebdavUrl => {
            if answer.trim().is_empty() {
                let text = app.strings().net_no_url.to_string();
                app.push_notice(crate::app::Notice {
                    text,
                    level: NoticeLevel::Warn,
                });
                return;
            }
            let command = match crate::accessory::webdav_command("on", answer.trim()) {
                Ok(command) => command,
                Err(why) => {
                    app.push_notice(crate::app::Notice {
                        text: why,
                        level: NoticeLevel::Error,
                    });
                    return;
                }
            };
            ask(app, ConfirmAction::Accessory(command));
        }
        // The advertised name is checked here in the firmware's own units — a
        // name that is 30 bytes is refused before a round trip — and the
        // change still goes through the approval card because it is persisted
        // and survives a reboot.
        PromptAction::BleName => {
            let command = match crate::accessory::ble_name_command(&answer) {
                Ok(command) => command,
                Err(_) => {
                    let text = app.strings().net_ble_name_invalid.to_string();
                    app.push_notice(crate::app::Notice {
                        text,
                        level: NoticeLevel::Error,
                    });
                    return;
                }
            };
            ask(app, ConfirmAction::Accessory(command));
        }
        // The address is a value the user came to set, so an empty answer is
        // an answer: erase the field and the board's own WiFi address is what
        // a dial falls back to.
        PromptAction::LanHost => app.set_lan_host(answer.to_string()),
        // The token goes into the sidebar row and nowhere else — no notice,
        // no log, no report ever names it.
        PromptAction::LanToken => app.lan_token = answer.to_string(),
    }
}

/// The dialog after a scroll key, or `None` when the key closes it.
fn scrolled(app: &App, dialog: Dialog, offset: usize, key: KeyEvent) -> Option<Dialog> {
    let rows = row_count(app, &dialog);
    let room = crate::ui::overlay::dialog_body_room(
        app.screen,
        app.sidebar_visible,
        app.panel_wanted(),
        rows,
    );
    // Stop at the last *visible* start, not the last row: `lines` clamps the
    // start to `rows - room` too. Otherwise End parks the offset below the
    // last window and the first Up presses move an offset nobody can see.
    let last = if room == 0 {
        rows.saturating_sub(1)
    } else {
        rows.saturating_sub(room)
    };
    let moved = match key.code {
        KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('?') | KeyCode::Enter => return None,
        KeyCode::Up => offset.saturating_sub(1),
        KeyCode::Down => offset.saturating_add(1),
        KeyCode::PageUp => offset.saturating_sub(10),
        KeyCode::PageDown => offset.saturating_add(10),
        KeyCode::Home => 0,
        KeyCode::End => last,
        _ => offset,
    };
    let moved = moved.min(last);
    Some(match dialog {
        Dialog::Notices(_) => Dialog::Notices(moved),
        Dialog::Licenses(_) => Dialog::Licenses(moved),
        _ => Dialog::Help(moved),
    })
}

/// The scroll a form key leaves behind: the least the window can move and
/// still paint the caret.
///
/// The caret is not a scroll position. Tab and the typing keys walk the five
/// fields, ↑↓ on the note row walks the list cursor, and either walk can leave
/// the row the next keystroke acts on outside the window's slice of the body.
/// When that happens the window moves to the caret; when it does not, the
/// scroll is left where it was. The paging keys are the user moving the window
/// themselves, so they never come through here.
fn followed(app: &App, key: KeyCode, offset: usize, rows: usize) -> usize {
    let room = crate::ui::overlay::dialog_body_room(
        app.screen,
        app.sidebar_visible,
        app.panel_wanted(),
        rows,
    );
    if room == 0 {
        // No paint has said how tall the window is (a headless test, the first
        // tick), or the frame is too small for a modal at all: the scroll
        // keeps whatever the key left it.
        return offset;
    }
    let caret = if matches!(key, KeyCode::Up | KeyCode::Down | KeyCode::Delete)
        && app.assistant.focus == crate::views::assistant::AgentField::Notes
        && !app.assistant.notes.is_empty()
    {
        // The list keys walk the notes: the cursor's own row is what must stay
        // seen. The field row far above is where a typed character would land,
        // and it is not the row this key just moved.
        crate::views::assistant::settings_note_row(app)
    } else {
        crate::views::assistant::settings_caret_row(app)
    };
    if caret < offset {
        caret
    } else if caret >= offset + room {
        caret + 1 - room
    } else {
        offset
    }
}

/// Body line the `selected` command is painted on.
///
/// The key handler moves the scroll from this number, so it has to be the same
/// arithmetic [`cheat_body`] lays out — a heading, the commands, a blank —
/// or the cursor walks off the window one line at a time.
fn cheat_line_of(selected: usize) -> usize {
    let mut line = 0;
    let mut index = 0;
    for (_, items) in CHEAT_GROUPS {
        if selected < index + items.len() {
            return line + 1 + (selected - index);
        }
        index += items.len();
        line += 1 + items.len() + 1;
    }
    line
}

/// The scroll the cursor leaves behind: the least the window moves and still
/// paints the chip — the settings window's arithmetic, with the cursor's line
/// in place of its field.
fn cheat_scrolled(app: &App, selected: usize, scroll: usize) -> usize {
    let rows: usize = CHEAT_GROUPS.iter().map(|(_, items)| items.len() + 2).sum();
    let room = crate::ui::overlay::dialog_body_room(
        app.screen,
        app.sidebar_visible,
        app.panel_wanted(),
        rows,
    );
    if room == 0 {
        // No paint has said how tall the window is (a headless test, the first
        // tick), or the frame is too small for a modal at all: the scroll
        // keeps whatever the key left it.
        return scroll;
    }
    let line = cheat_line_of(selected);
    if line < scroll {
        line
    } else if line >= scroll + room {
        line + 1 - room
    } else {
        scroll
    }
}

/// The cheat sheet's keys: a cursor over the commands, Enter sends the row it
/// is on, Escape closes.
///
/// Enter keeps the sheet up — several commands out of one window is the point
/// of it — and a send with no link is refused out loud by `send_command`,
/// which is the answer a button press is owed. A key with no meaning here is
/// not a key that cancels.
fn cheat_key(app: &mut App, cheat: Cheat, key: KeyEvent) {
    if key.code == KeyCode::Esc {
        return;
    }
    if key.code == KeyCode::Enter {
        if let Some(command) = cheat_command(cheat.selected) {
            app.send_command(command);
        }
        app.dialog = Some(Dialog::Cheat(cheat));
        return;
    }
    let last = cheat_count().saturating_sub(1);
    let selected = match key.code {
        KeyCode::Up => cheat.selected.saturating_sub(1),
        KeyCode::Down => (cheat.selected + 1).min(last),
        KeyCode::PageUp => cheat.selected.saturating_sub(10),
        KeyCode::PageDown => (cheat.selected + 10).min(last),
        KeyCode::Home => 0,
        KeyCode::End => last,
        _ => {
            app.dialog = Some(Dialog::Cheat(cheat));
            return;
        }
    };
    let scroll = cheat_scrolled(app, selected, cheat.scroll);
    app.dialog = Some(Dialog::Cheat(Cheat { selected, scroll }));
}

/// The UART window's keys: a spec to edit, Enter to send it, Escape to close.
fn uart_key(app: &mut App, mut uart: Uart, key: KeyEvent) {
    match key.code {
        KeyCode::Esc => return,
        KeyCode::Enter => send_uart_spec(app, &mut uart),
        _ => {
            // A key that is not a spec character leaves the field exactly as
            // it was: "no meaning here" is not "cancel", the same way it is
            // not in every other window.
            field_key(&mut uart.field, key);
        }
    }
    app.dialog = Some(Dialog::Uart(uart));
}

/// Send the typed spec.
///
/// The local parser has the last word on the *shape* and `set_uart` on the
/// link and the ranges, so a spec that cannot work is refused before a round
/// trip rather than after it. The status line then says what is being set,
/// until the bridge answers with what it now is.
fn send_uart_spec(app: &mut App, uart: &mut Uart) {
    uart.status = None;
    match crate::accessory::parse_uart_spec(uart.field.answer()) {
        Err(why) => uart.error = Some(why),
        Ok(settings) => match app.set_uart(&settings) {
            Err(why) => uart.error = Some(why),
            Ok(()) => {
                uart.error = None;
                // The interface's own `setting uart=…` line, folded; the bridge's
                // answer that replaces it is the bridge's and is left as it is.
                let setting = fill(entry(UART_SETTING, app.lang), &[settings.spec()]);
                uart.status = Some(app.theme().fold(&setting).into_owned());
            }
        },
    }
}

/// Show a UART answer on the window that asked for it, when one is up.
///
/// The bridge's own words, shown as they came: the window's job is to say what
/// the bridge is running, and a paraphrase would be a second opinion. A
/// successful answer also sets the field to what the bridge *says* it is —
/// a bridge that could not take the new rate answers with the old one, and the
/// field correcting to it is the whole point of asking.
pub fn uart_answered(app: &mut App, text: &str, ok: bool) {
    let Some(Dialog::Uart(uart)) = &mut app.dialog else {
        return;
    };
    let answer = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if !ok {
        uart.status = None;
        uart.error = Some(answer.to_string());
        return;
    }
    if let Some(settings) = crate::accessory::parse_uart_settings(answer) {
        uart.field = Field::new(&settings.spec());
    }
    uart.error = None;
    uart.status = Some(answer.to_string());
}

/// Do what the confirmation agreed to.
fn run(app: &mut App, action: ConfirmAction) {
    match action {
        ConfirmAction::Send(command) => {
            app.send_command(&command);
        }
        // Says so when it cannot be sent, which `send_command` does not: a
        // keystroke refused in silence is right, but a command the user just
        // approved in a dialog is owed an answer.
        ConfirmAction::Accessory(command) => {
            if let Err(why) = app.run_accessory(&command) {
                app.push_notice(crate::app::Notice {
                    text: why,
                    level: NoticeLevel::Error,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::Notice;
    use crate::event::ConnectionState;
    use crate::theme::Theme;
    use crate::transport::testing::{answer, asked_frames, asked_id, asked_includes, MemoryLink};
    use ratatui::style::Color;

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

    /// Pump until `ready`, or give up after two seconds and say so.
    ///
    /// Pumping is what moves bytes across a test's link, so this is the wait
    /// every test that puts a real command on a real wire needs.
    fn pump_until(app: &mut App, ready: impl Fn(&App) -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline && !ready(app) {
            app.pump();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(ready(app), "the pump did not get there in two seconds");
    }

    /// A connected app on a memory link that says it is Bluetooth: the
    /// management channel — and so any question a dialog asks — exists on no
    /// other kind of link.
    fn connected_over_ble() -> (App, MemoryLink) {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        let wire = MemoryLink::ble();
        app.connect(wire.link()).expect("the memory link opens");
        pump_until(&mut app, |app| app.state == ConnectionState::Connected);
        assert_eq!(app.transport, crate::app::Transport::Ble);
        (app, wire)
    }

    /// The UART window under test, or a panic naming what is there instead.
    fn uart_of(app: &App) -> &Uart {
        match app.dialog.as_ref() {
            Some(Dialog::Uart(uart)) => uart,
            other => panic!("the UART window is up: {other:?}"),
        }
    }

    /// Type `text` over the UART field, one key at a time, the way a user
    /// correcting a spec would: from the start, deleting what is there.
    fn retype(app: &mut App, text: &str) {
        handle_key(app, KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
        for _ in 0..uart_of(app).field.text.len() {
            handle_key(app, KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE));
        }
        for ch in text.chars() {
            handle_key(app, KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE));
        }
    }

    /// Every string this module owns is written in both languages — the table
    /// is the contract, and a missing translation is the bug the flat tables
    /// exist to make impossible.
    #[test]
    fn every_dialog_string_is_bilingual() {
        let mut entries: Vec<Entry> = vec![
            HELP_TITLE,
            NOTICES_TITLE,
            CONFIRM_TITLE,
            SETTINGS_TITLE,
            HELP_KEYS,
            NOTICES_KEYS,
            CONFIRM_KEYS,
            SETTINGS_KEYS,
            NOTICES_EMPTY,
            BUTTON_YES,
            BUTTON_NO,
            CONFIRM_SEND,
            CONFIRM_SEND_DETAIL,
            LEVEL_INFO,
            LEVEL_WARN,
            LEVEL_ERROR,
            HELP_NOTE,
            PROMPT_KEYS,
            CHEAT_TITLE,
            CHEAT_KEYS,
            UART_TITLE,
            UART_PROMPT,
            UART_KEYS,
            UART_QUERYING,
            UART_SETTING,
            ABOUT_TITLE,
            ABOUT_KEYS,
            ABOUT_VERSION,
            ABOUT_LICENSE,
            ABOUT_CONTRIBUTOR,
            ABOUT_PROJECT,
            ABOUT_RENDER,
            ABOUT_COMPONENTS,
            ABOUT_COMPONENTS_VALUE,
            LICENSES_TITLE,
            LICENSES_KEYS,
            LICENSES_DIRECT,
            LICENSES_TRANSITIVE,
            LICENSES_CONTRIBUTORS,
            LICENSES_LICENSE,
            LICENSES_NOTE,
        ];
        entries.extend(CHEAT_GROUPS.iter().map(|(group, _)| *group));
        entries.extend(
            CHEAT_GROUPS
                .iter()
                .flat_map(|(_, items)| items.iter())
                .map(|(_, meaning)| *meaning),
        );
        entries.extend(HELP_ROWS.iter().map(|(_, meaning)| *meaning));
        crate::i18n::assert_bilingual(&entries);
    }

    /// The help lists every chord the interface answers to, and every entry
    /// names a key — a help overlay that forgot `Ctrl+Q` would be worse than
    /// none, because the user would trust it.
    #[test]
    fn the_help_names_the_chords() {
        let app = App::default();
        // The whole body, not the first window of it: the list scrolls in a
        // real frame, and a chord that is one page down is still a chord the
        // help names.
        let height = body_height(&app, &Dialog::Help(0), 60);
        let shown = text_of(&lines(&Dialog::Help(0), &app, 60, height));
        for key in [
            "Ctrl+P",
            "F1",
            "F2–F5",
            "F6",
            "Ctrl+B",
            "Ctrl+←/→",
            "Ctrl+Up",
            "Enter",
            "Ctrl+C",
            "Ctrl+Shift+C",
            "Ctrl+Shift+Y",
            "PgUp",
            "Ctrl+N",
            "Alt+↑/↓",
            "Ctrl+V",
            "Ctrl+L",
            "Ctrl+T",
            "Ctrl+Q",
        ] {
            assert!(shown.contains(key), "help is missing {key:?}\n{shown}");
        }
        for (key, _) in HELP_ROWS {
            assert!(!key.trim().is_empty(), "a help row has no key");
        }
    }

    /// The help follows the language: the meaning translates, the chords do not.
    #[test]
    fn the_help_follows_the_language() {
        let zh = App {
            lang: Lang::Zh,
            ..App::default()
        };
        let en = App {
            lang: Lang::En,
            ..App::default()
        };
        let zh_text = text_of(&lines(&Dialog::Help(0), &zh, 60, 20));
        let en_text = text_of(&lines(&Dialog::Help(0), &en, 60, 20));
        assert!(zh_text.contains("命令面板"), "{zh_text}");
        assert!(en_text.contains("Command palette"), "{en_text}");
        assert!(zh_text.contains("Ctrl+P") && en_text.contains("Ctrl+P"));
        assert_eq!(title(&Dialog::Help(0), Lang::Zh), " 键盘帮助 ");
        assert_eq!(title(&Dialog::Help(0), Lang::En), " Keyboard help ");
    }

    /// The notice log shows what was announced, newest last, with the level
    /// spelled out — and an empty log says so rather than showing a bare box.
    #[test]
    fn the_notice_log_shows_what_was_announced() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        assert!(text_of(&lines(&Dialog::Notices(0), &app, 60, 10)).contains("Nothing has been"));
        app.push_notice(Notice {
            text: "link open: stdio: -".into(),
            level: NoticeLevel::Info,
        });
        app.push_notice(Notice {
            text: "connect failed: nope".into(),
            level: NoticeLevel::Error,
        });
        let shown = text_of(&lines(&Dialog::Notices(0), &app, 60, 10));
        assert!(shown.contains("info"), "{shown}");
        assert!(shown.contains("error"), "{shown}");
        let first = shown.find("link open").expect("the first is listed");
        let second = shown.find("connect failed").expect("the second is listed");
        assert!(first < second, "the log runs newest last:\n{shown}");
    }

    /// The notice log keeps more than the toast stack does, so the dialog is a
    /// *log* and not a second view of the three toasts already on screen.
    #[test]
    fn the_log_keeps_more_than_the_toasts() {
        let mut app = App::default();
        for i in 0..crate::app::MAX_NOTICES + 5 {
            app.push_notice(Notice {
                text: format!("n{i}"),
                level: NoticeLevel::Info,
            });
        }
        assert_eq!(
            app.notices.len(),
            crate::app::MAX_NOTICES,
            "the toasts stay bounded"
        );
        assert!(app.log.len() > crate::app::MAX_NOTICES, "the log is deeper");
    }

    /// Scrolling walks the window down one row at a time and stops at both
    /// ends: a help overlay that could be scrolled off its own text would leave
    /// the user staring at blanks.
    #[test]
    fn the_help_scrolls_and_stops_at_the_ends() {
        // A frame the modal can be measured in: the help wraps to the box,
        // so the count the keys clamp to has to be the count the painter
        // draws. The rail and the panel are closed to give it the wide box.
        let mut app = App {
            screen: ratatui::layout::Rect::new(0, 0, 80, 24),
            sidebar_visible: false,
            assistant_panel: false,
            ..App::default()
        };
        let width = crate::ui::overlay::dialog_body_width(
            app.screen,
            app.sidebar_visible,
            app.panel_wanted(),
        );
        let rows = row_count(&app, &Dialog::Help(0));
        let height = crate::ui::overlay::dialog_body_room(
            app.screen,
            app.sidebar_visible,
            app.panel_wanted(),
            rows,
        );
        assert!(height > 0, "the help should have a painted window");
        let first = text_of(&lines(&Dialog::Help(0), &app, width, height));
        assert!(first.contains("Ctrl+P"), "{first}");

        open_help(&mut app);
        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.dialog, Some(Dialog::Help(1)));
        handle_key(&mut app, KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
        assert_eq!(app.dialog, Some(Dialog::Help(0)));
        handle_key(&mut app, KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
        // The count knows about the wrapping: End lands on the body's last
        // *visible start*, not on the row the unwrapped list or the painter's
        // clamp would have ended at.
        let all = body(&Dialog::Help(0), &app, width as usize, &app.theme());
        let last = all.len().saturating_sub(height);
        assert!(last > 0, "the help should overflow the test window");
        assert_eq!(row_count(&app, &Dialog::Help(0)), all.len());
        assert_eq!(app.dialog, Some(Dialog::Help(last)));
        // Past the end stays at the end, and the window shows the tail.
        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.dialog, Some(Dialog::Help(last)));
        let tail = text_of(&lines(&Dialog::Help(last), &app, width, height));
        let end = text_of(&all[last..]);
        assert!(tail.ends_with(&end), "{tail}");
    }

    /// The help's two columns stay apart even at the longest chord, and a
    /// meaning or the note that outgrows the box wraps instead of being cut.
    #[test]
    fn the_help_wraps_inside_its_box() {
        let app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        for width in [30u16, 44, 60, 94] {
            let height = body_height(&app, &Dialog::Help(0), width);
            let rows = lines(&Dialog::Help(0), &app, width, height);
            for line in &rows {
                assert!(
                    line.width() <= width as usize,
                    "a row outgrew {width} columns: {:?}",
                    text_of(std::slice::from_ref(line))
                );
            }
            let shown = text_of(&rows);
            // The longest key and the note's last words survive the box at
            // every width; the old painter cut the note off at the border.
            assert!(shown.contains("Ctrl+Shift+C"), "{shown}");
            assert!(shown.contains("属于助手"), "{shown}");
        }
        // The gutter: the longest chord is followed by four blanks before
        // the meaning starts.
        let rows = lines(&Dialog::Help(0), &app, 94, 40);
        let row = rows
            .iter()
            .find(|line| text_of(std::slice::from_ref(line)).starts_with("Ctrl+Shift+C"))
            .expect("the longest chord is drawn");
        let row = text_of(std::slice::from_ref(row));
        assert_eq!(&row[12..16], "    ", "{row:?}");
    }

    /// A meaning wraps at a space before it wraps inside a word: a narrow
    /// English box once drew `assis` and `tant` on two rows.
    #[test]
    fn the_help_does_not_split_english_words() {
        let app = App {
            lang: Lang::En,
            screen: ratatui::layout::Rect::new(0, 0, 100, 24),
            ..App::default()
        };
        let width = crate::ui::overlay::dialog_body_width(
            app.screen,
            app.sidebar_visible,
            app.panel_wanted(),
        );
        let shown = text_of(&lines(&Dialog::Help(0), &app, width, 30));
        assert!(!shown.contains("assis\n"), "{shown}");
        assert!(shown.contains("assistant"), "{shown}");
    }

    /// The sheet carries every command in its group, in both languages —
    /// commands verbatim, because they are what the shell gets — and exactly
    /// one row is under the cursor.
    #[test]
    fn the_cheat_sheet_lists_every_command() {
        let en = App {
            lang: Lang::En,
            ..App::default()
        };
        let sheet = text_of(&lines(
            &Dialog::Cheat(Cheat {
                selected: 0,
                scroll: 0,
            }),
            &en,
            70,
            40,
        ));
        for (group, items) in CHEAT_GROUPS {
            assert!(sheet.contains(entry(*group, Lang::En)), "{sheet}");
            for (command, meaning) in items.iter() {
                assert!(sheet.contains(command), "missing {command:?}\n{sheet}");
                assert!(
                    sheet.contains(entry(*meaning, Lang::En)),
                    "missing the note for {command:?}\n{sheet}"
                );
            }
        }
        assert_eq!(
            sheet.matches('▸').count(),
            1,
            "one cursor, not two:\n{sheet}"
        );

        let zh = App {
            lang: Lang::Zh,
            ..App::default()
        };
        let sheet = text_of(&lines(
            &Dialog::Cheat(Cheat {
                selected: 0,
                scroll: 0,
            }),
            &zh,
            70,
            40,
        ));
        assert!(sheet.contains("文件与目录"), "{sheet}");
        assert!(sheet.contains("ls -l"), "a command is literal:\n{sheet}");
    }

    /// The cursor walks the commands and stops at both ends; Escape closes and
    /// a key with no meaning here does not.
    #[test]
    fn the_cheat_cursor_walks_and_stops_at_the_ends() {
        let mut app = App::default();
        open_cheat(&mut app);
        fn selected(app: &App) -> usize {
            match app.dialog.as_ref() {
                Some(Dialog::Cheat(cheat)) => cheat.selected,
                other => panic!("the sheet is up: {other:?}"),
            }
        }
        handle_key(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(selected(&app), 0, "up from the top");
        for _ in 0..3 {
            handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert_eq!(selected(&app), 3);
        handle_key(&mut app, KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
        assert_eq!(selected(&app), cheat_count() - 1);
        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(selected(&app), cheat_count() - 1, "down from the bottom");
        handle_key(&mut app, KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
        assert_eq!(selected(&app), cheat_count() - 11);
        handle_key(&mut app, KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
        assert_eq!(selected(&app), 0);
        // A key with no meaning here is not a key that cancels.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
        );
        assert!(matches!(app.dialog, Some(Dialog::Cheat(_))));
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.dialog, None);
    }

    /// Enter sends the command under the cursor — verbatim, placeholders and
    /// all — and the sheet stays up, so a session's commands go out of one
    /// window.
    #[test]
    fn enter_sends_the_command_under_the_cursor_and_keeps_the_sheet() {
        use crate::session::Dial;
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.dial(&Dial::Stdio("-".into()))
            .expect("the loopback opens");
        pump_until(&mut app, |app| app.state == ConnectionState::Connected);

        open_cheat(&mut app);
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.tx, "ls -l".len() as u64 + 1, "and a carriage return");
        let Some(Dialog::Cheat(cheat)) = app.dialog.as_ref() else {
            panic!("the sheet stayed up: {:?}", app.dialog);
        };
        assert_eq!(cheat.selected, 0, "the cursor did not move");

        // `<dir>` goes out as written: the placeholder is edited on the
        // target, and the sheet must not guess what it stands for.
        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.tx, ("ls -l".len() + 1 + "cd <dir>".len() + 1) as u64);
    }

    /// A send with no link is refused out loud, the way a preset is — and the
    /// sheet stays put so the command is still there to copy from.
    #[test]
    fn a_cheat_send_with_no_link_is_refused_out_loud() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        open_cheat(&mut app);
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(app.dialog, Some(Dialog::Cheat(_))));
        assert!(
            app.log
                .iter()
                .any(|notice| notice.text.contains("Not connected")),
            "it said so: {:?}",
            app.log
        );
    }

    /// The sheet follows the cursor: walking past the window's bottom row
    /// scrolls it, and the chip is painted inside the window.
    #[test]
    fn the_cheat_sheet_follows_the_cursor() {
        let mut app = App {
            screen: ratatui::layout::Rect::new(0, 0, 120, 30),
            ..App::default()
        };
        open_cheat(&mut app);
        fn scroll(app: &App) -> usize {
            match app.dialog.as_ref() {
                Some(Dialog::Cheat(cheat)) => cheat.scroll,
                other => panic!("the sheet is up: {other:?}"),
            }
        }
        assert_eq!(scroll(&app), 0, "the sheet opens on its first row");
        handle_key(&mut app, KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
        let rows: usize = CHEAT_GROUPS.iter().map(|(_, items)| items.len() + 2).sum();
        let room = crate::ui::overlay::dialog_body_room(
            app.screen,
            app.sidebar_visible,
            app.panel_wanted(),
            rows,
        );
        assert!(room > 0, "the test frame is big enough for a modal");
        let line = cheat_line_of(cheat_count() - 1);
        assert!(
            line >= scroll(&app) && line < scroll(&app) + room,
            "the chip is painted: line {line}, scroll {}, room {room}",
            scroll(&app)
        );
    }

    // --- the UART window ------------------------------------------------

    /// Opening the window asks the bridge what its UART is running, and shows
    /// that the question is out — the field holds the default until the
    /// answer corrects it.
    #[test]
    fn opening_the_uart_window_asks_the_bridge_what_it_runs() {
        let (mut app, wire) = connected_over_ble();
        open_uart(&mut app);
        assert!(asked_includes(&wire, b"@u?"), "the window asked");
        let uart = uart_of(&app);
        assert_eq!(uart.field.text, UART_DEFAULT);
        assert_eq!(
            uart.field.cursor,
            UART_DEFAULT.len(),
            "the caret is at the end"
        );
        assert!(uart.error.is_none(), "{:?}", uart.error);
        let dialog = app.dialog.clone().expect("the window is up");
        let shown = text_of(&lines(&dialog, &app, 70, 8));
        assert!(shown.contains("querying uart"), "{shown}");
    }

    /// Without a Bluetooth link there is no management channel to ask over.
    /// The window still opens — the field is a hint in itself — and says on
    /// its own error line why the question cannot go out.
    #[test]
    fn without_a_bluetooth_link_the_uart_window_says_why() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        open_uart(&mut app);
        let uart = uart_of(&app);
        let error = uart.error.clone().expect("it said why");
        assert!(error.contains("Not connected"), "{error}");
        assert!(uart.status.is_none());
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.dialog, None);
    }

    /// The answer is what the field ends up holding — the bridge's rate, not
    /// the typed one — and the status line carries the bridge's own words.
    #[test]
    fn the_bridges_answer_sets_the_field_and_the_status_line() {
        let (mut app, wire) = connected_over_ble();
        open_uart(&mut app);
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "OK uart=9600,7,e,2,rtscts"));
        pump_until(
            &mut app,
            |app| matches!(&app.dialog, Some(Dialog::Uart(uart)) if uart.field.text == "9600,7,e,2,rtscts"),
        );
        let uart = uart_of(&app);
        assert_eq!(uart.field.text, "9600,7,e,2,rtscts");
        assert_eq!(uart.field.cursor, uart.field.text.len());
        assert_eq!(uart.status.as_deref(), Some("OK uart=9600,7,e,2,rtscts"));
        assert!(uart.error.is_none());
        assert_eq!(app.baud, Some(9600), "and the top bar's slot fills in");
    }

    /// Enter sends the spec under the caret, verbatim, and says what is being
    /// set until the bridge answers with what it now is.
    #[test]
    fn enter_sends_the_typed_spec() {
        let (mut app, wire) = connected_over_ble();
        open_uart(&mut app);
        retype(&mut app, "9600,8,n,1,none");
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        // One drain, because the frame that went out is also the one whose id
        // the bridge will answer with.
        let frames = asked_frames(&wire);
        let last = frames.last().expect("the spec went out");
        assert_eq!(
            &last[crate::protocol::MGMT_HEADER_SIZE..],
            b"@u=9600,8,n,1,none",
            "the spec went out as typed"
        );
        let expected = fill(
            entry(UART_SETTING, Lang::En),
            &["9600,8,n,1,none".to_string()],
        );
        let uart = uart_of(&app);
        assert_eq!(uart.status.as_deref(), Some(expected.as_str()));
        assert!(uart.error.is_none());

        // And the bridge's answer, when it comes, is what stays on the line.
        let id = u32::from_le_bytes([last[4], last[5], last[6], last[7]]);
        wire.feed_management(answer(id, "OK uart=9600,8,n,1,none"));
        pump_until(
            &mut app,
            |app| matches!(&app.dialog, Some(Dialog::Uart(uart)) if uart.status.as_deref() == Some("OK uart=9600,8,n,1,none")),
        );
    }

    /// A spec that does not parse is refused where it was typed, and nothing
    /// goes out: the round trip is for the bridge's judgement, not the
    /// parser's.
    #[test]
    fn a_spec_that_does_not_parse_is_refused_and_nothing_is_sent() {
        let (mut app, wire) = connected_over_ble();
        open_uart(&mut app);
        retype(&mut app, "fast,8,n,1,none");
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let uart = uart_of(&app);
        let error = uart.error.clone().expect("the field was refused");
        assert!(error.contains("fast"), "{error}");
        assert!(uart.status.is_none());
        assert!(
            !asked_frames(&wire)
                .iter()
                .any(|frame| frame[crate::protocol::MGMT_HEADER_SIZE..].starts_with(b"@u=")),
            "nothing went out"
        );
    }

    /// The bridge's refusal is shown as it came, on the error line, and the
    /// field is left alone — it is what the user is going to fix.
    #[test]
    fn the_bridges_refusal_lands_on_the_error_line() {
        let (mut app, wire) = connected_over_ble();
        open_uart(&mut app);
        let id = asked_id(&wire);
        wire.feed_management(answer(id, "ERR format: @u=115200,8,n,1,n"));
        pump_until(
            &mut app,
            |app| matches!(&app.dialog, Some(Dialog::Uart(uart)) if uart.error.is_some()),
        );
        let uart = uart_of(&app);
        assert_eq!(uart.error.as_deref(), Some("ERR format: @u=115200,8,n,1,n"));
        assert!(uart.status.is_none());
        assert_eq!(uart.field.text, UART_DEFAULT, "the field is not touched");
    }

    /// Esc, `q`, `?` and Enter all close a scrolled dialog, and every one of
    /// them is consumed — a key that closed the overlay and *also* went to the
    /// device would be a silent double action.
    #[test]
    fn the_close_keys_close_and_are_consumed() {
        for code in [
            KeyCode::Esc,
            KeyCode::Char('q'),
            KeyCode::Char('?'),
            KeyCode::Enter,
        ] {
            let mut app = App::default();
            open_help(&mut app);
            assert!(handle_key(
                &mut app,
                KeyEvent::new(code, KeyModifiers::NONE)
            ));
            assert!(app.dialog.is_none(), "{code:?} did not close");
        }
    }

    /// A confirmation names the command and starts on *Cancel*: the safe answer
    /// is the one a stray Enter gives.
    #[test]
    fn a_confirmation_names_the_command_and_defaults_to_cancel() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        ask(&mut app, ConfirmAction::Send("reboot".into()));
        let Some(Dialog::Confirm(confirm)) = &app.dialog else {
            panic!("no confirmation was raised");
        };
        assert!(confirm.prompt.contains("reboot"), "{}", confirm.prompt);
        assert!(!confirm.yes, "the safe button is highlighted");
        assert_eq!(title(&app.dialog.clone().unwrap(), Lang::En), " Confirm ");
    }

    /// Enter on the default highlight cancels; `y` confirms; `n` and Esc cancel
    /// — and confirming is what actually sends.
    #[test]
    fn a_confirmation_only_sends_when_it_is_agreed_to() {
        // Enter on the default highlight: nothing is sent.
        let mut app = App::default();
        ask(&mut app, ConfirmAction::Send("reboot".into()));
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        assert_eq!(app.tx, 0, "the default answer sent nothing");

        // Flip to yes and Enter: it goes out — or, with no link, it is refused
        // out loud rather than silently dropped.
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        ask(&mut app, ConfirmAction::Send("reboot".into()));
        handle_key(&mut app, KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
        assert!(matches!(
            app.dialog,
            Some(Dialog::Confirm(Confirm { yes: true, .. }))
        ));
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none());
        assert!(
            app.log
                .iter()
                .any(|notice| notice.text.contains("Not connected")),
            "a confirmed send with no link is refused out loud: {:?}",
            app.log
        );

        // `y` is the shortcut straight to the same place.
        let mut app = App::default();
        ask(&mut app, ConfirmAction::Send("reboot".into()));
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE),
        );
        assert!(app.dialog.is_none());

        // `n` cancels without doing anything.
        let mut app = App::default();
        ask(&mut app, ConfirmAction::Send("reboot".into()));
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE),
        );
        assert!(app.dialog.is_none());
        assert!(app.log.is_empty(), "cancelling announced nothing");
    }

    /// A confirmed command rides the same path a preset does: with a live link
    /// it reaches the device, and the counter moves with it.
    #[test]
    fn a_confirmed_command_reaches_the_device() {
        use crate::session::Dial;
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.dial(&Dial::Stdio("-".into()))
            .expect("the loopback opens");
        pump_until(&mut app, |app| app.state == ConnectionState::Connected);

        ask(&mut app, ConfirmAction::Send("version".into()));
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE),
        );
        assert_eq!(app.tx, 8, "the carriage return is part of what was sent");
    }

    /// Joining a network is two questions and one command: the name is asked,
    /// then the password, and only then is the change put in front of the user.
    /// A half of that command is not a thing that can be sent.
    #[test]
    fn joining_a_network_asks_for_the_name_then_the_password_then_agreement() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        prompt_wifi_ssid(&mut app);
        for ch in "BenchNet".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            );
        }
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

        // The password, not the wire.
        let Some(Dialog::Prompt(prompt)) = &app.dialog else {
            panic!("the password was asked for: {:?}", app.dialog);
        };
        assert_eq!(prompt.action, PromptAction::WifiPassword);
        assert_eq!(app.network.ssid_input, "BenchNet", "the name was kept");

        for ch in "s3cret".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            );
        }
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

        let Some(Dialog::Confirm(card)) = &app.dialog else {
            panic!("and then the approval card: {:?}", app.dialog);
        };
        assert_eq!(
            card.action,
            ConfirmAction::Accessory("@w=BenchNet,s3cret".to_string())
        );
        // The card says what it is doing without saying the password: it is on
        // a screen somebody may be looking at.
        assert!(!card.prompt.contains("s3cret"), "{:?}", card.prompt);
        assert!(card.prompt.contains("BenchNet"), "{:?}", card.prompt);
    }

    /// Naming no network is a stop, not a join: `@w=,` would be read by the
    /// firmware as an empty SSID, which is a different and much more confusing
    /// failure than the one worth reporting.
    #[test]
    fn joining_a_network_nobody_named_is_refused() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        prompt_wifi_ssid(&mut app);
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "and nothing else was asked");
        assert!(app.network.ssid_input.is_empty());
        assert!(
            app.notices
                .iter()
                .any(|n| n.level == NoticeLevel::Warn && !n.text.is_empty()),
            "it said why: {:?}",
            app.notices
        );
    }

    /// A control chord is not consumed: the global handler still owns `Ctrl+Q`
    /// and `Ctrl+T` with a modal open.
    #[test]
    fn a_control_chord_falls_through_to_the_global_handler() {
        let mut app = App::default();
        open_help(&mut app);
        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)
        ));
        assert!(app.dialog.is_some(), "the help is still open");
    }

    /// The body is padded to the height it is given, so the legend stays on the
    /// box's bottom row however short the content is.
    #[test]
    fn the_body_fills_its_height() {
        let app = App::default();
        for height in [1usize, 3, 8, 40] {
            let shown = lines(&Dialog::Notices(0), &app, 60, height);
            assert_eq!(shown.len(), height, "height {height}");
        }
        assert!(lines(&Dialog::Notices(0), &app, 60, 0).is_empty());
    }

    /// The confirmation wraps a long prompt instead of cutting it: the command
    /// being confirmed is the one thing that must never be truncated.
    #[test]
    fn a_long_prompt_wraps_rather_than_cuts() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        let long = "a-very-long-preset-command-that-does-not-fit-on-one-row";
        ask(&mut app, ConfirmAction::Send(long.into()));
        let shown = text_of(&lines(&app.dialog.clone().unwrap(), &app, 24, 12));
        assert!(shown.contains("a-very-long-preset"), "{shown}");
        assert!(
            shown.contains("one-row"),
            "the tail of the command is there:\n{shown}"
        );
        assert!(
            !shown.contains('…'),
            "a prompt is wrapped, not cut:\n{shown}"
        );
    }

    /// The buttons take the right chip in each state, so the highlight really
    /// moves rather than both buttons looking chosen.
    #[test]
    fn the_highlight_moves_between_the_buttons() {
        let app = App {
            lang: Lang::En,
            ..App::default()
        };
        let no = Dialog::Confirm(Confirm {
            prompt: "p".into(),
            detail: "d".into(),
            action: ConfirmAction::Send("x".into()),
            yes: false,
        });
        let yes = Dialog::Confirm(Confirm {
            prompt: "p".into(),
            detail: "d".into(),
            action: ConfirmAction::Send("x".into()),
            yes: true,
        });
        let chips = |dialog: &Dialog| -> (usize, usize) {
            let theme: Theme = Theme::DARK;
            let rows = body(dialog, &app, 40, &theme);
            let last = rows.last().expect("the button row");
            let yes = last.spans[0].style;
            let no = last.spans[2].style;
            (
                usize::from(yes == theme.selected()),
                usize::from(no == theme.selected()),
            )
        };
        assert_eq!(chips(&no), (0, 1), "cancel is highlighted by default");
        assert_eq!(chips(&yes), (1, 0), "and the highlight moves to confirm");
    }

    // --- the prompts ------------------------------------------------

    /// The field edits *at the caret*, the way a text field does — including in
    /// the middle of a value, which is the case an append-only field gets wrong.
    #[test]
    fn the_field_edits_at_the_caret() {
        let mut field = Field::default();
        assert_eq!(
            field.split(),
            ("", " ", ""),
            "an empty field still has a caret"
        );

        field.insert('a');
        field.insert('b');
        assert_eq!(field.text, "ab");
        field.left();
        field.insert('X');
        assert_eq!(field.text, "aXb");
        // Inserting moves the caret *past* what was typed, so the highlighted
        // glyph is the one now to the caret's right — not the one just written.
        assert_eq!(field.split(), ("aX", "b", ""));
        field.backspace();
        assert_eq!(field.text, "ab");
        field.delete();
        assert_eq!(field.text, "a");
        field.home();
        field.delete();
        assert_eq!(field.text, "");
        field.backspace();
        assert_eq!(field.text, "", "backspace at the start does nothing");
        field.insert('z');
        field.end();
        field.right();
        assert_eq!(field.cursor, 1, "right stops at the end");
        assert_eq!(field.answer(), "z");
    }

    /// The answer is trimmed: a trailing space is easy to type and never meant,
    /// and a leading one hides.
    #[test]
    fn the_answer_is_trimmed() {
        let mut field = Field::default();
        for c in "  fw.bin ".chars() {
            field.insert(c);
        }
        assert_eq!(field.text, "  fw.bin ");
        assert_eq!(field.answer(), "fw.bin");

        let mut blank = Field::default();
        for _ in 0..3 {
            blank.insert(' ');
        }
        assert_eq!(blank.answer(), "", "whitespace is not a file name");
    }

    /// The caret moves by whole characters. A caret that split one would panic
    /// the painter, and a network name is a likely place to meet a multi-byte
    /// one.
    #[test]
    fn the_caret_never_splits_a_character() {
        let mut field = Field::default();
        for c in "固件.bin".chars() {
            field.insert(c);
        }
        assert_eq!(field.text, "固件.bin");

        for _ in 0..20 {
            field.left();
            let (before, under, after) = field.split();
            if field.cursor < field.text.len() {
                assert_eq!(format!("{before}{under}{after}"), field.text);
            } else {
                assert_eq!(under, " ", "the caret is one cell at the end");
            }
        }
        assert_eq!(field.cursor, 0, "left stops at the start");
        for _ in 0..20 {
            field.right();
            let (before, under, after) = field.split();
            if field.cursor < field.text.len() {
                assert_eq!(format!("{before}{under}{after}"), field.text);
            }
        }
        assert_eq!(field.cursor, field.text.len(), "right stops at the end");
        assert_eq!(field.answer(), "固件.bin");
    }

    /// The field is painted as a box with a one-cell caret in it, and the
    /// placeholder only while there is nothing to show: an input nobody can see
    /// is the state every prompt opens in, so the place to type into is drawn
    /// whether or not it holds anything.
    #[test]
    fn the_field_paints_its_caret() {
        let app = App {
            lang: Lang::En,
            ..App::default()
        };
        let theme = Theme::DARK;
        let rows_of = |prompt: Prompt| -> Vec<Line<'static>> {
            let rows = body(&Dialog::Prompt(prompt), &app, 60, &theme);
            rows[rows.len() - 3..].to_vec()
        };
        let row_text = |row: &Line<'static>| -> String {
            row.spans.iter().map(|s| s.content.as_ref()).collect()
        };

        let rows = rows_of(Prompt::new(WIFI_TITLE, PromptAction::WifiSsid));
        assert_eq!(rows.len(), 3, "a field is a box: top, content, bottom");
        let (top, field, bottom) = (&rows[0], &rows[1], &rows[2]);

        // The box is the dialog frame's own furniture one size down, drawn
        // rather than filled — so an empty field is a place, not a gap between
        // two labels.
        let edge = Style::default().fg(theme.line_strong);
        let top_text = row_text(top);
        assert!(top_text.starts_with("  ╭"), "{top_text:?}");
        assert!(top_text.ends_with('╮'), "{top_text:?}");
        let bottom_text = row_text(bottom);
        assert!(bottom_text.starts_with("  ╰"), "{bottom_text:?}");
        assert!(bottom_text.ends_with('╯'), "{bottom_text:?}");
        assert_eq!(text::columns(&top_text), 60, "the box fills the row");
        assert_eq!(top.spans[0].style, theme.card());
        assert_eq!(top.spans[1].style, edge, "the edge is the frame's ink");

        let shown = row_text(field);
        assert!(
            shown.starts_with("  │ for example BenchNet"),
            "an empty field says what it wants: {shown:?}"
        );
        assert!(shown.ends_with('│'), "{shown:?}");
        assert_eq!(text::columns(&shown), 60, "the box fills the row");
        let caret = field
            .spans
            .iter()
            .position(|span| span.style == theme.selected())
            .expect("a caret chip");
        assert_eq!(field.spans[caret].content, " ", "the caret is one cell");
        // The interior is the card's own ground: a row painted in a background
        // colour would read as a line the user selected rather than as a field.
        assert_eq!(field.spans[0].style, theme.card());
        assert_eq!(
            field.spans[field.spans.len() - 2].style,
            theme.card(),
            "the interior is filled to the box's side"
        );

        let mut typed = Prompt::new(WIFI_TITLE, PromptAction::WifiSsid);
        typed.field.insert('x');
        let typed_row = rows_of(typed)[1].clone();
        let shown = row_text(&typed_row);
        assert!(
            shown.starts_with("  │x "),
            "the caret sits after what was typed: {shown:?}"
        );
    }

    /// A masked field shows one star per character, except the character the
    /// last edit put there: it stays in the clear for its moment, the way the
    /// assistant's key field shows a character it was given. Ctrl+R still shows
    /// the whole field, and a character taken away takes the reveal with it.
    #[test]
    fn a_masked_field_reveals_only_the_last_character() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.lan_token = String::new();
        prompt_lan_token(&mut app);
        for ch in "abcd".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            );
        }
        let theme = app.theme();
        let painted = text_of(&body(&app.dialog.clone().unwrap(), &app, 60, &theme));
        assert!(
            painted.contains("***d"),
            "the character just typed is in the clear:\n{painted}"
        );
        assert!(
            !painted.contains("abcd"),
            "the ones before it are not:\n{painted}"
        );

        // The moment passes, and the star takes the character back.
        let Some(Dialog::Prompt(prompt)) = &mut app.dialog else {
            panic!("the prompt is up");
        };
        prompt.reveal = Some((3, Instant::now() - Duration::from_millis(1)));
        let painted = text_of(&body(&app.dialog.clone().unwrap(), &app, 60, &theme));
        assert!(painted.contains("****"), "the reveal ends:\n{painted}");

        // An edit that takes a character away puts the reveal out too: the
        // index it holds is a place in the text, and the edit moved the
        // characters left into it.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
        );
        let painted = text_of(&body(&app.dialog.clone().unwrap(), &app, 60, &theme));
        assert!(
            painted.contains("***"),
            "nothing is left in the clear:\n{painted}"
        );
    }

    /// A keystroke in the middle of an answer unveils *its* character, not the
    /// last character of the line: the caret is where the edit left it, and the
    /// character just put there is the one before the caret.
    #[test]
    fn a_masked_field_reveals_the_character_just_typed() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.lan_token = String::new();
        prompt_lan_token(&mut app);
        for ch in "abcd".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            );
        }
        // The caret walks back to sit before the `d`, and `x` lands there.
        handle_key(&mut app, KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
        );
        let theme = app.theme();
        let painted = text_of(&body(&app.dialog.clone().unwrap(), &app, 60, &theme));
        assert!(
            painted.contains("***x*"),
            "the character just typed is in the clear:\n{painted}"
        );
        assert!(
            !painted.contains("***d"),
            "the last character of the line is not the one that was typed:\n{painted}"
        );
    }

    /// A prompt carries its own title and legend, in the interface language.
    #[test]
    fn a_prompt_carries_its_own_words() {
        let send = Dialog::Prompt(Prompt::new(WIFI_TITLE, PromptAction::WifiSsid));
        let receive = Dialog::Prompt(Prompt::new(LAN_HOST_TITLE, PromptAction::LanHost));
        assert_eq!(title(&send, Lang::En), " Join a WiFi network ");
        assert_eq!(title(&receive, Lang::Zh), " 局域网主机 ");
        assert_ne!(title(&send, Lang::Zh), title(&send, Lang::En));

        let theme = Theme::DARK;
        let en = legend(&send, Lang::En, &theme);
        assert!(en.spans[0].content.contains("Enter start"), "{en:?}");
        let zh = legend(&send, Lang::Zh, &theme);
        assert!(zh.spans[0].content.contains("Enter 开始"), "{zh:?}");
        // The two prompts do not share their words either.
        assert_ne!(title(&send, Lang::En), title(&receive, Lang::En));
    }

    /// The settings window is a form, not a log: it has its own title and
    /// legend, it paints the rows it edits, and it answers to the field keys —
    /// `q` types a `q` and does not close anything, which is the one habit a
    /// reader of the notice log would otherwise bring with them.
    #[test]
    fn the_settings_window_is_a_form() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.assistant.notes = vec![(String::from("disk"), String::new())];
        crate::views::assistant::open_settings(
            &mut app,
            crate::views::assistant::AgentField::Endpoint,
        );
        let dialog = app.dialog.clone().expect("the window was not raised");
        let shown = text_of(&lines(&dialog, &app, 70, 20));
        assert!(shown.contains("endpoint"), "{shown}");
        assert!(shown.contains("Device notes"), "{shown}");
        assert!(
            shown.contains("disk"),
            "the note list is not painted:\n{shown}"
        );
        assert_eq!(title(&dialog, app.lang).trim(), "Assistant settings");
        assert!(!legend(&dialog, app.lang, &Theme::DARK).spans.is_empty());

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE),
        );
        assert!(app.dialog.is_some(), "`q` closed a form that was typing");
        assert_eq!(app.assistant.endpoint, "q");
    }

    /// The window pages with the reading keys and hands the caret back on
    /// Escape — a caret left on a row the view does not paint is a keystroke
    /// that lands nowhere the user can see it.
    #[test]
    fn the_settings_window_pages_and_gives_the_caret_back() {
        let mut app = App::default();
        crate::views::assistant::open_settings(
            &mut app,
            crate::views::assistant::AgentField::Endpoint,
        );
        for _ in 0..40 {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
            );
        }
        let scrolled = app.dialog.clone().expect("the window closed on a page");
        assert!(scrolled.scroll() > 0, "PgDn scrolled nothing");
        handle_key(&mut app, KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
        assert_eq!(app.dialog.clone().unwrap().scroll(), 0, "Home kept a page");

        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "Escape did not close the window");
        assert_eq!(
            crate::views::assistant::AgentField::Composer,
            app.assistant.focus,
            "the caret stayed on a row nothing is painting"
        );
    }

    /// The window follows its caret: ↑↓ walks the note list and Tab walks the
    /// fields, and the row the next keystroke lands on cannot leave the window
    /// on either trip. Paging is the exception — it is the user moving the
    /// window itself — and the next form key brings the window back, so typed
    /// text lands where it can be seen.
    #[test]
    fn the_settings_window_follows_its_caret() {
        let mut app = App {
            // The size the event loop stores before a key can arrive.
            screen: ratatui::layout::Rect::new(0, 0, 80, 24),
            ..App::default()
        };
        app.assistant.notes = (0..30)
            .map(|index| (format!("note-{index:02}"), String::new()))
            .collect();
        crate::views::assistant::open_settings(
            &mut app,
            crate::views::assistant::AgentField::Notes,
        );

        // Down the list: the cursor's note has to stay painted.
        for _ in 0..20 {
            handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert_eq!(app.assistant.note_cursor, 20);
        assert!(
            app.dialog.as_ref().unwrap().scroll() > 0,
            "the window did not follow the cursor down"
        );
        let shown = crate::ui::render_to_text(&app, 80, 24);
        assert!(
            shown.contains("note-20"),
            "the cursor's note left the window:\n{shown}"
        );

        // Tab walks back to the fields, and the window comes with it.
        handle_key(&mut app, KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(
            crate::views::assistant::AgentField::Endpoint,
            app.assistant.focus
        );
        assert_eq!(
            app.dialog.as_ref().unwrap().scroll(),
            2,
            "the window stayed on the notes"
        );
        let shown = crate::ui::render_to_text(&app, 80, 24);
        assert!(
            shown.contains("▌"),
            "the caret's row is not painted:\n{shown}"
        );

        // Paging moves the window on its own...
        for _ in 0..3 {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
            );
        }
        assert!(
            app.dialog.as_ref().unwrap().scroll() > 2,
            "PgDn scrolled nothing"
        );
        // ...and the first typed key brings it back to the caret.
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
        );
        assert_eq!(app.assistant.endpoint, "x");
        assert_eq!(
            app.dialog.as_ref().unwrap().scroll(),
            2,
            "the window did not come back to the caret"
        );
        let shown = crate::ui::render_to_text(&app, 80, 24);
        assert!(
            shown.contains("x▌"),
            "the typed key is not painted:\n{shown}"
        );
    }

    /// On the note row the arrows walk the notes; anywhere else they walk the
    /// fields. That row is where a field meets a list, and the list is the only
    /// thing that says which note Delete means.
    #[test]
    fn the_note_row_walks_the_notes() {
        // A real store in a temp file: both the write and the delete go through
        // it, and a `None` store empties the list on every write — which would
        // make this test pass for the wrong reason.
        let mut path = std::env::temp_dir();
        path.push(format!("linkr-dialog-note-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut app = App {
            agent_store: Some(crate::agent::store::JsonFile::at(&path)),
            ..App::default()
        };

        crate::views::assistant::open_settings(
            &mut app,
            crate::views::assistant::AgentField::Notes,
        );
        for word in ["one", "two"] {
            for ch in word.chars() {
                handle_key(
                    &mut app,
                    KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
                );
            }
            handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        }
        assert_eq!(app.assistant.notes.len(), 2, "neither note was filed");

        // Which row is which depends on the store's own ordering, so the test
        // asks the list rather than assuming it: Delete means the note under the
        // cursor, and the other one is what must survive.
        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(
            app.assistant.note_cursor, 1,
            "Down walked the fields, not the list"
        );
        let gone = app.assistant.notes[app.assistant.note_cursor].0.clone();
        handle_key(&mut app, KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE));
        assert_eq!(app.assistant.notes.len(), 1, "Delete kept both notes");
        assert_ne!(
            app.assistant.notes[0].0, gone,
            "Delete removed a note the cursor was not on"
        );

        // Tab leaves the row, and then the arrows are the fields' again — the
        // note list keeps its cursor, so coming back finds it where it was.
        handle_key(&mut app, KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_ne!(
            app.assistant.focus,
            crate::views::assistant::AgentField::Notes,
            "Tab did not leave the note row"
        );
        let cursor = app.assistant.note_cursor;
        handle_key(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(
            app.assistant.note_cursor, cursor,
            "the list moved while a different field had the caret"
        );
        let _ = std::fs::remove_file(&path);
    }

    // --- the LAN rows -----------------------------------------------

    /// The token prompt opens masked — a token that reached a screenshot has
    /// to be rotated — and Ctrl+R shows it for as long as it takes to check a
    /// character. The stars are one per character, so revealing the field does
    /// not move the caret.
    #[test]
    fn the_token_prompt_is_masked_and_ctrl_r_shows_it() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.lan_token = "abcd".into();
        prompt_lan_token(&mut app);

        let theme = app.theme();
        let painted = text_of(&body(&app.dialog.clone().unwrap(), &app, 60, &theme));
        assert!(painted.contains("****"), "the token is masked:\n{painted}");
        assert!(!painted.contains("abcd"), "and not spelled out:\n{painted}");

        // Ctrl+R is answered by the dialog itself, not the global handler.
        assert!(handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)
        ));
        let painted = text_of(&body(&app.dialog.clone().unwrap(), &app, 60, &theme));
        assert!(
            painted.contains("abcd"),
            "Ctrl+R shows the field:\n{painted}"
        );

        assert!(handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)
        ));
        let painted = text_of(&body(&app.dialog.clone().unwrap(), &app, 60, &theme));
        assert!(
            !painted.contains("abcd"),
            "and Ctrl+R masks it again:\n{painted}"
        );

        // The address is a thing to read back, not a secret.
        assert!(!Prompt::new(LAN_HOST_TITLE, PromptAction::LanHost).masked);
    }

    /// Both LAN prompts file their answer in the sidebar row they edit, and
    /// nowhere else: the row is the field, so the next dial describes what was
    /// typed.
    #[test]
    fn the_lan_prompts_write_the_sidebar_rows() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        prompt_lan_host(&mut app);
        for ch in " 192.168.1.9 ".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            );
        }
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "the prompt closed");
        assert_eq!(app.lan_host, "192.168.1.9", "the answer is trimmed in");

        prompt_lan_token(&mut app);
        for ch in "0123456789abcdef0123456789abcdef".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE),
            );
        }
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(
            app.lan_token, "0123456789abcdef0123456789abcdef",
            "the token is in the row, and nowhere else"
        );
        assert!(
            app.notices.is_empty(),
            "nothing was announced about a token"
        );
    }

    /// A conversation row for the picker's tests: an id, a name from its first
    /// question, nothing else.
    fn chat(id: u64, title: &str) -> crate::views::assistant::ChatState {
        crate::views::assistant::ChatState {
            id,
            title: title.to_string(),
            ..Default::default()
        }
    }

    /// The delete picker lists the conversations, marks the one the panel is
    /// showing, and Escape leaves every one of them alone — the palette's
    /// delete is a question now, not a command.
    #[test]
    fn the_chat_picker_lists_and_cancels() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.assistant.chats = vec![
            chat(1, "boot loop"),
            chat(2, "wifi keeps dropping"),
            chat(3, ""),
        ];
        app.assistant.active = 1;

        open_chat_pick(&mut app);
        assert!(matches!(app.dialog, Some(Dialog::ChatPick(_))));
        let shown = crate::ui::render_to_text(&app, 80, 24);
        assert!(shown.contains("1. boot loop"), "{shown}");
        assert!(
            shown.contains("2. wifi keeps dropping · shown"),
            "the panel's thread is not marked: {shown}"
        );
        assert!(
            shown.contains("3. (no messages)"),
            "an unnamed conversation has no row: {shown}"
        );

        // Down walks the list; Escape closes without deleting anything.
        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        handle_key(&mut app, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        let cursor = match app.dialog.as_ref() {
            Some(Dialog::ChatPick(pick)) => pick.cursor,
            other => panic!("the picker is not up: {other:?}"),
        };
        assert_eq!(cursor, 2, "Down did not walk the list");
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "Escape kept the window");
        assert_eq!(app.assistant.chats.len(), 3, "Escape deleted something");
    }

    /// Enter forgets the row under the cursor, and the panel keeps the thread
    /// it was showing when a row before it in the list goes.
    #[test]
    fn the_chat_picker_deletes_the_row_under_the_cursor() {
        let mut app = App {
            lang: Lang::En,
            ..App::default()
        };
        app.assistant.chats = vec![chat(1, "boot loop"), chat(2, "wifi"), chat(3, "audio")];
        app.assistant.active = 2;

        open_chat_pick(&mut app);
        handle_key(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        handle_key(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "the window outlived the delete");
        assert_eq!(app.assistant.chats.len(), 2);
        assert_eq!(
            app.assistant.chats[app.assistant.active].title, "audio",
            "the panel moved off the thread it was showing"
        );
        assert!(
            app.notices
                .last()
                .is_some_and(|notice| notice.text.contains("deleted")),
            "the delete went unannounced: {:?}",
            app.notices.last().map(|notice| &notice.text)
        );
    }

    /// The card about the program names what is actually running: the facts
    /// come from the crate's own manifest, the rendering line from the frame's
    /// capability, and the mark from the same — never from a string that could
    /// go stale.
    #[test]
    fn the_about_card_names_what_is_running() {
        let app = App {
            lang: Lang::En,
            screen: ratatui::layout::Rect::new(0, 0, 120, 36),
            ..App::default()
        };
        let height = body_height(&app, &Dialog::About, 60);
        let shown = text_of(&lines(&Dialog::About, &app, 60, height));
        assert!(shown.contains("bee"), "{shown}");
        assert!(shown.contains(env!("CARGO_PKG_VERSION")), "{shown}");
        assert!(shown.contains(env!("CARGO_PKG_LICENSE")), "{shown}");
        assert!(shown.contains(env!("CARGO_PKG_REPOSITORY")), "{shown}");
        assert!(shown.contains("https://github.com/Novice-PG"), "{shown}");
        assert!(shown.contains("TrueColor"), "{shown}");
        assert!(shown.contains("Unicode"), "{shown}");
        assert!(shown.contains("Components"), "{shown}");
        assert!(
            shown.contains(&format!("{} direct", crate::licenses::COMPONENTS.len())),
            "{shown}"
        );
        // The mark is on the card — the small one is twelve rows of cells, so
        // the body is taller than the facts alone.
        assert!(
            height > ABOUT_FACTS as usize,
            "no mark on the card:\n{shown}"
        );

        // Free of a frame — `--print-frame` before the first paint — there is
        // no room to measure, so the card is the facts and nothing else.
        let headless = App::default();
        let bare = text_of(&lines(
            &Dialog::About,
            &headless,
            60,
            body_height(&headless, &Dialog::About, 60),
        ));
        assert!(bare.contains(env!("CARGO_PKG_VERSION")), "{bare}");
    }

    /// The card's mark is transparent: its empty cells carry no background,
    /// so the card's own ground shows through; the art's lower-half colours
    /// stay.
    #[test]
    fn the_about_mark_leaves_its_ground_transparent() {
        let app = App {
            screen: ratatui::layout::Rect::new(0, 0, 120, 36),
            ..App::default()
        };
        let rows = body(&Dialog::About, &app, 60, &app.theme());
        let first = rows.first().expect("the card has a mark");
        assert!(
            first
                .spans
                .iter()
                .any(|span| span.content == " " && span.style.bg.is_none()),
            "the mark has no transparent ground: {:?}",
            first
                .spans
                .iter()
                .map(|span| (span.content.as_ref(), span.style.bg))
                .collect::<Vec<_>>()
        );
        assert!(
            !rows
                .iter()
                .flat_map(|line| line.spans.iter())
                .any(|span| span.style.bg == Some(Color::Rgb(255, 255, 255))),
            "the mark was painted on a white plate"
        );
        assert!(
            rows.iter()
                .flat_map(|line| line.spans.iter())
                .any(|span| span.style.bg.is_some()),
            "the art's own colours were lost"
        );
    }

    /// The card is the same card in either language: the labels translate,
    /// the facts do not.
    #[test]
    fn the_about_card_is_bilingual() {
        let zh = App {
            lang: Lang::Zh,
            screen: ratatui::layout::Rect::new(0, 0, 120, 36),
            ..App::default()
        };
        let shown = text_of(&lines(
            &Dialog::About,
            &zh,
            60,
            body_height(&zh, &Dialog::About, 60),
        ));
        assert!(shown.contains("版本"), "{shown}");
        assert!(shown.contains("许可证"), "{shown}");
        assert!(shown.contains("贡献者"), "{shown}");
        assert!(shown.contains("项目"), "{shown}");
        assert!(shown.contains("渲染"), "{shown}");
        assert!(shown.contains("开源组件"), "{shown}");
        assert!(shown.contains(env!("CARGO_PKG_VERSION")), "{shown}");
        assert_eq!(title(&Dialog::About, Lang::Zh), "关于");
        assert_eq!(title(&Dialog::About, Lang::En), "About");
    }

    /// Any key puts the card away: it is a card, not a form. A control chord
    /// is still the loop's, which is what keeps `Ctrl+Q` working over it.
    #[test]
    fn any_key_closes_the_about_card() {
        let mut app = App::default();
        open_about(&mut app);
        assert!(matches!(app.dialog, Some(Dialog::About)));
        assert!(handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)
        ));
        assert!(app.dialog.is_none(), "the card stayed up");

        open_about(&mut app);
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "Escape left the card up");

        open_about(&mut app);
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE),
        );
        assert!(
            matches!(app.dialog, Some(Dialog::Licenses(0))),
            "L did not open the component page"
        );
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "Escape left the component page up");

        open_about(&mut app);
        assert!(!handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL)
        ));
        assert!(
            matches!(app.dialog, Some(Dialog::About)),
            "a chord ate the card"
        );
    }

    /// The component page is the direct-dependency half of the generated
    /// notice: it names the build, the crates the binary links, and the
    /// contributors, and it says where the full transitive tail lives.
    #[test]
    fn the_licence_page_names_the_direct_components_and_contributors() {
        let app = App {
            lang: Lang::En,
            screen: ratatui::layout::Rect::new(0, 0, 120, 40),
            ..App::default()
        };
        let shown = text_of(&lines(
            &Dialog::Licenses(0),
            &app,
            70,
            body_height(&app, &Dialog::Licenses(0), 70),
        ));
        assert!(shown.contains("Linkr Bee Terminal"), "{shown}");
        assert!(shown.contains(env!("CARGO_PKG_VERSION")), "{shown}");
        assert!(shown.contains("ratatui"), "{shown}");
        assert!(
            shown.contains(&format!(
                "Direct dependencies ({})",
                crate::licenses::COMPONENTS.len()
            )),
            "{shown}"
        );
        assert!(shown.contains("transitive"), "{shown}");
        assert!(shown.contains("Novice-PG"), "{shown}");
        assert!(shown.contains("bee --licenses"), "{shown}");
        assert!(
            shown.contains("THIRD_PARTY_LICENSES.md"),
            "the notice filename was split by the wrap: {shown}"
        );
        assert_eq!(
            title(&Dialog::Licenses(0), Lang::En),
            " Open-source components "
        );
        assert_eq!(title(&Dialog::Licenses(0), Lang::Zh), " 开源组件 ");
    }

    /// The page is a document, so the paging keys move its own offset rather
    /// than the help's — the old scroll helper knew only two window kinds.
    #[test]
    fn the_licence_page_scrolls_and_keeps_its_own_kind() {
        let mut app = App::default();
        open_licenses(&mut app);
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
        );
        let Some(Dialog::Licenses(offset)) = app.dialog else {
            panic!("the page closed on a paging key: {:?}", app.dialog);
        };
        assert!(offset > 0, "PageDown did not move the page");
        handle_key(&mut app, KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE));
        assert!(matches!(app.dialog, Some(Dialog::Licenses(0))));
        handle_key(&mut app, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.dialog.is_none(), "Escape kept the page");
    }

    /// End parks the window at the last *visible* start, so the first Up after
    /// it actually moves the page. Clamping to the last row instead made Up
    /// spend several presses in an offset the painter could not show.
    #[test]
    fn end_stops_at_the_last_visible_start() {
        let mut app = App {
            screen: ratatui::layout::Rect::new(0, 0, 80, 24),
            ..App::default()
        };
        open_licenses(&mut app);
        let rows = row_count(&app, &Dialog::Licenses(0));
        let room = crate::ui::overlay::dialog_body_room(
            app.screen,
            app.sidebar_visible,
            app.panel_wanted(),
            rows,
        );
        assert!(room > 0, "the test screen should paint a dialog");
        let last = rows.saturating_sub(room);
        handle_key(&mut app, KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
        assert_eq!(
            app.dialog.as_ref().map(Dialog::scroll),
            Some(last),
            "End should stop at the last visible start"
        );
        handle_key(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(
            app.dialog.as_ref().map(Dialog::scroll),
            Some(last.saturating_sub(1)),
            "Up after End should move the visible window"
        );
    }
}

#[cfg(test)]
mod pick_tests {
    use super::*;

    fn device(name: &str, address: &str, board: bool) -> crate::cli::FoundDevice {
        crate::cli::FoundDevice {
            name: Some(name.to_string()),
            address: address.to_string(),
            board,
            rssi: None,
        }
    }

    /// The list is a list: the cursor moves inside it and stops at both ends,
    /// so a user cannot walk off a bench onto nothing.
    #[test]
    fn the_cursor_moves_inside_the_list() {
        let mut pick = DevicePick {
            devices: vec![device("A", "aa", true), device("B", "bb", false)],
            cursor: 0,
            scanning: false,
            message: String::new(),
            scroll: 0,
        };
        pick.move_cursor(false);
        assert_eq!(pick.cursor, 0, "up from the top");
        pick.move_cursor(true);
        assert_eq!(pick.cursor, 1);
        pick.move_cursor(true);
        assert_eq!(pick.cursor, 1, "down from the bottom");
    }

    /// The dialog paints a row for every device the list carries and marks
    /// whether it looks like a board; which devices deserve a row is the
    /// scan's decision, not the dialog's.
    #[test]
    fn a_device_that_is_not_a_board_is_still_listed() {
        let pick = DevicePick {
            devices: vec![device("Bee", "aa", true), device("Other", "bb", false)],
            cursor: 1,
            scanning: false,
            message: String::new(),
            scroll: 0,
        };
        assert_eq!(pick.rows(), 2);
        assert!(pick.selected().is_some());
        assert!(!pick.selected().expect("a device").board);
    }

    /// An empty list has no selection, which is what makes Enter scan again
    /// rather than dial nothing.
    #[test]
    fn an_empty_list_selects_nothing() {
        let pick = DevicePick {
            devices: Vec::new(),
            cursor: 0,
            scanning: true,
            message: String::new(),
            scroll: 0,
        };
        assert_eq!(pick.rows(), 0);
        assert!(pick.selected().is_none());
    }

    /// A device row leads with the signal the scan heard it at, dots and
    /// reading; a device the adapter had no reading for keeps the column and
    /// shows a dash rather than inventing a number.
    #[test]
    fn a_device_row_shows_the_signal_it_was_heard_at() {
        let app = App::default();
        let dialog = Dialog::DevicePick(DevicePick {
            devices: vec![
                crate::cli::FoundDevice {
                    rssi: Some(-58),
                    ..device("Bee", "aa", true)
                },
                device("Far", "bb", true),
            ],
            cursor: 0,
            scanning: false,
            message: String::new(),
            scroll: 0,
        });
        let text = painted(&dialog, &app, 70, 20);
        let bee = text
            .lines()
            .find(|row| row.contains("Bee"))
            .expect("the row is drawn");
        assert!(bee.contains("●●●○  -58dBm"), "{bee}");
        let far = text
            .lines()
            .find(|row| row.contains("Far"))
            .expect("the row is drawn");
        assert!(far.contains('—'), "no reading, no invented number: {far}");
        assert!(!far.contains("dBm"), "no reading, no unit: {far}");
    }

    /// The body of a dialog as text, one row per line: what the test reads is
    /// what the user would see.
    fn painted(dialog: &Dialog, app: &App, width: u16, height: usize) -> String {
        lines(dialog, app, width, height)
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

    /// The window follows the cursor: on a bench with more boards than the
    /// modal has rows, moving past the bottom scrolls by the least that keeps
    /// the highlighted row on screen, and walking back up brings the top row
    /// back. Without this, Enter dials whatever the cursor is on — a board the
    /// user cannot see.
    #[test]
    fn the_window_follows_the_cursor_it_cannot_show_at_once() {
        let mut pick = DevicePick {
            devices: (0..10)
                .map(|index| device("bee", &format!("id{index}"), true))
                .collect(),
            cursor: 0,
            scanning: false,
            message: String::new(),
            scroll: 0,
        };
        // The width the rows fit at: one line each, so the window moves in
        // device-sized steps, the way it always has.
        let spans = pick.line_spans(70, GlyphSet::Unicode);
        assert_eq!(spans, vec![1; 10]);
        for _ in 0..4 {
            pick.move_cursor(true);
            pick.follow(3, &spans);
        }
        assert_eq!(pick.cursor, 4);
        assert_eq!(pick.scroll(), 2, "the least move that shows the cursor");
        for _ in 0..9 {
            pick.move_cursor(false);
            pick.follow(3, &spans);
        }
        assert_eq!(pick.cursor, 0);
        assert_eq!(pick.scroll(), 0, "and the top of the list shows again");
    }

    /// A row the window is too narrow to hold whole wraps onto the rows below
    /// it — the name and the address both stay readable — where a cut would
    /// have left one of them behind an ellipsis.
    #[test]
    fn a_row_the_window_cannot_hold_wraps_instead_of_being_cut() {
        let app = App::default();
        let dialog = Dialog::DevicePick(DevicePick {
            devices: vec![crate::cli::FoundDevice {
                rssi: Some(-74),
                ..device("Linkr BLE UART-1", "DA:EB:CC:48:40:1A", true)
            }],
            cursor: 0,
            scanning: false,
            message: String::new(),
            scroll: 0,
        });
        // Narrow enough for the address to have to move: the head is the
        // board mark, the dots and the name, and the address rides the row
        // under it, indented to the name column.
        let narrow = painted(&dialog, &app, 36, 6);
        let rows: Vec<&str> = narrow.lines().filter(|row| !row.is_empty()).collect();
        assert_eq!(
            rows,
            vec![
                "bee ●●○○  -74dBm Linkr BLE UART-1",
                "                 DA:EB:CC:48:40:1A",
            ],
            "the row was cut or split instead of broken at its seam: {narrow}"
        );
        // Wide enough, and the row is the one-line table it always was.
        let wide = painted(&dialog, &app, 70, 6);
        assert_eq!(
            wide.lines().filter(|row| !row.is_empty()).count(),
            1,
            "the table row came apart at a width it fits: {wide}"
        );
    }

    /// The scroll counts the rows the paint will draw, so a cursor on a
    /// wrapped row still ends up on the screen — the arithmetic the key
    /// handler hands over.
    #[test]
    fn a_wrapped_row_scrolls_by_the_rows_it_paints() {
        let mut pick = DevicePick {
            devices: vec![
                device("Linkr BLE UART-1", "DA:EB:CC:48:40:1A", true),
                device("Linkr BLE UART-3", "FB:F6:91:14:33:3A", true),
                device("Linkr BLE UART-5", "EE:C7:42:34:48:CF", true),
            ],
            cursor: 0,
            scanning: false,
            message: String::new(),
            scroll: 0,
        };
        // At this width each row wraps onto two lines; a window of three rows
        // can show one device and a half of the next.
        let spans = pick.line_spans(36, GlyphSet::Unicode);
        assert_eq!(spans, vec![2, 2, 2]);
        pick.move_cursor(true);
        pick.move_cursor(true);
        pick.follow(3, &spans);
        let top: usize = spans.iter().take(pick.cursor).sum();
        assert!(
            pick.scroll() <= top && top + spans[pick.cursor] <= pick.scroll() + 3,
            "cursor rows {top}..{} outside the window at {}",
            top + spans[pick.cursor],
            pick.scroll()
        );
    }

    /// A scan that could not run says why in the dialog rather than being
    /// painted over with "no board answered": the two are different news, and
    /// the first is the one that sends the user to check an adapter.
    #[test]
    fn a_scan_that_could_not_run_says_why() {
        let app = App::default();
        let dialog = Dialog::DevicePick(DevicePick {
            devices: Vec::new(),
            cursor: 0,
            scanning: false,
            message: "no Bluetooth adapter on this machine".to_string(),
            scroll: 0,
        });
        let text = painted(&dialog, &app, 60, 4);
        assert!(text.contains("no Bluetooth adapter"), "{text:?}");
    }

    /// The picker's body says what is happening and its legend says which keys
    /// are live. They are different sentences: a scanning window that printed
    /// the same words in both places was saying it twice, once above the keys.
    #[test]
    fn the_picker_does_not_say_the_same_thing_twice() {
        let app = App {
            lang: Lang::Zh,
            ..App::default()
        };
        for scanning in [true, false] {
            let dialog = Dialog::DevicePick(DevicePick {
                devices: Vec::new(),
                cursor: 0,
                scanning,
                message: String::new(),
                scroll: 0,
            });
            let body_text: String = lines(&dialog, &app, 70, 20)
                .iter()
                .map(|line| {
                    line.spans
                        .iter()
                        .map(|span| span.content.as_ref())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n");
            let legend_text: String = legend(&dialog, app.lang, &Theme::DARK)
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect();
            assert!(!legend_text.is_empty());
            assert!(
                !body_text.contains(&legend_text),
                "scanning={scanning}: the legend repeats the body: {body_text:?}"
            );
        }
    }

    /// A cursor left over from a longer list is clamped by the app, not by the
    /// dialog: this is what that clamp looks like when the list shrinks to one
    /// — walking up from anywhere lands on the only row.
    #[test]
    fn a_stale_cursor_walks_back_onto_the_list() {
        let mut pick = DevicePick {
            devices: vec![device("A", "aa", true)],
            cursor: 3,
            scanning: false,
            message: String::new(),
            scroll: 0,
        };
        // The app clamps on the way in; this is the invariant it relies on —
        // that up from any position reaches the top and stops.
        pick.move_cursor(false);
        pick.move_cursor(false);
        pick.move_cursor(false);
        pick.move_cursor(false);
        assert_eq!(pick.cursor, 0, "up stops at the top of one row");
        assert!(pick.selected().is_some());
    }
}
