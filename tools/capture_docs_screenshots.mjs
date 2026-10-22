import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "mobile/package.json"));
const { chromium } = require("@playwright/test");
const url = process.argv[2] || "http://127.0.0.1:8765/";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(executablePath
  ? { executablePath }
  : existsSync(chromium.executablePath()) ? {} : { channel: "chrome" });

function sampleOutput(lang) {
  const prompt = "\x1b[38;5;35mroot@board\x1b[0m:\x1b[38;5;33m~\x1b[0m# ";
  return [
    "\x1b[1mLinkr Bee / UART console preview\x1b[0m",
    lang === "en" ? "Sample output - no device connected." : "示例输出 - 未连接真实设备。",
    "",
    `${prompt}uname -sr`,
    "Linux 6.1.0",
    "",
    `${prompt}ip -br addr show eth0`,
    "eth0    UP    192.0.2.10/24",
    "",
    `${prompt}systemctl is-system-running`,
    "\x1b[38;5;35mrunning\x1b[0m",
    "",
    `${prompt}printf 'UART console ready\\n'`,
    "UART console ready",
    "",
    `${prompt}`,
  ].join("\r\n");
}

try {
  for (const lang of ["en", "zh"]) {
    for (const layout of ["desktop", "controls", "mobile"]) {
      const mobile = layout === "mobile";
      const context = await browser.newContext({
        locale: lang === "en" ? "en-US" : "zh-CN",
        viewport: mobile ? { width: 430, height: 932 } : { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: "light",
      });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(({ lang, controls }) => {
          localStorage.setItem("linkr-lang", lang);
          localStorage.setItem("linkr-theme", "light");
          localStorage.setItem("linkr-sidebar", controls ? "open" : "collapsed");
          localStorage.setItem("linkr-settings-page", "terminal");
        }, { lang, controls: layout === "controls" });
        // Expose the existing terminal only in this isolated browser; no BLE
        // transport is opened and no preview bytes can reach a target.
        await page.route("**/app.js?*", async route => {
          const response = await route.fetch();
          await route.fulfill({ response, body: await response.text()
            + "\nwindow.__docsTerminal = state.term;" });
        });
        await page.goto(url, { waitUntil: "networkidle" });
        await page.waitForFunction(() => window.__docsTerminal?.rows > 0);
        await page.evaluate(async text => {
          await document.fonts.ready;
          const term = window.__docsTerminal;
          // Match the retained-transcript view without claiming a live link.
          document.querySelector("#terminalOutput").dataset.everConnected = "1";
          term.options.cursorBlink = false;
          await new Promise(resolve => term.write("\x1bc" + text, resolve));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, sampleOutput(lang));
        const invalid = await page.locator("[data-i18n]:visible").evaluateAll((elements, lang) =>
          lang === "en" ? elements.filter(element => /\p{Script=Han}/u.test(element.textContent))
            .map(element => element.textContent) : [], lang);
        if (invalid.length || errors.length) {
          throw new Error(JSON.stringify({ lang, layout, untranslated: invalid, errors }));
        }
        const suffix = lang === "en" ? "-en" : "";
        const file = path.join(root, "assets/screenshots", `linkr-bee-terminal-${layout}${suffix}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 88, animations: "disabled" });
        console.log(`${lang} ${layout}: ${file}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
