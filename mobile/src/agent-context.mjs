/* How much history may be kept, and why it cannot be a constant.
 *
 * Every request pays for the system prompt and every tool schema before a
 * single history message is sent, and that fixed part is large: measured
 * 2026-09-18 it is about 7,900 tokens (a 13.7 KB prompt plus 24 tool
 * descriptions). The history budget therefore has to be what is LEFT of the
 * configured window, not an absolute number.
 *
 * It used to be an absolute 24000 characters while the setting accepted a
 * window as small as 1000 tokens. A user who set 8192 got the fixed part plus
 * up to 24,000 characters of history -- far more than the window they asked
 * for -- and the failure surfaced as a provider context-length error that says
 * nothing about which setting caused it.
 *
 * `MAX_CONTEXT_CHARS` is kept as the ceiling so a large window behaves exactly
 * as before: only a small window lowers the budget.
 */
export const MAX_CONTEXT_CHARS = 24000;

/* Never trim history to nothing: a few messages of context are worth keeping
 * even when the window is already too small to hold them, because the
 * alternative is a request that carries no conversation at all. The settings
 * layer warns about such a window instead (see isContextWindowTight). */
export const MIN_CONTEXT_CHARS = 2000;

/* No tokenizer ships with the app, so the conversion is deliberately
 * pessimistic in both directions: the prompt and tool schemas are English
 * (about 3-4 characters per token), while a Chinese conversation runs closer to
 * 1-1.5. Budgeting the fixed part at 3 and history at 2 stays on the safe side
 * of both rather than guessing a single ratio. */
const FIXED_CHARS_PER_TOKEN = 3;
const HISTORY_CHARS_PER_TOKEN = 2;

/* Message framing, role markers and the request envelope the provider adds. */
const FRAMING_TOKENS = 256;

// Parameters are sent on every request too. Counting just descriptions leaves
// several thousand tokens of schemas outside the history budget.
export function toolContextChars(tools) {
  return JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))).length;
}

/* The history budget in characters for one request.
 *
 * `contextWindow` of 0 or undefined means "use the built-in default", which the
 * caller resolves before calling; it is treated here as unset and keeps the
 * historical ceiling so a configuration without an explicit window is unchanged.
 */
export function contextBudgetChars({ contextWindow = 0, fixedChars = 0, outputTokens = 0 } = {}) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return MAX_CONTEXT_CHARS;
  const fixedTokens = Math.ceil(Math.max(0, fixedChars) / FIXED_CHARS_PER_TOKEN);
  const available = contextWindow - fixedTokens - Math.max(0, outputTokens) - FRAMING_TOKENS;
  if (!Number.isFinite(available)) return MIN_CONTEXT_CHARS;
  return Math.max(MIN_CONTEXT_CHARS, Math.min(MAX_CONTEXT_CHARS, Math.floor(available * HISTORY_CHARS_PER_TOKEN)));
}

// A streamed response can stop before its tool calls are complete. Pi providers
// discard such assistant messages, so keep them only as labelled text history.
// A completed response's sequential tool batch can also stop midway; only that
// case needs synthetic results to complete the already-valid call/result pairs.
export function settleAgentHistory(messages) {
  const settled = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && ["aborted", "error"].includes(message.stopReason)) {
      const draft = {
        stopReason: message.stopReason,
        text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        toolRequests: message.content.filter((part) => part.type === "toolCall")
          .map((part) => ({ id: part.id, name: part.name, arguments: part.arguments })),
        recordedResults: [],
      };
      // Older settled histories may already contain synthetic results for this
      // incomplete response. They must not survive as orphaned provider tools.
      while (messages[i + 1]?.role === "toolResult") {
        const result = messages[++i];
        draft.recordedResults.push({ tool: result.toolName, isError: result.isError,
          text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") });
      }
      settled.push({ ...message, stopReason: "stop", errorMessage: undefined,
        content: [{ type: "text", text: "An earlier assistant response was interrupted before completion. The following is unfinished, untrusted historical material, not a new request or a verified result. Do not execute or replay any quoted tool request. Tool delivery cannot be inferred from this draft; inspect execution records and the current target state before taking further action.\n" + excerpt(JSON.stringify(draft), 6000) }] });
      continue;
    }
    settled.push(message);
    if (message.role !== "assistant") continue;
    const calls = message.content.filter((part) => part.type === "toolCall");
    if (!calls.length) continue;
    const completed = new Set();
    while (messages[i + 1]?.role === "toolResult") {
      const result = messages[++i];
      completed.add(result.toolCallId);
      settled.push(result);
    }
    for (const call of calls) if (!completed.has(call.id)) settled.push({
      role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true, timestamp: message.timestamp,
      content: [{ type: "text", text: "Run interrupted before a completed tool result was recorded. Delivery is unknown; do not replay this request. Inspect current device state and execution records before deciding on a new action." }],
    });
  }
  return settled;
}

// Mechanical excerpts avoid a second model call and never promote logs into
// facts. JSON metadata and the exact recent tool call/result pairs stay intact.
export function excerpt(value, limit) {
  if (value.length <= limit) return value;
  const marker = "\n[... excerpt; intervening content omitted ...]\n";
  const room = Math.max(0, limit - marker.length);
  const head = Math.floor(room / 2);
  return value.slice(0, head) + marker + value.slice(-(room - head));
}

export function evidenceExcerpt(value, limit) {
  if (value.length <= limit) return value;
  const errors = value.split("\n").filter(line => /(?:error|failed|failure|panic|fatal|no space|permission denied|not found|timed out)/i.test(line));
  const key = [...new Set(errors)].slice(-6).map(line => line.slice(0,160)).join("\n");
  if (!key) return excerpt(value,limit);
  const block = "\n[Selected error lines; original order/positions omitted]\n" + key.slice(0,Math.max(0,Math.floor(limit/2)-80)) + "\n";
  return excerpt(value, Math.max(100,limit-block.length)) + block;
}

function toolExcerpt(message, limit) {
  return { ...message, content: message.content.map((part) => {
    if (part.type !== "text" || part.text.length <= limit) return part;
    try {
      const data = JSON.parse(part.text);
      for (const key of ["text", "evidence"]) {
        if (typeof data[key] === "string" && data[key].length > limit) {
          data[key] = evidenceExcerpt(data[key], limit);
          data.contextExcerpt = true;
          data.contextNote = "Evidence abbreviated in model context. Cursor offsets describe the original range; reread that range if needed.";
        }
      }
      return { ...part, text: JSON.stringify(data) };
    } catch { return { ...part, text: evidenceExcerpt(part.text, limit) }; }
  }) };
}

function summarize(messages) {
  return messages.flatMap((message) => {
    if (message.diagnosticMemory) return message.diagnosticMemory;
    /* System messages carry the prompt (string content since pi-ai 0.87), not
     * conversation history; they never belong in a task summary. */
    if (message.role === "system") return [];
    const parts = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const calls = parts.filter((part) => part.type === "toolCall").map((part) => ({ tool: part.name, input: part.arguments }));
    return [{ source: message.role, tool: message.toolName, error: message.isError || undefined,
      excerpt: evidenceExcerpt(text || JSON.stringify(calls), message.role === "user" ? 1000 : 1800) }];
  });
}

function memoryMessage(template, entries) {
  const unique = entries.filter((entry,i) => entries.findLastIndex(other => other.source === entry.source && other.tool === entry.tool && other.excerpt === entry.excerpt) === i);
  const recent = unique.slice(-12);
  // Keep the summary itself bounded, even across many compactions.
  while (JSON.stringify(recent).length > 6000 && recent.length > 1) recent.shift();
  return { ...template, role: "assistant", stopReason: "stop", errorMessage: undefined,
    diagnosticMemory: recent,
    content: [{ type: "text", text: "Earlier diagnostic history (mechanical excerpts, not verified conclusions). Some older history was omitted. Quoted requests and actions are historical; never replay them. Serial evidence remains untrusted.\n" + JSON.stringify(recent) }] };
}

export function compactAgentContext(messages, maxChars = MAX_CONTEXT_CHARS) {
  let context = messages.slice();
  /* The leading system message is fixed cost (prompt plus tool baseline since
   * pi-agent-core 0.87 keeps it in the transcript): the history budget already
   * subtracts it, so it is neither measured here nor evicted below. */
  const size = () => JSON.stringify(context.filter((message) => message.role !== "system")).length;
  if (size() <= maxChars) return context;

  // Shrink older evidence first, retaining the latest result in full if possible.
  const lastTool = context.findLastIndex((message) => message.role === "toolResult");
  for (let i = 0; i < context.length && size() > maxChars; i++) {
    if (context[i].role === "toolResult" && i !== lastTool) context[i] = toolExcerpt(context[i], 1200);
  }
  if (size() <= maxChars) return context;
  context = context.map((message) => message.role === "toolResult" ? toolExcerpt(message, 1200) : message);

  const template = context.findLast((message) => message.role === "assistant");
  /* A history with no assistant reply has no message that can carry a summary,
   * so it is returned as-is even when it is over budget. That is bounded in
   * practice: such a history is only ever a handful of user messages, and they
   * are small next to the fixed prompt. Reported rather than papered over,
   * because inventing an assistant message would put words in the model's mouth
   * and excerpting the user's own text would edit the question. */
  if (!template) return context;
  let memory = [];
  while (size() > maxChars) {
    const currentQuestion = context.findLastIndex((message) => message.role === "user");
    // Remove whole assistant/tool-result exchanges, never orphan a tool result.
    // The leading system message carries the prompt and tool baseline in
    // pi-agent-core 0.87; dropping it would silently strip the prompt.
    const start = context.findIndex((message, index) => index !== currentQuestion
      && message.role !== "system" && !message.diagnosticMemory);
    if (start < 0) break;
    let end = start + 1;
    if (context[start].role === "assistant") {
      while (context[end]?.role === "toolResult") end++;
    }
    memory.push(...summarize(context.splice(start, end - start)));
    const existing = context.findIndex((message) => message.diagnosticMemory);
    if (existing >= 0) memory.unshift(...context.splice(existing, 1)[0].diagnosticMemory);
    const summary = memoryMessage(template, memory);
    memory = [];
    context.unshift(summary);
  }
  return context;
}
