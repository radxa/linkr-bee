import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteHistory, createSerialPresentation } from '../../web/serial_presentation.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const token = 'LINKR_EXIT_' + 'a'.repeat(32);
const record = { completionToken: token, command: 'printf "设备 ready\\n"', payload: `sh -c 'printf "设备 ready\\n"'; printf '\\n%s:%s\\n' '${token}' "$?"\r`, sessionId: 1 };
function stream(filter, text, size = 1) {
  const bytes = encoder.encode(text), chunks = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(filter.push(bytes.subarray(offset, offset + size)));
  chunks.push(filter.flush());
  return decoder.decode(Buffer.concat(chunks));
}

for (const ending of ['\r', '\n', '\r\n']) {
  test(`exact registered echo works with ${JSON.stringify(ending)} and split UTF-8`, () => {
    for (const size of [1, 2, 7, 20, 244, 1000]) {
      const filter = createSerialPresentation(); filter.register(record);
      const raw = record.payload.replace(/\r$/, ending) + '\r\n设备 ready\r\n' + token + ':0\r\nroot@bee:~# ';
      assert.equal(stream(filter, raw, size), record.command + ending + '\r\n设备 ready\r\n[Agent] exit=0\r\nroot@bee:~# ');
      filter.reset();
    }
  });
}

test('only complete known marker lines with valid exit status are replaced', () => {
  for (const code of [0, 1, 127, 255]) {
    const filter = createSerialPresentation(); filter.register(record);
    assert.equal(stream(filter, `\n${token}:${code}\n`), `\n[Agent] exit=${code}\r\n`);
    // An already consumed token is ordinary log text.
    assert.equal(stream(filter, `${token}:${code}\n`), `${token}:${code}\n`);
  }
});

test('unknown, embedded, malformed and incomplete tokens fail open', () => {
  const samples = ['LINKR_TOOL:hello\r\n', `prefix ${token}:0\n`, `${token}:256\n`, `${token}:1000\n`, `${token}:-1\n`, `${token}:0 trailing\n`, `${token}:0`, `${token.slice(0, 20)}`, 'LINKR_EXIT_' + 'b'.repeat(32) + ':0\n'];
  for (const sample of samples) {
    const filter = createSerialPresentation(); filter.register(record);
    assert.equal(stream(filter, sample), sample);
  }
});

test('mismatched or terminal-redrawn echo is preserved byte-for-byte', () => {
  for (const raw of [record.payload.replace('sh -c', 'sh \x1b[K-c'), record.payload.replace('printf', 'printX'), 'sh -c truncated', 'unrelated output\r\n' + record.payload]) {
    const filter = createSerialPresentation(); filter.register(record);
    assert.equal(stream(filter, raw), raw);
  }
});

test('idle timeout emits incomplete bytes and a new operation flushes older prefix', async () => {
  const output = [], filter = createSerialPresentation({ idleMs: 10, onIdle: bytes => output.push(decoder.decode(bytes)) });
  filter.register(record); assert.equal(filter.push(encoder.encode('sh -')).length, 0);
  filter.push(new Uint8Array()); // An empty notification must not cancel expiry.
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(output, ['sh -']); assert.equal(filter.pendingBytes, 0);
  filter.register({ ...record, completionToken: 'LINKR_EXIT_' + 'b'.repeat(32) });
  filter.push(encoder.encode('sh -'));
  filter.register({ ...record, completionToken: 'LINKR_EXIT_' + 'c'.repeat(32) });
  assert.deepEqual(output, ['sh -', 'sh -']); filter.reset();
});

test('reset discards registrations and bounded registrations evict oldest token', () => {
  const filter = createSerialPresentation({ maxRecords: 2 });
  const tokens = ['1','2','3'].map(char => 'LINKR_EXIT_' + char.repeat(32));
  for (const completionToken of tokens) filter.register({ ...record, completionToken });
  assert.equal(stream(filter, '\n' + tokens[0] + ':0\n'), '\n' + tokens[0] + ':0\n');
  assert.equal(stream(filter, tokens[1] + ':1\n'), '[Agent] exit=1\r\n');
  filter.reset(); assert.equal(stream(filter, tokens[2] + ':0\n'), tokens[2] + ':0\n');
});

test('normal bulk data passes immediately without mutation or byte loss', () => {
  const bytes = encoder.encode('设备 data\r\n'.repeat(40000));
  const before = bytes.slice(), filter = createSerialPresentation();
  assert.strictEqual(filter.push(bytes), bytes); assert.deepEqual(bytes, before);
  filter.register(record);
  assert.deepEqual(filter.push(bytes), before); assert.equal(filter.pendingBytes, 0);
});

test('ByteHistory retains the exact tail and snapshots do not alias', () => {
  for (const capacity of [1, 8, 16384, 16385, 40000]) {
    const history = new ByteHistory(capacity); let all = Buffer.alloc(0);
    for (const size of [20, 1, 16385, 3, 50000, 17]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
      history.append(bytes); all = Buffer.concat([all, bytes]); bytes.fill(0);
      assert.deepEqual(Buffer.from(history.read()), all.subarray(-capacity));
      assert.ok(history.length <= capacity);
    }
    const snapshot = history.read(); snapshot.fill(0);
    assert.deepEqual(Buffer.from(history.read()), all.subarray(-capacity));
    history.clear(); assert.equal(history.read().length, 0); assert.equal(history.blocks.length, 0);
  }
  assert.throws(() => new ByteHistory(0), RangeError);
});


test('internal probe echo is hidden across fragments while device output and errors remain visible', () => {
  for (const ending of ['\r', '\n', '\r\n']) {
    for (const size of [1, 2, 7, 20, 244, 1000]) {
      const filter = createSerialPresentation();
      const internal = { ...record, terminalEcho: 'hidden' };
      filter.register(internal);
      const output = '\r\nTOOL:curl:available\r\nKernel panic - not syncing: diagnostic\r\n';
      const raw = record.payload.replace(/\r$/, ending) + output + token + ':1\r\nroot@bee:~# ';
      assert.equal(stream(filter, raw, size), output + '[Agent] exit=1\r\nroot@bee:~# ');
      assert.equal(internal.command, record.command);
      assert.equal(internal.payload, record.payload);
      filter.reset();
    }
  }
});

test('hidden echoes still fail open on ambiguous, unregistered or unrelated output', () => {
  for (const raw of [record.payload.replace('sh -c', 'sh \x1b[K-c'), 'sh -c truncated',
    'UNRELATED\r\n' + record.payload, 'ordinary data\r\n']) {
    const filter = createSerialPresentation();
    filter.register({ ...record, terminalEcho: 'hidden' });
    assert.equal(stream(filter, raw), raw);
  }
  const filter = createSerialPresentation();
  filter.register({ command:record.command, payload:record.payload, terminalEcho:'hidden' });
  assert.equal(stream(filter, record.payload), record.payload);
  filter.register({ ...record, terminalEcho:'hidden' });
  filter.reset();
  assert.equal(stream(filter, record.payload), record.payload);
});
