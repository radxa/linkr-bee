import { isAlwaysAsk, isPreApproved } from "./command_policy.js";

// Exact, deliberately small shell-query allowlist. Never trust a model's risk label.
const queries = new Set([
  "pwd", "whoami", "id", "uptime", "date",
  "uname", "uname -a", "uname -r", "uname -m",
  "ls", "ls -l", "ls -a", "ls -la", "ls -al", "ls -lh",
  "df", "df -h", "df -T", "free", "free -h", "free -m",
  "lsblk", "lsblk -f", "dmesg", "dmesg -T",
  "ip addr show", "ip link show", "ip route show",
  "cat /proc/version", "cat /proc/cpuinfo", "cat /proc/meminfo",
  "cat /proc/uptime", "cat /proc/cmdline", "cat /etc/os-release",
]);

/* `policy` is the per-target list from web/command_policy.js. It can only move
 * a decision in one direction each way: alwaysAsk forces approval in every
 * mode, allow grants approval in Auto mode under the same conditions the
 * built-in query list requires. Neither can override a destructive guard.
 *
 * `review` is the serialInputReview() result for this write when the caller
 * tracks the console input line (the executor and the MCP gate both do). Full
 * Auto stops being "no clicks" for input the guard cannot read as one complete
 * command line: a fragment, quoting/substitution/separators, or a preceding
 * line this app did not write. Auto already asks for everything except its
 * exact query list, so this changes Full Auto only. */
export function requiresInputApproval(mode, args, payload, inputPending = false, policy = null, review = null) {
  // Destructive operations outrank the mode: no execution mode sends them
  // unattended.
  if (isGuardedCommand(args.text)) return true;
  if (review?.destructive) return true;
  // The user's own "always ask" list outranks Full Auto too, and matches the
  // wire text so a rewritten tracked command cannot slip past it.
  if (policy && isAlwaysAsk(policy.alwaysAsk, args.text, payload)) return true;
  if (mode === "full-auto") return Boolean(review?.needsReview);
  if (mode !== "auto" || inputPending || args.appendEnter !== true) return true;
  // Compare the exact wire text: no multiline, escapes, operators, substitution,
  // arbitrary flags/paths or partial input can inherit query permission.
  if (policy && isPreApproved(policy.allow, args.text) &&
      ["\r", "\n", "\r\n"].some((enter) => payload === args.text + enter)) {
    return false;
  }
  return !queries.has(args.text) || !["\r", "\n", "\r\n"].some((enter) => payload === args.text + enter);
}

/* Destructive or irreversible operations that no execution mode may send
 * without a human decision.
 *
 * The model's context deliberately contains untrusted material: raw serial
 * output, target file contents and fetched web pages. Full Auto removes routine
 * friction, but it must not turn a single prompt injection into an unattended
 * `rm -rf`, `dd`, or firmware write. A false positive only costs one
 * confirmation click, so the patterns stay deliberately broad. This is a
 * best-effort guard for recognized shell forms, not a shell sandbox: indirect
 * execution through scripts, variables or interpreters cannot be classified
 * completely with these patterns.
 *
 * Matching starts at a command position — the beginning of the wire text, after
 * a shell separator or a compound-command keyword (`then`, `do`, `else`,
 * `elif`, `{`), inside a subshell, or inside the tracked `sh -c '…'` wrapper —
 * so text that merely *mentions* a tool name does not demand approval. The
 * app's own probes are the reason: PROFILE_PROBE runs `for t in … sudo
 * systemctl …` to detect available tools, and that must stay unattended.
 *
 * The wire form is normalized first: the tty erases the previous character on
 * backspace/DEL, the shell expands `${IFS}` before parsing, and quoting or
 * backslash escaping can split a command word (`r"m" -rf`), so all three can
 * hide a command or its argument separator. The de-quoted form is matched in
 * addition to the literal text. This is still a best-effort guard for
 * recognized forms, not a shell parser.
 *
 * Recoverable actions are deliberately absent: reboot, poweroff, mount/umount
 * and service restarts stay unguarded so Full Auto remains usable for the
 * normal bench loop, and they still require a click in Auto and Manual. */
const COMMAND_BOUNDARY = "(?:^|[\\r\\n;&|`(){}]\\s*|(?:then|do|else|elif)\\s+|(?:/[^\\s'\"]*/)?(?:sh|bash|dash|ash|zsh)\\s+-[a-z]*c[a-z]*\\s*['\"])\\s*";
const COMMAND_PATH = "(?:[./a-z0-9_-]+/)?";
// Resolve ordinary command prefixes, without treating argument mentions as commands.
const ASSIGNMENT = "[a-z_][a-z0-9_]*=[^\\s;&|]+\\s+";
const WRAPPER = COMMAND_PATH + "(?:env|command|exec|busybox)\\s+(?:(?:--|-[a-z]+)\\s+)*";
const COMMAND_START = COMMAND_BOUNDARY + "(?:(?:" + ASSIGNMENT + "|" + WRAPPER + "))*" + COMMAND_PATH;

// Commands that must start a command position to count.
const guardedCommands = [
  // Recursive or forced deletion, including find -delete / -exec rm.
  "rm\\b[^\\n]*\\s-{1,2}[a-z]*[rf]",
  "find\\b[^\\n]*\\s-(?:delete|exec\\s+rm)\\b",
  "shred\\b",
  // Partition table and filesystem creation/erasure.
  "(?:mkfs(?:\\.[a-z0-9]+)?|mke2fs|fdisk|sfdisk|gdisk|parted|sgdisk|wipefs|blkdiscard)\\b",
  // Raw copies, flash/MTD and bootloader tooling.
  "dd\\b",
  "(?:flash_erase|nandwrite|ubiformat|mtd_debug|flashrom|fw_setenv)\\b",
  "(?:esptool(?:\\.py)?|openocd|fastboot|rkdeveloptool|dfu-util|stm32flash|avrdude)\\b",
  // Privilege escalation.
  "(?:sudo|doas|su)\\b",
  // Recursive permission/ownership or immutable-attribute changes.
  "(?:chmod|chown|chgrp)\\b[^\\n]*\\s(?:-{1,2}[a-z]*r\\b|--recursive)",
  "(?:chattr|setfacl)\\b",
].map((source) => new RegExp(COMMAND_START + "(?:" + source + ")", "i"));

// Pipe and redirect patterns are position-independent.
const guardedPipelines = [
  />\s*\/dev\/(?:sd|mmcblk|nvme|mtdblock|loop|disk)/i,
  /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|ash|dash|zsh|ksh)\b/i,
  /\bbase64\b[^\n|]*(?:-d|--decode)[^\n|]*\|\s*(?:sh|bash|ash|dash|zsh)\b/i,
];

const guarded = guardedCommands.concat(guardedPipelines);

/* Undo the wire-level transformations that can hide a guarded command:
 * tty erase on backspace/DEL, shell expansion of ${IFS}/$IFS into a word
 * separator, and shell quoting/escaping that splits a command word. `r"m"`
 * and r\m both run `rm`, so matching the literal text alone would read them as
 * an unknown command. The quoted forms are tried in addition to the literal
 * text, never instead of it: the `sh -c '…'` wrapper is itself quoted, and
 * dropping the quotes first would remove that boundary. This is still
 * best-effort pattern matching, not a shell parser. */
function normalizeForGuardCommand(text) {
  let erased = "";
  for (const char of text) {
    if (char === "\x08" || char === "\x7f") erased = erased.slice(0, -1);
    else erased += char;
  }
  return erased
    .replace(/\$\{IFS(?::-[^}]*)?\}/gi, " ")
    .replace(/\$IFS\b/gi, " ");
}

function stripShellQuoting(text) {
  // Keep \n and \r: they separate commands and the boundary pattern needs them.
  return text.replace(/\\(?![nr])/g, "").replace(/["'`]/g, "");
}

export function isGuardedCommand(text) {
  if (typeof text !== "string") return false;
  const normalized = normalizeForGuardCommand(text);
  const unquoted = stripShellQuoting(normalized);
  const variants = unquoted === normalized ? [normalized] : [normalized, unquoted];
  return guarded.some((pattern) => variants.some((variant) => pattern.test(variant)));
}

/* A serial console is a line editor: bytes accumulate until a line terminator.
 * One write is therefore not necessarily one command, and a destructive
 * command can be delivered as a fragment plus its completion, with neither
 * write looking destructive on its own. These helpers keep the unfinished line
 * so a write is classified after concatenation.
 *
 * Quoting, substitution and separators make the resulting line impossible to
 * read as one literal command without running a shell parser, and a write that
 * does not end the line leaves the console in a state the guard cannot see.
 * Both shapes are forced through approval on the surfaces that otherwise run
 * unattended. This remains a best-effort guard, not a sandbox: an interpreter,
 * a script the target already has, or state the app never observed can still
 * execute something the patterns do not name. */
const OPAQUE_SHELL_INPUT = /["'`\\$;]/;

/* Bounded so a fragment storm cannot grow the tracked line without limit; a
 * write itself is capped at 2048 characters by the executor. */
export const INPUT_LINE_LIMIT = 4096;

/* Text up to the last line terminator (or Ctrl-C, which the tty uses to
 * discard the line) is what the shell will parse; the rest is still pending
 * input on the target console. */
export function pendingInputLine(line, payload) {
  const combined = String(line ?? "") + String(payload ?? "");
  const cut = Math.max(
    combined.lastIndexOf("\n"), combined.lastIndexOf("\r"), combined.lastIndexOf("\x03"));
  return combined.slice(cut + 1).slice(-INPUT_LINE_LIMIT);
}

/* One write ends the input line when its last byte is a terminator or an
 * interrupt. Reuses inputLeavesPendingLine() so the two cannot drift apart. */
function endsInputLine(payload) {
  if (typeof payload !== "string" || !payload.length) return false;
  return !inputLeavesPendingLine([payload.charCodeAt(payload.length - 1)], false);
}

/* Classify one serial write together with the text it completes. `destructive`
 * is the same recognition isGuardedCommand() applies to the joined line, so
 * `r` followed by `m -rf /tmp/x` is the same command as `rm -rf /tmp/x`.
 * `unverifiable` is true for a write that leaves the line unfinished, for a
 * line with quoting/substitution/separators, and for a console whose existing
 * input line this app never wrote (status says a line is pending but no text
 * was tracked). `continuesPendingLine` says the executed string is not this
 * write's text alone, which is what makes an approval of the text insufficient.
 * `payload` defaults to what appendEnter would append. */
export function serialInputReview({ text = "", appendEnter = true, payload = null, pendingLine = "", inputPending = false } = {}) {
  const requested = String(text ?? "");
  const joined = String(pendingLine ?? "") + requested;
  const wire = typeof payload === "string" ? payload : requested + (appendEnter === true ? "\r" : "");
  const destructive = isGuardedCommand(joined);
  const opaque = OPAQUE_SHELL_INPUT.test(joined);
  const unfinished = !endsInputLine(wire);
  const untrackedLine = String(pendingLine ?? "") === "" && inputPending === true;
  /* True when this write runs a string other than its own text: either it
   * appends to a line this app tracked, or the console holds a line the app
   * never saw. An approval that names this write's text does not cover that
   * longer string. */
  const continuesPendingLine = String(pendingLine ?? "") !== "" || untrackedLine;
  return { joined, destructive, opaque, unfinished, untrackedLine, continuesPendingLine,
    unverifiable: opaque || unfinished || untrackedLine,
    needsReview: destructive || opaque || unfinished || untrackedLine };
}

/* Per-session unfinished input line. A new session (reconnect, clear, reset)
 * starts an empty line. This is bookkeeping for the guard, not a terminal
 * emulator: bytes the app never wrote are covered by status.inputPending
 * instead of by reconstructed text. */
export function createInputLineTracker() {
  let key = null;
  let pending = "";
  const sync = (sessionKey) => {
    if (sessionKey !== key) { key = sessionKey; pending = ""; }
  };
  return {
    current(sessionKey) { sync(sessionKey); return pending; },
    record(sessionKey, payload) { sync(sessionKey); pending = pendingInputLine(pending, payload); return pending; },
    reset() { key = null; pending = ""; },
  };
}

export function inputLeavesPendingLine(bytes, pending) {
  for (const byte of bytes) {
    // Other controls (including cursor movement/backspace) leave state uncertain.
    pending = byte !== 10 && byte !== 13 && byte !== 3;
  }
  return pending;
}

export function executionModePrompt(mode = "auto") {
  if (mode === "full-auto") return "Execution mode: Full Auto. The user authorizes direct serial execution without confirmation for ordinary input, except for two classes, which always require their explicit approval: destructive or irreversible commands (recursive or forced deletion, partition/filesystem tools, dd and raw device writes, flash/bootloader tooling, piping downloaded content into a shell, privilege escalation, recursive permission changes), and input the guard cannot read as one complete command line (a write that does not end the line, or a line with quoting, substitution or command separators). Unrelated text that merely mentions those tools is not affected. If such input needs approval, ask the user instead of looking for a way around the rule.";
  if (mode === "auto") return "Execution mode: Auto (recommended). The app automatically sends only exact allowlisted low-risk queries on a clear input line with a currently recognized shell prompt. All other input requires user approval. Destructive or irreversible commands always require approval in every mode. Do not assume shell queries are suitable until logs establish the target console state.";
  return "Execution mode: Manual. Propose commands with send_serial_input; nothing is sent until the user clicks Send.";
}
