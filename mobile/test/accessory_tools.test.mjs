import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { createSerialAgent } from "../src/pi-agent.mjs";

/* Accessory tools are injected by the panel only when the app can reach the
 * management channel; these tests drive the real Pi loop against a fake
 * accessory and assert what the model is allowed to observe. */
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
const toolCall = (name, args) => ({ type: "toolCall", id: `call-${name}`, name, arguments: args });
const toolResultText = (message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

function makeAgent({ accessory, stream, getStatus = () => status, sendInput = () => assert.fail("accessory tests must not write UART") }) {
  return createSerialAgent({
    config, stream, accessory,
    runLimits: { maxTurns: 8, maxTools: 16 },
    device: { mode: "auto", getStatus, readLog: () => ({ text: "", cursor: 0 }), execute: sendInput,
      inspectExecution: () => ({ executionStatus: "unknown" }) },
  });
}

test("accessory tools exist only when the app injects the capability", async () => {
  const seen = [];
  const stream = fakeStream((context) => {
    seen.push(getCurrentTools(context.messages).map((tool) => tool.name));
    return [{ type: "text", text: "done" }];
  });
  await makeAgent({ accessory: null, stream }).prompt("hello");
  for (const name of ["get_accessory_diagnostics", "set_uart_config", "wifi_scan", "set_wifi", "set_webdav"]) {
    assert.equal(seen[0].includes(name), false, `${name} must not be exposed without an accessory`);
  }

  const withAccessory = [];
  const accessoryStream = fakeStream((context) => {
    withAccessory.push(getCurrentTools(context.messages).map((tool) => tool.name));
    return [{ type: "text", text: "done" }];
  });
  await makeAgent({ accessory: { capability: () => ({ available: true }) }, stream: accessoryStream }).prompt("hello");
  for (const name of ["get_accessory_diagnostics", "set_uart_config", "wifi_scan", "set_wifi", "set_webdav"]) {
    assert.equal(withAccessory[0].includes(name), true, `${name} must be exposed with an accessory`);
  }
});

test("diagnostics are read without approval and reach the next model turn", async () => {
  let turns = 0, readings = 0;
  const agent = makeAgent({
    stream: fakeStream((context) => {
      if (++turns === 1) return [toolCall("get_accessory_diagnostics", {})];
      const evidence = JSON.parse(toolResultText(context.messages.at(-1)));
      assert.equal(evidence.groups.fw.version, "0.1.2");
      assert.equal(evidence.settled, true);
      assert.equal(evidence.source, "accessory-management-channel");
      return [{ type: "text", text: "Firmware 0.1.2 is running." }];
    }),
    accessory: {
      capability: () => ({ available: true }),
      diagnostics: async ({ signal }) => {
        assert.equal(signal?.aborted, false);
        readings += 1;
        return { settled: true, lines: ["@info fw version=0.1.2 zephyr=4.4.1"],
          groups: { fw: { version: "0.1.2", zephyr: "4.4.1" } } };
      },
    },
  });
  await agent.prompt("Which firmware is the bridge running?");
  assert.equal(turns, 2);
  assert.equal(readings, 1);
});

test("a change reports the accessory's own reading, not an acknowledgement", async () => {
  const calls = [];
  let turns = 0;
  const agent = makeAgent({
    stream: fakeStream((context) => {
      if (++turns === 1) return [toolCall("set_uart_config", { baud: 9600, parity: "e", stopBits: 2 })];
      const evidence = JSON.parse(toolResultText(context.messages.at(-1)));
      assert.equal(evidence.applied, true);
      assert.equal(evidence.confirmed.baud, 9600);
      assert.equal(evidence.accepted, true);
      return [{ type: "text", text: "The bridge now runs 9600,8,e,2,none." }];
    }),
    accessory: {
      capability: () => ({ available: true }),
      change: async ({ action, args }) => {
        calls.push({ action, args });
        return { command: "@u=9600,8,e,2,none", reply: "OK uart=9600,8,E,2,none", accepted: true,
          confirmed: { baud: 9600, dataBits: 8, parity: "e", stopBits: 2, flow: "none" }, settled: true, applied: true };
      },
    },
  });
  await agent.prompt("Switch the bridge to 9600 8E2");
  assert.deepEqual(calls, [{ action: "set-uart", args: { baud: 9600, parity: "e", stopBits: 2 } }]);
  assert.equal(turns, 2);
});

test("a rejected change is an error result the model cannot read as success", async () => {
  let turns = 0, changes = 0;
  const agent = makeAgent({
    stream: fakeStream((context) => {
      if (++turns === 1) return [toolCall("set_wifi", { action: "connect", ssid: "Bench", password: "hunter2" })];
      const result = context.messages.at(-1);
      assert.equal(result.isError, true);
      assert.match(toolResultText(result), /rejected/i);
      assert.doesNotMatch(toolResultText(result), /hunter2/);
      return [{ type: "text", text: "The change was declined." }];
    }),
    accessory: {
      capability: () => ({ available: true, wifi: true }),
      change: async () => { changes += 1; throw new Error("The user rejected this change. Do not retry unless the user asks again."); },
    },
  });
  await agent.prompt("Join the Bench network");
  assert.equal(changes, 1);
  assert.equal(turns, 2);
});

test("a firmware without the capability is reported instead of attempted", async () => {
  let changes = 0, turns = 0;
  const agent = makeAgent({
    stream: fakeStream((context) => {
      if (++turns === 1) return [toolCall("wifi_scan", {})];
      const result = context.messages.at(-1);
      assert.equal(result.isError, true);
      assert.match(toolResultText(result), /does not provide WiFi control/);
      return [{ type: "text", text: "Unavailable." }];
    }),
    accessory: {
      capability: () => ({ available: true, wifi: false }),
      change: async () => { changes += 1; throw new Error("must not run"); },
    },
  });
  await agent.prompt("Scan for networks");
  assert.equal(turns, 2);
  assert.equal(changes, 0);
});

test("accessory changes are refused while the app has no management channel", async () => {
  let turns = 0, changes = 0;
  const agent = makeAgent({
    stream: fakeStream((context) => {
      if (++turns === 1) return [toolCall("set_wifi", { action: "off" })];
      const result = context.messages.at(-1);
      assert.equal(result.isError, true);
      assert.match(toolResultText(result), /Bluetooth LE connection/);
      return [{ type: "text", text: "Not available over LAN." }];
    }),
    accessory: {
      capability: () => ({ available: false, reason: "Accessory settings need a Bluetooth LE connection; LAN mode carries the terminal data path only." }),
      change: async () => { changes += 1; throw new Error("must not run"); },
    },
  });
  const outcome = await agent.prompt("Turn off WiFi");
  assert.equal(turns, 2);
  assert.equal(changes, 0);
  assert.equal(outcome.limitReached, false);
});
