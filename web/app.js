"use strict";

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const MGMT_SERVICE = "4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001";
const MGMT_PROTOCOL = "4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001";
const MGMT_DEVICE_ID = "4c4b0003-9a7e-4f4e-8b8a-3d6f12a0c001";
const MGMT_COMMAND = "4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001";
const MGMT_RESPONSE = "4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001";
const RELIABLE_UART_SERVICE = "4c4b0010-9a7e-4f4e-8b8a-3d6f12a0c001";
const RELIABLE_UART_RX = "4c4b0011-9a7e-4f4e-8b8a-3d6f12a0c001";
const RELIABLE_UART_TX = "4c4b0012-9a7e-4f4e-8b8a-3d6f12a0c001";
const RELIABLE_UART_STATE = "4c4b0013-9a7e-4f4e-8b8a-3d6f12a0c001";
const MGMT_HEADER_SIZE = 12;
const MGMT_API_MAJOR = 1;
const RELIABLE_UART_HEADER_SIZE = 12;
const BLE_MAX_ATT_VALUE = 244;
const BLE_DEVICE_NAME_PREFIX = "Linkr BLE UART";
const WIFI_SCAN_CMD = "@w scan";
const WIFI_SCAN_PREFIX = "@scan ";
const WS_CONNECT_TIMEOUT_MS = 15000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let rxDecoder = new TextDecoder();

const state = {
  device: null,
  server: null,
  rxChar: null,
  txChar: null,
  mgmtCommandChar: null,
  mgmtResponseChar: null,
  reliableRxChar: null,
  reliableTxChar: null,
  reliableTxSequence: 1,
  reliableRxSequence: 1,
  reliableMaxPayload: 20,
  reliableWriteSize: BLE_MAX_ATT_VALUE,
  reliableRx: null,
  deviceId: "",
  nextRequestId: 1,
  mgmtRx: null,
  controlWriteQueue: Promise.resolve(),
  mode: "ble",
  ws: null,
  wsHost: "",
  term: null,
  fitAddon: null,
  resizeObserver: null,
  connected: false,
  termReady: false,
  logBytes: [],
  autoScroll: true,
  fontSize: 13,
  fontFamily: "system",
  rxBytes: 0,
  txBytes: 0,
  writeQueue: Promise.resolve(),
  writeGeneration: 0,
  deviceRestored: false,
  sidebarCollapsed: false,
  scanning: false,
  scanResults: [],
  scanTimer: null,
  wifiRefreshTimers: [],
  wifiStatus: { connected: false, ssid: "", ip: "down" },
  rxBuffer: "",
  diagnostics: {},
  logSize: 0,
};

const LOG_CAP_BYTES = 4 * 1024 * 1024;

const $ = (id) => document.getElementById(id);

const elements = {
  supportText: $("supportText"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  deviceName: $("deviceName"),
  connectButton: $("connectButton"),
  disconnectButton: $("disconnectButton"),
  reconnectButton: $("reconnectButton"),
  queryButton: $("queryButton"),
  diagnosticsPanel: $("diagnosticsPanel"),
  diagnosticsButton: $("diagnosticsButton"),
  diagFirmware: $("diagFirmware"),
  diagUptime: $("diagUptime"),
  diagOwner: $("diagOwner"),
  diagUart: $("diagUart"),
  diagWifi: $("diagWifi"),
  diagUpload: $("diagUpload"),
  setUartButton: $("setUartButton"),
  clearButton: $("clearButton"),
  saveButton: $("saveButton"),
  terminalOutput: $("terminalOutput"),
  terminalInputHint: $("terminalInputHint"),
  breakButton: $("breakButton"),
  uartInput: $("uartInput"),
  enterSelect: $("enterSelect"),
  chunkInput: $("chunkInput"),
  fontSelect: $("fontSelect"),
  fontPreview: $("fontPreview"),
  localEchoInput: $("localEchoInput"),
  debugInput: $("debugInput"),
  wifiSsidInput: $("wifiSsidInput"),
  wifiPasswordInput: $("wifiPasswordInput"),
  wifiPasswordToggle: $("wifiPasswordToggle"),
  wifiNetworkList: $("wifiNetworkList"),
  wifiFeedback: $("wifiFeedback"),
  wifiConnectedSummary: $("wifiConnectedSummary"),
  wifiConnectedSsid: $("wifiConnectedSsid"),
  wifiDeviceIp: $("wifiDeviceIp"),
  wifiSetButton: $("wifiSetButton"),
  wifiOffButton: $("wifiOffButton"),
  wifiQueryButton: $("wifiQueryButton"),
  wifiScanButton: $("wifiScanButton"),
  wifiSsidList: $("wifiSsidList"),
  webdavInput: $("webdavInput"),
  webdavSetButton: $("webdavSetButton"),
  webdavOffButton: $("webdavOffButton"),
  webdavQueryButton: $("webdavQueryButton"),
  presetChips: $("presetChips"),
  zoomInBtn: $("zoomInBtn"),
  zoomOutBtn: $("zoomOutBtn"),
  fullscreenBtn: $("fullscreenBtn"),
  autoscrollBtn: $("autoscrollBtn"),
  copyBtn: $("copyBtn"),
  terminalCard: $("terminalCard"),
  rxCount: $("rxCount"),
  txCount: $("txCount"),
  baudLabel: $("baudLabel"),
  connStateText: $("connStateText"),
  themeButton: $("themeButton"),
  langButton: $("langButton"),
  panelToggle: $("panelToggle"),
  drawerClose: $("drawerClose"),
  drawerBackdrop: $("drawerBackdrop"),
  themeColorMeta: $("themeColorMeta"),
  bleModeBtn: $("bleModeBtn"),
  lanModeBtn: $("lanModeBtn"),
  wsHostField: $("wsHostField"),
  wsHostInput: $("wsHostInput"),
  mobileConnectBtn: $("mobileConnectBtn"),
};

const THEME_KEY = "linkr-theme";
const LANG_KEY = "linkr-lang";
const FONT_FAMILY_KEY = "linkr-font-family";
const LAST_DEVICE_ID_KEY = "linkr-last-device-id";
const TRANSPORT_KEY = "linkr-transport";
const WS_HOST_KEY = "linkr-ws-host";

const SYSTEM_TERMINAL_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const TERMINAL_FONTS = {
  system: SYSTEM_TERMINAL_FONT,
  symbols:
    '"Symbols Nerd Font Mono", "Symbols Nerd Font", ' +
    SYSTEM_TERMINAL_FONT,
  jetbrains:
    '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", ' +
    '"Symbols Nerd Font Mono", "Symbols Nerd Font", ' +
    SYSTEM_TERMINAL_FONT,
  meslo:
    '"MesloLGS Nerd Font Mono", "MesloLGS NF", ' +
    '"Symbols Nerd Font Mono", "Symbols Nerd Font", ' +
    SYSTEM_TERMINAL_FONT,
  firacode:
    '"FiraCode Nerd Font Mono", "FiraCode Nerd Font", ' +
    '"Symbols Nerd Font Mono", "Symbols Nerd Font", ' +
    SYSTEM_TERMINAL_FONT,
};

const XTERM_DARK = {
  background: "#05080d",
  foreground: "#d8f3dc",
  cursor: "#d8f3dc",
  selectionBackground: "#2b5340",
};

const XTERM_LIGHT = {
  background: "#f8fafc",
  foreground: "#1f6b43",
  cursor: "#1f6b43",
  selectionBackground: "#bfe3cf",
};

const I18N = {
  en: {
    title: "Linkr BMC Lite Terminal",
    checking: "Checking Web Bluetooth…",
    supported: "Chrome/Chromium Web Bluetooth over HTTPS or localhost",
    unsupported: "Web Bluetooth unavailable in this browser",
    bleMode: "BLE",
    lanMode: "LAN",
    wsHost: "Device address",
    placeholderWsHost: "192.168.1.50 or ws://host/ws",
    lanHint: "LAN mode: reach the device's WebSocket over your network",
    wsMissingHost: "Enter the device address first.",
    wsUnreachable: "WebSocket {url} is unreachable.",
    wsTimeout: "WebSocket connection timed out after 15 seconds.",
    xtermFail: "xterm.js failed to load; check network access to jsDelivr",
    connected: "Connected",
    disconnected: "Disconnected",
    authorizedDeviceReady: "Authorized device restored; click Connect to reconnect",
    authorizedDeviceFailed: "Saved device unavailable; choose it again",
    connection: "Connection",
    terminalSettings: "Terminal Settings",
    diagnostics: "Device Diagnostics",
    diagFirmware: "Firmware",
    diagUptime: "Uptime",
    diagOwner: "BLE access",
    diagUart: "UART Buffer",
    diagWifi: "WiFi",
    diagUpload: "Upload Queue",
    refreshDiagnostics: "Refresh diagnostics",
    diagnosticsUpdated: "Diagnostics updated",
    wifiWebdav: "WiFi & WebDAV",
    connect: "Connect",
    disconnect: "Disconnect",
    reconnect: "Reconnect",
    queryUart: "Query UART",
    clear: "Clear",
    saveLog: "Save Log",
    set: "Set",
    off: "Off",
    ctrlC: "Ctrl-C",
    uart: "UART",
    enterKey: "Enter key",
    chunkSize: "Chunk size",
    fontFamily: "Terminal font",
    fontSystem: "System monospace",
    fontSymbols: "System + Nerd Symbols",
    fontJetBrains: "JetBrains Mono Nerd Font",
    fontMeslo: "MesloLGS Nerd Font",
    fontFiraCode: "FiraCode Nerd Font",
    fontHint: "Nerd Font options use fonts installed on this device.",
    fontApplied: "Terminal font applied",
    localEcho: "Local echo",
    debugIO: "Debug I/O",
    wifi: "WiFi",
    wifiSsid: "Network name",
    wifiPassword: "Password",
    connectWifi: "Connect WiFi",
    wifiStatus: "WiFi status",
    showPassword: "Show password",
    hidePassword: "Hide password",
    wifiScanHint: "Scan to select a nearby 2.4 GHz network.",
    wifiSelectHint: "Select a network or enter its SSID.",
    wifiMissingSsid: "Enter or select a network name.",
    connectedNetwork: "Connected network",
    deviceIp: "Device IP",
    awaitingIp: "Obtaining address…",
    webdav: "WebDAV",
    webdavStatus: "WebDAV status",
    serialOutput: "Serial Terminal",
    terminalAria: "Interactive serial terminal",
    xterm: "xterm.js",
    terminalInputHint: "Type here · Tab completes · Arrow keys browse history",
    terminalInputDisconnected: "Connect a device to enable terminal input",
    placeholderWifiSsid: "SSID",
    placeholderWifiPassword: "Leave blank for an open network",
    placeholderWebdav: "http://host/path/ (anonymous)",
    enterRaw: "Raw",
    enterCr: "CR",
    enterLf: "LF",
    enterCrlf: "CRLF",
    cheatsheet: "Cheat Sheet",
    linuxCmds: "Linux Commands",
    shortcuts: "Shortcuts",
    cheatHint: "Tip: click a command to send it when connected.",
    grpFiles: "Files & Dirs",
    grpSys: "System",
    grpNet: "Network",
    grpPerm: "Permissions & Processes",
    panel: "Panel",
    close: "Close",
    theme: "Theme",
    language: "Language",
    zoomIn: "Increase font size",
    zoomOut: "Decrease font size",
    fullscreen: "Fullscreen terminal",
    exitFullscreen: "Exit fullscreen",
    autoScroll: "Auto-scroll",
    copy: "Copy selection",
    rx: "RX",
    tx: "TX",
    baud: "Baud",
    welcome: "Linkr BMC Lite Terminal ready. Press Connect to open a device.",
    connecting: "Connecting…",
    saved: "Log saved",
    uartSet: "UART configured",
    wifiSet: "WiFi configured",
    webdavSet: "WebDAV configured",
    sent: "Sent",
    cleared: "Screen cleared",
    copied: "Copied to clipboard",
    scan: "Scan",
    scanning: "Scanning…",
    foundN: "Found {n} networks",
    noNetworks: "No networks found",
    scanFailed: "Wi-Fi scan failed; retry in a moment",
    light: "Light",
    dark: "Dark",
  },
  zh: {
    title: "Linkr BMC Lite 终端",
    checking: "正在检测 Web Bluetooth…",
    supported: "Chrome/Chromium 需通过 HTTPS 或 localhost 使用 Web Bluetooth",
    unsupported: "当前浏览器不支持 Web Bluetooth",
    bleMode: "BLE",
    lanMode: "局域网",
    wsHost: "设备地址",
    placeholderWsHost: "192.168.1.50 或 ws://host/ws",
    lanHint: "局域网模式:通过设备的 WebSocket 直连串口",
    wsMissingHost: "请先输入设备地址。",
    wsUnreachable: "无法连接 WebSocket {url}。",
    wsTimeout: "WebSocket 连接超过 15 秒未响应。",
    xtermFail: "xterm.js 加载失败，请检查对 jsDelivr 的网络访问",
    connected: "已连接",
    disconnected: "未连接",
    authorizedDeviceReady: "已恢复授权设备，点击「连接」即可快速重连",
    authorizedDeviceFailed: "已授权设备不可用，请重新选择设备",
    connection: "连接",
    terminalSettings: "终端设置",
    diagnostics: "设备诊断",
    diagFirmware: "固件",
    diagUptime: "运行时间",
    diagOwner: "BLE 访问",
    diagUart: "UART 缓冲",
    diagWifi: "WiFi",
    diagUpload: "上传队列",
    refreshDiagnostics: "刷新诊断",
    diagnosticsUpdated: "诊断信息已更新",
    wifiWebdav: "WiFi 与 WebDAV",
    connect: "连接",
    disconnect: "断开",
    reconnect: "重连",
    queryUart: "查询 UART",
    clear: "清屏",
    saveLog: "保存日志",
    set: "设置",
    off: "关闭",
    ctrlC: "Ctrl-C",
    uart: "UART",
    enterKey: "回车键",
    chunkSize: "分片大小",
    fontFamily: "终端字体",
    fontSystem: "系统等宽字体",
    fontSymbols: "系统字体 + Nerd Symbols",
    fontJetBrains: "JetBrains Mono Nerd Font",
    fontMeslo: "MesloLGS Nerd Font",
    fontFiraCode: "FiraCode Nerd Font",
    fontHint: "Nerd Font 选项使用当前设备已安装的本地字体。",
    fontApplied: "终端字体已应用",
    localEcho: "本地回显",
    debugIO: "调试 I/O",
    wifi: "WiFi",
    wifiSsid: "网络名称",
    wifiPassword: "密码",
    connectWifi: "连接 WiFi",
    wifiStatus: "WiFi 状态",
    showPassword: "显示密码",
    hidePassword: "隐藏密码",
    wifiScanHint: "扫描并选择附近的 2.4 GHz 网络。",
    wifiSelectHint: "选择一个网络，或手动输入 SSID。",
    wifiMissingSsid: "请输入或选择网络名称。",
    connectedNetwork: "当前网络",
    deviceIp: "设备 IP",
    awaitingIp: "正在获取地址…",
    webdav: "WebDAV",
    webdavStatus: "WebDAV 状态",
    serialOutput: "串口终端",
    terminalAria: "交互式串口终端",
    xterm: "xterm.js",
    terminalInputHint: "直接输入 · Tab 补全 · 方向键浏览历史",
    terminalInputDisconnected: "连接设备后即可在终端内直接输入",
    placeholderWifiSsid: "SSID",
    placeholderWifiPassword: "开放网络可留空",
    placeholderWebdav: "http://host/path/ (匿名)",
    enterRaw: "原始",
    enterCr: "CR",
    enterLf: "LF",
    enterCrlf: "CRLF",
    cheatsheet: "速查参考",
    linuxCmds: "Linux 命令",
    shortcuts: "常用快捷键",
    cheatHint: "提示：连接后可点击命令直接发送。",
    grpFiles: "文件与目录",
    grpSys: "系统信息",
    grpNet: "网络",
    grpPerm: "权限与进程",
    panel: "面板",
    close: "关闭",
    theme: "主题",
    language: "语言",
    zoomIn: "放大字体",
    zoomOut: "缩小字体",
    fullscreen: "终端全屏",
    exitFullscreen: "退出全屏",
    autoScroll: "自动滚动",
    copy: "复制选中",
    rx: "收",
    tx: "发",
    baud: "波特率",
    welcome: "Linkr BMC Lite 终端已就绪，点击「连接」打开设备。",
    connecting: "连接中…",
    saved: "日志已保存",
    uartSet: "UART 已配置",
    wifiSet: "WiFi 已配置",
    webdavSet: "WebDAV 已配置",
    sent: "已发送",
    cleared: "已清屏",
    copied: "已复制到剪贴板",
    scan: "扫描",
    scanning: "扫描中…",
    foundN: "找到 {n} 个网络",
    noNetworks: "未找到网络",
    scanFailed: "Wi-Fi 扫描失败，请稍后重试",
    light: "浅色",
    dark: "深色",
  },
};

let theme =
  localStorage.getItem(THEME_KEY) ||
  (window.matchMedia &&
  window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark");

let lang =
  localStorage.getItem(LANG_KEY) ||
  (navigator.language &&
  navigator.language.toLowerCase().startsWith("zh")
    ? "zh"
    : "en");

function t(key) {
  const dict = I18N[lang] || I18N.en;
  if (dict[key] != null) {
    return dict[key];
  }
  return I18N.en[key] != null ? I18N.en[key] : key;
}

function tl(obj) {
  if (!obj) {
    return "";
  }
  return obj[lang] != null ? obj[lang] : obj.en != null ? obj.en : "";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateXtermTheme() {
  if (!state.term) {
    return;
  }
  state.term.options.theme = theme === "dark" ? XTERM_DARK : XTERM_LIGHT;
}

function terminalFontStack(fontId = state.fontFamily) {
  return TERMINAL_FONTS[fontId] || TERMINAL_FONTS.system;
}

function refreshTerminalFont(fontId) {
  if (!state.term || state.fontFamily !== fontId) {
    return;
  }

  requestAnimationFrame(() => {
    if (!state.term || state.fontFamily !== fontId) {
      return;
    }
    if (state.term.rows > 0) {
      state.term.refresh(0, state.term.rows - 1);
    }
    fitTerminal();
  });
}

function applyTerminalFont(fontId, persist = false) {
  const next = TERMINAL_FONTS[fontId] ? fontId : "system";
  const stack = terminalFontStack(next);

  state.fontFamily = next;
  if (elements.fontSelect) {
    elements.fontSelect.value = next;
  }
  if (elements.fontPreview) {
    elements.fontPreview.style.fontFamily = stack;
  }
  if (persist) {
    saveSetting(FONT_FAMILY_KEY, next);
  }
  if (!state.term) {
    return;
  }

  state.term.options.fontFamily = stack;
  if (document.fonts && document.fonts.load) {
    document.fonts
      .load(`${state.fontSize}px ${stack}`, "\ue0a0\ue0b0")
      .then(() => refreshTerminalFont(next))
      .catch(() => refreshTerminalFont(next));
  } else {
    refreshTerminalFont(next);
  }
}

function updateToggleLabels() {
  if (elements.langButton) {
    const label = elements.langButton.querySelector(".btn-label");
    if (label) {
      label.textContent = lang === "zh" ? "EN" : "中";
    }
  }
  if (elements.themeButton) {
    const label = elements.themeButton.querySelector(".btn-label");
    if (label) {
      label.textContent = theme === "dark" ? t("light") : t("dark");
    }
  }
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", theme);
  if (elements.themeColorMeta) {
    elements.themeColorMeta.content = theme === "dark" ? "#090d14" : "#eef2f7";
  }
  document.title = t("title");
  updateXtermTheme();
  updateToggleLabels();
}

function setSupportText() {
  if (!state.termReady) {
    elements.supportText.textContent = t("xtermFail");
    return;
  }
  if (state.mode === "ws") {
    elements.supportText.textContent = t("lanHint");
    return;
  }
  elements.supportText.textContent = navigator.bluetooth
    ? t("supported")
    : t("unsupported");
}

function setTransportMode(mode) {
  if (state.connected || mode === state.mode) {
    return;
  }
  state.mode = mode;
  saveSetting(TRANSPORT_KEY, mode);
  elements.bleModeBtn.classList.toggle("active", mode === "ble");
  elements.lanModeBtn.classList.toggle("active", mode === "ws");
  elements.wsHostField.hidden = mode !== "ws";
  setConnected(false);
  setSupportText();
}

function refreshDynamicTexts() {
  elements.statusText.textContent = t(
    state.connected ? "connected" : "disconnected",
  );
  if (elements.connStateText) {
    elements.connStateText.textContent = t(
      state.connected ? "connected" : "disconnected",
    );
  }
  setSupportText();
}

const CHEATS = [
  {
    group: "grpFiles",
    items: [
      { c: "ls -l", d: { en: "List in long format", zh: "详细列表" } },
      { c: "cd <dir>", d: { en: "Change directory", zh: "切换目录" } },
      { c: "pwd", d: { en: "Print working directory", zh: "显示当前路径" } },
      { c: "mkdir <dir>", d: { en: "Make directory", zh: "创建目录" } },
      { c: "cp -r a b", d: { en: "Copy recursively", zh: "递归复制" } },
      { c: "mv a b", d: { en: "Move / rename", zh: "移动或重命名" } },
      { c: "rm -rf <dir>", d: { en: "Force remove", zh: "强制删除" } },
      { c: "cat <file>", d: { en: "Show file content", zh: "查看文件内容" } },
      { c: 'grep "x" <f>', d: { en: "Search text", zh: "搜索文本" } },
      { c: 'find . -name "*.c"', d: { en: "Find files", zh: "查找文件" } },
    ],
  },
  {
    group: "grpSys",
    items: [
      { c: "uname -a", d: { en: "Kernel info", zh: "内核信息" } },
      { c: "df -h", d: { en: "Disk usage", zh: "磁盘使用" } },
      { c: "free -h", d: { en: "Memory usage", zh: "内存使用" } },
      { c: "top", d: { en: "Process monitor", zh: "进程监控" } },
      { c: "uptime", d: { en: "System uptime", zh: "运行时长" } },
    ],
  },
  {
    group: "grpNet",
    items: [
      { c: "ip a", d: { en: "Network interfaces", zh: "网络接口" } },
      { c: "ping <host>", d: { en: "Ping a host", zh: "连通测试" } },
      { c: "ssh u@host", d: { en: "Remote login", zh: "远程登录" } },
      { c: "scp a u@h:", d: { en: "Secure copy", zh: "安全拷贝" } },
      { c: "curl -I <url>", d: { en: "Fetch headers", zh: "请求响应头" } },
    ],
  },
  {
    group: "grpPerm",
    items: [
      { c: "chmod 755 <f>", d: { en: "Change mode", zh: "修改权限" } },
      { c: "chown u:g <f>", d: { en: "Change owner", zh: "修改属主" } },
      { c: "ps aux", d: { en: "List processes", zh: "进程列表" } },
      { c: "kill -9 <pid>", d: { en: "Kill process", zh: "终止进程" } },
      { c: "sudo <cmd>", d: { en: "Run as root", zh: "提权执行" } },
    ],
  },
];

const SHORTCUTS = [
  { c: "Ctrl+C", d: { en: "Interrupt task", zh: "中断当前任务" } },
  { c: "Ctrl+L", d: { en: "Clear screen", zh: "清屏" } },
  { c: "Ctrl+A", d: { en: "Start of line", zh: "光标到行首" } },
  { c: "Ctrl+E", d: { en: "End of line", zh: "光标到行尾" } },
  { c: "Ctrl+R", d: { en: "Search history", zh: "搜索历史命令" } },
  { c: "Ctrl+Z", d: { en: "Suspend task", zh: "挂起任务" } },
  { c: "Ctrl+D", d: { en: "Exit shell", zh: "退出终端" } },
  { c: "Ctrl+U", d: { en: "Clear whole line", zh: "删除整行" } },
  { c: "Tab", d: { en: "Autocomplete", zh: "自动补全" } },
  { c: "↑ / ↓", d: { en: "Command history", zh: "浏览历史命令" } },
];

function renderRefLists() {
  const cheat = document.getElementById("cheatList");
  const shortcut = document.getElementById("shortcutList");
  if (cheat) {
    cheat.innerHTML = CHEATS.map(
      (g) => `
        <div class="ref-group">
          <div class="ref-group-title">${escapeHtml(t(g.group))}</div>
          ${g.items
            .map(
              (it) => `
            <div class="ref-item" data-cmd="${escapeHtml(it.c)}">
              <code class="ref-cmd">${escapeHtml(it.c)}</code>
              <span class="ref-desc">${escapeHtml(tl(it.d))}</span>
            </div>`,
            )
            .join("")}
        </div>`,
    ).join("");
  }
  if (shortcut) {
    shortcut.innerHTML = SHORTCUTS.map(
      (it) => `
        <div class="ref-item">
          <code class="ref-cmd">${escapeHtml(it.c)}</code>
          <span class="ref-desc">${escapeHtml(tl(it.d))}</span>
        </div>`,
    ).join("");
  }
}

function applyLang() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
  });
  updateToggleLabels();
  renderRefLists();
  refreshDynamicTexts();
  renderDiagnostics();
  updateWifiConnectionView();
  updateFullscreenButton();
}

function fitTerminal() {
  if (!state.fitAddon) {
    return;
  }
  try {
    state.fitAddon.fit();
  } catch (_error) {
    // The fit addon can throw while the terminal container is hidden/resizing.
  }
}

let fitRaf = 0;
function scheduleFit() {
  if (fitRaf) {
    return;
  }
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    fitTerminal();
  });
}

function isTerminalFullscreen() {
  return (
    document.fullscreenElement === elements.terminalCard ||
    elements.terminalCard.classList.contains("terminal-fullscreen-fallback")
  );
}

function updateFullscreenButton() {
  if (!elements.fullscreenBtn || !elements.terminalCard) {
    return;
  }
  const active = isTerminalFullscreen();
  const label = t(active ? "exitFullscreen" : "fullscreen");
  elements.fullscreenBtn.classList.toggle("active", active);
  elements.fullscreenBtn.setAttribute("aria-pressed", String(active));
  elements.fullscreenBtn.setAttribute("aria-label", label);
  elements.fullscreenBtn.setAttribute("title", label);
}

function refitTerminalAfterLayoutChange() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fitTerminal();
      state.term?.focus();
    });
  });
}

function setTerminalFallbackFullscreen(enabled) {
  elements.terminalCard.classList.toggle(
    "terminal-fullscreen-fallback",
    enabled,
  );
  document.body.classList.toggle("terminal-fullscreen-fallback", enabled);
  updateFullscreenButton();
  refitTerminalAfterLayoutChange();
}

async function toggleTerminalFullscreen() {
  if (document.fullscreenElement === elements.terminalCard) {
    await document.exitFullscreen();
    return;
  }

  if (elements.terminalCard.classList.contains("terminal-fullscreen-fallback")) {
    setTerminalFallbackFullscreen(false);
    return;
  }

  if (elements.terminalCard.requestFullscreen) {
    try {
      await elements.terminalCard.requestFullscreen();
      return;
    } catch (_error) {
      // Some embedded browsers expose the API but reject fullscreen requests.
    }
  }

  setTerminalFallbackFullscreen(true);
}

function onFullscreenChange() {
  if (document.fullscreenElement === elements.terminalCard) {
    elements.terminalCard.classList.remove("terminal-fullscreen-fallback");
    document.body.classList.remove("terminal-fullscreen-fallback");
  }
  updateFullscreenButton();
  refitTerminalAfterLayoutChange();
}

function initTerminal() {
  if (!globalThis.Terminal || !globalThis.FitAddon) {
    state.termReady = false;
    elements.supportText.textContent = t("xtermFail");
    return false;
  }

  state.termReady = true;
  state.term = new globalThis.Terminal({
    cursorBlink: true,
    fontFamily: terminalFontStack(),
    fontSize: state.fontSize,
    lineHeight: 1,
    scrollback: 10000,
    smoothScrollDuration: 100,
    tabStopWidth: 8,
    theme: theme === "dark" ? XTERM_DARK : XTERM_LIGHT,
  });
  state.fitAddon = new globalThis.FitAddon.FitAddon();
  state.term.loadAddon(state.fitAddon);
  state.term.open(elements.terminalOutput);
  state.term.onData(onTerminalData);
  applyTerminalFont(state.fontFamily);
  fitTerminal();

  window.addEventListener("resize", scheduleFit);
  if (globalThis.ResizeObserver) {
    state.resizeObserver = new ResizeObserver(scheduleFit);
    state.resizeObserver.observe(elements.terminalOutput);
  }

  return true;
}

let writeRaf = 0;
let pendingWrites = [];

function flushTerminalWrites() {
  writeRaf = 0;
  const chunks = pendingWrites;
  pendingWrites = [];
  if (!state.term || !chunks.length) {
    return;
  }
  if (chunks.length === 1) {
    state.term.write(chunks[0]);
    return;
  }
  let total = 0;
  const encoded = chunks.map((chunk) => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    total += bytes.length;
    return bytes;
  });
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const bytes of encoded) {
    merged.set(bytes, offset);
    offset += bytes.length;
  }
  state.term.write(merged);
}

function appendOutput(data) {
  if (!state.term) {
    const text =
      data instanceof Uint8Array ? decoder.decode(data) : String(data);
    elements.terminalOutput.append(
      document.createTextNode(text.replace(/\x1b\[[0-9;]*m/g, "")),
    );
    elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
    return;
  }
  pendingWrites.push(data);
  if (!writeRaf) {
    writeRaf = requestAnimationFrame(flushTerminalWrites);
  }
}

function appendLine(text) {
  let color = "\x1b[90m";
  if (text.startsWith("[error]")) {
    color = "\x1b[91m";
  } else if (text.startsWith("[warn]") || text.startsWith("[disconnected]")) {
    color = "\x1b[93m";
  } else if (text === "[ready]") {
    color = "\x1b[92m";
  }
  appendOutput(`${color}${text}\x1b[0m\r\n`);
}

function debugLine(text) {
  if (elements.debugInput.checked) {
    appendLine(text);
  }
}

const TOAST_LIMIT = 3;

function toast(message, kind = "info") {
  const host = document.getElementById("toastHost");
  if (!host) {
    return;
  }
  while (host.children.length >= TOAST_LIMIT) {
    host.firstElementChild.remove();
  }
  const el = document.createElement("div");
  el.className = kind === "error" ? "toast toast-error" : "toast";
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 2200);
}

let counterRaf = 0;
function updateCounters() {
  if (counterRaf) {
    return;
  }
  counterRaf = requestAnimationFrame(() => {
    counterRaf = 0;
    if (elements.rxCount) {
      elements.rxCount.textContent = state.rxBytes.toLocaleString();
    }
    if (elements.txCount) {
      elements.txCount.textContent = state.txBytes.toLocaleString();
    }
  });
}

function appendLogBytes(bytes) {
  state.logBytes.push(bytes);
  state.logSize += bytes.length;
  while (state.logSize > LOG_CAP_BYTES && state.logBytes.length > 1) {
    state.logSize -= state.logBytes.shift().byteLength;
  }
}

function updateWifiDatalist() {
  const list = elements.wifiSsidList;
  const networkList = elements.wifiNetworkList;
  if (!list || !networkList) {
    return;
  }

  const networks = [...state.scanResults].sort(
    (a, b) => (b.rssi ?? -999) - (a.rssi ?? -999),
  );
  list.replaceChildren(
    ...networks.map((network) => {
      const option = document.createElement("option");
      option.value = network.ssid;
      return option;
    }),
  );
  networkList.replaceChildren(
    ...networks.map((network) => {
      const button = document.createElement("button");
      const name = document.createElement("span");
      const rssi = document.createElement("span");

      button.type = "button";
      button.className = "wifi-network";
      button.dataset.ssid = network.ssid;
      name.className = "wifi-network-name";
      name.textContent = network.ssid;
      rssi.className = "wifi-network-rssi";
      rssi.textContent = Number.isFinite(network.rssi)
        ? `${network.rssi} dBm`
        : "";
      button.append(name, rssi);
      return button;
    }),
  );
}

function updateWifiConnectionView() {
  const wifi = state.wifiStatus;
  const connected = Boolean(wifi.connected);
  const wifiForm = document.querySelector(".wifi-form");

  if (elements.wifiConnectedSummary) {
    elements.wifiConnectedSummary.hidden = !connected;
  }
  if (wifiForm) {
    wifiForm.hidden = connected;
  }
  elements.wifiScanButton.hidden = connected;
  elements.wifiSetButton.hidden = connected;

  if (!connected) {
    return;
  }

  state.scanResults = [];
  updateWifiDatalist();
  elements.wifiConnectedSsid.textContent = wifi.ssid || "—";
  elements.wifiDeviceIp.textContent = /^\d{1,3}(\.\d{1,3}){3}$/.test(wifi.ip)
    ? wifi.ip
    : t("awaitingIp");
}

function handleWifiStatusLine(line) {
  const value = String(line).trim();

  if (value === "OK wifi off") {
    state.wifiStatus = { connected: false, ssid: "", ip: "down" };
    updateWifiConnectionView();
    return true;
  }
  if (!value.startsWith("OK wifi=")) {
    return false;
  }

  let payload = value.slice("OK ".length);
  let ip = "down";
  const ipIndex = payload.lastIndexOf(",ip=");
  if (ipIndex >= 0) {
    ip = payload.slice(ipIndex + 4).trim();
    payload = payload.slice(0, ipIndex);
  }
  const match = payload.match(/^wifi=([^,]+),ssid=(.*)$/);
  if (!match) {
    return false;
  }

  state.wifiStatus.connected = match[1] === "connected";
  state.wifiStatus.ssid = match[2] === "-" ? "" : match[2];
  state.wifiStatus.ip = ip;
  updateWifiConnectionView();
  return true;
}

function clearWifiRefreshTimers() {
  for (const timer of state.wifiRefreshTimers) {
    clearTimeout(timer);
  }
  state.wifiRefreshTimers = [];
}

function requestWifiState() {
  if (!state.connected || state.mode !== "ble") {
    return Promise.resolve();
  }
  return Promise.all([sendControl("@w?"), requestDiagnostics()]);
}

function scheduleWifiStateRefresh() {
  clearWifiRefreshTimers();
  state.wifiRefreshTimers = [1500, 3500, 7000].map((delay) =>
    setTimeout(() => {
      requestWifiState().catch((error) =>
        appendLine(`[error] ${error.message}`),
      );
    }, delay),
  );
}

function parseWifiScanResult(raw) {
  let value = String(raw).trim();
  const rssiMatch = value.match(/\s+(-?\d+)\s*dBm?$/i);
  const rssi = rssiMatch ? Number(rssiMatch[1]) : null;
  let channel = null;
  let security = null;

  if (rssiMatch) {
    value = value.slice(0, rssiMatch.index).trim();
  }
  const channelMatch = value.match(/\s+ch=(\d+)$/i);
  if (channelMatch) {
    channel = Number(channelMatch[1]);
    value = value.slice(0, channelMatch.index).trim();
  }
  const securityMatch = value.match(
    /\s+(open|wep|wpa|wpa2|wpa2-sha256|wpa3|eap|wapi|unknown)$/i,
  );
  if (securityMatch) {
    security = securityMatch[1].toLowerCase();
    value = value.slice(0, securityMatch.index).trim();
  }
  if (!value || value.length > 32) {
    return null;
  }
  if (/^[[@]/.test(value)) {
    return null;
  }
  value = value.replace(/^\d+[).]\s*/, "");
  value = value.replace(/^["']|["']$/g, "").trim();
  if (!value || value === "<hidden>") {
    return null;
  }
  return { ssid: value, rssi, channel, security };
}

function formatUptime(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return days
    ? `${days}d ${hours}h`
    : hours
      ? `${hours}h ${minutes}m`
      : `${minutes}m ${seconds}s`;
}

function renderDiagnostics() {
  const diag = state.diagnostics;
  const fw = diag.fw || {};
  const sys = diag.sys || {};
  const uart = diag.uart || {};
  const wifi = diag.wifi || {};
  const upload = diag.upload || {};

  elements.diagFirmware.textContent = fw.version
    ? `${fw.version} · Z${fw.zephyr || "?"}`
    : "—";
  elements.diagUptime.textContent = sys.uptime_ms
    ? formatUptime(sys.uptime_ms)
    : "—";
  elements.diagOwner.textContent = sys.owner != null
    ? `open · L${sys.security || "?"}`
    : "—";
  elements.diagUart.textContent = uart.buffer
    ? `${uart.buffer} · drop ${uart.dropped || "0"}`
    : "—";
  elements.diagWifi.textContent = wifi.state
    ? `${wifi.state} · IP ${wifi.ip || "?"} · err ${wifi.error || "0"}`
    : "—";
  if (wifi.state) {
    state.wifiStatus.connected = wifi.state === "connected";
    state.wifiStatus.ip = wifi.ip || "down";
    updateWifiConnectionView();
  }
  if (
    elements.wsHostInput &&
    !elements.wsHostInput.value &&
    /^\d{1,3}(\.\d{1,3}){3}$/.test(wifi.ip || "")
  ) {
    elements.wsHostInput.value = wifi.ip;
  }
  elements.diagUpload.textContent = upload.queue != null
    ? `${upload.queue} B · HTTP ${upload.http || "0"} · fail ${upload.failures || "0"}`
    : "—";
}

function handleInfoLine(line) {
  const payload = line.slice("@info ".length).trim();
  if (payload === "done") {
    renderDiagnostics();
    toast(t("diagnosticsUpdated"));
    return;
  }

  const parts = payload.split(/\s+/);
  const group = parts.shift();
  if (!group) {
    return;
  }
  const fields = {};
  for (const token of parts) {
    const separator = token.indexOf("=");
    if (separator > 0) {
      fields[token.slice(0, separator)] = token.slice(separator + 1);
    }
  }
  state.diagnostics[group] = fields;
}

function feedRx(text) {
  state.rxBuffer += text;
  const lines = state.rxBuffer.split(/\r?\n/);
  state.rxBuffer = lines.pop() || "";
  for (const line of lines) {
    handleRxLine(line);
  }
}

function handleRxLine(line) {
  const scanLine = String(line).trim();
  if (scanLine.startsWith("@info ")) {
    handleInfoLine(scanLine);
    return;
  }
  if (handleWifiStatusLine(scanLine)) {
    return;
  }
  if (!state.scanning) {
    return;
  }
  const resultPrefix = WIFI_SCAN_PREFIX + "result ";
  if (/^ERR\b/i.test(scanLine) || scanLine === "@scan error") {
    finishScan(true);
    return;
  }
  if (scanLine === "@scan done") {
    finishScan();
    return;
  }
  if (!scanLine.startsWith(resultPrefix)) {
    return;
  }
  const network = parseWifiScanResult(scanLine.slice(resultPrefix.length));
  if (network) {
    const existing = state.scanResults.find(
      (item) => item.ssid === network.ssid,
    );
    if (!existing) {
      state.scanResults.push(network);
    } else if (
      Number.isFinite(network.rssi) &&
      (!Number.isFinite(existing.rssi) || network.rssi > existing.rssi)
    ) {
      existing.rssi = network.rssi;
    }
    updateWifiDatalist();
  }
}

async function scanWifi() {
  if (!state.connected) {
    return;
  }
  state.scanning = true;
  state.scanResults = [];
  updateWifiDatalist();
  elements.wifiFeedback.textContent = t("scanning");
  elements.wifiScanButton.disabled = true;
  clearTimeout(state.scanTimer);
  state.scanTimer = setTimeout(finishScan, 10000);
  try {
    await sendControl(WIFI_SCAN_CMD);
    toast(t("scanning"));
  } catch (error) {
    appendLine("[error] " + error.message);
    finishScan(true);
  }
}

function finishScan(failed = false) {
  if (!state.scanning) {
    return;
  }
  state.scanning = false;
  clearTimeout(state.scanTimer);
  updateWifiDatalist();
  elements.wifiScanButton.disabled = !state.connected;
  if (failed) {
    elements.wifiFeedback.textContent = t("scanFailed");
    toast(t("scanFailed"), "error");
    return;
  }
  if (state.scanResults.length) {
    elements.wifiFeedback.textContent = t("wifiSelectHint");
    toast(t("foundN").replace("{n}", String(state.scanResults.length)));
  } else {
    elements.wifiFeedback.textContent = t("noNetworks");
    toast(t("noNetworks"));
  }
}

function setAutoScroll(value, scroll) {
  if (state.autoScroll !== value) {
    state.autoScroll = value;
    if (elements.autoscrollBtn) {
      elements.autoscrollBtn.setAttribute("aria-pressed", String(value));
      elements.autoscrollBtn.classList.toggle("active", value);
    }
  }
  if (value && scroll && state.term) {
    state.term.scrollToBottom();
  }
}

function onViewportScroll() {
  const vp = elements.terminalOutput.querySelector(".xterm-viewport");
  if (!vp) {
    return;
  }
  const atBottom = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 2;
  setAutoScroll(atBottom, false);
}

function setConnecting(connecting) {
  const btn = elements.connectButton;
  btn.classList.toggle("loading", connecting);
  btn.disabled = connecting || state.connected;
  elements.bleModeBtn.disabled = connecting || state.connected;
  elements.lanModeBtn.disabled = connecting || state.connected;
  const label = btn.querySelector(".btn-label");
  if (connecting) {
    if (label) {
      label.textContent = t("connecting");
    }
  } else if (label) {
    label.textContent = t("connect");
  }
  const mobileBtn = elements.mobileConnectBtn;
  if (mobileBtn) {
    mobileBtn.classList.toggle("loading", connecting);
    mobileBtn.disabled = connecting || state.connected;
    const mobileLabel = mobileBtn.querySelector(".btn-label");
    if (mobileLabel) {
      mobileLabel.textContent = connecting ? t("connecting") : t("connect");
    }
  }
}

function setConnected(connected) {
  const isWs = state.mode === "ws";
  const canConnect =
    Boolean(state.term) && (isWs || Boolean(navigator.bluetooth));
  const canControl = connected && !isWs;

  state.writeGeneration += 1;
  state.connected = connected;
  elements.statusDot.classList.toggle("connected", connected);
  elements.statusText.textContent = t(
    connected ? "connected" : "disconnected",
  );
  if (elements.connStateText) {
    elements.connStateText.textContent = t(
      connected ? "connected" : "disconnected",
    );
  }
  elements.deviceName.textContent = isWs
    ? state.wsHost || ""
    : state.device
      ? state.device.name || state.device.id
      : "";
  elements.connectButton.disabled = connected || !canConnect;
  if (elements.mobileConnectBtn) {
    elements.mobileConnectBtn.disabled = connected || !canConnect;
  }
  elements.disconnectButton.disabled = !connected;
  elements.reconnectButton.disabled =
    connected || (!isWs && !state.device);
  elements.bleModeBtn.disabled = connected;
  elements.lanModeBtn.disabled = connected;
  elements.queryButton.disabled = !canControl;
  elements.diagnosticsButton.disabled = !canControl;
  elements.setUartButton.disabled = !canControl;
  elements.breakButton.disabled = !connected;
  elements.terminalOutput.classList.toggle("connected", connected);
  elements.terminalInputHint.textContent = t(
    connected ? "terminalInputHint" : "terminalInputDisconnected",
  );
  elements.wifiSetButton.disabled = !canControl;
  elements.wifiOffButton.disabled = !canControl;
  elements.wifiQueryButton.disabled = !canControl;
  elements.wifiScanButton.disabled = !canControl;
  elements.webdavSetButton.disabled = !canControl;
  elements.webdavOffButton.disabled = !canControl;
  elements.webdavQueryButton.disabled = !canControl;
  if (elements.presetChips) {
    elements.presetChips
      .querySelectorAll(".preset-chip")
      .forEach((chip) => (chip.disabled = !connected));
  }
  if (connected) {
    setAutoScroll(true, true);
    state.term.focus();
  }
}

function rememberDevice(device, restored = false) {
  if (!device) {
    return;
  }
  if (state.device && state.device !== device) {
    state.device.removeEventListener(
      "gattserverdisconnected",
      onDisconnected,
    );
  }
  state.device = device;
  state.deviceRestored = restored;
  device.removeEventListener("gattserverdisconnected", onDisconnected);
  device.addEventListener("gattserverdisconnected", onDisconnected);
  saveSetting(LAST_DEVICE_ID_KEY, device.id);
  setConnected(false);
}

async function restoreAuthorizedDevice() {
  if (!navigator.bluetooth?.getDevices) {
    return;
  }
  try {
    const devices = await navigator.bluetooth.getDevices();
    const lastDeviceId = localStorage.getItem(LAST_DEVICE_ID_KEY);
    const candidates = devices.filter(
      (device) =>
        device.id === lastDeviceId ||
        (device.name && device.name.startsWith(BLE_DEVICE_NAME_PREFIX)),
    );
    const device =
      candidates.find((candidate) => candidate.id === lastDeviceId) ||
      candidates[0];

    if (!device) {
      return;
    }
    rememberDevice(device, true);
    appendLine(`[restore] ${device.name || device.id}`);
    toast(t("authorizedDeviceReady"));
  } catch (error) {
    debugLine(`[restore] ${error.message}`);
  }
}

function requestDiagnostics() {
  if (!state.connected) {
    return Promise.resolve();
  }
  state.diagnostics = {};
  renderDiagnostics();
  return sendControl("@i?");
}

function normalizeEnter(text) {
  const mode = elements.enterSelect.value;
  if (mode === "raw") {
    return text;
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const replacement = {
    cr: "\r",
    lf: "\n",
    crlf: "\r\n",
  }[mode];
  return normalized.replace(/\n/g, replacement);
}

function chunkSize() {
  const value = Number(elements.chunkInput.value);
  if (!Number.isFinite(value)) {
    return 20;
  }
  return Math.max(1, Math.min(BLE_MAX_ATT_VALUE, Math.floor(value)));
}

async function writeBytes(bytes, sensitive = false) {
  if (state.mode === "ws") {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    if (elements.debugInput.checked) {
      appendLine(
        sensitive
          ? `TX <redacted ${bytes.length} bytes>`
          : `TX ${bytes.length}: ${JSON.stringify(decoder.decode(bytes))}`,
      );
    }
    state.ws.send(bytes);
    state.txBytes += bytes.length;
    updateCounters();
    return;
  }

  if (!state.reliableRxChar && !state.rxChar) {
    throw new Error("UART RX characteristic is not ready");
  }

  const size = state.reliableRxChar
    ? state.reliableMaxPayload
    : chunkSize();
  for (let offset = 0; offset < bytes.length; offset += size) {
    const chunk = bytes.slice(offset, offset + size);
    if (elements.debugInput.checked) {
      appendLine(
        sensitive
          ? `TX <redacted ${chunk.length} bytes>`
          : `TX ${chunk.length}: ${JSON.stringify(decoder.decode(chunk))}`,
      );
    }
    try {
      if (state.reliableRxChar) {
        await writeReliableUartChunk(chunk);
        state.txBytes += chunk.length;
        continue;
      }
      if (
        state.rxChar.properties.writeWithoutResponse &&
        state.rxChar.writeValueWithoutResponse
      ) {
        await state.rxChar.writeValueWithoutResponse(chunk);
      } else if (state.rxChar.writeValueWithResponse) {
        await state.rxChar.writeValueWithResponse(chunk);
      } else {
        await state.rxChar.writeValue(chunk);
      }
      state.txBytes += chunk.length;
    } catch (error) {
      if (state.reliableRxChar) {
        throw error;
      }
      if (size <= 20) {
        throw error;
      }
      elements.chunkInput.value = "20";
      appendLine("[warn] BLE write failed; retrying with 20-byte chunks");
      await writeBytes(bytes, sensitive);
      return;
    }
  }
  updateCounters();
}

function nextSequence(sequence) {
  return sequence === 0xffffffff ? 1 : sequence + 1;
}

async function writeReliableUartChunk(payload) {
  const sequence = state.reliableTxSequence;
  const frame = new Uint8Array(RELIABLE_UART_HEADER_SIZE + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = 0x4c;
  frame[1] = 0x52;
  frame[2] = 1;
  frame[3] = 0;
  view.setUint32(4, sequence, true);
  view.setUint16(8, payload.length, true);
  view.setUint16(10, 0, true);
  frame.set(payload, RELIABLE_UART_HEADER_SIZE);

  const candidates = [
    Math.min(state.reliableWriteSize, frame.length),
    Math.min(182, frame.length),
    Math.min(128, frame.length),
    Math.min(62, frame.length),
    Math.min(20, frame.length),
  ].filter((size, index, values) => size > 0 && values.indexOf(size) === index);
  let lastError;

  for (const attSize of candidates) {
    let writesCompleted = 0;
    try {
      for (let offset = 0; offset < frame.length; offset += attSize) {
        await state.reliableRxChar.writeValueWithResponse(
          frame.slice(offset, offset + attSize),
        );
        writesCompleted += 1;
      }
      state.reliableWriteSize = attSize;
      state.reliableTxSequence = nextSequence(sequence);
      return;
    } catch (error) {
      lastError = error;
      if (writesCompleted > 0) {
        throw error;
      }
      /* A rejected atomic write has not started a Reliable frame. Retry with
       * the next common ATT payload size and cache the accepted size. */
    }
  }
  throw lastError || new Error("Reliable UART write failed");
}

function enqueueBytes(bytes, sensitive = false) {
  const generation = state.writeGeneration;
  const operation = state.writeQueue.then(() => {
    if (!state.connected || generation !== state.writeGeneration) {
      return;
    }
    return writeBytes(bytes, sensitive);
  });
  state.writeQueue = operation.catch(() => {});
  return operation;
}

async function writeText(text) {
  await enqueueBytes(encoder.encode(text));
}

function sendText(text) {
  if (!state.connected) {
    return Promise.resolve();
  }
  const payload = normalizeEnter(`${text}\n`);
  if (elements.localEchoInput.checked) {
    appendOutput(payload);
  }
  return writeText(payload);
}

function onTerminalData(data) {
  if (!state.connected || !data) {
    return;
  }
  const payload = normalizeEnter(data);
  if (elements.localEchoInput.checked) {
    appendOutput(payload);
  }
  writeText(payload).catch((error) => appendLine(`[error] ${error.message}`));
}

async function sendControl(command) {
  const sensitive = command.startsWith("@w=") || command.startsWith("@d=");
  appendLine(
    `[control] ${sensitive ? `${command.slice(0, 2)}=<redacted>` : command}`,
  );
  if (state.mode !== "ble" || !state.mgmtCommandChar) {
    throw new Error("Management characteristic is not ready");
  }

  const requestId = state.nextRequestId || 1;
  state.nextRequestId = requestId === 0xffffffff ? 1 : requestId + 1;
  const payload = encoder.encode(command);
  const frame = new Uint8Array(MGMT_HEADER_SIZE + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = 0x4c;
  frame[1] = 0x4b;
  frame[2] = MGMT_API_MAJOR;
  frame[3] = 1;
  view.setUint32(4, requestId, true);
  view.setUint16(8, payload.length, true);
  view.setUint16(10, 0, true);
  frame.set(payload, MGMT_HEADER_SIZE);

  const operation = state.controlWriteQueue.then(async () => {
    /* The first GATT write must contain the complete 12-byte management
     * header. Keep 20 bytes as the minimum even if the terminal's raw UART
     * chunk-size control is configured lower. */
    const size = Math.max(20, chunkSize());
    for (let offset = 0; offset < frame.length; offset += size) {
      const chunk = frame.slice(offset, offset + size);
      if (elements.debugInput.checked) {
        appendLine(
          sensitive
            ? `MGMT TX #${requestId} <redacted ${chunk.length} bytes>`
            : `MGMT TX #${requestId} ${chunk.length} bytes`,
        );
      }
      await state.mgmtCommandChar.writeValueWithResponse(chunk);
    }
  });
  state.controlWriteQueue = operation.catch(() => {});
  await operation;
  return requestId;
}

function dispatchManagementMessage(message) {
  const text = decoder.decode(message.payload);
  const kind = message.type === 3 ? "event" : "response";
  if (elements.debugInput.checked) {
    appendLine(
      `[mgmt ${kind} #${message.requestId} flags=0x${message.flags.toString(16)}]`,
    );
  }
  feedRx(text);
  for (const line of text.split(/\r?\n/)) {
    if (line) {
      appendLine(`[${kind} #${message.requestId}] ${line}`);
    }
  }
}

function onManagementIndication(event) {
  const value = event.target.value;
  const bytes = new Uint8Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
  let fragment = bytes;

  if (!state.mgmtRx) {
    if (
      bytes.length < MGMT_HEADER_SIZE ||
      bytes[0] !== 0x4c ||
      bytes[1] !== 0x4b
    ) {
      appendLine("[error] orphaned management fragment");
      return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[2] !== MGMT_API_MAJOR || (bytes[3] !== 2 && bytes[3] !== 3)) {
      appendLine("[error] unsupported management response");
      state.mgmtRx = null;
      return;
    }
    state.mgmtRx = {
      type: bytes[3],
      requestId: view.getUint32(4, true),
      expected: view.getUint16(8, true),
      flags: view.getUint16(10, true),
      payload: [],
      received: 0,
    };
    fragment = bytes.slice(MGMT_HEADER_SIZE);
  }

  const message = state.mgmtRx;
  if (message.received + fragment.length > message.expected) {
    appendLine("[error] oversized management response");
    state.mgmtRx = null;
    return;
  }
  message.payload.push(fragment);
  message.received += fragment.length;
  if (message.received !== message.expected) {
    return;
  }

  const payload = new Uint8Array(message.expected);
  let offset = 0;
  for (const chunk of message.payload) {
    payload.set(chunk, offset);
    offset += chunk.length;
  }
  state.mgmtRx = null;
  dispatchManagementMessage({ ...message, payload });
}

function onReliableUartIndication(event) {
  const value = event.target.value;
  const bytes = new Uint8Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
  let fragment = bytes;

  if (!state.reliableRx) {
    if (
      bytes.length < RELIABLE_UART_HEADER_SIZE ||
      bytes[0] !== 0x4c ||
      bytes[1] !== 0x52
    ) {
      appendLine("[error] orphaned Reliable UART fragment");
      return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[2] !== 1) {
      appendLine("[error] unsupported Reliable UART version");
      state.reliableRx = null;
      return;
    }
    state.reliableRx = {
      sequence: view.getUint32(4, true),
      expected: view.getUint16(8, true),
      chunks: [],
      received: 0,
    };
    fragment = bytes.slice(RELIABLE_UART_HEADER_SIZE);
  }

  const message = state.reliableRx;
  if (message.received + fragment.length > message.expected) {
    appendLine("[error] oversized Reliable UART frame");
    state.reliableRx = null;
    return;
  }
  message.chunks.push(fragment);
  message.received += fragment.length;
  if (message.received !== message.expected) {
    return;
  }

  state.reliableRx = null;
  const previous = state.reliableRxSequence === 1
    ? 0xffffffff
    : state.reliableRxSequence - 1;
  if (message.sequence === previous) {
    return;
  }
  if (message.sequence !== state.reliableRxSequence) {
    appendLine(
      `[error] Reliable UART sequence gap: expected ${state.reliableRxSequence}, got ${message.sequence}`,
    );
    return;
  }
  state.reliableRxSequence = nextSequence(state.reliableRxSequence);
  const payload = new Uint8Array(message.expected);
  let offset = 0;
  for (const chunk of message.chunks) {
    payload.set(chunk, offset);
    offset += chunk.length;
  }
  handleIncomingBytes(payload);
}

function handleIncomingBytes(bytes) {
  appendLogBytes(bytes);
  state.rxBytes += bytes.length;
  updateCounters();
  const text = rxDecoder.decode(bytes, { stream: true });
  if (elements.debugInput.checked) {
    appendLine(`RX ${bytes.length}: ${JSON.stringify(text)}`);
  }
  feedRx(text);
  appendOutput(bytes);
}

function onNotification(event) {
  const view = event.target.value;
  handleIncomingBytes(
    new Uint8Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    ),
  );
}

function onDisconnected() {
  state.rxChar = null;
  state.txChar = null;
  state.mgmtCommandChar = null;
  state.mgmtResponseChar = null;
  state.reliableRxChar = null;
  state.reliableTxChar = null;
  state.reliableMaxPayload = 20;
  state.reliableWriteSize = BLE_MAX_ATT_VALUE;
  state.reliableRx = null;
  state.mgmtRx = null;
  state.deviceId = "";
  state.server = null;
  state.ws = null;
  state.scanning = false;
  state.rxBuffer = "";
  state.diagnostics = {};
  rxDecoder = new TextDecoder();
  clearWifiRefreshTimers();
  clearTimeout(state.scanTimer);
  state.scanResults = [];
  updateWifiDatalist();
  renderDiagnostics();
  setConnected(false);
  appendLine("[disconnected]");
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const host = elements.wsHostInput.value.trim();
    if (!host) {
      reject(new Error(t("wsMissingHost")));
      return;
    }
    saveSetting(WS_HOST_KEY, host);
    const url = /^wss?:\/\//.test(host) ? host : `ws://${host}/ws`;
    const ws = new WebSocket(url);
    let opened = false;
    let settled = false;

    const clearConnectTimer = () => clearTimeout(connectTimer);
    const failConnect = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      clearConnectTimer();
      if (state.ws === ws) {
        state.ws = null;
      }
      reject(new Error(message));
    };
    const connectTimer = setTimeout(() => {
      failConnect(t("wsTimeout"));
      ws.close();
    }, WS_CONNECT_TIMEOUT_MS);

    state.ws = ws;
    state.wsHost = url;
    ws.binaryType = "arraybuffer";
    appendLine(`[connect] ${url}`);

    ws.onopen = () => {
      if (settled) {
        ws.close();
        return;
      }
      settled = true;
      clearConnectTimer();
      opened = true;
      setConnected(true);
      appendLine("[ready]");
      resolve();
    };
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleIncomingBytes(new Uint8Array(event.data));
      } else if (typeof event.data === "string") {
        handleIncomingBytes(encoder.encode(event.data));
      }
    };
    ws.onclose = () => {
      if (opened) {
        onDisconnected();
      } else {
        failConnect(t("wsUnreachable").replace("{url}", url));
      }
    };
    ws.onerror = () => {
      if (!opened) {
        failConnect(t("wsUnreachable").replace("{url}", url));
      }
    };
  });
}

async function connect() {
  if (state.mode === "ws") {
    setConnecting(true);
    try {
      await connectWs();
    } catch (error) {
      appendLine(`[error] ${error.message}`);
      setConnected(false);
    } finally {
      setConnecting(false);
    }
    return;
  }

  if (!navigator.bluetooth) {
    appendLine("[error] Web Bluetooth is not available in this browser");
    return;
  }

  setConnecting(true);
  const restoredAttempt = Boolean(state.device && state.deviceRestored);
  try {
    let device = state.device;
    if (!device) {
      appendLine(`[scan] requesting Linkr Management v1 device`);
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [MGMT_SERVICE] }],
        optionalServices: [MGMT_SERVICE, NUS_SERVICE, RELIABLE_UART_SERVICE],
      });
      rememberDevice(device);
    }

    appendLine(`[connect] ${device.name || device.id}`);
    state.server = await device.gatt.connect();
    const service = await state.server.getPrimaryService(NUS_SERVICE);
    state.rxChar = await service.getCharacteristic(NUS_RX);
    state.txChar = await service.getCharacteristic(NUS_TX);
    const mgmtService = await state.server.getPrimaryService(MGMT_SERVICE);
    const protocolChar = await mgmtService.getCharacteristic(MGMT_PROTOCOL);
    const deviceIdChar = await mgmtService.getCharacteristic(MGMT_DEVICE_ID);
    state.mgmtCommandChar = await mgmtService.getCharacteristic(MGMT_COMMAND);
    state.mgmtResponseChar = await mgmtService.getCharacteristic(MGMT_RESPONSE);
    const protocolValue = await protocolChar.readValue();
    if (protocolValue.byteLength < 10 || protocolValue.getUint8(0) !== MGMT_API_MAJOR) {
      throw new Error("Unsupported Linkr Management API version");
    }
    const deviceIdValue = await deviceIdChar.readValue();
    state.deviceId = Array.from(
      new Uint8Array(
        deviceIdValue.buffer.slice(
          deviceIdValue.byteOffset,
          deviceIdValue.byteOffset + deviceIdValue.byteLength,
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await state.mgmtResponseChar.startNotifications();
    state.mgmtResponseChar.addEventListener(
      "characteristicvaluechanged",
      onManagementIndication,
    );
    const reliableService = await state.server.getPrimaryService(
      RELIABLE_UART_SERVICE,
    );
    state.reliableRxChar = await reliableService.getCharacteristic(
      RELIABLE_UART_RX,
    );
    state.reliableTxChar = await reliableService.getCharacteristic(
      RELIABLE_UART_TX,
    );
    const reliableStateChar = await reliableService.getCharacteristic(
      RELIABLE_UART_STATE,
    );
    const reliableState = await reliableStateChar.readValue();
    if (reliableState.byteLength < 16 || reliableState.getUint8(0) !== 1) {
      throw new Error("Unsupported Reliable UART version");
    }
    state.reliableMaxPayload = Math.max(
      1,
      Math.min(
        reliableState.getUint16(2, true),
        BLE_MAX_ATT_VALUE - RELIABLE_UART_HEADER_SIZE,
      ),
    );
    state.reliableWriteSize = BLE_MAX_ATT_VALUE;
    state.reliableTxSequence = reliableState.getUint32(4, true);
    state.reliableRxSequence = reliableState.getUint32(8, true);
    await state.reliableTxChar.startNotifications();
    state.reliableTxChar.addEventListener(
      "characteristicvaluechanged",
      onReliableUartIndication,
    );
    state.deviceRestored = false;
    setConnected(true);
    appendLine(`[ready] API v${protocolValue.getUint8(0)}.${protocolValue.getUint8(1)} device=${state.deviceId}`);
    requestWifiState().catch((error) =>
      appendLine(`[error] ${error.message}`),
    );
  } catch (error) {
    appendLine(`[error] ${error.message}`);
    if (restoredAttempt) {
      localStorage.removeItem(LAST_DEVICE_ID_KEY);
      if (state.device) {
        state.device.removeEventListener(
          "gattserverdisconnected",
          onDisconnected,
        );
      }
      state.device = null;
      state.deviceRestored = false;
      appendLine(`[restore] ${t("authorizedDeviceFailed")}`);
      toast(t("authorizedDeviceFailed"), "error");
    }
    setConnected(false);
  } finally {
    setConnecting(false);
  }
}

async function disconnect() {
  if (state.mode === "ws") {
    if (state.ws) {
      state.ws.close();
    } else {
      onDisconnected();
    }
    return;
  }

  if (state.mgmtResponseChar) {
    try {
      await state.mgmtResponseChar.stopNotifications();
    } catch (_error) {
      // Ignore disconnect races.
    }
  }
  if (state.reliableTxChar) {
    try {
      await state.reliableTxChar.stopNotifications();
    } catch (_error) {
      // Ignore disconnect races.
    }
  }

  if (state.device && state.device.gatt.connected) {
    state.device.gatt.disconnect();
  } else {
    onDisconnected();
  }
}

function clearTerminalOutput(resetTerminal) {
  if (!state.term) {
    elements.terminalOutput.replaceChildren();
    return;
  }
  if (resetTerminal) {
    state.term.reset();
  }
  state.term.clear();
  fitTerminal();
}

function saveLog() {
  const chunks = state.logBytes.length
    ? state.logBytes
    : [encoder.encode(elements.terminalOutput.textContent)];
  const blob = new Blob(chunks, { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `linkr-ble-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  link.click();
  URL.revokeObjectURL(url);
  toast(t("saved"));
}

function loadPersisted() {
  const uart = localStorage.getItem("linkr-uart");
  if (uart) {
    elements.uartInput.value = uart;
  }
  const enter = localStorage.getItem("linkr-enter");
  if (enter) {
    elements.enterSelect.value = enter;
  }
  const chunk = localStorage.getItem("linkr-chunk");
  if (chunk) {
    elements.chunkInput.value = chunk;
  }
  if (localStorage.getItem("linkr-echo") === "1") {
    elements.localEchoInput.checked = true;
  }
  if (localStorage.getItem("linkr-debug") === "1") {
    elements.debugInput.checked = true;
  }
  const fs = parseInt(localStorage.getItem("linkr-font"), 10);
  if (Number.isFinite(fs)) {
    state.fontSize = fs;
  }
  const fontFamily = localStorage.getItem(FONT_FAMILY_KEY);
  state.fontFamily = TERMINAL_FONTS[fontFamily] ? fontFamily : "system";
  applyTerminalFont(state.fontFamily);
  state.sidebarCollapsed = localStorage.getItem("linkr-sidebar") === "collapsed";
  const savedHost = localStorage.getItem(WS_HOST_KEY);
  if (savedHost && elements.wsHostInput) {
    elements.wsHostInput.value = savedHost;
  }
  updateBaudLabel();
}

function updateBaudLabel() {
  const baud = String(elements.uartInput.value || "").split(",")[0].trim();
  if (elements.baudLabel && baud) {
    elements.baudLabel.textContent = baud;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_error) {
    // Storage may be unavailable; ignore.
  }
}

const mobileMedia = window.matchMedia("(max-width: 900px)");

function isMobile() {
  return mobileMedia.matches;
}

function applySidebar() {
  const shell = document.querySelector(".app-shell");
  if (state.sidebarCollapsed && !isMobile()) {
    shell.classList.add("controls-hidden");
  }
}

function toggleSidebar() {
  const shell = document.querySelector(".app-shell");
  if (isMobile()) {
    shell.classList.toggle("sidebar-open");
  } else {
    const hidden = shell.classList.toggle("controls-hidden");
    state.sidebarCollapsed = hidden;
    saveSetting("linkr-sidebar", hidden ? "collapsed" : "open");
  }
}

function syncSidebarForViewport() {
  const shell = document.querySelector(".app-shell");
  if (isMobile()) {
    shell.classList.remove("controls-hidden");
  } else {
    shell.classList.remove("sidebar-open");
  }
}

function changeFontSize(delta) {
  const next = Math.max(10, Math.min(28, state.fontSize + delta));
  if (next === state.fontSize) {
    return;
  }
  state.fontSize = next;
  if (state.term) {
    state.term.options.fontSize = next;
    fitTerminal();
  }
  saveSetting("linkr-font", String(next));
}

function bind() {
  elements.connectButton.addEventListener("click", () => {
    connect().catch((error) => appendLine(`[error] ${error.message}`));
  });

  if (elements.mobileConnectBtn) {
    elements.mobileConnectBtn.addEventListener("click", () => {
      connect().catch((error) => appendLine(`[error] ${error.message}`));
    });
  }

  elements.disconnectButton.addEventListener("click", () => {
    disconnect().catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.reconnectButton.addEventListener("click", () => {
    connect().catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.queryButton.addEventListener("click", () => {
    sendControl("@u?").catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.diagnosticsButton.addEventListener("click", () => {
    requestDiagnostics().catch((error) =>
      appendLine(`[error] ${error.message}`),
    );
  });
  elements.diagnosticsPanel.addEventListener("toggle", () => {
    if (elements.diagnosticsPanel.open && state.connected) {
      requestDiagnostics().catch((error) =>
        appendLine(`[error] ${error.message}`),
      );
    }
  });

  elements.setUartButton.addEventListener("click", () => {
    const value = elements.uartInput.value.trim();
    sendControl(`@u=${value}`)
      .then(() => {
        updateBaudLabel();
        toast(t("uartSet"));
      })
      .catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.clearButton.addEventListener("click", () => {
    clearTerminalOutput(true);
    state.logBytes = [];
    state.logSize = 0;
    toast(t("cleared"));
  });

  elements.saveButton.addEventListener("click", saveLog);

  elements.breakButton.addEventListener("click", () => {
    enqueueBytes(new Uint8Array([0x03]))
      .then(() => state.term?.focus())
      .catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.wifiSetButton.addEventListener("click", () => {
    const ssid = elements.wifiSsidInput.value.trim();
    const password = elements.wifiPasswordInput.value;

    if (!ssid) {
      elements.wifiFeedback.textContent = t("wifiMissingSsid");
      elements.wifiSsidInput.focus();
      return;
    }
    sendControl(`@w=${ssid},${password}`)
      .then(() => {
        state.wifiStatus.ssid = ssid;
        toast(t("wifiSet"));
        scheduleWifiStateRefresh();
      })
      .catch((error) => appendLine(`[error] ${error.message}`));
  });
  elements.wifiPasswordToggle.addEventListener("click", () => {
    const show = elements.wifiPasswordInput.type === "password";
    elements.wifiPasswordInput.type = show ? "text" : "password";
    elements.wifiPasswordToggle.setAttribute("aria-pressed", String(show));
    elements.wifiPasswordToggle.setAttribute(
      "aria-label",
      t(show ? "hidePassword" : "showPassword"),
    );
  });
  elements.wifiNetworkList.addEventListener("click", (event) => {
    const button = event.target.closest(".wifi-network[data-ssid]");
    if (!button) {
      return;
    }
    elements.wifiSsidInput.value = button.dataset.ssid || "";
    elements.wifiPasswordInput.focus();
  });
  elements.wifiOffButton.addEventListener("click", () => {
    sendControl("@w off")
      .then(() => {
        state.wifiStatus = { connected: false, ssid: "", ip: "down" };
        updateWifiConnectionView();
      })
      .catch((error) => appendLine(`[error] ${error.message}`));
  });
  elements.wifiQueryButton.addEventListener("click", () => {
    sendControl("@w?").catch((error) => appendLine(`[error] ${error.message}`));
  });
  elements.wifiScanButton.addEventListener("click", () => {
    scanWifi().catch((error) => appendLine("[error] " + error.message));
  });
  elements.webdavSetButton.addEventListener("click", () => {
    sendControl(`@d=${elements.webdavInput.value.trim()}`)
      .then(() => toast(t("webdavSet")))
      .catch((error) => appendLine(`[error] ${error.message}`));
  });
  elements.webdavOffButton.addEventListener("click", () => {
    sendControl("@d off").catch((error) => appendLine(`[error] ${error.message}`));
  });
  elements.webdavQueryButton.addEventListener("click", () => {
    sendControl("@d?").catch((error) => appendLine(`[error] ${error.message}`));
  });

  if (elements.presetChips) {
    elements.presetChips.querySelectorAll(".preset-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const cmd = chip.getAttribute("data-cmd");
        if (cmd) {
          sendText(cmd).catch((error) =>
            appendLine(`[error] ${error.message}`),
          );
        }
      });
    });
  }

  const cheatList = document.getElementById("cheatList");
  if (cheatList) {
    cheatList.addEventListener("click", (event) => {
      const item = event.target.closest(".ref-item[data-cmd]");
      if (!item) {
        return;
      }
      const cmd = item.getAttribute("data-cmd");
      if (cmd) {
        sendText(cmd).catch((error) => appendLine(`[error] ${error.message}`));
      }
    });
  }

  elements.zoomInBtn.addEventListener("click", () => changeFontSize(1));
  elements.zoomOutBtn.addEventListener("click", () => changeFontSize(-1));
  elements.fullscreenBtn.addEventListener("click", () => {
    toggleTerminalFullscreen().catch((error) =>
      appendLine(`[error] ${error.message}`),
    );
  });
  elements.autoscrollBtn.addEventListener("click", () => {
    setAutoScroll(!state.autoScroll, true);
  });
  elements.copyBtn.addEventListener("click", () => {
    if (!state.term) {
      return;
    }
    const sel = state.term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel).then(
        () => toast(t("copied")),
        () => toast(t("copied")),
      );
    }
  });

  elements.themeButton.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, theme);
    applyTheme();
  });

  elements.langButton.addEventListener("click", () => {
    lang = lang === "zh" ? "en" : "zh";
    localStorage.setItem(LANG_KEY, lang);
    applyLang();
  });

  elements.bleModeBtn.addEventListener("click", () => setTransportMode("ble"));
  elements.lanModeBtn.addEventListener("click", () => setTransportMode("ws"));

  elements.panelToggle.addEventListener("click", toggleSidebar);
  elements.drawerClose.addEventListener("click", () => {
    document.querySelector(".app-shell").classList.remove("sidebar-open");
  });
  elements.drawerBackdrop.addEventListener("click", () => {
    document.querySelector(".app-shell").classList.remove("sidebar-open");
  });

  document.addEventListener("fullscreenchange", onFullscreenChange);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      document.querySelector(".app-shell").classList.remove("sidebar-open");
      if (
        elements.terminalCard.classList.contains(
          "terminal-fullscreen-fallback",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
        setTerminalFallbackFullscreen(false);
      }
    }
  }, true);

  elements.uartInput.addEventListener("change", () => {
    saveSetting("linkr-uart", elements.uartInput.value.trim());
    updateBaudLabel();
  });
  elements.enterSelect.addEventListener("change", () =>
    saveSetting("linkr-enter", elements.enterSelect.value),
  );
  elements.chunkInput.addEventListener("change", () =>
    saveSetting("linkr-chunk", elements.chunkInput.value),
  );
  elements.fontSelect.addEventListener("change", () => {
    applyTerminalFont(elements.fontSelect.value, true);
    toast(t("fontApplied"));
  });
  elements.localEchoInput.addEventListener("change", () =>
    saveSetting("linkr-echo", elements.localEchoInput.checked ? "1" : "0"),
  );
  elements.debugInput.addEventListener("change", () =>
    saveSetting("linkr-debug", elements.debugInput.checked ? "1" : "0"),
  );
}

function init() {
  loadPersisted();
  initTerminal();
  applyTheme();
  applyLang();
  applySidebar();
  if (localStorage.getItem(TRANSPORT_KEY) === "ws") {
    setTransportMode("ws");
  }
  setConnected(false);
  bind();
  syncSidebarForViewport();
  if (mobileMedia.addEventListener) {
    mobileMedia.addEventListener("change", syncSidebarForViewport);
  } else if (mobileMedia.addListener) {
    mobileMedia.addListener(syncSidebarForViewport);
  }
  if (state.term) {
    const vp = elements.terminalOutput.querySelector(".xterm-viewport");
    if (vp) {
      vp.addEventListener("scroll", onViewportScroll, { passive: true });
    }
  }
  appendLine(t("welcome"));
  if (state.mode === "ble") {
    restoreAuthorizedDevice().catch((error) =>
      debugLine(`[restore] ${error.message}`),
    );
  }
}

init();
