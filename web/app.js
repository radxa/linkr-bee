"use strict";

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const state = {
  device: null,
  server: null,
  rxChar: null,
  txChar: null,
  connected: false,
  logBytes: [],
  ansi: {
    pending: "",
    pendingCr: false,
    currentLine: null,
    attrs: defaultAnsiAttrs(),
  },
};

const $ = (id) => document.getElementById(id);

const elements = {
  supportText: $("supportText"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  connectButton: $("connectButton"),
  disconnectButton: $("disconnectButton"),
  queryButton: $("queryButton"),
  setUartButton: $("setUartButton"),
  clearButton: $("clearButton"),
  saveButton: $("saveButton"),
  terminalOutput: $("terminalOutput"),
  terminalInput: $("terminalInput"),
  sendButton: $("sendButton"),
  breakButton: $("breakButton"),
  uartInput: $("uartInput"),
  enterSelect: $("enterSelect"),
  chunkInput: $("chunkInput"),
  localEchoInput: $("localEchoInput"),
  debugInput: $("debugInput"),
};

function defaultAnsiAttrs() {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    fg: null,
    bg: null,
  };
}

function basicAnsiColor(index) {
  const colors = [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#ffffff",
  ];
  return colors[index] || null;
}

function color256(index) {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    return null;
  }
  if (index < 16) {
    return basicAnsiColor(index);
  }
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }

  const levels = [0, 95, 135, 175, 215, 255];
  const cube = index - 16;
  const r = levels[Math.floor(cube / 36)];
  const g = levels[Math.floor((cube % 36) / 6)];
  const b = levels[cube % 6];
  return `rgb(${r}, ${g}, ${b})`;
}

function rgbColor(r, g, b) {
  const valid = [r, g, b].every(
    (value) => Number.isInteger(value) && value >= 0 && value <= 255,
  );
  return valid ? `rgb(${r}, ${g}, ${b})` : null;
}

function applyStyle(span) {
  const attrs = state.ansi.attrs;
  let fg = attrs.fg;
  let bg = attrs.bg;

  if (attrs.inverse) {
    fg = attrs.bg || "#07090c";
    bg = attrs.fg || "#d8f3dc";
  }

  if (fg) {
    span.style.color = fg;
  }
  if (bg) {
    span.style.backgroundColor = bg;
  }
  if (attrs.bold) {
    span.style.fontWeight = "700";
  }
  if (attrs.dim) {
    span.style.opacity = "0.65";
  }
  if (attrs.italic) {
    span.style.fontStyle = "italic";
  }
  if (attrs.underline) {
    span.style.textDecoration = "underline";
  }
}

function hasActiveStyle() {
  const attrs = state.ansi.attrs;
  return (
    attrs.bold ||
    attrs.dim ||
    attrs.italic ||
    attrs.underline ||
    attrs.inverse ||
    attrs.fg ||
    attrs.bg
  );
}

function currentLine() {
  if (!state.ansi.currentLine) {
    state.ansi.currentLine = document.createElement("div");
    state.ansi.currentLine.className = "terminal-line";
    elements.terminalOutput.append(state.ansi.currentLine);
  }
  return state.ansi.currentLine;
}

function appendLineBreak() {
  currentLine();
  state.ansi.currentLine = null;
}

function clearCurrentLine() {
  currentLine().replaceChildren();
}

function appendStyledText(text) {
  if (!text) {
    return;
  }

  if (!hasActiveStyle()) {
    currentLine().append(document.createTextNode(text));
    return;
  }

  const span = document.createElement("span");
  applyStyle(span);
  span.textContent = text;
  currentLine().append(span);
}

function parseAnsiNumbers(raw) {
  if (!raw) {
    return [0];
  }

  return raw
    .split(/[;:]/)
    .filter((part) => part !== "")
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));
}

function applySgr(rawParams) {
  const params = parseAnsiNumbers(rawParams);
  if (params.length === 0) {
    state.ansi.attrs = defaultAnsiAttrs();
    return;
  }

  for (let index = 0; index < params.length; ) {
    const code = params[index];

    if (code === 0) {
      state.ansi.attrs = defaultAnsiAttrs();
      index += 1;
    } else if (code === 1) {
      state.ansi.attrs.bold = true;
      index += 1;
    } else if (code === 2) {
      state.ansi.attrs.dim = true;
      index += 1;
    } else if (code === 3) {
      state.ansi.attrs.italic = true;
      index += 1;
    } else if (code === 4) {
      state.ansi.attrs.underline = true;
      index += 1;
    } else if (code === 7) {
      state.ansi.attrs.inverse = true;
      index += 1;
    } else if (code === 22) {
      state.ansi.attrs.bold = false;
      state.ansi.attrs.dim = false;
      index += 1;
    } else if (code === 23) {
      state.ansi.attrs.italic = false;
      index += 1;
    } else if (code === 24) {
      state.ansi.attrs.underline = false;
      index += 1;
    } else if (code === 27) {
      state.ansi.attrs.inverse = false;
      index += 1;
    } else if (code === 39) {
      state.ansi.attrs.fg = null;
      index += 1;
    } else if (code === 49) {
      state.ansi.attrs.bg = null;
      index += 1;
    } else if (code >= 30 && code <= 37) {
      state.ansi.attrs.fg = basicAnsiColor(code - 30);
      index += 1;
    } else if (code >= 40 && code <= 47) {
      state.ansi.attrs.bg = basicAnsiColor(code - 40);
      index += 1;
    } else if (code >= 90 && code <= 97) {
      state.ansi.attrs.fg = basicAnsiColor(code - 90 + 8);
      index += 1;
    } else if (code >= 100 && code <= 107) {
      state.ansi.attrs.bg = basicAnsiColor(code - 100 + 8);
      index += 1;
    } else if ((code === 38 || code === 48) && params[index + 1] === 5) {
      const color = color256(params[index + 2]);
      if (color) {
        state.ansi.attrs[code === 38 ? "fg" : "bg"] = color;
      }
      index += 3;
    } else if ((code === 38 || code === 48) && params[index + 1] === 2) {
      const color = rgbColor(
        params[index + 2],
        params[index + 3],
        params[index + 4],
      );
      if (color) {
        state.ansi.attrs[code === 38 ? "fg" : "bg"] = color;
      }
      index += 5;
    } else {
      index += 1;
    }
  }
}

function clearTerminalOutput(resetAnsi) {
  elements.terminalOutput.replaceChildren();
  state.ansi.currentLine = null;
  if (resetAnsi) {
    state.ansi.pending = "";
    state.ansi.pendingCr = false;
    state.ansi.attrs = defaultAnsiAttrs();
  }
}

function handleCsi(params, final) {
  if (final === "m") {
    applySgr(params);
  } else if (final === "J" && /(^|[;:])[23]($|[;:])/.test(params)) {
    clearTerminalOutput(false);
  } else if (final === "K") {
    clearCurrentLine();
  }
}

function appendAnsiOutput(text) {
  const data = state.ansi.pending + text;
  state.ansi.pending = "";

  for (let index = 0; index < data.length; ) {
    const char = data[index];

    if (state.ansi.pendingCr) {
      if (char === "\n") {
        appendLineBreak();
        state.ansi.pendingCr = false;
        index += 1;
        continue;
      }

      clearCurrentLine();
      state.ansi.pendingCr = false;
    }

    if (char === "\x1b") {
      const next = data[index + 1];
      if (!next) {
        state.ansi.pending = data.slice(index);
        break;
      }

      if (next === "[") {
        let end = index + 2;
        while (end < data.length) {
          const code = data.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) {
            break;
          }
          end += 1;
        }

        if (end >= data.length) {
          state.ansi.pending = data.slice(index);
          break;
        }

        handleCsi(data.slice(index + 2, end), data[end]);
        index = end + 1;
      } else if (next === "]") {
        const belEnd = data.indexOf("\x07", index + 2);
        const stEnd = data.indexOf("\x1b\\", index + 2);
        let end = -1;
        let extra = 1;

        if (belEnd !== -1 && (stEnd === -1 || belEnd < stEnd)) {
          end = belEnd;
        } else if (stEnd !== -1) {
          end = stEnd;
          extra = 2;
        }

        if (end === -1) {
          state.ansi.pending = data.slice(index);
          break;
        }

        index = end + extra;
      } else if ("()*+-. /".includes(next)) {
        if (!data[index + 2]) {
          state.ansi.pending = data.slice(index);
          break;
        }
        index += 3;
      } else {
        index += 2;
      }
    } else if (char === "\r") {
      if (data[index + 1] === "\n") {
        appendLineBreak();
        index += 2;
      } else if (index + 1 < data.length) {
        clearCurrentLine();
        index += 1;
      } else {
        state.ansi.pendingCr = true;
        index += 1;
      }
    } else if (char === "\n") {
      appendLineBreak();
      index += 1;
    } else if (char === "\t") {
      appendStyledText("\t");
      index += 1;
    } else if (char < " ") {
      index += 1;
    } else {
      let end = index + 1;
      while (end < data.length) {
        const code = data.charCodeAt(end);
        if (data[end] === "\x1b" || code < 0x20) {
          break;
        }
        end += 1;
      }
      appendStyledText(data.slice(index, end));
      index = end;
    }
  }
}

function appendOutput(text) {
  appendAnsiOutput(text);
  elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
}

function appendLine(text) {
  appendOutput(`${text}\n`);
}

function debugLine(text) {
  if (elements.debugInput.checked) {
    appendLine(text);
  }
}

function setConnected(connected) {
  state.connected = connected;
  elements.statusDot.classList.toggle("connected", connected);
  elements.statusText.textContent = connected ? "Connected" : "Disconnected";
  elements.connectButton.disabled = connected;
  elements.disconnectButton.disabled = !connected;
  elements.queryButton.disabled = !connected;
  elements.setUartButton.disabled = !connected;
  elements.terminalInput.disabled = !connected;
  elements.sendButton.disabled = !connected;
  elements.breakButton.disabled = !connected;
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
  return Math.max(1, Math.min(244, Math.floor(value)));
}

async function writeBytes(bytes) {
  if (!state.rxChar) {
    throw new Error("RX characteristic is not ready");
  }

  const size = chunkSize();
  for (let offset = 0; offset < bytes.length; offset += size) {
    const chunk = bytes.slice(offset, offset + size);
    debugLine(`TX ${chunk.length}: ${JSON.stringify(decoder.decode(chunk))}`);
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
    } catch (error) {
      if (size <= 20) {
        throw error;
      }
      elements.chunkInput.value = "20";
      appendLine("[warn] BLE write failed; retrying with 20-byte chunks");
      await writeBytes(bytes);
      return;
    }
  }
}

async function writeText(text) {
  await writeBytes(encoder.encode(text));
}

async function sendTerminalInput() {
  const raw = elements.terminalInput.value;
  if (!raw) {
    return;
  }

  const text = normalizeEnter(`${raw}\n`);
  elements.terminalInput.value = "";

  if (elements.localEchoInput.checked) {
    appendOutput(text);
  }
  await writeText(text);
}

async function sendControl(command) {
  appendLine(`[control] ${command}`);
  await writeText(command);
}

function onNotification(event) {
  const view = event.target.value;
  const bytes = new Uint8Array(
    view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
  );
  state.logBytes.push(bytes);
  debugLine(`RX ${bytes.length}: ${JSON.stringify(decoder.decode(bytes))}`);
  appendOutput(decoder.decode(bytes));
}

function onDisconnected() {
  state.rxChar = null;
  state.txChar = null;
  state.server = null;
  setConnected(false);
  appendLine("[disconnected]");
}

async function connect() {
  if (!navigator.bluetooth) {
    appendLine("[error] Web Bluetooth is not available in this browser");
    return;
  }

  appendLine("[scan] requesting Linkr BLE UART");
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ name: "Linkr BLE UART" }, { services: [NUS_SERVICE] }],
    optionalServices: [NUS_SERVICE],
  });

  state.device = device;
  state.device.addEventListener("gattserverdisconnected", onDisconnected);

  appendLine(`[connect] ${device.name || device.id}`);
  state.server = await device.gatt.connect();
  const service = await state.server.getPrimaryService(NUS_SERVICE);
  state.rxChar = await service.getCharacteristic(NUS_RX);
  state.txChar = await service.getCharacteristic(NUS_TX);

  await state.txChar.startNotifications();
  state.txChar.addEventListener("characteristicvaluechanged", onNotification);
  setConnected(true);
  appendLine("[ready]");
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
}

function bind() {
  elements.connectButton.addEventListener("click", () => {
    connect().catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.disconnectButton.addEventListener("click", () => {
    disconnect().catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.queryButton.addEventListener("click", () => {
    sendControl("@u?").catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.setUartButton.addEventListener("click", () => {
    sendControl(`@u=${elements.uartInput.value.trim()}`).catch((error) =>
      appendLine(`[error] ${error.message}`),
    );
  });

  elements.clearButton.addEventListener("click", () => {
    clearTerminalOutput(true);
    state.logBytes = [];
  });

  elements.saveButton.addEventListener("click", saveLog);

  elements.sendButton.addEventListener("click", () => {
    sendTerminalInput().catch((error) => appendLine(`[error] ${error.message}`));
  });

  elements.breakButton.addEventListener("click", () => {
    writeBytes(new Uint8Array([0x03])).catch((error) =>
      appendLine(`[error] ${error.message}`),
    );
  });

  elements.terminalInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendTerminalInput().catch((error) => appendLine(`[error] ${error.message}`));
    }
  });
}

function init() {
  const supported = Boolean(navigator.bluetooth);
  elements.supportText.textContent = supported
    ? "Chrome/Chromium Web Bluetooth over HTTPS or localhost"
    : "Web Bluetooth unavailable in this browser";
  elements.connectButton.disabled = !supported;
  setConnected(false);
  bind();
}

init();
