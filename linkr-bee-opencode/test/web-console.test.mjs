import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConsole } from '../src/console.js';
import { createWebConsole } from '../src/web-console.js';
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

function writeAsset(content = 'globalThis.__LINKR_BEE_TEST__ = 1;\n') {
  const dir = mkdtempSync(join(tmpdir(), 'linkr-bee-web-'));
  const path = join(dir, 'web-console.js');
  writeFileSync(path, content);
  return { dir, path };
}

/** Start a fake-CLI console authority plus its browser page server. */
async function setup({ scenario = {}, config = {}, asset = true } = {}) {
  fake.reset();
  fake.setScenario(scenario);
  const { dir, path } = writeAsset();
  const events = [];
  let web = null;
  const runtime = createConsole({
    config: {
      cliPath: fake.command,
      transport: 'loopback',
      lanHost: '',
      lanToken: '',
      bleAddress: '',
      bleName: '',
      timeoutMs: 5000,
      sendCaptureMs: 80,
      webConsole: true,
      ...config,
    },
    emit: (name, data) => {
      events.push({ name, data });
      web?.broadcast(name, data);
    },
  });
  web = createWebConsole({
    console: runtime,
    config: runtime.config,
    assetPath: asset ? path : join(dir, 'missing-web-console.js'),
  });
  const info = await web.start();
  return { runtime, web, info, events, assetPath: path };
}

async function teardown({ runtime, web }) {
  await web.stop();
  runtime.dispose();
}

function tokenOf(info) {
  return new URL(info.url).searchParams.get('t');
}

/** A URL on the page server, with the token unless asked to omit it. */
function pageUrl(info, path = '/', { token = true } = {}) {
  const page = new URL(info.url);
  const url = new URL(path, page.origin);
  if (token) url.searchParams.set('t', tokenOf(info));
  return url;
}

function post(info, path, body, { token = true } = {}) {
  return fetch(pageUrl(info, path, { token }), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Read SSE text until `until(text)`; aborts and returns the collected text. */
async function collectEvents(info, untilText, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';
  let response = null;
  try {
    response = await fetch(pageUrl(info, '/events'), { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (!untilText(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (!untilText(text)) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { text, response };
}

/* ---------------------------------------------------------------- security */

test('every request needs the token; a wrong or missing one is 401', async () => {
  const env = await setup();
  try {
    for (const path of ['/', '/state', '/read', '/events', '/assets/web-console.js']) {
      const missing = await fetch(pageUrl(env.info, path, { token: false }));
      assert.equal(missing.status, 401, `${path} without a token`);
      assert.deepEqual(await missing.json(), { ok: false, error: 'invalid or missing token' });
      const wrong = await fetch(pageUrl(env.info, path, { token: false }).toString().replace('?', '?t=deadbeef&x='));
      assert.equal(wrong.status, 401, `${path} with a wrong token`);
    }
    const postMissing = await post(env.info, '/input', { data: 'x' }, { token: false });
    assert.equal(postMissing.status, 401);
    // The token is 32 hex characters, and the page URL carries it.
    assert.match(tokenOf(env.info), /^[0-9a-f]{32}$/);
    assert.equal(env.info.enabled, true);
    assert.match(env.info.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
  } finally {
    await teardown(env);
  }
});

test('the server is disabled cleanly by config.webConsole = false', async () => {
  const { runtime, web } = await setup({ config: { webConsole: false } });
  try {
    assert.equal(web.enabled, false);
    const info = await web.webUrl();
    assert.deepEqual(info, { url: '', enabled: false });
    const started = await web.start();
    assert.deepEqual(started, { url: '', enabled: false });
    assert.equal(web.token, '');
  } finally {
    await web.stop();
    runtime.dispose();
  }
});

/* -------------------------------------------------------------------- shell */

test('the page shell loads the bundle and carries the token', async () => {
  const env = await setup();
  try {
    const response = await fetch(pageUrl(env.info));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /<title>Linkr Bee console<\/title>/);
    assert.match(html, /<div id="linkr-console"><\/div>/);
    assert.match(html, new RegExp(`window.__LINKR_BEE_TOKEN__="${tokenOf(env.info)}"`));
    assert.match(html, /<script src="\/assets\/web-console.js\?t=[0-9a-f]{32}" defer><\/script>/);
    assert.match(html, /window.__LINKR_BEE_WEB_URL__="http:\/\/127\.0\.0\.1:\d+"/);
  } finally {
    await teardown(env);
  }
});

test('the built page bundle is served from dist, and a missing one is a clear 404', async () => {
  const env = await setup();
  try {
    const response = await fetch(pageUrl(env.info, '/assets/web-console.js'));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/javascript/);
    assert.equal(await response.text(), 'globalThis.__LINKR_BEE_TEST__ = 1;\n');
  } finally {
    await teardown(env);
  }

  const missing = await setup({ asset: false });
  try {
    const response = await fetch(pageUrl(missing.info, '/assets/web-console.js'));
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /not built/);
  } finally {
    await teardown(missing);
  }
});

/* --------------------------------------------------------------- state/read */

test('GET /state exposes the RPC state plus the page URL', async () => {
  const env = await setup({ scenario: { streams: ['hello\r\n'] } });
  try {
    const response = await fetch(pageUrl(env.info, '/state'));
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.connected, true);
    assert.equal(state.transport, 'loopback');
    assert.equal(state.webUrl, env.info.url);
    assert.equal(state.cols, 80);
    assert.equal(state.rows, 24);
    assert.equal(typeof state.bytes, 'number');
    assert.equal(typeof state.epoch, 'string');
    assert.equal(typeof state.readingBytes, 'number');
  } finally {
    await teardown(env);
  }
});

test('GET /read tails the ring and honours view/since', async () => {
  const env = await setup({ scenario: { streams: ['hello\r\n', 'world\r\n'] } });
  try {
    await fetch(pageUrl(env.info, '/state')); // dials + starts watch
    await until(
      () => env.runtime.readConsole({ view: 'raw' }).text.includes('world'),
      4000,
      'watch stream',
    );
    const tail = await (await fetch(pageUrl(env.info, '/read?view=raw'))).json();
    assert.equal(tail.view, 'raw');
    assert.equal(tail.text, 'hello\r\nworld\r\n');
    assert.equal(typeof tail.bytes, 'number');
    assert.equal(typeof tail.epoch, 'string');

    const incremental = await (await fetch(pageUrl(env.info, '/read?view=reading&since=5'))).json();
    assert.equal(incremental.view, 'reading');
    assert.equal(incremental.text, '\r\nworld\r\n');

    const bad = await fetch(pageUrl(env.info, '/read?since=nope'));
    assert.equal(bad.status, 400);
  } finally {
    await teardown(env);
  }
});

/* --------------------------------------------------------------------- SSE */

test('GET /events sends the initial state and live output events', async () => {
  const env = await setup({ scenario: { streams: ['boot\r\n'] } });
  try {
    await fetch(pageUrl(env.info, '/state'));
    const initial = await collectEvents(env.info, (text) => text.includes('event: state'));
    assert.match(initial.text, /^retry: 2000\n\n/);
    assert.match(initial.text, /event: state\ndata: \{.*"connected":/);
    assert.match(initial.response.headers.get('content-type'), /text\/event-stream/);

    const live = collectEvents(env.info, (text) => text.includes('event: output') && text.includes('live'));
    // Give the SSE connection a moment, then publish through the authority.
    await sleep(80);
    env.runtime.publishConsole({ kind: 'data', text: 'live\r\n' });
    const received = await live;
    assert.match(received.text, /event: output/);
    assert.match(received.text, /"text":"live\\r\\n"/);
    assert.match(received.text, /"reading":"live\\r\\n"/);
    assert.match(received.text, /"readingBytes":/);
  } finally {
    await teardown(env);
  }
});

/* ------------------------------------------------------------------- posts */

test('POST /input and /key reach the board session and reject bad bodies', async () => {
  const env = await setup({ scenario: { sendEcho: 'id=0\r\n' } });
  try {
    assert.deepEqual(await (await post(env.info, '/input', { data: 'ls\r\n' })).json(), { ok: true });
    assert.deepEqual(await (await post(env.info, '/key', { key: 'enter' })).json(), { ok: true });
    const sends = fake.getCalls().filter((call) => call.type === 'send').map((call) => call.data);
    assert.deepEqual(sends, ['ls\r\n', '\r']);

    const unknownKey = await post(env.info, '/key', { key: 'hyperspace' });
    assert.equal(unknownKey.status, 200);
    const unknownBody = await unknownKey.json();
    assert.equal(unknownBody.ok, false);
    assert.match(unknownBody.error, /unknown key/);

    assert.equal((await post(env.info, '/input', 'not json')).status, 400);
    assert.equal((await post(env.info, '/input', { nope: true })).status, 400);
    assert.equal((await post(env.info, '/missing', {})).status, 404);

    const tooLarge = await post(env.info, '/input', { data: 'x'.repeat(70 * 1024) });
    assert.equal(tooLarge.status, 413);
  } finally {
    await teardown(env);
  }
});

test('POST /resize, /clear and /reconnect drive the shared console', async () => {
  const env = await setup({ scenario: {} });
  try {
    // The page calls /state on load (which dials); do the same before resizing.
    await fetch(pageUrl(env.info, '/state'));
    const resized = await (await post(env.info, '/resize', { cols: 120, rows: 40 })).json();
    assert.equal(resized.ok, true);
    assert.equal(resized.applied, true);
    assert.equal(resized.cols, 120);
    assert.equal(resized.rows, 40);
    assert.equal(
      fake.getCalls().some((call) => call.type === 'request' && call.op === 'resize' && call.fields.cols === 120),
      true,
    );

    env.runtime.publishConsole({ kind: 'data', text: 'before clear\r\n' });
    assert.match(env.runtime.readConsole({ view: 'raw' }).text, /before clear/);
    assert.deepEqual(await (await post(env.info, '/clear', {})).json(), { ok: true });
    assert.equal(env.runtime.readConsole({ view: 'raw' }).text, '');

    const spawnsBefore = fake.getCalls().filter((call) => call.type === 'spawn').length;
    const reconnected = await (await post(env.info, '/reconnect', {})).json();
    assert.equal(reconnected.ok, true);
    const spawnsAfter = fake.getCalls().filter((call) => call.type === 'spawn').length;
    assert.ok(spawnsAfter > spawnsBefore, `reconnect spawned a fresh bee-cli (${spawnsBefore} -> ${spawnsAfter})`);
  } finally {
    await teardown(env);
  }
});

test('stopping the page server closes the listener', async () => {
  const env = await setup();
  const url = env.info.url;
  await teardown(env);
  await assert.rejects(fetch(url), /fetch failed|ECONNREFUSED/);
});
