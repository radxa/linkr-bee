import { TARGET_DIRECTORY_SETUP } from './target_binding.js';
import { available } from "./agent_runtime.js";
import {
  AGENT_FIXED_CONTEXT_TOKENS,
  AGENT_PROVIDERS,
  AGENT_VENDOR_CUSTOM,
  AGENT_VENDORS,
  vendorForEndpoint,
  AGENT_REASONING_LEVELS,
  clearAgentConfig,
  endpointSecurity,
  fetchAgentModels,
  formatAgentHeaders,
  isValidEndpoint,
  isContextWindowTight,
  loadAgentConfig,
  minimumUsefulContextWindow,
  parseAgentHeaders,
  saveAgentConfig,
  validateAgentConfig,
} from "./agent_config.js";
import { loadPricing, savePricing } from "./agent_usage.js";

const labels = {
  bindingUuid:["Bee 保存的目标机 UUID", "Bound target UUID"], observedUuid:["本次读取的目标机 UUID", "Observed target UUID"],
  bindingTitle:["目标机绑定", "Target identity binding"],
  bindingHint:["优先使用已有的系统 ID，其次是用户 ID。首次绑定优先写入 /var/lib/linkr/device-id，需要权限时尝试 sudo；请在串口输入密码。sudo 不可用或失败时改用 ~/.local/share/linkr/device-id（随登录用户变化）。输入密码后请再次点击绑定，核实后才保存到 Bee Flash。", "Existing system IDs take priority, then existing user IDs. New IDs prefer /var/lib/linkr/device-id using sudo when needed; enter the password in the terminal. If sudo is unavailable or fails, use ~/.local/share/linkr/device-id (per user). After entering a password, click Bind again to verify before saving to Bee Flash."],
  bindingPath:["目标机保存路径", "Target save path"],
  bindingSudo:["请在串口终端输入目标机 sudo 密码（不会显示字符）。完成并返回 Shell 提示符后，再点击“绑定当前目标机”核实并保存。若不使用 sudo，可在密码提示处按 Ctrl+D，等待命令回退到用户目录。", "Enter the target sudo password directly in the terminal (characters stay hidden). Once the shell prompt returns, click Bind current target again to verify and save. To decline sudo, press Ctrl+D at its password prompt and wait for the user-directory fallback."],
  bindingVerify:["核实绑定", "Verify binding"], bindingBind:["绑定当前目标机", "Bind current target"],
  bindingClear:["解除 Bee 绑定", "Unbind Bee"], bindingRegenerate:["重新生成并绑定", "Regenerate and bind"],
  bindingRegenerateHint:["允许替换目标机现有 ID；旧档案保留，但不再自动关联。", "Allow replacing the target ID. Previous records remain but will no longer match automatically."],
  bindingWorking:["正在核实目标机与 Bee；若串口提示 sudo 密码，请在终端输入，其他时候请勿输入命令或切换连接…", "Checking target and Bee. Enter sudo credentials in the terminal if prompted; otherwise do not send commands or switch connections…"],
  bindingVerified:["目标机 ID 已核实，与 Bee Flash 绑定一致。", "Target UUID verified against Bee Flash binding."],
  bindingCleared:["已清除 Bee 绑定；目标机 ID 文件和历史档案保留。", "Bee binding cleared; target ID file and historical records retained."],
  bindingMismatch:["当前目标机与 Bee 保存的绑定不一致。核对目标机后可点击“绑定当前目标机”。", "Target does not match the stored Bee binding. Check the target before binding it."],
  bindingPermission:["目标机当前用户无权写入 /var/lib/linkr。首次绑定可先在串口执行下面的命令，按提示输入目标机 sudo 密码，再点击“绑定当前目标机”：", "The target user cannot write /var/lib/linkr. For initial setup, run the following in the terminal, enter the target sudo password if prompted, then click Bind current target:"],
  bindingError:["操作未完成：", "Operation incomplete: "],
  bindingUnknown:["本次连接尚未核实绑定", "Binding not verified in this connection"],
  title: ["AI 配置", "AI configuration"],
  endpoint: ["API 地址", "API base URL"],
  endpointHint: ["兼容 Chat Completions，例如 https://api.example.com/v1", "Chat Completions compatible, e.g. https://api.example.com/v1"],
  model: ["模型名称", "Model ID"], key: ["API Key", "API key"],
  /* The preset model ids go stale, so the form can ask the service what it
   * offers right now once the address and key are in. */
  modelHint: ["可手动填写；填好地址和 API Key 后，可点击下方“获取模型列表”从服务端读取当前可用的模型。", "Type it, or fill in the address and API key and use Fetch model list below to read the models the service currently offers."],
  fetchModels: ["获取模型列表", "Fetch model list"],
  fetchBusy: ["正在获取模型列表…", "Fetching the model list…"],
  fetchDone: ["已获取 {count} 个模型，从模型名称输入框的下拉中选择，也可继续手动输入。", "Found {count} models. Open the model field and pick one, or keep typing."],
  fetchEndpoint: ["请先填写有效的 API 地址。", "Enter a valid API base URL first."],
  fetchUnauthorized: ["无法获取模型列表：API Key 无效或没有读取模型的权限。", "Could not read the model list: the API key is invalid or cannot list models."],
  fetchNetwork: ["无法获取模型列表：请求被浏览器跨域或网络拦截，或不支持该接口。可继续手动填写模型名。", "Could not read the model list: the request was blocked (CORS or network) or the endpoint does not support it. Type the model ID instead."],
  fetchHttp: ["模型列表接口返回 HTTP {status}。可继续手动填写模型名。", "The model list endpoint returned HTTP {status}. Type the model ID instead."],
  fetchEmpty: ["该服务没有返回可用的模型，请手动填写模型名。", "The service returned no usable models; type the model ID instead."],
  keyHint: ["无需密钥的本地服务可留空。", "Leave blank for a local service that does not require a key."],
  headers: ["附加请求头", "Extra request headers"],
  headersHint: ["每行一个 `名称: 值`。部分端点需要特定请求头才接受浏览器请求，例如 Anthropic 需要 anthropic-dangerous-direct-browser-access: true。", "One `Name: value` per line. Some endpoints only accept a browser request with a specific header, for example Anthropic needs anthropic-dangerous-direct-browser-access: true."],
  vendor: ["AI 接入商", "AI provider"],
  /* A preset only fills the fields; it never locks them, and the model id is the
   * part most likely to go stale, so the hint says so instead of pretending. */
  vendorHint: ["选择后自动填入 API 地址、接口协议和模型名，三个字段都可以再改；模型名以你的账号可用的为准。", "Choosing a provider fills the API base URL, protocol and model. All three stay editable; use a model your account can actually call."],
  keyStorage: ["API Key 只保存在这台设备（本浏览器 / 应用的本地存储，键名 linkr-agent-model，明文）。不会上传到 Linkr Bee、本网站或任何服务器，应用也没有云端账号。提问时由本机直接发往你选择的接入商；清除配置或站点数据即可删除。", "The API key stays on this device (this browser/app's local storage, key linkr-agent-model, plaintext). It is not uploaded to Linkr Bee, this site or any server, and the app has no cloud account. A question carries it from this device straight to the provider you chose; clear the configuration or site data to remove it."],
  provider: ["接口协议", "API protocol"],
  providerHint: ["必须与 API 地址匹配，协议不同请求格式也不同。", "Must match the API base URL; each protocol uses a different request format."],
  reasoning: ["推理强度", "Reasoning effort"],
  reasoningHint: ["仅部分模型支持；关闭可减少等待和 token 消耗。", "Only some models support this; off avoids the extra latency and tokens."],
  reasoningOff: ["关闭", "Off"], reasoningLow: ["低", "Low"], reasoningMedium: ["中", "Medium"], reasoningHigh: ["高", "High"],
  contextWindow: ["上下文窗口（token，可留空）", "Context window in tokens (optional)"],
  maxTokens: ["最大输出（token，可留空）", "Max output tokens (optional)"],
  limitsHint: ["留空或填 0 表示使用内置默认值。", "Leave blank or 0 to keep the built-in default."],
  /* The window is not only the conversation: the system prompt and every tool
   * description are paid first, on every request. Saying so here is the
   * difference between "the model refused" and "this field is too small". */
  contextWindowHint: ["留空或填 0 表示使用内置默认值。系统提示词、工具说明和参数结构每次请求都占用窗口，还需为回复留出空间，其余才是对话历史。", "Leave blank or 0 to keep the built-in default. The system prompt, tool descriptions and parameter schemas consume part of each request's window. Room is also reserved for the reply; the rest is conversation history."],
  contextWindowTight: ["窗口可能不足：提示词和工具（含参数结构）按约 {fixed} token 预留，加上最大输出建议至少 {min}。请增大窗口或降低最大输出；实际用量随模型和启用的工具变化。", "The window may be too small: about {fixed} tokens are reserved for the prompt and tools, including schemas. With max output, at least {min} is recommended. Increase the window or reduce max output; actual usage varies by model and enabled tools."],
  providerError: ["请选择接口协议。", "Choose an API protocol."],
  reasoningError: ["请选择推理强度。", "Choose a reasoning effort."],
  contextWindowError: ["上下文窗口必须是 0，或 1000 到 2000000 之间的整数。", "Context window must be 0, or an integer between 1000 and 2000000."],
  maxTokensError: ["最大输出必须是 0，或 1 到 100000 之间的整数。", "Max output tokens must be 0, or an integer between 1 and 100000."],
  pricing: ["Token 单价（每 100 万，可选）", "Token prices per 1M (optional)"],
  pricingHint: ["填了就按它估算本轮费用，只用于显示，留空则只显示 token 数。", "When set, the conversation shows an estimated cost; leave blank to show token counts only."],
  pricingError: ["单价必须是 0 到 100000 之间的数字。", "Prices must be numbers between 0 and 100000."],
  headersError: ["请求头格式无效：每行一个 `名称: 值`，名称只能包含字母、数字和连字符。", "Invalid headers: use one `Name: value` per line, with names limited to letters, digits and hyphens."],
  save: ["保存配置", "Save configuration"], clear: ["清除配置", "Clear configuration"],
  storage: ["其余配置同样保存在本机，刷新或重启后保留；清除配置或清除站点数据后删除。", "The rest of the configuration is stored on this device too, across reloads and restarts; clear the configuration or the site data to remove it."],
  notice: ["提问后，助手会把所需串口日志发送到你配置的模型服务。", "When you ask a question, the assistant sends the requested serial logs to your configured model service."],
  saved: ["配置已保存到当前设备。", "Configuration saved on this device."],
  cleared: ["已清除当前设备上的 AI 配置。", "AI configuration cleared from this device."],
  dirty: ["修改尚未保存。", "Changes have not been saved."],
  plaintextKeyWarning: ["警告：该地址使用明文 http 且非本机回环，API Key 与串口日志会在网络中明文传输；请改用 https，或把服务放在 localhost。", "Warning: this endpoint uses plain http and is not loopback, so the API key and serial logs travel the network in cleartext. Use https, or host the service on localhost."],
  plaintextKeyConfirm: ["该地址使用明文 http 且非本机回环，API Key 会以明文发送。仍要保存吗？", "This endpoint uses plain http and is not loopback, so the API key will be sent in cleartext. Save anyway?"],
  plaintextKeyBlocked: ["已取消保存：明文 http 端点需要确认后才会保存 API Key。", "Save cancelled: a plaintext http endpoint needs confirmation before an API key is stored."],
  readError: ["无法读取本地配置，请重新填写并保存。", "Could not read local configuration. Enter it again and save."],
  saveError: ["保存失败，请检查应用 / 浏览器是否允许本地存储后重试。", "Save failed. Check that app / browser storage is allowed, then retry."],
  clearError: ["清除失败，本地配置仍保留，请重试。", "Clear failed. The saved configuration is still present; retry."],
  endpointError: ["请输入有效的 HTTP(S) API 地址，不要包含账号密码、查询参数或片段。", "Enter an HTTP(S) API base URL without credentials, query parameters or a fragment."],
  modelError: ["请填写模型名称。", "Enter a model ID."],
  busy: ["Agent 正在运行，请先返回对话并停止，再修改配置。", "Agent is running. Return to the conversation and stop it before editing configuration."],
};

export function createAgentSettings({ section, tab, getLang, onChange, bindingAction }) {
  if (!available) return null;
  section.hidden = tab.hidden = false;
  section.closest(".controls").classList.add("has-agent-settings");
  const $ = (id) => section.querySelector(`#${id}`);
  const inputs = {
    vendor: $("agentVendor"),
    endpoint: $("agentEndpoint"), model: $("agentModel"), apiKey: $("agentApiKey"),
    provider: $("agentProvider"), reasoning: $("agentReasoning"),
    contextWindow: $("agentContextWindow"), maxTokens: $("agentMaxTokens"),
  };
  const headersInput = $("agentHeaders");
  const priceInputs = { input: $("agentPriceInput"), output: $("agentPriceOutput") };
  // Every validated field reports through its own message; a wrong apiKey type
  // can only come from a stored record, never from this form, so it keeps the
  // endpoint message like before.
  const statusLabels = { model: "modelError", provider: "providerError", reasoning: "reasoningError", contextWindow: "contextWindowError", maxTokens: "maxTokensError" };
  const reasoningLabels = { off: "reasoningOff", low: "reasoningLow", medium: "reasoningMedium", high: "reasoningHigh" };
  const text = (key) => labels[key]?.[getLang().startsWith("zh") ? 0 : 1] || key;
  let config = null;
  let status = "";
  let error = false;
  let busy = false;
  function renderStatus() {
    // The plaintext warning describes the saved configuration, so it stays
    // visible next to whatever status the last action produced. The context
    // window does too: it is a property of the saved record, and a window below
    // what the assistant costs by itself fails on every question, so it must not
    // be reported only while the form happens to be dirty.
    const exposed = endpointSecurity(config?.endpoint).exposesKey;
    const tight = isContextWindowTight(config?.contextWindow, config?.maxTokens)
      ? text("contextWindowTight")
        .replace("{fixed}", String(AGENT_FIXED_CONTEXT_TOKENS))
        .replace("{min}", String(minimumUsefulContextWindow(config?.maxTokens)))
      : "";
    const el = $("agentSettingsStatus");
    el.textContent = [
      busy ? text("busy") : status ? text(status) : "",
      tight,
      exposed ? text("plaintextKeyWarning") : "",
    ].filter(Boolean).join(" ");
    el.classList.toggle("field-error", (!busy && error) || exposed || Boolean(tight));
  }
  function showStatus(next, failed = false) { status = next; error = failed; renderStatus(); }
  // Model discovery has its own line: it reports the list, not the record, and
  // it must not overwrite the save/clear status the user is waiting on.
  function showModelStatus(key, replacements = {}, failed = false) {
    const el = $("agentModelStatus");
    let message = key ? text(key) : "";
    for (const [name, value] of Object.entries(replacements)) message = message.replace(`{${name}}`, String(value));
    el.textContent = message;
    el.classList.toggle("field-error", failed);
  }
  let fetchingModels = false;
  async function fetchModels() {
    if (busy || fetchingModels) return;
    if (!isValidEndpoint(inputs.endpoint.value)) {
      inputs.endpoint.setAttribute("aria-invalid", "true");
      showModelStatus("fetchEndpoint", {}, true);
      inputs.endpoint.focus();
      return;
    }
    let requestHeaders;
    try { requestHeaders = parseAgentHeaders(headersInput.value); }
    catch {
      headersInput.setAttribute("aria-invalid", "true");
      showModelStatus("headersError", {}, true);
      headersInput.focus();
      return;
    }
    fetchingModels = true;
    const button = $("agentModelFetch");
    button.disabled = true;
    showModelStatus("fetchBusy");
    try {
      const models = await fetchAgentModels({
        endpoint: inputs.endpoint.value.trim(),
        apiKey: inputs.apiKey.value,
        headers: requestHeaders,
        provider: inputs.provider.value || AGENT_PROVIDERS[0].id,
      });
      const list = $("agentModelOptions");
      list.textContent = "";
      for (const model of models) {
        const option = document.createElement("option");
        option.value = model;
        list.append(option);
      }
      showModelStatus("fetchDone", { count: models.length });
      // Choosing is the point: put the caret where the list opens.
      if (!inputs.model.value.trim()) inputs.model.focus();
    } catch (error) {
      if (error?.code === "models-unauthorized") showModelStatus("fetchUnauthorized", {}, true);
      else if (error?.code === "models-http") showModelStatus("fetchHttp", { status: error.status ?? "?" }, true);
      else if (error?.code === "models-empty") showModelStatus("fetchEmpty", {}, true);
      else showModelStatus("fetchNetwork", {}, true);
    } finally {
      fetchingModels = false;
      button.disabled = false;
    }
  }
  /* The provider and reasoning selects are driven by the shared option lists, so
   * the form and the validator cannot drift apart. Their text is translated, so
   * the lists are rebuilt on every language change; the ids never change, so a
   * choice made by the user survives the rebuild. */
  function fillOptions() {
    const index = getLang().startsWith("zh") ? 0 : 1;
    const options = {
      agentVendor: AGENT_VENDORS.map(({ id, label, hint }) => ({ value: id, label, hint })),
      agentProvider: AGENT_PROVIDERS.map(({ id, label, hint }) => ({ value: id, label, hint })),
      agentReasoning: AGENT_REASONING_LEVELS.map((id) => ({ value: id, label: labels[reasoningLabels[id]] || [id, id] })),
    };
    for (const [id, entries] of Object.entries(options)) {
      const select = $(id);
      const chosen = select.value;
      select.textContent = "";
      for (const { value, label, hint } of entries) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label[index];
        // Only a tooltip has room for the endpoints a provider targets.
        if (hint) option.title = hint[index];
        select.append(option);
      }
      select.value = chosen || entries[0].value;
    }
  }
  function fill() {
    for (const [name, input] of Object.entries(inputs)) {
      // The vendor is not part of the stored record; it is read back from the
      // endpoint so an existing configuration shows its provider without a
      // schema change.
      if (name === "vendor") continue;
      input.value = config?.[name] || "";
    }
    inputs.vendor.value = config ? vendorForEndpoint(config.endpoint) : AGENT_VENDOR_CUSTOM;
    // A select whose value matches no option shows nothing and would submit an
    // empty string, so a missing record falls back to the schema default.
    if (!inputs.provider.value) inputs.provider.value = AGENT_PROVIDERS[0].id;
    if (!inputs.reasoning.value) inputs.reasoning.value = AGENT_REASONING_LEVELS[0];
    headersInput.value = formatAgentHeaders(config?.headers);
    const pricing = loadPricing(localStorage);
    for (const [name, input] of Object.entries(priceInputs)) input.value = pricing[name] ? String(pricing[name]) : "";
  }
  function resetErrors() {
    for (const input of Object.values(inputs)) input.removeAttribute("aria-invalid");
    headersInput.removeAttribute("aria-invalid");
    for (const input of Object.values(priceInputs)) input.removeAttribute("aria-invalid");
  }
  try { config = loadAgentConfig(localStorage); } catch { showStatus("readError", true); }
  fillOptions();
  fill();
  $("agentSettingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    resetErrors();
    const draft = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
    delete draft.vendor;
    // A cleared number input reports an empty string and an empty select reports
    // no choice at all. Both mean "keep the schema default", not invalid input.
    for (const name of ["contextWindow", "maxTokens"]) draft[name] = draft[name].trim() ? Number(draft[name]) : 0;
    draft.provider ||= AGENT_PROVIDERS[0].id;
    draft.reasoning ||= AGENT_REASONING_LEVELS[0];
    try { draft.headers = parseAgentHeaders(headersInput.value); } catch {
      headersInput.setAttribute("aria-invalid", "true");
      showStatus("headersError", true);
      headersInput.focus();
      return;
    }
    try { validateAgentConfig(draft); } catch (error) {
      if (error.message === "headers") {
        headersInput.setAttribute("aria-invalid", "true");
        showStatus("headersError", true);
        headersInput.focus();
        return;
      }
      const name = statusLabels[error.message] ? error.message : "endpoint";
      inputs[name].setAttribute("aria-invalid", "true");
      showStatus(statusLabels[error.message] || "endpointError", true);
      inputs[name].focus();
      return;
    }
    const previous = config;
    // A credential must not reach a cleartext remote endpoint by accident.
    const security = endpointSecurity(draft.endpoint);
    if (security.exposesKey && draft.apiKey && !window.confirm(text("plaintextKeyConfirm"))) {
      inputs.endpoint.setAttribute("aria-invalid", "true");
      showStatus("plaintextKeyBlocked", true);
      inputs.endpoint.focus();
      return;
    }
    try { config = saveAgentConfig(localStorage, draft); } catch {
      showStatus("saveError", true);
      return;
    }
    /* Prices are display-only, so they are stored apart from the model
     * configuration: editing them must not restart the conversation. */
    try { savePricing(localStorage, { input: priceInputs.input.value, output: priceInputs.output.value }); }
    catch {
      priceInputs.input.setAttribute("aria-invalid", "true");
      showStatus("pricingError", true);
      priceInputs.input.focus();
      return;
    }
    fill();
    showStatus("saved");
    // Re-saving the same normalized settings must not silently reset the visible
    // diagnostic conversation. A changed provider, model or key starts fresh.
    if (!previous || Object.keys(inputs).some((name) => previous[name] !== config[name])) onChange?.();
  });
  $("agentSettingsClear").addEventListener("click", () => {
    if (busy) return;
    try { clearAgentConfig(localStorage); } catch { showStatus("clearError", true); return; }
    config = null;
    fill();
    resetErrors();
    showStatus("cleared");
    onChange?.();
  });
  /* A preset writes the three fields the protocol owns and stops there: the key,
   * the headers (unless the vendor needs one), the reasoning level and the token
   * limits belong to the account, not to the vendor. The fields stay editable
   * afterwards, and Custom changes nothing so an endpoint can be typed by hand. */
  inputs.vendor.addEventListener("change", () => {
    const preset = AGENT_VENDORS.find((entry) => entry.id === inputs.vendor.value);
    if (!preset || preset.id === AGENT_VENDOR_CUSTOM) {
      showStatus("dirty");
      return;
    }
    inputs.endpoint.value = preset.endpoint;
    inputs.model.value = preset.model;
    if (preset.protocol) inputs.provider.value = preset.protocol;
    /* Replace the headers a previous preset wrote, but never a user's own: the
     * Anthropic preset sets one, and switching away would otherwise leave a
     * header that belongs to a service the new endpoint is not. */
    let currentHeaders = null;
    try { currentHeaders = parseAgentHeaders(headersInput.value); } catch { currentHeaders = null; }
    const ownHeaderNames = new Set(AGENT_VENDORS.flatMap((entry) => Object.keys(entry.headers || {})));
    const onlyPresetHeaders = currentHeaders && Object.keys(currentHeaders).length > 0 &&
      Object.keys(currentHeaders).every((name) => ownHeaderNames.has(name));
    if (preset.headers) headersInput.value = formatAgentHeaders(preset.headers);
    else if (onlyPresetHeaders) headersInput.value = "";
    resetErrors();
    showStatus("dirty");
  });
  $("agentModelFetch").addEventListener("click", fetchModels);
  for (const [name, input] of Object.entries(inputs)) input.addEventListener("input", () => {
    resetErrors();
    // A list fetched for a previous address or key is no longer evidence.
    if (["vendor", "endpoint", "apiKey", "provider"].includes(name)) showModelStatus("");
    showStatus("dirty");
  });
  for (const [id, action] of [["targetVerify","verify"],["targetBind","bind"],["targetUnbind","clear"],["targetRegenerate","regenerate"]]) {
    $(id).addEventListener("click", async () => {
      if (busy || (action === "regenerate" && !$("targetRegenerateConfirm").checked)) return;
      $("targetBindingStatus").textContent = text("bindingWorking");
      $("targetBindingIdentity").textContent = "";
      try {
        const result = await bindingAction(action);
        $("targetBindingIdentity").textContent = [result.targetId && `${text("bindingUuid")}: ${result.targetId}`, result.observedId && `${text("observedUuid")}: ${result.observedId}`, result.targetPath && `${text("bindingPath")}: ${result.targetPath}`].filter(Boolean).join("\n");
        $("targetBindingStatus").textContent = text(result.status === "cleared" ? "bindingCleared" : result.status === "mismatch" ? "bindingMismatch" : "bindingVerified");
      } catch(error) { $("targetBindingStatus").textContent = error.code === "TARGET_SUDO_INPUT" ? text("bindingSudo") : error.code === "TARGET_PERMISSION_DENIED" ? text("bindingPermission") + "\n" + TARGET_DIRECTORY_SETUP : text("bindingError") + error.message; }
      // The regenerate confirmation is single-use and is dropped after every
      // target action, not just regenerate: an armed "replace the target ID"
      // state must never survive into a later, unrelated click.
      finally { $("targetRegenerateConfirm").checked = false; $("targetRegenerate").disabled = true; }
    });
  }
  $("targetRegenerateConfirm").addEventListener("change", () => { $("targetRegenerate").disabled = !$("targetRegenerateConfirm").checked; });
  function refreshLang() {
    for (const el of section.querySelectorAll("[data-ai-setting]")) el.textContent = text(el.dataset.aiSetting);
    fillOptions();
    // The status was written in the previous language; the fetched options stay.
    showModelStatus("");
    renderStatus();
  }
  refreshLang();
  return {
    refreshLang,
    connectionChanged() { $("targetBindingIdentity").textContent = ""; $("targetBindingStatus").textContent = text("bindingUnknown"); },
    getConfig: () => config && { ...config },
    setBusy(value) { busy = value; $("agentSettingsFields").disabled = value; $("targetBindingFields").disabled = value; renderStatus(); },
  };
}
