import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/app.js?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() +
      "\nwindow.__test = { state, setConnected, handleIncomingBytes, enqueueBytes, bleTransport, agentJournal, setBindingControl: fn => { sendControl = fn; } };" });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__test?.state.term);
  await page.evaluate(() => {
    const { state, setConnected } = window.__test;
    window.sent = [];
    state.mode = "ws";
    /* window.sent is the UART input this test observes. A recognized shell
     * prompt schedules the app's own window-size sync ("stty rows … cols …"),
     * which is not assistant input and would otherwise race every count
     * assertion; geometry is covered by terminal_geometry.spec.mjs. */
    state.ws = { readyState: 1, send: (bytes) => {
      if (new TextDecoder().decode(bytes).startsWith("stty ")) return;
      window.sent.push(Array.from(bytes));
    } };
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
  const chunk = (delta, finish_reason) => JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk",
    created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] });
  return `data: ${chunk(delta, null)}\n\ndata: ${chunk({}, tool ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`;
}

async function mockModelResponse(page, respond) {
  let calls = 0;
  await page.route("https://agent.test/v1/chat/completions", async (route) => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const response = await respond(route.request().postDataJSON(), ++calls);
    await route.fulfill({ status: 200, headers, ...response });
  });
}
async function mockModel(page, respond) {
  await mockModelResponse(page, async (request, round) => ({
    contentType: "text/event-stream", body: sse(await respond(request, round)),
  }));
}
async function chooseMode(page, mode) {
  await page.locator("#agentModeButton").tap();
  await page.locator(`[name="agentMode"][value="${mode}"]`).locator('..').tap();
  await expect(page.locator("#agentModePicker")).toBeHidden();
}
async function ask(page, question = "Why did the target fail to boot?") {
  await page.locator("#agentQuestion").fill(question);
  await page.locator("#agentAsk").click();
}

test("a built-in Radxa skill discovers and reads the correct board's official document", async ({ page }, testInfo) => {
  const base = "https://docs.radxa.com";
  const url = `${base}/dragon/q8b/system-config/uart-debug`;
  const publicHeaders = { "access-control-allow-origin": "*" };
  await page.route(`${base}/agent/products.json`, route => {
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ headers: publicHeaders, contentType: "application/json", body: JSON.stringify({ products: [
      { name: "Dragon Q8B", id: "dragon-q8b", public_urls: { zh: `${base}/dragon/q8b` } },
      { name: "Dragon Q6A", id: "dragon-q6a", public_urls: { zh: `${base}/dragon/q6a` } },
    ] }) });
  });
  await page.route(`${base}/sitemap.xml`, route => route.fulfill({ headers: publicHeaders, contentType: "application/xml",
    body: `<urlset><url><loc>${url}</loc></url><url><loc>${base}/dragon/q6a/system-config/uart-debug</loc></url></urlset>` }));
  await page.route(url, route => route.fulfill({ headers: publicHeaders, contentType: "text/html",
    body: "<title>Q8B UART guide</title><nav>" + Array.from({ length: 50 }, (_, i) => `<a href='/navigation-${i}'>Menu</a>`).join("") +
      "</nav><main><h1>Q8B UART</h1><p>Mock official UART instructions.</p><a href='/dragon/q8b/getting-started'>Related board guide</a></main>" }));
  await mockModel(page, (request, round) => {
    if (round === 1) {
      expect(JSON.stringify(request.messages)).toContain("radxa-docs");
      expect(JSON.stringify(request.messages)).not.toContain("# Radxa documentation workflow");
      return { tool: { name: "load_skill", args: { name: "radxa-docs" } } };
    }
    if (round === 2) {
      expect(JSON.stringify(request.messages.at(-1))).toContain("imports_resolve_to");
      return { tool: { name: "search_radxa_docs", args: { query: "串口调试", board: "Q8B" } } };
    }
    if (round === 3) {
      const value = JSON.parse(request.messages.at(-1).content);
      expect(value.results.map(item => item.url)).toEqual([url]);
      return { tool: { name: "read_web_page", args: { url } } };
    }
    expect(JSON.stringify(request.messages.at(-1))).toContain("Mock official UART instructions.");
    expect(JSON.parse(request.messages.at(-1).content).links).toContainEqual({ text: "Related board guide", url: `${base}/dragon/q8b/getting-started` });
    return { text: `Read [Q8B UART documentation](${url}). Check the guide before changing UART settings.` };
  });
  await ask(page, "查一下 Q8B 的串口调试文档");
  await expect(page.locator(".agent-assistant a").last()).toHaveAttribute("href", url);
  await expect(page.locator("#agentAsk")).toBeEnabled();
  await expect(page.locator("#agentMessages")).toContainText("Load built-in skill");
  await expect(page.locator("#agentMessages")).toContainText("Find official Radxa docs");
  for (const viewport of [{ width: 390, height: 844 }, { width: 1552, height: 1221 }]) {
    await page.setViewportSize(viewport);
    expect(await page.locator("#agentMessages").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`radxa-skills-${viewport.width}.png`) });
  }
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("blocked Radxa discovery reads official MDX source and follows its documented content reference", async ({ page }) => {
  const site = "https://docs.radxa.com";
  const sha = "b".repeat(40);
  const raw = `https://raw.githubusercontent.com/radxa-docs/docs/${sha}/`;
  const path = "docs/dragon/q8b/system-config/uart-debug.mdx";
  const contentPath = "docs/common/uart-body.md";
  const headers = { "access-control-allow-origin": "*" };
  await page.route(`${site}/agent/products.json`, route => route.fulfill({ headers, contentType: "application/json",
    body: JSON.stringify({ products: [{ name: "Dragon Q8B", id: "dragon-q8b", public_urls: { zh: `${site}/dragon/q8b` } }] }) }));
  await page.route(`${site}/sitemap.xml`, route => route.abort("failed"));
  await page.route("https://api.github.com/repos/radxa-docs/docs/git/trees/main?recursive=1", route => route.fulfill({ headers,
    contentType: "application/json", body: JSON.stringify({ sha, truncated: false, tree: [{ type: "blob", path }] }) }));
  await page.route(raw + path, route => route.fulfill({ headers, contentType: "text/plain",
    body: `---\ndoc_kind: wrapper\nimports_resolve_to:\n  - ${contentPath}\n---\nimport Body from '@site/${contentPath}';\n<Body />` }));
  await page.route(raw + contentPath, route => route.fulfill({ headers, contentType: "text/plain",
    body: "# Shared UART procedure\n\nOnly apply after checking the exact board wiring.\n\n```yaml\nserial:\n  example: true\n```" }));
  await mockModel(page, (request, round) => {
    if (round === 1) return { tool: { name: "load_skill", args: { name: "radxa-docs" } } };
    if (round === 2) return { tool: { name: "search_radxa_docs", args: { query: "串口", board: "Q8B" } } };
    if (round === 3) {
      const found = JSON.parse(request.messages.at(-1).content);
      expect(found.source).toBe("repository");
      expect(found.warnings.join(" ")).toContain("Published sitemap unavailable");
      expect(found.results[0].url).toBe(raw + path);
      return { tool: { name: "read_web_page", args: { url: found.results[0].url } } };
    }
    if (round === 4) {
      expect(JSON.stringify(request.messages.at(-1))).toContain("imports_resolve_to");
      return { tool: { name: "read_web_page", args: { url: raw + contentPath } } };
    }
    const read = JSON.parse(request.messages.at(-1).content);
    expect(read.text).toContain("serial:\n  example: true");
    return { text: `Published site unavailable; read the [official source](${raw + path}) and its referenced content. Board prerequisites still need verification.` };
  });
  await ask(page, "查一下 Q8B 的串口文档");
  await expect(page.locator(".agent-assistant").last()).toContainText("Published site unavailable");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("a transient model error recovers with visible status and no serial input", async ({ page }, testInfo) => {
  let calls = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  await mockModelResponse(page, async (_request, round) => {
    calls = round;
    if (round === 1) {
      return { status: 503, contentType: "application/json",
        body: JSON.stringify({ error: { message: "Service temporarily unavailable" } }) };
    }
    await held;
    return { contentType: "text/event-stream", body: sse({ text: "Recovered without repeating any command." }) };
  });
  try {
    await ask(page);
    await expect(page.locator("#agentStatus")).toContainText("Retrying model request (1/2)");
    await expect(page.locator("#agentStop")).toBeEnabled();
    for (const viewport of [{ width: 1552, height: 1221 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      expect(await page.locator("#agentStatus").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`model-retry-${viewport.width}.png`) });
    }
  } finally { release(); }
  await expect(page.locator(".agent-assistant").last()).toContainText("Recovered without repeating any command.");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  await expect(page.locator("#agentStatus")).toBeEmpty();
  expect(calls).toBe(2);
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("stopping retry backoff unlocks the composer and cancels the old request", async ({ page }) => {
  const requests = [];
  await mockModelResponse(page, async request => {
    requests.push(request);
    return requests.length === 1
      ? { status: 503, contentType: "application/json", body: '{"error":{"message":"Service temporarily unavailable"}}' }
      : { contentType: "text/event-stream", body: sse({ text: "New question answered." }) };
  });
  await ask(page, "First question");
  await expect(page.locator("#agentStatus")).toContainText("Retrying in 1s (1/2)");
  await page.locator("#agentStop").click();
  await expect(page.locator("#agentAsk")).toBeEnabled();
  await ask(page, "New question");
  await expect(page.locator(".agent-assistant").last()).toContainText("New question answered.");
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.at(-1).content).toEqual([{ type: "text", text: "New question" }]);
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("persistent transient errors stop after the question's two retries", async ({ page }) => {
  let calls = 0;
  await mockModelResponse(page, async (_request, round) => {
    calls = round;
    return { status: 503, contentType: "application/json", body: '{"error":{"message":"Service temporarily unavailable"}}' };
  });
  await ask(page);
  await expect(page.locator(".agent-assistant").last()).toContainText("Service temporarily unavailable");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  expect(calls).toBe(3);
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("an interrupted partial assistant response is reported without replay", async ({ page }) => {
  let calls = 0;
  await mockModelResponse(page, async (_request, round) => {
    calls = round;
    const body = sse({ text: "Partial report" }).replace('"finish_reason":"stop"', '"finish_reason":"network_error"');
    return { contentType: "text/event-stream", body };
  });
  await ask(page);
  await expect(page.locator(".agent-assistant .agent-markdown").first()).toContainText("Partial report");
  await expect(page.locator(".agent-assistant").last()).toContainText("network_error");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  expect(calls).toBe(1);
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("assistant renders Markdown while user and tool input stay literal", async ({ page }, testInfo) => {
  const markdown = '## 检查结果\n\n**连接正常**，请查看 [Radxa Docs](https://docs.radxa.com/)。\n\n1. 检查版本\n2. 查看日志\n\n```sh\nuname -a\nprintf "<tag>"\n' + 'x'.repeat(180) + '\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| UART | 正常 |\n\n> 保留日志以便核对。';
  await mockModel(page, () => ({ text: markdown }));
  await ask(page, "**原始问题**");
  const answer = page.locator(".agent-assistant .agent-markdown").last();
  await expect(answer.locator("h2")).toHaveText("检查结果");
  await expect(answer.locator("strong")).toHaveText("连接正常");
  await expect(answer.locator("ol li")).toHaveCount(2);
  await expect(answer.locator("pre code")).toContainText('printf "<tag>"');
  await expect(answer.locator("table tbody td")).toHaveText(["UART", "正常"]);
  await expect(answer.locator("a")).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator(".agent-user .agent-message-text")).toHaveText("**原始问题**");
  for (const viewport of [{width:1552,height:1221},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => answer.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(page.locator("#agentMessages")).toHaveCSS("overflow-x", "hidden");
    await expect(answer.locator("pre")).toHaveCSS("overflow-x", "auto");
    const scrolling = await answer.locator("pre").evaluate(pre => {
      pre.scrollLeft = 100;
      const messages = pre.closest("#agentMessages");
      return { codeScrolled: pre.scrollLeft > 0, messagesScrolled: messages.scrollLeft,
        messagesFit: messages.scrollWidth <= messages.clientWidth + 1 };
    });
    expect(scrolling).toEqual({ codeScrolled: true, messagesScrolled: 0, messagesFit: true });
    await page.screenshot({path: testInfo.outputPath(`markdown-${viewport.width}.png`)});
  }
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("streaming Markdown retains raw source and filters active HTML and unsafe links", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderAssistantMarkdown } = await import('/agent_markdown.js');
    const body = document.createElement('div');
    document.body.append(body);
    renderAssistantMarkdown(body, '**str');
    renderAssistantMarkdown(body, 'ong**\n\n```sh\necho <script>', {append:true});
    renderAssistantMarkdown(body, '\n```\n\n<img src=x onerror="window.pwned=true"><script>window.pwned=true</script><iframe src="https://evil.test"></iframe>\n\n[bad](javascript:alert(1)) [local](/reset) [good](https://docs.radxa.com/)\n\n<form><input autofocus></form>', {append:true});
    const result = { strong:body.querySelector('strong')?.textContent, code:body.querySelector('code')?.textContent,
      active:body.querySelectorAll('script,img,iframe,form,input,[onerror]').length,
      links:[...body.querySelectorAll('a[href]')].map(a=>a.href), pwned:!!window.pwned };
    body.remove();
    return result;
  });
  expect(result).toEqual({strong:'strong',code:'echo <script>\n',active:0,links:['https://docs.radxa.com/'],pwned:false});
});

test("Pi reads and extracts a web page without UART or credential leakage", async ({ page }) => {
  await page.route("https://docs.example.org/board", async route => {
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().headers().cookie).toBeUndefined();
    await route.fulfill({ contentType: "text/html", headers: { "access-control-allow-origin": "*" },
      body: '<title>Board guide</title><script>SECRET_SCRIPT</script><main><h1>Board instructions</h1><p>Version 2</p><a href="/releases">Releases</a></main>' });
  });
  await mockModel(page, (request, round) => {
    if (round === 1) return { tool: { name: "read_web_page", args: { url: "https://docs.example.org/board" } } };
    const evidence = request.messages.at(-1).content;
    expect(evidence).toContain("Board instructions");
    expect(evidence).toContain("https://docs.example.org/releases");
    expect(evidence).not.toContain("SECRET_SCRIPT");
    return { text: "Read the board guide successfully." };
  });
  await ask(page, "Read https://docs.example.org/board");
  await expect(page.locator("#agentMessages")).toContainText("Read the board guide successfully.");
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("Pi reads real UART logs without exposing the saved key to model context", async ({ page }) => {
  let toolEvidence = "";
  await page.evaluate(() => {
    window.__test.handleIncomingBytes(new TextEncoder().encode("Kernel panic: unable to mount root\r\n"));
    window.__test.state.term.write("LOCAL_UI_ONLY");
  });
  await mockModel(page, (request, count) => {
    expect(JSON.stringify(request)).not.toContain("test-device-key");
    if (count === 1) return { tool: { name: "read_serial_log", args: {} } };
    toolEvidence = request.messages.find((message) => message.role === "tool")?.content;
    return { text: "The serial log reports a root filesystem mount failure." };
  });
  await ask(page);
  await expect(page.locator("#agentMessages")).toContainText("root filesystem mount failure");
  expect(toolEvidence).toContain("Kernel panic");
  expect(toolEvidence).not.toContain("LOCAL_UI_ONLY");
  expect(await page.evaluate(() => window.sent)).toEqual([]);
  expect(toolEvidence).not.toContain("test-device-key");
  expect(await page.locator("#agentMessages").textContent()).not.toContain("test-device-key");
  await page.screenshot({ path: "test-results/agent-phone.png" });
});

test("unsaved configuration is not used, and running Agent settings are locked", async ({ page }) => {
  await page.locator("#agentSettingsButton").tap();
  await page.locator("#agentModel").fill("unsaved-model");
  await page.locator("#drawerClose").tap();
  await mockModel(page, (request, count) => {
    expect(request.model).toBe("test-model");
    return count === 1 ? { tool: { name: "send_serial_input", args: { text: "reboot", appendEnter: true } } }
      : { text: "Rejected input was not sent." };
  });
  await ask(page);
  await expect(page.locator("#agentMessages .agent-actions .btn-primary")).toBeVisible();
  await page.locator("#agentSettingsButton").tap();
  await expect(page.locator("#agentSettingsStatus")).toContainText("Agent is running");
  for (const id of ["agentModel", "agentApiKey", "agentSettingsSave", "agentSettingsClear"]) {
    await expect(page.locator(`#${id}`)).toBeDisabled();
  }
  await page.locator("#drawerClose").tap();
  await page.locator("#agentMessages .agent-actions .btn:not(.btn-primary)").tap();
  await expect(page.locator("#agentMessages")).toContainText("Rejected input was not sent.");
  expect(await page.evaluate(() => window.sent)).toEqual([]);
  await page.locator("#agentSettingsButton").tap();
  await expect(page.locator("#agentSettingsSave")).toBeEnabled();
  await expect(page.locator("#agentSettingsStatus")).toContainText("not been saved");
});

for (const changed of [false, true]) {
  test(`saved settings ${changed ? "start fresh when the model changes" : "retain the conversation when unchanged"}`, async ({ page }) => {
    let continued;
    await mockModel(page, (request, count) => {
      if (count === 1) return { text: "The root partition could not be mounted." };
      continued = request;
      return { text: "The next question uses the explicitly saved configuration." };
    });
    await ask(page, "Remember the board boots from eMMC");
    await expect(page.locator("#agentAsk")).toBeEnabled();
    await page.locator("#agentSettingsButton").tap();
    if (changed) await page.locator("#agentModel").fill("replacement-model");
    await page.locator("#agentSettingsSave").tap();
    await expect(page.locator("#agentSettingsStatus")).toContainText("saved on this device");
    await page.locator("#drawerClose").tap();
    await ask(page, "Continue diagnosing");
    await expect(page.locator("#agentMessages")).toContainText("explicitly saved configuration");
    expect(continued.model).toBe(changed ? "replacement-model" : "test-model");
    const context = JSON.stringify(continued.messages);
    if (changed) expect(context).not.toContain("boots from eMMC");
    else {
      expect(context).toContain("boots from eMMC");
      expect(context).toContain("could not be mounted");
    }
  });
}

test("serial input waits for explicit approval and returns to the Pi loop", async ({ page }) => {
  await chooseMode(page, "manual");
  await mockModel(page, (_request, count) => count === 1
    ? { tool: { name: "send_serial_input", args: { text: "uname -a", appendEnter: true } } }
    : { text: "Input sent. Read the target output to verify execution." });
  await ask(page, "Inspect the operating system");
  const approve = page.locator("#agentMessages .agent-actions .btn-primary");
  await expect(approve).toBeVisible();
  expect(await page.evaluate(() => window.sent)).toEqual([]);
  await approve.tap();
  await expect.poll(() => page.evaluate(() => window.sent.length)).toBe(1);
  const sent = await page.evaluate(() => window.sent[0]);
  expect(new TextDecoder().decode(new Uint8Array(sent))).toMatch(/^uname -a\r?\n?$|^uname -a\r$/);
  await expect(page.locator("#agentMessages")).toContainText("Read the target output");
});

for (const [mode, command] of [["auto", "uname -a"], ["full-auto", "reboot"]]) {
  test(`${mode} sends permitted input directly and records the command`, async ({ page }) => {
    if (mode === "full-auto") await chooseMode(page, "full-auto");
    else await expect(page.locator('[name="agentMode"][value="auto"]')).toBeChecked();
    if (mode === "auto") await page.evaluate(() => window.__test.handleIncomingBytes(new TextEncoder().encode("root@board:~# ")));
    let systemPrompt = "";
    await mockModel(page, (request, count) => {
      systemPrompt = request.messages.find((message) => message.role === "system")?.content || "";
      return count === 1 ? { tool: { name: "send_serial_input", args: { text: command, appendEnter: true } } }
        : { text: "Command delivery recorded." };
    });
    await ask(page);
    await expect(page.locator("#agentMessages")).toContainText("Command delivery recorded.");
    expect(await page.evaluate(() => window.sent.length)).toBe(1);
    await expect(page.locator("#agentMessages .agent-actions .btn-primary")).toHaveCount(0);
    await expect(page.locator("#agentMessages")).toContainText(command);
    expect(systemPrompt).toContain(mode === "auto" ? "Execution mode: Auto" : "Execution mode: Full Auto");
  });
}

test("switching to Full Auto cancels pending input instead of approving it", async ({ page }) => {
  await mockModel(page, () => ({ tool: { name: "send_serial_input", args: { text: "reboot", appendEnter: true } } }));
  await ask(page);
  const approve = page.locator("#agentMessages .agent-actions .btn-primary");
  await expect(approve).toBeVisible();
  await page.locator("#agentModeButton").tap();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('[name="agentMode"][value="auto"]')).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(approve).toBeEnabled();
  await chooseMode(page, "full-auto");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  await expect(approve).toBeDisabled();
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("mode changes keep completed diagnostic context and use the new policy on the next question", async ({ page }) => {
  let nextRequest;
  await mockModel(page, (request, count) => {
    if (count === 1) return { text: "The current hypothesis is a missing root filesystem." };
    nextRequest = request;
    return { text: "Continuing the root filesystem diagnosis in Manual mode." };
  });
  await ask(page, "Remember that this board boots from eMMC");
  await expect(page.locator("#agentMessages")).toContainText("missing root filesystem");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  await chooseMode(page, "manual");
  await expect(page.locator("#agentMessages")).toContainText("conversation retained");
  await ask(page, "Continue the same diagnosis");
  await expect(page.locator("#agentMessages")).toContainText("Continuing the root filesystem diagnosis");
  expect(nextRequest.messages.find((message) => message.role === "system").content).toContain("Execution mode: Manual");
  expect(JSON.stringify(nextRequest.messages)).toContain("boots from eMMC");
  expect(JSON.stringify(nextRequest.messages)).toContain("missing root filesystem");
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("returning from another app preserves an idle diagnostic conversation", async ({ page }) => {
  let continued;
  await mockModel(page, (request, count) => {
    if (count === 1) return { text: "The suspected fault is the eMMC root filesystem." };
    continued = request;
    return { text: "Continuing the same diagnosis after returning to the app." };
  });
  await ask(page, "Remember this board boots from eMMC");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await ask(page, "Continue the diagnosis");
  await expect(page.locator("#agentMessages")).toContainText("after returning to the app");
  expect(JSON.stringify(continued.messages)).toContain("boots from eMMC");
  expect(JSON.stringify(continued.messages)).toContain("suspected fault");
});

for (const action of ["stop", "background", "timeout", "exit"]) {
  test(`${action} retains completed context and cancelled input history for the next question`, async ({ page }) => {
    let continued;
    await mockModel(page, (request, count) => {
      if (count === 1) return { text: "The board boots from eMMC and the root filesystem could not be mounted." };
      if (count === 2) return { tool: { name: "send_serial_input", args: { text: "reboot", appendEnter: true } } };
      continued = request;
      return { text: "Continuing the same diagnosis without replaying the cancelled restart." };
    });
    await ask(page, "Remember the eMMC boot failure");
    await expect(page.locator("#agentAsk")).toBeEnabled();
    if (action === "timeout") await page.clock.install();
    await ask(page, "Propose a restart");
    const approve = page.locator("#agentMessages .agent-actions .btn-primary");
    await expect(approve).toBeVisible();
    if (action === "stop") await page.locator("#agentStop").tap();
    if (action === "exit") await page.locator("#agentClose").tap();
    if (action === "timeout") await page.clock.fastForward(900001);
    if (action === "background") await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("#agentAsk")).toBeEnabled();
    await expect(approve).toBeDisabled();
    if (action === "exit") await page.locator("#agentButton").tap();
    await ask(page, "Continue analysis only");
    await expect(page.locator("#agentMessages")).toContainText("without replaying the cancelled restart");
    const context = JSON.stringify(continued.messages);
    expect(context).toContain("Remember the eMMC boot failure");
    expect(context).toContain("could not be mounted");
    expect(context).toContain("Propose a restart");
    const calls = continued.messages.flatMap((message) => message.tool_calls || []);
    const results = continued.messages.filter((message) => message.role === "tool");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].tool_call_id).toBe(calls[0].id);
    expect(results[0].content).toMatch(/cancelled|aborted/i);
    expect(await page.evaluate(() => window.sent)).toEqual([]);
    await expect(page.locator("#agentMessages [data-execution]")).toHaveCount(1);
  });
}

test("closing an idle Agent keeps its history without adding a stopped-run notice", async ({ page }) => {
  let continued;
  await mockModel(page, (request, count) => {
    if (count === 1) return { text: "The known issue is an eMMC root filesystem mount failure." };
    continued = request;
    return { text: "Continuing after reopening the Agent." };
  });
  await ask(page, "Remember the boot problem");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  const previous = await page.locator("#agentMessages").textContent();
  await page.locator("#agentClose").tap();
  await page.locator("#agentButton").tap();
  await expect(page.locator("#agentMessages")).toHaveText(previous);
  await ask(page, "Continue investigating");
  await expect(page.locator("#agentMessages")).toContainText("after reopening the Agent");
  expect(JSON.stringify(continued.messages)).toContain("root filesystem mount failure");
});

test("a cancelled model response cannot overwrite the preserved conversation or the following answer", async ({ page }) => {
  let releaseCancelled, requests = 0, continued;
  await mockModel(page, (request, count) => {
    requests = count;
    if (count === 1) return { text: "Retained diagnosis: the eMMC root filesystem failed to mount." };
    if (count === 2) return new Promise((resolve) => { releaseCancelled = resolve; });
    continued = request;
    return { text: "The follow-up answer continues the retained diagnosis." };
  });
  await ask(page, "Diagnose the eMMC boot failure");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  await ask(page, "Inspect another possible cause");
  await expect.poll(() => requests).toBe(2);
  await page.locator("#agentStop").tap();
  await expect(page.locator("#agentAsk")).toBeEnabled();
  releaseCancelled({ text: "STALE_CANCELLED_RESPONSE" });
  await ask(page, "Continue after stopping that request");
  await expect(page.locator("#agentMessages")).toContainText("follow-up answer continues");
  expect(JSON.stringify(continued.messages)).toContain("Retained diagnosis");
  expect(JSON.stringify(continued.messages)).not.toContain("STALE_CANCELLED_RESPONSE");
  await expect(page.locator("#agentMessages")).not.toContainText("STALE_CANCELLED_RESPONSE");
});

for (const action of ["new chat", "new connection"]) {
  test(`${action} resets context and execution cards after an interrupted question`, async ({ page }) => {
    let continued;
    await mockModel(page, (request, count) => {
      if (count === 1) return { text: "OLD_DIAGNOSTIC_FACT" };
      if (count === 2) return { tool: { name: "send_serial_input", args: { text: "OLD_PRIVATE_COMMAND", appendEnter: true } } };
      continued = request;
      return { text: "A fresh diagnostic conversation." };
    });
    await ask(page, "Remember the old diagnosis");
    await expect(page.locator("#agentAsk")).toBeEnabled();
    await ask(page, "Propose input for the old diagnosis");
    await expect(page.locator("#agentMessages .agent-actions .btn-primary")).toBeVisible();
    if (action === "new chat") {
      await page.locator("#agentStop").tap();
      await expect(page.locator("#agentNew")).toBeEnabled();
      await page.locator("#agentNew").tap();
    } else await page.evaluate(() => {
      window.__test.setConnected(false);
      window.__test.setConnected(true);
    });
    await expect(page.locator("#agentAsk")).toBeEnabled();
    await expect(page.locator("#agentMessages")).toHaveText("");
    await ask(page, "Diagnose from a fresh context");
    await expect(page.locator("#agentMessages")).toContainText("fresh diagnostic conversation");
    expect(JSON.stringify(continued.messages)).not.toContain("OLD_DIAGNOSTIC_FACT");
    expect(JSON.stringify(continued.messages)).not.toContain("OLD_PRIVATE_COMMAND");
    expect(await page.evaluate(() => window.sent)).toEqual([]);
    await expect(page.locator("#agentMessages [data-execution]")).toHaveCount(0);
  });
}

test("Escape during IME composition preserves the Agent and its question draft", async ({ page }) => {
  await page.locator("#agentQuestion").fill("分析启动失败");
  await page.locator("#agentQuestion").dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await expect(page.locator("#agentPanel")).toBeVisible();
  await expect(page.locator("#agentQuestion")).toHaveValue("分析启动失败");
  await page.keyboard.press("Escape");
  await expect(page.locator("#agentPanel")).toBeHidden();
});

test("a mode change during approval preserves context but never sends the cancelled command", async ({ page }) => {
  let calls = 0, continued;
  await mockModel(page, (request) => {
    if (++calls === 1) return { tool: { name: "send_serial_input", args: { text: "reboot", appendEnter: true } } };
    continued = request;
    return { text: "The cancelled restart remains cancelled; continuing analysis only." };
  });
  await ask(page, "Check the eMMC boot failure; propose a restart");
  await expect(page.locator("#agentMessages .agent-actions .btn-primary")).toBeVisible();
  await chooseMode(page, "full-auto");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  await ask(page, "Continue analysis only");
  await expect(page.locator("#agentMessages")).toContainText("continuing analysis only");
  expect(JSON.stringify(continued.messages)).toContain("eMMC boot failure");
  expect(continued.messages.find((message) => message.role === "system").content).toContain("Execution mode: Full Auto");
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("long execution output exposes the final result in both tool context and the execution card", async ({ page }) => {
  await chooseMode(page, "full-auto");
  let evidence;
  await mockModel(page, async (request, count) => {
    if (count === 1) return { tool: { name: "send_serial_input", args: { text: "dmesg", appendEnter: true } } };
    const value = JSON.parse(request.messages.filter((message) => message.role === "tool").at(-1).content);
    if (count === 2) {
      await page.evaluate(() => window.__test.handleIncomingBytes(new TextEncoder().encode("x".repeat(6000) + "\r\nROOTFS_FAILURE_AT_END\r\nroot@board:~# ")));
      return { tool: { name: "inspect_serial_execution", args: { id: value.id } } };
    }
    evidence = value;
    return { text: "The final output reports a root filesystem failure." };
  });
  await ask(page);
  await expect(page.locator("#agentMessages")).toContainText("The final output reports");
  expect(evidence.evidence).toContain("ROOTFS_FAILURE_AT_END");
  expect(evidence.waitStatus).toBe("settled");
  expect(evidence.executionStatus).toBe("unknown");
  await expect(page.locator('[data-execution="serial-1"]')).toContainText("ROOTFS_FAILURE_AT_END");
});

test("gear picker navigates without changing mode until selection and dismisses without exiting Agent", async ({ page }) => {
  await expect(page.locator("#agentActiveMode")).toHaveText("Auto");
  await expect(page.locator("#agentModePicker")).toBeHidden();
  await page.locator("#agentModeButton").tap();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator('[name="agentMode"][value="manual"]')).toBeFocused();
  await expect(page.locator('[name="agentMode"][value="auto"]')).toBeChecked();
  await page.keyboard.press("Enter");
  await expect(page.locator("#agentModePicker")).toBeHidden();
  await expect(page.locator("#agentActiveMode")).toHaveText("Manual");
  await expect(page.locator("#agentModeButton")).toBeFocused();
  await page.locator("#agentModeButton").tap();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('[name="agentMode"][value="auto"]')).toBeFocused();
  await expect(page.locator('[name="agentMode"][value="manual"]')).toBeChecked();
  await page.keyboard.press("Space");
  await expect(page.locator("#agentActiveMode")).toHaveText("Auto");
  await page.locator("#agentModeButton").tap();
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(page.locator("#agentActiveMode")).toHaveText("Auto");
  await expect(page.locator("#agentPanel")).toBeVisible();
  await page.locator("#agentModeButton").tap();
  await page.locator("#agentModeClose").tap();
  await expect(page.locator("#agentModeButton")).toBeFocused();
  await expect(page.locator("#agentModePicker")).toBeHidden();
  await page.locator("#agentModeButton").tap();
  await page.locator("#agentQuestion").tap();
  await expect(page.locator("#agentModePicker")).toBeHidden();
  await expect(page.locator("#agentActiveMode")).toHaveText("Auto");
  for (const [mode, label] of [["full-auto", "Full Auto"], ["manual", "Manual"], ["auto", "Auto"]]) {
    await chooseMode(page, mode);
    await expect(page.locator("#agentActiveMode")).toHaveText(label);
  }
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

for (const [width, height] of [[320, 740], [375, 812], [802, 867], [1194, 834]]) {
  test(`gear selector fits the header and opens a vertical track at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const heading = page.locator("#agentPanel .agent-header");
    await expect.poll(() => heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const button = await page.locator("#agentModeButton").boundingBox();
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.width).toBeGreaterThanOrEqual(44);
    // Poll the invariant: the preceding drawer close leaves a 250 ms transition
    // running, and a single read here can land mid-layout by a few pixels.
    await expect.poll(async () => {
      const header = await heading.boundingBox();
      const box = await page.locator("#agentModeButton").boundingBox();
      return box.y + box.height - (header.y + header.height);
    }).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/agent-gears-${width}.png` });
    await page.locator("#agentModeButton").tap();
    await expect(page.locator("#agentModePicker")).toBeVisible();
    const rows = await page.locator("#agentModePicker label").all();
    const boxes = await Promise.all(rows.map((row) => row.boundingBox()));
    expect(boxes[0].y + boxes[0].height).toBeLessThanOrEqual(boxes[1].y);
    expect(boxes[1].y + boxes[1].height).toBeLessThanOrEqual(boxes[2].y);
    const picker = await page.locator("#agentModePicker").boundingBox();
    expect(picker.x).toBeGreaterThanOrEqual(0);
    expect(picker.x + picker.width).toBeLessThanOrEqual(width);
    expect(picker.y + picker.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: `test-results/agent-gears-open-${width}.png` });
    await page.locator('[name="agentMode"][value="manual"]').locator("..").tap();
    await expect(page.locator("#agentActiveMode")).toHaveText("Manual");
  });
}

for (const [width, height] of [[320, 740], [360, 640], [390, 844]]) {
  test(`mode picker never covers the composer at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.locator("#agentModeButton").tap();
    await expect(page.locator("#agentModePicker")).toBeVisible();
    const geometry = await page.evaluate(() => {
      const picker = document.querySelector("#agentModePicker").getBoundingClientRect();
      const composer = document.querySelector("#agentQuestion").getBoundingClientRect();
      const centre = document.elementFromPoint(
        (composer.left + composer.right) / 2,
        (composer.top + composer.bottom) / 2,
      );
      return {
        pickerBottom: picker.bottom,
        composerTop: composer.top,
        covered: Boolean(centre?.closest("#agentModePicker")),
      };
    });
    // A picker over the composer swallows the dismissing tap as a mode choice.
    expect(geometry.covered).toBe(false);
    expect(geometry.pickerBottom).toBeLessThanOrEqual(geometry.composerTop);
    await page.locator("#agentQuestion").tap();
    await expect(page.locator("#agentModePicker")).toBeHidden();
    await expect(page.locator("#agentActiveMode")).toHaveText("Auto");
  });
}

test("gear selector stays usable above a landscape soft keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator("#agentQuestion").focus();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 215 });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("#terminalCard")).toBeHidden();
  for (const mode of ["full-auto", "manual", "auto"]) {
    await page.locator("#agentModeButton").tap();
    const picker = await page.locator("#agentModePicker").boundingBox();
    expect(picker.y).toBeGreaterThanOrEqual(0);
    expect(picker.y + picker.height).toBeLessThanOrEqual(215);
    await page.locator(`[name="agentMode"][value="${mode}"]`).locator("..").tap();
    await expect(page.locator("#agentModePicker")).toBeHidden();
    await expect(page.locator(`#agentModePicker [value="${mode}"]`)).toBeChecked();
  }
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test("gear selector supports dark mode and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#agentSettingsButton").tap();
  await page.locator("#drawerThemeButton").tap();
  await page.locator("#drawerLangButton").tap();
  await page.locator("#drawerClose").tap();
  await page.locator("#agentModeButton").tap();
  await expect(page.locator("#agentModePicker")).toContainText("Auto · 推荐");
  expect(await page.locator(".agent-gear-track b").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  await page.screenshot({ path: "test-results/agent-gears-dark.png" });
});

test("Auto asks before appending a query to a partially typed terminal line", async ({ page }) => {
  await page.evaluate(() => window.__test.enqueueBytes(new TextEncoder().encode("rm ")));
  await mockModel(page, () => ({ tool: { name: "send_serial_input", args: { text: "uname -a", appendEnter: true } } }));
  await ask(page);
  await expect(page.locator("#agentMessages .agent-actions .btn-primary")).toBeVisible();
  expect(await page.evaluate(() => window.sent.length)).toBe(1);
  await page.locator("#agentStop").tap();
});

test("intervening terminal input invalidates an approved command", async ({ page }) => {
  await mockModel(page, (_request, count) => count === 1
    ? { tool: { name: "send_serial_input", args: { text: "reboot", appendEnter: true } } }
    : { text: "Input changed; request cancelled." });
  await ask(page);
  const approve = page.locator("#agentMessages .agent-actions .btn-primary");
  await expect(approve).toBeVisible();
  await page.evaluate(() => window.__test.enqueueBytes(new TextEncoder().encode("pwd\r")));
  await approve.tap();
  await expect(page.locator("#agentMessages")).toContainText("Terminal input changed");
  await expect(page.locator("#agentAsk")).toBeEnabled();
  expect(await page.evaluate(() => window.sent.length)).toBe(1);
});

for (const action of ["stop", "disconnect", "reject", "exit", "background"]) {
  test(`${action} prevents a pending agent write`, async ({ page }) => {
    await mockModel(page, (_request, count) => count === 1
      ? { tool: { name: "send_serial_input", args: { text: "reboot", appendEnter: true } } }
      : { text: "The request was not sent." });
    await ask(page, "Restart the target");
    await expect(page.locator("#agentMessages .agent-actions .btn-primary")).toBeVisible();
    if (action === "stop") await page.locator("#agentStop").tap();
    if (action === "disconnect") await page.evaluate(() => window.__test.setConnected(false));
    if (action === "reject") await page.locator("#agentMessages .agent-actions .btn:not(.btn-primary)").tap();
    if (action === "exit") await page.locator("#agentClose").tap();
    if (action === "background") await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("#agentAsk")).toBeEnabled();
    expect(await page.evaluate(() => window.sent)).toEqual([]);
  });
}

test("new device sessions do not expose previous UART logs", async ({ page }) => {
  let evidence = "";
  await page.evaluate(() => {
    const { setConnected, handleIncomingBytes } = window.__test;
    handleIncomingBytes(new TextEncoder().encode("OLD_DEVICE_SECRET"));
    setConnected(false);
    setConnected(true);
    handleIncomingBytes(new TextEncoder().encode("NEW_DEVICE_BOOT"));
  });
  await mockModel(page, (request, count) => {
    if (count === 1) return { tool: { name: "read_serial_log", args: {} } };
    evidence = request.messages.find((message) => message.role === "tool")?.content;
    return { text: "New device log read." };
  });
  await ask(page);
  await expect(page.locator("#agentMessages")).toContainText("New device log read");
  expect(evidence).toContain("NEW_DEVICE_BOOT");
  expect(evidence).not.toContain("OLD_DEVICE_SECRET");
});

for (const [prompt, hint] of [["=> ", "Bootloader"], ["board login: ", "Login prompt"], ["Password: ", "Password prompt"]]) {
  test(`Auto waits for confirmation at ${hint}`, async ({ page }) => {
    await page.evaluate((prompt) => window.__test.handleIncomingBytes(new TextEncoder().encode(prompt)), prompt);
    await expect(page.locator("#agentConsole")).toContainText(hint);
    await mockModel(page, () => ({ tool: { name: "send_serial_input", args: { text: "uname -a", appendEnter: true } } }));
    await ask(page);
    await expect(page.locator("#agentMessages .agent-actions .btn-primary")).toBeVisible();
    expect(await page.evaluate(() => window.sent)).toEqual([]);
    await page.locator("#agentStop").tap();
  });
}

test("Pi inspects subsequent output without treating a returned prompt as command success", async ({ page }) => {
  await page.evaluate(() => window.__test.handleIncomingBytes(new TextEncoder().encode("root@board:~# ")));
  let record;
  await mockModel(page, async (request, count) => {
    if (count === 1) return { tool: { name: "send_serial_input", args: { text: "uname -a", appendEnter: true } } };
    const value = JSON.parse(request.messages.filter((message) => message.role === "tool").at(-1).content);
    if (count === 2) {
      expect(value.delivery).toBe("sent");
      expect(value.executionStatus).toBe("unknown");
      await page.evaluate(() => window.__test.handleIncomingBytes(new TextEncoder().encode("uname: not found\r\nroot@board:~# ")));
      return { tool: { name: "inspect_serial_execution", args: { id: value.id } } };
    }
    record = value;
    return { text: "The target reports uname is unavailable. A returned prompt does not mean success." };
  });
  await ask(page);
  await expect(page.locator("#agentMessages")).toContainText("uname is unavailable");
  expect(record.observation).toBe("prompt-returned");
  expect(record.executionStatus).toBe("unknown");
  expect(record.evidence).toContain("uname: not found");
  expect(await page.evaluate(() => window.sent.length)).toBe(1);
  await expect(page.locator('[data-execution="serial-1"]')).toContainText("uname: not found");
  await page.screenshot({ path: "test-results/agent-execution.png" });
});

test("AI keyboard collapses the terminal and restores it when dismissed", async ({ page }) => {
  await expect(page.locator("#terminalCard")).toBeVisible();
  const before = await page.locator("#terminalCard").boundingBox();
  const cols = await page.evaluate(() => window.__test.state.term.cols);
  await page.locator("#agentQuestion").focus();
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 420 });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("#terminalCard")).toBeHidden();
  await page.evaluate(() => window.__test.handleIncomingBytes(new TextEncoder().encode("LOG_WHILE_COLLAPSED\r\n")));
  await expect(page.locator("#agentShowTerminal")).toBeVisible();
  expect(await page.evaluate(() => window.__test.state.term.cols)).toBe(cols);
  await expect.poll(() => page.locator("#agentAsk").evaluate((button) => button.getBoundingClientRect().bottom)).toBeLessThanOrEqual(420);
  await page.screenshot({ path: "test-results/agent-keyboard.png" });
  await page.evaluate(() => {
    delete visualViewport.height;
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("#terminalCard")).toBeVisible();
  await expect(page.locator("#agentShowTerminal")).toBeHidden();
  expect(await page.evaluate(() => Array.from({length: window.__test.state.term.buffer.active.length}, (_, i) =>
    window.__test.state.term.buffer.active.getLine(i)?.translateToString()).join("\n"))).toContain("LOG_WHILE_COLLAPSED");
  await expect.poll(async () => Math.abs((await page.locator("#terminalCard").boundingBox()).height - before.height)).toBeLessThan(2);
});

test("landscape keyboard keeps AI input and stop controls inside the visible viewport", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator("#agentQuestion").focus();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 215 });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("#terminalCard")).toBeHidden();
  await expect(page.locator("#agentActiveMode")).toBeVisible();
  await expect.poll(() => page.locator("#agentAsk").evaluate((button) => button.getBoundingClientRect().bottom)).toBeLessThanOrEqual(215);
  await page.screenshot({ path: "test-results/agent-keyboard-landscape.png" });
});

for (const [name, width, height, orientation] of [["phone", 390, 844, "rows"], ["tablet", 1194, 834, "columns"], ["narrow tablet window", 744, 1000, "rows"]]) {
  test(`${name} uses ${orientation} without replacing the terminal`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await expect(page.locator("#terminalWorkspace")).toHaveAttribute("data-agent-layout", orientation);
    const term = await page.locator("#terminalCard").boundingBox();
    const chat = await page.locator("#agentPanel").boundingBox();
    if (orientation === "rows") expect(term.y + term.height).toBeLessThanOrEqual(chat.y);
    else expect(term.x + term.width).toBeLessThanOrEqual(chat.x);
    expect(chat.x + chat.width).toBeLessThanOrEqual(width);
    expect(chat.y + chat.height).toBeLessThanOrEqual(height);
    await page.evaluate(() => { window.originalTerminal = window.__test.state.term;
      window.__test.handleIncomingBytes(new TextEncoder().encode("KEEP_THIS_LOG\r\n")); });
    await page.locator("#agentClose").tap();
    await expect(page.locator("#agentPanel")).toBeHidden();
    await page.locator("#agentButton").tap();
    await expect(page.locator("#agentPanel")).toBeVisible();
    expect(await page.evaluate(() => window.originalTerminal === window.__test.state.term)).toBe(true);
    expect(await page.evaluate(() => window.__test.state.term.buffer.active.getLine(0)?.translateToString() +
      Array.from({length: window.__test.state.term.buffer.active.length}, (_,i) => window.__test.state.term.buffer.active.getLine(i)?.translateToString()).join("\n"))).toContain("KEEP_THIS_LOG");
    await page.screenshot({ path: `test-results/agent-split-${width}.png` });
  });
}

test("show terminal switches input back to UART while the keyboard is open", async ({ page }) => {
  await page.locator("#agentQuestion").focus();
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 420 });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("#terminalCard")).toBeHidden();
  await page.locator("#agentShowTerminal").tap();
  await expect(page.locator("#terminalCard")).toBeVisible();
  await page.locator('[data-terminal-key="Tab"]').tap();
  await expect.poll(() => page.evaluate(() => window.sent.at(-1))).toEqual([9]);
  await page.locator("#agentQuestion").fill("This is an AI question");
  await expect(page.locator("#terminalCard")).toBeHidden();
  expect(await page.evaluate(() => window.sent.length)).toBe(1);
});

test("entering Agent mode exits native terminal fullscreen", async ({ page }) => {
  await page.locator("#agentClose").tap();
  await page.locator("#fullscreenBtn").tap();
  await page.waitForFunction(() => document.fullscreenElement);
  await page.locator("#agentButton").tap();
  await expect(page.locator("#agentPanel")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.locator("#terminalCard")).toBeVisible();
});

test("cancelled BLE writes stop between fragments before a new device is used", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { state, setConnected, enqueueBytes, bleTransport } = window.__test;
    state.mode = "ble";
    state.nusReady = true;
    state.reliableReady = false;
    state.device = { id: "old-device" };
    document.querySelector("#chunkInput").value = "20";
    let writes = 0;
    bleTransport.write = async () => {
      writes++;
      setConnected(false);
      state.device = { id: "new-device" };
      setConnected(true);
    };
    try {
      await enqueueBytes(new Uint8Array(80), false, { signal: new AbortController().signal });
      return { writes, failed: false };
    } catch { return { writes, failed: true }; }
  });
  expect(result).toEqual({ writes: 1, failed: true });
});

test("tracked shell exit is displayed without claiming goal verification", async ({ page }) => {
  await chooseMode(page, 'full-auto');
  await page.evaluate(() => window.__test.handleIncomingBytes(new TextEncoder().encode('root@board:~# ')));
  await mockModel(page, async (request, round) => {
    if (round === 1) return {tool:{name:'run_shell_command',args:{command:'false'}}};
    if (round === 2) {
      const record = JSON.parse(request.messages.at(-1).content);
      await page.evaluate(token => window.__test.handleIncomingBytes(new TextEncoder().encode(`\r\n${token}:1\r\nroot@board:~# `)), record.completionToken);
      return {tool:{name:'monitor_serial_execution',args:{id:record.id,timeoutMs:100}}};
    }
    expect(request.messages.at(-1).content).toContain('"exitCode":1');
    return {text:'Command failed with exit code 1. Goal unverified.'};
  });
  await ask(page, 'Run false and inspect its exit status');
  await expect(page.locator('#agentMessages')).toContainText('Goal unverified.');
  await expect(page.locator('#agentMessages')).toContainText('Exit code: 1');
});

test("target download probes tools, reports path and hash, and blocks follow-on execution", async ({ page }) => {
  await chooseMode(page,'full-auto');
  await page.evaluate(()=>window.__test.handleIncomingBytes(new TextEncoder().encode('root@board:~# ')));
  let probe, download;
  const hash='a'.repeat(64);
  await mockModel(page,async(request,round)=>{
    const last=()=>JSON.parse(request.messages.at(-1).content);
    if(round===1) return {tool:{name:'probe_download_tools',args:{}}};
    if(round===2){
      probe=last();
      await page.evaluate(token=>window.__test.handleIncomingBytes(new TextEncoder().encode(`\r\nLINKR_TOOL:curl\r\nLINKR_TOOL:sha256sum\r\n${token}:0\r\nroot@board:~# `)),probe.completionToken);
      return {tool:{name:'inspect_serial_execution',args:{id:probe.id}}};
    }
    if(round===3) return {tool:{name:'download_to_target',args:{url:'https://files.example.org/fw.bin',path:'/tmp/fw.bin',sha256:hash}}};
    if(round===4){
      download=last();
      await page.evaluate(({token,hash})=>window.__test.handleIncomingBytes(new TextEncoder().encode(`\r\n100%\r\nLINKR_SHA256:${hash}\r\nLINKR_BYTES:1024\r\n${token}:0\r\nroot@board:~# `)),{token:download.completionToken,hash});
      return {tool:{name:'monitor_serial_execution',args:{id:download.id,timeoutMs:100}}};
    }
    if(round===5){
      expect(last().download).toMatchObject({status:'saved',path:'/tmp/fw.bin',sha256:hash,bytes:1024});
      return {tool:{name:'run_shell_command',args:{command:'echo MUST_NOT_RUN'}}};
    }
    expect(request.messages.at(-1).content).toContain('wait for a new user instruction');
    return {text:'Download complete. Awaiting your next instruction.'};
  });
  await ask(page,'Download firmware to target /tmp/fw.bin');
  await expect(page.locator('#agentMessages')).toContainText('Awaiting your next instruction.');
  await expect(page.locator('#agentMessages')).toContainText(hash);
  expect(await page.evaluate(()=>window.sent.some(bytes=>new TextDecoder().decode(new Uint8Array(bytes)).includes('MUST_NOT_RUN')))).toBe(false);
});

test("computer download waits for save action and shows checked file details",async({page})=>{
  await page.evaluate(()=>{
    window.savedBytes=0;
    window.showSaveFilePicker=async()=>({name:'local.bin',createWritable:async()=>({write:async bytes=>window.savedBytes=bytes.length,close:async()=>{},abort:async()=>{}})});
  });
  await page.route('https://files.example.org/local.bin',route=>route.fulfill({body:'payload',headers:{'access-control-allow-origin':'*','content-length':'7'}}));
  await mockModel(page,(request,round)=>{
    if(round===1) return {tool:{name:'download_to_computer',args:{url:'https://files.example.org/local.bin',fileName:'local.bin'}}};
    expect(JSON.parse(request.messages.at(-1).content)).toMatchObject({destination:'computer',bytes:7,saveStatus:'saved',checksumStatus:'computed-only'});
    return {text:'Local file saved; awaiting next instruction.'};
  });
  await ask(page,'Download to my computer');
  await expect(page.getByRole('button',{name:'Choose location and download'})).toBeVisible();
  expect(await page.evaluate(()=>window.savedBytes)).toBe(0);
  await page.getByRole('button',{name:'Choose location and download'}).click();
  await expect(page.locator('#agentMessages')).toContainText('Local file saved');
  await expect(page.locator('#agentMessages')).toContainText('SHA-256:');
  expect(await page.evaluate(()=>window.savedBytes)).toBe(7);
  expect(await page.evaluate(()=>window.sent)).toEqual([]);
});

test('task summaries survive reconnect without replay and can be cleared', async ({page}) => {
  await page.evaluate(()=>{window.__test.state.wsHost='ws://test-board';});
  await mockModel(page,()=>({text:'Inspection complete; no repair performed.'}));
  await ask(page,'Inspect storage');
  await expect(page.locator('#agentAsk')).toBeEnabled();
  await page.locator('#agentHistory > summary').tap();
  await expect(page.locator('#agentTasks')).toContainText('Inspect storage');
  await page.evaluate(()=>{window.__test.setConnected(false);window.__test.setConnected(true);});
  await expect(page.locator('#agentTasks')).toContainText('Inspection complete');
  await expect(page.locator('#agentMessages')).toBeEmpty();
  await page.locator('#agentTasks summary').first().tap();
  await page.locator('#agentTasks button').first().tap();
  await expect(page.locator('#agentQuestion')).toHaveValue(/Inspect storage/);
  await expect(page.locator('#agentMessages')).toBeEmpty();
  await page.locator('#agentForget').tap();
  await expect(page.locator('#agentTasks')).toBeEmpty();
});

for (const desktop of [false,true]) test.describe(desktop ? 'desktop task archive' : 'mobile task archive',()=>{
  test.use({isMobile:!desktop,hasTouch:!desktop,viewport:desktop?{width:1552,height:1000}:{width:390,height:844}});
  test('refresh restores summaries and the transcript without replaying commands',async ({page},testInfo)=>{
    await page.evaluate(()=>{window.__test.state.wsHost='ws://archive-board';});
    await mockModel(page,()=>({text:'Saved observation only.'}));
    await ask(page,'Verify target storage');
    await expect(page.locator('#agentAsk')).toBeEnabled();
    await page.reload(); await page.waitForFunction(()=>window.__test?.state.term);
    await page.evaluate(()=>{const {state,setConnected}=window.__test;state.mode='ws';state.wsHost='ws://archive-board';state.ws={readyState:1,send:()=>{throw new Error('unexpected replay');}};setConnected(true);});
    await page.locator('#agentButton').click();
    await page.locator('#agentHistory > summary').click();
    await page.locator('#agentTasks summary').click();
    await expect(page.locator('#agentTasks')).toContainText('Saved observation only.');
    /* The transcript comes back from local storage and is labelled unverified;
     * the throw-on-send stub above proves the refresh itself stayed offline. */
    await expect(page.locator('#agentMessages .agent-message')).not.toHaveCount(0);
    await expect(page.locator('#agentMessages')).toContainText(/unverified|未经核实/);
    expect(await page.locator('#agentPanel').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('task-archive.png')});
  });
});

for (const desktop of [false, true]) test.describe(desktop ? 'desktop agent composer' : 'mobile agent composer', () => {
  test.use({isMobile:!desktop,hasTouch:!desktop,viewport:desktop?{width:1552,height:1000}:{width:390,height:844}});
  test('focus and send shortcuts protect UART and IME; surfaces match the terminal', async ({page},testInfo) => {
    let requests=0;
    await mockModel(page,()=>{requests++;return {text:'**Ready**\n\n```sh\nuname -a\n```'};});
    await page.locator('#agentClose').click();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Control+Shift+K');
    await expect(page.locator('#agentQuestion')).toBeFocused();
    expect(await page.evaluate(()=>window.sent)).toEqual([]);
    await page.locator('#agentQuestion').fill('First line');
    await page.keyboard.press('Enter');
    await expect(page.locator('#agentQuestion')).toHaveValue('First line\n');
    await page.locator('#agentQuestion').dispatchEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true});
    expect(requests).toBe(0);
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.agent-assistant strong')).toHaveText('Ready');
    expect(requests).toBe(1);
    await expect(page.locator('#agentAsk')).toHaveAttribute('aria-label','Send');
    await expect(page.locator('#agentAsk svg')).toHaveCount(1);
    expect(await page.locator('#agentAsk').innerText()).toBe('');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Meta+Shift+K');
    await expect(page.locator('#agentQuestion')).toBeFocused();
    await page.locator('#agentQuestion').fill('Second question');
    await page.keyboard.press('Meta+Enter');
    await expect(page.locator('#agentAsk')).toBeEnabled();
    expect(requests).toBe(2);
    expect(await page.evaluate(()=>window.sent)).toEqual([]);
    for (const dark of [false,true]) {
      await page.evaluate(dark=>document.documentElement.dataset.theme=dark?'dark':'light',dark);
      const colors=await page.evaluate(()=>['#agentMessages','#terminalOutput','#agentPanel'].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor));
      expect(colors[0]).toBe(colors[1]);expect(colors[2]).toBe(colors[1]);
      expect(await page.locator('#agentPanel').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
      await page.screenshot({path:testInfo.outputPath(`composer-${dark?'dark':'light'}.png`)});
    }
  });
});

for (const desktop of [false,true]) test.describe(desktop?'desktop target binding':'mobile target binding',()=>{
 test.use({isMobile:!desktop,hasTouch:!desktop,viewport:desktop?{width:1552,height:1000}:{width:390,height:844}});
 test('AI settings verify, bind, regenerate and unbind with explicit Flash acknowledgement',async ({page},testInfo)=>{
  await page.evaluate(()=>{
   const {state,setConnected,handleIncomingBytes,bleTransport,setBindingControl}=window.__test;
   state.mode='ble';state.device={id:'bee'};state.deviceId='stable-bee';state.nusReady=true;state.reliableReady=false;
   setConnected(true);handleIncomingBytes(new TextEncoder().encode('root@board:~# '));
   window.flashId=null;window.targetId='12345678-1234-4123-8123-123456789abc';window.bindingWrites=[];
   setBindingControl(async command=>{
    if(command==='@linkr target?') return 'OK target='+(window.flashId||'none');
    window.bindingWrites.push(command);
    if(command==='@linkr target clear') window.flashId=null;
    else window.flashId=command.split('=')[1];
    return 'OK target='+(window.flashId||'none');
   });
   let pending='';
   bleTransport.write=async (_id,_service,_characteristic,bytes)=>{
    pending+=new TextDecoder().decode(bytes);
    if(pending.endsWith('\r')){
     const idMarker=pending.match(/LINKR_ID_[a-f0-9]+/),exitMarker=pending.match(/LINKR_EXIT_[a-f0-9]+/);
     /* The app writes its own terminal control to the same transport (a
      * geometry `stty rows … cols …` on connect). This stub only models tracked
      * commands; anything else must be swallowed, not indexed into — a throw
      * here fails the write, and a failed write latches `serialInputPending`,
      * which then refuses every tracked command as "not an idle prompt". */
     if(!idMarker || !exitMarker){ pending=''; return; }
     const marker=idMarker[0],exit=exitMarker[0];
     if(window.bindingPasswordPrompt) { pending=''; window.bindingPasswordPrompt=false; setTimeout(()=>handleIncomingBytes(new TextEncoder().encode('\r\n[sudo] password: ')),30); return; }
     if(pending.includes('mv -f')) window.targetId=pending.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)[0];
     pending='';setTimeout(()=>handleIncomingBytes(new TextEncoder().encode(`\r\n${marker}:${window.targetId}\r\n${exit}:0\r\nroot@board:~# `)),30);
    }
   };
  });
  await page.locator('#agentSettingsButton').click();
  // The "idle, observed POSIX shell prompt" guard is computed from the journal,
  // which the injected bytes reach on the app's own tick; clicking before it
  // lands fails with "Tracked commands require an idle, observed POSIX shell
  // prompt" instead of opening the password prompt.
  await expect.poll(() => page.evaluate(() =>
    window.__test.agentJournal.read({ limit: 4000 }).text.includes("root@board:~#"))).toBe(true);
  await page.evaluate(()=>window.bindingPasswordPrompt=true);
  await page.locator('#targetBind').click();
  await expect(page.locator('#targetBindingStatus')).toContainText('Enter the target sudo password');
  expect(await page.evaluate(()=>window.bindingWrites)).toEqual([]);
  await page.evaluate(()=>window.__test.handleIncomingBytes(new TextEncoder().encode('\r\nroot@board:~# ')));
  await page.locator('#targetVerify').click();
  await expect(page.locator('#targetBindingStatus')).toContainText('does not match');
  expect(await page.evaluate(()=>window.bindingWrites)).toEqual([]);
  await page.locator('#targetBind').click();
  await expect(page.locator('#targetBindingStatus')).toContainText('verified against Bee Flash');
  await expect(page.locator('#targetBindingIdentity')).toContainText('12345678-1234-4123-8123-123456789abc');
  await expect(page.locator('#targetRegenerate')).toBeDisabled();
  await page.locator('#targetRegenerateConfirm').check();
  await page.locator('#targetRegenerate').click();
  await expect(page.locator('#targetBindingStatus')).toContainText('verified against Bee Flash');
  const regenerated = await page.evaluate(()=>window.targetId);
  expect(regenerated).not.toBe('12345678-1234-4123-8123-123456789abc');
  await expect(page.locator('#targetBindingIdentity')).toContainText(regenerated);
  await page.locator('.target-binding').scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('binding-settings.png')});
  await page.locator('#targetUnbind').click();
  await expect(page.locator('#targetBindingStatus')).toContainText('target ID file and historical records retained');
  expect(await page.evaluate(()=>window.targetId)).toBe(regenerated);
  await page.evaluate(()=>window.__test.setBindingControl(async()=>{throw new Error('ERR unsupported; update firmware');}));
  await page.locator('#targetBind').click();
  await expect(page.locator('#targetBindingStatus')).toContainText('update firmware');
 });
});

for (const matches of [true, false]) test('automatic identity waits for shell and checks history match: '+matches, async ({page})=>{
 const id='12345678-1234-4123-8123-123456789abc';
 await page.evaluate(({id,matches})=>{
  const observedId = matches ? id : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const {state,setConnected,handleIncomingBytes,bleTransport,setBindingControl}=window.__test;
  window.identityCommands=[];
  localStorage.setItem('linkr-target-profile:'+id,JSON.stringify({tools:['curl'],model:'remembered-board',observedAt:1}));
  setBindingControl(async()=> 'OK target='+id);
  let pending='';
  bleTransport.write=async (_id,_s,_c,bytes)=>{
   pending+=new TextDecoder().decode(bytes);
   if(pending.endsWith('\r')) {
    window.identityCommands.push(pending);
    const marker=pending.match(/LINKR_ID_[a-f0-9]+/)[0],exit=pending.match(/LINKR_EXIT_[a-f0-9]+/)[0];
    pending='';setTimeout(()=>handleIncomingBytes(new TextEncoder().encode(`\r\n${marker}:${observedId}\r\n${exit}:0\r\nroot@board:~# `)),30);
   }
  };
  state.mode='ble';state.device={id:'bee'};state.deviceId='bee';state.nusReady=true;state.reliableReady=false;
  setConnected(true);handleIncomingBytes(new TextEncoder().encode('\r\nboard login: '));
 },{id,matches});
 await page.waitForTimeout(600);
 expect(await page.evaluate(()=>window.identityCommands)).toEqual([]);
 await page.evaluate(()=>window.__test.handleIncomingBytes(new TextEncoder().encode('\r\nroot@board:~# ')));
 await expect.poll(()=>page.evaluate(()=>window.identityCommands.length)).toBe(1);
 await expect(page.locator('#agentAsk')).toBeEnabled();
 let status;
 await mockModel(page,(body,count)=>{
  if(count===1)return {tool:{name:'get_device_status',args:{}}};
  status=JSON.parse(body.messages.findLast(m=>m.role==='tool').content);
  return {text:'Loaded remembered device.'};
 });
 await page.locator('#agentQuestion').fill('What do you remember?');await page.locator('#agentAsk').click();
 await expect(page.locator('#agentMessages')).toContainText('Loaded remembered device.');
 expect(status.targetBinding).toMatchObject({targetId:id,verified:matches});
 if(matches) expect(status.rememberedProfile.profile.model).toBe('remembered-board');
 else expect(status.rememberedProfile).toBeNull();
 expect(await page.evaluate(()=>window.identityCommands.length)).toBe(1);
 expect(await page.evaluate(()=>window.identityCommands[0])).not.toMatch(/uname|command -v|mkdir|sudo/);
});

test('blocked task plans render verification and persist recovery steps without serial writes', async ({page}) => {
 await page.evaluate(()=>{window.__test.state.wsHost='plan-test-device';});
 await mockModel(page,(body,count)=> count===1 ? {tool:{name:'read_serial_log',args:{}}} : count===2 ? {tool:{name:'update_task_plan',args:{steps:[
  {title:'Inspect service',kind:'observation',status:'completed',expectedResult:'Read current diagnostic logs',evidenceIds:[JSON.parse(body.messages.at(-1).content).taskEvidence.id],verification:'Observed current diagnostic logs',nextAction:''},
  {title:'Verify recovery',status:'blocked',verification:'Device unavailable',nextAction:'Reconnect and inspect current service state'},
 ]}}} : {text:'Task is incomplete; reconnect before continuing.'});
 await ask(page,'Plan the service repair');
 await expect(page.locator('#agentMessages')).toContainText('[Blocked] Verify recovery');
 await expect(page.locator('#agentMessages')).toContainText('Reconnect and inspect current service state');
 await expect(page.locator('#agentAsk')).toBeEnabled();
 const tasks=await page.evaluate(()=>JSON.parse(localStorage.getItem('linkr-agent-tasks-v1')));
 expect(tasks.at(-1).status).toBe('interrupted');
 expect(tasks.at(-1).plan[1].nextAction).toContain('Reconnect');
 expect(tasks.at(-1).plan[0].completion).toBe('observed');
 expect(tasks.at(-1).plan[0].evidence[0].tool).toBe('read_serial_log');
 await expect(page.locator('#agentMessages')).toContainText('Observation recorded; repair not verified');
 expect(await page.evaluate(()=>window.sent)).toEqual([]);
});

test('the app rejects a claimed repair with invented evidence instead of displaying a completed plan',async({page})=>{
 await page.evaluate(()=>{window.__test.state.wsHost='unverified-plan-device';});
 await mockModel(page,(_body,round)=>round===1?{tool:{name:'update_task_plan',args:{steps:[{
  title:'Repair complete',kind:'action',status:'completed',expectedResult:'Service is active',
  verification:'I think the command succeeded',nextAction:'',evidenceIds:['evidence-invented'],
 }]}}}:{text:'No verified repair result is available.'});
 await ask(page,'Verify the repair');
 await expect(page.locator('#agentAsk')).toBeEnabled();
 await expect(page.locator('#agentMessages')).toContainText('Historical or invented evidence is not current');
 await expect(page.locator('#agentMessages')).not.toContainText('[Completed] Repair complete');
 const tasks=await page.evaluate(()=>JSON.parse(localStorage.getItem('linkr-agent-tasks-v1')));
 expect(tasks.at(-1).plan).toEqual([]);
 expect(await page.evaluate(()=>window.sent)).toEqual([]);
});

test('a page reload restores pending references as unknown and blocks resending the recorded operation',async({page})=>{
 await page.evaluate(()=>{window.__test.state.wsHost='ws://checkpoint-device';
  const send=window.__test.state.ws.send;
  window.__test.state.ws.send=bytes=>{
   if(new TextDecoder().decode(bytes).includes('/tmp/checkpoint-fixture')) {
    const last=JSON.parse(localStorage.getItem('linkr-agent-tasks-v1')).at(-1);
    window.checkpointBeforeSend=last.checkpoint.pendingExecutions.some(ref=>ref.delivery==='unknown' && /^[a-f0-9]{64}$/.test(ref.requestFingerprint));
   }
   send(bytes);
  };
  window.__test.handleIncomingBytes(new TextEncoder().encode('\nradxa@fixture:~$ '));});
 await chooseMode(page,'full-auto');
 await mockModel(page,(body,round)=>{
  if(round===1 || round===6)return {tool:{name:'run_shell_command',args:{command:'touch /tmp/checkpoint-fixture'}}};
  if(round===2)return {text:'The command was sent; its result is still unknown.'};
  if(round===3)return {tool:{name:'get_device_status',args:{}}};
  if(round===4)return {tool:{name:'read_serial_log',args:{}}};
  if(round===5)return {tool:{name:'get_task_checkpoint',args:{}}};
  expect(JSON.stringify(body.messages.at(-1))).toContain('unresolved historical execution');
  return {text:'The prior execution is unknown and was not re-sent.'};
 });
 await ask(page,'Create the fixture file');
 await expect(page.locator('#agentAsk')).toBeEnabled();
 const original=await page.evaluate(()=>JSON.parse(localStorage.getItem('linkr-agent-tasks-v1')).at(-1));
 expect(original.status).toBe('interrupted');
 expect(await page.evaluate(()=>window.checkpointBeforeSend)).toBe(true);
 expect(original.checkpoint.pendingExecutions).toHaveLength(1);
 expect(original.checkpoint.pendingExecutions[0].requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
 await page.reload();await page.waitForFunction(()=>window.__test?.state.term);
 await page.evaluate(()=>{const {state,setConnected}=window.__test;window.replayed=[];
  state.mode='ws';state.wsHost='ws://checkpoint-device';state.ws={readyState:1,send:bytes=>window.replayed.push(Array.from(bytes))};setConnected(true);});
 await page.locator('#agentButton').click();
 await ask(page,'Continue checking the prior task');
 await expect(page.locator('#agentAsk')).toBeEnabled();
 await expect(page.locator('#agentMessages')).toContainText('unavailable · unknown');
 await expect(page.locator('#agentMessages')).toContainText('was not re-sent');
 expect(await page.evaluate(()=>window.replayed)).toEqual([]);
});

test('agent locates late documentation and serial errors without UART writes', async ({page})=>{
 await page.route('https://docs.example.org/long',route=>route.fulfill({contentType:'text/plain',headers:{'access-control-allow-origin':'*'},body:'a'.repeat(17000)+'\nRECOVERY: inspect root filesystem'}));
 await page.evaluate(()=>window.__test.handleIncomingBytes(new TextEncoder().encode('\nERROR [disk] unavailable\n')));
 await mockModel(page,(body,count)=>{
  if(count===1)return {tool:{name:'read_web_page',args:{url:'https://docs.example.org/long',find:'RECOVERY'}}};
  const result=JSON.parse(body.messages.findLast(m=>m.role==='tool').content);
  if(count===2){expect(result.matchFound).toBe(true);expect(result.offset).toBeGreaterThan(16000);return {tool:{name:'search_serial_log',args:{query:'ERROR [disk]'}}};}
  expect(result.matches[0].excerpt).toContain('unavailable');return {text:'Located recovery documentation and disk error.'};
 });
 await ask(page,'Find recovery guidance and the disk error');
 await expect(page.locator('#agentMessages')).toContainText('Located recovery documentation and disk error.');
 await expect(page.locator('#agentMessages')).toContainText('Read range');
 expect(await page.evaluate(()=>window.sent)).toEqual([]);
});

for(const width of [390,1280]) test(`running input queues support steering and follow-up at width ${width}`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:844});
 let release;const gate=new Promise(resolve=>release=resolve);
 await mockModel(page,async(body,count)=>{
  if(count===1){await gate;return {text:'Initial complete.'};}
  const user=body.messages.findLast(m=>m.role==='user');
  expect(user.content).toBe(count===2?'Use read-only checks':'Summarize afterwards');
  return {text:count===2?'Applied clarification.':'Follow-up complete.'};
 });
 await ask(page,'Inspect the device');
 await expect(page.locator('#agentQueueControls')).toBeVisible();
 await expect(page.locator('#agentFollowUp')).toBeEnabled();
 await page.locator('#agentQuestion').fill('Summarize afterwards');await page.locator('#agentFollowUp').click();
 await page.locator('#agentQuestion').fill('Use read-only checks');await page.locator('#agentSteer').click();
 await expect(page.locator('#agentQueue')).toContainText('Summarize afterwards');
 await page.screenshot({path:testInfo.outputPath(`agent-queue-${width}.png`)});
 release();
 await expect(page.locator('#agentMessages')).toContainText('Follow-up complete.');
 await expect(page.locator('#agentQueueControls')).toBeHidden();
 expect(await page.evaluate(()=>window.sent)).toEqual([]);
});
