import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const bridgeSource = await readFile(
  path.resolve(import.meta.dirname, "../../harmonyos/src/native-bootstrap.js"),
  "utf8",
);

function installBridge(window, timers = {}) {
  vm.runInContext(
    bridgeSource,
    vm.createContext({
      window,
      Array,
      clearTimeout: timers.clearTimeout || clearTimeout,
      DataView,
      Error,
      Map,
      Promise,
      setTimeout: timers.setTimeout || setTimeout,
      String,
      Uint8Array,
    }),
    { filename: "harmonyos/src/native-bootstrap.js" },
  );
  return window;
}

function createHost() {
  const messages = [];
  const window = installBridge({
    linkrBleHost: {
      postMessage(message) {
        messages.push(JSON.parse(message));
      },
    },
  });
  return { messages, window };
}

test("Harmony bridge correlates requests and forwards binary notifications", async () => {
  const { messages, window } = createHost();

  const request = window.LinkrNativeBle.requestDevice({
    filters: [{ services: ["management-service"] }],
  });
  assert.equal(messages[0].method, "requestDevice");
  window.LinkrHarmonyBle.resolve(
    messages[0].id,
    { id: "harmony-1", name: "Linkr BLE UART-1" },
    null,
  );
  assert.deepEqual(await request, {
    id: "harmony-1",
    name: "Linkr BLE UART-1",
  });

  let received = [];
  const subscribe = window.LinkrNativeBle.startNotifications(
    "harmony-1",
    "service",
    "characteristic",
    (bytes) => {
      received = Array.from(bytes);
    },
  );
  window.LinkrHarmonyBle.resolve(messages[1].id, null, null);
  await subscribe;
  window.LinkrHarmonyBle.notify(
    "harmony-1",
    "service",
    "characteristic",
    [1, 2, 255],
  );
  assert.deepEqual(received, [1, 2, 255]);

  let disconnects = 0;
  const connect = window.LinkrNativeBle.connect("harmony-1", () => {
    disconnects += 1;
  });
  window.LinkrHarmonyBle.resolve(messages[2].id, null, null);
  await connect;
  assert.equal(window.LinkrNativeBle.isConnected(), true);

  window.LinkrHarmonyBle.disconnected("harmony-1");
  window.LinkrHarmonyBle.notify(
    "harmony-1",
    "service",
    "characteristic",
    [9],
  );
  window.LinkrHarmonyBle.disconnected("harmony-1");
  assert.equal(window.LinkrNativeBle.isConnected(), false);
  assert.equal(disconnects, 1);
  assert.deepEqual(received, [1, 2, 255]);
});

test("Harmony bridge copies writes, returns reads, and reports host errors", async () => {
  const { messages, window } = createHost();

  const write = window.LinkrNativeBle.write(
    "harmony-2",
    "service",
    "rx",
    Uint8Array.from([0, 127, 255]),
    false,
  );
  assert.deepEqual(messages[0].args.value, [0, 127, 255]);
  assert.equal(messages[0].args.withResponse, false);
  window.LinkrHarmonyBle.resolve(messages[0].id, null, null);
  await write;

  const read = window.LinkrNativeBle.read("harmony-2", "service", "tx");
  window.LinkrHarmonyBle.resolve(messages[1].id, [1, 2, 3], null);
  assert.deepEqual(
    Array.from(new Uint8Array((await read).buffer)),
    [1, 2, 3],
  );

  const failed = window.LinkrNativeBle.initialize();
  window.LinkrHarmonyBle.resolve(messages[2].id, null, "permission denied");
  await assert.rejects(failed, /permission denied/);
});

test("Harmony bridge rejects device operations after a remote disconnect", async () => {
  const { messages, window } = createHost();

  const connect = window.LinkrNativeBle.connect("harmony-3", () => {});
  window.LinkrHarmonyBle.resolve(messages[0].id, null, null);
  await connect;

  const write = window.LinkrNativeBle.write(
    "harmony-3",
    "service",
    "rx",
    Uint8Array.from([42]),
  );
  window.LinkrHarmonyBle.disconnected("harmony-3");
  await assert.rejects(write, /device disconnected/);

  window.LinkrHarmonyBle.resolve(messages[1].id, null, null);
  assert.equal(window.LinkrNativeBle.isConnected(), false);
});

test("Harmony bridge times out when the ArkTS host loses a response", async () => {
  let timeoutCallback = () => {};
  let timeoutDelay = 0;
  let cleared = false;
  const window = installBridge(
    {
      linkrBleHost: {
        postMessage() {},
      },
    },
    {
      setTimeout(callback, delay) {
        timeoutCallback = callback;
        timeoutDelay = delay;
        return 7;
      },
      clearTimeout(id) {
        assert.equal(id, 7);
        cleared = true;
      },
    },
  );

  const request = window.LinkrNativeBle.initialize();
  assert.equal(timeoutDelay, 30000);
  timeoutCallback();
  await assert.rejects(request, /request timed out: initialize/);
  assert.equal(cleared, false);
});
