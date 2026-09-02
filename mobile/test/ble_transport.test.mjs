import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const transportSource = await readFile(
  path.resolve(import.meta.dirname, "../../web/ble_transport.js"),
  "utf8",
);

function installTransport(window = {}) {
  window.navigator ??= {};
  const context = vm.createContext({
    window,
    ArrayBuffer,
    DataView,
    Map,
    Promise,
    TypeError,
    Uint8Array,
  });
  vm.runInContext(transportSource, context, {
    filename: "web/ble_transport.js",
  });
  return { transport: window.LinkrBleTransport, window };
}

test("native backend receives copied binary writes and notifications", async () => {
  const calls = [];
  let notificationCallback;
  const native = {
    platform: "android",
    isAvailable: () => true,
    initialize: async () => calls.push(["initialize"]),
    requestDevice: async () => ({ id: "native-1", name: "Linkr BLE UART-1" }),
    getDevices: async () => [],
    connect: async () => calls.push(["connect"]),
    disconnect: async () => calls.push(["disconnect"]),
    isConnected: () => true,
    read: async () => new DataView(Uint8Array.from([1, 2, 3]).buffer),
    write: async (_id, service, characteristic, value, withResponse) => {
      calls.push([
        "write",
        service,
        characteristic,
        Array.from(value),
        withResponse,
      ]);
    },
    startNotifications: async (_id, _service, _characteristic, callback) => {
      notificationCallback = callback;
    },
    stopNotifications: async () => {},
  };
  const { transport } = installTransport({ LinkrNativeBle: native });

  await transport.initialize();
  await transport.write("native-1", "service", "characteristic", [4, 5], true);
  const value = await transport.read("native-1", "service", "characteristic");
  assert.deepEqual(Array.from(new Uint8Array(value.buffer)), [1, 2, 3]);

  let notified = [];
  await transport.startNotifications(
    "native-1",
    "service",
    "characteristic",
    (bytes) => {
      notified = Array.from(bytes);
    },
  );
  notificationCallback(Uint8Array.from([6, 7]));

  assert.deepEqual(notified, [6, 7]);
  assert.deepEqual(calls, [
    ["initialize"],
    ["write", "service", "characteristic", [4, 5], true],
  ]);
});

test("pending native backend keeps BLE available before bootstrap resolves", async () => {
  let resolveReady;
  const window = {
    navigator: {},
    LinkrNativeBleReady: new Promise((resolve) => {
      resolveReady = resolve;
    }),
  };
  const installed = installTransport(window);
  const transport = installed.transport;
  assert.equal(transport.isAvailable(), true);

  installed.window.LinkrNativeBle = {
    platform: "harmonyos",
    initialize: async () => {},
  };
  resolveReady();
  await transport.initialize();
  assert.equal(transport.platform(), "harmonyos");
});
