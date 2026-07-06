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

function appendOutput(text) {
  elements.terminalOutput.textContent += text;
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
    elements.terminalOutput.textContent = "";
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
