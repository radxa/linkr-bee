const MIN_TERMINAL_COLUMNS = 2;
const MIN_TERMINAL_ROWS = 2;
const MAX_TERMINAL_DIMENSION = 1000;

function clampDimension(value, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(
    minimum,
    Math.min(MAX_TERMINAL_DIMENSION, Math.floor(number)),
  );
}

export function normalizeTerminalGeometry(cols, rows) {
  const normalizedCols = clampDimension(cols, MIN_TERMINAL_COLUMNS);
  const normalizedRows = clampDimension(rows, MIN_TERMINAL_ROWS);
  return {
    cols: normalizedCols,
    rows: normalizedRows,
    key: `${normalizedCols}x${normalizedRows}`,
  };
}

export function terminalGeometryCommand(cols, rows) {
  const geometry = normalizeTerminalGeometry(cols, rows);
  return `stty rows ${geometry.rows} cols ${geometry.cols} >/dev/null 2>&1\r`;
}

/* Prompt terminators, each followed by one space.
 *
 * `%` is zsh's default and fish uses `>`; both were missing, so a board whose
 * prompt ends that way never received the `stty` line at all and every
 * full-screen program kept the tty's boot-time size. `>` is the riskiest of the
 * four because ordinary output can end with it, which is why the prefix has to
 * look like a prompt too — a bare `=>` (U-Boot) or `echo hi >` still fails. */
const PROMPT_TERMINATORS = new Set(["$", "#", "%", ">"]);

/* A prompt on its own line, without the terminator. */
function looksLikePromptPrefix(prefix) {
  if (!prefix) return true;

  /* `(venv) user@host:~` — an activated environment is part of the prompt. */
  const wrapper = /^\([^)]*\)\s+/.exec(prefix);
  if (wrapper) prefix = prefix.slice(wrapper[0].length).trim();
  if (!prefix) return false;

  if (/^\[[^\]]+\]$/.test(prefix)) return true;
  if (/^(?:ba|da|a|z)?sh(?:-[\d.]+)?$/.test(prefix)) return true;
  if (/^(?:~|~?\/[^\s]*|\/[^\s]*)$/.test(prefix)) return true;

  /* `user@host`, `user@host:path`, `user@host ~/dir` (zsh and fish place the
   * working directory after a space instead of a colon). */
  const at = prefix.lastIndexOf("@");
  if (at > 0) {
    /* The last token before `@` is the user. The Python client's line tracker
     * concatenates a prompt redrawn without a newline, so an earlier prompt may
     * sit to the left of this one; only the token adjacent to `@` counts. */
    const user = prefix.slice(0, at).split(/\s+/).pop();
    if (!user) return false;
    const rest = prefix.slice(at + 1);
    const split = rest.search(/[\s:]/);
    const host = split < 0 ? rest : rest.slice(0, split);
    if (!host) return false;
    if (split < 0) return true;
    const tail = rest.slice(split);
    if (tail.startsWith(":")) return !/\s/.test(tail);
    const path = tail.trim();
    return path === "~" || path.startsWith("~/") || path.startsWith("/");
  }

  /* `buildroot:~#`, `host:/etc#` — a host name with no `user@`. */
  const colon = prefix.indexOf(":");
  if (colon > 0) {
    const host = prefix.slice(0, colon);
    const path = prefix.slice(colon + 1);
    if (!/[\s@:]/.test(host) && !/\s/.test(path)) {
      return path === "~" || path.startsWith("~/") || path.startsWith("/");
    }
  }

  return false;
}

export function looksLikeShellPrompt(line) {
  if (typeof line !== "string" || line.length < 2) return false;
  if (!PROMPT_TERMINATORS.has(line[line.length - 2])) return false;
  if (line[line.length - 1] !== " ") return false;
  return looksLikePromptPrefix(line.slice(0, -2).trim());
}

// Track incoming UART text, including prompts split across notifications. A
// target can reboot or start getty again without disconnecting the accessory.
export function createTerminalSessionTracker() {
  let line = "";
  let matched = false;
  return {
    reset() { line = ""; matched = false; },
    push(text) {
      let restarted = false;
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          line = "";
          matched = false;
          continue;
        }
        line = (line + char).slice(-1024);
        if (!matched && (/^(?:[^\s:]+\s+)?login:\s*$/i.test(line) ||
            /^(?:\[\s*\d+(?:\.\d+)?\]\s*)?Linux version\s/.test(line))) {
          restarted = true;
          matched = true;
        }
      }
      return restarted;
    },
  };
}
