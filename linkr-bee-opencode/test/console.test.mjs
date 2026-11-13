import assert from 'node:assert/strict';
import test from 'node:test';

import { createConsole, defineConsoleTool, NAMED_KEY_BYTES } from '../src/console.js';
import { CONSOLE_RPC_ID, NAMED_KEYS, consoleRpcDefinition } from '../src/rpc-schema.js';
import { makeFakeServeCli } from './helpers.mjs';

const fake = makeFakeServeCli();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeRuntime({ emit, scenario = {}, config = {} } = {}) {
  fake.reset();
  fake.setScenario(scenario);
  const events = [];
  const runtime = createConsole({
    config: {
      cliPath: fake.command,
      transport: 'loopback',
      lanHost: '',
      lanToken: '',
      bleAddress: '',
      bleName: '',
      timeoutMs: 5000,
      sendCaptureMs: 100,
      ...config,
    },
    emit: (name, data) => {
      events.push({ name, data });
      emit?.(name, data);
    },
  });
  return { runtime, events };
}

function withoutSpawn(calls) {
  return calls.filter((call) => call.type !== 'spawn');
}

/* --------------------------------------------------------------- RPC schema */

test('the console RPC contract is frozen and complete', () => {
  const definition = consoleRpcDefinition();
  assert.equal(definition.id, CONSOLE_RPC_ID);
  assert.equal(definition.id, 'linkr_bee.console');
  assert.deepEqual(Object.keys(definition.methods).sort(), [
    'applyUart', 'clear', 'key', 'read', 'reconnect', 'resize', 'scan', 'settings', 'state',
    'updateSettings', 'webUrl', 'write',
  ]);
  assert.deepEqual(Object.keys(definition.events).sort(), ['output', 'request', 'state']);
  for (const [name, method] of Object.entries(definition.methods)) {
    assert.equal(method.input.type, 'object', `${name} input is an object schema`);
    assert.equal(method.output.type, 'object', `${name} output is an object schema`);
  }
  for (const [name, event] of Object.entries(definition.events)) {
    assert.equal(event.schema.type, 'object', `${name} event is an object schema`);
  }
  assert.deepEqual(
    definition.methods.read.output.required,
    ['view', 'text', 'bytes', 'epoch'],
  );
  assert.deepEqual(definition.methods.webUrl.output.required, ['url', 'enabled']);
  assert.deepEqual(
    definition.methods.state.output.required,
    ['connected', 'transport', 'target', 'cols', 'rows', 'bytes', 'epoch', 'readingBytes'],
  );
  assert.deepEqual(definition.methods.key.input.properties.key.enum, [...NAMED_KEYS]);
  assert.deepEqual(definition.events.request.schema.properties.action.enum, ['open', 'focus', 'clear']);
  assert.equal(definition.events.output.schema.properties.kind.enum.join(','), 'data,meta,user');
  assert.equal(NAMED_KEYS.length, 15);
});

test('named keys all map to terminal bytes', () => {
  assert.deepEqual(Object.keys(NAMED_KEY_BYTES).sort(), [...NAMED_KEYS].sort());
  assert.equal(NAMED_KEY_BYTES.enter, '\r');
  assert.equal(NAMED_KEY_BYTES['ctrl-c'], '\x03');
  assert.equal(NAMED_KEY_BYTES.esc, '\x1b');
});

/* ------------------------------------------------------------ session + ring */

test('state lazily dials the resident session and reports the shared console', async () => {
  const { runtime, events } = makeRuntime({
    scenario: { streams: ['boot\r\n'] },
  });
  try {
    const state = await runtime.consoleState();
    assert.equal(state.connected, true);
    assert.equal(state.transport, 'loopback');
    assert.equal(state.target, 'loopback');
    assert.equal(state.cols, 80);
    assert.equal(state.rows, 24);
    assert.equal(typeof state.bytes, 'number');
    assert.equal(typeof state.epoch, 'string');
    assert.equal(typeof state.readingBytes, 'number');

    const calls = fake.getCalls();
    assert.equal(calls.filter((call) => call.type === 'spawn').length, 1, 'one bee-cli --serve');
    const watch = calls.find((call) => call.type === 'request' && call.op === 'watch');
    assert.equal(watch.fields.on, true);

    await until(() => runtime.ring.raw.store.told > 0, 3000, 'watch stream');
    assert.equal(runtime.readConsole({ view: 'raw' }).text, 'boot\r\n');
    assert.equal(events.some((event) => event.name === 'state' && event.data.connected), true);
    assert.equal(events.some((event) => event.name === 'output' && event.data.kind === 'data'), true);
  } finally {
    runtime.dispose();
  }
});

test('output events advance both view cursors independently', async () => {
  const { runtime, events } = makeRuntime({
    scenario: { streams: ['first\r\n', 'second\r\n'] },
  });
  try {
    await runtime.consoleState();
    await until(() => runtime.ring.raw.store.told >= 'first\r\nsecond\r\n'.length, 3000, 'two chunks');

    const raw = runtime.readConsole({ view: 'raw' });
    assert.equal(raw.text, 'first\r\nsecond\r\n');
    assert.equal(raw.bytes, Buffer.byteLength('first\r\nsecond\r\n'));
    assert.equal(raw.epoch, runtime.epoch());

    const firstEvent = events.find((event) => event.name === 'output');
    const afterFirst = runtime.readConsole({ view: 'raw', since: firstEvent.data.bytes });
    assert.equal(afterFirst.text, 'second\r\n', 'since is the raw byte counter');

    const reading = runtime.readConsole({ view: 'reading' });
    assert.equal(reading.text, raw.text, 'without probe traffic both views show the same bytes');
    assert.equal(reading.bytes, raw.bytes);
  } finally {
    runtime.dispose();
  }
});

test('the reading view hides dispatch echoes and collapses LINKR_RC markers', async () => {
  const { runtime } = makeRuntime({ scenario: {} });
  try {
    const marker = `LINKR_RC_${'a'.repeat(32)}`;
    const wire = "sh -c 'uname -a'; printf '\\n%s:%s\\n' '" + marker + "' \"$?\"\r";
    runtime.registerReadingCommand({ event: 'dispatch', marker, wire });
    runtime.publishConsole({ kind: 'data', text: `${wire}\r\n${marker}:0\r\nLinux bench\r\n` });

    const reading = runtime.readConsole({ view: 'reading' }).text;
    assert.equal(reading.includes(wire), false, 'dispatch wrapper is hidden in the reading view');
    assert.equal(reading.includes(marker), false, 'completion marker is collapsed');
    assert.match(reading, /\[Agent\] exit=0/);
    assert.match(reading, /Linux bench/);

    const raw = runtime.readConsole({ view: 'raw' }).text;
    assert.match(raw, /LINKR_RC_/);
    assert.match(raw, /Linux bench/);
  } finally {
    runtime.dispose();
  }
});

test('the raw ring keeps 64 KiB, keeps counting, and flags truncated reads', async () => {
  const { runtime } = makeRuntime({ scenario: {} });
  try {
    const chunk = 'a'.repeat(70 * 1024);
    runtime.publishConsole({ kind: 'data', text: chunk });
    const state = runtime.snapshot();
    assert.equal(state.bytes, 70 * 1024, 'byte counter is monotonic past the ring limit');
    const read = runtime.readConsole({ view: 'raw', since: 0 });
    assert.equal(read.truncated, true);
    assert.ok(Buffer.byteLength(read.text, 'utf8') <= 64 * 1024);
    const tail = runtime.readConsole({ view: 'raw' });
    assert.equal(tail.text.length, 64 * 1024);
    assert.notEqual(tail.truncated, true);
  } finally {
    runtime.dispose();
  }
});

test('clear empties both rings but the byte counters and a new epoch survive', async () => {
  const { runtime } = makeRuntime({ scenario: {} });
  try {
    const before = runtime.epoch();
    runtime.publishConsole({ kind: 'data', text: 'kept until clear\r\n' });
    assert.match(runtime.readConsole({ view: 'raw' }).text, /kept until clear/);
    const bytes = runtime.snapshot().bytes;

    runtime.clear();
    assert.notEqual(runtime.epoch(), before, 'epoch identifies the ring generation');
    assert.equal(runtime.readConsole({ view: 'raw' }).text, '');
    assert.equal(runtime.readConsole({ view: 'reading' }).text, '');
    assert.equal(runtime.snapshot().bytes, bytes, 'byte counter keeps counting after a clear');
  } finally {
    runtime.dispose();
  }
});

/* ------------------------------------------------------------- live actions */

test('write and key reach the board session as send frames', async () => {
  const { runtime } = makeRuntime({ scenario: { sendEcho: 'id=0\r\n' } });
  try {
    await runtime.consoleState();
    await runtime.write('ls\r\n');
    await runtime.key('enter');
    await assert.rejects(runtime.key('hyperdrive'), /unknown key "hyperdrive"/);

    const sends = fake.getCalls().filter((call) => call.type === 'send').map((call) => call.data);
    assert.deepEqual(sends, ['ls\r\n', '\r']);
  } finally {
    runtime.dispose();
  }
});

test('resize applies through the session and updates state', async () => {
  const { runtime, events } = makeRuntime({ scenario: {} });
  try {
    await runtime.consoleState();
    const result = await runtime.resize(120, 40);
    assert.deepEqual(result, { applied: true, cols: 120, rows: 40 });
    const resize = fake.getCalls().find((call) => call.type === 'request' && call.op === 'resize');
    assert.equal(resize.fields.cols, 120);
    assert.equal(resize.fields.rows, 40);
    const state = await runtime.consoleState();
    assert.equal(state.cols, 120);
    assert.equal(state.rows, 40);
    assert.equal(events.some((event) => event.name === 'state' && event.data.cols === 120), true);
  } finally {
    runtime.dispose();
  }
});

test('typeIntoConsole returns the echo captured in the window', async () => {
  const { runtime } = makeRuntime({ scenario: { sendEcho: 'uid=0(root)\r\n' } });
  try {
    await runtime.consoleState();
    const sent = await runtime.typeIntoConsole('id\r\n', 150);
    assert.match(sent.echoed, /uid=0\(root\)/);
  } finally {
    runtime.dispose();
  }
});

test('reconnect redials after the session exits', async () => {
  const { runtime } = makeRuntime({ scenario: { exitAfterReady: true, exitAfterReadyMs: 40 } });
  try {
    await runtime.openConsole();
    await until(() => runtime.snapshot().link.connected === false, 3000, 'session loss');
    fake.setScenario({});
    const result = await runtime.reconnect();
    assert.equal(result.ok, true, 'reconnect restarts the resident session');
    const state = await runtime.consoleState();
    assert.equal(state.connected, true);
    const spawns = fake.getCalls().filter((call) => call.type === 'spawn').length;
    assert.ok(spawns >= 2, `a fresh bee-cli --serve was spawned (${spawns})`);
  } finally {
    runtime.dispose();
  }
});

test('monitor fallback polls when the CLI has no watch op', async () => {
  const { runtime } = makeRuntime({
    scenario: {
      ops: ['send', 'monitor', 'resize'],
      monitorPages: [{ cursor: 7, text: 'polled bytes\r\n' }],
    },
  });
  try {
    const state = await runtime.consoleState();
    assert.equal(state.connected, true);
    await until(() => runtime.readConsole({ view: 'raw' }).text.includes('polled bytes'), 4000, 'monitor page');
    assert.equal(runtime.snapshot().session.mode, 'poll');
    assert.equal(
      fake.getCalls().some((call) => call.type === 'request' && call.op === 'monitor'),
      true,
    );
  } finally {
    runtime.dispose();
  }
});

test('state reports a dead board without throwing', async () => {
  const { runtime } = makeRuntime({ scenario: { exitBeforeReady: true } });
  try {
    const state = await runtime.consoleState();
    assert.equal(state.connected, false);
    assert.equal(state.transport, 'loopback');
    assert.match(state.target, /exited before it was ready/);
    assert.equal(state.bytes, 0);
    assert.deepEqual(runtime.readConsole({ view: 'reading' }).text, '');
  } finally {
    runtime.dispose();
  }
});

/* ----------------------------------------------------------- shared leases */

test('a link lease retires the panel session, runs the tool, and resumes the stream', async () => {
  const { runtime } = makeRuntime({ scenario: {} });
  try {
    await runtime.consoleState();
    assert.equal(runtime.snapshot().link.connected, true);

    const result = await runtime.linkLease({}, async ({ publish }) => {
      publish({ event: 'output', data: 'from the one-shot\r\n' });
      return 'ran';
    });
    assert.equal(result, 'ran');
    assert.match(runtime.readConsole({ view: 'raw' }).text, /from the one-shot/, 'tool output lands in the shared ring');
    assert.equal(runtime.snapshot().link.connected, false, 'the panel session was released for the one-shot');

    await until(() => runtime.snapshot().link.connected === true, 5000, 'panel session resumed');
    const spawns = fake.getCalls().filter((call) => call.type === 'spawn').length;
    assert.ok(spawns >= 2, `the resident session was restarted (${spawns})`);
  } finally {
    runtime.dispose();
  }
});

/* --------------------------------------------------------------- console tool */

test('the console tool drives the shared console and relays open/focus', async () => {
  const { runtime, events } = makeRuntime({ scenario: { streams: ['root@bench:~#\r\n'] } });
  const tool = defineConsoleTool({ console: runtime });
  try {
    assert.equal(tool.name, 'linkr_bee_console');
    assert.deepEqual(tool.options, { codemode: false, permission: 'linkr_bee' });
    assert.deepEqual(tool.input.required, ['action']);

    const opened = await tool.execute({ action: 'open' }, {});
    assert.match(opened.content, /console open requested/);
    assert.equal(events.some((event) => event.name === 'request' && event.data.action === 'open'), true);
    await tool.execute({ action: 'focus' }, {});

    await runtime.consoleState();
    await until(() => runtime.readConsole({ view: 'raw' }).text.includes('root@bench'), 3000, 'console text');
    const read = await tool.execute({ action: 'read' }, {});
    assert.match(read.content, /root@bench/);

    const typed = await tool.execute({ action: 'type', text: 'ls\r' }, {});
    assert.match(typed.content, /Typed 3 character\(s\)/);
    assert.equal(fake.getCalls().some((call) => call.type === 'send' && call.data === 'ls\r'), true);
    assert.equal(events.some((event) => event.name === 'output' && event.data.kind === 'user'), true);

    await tool.execute({ action: 'key', key: 'enter' }, {});
    assert.equal(fake.getCalls().some((call) => call.type === 'send' && call.data === '\r'), true);

    const resized = await tool.execute({ action: 'resize', cols: 100, rows: 30 }, {});
    assert.match(resized.content, /resized to 100x30/);
    await assert.rejects(tool.execute({ action: 'resize', cols: 1, rows: 30 }, {}), /cols 2-500/);

    const state = await tool.execute({ action: 'state' }, {});
    assert.match(state.content, /"streaming": true/);

    await tool.execute({ action: 'clear' }, {});
    const cleared = await tool.execute({ action: 'read' }, {});
    assert.match(cleared.content, /\(nothing new\)/);

    await assert.rejects(tool.execute({ action: 'reboot' }, {}), /unknown action/);
    await assert.rejects(tool.execute({ action: 'type', text: '' }, {}), /needs text/);
    await assert.rejects(tool.execute({ action: 'key', key: 'hyperspace' }, {}), /unknown key/);
  } finally {
    runtime.dispose();
  }
});

/* ------------------------------------------------------------------- baud */

test('the state reports the baud rate the bridge answers for itself', async () => {
  const { runtime, events } = makeRuntime({
    scenario: {
      ops: ['send', 'watch', 'resize', 'monitor', 'exec', 'state', 'uart'],
      uartBaud: 115200,
    },
  });
  const first = await runtime.consoleState();
  assert.equal(first.connected, true);
  await until(
    () => events.some((event) => event.name === 'state' && event.data.baud === 115200),
    5000,
    'the probed baud rate',
  );
  const second = await runtime.consoleState();
  assert.equal(second.baud, 115200);
  runtime.dispose();
});

test('setBaud publishes a known UART without waiting for a redial', async () => {
  const { runtime, events } = makeRuntime({
    scenario: { ops: ['send', 'watch', 'resize', 'monitor', 'exec', 'state'] },
  });
  await runtime.consoleState();
  runtime.setBaud(230400);
  await until(
    () => events.some((event) => event.name === 'state' && event.data.baud === 230400),
    2000,
    'the applied baud rate',
  );
  assert.equal((await runtime.consoleState()).baud, 230400);
  runtime.dispose();
});
