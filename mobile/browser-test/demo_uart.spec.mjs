import { test, expect } from "@playwright/test";

/* The hardware-free demo has no GATT characteristics. Typed input used to be
 * dropped with "[error] UART RX characteristic is not ready", which also meant
 * `?demo=board` could not stand in for a full-screen program. A desktop
 * viewport keeps the settings panel beside the terminal. */

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

test("the demo board echoes typed input instead of a missing-characteristic error", async ({ page }) => {
  // A desktop viewport keeps the settings panel beside the terminal instead of
  // covering it, so the keystrokes land where a person would put them.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?demo=board");
  await expect(page.locator("#statusText")).toContainText(/Connected|已连接/);

  await page.locator(".xterm-screen").click();
  await page.keyboard.type("echo hello from the demo");
  await page.keyboard.press("Enter");

  // The mock board echoes through the same output path a real board uses.
  await expect(page.locator("#terminalOutput")).toContainText("echo hello from the demo");
  await expect(page.locator("#terminalOutput")).not.toContainText("UART RX characteristic is not ready");
});
