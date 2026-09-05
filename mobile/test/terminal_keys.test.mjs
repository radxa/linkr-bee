import assert from "node:assert/strict";
import test from "node:test";
import { applyInputModifiers, controlInput, terminalKeySequence } from "../../web/terminal_keys.js";

test("Ctrl maps a single letter to a control byte regardless of case", () => {
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    assert.equal(controlInput(letter).charCodeAt(0), code - 64);
    assert.equal(controlInput(letter.toLowerCase()).charCodeAt(0), code - 64);
  }
  assert.equal(controlInput(" "), "\x00");
  assert.equal(controlInput("["), "\x1b");
  assert.equal(controlInput("?"), "\x7f");
});

test("Ctrl preserves IME commits, paste and physical-key escape sequences", () => {
  for (const text of ["你好", "ß", "hello", "\x1b[A", "\x03", "1", ""]) {
    assert.equal(controlInput(text), text);
  }
});

test("accessory keys send UART bytes, not their visible labels", () => {
  assert.equal(terminalKeySequence("Tab"), "\x09");
  assert.equal(terminalKeySequence("Escape"), "\x1b");
  assert.equal(terminalKeySequence("Ctrl-C"), "\x03");
  assert.equal(terminalKeySequence("Ctrl-D"), "\x04");
  assert.equal(terminalKeySequence("Ctrl-Z"), "\x1a");
  assert.equal(terminalKeySequence("PageUp"), "\x1b[5~");
  assert.equal(terminalKeySequence("PageDown"), "\x1b[6~");
  assert.equal(terminalKeySequence("Delete"), "\x1b[3~");
  assert.equal(terminalKeySequence("unknown"), "");
});

test("cursor keys follow normal and application modes (shell versus editors)", () => {
  for (const [key, suffix] of Object.entries({
    ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F",
  })) {
    assert.equal(terminalKeySequence(key), `\x1b[${suffix}`);
    assert.equal(terminalKeySequence(key, true), `\x1bO${suffix}`);
  }
});

test("Shift and Alt combine with Ctrl and preserve composed text", () => {
  assert.equal(applyInputModifiers("c", { shift: true }), "C");
  assert.equal(applyInputModifiers("/", { shift: true }), "?");
  assert.equal(applyInputModifiers("\\", { shift: true }), "|");
  assert.equal(applyInputModifiers("c", { shift: true, ctrl: true }), "\x03");
  assert.equal(applyInputModifiers("b", { alt: true }), "\x1bb");
  assert.equal(applyInputModifiers("c", { ctrl: true, alt: true }), "\x1b\x03");
  for (const text of ["你好", "ß", "pasted text", "\x1b[A"]) {
    assert.equal(applyInputModifiers(text, { shift: true, ctrl: true, alt: true }), text);
  }
});

test("accessory modifiers support reverse Tab, word navigation and symbols", () => {
  assert.equal(terminalKeySequence("Tab", false, { shift: true }), "\x1b[Z");
  assert.equal(terminalKeySequence("ArrowRight", true, { ctrl: true }), "\x1b[1;5C");
  assert.equal(terminalKeySequence("ArrowUp", false, { shift: true, alt: true }), "\x1b[1;4A");
  assert.equal(terminalKeySequence("PageDown", false, { shift: true }), "\x1b[6;2~");
  assert.equal(terminalKeySequence("/", false, { shift: true }), "?");
  assert.equal(terminalKeySequence("|"), "|");
  assert.equal(terminalKeySequence("Backspace"), "\x7f");
  assert.equal(terminalKeySequence("Enter"), "\r");
});
