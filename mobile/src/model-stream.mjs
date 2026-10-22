import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.throwIfAborted();
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

function failedMessage(model, error, signal, partial) {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...partial, stopReason: signal?.aborted ? "aborted" : "error",
    errorMessage: error?.message || String(error),
  };
}

/* Retry only the current model request, before it has produced any content.
 * Never restart the Agent loop: a preceding UART/tool action may already have
 * happened. Even a partial tool call or thinking block makes a retry unsafe.
 * The budget belongs to the whole question, not each of its model turns. */
export function createModelStream({ stream, checkSession, onEvent, maxRetries = 2, baseDelayMs = 1000 }) {
  let retries = 0;
  return {
    reset() { retries = 0; },
    stream(model, context, options = {}) {
      const output = createAssistantMessageEventStream();
      const { signal } = options;
      void (async () => {
        let finalMessage, retrying = false;
        try {
          for (;;) {
            let start, partial, contentStarted = false;
            try {
              signal?.throwIfAborted();
              checkSession?.(signal);
              const response = await stream(model, context, options);
              for await (const event of response) {
                signal?.throwIfAborted();
                partial = event.partial || partial;
                if (event.type === "start") {
                  // A failed empty attempt must not leave a phantom assistant
                  // message in Pi's history or a blank message in the panel.
                  start = event;
                } else if (event.type === "done" || event.type === "error") {
                  finalMessage = event.type === "done" ? event.message : event.error;
                  break;
                } else {
                  contentStarted = true;
                  if (start) { output.push(start); start = null; }
                  output.push(event);
                }
              }
              finalMessage ||= await response.result();
              signal?.throwIfAborted();
            } catch (error) {
              finalMessage = failedMessage(model, error, signal, partial);
            }
            const canRetry = !signal?.aborted && !contentStarted && !partial?.content?.length && !finalMessage.content.length &&
              retries < maxRetries && !isContextOverflow(finalMessage) && isRetryableAssistantError(finalMessage);
            if (!canRetry) break;
            const attempt = ++retries, delayMs = baseDelayMs * 2 ** (attempt - 1);
            retrying = true;
            onEvent?.({ type: "model_retry_scheduled", attempt, maxAttempts: maxRetries, delayMs, usage: finalMessage.usage });
            await pause(delayMs, signal);
            checkSession?.(signal);
            onEvent?.({ type: "model_retry_start", attempt, maxAttempts: maxRetries });
            finalMessage = null;
          }
        } catch (error) {
          finalMessage = failedMessage(model, error, signal, finalMessage);
        }
        if (retrying) onEvent?.({ type: "model_retry_end", success: !["error", "aborted"].includes(finalMessage.stopReason) });
        output.push(["error", "aborted"].includes(finalMessage.stopReason)
          ? { type: "error", reason: finalMessage.stopReason, error: finalMessage }
          : { type: "done", reason: finalMessage.stopReason, message: finalMessage });
        output.end(finalMessage);
      })();
      return output;
    },
  };
}
