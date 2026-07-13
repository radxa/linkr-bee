"use strict";

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const BLE_DEVICE_NAME_PREFIX = "Linkr BLE UART";
const WIFI_SCAN_CMD = "@w scan";
const WIFI_SCAN_PREFIX = "@scan ";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const state = {
  device: null,
  server: null,
  rxChar: null,
  txChar: null,
  term: null,
  fitAddon: null,
  resizeObserver: null,
  connected: false,
  termReady: false,
  logBytes: [],
  autoScroll: true,
  fontSize: 13,
  rxBytes: 0,
  txBytes: 0,
  writeQueue: Promise.resolve(),
  writeGeneration: 0,
  sidebarCollapsed: false,
  scanning: false,
  scanResults: [],
  scanTimer: null,
  rxBuffer: "",
};

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
  setUartButton: $("setUartButton"),
  clearButton: $("clearButton"),
  saveButton: $("saveButton"),
  terminalOutput: $("terminalOutput"),
  terminalInputHint: $("terminalInputHint"),
  breakButton: $("breakButton"),
  uartInput: $("uartInput"),
  enterSelect: $("enterSelect"),
  chunkInput: $("chunkInput"),
  localEchoInput: $("localEchoInput"),
  debugInput: $("debugInput"),
  wifiInput: $("wifiInput"),
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
};

const THEME_KEY = "linkr-theme";
const LANG_KEY = "linkr-lang";

const XTERM_DARK = {
  background: "#07090c",
  foreground: "#d8f3dc",
  cursor: "#d8f3dc",
  selectionBackground: "#315a42",
};

const XTERM_LIGHT = {
  background: "#f8fafc",
  foreground: "#1f6b43",
  cursor: "#1f6b43",
  selectionBackground: "#bfe3cf",
};

const I18N = {
  en: {
    title: "Linkr BLE Terminal",
    checking: "Checking Web Bluetooth…",
    supported: "Chrome/Chromium Web Bluetooth over HTTPS or localhost",
    unsupported: "Web Bluetooth unavailable in this browser",
    xtermFail: "xterm.js failed to load; check network access to jsDelivr",
    connected: "Connected",
    disconnected: "Disconnected",
    connection: "Connection",
    terminalSettings: "Terminal Settings",
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
    localEcho: "Local echo",
    debugIO: "Debug I/O",
    wifi: "WiFi",
    webdav: "WebDAV",
    serialOutput: "Serial Terminal",
    terminalAria: "Interactive serial terminal",
    xterm: "xterm.js",
    terminalInputHint: "Type here · Tab completes · Arrow keys browse history",
    terminalInputDisconnected: "Connect a device to enable terminal input",
    placeholderWifi: "SSID,pass",
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
    welcome: "Linkr BLE Terminal ready. Press Connect to pair a device.",
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
    scanFailed: "Wi-Fi scan failed; complete BLE pairing and retry",
    light: "Light",
    dark: "Dark",
  },
  zh: {
    title: "Linkr BLE 终端",
    checking: "正在检测 Web Bluetooth…",
    supported: "Chrome/Chromium 需通过 HTTPS 或 localhost 使用 Web Bluetooth",
    unsupported: "当前浏览器不支持 Web Bluetooth",
    xtermFail: "xterm.js 加载失败，请检查对 jsDelivr 的网络访问",
    connected: "已连接",
    disconnected: "未连接",
    connection: "连接",
    terminalSettings: "终端设置",
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
    localEcho: "本地回显",
    debugIO: "调试 I/O",
    wifi: "WiFi",
    webdav: "WebDAV",
    serialOutput: "串口终端",
    terminalAria: "交互式串口终端",
    xterm: "xterm.js",
    terminalInputHint: "直接输入 · Tab 补全 · 方向键浏览历史",
    terminalInputDisconnected: "连接设备后即可在终端内直接输入",
    placeholderWifi: "SSID,密码",
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
    welcome: "Linkr BLE 终端已就绪，点击「连接」配对设备。",
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
    scanFailed: "Wi-Fi 扫描失败，请完成 BLE 配对后重试",
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
    elements.themeColorMeta.content = theme === "dark" ? "#0d1014" : "#eef2f8";
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
  elements.supportText.textContent = navigator.bluetooth
    ? t("supported")
    : t("unsupported");
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
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: state.fontSize,
    lineHeight: 1,
    scrollback: 10000,
    tabStopWidth: 8,
    theme: theme === "dark" ? XTERM_DARK : XTERM_LIGHT,
  });
  state.fitAddon = new globalThis.FitAddon.FitAddon();
  state.term.loadAddon(state.fitAddon);
  state.term.open(elements.terminalOutput);
  state.term.onData(onTerminalData);
  fitTerminal();

  window.addEventListener("resize", fitTerminal);
  if (globalThis.ResizeObserver) {
    state.resizeObserver = new ResizeObserver(fitTerminal);
    state.resizeObserver.observe(elements.terminalOutput);
  }

  return true;
}

function appendOutput(data) {
  if (!state.term) {
    const text =
      data instanceof Uint8Array ? decoder.decode(data) : String(data);
    elements.terminalOutput.append(document.createTextNode(text));
    elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
    return;
  }
  state.term.write(data);
}

function appendLine(text) {
  appendOutput(`${text}\r\n`);
}

function debugLine(text) {
  if (elements.debugInput.checked) {
    appendLine(text);
  }
}

function toast(message) {
  const host = document.getElementById("toastHost");
  if (!host) {
    return;
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 2200);
}

function updateCounters() {
  if (elements.rxCount) {
    elements.rxCount.textContent = state.rxBytes.toLocaleString();
  }
  if (elements.txCount) {
    elements.txCount.textContent = state.txBytes.toLocaleString();
  }
}

function updateWifiDatalist() {
  const list = elements.wifiSsidList;
  if (!list) {
    return;
  }
  list.innerHTML = state.scanResults
    .map((s) => `<option value="${escapeHtml(s)}"></option>`)
    .join("");
}

function parseSsid(raw) {
  let s = String(raw).trim();
  if (!s || s.length > 32) {
    return null;
  }
  if (/^[[@]/.test(s)) {
    return null;
  }
  s = s.replace(/^\d+[).]\s*/, "");
  s = s.replace(/\s+-\d+\s*dBm?$/i, "");
  s = s.replace(/^["']|["']$/g, "");
  s = s.trim();
  if (!s || s === "<hidden>") {
    return null;
  }
  return s;
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
  if (!state.scanning) {
    return;
  }
  const scanLine = String(line).trim();
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
  const ssid = parseSsid(scanLine.slice(resultPrefix.length));
  if (ssid && !state.scanResults.includes(ssid)) {
    state.scanResults.push(ssid);
    updateWifiDatalist();
  }
}

async function scanWifi() {
  if (!state.connected) {
    return;
  }
  state.scanning = true;
  state.scanResults = [];
  state.rxBuffer = "";
  updateWifiDatalist();
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
    toast(t("scanFailed"));
    return;
  }
  if (state.scanResults.length) {
    toast(t("foundN").replace("{n}", String(state.scanResults.length)));
  } else {
    toast(t("noNetworks"));
  }
}

function setAutoScroll(value, scroll) {
  state.autoScroll = value;
  if (elements.autoscrollBtn) {
    elements.autoscrollBtn.setAttribute("aria-pressed", String(value));
    elements.autoscrollBtn.classList.toggle("active", value);
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
  const label = btn.querySelector(".btn-label");
  if (connecting) {
    if (label) {
      label.textContent = t("connecting");
    }
  } else if (label) {
    label.textContent = t("connect");
  }
}

function setConnected(connected) {
  const canConnect = Boolean(navigator.bluetooth) && Boolean(state.term);

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
  elements.deviceName.textContent = connected && state.device
    ? state.device.name || state.device.id
    : "";
  elements.connectButton.disabled = connected || !canConnect;
  elements.disconnectButton.disabled = !connected;
  elements.reconnectButton.disabled = !state.device || connected;
  elements.queryButton.disabled = !connected;
  elements.setUartButton.disabled = !connected;
  elements.breakButton.disabled = !connected;
  elements.terminalOutput.classList.toggle("connected", connected);
  elements.terminalInputHint.textContent = t(
    connected ? "terminalInputHint" : "terminalInputDisconnected",
  );
  elements.wifiSetButton.disabled = !connected;
  elements.wifiOffButton.disabled = !connected;
  elements.wifiQueryButton.disabled = !connected;
  elements.wifiScanButton.disabled = !connected;
  elements.webdavSetButton.disabled = !connected;
  elements.webdavOffButton.disabled = !connected;
  elements.webdavQueryButton.disabled = !connected;
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
  return Math.max(1, Math.min(62, Math.floor(value)));
}

async function writeBytes(bytes, sensitive = false) {
  if (!state.rxChar) {
    throw new Error("RX characteristic is not ready");
  }

  const size = chunkSize();
  for (let offset = 0; offset < bytes.length; offset += size) {
    const chunk = bytes.slice(offset, offset + size);
    debugLine(
      sensitive
        ? `TX <redacted ${chunk.length} bytes>`
        : `TX ${chunk.length}: ${JSON.stringify(decoder.decode(chunk))}`,
    );
    try {
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
  const payload = encoder.encode(command);
  const header = encoder.encode(`@!${payload.length}:`);
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header);
  frame.set(payload, header.length);
  await enqueueBytes(frame, sensitive);
}

function onNotification(event) {
  const view = event.target.value;
  const bytes = new Uint8Array(
    view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
  );
  state.logBytes.push(bytes);
  state.rxBytes += bytes.length;
  updateCounters();
  const text = decoder.decode(bytes);
  debugLine(`RX ${bytes.length}: ${JSON.stringify(text)}`);
  feedRx(text);
  appendOutput(bytes);
}

function onDisconnected() {
  state.rxChar = null;
  state.txChar = null;
  state.server = null;
  state.scanning = false;
  clearTimeout(state.scanTimer);
  state.scanResults = [];
  updateWifiDatalist();
  setConnected(false);
  appendLine("[disconnected]");
}

async function connect() {
  if (!navigator.bluetooth) {
    appendLine("[error] Web Bluetooth is not available in this browser");
    return;
  }

  setConnecting(true);
  try {
    let device = state.device;
    if (!device) {
      appendLine(`[scan] requesting NUS device (${BLE_DEVICE_NAME_PREFIX}*)`);
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE] }],
        optionalServices: [NUS_SERVICE],
      });
      state.device = device;
      device.addEventListener("gattserverdisconnected", onDisconnected);
    }

    appendLine(`[connect] ${device.name || device.id}`);
    state.server = await device.gatt.connect();
    const service = await state.server.getPrimaryService(NUS_SERVICE);
    state.rxChar = await service.getCharacteristic(NUS_RX);
    state.txChar = await service.getCharacteristic(NUS_TX);

    await state.txChar.startNotifications();
    state.txChar.addEventListener("characteristicvaluechanged", onNotification);
    setConnected(true);
    appendLine("[ready]");
  } catch (error) {
    appendLine(`[error] ${error.message}`);
    setConnected(false);
  } finally {
    setConnecting(false);
  }
}

async function disconnect() {
  if (state.txChar) {
    try {
      await state.txChar.stopNotifications();
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
  state.sidebarCollapsed = localStorage.getItem("linkr-sidebar") === "collapsed";
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

function isMobile() {
  return window.matchMedia("(max-width: 900px)").matches;
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

  elements.disconnectButton.addEventListener("click", () => {
    disconnect().catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.reconnectButton.addEventListener("click", () => {
    connect().catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.queryButton.addEventListener("click", () => {
    sendControl("@u?").catch((error) => appendLine(`[error] ${error.message}`));
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
    toast(t("cleared"));
  });

  elements.saveButton.addEventListener("click", saveLog);

  elements.breakButton.addEventListener("click", () => {
    enqueueBytes(new Uint8Array([0x03]))
      .then(() => state.term?.focus())
      .catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.wifiSetButton.addEventListener("click", () => {
    sendControl(`@w=${elements.wifiInput.value.trim()}`)
      .then(() => toast(t("wifiSet")))
      .catch((error) => appendLine(`[error] ${error.message}`));
  });
  elements.wifiOffButton.addEventListener("click", () => {
    sendControl("@w off").catch((error) => appendLine(`[error] ${error.message}`));
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
  setConnected(false);
  bind();
  syncSidebarForViewport();
  window.addEventListener("resize", syncSidebarForViewport);
  if (state.term) {
    const vp = elements.terminalOutput.querySelector(".xterm-viewport");
    if (vp) {
      vp.addEventListener("scroll", onViewportScroll);
    }
  }
  appendLine(t("welcome"));
}

init();
