import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  applyBytes,
  createState,
  displayWidth,
  lines,
  normalizeView,
  pickCursor,
  pickOutput,
  renderText,
  resetState,
  singleLine,
  stripAnsi,
  visibleLines,
  wrapLine,
} from '../src/tui/render.js';

/** Feed a list of chunks into a fresh state. */
function feed(chunks, options) {
  const state = createState(options);
  for (const chunk of chunks) applyBytes(state, chunk);
  return state;
}

/* ------------------------------------------------------------------ stripAnsi */

test('stripAnsi removes CSI colour and cursor sequences', () => {
  assert.equal(stripAnsi('\x1b[1;32mREADY\x1b[0m'), 'READY');
  assert.equal(stripAnsi('a\x1b[2Kb\x1b[1;1Hc'), 'abc');
  assert.equal(stripAnsi('\x1b[?25lhidden\x1b[?25h'), 'hidden');
});

test('stripAnsi removes OSC titles with both terminators', () => {
  assert.equal(stripAnsi('\x1b]0;window title\x07visible'), 'visible');
  assert.equal(stripAnsi('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'), 'link');
});

test('stripAnsi removes DCS, charset selectors and two-byte escapes', () => {
  assert.equal(stripAnsi('\x1bP1;2|payload\x1b\\after'), 'after');
  assert.equal(stripAnsi('\x1b(0\x1b(Btext'), 'text');
  assert.equal(stripAnsi('\x1b=\x1b>text'), 'text');
});

test('stripAnsi handles the 8-bit CSI form', () => {
  assert.equal(stripAnsi('\u009b31mred'), 'red');
});

test('stripAnsi keeps line-editing controls and drops other controls', () => {
  assert.equal(stripAnsi('a\nb\rc\td\be'), 'a\nb\rc\td\be');
  assert.equal(stripAnsi('a\x00b\x07c\x7fd'), 'abcd');
});

test('stripAnsi drops an unterminated escape sequence at the end', () => {
  // A chunk split mid-sequence cannot be drawn; the next chunk is a new call.
  assert.equal(stripAnsi('hello\x1b[31'), 'hello');
  assert.equal(stripAnsi('hello\x1b]0;title'), 'hello');
  assert.equal(stripAnsi('\x1b'), '');
});

/* ------------------------------------------------------------------ applyBytes */

test('applyBytes accumulates printable text into the current line', () => {
  const state = feed(['hel', 'lo']);
  assert.deepEqual(lines(state), ['hello']);
  assert.equal(state.bytes, 5);
});

test('applyBytes commits lines on LF and keeps the trailing empty line', () => {
  const state = feed(['one\ntwo\n']);
  assert.deepEqual(lines(state), ['one', 'two', '']);
});

test('applyBytes treats CRLF as one line ending', () => {
  const state = feed(['one\r\ntwo']);
  assert.deepEqual(lines(state), ['one', 'two']);
});

test('applyBytes overwrites the line after CR instead of appending', () => {
  const state = feed(['10%\r20%\r30%', '\ndone']);
  assert.deepEqual(lines(state), ['30%', 'done']);
});

test('applyBytes keeps trailing characters when CR overwrite is shorter', () => {
  const state = feed(['progress 100%\r50%']);
  // The cursor returns to column 0 and the new text overwrites the prefix.
  assert.deepEqual(lines(state), ['50%gress 100%']);
});

test('applyBytes applies backspace', () => {
  const state = feed(['abc\bX']);
  assert.deepEqual(lines(state), ['abX']);
  // Backspace at column 0 is ignored.
  const start = feed(['\bX']);
  assert.deepEqual(lines(start), ['X']);
  assert.equal(start.cursor, 1);
});

test('applyBytes strips ANSI sequences inside the stream', () => {
  const state = feed(['\x1b[1;32mOK\x1b[0m\ndone']);
  assert.deepEqual(lines(state), ['OK', 'done']);
});

test('applyBytes carries an escape sequence split across chunks', () => {
  const state = feed(['\x1b[3', '1mhello']);
  assert.deepEqual(lines(state), ['hello']);
  assert.equal(state.pending, '');
});

test('applyBytes carries an OSC sequence split across chunks', () => {
  const state = feed(['\x1b]0;tit', 'le\x07ok']);
  assert.deepEqual(lines(state), ['ok']);
  assert.equal(state.pending, '');
});

test('applyBytes pads tabs to the next 8-column stop', () => {
  const state = feed(['a\tb']);
  assert.deepEqual(lines(state), ['a       b']);
});

test('applyBytes counts UTF-8 bytes, not code units', () => {
  const state = feed(['é', '中']);
  assert.equal(state.bytes, 5); // 2 + 3
  assert.deepEqual(lines(state), ['é中']);
});

test('applyBytes ignores empty and non-string chunks', () => {
  const state = createState();
  assert.equal(applyBytes(state, ''), state);
  assert.equal(applyBytes(state, undefined), state);
  assert.deepEqual(lines(state), ['']);
});

/* ------------------------------------------------------------------ scrollback bounds */

test('scrollback defaults match the documented bounds', () => {
  assert.equal(DEFAULT_MAX_LINES, 2000);
  assert.equal(DEFAULT_MAX_BYTES, 64 * 1024);
  assert.equal(createState().maxLines, 2000);
  assert.equal(createState().maxBytes, 64 * 1024);
});

test('scrollback drops the oldest lines past maxLines', () => {
  const state = createState({ maxLines: 3 });
  applyBytes(state, '1\n2\n3\n4\n5\n');
  assert.deepEqual(state.lines, ['3', '4', '5']);
  assert.equal(state.truncated, true);
  assert.deepEqual(lines(state), ['3', '4', '5', '']);
});

test('scrollback drops the oldest lines past maxBytes', () => {
  const state = createState({ maxBytes: 8 });
  applyBytes(state, 'aaaa\nbbbb\ncccc\n');
  // Each "aaaa\n" is 5 bytes; only the newest line survives an 8-byte budget.
  assert.deepEqual(state.lines, ['cccc']);
  assert.equal(state.truncated, true);
});

test('an unfinished line is bounded by maxLineChars', () => {
  const state = createState({ maxLineChars: 10 });
  applyBytes(state, '0123456789abcdef');
  assert.deepEqual(lines(state), ['6789abcdef']);
  assert.equal(state.truncated, true);
});

test('resetState clears text and counters', () => {
  const state = feed(['one\ntwo', '\x1b[3']);
  resetState(state);
  assert.deepEqual(lines(state), ['']);
  assert.equal(state.bytes, 0);
  assert.equal(state.truncated, false);
  assert.equal(state.storedBytes, 0);
  assert.equal(state.pending, '');
});

/* ------------------------------------------------------------------ wrapping / width */

test('displayWidth counts wide CJK cells', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('a中b'), 4);
});

test('wrapLine splits on cell width and keeps wide characters whole', () => {
  assert.deepEqual(wrapLine('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(wrapLine('中文中文', 4), ['中文', '中文']);
  assert.deepEqual(wrapLine('abc', 3), ['abc']);
  assert.deepEqual(wrapLine('', 3), ['']);
});

test('wrapLine without a width returns the line unchanged', () => {
  assert.deepEqual(wrapLine('a'.repeat(200), 0), ['a'.repeat(200)]);
  assert.deepEqual(wrapLine('a'.repeat(200)), ['a'.repeat(200)]);
});

test('visibleLines wraps and anchors the bottom of the viewport', () => {
  const state = feed(['abcdef\n123456\n']);
  assert.deepEqual(visibleLines(state, { width: 3 }), ['abc', 'def', '123', '456', '']);
  assert.deepEqual(visibleLines(state, { width: 3, maxLines: 3 }), ['123', '456', '']);
  // No width means no wrapping.
  assert.deepEqual(visibleLines(state), ['abcdef', '123456', '']);
});

test('visibleLines caps by default scrollback bounds', () => {
  const state = createState({ maxLines: 2 });
  applyBytes(state, 'a\nb\nc\n');
  // The viewport is anchored to the bottom: the newest two display lines.
  assert.deepEqual(lines(state), ['b', 'c', '']);
  assert.deepEqual(visibleLines(state), ['c', '']);
});

test('renderText joins the visible window with newlines', () => {
  const state = feed(['alpha\nbeta']);
  assert.equal(renderText(state), 'alpha\nbeta');
  // Wrapped to 3 cells the text is alp/ha/bet/a; a 2-line viewport is bottom-anchored.
  assert.equal(renderText(state, { width: 3, maxLines: 2 }), 'bet\na');
});

/* ------------------------------------------------------------------ view selection */

test('normalizeView defaults to the reading view', () => {
  assert.equal(normalizeView('raw'), 'raw');
  assert.equal(normalizeView('reading'), 'reading');
  assert.equal(normalizeView(undefined), 'reading');
  assert.equal(normalizeView('other'), 'reading');
});

test('pickOutput shows raw or reading text for the same event', () => {
  const event = { text: 'LINKR_RC_abc:0\r\n', reading: '[Agent] exit=0\n', bytes: 20, readingBytes: 15 };
  assert.equal(pickOutput(event, 'raw'), 'LINKR_RC_abc:0\r\n');
  assert.equal(pickOutput(event, 'reading'), '[Agent] exit=0\n');
  // No reading override: reading view falls back to the raw text.
  assert.equal(pickOutput({ text: 'plain' }, 'reading'), 'plain');
  assert.equal(pickOutput(null, 'raw'), '');
});

test('pickCursor uses the raw or reading byte counter', () => {
  const event = { text: 'x', reading: 'y', bytes: 10, readingBytes: 4 };
  assert.equal(pickCursor(event, 'raw'), 10);
  assert.equal(pickCursor(event, 'reading'), 4);
  // A reading-only record carries no raw text; its reading cursor still wins.
  assert.equal(pickCursor({ text: '', reading: 'held', bytes: 12, readingBytes: 9 }, 'reading'), 9);
  assert.equal(pickCursor({ text: '' }, 'raw'), undefined);
  assert.equal(pickCursor(undefined, 'raw'), undefined);
});

/* ------------------------------------------------------------------ singleLine */

test('singleLine flattens control sequences and truncates', () => {
  assert.equal(singleLine('\x1b[31mline one\x1b[0m\r\nsecond'), 'line one second');
  assert.equal(singleLine('abcdef', 4), 'abc…');
  assert.equal(singleLine('abc', 10), 'abc');
});
