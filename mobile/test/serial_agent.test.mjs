import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createSerialAgent, validateAgentConfig } from "../src/pi-agent.mjs";
import { toolContextChars } from "../src/agent-context.mjs";
import { AGENT_FIXED_CONTEXT_TOKENS } from "../../web/agent_config.js";
import { SerialJournal } from "../../web/serial_journal.js";
import { createDeviceExecutor } from "../../web/device_executor.js";

test("serial journal preserves split UTF-8 and strips terminal controls", () => {
  const journal = new SerialJournal();
  const bytes = new TextEncoder().encode("\x1b[31m启动失败\x1b[0m\r\n");
  journal.append(bytes.slice(0, 7));
  journal.append(bytes.slice(7));
  assert.equal(journal.read().text, "启动失败\r\n");
  assert.equal(journal.read({ after: journal.read().cursor }).text, "");
});

test("serial journal caps retained data and reports missing history", () => {
  const journal = new SerialJournal(8);
  journal.append(new TextEncoder().encode("0123456789"));
  assert.deepEqual(Object.fromEntries(Object.entries(journal.read({ after: 0, limit: 3 })).filter(([key]) => key !== "updatedAt")),
    { text: "234", start: 2, cursor: 5, latestCursor: 10, truncated: true });
  journal.reset();
  assert.equal(journal.read().text, "");
  assert.equal(journal.read().latestCursor, 0);
});

test("model endpoint rejects embedded credentials and ambiguous URLs", () => {
  for (const endpoint of ["file:///tmp/model", "https://secret@host/v1", "https://host/v1?key=x", "https://host/v1#fragment"]) {
    assert.throws(() => validateAgentConfig({ endpoint, model: "model" }));
  }
  assert.equal(validateAgentConfig({ endpoint: "https://host/v1/", model: " model " }).endpoint, "https://host/v1");
});

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
const call = (name, args) => ({ type: "toolCall", id: `call-${Math.random()}`, name, arguments: args });

test("Pi exposes web evidence to the next model turn without serial writes", async () => {
  let turns = 0;
  const agent = makeAgent({ config, getStatus: () => status,
    sendInput: () => assert.fail("web reading must not write UART"),
    webReader: async ({ url }) => ({ url, text: "Board documentation", untrusted: true }),
    stream: fakeStream(context => {
      if (++turns === 1) return [call("read_web_page", { url: "https://docs.example.org" })];
      assert.match(context.messages.at(-1).content[0].text, /Board documentation/);
      return [{ type: "text", text: "Found the documentation." }];
    }),
  });
  await agent.prompt("Read the board documentation");
  assert.equal(turns, 2);
});

// Exercise the Pi adapter separately from the SDK-independent device executor.
function makeAgent({ getStatus, readLog, sendInput, ...options }) {
  return createSerialAgent({ runLimits: { maxTurns: 8, maxTools: 16 }, ...options, device: {
    mode: "auto", getStatus, readLog, execute: sendInput,
    inspectExecution: () => ({ executionStatus: "unknown" }),
  } });
}

test("real Pi loop reads target logs and supplies them to the next model turn", async () => {
  let turns = 0;
  const agent = makeAgent({ config, getStatus: () => status,
    readLog: () => ({ text: "Kernel panic: unable to mount root", cursor: 40 }),
    sendInput: () => assert.fail("read-only diagnosis must not write"),
    stream: fakeStream((context) => {
      if (++turns === 1) return [call("read_serial_log", {})];
      assert.match(context.messages.at(-1).content[0].text, /Kernel panic/);
      return [{ type: "text", text: "Root filesystem could not mount." }];
    }),
  });
  await agent.prompt("Why did boot fail?");
  assert.equal(turns, 2);
});

test("Pi validates tool arguments before any serial write", async () => {
  let turns = 0;
  const events = [];
  const agent = makeAgent({ config, getStatus: () => status, readLog: () => ({}),
    sendInput: () => assert.fail("invalid arguments must not reach transport"),
    onEvent: (event) => events.push(event),
    stream: fakeStream(() => ++turns === 1
      ? [call("send_serial_input", { text: "uname", appendEnter: "yes" })]
      : [{ type: "text", text: "Invalid tool request." }]),
  });
  await agent.prompt("Inspect target");
  assert(events.some((event) => event.type === "tool_execution_end" && event.isError));
});

test("automatic diagnosis has a bounded number of model turns", async () => {
  let reads = 0;
  const agent = makeAgent({ config, getStatus: () => status,
    readLog: () => { reads++; return { text: "waiting" }; }, sendInput: async () => {},
    stream: fakeStream(() => [call("read_serial_log", {})]),
  });
  assert.equal((await agent.prompt("Inspect target")).limitReached, true);
  assert.equal(reads, 8);
});

test("exhausting the tool budget reports an interrupted run and resets for the next question", async () => {
  let reads = 0, turns = 0;
  const agent = makeAgent({ config, getStatus: () => status,
    readLog: () => { reads++; return { text: "waiting" }; },
    stream: fakeStream(() => {
      turns++;
      return Array.from({ length: 4 }, () => call("read_serial_log", {}));
    }),
  });
  assert.equal((await agent.prompt("Inspect target")).limitReached, true);
  assert.equal(reads, 16);
  assert.equal(turns, 5);
  assert.equal((await agent.prompt("Continue inspecting")).limitReached, true);
  assert.equal(reads, 32);
});

test("a final answer on the last allowed model turn is a completed diagnosis", async () => {
  let turns = 0;
  const agent = makeAgent({ config, getStatus: () => status, readLog: () => ({ text: "evidence" }),
    stream: fakeStream(() => ++turns < 8 ? [call("read_serial_log", {})]
      : [{ type: "text", text: "Diagnosis complete." }]),
  });
  assert.equal((await agent.prompt("Inspect target")).limitReached, false);
  assert.equal(turns, 8);
});

test("a mixed tool batch stops at the execution budget before another model request", async () => {
  let reads = 0, turns = 0;
  const agent = makeAgent({ config, getStatus: () => status,
    readLog: () => { reads++; return { text: "evidence" }; },
    stream: fakeStream(() => { turns++; return Array.from({ length: 20 }, () => call("read_serial_log", {})); }),
  });
  assert.equal((await agent.prompt("Inspect target")).limitReached, true);
  assert.equal(reads, 16);
  assert.equal(turns, 1);
});

test("a changed connection cannot reuse a previous device's agent context", async () => {
  let sessionId = 1;
  const agent = makeAgent({ config, getStatus: () => ({ sessionId }), readLog: () => ({}),
    sendInput: () => assert.fail("must not send to a new target"),
    stream: fakeStream(() => { sessionId = 2; return [call("send_serial_input", { text: "uname", appendEnter: true })]; }),
  });
  // A changed target fails before another model request can use stale context.
  await assert.rejects(agent.prompt("Inspect target"), /session or mode changed/);
  await assert.rejects(agent.prompt("continue"), /session or mode changed/);
});

test("real Pi loop processes two large incremental log reads without context overflow", async () => {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode("EARLY_FAILURE" + "x".repeat(11987) + "y".repeat(11987) + "LATEST_RESULT"));
  let turns = 0;
  const agent = makeAgent({ config, getStatus: () => status, readLog: (options) => journal.read(options),
    sendInput: () => assert.fail("read-only"),
    stream: fakeStream((context) => {
      /* pi-agent-core 0.87 folds the tool declarations (with parameter schemas)
       * into the transcript's leading system message, so the whole-request JSON
       * includes the fixed cost on top of the history the budget governs. */
      const history = context.messages.filter((message) => message.role !== "system");
      assert(JSON.stringify(history).length <= 24000);
      if (++turns === 1) return [call("read_serial_log", { after: 0, limit: 12000 })];
      if (turns === 2) return [call("read_serial_log", { limit: 12000 })];
      const value = JSON.parse(context.messages.at(-1).content[0].text);
      assert.equal(value.start, 12000);
      assert.equal(value.cursor, 24000);
      assert(value.text.endsWith("LATEST_RESULT"));
      assert(JSON.stringify(context.messages).includes("EARLY_FAILURE"));
      return [{ type: "text", text: "Diagnosis complete." }];
    }),
  });
  await agent.prompt("Read this long log");
  assert.equal(turns, 3);
});

test("omitted log cursors read only new data, while recent explicitly rereads the tail", async () => {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode("A"));
  let turns = 0;
  const agent = makeAgent({ config, getStatus: () => status, readLog: (options) => journal.read(options),
    stream: fakeStream((context) => {
      if (++turns === 1) return [call("read_serial_log", {})];
      const value = JSON.parse(context.messages.at(-1).content[0].text);
      assert.equal(value.text, turns === 2 ? "A" : turns === 3 ? "B" : "AB");
      if (turns === 2) { journal.append(new TextEncoder().encode("B")); return [call("read_serial_log", {})]; }
      if (turns === 3) return [call("read_serial_log", { recent: true })];
      return [{ type: "text", text: "Done" }];
    }),
  });
  await agent.prompt("Watch new output");
});

test("default log reads continue from an explicit historical page after reading the tail", async () => {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode("ABCDEFGHIJ"));
  const pages = [];
  const requests = [{ limit: 2 }, { after: 0, limit: 2 }, { limit: 2 }];
  let turns = 0;
  const agent = makeAgent({ config, getStatus: () => status, readLog: (options) => journal.read(options),
    stream: fakeStream((context) => {
      if (turns > 0) pages.push(JSON.parse(context.messages.at(-1).content[0].text));
      if (turns < requests.length) return [call("read_serial_log", requests[turns++])];
      return [{ type: "text", text: "Historical paging continued without skipping output." }];
    }),
  });
  await agent.prompt("Read the tail, then page through the earlier output");
  assert.deepEqual(pages.map(({ text, start, cursor, hasMore }) => ({ text, start, cursor, hasMore })), [
    { text: "IJ", start: 8, cursor: 10, hasMore: false },
    { text: "AB", start: 0, cursor: 2, hasMore: true },
    { text: "CD", start: 2, cursor: 4, hasMore: true },
  ]);
});

test("default log reads continue from the last page returned by waiting for output", async () => {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode("A".repeat(12000) + "NEXT_PAGE" + "Z".repeat(1000)));
  const pages = [];
  let turns = 0;
  const agent = makeAgent({ config, getStatus: () => status, readLog: (options) => journal.read(options),
    stream: fakeStream((context) => {
      if (++turns === 1) return [call("read_serial_log", { limit: 2 })];
      pages.push(JSON.parse(context.messages.at(-1).content[0].text));
      if (turns === 2) return [call("wait_for_serial_output", { after: 0, timeoutMs: 100, settleMs: 100 })];
      if (turns === 3) return [call("read_serial_log", { limit: 9 })];
      return [{ type: "text", text: "Continued from the observed page." }];
    }),
  });
  await agent.prompt("Read the tail, then observe and page through earlier output");
  assert.equal(pages[0].text, "ZZ");
  assert.equal(pages[1].cursor, 12000);
  assert.equal(pages[1].hasMore, true);
  assert.equal(pages[2].text, "NEXT_PAGE");
  assert.equal(pages[2].start, 12000);
});

function executableDevice({ onRecord, output = "DONE\r\nroot@board:~# " } = {}) {
  const journal = new SerialJournal();
  const sent = [];
  let inputRevision = 0;
  const device = createDeviceExecutor({ getStatus: () => ({ ...status, inputRevision, inputPending: false }),
    readLog: (options) => journal.read(options), prepareInput: ({ text, appendEnter }) => text + (appendEnter ? "\r" : ""),
    sendInput: async (payload) => { sent.push(payload); journal.append(new TextEncoder().encode(output)); return { inputRevision: ++inputRevision }; }, onRecord });
  return { device, sent };
}

test("Full Auto must receive inspection results in a later model turn before another send", async () => {
  const { device, sent } = executableDevice();
  device.setMode("full-auto");
  let turns = 0;
  const errors = [];
  const send = () => call("send_serial_input", { text: "pwd", appendEnter: true });
  const agent = createSerialAgent({ config, device, onEvent: (event) => {
    if (event.type === "tool_execution_end" && event.isError) errors.push(event.result);
  }, stream: fakeStream((context) => {
    if (++turns === 1) return [send(), send()];
    if (turns === 2) { assert.equal(sent.length, 1); return [call("inspect_serial_execution", { id: "serial-1" }), send()]; }
    if (turns === 3) {
      assert.equal(sent.length, 1);
      const inspected = context.messages.filter((m) => m.role === "toolResult" && m.toolName === "inspect_serial_execution").at(-1);
      assert.equal(JSON.parse(inspected.content[0].text).waitStatus, "settled");
      return [send()];
    }
    return [{ type: "text", text: "Verified first step; second input sent." }];
  }) });
  await agent.prompt("Inspect the device");
  assert.equal(sent.length, 2);
  assert.equal(errors.length, 2);
});

test("changing mode retains prior dialogue and closes interrupted tool batches without replay", async () => {
  let agent, cancelNext = false, turns = 0;
  const { device, sent } = executableDevice({ onRecord: (record) => {
    if (cancelNext && record.state === "awaiting-approval") {
      cancelNext = false;
      queueMicrotask(() => { agent.abort(); device.setMode("full-auto"); });
    }
  } });
  agent = createSerialAgent({ config, device, stream: fakeStream((context) => {
    if (++turns === 1) return [{ type: "text", text: "Remember: this board has a mount failure." }];
    if (turns === 2) return [call("send_serial_input", { text: "reboot", appendEnter: true }), call("send_serial_input", { text: "pwd", appendEnter: true })];
    assert(getCurrentSystemPrompt(context.messages).includes("Execution mode: Full Auto"));
    assert(JSON.stringify(context.messages).includes("mount failure"));
    const requests = context.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((c) => c.type === "toolCall").map((c) => c.id) : []);
    const results = context.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
    assert.deepEqual(new Set(requests), new Set(results));
    assert(JSON.stringify(context.messages).includes("interrupted"));
    return [{ type: "text", text: "Continue diagnosing the mount failure." }];
  }) });
  await agent.prompt("Diagnose this board");
  cancelNext = true;
  await agent.prompt("Propose a restart").catch(() => {});
  assert.equal(sent.length, 0);
  await agent.prompt("Continue analysis only");
  assert.equal(sent.length, 0);
});

test("input delivered just before abort still needs inspection when the dialogue resumes", async () => {
  let agent, turns = 0, interrupted = false;
  const { device, sent } = executableDevice({ onRecord: (record) => {
    if (!interrupted && record.state === "sending") {
      interrupted = true;
      queueMicrotask(() => agent.abort());
    }
  } });
  device.setMode("full-auto");
  agent = createSerialAgent({ config, device, stream: fakeStream((context) => {
    if (++turns <= 2) return [call("send_serial_input", { text: "pwd", appendEnter: true })];
    assert.equal(sent.length, 1);
    assert.match(context.messages.at(-1).content[0].text, /Inspect execution serial-1/);
    return [{ type: "text", text: "The interrupted send must be inspected first." }];
  }) });
  await agent.prompt("Inspect the board").catch(() => {});
  assert.equal(device.getRecords()[0].delivery, "sent");
  await agent.prompt("Continue");
  assert.equal(sent.length, 1);
});

test("tracked commands share uncertain-send protection with serial input", async () => {
  let round = 0;
  let sends = 0;
  let record;
  const agent = createSerialAgent({ config, device: {
    mode: 'full-auto', getStatus: () => status,
    getRecords: () => record ? [record] : [],
    execute: async () => { sends++; record = {id:'tracked-1',delivery:'unknown'}; throw new Error('delivery uncertain'); },
  }, stream: fakeStream(() => {
    round++;
    if (round <= 2) return [call('run_shell_command', {command:'echo test'})];
    return [{type:'text',text:'Delivery unresolved; do not repeat.'}];
  }) });
  await agent.prompt('Run a shell command');
  assert.equal(sends, 1);
});

test('recovery blocks writes until fresh status and logs are reviewed in a later model round', async () => {
  let turns=0, sends=0;
  const agent=makeAgent({config,getStatus:()=>status,readLog:()=>({text:'root@board:~# ',cursor:20,latestCursor:20}),
    sendInput:async()=>{sends++;return {id:'new-command',delivery:'sent'};},
    stream:fakeStream(context=>{
      turns++;
      if(turns===1) return [call('run_shell_command',{command:'uname -a'})];
      if(turns===2) {assert.match(context.messages.at(-1).content[0].text,/Recovered history/);return [call('get_device_status',{}),call('read_serial_log',{}),call('run_shell_command',{command:'uname -a'})];}
      if(turns===3) {assert.equal(sends,0);return [call('run_shell_command',{command:'uname -a'})];}
      return [{type:'text',text:'Observed current target'}];
    })});
  await agent.prompt('Verify previous task',{recovery:{goal:'old task',summary:'delivery unknown'}});
  assert.equal(sends,1);
});

test('target tool check probes only requested safe command names', async()=>{
 const sent=[];
 let turns=0;
 const agent=makeAgent({config,getStatus:()=>status,sendInput:async args=>{sent.push(args);return {id:'probe',delivery:'sent',executionStatus:'completed',exitCode:0};},
 stream:fakeStream(()=> ++turns===1 ? [call('probe_tools',{names:['curl','sha256sum']})] : [{type:'text',text:'Checked tools.'}])});
 await agent.prompt('Check curl and sha256sum');
 assert.equal(sent.length,1);
 assert.match(sent[0].text,/for t in 'curl' 'sha256sum'/);
 assert.doesNotMatch(sent[0].text,/uname|df |os-release/);
 assert.equal(sent[0].trackExit,true);
 assert.deepEqual(sent[0].toolProbe,['curl','sha256sum']);
});

test('task plans reject unsupported completion and preserve blocked recovery details', async () => {
 let turns=0;
 const agent=makeAgent({config,getStatus:()=>status,sendInput:()=>assert.fail('plans must not write UART'),
 stream:fakeStream(context=>{
  if(++turns===1)return [call('update_task_plan',{steps:[{title:'Repair',status:'completed',verification:'',nextAction:''}]})];
  if(turns===2){
   assert.match(context.messages.at(-1).content[0].text,/verification for completed/);
   return [call('update_task_plan',{steps:[{title:'Check service',status:'blocked',verification:'No service health output',nextAction:'Read service status after reconnect'}]})];
  }
  const plan=JSON.parse(context.messages.at(-1).content[0].text);
  assert.equal(plan.verifiedByApplication,false);
  assert.equal(plan.steps[0].status,'blocked');
  return [{type:'text',text:'Blocked; inspect service state after reconnect.'}];
 })});
 await agent.prompt('Plan repair');assert.equal(turns,3);
});

test('log search finds literal evidence without consuming the incremental cursor or writing UART', async () => {
 let turns=0;const queries=[];
 const agent=makeAgent({config,getStatus:()=>status,sendInput:()=>assert.fail('read only'),
 readLog:args=>{queries.push(args);return {text:'Boot\nERROR [disk] failed\n',start:10,cursor:40,latestCursor:90,truncated:true};},
 stream:fakeStream(context=>{
  if(++turns===1)return [call('search_serial_log',{query:'error [disk]',after:10})];
  if(turns===2){const result=JSON.parse(context.messages.at(-1).content[0].text);
   assert.equal(result.matches.length,1);assert.match(result.matches[0].excerpt,/failed/);
   assert.equal(result.truncated,true);assert.equal(result.hasMore,true);
   return [call('read_serial_log',{})];
  }
  return [{type:'text',text:'Disk failure observed; earlier logs are missing.'}];
 })});
 await agent.prompt('Find disk failure');
 assert.equal(queries[0].after,10);assert.equal(queries[1].after,undefined);
});

test('Pi consumes steering before follow-ups and reports pending messages', async () => {
 let turns=0;const consumed=[],queue=[];
 const agent=makeAgent({config,getStatus:()=>status,sendInput:()=>assert.fail('no serial action'),
 onEvent:e=>{if(e.type==='queued_input_consumed')consumed.push(e.item.text);if(e.type==='input_queue_changed')queue.push(e.items);},
 stream:fakeStream(context=>{
  turns++;
  if(turns===1){agent.enqueue('Do later','followUp');agent.enqueue('Clarification','steer');}
  else assert.equal(context.messages.at(-1).content,turns===2?'Clarification':'Do later');
  return [{type:'text',text:'Handled.'}];
 })});
 await agent.prompt('Initial task');
 assert.equal(turns,3);assert.deepEqual(consumed,['Clarification','Do later']);assert.deepEqual(queue.at(-1),[]);
 assert.throws(()=>agent.enqueue('too late'),/No active task/);
});

test('queued messages are bounded and cleared before the next prompt', async () => {
 let turns=0;
 const agent=makeAgent({config,getStatus:()=>status,sendInput:()=>assert.fail('no serial action'),
 stream:fakeStream(context=>{
  if(++turns===1){
   for(let i=0;i<8;i++)agent.enqueue('Queued '+i,'followUp');
   assert.throws(()=>agent.enqueue('overflow'),/Queue is full/);
   agent.clearQueue();
  }else assert.equal(context.messages.at(-1).content[0].text,'New task');
  return [{type:'text',text:'Done'}];
 })});
 await agent.prompt('Initial');await agent.prompt('New task');assert.equal(turns,2);
});

test('turn limit clears unconsumed follow-ups', async () => {
 let turns=0;const consumed=[];
 const agent=makeAgent({config,getStatus:()=>status,runLimits:{maxTurns:1,maxTools:10},
 onEvent:e=>{if(e.type==='queued_input_consumed')consumed.push(e.item);},
 stream:fakeStream(()=>{if(++turns===1)agent.enqueue('Must not run','followUp');return [{type:'text',text:'Done'}];})});
 assert.equal((await agent.prompt('Initial')).limitReached,true);
 await agent.prompt('Next');assert.equal(turns,2);assert.deepEqual(consumed,[]);
});

test('abort clears queued instructions and never replays them on a later prompt',async()=>{
 let turns=0;const consumed=[];
 const agent=makeAgent({config,getStatus:()=>status,onEvent:e=>{if(e.type==='queued_input_consumed')consumed.push(e.item);},
 stream:fakeStream(()=>{if(++turns===1){agent.enqueue('Old follow-up','followUp');agent.abort();}
 return [{type:'text',text:'Stopped'}];})});
 await agent.prompt('First').catch(()=>{});
 await agent.prompt('Fresh request');assert.equal(turns,2);assert.deepEqual(consumed,[]);
});

test("configured extra headers reach the provider request", async () => {
  let seen;
  const agent = makeAgent({ config: { ...config, headers: { "anthropic-dangerous-direct-browser-access": "true" } },
    getStatus: () => status, readLog: () => ({ text: "", cursor: 0 }),
    sendInput: () => assert.fail("read-only turn must not write"),
    stream: (model, context, options) => {
      seen = options.headers;
      return fakeStream(() => [{ type: "text", text: "ok" }])(model, context);
    } });
  await agent.prompt("hello");
  assert.deepEqual(seen, { "anthropic-dangerous-direct-browser-access": "true" });
});

/* The history budget has to be what is LEFT of the configured window, because
 * the prompt and every tool description are paid first. It used to be a constant
 * that ignored the setting, so a small window sent a request far larger than it
 * and the failure appeared at the provider with nothing pointing at the field. */
test("a small configured context window shrinks the history that is sent", async () => {
  /* A restored conversation looks like this: alternating turns from both roles,
   * because compaction builds its summary from an assistant message. */
  const restoredMessages = Array.from({ length: 12 }, (_, index) => ([
    { role: "user", content: [{ type: "text", text: `question-${index}:` + "x".repeat(3000) }], timestamp: 1 },
    { role: "assistant", api: "openai-completions", provider: "test", model: "test", stopReason: "stop",
      content: [{ type: "text", text: `answer-${index}:` + "y".repeat(3000) }], timestamp: 1 },
  ])).flat();
  const sent = [];
  const openAgent = (contextWindow) => makeAgent({
    config: { ...config, contextWindow }, getStatus: () => status,
    readLog: () => ({ text: "", cursor: 0 }),
    sendInput: () => assert.fail("read-only turn must not write"),
    restoredMessages,
    stream: fakeStream((context) => {
      sent.push(JSON.stringify(context.messages).length);
      return [{ type: "text", text: "ok" }];
    }),
  });

  await openAgent(32768).prompt("Continue");
  await openAgent(8192).prompt("Continue");
  assert.ok(sent[0] > sent[1], `the smaller window must carry less history (${sent[0]} vs ${sent[1]} characters)`);
});

test("tool parameter schemas leave less history in a constrained window", async () => {
  const restoredMessages = Array.from({ length: 20 }, (_, index) => ([
    { role: "user", content: `question-${index}:` + "x".repeat(600), timestamp: 1 },
    { role: "assistant", api: "openai-completions", provider: "test", model: "test", stopReason: "stop",
      content: [{ type: "text", text: `answer-${index}:` + "y".repeat(1600) }], timestamp: 1 },
  ])).flat();
  const agent = makeAgent({ config: { ...config, contextWindow: 16000, maxTokens: 512 },
    accessory: {}, notes: {}, restoredMessages, getStatus: () => status,
    stream: fakeStream(context => {
      // Prompt + optional tool schemas consume about 9600 estimated tokens;
      // after output/framing reserve, fewer than 12000 history chars fit. The
      // old description-only estimate sent considerably more than that.
      const history = JSON.stringify(context.messages.filter(m => m.role !== "system"));
      assert.ok(history.length < 12000, `${history.length} history characters left no room for schemas`);
      assert.ok(history.includes("CURRENT_GOAL"));
      return [{ type: "text", text: "ok" }];
    }),
  });
  await agent.prompt("CURRENT_GOAL");
});

/* pi-agent-core 0.87 replays system messages: every message's text merges into
 * the prompt and the tool declarations replay in order. A restored snapshot
 * carries its own baseline system message, so without deduplication each
 * request would send the prompt twice — including a stale copy that never
 * refreshes (two conflicting "Execution mode" lines at once). Legacy snapshots
 * saved before the upgrade hold no system message at all and must still gain
 * exactly one baseline with the tool declarations. */
test("a restored conversation carries exactly one baseline system prompt", async () => {
  const device = (mode) => ({ mode, getStatus: () => status, readLog: () => ({ text: "", cursor: 0 }),
    execute: () => assert.fail("read-only turn must not write"), inspectExecution: () => ({ executionStatus: "unknown" }) });
  let snapshot;
  let expectedTools = 0;
  {
    const agent = createSerialAgent({ config, device: device("auto"),
      stream: fakeStream((context) => {
        expectedTools = getCurrentTools(context.messages).length;
        return [{ type: "text", text: "ok" }];
      }) });
    await agent.prompt("q1");
    snapshot = agent.snapshot();
    assert.ok(snapshot.some((message) => message.role === "system"), "a new-format snapshot carries its baseline");
  }
  for (const [label, restoredMessages] of [
    ["new-format", snapshot],
    ["legacy", snapshot.filter((message) => message.role !== "system")],
  ]) {
    const seen = [];
    const agent = createSerialAgent({ config, device: device("manual"), restoredMessages,
      stream: fakeStream((context) => {
        seen.push(context.messages);
        return [{ type: "text", text: "ok" }];
      }) });
    await agent.prompt("q2");
    await agent.prompt("q3");
    for (const messages of seen) {
      const system = messages.filter((message) => message.role === "system");
      const baselines = system.filter((message) => message.content);
      assert.equal(baselines.length, 1, `${label} restore must carry exactly one prompt per request`);
      const prompt = system.map((message) => String(message.content)).join("\n");
      assert.equal((prompt.match(/Execution mode: /g) || []).length, 1,
        `${label} restore must not leak a stale prompt copy`);
      assert.match(prompt, /Execution mode: Manual/);
      assert.ok(!prompt.includes("Execution mode: Auto"), `${label} restore kept the stale snapshot prompt`);
      assert.equal(getCurrentTools(messages).length, expectedTools,
        `${label} restore must replay the runner's tool baseline`);
    }
  }
});

/* AGENT_FIXED_CONTEXT_TOKENS tells a user how much of their window the assistant
 * spends before any conversation, and the settings form warns from it. That
 * number is only honest while it still describes the real prompt and tools, so
 * this re-measures them at the same pessimistic ratio the runtime budgets with
 * and fails when a new tool description pushes the truth past the constant. */
test("the fixed-context estimate covers parameter schemas and optional tools", async () => {
  let fixedChars = 0;
  const agent = makeAgent({ config, accessory: {}, notes: {}, getStatus: () => status, readLog: () => ({ text: "", cursor: 0 }),
    sendInput: () => assert.fail("read-only turn must not write"),
    stream: fakeStream((context) => {
      const tools = getCurrentTools(context.messages);
      assert.ok(tools.some(tool => tool.name === "remember_target_note"));
      assert.ok(tools.some(tool => tool.name === "set_uart_config"));
      fixedChars = getCurrentSystemPrompt(context.messages).length + toolContextChars(tools);
      return [{ type: "text", text: "ok" }];
    }) });
  await agent.prompt("hello");
  const measured = Math.ceil(fixedChars / 3);
  assert.ok(measured <= AGENT_FIXED_CONTEXT_TOKENS,
    `the assistant now costs about ${measured} tokens before any history, past AGENT_FIXED_CONTEXT_TOKENS=${AGENT_FIXED_CONTEXT_TOKENS}; raise the constant and re-check the settings warning`);
});
