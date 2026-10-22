"use strict";

import { createLanTokenStore } from "./lan_token_store.js";
import {
  ACCESSORY_LIMITS,
  BLE_NAME_QUERY_COMMAND,
  DIAGNOSTICS_COMMAND,
  UART_QUERY_COMMAND,
  WIFI_QUERY_COMMAND,
  WEBDAV_QUERY_COMMAND,
  bleNameCommand,
  parseBleName,
  parseInfoGroups,
  parseUartSettings,
  parseWebdavStatus,
  parseWifiStatus,
  printableDeviceName,
  redactCommand,
  replyStatus,
  setUartCommand,
  webdavCommand,
  wifiCommand,
} from "./accessory_control.js";

import {
  ManagementResponseTracker,
  MGMT_API_MAJOR,
  MGMT_FRAME_ERRORS,
  MGMT_HEADER_SIZE,
  RELIABLE_FRAME_ERRORS,
  RELIABLE_UART_HEADER_SIZE,
  createFragmentReassembler,
  parseManagementHeader,
  parseReliableHeader,
  parseWifiEvent,
  wifiProvisioningComplete,
} from "./management_protocol.js";
import { applyInputModifiers, terminalKeySequence } from "./terminal_keys.js";
import { subscribeTerminalInput } from "./terminal_input.js";
import { SerialJournal } from "./serial_journal.js";
import { createAgentPanel } from "./agent_panel.js";
import { createAgentSettings } from "./agent_settings.js";
import { createAboutPage } from "./about_page.js";
import { inputLeavesPendingLine } from "./agent_execution_policy.js";
import {
  createTerminalSessionTracker,
  looksLikeShellPrompt,
  normalizeTerminalGeometry,
  terminalGeometryCommand,
} from "./terminal_geometry.js";

const terminalSessionTracker = createTerminalSessionTracker();

const agentJournal = new SerialJournal();
let agentPanel = null;
let agentSettings = null;
let aboutPage = null;
let serialInputRevision = 0;
let serialInputPending = false;
let bleNotificationSession = null;

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
const MGMT_CAP_WIFI = 1 << 0;
const MGMT_CAP_WEBDAV = 1 << 1;
const MGMT_CAP_WEBSOCKET = 1 << 2;
const MGMT_CAP_DEVICE_ID = 1 << 3;
const MGMT_CAP_ASYNC_EVENTS = 1 << 4;
const MGMT_CAP_RELIABLE_UART = 1 << 5;
const BLE_MAX_ATT_VALUE = 244;
const LEGACY_BLE_DEVICE_NAME_PREFIX = "Linkr BLE UART";
/* A Linkr Bee is a device that speaks the Management Service, and that is
 * how the picker finds one: the advertised name is a label the owner can
 * change, so a name filter would find the factory names and nothing else.
 * The oldest NUS-only firmware has no service to be found by and no
 * per-device name, so its fixed name is offered as well; whether a board is
 * one of those is decided by the service it does not have, not by its
 * name. */
const BLE_REQUEST_FILTERS = [
  { services: [MGMT_SERVICE] },
  { namePrefix: LEGACY_BLE_DEVICE_NAME_PREFIX },
];

/* Whether a failed read says the Management Service is not there, as
 * opposed to the read being refused: a board that is not paired yet, or
 * one whose encryption is not in place yet. The first is a legacy board
 * whose terminal still works; the second is a pairing problem, and calling
 * it a legacy board would hide the reason the user needs. */
function isMissingService(error) {
  const name = error?.name || "";
  const text = String(error?.message || "").toLowerCase();
  return (
    name === "NotFoundError" ||
    text.includes("no characteristic") ||
    text.includes("no service") ||
    text.includes("not found") ||
    text.includes("unknown service")
  );
}

const WIFI_SCAN_CMD = "@w scan";
const WIFI_SCAN_PREFIX = "@scan ";
const WIFI_SCAN_TIMEOUT_MS = 50000;
/* Assistant-facing state: one in-flight `@i?` collection and the waiters for a
 * scan the assistant started. Both settle from the existing event handlers. */
let infoCollection = null;
const scanWaiters = [];
const WS_CONNECT_TIMEOUT_MS = 15000;
const bleTransport = window.LinkrBleTransport;
const coarsePointerMedia = window.matchMedia("(pointer: coarse)");
const isHarmonyHost =
  window.LinkrNativeBle?.platform === "harmonyos" ||
  document.documentElement.dataset.platform === "harmonyos";
const prefersSettingsDrawer = isHarmonyHost || coarsePointerMedia.matches;

document.documentElement.classList.toggle(
  "settings-drawer-layout",
  prefersSettingsDrawer,
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let rxDecoder = new TextDecoder();

const state = {
  device: null,
  nusReady: false,
  mgmtReady: false,
  reliableReady: false,
  legacy: false,
  reliableTxSequence: 1,
  reliableRxSequence: 1,
  reliableRxDesync: false,
  reliableMaxPayload: 20,
  reliableWriteSize: BLE_MAX_ATT_VALUE,
  deviceId: "",
  mgmtCapabilities: 0,
  mgmtMaxPayload: 512,
  nextRequestId: 1,
  mgmtResponses: new ManagementResponseTracker(),
  controlWriteQueue: Promise.resolve(),
  mgmtWriteError: "",
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
  fontSize: isHarmonyHost ? 11 : 13,
  fontFamily: "system",
  rxBytes: 0,
  txBytes: 0,
  writeQueue: Promise.resolve(),
  writeGeneration: 0,
  uartWriteError: "",
  controlPending: false,
  shiftPending: false,
  altPending: false,
  deviceRestored: false,
  sidebarCollapsed: true,
  scanning: false,
  scanResults: [],
  scanTimer: null,
  wifiRefreshTimers: [],
  wifiStatus: { connected: false, ssid: "", ip: "down" },
  /* Accepted @w= provisioning operation: { id, ssid }. Cleared once the bridge
   * reports a FINAL phase, or when the fallback poll takes over. */
  wifiOperation: null,
  wifiOperationTimer: null,
  bleName: null,
  bleNameCustom: null,
  bleNameSupported: null,
  diagnostics: {},
  logSize: 0,
  terminalGeometry: null,
  terminalGeometrySynced: "",
  terminalGeometrySyncInFlight: "",
  terminalGeometrySyncTimer: null,
  terminalGeometrySession: 0,
  shellPromptVisible: false,
};

const LOG_CAP_BYTES = 4 * 1024 * 1024;

const $ = (id) => document.getElementById(id);

const elements = {
  appShell: document.querySelector(".app-shell"),
  topbar: document.querySelector(".topbar"),
  controlsPanel: $("controlsPanel"),
  workpanel: document.querySelector(".workpanel"),
  supportText: $("supportText"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  deviceName: $("deviceName"),
  connectButton: $("connectButton"),
  disconnectButton: $("disconnectButton"),
  switchDeviceButton: $("switchDeviceButton"),
  queryButton: $("queryButton"),
  diagnosticsPanel: $("diagnosticsPanel"),
  diagnosticsButton: $("diagnosticsButton"),
  diagFirmware: $("diagFirmware"),
  diagUptime: $("diagUptime"),
  diagOwner: $("diagOwner"),
  diagUart: $("diagUart"),
  diagWifi: $("diagWifi"),
  diagUpload: $("diagUpload"),
  bleNameInput: $("bleNameInput"),
  bleNameSetButton: $("bleNameSetButton"),
  bleNameDefaultButton: $("bleNameDefaultButton"),
  bleNameQueryButton: $("bleNameQueryButton"),
  bleNameStatus: $("bleNameStatus"),
  setUartButton: $("setUartButton"),
  clearButton: $("clearButton"),
  saveButton: $("saveButton"),
  terminalOutput: $("terminalOutput"),
  terminalInputHint: $("terminalInputHint"),
  focusTerminalButton: $("focusTerminalButton"),
  breakButton: $("breakButton"),
  terminalKeyBar: $("terminalKeyBar"),
  controlKeyButton: $("controlKeyButton"),
  modifierButtons: document.querySelectorAll("[data-modifier]"),
  pasteTerminalButton: $("pasteTerminalButton"),
  terminalKeyButtons: document.querySelectorAll("[data-terminal-key]"),
  uartInput: $("uartInput"),
  baudSelect: $("baudSelect"),
  baudCustomField: $("baudCustomField"),
  baudCustomInput: $("baudCustomInput"),
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
  drawerThemeButton: $("drawerThemeButton"),
  drawerLangButton: $("drawerLangButton"),
  drawerBackdrop: $("drawerBackdrop"),
  controls: document.querySelector(".controls"),
  settingsTabs: document.querySelectorAll("[data-settings-target]"),
  themeColorMeta: $("themeColorMeta"),
  bleModeBtn: $("bleModeBtn"),
  lanModeBtn: $("lanModeBtn"),
  wsHostField: $("wsHostField"),
  blePairingHint: $("blePairingHint"),
  wsHostInput: $("wsHostInput"),
  wsHostError: $("wsHostError"),
  wsTokenField: $("wsTokenField"),
  wsTokenInput: $("wsTokenInput"),
  wsTokenError: $("wsTokenError"),
  mobileConnectBtn: $("mobileConnectBtn"),
};

const THEME_KEY = "linkr-theme";
const LANG_KEY = "linkr-lang";
const FONT_FAMILY_KEY = "linkr-font-family";
const LAST_DEVICE_ID_KEY = "linkr-last-device-id";
const TRANSPORT_KEY = "linkr-transport";
const WS_HOST_KEY = "linkr-ws-host";
const lanTokens = createLanTokenStore(localStorage);
/* LAN access handshake. The bridge announces whether a token is required, so
 * the client never has to guess; UART data always arrives as binary frames, so
 * these text frames are unambiguous. See src/ws_bridge.c. */
const WS_AUTH_NONE_FRAME = "@ws auth=none";
const WS_AUTH_REQUIRED_FRAME = "@ws auth=required";
const WS_AUTH_OK_FRAME = "@ws auth=ok";
const WS_HANDSHAKE_TIMEOUT_MS = 5000;

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
  brightBlack: "#8d9bb0",
  cursor: "#d8f3dc",
  selectionBackground: "#2b5340",
};

const XTERM_LIGHT = {
  background: "#f8fafc",
  foreground: "#1f6b43",
  brightBlack: "#5c6a82",
  cursor: "#1f6b43",
  selectionBackground: "#bfe3cf",
};

const I18N = {
  en: {
    title: "Linkr Bee Terminal",
    checking: "Checking Web Bluetooth…",
    supported: "Chrome/Chromium Web Bluetooth over HTTPS or localhost",
    nativeSupported: "Native Bluetooth LE transport",
    unsupported: "Web Bluetooth unavailable in this browser",
    bleMode: "BLE",
    lanMode: "LAN",
    wsHost: "Device address",
    placeholderWsHost: "192.168.1.50 or ws://host/ws",
    wsToken: "Access token",
    placeholderWsToken: "32 hex characters",
    wsTokenHint: "Captured automatically while connected over BLE (from @s?). Leave blank only if LAN auth was disabled with @s token off.",
    lanHint: "LAN mode: reach the device's WebSocket over your network",
    wsMissingHost: "Enter the device address first.",
    wsUnreachable: "WebSocket {url} is unreachable.",
    wsTimeout: "WebSocket connection timed out after 15 seconds.",
    wsAuthRejected: "LAN access token rejected. Read the current token with @s? over BLE.",
    wsNoHandshake: "The bridge did not confirm LAN access; check the token or firmware version.",
    wsTokenRequired: "This bridge requires an access token. Read it with @s? over BLE.",
    wsTokenInvalid: "The access token must be 32 lowercase hex characters.",
    xtermFail: "Bundled xterm.js failed to load; check the web assets",
    connected: "Connected",
    disconnected: "Disconnected",
    authorizedDeviceReady: "Authorized device restored; click Connect to reconnect",
    authorizedDeviceFailed: "Saved device unavailable; choose it again",
    connection: "Connection",
    settingsConnection: "Connect",
    settingsTerminal: "Serial",
    settingsNetwork: "Network",
    // The rail's fourth section. Without this key t() falls back to the key
    // itself, so the icon button announced (and titled) "assistant".
    assistant: "Assistant",
    aboutNav: "About",
    aboutLead: "An open-source serial terminal for Linkr Bee bridges, with an assistant that talks to the model service you configure.",
    aboutComponentsHeading: "Open source components",
    aboutComponentsHint: "Everything the app and its firmware ship, with the licence each one is distributed under. The full licence texts travel with the components.",
    aboutComplianceHeading: "Licences and compliance",
    aboutComplianceProject: "This project is released under Apache-2.0.",
    aboutComplianceThirdParty: "Third-party components remain the property of their authors and are distributed under their own licences, listed above.",
    aboutComplianceDual: "DOMPurify is dual-licensed MPL-2.0 / Apache-2.0; this project uses it under Apache-2.0.",
    aboutComplianceCcBy: "The macaron cursors are CC-BY-4.0, © UnionTech Software Technology Co., Ltd.; three shapes were converted from XCursor to PNG. Attribution and the source revision are in vendor/macaron-cursors/README.md.",
    aboutContributorsHeading: "Contributors",
    aboutContributorsHint: "Taken from the git history of radxa/linkr-bee; duplicate identities are merged.",
    aboutRepository: "Repository",
    aboutIssues: "Report a problem",
    aboutLicenseLink: "Licence text",
    // The rail landmark's own name. It is the one accessible name in the rail
    // that is not a section, so it needs its own key.
    sections: "Sections",
    terminalSettings: "Terminal Settings",
    diagnostics: "Device Diagnostics",
    diagFirmware: "Firmware",
    diagUptime: "Uptime",
    diagOwner: "BLE access",
    accessOpen: "open",
    accessScoped: "scoped",
    linkSecurity: "link L{level}",
    diagUart: "UART Buffer",
    diagWifi: "WiFi",
    diagUpload: "Upload Queue",
    refreshDiagnostics: "Refresh diagnostics",
    diagnosticsUpdated: "Diagnostics updated",
    bleNameTitle: "BLE device name",
    bleNameAria: "BLE device name",
    bleNameHint: "Shown when scanning nearby devices. 1–29 UTF-8 bytes; Chinese and emoji are allowed (an emoji usually uses 4 bytes). The Device ID used for verification does not change.",
    bleName: "Advertised name",
    placeholderBleName: "Linkr Bee 078C",
    bleNameUnknown: "Connect over BLE to read the current name.",
    bleNameDefault: "Restore default",
    bleNameQuery: "Read name",
    bleNameSet: "BLE name updated",
    bleNameReset: "Default BLE name restored",
    bleNameInvalid: "Enter 1–29 UTF-8 bytes, without control characters.",
    bleNameUnsupported: "This firmware does not support BLE name changes.",
    bleNameReadFailed: "Could not read the BLE name.",
    bleNameStateDefault: "current: {name} (default)",
    bleNameStateCustom: "current: {name} (custom)",
    legacyHint: "Legacy firmware: Management Service not found. Terminal is available; accessory settings are disabled.",
    wifiWebdav: "WiFi & WebDAV",
    connect: "Connect",
    disconnect: "Disconnect",
    reconnect: "Reconnect",
    switchDevice: "Switch device",
    queryUart: "Query UART",
    clear: "Clear",
    saveLog: "Save Log",
    set: "Set",
    off: "Off",
    ctrlC: "Ctrl-C",
    terminalKeys: "Terminal keys · swipe for more",
    keyUp: "Up arrow · previous command",
    keyDown: "Down arrow · next command",
    keyLeft: "Left arrow",
    keyRight: "Right arrow",
    paste: "Paste",
    backspace: "Backspace",
    modifierNext: "{key}: combine with the next key; tap again to cancel",
    modifierActive: "{key} active · next key only · tap again to cancel",
    pasteUnavailable: "Clipboard unavailable. Long-press in the terminal to paste.",
    keyboard: "Keyboard",
    uart: "UART",
    baudRate: "Baud rate",
    baudHint: "Picking a rate updates the UART string below; press Set to apply it.",
    baudCustom: "Custom…",
    baudCustomRate: "Custom baud rate",
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
    terminalInputHint: "Modifiers apply once · Swipe right-hand keys for more",
    terminalInputDisconnected: "Connect a device to enable terminal input",
    emptyTitle: "No device yet",
    emptyHint: "Tap Connect to scan for a nearby Linkr Bee",
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
    panel: "Settings",
    close: "Close",
    controls: "Control panel",
    connectionControls: "Connection controls",
    transport: "Transport",
    togglePanel: "Toggle control panel",
    closePanel: "Close control panel",
    terminalSettingsAria: "Terminal settings",
    wifiWebdavAria: "WiFi and WebDAV settings",
    cheatsheetAria: "Command cheat sheet",
    quickSend: "Quick send commands",
    statusAria: "Connection statistics",
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
    welcome: "Linkr Bee Terminal ready. Press Connect to open a device.",
    connecting: "Connecting…",
    pairingHint: "New host: hold Bee GPIO1 to GND before connecting and accept system pairing. Bonded hosts reconnect without GPIO1.",
    pairingFailed: "If pairing failed, hold GPIO1 to GND and reconnect. If the host lost its keys, forget its old system bond first. A full Bee bond table requires a factory reset.",
    saved: "Log saved",
    uartSet: "UART configured",
    wifiSet: "WiFi configured",
    wifiPhaseQueued: "WiFi request queued…",
    wifiPhaseConnecting: "Connecting to {ssid}…",
    wifiPhaseDhcp: "Connected to {ssid}; obtaining address…",
    wifiPhaseOff: "Disconnecting WiFi…",
    wifiAwaitingAddress: "The bridge reports ready but has no IPv4 address yet; waiting…",
    wifiReady: "WiFi ready: {ssid}",
    wifiConnectFailed: "WiFi provisioning failed (result {code}). Check the password and 2.4 GHz coverage, then retry.",
    wifiEventTimeout: "The bridge sent no completion event; showing the polled status instead.",
    webdavSet: "WebDAV configured",
    sent: "Sent",
    cleared: "Screen cleared",
    copied: "Copied to clipboard",
    copyFailed: "Copy failed. Select the text and copy it manually.",
    confirmReboot: "Reboot the connected device now?",
    scan: "Scan",
    scanning: "Scanning…",
    foundN: "Found {n} networks",
    noNetworks: "No networks found",
    scanFailed: "Wi-Fi scan failed; retry in a moment",
    light: "Light",
    dark: "Dark",
  },
  zh: {
    title: "Linkr Bee 终端",
    checking: "正在检测 Web Bluetooth…",
    supported: "Chrome/Chromium 需通过 HTTPS 或 localhost 使用 Web Bluetooth",
    nativeSupported: "手机原生 Bluetooth LE 通道",
    unsupported: "当前浏览器不支持 Web Bluetooth",
    bleMode: "BLE",
    lanMode: "局域网",
    wsHost: "设备地址",
    placeholderWsHost: "192.168.1.50 或 ws://host/ws",
    wsToken: "访问令牌",
    placeholderWsToken: "32 位十六进制字符",
    wsTokenHint: "连接 BLE 时会自动获取（来自 @s?）。仅在已用 @s token off 关闭局域网鉴权时才留空。",
    lanHint: "局域网模式:通过设备的 WebSocket 直连串口",
    wsMissingHost: "请先输入设备地址。",
    wsUnreachable: "无法连接 WebSocket {url}。",
    wsTimeout: "WebSocket 连接超过 15 秒未响应。",
    wsAuthRejected: "局域网访问令牌被拒绝。请通过 BLE 执行 @s? 获取当前令牌。",
    wsNoHandshake: "桥接器未确认局域网访问，请检查令牌或固件版本。",
    wsTokenRequired: "该桥接器需要访问令牌。请通过 BLE 执行 @s? 获取。",
    wsTokenInvalid: "访问令牌必须是 32 位小写十六进制字符。",
    xtermFail: "内置 xterm.js 加载失败，请检查网页静态资源",
    connected: "已连接",
    disconnected: "未连接",
    authorizedDeviceReady: "已恢复授权设备，点击「连接」即可快速重连",
    authorizedDeviceFailed: "已授权设备不可用，请重新选择设备",
    connection: "连接",
    settingsConnection: "连接",
    settingsTerminal: "串口",
    settingsNetwork: "网络",
    assistant: "助手",
    aboutNav: "关于",
    aboutLead: "Linkr Bee 桥接器的开源串口终端，并带有可自行配置模型服务的助手。",
    aboutComponentsHeading: "开源组件",
    aboutComponentsHint: "程序与其固件实际随附的组件，以及各自的许可证。完整许可证文本随各组件分发。",
    aboutComplianceHeading: "许可证与合规",
    aboutComplianceProject: "本项目以 Apache-2.0 发布。",
    aboutComplianceThirdParty: "第三方组件版权归其作者，按各自许可证分发，见上表。",
    aboutComplianceDual: "DOMPurify 采用 MPL-2.0 / Apache-2.0 双许可，本项目按 Apache-2.0 使用。",
    aboutComplianceCcBy: "Macaron 光标为 CC-BY-4.0，© 统信软件技术有限公司；三种形状由 XCursor 转为 PNG。署名与来源版本见 vendor/macaron-cursors/README.md。",
    aboutContributorsHeading: "贡献者",
    aboutContributorsHint: "按 radxa/linkr-bee 的 git 提交历史整理，重复身份已合并。",
    aboutRepository: "项目仓库",
    aboutIssues: "问题反馈",
    aboutLicenseLink: "许可证全文",
    sections: "分区",
    terminalSettings: "终端设置",
    diagnostics: "设备诊断",
    diagFirmware: "固件",
    diagUptime: "运行时间",
    diagOwner: "BLE 访问",
    accessOpen: "开放",
    accessScoped: "受限",
    linkSecurity: "链路 L{level}",
    diagUart: "UART 缓冲",
    diagWifi: "WiFi",
    diagUpload: "上传队列",
    refreshDiagnostics: "刷新诊断",
    diagnosticsUpdated: "诊断信息已更新",
    bleNameTitle: "BLE 设备名称",
    bleNameAria: "BLE 设备名称",
    bleNameHint: "扫描附近设备时显示的名称，最多 29 个 UTF-8 字节，可直接使用中文和 emoji（每个 emoji 通常占 4 字节）。用于连接校验的 Device ID 不会改变。",
    bleName: "广播名称",
    placeholderBleName: "Linkr Bee 078C",
    bleNameUnknown: "通过 BLE 连接后可读取当前名称。",
    bleNameDefault: "恢复默认",
    bleNameQuery: "读取名称",
    bleNameSet: "BLE 名称已更新",
    bleNameReset: "已恢复默认 BLE 名称",
    bleNameInvalid: "请输入 1–29 个 UTF-8 字节，且不能包含控制字符。",
    bleNameUnsupported: "当前固件不支持修改 BLE 名称。",
    bleNameReadFailed: "读取 BLE 名称失败。",
    bleNameStateDefault: "当前：{name}（默认）",
    bleNameStateCustom: "当前：{name}（自定义）",
    legacyHint: "旧固件：未发现 Management Service，仅终端功能可用，配件设置已禁用。",
    wifiWebdav: "WiFi 与 WebDAV",
    connect: "连接",
    disconnect: "断开",
    reconnect: "重新连接",
    switchDevice: "切换设备",
    queryUart: "查询 UART",
    clear: "清屏",
    saveLog: "保存日志",
    set: "设置",
    off: "关闭",
    ctrlC: "Ctrl-C",
    terminalKeys: "终端按键 · 左右滑动查看更多",
    keyUp: "向上 · 上一条命令",
    keyDown: "向下 · 下一条命令",
    keyLeft: "向左",
    keyRight: "向右",
    paste: "粘贴",
    backspace: "退格",
    modifierNext: "{key}：与下一个按键组合，再点一次取消",
    modifierActive: "{key} 已开启 · 仅作用于下一键 · 再点取消",
    pasteUnavailable: "无法读取剪贴板，请长按终端进行粘贴。",
    keyboard: "键盘",
    uart: "UART",
    baudRate: "波特率",
    baudHint: "选择预设会更新下方 UART 参数，点击「设置」后生效。",
    baudCustom: "自定义…",
    baudCustomRate: "自定义波特率",
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
    terminalInputHint: "组合键单次生效 · 左右滑动右侧按键查看更多",
    terminalInputDisconnected: "连接设备后即可在终端内直接输入",
    emptyTitle: "还没有连接设备",
    emptyHint: "点右上角「连接」，扫描附近的 Linkr Bee",
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
    panel: "设置",
    close: "关闭",
    controls: "控制面板",
    connectionControls: "连接控制",
    transport: "连接方式",
    togglePanel: "切换控制面板",
    closePanel: "关闭控制面板",
    terminalSettingsAria: "终端设置",
    wifiWebdavAria: "WiFi 与 WebDAV 设置",
    cheatsheetAria: "命令速查",
    quickSend: "快捷发送命令",
    statusAria: "连接统计",
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
    welcome: "Linkr Bee 终端已就绪，点击「连接」打开设备。",
    connecting: "连接中…",
    pairingHint: "首次连接新主机：先将 Bee GPIO1 接地，再连接并接受系统配对。已绑定主机无需拉低 GPIO1。",
    pairingFailed: "若配对失败，请将 GPIO1 接地后重连；主机密钥丢失时，先在系统中忽略旧绑定。Bee 绑定表已满时需恢复出厂。",
    saved: "日志已保存",
    uartSet: "UART 已配置",
    wifiSet: "WiFi 已配置",
    wifiPhaseQueued: "WiFi 请求已入队…",
    wifiPhaseConnecting: "正在连接 {ssid}…",
    wifiPhaseDhcp: "已连接 {ssid}，正在获取地址…",
    wifiPhaseOff: "正在断开 WiFi…",
    wifiAwaitingAddress: "桥接器已进入 ready，但尚无 IPv4 地址，继续等待…",
    wifiReady: "WiFi 已就绪：{ssid}",
    wifiConnectFailed: "WiFi 配网失败（result {code}）。请检查密码与 2.4 GHz 信号后重试。",
    wifiEventTimeout: "桥接器未上报完成事件，改为显示轮询到的状态。",
    webdavSet: "WebDAV 已配置",
    sent: "已发送",
    cleared: "已清屏",
    copied: "已复制到剪贴板",
    copyFailed: "复制失败，请选中文本后手动复制。",
    confirmReboot: "确定立即重启当前连接的设备吗？",
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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  [elements.langButton, elements.drawerLangButton].forEach((button) => {
    const label = button?.querySelector(".btn-label");
    if (label) {
      label.textContent = lang === "zh" ? "EN" : "中";
    }
  });
  [elements.themeButton, elements.drawerThemeButton].forEach((button) => {
    const label = button?.querySelector(".btn-label");
    if (label) {
      label.textContent = theme === "dark" ? t("light") : t("dark");
    }
  });
}

function toggleTheme() {
  theme = theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, theme);
  applyTheme();
}

function toggleLanguage() {
  lang = lang === "zh" ? "en" : "zh";
  localStorage.setItem(LANG_KEY, lang);
  applyLang();
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", theme);
  if (elements.themeColorMeta) {
    elements.themeColorMeta.content = theme === "dark" ? "#05080D" : "#E2E9F4";
  }
  Promise.resolve(window.LinkrNativeUi?.setTheme?.(theme)).catch(() => {
    // Web and Capacitor hosts do not expose native system-bar controls.
  });
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
  elements.supportText.textContent = bleTransport?.isAvailable()
    ? bleTransport.platform() === "web"
      ? t("supported")
      : t("nativeSupported")
    : t("unsupported");
}

function setFieldError(input, error, message = "", focus = false, i18nKey = "") {
  const hasError = Boolean(message);
  input.setAttribute("aria-invalid", String(hasError));
  error.textContent = message;
  error.hidden = !hasError;
  error.dataset.i18nKey = hasError ? i18nKey : "";
  if (hasError && focus) {
    input.focus();
  }
}

function setWsHostError(message = "", focus = false, i18nKey = "") {
  setFieldError(elements.wsHostInput, elements.wsHostError, message, focus, i18nKey);
}

function setWsTokenError(message = "", focus = false, i18nKey = "") {
  setFieldError(elements.wsTokenInput, elements.wsTokenError, message, focus, i18nKey);
}

function clearWsErrors() {
  setWsHostError();
  setWsTokenError();
}

function syncTransportControls() {
  const isWs = state.mode === "ws";
  elements.bleModeBtn.classList.toggle("active", !isWs);
  elements.lanModeBtn.classList.toggle("active", isWs);
  elements.bleModeBtn.setAttribute("aria-pressed", String(!isWs));
  elements.lanModeBtn.setAttribute("aria-pressed", String(isWs));
  elements.wsHostField.hidden = !isWs;
  elements.wsTokenField.hidden = !isWs;
  elements.blePairingHint.hidden = isWs;
  document.querySelectorAll(".connect-icon-ble").forEach((icon) => {
    icon.toggleAttribute("hidden", isWs);
  });
  document.querySelectorAll(".connect-icon-lan").forEach((icon) => {
    icon.toggleAttribute("hidden", !isWs);
  });
}

function setTransportMode(mode) {
  if (state.connected || !["ble", "ws"].includes(mode)) {
    return;
  }
  state.mode = mode;
  if (mode === "ws") elements.wsTokenInput.value = lanTokens.selectHost(elements.wsHostInput.value);
  saveSetting(TRANSPORT_KEY, mode);
  syncTransportControls();
  clearWsErrors();
  setConnected(false);
  setSupportText();
}

function connectionActionKey() {
  return state.mode === "ble" && state.device ? "reconnect" : "connect";
}

function refreshConnectionActions() {
  elements.connectButton.querySelector(".btn-label").textContent = t(connectionInFlight ? "connecting" : connectionActionKey());
  elements.switchDeviceButton.hidden = state.mode !== "ble";
  elements.switchDeviceButton.disabled = connectionInFlight || state.connected;
}

function refreshDynamicTexts() {
  refreshConnectionActions();
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
    const disabled = state.connected ? "" : " disabled";
    cheat.innerHTML = CHEATS.map(
      (g) => `
        <div class="ref-group">
          <div class="ref-group-title">${escapeHtml(t(g.group))}</div>
          ${g.items
            .map(
              (it) => `
            <button class="ref-item" type="button" data-cmd="${escapeHtml(it.c)}"${disabled}>
              <code class="ref-cmd">${escapeHtml(it.c)}</code>
              <span class="ref-desc">${escapeHtml(tl(it.d))}</span>
            </button>`,
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
  const wsErrorKey = elements.wsHostError.dataset.i18nKey;
  if (!elements.wsHostError.hidden && wsErrorKey) {
    setWsHostError(t(wsErrorKey), false, wsErrorKey);
  }
  const wsTokenErrorKey = elements.wsTokenError.dataset.i18nKey;
  if (!elements.wsTokenError.hidden && wsTokenErrorKey) {
    setWsTokenError(t(wsTokenErrorKey), false, wsTokenErrorKey);
  }
  updateToggleLabels();
  renderRefLists();
  refreshDynamicTexts();
  renderDiagnostics();
  renderBleNameStatus();
  updateWifiConnectionView();
  updateFullscreenButton();
  updateModifierButtons();
  agentPanel?.refreshLang();
  agentSettings?.refreshLang();
  aboutPage?.refreshLang();
}

function fitTerminal() {
  if (!state.fitAddon || !elements.terminalOutput.clientWidth || !elements.terminalOutput.clientHeight) {
    return;
  }
  try {
    state.fitAddon.fit();
  } catch (_error) {
    // The fit addon can throw while the terminal container is hidden/resizing.
  }
}

function clearTerminalGeometrySyncTimer() {
  clearTimeout(state.terminalGeometrySyncTimer);
  state.terminalGeometrySyncTimer = null;
}

function resetTerminalGeometrySync() {
  terminalSessionTracker.reset();
  invalidateTerminalGeometrySync();
  state.terminalGeometry = state.term
    ? normalizeTerminalGeometry(state.term.cols, state.term.rows)
    : null;
}

function invalidateTerminalGeometrySync() {
  clearTerminalGeometrySyncTimer();
  state.terminalGeometrySession += 1;
  state.terminalGeometrySynced = "";
  state.terminalGeometrySyncInFlight = "";
  state.shellPromptVisible = false;
}

function markTerminalBusy() {
  state.shellPromptVisible = false;
  clearTerminalGeometrySyncTimer();
}

function scheduleTerminalGeometrySync() {
  clearTerminalGeometrySyncTimer();
  const geometry = state.terminalGeometry;
  const session = state.terminalGeometrySession;
  if (
    !state.connected ||
    serialInputPending ||
    agentPanel?.isBusy?.() ||
    !state.shellPromptVisible ||
    !geometry ||
    geometry.key === state.terminalGeometrySynced ||
    geometry.key === state.terminalGeometrySyncInFlight
  ) {
    return;
  }

  state.terminalGeometrySyncTimer = setTimeout(() => {
    state.terminalGeometrySyncTimer = null;
    if (
      !state.connected ||
      serialInputPending ||
      session !== state.terminalGeometrySession ||
      agentPanel?.isBusy?.() ||
      !state.shellPromptVisible ||
      !terminalHasIdleShellPrompt() ||
      geometry.key !== state.terminalGeometry?.key ||
      geometry.key === state.terminalGeometrySynced ||
      geometry.key === state.terminalGeometrySyncInFlight
    ) {
      return;
    }

    state.shellPromptVisible = false;
    state.terminalGeometrySyncInFlight = geometry.key;
    writeText(terminalGeometryCommand(geometry.cols, geometry.rows))
      .then(() => {
        if (session === state.terminalGeometrySession) {
          state.terminalGeometrySynced = geometry.key;
        }
      })
      .catch((error) => {
        debugLine(`[terminal-size] ${error.message}`);
      })
      .finally(() => {
        if (session === state.terminalGeometrySession &&
            state.terminalGeometrySyncInFlight === geometry.key) {
          state.terminalGeometrySyncInFlight = "";
        }
      });
  }, 180);
}

function onTerminalResize({ cols, rows }) {
  state.terminalGeometry = normalizeTerminalGeometry(cols, rows);
  scheduleTerminalGeometrySync();
}

function terminalHasIdleShellPrompt() {
  const buffer = state.term?.buffer.active;
  const line = buffer?.getLine(buffer.baseY + buffer.cursorY);
  if (!buffer || buffer.type !== "normal" || !line) return false;

  // Readline can move back to the prompt while leaving an editable command
  // to its right, or on wrapped rows. Neither case is an empty input line.
  if (line.translateToString(true, buffer.cursorX).trim()) return false;
  const nextLine = buffer.getLine(buffer.baseY + buffer.cursorY + 1);
  if (nextLine?.isWrapped) return false;

  const text = line.translateToString(false, 0, buffer.cursorX);
  return looksLikeShellPrompt(text);
}

function onTerminalWriteParsed() {
  state.shellPromptVisible = terminalHasIdleShellPrompt();
  if (state.shellPromptVisible) {
    scheduleTerminalGeometrySync();
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
      if (!agentPanel?.isOpen()) state.term?.focus();
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
    // A burst of log lines must not queue an animation frame per scroll step.
    smoothScrollDuration: 0,
    tabStopWidth: 8,
    theme: theme === "dark" ? XTERM_DARK : XTERM_LIGHT,
  });
  state.fitAddon = new globalThis.FitAddon.FitAddon();
  state.term.loadAddon(state.fitAddon);
  state.term.open(elements.terminalOutput);
  subscribeTerminalInput(state.term, onTerminalData);
  state.term.onResize(onTerminalResize);
  applyTerminalFont(state.fontFamily);
  fitTerminal();

  window.addEventListener("resize", scheduleFit);
  if (globalThis.ResizeObserver) {
    state.resizeObserver = new ResizeObserver(scheduleFit);
    state.resizeObserver.observe(elements.terminalOutput);
  }

  return true;
}

/* A hidden page never runs rAF, so the queue needs a timer next to the frame:
 * without both, one fast burst stays pending until the user returns and the
 * backlog grows without limit. The cap drops the oldest half of the pending
 * display only — the agent's evidence is the journal, which is untouched. */
const WRITE_BACKLOG_LIMIT = 512 * 1024;
const WRITE_FALLBACK_MS = 50;

let writeRaf = 0;
let writeFallbackTimer = 0;
let pendingWrites = [];
let pendingWriteBytes = 0;
let droppedWriteBytes = 0;

function flushTerminalWrites() {
  writeRaf = 0;
  if (writeFallbackTimer) {
    clearTimeout(writeFallbackTimer);
    writeFallbackTimer = 0;
  }
  const chunks = pendingWrites;
  pendingWrites = [];
  pendingWriteBytes = 0;
  if (!state.term || !chunks.length) {
    return;
  }
  if (droppedWriteBytes) {
    // The notice belongs after the surviving output, where the gap actually is.
    chunks.push(
      encoder.encode(
        `\x1b[93m[warn] ${droppedWriteBytes} bytes of output dropped (terminal backlog)\x1b[0m\r\n`,
      ),
    );
    droppedWriteBytes = 0;
  }
  if (chunks.length === 1) {
    state.term.write(chunks[0], onTerminalWriteParsed);
    return;
  }
  let total = 0;
  for (const bytes of chunks) {
    total += bytes.length;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const bytes of chunks) {
    merged.set(bytes, offset);
    offset += bytes.length;
  }
  state.term.write(merged, onTerminalWriteParsed);
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
  // Encoding here keeps the byte accounting honest and encodes each chunk once.
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  pendingWrites.push(bytes);
  pendingWriteBytes += bytes.length;
  if (pendingWriteBytes > WRITE_BACKLOG_LIMIT && pendingWrites.length > 1) {
    // Drop the oldest half in one step: a user watching a running command needs
    // the live tail, and repeated shift() would be quadratic.
    const keep = Math.max(1, pendingWrites.length >> 1);
    for (const chunk of pendingWrites.slice(0, pendingWrites.length - keep)) {
      droppedWriteBytes += chunk.length;
    }
    pendingWrites = pendingWrites.slice(-keep);
    pendingWriteBytes = pendingWrites.reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
  }
  if (!writeRaf) {
    writeRaf = requestAnimationFrame(flushTerminalWrites);
  }
  if (!writeFallbackTimer) {
    writeFallbackTimer = setTimeout(flushTerminalWrites, WRITE_FALLBACK_MS);
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
  clearTimeout(state.wifiOperationTimer);
  state.wifiOperationTimer = null;
}

/* WiFi provisioning is an asynchronous bridge operation. The documented
 * completion signal is a FINAL @event whose phase is ready/failed/off, with a
 * usable IPv4 address — the initial "OK wifi=accepted" only means the request
 * was queued. Parsing lives in management_protocol.js so the contract is unit
 * tested; polling is retained purely as a fallback for a bridge that never
 * reports the event. */
/* CONFIG_LINKR_BLE_BRIDGE_WIFI_OPERATION_TIMEOUT_MS is 30 s; allow for the
 * disconnect/recovery cycle before giving up on the event stream. */
const WIFI_EVENT_FALLBACK_MS = 45000;
const WIFI_PHASE_KEYS = {
  queued: "wifiPhaseQueued",
  connecting: "wifiPhaseConnecting",
  dhcp: "wifiPhaseDhcp",
};

function setWifiFeedback(key, replacements) {
  let message = key ? t(key) : "";
  for (const [name, value] of Object.entries(replacements || {})) {
    message = message.replace(`{${name}}`, String(value));
  }
  elements.wifiFeedback.textContent = message;
}

function applyWifiEvent(event) {
  const pending = state.wifiOperation;
  const ssid = pending?.ssid || state.wifiStatus.ssid;

  if (event.phase === "ready") {
    if (!wifiProvisioningComplete(event)) {
      if (pending) {
        setWifiFeedback("wifiAwaitingAddress");
        scheduleWifiStateRefresh();
      }
      return;
    }
    state.wifiOperation = null;
    clearWifiRefreshTimers();
    state.wifiStatus = { connected: true, ssid, ip: event.ip };
    updateWifiConnectionView();
    setWifiFeedback("");
    toast(t("wifiReady").replace("{ssid}", ssid || "—"));
    return;
  }

  if (event.phase === "failed") {
    state.wifiOperation = null;
    state.wifiStatus = { connected: false, ssid: "", ip: "down" };
    updateWifiConnectionView();
    setWifiFeedback("wifiConnectFailed", { code: event.result });
    // Reconcile with the bridge: a retry may already be in progress.
    scheduleWifiStateRefresh();
    return;
  }

  if (event.phase === "off") {
    state.wifiOperation = null;
    clearWifiRefreshTimers();
    state.wifiStatus = { connected: false, ssid: "", ip: "down" };
    updateWifiConnectionView();
    setWifiFeedback("");
    return;
  }

  const key = WIFI_PHASE_KEYS[event.phase];
  if (key && pending) {
    state.wifiStatus.ssid = ssid;
    setWifiFeedback(key, { ssid });
  }
}

function handleWifiEventLine(line) {
  const event = parseWifiEvent(line);
  if (!event) {
    return false;
  }
  /* While a user operation is pending only its own events drive the UI, so a
   * background lease change cannot claim success or failure for it. With no
   * operation pending, only id 0 (background lifecycle) is applied. */
  const ours = state.wifiOperation
    ? event.operation === state.wifiOperation.id
    : event.operation === 0;
  if (ours) {
    applyWifiEvent(event);
  }
  return true;
}

function scheduleWifiOperationFallback() {
  clearTimeout(state.wifiOperationTimer);
  state.wifiOperationTimer = setTimeout(() => {
    state.wifiOperationTimer = null;
    if (!state.wifiOperation) {
      return;
    }
    // The bridge never finished the documented event sequence. Fall back to
    // polling so the user still sees the outcome.
    state.wifiOperation = null;
    appendLine("[warn] no WiFi completion event; falling back to status polling");
    setWifiFeedback("wifiEventTimeout");
    scheduleWifiStateRefresh();
  }, WIFI_EVENT_FALLBACK_MS);
}

function hasManagementCapability(capability) {
  return (state.mgmtCapabilities & capability) !== 0;
}

function requestDeviceState() {
  if (!state.connected || state.mode !== "ble" || !state.mgmtReady) {
    return Promise.resolve();
  }
  const requests = [requestDiagnostics()];
  if (hasManagementCapability(MGMT_CAP_WIFI)) {
    requests.push(sendControl("@w?"));
  }
  if (hasManagementCapability(MGMT_CAP_WEBSOCKET)) {
    // "@s?" is the only place the bridge reports its LAN access token, and the
    // web UI has no other management-command entry point. Capturing it during
    // the BLE session means the token field is already filled when the user
    // switches to LAN mode. "@i?" diagnostics deliberately omit the token.
    requests.push(sendControl("@s?"));
  }
  return Promise.all(requests);
}

function updateBleNameControls() {
  const enabled =
    state.connected &&
    state.mode === "ble" &&
    state.mgmtReady &&
    state.bleNameSupported !== false;
  elements.bleNameInput.disabled = !enabled;
  elements.bleNameSetButton.disabled = !enabled;
  elements.bleNameDefaultButton.disabled = !enabled;
  elements.bleNameQueryButton.disabled = !enabled;
}

function renderBleNameStatus() {
  if (!state.connected || state.mode !== "ble") {
    elements.bleNameStatus.textContent = t("bleNameUnknown");
    return;
  }
  // A legacy NUS-only board is connected; it simply has no Management
  // Service, so "connect over BLE" would be untrue. Say the firmware does
  // not support renaming instead.
  if (!state.mgmtReady || state.bleNameSupported === false) {
    elements.bleNameStatus.textContent = t("bleNameUnsupported");
    return;
  }
  if (!state.bleName) {
    elements.bleNameStatus.textContent = t("bleNameUnknown");
    return;
  }
  const key = state.bleNameCustom ? "bleNameStateCustom" : "bleNameStateDefault";
  // A function replacement, not a string: a name containing `$&` or `$'`
  // must not be interpreted as a replacement pattern.
  elements.bleNameStatus.textContent = t(key).replace("{name}", () => state.bleName);
}

function applyBleName(parsed, { custom = null } = {}) {
  state.bleName = parsed.name;
  if (custom !== null) {
    state.bleNameCustom = Boolean(custom);
  } else if (parsed.custom !== null) {
    state.bleNameCustom = parsed.custom;
  }
  state.bleNameSupported = true;
  elements.bleNameInput.value = parsed.name;
  // The board's own name is the name everything else shows. The name the
  // picker carried is a snapshot the owner can change from another client, so
  // a top bar that keeps it would name a board that no longer answers to it.
  if (state.device) {
    state.device = { ...state.device, name: parsed.name };
    renderDeviceName();
  }
  updateBleNameControls();
  renderBleNameStatus();
}

function renderDeviceName() {
  elements.deviceName.textContent = state.mode === "ws"
    ? state.wsHost || ""
    : state.device
      ? state.device.name || state.device.id
      : "";
}

async function readBleName({ quiet = false } = {}) {
  if (!state.connected || state.mode !== "ble" || !state.mgmtReady) {
    return null;
  }
  try {
    const reply = await sendControl(BLE_NAME_QUERY_COMMAND, {
      returnResponse: true,
    });
    const parsed = parseBleName(reply, { query: true });
    if (!parsed) {
      state.bleName = null;
      state.bleNameCustom = null;
      state.bleNameSupported = false;
      updateBleNameControls();
      renderBleNameStatus();
      if (!quiet) toast(t("bleNameUnsupported"), "error");
      return null;
    }
    applyBleName(parsed);
    return parsed;
  } catch (error) {
    // An old board answers the query with "ERR unknown command". That is not
    // a transient read failure: the firmware simply has no rename command.
    if (/^ERR\b/i.test(String(error.message))) {
      state.bleName = null;
      state.bleNameCustom = null;
      state.bleNameSupported = false;
      updateBleNameControls();
      renderBleNameStatus();
      return null;
    }
    if (!quiet) {
      appendLine(`[error] ${error.message}`);
      toast(t("bleNameReadFailed"), "error");
    }
    return null;
  }
}

async function changeBleName(command, successKey, custom) {
  const reply = await sendControl(command, { returnResponse: true });
  const status = replyStatus(reply);
  if (!status.ok) {
    throw new Error(status.error || t("bleNameReadFailed"));
  }
  // A write's reply has no `custom=` field, so it is parsed without the
  // suffix rule and then verified by the read below.
  const parsed = parseBleName(reply);
  if (!parsed) {
    throw new Error(t("bleNameReadFailed"));
  }
  applyBleName(parsed, { custom });
  // The board is asked again, so the name on screen is the one the board
  // reports and not the one the write's own reply carried. A write's reply
  // has no `custom=` field, and the advertisement only carries the new name
  // once the board has started broadcasting it. A reset's MAC suffix is not
  // predictable here, so it only has to read back; a set must read back the
  // name we asked for.
  const expected = command === "@n default" ? null : command.slice(3);
  const readBack = await readBleName({ quiet: true });
  if (!readBack || (expected !== null && readBack.name !== expected)) {
    throw new Error(t("bleNameReadFailed"));
  }
  toast(t(successKey));
}

async function setNameFromInput() {
  let command;
  try {
    command = bleNameCommand({ name: elements.bleNameInput.value });
  } catch (_error) {
    elements.bleNameStatus.textContent = t("bleNameInvalid");
    elements.bleNameInput.focus();
    return;
  }
  try {
    await changeBleName(command, "bleNameSet", true);
  } catch (error) {
    elements.bleNameStatus.textContent = t("bleNameReadFailed");
    appendLine(`[error] ${error.message}`);
  }
}

async function restoreDefaultBleName() {
  try {
    await changeBleName("@n default", "bleNameReset", false);
  } catch (error) {
    elements.bleNameStatus.textContent = t("bleNameReadFailed");
    appendLine(`[error] ${error.message}`);
  }
}

function scheduleWifiStateRefresh() {
  clearWifiRefreshTimers();
  state.wifiRefreshTimers = [1500, 3500, 7000].map((delay) =>
    setTimeout(() => {
      requestDeviceState().catch((error) =>
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
  // Follow the reported owner value instead of asserting "open" unconditionally,
  // and name what the L<n> number actually is. "@info sys" reports owner=0 while
  // no application-level access policy is active.
  elements.diagOwner.textContent =
    sys.owner != null && sys.security != null
      ? `${sys.owner === "0" ? t("accessOpen") : t("accessScoped")} · ` +
        t("linkSecurity").replace("{level}", sys.security)
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
  /* The assistant reads diagnostics as one collection: `@i?` answers with
   * several "@info <group> …" frames terminated by "@info done". */
  if (infoCollection) {
    infoCollection.lines.push(String(line).trim());
    if (payload === "done") settleInfoCollection(true);
  }
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

/* Settle the assistant's diagnostics collection. A missing "@info done" (lost
 * frame, disconnect, aborted run) still resolves, flagged as unsettled, so the
 * model is told the reading is incomplete instead of waiting forever. */
function settleInfoCollection(settled) {
  const collection = infoCollection;
  if (!collection) return;
  infoCollection = null;
  clearTimeout(collection.timer);
  collection.signal?.removeEventListener("abort", collection.onAbort);
  collection.resolve({ lines: collection.lines, groups: parseInfoGroups(collection.lines), settled });
}

/* Read `@i?` as one collection of "@info …" frames for the assistant. The
 * button path keeps its own requestDiagnostics() and shares state.diagnostics. */
function collectAccessoryDiagnostics({ signal, timeoutMs = 8000 } = {}) {
  if (infoCollection) {
    return Promise.reject(new Error("A diagnostics request is already in flight."));
  }
  return new Promise((resolve, reject) => {
    const collection = { lines: [], resolve, signal, timer: 0, onAbort: null };
    collection.timer = setTimeout(() => settleInfoCollection(false), timeoutMs);
    collection.onAbort = () => settleInfoCollection(false);
    signal?.addEventListener("abort", collection.onAbort, { once: true });
    infoCollection = collection;
    sendControl(DIAGNOSTICS_COMMAND).catch((error) => {
      if (infoCollection !== collection) return;
      infoCollection = null;
      clearTimeout(collection.timer);
      signal?.removeEventListener("abort", collection.onAbort);
      reject(error);
    });
  });
}

function feedManagementText(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (line) {
      handleRxLine(line);
    }
  }
}

/* The LAN access token grants full target access, so it must not reach the
 * scrollback or an exported log: `@s?` returns it as "… token=<32 hex>" and its
 * reply line is echoed to the terminal and can be saved to disk. Parsing uses
 * the raw text; only display and export are redacted. */
function redactSecrets(text) {
  return String(text).replace(/(^|\s)token=[0-9a-fA-F]{32}(?=\s|$)/g, "$1token=<redacted>");
}

function handleSocketStatusLine(line) {
  const value = String(line).trim();
  if (!value.startsWith("OK ws=")) {
    return false;
  }
  const match = value.match(/(?:^|\s)token=(none|[0-9a-f]{32})(?:\s|$)/);
  if (!match) {
    return false;
  }
  elements.wsTokenInput.value = lanTokens.capture(
    state.deviceId, match[1] === "none" ? "" : match[1],
    /^\d{1,3}(\.\d{1,3}){3}$/.test(state.wifiStatus.ip) ? state.wifiStatus.ip : "",
  );
  return true;
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
  if (handleWifiEventLine(scanLine)) {
    return;
  }
  if (handleSocketStatusLine(scanLine)) {
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
  if (
    !state.connected ||
    !hasManagementCapability(MGMT_CAP_WIFI) ||
    !hasManagementCapability(MGMT_CAP_ASYNC_EVENTS)
  ) {
    return { networks: [], failed: true, unavailable: true };
  }
  state.scanning = true;
  state.scanResults = [];
  updateWifiDatalist();
  elements.wifiFeedback.textContent = t("scanning");
  elements.wifiScanButton.disabled = true;
  clearTimeout(state.scanTimer);
  state.scanTimer = setTimeout(finishScan, WIFI_SCAN_TIMEOUT_MS);
  /* Resolve when the device reports completion, so the assistant can cite the
   * networks instead of assuming the scan worked. */
  const outcome = new Promise((resolve) => scanWaiters.push(resolve));
  try {
    await sendControl(WIFI_SCAN_CMD);
    toast(t("scanning"));
  } catch (error) {
    appendLine("[error] " + error.message);
    finishScan(true);
  }
  return outcome;
}

function finishScan(failed = false) {
  if (!state.scanning) {
    return;
  }
  state.scanning = false;
  clearTimeout(state.scanTimer);
  updateWifiDatalist();
  /* An assistant-driven scan waits for exactly this outcome. */
  const outcome = { networks: failed ? [] : [...state.scanResults], failed };
  for (const resolve of scanWaiters.splice(0)) resolve(outcome);
  elements.wifiScanButton.disabled = !(
    state.connected &&
    hasManagementCapability(MGMT_CAP_WIFI) &&
    hasManagementCapability(MGMT_CAP_ASYNC_EVENTS)
  );
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

let terminalViewport = null;

function onViewportScroll() {
  // Scroll fires every frame while the log streams; re-querying the viewport (and
  // re-resolving it after xterm re-opens) is cheaper than the three layout reads
  // below, which must stay.
  if (!terminalViewport || !terminalViewport.isConnected) {
    terminalViewport = elements.terminalOutput.querySelector(".xterm-viewport");
  }
  const vp = terminalViewport;
  if (!vp) {
    return;
  }
  const atBottom = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 2;
  setAutoScroll(atBottom, false);
}

let connectionInFlight = false;
let disconnectInFlight = false;

function setConnecting(connecting) {
  connecting = connecting || connectionInFlight;
  // Same source as setConnected(): a failure path must not re-enable a Connect
  // button whose prerequisites (term, BLE availability) are still missing.
  const canConnect =
    Boolean(state.term) &&
    (state.mode === "ws" || Boolean(bleTransport?.isAvailable()));
  elements.switchDeviceButton.disabled = connecting || state.connected;
  const btn = elements.connectButton;
  btn.classList.toggle("loading", connecting);
  btn.disabled = connecting || state.connected || !canConnect;
  elements.bleModeBtn.disabled = connecting || state.connected;
  elements.lanModeBtn.disabled = connecting || state.connected;
  const label = btn.querySelector(".btn-label");
  if (connecting) {
    if (label) {
      label.textContent = t("connecting");
    }
  } else if (label) {
    label.textContent = t(connectionActionKey());
  }
  const mobileBtn = elements.mobileConnectBtn;
  if (mobileBtn) {
    mobileBtn.classList.toggle("loading", connecting);
    mobileBtn.disabled = connecting || (!state.connected && !canConnect);
    mobileBtn.classList.toggle("btn-primary", !state.connected);
    const mobileLabel = mobileBtn.querySelector(".btn-label");
    if (mobileLabel) {
      mobileLabel.textContent = connecting
        ? t("connecting")
        : t(state.connected ? "disconnect" : connectionActionKey());
    }
  }
}

function setConnected(connected, { preserveJournal = false } = {}) {
  const isWs = state.mode === "ws";
  const canConnect =
    Boolean(state.term) && (isWs || Boolean(bleTransport?.isAvailable()));
  const canControl = connected && !isWs && state.mgmtReady;
  const canControlWifi = canControl && hasManagementCapability(MGMT_CAP_WIFI);
  const canMutateWifi =
    canControlWifi && hasManagementCapability(MGMT_CAP_ASYNC_EVENTS);
  const canControlWebdav =
    canControl && hasManagementCapability(MGMT_CAP_WEBDAV);

  const connectionChanged = state.connected !== connected;
  state.writeGeneration += 1;
  state.uartWriteError = "";
  state.mgmtWriteError = "";
  serialInputRevision++;
  serialInputPending = false;
  state.connected = connected;
  if (connected && !preserveJournal) agentJournal.reset();
  agentPanel?.connectionChanged(connected);
  agentSettings?.connectionChanged();
  if (connectionChanged) {
    resetTerminalGeometrySync();
  }
  elements.statusDot.classList.toggle("connected", connected);
  elements.statusText.textContent = t(
    connected ? "connected" : "disconnected",
  );
  if (elements.connStateText) {
    elements.connStateText.textContent = t(
      connected ? "connected" : "disconnected",
    );
  }
  renderDeviceName();
  elements.connectButton.disabled = connectionInFlight || connected || !canConnect;
  if (elements.mobileConnectBtn) {
    elements.mobileConnectBtn.disabled = connectionInFlight || (!connected && !canConnect);
    elements.mobileConnectBtn.classList.toggle("btn-primary", !connected);
    const mobileLabel =
      elements.mobileConnectBtn.querySelector(".btn-label");
    if (mobileLabel) {
      mobileLabel.textContent = t(connected ? "disconnect" : connectionActionKey());
    }
  }
  elements.disconnectButton.disabled = !connected;
  elements.switchDeviceButton.disabled =
    connectionInFlight || connected;
  elements.bleModeBtn.disabled = connectionInFlight || connected;
  elements.lanModeBtn.disabled = connectionInFlight || connected;
  elements.queryButton.disabled = !canControl;
  elements.diagnosticsButton.disabled = !canControl;
  elements.setUartButton.disabled = !canControl;
  elements.focusTerminalButton.disabled = !connected;
  elements.breakButton.disabled = !connected;
  elements.controlKeyButton.disabled = !connected;
  elements.modifierButtons.forEach((button) => { button.disabled = !connected; });
  elements.pasteTerminalButton.disabled = !connected;
  elements.terminalKeyButtons.forEach((button) => {
    button.disabled = !connected;
  });
  if (!connected) resetModifiers();
  elements.terminalOutput.classList.toggle("connected", connected);
  // The empty state is for "no session yet", not "no session right now": a
  // disconnect keeps the transcript, and the overlay is transparent, so
  // letting it come back would draw the mark and the hint over the user's log.
  if (connected) elements.terminalOutput.dataset.everConnected = "1";
  elements.terminalInputHint.textContent = t(
    connected ? "terminalInputHint" : "terminalInputDisconnected",
  );
  elements.wifiSetButton.disabled = !canMutateWifi;
  elements.wifiOffButton.disabled = !canMutateWifi;
  elements.wifiQueryButton.disabled = !canControlWifi;
  elements.wifiScanButton.disabled = !canMutateWifi;
  elements.webdavSetButton.disabled = !canControlWebdav;
  elements.webdavOffButton.disabled = !canControlWebdav;
  elements.webdavQueryButton.disabled = !canControlWebdav;
  if (elements.presetChips) {
    elements.presetChips
      .querySelectorAll(".preset-chip")
      .forEach((chip) => (chip.disabled = !connected));
  }
  document
    .querySelectorAll("#cheatList button[data-cmd]")
    .forEach((button) => (button.disabled = !connected));
  refreshConnectionActions();
  updateBleNameControls();
  renderBleNameStatus();
  if (connected) {
    setAutoScroll(true, true);
    state.term?.focus();
  }
}

function rememberDevice(device, restored = false) {
  if (!device) {
    return;
  }
  state.device = device;
  state.deviceRestored = restored;
  saveSetting(LAST_DEVICE_ID_KEY, device.id);
  /* The name belongs to the board that was there: an input still holding
   * the last board's name would write it onto this one. */
  state.bleName = null;
  state.bleNameCustom = null;
  state.bleNameSupported = null;
  if (elements.bleNameInput) {
    elements.bleNameInput.value = "";
  }
  updateBleNameControls();
  renderBleNameStatus();
  setConnected(false);
}

async function restoreAuthorizedDevice() {
  if (!bleTransport?.isAvailable()) {
    return;
  }
  try {
    const lastDeviceId = localStorage.getItem(LAST_DEVICE_ID_KEY);
    const devices = await bleTransport.getDevices(
      lastDeviceId ? [lastDeviceId] : [],
    );
    // The id is the only thing that identifies a board: the advertised
    // name is a label the owner can change, so a board is restored by the
    // id it was last seen under. Restoring by a name would pick whichever
    // board happens to carry it and talk to the wrong one.
    const device = devices.find((candidate) => candidate.id === lastDeviceId);

    if (!device) {
      return;
    }
    /* getDevices() can settle long after the user started connecting: a background
     * restore must not overwrite the device in use or tear down a live session. */
    if (state.connected || connectionInFlight || state.deviceId || state.ws) {
      debugLine("[restore] skipped: a session is already in use");
      return;
    }
    rememberDevice(device, true);
    appendLine(`[restore] ${printableDeviceName(device.name, device.id)}`);
    toast(t("authorizedDeviceReady"));
  } catch (error) {
    debugLine(`[restore] ${error.message}`);
  }
}

function requestDiagnostics() {
  if (!state.connected || state.mode !== "ble" || !state.mgmtReady) {
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

function assertWriteSession(generation, signal) {
  signal?.throwIfAborted();
  if (!state.connected || generation !== state.writeGeneration) {
    throw new Error("Device session changed; UART delivery may be incomplete.");
  }
}

function isAttSizeRejection(error) {
  // Only explicit local/ATT size rejection proves this write was not applied.
  // Timeouts and generic network errors can arrive after the peripheral wrote it.
  // Web Bluetooth names the failure, but the native bridges surface the platform
  // message instead, so match those shapes as well:
  //  - Android through the Capacitor BLE plugin:
  //    "Writing characteristic failed with status code 13."
  //    (13 = GATT_INVALID_ATTRIBUTE_LENGTH)
  //  - iOS/CoreBluetooth: "The attribute value length is invalid."
  const name = error?.name || "";
  const message = error?.message || "";
  if (name === "InvalidModificationError" || /invalid attribute (?:value )?length/i.test(message)) {
    return true;
  }
  if (/\bstatus code 13\b/.test(message)) {
    return true;
  }
  // Locale-independent fallback for platform wording that names the length as
  // invalid without matching either fixed phrase above.
  return /\blength\b[^.]*\binvalid\b/i.test(message) || /\binvalid\b[^.]*\blength\b/i.test(message);
}

async function writeBytes(bytes, sensitive = false, generation = state.writeGeneration, signal) {
  assertWriteSession(generation, signal);
  if (state.uartWriteError) throw new Error(state.uartWriteError);
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

  if (!state.reliableReady && !state.nusReady) {
    throw new Error("UART RX characteristic is not ready");
  }

  const size = state.reliableReady
    ? state.reliableMaxPayload
    : chunkSize();
  for (let offset = 0; offset < bytes.length; offset += size) {
    assertWriteSession(generation, signal);
    const chunk = bytes.slice(offset, offset + size);
    if (elements.debugInput.checked) {
      appendLine(
        sensitive
          ? `TX <redacted ${chunk.length} bytes>`
          : `TX ${chunk.length}: ${JSON.stringify(decoder.decode(chunk))}`,
      );
    }
    try {
      if (state.reliableReady) {
        await writeReliableUartChunk(chunk, generation, signal);
        state.txBytes += chunk.length;
        continue;
      }
      await bleTransport.write(
        state.device.id,
        NUS_SERVICE,
        NUS_RX,
        chunk,
        false,
      );
      assertWriteSession(generation, signal);
      state.txBytes += chunk.length;
    } catch (error) {
      if (state.uartWriteError && generation === state.writeGeneration) throw error;
      assertWriteSession(generation, signal);
      // Agent writes cannot be replayed after an uncertain legacy write, and
      // an earlier successful chunk must never be resent as part of fallback.
      if (signal || offset > 0 || !isAttSizeRejection(error)) throw error;
      if (state.reliableReady) {
        throw error;
      }
      if (size <= 20) {
        throw error;
      }
      elements.chunkInput.value = "20";
      appendLine("[warn] BLE write failed; retrying with 20-byte chunks");
      await writeBytes(bytes, sensitive, generation, signal);
      return;
    }
  }
  updateCounters();
}

function nextSequence(sequence) {
  return sequence === 0xffffffff ? 1 : sequence + 1;
}

async function writeReliableUartChunk(payload, generation = state.writeGeneration, signal) {
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
    let writesAttempted = 0;
    try {
      for (let offset = 0; offset < frame.length; offset += attSize) {
        assertWriteSession(generation, signal);
        writesAttempted += 1;
        await bleTransport.write(
          state.device.id,
          RELIABLE_UART_SERVICE,
          RELIABLE_UART_RX,
          frame.slice(offset, offset + attSize),
          true,
        );
        writesCompleted += 1;
      }
      assertWriteSession(generation, signal);
      state.reliableWriteSize = attSize;
      state.reliableTxSequence = nextSequence(sequence);
      return;
    } catch (error) {
      if (generation === state.writeGeneration && state.connected &&
          writesAttempted > 0 && (writesCompleted > 0 || !isAttSizeRejection(error))) {
        // An unfinished frame may consume the next command as its payload;
        // an unacknowledged complete frame may have advanced the peer sequence.
        // Preserve incoming logs but require a fresh session before any UART input.
        state.uartWriteError = "Reliable UART delivery is uncertain; disconnect and reconnect before sending more input.";
        throw new Error(state.uartWriteError, { cause: error });
      }
      assertWriteSession(generation, signal);
      lastError = error;
      /* Explicit size rejection before the first fragment is safe to retry
       * with the next common ATT payload size. */
    }
  }
  throw lastError || new Error("Reliable UART write failed");
}

function enqueueBytes(bytes, sensitive = false, { generation = state.writeGeneration, signal, inputRevision, trackPending = true } = {}) {
  try { assertWriteSession(generation, signal); } catch (error) { return Promise.reject(error); }
  if (inputRevision !== undefined && inputRevision !== serialInputRevision) {
    return Promise.reject(new Error("Terminal input changed; request a new command before sending."));
  }
  const queuedRevision = trackPending ? ++serialInputRevision : serialInputRevision;
  if (trackPending) {
    serialInputPending = inputLeavesPendingLine(bytes, serialInputPending);
  }
  const operation = state.writeQueue.then(async () => {
    try {
      assertWriteSession(generation, signal);
      if (inputRevision !== undefined && queuedRevision !== serialInputRevision) {
        throw new Error("Terminal input changed; request a new command before sending.");
      }
      await writeBytes(bytes, sensitive, generation, signal);
    } catch (error) {
      // A partially delivered line has unknown contents; Auto must ask next time.
      // Transport replies are not terminal input and must not latch the line.
      if (trackPending && generation === state.writeGeneration) {
        serialInputPending = true;
        serialInputRevision++;
      }
      throw error;
    }
  });
  state.writeQueue = operation.catch(() => {});
  return operation;
}

async function writeText(text, options) {
  await enqueueBytes(encoder.encode(text), false, options);
}

function sendText(text) {
  if (!state.connected) {
    return Promise.resolve();
  }
  markTerminalBusy();
  const payload = normalizeEnter(`${text}\n`);
  if (elements.localEchoInput.checked) {
    appendOutput(payload);
  }
  return writeText(payload);
}

function pendingModifiers() {
  return { ctrl: state.controlPending, shift: state.shiftPending, alt: state.altPending };
}

function updateModifierButtons() {
  const modifiers = pendingModifiers();
  elements.modifierButtons.forEach((button) => {
    const active = modifiers[button.dataset.modifier];
    const label = t(active ? "modifierActive" : "modifierNext")
      .replace("{key}", button.textContent);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", label);
    button.title = label;
  });
}

function resetModifiers() {
  state.controlPending = state.shiftPending = state.altPending = false;
  updateModifierButtons();
}

function onTerminalData(data, { raw = false, userInput = true } = {}) {
  if (!state.connected || !data) {
    return;
  }
  if (!userInput) {
    // Replies and focus reports are transport data, not keystrokes. Preserve
    // armed modifiers and send these bytes without local echo or CR mapping.
    // They must not mark the terminal input line as pending: a program that
    // queries the terminal (DSR/DA/focus) would otherwise block tracked
    // commands and geometry sync until the user pressed Enter.
    writeText(data, { trackPending: false }).catch((error) => appendLine(`[error] ${error.message}`));
    return;
  }
  markTerminalBusy();
  const modifiers = pendingModifiers();
  const modified = Object.values(modifiers).some(Boolean);
  if (modified) data = applyInputModifiers(data, modifiers);
  resetModifiers();
  const payload = raw || modified ? data : normalizeEnter(data);
  if (elements.localEchoInput.checked) {
    appendOutput(payload);
  }
  writeText(payload).catch((error) => appendLine(`[error] ${error.message}`));
}

async function sendControl(command, { returnResponse = false } = {}) {
  const sensitive = command.startsWith("@w=") || command.startsWith("@d=");
  appendLine(
    `[control] ${sensitive ? `${command.slice(0, 2)}=<redacted>` : command}`,
  );
  if (state.mode !== "ble" || !state.mgmtReady) {
    throw new Error("Management characteristic is not ready");
  }
  if (state.mgmtWriteError) throw new Error(state.mgmtWriteError);
  const generation = state.writeGeneration;
  const deviceId = state.device?.id;
  const responses = state.mgmtResponses;

  const requestId = state.nextRequestId || 1;
  state.nextRequestId = requestId === 0xffffffff ? 1 : requestId + 1;
  const payload = encoder.encode(command);
  if (payload.length === 0 || payload.length > state.mgmtMaxPayload) {
    throw new Error("Management command payload is outside the advertised limit");
  }
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
    assertWriteSession(generation);
    if (state.mgmtWriteError) throw new Error(state.mgmtWriteError);
    if (!state.connected || !state.mgmtReady || !state.device) {
      throw new Error("Management characteristic is not ready");
    }
    const response = responses.wait(requestId);
    let writesCompleted = 0;
    let writesAttempted = 0;
    /* The first GATT write must contain the complete 12-byte management
     * header. Keep 20 bytes as the minimum even if the terminal's raw UART
     * chunk-size control is configured lower. */
    try {
      const size = Math.max(20, chunkSize());
      for (let offset = 0; offset < frame.length; offset += size) {
        assertWriteSession(generation);
        const chunk = frame.slice(offset, offset + size);
        if (elements.debugInput.checked) {
          appendLine(
            sensitive
              ? `MGMT TX #${requestId} <redacted ${chunk.length} bytes>`
              : `MGMT TX #${requestId} ${chunk.length} bytes`,
          );
        }
        writesAttempted += 1;
        await bleTransport.write(
          deviceId,
          MGMT_SERVICE,
          MGMT_COMMAND,
          chunk,
          true,
        );
        writesCompleted += 1;
        assertWriteSession(generation);
      }
    } catch (error) {
      if (generation === state.writeGeneration && state.connected &&
          writesAttempted > 0 && (writesCompleted > 0 || !isAttSizeRejection(error))) {
        // A partial management frame must not absorb a later settings request.
        state.mgmtWriteError = "Management delivery is uncertain; disconnect and reconnect before sending more settings commands.";
        error = new Error(state.mgmtWriteError, { cause: error });
      }
      responses.reject(requestId, error);
    }
    const reply = await response;
    assertWriteSession(generation);
    return returnResponse ? reply.text : requestId;
  });
  state.controlWriteQueue = operation.catch(() => {});
  return operation;
}

function dispatchManagementMessage(message) {
  const text = decoder.decode(message.payload);
  const kind = message.type === 3 ? "event" : "response";
  if (elements.debugInput.checked) {
    appendLine(
      `[mgmt ${kind} #${message.requestId} flags=0x${message.flags.toString(16)}]`,
    );
  }
  feedManagementText(text);
  for (const line of text.split(/\r?\n/)) {
    if (line) {
      appendLine(`[${kind} #${message.requestId}] ${redactSecrets(line)}`);
    }
  }
  state.mgmtResponses.settle({ ...message, text });
}

/* Reassembly lives in management_protocol.js so the framing rules are unit
 * tested; these handlers only map a reject reason to a user-visible message and
 * apply the connection-level sequence rules. */
const mgmtReassembler = createFragmentReassembler({
  headerSize: MGMT_HEADER_SIZE,
  maxPayload: () => state.mgmtMaxPayload,
  parseHeader: parseManagementHeader,
});
const reliableReassembler = createFragmentReassembler({
  headerSize: RELIABLE_UART_HEADER_SIZE,
  maxPayload: () => state.reliableMaxPayload,
  parseHeader: (bytes) => parseReliableHeader(bytes, state.reliableMaxPayload),
});

function onManagementIndication(value) {
  const result = mgmtReassembler.push(value);
  if (result.status === "incomplete") return;
  if (result.status === "error") {
    appendLine(`[error] ${MGMT_FRAME_ERRORS[result.reason] || "invalid management response"}`);
    return;
  }
  dispatchManagementMessage({ ...result.meta, payload: result.payload });
}

function onReliableUartIndication(value) {
  const result = reliableReassembler.push(value);
  if (result.status === "incomplete") return;
  if (result.status === "error") {
    appendLine(`[error] ${RELIABLE_FRAME_ERRORS[result.reason] || "invalid Reliable UART frame"}`);
    return;
  }
  const { sequence } = result.meta;
  // u32 sequence with 0xffffffff -> 1 wraparound.
  const previous = state.reliableRxSequence === 1
    ? 0xffffffff
    : state.reliableRxSequence - 1;
  if (sequence === previous) {
    return; // Duplicate of the frame we already delivered.
  }
  if (sequence !== state.reliableRxSequence) {
    // A gap cannot be recovered by waiting: every later frame keeps failing the
    // same check. Latch the desynchronized state, say so once, and stop logging
    // per-frame errors that would otherwise flood the terminal forever.
    if (!state.reliableRxDesync) {
      state.reliableRxDesync = true;
      appendLine(
        `[error] Reliable UART sequence gap: expected ${state.reliableRxSequence}, got ${sequence}. `
        + "Serial output is no longer delivered; disconnect and reconnect the device.",
      );
    }
    return;
  }
  state.reliableRxSequence = nextSequence(state.reliableRxSequence);
  handleIncomingBytes(result.payload);
}

function handleIncomingBytes(bytes) {
  agentJournal.append(bytes);
  agentPanel?.logsChanged();
  appendLogBytes(bytes);
  state.rxBytes += bytes.length;
  updateCounters();
  const text = rxDecoder.decode(bytes, { stream: true });
  if (terminalSessionTracker.push(text)) invalidateTerminalGeometrySync();
  if (elements.debugInput.checked) {
    appendLine(`RX ${bytes.length}: ${JSON.stringify(text)}`);
  }
  appendOutput(bytes);
}

function onDisconnected() {
  bleNotificationSession = null;
  const hadSession = Boolean(
    state.connected ||
      state.nusReady ||
      state.mgmtReady ||
      state.reliableReady ||
      state.deviceId ||
      state.ws,
  );
  state.nusReady = false;
  state.mgmtReady = false;
  state.reliableReady = false;
  state.legacy = false;
  state.bleName = null;
  state.bleNameCustom = null;
  state.bleNameSupported = null;
  if (elements.bleNameInput) {
    elements.bleNameInput.value = "";
  }
  state.reliableMaxPayload = 20;
  state.reliableWriteSize = BLE_MAX_ATT_VALUE;
  // Drop any half-received frame: the next connection restarts the sequence.
  reliableReassembler.reset();
  mgmtReassembler.reset();
  state.mgmtResponses.rejectAll(
    new Error("Disconnected before management response"),
  );
  state.deviceId = "";
  state.mgmtCapabilities = 0;
  state.mgmtMaxPayload = 512;
  state.ws = null;
  state.scanning = false;
  state.diagnostics = {};
  rxDecoder = new TextDecoder();
  clearWifiRefreshTimers();
  state.wifiOperation = null;
  clearTimeout(state.scanTimer);
  state.scanResults = [];
  updateWifiDatalist();
  renderDiagnostics();
  setConnected(false);
  if (hadSession) {
    appendLine("[disconnected]");
  }
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const host = elements.wsHostInput.value.trim();
    if (!host) {
      setWsHostError(t("wsMissingHost"), true, "wsMissingHost");
      reject(new Error(t("wsMissingHost")));
      return;
    }
    const token = elements.wsTokenInput.value.trim().toLowerCase();
    if (token && !/^[0-9a-f]{32}$/.test(token)) {
      setWsTokenError(t("wsTokenInvalid"), true, "wsTokenInvalid");
      reject(new Error(t("wsTokenInvalid")));
      return;
    }
    clearWsErrors();
    saveSetting(WS_HOST_KEY, host);
    const url = /^wss?:\/\//.test(host) ? host : `ws://${host}/ws`;
    const ws = new WebSocket(url);
    let opened = false;
    let settled = false;
    let sentToken = false;

    const clearTimers = () => {
      clearTimeout(connectTimer);
      clearTimeout(handshakeTimer);
    };
    const failConnect = (message, { field = "host", i18nKey = "" } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      if (state.ws === ws) {
        state.ws = null;
      }
      if (field === "token") {
        setWsTokenError(message, true, i18nKey);
      } else {
        setWsHostError(message, true, i18nKey);
      }
      reject(new Error(message));
    };
    const connectTimer = setTimeout(() => {
      failConnect(t("wsTimeout"), { i18nKey: "wsTimeout" });
      ws.close();
    }, WS_CONNECT_TIMEOUT_MS);
    let handshakeTimer = 0;

    state.ws = ws;
    state.wsHost = url;
    ws.binaryType = "arraybuffer";
    appendLine(`[connect] ${url}`);

    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      opened = true;
      clearWsErrors();
      /* Persist the token only after the access handshake accepted it: a rejected
       * or unreachable attempt must not overwrite a token that still works. */
      lanTokens.edit(token);
      lanTokens.save();
      setConnected(true);
      appendLine("[ready]");
      resolve();
    };

    /* Before the handshake completes, text frames are protocol frames and are
     * never terminal output. UART data always arrives as binary frames. */
    const handleHandshakeFrame = (text) => {
      const frame = String(text).trim();
      if (frame === WS_AUTH_NONE_FRAME || frame === WS_AUTH_OK_FRAME) {
        succeed();
        return true;
      }
      if (frame === WS_AUTH_REQUIRED_FRAME) {
        if (!token) {
          failConnect(t("wsTokenRequired"), { field: "token", i18nKey: "wsTokenRequired" });
          ws.close();
          return true;
        }
        sentToken = true;
        ws.send(token);
        return true;
      }
      return false;
    };

    ws.onopen = () => {
      if (settled || state.ws !== ws) {
        ws.close();
        return;
      }
      handshakeTimer = setTimeout(() => {
        failConnect(t("wsNoHandshake"), { i18nKey: "wsNoHandshake" });
        ws.close();
      }, WS_HANDSHAKE_TIMEOUT_MS);
    };
    ws.onmessage = (event) => {
      if (state.ws !== ws) return;
      if (!opened) {
        if (typeof event.data === "string" && handleHandshakeFrame(event.data)) {
          return;
        }
        appendLine("[warn] ignored LAN frame before the access handshake");
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        handleIncomingBytes(new Uint8Array(event.data));
      } else if (typeof event.data === "string") {
        handleIncomingBytes(encoder.encode(event.data));
      }
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      if (opened) {
        onDisconnected();
        return;
      }
      if (sentToken) {
        failConnect(t("wsAuthRejected"), { field: "token", i18nKey: "wsAuthRejected" });
      } else {
        failConnect(t("wsUnreachable").replace("{url}", url));
      }
    };
    ws.onerror = () => {
      if (state.ws !== ws || opened) return;
      failConnect(t("wsUnreachable").replace("{url}", url));
    };
  });
}

async function connect({ chooseDevice = false } = {}) {
  if (connectionInFlight || state.connected) return;
  connectionInFlight = true;
  try {
    await connectOnce({ chooseDevice });
  } finally {
    connectionInFlight = false;
    setConnecting(false);
  }
}

/* A pre-Management-Service board still speaks the plain Nordic UART Service.
 * Subscribe to its notify characteristic and mark the session terminal-only:
 * every accessory control is gated on `state.mgmtReady`, so none of them will
 * try to send a management frame the old firmware cannot answer. */
async function adoptLegacyNus(device) {
  const notificationSession = {};
  bleNotificationSession = notificationSession;
  state.writeGeneration += 1;
  agentPanel?.connectionChanged(false);
  agentJournal.reset();
  await bleTransport.startNotifications(
    device.id,
    NUS_SERVICE,
    NUS_TX,
    (value) => {
      if (bleNotificationSession !== notificationSession) return;
      const bytes = new Uint8Array(
        value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ),
      );
      handleIncomingBytes(bytes);
    },
  );
  state.legacy = true;
  state.mgmtReady = false;
  state.reliableReady = false;
  state.nusReady = true;
  state.mgmtCapabilities = 0;
  state.deviceId = "";
  state.deviceRestored = false;
  elements.wsTokenInput.value = lanTokens.selectDevice("");
  setConnected(true, { preserveJournal: true });
  appendLine(`[legacy] ${printableDeviceName(device.name, device.id)}`);
  appendLine(t("legacyHint"));
}

async function connectOnce({ chooseDevice = false } = {}) {
  if (state.mode === "ws") {
    setConnecting(true);
    try {
      await connectWs();
    } catch (error) {
      // connectWs() already routed the message to the offending field.
      if (elements.wsHostError.hidden && elements.wsTokenError.hidden) {
        setWsHostError(error.message, true);
      }
      appendLine(`[error] ${error.message}`);
      setConnected(false);
    } finally {
      setConnecting(false);
    }
    return;
  }

  if (!bleTransport?.isAvailable()) {
    appendLine("[error] Bluetooth LE transport is not available");
    return;
  }

  setConnecting(true);
  const restoredAttempt = Boolean(!chooseDevice && state.device && state.deviceRestored);
  let device = chooseDevice ? null : state.device;
  let transportConnected = false;
  let pairingAttempted = false;
  try {
    await bleTransport.initialize();
    if (!device) {
      appendLine(`[scan] requesting a Linkr Bee device`);
      device = await bleTransport.requestDevice({
        filters: BLE_REQUEST_FILTERS,
        optionalServices: [MGMT_SERVICE, NUS_SERVICE, RELIABLE_UART_SERVICE],
      });
      rememberDevice(device);
    }

    appendLine(`[pairing] ${t("pairingHint")}`);
    appendLine(`[connect] ${printableDeviceName(device.name, device.id)}`);
    pairingAttempted = true;
    await bleTransport.connect(device.id, onDisconnected);
    transportConnected = true;
    state.nusReady = true;
    state.legacy = false;
    let protocolValue;
    try {
      protocolValue = await bleTransport.read(
        device.id,
        MGMT_SERVICE,
        MGMT_PROTOCOL,
      );
    } catch (error) {
      /* The oldest firmware has no Management Service, and its terminal
       * stays usable. Which board this is, is told by the failure and not
       * by the name: a service that is not there is a legacy board, while
       * a read that was refused is a pairing problem on a board that
       * promised the service. The name says neither - the owner chooses
       * it, and can choose it for a current board too. */
      if (!isMissingService(error)) throw error;
      await adoptLegacyNus(device);
      return;
    }
    if (protocolValue.byteLength < 10 || protocolValue.getUint8(0) !== MGMT_API_MAJOR) {
      throw new Error("Unsupported Linkr Management API version");
    }
    state.mgmtMaxPayload = protocolValue.getUint16(2, true);
    if (state.mgmtMaxPayload === 0) {
      throw new Error("Invalid Linkr Management payload limit");
    }
    state.mgmtCapabilities = protocolValue.getUint32(4, true);
    if (!hasManagementCapability(MGMT_CAP_DEVICE_ID)) {
      throw new Error("Device does not advertise Device ID support");
    }
    if (!hasManagementCapability(MGMT_CAP_RELIABLE_UART)) {
      throw new Error("Device does not advertise Reliable UART support");
    }
    const deviceIdValue = await bleTransport.read(
      device.id,
      MGMT_SERVICE,
      MGMT_DEVICE_ID,
    );
    if (deviceIdValue.byteLength !== 16) {
      throw new Error("Invalid Linkr Device ID length");
    }
    // Any device can advertise the Management Service UUID; the namespace is
    // what makes the service a filter. Python and the C client check it too.
    const deviceIdBytes = new Uint8Array(
      deviceIdValue.buffer,
      deviceIdValue.byteOffset,
      deviceIdValue.byteLength,
    );
    const linkrNamespace = [0x4c, 0x49, 0x4e, 0x4b, 0x52, 0x42, 0x4c, 0x45, 0x01, 0x00];
    if (!linkrNamespace.every((byte, index) => deviceIdBytes[index] === byte)) {
      throw new Error("Device ID is not a Linkr Bee ID");
    }
    state.deviceId = Array.from(deviceIdBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    elements.wsTokenInput.value = lanTokens.selectDevice(state.deviceId);
    // Notifications can arrive before startNotifications resolves. Start the
    // evidence window before subscribing, and retain these first bytes when
    // the handshake completes. Retired callbacks cannot feed the next device.
    const notificationSession = {};
    bleNotificationSession = notificationSession;
    // Offline diagnostics may still be running. Retire that generation before
    // its journal is replaced, without changing the connecting UI state.
    state.writeGeneration += 1;
    agentPanel?.connectionChanged(false);
    agentJournal.reset();
    await bleTransport.startNotifications(
      device.id,
      MGMT_SERVICE,
      MGMT_RESPONSE,
      (value) => {
        if (bleNotificationSession === notificationSession) onManagementIndication(value);
      },
    );
    state.mgmtReady = true;
    const reliableState = await bleTransport.read(
      device.id,
      RELIABLE_UART_SERVICE,
      RELIABLE_UART_STATE,
    );
    if (reliableState.byteLength !== 16 || reliableState.getUint8(0) !== 1) {
      throw new Error("Unsupported Reliable UART version");
    }
    const reliablePayloadLimit = reliableState.getUint16(2, true);
    const reliableTxSequence = reliableState.getUint32(4, true);
    const reliableRxSequence = reliableState.getUint32(8, true);
    if (
      reliablePayloadLimit === 0 ||
      reliableTxSequence === 0 ||
      reliableRxSequence === 0
    ) {
      throw new Error("Invalid Reliable UART state");
    }
    state.reliableMaxPayload = Math.max(
      1,
      Math.min(
        reliablePayloadLimit,
        BLE_MAX_ATT_VALUE - RELIABLE_UART_HEADER_SIZE,
      ),
    );
    state.reliableWriteSize = BLE_MAX_ATT_VALUE;
    state.reliableTxSequence = reliableTxSequence;
    state.reliableRxSequence = reliableRxSequence;
    state.reliableRxDesync = false;
    await bleTransport.startNotifications(
      device.id,
      RELIABLE_UART_SERVICE,
      RELIABLE_UART_TX,
      (value) => {
        if (bleNotificationSession === notificationSession) onReliableUartIndication(value);
      },
    );
    state.reliableReady = true;
    state.deviceRestored = false;
    setConnected(true, { preserveJournal: true });
    appendLine(`[ready] API v${protocolValue.getUint8(0)}.${protocolValue.getUint8(1)} device=${state.deviceId}`);
    requestDeviceState().catch((error) =>
      appendLine(`[error] ${error.message}`),
    );
    readBleName({ quiet: true });
  } catch (error) {
    appendLine(`[error] ${error.message}`);
    if (pairingAttempted) {
      appendLine(`[pairing] ${t("pairingFailed")}`);
      toast(t("pairingFailed"), "error");
    }
    if (device) {
      // Always attempt to release the transport, not just when we saw it
      // connect: a native host can finish a connect after our own timeout, and
      // leaving that link up would contradict the failed state shown here.
      try {
        await bleTransport.disconnect(device.id);
      } catch (_disconnectError) {
        // The transport may already have closed after a failed GATT operation.
      }
      if (transportConnected) {
        onDisconnected();
      }
    }
    if (restoredAttempt) {
      localStorage.removeItem(LAST_DEVICE_ID_KEY);
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

  /* Double taps fire two teardowns whose notification/race handling interleaves. */
  if (disconnectInFlight) return;
  disconnectInFlight = true;
  try {
    if (state.mgmtReady && state.device) {
      try {
        await bleTransport.stopNotifications(
          state.device.id,
          MGMT_SERVICE,
          MGMT_RESPONSE,
        );
      } catch (_error) {
        // Ignore disconnect races.
      }
    }
    if (state.reliableReady && state.device) {
      try {
        await bleTransport.stopNotifications(
          state.device.id,
          RELIABLE_UART_SERVICE,
          RELIABLE_UART_TX,
        );
      } catch (_error) {
        // Ignore disconnect races.
      }
    }
    if (state.legacy && state.device) {
      try {
        await bleTransport.stopNotifications(
          state.device.id,
          NUS_SERVICE,
          NUS_TX,
        );
      } catch (_error) {
        // Ignore disconnect races.
      }
    }

    if (state.device && (await bleTransport.isConnected())) {
      await bleTransport.disconnect(state.device.id);
      if (state.connected) {
        onDisconnected();
      }
    } else if (state.connected) {
      onDisconnected();
    }
  } finally {
    disconnectInFlight = false;
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
    : [encoder.encode(redactSecrets(elements.terminalOutput.textContent))];
  const blob = new Blob(chunks, { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `linkr-ble-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  link.click();
  // Release the blob after the browser has had time to start the download;
  // revoking synchronously can cancel it in Firefox/Safari.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
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
  state.sidebarCollapsed = localStorage.getItem("linkr-sidebar") !== "open";
  const savedHost = localStorage.getItem(WS_HOST_KEY);
  if (savedHost && elements.wsHostInput) {
    elements.wsHostInput.value = savedHost;
  }
  elements.wsTokenInput.value = lanTokens.selectHost(elements.wsHostInput.value);
  syncBaudControls();
  updateBaudLabel();
}

function updateBaudLabel() {
  const baud = String(elements.uartInput.value || "").split(",")[0].trim();
  if (elements.baudLabel && baud) {
    elements.baudLabel.textContent = baud;
  }
}

/* The presets live in the select itself, so the visible options are the single
 * source of truth. Anything else in the UART string selects "Custom…" and opens
 * the numeric field with the current value. */
function supportedBaud(rate) {
  return (
    Number.isInteger(rate) &&
    rate >= ACCESSORY_LIMITS.minBaud &&
    rate <= ACCESSORY_LIMITS.maxBaud
  );
}

function uartBaudToken(value) {
  const token = String(value ?? "").split(",")[0].trim();
  return /^\d+$/.test(token) ? Number(token) : NaN;
}

function syncBaudControls() {
  if (!elements.baudSelect || !elements.baudCustomField) {
    return;
  }
  const rate = uartBaudToken(elements.uartInput.value);
  const preset = supportedBaud(rate)
    ? [...elements.baudSelect.options].find(
        (option) => option.value === String(rate),
      )
    : null;
  if (preset) {
    elements.baudSelect.value = preset.value;
    elements.baudCustomField.hidden = true;
    return;
  }
  elements.baudSelect.value = "custom";
  elements.baudCustomField.hidden = false;
  elements.baudCustomInput.value = Number.isInteger(rate) ? String(rate) : "";
}

/* Rewrite only the baud field of "baud,data,parity,stop,flow" so a preset never
 * discards the frame settings the user already typed. */
function setUartBaud(rate) {
  const current = String(elements.uartInput.value || "").trim();
  const comma = current.indexOf(",");
  const suffix = comma >= 0 ? current.slice(comma) : ",8,n,1,n";
  const value = `${rate}${suffix}`;
  elements.uartInput.value = value;
  saveSetting("linkr-uart", value);
  updateBaudLabel();
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_error) {
    // Storage may be unavailable; ignore.
  }
}

const mobileMedia = window.matchMedia("(max-width: 900px)");
let sidebarReturnFocus = null;
const softKeyboardLayout = {
  active: false,
  fullHeight: 0,
  viewportWidth: 0,
  raf: 0,
};

function isMobile() {
  return mobileMedia.matches;
}

function usesSettingsDrawer() {
  return isMobile() || prefersSettingsDrawer;
}

function viewportSize() {
  const viewport = window.visualViewport;
  return {
    width: Math.round(viewport?.width || window.innerWidth),
    height: Math.round(viewport?.height || window.innerHeight),
  };
}

function terminalHasFocus() {
  const active = document.activeElement;
  return Boolean(active && elements.terminalOutput.contains(active));
}

function syncSoftKeyboardLayout() {
  const { width, height } = viewportSize();
  if (
    !softKeyboardLayout.viewportWidth ||
    Math.abs(width - softKeyboardLayout.viewportWidth) > 64
  ) {
    softKeyboardLayout.viewportWidth = width;
    softKeyboardLayout.fullHeight = height;
  } else {
    softKeyboardLayout.fullHeight = Math.max(
      softKeyboardLayout.fullHeight,
      height,
    );
  }

  const heightLoss = softKeyboardLayout.fullHeight - height;
  const keyboardHeight = Math.max(120, softKeyboardLayout.fullHeight * 0.2);
  const compactInputDevice = isHarmonyHost || coarsePointerMedia.matches;
  const active =
    compactInputDevice &&
    heightLoss > keyboardHeight &&
    (terminalHasFocus() || agentPanel?.hasInputFocus() ||
      (elements.controlsPanel.contains(document.activeElement) && document.activeElement.matches("input, textarea")) ||
      softKeyboardLayout.active);

  // iOS/Android WebViews may resize only the visual viewport, leaving dvh
  // unchanged. Size the workspace to the area actually above the keyboard.
  // visualViewport also fires for plain scrolls: skip identical writes so the
  // stylesheet is not dirtied every frame.
  const viewportHeight = `${height}px`;
  const settingsTop = `${window.visualViewport?.offsetTop || 0}px`;
  if (softKeyboardLayout.appliedHeight !== viewportHeight) {
    softKeyboardLayout.appliedHeight = viewportHeight;
    document.documentElement.style.setProperty("--terminal-viewport-height", viewportHeight);
  }
  if (softKeyboardLayout.appliedTop !== settingsTop) {
    softKeyboardLayout.appliedTop = settingsTop;
    document.documentElement.style.setProperty("--settings-viewport-top", settingsTop);
  }
  agentPanel?.syncLayout({ keyboardOpen: active });

  if (active === softKeyboardLayout.active) {
    return;
  }

  softKeyboardLayout.active = active;
  document.documentElement.classList.toggle("soft-keyboard-open", active);
  scheduleFit();
}

function scheduleSoftKeyboardLayout() {
  if (softKeyboardLayout.raf) {
    return;
  }
  softKeyboardLayout.raf = requestAnimationFrame(() => {
    softKeyboardLayout.raf = 0;
    syncSoftKeyboardLayout();
  });
}

function initSoftKeyboardLayout() {
  syncSoftKeyboardLayout();
  window.addEventListener("resize", scheduleSoftKeyboardLayout, {
    passive: true,
  });
  window.visualViewport?.addEventListener(
    "resize",
    scheduleSoftKeyboardLayout,
    { passive: true },
  );
  window.visualViewport?.addEventListener(
    "scroll",
    scheduleSoftKeyboardLayout,
    { passive: true },
  );
  document.addEventListener("focusin", scheduleSoftKeyboardLayout);
  document.addEventListener("focusout", () => {
    window.setTimeout(scheduleSoftKeyboardLayout, 0);
  });
  window.addEventListener("orientationchange", () => {
    softKeyboardLayout.viewportWidth = 0;
    softKeyboardLayout.fullHeight = 0;
    scheduleSoftKeyboardLayout();
  });
}

function setInert(element, inert) {
  if (!element) {
    return;
  }
  element.inert = inert;
  element.toggleAttribute("inert", inert);
}

function syncSidebarAccessibility({ focusDrawer = false, restoreToggle = false } = {}) {
  const returnButton = sidebarReturnFocus === $("agentSettingsButton") && agentPanel?.isOpen()
    ? sidebarReturnFocus : elements.panelToggle;
  const drawerLayout = usesSettingsDrawer();
  // Use the same drawer presentation for touch and narrow desktop windows.
  document.documentElement.classList.toggle("settings-drawer-layout", drawerLayout);
  const drawerOpen =
    drawerLayout && elements.appShell.classList.contains("sidebar-open");
  const sidebarHidden = drawerLayout
    ? !drawerOpen
    : elements.appShell.classList.contains("controls-hidden");

  if (!drawerOpen) {
    setInert(elements.topbar, false);
    setInert(elements.workpanel, false);
    if (
      restoreToggle &&
      elements.controlsPanel.contains(document.activeElement)
    ) {
      returnButton.focus({ preventScroll: true });
    }
  }

  elements.panelToggle.setAttribute("aria-expanded", String(!sidebarHidden));
  elements.controlsPanel.setAttribute("aria-hidden", String(sidebarHidden));
  setInert(elements.controlsPanel, sidebarHidden);
  elements.drawerBackdrop.setAttribute("aria-hidden", String(!drawerOpen));
  document.body.classList.toggle("drawer-open", drawerOpen);
  if (drawerOpen) {
    setInert(elements.topbar, true);
    setInert(elements.workpanel, true);
  }

  if (drawerLayout) {
    elements.controlsPanel.setAttribute("role", "dialog");
    if (drawerOpen) {
      elements.controlsPanel.setAttribute("aria-modal", "true");
    } else {
      elements.controlsPanel.removeAttribute("aria-modal");
    }
  } else {
    elements.controlsPanel.removeAttribute("role");
    elements.controlsPanel.removeAttribute("aria-modal");
  }

  if (focusDrawer && drawerOpen) {
    requestAnimationFrame(() => elements.drawerClose.focus());
  } else if (
    restoreToggle &&
    !drawerOpen &&
    document.activeElement !== returnButton
  ) {
    requestAnimationFrame(() => returnButton.focus({ preventScroll: true }));
  }
}

function setMobileSidebarOpen(open, { restoreFocus = true } = {}) {
  if (!usesSettingsDrawer()) {
    return;
  }
  elements.appShell.classList.toggle("sidebar-open", open);
  syncSidebarAccessibility({
    focusDrawer: open,
    restoreToggle: !open && restoreFocus,
  });
}

function applySidebar() {
  if (state.sidebarCollapsed && !usesSettingsDrawer()) {
    elements.appShell.classList.add("controls-hidden");
  }
  syncSidebarAccessibility();
}

function toggleSidebar() {
  sidebarReturnFocus = elements.panelToggle;
  if (usesSettingsDrawer()) {
    setMobileSidebarOpen(
      !elements.appShell.classList.contains("sidebar-open"),
    );
  } else {
    const hidden = elements.appShell.classList.toggle("controls-hidden");
    state.sidebarCollapsed = hidden;
    saveSetting("linkr-sidebar", hidden ? "collapsed" : "open");
    syncSidebarAccessibility();
  }
}

function openAgentSettings() {
  setSettingsPage("ai");
  sidebarReturnFocus = $("agentSettingsButton");
  if (usesSettingsDrawer()) {
    setMobileSidebarOpen(true);
  } else {
    elements.appShell.classList.remove("controls-hidden");
    state.sidebarCollapsed = false;
    saveSetting("linkr-sidebar", "open");
    syncSidebarAccessibility();
    elements.drawerClose.focus({ preventScroll: true });
  }
}

function closeSidebar({ restoreFocus = true } = {}) {
  const wasOpen = usesSettingsDrawer()
    ? elements.appShell.classList.contains("sidebar-open")
    : !elements.appShell.classList.contains("controls-hidden");
  elements.appShell.classList.remove("sidebar-open");
  if (!usesSettingsDrawer()) {
    elements.appShell.classList.add("controls-hidden");
    state.sidebarCollapsed = true;
    saveSetting("linkr-sidebar", "collapsed");
  }
  syncSidebarAccessibility({
    restoreToggle: wasOpen && restoreFocus,
  });
}

function setSettingsPage(page) {
  const next = ["connection", "terminal", "network", "about", ...(agentSettings ? ["ai"] : [])].includes(page)
    ? page
    : "connection";
  elements.controls.dataset.settingsActive = next;
  elements.settingsTabs.forEach((tab) => {
    const selected = tab.dataset.settingsTarget === next;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  saveSetting("linkr-settings-page", next);
}

function syncSidebarForViewport() {
  elements.appShell.classList.remove("sidebar-open");
  if (usesSettingsDrawer()) {
    elements.appShell.classList.remove("controls-hidden");
  } else {
    elements.appShell.classList.toggle(
      "controls-hidden",
      state.sidebarCollapsed,
    );
  }
  syncSidebarAccessibility();
  scheduleFit();
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
      const action = state.connected ? disconnect() : connect();
      action.catch((error) => appendLine(`[error] ${error.message}`));
    });
  }

  elements.disconnectButton.addEventListener("click", () => {
    disconnect().catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.switchDeviceButton.addEventListener("click", () => {
    connect({ chooseDevice: true }).catch((error) => appendLine(`[error] ${error.message}`));
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

  elements.bleNameSetButton.addEventListener("click", () => {
    setNameFromInput();
  });
  elements.bleNameDefaultButton.addEventListener("click", () => {
    restoreDefaultBleName();
  });
  elements.bleNameQueryButton.addEventListener("click", () => {
    readBleName();
  });
  elements.bleNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setNameFromInput();
    }
  });

  elements.clearButton.addEventListener("click", () => {
    clearTerminalOutput(true);
    state.logBytes = [];
    state.logSize = 0;
    agentJournal.reset();
    agentPanel?.logsCleared();
    toast(t("cleared"));
  });

  elements.saveButton.addEventListener("click", saveLog);

  // Keep the terminal textarea focused when a pointer activates an accessory
  // key. Focus synchronously on click so iOS can retain/open its soft keyboard.
  elements.terminalKeyBar.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });
  elements.modifierButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.connected) return;
      const field = { ctrl: "controlPending", shift: "shiftPending", alt: "altPending" }
        [button.dataset.modifier];
      state[field] = !state[field];
      updateModifierButtons();
      state.term?.focus();
    });
  });
  elements.terminalKeyButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.connected) return;
      const key = button.dataset.terminalKey;
      const modifiers = pendingModifiers();
      const data = terminalKeySequence(key, state.term?.modes.applicationCursorKeysMode, modifiers);
      resetModifiers();
      state.term?.focus();
      onTerminalData(data, { raw: key !== "Enter" || Object.values(modifiers).some(Boolean) });
    });
  });

  elements.pasteTerminalButton.addEventListener("click", async () => {
    if (!state.connected) return;
    const generation = state.writeGeneration;
    resetModifiers();
    state.term?.focus();
    try {
      const text = await navigator.clipboard.readText();
      if (state.connected && generation === state.writeGeneration) {
        // xterm applies the remote application's bracketed-paste mode.
        resetModifiers();
        state.term?.paste(text);
      }
    } catch (_error) {
      toast(t("pasteUnavailable"), "error");
    }
  });

  elements.focusTerminalButton.addEventListener("click", () => {
    state.term?.focus();
  });

  elements.terminalOutput.addEventListener("pointerdown", () => {
    if (state.connected) {
      window.requestAnimationFrame(() => state.term?.focus());
    }
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
      .then((requestId) => {
        // The reply only means "queued". Completion arrives as FINAL events
        // carrying this request id as the operation id.
        state.wifiOperation = { id: requestId, ssid };
        state.wifiStatus.ssid = ssid;
        setWifiFeedback("wifiPhaseQueued", { ssid });
        toast(t("wifiSet"));
        scheduleWifiOperationFallback();
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
      .then((requestId) => {
        state.wifiOperation = { id: requestId, ssid: "" };
        state.wifiStatus = { connected: false, ssid: "", ip: "down" };
        updateWifiConnectionView();
        setWifiFeedback("wifiPhaseOff");
        scheduleWifiOperationFallback();
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
          const confirmKey = chip.dataset.confirm;
          if (confirmKey && !window.confirm(t(confirmKey))) {
            return;
          }
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
      if (!navigator.clipboard?.writeText) {
        toast(t("copyFailed"), "error");
        return;
      }
      navigator.clipboard.writeText(sel).then(
        () => toast(t("copied")),
        () => toast(t("copyFailed"), "error"),
      );
    }
  });

  elements.themeButton.addEventListener("click", toggleTheme);
  elements.drawerThemeButton?.addEventListener("click", toggleTheme);
  elements.langButton.addEventListener("click", toggleLanguage);
  elements.drawerLangButton?.addEventListener("click", toggleLanguage);

  elements.bleModeBtn.addEventListener("click", () => setTransportMode("ble"));
  elements.lanModeBtn.addEventListener("click", () => setTransportMode("ws"));

  elements.panelToggle.addEventListener("click", toggleSidebar);
  elements.drawerClose.addEventListener("click", () => closeSidebar());
  elements.drawerBackdrop.addEventListener("click", () => closeSidebar());
  elements.settingsTabs.forEach((tab) => {
    tab.addEventListener("click", () => setSettingsPage(tab.dataset.settingsTarget));
  });
  elements.wsHostInput.addEventListener("input", () => {
    setWsHostError();
    elements.wsTokenInput.value = lanTokens.selectHost(elements.wsHostInput.value);
  });
  elements.wsTokenInput.addEventListener("input", () => {
    setWsTokenError(); lanTokens.edit(elements.wsTokenInput.value);
  });

  let drawerTouchStart = null;
  elements.controls.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    drawerTouchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, { passive: true });
  elements.controls.addEventListener("touchend", (event) => {
    if (!drawerTouchStart || !usesSettingsDrawer()) {
      drawerTouchStart = null;
      return;
    }
    const touch = event.changedTouches[0];
    if (touch) {
      const dx = touch.clientX - drawerTouchStart.x;
      const dy = touch.clientY - drawerTouchStart.y;
      if (dx > 72 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        closeSidebar();
      }
    }
    drawerTouchStart = null;
  }, { passive: true });

  document.addEventListener("fullscreenchange", onFullscreenChange);

  document.addEventListener("keydown", (event) => {
    // Escape may cancel a mobile/IME composition without leaving its editor.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      if (
        usesSettingsDrawer() &&
        elements.appShell.classList.contains("sidebar-open")
      ) {
        event.preventDefault();
        event.stopPropagation();
        closeSidebar();
      }
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

  elements.baudSelect.addEventListener("change", () => {
    if (elements.baudSelect.value === "custom") {
      const rate = uartBaudToken(elements.uartInput.value);
      elements.baudCustomField.hidden = false;
      elements.baudCustomInput.value = Number.isInteger(rate) ? String(rate) : "";
      elements.baudCustomInput.setAttribute("aria-invalid", "false");
      elements.baudCustomInput.focus();
      return;
    }
    const rate = Number(elements.baudSelect.value);
    if (!supportedBaud(rate)) {
      return;
    }
    elements.baudCustomField.hidden = true;
    setUartBaud(rate);
  });
  elements.baudCustomInput.addEventListener("input", () => {
    const raw = String(elements.baudCustomInput.value || "").trim();
    const rate = Number(raw);
    const valid = supportedBaud(rate);
    elements.baudCustomInput.setAttribute(
      "aria-invalid",
      raw && !valid ? "true" : "false",
    );
    if (valid) {
      setUartBaud(rate);
    }
  });
  elements.uartInput.addEventListener("change", () => {
    saveSetting("linkr-uart", elements.uartInput.value.trim());
    updateBaudLabel();
    syncBaudControls();
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

function accessoryCapability() {
  if (state.mode !== "ble" || !state.mgmtReady) {
    return {
      available: false,
      reason: "Accessory settings need a Bluetooth LE connection; LAN mode carries the terminal data path only.",
    };
  }
  return {
    available: true,
    wifi: hasManagementCapability(MGMT_CAP_WIFI),
    webdav: hasManagementCapability(MGMT_CAP_WEBDAV),
    asyncEvents: hasManagementCapability(MGMT_CAP_ASYNC_EVENTS),
  };
}

function accessoryCommand(action, args = {}) {
  switch (action) {
    case "set-uart": return setUartCommand(args);
    case "set-wifi": return wifiCommand(args);
    case "set-webdav": return webdavCommand(args);
    default: throw new Error(`Unknown accessory action: ${action}`);
  }
}

/* Read one status command until it reports a terminal state or the deadline
 * passes, so a "queued" acknowledgement is never mistaken for the result. */
async function pollAccessoryStatus(command, parse, isSettled, { signal, timeoutMs = 20000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  for (;;) {
    signal?.throwIfAborted();
    value = parse(await sendControl(command, { returnResponse: true }));
    if (value && isSettled(value)) return { value, settled: true };
    if (Date.now() >= deadline) return { value, settled: false };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function executeAccessoryChange({ action, args = {}, command, signal }) {
  signal?.throwIfAborted();
  const reply = String((await sendControl(command, { returnResponse: true })) ?? "");
  const status = replyStatus(reply);
  const evidence = { command: redactCommand(command), reply: redactSecrets(reply), accepted: status.ok };
  if (!status.ok) {
    return { ...evidence, error: status.error || "The accessory did not accept the command." };
  }
  if (action === "set-uart") {
    const wanted = setUartCommand(args);
    const queried = await pollAccessoryStatus(
      UART_QUERY_COMMAND, parseUartSettings,
      (value) => `@u=${value.baud},${value.dataBits},${value.parity},${value.stopBits},${value.flow}` === wanted,
      { signal, timeoutMs: 6000, intervalMs: 800 },
    );
    return { ...evidence, confirmed: queried.value, settled: queried.settled,
      applied: Boolean(queried.value) && `@u=${queried.value.baud},${queried.value.dataBits},${queried.value.parity},${queried.value.stopBits},${queried.value.flow}` === wanted };
  }
  if (action === "set-wifi") {
    const wantOff = String(args.action ?? "connect").toLowerCase() === "off";
    const queried = await pollAccessoryStatus(
      WIFI_QUERY_COMMAND, parseWifiStatus,
      (value) => (wantOff ? value.state === "off" : value.state === "connected"), { signal },
    );
    return { ...evidence, status: queried.value, settled: queried.settled,
      applied: Boolean(queried.value) && (wantOff ? queried.value.state === "off" : queried.value.state === "connected") };
  }
  const wantOff = String(args.action ?? "on").toLowerCase() === "off";
  const queried = await pollAccessoryStatus(WEBDAV_QUERY_COMMAND, parseWebdavStatus, () => true, { signal, timeoutMs: 6000 });
  return { ...evidence, status: queried.value, settled: queried.settled,
    applied: Boolean(queried.value) && (wantOff ? queried.value.state === "off" : queried.value.state === "on") };
}

function init() {
  loadPersisted();
  aboutPage = createAboutPage({ section: $("aboutPage"), getLang: () => lang });
  agentSettings = createAgentSettings({
    section: $("agentSettings"), tab: document.querySelector('[data-settings-target="ai"]'),
    getLang: () => lang, onChange: () => agentPanel?.settingsChanged(),
    bindingAction: (action) => agentPanel.targetBinding(action),
  });
  setSettingsPage(localStorage.getItem("linkr-settings-page") || "connection");
  initTerminal();
  applyTheme();
  applyLang();
  applySidebar();
  if (localStorage.getItem(TRANSPORT_KEY) === "ws") {
    setTransportMode("ws");
  }
  setConnected(false);
  bind();
  agentPanel = createAgentPanel({
    button: $("agentButton"), getLang: () => lang,
    settings: agentSettings,
    bindingControl: command => sendControl(command, {returnResponse:true}),
    /* The assistant configures Linkr Bee itself over the encrypted management
     * channel. Approval happens in the panel, which owns the tool row and the
     * user's click; these helpers own the protocol and read every setting back
     * so a tool result is evidence rather than an acknowledgement. */
    accessory: {
      capability: accessoryCapability,
      command: accessoryCommand,
      execute: executeAccessoryChange,
      diagnostics: collectAccessoryDiagnostics,
      scan: scanWifi,
    },
    openSettings: openAgentSettings,
    onClose: syncSidebarForViewport,
    workspace: $("terminalWorkspace"), terminal: elements.terminalCard,
    onLayout: scheduleFit,
    focusTerminal: () => state.term?.focus(),
    onOpen: async () => {
      // Entering Agent changes only the workspace on desktop. Keep the docked
      // settings panel and its saved visibility; touch layouts close the sheet.
      if (usesSettingsDrawer()) setMobileSidebarOpen(false, { restoreFocus: false });
      /* Leaving fullscreen is best effort: some WebViews reject the request (or the
       * call is no longer tied to a user gesture) and a refused exit must not stop
       * the assistant from opening. */
      if (document.fullscreenElement === elements.terminalCard) {
        await document.exitFullscreen().catch(() => {});
      }
      elements.terminalCard.classList.remove("terminal-fullscreen-fallback");
      document.body.classList.remove("terminal-fullscreen-fallback");
      updateFullscreenButton();
    },
    getStatus: () => ({ sessionId: state.writeGeneration, connected: state.connected,
      inputPending: serialInputPending, inputRevision: serialInputRevision,
      uartWriteError: state.uartWriteError,
      transport: state.mode, device: elements.deviceName.textContent,
      deviceId: state.mode === "ws" ? state.wsHost : state.deviceId || state.device?.id,
      uart: elements.uartInput.value, receivedBytes: state.rxBytes, sentBytes: state.txBytes }),
    readLog: (options) => agentJournal.read(options),
    prepareInput: ({ text, appendEnter }) => normalizeEnter(text + (appendEnter ? "\r" : "")),
    sendInput: async (payload, generation, signal, inputRevision) => {
      const operation = enqueueBytes(encoder.encode(payload), false, { generation, signal, inputRevision });
      const queuedRevision = serialInputRevision;
      await operation;
      return { inputRevision: queuedRevision };
    },
  });
  initSoftKeyboardLayout();
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
