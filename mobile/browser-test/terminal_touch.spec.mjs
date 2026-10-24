import { test, expect } from "@playwright/test";

async function openTerminal(page, { android = false, connected = true } = {}) {
  if (android) {
    await page.addInitScript(() => {
      // The Capacitor bootstrap only installs LinkrNativeBle on a native
      // platform; this is the same surface app.js reads for layout decisions.
      window.LinkrNativeBle = { platform: "android" };
    });
  }
  await page.route("**/app.js?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()) +
        "\nwindow.__terminalTest = { state, setConnected, handleIncomingBytes, setTerminalSelection };" +
        "\nwindow.__terminalCopied = null;" +
        "\nObject.defineProperty(navigator.clipboard, 'writeText', {" +
        "\n  configurable: true," +
        "\n  value: async (text) => { window.__terminalCopied = text; }," +
        "\n});",
    });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__terminalTest?.state.term);
  await page.evaluate(async (connected) => {
    const { state, setConnected } = window.__terminalTest;
    window.sent = [];
    state.mode = "ws";
    state.ws = {
      readyState: 1,
      send: (bytes) => window.sent.push(new TextDecoder().decode(bytes)),
    };
    setConnected(connected);
    await new Promise((resolve) => state.term.write(
      Array.from({ length: 120 }, (_, i) =>
        `line ${String(i).padStart(3, "0")} abcdefghijklmnopqrstuvwxyz\r\n`).join(""),
      resolve,
    ));
    state.term.blur();
  }, connected);
}

async function touchDrag(context, page, { startY, deltaY }) {
  const box = await page.locator(".xterm-screen").boundingBox();
  const x = box.x + box.width / 2;
  const y = startY ?? box.y + 40;
  const client = await context.newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }],
  });
  for (let i = 1; i <= 10; i += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x,
        y: y + (deltaY * i) / 10,
        radiusX: 8,
        radiusY: 8,
        force: 1,
        id: 1,
      }],
    });
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.waitForTimeout(200);
}

test("touch drag scrolls the xterm history and turns auto-scroll off", async ({ page, context }) => {
  await openTerminal(page);
  const before = await page.evaluate(() => {
    const buffer = window.__terminalTest.state.term.buffer.active;
    return { viewportY: buffer.viewportY, baseY: buffer.baseY, auto: window.__terminalTest.state.autoScroll };
  });
  await touchDrag(context, page, { deltaY: 240 });
  const after = await page.evaluate(() => {
    const buffer = window.__terminalTest.state.term.buffer.active;
    return {
      viewportY: buffer.viewportY,
      auto: window.__terminalTest.state.autoScroll,
      focused: document.activeElement?.className || "",
    };
  });
  expect(after.viewportY).toBeLessThan(before.viewportY);
  expect(after.viewportY).toBeLessThan(before.baseY);
  expect(after.auto).toBe(false);
  // Dragging history must not pop the soft keyboard, including when Android
  // WebView focuses the hidden textarea just after touchend.
  expect(after.focused).not.toContain("xterm-helper-textarea");
  await page.evaluate(() => window.__terminalTest.state.term.focus());
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => document.activeElement?.className || ""))
    .not.toContain("xterm-helper-textarea");

  // The guard is short-lived, so an explicit keyboard button/tap still works.
  await page.waitForTimeout(1300);
  await page.evaluate(() => window.__terminalTest.state.term.focus());
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");
});

test("a tap focuses the terminal for typing", async ({ page, context }) => {
  await openTerminal(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const client = await context.newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 3 }],
  });
  await page.waitForTimeout(40);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");
});

test("the keyboard button follows the keyboard, not just focus", async ({ page }) => {
  await openTerminal(page);
  const keyboardButton = page.locator("#focusTerminalButton");
  await expect(keyboardButton).toBeVisible();
  await expect(keyboardButton).toHaveAttribute("aria-pressed", "false");
  await keyboardButton.tap();
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");

  // An Android IME opening shrinks the visual viewport. Only then is the
  // button allowed to say the keyboard is up.
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      get: () => 420,
    });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(keyboardButton).toHaveAttribute("aria-pressed", "true");

  await keyboardButton.tap();
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .not.toContain("xterm-helper-textarea");
  await expect(keyboardButton).toHaveAttribute("aria-pressed", "false");

  // Android's own hide button removes the IME without blurring the textarea.
  // The button must go back to unpressed, and pressing it must ask again.
  await page.evaluate(() => window.__terminalTest.state.term.focus());
  await expect(keyboardButton).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      get: () => 844,
    });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(keyboardButton).toHaveAttribute("aria-pressed", "false");
  await keyboardButton.tap();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");
});

test("long press shows draggable handles and dragging one trims precisely", async ({ page, context }) => {
  await openTerminal(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const termSize = await page.evaluate(() => ({
    rows: window.__terminalTest.state.term.rows,
    cols: window.__terminalTest.state.term.cols,
  }));
  const client = await context.newCDPSession(page);
  const x = box.x + (box.width / termSize.cols) * 12;
  const y = box.y + box.height - 50;

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 11 }],
  });
  await page.waitForTimeout(900);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  const word = await page.evaluate(() => window.__terminalTest.state.term.getSelection());
  expect(word).toBe("abcdefghijklmnopqrstuvwxyz");
  await expect(page.locator(".terminal-selection-handle")).toHaveCount(2);
  await expect(page.locator(".terminal-selection-handle-start")).toBeVisible();
  await expect(page.locator(".terminal-selection-handle-end")).toBeVisible();
  await expect(page.locator(".terminal-selection-copy")).toBeVisible();

  // Drag the start dot two cells to the right: exactly the first two letters
  // leave the selection, which is the precision the phone's own handles give.
  const handle = await page.locator(".terminal-selection-handle-start").boundingBox();
  const cellWidth = box.width / termSize.cols;
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: hx, y: hy, radiusX: 6, radiusY: 6, force: 1, id: 12 }],
  });
  for (let i = 1; i <= 6; i += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x: hx + (cellWidth * 2 * i) / 6,
        y: hy,
        radiusX: 6,
        radiusY: 6,
        force: 1,
        id: 12,
      }],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(80);

  const trimmed = await page.evaluate(() => window.__terminalTest.state.term.getSelection());
  expect(trimmed).toBe("cdefghijklmnopqrstuvwxyz");
  await expect(page.locator(".terminal-selection-copy")).toBeVisible();

  await page.locator(".terminal-selection-copy").click();
  await expect.poll(() => page.evaluate(() => window.__terminalCopied)).toBe(trimmed);
});


test("long press selects a word and dragging extends the selection", async ({ page, context }) => {
  await openTerminal(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const termSize = await page.evaluate(() => ({
    rows: window.__terminalTest.state.term.rows,
    cols: window.__terminalTest.state.term.cols,
  }));
  const client = await context.newCDPSession(page);
  // Column 12 is inside "abcdefghijklmnopqrstuvwxyz" in the fixture lines.
  const x = box.x + (box.width / termSize.cols) * 12;
  const y = box.y + box.height - 50;
  const rowHeight = box.height / termSize.rows;

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 2 }],
  });
  await page.waitForTimeout(900);
  const word = await page.evaluate(() => window.__terminalTest.state.term.getSelection());
  expect(word).toBe("abcdefghijklmnopqrstuvwxyz");

  // Keep the finger down after the long-press word selection and drag upward.
  for (let i = 1; i <= 8; i += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x,
        y: y - rowHeight * 3 * (i / 8),
        radiusX: 8,
        radiusY: 8,
        force: 1,
        id: 2,
      }],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  const selected = await page.evaluate(() => window.__terminalTest.state.term.getSelection());
  const lines = selected.split("\n");
  expect(lines.length).toBeGreaterThan(1);
  expect(selected.length).toBeGreaterThan(word.length);
  // The drag is anchored on the exact cell under the finger, not on the word
  // edge, so the box starts part-way through the word on the row it reached.
  expect(lines[0]).not.toBe(word);
  expect(word.endsWith(lines[0])).toBe(true);
  expect(lines[0].length).toBeGreaterThan(4);
  expect(lines.at(-1)).toMatch(/^line \d{3} abc/);
  await expect(page.locator("#copyBtn")).toBeVisible();
  await page.locator("#copyBtn").click();
  await expect.poll(() => page.evaluate(() => window.__terminalCopied)).toBe(selected);
});

test("long press with the keyboard open selects and copies without closing it", async ({ page, context }) => {
  await openTerminal(page);
  await page.evaluate(() => window.__terminalTest.state.term.focus());
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");

  const box = await page.locator(".xterm-screen").boundingBox();
  const termSize = await page.evaluate(() => ({
    rows: window.__terminalTest.state.term.rows,
    cols: window.__terminalTest.state.term.cols,
  }));
  const client = await context.newCDPSession(page);
  const x = box.x + (box.width / termSize.cols) * 12;
  const y = box.y + box.height - 50;
  const rowHeight = box.height / termSize.rows;

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 5 }],
  });
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__terminalTest.state.term.getSelection()))
    .toBe("abcdefghijklmnopqrstuvwxyz");

  for (let i = 1; i <= 8; i += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x,
        y: y - rowHeight * 3 * (i / 8),
        radiusX: 8,
        radiusY: 8,
        force: 1,
        id: 5,
      }],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  const selected = await page.evaluate(() => window.__terminalTest.state.term.getSelection());
  expect(selected).toContain("\n");
  // The soft keyboard was open before the gesture and must still be open.
  expect(await page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");

  await page.locator("#copyBtn").click();
  await expect.poll(() => page.evaluate(() => window.__terminalCopied)).toBe(selected);
});

test("a long press keeps a keyboard the WebView took focus from", async ({ page, context }) => {
  // Physical Android WebViews drop activeElement while their own long-press
  // gesture runs, which used to read as "the keyboard was closed" and made the
  // app dismiss an IME the user had just opened. The IME state is judged by the
  // visual viewport, so the gesture must survive a lost focus.
  await openTerminal(page);
  await page.evaluate(() => window.__terminalTest.state.term.focus());
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      get: () => 420,
    });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  const keyboardButton = page.locator("#focusTerminalButton");
  await expect(keyboardButton).toHaveAttribute("aria-pressed", "true");

  const box = await page.locator(".xterm-screen").boundingBox();
  const termSize = await page.evaluate(() => ({
    rows: window.__terminalTest.state.term.rows,
    cols: window.__terminalTest.state.term.cols,
  }));
  const client = await context.newCDPSession(page);
  const x = box.x + (box.width / termSize.cols) * 12;
  const y = box.y + box.height - 50;

  await page.evaluate(() => {
    window.__terminalBlurs = 0;
    window.__terminalTest.state.term.textarea.addEventListener("blur", () => {
      window.__terminalBlurs += 1;
    });
  });

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 7 }],
  });
  await page.waitForTimeout(600);
  // The WebView's gesture detector moves focus off the textarea mid-gesture.
  await page.evaluate(() => document.activeElement?.blur());
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  expect(await page.evaluate(() => window.__terminalTest.state.term.getSelection()))
    .toBe("abcdefghijklmnopqrstuvwxyz");
  // Only the simulated one: the app itself must not blur the terminal when the
  // keyboard was already up, and it must hand focus back afterwards.
  expect(await page.evaluate(() => window.__terminalBlurs)).toBe(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");
  await expect(keyboardButton).toHaveAttribute("aria-pressed", "true");
});

test("swiping history keeps an open keyboard open", async ({ page, context }) => {
  await openTerminal(page);
  await page.evaluate(() => window.__terminalTest.state.term.focus());
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");

  const before = await page.evaluate(() => ({
    viewportY: window.__terminalTest.state.term.buffer.active.viewportY,
    baseY: window.__terminalTest.state.term.buffer.active.baseY,
  }));
  await touchDrag(context, page, { deltaY: 240 });
  const after = await page.evaluate(() => ({
    viewportY: window.__terminalTest.state.term.buffer.active.viewportY,
    focused: document.activeElement?.className || "",
  }));
  expect(after.viewportY).toBeLessThan(before.viewportY);
  expect(after.viewportY).toBeLessThan(before.baseY);
  expect(after.focused).toContain("xterm-helper-textarea");
});

test("a cancelled long press still selects and does not open the keyboard", async ({ page, context }) => {
  await openTerminal(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const client = await context.newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height - 50;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 6 }],
  });
  await page.waitForTimeout(900);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
  expect(await page.evaluate(() => window.__terminalTest.state.term.getSelection()))
    .not.toBe("");
  expect(await page.evaluate(() => document.activeElement?.className || ""))
    .not.toContain("xterm-helper-textarea");
});

test("copy survives a WebView clearing the selection during a long press", async ({ page, context }) => {
  await openTerminal(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const termSize = await page.evaluate(() => ({
    rows: window.__terminalTest.state.term.rows,
    cols: window.__terminalTest.state.term.cols,
  }));
  const client = await context.newCDPSession(page);
  const x = box.x + (box.width / termSize.cols) * 12;
  const y = box.y + box.height - 50;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 21 }],
  });
  await page.waitForTimeout(900);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  const word = await page.evaluate(() => window.__terminalTest.state.term.getSelection());
  expect(word).toBe("abcdefghijklmnopqrstuvwxyz");

  // This is what several Android WebViews do: their own selection collapses
  // and xterm drops the selection we made. The app must put it back.
  await page.evaluate(() => window.__terminalTest.state.term.clearSelection());
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => window.__terminalTest.state.term.getSelection()))
    .toBe(word);
  await expect(page.locator(".terminal-selection-copy")).toBeVisible();

  await page.locator("#copyBtn").click();
  await expect.poll(() => page.evaluate(() => window.__terminalCopied)).toBe(word);
});

test("a long hold never opens the keyboard, even without a word selected", async ({ page, context }) => {
  await openTerminal(page);
  const box = await page.locator(".xterm-screen").boundingBox();
  const client = await context.newCDPSession(page);
  // Far right of an empty area: no word to select there.
  const x = box.x + box.width - 6;
  const y = box.y + box.height - 20;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 31 }],
  });
  await page.waitForTimeout(900);
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.activeElement?.className || ""))
    .not.toContain("xterm-helper-textarea");
});

test("copy with no selection falls back to the whole transcript", async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => window.__terminalTest.state.term.clearSelection());
  await page.locator("#copyBtn").click();
  const copied = await page.evaluate(() => window.__terminalCopied);
  expect(copied).toContain("line 000 abcdefghijklmnopqrstuvwxyz");
  expect(copied).toContain("line 119 abcdefghijklmnopqrstuvwxyz");
});

test("whole transcript copy preserves wrapped lines and boundary spaces", async ({ page }) => {
  await openTerminal(page);
  // Flush the welcome output before resetting the buffer for this fixture.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const expected = await page.evaluate(async () => {
    const { term } = window.__terminalTest.state;
    const text = "A".repeat(term.cols * 2 + 5) + "\r\nNEXT\r\n" +
      "B".repeat(term.cols - 1) + " TAIL\r\n\r\nEND";
    await new Promise(resolve => term.write("\x1bc" + text, resolve));
    return text.replaceAll("\r", "");
  });
  await page.locator("#copyBtn").click();
  await expect.poll(() => page.evaluate(() => window.__terminalCopied)).toBe(expected);
});

for (const clipboard of ["missing", "rejected"]) {
  for (const control of ["#copyBtn", ".terminal-selection-copy"]) {
    test(`fallback copy keeps focus and selection (${clipboard}, ${control})`, async ({ page }) => {
      await openTerminal(page);
      const selected = await page.evaluate((clipboard) => {
        const { state, setTerminalSelection } = window.__terminalTest;
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: clipboard === "missing" ? undefined : async () => {
            throw new Error("clipboard permission denied");
          },
        });
        // Observe the real browser copy event without replacing execCommand.
        document.addEventListener("copy", (event) => {
          const data = event.clipboardData;
          if (!data) return;
          const setData = data.setData.bind(data);
          data.setData = (format, text) => {
            if (format === "text/plain") window.__terminalCopied = text;
            setData(format, text);
          };
        }, { capture: true });
        state.term.focus();
        const row = state.term.buffer.active.viewportY + state.term.rows - 4;
        setTerminalSelection({ row, col: 9 }, { row, col: 13 });
        window.__terminalBlurCount = 0;
        state.term.textarea.addEventListener("blur", () => {
          window.__terminalBlurCount += 1;
        });
        return state.term.getSelection();
      }, clipboard);
      expect(selected).not.toBe("");
      await page.locator(control).tap();
      await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
        .toContain("xterm-helper-textarea");
      expect(await page.evaluate(() => window.__terminalBlurCount)).toBe(0);
      await expect.poll(() => page.evaluate(() => window.__terminalCopied)).toBe(selected);
      expect(await page.evaluate(() => window.__terminalTest.state.term.getSelection())).toBe(selected);
    });
  }
}

test("native Android keeps keyboard resizes local instead of sending stty", async ({ page }) => {
  await openTerminal(page, { android: true });
  await page.evaluate(() => {
    const { handleIncomingBytes } = window.__terminalTest;
    handleIncomingBytes(new TextEncoder().encode("root@target:~# "));
  });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.sent.filter((text) => text.startsWith("stty ")))).toEqual([]);

  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      get: () => 420,
    });
    visualViewport.dispatchEvent(new Event("resize"));
    window.__terminalTest.state.term.focus();
  });
  await expect(page.locator("html")).toHaveClass(/soft-keyboard-open/);
  await expect.poll(() => page.evaluate(() => window.__terminalTest.state.term.rows)).toBeLessThan(40);
  expect(await page.evaluate(() => window.sent.filter((text) => text.startsWith("stty ")))).toEqual([]);
});

test("a long press while disconnected can be dismissed and repeated", async ({ page }) => {
  // Nothing is connected, so the textarea never takes focus and a phone WebView
  // reports the hold through its contextmenu backup path. That path used to
  // start a selection while the touch state machine was skipped, and the
  // selection then stuck: the tap that should dismiss it hit a swallowed click,
  // and no later long press could move it.
  await openTerminal(page, { connected: false });
  expect(await page.evaluate(() => window.__terminalTest.state.connected)).toBe(false);

  const box = await page.locator(".xterm-screen").boundingBox();
  const rows = await page.evaluate(() => window.__terminalTest.state.term.rows);
  const rowHeight = box.height / rows;
  const copy = page.locator(".terminal-selection-copy");

  const longPressAt = async (y) => {
    await page.evaluate(({ x, y: clientY }) => {
      document.querySelector(".xterm-screen").dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY,
      }));
    }, { x: box.x + 40, y });
    await page.waitForTimeout(80);
  };

  await longPressAt(box.y + rowHeight * 2);
  const first = await page.evaluate(() => window.__terminalTest.state.term.getSelection());
  expect(first).not.toBe("");
  await expect(copy).toBeVisible();

  // A tap somewhere else must dismiss the selection instead of being eaten.
  await page.touchscreen.tap(box.x + 220, box.y + rowHeight * 6);
  await page.waitForTimeout(200);
  await expect(copy).toBeHidden();
  expect(await page.evaluate(() => window.__terminalTest.state.term.getSelection())).toBe("");

  // And a second long press has to move the selection to the new row.
  await longPressAt(box.y + rowHeight * 4);
  const second = await page.evaluate(() => window.__terminalTest.state.term.getSelection());
  expect(second).not.toBe("");
  expect(second).not.toBe(first);
  await expect(copy).toBeVisible();
});

/* Android resizes only the visual viewport when its IME opens or closes, and
 * the app reads that height to decide whether the keyboard is up. Define the
 * getter so a spec can walk the same heights a phone reports. */
async function setVisualViewportHeight(page, height) {
  await page.evaluate((next) => {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      get: () => next,
    });
    visualViewport.dispatchEvent(new Event("resize"));
  }, height);
  // The layout pass runs in a requestAnimationFrame callback.
  await page.waitForTimeout(80);
}

test("a tap brings back a keyboard Android dismissed without blurring", async ({ page }) => {
  // Android's own hide button removes the IME and leaves the textarea focused,
  // and a long press plus Copy ends in the same state. focus() is a no-op on a
  // focused element, so the tap has to cycle the focus or the terminal cannot be
  // typed into again.
  await openTerminal(page);
  await page.evaluate(() => window.__terminalTest.state.term.focus());
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");

  await setVisualViewportHeight(page, 420);
  await setVisualViewportHeight(page, 844);
  const keyboardButton = page.locator("#focusTerminalButton");
  await expect(keyboardButton).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");

  await page.evaluate(() => {
    window.__terminalBlurs = 0;
    window.__terminalTest.state.term.textarea.addEventListener("blur", () => {
      window.__terminalBlurs += 1;
    });
  });
  const box = await page.locator(".xterm-screen").boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  // Exactly one blurred focus: that focus change is what reopens the IME.
  await expect.poll(() => page.evaluate(() => window.__terminalBlurs)).toBe(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");
});

test("a tap while the IME animates open leaves the keyboard alone", async ({ page }) => {
  // The visual viewport reports a partial height loss until the IME finishes
  // opening. Reading that moment as "the keyboard is down" would make a tap
  // dismiss a keyboard the user had just opened, so only a viewport that has
  // fully recovered counts as dismissed.
  await openTerminal(page);
  await page.evaluate(() => window.__terminalTest.state.term.focus());
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");

  await setVisualViewportHeight(page, 420);
  // 760 is between "no keyboard" and the 20 % threshold: the IME is mid-flight.
  await setVisualViewportHeight(page, 760);

  await page.evaluate(() => {
    window.__terminalBlurs = 0;
    window.__terminalTest.state.term.textarea.addEventListener("blur", () => {
      window.__terminalBlurs += 1;
    });
  });
  const box = await page.locator(".xterm-screen").boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);

  expect(await page.evaluate(() => window.__terminalBlurs)).toBe(0);
  expect(await page.evaluate(() => document.activeElement?.className || ""))
    .toContain("xterm-helper-textarea");
});
