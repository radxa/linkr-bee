/* Board I/O controls for the Linkr Bee X1.0 (MV013).
 *
 * These commands drive the accessory's own hardware — the single-wire RGB
 * status LED, the optocoupler dry contact across J5, and the 38 kHz IR
 * transceiver with its raw-learning slots. They go over the encrypted
 * Bluetooth management channel and never touch the target UART.
 *
 * The builders and parsers are pure so the panel, the browser tests and any
 * later assistant tool share one definition of every command and reply. The
 * limits mirror the firmware: Kconfig sets the learning slot count and the
 * edge budget, IR addresses are 16-bit (extended NEC included), commands are
 * 8-bit and a NEC frame carries at most 16 repeat frames.
 *
 * Boards without the hardware answer `ERR ... unsupported`; the parsers expose
 * that through `isUnsupportedReply()` so the panel can disable itself instead
 * of pretending every Linkr Bee has these controls.
 */

export const BOARD_LIMITS = {
  colorMax: 255,
  repeatsMax: 16,
  pulseMinMs: 1,
  pulseMaxMs: 60000,
  addressMax: 0xffff,
  commandMax: 0xff,
  /* Firmware defaults; `@r slots` reports the real count. */
  slots: 8,
  maxEdges: 192,
};

/* Saved-command names live in the board's NVS, so their length is measured in
 * UTF-8 bytes: 32 bytes fits about ten Chinese characters or 32 ASCII ones. */
export const BOARD_SLOT_NAME_MAX_BYTES = 32;

export const LED_QUERY_COMMAND = "@l?";
export const LED_OFF_COMMAND = "@l off";
export const OPTO_QUERY_COMMAND = "@o?";
export const IR_QUERY_COMMAND = "@r?";
export const IR_SLOTS_COMMAND = "@r slots";
export const IR_LEARN_STOP_COMMAND = "@r learn stop";


function invalid(reason) {
  throw new Error(reason);
}

function channel(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > BOARD_LIMITS.colorMax) {
    invalid(`${name} must be an integer between 0 and ${BOARD_LIMITS.colorMax}`);
  }
  return number;
}

/* "@l=<r>,<g>,<b>" */
export function ledCommand({ r = 0, g = 0, b = 0 } = {}) {
  return `@l=${channel(r, "red")},${channel(g, "green")},${channel(b, "blue")}`;
}

export function ledHex({ r = 0, g = 0, b = 0 } = {}) {
  const hex = (value) => channel(value, "channel").toString(16).padStart(2, "0");
  return `${hex(r)}${hex(g)}${hex(b)}`;
}

/* "#RRGGBB" or "#RGB" from an <input type="color"> value. */
export function rgbFromHex(value) {
  const text = String(value ?? "").trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(text) && !/^[0-9a-f]{3}$/i.test(text)) {
    invalid("colour must be #RRGGBB or #RGB");
  }
  const full = text.length === 3
    ? text.split("").map((char) => char + char).join("")
    : text;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/* "@o on" / "@o off" / "@o pulse <ms>". */
export function optoCommand({ action = "on", ms = 500 } = {}) {
  const mode = String(action).toLowerCase();
  if (mode === "on" || mode === "close" || mode === "closed") return "@o on";
  if (mode === "off" || mode === "open" || mode === "opened") return "@o off";
  if (mode !== "pulse") invalid("action must be on, off or pulse");
  const duration = Number(ms);
  if (!Number.isInteger(duration) ||
      duration < BOARD_LIMITS.pulseMinMs || duration > BOARD_LIMITS.pulseMaxMs) {
    invalid(`pulse must be an integer between ${BOARD_LIMITS.pulseMinMs} and ${BOARD_LIMITS.pulseMaxMs} ms`);
  }
  return `@o pulse ${duration}`;
}

/* Accepts decimal or 0x-prefixed hexadecimal, the way the firmware parser does. */
export function parseNumber(value, { max, name } = {}) {
  const text = String(value ?? "").trim();
  const base = /^0x/i.test(text) ? 16 : 10;
  const digits = text.replace(/^0x/i, "");
  if (!digits || !new RegExp(base === 16 ? "^[0-9a-f]+$" : "^[0-9]+$", "i").test(digits)) {
    invalid(`${name} must be a number`);
  }
  const number = parseInt(digits, base);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    invalid(`${name} must be between 0 and ${max}`);
  }
  return number;
}

/* "@r tx 0x0004,0x08" or with an explicit repeat count. */
export function irSendCommand({ address, command, repeats = 0 } = {}) {
  const addr = parseNumber(address, { max: BOARD_LIMITS.addressMax, name: "address" });
  const cmd = parseNumber(command, { max: BOARD_LIMITS.commandMax, name: "command" });
  const repeat = Number(repeats ?? 0);
  if (!Number.isInteger(repeat) || repeat < 0 || repeat > BOARD_LIMITS.repeatsMax) {
    invalid(`repeats must be an integer between 0 and ${BOARD_LIMITS.repeatsMax}`);
  }
  const suffix = repeat > 0 ? `,${repeat}` : "";
  return `@r tx 0x${addr.toString(16).padStart(4, "0")},0x${cmd.toString(16).padStart(2, "0")}${suffix}`;
}

function slotNumber(value, slots = BOARD_LIMITS.slots) {
  const slot = Number(value ?? 0);
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots) {
    invalid(`slot must be between 0 and ${slots - 1}`);
  }
  return slot;
}

/* "@r learn" uses the firmware's default slot 0; a chosen slot is explicit. */
export function irLearnCommand({ slot = 0 } = {}) {
  const number = slotNumber(slot);
  return number === 0 ? "@r learn" : `@r learn ${number}`;
}

export function irPlayCommand({ slot = 0 } = {}) {
  return `@r play ${slotNumber(slot)}`;
}

export function irDeleteCommand({ slot = 0 } = {}) {
  return `@r delete ${slotNumber(slot)}`;
}

/* Names travel hex-encoded so spaces and non-ASCII bytes need no quoting on
 * the management channel. An empty name clears the label on the board. */
export function irNameQueryCommand({ slot = 0 } = {}) {
  return `@r name ${slotNumber(slot)}`;
}

export function irNameSetCommand({ slot = 0, name = "" } = {}) {
  const number = slotNumber(slot);
  const text = sanitizeSlotName(name);
  return text ? `@r name ${number} ${utf8ToHex(text)}` : `@r name ${number} clear`;
}

/* "OK ir name=0 none" or "OK ir name=0 hex=e5aea2e58e85". */
export function parseIrName(text) {
  const line = replyLines(text).find((candidate) => /^OK\s+ir\s+name=/i.test(candidate));
  if (!line) return null;
  const match = line.match(/^OK\s+ir\s+name=(\d+)\s+(none|hex=([0-9a-f]*))$/i);
  if (!match) return null;
  if (match[2].toLowerCase() === "none") {
    return { slot: Number(match[1]), name: "", empty: true };
  }
  let name;
  try {
    name = hexToUtf8(match[3] || "");
  } catch {
    return null;
  }
  return { slot: Number(match[1]), name, empty: name.length === 0 };
}

function replyLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/* Boards without the IR/RGB/optocoupler hardware answer with this error. */
export function isUnsupportedReply(text) {
  return replyLines(text).some((line) => /^ERR\b.*\bunsupported\b/i.test(line));
}

/* "OK led rgb=001830" */
export function parseLedStatus(text) {
  const match = String(text ?? "").match(/\brgb=([0-9a-f]{6})\b/i);
  if (!match) return null;
  const hex = match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/* "OK opto=closed", "OK opto=open" or "OK opto=pulse ms=500". */
export function parseOptoStatus(text) {
  const line = replyLines(text).find((candidate) => /^OK\s+opto=/i.test(candidate));
  if (!line) return null;
  if (/\bopto=pulse\b/i.test(line)) {
    const ms = Number(line.match(/\bms=(\d+)/i)?.[1]);
    return { pulse: true, closed: true, ms: Number.isFinite(ms) ? ms : null };
  }
  const state = line.match(/\bopto=(closed|open)\b/i)?.[1]?.toLowerCase();
  if (!state) return null;
  return { pulse: false, closed: state === "closed", ms: null };
}

/* "OK ir rx=on frames=3 repeats=1 glitches=0 last=addr=0x1234,cmd=0x56,ext=yes
 *  learn=idle,slots=1/8" or "learn=active,slot=0,edges=12". */
export function parseIrStatus(text) {
  const line = replyLines(text).find((candidate) => /^OK\s+ir\b/i.test(candidate));
  if (!line) return null;
  const number = (key) => {
    const value = line.match(new RegExp(`\\b${key}=(\\d+)`))?.[1];
    return value === undefined ? null : Number(value);
  };
  const last = line.match(/\blast=addr=0x([0-9a-f]+),cmd=0x([0-9a-f]+),ext=(yes|no)\b/i);
  const idle = line.match(/\blearn=idle,slots=(\d+)\/(\d+)\b/i);
  const active = line.match(/\blearn=active,slot=(\d+),edges=(\d+)\b/i);
  const rx = line.match(/\brx=(on|off)\b/i)?.[1]?.toLowerCase();
  if (!rx) return null;
  return {
    rxOn: rx === "on",
    /* Boards compiled without the learning feature answer learn=off. */
    learnSupported: !/\blearn=off\b/i.test(line),
    frames: number("frames"),
    repeats: number("repeats"),
    glitches: number("glitches"),
    last: last
      ? { address: parseInt(last[1], 16), command: parseInt(last[2], 16), extended: last[3].toLowerCase() === "yes" }
      : null,
    learning: active
      ? { active: true, slot: Number(active[1]), edges: Number(active[2]) }
      : idle
        ? { active: false, slot: null, edges: 0 }
        : { active: false, slot: null, edges: 0 },
    slotsUsed: idle ? Number(idle[1]) : null,
    slotsTotal: idle ? Number(idle[2]) : null,
  };
}

/* "OK ir slots=0:67,1:0,2:0,3:0 used=1" */
export function parseIrSlots(text) {
  const line = replyLines(text).find((candidate) => /^OK\s+ir\s+slots=/i.test(candidate));
  if (!line) return null;
  const slots = [];
  for (const match of line.matchAll(/(?:^|[=\s,])(\d+):(\d+)\b/g)) {
    slots.push({ slot: Number(match[1]), edges: Number(match[2]) });
  }
  const used = Number(line.match(/\bused=(\d+)/i)?.[1]);
  return {
    slots,
    used: Number.isFinite(used) ? used : slots.filter((entry) => entry.edges > 0).length,
  };
}

/* "OK ir learn slot=0 timeout_ms=15000" */
export function parseLearnStarted(text) {
  const line = replyLines(text).find((candidate) => /^OK\s+ir\s+learn\b/i.test(candidate));
  if (!line) return null;
  return {
    slot: Number(line.match(/\bslot=(\d+)/i)?.[1] ?? 0),
    timeoutMs: Number(line.match(/\btimeout_ms=(\d+)/i)?.[1] ?? 15000),
  };
}

/* Acknowledgement lines for LED/opto/IR actions: "OK ..." or "ERR ...". */
export function boardReply(text) {
  const lines = replyLines(text);
  const error = lines.find((line) => /^ERR\b/i.test(line));
  if (error) return { ok: false, error, line: error };
  const ok = lines.find((line) => /^OK\b/i.test(line));
  return ok ? { ok: true, error: "", line: ok } : { ok: false, error: "no reply", line: "" };
}

/* True when a reply line is a led/opto/ir command line worth showing verbatim. */
export function isBoardReplyLine(line) {
  return /^(OK|ERR)\s+(led|opto|ir)\b/i.test(String(line ?? "").trim());
}

/* The colour name/short label used by the swatch row. */
/* Saved-signal names are free text (any language), trimmed, with runs of
 * whitespace collapsed and a UTF-8 byte cap so a pasted paragraph cannot
 * overflow the board's NVS record. Truncation never splits a code point. */
export function sanitizeSlotName(value, maxBytes = BOARD_SLOT_NAME_MAX_BYTES) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const encoder = new TextEncoder();
  let used = 0;
  let kept = "";
  for (const point of text) {
    const bytes = encoder.encode(point).length;
    if (used + bytes > maxBytes) break;
    used += bytes;
    kept += point;
  }
  return kept.trim();
}

/* ---- Paired-device labels ---- */
/* A label is free text stored in the board's NVS, keyed by the bond's identity
 * address. Like saved IR names it travels hex-encoded over the management
 * channel so spaces and non-ASCII bytes need no quoting. The byte cap mirrors
 * the firmware default. */
export const BOND_LABEL_MAX_BYTES = 48;
const BOND_ID = /^[01]\/(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

function bondAddress(value) {
  const id = String(value ?? "");
  if (!BOND_ID.test(id)) {
    invalid("bond address must be 0/ or 1/ followed by six hex octets");
  }
  return id;
}

/* "@linkr bonds label <type>/<addr>" — read one label. */
export function bondLabelQueryCommand({ id = "" } = {}) {
  return `@linkr bonds label ${bondAddress(id)}`;
}

/* "@linkr bonds label <type>/<addr> <hex>", or `... clear` when empty. */
export function bondLabelSetCommand({ id = "", label = "" } = {}) {
  const address = bondAddress(id);
  const text = sanitizeBondLabel(label);
  return text
    ? `@linkr bonds label ${address} ${utf8ToHex(text)}`
    : `@linkr bonds label ${address} clear`;
}

/* "OK bonds label=1/AA:..:FF hex=e5aea2" or "... none". */
export function parseBondLabel(text) {
  const line = replyLines(text).find((candidate) => /^OK\s+bonds\s+label=/i.test(candidate));
  if (!line) return null;
  const match = line.match(/^OK\s+bonds\s+label=([01]\/[0-9A-F:]{17})\s+(none|hex=([0-9a-f]*))$/i);
  if (!match) return null;
  const id = match[1].toUpperCase();
  if (match[2].toLowerCase() === "none") {
    return { id, label: "", empty: true };
  }
  let label;
  try {
    label = hexToUtf8(match[3] || "");
  } catch {
    return null;
  }
  return { id, label, empty: label.length === 0 };
}

/* Same rules as saved-slot names: collapse whitespace, strip control bytes (a
 * label reaches the terminal and the CLI), and truncate on a code-point
 * boundary so the board's byte cap is never split mid-character. */
export function sanitizeBondLabel(value, maxBytes = BOND_LABEL_MAX_BYTES) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const encoder = new TextEncoder();
  let used = 0;
  let kept = "";
  for (const point of text) {
    const bytes = encoder.encode(point).length;
    if (used + bytes > maxBytes) break;
    used += bytes;
    kept += point;
  }
  return kept.trim();
}

export function utf8ToHex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToUtf8(hex) {
  const text = String(hex ?? "");
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(text)) {
    invalid("hex must be an even-length hexadecimal string");
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export const BOARD_SWATCHES = [
  { id: "off", hex: "000000", label: "boardColorOff" },
  { id: "red", hex: "ff0000", label: "boardColorRed" },
  { id: "green", hex: "00ff00", label: "boardColorGreen" },
  { id: "blue", hex: "0000ff", label: "boardColorBlue" },
  { id: "white", hex: "ffffff", label: "boardColorWhite" },
  { id: "amber", hex: "ff8000", label: "boardColorAmber" },
  { id: "cyan", hex: "00ffff", label: "boardColorCyan" },
  { id: "violet", hex: "7f00ff", label: "boardColorViolet" },
];
