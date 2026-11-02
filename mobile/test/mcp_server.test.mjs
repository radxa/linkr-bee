import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_CONFIG_KEY,
  MCP_DEFAULT_PORT,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
  claudeConfigSnippet,
  createMcpHost,
  defaultMcpConfig,
  isHighRiskToolCall,
  redactToolArguments,
  validateMcpConfig,
} from "../../web/mcp_server.js";
import { wifiCommand, webdavCommand } from "../../web/accessory_control.js";
import { SerialJournal } from "../../web/serial_journal.js";

const TOOL_NAMES = [
  "get_device_status",
  "read_serial_log",
  "search_serial_log",
  "get_accessory_diagnostics",
  "wifi_scan",
  "send_serial_input",
  "set_uart_config",
  "set_wifi",
  "set_webdav",
  "get_bee_status",
  "scan_bee_devices",
  "connect_bee",
  "disconnect_bee",
  "set_bee_name",
  "set_lan_bridge",
  "get_execution_status",
  "get_agent_status",
  "start_agent_task",
  "get_agent_task",
  "list_agent_tasks",
  "cancel_agent_task",
];

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

/* The journal contract is {text,start,cursor,latestCursor,truncated}; the host
 * must not need any other field, so the fake can stay tiny. */
function fakeJournal(log = {}) {
  const reads = [];
  return {
    reads,
    read(options = {}) {
      reads.push({ ...options });
      return { text: "", start: 0, cursor: 0, latestCursor: 0, truncated: false, ...log };
    },
  };
}

function fakeDevice({ status = {}, execute, inspectExecution = null } = {}) {
  const calls = { execute: [], status: 0, inspect: [] };
  return {
    calls,
    device: {
      getStatus() {
        calls.status += 1;
        return {
          connected: true,
          transport: "ble",
          device: "Linkr Bee",
          deviceId: "dev-1",
          uart: "115200",
          receivedBytes: 100,
          sentBytes: 20,
          console: { kind: "shell", evidence: "", cursor: 10, source: "classifier" },
          executionMode: "auto",
          // Fields the MCP status tool must not leak to an external client.
          sessionId: "session-1",
          inputRevision: 3,
          profile: { board: "radxa" },
          notes: [{ text: "kept locally" }],
          commandPolicy: { alwaysAsk: [], allow: [] },
          ...status,
        };
      },
      inspectExecution(id) {
        calls.inspect.push(id);
        return inspectExecution ? inspectExecution(id) : null;
      },
      observe() {},
      async execute(args, signal, options) {
        calls.execute.push({ args, signal, options });
        if (execute) return execute(args, signal, options);
        return {
          id: "serial-1",
          delivery: "sent",
          executionStatus: "unknown",
          observation: "no-output",
          evidence: "",
          evidenceStart: 10,
          evidenceTruncated: false,
          observedCursor: 10,
          latestCursor: 10,
          hasMore: false,
        };
      },
    },
  };
}

function fakeAccessory(overrides = {}) {
  const calls = { capability: 0, command: [], diagnostics: 0, scan: 0, execute: [], changeBleName: [], changeLanBridge: [] };
  const capability = { available: true, wifi: true, webdav: true, asyncEvents: true, ...(overrides.capability || {}) };
  const accessory = {
    capability() {
      calls.capability += 1;
      return { ...capability };
    },
    command(action, args) {
      calls.command.push({ action, args });
      return overrides.command ? overrides.command(action, args) : `@${action}`;
    },
    async diagnostics(options) {
      calls.diagnostics += 1;
      if (overrides.diagnostics) return overrides.diagnostics(options);
      return {
        settled: true,
        groups: { fw: { version: "1" } },
        lines: Array.from({ length: 30 }, (_, index) => `@info fw line${index}`),
      };
    },
    async scan(options) {
      calls.scan += 1;
      if (overrides.scan) return overrides.scan(options);
      return { failed: false, networks: [{ ssid: "Bench" }] };
    },
    async execute(request) {
      calls.execute.push(request);
      if (overrides.execute) return overrides.execute(request);
      return {
        command: request.command,
        reply: "OK",
        accepted: true,
        applied: true,
        settled: true,
      };
    },
    async readBleName() {
      return { name: "Linkr Bee Test", custom: true };
    },
    async changeBleName(request) {
      calls.changeBleName.push(request);
      if (overrides.changeBleName) return overrides.changeBleName(request);
      return { command: request.reset ? "@n default" : `@n=${request.name}`, accepted: true, applied: true, settled: true };
    },
    async readLanBridge() {
      return { state: "off", enabled: false, listening: false, port: 80, clients: 0, hasToken: true };
    },
    async changeLanBridge(request) {
      calls.changeLanBridge.push(request);
      if (overrides.changeLanBridge) return overrides.changeLanBridge(request);
      return { command: `@s ${request.action}`, accepted: true, applied: true, settled: true };
    },
  };
  return { accessory, calls };
}

function fakeBridge(overrides = {}) {
  const listeners = [];
  const calls = { start: [], stop: 0, getState: 0, regenerate: 0, respond: [], listeners: 0 };
  const state = {
    running: false,
    port: MCP_DEFAULT_PORT,
    bind: "lan",
    token: "a".repeat(64),
    url: `http://127.0.0.1:${MCP_DEFAULT_PORT}/mcp`,
    urls: [`http://127.0.0.1:${MCP_DEFAULT_PORT}/mcp`],
    foreground: true,
    activeRequests: 0,
    lastError: null,
  };
  const bridge = {
    available: true,
    platform: "android",
    async start(config) {
      calls.start.push({ ...config });
      Object.assign(state, {
        running: true,
        port: config.port,
        bind: config.bind,
        url: `http://127.0.0.1:${config.port}/mcp`,
        urls: [`http://127.0.0.1:${config.port}/mcp`],
      });
      return { ...state };
    },
    async stop() {
      calls.stop += 1;
      Object.assign(state, { running: false });
      return { ...state };
    },
    async getState() {
      calls.getState += 1;
      return { ...state };
    },
    async regenerateToken() {
      calls.regenerate += 1;
      state.token = "b".repeat(64);
      return { ...state };
    },
    async respond(input) {
      calls.respond.push({ ...input });
    },
    async addListener(event, callback) {
      calls.listeners += 1;
      listeners.push({ event, callback });
      return { remove: async () => {} };
    },
  };
  Object.assign(bridge, overrides);
  return { bridge, calls, state, listeners };
}

function createHost({
  bridge = null,
  device = null,
  readLog = null,
  accessory = null,
  bee = null,
  residentAgent = null,
  requestApproval = async () => ({ approved: true }),
  storage = memoryStorage(),
  onChange = () => {},
  getLang = () => "en",
} = {}) {
  return createMcpHost({
    getBridge: () => bridge,
    storage,
    getDevice: () => device,
    readLog: readLog || (() => ({ text: "", start: 0, cursor: 0, latestCursor: 0, truncated: false })),
    accessory,
    bee,
    residentAgent,
    requestApproval,
    getLang,
    onChange,
  });
}

async function rpc(host, method, params, id = 1) {
  const request = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
  const response = await host.handleRpc(JSON.stringify(request));
  return { status: response.status, message: response.body ? JSON.parse(response.body) : null };
}

async function callTool(host, name, args = {}, id = 1) {
  return rpc(host, "tools/call", { name, arguments: args }, id);
}

function toolPayload(message) {
  return JSON.parse(message.result.content[0].text);
}

function toolErrorText(message) {
  assert.equal(message.result.isError, true);
  return message.result.content[0].text;
}

test("initialize negotiates the protocol version and carries the evidence rules", async () => {
  const host = createHost();
  const cases = [
    ["2024-11-05", "2024-11-05"],
    ["2025-03-26", "2025-03-26"],
    ["2099-01-01", "2025-06-18"],
    [undefined, "2025-06-18"],
  ];
  for (const [requested, expected] of cases) {
    const { status, message } = await rpc(host, "initialize",
      requested === undefined ? {} : { protocolVersion: requested });
    assert.equal(status, 200);
    assert.equal(message.result.protocolVersion, expected);
    assert.deepEqual(message.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(message.result.serverInfo, {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    });
    const instructions = message.result.instructions;
    assert.match(instructions, /untrusted device data/i);
    assert.match(instructions, /delivery is not command completion/i);
    assert.match(instructions, /approved by a human/i);
    assert.match(instructions, /read-only mode/i);
    assert.match(instructions, /high-risk-only mode/i);
    assert.match(instructions, /fully-authorized mode/i);
  }
});

test("notifications are acknowledged with 202 and ping has an empty result", async () => {
  const host = createHost();
  const initialized = await host.handleRpc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.deepEqual(initialized, { status: 202, body: "" });
  const cancelled = await host.handleRpc(JSON.stringify({
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 },
  }));
  assert.deepEqual(cancelled, { status: 202, body: "" });
  // An unknown notification is not answered either: it has no id to answer to.
  const unknownNotification = await host.handleRpc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/nope" }));
  assert.equal(unknownNotification.status, 202);
  const ping = await rpc(host, "ping");
  assert.deepEqual(ping.message, { jsonrpc: "2.0", id: 1, result: {} });
});

test("malformed JSON and invalid requests become JSON-RPC errors", async () => {
  const host = createHost();
  const parse = await host.handleRpc("{not json");
  assert.equal(parse.status, 400);
  assert.equal(JSON.parse(parse.body).error.code, -32700);
  assert.equal(JSON.parse(parse.body).id, null);

  const version = await host.handleRpc(JSON.stringify({ jsonrpc: "1.0", id: 7, method: "ping" }));
  assert.equal(version.status, 400);
  assert.equal(JSON.parse(version.body).error.code, -32600);
  assert.equal(JSON.parse(version.body).id, 7);

  const missingMethod = await host.handleRpc(JSON.stringify({ jsonrpc: "2.0", id: 8 }));
  assert.equal(missingMethod.status, 400);
  assert.equal(JSON.parse(missingMethod.body).error.code, -32600);

  const unknownMethod = await rpc(host, "tools/nope");
  assert.equal(unknownMethod.status, 200);
  assert.equal(unknownMethod.message.error.code, -32601);

  const batch = await host.handleRpc(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
  assert.equal(batch.status, 400);
  assert.equal(JSON.parse(batch.body).error.code, -32600);
});

test("tools/list exposes the fixed catalog without internal policy fields", async () => {
  const host = createHost();
  const { status, message } = await rpc(host, "tools/list");
  assert.equal(status, 200);
  const tools = message.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name"]);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 120, `${tool.name} needs an evidence-disciplined description`);
    assert.doesNotMatch(JSON.stringify(tool), /"access"|"write"/);
  }
  const send = tools.find((tool) => tool.name === "send_serial_input");
  assert.deepEqual(send.inputSchema.required, ["text", "appendEnter"]);
  assert.equal(send.inputSchema.properties.text.maxLength, 2048);
  assert.match(send.description, /delivery is not command completion/i);
  const read = tools.find((tool) => tool.name === "read_serial_log");
  assert.match(read.description, /untrusted device data/i);
  assert.equal(read.inputSchema.properties.limit.maximum, 16000);
  const uart = tools.find((tool) => tool.name === "set_uart_config");
  assert.equal(uart.inputSchema.properties.baud.minimum, 300);
  assert.equal(uart.inputSchema.properties.baud.maximum, 3000000);
  assert.deepEqual(uart.inputSchema.properties.parity.enum, ["n", "e", "o"]);
  const wifi = tools.find((tool) => tool.name === "set_wifi");
  assert.deepEqual(wifi.inputSchema.properties.action.enum, ["connect", "off"]);
  assert.equal(wifi.inputSchema.properties.password.maxLength, 64);
  const webdav = tools.find((tool) => tool.name === "set_webdav");
  assert.deepEqual(webdav.inputSchema.properties.action.enum, ["on", "off"]);
  // The list is plain JSON: no handler functions may leak into the payload.
  assert.doesNotThrow(() => JSON.stringify(tools));
});

test("empty resources/prompts lists and logging level are accepted", async () => {
  const host = createHost();
  assert.deepEqual((await rpc(host, "resources/list")).message.result, { resources: [] });
  assert.deepEqual((await rpc(host, "resources/templates/list")).message.result, { resourceTemplates: [] });
  assert.deepEqual((await rpc(host, "prompts/list")).message.result, { prompts: [] });
  assert.deepEqual((await rpc(host, "logging/setLevel", { level: "debug" })).message.result, {});
});

test("read tools return only the documented device evidence", async () => {
  const { device } = fakeDevice();
  const journal = fakeJournal({ text: "U-Boot 2024.01\r\n", start: 10, cursor: 25, latestCursor: 25 });
  const host = createHost({ device, readLog: journal.read });

  const statusResponse = await callTool(host, "get_device_status");
  assert.equal(statusResponse.status, 200);
  const status = toolPayload(statusResponse.message);
  assert.deepEqual(Object.keys(status).sort(), [
    "connected", "console", "device", "deviceId", "executionMode",
    "receivedBytes", "sentBytes", "transport", "uart",
  ]);
  assert.equal(status.connected, true);
  assert.equal(status.transport, "ble");
  assert.equal(status.uart, "115200");
  assert.equal(status.executionMode, "auto");
  // Local-only fields must not reach an external client.
  assert.equal("sessionId" in status, false);
  assert.equal("profile" in status, false);
  assert.equal("notes" in status, false);
  assert.equal("commandPolicy" in status, false);

  const read = toolPayload((await callTool(host, "read_serial_log")).message);
  assert.deepEqual(journal.reads.at(-1), { limit: 6000 });
  assert.equal(read.text, "U-Boot 2024.01\r\n");
  assert.equal(read.cursor, 25);
  assert.equal(read.latestCursor, 25);
  assert.equal(read.hasMore, false);
  assert.equal(read.untrusted, true);

  await callTool(host, "read_serial_log", { after: 5, limit: 100 });
  assert.deepEqual(journal.reads.at(-1), { after: 5, limit: 100 });
  await callTool(host, "read_serial_log", { recent: true });
  assert.deepEqual(journal.reads.at(-1), { limit: 6000, recent: true });
});

test("read_serial_log refuses recent combined with after as invalid params", async () => {
  const { device } = fakeDevice();
  const host = createHost({ device, readLog: fakeJournal().read });
  const response = await callTool(host, "read_serial_log", { after: 10, recent: true });
  assert.equal(response.status, 200);
  assert.equal(response.message.error.code, -32602);
});

test("search_serial_log returns bounded excerpts without advancing a cursor", async () => {
  const text = `${"hit ".repeat(14)}tail hit`;
  const journal = fakeJournal({ text, start: 0, cursor: text.length, latestCursor: text.length });
  const { device } = fakeDevice();
  const host = createHost({ device, readLog: journal.read });
  const response = await callTool(host, "search_serial_log", { query: "HIT" });
  assert.equal(response.status, 200);
  const payload = toolPayload(response.message);
  assert.equal(payload.matches.length, 12);
  assert.equal(payload.moreMatches, true);
  assert.equal(payload.untrusted, true);
  assert.equal(payload.cursor, text.length);
  assert.match(payload.note, /window/i);
  assert.equal(payload.matches[0].excerpt.startsWith("hit"), true);
  assert.deepEqual(journal.reads[0], { after: undefined, limit: 16000 });
  const blank = await callTool(host, "search_serial_log", { query: "   " });
  assert.equal(blank.message.error.code, -32602);
});

test("unknown tools and invalid arguments are invalid-params errors", async () => {
  const host = createHost();
  const unknown = await callTool(host, "no_such_tool", {});
  assert.equal(unknown.status, 200);
  assert.equal(unknown.message.error.code, -32602);
  assert.match(unknown.message.error.message, /Unknown tool/);

  const badLimit = await callTool(host, "read_serial_log", { limit: 0 });
  assert.equal(badLimit.message.error.code, -32602);
  assert.match(badLimit.message.error.message, /arguments\.limit/);

  const missingText = await callTool(host, "send_serial_input", { appendEnter: true });
  assert.equal(missingText.message.error.code, -32602);
  assert.match(missingText.message.error.message, /arguments\.text is required/);

  const extra = await callTool(host, "get_device_status", { unexpected: true });
  assert.equal(extra.message.error.code, -32602);
  assert.match(extra.message.error.message, /Unknown argument/);

  const badEnum = await callTool(host, "set_wifi", { action: "reboot" });
  assert.equal(badEnum.message.error.code, -32602);
});

test("a missing or disconnected target is an isError result with a clear reason", async () => {
  const noSession = createHost({ device: null });
  const missing = await callTool(noSession, "get_device_status");
  assert.equal(missing.status, 200);
  assert.match(toolErrorText(missing.message), /No target device session/);

  const { device } = fakeDevice({ status: { connected: false } });
  const disconnected = await callTool(createHost({ device }), "get_device_status");
  assert.match(toolErrorText(disconnected.message), /not connected/i);
});

test("read-only access mode refuses device-changing tools and nothing is approved", async () => {
  const approvals = [];
  const { device, calls } = fakeDevice();
  const host = createHost({
    device,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  await host.setConfig({ access: "read" });
  const denied = await callTool(host, "send_serial_input", { text: "reboot", appendEnter: true });
  assert.equal(denied.status, 200);
  assert.match(toolErrorText(denied.message), /read-only/i);
  assert.equal(calls.execute.length, 0);
  assert.equal(approvals.length, 0);
  const audit = host.getAudit();
  assert.equal(audit[0].outcome, "denied");
  assert.equal(audit[0].tool, "send_serial_input");
  // Reads stay available.
  const status = await callTool(host, "get_device_status");
  assert.equal(status.message.result.isError, undefined);
});

test("send_serial_input asks the phone for approval and sends once approved", async () => {
  const approvals = [];
  const { device, calls } = fakeDevice();
  const host = createHost({
    device,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const response = await callTool(host, "send_serial_input", { text: "uname -a", appendEnter: true });
  assert.equal(response.status, 200);
  assert.equal(response.message.result.isError, undefined);
  const payload = toolPayload(response.message);
  assert.equal(payload.id, "serial-1");
  assert.equal(payload.delivery, "sent");
  assert.match(payload.note, /Delivery is not command completion/);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].tool, "send_serial_input");
  assert.equal(approvals[0].args.text, "uname -a");
  assert.match(approvals[0].summary, /uname -a/);
  assert.equal(typeof approvals[0].timeoutMs, "number");
  assert.equal(calls.execute.length, 1);
  assert.deepEqual(calls.execute[0].args, { text: "uname -a", appendEnter: true });
  assert.deepEqual(calls.execute[0].options, { userApproved: true });
  assert.ok(calls.execute[0].signal instanceof AbortSignal);
  assert.equal(host.getAudit()[0].outcome, "ok");
});

test("a denied approval never executes the write", async () => {
  const { device, calls } = fakeDevice();
  const host = createHost({ device, requestApproval: async () => ({ approved: false, reason: "not now" }) });
  const response = await callTool(host, "send_serial_input", { text: "rm -rf /tmp/x", appendEnter: true });
  assert.equal(response.status, 200);
  /* The phone UI explains why it refused; that reason travels to the caller. */
  assert.equal(toolErrorText(response.message), "Not executed: not now");
  assert.equal(calls.execute.length, 0);
  assert.equal(host.getAudit()[0].outcome, "denied");
});

test("a denial without a reason keeps the generic human-denial sentence", async () => {
  const { device, calls } = fakeDevice();
  const host = createHost({ device, requestApproval: async () => ({ approved: false }) });
  const response = await callTool(host, "send_serial_input", { text: "ls", appendEnter: true });
  assert.equal(toolErrorText(response.message), "Not executed: the request was denied on the phone.");
  assert.equal(calls.execute.length, 0);
});

test("fully-authorized mode runs approval-gated tools without asking the phone", async () => {
  const approvals = [];
  const { device, calls } = fakeDevice();
  const host = createHost({
    device,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: false };
    },
  });
  const state = await host.setConfig({ access: "auto" });
  assert.equal(state.access, "auto");

  const write = await callTool(host, "send_serial_input", { text: "uname -a", appendEnter: true });
  assert.equal(write.status, 200);
  assert.equal(toolPayload(write.message).delivery, "sent");
  assert.equal(approvals.length, 0);
  assert.equal(calls.execute.length, 1);
  assert.equal(host.getAudit()[0].outcome, "ok");

  /* A scan is approval-gated but not a write: the fully-authorized mode skips
   * that prompt too. */
  const { accessory } = fakeAccessory({ scan: async () => ({ failed: false, networks: [{ ssid: "Bench" }] }) });
  const scanHost = createHost({
    accessory,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: false };
    },
  });
  await scanHost.setConfig({ access: "auto" });
  const scan = await callTool(scanHost, "wifi_scan");
  assert.equal(scan.status, 200);
  assert.equal(toolPayload(scan.message).failed, false);
  assert.equal(approvals.length, 0);
});

test("fully-authorized mode still runs preflight and honours the read-only switch", async () => {
  const missingHost = createHost();
  await missingHost.setConfig({ access: "auto" });
  const missing = await callTool(missingHost, "send_serial_input", { text: "ls", appendEnter: true });
  assert.match(toolErrorText(missing.message), /No target device session/);

  const { device } = fakeDevice();
  const readHost = createHost({ device });
  await readHost.setConfig({ access: "auto" });
  await readHost.setConfig({ access: "read" });
  const denied = await callTool(readHost, "send_serial_input", { text: "ls", appendEnter: true });
  assert.match(toolErrorText(denied.message), /read-only mode/);
});

test("read-only access mode asks nothing, including scans", async () => {
  const approvals = [];
  const scans = [];
  const { accessory } = fakeAccessory();
  const host = createHost({
    accessory,
    bee: {
      scan: async (options) => {
        scans.push(options);
        return [{ deviceId: "AA", name: "Linkr Bee 1", rssi: -40 }];
      },
    },
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: false };
    },
  });
  await host.setConfig({ access: "read" });
  const wifi = await callTool(host, "wifi_scan");
  assert.equal(wifi.message.result.isError, undefined);
  const boards = await callTool(host, "scan_bee_devices");
  assert.equal(boards.message.result.isError, undefined);
  assert.equal(toolPayload(boards.message).devices.length, 1);
  assert.equal(scans.length, 1);
  // Read-only mode refuses writes instead of asking for them.
  const denied = await callTool(host, "set_bee_name", { name: "Bench" });
  assert.match(toolErrorText(denied.message), /read-only mode/);
  assert.equal(approvals.length, 0);
});

test("high-risk-only mode runs ordinary writes without asking the phone", async () => {
  const approvals = [];
  const { device, calls } = fakeDevice();
  const { accessory } = fakeAccessory();
  const host = createHost({
    device,
    accessory,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: false };
    },
  });
  const state = await host.setConfig({ access: "guarded" });
  assert.equal(state.access, "guarded");

  const send = await callTool(host, "send_serial_input", { text: "uname -a", appendEnter: true });
  assert.equal(send.message.result.isError, undefined);
  assert.equal(toolPayload(send.message).delivery, "sent");

  const uart = await callTool(host, "set_uart_config", { baud: 115200 });
  assert.equal(uart.message.result.isError, undefined);

  const rename = await callTool(host, "set_bee_name", { name: "Bench Bee" });
  assert.equal(rename.message.result.isError, undefined);

  const scan = await callTool(host, "wifi_scan");
  assert.equal(scan.message.result.isError, undefined);

  assert.equal(approvals.length, 0);
  assert.equal(calls.execute.length, 1);
  assert.equal(host.getAudit()[0].outcome, "ok");
});

test("high-risk-only mode still asks for destructive serial input", async () => {
  const approvals = [];
  const { device, calls } = fakeDevice();
  const host = createHost({
    device,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: false };
    },
  });
  await host.setConfig({ access: "guarded" });

  const rm = await callTool(host, "send_serial_input", { text: "rm -rf /tmp/bench", appendEnter: true });
  assert.equal(toolErrorText(rm.message), "Not executed: the request was denied on the phone.");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].tool, "send_serial_input");

  const sudo = await callTool(host, "send_serial_input", { text: "sudo cat /etc/shadow", appendEnter: true });
  assert.equal(toolErrorText(sudo.message), "Not executed: the request was denied on the phone.");
  assert.equal(approvals.length, 2);

  /* Reboot is recoverable and deliberately absent from the destructive guard,
   * so the guarded mode sends it directly. */
  const reboot = await callTool(host, "send_serial_input", { text: "reboot", appendEnter: true });
  assert.equal(reboot.message.result.isError, undefined);
  assert.equal(approvals.length, 2);
  assert.equal(calls.execute.length, 1);
});

test("high-risk-only mode gates credential, bridge and forget changes", async () => {
  const approvals = [];
  const { accessory } = fakeAccessory();
  const disconnects = [];
  const host = createHost({
    accessory,
    bee: {
      disconnect: async (options) => {
        disconnects.push(options);
        return { connected: false, savedDeviceId: options.forget ? null : "AA" };
      },
    },
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  await host.setConfig({ access: "guarded" });

  // Safe variants run directly.
  await callTool(host, "set_webdav", { action: "off" });
  await callTool(host, "set_lan_bridge", { action: "off" });
  await callTool(host, "disconnect_bee", {});
  assert.equal(approvals.length, 0);

  // Credentials, bridge exposure and forgetting the board still ask.
  await callTool(host, "set_wifi", { action: "connect", ssid: "Bench", password: "secret" });
  await callTool(host, "set_webdav", { action: "on", url: "https://example.test/logs" });
  await callTool(host, "set_lan_bridge", { action: "rotate-token" });
  await callTool(host, "disconnect_bee", { forget: true });
  assert.deepEqual(approvals.map((request) => request.tool), [
    "set_wifi", "set_webdav", "set_lan_bridge", "disconnect_bee",
  ]);
  assert.equal(approvals[0].args.password, "<redacted>");
  assert.equal(disconnects.length, 2);
});

test("isHighRiskToolCall keeps the guarded gate narrowly high risk", () => {
  assert.equal(isHighRiskToolCall("send_serial_input", { text: "uname -a" }), false);
  assert.equal(isHighRiskToolCall("send_serial_input", { text: "rm -rf /tmp/x" }), true);
  assert.equal(isHighRiskToolCall("send_serial_input", { text: "dd if=/dev/zero of=/dev/mmcblk0" }), true);
  assert.equal(isHighRiskToolCall("send_serial_input", { text: "sudo systemctl restart ssh" }), true);
  assert.equal(isHighRiskToolCall("set_wifi", { action: "off" }), true);
  assert.equal(isHighRiskToolCall("set_webdav", { action: "on" }), true);
  assert.equal(isHighRiskToolCall("set_webdav", { action: "off" }), false);
  assert.equal(isHighRiskToolCall("set_lan_bridge", { action: "on" }), true);
  assert.equal(isHighRiskToolCall("set_lan_bridge", { action: "rotate-token" }), true);
  assert.equal(isHighRiskToolCall("set_lan_bridge", { action: "off" }), false);
  assert.equal(isHighRiskToolCall("disconnect_bee", { forget: true }), true);
  assert.equal(isHighRiskToolCall("disconnect_bee", {}), false);
  assert.equal(isHighRiskToolCall("set_uart_config", { baud: 9600 }), false);
  assert.equal(isHighRiskToolCall("set_bee_name", { name: "Bench" }), false);
  assert.equal(isHighRiskToolCall("connect_bee", {}), false);
  assert.equal(isHighRiskToolCall("wifi_scan", {}), false);
  assert.equal(isHighRiskToolCall("scan_bee_devices", {}), false);
  assert.equal(isHighRiskToolCall("get_device_status", {}), false);
});

test("a write on a missing target is refused before approval is requested", async () => {
  const approvals = [];
  const host = createHost({
    device: null,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const response = await callTool(host, "send_serial_input", { text: "ls", appendEnter: true });
  assert.match(toolErrorText(response.message), /No target device session/);
  assert.equal(approvals.length, 0);
});

test("only one device-changing call runs at a time", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { device } = fakeDevice({
    execute: async () => {
      await gate;
      return {
        id: "serial-1", delivery: "sent", executionStatus: "unknown", observation: "no-output",
        evidence: "", evidenceStart: 0, evidenceTruncated: false,
        observedCursor: 0, latestCursor: 0, hasMore: false,
      };
    },
  });
  const host = createHost({ device });
  const first = callTool(host, "send_serial_input", { text: "one", appendEnter: true });
  const second = await callTool(host, "send_serial_input", { text: "two", appendEnter: true });
  assert.equal(second.status, 200);
  assert.match(toolErrorText(second.message), /another action is in progress/);
  release();
  const firstResponse = await first;
  assert.equal(firstResponse.message.result.isError, undefined);
  assert.equal(host.getAudit()[0].outcome, "ok");
});

test("tool failures are isError results, not JSON-RPC errors", async () => {
  const { accessory } = fakeAccessory({
    diagnostics: async () => {
      throw new Error("management channel busy");
    },
  });
  const host = createHost({ accessory });
  const response = await callTool(host, "get_accessory_diagnostics");
  assert.equal(response.status, 200);
  assert.match(toolErrorText(response.message), /management channel busy/);
  assert.equal(host.getAudit()[0].outcome, "error");
});

test("get_accessory_diagnostics bounds lines and requires the management channel", async () => {
  const { accessory } = fakeAccessory();
  const host = createHost({ accessory });
  const payload = toolPayload((await callTool(host, "get_accessory_diagnostics")).message);
  assert.equal(payload.source, "accessory-management-channel");
  assert.equal(payload.command, "@i?");
  assert.equal(payload.settled, true);
  assert.equal(payload.groups.fw.version, "1");
  assert.equal(payload.lines.length, 24);

  const missing = await callTool(createHost({ accessory: null }), "get_accessory_diagnostics");
  assert.match(toolErrorText(missing.message), /unavailable/i);
});

test("wifi_scan enforces capabilities, bounds networks and stays usable read-only", async () => {
  const networks = Array.from({ length: 25 }, (_, index) => ({ ssid: `net-${index}`, rssi: -40 - index }));
  const { accessory } = fakeAccessory({ scan: async () => ({ failed: false, networks }) });
  const host = createHost({ accessory });
  const response = await callTool(host, "wifi_scan");
  const payload = toolPayload(response.message);
  assert.equal(payload.failed, false);
  assert.equal(payload.networks.length, 20);
  assert.equal(payload.networks[19].ssid, "net-19");
  assert.match(payload.note, /empty list/i);

  const { accessory: limited } = fakeAccessory({ capability: { wifi: false } });
  const denied = await callTool(createHost({ accessory: limited }), "wifi_scan");
  assert.match(toolErrorText(denied.message), /WiFi control/);

  // A scan changes no stored configuration, so read-only mode still allows it.
  await host.setConfig({ access: "read" });
  const readOnlyScan = await callTool(host, "wifi_scan");
  assert.equal(readOnlyScan.message.result.isError, undefined);
});

test("accessory changes return the redacted command and the read-back evidence", async () => {
  const approvals = [];
  const { accessory, calls } = fakeAccessory({
    command: (action, args) =>
      `@u=${args.baud},${args.dataBits ?? 8},${args.parity ?? "n"},${args.stopBits ?? 1},${args.flow ?? "none"}`,
    execute: async (request) => ({
      command: request.command,
      reply: "OK uart=115200,8,e,1,none",
      accepted: true,
      confirmed: { baud: 115200, dataBits: 8, parity: "e", stopBits: 1, flow: "none" },
      settled: true,
      applied: true,
    }),
  });
  const host = createHost({
    accessory,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const response = await callTool(host, "set_uart_config", { baud: 115200, parity: "e" });
  const payload = toolPayload(response.message);
  assert.equal(payload.source, "accessory-management-channel");
  assert.equal(payload.command, "@u=115200,8,e,1,none");
  assert.equal(payload.reply, "OK uart=115200,8,e,1,none");
  assert.equal(payload.applied, true);
  assert.equal(payload.settled, true);
  assert.match(payload.note, /applied=false/);
  assert.match(approvals[0].summary, /UART/);
  assert.deepEqual(calls.execute[0].action, "set-uart");
  assert.equal(calls.execute[0].command, "@u=115200,8,e,1,none");
});

test("a WiFi password never reaches the tool result, summary or audit", async () => {
  const PASSWORD = "BenchSecret-9f2";
  const approvals = [];
  const { accessory, calls } = fakeAccessory({
    command: () => `@w=Bench,${PASSWORD}`,
    // The step is deliberately leaky: the host itself must scrub the value.
    execute: async (request) => ({
      command: request.command,
      reply: `OK wifi=connected,ssid=Bench,ip=10.0.0.2 echo @w=Bench,${PASSWORD}`,
      accepted: true,
      applied: true,
      settled: true,
    }),
  });
  const host = createHost({
    accessory,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const response = await callTool(host, "set_wifi", { action: "connect", ssid: "Bench", password: PASSWORD });
  assert.equal(response.message.result.isError, undefined);
  const text = response.message.result.content[0].text;
  assert.doesNotMatch(text, /BenchSecret/);
  assert.match(text, /"command":"@w=Bench,<redacted>"/);

  assert.doesNotMatch(JSON.stringify(approvals), /BenchSecret/);
  assert.equal(approvals[0].args.password, "<redacted>");
  assert.equal(approvals[0].args.ssid, "Bench");
  assert.doesNotMatch(JSON.stringify(host.getAudit()), /BenchSecret/);
  assert.equal(host.getAudit()[0].args.password, "<redacted>");
  // The app still receives the real command over the management channel.
  assert.equal(calls.execute[0].command, `@w=Bench,${PASSWORD}`);
});

test("the audit list is bounded, newest first and redacted", async () => {
  const { device } = fakeDevice();
  const host = createHost({ device, readLog: fakeJournal().read });
  for (let index = 0; index < 55; index++) {
    await callTool(host, "get_device_status");
  }
  assert.equal(host.getAudit().length, 50);
  assert.equal(host.getState().audit.length, 50);
  await callTool(host, "read_serial_log", { limit: 10 });
  const audit = host.getAudit();
  assert.equal(audit.length, 50);
  assert.equal(audit[0].tool, "read_serial_log");
  assert.equal(audit[0].outcome, "ok");
  assert.equal(audit[0].remote, null);
  assert.match(audit[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof audit[0].durationMs, "number");
  assert.deepEqual(audit[0].args, { limit: 10 });
});

test("validateMcpConfig rejects invalid records with stable messages", () => {
  assert.deepEqual(validateMcpConfig({}), { enabled: false, port: 8712, bind: "lan", access: "confirm" });
  assert.deepEqual(defaultMcpConfig({ port: 9000 }), { enabled: false, port: 9000, bind: "lan", access: "confirm" });
  // "ask" is the tool-level access label; it normalizes to the stored mode.
  assert.equal(validateMcpConfig({ access: "ask" }).access, "confirm");
  assert.throws(() => validateMcpConfig({ port: 80 }), /MCP port/);
  assert.throws(() => validateMcpConfig({ port: 65536 }), /MCP port/);
  assert.throws(() => validateMcpConfig({ port: "8712" }), /MCP port/);
  assert.throws(() => validateMcpConfig({ bind: "wan" }), /MCP bind/);
  assert.equal(validateMcpConfig({ access: "auto" }).access, "auto");
  assert.equal(validateMcpConfig({ access: "guarded" }).access, "guarded");
  assert.throws(() => validateMcpConfig({ access: "write" }), /MCP access/);
  assert.throws(() => validateMcpConfig({ enabled: "yes" }), /MCP enabled/);
  assert.throws(() => validateMcpConfig({ nonsense: true }), /Unknown MCP configuration field/);
  assert.throws(() => validateMcpConfig(null), /must be an object/);
});

test("setConfig validates before persisting and keeps the previous record on error", async () => {
  const storage = memoryStorage();
  const host = createHost({ storage });
  assert.deepEqual(host.getConfig(), { enabled: false, port: 8712, bind: "lan", access: "confirm" });
  const state = await host.setConfig({ port: 9000, bind: "loopback", access: "read" });
  assert.equal(state.port, 9000);
  assert.equal(state.bind, "loopback");
  assert.equal(state.access, "read");
  assert.deepEqual(JSON.parse(storage.data.get(MCP_CONFIG_KEY)), {
    enabled: false, port: 9000, bind: "loopback", access: "read",
  });
  await assert.rejects(() => host.setConfig({ port: 80 }), /MCP port/);
  await assert.rejects(() => host.setConfig({ bind: "wan" }), /MCP bind/);
  await assert.rejects(() => host.setConfig({ access: "write" }), /MCP access/);
  await assert.rejects(() => host.setConfig({ unknownKey: 1 }), /Unknown MCP configuration field/);
  await assert.rejects(() => host.setConfig(null), /must be an object/);
  assert.equal(JSON.parse(storage.data.get(MCP_CONFIG_KEY)).port, 9000);
});

test("a stored configuration is restored and a corrupt record falls back", () => {
  const restored = createHost({
    storage: memoryStorage({
      [MCP_CONFIG_KEY]: JSON.stringify({ enabled: true, port: 9100, bind: "loopback", access: "read" }),
    }),
  });
  assert.deepEqual(restored.getConfig(), { enabled: true, port: 9100, bind: "loopback", access: "read" });
  assert.equal(restored.getState().enabled, true);
  const corrupt = createHost({ storage: memoryStorage({ [MCP_CONFIG_KEY]: "{oops" }) });
  assert.equal(corrupt.getConfig().port, 8712);
});

test("getState is a synchronous snapshot with the documented fields", () => {
  const host = createHost();
  const state = host.getState();
  assert.equal(typeof state.then, "undefined");
  assert.deepEqual(Object.keys(state).sort(), [
    "access", "activeRequests", "audit", "bind", "enabled", "foreground",
    "lastError", "port", "running", "token", "url", "urls",
  ]);
  assert.equal(state.enabled, false);
  assert.equal(state.running, false);
  assert.equal(state.url, "");
  assert.deepEqual(state.urls, []);
  assert.equal(state.token, "");
  assert.equal(state.port, 8712);
  assert.equal(state.bind, "lan");
  assert.equal(state.access, "confirm");
  assert.equal(state.foreground, false);
  assert.equal(state.activeRequests, 0);
  assert.equal(state.lastError, null);
  assert.deepEqual(state.audit, []);
  assert.equal(host.getBridge(), null);
});

test("enable/disable and setConfig drive the native bridge", async () => {
  const { bridge, calls } = fakeBridge();
  const host = createHost({ bridge });
  assert.equal(host.getBridge(), bridge);

  const attached = await host.attach();
  assert.equal(attached.running, false);
  assert.equal(calls.listeners, 3);
  await host.attach();
  assert.equal(calls.listeners, 3, "attach must be idempotent");

  const [enabled] = await Promise.all([host.enable(), host.enable()]);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.running, true);
  assert.equal(calls.start.length, 1, "concurrent enable calls share one native start");
  assert.deepEqual(calls.start[0], { port: 8712, bind: "lan" });
  assert.match(enabled.url, /8712/);

  const rotated = await host.regenerateToken();
  assert.equal(rotated.token, "b".repeat(64));
  const refreshed = await host.refreshState();
  assert.equal(refreshed.running, true);

  const restarted = await host.setConfig({ port: 9000 });
  assert.equal(calls.stop, 1);
  assert.deepEqual(calls.start.at(-1), { port: 9000, bind: "lan" });
  assert.equal(restarted.port, 9000);
  assert.equal(restarted.running, true);

  const disabled = await host.disable();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.running, false);
  assert.equal(calls.stop, 2);
  await host.dispose();
});

test("an older native state reply cannot overwrite a newer snapshot", async () => {
  let resolveState;
  const pendingState = new Promise((resolve) => {
    resolveState = resolve;
  });
  const { bridge, state } = fakeBridge();
  bridge.getState = async () => pendingState;
  const host = createHost({ bridge });
  const attaching = host.attach(); // its refreshState waits on the slow getState
  await new Promise((resolve) => setTimeout(resolve, 0));
  await host.enable(); // start answers first and sets running:true
  assert.equal(host.getState().running, true);
  resolveState({ ...state, running: false, url: "" }); // stale pre-start reply
  await attaching;
  assert.equal(host.getState().running, true, "a stale getState reply must be ignored");
});

test("bridge failures surface through lastError without throwing", async () => {
  const { bridge } = fakeBridge({
    start: async () => {
      throw new Error("port in use");
    },
  });
  const host = createHost({ bridge });
  const state = await host.enable();
  assert.equal(state.enabled, true);
  assert.equal(state.running, false);
  assert.match(state.lastError, /Could not start the MCP server: port in use/);
  const updated = await host.setConfig({ port: 9001 });
  assert.equal(updated.port, 9001);
  assert.equal(host.getConfig().port, 9001);
});

test("the host reports Android-only availability when no bridge exists", async () => {
  const host = createHost();
  const state = await host.enable();
  assert.equal(state.enabled, true);
  assert.equal(state.running, false);
  assert.match(state.lastError, /Android app/);
  assert.deepEqual(await host.refreshState(), host.getState());
  assert.deepEqual(await host.regenerateToken(), host.getState());
  assert.equal(host.getBridge(), null);
});

test("handleHttp answers every forwarded request through the native bridge", async () => {
  const { bridge, calls } = fakeBridge();
  const { device } = fakeDevice();
  const host = createHost({ bridge, device });
  await host.enable();
  await host.attach();

  const ok = await host.handleHttp({
    id: "req-1",
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_device_status", arguments: {} } }),
    remote: "192.168.1.7",
    userAgent: "cursor/1.0",
  });
  assert.equal(ok.status, 200);
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].id, "req-1");
  assert.equal(calls.respond[0].status, 200);
  assert.equal(JSON.parse(calls.respond[0].body).id, 9);
  assert.equal(host.getAudit()[0].remote, "192.168.1.7");

  const notification = await host.handleHttp({
    id: "req-2",
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    remote: "192.168.1.7",
  });
  assert.equal(notification.status, 202);
  assert.deepEqual(calls.respond[1], { id: "req-2", status: 202, body: "" });

  const parseError = await host.handleHttp({ id: "req-3", body: "{not json" });
  assert.equal(parseError.status, 400);
  assert.equal(calls.respond[2].status, 400);
  assert.equal(JSON.parse(calls.respond[2].body).error.code, -32700);
});

test("attach subscribes to forwarded HTTP requests and mirrors stateChanged", async () => {
  const { bridge, calls, listeners } = fakeBridge();
  const { device } = fakeDevice();
  const host = createHost({ bridge, device });
  await host.attach();
  await host.enable();
  const requestListener = listeners.find((entry) => entry.event === "httpRequest").callback;
  const stateListener = listeners.find((entry) => entry.event === "stateChanged").callback;
  assert.equal(typeof requestListener, "function");
  assert.equal(typeof stateListener, "function");

  requestListener({
    id: "native-1",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    remote: "10.0.0.9",
    userAgent: "cursor/1.0",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.respond.length, 1);
  assert.equal(calls.respond[0].id, "native-1");
  assert.deepEqual(JSON.parse(calls.respond[0].body).result, {});

  stateListener({
    running: true, port: 8712, bind: "lan", token: "t".repeat(64),
    url: "http://10.0.0.2:8712/mcp", urls: ["http://10.0.0.2:8712/mcp"],
    foreground: false, activeRequests: 2, lastError: null,
  });
  const state = host.getState();
  assert.equal(state.running, true);
  assert.equal(state.activeRequests, 2);
  assert.equal(state.foreground, false);
  assert.equal(state.url, "http://10.0.0.2:8712/mcp");
});

test("claudeConfigSnippet produces a usable Claude Desktop server entry", () => {
  const token = "a".repeat(64);
  const snippet = claudeConfigSnippet({ url: "http://192.168.1.20:8712/mcp", token });
  const parsed = JSON.parse(snippet);
  assert.deepEqual(Object.keys(parsed.mcpServers), [MCP_SERVER_NAME]);
  const entry = parsed.mcpServers[MCP_SERVER_NAME];
  assert.equal(entry.type, "http");
  assert.equal(entry.url, "http://192.168.1.20:8712/mcp");
  assert.equal(entry.headers.Authorization, `Bearer ${token}`);
});

test("redactToolArguments masks credentials and URL userinfo without mutating input", () => {
  const args = { action: "connect", ssid: "Bench", password: "secret" };
  const redacted = redactToolArguments("set_wifi", args);
  assert.equal(redacted.password, "<redacted>");
  assert.equal(redacted.ssid, "Bench");
  assert.equal(args.password, "secret");
  assert.equal(
    redactToolArguments("set_webdav", { action: "on", url: "http://user:pass@host/dav/" }).url,
    "http://<redacted>@host/dav/",
  );
  assert.equal(redactToolArguments("x", { token: "abc" }).token, "<redacted>");
  assert.equal(redactToolArguments("x", { apiKey: "abc" }).apiKey, "<redacted>");
  assert.deepEqual(redactToolArguments("x", null), {});
  assert.deepEqual(readCatalogNames(), TOOL_NAMES);
});

/* Reading the exported catalog directly (instead of tools/list) keeps the
 * fixed-name assertion honest: the transport projection cannot hide a rename. */
function readCatalogNames() {
  return MCP_TOOLS.map((tool) => tool.name);
}

/* ------------------------------------------------------------------ *
 * Linkr Bee board lifecycle + identity tools
 * ------------------------------------------------------------------ */
test("get_bee_status reports the app's bridge connection and identity", async () => {
  const host = createHost({
    bee: {
      status: async () => ({
        connected: true,
        transport: "ble",
        device: "Linkr Bee Test",
        deviceId: "test-device-1",
        legacy: false,
        management: { available: true, wifi: true, webdav: true, asyncEvents: true },
        bleName: "Linkr Bee Test",
        bleNameCustom: false,
        lanBridge: { state: "off", enabled: false, hasToken: true },
      }),
    },
  });
  const response = await callTool(host, "get_bee_status");
  const payload = toolPayload(response.message);
  assert.equal(payload.source, "linkr-bee-connection");
  assert.equal(payload.connected, true);
  assert.equal(payload.transport, "ble");
  assert.equal(payload.bleName, "Linkr Bee Test");
  assert.equal(payload.lanBridge.hasToken, true);
  assert.match(payload.note, /target console/);
});

test("scan_bee_devices asks the phone and returns the scanned boards", async () => {
  const approvals = [];
  const scans = [];
  const host = createHost({
    bee: {
      scan: async (options) => {
        scans.push(options);
        return [{ deviceId: "AA", name: "Linkr Bee 1", rssi: -42 }];
      },
    },
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const response = await callTool(host, "scan_bee_devices", { durationMs: 4000 });
  const payload = toolPayload(response.message);
  assert.deepEqual(payload.devices, [{ deviceId: "AA", name: "Linkr Bee 1", rssi: -42 }]);
  assert.equal(approvals.length, 1);
  assert.match(approvals[0].summary, /Linkr Bee/);
  assert.equal(scans[0].durationMs, 4000);
});

test("connect_bee asks the phone and connects to the requested board", async () => {
  const approvals = [];
  const connects = [];
  const host = createHost({
    bee: {
      connect: async (options) => {
        connects.push(options);
        return { connected: true, transport: "ble", deviceId: options.deviceId };
      },
    },
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const response = await callTool(host, "connect_bee", { deviceId: "AA:BB" });
  const payload = toolPayload(response.message);
  assert.equal(payload.connected, true);
  assert.equal(connects[0].deviceId, "AA:BB");
  assert.equal(approvals.length, 1);
  assert.match(approvals[0].summary, /AA:BB/);
});

test("disconnect_bee passes forget through and reports the new state", async () => {
  const calls = [];
  const host = createHost({
    bee: {
      disconnect: async (options) => {
        calls.push(options);
        return { connected: false, savedDeviceId: null };
      },
    },
  });
  const response = await callTool(host, "disconnect_bee", { forget: true });
  const payload = toolPayload(response.message);
  assert.equal(payload.connected, false);
  assert.equal(payload.forgotten, true);
  assert.equal(calls[0].forget, true);
});

test("connection tools are refused in read-only mode and when the dependency is missing", async () => {
  const host = createHost({ bee: { connect: async () => ({ connected: true }) } });
  await host.setConfig({ access: "read" });
  const refused = await callTool(host, "connect_bee", { deviceId: "AA" });
  assert.match(toolErrorText(refused.message), /read-only mode/);

  const missing = createHost();
  const unavailable = await callTool(missing, "scan_bee_devices");
  assert.match(toolErrorText(unavailable.message), /connection control is unavailable/i);

  const both = await callTool(host, "connect_bee", { deviceId: "AA", name: "Bee" });
  assert.equal(both.message.error.code, -32602);
  assert.match(both.message.error.message, /cannot be combined/);
});

test("set_bee_name and set_lan_bridge use the accessory helpers and report the read-back", async () => {
  const { accessory, calls } = fakeAccessory();
  const host = createHost({ accessory });

  const renamed = await callTool(host, "set_bee_name", { name: "Bench Bee" });
  const renamePayload = toolPayload(renamed.message);
  assert.equal(renamePayload.applied, true);
  assert.deepEqual(calls.changeBleName[0].name, "Bench Bee");
  assert.match(renamePayload.note, /Device ID/);

  const reset = await callTool(host, "set_bee_name", { reset: true });
  assert.equal(toolPayload(reset.message).applied, true);
  assert.equal(calls.changeBleName[1].reset, true);

  const lan = await callTool(host, "set_lan_bridge", { action: "rotate-token" });
  assert.equal(toolPayload(lan.message).applied, true);
  assert.equal(calls.changeLanBridge[0].action, "rotate-token");

  const invalid = await callTool(host, "set_bee_name", {});
  assert.equal(invalid.message.error.code, -32602);
  const combined = await callTool(host, "set_bee_name", { name: "x", reset: true });
  assert.equal(combined.message.error.code, -32602);
});

test("set_bee_name requires the management channel instead of approving an impossible call", async () => {
  const approvals = [];
  const host = createHost({
    accessory: fakeAccessory({ capability: { available: false, reason: "LAN only" } }).accessory,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const response = await callTool(host, "set_bee_name", { name: "x" });
  assert.match(toolErrorText(response.message), /LAN only/);
  assert.equal(approvals.length, 0);
});

/* ------------------------------------------------------------------ *
 * Execution status: tracked completion + polling by id
 * ------------------------------------------------------------------ */
test("send_serial_input with trackExit and waitForCompletion reports the exit code", async () => {
  const { device, calls } = fakeDevice({
    execute: async () => ({
      id: "serial-2",
      state: "sent",
      delivery: "sent",
      executionStatus: "unknown",
      observation: "output-observed",
      evidence: "",
      tracked: true,
    }),
    inspectExecution: () => {
      // First poll: still running; second: the shell printed the token.
      if (!calls.inspect.length || calls.inspect.length === 1) {
        return { id: "serial-2", state: "sent", delivery: "sent", executionStatus: "unknown", observation: "output-observed", evidence: "", observationClosed: false };
      }
      return { id: "serial-2", state: "sent", delivery: "sent", executionStatus: "completed", observation: "prompt-returned", evidence: "uname -a\nLinux\n", observationClosed: true, exitCode: 0, completionToken: "LINKR_EXIT_x" };
    },
  });
  const host = createHost({ device });
  const response = await callTool(host, "send_serial_input", {
    text: "uname -a",
    appendEnter: true,
    trackExit: true,
    waitForCompletion: true,
    timeoutMs: 5000,
  });
  const payload = toolPayload(response.message);
  assert.equal(payload.completed, true);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.tracked, true);
  assert.equal(payload.executionStatus, "completed");
  assert.equal(payload.timedOut, false);
  assert.match(payload.note, /Tracked command/);
  assert.equal(calls.execute[0].args.trackExit, true);
  assert.equal(calls.inspect.length >= 1, true);
});

test("get_execution_status returns the current snapshot and waits on request", async () => {
  let polls = 0;
  const { device } = fakeDevice({
    inspectExecution: () => {
      polls += 1;
      return polls < 2
        ? { id: "serial-1", state: "sent", delivery: "sent", executionStatus: "unknown", observation: "no-output", evidence: "", observationClosed: false }
        : { id: "serial-1", state: "sent", delivery: "sent", executionStatus: "unknown", observation: "output-observed", evidence: "hello\n", observationClosed: false };
    },
  });
  const host = createHost({ device });
  const snapshot = await callTool(host, "get_execution_status", { id: "serial-1" });
  const immediate = toolPayload(snapshot.message);
  assert.equal(immediate.id, "serial-1");
  assert.equal(immediate.completed, false);
  assert.equal(immediate.timedOut, true);

  const waited = await callTool(host, "get_execution_status", { id: "serial-1", waitMs: 1000 });
  const payload = toolPayload(waited.message);
  assert.equal(payload.id, "serial-1");
  assert.equal(payload.timedOut, true);
  assert.equal(payload.completed, false);
});

test("execution tracking validates its arguments and reports unknown ids", async () => {
  const { device } = fakeDevice();
  const host = createHost({ device });

  const semantic = await callTool(host, "send_serial_input", {
    text: "ls",
    appendEnter: true,
    waitForCompletion: true,
  });
  assert.equal(semantic.message.error.code, -32602);
  assert.match(semantic.message.error.message, /trackExit/);

  const missing = await callTool(host, "get_execution_status", { id: "serial-unknown" });
  assert.equal(missing.message.result.isError, true);
  assert.match(missing.message.result.content[0].text, /No execution/);
});

test("pending approval is revoked when MCP access changes to read-only", async () => {
  let approve;
  const decision = new Promise((resolve) => { approve = resolve; });
  const { device, calls } = fakeDevice();
  const host = createHost({ device, requestApproval: () => decision });
  const pending = callTool(host, "send_serial_input", { text: "echo pending", appendEnter: true });
  await host.setConfig({ access: "read" });
  approve({ approved: true });
  const response = await pending;
  assert.equal(calls.execute.length, 0);
  assert.match(toolErrorText(response.message), /changed|revoked|read.only/i);
});

test("approval cannot move a serial write into a replacement target session", async () => {
  let approve;
  const decision = new Promise((resolve) => { approve = resolve; });
  const status = { deviceId: "board-A", sessionId: "session-A" };
  const { device, calls } = fakeDevice({ status });
  const host = createHost({ device, requestApproval: () => decision });
  const pending = callTool(host, "send_serial_input", { text: "echo target-A", appendEnter: true });
  status.deviceId = "board-B";
  status.sessionId = "session-B";
  approve({ approved: true });
  const response = await pending;
  assert.equal(calls.execute.length, 0);
  assert.match(toolErrorText(response.message), /session|target.*changed/i);
});

test("disabling MCP revokes an approval that was already displayed", async () => {
  let approve;
  const decision = new Promise((resolve) => { approve = resolve; });
  const { bridge } = fakeBridge();
  const { device, calls } = fakeDevice();
  const host = createHost({ bridge, device, requestApproval: () => decision });
  await host.enable();
  const pending = callTool(host, "send_serial_input", { text: "echo stale", appendEnter: true });
  await host.disable();
  approve({ approved: true });
  const response = await pending;
  assert.equal(calls.execute.length, 0);
  assert.match(toolErrorText(response.message), /stopped|disabled|revoked/i);
});

test("an expired native request cannot submit serial input after WebView resumes", async () => {
  const { bridge } = fakeBridge();
  const { device, calls } = fakeDevice();
  const host = createHost({ bridge, device });
  await host.enable();
  const response = await host.handleHttp({
    id: "expired-native-call", deadlineMs: Date.now() - 1,
    body: JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/call", params: {
      name: "send_serial_input", arguments: { text: "echo too-late", appendEnter: true },
    } }),
  });
  assert.equal(calls.execute.length, 0);
  assert.match(response.body, /expired|timed out/i);
});

test("disable during an in-flight start still leaves the native listener stopped", async () => {
  let finishStart;
  const ready = new Promise((resolve) => { finishStart = resolve; });
  const { bridge, calls, state } = fakeBridge();
  const originalStart = bridge.start;
  bridge.start = async (config) => { await ready; return originalStart(config); };
  const host = createHost({ bridge });
  const enabling = host.enable();
  const disabling = host.disable();
  finishStart();
  await Promise.all([enabling, disabling]);
  assert.equal(host.getConfig().enabled, false);
  assert.equal(state.running, false);
  assert.ok(calls.stop > 0);
});

test("native timeout cancellation revokes only its own pending request", async () => {
  let approvalSignal;
  const { bridge, listeners } = fakeBridge();
  const { device, calls } = fakeDevice();
  const host = createHost({ bridge, device, requestApproval: (request) => {
    approvalSignal = request.signal;
    return new Promise(() => {});
  } });
  await host.attach();
  await host.enable();
  const pending = host.handleHttp({ id: "native-cancelled", body: JSON.stringify({
    jsonrpc: "2.0", id: 9, method: "tools/call", params: {
      name: "send_serial_input", arguments: { text: "echo waiting", appendEnter: true },
    },
  }) });
  const cancel = listeners.find(entry => entry.event === "requestCancelled").callback;
  cancel({ id: "a-different-request" });
  assert.equal(approvalSignal.aborted, false);
  cancel({ id: "native-cancelled" });
  const response = await pending;
  assert.equal(approvalSignal.aborted, true);
  assert.equal(calls.execute.length, 0);
  assert.match(response.body, /expired|cancelled/i);
});

test("rotating the bearer token revokes a pending approval immediately", async () => {
  const { bridge } = fakeBridge();
  const { device, calls } = fakeDevice();
  const host = createHost({ bridge, device, requestApproval: () => new Promise(() => {}) });
  await host.enable();
  const pending = callTool(host, "send_serial_input", { text: "echo waiting", appendEnter: true });
  await host.regenerateToken();
  const response = await pending;
  assert.equal(calls.execute.length, 0);
  assert.match(toolErrorText(response.message), /token.*changed|revoked/i);
});

test("native stop events revoke pending approvals", async () => {
  const { bridge, listeners } = fakeBridge();
  const { device, calls } = fakeDevice();
  const host = createHost({ bridge, device, requestApproval: () => new Promise(() => {}) });
  await host.attach();
  await host.enable();
  const pending = callTool(host, "send_serial_input", { text: "echo waiting", appendEnter: true });
  listeners.find(entry => entry.event === "stateChanged").callback({ running: false });
  const response = await pending;
  assert.equal(calls.execute.length, 0);
  assert.match(toolErrorText(response.message), /stopped|revoked/i);
});

test("the native deadline also bounds an unresolved approval", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { bridge } = fakeBridge();
  const { device, calls } = fakeDevice();
  const host = createHost({ bridge, device, requestApproval: () => new Promise(() => {}) });
  await host.enable();
  const pending = host.handleHttp({ id: "native-deadline", deadlineMs: Date.now() + 5000,
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: {
      name: "send_serial_input", arguments: { text: "echo waiting", appendEnter: true },
    } }),
  });
  t.mock.timers.tick(4001);
  const response = await pending;
  assert.equal(calls.execute.length, 0);
  assert.match(response.body, /timed out/i);
});

test("a forwarded request delivered after stop cannot act on the device", async () => {
  const { bridge } = fakeBridge();
  const { device, calls } = fakeDevice();
  const host = createHost({ bridge, device });
  await host.enable();
  await host.disable();
  const response = await host.handleHttp({ id: "late-after-stop", body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "send_serial_input", arguments: { text: "echo late", appendEnter: true },
    },
  }) });
  assert.equal(response.status, 503);
  assert.equal(calls.execute.length, 0);
});

test("a native cancellation arriving before its HTTP event still prevents execution", async () => {
  const { bridge, listeners } = fakeBridge();
  const { device, calls } = fakeDevice();
  const host = createHost({ bridge, device });
  await host.attach();
  await host.enable();
  listeners.find(entry => entry.event === "requestCancelled").callback({ id: "late-cancelled-call" });
  const response = await host.handleHttp({ id: "late-cancelled-call", body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "send_serial_input", arguments: { text: "echo late", appendEnter: true },
    },
  }) });
  assert.equal(response.status, 504);
  assert.equal(calls.execute.length, 0);
});

/* ------------------------------------------------------------------ *
 * Resident agent delegation tools
 * ------------------------------------------------------------------ */
function fakeResidentAgent(overrides = {}) {
  const calls = { start: [], get: [], list: [], cancel: [], cancelAll: 0, status: 0 };
  const tasks = new Map();
  const state = {
    available: true,
    configured: true,
    model: { provider: "openai-completions", model: "test-model", endpoint: "https://api.example.test" },
    humanAssistantBusy: false,
    queued: 0,
    ...(overrides.status || {}),
  };
  let taskCounter = 0;
  const agent = {
    calls,
    tasks,
    getStatus() {
      calls.status += 1;
      return { ...state };
    },
    isBusy: overrides.isBusy || (() => false),
    startTask(args) {
      calls.start.push({ ...args });
      const task = {
        taskId: `agent-task-${++taskCounter}`,
        sessionId: args.sessionId || "default",
        state: "running",
        request: args.request,
        result: "",
        error: "",
        createdAt: "2026-10-29T00:00:00.000Z",
        startedAt: "2026-10-29T00:00:00.000Z",
        finishedAt: null,
        timedOut: false,
        limitReached: false,
        unresolvedExecutions: 0,
        usage: { input: 0, output: 0, totalTokens: 0 },
        toolCalls: [],
        events: [],
        progress: "thinking",
      };
      tasks.set(task.taskId, task);
      return task;
    },
    async getTask(id) {
      calls.get.push(id);
      const task = tasks.get(id);
      if (!task) throw new Error(`No resident agent task "${id}".`);
      return { ...task };
    },
    listTasks(options = {}) {
      calls.list.push({ ...options });
      return [...tasks.values()].map((task) => ({ ...task }));
    },
    async cancelTask(id) {
      calls.cancel.push(id);
      const task = tasks.get(id);
      if (!task) throw new Error(`No resident agent task "${id}".`);
      task.state = "canceled";
      task.finishedAt = "2026-10-29T00:01:00.000Z";
      return { ...task };
    },
    /* Mirrors the resident manager's owner-side revocation: queued and running
     * tasks are canceled without touching anything else. */
    cancelAll() {
      calls.cancelAll += 1;
      for (const task of tasks.values()) {
        if (!["completed", "failed", "canceled"].includes(task.state)) {
          task.state = "canceled";
          task.finishedAt = "2026-10-29T00:01:00.000Z";
        }
      }
    },
  };
  return agent;
}

test("resident agent tools are ordered after the device tools", async () => {
  const host = createHost({ residentAgent: fakeResidentAgent() });
  const response = await rpc(host, "tools/list");
  assert.deepEqual(response.message.result.tools.map((tool) => tool.name), TOOL_NAMES);
});

test("get_agent_status reports the resident agent without exposing secrets", async () => {
  const agent = fakeResidentAgent();
  const host = createHost({ residentAgent: agent });
  const response = await callTool(host, "get_agent_status");
  const payload = toolPayload(response.message);
  assert.equal(payload.source, "resident-agent");
  assert.equal(payload.available, true);
  assert.equal(payload.model.model, "test-model");
  assert.equal(JSON.stringify(payload).includes("secret"), false);
});

test("start_agent_task asks once, then queues the task and returns it", async () => {
  const approvals = [];
  const agent = fakeResidentAgent();
  const host = createHost({
    residentAgent: agent,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const response = await callTool(host, "start_agent_task", {
    request: "check the target and report",
    sessionId: "s1",
    maxTurns: 8,
  });
  const payload = toolPayload(response.message);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].tool, "start_agent_task");
  assert.match(approvals[0].summary, /approval covers|批准后/);
  assert.equal(payload.taskId, "agent-task-1");
  assert.equal(payload.state, "running");
  assert.deepEqual(agent.calls.start, [{ request: "check the target and report", sessionId: "s1", maxTurns: 8 }]);
});

test("denying the task approval starts nothing", async () => {
  const agent = fakeResidentAgent();
  const host = createHost({ residentAgent: agent, requestApproval: async () => ({ approved: false }) });
  const response = await callTool(host, "start_agent_task", { request: "do work" });
  assert.equal(response.message.result.isError, true);
  assert.match(response.message.result.content[0].text, /denied on the phone/);
  assert.equal(agent.calls.start.length, 0);
});

test("read-only mode refuses start_agent_task but allows status and cancel", async () => {
  const agent = fakeResidentAgent();
  const host = createHost({ residentAgent: agent });
  await host.setConfig({ access: "read" });
  const refused = await callTool(host, "start_agent_task", { request: "do work" });
  assert.equal(refused.message.result.isError, true);
  assert.match(refused.message.result.content[0].text, /read-only/);
  assert.equal((await callTool(host, "get_agent_status")).message.result.isError, undefined);
  await callTool(host, "cancel_agent_task", { taskId: "agent-task-1" });
});

test("get/list/cancel agent tasks reach the resident manager", async () => {
  const agent = fakeResidentAgent();
  const host = createHost({ residentAgent: agent });
  await callTool(host, "start_agent_task", { request: "task" });
  const got = toolPayload((await callTool(host, "get_agent_task", { taskId: "agent-task-1" })).message);
  assert.equal(got.taskId, "agent-task-1");
  const listed = toolPayload((await callTool(host, "list_agent_tasks", { limit: 5 })).message);
  assert.equal(listed.tasks.length, 1);
  const canceled = toolPayload((await callTool(host, "cancel_agent_task", { taskId: "agent-task-1" })).message);
  assert.equal(canceled.state, "canceled");
  assert.equal(agent.calls.cancel[0], "agent-task-1");
});

test("an active resident task blocks other device-changing calls", async () => {
  const agent = fakeResidentAgent({ isBusy: () => true });
  const device = fakeDevice();
  const host = createHost({ device: device.device, residentAgent: agent });
  const denied = await callTool(host, "send_serial_input", { text: "ls", appendEnter: true });
  assert.equal(denied.message.result.isError, true);
  assert.match(denied.message.result.content[0].text, /resident agent is running/);
  assert.equal(device.calls.execute.length, 0);
});

test("start_agent_task refuses when the in-app assistant is busy or no AI config exists", async () => {
  const busy = fakeResidentAgent({ status: { humanAssistantBusy: true } });
  const busyHost = createHost({ residentAgent: busy });
  const busyResponse = await callTool(busyHost, "start_agent_task", { request: "work" });
  assert.match(busyResponse.message.result.content[0].text, /busy/);
  assert.equal(busy.calls.start.length, 0);

  const unconfigured = fakeResidentAgent({ status: { available: false } });
  const unconfiguredHost = createHost({ residentAgent: unconfigured });
  const unconfiguredResponse = await callTool(unconfiguredHost, "start_agent_task", { request: "work" });
  assert.match(unconfiguredResponse.message.result.content[0].text, /AI configuration/);
});

/* ------------------------------------------------------------------ *
 * A2A JSON-RPC and agent card
 * ------------------------------------------------------------------ */
async function enabledHost(options = {}) {
  const bridge = options.bridge || fakeBridge();
  const host = createHost({ ...options, bridge });
  await host.attach();
  await host.enable();
  return { host, bridge };
}

async function a2a(host, body) {
  const bridgeCalls = [];
  const response = await host.handleHttp({
    id: "native-a2a",
    path: "/a2a",
    body: JSON.stringify(body),
  });
  return { status: response.status, message: JSON.parse(response.body) };
}

test("the A2A agent card is public JSON with the JSONRPC interface and no token", async () => {
  const { host } = await enabledHost({ residentAgent: fakeResidentAgent() });
  const response = await host.handleHttp({ id: "card-1", method: "GET", path: "/.well-known/agent-card.json", body: "" });
  assert.equal(response.status, 200);
  const card = JSON.parse(response.body);
  assert.equal(card.name, "Linkr Bee Resident Agent");
  assert.equal(card.protocolVersion, "1.0");
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
  assert.match(card.supportedInterfaces[0].url, /\/a2a$/);
  assert.deepEqual(card.security, [{ bearer: [] }]);
  assert.equal(JSON.stringify(card).includes("a".repeat(64)), false);
});

test("A2A SendMessage approves once, starts the resident task and returns an A2A Task", async () => {
  const approvals = [];
  const agent = fakeResidentAgent();
  const { host } = await enabledHost({
    residentAgent: agent,
    requestApproval: async (request) => { approvals.push(request); return { approved: true }; },
  });
  const response = await a2a(host, {
    jsonrpc: "2.0", id: 1, method: "SendMessage",
    params: { message: { role: "ROLE_USER", parts: [{ text: "check the kernel" }], messageId: "m1", contextId: "ctx-1" } },
  });
  assert.equal(response.message.result.task.id, "agent-task-1");
  assert.equal(response.message.result.task.contextId, "ctx-1");
  assert.equal(response.message.result.task.status.state, "TASK_STATE_WORKING");
  assert.equal(approvals.length, 1);
  assert.equal(agent.calls.start[0].request, "check the kernel");
  assert.equal(agent.calls.start[0].sessionId, "ctx-1");
});

test("A2A refuses a task when the phone denies it or the access mode is read-only", async () => {
  const denied = await enabledHost({ residentAgent: fakeResidentAgent(), requestApproval: async () => ({ approved: false }) });
  const deniedResponse = await a2a(denied.host, {
    jsonrpc: "2.0", id: 1, method: "SendMessage",
    params: { message: { role: "ROLE_USER", parts: [{ text: "work" }] } },
  });
  /* App-specific failures use the non-reserved -32010..-32014 range. */
  assert.equal(deniedResponse.message.error.code, -32014);
  assert.equal(deniedResponse.message.error.data[0].reason, "DENIED");

  const readOnly = await enabledHost({ residentAgent: fakeResidentAgent() });
  await readOnly.host.setConfig({ access: "read" });
  const refusedResponse = await a2a(readOnly.host, {
    jsonrpc: "2.0", id: 2, method: "SendMessage",
    params: { message: { role: "ROLE_USER", parts: [{ text: "work" }] } },
  });
  assert.equal(refusedResponse.message.error.code, -32011);
  assert.equal(refusedResponse.message.error.data[0].reason, "READ_ONLY");
});

test("A2A GetTask, CancelTask, ListTasks and unsupported streaming answer honestly", async () => {
  const agent = fakeResidentAgent();
  const { host } = await enabledHost({ residentAgent: agent });
  await a2a(host, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "work" }] } } });
  const got = await a2a(host, { jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "agent-task-1" } });
  assert.equal(got.message.result.id, "agent-task-1");
  assert.equal(got.message.result.status.state, "TASK_STATE_WORKING");
  const listed = await a2a(host, { jsonrpc: "2.0", id: 3, method: "ListTasks", params: { pageSize: 5 } });
  assert.equal(listed.message.result.tasks.length, 1);
  const canceled = await a2a(host, { jsonrpc: "2.0", id: 4, method: "CancelTask", params: { id: "agent-task-1" } });
  assert.equal(canceled.message.result.status.state, "TASK_STATE_CANCELED");
  const unknown = await a2a(host, { jsonrpc: "2.0", id: 5, method: "GetTask", params: { id: "nope" } });
  assert.equal(unknown.message.error.data[0].reason, "TASK_NOT_FOUND");
  const streaming = await a2a(host, { jsonrpc: "2.0", id: 6, method: "SendStreamingMessage", params: {} });
  assert.equal(streaming.message.error.data[0].reason, "UNSUPPORTED_OPERATION");
  const unknownMethod = await a2a(host, { jsonrpc: "2.0", id: 7, method: "NoSuchMethod" });
  assert.equal(unknownMethod.message.error.code, -32601);
});

for (const action of ["disable", "rotate token", "read only", "target change", "native cancel", "deadline"]) {
  test(`A2A pending approval cannot execute after ${action}`, async () => {
    let approve, entered, sessionId = 1;
    const ready = new Promise(resolve => { entered = resolve; });
    const agent = fakeResidentAgent();
    const bridge = fakeBridge();
    const host = createHost({
      bridge: bridge.bridge, residentAgent: agent,
      device: { getStatus: () => ({ connected: true, sessionId }) },
      requestApproval: () => { entered(); return new Promise(resolve => { approve = resolve; }); },
    });
    await host.attach(); await host.enable();
    const pending = host.handleHttp({
      id: "approval-revocation", path: "/a2a",
      ...(action === "deadline" ? { deadlineMs: Date.now() + 1080 } : {}),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage",
        params: { message: { role: "ROLE_USER", parts: [{ text: "configure target" }] } } }),
    });
    await ready;
    if (action === "disable") await host.disable();
    if (action === "rotate token") await host.regenerateToken();
    if (action === "read only") await host.setConfig({ access: "read" });
    if (action === "target change") sessionId++;
    if (action === "native cancel") bridge.listeners.find(item => item.event === "requestCancelled").callback({ id: "approval-revocation" });
    if (action === "deadline") await new Promise(resolve => setTimeout(resolve, 100));
    approve({ approved: true });
    const result = JSON.parse((await pending).body);
    assert.ok(result.error);
    assert.equal(agent.calls.start.length, 0);
    await host.dispose();
  });
}

test("A2A validates task limits before asking for approval", async () => {
  const agent = fakeResidentAgent();
  let approvals = 0;
  const { host } = await enabledHost({
    residentAgent: agent, requestApproval: async () => { approvals++; return { approved: true }; },
  });
  const response = await a2a(host, { jsonrpc: "2.0", id: 1, method: "SendMessage",
    params: { message: { role: "ROLE_USER", parts: [{ text: "work" }] }, metadata: { maxTurns: -1 } } });
  assert.equal(response.message.error.code, -32602);
  assert.equal(approvals, 0);
  assert.equal(agent.calls.start.length, 0);
});

/* ------------------------------------------------------------------ *
 * Review regressions: JSON-RPC envelope, schema, preflight, journal reset
 * ------------------------------------------------------------------ */

test("JSON-RPC ids must be string, number or null, and a request always needs a method", async () => {
  const host = createHost();
  for (const id of [{ nested: true }, [1], true]) {
    const response = await host.handleRpc(JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }));
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, -32600);
    assert.equal(JSON.parse(response.body).id, null, "an invalid id must not be echoed back");
  }
  /* Neither method nor id is a malformed request, not a silent notification. */
  const noMethod = await host.handleRpc(JSON.stringify({ jsonrpc: "2.0" }));
  assert.equal(noMethod.status, 400);
  assert.equal(JSON.parse(noMethod.body).error.code, -32600);
  /* A real notification still gets 202, and a null id is a legal request id. */
  const notification = await host.handleRpc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.deepEqual(notification, { status: 202, body: "" });
  const nullId = await host.handleRpc(JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }));
  assert.equal(nullId.status, 200);
  assert.equal(JSON.parse(nullId.body).id, null);
});

test("additionalProperties:false is not bypassed by Object.prototype names", async () => {
  const host = createHost();
  for (const key of ["constructor", "toString", "hasOwnProperty"]) {
    const response = await callTool(host, "get_device_status", JSON.parse(`{"${key}":1}`));
    assert.equal(response.message.error.code, -32602, key);
    assert.match(response.message.error.message, new RegExp(`Unknown argument: ${key}`));
  }
});

test("invalid accessory commands are refused before the phone is asked", async () => {
  const approvals = [];
  const { accessory } = fakeAccessory({
    command: (action, args) => action === "set-wifi" ? wifiCommand(args)
      : action === "set-webdav" ? webdavCommand(args) : `@${action}`,
  });
  const host = createHost({
    accessory,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const wifi = await callTool(host, "set_wifi", { action: "connect" });
  assert.match(toolErrorText(wifi.message), /ssid/);
  const webdav = await callTool(host, "set_webdav", { action: "on" });
  assert.match(toolErrorText(webdav.message), /url/);
  /* Twelve Chinese characters are 36 UTF-8 bytes: the JSON Schema character
   * limit passes, the board's byte budget does not. */
  const beeName = await callTool(host, "set_bee_name", { name: "十个中文字符名字测试一下" });
  assert.match(toolErrorText(beeName.message), /29 UTF-8 bytes/);
  assert.equal(approvals.length, 0, "no approval may be requested for an impossible change");
});

test("read_serial_log reports a reset journal instead of an empty quiet page", async () => {
  const journal = new SerialJournal();
  const encode = (text) => new TextEncoder().encode(text);
  journal.append(encode("boot: old session\r\n"));
  const oldCursor = journal.read().latestCursor;
  journal.reset(); // reconnect or Clear
  journal.append(encode("new session\r\n"));
  const { device } = fakeDevice();
  const host = createHost({ device, readLog: (options) => journal.read(options) });

  const stale = await callTool(host, "read_serial_log", { after: oldCursor + 100 });
  const payload = toolPayload(stale.message);
  assert.equal(payload.text, "");
  assert.equal(payload.truncated, true, "a cursor from before the reset is a truncated window");
  assert.equal(payload.hasMore, false);
  assert.match(payload.note, /reset|ahead/i);

  const tail = toolPayload((await callTool(host, "read_serial_log", { recent: true })).message);
  assert.equal(tail.text, "new session\r\n");
  assert.equal(tail.truncated, false);
  assert.equal(tail.note, undefined);
});

/* ------------------------------------------------------------------ *
 * Review regressions: resident task revocation
 * ------------------------------------------------------------------ */

test("changing the access mode cancels a running resident task, not only pending calls", async () => {
  const agent = fakeResidentAgent();
  const host = createHost({
    residentAgent: agent,
    requestApproval: async () => ({ approved: true }),
  });
  const started = await callTool(host, "start_agent_task", { request: "drive the console" });
  assert.equal(started.message.result.isError, undefined);
  const before = agent.calls.cancelAll;
  await host.setConfig({ access: "read" });
  assert.equal(agent.calls.cancelAll, before + 1, "owner-side access change cancels resident work");
  assert.equal((await agent.getTask("agent-task-1")).state, "canceled");
});

test("rotating the token cancels a running resident task", async () => {
  const agent = fakeResidentAgent();
  const { bridge } = fakeBridge();
  const host = createHost({
    bridge, residentAgent: agent,
    requestApproval: async () => ({ approved: true }),
  });
  await host.attach();
  await host.enable();
  await callTool(host, "start_agent_task", { request: "drive the console" });
  const before = agent.calls.cancelAll;
  await host.regenerateToken();
  /* The explicit rotation and the resulting stateChanged snapshot may both
   * revoke, which is harmless; what matters is that resident work stops. */
  assert.ok(agent.calls.cancelAll > before);
  assert.equal((await agent.getTask("agent-task-1")).state, "canceled");
});

test("a native token change cancels resident tasks as well as pending approvals", async () => {
  const agent = fakeResidentAgent();
  const { bridge, listeners, state } = fakeBridge();
  const host = createHost({
    bridge, residentAgent: agent,
    requestApproval: async () => ({ approved: true }),
  });
  await host.attach();
  await host.enable();
  await callTool(host, "start_agent_task", { request: "drive the console" });
  const before = agent.calls.cancelAll;
  listeners.find((entry) => entry.event === "stateChanged").callback({ ...state, token: "b".repeat(64) });
  assert.equal(agent.calls.cancelAll, before + 1);
});

test("a native Stop notification that reports autoStart=false stays disabled", async () => {
  const storage = memoryStorage();
  let changes = 0;
  const { bridge, listeners, state } = fakeBridge();
  const host = createHost({ bridge, storage, onChange: () => { changes += 1; } });
  await host.attach();
  await host.enable();
  assert.equal(host.getConfig().enabled, true);
  const before = changes;
  listeners.find((entry) => entry.event === "stateChanged").callback({ ...state, running: false, autoStart: false });
  assert.equal(host.getConfig().enabled, false);
  assert.equal(JSON.parse(storage.data.get(MCP_CONFIG_KEY)).enabled, false);
  assert.ok(changes > before, "the UI is notified to re-render the disabled card");
});

test("stopping the server forgets messageId dedupe state", async () => {
  const agent = fakeResidentAgent();
  const { bridge } = fakeBridge();
  const host = createHost({ bridge, residentAgent: agent });
  await host.attach();
  await host.enable();
  const request = {
    jsonrpc: "2.0", id: 1, method: "SendMessage",
    params: { message: { role: "ROLE_USER", parts: [{ text: "work" }], messageId: "dedupe-reset", contextId: "ctx" } },
  };
  const first = await a2a(host, request);
  await host.disable();
  await host.enable();
  const second = await a2a(host, { ...request, id: 2 });
  assert.notEqual(second.message.result.task.id, first.message.result.task.id);
  assert.equal(agent.calls.start.length, 2);
});

/* ------------------------------------------------------------------ *
 * Review regressions: A2A codes, defaults, dedupe and pagination
 * ------------------------------------------------------------------ */

function sendMessage(id, { text = "work", messageId, contextId = "ctx", configuration } = {}) {
  const message = { role: "ROLE_USER", parts: [{ text }] };
  if (messageId) message.messageId = messageId;
  if (contextId) message.contextId = contextId;
  return { jsonrpc: "2.0", id, method: "SendMessage", params: { message, ...(configuration ? { configuration } : {}) } };
}

test("A2A SendMessage defaults to blocking and reads the task before answering", async () => {
  const agent = fakeResidentAgent();
  const { host } = await enabledHost({ residentAgent: agent });
  const response = await a2a(host, sendMessage(1));
  assert.equal(response.message.result.task.id, "agent-task-1");
  assert.ok(agent.calls.get.includes("agent-task-1"), "the blocking default waits on the task");
});

test("A2A retries with the same messageId return the existing task without a second approval", async () => {
  const approvals = [];
  const agent = fakeResidentAgent();
  const { host } = await enabledHost({
    residentAgent: agent,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const first = await a2a(host, sendMessage(1, { messageId: "retry-1" }));
  assert.equal(first.message.result.task.id, "agent-task-1");
  assert.equal(approvals.length, 1);
  const retry = await a2a(host, sendMessage(2, { messageId: "retry-1" }));
  assert.equal(retry.message.result.task.id, "agent-task-1");
  assert.equal(approvals.length, 1, "a lost response plus retry must not ask the phone twice");
  assert.equal(agent.calls.start.length, 1, "the physical task is not started twice");
});

test("A2A SendMessage naming an existing task asks for a new context message instead", async () => {
  const agent = fakeResidentAgent();
  const { host } = await enabledHost({ residentAgent: agent });
  await a2a(host, sendMessage(1));
  const continuation = await a2a(host, {
    jsonrpc: "2.0", id: 2, method: "SendMessage",
    params: {
      message: {
        role: "ROLE_USER", parts: [{ text: "follow up" }], taskId: "agent-task-1", contextId: "ctx",
      },
    },
  });
  assert.equal(continuation.message.error.code, -32004);
  assert.equal(continuation.message.error.data[0].reason, "UNSUPPORTED_OPERATION");
  assert.match(continuation.message.error.message, /new message with the same contextId/i);
  assert.equal(agent.calls.start.length, 1, "no second task starts in the old session");
});

test("A2A CancelTask on a terminal task returns TaskNotCancelable", async () => {
  const agent = fakeResidentAgent();
  const { host } = await enabledHost({ residentAgent: agent });
  await a2a(host, sendMessage(1));
  const canceled = await a2a(host, { jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id: "agent-task-1" } });
  assert.equal(canceled.message.result.status.state, "TASK_STATE_CANCELED");
  const again = await a2a(host, { jsonrpc: "2.0", id: 3, method: "CancelTask", params: { id: "agent-task-1" } });
  assert.equal(again.message.error.code, -32002);
  assert.equal(again.message.error.data[0].reason, "TASK_NOT_CANCELABLE");
  assert.equal(agent.calls.cancel.length, 1);
});

test("A2A push-notification methods report the unsupported capability", async () => {
  const { host } = await enabledHost({ residentAgent: fakeResidentAgent() });
  for (const method of [
    "CreateTaskPushNotificationConfig",
    "GetTaskPushNotificationConfig",
    "ListTaskPushNotificationConfigs",
    "DeleteTaskPushNotificationConfig",
  ]) {
    const response = await a2a(host, { jsonrpc: "2.0", id: 1, method, params: {} });
    assert.equal(response.message.error.code, -32003, method);
    assert.equal(response.message.error.data[0].reason, "PUSH_NOTIFICATION_NOT_SUPPORTED");
  }
});

test("A2A ListTasks pages by numeric offset and reports the full matched total", async () => {
  const agent = fakeResidentAgent();
  const { host } = await enabledHost({ residentAgent: agent });
  for (let index = 0; index < 3; index += 1) {
    await a2a(host, sendMessage(index + 1, { text: `work-${index}`, messageId: `page-${index}` }));
  }
  const first = await a2a(host, {
    jsonrpc: "2.0", id: 10, method: "ListTasks",
    /* An unsupported filter is ignored, not echoed or claimed. */
    params: { pageSize: 2, contextId: "ctx", statusFilter: "TASK_STATE_COMPLETED" },
  });
  assert.equal(first.message.result.tasks.length, 2);
  assert.equal(first.message.result.pageSize, 2);
  assert.equal(first.message.result.totalSize, 3, "totalSize is the matched count, not the page");
  assert.equal(first.message.result.nextPageToken, "2");
  assert.equal(first.message.result.statusFilter, undefined);
  const second = await a2a(host, {
    jsonrpc: "2.0", id: 11, method: "ListTasks",
    params: { pageSize: 2, pageToken: first.message.result.nextPageToken },
  });
  assert.equal(second.message.result.tasks.length, 1);
  assert.equal(second.message.result.totalSize, 3);
  assert.equal(second.message.result.nextPageToken, "");
});

test("A2A configuration, busy and disabled failures use non-reserved codes", async () => {
  const unconfigured = await enabledHost({ residentAgent: fakeResidentAgent({ status: { available: false } }) });
  const unavailable = await a2a(unconfigured.host, sendMessage(1));
  assert.equal(unavailable.message.error.code, -32012);
  assert.equal(unavailable.message.error.data[0].reason, "AGENT_NOT_CONFIGURED");

  const busy = await enabledHost({ residentAgent: fakeResidentAgent({ status: { humanAssistantBusy: true } }) });
  const busyResponse = await a2a(busy.host, sendMessage(1));
  assert.equal(busyResponse.message.error.code, -32013);
  assert.equal(busyResponse.message.error.data[0].reason, "TASK_BUSY");

  const stopped = await enabledHost({ residentAgent: fakeResidentAgent() });
  await stopped.host.disable();
  const disabled = await stopped.host.handleHttp({
    id: "a2a-disabled",
    path: "/a2a",
    body: JSON.stringify(sendMessage(1)),
  });
  assert.equal(disabled.status, 503);
  assert.equal(JSON.parse(disabled.body).error.code, -32010);
  assert.equal(JSON.parse(disabled.body).error.data[0].reason, "SERVER_DISABLED");
});

test("the task-start approval wording scopes consent to ordinary serial reads and writes", async () => {
  const approvals = [];
  const agent = fakeResidentAgent();
  const host = createHost({
    residentAgent: agent,
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const init = await rpc(host, "initialize", {});
  const instructions = init.message.result.instructions;
  assert.match(instructions, /ORDINARY serial reads and writes/);
  for (const phrase of [
    /destructive shell commands/,
    /WiFi scans/,
    /WiFi or other credentials/,
    /WebDAV enable/,
    /LAN-bridge on\/rotate-token/,
    /forgetting the saved board/,
  ]) {
    assert.match(instructions, phrase);
  }

  const list = await rpc(host, "tools/list", {});
  const tool = list.message.result.tools.find((item) => item.name === "start_agent_task");
  assert.match(tool.description, /ORDINARY serial reads and writes/);
  assert.match(tool.description, /WiFi or other credentials/);

  const response = await callTool(host, "start_agent_task", { request: "check the target" });
  const payload = toolPayload(response.message);
  assert.match(approvals[0].summary, /ORDINARY serial reads and writes/);
  assert.match(approvals[0].summary, /WiFi\/credentials/);
  assert.match(payload.note, /ORDINARY serial reads and writes/);
});
