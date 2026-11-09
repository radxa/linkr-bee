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
    AbortController,
    setTimeout,
    clearTimeout,
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

function browserFixture({ watching = "ok", connectError = "Bluetooth Device is no longer in range." } = {}) {
  const listeners = new Map();
  const calls = { connects: 0, watches: 0, requests: 0, watchSignal: null };
  const device = {
    id: "original-bee", name: "Linkr Bee",
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
    gatt: {
      connected: false,
      async connect() {
        calls.connects++;
        if (calls.connects === 1) throw new Error(connectError);
        this.connected = true;
        return this;
      },
      disconnect() { this.connected = false; },
    },
  };
  if (watching !== "missing") device.watchAdvertisements = async ({ signal }) => {
    calls.watches++;
    calls.watchSignal = signal;
    if (watching === "reject") throw new Error("Not supported");
  };
  const { transport } = installTransport({ navigator: { bluetooth: {
    async requestDevice() { calls.requests++; return device; },
  } } });
  return { transport, device, calls, listeners };
}

async function waitForWatch(fixture) {
  for (let i = 0; i < 20 && !fixture.calls.watches; i++) await Promise.resolve();
  assert.equal(fixture.calls.watches, 1);
}

test("browser rediscovers only the original Bee before retrying GATT", async () => {
  const f = browserFixture();
  await f.transport.requestDevice({});
  const connecting = f.transport.connect(f.device.id);
  await waitForWatch(f);
  f.listeners.get("advertisementreceived")({ device: { id: "other-bee" } });
  assert.equal(f.calls.connects, 1);
  f.listeners.get("advertisementreceived")({ device: f.device });
  await connecting;
  assert.equal(f.calls.connects, 2);
  assert.equal(f.calls.requests, 1);
  assert.equal(f.calls.watchSignal.aborted, true);
  assert.equal(f.listeners.has("advertisementreceived"), false);
  assert.equal(await f.transport.isConnected(), true);
});

for (const watching of ["missing", "reject"]) {
  test(`browser asks for reselection when advertisement watching is ${watching}`, async () => {
    const f = browserFixture({ watching });
    await f.transport.requestDevice({});
    await assert.rejects(f.transport.connect(f.device.id), { code: "BLE_RESELECT_REQUIRED" });
    assert.equal(f.calls.connects, 1);
    assert.equal(f.calls.requests, 1);
    assert.equal(f.listeners.has("advertisementreceived"), false);
    if (f.calls.watchSignal) assert.equal(f.calls.watchSignal.aborted, true);
  });
}

test("cancelling rediscovery releases the watcher and ignores late advertisements", async () => {
  const f = browserFixture();
  await f.transport.requestDevice({});
  const controller = new AbortController();
  const connecting = f.transport.connect(f.device.id, () => {}, { signal: controller.signal });
  await waitForWatch(f);
  const late = f.listeners.get("advertisementreceived");
  controller.abort();
  await assert.rejects(connecting, { name: "AbortError" });
  late({ device: f.device });
  assert.equal(f.calls.connects, 1);
  assert.equal(f.calls.watchSignal.aborted, true);
  assert.equal(f.listeners.has("advertisementreceived"), false);
});

test("authentication failures do not trigger rediscovery", async () => {
  const f = browserFixture({ connectError: "Authentication failed." });
  await f.transport.requestDevice({});
  await assert.rejects(f.transport.connect(f.device.id), /Authentication failed/);
  assert.equal(f.calls.watches, 0);
  assert.equal(f.calls.connects, 1);
});

test("a forgotten browser object requests reselection without dialing", async () => {
  const f = browserFixture();
  await assert.rejects(f.transport.connect("unknown"), { code: "BLE_RESELECT_REQUIRED" });
  assert.equal(f.calls.connects, 0);
});

test("rediscovery timeout is bounded and stops scanning", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = browserFixture();
  await f.transport.requestDevice({});
  const connecting = f.transport.connect(f.device.id);
  const rejected = assert.rejects(connecting, { code: "BLE_RESELECT_REQUIRED" });
  await waitForWatch(f);
  t.mock.timers.tick(8000);
  await rejected;
  assert.equal(f.calls.connects, 1);
  assert.equal(f.calls.watchSignal.aborted, true);
  assert.equal(f.listeners.has("advertisementreceived"), false);
});

function browserGattFixture({ failFirst = false } = {}) {
  const calls = [];
  let releaseWrite;
  const gate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const characteristic = {
    async writeValueWithResponse(bytes) {
      calls.push(["write:start", Array.from(bytes)]);
      if (calls.filter((call) => call[0] === "write:start").length === 1) {
        await gate;
        if (failFirst) throw new Error("GATT failure");
      }
      calls.push(["write:end", Array.from(bytes)]);
    },
    async startNotifications() {
      calls.push(["start:notifications"]);
    },
    async stopNotifications() {
      calls.push(["stop:notifications"]);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const server = {
    connected: true,
    async getPrimaryService() {
      return {
        async getCharacteristic() {
          return characteristic;
        },
      };
    },
  };
  const device = {
    id: "browser-1",
    name: "Linkr Bee 0001",
    addEventListener() {},
    removeEventListener() {},
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return server;
      },
      disconnect() {
        this.connected = false;
      },
    },
  };
  const { transport } = installTransport({
    navigator: {
      bluetooth: {
        async requestDevice() {
          return device;
        },
      },
    },
  });
  return { transport, device, calls, release: () => releaseWrite() };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test("browser serializes concurrent GATT writes", async () => {
  const f = browserGattFixture();
  await f.transport.requestDevice({});
  await f.transport.connect(f.device.id);

  const first = f.transport.write("browser-1", "service", "characteristic", [1], true);
  const second = f.transport.write("browser-1", "service", "characteristic", [2], true);
  await settle();

  assert.deepEqual(
    f.calls.filter((call) => call[0] === "write:start"),
    [["write:start", [1]]],
    "the second write must not start while the first is in flight",
  );

  f.release();
  await Promise.all([first, second]);
  assert.deepEqual(f.calls.filter((call) => call[0] === "write:start"), [
    ["write:start", [1]],
    ["write:start", [2]],
  ]);
});

test("browser queues notification setup behind a pending write", async () => {
  const f = browserGattFixture();
  await f.transport.requestDevice({});
  await f.transport.connect(f.device.id);

  const write = f.transport.write("browser-1", "service", "characteristic", [3], true);
  const subscribe = f.transport.startNotifications(
    "browser-1",
    "service",
    "characteristic",
    () => {},
  );
  await settle();

  assert.deepEqual(f.calls.filter((call) => call[0] === "start:notifications"), []);
  f.release();
  await Promise.all([write, subscribe]);
  assert.deepEqual(f.calls.filter((call) => call[0] === "start:notifications"), [
    ["start:notifications"],
  ]);
});

test("a rejected GATT write releases the serialization chain", async () => {
  const f = browserGattFixture({ failFirst: true });
  await f.transport.requestDevice({});
  await f.transport.connect(f.device.id);

  const failing = f.transport.write("browser-1", "service", "characteristic", [4], true);
  const following = f.transport.write("browser-1", "service", "characteristic", [5], true);
  await settle();
  f.release();

  await assert.rejects(failing, /GATT failure/);
  await following;
  assert.deepEqual(f.calls.filter((call) => call[0] === "write:start"), [
    ["write:start", [4]],
    ["write:start", [5]],
  ]);
});
