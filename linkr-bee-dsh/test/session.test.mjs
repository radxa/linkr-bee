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
  if(config.scenario==='scan-fail') {process.stderr.write('bluetooth adapter unavailable\n');process.exit(2);}
  if(config.scenario==='scan-empty') process.exit(0);
  setTimeout(()=>{emit({event:'device',board:true,name:config.scanName||'Linkr Bee Mock'});},250);
} else if (args.includes('--serve')) {
  note({mode:'serve',args});
  if(config.scenario==='serve-fail-once'&&!fs.existsSync(__dirname+'/attempted')){
    fs.writeFileSync(__dirname+'/attempted','1');
    process.exit(1);
  }
  const ready = () => emit({event:'ready',ops:(config.scenario==='old-cli'||config.scenario==='send-window'||config.scenario==='large-output')?['exec']:config.scenario==='monitor'?['exec','monitor']:['exec','watch','send','resize']});
  if(config.scenario==='slow-start'||config.scenario==='slow-capture')setTimeout(ready,250);else ready();
  readline.createInterface({input:process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    note({mode:'request',...request});
    if(request.op==='quit')process.exit(0);
    emit({event:'begin',id:request.id});
    if(config.scenario==='not-connected-once'&&request.op==='exec'&&!fs.existsSync(__dirname+'/nc-used')){
      fs.writeFileSync(__dirname+'/nc-used','1');
      emit({event:'error',id:request.id,code:'not_connected',message:'the board is not reachable'});
      emit({event:'end',id:request.id,code:255});
      return;
    }
    if(config.scenario==='lost-exec'&&request.op==='exec'){
      emit({event:'output',id:request.id,data:'SIDE_EFFECT_DONE\n'});
      emit({event:'error',id:request.id,code:'link_lost',message:'the link went away mid-command',still_running:false});
      emit({event:'end',id:request.id,code:255});
      return;
    }
    if(config.scenario==='large-resident-output'&&request.op==='exec') {
      for(let i=0;i<80;i++) emit({event:'output',id:request.id,data:'界'.repeat(12000)});
    }
    if(config.scenario==='large-lost-exec'&&request.op==='exec') {
      for(let i=0;i<80;i++) emit({event:'output',id:request.id,data:'x'.repeat(32768)});
      emit({event:'error',id:request.id,code:'link_lost',message:'lost after a large response',still_running:false});
      emit({event:'end',id:request.id,code:255});
      return;
    }
    if(config.scenario==='drop-exec'&&request.op==='exec')process.exit(1);
    if(config.scenario==='drop-send'&&request.op==='send')process.exit(1);
    if(config.scenario==='presentation'&&request.op==='exec') {
      const marker='LINKR_RC_0123456789abcdef0123456789abcdef';
      const wire="sh -c '"+request.cmd+"'; printf '\\n%s:%s\\n' '"+marker+"' \"$?\"\r";
      emit({event:'dispatch',id:request.id,marker,wire});
    }
    if(config.scenario==='presentation'&&request.op==='send')emit({event:'stream',data:request.data});
    if(config.scenario==='slow-capture'&&request.op==='send')setTimeout(()=>emit({event:'stream',data:'AFTER_READY_REPLY\n'}),200);
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
  if(config.scenario==='large-output') {
    for(let i=0;i<80;i++) emit({event:'output',data:'x'.repeat(32768)});
    emit({event:'result',what:'exec',ok:true,exit:0});
    return;
  }
  if(config.scenario==='uart-nonzero') {process.stderr.write('UART configuration unavailable');process.exit(2);}
  if(config.scenario==='uart-empty')process.exit(0);
  if(config.scenario==='uart-rejected'){emit({event:'result',what:'uart',ok:false,detail:'UART refused'});process.exit(0);}
  if(config.scenario==='uart-ok'){emit({event:'result',what:'uart',ok:true,reply:'uart=115200,8,n,1,none'});process.exit(0);}
  if(config.scenario==='uart-baud'){emit({event:'result',what:'uart',ok:true,reply:'uart=230400'});process.exit(0);}
  if(config.scenario==='send-window') {
    let text='',sent=false,reply=null;
    const send=()=>{if(sent)return;sent=true;note({mode:'delivered',text});reply=setTimeout(()=>emit({event:'output',text:'DELAYED_REPLY\n'}),1000);};
    process.stdin.on('data',chunk=>{text+=chunk;if(args[args.indexOf('--send')+1]==='raw'||text.includes('\n'))send();});
    process.stdin.on('end',()=>{send();setTimeout(()=>{clearTimeout(reply);emit({event:'result',what:'send',ok:true});},500);});
    return;
  }
  const finish=()=>{note({mode:'finished-one-shot'});emit({event:'result',what:'exec',ok:true});};
  if(args.includes('--send')){
    let stdin='';
    process.stdin.on('data',chunk=>{stdin+=chunk;});
    process.stdin.on('end',()=>{note({mode:'send-stdin',stdin});finish();});
    process.stdin.resume();
    return;
  }
  if(config.scenario==='slow-query')setTimeout(finish,200);else finish();
}
`;

async function fixture(t, scenario = 'ok', extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'linkr-plugin-session-'));
  const executable = join(dir, 'bee-cli.cjs');
  const { cli = {}, editor, fiberEntry, ...configExtra } = extra;
  await writeFile(executable, fakeCli, { mode: 0o755 });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ scenario, ...cli }));
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
  if (editor !== undefined) ctx.get = name => (name === 'configEditor' ? editor : undefined);
  if (fiberEntry !== undefined) ctx.fiber = { entry: fiberEntry };
  const config = { cliPath: executable, transport: 'loopback', sendCaptureMs: 0, ...configExtra };
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
  await f.call('linkr_bee_exec', { cmd:'one-command', timeoutMs:120000 });
  const calls = await f.calls();
  assert.equal(calls.filter(c => c.mode === 'request' && c.op === 'exec').length, 0);
  assert.equal(calls.filter(c => c.mode === 'one-shot').length, 1);
  const args = calls.find(c => c.mode === 'one-shot').args;
  assert.equal(args[args.indexOf('--timeout') + 1], '120');
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

test('auto-discovery is reused while fresh and scanned again once it expires', async t => {
  const f = await fixture(t, 'ok', {transport:'ble',bleName:'',bleAddress:''});
  const scans = async () => (await f.calls()).filter(c => c.mode === 'scan').length;

  await f.call('linkr_bee_query', {target:'state'});
  assert.equal(await scans(), 1);
  const dialled = (await f.calls()).find(c => c.mode === 'one-shot' && c.args.includes('--ble-name'));
  assert.ok(dialled, 'the board found by the scan is dialled by name');
  assert.equal(dialled.args[dialled.args.indexOf('--ble-name') + 1], 'Linkr Bee Mock');

  // Inside the TTL the remembered name is used without touching the radio.
  await f.call('linkr_bee_query', {target:'state'});
  assert.equal(await scans(), 1, 'a fresh discovery is reused, not rescanned');

  // Past the TTL it is a hint only: scan again, so a renamed or swapped board
  // is found instead of dialling the old name forever.
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60_000;
  try {
    await f.call('linkr_bee_query', {target:'state'});
  } finally {
    Date.now = realNow;
  }
  assert.equal(await scans(), 2, 'a discovery older than the TTL is rescanned');
});

test('a failed dial forgets the discovered name and scans again', async t => {
  const f = await fixture(t, 'serve-fail-once', {transport:'ble',bleName:'',bleAddress:''});
  await f.call('linkr_bee_exec', {cmd:'true'});
  const calls = await f.calls();
  assert.equal(calls.filter(c => c.mode === 'scan').length, 2,
    'the start that never became a session must not pin the old name');
  assert.equal(calls.filter(c => c.mode === 'serve').length, 1);
  assert.equal(calls.filter(c => c.mode === 'one-shot').length, 1,
    'the exec falls back to the one-shot path after the failed session start');
});

test('the Host half carries no hard-coded Chinese UI text', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.equal(/[\u3400-\u9fff]/.test(source), false,
    'Host messages are language-neutral; the panel localises its own labels');
});

test('a not_connected exec says nothing was dispatched and the next call rescans', async t => {
  const f = await fixture(t, 'not-connected-once', {transport:'ble',bleName:'',bleAddress:''});
  // Watching keeps the session alive between calls, so the recovery below is
  // the stale-session path rather than "the lease closed the session".
  const watched = await f.route('/watch', {on:true});
  assert.equal(watched.ok, true);
  await assert.rejects(
    f.call('linkr_bee_exec', {cmd:'echo hi'}),
    /not dispatched.*not reachable/,
  );
  // The failed dial marked the session dirty: the next call stops it and scans
  // again instead of reusing the board name that just failed.
  const answer = await f.call('linkr_bee_exec', {cmd:'echo hi'});
  assert.match(answer, /result/);
  const calls = await f.calls();
  assert.equal(calls.filter(c => c.mode === 'scan').length, 2);
  assert.equal(calls.filter(c => c.mode === 'serve').length, 2);
  await f.route('/watch', {on:false});
});

test('a lost exec after dispatch is never reported as safe to resend', async t => {
  // The CLI emits `link_lost` with `still_running: false` after the command
  // was sent and the link died holding the answer. That flag is not proof
  // that nothing was dispatched, so the tool must not offer a resend.
  const f = await fixture(t, 'lost-exec', {transport:'ble',bleName:'Mock'});
  await assert.rejects(
    f.call('linkr_bee_exec', {cmd:'touch /tmp/already-ran'}),
    /bee-cli exec failed \(link_lost\).*do not resend automatically/,
  );
  const calls = await f.calls();
  assert.equal(calls.filter(c => c.mode === 'request' && c.op === 'exec').length, 1,
    'the command was dispatched exactly once');
  assert.equal(calls.filter(c => c.mode === 'one-shot').length, 0,
    'a post-dispatch failure must not fall back to a one-shot replay');
});

test('an inherited property is not a named key', async t => {
  const f = await fixture(t, 'ok');
  await assert.rejects(
    f.call('linkr_bee_console', {action:'key', key:'constructor'}),
    /unknown key "constructor"/,
  );
});

test('LAN transport without a host says so instead of falling back to BLE', async t => {
  const f = await fixture(t, 'ok', {transport:'lan', lanHost:''});
  await assert.rejects(
    f.call('linkr_bee_query', {target:'state'}),
    /LAN transport needs lanHost/,
  );
});

test('a failed scan is an error, not an empty result', async t => {
  const f = await fixture(t, 'scan-fail', {transport:'ble', bleName:'', bleAddress:''});
  const result = await f.route('/scan', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /adapter unavailable/);
});

test('the scan tool does not require a board to already connect to', async t => {
  const f = await fixture(t, 'scan-empty', {transport:'ble', bleName:'', bleAddress:''});
  const answer = await f.call('linkr_bee_query', {target:'scan'});
  assert.equal(answer, 'No Linkr Bee boards found nearby.');
  assert.equal((await f.calls()).filter(c => c.mode === 'scan').length, 1);
});

test('a dry run answers without scanning for or dialling a board', async t => {
  const f = await fixture(t, 'scan-empty', {transport:'ble', bleName:'', bleAddress:''});
  const answer = await f.call('linkr_bee_exec', {cmd:'echo hi', dryRun:true});
  assert.match(answer, /result/);
  const calls = await f.calls();
  assert.equal(calls.filter(c => c.mode === 'scan').length, 0,
    'the dry run is a CLI question, not a dial');
  const dry = calls.find(c => c.mode === 'one-shot');
  assert.ok(dry, 'the CLI answered the dry run');
  assert.ok(dry.args.includes('--dry-run'));
  assert.equal(dry.args.some(a => a === '--ble-name' || a === '--ble-address' || a === '--lan-host'), false);
});

test('linkr_bee_set validates before it dials', async t => {
  const f = await fixture(t, 'ok', {transport:'ble', bleName:'Mock'});
  await assert.rejects(f.call('linkr_bee_set', {target:'uart', value:'not-a-format'}),
    /baud,data,parity,stop,flow/);
  await assert.rejects(f.call('linkr_bee_set', {target:'rename-ble', value:'x'.repeat(30)}),
    /1-29 UTF-8 bytes/);
  await assert.rejects(f.call('linkr_bee_set', {target:'wifi'}),
    /wifi needs a value/);
  assert.deepEqual(await f.calls(), []);
});

test('a saved config is what the next read and dial use', async t => {
  const f = await fixture(t, 'ok');
  const saved = await f.route('/config', {transport:'loopback', bleName:'New Name', timeoutMs:12000});
  assert.equal(saved.ok, true);
  assert.equal(saved.applied, 'memory');
  const read = await f.route('/config');
  assert.equal(read.config.bleName, 'New Name');
  assert.equal(read.config.timeoutMs, 12000);
});

test('a spawn that cannot start gives the link back instead of wedging every caller', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'linkr-cmd-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const shim = join(dir, 'bee-cli.cmd');
  await writeFile(shim, '');
  const f = await fixture(t, 'ok', {cliPath: shim, transport:'loopback'});
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {value:'win32', configurable:true});
  try {
    await assert.rejects(f.call('linkr_bee_exec', {cmd:'x'}), /\.cmd shim/);
    // A leaked borrow would park this call until its timeout; rejecting with
    // the same message quickly is what proves the link was released.
    await assert.rejects(
      Promise.race([
        f.call('linkr_bee_exec', {cmd:'x'}),
        pause(3000).then(() => { throw new Error('the second call was wedged'); }),
      ]),
      /\.cmd shim/,
    );
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
});

test('memory connection changes retire the old board before the next exec', async t => {
  const f = await fixture(t, 'ok', {transport:'ble',bleName:'Board-A'});
  await f.route('/watch', {on:true});
  const saved = await f.route('/config', {bleName:'Board-B'});
  assert.equal(saved.ok, true);
  await f.call('linkr_bee_exec', {cmd:'new-board-only'});
  const calls = await f.calls();
  const old = calls.find(c => c.mode === 'serve' && c.args.includes('Board-A'));
  const current = calls.find(c => c.mode === 'serve' && c.args.includes('Board-B'));
  assert.ok(old && current);
  assert.notEqual(old.pid, current.pid);
  assert.equal(calls.find(c => c.op === 'exec').pid, current.pid);
  assert.equal((await f.state()).link.target, 'Board-B');
});

test('a connection change cannot redirect an active or queued command', async t => {
  const f = await fixture(t, 'ok', {transport:'ble',bleName:'Board-A'});
  const running = f.call('linkr_bee_exec', {cmd:'hold'});
  await f.waitFor(c => c.op === 'exec');
  const queued = f.call('linkr_bee_exec', {cmd:'queued'});
  assert.equal((await f.route('/config', {bleName:'Board-B'})).ok, false);
  assert.equal((await f.route('/config')).config.bleName, 'Board-A');
  await Promise.all([running, queued]);
  assert.equal((await f.route('/config', {bleName:'Board-B'})).ok, true);
  await f.call('linkr_bee_exec', {cmd:'new-board'});
  const calls = await f.calls();
  const current = calls.find(c => c.mode === 'serve' && c.args.includes('Board-B'));
  assert.equal(calls.find(c => c.cmd === 'new-board').pid, current.pid);
});

test('a command accepted during an async settings write waits for the new board', async t => {
  let releaseEdit;
  const gate = new Promise(resolve => { releaseEdit = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const editor = {
    async edit() {
      markStarted();
      await gate;
    },
  };
  const f = await fixture(t, 'ok', {
    transport: 'ble',
    bleName: 'Board-A',
    editor,
    fiberEntry: { config: { transport: 'ble', bleName: 'Board-A' } },
  });
  const saving = f.route('/config', { bleName: 'Board-B' });
  await started;
  const exec = f.call('linkr_bee_exec', { cmd: 'only-on-B' });
  await pause(120);
  const during = await f.calls();
  assert.equal(during.filter(c => c.mode === 'serve').length, 0,
    'a command accepted during the write must not be dialled to the old board');
  assert.equal(during.filter(c => c.op === 'exec').length, 0,
    'nothing reaches the resident session while the write is pending');
  releaseEdit();
  const saved = await saving;
  assert.equal(saved.ok, true);
  const answer = await exec;
  assert.match(answer, /result/);
  const calls = await f.calls();
  const serves = calls.filter(c => c.mode === 'serve');
  assert.equal(serves.length, 1, 'the command was dialled once, after the write');
  const name = serves[0].args[serves[0].args.indexOf('--ble-name') + 1];
  assert.equal(name, 'Board-B');
  assert.equal(calls.find(c => c.cmd === 'only-on-B').pid, serves[0].pid,
    'the accepted command belongs to the new connection, not the stopped one');
});

test('legacy UART replies expose the confirmed baud without inventing other fields', async t => {
  const f = await fixture(t, 'uart-baud', {transport:'ble',bleName:'Mock'});
  const reply = await f.route('/uart');
  assert.equal(reply.ok, true);
  assert.equal(reply.baud, 230400);
  assert.equal(reply.spec, null);
});

for (const mode of ['line', 'raw']) {
  test(`${mode} send captures a delayed reply and publishes CLI text output to the shared console`, async t => {
    const f = await fixture(t, 'send-window');
    const result = await f.call('linkr_bee_send', {text:'PING',mode,captureMs:1500});
    assert.match(result, /DELAYED_REPLY/);
    assert.equal((await f.route('/console/read?view=raw')).text, 'DELAYED_REPLY\n');
    const delivered = (await f.calls()).find(c => c.mode === 'delivered');
    assert.equal(delivered.text, mode === 'line' ? 'PING\n' : 'PING');
  });
}

const marker = 'LINKR_RC_0123456789abcdef0123456789abcdef';
const wrapper = `sh -c 'echo hi'; printf '\\n%s:%s\\n' '${marker}' "$?"`;
async function presentation(t) {
  const f = await fixture(t, 'presentation');
  await f.route('/watch', {on:true});
  await f.call('linkr_bee_exec', {cmd:'echo hi'});
  return {...f, send: text => f.route('/input', {data:text})};
}

test('reading transforms only registered complete echoes and markers across every chunk boundary', async t => {
  const f = await presentation(t);
  for (const text of ['sh ', "-c 'echo hi'; printf '\\n%s:%s\\n' 'LINKR_ \rRC_", '0123456789abcdef0123456789abcdef', "' \"$?\"\r\n", 'hi\r\n', 'LINK', 'R_RC_0123456789abcdef0123456789abcdef:0\r\n']) await f.send(text);
  assert.equal((await f.route('/console/read')).text, 'hi\r\n[Agent] exit=0\r\n');
  assert.match((await f.route('/console/read?view=raw')).text, /printf/);
  await f.send(marker + ':0\r\n');
  assert.ok((await f.route('/console/read')).text.endsWith(marker + ':0\r\n'), 'a completed marker is retired');
});

test('unregistered markers and mismatched wrappers remain ordinary device output', async t => {
  const f = await presentation(t);
  const text = `LINKR_RC_device_log:7\r\n${wrapper.replace('echo hi','echo other')}\r\n`;
  await f.send(text);
  assert.equal((await f.route('/console/read')).text, text);
});

test('an idle partial echo gets an ordered reading-only event, including after reconnect', async t => {
  const f = await presentation(t);
  await f.send('sh -c');
  const before = (await f.route('/console/read')).seq;
  assert.equal((await f.route('/console/read')).text, '');
  await pause(350);
  const after = await f.route('/console/read');
  assert.equal(after.text, 'sh -c');
  assert.equal(after.seq, before + 1);
  const frames = await f.consoleFrames();
  assert.ok(frames.some(event => event.type === 'stream' && event.text === '' && event.reading === 'sh -c'));
  assert.equal((await f.route('/console/read?view=raw')).text, 'sh -c');
});

test('clear cancels a pending reading flush without reviving cleared output', async t => {
  const f = await presentation(t);
  await f.send('sh -c');
  await f.route('/panel', {action:'clear'});
  await pause(350);
  assert.equal((await f.route('/console/read')).text, '');
  assert.equal((await f.route('/console/read?view=raw')).text, '');
});

test('resident send observes its full capture budget after slow connection startup', async t => {
  const f = await fixture(t, 'slow-capture');
  const result = await f.call('linkr_bee_send', {text:'PING',captureMs:300});
  assert.match(result,/AFTER_READY_REPLY/);
  assert.equal((await f.route('/console/read?view=raw')).text,'AFTER_READY_REPLY\n');
  const calls=await f.calls();
  assert.equal(calls.find(c=>c.op==='send').data,'PING\n');
  assert.equal(calls.filter(c=>c.mode==='one-shot').length,0);
  assert.equal((await f.state()).session.active,false);
});

test('cancelling a send capture after acknowledgement never claims input was not sent', async t => {
  const f=await fixture(t,'slow-capture');
  const controller=new AbortController();
  const result=f.call('linkr_bee_send',{text:'PING',captureMs:1000},controller.signal);
  const rejected=assert.rejects(result,/unknown.*Do not resend automatically/);
  await f.waitFor(c=>c.mode==='finished'&&c.op==='send');
  await pause(30);controller.abort();await rejected;
  assert.equal((await f.calls()).filter(c=>c.mode==='request'&&c.op==='send').length,1);
});


for (const kind of ['set', 'exec-timeout', 'http-exec', 'http-uart']) {
  test(`${kind}: parameters are prepared after a pending connection save`, {timeout:5000}, async t => {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    t.after(() => release());
    const f = await fixture(t, 'uart-ok', {
      transport:'ble', bleName:'Board-A',
      editor:{async edit() { entered(); await gate; }},
      fiberEntry:{config:{transport:'ble',bleName:'Board-A'}},
    });
    const saving = f.route('/config', {bleName:'Board-B'});
    await started;
    const operation = kind === 'set'
      ? f.call('linkr_bee_set', {target:'rename-ble',value:'Renamed'})
      : kind === 'exec-timeout'
        ? f.call('linkr_bee_exec', {cmd:'probe-target',timeoutMs:12000})
        : kind === 'http-exec'
          ? f.route('/exec', {cmd:'probe-target',timeoutMs:12000})
          : f.route('/uart', {value:'115200,8,n,1,none'});
    await pause(40);
    assert.equal((await f.calls()).length,0,'nothing dials while the settings edit is pending');
    release();
    assert.equal((await saving).ok,true);
    const answer=await operation;
    if(kind.startsWith('http-')) assert.equal(answer.ok,true);
    const runtime=(await f.route('/config')).config;
    const dial=(await f.calls()).find(c=>c.mode==='one-shot'||c.mode==='serve');
    assert.equal(runtime.bleName,'Board-B');
    assert.equal(dial.args[dial.args.indexOf('--ble-name')+1],runtime.bleName);
  });
}

test('overlapping settings patches preserve the new target and the later timeout', {timeout:5000}, async t => {
  const releases=[];
  let profile={transport:'ble',bleName:'Board-A',timeoutMs:30000};
  const f=await fixture(t,'ok',{
    transport:'ble',bleName:'Board-A',
    editor:{async edit(_entry,update){
      const gate=new Promise(resolve=>releases.push(resolve));
      await gate;
      profile=update(profile);
    }},
    fiberEntry:{config:profile},
  });
  t.after(()=>releases.forEach(release=>release()));
  const first=f.route('/config',{bleName:'Board-B'});
  while(releases.length<1) await pause(5);
  const second=f.route('/config',{timeoutMs:12000});
  await pause(30);
  assert.equal(releases.length,1,'profile writes must be serialized');
  releases[0]();
  assert.equal((await first).ok,true);
  while(releases.length<2) await pause(5);
  const command=f.call('linkr_bee_exec',{cmd:'after-both-saves'});
  await pause(30);
  assert.equal((await f.calls()).length,0,'commands wait for every queued settings patch');
  releases[1]();
  assert.equal((await second).ok,true);
  const runtime=(await f.route('/config')).config;
  assert.equal(profile.bleName,'Board-B');
  assert.equal(runtime.bleName,profile.bleName);
  assert.equal(runtime.timeoutMs,12000);
  assert.equal(profile.timeoutMs,12000);
  await command;
  const dial=(await f.calls()).find(c=>c.mode==='serve');
  assert.equal(dial.args[dial.args.indexOf('--ble-name')+1],'Board-B');
  assert.equal((await f.calls()).find(c=>c.op==='exec').timeout_ms,12000);
});

test('cancelling a command waiting for settings does not dial or retain its lease', {timeout:5000}, async t => {
  let release, entered;
  const gate=new Promise(resolve=>release=resolve);
  const started=new Promise(resolve=>entered=resolve);
  const f=await fixture(t,'ok',{
    transport:'ble',bleName:'Board-A',
    editor:{async edit(){entered();await gate;}},
    fiberEntry:{config:{transport:'ble',bleName:'Board-A'}},
  });
  t.after(()=>release());
  const saving=f.route('/config',{bleName:'Board-B'});
  await started;
  const controller=new AbortController();
  const command=f.call('linkr_bee_exec',{cmd:'cancelled-before-settings-commit'},controller.signal);
  const rejected=assert.rejects(command,{name:'AbortError'});
  controller.abort();
  await rejected;
  assert.equal((await f.calls()).length,0);
  release();
  assert.equal((await saving).ok,true);
  await f.call('linkr_bee_exec',{cmd:'next-command'});
  const history=await f.calls();
  assert.equal(history.filter(c=>c.mode==='request'&&c.op==='exec').length,1);
  assert.equal(history.find(c=>c.mode==='request'&&c.op==='exec').cmd,'next-command');
});

test('a rejected profile edit releases queued settings and the next command', {timeout:5000}, async t => {
  let release, entered;
  const gate=new Promise(resolve=>release=resolve);
  const started=new Promise(resolve=>entered=resolve);
  let edits=0;
  const f=await fixture(t,'ok',{
    transport:'ble',bleName:'Board-A',
    editor:{async edit(){ if(++edits===1){entered();await gate;throw new Error('profile write failed');} }},
    fiberEntry:{config:{transport:'ble',bleName:'Board-A'}},
  });
  t.after(()=>release());
  const first=f.route('/config',{bleName:'Board-B'});
  await started;
  const second=f.route('/config',{timeoutMs:12000});
  release();
  assert.equal((await first).ok,false);
  assert.equal((await second).ok,true);
  const runtime=(await f.route('/config')).config;
  assert.equal(runtime.bleName,'Board-A');
  assert.equal(runtime.timeoutMs,12000);
  await f.call('linkr_bee_exec',{cmd:'after-failed-save'});
});

for(const scenario of ['large-output','large-resident-output']) {
  test(`${scenario}: retained output is bounded and completion remains visible`, async t => {
    const f=await fixture(t,scenario);
    const result=await f.call('linkr_bee_exec',{cmd:'large-output'});
    assert.ok(Buffer.byteLength(result)<=1024*1024+8192);
    assert.match(result,/"event":"result"/);
    assert.match(result,/captured output truncated/);
  });
}

test('output truncation preserves a later lost-link error without replay', async t => {
  const f=await fixture(t,'large-lost-exec');
  await assert.rejects(f.call('linkr_bee_exec',{cmd:'large-output'}),/link_lost.*do not resend automatically/);
  const history=await f.calls();
  assert.equal(history.filter(c=>c.mode==='request'&&c.op==='exec').length,1);
  assert.equal(history.some(c=>c.mode==='one-shot'),false);
});

test('a connection change reports which operation holds the console', async t => {
  const f = await fixture(t, 'ok');
  const scanning = f.route('/scan', {});
  await pause(50);
  const answer = await f.route('/config', { bleName: 'Linkr Bee Other' });
  assert.equal(answer.status, 200);
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'busy');
  assert.ok(answer.busy.includes('command'), 'a one-shot scan holds the link as a command');
  const scan = await scanning;
  assert.equal(scan.ok, true);
});

test('an idle console accepts a connection change', async t => {
  const f = await fixture(t, 'ok');
  const answer = await f.route('/config', { bleName: 'Linkr Bee Other' });
  assert.equal(answer.status, 200);
  assert.equal(answer.ok, true);
  assert.equal(answer.applied, 'memory');
});

test('a failed scan is reported as a scan failure, not an empty list', async t => {
  const f = await fixture(t, 'scan-fail');
  const answer = await f.route('/scan', {});
  assert.equal(answer.status, 400);
  assert.equal(answer.ok, false);
  assert.match(answer.error, /bluetooth adapter unavailable/);
});
