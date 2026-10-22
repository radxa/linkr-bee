import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createSerialAgent } from "../src/pi-agent.mjs";
import { SerialJournal } from "../../web/serial_journal.js";

/* The verify tools are the one place where the application decides a
 * conclusion. What has to hold at this layer is not the parsing -- the module
 * test runs the real shell for that -- but the contract with the model: the
 * verdict travels as the application's, a mismatch is never laundered into
 * success, an unanswerable claim says so, and an unusable request is an error
 * rather than a quiet pass. */
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

/* `outputs` scripts the fake target: the first entry whose key appears in the
 * command answers it with the given marker text. The key is matched against the
 * command as it is written, and the subject marker is printed through `%s`, so a
 * service key stops at the colon. The command is echoed into the journal first,
 * exactly as a console does, so every test also proves that the echo of a
 * command cannot be mistaken for its output. */
function makeAgent({ stream, journal, outputs = {}, onEvent = undefined, getStatus = () => status }) {
  const sent = [];
  const agent = createSerialAgent({
    config, stream, onEvent, runLimits: { maxTurns: 8, maxTools: 16 },
    device: {
      mode: "auto", getStatus, readLog: (options) => journal.read(options),
      prepareInput: ({ text, appendEnter }) => text + (appendEnter ? "\r" : ""),
      sendInput: async () => ({ inputRevision: 1 }),
      execute: async (args) => {
        sent.push(args.text);
        const answered = Object.entries(outputs).find(([needle]) => String(args.text).includes(needle));
        const body = answered ? `\r\n${answered[1]}` : "";
        journal.append(new TextEncoder().encode(`\r\nroot@board:~# ${args.text}${body}\r\nroot@board:~# `));
        return { id: "verify-1", delivery: "sent", console: { kind: "shell" } };
      },
      inspectExecution: () => ({ id: "verify-1", delivery: "sent", executionStatus: "completed", exitCode: 0,
        observation: "prompt-returned", evidence: journal.read({ limit: 8000 }).text }),
      getRecords: () => [],
    },
  });
  return { agent, sent };
}

const newJournal = () => {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode("root@board:~# "));
  return journal;
};

test("verifying a target file returns the application's verdict, not a claim", async () => {
  const digest = "a".repeat(64);
  let turns = 0;
  const { agent, sent } = makeAgent({
    journal: newJournal(),
    outputs: { "/var/lib/linkr/device-id": `LINKR_VERIFY:path=/var/lib/linkr/device-id\nLINKR_VERIFY:file\nLINKR_VERIFY:bytes=36\nLINKR_VERIFY:sha256=${digest}\nLINKR_VERIFY:done` },
    stream: fakeStream((context) => {
      if (++turns === 1) return [call("verify_target_file", { path: "/var/lib/linkr/device-id", bytes: 36, sha256: digest })];
      const evidence = JSON.parse(toolText(context.messages.at(-1)));
      assert.equal(evidence.source, "application-verification", "the verdict must be attributable to the app");
      assert.equal(evidence.status, "match");
      assert.deepEqual(evidence.checks, { bytes: "match", sha256: "match" });
      assert.equal(evidence.bytes, 36);
      // The markers the verdict rests on travel with it, so the model can cite
      // them without going back to the console.
      assert.ok(evidence.evidence.some((line) => line.includes("LINKR_VERIFY:sha256=")));
      assert.ok(evidence.executionId, "the execution stays addressable for a follow-up check");
      /* A match is a statement about bytes on the target. The payload has to say
       * so, or the model can inflate it into "the goal is achieved". */
      assert.match(evidence.note, /not a model judgement/);
      assert.match(evidence.note, /does not mean the user's wider goal/);
      return [{ type: "text", text: "Verified." }];
    }),
  });
  await agent.prompt("Confirm the target ID file.");
  // The check went out as a tracked shell command, so the approval policy sees it.
  assert.ok(sent.some((payload) => String(payload).includes("LINKR_VERIFY:path=")), "the check is sent through the tracked shell path");
  assert.equal(turns, 2);
});

test("a target file that does not match is never reported as verified", async () => {
  let turns = 0;
  const { agent } = makeAgent({
    journal: newJournal(),
    outputs: { "/tmp/fw.bin": "LINKR_VERIFY:path=/tmp/fw.bin\nLINKR_VERIFY:file\nLINKR_VERIFY:bytes=12\nLINKR_VERIFY:sha256=unavailable\nLINKR_VERIFY:done" },
    stream: fakeStream((context) => {
      if (++turns === 1) return [call("verify_target_file", { path: "/tmp/fw.bin", bytes: 67108864 })];
      const evidence = JSON.parse(toolText(context.messages.at(-1)));
      assert.equal(evidence.status, "mismatch");
      assert.equal(evidence.checks.bytes, "mismatch");
      assert.match(evidence.reason, /holds 12 bytes, not 67108864/);
      return [{ type: "text", text: "The image is truncated." }];
    }),
  });
  await agent.prompt("Did the firmware image land intact?");
  assert.equal(turns, 2);
});

test("a service claim the target cannot answer is indeterminate, with the reason", async () => {
  let turns = 0;
  const { agent } = makeAgent({
    journal: newJournal(),
    outputs: { "LINKR_VERIFY:subject=port:": "LINKR_VERIFY:subject=port:8765\nLINKR_VERIFY:unsupported=no-listener-tool\nLINKR_VERIFY:done" },
    stream: fakeStream((context) => {
      if (++turns === 1) return [call("verify_target_service", { port: 8765 })];
      const evidence = JSON.parse(toolText(context.messages.at(-1)));
      assert.equal(evidence.status, "indeterminate");
      assert.equal(evidence.unsupported, "no-listener-tool");
      assert.match(evidence.reason, /neither ss nor netstat/);
      return [{ type: "text", text: "Cannot tell; nothing to list sockets." }];
    }),
  });
  await agent.prompt("Is the WebDAV port open?");
  assert.equal(turns, 2);
});

test("a service that is not active is reported as a mismatch against what it is", async () => {
  let turns = 0;
  const { agent } = makeAgent({
    journal: newJournal(),
    outputs: { "LINKR_VERIFY:subject=unit:": "LINKR_VERIFY:subject=unit:linkr.service\nLINKR_VERIFY:unit-begin\nLoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nExecMainStatus=3\nLINKR_VERIFY:unit-end\nLINKR_VERIFY:done" },
    stream: fakeStream((context) => {
      if (++turns === 1) return [call("verify_target_service", { unit: "linkr.service" })];
      const evidence = JSON.parse(toolText(context.messages.at(-1)));
      assert.equal(evidence.status, "mismatch");
      assert.match(evidence.reason, /is not active: ActiveState=failed/);
      assert.equal(evidence.observed.active, "failed");
      // The setting that decided the verdict is part of the evidence.
      assert.ok(evidence.evidence.includes("ActiveState=failed"));
      return [{ type: "text", text: "The unit failed." }];
    }),
  });
  await agent.prompt("Is linkr.service up?");
  assert.equal(turns, 2);
});

test("a digest the target was already probed for is refused without a round trip", async () => {
  const entry = (available, stale = false) => ({ available, observedAt: 1, executionId: "probe-1", stale });
  const both = (available, stale = false) => ({ sha256sum: entry(available, stale), shasum: entry(available, stale) });

  const run = async (toolCapabilities, args = { path: "/tmp/fw.bin", sha256: "a".repeat(64) }) => {
    let turns = 0;
    let payload = null;
    const { agent, sent } = makeAgent({
      journal: newJournal(),
      /* The size is reported while the digest is not, which is what a target
       * without a hashing tool actually answers. */
      outputs: { "/tmp/fw.bin": "LINKR_VERIFY:path=/tmp/fw.bin\nLINKR_VERIFY:file\nLINKR_VERIFY:bytes=16\nLINKR_VERIFY:sha256=unavailable\nLINKR_VERIFY:done" },
      getStatus: () => ({ sessionId: 1, connected: true, toolCapabilities }),
      stream: fakeStream((context) => {
        if (++turns === 1) return [call("verify_target_file", args)];
        payload = JSON.parse(toolText(context.messages.at(-1)));
        return [{ type: "text", text: "ok" }];
      }),
    });
    await agent.prompt("Check the image.");
    return { payload, sent };
  };

  /* A completed probe_tools check already established that this target cannot
   * hash anything, so sending the check would spend a UART round trip (up to the
   * monitor window) to be told what the app already knows. */
  const refused = await run(both(false));
  assert.equal(refused.sent.length, 0, "nothing may reach the target");
  assert.equal(refused.payload.status, "indeterminate");
  assert.equal(refused.payload.sha256Unavailable, true);
  assert.match(refused.payload.reason, /No command was sent/);
  assert.ok(refused.payload.probeEvidence.some((item) => item.tool === "sha256sum"), "the observation it rests on travels with it");

  // Only a fresh observation of BOTH tools counts for that.
  assert.equal((await run(both(false, true))).sent.length, 1, "a stale observation proves nothing");
  assert.equal((await run({ sha256sum: entry(true), shasum: entry(false) })).sent.length, 1, "one available tool is enough to try");
  assert.equal((await run(undefined)).sent.length, 1, "no probe at all leaves the question open");

  // An expected byte count is still checkable, so the check is worth sending even
  // when the digest cannot be: the app reports the digest as unverifiable.
  const sized = await run(both(false), { path: "/tmp/fw.bin", sha256: "a".repeat(64), bytes: 16 });
  assert.equal(sized.sent.length, 1);
  assert.equal(sized.payload.status, "indeterminate");
  assert.equal(sized.payload.checks.bytes, "match", "the check that could run still reports its own result");
});

test("a verify result says whether the monitor window expired", async () => {
  let turns = 0;
  const { agent } = makeAgent({
    journal: newJournal(),
    outputs: { "/f": "LINKR_VERIFY:path=/f\nLINKR_VERIFY:file\nLINKR_VERIFY:bytes=3\nLINKR_VERIFY:done" },
    stream: fakeStream((context) => {
      if (++turns === 1) return [call("verify_target_file", { path: "/f", bytes: 3 })];
      const evidence = JSON.parse(toolText(context.messages.at(-1)));
      assert.equal(evidence.timedOut, false, "a settled execution must say so explicitly");
      return [{ type: "text", text: "ok" }];
    }),
  });
  await agent.prompt("Check the file.");
  assert.equal(turns, 2);
});

test("an unusable verify request is an error rather than a quiet pass", async () => {
  const errors = [];
  let turns = 0;
  const { agent } = makeAgent({
    journal: newJournal(),
    onEvent: (event) => { if (event.type === "tool_execution_end" && event.isError) errors.push(event.result); },
    stream: fakeStream(() => {
      // Two claims in one call cannot be verified as one verdict.
      if (++turns === 1) return [call("verify_target_service", { unit: "linkr.service", port: 8765 })];
      return [{ type: "text", text: "Asked for one thing." }];
    }),
  });
  await agent.prompt("Check the service and the port.");
  assert.equal(errors.length, 1, "a request that cannot be honoured must fail loudly");
  assert.match(JSON.stringify(errors[0]), /exactly one of unit, process or port/);
});

test('multiple read-only comparisons remain valid when the plan is updated after both results',async()=>{
  let round=0,first,lastPath='',execution=0;
  const agent=createSerialAgent({config,device:{mode:'auto',getStatus:()=>status,getRecords:()=>[],
    execute:async args=>{
      assert.equal(args.applicationReadOnly,true);
      lastPath=args.text.includes('/tmp/first')?'/tmp/first':'/tmp/second';
      return {id:`verify-${++execution}`,delivery:'sent'};
    },
    inspectExecution:id=>({id,delivery:'sent',executionStatus:'completed',exitCode:0,
      evidence:`\nLINKR_VERIFY:path=${lastPath}\nLINKR_VERIFY:file\nLINKR_VERIFY:bytes=3\nLINKR_VERIFY:done\n`}),
  },stream:fakeStream(context=>{
    if(++round===1)return [call('verify_target_file',{path:'/tmp/first',bytes:3})];
    if(round===2){first=JSON.parse(toolText(context.messages.at(-1)));return [call('verify_target_file',{path:'/tmp/second',bytes:3})];}
    if(round===3){
      const second=JSON.parse(toolText(context.messages.at(-1)));
      return [call('update_task_plan',{steps:[first,second].map((proof,index)=>({title:`Check file ${index+1}`,
        kind:'action',status:'completed',expectedResult:'File has 3 bytes',verification:'Application comparison matched',
        evidenceIds:[proof.taskEvidence.id],nextAction:''}))})];
    }
    assert.deepEqual(JSON.parse(toolText(context.messages.at(-1))).steps.map(step=>step.completion),['verified','verified']);
    return [{type:'text',text:'Both comparisons matched.'}];
  })});
  await agent.prompt('Verify both files');assert.equal(round,4);
});
