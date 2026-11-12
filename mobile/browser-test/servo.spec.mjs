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
  await page.locator("#readParams").click();
  await expect(page.locator("#paramsHint")).toContainText("Read 22 registers");
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
  await page.waitForFunction(() => (window.__servoBench?.servos.size || 0) === 6);
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
  await page.locator("#readParams").click();
  await expect(page.locator("#paramsHint")).toContainText("Read 22 registers");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#saveParams").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/STS3215_ID1\.json/);
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
