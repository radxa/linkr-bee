import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/* The servo bench is a second plain-hosting page (no bundler): it imports the
 * shared BLE transport, management framing and the FEETECH protocol module
 * directly. This spec drives it in `?demo=servo` mode, where a loopback bus
 * replaces the Bee, so the page's protocol and DOM are exercised without
 * hardware or Web Bluetooth. */

const base = "http://127.0.0.1:8767";
const serverScript = fileURLToPath(new URL("./static-server.mjs", import.meta.url));
const webRoot = fileURLToPath(new URL("../../web", import.meta.url));

test.describe.configure({ mode: "serial" });

let server = null;

async function reachable() {
  try {
    const response = await fetch(`${base}/servo.html`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  if (await reachable()) return;
  server = spawn(process.execPath, [serverScript, "8767", webRoot], { stdio: "ignore" });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await reachable()) return;
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  server?.kill();
  server = null;
  throw new Error(`servo bench server never answered on ${base}`);
});

test.afterAll(() => {
  server?.kill();
});

test("the demo bus fills the servo list and live values", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await expect(page.locator("#linkStateText")).toContainText("Simulated bus");
  await expect(page.locator(".servo-list-item")).toHaveCount(6);
  await expect(page.locator("#selectedId")).toHaveText("001");
  await expect(page.locator("#positionValue")).toHaveText("2048");
  await expect(page.locator("#connectButton")).toBeHidden();
  await expect(page.locator("#chartCanvas")).toBeVisible();
  await expect(page.locator("#chartLegend label")).toHaveCount(6);
  expect(errors).toEqual([]);
});

test("register read, move and servo selection hit the bus", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await page.locator("#tabProgram").click();
  // Entering the page reads the selected servo automatically.
  await expect(page.locator("#paramsHint")).toContainText("Read 22 registers");
  await expect(page.locator("#saveParams")).toBeEnabled();
  const modelCell = page
    .locator("#paramRows tr")
    .filter({ has: page.locator("td", { hasText: /^model$/ }) })
    .locator("td")
    .nth(2);
  await expect(modelCell).toHaveText("STS3215 (9/3)");

  await page.locator("#tabBench").click();
  await page.locator("#targetInput").fill("1024");
  await page.locator("#moveButton").click();
  await expect(page.locator("#logList")).toContainText("Moved to 1024");
  await expect(page.locator("#positionValue")).toHaveText("1024");

  await page.locator(".servo-list-item").nth(1).click();
  await expect(page.locator("#selectedId")).toHaveText("002");
  await expect(page.locator("#positionValue")).toHaveText("2048");
});

test("async write queues the goal and Run async applies it", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await page.locator('input[name="writeMode"][value="async"]').check();
  await page.locator("#targetInput").fill("1500");
  await page.locator("#moveButton").click();
  await expect(page.locator("#moveHint")).toContainText("queued");
  await expect(page.locator("#positionValue")).toHaveText("2048");
  await page.locator("#asyncExecute").click();
  await expect(page.locator("#positionValue")).toHaveText("1500");
});

test("the chart collects samples and the auto step test ends at the end point", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await page.waitForFunction(() => (window.__servoBench?.chart.samples.length || 0) > 2);
  const samples = await page.evaluate(() => window.__servoBench.chart.samples.length);
  expect(samples).toBeGreaterThan(2);

  await page.locator("#autoStart").fill("500");
  await page.locator("#autoEnd").fill("900");
  await page.locator("#autoSteps").fill("2");
  await page.locator("#autoStepDelay").fill("10");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#autoStep").click();
  await expect(page.locator("#logList")).toContainText("Auto test finished");
  await expect(page.locator("#positionValue")).toHaveText("900");
});

test("all torque off broadcasts a sync write to every scanned servo", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await expect(page.locator("#torqueAllOff")).toBeEnabled();
  await page.locator("#torqueAllOff").click();
  await expect(page.locator("#logList")).toContainText("Torque released on 6 servo");
});

test("an SCS model switches range, register map and motor mode", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await page.waitForFunction(
    () => (window.__servoBench?.servos.size || 0) === 6 && !window.__servoBench.scanBusy,
  );
  await page.locator('.servo-list-item[data-id="6"]').click();
  await expect(page.locator("#selectedModel")).toContainText("SCS0009");
  await expect(page.locator("#positionMax")).toHaveText("/ 1023");
  await expect(page.locator("#wheelButton")).toHaveText("Motor mode");
  await expect(page.locator("#calibrateButton")).toBeDisabled();
  await page.locator("#tabProgram").click();
  await expect(page.locator("#paramRows tr")).toHaveCount(19);
  const lockRow = page
    .locator("#paramRows tr")
    .filter({ has: page.locator("td", { hasText: /^lock$/ }) })
    .locator("td")
    .first();
  await expect(lockRow).toHaveText("48");

  await page.locator("#tabBench").click();
  await page.locator("#targetInput").fill("700");
  await page.locator("#moveButton").click();
  await expect(page.locator("#positionValue")).toHaveText("700");
  await page.locator("#wheelSpeed").fill("-300");
  await page.locator("#wheelButton").click();
  await expect(page.locator("#logList")).toContainText("Motor mode: -300");
});

test("factory reset is available and re-reads the servo", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await page.locator("#tabProgram").click();
  await expect(page.locator("#selectedId")).toHaveText("001");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#factoryReset").click();
  await expect(page.locator("#logList")).toContainText("Factory-restore instruction sent");
  await expect(page.locator("#selectedId")).toHaveText("001");
});

test("chart zoom, offset and manual bounds drive the view", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await page.waitForFunction(() => (window.__servoBench?.chart.samples.length || 0) > 3);
  await page.evaluate(() => {
    const zoom = document.querySelector("#chartZoom");
    zoom.value = "2";
    zoom.dispatchEvent(new Event("input", { bubbles: true }));
    const pan = document.querySelector("#chartPan");
    pan.value = "40";
    pan.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#chartYChannel").selectOption("position");
  await page.locator("#chartUpper").fill("3000");
  await page.locator("#chartLower").fill("1000");
  await page.waitForTimeout(200);
  const view = await page.evaluate(() => ({
    zoom: window.__servoBench.chart.zoom,
    pan: window.__servoBench.chart.pan,
    channel: window.__servoBench.chart.yChannel,
    bounds: window.__servoBench.chart.bounds,
    pixels: document.querySelector("#chartCanvas").width,
  }));
  expect(view.zoom).toBe(2);
  expect(view.pan).toBe(40);
  expect(view.channel).toBe("position");
  expect(view.bounds).toEqual({ min: 1000, max: 3000 });
  expect(view.pixels).toBeGreaterThan(0);

  await page.locator("#chartAuto").click();
  await expect(page.locator("#chartUpper")).toHaveValue("");
  await expect(page.locator("#chartLower")).toHaveValue("");
  const reset = await page.evaluate(() => ({
    zoom: window.__servoBench.chart.zoom,
    pan: window.__servoBench.chart.pan,
    bounds: window.__servoBench.chart.bounds,
  }));
  expect(reset).toEqual({ zoom: 1, pan: 0, bounds: null });
});

test("parameter save downloads a JSON file with the EEPROM map", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await page.locator("#tabProgram").click();
  await expect(page.locator("#paramsHint")).toContainText("Read 22 registers");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#saveParams").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/STS3215_ID1\.json/);
});

/* A real Web Bluetooth read hands the page a DataView. The page used to wrap
 * that in `new Uint8Array(view)`, which is empty, and reported "unsupported
 * Management v1" on a perfectly good Bee. Drive the connect path with a fake
 * transport that returns the same shapes. */
test("the connect handshake claims control and parses the management protocol", async ({ page }) => {
  await page.addInitScript(() => {
    const MGMT_COMMAND = "4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001";
    const MGMT_RESPONSE = "4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001";
    const MGMT_PROTOCOL = "4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001";
    const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
    const encoder = new TextEncoder();
    class FakeTransport {
      constructor() {
        this.mgmtCallback = null;
        this.uartCallback = null;
        this.frame = new Uint8Array(0);
        this.owner = "0";
        this.uart = "115200,8,N,1,none";
      }
      async initialize() {}
      async requestDevice() { return { id: "fake-bee", name: "Linkr Bee fake" }; }
      async connect() {}
      async disconnect() {}
      async read(_id, _service, characteristic) {
        if (characteristic === MGMT_PROTOCOL) {
          return new DataView(Uint8Array.from([1, 0, 0, 2, 0xbf, 0, 0, 0, 0, 0]).buffer);
        }
        return new DataView(new ArrayBuffer(0));
      }
      async write(_id, _service, characteristic, value) {
        if (characteristic !== MGMT_COMMAND) return;
        const chunk = value instanceof Uint8Array
          ? value
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const merged = new Uint8Array(this.frame.length + chunk.length);
        merged.set(this.frame, 0);
        merged.set(chunk, this.frame.length);
        this.frame = merged;
        if (this.frame.length < 12) return;
        const requestId = this.frame[4] | (this.frame[5] << 8) | (this.frame[6] << 16) | (this.frame[7] << 24);
        const length = this.frame[8] | (this.frame[9] << 8);
        if (this.frame.length < 12 + length) return;
        const command = new TextDecoder().decode(this.frame.slice(12, 12 + length));
        this.frame = new Uint8Array(0);
        let reply;
        if (command.startsWith("@u=")) {
          this.uart = command.slice(3);
          reply = `OK uart=${this.uart}\r\n`;
        } else if (command === "@u?") {
          reply = `OK uart=${this.uart}\r\n`;
        } else if (command === "@c claim") {
          this.owner = "2";
          reply = "OK control self=2 owner=2 mode=control epoch=2\r\n";
        } else if (command === "@c release") {
          this.owner = "0";
          reply = "OK control self=2 owner=0 mode=available epoch=3\r\n";
        } else if (command === "@c?") {
          reply = this.owner === "2"
            ? "OK control self=2 owner=2 mode=control epoch=2\r\n"
            : "OK control self=2 owner=0 mode=available epoch=1\r\n";
        } else {
          reply = "ERR unknown command\r\n";
        }
        queueMicrotask(() => {
          const payload = encoder.encode(reply);
          const frame = new Uint8Array(12 + payload.length);
          frame.set([0x4c, 0x4b, 1, 2]);
          const view = new DataView(frame.buffer);
          view.setUint32(4, requestId, true);
          view.setUint16(8, payload.length, true);
          frame.set(payload, 12);
          this.mgmtCallback?.(new DataView(frame.buffer));
        });
      }
      async startNotifications(_id, _service, characteristic, callback) {
        if (characteristic === MGMT_RESPONSE) this.mgmtCallback = callback;
        else if (characteristic === NUS_TX) this.uartCallback = callback;
      }
    }
    window.__fakeTransport = new FakeTransport();
  });

  await page.goto(`${base}/servo.html?lang=en&theme=dark`);
  // ble_transport.js installs the browser transport when the page loads; swap
  // the fake in only after it has run.
  await page.evaluate(() => { window.LinkrBleTransport = window.__fakeTransport; });
  await page.locator("#connectButton").click();
  await expect(page.locator("#logList")).toContainText("Console control claimed", { timeout: 15000 });
  await expect(page.locator("#logList")).not.toContainText("Management v1");
  await expect(page.locator("#linkStateText")).toContainText("Linkr Bee fake");
  await expect(page.locator("#scanHint")).toContainText("No servo", { timeout: 15000 });
  await page.locator("#disconnectButton").click();
  await expect(page.locator("#linkStateText")).toContainText("Disconnected");
});

test("the phone layout has no horizontal overflow and the language toggles", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=zh&theme=dark`);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await expect(page.locator("#selectedModel")).toContainText("STS3215");
  await page.locator("#servoLangButton").click();
  await expect(page.locator("h1")).toHaveText("Servo bench");
  await page.locator("#servoThemeButton").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("the terminal links to the bench from the rail and About", async ({ page }) => {
  await page.goto(`${base}/index.html?demo=board`);
  await expect(page.locator('a.rail-btn[href="./servo.html"]')).toHaveCount(1);
  await expect(page.locator("#aboutServoTool")).toHaveAttribute("href", "./servo.html");
});
