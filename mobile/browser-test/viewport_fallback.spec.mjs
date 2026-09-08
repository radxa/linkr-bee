import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const stylesheet = readFileSync(new URL("../../web/style.css", import.meta.url), "utf8");

for (const supportsDynamicViewport of [false, true]) {
  test(`fullscreen keyboard padding survives dvh support=${supportsDynamicViewport}`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    await page.setContent('<html class="soft-keyboard-open"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="terminal-card test-fullscreen"></div></body></html>');
    // Exercise the shipped cascade. An unknown unit models old WebViews,
    // including var() declarations that parse but fail at computed-value time.
    const css = stylesheet.replaceAll(":fullscreen", ".test-fullscreen");
    await page.addStyleTag({ content: supportsDynamicViewport ? css : css.replaceAll("dvh", "unsupportedunit") });
    for (const [visibleHeight, expectedPadding] of [[500, "300px"], [800, "0px"]]) {
      await page.evaluate(height => document.documentElement.style.setProperty("--terminal-viewport-height", `${height}px`), visibleHeight);
      await expect(page.locator(".terminal-card")).toHaveCSS("padding-bottom", expectedPadding);
    }
  });
}
