import assert from "node:assert/strict";
import test from "node:test";
import {
  createInputLineTracker,
  inputLeavesPendingLine,
  isGuardedCommand,
  pendingInputLine,
  requiresInputApproval,
  serialInputReview,
} from "../../web/agent_execution_policy.js";
import { createDeviceExecutor } from "../../web/device_executor.js";
import { SerialJournal } from "../../web/serial_journal.js";
import { PROFILE_PROBE } from "../../web/device_profile.js";
import { DOWNLOAD_PROBE } from "../../web/download_plan.js";
import { readFileCommand } from "../../web/target_files.js";
import { createMcpHost, isHighRiskToolCall } from "../../web/mcp_server.js";

/* The review's H3 finding, as executable cases: one `send_serial_input` call is
 * not necessarily one command. `r` followed by `m -rf /tmp/x` must be treated
 * as the `rm -rf /tmp/x` the target shell will parse, in the MCP high-risk
 * gate, in Full Auto, and even when a caller says the input was approved. */

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

/* A real executor over a real journal, the way the app wires it. */
function executorFixture(initial = "root@board:~# ") {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode(initial));
  const status = { connected: true, sessionId: 1, inputRevision: 0, inputPending: false };
  const sent = [];
  const device = createDeviceExecutor({
    getStatus: () => ({ ...status }),
    readLog: (options) => journal.read(options),
    prepareInput: ({ text, appendEnter }) => text + (appendEnter ? "\r" : ""),
    sendInput: async (payload) => {
      sent.push(payload);
      return { inputRevision: ++status.inputRevision };
    },
  });
  return { device, status, sent, journal };
}

function mcpFixture(initial) {
  const fixture = executorFixture(initial);
  const approvals = [];
  const host = createMcpHost({
    getBridge: () => null,
    storage: memoryStorage(),
    getDevice: () => fixture.device,
    readLog: (options) => fixture.journal.read(options),
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
    getLang: () => "en",
    onChange: () => {},
  });
  return { ...fixture, host, approvals };
}

async function rpc(host, name, args) {
  const response = await host.handleRpc(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
  }));
  return JSON.parse(response.body);
}

test("a per-call classifier cannot see the fragment, the input line can", () => {
  /* The bug the review reproduced: on its own `m -rf /tmp/x` is not a command. */
  assert.equal(isHighRiskToolCall("send_serial_input", { text: "m -rf /tmp/x", appendEnter: true }), false);
  /* Joined with the console's unfinished line it is `rm -rf /tmp/x`. */
  assert.equal(isHighRiskToolCall("send_serial_input", { text: "m -rf /tmp/x", appendEnter: true },
    { pendingLine: "r" }), true);
  /* A write that leaves the line unfinished is not ordinary input either. */
  assert.equal(isHighRiskToolCall("send_serial_input", { text: "r", appendEnter: false }), true);
  /* A line this module did not write cannot be joined, so it forces review. */
  assert.equal(isHighRiskToolCall("send_serial_input", { text: "uname -a", appendEnter: true },
    { inputPending: true }), true);
  /* Ordinary, complete input keeps the narrow gate. */
  assert.equal(isHighRiskToolCall("send_serial_input", { text: "uname -a", appendEnter: true }), false);
});

test("quoting, backticks and backslashes cannot split a destructive command past the guard", () => {
  for (const text of ["r\"m\" -rf /tmp/x", "r`m` -rf /tmp/x", "r\\m -rf /tmp/x"]) {
    assert.equal(isGuardedCommand(text), true, text);
    assert.equal(isHighRiskToolCall("send_serial_input", { text, appendEnter: true }), true, text);
    assert.equal(requiresInputApproval("full-auto", { text, appendEnter: true }, text + "\r"), true, text);
  }
  /* A quoted mention still is not execution. */
  assert.equal(isGuardedCommand("echo 'never run rm -rf /'"), false);
});

test("Full Auto asks for fragments and unparseable lines, not for ordinary input", () => {
  const review = (text, appendEnter = true, payload = null) =>
    serialInputReview({ text, appendEnter, payload: payload ?? text + (appendEnter ? "\r" : "") });
  assert.equal(requiresInputApproval("full-auto", { text: "uname -a", appendEnter: true }, "uname -a\r",
    false, null, review("uname -a")), false);
  assert.equal(requiresInputApproval("full-auto", { text: "r", appendEnter: false }, "r",
    false, null, review("r", false)), true);
  assert.equal(requiresInputApproval("full-auto", { text: "echo \"hi\"", appendEnter: true }, "echo \"hi\"\r",
    false, null, review("echo \"hi\"")), true);
  /* Auto keeps the exact-query rule, so a clean query is still unattended. */
  assert.equal(requiresInputApproval("auto", { text: "uname -a", appendEnter: true }, "uname -a\r",
    false, null, review("uname -a")), false);
});

test("the tracked input line joins fragments per session and ends at a terminator", () => {
  const tracker = createInputLineTracker();
  assert.equal(tracker.current(1), "");
  assert.equal(tracker.record(1, "r"), "r");
  assert.equal(tracker.record(1, "m -rf /tmp/x"), "rm -rf /tmp/x");
  assert.equal(tracker.record(1, "m -rf /tmp/x\r"), "");
  tracker.record(1, "left-over");
  assert.equal(tracker.current(2), "", "a new session starts on an empty line");
  tracker.record(1, "discarded\x03");
  assert.equal(tracker.current(1), "", "Ctrl-C discards the line, like the tty");
  assert.equal(pendingInputLine("abc", "def"), "abcdef");
  assert.equal(pendingInputLine("abc", "def\r"), "");
  assert.equal(pendingInputLine("abc\r", "def"), "def");
  assert.equal(pendingInputLine("", "line\nnext"), "next");
  assert.equal(inputLeavesPendingLine(new TextEncoder().encode("r"), false), true);
});

test("guarded mode asks for the fragment and for the completed destructive line", async () => {
  const { host, approvals, sent } = mcpFixture();
  await host.setConfig({ access: "guarded" });

  const first = await rpc(host, "send_serial_input", { text: "r", appendEnter: false });
  assert.equal(first.result.isError, undefined);
  assert.equal(approvals.length, 1, "the fragment itself is not ordinary input");
  assert.match(approvals[0].summary, /stays unsubmitted/);

  const second = await rpc(host, "send_serial_input", { text: "m -rf /tmp/x", appendEnter: true });
  assert.equal(second.result.isError, undefined);
  assert.equal(approvals.length, 2, "the completion is classified after concatenation");
  assert.match(approvals[1].summary, /rm -rf \/tmp\/x/);
  assert.match(approvals[1].summary, /completes the current input line/);
  assert.deepEqual(sent, ["r", "m -rf /tmp/x\r"]);
});

test("confirm mode still asks for every serial write, ordinary input included", async () => {
  const { host, approvals } = mcpFixture();
  assert.equal(host.getConfig().access, "confirm");
  await rpc(host, "send_serial_input", { text: "uname -a", appendEnter: true });
  assert.equal(approvals.length, 1);
});

test("a text-scoped approval is honoured while the write runs the approved string", async () => {
  const { device, sent } = executorFixture();
  device.setMode("full-auto");
  /* web/agent_panel.js:1245 depends on this: the user pressed a button that
   * sends an app-built command (the target-identity bind carries sudo), so the
   * app's own gesture is the approval for that exact text. */
  await device.execute({ text: "rm -rf /tmp/x", appendEnter: true }, undefined, { userApproved: true });
  assert.deepEqual(sent, ["rm -rf /tmp/x\r"]);
});

test("a text-scoped approval never covers a command that continues another line", async () => {
  const { device, sent } = executorFixture();
  device.setMode("full-auto");
  /* The shard path from the review: the approval names `m -rf /tmp/x`, but the
   * console will run `rm -rf /tmp/x`. The approval is ignored and asked again. */
  await device.execute({ text: "r", appendEnter: false }, undefined, { userApproved: true });
  const pending = device.execute({ text: "m -rf /tmp/x", appendEnter: true }, undefined, { userApproved: true });
  const waiting = device.getRecords().at(-1);
  assert.equal(waiting.state, "awaiting-approval");
  assert.deepEqual(sent, ["r"]);
  device.reject(waiting.id);
  await assert.rejects(pending, /rejected/);
  assert.deepEqual(sent, ["r"], "the joined destructive command was never sent");
});

test("a text-scoped approval is ignored while the console holds a line the app did not write", async () => {
  const { device, status, sent } = executorFixture();
  device.setMode("full-auto");
  /* A human typing in the terminal leaves inputPending with no tracked text. */
  status.inputPending = true;
  const pending = device.execute({ text: "reboot", appendEnter: true }, undefined, { userApproved: true });
  assert.equal(device.getRecords().at(-1).state, "awaiting-approval");
  assert.deepEqual(sent, []);
  device.cancel();
  await assert.rejects(pending, /cancelled/);
});

test("a caller that classified the write passes the sensitive approval", async () => {
  const { device, sent } = executorFixture();
  device.setMode("full-auto");
  await device.execute({ text: "rm -rf /tmp/x", appendEnter: true }, undefined,
    { userApproved: true, sensitiveApproved: true });
  assert.deepEqual(sent, ["rm -rf /tmp/x\r"]);
});

test("a completion that only becomes destructive after the pending line asks again", async () => {
  const { device, sent } = executorFixture();
  device.setMode("full-auto");
  await device.execute({ text: "r", appendEnter: false }, undefined,
    { userApproved: true, sensitiveApproved: true });
  const pending = device.execute({ text: "m -rf /tmp/x", appendEnter: true }, undefined,
    { userApproved: true, sensitiveApproved: false });
  const waiting = device.getRecords().at(-1);
  assert.equal(waiting.state, "awaiting-approval");
  assert.deepEqual(sent, ["r"]);
  device.reject(waiting.id);
  await assert.rejects(pending, /rejected/);
  assert.deepEqual(sent, ["r"], "a denial sends nothing");
});

test("Full Auto asks for unparseable input and stays unattended for the rest", async () => {
  const { device, sent } = executorFixture();
  device.setMode("full-auto");

  const quoted = device.execute({ text: "echo \"hi\"", appendEnter: true });
  assert.equal(device.getRecords().at(-1).state, "awaiting-approval");
  device.reject(device.getRecords().at(-1).id);
  await assert.rejects(quoted, /rejected/);

  const fragment = device.execute({ text: "y", appendEnter: false });
  assert.equal(device.getRecords().at(-1).state, "awaiting-approval");
  device.cancel();
  await assert.rejects(fragment, /cancelled/);
  assert.deepEqual(sent, []);

  await device.execute({ text: "uname -a", appendEnter: true });
  assert.deepEqual(sent, ["uname -a\r"]);

  /* Ctrl-C discards the console line, so it is a complete keystroke, not a
   * fragment: an interrupt must stay one keypress in Full Auto. */
  await device.execute({ text: "\x03", appendEnter: false });
  assert.deepEqual(sent, ["uname -a\r", "\x03"]);
});

test("the app's own read-only builders do not need a second approval", async () => {
  const { device, sent } = executorFixture();
  device.setMode("full-auto");
  /* The file-read builder contains `dd` in a read, which the broad guard
   * matches on purpose; the app built this exact command, so an approval that
   * already covered it must not produce a second card. */
  await device.execute({ text: readFileCommand({ path: "/etc/os-release", offset: 0, bytes: 16 }),
    appendEnter: true, trackExit: true, applicationReadOnly: true }, undefined, { userApproved: true });
  assert.equal(sent.length, 1);
  assert.equal(device.getRecords().filter((record) => record.state === "awaiting-approval").length, 0);
});

test("the app's own probe commands stay unattended in Full Auto", async () => {
  const { device, sent, journal } = executorFixture();
  device.setMode("full-auto");
  const prompt = () => journal.append(new TextEncoder().encode("\r\nroot@board:~# "));
  /* These are constants built by the app, not model text: their quoting cannot
   * hide a command. The assertions in agent_execution_policy.test.mjs already
   * pin that they are not destructive. */
  await device.execute({ text: PROFILE_PROBE, appendEnter: true, trackExit: true, profileProbe: true });
  prompt();
  await device.execute({ text: DOWNLOAD_PROBE, appendEnter: true, trackExit: true, applicationReadOnly: true });
  assert.equal(sent.length, 2);
  assert.equal(device.getRecords().filter((record) => record.state === "awaiting-approval").length, 0);
});
