import { test, expect } from "@playwright/test";

/* App-level messages (connection state, [demo] startup lines, reconnect and
 * error notices) used to be written into the serial terminal. They now live in
 * a separate Event log drawer, so a full-screen program on the target never
 * receives injected text. */

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("linkr-lang", "en"));
});

test("app log lines stay out of the serial terminal and appear in the event log", async ({ page }) => {
  await page.goto("/?demo=board");
  await expect(page.locator("#statusText")).toContainText(/Connected/);

  const terminal = page.locator("#terminalOutput");
  // The demo writes app log lines; none of them may reach xterm.
  await expect(terminal).not.toContainText("[demo]");
  await expect(terminal).not.toContainText("Linkr Bee Terminal ready");

  // While closed, the toggle shows a quiet unread dot (no counts).
  const toggle = page.locator("#eventLogBtn");
  await expect(toggle).toBeVisible();
  const dot = page.locator("#eventLogDot");
  await expect(dot).toBeVisible();
  await expect(dot).not.toHaveText(/\d/);

  await toggle.click();
  await expect(dot).toBeHidden();
  const panel = page.locator("#eventLogPanel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("[demo]");
  await expect(panel).toContainText(/connected over a mock management channel/);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // Clear empties the drawer only; the serial terminal is untouched.
  await page.locator("#eventLogClear").click();
  await expect(panel).toContainText("No events yet");
  await expect(terminal).not.toContainText("[demo]");

  // Escape closes the drawer and returns focus to its toggle.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("the event log drawer can be resized by drag and keyboard, and remembers its height", async ({ page }) => {
  await page.goto("/?demo=board");
  const toggle = page.locator("#eventLogBtn");
  await expect(toggle).toBeVisible();
  await toggle.click();
  const panel = page.locator("#eventLogPanel");
  await expect(panel).toBeVisible();
  const handle = page.locator("#eventLogResize");
  await expect(handle).toBeVisible();

  const initial = (await panel.boundingBox()).height;
  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  const grown = (await panel.boundingBox()).height;
  expect(grown).toBeGreaterThan(initial + 30);
  await page.keyboard.press("ArrowDown");
  const shrunk = (await panel.boundingBox()).height;
  expect(shrunk).toBeLessThan(grown);

  // Drag the grabber upward: the drawer grows, and the height survives a reload.
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 60, { steps: 5 });
  await page.mouse.up();
  const dragged = (await panel.boundingBox()).height;
  expect(dragged).toBeGreaterThan(shrunk);

  await page.reload();
  await page.locator("#eventLogBtn").click();
  await expect(page.locator("#eventLogPanel")).toBeVisible();
  const restored = (await page.locator("#eventLogPanel").boundingBox()).height;
  expect(Math.abs(restored - dragged)).toBeLessThan(2);

  // The terminal head stays visible above the drawer.
  const card = await page.locator("#terminalCard").boundingBox();
  const panelBox = await page.locator("#eventLogPanel").boundingBox();
  expect(panelBox.y).toBeGreaterThan(card.y + 40);
  await expect(page.locator("#terminalOutput")).toBeVisible();
});
