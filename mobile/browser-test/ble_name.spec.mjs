import { test, expect } from "@playwright/test";

/* The advertised BLE name is a label the owner can change, so nothing may
 * decide what a board is by the name it carries: the board is found by the
 * service it speaks, identified by the id it was seen under, and *named* by
 * the answer it gives to `@n?`. These tests drive the shipped app. */

async function openApp(page) {
  await page.route("**/app.js?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() +
      "\nwindow.__test = { state, connect, bleTransport, restoreAuthorizedDevice," +
      " setControl: fn => { sendControl = fn; }, feedManagementText };" });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__test?.state.term);
}

/* A board as the app sees it: Management API v1 with the Device ID and
 * Reliable UART capabilities, a 16-byte Device ID, and the Reliable UART
 * state a current firmware advertises. The bytes are built inside the page:
 * a typed array cannot cross the test bridge intact. */
async function mockBoard(page, { name = "Linkr Bee 078C", id = "bee-1", readError = null } = {}) {
  return page.evaluate(async ({ name, id, readError }) => {
    const { bleTransport } = window.__test;
    const protocol = new Uint8Array([1, 0, 0, 2, 40, 0, 0, 0, 0, 0]);
    const deviceId = new Uint8Array([
      0x4c, 0x49, 0x4e, 0x4b, 0x52, 0x42, 0x4c, 0x45, 0x01, 0x00, 0, 0, 0, 0, 0, 0,
    ]);
    const reliable = new Uint8Array([1, 0, 232, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    Object.assign(bleTransport, {
      isAvailable: () => true,
      initialize: async () => {},
      requestDevice: async () => ({ id, name }),
      connect: async () => {},
      read: async (_id, _service, characteristic) => {
        if (readError) {
          throw new Error(readError);
        }
        if (characteristic.startsWith("4c4b0002")) {
          return new DataView(protocol.buffer);
        }
        if (characteristic.startsWith("4c4b0003")) {
          return new DataView(deviceId.buffer);
        }
        if (characteristic.startsWith("4c4b0013")) {
          return new DataView(reliable.buffer);
        }
        return new DataView(new Uint8Array(0).buffer);
      },
      write: async () => {},
      startNotifications: async () => {},
      stopNotifications: async () => {},
      disconnect: async () => {},
    });
    window.__test.setControl(async (command) => {
      if (command === "@n?") {
        return "OK name=测试😀 custom=yes";
      }
      return "OK";
    });
  }, { name, id, readError });
}

test("the name the board reports is the name the page shows", async ({ page }) => {
  await openApp(page);
  await mockBoard(page);
  await page.evaluate(async () => {
    const { state, connect } = window.__test;
    state.device = null;
    await connect();
  });
  await expect(page.locator("#deviceName")).toHaveText("测试😀");
  await expect(page.locator("#bleNameStatus")).toContainText("测试😀");
  await expect(page.locator("#bleNameInput")).toHaveValue("测试😀");
});

test("set and restore show the name the board reads back", async ({ page }) => {
  await openApp(page);
  await mockBoard(page);
  await page.evaluate(async () => {
    const { state, connect } = window.__test;
    state.device = null;
    await connect();
    let current = "Original";
    let custom = false;
    const seen = [];
    window.__test.setControl(async (command) => {
      seen.push(command);
      if (command === "@n?") {
        return `OK name=${current} custom=${custom ? "yes" : "no"}`;
      }
      if (command === "@n default") {
        current = "Linkr Bee 078C";
        custom = false;
        return `OK name=${current}`;
      }
      current = command.slice(3);
      custom = true;
      return `OK name=${current}`;
    });
    window.__seenCommands = seen;
  });
  await page.locator("#panelToggle").tap();
  await expect(page.locator("#controlsPanel #bleNameInput")).toBeVisible();
  await page.fill("#bleNameInput", "Bench Bee");
  await page.click("#bleNameSetButton");
  await expect(page.locator("#bleNameInput")).toHaveValue("Bench Bee");
  await expect(page.locator("#bleNameStatus")).toContainText("Bench Bee");
  await page.click("#bleNameDefaultButton");
  await expect(page.locator("#bleNameInput")).toHaveValue("Linkr Bee 078C");
  await expect(page.locator("#bleNameStatus")).toContainText("Linkr Bee 078C");
  expect(await page.evaluate(() => window.__seenCommands)).toEqual([
    "@n=Bench Bee",
    "@n?",
    "@n default",
    "@n?",
  ]);
});

test("a rename the board does not read back is not a success", async ({ page }) => {
  await openApp(page);
  await mockBoard(page);
  await page.evaluate(async () => {
    const { state, connect } = window.__test;
    state.device = null;
    await connect();
    // The write echoes the requested name; the authoritative read reports
    // another one, which is the only state the page may show.
    window.__test.setControl(async (command) =>
      command === "@n?" ? "OK name=Different custom=yes" : "OK name=Requested");
  });
  await page.locator("#panelToggle").tap();
  await expect(page.locator("#controlsPanel #bleNameInput")).toBeVisible();
  await page.fill("#bleNameInput", "Requested");
  await page.click("#bleNameSetButton");
  await expect(page.locator("#bleNameInput")).toHaveValue("Different");
  await expect(page.locator("#bleNameStatus")).toContainText(
    "Could not read the BLE name.",
  );
  await expect(page.locator(".toast").filter({ hasText: "BLE name updated" }))
    .toHaveCount(0);
});

test("a board wearing a legacy name is not taken for a legacy board", async ({ page }) => {
  /* The name is the owner's to choose, so a current board can carry the
   * legacy name. What separates a legacy board is the service it does not
   * have — and a refused read is a pairing problem, not an old board. */
  await openApp(page);
  await mockBoard(page, { name: "Linkr BLE UART-1", readError: "Insufficient authentication" });
  const result = await page.evaluate(async () => {
    const { state, connect } = window.__test;
    state.device = null;
    await connect().catch(() => {});
    return { connected: state.connected, legacy: state.legacy };
  });
  expect(result.connected).toBe(false);
  expect(result.legacy).toBe(false);
  await expect(page.locator(".toast").filter({ hasText: "GPIO1" })).toBeVisible();
});

test("a board is restored by the id it was seen under", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const { state, bleTransport, restoreAuthorizedDevice } = window.__test;
    localStorage.setItem("linkr-last-device-id", "bee-7");
    const seen = [];
    Object.assign(bleTransport, {
      isAvailable: () => true,
      getDevices: async (ids) => {
        seen.push(ids);
        /* Two boards the browser still knows: the one that was seen under
         * the stored id, and one that happens to carry a Linkr name. */
        return [
          { id: "bee-7", name: "测试😀" },
          { id: "bee-9", name: "Linkr Bee 078C" },
        ];
      },
    });
    await restoreAuthorizedDevice();
    return { seen, device: state.device && state.device.id };
  });
  expect(result.seen.length).toBeGreaterThan(0);
  expect(result.device).toBe("bee-7");
});
