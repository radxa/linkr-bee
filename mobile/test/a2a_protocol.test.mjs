import assert from "node:assert/strict";
import test from "node:test";
import {
  A2A_CARD_PATH,
  A2A_ERROR,
  A2A_JSONRPC_PATH,
  a2aAgentCard,
  a2aError,
  a2aListTasks,
  a2aTask,
  messageText,
  parseSendMessageParams,
} from "../../web/a2a_protocol.js";

test("the agent card advertises JSON-RPC, bearer auth and no streaming", () => {
  const card = a2aAgentCard({ url: "http://192.168.1.50:8712/a2a", lang: "zh" });
  assert.equal(card.protocolVersion, "1.0");
  assert.equal(card.supportedInterfaces[0].url, "http://192.168.1.50:8712/a2a");
  assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.deepEqual(card.defaultInputModes, ["text/plain"]);
  assert.equal(card.securitySchemes.bearer.scheme, "bearer");
  assert.equal(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme, "bearer");
  assert.equal(card.skills[0].id, "linkr-bee-serial-console");
  assert.match(card.skills[0].description, /串口/);
});

test("SendMessage params accept one or more text parts and default to blocking", () => {
  const parsed = parseSendMessageParams({
    message: {
      role: "ROLE_USER",
      parts: [{ text: "line one" }, { text: "line two" }],
      messageId: "m-1",
      contextId: "ctx-1",
    },
    configuration: { returnImmediately: false, historyLength: 2 },
  });
  assert.equal(parsed.request, "line one\nline two");
  assert.equal(parsed.sessionId, "ctx-1");
  assert.equal(parsed.messageId, "m-1");
  assert.equal(parsed.returnImmediately, false);
  assert.equal(parsed.historyLength, 2);
  // A2A v1.0 defaults to blocking; only an explicit true asks for the queued task.
  assert.equal(parseSendMessageParams({ message: { role: "ROLE_USER", parts: [{ text: "x" }] } }).returnImmediately, false);
  assert.equal(parseSendMessageParams({
    message: { role: "ROLE_USER", parts: [{ text: "x" }] },
    configuration: { returnImmediately: true },
  }).returnImmediately, true);
});

test("only text user messages are accepted", () => {
  assert.throws(() => messageText(null), /message is required/);
  assert.throws(() => messageText({ role: "ROLE_AGENT", parts: [{ text: "x" }] }), /ROLE_USER/);
  assert.throws(() => messageText({ role: "ROLE_USER", parts: [] }), /at least one/);
  assert.throws(() => messageText({ role: "ROLE_USER", parts: [{ data: {} }] }), /Only text/);
  assert.throws(() => messageText({ role: "ROLE_USER", parts: [{ text: "   " }] }), /non-empty/);
});

test("a resident task maps to an A2A Task with artifacts for a completed result", () => {
  const running = a2aTask({
    taskId: "agent-1", sessionId: "default", state: "running", progress: "tool:get_device_status",
    request: "check it", result: "", error: "", createdAt: "2026-10-29T00:00:00Z",
    usage: { input: 1, output: 2, totalTokens: 3 }, toolCalls: [{ name: "get_device_status", state: "running" }],
  });
  assert.equal(running.id, "agent-1");
  assert.equal(running.contextId, "default");
  assert.equal(running.status.state, "TASK_STATE_WORKING");
  assert.match(running.status.message.parts[0].text, /tool:/);
  assert.equal(running.status.message.role, "ROLE_AGENT");

  const completed = a2aTask({
    taskId: "agent-1", sessionId: "default", state: "completed", progress: "completed",
    request: "check it", result: "kernel 6.1", error: "", createdAt: "2026-10-29T00:00:00Z",
    finishedAt: "2026-10-29T00:01:00Z", historyLength: 0,
  }, { historyLength: 3 });
  assert.equal(completed.status.state, "TASK_STATE_COMPLETED");
  assert.equal(completed.artifacts[0].parts[0].text, "kernel 6.1");
  assert.equal(completed.history.length, 2);
  assert.equal(completed.history[0].role, "ROLE_USER");

  const failed = a2aTask({ taskId: "agent-2", state: "failed", error: "model refused", createdAt: "2026-10-29T00:00:00Z" });
  assert.equal(failed.status.state, "TASK_STATE_FAILED");
  assert.match(failed.status.message.parts[0].text, /refused/);
  const canceled = a2aTask({ taskId: "agent-3", state: "canceled", createdAt: "2026-10-29T00:00:00Z" });
  assert.equal(canceled.status.state, "TASK_STATE_CANCELED");
});

test("task lists report the total matched count and page by numeric offset", () => {
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    taskId: `task-${index}`,
    sessionId: "s",
    state: "completed",
    request: `r${index}`,
    result: "ok",
    createdAt: `2026-10-29T00:0${index}:00Z`,
  }));
  const first = a2aListTasks(tasks, { pageSize: 2 });
  assert.equal(first.tasks.length, 2);
  assert.equal(first.pageSize, 2);
  assert.equal(first.totalSize, 5, "totalSize is the matched count, not the page length");
  assert.equal(first.nextPageToken, "2");
  const second = a2aListTasks(tasks, { pageSize: 2, pageToken: first.nextPageToken });
  assert.deepEqual(second.tasks.map((task) => task.id), ["task-2", "task-3"]);
  assert.equal(second.totalSize, 5);
  assert.equal(second.nextPageToken, "4");
  const last = a2aListTasks(tasks, { pageSize: 2, pageToken: second.nextPageToken });
  assert.equal(last.tasks.length, 1);
  assert.equal(last.nextPageToken, "");
  assert.equal(last.totalSize, 5);
  // The response's own field name is accepted as the request token too.
  assert.equal(a2aListTasks(tasks, { pageSize: 2, nextPageToken: "4" }).tasks[0].id, "task-4");
  const error = a2aError(7, A2A_ERROR.TASK_NOT_FOUND, "Task not found", { reason: "TASK_NOT_FOUND" });
  assert.equal(error.jsonrpc, "2.0");
  assert.equal(error.id, 7);
  assert.equal(error.error.code, -32001);
  assert.equal(error.error.data[0].reason, "TASK_NOT_FOUND");
  assert.equal(A2A_JSONRPC_PATH, "/a2a");
  assert.equal(A2A_CARD_PATH, "/.well-known/agent-card.json");
});

test("A2A error codes stay outside the reserved -32001..-32004 range", () => {
  assert.equal(A2A_ERROR.TASK_NOT_FOUND, -32001);
  assert.equal(A2A_ERROR.TASK_NOT_CANCELABLE, -32002);
  assert.equal(A2A_ERROR.PUSH_NOTIFICATION_NOT_SUPPORTED, -32003);
  assert.equal(A2A_ERROR.UNSUPPORTED_OPERATION, -32004);
  for (const name of ["SERVER_DISABLED", "READ_ONLY", "AGENT_NOT_CONFIGURED", "TASK_BUSY", "DENIED"]) {
    assert.ok(A2A_ERROR[name] >= -32014 && A2A_ERROR[name] <= -32010, `${name} uses the app-specific range`);
  }
});
