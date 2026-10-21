import { test, expect } from "@playwright/test";

/* The terminal settings card offers the common line rates as a select instead of
 * asking users to edit the first field of the raw UART string. The raw string is
 * still authoritative: a preset rewrites only the baud field of
 * "baud,data,parity,stop,flow", and a hand-edited rate moves the select back. */

async function openTerminalSettings(page) {
  await page.goto("/");
  await page.locator("#panelToggle").tap();
  await page.locator('[data-settings-target="terminal"]').tap();
  await expect(page.locator("#baudSelect")).toBeVisible();
}

test("a baud preset updates the UART string and keeps the frame settings", async ({ page }) => {
  await openTerminalSettings(page);
  await expect(page.locator("#uartInput")).toHaveValue("115200,8,n,1,n");

  await page.locator("#baudSelect").selectOption("9600");
  await expect(page.locator("#uartInput")).toHaveValue("9600,8,n,1,n");
  await expect(page.locator("#baudLabel")).toHaveText("9600");

  // Data bits, parity, stop bits and flow are not a preset's business.
  await page.locator("#uartInput").fill("57600,7,e,2,rtscts");
  await page.locator("#uartInput").press("Tab");
  await page.locator("#baudSelect").selectOption("1500000");
  await expect(page.locator("#uartInput")).toHaveValue("1500000,7,e,2,rtscts");
});

test("a custom rate opens the numeric field, validates, and persists", async ({ page }) => {
  await openTerminalSettings(page);
  await page.locator("#baudSelect").selectOption("custom");
  await expect(page.locator("#baudCustomField")).toBeVisible();

  await page.locator("#baudCustomInput").fill("2000000");
  await expect(page.locator("#uartInput")).toHaveValue("2000000,8,n,1,n");
  await expect(page.locator("#baudCustomInput")).toHaveAttribute("aria-invalid", "false");

  // Outside the firmware's 300–3000000 range: flagged, and the last valid value stays.
  await page.locator("#baudCustomInput").fill("100");
  await expect(page.locator("#baudCustomInput")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#uartInput")).toHaveValue("2000000,8,n,1,n");

  await page.reload();
  await expect(page.locator("#baudSelect")).toHaveValue("custom");
  await expect(page.locator("#baudCustomInput")).toHaveValue("2000000");
});

test("a hand-edited preset rate moves the select, and the label is translated", async ({ page }) => {
  await openTerminalSettings(page);
  await page.locator("#uartInput").fill("9600,8,n,1,none");
  await page.locator("#uartInput").press("Tab");
  await expect(page.locator("#baudSelect")).toHaveValue("9600");
  await expect(page.locator("#baudCustomField")).toBeHidden();

  await page.locator("#baudSelect").selectOption("custom");
  // The browser's own language decides the starting locale, so assert the
  // translation the switch is supposed to land on rather than a fixed one.
  const before = await page.evaluate(() => document.documentElement.lang);
  await page.locator("#drawerLangButton").tap();
  await expect(page.locator("html")).toHaveAttribute("lang", before === "zh-CN" ? "en" : "zh-CN");
  await expect(page.locator('label[for="baudSelect"]')).toHaveText(before === "zh-CN" ? "Baud rate" : "波特率");
  await expect(page.locator('#baudSelect option[value="custom"]')).toHaveText(before === "zh-CN" ? "Custom…" : "自定义…");
});
