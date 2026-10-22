import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createSerialAgent } from "../src/pi-agent.mjs";
import { createDeviceExecutor } from "../../web/device_executor.js";
import { SerialJournal } from "../../web/serial_journal.js";
import {executionReference, inputFingerprint} from '../../web/agent_task_state.js';

const tool = (name, args = {}) => ({ type: "toolCall", id: crypto.randomUUID(), name, arguments: args });
const write = () => tool("send_serial_input", { text: "touch /tmp/recovery-example", appendEnter: true });
const done = () => [{ type: "text", text: "Mock response complete." }];
const blocked = context => context.messages.some(message => message.role === "toolResult" &&
  message.isError && JSON.stringify(message.content).includes("Recovered history is unverified"));

function fixture(source, respond) {
  const journal = new SerialJournal();
  journal.append(new TextEncoder().encode("root@board:~# "));
  let revision = 0, round = 0;
  const sent = [];
  const device = createDeviceExecutor({
    getStatus: () => ({ connected: true, transport:'ble', deviceId:'bee-a', uart:'115200', sessionId: 1, inputRevision: revision, inputPending: false }),
    readLog: options => journal.read(options),
    prepareInput: ({ text, appendEnter }) => text + (appendEnter ? "\r" : ""),
    sendInput: async text => { sent.push(text); return { inputRevision: ++revision }; },
  });
  device.setMode("full-auto");
  const agent = createSerialAgent({
    config: { endpoint: "https://agent.test/v1", model: "test-model", apiKey: "test-key" },
    device,
    restoredMessages: source === "chat" ? [{ role: "user", content: "Repair the service.", timestamp: 1 }] : null,
    stream: (model, context) => {
      const content = respond(++round, context, sent);
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content, stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
  const recovery = source === "task" ? { goal: "Repair the service", historical: true } : null;
  return { agent, device, sent, recovery, journal };
}

for (const source of ["chat", "task"]) {
  test(`${source} recovery blocks writes and keeps the gate across questions`, async () => {
    const f = fixture(source, (round, context) => {
      if (round % 2 === 1) return [write()];
      assert.equal(blocked(context), true);
      return done();
    });
    try {
      await f.agent.prompt("Continue the repair.", { recovery: f.recovery });
      assert.deepEqual(f.sent, []);
      // A second question must not silently clear an unfinished recovery.
      await f.agent.prompt("Continue.");
      assert.deepEqual(f.sent, []);
    } finally { f.device.setMode("auto"); }
  });

  test(`${source} recovery releases writes only after both reads reach the model`, async () => {
    const f = fixture(source, (round, context, sent) => {
      if (round === 1) return [tool("get_device_status")];
      if (round === 2) return [write()];
      if (round === 3) {
        assert.equal(blocked(context), true);
        assert.deepEqual(sent, []);
        // Even the second read cannot authorize a write in its own batch.
        return [tool("read_serial_log"), write()];
      }
      if (round === 4) {
        assert.deepEqual(sent, []);
        const results = context.messages.filter(message => message.role === "toolResult");
        assert.ok(results.some(result => result.toolName === "read_serial_log" && !result.isError));
        assert.ok(results.some(result => result.toolName === "get_device_status" && !result.isError));
        return [write()];
      }
      return done();
    });
    try {
      await f.agent.prompt("Continue the repair.", { recovery: f.recovery });
      assert.deepEqual(f.sent, ["touch /tmp/recovery-example\r"]);
    } finally { f.device.setMode("auto"); }
  });
}

test("a new conversation does not inherit a recovery gate", async () => {
  const f = fixture(null, round => round === 1 ? [write()] : done());
  try {
    await f.agent.prompt("Create the example file.");
    assert.deepEqual(f.sent, ["touch /tmp/recovery-example\r"]);
  } finally { f.device.setMode("auto"); }
});

const checkpoint = pendingExecutions => ({version:1,deviceKey:JSON.stringify(['ble','bee-a','115200']),sessionId:1,pendingExecutions});
const refresh = () => [tool('get_device_status'),tool('read_serial_log'),tool('get_task_checkpoint')];
const lastResult = context => context.messages.findLast(message=>message.role==='toolResult');

test('a reused serial id after reload stays unknown and its uncertain operation cannot be replayed',async()=>{
  const args={text:'touch /tmp/recovery-example',appendEnter:true};
  const historical={id:'serial-1',executorId:'previous-page',sessionId:1,delivery:'unknown',executionStatus:'unknown',requestFingerprint:await inputFingerprint(args)};
  const f=fixture(null,(round,context)=>{
    if(round===1)return refresh();
    if(round===2){
      const result=JSON.parse(lastResult(context).content[0].text);
      assert.equal(result.observations[0].availability,'unavailable');
      assert.equal(result.observations[0].outcome,'unknown');
      return [write()];
    }
    assert.match(JSON.stringify(lastResult(context)),/unresolved historical execution/);
    return done();
  });
  try {
    const current=await f.device.execute({text:'printf new-page',appendEnter:true});
    assert.equal(current.id,'serial-1');assert.notEqual(current.executorId,historical.executorId);
    await f.agent.prompt('Continue',{recovery:{checkpoint:checkpoint([historical])}});
    assert.deepEqual(f.sent,['printf new-page\r']);
    assert.equal(f.agent.checkpoint().pendingExecutions[0].executorId,'previous-page');
  }finally{f.device.setMode('auto');}
});

test('a live recovered command is observed to completion before new input without replay',async()=>{
  let original;
  const f=fixture(null,(round,context)=>{
    if(round===1)return refresh();
    if(round===2)return [write()];
    if(round===3){
      assert.match(JSON.stringify(lastResult(context)),/recovered execution is still unresolved/);
      f.journal.append(new TextEncoder().encode(`\n${original.completionToken}:0\nroot@board:~# `));
      return [tool('monitor_serial_execution',{id:original.id,timeoutMs:100})];
    }
    if(round===4)return [tool('get_task_checkpoint')];
    if(round===5)return [write()];
    return done();
  });
  try {
    original=await f.device.execute({text:'long-running-job',appendEnter:true,trackExit:true});
    await f.agent.prompt('Continue',{recovery:{checkpoint:checkpoint([executionReference(original)])}});
    assert.equal(f.sent.length,2);
    assert.match(f.sent[0],/long-running-job/);
    assert.equal(f.sent[1],'touch /tmp/recovery-example\r');
  }finally{f.device.setMode('auto');}
});

test('checkpoint recovery rejects another target before any model request or UART input',async()=>{
  const f=fixture(null,()=>assert.fail('mismatched device must not call the model'));
  try {
    await assert.rejects(f.agent.prompt('Continue',{recovery:{checkpoint:{...checkpoint([]),deviceKey:'target:another'}}}),/another device/);
    assert.deepEqual(f.sent,[]);
  }finally{f.device.setMode('auto');}
});

test('an interrupted observation remains unknown but permits a different read-only check after recovery',async()=>{
  let original;
  const f=fixture(null,(round,context)=>{
    if(round===1)return refresh();
    if(round===2){
      assert.equal(JSON.parse(lastResult(context).content[0].text).observations[0].outcome,'unknown');
      return [tool('run_shell_command',{command:'wc -c /tmp/recovery-example'})];
    }
    assert.equal(lastResult(context).isError,false);
    return done();
  });
  try{
    original=await f.device.execute({text:'touch /tmp/recovery-example',appendEnter:true});
    await f.device.execute({text:'user-input',appendEnter:true});
    f.journal.append(new TextEncoder().encode('\nroot@board:~# '));
    await f.agent.prompt('Check the effect without replay',{recovery:{checkpoint:checkpoint([executionReference(original)])}});
    assert.equal(f.sent.length,3);assert.match(f.sent[2],/wc -c/);
  }finally{f.device.setMode('auto');}
});
