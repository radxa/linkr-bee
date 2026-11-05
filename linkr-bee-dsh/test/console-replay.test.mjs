import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// This client is a self-contained Harness bundle, not an ES module. Execute
// its actual cursor and stream effect without mocking their decisions.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const cursorStart = source.indexOf('    function createConsoleCursor(');
assert.ok(cursorStart >= 0);
const cursorCode = source.slice(cursorStart, source.indexOf('\n    }\n', cursorStart) + 6);
const createCursor = vm.runInNewContext(`${cursorCode}; createConsoleCursor`);
const effectStart = source.indexOf('      useEffect(() => {',
  source.indexOf('// The console stream, and with it the panel\'s memory of the screen.'));
const effectEnd = source.indexOf('      }, [appendEvent, clearScreen]);', effectStart);
assert.ok(effectStart >= 0 && effectEnd > effectStart);
const effectCode = source.slice(effectStart, effectEnd + '      }, [appendEvent, clearScreen]);'.length);

function fixture(state = { text: '', at: 0, epoch: null, seq: 0 }, cursor = createCursor(state)) {
  const sources = [], timers = new Map(), drawn = [];
  let cleanup, rendered = '', nextTimer = 0, resets = 0;
  const clearScreen = ({ reset = false } = {}) => {
    state.text = '';
    state.views = { raw: '', reading: '' };
    rendered = '';
    if (reset) resets++;
  };
  class EventSource {
    constructor() { sources.push(this); }
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    screen: state, consoleCursor: cursor, clearScreen, logViewRef: {current: state.view || 'reading'}, SCREEN_KEEP: 96 * 1024,
    appendEvent: record => { drawn.push(record); const reading = record.reading ?? record.text ?? ''; const text = context.logViewRef.current === 'raw' ? (record.text || '') : reading; context.rememberScreen(text, record.ts, {raw:record.text || '',reading}); rendered += text; },
    termApi: { current: { reset() { rendered = ''; }, write(text, done) { if (text.startsWith('\u001bc')) { rendered = ''; text = text.slice(2); } rendered += text; done?.(); } } },
    dirtyRef: { current: false }, linesRef: { current: [] },
    setDrew() {}, setLink() {}, setSession() {}, setLive() {}, setEverLive() {},
    STREAM_URL: '/linkr-bee/console/stream', EventSource,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    useEffect: callback => { cleanup = callback(); },
    useCallback: callback => callback,
    replaying: {current:false}, replayRevision: {current:0}, streamBuf: {current:''},
    setLogView() {}, localStorage: {setItem() {}},
    fetch() { throw new Error('switching views must not fetch a snapshot'); },
  });
  vm.runInContext(source.slice(source.indexOf('    function rememberScreen('), source.indexOf('    /** One console record as the bytes')), context);
  vm.runInContext(effectCode, context);
  const switchStart = source.indexOf('      const switchView = useCallback(');
  const switchEnd = source.indexOf('\n      }, []);', switchStart) + '\n      }, []);'.length;
  const switchView = vm.runInContext(source.slice(switchStart, switchEnd) + ';switchView', context);
  return {
    switchView, context,
    state, cursor, sources, drawn, timers,
    get rendered() { return rendered; }, get resets() { return resets; },
    emit: record => sources.at(-1).onmessage({ data: JSON.stringify(record) }),
    reconnect() {
      sources.at(-1).onerror();
      const [id, callback] = timers.entries().next().value;
      timers.delete(id); callback();
    },
    expireSeed() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id); callback();
    },
    unmount: () => cleanup(),
  };
}
const event = (seq, text, epoch = 'host-a') => ({ type: 'stream', epoch, seq, ts: 100, text });
const snapshot = (seq, text, epoch = 'host-a', firstSeq = 1) => ({ type: 'snapshot', epoch, seq, text, firstSeq });

test('same-millisecond events remain distinct and replayed sequences are ignored', () => {
  const f = fixture();
  f.emit(snapshot(2, 'AB'));
  f.emit(event(1, 'A')); f.emit(event(2, 'B')); f.emit(event(3, 'C'));
  assert.equal(f.rendered, 'ABC');
  f.reconnect();
  f.emit(snapshot(3, 'ABC'));
  for (let seq = 1; seq <= 3; seq++) f.emit(event(seq, 'duplicate'));
  f.emit(event(4, 'D'));
  assert.equal(f.rendered, 'ABCD');
  assert.deepEqual(f.drawn.map(record => record.seq), [3, 4]);
  f.unmount();
});

test('a remount retains its cursor without replaying the previous screen', () => {
  const first = fixture();
  first.emit(snapshot(1, 'A')); first.emit(event(2, 'B')); first.unmount();
  const second = fixture(first.state, first.cursor);
  second.emit(snapshot(2, 'AB')); second.emit(event(1, 'A')); second.emit(event(2, 'B'));
  second.emit(event(3, 'C'));
  assert.equal(second.rendered, 'ABC');
  assert.deepEqual(second.drawn.map(record => record.seq), [3]);
  second.unmount();
});

test('ordered clear survives reconnect and a delayed panel clear cannot erase newer output', () => {
  const f = fixture();
  f.emit(snapshot(1, 'old')); f.emit({ type: 'clear', epoch: 'host-a', seq: 2 });
  f.emit(event(3, 'new'));
  assert.equal(f.cursor.accept({ epoch: 'host-a', seq: 2 }).accepted, false);
  f.reconnect(); f.emit(snapshot(3, 'new'));
  f.emit(event(1, 'old')); f.emit({ type: 'clear', epoch: 'host-a', seq: 2 }); f.emit(event(3, 'new'));
  assert.equal(f.rendered, 'new');
  f.unmount();
});

test('a cleared screen can remount from a snapshot without restoring the old backlog', () => {
  const first = fixture();
  first.emit(snapshot(1, 'old')); first.emit({ type: 'clear', epoch: 'host-a', seq: 2 }); first.unmount();
  const second = fixture(first.state, first.cursor);
  second.emit(snapshot(2, '')); second.emit(event(1, 'old'));
  second.emit({ type: 'clear', epoch: 'host-a', seq: 2 }); second.emit(event(3, 'new'));
  assert.equal(second.rendered, 'new'); second.unmount();
});

test('a Host restart resets sequence and view; old-epoch callbacks cannot resurrect output', () => {
  const f = fixture();
  f.emit(snapshot(200, 'old host'));
  f.reconnect(); f.emit(snapshot(1, 'new host', 'host-b'));
  f.emit(event(201, 'stale', 'host-a')); f.emit(snapshot(201, 'stale', 'host-a'));
  f.emit(event(2, '!', 'host-b'));
  assert.equal(f.rendered, 'new host!'); assert.equal(f.resets, 1);
  assert.equal(f.state.seq, 2); f.unmount();
});

test('legacy Hosts without snapshot frames drain once after the seed deadline', () => {
  const f = fixture();
  f.emit({ type: 'stream', seq: 1, text: 'A' });
  assert.equal(f.rendered, ''); f.expireSeed(); assert.equal(f.rendered, 'A');
  f.reconnect(); f.emit({ type: 'stream', seq: 1, text: 'A' });
  f.emit({ type: 'stream', seq: 2, text: 'B' });
  assert.equal(f.rendered, 'AB'); f.unmount();
});

test('an empty ring snapshot completes seeding and cleanup retires its timer/source', () => {
  const f = fixture(); f.emit(snapshot(0, ''));
  assert.equal(f.timers.size, 0); f.emit(event(1, 'first')); assert.equal(f.rendered, 'first');
  f.unmount(); assert.ok(f.sources.at(-1).closed); assert.equal(f.timers.size, 0);
  const pending = fixture(); pending.unmount(); assert.equal(pending.timers.size, 0);
});

test('reconnect repairs a backlog gap using the complete retained ring snapshot', () => {
  const f = fixture(); f.emit(snapshot(1, 'x'));
  f.reconnect(); f.emit(snapshot(1000, 'x'.repeat(1000), 'host-a', 601));
  for (let seq = 601; seq <= 1000; seq++) f.emit(event(seq, 'x'));
  assert.equal(f.rendered, 'x'.repeat(1000)); assert.equal(f.resets, 1);
  f.unmount();
});

test('late callbacks from a superseded or closed source cannot replace the active Host', () => {
  const f = fixture(); f.expireSeed();
  const staleMessage = f.sources[0].onmessage, staleError = f.sources[0].onerror;
  f.reconnect(); f.emit(snapshot(1, 'NEW', 'host-b'));
  staleMessage({ data: JSON.stringify(snapshot(1000, 'OLD', 'unseen-host-a')) }); staleError();
  assert.equal(f.rendered, 'NEW'); assert.equal(f.state.epoch, 'host-b');
  assert.notEqual(f.sources.at(-1).closed, true);
  assert.equal(f.cursor.accept({ epoch: 'unseen-host-a', seq: 1001 }).accepted, false,
    'a delayed old HTTP/panel clear cannot change epochs either');
  const lateMessage = f.sources.at(-1).onmessage;
  f.unmount(); lateMessage({ data: JSON.stringify(event(2, 'late', 'host-b')) });
  assert.equal(f.rendered, 'NEW');
});

test('late panel-channel callbacks neither execute actions nor detach a replacement source', () => {
  const start = source.indexOf('        ctx.effect(() => {',
    source.indexOf('// The control channel: one EventSource for the plugin\'s whole lifetime,'));
  const end = source.indexOf("        }, 'linkr-bee: panel channel');", start);
  assert.ok(start >= 0 && end > start);
  const code = source.slice(start, end + "        }, 'linkr-bee: panel channel');".length);
  const sources = [], timers = new Map(), actions = [];
  let cleanup, next = 0;
  class EventSource { constructor() { sources.push(this); } close() { this.closed = true; } }
  vm.runInNewContext(code, {
    EventSource, PANEL_URL: '/panel/stream', ctx: { effect: callback => { cleanup = callback(); } },
    dispatchPanel: action => actions.push(action),
    setTimeout: callback => { const id = ++next; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const staleMessage = sources[0].onmessage, staleError = sources[0].onerror;
  staleError(); const [id, callback] = timers.entries().next().value; timers.delete(id); callback();
  staleMessage({ data: JSON.stringify({ type: 'panel', action: 'open' }) }); staleError();
  assert.deepEqual(actions, []); assert.notEqual(sources[1].closed, true);
  sources[1].onmessage({ data: JSON.stringify({ type: 'panel', action: 'focus' }) });
  const lateMessage = sources[1].onmessage;
  cleanup(); lateMessage({ data: JSON.stringify({ type: 'panel', action: 'open' }) });
  assert.deepEqual(actions, ['focus']); assert.equal(timers.size, 0);
});

test('view switching repaints both local histories without losing or repeating live output', () => {
  const f = fixture();
  f.emit({...snapshot(1, 'RAW_OLD'), reading:'READ_OLD'});
  f.emit({...event(2, 'RAW_NEW'),reading:'READ_NEW'});
  assert.equal(f.rendered, 'READ_OLDREAD_NEW');
  f.switchView('raw');
  assert.equal(f.rendered, 'RAW_OLDRAW_NEW');
  f.emit({...event(3, 'RAW_LAST'),reading:'READ_LAST'});
  assert.equal(f.rendered, 'RAW_OLDRAW_NEWRAW_LAST');
  f.switchView('reading');f.switchView('raw');f.switchView('reading');
  assert.equal(f.rendered, 'READ_OLDREAD_NEWREAD_LAST');
  assert.equal(f.state.seq, 3);
  assert.equal(f.context.replaying.current, false);
  f.unmount();
});

test('hidden raw records and reading-only flushes survive switching and clear in both views', () => {
  const f = fixture();
  f.emit({...snapshot(0,''),reading:''});
  f.emit({...event(1, 'hidden'),reading:''});
  f.emit({...event(2, ''),reading:'flushed'});
  assert.equal(f.rendered, 'flushed');
  f.switchView('raw');assert.equal(f.rendered, 'hidden');
  f.emit({type:'clear',epoch:'host-a',seq:3});
  f.switchView('reading');assert.equal(f.rendered, '');
  f.switchView('raw');assert.equal(f.rendered, '');
  f.unmount();
});

test('plain-renderer fallback never removes device markers or shell-looking output', () => {
  const start=source.indexOf('    function cleanExecText(');
  const end=source.indexOf('    /* ---------------- Terminal',start);
  const clean=vm.runInNewContext(source.slice(start,end)+';({exec:cleanExecText,stream:cleanStreamText})');
  const text="sh -c 'user command'\nLINKR_RC_0123456789abcdef0123456789abcdef:7\n";
  assert.equal(clean.exec(text),text);
  assert.equal(clean.stream(text),text);
});
