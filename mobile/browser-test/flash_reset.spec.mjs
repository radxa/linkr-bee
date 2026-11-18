import { expect, test } from "@playwright/test";

test("watchdog holds the selected device until cleanup, then allows a flash", async ({ page }) => {
  await page.addInitScript(() => {
    const serial = new EventTarget();
    const port = {
      getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
      async open() {
        if (this.readable) throw Error("already open");
        this.readable = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(window.bootText));
            controller.close();
          },
        });
        this.writable = new WritableStream();
      },
      async close() {
        if (this.readable.locked) throw Error("reader still locked");
        this.readable = this.writable = null;
      },
      async setSignals() {},
    };
    const other = { getInfo: port.getInfo, open: () => { throw Error("wrong port"); } };
    serial.getPorts = async () => [port, other];
    Object.defineProperty(navigator, "serial", { value: serial });
    window.loaderStarts = 0;
    window.bootText = "ESP-ROM:esp32c3";
  });
  await page.route("**/firmware/manifest.json?*", route => route.fulfill({ json: {
    version: "test", boards: [{ slug: "linkr-bee-x1-0", chip: "ESP32-C3", name: "Bee X1.0", image_url: "./test.bin" }],
  } }));
  await page.route("**/test.bin", route => route.fulfill({ body: "test" }));
  await page.route(/\/vendor\/esptool-js\/bundle\.js(?:\?.*)?$/, route => route.fulfill({
    contentType: "application/javascript", body: `
      export class Transport { constructor(device) { this.device = device; } }
      export class ESPLoader {
        constructor({ transport }) { this.transport = transport; }
        async main() {
          const t = this.transport;
          await t.device.open();
          t.reader = t.device.readable.getReader();
          if (++window.loaderStarts === 1) await new Promise(r => { window.resumeLoader = r; });
          return "ESP32-C3";
        }
        async writeReg() {}
        async writeFlash() {}
      }`,
  }));
  await page.goto("/flash.html");
  const watchdog = page.locator("#watchdogButton");
  const flash = page.locator("#connectButton");
  const select = page.locator("#portSelect");
  await expect(watchdog).toBeEnabled();
  await watchdog.click();
  await page.waitForFunction(() => typeof window.resumeLoader === "function");
  for (const id of ["portSelect", "boardSelect", "baudSelect", "pickPortButton", "refreshPortsButton", "connectButton", "resetButton", "watchdogButton"]) {
    await expect(page.locator("#" + id)).toBeDisabled();
  }
  // A USB notification refreshes port options while the operation owns the port.
  await page.evaluate(() => {
    navigator.serial.dispatchEvent(new Event("connect"));
    document.querySelector("#connectButton").dispatchEvent(new Event("click"));
    const select = document.querySelector("#portSelect");
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    window.resumeLoader();
  });
  await expect(page.locator("#status")).toContainText("尚未确认固件启动");
  await expect(flash).toBeEnabled();
  await expect(select).toHaveValue("0");
  expect(await page.evaluate(() => window.loaderStarts)).toBe(1);

  // The write succeeds even when the ROM reports an invalid image on reboot.
  await page.evaluate(() => { window.bootText = "invalid header: 0xffffffff"; });
  await flash.click();
  await expect(page.locator("#status")).toContainText("烧录完成，重启失败");
  await expect(page.locator("#status")).toContainText("invalid header");
  await expect(watchdog).toBeEnabled();
  expect(await page.evaluate(() => window.loaderStarts)).toBe(2);
});
