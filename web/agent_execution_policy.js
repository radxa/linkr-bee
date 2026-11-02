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
 * built-in query list requires. Neither can override a destructive guard. */
export function requiresInputApproval(mode, args, payload, inputPending = false, policy = null) {
  // Destructive operations outrank the mode: no execution mode sends them
  // unattended.
  if (isGuardedCommand(args.text)) return true;
  // The user's own "always ask" list outranks Full Auto too, and matches the
  // wire text so a rewritten tracked command cannot slip past it.
  if (policy && isAlwaysAsk(policy.alwaysAsk, args.text, payload)) return true;
  if (mode === "full-auto") return false;
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
 * backspace/DEL, and the shell expands `${IFS}` before parsing, so both can
 * hide a command or its argument separator. This is still a best-effort guard
 * for recognized forms, not a shell parser.
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

/* Undo the two wire-level transformations that can hide a guarded command:
 * tty erase on backspace/DEL, and shell expansion of ${IFS}/$IFS into a word
 * separator. Everything else is matched against the literal wire text. */
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

export function isGuardedCommand(text) {
  if (typeof text !== "string") return false;
  const normalized = normalizeForGuardCommand(text);
  return guarded.some((pattern) => pattern.test(normalized));
}

export function inputLeavesPendingLine(bytes, pending) {
  for (const byte of bytes) {
    // Other controls (including cursor movement/backspace) leave state uncertain.
    pending = byte !== 10 && byte !== 13 && byte !== 3;
  }
  return pending;
}

export function executionModePrompt(mode = "auto") {
  if (mode === "full-auto") return "Execution mode: Full Auto. The user authorizes direct serial execution without confirmation, except for destructive or irreversible commands, which always require their explicit approval: recursive or forced deletion, partition/filesystem tools, dd and raw device writes, flash/bootloader tooling, piping downloaded content into a shell, privilege escalation, and recursive permission changes. Unrelated text that merely mentions those tools is not affected. If such a command needs approval, ask the user instead of looking for a way around the rule.";
  if (mode === "auto") return "Execution mode: Auto (recommended). The app automatically sends only exact allowlisted low-risk queries on a clear input line with a currently recognized shell prompt. All other input requires user approval. Destructive or irreversible commands always require approval in every mode. Do not assume shell queries are suitable until logs establish the target console state.";
  return "Execution mode: Manual. Propose commands with send_serial_input; nothing is sent until the user clicks Send.";
}
