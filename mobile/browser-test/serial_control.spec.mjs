import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/app.js?*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() +
      "\nwindow.__control = { state, setConnected, applySerialControl, consumeSerialControl, enqueueBytes, onTerminalData, handleIncomingBytes, setMobileSidebarOpen, sendControl, bleTransport, connect };" });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__control?.state.term);
  await page.evaluate(() => {
    const { state, setConnected, applySerialControl } = window.__control;
    window.sent = [];
    state.mode = "ws";
    state.ws = { readyState: 1, send: bytes => window.sent.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)) };
    setConnected(true);
    applySerialControl({ self: 2, owner: 1, mode: "readonly", epoch: 3, peers: 2, capacity: 2 });
    window.__control.setMobileSidebarOpen(false, { restoreFocus: false });
  });
});

test("readonly blocks automatic replies and direct queued writes but enables typing", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const c = window.__control;
    c.onTerminalData("\x1b[1;1R", { userInput: false });
    c.handleIncomingBytes(new TextEncoder().encode("root@target:~# "));
    try { await c.enqueueBytes(new TextEncoder().encode("sudo reboot\r")); }
    catch (error) { return error.message; }
  });
  expect(result).toMatch(/Read-only|只读/);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.sent)).toEqual([]);
  /* Typing is enabled in a read-only session: the first keystroke asks for
   * the console when the other owner is idle. */
  await expect(page.locator("#breakButton")).toBeEnabled();
  await expect(page.locator("#serialControlButton")).toBeEnabled();
});

test("typing in a read-only session takes over the idle console seamlessly", async ({ page }) => {
  await page.evaluate(() => window.__control.onTerminalData("reboot\r"));
  await expect
    .poll(() => page.evaluate(() => window.sent))
    .toContain("@control claim idle");
  await page.evaluate(() => window.__control.consumeSerialControl(
    "OK control self=2 owner=2 mode=control epoch=4 peers=2 ble_max=2 linkr_reserved=0"));
  await expect
    .poll(() => page.evaluate(() => window.sent))
    .toEqual(expect.arrayContaining([expect.stringContaining("reboot")]));
});

test("control can be requested and released without disconnecting", async ({ page }) => {
  await page.locator("#serialControlButton").click();
  expect(await page.evaluate(() => window.sent)).toEqual(["@control claim"]);
  await page.evaluate(() => window.__control.consumeSerialControl(
    "OK control self=2 owner=2 mode=control epoch=4 peers=2 ble_max=2 linkr_reserved=0"));
  await expect(page.locator("#breakButton")).toBeEnabled();
  await page.locator("#serialControlButton").click();
  expect(await page.evaluate(() => window.sent)).toEqual(["@control claim", "@control release"]);
  await page.evaluate(() => window.__control.consumeSerialControl(
    "OK control self=2 owner=0 mode=available epoch=5 peers=2 ble_max=2 linkr_reserved=0"));
  /* Released is still an input-capable session: the next key takes the idle
   * console instead of asking the user to press Take control first. */
  await expect(page.locator("#breakButton")).toBeEnabled();
  expect(await page.evaluate(() => window.__control.state.connected)).toBe(true);
});

test("a queued write cannot survive loss and reacquisition of control", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const c = window.__control;
    c.applySerialControl({ self: 2, owner: 2, mode: "control", epoch: 4, peers: 2, capacity: 2 });
    let resume;
    c.state.writeQueue = new Promise(resolve => { resume = resolve; });
    const pending = c.enqueueBytes(new TextEncoder().encode("OLD\r")).catch(error => error.message);
    c.applySerialControl({ self: 2, owner: 1, mode: "readonly", epoch: 5, peers: 2, capacity: 2 });
    c.applySerialControl({ self: 2, owner: 2, mode: "control", epoch: 6, peers: 2, capacity: 2 });
    resume();
    return { error: await pending, sent: window.sent };
  });
  expect(result.error).toMatch(/Read-only|只读/);
  expect(result.sent).toEqual([]);
});

test("queued settings cannot cross a control handover", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const c = window.__control;
    c.state.mode = "ble"; c.state.mgmtReady = true; c.state.device = { id: "test-bee" };
    c.applySerialControl({ self: 2, owner: 2, mode: "control", epoch: 4, peers: 2, capacity: 2 });
    let resume, writes = 0;
    c.bleTransport.write = async () => { writes++; };
    c.state.controlWriteQueue = new Promise(resolve => { resume = resolve; });
    const pending = c.sendControl("@u=115200,8,n,1,n").catch(error => error.message);
    c.applySerialControl({ self: 2, owner: 1, mode: "readonly", epoch: 5, peers: 2, capacity: 2 });
    c.applySerialControl({ self: 2, owner: 2, mode: "control", epoch: 6, peers: 2, capacity: 2 });
    resume();
    return { error: await pending, writes };
  });
  expect(result.error).toMatch(/Read-only|只读/);
  expect(result.writes).toBe(0);
});

test("a BLE capability handshake queries and claims without invalidating itself", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const c = window.__control;
    c.setConnected(false);
    Object.assign(c.state, { mode: "ble", device: null, mgmtReady: false, reliableReady: false });
    let notify, incoming = [], commands = [], uartWrites = 0;
    window.handshakeCommands = commands;
    const encode = new TextEncoder();
    Object.assign(c.bleTransport, {
      isAvailable: () => true, initialize: async () => {},
      requestDevice: async () => ({ id: "multi-bee", name: "Linkr Bee Test" }),
      connect: async () => {}, disconnect: async () => {},
      startNotifications: async (_id, _service, uuid, callback) => {
        if (uuid.startsWith("4c4b0005")) notify = callback;
      },
      read: async (_id, _service, uuid) => {
        if (uuid.startsWith("4c4b0002")) {
          const data = new DataView(new ArrayBuffer(10));
          data.setUint8(0, 1); data.setUint16(2, 512, true); data.setUint32(4, 8 | 32 | 128, true);
          return data;
        }
        if (uuid.startsWith("4c4b0003")) {
          return new DataView(Uint8Array.from([...encode.encode("LINKRBLE"), 1, 0, 1, 2, 3, 4, 5, 6]).buffer);
        }
        const data = new DataView(new ArrayBuffer(16));
        data.setUint8(0, 1); data.setUint16(2, 232, true);
        data.setUint32(4, 1, true); data.setUint32(8, 1, true);
        return data;
      },
      write: async (_id, _service, uuid, bytes) => {
        if (!uuid.startsWith("4c4b0004")) { uartWrites++; return; }
        incoming.push(...bytes);
        if (incoming.length < 12) return;
        const frame = Uint8Array.from(incoming), view = new DataView(frame.buffer);
        if (frame.length < 12 + view.getUint16(8, true)) return;
        const command = new TextDecoder().decode(frame.slice(12));
        commands.push(command); incoming = [];
        const text = command === "@c?"
          ? "OK control self=2 owner=0 mode=available epoch=1 peers=1 ble_max=2 linkr_reserved=0"
          : command === "@c claim"
          ? "OK control self=2 owner=2 mode=control epoch=2 peers=1 ble_max=2 linkr_reserved=0"
          : command === "@linkr bonds?" ? "OK bonds pending=0 result=0\nBOND 0/AA:BB:CC:DD:EE:02 self=1\n"
          : command === "@linkr bonds label 0/AA:BB:CC:DD:EE:02" ? "OK bonds label=0/AA:BB:CC:DD:EE:02 none\r\n"
          : command === "@i?" ? "@info done\r\n" : "ERR unsupported\r\n";
        const payload = encode.encode(text), response = new Uint8Array(12 + payload.length);
        response.set([0x4c, 0x4b, 1, 2]);
        const header = new DataView(response.buffer);
        header.setUint32(4, view.getUint32(4, true), true);
        header.setUint16(8, payload.length, true); header.setUint16(10, 1, true);
        response.set(payload, 12); notify(response);
      },
    });
    await c.connect();
    return { connected: c.state.connected, mode: c.state.serialControl?.mode, commands, uartWrites };
  });
  expect(result.connected).toBe(true);
  expect(result.mode).toBe("control");
  expect(result.commands.slice(0, 2)).toEqual(["@c?", "@c claim"]);
  expect(result.uartWrites).toBe(0);
  await expect.poll(() => page.evaluate(() => window.handshakeCommands.filter(command =>
    command.startsWith("@linkr bonds name ")).length)).toBe(1);
  await page.evaluate(() => window.__control.applySerialControl({
    self:2, owner:1, mode:"readonly", epoch:3, peers:2, capacity:2,
  }));
  expect(await page.evaluate(() => window.handshakeCommands.filter(command =>
    command.startsWith("@linkr bonds name ")).length)).toBe(1);
});

for (const width of [390, 1200]) {
  test(`control toolbar fits at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    await page.evaluate(() => window.__control.setMobileSidebarOpen(false, { restoreFocus: false }));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__control.handleIncomingBytes(new TextEncoder().encode(
      "[    0.000000] Linux version 5.10.160\r\n[    1.423891] serial console ready\r\nroot@target:~# ")));
    const geometry = await page.locator(".term-tools").evaluate(el => {
      const box = el.getBoundingClientRect();
      const title = document.querySelector(".term-title").getBoundingClientRect();
      return { left: box.left, right: box.right, titleRight: title.right, viewport: innerWidth };
    });
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.titleRight);
    await expect(page.locator("#serialControlButton")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`control-${width}.png`) });
  });
}

// Outer toolbar bounds alone miss button text squeezed into a neighbour.
for (const width of [320, 390, 600, 844, 1200]) for (const lang of ['en','zh']) {
  test(`ownership labels never overlap at ${width}px (${lang})`, async ({page}) => {
    await page.setViewportSize({width,height:844});
    if (lang === 'zh') await page.locator('#langButton').evaluate(el=>el.click());
    for (const mode of ['readonly','control','available']) {
      await page.evaluate(mode=>window.__control.applySerialControl({self:2,owner:mode==='available'?0:1,mode,epoch:3,peers:2}),mode);
      for (const keyboard of [false,true]) {
        await page.evaluate(open=>{
          Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>open?400:844});visualViewport.dispatchEvent(new Event('resize'));
        },keyboard);
        if (keyboard) await expect(page.locator('html')).toHaveClass(/soft-keyboard-open/);
        else await expect(page.locator('html')).not.toHaveClass(/soft-keyboard-open/);
        await expect.poll(()=>page.locator('.terminal-head').evaluate(header=>{
          const r=header.getBoundingClientRect();
          const items=[...header.querySelectorAll('.term-title,.serial-control-status,.term-tool')].filter(el=>el.getBoundingClientRect().width);
          return items.every((el,index)=>{
            const box=el.getBoundingClientRect(),text=new Range();text.selectNodeContents(el);const ink=text.getBoundingClientRect();
            return box.left>=r.left && box.right<=r.right+1 && box.bottom<=r.bottom+1 && ink.left>=box.left-1 && ink.right<=box.right+1 &&
              items.slice(index+1).every(other=>{const next=other.getBoundingClientRect();return box.right<=next.left+1 || next.right<=box.left+1 || box.bottom<=next.top+1 || next.bottom<=box.top+1;});
          });
        })).toBe(true);
      }
    }
  });
}
