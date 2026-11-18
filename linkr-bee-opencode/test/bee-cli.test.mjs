import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_NOTICE,
  DISCOVERY_TTL_MS,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_EVENTS,
  captureEvent,
  connectionArgs,
  dialArgs,
  discoveredBleName,
  discoveryKey,
  forgetDiscoveredName,
  launcherCandidates,
  newCapture,
  renderRun,
  report,
  requireSuccess,
  resolveCli,
  runBee,
  workspaceBuild,
} from '../src/bee-cli.js';
import { makeFakeBeeCli } from './helpers.mjs';

const fake = makeFakeBeeCli();
const config = () => ({
  cliPath: fake.command,
  transport: 'loopback',
  lanHost: '',
  lanToken: '',
  bleAddress: '',
  bleName: '',
  timeoutMs: 30000,
  sendCaptureMs: 1500,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ resolution */

test('resolveCli prefers cliPath, then LINKR_BEE_CLI, then the launcher, the checkout build and PATH', () => {
  const existsOnly = (...paths) => (candidate) => paths.includes(candidate);

  assert.deepEqual(
    resolveCli({ cliPath: '/config/bee-cli' }, {
      exists: existsOnly('/config/bee-cli'), env: { LINKR_BEE_CLI: '/env/bee-cli' }, launchers: [], workspaceBuild: '/built/bee-cli',
    }),
    { command: '/config/bee-cli', args: [] },
  );
  assert.deepEqual(
    resolveCli({}, {
      exists: existsOnly('/env/bee-cli'), env: { LINKR_BEE_CLI: '/env/bee-cli' }, launchers: [], workspaceBuild: '/built/bee-cli',
    }),
    { command: '/env/bee-cli', args: [] },
  );
  assert.deepEqual(
    resolveCli({}, {
      exists: existsOnly('/launcher.js'), env: {}, launchers: [null, '/launcher.js'], workspaceBuild: '/built/bee-cli', execPath: '/node',
    }),
    { command: '/node', args: ['/launcher.js'] },
  );
  assert.deepEqual(
    resolveCli({}, { exists: () => false, env: {}, launchers: [null], workspaceBuild: '/built/bee-cli' }),
    { command: '/built/bee-cli', args: [] },
  );
  assert.deepEqual(
    resolveCli({}, { exists: () => false, env: {}, launchers: [null], workspaceBuild: null }),
    { command: 'bee-cli', args: [] },
  );
});

test('a missing cliPath does not shadow a later fallback', () => {
  assert.deepEqual(
    resolveCli({ cliPath: '/gone/bee-cli' }, {
      exists: (candidate) => candidate === '/env/bee-cli', env: { LINKR_BEE_CLI: '/env/bee-cli' }, launchers: [], workspaceBuild: null,
    }),
    { command: '/env/bee-cli', args: [] },
  );
});

test('resolveCli refuses the Windows .cmd shim with an actionable message', () => {
  const runtime = { platform: 'win32', exists: () => true, env: {}, launchers: [], workspaceBuild: null };
  assert.throws(
    () => resolveCli({ cliPath: 'C:\\npm\\bee-cli.cmd' }, runtime),
    /Windows \.cmd shim.*bee-cli\.exe/s,
  );
  assert.deepEqual(
    resolveCli({ cliPath: 'C:\\npm\\bee-cli.exe' }, runtime),
    { command: 'C:\\npm\\bee-cli.exe', args: [] },
  );
  assert.deepEqual(
    resolveCli({}, { platform: 'win32', exists: () => false, env: {}, launchers: [null], workspaceBuild: null }),
    { command: 'bee-cli.exe', args: [] },
  );
});

test('launcherCandidates finds the linkr-bee-cli launcher from a resolution base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkr-bee-launcher-'));
  const moduleDir = join(dir, 'node_modules', 'linkr-bee-cli');
  mkdirSync(join(moduleDir, 'bin'), { recursive: true });
  writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ name: 'linkr-bee-cli', version: '1.2.0' }));
  writeFileSync(join(moduleDir, 'bin', 'bee-cli.js'), '#!/usr/bin/env node\n');
  const found = launcherCandidates([join(dir, 'index.js')]);
  assert.equal(found.length, 1);
  assert.match(found[0], /node_modules[/\\]linkr-bee-cli[/\\]bin[/\\]bee-cli\.js$/);
  assert.equal(existsSync(found[0]), true);
  // A base without the package yields null, never a throw.
  const isolated = mkdtempSync(join(tmpdir(), 'linkr-bee-no-launcher-'));
  assert.deepEqual(launcherCandidates([join(isolated, 'index.js')]), [null]);
});

test('workspaceBuild points at this checkout build when it exists', () => {
  const here = fileURLToPath(new URL('../src/bee-cli.js', import.meta.url));
  const expected = join(
    dirname(dirname(dirname(here))),
    'tools', 'linkr-tui', 'target', 'release',
    process.platform === 'win32' ? 'bee-cli.exe' : 'bee-cli',
  );
  assert.equal(workspaceBuild(), existsSync(expected) ? expected : null);
});

/* ------------------------------------------------------------ connection */

test('connectionArgs maps each transport and BLE form', () => {
  assert.deepEqual(connectionArgs({ transport: 'loopback' }), ['--bridge', '-']);
  assert.deepEqual(connectionArgs({ transport: 'lan', lanHost: '192.168.0.102' }), ['--lan-host', '192.168.0.102']);
  assert.throws(() => connectionArgs({ transport: 'lan' }), /LAN transport needs lanHost/);
  assert.deepEqual(connectionArgs({ transport: 'ble', bleAddress: 'EE:C7:42:34:48:CF' }), ['--ble-address', 'EE:C7:42:34:48:CF']);
  assert.deepEqual(connectionArgs({ transport: 'ble', bleName: 'Bench Bee' }), ['--ble-name', 'Bench Bee']);
  assert.deepEqual(connectionArgs({ transport: 'ble' }), []);
});

/* ------------------------------------------------------------- discovery */

test('dialArgs scans once, caches the board name, and reuses it within the TTL', async () => {
  fake.reset();
  forgetDiscoveredName();
  fake.setScenario({
    steps: [
      { events: [{ event: 'device', board: 'linkr-bee', name: 'Bench Bee' }] },
      { events: [{ event: 'result', what: 'info', ok: true }] },
    ],
  });
  const bleConfig = { ...config(), transport: 'ble' };
  assert.equal(DISCOVERY_TTL_MS, 5 * 60_000);
  assert.deepEqual(await dialArgs(bleConfig), ['--ble-name', 'Bench Bee']);
  assert.deepEqual(await dialArgs(bleConfig), ['--ble-name', 'Bench Bee']);
  assert.equal(fake.getCalls().length, 1, 'second dial uses the cached name');
  assert.equal(discoveredBleName(), 'Bench Bee');
});

test('dialArgs reports a room with no board instead of dialling blindly', async () => {
  fake.reset();
  forgetDiscoveredName();
  fake.setScenario({ events: [] });
  await assert.rejects(dialArgs({ ...config(), transport: 'ble' }), /No Linkr Bee board found/);
});

test('a failed dial forgets the discovered name; the next call scans again', async () => {
  fake.reset();
  forgetDiscoveredName();
  fake.setScenario({ steps: [{ events: [{ event: 'device', board: 'linkr-bee', name: 'Bench Bee' }] }] });
  const bleConfig = { ...config(), transport: 'ble' };
  await dialArgs(bleConfig);

  fake.reset();
  fake.setScenario({ exitCode: 255, stderr: 'link lost\n' });
  const run = await runBee(bleConfig, ['--ble-name', 'Bench Bee', '--json', '--query-info']);
  assert.equal(run.code, 255);
  assert.equal(discoveredBleName(), '', 'stale name forgotten after a failed dial');

  fake.reset();
  fake.setScenario({ steps: [{ events: [{ event: 'device', board: 'linkr-bee', name: 'Other Bee' }] }] });
  assert.deepEqual(await dialArgs(bleConfig), ['--ble-name', 'Other Bee']);
  assert.deepEqual(fake.getCalls()[0].args, ['--scan', '--json']);
});

test('changing connection settings invalidates the cached discovery key', () => {
  const bleConfig = { ...config(), transport: 'ble' };
  assert.equal(discoveryKey(bleConfig), discoveryKey({ ...bleConfig }));
  assert.notEqual(discoveryKey(bleConfig), discoveryKey({ ...bleConfig, bleName: 'Renamed' }));
  assert.notEqual(discoveryKey(bleConfig), discoveryKey({ ...bleConfig, bleAddress: 'EE:C7:42:34:48:CF' }));
  assert.notEqual(discoveryKey(bleConfig), discoveryKey({ ...bleConfig, lanToken: 'c'.repeat(32) }));
});

/* ----------------------------------------------------------- run and cap */

test('runBee parses JSON Lines and keeps a bounded stderr tail', async () => {
  fake.reset();
  fake.setScenario({
    events: [
      { event: 'begin', what: 'state' },
      { event: 'result', what: 'state', ok: true, live: false },
    ],
    stderr: 'progress line\n',
  });
  const run = await runBee(config(), ['--json', '--link-state']);
  assert.equal(run.code, 0);
  assert.equal(run.events.length, 2);
  assert.equal(run.events[1].live, false);
  assert.match(run.stderr, /progress line/);
  // runBee is the low-level runner: connection flags belong to the caller.
  assert.deepEqual(fake.getCalls()[0].args, ['--json', '--link-state']);
});

test('runBee sends the LAN token through the environment only', async () => {
  fake.reset();
  fake.setScenario({ events: [] });
  const token = 'd'.repeat(32);
  await runBee({ ...config(), lanToken: token }, ['--lan-host', 'example', '--json']);
  const call = fake.getCalls()[0];
  assert.equal(call.lanToken, token);
  assert.equal(call.args.includes(token), false);
});

test('runBee enforces the timeout budget and reaps the child', async () => {
  fake.reset();
  fake.setScenario({ sleepMs: 5000 });
  const started = Date.now();
  await assert.rejects(runBee(config(), ['--json'], { timeoutMs: 300 }), /bee-cli timed out after 300 ms/);
  assert.ok(Date.now() - started < 3000, 'timeout fired without waiting for the child');
});

test('runBee honours an abort signal and marks the delivery unknown', async () => {
  fake.reset();
  fake.setScenario({ sleepMs: 5000 });
  const controller = new AbortController();
  const started = Date.now();
  const pending = runBee(config(), ['--json'], { signal: controller.signal, timeoutMs: 30000 });
  await sleep(100);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.delivery === 'unknown');
  assert.ok(Date.now() - started < 3000);
});

test('runBee refuses to start when the signal is already aborted', async () => {
  fake.reset();
  fake.setScenario({});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runBee(config(), ['--json'], { signal: controller.signal }),
    (error) => error.name === 'AbortError' && /not sent/.test(error.message),
  );
  assert.equal(fake.getCalls().length, 0);
});

test('capture is bounded by event count but keeps the newest terminal frame', () => {
  const capture = newCapture();
  for (let i = 0; i < 5000; i++) captureEvent(capture, { event: 'output', data: '' });
  captureEvent(capture, { event: 'result', ok: true });
  assert.ok(capture.events.length <= MAX_CAPTURE_EVENTS);
  assert.equal(capture.events.at(-1).event, 'result');
  assert.equal(capture.truncated, true);
});

test('capture is bounded by bytes and evicts expendable output for a failure frame', () => {
  const capture = newCapture();
  captureEvent(capture, { event: 'output', data: 'x'.repeat(MAX_CAPTURE_BYTES - 64) });
  assert.equal(capture.events.length, 1);
  captureEvent(capture, { event: 'error', code: 'link_lost', message: 'lost after dispatch', still_running: false });
  captureEvent(capture, { event: 'result', ok: false });
  assert.ok(capture.bytes <= MAX_CAPTURE_BYTES);
  assert.equal(capture.events.some((event) => event.event === 'output'), false);
  assert.equal(capture.events.some((event) => event.code === 'link_lost'), true);
  assert.equal(capture.events.at(-1).ok, false);
  assert.equal(capture.truncated, true);
});

/* ------------------------------------------------------------- rendering */

const SAMPLE_RUN = {
  code: 0,
  signalName: null,
  truncated: false,
  stdout: '',
  stderr: '',
  events: [
    { event: 'result', what: 'exec', ok: true, exit: 0 },
    { event: 'output', data: 'uid=0(root)\r\n' },
    { event: 'output', text: 'second line\n' },
  ],
};

test('renderRun keeps result lines, target output and stderr in order', () => {
  const text = renderRun({ ...SAMPLE_RUN, stderr: 'a warning\n' });
  const resultAt = text.indexOf('{"event":"result"');
  const outputAt = text.indexOf('--- target output ---');
  const stderrAt = text.indexOf('--- stderr ---');
  assert.ok(resultAt >= 0 && outputAt > resultAt && stderrAt > outputAt, text);
  assert.match(text, /uid=0\(root\)/);
  assert.match(text, /second line/);
});

test('renderRun labels truncated capture and falls back to raw output', () => {
  assert.match(renderRun({ ...SAMPLE_RUN, truncated: true }), new RegExp(CAPTURE_NOTICE.replace(/[()]/g, '\\$&')));
  assert.equal(
    renderRun({ code: 0, signalName: null, truncated: false, stdout: 'plain text\n', stderr: '', events: [] }),
    'plain text',
  );
  assert.equal(
    renderRun({ code: 0, signalName: null, truncated: false, stdout: '', stderr: '', events: [] }),
    '(no output)',
  );
});

test('report returns answers and throws only for tooling failures', () => {
  assert.match(report(SAMPLE_RUN), /uid=0\(root\)/);
  assert.equal(report({ ...SAMPLE_RUN, events: [], stdout: 'done' }), 'done');
  assert.throws(
    () => report({ code: 255, signalName: null, truncated: false, stdout: '', stderr: 'link could not be opened\n', events: [] }),
    /bee-cli failed \(exit 255\).*link could not be opened/s,
  );
});

test('requireSuccess treats a failed result frame as an unconfirmed send', () => {
  assert.doesNotThrow(() => requireSuccess({ code: 0, events: [{ event: 'result', ok: true }] }, 'send'));
  assert.throws(
    () => requireSuccess({ code: 0, events: [{ event: 'result', ok: false }] }, 'send'),
    /bee-cli send failed \(exit 0\).*not confirmed delivered\. Do not resend automatically/s,
  );
});
