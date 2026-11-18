import { test, expect } from "@playwright/test";

/* App-level messages (connection state, [demo] startup lines, reconnect and
 * error notices) used to be written into the serial terminal. They now live in
 * a separate Event log drawer, so a full-screen program on the target never
 * receives injected text. */

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("linkr-lang", "en"));
});

test.describe('event log in native keyboard layouts', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('an expanded drawer shrinks with the card and restores the preferred height', async ({ page }) => {
    await page.addInitScript(() => { window.LinkrNativeBle = { platform: 'android' }; });
    await page.route('**/app.js?*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: await response.text() +
        '\nwindow.__eventLogTest = { state, setMobileSidebarOpen };' });
    });
    await page.goto('/?demo=board');
    await page.waitForFunction(() => window.__eventLogTest?.state.termReady);
    await page.evaluate(() => window.__eventLogTest.setMobileSidebarOpen(false, { restoreFocus: false }));
    await page.locator('#eventLogBtn').click();
    await page.locator('#eventLogResize').focus();
    await page.keyboard.press('End');
    const panel = page.locator('#eventLogPanel');
    const preferred = (await panel.boundingBox()).height;
    const saved = await page.evaluate(() => localStorage.getItem('linkr-event-log-height'));

    const headerIsAccessible = () => page.evaluate(() => {
      const card = document.getElementById('terminalCard').getBoundingClientRect();
      const head = document.querySelector('#terminalCard > .terminal-head').getBoundingClientRect();
      const log = document.getElementById('eventLogPanel').getBoundingClientRect();
      const close = document.getElementById('eventLogClose').getBoundingClientRect();
      return log.top >= head.bottom && log.bottom <= card.bottom + 1 && close.top >= 0;
    });
    await page.evaluate(() => {
      window.__eventLogTest.state.term.focus();
      Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 350 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await expect(page.locator('html')).toHaveClass(/soft-keyboard-open/);
    await expect.poll(headerIsAccessible).toBe(true);
    expect((await panel.boundingBox()).height).toBeLessThan(preferred);
    expect(await page.evaluate(() => localStorage.getItem('linkr-event-log-height'))).toBe(saved);

    await page.evaluate(() => {
      delete visualViewport.height;
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await expect(page.locator('html')).not.toHaveClass(/soft-keyboard-open/);
    await expect.poll(async () => Math.abs((await panel.boundingBox()).height - preferred)).toBeLessThan(2);
    // Opening Agent changes the card height without a window resize event.
    await page.locator('#agentButton').click();
    /* A phone opens the assistant alone, which hides the terminal card and the
     * drawer inside it. Ask for the split first: a hidden card would satisfy
     * headerIsAccessible trivially (every rect measures zero) while the close
     * button cannot be clicked at all. */
    await page.locator('#agentToggleTerminal').click();
    await expect(page.locator('#terminalCard')).toBeVisible();
    await expect.poll(headerIsAccessible).toBe(true);
    await page.locator('#eventLogClose').click();
    await expect(panel).toBeHidden();
  });
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
