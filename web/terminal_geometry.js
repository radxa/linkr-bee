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

// Keep the basic resize shared with the CLI/TUI. The web status indicator also
// needs a readback: a completed transport write is not a successful stty.
export function terminalGeometryProbeCommand(cols, rows, nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new TypeError("Invalid TTY probe nonce");
  return terminalGeometryCommand(cols, rows).slice(0, -1) +
    ` && printf '\\033]633;P;LinkrTTY=${nonce};%s\\007' "$(stty size 2>/dev/null)"\r`;
}

export function parseTerminalGeometryConfirmation(data, nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce || "")) return null;
  const match = /^P;LinkrTTY=([a-f0-9]{32});([0-9]{1,4}) ([0-9]{1,4})$/.exec(data);
  if (!match || match[1] !== nonce) return null;
  const rows = Number(match[2]), cols = Number(match[3]);
  if (rows < MIN_TERMINAL_ROWS || cols < MIN_TERMINAL_COLUMNS ||
      rows > MAX_TERMINAL_DIMENSION || cols > MAX_TERMINAL_DIMENSION) return null;
  return normalizeTerminalGeometry(cols, rows);
}

/* Prompt terminators, each followed by one space.
 *
 * `%` is zsh and `>` is fish; the arrows are what starship and powerline prompts
 * end with, which is the shape most development boards ship. Every one of them
 * was missing at some point, and a prompt nobody recognises is never idle: the
 * `stty` line is never sent, and every full-screen program keeps drawing at the
 * tty's boot-time 80x24. `>` and the arrows are the riskiest because ordinary
 * output can end with them, which is why the prefix has to look like a prompt
 * too — a bare `=>` (U-Boot) or `echo hi >` still fails. */
const PROMPT_TERMINATORS = new Set(["$", "#", "%", ">", "→", "❯", "›"]);

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
  // Bare `> ` is the default PS2 continuation prompt (quotes, heredocs, etc.).
  // A fish-style primary prompt needs an identifying prefix to be safe here.
  if (line[line.length - 2] === ">" && !line.slice(0, -2).trim()) return false;
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
