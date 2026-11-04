import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createShellMarkerParser } from '../../web/shell_integration.js';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('linkr-lang','en'));
  await page.route('**/app.js?*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nwindow.__shellTest={state,setConnected,handleIncomingBytes,setSettingsPage,setMobileSidebarOpen,setLogView,renderShellIntegration,getDevice:()=>agentPanel.getDevice()};'});
  });
  const child=spawn('/bin/sh',['-s'],{stdio:['pipe','pipe','pipe']});
  const parser=createShellMarkerParser(); let offset=0,tail='',markerTail='',delivery=Promise.resolve();
  page.on('close',()=>child.kill());
  function receive(data) {
    const text=data.toString('utf8'),events=parser.push(text,offset);offset+=text.length;
    const legacy=/LINKR_EXIT_[a-f0-9]{32}:[0-9]{1,3}\r?\n/.test(markerTail+text);
    markerTail=legacy?'':(markerTail+text).slice(-80);
    const prompt=legacy||events.some(event=>event.phase==='R'||event.phase==='D')?'\r\nroot@bee:~# ':'';
    delivery=delivery.then(()=>page.evaluate(({text,prompt})=>{
      if(window.dropShellHandshake&&text.includes(':0:R'))return;
      window.__shellTest.handleIncomingBytes(new TextEncoder().encode(text+prompt));
    },{text,prompt})).catch(()=>{});
  }
  child.stdout.on('data',receive);child.stderr.on('data',receive);
  await page.exposeFunction('writeTestShell',async text=>{
    tail+=text;
    let end;
    while((end=tail.search(/[\r\n]/))>=0){
      const line=tail.slice(0,end);tail=tail.slice(end+1);
      if(!line||line.startsWith('stty '))continue;
      await page.evaluate(line=>window.__shellTest.handleIncomingBytes(new TextEncoder().encode(line+'\r\n')),line);
      await new Promise((resolve,reject)=>child.stdin.write(line+'\n',error=>error?reject(error):resolve()));
    }
  });
  await page.goto('/');await page.waitForFunction(()=>window.__shellTest?.state.term);
  await page.evaluate(()=>{
    const c=window.__shellTest;window.shellSent=[];c.state.mode='ws';
    c.state.ws={readyState:1,send:bytes=>{const text=new TextDecoder().decode(bytes);window.shellSent.push(text);void window.writeTestShell(text);}};
    c.setConnected(true);document.querySelector('#clearButton').click();
    c.handleIncomingBytes(new TextEncoder().encode('root@bee:~# '));
    c.setSettingsPage('terminal');c.setMobileSidebarOpen(true);
  });
  await page.locator('#shellIntegrationEnable').scrollIntoViewIfNeeded();
  await expect(page.locator('#shellIntegrationEnable')).toBeEnabled();
});
async function enable(page){
  await page.locator('#shellIntegrationEnable').click();
  await expect(page.locator('#shellIntegrationStatus')).toContainText('Enabled ·');
  await expect(page.locator('#shellIntegrationDisable')).toBeEnabled();
  await expect(page.locator('.agent-activity').last()).toHaveAttribute('data-state','done');
}
async function run(page,text='uname -r'){
  // Full Auto still asks for opaque shell syntax. Start without awaiting so
  // the test can inspect and explicitly approve that same pending request.
  await page.evaluate(text=>{
    const d=window.__shellTest.getDevice();d.setMode('full-auto');
    window.shellExecution=d.execute({text,appendEnter:true,trackExit:true});
  },text);
  const pending=await page.evaluate(()=>window.__shellTest.getDevice().getRecords().at(-1));
  if (pending.state==='awaiting-approval') {
    expect(pending.command).toBe(text);
    expect(await page.evaluate(id=>window.__shellTest.getDevice().approve(id),pending.id)).toBe(true);
  }
  const id=await page.evaluate(async()=>(await window.shellExecution).id);
  await expect.poll(()=>page.evaluate(id=>window.__shellTest.getDevice().inspectExecution(id).executionStatus,id)).toBe('completed');
  return page.evaluate(id=>window.__shellTest.getDevice().inspectExecution(id),id);
}
test('explicit enable handshakes with a real POSIX shell and later calls have no random wire ID',async({page})=>{
  await enable(page);await page.evaluate(()=>window.shellSent=[]);
  const record=await run(page,'printf "result\\n"; exit 7');
  await expect(page.locator('.agent-activity').last()).toHaveAttribute('data-state','done');
  expect(record.exitCode).toBe(7);expect(record.payload).toBe("__linkr_run_v1 'printf \"result\\n\"; exit 7'\r");
  expect(record.payload).not.toContain(record.shellTracking.nonce);expect(record.evidence).not.toContain('\x1b]');
  expect(await page.evaluate(()=>window.shellSent.join(''))).not.toContain('LINKR_EXIT_');
  const output=await page.evaluate(()=>{const b=window.__shellTest.state.term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)).join('\n');});
  expect(output).toContain('[Agent] exit=7');
});
test('OSC raw export retains bytes while reading export has short statuses; replay sends no input',async({page})=>{
  await enable(page);await run(page,'printf output');
  for(const [button,raw]of[['#saveRawLog',true],['#saveReadingLog',false]]){
    const event=page.waitForEvent('download');await page.locator(button).click();const download=await event;
    const text=await readFile(await download.path(),'utf8');
    expect(text.includes('\x1b]633;P;Linkr=1:')).toBe(raw);
    if(!raw)expect(text).toContain('[Agent] exit=0');
  }
  await page.waitForTimeout(300);await page.evaluate(()=>{window.shellSent=[];window.__shellTest.setLogView('raw');});
  await expect(page.locator('#terminalOutput')).not.toHaveAttribute('aria-busy','true');
  await page.evaluate(()=>window.__shellTest.setLogView('reading'));
  await expect(page.locator('#terminalOutput')).not.toHaveAttribute('aria-busy','true');
  await page.waitForTimeout(400);expect(await page.evaluate(()=>window.shellSent)).toEqual([]);
});
test('disable sends nothing and later commands use compatibility tracking; reconnect requires enable again',async({page})=>{
  await enable(page);await page.evaluate(()=>window.shellSent=[]);
  await page.locator('#shellIntegrationDisable').click();expect(await page.evaluate(()=>window.shellSent)).toEqual([]);
  const record=await run(page);expect(record.shellTracking).toBeUndefined();expect(record.payload).toContain('LINKR_EXIT_');
  // The owned namespace can be reinstalled in the same shell.
  await expect(page.locator('#shellIntegrationEnable')).toBeEnabled();await enable(page);
  await page.evaluate(()=>{window.__shellTest.setConnected(false);window.__shellTest.setConnected(true);});
  await expect(page.locator('#shellIntegrationStatus')).toContainText('Normal tracking');
});
test('Full Auto still asks before a destructive original command even with the short helper wrapper',async({page})=>{
  await enable(page);
  await page.evaluate(()=>{const d=window.__shellTest.getDevice();d.setMode('full-auto');window.blockedShellCommand=d.execute({text:'sudo id',appendEnter:true,trackExit:true}).catch(error=>error.message);});
  const record=await page.evaluate(()=>window.__shellTest.getDevice().getRecords().at(-1));
  expect(record.state).toBe('awaiting-approval');
  expect(record.command).toBe('sudo id');
  await page.evaluate(id=>window.__shellTest.getDevice().reject(id),record.id);
  expect(await page.evaluate(()=>window.blockedShellCommand)).toContain('rejected');
});
test('a lost handshake reports failure once, with no automatic retry',async({page},testInfo)=>{
  test.setTimeout(20000);await page.evaluate(()=>window.dropShellHandshake=true);
  await page.locator('#shellIntegrationEnable').click();
  await expect(page.locator('#shellIntegrationStatus')).toContainText('Handshake unconfirmed',{timeout:13000});
  expect(await page.evaluate(()=>window.__shellTest.getDevice().getRecords().length)).toBe(1);
  await expect(page.locator('#shellIntegrationDisable')).toBeDisabled();
  await page.screenshot({path:testInfo.outputPath('handshake-timeout.png')});
});

test('unfinished child control strings cannot swallow completion or subsequent terminal output',async({page},testInfo)=>{
  await enable(page);
  for(const suffix of [String.raw`\033]0;unfinished`,String.raw`\033[31`,String.raw`\033PqPRIVATE`]) {
    const record=await run(page,`printf '${suffix}'`);expect(record.exitCode).toBe(0);
  }
  await run(page,String.raw`printf 'AFTER_CONTROL_RECOVERY\n'`);
  await expect.poll(()=>page.evaluate(()=>{
    const buffer=window.__shellTest.state.term.buffer.active;
    return Array.from({length:buffer.length},(_,index)=>buffer.getLine(index).translateToString(true)).join('\n');
  })).toContain('AFTER_CONTROL_RECOVERY');
  await expect(page.locator('#shellIntegrationStatus')).toContainText('Enabled ·');
  await page.evaluate(()=>window.__shellTest.setMobileSidebarOpen(false));
  await page.screenshot({path:testInfo.outputPath('terminal-control-recovery.png')});
});
test('version and boot-log queries keep the next command on the enabled helper',async({page})=>{
  await enable(page);
  for(const line of ['Linux version 6.12.0-test','U-Boot 2026 diagnostic output']) {
    const record=await run(page,`printf '${line}\\n'`);expect(record.exitCode).toBe(0);
    await expect(page.locator('#shellIntegrationStatus')).toContainText('Enabled ·');
  }
  const next=await run(page,'printf READY');expect(next.payload).toMatch(/^__linkr_run_v1 /);
});
