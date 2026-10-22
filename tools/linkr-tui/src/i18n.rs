//! Every user-visible string, in both languages, in one table.
//!
//! Views never hold a literal: they call [`Lang::strings`] and read a field.
//! The two tables are `const`, so a missing translation is a compile error
//! rather than a blank row at runtime — the failure mode the old string
//! scattering produced.

use crate::event::{ConnectionState, View};

/// The interface language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    Zh,
    En,
}

/// One language's whole vocabulary.
#[derive(Debug, Clone, Copy)]
pub struct Strings {
    // --- technical tokens -------------------------------------------------
    // Deliberately untranslated: the design writes `RX`, `TX`, `Auto` and
    // `dBm` in the Chinese interface too, and keeping them Latin is what keeps
    // the top bar the same width whichever language is in force.
    /// Prefix of the receive counter (`RX`).
    pub rx: &'static str,
    /// Prefix of the transmit counter (`TX`).
    pub tx: &'static str,
    /// The auto-scroll indicator.
    pub autoscroll: &'static str,
    /// The unit of the signal reading beside the state (`dBm`).
    pub signal_unit: &'static str,
    /// What a slot shows before the device has reported a value.
    ///
    /// One glyph for every such slot, as the design has it: the rule spans its
    /// cell, so an unknown speed and an unknown signal read as the same
    /// absence rather than as two different kinds of dash.
    pub value_unknown: &'static str,
    /// The colon and its spacing after a field label.
    ///
    /// Chinese uses the full-width colon, which carries its own space; English
    /// needs an explicit one. Keeping both in the table is what lets the two
    /// rows be laid out by the same code.
    pub label_separator: &'static str,

    // --- sidebar ---------------------------------------------------------
    /// Section header for the connection block.
    pub section_connection: &'static str,
    /// Section header for the view list.
    pub section_views: &'static str,
    /// Section header for the quick-send list.
    pub section_quick_send: &'static str,
    /// Section header for the watch findings.
    pub section_watch: &'static str,
    /// `Transport: <name>` prefix.
    pub transport_label: &'static str,
    /// `Enter mode: <mode>` — the palette's cycle, announced.
    pub enter_mode_label: &'static str,
    /// `Debug I/O: <on|off>` — the trace switch, announced.
    pub debug_io_label: &'static str,
    /// `Device: <name>` prefix.
    pub device_label: &'static str,
    /// `LAN host: <address>` — the row a LAN dial is built from.
    pub lan_host_label: &'static str,
    /// `LAN token: ******` — that one is in hand, never which.
    pub lan_token_label: &'static str,
    /// Whether the live LAN link presented a token.
    pub lan_token_yes: &'static str,
    /// The same, when it did not.
    pub lan_token_no: &'static str,
    /// The token row when the bridge says its LAN door has no key.
    pub lan_token_off: &'static str,
    /// The connect action.
    pub connect: &'static str,
    /// The same row once a link is up: pressing it hangs up. One row, two
    /// words, is how the web client does it — a row that always says `Connect`
    /// leaves nothing to press once the link is live.
    pub disconnect: &'static str,
    /// The switch-device action.
    pub switch_device: &'static str,
    /// Suffix on the transport row when a CLI flag pinned it.
    pub transport_locked: &'static str,
    /// The `◂▸` marker on the transport row: Enter flips it between the two
    /// links a session can be carried over.
    pub transport_switch_hint: &'static str,
    /// Hint under the quick-send header.
    pub quick_send_hint: &'static str,
    /// Shown in the watch section when nothing has been found.
    pub watch_empty: &'static str,

    // --- bottom bar ------------------------------------------------------
    /// The focus tag's word for the terminal pane.
    pub focus_terminal: &'static str,
    /// The focus tag's word for the sidebar.
    pub focus_sidebar: &'static str,
    /// The focus tag's word for the docked assistant panel.
    pub focus_assistant: &'static str,
    /// What the keyboard is typing into while the terminal has it.
    pub term_input: &'static str,
    /// The palette hint.
    pub hint_palette: &'static str,
    /// The help hint.
    pub hint_help: &'static str,
    /// The view-rota hint.
    pub hint_views: &'static str,
    /// The quit hint.
    pub hint_quit: &'static str,
    /// The one-shot modifier latch: what arming announces, what cancelling
    /// says, and the chip the bottom bar carries while one is armed.
    pub latch_armed: &'static str,
    pub latch_disarmed: &'static str,
    pub latch_pending: &'static str,

    // --- what the wire did ------------------------------------------------
    /// The bottom bar's marker for bytes the pane could not read as UTF-8.
    /// The count follows it in the bar (`乱码 41B`), so the label stays short.
    pub decode_loss: &'static str,
    /// The one-time notice that explains those bytes; `{}` is the count.
    ///
    /// It names both things that produce them — a device speaking something
    /// that is not UTF-8, and a serial link whose framing does not match the
    /// device's — because either one is the user's to check and neither is
    /// visible from the pane the user is looking at.
    pub decode_loss_notice: &'static str,

    // --- views -----------------------------------------------------------
    /// Title of the serial terminal view.
    pub view_terminal: &'static str,
    /// Title of the diagnostics view.
    pub view_diagnostics: &'static str,
    /// Title of the network view.
    pub view_network: &'static str,
    /// Title of the assistant view.
    pub view_assistant: &'static str,
    /// Placeholder in a view whose body has no content yet.
    pub view_empty: &'static str,
    /// The empty terminal's title: no board is connected and the pane has
    /// nothing to show.
    pub term_empty_title: &'static str,
    /// The empty terminal's guidance: where a connection is started from.
    pub term_empty_hint: &'static str,
    /// The splash's line under the mark: what this program is.
    pub splash_label: &'static str,
    /// The name the startup-splash switch is announced under.
    pub splash_setting: &'static str,
    /// The splash's way out: any key.
    pub splash_hint: &'static str,

    // --- diagnostics view -------------------------------------------------
    /// Prefix of the "last read" stamp (`@i? · updated 19:08:06`).
    pub diag_updated: &'static str,
    /// Shown before diagnostics have ever been read.
    pub diag_not_read: &'static str,
    /// Why there is nothing to read: management commands are BLE-only.
    pub diag_no_ble: &'static str,
    /// Shown while `@i?` is in flight.
    pub diag_loading: &'static str,
    /// Shown when a read completed and reported nothing.
    pub diag_empty: &'static str,
    /// The keys this view answers to.
    pub diag_keys_hint: &'static str,
    /// The local failure when the link closed before a reply arrived.
    pub diag_poll_closed: &'static str,
    /// Grid label for the firmware version.
    pub diag_label_firmware: &'static str,
    /// Grid label for the device's uptime.
    pub diag_label_uptime: &'static str,
    /// Grid label for who may use the BLE link.
    pub diag_label_ble_access: &'static str,
    /// Grid label for the UART ring buffer.
    pub diag_label_uart_buffer: &'static str,
    /// Grid label for the upload queue.
    pub diag_label_upload_queue: &'static str,
    /// `sys.owner` is `0`: the link is open to anyone.
    pub diag_access_open: &'static str,
    /// `sys.owner` is someone else: access is scoped to one host.
    pub diag_access_scoped: &'static str,
    /// Prefix of the link security level (`link L2`).
    pub diag_link_level: &'static str,

    // --- network view -----------------------------------------------------
    /// The WiFi section heading.
    pub net_wifi_section: &'static str,
    /// Why BLE is needed to manage the bridge's own network settings.
    pub net_wifi_needs_ble: &'static str,
    /// The network-name (SSID) field label.
    pub net_ssid_label: &'static str,
    /// The password field label.
    pub net_password_label: &'static str,
    /// The value an empty field shows.
    pub net_empty_value: &'static str,
    /// Suffix marking an action as BLE-only (`（仅限 BLE）`).
    pub net_ble_only: &'static str,
    /// The scan action.
    pub net_scan: &'static str,
    /// The connect action.
    pub net_connect: &'static str,
    /// The WiFi-off action.
    pub net_wifi_off: &'static str,
    /// The status action.
    pub net_status: &'static str,
    /// The scan-results section heading.
    pub net_results_section: &'static str,
    /// Shown when a scan failed after the bridge had accepted it.
    pub net_scan_failed: &'static str,
    /// Shown when the bridge reported a failed WiFi operation, with the
    /// firmware's own result code.
    pub net_wifi_failed: &'static str,
    /// Shown when a scan has produced nothing.
    pub net_no_results: &'static str,
    /// The WebDAV section heading.
    pub net_webdav_section: &'static str,
    /// The WebDAV upload-URL field label.
    pub net_url_label: &'static str,
    /// The WebDAV-enable action.
    pub net_set: &'static str,
    /// The WebDAV-disable action.
    pub net_disable: &'static str,
    /// The advertised BLE-name section heading.
    pub net_ble_name_section: &'static str,
    /// The current advertised name field label.
    pub net_ble_name_label: &'static str,
    /// The rename action.
    pub net_ble_name_rename: &'static str,
    /// The restore-default action.
    pub net_ble_name_default_action: &'static str,
    /// The read-name action.
    pub net_ble_name_status_action: &'static str,
    /// The byte and character rules under the name field.
    pub net_ble_name_hint: &'static str,
    /// Shown when the local name check refuses a value.
    pub net_ble_name_invalid: &'static str,
    /// The note marking a custom name.
    pub net_ble_name_custom: &'static str,
    /// The note marking the MAC-derived name.
    pub net_ble_name_default: &'static str,
    /// The WebDAV status action.
    pub net_webdav_status: &'static str,
    /// Refusing to enable WebDAV without a URL.
    pub net_no_url: &'static str,
    /// The on/off state words.
    pub net_state_on: &'static str,
    pub net_state_off: &'static str,
    /// The keys the network view answers, so a form that looks like a form
    /// says how it is driven.
    pub net_keys_hint: &'static str,
    /// What agreeing to a network change means, on the approval card.
    pub net_confirm_detail: &'static str,
    /// Refusing to join a network nobody named.
    pub net_no_ssid: &'static str,
    /// Shown when a join never reached an ending: the state it last reported
    /// is the argument, and "not yet" is the point of the sentence.
    pub net_wifi_pending: &'static str,
    /// The same, for a forget that never reached "off".
    pub net_wifi_off_pending: &'static str,
    /// A command that is not one the bridge takes, which is a bug in the caller
    /// rather than something the user did.
    pub net_bad_command: &'static str,
    /// What the diagnostics and network surfaces say when the bridge was asked
    /// something and never answered it.
    ///
    /// Not "failed": a question that timed out may have been understood and
    /// acted on slowly. The wording has to leave that open, because whether to
    /// press the button again depends on it.
    pub mgmt_no_answer: &'static str,

    // --- assistant view ---------------------------------------------------
    /// The session section heading.
    pub asst_session_section: &'static str,
    /// The tasks section heading.
    pub asst_tasks_section: &'static str,
    /// Shown when no task has been recorded for this device.
    pub asst_no_tasks: &'static str,
    /// Shown when the agent is not configured.
    pub asst_not_configured: &'static str,
    /// The notes section heading.
    pub asst_notes_section: &'static str,
    /// Shown when the device has no durable notes.
    pub asst_no_notes: &'static str,
    /// Shown when a note is longer than the store keeps. Takes the limit.
    pub asst_note_too_long: &'static str,
    /// Shown when a note is nothing but secrets, so nothing would be kept.
    pub asst_note_empty: &'static str,
    /// Shown when the target has no identity to file a note under.
    pub asst_note_no_identity: &'static str,
    /// The execution-mode row label.
    pub asst_mode_label: &'static str,
    /// The three mode names.
    pub asst_mode_auto: &'static str,
    pub asst_mode_manual: &'static str,
    pub asst_mode_full_auto: &'static str,
    /// What the status line says when the unattended window elapses.
    pub asst_full_auto_expired: &'static str,
    pub asst_device_changed: &'static str,
    /// The token-usage row label.
    pub asst_usage_label: &'static str,
    /// The conversation row label: which thread, of how many.
    pub asst_chat_label: &'static str,
    /// The docked panel's key hint, under the composer.
    pub asst_panel_keys: &'static str,
    /// Shown when the window has no room for the docked panel.
    pub asst_panel_narrow: &'static str,
    /// The pending-approval row.
    pub asst_awaiting: &'static str,
    /// A request that never reached the model, with the transport's own why.
    ///
    /// An assistant that does nothing is the hardest thing to diagnose, so
    /// the reason a request failed is a sentence in the interface's own
    /// language rather than an English line from a library the user did not
    /// choose.
    pub asst_unreachable: &'static str,
    /// A provider that answered and refused, with its status and its words.
    pub asst_rejected: &'static str,
    /// Stands in for the words of a refusal whose body was empty — the shape a
    /// 404 from a mistyped endpoint arrives in. A refusal with nothing to read
    /// is the one a user cannot act on.
    pub asst_rejected_blank: &'static str,
    /// A 200 whose body carried no completion at all.
    pub asst_malformed: &'static str,

    // --- notices ---------------------------------------------------------
    /// "Theme: light" and friends — the toast shown by the toggle.
    pub theme_switched_prefix: &'static str,
    /// The word for the dark theme in a notice.
    pub theme_dark: &'static str,
    /// The word for the light theme in a notice.
    pub theme_light: &'static str,
    /// The word for the Nord theme in a notice. A palette's name is its own,
    /// so these are the spelling in both languages.
    pub theme_nord: &'static str,
    /// The word for the Gruvbox theme in a notice.
    pub theme_gruvbox: &'static str,
    /// The word for the Solarized theme in a notice.
    pub theme_solarized: &'static str,
    /// The word for the Dracula theme in a notice.
    pub theme_dracula: &'static str,
    /// "Sidebar shown" — the toast for the rail toggle.
    pub sidebar_shown: &'static str,
    /// "Sidebar hidden" — the same toggle, the other way.
    pub sidebar_hidden: &'static str,
    /// The head of the copy confirmation: "Copied 1234 chars".
    pub copy_done_prefix: &'static str,
    /// The tail of the copy confirmation.
    pub copy_done_suffix: &'static str,
    /// The composer field label in the assistant view.
    pub agent_field_composer: &'static str,
    /// The endpoint field label.
    pub agent_field_endpoint: &'static str,
    /// The model field label.
    pub agent_field_model: &'static str,
    /// The API key field label.
    pub agent_field_key: &'static str,
    /// The extra headers field label.
    pub agent_field_headers: &'static str,
    /// The protocol (provider) field label.
    pub agent_field_protocol: &'static str,
    /// The reasoning-level field label.
    pub agent_field_reasoning: &'static str,
    /// The context-window field label.
    pub agent_field_context_window: &'static str,
    /// The output-ceiling field label.
    pub agent_field_max_tokens: &'static str,
    /// The word for a reasoning level, one per `AGENT_REASONING_LEVELS`.
    pub agent_reasoning_off: &'static str,
    pub agent_reasoning_low: &'static str,
    pub agent_reasoning_medium: &'static str,
    pub agent_reasoning_high: &'static str,
    /// The warning under a context window too small for the request itself.
    /// Two `{}`: what the fixed part costs, and the smallest window that works.
    pub agent_window_tight: &'static str,
    /// The note field label.
    pub agent_field_note: &'static str,
    /// The conversation section heading.
    pub agent_thread_section: &'static str,
    /// Notice when the system clipboard could not be read.
    pub clipboard_empty: &'static str,
    /// Notice when a Bluetooth scan could not start.
    pub ble_scan_failed: &'static str,
    /// Said when the user tries to switch device while connected.
    pub switch_needs_disconnect: &'static str,
    /// Prefix of the notice naming how much was pasted.
    pub clipboard_pasted: &'static str,
    /// Who the user's own turns are labelled.
    pub agent_who_user: &'static str,
    /// Who the model's turns are labelled.
    pub agent_who_model: &'static str,
    /// The notice when a model is not configured and a prompt cannot be sent.
    pub agent_needs_endpoint: &'static str,
    /// The notice when a settings save was refused, naming the field after it.
    pub agent_setting_invalid: &'static str,
    /// The composer section heading.
    pub agent_composer_section: &'static str,
    /// The model settings section heading.
    pub agent_settings_section: &'static str,
    /// The word for an execution mode, in the assistant's own vocabulary.
    pub agent_mode_auto: &'static str,
    pub agent_mode_full: &'static str,
    pub agent_mode_manual: &'static str,
    /// The notice when a fresh conversation was started.
    pub agent_new_chat: &'static str,
    /// Prefix of the notice naming the conversation the panel moved to.
    pub agent_chat_switched: &'static str,
    /// The notice when the open conversation was forgotten.
    pub agent_chat_deleted: &'static str,
    /// The word for a finding awaiting review.
    pub pending_review: &'static str,

    // --- the link ---------------------------------------------------------
    /// Prefix of the notice raised when a link comes up.
    pub link_opened: &'static str,
    /// Prefix of the notice raised when a link ends.
    pub link_closed: &'static str,
    /// Prefix of the notice raised when a dial fails.
    pub link_failed: &'static str,
    /// Shown when something was to be sent and there was no link to send it
    /// over. A silent drop reads as success, which for `reboot` is the worst
    /// possible lie.
    pub not_connected: &'static str,

    // --- the switches ------------------------------------------------------
    /// Prefix of the notice raised when the interface language changes.
    pub language_switched_prefix: &'static str,
    /// The word for Chinese in that notice. Written in its own language, the
    /// way a language picker names a language.
    pub language_zh: &'static str,
    /// The word for English in that notice.
    pub language_en: &'static str,
    /// Shown when the transport cannot be switched because the command line
    /// pinned it.
    pub transport_is_locked: &'static str,
    /// Shown when there is nothing to dial — no bridge, no port.
    pub no_link: &'static str,
    /// Shown when a LAN dial has no address to go to.
    pub lan_needs_host: &'static str,
    /// Shown when a dial is already in flight: one at a time.
    pub dialing: &'static str,
    /// Shown when `switch device` has nothing to switch to: one device is
    /// known, so the action is a no-op that says so rather than doing nothing.
    pub no_other_device: &'static str,
}

const ZH: Strings = Strings {
    rx: "RX",
    tx: "TX",
    autoscroll: "Auto",
    signal_unit: "dBm",
    value_unknown: "─",
    label_separator: "：",
    section_connection: "连接",
    section_views: "视图",
    section_quick_send: "快捷发送",
    section_watch: "监控",
    transport_label: "传输方式",
    enter_mode_label: "回车模式",
    debug_io_label: "调试 I/O",
    device_label: "设备",
    lan_host_label: "局域网主机",
    lan_token_label: "局域网令牌",
    lan_token_yes: "有密钥",
    lan_token_no: "无密钥",
    lan_token_off: "已关闭",
    connect: "连接",
    disconnect: "断开连接",
    switch_device: "切换设备",
    transport_locked: "（已锁定）",
    transport_switch_hint: "◂▸",
    quick_send_hint: "Enter 发送 · reboot 先确认",
    watch_empty: "暂无发现",
    focus_terminal: "终端",
    focus_sidebar: "侧栏",
    focus_assistant: "助手",
    term_input: "输入",
    hint_palette: "Ctrl+P 面板",
    hint_help: "F1 帮助",
    hint_views: "F2-F5 视图",
    hint_quit: "Ctrl+Q 退出",
    latch_armed: "{} 已武装：下一次按键会带上它",
    latch_disarmed: "{} 已取消武装",
    latch_pending: "待发",
    decode_loss: "乱码",
    decode_loss_notice: "串口收到 {} 字节不是有效 UTF-8 文本：终端里显示为 �（旧控制台上是 ?）。请检查设备的串口参数（--query-uart 查看、--uart 设置），或确认设备没有用 GBK 等非 UTF-8 编码。",
    view_terminal: "串口终端",
    view_diagnostics: "诊断",
    view_network: "网络",
    view_assistant: "助手",
    view_empty: "此视图尚未实现",
    term_empty_title: "还没有连接设备",
    term_empty_hint: "在侧栏「连接」扫描附近的 Linkr Bee",
    splash_label: "Linkr Bee 串口控制台",
    splash_setting: "启动闪屏",
    splash_hint: "按任意键跳过",
    diag_updated: "@i? · 已更新",
    diag_not_read: "@i? 尚未读取",
    diag_no_ble: "通过 BLE 连接后才能读取诊断（管理命令仅限 BLE）。",
    diag_loading: "正在读取 @i?…",
    diag_empty: "暂无设备信息。",
    diag_keys_hint: "r 刷新 · PgUp/PgDn 滚动 · F2 终端",
    diag_poll_closed: "诊断数据到达前连接已断开",
    diag_label_firmware: "固件",
    diag_label_uptime: "运行时间",
    diag_label_ble_access: "BLE 访问",
    diag_label_uart_buffer: "UART 缓冲",
    diag_label_upload_queue: "上传队列",
    diag_access_open: "开放",
    diag_access_scoped: "受限",
    diag_link_level: "链路 L",
    theme_switched_prefix: "主题",
    theme_dark: "深色",
    theme_light: "浅色",
    theme_nord: "Nord",
    theme_gruvbox: "Gruvbox",
    theme_solarized: "Solarized",
    theme_dracula: "Dracula",
    sidebar_shown: "侧栏已显示",
    sidebar_hidden: "侧栏已隐藏",
    copy_done_prefix: "已复制",
    copy_done_suffix: "字符",
    agent_field_composer: "提问",
    agent_field_endpoint: "接口地址",
    agent_field_model: "模型",
    agent_field_key: "密钥",
    agent_field_headers: "自定义头",
    agent_field_protocol: "接口协议",
    agent_field_reasoning: "推理强度",
    agent_field_context_window: "上下文窗口",
    agent_field_max_tokens: "输出上限",
    agent_reasoning_off: "关闭",
    agent_reasoning_low: "低",
    agent_reasoning_medium: "中",
    agent_reasoning_high: "高",
    agent_window_tight: "窗口偏小：提示词约占 {} token，加上输出至少需要 {}，当前设置下每问都可能超窗",
    agent_field_note: "记一条",
    agent_thread_section: "对话",
    clipboard_empty: "读不到剪贴板",
    ble_scan_failed: "无法开始搜索设备",
    switch_needs_disconnect: "请先断开连接，再切换设备",
    clipboard_pasted: "已粘贴",
    agent_who_user: "你",
    agent_who_model: "模型",
    agent_needs_endpoint: "先填接口地址和模型",
    agent_setting_invalid: "这一项没填对",
    agent_composer_section: "提问",
    agent_settings_section: "模型设置",
    agent_mode_auto: "自动",
    agent_mode_full: "全自动",
    agent_mode_manual: "手动",
    agent_new_chat: "已新建对话",
    agent_chat_switched: "已切换对话",
    agent_chat_deleted: "对话已删除",
    pending_review: "待确认",
    net_wifi_section: "WiFi",
    net_wifi_needs_ble: "通过 BLE 连接后才能管理 WiFi 与 WebDAV（局域网传输方式没有管理通道）。",
    net_ssid_label: "网络名称",
    net_password_label: "密码",
    net_empty_value: "—",
    net_ble_only: "（仅限 BLE）",
    net_scan: "[扫描]",
    net_connect: "[连接 WiFi]",
    net_wifi_off: "[WiFi 关闭]",
    net_status: "[WiFi 状态]",
    net_results_section: "扫描结果",
    net_scan_failed: "扫描失败",
    net_wifi_failed: "WiFi 配网失败（result {}）。请检查密码与 2.4 GHz 信号后重试。",
    net_no_results: "暂无结果",
    net_webdav_section: "WebDAV 日志上传",
    net_url_label: "上传地址",
    net_set: "[设置 WebDAV]",
    net_disable: "[关闭 WebDAV]",
    net_ble_name_section: "BLE 广播名",
    net_ble_name_label: "当前名称",
    net_ble_name_rename: "[修改名称]",
    net_ble_name_default_action: "[恢复默认]",
    net_ble_name_status_action: "[读取名称]",
    net_ble_name_hint: "1–29 个 UTF-8 字节，支持中文和 emoji",
    net_ble_name_invalid: "名称需为 1–29 个 UTF-8 字节，且不能包含控制字符",
    net_ble_name_custom: "自定义",
    net_ble_name_default: "MAC 默认",
    net_webdav_status: "[WebDAV 状态]",
    net_no_url: "先输入 WebDAV 上传地址",
    net_state_on: "开启",
    net_state_off: "关闭",
    net_keys_hint: "↑↓ 选择 · Enter 执行 · 结果行=填名",
    net_confirm_detail: "该配置会写入设备，重启后仍然生效",
    net_no_ssid: "先输入网络名称",
    net_wifi_pending: "板子还没连上（当前 wifi={}）；稍后用 --query-wifi 回读确认",
    net_wifi_off_pending: "板子还没断开（当前 wifi={}）；稍后用 --query-wifi 回读确认",
    net_bad_command: "不是桥接能识别的命令",
    mgmt_no_answer: "桥接没有应答：它可能正忙，请稍后重试",
    asst_session_section: "会话",
    asst_tasks_section: "任务",
    asst_no_tasks: "此设备暂无任务记录。",
    asst_not_configured: "未配置模型端点（Ctrl+P 打开面板设置）。",
    asst_notes_section: "设备笔记",
    asst_no_notes: "暂无笔记。",
    asst_note_too_long: "笔记最多 {} 个字符。",
    asst_note_empty: "笔记在去掉密钥后是空的，没有可保存的内容。",
    asst_note_no_identity: "该目标还没有身份，笔记无法保存（先连接一次）。",
    asst_mode_label: "执行模式",
    asst_mode_auto: "自动（仅白名单命令免确认）",
    asst_mode_manual: "手动（每次都确认）",
    asst_mode_full_auto: "全自动（危险命令仍确认）",
    asst_full_auto_expired: "Full Auto 已到时并回退到 Auto，后续命令需要确认。",
    asst_device_changed: "设备已切换，之前的回复未完成。",
    asst_usage_label: "Token 用量",
    asst_chat_label: "对话",
    asst_panel_keys: "Ctrl+N 新对话 · Alt+↑↓ 切换",
    asst_panel_narrow: "窗口太窄放不下助手：Ctrl+B 收侧栏，或 F5 整屏查看",
    asst_awaiting: "等待确认",
    asst_unreachable: "模型没有应答：{}",
    asst_rejected: "服务商拒绝（HTTP {}）：{}",
    asst_rejected_blank: "（服务商没有说明原因，请检查接口地址）",
    asst_malformed: "服务商返回了正文，但里面没有回答",
    link_opened: "链路已建立：",
    link_closed: "链路已断开：",
    link_failed: "连接失败：",
    not_connected: "未连接——没有发送任何内容。",
    language_switched_prefix: "界面语言",
    language_zh: "中文",
    language_en: "English",
    transport_is_locked: "传输方式已被锁定，无法切换。",
    no_link: "没有配置链路——无目标可连接。",
    lan_needs_host: "请先填写局域网主机（板子的 WiFi IP）。",
    dialing: "连接中…",
    no_other_device: "没有其他设备可切换。",
};

const EN: Strings = Strings {
    rx: "RX",
    tx: "TX",
    autoscroll: "Auto",
    signal_unit: "dBm",
    value_unknown: "─",
    label_separator: ": ",
    section_connection: "Connection",
    section_views: "Views",
    section_quick_send: "Quick send",
    section_watch: "Watch",
    transport_label: "Transport",
    enter_mode_label: "Enter mode",
    debug_io_label: "Debug I/O",
    device_label: "Device",
    lan_host_label: "LAN host",
    lan_token_label: "LAN token",
    lan_token_yes: "token",
    lan_token_no: "no token",
    lan_token_off: "auth off",
    connect: "Connect",
    disconnect: "Disconnect",
    switch_device: "Switch device",
    transport_locked: "(locked)",
    transport_switch_hint: "◂▸",
    // Fits the 29-column sidebar with three columns to spare. The longer
    // `Enter sends · reboot asks first` overflowed the column and wrapped onto a
    // second row, which pushed every section below it one row down — the
    // sidebar then sat differently in English than in Chinese.
    quick_send_hint: "Enter sends · reboot asks",
    watch_empty: "no findings yet",
    focus_terminal: "Terminal",
    focus_sidebar: "Sidebar",
    focus_assistant: "Assistant",
    term_input: "typing",
    hint_palette: "Ctrl+P palette",
    hint_help: "F1 help",
    hint_views: "F2-F5 views",
    hint_quit: "Ctrl+Q quit",
    latch_armed: "{} armed — the next key carries it",
    latch_disarmed: "{} disarmed",
    latch_pending: "armed",
    decode_loss: "garbled",
    decode_loss_notice: "{} bytes from the serial link are not valid UTF-8: the pane shows � (? on the old console). Check the device's serial parameters (--query-uart reads them, --uart sets them), or whether it speaks GBK rather than UTF-8.",
    view_terminal: "Serial Terminal",
    view_diagnostics: "Diagnostics",
    view_network: "Network",
    view_assistant: "Assistant",
    view_empty: "This view is not implemented yet",
    term_empty_title: "No board connected",
    term_empty_hint: "Connect from the sidebar to scan for a Linkr Bee",
    splash_label: "Linkr Bee serial console",
    splash_setting: "Startup splash",
    splash_hint: "Press any key to skip",
    diag_updated: "@i? · updated",
    diag_not_read: "@i? not read yet",
    diag_no_ble: "Connect over BLE to read diagnostics (management commands are BLE-only).",
    diag_loading: "reading @i?…",
    diag_empty: "No device information yet.",
    diag_keys_hint: "r refresh · PgUp/PgDn scroll · F2 terminal",
    diag_poll_closed: "disconnected before diagnostics arrived",
    diag_label_firmware: "Firmware",
    diag_label_uptime: "Uptime",
    diag_label_ble_access: "BLE access",
    diag_label_uart_buffer: "UART Buffer",
    diag_label_upload_queue: "Upload Queue",
    diag_access_open: "open",
    diag_access_scoped: "scoped",
    diag_link_level: "link L",
    theme_switched_prefix: "Theme",
    theme_dark: "dark",
    theme_light: "light",
    theme_nord: "Nord",
    theme_gruvbox: "Gruvbox",
    theme_solarized: "Solarized",
    theme_dracula: "Dracula",
    sidebar_shown: "Sidebar shown",
    sidebar_hidden: "Sidebar hidden",
    copy_done_prefix: "Copied",
    copy_done_suffix: "chars",
    agent_field_composer: "ask",
    agent_field_endpoint: "endpoint",
    agent_field_model: "model",
    agent_field_key: "key",
    agent_field_headers: "headers",
    agent_field_protocol: "protocol",
    agent_field_reasoning: "reasoning",
    agent_field_context_window: "context window",
    agent_field_max_tokens: "max output",
    agent_reasoning_off: "off",
    agent_reasoning_low: "low",
    agent_reasoning_medium: "medium",
    agent_reasoning_high: "high",
    agent_window_tight: "the window is small: the prompt costs about {} tokens and the answer needs {} more, so questions may overrun it",
    agent_field_note: "note",
    agent_thread_section: "conversation",
    clipboard_empty: "the clipboard could not be read",
    ble_scan_failed: "the scan could not start",
    switch_needs_disconnect: "Disconnect first, then switch device",
    clipboard_pasted: "Pasted",
    agent_who_user: "you",
    agent_who_model: "model",
    agent_needs_endpoint: "set the endpoint and model first",
    agent_setting_invalid: "that setting is not acceptable",
    agent_composer_section: "ask",
    // A section heading, and a word that also appears in the "no endpoint"
    // notice — so it is spelled out rather than left as "model", which would
    // make the view and the window indistinguishable to anything looking for
    // the heading by name.
    agent_settings_section: "Model settings",
    agent_mode_auto: "auto",
    agent_mode_full: "full auto",
    agent_mode_manual: "manual",
    agent_new_chat: "Started a new conversation",
    agent_chat_switched: "Conversation",
    agent_chat_deleted: "Conversation deleted",
    pending_review: "asks first",
    net_wifi_section: "WiFi",
    net_wifi_needs_ble:
        "Connect over BLE to manage WiFi and WebDAV (the LAN transport has no management channel).",
    net_ssid_label: "Network name",
    net_password_label: "Password",
    net_empty_value: "—",
    net_ble_only: " (BLE only)",
    net_scan: "[Scan]",
    net_connect: "[Connect WiFi]",
    net_wifi_off: "[WiFi off]",
    net_status: "[WiFi status]",
    net_results_section: "Scan results",
    net_scan_failed: "the scan failed",
    net_wifi_failed:
        "WiFi provisioning failed (result {}). Check the password and 2.4 GHz coverage, then retry.",
    net_no_results: "no results yet",
    net_webdav_section: "WebDAV log upload",
    net_url_label: "Upload URL",
    net_set: "[Set WebDAV]",
    net_disable: "[WebDAV off]",
    net_ble_name_section: "BLE advertised name",
    net_ble_name_label: "Current name",
    net_ble_name_rename: "[Rename]",
    net_ble_name_default_action: "[Restore default]",
    net_ble_name_status_action: "[Read name]",
    net_ble_name_hint: "1-29 UTF-8 bytes; Chinese and emoji are allowed",
    net_ble_name_invalid: "the name must be 1-29 UTF-8 bytes without control characters",
    net_ble_name_custom: "custom",
    net_ble_name_default: "MAC default",
    net_webdav_status: "[WebDAV status]",
    net_no_url: "enter a WebDAV upload URL first",
    net_state_on: "on",
    net_state_off: "off",
    net_keys_hint: "up/down choose · Enter run · a result fills the name",
    net_confirm_detail: "This is written to the device and survives a reboot",
    net_no_ssid: "name the network first",
    net_wifi_pending: "the board has not joined yet (wifi={}); read it back with --query-wifi",
    net_wifi_off_pending: "the board is not off yet (wifi={}); read it back with --query-wifi",
    net_bad_command: "not a command the bridge understands",
    mgmt_no_answer: "the bridge did not answer — it may be busy, try again",
    asst_session_section: "Session",
    asst_tasks_section: "Tasks",
    asst_no_tasks: "No tasks recorded for this device.",
    asst_not_configured: "No model endpoint configured (Ctrl+P opens the palette).",
    asst_notes_section: "Device notes",
    asst_no_notes: "no notes",
    asst_note_too_long: "A note is limited to {} characters.",
    asst_note_empty: "The note is nothing but secrets once they are taken out.",
    asst_note_no_identity: "This target has no identity yet, so a note cannot be stored (connect once).",
    asst_mode_label: "Execution mode",
    asst_mode_auto: "auto (only allowlisted commands run unattended)",
    asst_mode_manual: "manual (every send is confirmed)",
    asst_mode_full_auto: "full auto (destructive commands still ask)",
    asst_full_auto_expired:
        "Full Auto reached its time limit and reverted to Auto; later commands need approval.",
    asst_device_changed: "The device changed before the reply finished.",
    asst_usage_label: "Token usage",
    asst_chat_label: "Conversation",
    asst_panel_keys: "Ctrl+N new · Alt+↑↓ switch",
    asst_panel_narrow: "No room for the assistant panel — Ctrl+B hides the rail, F5 opens it full width",
    asst_awaiting: "awaiting approval",
    asst_unreachable: "the model did not answer: {}",
    asst_rejected: "the provider refused (HTTP {}): {}",
    asst_rejected_blank: "(the provider gave no reason — check the endpoint URL)",
    asst_malformed: "the provider answered, but its body held no reply",
    link_opened: "link open: ",
    link_closed: "link closed: ",
    link_failed: "connect failed: ",
    not_connected: "Not connected — nothing was sent.",
    language_switched_prefix: "Interface language",
    language_zh: "中文",
    language_en: "English",
    transport_is_locked: "The transport is pinned and cannot be switched.",
    no_link: "No link configured — nothing to dial.",
    lan_needs_host: "Enter the bridge's LAN address first (the board's WiFi IP).",
    dialing: "connecting…",
    no_other_device: "No other device to switch to yet.",
};

/// A bilingual interface string: `[English, Chinese]`.
///
/// The flat [`Strings`] table is for the vocabulary the whole interface shares —
/// labels, placeholders, the words in the bars. Text that belongs to exactly one
/// module (every palette action, every dialog) is kept *with* that module as a
/// list of these, so a module's words are readable next to the code that paints
/// them, and the two halves can never be edited apart.
pub type Entry = [&'static str; 2];

/// The text of an entry in `lang`.
pub const fn entry(text: Entry, lang: Lang) -> &'static str {
    match lang {
        Lang::En => text[0],
        Lang::Zh => text[1],
    }
}

/// Assert a table is complete: both halves carry text, and they differ — a
/// copied English string is a missing translation, not a translation.
///
/// The `pub` is for the sibling modules' tests; the assert is the same guard
/// the flat table has, applied to the per-module tables.
pub fn assert_bilingual(entries: &[Entry]) {
    for [en, zh] in entries {
        assert!(!en.trim().is_empty(), "an english string is empty");
        assert!(!zh.trim().is_empty(), "a chinese string is empty");
        assert_ne!(en, zh, "{en:?} was never translated");
    }
}

/// Every word the execution modes need, in one place.
///
/// A `Strings` method rather than three fields consumed by callers, because the
/// three names travel together and a caller picking one with an `if` would be a
/// second translation of the same three modes.
impl Strings {
    /// The word for `mode`, in this language.
    pub fn execution_mode(&self, mode: crate::exec::executor::Mode) -> &'static str {
        use crate::exec::executor::Mode;
        match mode {
            Mode::Auto => self.agent_mode_auto,
            Mode::FullAuto => self.agent_mode_full,
            Mode::Manual => self.agent_mode_manual,
        }
    }
}

impl Lang {
    /// This language's table.
    pub fn strings(self) -> &'static Strings {
        match self {
            Lang::Zh => &ZH,
            Lang::En => &EN,
        }
    }

    /// The spelling a command line or a settings file uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Lang::Zh => "zh",
            Lang::En => "en",
        }
    }

    /// The language a name refers to. Unknown names give `None`, so a caller
    /// can report the bad value instead of silently switching language.
    pub fn from_name(name: &str) -> Option<Lang> {
        match name.trim().to_ascii_lowercase().as_str() {
            "zh" => Some(Lang::Zh),
            "en" => Some(Lang::En),
            _ => None,
        }
    }

    /// The name of a view in this language.
    pub fn view_name(self, view: View) -> &'static str {
        let s = self.strings();
        match view {
            View::Terminal => s.view_terminal,
            View::Diagnostics => s.view_diagnostics,
            View::Network => s.view_network,
            View::Assistant => s.view_assistant,
        }
    }

    /// The connection state as it reads in the top bar and the toast.
    pub fn state_name(self, state: ConnectionState) -> &'static str {
        match (self, state) {
            (Lang::Zh, ConnectionState::Disconnected) => "未连接",
            (Lang::Zh, ConnectionState::Connecting) => "连接中…",
            (Lang::Zh, ConnectionState::Connected) => "已连接",
            (Lang::Zh, ConnectionState::Failed) => "连接失败",
            (Lang::En, ConnectionState::Disconnected) => "disconnected",
            (Lang::En, ConnectionState::Connecting) => "connecting…",
            (Lang::En, ConnectionState::Connected) => "connected",
            (Lang::En, ConnectionState::Failed) => "connection failed",
        }
    }

    /// What a WiFi failure actually means, by the number the firmware gave it.
    ///
    /// The firmware answers in its C vocabulary, and it has two of them: a
    /// refusal of the command itself carries an `errno` — `-16` its
    /// one-operation gate being held, `-120` a radio that is already up, `-22`
    /// a name or key it will not take — while a join that was accepted and then
    /// failed reports the radio's own status, a small positive number where `2`
    /// is a bad password and `4` an access point nobody heard. A bare number in
    /// front of a user is not a thing anybody can act on, so both halves are
    /// worded here; a code with no words keeps the table's own sentence with
    /// the number in it, because a code nobody has words for is still the only
    /// clue there is.
    pub fn wifi_failure(self, code: i64) -> String {
        use crate::accessory::{
            WIFI_ALREADY, WIFI_BAD_ARGUMENT, WIFI_BUSY, WIFI_CONN_AP_NOT_FOUND, WIFI_CONN_FAIL,
            WIFI_CONN_TIMEOUT, WIFI_CONN_WRONG_PASSWORD, WIFI_NO_MEMORY, WIFI_NO_RADIO,
            WIFI_TIMEOUT, WIFI_UNREACHABLE,
        };
        let words = match (self, code) {
            (Lang::Zh, WIFI_BUSY) => {
                "板子正忙：另一个 WiFi 操作还没结束，等它结束再试一次。"
            }
            (Lang::En, WIFI_BUSY) => {
                "The board is busy: another WiFi operation has not finished. Try again once it does."
            }
            (Lang::Zh, WIFI_ALREADY) => {
                "板子已经有网络了，不用重复配网；要换网络，先在网络页做一次“关闭 WiFi”（@w off）再连。"
            }
            (Lang::En, WIFI_ALREADY) => {
                "The board already has a network — no need to configure it again; to switch, turn WiFi off first (network pane) and join again."
            }
            (Lang::Zh, WIFI_BAD_ARGUMENT) => {
                "网络名或密码不被接受：名称最多 32 字节，密码最多 64 字节。"
            }
            (Lang::En, WIFI_BAD_ARGUMENT) => {
                "The board would not take that name or key: an SSID is at most 32 bytes, a key at most 64."
            }
            (Lang::Zh, WIFI_CONN_WRONG_PASSWORD) => "密码不对：四步握手没过，注意大小写。",
            (Lang::En, WIFI_CONN_WRONG_PASSWORD) => {
                "Wrong password: the handshake did not go through. Mind the letter case."
            }
            (Lang::Zh, WIFI_CONN_AP_NOT_FOUND) => {
                "没找到这个网络：它得是 2.4 GHz 的、且在板子附近。"
            }
            (Lang::En, WIFI_CONN_AP_NOT_FOUND) => {
                "No network by that name: it has to be a 2.4 GHz one, and near the board."
            }
            (Lang::Zh, WIFI_TIMEOUT | WIFI_CONN_TIMEOUT) => {
                "连接超时：密码不对，或者这是 5 GHz、或信号太弱的 2.4 GHz 网络。"
            }
            (Lang::En, WIFI_TIMEOUT | WIFI_CONN_TIMEOUT) => {
                "The join timed out: the key is wrong, or this is a 5 GHz — or a too-weak 2.4 GHz — network."
            }
            (Lang::Zh, WIFI_UNREACHABLE) => {
                "网络不可达：板子连上了路由器，但网络没有把地址给出来（看看路由器的 DHCP）。"
            }
            (Lang::En, WIFI_UNREACHABLE) => {
                "The network is unreachable: the board joined the router but no address came back (check the router's DHCP)."
            }
            (Lang::Zh, WIFI_CONN_FAIL) => "连接失败：密码不对、信号太弱，或路由器拒绝了板子。",
            (Lang::En, WIFI_CONN_FAIL) => {
                "The join failed: a wrong key, a weak signal, or a router turning the board away."
            }
            (Lang::Zh, WIFI_NO_RADIO) => "板子的 WiFi 无线还没就绪，稍后重试。",
            (Lang::En, WIFI_NO_RADIO) => "The board's WiFi radio is not up yet; try again shortly.",
            (Lang::Zh, WIFI_NO_MEMORY) => "板子内存不足，稍后重试。",
            (Lang::En, WIFI_NO_MEMORY) => "The board is out of memory; try again shortly.",
            _ => return crate::text::fill(self.strings().net_wifi_failed, &[code.to_string()]),
        };
        words.to_string()
    }

    /// A `@w=` write the board refused because it was busy, and the pause
    /// before the interface asks again.
    pub fn wifi_busy_wait(self, seconds: u64) -> String {
        match self {
            // The number is a bound, not a promise: the retry also goes early
            // when the bridge says it has finished with the radio.
            Lang::Zh => {
                format!("板子正忙（另一个 WiFi 操作还没结束），最多 {seconds} 秒后自动重试…")
            }
            Lang::En => format!(
                "The board is busy with another WiFi operation; retrying within {seconds} s…"
            ),
        }
    }

    /// A question the board never answered, after the retries that were meant
    /// to outlast its being busy.
    ///
    /// The plain [`Self::mgmt_no_answer`] says "try again", which is the one
    /// thing the caller has just spent the retries doing; this says what was
    /// already tried, so the next step is not a repeat of this one.
    pub fn mgmt_no_answer_after_retries(self, tries: u32) -> String {
        match self {
            Lang::Zh => format!("桥接重试 {tries} 次仍没有应答：它一直很忙，请稍后再试"),
            Lang::En => format!(
                "the bridge did not answer through {tries} retries — it stayed busy, try again later"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both tables exist and every field is filled: an empty string is the
    /// blank-row failure this table exists to prevent.
    #[test]
    fn both_languages_are_complete() {
        for lang in [Lang::Zh, Lang::En] {
            let s = lang.strings();
            let all = [
                s.rx,
                s.tx,
                s.autoscroll,
                s.signal_unit,
                s.value_unknown,
                s.label_separator,
                s.section_connection,
                s.section_views,
                s.section_quick_send,
                s.section_watch,
                s.transport_label,
                s.device_label,
                s.lan_host_label,
                s.lan_token_label,
                s.lan_token_yes,
                s.lan_token_no,
                s.lan_token_off,
                s.connect,
                s.switch_device,
                s.transport_locked,
                s.transport_switch_hint,
                s.quick_send_hint,
                s.watch_empty,
                s.focus_terminal,
                s.focus_sidebar,
                s.focus_assistant,
                s.term_input,
                s.hint_palette,
                s.hint_help,
                s.hint_views,
                s.hint_quit,
                s.view_terminal,
                s.view_diagnostics,
                s.view_network,
                s.view_assistant,
                s.view_empty,
                s.term_empty_title,
                s.term_empty_hint,
                s.splash_label,
                s.splash_setting,
                s.splash_hint,
                s.diag_updated,
                s.diag_not_read,
                s.diag_no_ble,
                s.diag_loading,
                s.diag_empty,
                s.diag_keys_hint,
                s.diag_poll_closed,
                s.diag_label_firmware,
                s.diag_label_uptime,
                s.diag_label_ble_access,
                s.diag_label_uart_buffer,
                s.diag_label_upload_queue,
                s.diag_access_open,
                s.diag_access_scoped,
                s.diag_link_level,
                s.theme_switched_prefix,
                s.theme_dark,
                s.theme_light,
                s.theme_nord,
                s.theme_gruvbox,
                s.theme_solarized,
                s.theme_dracula,
                s.sidebar_shown,
                s.sidebar_hidden,
                s.copy_done_prefix,
                s.copy_done_suffix,
                s.agent_field_composer,
                s.agent_field_endpoint,
                s.agent_field_model,
                s.agent_field_key,
                s.agent_field_headers,
                s.agent_field_protocol,
                s.agent_field_reasoning,
                s.agent_field_context_window,
                s.agent_field_max_tokens,
                s.agent_reasoning_off,
                s.agent_reasoning_low,
                s.agent_reasoning_medium,
                s.agent_reasoning_high,
                s.agent_window_tight,
                s.agent_field_note,
                s.agent_needs_endpoint,
                s.agent_setting_invalid,
                s.agent_composer_section,
                s.agent_settings_section,
                s.agent_mode_auto,
                s.agent_mode_full,
                s.agent_mode_manual,
                s.pending_review,
                s.net_wifi_section,
                s.net_wifi_needs_ble,
                s.net_ssid_label,
                s.net_password_label,
                s.net_empty_value,
                s.net_ble_only,
                s.net_scan,
                s.net_connect,
                s.net_wifi_off,
                s.net_status,
                s.net_results_section,
                s.net_wifi_failed,
                s.net_no_results,
                s.net_state_on,
                s.net_state_off,
                s.net_keys_hint,
                s.net_confirm_detail,
                s.net_no_ssid,
                s.net_wifi_pending,
                s.net_wifi_off_pending,
                s.net_bad_command,
                s.net_ble_name_section,
                s.net_ble_name_label,
                s.net_ble_name_rename,
                s.net_ble_name_default_action,
                s.net_ble_name_status_action,
                s.net_ble_name_hint,
                s.net_ble_name_invalid,
                s.net_ble_name_custom,
                s.net_ble_name_default,
                s.asst_session_section,
                s.asst_tasks_section,
                s.asst_no_tasks,
                s.asst_not_configured,
                s.asst_notes_section,
                s.asst_no_notes,
                s.asst_note_too_long,
                s.asst_note_empty,
                s.asst_note_no_identity,
                s.asst_mode_label,
                s.asst_mode_auto,
                s.asst_mode_manual,
                s.asst_mode_full_auto,
                s.asst_usage_label,
                s.asst_chat_label,
                s.asst_panel_keys,
                s.asst_panel_narrow,
                s.agent_new_chat,
                s.agent_chat_switched,
                s.agent_chat_deleted,
                s.asst_awaiting,
                s.asst_unreachable,
                s.asst_rejected,
                s.asst_rejected_blank,
                s.asst_malformed,
                s.link_opened,
                s.link_closed,
                s.link_failed,
                s.not_connected,
                s.language_switched_prefix,
                s.language_zh,
                s.language_en,
                s.transport_is_locked,
                s.no_link,
                s.no_other_device,
            ];
            for field in all {
                assert!(!field.trim().is_empty(), "empty string in {lang:?}");
            }
        }
    }

    /// A failure's number becomes a sentence, and a code nobody has words for
    /// keeps the table's sentence with the number in it rather than a blank.
    #[test]
    fn a_wifi_failure_has_words_in_both_languages() {
        use crate::accessory::{
            WIFI_ALREADY, WIFI_BAD_ARGUMENT, WIFI_BUSY, WIFI_CONN_AP_NOT_FOUND, WIFI_CONN_FAIL,
            WIFI_CONN_TIMEOUT, WIFI_CONN_WRONG_PASSWORD, WIFI_NO_MEMORY, WIFI_NO_RADIO,
            WIFI_TIMEOUT, WIFI_UNREACHABLE,
        };
        for lang in [Lang::Zh, Lang::En] {
            for code in [
                WIFI_BUSY,
                WIFI_ALREADY,
                WIFI_BAD_ARGUMENT,
                WIFI_TIMEOUT,
                WIFI_UNREACHABLE,
                WIFI_NO_RADIO,
                WIFI_NO_MEMORY,
                WIFI_CONN_FAIL,
                WIFI_CONN_WRONG_PASSWORD,
                WIFI_CONN_TIMEOUT,
                WIFI_CONN_AP_NOT_FOUND,
            ] {
                let words = lang.wifi_failure(code);
                assert!(!words.trim().is_empty(), "{lang:?} has no words for {code}");
                // An errno is a C number and never a thing to show. The radio's
                // own statuses are small enough that "2.4 GHz" holds one of
                // them, so only the negative half is checked for it.
                if code < 0 {
                    assert!(
                        !words.contains(&format!("{code}")),
                        "{lang:?} shows the number for {code}: {words}"
                    );
                }
            }
            let unknown = lang.wifi_failure(-4242);
            assert!(unknown.contains("-4242"), "{unknown}");
            assert!(
                lang.wifi_busy_wait(4).contains('4'),
                "the wait says how long it is"
            );
            let retried = lang.mgmt_no_answer_after_retries(4);
            assert!(retried.contains('4'), "the retries are counted: {retried}");
            assert_ne!(
                lang.strings().mgmt_no_answer,
                retried,
                "the retried ending is said differently from the plain one"
            );
        }
        assert_ne!(
            Lang::Zh.wifi_failure(WIFI_BUSY),
            Lang::En.wifi_failure(WIFI_BUSY),
            "the sentence was never translated"
        );
    }

    /// The live traffic that caught this: a board that was already connected
    /// answered `-120`, while the table held `-114` to mean "already connected".
    /// In the firmware's own C library those are `EALREADY` and `ENETUNREACH` —
    /// one is the board saying "I am fine", the other a router to look at — so
    /// the two sentences must never be each other's.
    #[test]
    fn an_already_connected_board_is_not_an_unreachable_network() {
        use crate::accessory::{WIFI_ALREADY, WIFI_UNREACHABLE};
        for lang in [Lang::Zh, Lang::En] {
            let already = lang.wifi_failure(WIFI_ALREADY);
            let unreachable = lang.wifi_failure(WIFI_UNREACHABLE);
            assert_ne!(already, unreachable, "{lang:?} words both as one thing");
            assert!(!already.contains(&format!("{WIFI_ALREADY}")), "{already}");
            assert!(
                !unreachable.contains(&format!("{WIFI_UNREACHABLE}")),
                "{unreachable}"
            );
        }
    }

    /// The four connection states are all named, in both languages, and no two
    /// share a label — otherwise the dot and the text could disagree.
    #[test]
    fn every_connection_state_has_its_own_label() {
        for lang in [Lang::Zh, Lang::En] {
            let labels: Vec<&str> = [
                ConnectionState::Disconnected,
                ConnectionState::Connecting,
                ConnectionState::Connected,
                ConnectionState::Failed,
            ]
            .into_iter()
            .map(|state| lang.state_name(state))
            .collect();
            for label in &labels {
                assert!(!label.trim().is_empty());
            }
            let mut unique = labels.clone();
            unique.sort_unstable();
            unique.dedup();
            assert_eq!(
                unique.len(),
                labels.len(),
                "duplicate state label in {lang:?}"
            );
        }
    }

    /// Every diagnostics entry is genuinely translated: a copy that forgot to
    /// translate would otherwise pass as the Chinese one. The one label that is
    /// deliberately untranslated (`WiFi`) is not in this table at all.
    #[test]
    fn the_diagnostics_table_is_translated() {
        let pairs = |lang: Lang| -> Vec<(&'static str, &'static str)> {
            let s = lang.strings();
            vec![
                ("diag_updated", s.diag_updated),
                ("diag_not_read", s.diag_not_read),
                ("diag_no_ble", s.diag_no_ble),
                ("diag_loading", s.diag_loading),
                ("diag_empty", s.diag_empty),
                ("diag_keys_hint", s.diag_keys_hint),
                ("diag_poll_closed", s.diag_poll_closed),
                ("diag_label_firmware", s.diag_label_firmware),
                ("diag_label_uptime", s.diag_label_uptime),
                ("diag_label_ble_access", s.diag_label_ble_access),
                ("diag_label_uart_buffer", s.diag_label_uart_buffer),
                ("diag_label_upload_queue", s.diag_label_upload_queue),
                ("diag_access_open", s.diag_access_open),
                ("diag_access_scoped", s.diag_access_scoped),
                ("diag_link_level", s.diag_link_level),
            ]
        };
        let zh = pairs(Lang::Zh);
        let en = pairs(Lang::En);
        assert_eq!(zh.len(), 15, "the diagnostics view carries 15 entries");
        for ((name, zh), (_, en)) in zh.iter().zip(&en) {
            assert_ne!(zh, en, "{name} is untranslated");
        }
    }

    /// The technical tokens are the same in both languages, and the value
    /// placeholder is one column wide. Both matter for the same reason: the
    /// chrome is laid out to the column, and a token that changed width with the
    /// language — or a placeholder that rendered as two columns — would move
    /// everything after it.
    #[test]
    fn the_technical_tokens_do_not_move_with_the_language() {
        let zh = Lang::Zh.strings();
        let en = Lang::En.strings();
        for (name, zh, en) in [
            ("rx", zh.rx, en.rx),
            ("tx", zh.tx, en.tx),
            ("autoscroll", zh.autoscroll, en.autoscroll),
            ("signal_unit", zh.signal_unit, en.signal_unit),
            ("value_unknown", zh.value_unknown, en.value_unknown),
            (
                "transport_switch_hint",
                zh.transport_switch_hint,
                en.transport_switch_hint,
            ),
        ] {
            assert_eq!(zh, en, "{name} differs between the languages");
        }
        for lang in [Lang::Zh, Lang::En] {
            let placeholder = lang.strings().value_unknown;
            assert_eq!(
                crate::text::columns(placeholder),
                1,
                "{lang:?} placeholder {placeholder:?} is not one column wide"
            );
        }
    }

    /// The label separator is genuinely localised, and it costs the same number
    /// of columns in both languages: the full-width Chinese colon carries its
    /// own gap, so the English one has to spell that gap out. A separator that
    /// cost more in one language would move every value in that language.
    #[test]
    fn the_label_separator_keeps_the_value_in_one_column() {
        for lang in [Lang::Zh, Lang::En] {
            let s = lang.strings();
            let row = format!("{}{}{}", s.device_label, s.label_separator, "X");
            assert!(row.ends_with('X'), "{row:?}");
            assert_eq!(
                crate::text::columns(s.label_separator),
                2,
                "{lang:?}: the separator is not a colon and a gap"
            );
            assert!(
                !s.label_separator.starts_with(' '),
                "{lang:?}: the separator starts with the gap"
            );
        }
        // The Chinese colon is a colon and the gap is inside it; the English one
        // is a colon plus an explicit space.
        let zh = Lang::Zh.strings().label_separator;
        let en = Lang::En.strings().label_separator;
        assert_ne!(zh, en);
        assert_eq!(zh, "：");
        assert_eq!(en, ": ");
    }

    /// Every view has a title in both languages, and the titles differ between
    /// them (a missing translation would otherwise pass as the Chinese one).
    #[test]
    fn every_view_is_named_in_both_languages() {
        for view in View::ALL {
            for lang in [Lang::Zh, Lang::En] {
                assert!(!lang.view_name(view).trim().is_empty());
            }
            assert_ne!(
                Lang::Zh.view_name(view),
                Lang::En.view_name(view),
                "{view:?} is untranslated"
            );
        }
    }
}
