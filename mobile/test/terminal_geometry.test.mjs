import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalSessionTracker,
  looksLikeShellPrompt,
  normalizeTerminalGeometry,
  terminalGeometryCommand,
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
  ]) {
    assert.equal(looksLikeShellPrompt(output), false, output);
  }
});
