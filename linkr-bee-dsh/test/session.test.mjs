import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let nextImport = 0;
const fakeCli = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const config = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
const note = item => fs.appendFileSync(__dirname + '/calls.jsonl', JSON.stringify({pid:process.pid,...item})+'\n');
const emit = item => process.stdout.write(JSON.stringify(item)+'\n');
const args = process.argv.slice(2);
if (args.includes('--scan')) {
  note({mode:'scan'});
  setTimeout(()=>{emit({event:'device',board:true,name:'Linkr Bee Mock'});},250);
} else if (args.includes('--serve')) {
  note({mode:'serve'});
  const ready = () => emit({event:'ready',ops:config.scenario==='old-cli'?['exec']:config.scenario==='monitor'?['exec','monitor']:['exec','watch','send','resize']});
  if(config.scenario==='slow-start')setTimeout(ready,250);else ready();
  readline.createInterface({input:process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    note({mode:'request',...request});
    if(request.op==='quit')process.exit(0);
    emit({event:'begin',id:request.id});
    if(config.scenario==='drop-exec'&&request.op==='exec')process.exit(1);
    if(config.scenario==='drop-send'&&request.op==='send')process.exit(1);
    const finish=()=>{
      note({mode:'finished',op:request.op});
      if(request.op==='monitor')emit({event:'monitor',cursor:1,text:''});
      const bad=(config.scenario==='send-fail'||config.scenario==='send-false-zero')&&request.op==='send';
      emit({event:'result',id:request.id,what:request.op,ok:!bad});
      emit({event:'end',id:request.id,code:bad&&config.scenario!=='send-false-zero'?1:0});
    };
    if((request.op==='exec'&&request.cmd==='hold')||request.op==='monitor')setTimeout(finish,200);else finish();
  });
} else {
  note({mode:'one-shot',args});
  if(config.scenario==='uart-nonzero') {process.stderr.write('UART configuration unavailable');process.exit(2);}
  if(config.scenario==='uart-empty')process.exit(0);
  if(config.scenario==='uart-rejected'){emit({event:'result',what:'uart',ok:false,detail:'UART refused'});process.exit(0);}
  if(config.scenario==='uart-ok'){emit({event:'result',what:'uart',ok:true,detail:'OK uart=115200,8,n,1,none'});process.exit(0);}
  const finish=()=>{note({mode:'finished-one-shot'});emit({event:'result',what:'exec',ok:true});};
  if(config.scenario==='slow-query')setTimeout(finish,200);else finish();
}
`;

async function fixture(t, scenario = 'ok', extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'linkr-plugin-session-'));
  const executable = join(dir, 'bee-cli.cjs');
  await writeFile(executable, fakeCli, { mode: 0o755 });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ scenario }));
  await writeFile(join(dir, 'calls.jsonl'), '');
  const { apply } = await import(`../index.js?session-test=${++nextImport}`);
  const tools = new Map();
  const cleanups = [];
  let handler;
  let disposed = false;
  const ctx = {
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    webServer: { register(options) { handler = options.handler; return () => {}; } },
  };
  const config = { cliPath: executable, transport: 'loopback', sendCaptureMs: 0, ...extra };
  apply(ctx, config);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
  t.after(async () => { dispose(); await pause(450); await rm(dir, { recursive: true, force: true }); });
  const calls = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const found = (await calls()).find(predicate);
      if (found) return found;
      await pause(5);
    }
    assert.fail('mock CLI did not reach the expected state');
  };
  const call = (name, args, signal) => tools.get(name).execute(args, { signal });
  const state = async () => JSON.parse(await call('linkr_bee_console', { action: 'state' }));
  const route = async (path, body, stream) => {
    const req = stream ?? Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: '/linkr-bee'+path, headers: {host:'localhost'} });
    let status;
    let value;
    await handler(req, {writeHead(code){status=code;},end(text){value=JSON.parse(text);}});
    return { status, ...value };
  };
  const reapply = () => { dispose(); cleanups.length = 0; disposed = false; apply(ctx, config); };
  const consoleFrames = async () => {
    const req = new Readable({read(){}});
    Object.assign(req, {method:'GET',url:'/linkr-bee/console/stream',headers:{host:'localhost'}});
    const frames = [];
    await handler(req, {writeHead(){},write(text){frames.push(text);return true;}});
    req.emit('close');
    return frames.filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)));
  };
  return { call, calls, waitFor, state, route, dispose, reapply, consoleFrames };
}

test('a lost exec response never causes a one-shot replay', async t => {
  const f = await fixture(t, 'drop-exec');
  await assert.rejects(f.call('linkr_bee_exec', { cmd: 'non-idempotent-operation' }), /unknown|exited/);
  const calls = await f.calls();
  assert.equal(calls.filter(c => c.mode === 'request' && c.op === 'exec').length, 1);
  assert.equal(calls.filter(c => c.mode === 'one-shot').length, 0);
});

test('a raw Enter whose response is lost is never replayed', async t => {
  const f = await fixture(t, 'drop-send');
  await assert.rejects(f.call('linkr_bee_console', { action:'key',key:'enter' }), /unknown|exited/);
  assert.equal((await f.calls()).filter(c => c.mode === 'request' && c.op === 'send').length, 1);
});

test('startup incompatibility can fall back before exec is dispatched', async t => {
  const f = await fixture(t, 'old-cli');
  await f.call('linkr_bee_exec', { cmd:'one-command' });
  const calls = await f.calls();
  assert.equal(calls.filter(c => c.mode === 'request' && c.op === 'exec').length, 0);
  assert.equal(calls.filter(c => c.mode === 'one-shot').length, 1);
});

test('an already cancelled task starts no child and sends no input', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.call('linkr_bee_exec', {cmd:'never-send'}, controller.signal), {name:'AbortError'});
  assert.deepEqual(await f.calls(), []);
});

test('cancelling while connecting cannot send after the ready line', async t => {
  const f = await fixture(t, 'slow-start');
  const controller = new AbortController();
  const run = f.call('linkr_bee_exec', {cmd:'never-send'}, controller.signal);
  const rejection = assert.rejects(run, {name:'AbortError'});
  await f.waitFor(c => c.mode === 'serve'); controller.abort();
  await rejection; await pause(300);
  assert.equal((await f.calls()).some(c => c.op === 'exec' || c.mode === 'one-shot'), false);
  assert.equal((await f.state()).session.active, false);
});

test('cancelling one startup waiter preserves another caller of the same start', async t => {
  const f = await fixture(t, 'slow-start');
  const controller = new AbortController();
  const cancelled = f.call('linkr_bee_exec', {cmd:'cancelled'}, controller.signal);
  const rejection = assert.rejects(cancelled, {name:'AbortError'});
  await f.waitFor(c => c.mode === 'serve');
  const kept = f.call('linkr_bee_exec', {cmd:'kept'});
  controller.abort();
  await rejection; await kept;
  assert.deepEqual((await f.calls()).filter(c => c.mode === 'request' && c.op === 'exec').map(c => c.cmd), ['kept']);
});

test('a queued cancelled command is removed before reaching stdin', async t => {
  const f = await fixture(t);
  const first = f.call('linkr_bee_exec', {cmd:'hold'});
  await f.waitFor(c => c.op === 'exec');
  const controller = new AbortController();
  const second = f.call('linkr_bee_exec', {cmd:'cancelled'}, controller.signal);
  const rejection = assert.rejects(second, {name:'AbortError'});
  await pause(10); controller.abort(); await rejection; await first;
  assert.deepEqual((await f.calls()).filter(c => c.mode === 'request' && c.op === 'exec').map(c => c.cmd), ['hold']);
});

test('cancelling a dispatched request retires it without replay', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const run = f.call('linkr_bee_exec', {cmd:'hold'}, controller.signal);
  const rejection = assert.rejects(run, /unknown/);
  await f.waitFor(c => c.op === 'exec'); controller.abort(); await rejection;
  assert.equal((await f.calls()).filter(c => (c.mode === 'request' && c.op === 'exec') || c.mode === 'one-shot').length, 1);
  assert.equal((await f.state()).session.active, false);
});

test('queued work survives the preceding lease returning', async t => {
  const f = await fixture(t);
  const first = f.call('linkr_bee_exec', {cmd:'hold'});
  await f.waitFor(c => c.op === 'exec');
  const second = f.call('linkr_bee_exec', {cmd:'second'});
  await Promise.all([first,second]);
  const calls = await f.calls();
  assert.equal(calls.filter(c => c.mode === 'serve').length, 1);
  assert.deepEqual(calls.filter(c => c.mode === 'request' && c.op === 'exec').map(c => c.cmd), ['hold','second']);
  assert.equal((await f.state()).session.active, false);
});

for (const scenario of ['send-fail','send-false-zero']) {
  test(`${scenario}: failed send is not reported as delivered`, async t => {
    const f = await fixture(t, scenario);
    await assert.rejects(f.call('linkr_bee_console', {action:'type',text:'hello'}), /send failed/);
    const result = await f.route('/input', {data:'hello'});
    assert.equal(result.ok, false);
    assert.match(result.error, /send failed/);
    assert.equal((await f.state()).session.active, false);
  });
}

test('idle exec and typing release the link without a panel', async t => {
  const f = await fixture(t);
  await f.call('linkr_bee_exec', {cmd:'done'});
  assert.equal((await f.state()).session.active, false);
  await f.call('linkr_bee_console', {action:'type',text:'hello'});
  assert.equal((await f.state()).session.active, false);
});

test('the panel retains its watched link across a tool call', async t => {
  const f = await fixture(t);
  await f.route('/watch', {on:true});
  await f.call('linkr_bee_exec', {cmd:'done'});
  const state = await f.state();
  assert.equal(state.session.active, true);
  assert.equal(state.session.watching, true);
  await f.route('/watch', {on:false});
  assert.equal((await f.state()).session.active, false);
});

test('closing the panel preserves a tool capture window then returns the link', async t => {
  const f = await fixture(t, 'ok', {sendCaptureMs:200});
  await f.route('/watch', {on:true});
  const typed = f.call('linkr_bee_console', {action:'type',text:'capture'});
  await f.waitFor(c => c.op === 'send');
  const stopped = await f.route('/watch', {on:false});
  assert.equal(stopped.released, false);
  assert.equal((await f.state()).session.watching, true);
  await typed;
  assert.equal((await f.state()).session.active, false);
});

test('dispose while discovering cannot resurrect a pending session', async t => {
  const f = await fixture(t, 'ok', {transport:'ble'});
  const run = f.call('linkr_bee_exec', {cmd:'never-send'});
  const rejection = assert.rejects(run, /disposed|cancelled|abort/i);
  await f.waitFor(c => c.mode === 'scan'); f.dispose();
  await rejection; await pause(300);
  assert.equal((await f.calls()).some(c => c.mode === 'serve' || c.mode === 'one-shot'), false);
});

test('console snapshot and clear expose one ordered epoch/sequence cutoff', async t => {
  const f = await fixture(t);
  const before = await f.route('/console/read');
  assert.equal(typeof before.epoch, 'string');
  await f.call('linkr_bee_console', {action:'clear'});
  const after = await f.route('/console/read');
  const history = await f.route('/console/history');
  const clear = history.events.at(-1);
  assert.equal(after.epoch, before.epoch);
  assert.equal(after.seq, before.seq+1);
  assert.equal(clear.type, 'clear');
  assert.equal(clear.epoch, after.epoch);
  assert.equal(clear.seq, after.seq);
  const panel = await f.route('/panel', {action:'clear'});
  assert.equal(panel.event.consoleEpoch, after.epoch);
  assert.equal(panel.event.consoleSeq, after.seq+1);
  const frames = await f.consoleFrames();
  assert.equal(frames[0].type, 'snapshot');
  assert.equal(frames[0].epoch, after.epoch);
  assert.equal(frames[0].seq, panel.event.consoleSeq);
  assert.equal(frames[0].firstSeq, history.events[0].seq);
});

test('a one-shot query waits for an exec lease rather than disconnecting it', async t => {
  const f = await fixture(t);
  const exec = f.call('linkr_bee_exec', {cmd:'hold'});
  await f.waitFor(c => c.op === 'exec');
  const query = f.call('linkr_bee_query', {target:'info'});
  await Promise.all([exec,query]);
  const calls = await f.calls();
  assert.ok(calls.findIndex(c => c.mode === 'one-shot') > calls.findIndex(c => c.mode === 'finished' && c.op === 'exec'));
});

test('resident dialing waits for a one-shot to return the link', async t => {
  const f = await fixture(t, 'slow-query');
  const query = f.call('linkr_bee_query', {target:'info'});
  await f.waitFor(c => c.mode === 'one-shot');
  const typed = f.call('linkr_bee_console', {action:'type',text:'later'});
  await Promise.all([query,typed]);
  const calls = await f.calls();
  assert.ok(calls.findIndex(c => c.mode === 'serve') > calls.findIndex(c => c.mode === 'finished-one-shot'));
});

test('cancelling a one-shot while waiting never interrupts the active exec', async t => {
  const f = await fixture(t);
  const exec = f.call('linkr_bee_exec', {cmd:'hold'});
  await f.waitFor(c => c.op === 'exec');
  const controller = new AbortController();
  const query = f.call('linkr_bee_query', {target:'info'}, controller.signal);
  const rejection = assert.rejects(query, {name:'AbortError'});
  await pause(10); controller.abort();
  await rejection; await exec;
  assert.equal((await f.calls()).some(c => c.mode === 'one-shot'), false);
});

test('cancelling an active one-shot returns the watched link to the panel', async t => {
  const f = await fixture(t, 'slow-query');
  await f.route('/watch', {on:true});
  const controller = new AbortController();
  const query = f.call('linkr_bee_query', {target:'info'}, controller.signal);
  const rejection = assert.rejects(query, {name:'AbortError'});
  await f.waitFor(c => c.mode === 'one-shot'); controller.abort(); await rejection;
  const deadline = Date.now()+2000;
  let state;
  do { state = await f.state(); if (state.session.watching) break; await pause(10); } while (Date.now()<deadline);
  assert.equal(state.session.streaming, true);
  assert.equal(state.session.active, true);
  assert.equal(state.session.watching, true);
});

test('stopping an in-flight old-CLI monitor releases when its poll drains', async t => {
  const f = await fixture(t, 'monitor');
  await f.route('/watch', {on:true});
  await f.waitFor(c => c.op === 'monitor');
  const stopped = await f.route('/watch', {on:false});
  assert.equal(stopped.released, false);
  await pause(250);
  assert.equal((await f.state()).session.active, false);
});

test('an old HTTP body cannot dispatch through a replacement plugin instance', async t => {
  const f = await fixture(t);
  const body = new Readable({read(){}});
  const old = f.route('/exec', {}, body);
  f.reapply();
  body.push(Buffer.from(JSON.stringify({cmd:'old-request'}))); body.push(null);
  const response = await old;
  assert.equal(response.ok, false);
  await f.call('linkr_bee_exec', {cmd:'new-request'});
  assert.deepEqual((await f.calls()).filter(c => c.mode === 'request' && c.op === 'exec').map(c => c.cmd), ['new-request']);
});

for (const scenario of ['uart-nonzero','uart-empty','uart-rejected']) {
  test(`${scenario}: UART read/write routes require an affirmative result`, async t => {
    const f = await fixture(t, scenario, {transport:'ble',bleName:'Mock'});
    const queried = await f.route('/uart');
    assert.equal(queried.ok, false);
    assert.equal(typeof queried.error, 'string');
    const written = await f.route('/uart', {value:'115200,8,n,1,none'});
    assert.equal(written.ok, false);
    assert.equal(typeof written.error, 'string');
    const history = await f.route('/console/history');
    assert.equal(history.events.some(event => event.text?.includes('UART →')), false);
  });
}

test('confirmed UART read/write routes return settings and announce the accepted change', async t => {
  const f = await fixture(t, 'uart-ok', {transport:'ble',bleName:'Mock'});
  const queried = await f.route('/uart');
  assert.equal(queried.ok, true);
  assert.equal(queried.spec, '115200,8,n,1,none');
  const written = await f.route('/uart', {value:'115200,8,n,1,none'});
  assert.equal(written.ok, true);
  const history = await f.route('/console/history');
  assert.equal(history.events.filter(event => event.text?.includes('UART →')).length, 1);
});

for (const transport of ['lan','loopback']) {
  test(`UART management on ${transport} is rejected without invoking CLI`, async t => {
    const f = await fixture(t, 'uart-ok', {transport,lanHost:''});
    assert.equal((await f.route('/uart')).ok, false);
    assert.equal((await f.route('/uart', {value:'115200,8,n,1,none'})).ok, false);
    assert.deepEqual(await f.calls(), []);
  });
}

test('the line input route also rejects a failed one-shot send', async t => {
  const f = await fixture(t, 'uart-rejected');
  const result = await f.route('/console/input', {text:'hello',mode:'line'});
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
});
