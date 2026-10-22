import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/app.js?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() +
      "\nwindow.__initialLogTest = { state, connect, connectWs, onDisconnected, agentJournal, bleTransport };" });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__initialLogTest?.state.term);
  await page.evaluate(() => {
    const { state, bleTransport } = window.__initialLogTest;
    state.mode = "ble";
    window.serialNotifications = new Map();
    window.initialLogs = new Map();
    window.serialFrame = (text, sequence = 1) => {
      const payload = new TextEncoder().encode(text);
      const bytes = new Uint8Array(12 + payload.length);
      const view = new DataView(bytes.buffer);
      bytes.set([0x4c, 0x52, 1, 0]);
      view.setUint32(4, sequence, true);
      view.setUint16(8, payload.length, true);
      bytes.set(payload, 12);
      return bytes;
    };
    Object.assign(bleTransport, {
      isAvailable: () => true,
      initialize: async () => {},
      connect: async () => {},
      disconnect: async () => {},
      read: async (_id, _service, characteristic) => {
        const bytes = new Uint8Array(characteristic.startsWith("4c4b0002") ? 10 : 16);
        const view = new DataView(bytes.buffer);
        if (characteristic.startsWith("4c4b0002")) {
          bytes[0] = 1;
          view.setUint16(2, 512, true);
          view.setUint32(4, (1 << 3) | (1 << 5), true);
        }
        if (characteristic.startsWith("4c4b0003")) {
          // The Linkr Device ID namespace; the app rejects any other board
          // advertising the same Management Service UUID.
          bytes.set([0x4c, 0x49, 0x4e, 0x4b, 0x52, 0x42, 0x4c, 0x45, 0x01, 0x00]);
        }
        if (characteristic.startsWith("4c4b0013")) {
          bytes[0] = 1;
          view.setUint16(2, 232, true);
          view.setUint32(4, 1, true);
          view.setUint32(8, 1, true);
        }
        return view;
      },
      startNotifications: async (id, _service, characteristic, callback) => {
        if (!characteristic.startsWith("4c4b0012")) return;
        window.serialNotifications.set(id, callback);
        const log = window.initialLogs.get(id);
        // The native notification callback can run before the subscription
        // promise completes. Exercise the actual parser and connection path.
        if (log) callback(window.serialFrame(log));
      },
    });
  });
});

test("Agent keeps serial evidence received before BLE subscription resolves", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { state, connect, agentJournal } = window.__initialLogTest;
    agentJournal.append(new TextEncoder().encode("previous device output"));
    state.device = { id: "first", name: "First" };
    window.initialLogs.set("first", "BOOT FAILURE: rootfs missing\r\nroot@bee:~# ");
    await connect();
    return { text: agentJournal.read().text, connected: state.connected, bytes: state.rxBytes };
  });
  expect(result).toEqual({
    text: "BOOT FAILURE: rootfs missing\r\nroot@bee:~# ", connected: true, bytes: 42,
  });
});

test("new BLE evidence excludes old logs and retired notification callbacks", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { state, connect, onDisconnected, agentJournal } = window.__initialLogTest;
    state.device = { id: "old", name: "Old" };
    window.initialLogs.set("old", "old boot\r\n");
    await connect();
    const oldCallback = window.serialNotifications.get("old");
    onDisconnected();
    oldCallback(window.serialFrame("late while disconnected\r\n", 2));
    const afterDisconnect = agentJournal.read().text;
    state.device = { id: "new", name: "New" };
    window.initialLogs.set("new", "new boot\r\n");
    await connect();
    oldCallback(window.serialFrame("old session contamination\r\n", 2));
    window.serialNotifications.get("new")(window.serialFrame("new session ready\r\n", 2));
    return { afterDisconnect, afterReconnect: agentJournal.read().text, connected: state.connected };
  });
  expect(result).toEqual({
    afterDisconnect: "old boot\r\n", afterReconnect: "new boot\r\nnew session ready\r\n", connected: true,
  });
});

test("BLE handshake retires an offline Agent before accepting new evidence", async ({ page }) => {
  let releaseModel;
  let modelStarted;
  const modelWaiting = new Promise((resolve) => { modelStarted = resolve; });
  const modelRelease = new Promise((resolve) => { releaseModel = resolve; });
  const modelRequests = [];
  await page.route("https://agent.test/v1/chat/completions", async (route) => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    modelRequests.push(route.request().postDataJSON());
    modelStarted();
    await modelRelease;
    const delta = { role: "assistant", tool_calls: [{ index: 0, id: "old-read", type: "function",
      function: { name: "read_serial_log", arguments: "{}" } }] };
    const chunk = (delta, finish_reason) => JSON.stringify({ id: "offline", object: "chat.completion.chunk",
      created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] });
    // If reconnect did not retire the old run, this delayed reply would read
    // the newly subscribed device and send its log in another model request.
    await route.fulfill({ status: 200, headers, contentType: "text/event-stream",
      body: `data: ${chunk(delta, null)}\n\ndata: ${chunk({}, "tool_calls")}\n\ndata: [DONE]\n\n` }).catch(() => {});
  });
  await page.locator("#agentButton").tap();
  await page.locator("#agentSettingsButton").tap();
  await page.locator("#agentEndpoint").fill("https://agent.test/v1");
  await page.locator("#agentModel").fill("test-model");
  await page.locator("#agentApiKey").fill("test-key");
  await page.locator("#agentSettingsSave").tap();
  await page.locator("#drawerClose").tap();
  await page.evaluate(() => {
    window.__initialLogTest.agentJournal.append(new TextEncoder().encode("OFFLINE_OLD_LOG\r\n"));
  });
  await page.locator("#agentQuestion").fill("Analyze the disconnected device log");
  await page.locator("#agentAsk").tap();
  await modelWaiting;
  await expect(page.locator("#agentStop")).toBeVisible();
  const oldGeneration = await page.evaluate(() => {
    const { state, connect, bleTransport } = window.__initialLogTest;
    const generation = state.writeGeneration;
    state.device = { id: "new", name: "New" };
    window.initialLogs.set("new", "NEW_DEVICE_ONLY\r\n");
    const subscribe = bleTransport.startNotifications;
    bleTransport.startNotifications = async (...args) => {
      await subscribe(...args);
      if (args[2].startsWith("4c4b0012")) {
        window.subscriptionWaiting = true;
        await new Promise((resolve) => { window.finishSubscription = resolve; });
      }
    };
    window.connectingForReview = connect();
    return generation;
  });
  try {
    await page.waitForFunction(() => window.subscriptionWaiting);
    const duringHandshake = await page.evaluate(() => ({
      generation: window.__initialLogTest.state.writeGeneration,
      connected: window.__initialLogTest.state.connected,
      log: window.__initialLogTest.agentJournal.read().text,
    }));
    expect(duringHandshake.connected).toBe(false);
    expect(duringHandshake.log).toBe("NEW_DEVICE_ONLY\r\n");
    expect(duringHandshake.generation).toBeGreaterThan(oldGeneration);
    await expect(page.locator("#agentStop")).toBeHidden();
    releaseModel();
    await page.evaluate(async () => { window.finishSubscription(); await window.connectingForReview; });
    expect(modelRequests).toHaveLength(1);
    expect(JSON.stringify(modelRequests)).not.toContain("NEW_DEVICE_ONLY");
    expect(await page.evaluate(() => window.__initialLogTest.agentJournal.read().text)).toBe("NEW_DEVICE_ONLY\r\n");
  } finally {
    releaseModel();
  }
});

test("WebSocket switches start fresh evidence and ignore retired socket events", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { state, connectWs, agentJournal } = window.__initialLogTest;
    const sockets = [];
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() { sockets.push(this); }
      close() { this.readyState = 3; }
      send() {}
    };
    state.mode = "ws";
    document.querySelector("#wsHostInput").value = "old.test";
    const first = connectWs();
    const old = sockets[0];
    // The bridge confirms LAN access before any terminal data is accepted, so a
    // socket that only fires onopen never lets connectWs() resolve.
    const openAndAuthorize = (socket) => {
      socket.onopen();
      socket.onmessage({ data: "@ws auth=none" });
    };
    openAndAuthorize(old);
    await first;
    old.onmessage({ data: "old network log\r\n" });
    old.onclose();
    document.querySelector("#wsHostInput").value = "new.test";
    const second = connectWs();
    const current = sockets[1];
    openAndAuthorize(current);
    await second;
    current.onmessage({ data: "new network log\r\n" });
    old.onmessage({ data: "late old network log\r\n" });
    old.onclose();
    return { text: agentJournal.read().text, connected: state.connected, currentSocket: state.ws === current };
  });
  expect(result).toEqual({ text: "new network log\r\n", connected: true, currentSocket: true });
});
