// Byte sequences for the shared Web/Capacitor/ArkWeb terminal accessory bar.
export function controlInput(data) {
  // Never rewrite an IME commit, paste, or an existing terminal escape sequence.
  if (data.length !== 1) return data;
  let code = data.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a) code -= 0x20;
  if (data === " ") return "\x00";
  if (data === "?") return "\x7f";
  return code >= 0x40 && code <= 0x5f
    ? String.fromCharCode(code & 0x1f)
    : data;
}

export function applyInputModifiers(data, { shift = false, ctrl = false, alt = false } = {}) {
  // Composition and paste can contain many characters; modifiers only target
  // one ASCII keystroke, never arbitrary text or a physical-key escape sequence.
  if (data.length !== 1 || data.charCodeAt(0) > 0x7f) return data;
  if (shift) {
    const normal = "`1234567890-=[]\\;',./";
    const shifted = '~!@#$%^&*()_+{}|:"<>?';
    const index = normal.indexOf(data);
    data = index >= 0 ? shifted[index] : data.toUpperCase();
  }
  if (ctrl) data = controlInput(data);
  return alt ? `\x1b${data}` : data;
}

export function terminalKeySequence(key, applicationCursorKeys = false, modifiers = {}) {
  const modifier = 1 + (modifiers.shift ? 1 : 0) +
    (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  const cursor = {
    ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D",
    Home: "H", End: "F",
  };
  if (Object.hasOwn(cursor, key)) {
    if (modifier > 1) return `\x1b[1;${modifier}${cursor[key]}`;
    return `\x1b${applicationCursorKeys ? "O" : "["}${cursor[key]}`;
  }
  if (/^Ctrl-[A-Z]$/.test(key)) return controlInput(key.slice(-1));
  if (key.length === 1 && "/|~\\`-".includes(key)) return applyInputModifiers(key, modifiers);
  if (key === "Tab" && modifiers.shift) return "\x1b[Z";
  const tilde = { Delete: 3, PageUp: 5, PageDown: 6 };
  if (Object.hasOwn(tilde, key) && modifier > 1) {
    return `\x1b[${tilde[key]};${modifier}~`;
  }
  const sequence = {
    Tab: "\t", Escape: "\x1b", Enter: "\r", Backspace: "\x7f",
    Delete: "\x1b[3~", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
  }[key] ?? "";
  return applyInputModifiers(sequence, modifiers);
}
