import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const vendorStart = source.indexOf('    var __commonJSMin');
const vendorEnd = source.indexOf('    const XTERM_TAG', vendorStart);
assert.ok(vendorStart >= 0 && vendorEnd > vendorStart);
// Use the shipped xterm parser and asynchronous write buffer without opening
// its DOM renderer. Browser checks separately exercise keyboard/paste handling.
const Terminal = vm.runInNewContext(source.slice(vendorStart, vendorEnd) + ';require_xterm().Terminal', {
  console, setTimeout, clearTimeout, queueMicrotask, TextDecoder, TextEncoder, performance,
  window: {}, document: { queryCommandSupported: () => false },
  navigator: { userAgent: 'node', platform: 'MacIntel', language: 'en-US' },
});
const apiStart = source.indexOf('        clear() {', source.indexOf('    function mountTerminal('));
const apiEnd = source.indexOf('\n        focus,', apiStart);
const clearStart = source.indexOf('      const clearScreen = useCallback(');
const clearEnd = source.indexOf('\n      }, []);', clearStart) + '\n      }, []);'.length;
assert.ok(apiStart >= 0 && apiEnd > apiStart && clearStart >= 0 && clearEnd > clearStart);

function fixture(t) {
  const terminal = new Terminal({ cols: 40, rows: 6, scrollback: 100 });
  t.after(() => terminal.dispose());
  const api = vm.runInNewContext('({' + source.slice(apiStart, apiEnd) + '})', { terminal });
  const history = { text: 'old history', raw: 'old history', reading: 'old history' };
  const context = {
    termApi: { current: api }, linesRef: { current: ['old line'] }, streamBuf: { current: 'pending line' },
    dirtyRef: { current: false }, lastTs: { current: 123 }, useCallback: callback => callback,
    forgetScreen() { history.text = history.raw = history.reading = ''; }, setDrew() {},
  };
  const clear = vm.runInNewContext(source.slice(clearStart, clearEnd) + ';clearScreen', context);
  const write = text => new Promise(resolve => terminal.write(text, resolve));
  const text = () => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) || '').join('\n');
  };
  const modes = () => JSON.parse(JSON.stringify(terminal.modes));
  return { terminal, api, history, context, clear, write, text, modes };
}

for (const alternate of [false, true]) {
  test(`clear preserves negotiated modes and the ${alternate ? 'alternate' : 'normal'} buffer`, async t => {
    const f = fixture(t);
    await f.write((alternate ? '\x1b[?1049h' : '') +
      '\x1b[?1h\x1b=\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[4h\x1b[?7l\x1b[31mPROMPT');
    const modes = f.modes(), type = f.terminal.buffer.active.type;
    const foreground = f.terminal.buffer.active.getLine(0).getCell(0).getFgColor();
    f.clear(); await f.write('');
    assert.equal(f.text().trim(), '');
    assert.deepEqual(f.modes(), modes);
    assert.equal(f.terminal.buffer.active.type, type);
    assert.equal(f.history.text, '');
    await f.write('NEXT');
    assert.equal(f.terminal.buffer.active.getLine(0).getCell(0).getFgColor(), foreground);
  });
}

test('clear removes the current prompt and scrollback, ordered after earlier queued writes', async t => {
  const f = fixture(t);
  await f.write('old scrollback\r\n'.repeat(15) + 'prompt> ');
  assert.ok(f.terminal.buffer.active.baseY > 0);
  f.terminal.write('BEFORE_CLEAR_QUEUED');
  f.clear(); await f.write('');
  assert.equal(f.text().trim(), '');
  assert.equal(f.terminal.buffer.active.baseY, 0);
  assert.equal(f.terminal.buffer.active.length, f.terminal.rows);
  assert.equal(f.history.text, '');
  await f.write('ONLY_AFTER_CLEAR');
  assert.equal(f.text().trim(), 'ONLY_AFTER_CLEAR');
});

for (const unfinished of ['\x1b[', '\x1b]2;unfinished', '\x1bP1;unfinished']) {
  test(`an unfinished ${JSON.stringify(unfinished)} cannot swallow a clear or later output`, async t => {
    const f = fixture(t);
    await f.write('\x1b[?1h\x1b[?2004hPROMPT');
    const modes = f.modes();
    f.terminal.write(unfinished);
    f.clear();
    await f.write('VISIBLE_AFTER_CLEAR');
    assert.equal(f.text().trim(), 'VISIBLE_AFTER_CLEAR');
    assert.deepEqual(f.modes(), modes);
  });
}

test('an explicit host reset is also ordered, then restores default terminal modes', async t => {
  const f = fixture(t);
  await f.write('\x1b[?1h\x1b[?2004h\x1b[?1049hOLD_HOST');
  f.terminal.write('QUEUED_OLD_HOST');
  f.clear({ reset: true });
  await f.write('NEW_HOST');
  assert.equal(f.text().trim(), 'NEW_HOST');
  assert.equal(f.modes().applicationCursorKeysMode, false);
  assert.equal(f.modes().bracketedPasteMode, false);
  assert.equal(f.terminal.buffer.active.type, 'normal');
});

test('clear preserves origin mode and scroll margins without sending terminal replies', async t => {
  const f = fixture(t), replies = [];
  f.terminal.onData(data => replies.push(data));
  await f.write('\x1b[2;5r\x1b[?6hPROMPT');
  const modes = f.modes();
  assert.equal(modes.originMode, true);
  f.clear(); await f.write('');
  assert.equal(f.text().trim(), '');
  assert.deepEqual(f.modes(), modes);
  assert.equal(f.terminal.buffer.active.cursorY, 1);
  await f.write('\n'.repeat(10));
  assert.equal(f.terminal.buffer.active.cursorY, 4);
  assert.deepEqual(replies, []);
});
