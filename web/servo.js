"use strict";

/* Linkr Bee servo bench.
 *
 * A standalone toolbox page: the browser talks BLE to a Linkr Bee, the Bee
 * carries the FEETECH half-duplex bus on J7, and this page implements the SCS/
 * STS packet layer (servo_protocol.js) so no host software is needed. Open it
 * from the terminal's rail or directly at /servo.html.
 *
 * The layout follows the two working tabs of the vendor utility: 调试 (bench)
 * with position control, live feedback, a scrolling chart and an automatic
 * step/sweep test, and 编程 (program) with the register table and parameter
 * save/load/restore. `?demo=servo` swaps the Bee for a loopback bus so the page
 * can be reviewed and tried without hardware; `?lang=` / `?theme=` pin the
 * presentation for screenshot runs.
 */

import { parseManagementHeader } from "./management_protocol.js";
import {
  BROADCAST_ID,
  INSTRUCTION,
  FAMILIES,
  modelInfoFromBytes,
  registersFor,
  wordFromBytes,
  bytesFromWord,
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
const TAB_KEY = "linkr-servo-tab";
const UART_ORIGINAL_KEY = "linkr-servo-uart-original";
const BUS_BAUD = 1000000;
const UART_OPTIONS = [1000000, 500000, 250000, 115200, 76800];
const DEFAULT_TIMEOUT_MS = 250;
const MAX_POSITION = 4095;

/* Chart series. Each uses an existing semantic token rather than a new colour;
 * the value range normalises the trace on the shared canvas. */
const CHANNELS = [
  { key: "position", token: "--accent", label: "positionLabel", min: 0, max: 4095, digits: 0 },
  { key: "load", token: "--tx", label: "torque", min: -1000, max: 1000, digits: 0 },
  { key: "speed", token: "--rx", label: "speed", min: -3400, max: 3400, digits: 0 },
  { key: "current", token: "--warn", label: "current", min: -3000, max: 3000, digits: 0 },
  { key: "temperature", token: "--muted", label: "temperature", min: 0, max: 100, digits: 0 },
  { key: "voltage", token: "--focus", label: "voltage", min: 0, max: 20, digits: 1 },
];

const ERROR_BITS = [
  [1, "errVoltage"],
  [2, "errAngle"],
  [4, "errOverheat"],
  [8, "errOverEle"],
  [32, "errOverload"],
];

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
    tabsAria: "调试与编程",
    tabBench: "调试",
    tabProgram: "编程",
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
    timeoutLabel: "通信超时 (ms)",
    uartHint: "连接后会读取 Bee 的 UART 参数。",
    uartNone: "尚未读取 Bee 的 UART 参数。",
    uartSim: "模拟总线不修改 Bee 的 UART 参数。",
    uartNow: "当前 UART：{spec}",
    uartChanged: "已切换到 {baud}，断开时恢复为 {previous}。",
    uartLeftover: "上次离开时总线仍停在 {spec}（原值 {previous}），已把“恢复”按钮指向原值。",
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
    torqueAllOff: "全部力矩关",
    torqueAllDone: "已对 {count} 个舵机广播松力矩。",
    torqueAllFailed: "广播松力矩失败：{message}",
    refresh: "刷新",
    speed: "速度",
    load: "负载",
    voltage: "电压",
    temperature: "温度",
    current: "电流",
    moving: "运动中",
    positionLabel: "位置",
    torque: "扭矩",
    goalLabel: "目标",
    statusLabel: "状态",
    target: "目标位置",
    speedLabel: "速度",
    accLabel: "加速度",
    timeLabel: "时间 (ms)",
    set: "设置",
    writeMode: "写入方式",
    modeNormal: "普通写",
    modeSync: "同步写",
    modeAsync: "异步写",
    torqueOutput: "扭矩输出",
    asyncExecute: "异步执行",
    asyncPending: "目标已缓存（异步写），点“异步执行”才会动。",
    asyncDone: "已广播异步执行。",
    moveHint: "滑块与数字框同步；普通写完成后会等待舵机停稳。",
    moved: "已移动到 {position}。",
    synced: "同步写：{count} 个舵机 → {position}。",
    moveFailed: "移动失败：{message}",
    wheelSpeed: "轮模式速度",
    motorSpeedLabel: "电机速度",
    wheel: "轮模式",
    motorMode: "电机模式",
    wheelStarted: "已切到轮模式，速度 {speed}。",
    motorStarted: "电机模式：{speed}（SCS 时间寄存器 100–1000，+1024 为反向）。",
    unknownModelBytes: "未知型号（主/次 {bytes}），按 STS 处理。",
    calibrateUnsupported: "该型号没有偏移寄存器，不支持中位校准。",
    factoryReset: "恢复出厂",
    factoryHint: "向 {name} 发送恢复出厂指令（实验性，需真机确认）",
    factoryConfirm: "将向 {name} 发送恢复出厂指令（SCS=0x0A，STS/HD=0x06）。该操作不可撤销，建议先保存参数。确认？",
    factoryDone: "恢复出厂指令已发送，正在重新读取参数。",
    factoryFailed: "恢复出厂失败：{message}",
    torqueSet: "力矩已{state}。",
    torqueFailed: "力矩设置失败：{message}",
    live: "实时监视",
    chartTitle: "实时曲线",
    chartChannels: "曲线通道",
    chartExport: "导出 CSV",
    chartWindow: "时间窗",
    chartEmpty: "开启“实时监视”后开始采样。",
    chartSamples: "{count} 个采样 · 窗口 {window} s",
    autoTitle: "自动调试",
    autoHint: "固定好机构、确认限位后再运行；运行中可用“停止”中断。",
    autoStart: "起始",
    autoEnd: "结束",
    autoSteps: "步数",
    autoStepDelay: "步进延时 (ms)",
    autoSweepDelay: "扫描延时 (ms)",
    autoSweep: "连续扫描",
    autoStep: "步进",
    autoStop: "停止",
    autoConfirm: "自动调试会让舵机连续动作。确认机构固定、周围无障碍、限位合理后再开始？",
    autoRunning: "自动调试中：{mode}，第 {n} 步…",
    autoDone: "自动调试结束（{mode}）。",
    autoStopped: "自动调试已停止。",
    paramsTitle: "参数表",
    onlineLoad: "在线载入",
    saveParams: "保存参数",
    loadParams: "载入参数",
    restoreParams: "恢复参数",
    calibrate: "中位校准",
    paramsHint: "先选择舵机。",
    paramsIdle: "读取 ID {id} 的寄存器。",
    paramsReading: "正在读取 {count} 个寄存器…",
    paramsDone: "已读取 {count} 个寄存器。",
    paramsFailed: "读取参数失败。",
    paramsSaved: "已保存 {count} 项参数：{name}。",
    paramsLoaded: "已载入 {name}，共 {count} 项；点“恢复参数”写回。",
    paramsLoadFailed: "参数文件无效：{message}",
    restoreConfirm: "将把 {count} 项 EEPROM 参数写回 ID {id}（先松力矩、自动解锁/加锁）。确认？",
    restoreDone: "参数已写回并重新读取。",
    restoreFailed: "恢复参数失败：{message}",
    calibrateConfirm: "把当前位置 {position} 设为中位 2048 会改写偏移寄存器（旧值 {old}，可写回恢复）。确认？",
    calibrateDone: "中位校准完成：位置 {before} → {after}，偏移 {old} → {new}。",
    calibrateWorse: "中位校准后位置反而偏离中位（{before} → {after}）；旧偏移 {old} 已记录，可写回地址 0x1F 撤销。",
    calibrateFailed: "中位校准失败：{message}",
    colAddress: "地址",
    colRegister: "寄存器",
    colValue: "值",
    colArea: "区域",
    writeAddress: "地址",
    writeLength: "长度",
    writeValue: "值",
    write: "写入",
    writeHint: "写入 EEPROM（地址 0–39）时会自动解锁、写完加锁；地址/值支持十进制或 0x 十六进制。",
    paramFileHint: "保存/载入为 JSON 参数文件（相当于官方工具的 xdat 备份）；恢复参数只写 EEPROM 区。",
    writeDone: "已写入地址 {address}。",
    writeFailed: "写入失败：{message}",
    readFailed: "读取失败。",
    needConnection: "请先连接 Bee。",
    selectServo: "请先在左侧选择一个舵机。",
    invalidRange: "ID 范围无效，例如 1-12 或 1,3,5。",
    invalidAddress: "地址或数值无效。",
    mgmtTimeout: "Bee 没有回应管理命令。",
    controlClaimed: "已取得控制权。",
    controlOther: "另一个客户端正在控制 Bee，写操作可能被拒绝。",
    controlFailed: "无法取得控制权：{message}",
    requestFailed: "请求失败：{message}",
    commOk: "正常",
    commTimeout: "通信超时",
    errVoltage: "电压",
    errAngle: "角度",
    errOverheat: "过温",
    errOverEle: "过流",
    errOverload: "过载",
    yes: "是",
    no: "否",
    unitV: "{value} V",
    unitC: "{value} °C",
    unitmA: "{value} mA",
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
    tabsAria: "Bench and program",
    tabBench: "Bench",
    tabProgram: "Program",
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
    timeoutLabel: "Reply timeout (ms)",
    uartHint: "The Bee's UART settings are read after connecting.",
    uartNone: "The Bee's UART settings have not been read yet.",
    uartSim: "The simulated bus never changes the Bee's UART settings.",
    uartNow: "UART: {spec}",
    uartChanged: "Switched to {baud}; {previous} is restored on disconnect.",
    uartLeftover: "The bus was left at {spec} last time (original {previous}); Restore now targets the original.",
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
    torqueAllOff: "All torque off",
    torqueAllDone: "Torque released on {count} servo(s).",
    torqueAllFailed: "Broadcast torque release failed: {message}",
    refresh: "Refresh",
    speed: "Speed",
    load: "Load",
    voltage: "Voltage",
    temperature: "Temperature",
    current: "Current",
    moving: "Moving",
    positionLabel: "Position",
    torque: "Torque",
    goalLabel: "Goal",
    statusLabel: "Status",
    target: "Goal position",
    speedLabel: "Speed",
    accLabel: "Acceleration",
    timeLabel: "Time (ms)",
    set: "Set",
    writeMode: "Write mode",
    modeNormal: "Normal",
    modeSync: "Sync",
    modeAsync: "Async",
    torqueOutput: "Torque output",
    asyncExecute: "Run async",
    asyncPending: "Goal queued (async write); press Run async to move it.",
    asyncDone: "Async action broadcast.",
    moveHint: "The slider and the number field stay in sync; a normal write waits for the servo to stop.",
    moved: "Moved to {position}.",
    synced: "Sync write: {count} servo(s) → {position}.",
    moveFailed: "Move failed: {message}",
    wheelSpeed: "Wheel speed",
    motorSpeedLabel: "Motor speed",
    wheel: "Wheel mode",
    motorMode: "Motor mode",
    wheelStarted: "Wheel mode at speed {speed}.",
    motorStarted: "Motor mode: {speed} (SCS time register 100–1000, +1024 reverses).",
    unknownModelBytes: "Unknown model (main/sub {bytes}); treating it as STS.",
    calibrateUnsupported: "This model has no offset register, so midpoint calibration is unavailable.",
    factoryReset: "Factory reset",
    factoryHint: "Send the factory-restore instruction to {name} (experimental; verify on hardware)",
    factoryConfirm: "Send the factory-restore instruction to {name} (SCS=0x0A, STS/HD=0x06). This cannot be undone; save the parameters first. Continue?",
    factoryDone: "Factory-restore instruction sent; re-reading parameters.",
    factoryFailed: "Factory reset failed: {message}",
    torqueSet: "Torque {state}.",
    torqueFailed: "Torque change failed: {message}",
    live: "Live monitor",
    chartTitle: "Live chart",
    chartChannels: "Chart channels",
    chartExport: "Export CSV",
    chartWindow: "Window",
    chartEmpty: "Samples appear while live monitor is on.",
    chartSamples: "{count} samples · {window} s",
    autoTitle: "Auto test",
    autoHint: "Fix the mechanism and check the limits before running; Stop interrupts it.",
    autoStart: "Start",
    autoEnd: "End",
    autoSteps: "Steps",
    autoStepDelay: "Step delay (ms)",
    autoSweepDelay: "Sweep delay (ms)",
    autoSweep: "Sweep",
    autoStep: "Step",
    autoStop: "Stop",
    autoConfirm: "The auto test moves the servo repeatedly. Is the mechanism fixed, the area clear, and the limits sane?",
    autoRunning: "Auto test: {mode}, step {n}…",
    autoDone: "Auto test finished ({mode}).",
    autoStopped: "Auto test stopped.",
    paramsTitle: "Registers",
    onlineLoad: "Read live",
    saveParams: "Save params",
    loadParams: "Load params",
    restoreParams: "Restore params",
    calibrate: "Midpoint calibrate",
    paramsHint: "Select a servo first.",
    paramsIdle: "Read the registers of ID {id}.",
    paramsReading: "Reading {count} registers…",
    paramsDone: "Read {count} registers.",
    paramsFailed: "Reading registers failed.",
    paramsSaved: "Saved {count} parameters: {name}.",
    paramsLoaded: "Loaded {name} with {count} entries; press Restore params to write.",
    paramsLoadFailed: "Invalid parameter file: {message}",
    restoreConfirm: "Write {count} EEPROM parameters back to ID {id} (torque off, unlock/lock automatic)?",
    restoreDone: "Parameters restored and re-read.",
    restoreFailed: "Restore failed: {message}",
    calibrateConfirm: "Set the current position {position} as midpoint 2048 by changing the offset register (old {old}, writable back)?",
    calibrateDone: "Midpoint calibrated: position {before} → {after}, offset {old} → {new}.",
    calibrateWorse: "The position moved away from midpoint ({before} → {after}); old offset {old} is logged and can be written back at 0x1F.",
    calibrateFailed: "Calibration failed: {message}",
    colAddress: "Address",
    colRegister: "Register",
    colValue: "Value",
    colArea: "Area",
    writeAddress: "Address",
    writeLength: "Length",
    writeValue: "Value",
    write: "Write",
    writeHint: "EEPROM writes (addresses 0–39) unlock and lock automatically; address and value accept decimal or 0x hex.",
    paramFileHint: "Save/load writes a JSON parameter file (the xdat equivalent); restore writes the EEPROM area only.",
    writeDone: "Wrote address {address}.",
    writeFailed: "Write failed: {message}",
    readFailed: "Read failed.",
    needConnection: "Connect a Bee first.",
    selectServo: "Select a servo on the left first.",
    invalidRange: "Invalid ID range, for example 1-12 or 1,3,5.",
    invalidAddress: "Invalid address or value.",
    mgmtTimeout: "The Bee did not answer the management command.",
    controlClaimed: "Console control claimed.",
    controlOther: "Another client controls the Bee; writes may be refused.",
    controlFailed: "Could not claim control: {message}",
    requestFailed: "Request failed: {message}",
    commOk: "OK",
    commTimeout: "Timeout",
    errVoltage: "voltage",
    errAngle: "angle",
    errOverheat: "overheat",
    errOverEle: "over-current",
    errOverload: "overload",
    yes: "yes",
    no: "no",
    unitV: "{value} V",
    unitC: "{value} °C",
    unitmA: "{value} mA",
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

function removeStored(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Ignore storage failures. */
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
  info: null,
  selectedId: null,
  telemetry: {},
  registerValues: new Map(),
  loadedParams: null,
  limits: { min: 0, max: MAX_POSITION },
  family: "sts",
  previousUart: null,
  currentUart: null,
  uartTouched: false,
  busy: false,
  monitorTimer: null,
  monitorTick: 0,
  scanBusy: false,
  userSelected: false,
  lastScan: null,
  auto: null,
  pendingAsync: false,
  chart: { samples: [], raf: 0, channels: new Set(["position", "speed", "load"]) },
  lang: initialLang,
  theme: initialTheme,
};

/* --- Presentation -------------------------------------------------------- */

function applyTheme() {
  colorCache.clear();
  document.documentElement.dataset.theme = state.theme;
  const meta = $("themeColorMeta");
  if (meta) meta.content = state.theme === "light" ? "#E2E9F4" : "#05080D";
  store(THEME_KEY, state.theme);
  renderChart();
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
  renderLegend();
  updateUartHint();
  updateMetrics(state.telemetry);
  if (state.lastScan) {
    $("scanHint").textContent = state.lastScan.count
      ? t("scanDone", { count: state.lastScan.count })
      : t("scanNone");
  } else {
    $("scanHint").textContent = t("notScanned");
  }
  renderParamsHint();
  syncFamilyUi();
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

function modelLabel(servo) {
  const info = servo?.info;
  if (!info || !info.known) return t("unknownModel");
  return `${info.name} · ${info.label}`;
}

function lockAddress() {
  return state.info?.lock ?? 55;
}

function familyInfo() {
  return state.info || FAMILIES.sts;
}

/* Keep the controls and register table in step with the selected family. */
function syncFamilyUi() {
  const info = familyInfo();
  state.limits = { min: 0, max: info.positionMax };
  for (const id of ["positionSlider", "targetInput", "autoStart", "autoEnd"]) {
    $(id).max = String(info.positionMax);
  }
  $("positionMax").textContent = `/ ${info.positionMax}`;
  const motorFamily = info.family === "scs";
  $("wheelButton").textContent = motorFamily ? t("motorMode") : t("wheel");
  $("wheelSpeedLabel").textContent = motorFamily ? t("motorSpeedLabel") : t("wheelSpeed");
  $("accInput").closest("label").hidden = motorFamily;
  for (const id of ["targetInput", "autoStart", "autoEnd"]) {
    if (Number($(id).value) > info.positionMax) $(id).value = String(info.positionMax);
  }
  $("calibrateButton").disabled =
    state.mode === "off" || state.selectedId == null || !info.offset;
  $("calibrateButton").title = info.offset ? "" : t("calibrateUnsupported");
  $("factoryReset").title = t("factoryHint", { name: info.name });
  renderRegisterTable();
  scheduleChart();
}

function requestTimeout() {
  const value = Number($("timeoutInput").value);
  return Number.isFinite(value) ? Math.min(3000, Math.max(50, value)) : DEFAULT_TIMEOUT_MS;
}

function clampPosition(value) {
  const number = Number(value);
  const base = Number.isFinite(number) ? number : state.limits.min;
  return Math.max(state.limits.min, Math.min(state.limits.max, Math.round(base)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      const original = stored(UART_ORIGINAL_KEY, "");
      if (original) {
        state.previousUart = original;
        if (spec !== original) log("warn", t("uartLeftover", { spec, previous: original }));
      } else {
        state.previousUart = spec;
      }
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
  } else if (state.currentUart) {
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
    if (!state.uartTouched) store(UART_ORIGINAL_KEY, previous || state.currentUart || "");
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
    removeStored(UART_ORIGINAL_KEY);
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
    /* Idle hand-over covers a failed release. */
  }
}

/* --- Connection lifecycle ------------------------------------------------ */

function setControlsEnabled(enabled) {
  const ids = [
    "torqueOn", "torqueOff", "torqueAllOff", "refreshButton", "readParams", "saveParams",
    "restoreParams", "calibrateButton", "factoryReset", "writeButton", "moveButton",
    "wheelButton", "scanButton", "positionSlider", "asyncExecute",
    "autoSweep", "autoStep",
  ];
  for (const id of ids) {
    const element = $(id);
    if (!element) continue;
    if (id === "asyncExecute") {
      element.disabled = !enabled || !state.pendingAsync;
      continue;
    }
    if (id === "restoreParams") {
      element.disabled = !enabled || !state.loadedParams;
      continue;
    }
    element.disabled = !enabled;
  }
  if (!familyInfo().offset) $("calibrateButton").disabled = true;
  $("connectButton").disabled = enabled;
  $("disconnectButton").hidden = !enabled;
  $("baudApply").disabled = !enabled || state.mode === "sim";
  $("baudRestore").disabled = !enabled || state.mode === "sim";
}

function onConnected() {
  syncLinkText();
  setControlsEnabled(true);
  $("linkHint").textContent = state.mode === "sim" ? t("uartSim") : t("linkHint");
  $("disconnectButton").hidden = false;
  $("connectButton").hidden = true;
  updateUartHint();
  setTab(stored(TAB_KEY, "bench") === "program" ? "program" : "bench");
}

function resetUi() {
  stopMonitor();
  stopAuto({ silent: true });
  state.mode = "off";
  state.link = null;
  state.transport = null;
  state.deviceId = null;
  state.deviceName = "";
  state.simBus = null;
  state.servos.clear();
  state.selectedId = null;
  state.info = null;
  state.telemetry = {};
  state.registerValues.clear();
  state.loadedParams = null;
  state.limits = { min: 0, max: MAX_POSITION };
  state.previousUart = null;
  state.currentUart = null;
  state.uartTouched = false;
  state.pendingAsync = false;
  state.chart.samples = [];
  syncLinkText();
  setControlsEnabled(false);
  $("connectButton").hidden = false;
  $("disconnectButton").hidden = true;
  $("scanHint").textContent = t("notScanned");
  $("selectedId").textContent = "—";
  $("selectedModel").textContent = t("noServo");
  $("positionMax").textContent = `/ ${FAMILIES.sts.positionMax}`;
  $("wheelButton").textContent = t("wheel");
  $("positionValue").textContent = "—";
  updateMetrics({});
  renderServoList();
  renderRegisterTable();
  renderParamsHint();
  renderChart();
  updateUartHint();
  $("moveHint").textContent = t("moveHint");
  $("actionHint").textContent = "";
  $("autoHint").textContent = "";
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
    state.link = new ServoLink({ write: sendUart, echo: true, timeoutMs: requestTimeout() });
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
  const bus = new SimulatedBus({
    ids: [1, 2, 3, 4, 5, 6],
    models: { 6: 1029 },
    echo: true,
    latencyMs: 3,
  });
  const link = new ServoLink({ write: (bytes) => bus.write(bytes), echo: true, timeoutMs: requestTimeout() });
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
  stopAuto({ silent: true });
  const wasBle = state.mode === "ble";
  const previous = state.previousUart;
  const restore = wasBle && state.uartTouched && previous;
  try {
    /* The vendor tool also releases torque before closing; a disconnected page
     * must not leave the servos holding a goal. */
    if (wasBle) await releaseAllTorque({ silent: true });
  } catch {
    /* A dead link cannot be told to release. */
  }
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
  if (restore) {
    removeStored(UART_ORIGINAL_KEY);
    log("ok", t("uartRestored", { spec: previous }));
  }
  resetUi();
}

/* --- Servo operations ---------------------------------------------------- */

function selectedServo() {
  return state.selectedId == null ? null : state.servos.get(state.selectedId) || null;
}

async function readRegisters(id, address, length, timeoutMs) {
  const frame = await state.link.request(
    id,
    INSTRUCTION.read,
    [address, length],
    { timeoutMs: timeoutMs ?? requestTimeout() },
  );
  return frame ? frame.data : null;
}

async function writeRegisters(id, address, values, timeoutMs) {
  const frame = await state.link.request(
    id,
    INSTRUCTION.write,
    [address, ...values],
    { timeoutMs: timeoutMs ?? requestTimeout() },
  );
  return Boolean(frame);
}

async function readError(id) {
  const frame = await state.link.request(id, INSTRUCTION.read, [56, 15], {
    timeoutMs: requestTimeout(),
  });
  return frame?.error ?? 0;
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
  state.userSelected = false;
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
      await sleep(0);
      const frame = await state.link.request(id, INSTRUCTION.ping, [], { timeoutMs: 90 });
      if (!frame) continue;
      let info = null;
      const modelData = await state.link.request(id, INSTRUCTION.read, [3, 2], {
        timeoutMs: requestTimeout(),
      });
      if (modelData) info = modelInfoFromBytes(modelData.data);
      else info = modelInfoFromBytes([0, 0]);
      state.servos.set(id, { info });
      state.lastScan = { range: rangeText, count: state.servos.size };
      log("ok", t("servoFound", { id, model: modelLabel({ info }) }));
      if (!info.known) log("warn", t("unknownModelBytes", { bytes: `${info.bytes[0]}/${info.bytes[1]}` }));
      renderServoList();
    }
    state.lastScan = { range: rangeText, count: state.servos.size };
    if (state.servos.size === 0) {
      $("scanHint").textContent = t("scanNone");
    } else {
      $("scanHint").textContent = t("scanDone", { count: state.servos.size });
      if (!state.userSelected) {
        const first = [...state.servos.keys()][0];
        await selectServo(first);
      }
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
  state.info = state.servos.get(id)?.info || null;
  state.registerValues.clear();
  state.loadedParams = null;
  state.telemetry = {};
  state.chart.samples = [];
  $("chartEmpty").hidden = false;
  updateChartStats();
  renderServoList();
  renderSelectedHeader();
  renderRegisterTable();
  renderParamsHint();
  syncFamilyUi();
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
    model.textContent = modelLabel(servo);
    item.append(badge, model);
    item.addEventListener("click", () => {
      /* Selecting during a scan is allowed: the link serializes requests and
       * the scan keeps filling the list. */
      if (!state.servos.has(id)) return;
      state.userSelected = true;
      selectServo(id).catch((error) => log("error", error.message));
    });
    list.append(item);
  }
}

function renderSelectedHeader() {
  const servo = selectedServo();
  $("selectedId").textContent = servo ? String(state.selectedId).padStart(3, "0") : "—";
  $("selectedModel").textContent = servo ? modelLabel(servo) : t("noServo");
}

function errorText(error) {
  if (!error) return t("commOk");
  const names = ERROR_BITS.filter(([bit]) => error & bit).map(([, key]) => t(key));
  return names.length ? names.join(" / ") : `0x${error.toString(16)}`;
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
  $("metricGoal").textContent = value("goal");
  const failure = telemetry.comm === "timeout" || telemetry.error;
  $("metricStatus").textContent = telemetry.comm === "timeout"
    ? t("commTimeout")
    : errorText(telemetry.error);
  $("metricStatus").classList.toggle("is-bad", Boolean(failure));
}

function updatePosition(position) {
  const clamped = clampPosition(position);
  $("positionValue").textContent = String(clamped);
  const span = Math.max(1, state.limits.max - state.limits.min);
  $("positionNeedle").style.left = `${((clamped - state.limits.min) / span) * 100}%`;
  if (document.activeElement !== $("targetInput")) {
    $("targetInput").value = String(clamped);
    $("positionSlider").value = String(clamped);
  }
}

async function refreshSelected({ full = false } = {}) {
  const id = state.selectedId;
  if (id == null || !state.link) return;
  try {
    const endian = familyInfo().endian;
    const frame = await state.link.request(id, INSTRUCTION.read, [56, 15], {
      timeoutMs: requestTimeout(),
    });
    if (!frame) {
      state.telemetry.comm = "timeout";
      updateMetrics(state.telemetry);
      return;
    }
    const data = frame.data;
    const telemetry = {
      comm: "ok",
      error: frame.error,
      position: wordFromBytes(data.slice(0, 2), endian),
      speed: toServoWord(wordFromBytes(data.slice(2, 4), endian), 15),
      load: toServoWord(wordFromBytes(data.slice(4, 6), endian), 10),
      voltage: data[6] / 10,
      temperature: data[7],
      moving: data[10],
      current: Math.round(wordFromBytes(data.slice(13, 15), endian) * 6.5),
    };
    if (full) {
      const goalData = await readRegisters(id, 42, 2);
      if (goalData) telemetry.goal = wordFromBytes(goalData, endian);
    } else {
      telemetry.goal = state.telemetry.goal;
    }
    state.telemetry = { ...state.telemetry, ...telemetry };
    updatePosition(telemetry.position);
    updateMetrics(state.telemetry);
    pushSample(state.telemetry);
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
  }, 200);
}

function stopMonitor() {
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  state.monitorTimer = null;
}

/* --- Motion -------------------------------------------------------------- */

function movePayload(position, speed, acc, timeMs) {
  if (familyInfo().family === "scs") {
    return [
      ...bytesFromWord(position, "big"),
      ...bytesFromWord(timeMs, "big"),
      ...bytesFromWord(speed, "big"),
    ];
  }
  return [
    acc & 0xff,
    ...bytesFromWord(position, "little"),
    ...bytesFromWord(timeMs, "little"),
    ...bytesFromWord(speed, "little"),
  ];
}

async function waitUntilStopped(id, timeoutMs = 3000) {
  if (state.mode === "sim") return true;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const data = await readRegisters(id, 66, 1);
    if (!data) return false;
    if ((data[0] & 1) === 0) return true;
    await sleep(80);
  }
  return false;
}

async function moveTo(position, { wait = false, silent = false, mode } = {}) {
  const id = state.selectedId;
  if (id == null || !state.link) throw new Error(t("selectServo"));
  const target = clampPosition(position);
  const speed = Math.max(0, Math.min(3400, Number($("speedInput").value) || 0));
  const acc = Math.max(0, Math.min(254, Number($("accInput").value) || 0));
  const timeMs = Math.max(0, Math.min(65535, Number($("timeInput").value) || 0));
  const payload = movePayload(target, speed, acc, timeMs);
  const motion = familyInfo().motion;
  const writeMode = mode || document.querySelector('input[name="writeMode"]:checked')?.value || "normal";
  if (writeMode === "sync") {
    const servoIds = [...state.servos.keys()];
    const syncParams = [motion.start, motion.length];
    for (const servoId of servoIds) syncParams.push(servoId, ...payload);
    await state.link.send(BROADCAST_ID, INSTRUCTION.syncWrite, syncParams);
    if (!silent) {
      log("ok", t("synced", { count: servoIds.length, position: target }));
      $("moveHint").textContent = t("synced", { count: servoIds.length, position: target });
    }
    return target;
  }
  if (writeMode === "async") {
    await state.link.request(id, INSTRUCTION.regWrite, [motion.start, ...payload], {
      timeoutMs: requestTimeout(),
    });
    state.pendingAsync = true;
    setControlsEnabled(state.mode !== "off");
    if (!silent) {
      log("info", t("asyncPending"));
      $("moveHint").textContent = t("asyncPending");
    }
    return target;
  }
  const ok = await writeRegisters(id, motion.start, payload);
  if (!ok) throw new Error(t("commTimeout"));
  if (!silent) {
    log("ok", t("moved", { position: target }));
    $("moveHint").textContent = t("moved", { position: target });
  }
  if (wait) await waitUntilStopped(id);
  return target;
}

async function submitMove() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  try {
    if ($("torqueOutput").checked) await setTorque(true, { silent: true });
    const target = clampPosition($("targetInput").value);
    const mode = document.querySelector('input[name="writeMode"]:checked')?.value || "normal";
    await moveTo(target, { wait: mode === "normal" });
    await refreshSelected({ full: true });
  } catch (error) {
    log("error", t("moveFailed", { message: error.message }));
  }
}

async function runAsyncAction() {
  if (!state.link) return;
  try {
    await state.link.send(BROADCAST_ID, INSTRUCTION.action, []);
    state.pendingAsync = false;
    setControlsEnabled(state.mode !== "off");
    log("ok", t("asyncDone"));
    $("moveHint").textContent = t("asyncDone");
    await refreshSelected({ full: true });
  } catch (error) {
    log("error", t("requestFailed", { message: error.message }));
  }
}

async function setTorque(on, { silent = false } = {}) {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  try {
    await writeRegisters(id, 40, [on ? 1 : 0]);
    if (!silent) log("ok", t("torqueSet", { state: on ? "on" : "off" }));
  } catch (error) {
    log("error", t("torqueFailed", { message: error.message }));
  }
}

async function releaseAllTorque({ silent = false } = {}) {
  const ids = [...state.servos.keys()];
  if (ids.length === 0 || !state.link) return;
  const params = [40, 1];
  for (const id of ids) params.push(id, 0);
  await state.link.send(BROADCAST_ID, INSTRUCTION.syncWrite, params);
  if (!silent) log("ok", t("torqueAllDone", { count: ids.length }));
  else log("info", t("torqueAllDone", { count: ids.length }));
}

async function wheel() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  const speed = Math.trunc(Number($("wheelSpeed").value) || 0);
  if (!Number.isFinite(speed)) return;
  try {
    if (familyInfo().family === "scs") {
      /* SCS motor mode: zero the angle limits, then the goal-time register
       * carries 100..1000 for one direction and +1024 for the other. */
      const magnitude = Math.max(100, Math.min(1000, Math.abs(speed) || 100));
      const value = speed < 0 ? magnitude + 1024 : magnitude;
      await writeRegisters(id, 9, [0, 0, 0, 0]);
      await writeRegisters(id, 44, bytesFromWord(value, "big"));
      log("ok", t("motorStarted", { speed: speed < 0 ? -magnitude : magnitude }));
      return;
    }
    const encoded = Math.abs(speed) > 3400 ? Math.sign(speed) * 3400 : speed;
    const word = toServoWord(encoded, 15);
    await writeRegisters(id, 33, [1]);
    await writeRegisters(id, 41, [50, 0, 0, 0, 0, word & 0xff, (word >> 8) & 0xff]);
    log("ok", t("wheelStarted", { speed }));
  } catch (error) {
    log("error", t("requestFailed", { message: error.message }));
  }
}

/* --- Auto test ----------------------------------------------------------- */

function setAutoButtons(running) {
  const enabled = state.mode !== "off" && state.selectedId != null;
  $("autoSweep").disabled = !enabled || running;
  $("autoStep").disabled = !enabled || running;
  $("autoStop").disabled = !running;
}

async function runAuto(mode) {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  if (!window.confirm(t("autoConfirm"))) return;
  if (state.auto) return;
  const start = clampPosition($("autoStart").value);
  const end = clampPosition($("autoEnd").value);
  const steps = Math.max(1, Math.min(500, Number($("autoSteps").value) || 10));
  const stepDelay = Math.max(0, Math.min(10000, Number($("autoStepDelay").value) || 0));
  const sweepDelay = Math.max(0, Math.min(60000, Number($("autoSweepDelay").value) || 0));
  state.auto = { stop: false, mode };
  setAutoButtons(true);
  try {
    if ($("torqueOutput").checked) await setTorque(true, { silent: true });
    if (mode === "step") {
      for (let index = 1; index <= steps; index += 1) {
        if (state.auto.stop) break;
        const position = Math.round(start + ((end - start) * index) / steps);
        $("autoHint").textContent = t("autoRunning", { mode: t("autoStep"), n: `${index}/${steps}` });
        await moveTo(position, { silent: true, mode: "normal" });
        await sleep(stepDelay);
      }
    } else {
      let up = true;
      let cycles = 0;
      while (!state.auto.stop) {
        cycles += 1;
        $("autoHint").textContent = t("autoRunning", { mode: t("autoSweep"), n: cycles });
        await moveTo(up ? end : start, { silent: true, mode: "normal" });
        await sleep(sweepDelay);
        up = !up;
      }
    }
    if (state.auto?.stop) log("info", t("autoStopped"));
    else log("ok", t("autoDone", { mode: t(mode === "step" ? "autoStep" : "autoSweep") }));
    $("autoHint").textContent = state.auto?.stop
      ? t("autoStopped")
      : t("autoDone", { mode: t(mode === "step" ? "autoStep" : "autoSweep") });
  } catch (error) {
    log("error", t("moveFailed", { message: error.message }));
  } finally {
    state.auto = null;
    setAutoButtons(false);
    await refreshSelected({ full: true }).catch(() => {});
  }
}

function stopAuto({ silent = false } = {}) {
  if (state.auto) {
    state.auto.stop = true;
    if (!silent) log("info", t("autoStopped"));
  }
  setAutoButtons(false);
}

/* --- Chart --------------------------------------------------------------- */

function pushSample(telemetry) {
  if (telemetry.position == null) return;
  const now = Date.now() / 1000;
  state.chart.samples.push({
    t: now,
    position: telemetry.position,
    speed: telemetry.speed ?? 0,
    load: telemetry.load ?? 0,
    voltage: telemetry.voltage ?? 0,
    temperature: telemetry.temperature ?? 0,
    current: telemetry.current ?? 0,
  });
  if (state.chart.samples.length > 8000) state.chart.samples.splice(0, 2000);
  $("chartEmpty").hidden = true;
  scheduleChart();
  updateChartStats();
}

function updateChartStats() {
  const windowSeconds = state.chart.window || Number($("chartWindow").value) || 30;
  $("chartStats").textContent = state.chart.samples.length
    ? t("chartSamples", {
      count: state.chart.samples.length,
      window: windowSeconds.toFixed(windowSeconds < 10 ? 1 : 0),
    })
    : "";
}

function scheduleChart() {
  if (state.chart.raf) return;
  state.chart.raf = requestAnimationFrame(() => {
    state.chart.raf = 0;
    renderChart();
  });
}

const colorCache = new Map();

/* Custom properties may hold another var() (--accent is rgb(var(--accent-rgb))),
 * which canvas cannot parse. Resolve through a hidden element instead. */
function tokenColor(name) {
  const cached = colorCache.get(name);
  if (cached && !state.themeChanged) return cached;
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;width:0;height:0;color:var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  colorCache.set(name, color);
  return color;
}

function renderChart() {
  const canvas = $("chartCanvas");
  if (!canvas) return;
  const width = canvas.clientWidth || 720;
  const height = canvas.clientHeight || 260;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const pad = 10;
  const grid = tokenColor("--line-soft") || "rgba(128,128,128,0.2)";
  const label = tokenColor("--placeholder") || "#888";
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  for (let index = 0; index <= 4; index += 1) {
    const y = pad + ((height - pad * 2) * index) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const requestedWindow = Number($("chartWindow").value) || 30;
  const samples = state.chart.samples;
  if (samples.length === 0) {
    $("chartEmpty").hidden = false;
    return;
  }
  const now = samples[samples.length - 1].t;
  /* With only a few samples the requested window would leave the trace as a
   * sliver at the right edge, so shrink to the data for the first seconds. */
  const collected = Math.max(0.5, now - samples[0].t);
  const windowSeconds = Math.min(requestedWindow, Math.max(2, collected * 1.05));
  state.chart.window = windowSeconds;
  const start = now - windowSeconds;
  for (const channel of CHANNELS) {
    if (!state.chart.channels.has(channel.key)) continue;
    ctx.strokeStyle = tokenColor(channel.token) || "#8ab";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    for (const sample of samples) {
      if (sample.t < start) continue;
      const ratio = (sample.t - start) / windowSeconds;
      const x = pad + ratio * (width - pad * 2);
      const channelMax = channel.key === "position"
        ? (familyInfo().positionMax || channel.max)
        : channel.max;
      const span = channelMax - channel.min;
      const normalised = Math.max(0, Math.min(1, (sample[channel.key] - channel.min) / span));
      const y = height - pad - normalised * (height - pad * 2);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (started) ctx.stroke();
  }
  ctx.fillStyle = label;
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText(`-${windowSeconds.toFixed(1)}s`, pad, height - 1);
  ctx.fillText("now", width - pad - 20, height - 1);
  $("chartEmpty").hidden = true;
  updateLegendValues();
  updateChartStats();
}

function renderLegend() {
  const legend = $("chartLegend");
  if (!legend) return;
  legend.replaceChildren();
  for (const channel of CHANNELS) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.chart.channels.has(channel.key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.chart.channels.add(channel.key);
      else state.chart.channels.delete(channel.key);
      scheduleChart();
    });
    const chip = document.createElement("i");
    chip.style.color = `var(${channel.token})`;
    const text = document.createElement("span");
    text.textContent = t(channel.label);
    const value = document.createElement("strong");
    value.dataset.channel = channel.key;
    value.textContent = "—";
    label.append(checkbox, chip, text, value);
    legend.append(label);
  }
  updateLegendValues();
}

function updateLegendValues() {
  for (const channel of CHANNELS) {
    const value = $("chartLegend")?.querySelector(`strong[data-channel="${channel.key}"]`);
    if (!value) continue;
    const current = state.telemetry[channel.key];
    value.textContent = current == null
      ? "—"
      : current.toFixed(channel.digits);
  }
}

function exportChart() {
  if (state.chart.samples.length === 0) {
    log("warn", t("chartEmpty"));
    return;
  }
  const header = "time_s,position,speed,load,voltage_V,temperature_C,current_mA";
  const rows = state.chart.samples.map((sample) =>
    [
      sample.t.toFixed(3),
      sample.position,
      sample.speed,
      sample.load,
      sample.voltage.toFixed(1),
      sample.temperature,
      sample.current,
    ].join(","),
  );
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `servo-chart-ID${state.selectedId ?? "x"}-${new Date().toISOString().slice(0, 19).replaceAll(":", "")}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

/* --- Parameter table, save/load, calibration ----------------------------- */

function renderParamsHint() {
  if (state.selectedId == null) {
    $("paramsHint").textContent = t("paramsHint");
    return;
  }
  if (state.loadedParams) {
    $("paramsHint").textContent = t("paramsLoaded", {
      name: state.loadedParams.modelName || state.loadedParams.model || "?",
      count: Object.keys(state.loadedParams.registers || {}).length,
    });
    return;
  }
  if (state.registerValues.size) {
    $("paramsHint").textContent = t("paramsDone", { count: state.registerValues.size });
    return;
  }
  $("paramsHint").textContent = t("paramsIdle", {
    id: String(state.selectedId).padStart(3, "0"),
  });
}

function renderRegisterTable() {
  const body = $("paramRows");
  body.replaceChildren();
  for (const register of registersFor(state.info)) {
    const row = document.createElement("tr");
    row.dataset.writable = String(register.writable);
    const address = document.createElement("td");
    address.textContent = String(register.address);
    const name = document.createElement("td");
    name.textContent = register.name;
    const value = document.createElement("td");
    const storedValue = state.registerValues.get(register.address);
    if (storedValue !== undefined && register.address === 3 && state.info?.known) {
      value.textContent = `${state.info.name} (${state.info.bytes[0]}/${state.info.bytes[1]})`;
    } else {
      value.textContent = storedValue === undefined ? "—" : formatRegister(storedValue, register);
    }
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
        $("writeButton").disabled = false;
      });
    }
    body.append(row);
  }
}

function formatRegister(value, register) {
  if (register.unit === "V") return `${value.toFixed(1)} V`;
  if (register.unit === "°C") return `${value} °C`;
  if (register.unit === "mA") return `${value} mA`;
  return String(value);
}

function applyLimits(minAngle, maxAngle) {
  const info = familyInfo();
  const min = Number.isFinite(minAngle) && minAngle >= 0 ? minAngle : 0;
  const fallback = info.positionMax;
  const max = Number.isFinite(maxAngle) && maxAngle > min ? maxAngle : fallback;
  state.limits = { min, max };
  for (const id of ["positionSlider", "targetInput", "autoStart", "autoEnd"]) {
    $(id).min = "0";
    $(id).max = String(info.positionMax);
  }
  $("positionMax").textContent = `/ ${info.positionMax}`;
  if (Number($("targetInput").value) > max || Number($("targetInput").value) < min) {
    $("targetInput").value = String(clampPosition($("targetInput").value));
    $("positionSlider").value = $("targetInput").value;
  }
}

async function readParameters() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  $("readParams").disabled = true;
  const registers = registersFor(state.info);
  const endian = familyInfo().endian;
  $("paramsHint").textContent = t("paramsReading", { count: registers.length });
  let read = 0;
  try {
    for (const register of registers) {
      const data = await readRegisters(id, register.address, register.length);
      if (data) {
        const value = decodeRegister(register, data, endian);
        state.registerValues.set(register.address, value);
        read += 1;
        if (register.address === 3) {
          const info = modelInfoFromBytes(data);
          const servo = state.servos.get(id);
          if (servo) servo.info = info;
          state.info = info;
          syncFamilyUi();
          renderSelectedHeader();
          renderServoList();
        }
      } else {
        state.registerValues.delete(register.address);
      }
    }
    renderRegisterTable();
    renderParamsHint();
    applyLimits(
      state.registerValues.get(9),
      state.registerValues.get(11),
    );
    log("ok", t("paramsDone", { count: read }));
  } catch (error) {
    $("paramsHint").textContent = t("paramsFailed");
    log("error", t("paramsFailed"));
  } finally {
    $("readParams").disabled = state.mode === "off";
  }
}

function parameterFileName() {
  const servo = selectedServo();
  const name = servo?.info?.name || "servo";
  return `${name}_ID${state.selectedId ?? "x"}.json`;
}

async function saveParameters() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  if (state.registerValues.size === 0) await readParameters();
  const servo = selectedServo();
  const registers = {};
  for (const register of registersFor(state.info)) {
    if (state.registerValues.has(register.address)) {
      registers[register.address] = state.registerValues.get(register.address);
    }
  }
  const payload = {
    format: "linkr-servo-params",
    version: 1,
    model: servo?.info?.model ?? 0,
    modelName: servo?.info?.name || "unknown",
    family: familyInfo().key,
    servoId: id,
    savedAt: new Date().toISOString(),
    registers,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = parameterFileName();
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  log("ok", t("paramsSaved", { count: Object.keys(registers).length, name: anchor.download }));
}

async function loadParameterFile(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed?.format !== "linkr-servo-params" || !parsed.registers) {
      throw new Error("format");
    }
    state.loadedParams = parsed;
    renderParamsHint();
    setControlsEnabled(state.mode !== "off");
    log("ok", t("paramsLoaded", {
      name: parsed.modelName || parsed.model || file.name,
      count: Object.keys(parsed.registers).length,
    }));
  } catch (error) {
    log("error", t("paramsLoadFailed", { message: error.message }));
  }
}

async function restoreParameters() {
  const id = state.selectedId;
  const loaded = state.loadedParams;
  if (id == null || !loaded) {
    log("warn", t("selectServo"));
    return;
  }
  const endian = familyInfo().endian;
  const entries = registersFor(state.info).filter(
    (register) => register.writable && register.area === "eeprom" &&
      loaded.registers[register.address] != null,
  );
  if (entries.length === 0) return;
  if (!window.confirm(t("restoreConfirm", { count: entries.length, id }))) return;
  try {
    await setTorque(false, { silent: true });
    await writeRegisters(id, lockAddress(), [0]);
    for (const register of entries) {
      await writeRegisters(
        id,
        register.address,
        encodeRegister(register, loaded.registers[register.address], endian),
      );
    }
    await writeRegisters(id, lockAddress(), [1]);
    await readParameters();
    log("ok", t("restoreDone"));
  } catch (error) {
    log("error", t("restoreFailed", { message: error.message }));
  }
}

async function factoryReset() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  const info = familyInfo();
  if (!window.confirm(t("factoryConfirm", { name: info.name }))) return;
  try {
    const frame = await state.link.request(id, info.factory, [], { timeoutMs: 2000 });
    if (!frame) throw new Error(t("commTimeout"));
    log("ok", t("factoryDone"));
    await readParameters();
  } catch (error) {
    log("error", t("factoryFailed", { message: error.message }));
  }
}

async function calibrateMidpoint() {
  const id = state.selectedId;
  if (id == null) {
    log("warn", t("selectServo"));
    return;
  }
  const info = familyInfo();
  if (!info.offset) {
    log("warn", t("calibrateUnsupported"));
    return;
  }
  const endian = info.endian;
  try {
    const positionData = await readRegisters(id, 56, 2);
    const offsetData = await readRegisters(id, info.offset, 2);
    if (!positionData || !offsetData) throw new Error(t("commTimeout"));
    const before = wordFromBytes(positionData, endian);
    const oldOffset = toServoWord(wordFromBytes(offsetData, endian), 11);
    if (!window.confirm(t("calibrateConfirm", { position: before, old: oldOffset }))) return;
    let newOffset = oldOffset + (before - 2048);
    if (newOffset > 1023) newOffset -= 2048;
    if (newOffset < -1024) newOffset += 2048;
    const word = toServoWord(newOffset, 11);
    await writeRegisters(id, info.lock, [0]);
    await writeRegisters(id, info.offset, bytesFromWord(word, endian));
    await writeRegisters(id, info.lock, [1]);
    const afterData = await readRegisters(id, 56, 2);
    const after = afterData ? wordFromBytes(afterData, endian) : NaN;
    if (Number.isFinite(after) && Math.abs(after - 2048) > Math.abs(before - 2048)) {
      log("warn", t("calibrateWorse", { before, after, old: oldOffset }));
    } else {
      log("ok", t("calibrateDone", {
        before,
        after: Number.isFinite(after) ? after : "?",
        old: oldOffset,
        new: newOffset,
      }));
    }
    await refreshSelected({ full: true });
    renderRegisterTable();
  } catch (error) {
    log("error", t("calibrateFailed", { message: error.message }));
  }
}

/* --- Register write form ------------------------------------------------- */

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
  const endian = familyInfo().endian;
  const address = parseNumber($("writeAddress").value);
  const length = Number($("writeLength").value);
  const value = parseNumber($("writeValue").value);
  if (!Number.isInteger(address) || address < 0 || address > 255 ||
      !Number.isInteger(length) || length < 1 || length > 16 ||
      !Number.isFinite(value)) {
    log("warn", t("invalidAddress"));
    return;
  }
  try {
    const eeprom = address < 40;
    const register = registersFor(state.info).find((item) => item.address === address);
    const bytes = register
      ? encodeRegister(register, value, endian)
      : (() => {
        const raw = [];
        let remaining = value < 0 ? value + 2 ** (length * 8) : value;
        for (let index = 0; index < length; index += 1) {
          raw.push(remaining & 0xff);
          remaining = Math.floor(remaining / 256);
        }
        return raw;
      })();
    if (eeprom) {
      await setTorque(false, { silent: true });
      await writeRegisters(id, lockAddress(), [0]);
    }
    await writeRegisters(id, address, bytes);
    if (eeprom) await writeRegisters(id, lockAddress(), [1]);
    log("ok", t("writeDone", { address: `0x${address.toString(16)}` }));
    if (register) {
      const data = await readRegisters(id, register.address, register.length);
      if (data) {
        state.registerValues.set(register.address, decodeRegister(register, data, endian));
        renderRegisterTable();
        renderParamsHint();
      }
    }
  } catch (error) {
    log("error", t("writeFailed", { message: error.message }));
  }
}

/* --- Tabs ---------------------------------------------------------------- */

function setTab(name) {
  for (const button of document.querySelectorAll("[data-servo-tab]")) {
    const active = button.dataset.servoTab === name;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const page of document.querySelectorAll("[data-servo-page]")) {
    page.hidden = page.dataset.servoPage !== name;
  }
  store(TAB_KEY, name);
  if (name === "bench") scheduleChart();
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
  $("timeoutInput").addEventListener("change", () => {
    const timeout = requestTimeout();
    $("timeoutInput").value = String(timeout);
    if (state.link) state.link.timeoutMs = timeout;
  });
  $("moveForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitMove().catch((error) => log("error", error.message));
  });
  $("positionSlider").addEventListener("input", () => {
    $("targetInput").value = $("positionSlider").value;
  });
  $("targetInput").addEventListener("input", () => {
    const value = Number($("targetInput").value);
    if (Number.isFinite(value)) $("positionSlider").value = String(value);
  });
  $("asyncExecute").addEventListener("click", () => {
    runAsyncAction().catch((error) => log("error", error.message));
  });
  $("torqueOn").addEventListener("click", () => setTorque(true).catch((error) => log("error", error.message)));
  $("torqueOff").addEventListener("click", () => setTorque(false).catch((error) => log("error", error.message)));
  $("torqueAllOff").addEventListener("click", () => {
    releaseAllTorque().catch((error) => log("error", t("torqueAllFailed", { message: error.message })));
  });
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
  $("saveParams").addEventListener("click", () => {
    saveParameters().catch((error) => log("error", error.message));
  });
  $("loadParams").addEventListener("click", () => $("paramFile").click());
  $("paramFile").addEventListener("change", (event) => {
    loadParameterFile(event.target.files?.[0]).finally(() => {
      event.target.value = "";
    });
  });
  $("restoreParams").addEventListener("click", () => {
    restoreParameters().catch((error) => log("error", error.message));
  });
  $("factoryReset").addEventListener("click", () => {
    factoryReset().catch((error) => log("error", t("factoryFailed", { message: error.message })));
  });
  $("calibrateButton").addEventListener("click", () => {
    calibrateMidpoint().catch((error) => log("error", error.message));
  });
  $("writeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    writeParameter().catch((error) => log("error", error.message));
  });
  $("logClear").addEventListener("click", () => $("logList").replaceChildren());
  $("autoSweep").addEventListener("click", () => runAuto("sweep"));
  $("autoStep").addEventListener("click", () => runAuto("step"));
  $("autoStop").addEventListener("click", () => stopAuto());
  $("chartClear").addEventListener("click", () => {
    state.chart.samples = [];
    $("chartEmpty").hidden = false;
    updateChartStats();
    renderChart();
  });
  $("chartExport").addEventListener("click", exportChart);
  $("chartWindow").addEventListener("change", () => renderChart());
  for (const tab of document.querySelectorAll("[data-servo-tab]")) {
    tab.addEventListener("click", () => setTab(tab.dataset.servoTab));
  }
  for (const radio of document.querySelectorAll('input[name="writeMode"]')) {
    radio.addEventListener("change", () => {
      if (radio.value !== "async") {
        state.pendingAsync = false;
        setControlsEnabled(state.mode !== "off");
      }
    });
  }
  window.addEventListener("resize", () => scheduleChart());
  /* Navigating away drops the BLE session, so remember the original UART and
   * try a last-moment restore; the next visit also offers it (See readUart). */
  window.addEventListener("pagehide", () => {
    if (state.mode === "ble" && state.uartTouched && state.previousUart) {
      store(UART_ORIGINAL_KEY, state.previousUart);
      managementCommand(`@u=${state.previousUart}`).catch(() => {});
    }
  });
  if (window.ResizeObserver) {
    new ResizeObserver(() => scheduleChart()).observe($("chartCanvas"));
  }
}

function boot() {
  applyTheme();
  applyLanguage();
  wireUi();
  setControlsEnabled(false);
  renderLegend();
  updateMetrics({});
  setTab(stored(TAB_KEY, "bench") === "program" ? "program" : "bench");
  window.__servoBench = state;
  if (demoRequested) {
    startSimulatedBus().catch((error) => log("error", error.message));
  } else {
    log("info", t("uartHint"));
  }
}

boot();
