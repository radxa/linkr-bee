import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import ts from "typescript";

const source = await readFile(new URL("../../harmonyos/entry/src/main/ets/bridge/LinkrBleHost.ets", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const hilog = { info() {}, warn() {}, error() {} };

function createHost() {
  const context = {
    exports: {}, setTimeout, clearTimeout,
    require: () => ({ ble: { GattWriteType: { WRITE: 1, WRITE_NO_RESPONSE: 0 } }, hilog }),
  };
  vm.runInNewContext(outputText, context);
  return new context.exports.LinkrBleHost({ runJavaScript: async () => "" });
}

function connect(host, calls) {
  host.client = {
    disconnect() {}, close() {},
    writeCharacteristicValue: async () => calls.push("write"),
    readCharacteristicValue: async () => { calls.push("read"); return { characteristicValue: new ArrayBuffer(0) }; },
    setCharacteristicChangeNotification: async () => calls.push("subscribe"),
    setCharacteristicChangeIndication: async () => calls.push("subscribe"),
  };
  host.connectedDeviceId = "same-board";
  host.characteristics.set("service/uart", { characteristicValue: new ArrayBuffer(0),
    properties: { notify: false, indicate: true } });
}

for (const method of ["read", "write", "subscribe"]) {
  test(`Harmony queued ${method} cannot enter a reconnected session on the same board`, async () => {
    const host = createHost();
    const calls = [];
    connect(host, calls);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = host.enqueue(() => gate);
    await Promise.resolve();
    const stale = method === "read" ? host.read("same-board", "service", "uart")
      : method === "write" ? host.write("same-board", "service", "uart", [114, 101, 98, 111, 111, 116, 13], true)
      : host.setSubscription("same-board", "service", "uart", true);
    const rejected = [assert.rejects(first, /session changed/), assert.rejects(stale, /session changed/)];
    host.closeClient(true);
    connect(host, calls);
    release();
    await Promise.all(rejected);
    assert.deepEqual(calls, []);
    await host.write("same-board", "service", "uart", [65], true);
    assert.deepEqual(calls, ["write"]);
  });
}

test("Harmony completion from a retired connect cannot close its replacement", async () => {
  let release;
  const context = { exports: {}, setTimeout, clearTimeout, require: () => ({ ble: {
    createGattClientDevice: () => ({ disconnect() {}, close() {}, getServices: async () => [] }),
  }, hilog }) };
  vm.runInNewContext(outputText, context);
  const connecting = new context.exports.LinkrBleHost({ runJavaScript: async () => "" });
  connecting.waitForConnection = () => new Promise(resolve => { release = resolve; });
  const old = connecting.connect("same-board");
  const rejected = assert.rejects(old, /session changed/);
  connecting.closeClient(true);
  connect(connecting, []);
  const replacement = connecting.client;
  release();
  await rejected;
  assert.equal(connecting.client, replacement);
  assert.equal(connecting.connectedDeviceId, "same-board");
});

const bondStates = { BOND_STATE_INVALID: 0, BOND_STATE_BONDING: 1, BOND_STATE_BONDED: 2 };
const pairingDevice = "AA:BB:CC:DD:EE:FF";

function createPairingHost(initialState = bondStates.BOND_STATE_INVALID) {
  let state = initialState, resolvePair, rejectPair;
  const calls = [], listeners = new Set(), timers = new Map();
  const client = {
    disconnect: () => calls.push("disconnect"), close: () => calls.push("close"),
    getServices: async () => {
      calls.push("services");
      return [{ serviceUuid: "4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001",
        characteristics: [{ characteristicUuid: "protocol" }] }];
    },
  };
  const connection = {
    BondState: bondStates,
    getPairState: () => state,
    on(type, callback) { assert.equal(type, "bondStateChange"); listeners.add(callback); },
    off(type, callback) { assert.equal(type, "bondStateChange"); listeners.delete(callback); },
    pairDevice(id) {
      assert.equal(id, pairingDevice);
      calls.push("pair");
      return new Promise((resolve, reject) => { resolvePair = resolve; rejectPair = reject; });
    },
  };
  const context = { exports: {},
    setTimeout(callback, delay) { const id = timers.size + 1; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require: () => ({ ble: { createGattClientDevice: () => client }, connection, hilog }),
  };
  vm.runInNewContext(outputText, context);
  const host = new context.exports.LinkrBleHost({ runJavaScript: async () => "" });
  host.waitForConnection = async () => { calls.push("link"); };
  host.negotiateMtu = async () => { assert.equal(state, bondStates.BOND_STATE_BONDED); calls.push("mtu"); };
  return { host, client, connection, calls, listeners, timers,
    resolvePair: () => resolvePair(), rejectPair: error => rejectPair(error),
    emit(nextState, deviceId = pairingDevice, cause = 3) {
      if (deviceId.toLowerCase() === pairingDevice.toLowerCase()) state = nextState;
      for (const callback of [...listeners]) callback({ deviceId, state: nextState, cause });
    },
  };
}

test("Harmony bonded reconnect skips pairing", async () => {
  const f = createPairingHost(bondStates.BOND_STATE_BONDED);
  await f.host.connect(pairingDevice);
  assert.deepEqual(f.calls, ["link", "mtu", "services"]);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
});

test("Harmony first host explicitly pairs and waits for its own bond before GATT", async () => {
  const f = createPairingHost();
  const connected = f.host.connect(pairingDevice);
  await nextTurn();
  assert.deepEqual(f.calls, ["link", "pair"]);
  f.resolvePair();
  await nextTurn();
  assert.deepEqual(f.calls, ["link", "pair"], "a resolved request alone is not proof of a bond");
  f.emit(bondStates.BOND_STATE_BONDED, "11:22:33:44:55:66");
  assert.equal(f.listeners.size, 1);
  f.emit(bondStates.BOND_STATE_BONDED, pairingDevice.toLowerCase());
  await connected;
  assert.deepEqual(f.calls, ["link", "pair", "mtu", "services"]);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test("Harmony joins an existing system pairing without a duplicate pair request", async () => {
  const f = createPairingHost(bondStates.BOND_STATE_BONDING);
  const connected = f.host.connect(pairingDevice);
  await nextTurn();
  assert.deepEqual(f.calls, ["link"]);
  f.emit(bondStates.BOND_STATE_BONDED);
  await connected;
  assert.deepEqual(f.calls, ["link", "mtu", "services"]);
});

test("Harmony catches a bond completed while its listener was being installed", async () => {
  const f = createPairingHost();
  let reads = 0;
  f.connection.getPairState = () => ++reads === 1 ? bondStates.BOND_STATE_INVALID : bondStates.BOND_STATE_BONDED;
  f.host.negotiateMtu = async () => f.calls.push("mtu");
  await f.host.connect(pairingDevice);
  assert.deepEqual(f.calls, ["link", "mtu", "services"]);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test("Harmony rejected pairing closes the link without service access", async () => {
  const f = createPairingHost();
  const connected = f.host.connect(pairingDevice);
  const failed = assert.rejects(connected, /pairing failed \(cause 3\)/);
  await nextTurn();
  f.emit(bondStates.BOND_STATE_INVALID);
  await failed;
  f.resolvePair();
  await nextTurn();
  assert.deepEqual(f.calls, ["link", "pair", "disconnect", "close"]);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test("Harmony pairing API errors retain the native error code", async () => {
  const f = createPairingHost();
  const failed = assert.rejects(f.host.connect(pairingDevice), /pairing failed: Rejected \(code 2900099\)/);
  await nextTurn();
  f.rejectPair({ message: "Rejected", code: 2900099 });
  await failed;
  assert.deepEqual(f.calls, ["link", "pair", "disconnect", "close"]);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test("Harmony bond lookup errors fail closed without starting pairing", async () => {
  const f = createPairingHost();
  f.connection.getPairState = () => { throw { message: "Bluetooth disabled", code: 2900003 }; };
  await assert.rejects(f.host.connect(pairingDevice), /Unable to query Bluetooth bond: Bluetooth disabled \(code 2900003\)/);
  assert.deepEqual(f.calls, ["link", "disconnect", "close"]);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test("Harmony pairing timeout is bounded and removes its listener", async () => {
  const f = createPairingHost();
  const failed = assert.rejects(f.host.connect(pairingDevice), /pairing timed out/);
  await nextTurn();
  const [timer] = f.timers.values();
  assert.equal(timer.delay, 60000);
  timer.callback();
  await failed;
  assert.deepEqual(f.calls, ["link", "pair", "disconnect", "close"]);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test("Harmony retiring a pairing cannot complete or close a replacement session", async () => {
  const f = createPairingHost();
  const failed = assert.rejects(f.host.connect(pairingDevice), /session changed/);
  await nextTurn();
  f.host.closeClient(true);
  const replacement = { disconnect() { assert.fail("replacement disconnected"); } };
  f.host.client = replacement;
  f.host.connectedDeviceId = pairingDevice;
  f.emit(bondStates.BOND_STATE_BONDED);
  f.resolvePair();
  await failed;
  assert.equal(f.host.client, replacement);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls, ["link", "pair", "disconnect", "close"]);
});
test("Harmony subscribes with the CCC the characteristic actually declares", async () => {
  const host = createHost();
  const calls = [];
  host.client = {
    setCharacteristicChangeNotification: async (_characteristic, enabled) => calls.push(`notify:${enabled}`),
    setCharacteristicChangeIndication: async (_characteristic, enabled) => calls.push(`indicate:${enabled}`),
  };
  host.connectedDeviceId = "same-board";
  host.characteristics.set("svc/tx", { characteristicUuid: "tx",
    properties: { notify: true, indicate: false } });
  host.characteristics.set("svc/mgmt", { characteristicUuid: "mgmt",
    properties: { notify: false, indicate: true } });
  host.characteristics.set("svc/both", { characteristicUuid: "both",
    properties: { notify: true, indicate: true } });
  await host.setSubscription("same-board", "svc", "tx", true);
  await host.setSubscription("same-board", "svc", "mgmt", true);
  await host.setSubscription("same-board", "svc", "both", true);
  await host.setSubscription("same-board", "svc", "tx", false);
  assert.deepEqual(calls, ["notify:true", "indicate:true", "notify:true", "notify:false"],
    "NUS TX is notify-only, Management uses indications, and both prefers the lower-latency path");
});

test("Harmony disconnect drops queued notifications instead of delivering them after a reconnect", async () => {
  let deliver = () => {};
  const delivered = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = { exports: {}, setTimeout, clearTimeout,
    require: () => ({ ble: { GattWriteType: { WRITE: 1, WRITE_NO_RESPONSE: 0 } }, hilog }) };
  const source = outputText;
  vm.runInNewContext(source, context);
  const host = new context.exports.LinkrBleHost({
    runJavaScript: async (script) => {
      delivered.push(script);
      // The first IPC stays in flight, so later notifications only queue.
      if (delivered.length === 1) await gate;
    },
  });
  const notification = (length) => ({ serviceUuid: "svc", characteristicUuid: "tx",
    characteristicValue: new Uint8Array(length).fill(65).buffer });
  host.client = { disconnect() {}, close() {} };
  host.connectedDeviceId = "same-board";

  host.sendNotification("same-board", notification(4));
  await nextTurn();
  host.sendNotification("same-board", notification(8));
  assert.equal(host.pendingNotifications.length, 1, "the second notification waits behind the in-flight batch");

  host.closeClient(true);
  assert.equal(host.pendingNotifications.length, 0, "a disconnect empties the queue");
  assert.equal(host.pendingNotificationBytes, 0, "and its byte counter");

  host.client = { disconnect() {}, close() {} };
  host.connectedDeviceId = "same-board";
  host.sendNotification("same-board", notification(2));
  release();
  await nextTurn();
  await nextTurn();
  assert.ok(delivered.length >= 2, "the flush continues after the link changed");
  const batches = delivered.map((script) => JSON.parse(script.replace(/^window.LinkrHarmonyBle.notifyBatch\(/, "").replace(/\);$/, "")));
  assert.ok(batches.every((batch) => Array.isArray(batch)), "each delivery is a batch");
  const deliveredBytes = batches.flat().map((item) => item.value.length);
  assert.deepEqual(deliveredBytes, [4, 2], "the queued 8-byte batch from the retired link is never delivered");
});
