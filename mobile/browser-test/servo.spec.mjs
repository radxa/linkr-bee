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
  expect(errors).toEqual([]);
});

test("register read, move and servo selection hit the bus", async ({ page }) => {
  await page.goto(`${base}/servo.html?demo=servo&lang=en&theme=dark`);
  await page.locator("#readParams").click();
  await expect(page.locator("#paramsHint")).toContainText("Read 22 registers");
  const modelCell = page
    .locator("#paramRows tr")
    .filter({ has: page.locator("td", { hasText: /^model$/ }) })
    .locator("td")
    .nth(2);
  await expect(modelCell).toHaveText("777");

  await page.locator("#targetInput").fill("1024");
  await page.locator("#moveButton").click();
  await expect(page.locator("#logList")).toContainText("Moved to 1024");
  await expect(page.locator("#positionValue")).toHaveText("1024");

  await page.locator(".servo-list-item").nth(1).click();
  await expect(page.locator("#selectedId")).toHaveText("002");
  await expect(page.locator("#positionValue")).toHaveText("2048");
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
