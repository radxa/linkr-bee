"use strict";

/* Linkr Bee servo bench.
 *
 * A standalone toolbox page: the browser talks BLE to a Linkr Bee, the Bee
 * carries the FEETECH half-duplex bus on J7, and this page implements the SCS/
 * STS packet layer (servo_protocol.js) so no host software is needed. Open it
 * from the terminal's rail or directly at /servo.html.
 *
 * `?demo=servo` swaps the Bee for a loopback bus so the page can be reviewed
 * and tried without hardware. `?lang=` and `?theme=` pin the presentation for
 * screenshot runs.
 */

import { parseManagementHeader } from "./management_protocol.js";
import {
  INSTRUCTION,
  MODEL_NAMES,
  REGISTERS,
  ServoLink,
  SimulatedBus,
  decodeRegister,
  decodeWord,
  encodeRegister,
  parseIdRange,
  toServoWord,
} from "./servo_protocol.js";

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const MGMT_SERVICE = "4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001";
const MGMT_PROTOCOL = "4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001";
const MGMT_COMMAND = "4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001";
const MGMT_RESPONSE = "4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001";

const MGMT_CAP_MULTI_SESSION = 1 << 7;
const MGMT_FLAG_ERROR = 1 << 1;
const THEME_KEY = "linkr-theme";
const LANG_KEY = "linkr-lang";
const BUS_BAUD = 1000000;
const UART_OPTIONS = [1000000, 500000, 250000, 115200, 76800];

const STRINGS = {
  zh: {
    title: "舵机调试",
    backToTerminal: "返回终端",
    connect: "连接 Bee",
    disconnect: "断开",
    disconnected: "未连接",
    connectedTo: "已连接 {name}",
    simMode: "模拟总线",
    theme: "主题",
    language: "语言",
    noWebBluetooth: "此浏览器不支持 Web Bluetooth，请用 Chrome / Edge 从 https 或 localhost 打开。",
    requesting: "请选择 Linkr Bee…",
    connectingDevice: "正在连接 {name}…",
    unsupportedApi: "这块 Bee 的固件不支持 Management v1，无法改 UART 参数。",
    pairHint: "首次连接新主机：先按一下 Bee 的配对键（X1.0：USER_KEY/GPIO3），再在浏览器里允许配对。",
    connectFailed: "连接失败：{message}",
    disconnectedNotice: "连接已断开。",
    busTitle: "总线",
    linkHint: "把舵机总线接到 J7：J7.1(RX) 与 J7.2(TX) 短接后接信号线，GND 共地，舵机单独供电。",
    busBaud: "总线波特率",
    apply: "应用",
    restore: "恢复",
    uartHint: "连接后会读取 Bee 的 UART 参数。",
    uartNone: "尚未读取 Bee 的 UART 参数。",
    uartSim: "模拟总线不修改 Bee 的 UART 参数。",
    uartNow: "当前 UART：{spec}",
    uartChanged: "已切换到 {baud}，断开时恢复为 {previous}。",
    uartRestored: "已恢复为 {spec}。",
    uartFailed: "UART 参数修改失败：{message}",
    scanRange: "扫描 ID 范围",
    scan: "扫描",
    notScanned: "尚未扫描。",
    scanStart: "扫描 {range}…",
    scanningId: "正在探测 ID {id}…",
    scanDone: "扫描完成：{count} 个舵机。",
    scanNone: "没有舵机应答：检查供电、共地和 J7 接线，或换一个波特率。",
    servoFound: "ID {id}：型号 {model}",
    servoList: "舵机列表",
    noServo: "未选择舵机",
    unknownModel: "型号未知",
    logTitle: "日志",
    clear: "清空",
    torqueOn: "力矩开",
    torqueOff: "力矩关",
    refresh: "刷新",
    speed: "速度",
    load: "负载",
    voltage: "电压",
    temperature: "温度",
    current: "电流",
    moving: "运动中",
    target: "目标位置",
    speedLabel: "速度",
    accLabel: "加速度",
    move: "移动",
    moveHint: "滑块与数字框同步；移动前会自动打开力矩。",
    moved: "已移动到 {position}。",
    moveFailed: "移动失败：{message}",
    wheelSpeed: "轮模式速度",
    wheel: "轮模式",
    wheelStarted: "已切到轮模式，速度 {speed}。",
    torqueSet: "力矩已{state}。",
    torqueFailed: "力矩设置失败：{message}",
    live: "实时监视",
    paramsTitle: "参数表",
    readParams: "读取参数",
    paramsHint: "先选择舵机。",
    paramsReading: "正在读取 {count} 个寄存器…",
    paramsIdle: "读取 ID {id} 的寄存器。",
    paramsDone: "已读取 {count} 个寄存器。",
    paramsFailed: "读取参数失败。",
    colAddress: "地址",
    colRegister: "寄存器",
    colValue: "值",
    colArea: "区域",
    writeAddress: "地址",
    writeLength: "长度",
    writeValue: "值",
    write: "写入",
    writeHint: "地址/值支持十进制或 0x 十六进制；写入为单次小端写入。",
    writeDone: "已写入地址 {address}。",
    writeFailed: "写入失败：{message}",
    readFailed: "读取失败。",
    needConnection: "请先连接 Bee。",
    selectServo: "请先在左侧选择一个舵机。",
    noResponse: "没有应答。",
    invalidRange: "ID 范围无效，例如 1-12 或 1,3,5。",
    invalidAddress: "地址或数值无效。",
    mgmtTimeout: "Bee 没有回应管理命令。",
    controlClaimed: "已取得控制权。",
    controlOther: "另一个客户端正在控制 Bee，写操作可能被拒绝。",
    controlFailed: "无法取得控制权：{message}",
    requestFailed: "请求失败：{message}",
    actionHint: "",
    unitV: "{value} V",
    unitC: "{value} °C",
    unitmA: "{value} mA",
    yes: "是",
    no: "否",
  },
  en: {
    title: "Servo bench",
    backToTerminal: "Back to terminal",
    connect: "Connect Bee",
    disconnect: "Disconnect",
    disconnected: "Disconnected",
    connectedTo: "Connected to {name}",
    simMode: "Simulated bus",
    theme: "Theme",
    language: "Language",
    noWebBluetooth: "This browser has no Web Bluetooth. Use Chrome or Edge over https or localhost.",
    requesting: "Choose a Linkr Bee…",
    connectingDevice: "Connecting to {name}…",
    unsupportedApi: "This Bee firmware does not expose Management v1, so the UART cannot be configured.",
    pairHint: "First time on a new host: press the Bee pairing key (X1.0: USER_KEY/GPIO3), then allow pairing in the browser.",
    connectFailed: "Connection failed: {message}",
    disconnectedNotice: "The link disconnected.",
    busTitle: "Bus",
    linkHint: "Wire the servo bus to J7: tie J7.1 (RX) to J7.2 (TX), connect that to the signal wire, share ground, power the servo separately.",
    busBaud: "Bus baud",
    apply: "Apply",
    restore: "Restore",
    uartHint: "The Bee's UART settings are read after connecting.",
    uartNone: "The Bee's UART settings have not been read yet.",
    uartSim: "The simulated bus never changes the Bee's UART settings.",
    uartNow: "UART: {spec}",
    uartChanged: "Switched to {baud}; {previous} is restored on disconnect.",
    uartRestored: "Restored {spec}.",
    uartFailed: "UART change failed: {message}",
    scanRange: "Scan ID range",
    scan: "Scan",
    notScanned: "Not scanned yet.",
    scanStart: "Scanning {range}…",
    scanningId: "Probing ID {id}…",
    scanDone: "Scan finished: {count} servo(s).",
    scanNone: "No servo answered. Check power, common ground and the J7 wiring, or try another baud.",
    servoFound: "ID {id}: model {model}",
    servoList: "Servo list",
    noServo: "No servo selected",
    unknownModel: "Unknown model",
    logTitle: "Log",
    clear: "Clear",
    torqueOn: "Torque on",
    torqueOff: "Torque off",
    refresh: "Refresh",
    speed: "Speed",
    load: "Load",
    voltage: "Voltage",
    temperature: "Temperature",
    current: "Current",
    moving: "Moving",
    target: "Goal position",
    speedLabel: "Speed",
    accLabel: "Acceleration",
    move: "Move",
    moveHint: "The slider and the number field stay in sync; torque is enabled before a move.",
    moved: "Moved to {position}.",
    moveFailed: "Move failed: {message}",
    wheelSpeed: "Wheel speed",
    wheel: "Wheel mode",
    wheelStarted: "Wheel mode at speed {speed}.",
    torqueSet: "Torque {state}.",
    torqueFailed: "Torque change failed: {message}",
    live: "Live monitor",
    paramsTitle: "Registers",
    readParams: "Read registers",
    paramsHint: "Select a servo first.",
    paramsReading: "Reading {count} registers…",
    paramsIdle: "Read the registers of ID {id}.",
    paramsDone: "Read {count} registers.",
    paramsFailed: "Reading registers failed.",
    colAddress: "Address",
    colRegister: "Register",
    colValue: "Value",
    colArea: "Area",
    writeAddress: "Address",
    writeLength: "Length",
    writeValue: "Value",
    write: "Write",
    writeHint: "Address and value accept decimal or 0x hex; the write is a single little-endian write.",
    writeDone: "Wrote address {address}.",
    writeFailed: "Write failed: {message}",
    readFailed: "Read failed.",
    needConnection: "Connect a Bee first.",
    selectServo: "Select a servo on the left first.",
    noResponse: "No answer.",
    invalidRange: "Invalid ID range, for example 1-12 or 1,3,5.",
    invalidAddress: "Invalid address or value.",
    mgmtTimeout: "The Bee did not answer the management command.",
    controlClaimed: "Console control claimed.",
    controlOther: "Another client controls the Bee; writes may be refused.",
    controlFailed: "Could not claim control: {message}",
    requestFailed: "Request failed: {message}",
    actionHint: "",
    unitV: "{value} V",
    unitC: "{value} °C",
    unitmA: "{value} mA",
    yes: "yes",
    no: "no",
  },
};

const params = new URLSearchParams(window.location.search);
const forcedLang = params.get("lang");
const forcedTheme = params.get("theme");
const demoRequested = params.get("demo") === "servo";

function stored(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private mode or a webview without storage: the page still works. */
  }
}

const initialLang =
  forcedLang === "zh" || forcedLang === "en"
    ? forcedLang
    : stored(LANG_KEY, (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
const initialTheme =
  forcedTheme === "light" || forcedTheme === "dark"
    ? forcedTheme
    : stored(THEME_KEY, document.documentElement.dataset.theme === "light" ? "light" : "dark");

function t(key, vars = {}) {
  const value = STRINGS[state.lang]?.[key] ?? STRINGS.en[key] ?? key;
  return value.replace(/\{(\w+)\}/g, (_match, name) =>
    vars[name] == null ? `{${name}}` : String(vars[name]),
  );
}

const $ = (id) => document.getElementById(id);

const state = {
  mode: "off", // "ble" | "sim" | "off"
  transport: null,
  deviceId: null,
  deviceName: "",
  caps: 0,
  link: null,
  simBus: null,
  servos: new Map(),
  selectedId: null,
  telemetry: {},
  registerValues: new Map(),
  previousUart: null,
  currentUart: null,
  uartTouched: false,
  busy: false,
  lastScan: null,
  monitorTimer: null,
  monitorTick: 0,
  scanBusy: false,
  lang: initialLang,
  theme: initialTheme,
};

/* --- Presentation -------------------------------------------------------- */

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const meta = $("themeColorMeta");
  if (meta) meta.content = state.theme === "light" ? "#E2E9F4" : "#05080D";
  store(THEME_KEY, state.theme);
}

function applyLanguage() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.title = t(element.getAttribute("data-i18n-title"));
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
    element.setAttribute("aria-label", t(element.getAttribute("data-i18n-aria")));
  });
  const langButton = $("servoLangButton").querySelector(".btn-label");
  langButton.textContent = state.lang === "zh" ? "EN" : "中";
  document.title = `Linkr Bee · ${t("title")}`;
  syncLinkText();
  renderServoList();
  renderSelectedHeader();
  renderRegisterTable();
  updateUartHint();
  if (state.lastScan) {
    $("scanHint").textContent = state.lastScan.count
      ? t("scanDone", { count: state.lastScan.count })
      : t("scanNone");
  } else {
    $("scanHint").textContent = t("notScanned");
  }
  if (state.selectedId != null) {
    $("paramsHint").textContent = state.registerValues.size
      ? t("paramsDone", { count: state.registerValues.size })
      : t("paramsIdle", { id: String(state.selectedId).padStart(3, "0") });
  }
  store(LANG_KEY, state.lang);
}

function log(level, message) {
  const list = $("logList");
  const item = document.createElement("li");
  item.dataset.level = level;
  const time = document.createElement("time");
  const now = new Date();
  time.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const text = document.createElement("span");
  text.textContent = message;
  item.append(time, text);
  list.append(item);
  while (list.children.length > 200) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
}

function syncLinkText() {
  const pill = $("linkState");
  const text = $("linkStateText");
  if (state.mode === "ble") {
    pill.dataset.state = "connected";
    text.textContent = t("connectedTo", { name: state.deviceName || "Linkr Bee" });
  } else if (state.mode === "sim") {
    pill.dataset.state = "sim";
    text.textContent = t("simMode");
  } else {
    pill.dataset.state = "offline";
    text.textContent = t("disconnected");
  }
}

function formatValue(value, register) {
  if (value == null) return "—";
  if (register?.unit === "V") return t("unitV", { value: value.toFixed(1) });
  if (register?.unit === "°C") return t("unitC", { value });
  if (register?.unit === "mA") return t("unitmA", { value });
  return String(value);
}

function modelLabel(model) {
  if (!model) return t("unknownModel");
  const name = MODEL_NAMES[model];
  return `${model}${name ? ` · ${name}` : ""}`;
}

/* --- Transport ----------------------------------------------------------- */

async function sendUart(bytes) {
  if (state.mode !== "ble" || !state.transport || !state.deviceId) {
    throw new Error(t("needConnection"));
  }
  for (let offset = 0; offset < bytes.length; offset += 20) {
    await state.transport.write(
      state.deviceId,
      NUS_SERVICE,
      NUS_RX,
      bytes.slice(offset, offset + 20),
      false,
    );
  }
}

function onUartData(value) {
  if (!state.link) return;
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  state.link.feed(bytes);
}

/* Management v1 request/response on its own framed characteristic. */
let managementRequestId = 0;
const managementPending = new Map();
let managementPartial = null;

function onManagementData(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (!managementPartial) {
    if (bytes.length < 12) return;
    const header = parseManagementHeader(bytes);
    if (header.error) return;
    managementPartial = {
      id: header.requestId,
      expected: header.expected,
      flags: header.flags,
      type: header.type,
      chunks: [bytes.slice(12)],
    };
  } else {
    managementPartial.chunks.push(bytes);
  }
  const received = managementPartial.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (received < managementPartial.expected) return;
  const message = managementPartial;
  managementPartial = null;
  const payload = new Uint8Array(message.expected);
  let offset = 0;
  for (const chunk of message.chunks) {
    const take = Math.min(chunk.length, message.expected - offset);
    payload.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  const pending = managementPending.get(message.id);
  if (!pending) return;
  managementPending.delete(message.id);
  clearTimeout(pending.timer);
  const text = new TextDecoder().decode(payload);
  if (message.flags & MGMT_FLAG_ERROR) pending.reject(new Error(text.trim()));
  else pending.resolve(text);
}

async function managementCommand(text) {
  if (state.mode !== "ble" || !state.transport) throw new Error(t("needConnection"));
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(12 + payload.length);
  frame.set([0x4c, 0x4b, 1, 1]);
  const view = new DataView(frame.buffer);
  managementRequestId = (managementRequestId + 1) >>> 0;
  const requestId = managementRequestId;
  view.setUint32(4, requestId, true);
  view.setUint16(8, payload.length, true);
  view.setUint16(10, 0, true);
  frame.set(payload, 12);
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      managementPending.delete(requestId);
      reject(new Error(t("mgmtTimeout")));
    }, 6000);
    managementPending.set(requestId, { resolve, reject, timer });
  });
  try {
    for (let offset = 0; offset < frame.length; offset += 20) {
      await state.transport.write(
        state.deviceId,
        MGMT_SERVICE,
        MGMT_COMMAND,
        frame.slice(offset, offset + 20),
        true,
      );
    }
  } catch (error) {
    clearTimeout(managementPending.get(requestId)?.timer);
    managementPending.delete(requestId);
    throw error;
  }
  return result;
}

function uartFields(text) {
  const match = /uart=([^,\s]+),([^,\s]+),([^,\s]+),([^,\s]+),([^,\s]+)/i.exec(text);
  if (!match) return null;
  return `${match[1]},${match[2]},${match[3]},${match[4]},${match[5]}`;
}

async function readUart() {
  try {
    const reply = await managementCommand("@u?");
    const spec = uartFields(reply);
    if (spec) {
      state.currentUart = spec;
      if (state.previousUart == null) state.previousUart = spec;
      const baud = Number(spec.split(",")[0]);
      if (UART_OPTIONS.includes(baud)) $("baudSelect").value = String(baud);
    }
  } catch (error) {
    log("warn", error.message);
  }
  updateUartHint();
}

function updateUartHint() {
  const hint = $("uartHint");
  if (state.mode === "sim") {
    hint.textContent = t("uartSim");
    return;
  }
  if (state.currentUart) {
    hint.textContent = t("uartNow", { spec: state.currentUart });
  } else {
    hint.textContent = t("uartNone");
  }
}

async function applyUart(baud, { automatic = false } = {}) {
  if (state.mode !== "ble") {
    log("warn", t("uartSim"));
    return;
  }
  const spec = `${baud},8,n,1,none`;
  try {
    if (state.previousUart == null) await readUart();
    const previous = state.previousUart;
    await managementCommand(`@u=${spec}`);
    state.currentUart = spec;
    state.uartTouched = true;
    const verify = uartFields(await managementCommand("@u?"));
    if (verify) state.currentUart = verify;
    updateUartHint();
    if (automatic) {
      log("info", t("uartChanged", { baud, previous: previous || "?" }));
    } else {
      log("ok", t("uartNow", { spec: verify || spec }));
    }
  } catch (error) {
    log("error", t("uartFailed", { message: error.message }));
  }
}

async function restoreUart() {
  if (state.mode !== "ble" || !state.previousUart) return;
  try {
    await managementCommand(`@u=${state.previousUart}`);
    state.currentUart = state.previousUart;
    state.uartTouched = false;
    updateUartHint();
    log("ok", t("uartRestored", { spec: state.previousUart }));
  } catch (error) {
    log("error", t("uartFailed", { message: error.message }));
  }
}

async function claimControl() {
  if (!(state.caps & MGMT_CAP_MULTI_SESSION)) return;
  try {
    const status = await managementCommand("@c?");
    const self = /self=(\d+)/.exec(status)?.[1];
    const owner = /owner=(\d+)/.exec(status)?.[1];
    if (owner && owner !== "0" && owner !== self) {
      log("warn", t("controlOther"));
      await managementCommand("@c claim");
    }
    log("ok", t("controlClaimed"));
  } catch (error) {
    log("warn", t("controlFailed", { message: error.message }));
  }
}

async function releaseControl() {
  if (state.mode !== "ble" || !(state.caps & MGMT_CAP_MULTI_SESSION)) return;
  try {
    await managementCommand("@c release");
  } catch {
    /* The idle hand-over covers this; a failed release is not user-visible. */
  }
}

/* --- Connection lifecycle ------------------------------------------------ */

function setControlsEnabled(enabled) {
  const ids = [
    "torqueOn", "torqueOff", "refreshButton", "readParams", "writeButton",
    "moveButton", "wheelButton", "scanButton", "positionSlider",
  ];
  for (const id of ids) {
    const element = $(id);
    if (!element) continue;
    element.disabled = !enabled;
  }
  $("connectButton").disabled = enabled;
  $("disconnectButton").hidden = !enabled;
  $("baudApply").disabled = !enabled || state.mode === "sim";
  $("baudRestore").disabled = !enabled || state.mode === "sim";
}

function onConnected() {
  syncLinkText();
  setControlsEnabled(true);
  $("linkHint").textContent = state.mode === "sim"
    ? t("uartSim")
    : t("linkHint");
  $("disconnectButton").hidden = false;
  $("connectButton").hidden = true;
  updateUartHint();
}

function resetUi() {
  stopMonitor();
  state.mode = "off";
  state.link = null;
  state.transport = null;
  state.deviceId = null;
  state.deviceName = "";
  state.simBus = null;
  state.servos.clear();
  state.selectedId = null;
  state.telemetry = {};
  state.registerValues.clear();
  state.lastScan = null;
  state.currentUart = null;
  state.previousUart = null;
  state.uartTouched = false;
  syncLinkText();
  setControlsEnabled(false);
  $("connectButton").hidden = false;
  $("disconnectButton").hidden = true;
  $("scanHint").textContent = t("notScanned");
  $("selectedId").textContent = "—";
  $("selectedModel").textContent = t("noServo");
  $("positionValue").textContent = "—";
  renderServoList();
  renderRegisterTable();
  updateUartHint();
  updateMetrics({});
  $("actionHint").textContent = "";
}

function onDisconnected() {
  if (state.mode === "off") return;
  log("warn", t("disconnectedNotice"));
  resetUi();
}

async function connect() {
  if (state.busy || state.mode !== "off") return;
  state.busy = true;
  $("connectButton").disabled = true;
  try {
    const transport = window.LinkrBleTransport;
    if (!transport) throw new Error(t("noWebBluetooth"));
    await transport.initialize?.();
    log("info", t("requesting"));
    const device = await transport.requestDevice({
      filters: [{ services: [MGMT_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
    state.deviceName = device.name || device.id;
    log("info", t("connectingDevice", { name: state.deviceName }));
    await transport.connect(device.id, () => onDisconnected());
    state.transport = transport;
    state.deviceId = device.id;
    const protocol = new Uint8Array(await transport.read(device.id, MGMT_SERVICE, MGMT_PROTOCOL));
    if (protocol[0] !== 1) throw new Error(t("unsupportedApi"));
    state.caps = protocol[4] | (protocol[5] << 8) | (protocol[6] << 16) | (protocol[7] << 24);
    await transport.startNotifications(device.id, MGMT_SERVICE, MGMT_RESPONSE, onManagementData);
    await transport.startNotifications(device.id, NUS_SERVICE, NUS_TX, onUartData);
    state.mode = "ble";
    state.link = new ServoLink({ write: sendUart, echo: true, timeoutMs: 250 });
    onConnected();
    log("ok", t("connectedTo", { name: state.deviceName }));
    await claimControl();
    await readUart();
    await applyUart(BUS_BAUD, { automatic: true });
    await scan();
  } catch (error) {
    log("error", t("connectFailed", { message: error.message }));
    log("info", t("pairHint"));
    try {
      if (state.deviceId) await state.transport?.disconnect(state.deviceId);
    } catch {
      /* Nothing to clean up. */
    }
    resetUi();
  } finally {
    state.busy = false;
    $("connectButton").disabled = state.mode !== "off";
  }
}

async function startSimulatedBus() {
  state.mode = "sim";
  const bus = new SimulatedBus({ ids: [1, 2, 3, 4, 5, 6], echo: true, latencyMs: 3 });
  const link = new ServoLink({ write: (bytes) => bus.write(bytes), echo: true, timeoutMs: 250 });
  bus.onData = (bytes) => link.feed(bytes);
  state.simBus = bus;
  state.link = link;
  state.deviceName = t("simMode");
  onConnected();
  log("ok", t("simMode"));
  await scan();
}

async function disconnect() {
  stopMonitor();
  const wasBle = state.mode === "ble";
  const previous = state.previousUart;
  const restore = wasBle && state.uartTouched && previous;
  try {
    if (restore) await managementCommand(`@u=${previous}`);
  } catch {
    /* Disconnect must proceed even when the restore command fails. */
  }
  await releaseControl();
  try {
    if (wasBle && state.transport && state.deviceId) {
      await state.transport.disconnect(state.deviceId);
    }
  } catch {
    /* The link may already be gone. */
  }
  if (restore) log("ok", t("uartRestored", { spec: previous }));
  resetUi();
}

/* --- Servo operations ---------------------------------------------------- */

function selectedServo() {
  return state.selectedId == null ? null : state.servos.get(state.selectedId) || null;
}

function requireSelected() {
  if (!state.link) throw new Error(t("needConnection"));
  if (state.selectedId == null) throw new Error(t("selectServo"));
  return state.selectedId;
}

async function readRegisters(id, address, length) {
  const frame = await state.link.request(
    id,
    INSTRUCTION.read,
    [address, length],
    { timeoutMs: 250 },
  );
  return frame ? frame.data : null;
}

async function writeRegisters(id, address, values) {
  const frame = await state.link.request(
    id,
    INSTRUCTION.write,
    [address, ...values],
    { timeoutMs: 250 },
  );
  return Boolean(frame);
}

async function scan() {
  if (!state.link || state.scanBusy) return;
  const rangeText = $("scanRange").value.trim();
  const ids = parseIdRange(rangeText);
  if (ids.length === 0) {
    log("warn", t("invalidRange"));
    return;
  }
  state.scanBusy = true;
  state.servos.clear();
  state.selectedId = null;
  renderServoList();
  renderSelectedHeader();
  setControlsEnabled(false);
  $("scanButton").disabled = true;
  $("scanHint").textContent = t("scanStart", { range: rangeText });
  log("info", t("scanStart", { range: rangeText }));
  try {
    for (const id of ids) {
      $("scanHint").textContent = t("scanningId", { id });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const frame = await state.link.request(id, INSTRUCTION.ping, [], { timeoutMs: 90 });
      if (!frame) continue;
      let model = 0;
      const modelData = await state.link.request(id, INSTRUCTION.read, [3, 2], { timeoutMs: 250 });
      if (modelData) model = decodeWord(modelData.data);
      state.servos.set(id, { model });
      log("ok", t("servoFound", { id, model: modelLabel(model) }));
      renderServoList();
    }
    state.lastScan = { range: rangeText, count: state.servos.size };
    if (state.servos.size === 0) {
      $("scanHint").textContent = t("scanNone");
    } else {
      $("scanHint").textContent = t("scanDone", { count: state.servos.size });
      const first = [...state.servos.keys()][0];
      await selectServo(first);
    }
  } catch (error) {
    log("error", t("requestFailed", { message: error.message }));
  } finally {
    state.scanBusy = false;
    state.busy = false;
    setControlsEnabled(state.mode !== "off");
    $("scanButton").disabled = state.mode === "off";
  }
}

async function selectServo(id) {
  state.selectedId = id;
  state.registerValues.clear();
  renderServoList();
  renderSelectedHeader();
  renderRegisterTable();
  $("paramsHint").textContent = t("paramsIdle", { id: String(id).padStart(3, "0") });
  $("positionValue").textContent = "—";
  updateMetrics({});
  await refreshSelected({ full: true });
  startMonitor();
}

function renderServoList() {
  const list = $("servoList");
  list.replaceChildren();
  for (const [id, servo] of [...state.servos.entries()].sort((a, b) => a[0] - b[0])) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "servo-list-item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(id === state.selectedId));
    item.dataset.id = String(id);
    const badge = document.createElement("span");
    badge.className = "servo-list-id";
    badge.textContent = `ID ${String(id).padStart(3, "0")}`;
    const model = document.createElement("span");
    model.className = "servo-list-model";
    model.textContent = modelLabel(servo.model);
    item.append(badge, model);
    item.addEventListener("click", () => {
      if (state.busy || state.scanBusy) return;
      selectServo(id).catch((error) => log("error", error.message));
    });
    list.append(item);
  }
}

function renderSelectedHeader() {
  const servo = selectedServo();
  $("selectedId").textContent = servo ? String(state.selectedId).padStart(3, "0") : "—";
  $("selectedModel").textContent = servo ? modelLabel(servo.model) : t("noServo");
}

function updateMetrics(telemetry) {
  const value = (key) => (telemetry[key] == null ? "—" : String(telemetry[key]));
  $("metricSpeed").textContent = value("speed");
  $("metricLoad").textContent = value("load");
  $("metricVoltage").textContent = telemetry.voltage == null ? "—" : `${telemetry.voltage.toFixed(1)} V`;
  $("metricTemperature").textContent = telemetry.temperature == null ? "—" : `${telemetry.temperature} °C`;
  $("metricCurrent").textContent = telemetry.current == null ? "—" : `${telemetry.current} mA`;
  $("metricMoving").textContent =
    telemetry.moving == null ? "—" : telemetry.moving ? t("yes") : t("no");
}

function updatePosition(position) {
  const clamped = Math.max(0, Math.min(4095, Number(position) || 0));
  $("positionValue").textContent = String(clamped);
  $("positionNeedle").style.left = `${(clamped / 4095) * 100}%`;
  if (document.activeElement !== $("targetInput")) {
    $("targetInput").value = String(clamped);
    $("positionSlider").value = String(clamped);
  }
}

async function refreshSelected({ full = false } = {}) {
  const id = state.selectedId;
  if (id == null || !state.link) return;
  try {
    const positionSpeed = await readRegisters(id, 56, 4);
    if (positionSpeed) {
      const position = decodeWord(positionSpeed.slice(0, 2));
      const speed = toServoWord(decodeWord(positionSpeed.slice(2, 4)), 15);
      state.telemetry.position = position;
      state.telemetry.speed = speed;
      updatePosition(position);
      updateMetrics(state.telemetry);
    }
    if (!full) return;
    const status = await readRegisters(id, 60, 7);
    if (status) {
      state.telemetry.load = toServoWord(decodeWord(status.slice(0, 2)), 10);
      state.telemetry.voltage = status[2] / 10;
      state.telemetry.temperature = status[3];
      state.telemetry.moving = status[6];
    }
    const current = await readRegisters(id, 69, 2);
    if (current) state.telemetry.current = Math.round(decodeWord(current) * 6.5);
    updateMetrics(state.telemetry);
  } catch (error) {
    if (!state.scanBusy) log("warn", t("readFailed"));
  }
}

function startMonitor() {
  stopMonitor();
  if (!$("liveToggle").checked) return;
  state.monitorTick = 0;
  state.monitorTimer = setInterval(async () => {
    if (state.busy || state.scanBusy || state.selectedId == null || !state.link) return;
    state.busy = true;
    state.monitorTick += 1;
    try {
      await refreshSelected({ full: state.monitorTick % 6 === 0 });
    } finally {
      state.busy = false;
    }
  }, 220);
}

function stopMonitor() {
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  state.monitorTimer = null;
}

async function move() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  const position = Math.max(0, Math.min(4095, Number($("targetInput").value)));
  const speed = Math.max(0, Math.min(3400, Number($("speedInput").value)));
  const acc = Math.max(0, Math.min(254, Number($("accInput").value)));
  if (![position, speed, acc].every(Number.isFinite)) {
    log("warn", t("invalidAddress"));
    return;
  }
  try {
    await writeRegisters(id, 40, [1]);
    await writeRegisters(id, 41, [
      acc,
      position & 0xff,
      (position >> 8) & 0xff,
      0, 0,
      speed & 0xff,
      (speed >> 8) & 0xff,
    ]);
    log("ok", t("moved", { position }));
    await refreshSelected({ full: true });
  } catch (error) {
    log("error", t("moveFailed", { message: error.message }));
  }
}

async function setTorque(on) {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  try {
    await writeRegisters(id, 40, [on ? 1 : 0]);
    log("ok", t("torqueSet", { state: on ? "on" : "off" }));
  } catch (error) {
    log("error", t("torqueFailed", { message: error.message }));
  }
}

async function wheel() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  const speed = Math.trunc(Number($("wheelSpeed").value) || 0);
  if (!Number.isFinite(speed)) return;
  const encoded = Math.abs(speed) > 3400 ? Math.sign(speed) * 3400 : speed;
  const word = toServoWord(encoded, 15);
  try {
    await writeRegisters(id, 33, [1]);
    await writeRegisters(id, 41, [50, 0, 0, 0, 0, word & 0xff, (word >> 8) & 0xff]);
    log("ok", t("wheelStarted", { speed }));
  } catch (error) {
    log("error", t("requestFailed", { message: error.message }));
  }
}

/* --- Register table ------------------------------------------------------ */

function renderRegisterTable() {
  const body = $("paramRows");
  body.replaceChildren();
  for (const register of REGISTERS) {
    const row = document.createElement("tr");
    row.dataset.writable = String(register.writable);
    const address = document.createElement("td");
    address.textContent = String(register.address);
    const name = document.createElement("td");
    name.textContent = register.name;
    const value = document.createElement("td");
    const storedValue = state.registerValues.get(register.address);
    value.textContent = storedValue === undefined ? "—" : formatValue(storedValue, register);
    if (storedValue === undefined) value.className = "servo-unread";
    const area = document.createElement("td");
    area.className = "servo-area";
    area.textContent = register.area;
    row.append(address, name, value, area);
    if (register.writable && state.selectedId != null) {
      row.addEventListener("click", () => {
        const current = state.registerValues.get(register.address);
        $("writeAddress").value = `0x${register.address.toString(16)}`;
        $("writeLength").value = String(register.length);
        $("writeValue").value = current == null ? "0" : String(current);
      });
    }
    body.append(row);
  }
}

async function readParameters() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  $("readParams").disabled = true;
  $("paramsHint").textContent = t("paramsReading", { count: REGISTERS.length });
  let read = 0;
  try {
    for (const register of REGISTERS) {
      const data = await readRegisters(id, register.address, register.length);
      if (data) {
        state.registerValues.set(register.address, decodeRegister(register, data));
        read += 1;
      } else {
        state.registerValues.set(register.address, undefined);
      }
    }
    renderRegisterTable();
    $("paramsHint").textContent = t("paramsDone", { count: read });
    log("ok", t("paramsDone", { count: read }));
  } catch (error) {
    $("paramsHint").textContent = t("paramsFailed");
    log("error", t("paramsFailed"));
  } finally {
    $("readParams").disabled = state.mode === "off";
  }
}

function parseNumber(text) {
  const trimmed = String(text).trim();
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return Number.parseInt(trimmed, 16);
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return Number.NaN;
}

async function writeParameter() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  const address = parseNumber($("writeAddress").value);
  const length = Number($("writeLength").value);
  const value = parseNumber($("writeValue").value);
  if (!Number.isInteger(address) || address < 0 || address > 255 ||
      !Number.isInteger(length) || length < 1 || length > 16 ||
      !Number.isFinite(value)) {
    log("warn", t("invalidAddress"));
    return;
  }
  const bytes = [];
  let remaining = value < 0 ? value + 2 ** (length * 8) : value;
  for (let index = 0; index < length; index += 1) {
    bytes.push(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  try {
    await writeRegisters(id, address, bytes);
    log("ok", t("writeDone", { address: `0x${address.toString(16)}` }));
    const register = REGISTERS.find((item) => item.address === address);
    if (register) {
      const data = await readRegisters(id, register.address, register.length);
      if (data) {
        state.registerValues.set(register.address, decodeRegister(register, data));
        renderRegisterTable();
      }
    }
  } catch (error) {
    log("error", t("writeFailed", { message: error.message }));
  }
}

/* --- Wiring -------------------------------------------------------------- */

function wireUi() {
  $("connectButton").addEventListener("click", () => {
    connect().catch((error) => log("error", t("connectFailed", { message: error.message })));
  });
  $("disconnectButton").addEventListener("click", () => {
    disconnect().catch((error) => log("error", error.message));
  });
  $("servoThemeButton").addEventListener("click", () => {
    state.theme = state.theme === "light" ? "dark" : "light";
    applyTheme();
  });
  $("servoLangButton").addEventListener("click", () => {
    state.lang = state.lang === "zh" ? "en" : "zh";
    applyLanguage();
  });
  $("scanButton").addEventListener("click", () => {
    scan().catch((error) => log("error", error.message));
  });
  $("baudApply").addEventListener("click", () => {
    applyUart(Number($("baudSelect").value)).catch((error) =>
      log("error", t("uartFailed", { message: error.message })));
  });
  $("baudRestore").addEventListener("click", () => {
    restoreUart().catch((error) => log("error", error.message));
  });
  $("moveForm").addEventListener("submit", (event) => {
    event.preventDefault();
    move().catch((error) => log("error", error.message));
  });
  $("positionSlider").addEventListener("input", () => {
    $("targetInput").value = $("positionSlider").value;
  });
  $("targetInput").addEventListener("input", () => {
    const value = Number($("targetInput").value);
    if (Number.isFinite(value)) $("positionSlider").value = String(value);
  });
  $("torqueOn").addEventListener("click", () => setTorque(true).catch((error) => log("error", error.message)));
  $("torqueOff").addEventListener("click", () => setTorque(false).catch((error) => log("error", error.message)));
  $("wheelButton").addEventListener("click", () => wheel().catch((error) => log("error", error.message)));
  $("refreshButton").addEventListener("click", () => {
    refreshSelected({ full: true }).catch((error) => log("error", error.message));
  });
  $("liveToggle").addEventListener("change", () => {
    if ($("liveToggle").checked) startMonitor();
    else stopMonitor();
  });
  $("readParams").addEventListener("click", () => {
    readParameters().catch((error) => log("error", error.message));
  });
  $("writeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    writeParameter().catch((error) => log("error", error.message));
  });
  $("logClear").addEventListener("click", () => $("logList").replaceChildren());
}

function boot() {
  applyTheme();
  applyLanguage();
  wireUi();
  setControlsEnabled(false);
  updateMetrics({});
  if (demoRequested) {
    startSimulatedBus().catch((error) => log("error", error.message));
  } else {
    log("info", t("uartHint"));
  }
}

boot();
