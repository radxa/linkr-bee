/**
 * Shared, dependency-free test fixtures: a fake `bee-cli` executable and a
 * fake OpenCode `tool` helper.
 *
 * The fake CLI is a real Node script with a shebang, so the plugin spawns it
 * exactly the way it spawns the real binary. It appends every invocation to
 * FAKE_BEE_CALLS (arguments, stdin, the LAN token it saw) and answers from
 * FAKE_BEE_SCENARIO: either one scenario object or `{steps:[...]}`, consumed
 * one per invocation. That gives the tests full control over discovery,
 * failures, delays and captured input without installing anything.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_SOURCE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const scenarioPath = process.env.FAKE_BEE_SCENARIO;
const callsPath = process.env.FAKE_BEE_CALLS;
const args = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(98);
  });
});

async function main() {
  let scenario = {};
  if (scenarioPath) {
    try { scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')); } catch { scenario = {}; }
  }
  if (Array.isArray(scenario.steps) && scenario.steps.length > 0) {
    let count = 0;
    if (callsPath) {
      try { count = readFileSync(callsPath, 'utf8').split('\\n').filter(Boolean).length; } catch { count = 0; }
    }
    scenario = scenario.steps[Math.min(count, scenario.steps.length - 1)] ?? {};
  }
  if (callsPath) {
    appendFileSync(callsPath, JSON.stringify({
      args,
      stdin,
      lanToken: process.env.LINKR_LAN_TOKEN ?? null,
    }) + '\\n');
  }
  for (const event of scenario.events ?? []) process.stdout.write(JSON.stringify(event) + '\\n');
  if (scenario.stdout) process.stdout.write(scenario.stdout);
  if (scenario.includeStdin) {
    process.stdout.write(JSON.stringify({ event: 'output', data: stdin }) + '\\n');
  }
  if (scenario.stderr) process.stderr.write(scenario.stderr);
  if (scenario.sleepMs) await new Promise((resolve) => setTimeout(resolve, scenario.sleepMs));
  process.exitCode = scenario.exitCode ?? 0;
}
`;

/** Create a temp directory holding a fake bee-cli and its control files. */
export function makeFakeBeeCli() {
  const dir = mkdtempSync(join(tmpdir(), 'linkr-bee-opencode-'));
  const command = join(dir, 'fake-bee-cli.mjs');
  const calls = join(dir, 'calls.jsonl');
  const scenario = join(dir, 'scenario.json');
  writeFileSync(command, FAKE_SOURCE);
  chmodSync(command, 0o755);
  writeFileSync(calls, '');
  writeFileSync(scenario, '{}');
  // runBee forwards process.env, so every fake CLI child of this test file
  // finds the same control files.
  process.env.FAKE_BEE_CALLS = calls;
  process.env.FAKE_BEE_SCENARIO = scenario;
  return {
    dir,
    command,
    calls,
    scenario,
    setScenario(value) {
      writeFileSync(scenario, JSON.stringify(value));
    },
    reset() {
      writeFileSync(calls, '');
    },
    getCalls() {
      return readFileSync(calls, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

/**
 * A fake `bee-cli --serve`: prints one `ready` line with the console ops, then
 * answers JSON request frames from stdin. Invocations, frames and the bytes it
 * was asked to send are appended to `calls.jsonl` so tests can prove what the
 * console authority asked the board process to do. Scenario knobs live in
 * `scenario.json` (fresh content read for every invocation) and cover the
 * watch stream, monitor pages, send echo, a dispatch/RC-marker pair, exits
 * before/after ready and request delays.
 */
export function makeFakeServeCli() {
  const dir = mkdtempSync(join(tmpdir(), 'linkr-bee-console-'));
  const command = join(dir, 'fake-bee-serve.mjs');
  const calls = join(dir, 'calls.jsonl');
  const scenario = join(dir, 'scenario.json');
  writeFileSync(command, FAKE_SERVE_SOURCE);
  chmodSync(command, 0o755);
  writeFileSync(calls, '');
  writeFileSync(scenario, '{}');
  process.env.FAKE_SERVE_CALLS = calls;
  process.env.FAKE_SERVE_SCENARIO = scenario;
  return {
    dir,
    command,
    calls,
    scenario,
    setScenario(value) { writeFileSync(scenario, JSON.stringify(value)); },
    reset() { writeFileSync(calls, ''); },
    getCalls() {
      return readFileSync(calls, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

const FAKE_SERVE_SOURCE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const scenarioPath = process.env.FAKE_SERVE_SCENARIO;
const callsPath = process.env.FAKE_SERVE_CALLS;
let scenario = {};
try { scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')); } catch { scenario = {}; }

const record = (entry) => {
  if (callsPath) appendFileSync(callsPath, JSON.stringify(entry) + '\\n');
};
const write = (event) => process.stdout.write(JSON.stringify(event) + '\\n');

record({ type: 'spawn', args: process.argv.slice(2) });
if (scenario.exitBeforeReady) process.exit(1);

if (scenario.exitAfterReady) {
  write({ event: 'ready', program: 'bee-cli', version: '1.2.0', link: 'loopback', ops: scenario.ops ?? ['send', 'watch', 'resize', 'monitor', 'exec', 'state'] });
  setTimeout(() => process.exit(1), scenario.exitAfterReadyMs ?? 30);
} else {
  write({ event: 'ready', program: 'bee-cli', version: '1.2.0', link: 'loopback', ops: scenario.ops ?? ['send', 'watch', 'resize', 'monitor', 'exec', 'state'] });
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
  let index;
  while ((index = stdin.indexOf('\\n')) >= 0) {
    const line = stdin.slice(0, index).trim();
    stdin = stdin.slice(index + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    record({ type: 'request', id: frame.id, op: frame.op, fields: { ...frame } });
    const reply = (event) => write({ id: frame.id, ...event });
    const finish = (code = 0) => reply({ event: 'end', code });
    if (scenario.requestDelayMs) {
      setTimeout(() => answer(frame, reply, finish), scenario.requestDelayMs);
    } else {
      answer(frame, reply, finish);
    }
  }
});
process.stdin.on('end', () => process.exit(0));

function answer(frame, reply, finish) {
  const op = frame.op;
  if (op === 'quit') { finish(0); return; }
  if (op === 'watch') {
    reply({ event: 'result', what: 'watch', ok: true, on: frame.on });
    finish(0);
    if (frame.on && Array.isArray(scenario.streams)) {
      for (const chunk of scenario.streams) write({ event: 'stream', data: chunk, cursor: 0 });
    }
    if (frame.on && typeof scenario.streamAfterMs === 'number') {
      setTimeout(() => { for (const chunk of scenario.streams ?? []) write({ event: 'stream', data: chunk, cursor: 0 }); }, scenario.streamAfterMs);
    }
    return;
  }
  if (op === 'send') {
    record({ type: 'send', data: frame.data });
    reply({ event: 'result', what: 'send', ok: true });
    finish(0);
    if (scenario.sendEcho) write({ event: 'stream', data: scenario.sendEcho, cursor: 1 });
    return;
  }
  if (op === 'resize') {
    reply({ event: 'result', what: 'resize', ok: true });
    finish(0);
    return;
  }
  if (op === 'monitor') {
    const pages = scenario.monitorPages ?? [];
    const page = pages.shift();
    if (page) reply({ event: 'monitor', cursor: page.cursor ?? 1, text: page.text ?? '' });
    finish(0);
    return;
  }
  if (op === 'state') {
    reply({ event: 'result', what: 'state', ok: true, live: true, ...(typeof scenario.uartBaud === 'number' ? { uart: scenario.uartBaud } : {}) });
    finish(0);
    return;
  }
  if (op === 'uart') {
    reply({ event: 'result', what: 'uart', ok: true, ...(typeof scenario.uartBaud === 'number' ? { baud: scenario.uartBaud } : {}) });
    finish(0);
    return;
  }
  if (op === 'exec') {
    reply({ event: 'result', what: 'exec', ok: true, exit: 0 });
    finish(0);
    return;
  }
  reply({ event: 'error', code: 'bad_request', message: 'unknown op ' + String(op) });
  finish(2);
}

`;
