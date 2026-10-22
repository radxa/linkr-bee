import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../../harmonyos/entry/src/main/ets/bridge/LinkrBleHost.ets", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function createHost() {
  const context = {
    exports: {}, setTimeout, clearTimeout,
    require: () => ({ ble: { GattWriteType: { WRITE: 1, WRITE_NO_RESPONSE: 0 } } }),
  };
  vm.runInNewContext(outputText, context);
  return new context.exports.LinkrBleHost({ runJavaScript: async () => "" });
}

function connect(host, calls) {
  host.client = {
    disconnect() {}, close() {},
    writeCharacteristicValue: async () => calls.push("write"),
    readCharacteristicValue: async () => { calls.push("read"); return { characteristicValue: new ArrayBuffer(0) }; },
    setCharacteristicChangeIndication: async () => calls.push("subscribe"),
  };
  host.connectedDeviceId = "same-board";
  host.characteristics.set("service/uart", { characteristicValue: new ArrayBuffer(0) });
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
      : host.setIndications("same-board", "service", "uart", true);
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
  } }) };
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
