import { test, expect } from "@playwright/test";

/* Automatic reconnect after an unexpected link loss. The LAN transport is the
 * easiest to drive headlessly, and the state machine is transport-independent:
 * the BLE path goes through the same onDisconnected({unexpected:true}) entry. */

test.beforeEach(async ({ page }) => {
  await page.route("**/app.js?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: await response.text() +
        "\nwindow.__test = { state, connect, disconnect, onDisconnected, setConnected, " +
        "cancelAutoReconnect, autoReconnect, elements, renderAutoReconnectStatus, setBleTransport: value => Object.assign(bleTransport, value) };" ,
    });
  });
  await page.addInitScript(() => {
    /* A WebSocket the spec can fail or drop, standing in for the bridge. */
    window.__ws = { instances: [], mode: "ok" };
    const RealWebSocket = window.WebSocket;
    class FakeWebSocket {
      constructor(url, protocols) {
        // Vite uses WebSocket for HMR too; only mock the bridge under test.
        if (!String(url).includes("127.0.0.1:9999")) return new RealWebSocket(url, protocols);
        this.url = url;
        this.readyState = 0;
        this.closed = false;
        window.__ws.instances.push(this);
        /* One macrotask, so connectWs() has installed its handlers. */
        setTimeout(() => {
          if (this.closed) return;
          this.readyState = 1;
          this.onopen?.();
          if (window.__ws.mode === "ok") {
            this.onmessage?.({ data: "@ws auth=none" });
          } else if (window.__ws.mode === "fail") {
            this.onclose?.();
          }
        }, 0);
      }
      send(data) {
        this.lastSent = data;
      }
      close() {
        if (this.closed) return;
        this.closed = true;
        this.readyState = 3;
        setTimeout(() => this.onclose?.(), 0);
      }
    }
    window.WebSocket = FakeWebSocket;
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__test?.state.term);
  await page.evaluate(() => {
    /* Fast, deterministic schedule: three attempts at 10/20/30 ms. */
    window.__linkrReconnectDelays = [10, 20, 30];
    window.__test.state.mode = "ws";
    window.__test.state.ws = null;
    document.querySelector("#wsHostInput").value = "127.0.0.1:9999";
  });
});

async function connectLan(page) {
  await page.evaluate(async () => {
    await window.__test.connect();
  });
  await expect
    .poll(() => page.evaluate(() => window.__test.state.connected))
    .toBe(true);
}

async function dropLan(page) {
  await page.evaluate(() => {
    window.__ws.instances.at(-1).close();
  });
}

/** App messages are in the event log drawer now, never in the terminal. */
async function eventLogText(page) {
  const panel = page.locator("#eventLogPanel");
  if (await panel.isHidden()) {
    await page.locator("#eventLogBtn").click();
  }
  await expect(panel).toBeVisible();
  return panel.innerText();
}

for (const [width, label] of [[338, "Disconnect"], [521, "Cancel reconnect"], [320, "Cancel reconnect"]]) {
  test(`header actions stay reachable at ${width}px with ${label}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await connectLan(page);
    if (label === "Cancel reconnect") {
      await page.evaluate(() => { window.__linkrReconnectDelays = [60_000]; });
      await dropLan(page);
    }
    const action = page.locator("#mobileConnectBtn");
    const settings = page.locator("#panelToggle");
    await expect(action.locator(".btn-label")).toHaveText(label);
    if (await settings.getAttribute("aria-expanded") === "true") {
      await page.locator("#drawerClose").click();
    }

    for (const button of [action, settings]) {
      await expect(button).toBeInViewport({ ratio: 1 });
      await button.click({ trial: true });
    }
    await settings.click();
    await expect(settings).toHaveAttribute("aria-expanded", "true");
    await page.locator("#drawerClose").click();
    await action.click();
    await expect(action.locator(".btn-label")).toHaveText("Connect");
  });
}

test("an unexpected LAN drop reconnects automatically and keeps the log", async ({ page }) => {
  await connectLan(page);
  const before = await page.evaluate(() => window.__ws.instances.length);

  await dropLan(page);
  await expect
    .poll(() => page.evaluate(() => window.__ws.instances.length), { timeout: 5000 })
    .toBe(before + 1);
  await expect
    .poll(() => page.evaluate(() => window.__test.state.connected))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__test.autoReconnect.active))
    .toBe(false);
  const text = await eventLogText(page);
  expect(text).toContain("[reconnect]");
  expect(text).toContain("restored");
  await expect(page.locator("#mobileConnectBtn .btn-label")).toHaveText("Disconnect");
  /* The journal is not cleared by the reconnect. */
  expect(text).toContain("[connect]");
  /* The serial terminal never receives app log lines. */
  await expect(page.locator("#terminalOutput")).not.toContainText("[reconnect]");
});

test("auto-reconnect gives up after the configured attempts and offers the manual button", async ({ page }) => {
  await connectLan(page);
  await page.evaluate(() => {
    window.__ws.mode = "fail";
  });
  const before = await page.evaluate(() => window.__ws.instances.length);
  await dropLan(page);
  await expect
    .poll(() => page.evaluate(() => window.__test.autoReconnect.active), { timeout: 5000 })
    .toBe(false);
  const after = await page.evaluate(() => window.__ws.instances.length);
  /* The drop's own reconnect plus one dial per configured attempt. */
  expect(after).toBe(before + 3);
  await expect(page.locator("#connectButton .btn-label")).toHaveText(/Connect/i);
  const text = await eventLogText(page);
  expect(text).toContain("Automatic reconnect failed");
});

test("clicking the button while reconnecting cancels the schedule", async ({ page }) => {
  await connectLan(page);
  await page.evaluate(() => { window.__linkrReconnectDelays = [5000]; });
  const before = await page.evaluate(() => window.__ws.instances.length);
  await dropLan(page);
  await page.evaluate(() => {
    document.querySelector("#connectButton").click();
  });
  await expect
    .poll(() => page.evaluate(() => window.__test.autoReconnect.active))
    .toBe(false);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__ws.instances.length)).toBe(before);
  const text = await eventLogText(page);
  expect(text).toContain("cancelled");
});

test("a manual disconnect is not treated as a lost link", async ({ page }) => {
  await connectLan(page);
  const before = await page.evaluate(() => window.__ws.instances.length);
  await page.evaluate(async () => {
    await window.__test.disconnect();
  });
  await expect
    .poll(() => page.evaluate(() => window.__test.state.connected))
    .toBe(false);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__ws.instances.length)).toBe(before);
  const text = await eventLogText(page);
  expect(text).not.toContain("[reconnect]");
});

test("calling onDisconnected without the unexpected flag never schedules a retry", async ({ page }) => {
  await connectLan(page);
  const before = await page.evaluate(() => window.__ws.instances.length);
  await page.evaluate(() => {
    window.__test.onDisconnected();
  });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__test.autoReconnect.active)).toBe(false);
  expect(await page.evaluate(() => window.__ws.instances.length)).toBe(before);
});

test("BLE uses the restored device as the reconnect target and shows a cancel button", async ({ page }) => {
  await page.evaluate(() => {
    window.__linkrReconnectDelays = [5000];
    const { state, setConnected, onDisconnected } = window.__test;
    state.mode = "ble";
    state.device = { id: "AA:BB:CC:DD:EE:FF", name: "Linkr Bee 36E8" };
    state.nusReady = true;
    state.mgmtReady = true;
    setConnected(true);
    onDisconnected({ unexpected: true });
  });
  await expect
    .poll(() => page.evaluate(() => window.__test.autoReconnect.active))
    .toBe(true);
  await expect(page.locator("#connectButton .btn-label")).toHaveText(/Cancel reconnect/i);
  await page.evaluate(() => {
    window.__test.cancelAutoReconnect("cancelled by test");
  });
  expect(await page.evaluate(() => window.__test.autoReconnect.active)).toBe(false);
});


test("cancel stays available while the automatic LAN handshake is pending", async ({ page }) => {
  await connectLan(page);
  await page.evaluate(() => { window.__ws.mode = "hold"; });
  await dropLan(page);
  await expect.poll(() => page.evaluate(() => window.__ws.instances.length)).toBe(2);
  for (const id of ["connectButton", "mobileConnectBtn"]) {
    await expect(page.locator(`#${id}`)).toBeEnabled();
    await expect(page.locator(`#${id} .btn-label`)).toHaveText(/Cancel reconnect/i);
  }
  await page.evaluate(() => document.querySelector("#connectButton").click());
  await expect.poll(() => page.evaluate(() => window.__ws.instances.at(-1).closed)).toBe(true);
  await page.evaluate(() => window.__ws.instances.at(-1).onmessage?.({data: "@ws auth=none"}));
  expect(await page.evaluate(() => window.__test.state.connected)).toBe(false);
  expect(await page.evaluate(() => window.__test.autoReconnect.active)).toBe(false);
  await expect(page.locator("#connectButton")).toBeEnabled();
  // A new manual connection can succeed; callbacks from the retired socket cannot affect it.
  await page.evaluate(() => { window.__ws.mode = "ok"; });
  await connectLan(page);
  await page.evaluate(() => {
    window.__ws.instances[1].onclose?.();
    window.__ws.instances[1].onmessage?.({data: "@ws auth=ok"});
  });
  expect(await page.evaluate(() => window.__test.state.connected)).toBe(true);
});

for (const phase of ["connect", "subscribe"]) {
  test(`cancel discards a late native BLE ${phase} result`, async ({ page }) => {
    await page.evaluate((phase) => {
      const { state, setConnected, onDisconnected, setBleTransport } = window.__test;
      window.__ble = { disconnects: 0, connects: 0, entered: false };
      setBleTransport({
        isAvailable: () => true,
        initialize: async () => {},
        connect: async (_id, onDisconnect) => {
          window.__ble.connects++;
          window.__ble.onDisconnect = onDisconnect;
          if (phase === "connect") await new Promise(resolve => {
            window.__ble.entered = true; window.__ble.finish = resolve;
          });
        },
        // Exercise the legacy NUS path after discovery.
        read: async () => { throw new Error("No Services matching UUID"); },
        startNotifications: async (_id, _service, _characteristic, callback) => {
          window.__ble.notify = callback;
          await new Promise(resolve => {
            window.__ble.entered = true; window.__ble.finish = resolve;
          });
        },
        disconnect: async () => { window.__ble.disconnects++; window.__ble.onDisconnect?.(); },
      });
      state.mode = "ble";
      state.device = { id: "saved-bee", name: "Linkr Bee" };
      setConnected(true);
      onDisconnected({unexpected: true});
    }, phase);
    await page.waitForFunction(() => window.__ble.entered);
    await expect(page.locator("#connectButton")).toBeEnabled();
    await page.evaluate(() => document.querySelector("#mobileConnectBtn").click());
    expect(await page.evaluate(() => window.__test.autoReconnect.active)).toBe(false);
    await page.evaluate(() => {
      window.__ble.notify?.(new DataView(new TextEncoder().encode("STALE_NOTIFICATION").buffer));
      window.__ble.finish();
    });
    await expect.poll(() => page.evaluate(() => window.__ble.disconnects)).toBe(1);
    await expect(page.locator("#connectButton")).toBeEnabled();
    expect(await page.evaluate(() => window.__test.state.connected)).toBe(false);
    expect(await page.evaluate(() => window.__ble.connects)).toBe(1);
    expect(await page.locator("#terminalOutput").innerText()).not.toContain("STALE_NOTIFICATION");
  });
}

async function installUnavailableBee(page) {
  await page.evaluate(() => {
    const { state, setBleTransport } = window.__test;
    state.mode = "ble";
    state.device = { id: "original-bee", name: "Linkr Bee" };
    state.deviceRestored = true;
    window.__reselect = { requests: 0, connects: [], selection: "original-bee", failing: true };
    setBleTransport({
      isAvailable: () => true,
      initialize: async () => {},
      requestDevice: async () => {
        window.__reselect.requests++;
        if (window.__reselect.selection === "cancel") throw new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError");
        return { id: window.__reselect.selection, name: "Linkr Bee" };
      },
      connect: async (id) => {
        window.__reselect.connects.push(id);
        if (window.__reselect.failing) {
          const error = new Error("Bluetooth Device is no longer in range.");
          error.code = "BLE_RESELECT_REQUIRED";
          throw error;
        }
      },
      read: async () => { throw new Error("No Services matching UUID"); },
      startNotifications: async () => {},
      disconnect: async () => {},
    });
  });
}

test("unavailable BLE offers same-device reselection without a pairing warning", async ({ page }) => {
  await installUnavailableBee(page);
  await page.evaluate(() => window.__test.connect());
  await expect(page.locator("#mobileConnectBtn .btn-label")).toHaveText("Reselect device");
  await expect(page.locator("#connectButton .btn-label")).toHaveText("Reselect device");
  expect(await page.evaluate(() => window.__test.state.device.id)).toBe("original-bee");
  expect(await eventLogText(page)).not.toContain("If pairing failed");
  await page.evaluate(() => { window.__reselect.failing = false; });
  await page.locator("#mobileConnectBtn").click();
  await expect.poll(() => page.evaluate(() => window.__test.state.connected)).toBe(true);
  expect(await page.evaluate(() => window.__reselect.requests)).toBe(1);
  expect(await page.evaluate(() => window.__reselect.connects)).toEqual(["original-bee", "original-bee"]);
});

test("reselection cancellation or another Bee never changes the pinned target", async ({ page }) => {
  await installUnavailableBee(page);
  await page.evaluate(() => window.__test.connect());
  for (const selection of ["cancel", "other-bee"]) {
    await page.evaluate(selection => { window.__reselect.selection = selection; }, selection);
    await page.locator("#mobileConnectBtn").click();
    await expect(page.locator("#mobileConnectBtn .btn-label")).toHaveText("Reselect device");
    expect(await page.evaluate(() => window.__test.state.device.id)).toBe("original-bee");
    expect(await page.evaluate(() => window.__reselect.connects)).toEqual(["original-bee"]);
    expect(await page.evaluate(() => window.__test.state.connected)).toBe(false);
  }
  await expect.poll(() => eventLogText(page)).toContain("That is a different Bee");
});

test("background rediscovery failure stops retries without opening a chooser", async ({ page }) => {
  await installUnavailableBee(page);
  await page.evaluate(() => {
    window.__test.setConnected(true);
    window.__test.onDisconnected({ unexpected: true });
  });
  await expect(page.locator("#mobileConnectBtn .btn-label")).toHaveText("Reselect device");
  expect(await page.evaluate(() => window.__test.autoReconnect.active)).toBe(false);
  expect(await page.evaluate(() => window.__reselect.requests)).toBe(0);
  expect(await page.evaluate(() => window.__reselect.connects)).toEqual(["original-bee"]);
});

test("a pairing refusal during automatic reconnect stops the retries", async ({ page }) => {
  /* The Bee refuses pairing until its key is pressed. Dialling again cannot
   * recover the link, so the loop must stop and leave Connect to the user. */
  await page.evaluate(() => {
    const { state, setConnected, onDisconnected, setBleTransport } = window.__test;
    window.__ble = { connects: 0 };
    setBleTransport({
      isAvailable: () => true,
      initialize: async () => {},
      connect: async () => { window.__ble.connects++; },
      read: async () => { throw new Error("Insufficient authentication"); },
      disconnect: async () => {},
    });
    state.mode = "ble";
    state.device = { id: "AA:BB:CC:DD:EE:FF", name: "Linkr Bee 36E8" };
    setConnected(true);
    onDisconnected({ unexpected: true });
  });
  await expect
    .poll(() => page.evaluate(() => window.__test.autoReconnect.active), { timeout: 5000 })
    .toBe(false);
  expect(await page.evaluate(() => window.__ble.connects)).toBe(1);
  await expect(page.locator(".toast").filter({ hasText: /pairing key|配对键/i })).toBeVisible();
  await expect(page.locator("#connectButton")).toBeEnabled();
  const text = await eventLogText(page);
  expect(text).toContain("Automatic reconnect stopped");
});

for (const failure of [
  { stage: "read", message: "GATT operation timed out" },
  { stage: "read", message: "GATT Server is disconnected" },
  { stage: "connect", message: "GATT Server is disconnected" },
  { stage: "read", name: "SecurityError", message: "Access to the service is blocked by browser policy" },
]) {
  test(`non-pairing ${failure.stage} failure keeps retries: ${failure.message}`, async ({ page }) => {
    await page.evaluate((failure) => {
      const { state, setConnected, onDisconnected, setBleTransport } = window.__test;
      window.__ble = { connects: 0 };
      const fail = () => { throw Object.assign(new Error(failure.message), { name: failure.name || "NetworkError" }); };
      setBleTransport({
        isAvailable: () => true,
        initialize: async () => {},
        connect: async () => { window.__ble.connects++; if (failure.stage === "connect") fail(); },
        read: async () => fail(),
        disconnect: async () => {},
      });
      state.mode = "ble";
      state.device = { id: "AA:BB:CC:DD:EE:FF", name: "Linkr Bee 36E8" };
      setConnected(true);
      onDisconnected({ unexpected: true });
    }, failure);
    await expect.poll(() => page.evaluate(() => window.__ble.connects)).toBe(3);
    await expect.poll(() => page.evaluate(() => window.__test.autoReconnect.active)).toBe(false);
    const text = await eventLogText(page);
    expect(text).toMatch(/Automatic reconnect failed after\s+3 attempts/);
    expect(text).not.toContain("Automatic reconnect stopped");
    expect(text).not.toContain("Pairing was refused");
    await expect(page.locator(".toast").filter({ hasText: /Pairing was refused|配对被拒绝/i })).toHaveCount(0);
    await expect(page.locator("#connectButton")).toBeEnabled();
  });
}
