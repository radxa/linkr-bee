import { createBondUi } from "./bond_ui.js";
"use strict";

import { MGMT_CAP_MULTI_SESSION, parseSerialControl, agentLedAction, isReadonlyManagementCommand } from "./serial_control.js";
import { installSelectControls } from "./select_controls.js";
import { normalizeUartMode, uartTransportPlan } from "./uart_transport_mode.js";
import { createLanTokenStore } from "./lan_token_store.js";
import {
  BOARD_SWATCHES,
  IR_LEARN_STOP_COMMAND,
  IR_QUERY_COMMAND,
  IR_SLOTS_COMMAND,
  LED_OFF_COMMAND,
  LED_QUERY_COMMAND,
  OPTO_QUERY_COMMAND,
  boardReply,
  irDeleteCommand,
  irLearnCommand,
  irNameQueryCommand,
  irNameSetCommand,
  irPlayCommand,
  irSendCommand,
  isBoardReplyLine,
  isUnsupportedReply,
  ledHex,
  ledCommand,
  optoCommand,
  parseIrName,
  parseIrSlots,
  parseIrStatus,
  parseLearnStarted,
  parseLedStatus,
  parseOptoStatus,
  rgbFromHex,
  sanitizeSlotName,
} from "./board_io.js";
import {
  PROMPT_CLEAR_COMMAND,
  PROMPT_QUERY_COMMAND,
  assemblePrompt,
  parsePromptChunk,
  parsePromptStatus,
  promptGetCommand,
  promptSetCommand,
} from "./prompt_store.js";
import { demoModeRequested, installDemoMode } from "./demo_mode.js";
import {
  BLE_NAME_QUERY_COMMAND,
  DIAGNOSTICS_COMMAND,
  LAN_BRIDGE_QUERY_COMMAND,
  UART_QUERY_COMMAND,
  WIFI_QUERY_COMMAND,
  WEBDAV_QUERY_COMMAND,
  bleNameCommand,
  lanBridgeCommand,
  parseBleName,
  parseLanBridge,
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
import { createTerminalKeyPreferences } from "./terminal_key_preferences.js";
import { ByteHistory, createSerialPresentation } from "./serial_presentation.js";
import { SerialJournal } from "./serial_journal.js";
import { createAgentPanel } from "./agent_panel.js";
import { createAgentSettings } from "./agent_settings.js";
import { createMcpHost } from "./mcp_server.js";
import { createResidentAgent } from "./resident_agent.js";
import { createMcpUi } from "./mcp_ui.js";
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
let mcpHost = null;
let mcpUi = null;
let residentAgent = null;
let terminalKeyPreferences = null;
let aboutPage = null;
let serialControlTimer = null;
let agentLedActive = false;
let serialControlPolling = false;
let serialControlPending = false;
let serialControlWaiter = null;
let idleClaimInFlight = null;
let serialInputRevision = 0;
let serialInputPending = false;
let bleNotificationSession = null;
let bleUartNotificationSession = null;

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
/* Bit 6 was "prefer NUS" for the historical ESP32-CAM board, which is no
 * longer produced: firmware never defines or sets it (src/ble_mgmt.h,
 * src/ble_mgmt.c) and docs/LINKR_BLE_API.zh-CN.md does not document it. The
 * client follows the documented capability map, so the bit is a reserved,
 * always-zero bit here rather than a branch that can never run. */
const BLE_MAX_ATT_VALUE = 244;
/* Start every connection at the universally available ATT payload. Probing a
 * larger size first only works if the platform reports the rejection in a
 * shape we recognise; a client that writes input immediately after connect can
 * otherwise mistake that first oversized write for an ambiguous delivery and
 * latch the terminal until it reconnects. 20 bytes is always valid on top of
 * the default 23-byte ATT MTU, and the reliable framing handles the rest. */
const RELIABLE_UART_WRITE_START = 20;
const APP_BUILD = "Novice-PG";
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
/* xterm 6 derives its custom scrollbar width from overviewRuler.width in
 * JavaScript (default 14 px), so a CSS-only override would desynchronise the
 * slider. A phone loses too much of the output to the default track; use a
 * narrower one there and keep the desktop track at the 10 px the native
 * viewport scrollbar used to show. */
const terminalScrollbarWidth = coarsePointerMedia.matches ? 8 : 10;

/* Native shells shrink their own WebView when the soft keyboard opens. Keep
 * that local: a resize caused by the keyboard is a display change, not a
 * request to reflow the remote shell. Browsers still synchronize the remote
 * tty with stty, because their viewport is the actual terminal window. */
function handlesTerminalGeometryLocally() {
  const platform =
    window.LinkrNativeBle?.platform ||
    globalThis.Capacitor?.getPlatform?.();
  return platform === "android" || platform === "ios" || isHarmonyHost;
}

/* The two draggable dots exist because a WebView long press cannot reach the
 * terminal's own selection. A browser already draws its native handles and
 * copy menu, so drawing a second set there is both confusing and, after the
 * native gesture collapses the DOM selection, unsafe: the two systems selected
 * different text. Keep the custom UI for the native shells only. */
const nativeSelectionShell = handlesTerminalGeometryLocally();

document.documentElement.classList.toggle(
  "settings-drawer-layout",
  prefersSettingsDrawer,
);
document.documentElement.classList.toggle(
  "browser-terminal-selection",
  !nativeSelectionShell,
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let rxDecoder = new TextDecoder();

const state = {
  device: null,
  nusReady: false,
  mgmtReady: false,
  serialControl: null,
  serialControlRevision: 0,
  reliableReady: false,
  uartMode: "interactive",
  uartSessionMode: null,
  uartReliableAvailable: null,
  uartFallback: false,
  legacy: false,
  reliableTxSequence: 1,
  reliableRxSequence: 1,
  reliableRxDesync: false,
  reliableMaxPayload: 20,
  reliableWriteSize: RELIABLE_UART_WRITE_START,
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
  logView: "reading",
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
  bleReselectId: null,
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
  /* Linkr Bee X1.0 board I/O: RGB LED, optocoupler contact, IR remote and its
   * learned-slot table. `supported` stays null until the first reply says
   * whether this firmware exposes the @l/@o/@r group at all. */
  features: {
    bonds: null,
    led: null,
    opto: null,
    ir: null,
    irLearn: null,
    irName: null,
    prompt: null,
    wifi: null,
    webdav: null,
    bleName: null,
  },
  board: {
    canControl: false,
    slots: 8,
    slotEdges: [],
    learning: false,
    polling: false,
    pollTimer: null,
    learnDeadline: 0,
    lastIr: null,
    lastLed: null,
    lastOptoClosed: null,
    lastSlots: null,
    /* Slot names live in the board's NVS; this is the last copy read from it.
     * `namesSupported` stays null until the firmware proves it has @r name. */
    slotNames: {},
    namesSupported: null,
    editingSlot: null,
  },
  boardPromptBytes: 0,
  diagnostics: {},
  terminalGeometry: null,
  terminalGeometrySynced: "",
  terminalGeometrySyncInFlight: "",
  terminalGeometrySyncTimer: null,
  terminalGeometrySession: 0,
  /* A new link has not been told a size yet, so its first idle prompt syncs
   * immediately instead of waiting for the resize debounce. */
  terminalGeometryUrgent: false,
  /* A full-screen program owns the tty: the pane can change but the target
   * cannot be told until it exits, which the status bar explains. */
  alternateScreen: false,
  shellPromptVisible: false,
};

const LOG_CAP_BYTES = 4 * 1024 * 1024;
const rawLog = new ByteHistory(LOG_CAP_BYTES);
const readingLog = new ByteHistory(LOG_CAP_BYTES);
const rawDisplay = new ByteHistory(LOG_CAP_BYTES);
const readingDisplay = new ByteHistory(LOG_CAP_BYTES);
let terminalReplay = false, replayRevision = 0, replayTail = [], replayTailBytes = 0;
const serialPresentation = createSerialPresentation({onIdle: appendDeferredReading});

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
  compactDevice: $("compactDevice"),
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
  logViewSelect: $("logViewSelect"),
  saveReadingLog: $("saveReadingLog"),
  saveRawLog: $("saveRawLog"),
  shellIntegrationEnable: $("shellIntegrationEnable"),
  shellIntegrationDisable: $("shellIntegrationDisable"),
  shellIntegrationStatus: $("shellIntegrationStatus"),
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
  enterSelect: $("enterSelect"),
  chunkInput: $("chunkInput"),
  uartModeField: $("uartModeField"),
  uartModeSelect: $("uartModeSelect"),
  uartModeHint: $("uartModeHint"),
  uartTransportStatus: $("uartTransportStatus"),
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
  boardIoBanner: $("boardIoBanner"),
  bleNameCard: $("bleNameCard"),
  wifiWebdavCard: $("wifiWebdavCard"),
  wifiWebdavTitle: $("wifiWebdavTitle"),
  wifiBlock: $("wifiBlock"),
  webdavBlock: $("webdavBlock"),
  boardLedCard: $("boardLedCard"),
  boardOptoCard: $("boardOptoCard"),
  boardIrCard: $("boardIrCard"),
  boardPromptCard: $("boardPromptCard"),
  boardLearnBlock: $("boardLearnBlock"),
  boardSavedBlock: $("boardSavedBlock"),
  boardIoHint: $("boardIoHint"),
  boardLedSwatches: $("boardLedSwatches"),
  boardLedColor: $("boardLedColor"),
  boardLedApply: $("boardLedApply"),
  boardLedOff: $("boardLedOff"),
  boardLedQuery: $("boardLedQuery"),
  boardLedStatus: $("boardLedStatus"),
  boardOptoClose: $("boardOptoClose"),
  boardOptoOpen: $("boardOptoOpen"),
  boardOptoQuery: $("boardOptoQuery"),
  boardOptoPulse: $("boardOptoPulse"),
  boardOptoPulseMs: $("boardOptoPulseMs"),
  boardOptoStatus: $("boardOptoStatus"),
  boardIrAddress: $("boardIrAddress"),
  boardIrCommand: $("boardIrCommand"),
  boardIrRepeats: $("boardIrRepeats"),
  boardIrSend: $("boardIrSend"),
  boardIrQuery: $("boardIrQuery"),
  boardIrStatus: $("boardIrStatus"),
  boardLearnSlot: $("boardLearnSlot"),
  boardLearnStart: $("boardLearnStart"),
  boardLearnStop: $("boardLearnStop"),
  boardLearnStatus: $("boardLearnStatus"),
  boardSlotList: $("boardSlotList"),
  boardPromptClear: $("boardPromptClear"),
  boardPromptLoad: $("boardPromptLoad"),
  boardPromptText: $("boardPromptText"),
  boardPromptSave: $("boardPromptSave"),

  boardPromptStatus: $("boardPromptStatus"),
  boardPromptCount: $("boardPromptCount"),
  boardSlotEmptyHint: $("boardSlotEmptyHint"),
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
  ttySizeLabel: $("ttySizeLabel"),
  ttySizeItem: $("ttySizeItem"),
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
const UART_MODE_KEY = "linkr-uart-mode";
const WS_HOST_KEY = "linkr-ws-host";
const lanTokens = createLanTokenStore(localStorage);
/* LAN access handshake. The bridge announces whether a token is required, so
 * the client never has to guess; UART data always arrives as binary frames, so
 * these text frames are unambiguous. See src/ws_bridge.c. */
const WS_AUTH_NONE_FRAME = "@ws auth=none";
const WS_AUTH_REQUIRED_FRAME = "@ws auth=required";
const WS_AUTH_OK_FRAME = "@ws auth=ok";
const WS_HANDSHAKE_TIMEOUT_MS = 5000;
/* Automatic reconnect after an unexpected link loss. Bounded on purpose: a
 * board that was switched off should not be redialled forever, and a user can
 * always press Reconnect again. Tests shorten or disable the schedule through
 * globalThis.__linkrReconnectDelays instead of faking the clock. */
const AUTO_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function reconnectDelays() {
  const override = globalThis.__linkrReconnectDelays;
  return Array.isArray(override) ? override : AUTO_RECONNECT_DELAYS_MS;
}

const SYSTEM_TERMINAL_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", ' +
  '"Linkr Legacy Computing", monospace';
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
    serialReadonly: "Read only", serialControlled: "In control", serialAvailable: "No controller",
    serialReadonlyHint: "Typing takes over automatically when the other session is idle; Take control preempts it immediately.",
    claimControl: "Take control", releaseControl: "Release",
    serialReadonlyError: "Read-only session. Take control before sending input.",
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
    reconnectLost: "Link lost; reconnecting automatically",
    reconnectDialing: "Reconnecting… attempt {n}/{total}",
    reconnectWaiting: "Reconnecting in {s}s (attempt {n}/{total})",
    reconnectRestored: "Link restored automatically",
    reconnectGaveUp: "Automatic reconnect failed after {total} attempts. Press Reconnect to try again.",
    reconnectPausedForPairing: "Automatic reconnect stopped: pairing needs a fresh key press, then press Connect.",
    reconnectCancelled: "Automatic reconnect cancelled",
    reconnectCancel: "Cancel reconnect",
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
    reselectDevice: "Reselect device",
    bleReselectHint: "Browser cannot rediscover this Bee. Keep it powered on, then click Reselect device and choose the same Bee. Existing pairing is kept.",
    bleReselectMismatch: "That is a different Bee. Select the previous device, or use Switch device to change devices.",
    reconnect: "Reconnect",
    switchDevice: "Switch device",
    queryUart: "Query UART",
    clear: "Clear",
    saveLog: "Save current view",
    logViewTitle: "Log view", logViewReading: "Reading", logViewRaw: "Raw",
    logViewHint: "Reading hides internal Agent probe/setup echoes and simplifies tracked commands. Device output stays visible. Switching sends no input; Raw and board WebDAV retain original UART bytes.",
    saveReadingLog: "Export reading log", saveRawLog: "Export raw log",
    shellIntegrationTitle: "Session Shell integration",
    shellIntegrationHint: "Optional for an idle POSIX shell. Defines a temporary function without sudo or files; commands still run in sh subprocesses. Re-enable after reconnecting or starting a new chat. Disabling only changes future tracking.",
    shellIntegrationEnable: "Enable for this Shell", shellIntegrationDisable: "Use normal tracking",
    shellIntegrationDisabled: "Normal tracking · connect to an idle Shell to enable OSC boundaries.",
    shellIntegrationReady: "Enabled · command boundaries and exit codes use OSC.",
    shellIntegrationPending: "An execution is unresolved. Inspect the target, then start a new chat before enabling again.",
    shellIntegrationEnabling: "Waiting for the Shell handshake…", shellIntegrationFailed: "Handshake unconfirmed. No command was retried; inspect the terminal before trying again.",
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
    uartMode: "BLE UART mode",
    uartModeInteractive: "Interaction first",
    uartModeReliable: "Reliability first",
    uartModeInteractiveHint: "Favors quick input and log streaming, without UART frame delivery confirmation.",
    uartModeReliableHint: "Confirms each fragment at the Bee; throughput may be lower. This does not confirm execution on the target.",
    uartModeNext: "Saved for the next BLE connection.",
    uartActiveNus: "Current: interaction channel · NUS",
    uartActiveReliable: "Current: reliable channel · Reliable UART",
    uartNusOnly: "This device supports only the interaction channel.",
    uartModeFallback: "Preferred channel unavailable; using the compatible channel.",
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
    settingsBoard: "Board",
    boardLed: "Status LED",
    boardLedAria: "Status LED",
    boardLedColors: "Status LED colours",
    boardLedHint: "With automatic-status firmware: blue for Bluetooth, white for WiFi, cyan for AI. UART traffic blinks. Manual colours preview for 5 seconds; AI takes priority.",
    boardLedCustom: "Custom colour",
    boardApply: "Apply",
    refresh: "Refresh",
    boardIoHint: "Available on the Linkr Bee X1.0. Commands use the encrypted management channel, not the target UART.",
    boardUnsupported: "This firmware does not expose the RGB LED, optocoupler or IR controls.",
    boardColorOff: "Off",
    boardColorRed: "Red",
    boardColorGreen: "Green",
    boardColorBlue: "Blue",
    boardColorWhite: "White",
    boardColorAmber: "Amber",
    boardColorCyan: "Cyan",
    boardColorViolet: "Violet",
    boardOpto: "Isolated contact (J5)",
    boardOptoAria: "Optocoupler contact",
    boardOptoClose: "Close",
    boardOptoOpen: "Open",
    boardOptoPulse: "Pulse",
    boardOptoPulseMs: "Pulse length (ms)",
    boardOptoClosed: "Contact closed",
    boardOptoOpenState: "Contact open",
    boardIr: "Infrared remote & learning",
    boardIrLearnHint: "Send a NEC frame, or learn any remote's signal and keep it on the board.",
    boardIrSendTitle: "Send NEC frame",
    boardLearn: "Learn a signal",
    boardSavedSignals: "Saved signals",
    boardSavedHint: "The signal and its name are both kept in the board's NVS, so they survive reboots. Play sends one directly.",
    boardSlotsEmpty: "No signals learned yet — press Learn, then a remote key.",
    boardPrompt: "On-board AI prompt",
    boardPromptAria: "On-board AI prompt",
    boardPromptHint: "Stored in the board's NVS; the assistant reads it when a conversation starts.",
    boardPromptText: "Custom instructions",
    boardPromptPlaceholder: "For example: give the conclusion first and explain commands in Chinese.",
    boardPromptLoad: "Load",
    boardPromptSave: "Save to board",
    boardPromptClear: "Clear",
    boardPromptStored: "Stored",
    boardPromptEmpty: "Empty",
    boardPromptBytes: "bytes",
    boardPromptSaved: "Saved",
    collapseCard: "Collapse card",
    expandCard: "Expand card",
    boardSlotRename: "Rename",
    boardSlotNamePlaceholder: "Name this signal",
    boardSlotNameSave: "Save",
    boardSlotNameCancel: "Cancel",
    boardIrAria: "Infrared remote",
    boardIrAddress: "Address",
    boardIrCommand: "Command",
    boardIrRepeats: "Repeats",
    boardIrSend: "Send NEC",
    boardIrReceiver: "Receiver status",
    boardIrNone: "No frame received yet",
    boardIrLast: "Last frame",
    boardIrCounters: "frames / repeats / glitches",
    boardIrBusy: "IR transmitter busy; try again",
    boardLearnHint: "Point a remote at the receiver and press a key; the frame is saved about 60 ms after the key is released.",
    boardLearnSlot: "Slot",
    boardLearnStart: "Learn",
    boardLearnStop: "Stop & save",
    boardLearnPlay: "Play",
    boardLearnDelete: "Delete",
    boardLearnActive: "Learning — press a remote key",
    boardLearnIdle: "Not learning",
    boardLearnSaved: "Saved to slot",
    boardLearnEmpty: "Slot is empty",
    boardLearnFailed: "Capture failed or timed out",
    boardSlotUsed: "used",
    boardSlotEmpty: "empty",
    boardCmdError: "Board command failed",
    serialOutput: "Serial Terminal",
    terminalAria: "Interactive serial terminal",
    xterm: "xterm.js",
    terminalInputHint: "Modifiers apply once · Scroll for more keys",
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
    tty: "TTY",
    ttySynced: "Target tty matches this pane",
    ttyPending: "Pane resized; the target tty is told at the next idle shell prompt",
    ttyFullscreen: "A full-screen program owns the tty; it is resized after you exit",
    ttyUnsynced: "Not yet synced; the target is told at its next idle shell prompt",
    ttyDisconnected: "Not connected",
    welcome: "Linkr Bee Terminal ready. Press Connect to open a device.",
    connecting: "Connecting…",
    pairingHint: "New host: press the Bee pairing key once (Linkr Bee X1.0: USER_KEY/GPIO3; C3/C5: GPIO1), then connect within 30 s. Bonded hosts reconnect without a key press.",
    pairingFailed: "Pairing was refused. Press the pairing key again, then choose Connect to start a new pairing; the terminal does not reconnect on its own.",
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
    serialReadonly: "只读", serialControlled: "控制中", serialAvailable: "无人控制",
    claimControl: "申请控制", releaseControl: "释放",
    serialReadonlyHint: "对方空闲时，输入会自动接管控制权；点「申请控制」可立即抢占。",
    serialReadonlyError: "对方正在输入，未自动接管；点「申请控制」可强制接管。",
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
    reconnectLost: "连接已断开，正在自动重连",
    reconnectDialing: "正在重连…第 {n}/{total} 次",
    reconnectWaiting: "{s} 秒后重连（第 {n}/{total} 次）",
    reconnectRestored: "连接已自动恢复",
    reconnectGaveUp: "自动重连 {total} 次失败，请点「重新连接」再试。",
    reconnectPausedForPairing: "已停止自动重连：配对需要重新按键，之后再点「连接」。",
    reconnectCancelled: "已取消自动重连",
    reconnectCancel: "取消重连",
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
    reselectDevice: "重新选择设备",
    bleReselectHint: "浏览器暂时无法重新发现这台 Bee。请保持供电，点击「重新选择设备」并选择原来的 Bee；无需删除配对记录。",
    bleReselectMismatch: "选择的不是原来的 Bee。请选择原设备；如需更换，请使用「切换设备」。",
    reconnect: "重新连接",
    switchDevice: "切换设备",
    queryUart: "查询 UART",
    clear: "清屏",
    saveLog: "保存当前视图",
    logViewTitle: "日志视图", logViewReading: "阅读", logViewRaw: "原始",
    logViewHint: "阅读视图隐藏 Agent 内部探测与初始化脚本回显，简化任务命令，保留设备输出。切换不发送串口输入；原始视图和板端 WebDAV 保留 UART 原始字节。",
    saveReadingLog: "导出阅读日志", saveRawLog: "导出原始日志",
    shellIntegrationTitle: "本次 Shell 集成",
    shellIntegrationHint: "可选，需要空闲的 POSIX Shell。只定义临时函数，无需 sudo、不写文件；命令仍在 sh 子进程执行。重连或新建对话后需重新启用。停用仅切换后续跟踪方式。",
    shellIntegrationEnable: "启用当前 Shell", shellIntegrationDisable: "切回普通跟踪",
    shellIntegrationDisabled: "普通跟踪 · 连接空闲 Shell 后可启用 OSC 边界。",
    shellIntegrationReady: "已启用 · 通过 OSC 接收命令边界和退出码。",
    shellIntegrationPending: "有未结束的执行记录，请检查目标机状态并新建对话后再启用。",
    shellIntegrationEnabling: "正在等待 Shell 握手…", shellIntegrationFailed: "握手未确认，未重发任何命令；请检查终端后再操作。",
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
    uartMode: "BLE 串口模式",
    uartModeInteractive: "交互优先",
    uartModeReliable: "可靠优先",
    uartModeInteractiveHint: "优先响应速度，适合终端输入和日志查看；不提供 UART 帧级交付确认。",
    uartModeReliableHint: "逐片确认 Bee 收包，吞吐可能降低；不代表目标机已执行。",
    uartModeNext: "已保存，下次 BLE 连接生效。",
    uartActiveNus: "当前：交互通道 · NUS",
    uartActiveReliable: "当前：可靠通道 · Reliable UART",
    uartNusOnly: "此设备仅支持交互通道。",
    uartModeFallback: "首选通道不可用，已使用兼容通道。",
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
    settingsBoard: "板载",
    boardLed: "状态灯",
    boardLedAria: "状态灯",
    boardLedColors: "状态灯颜色",
    boardLedHint: "支持自动状态的新固件：蓝牙为蓝色，WiFi 为白色，AI 为蓝绿色。串口有数据时闪烁。手动颜色预览 5 秒，AI 状态优先。",
    boardLedCustom: "自定义颜色",
    boardApply: "应用",
    refresh: "刷新",
    boardIoHint: "仅 Linkr Bee X1.0 支持。命令走加密的管理通道，不会写进目标串口。",
    boardUnsupported: "当前固件没有 RGB 灯、光耦或红外控制。",
    boardColorOff: "关闭",
    boardColorRed: "红",
    boardColorGreen: "绿",
    boardColorBlue: "蓝",
    boardColorWhite: "白",
    boardColorAmber: "琥珀",
    boardColorCyan: "青",
    boardColorViolet: "紫",
    boardOpto: "隔离干接点（J5）",
    boardOptoAria: "光耦干接点",
    boardOptoClose: "闭合",
    boardOptoOpen: "断开",
    boardOptoPulse: "脉冲",
    boardOptoPulseMs: "脉冲时长（毫秒）",
    boardOptoClosed: "触点已闭合",
    boardOptoOpenState: "触点已断开",
    boardIr: "红外遥控与学习",
    boardIrLearnHint: "可以发送 NEC 帧，也可以学习任意遥控器的信号并保存在板子上。",
    boardIrSendTitle: "发送 NEC 帧",
    boardLearn: "学习信号",
    boardSavedSignals: "已保存的信号",
    boardSavedHint: "信号和名字都保存在板子的 NVS 里，掉电不丢；点「回放」即可直接发送。",
    boardSlotsEmpty: "还没有学习的信号——点「学习」，再按一下遥控器。",
    boardPrompt: "板载 AI 提示词",
    boardPromptAria: "板载 AI 提示词",
    boardPromptHint: "存在板子 NVS，新对话开始时读取。",
    boardPromptText: "自定义指令",
    boardPromptPlaceholder: "例如：先给结论，再用中文解释命令。",
    boardPromptLoad: "读取",
    boardPromptSave: "保存到板子",
    boardPromptClear: "清除",
    boardPromptStored: "已存储",
    boardPromptEmpty: "空",
    boardPromptBytes: "字节",
    boardPromptSaved: "已保存",
    collapseCard: "折叠卡片",
    expandCard: "展开卡片",
    boardSlotRename: "改名",
    boardSlotNamePlaceholder: "给这个信号起个名字",
    boardSlotNameSave: "保存",
    boardSlotNameCancel: "取消",
    boardIrAria: "红外遥控",
    boardIrAddress: "地址",
    boardIrCommand: "命令",
    boardIrRepeats: "重复帧",
    boardIrSend: "发送 NEC",
    boardIrReceiver: "接收状态",
    boardIrNone: "还没有收到红外帧",
    boardIrLast: "最近一帧",
    boardIrCounters: "帧 / 重复 / 错误",
    boardIrBusy: "红外发送忙，请稍后重试",
    boardLearnHint: "把遥控器对准接收头按一下；松手约 60 ms 后自动保存。",
    boardLearnSlot: "槽位",
    boardLearnStart: "学习",
    boardLearnStop: "停止并保存",
    boardLearnPlay: "回放",
    boardLearnDelete: "删除",
    boardLearnActive: "学习中——请按遥控器按键",
    boardLearnIdle: "未在学习",
    boardLearnSaved: "已保存到槽位",
    boardLearnEmpty: "槽位为空",
    boardLearnFailed: "没有抓到完整帧或已超时",
    boardSlotUsed: "已用",
    boardSlotEmpty: "空",
    boardCmdError: "板载命令失败",
    serialOutput: "串口终端",
    terminalAria: "交互式串口终端",
    xterm: "xterm.js",
    terminalInputHint: "组合键单次生效 · 滚动查看更多按键",
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
    tty: "TTY",
    ttySynced: "目标 tty 与当前面板一致",
    ttyPending: "面板已改变，目标 tty 将在下一个空闲提示符处同步",
    ttyFullscreen: "全屏程序占用 tty，退出后才会同步尺寸",
    ttyUnsynced: "尚未同步；目标会在下一个空闲 shell 提示符处收到尺寸",
    ttyDisconnected: "未连接",
    welcome: "Linkr Bee 终端已就绪，点击「连接」打开设备。",
    connecting: "连接中…",
    pairingHint: "首次连接新主机：先按一下 Bee 的配对键（Linkr Bee X1.0：USER_KEY/GPIO3；C3/C5：GPIO1），并在 30 秒内发起连接。已绑定主机无需按键。",
    pairingFailed: "配对被拒绝。请再次按下配对键，再点「连接」重新发起配对；终端不会自动重连。",
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
    elements.fontPreview.textContent = next === "system"
      ? "user@bee:~ $ echo ready" : "\ue0a0 main \ue0b0 \uf07c ~/project";
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
  cancelAutoReconnect(t("reconnectCancelled"), { silent: true });
  state.mode = mode;
  if (mode === "ws") elements.wsTokenInput.value = lanTokens.selectHost(elements.wsHostInput.value);
  saveSetting(TRANSPORT_KEY, mode);
  syncTransportControls();
  clearWsErrors();
  setConnected(false);
  setSupportText();
}

function connectionActionKey() {
  if (state.mode === "ble" && state.bleReselectId) return "reselectDevice";
  return state.mode === "ble" && state.device ? "reconnect" : "connect";
}

function refreshConnectionActions() {
  elements.connectButton.querySelector(".btn-label").textContent = t(connectionInFlight ? "connecting" : connectionActionKey());
  elements.switchDeviceButton.hidden = state.mode !== "ble";
  elements.switchDeviceButton.disabled = connectionInFlight || state.connected;
}

function refreshDynamicTexts() {
  if (autoReconnect.active) {
    renderAutoReconnectStatus();
    return;
  }
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
  renderTerminalGeometryStatus();
  renderDiagnostics();
  refreshCardToggleLabels();
  refreshBoardLabels();
  renderBleNameStatus();
  updateWifiConnectionView();
  updateFullscreenButton();
  updateModifierButtons();
  agentPanel?.refreshLang();
  agentSettings?.refreshLang();
  mcpUi?.refreshLang();
  terminalKeyPreferences?.refreshLang();
  aboutPage?.refreshLang();
  renderUartMode();
  renderShellIntegration();
  renderSerialControl();
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
  /* A new link has never been told a size. The first idle prompt is the one
   * moment the target can still be resized before the person types `htop`, so
   * that sync skips the debounce a later resize needs. */
  state.terminalGeometryUrgent = true;
  state.alternateScreen = false;
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
  if (terminalReplay || !canSerialInput()) return;
  if (handlesTerminalGeometryLocally()) {
    return;
  }
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

  /* A fresh link skips the debounce: the first idle prompt is the last moment
   * the target can be resized before a full-screen program starts. Later
   * resizes wait 180 ms so a drag or a panel animation sends one size. The
   * flag clears only once a size actually went out, so a cancelled timer or a
   * prompt that vanished does not push the first sync back. */
  const delay = state.terminalGeometryUrgent ? 0 : 180;
  state.terminalGeometrySyncTimer = setTimeout(() => {
    state.terminalGeometrySyncTimer = null;
    if (
      terminalReplay ||
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
    writeText(terminalGeometryCommand(geometry.cols, geometry.rows), { claim: false })
      .then(() => {
        if (session === state.terminalGeometrySession) {
          state.terminalGeometrySynced = geometry.key;
          state.terminalGeometryUrgent = false;
          renderTerminalGeometryStatus();
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
  }, delay);
}

function onTerminalResize({ cols, rows }) {
  state.terminalGeometry = normalizeTerminalGeometry(cols, rows);
  renderTerminalGeometryStatus();
  scheduleTerminalGeometrySync();
}

/* What the target's tty believes its size is, next to the pane's own size when
 * the two differ. A full-screen program is the one case where the gap cannot be
 * closed from here: the client may only write `stty` at an idle shell prompt,
 * and the pane says so rather than claiming a size the target never took. */
function renderTerminalGeometryStatus() {
  const label = elements.ttySizeLabel;
  if (!label) return;
  const item = label.closest(".sb-tty");
  /* Native shells keep their own tty size on purpose (a soft-keyboard resize is
   * local display state), so there is no target size for this to report. */
  if (handlesTerminalGeometryLocally()) {
    if (item) item.hidden = true;
    return;
  }
  if (item) item.hidden = false;
  const synced = state.terminalGeometrySynced;
  const pane = state.terminalGeometry?.key || "";
  const pending = Boolean(state.connected && pane && synced && pane !== synced);
  /* Only a size the target acknowledged is reported as its size. Showing the
   * pane's own size before the first sync would be the same false claim the
   * `stty` gate exists to avoid. */
  label.textContent = synced ? synced.replace("x", "×") : "—";

  let hint = "";
  if (!state.connected) hint = t("ttyDisconnected");
  else if (state.alternateScreen && pending) hint = t("ttyFullscreen");
  else if (pending) hint = t("ttyPending");
  else if (synced) hint = t("ttySynced");
  else hint = t("ttyUnsynced");
  if (item) {
    item.classList.toggle("sb-pending", pending && !state.alternateScreen);
    item.classList.toggle("sb-fullscreen", state.alternateScreen && pending);
    item.title = hint;
    item.setAttribute("aria-label", hint ? `${t("tty")} ${label.textContent} · ${hint}` : `${t("tty")} ${label.textContent}`);
  }
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
  if (terminalReplay) return;
  const alternate = state.term?.buffer?.active?.type === "alternate";
  if (alternate !== state.alternateScreen) {
    state.alternateScreen = alternate;
    if (!alternate) {
      /* Leaving a full-screen program is the first chance to move the tty to
       * the size the pane grew to while it owned the screen. */
      state.terminalGeometryUrgent = true;
    }
    renderTerminalGeometryStatus();
  }
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
    // The width has to reach xterm's own layout, not just CSS; see above.
    overviewRuler: { width: terminalScrollbarWidth },
    tabStopWidth: 8,
    theme: theme === "dark" ? XTERM_DARK : XTERM_LIGHT,
  });
  state.fitAddon = new globalThis.FitAddon.FitAddon();
  state.term.loadAddon(state.fitAddon);
  state.term.open(elements.terminalOutput);
  // Legacy-computing glyphs only trigger the fallback font on demand. Load it
  // explicitly, then redraw so existing scrollback switches from .notdef to
  // the real shapes as soon as it arrives.
  if (document.fonts && document.fonts.load) {
    document.fonts
      .load(`${state.fontSize}px "Linkr Legacy Computing"`, "\u{1cc1a}\u{1fb00}")
      .then(() => refreshTerminalFont(state.fontFamily))
      .catch(() => {});
  }
  subscribeTerminalInput(state.term, onTerminalData);
  state.term.onResize(onTerminalResize);
  state.term.onScroll(() => {
    onTerminalScroll();
    positionTerminalSelectionHandles();
  });
  state.term.onSelectionChange(() => {
    if (state.term?.hasSelection()) {
      positionTerminalSelectionHandles();
      return;
    }
    // A long press can make the WebView collapse its own DOM selection, which
    // in turn clears the xterm selection we just made. Reapply it while the
    // gesture is fresh so the highlight and Copy keep working; user input and
    // a new touch clear the stored endpoints first, so those never reassert.
    if (
      !terminalSelection.reasserting &&
      terminalSelection.start &&
      terminalSelection.end &&
      performance.now() - terminalSelection.stamp < 1500
    ) {
      const { start, end } = terminalSelection;
      terminalSelection.reasserting = true;
      setTerminalSelection(start, end);
      terminalSelection.reasserting = false;
      return;
    }
    hideTerminalSelectionHandles();
  });
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

// xterm already schedules rendering. During typing, hand it small echoes
// immediately instead of making them wait for two successive animation frames.
// Bound this shortcut to once per frame so sustained output still batches.
let terminalInputUntil = 0;
let lastImmediateWriteAt = -Infinity;
let writeRaf = 0;
let writeFallbackTimer = 0;
let pendingWrites = [];
let pendingWriteBytes = 0;
let droppedWriteBytes = 0;

function flushTerminalWrites() {
  if (writeRaf) cancelAnimationFrame(writeRaf);
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

function appendDeferredReading(bytes) {
  readingLog.append(bytes); readingDisplay.append(bytes);
  if (state.logView === "reading") queueTerminalOutput(bytes);
}
function flushReadingPrefix() {
  const bytes = serialPresentation.flush();
  if (bytes.length) appendDeferredReading(bytes);
}
function appendOutput(data) {
  // UI/control messages are outside the UART stream. Finish a pending prefix
  // first so neither reading history nor replay can reorder it around the UI.
  flushReadingPrefix();
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  rawDisplay.append(bytes); readingDisplay.append(bytes);
  queueTerminalOutput(bytes);
}
function queueTerminalOutput(data) {
  if (!data.length) return;
  if (terminalReplay) {
    if (replayTailBytes + data.length > WRITE_BACKLOG_LIMIT) {
      // The bounded display history already has these bytes. Restart from a
      // fresh snapshot instead of retaining an unbounded second live queue.
      replayRevision++;
      replayTail = [];
      replayTailBytes = 0;
    } else {
      replayTail.push(data);
      replayTailBytes += data.length;
    }
    return;
  }
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
  const now = performance.now();
  if (!document.hidden && now < terminalInputUntil && bytes.length <= 256 &&
      pendingWriteBytes <= 4096 && now - lastImmediateWriteAt >= 16) {
    lastImmediateWriteAt = now;
    flushTerminalWrites();
    return;
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

/* Changing the WiFi state needs the board's asynchronous event channel (bit 4);
 * a board that advertises WiFi (bit 0) without it can still be queried. While
 * the answer is unknown — not connected yet, or the handshake is still running
 * — the controls stay visible, per AGENTS.md "keep the controls visible while a
 * board is not connected or the capability is still unknown". */
function wifiMutationAllowed() {
  if (!state.connected || state.mode === "ws" || !state.mgmtReady) return true;
  return hasManagementCapability(MGMT_CAP_WIFI) &&
    hasManagementCapability(MGMT_CAP_ASYNC_EVENTS);
}

function updateWifiConnectionView() {
  const wifi = state.wifiStatus;
  const connected = Boolean(wifi.connected);
  const wifiForm = document.querySelector(".wifi-form");
  /* Query-only board: no form and no mutating buttons at all, but the status
   * button and the connected-network summary stay. */
  const mutable = wifiMutationAllowed();

  if (elements.wifiConnectedSummary) {
    elements.wifiConnectedSummary.hidden = !connected;
  }
  if (wifiForm) {
    wifiForm.hidden = connected || !mutable;
  }
  elements.wifiScanButton.hidden = connected || !mutable;
  elements.wifiSetButton.hidden = connected || !mutable;
  elements.wifiOffButton.hidden = !mutable;

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

function canSerialInput() {
  return state.connected && (!state.serialControl || state.serialControl.mode === "control");
}

/* UART typing is allowed to try even in a read-only session: the first
 * keystroke asks the bridge for the idle console and becomes input once the
 * hand-over succeeds. Management controls stay strict (see canSerialInput). */
function canAttemptUserInput() {
  return Boolean(state.connected);
}

function assertSerialInput(revision = state.serialControlRevision) {
  if (!canSerialInput() || revision !== state.serialControlRevision) {
    throw new Error(t("serialReadonlyError"));
  }
}

function renderSerialControl() {
  bondUi?.render();
  const status = document.getElementById("serialControlStatus");
  const button = document.getElementById("serialControlButton");
  const control = state.connected ? state.serialControl : null;
  document.getElementById("serialControlGroup").hidden = !control;
  if (status) {
    status.hidden = !control;
    if (control) {
      const key = control.mode === "control" ? "serialControlled" :
        control.mode === "available" ? "serialAvailable" : "serialReadonly";
      status.textContent = `${t(key)} · ${control.peers}`;
      status.title = `#${control.self} / controller #${control.owner || "–"}`;
    }
  }
  if (button) {
    button.hidden = !control;
    button.disabled = serialControlPending;
    button.textContent = t(control?.mode === "control" ? "releaseControl" : "claimControl");
    button.title = button.textContent;
    button.setAttribute("aria-label", button.textContent);
  }
  const writable = canAttemptUserInput();
  if (state.term) {
    state.term.options.disableStdin = !writable;
    if (!writable) state.term.blur();
  }
  for (const element of [elements.breakButton, elements.controlKeyButton,
    elements.pasteTerminalButton, ...elements.modifierButtons, ...elements.terminalKeyButtons]) {
    if (element) element.disabled = !writable;
  }
  const management = canSerialInput() && state.mode === "ble" && state.mgmtReady;
  elements.setUartButton.disabled = !management;
  elements.wifiSetButton.disabled = !management || !hasManagementCapability(MGMT_CAP_ASYNC_EVENTS);
  elements.wifiOffButton.disabled = elements.wifiSetButton.disabled;
  elements.wifiScanButton.disabled = elements.wifiSetButton.disabled;
  /* Disabled is not the same as absent: a query-only board shows no WiFi form
   * or mutating buttons, only the status query. */
  updateWifiConnectionView();
  elements.webdavSetButton.disabled = !management || !hasManagementCapability(MGMT_CAP_WEBDAV);
  elements.webdavOffButton.disabled = elements.webdavSetButton.disabled;
  elements.webdavQueryButton.disabled = !management || !hasManagementCapability(MGMT_CAP_WEBDAV);
  updateBleNameControls();
  document.querySelectorAll("#cheatList button[data-cmd], #presets button, .presets button")
    .forEach(item => { item.disabled = !writable; });
  if (control && !canSerialInput()) elements.terminalInputHint.textContent = t("serialReadonlyHint");
  else if (state.connected) elements.terminalInputHint.textContent = t("terminalInputHint");
}

function applySerialControl(control) {
  const previous = state.serialControl;
  if (!state.connected) return;
  if (previous?.epoch !== control.epoch || previous?.mode !== control.mode) {
    state.serialControlRevision++;
    serialInputPending = false;
    serialInputRevision++;
    clearTerminalGeometrySyncTimer();
    if (previous?.mode === "control") agentPanel?.connectionChanged(false);
    if (control.mode === "control") {
      state.terminalGeometrySynced = "";
      agentPanel?.connectionChanged(true);
    }
  }
  state.serialControl = control;
  serialControlPending = false;
  renderSerialControl();
  renderShellIntegration();
  if (control.mode === "control") scheduleTerminalGeometrySync();
}

function consumeSerialControl(text) {
  const control = parseSerialControl(text);
  const waiter = serialControlWaiter;
  serialControlWaiter = null;
  if (control) {
    const first = !state.serialControl;
    applySerialControl(control);
    if (state.mode === "ws") {
      startSerialControlPoll();
      if (first && control.mode === "available") requestSerialControl("claim").catch(() => {});
    }
    waiter?.(text);
    return true;
  }
  if (String(text).trim().startsWith("ERR control=")) {
    serialControlPending = false;
    if (state.serialControl && /ERR control=(?:readonly|not_owner|stale_epoch)(?:\s|$)/.test(String(text))) {
      applySerialControl({ ...state.serialControl, mode: "readonly" });
    }
    renderSerialControl();
    waiter?.(text);
    return true;
  }
  return false;
}

function waitForSerialControlReply(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const done = (text) => {
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => {
      if (serialControlWaiter === done) serialControlWaiter = null;
      resolve(null);
    }, timeoutMs);
    serialControlWaiter = done;
  });
}

/* Seamless hand-over: ask the bridge for the console only if its current
 * owner has been quiet long enough. The explicit button uses "claim", which
 * preempts immediately; this path never interrupts an active typist. */
async function claimIdleControl() {
  if (state.serialControl?.mode === "control") return true;
  if (!state.connected || !state.serialControl) return false;
  if (idleClaimInFlight) return idleClaimInFlight;
  serialControlPending = true;
  renderSerialControl();
  idleClaimInFlight = (async () => {
    try {
      if (state.mode === "ws") {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
        const reply = waitForSerialControlReply();
        state.ws.send("@control claim idle");
        await reply;
      } else {
        await sendControl("@c claim idle", { returnResponse: true, quiet: true });
      }
      return state.serialControl?.mode === "control";
    } catch {
      return false;
    } finally {
      serialControlPending = false;
      renderSerialControl();
      idleClaimInFlight = null;
    }
  })();
  return idleClaimInFlight;
}

function setAgentLedActive(active) {
  if (agentLedActive === active) return;
  agentLedActive = active;
  const action = agentLedAction(state.serialControl, active);
  if (action !== "?") requestSerialControl(action).catch(() => {});
}

async function requestSerialControl(action = "?") {
  if (!state.connected) return;
  if (state.mode === "ws") {
    if (!state.serialControl || state.ws?.readyState !== WebSocket.OPEN) return;
    state.ws.send(`@control ${action}`);
  } else {
    await sendControl(action === "?" ? "@c?" : `@c ${action}`, { returnResponse: true, quiet: true });
  }
}

function startSerialControlPoll() {
  if (serialControlTimer) return;
  serialControlTimer = setInterval(async () => {
    if (serialControlPolling || !state.connected || !state.serialControl) return;
    const operation = {};
    const generation = state.writeGeneration;
    serialControlPolling = operation;
    try { await requestSerialControl(agentLedAction(state.serialControl, agentLedActive)); }
    catch (_error) {
      if (generation === state.writeGeneration && state.serialControl) {
        applySerialControl({ ...state.serialControl, mode: "readonly" });
      }
    } finally {
      if (serialControlPolling === operation) serialControlPolling = false;
    }
  }, 2000);
}

document.getElementById("serialControlButton")?.addEventListener("click", async () => {
  if (serialControlPending || !state.serialControl) return;
  serialControlPending = true;
  renderSerialControl();
  try { await requestSerialControl(state.serialControl.mode === "control" ? "release" : "claim"); }
  catch (error) { toast(error.message, "error"); }
  finally { serialControlPending = false; renderSerialControl(); }
});

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
    if (canSerialInput()) requests.push(sendControl("@s?"));
  }
  return Promise.all(requests);
}

function updateBleNameControls() {
  const enabled =
    state.connected &&
    state.mode === "ble" &&
    state.mgmtReady &&
    state.bleNameSupported !== false;
  elements.bleNameInput.disabled = !enabled || !canSerialInput();
  elements.bleNameSetButton.disabled = !enabled || !canSerialInput();
  elements.bleNameDefaultButton.disabled = !enabled || !canSerialInput();
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
  setFeature("bleName", true);
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
  const name = state.mode === "ws"
    ? state.wsHost || ""
    : state.device
      ? state.device.name || state.device.id
      : "";
  elements.deviceName.textContent = name;
  /* The phone topbar hides the pill's word and device name; keep the identity
   * on a second line of the brand block instead of dropping it entirely. */
  if (elements.compactDevice) {
    elements.compactDevice.textContent = name;
    elements.compactDevice.hidden = !state.connected || !name;
  }
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
      setFeature("bleName", false);
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
      setFeature("bleName", false);
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

function onTerminalScroll() {
  if (!state.term) {
    return;
  }
  // xterm 6 renders through .xterm-scrollable-element; .xterm-viewport is an
  // empty legacy node whose scrollTop never changes. Follow the buffer instead.
  const buffer = state.term.buffer.active;
  setAutoScroll(buffer.viewportY >= buffer.baseY, false);
}

const TERMINAL_TOUCH_SLOP = 10;
const TERMINAL_LONG_PRESS_MS = 400;
const terminalTouch = {
  active: false,
  startX: 0,
  startY: 0,
  startTime: 0,
  lastY: 0,
  moved: false,
  scrolling: false,
  longPress: false,
  selectionBase: null,
  blurOnEnd: false,
  cancelled: false,
  suppressClick: false,
  suppressFocusUntil: 0,
  timer: 0,
};

// The two draggable dots and the floating Copy pill shown after a long press.
// The endpoints are buffer cells, so the dots follow the same text the way the
// phone's own selection handles do.
const terminalSelection = {
  start: null,
  end: null,
  // The text is snapshotted when the selection is made. Android WebViews can
  // collapse their DOM selection during a long press, which makes xterm clear
  // its own selection; Copy must still return what the user selected.
  text: "",
  stamp: 0,
  drag: null,
  ui: null,
  reasserting: false,
};

function clearTerminalTouchTimer() {
  if (terminalTouch.timer) {
    clearTimeout(terminalTouch.timer);
    terminalTouch.timer = 0;
  }
}

function suppressTerminalFocus(ms = 600) {
  terminalTouch.suppressClick = true;
  terminalTouch.suppressFocusUntil = performance.now() + ms;
}

function releaseTerminalFocusSuppression() {
  terminalTouch.suppressClick = false;
  terminalTouch.suppressFocusUntil = 0;
}

function terminalFocusSuppressed() {
  return performance.now() < terminalTouch.suppressFocusUntil;
}

function blurTerminalIfFocusSuppressed() {
  if (terminalFocusSuppressed()) {
    state.term?.blur();
  }
}

function terminalCellAt(clientX, clientY) {
  const term = state.term;
  const screen = elements.terminalOutput.querySelector(".xterm-screen");
  if (!term || !screen) {
    return null;
  }
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const x = Math.min(Math.max(clientX - rect.left, 0), rect.width - 1);
  const y = Math.min(Math.max(clientY - rect.top, 0), rect.height - 1);
  return {
    col: Math.min(term.cols - 1, Math.floor((x / rect.width) * term.cols)),
    row:
      term.buffer.active.viewportY +
      Math.min(term.rows - 1, Math.floor((y / rect.height) * term.rows)),
    rowHeight: rect.height / term.rows,
  };
}

function terminalCellIsWordChar(line, col) {
  const cell = line.getCell(col);
  if (!cell) {
    return false;
  }
  // A wide character occupies two cells; the trailing cell has width zero and
  // belongs to the same word as the character before it.
  if (cell.getWidth() === 0) {
    return true;
  }
  return Boolean(cell.getChars()) && !/\s/.test(cell.getChars());
}

function terminalWordRangeAt(cell) {
  const term = state.term;
  if (!term || !cell) {
    return null;
  }
  const line = term.buffer.active.getLine(cell.row);
  if (!line) {
    return null;
  }
  const col = Math.min(cell.col, Math.max(0, line.length - 1));
  if (!terminalCellIsWordChar(line, col)) {
    return {
      start: { row: cell.row, col },
      end: { row: cell.row, col },
    };
  }
  let start = col;
  let end = col;
  while (start > 0 && terminalCellIsWordChar(line, start - 1)) {
    start -= 1;
  }
  while (end + 1 < line.length && terminalCellIsWordChar(line, end + 1)) {
    end += 1;
  }
  return {
    start: { row: cell.row, col: start },
    end: { row: cell.row, col: end },
  };
}

function terminalCellGeometry(cell) {
  const term = state.term;
  const screen = elements.terminalOutput.querySelector(".xterm-screen");
  if (!term || !screen || !cell) {
    return null;
  }
  const viewportRow = cell.row - term.buffer.active.viewportY;
  if (viewportRow < 0 || viewportRow >= term.rows) {
    return null;
  }
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const cellWidth = rect.width / term.cols;
  const cellHeight = rect.height / term.rows;
  return {
    left: rect.left + cell.col * cellWidth,
    right: rect.left + Math.min(term.cols, cell.col + 1) * cellWidth,
    top: rect.top + viewportRow * cellHeight,
    bottom: rect.top + (viewportRow + 1) * cellHeight,
    cellWidth,
    cellHeight,
    screen: rect,
  };
}

function positionTerminalSelectionHandles() {
  const ui = terminalSelection.ui;
  const { start, end } = terminalSelection;
  if (!ui || !start || !end) {
    if (ui) {
      ui.root.hidden = true;
    }
    return;
  }
  const startGeo = terminalCellGeometry(start);
  const endGeo = terminalCellGeometry(end);
  if (!startGeo || !endGeo) {
    // The selection scrolled out of the viewport; the dots would be wrong.
    ui.root.hidden = true;
    return;
  }
  ui.root.hidden = false;
  const vv = window.visualViewport;
  const margin = 14;
  const viewLeft = vv?.offsetLeft || 0;
  const viewTop = vv?.offsetTop || 0;
  const viewRight = viewLeft + (vv?.width || window.innerWidth);
  const viewBottom = viewTop + (vv?.height || window.innerHeight);
  const clampX = (x) =>
    Math.min(viewRight - margin, Math.max(viewLeft + margin, x));
  const clampY = (y) =>
    Math.min(viewBottom - margin, Math.max(viewTop + margin, y));

  // The start dot sits above the first selected cell and the end dot below the
  // last one, so neither dot covers the text being selected.
  ui.start.style.left = `${clampX(startGeo.left)}px`;
  ui.start.style.top = `${clampY(startGeo.top - 16)}px`;
  ui.end.style.left = `${clampX(endGeo.right)}px`;
  ui.end.style.top = `${clampY(endGeo.bottom + 16)}px`;

  const selectionTop = Math.min(startGeo.top, endGeo.top);
  const selectionBottom = Math.max(startGeo.bottom, endGeo.bottom);
  const copyAbove = selectionTop - viewTop > 64;
  ui.copy.classList.toggle("terminal-selection-copy-below", !copyAbove);
  ui.copy.style.left = `${clampX((startGeo.left + endGeo.right) / 2)}px`;
  ui.copy.style.top = `${copyAbove ? selectionTop - 10 : selectionBottom + 10}px`;
}

function hideTerminalSelectionHandles() {
  terminalSelection.start = null;
  terminalSelection.end = null;
  terminalSelection.text = "";
  terminalSelection.stamp = 0;
  terminalSelection.drag = null;
  if (terminalSelection.ui) {
    terminalSelection.ui.root.hidden = true;
  }
}

function onSelectionHandleDown(event) {
  const which = event.currentTarget.dataset.selectionHandle;
  const start = terminalSelection.start;
  const end = terminalSelection.end;
  if (!start || !end || (which !== "start" && which !== "end")) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const endpoint = which === "start" ? start : end;
  const geometry = terminalCellGeometry(endpoint);
  // The opposite endpoint stays put while this dot moves the active edge.
  terminalSelection.drag = {
    which,
    fixed: which === "start" ? { ...end } : { ...start },
    row: endpoint.row,
    col: endpoint.col,
    pointerX: event.clientX,
    pointerY: event.clientY,
    cellWidth: geometry?.cellWidth || 8,
    cellHeight: geometry?.cellHeight || 16,
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function onSelectionHandleMove(event) {
  const drag = terminalSelection.drag;
  if (!drag) {
    return;
  }
  event.preventDefault();
  const term = state.term;
  if (!term) {
    return;
  }
  // Measure from the grabbed cell, not from the dot's pixel position: the
  // start dot sits on the left edge and the end dot on the right edge, so an
  // absolute lookup would jump one cell on the first move. Rounding also lets
  // small finger jitter stay on the same character.
  const viewportY = term.buffer.active.viewportY;
  const rowDelta = Math.round((event.clientY - drag.pointerY) / drag.cellHeight);
  const colDelta = Math.round((event.clientX - drag.pointerX) / drag.cellWidth);
  const cell = {
    row: Math.min(
      viewportY + term.rows - 1,
      Math.max(viewportY, drag.row + rowDelta),
    ),
    col: Math.min(term.cols - 1, Math.max(0, drag.col + colDelta)),
  };
  if (drag.which === "start") {
    setTerminalSelection(cell, drag.fixed);
  } else {
    setTerminalSelection(drag.fixed, cell);
  }
}

function onSelectionHandleUp(event) {
  if (!terminalSelection.drag) {
    return;
  }
  const handle = event.currentTarget;
  if (handle?.releasePointerCapture && event.pointerId != null) {
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch (_error) {
      // The capture was already released.
    }
  }
  terminalSelection.drag = null;
  positionTerminalSelectionHandles();
}

function ensureTerminalSelectionUi() {
  if (terminalSelection.ui) {
    return terminalSelection.ui;
  }
  const root = document.createElement("div");
  root.className = "terminal-selection-ui";
  root.hidden = true;

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "terminal-selection-copy";
  copy.textContent = t("copy");
  // Keep the terminal focused (and a soft keyboard open) while copying. The
  // click still fires; only the focus stealing is suppressed.
  copy.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  copy.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = terminalCopyText();
    if (!text) {
      toast(t("copyFailed"), "error");
      return;
    }
    copyToClipboard(text).then(
      (copied) =>
        toast(t(copied ? "copied" : "copyFailed"), copied ? undefined : "error"),
      () => toast(t("copyFailed"), "error"),
    );
  });

  const handles = {};
  for (const which of ["start", "end"]) {
    const handle = document.createElement("span");
    handle.className = `terminal-selection-handle terminal-selection-handle-${which}`;
    handle.dataset.selectionHandle = which;
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", onSelectionHandleDown);
    handles[which] = handle;
  }
  root.append(copy, handles.start, handles.end);
  document.body.append(root);
  terminalSelection.ui = { root, copy, start: handles.start, end: handles.end };

  window.addEventListener("pointermove", onSelectionHandleMove, {
    passive: false,
  });
  window.addEventListener("pointerup", onSelectionHandleUp);
  window.addEventListener("pointercancel", onSelectionHandleUp);
  window.addEventListener("resize", positionTerminalSelectionHandles, {
    passive: true,
  });
  window.visualViewport?.addEventListener(
    "resize",
    positionTerminalSelectionHandles,
    { passive: true },
  );
  return terminalSelection.ui;
}

function setTerminalSelection(start, end) {
  const term = state.term;
  if (!term || !start || !end) {
    return false;
  }
  let first = start;
  let last = end;
  if (
    first.row > last.row ||
    (first.row === last.row && first.col > last.col)
  ) {
    [first, last] = [last, first];
  }
  // xterm's public select() takes a linear cell count. Include the cell under
  // the finger so dragging to a character selects that character too.
  const length =
    (last.row - first.row) * term.cols + (last.col - first.col) + 1;
  term.select(first.col, first.row, length);
  if (!term.hasSelection()) {
    hideTerminalSelectionHandles();
    return false;
  }
  terminalSelection.start = { row: first.row, col: first.col };
  terminalSelection.end = { row: last.row, col: last.col };
  terminalSelection.text = term.getSelection();
  terminalSelection.stamp = performance.now();
  ensureTerminalSelectionUi();
  positionTerminalSelectionHandles();
  return true;
}

function extendTerminalSelection(clientX, clientY) {
  const cell = terminalCellAt(clientX, clientY);
  const base = terminalTouch.selectionBase;
  if (!cell || !base) {
    return;
  }
  // Native-style extension: the long-pressed word stays selected and the drag
  // grows the range from the word edge nearest the finger. Moving back inside
  // the word leaves just the word selected.
  const beforeWord =
    cell.row < base.start.row ||
    (cell.row === base.start.row && cell.col < base.start.col);
  const afterWord =
    cell.row > base.end.row ||
    (cell.row === base.end.row && cell.col > base.end.col);
  if (beforeWord) {
    setTerminalSelection(cell, base.end);
  } else if (afterWord) {
    setTerminalSelection(base.start, cell);
  } else {
    setTerminalSelection(base.start, base.end);
  }
}

function selectTerminalWordAt(clientX, clientY) {
  const cell = terminalCellAt(clientX, clientY);
  const range = terminalWordRangeAt(cell);
  if (!range) {
    return false;
  }
  // The word under the finger is selected at once; the drag keeps that word
  // and extends from its edge, exactly like the phone's own selection.
  terminalTouch.selectionBase = range;
  return setTerminalSelection(range.start, range.end);
}

function beginTerminalLongPress(clientX, clientY) {
  if (terminalTouch.longPress || terminalSelection.start) {
    return true;
  }
  if (!selectTerminalWordAt(clientX, clientY)) {
    return false;
  }
  terminalTouch.longPress = true;
  suppressTerminalFocus();
  navigator.vibrate?.(8);
  return true;
}

function browserTerminalSelectionText() {
  if (nativeSelectionShell) return "";
  const rows = elements.terminalOutput.querySelector(".xterm-rows");
  const selection = document.getSelection?.();
  if (!rows || !selection || selection.isCollapsed || selection.rangeCount !== 1) return "";
  const range = selection.getRangeAt(0);
  if (!rows.contains(range.startContainer) || !rows.contains(range.endContainer)) return "";
  return selection.toString();
}

function preserveBrowserTerminalSelection() {
  if (!browserTerminalSelectionText()) return false;
  clearTerminalTouchTimer();
  terminalTouch.active = false;
  terminalTouch.scrolling = false;
  releaseTerminalFocusSuppression();
  return true;
}

function onTerminalTouchStart(event) {
  if (!state.connected || !state.term || event.touches.length !== 1) {
    return;
  }
  if (preserveBrowserTerminalSelection()) return;
  const touch = event.touches[0];
  clearTerminalTouchTimer();
  // Hold focus off for the whole gesture. A tap releases it in touchend, while
  // a scroll or long press keeps it suppressed so WebView cannot flash the
  // keyboard before we know which gesture this is.
  suppressTerminalFocus(5000);
  terminalTouch.active = true;
  terminalTouch.startX = touch.clientX;
  terminalTouch.startY = touch.clientY;
  terminalTouch.startTime = performance.now();
  terminalTouch.lastY = touch.clientY;
  terminalTouch.moved = false;
  terminalTouch.scrolling = false;
  terminalTouch.longPress = false;
  terminalTouch.selectionBase = null;
  // Read the keyboard state here, not in pointerdown: some WebViews deliver
  // only touch events. A keyboard that is already open must stay open while
  // the user selects text or scrolls.
  terminalTouch.blurOnEnd = !terminalHasFocus();
  terminalTouch.cancelled = false;
  // Drop any WebView-owned DOM selection before xterm draws its own. A later
  // collapsed DOM selection inside the rows makes xterm clear the selection.
  if (nativeSelectionShell) {
    const domSelection = document.getSelection?.();
    if (domSelection?.rangeCount) domSelection.removeAllRanges();
  }
  // Clear our own selection UI first: clearSelection() fires the change event,
  // and the endpoints must already be gone so the guard does not reassert the
  // previous selection.
  hideTerminalSelectionHandles();
  state.term.clearSelection();
  if (nativeSelectionShell) {
    terminalTouch.timer = setTimeout(() => {
      terminalTouch.timer = 0;
      if (!terminalTouch.active || terminalTouch.moved || terminalTouch.scrolling) {
        return;
      }
      beginTerminalLongPress(terminalTouch.startX, terminalTouch.startY);
    }, TERMINAL_LONG_PRESS_MS);
  }
}

function onTerminalTouchMove(event) {
  if (preserveBrowserTerminalSelection()) return;
  if (!terminalTouch.active) {
    return;
  }
  const touch = event.touches[0];
  if (!touch) {
    return;
  }
  const dx = touch.clientX - terminalTouch.startX;
  const dy = touch.clientY - terminalTouch.startY;

  if (terminalTouch.longPress) {
    // Native-style selection: keep the finger's cell as the moving edge. This
    // also works while the soft keyboard is open, because the gesture never
    // takes focus away from the terminal. Mark the gesture as consumed so a
    // later touchcancel can never turn it back into a tap or reset the word.
    event.preventDefault();
    terminalTouch.moved = true;
    extendTerminalSelection(touch.clientX, touch.clientY);
    return;
  }
  if (
    !terminalTouch.scrolling &&
    Math.abs(dy) > TERMINAL_TOUCH_SLOP &&
    Math.abs(dy) >= Math.abs(dx)
  ) {
    terminalTouch.scrolling = true;
    suppressTerminalFocus();
    clearTerminalTouchTimer();
  }
  if (terminalTouch.scrolling) {
    // xterm 6 has no touch scrolling of its own; drive the buffer directly.
    // The keyboard state is left alone, so history can be read with the
    // keyboard either open or closed.
    event.preventDefault();
    const cell = terminalCellAt(touch.clientX, touch.clientY);
    const rowHeight = cell?.rowHeight || 18;
    const rows = Math.trunc((terminalTouch.lastY - touch.clientY) / rowHeight);
    if (rows) {
      state.term?.scrollLines(rows);
      terminalTouch.lastY -= rows * rowHeight;
      terminalTouch.moved = true;
    }
    return;
  }
  if (Math.abs(dx) > TERMINAL_TOUCH_SLOP || Math.abs(dy) > TERMINAL_TOUCH_SLOP) {
    terminalTouch.moved = true;
    clearTerminalTouchTimer();
  }
}

function finishTerminalTouch(event) {
  if (preserveBrowserTerminalSelection()) return;
  if (!terminalTouch.active) {
    return;
  }
  const wasScrolling = terminalTouch.scrolling;
  let wasLongPress = terminalTouch.longPress;
  const wasMoved = terminalTouch.moved;
  const wasCancelled = terminalTouch.cancelled;
  const heldMs = performance.now() - terminalTouch.startTime;
  const blurOnEnd = terminalTouch.blurOnEnd;
  const startX = terminalTouch.startX;
  const startY = terminalTouch.startY;
  clearTerminalTouchTimer();
  terminalTouch.active = false;
  terminalTouch.scrolling = false;
  terminalTouch.longPress = false;
  terminalTouch.selectionBase = null;
  terminalTouch.moved = false;
  terminalTouch.blurOnEnd = false;
  terminalTouch.cancelled = false;

  // A WebView may swallow the long-press timer or send touchcancel when its
  // own gesture detector fires. A stationary press that lasted long enough is
  // still a selection gesture, never a tap that opens the keyboard.
  const heldLongEnough = heldMs >= TERMINAL_LONG_PRESS_MS - 20;
  if (nativeSelectionShell && !wasLongPress && !wasScrolling && !wasMoved &&
      heldLongEnough) {
    wasLongPress = beginTerminalLongPress(startX, startY);
  }
  // A selection that is already on screen proves this was a long press, even
  // if the WebView reset the gesture state under us.
  if (nativeSelectionShell && terminalSelection.start) {
    wasLongPress = true;
  }

  if (wasScrolling || wasLongPress || wasCancelled || (heldLongEnough && !wasMoved)) {
    // Keep the synthetic click/mousedown and any delayed WebView focus from
    // reopening the keyboard after a scroll or selection gesture. The next
    // touchstart releases the guard, so a deliberate tap still opens it.
    suppressTerminalFocus(1200);
    if (blurOnEnd) {
      state.term?.blur();
      for (const delay of [0, 120, 400, 800]) {
        window.setTimeout(blurTerminalIfFocusSuppressed, delay);
      }
    }
    event.preventDefault();
    return;
  }
  if (!wasMoved) {
    releaseTerminalFocusSuppression();
    window.requestAnimationFrame(() => {
      if (state.connected) state.term?.focus();
    });
  }
}

function onTerminalTouchCancel(event) {
  // touchcancel often arrives when the WebView tries to take the gesture for
  // its own text selection. A stationary touch becomes a selection instead of
  // a tap, and a cancelled gesture never opens the keyboard.
  if (!terminalTouch.active) {
    return;
  }
  if (nativeSelectionShell && !terminalTouch.longPress &&
      !terminalTouch.moved && !terminalTouch.scrolling &&
      !terminalSelection.start) {
    beginTerminalLongPress(terminalTouch.startX, terminalTouch.startY);
  }
  terminalTouch.cancelled = true;
  finishTerminalTouch(event);
}

function terminalCopyText() {
  const term = state.term;
  if (!term) {
    return "";
  }
  const browserSelection = browserTerminalSelectionText();
  if (browserSelection) return browserSelection;
  const selected = term.getSelection();
  if (selected) {
    return selected;
  }
  // Android may collapse its DOM selection right after a long press, which
  // makes xterm drop the selection. The snapshot keeps Copy working.
  if (terminalSelection.text) {
    return terminalSelection.text;
  }
  // No selection and no snapshot: copy nothing. Falling back to the whole
  // scrollback made a tap on Copy paste an unrelated transcript, which is far
  // worse than telling the user there was nothing selected.
  return "";
}

async function copyToClipboard(text) {
  if (!text) {
    return false;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      // Capacitor WebViews and non-secure origins can reject the async API.
    }
  }
  // Supply the requested text through the browser's copy event. Selecting a
  // temporary textarea would steal terminal focus and dismiss the soft IME.
  let copied = false;
  const onCopy = (event) => {
    if (!event.clipboardData) {
      return;
    }
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    // xterm's own copy handler must not replace the snapshot we supply.
    event.stopImmediatePropagation();
    copied = true;
  };
  document.addEventListener("copy", onCopy, true);
  try {
    return document.execCommand("copy") && copied;
  } catch (_error) {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
}

let connectionInFlight = false;
let disconnectInFlight = false;
/* The auto-reconnect state machine: one timer for the next attempt, one ticker
 * for the countdown, and the attempt count that also drives the backoff. */
const autoReconnect = {
  active: false,
  attempts: 0,
  timer: null,
  ticker: null,
  nextAt: 0,
  controller: null,
};
/* Set by a user-initiated disconnect so the teardown it causes is not treated
 * as a lost link. onDisconnected() consumes it. */
let userInitiatedDisconnect = false;
/* The last connect attempt's failure class. Pairing is refused by the Bee until
 * the user presses its pairing key, so a refused encrypted read must not be
 * answered with the automatic reconnect loop: that loop can never succeed and
 * hides the fact that a physical press is required. The next manual Connect is
 * the user's re-initiation. */
let lastConnectFailure = null;

function pairingRefused(error) {
  const text = String(error?.message || "");

  /* Only explicit authentication failures require a fresh pairing attempt.
   * Timeouts/disconnects can happen during any GATT operation, including the
   * first encrypted read. SecurityError alone may instead be a browser policy
   * restriction and is not evidence that the Bee refused pairing. */
  return /insufficient (authentication|encryption|security)|authentication failed|pairing failed/i.test(text);
}


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
  renderAutoReconnectStatus();
}


/* -------------------------------------------------------------------------
 * Board I/O: RGB status LED, optocoupler contact, NEC remote and IR learning
 * -------------------------------------------------------------------------
 *
 * Everything here is optional hardware that only the Linkr Bee X1.0 carries.
 * The first `ERR ... unsupported` reply from a board disables the whole group
 * instead of leaving buttons that can never work. Status lines are written
 * from the parsed replies, so the panel always shows what the board said.
 */

let boardSwatchButtons = [];
let bondUi = null;

function boardUsable() {
  return state.connected && state.mode !== "ws" && state.mgmtReady;
}

/* Feature flags drive which panels a board exposes. null means "not probed
 * yet": keep the panel visible until the board answers, false hides it. */
function setFeature(key, supported) {
  const next = supported === null ? null : Boolean(supported);
  if (state.features[key] === next) {
    applyFeatureVisibility();
    return;
  }
  state.features[key] = next;
  applyFeatureVisibility();
}

/* What a management-driven feature starts as on a new connection. A board that
 * finished the BLE handshake without a management service (legacy NUS
 * firmware) cannot host any of these devices and has no command channel to
 * probe them with, so "not probed yet" would keep every card, settings tab and
 * rail entry on screen forever: answer false. While the handshake is still
 * running, or on a LAN link, the answer is unknown (null) and the controls
 * stay visible. */
function unmanagedFeatureValue(connected, isWs, mgmtReady) {
  return connected && !isWs && !mgmtReady ? false : null;
}

function setTabHidden(name, hidden) {
  const tab = document.querySelector(`.settings-tab[data-settings-target="${name}"]`);
  if (tab) tab.hidden = Boolean(hidden);
  const rail = document.querySelector(`[data-rail-target="${name}"]`);
  if (rail) rail.hidden = Boolean(hidden);
}

function updateNetworkCardTitle() {
  const title = elements.wifiWebdavTitle;
  if (!title) return;
  const wifi = state.features.wifi;
  const webdav = state.features.webdav;
  const key = wifi === false ? "webdav" : webdav === false ? "wifi" : "wifiWebdav";
  title.dataset.i18n = key;
  title.textContent = t(key);
  elements.wifiWebdavCard?.setAttribute("aria-label", t(key));
}

function applyFeatureVisibility() {
  const features = state.features;
  const bondsCard = $("boardBondsCard");
  if (bondsCard) bondsCard.hidden = features.bonds === false;
  const cards = [
    [elements.boardLedCard, features.led],
    [elements.boardOptoCard, features.opto],
    [elements.boardIrCard, features.ir],
  ];
  for (const [card, supported] of cards) {
    if (!card) continue;
    card.hidden = supported === false;
  }
  const learningHidden = features.ir === false || features.irLearn === false;
  if (elements.boardLearnBlock) elements.boardLearnBlock.hidden = learningHidden;
  if (elements.boardSavedBlock) elements.boardSavedBlock.hidden = learningHidden;

  /* Prompts live on the AI page and paired devices in Connection, so the Board
   * section depends only on the three board devices. */
  const boardUnsupported = features.led === false && features.opto === false &&
    features.ir === false;
  setTabHidden("board", boardUnsupported);

  if (elements.wifiBlock) elements.wifiBlock.hidden = features.wifi === false;
  if (elements.webdavBlock) elements.webdavBlock.hidden = features.webdav === false;
  const networkUnsupported = features.wifi === false && features.webdav === false;
  if (elements.wifiWebdavCard) elements.wifiWebdavCard.hidden = networkUnsupported;
  setTabHidden("network", networkUnsupported);
  updateNetworkCardTitle();

  if (elements.bleNameCard) elements.bleNameCard.hidden = features.bleName === false;
  if (elements.boardPromptCard) elements.boardPromptCard.hidden = features.prompt === false;

  /* Never leave the drawer on a section that just disappeared. */
  const active = elements.controls?.dataset.settingsActive;
  if (active) {
    const tab = document.querySelector(`.settings-tab[data-settings-target="${active}"]`);
    if (tab && tab.hidden) setSettingsPage("connection");
  }
}

function boardStatus(element, text, tone = "") {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("is-error", tone === "error");
  element.classList.toggle("is-ok", tone === "ok");
}

function boardFailureText(text) {
  const reply = boardReply(text);
  return reply.ok ? "" : (reply.error || t("boardCmdError"));
}

async function boardSend(command, { quiet = false } = {}) {
  const text = await sendControl(command, { returnResponse: true, quiet });
  return String(text ?? "");
}

/* A group that answers "unsupported" is a board variant, not an error: hide
 * its card and stop asking. */
function hideUnsupportedFeature(key, text) {
  if (!isUnsupportedReply(text)) return false;
  setFeature(key, false);
  return true;
}

/* The same answer arrives two ways. A board without the device can reply
 * "OK <group> unsupported" to a query, or reject the control request with
 * "ERR <group> unsupported" — the tracker turns the error flag into a
 * rejected promise carrying the raw reply text. Both paths must land in the
 * same place, otherwise the feature stays "not probed", applyFeatureVisibility
 * keeps it visible, and the card, settings tab and rail entry stay on screen
 * for a board that cannot use them (AGENTS.md: capabilities decide the UI,
 * never a disabled ghost of an absent feature). */
function hideUnsupportedFromError(key, error) {
  const text = String((error && error.message) || error || "");
  if (!isUnsupportedReply(text)) return false;
  setFeature(key, false);
  return true;
}

function refreshBoardLabels() {
  bondUi?.render();
  for (const button of boardSwatchButtons) {
    if (!button.dataset.labelKey) continue;
    const label = t(button.dataset.labelKey);
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  if (state.board.lastLed) {
    renderBoardLed({ r: state.board.lastLed.r, g: state.board.lastLed.g, b: state.board.lastLed.b },
      { off: state.board.lastLed.off });
  }
  if (state.board.lastOptoClosed !== null) {
    renderBoardOptoStatus(state.board.lastOptoClosed);
  }
  if (state.board.lastIr) renderBoardIrStatus(state.board.lastIr);
  if (!state.board.learning && state.board.lastSlots) {
    renderBoardSlots(state.board.lastSlots);
  }
  boardPromptStatusText(state.boardPromptBytes);
}

function updateBoardIoControls() {
  bondUi?.render();
  state.board.canControl = state.connected && state.mode !== "ws" && state.mgmtReady;
  const enabled = state.board.canControl;
  const actions = [
    elements.boardLedApply, elements.boardLedOff, elements.boardLedQuery,
    elements.boardOptoClose, elements.boardOptoOpen, elements.boardOptoQuery,
    elements.boardOptoPulse, elements.boardIrSend, elements.boardIrQuery,
    elements.boardLearnStart, elements.boardLearnStop,
    elements.boardPromptLoad, elements.boardPromptSave, elements.boardPromptClear,
  ];
  for (const button of actions) {
    if (button) button.disabled = !enabled;
  }
  for (const button of boardSwatchButtons) button.disabled = !enabled;
  const inputs = [
    elements.boardLedColor, elements.boardOptoPulseMs,
    elements.boardIrAddress, elements.boardIrCommand, elements.boardIrRepeats,
    elements.boardLearnSlot, elements.boardPromptText,
  ];
  for (const input of inputs) {
    if (input) input.disabled = !enabled;
  }
  applyBoardSlotButtonState();
}

function renderBoardLed(color, { off = false } = {}) {
  if (!color) return;
  state.board.lastLed = { ...color, off };
  const hex = ledHex(color);
  elements.boardLedColor.value = `#${hex}`;
  for (const button of boardSwatchButtons) {
    const current = button.dataset.hex === hex;
    button.classList.toggle("is-current", current);
    button.setAttribute("aria-pressed", String(current));
  }
  boardStatus(elements.boardLedStatus,
    off ? `${t("boardLed")}: ${t("boardColorOff")}`
        : `${t("boardLed")} ${ledHex(color).toUpperCase()}`,
    "ok");
}

function renderBoardOptoStatus(closed) {
  state.board.lastOptoClosed = Boolean(closed);
  boardStatus(elements.boardOptoStatus,
    closed ? t("boardOptoClosed") : t("boardOptoOpenState"), "ok");
}

async function refreshBoardLed({ quiet = true } = {}) {
  if (!boardUsable() || state.features.led === false) return null;
  try {
    const text = await boardSend(LED_QUERY_COMMAND, { quiet });
    if (hideUnsupportedFeature("led", text)) return null;
    const color = parseLedStatus(text);
    if (color) setFeature("led", true);
    if (color) renderBoardLed(color);
    else boardStatus(elements.boardLedStatus, boardFailureText(text) || text.trim(), "error");
    return color;
  } catch (error) {
    if (hideUnsupportedFromError("led", error)) return null;
    boardStatus(elements.boardLedStatus, error.message, "error");
    return null;
  }
}

async function refreshBoardOpto({ quiet = true } = {}) {
  if (!boardUsable() || state.features.opto === false) return null;
  try {
    const text = await boardSend(OPTO_QUERY_COMMAND, { quiet });
    if (hideUnsupportedFeature("opto", text)) return null;
    const status = parseOptoStatus(text);
    if (status) setFeature("opto", true);
    if (status) renderBoardOptoStatus(status.closed);
    else boardStatus(elements.boardOptoStatus, boardFailureText(text) || text.trim(), "error");
    return status;
  } catch (error) {
    if (hideUnsupportedFromError("opto", error)) return null;
    boardStatus(elements.boardOptoStatus, error.message, "error");
    return null;
  }
}

function renderBoardIrStatus(status) {
  state.board.lastIr = status;
  if (!status) return;
  const parts = [`${t("boardIrReceiver")}: ${status.rxOn ? "on" : "off"}`];
  if (status.last) {
    parts.push(`${t("boardIrLast")} 0x${status.last.address.toString(16).padStart(4, "0")}` +
      ` / 0x${status.last.command.toString(16).padStart(2, "0")}` +
      (status.last.extended ? " (ext)" : ""));
  } else {
    parts.push(t("boardIrNone"));
  }
  if (status.frames !== null) {
    parts.push(`frames=${status.frames} repeats=${status.repeats} glitches=${status.glitches}`);
  }
  boardStatus(elements.boardIrStatus, parts.join(" · "));
  if (status.learning.active) {
    boardStatus(elements.boardLearnStatus,
      `${t("boardLearnActive")} (${status.learning.edges})`);
  } else {
    boardStatus(elements.boardLearnStatus,
      `${t("boardLearnIdle")} · ${t("boardSlotUsed")} ${status.slotsUsed ?? 0}/${status.slotsTotal ?? state.board.slots}`);
  }
}

async function refreshBoardIr({ quiet = true } = {}) {
  if (!boardUsable() || state.features.ir === false) return null;
  try {
    const text = await boardSend(IR_QUERY_COMMAND, { quiet });
    if (hideUnsupportedFeature("ir", text)) {
      setFeature("irLearn", false);
      return null;
    }
    const status = parseIrStatus(text);
    if (status) {
      setFeature("ir", true);
      setFeature("irLearn", status.learnSupported !== false);
      renderBoardIrStatus(status);
    } else {
      boardStatus(elements.boardIrStatus, boardFailureText(text) || text.trim(), "error");
    }
    return status;
  } catch (error) {
    if (hideUnsupportedFromError("ir", error)) {
      setFeature("irLearn", false);
      return null;
    }
    boardStatus(elements.boardIrStatus, error.message, "error");
    return null;
  }
}

async function refreshBoardSlotNames(slots) {
  if (state.board.namesSupported === false) return;
  const names = {};
  let answered = false;
  for (const entry of slots) {
    if (entry.edges === 0) continue;
    try {
      const text = await boardSend(irNameQueryCommand({ slot: entry.slot }), { quiet: true });
      const parsed = parseIrName(text);
      const reply = boardReply(text);
      if (!reply.ok) {
        /* Firmware without @r name: keep the panel usable and stop asking. */
        state.board.namesSupported = false;
        state.board.slotNames = {};
        setFeature("irName", false);
        renderBoardSlots(state.board.lastSlots);
        return;
      }
      if (!parsed) continue;
      answered = true;
      if (parsed.name) names[String(entry.slot)] = parsed.name;
    } catch {
      return;
    }
  }
  if (answered) {
    state.board.namesSupported = true;
  }
  state.board.slotNames = names;
}

function boardSlotName(entry) {
  const custom = state.board.slotNames[String(entry.slot)];
  return custom || `${t("boardLearnSlot")} ${entry.slot}`;
}

function boardSlotMeta(entry) {
  return entry.edges > 0
    ? `${entry.edges} ${t("boardSlotUsed")}`
    : t("boardSlotEmpty");
}

function focusBoardSlotEditor() {
  const input = elements.boardSlotList?.querySelector(".board-slot-input");
  input?.focus();
  input?.select();
}

async function saveBoardSlotName(slot, value) {
  const name = sanitizeSlotName(value);
  try {
    const text = await boardSend(irNameSetCommand({ slot, name }));
    const reply = boardReply(text);
    if (!reply.ok) {
      boardStatus(elements.boardLearnStatus,
        reply.error || t("boardCmdError"), "error");
      return;
    }
    state.board.namesSupported = true;
    const names = { ...state.board.slotNames };
    if (name) names[String(slot)] = name;
    else delete names[String(slot)];
    state.board.slotNames = names;
    state.board.editingSlot = null;
    renderBoardSlots(state.board.lastSlots);
  } catch (error) {
    boardStatus(elements.boardLearnStatus, error.message, "error");
  }
}

function boardSlotLabel(entry) {
  return entry.edges > 0
    ? `${entry.slot} · ${entry.edges} ${t("boardSlotUsed")}`
    : `${entry.slot} · ${t("boardSlotEmpty")}`;
}

function boardSlotButton(action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-soft board-slot-action";
  button.dataset.boardAction = action;
  button.textContent = t(action === "play" ? "boardLearnPlay" : "boardLearnDelete");
  return button;
}

function applyBoardSlotButtonState() {
  if (!elements.boardSlotList) return;
  const enabled = state.board.canControl;
  for (const button of elements.boardSlotList.querySelectorAll("[data-board-action]")) {
    button.disabled = !enabled || button.dataset.empty === "1" ||
      (button.dataset.boardAction === "rename" &&
        state.board.namesSupported === false);
  }
}

function renderBoardSlots(parsed) {
  if (!parsed || !parsed.slots.length) return;
  state.board.lastSlots = parsed;
  state.board.slots = parsed.slots.length;
  state.board.slotEdges = parsed.slots.map((entry) => entry.edges);
  if (state.board.editingSlot !== null &&
      !parsed.slots.some((entry) => entry.slot === state.board.editingSlot)) {
    state.board.editingSlot = null;
  }

  const select = elements.boardLearnSlot;
  const previous = Number(select.value || 0);
  select.textContent = "";
  for (const entry of parsed.slots) {
    const option = document.createElement("option");
    option.value = String(entry.slot);
    option.textContent = state.board.slotNames[String(entry.slot)]
      ? `${entry.slot} · ${state.board.slotNames[String(entry.slot)]}`
      : boardSlotLabel(entry);
    select.append(option);
  }
  if (parsed.slots.some((entry) => entry.slot === previous)) {
    select.value = String(previous);
  }

  /* Saved signals are first-class rows: a learned key can be replayed without
   * touching the slot picker, and the owner can name it in any language so a
   * remote with many keys stays recognisable. Empty slots stay visible but
   * disabled, so the table does not jump around as captures change. */
  if (elements.boardSlotList) {
    elements.boardSlotList.textContent = "";
    for (const entry of parsed.slots) {
      const row = document.createElement("div");
      row.className = entry.edges > 0 ? "board-slot-row" : "board-slot-row is-empty";
      row.dataset.slot = String(entry.slot);
      row.dataset.edges = String(entry.edges);
      row.setAttribute("role", "listitem");

      const copy = document.createElement("div");
      copy.className = "board-slot-copy";
      const name = document.createElement("span");
      name.className = "board-slot-name";
      name.textContent = boardSlotName(entry);
      const meta = document.createElement("span");
      meta.className = "board-slot-meta";
      meta.textContent = boardSlotMeta(entry);
      copy.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "board-slot-actions";
      if (state.board.editingSlot === entry.slot) {
        row.classList.add("is-editing");
        const input = document.createElement("input");
        input.className = "board-slot-input";
        input.type = "text";
        input.value = state.board.slotNames[String(entry.slot)] || "";
        input.placeholder = t("boardSlotNamePlaceholder");
        input.setAttribute("aria-label", t("boardSlotNamePlaceholder"));
        input.dataset.slot = String(entry.slot);
        const save = boardSlotButton("save-name");
        save.textContent = t("boardSlotNameSave");
        const cancel = boardSlotButton("cancel-name");
        cancel.textContent = t("boardSlotNameCancel");
        actions.append(input, save, cancel);
      } else {
        const play = boardSlotButton("play");
        play.dataset.empty = entry.edges > 0 ? "0" : "1";
        const remove = boardSlotButton("delete");
        remove.dataset.empty = entry.edges > 0 ? "0" : "1";
        const rename = boardSlotButton("rename");
        rename.dataset.empty = entry.edges > 0 ? "0" : "1";
        rename.textContent = t("boardSlotRename");
        actions.append(play, remove);
        if (state.board.namesSupported !== false) actions.append(rename);
      }

      row.append(copy, actions);
      elements.boardSlotList.append(row);
    }
    applyBoardSlotButtonState();
    if (state.board.editingSlot !== null) focusBoardSlotEditor();
  }

  if (elements.boardSlotEmptyHint) {
    elements.boardSlotEmptyHint.hidden = parsed.used > 0;
  }
  boardStatus(elements.boardLearnStatus,
    `${t("boardLearnIdle")} · ${t("boardSlotUsed")} ${parsed.used}/${parsed.slots.length}`);
}

async function refreshBoardSlots({ quiet = true } = {}) {
  if (!boardUsable() || state.features.ir === false ||
      state.features.irLearn === false) return null;
  try {
    const text = await boardSend(IR_SLOTS_COMMAND, { quiet });
    if (hideUnsupportedFeature("irLearn", text)) return null;
    const parsed = parseIrSlots(text);
    if (parsed) {
      setFeature("irLearn", true);
      await refreshBoardSlotNames(parsed.slots);
      renderBoardSlots(parsed);
    } else {
      boardStatus(elements.boardLearnStatus, boardFailureText(text) || text.trim(), "error");
    }
    return parsed;
  } catch (error) {
    if (hideUnsupportedFromError("irLearn", error)) return null;
    boardStatus(elements.boardLearnStatus, error.message, "error");
    return null;
  }
}

function stopBoardLearnPolling() {
  if (state.board.pollTimer) {
    clearInterval(state.board.pollTimer);
    state.board.pollTimer = null;
  }
  state.board.polling = false;
  state.board.learning = false;
}

function startBoardLearnPolling() {
  stopBoardLearnPolling();
  state.board.polling = true;
  state.board.pollTimer = setInterval(pollBoardLearn, 500);
  pollBoardLearn();
}

async function pollBoardLearn() {
  if (!state.board.polling) return;
  if (!boardUsable()) {
    stopBoardLearnPolling();
    boardStatus(elements.boardLearnStatus, t("boardLearnFailed"), "error");
    return;
  }
  if (performance.now() > state.board.learnDeadline) {
    stopBoardLearnPolling();
    boardStatus(elements.boardLearnStatus, t("boardLearnFailed"), "error");
    await refreshBoardSlots();
    return;
  }
  const status = await refreshBoardIr();
  if (!status) return;
  if (!status.learning.active) {
    stopBoardLearnPolling();
    await refreshBoardSlots();
    const slot = Number(elements.boardLearnSlot.value || 0);
    const saved = (state.board.slotEdges[slot] || 0) > 0;
    boardStatus(elements.boardLearnStatus,
      saved ? `${t("boardLearnSaved")} ${slot}` : t("boardLearnFailed"),
      saved ? "ok" : "error");
  }
}

async function startBoardLearn() {
  if (!boardUsable()) return;
  const slot = Number(elements.boardLearnSlot.value || 0);
  try {
    const text = await boardSend(irLearnCommand({ slot }));
    const started = parseLearnStarted(text);
    if (!started) {
      boardStatus(elements.boardLearnStatus, boardFailureText(text) || text.trim(), "error");
      return;
    }
    state.board.learnDeadline = performance.now() + started.timeoutMs + 3000;
    boardStatus(elements.boardLearnStatus, t("boardLearnActive"));
    startBoardLearnPolling();
  } catch (error) {
    boardStatus(elements.boardLearnStatus, error.message, "error");
  }
}

async function stopBoardLearn() {
  if (!boardUsable()) return;
  stopBoardLearnPolling();
  try {
    const text = await boardSend(IR_LEARN_STOP_COMMAND);
    const reply = boardReply(text);
    boardStatus(elements.boardLearnStatus,
      reply.ok ? reply.line : (reply.error || t("boardCmdError")),
      reply.ok ? "ok" : "error");
    await refreshBoardSlots();
  } catch (error) {
    boardStatus(elements.boardLearnStatus, error.message, "error");
  }
}

async function playBoardSlot(slot) {
  if (!boardUsable()) return;
  if ((state.board.slotEdges[slot] || 0) === 0) {
    boardStatus(elements.boardLearnStatus, t("boardLearnEmpty"), "error");
    return;
  }
  try {
    const text = await boardSend(irPlayCommand({ slot }));
    const reply = boardReply(text);
    boardStatus(elements.boardLearnStatus,
      reply.ok ? reply.line : (reply.error || t("boardCmdError")),
      reply.ok ? "ok" : "error");
  } catch (error) {
    boardStatus(elements.boardLearnStatus, error.message, "error");
  }
}

async function deleteBoardSlot(slot) {
  if (!boardUsable()) return;
  try {
    const text = await boardSend(irDeleteCommand({ slot }));
    const reply = boardReply(text);
    boardStatus(elements.boardLearnStatus,
      reply.ok ? reply.line : (reply.error || t("boardCmdError")),
      reply.ok ? "ok" : "error");
    await refreshBoardSlots();
  } catch (error) {
    boardStatus(elements.boardLearnStatus, error.message, "error");
  }
}

async function sendBoardIrFrame() {
  if (!boardUsable()) return;
  let command;
  try {
    command = irSendCommand({
      address: elements.boardIrAddress.value,
      command: elements.boardIrCommand.value,
      repeats: elements.boardIrRepeats.value,
    });
  } catch (error) {
    boardStatus(elements.boardIrStatus, error.message, "error");
    return;
  }
  try {
    const text = await boardSend(command);
    const reply = boardReply(text);
    boardStatus(elements.boardIrStatus,
      reply.ok ? reply.line : (reply.error || t("boardCmdError")),
      reply.ok ? "ok" : "error");
  } catch (error) {
    if (hideUnsupportedFromError("ir", error)) {
      setFeature("irLearn", false);
      return;
    }
    boardStatus(elements.boardIrStatus, error.message, "error");
  }
}

async function boardOptoAction(action) {
  if (!boardUsable()) return;
  let command;
  try {
    command = optoCommand(action);
  } catch (error) {
    boardStatus(elements.boardOptoStatus, error.message, "error");
    return;
  }
  try {
    const text = await boardSend(command);
    const reply = boardReply(text);
    const status = parseOptoStatus(text);
    if (status) {
      renderBoardOptoStatus(status.closed);
    } else {
      boardStatus(elements.boardOptoStatus,
        reply.ok ? reply.line : (reply.error || t("boardCmdError")),
        reply.ok ? "ok" : "error");
    }
  } catch (error) {
    if (hideUnsupportedFromError("opto", error)) return;
    boardStatus(elements.boardOptoStatus, error.message, "error");
  }
}

async function applyBoardLedColor() {
  if (!boardUsable()) return;
  let color;
  try {
    color = rgbFromHex(elements.boardLedColor.value);
  } catch (error) {
    boardStatus(elements.boardLedStatus, error.message, "error");
    return;
  }
  try {
    const text = await boardSend(ledCommand(color));
    const reply = boardReply(text);
    if (!reply.ok) {
      boardStatus(elements.boardLedStatus, reply.error || t("boardCmdError"), "error");
      return;
    }
    renderBoardLed(parseLedStatus(text) || color);
  } catch (error) {
    if (hideUnsupportedFromError("led", error)) return;
    boardStatus(elements.boardLedStatus, error.message, "error");
  }
}

/* -------------------------------------------------------------------------
 * Board-stored AI prompt
 * ------------------------------------------------------------------------- */

async function readBoardPrompt() {
  const chunks = [];
  let offset = 0;
  for (let guard = 0; guard < 32; guard += 1) {
    const text = await boardSend(promptGetCommand({ offset }), { quiet: true });
    const chunk = parsePromptChunk(text);
    if (!chunk) {
      throw new Error(boardReply(text).error || t("boardCmdError"));
    }
    chunks.push(chunk);
    offset += chunk.hex.length / 2;
    if (chunk.done) break;
  }
  if (!chunks.length) return "";
  return assemblePrompt(chunks, chunks[chunks.length - 1].total);
}

function updateBoardPromptCount() {
  if (!elements.boardPromptCount || !elements.boardPromptText) return;
  const bytes = new TextEncoder().encode(elements.boardPromptText.value).length;
  elements.boardPromptCount.textContent = `${bytes} / 240`;
  elements.boardPromptCount.classList.toggle("is-over", bytes > 240);
}

function boardPromptStatusText(bytes, tone = "") {
  boardStatus(elements.boardPromptStatus,
    bytes > 0 ? `${t("boardPromptStored")} ${bytes} ${t("boardPromptBytes")}` : t("boardPromptEmpty"),
    tone);
}

async function refreshBoardPromptStatus({ quiet = true } = {}) {
  if (!boardUsable() || state.features.prompt === false) return null;
  try {
    const text = await boardSend(PROMPT_QUERY_COMMAND, { quiet });
    if (hideUnsupportedFeature("prompt", text)) return null;
    const status = parsePromptStatus(text);
    if (status) setFeature("prompt", true);
    if (!status) {
      boardStatus(elements.boardPromptStatus,
        boardFailureText(text) || text.trim(), "error");
      return null;
    }
    state.boardPromptBytes = status.bytes;
    boardPromptStatusText(status.bytes);
    return status;
  } catch (error) {
    if (hideUnsupportedFromError("prompt", error)) return null;
    boardStatus(elements.boardPromptStatus, error.message, "error");
    return null;
  }
}

async function loadBoardPrompt() {
  if (!boardUsable()) return;
  try {
    const text = await readBoardPrompt();
    elements.boardPromptText.value = text;
    updateBoardPromptCount();
    boardPromptStatusText(new TextEncoder().encode(text).length);
  } catch (error) {
    boardStatus(elements.boardPromptStatus, error.message, "error");
  }
}

async function saveBoardPrompt() {
  if (!boardUsable()) return;
  let command;
  try {
    command = promptSetCommand({ text: elements.boardPromptText.value });
  } catch (error) {
    boardStatus(elements.boardPromptStatus, error.message, "error");
    return;
  }
  try {
    const text = await boardSend(command);
    const reply = boardReply(text);
    if (!reply.ok) {
      boardStatus(elements.boardPromptStatus, reply.error || t("boardCmdError"), "error");
      return;
    }
    await refreshBoardPromptStatus({ quiet: false });
    boardStatus(elements.boardPromptStatus,
      `${t("boardPromptSaved")} · ${state.boardPromptBytes} ${t("boardPromptBytes")}`, "ok");
  } catch (error) {
    boardStatus(elements.boardPromptStatus, error.message, "error");
  }
}

async function clearBoardPrompt() {
  if (!boardUsable()) return;
  try {
    const text = await boardSend(PROMPT_CLEAR_COMMAND);
    const reply = boardReply(text);
    if (!reply.ok) {
      boardStatus(elements.boardPromptStatus, reply.error || t("boardCmdError"), "error");
      return;
    }
    elements.boardPromptText.value = "";
    updateBoardPromptCount();
    boardPromptStatusText(0);
  } catch (error) {
    boardStatus(elements.boardPromptStatus, error.message, "error");
  }
}

/* The assistant runtime asks for the instructions when a conversation starts;
 * a missing or unsupported board prompt must never block the assistant. */
async function readBoardPromptForAgent() {
  if (!boardUsable()) return "";
  try {
    return await readBoardPrompt();
  } catch {
    return "";
  }
}

function wireBoardPromptControls() {
  elements.boardPromptText?.addEventListener("input", updateBoardPromptCount);
  elements.boardPromptLoad?.addEventListener("click", loadBoardPrompt);
  elements.boardPromptSave?.addEventListener("click", saveBoardPrompt);
  elements.boardPromptClear?.addEventListener("click", clearBoardPrompt);
  updateBoardPromptCount();
}

async function refreshBoardIo() {
  if (!state.board.canControl) return;
  await refreshBoardLed();
  await refreshBoardOpto();
  await refreshBoardIr();
  await refreshBoardSlots();
}

function wireBoardIoControls() {
  bondUi = createBondUi({
    card: $("boardBondsCard"),
    context: () => ({ lang, supported: state.features.bonds, ready: boardUsable(), control: canSerialInput(), generation: state.writeGeneration }),
    send: (command, options) => boardSend(command, options),
    supported: value => setFeature("bonds", value),
    beforeSelfDelete: () => { cancelAutoReconnect(); userInitiatedDisconnect = true; },
    afterSelfDelete: (token, queued) => { if (!queued && state.writeGeneration === token) userInitiatedDisconnect = false; },
  });
  if (!elements.boardLedSwatches) return;
  boardSwatchButtons = BOARD_SWATCHES.map((swatch) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "board-swatch";
    button.dataset.hex = swatch.hex;
    button.style.setProperty("--board-swatch", `#${swatch.hex}`);
    button.dataset.labelKey = swatch.label;
    button.title = t(swatch.label);
    button.setAttribute("aria-label", t(swatch.label));
    button.setAttribute("aria-pressed", "false");
    if (swatch.hex === "000000") button.dataset.off = "1";
    button.addEventListener("click", () => {
      elements.boardLedColor.value = `#${swatch.hex}`;
      applyBoardLedColor();
    });
    elements.boardLedSwatches.append(button);
    return button;
  });

  elements.boardLedApply?.addEventListener("click", applyBoardLedColor);
  elements.boardLedOff?.addEventListener("click", async () => {
    if (!boardUsable()) return;
    try {
      const text = await boardSend(LED_OFF_COMMAND);
      const reply = boardReply(text);
      if (reply.ok) renderBoardLed({ r: 0, g: 0, b: 0 }, { off: true });
      else boardStatus(elements.boardLedStatus, reply.error || t("boardCmdError"), "error");
    } catch (error) {
      if (hideUnsupportedFromError("led", error)) return;
      boardStatus(elements.boardLedStatus, error.message, "error");
    }
  });
  elements.boardLedQuery?.addEventListener("click", () => refreshBoardLed({ quiet: false }));

  elements.boardOptoClose?.addEventListener("click", () => boardOptoAction({ action: "on" }));
  elements.boardOptoOpen?.addEventListener("click", () => boardOptoAction({ action: "off" }));
  elements.boardOptoQuery?.addEventListener("click", () => refreshBoardOpto({ quiet: false }));
  elements.boardOptoPulse?.addEventListener("click", () =>
    boardOptoAction({ action: "pulse", ms: Number(elements.boardOptoPulseMs?.value) }));

  elements.boardIrSend?.addEventListener("click", sendBoardIrFrame);
  elements.boardIrQuery?.addEventListener("click", () => refreshBoardIr({ quiet: false }));

  elements.boardLearnStart?.addEventListener("click", startBoardLearn);
  elements.boardLearnStop?.addEventListener("click", stopBoardLearn);
  elements.boardSlotList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-board-action]");
    const row = button?.closest(".board-slot-row");
    if (!button || !row) return;
    const slot = Number(row.dataset.slot);
    const action = button.dataset.boardAction;
    if (action === "play") playBoardSlot(slot);
    else if (action === "delete") deleteBoardSlot(slot);
    else if (action === "rename") {
      state.board.editingSlot = slot;
      renderBoardSlots(state.board.lastSlots);
    } else if (action === "save-name") {
      saveBoardSlotName(slot, row.querySelector(".board-slot-input")?.value);
    } else if (action === "cancel-name") {
      state.board.editingSlot = null;
      renderBoardSlots(state.board.lastSlots);
    }
  });
  elements.boardSlotList?.addEventListener("keydown", (event) => {
    const input = event.target.closest(".board-slot-input");
    if (!input) return;
    const row = input.closest(".board-slot-row");
    if (event.key === "Enter") {
      event.preventDefault();
      saveBoardSlotName(Number(row.dataset.slot), input.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      state.board.editingSlot = null;
      renderBoardSlots(state.board.lastSlots);
    }
  });

  updateBoardIoControls();
}

/* -------------------------------------------------------------------------
 * Collapsible settings cards
 * ------------------------------------------------------------------------- */

const COLLAPSED_CARDS_KEY = "linkr-collapsed-cards";
let cardToggles = [];

function cardKey(card) {
  return card.id ||
    card.dataset.i18nAria ||
    card.getAttribute("aria-label") ||
    card.dataset.settingsPage ||
    "card";
}

function loadCollapsedCards() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_CARDS_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedCards() {
  const keys = cardToggles
    .filter((entry) => entry.card.classList.contains("is-collapsed"))
    .map((entry) => entry.key);
  saveSetting(COLLAPSED_CARDS_KEY, JSON.stringify(keys));
}

function updateCardToggle(entry) {
  const collapsed = entry.card.classList.contains("is-collapsed");
  entry.toggle.setAttribute("aria-expanded", String(!collapsed));
  const label = t(collapsed ? "expandCard" : "collapseCard");
  entry.toggle.title = label;
  entry.toggle.setAttribute("aria-label", label);
}

function setCardCollapsed(card, collapsed, { persist = true } = {}) {
  card.classList.toggle("is-collapsed", collapsed);
  const entry = cardToggles.find((candidate) => candidate.card === card);
  if (entry) updateCardToggle(entry);
  if (persist) saveCollapsedCards();
}

function refreshCardToggleLabels() {
  for (const entry of cardToggles) updateCardToggle(entry);
}

function initCollapsibleCards() {
  const collapsed = loadCollapsedCards();
  const cards = Array.from(document.querySelectorAll("#controlsPanel section.card"))
    .filter((card) => !card.matches("#agentSettings, #aboutPage"))
    .filter((card) => card.querySelector(":scope > .card-title"))
    /* MCP is appended after the first pass, so allow a second idempotent pass. */
    .filter((card) => !card.querySelector(":scope > .card-title > .card-toggle"));
  for (const card of cards) {
    const title = card.querySelector(":scope > .card-title");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "card-toggle";
    /* The chevron is drawn in CSS so section cards and native <details> cards
     * use the exact same glyph, weight, size and rotation. */
    title.append(toggle);
    card.classList.add("is-collapsible");
    const entry = { card, toggle, key: cardKey(card) };
    cardToggles.push(entry);
    toggle.addEventListener("click", () =>
      setCardCollapsed(card, !card.classList.contains("is-collapsed")));
    /* A native <details> header toggles anywhere on the summary; match it. */
    title.addEventListener("click", (event) => {
      if (event.target.closest("button, a, input, select, textarea")) return;
      setCardCollapsed(card, !card.classList.contains("is-collapsed"));
    });
    const isCollapsed = collapsed.has(entry.key);
    card.classList.toggle("is-collapsed", isCollapsed);
    updateCardToggle(entry);
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
  flushReadingPrefix(); serialPresentation.reset();
  if (connectionChanged) {
    shellIntegrationError = false;
    const featureDefault = unmanagedFeatureValue(connected, isWs, state.mgmtReady);
    for (const key of ["bonds", "led", "opto", "ir", "irLearn", "irName", "prompt", "bleName"]) {
      state.features[key] = featureDefault;
    }
    state.features.wifi = featureDefault === false ? false
      : connected && !isWs && state.mgmtReady
        ? hasManagementCapability(MGMT_CAP_WIFI) : null;
    state.features.webdav = featureDefault === false ? false
      : connected && !isWs && state.mgmtReady
        ? hasManagementCapability(MGMT_CAP_WEBDAV) : null;
    applyFeatureVisibility();
  }
  if (!connected) {
    clearInterval(serialControlTimer);
    serialControlTimer = null;
    serialControlPolling = false;
    state.serialControl = null;
    state.serialControlRevision++;
    serialControlPending = false;
  }
  state.writeGeneration += 1;
  state.uartWriteError = "";
  state.mgmtWriteError = "";
  serialInputRevision++;
  serialInputPending = false;
  state.connected = connected;
  if (connected) {
    state.board.slotNames = {};
    state.board.namesSupported = null;
    state.board.lastSlots = null;
    state.board.editingSlot = null;
    state.boardPromptBytes = 0;
  }
  if (connected && !isWs) state.bleReselectId = null;
  if (connected && !preserveJournal) agentJournal.reset();
  agentPanel?.connectionChanged(connected);
  agentSettings?.connectionChanged();
  renderShellIntegration();
  if (connectionChanged) {
    resetTerminalGeometrySync();
  }
  renderTerminalGeometryStatus();
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
  renderUartMode();
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
  updateBoardIoControls();
  if (connectionChanged) {
    stopBoardLearnPolling();
    /* Only read the board's own hardware when its panel is on screen: a user
     * who never opens the Board section should not pay four management
     * round-trips on every connect. */
    if (connected && elements.controls.dataset.settingsActive === "board") {
      refreshBoardIo();
    } else if (connected && settingsPanelOpen() &&
               elements.controls.dataset.settingsActive === "connection") {
      bondUi?.query();
    }
  }
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
  renderSerialControl();
  renderAutoReconnectStatus();
}

function rememberDevice(device, restored = false) {
  if (!device) {
    return;
  }
  state.device = device;
  state.deviceRestored = restored;
  state.bleReselectId = null;
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

function renderUartMode() {
  const ble = state.mode === "ble";
  const onlyNus = state.connected && state.uartReliableAvailable === false;
  elements.uartModeField.hidden = !ble || onlyNus;
  elements.uartModeSelect.value = state.uartMode;
  elements.uartModeHint.textContent = t(state.uartMode === "reliable"
    ? "uartModeReliableHint" : "uartModeInteractiveHint");
  elements.uartTransportStatus.hidden = !ble || !state.connected;
  if (!ble || !state.connected) {
    elements.uartTransportStatus.textContent = "";
    return;
  }
  const lines = [t(state.reliableReady ? "uartActiveReliable" : "uartActiveNus")];
  if (onlyNus) lines.push(t("uartNusOnly"));
  else if (state.uartFallback) lines.push(t("uartModeFallback"));
  if (state.uartSessionMode && state.uartMode !== state.uartSessionMode) {
    lines.push(t("uartModeNext"));
  }
  elements.uartTransportStatus.textContent = lines.join(lang === "zh" ? "；" : ". ");
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

async function writeBytes(bytes, sensitive = false, generation = state.writeGeneration, signal, revision = state.serialControlRevision) {
  assertWriteSession(generation, signal);
  assertSerialInput(revision);
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
    : Math.min(chunkSize(), 20);
  for (let offset = 0; offset < bytes.length; offset += size) {
    assertWriteSession(generation, signal);
    assertSerialInput(revision);
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
        await writeReliableUartChunk(chunk, generation, signal, revision);
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
      assertSerialInput(revision);
      state.txBytes += chunk.length;
    } catch (error) {
      if (state.uartWriteError && generation === state.writeGeneration) throw error;
      assertWriteSession(generation, signal);
      assertSerialInput(revision);
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
      await writeBytes(bytes, sensitive, generation, signal, revision);
      return;
    }
  }
  updateCounters();
}

function nextSequence(sequence) {
  return sequence === 0xffffffff ? 1 : sequence + 1;
}

async function writeReliableUartChunk(payload, generation = state.writeGeneration, signal, revision = state.serialControlRevision) {
  assertSerialInput(revision);
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

  /* A fragment shorter than the header can never start a frame; it is only a
   * size we learned from a previous short frame, and asking the peer to parse
   * it produces an ATT invalid-length error rather than useful data.
   *
   * Always use the 20-byte ATT-default payload. Probing a larger write first
   * is unsafe on a fresh link: the MTU exchange may still be in flight, the
   * stack refuses the oversized value before the firmware sees it, and a
   * platform whose error text does not say "length" leaves the whole session
   * latched as "delivery uncertain". A terminal frame is small, so the extra
   * writes cost nothing next to never recovering. */
  const minimumWrite = RELIABLE_UART_HEADER_SIZE + 1;
  const candidates = [Math.min(RELIABLE_UART_WRITE_START, frame.length)].filter(
    (size) => size >= minimumWrite,
  );
  let lastError;

  for (const attSize of candidates) {
    let writesCompleted = 0;
    let writesAttempted = 0;
    try {
      for (let offset = 0; offset < frame.length; offset += attSize) {
        assertWriteSession(generation, signal);
        assertSerialInput(revision);
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
      assertSerialInput(revision);
      state.reliableWriteSize = attSize;
      state.reliableTxSequence = nextSequence(sequence);
      return;
    } catch (error) {
      if (generation === state.writeGeneration && state.connected &&
          writesAttempted > 0 && (writesCompleted > 0 || !isAttSizeRejection(error))) {
        // An unfinished frame may consume the next command as its payload;
        // an unacknowledged complete frame may have advanced the peer sequence.
        // Preserve incoming logs but require a fresh session before any UART input.
        state.uartWriteError = `Reliable UART delivery is uncertain; disconnect and reconnect before sending more input. (${error?.message || error})`;
        throw new Error(state.uartWriteError, { cause: error });
      }
      assertWriteSession(generation, signal);
      assertSerialInput(revision);
      lastError = error;
      /* Explicit size rejection before the first fragment is safe to retry
       * with the next common ATT payload size. */
    }
  }
  throw lastError || new Error("Reliable UART write failed");
}

function enqueueBytes(bytes, sensitive = false, { generation = state.writeGeneration, signal, inputRevision, trackPending = true } = {}) {
  try { assertWriteSession(generation, signal); assertSerialInput(); } catch (error) { return Promise.reject(error); }
  if (inputRevision !== undefined && inputRevision !== serialInputRevision) {
    return Promise.reject(new Error("Terminal input changed; request a new command before sending."));
  }
  const ownershipRevision = state.serialControlRevision;
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
      await writeBytes(bytes, sensitive, generation, signal, ownershipRevision);
    } catch (error) {
      // A partially delivered line has unknown contents; Auto must ask next time.
      // Transport replies are not terminal input and must not latch the line.
      if (trackPending && generation === state.writeGeneration &&
          ownershipRevision === state.serialControlRevision) {
        serialInputPending = true;
        serialInputRevision++;
      }
      throw error;
    }
  });
  state.writeQueue = operation.catch(() => {});
  return operation;
}

async function writeText(text, options = {}) {
  if (options.claim !== false && state.serialControl && state.serialControl.mode !== "control") {
    const claimed = await claimIdleControl();
    if (!claimed) throw new Error(t("serialReadonlyError"));
  }
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
  if (terminalReplay || !data || (!canSerialInput() && !(userInput && canAttemptUserInput()))) {
    return;
  }
  if (!userInput) {
    // Replies and focus reports are transport data, not keystrokes. Preserve
    // armed modifiers and send these bytes without local echo or CR mapping.
    // They must not mark the terminal input line as pending: a program that
    // queries the terminal (DSR/DA/focus) would otherwise block tracked
    // commands and geometry sync until the user pressed Enter.
    writeText(data, { trackPending: false, claim: false }).catch((error) => appendLine(`[error] ${error.message}`));
    return;
  }
  terminalInputUntil = performance.now() + 1000;
  markTerminalBusy();
  // Typing is an explicit end to the selection: do not keep stale handles or a
  // stale copy snapshot around.
  hideTerminalSelectionHandles();
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

async function sendControl(command, { returnResponse = false, quiet = false } = {}) {
  if (state.serialControl && !canSerialInput() && !isReadonlyManagementCommand(command)) {
    throw new Error(t("serialReadonlyError"));
  }
  const sensitive = command.startsWith("@w=") || command.startsWith("@d=");
  if (!quiet) appendLine(
    `[control] ${sensitive ? `${command.slice(0, 2)}=<redacted>` : command}`,
  );
  if (state.mode !== "ble" || !state.mgmtReady) {
    throw new Error("Management characteristic is not ready");
  }
  if (state.mgmtWriteError) throw new Error(state.mgmtWriteError);
  const generation = state.writeGeneration;
  const ownershipRevision = state.serialControlRevision;
  const requiresControl = !isReadonlyManagementCommand(command);
  const checkOwnership = () => {
    if (requiresControl && state.serialControl) assertSerialInput(ownershipRevision);
  };
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
    checkOwnership();
    if (state.mgmtWriteError) throw new Error(state.mgmtWriteError);
    if (!state.connected || !state.mgmtReady || !state.device) {
      throw new Error("Management characteristic is not ready");
    }
    const response = responses.wait(requestId);
    let writesCompleted = 0;
    let writesAttempted = 0;
    /* The first GATT write must contain the complete 12-byte management
     * header, and a new ATT link starts at 23 bytes (20 payload) until the
     * MTU exchange finishes. A learned or user-configured larger chunk size
     * can therefore be refused on the first frame, which surfaces as a
     * management write that "may or may not" have arrived. Management frames
     * are small: always segment at the default payload so no command depends
     * on the timing of the MTU exchange. */
    try {
      const size = 20;
      for (let offset = 0; offset < frame.length; offset += size) {
        assertWriteSession(generation);
        checkOwnership();
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
        state.mgmtWriteError = `Management delivery is uncertain; disconnect and reconnect before sending more settings commands. (${error?.message || error})`;
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
  const controlMessage = consumeSerialControl(text);
  if (!controlMessage) feedManagementText(text);
  for (const line of text.split(/\r?\n/)) {
    if (line && !controlMessage) {
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
  rawLog.append(bytes);
  state.rxBytes += bytes.length;
  updateCounters();
  const text = rxDecoder.decode(bytes, { stream: true });
  if (terminalSessionTracker.push(text)) invalidateTerminalGeometrySync();
  if (elements.debugInput.checked) {
    appendLine(`RX ${bytes.length}: ${JSON.stringify(text)}`);
  }
  const reading = serialPresentation.push(bytes);
  readingLog.append(reading); rawDisplay.append(bytes); readingDisplay.append(reading);
  queueTerminalOutput(state.logView === "raw" ? bytes : reading);
  scheduleShellIntegrationRender();
}

function onDisconnected({ unexpected = false } = {}) {
  bleNotificationSession = null;
  bleUartNotificationSession = null;
  state.uartSessionMode = null;
  state.uartReliableAvailable = null;
  state.uartFallback = false;
  const wasConnected = state.connected;
  const manual = userInitiatedDisconnect;
  userInitiatedDisconnect = false;
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
  state.reliableWriteSize = RELIABLE_UART_WRITE_START;
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
  /* Only a link that had been up and was not hung up by the user is a lost
   * link worth redialling. A failure during a connection attempt lands here
   * too (transportConnected teardown), but state.connected is already false. */
  if (unexpected && wasConnected && !manual) scheduleAutoReconnect();
}

function autoReconnectTargetAvailable() {
  if (state.mode === "ws") return Boolean(elements.wsHostInput.value.trim());
  return Boolean(state.device);
}

function reconnectStatusText() {
  const total = reconnectDelays().length;
  if (!autoReconnect.nextAt) {
    return t("reconnectDialing")
      .replace("{n}", String(autoReconnect.attempts))
      .replace("{total}", String(total));
  }
  const seconds = Math.max(
    0,
    Math.ceil((autoReconnect.nextAt - Date.now()) / 1000),
  );
  return t("reconnectWaiting")
    .replace("{s}", String(seconds))
    .replace("{n}", String(autoReconnect.attempts + 1))
    .replace("{total}", String(total));
}

function renderAutoReconnectStatus() {
  if (!autoReconnect.active) return;
  const text = reconnectStatusText();
  elements.statusText.textContent = text;
  if (elements.connStateText) elements.connStateText.textContent = text;
  const cancelLabel = t("reconnectCancel");
  for (const button of [elements.connectButton, elements.mobileConnectBtn]) {
    if (!button) continue;
    button.disabled = false;
    button.classList.remove("loading");
    const label = button.querySelector(".btn-label");
    if (label) label.textContent = cancelLabel;
  }
}

function stopAutoReconnectTicker() {
  if (autoReconnect.ticker) clearInterval(autoReconnect.ticker);
  autoReconnect.ticker = null;
}

function stopAutoReconnectTimer() {
  if (autoReconnect.timer) clearTimeout(autoReconnect.timer);
  autoReconnect.timer = null;
}

function cancelAutoReconnect(reason, { silent = false, refresh = true } = {}) {
  if (!autoReconnect.active && !autoReconnect.timer) return false;
  stopAutoReconnectTimer();
  stopAutoReconnectTicker();
  autoReconnect.active = false;
  const controller = autoReconnect.controller;
  autoReconnect.controller = null;
  controller?.abort();
  // Retire partial subscriptions, pending management requests and input now,
  // even if a native connect call must finish before its transport can close.
  if (controller) onDisconnected();
  autoReconnect.attempts = 0;
  autoReconnect.nextAt = 0;
  if (!silent) appendLine(`[reconnect] ${reason || t("reconnectCancelled")}`);
  if (refresh) {
    setConnecting(false);
    refreshDynamicTexts();
  }
  return true;
}

function autoReconnectGaveUp() {
  const total = reconnectDelays().length;
  const text = t("reconnectGaveUp").replace("{total}", String(total));
  stopAutoReconnectTimer();
  stopAutoReconnectTicker();
  autoReconnect.active = false;
  autoReconnect.attempts = 0;
  autoReconnect.nextAt = 0;
  appendLine(`[reconnect] ${text}`);
  toast(text, "error");
  setConnecting(false);
  refreshDynamicTexts();
}

async function attemptAutoReconnect(index) {
  if (!autoReconnect.active) return;
  const delays = reconnectDelays();
  if (index >= delays.length) {
    autoReconnectGaveUp();
    return;
  }
  autoReconnect.attempts = index + 1;
  autoReconnect.nextAt = 0;
  stopAutoReconnectTicker();
  renderAutoReconnectStatus();
  if (!autoReconnectTargetAvailable()) {
    autoReconnectGaveUp();
    return;
  }
  const controller = new AbortController();
  autoReconnect.controller = controller;
  try {
    await connect({ signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) appendLine(`[reconnect] ${error.message}`);
  }
  if (autoReconnect.controller !== controller || !autoReconnect.active) return;
  autoReconnect.controller = null;
  if (state.mode === "ble" && state.bleReselectId) {
    autoReconnect.active = false;
    setConnecting(false);
    refreshDynamicTexts();
    return;
  }
  if (lastConnectFailure?.pairing) {
    /* The Bee refuses pairing until its key is pressed, so dialling again can
     * never recover the link. Stop here and leave the Connect button to the
     * user; the pairing hint shown by the failed attempt is the instruction. */
    autoReconnect.active = false;
    autoReconnect.attempts = 0;
    autoReconnect.nextAt = 0;
    stopAutoReconnectTimer();
    stopAutoReconnectTicker();
    appendLine(`[reconnect] ${t("reconnectPausedForPairing")}`);
    setConnecting(false);
    refreshDynamicTexts();
    return;
  }
  if (state.connected) {
    autoReconnect.active = false;
    autoReconnect.attempts = 0;
    autoReconnect.nextAt = 0;
    stopAutoReconnectTicker();
    appendLine(`[reconnect] ${t("reconnectRestored")}`);
    toast(t("reconnectRestored"));
    setConnecting(false);
    refreshDynamicTexts();
    return;
  }
  scheduleNextAutoReconnect(autoReconnect.attempts);
}

function startAutoReconnectTicker() {
  stopAutoReconnectTicker();
  autoReconnect.ticker = setInterval(() => {
    if (!autoReconnect.active) {
      stopAutoReconnectTicker();
      return;
    }
    renderAutoReconnectStatus();
  }, 500);
}

function scheduleNextAutoReconnect(index) {
  const delays = reconnectDelays();
  if (!autoReconnect.active) return;
  if (index >= delays.length) {
    autoReconnectGaveUp();
    return;
  }
  autoReconnect.nextAt = Date.now() + delays[index];
  autoReconnect.timer = setTimeout(() => {
    autoReconnect.timer = null;
    void attemptAutoReconnect(index);
  }, delays[index]);
  startAutoReconnectTicker();
  renderAutoReconnectStatus();
}

function scheduleAutoReconnect() {
  if (autoReconnect.active || autoReconnect.timer) return;
  if (!autoReconnectTargetAvailable()) return;
  autoReconnect.active = true;
  autoReconnect.attempts = 0;
  autoReconnect.nextAt = 0;
  appendLine(`[reconnect] ${t("reconnectLost")}`);
  scheduleNextAutoReconnect(0);
}

function connectWs(signal) {
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
      signal?.removeEventListener("abort", abortConnect);
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
    const abortConnect = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (state.ws === ws) state.ws = null;
      ws.close();
      reject(signal.reason || new DOMException("Connection cancelled", "AbortError"));
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
    signal?.addEventListener("abort", abortConnect, { once: true });
    if (signal?.aborted) { abortConnect(); return; }

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
        if (!consumeSerialControl(event.data)) handleIncomingBytes(encoder.encode(event.data));
      }
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      if (opened) {
        onDisconnected({ unexpected: true });
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

function connectManually() {
  // Only a fresh user click may open the chooser. Background retries never do.
  return connect({ reselectId: state.mode === "ble" ? state.bleReselectId : null });
}

async function connect({ chooseDevice = false, reselectId = null, signal } = {}) {
  signal?.throwIfAborted();
  if (connectionInFlight || state.connected) return;
  userInitiatedDisconnect = false;
  connectionInFlight = true;
  try {
    await connectOnce({ chooseDevice, reselectId, signal });
  } finally {
    connectionInFlight = false;
    setConnecting(false);
  }
}

/* A pre-Management-Service board still speaks the plain Nordic UART Service.
 * Subscribe to its notify characteristic and mark the session terminal-only:
 * every accessory control is gated on `state.mgmtReady`, so none of them will
 * try to send a management frame the old firmware cannot answer. */
async function adoptLegacyNus(device, signal) {
  signal?.throwIfAborted();
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
      if (signal?.aborted || bleNotificationSession !== notificationSession) return;
      const bytes = new Uint8Array(
        value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ),
      );
      handleIncomingBytes(bytes);
    },
  );
  signal?.throwIfAborted();
  state.legacy = true;
  state.uartReliableAvailable = false;
  state.uartFallback = state.uartSessionMode === "reliable";
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

/* Choose once per BLE session. A UI preference change never interrupts an
 * in-flight frame or replays queued input on another UART characteristic. */
async function subscribeBleUart(device, signal, notificationSession) {
  const validSession = () => {
    signal?.throwIfAborted();
    if (bleNotificationSession !== notificationSession) {
      throw new Error("Bluetooth device session changed");
    }
  };
  const available = hasManagementCapability(MGMT_CAP_RELIABLE_UART);
  state.uartReliableAvailable = available;
  const plan = uartTransportPlan(state.uartSessionMode, { reliable: available });
  let lastError;
  for (const channel of plan) {
    validSession();
    const token = {};
    bleUartNotificationSession = token;
    state.nusReady = state.reliableReady = false;
    const reliable = channel === "reliable";
    const service = reliable ? RELIABLE_UART_SERVICE : NUS_SERVICE;
    const tx = reliable ? RELIABLE_UART_TX : NUS_TX;
    const accepts = () => !signal?.aborted &&
      bleNotificationSession === notificationSession && bleUartNotificationSession === token;
    try {
      if (reliable) {
        const value = await bleTransport.read(device.id, RELIABLE_UART_SERVICE, RELIABLE_UART_STATE);
        validSession();
        if (value.byteLength !== 16 || value.getUint8(0) !== 1 ||
            value.getUint16(2, true) === 0 || value.getUint32(4, true) === 0 ||
            value.getUint32(8, true) === 0) {
          throw new Error("Invalid Reliable UART state");
        }
        reliableReassembler.reset();
        state.reliableMaxPayload = Math.min(value.getUint16(2, true),
          BLE_MAX_ATT_VALUE - RELIABLE_UART_HEADER_SIZE);
        state.reliableWriteSize = RELIABLE_UART_WRITE_START;
        state.reliableTxSequence = value.getUint32(4, true);
        state.reliableRxSequence = value.getUint32(8, true);
        state.reliableRxDesync = false;
      }
      await bleTransport.startNotifications(device.id, service, tx, value => {
        if (!accepts()) return;
        if (reliable) onReliableUartIndication(value);
        else handleIncomingBytes(new Uint8Array(value.buffer.slice(
          value.byteOffset, value.byteOffset + value.byteLength)));
      });
      validSession();
      state.reliableReady = reliable;
      state.nusReady = !reliable;
      state.uartFallback = channel !== (normalizeUartMode(state.uartSessionMode) === "reliable" ? "reliable" : "nus");
      if (state.uartFallback) appendLine(`[warn] ${t("uartModeFallback")}`);
      return;
    } catch (error) {
      // A failed subscription may already have installed a callback. Retire
      // it before trying the other channel so late packets cannot duplicate RX.
      if (bleNotificationSession !== notificationSession || bleUartNotificationSession !== token) {
        throw error; // A retired attempt must not unsubscribe the next device.
      }
      bleUartNotificationSession = null;
      try { await bleTransport.stopNotifications(device.id, service, tx); }
      catch { /* A missing characteristic may have failed before subscribing. */ }
      validSession();
      lastError = error;
    }
  }
  throw lastError || new Error("No UART transport available");
}

async function connectOnce({ chooseDevice = false, reselectId = null, signal } = {}) {
  signal?.throwIfAborted();
  /* Every attempt starts without a failure class; the catch below records one
   * so automatic reconnect can tell a pairing refusal from a lost link. */
  lastConnectFailure = null;
  if (state.mode === "ws") {
    setConnecting(true);
    try {
      await connectWs(signal);
    } catch (error) {
      if (signal?.aborted) return;
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
  state.uartSessionMode = state.uartMode;
  state.uartReliableAvailable = null;
  state.uartFallback = false;
  const restoredAttempt = Boolean(!chooseDevice && !reselectId && state.device && state.deviceRestored);
  let device = chooseDevice || reselectId ? null : state.device;
  let transportConnected = false;
  let pairingAttempted = false;
  try {
    await bleTransport.initialize();
    signal?.throwIfAborted();
    if (!device) {
      appendLine(`[scan] requesting a Linkr Bee device`);
      const selectedDevice = await bleTransport.requestDevice({
        filters: BLE_REQUEST_FILTERS,
        optionalServices: [MGMT_SERVICE, NUS_SERVICE, RELIABLE_UART_SERVICE],
      });
      signal?.throwIfAborted();
      if (reselectId && selectedDevice.id !== reselectId) {
        throw new Error(t("bleReselectMismatch"));
      }
      device = selectedDevice;
      rememberDevice(device);
    }

    appendLine(`[pairing] ${t("pairingHint")}`);
    appendLine(`[connect] ${printableDeviceName(device.name, device.id)}`);
    pairingAttempted = true;
    await bleTransport.connect(device.id, () => {
      if (!signal?.aborted) onDisconnected({ unexpected: true });
    }, { signal });
    transportConnected = true;
    signal?.throwIfAborted();
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
      /* Only a missing service identifies legacy firmware. Other failures
       * retain their original cause: an encrypted read can time out or lose
       * its link without pairing having been refused. */
      if (!isMissingService(error)) throw error;
      await adoptLegacyNus(device, signal);
      return;
    }
    signal?.throwIfAborted();
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
      throw new Error("Device does not advertise a UART transport");
    }
    const deviceIdValue = await bleTransport.read(
      device.id,
      MGMT_SERVICE,
      MGMT_DEVICE_ID,
    );
    signal?.throwIfAborted();
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
        if (!signal?.aborted && bleNotificationSession === notificationSession) onManagementIndication(value);
      },
    );
    signal?.throwIfAborted();
    state.mgmtReady = true;
    await subscribeBleUart(device, signal, notificationSession);
    state.legacy = false;
    state.deviceRestored = false;
    if (hasManagementCapability(MGMT_CAP_MULTI_SESSION)) {
      state.serialControl = { mode: "readonly", epoch: 0, peers: 1, owner: 0, self: 0 };
    }
    setConnected(true, { preserveJournal: true });
    if (state.serialControl) {
      await requestSerialControl();
      signal?.throwIfAborted();
      if (state.serialControl.mode === "available") await requestSerialControl("claim");
      signal?.throwIfAborted();
      startSerialControlPoll();
    }
    appendLine(`[ready] API v${protocolValue.getUint8(0)}.${protocolValue.getUint8(1)} device=${state.deviceId} transport=${state.reliableReady ? "RELIABLE" : "NUS"} build=${APP_BUILD}`);
    requestDeviceState().catch((error) =>
      appendLine(`[error] ${error.message}`),
    );
    readBleName({ quiet: true });
    // Labels are cosmetic: enqueue only after the ownership handshake, never
    // from render() or while a setting is being checked for a handover.
    bondUi?.reportHostName();
  } catch (error) {
    if (!signal?.aborted) appendLine(`[error] ${error.message}`);
    const needsReselect = error.code === "BLE_RESELECT_REQUIRED";
    const pairingFailure = pairingRefused(error);
    lastConnectFailure = pairingFailure ? { pairing: true } : null;
    if (needsReselect && device && !signal?.aborted) {
      state.bleReselectId = device.id;
      appendLine(`[reconnect] ${t("bleReselectHint")}`);
      toast(t("bleReselectHint"), "error");
    }
    if (pairingAttempted && !signal?.aborted && !needsReselect && pairingFailure) {
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
    if (restoredAttempt && !signal?.aborted && !needsReselect) {
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
  cancelAutoReconnect(t("reconnectCancelled"), { silent: true });
  userInitiatedDisconnect = true;
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
    if (state.nusReady && state.device) {
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

function replayTerminalView() {
  replayRevision++;
  if (!state.term || terminalReplay) return;
  clearTerminalGeometrySyncTimer();
  flushTerminalWrites();
  terminalReplay = true;
  const disabled = state.term.options.disableStdin;
  state.term.options.disableStdin = true;
  elements.terminalOutput.setAttribute("aria-busy", "true");
  function render() {
    const revision = replayRevision;
    const bytes = (state.logView === "raw" ? rawDisplay : readingDisplay).read();
    replayTail = []; replayTailBytes = 0;
    state.term.write("", () => {
      if (revision !== replayRevision) { render(); return; }
      state.term.reset(); state.term.options.disableStdin = true;
      state.term.write(bytes, () => {
        if (revision !== replayRevision || replayTailBytes > WRITE_BACKLOG_LIMIT) { render(); return; }
        const tail = replayTail; replayTail = []; replayTailBytes = 0;
        terminalReplay = false; state.term.options.disableStdin = disabled;
        elements.terminalOutput.removeAttribute("aria-busy");
        // Only the retained snapshot is historical. Live bytes arriving during
        // replay go through normal parsing once, after protocol replies unlock.
        for (const chunk of tail) queueTerminalOutput(chunk);
        renderShellIntegration();
      });
    });
  }
  render();
}

function setLogView(value) {
  flushReadingPrefix();
  state.logView = value === "raw" ? "raw" : "reading";
  elements.logViewSelect.value = state.logView;
  saveSetting("linkr-log-view", state.logView);
  replayTerminalView();
}

function clearTerminalOutput() {
  serialPresentation.reset(); readingLog.clear(); rawDisplay.clear(); readingDisplay.clear();
  if (writeRaf) cancelAnimationFrame(writeRaf);
  if (writeFallbackTimer) clearTimeout(writeFallbackTimer);
  writeRaf = writeFallbackTimer = 0; pendingWrites = []; pendingWriteBytes = droppedWriteBytes = 0;
  if (!state.term) { elements.terminalOutput.replaceChildren(); return; }
  replayTerminalView();
}

let shellIntegrationBusy = false;
let shellIntegrationError = false;
let shellIntegrationRenderTimer = null;
function scheduleShellIntegrationRender() {
  if (shellIntegrationRenderTimer !== null || elements.controls.dataset.settingsActive !== "terminal" ||
      elements.controlsPanel.getAttribute("aria-hidden") === "true") return;
  shellIntegrationRenderTimer = setTimeout(() => {
    shellIntegrationRenderTimer = null;
    renderShellIntegration();
  }, 100);
}
function renderShellIntegration() {
  const device = agentPanel?.getDevice();
  if (!device) return;
  const status = device.getStatus();
  const ready = status.shellIntegration.status === "ready";
  elements.shellIntegrationEnable.disabled = shellIntegrationBusy || ready || !state.connected || !canSerialInput() ||
    terminalReplay || status.inputPending || status.console.kind !== "shell" || device.needsObservation() || agentPanel.isBusy();
  elements.shellIntegrationDisable.disabled = shellIntegrationBusy || !ready;
  elements.shellIntegrationStatus.textContent = t(shellIntegrationBusy ? "shellIntegrationEnabling" : ready ? "shellIntegrationReady" :
    shellIntegrationError ? "shellIntegrationFailed" : device.needsObservation() ? "shellIntegrationPending" : "shellIntegrationDisabled");
}
async function enableShellIntegration() {
  const device = agentPanel.getDevice();
  const controller = new AbortController();
  const session = state.writeGeneration;
  let record;
  shellIntegrationBusy = true; shellIntegrationError = false; renderShellIntegration();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    record = await device.enableShellIntegration(controller.signal);
    while (!record.observationClosed && state.connected && session === state.writeGeneration && !controller.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 100));
      record = device.inspectExecution(record.id);
    }
    if (record.executionStatus !== "completed" || session !== state.writeGeneration) throw new Error("Shell handshake unconfirmed");
  } catch (error) {
    if (record) device.expireShellIntegration(record.id);
    else device.disableShellIntegration();
    shellIntegrationError = state.connected && session === state.writeGeneration;
    if (shellIntegrationError) toast(t("shellIntegrationFailed"), true);
  } finally {
    clearTimeout(timer);
    shellIntegrationBusy = false;
    renderShellIntegration();
  }
}

function saveLog(view = state.logView) {
  flushReadingPrefix();
  const raw = view === "raw";
  const chunks = [(raw ? rawLog : readingLog).read()];
  const blob = new Blob(chunks, { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `linkr-ble-${raw ? "raw" : "reading"}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(t("saved"));
}

function loadPersisted() {
  state.logView = localStorage.getItem("linkr-log-view") === "raw" ? "raw" : "reading";
  elements.logViewSelect.value = state.logView;
  state.uartMode = normalizeUartMode(localStorage.getItem(UART_MODE_KEY));
  renderUartMode();
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

function softKeyboardIsVisible() {
  if (!terminalHasFocus()) {
    return false;
  }
  // A focused hidden textarea does not mean the IME is showing: Android lets
  // the user dismiss the keyboard with its own hide button while the textarea
  // keeps focus. On touch devices the visual viewport is the only truth.
  if (coarsePointerMedia.matches || isHarmonyHost) {
    return softKeyboardLayout.active;
  }
  return true;
}

function syncKeyboardButtonState() {
  elements.focusTerminalButton?.setAttribute(
    "aria-pressed",
    String(softKeyboardIsVisible()),
  );
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
  if (active) terminalKeyPreferences?.collapse();
  document.documentElement.classList.toggle("soft-keyboard-open", active);
  // The button must follow the keyboard the user actually sees, including a
  // keyboard dismissed from Android's own hide button.
  syncKeyboardButtonState();
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
    requestAnimationFrame(() => {
      // A fast click/keystroke may already have focused a field while the
      // drawer was opening. Do not redirect that input to the close button.
      if (elements.appShell.classList.contains("sidebar-open") &&
          !elements.controlsPanel.contains(document.activeElement)) {
        elements.drawerClose.focus({ preventScroll: true });
      }
    });
  } else if (
    restoreToggle &&
    !drawerOpen &&
    document.activeElement !== returnButton
  ) {
    requestAnimationFrame(() => returnButton.focus({ preventScroll: true }));
  }
}

/* Paired devices live in Connection now: read them when that page is actually
 * on screen, not merely as a side effect of opening the management channel. */
function refreshVisibleSettingsPage() {
  if (!state.board.canControl) return;
  if (elements.controls.dataset.settingsActive === "connection") bondUi?.query();
}

function settingsPanelOpen() {
  return usesSettingsDrawer()
    ? elements.appShell.classList.contains("sidebar-open")
    : !elements.appShell.classList.contains("controls-hidden");
}

function setMobileSidebarOpen(open, { restoreFocus = true } = {}) {
  if (!usesSettingsDrawer()) {
    return;
  }
  if (open) {
    // Close the IME before the drawer slides in. Otherwise the keyboard resize
    // and the terminal refit underneath run during the slide and make it stutter.
    state.term?.blur();
    // The selection dots float above the terminal; they must not sit on top of
    // the drawer.
    hideTerminalSelectionHandles();
  }
  elements.appShell.classList.toggle("sidebar-open", open);
  syncSidebarAccessibility({
    focusDrawer: open,
    restoreToggle: !open && restoreFocus,
  });
  if (open) refreshVisibleSettingsPage();
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
    if (!hidden) refreshVisibleSettingsPage();
  }
}

function openAgentSettings() {
  setSettingsPage("ai");
  hideTerminalSelectionHandles();
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
  const wanted = ["connection", "terminal", "network", "board", "about",
    ...(agentSettings ? ["ai"] : [])].includes(page) ? page : "connection";
  const wantedTab = document.querySelector(`.settings-tab[data-settings-target="${wanted}"]`);
  const next = wantedTab && !wantedTab.hidden ? wanted : "connection";
  elements.controls.dataset.settingsActive = next;
  if (next === "terminal") renderShellIntegration();
  if (next === "board" && state.board.canControl) {
    refreshBoardIo();
  } else if (next === "connection" && state.board.canControl) {
    bondUi?.query();
  } else if (next === "ai" && state.board.canControl) {
    refreshBoardPromptStatus();
  }
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
    if (autoReconnect.active) {
      cancelAutoReconnect(t("reconnectCancelled"));
      toast(t("reconnectCancelled"));
      return;
    }
    connectManually().catch((error) => appendLine(`[error] ${error.message}`));
  });

  if (elements.mobileConnectBtn) {
    elements.mobileConnectBtn.addEventListener("click", () => {
      if (autoReconnect.active) {
        cancelAutoReconnect(t("reconnectCancelled"));
        toast(t("reconnectCancelled"));
        return;
      }
      const action = state.connected ? disconnect() : connectManually();
      action.catch((error) => appendLine(`[error] ${error.message}`));
    });
  }

  elements.disconnectButton.addEventListener("click", () => {
    disconnect().catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.switchDeviceButton.addEventListener("click", () => {
    cancelAutoReconnect(t("reconnectCancelled"), { silent: true });
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
    rawLog.clear();
    agentJournal.reset();
    agentPanel?.logsCleared();
    toast(t("cleared"));
  });

  elements.saveButton.addEventListener("click", () => saveLog());
  elements.logViewSelect.addEventListener("change", () => setLogView(elements.logViewSelect.value));
  elements.saveReadingLog.addEventListener("click", () => saveLog("reading"));
  elements.saveRawLog.addEventListener("click", () => saveLog("raw"));
  elements.shellIntegrationEnable.addEventListener("click", () => enableShellIntegration());
  elements.shellIntegrationDisable.addEventListener("click", () => {
    agentPanel.getDevice().disableShellIntegration(); shellIntegrationError = false; renderShellIntegration();
  });

  // Keep the terminal textarea focused when a pointer activates an accessory
  // key. Focus synchronously on click so iOS can retain/open its soft keyboard.
  elements.terminalKeyBar.addEventListener("pointerdown", (event) => {
    // A key press is an explicit input action. Drop the scroll/long-press
    // focus guard before the button handlers below run.
    releaseTerminalFocusSuppression();
    if (event.target.closest("button")) event.preventDefault();
  }, true);
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
    releaseTerminalFocusSuppression();
    if (softKeyboardIsVisible()) {
      state.term?.blur();
      elements.focusTerminalButton.setAttribute("aria-pressed", "false");
    } else if (terminalHasFocus()) {
      // The IME was dismissed with its own hide button while the textarea kept
      // focus. Calling focus() again would be a no-op, so cycle the focus.
      state.term?.blur();
      window.setTimeout(() => {
        state.term?.focus();
      }, 40);
    } else {
      state.term?.focus();
    }
    syncKeyboardButtonState();
    window.setTimeout(syncKeyboardButtonState, 350);
  });
  elements.terminalOutput.addEventListener("focusin", syncKeyboardButtonState);
  elements.terminalOutput.addEventListener("focusout", () => {
    window.requestAnimationFrame(syncKeyboardButtonState);
  });

  // A scroll or long press can make Android WebView focus the hidden textarea
  // after our touchend handler. Reject that focus until the next touch starts.
  elements.terminalOutput.addEventListener("focusin", (event) => {
    if (!terminalFocusSuppressed()) {
      return;
    }
    event.stopPropagation();
    if (event.target instanceof HTMLElement) {
      event.target.blur();
    }
  }, true);
  for (const type of ["mousedown", "mouseup", "click"]) {
    elements.terminalOutput.addEventListener(type, (event) => {
      if (!terminalTouch.suppressClick) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }

  elements.terminalOutput.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") {
      // xterm focuses its hidden textarea from pointerdown, which opens the
      // keyboard before we know whether this is a scroll, long press or tap.
      // A confirmed tap focuses after touchend instead.
      event.stopPropagation();
    }
  }, true);
  elements.terminalOutput.addEventListener("pointerdown", (event) => {
    // Touch taps are handled after touchend, so a scroll or long press does
    // not focus the hidden textarea and pop the keyboard open.
    if (!state.connected || event.pointerType === "touch") {
      return;
    }
    releaseTerminalFocusSuppression();
    window.requestAnimationFrame(() => state.term?.focus());
  });
  elements.terminalOutput.addEventListener("touchstart", onTerminalTouchStart, {
    passive: true,
  });
  elements.terminalOutput.addEventListener("touchmove", onTerminalTouchMove, {
    passive: false,
  });
  elements.terminalOutput.addEventListener("touchend", finishTerminalTouch, {
    passive: false,
  });
  elements.terminalOutput.addEventListener("touchcancel", onTerminalTouchCancel, {
    passive: false,
  });
  elements.terminalOutput.addEventListener("contextmenu", (event) => {
    // A long press selects text through xterm; suppress the WebView's native
    // canvas menu, which cannot copy the DOM-rendered terminal anyway. Some
    // WebViews swallow the touch timer and only signal the hold through this
    // event, so use it as a backup for the selection gesture. In a browser,
    // leave the native copy/paste menu alone.
    if (!nativeSelectionShell) {
      return;
    }
    if (!coarsePointerMedia.matches && event.pointerType !== "touch") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const x = event.clientX || terminalTouch.startX;
    const y = event.clientY || terminalTouch.startY;
    if (beginTerminalLongPress(x, y)) {
      suppressTerminalFocus(1200);
    }
  });
  elements.terminalOutput.addEventListener("selectstart", (event) => {
    // The WebView would start its own selection over the rendered rows and
    // take the gesture away from the xterm selection the app drives. A
    // browser's native selection is the one the user expects, so keep it.
    if (nativeSelectionShell && coarsePointerMedia.matches) {
      event.preventDefault();
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

  wireBoardIoControls();
  wireBoardPromptControls();

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
  elements.copyBtn.addEventListener("pointerdown", (event) => {
    // Copying must not blur the terminal and close the keyboard.
    event.preventDefault();
  });
  elements.copyBtn.addEventListener("click", () => {
    if (!state.term) {
      return;
    }
    // Copy only a live selection or the snapshot taken for it. A tap with
    // nothing selected must not paste an unrelated whole-screen transcript.
    const text = terminalCopyText();
    if (!text) {
      toast(t("copyFailed"), "error");
      return;
    }
    copyToClipboard(text).then(
      (copied) => toast(t(copied ? "copied" : "copyFailed"), copied ? undefined : "error"),
      () => toast(t("copyFailed"), "error"),
    );
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

  elements.uartInput.addEventListener("change", () => {
    saveSetting("linkr-uart", elements.uartInput.value.trim());
    updateBaudLabel();
  });
  elements.enterSelect.addEventListener("change", () =>
    saveSetting("linkr-enter", elements.enterSelect.value),
  );
  elements.uartModeSelect.addEventListener("change", () => {
    state.uartMode = normalizeUartMode(elements.uartModeSelect.value);
    saveSetting(UART_MODE_KEY, state.uartMode);
    renderUartMode();
  });
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

/* ---- Linkr Bee board lifecycle + identity (MCP) ----
 *
 * These helpers only drive the app's own connection path (rememberDevice,
 * connect, disconnect, sendControl), so the MCP tools never open a second BLE
 * session or a second management channel. They are Android-only in practice:
 * the agent settings panel never sees them and the bridge is only installed by
 * the Android shell. */

function beeConnectionStatus() {
  const isLan = state.mode === "ws";
  const capability = !isLan && state.mgmtReady
    ? {
      available: true,
      wifi: hasManagementCapability(MGMT_CAP_WIFI),
      webdav: hasManagementCapability(MGMT_CAP_WEBDAV),
      asyncEvents: hasManagementCapability(MGMT_CAP_ASYNC_EVENTS),
    }
    : { available: false, wifi: false, webdav: false, asyncEvents: false };
  const device = state.device;
  return {
    connected: state.connected,
    transport: isLan ? "lan" : "ble",
    device: isLan
      ? printableDeviceName(state.wsHost, "")
      : printableDeviceName(device?.name, device?.id || ""),
    deviceId: isLan ? (state.wsHost || "") : (state.deviceId || device?.id || ""),
    legacy: Boolean(state.legacy),
    management: capability,
    savedDeviceId: localStorage.getItem(LAST_DEVICE_ID_KEY) || null,
  };
}

/* Board identity is best effort: a legacy board has no management channel, and
 * a query that times out must not fail get_bee_status as a whole. */
async function readBeeIdentity({ signal } = {}) {
  const identity = { bleName: null, bleNameCustom: null, lanBridge: null, identityError: null };
  if (state.mode !== "ble" || !state.connected || !state.mgmtReady) return identity;
  try {
    const parsed = parseBleName(
      String((await sendControl(BLE_NAME_QUERY_COMMAND, { returnResponse: true })) ?? ""),
      { query: true },
    );
    if (parsed) {
      identity.bleName = parsed.name;
      identity.bleNameCustom = parsed.custom;
    }
  } catch (error) {
    identity.identityError = error?.message || "The BLE name could not be read.";
  }
  try {
    identity.lanBridge = parseLanBridge(
      String((await sendControl(LAN_BRIDGE_QUERY_COMMAND, { returnResponse: true })) ?? ""),
    );
  } catch {
    // The bridge may not support @s?; the rest of the status is still useful.
  }
  signal?.throwIfAborted();
  return identity;
}

async function beeStatus({ signal } = {}) {
  signal?.throwIfAborted();
  const status = beeConnectionStatus();
  Object.assign(status, await readBeeIdentity({ signal }));
  return status;
}

async function scanBeeDevices({ durationMs = 6000, signal } = {}) {
  signal?.throwIfAborted();
  if (state.mode !== "ble") {
    throw new Error("Switch the app to Bluetooth LE mode before scanning for Linkr Bee boards.");
  }
  if (state.connected) {
    throw new Error("Disconnect from the current Linkr Bee board before scanning for another one.");
  }
  if (!bleTransport || typeof bleTransport.scanDevices !== "function") {
    throw new Error("Bluetooth scanning is not available in this build.");
  }
  await bleTransport.initialize();
  const devices = await bleTransport.scanDevices({
    services: [MGMT_SERVICE],
    durationMs: Math.max(1000, Math.min(15000, Number(durationMs) || 6000)),
  });
  signal?.throwIfAborted();
  return (Array.isArray(devices) ? devices : [])
    .filter((device) => device && device.id)
    .map((device) => ({
      deviceId: String(device.id),
      name: printableDeviceName(device.name, ""),
      rssi: Number.isFinite(device.rssi) ? device.rssi : null,
    }))
    .slice(0, 40);
}

async function connectBee({ deviceId, name, signal } = {}) {
  signal?.throwIfAborted();
  cancelAutoReconnect(t("reconnectCancelled"), { silent: true });
  if (state.connected) {
    throw new Error("The app is already connected to a Linkr Bee board. Disconnect first (disconnect_bee).");
  }
  if (state.mode !== "ble") setTransportMode("ble");
  let device = null;
  if (deviceId) {
    device = { id: String(deviceId), name: printableDeviceName(name, "") };
  } else if (name) {
    const wanted = String(name).trim().toLowerCase();
    const found = (await scanBeeDevices({ durationMs: 8000, signal }))
      .filter((candidate) => String(candidate.name || "").toLowerCase().includes(wanted));
    if (!found.length) throw new Error(`No nearby Linkr Bee matched "${name}".`);
    if (found.length > 1) {
      throw new Error(`Several Linkr Bee boards matched "${name}"; pass a deviceId from scan_bee_devices.`);
    }
    device = { id: found[0].deviceId, name: found[0].name };
  } else {
    const saved = localStorage.getItem(LAST_DEVICE_ID_KEY);
    if (!saved) throw new Error("No Linkr Bee is saved in the app. Run scan_bee_devices first.");
    device = { id: saved, name: state.device?.name || "" };
  }
  rememberDevice(device);
  await connect();
  if (!state.connected) {
    throw new Error(`Could not connect to ${printableDeviceName(device.name, device.id)}. Keep the board powered and in range, and check the app log for the pairing result.`);
  }
  return beeStatus({ signal });
}

async function disconnectBee({ forget = false, signal } = {}) {
  signal?.throwIfAborted();
  cancelAutoReconnect(t("reconnectCancelled"), { silent: true });
  if (state.connected) {
    await disconnect();
  }
  if (forget) {
    localStorage.removeItem(LAST_DEVICE_ID_KEY);
    state.device = null;
    state.deviceRestored = false;
    state.bleReselectId = null;
  }
  return beeStatus({ signal });
}

async function readMcpBleName({ signal } = {}) {
  signal?.throwIfAborted();
  const parsed = parseBleName(
    String((await sendControl(BLE_NAME_QUERY_COMMAND, { returnResponse: true })) ?? ""),
    { query: true },
  );
  if (!parsed) throw new Error("The accessory did not report its BLE name.");
  return { name: parsed.name, custom: parsed.custom };
}

async function changeMcpBleName({ name, reset = false, signal } = {}) {
  signal?.throwIfAborted();
  const command = reset ? bleNameCommand({ reset: true }) : bleNameCommand({ name });
  const wanted = reset ? null : command.slice("@n=".length);
  const reply = String((await sendControl(command, { returnResponse: true })) ?? "");
  const status = replyStatus(reply);
  const evidence = { command: redactCommand(command), reply: redactSecrets(reply), accepted: status.ok };
  if (!status.ok) {
    return { ...evidence, error: status.error || "The accessory did not accept the command." };
  }
  const queried = await pollAccessoryStatus(
    BLE_NAME_QUERY_COMMAND,
    (text) => parseBleName(text, { query: true }),
    (value) => (reset ? value.custom === false : value.name === wanted),
    { signal, timeoutMs: 6000, intervalMs: 600 },
  );
  return {
    ...evidence,
    confirmed: queried.value,
    settled: queried.settled,
    applied: Boolean(queried.value) && (reset ? queried.value.custom === false : queried.value.name === wanted),
  };
}

async function readMcpLanBridge({ signal } = {}) {
  signal?.throwIfAborted();
  const parsed = parseLanBridge(
    String((await sendControl(LAN_BRIDGE_QUERY_COMMAND, { returnResponse: true })) ?? ""),
  );
  if (!parsed) throw new Error("The accessory did not report the LAN bridge state.");
  return parsed;
}

async function changeMcpLanBridge({ action, signal } = {}) {
  signal?.throwIfAborted();
  const command = lanBridgeCommand({ action });
  const reply = String((await sendControl(command, { returnResponse: true })) ?? "");
  const status = replyStatus(reply);
  const evidence = { command: redactCommand(command), reply: redactSecrets(reply), accepted: status.ok };
  if (!status.ok) {
    return { ...evidence, error: status.error || "The accessory did not accept the command." };
  }
  const wanted = action === "on" ? true : action === "off" ? false : null;
  const queried = await pollAccessoryStatus(
    LAN_BRIDGE_QUERY_COMMAND,
    (text) => parseLanBridge(text),
    (value) => wanted === null || value.enabled === wanted,
    { signal, timeoutMs: 6000 },
  );
  return {
    ...evidence,
    state: queried.value,
    settled: queried.settled,
    applied: Boolean(queried.value) && (wanted === null || queried.value.enabled === wanted),
  };
}

/* External MCP clients (Claude Desktop, Cursor, …) reach the same serial gate
 * the assistant uses. Only the Android shell installs window.LinkrMcp; on the
 * web, iOS and HarmonyOS builds this returns immediately and the settings card
 * is never created. */
function initMcp() {
  const bridge = globalThis.LinkrMcp;
  if (!bridge || !bridge.available) return;
  let storage;
  try { storage = localStorage; } catch { storage = { getItem: () => null, setItem: () => {} }; }
  /* The resident assistant is the app's own agent runtime, made callable by
   * MCP/A2A clients. It uses the same device executor, accessory helpers,
   * notes and board prompt as the human conversation; only its conversation is
   * separate. Starting a task is approved once in MCP/A2A, and that approval
   * covers the task's ordinary writes. The app's destructive-command class and
   * every accessory/WiFi change still ask per call through this same approval
   * surface (a card while the app is visible, a notification while it is not). */
  residentAgent = createResidentAgent({
    storage,
    getConfig: () => agentSettings?.getConfig?.() || null,
    getDevice: () => agentPanel?.getDevice?.() || null,
    readBoardPrompt: readBoardPromptForAgent,
    accessory: {
      capability: accessoryCapability,
      command: accessoryCommand,
      execute: executeAccessoryChange,
      diagnostics: collectAccessoryDiagnostics,
      scan: scanWifi,
    },
    /* Resolved at call time: mcpUi is created later in this function, and a
     * missing UI must fail closed rather than execute a sensitive call. */
    requestApproval: (request) => mcpUi
      ? mcpUi.requestApproval(request)
      : Promise.resolve({ approved: false, reason: "MCP approval UI is unavailable." }),
    /* The resident device wrapper re-reads the target's always-ask list per
     * command, so a task cannot send a command the user pinned for approval. */
    getCommandPolicy: () => agentPanel?.getCommandPolicy?.() || null,
    getLang: () => lang,
    isHumanAgentBusy: () => Boolean(agentPanel?.isBusy?.()),
    onTaskChange: () => {
      agentPanel?.residentChanged();
      mcpUi?.refresh();
    },
  });
  mcpHost = createMcpHost({
    getBridge: () => globalThis.LinkrMcp || null,
    storage,
    residentAgent,
    getDevice: () => agentPanel?.getDevice?.() || null,
    readLog: (options) => agentJournal.read(options),
    /* The accessory helpers are the app's own management-channel functions, so
     * an MCP change goes through the same read-back and redaction every other
     * host client uses. */
    readBoardPrompt: readBoardPromptForAgent,
    accessory: {
      capability: accessoryCapability,
      command: accessoryCommand,
      execute: executeAccessoryChange,
      diagnostics: collectAccessoryDiagnostics,
      scan: scanWifi,
      readBleName: readMcpBleName,
      changeBleName: changeMcpBleName,
      readLanBridge: readMcpLanBridge,
      changeLanBridge: changeMcpLanBridge,
    },
    bee: {
      status: beeStatus,
      scan: scanBeeDevices,
      connect: connectBee,
      disconnect: disconnectBee,
    },
    requestApproval: (request) => mcpUi
      ? mcpUi.requestApproval(request)
      : Promise.resolve({ approved: false, reason: "MCP approval UI is unavailable." }),
    getLang: () => lang,
    onChange: () => mcpUi?.refresh(),
  });
  mcpUi = createMcpUi({
    mount: elements.controls, getLang: () => lang, host: mcpHost,
    /* The hidden-page approval path posts a notification through the Android bridge. */
    getBridge: () => globalThis.LinkrMcp || null,
  });
  /* Subscribe before starting: a server that accepts a request before the
   * httpRequest listener exists could only answer 503. The user explicitly
   * enabled the server in a previous run, so bring it back up afterwards; a
   * failed start stays visible in the settings card instead of blocking boot. */
  Promise.resolve(mcpHost.attach())
    .then(() => (mcpHost.getConfig().enabled ? mcpHost.enable() : null))
    .catch(() => {});
}

function init() {
  loadPersisted();
  aboutPage = createAboutPage({ section: $("aboutPage"), getLang: () => lang });
  agentSettings = createAgentSettings({
    section: $("agentSettings"), tab: document.querySelector('[data-settings-target="ai"]'),
    getLang: () => lang, onChange: () => agentPanel?.settingsChanged(),
    bindingAction: (action) => agentPanel.targetBinding(action),
    control: (command) => sendControl(command, { returnResponse: true, quiet: true }),
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
  initCollapsibleCards();
  // Keep the same buttons and UART listeners when changing their visual order.
  // Storage denial must not prevent the terminal itself from starting.
  let keyStorage;
  try { keyStorage = localStorage; } catch { keyStorage = { getItem: () => null, setItem: () => { throw new Error("Storage unavailable"); } }; }
  terminalKeyPreferences = createTerminalKeyPreferences({
    bar: elements.terminalKeyBar, getLang: () => lang, storage: keyStorage,
    onCustomize: () => { resetModifiers(); hideTerminalSelectionHandles(); state.term?.blur(); },
  });
  agentPanel = createAgentPanel({
    onBusyChange: setAgentLedActive,
    resident: {
      isBusy: () => residentAgent?.isBusy() === true,
      // A canceled runner can keep its resource lease until it settles. Its
      // task state, rather than panel visibility or the lease, drives the LED.
      getRunningTaskId: () => {
        const status = residentAgent?.getStatus();
        return status?.activeTaskState === "running" ? status.activeTaskId : null;
      },
      cancelAll: () => residentAgent?.cancelAll(),
    },
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
      refreshBoardPromptStatus().catch(() => {});
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
    readExecutionEvents: options => agentJournal.readExecutionEvents(options),
    onExecutionRecord: record => {
      if (record.state === "sending" && record.sessionId === state.writeGeneration) serialPresentation.register(record);
      renderShellIntegration();
    },
    prepareInput: ({ text, appendEnter }) => normalizeEnter(text + (appendEnter ? "\r" : "")),
    sendInput: async (payload, generation, signal, inputRevision) => {
      const operation = enqueueBytes(encoder.encode(payload), false, { generation, signal, inputRevision });
      const queuedRevision = serialInputRevision;
      await operation;
      return { inputRevision: queuedRevision };
    },
  });
  renderShellIntegration();
  initMcp();
  /* MCP is created after the first pass; add its header chevron without
   * duplicating the toggles already created for the static cards. */
  initCollapsibleCards();
  initSoftKeyboardLayout();
  syncSidebarForViewport();
  if (mobileMedia.addEventListener) {
    mobileMedia.addEventListener("change", syncSidebarForViewport);
  } else if (mobileMedia.addListener) {
    mobileMedia.addListener(syncSidebarForViewport);
  }
  installSelectControls(elements.controlsPanel);
  appendLine(t("welcome"));
  if (state.mode === "ble") {
    restoreAuthorizedDevice().catch((error) =>
      debugLine(`[restore] ${error.message}`),
    );
  }
}

init();

/* `?demo=board` opens the terminal against a mock X1.0 so the board panel can
 * be looked at (and screenshotted) without hardware. The module does nothing
 * without the query parameter. */
function startDemoModeIfRequested() {
  if (!demoModeRequested()) {
    return;
  }
  if (!state.term) {
    window.setTimeout(startDemoModeIfRequested, 60);
    return;
  }
  installDemoMode({
    state,
    setConnected,
    setControl: (fn) => { sendControl = fn; },
    setPage: setSettingsPage,
    appendLine,
    panelToggle: elements.panelToggle,
    appShell: elements.appShell,
  });
}

startDemoModeIfRequested();
