/* Demo mode: a mock Linkr Bee X1.0 for looking at the UI without hardware.
 *
 * Opened with `?demo=board` (or any `?demo=…` value) on the web terminal. The
 * page then behaves as if a real X1.0 were connected over BLE: the management
 * channel is answered from an in-memory mock, the board panel opens itself and
 * the terminal shows the same `[control]` lines a real device produces.
 *
 * This module is loaded by app.js and does nothing unless the query parameter
 * is present, so the shipped app is unchanged for normal use. It is also what
 * the `demo_mode` browser regression drives, so the mock cannot silently drift
 * away from the firmware replies the panel parses.
 */

import { hexToUtf8, utf8ToHex } from "./board_io.js";

/* Demo board storage: names live with the simulated NVS, so a page reload
 * keeps them exactly as a real board would. */
const DEMO_NAMES_KEY = "linkr-demo-slot-names";
const DEMO_PROMPT_KEY = "linkr-demo-prompt";
const DEMO_AICONF_KEY = "linkr-demo-aiconf";

const DEMO_DEVICE_NAME = "Linkr Bee X1.0 (demo)";
const DEMO_DEVICE_ID = "demo-x1-0";
const DEMO_SLOTS = 8;
const DEMO_LEARN_EDGES = 67;

export function demoModeRequested() {
  try {
    return new URLSearchParams(window.location.search).has("demo");
  } catch {
    return false;
  }
}

export function installDemoMode({
  state,
  setConnected,
  setControl,
  setPage,
  appendLine,
  panelToggle,
  appShell,
}) {
  const demo = {
    led: { r: 0, g: 0x18, b: 0x30 },
    opto: false,
    bonds: ["0/AA:BB:CC:DD:EE:01", "1/AA:BB:CC:DD:EE:02"],
    bondNames: { "0/AA:BB:CC:DD:EE:01": "longlong-mbp", "1/AA:BB:CC:DD:EE:02": "Chrome · macOS" },
    optoTimer: null,
    slots: new Array(DEMO_SLOTS).fill(0),
    rx: true,
    frames: 2,
    repeats: 0,
    glitches: 0,
    last: { address: 0x0004, command: 0x08, extended: false },
    learning: null,
    names: loadDemoNames(),
    prompt: loadDemoPrompt(),
    aiconf: loadDemoAiconf(),
    aiconfStageHex: null,
  };
  demo.slots[0] = DEMO_LEARN_EDGES;

  function loadDemoNames() {
    try {
      const stored = JSON.parse(localStorage.getItem(DEMO_NAMES_KEY) || "{}");
      return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    } catch {
      return {};
    }
  }

  function loadDemoPrompt() {
    try {
      return localStorage.getItem(DEMO_PROMPT_KEY) || "";
    } catch {
      return "";
    }
  }

  function loadDemoAiconf() {
    try {
      return localStorage.getItem(DEMO_AICONF_KEY) || "";
    } catch {
      return "";
    }
  }

  function saveDemoAiconf() {
    try {
      localStorage.setItem(DEMO_AICONF_KEY, demo.aiconf);
    } catch {
      // In-memory mock is enough when storage is unavailable.
    }
  }

  function saveDemoPrompt() {
    try {
      localStorage.setItem(DEMO_PROMPT_KEY, demo.prompt);
    } catch {
      // In-memory mock still works when storage is unavailable.
    }
  }

  const promptBytes = (text) => Array.from(new TextEncoder().encode(text || ""));
  const promptHex = (bytes) => Array.from(bytes,
    (byte) => byte.toString(16).padStart(2, "0")).join("");

  function saveDemoNames() {
    try {
      localStorage.setItem(DEMO_NAMES_KEY, JSON.stringify(demo.names));
    } catch {
      // Storage is a convenience here; the mock still works in memory.
    }
  }

  const hex = ({ r, g, b }) =>
    [r, g, b].map((value) => Number(value).toString(16).padStart(2, "0")).join("");
  const useCount = () => demo.slots.filter((edges) => edges > 0).length;
  const slotLine = () =>
    `OK ir slots=${demo.slots.map((edges, slot) => `${slot}:${edges}`).join(",")} used=${useCount()}`;
  const irLine = () => {
    const last = demo.last
      ? `addr=0x${demo.last.address.toString(16).padStart(4, "0")},` +
        `cmd=0x${demo.last.command.toString(16).padStart(2, "0")},` +
        `ext=${demo.last.extended ? "yes" : "no"}`
      : "none";
    const learn = demo.learning
      ? `learn=active,slot=${demo.learning.slot},edges=${demo.learning.edges}`
      : `learn=idle,slots=${useCount()}/${DEMO_SLOTS}`;
    return `OK ir rx=${demo.rx ? "on" : "off"} frames=${demo.frames} ` +
      `repeats=${demo.repeats} glitches=${demo.glitches} last=${last} ${learn}`;
  };

  const finishLearning = () => {
    const session = demo.learning;
    if (!session) {
      return false;
    }
    if (session.timer) {
      clearInterval(session.timer);
    }
    demo.learning = null;
    if (session.edges < 6) {
      return false;
    }
    demo.slots[session.slot] = session.edges > DEMO_LEARN_EDGES
      ? DEMO_LEARN_EDGES
      : session.edges;
    demo.frames += 1;
    demo.last = { address: 0x0004, command: 0x08, extended: false };
    appendLine(`[demo] learned slot ${session.slot}: ${demo.slots[session.slot]} edges`);
    return true;
  };

  const startLearning = (slot) => {
    finishLearning();
    const session = { slot, edges: 0, timer: null };
    session.timer = setInterval(() => {
      if (!demo.learning || demo.learning !== session) {
        return;
      }
      session.edges = Math.min(session.edges + 7, DEMO_LEARN_EDGES);
      if (session.edges >= DEMO_LEARN_EDGES) {
        finishLearning();
      }
    }, 160);
    demo.learning = session;
  };

  function reply(command) {
    if (command === "@linkr bonds?") {
      return "OK bonds pending=0 result=0\n" + demo.bonds.map(id => `BOND ${id} self=${id.endsWith("01") ? 1 : 0}`).join("\n");
    }
    if (command === "@linkr bonds names?") {
      return "OK bonds names\n" + demo.bonds
        .filter(id => demo.bondNames[id])
        .map(id => `NAME ${id} "${demo.bondNames[id]}"`)
        .join("\n");
    }
    if (command.startsWith("@linkr bonds label ")) {
      const rest = command.slice("@linkr bonds label ".length);
      const space = rest.indexOf(" ");
      const id = space < 0 ? rest : rest.slice(0, space);
      const value = space < 0 ? null : rest.slice(space + 1);
      if (!demo.bonds.includes(id)) return "ERR bonds not found";
      if (value === null) {
        const label = demo.bondNames[id] || "";
        return label ? `OK bonds label=${id} hex=${utf8ToHex(label)}` : `OK bonds label=${id} none`;
      }
      if (value === "clear") {
        delete demo.bondNames[id];
        return `OK bonds label=${id} none`;
      }
      try {
        const label = hexToUtf8(value);
        demo.bondNames[id] = label;
        return `OK bonds label=${id} hex=${utf8ToHex(label)}`;
      } catch {
        return "ERR bonds label hex";
      }
    }
    if (command.startsWith("@linkr bonds name ")) {
      const label = command.slice(18).trim();
      const self = demo.bonds.find(id => id.endsWith("01"));
      if (!self) return "ERR bonds not found";
      demo.bondNames[self] = label;
      return "OK bonds name";
    }
    if (command.startsWith("@linkr bonds remove ")) {
      const id = command.slice(20);
      demo.bonds = demo.bonds.filter(value => value !== id);
      delete demo.bondNames[id];
      if (id.endsWith("01")) setTimeout(() => setConnected(false), 500);
      return "OK bonds queued";
    }
    if (command === "@l?") {
      return `OK led rgb=${hex(demo.led)}`;
    }
    if (command === "@l off") {
      demo.led = { r: 0, g: 0, b: 0 };
      return "OK led off";
    }
    let match = command.match(/^@l=(\d+),(\d+),(\d+)$/);
    if (match) {
      demo.led = { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
      return `OK led rgb=${hex(demo.led)}`;
    }

    if (command === "@o?") {
      return `OK opto=${demo.opto ? "closed" : "open"}`;
    }
    if (command === "@o on") {
      demo.opto = true;
      if (demo.optoTimer) clearTimeout(demo.optoTimer);
      return "OK opto=closed";
    }
    if (command === "@o off") {
      demo.opto = false;
      if (demo.optoTimer) clearTimeout(demo.optoTimer);
      return "OK opto=open";
    }
    match = command.match(/^@o pulse (\d+)$/);
    if (match) {
      const ms = Number(match[1]);
      demo.opto = true;
      if (demo.optoTimer) clearTimeout(demo.optoTimer);
      demo.optoTimer = setTimeout(() => { demo.opto = false; }, ms);
      return `OK opto=pulse ms=${ms}`;
    }

    if (command === "@r?") {
      return irLine();
    }
    if (command === "@r slots") {
      return slotLine();
    }
    match = command.match(/^@r learn(?: (\d+))?$/);
    if (match) {
      const slot = Number(match[1] ?? 0);
      startLearning(slot);
      return `OK ir learn slot=${slot} timeout_ms=15000`;
    }
    if (command === "@r learn stop") {
      const session = demo.learning;
      const ok = finishLearning();
      return ok
        ? `OK ir learn slot=${session ? session.slot : 0} stored edges=${demo.slots[session ? session.slot : 0]}`
        : "ERR ir learn=no-frame";
    }
    match = command.match(/^@r play (\d+)$/);
    if (match) {
      const slot = Number(match[1]);
      if (!demo.slots[slot]) return `ERR ir slot=${slot} empty`;
      demo.frames += 1;
      demo.last = { address: 0x0004, command: 0x08, extended: false };
      return `OK ir play slot=${slot} edges=${demo.slots[slot]}`;
    }
    match = command.match(/^@r delete (\d+)$/);
    if (match) {
      const slot = Number(match[1]);
      if (!demo.slots[slot]) return `ERR ir slot=${slot} empty`;
      demo.slots[slot] = 0;
      delete demo.names[slot];
      saveDemoNames();
      return `OK ir slot=${slot} cleared`;
    }
    match = command.match(/^@r tx 0x([0-9a-f]+),0x([0-9a-f]+)(?:,(\d+))?$/i);
    if (match) {
      demo.frames += 1;
      demo.last = {
        address: parseInt(match[1], 16),
        command: parseInt(match[2], 16),
        extended: parseInt(match[1], 16) > 0xff,
      };
      return `OK ir tx addr=0x${match[1]},cmd=0x${match[2]},repeats=${match[3] ?? 0}`;
    }
    match = command.match(/^@r rx (on|off)$/);
    if (match) {
      demo.rx = match[1] === "on";
      return `OK ir rx=${match[1]}`;
    }
    if (command === "@r clear") {
      demo.frames = 0;
      demo.repeats = 0;
      demo.glitches = 0;
      demo.last = null;
      return "OK ir cleared";
    }

    match = command.match(/^@r name (\d+)$/);
    if (match) {
      const slot = Number(match[1]);
      const name = demo.names[slot];
      return name
        ? `OK ir name=${slot} hex=${utf8ToHex(name)}`
        : `OK ir name=${slot} none`;
    }
    match = command.match(/^@r name (\d+) clear$/);
    if (match) {
      const slot = Number(match[1]);
      delete demo.names[slot];
      saveDemoNames();
      return `OK ir name=${slot} cleared`;
    }
    match = command.match(/^@r name (\d+) ([0-9a-f]+)$/i);
    if (match) {
      const slot = Number(match[1]);
      try {
        demo.names[slot] = hexToUtf8(match[2]);
      } catch {
        return "ERR ir name=hex";
      }
      saveDemoNames();
      return `OK ir name=${slot} set`;
    }

    if (command === "@p?") {
      return `OK prompt=${promptBytes(demo.prompt).length}`;
    }
    match = command.match(/^@p get(?: (\d+))?$/);
    if (match) {
      const offset = Number(match[1] ?? 0);
      const bytes = promptBytes(demo.prompt);
      const chunk = bytes.slice(offset, offset + 48);
      const done = offset + chunk.length >= bytes.length;
      return `OK p off=${offset} hex=${promptHex(chunk)} ` +
        `total=${bytes.length} done=${done ? "yes" : "no"}`;
    }
    match = command.match(/^@p set ([0-9a-f]+)$/i);
    if (match) {
      const bytes = new Uint8Array((match[1].match(/.{2}/g) || []).map((b) => parseInt(b, 16)));
      demo.prompt = new TextDecoder().decode(bytes);
      saveDemoPrompt();
      return `OK prompt len=${bytes.length}`;
    }
    if (command === "@p clear") {
      demo.prompt = "";
      saveDemoPrompt();
      return "OK prompt cleared";
    }

    if (command === "@y?") {
      const bytes = promptBytes(demo.aiconf).length;
      return `OK aiconf bytes=${bytes} max=960`;
    }
    if (command === "@y begin") {
      demo.aiconfStageHex = "";
      return "OK aiconf begin";
    }
    match = command.match(/^@y put ([0-9a-f]+)$/i);
    if (match) {
      if (demo.aiconfStageHex === null) return "ERR aiconf=not-begun";
      const next = demo.aiconfStageHex + match[1].toLowerCase();
      if (next.length / 2 > 960) return "ERR aiconf=too-large";
      demo.aiconfStageHex = next;
      return `OK aiconf stage=${next.length / 2}`;
    }
    if (command === "@y end") {
      if (demo.aiconfStageHex === null) return "ERR aiconf=not-begun";
      const bytes = new Uint8Array((demo.aiconfStageHex.match(/.{2}/g) || []).map((b) => parseInt(b, 16)));
      demo.aiconf = new TextDecoder().decode(bytes);
      demo.aiconfStageHex = null;
      saveDemoAiconf();
      return `OK aiconf bytes=${promptBytes(demo.aiconf).length}`;
    }
    match = command.match(/^@y get(?: (\d+))?$/);
    if (match) {
      if (demo.aiconfStageHex !== null) return "ERR aiconf=staging";
      if (!demo.aiconf) return "ERR aiconf=empty";
      const offset = Number(match[1] ?? 0);
      const bytes = promptBytes(demo.aiconf);
      const chunk = bytes.slice(offset, offset + 48);
      const done = offset + chunk.length >= bytes.length;
      return `OK aiconf off=${offset} hex=${promptHex(chunk)} ` +
        `total=${bytes.length} done=${done ? "yes" : "no"}`;
    }
    if (command === "@y clear") {
      demo.aiconf = "";
      demo.aiconfStageHex = null;
      saveDemoAiconf();
      return "OK aiconf cleared";
    }

    /* Enough of the accessory's other surfaces to make the demo panels look
     * alive when someone clicks around. */
    const canned = {
      "@u?": "OK uart=115200,8,N,1,none",
      "@w?": "OK wifi off",
      "@d?": "OK webdav=off,url=",
      "@n?": `OK name=${DEMO_DEVICE_NAME} custom=yes`,
      "@s?": "OK ws=off port=80 clients=0 token=none",
      "@c?": "OK control self=1 owner=1 mode=control epoch=1 peers=1 ble_max=2 linkr_reserved=0",
    };
    return canned[command] ?? "OK";
  }

  setControl((command, options = {}) => {
    const text = reply(String(command ?? ""));
    const delay = 30 + Math.floor(Math.random() * 40);
    return new Promise((resolve) => {
      setTimeout(() => resolve(options.returnResponse ? text : 1), delay);
    });
  });

  state.mode = "ble";
  state.mgmtReady = true;
  state.mgmtCapabilities = 1 | 2 | (1 << 4);
  state.device = { id: DEMO_DEVICE_ID, name: DEMO_DEVICE_NAME };
  state.deviceId = DEMO_DEVICE_ID;
  setConnected(true);
  appendLine(`[demo] ${DEMO_DEVICE_NAME} connected over a mock management channel`);
  appendLine("[demo] board panel is live: LED, optocoupler, NEC remote and IR learning");

  setPage("board");
  const drawer = document.documentElement.classList.contains("settings-drawer-layout");
  const hidden = drawer
    ? !appShell.classList.contains("sidebar-open")
    : appShell.classList.contains("controls-hidden");
  if (hidden && panelToggle) {
    panelToggle.click();
  }
}
