import { parseShellMarker, SHELL_OSC_PREFIX } from "./shell_integration.js";

/* Display-only filtering. The raw journal and transport never pass through this
 * module. Match only registered commands/tokens, and fail open on ambiguity. */
const encoder = new TextEncoder();
const TOKEN = /^LINKR_EXIT_[a-f0-9]{32}$/;
function join(chunks) {
  if (!chunks.length) return new Uint8Array();
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// Fixed-size blocks avoid retaining an object for every 20-byte BLE notification.
export class ByteHistory {
  constructor(capacity = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("History capacity must be a positive integer.");
    }
    this.capacity = capacity;
    this.clear();
  }
  clear() {
    this.blocks = [];
    this.length = 0;
    this.used = 0;
    this.head = 0;
  }
  append(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.blocks.length || this.used === this.blocks.at(-1).length) {
        this.blocks.push(new Uint8Array(Math.min(16384, this.capacity)));
        this.used = 0;
      }
      const tail = this.blocks.at(-1);
      const count = Math.min(tail.length - this.used, bytes.length - offset);
      tail.set(bytes.subarray(offset, offset + count), this.used);
      this.used += count;
      this.length += count;
      offset += count;
      while (this.length > this.capacity) {
        const first = this.blocks[0];
        const available = (this.blocks.length === 1 ? this.used : first.length) - this.head;
        const discard = Math.min(available, this.length - this.capacity);
        this.head += discard;
        this.length -= discard;
        if (this.head === first.length) {
          this.blocks.shift();
          this.head = 0;
        }
      }
    }
  }
  read() {
    const result = new Uint8Array(this.length);
    let offset = 0;
    for (let index = 0; index < this.blocks.length; index++) {
      const block = this.blocks[index];
      const bytes = block.subarray(index === 0 ? this.head : 0, index === this.blocks.length - 1 ? this.used : block.length);
      result.set(bytes, offset);
      offset += bytes.length;
    }
    return result;
  }
}

export function createSerialPresentation({ onIdle = () => {}, idleMs = 300, maxRecords = 64 } = {}) {
  const tokens = new Map();
  const oscRecords = new Map();
  let echo = null, pending = [], kind = null, lineStart = true, timer = null;
  let hiddenEchoCR = false;
  function cancelTimer() {
    clearTimeout(timer);
    timer = null;
  }
  function flush() {
    cancelTimer();
    hiddenEchoCR = false;
    const output = Uint8Array.from(pending);
    if (kind === "echo") echo = null;
    pending = [];
    kind = null;
    return output;
  }
  function register(record) {
    const tracking = record.shellTracking;
    const osc = tracking?.protocol === "osc" && parseShellMarker(`${SHELL_OSC_PREFIX}${tracking.nonce}:${tracking.sequence}:${tracking.phase === "setup" ? "R" : "C"}`);
    if ((!TOKEN.test(record.completionToken || "") && !osc) || typeof record.command !== "string" || typeof record.payload !== "string") return;
    const key = osc ? `${tracking.nonce}:${tracking.sequence}` : record.completionToken;
    if (osc ? oscRecords.has(key) : tokens.has(key)) return;
    // A new operation must never reinterpret a held prefix from an older one.
    if (pending.length) onIdle(flush());
    hiddenEchoCR = false;
    if (osc) {
      oscRecords.set(key, {phase:tracking.phase, started:false});
      while (oscRecords.size > maxRecords) oscRecords.delete(oscRecords.keys().next().value);
    } else {
      tokens.set(record.completionToken, record.sessionId);
      while (tokens.size > maxRecords) tokens.delete(tokens.keys().next().value);
    }
    const variants = [record.payload, record.payload.replace(/\r\n|\r|\n/g, "\r\n"), record.payload.replace(/\r\n|\r|\n/g, "\n")];
    echo = {
      patterns: [...new Set(variants)].map(value => ({
        bytes: encoder.encode(value),
        ending: value.endsWith("\r\n") ? "\r\n" : value.endsWith("\n") ? "\n" : "\r",
      })).filter(pattern => pattern.bytes.length <= 8192),
      // Hide only an exact registered echo, never the following device output.
      // Older shell-setup records also contain an internal initialization script.
      command: record.terminalEcho === "hidden" || tracking?.phase === "setup"
        ? null : record.command,
    };
  }
  function push(bytes) {
    if (!bytes.length) return bytes;
    cancelTimer();
    if (!echo && !tokens.size && !oscRecords.size && !pending.length) {
      lineStart = bytes.at(-1) === 10;
      return bytes;
    }
    const output = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i], atStart = lineStart;
      lineStart = byte === 10;
      // The CR variant matches before CRLF is complete, including when the
      // LF arrives in the next notification. Hide the whole echo line ending.
      if (hiddenEchoCR) {
        hiddenEchoCR = false;
        if (byte === 10) { start = i + 1; continue; }
      }
      if (!kind) {
        if (echo?.patterns.some(pattern => pattern.bytes[0] === byte)) kind = "echo";
        else if (byte === 27 && oscRecords.size) kind = "osc";
        else if (atStart && byte === 76 && tokens.size) kind = "marker";
        if (kind) {
          if (i > start) output.push(bytes.subarray(start, i));
          pending = [];
        } else {
          if (byte === 10) echo = null;
          continue;
        }
      }
      pending.push(byte);
      start = i + 1;
      if (kind === "echo") {
        const patterns = echo?.patterns.filter(pattern => pending.length <= pattern.bytes.length && pattern.bytes[pending.length - 1] === byte) || [];
        if (echo) echo.patterns = patterns;
        const complete = patterns.find(pattern => pattern.bytes.length === pending.length);
        if (complete) {
          if (echo.command !== null) {
            output.push(encoder.encode(echo.command.replace(/\r\n|\r|\n/g, "\r\n") + complete.ending));
          } else hiddenEchoCR = complete.ending === "\r";
          echo = null;
          pending = [];
          kind = null;
        } else if (!patterns.length) {
          output.push(flush());
          if (byte === 10) echo = null;
        }
      } else if (kind === "osc") {
        const text = String.fromCharCode(...pending);
        const prefix = "\x1b]" + SHELL_OSC_PREFIX;
        const end = text.endsWith("\x07") ? 1 : text.endsWith("\x1b\\") ? 2 : 0;
        if (end) {
          const event = parseShellMarker(text.slice(2, -end));
          const key = event && `${event.nonce}:${event.sequence}`;
          const operation = oscRecords.get(key);
          if (operation && ((operation.phase === "setup" && event.phase === "R") || (operation.phase === "command" && event.phase === "C"))) {
            if (event.phase === "C") operation.started = true;
            else oscRecords.delete(key);
            pending = []; kind = null;
          } else if (operation?.started && event.phase === "D") {
            output.push(encoder.encode(`[Agent] exit=${event.exitCode}\r\n`));
            oscRecords.delete(key); pending = []; kind = null; echo = null;
          } else output.push(flush());
        } else if (pending.length > 164 || (!prefix.startsWith(text) && !text.startsWith(prefix))) output.push(flush());
      } else {
        const text = String.fromCharCode(...pending);
        const prefixes = [...tokens.keys()].map(token => token + ":");
        if (prefixes.some(prefix => prefix.startsWith(text))) continue;
        const prefix = prefixes.find(prefix => text.startsWith(prefix));
        const suffix = prefix ? text.slice(prefix.length) : "";
        const complete = suffix.match(/^([0-9]{1,3})\r?\n$/);
        if (complete && Number(complete[1]) <= 255) {
          tokens.delete(prefix.slice(0, -1));
          output.push(encoder.encode(`[Agent] exit=${Number(complete[1])}\r\n`));
          pending = [];
          kind = null;
          echo = null;
        } else if (!prefix || !/^[0-9]{0,3}\r?$/.test(suffix)) {
          output.push(flush());
        }
      }
    }
    if (start < bytes.length) output.push(bytes.subarray(start));
    if (pending.length) {
      timer = setTimeout(() => {
        const bytes = flush();
        if (bytes.length) onIdle(bytes);
      }, idleMs);
      timer?.unref?.();
    }
    return join(output);
  }
  return {
    register, push, flush,
    reset() {
      cancelTimer();
      tokens.clear();
      oscRecords.clear();
      echo = null;
      pending = [];
      kind = null;
      lineStart = true;
      hiddenEchoCR = false;
    },
    get pendingBytes() { return pending.length; },
  };
}
