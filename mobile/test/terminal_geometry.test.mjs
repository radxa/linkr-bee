import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalSessionTracker,
  looksLikeShellPrompt,
  normalizeTerminalGeometry,
  terminalGeometryCommand,
  terminalGeometryProbeCommand,
  parseTerminalGeometryConfirmation,
} from "../../web/terminal_geometry.js";

test("target session restart survives fragmented and coalesced UART notifications", () => {
  const tracker = createTerminalSessionTracker();
  assert.equal(tracker.push("board log"), false);
  assert.equal(tracker.push("in:"), true);
  assert.equal(tracker.push(" root"), false);
  assert.equal(tracker.push("\r\nPassword: \r\nroot@board:~# "), false);
  assert.equal(tracker.push("\r\nboard login: root\r\nroot@board:~# "), true);
  assert.equal(tracker.push("\r\n[    0.000000] Linux ver"), false);
  assert.equal(tracker.push("sion 6.6.0\r\n"), true);
  assert.equal(tracker.push("application mentions login: in its output"), false);
  tracker.reset();
  assert.equal(tracker.push("login:"), true);
});

test("terminal geometry is integer, bounded and stable", () => {
  assert.deepEqual(normalizeTerminalGeometry(145.9, 53.8), {
    cols: 145,
    rows: 53,
    key: "145x53",
  });
  assert.deepEqual(normalizeTerminalGeometry(0, Infinity), {
    cols: 2,
    rows: 2,
    key: "2x2",
  });
  assert.deepEqual(normalizeTerminalGeometry(5000, 2000), {
    cols: 1000,
    rows: 1000,
    key: "1000x1000",
  });
});

test("stty command uses the current xterm rows and columns", () => {
  assert.equal(
    terminalGeometryCommand(145, 53),
    "stty rows 53 cols 145 >/dev/null 2>&1\r",
  );
});

test("common Linux shell prompts are recognized", () => {
  for (const prompt of [
    "radxa@radxa-dragon-q8b:~$ ",
    "root@linkr:/etc# ",
    "~ # ",
    "/ # ",
    "bash-5.2$ ",
    "[root@linkr tmp]# ",
    "$ ",
    "# ",
    // zsh and fish terminators: a board whose prompt ends this way used to
    // never receive the stty line, so every full-screen program stayed at the
    // tty's boot-time size.
    "user@host ~ % ",
    "user@host ~/src % ",
    "user@host:~/src% ",
    "user@host ~> ",
    "user@host ~/src> ",
    "sh-5.2> ",
    // a host with no user@, the buildroot prompt
    "buildroot:~# ",
    "buildroot:/etc# ",
    // starship / powerline: the shape most development boards ship
    "08:57:55 radxa@radxa-cubie-a7z ~ → ",
    "bob@host /srv ❯ ",
    "❯ ",
    // an activated environment is part of the prompt
    "(venv) user@host:~# ",
  ]) {
    assert.equal(looksLikeShellPrompt(prompt), true, prompt);
  }
});

test("login prompts and command output do not trigger shell synchronization", () => {
  for (const output of [
    "linkr login: ",
    "Password: ",
    "Progress: [ 99%] ",
    "cost $ ",
    "printf '# '",
    "root@linkr:~# command",
    "",
    // `>` appears in ordinary output, so the prefix must look like a prompt.
    "=> ",
    "U-Boot> ",
    "echo hi > ",
    "100% ",
    "select> ",
    "> ",
    "   > ",
  ]) {
    assert.equal(looksLikeShellPrompt(output), false, output);
  }
});

test("TTY size probes require a valid nonce and read back the target size", () => {
  const nonce = "a".repeat(32);
  assert.equal(terminalGeometryProbeCommand(80, 24, nonce),
    `stty rows 24 cols 80 >/dev/null 2>&1 && printf '\\033]633;P;LinkrTTY=${nonce};%s\\007' "$(stty size 2>/dev/null)"\r`);
  assert.throws(() => terminalGeometryProbeCommand(80, 24, "'; echo bad"), TypeError);
  assert.deepEqual(parseTerminalGeometryConfirmation(`P;LinkrTTY=${nonce};24 80`, nonce), normalizeTerminalGeometry(80, 24));
  for (const data of [`P;LinkrTTY=${"b".repeat(32)};24 80`, `P;LinkrTTY=${nonce};`,
    `P;LinkrTTY=${nonce};0 80`, `P;LinkrTTY=${nonce};24 1001`,
    `P;LinkrTTY=${nonce};24 80 extra`]) {
    assert.equal(parseTerminalGeometryConfirmation(data, nonce), null, data);
  }
  assert.equal(parseTerminalGeometryConfirmation(`P;LinkrTTY=${nonce};24 80`, null), null);
});
