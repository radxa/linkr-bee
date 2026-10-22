export const AGENT_CONFIG_KEY = "linkr-agent-model";

/* Plain http sends the API key and the serial logs in cleartext. A local model
 * server reached over loopback never leaves the machine, so it stays a normal
 * configuration; anything else is reported so the UI can ask for consent before
 * a credential is stored and transmitted. */
export function endpointSecurity(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint ?? ""));
  } catch {
    return { plaintext: false, loopback: false, exposesKey: false };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host);
  const plaintext = url.protocol === "http:";
  return { plaintext, loopback, exposesKey: plaintext && !loopback };
}

/* Extra request headers, written one "Name: value" per line. Several endpoints
 * only answer a browser request when a specific header is present (Anthropic
 * requires anthropic-dangerous-direct-browser-access, header-authenticated
 * gateways need their own credential), and pi-ai merges these into the request.
 * Names and values are restricted so a stored record cannot inject a new line
 * into the HTTP request. */
export const AGENT_HEADER_LIMIT = 8;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export function parseAgentHeaders(text) {
  const headers = {};
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > AGENT_HEADER_LIMIT) throw new Error("headers");
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("headers");
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!HEADER_NAME.test(name) || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error("headers");
    }
    headers[name] = value;
  }
  return headers;
}

export function formatAgentHeaders(headers) {
  return Object.entries(headers || {}).map(([name, value]) => `${name}: ${value}`).join("\n");
}

/* One endpoint host can speak several incompatible HTTP APIs, so the provider
 * selects the request and response shape pi-ai drives against it. The default
 * stays first because a record without the field keeps the historical protocol. */
export const AGENT_PROVIDERS = [
  // OpenAI-compatible /chat/completions: OpenAI, DeepSeek, Ollama, vLLM and most gateways.
  { id: "openai-completions", label: ["OpenAI 兼容接口", "OpenAI-compatible API"],
    hint: ["适用于提供 /chat/completions 的服务，例如 OpenAI、DeepSeek、Ollama、vLLM", "For services exposing /chat/completions, such as OpenAI, DeepSeek, Ollama or vLLM"] },
  // Anthropic Messages API at /v1/messages, e.g. https://api.anthropic.com/v1.
  { id: "anthropic-messages", label: ["Anthropic Messages 接口", "Anthropic Messages API"],
    hint: ["适用于提供 /v1/messages 的服务，例如 https://api.anthropic.com/v1", "For services exposing /v1/messages, such as https://api.anthropic.com/v1"] },
  // Google Generative AI generateContent, e.g. https://generativelanguage.googleapis.com/v1beta.
  { id: "google-generative-ai", label: ["Google Gemini 接口", "Google Generative AI"],
    hint: ["适用于提供 generateContent 的服务，例如 https://generativelanguage.googleapis.com/v1beta", "For services exposing generateContent, such as https://generativelanguage.googleapis.com/v1beta"] },
];

/* Vendors sit on top of the protocol list above: choosing one fills the base
 * URL, the protocol and a starting model, and every field stays editable. Model
 * ids move, so the suggestion is a starting point, not a contract — the record
 * stores whatever the user saves. Custom is first because it is the only entry
 * that promises nothing about the endpoint.
 *
 * No new stored field: the vendor is inferred from the endpoint (below), so a
 * record written before this list existed still shows the right vendor when its
 * endpoint matches one, and Custom otherwise. */
export const AGENT_VENDOR_CUSTOM = "custom";

/* Model ids checked 2026-10-19 against the vendors' own docs where they are
 * reachable — DeepSeek's Models & Pricing page, Gemini's model list, Zhipu's
 * model overview, Moonshot's and xAI's current catalogs — and against the
 * OpenRouter / LiteLLM model tables for the rest. They are still suggestions;
 * `Fetch model list` is the authority. SiliconFlow's docs return 404 and its
 * /v1/models requires a key, so its id is the least verified entry here. */
export const AGENT_VENDORS = [
  { id: AGENT_VENDOR_CUSTOM, label: ["自定义", "Custom"],
    hint: ["手动填写 API 地址、接口协议和模型名称。", "Enter the API base URL, protocol and model yourself."] },
  { id: "openai", label: ["OpenAI", "OpenAI"], endpoint: "https://api.openai.com/v1",
    protocol: "openai-completions", model: "gpt-6.1-sol" },
  { id: "anthropic", label: ["Anthropic Claude", "Anthropic Claude"], endpoint: "https://api.anthropic.com/v1",
    protocol: "anthropic-messages", model: "claude-sonnet-5-5",
    /* The browser calls the Messages API directly; without this header Anthropic
     * answers 401/403 to a cross-origin browser request. */
    headers: { "anthropic-dangerous-direct-browser-access": "true" } },
  { id: "google", label: ["Google Gemini", "Google Gemini"], endpoint: "https://generativelanguage.googleapis.com/v1beta",
    protocol: "google-generative-ai", model: "gemini-4-argon" },
  { id: "deepseek", label: ["DeepSeek 深度求索", "DeepSeek"], endpoint: "https://api.deepseek.com",
    protocol: "openai-completions", model: "deepseek-flash" },
  { id: "moonshot", label: ["Moonshot Kimi", "Moonshot Kimi"], endpoint: "https://api.moonshot.cn/v1",
    protocol: "openai-completions", model: "kimi-k3" },
  { id: "zhipu", label: ["智谱 GLM", "Zhipu GLM"], endpoint: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-completions", model: "glm-5.3" },
  { id: "dashscope", label: ["阿里云百炼（通义千问）", "Alibaba Cloud Bailian (Qwen)"],
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-completions", model: "qwen3.8-max" },
  { id: "siliconflow", label: ["硅基流动", "SiliconFlow"], endpoint: "https://api.siliconflow.cn/v1",
    protocol: "openai-completions", model: "deepseek-ai/DeepSeek-V4.1-Flash" },
  { id: "volces", label: ["火山方舟（豆包）", "Volcengine Ark (Doubao)"],
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai-completions", model: "doubao-seed-2-1-pro-260628" },
  { id: "groq", label: ["Groq", "Groq"], endpoint: "https://api.groq.com/openai/v1",
    protocol: "openai-completions", model: "qwen/qwen3.8-27b" },
  { id: "openrouter", label: ["OpenRouter", "OpenRouter"], endpoint: "https://openrouter.ai/api/v1",
    protocol: "openai-completions", model: "openai/gpt-6.1-sol" },
  { id: "mistral", label: ["Mistral", "Mistral"], endpoint: "https://api.mistral.ai/v1",
    protocol: "openai-completions", model: "mistral-large-latest" },
  { id: "xai", label: ["xAI Grok", "xAI Grok"], endpoint: "https://api.x.ai/v1",
    protocol: "openai-completions", model: "grok-4.7" },
  { id: "ollama", label: ["Ollama（本机）", "Ollama (local)"], endpoint: "http://localhost:11434/v1",
    protocol: "openai-completions", model: "qwen3.5" },
];

export function vendorById(id) {
  return AGENT_VENDORS.find((entry) => entry.id === id) ?? null;
}

/* Which vendor an endpoint belongs to, for a form that must show the selection
 * it saved. Normalised exactly the way validateAgentConfig stores it, so the
 * round-trip cannot disagree with itself. */
export function vendorForEndpoint(endpoint) {
  let url;
  try { url = new URL(String(endpoint ?? "")); } catch { return AGENT_VENDOR_CUSTOM; }
  const normalized = url.href.replace(/\/$/, "");
  const match = AGENT_VENDORS.find((entry) => entry.endpoint?.replace(/\/$/, "") === normalized);
  return match?.id ?? AGENT_VENDOR_CUSTOM;
}

/* Model discovery. Every protocol this app speaks has a list endpoint, but the
 * credential sits in a different header and the payload has a different shape,
 * and the hard-coded ids in the presets go stale. Building the request and
 * parsing the payload here — not in the settings panel — is what makes all
 * three cases testable without a browser or a provider.
 *
 * The list is a convenience: a service can also omit the endpoint or refuse a
 * browser request (CORS), so the UI must always keep the field editable. */
export function modelsUrl({ endpoint }) {
  return `${String(endpoint ?? "").trim().replace(/\/+$/, "")}/models`;
}

export function modelsRequest({ endpoint, apiKey = "", headers = {}, provider = AGENT_PROVIDERS[0].id }) {
  const requestHeaders = { ...(headers || {}) };
  if (provider === "anthropic-messages") {
    // Anthropic reads x-api-key, not a bearer token, and versions the endpoint.
    requestHeaders["x-api-key"] = apiKey;
    requestHeaders["anthropic-version"] ||= "2023-06-01";
  } else if (provider === "google-generative-ai") {
    // Header rather than ?key=: a URL lands in proxy logs, a header does not.
    requestHeaders["x-goog-api-key"] = apiKey;
  } else if (apiKey) {
    requestHeaders["Authorization"] = `Bearer ${apiKey}`;
  }
  return { url: modelsUrl({ endpoint }), headers: requestHeaders };
}

/* OpenAI-compatible services answer {data:[{id}]}; a few gateways also return
 * {models:[...]}. Gemini answers {models:[{name:"models/x", supportedGenerationMethods}]}
 * and lists embeddings and other non-chat models beside the chat ones, so only
 * entries that can answer generateContent are offered. */
export function parseModels(payload, provider = AGENT_PROVIDERS[0].id) {
  const ids = [];
  if (provider === "google-generative-ai") {
    for (const model of payload?.models ?? []) {
      const name = model?.name;
      if (!name) continue;
      const methods = model?.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
      ids.push(String(name).replace(/^models\//, ""));
    }
  } else {
    for (const model of payload?.data ?? payload?.models ?? []) {
      const id = typeof model === "string" ? model : model?.id ?? model?.name;
      if (id) ids.push(String(id));
    }
  }
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/* The failure kinds the panel words differently: a bad key is the user's to fix,
 * a blocked request means "type the model yourself", an empty list means the
 * service has nothing to offer. */
export async function fetchAgentModels(config, fetchImpl = globalThis.fetch) {
  const { url, headers } = modelsRequest(config);
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", headers });
  } catch {
    throw Object.assign(new Error("models-network"), { code: "models-network" });
  }
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("models-unauthorized"), { code: "models-unauthorized" });
  }
  if (!response.ok) {
    throw Object.assign(new Error("models-http"), { code: "models-http", status: response.status });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error("models-format"), { code: "models-empty" });
  }
  const models = parseModels(payload, config.provider);
  if (!models.length) throw Object.assign(new Error("models-empty"), { code: "models-empty" });
  return models;
}

export function isValidEndpoint(endpoint) {
  let url;
  try { url = new URL(String(endpoint ?? "").trim()); } catch { return false; }
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
    !url.search && !url.hash;
}

// Ascending thinking budget. "off" leaves reasoning options out of the request.
export const AGENT_REASONING_LEVELS = ["off", "low", "medium", "high"];

/* Shared with the runtime so the settings form and the request it produces
 * cannot disagree about what "left blank" means. */
export const AGENT_DEFAULT_CONTEXT_WINDOW = 32768;
export const AGENT_DEFAULT_MAX_TOKENS = 4096;

/* What the assistant costs before any conversation is sent.
 *
 * Includes the system prompt, tool descriptions and JSON parameter schemas,
 * including optional accessory/note tools. Converted at a pessimistic 3 chars
 * per token; serial_agent.test.mjs re-measures this estimate as tools change.
 *
 * This matters because the setting accepts a window as small as 1000 tokens: a
 * window below the fixed part cannot hold a request at all, and the failure
 * arrives as an opaque provider error. Naming the floor is the difference
 * between "the model refused" and "this field is too small".
 */
export const AGENT_FIXED_CONTEXT_TOKENS = 12000;

/* Reserve framing (256 tokens) and at least 2000 history chars at 2 chars/token,
 * rounded up. Keep the settings warning consistent with contextBudgetChars's
 * minimum retained history; lowering maxTokens still lowers this floor. */
export function minimumUsefulContextWindow(maxTokens = 0) {
  const output = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : AGENT_DEFAULT_MAX_TOKENS;
  return AGENT_FIXED_CONTEXT_TOKENS + output + 1280;
}

/* 0 means "use the built-in default", which is large enough, so it is never
 * tight. Only an explicit window is judged. */
export function isContextWindowTight(contextWindow, maxTokens = 0) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return false;
  return contextWindow < minimumUsefulContextWindow(maxTokens);
}

// 0 keeps the built-in default, so the ranges only bound what a user may set.
const CONTEXT_WINDOW_RANGE = [1000, 2000000];
const MAX_TOKENS_RANGE = [1, 100000];

function validateRange(value, field, [min, max]) {
  if (!Number.isInteger(value) || (value !== 0 && (value < min || value > max))) throw new Error(field);
  return value;
}

export function validateAgentConfig({ endpoint, model, apiKey = "", headers = {},
  provider = AGENT_PROVIDERS[0].id, reasoning = AGENT_REASONING_LEVELS[0],
  contextWindow = 0, maxTokens = 0 } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error("endpoint"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("endpoint");
  }
  if (typeof model !== "string" || !model.trim()) throw new Error("model");
  if (typeof apiKey !== "string") throw new Error("apiKey");
  const normalizedHeaders = {};
  const entries = Object.entries(headers || {});
  if (entries.length > AGENT_HEADER_LIMIT) throw new Error("headers");
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name) || typeof value !== "string" || !value ||
        value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error("headers");
    }
    normalizedHeaders[name] = value;
  }
  if (!AGENT_PROVIDERS.some((entry) => entry.id === provider)) throw new Error("provider");
  if (!AGENT_REASONING_LEVELS.includes(reasoning)) throw new Error("reasoning");
  return {
    endpoint: url.href.replace(/\/$/, ""), model: model.trim(), apiKey, headers: normalizedHeaders,
    provider, reasoning,
    contextWindow: validateRange(contextWindow, "contextWindow", CONTEXT_WINDOW_RANGE),
    maxTokens: validateRange(maxTokens, "maxTokens", MAX_TOKENS_RANGE),
  };
}

/* A request that never reached the model arrives as an opaque transport error:
 * the host is unreachable, the browser blocked the cross-origin request (CORS),
 * or the device is offline. Engines word it differently, and the OpenAI SDK
 * wraps it as "Connection error." / APIConnectionError, so both are recognised.
 * Reported separately because the fix is browser-side, not model-side. */
export function isEndpointUnreachable(error) {
  if (String(error?.name || "") === "APIConnectionError") return true;
  const message = String(error?.message || error || "");
  return /failed to fetch|fetch failed|networkerror|load failed|network request failed|connection error/i.test(message);
}

// Shared by browser, Capacitor and ArkWeb. Storage errors are surfaced by the UI;
// never report a successful save or clear when the persistent write failed.
export function loadAgentConfig(storage) {
  const raw = storage.getItem(AGENT_CONFIG_KEY);
  if (!raw) return null;
  try { return validateAgentConfig(JSON.parse(raw)); } catch { return null; }
}

export function saveAgentConfig(storage, config) {
  const normalized = validateAgentConfig(config);
  storage.setItem(AGENT_CONFIG_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearAgentConfig(storage) {
  storage.removeItem(AGENT_CONFIG_KEY);
}
