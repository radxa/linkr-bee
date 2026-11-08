import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = source.indexOf('const MAX_CAPTURE_BYTES');
const code = source.slice(start, source.indexOf('/**\n * Run one bee-cli request.', start));
const { newCapture, captureEvent } = vm.runInNewContext(
  code + ';({newCapture,captureEvent})', { Buffer },
);

test('tiny frames cannot bypass the capture event-count limit', () => {
  const capture = newCapture();
  for (let i = 0; i < 5000; i++) captureEvent(capture, { event:'output', data:'' });
  captureEvent(capture, { event:'result', ok:true });
  assert.ok(capture.events.length <= 4096);
  assert.equal(capture.events.at(-1).event, 'result');
  assert.equal(capture.truncated, true);
});

test('terminal error and result frames evict output when the byte budget is full', () => {
  const capture = newCapture();
  captureEvent(capture, { event:'output', data:'x'.repeat(1024 * 1024 - 64) });
  assert.equal(capture.events.length, 1);
  captureEvent(capture, { event:'error', code:'link_lost', message:'lost after dispatch', still_running:false });
  captureEvent(capture, { event:'result', ok:false });
  assert.ok(capture.bytes <= 1024 * 1024);
  assert.equal(capture.events.some(event => event.event === 'output'), false);
  assert.equal(capture.events.some(event => event.code === 'link_lost'), true);
  assert.equal(capture.events.at(-1).ok, false);
  assert.equal(capture.truncated, true);
});
