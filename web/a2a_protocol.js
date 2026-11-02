/* A2A protocol mapping for the resident agent.
 *
 * Linkr Bee speaks A2A over the same authenticated JSON-RPC transport as MCP:
 * `POST /a2a` for the JSON-RPC binding and a public agent card at
 * `/.well-known/agent-card.json`. The wire shapes live here as pure functions
 * so the host, the tests and the docs share one definition.
 *
 * The task lifecycle is the resident agent's: one task at a time, polled with
 * GetTask. Streaming (SSE) and push notifications are not advertised, because
 * the native transport answers one POST with one body; the card says so.
 */

export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_AGENT_VERSION = "0.1.0";
export const A2A_SKILL_ID = "linkr-bee-serial-console";
export const A2A_JSONRPC_PATH = "/a2a";
export const A2A_CARD_PATH = "/.well-known/agent-card.json";

/* A2A v1.0 reserves -32001..-32004. App-specific failures must not reuse those
 * codes: a client that sees -32001 concludes "task not found", not "the phone
 * is in read-only mode". The custom range below is outside the reserved set. */
export const A2A_ERROR = Object.freeze({
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  SERVER_DISABLED: -32010,
  READ_ONLY: -32011,
  AGENT_NOT_CONFIGURED: -32012,
  TASK_BUSY: -32013,
  DENIED: -32014,
});

const TASK_STATE = {
  queued: "TASK_STATE_SUBMITTED",
  running: "TASK_STATE_WORKING",
  canceling: "TASK_STATE_WORKING",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
};

const TERMINAL_STATES = new Set([
  "TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED",
]);

export function isA2aTerminal(state) {
  return TERMINAL_STATES.has(state);
}

function partText(part) {
  return part && typeof part === "object" && typeof part.text === "string" ? part.text : "";
}

/* Collect the textual user input from an A2A Message. File/data parts are not
 * supported by this agent: the target is a serial console, not a document
 * store, and silently dropping a file part would misrepresent the request. */
export function messageText(message) {
  if (!message || typeof message !== "object") throw new Error("message is required");
  if (message.role !== "ROLE_USER" && message.role !== "user") {
    throw new Error("message.role must be ROLE_USER");
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (!parts.length) throw new Error("message.parts must contain at least one text part");
  const texts = [];
  for (const part of parts) {
    if (!part || typeof part !== "object" || typeof part.text !== "string") {
      throw new Error("Only text message parts are supported");
    }
    if (part.text.trim()) texts.push(part.text);
  }
  if (!texts.length) throw new Error("message.parts must contain non-empty text");
  return texts.join("\n");
}

/* A2A v1.0 defaults to a blocking SendMessage: the response carries the task
 * after it settles (or after a bounded wait). Only an explicit
 * returnImmediately=true asks for the queued task right away. */
export function parseSendMessageParams(params = {}) {
  if (!params || typeof params !== "object") throw new Error("params must be an object");
  const text = messageText(params.message);
  const configuration = params.configuration && typeof params.configuration === "object"
    ? params.configuration
    : {};
  const message = params.message;
  return {
    request: text,
    sessionId: typeof message.contextId === "string" && message.contextId ? message.contextId : undefined,
    taskId: typeof message.taskId === "string" && message.taskId ? message.taskId : undefined,
    messageId: typeof message.messageId === "string" ? message.messageId : undefined,
    returnImmediately: configuration.returnImmediately === true,
    historyLength: Number.isInteger(configuration.historyLength) ? configuration.historyLength : 0,
  };
}

export function a2aAgentCard({ url, lang = "en" } = {}) {
  const zh = lang === "zh";
  const skill = {
    id: A2A_SKILL_ID,
    name: zh ? "Linkr Bee 串口控制台" : "Linkr Bee serial console",
    description: zh
      ? "通过 Linkr Bee 桥接器读取、配置和操作目标串口控制台；可以执行 shell 命令、检查设备、保存笔记并返回结论。"
      : "Read, configure and operate a target serial console through a Linkr Bee bridge: run shell commands, inspect the device, save notes and report a conclusion.",
    tags: ["serial", "uart", "console", "embedded", "linux", "linkr-bee"],
    examples: zh
      ? ["检查目标的系统版本和运行状态，并给出结论。", "把目标控制台里最近的内核报错整理出来。"]
      : ["Check the target's OS version and health, then report a conclusion.", "Summarize the recent kernel errors from the target console."],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
  };
  return {
    name: "Linkr Bee Resident Agent",
    description: zh
      ? "运行在 Linkr Bee App 内的常驻助手。通过 MCP/A2A 接收任务，使用 App 里已保存的 AI 配置和板载提示词操作目标串口；任务启动时在手机上确认一次。"
      : "A resident assistant inside the Linkr Bee app. It accepts tasks over MCP/A2A and uses the app's saved AI configuration and the board-stored instructions to work the target serial console; the phone owner approves each task once.",
    protocolVersion: A2A_PROTOCOL_VERSION,
    version: A2A_AGENT_VERSION,
    url,
    preferredTransport: "JSONRPC",
    supportedInterfaces: [{
      url,
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    provider: {
      organization: "Linkr Bee",
      url: "https://github.com/radxa/linkr-bee",
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    securitySchemes: {
      bearer: {
        /* A2A v1.0's SecurityScheme is a discriminated union; keep the HTTP
         * auth object under its proto JSON name. The flat OpenAPI-shaped
         * fields are kept as well for A2A 0.2/0.3-era clients, which read
         * `type`/`scheme` directly. */
        httpAuthSecurityScheme: {
          scheme: "bearer",
          bearerFormat: "64 lowercase hex characters (the MCP access token)",
        },
        type: "http",
        scheme: "bearer",
        bearerFormat: "64 lowercase hex characters (the MCP access token)",
      },
    },
    security: [{ bearer: [] }],
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [skill],
  };
}

export function a2aMessage({ role = "ROLE_AGENT", text = "", taskId = "", contextId = "" } = {}) {
  const message = {
    role,
    parts: [{ text: String(text).slice(0, 20000) }],
    messageId: `msg-${taskId || "agent"}`,
  };
  if (taskId) message.taskId = taskId;
  if (contextId) message.contextId = contextId;
  return message;
}

/* Map a resident-agent snapshot onto an A2A Task. The assistant's answer is an
 * artifact, never evidence; the caller still has to verify device state. */
export function a2aTask(task, { historyLength = 0 } = {}) {
  if (!task || typeof task !== "object" || typeof task.taskId !== "string") {
    throw new Error("A resident agent task is required");
  }
  const state = TASK_STATE[task.state] || "TASK_STATE_WORKING";
  const contextId = task.sessionId || "default";
  const result = {
    id: task.taskId,
    contextId,
    status: {
      state,
      timestamp: task.finishedAt || task.startedAt || task.createdAt || new Date().toISOString(),
    },
    metadata: {
      progress: task.progress || "",
      usage: task.usage || null,
      toolCalls: Array.isArray(task.toolCalls)
        ? task.toolCalls.slice(-20).map((call) => ({
          name: call.name,
          state: call.state,
          startedAt: call.startedAt || null,
          finishedAt: call.finishedAt || null,
        }))
        : [],
    },
  };
  if (state === "TASK_STATE_WORKING" || state === "TASK_STATE_SUBMITTED") {
    if (task.progress) {
      result.status.message = a2aMessage({ text: task.progress, taskId: task.taskId, contextId });
    }
  }
  if (state === "TASK_STATE_FAILED" && task.error) {
    result.status.message = a2aMessage({ text: task.error, taskId: task.taskId, contextId });
  }
  if (state === "TASK_STATE_COMPLETED" && task.result) {
    result.artifacts = [{
      artifactId: `artifact-${task.taskId}`,
      name: "Linkr Bee resident agent answer",
      parts: [{ text: task.result }],
    }];
  }
  if (historyLength > 0) {
    const history = [a2aMessage({ role: "ROLE_USER", text: task.request, taskId: task.taskId, contextId })];
    if (task.result) history.push(a2aMessage({ role: "ROLE_AGENT", text: task.result, taskId: task.taskId, contextId }));
    result.history = history.slice(-historyLength);
  }
  return result;
}

/* One page of tasks plus the totals the spec asks for. `nextPageToken` is a
 * plain numeric offset into the matched list, so a client can page without any
 * server-side state; the request may use pageToken or the response's own
 * nextPageToken name. Unknown filters are ignored by the caller, not claimed
 * here. */
export function a2aListTasks(tasks, { pageSize = 50, pageToken = "", nextPageToken = "" } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const size = Math.max(1, Math.min(100, Number.isInteger(pageSize) ? pageSize : 50));
  const requested = String(pageToken || nextPageToken || "").trim();
  const requestedOffset = Number.parseInt(requested, 10);
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
  const page = list.slice(offset, offset + size);
  const nextOffset = offset + page.length;
  return {
    tasks: page.map((task) => a2aTask({
      taskId: task.taskId,
      sessionId: task.sessionId,
      state: task.state,
      progress: "",
      request: task.request,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    })),
    nextPageToken: nextOffset < list.length ? String(nextOffset) : "",
    pageSize: page.length,
    totalSize: list.length,
  };
}

export function a2aError(id, code, message, { reason = "" } = {}) {
  const error = { code, message };
  if (reason) {
    error.data = [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "a2a-protocol.org" }];
  }
  return { jsonrpc: "2.0", id: id ?? null, error };
}

export function a2aResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
