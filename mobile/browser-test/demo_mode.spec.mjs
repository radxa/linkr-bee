import { test, expect } from "@playwright/test";

/* `?demo=board` is the hardware-free preview: a mock Linkr Bee X1.0 answers the
 * management channel, the board panel opens itself, and the same parsers the
 * real device goes through render the values. This test keeps that mock honest
 * against the firmware replies the panel understands. */

test("the demo URL connects a mock X1.0 and opens the board panel", async ({ page }) => {
  await page.goto("/?demo=board");

  await expect(page.locator("#statusText")).toContainText(/Connected|已连接/);
  await expect(page.locator("#deviceName")).toContainText("Linkr Bee X1.0 (demo)");
  await expect(page.locator('[data-settings-page="board"]:visible')).toHaveCount(3);

  await expect(page.locator("#boardLedStatus")).toContainText("001830");
  await expect(page.locator("#boardOptoStatus")).toContainText(/Contact open|触点已断开/);
  await expect(page.locator("#boardIrStatus")).toContainText(/frames=2/);
  await expect(page.locator('#boardSlotList .board-slot-row[data-slot="0"]')).toHaveAttribute("data-edges", "67");
});

test("the demo board answers LED, contact and learning commands", async ({ page }) => {
  await page.goto("/?demo=board");
  await expect(page.locator("#statusText")).toContainText(/Connected|已连接/);

  await page.locator('.board-swatch[data-hex="ff0000"]').tap();
  await expect(page.locator("#boardLedStatus")).toContainText("FF0000");

  await page.locator("#boardOptoClose").tap();
  await expect(page.locator("#boardOptoStatus")).toContainText(/Contact closed|触点已闭合/);

  await page.locator("#boardLearnStart").tap();
  await expect(page.locator("#boardLearnStatus")).toContainText(/Learning|学习中/);
  // The mock capture finishes by itself; the panel polls until the frame lands.
  await expect(page.locator("#boardLearnStatus")).toContainText(/Saved to slot 0|已保存到槽位 0/, {
    timeout: 10_000,
  });

  await page.locator('#boardSlotList .board-slot-row[data-slot="0"] [data-board-action="play"]').tap();
  await expect(page.locator("#boardLearnStatus")).toContainText(/OK ir play slot=0 edges=67/);
});

test("the demo board keeps a renamed signal like the real NVS", async ({ page }) => {
  await page.goto("/?demo=board");
  await expect(page.locator("#statusText")).toContainText(/Connected|已连接/);

  const row = page.locator('#boardSlotList .board-slot-row[data-slot="0"]');
  await row.locator('[data-board-action="rename"]').tap();
  await page.locator(".board-slot-input").fill("客厅 电源");
  await page.locator('[data-board-action="save-name"]').tap();
  await expect(row.locator(".board-slot-name")).toHaveText("客厅 电源");

  // The demo mimics NVS persistence, so the name is still there after a reload.
  await page.reload();
  await expect(page.locator("#statusText")).toContainText(/Connected|已连接/);
  await expect(page.locator('#boardSlotList .board-slot-row[data-slot="0"] .board-slot-name'))
    .toHaveText("客厅 电源");
});

test("the auto-sync switch is offered on a desktop browser and keeps its value", async ({ page }) => {
  await page.goto("/?demo=board");
  await expect(page.locator("#statusText")).toContainText(/Connected|已连接/);

  // A desktop window follows its own size by default, and the switch that
  // turns that off is offered here too — not only in a native shell.
  await expect(page.locator("#remoteSizeField")).toHaveJSProperty("hidden", false);
  await expect(page.locator("#remoteSizeInput")).toBeChecked();

  // Turning it off must survive a reload: the next session starts quiet.
  // The card is folded by default, so drive the control through the DOM rather
  // than through a visibility-dependent click.
  await page.evaluate(() => {
    const box = document.getElementById("remoteSizeInput");
    box.checked = false;
    box.dispatchEvent(new Event("change"));
  });
  await page.reload();
  await expect(page.locator("#statusText")).toContainText(/Connected|已连接/);
  await expect(page.locator("#remoteSizeInput")).not.toBeChecked();
});

for (const lang of ["en", "zh"]) {
test(`a native shell is offered the remote-size switch (${lang})`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript((lang) => {
    window.LinkrNativeBle = { platform: "android" };
    localStorage.setItem("linkr-lang", lang);
  }, lang);
  const page = await context.newPage();
  await page.goto("/?demo=board");
  await expect(page.locator("#statusText")).toContainText(/Connected|已连接/);
  // The switch lives on the terminal settings page and is offered here.
  await expect(page.locator("#remoteSizeField")).toHaveJSProperty("hidden", false);
  // A native shell starts with automatic syncing off.
  await expect(page.locator("#remoteSizeInput")).not.toBeChecked();
  await expect(page.locator("#remoteSizeHint, [data-i18n=\"remoteSizeHint\"]").first())
    .not.toBeEmpty();
  // Test the preference rather than a particular word in translated guidance.
  await page.locator("#remoteSizeInput").evaluate((input) => {
    input.checked = true;
    input.dispatchEvent(new Event("change"));
  });
  await page.reload();
  await expect(page.locator("#statusText")).toContainText(/Connected|已连接/);
  await expect(page.locator("#remoteSizeInput")).toBeChecked();
  await context.close();
});
}
