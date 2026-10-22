import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createModelStream } from "../src/model-stream.mjs";
import { createSerialAgent } from "../src/pi-agent.mjs";

const model = { api: "openai-completions", provider: "test", id: "test" };
const message = (patch = {}) => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
  content: [], stopReason: "stop", timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...patch });
const failure = (errorMessage = "503 Service temporarily unavailable", patch = {}) =>
  message({ stopReason: "error", errorMessage, ...patch });

function provider(respond) {
  let calls = 0;
  const stream = (...args) => {
    const output = createAssistantMessageEventStream();
    const { final, events = [] } = respond(++calls, ...args);
    queueMicrotask(() => {
      for (const event of events) output.push(event);
      output.push(final.stopReason === "stop" || final.stopReason === "toolUse"
        ? { type: "done", reason: final.stopReason, message: final }
        : { type: "error", reason: final.stopReason, error: final });
      output.end(final);
    });
    return output;
  };
  return { stream, calls: () => calls };
}

async function collect(runtime, options = {}) {
  const output = runtime.stream(model, { messages: [] }, options);
  const events = [];
  for await (const event of output) events.push(event);
  return { events, final: await output.result() };
}

test("an empty transient failure retries without phantom messages or errors", async () => {
  const notices = [], contexts = [];
  const successful = message({ content: [{ type: "text", text: "Recovered" }] });
  const source = provider((attempt, _model, context, options) => {
    contexts.push(context);
    assert.equal(options.maxRetries, 0, "SDK retries must not multiply the budget");
    return attempt === 1 ? { final: failure(), events: [{ type: "start", partial: message() }] }
      : { final: successful, events: [{ type: "start", partial: successful },
        { type: "text_delta", contentIndex: 0, delta: "Recovered", partial: successful }] };
  });
  const runtime = createModelStream({ stream: source.stream, baseDelayMs: 0, onEvent: e => notices.push(e) });
  const { events, final } = await collect(runtime, { maxRetries: 0 });
  assert.equal(source.calls(), 2);
  assert.equal(contexts[0], contexts[1], "retry the same request, not a new Agent turn");
  assert.deepEqual(events.map(e => e.type), ["start", "text_delta", "done"]);
  assert.equal(final, successful);
  assert.deepEqual(notices.map(e => e.type), ["model_retry_scheduled", "model_retry_start", "model_retry_end"]);
  assert.equal(notices.at(-1).success, true);
  assert.equal(notices[0].usage.totalTokens, 2, "usage on a failed attempt must remain reportable");
});

test("the retry budget is shared across turns and resets for a new question", async () => {
  const notices = [];
  const source = provider(attempt => ({ final: attempt === 3 ? message() : failure() }));
  const runtime = createModelStream({ stream: source.stream, baseDelayMs: 0, onEvent: e => notices.push(e) });
  assert.equal((await collect(runtime)).final.stopReason, "stop");
  assert.equal((await collect(runtime)).final.stopReason, "error");
  assert.equal(source.calls(), 4, "later turns cannot obtain another two retries");
  assert.deepEqual(notices.filter(e => e.type === "model_retry_scheduled").map(e => e.attempt), [1, 2]);
  runtime.reset();
  await collect(runtime);
  assert.equal(source.calls(), 7);
});

for (const error of ["401 Unauthorized", "403 Forbidden", "404 Model not found", "400 Invalid tool schema",
  "429 insufficient_quota", "429 billing limit reached", "503 prompt is too long"]) {
  test(`permanent errors fail immediately: ${error}`, async () => {
    const source = provider(() => ({ final: failure(error) }));
    const runtime = createModelStream({ stream: source.stream, baseDelayMs: 0 });
    assert.equal((await collect(runtime)).final.errorMessage, error);
    assert.equal(source.calls(), 1);
  });
}

for (const [type, content] of [
  ["text_delta", { type: "text", text: "Partial answer" }],
  ["thinking_delta", { type: "thinking", thinking: "Thinking" }],
  ["toolcall_delta", { type: "toolCall", id: "partial", name: "run_shell_command", arguments: {} }],
]) {
  test(`a ${type} followed by a connection failure is never replayed`, async () => {
    const partial = message({ content: [content] });
    const source = provider(() => ({ final: failure("Connection error", { content: [content] }),
      events: [{ type: "start", partial }, { type, contentIndex: 0, delta: "partial", partial }] }));
    const runtime = createModelStream({ stream: source.stream, baseDelayMs: 0 });
    const { events, final } = await collect(runtime);
    assert.equal(final.stopReason, "error");
    assert.equal(source.calls(), 1);
    assert.deepEqual(events.map(e => e.type), ["start", type, "error"]);
  });
}

test("content in a final error blocks retries even without delta events", async () => {
  const source = provider(() => ({ final: failure("Connection error", { content: [{ type: "text", text: "Partial" }] }) }));
  await collect(createModelStream({ stream: source.stream, baseDelayMs: 0 }));
  assert.equal(source.calls(), 1);
});

test("a nonempty start frame blocks retries even when the terminal error drops its content", async () => {
  const source = provider(() => ({ final: failure("Connection error"),
    events: [{ type: "start", partial: message({ content: [{ type: "thinking", thinking: "Partial reasoning" }] }) }] }));
  await collect(createModelStream({ stream: source.stream, baseDelayMs: 0 }));
  assert.equal(source.calls(), 1);
});

test("stopping during backoff cancels promptly without another request", async () => {
  const controller = new AbortController(), notices = [];
  const source = provider(() => ({ final: failure() }));
  const runtime = createModelStream({ stream: source.stream, baseDelayMs: 60_000, onEvent(event) {
    notices.push(event);
    if (event.type === "model_retry_scheduled") queueMicrotask(() => controller.abort());
  } });
  const { final } = await collect(runtime, { signal: controller.signal });
  assert.equal(final.stopReason, "aborted");
  assert.equal(source.calls(), 1);
  assert.equal(notices.at(-1).success, false);
});

test("an aborted provider response is terminal", async () => {
  const source = provider(() => ({ final: failure("Connection error", { stopReason: "aborted" }) }));
  assert.equal((await collect(createModelStream({ stream: source.stream, baseDelayMs: 0 }))).final.stopReason, "aborted");
  assert.equal(source.calls(), 1);
});

test("a pre-aborted request never contacts the provider", async () => {
  const source = provider(() => ({ final: message() }));
  const controller = new AbortController();
  controller.abort();
  assert.equal((await collect(createModelStream({ stream: source.stream }), { signal: controller.signal })).final.stopReason, "aborted");
  assert.equal(source.calls(), 0);
});

test("a changed device session during backoff blocks the retry", async () => {
  let changed = false;
  const source = provider(() => ({ final: failure() }));
  const runtime = createModelStream({ stream: source.stream, baseDelayMs: 0,
    checkSession() { if (changed) throw new Error("Device session changed"); },
    onEvent(event) { if (event.type === "model_retry_scheduled") changed = true; },
  });
  assert.match((await collect(runtime)).final.errorMessage, /Device session changed/);
  assert.equal(source.calls(), 1);
});

test("a synchronous transport failure is normalized and can recover", async () => {
  let calls = 0;
  const runtime = createModelStream({ baseDelayMs: 0, stream() {
    if (++calls === 1) throw new Error("Connection error");
    return provider(() => ({ final: message() })).stream();
  } });
  assert.equal((await collect(runtime)).final.stopReason, "stop");
  assert.equal(calls, 2);
});

test("retrying after a device command never repeats its tool or records failed empty turns", async () => {
  let writes = 0;
  const command = { type: "toolCall", name: "run_shell_command", id: "write", arguments: { command: "uname -a" } };
  const source = provider((attempt, _model, context) => {
    if (attempt === 1) return { final: message({ stopReason: "toolUse", content: [command] }) };
    if (attempt === 2) return { final: failure() };
    assert.equal(writes, 1);
    assert.equal(context.messages.filter(m => m.role === "toolResult").length, 1);
    assert.equal(context.messages.filter(m => m.role === "assistant").length, 1);
    return { final: message({ content: [{ type: "text", text: "Command sent; verification still required." }] }) };
  });
  const agent = createSerialAgent({ config: { endpoint: "https://model.test/v1", model: "test" },
    device: { mode: "auto", getStatus: () => ({ sessionId: 1, connected: true }),
      execute: async () => { writes++; return { id: "execution-1", delivery: "sent" }; } },
    stream: source.stream,
  });
  await agent.prompt("Check the OS");
  assert.equal(writes, 1);
  assert.equal(source.calls(), 3);
  assert.equal(agent.snapshot().filter(m => m.role === "assistant").length, 2);
});
