import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { READ_INPUT_SCHEMA } from '../src/rpc-schema.js';

// Run the production handlers without requiring a native OpenCode window.
// Only the host's terminal, signal and RPC boundaries are faked.
function handlers(path, names, boundary) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const functions = names.map((name) => {
    const marker = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(marker, `${name} exists in ${path}`);
    const end = source.indexOf('\n  }', marker.index);
    return source.slice(marker.index, end + 4);
  }).join('\n');
  const context = vm.createContext(boundary);
  vm.runInContext(stripTypeScriptTypes(functions), context);
  return context;
}

for (const kind of ['desktop', 'browser']) {
  function panel({ log = false, initializing = false, read } = {}) {
    const logs = [], writes = [], requests = [];
    let view = log ? 'log' : 'reading';
    const readResult = async (input) => {
      requests.push(input);
      return read ? read(input) : { epoch: 'new', bytes: 4, text: 'UART' };
    };
    const boundary = {
      epoch: 'old', readRevision: 0, initializing, pending: [], disposed: false,
      cursor: { reading: 0, raw: 0 },
      term: { write: (text) => writes.push(text) },
      terminal: { terminal: { write: (text) => writes.push(text) }, clear() {} },
      clearTerminal() {}, clearTransientError() {},
      say: (text) => logs.push(text), addLog: (text) => logs.push(text),
      ctx: { t: (text) => text }, setPhase() {}, setError() {}, handleError(error) { throw error; },
      rpc: { read: readResult }, client: { read: (view) => readResult({ view }) },
      view: kind === 'desktop' ? () => view : view,
    };
    const file = kind === 'desktop' ? '../src/gui/console.tsx' : '../src/web/main.ts';
    const reload = kind === 'desktop' ? 'resync' : 'reloadView';
    const context = handlers(file, ['applyOutput', reload], boundary);
    return { context, logs, writes, requests, reload: () => context[reload](true),
      setView(next) { view = next; if (kind === 'browser') context.view = next; } };
  }

  test(`${kind}: Log accepts notices across epochs without reading UART rings`, async () => {
    const p = panel({ log: true });
    p.context.applyOutput({ kind: 'meta', epoch: 'new', text: 'first notice' });
    p.context.applyOutput({ kind: 'data', epoch: 'new', text: 'hidden UART', bytes: 11 });
    p.context.applyOutput({ kind: 'meta', epoch: 'newer', text: 'second notice' });
    assert.deepEqual(p.logs, ['first notice', 'second notice']);
    assert.deepEqual(p.requests, []);
    assert.deepEqual(p.writes, []);
    p.setView('raw');
    await p.reload();
    assert.equal(p.requests[0].view, 'raw');
    assert.equal(p.context.cursor.raw, 4);
    assert.deepEqual(p.writes, ['UART']);
  });

  test(`${kind}: startup notices are independent of pending UART snapshots`, () => {
    const p = panel({ initializing: true });
    p.context.applyOutput({ kind: 'meta', epoch: 'new', text: 'connecting' });
    assert.deepEqual(p.logs, ['connecting']);
    assert.equal(p.context.pending.length, 0);
    assert.deepEqual(p.writes, []);
  });

  test(`${kind}: switching to Log retires an outstanding UART snapshot`, async () => {
    let resolve;
    const p = panel({ read: () => new Promise((done) => { resolve = done; }) });
    const pending = p.reload();
    p.setView('log');
    await p.reload();
    resolve({ epoch: 'late', bytes: 5, text: 'STALE' });
    await pending;
    assert.equal(p.requests.length, 1);
    assert.deepEqual(p.writes, []);
    assert.equal(p.context.epoch, 'old');
    assert.equal(p.context.cursor.reading, 0);
  });
}

function tui({ read } = {}) {
  let view = 'log';
  const requests = [], logs = [], drawn = [];
  const boundary = {
    view: () => view, reloadToken: 0, epoch: 'old', disposed: false,
    cursors: { reading: 0, raw: 0 }, term: null, consoleState: {},
    async call(_name, work) {
      return work({ async read(input) {
        requests.push(input);
        assert.ok(READ_INPUT_SCHEMA.properties.view.enum.includes(input.view), 'RPC read view is valid');
        return read ? read(input) : { epoch: 'new', text: 'UART', bytes: 4 };
      } });
    },
    addLog: (text) => logs.push(text), singleLine: (text) => text,
    applyBytes: (_state, text) => drawn.push(text), resetState() {},
    setCursorBytes() {}, bump() {}, mark() {},
    setCursor(value, wanted) { boundary.cursors[wanted] = value; },
  };
  return { context: handlers('../src/tui.tsx', ['backfill', 'onOutput'], boundary), requests, logs, drawn,
    setView(next) { view = next; } };
}

test('TUI: mounting and restoring Log never call the two-view read RPC', async () => {
  const p = tui();
  await p.context.backfill('mount');
  await p.context.backfill('view');
  p.context.onOutput({ kind: 'meta', epoch: 'new', text: 'notice' });
  p.context.onOutput({ kind: 'data', epoch: 'new', text: 'hidden', bytes: 6 });
  assert.deepEqual(p.requests, []);
  assert.deepEqual(p.logs, ['notice']);
  for (const view of ['reading', 'raw']) {
    p.setView(view);
    await p.context.backfill('view');
    assert.equal(p.requests.at(-1).view, view);
  }
  assert.deepEqual(p.drawn, ['UART', 'UART']);
});

test('TUI: entering Log cancels an outstanding reading backfill', async () => {
  let resolve;
  const p = tui({ read: () => new Promise((done) => { resolve = done; }) });
  p.setView('reading');
  const pending = p.context.backfill('view');
  p.setView('log');
  await p.context.backfill('view');
  resolve({ epoch: 'late', bytes: 5, text: 'STALE' });
  await pending;
  assert.deepEqual(p.drawn, []);
  assert.equal(p.context.epoch, 'old');
  assert.equal(p.requests.length, 1);
});
