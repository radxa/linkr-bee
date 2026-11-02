/* Browser verification of the Android-only MCP settings card and approval
 * banner (web/mcp_ui.js) against a fake native bridge.
 *
 * On a real phone the bridge is installed by Capacitor (mobile/src/mcp-native.ts
 * -> window.LinkrMcp). Here `page.addInitScript` installs the same contract
 * (mobile/src/mcp-native.ts) before any app script runs, so the whole path —
 * app.js initMcp() -> web/mcp_server.js -> web/mcp_ui.js — is exercised in a
 * real Chromium: settings card rendering, start/stop state, endpoint/token
 * display, audit list and the on-phone approval banner.
 *
 * Only the test file is part of the repo; the fake bridge and the fake device
 * executor live entirely inside the browser session. No app source is modified.
 */
import { test, expect } from "@playwright/test";

const TOKEN_A = "0123456789abcdef".repeat(4); // 64 hex chars, as the native side sends
const TOKEN_B = "fedcba9876543210".repeat(4);
const CONFIG_KEY = "linkr-mcp-config-v1";
const REMOTE = "192.168.1.20:49312";

/* ------------------------------------------------------------------ *
 * Fake native bridge (window.LinkrMcp)
 * ------------------------------------------------------------------ */
async function installFakeBridge(page) {
  await page.addInitScript(
    ({ tokenA, tokenB }) => {
      const state = {
        running: false,
        port: 8712,
        bind: "lan",
        token: "",
        url: "",
        urls: [],
        foreground: true,
        activeRequests: 0,
        lastError: null,
      };
      const clone = () => JSON.parse(JSON.stringify(state));
      const listeners = { httpRequest: [], stateChanged: [], approvalAction: [], requestCancelled: [] };

      /* Answer log and call log the spec reads back with page.evaluate(). */
      window.__mcpCalls = {
        start: [],
        stop: 0,
        getState: 0,
        regenerateToken: 0,
        respond: 0,
        addListener: [],
        showApproval: [],
        cancelApproval: [],
      };
      window.__mcpResponses = [];
      /* Tests can make the platform refuse to post a notification. */
      window.__mcpApprovalAvailable = true;

      const emitState = () => {
        const snapshot = clone();
        for (const cb of listeners.stateChanged) {
          try {
            cb(snapshot);
          } catch {
            /* a UI listener must not break the transport */
          }
        }
      };

      window.LinkrMcp = {
        available: true,
        platform: "android",
        async start(config) {
          window.__mcpCalls.start.push({ port: config?.port, bind: config?.bind });
          state.running = true;
          state.port = config?.port;
          state.bind = config?.bind;
          state.token = tokenA;
          const loopback = `http://127.0.0.1:${state.port}/mcp`;
          const lan = `http://192.168.1.50:${state.port}/mcp`;
          state.url = state.bind === "loopback" ? loopback : lan;
          state.urls = state.bind === "loopback" ? [loopback] : [loopback, lan];
          state.lastError = null;
          emitState();
          return clone();
        },
        async stop() {
          window.__mcpCalls.stop += 1;
          state.running = false;
          state.activeRequests = 0;
          emitState();
          return clone();
        },
        async getState() {
          window.__mcpCalls.getState += 1;
          return clone();
        },
        async regenerateToken() {
          window.__mcpCalls.regenerateToken += 1;
          state.token = state.token === tokenA ? tokenB : tokenA;
          emitState();
          return clone();
        },
        async respond(input) {
          window.__mcpCalls.respond += 1;
          window.__mcpResponses.push({ ...input });
        },
        async showApproval(input) {
          window.__mcpCalls.showApproval.push({ ...input });
          return window.__mcpApprovalAvailable !== false;
        },
        async cancelApproval(id) {
          window.__mcpCalls.cancelApproval.push(id);
        },
        async addListener(event, cb) {
          window.__mcpCalls.addListener.push(event);
          listeners[event]?.push(cb);
          return {
            remove: async () => {
              const list = listeners[event] || [];
              const index = list.indexOf(cb);
              if (index >= 0) list.splice(index, 1);
            },
          };
        },
      };

      /* Emit native -> JS events from page.evaluate(). */
      window.__mcpEmit = {
        http(payload) {
          for (const cb of listeners.httpRequest) {
            cb({ method: "POST", path: "/mcp", userAgent: "mcp-ui-spec/1.0", ...payload });
          }
        },
        state(patch) {
          Object.assign(state, patch || {});
          emitState();
        },
        approvalAction(payload) {
          for (const cb of listeners.approvalAction) cb({ ...payload });
        },
      };

      window.__mcpTestExecutions = [];
    },
    { tokenA: TOKEN_A, tokenB: TOKEN_B },
  );
}

/* Preload a stored MCP configuration so the card starts with non-default values.
 * app.js's initMcp() reads it through mcp_server.js loadConfig(). */
async function preloadMcpConfig(page, config) {
  await page.addInitScript(([key, value]) => {
    try {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: the test will fail on the visible default value */
    }
  }, [CONFIG_KEY, JSON.stringify(config)]);
}

/* ------------------------------------------------------------------ *
 * Test-only hook into app.js internals
 *
 * The real MCP write path executes through agentPanel.getDevice(), which only
 * exists after a real BLE/LAN connection. These tests need a "target connected"
 * precondition to reach the approval + execution path, so app.js is intercepted
 * once to expose the panel object; the spec then swaps only getDevice() for a
 * fake executor. Everything above it (host, approval UI, audit, serial gate) is
 * the unchanged product code.
 * ------------------------------------------------------------------ */
async function exposeAppInternals(page) {
  await page.route("**/app.js*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      response,
      body:
        body +
        "\nwindow.__mcpTest = {\n" +
        "  installDevice(device) { agentPanel.getDevice = () => device; },\n" +
        "  clearDevice() { agentPanel.getDevice = () => null; },\n" +
        "  get host() { return mcpHost; },\n" +
        "  get panel() { return agentPanel; },\n" +
        "  get resident() { return residentAgent; },\n" +
        "};\n",
    });
  });
}

async function installFakeDevice(page) {
  // app.js is intercepted above; wait for the appended hook (a cold Vite reload
  // can race the first evaluate()).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__mcpTest)), { timeout: 10_000 })
    .toBe(true);
  await page.evaluate(() => {
    window.__mcpTestExecutions = [];
    window.__mcpTest.installDevice({
      getStatus: () => ({
        connected: true,
        transport: "ble",
        device: "Linkr Bee Test",
        deviceId: "test-device-1",
        uart: "115200 8n1",
        receivedBytes: 42,
        sentBytes: 7,
        console: "unknown",
        executionMode: "unknown",
      }),
      execute: async (args, signal, options) => {
        window.__mcpTestExecutions.push({
          args,
          userApproved: Boolean(options?.userApproved),
        });
        return {
          id: "exec-1",
          delivery: "sent",
          executionStatus: "sent",
          observation: "quiet",
          evidence: "",
          evidenceStart: 0,
          evidenceTruncated: false,
          observedCursor: 0,
          latestCursor: 0,
          hasMore: false,
        };
      },
    });
  });
}

/* ------------------------------------------------------------------ *
 * Navigation + event helpers
 * ------------------------------------------------------------------ */
async function openApp(page) {
  await page.goto("/");
  await expect(page.locator("#agentButton")).toBeVisible();
}

async function openAiSettings(page) {
  await page.locator("#panelToggle").tap();
  await page.locator('[data-settings-target="ai"]').tap();
  await expect(page.locator("#agentSettings")).toBeVisible();
}

/* Put the MCP card's top just below the drawer's sticky header + tab strip so
 * taps are not intercepted and the card can be captured cleanly. */
async function revealMcpCard(page) {
  await page.evaluate(() => {
    const drawer = document.querySelector("#controlsPanel");
    const card = document.getElementById("mcpSettings");
    if (!drawer || !card) return;
    const chrome =
      (document.querySelector(".drawer-head")?.offsetHeight || 0) +
      (document.querySelector(".settings-tabs")?.offsetHeight || 0);
    const delta =
      card.getBoundingClientRect().top -
      drawer.getBoundingClientRect().top -
      chrome -
      8;
    drawer.scrollTop = Math.max(0, drawer.scrollTop + delta);
  });
}

/* The drawer header/tabs are sticky; an element screenshot would otherwise be
 * painted over by them at the top of the card. They are unrelated chrome, so
 * they are taken out of the sticky layout for the duration of the capture.
 * The drawer is position:fixed, so its layer only paints inside the viewport:
 * a taller viewport lets the whole (tall) card be captured in one image. */
async function screenshotMcpCard(page, path) {
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport.width, height: 1600 });
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.id = "mcp-spec-shot-clean";
    style.textContent =
      "html.settings-drawer-layout .drawer-head, html.settings-drawer-layout .settings-tabs { position: static !important; }";
    document.head.append(style);
  });
  await revealMcpCard(page);
  await page.locator("#mcpSettings").screenshot({ path });
  await page.evaluate(() => document.getElementById("mcp-spec-shot-clean")?.remove());
  await page.setViewportSize(viewport);
}

async function emitHttpRequest(page, { id, body, remote = REMOTE }) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  await page.evaluate(
    ({ id, text, remote }) => {
      window.__mcpEmit.http({ id, body: text, remote });
    },
    { id, text, remote },
  );
}

async function callRpc(page, { bridgeId, rpcId, method, params }) {
  await emitHttpRequest(page, {
    id: bridgeId,
    body: { jsonrpc: "2.0", id: rpcId, method, params },
  });
}

async function waitForResponse(page, bridgeId) {
  await expect
    .poll(
      () =>
        page.evaluate((id) => window.__mcpResponses.find((r) => r.id === id) ?? null, bridgeId),
      { timeout: 10_000 },
    )
    .not.toBeNull();
  return page.evaluate((id) => window.__mcpResponses.find((r) => r.id === id), bridgeId);
}

function parsedResponse(response) {
  return JSON.parse(response.body);
}

function resultText(payload) {
  return payload?.result?.content?.[0]?.text ?? "";
}

async function enableMcp(page) {
  await page.locator("#mcpEnabled").check();
  await expect.poll(() => page.evaluate(() => window.__mcpCalls.start.length)).toBeGreaterThan(0);
  await expect(page.locator("#mcpEndpointBlock")).toBeVisible();
}

/* ------------------------------------------------------------------ *
 * (a) The card exists only when the Android bridge is installed
 * ------------------------------------------------------------------ */
test("MCP settings card is absent without the native Android bridge", async ({ page }) => {
  await openApp(page);
  expect(await page.evaluate(() => window.LinkrMcp)).toBeUndefined();

  await openAiSettings(page);
  // The regular AI settings section is untouched...
  await expect(page.locator("#agentSettings")).toBeVisible();
  // ...and no MCP card or approval banner was created at all.
  await expect(page.locator("#mcpSettings")).toHaveCount(0);
  await expect(page.locator("#mcpApproval")).toHaveCount(0);
  await expect(page.locator("#controlsPanel")).not.toContainText(/MCP server|MCP 服务器/);
});

/* ------------------------------------------------------------------ *
 * (a) + (b) Card appears on the AI tab; enabling starts the bridge,
 *           reveals the endpoint and a masked token
 * ------------------------------------------------------------------ */
test("MCP card appears under the AI tab and enabling starts the bridge with the configured port/bind", async ({ page }) => {
  await installFakeBridge(page);
  await openApp(page);
  await openAiSettings(page);

  // The section is mounted next to the AI settings card and only shows on that tab.
  await expect(page.locator("#mcpSettings")).toBeVisible();
  expect(
    await page.evaluate(() => document.getElementById("mcpSettings")?.parentElement?.className),
  ).toContain("agent-settings-scroll");
  expect(
    await page.evaluate(() => document.getElementById("mcpSettings")?.previousElementSibling?.id),
  ).toBe("agentPrivacyCard");
  expect(await page.locator("#mcpSettings .agent-settings-scroll").count()).toBe(0);
  expect(await page.locator("#mcpSettings > .card-title > .card-toggle")).toHaveCount(1);
  await page.locator("#mcpSettings > .card-title").click();
  await expect(page.locator("#mcpSettings")).toHaveClass(/is-collapsed/);
  await page.locator("#mcpSettings > .card-title").click();
  await expect(page.locator("#mcpSettings")).not.toHaveClass(/is-collapsed/);
  const chevronCenters = await page.evaluate(() =>
    [...document.querySelectorAll("#agentSettings .card")].flatMap((card) => {
      const title = card.querySelector(":scope > .card-title");
      if (!title) return [];
      const titleRect = title.getBoundingClientRect();
      const toggle = title.querySelector(":scope > .card-toggle");
      if (toggle) {
        const rect = toggle.getBoundingClientRect();
        return [rect.left + rect.width / 2];
      }
      const style = getComputedStyle(title, "::after");
      const width = parseFloat(style.width) || 0;
      const margin = parseFloat(style.marginRight) || 0;
      const paddingRight = parseFloat(getComputedStyle(title).paddingRight) || 0;
      return width ? [titleRect.right - paddingRight - margin - width / 2] : [];
    }),
  );
  expect(Math.max(...chevronCenters) - Math.min(...chevronCenters)).toBeLessThanOrEqual(0.5);
  expect(
    await page.evaluate(() => {
      const body = document.querySelector("#mcpSettings .mcp-settings-body");
      return body ? body.scrollWidth <= body.clientWidth + 1 : false;
    }),
  ).toBe(true);
  await page.locator('[data-settings-target="connection"]').tap();
  await expect(page.locator("#mcpSettings")).toBeHidden();
  await page.locator('[data-settings-target="ai"]').tap();
  await expect(page.locator("#mcpSettings")).toBeVisible();
  await revealMcpCard(page);

  // Defaults come from web/mcp_server.js: port 8712, bind lan, access confirm.
  await expect(page.locator("#mcpPort")).toHaveValue("8712");
  await expect(page.locator("#mcpBind")).toHaveValue("lan");
  await expect(page.locator("#mcpAccess")).toHaveValue("confirm");
  // The four access modes are always listed in restrictive -> permissive order.
  await expect(page.locator("#mcpAccess option")).toHaveCount(4);
  await expect(page.locator("#mcpAccess option")).toHaveText([
    /Read-only: no approval needed|只读（不需要授权）/,
    /Read and write: every command needs approval|写入（每条命令需要授权）/,
    /Read and write: only high-risk commands need approval|写入（仅高危命令需要授权）/,
    /Read and write: fully authorized|写入（完全授权）/,
  ]);
  await expect(page.locator("#mcpEnabled")).not.toBeChecked();
  await expect(page.locator("#mcpEndpointBlock")).toBeHidden();
  await expect(page.locator("#mcpStatus")).toContainText(/Disabled|未启用/);

  await enableMcp(page);

  // The host and UI register their bridge event subscriptions during initMcp().
  await expect
    .poll(() => page.evaluate(() => [...new Set(window.__mcpCalls.addListener)].sort()))
    .toEqual(["approvalAction", "httpRequest", "requestCancelled", "stateChanged"]);

  // The bridge received exactly the configured port/bind, and the card mirrors
  // the native snapshot (endpoint + 64-hex token, masked with type=password).
  expect(await page.evaluate(() => window.__mcpCalls.start)).toEqual([
    { port: 8712, bind: "lan" },
  ]);
  await expect(page.locator("#mcpUrl")).toHaveValue("http://192.168.1.50:8712/mcp");
  await expect(page.locator("#mcpA2aCard")).toHaveValue("http://192.168.1.50:8712/.well-known/agent-card.json");
  await expect(page.locator("#mcpToken")).toHaveAttribute("type", "password");
  await expect(page.locator("#mcpToken")).toHaveValue(TOKEN_A);
  await expect(page.locator("#mcpTokenToggle")).toHaveText(/Show token|显示令牌/);
  await expect(page.locator("#mcpTokenToggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#mcpStatus")).toContainText(/Running|运行中/);
  await expect(page.locator("#mcpStatus")).toContainText("http://192.168.1.50:8712/mcp");
  await expect(page.locator("#mcpRegenerate")).toBeEnabled();
  // The copyable client snippet carries the same URL and bearer token.
  await expect(page.locator("#mcpSnippet")).toContainText("http://192.168.1.50:8712/mcp");
  await expect(page.locator("#mcpSnippet")).toContainText(`Bearer ${TOKEN_A}`);

  await screenshotMcpCard(page, "/tmp/mcp-ui-card.png");

  // "Show token" unmasks it; the value was only hidden by input type.
  await page.locator("#mcpTokenToggle").tap();
  await expect(page.locator("#mcpToken")).toHaveAttribute("type", "text");
  await expect(page.locator("#mcpTokenToggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#mcpTokenToggle")).toHaveText(/Hide token|隐藏令牌/);
  await expect(page.locator("#mcpToken")).toHaveValue(TOKEN_A);

  // Rotation goes through the native bridge and the card shows the new token.
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#mcpRegenerate").tap();
  await expect(page.locator("#mcpToken")).toHaveValue(TOKEN_B);
  expect(await page.evaluate(() => window.__mcpCalls.regenerateToken)).toBe(1);

  // Disabling stops the native server and hides the endpoint/token block.
  await revealMcpCard(page);
  await page.locator("#mcpEnabled").uncheck();
  await expect.poll(() => page.evaluate(() => window.__mcpCalls.stop)).toBe(1);
  await expect(page.locator("#mcpEndpointBlock")).toBeHidden();
  await expect(page.locator("#mcpStatus")).toContainText(/Disabled|未启用/);
});

/* ------------------------------------------------------------------ *
 * (b) Non-default configured port/bind are what the bridge is started with
 * ------------------------------------------------------------------ */
test("enabling starts the bridge with a stored non-default port and loopback bind", async ({ page }) => {
  await installFakeBridge(page);
  await preloadMcpConfig(page, {
    enabled: false,
    port: 9400,
    bind: "loopback",
    access: "confirm",
  });
  await openApp(page);
  await openAiSettings(page);
  await revealMcpCard(page);

  await expect(page.locator("#mcpPort")).toHaveValue("9400");
  await expect(page.locator("#mcpBind")).toHaveValue("loopback");
  await enableMcp(page);

  expect(await page.evaluate(() => window.__mcpCalls.start)).toEqual([
    { port: 9400, bind: "loopback" },
  ]);
  await expect(page.locator("#mcpUrl")).toHaveValue("http://127.0.0.1:9400/mcp");
  await expect(page.locator("#mcpStatus")).toContainText("http://127.0.0.1:9400/mcp");
});

/* ------------------------------------------------------------------ *
 * (c) An answered external tools/call shows up in the audit list
 * ------------------------------------------------------------------ */
test("an answered external tools/call is listed in the audit panel", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);
  await revealMcpCard(page);

  await page.locator("#mcpAudit > summary").tap();
  await expect(page.locator("#mcpAudit")).toHaveAttribute("open", "");
  await expect(page.locator("#mcpAuditList")).toContainText(
    /No external calls yet|还没有外部调用/,
  );

  await callRpc(page, {
    bridgeId: "req-status",
    rpcId: "rpc-status",
    method: "tools/call",
    params: { name: "get_device_status", arguments: {} },
  });

  const response = await waitForResponse(page, "req-status");
  expect(response.status).toBe(200);
  const payload = parsedResponse(response);
  expect(payload.jsonrpc).toBe("2.0");
  expect(payload.id).toBe("rpc-status");
  const toolData = JSON.parse(resultText(payload));
  expect(toolData).toMatchObject({
    connected: true,
    transport: "ble",
    device: "Linkr Bee Test",
    deviceId: "test-device-1",
  });
  // The answer went back through the native bridge, not just into the DOM.
  expect(await page.evaluate(() => window.__mcpCalls.respond)).toBe(1);

  // The audit row names the tool, the outcome and the remote client.
  const row = page.locator("#mcpAuditList .mcp-audit-row").first();
  await expect(row).toContainText(/Read device status|读取设备状态/);
  await expect(row).toContainText(/ok/);
  await expect(row).toContainText(REMOTE);
});

/* ------------------------------------------------------------------ *
 * (d) A write tool raises the on-phone approval banner:
 *     deny -> isError result and nothing executed
 *     allow -> the app's write path runs once
 * ------------------------------------------------------------------ */
test("a write tool needs on-phone approval: deny answers isError, allow executes", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);

  // The banner is outside the settings panel: close the drawer first, exactly
  // as a user reading the terminal would be when the external write arrives.
  await page.locator("#drawerClose").tap();
  await expect(page.locator("#controlsPanel")).toHaveAttribute("aria-hidden", "true");
  // Wait for the 240 ms slide-out so the banner screenshot shows the terminal,
  // not the settings sheet half-way off screen.
  await expect
    .poll(() =>
      page
        .locator("#controlsPanel")
        .evaluate((el) => Math.round(el.getBoundingClientRect().right)),
    )
    .toBeLessThanOrEqual(0);

  await callRpc(page, {
    bridgeId: "req-deny",
    rpcId: "rpc-deny",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "reboot", appendEnter: true } },
  });

  const banner = page.locator("#mcpApproval");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("role", "alertdialog");
  await expect(banner.locator(".mcp-approval-title")).toHaveText(
    /An AI client requests approval|AI 请求执行操作/,
  );
  await expect(banner.locator(".mcp-approval-tool")).toHaveText(
    /Send serial input|发送串口输入/,
  );
  await expect(banner.locator(".mcp-approval-args")).toContainText('"text": "reboot"');
  await expect(banner.locator(".mcp-approval-args")).toContainText('"appendEnter": true');
  // Nothing was answered while the human is still deciding.
  expect(
    await page.evaluate(() => window.__mcpResponses.some((r) => r.id === "req-deny")),
  ).toBe(false);
  await page.screenshot({ path: "/tmp/mcp-ui-approval.png" });

  await banner.locator('[data-mcp="approvalDeny"]').tap();
  const denied = parsedResponse(await waitForResponse(page, "req-deny"));
  expect(denied.result.isError).toBe(true);
  expect(resultText(denied)).toBe("Not executed: Denied; nothing was executed.");
  await expect(banner).toBeHidden();
  expect(await page.evaluate(() => window.__mcpTestExecutions)).toEqual([]);

  // Second request: allow this time and check the write reaches the device
  // executor once, with the MCP approval recorded as userApproved.
  await callRpc(page, {
    bridgeId: "req-allow",
    rpcId: "rpc-allow",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "reboot", appendEnter: true } },
  });
  await expect(banner).toBeVisible();
  await banner.locator('[data-mcp="approvalAllow"]').tap();

  const allowed = parsedResponse(await waitForResponse(page, "req-allow"));
  expect(allowed.result.isError).toBeUndefined();
  const execution = JSON.parse(resultText(allowed));
  expect(execution.source).toBe("serial-execution");
  expect(execution.id).toBe("exec-1");
  expect(execution.delivery).toBe("sent");
  expect(execution.note).toContain("Delivery is not command completion");
  await expect(banner).toBeHidden();
  expect(await page.evaluate(() => window.__mcpTestExecutions)).toEqual([
    { args: { text: "reboot", appendEnter: true }, userApproved: true },
  ]);
});

/* ------------------------------------------------------------------ *
 * (d) Read-only access refuses a write tool with an isError result and
 *     never asks the phone (no approval banner)
 * ------------------------------------------------------------------ */
test("read-only access refuses a write tool without raising the approval banner", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);
  await revealMcpCard(page);

  await page.locator("#mcpAccess").selectOption("read");
  await expect(page.locator("#mcpAccess")).toHaveValue("read");
  await expect(page.locator("#mcpAccess")).toBeEnabled();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("linkr-mcp-config-v1")).access),
  ).toBe("read");

  await callRpc(page, {
    bridgeId: "req-readonly",
    rpcId: "rpc-readonly",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "reboot", appendEnter: true } },
  });

  const response = await waitForResponse(page, "req-readonly");
  const payload = parsedResponse(response);
  expect(payload.result.isError).toBe(true);
  expect(resultText(payload)).toContain("read-only mode is enabled on the phone");
  await expect(page.locator("#mcpApproval")).toBeHidden();
  expect(await page.evaluate(() => window.__mcpTestExecutions)).toEqual([]);
  // The refusal is audited even though no approval was requested.
  await expect(page.locator("#mcpAuditList")).toContainText(/denied/);
});

/* ------------------------------------------------------------------ *
 * (f) No-confirmation access: the write runs without the approval banner
 * ------------------------------------------------------------------ */
test("no-confirmation access runs a write without the approval banner", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);
  await revealMcpCard(page);

  await expect(page.locator("#mcpAutoWarning")).toBeHidden();
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#mcpAccess").selectOption("auto");
  await expect(page.locator("#mcpAccess")).toHaveValue("auto");
  await expect(page.locator("#mcpAutoWarning")).toBeVisible();
  await expect(page.locator("#mcpAutoWarning")).toContainText("Write approval is off");
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("linkr-mcp-config-v1")).access),
  ).toBe("auto");

  await callRpc(page, {
    bridgeId: "req-auto",
    rpcId: "rpc-auto",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "uname -a", appendEnter: true } },
  });
  const response = await waitForResponse(page, "req-auto");
  const payload = parsedResponse(response);
  expect(payload.result.isError).toBeUndefined();
  expect(resultText(payload)).toContain("serial-execution");
  await expect(page.locator("#mcpApproval")).toBeHidden();
  const executions = await page.evaluate(() => window.__mcpTestExecutions);
  expect(executions).toHaveLength(1);
  expect(executions[0].userApproved).toBe(true);

  /* Cancelling the one-time security prompt leaves the previous mode selected. */
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.dismiss());
  await page.locator("#mcpAccess").selectOption("confirm");
  await expect(page.locator("#mcpAccess")).toHaveValue("confirm");
  await page.locator("#mcpAccess").selectOption("auto");
  await expect(page.locator("#mcpAccess")).toHaveValue("confirm");
  await expect(page.locator("#mcpAutoWarning")).toBeHidden();
});

/* ------------------------------------------------------------------ *
 * (g) High-risk-only access: safe writes run directly, destructive shell
 *     input still raises the approval banner
 * ------------------------------------------------------------------ */
test("high-risk-only access runs safe writes but still approves destructive input", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);
  await revealMcpCard(page);

  // Moving from the default every-command mode asks once before loosening.
  await expect(page.locator("#mcpGuardedWarning")).toBeHidden();
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#mcpAccess").selectOption("guarded");
  await expect(page.locator("#mcpAccess")).toHaveValue("guarded");
  await expect(page.locator("#mcpGuardedWarning")).toBeVisible();
  await expect(page.locator("#mcpGuardedWarning")).toContainText("best-effort");
  await expect(page.locator("#mcpAutoWarning")).toBeHidden();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("linkr-mcp-config-v1")).access),
  ).toBe("guarded");

  // A benign command does not ask and reaches the executor once.
  await callRpc(page, {
    bridgeId: "req-guarded-safe",
    rpcId: "rpc-guarded-safe",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "uname -a", appendEnter: true } },
  });
  const safe = parsedResponse(await waitForResponse(page, "req-guarded-safe"));
  expect(safe.result.isError).toBeUndefined();
  expect(resultText(safe)).toContain("serial-execution");
  await expect(page.locator("#mcpApproval")).toBeHidden();

  // Destructive shell input is still gated by the approval banner.
  await callRpc(page, {
    bridgeId: "req-guarded-risky",
    rpcId: "rpc-guarded-risky",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "rm -rf /tmp/x", appendEnter: true } },
  });
  const banner = page.locator("#mcpApproval");
  await expect(banner).toBeVisible();
  await expect(banner.locator(".mcp-approval-args")).toContainText("rm -rf /tmp/x");
  await banner.locator('[data-mcp="approvalDeny"]').tap();
  const risky = parsedResponse(await waitForResponse(page, "req-guarded-risky"));
  expect(risky.result.isError).toBe(true);
  expect(resultText(risky)).toBe("Not executed: Denied; nothing was executed.");
  await expect(banner).toBeHidden();
  const executions = await page.evaluate(() => window.__mcpTestExecutions);
  expect(executions).toEqual([
    { args: { text: "uname -a", appendEnter: true }, userApproved: true },
  ]);

  /* Cancelling the one-time prompt keeps the previous selection. */
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.dismiss());
  await page.locator("#mcpAccess").selectOption("confirm");
  await expect(page.locator("#mcpAccess")).toHaveValue("confirm");
  await page.locator("#mcpAccess").selectOption("guarded");
  await expect(page.locator("#mcpAccess")).toHaveValue("confirm");
  await expect(page.locator("#mcpGuardedWarning")).toBeHidden();
});

/* ------------------------------------------------------------------ *
 * (g) Hidden page: approvals happen in the platform notification
 * ------------------------------------------------------------------ */
async function hidePage(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
  });
  await expect.poll(
    () => page.evaluate(() => window.__mcpCalls.addListener.includes("approvalAction")),
  ).toBe(true);
}

async function waitForApprovalNotification(page) {
  await expect.poll(() => page.evaluate(() => window.__mcpCalls.showApproval.length)).toBeGreaterThan(0);
  return page.evaluate(() => window.__mcpCalls.showApproval.at(-1));
}

test("a hidden page asks through a notification and executes when Allow is tapped", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);
  await revealMcpCard(page);
  await hidePage(page);

  await callRpc(page, {
    bridgeId: "req-notif-allow",
    rpcId: "rpc-notif-allow",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "uname -a", appendEnter: true } },
  });
  const notification = await waitForApprovalNotification(page);
  expect(notification.id).toBeTruthy();
  expect(notification.body).toContain("Send serial input");
  await expect(page.locator("#mcpApproval")).toBeHidden();

  await page.evaluate((id) => window.__mcpEmit.approvalAction({ id, approved: true }), notification.id);
  const response = await waitForResponse(page, "req-notif-allow");
  const payload = parsedResponse(response);
  expect(payload.result.isError).toBeUndefined();
  expect(resultText(payload)).toContain("serial-execution");
  const executions = await page.evaluate(() => window.__mcpTestExecutions);
  expect(executions).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.__mcpCalls.cancelApproval)).toContain(notification.id);
});

test("a notification Deny answers isError and executes nothing", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);
  await revealMcpCard(page);
  await hidePage(page);

  await callRpc(page, {
    bridgeId: "req-notif-deny",
    rpcId: "rpc-notif-deny",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "reboot", appendEnter: true } },
  });
  const notification = await waitForApprovalNotification(page);
  await page.evaluate((id) => window.__mcpEmit.approvalAction({ id, approved: false }), notification.id);
  const response = await waitForResponse(page, "req-notif-deny");
  const payload = parsedResponse(response);
  expect(payload.result.isError).toBe(true);
  /* The notification UI supplies its localized denial reason; the host returns it. */
  expect(resultText(payload)).toContain("Not executed: Denied");
  expect(await page.evaluate(() => window.__mcpTestExecutions)).toEqual([]);
});

test("a hidden page without notification permission refuses instead of hanging", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);
  await revealMcpCard(page);
  await page.evaluate(() => { window.__mcpApprovalAvailable = false; });
  await hidePage(page);

  await callRpc(page, {
    bridgeId: "req-notif-unavailable",
    rpcId: "rpc-notif-unavailable",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "ls", appendEnter: true } },
  });
  const response = await waitForResponse(page, "req-notif-unavailable");
  const payload = parsedResponse(response);
  expect(payload.result.isError).toBe(true);
  expect(resultText(payload)).toContain("Not executed: The app is not in the foreground");
  expect(await page.evaluate(() => window.__mcpTestExecutions)).toEqual([]);
});

async function prepareResidentUi(page, { lang = "en", theme = "dark" } = {}) {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem("linkr-lang", lang);
    localStorage.setItem("linkr-theme", theme);
    localStorage.setItem("linkr-agent-model", JSON.stringify({
      endpoint: "https://model.test/v1", model: "test", apiKey: "test",
      provider: "openai-completions", reasoning: "off", contextWindow: 128000, maxTokens: 4096,
    }));
    window.__testRunners = [];
  }, { lang, theme });
  await page.route(/\/(?:agent_runtime\.js|agent-runtime\.mjs)(?:\?.*)?$/, route =>
    route.fulfill({ contentType: "text/javascript", body: `
      export const available = true;
      export async function createSerialAgent() {
        let release;
        const runner = {
          prompt: () => new Promise(resolve => { release = resolve; }),
          abort: () => release?.({}),
          snapshot: () => [],
        };
        window.__testRunners.push(runner);
        return runner;
      }` }));
  await openApp(page);
  await installFakeDevice(page);
  await page.locator("#agentButton").click();
  await expect(page.locator("#agentPanel")).toBeVisible();
}

for (const [width, lang, theme] of [[390, "zh", "light"], [390, "en", "dark"], [834, "zh", "dark"], [1440, "en", "light"]]) {
  test(`resident task owns the local Stop button and excludes human submissions (${width}/${lang}/${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await prepareResidentUi(page, { lang, theme });
    const ids = await page.evaluate(() => {
      const agent = window.__mcpTest.resident;
      return [agent.startTask({ request: "active task" }).taskId,
        agent.startTask({ request: "queued task" }).taskId];
    });
    await expect.poll(() => page.evaluate(() => window.__testRunners.length)).toBe(1);
    await expect(page.locator("#agentResidentStatus")).toBeVisible();
    await expect(page.locator("#agentStop")).toBeEnabled();
    await expect(page.locator("#agentAsk")).toBeDisabled();
    await page.locator("#agentQuestion").fill("must not start concurrently");
    await page.locator("#agentForm").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(await page.evaluate(() => window.__testRunners.length)).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("resident-stop.png") });
    await page.locator("#agentStop").click();
    await expect.poll(() => page.evaluate(() => window.__mcpTest.resident.isBusy())).toBe(false);
    expect(await page.evaluate(async ids => Promise.all(ids.map(async id => (await window.__mcpTest.resident.getTask(id)).state)), ids))
      .toEqual(["canceled", "canceled"]);
    await expect(page.locator("#agentAsk")).toBeEnabled();
    await expect(page.locator("#agentStop")).toBeDisabled();
    await expect(page.locator("#agentResidentStatus")).toBeHidden();
    // The existing draft survives cancellation and becomes a normal local run.
    await page.locator("#agentAsk").click();
    await expect.poll(() => page.evaluate(() => window.__testRunners.length)).toBe(2);
    const error = await page.evaluate(() => {
      try { window.__mcpTest.resident.startTask({ request: "cannot interrupt human" }); return ""; }
      catch (error) { return error.message; }
    });
    expect(error).toMatch(/assistant is busy/);
    await page.locator("#agentStop").click();
  });
}

/* ------------------------------------------------------------------ *
 * (h) Review regressions: banner reachability and visible status messages
 * ------------------------------------------------------------------ */

test("the approval banner paints above the terminal fullscreen fallback", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);
  /* app.js falls back to this class on WebViews that reject requestFullscreen;
   * the terminal then paints at z-index 1000 and would otherwise cover the
   * banner, leaving the write to time out unseen. */
  await page.evaluate(() => {
    document.getElementById("terminalCard").classList.add("terminal-fullscreen-fallback");
    document.body.classList.add("terminal-fullscreen-fallback");
  });
  await callRpc(page, {
    bridgeId: "req-fallback",
    rpcId: "rpc-fallback",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "uname -a", appendEnter: true } },
  });
  const banner = page.locator("#mcpApproval");
  await expect(banner).toBeVisible();
  const topmost = await page.evaluate(() => {
    const element = document.getElementById("mcpApproval");
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (!hit) return "none";
    return hit.closest("#mcpApproval") ? "banner" : `${hit.tagName}#${hit.id}`;
  });
  expect(topmost).toBe("banner");
  await banner.locator('[data-mcp="approvalDeny"]').tap();
  await waitForResponse(page, "req-fallback");
  await page.evaluate(() => {
    document.getElementById("terminalCard").classList.remove("terminal-fullscreen-fallback");
    document.body.classList.remove("terminal-fullscreen-fallback");
  });
});

test("the approval banner moves into the fullscreen element and is restored afterwards", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await installFakeDevice(page);
  await openAiSettings(page);
  await enableMcp(page);
  /* Headless Chromium has no reliable user-gesture fullscreen; a readable
   * fullscreenElement exercises the same branch App code sees on a phone. The
   * drawer is closed so it cannot intercept the banner (on a phone the terminal
   * is fullscreen and the drawer is not showing). */
  await page.locator("#drawerClose").tap();
  await expect(page.locator("#controlsPanel")).toHaveAttribute("aria-hidden", "true");
  await page.evaluate(() => {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => document.getElementById("terminalCard"),
    });
  });
  await callRpc(page, {
    bridgeId: "req-fullscreen",
    rpcId: "rpc-fullscreen",
    method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "pwd", appendEnter: true } },
  });
  const banner = page.locator("#mcpApproval");
  await expect(banner).toBeVisible();
  expect(
    await page.evaluate(() => document.getElementById("mcpApproval")?.parentElement?.id),
  ).toBe("terminalCard");
  await banner.locator('[data-mcp="approvalDeny"]').tap();
  await waitForResponse(page, "req-fullscreen");
  await expect(banner).toBeHidden();
  expect(
    await page.evaluate(() => document.getElementById("mcpApproval")?.parentElement?.tagName),
  ).toBe("BODY");
  await page.evaluate(() => { delete document.fullscreenElement; });
});

test("an invalid port error and the token rotation confirmation survive the refresh", async ({ page }) => {
  await installFakeBridge(page);
  await exposeAppInternals(page);
  await openApp(page);
  await openAiSettings(page);
  await enableMcp(page);
  await revealMcpCard(page);

  await page.locator("#mcpPort").fill("80");
  await page.locator("#mcpPort").press("Tab");
  /* The handler refreshes the card after saving/validation; the error must not
   * be replaced by the "Running" line before the user can read it. */
  await expect(page.locator("#mcpStatus")).toContainText("MCP port must be an integer between 1024 and 65535.");
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("linkr-mcp-config-v1")).port),
  ).toBe(8712);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#mcpRegenerate").tap();
  await expect(page.locator("#mcpStatus")).toContainText(/New token generated|已生成新令牌/);
  expect(await page.evaluate(() => window.__mcpCalls.regenerateToken)).toBe(1);
});
