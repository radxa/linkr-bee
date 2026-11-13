/**
 * Plain-text console rendering for the Linkr Bee TUI panel.
 *
 * This module is deliberately dependency-free ESM: no Solid, no OpenTUI, no
 * `@opencode/*`. The TUI component feeds it the console RPC's `text` chunks and
 * draws the result; `test/tui-render.test.mjs` exercises the same functions
 * with plain Node, so the byte-level behaviour (ANSI stripping, CR progress
 * overwrites, backspace, bounded scrollback) is tested without a terminal.
 *
 * The *reading* view (hiding agent probe echoes and collapsing `LINKR_RC_*`
 * completion markers) is produced on the server in `src/console.js`; this
 * renderer turns whichever view it is fed into display lines. The panel picks
 * `event.reading ?? event.text` in reading mode and `event.text` in raw mode
 * through `pickOutput()`, then re-reads the RPC for the new view when the user
 * toggles — so there is exactly one reading filter (the server's), not two.
 *
 * Console bytes are untrusted device data. This module only ever turns them
 * into text; it never interprets them as commands.
 */

/** Completed lines kept for scrollback. */
export const DEFAULT_MAX_LINES = 2000;

/** Completed-line bytes kept for scrollback (`64 KiB`). */
export const DEFAULT_MAX_BYTES = 64 * 1024;

/** Longest single (unterminated) line kept, so a CR progress line cannot grow without bound. */
export const DEFAULT_MAX_LINE_CHARS = 8 * 1024;

/** Longest escape sequence carried across chunk boundaries before it is dropped. */
export const DEFAULT_MAX_ESCAPE = 4 * 1024;

const ESC = '\x1b';
const BEL = '\x07';
const C1_CSI = '\u009b';

const TAB_WIDTH = 8;

/**
 * Number of terminal cells a code point occupies. Covers the East Asian wide
 * ranges and the common emoji blocks; everything else counts as one cell. A
 * full Unicode width table would be overkill for a serial console.
 */
export function charWidth(codePoint) {
  if (codePoint === 0) return 0;
  // Combining marks and zero-width characters occupy no cell.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200d
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK radicals / punctuation
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // Hiragana .. CJK compatibility
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK ext A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // Full-width forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) || // Emoji
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK ext B+
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a string in terminal cells (see `charWidth`). */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0));
  return width;
}

/**
 * Return the index just past the escape sequence starting at `index`, or -1
 * when the text ends inside one (the caller decides whether to drop or carry
 * the tail). Handles CSI (7-bit and 8-bit), OSC, DCS/SOS/PM/APC, charset
 * selectors and the two-character escapes.
 */
function escapeEnd(text, index) {
  const length = text.length;
  const next = text[index + 1];
  if (next === undefined) return -1;
  if (next === '[' || text[index] === C1_CSI) {
    // `text[index] === C1_CSI` is the 8-bit form: no extra byte to skip.
    let i = text[index] === C1_CSI ? index + 1 : index + 2;
    while (i < length) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1; // final byte
      if (code < 0x20 || code > 0x3f) return i; // malformed: drop what we scanned
      i += 1;
    }
    return -1;
  }
  if (next === ']') {
    let i = index + 2;
    while (i < length) {
      if (text[i] === BEL) return i + 1;
      if (text[i] === ESC && text[i + 1] === '\\') return i + 2;
      i += 1;
    }
    return -1;
  }
  if (next === 'P' || next === 'X' || next === '^' || next === '_') {
    let i = index + 2;
    while (i < length) {
      if (text[i] === ESC && text[i + 1] === '\\') return i + 2;
      i += 1;
    }
    return -1;
  }
  // Charset selectors: ESC ( B, ESC ) 0, ESC * ... take one more byte.
  if (next === '(' || next === ')' || next === '*' || next === '+' || next === '-' || next === '.' || next === '/') {
    return index + 3 <= length ? index + 3 : -1;
  }
  // ESC =, ESC >, ESC 7, ESC 8, ESC M, ... are two bytes.
  return index + 2;
}

/** True for C0/C1 controls that should never reach the display. */
function isControl(char) {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * Remove ANSI/VT escape sequences from `text`, keeping printable characters
 * and the line-editing controls `\n`, `\r`, `\t`, `\b` (`applyBytes` interprets
 * those; `stripAnsi` keeps them so callers can). An unterminated sequence at
 * the end of the input (a chunk split mid-sequence) is dropped.
 */
export function stripAnsi(text) {
  if (typeof text !== 'string' || text === '') return '';
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === ESC || char === C1_CSI) {
      const end = escapeEnd(text, i);
      if (end < 0) break; // incomplete tail: drop
      i = end;
      continue;
    }
    if (isControl(char)) {
      if (char === '\n' || char === '\r' || char === '\t' || char === '\b') out += char;
      i += 1;
      continue;
    }
    const codePoint = text.codePointAt(i);
    const size = codePoint > 0xffff ? 2 : 1;
    out += size === 2 ? text.slice(i, i + 2) : char;
    i += size;
  }
  return out;
}

/** Create an empty console state. All options are bounded by hard defaults. */
export function createState(options = {}) {
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES;
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxLineChars =
    Number.isInteger(options.maxLineChars) && options.maxLineChars > 0 ? options.maxLineChars : DEFAULT_MAX_LINE_CHARS;
  const state = {
    /** Completed lines, oldest first. */
    lines: [],
    /** The line being edited, as code-point-sized strings. */
    current: [],
    /** Write position inside `current` (code-point index). */
    cursor: 0,
    /** UTF-8 bytes of the text applied so far (informational; the RPC owns cursors). */
    bytes: 0,
    /** True once scrollback or a line was cut. */
    truncated: false,
    /** Escape sequence carried across a chunk boundary. */
    pending: '',
    maxLines,
    maxBytes,
    maxLineChars,
    /** Bytes of `lines` plus their newlines, maintained incrementally. */
    storedBytes: 0,
  };
  return state;
}

/** Reset a state in place (Clear button / RPC `clear`). */
export function resetState(state) {
  state.lines.length = 0;
  state.current.length = 0;
  state.cursor = 0;
  state.bytes = 0;
  state.truncated = false;
  state.pending = '';
  state.storedBytes = 0;
  return state;
}

function utf8Length(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function commitLine(state) {
  const line = state.current.join('');
  const bytes = utf8Length(line);
  state.lines.push(line);
  state.storedBytes += bytes + 1;
  state.current.length = 0;
  state.cursor = 0;
  while (state.lines.length > state.maxLines || state.storedBytes > state.maxBytes) {
    const removed = state.lines.shift();
    state.storedBytes -= utf8Length(removed) + 1;
    state.truncated = true;
  }
}

function writeChar(state, char) {
  if (state.cursor < state.current.length) {
    state.current[state.cursor] = char;
  } else {
    state.current.push(char);
  }
  state.cursor += 1;
  if (state.current.length > state.maxLineChars) {
    const drop = state.current.length - state.maxLineChars;
    state.current.splice(0, drop);
    state.cursor = Math.max(0, state.cursor - drop);
    state.truncated = true;
  }
}

function writeTab(state) {
  const column = state.cursor;
  const spaces = TAB_WIDTH - (column % TAB_WIDTH);
  for (let i = 0; i < spaces; i += 1) writeChar(state, ' ');
}

/**
 * Apply a decoded console text chunk to `state`, in place, and return it.
 *
 * Handling mirrors a dumb terminal: `\n` commits the current line, `\r`
 * returns the write position to column 0 (so a progress line is overwritten
 * rather than appended), `\b` moves one cell left, `\t` pads to the next tab
 * stop, ANSI CSI/OSC/DCS sequences are consumed, and every other control byte
 * is dropped. Escape sequences split across chunks are carried in
 * `state.pending`. Scrollback stays bounded by `maxLines`/`maxBytes`; the
 * unfinished line is bounded by `maxLineChars`.
 */
export function applyBytes(state, chunk) {
  if (typeof chunk !== 'string' || chunk === '') return state;
  if (chunk === undefined || chunk === null) return state;
  state.bytes += utf8Length(chunk);
  let text = state.pending + chunk;
  state.pending = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === ESC || char === C1_CSI) {
      const end = escapeEnd(text, i);
      if (end < 0) {
        const tail = text.slice(i);
        if (tail.length <= DEFAULT_MAX_ESCAPE) state.pending = tail;
        else state.truncated = true;
        return state;
      }
      i = end;
      continue;
    }
    if (isControl(char)) {
      if (char === '\n') commitLine(state);
      else if (char === '\r') state.cursor = 0;
      else if (char === '\b') state.cursor = Math.max(0, state.cursor - 1);
      else if (char === '\t') writeTab(state);
      i += 1;
      continue;
    }
    const codePoint = text.codePointAt(i);
    const size = codePoint > 0xffff ? 2 : 1;
    writeChar(state, size === 2 ? text.slice(i, i + 2) : char);
    i += size;
  }
  return state;
}

/** Split one line into display lines of at most `width` cells. */
export function wrapLine(line, width) {
  if (!Number.isInteger(width) || width <= 0) return [line];
  if (line === '') return [''];
  const out = [];
  let current = '';
  let currentWidth = 0;
  for (const char of line) {
    const cellWidth = charWidth(char.codePointAt(0));
    if (currentWidth > 0 && currentWidth + cellWidth > width) {
      out.push(current);
      current = '';
      currentWidth = 0;
    }
    // A single character wider than the terminal still occupies one cell row.
    current += char;
    currentWidth += Math.min(cellWidth, width);
  }
  out.push(current);
  return out;
}

/** All lines, completed plus the unfinished one, without wrapping. */
export function lines(state) {
  const out = state.lines.slice();
  out.push(state.current.join(''));
  return out;
}

/**
 * The bottom `maxLines` display lines, wrapped to `width` cells when `width`
 * is positive. The oldest lines are dropped first, so new console output is
 * always visible at the bottom of the viewport.
 */
export function visibleLines(state, options = {}) {
  const width = Number.isInteger(options.width) ? options.width : 0;
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : state.maxLines;
  const all = lines(state);
  const tail = all.slice(-maxLines); // each raw line yields at least one display line
  const out = [];
  for (const line of tail) {
    if (width > 0 && displayWidth(line) > width) out.push(...wrapLine(line, width));
    else out.push(line);
  }
  return out.slice(-maxLines);
}

/** The text the panel renders: `visibleLines` joined with newlines. */
export function renderText(state, options = {}) {
  return visibleLines(state, options).join('\n');
}

/** Collapse trailing whitespace for a one-line status/preview string. */
export function singleLine(text, maxLength = 120) {
  const flat = stripAnsi(text).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(maxLength) || maxLength <= 0 || flat.length <= maxLength) return flat;
  return `${flat.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Normalise a view name: anything that is not `raw` is the reading view. */
export function normalizeView(view) {
  return view === 'raw' ? 'raw' : 'reading';
}

/**
 * Pick the text a console RPC `output` event contributes for a view. Events
 * carry `reading` only when the reading text differs from `text`; the reading
 * view falls back to `text` for ordinary device output.
 */
export function pickOutput(event, view) {
  if (!event || typeof event !== 'object') return '';
  if (normalizeView(view) === 'raw') return typeof event.text === 'string' ? event.text : '';
  if (typeof event.reading === 'string') return event.reading;
  return typeof event.text === 'string' ? event.text : '';
}

/**
 * Pick the byte cursor that goes with `pickOutput` for a view. The server
 * updates `bytes` for raw output and `readingBytes` for reading output; a
 * reading-only record carries just `readingBytes`.
 */
export function pickCursor(event, view) {
  if (!event || typeof event !== 'object') return undefined;
  if (normalizeView(view) === 'raw') return Number.isInteger(event.bytes) ? event.bytes : undefined;
  if (Number.isInteger(event.readingBytes)) return event.readingBytes;
  if (typeof event.reading === 'string') return Number.isInteger(event.bytes) ? event.bytes : undefined;
  return Number.isInteger(event.bytes) ? event.bytes : undefined;
}
