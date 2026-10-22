import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { createSerialAgent } from "../src/pi-agent.mjs";
import { SerialJournal } from "../../web/serial_journal.js";

/* The gated tools only exist once the target is known to support them, and the
 * read/watch tools must hand back target content as evidence rather than as a
 * claim that the operation succeeded. */
function fakeStream(respond) {
  return (model, context) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const content = respond(context);
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content,
        stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };
}
const config = { endpoint: "https://model.invalid/v1", model: "test-model", apiKey: "test" };
const status = { sessionId: 1, connected: true };
const call = (name, args) => ({ type: "toolCall", id: `call-${name}`, name, arguments: args });
const toolText = (message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

/* `files` is the fake target's filesystem: a read command for a known path
 * makes the target print the same markers the real firmware-side script does,
 * so the parser under test is exercised against realistic output. */
function makeAgent({ stream, journal, files = {}, getStatus = () => status }) {
  const sent = [];
  const toBase64 = (bytes) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const agent = createSerialAgent({
    config, stream, runLimits: { maxTurns: 8, maxTools: 16 },
    device: {
      mode: "auto", getStatus, readLog: (options) => journal.read(options),
      prepareInput: ({ text, appendEnter }) => text + (appendEnter ? "\r" : ""),
      sendInput: async (payload) => { sent.push(payload); return { inputRevision: 1 }; },
      execute: async (args) => {
        sent.push(args.text);
        if (String(args.text).includes("LINKR_FILE")) {
          const path = Object.keys(files).find((candidate) => args.text.includes(candidate));
          if (!path) {
            // The real command prints a leading newline so a marker always starts
            // its own line, even when the echo of the command precedes it.
            journal.append(new TextEncoder().encode("\r\nLINKR_FILE:error denied\r\n"));
          } else {
            const content = new TextEncoder().encode(files[path]);
            const offset = Number((args.text.match(/skip=(\d+)/) || [])[1] || 0);
            // The command clamps through a shell variable, so the requested size
            // is the literal in its guard rather than a "count=" argument.
            const requested = Number((args.text.match(/-gt (\d+) \] && n=/) || [])[1] || 0);
            const page = content.slice(offset, offset + (requested || content.length));
            journal.append(new TextEncoder().encode(
              `\r\nLINKR_FILE:begin total=${content.length} from=${offset}\r\n${toBase64(page)}\r\nLINKR_FILE:end bytes=${page.length}\r\n`));
          }
        }
        return { id: "serial-1", delivery: "sent", console: { kind: "shell" } };
      },
      inspectExecution: () => ({ id: "serial-1", delivery: "sent", executionStatus: "completed", exitCode: 0,
        observation: "prompt-returned", evidence: journal.read({ limit: 4000 }).text }),
      getRecords: () => [],
    },
  });
  return { agent, sent };
}

test("target file and watch tools stay hidden until a probe observes what they need", async () => {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode("root@board:~# "));
  const seen = [];
  let turns = 0;
  const { agent } = makeAgent({ journal, stream: fakeStream((context) => {
    seen.push(getCurrentTools(context.messages).map((tool) => tool.name));
    if (++turns === 1) return [call("probe_tools", { names: ["dd", "base64"] })];
    return [{ type: "text", text: "Probed." }];
  }) });
  assert.equal(seen.length, 0);
  await agent.prompt("Can you read files here?");
  assert.equal(seen[0].includes("read_target_file"), false, "the read tool must not be offered before the probe");
  assert.equal(seen[0].includes("watch_serial_output"), true, "the watch tool needs no target command");
  assert.equal(seen[1].includes("read_target_file"), true, "the probe observed dd and base64");
});

test("reading a target file returns the decoded page and its size", async () => {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode("root@board:~# "));
  let turns = 0;
  const { agent, sent } = makeAgent({ journal, files: { "/etc/os-release": "ID=linkr-bee\nVERSION=1\n" },
    stream: fakeStream((context) => {
    // Review the probe before issuing the dependent file read.
    if (++turns === 1) return [call("probe_tools", { names: ["dd", "base64"] })];
    if (turns === 2) return [call('monitor_serial_execution',{id:'serial-1',timeoutMs:100})];
    if (turns === 3) return [call("read_target_file", { path: "/etc/os-release", bytes: 16 })];
    const evidence = JSON.parse(toolText(context.messages.at(-1)));
    assert.equal(evidence.status, "ok");
    // totalBytes is the file, bytes is this page: that difference is how the
    // assistant knows whether more remains.
    assert.equal(evidence.totalBytes, 23);
    assert.equal(evidence.bytes, 16);
    assert.equal(evidence.encoding, "utf-8");
    assert.equal(evidence.text, "ID=linkr-bee\nVER");
    return [{ type: "text", text: "It is a Linkr build." }];
  }) });
  await agent.prompt("Which OS is this? Read /etc/os-release.");
  // The read goes out as a tracked shell command.
  assert.ok(sent.some((payload) => String(payload).includes("LINKR_FILE:end") || String(payload).includes("dd bs=1")));
  assert.equal(turns, 4);
});

test("an unreadable target file is reported as the target's own answer", async () => {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode("root@board:~# "));
  let turns = 0;
  const { agent } = makeAgent({ journal,
    getStatus: () => status,
    stream: fakeStream((context) => {
      if (++turns === 1) return [call("probe_tools", { names: ["dd", "base64"] })];
      if (turns === 2) return [call('monitor_serial_execution',{id:'serial-1',timeoutMs:100})];
      if (turns === 3) return [call("read_target_file", { path: "/root/secret" })];
      const evidence = JSON.parse(toolText(context.messages.at(-1)));
      assert.equal(evidence.status, "denied");
      assert.ok(evidence.reason && evidence.reason.length > 0, "a refusal must come with the target's reason");
      assert.equal(evidence.text, undefined);
      return [{ type: "text", text: "Not readable." }];
    }) });
  await agent.prompt("Read /root/secret");
  assert.equal(turns, 4);
});
