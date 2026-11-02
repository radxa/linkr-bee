import assert from "node:assert/strict";
import test from "node:test";
import {
  createResidentAgent,
  RESIDENT_MAX_QUEUE,
  RESIDENT_SESSION_KEY,
  validateResidentTaskArgs,
} from "../../web/resident_agent.js";

const CONFIG = {
  endpoint: "https://api.example.test/v1",
  model: "test-model",
  apiKey: "secret-key",
  provider: "openai-completions",
  reasoning: "off",
  contextWindow: 128000,
  maxTokens: 4096,
};

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

function fakeBaseDevice(calls = [], { mode = "auto" } = {}) {
  let currentMode = mode;
  return {
    get mode() { return currentMode; },
    setMode(value) { currentMode = value; },
    getStatus: () => ({ connected: true, sessionId: 7, deviceId: "dev-1", transport: "ble", uart: "115200,8,n,1,n" }),
    readLog: () => ({ text: "", latestCursor: 0 }),
    getRecords: () => [],
    inspectExecution: () => ({ id: "serial-1", state: "sent", delivery: "sent" }),
    observe() {},
    execute: async (args, _signal, options) => {
      calls.push({ args, options });
      return { id: "serial-1", state: "sent", delivery: "sent", executionStatus: "completed", exitCode: 0 };
    },
  };
}

/* The accessory surface the resident agent may use: three changes plus a scan,
 * all of which must ask the phone owner per call. */
function fakeAccessory() {
  const calls = { capability: 0, command: [], diagnostics: 0, scan: 0, execute: [] };
  return {
    calls,
    accessory: {
      capability() { calls.capability += 1; return { available: true, wifi: true, webdav: true, asyncEvents: true }; },
      command(action, args) { calls.command.push({ action, args }); return `@${action}`; },
      async diagnostics() { calls.diagnostics += 1; return { lines: [], groups: {} }; },
      async scan() { calls.scan += 1; return { networks: [{ ssid: "Bench" }] }; },
      async execute(request) {
        calls.execute.push(request);
        return { command: request.command, accepted: true, applied: true, settled: true };
      },
    },
  };
}

function fakeRunner(text, { onEvent, block, snapshot } = {}) {
  let release;
  let aborted = false;
  const gate = block ? new Promise((resolve) => { release = resolve; }) : null;
  return {
    release() { release?.(); },
    async prompt(promptText) {
      if (gate) await gate;
      if (aborted) throw new Error("aborted by test");
      onEvent?.({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `${text}: ${promptText}` }],
          usage: { input: 12, output: 7, totalTokens: 19 },
        },
      });
      return { limitReached: false, unresolvedExecutions: 0 };
    },
    abort() { aborted = true; release?.(); },
    snapshot: () => snapshot ?? [{ role: "user", content: text }, { role: "assistant", content: text }],
  };
}

function build({ config = CONFIG, busy = false, block = false, runnerSnapshot, mode = "auto",
  decide = async () => ({ approved: true }), approvalSurface = true, readBoardPrompt = null,
  commandPolicy = { alwaysAsk: [], allow: [] }, policyAccessor = true } = {}) {
  const storage = fakeStorage();
  const calls = [];
  const created = [];
  const readPrompts = [];
  const runners = [];
  const events = [];
  const approvals = [];
  const baseDevice = fakeBaseDevice(calls, { mode });
  const { accessory, calls: accessoryCalls } = fakeAccessory();
  let runnerText = "answer";
  const agent = createResidentAgent({
    storage,
    maxQueue: RESIDENT_MAX_QUEUE,
    getConfig: () => config,
    getDevice: () => baseDevice,
    accessory,
    getLang: () => "en",
    ...(policyAccessor ? { getCommandPolicy: () => commandPolicy } : {}),
    ...(approvalSurface ? {
      requestApproval: async (request) => {
        approvals.push(request);
        return decide(request);
      },
    } : {}),
    readBoardPrompt: readBoardPrompt || (async () => {
      readPrompts.push(true);
      return "board instruction";
    }),
    isHumanAgentBusy: () => busy,
    notes: null,
    createAgent: async (options) => {
      created.push(options);
      const runner = fakeRunner(runnerText, {
        onEvent: (event) => {
          options.onEvent?.(event);
          events.push(event);
        },
        block,
        snapshot: runnerSnapshot,
      });
      runners.push(runner);
      return runner;
    },
  });
  return {
    agent, storage, calls, created, readPrompts, runners, events, approvals,
    accessory, accessoryCalls, baseDevice,
    setRunnerText(value) { runnerText = value; },
    runnerOptions: (index = 0) => created[index],
  };
}

async function waitForState(agent, taskId, states, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await agent.getTask(taskId);
    if (states.includes(task.state)) return task;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${states.join("/")}: ${task.state}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("arguments and readiness are validated before a task is queued", async () => {
  for (const args of [null, {}, { request: "   " }, { request: "x".repeat(12001) },
    { request: "ok", sessionId: "bad id" }, { request: "ok", maxTurns: 0 },
    { request: "ok", maxTools: 999 }, { request: "ok", timeoutMs: -1 },
    { request: "ok", timeoutMs: 86400001 }]) {
    assert.throws(() => validateResidentTaskArgs(args), /object|request|sessionId|maxTurns|maxTools|timeoutMs/);
  }
  const noConfig = createResidentAgent({
    storage: fakeStorage(),
    getConfig: () => null,
    getDevice: () => fakeBaseDevice(),
    createAgent: async () => { throw new Error("must not run"); },
  });
  assert.equal(noConfig.getStatus().available, false);
  assert.throws(() => noConfig.startTask({ request: "hello" }), /AI configuration/);
});

test("a task runs with an already-approved device and records result, tools and usage", async () => {
  const harness = build();
  const task = harness.agent.startTask({ request: "check the target", sessionId: "s1" });
  assert.ok(["queued", "running"].includes(task.state));
  const done = await waitForState(harness.agent, task.taskId, ["completed"]);
  assert.match(done.result, /answer: check the target/);
  assert.equal(done.usage.input, 12);
  assert.equal(done.usage.output, 7);
  assert.equal(done.usage.totalTokens, 19);
  assert.equal(done.toolCalls.length, 0);

  const options = harness.runnerOptions(0);
  assert.equal(options.customInstructions, "board instruction");
  /* The wrapper reports the app's real mode; it no longer claims Full Auto. */
  assert.equal(options.device.mode, "auto");
  /* The runtime is told this is a resident task, not a human Manual/Auto run. */
  assert.equal(options.authorityMode, "resident");
  await options.device.execute({ text: "uname -a", appendEnter: true });
  assert.equal(harness.calls[0].options.userApproved, true);
  assert.deepEqual(harness.calls[0].args, { text: "uname -a", appendEnter: true });
  /* An ordinary write is covered by the task-start approval: no second card. */
  assert.equal(harness.approvals.length, 0);
  /* board instructions are read once per session. */
  assert.equal(harness.readPrompts.length, 1);
});

test("tasks are serialized and queued", async () => {
  const harness = build({ block: true });
  const first = harness.agent.startTask({ request: "first" });
  const second = harness.agent.startTask({ request: "second" });
  assert.equal((await harness.agent.getTask(first.taskId)).state, "running");
  assert.equal((await harness.agent.getTask(second.taskId)).state, "queued");
  assert.equal(harness.created.length, 1);
  const list = harness.agent.listTasks();
  assert.equal(list.length, 2);
  assert.equal(list[0].taskId, second.taskId);

  const canceled = await harness.agent.cancelTask(second.taskId);
  assert.equal(canceled.state, "canceled");
  /* Canceling the active task releases the runner; the canceled queued task
     must not start afterwards. */
  await harness.agent.cancelTask(first.taskId);
  await waitForState(harness.agent, first.taskId, ["canceled"]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.created.length, 1);
  harness.agent.dispose();
});

test("a session is continued with its messages and newSession starts clean", async () => {
  const snapshot = [{ role: "user", content: "old" }, { role: "assistant", content: "old answer" }];
  const harness = build({ runnerSnapshot: snapshot });
  const first = harness.agent.startTask({ request: "first", sessionId: "shared" });
  await waitForState(harness.agent, first.taskId, ["completed"]);
  const second = harness.agent.startTask({ request: "second", sessionId: "shared" });
  await waitForState(harness.agent, second.taskId, ["completed"]);
  assert.equal(harness.created.length, 2);
  assert.deepEqual(harness.runnerOptions(0).restoredMessages, null);
  assert.deepEqual(harness.runnerOptions(1).restoredMessages, snapshot);

  const fresh = harness.agent.startTask({ request: "third", newSession: true });
  await waitForState(harness.agent, fresh.taskId, ["completed"]);
  assert.notEqual(fresh.sessionId, "shared");
  assert.equal(harness.runnerOptions(2).restoredMessages, null);
  const stored = JSON.parse(harness.storage.getItem(RESIDENT_SESSION_KEY));
  assert.ok(stored.sessions.shared);
});

test("canceling a queued task removes it before it starts", async () => {
  const harness = build({ block: true });
  const running = harness.agent.startTask({ request: "running" });
  const queued = harness.agent.startTask({ request: "queued" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const canceled = await harness.agent.cancelTask(queued.taskId);
  assert.equal(canceled.state, "canceled");
  assert.equal((await harness.agent.getTask(running.taskId)).state, "running");
  await harness.agent.cancelTask(running.taskId);
  await waitForState(harness.agent, running.taskId, ["canceled"]);
  assert.equal(harness.created.length, 1);
  harness.agent.dispose();
});

test("a busy human conversation or disabled agent blocks new tasks", async () => {
  const busy = build({ busy: true });
  assert.throws(() => busy.agent.startTask({ request: "hello" }), /in-app assistant is busy/);

  const disabled = build({ config: null });
  assert.throws(() => disabled.agent.startTask({ request: "hello" }), /AI configuration/);
});

test("a task has no wall-clock deadline unless the caller asks for one", async () => {
  const harness = build({ block: true });
  const task = harness.agent.startTask({ request: "long task" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const running = await harness.agent.getTask(task.taskId);
  assert.equal(running.state, "running");
  assert.equal(running.timedOut, false);
  const status = harness.agent.getStatus();
  assert.equal(status.limits.defaultTaskTimeoutMs, 0);
  assert.equal(status.limits.maxTaskTimeoutMs, 24 * 60 * 60 * 1000);
  await harness.agent.cancelTask(task.taskId);
  harness.agent.dispose();
});

test("an explicit per-task timeout aborts and reports a timed-out failure", async () => {
  const harness = build({ block: true });
  const task = harness.agent.startTask({ request: "bounded task", timeoutMs: 25 });
  const done = await waitForState(harness.agent, task.taskId, ["failed"], 1000);
  assert.equal(done.timedOut, true);
  assert.match(done.error, /timed out/);
  harness.agent.dispose();
});

test("status exposes model details but never the key or headers", () => {
  const harness = build();
  const status = harness.agent.getStatus();
  assert.equal(status.available, true);
  assert.equal(status.model.model, "test-model");
  assert.equal(status.model.endpoint, "https://api.example.test");
  assert.equal(JSON.stringify(status).includes("secret-key"), false);
  assert.equal(JSON.stringify(status).toLowerCase().includes("apikey"), false);
});

test("queued tasks stay bound to their approved target and release the gate on mismatch", async () => {
  let target = "A", release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const seen = [];
  const agent = createResidentAgent({
    getConfig: () => CONFIG,
    getDevice: () => ({ ...fakeBaseDevice(), getStatus: () => ({ connected: true, deviceId: target, sessionId: target }) }),
    createAgent: async ({ device }) => {
      const bound = device.getStatus().deviceId;
      return { prompt: async text => {
        seen.push([text, bound]);
        if (text === "first") { started(); await new Promise(resolve => { release = resolve; }); }
        return {};
      }};
    },
  });
  agent.startTask({ request: "first" }); await ready;
  const queued = agent.startTask({ request: "configure A" });
  target = "B"; release();
  const failed = await waitForState(agent, queued.taskId, ["failed"]);
  assert.match(failed.error, /target session changed/);
  assert.deepEqual(seen, [["first", "A"]]);
  assert.equal(agent.isBusy(), false);
  const next = agent.startTask({ request: "configure B" });
  await waitForState(agent, next.taskId, ["completed"]);
  assert.deepEqual(seen[1], ["configure B", "B"]);
});

for (const missing of ["config", "device"]) {
  test(`queue recovers after missing ${missing} at task start`, async () => {
    let config = CONFIG, device = fakeBaseDevice(), release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const agent = createResidentAgent({
      getConfig: () => config, getDevice: () => device,
      createAgent: async () => ({ prompt: async text => {
        if (text === "first") { started(); await new Promise(resolve => { release = resolve; }); }
        return {};
      }}),
    });
    agent.startTask({ request: "first" }); await ready;
    const queued = agent.startTask({ request: "second" });
    if (missing === "config") config = null; else device = null;
    release();
    await waitForState(agent, queued.taskId, ["failed"]);
    assert.equal(agent.isBusy(), false);
    config = CONFIG; device = fakeBaseDevice();
    const next = agent.startTask({ request: "third" });
    await waitForState(agent, next.taskId, ["completed"]);
  });
}

for (const phase of ["board prompt", "runtime loading"]) {
  test(`cancel all during ${phase} drains queue without starting model work`, async () => {
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const block = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    let prompts = 0;
    const agent = createResidentAgent({
      getConfig: () => CONFIG, getDevice: () => fakeBaseDevice(),
      readBoardPrompt: phase === "board prompt" ? block : () => "",
      createAgent: async () => {
        if (phase === "runtime loading") await block();
        return { prompt: async () => { prompts++; }, abort() {} };
      },
    });
    const first = agent.startTask({ request: "first" }); await ready;
    const second = agent.startTask({ request: "second" });
    agent.cancelAll();
    assert.equal(agent.isBusy(), true); // initialization still owns the gate
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await agent.getTask(first.taskId)).state, "canceled");
    assert.equal((await agent.getTask(second.taskId)).state, "canceled");
    assert.equal(agent.isBusy(), false);
    assert.equal(prompts, 0);
  });

  test(`target change during ${phase} prevents model start`, async () => {
    let target = 1, release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const block = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    let prompts = 0;
    const agent = createResidentAgent({
      getConfig: () => CONFIG,
      getDevice: () => ({ ...fakeBaseDevice(), getStatus: () => ({ connected: true, sessionId: target }) }),
      readBoardPrompt: phase === "board prompt" ? block : () => "",
      createAgent: async () => {
        if (phase === "runtime loading") await block();
        return { prompt: async () => { prompts++; }, abort() {} };
      },
    });
    const task = agent.startTask({ request: "first" }); await ready;
    target++; release();
    assert.match((await waitForState(agent, task.taskId, ["failed"])).error, /target session changed/);
    assert.equal(prompts, 0);
    assert.equal(agent.isBusy(), false);
  });
}

test("local stop cancels active and queued work, keeping the gate until abort settles", async () => {
  const h = build({ block: true });
  const first = h.agent.startTask({ request: "first" });
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = h.agent.startTask({ request: "second" });
  h.agent.cancelAll();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await h.agent.getTask(first.taskId)).state, "canceled");
  assert.equal((await h.agent.getTask(second.taskId)).state, "canceled");
  assert.equal(h.runners.length, 1);
  assert.equal(h.agent.isBusy(), false);
});

/* ------------------------------------------------------------------ *
 * Sensitive calls inside an approved task
 * ------------------------------------------------------------------ */

async function completedOptions(harness, request = "do the task", sessionId = undefined) {
  const task = harness.agent.startTask(sessionId ? { request, sessionId } : { request });
  await waitForState(harness.agent, task.taskId, ["completed"]);
  return harness.runnerOptions(0);
}

test("the device wrapper reports the app's real execution mode", async () => {
  const harness = build({ mode: "manual" });
  const options = await completedOptions(harness);
  assert.equal(options.device.mode, "manual");
  /* A real mode change is visible to the tool runtime instead of being masked. */
  harness.baseDevice.setMode("full-auto");
  assert.equal(options.device.mode, "full-auto");
  harness.baseDevice.setMode("auto");
  assert.equal(options.device.mode, "auto");
});

test("a destructive serial command asks on the phone and a denial sends nothing", async () => {
  const harness = build({ decide: async () => ({ approved: false }) });
  const options = await completedOptions(harness);
  await assert.rejects(
    options.device.execute({ text: "rm -rf /", appendEnter: true }),
    /Not executed: the phone owner denied this sensitive command/,
  );
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.approvals.length, 1);
  assert.equal(harness.approvals[0].tool, "send_serial_input");
  assert.deepEqual(harness.approvals[0].args, { text: "rm -rf /", appendEnter: true });
  assert.match(harness.approvals[0].summary, /rm -rf \//);
  assert.ok(Number.isInteger(harness.approvals[0].timeoutMs));
});

test("an approved destructive command runs once, and the next one asks again", async () => {
  const harness = build({ decide: async () => true });
  const options = await completedOptions(harness);
  await options.device.execute({ text: "dd if=/dev/zero of=/dev/mmcblk0", appendEnter: true });
  assert.equal(harness.approvals.length, 1);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].options.userApproved, true);
  await options.device.execute({ text: "sudo poweroff", appendEnter: true });
  assert.equal(harness.approvals.length, 2);
  assert.equal(harness.calls.length, 2);
});

test("an ordinary serial write inside the task does not ask again", async () => {
  const harness = build();
  const options = await completedOptions(harness);
  await options.device.execute({ text: "uname -a", appendEnter: true });
  await options.device.execute({ text: "dmesg -T", appendEnter: true });
  assert.equal(harness.approvals.length, 0);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].options.userApproved, true);
});

test("every accessory change asks per call, masking the WiFi password and URL credentials", async () => {
  const harness = build();
  const options = await completedOptions(harness);

  await options.accessory.change({ action: "set-wifi", args: { action: "connect", ssid: "Bench", password: "hunter2" } });
  assert.equal(harness.approvals.length, 1);
  assert.equal(harness.approvals[0].tool, "set_wifi");
  assert.equal(harness.approvals[0].args.password, "<redacted>");
  assert.equal(JSON.stringify(harness.approvals[0]).includes("hunter2"), false);
  assert.equal(harness.accessoryCalls.execute.length, 1);
  /* The executed command still receives the real argument. */
  assert.equal(harness.accessoryCalls.execute[0].args.password, "hunter2");

  await options.accessory.change({ action: "set-webdav", args: { action: "on", url: "http://user:secret@example.test/dav" } });
  assert.equal(harness.approvals[1].tool, "set_webdav");
  assert.equal(JSON.stringify(harness.approvals[1]).includes("secret"), false);
  assert.match(harness.approvals[1].args.url, /<redacted>@example\.test/);

  await options.accessory.change({ action: "set-uart", args: { baud: 115200 } });
  assert.equal(harness.approvals[2].tool, "set_uart_config");
  assert.match(harness.approvals[2].summary, /115200/);
  assert.equal(harness.accessoryCalls.execute.length, 3);
});

test("a denied accessory change executes nothing", async () => {
  const harness = build({ decide: async () => ({ approved: false }) });
  const options = await completedOptions(harness);
  await assert.rejects(
    options.accessory.change({ action: "set-webdav", args: { action: "on", url: "http://example.test/dav" } }),
    /Not executed: the phone owner denied this WebDAV change/,
  );
  assert.equal(harness.accessoryCalls.execute.length, 0);
});

test("a WiFi scan asks on the phone, and a denial skips the scan", async () => {
  const approved = build();
  const allowed = await completedOptions(approved);
  await allowed.accessory.scan({});
  assert.equal(approved.approvals.length, 1);
  assert.equal(approved.approvals[0].tool, "wifi_scan");
  assert.equal(approved.accessoryCalls.scan, 1);

  const denied = build({ decide: async () => ({ approved: false }) });
  const refused = await completedOptions(denied);
  await assert.rejects(refused.accessory.scan({}), /denied this WiFi scan/);
  assert.equal(denied.approvals.length, 1);
  assert.equal(denied.accessoryCalls.scan, 0);
});

test("a build without an approval surface fails closed for sensitive calls only", async () => {
  const harness = build({ approvalSurface: false });
  const options = await completedOptions(harness);
  await assert.rejects(
    options.device.execute({ text: "rm -rf /", appendEnter: true }),
    /no approval surface/,
  );
  await assert.rejects(
    options.accessory.change({ action: "set-wifi", args: { action: "off" } }),
    /no approval surface/,
  );
  await assert.rejects(options.accessory.scan({}), /no approval surface/);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.accessoryCalls.execute.length, 0);
  assert.equal(harness.accessoryCalls.scan, 0);
  /* Ordinary writes still work: the task-start approval covers them. */
  await options.device.execute({ text: "uname -a", appendEnter: true });
  assert.equal(harness.calls.length, 1);
});

test("canceling while an approval card is open rejects the sensitive call without sending", async () => {
  let settle;
  const harness = build({ decide: () => new Promise((resolve) => { settle = resolve; }) });
  const options = await completedOptions(harness);
  const controller = new AbortController();
  const pending = options.device.execute({ text: "rm -rf /", appendEnter: true }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(harness.calls.length, 0);
  controller.abort();
  await assert.rejects(pending, /Not executed: the approval request was cancelled/);
  settle?.({ approved: true });
  assert.equal(harness.calls.length, 0);
});

test("a board-prompt read failure is retried by the next task", async () => {
  const storage = fakeStorage();
  const calls = [];
  const created = [];
  let reads = 0;
  const agent = createResidentAgent({
    storage,
    getConfig: () => CONFIG,
    getDevice: () => fakeBaseDevice(calls),
    readBoardPrompt: async () => {
      reads += 1;
      if (reads === 1) throw new Error("BLE dropped");
      return "board instruction";
    },
    createAgent: async (options) => {
      created.push(options);
      return { prompt: async () => ({}), abort() {}, snapshot: () => [] };
    },
  });
  const first = agent.startTask({ request: "first", sessionId: "s1" });
  await waitForState(agent, first.taskId, ["completed"]);
  assert.equal(reads, 1);
  assert.equal(created[0].customInstructions, "");

  const second = agent.startTask({ request: "second", sessionId: "s1" });
  await waitForState(agent, second.taskId, ["completed"]);
  assert.equal(reads, 2);
  assert.equal(created[1].customInstructions, "board instruction");

  /* Once the read succeeded, later tasks reuse the loaded instructions. */
  const third = agent.startTask({ request: "third", sessionId: "s1" });
  await waitForState(agent, third.taskId, ["completed"]);
  assert.equal(reads, 2);
  assert.equal(created[2].customInstructions, "board instruction");
});

test("approval summaries follow the app's language", async () => {
  const created = [];
  const approvals = [];
  const { accessory } = fakeAccessory();
  const agent = createResidentAgent({
    storage: fakeStorage(),
    getConfig: () => CONFIG,
    getDevice: () => fakeBaseDevice(),
    accessory,
    getLang: () => "zh",
    requestApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
    createAgent: async (options) => {
      created.push(options);
      return { prompt: async () => ({}), abort() {}, snapshot: () => [] };
    },
  });
  const task = agent.startTask({ request: "检查目标" });
  await waitForState(agent, task.taskId, ["completed"]);
  await created[0].device.execute({ text: "rm -rf /", appendEnter: true });
  assert.match(approvals[0].summary, /向目标串口发送敏感命令/);
  await created[0].accessory.change({ action: "set-wifi", args: { action: "connect", ssid: "Bench", password: "hunter2" } });
  assert.match(approvals[1].summary, /让配件连接 WiFi/);
  assert.equal(JSON.stringify(approvals[1]).includes("hunter2"), false);
});

test("a command on the target's always-ask list asks inside an approved task", async () => {
  const harness = build({ commandPolicy: { alwaysAsk: ["reboot"], allow: [] } });
  const options = await completedOptions(harness);
  /* Not on the list and not destructive: still covered by the task approval. */
  await options.device.execute({ text: "uname -a", appendEnter: true });
  assert.equal(harness.approvals.length, 0);
  assert.equal(harness.calls.length, 1);
  /* The user's always-ask entry is substring-matched, like the panel does. */
  await options.device.execute({ text: "reboot -f", appendEnter: true });
  assert.equal(harness.approvals.length, 1);
  assert.equal(harness.approvals[0].tool, "send_serial_input");
  assert.match(harness.approvals[0].summary, /reboot -f/);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].options.userApproved, true);
});

test("a denied always-ask command sends nothing and reports the denial", async () => {
  const harness = build({
    commandPolicy: { alwaysAsk: ["poweroff"], allow: [] },
    decide: async () => ({ approved: false }),
  });
  const options = await completedOptions(harness);
  await assert.rejects(
    options.device.execute({ text: "poweroff", appendEnter: true }),
    /Not executed: the phone owner denied this sensitive command/,
  );
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.approvals.length, 1);
});

test("the destructive guard still asks even with an empty always-ask list", async () => {
  const harness = build({ commandPolicy: { alwaysAsk: [], allow: [] } });
  const options = await completedOptions(harness);
  await options.device.execute({ text: "rm -rf /", appendEnter: true });
  assert.equal(harness.approvals.length, 1);
  assert.equal(harness.calls.length, 1);
});

test("no command-policy accessor means no extra list, and nothing breaks", async () => {
  const harness = build({ policyAccessor: false });
  const options = await completedOptions(harness);
  await options.device.execute({ text: "reboot", appendEnter: true });
  assert.equal(harness.approvals.length, 0);
  assert.equal(harness.calls.length, 1);
  /* The destructive guard is a hard floor regardless of the policy store. */
  await options.device.execute({ text: "rm -rf /", appendEnter: true });
  assert.equal(harness.approvals.length, 1);
  assert.equal(harness.calls.length, 2);
});

test("an unreadable policy store is treated as no extra list", async () => {
  const created = [];
  const approvals = [];
  const calls = [];
  const agent = createResidentAgent({
    storage: fakeStorage(),
    getConfig: () => CONFIG,
    getDevice: () => fakeBaseDevice(calls),
    getCommandPolicy: () => { throw new Error("localStorage unavailable"); },
    requestApproval: async (request) => { approvals.push(request); return { approved: true }; },
    createAgent: async (options) => {
      created.push(options);
      return { prompt: async () => ({}), abort() {}, snapshot: () => [] };
    },
  });
  const task = agent.startTask({ request: "check" });
  await waitForState(agent, task.taskId, ["completed"]);
  /* The policy cannot be read, so it adds nothing; the command is not guarded. */
  await created[0].device.execute({ text: "reboot", appendEnter: true });
  assert.equal(approvals.length, 0);
  assert.equal(calls.length, 1);
});

test("a target change while a sensitive approval is open sends nothing", async () => {
  for (const operation of ["serial", "accessory", "scan"]) {
    let harness;
    harness = build({ decide: async () => {
      harness.baseDevice.getStatus = () => ({ connected: true, sessionId: 8,
        deviceId: "dev-2", transport: "ble", uart: "115200,8,n,1,n" });
      return { approved: true };
    } });
    const options = await completedOptions(harness);
    const request = operation === "serial"
      ? options.device.execute({ text: "rm -rf /tmp/test", appendEnter: true })
      : operation === "scan" ? options.accessory.scan({})
        : options.accessory.change({ action: "set-uart", args: { baud: 9600 } });
    await assert.rejects(request, /target session changed/, operation);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.accessoryCalls.execute.length, 0);
    assert.equal(harness.accessoryCalls.scan, 0);
  }
});
