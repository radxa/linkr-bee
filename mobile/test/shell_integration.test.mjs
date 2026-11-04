import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createShellMarkerParser, shellIntegrationCommand, shellMarker, shellQuote, SHELL_FUNCTION } from '../../web/shell_integration.js';
import { SerialJournal } from '../../web/serial_journal.js';
import { createDeviceExecutor } from '../../web/device_executor.js';
import { createSerialPresentation } from '../../web/serial_presentation.js';
const nonce = 'a'.repeat(32), other = 'b'.repeat(32), encode = text => new TextEncoder().encode(text);

for (const shell of ['/bin/sh','/bin/bash']) {
  test(`generated helper runs quoted commands and preserves outer errexit in ${shell}`, () => {
    const setup = shellIntegrationCommand(nonce);
    const command = `printf "设备 it's working\\n"; exit 7`;
    const raw = execFileSync(shell, ['-c', `set -e; ${setup}; ${SHELL_FUNCTION} ${shellQuote(command)}; ${SHELL_FUNCTION} ${shellQuote('printf second')}; printf '\\nOUTER_ALIVE\\n'`], {encoding:'utf8'});
    const parser = createShellMarkerParser(), events = parser.push(raw,0);
    assert.deepEqual(events.map(({phase,sequence,exitCode})=>({phase,sequence,exitCode})), [
      {phase:'R',sequence:0,exitCode:undefined}, {phase:'C',sequence:1,exitCode:undefined}, {phase:'D',sequence:1,exitCode:7},
      {phase:'C',sequence:2,exitCode:undefined}, {phase:'D',sequence:2,exitCode:0},
    ]);
    assert.match(raw,/设备 it's working/); assert.match(raw,/OUTER_ALIVE/); assert.ok(!raw.includes('LINKR_EXIT_'));
  });
}
test('an unrelated reserved function is not overwritten, and an owned helper can be re-enabled', () => {
  const raw = execFileSync('/bin/sh', ['-c', `${SHELL_FUNCTION}() { printf ORIGINAL; }; ${shellIntegrationCommand(nonce)}; ${SHELL_FUNCTION}`], {encoding:'utf8'});
  assert.match(raw,/already exists/); assert.match(raw,/ORIGINAL/); assert.equal(createShellMarkerParser().push(raw,0).length,0);
  const reset = execFileSync('/bin/sh', ['-c', `${shellIntegrationCommand(nonce)}; ${SHELL_FUNCTION} true; ${shellIntegrationCommand(other)}; ${SHELL_FUNCTION} true`], {encoding:'utf8'});
  assert.deepEqual(createShellMarkerParser().push(reset,0).map(event=>[event.nonce,event.sequence,event.phase]), [
    [nonce,0,'R'],[nonce,1,'C'],[nonce,1,'D'],[other,0,'R'],[other,1,'C'],[other,1,'D'],
  ]);
});
test('OSC markers survive byte fragmentation, have raw cursors, and never enter plain journal text', () => {
  const journal = new SerialJournal();
  const raw = '设备\r\n' + shellMarker(nonce,0,'R') + shellMarker(nonce,1,'C').replace('\x07','\x1b\\') + 'output\r\n' + shellMarker(nonce,1,'D',255);
  for (const byte of encode(raw)) journal.append(Uint8Array.of(byte));
  assert.equal(journal.read().text,'设备\r\noutput\r\n'); assert.equal(journal.read().latestCursor,raw.length);
  const events = journal.readExecutionEvents(); assert.deepEqual(events.map(event=>event.phase),['R','C','D']);
  for (const event of events) assert.ok(raw.slice(event.start,event.end).startsWith('\x1b]633;P;Linkr='));
  assert.equal(journal.readExecutionEvents({after:events[1].start,before:events[1].end}).length,1);
  events[0].nonce=other; assert.equal(journal.readExecutionEvents()[0].nonce,nonce);
  journal.reset(); assert.deepEqual(journal.readExecutionEvents(),[]);
});
test('literal, nested, malformed, cancelled and unfinished control payloads cannot create execution events', () => {
  const malformed = [shellMarker(nonce,1,'D',0).slice(0,-1), '\\033]633;P;Linkr=1:'+nonce+':1:D:0\\007',
    '\x1bP' + shellMarker(nonce,1,'D',0) + '\x1b\\', '\x1b]633;P;Linkr=1:'+nonce+':1:D:256\x07',
    '\x1b]633;P;Linkr=1:'+nonce+':0:C\x07', '\x1b]633;P;Linkr=1:'+nonce+':1:D:0junk\x07',
    '\x1b]633;P;Linkr=1:'+'x'.repeat(1000)+'\x07', shellMarker(nonce,1,'D',0).replace('\x07','\x18'),
  ];
  for (const raw of malformed) {
    const journal = new SerialJournal(); for (const byte of encode(raw)) journal.append(Uint8Array.of(byte));
    assert.deepEqual(journal.readExecutionEvents(),[],JSON.stringify(raw));
  }
  const journal = new SerialJournal(80); for(let i=1;i<200;i++) journal.append(encode(shellMarker(nonce,i,'C')));
  assert.ok(journal.executionEvents.length<=128); assert.ok(journal.readExecutionEvents().every(event=>event.start>=journal.end-journal.length));
});
function fixture() {
  const journal=new SerialJournal(); const receive=text=>journal.append(encode(text)); receive('root@bee:~# ');
  const status={connected:true,sessionId:1,inputRevision:0,inputPending:false}, sent=[];
  const device=createDeviceExecutor({getStatus:()=>({...status}),readLog:options=>journal.read(options),readExecutionEvents:options=>journal.readExecutionEvents(options),
    prepareInput:({text,appendEnter})=>text+(appendEnter?'\r':''),sendInput:async payload=>{sent.push(payload);return{inputRevision:++status.inputRevision};}});
  device.setMode('full-auto'); return{device,status,sent,receive,journal};
}
async function enable(f) {
  const setup=await f.device.enableShellIntegration();
  assert.equal(f.device.getStatus().shellIntegration.status,'enabling');
  // Echo alone contains the nonce but cannot confirm installation.
  f.receive(setup.payload+'\n'); assert.equal(f.device.inspectExecution(setup.id).executionStatus,'unknown');
  f.receive(shellMarker(setup.shellTracking.nonce,0,'R')+'\r\nroot@bee:~# ');
  assert.equal(f.device.inspectExecution(setup.id).executionStatus,'completed');
  return setup;
}
test('executor requires a matching handshake, start and finish, preserving nonzero exit status', async () => {
  const f=fixture(), setup=await enable(f); assert.equal(f.device.getStatus().shellIntegration.status,'ready');
  /* Full Auto now asks for shell text the guard cannot parse statically, and
   * this one is quoted: the approval is part of the setup, not the assertion. */
  const pending=f.device.execute({text:`printf "it's fine\\n"; exit 7`,appendEnter:true,trackExit:true});
  const waiting=f.device.getRecords().at(-1); assert.equal(waiting.state,'awaiting-approval');
  f.device.approve(waiting.id);
  const record=await pending;
  assert.match(record.payload,/^__linkr_run_v1 /); assert.ok(!record.payload.includes(setup.shellTracking.nonce)); assert.ok(!record.payload.includes('LINKR_EXIT_'));
  f.receive(shellMarker(other,1,'C')+shellMarker(other,1,'D',0)); assert.equal(f.device.inspectExecution(record.id).executionStatus,'unknown');
  // Finish without start is not sufficient. Inspect this before delivering start.
  f.receive(shellMarker(record.shellTracking.nonce,1,'D',0)); assert.equal(f.device.inspectExecution(record.id).executionStatus,'unknown');
  f.receive(shellMarker(record.shellTracking.nonce,1,'C')+'fine\n'+shellMarker(record.shellTracking.nonce,1,'D',7)+'\r\nroot@bee:~# ');
  const done=f.device.inspectExecution(record.id); assert.equal(done.executionStatus,'completed'); assert.equal(done.exitCode,7); assert.match(done.evidence,/fine/);
});
test('integration never bypasses dangerous command approval and rejected input does not consume sequence', async () => {
  const f=fixture(); await enable(f); const before=f.sent.length;
  const pending=f.device.execute({text:'rm -rf /tmp/example',appendEnter:true,trackExit:true});
  const record=f.device.getRecords().at(-1); assert.equal(record.state,'awaiting-approval'); assert.equal(f.sent.length,before);
  f.device.reject(record.id); await assert.rejects(pending,/rejected/);
  const next=await f.device.execute({text:'uname -a',appendEnter:true,trackExit:true}); assert.equal(next.shellTracking.sequence,1);
});
test('reset, session changes, boot output and handshake expiry disable future integration without resending input', async () => {
  for(const change of ['reset','session','boot']) {
    const f=fixture(); await enable(f); const before=f.sent.length;
    if(change==='reset')f.device.reset(); if(change==='session')f.status.sessionId++; if(change==='boot')f.receive('\r\nU-Boot 2026\r\nroot@bee:~# ');
    assert.equal(f.device.getStatus().shellIntegration.status,'disabled'); assert.equal(f.sent.length,before);
  }
  const f=fixture(),record=await f.device.enableShellIntegration(); f.device.expireShellIntegration(record.id);
  f.receive(shellMarker(record.shellTracking.nonce,0,'R')); assert.equal(f.device.inspectExecution(record.id).executionStatus,'unknown');
  assert.equal(f.device.getStatus().shellIntegration.status,'disabled'); assert.equal(f.sent.length,1);
});
test('unexpected command sequence is interrupted, not reported completed or retried', async () => {
  const f=fixture(); await enable(f); const record=await f.device.execute({text:'true',appendEnter:true,trackExit:true});
  f.receive(shellMarker(record.shellTracking.nonce,2,'C')+shellMarker(record.shellTracking.nonce,2,'D',0));
  const inspected=f.device.inspectExecution(record.id); assert.equal(inspected.executionStatus,'unknown'); assert.equal(inspected.observation,'interrupted');
  assert.equal(f.device.getStatus().shellIntegration.status,'disabled'); assert.equal(f.sent.length,2);
});
test('reading mode removes only registered OSC boundaries, preserving raw input and unknown sequences', () => {
  const tracking={protocol:'osc',nonce,sequence:1,phase:'command'}, command='uname -a',payload="__linkr_run_v1 'uname -a'\r";
  const filter=createSerialPresentation();filter.register({command,payload,shellTracking:tracking,completionToken:'LINKR_OSC_'+nonce+'_1'});
  const raw=payload+'\n'+shellMarker(nonce,1,'C')+'Linux\r\n'+shellMarker(nonce,1,'D',0), bytes=encode(raw), before=bytes.slice(), result=[];
  for(const byte of bytes)result.push(filter.push(Uint8Array.of(byte))); result.push(filter.flush());
  assert.equal(Buffer.concat(result).toString(),'uname -a\r\nLinux\r\n[Agent] exit=0\r\n'); assert.deepEqual(bytes,before);
  const unknown=encode(shellMarker(other,1,'C')); assert.deepEqual(filter.push(unknown),unknown);
});

test('disabling integration while approval is pending cannot silently re-enable it', async () => {
  const f=fixture(); await enable(f); const before=f.sent.length;
  const pending=f.device.execute({text:'sudo id',appendEnter:true,trackExit:true});
  const record=f.device.getRecords().at(-1); f.device.disableShellIntegration(); f.device.approve(record.id);
  await assert.rejects(pending,/integration changed/); assert.equal(f.sent.length,before);
  assert.equal(f.device.getStatus().shellIntegration.status,'disabled');
});
test('lost helper or stripped boundaries stay unknown and never trigger automatic resend', async () => {
  const f=fixture(); await enable(f);
  const record=await f.device.execute({text:'uname -a',appendEnter:true,trackExit:true});
  f.receive('__linkr_run_v1: not found\r\nroot@bee:~# ');
  assert.equal(f.device.inspectExecution(record.id).executionStatus,'unknown');
  assert.equal(f.device.getStatus().shellIntegration.status,'disabled'); assert.equal(f.sent.length,2);
  // Only a separate, explicit execute uses ordinary tracking afterward.
  const next=await f.device.execute({text:'uname -a',appendEnter:true,trackExit:true});
  assert.equal(next.shellTracking,undefined); assert.match(next.payload,/LINKR_EXIT_/); assert.equal(f.sent.length,3);
});

test('one burst of protocol events has a bounded parser and journal window',()=>{
  const raw=Array.from({length:400},(_,index)=>shellMarker(nonce,index+1,'C')).join('');
  const parser=createShellMarkerParser();assert.equal(parser.push(raw,0).length,128);
  const journal=new SerialJournal();journal.append(encode(raw));assert.equal(journal.readExecutionEvents().length,128);
});

test('observing a prior unresolved command cannot silently re-arm a lost helper',async()=>{
  const f=fixture();await enable(f);
  await f.device.execute({text:'true',appendEnter:true,trackExit:true});
  f.receive('__linkr_run_v1: not found\r\nroot@bee:~# ');
  await assert.rejects(f.device.execute({text:'uname -a',appendEnter:true,trackExit:true}),/integration changed/);
  assert.equal(f.sent.length,2);assert.equal(f.device.getStatus().shellIntegration.status,'disabled');
});

for (const suffix of [String.raw`\033]0;unfinished`, String.raw`\033[31`, String.raw`\033PqPRIVATE`]) {
  test(`helper completion recovers after unfinished terminal control ${JSON.stringify(suffix)}`, () => {
    const raw=execFileSync('/bin/sh',['-c',shellIntegrationCommand(nonce)+'; '+SHELL_FUNCTION+' '+shellQuote(`printf '${suffix}'`)],{encoding:'utf8'});
    const journal=new SerialJournal();
    for(const byte of encode(raw))journal.append(Uint8Array.of(byte));
    assert.deepEqual(journal.readExecutionEvents().map(event=>event.phase),['R','C','D']);
    assert.equal(journal.readExecutionEvents().at(-1).exitCode,0);
  });
}
test('command output resembling a boot or login banner does not disable a verified helper',async()=>{
  for(const text of ['Linux version 6.12.0-test (builder)\r\n','U-Boot 2026 diagnostic text\r\n','bee login: ']) {
    const f=fixture();await enable(f);
    const record=await f.device.execute({text:'cat /proc/version',appendEnter:true,trackExit:true});
    f.receive(shellMarker(record.shellTracking.nonce,1,'C')+text);
    assert.equal(f.device.getStatus().shellIntegration.status,'ready');
    f.receive(shellMarker(record.shellTracking.nonce,1,'D',0)+'\r\nroot@bee:~# ');
    assert.equal(f.device.inspectExecution(record.id).executionStatus,'completed');
    assert.equal(f.device.getStatus().shellIntegration.status,'ready');
  }
});
test('ambient boot banners still invalidate integration when split across reads or following a completed frame',async()=>{
  const f=fixture();await enable(f);
  f.receive('\r\nU-Bo');assert.equal(f.device.getStatus().shellIntegration.status,'ready');
  f.receive('ot 2026\r\n');assert.equal(f.device.getStatus().shellIntegration.status,'disabled');
  const g=fixture();await enable(g);
  const record=await g.device.execute({text:'true',appendEnter:true,trackExit:true});
  g.receive(shellMarker(record.shellTracking.nonce,1,'C')+shellMarker(record.shellTracking.nonce,1,'D',0)+'\r\nU-Boot 2026\r\n');
  g.device.inspectExecution(record.id);assert.equal(g.device.getStatus().shellIntegration.status,'disabled');
});

test('a reboot without an end marker remains unknown and cannot re-arm the next helper call',async()=>{
  const f=fixture();await enable(f);
  const record=await f.device.execute({text:'reboot',appendEnter:true,trackExit:true});
  f.receive(shellMarker(record.shellTracking.nonce,1,'C')+'\r\nLinux version 6.12.0\r\nroot@bee:~# ');
  assert.equal(f.device.inspectExecution(record.id).executionStatus,'unknown');
  assert.equal(f.device.getStatus().shellIntegration.status,'disabled');assert.equal(f.sent.length,2);
});
test('ambient boot scanning covers every retained page instead of skipping the tail before the next send',async()=>{
  const f=fixture();await enable(f);
  f.receive('background line\r\n'.repeat(2000)+'U-Boot 2026\r\nroot@bee:~# ');
  assert.equal(f.device.getStatus().shellIntegration.status,'disabled');assert.equal(f.sent.length,1);
});
