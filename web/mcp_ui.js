/* MCP server settings card + on-phone approval banner.
 *
 * Only the Android build has a native MCP listener (window.LinkrMcp), so this
 * module is inert everywhere else: createMcpUi() is called with a host only
 * when the native bridge exists, and the card stays out of the DOM otherwise.
 *
 * The card is the only place that knows how the server is exposed to the user:
 * endpoint, bearer token, access policy and the audit of external calls. The
 * approval banner is deliberately outside the settings panel — an external AI
 * can ask for a write while the user is looking at the terminal, and a request
 * that nobody sees would otherwise block until it times out.
 */
import { claudeConfigSnippet, redactToolArguments } from "./mcp_server.js";

const labels = {
  title: ["MCP 服务器", "MCP server"],
  enable: ["允许局域网内的 AI 客户端连接", "Allow AI clients on this network"],
  enableHint: ["Claude Desktop、Cursor、Codex 等 MCP 客户端可调用本机的串口与配件管理能力。需要保持 App 运行并连接 Linkr Bee；App 被系统杀掉后服务停止。", "MCP clients such as Claude Desktop, Cursor or Codex can use this device's serial console and accessory management. Keep the app running and Linkr Bee connected; the service stops if Android kills the app."],
  warning: ["拿到访问令牌的人都能向串口发送输入。请只在可信网络启用，并定期更换令牌；不要把这个地址暴露到公网。", "Anyone holding the access token can send serial input. Enable this only on a trusted network, rotate the token, and never expose the address to the internet."],
  access: ["访问权限", "Access"],
  accessHint: ["只读模式不弹任何确认，只拒绝修改设备的工具；每条确认模式对每次写入和扫描都要在手机上确认；仅高危模式只对破坏性命令、凭据/网络变更和桥接暴露确认，其余写入直接执行；完全授权不弹任何确认。", "Read-only asks nothing and refuses every device-changing tool. Every-command mode asks on the phone for each write and scan. High-risk-only mode asks only for destructive shell commands, credential or network changes and bridge exposure, and runs other writes directly. Fully authorized asks nothing."],
  accessConfirm: ["写入（每条命令需要授权）", "Read and write: every command needs approval"],
  accessGuarded: ["写入（仅高危命令需要授权）", "Read and write: only high-risk commands need approval"],
  accessAuto: ["写入（完全授权）", "Read and write: fully authorized"],
  accessRead: ["只读（不需要授权）", "Read-only: no approval needed"],
  accessAutoWarning: ["写入确认已关闭：任何拿到访问令牌的客户端都可以直接向串口发送输入、修改桥接设置，手机不会再弹出确认。请只在完全可信的网络与客户端上使用；更安全的选项是「写入：每条命令需要授权」。", "Write approval is off: any client holding the token can send serial input and change bridge settings with no prompt on the phone. Use only with fully trusted networks and clients; the every-command approval mode is the safer choice."],
  accessAutoConfirm: ["启用「完全授权」后，拿到访问令牌的客户端可以在没有手机确认的情况下执行串口写入和配置修改。确定启用？", "With fully-authorized mode, any client holding the token can send serial input and change settings without a confirmation on the phone. Enable it?"],
  accessGuardedWarning: ["仅高危模式依赖尽力而为的命令规则：未命中的写入会直接执行，脚本、变量或解释器间接执行无法识别。凭据、网络与桥接变更仍会确认。", "High-risk-only mode relies on best-effort command patterns: writes that do not match run directly, and indirect execution through scripts, variables or interpreters cannot be recognized. Credential, network and bridge changes still ask."],
  accessGuardedConfirm: ["启用「仅高危」后，未命中高危规则的写入会在没有手机确认的情况下执行；高危判定是尽力而为的规则，不是沙箱。确定启用？", "With high-risk-only mode, writes that do not match the high-risk rules run without a phone confirmation. The rules are best effort, not a sandbox. Enable it?"],
  port: ["端口", "Port"],
  portHint: ["1024–65535。修改端口会重启服务。", "1024–65535. Changing the port restarts the service."],
  bind: ["监听地址", "Listen on"],
  bindLan: ["所有网络接口（同网段可访问）", "All interfaces (reachable on the LAN)"],
  bindLoopback: ["仅本机回环", "Loopback only"],
  endpoint: ["MCP 地址", "MCP endpoint"],
  a2aEndpoint: ["A2A Agent Card", "A2A agent card"],
  a2aHint: ["同一端口提供 A2A：客户端读取这个 card，再用同一个令牌向 /a2a 发送 JSON-RPC 任务；启动任务时手机会确认一次。", "The same server exposes A2A: a client reads this card and sends JSON-RPC tasks to /a2a with the same token. Starting a task asks on the phone once."],
  token: ["访问令牌", "Access token"],
  tokenHint: ["令牌只保存在这台手机上，不会上传。复制到 AI 客户端的配置里；重新生成后旧令牌立即失效。", "The token stays on this phone and is never uploaded. Copy it into the AI client configuration; regenerating invalidates the old token immediately."],
  showToken: ["显示令牌", "Show token"],
  hideToken: ["隐藏令牌", "Hide token"],
  copy: ["复制", "Copy"],
  copied: ["已复制。", "Copied."],
  copyFailed: ["复制失败，请手动选择文本。", "Copy failed; select the text manually."],
  regenerate: ["重新生成令牌", "Regenerate token"],
  regenerateConfirm: ["重新生成后旧令牌立即失效，已连接的客户端需要更新配置。继续？", "The old token stops working immediately and connected clients need the new one. Continue?"],
  regenerated: ["已生成新令牌，旧令牌已失效。", "New token generated; the old one is invalid."],
  clientConfig: ["在 AI 客户端中接入", "Connect an AI client"],
  clientConfigHint: ["把下面的配置加入 Claude Desktop 的 claude_desktop_config.json（或 Cursor 的 MCP 设置）。任何支持 Streamable HTTP 传输的 MCP 客户端都可以用这个地址和令牌。", "Add this to Claude Desktop's claude_desktop_config.json (or Cursor's MCP settings). Any MCP client that supports the Streamable HTTP transport can use this URL and token."],
  audit: ["最近调用", "Recent calls"],
  auditEmpty: ["还没有外部调用。", "No external calls yet."],
  auditHint: ["只保留最近 50 次调用，参数中的口令与令牌已打码。", "Only the latest 50 calls are kept; passwords and tokens in arguments are masked."],
  running: ["运行中", "Running"],
  idle: ["已启用但未运行：通知栏“停止”后请关闭再启用，或重启 App。", "Enabled but not running: after the notification's Stop action, toggle it off and on again, or restart the app."],
  stopped: ["未启用", "Disabled"],
  stopping: ["正在停止…", "Stopping…"],
  foreground: ["App 在前台", "App in the foreground"],
  background: ["App 在后台：需要手机确认的写入可能失败。", "App in the background: writes that need approval may fail."],
  notConnected: ["当前未连接 Linkr Bee；串口与配件工具会返回明确错误。", "Linkr Bee is not connected; serial and accessory tools will return an explicit error."],
  errorPrefix: ["服务错误：", "Service error: "],
  portError: ["端口必须是 1024 到 65535 之间的整数。", "Port must be an integer between 1024 and 65535."],
  approvalTitle: ["AI 请求执行操作", "An AI client requests approval"],
  approvalArgs: ["参数", "Arguments"],
  approvalHint: ["该操作会通过当前连接执行。核对参数后允许或拒绝；拒绝的原因会返回给 AI。", "This runs over the current connection. Check the arguments before allowing; a denial is reported back to the AI."],
  approvalAllow: ["允许执行", "Allow"],
  approvalDeny: ["拒绝", "Deny"],
  approvalTimeout: ["等待超时，操作未执行。", "Timed out; nothing was executed."],
  approvalDenied: ["已拒绝，操作未执行。", "Denied; nothing was executed."],
  approvalBackground: ["App 不在前台，写入操作需要在手机上确认，因此未执行。", "The app is not in the foreground, so the write was not executed."],
  approvalBusy: ["已有另一个等待确认的请求。", "Another approval is already pending."],
  tool_get_device_status: ["读取设备状态", "Read device status"],
  tool_read_serial_log: ["读取串口日志", "Read serial log"],
  tool_search_serial_log: ["查找串口日志", "Search serial log"],
  tool_get_accessory_diagnostics: ["读取配件诊断", "Read accessory diagnostics"],
  tool_wifi_scan: ["扫描附近 WiFi", "Scan nearby WiFi"],
  tool_send_serial_input: ["发送串口输入", "Send serial input"],
  tool_set_uart_config: ["修改桥接串口参数", "Change bridge UART settings"],
  tool_set_wifi: ["配置配件 WiFi", "Configure accessory WiFi"],
  tool_set_webdav: ["配置日志上传", "Configure log upload"],
  tool_get_bee_status: ["读取主机状态", "Read Bee status"],
  tool_scan_bee_devices: ["扫描附近的主机", "Scan for Bee boards"],
  tool_connect_bee: ["连接主机", "Connect Bee"],
  tool_disconnect_bee: ["断开主机", "Disconnect Bee"],
  tool_set_bee_name: ["修改主机蓝牙名", "Change Bee BLE name"],
  tool_set_lan_bridge: ["配置主机局域网桥接", "Configure Bee LAN bridge"],
  tool_get_execution_status: ["读取执行状态", "Read execution status"],
  tool_get_agent_status: ["读取常驻助手状态", "Read resident agent status"],
  tool_start_agent_task: ["启动常驻助手任务", "Start resident agent task"],
  tool_get_agent_task: ["读取常驻助手任务", "Read resident agent task"],
  tool_list_agent_tasks: ["列出常驻助手任务", "List resident agent tasks"],
  tool_cancel_agent_task: ["取消常驻助手任务", "Cancel resident agent task"],
};

const TOOL_LABEL_KEYS = {
  get_device_status: "tool_get_device_status",
  read_serial_log: "tool_read_serial_log",
  search_serial_log: "tool_search_serial_log",
  get_accessory_diagnostics: "tool_get_accessory_diagnostics",
  wifi_scan: "tool_wifi_scan",
  send_serial_input: "tool_send_serial_input",
  set_uart_config: "tool_set_uart_config",
  set_wifi: "tool_set_wifi",
  set_webdav: "tool_set_webdav",
  get_bee_status: "tool_get_bee_status",
  scan_bee_devices: "tool_scan_bee_devices",
  connect_bee: "tool_connect_bee",
  disconnect_bee: "tool_disconnect_bee",
  set_bee_name: "tool_set_bee_name",
  set_lan_bridge: "tool_set_lan_bridge",
  get_execution_status: "tool_get_execution_status",
  get_agent_status: "tool_get_agent_status",
  start_agent_task: "tool_start_agent_task",
  get_agent_task: "tool_get_agent_task",
  list_agent_tasks: "tool_list_agent_tasks",
  cancel_agent_task: "tool_cancel_agent_task",
};

const APPROVAL_TIMEOUT_MS = 90000;
const REFRESH_INTERVAL_MS = 3000;
/* Ordered most to least restrictive. Moving to a less restrictive mode that
 * removes routine approval (guarded/auto) is a security decision, so the card
 * asks once before saving it. */
const ACCESS_RANK = { read: 0, confirm: 1, guarded: 2, auto: 3 };

export function createMcpUi({ mount, getLang, host, getBridge = () => null }) {
  if (!mount || !host) return null;
  const langIndex = () => (String(getLang?.() || "en").toLowerCase().startsWith("zh") ? 0 : 1);
  const text = (key) => labels[key]?.[langIndex()] || key;
  const toolText = (name) => text(TOOL_LABEL_KEYS[name] || name);

  const section = document.createElement("section");
  section.id = "mcpSettings";
  section.className = "card mcp-settings";
  section.dataset.settingsPage = "ai";
  section.hidden = true;
  section.setAttribute("aria-labelledby", "mcpSettingsTitle");
  section.innerHTML = `
    <div class="card-title"><span class="dot"></span><span id="mcpSettingsTitle" data-mcp="title"></span></div>
    <div class="mcp-settings-body">
        <label class="check"><input id="mcpEnabled" type="checkbox"><span data-mcp="enable"></span></label>
        <p class="field-hint" data-mcp="enableHint"></p>
        <p class="field-hint mcp-warning" data-mcp="warning"></p>
        <label class="field"><span class="field-label" data-mcp="access"></span>
          <select id="mcpAccess">
            <option value="read" data-mcp-option="accessRead"></option>
            <option value="confirm" data-mcp-option="accessConfirm"></option>
            <option value="guarded" data-mcp-option="accessGuarded"></option>
            <option value="auto" data-mcp-option="accessAuto"></option>
          </select>
          <span class="field-hint" data-mcp="accessHint"></span>
        </label>
        <p id="mcpAutoWarning" class="field-hint mcp-warning" data-mcp="accessAutoWarning" hidden></p>
        <p id="mcpGuardedWarning" class="field-hint mcp-warning" data-mcp="accessGuardedWarning" hidden></p>
        <label class="field"><span class="field-label" data-mcp="port"></span>
          <input id="mcpPort" type="number" inputmode="numeric" min="1024" max="65535" step="1">
          <span class="field-hint" data-mcp="portHint"></span>
        </label>
        <label class="field"><span class="field-label" data-mcp="bind"></span>
          <select id="mcpBind">
            <option value="lan" data-mcp-option="bindLan"></option>
            <option value="loopback" data-mcp-option="bindLoopback"></option>
          </select>
        </label>
        <div id="mcpEndpointBlock" hidden>
          <label class="field"><span class="field-label" data-mcp="endpoint"></span>
            <span class="password-row">
              <input id="mcpUrl" type="text" readonly spellcheck="false">
              <button id="mcpCopyUrl" class="btn btn-soft" type="button" data-mcp="copy"></button>
            </span>
          </label>
          <label class="field"><span class="field-label" data-mcp="a2aEndpoint"></span>
            <span class="password-row">
              <input id="mcpA2aCard" type="text" readonly spellcheck="false">
              <button id="mcpCopyA2a" class="btn btn-soft" type="button" data-mcp="copy"></button>
            </span>
            <span class="field-hint" data-mcp="a2aHint"></span>
          </label>
          <label class="field"><span class="field-label" data-mcp="token"></span>
            <span class="password-row">
              <input id="mcpToken" type="password" readonly spellcheck="false" autocomplete="off">
              <button id="mcpTokenToggle" class="btn btn-soft" type="button" data-mcp="showToken"></button>
              <button id="mcpCopyToken" class="btn btn-soft" type="button" data-mcp="copy"></button>
            </span>
            <span class="field-hint" data-mcp="tokenHint"></span>
          </label>
          <div class="agent-actions">
            <button id="mcpRegenerate" class="btn" type="button" data-mcp="regenerate"></button>
          </div>
        </div>
        <details id="mcpClientConfig" class="mcp-client-config">
          <summary data-mcp="clientConfig"></summary>
          <p class="field-hint" data-mcp="clientConfigHint"></p>
          <pre id="mcpSnippet" class="mcp-snippet"></pre>
          <div class="agent-actions"><button id="mcpCopySnippet" class="btn" type="button" data-mcp="copy"></button></div>
        </details>
        <details id="mcpAudit" class="mcp-audit">
          <summary data-mcp="audit"></summary>
          <p class="field-hint" data-mcp="auditHint"></p>
          <div id="mcpAuditList" class="mcp-audit-list" role="status"></div>
        </details>
        <p id="mcpStatus" class="field-hint" role="status"></p>
    </div>`;

  // Appended in the settings panel rather than in index.html: the section must
  // not exist on builds without the native MCP listener (web, iOS, HarmonyOS).
  // Keep MCP inside the AI card's single scroll container. Previously it was a
  // second .agent-settings page with its own scroll area, which split the AI
  // page into two panes on phones and left the lower card cut off.
  const anchor = mount.querySelector("#agentSettings");
  const aiScroll = anchor?.querySelector(".agent-settings-scroll");
  if (aiScroll) aiScroll.append(section);
  else if (anchor) anchor.append(section);
  else mount.appendChild(section);

  // MCP inputs now live inside the AI form; Enter must not submit the AI
  // configuration. Their change handlers already persist the MCP fields.
  section.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.closest("input, select")) {
      event.preventDefault();
    }
  });

  const $ = (id) => section.querySelector(`#${id}`);
  const elements = {
    enabled: $("mcpEnabled"), access: $("mcpAccess"),
    port: $("mcpPort"), bind: $("mcpBind"), endpoint: $("mcpEndpointBlock"),
    url: $("mcpUrl"), a2aCard: $("mcpA2aCard"), copyA2a: $("mcpCopyA2a"),
    token: $("mcpToken"), tokenToggle: $("mcpTokenToggle"),
    copyUrl: $("mcpCopyUrl"), copyToken: $("mcpCopyToken"), regenerate: $("mcpRegenerate"),
    snippet: $("mcpSnippet"), copySnippet: $("mcpCopySnippet"), status: $("mcpStatus"),
    auditList: $("mcpAuditList"), clientConfig: $("mcpClientConfig"), audit: $("mcpAudit"),
    autoWarning: $("mcpAutoWarning"),
    guardedWarning: $("mcpGuardedWarning"),
  };

  const banner = document.createElement("div");
  banner.id = "mcpApproval";
  banner.className = "mcp-approval";
  banner.hidden = true;
  banner.setAttribute("role", "alertdialog");
  banner.setAttribute("aria-live", "assertive");
  banner.innerHTML = `
    <p class="mcp-approval-title"></p>
    <p class="mcp-approval-tool"></p>
    <p class="mcp-approval-args-label" data-mcp="approvalArgs"></p>
    <pre class="mcp-approval-args"></pre>
    <p class="field-hint" data-mcp="approvalHint"></p>
    <div class="agent-actions">
      <button type="button" class="btn" data-mcp="approvalDeny"></button>
      <button type="button" class="btn btn-primary" data-mcp="approvalAllow"></button>
    </div>`;
  document.body.append(banner);
  const bannerParts = {
    title: banner.querySelector(".mcp-approval-title"),
    tool: banner.querySelector(".mcp-approval-tool"),
    argsLabel: banner.querySelector(".mcp-approval-args-label"),
    args: banner.querySelector(".mcp-approval-args"),
    hint: banner.querySelector('[data-mcp="approvalHint"]'),
    deny: banner.querySelector('[data-mcp="approvalDeny"]'),
    allow: banner.querySelector('[data-mcp="approvalAllow"]'),
  };

  let config = host.getConfig();
  let state = host.getState();
  let busy = false;
  let pendingApproval = null;
  let approvalActionSubscription = null;
  let approvalCounter = 0;
  let refreshInFlight = false;
  let refreshTimer = null;
  let transientStatus = null;
  /* The banner normally lives in <body>; entering real fullscreen moves it
   * inside the fullscreen element, and hiding it puts it back. */
  let bannerOriginalParent = null;

  function applyLabels() {
    section.querySelectorAll("[data-mcp]").forEach((node) => {
      const key = node.getAttribute("data-mcp");
      if (labels[key]) node.textContent = text(key);
    });
    section.querySelectorAll("[data-mcp-option]").forEach((node) => {
      const key = node.getAttribute("data-mcp-option");
      if (labels[key]) node.textContent = text(key);
    });
    bannerParts.argsLabel.textContent = text("approvalArgs");
    bannerParts.hint.textContent = text("approvalHint");
    bannerParts.deny.textContent = text("approvalDeny");
    bannerParts.allow.textContent = text("approvalAllow");
    banner.querySelector(".mcp-approval-title").textContent = text("approvalTitle");
  }

  function setStatus(message, isError = false) {
    elements.status.textContent = message || "";
    elements.status.classList.toggle("field-error", Boolean(isError));
  }

  /* Handlers run refresh() after saving, and render() rewrites the status line;
   * a one-off confirmation or validation error would vanish instantly. Keep it
   * for a few seconds (or until the next action replaces it). */
  function setTransientStatus(message, isError = false, ttlMs = 8000) {
    transientStatus = { message, isError, until: Date.now() + ttlMs };
    setStatus(message, isError);
  }

  function renderStatus(defaultMessage, isError = false) {
    if (transientStatus && Date.now() < transientStatus.until) {
      setStatus(transientStatus.message, transientStatus.isError);
      return;
    }
    transientStatus = null;
    setStatus(defaultMessage, isError);
  }

  /* A new user action supersedes a previous confirmation/error, otherwise a
   * stale "new token generated" line would hide the state that action produced. */
  function clearTransientStatus() {
    transientStatus = null;
  }

  function tokenVisible() {
    return elements.token.type === "text";
  }

  function render() {
    const lang = langIndex();
    section.hidden = false;
    elements.enabled.checked = Boolean(config.enabled);
    if (document.activeElement !== elements.port) elements.port.value = String(config.port);
    elements.access.value = config.access;
    elements.access.classList.toggle("is-danger", config.access === "auto");
    elements.autoWarning.hidden = config.access !== "auto";
    elements.guardedWarning.hidden = config.access !== "guarded";
    elements.bind.value = config.bind;
    elements.access.disabled = busy;
    elements.port.disabled = busy;
    elements.bind.disabled = busy;
    elements.enabled.disabled = busy;
    elements.tokenToggle.textContent = tokenVisible() ? text("hideToken") : text("showToken");
    elements.tokenToggle.setAttribute("aria-pressed", String(tokenVisible()));

    const endpointReady = Boolean(config.enabled && (state.running || state.token));
    elements.endpoint.hidden = !endpointReady;
    const url = state.url || (config.bind === "loopback"
      ? `http://127.0.0.1:${config.port}/mcp`
      : `http://<phone-ip>:${config.port}/mcp`);
    if (document.activeElement !== elements.url) elements.url.value = url;
    const a2aCardUrl = (state.url || url).replace(/\/mcp$/, "/.well-known/agent-card.json");
    if (document.activeElement !== elements.a2aCard) elements.a2aCard.value = a2aCardUrl;
    elements.token.value = state.token || "";
    elements.regenerate.disabled = busy || !state.running;
    const snippet = claudeConfigSnippet({ url: state.url || url, token: state.token || "" });
    elements.snippet.textContent = snippet;

    if (!config.enabled) renderStatus(text("stopped"));
    else if (state.lastError) renderStatus(`${text("errorPrefix")}${state.lastError}`, true);
    else if (state.running) {
      const foreground = state.foreground ? text("foreground") : text("background");
      renderStatus(`${text("running")} · ${state.url || url} · ${foreground}`, !state.foreground);
    } else renderStatus(text("idle"), true);

    renderAudit(lang);
  }

  function renderAudit() {
    const entries = host.getAudit?.() || [];
    elements.auditList.textContent = "";
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "field-hint";
      empty.textContent = text("auditEmpty");
      elements.auditList.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "mcp-audit-row";
      const head = document.createElement("p");
      head.className = "mcp-audit-head";
      const time = entry.at ? new Date(entry.at) : null;
      const stamp = time && !Number.isNaN(time.getTime()) ? time.toLocaleTimeString() : "";
      head.textContent = `${stamp} · ${toolText(entry.tool)}`;
      const meta = document.createElement("p");
      meta.className = "field-hint";
      const parts = [entry.outcome, entry.message].filter(Boolean);
      if (entry.remote) parts.push(entry.remote);
      meta.textContent = parts.join(" · ");
      row.append(head, meta);
      elements.auditList.append(row);
    }
  }

  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      if (typeof host.refreshState === "function") state = await host.refreshState();
      else state = host.getState();
      config = host.getConfig();
      render();
      /* Android can pause the Activity without changing WebView visibility, and
       * it can also resume without a stateChanged event reaching the WebView.
       * Re-check the approval surface on every refresh as well. */
      if (pendingApproval) {
        if (await isAppHidden()) void notificationOnHide();
        else void resurfacePendingApproval();
      }
    } finally {
      refreshInFlight = false;
    }
  }

  function readForm() {
    return {
      port: Number(elements.port.value),
      bind: elements.bind.value,
      access: elements.access.value,
    };
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      setTransientStatus(text("copied"), false, 4000);
    } catch {
      // A WebView without clipboard permission still lets the user select text.
      setTransientStatus(text("copyFailed"), true, 6000);
    }
  }

  elements.enabled.addEventListener("change", async () => {
    if (busy) return;
    /* Capture the intent before render(): render() mirrors the persisted
     * configuration, which does not have this change yet, so reading the
     * checkbox afterwards would undo the user's click. */
    const wanted = elements.enabled.checked;
    const form = readForm();
    clearTransientStatus();
    busy = true;
    render();
    let feedback = null;
    try {
      await host.setConfig(form);
      config = host.getConfig();
      if (wanted) {
        await host.enable();
        /* Android 13+ needs POST_NOTIFICATIONS for background approvals. Ask
         * now, while the user is in the app; a refusal only degrades to the
         * in-app card. */
        try {
          Promise.resolve(getBridge?.()?.requestApprovalPermission?.()).catch(() => {});
        } catch {
          /* older shells without the method keep the in-app card */
        }
      } else await host.disable();
    } catch (error) {
      feedback = { message: `${text("errorPrefix")}${error?.message || ""}`, isError: true };
    } finally {
      busy = false;
      await refresh();
      /* After refresh(), so render() cannot immediately overwrite the reason. */
      if (feedback) setTransientStatus(feedback.message, feedback.isError, 15000);
    }
  });

  for (const input of [elements.port, elements.bind, elements.access]) {
    input.addEventListener("change", async () => {
      if (busy) return;
      /* Same ordering rule as the enable checkbox: read the edited controls
       * first, because render() rewrites them from the saved configuration. */
      const form = readForm();
      /* Loosening the access mode is a security decision, not a routine
       * preference: ask once when moving to a mode that skips routine approval,
       * and leave the previous mode selected on cancel. */
      const loosening = input === elements.access
        && ACCESS_RANK[form.access] > ACCESS_RANK[config.access];
      if (loosening && (form.access === "guarded" || form.access === "auto")
          && !window.confirm(text(form.access === "auto" ? "accessAutoConfirm" : "accessGuardedConfirm"))) {
        render();
        return;
      }
      clearTransientStatus();
      busy = true;
      render();
      let feedback = null;
      try {
        await host.setConfig(form);
        config = host.getConfig();
      } catch (error) {
        feedback = { message: error?.message || text("portError"), isError: true };
      } finally {
        busy = false;
        await refresh();
        if (feedback) setTransientStatus(feedback.message, true, 15000);
      }
    });
  }

  elements.tokenToggle.addEventListener("click", () => {
    elements.token.type = tokenVisible() ? "password" : "text";
    render();
  });
  elements.copyUrl.addEventListener("click", () => copyText(elements.url.value));
  elements.copyA2a.addEventListener("click", () => copyText(elements.a2aCard.value));
  elements.copyToken.addEventListener("click", () => copyText(elements.token.value));
  elements.copySnippet.addEventListener("click", () => copyText(elements.snippet.textContent || ""));

  elements.regenerate.addEventListener("click", async () => {
    if (busy || !state.running) return;
    if (!window.confirm(text("regenerateConfirm"))) return;
    clearTransientStatus();
    busy = true;
    render();
    let feedback = null;
    try {
      if (typeof host.regenerateToken === "function") await host.regenerateToken();
      feedback = { message: text("regenerated"), isError: false };
    } catch (error) {
      feedback = { message: `${text("errorPrefix")}${error?.message || ""}`, isError: true };
    } finally {
      busy = false;
      await refresh();
      if (feedback) setTransientStatus(feedback.message, feedback.isError, feedback.isError ? 15000 : 8000);
    }
  });

  function placeBanner() {
    if (typeof document === "undefined") return;
    const target = document.fullscreenElement || document.body;
    if (!target || banner.parentElement === target) return;
    bannerOriginalParent = banner.parentElement || null;
    target.append(banner);
  }

  function restoreBannerPlacement() {
    if (bannerOriginalParent && banner.parentElement !== bannerOriginalParent) {
      bannerOriginalParent.append(banner);
    }
    bannerOriginalParent = null;
  }

  /* Fullscreen can start or end while the banner is open; keep it inside the
   * element that is actually painted. */
  function onFullscreenChange() {
    if (banner.hidden) return;
    if (typeof document !== "undefined" && document.fullscreenElement) placeBanner();
    else restoreBannerPlacement();
  }

  function hideBanner() {
    banner.hidden = true;
    bannerParts.tool.textContent = "";
    bannerParts.args.textContent = "";
    restoreBannerPlacement();
  }

  function showBanner(request) {
    bannerParts.title.textContent = text("approvalTitle");
    bannerParts.tool.textContent = toolText(request.tool);
    const redacted = redactToolArguments(request.tool, request.args || {});
    let pretty;
    try { pretty = JSON.stringify(redacted, null, 2); } catch { pretty = String(redacted); }
    bannerParts.args.textContent = pretty;
    /* Real fullscreen only paints descendants of the fullscreen element; the
     * fallback class is handled by the CSS z-index. */
    placeBanner();
    banner.hidden = false;
    bannerParts.allow.focus({ preventScroll: true });
  }

  /* The notification body never carries raw tool arguments: it names the tool
   * and the (already redacted) summary, and the notification is PRIVATE on the
   * lock screen. A resident-task summary starts with policy wording, so using
   * it verbatim would hide the actual request; the owner must recognize what
   * the task is about, so that tool spends the body on args.request. */
  function notificationBody(request) {
    const tool = toolText(request?.tool);
    if (request?.tool === "start_agent_task") {
      const text = typeof request?.args?.request === "string"
        ? request.args.request.replace(/\s+/g, " ").trim()
        : "";
      return (text ? `${tool} — ${text}` : tool).slice(0, 200);
    }
    const summary = typeof request?.summary === "string" ? request.summary : "";
    return (summary ? `${tool} — ${summary}` : tool).slice(0, 180);
  }

  function beginApproval(request, { notificationId = null, showBannerNow = true } = {}) {
    const timeoutMs = Math.min(120000, Math.max(5000, Number(request?.timeoutMs) || APPROVAL_TIMEOUT_MS));
    /* Absolute deadline, not another duration: the native side needs it to
     * cancel a notification whose approval has already expired (for example
     * because the WebView was suspended while the app was in the background). */
    const expiresAt = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(false, text("approvalTimeout")), timeoutMs);
      const pending = { request, resolve, timer, settle: null, notificationId, expiresAt };
      pendingApproval = pending;
      pending.settle = (approved, reason) => {
        if (pendingApproval !== pending) return;
        // A resumed renderer may receive Allow before its overdue timer runs.
        if (approved && Date.now() >= pending.expiresAt) {
          approved = false;
          reason = text("approvalTimeout");
        }
        pendingApproval = null;
        clearTimeout(timer);
        request?.signal?.removeEventListener("abort", aborted);
        hideBanner();
        if (pending.notificationId) {
          const bridge = getBridge?.();
          try { Promise.resolve(bridge?.cancelApproval?.(pending.notificationId)).catch(() => {}); } catch { /* ignore */ }
        }
        resolve({ approved, reason });
      };
      const settle = pending.settle;
      const aborted = () => settle(false, text("approvalDenied"));
      request?.signal?.addEventListener("abort", aborted, { once: true });
      if (request?.signal?.aborted) {
        aborted();
        return;
      }
      if (showBannerNow) showBanner(request || {});
    });
  }

  /* The WebView keeps reporting visibilityState "visible" when the Android
   * activity is paused (the foreground service keeps the process alive), so the
   * native foreground flag is the reliable signal for "can the user see the
   * app right now". Fall back to document.visibilityState on other platforms. */
  async function isAppHidden() {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return true;
    try {
      const bridge = getBridge?.();
      if (bridge && typeof bridge.getState === "function") {
        const native = await bridge.getState();
        if (native && native.foreground === false) return true;
      }
    } catch {
      /* keep the document signal */
    }
    return false;
  }

  async function requestApproval(request) {
    if (pendingApproval) {
      return { approved: false, reason: text("approvalBusy") };
    }
    /* Reserve synchronously, before native getState/showApproval can yield.
     * Otherwise concurrent scans or a scan plus a write overwrite the slot. */
    const decision = beginApproval(request, { showBannerNow: false });
    const pending = pendingApproval;
    if (!pending) return decision;
    /* Foreground: the in-app banner is faster and shows the arguments. While
     * the app is hidden (screen off, another app) the native notification is
     * the only place the user can answer, so ask the Android shell for it. */
    const hidden = await isAppHidden();
    if (pendingApproval !== pending) return decision;
    if (hidden) {
      if (!await postApprovalNotification(pending) && pendingApproval === pending) {
        pending.settle(false, text("approvalBackground"));
      }
    } else showBanner(request || {});
    return decision;
  }

  function handleApprovalAction(payload) {
    const pending = pendingApproval;
    if (!pending || !pending.notificationId) return;
    if (String(payload?.id ?? "") !== pending.notificationId) return;
    /* The native side cancels stale notifications at the absolute deadline and
     * reports the expiry; fail closed with the same copy as a local timeout. */
    if (payload?.expired === true) {
      pending.settle(false, text("approvalTimeout"));
      return;
    }
    pending.settle(Boolean(payload?.approved), payload?.approved ? "" : text("approvalDenied"));
  }

  async function subscribeApprovalActions() {
    const bridge = getBridge?.();
    if (!bridge || typeof bridge.addListener !== "function") return;
    try {
      approvalActionSubscription = await bridge.addListener("approvalAction", handleApprovalAction);
    } catch {
      approvalActionSubscription = null;
    }
  }

  /* If the user backgrounds the app while the in-app banner is waiting, move
   * the same request to a notification instead of letting it expire unseen. */
  async function postApprovalNotification(pending) {
    if (pendingApproval !== pending) return false;
    if (pending.notificationId) return true;
    const bridge = getBridge?.();
    if (!bridge || typeof bridge.showApproval !== "function") return false;
    const id = `mcp-${Date.now()}-${++approvalCounter}`;
    /* An Allow/Deny event may arrive before showApproval's promise resolves. */
    pending.notificationId = id;
    let shown = false;
    try {
      shown = (await bridge.showApproval({
        id,
        title: text("approvalTitle"),
        body: notificationBody(pending.request),
        deadlineMs: pending.expiresAt,
      })) === true;
    } catch {
      shown = false;
    }
    if (pendingApproval !== pending) {
      try { Promise.resolve(bridge.cancelApproval?.(id)).catch(() => {}); } catch { /* ignore */ }
      return false;
    }
    if (!shown) {
      pending.notificationId = null;
      return false;
    }
    hideBanner();
    return true;
  }

  async function notificationOnHide() {
    const pending = pendingApproval;
    if (!pending || pending.notificationId || !await isAppHidden()) return;
    if (pendingApproval !== pending) return;
    if (!await postApprovalNotification(pending) && pendingApproval === pending) {
      pending.settle(false, text("approvalBackground"));
    }
  }

  /* When the user is looking at the app again, the in-app card is the better
   * surface: cancel the notification that was only posted because the app was
   * hidden and show the same pending request again. The deadline is unchanged. */
  async function resurfacePendingApproval() {
    const pending = pendingApproval;
    if (!pending || !pending.notificationId || !banner.hidden) return;
    if (await isAppHidden()) return;
    if (pendingApproval !== pending) return;
    if (Date.now() >= pending.expiresAt) {
      pending.settle(false, text("approvalTimeout"));
      return;
    }
    const notificationId = pending.notificationId;
    const bridge = getBridge?.();
    pending.notificationId = null;
    try { Promise.resolve(bridge?.cancelApproval?.(notificationId)).catch(() => {}); } catch { /* ignore */ }
    if (pendingApproval !== pending) return;
    showBanner(pending.request || {});
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") void resurfacePendingApproval();
    else void notificationOnHide();
  }

  function onWindowFocus() {
    void resurfacePendingApproval();
  }

  function settlePending(approved, reason) {
    pendingApproval?.settle?.(approved, reason);
  }

  bannerParts.allow.addEventListener("click", () => settlePending(true));
  bannerParts.deny.addEventListener("click", () => settlePending(false, text("approvalDenied")));
  banner.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      settlePending(false, text("approvalDenied"));
    }
  });

  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  window.addEventListener("focus", onWindowFocus);
  void subscribeApprovalActions();

  applyLabels();
  render();
  // Keep the state line (foreground/background, active requests) honest while
  // the user has the settings panel open; a bridge event refreshes it too.
  refreshTimer = setInterval(() => {
    if (config.enabled && !document.hidden && !busy) refresh().catch(() => {});
  }, REFRESH_INTERVAL_MS);

  return {
    element: section,
    refresh,
    refreshLang() { applyLabels(); render(); },
    requestApproval,
    dispose() {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("focus", onWindowFocus);
      if (approvalActionSubscription?.remove) {
        Promise.resolve(approvalActionSubscription.remove()).catch(() => {});
      }
      approvalActionSubscription = null;
      settlePending(false, text("approvalDenied"));
    },
  };
}
