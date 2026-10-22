import { test, expect } from "@playwright/test";

/* Accessory tools configure Linkr Bee itself over the management channel. These
 * tests exercise the whole path in the shipped app: tool call → approval card →
 * command → read-back evidence, including the two things that must never leak
 * (an unapproved change, and a WiFi password in the transcript). */
test.beforeEach(async ({ page }) => {
  await page.route("**/app.js?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() +
      "\nwindow.__test = { state, setConnected, bleTransport, feedManagementText, setControl: fn => { sendControl = fn; } };" });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__test?.state.term);
  await page.evaluate(() => {
    const { state, setConnected } = window.__test;
    window.commands = [];
    state.mode = "ble";
    state.mgmtReady = true;
    /* WiFi (bit 0), WebDAV (bit 1) and async events (bit 4), as a real
     * accessory advertises them; without them the tools refuse to run. */
    state.mgmtCapabilities = 1 | 2 | (1 << 4);
    setConnected(true);
  });
  await page.locator("#agentButton").click();
  await page.locator("#agentSettingsButton").click();
  await page.locator("#agentEndpoint").fill("https://agent.test/v1");
  await page.locator("#agentModel").fill("test-model");
  await page.locator("#agentApiKey").fill("test-device-key");
  await page.locator("#agentSettingsSave").click();
  await expect(page.locator("#agentSettingsStatus")).toContainText("saved");
  await page.locator("#drawerClose").click();
});

function sse({ text, tool }) {
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function",
    function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
    : { role: "assistant", content: text };
  const chunk = (payload, finish) => JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk",
    created: 1, model: "test-model", choices: [{ index: 0, delta: payload, finish_reason: finish }] });
  return `data: ${chunk(delta, null)}\n\ndata: ${chunk({}, tool ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`;
}

async function mockModel(page, respond) {
  await page.route("https://agent.test/v1/chat/completions", async (route) => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    const body = route.request().postDataJSON();
    await route.fulfill({ status: 200, headers, contentType: "text/event-stream", body: sse(respond(body)) });
  });
}

async function ask(page, question) {
  await page.locator("#agentQuestion").fill(question);
  await page.locator("#agentAsk").click();
}

test("diagnostics are read without an approval card", async ({ page }) => {
  const replies = [];
  await page.evaluate(() => window.__test.setControl(async (command) => {
    window.commands.push(command);
    if (command === "@i?") {
      window.__test.feedManagementText("@info fw version=0.1.2 zephyr=4.4.1\r\n");
      window.__test.feedManagementText("@info uart dropped=0 dropped_no_conn=0 buffer=12/4096\r\n");
      window.__test.feedManagementText("@info done\r\n");
      return "OK";
    }
    throw new Error(`unexpected command ${command}`);
  }));
  let turns = 0;
  await mockModel(page, (body) => {
    if (++turns === 1) return { tool: { name: "get_accessory_diagnostics", args: {} } };
    replies.push(body.messages.at(-1).content);
    return { text: "The bridge runs firmware 0.1.2." };
  });
  await ask(page, "Which firmware is the bridge running?");
  await expect(page.locator("#agentMessages")).toContainText("firmware 0.1.2");
  expect(await page.evaluate(() => window.commands)).toEqual(["@i?"]);
  const evidence = JSON.parse(replies[0]);
  expect(evidence.groups.fw.version).toBe("0.1.2");
  expect(evidence.settled).toBe(true);
  await expect(page.getByRole("button", { name: /Allow change|允许修改/ })).toHaveCount(0);
});

for (const approved of [true, false]) {
  test(`a UART change ${approved ? "runs after approval" : "never reaches the device when rejected"}`, async ({ page }) => {
    await page.evaluate(() => window.__test.setControl(async (command) => {
      window.commands.push(command);
      if (command === "@u=9600,8,n,1,none") return "OK uart=9600,8,n,1,none";
      if (command === "@u?") return "OK uart=9600,8,n,1,none";
      throw new Error(`unexpected command ${command}`);
    }));
    let turns = 0;
    const replies = [];
    await mockModel(page, (body) => {
      if (++turns === 1) return { tool: { name: "set_uart_config", args: { baud: 9600 } } };
      // Tool results arrive on the wire as a plain string in a "tool" message.
      replies.push(body.messages.at(-1).content);
      return { text: approved ? "The bridge now uses 9600." : "I did not change anything." };
    });
    await ask(page, "Set the bridge to 9600 baud");
    const allow = page.getByRole("button", { name: /Allow change|允许修改/ });
    await expect(allow).toBeVisible();
    await expect(page.locator("#agentMessages")).toContainText(/Set the bridge UART to 9600,8,n,1,none|把桥接串口改为 9600,8,n,1,none/);
    if (approved) await allow.click();
    else await page.getByRole("button", { name: /Reject|拒绝/ }).click();
    await expect(page.locator("#agentMessages")).toContainText(approved ? "now uses 9600" : "did not change anything");

    const commands = await page.evaluate(() => window.commands);
    if (approved) {
      expect(commands).toEqual(["@u=9600,8,n,1,none", "@u?"]);
      expect(JSON.parse(replies[0])).toMatchObject({ applied: true, accepted: true });
    } else {
      expect(commands).toEqual([]);
      expect(replies[0]).toMatch(/rejected/i);
    }
  });
}

test("a WiFi password reaches the device but never the transcript", async ({ page }) => {
  await page.evaluate(() => window.__test.setControl(async (command) => {
    window.commands.push(command);
    if (command === "@w=Bench,hunter2") return "OK wifi=connecting,ssid=Bench";
    if (command === "@w?") return "OK wifi=connected,ssid=Bench,ip=192.168.1.5";
    throw new Error(`unexpected command ${command}`);
  }));
  let turns = 0;
  const replies = [];
  await mockModel(page, (body) => {
    if (++turns === 1) return { tool: { name: "set_wifi", args: { action: "connect", ssid: "Bench", password: "hunter2" } } };
    replies.push(body.messages.at(-1).content);
    return { text: "Joined Bench." };
  });
  await ask(page, "Join the Bench network, password hunter2");
  // The question itself is the user's own text and stays as typed; the card and
  // everything the tool returns must not repeat the password.
  const card = page.locator("#agentMessages .agent-message")
    .filter({ hasText: /encrypted Bluetooth management channel|加密的蓝牙管理通道/ });
  await expect(card).toContainText(/Join WiFi "Bench"|连接 WiFi「Bench」/);
  expect(await card.textContent()).not.toContain("hunter2");
  await page.getByRole("button", { name: /Allow change|允许修改/ }).click();
  await expect(page.locator("#agentMessages")).toContainText("Joined Bench.");

  expect(await page.evaluate(() => window.commands)).toEqual(["@w=Bench,hunter2", "@w?"]);
  const evidence = JSON.parse(replies[0]);
  expect(evidence.applied).toBe(true);
  expect(evidence.status).toMatchObject({ state: "connected", ssid: "Bench", ip: "192.168.1.5" });
  // The copy the model and the task store keep must not carry the password.
  expect(replies[0]).not.toContain("hunter2");
  expect(await page.evaluate(() => JSON.stringify(localStorage.getItem("linkr-agent-tasks-v1") || ""))).not.toContain("hunter2");
});
