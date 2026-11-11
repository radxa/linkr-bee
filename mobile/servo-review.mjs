/* Servo bench visual review: the bench and program tabs at phone, tablet and
 * desktop widths, in both themes and both languages.
 *
 * Usage, from the repository root:
 *   sh tools/serve_web.sh 8090
 *   cd mobile && node servo-review.mjs
 *
 * Screenshots land in build-demo/servo-review/ (gitignored). Compare them with
 * DESIGN.md; the script fails on console errors, horizontal overflow, missing
 * chart samples or a missing channel legend.
 */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const base = process.env.SERVO_BASE || "http://127.0.0.1:8090";
const outDir = new URL("../build-demo/servo-review/", import.meta.url);
const viewports = [
  { name: "phone-338", width: 338, height: 844, mobile: true },
  { name: "phone-390", width: 390, height: 844, mobile: true },
  { name: "tablet-834", width: 834, height: 1000, mobile: true },
  { name: "desktop-1440", width: 1440, height: 900, mobile: false },
];
const appearances = [
  { lang: "zh", theme: "dark" },
  { lang: "zh", theme: "light" },
  { lang: "en", theme: "dark" },
  { lang: "en", theme: "light" },
];
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const problems = [];
try {
  for (const viewport of viewports) {
    for (const appearance of appearances) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.mobile, hasTouch: viewport.mobile, colorScheme: appearance.theme });
      page.on("pageerror", (e) => problems.push(`${viewport.name}/${appearance.lang}/${appearance.theme}: ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error") problems.push(`${viewport.name}/${appearance.lang}/${appearance.theme}: ${m.text()}`); });
      await page.goto(`${base}/servo.html?demo=servo&lang=${appearance.lang}&theme=${appearance.theme}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1800);
      const status = await page.evaluate(() => ({
        items: document.querySelectorAll(".servo-list-item").length,
        samples: window.__servoBench?.chart.samples.length || 0,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        canvasWidth: document.querySelector("#chartCanvas")?.width || 0,
        legend: document.querySelectorAll("#chartLegend label").length,
      }));
      if (status.items !== 6) problems.push(`${viewport.name}/${appearance.lang}/${appearance.theme}: items ${status.items}`);
      if (status.overflow) problems.push(`${viewport.name}/${appearance.lang}/${appearance.theme}: overflow`);
      if (status.samples < 2) problems.push(`${viewport.name}/${appearance.lang}/${appearance.theme}: samples ${status.samples}`);
      if (status.legend !== 6) problems.push(`${viewport.name}/${appearance.lang}/${appearance.theme}: legend ${status.legend}`);
      await page.screenshot({ path: new URL(`${viewport.name}-${appearance.lang}-${appearance.theme}-bench.png`, outDir).pathname, fullPage: true });
      if (viewport.name === "desktop-1440") {
        await page.click("#tabProgram");
        await page.waitForTimeout(400);
        await page.screenshot({ path: new URL(`${viewport.name}-${appearance.lang}-${appearance.theme}-program.png`, outDir).pathname, fullPage: true });
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (problems.length) { console.log("PROBLEMS"); for (const p of problems) console.log(" -", p); process.exitCode = 1; }
else console.log("bench review: 6 servos, chart samples, 6 channels, no errors, no overflow (4 widths x 2 themes x 2 langs)");
