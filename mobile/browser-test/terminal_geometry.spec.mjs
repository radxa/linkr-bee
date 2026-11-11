import { test as base, expect } from "@playwright/test";

const test = base.extend({ nativeShell: [false, { option: true }] });

const prompt = "root@target:~# ";

test.beforeEach(async ({ page, nativeShell }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  if (nativeShell) {
    await page.addInitScript(() => { window.LinkrNativeBle = { platform: "android" }; });
  }
  await page.route("**/app.js?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() +
      "\nwindow.__geometry = { state, setConnected, handleIncomingBytes, onTerminalData, applySerialControl, onTerminalResize, syncSoftKeyboardLayout, setSettingsPage, agentPanel, setAgentLedActive, setLogView };" });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__geometry?.state.term?.buffer.active.cursorY > 0);
  await page.evaluate(async () => {
    const { state, setConnected } = window.__geometry;
    window.sent = [];
    state.mode = "ws";
    state.ws = { readyState: 1, send: bytes => window.sent.push(new TextDecoder().decode(bytes)) };
    setConnected(true);
    await new Promise(resolve => state.term.write("\x1bc", resolve));
  });
});

async function receive(page, text) {
  await page.evaluate(text => window.__geometry.handleIncomingBytes(new TextEncoder().encode(text)), text);
  // Cover xterm's asynchronous parser and the 180 ms debounce. The margin is
  // generous because a loaded runner can delay both, and the negative
  // assertions below rely on this wait being long enough to prove absence.
  await page.waitForTimeout(600);
}

async function syncCommands(page) {
  return page.evaluate(() => window.sent.filter(text => text.startsWith("stty ")));
}

/* A sync that is expected to happen is polled: the debounce plus xterm's parser
 * can take longer than the fixed wait above when the suite runs in parallel. */
async function expectSyncCount(page, count) {
  await expect.poll(() => syncCommands(page)).toHaveLength(count);
}

async function confirmation(page, { index = -1, nonce, rows, cols } = {}) {
  const command = (await syncCommands(page)).at(index);
  const requested = /^stty rows (\d+) cols (\d+)/.exec(command);
  nonce ??= /LinkrTTY=([a-f0-9]{32})/.exec(command)[1];
  return `\x1b]633;P;LinkrTTY=${nonce};${rows ?? requested[1]} ${cols ?? requested[2]}\x07`;
}

async function confirmAtPrompt(page) {
  await receive(page, `${await confirmation(page)}\r\n${prompt}`);
}

async function setRemoteSize(page, enabled) {
  await page.evaluate(enabled => {
    const input = document.getElementById("remoteSizeInput");
    input.checked = enabled;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, enabled);
}

async function requestResize(page) {
  await expect(page.locator("#terminalResizeButton")).toBeEnabled();
  await page.evaluate(() => document.getElementById("terminalResizeButton").click());
}

test("a continuation prompt never receives a size command", async ({ page }) => {
  await receive(page, "> ");
  expect(await syncCommands(page)).toEqual([]);
});

test("TTY confirmation works when a LAN page has no randomUUID API", async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(crypto, "randomUUID", { value: undefined }));
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  await receive(page, await confirmation(page));
  await expect(page.locator("#ttySizeLabel")).not.toHaveText("—");
});

test("TTY status waits for a matching target readback and accepts fragmented OSC", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  await expect(page.locator("#ttySizeLabel")).toHaveText("—");
  await expect(page.locator("#ttySizeItem")).toHaveAttribute("title", /not yet confirmed/);
  await receive(page, `\r\n${prompt}`);
  expect(await syncCommands(page)).toHaveLength(1); // No blind retry without a receipt.
  await receive(page, await confirmation(page, { nonce: "0".repeat(32) }));
  await expect(page.locator("#ttySizeLabel")).toHaveText("—");
  const frame = await confirmation(page);
  await receive(page, frame.slice(0, 18));
  await expect(page.locator("#ttySizeLabel")).toHaveText("—");
  await receive(page, frame.slice(18));
  const requested = /^stty rows (\d+) cols (\d+)/.exec((await syncCommands(page))[0]);
  await expect(page.locator("#ttySizeLabel")).toHaveText(`${requested[2]}×${requested[1]}`);
  await expect(page.locator("#ttySizeItem")).toHaveAttribute("title", "Target tty matches this pane");
  expect(await page.locator("#terminalOutput").innerText()).not.toContain("LinkrTTY=");
});

test("TTY status shows the readback instead of assuming the requested size", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  await receive(page, await confirmation(page, { rows: 20, cols: 70 }));
  await expect(page.locator("#ttySizeLabel")).toHaveText("70×20");
  await expect(page.locator("#ttySizeItem")).toHaveAttribute("title", /not yet confirmed/);
});

test("reboot clears the displayed TTY size and rejects the previous receipt", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  const old = await confirmation(page);
  await receive(page, old);
  await expect(page.locator("#ttySizeLabel")).not.toHaveText("—");
  await receive(page, "\r\nLinux version 6.6.0\r\ntarget login: ");
  await expect(page.locator("#ttySizeLabel")).toHaveText("—");
  await receive(page, old);
  await expect(page.locator("#ttySizeLabel")).toHaveText("—");
  await receive(page, `\r\n${prompt}`);
  await expectSyncCount(page, 2);
  await receive(page, old);
  await expect(page.locator("#ttySizeLabel")).toHaveText("—");
  await receive(page, await confirmation(page));
  await expect(page.locator("#ttySizeLabel")).not.toHaveText("—");
});

test("disconnect discards an outstanding target size confirmation", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  const old = await confirmation(page);
  await page.evaluate(() => { window.__geometry.setConnected(false); window.__geometry.setConnected(true); });
  await receive(page, `\r\n${prompt}`);
  await expectSyncCount(page, 2);
  await receive(page, old);
  await expect(page.locator("#ttySizeLabel")).toHaveText("—");
  await receive(page, await confirmation(page));
  await expect(page.locator("#ttySizeLabel")).not.toHaveText("—");
});

test("ownership changes revoke confirmed sizes and outstanding receipts", async ({ page }) => {
  await page.evaluate(() => window.__geometry.applySerialControl({self:1,owner:1,mode:"control",epoch:2,peers:2,capacity:2}));
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  const old = await confirmation(page);
  await receive(page, old);
  await page.evaluate(() => window.__geometry.applySerialControl({self:1,owner:2,mode:"readonly",epoch:3,peers:2,capacity:2}));
  await expect(page.locator("#ttySizeLabel")).toHaveText("—");
  await receive(page, old);
  await expect(page.locator("#ttySizeLabel")).toHaveText("—");
});

for (const viewport of [{ width: 1552, height: 1221 }, { width: 390, height: 844 }]) {
  test.describe(`terminal viewport ${viewport.width}`, () => {
  test.use({ isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  test(`last terminal row fits above keyboard with Agent at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.locator("#agentButton").click();
    await receive(page, ("test output 0123456789\r\n").repeat(150) + "LAST ROW");
    const measure = () => page.evaluate(() => {
      const screen = document.querySelector(".xterm-screen").getBoundingClientRect();
      const output = document.querySelector("#terminalOutput").getBoundingClientRect();
      const keyboard = document.querySelector(".terminal-input-bar").getBoundingClientRect();
      return { bottom: screen.bottom, right: screen.right, outputBottom: output.bottom,
        outputRight: output.right, keyboardTop: keyboard.top };
    });
    await expect.poll(async () => {
      const r = await measure();
      return r.bottom <= Math.min(r.outputBottom, r.keyboardTop) && r.right <= r.outputRight;
    }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`terminal-${viewport.width}.png`) });
    await page.evaluate(() => document.documentElement.classList.add("soft-keyboard-open"));
    await expect.poll(async () => {
      const r = await measure();
      return r.bottom <= Math.min(r.outputBottom, r.keyboardTop) && r.right <= r.outputRight;
    }).toBe(true);
  });
  });
}

test("geometry synchronizes once at an empty prompt", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  await receive(page, `stty\r\n${prompt}`);
  expect(await syncCommands(page)).toHaveLength(1);
});

for (const locallyTyped of [true, false]) {
  test(`Ctrl-A preserves the editable command (local input: ${locallyTyped})`, async ({ page }) => {
    if (locallyTyped) await page.evaluate(() => window.__geometry.onTerminalData("echo KEEP"));
    await receive(page, prompt + "echo KEEP");
    if (locallyTyped) await page.evaluate(() => window.__geometry.onTerminalData("\x01"));
    await receive(page, `\r\x1b[${prompt.length}C`);
    expect(await syncCommands(page)).toEqual([]);
    // Cancelling the input and receiving a fresh prompt permits synchronization.
    await page.evaluate(() => window.__geometry.onTerminalData("\x03"));
    await receive(page, `^C\r\n${prompt}`);
    await expectSyncCount(page, 1);
  });
}

test("hidden pending input and alternate-screen prompts never trigger geometry writes", async ({ page }) => {
  await page.evaluate(() => window.__geometry.onTerminalData("echo hidden"));
  await receive(page, prompt);
  expect(await syncCommands(page)).toEqual([]);
  await page.evaluate(() => window.__geometry.onTerminalData("\x03"));
  await receive(page, `\x1b[?1049h${prompt}`);
  expect(await syncCommands(page)).toEqual([]);
});

for (const coalesced of [false, true]) {
  test(`same-size login resynchronizes without a BLE reconnect (coalesced: ${coalesced})`, async ({ page }) => {
    await receive(page, prompt);
    await expectSyncCount(page, 1);
    if (coalesced) {
      await receive(page, `\r\ntarget login: root\r\n${prompt}`);
    } else {
      await receive(page, "\r\ntarget log");
      await receive(page, "in: ");
      expect(await syncCommands(page)).toHaveLength(1);
      await receive(page, `root\r\n${prompt}`);
    }
    await expectSyncCount(page, 2);
  });
}

test("manual resize retries an unconfirmed size only after another explicit click", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  await confirmAtPrompt(page);
  await requestResize(page); // Same size: still obtain a new target readback.
  await expectSyncCount(page, 2);
  const oldReceipt = await confirmation(page);
  await receive(page, `\r\n${prompt}`);
  await expect(page.locator("#terminalResizeStatus")).toContainText(/not yet confirmed/);
  expect(await syncCommands(page)).toHaveLength(2);
  await requestResize(page);
  await expectSyncCount(page, 3);
  await receive(page, oldReceipt);
  await expect(page.locator("#terminalResizeStatus")).toContainText(/not yet confirmed/);
  await confirmAtPrompt(page);
  await expect(page.locator("#terminalResizeStatus")).toContainText("Target tty matches this pane");
});

test("manual resize preserves a partially typed input line", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  await confirmAtPrompt(page);
  await page.evaluate(() => window.__geometry.onTerminalData("echo KEEP"));
  await requestResize(page);
  await receive(page, prompt); // Even a stale prompt cannot permit the write.
  expect(await syncCommands(page)).toHaveLength(1);
  await page.evaluate(() => window.__geometry.onTerminalData("\x03"));
  await receive(page, `^C\r\n${prompt}`);
  await expectSyncCount(page, 2);
});

test("a failed manual resize reports its error without replaying input", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  await confirmAtPrompt(page);
  await page.evaluate(() => { window.__geometry.state.ws.send = () => { throw new Error("resize transport failed"); }; });
  await requestResize(page);
  await expect(page.locator(".toast-error")).toContainText("resize transport failed");
  await receive(page, `\r\n${prompt}`);
  expect(await syncCommands(page)).toHaveLength(1);
});

test("a queued manual resize resumes after the agent becomes idle", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  await confirmAtPrompt(page);
  await page.evaluate(() => {
    window.agentBusy = true;
    window.__geometry.agentPanel.isBusy = () => window.agentBusy;
    window.__geometry.setAgentLedActive(true);
  });
  await requestResize(page);
  await receive(page, `\r\n${prompt}`);
  expect(await syncCommands(page)).toHaveLength(1);
  await page.evaluate(() => { window.agentBusy = false; window.__geometry.setAgentLedActive(false); });
  await expectSyncCount(page, 2);
});

test("historical redraw disables the manual button without triggering a resize", async ({ page }) => {
  await receive(page, prompt);
  await expectSyncCount(page, 1);
  await confirmAtPrompt(page);
  const disabled = await page.evaluate(() => {
    window.__geometry.setLogView("raw");
    return document.getElementById("terminalResizeButton").disabled;
  });
  expect(disabled).toBe(true);
  await expect(page.locator("#terminalOutput")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#terminalResizeButton")).toBeEnabled();
  await page.waitForTimeout(500);
  expect(await syncCommands(page)).toHaveLength(1);
});

test("disconnect and ownership changes cancel a queued manual resize", async ({ page }) => {
  await receive(page, "\x1b[?1049hTOP");
  await requestResize(page);
  await expect(page.locator("#terminalResizeButton")).toBeDisabled();
  await page.evaluate(() => window.__geometry.setConnected(false));
  expect(await page.evaluate(() => window.__geometry.state.terminalGeometryRequested)).toBe(false);
  await expect(page.locator("#terminalResizeButton")).toBeDisabled();
  await page.evaluate(() => window.__geometry.setConnected(true));
  await receive(page, "\x1b[?1049hTOP");
  await requestResize(page);
  await page.evaluate(() => window.__geometry.applySerialControl({self:1,owner:2,mode:"readonly",epoch:2,peers:2,capacity:2}));
  expect(await page.evaluate(() => window.__geometry.state.terminalGeometryRequested)).toBe(false);
  await expect(page.locator("#terminalResizeButton")).toBeDisabled();
  await receive(page, `\x1b[?1049l\r\n${prompt}`);
  expect(await syncCommands(page)).toEqual([]);
});

test.describe("native target geometry preferences", () => {
  test.use({ nativeShell: true });

  test.beforeEach(async ({ page }) => {
    await receive(page, prompt);
    await expectSyncCount(page, 1);
    await confirmAtPrompt(page);
  });

  test("the initial resize does not enable later syncs or sync on alternate-screen exit", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(500);
    expect(await syncCommands(page)).toHaveLength(1);
    await expect(page.locator("#terminalResizeStatus")).toContainText("Automatic sync is off");
    await receive(page, "\x1b[?1049hTOP");
    await page.setViewportSize({ width: 980, height: 800 });
    await expect(page.locator("#terminalResizeStatus")).toContainText("Automatic sync is off");
    await expect(page.locator("#ttySizeItem")).not.toHaveClass(/sb-fullscreen/);
    await receive(page, `\x1b[?1049l\r\n${prompt}`);
    expect(await syncCommands(page)).toHaveLength(1);
  });

  test("enabling sync applies pending geometry at the already observed idle prompt", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(500);
    const previous = await page.locator("#ttySizeLabel").innerText();
    await setRemoteSize(page, true);
    await expectSyncCount(page, 2); // No new UART output is needed.
    await expect(page.locator("#ttySizeLabel")).toHaveText(previous);
    await confirmAtPrompt(page);
    await page.setViewportSize({ width: 980, height: 800 });
    await expectSyncCount(page, 3);
  });

  test("disabling cancels a debounced resize and retains the confirmed target size", async ({ page }) => {
    await setRemoteSize(page, true);
    await page.setViewportSize({ width: 1000, height: 800 });
    await expectSyncCount(page, 2);
    await confirmAtPrompt(page);
    const confirmed = await page.locator("#ttySizeLabel").innerText();
    await page.evaluate(() => {
      const { state, onTerminalResize } = window.__geometry;
      onTerminalResize({ cols: state.terminalGeometry.cols - 1, rows: state.terminalGeometry.rows });
      const input = document.getElementById("remoteSizeInput");
      input.checked = false;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await receive(page, `\r\n${prompt}`);
    expect(await syncCommands(page)).toHaveLength(2);
    await expect(page.locator("#ttySizeLabel")).toHaveText(confirmed);
    await page.setViewportSize({ width: 980, height: 800 });
    await receive(page, `\r\n${prompt}`);
    expect(await syncCommands(page)).toHaveLength(2);
  });

  test("preference changes keep an outstanding target receipt valid", async ({ page }) => {
    await setRemoteSize(page, true);
    await page.setViewportSize({ width: 1000, height: 800 });
    await expectSyncCount(page, 2);
    const receipt = await confirmation(page);
    await setRemoteSize(page, false);
    await receive(page, receipt);
    const command = /^stty rows (\d+) cols (\d+)/.exec((await syncCommands(page))[1]);
    await expect(page.locator("#ttySizeLabel")).toHaveText(`${command[2]}×${command[1]}`);
    expect(await syncCommands(page)).toHaveLength(2);
  });

  test("a manual resize is one shot and does not change the automatic preference", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(500);
    await requestResize(page);
    await expectSyncCount(page, 2);
    await confirmAtPrompt(page);
    await expect(page.locator("#remoteSizeInput")).not.toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem("linkr-remote-size"))).not.toBe("1");
    await page.setViewportSize({ width: 980, height: 800 });
    await receive(page, `\r\n${prompt}`);
    expect(await syncCommands(page)).toHaveLength(2);
  });

  test("a manual request waits until the full-screen program exits", async ({ page }) => {
    await receive(page, `\x1b[?1049h${prompt}`);
    await requestResize(page);
    await expect(page.locator("#terminalResizeStatus")).toContainText(/full-screen program/);
    await receive(page, prompt);
    expect(await syncCommands(page)).toHaveLength(1);
    await receive(page, `\x1b[?1049l\r\n${prompt}`);
    await expectSyncCount(page, 2);
    await confirmAtPrompt(page);
    await receive(page, "\x1b[?1049hTOP");
    await page.setViewportSize({ width: 1000, height: 800 });
    await receive(page, `\x1b[?1049l\r\n${prompt}`);
    expect(await syncCommands(page)).toHaveLength(2);
  });

  test("opening the keyboard cancels an automatic timer and closing resumes manual sync", async ({ page }) => {
    await setRemoteSize(page, true);
    await page.setViewportSize({ width: 1000, height: 800 });
    await expectSyncCount(page, 2);
    await confirmAtPrompt(page);
    await page.evaluate(() => {
      const { state, onTerminalResize, syncSoftKeyboardLayout } = window.__geometry;
      onTerminalResize({ cols: state.terminalGeometry.cols - 1, rows: state.terminalGeometry.rows });
      state.term.focus();
      Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 350 });
      syncSoftKeyboardLayout();
    });
    await expect(page.locator("html")).toHaveClass(/soft-keyboard-open/);
    await page.waitForTimeout(500);
    expect(await syncCommands(page)).toHaveLength(2);
    await setRemoteSize(page, false);
    await requestResize(page);
    await expect(page.locator("#terminalResizeStatus")).toContainText(/Close the keyboard/);
    await page.waitForTimeout(500);
    expect(await syncCommands(page)).toHaveLength(2);
    await page.evaluate(() => {
      delete visualViewport.height;
      window.__geometry.syncSoftKeyboardLayout();
    });
    await expectSyncCount(page, 3);
    await expect(page.locator("#remoteSizeInput")).not.toBeChecked();
  });
});
