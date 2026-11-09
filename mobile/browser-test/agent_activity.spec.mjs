import {test,expect} from '@playwright/test';
const sampleReasoning='Compare the observed console with the device status before suggesting a command.';
function sse({text='',thinking='',tool=null}) {
  const deltas=[{role:'assistant'},...(thinking?[{reasoning_content:thinking.slice(0,24)},{reasoning_content:thinking.slice(24)}]:[]),...(text?[{content:text}]:[]),...(tool?[{tool_calls:[{index:0,id:'call-'+crypto.randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args||{})}}]}]:[])];
  const chunk=(delta,finish_reason)=>JSON.stringify({id:'activity',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]});
  return [...deltas.map(delta=>`data: ${chunk(delta,null)}\n\n`),`data: ${chunk({},tool?'tool_calls':'stop')}\n\n`,'data: [DONE]\n\n'].join('');
}
async function setup(page,respond,{lang='en',theme='dark',resident=false}={}){
  const requests=[];
  if (resident) await page.addInitScript(() => {
    const state = {running:false, foreground:true, token:'fixture', url:'http://127.0.0.1:8712/mcp'};
    window.LinkrMcp = {available:true, platform:'android',
      async getState() { return {...state}; }, async stop() { return {...state}; },
      async addListener() { return {async remove() {}}; }, async respond() {}};
  });
  await page.addInitScript(({lang,theme})=>{localStorage.setItem('linkr-lang',lang);localStorage.setItem('linkr-theme',theme);localStorage.setItem('linkr-sidebar','closed');localStorage.setItem('linkr-agent-model',JSON.stringify({endpoint:'https://activity.test/v1',model:'fixture',reasoning:'low'}));},{lang,theme});
  await page.route('**/app.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nwindow.__activity={state,setConnected,setMobileSidebarOpen,handleIncomingBytes,applySerialControl,startSerialControlPoll,residentAgent,consumeSerialControl};'});});
  await page.route('https://activity.test/v1/chat/completions',async route=>{
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*'};
    if(route.request().method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
    const request=route.request().postDataJSON();requests.push(request);const response=await respond(request,requests.length);
    await route.fulfill({status:200,headers,contentType:'text/event-stream',body:sse(response)});
  });
  await page.goto('/');await page.waitForFunction(()=>window.__activity?.state.term);
  await page.evaluate(()=>{const c=window.__activity;window.sent=[];c.state.mode='ws';c.state.wsHost='activity-board';c.state.ws={readyState:1,send:bytes=>{const text=new TextDecoder().decode(bytes);if(!text.startsWith('stty '))window.sent.push(text)}};c.setConnected(true);c.setMobileSidebarOpen(false,{restoreFocus:false});});
  await page.locator('#agentButton').click();return requests;
}
async function ask(page,text='Check the device status') {await page.locator('#agentQuestion').fill(text);await page.locator('#agentQuestion').press('Enter');}
const reply=(request,round)=>round===1?{thinking:sampleReasoning,text:'I will check the connected device first.',tool:{name:'get_device_status'}}:{text:'## Result\nThe bridge is connected.\n\nNo command was sent.'};

test('reasoning, intermediate notes and tool output fold away from the final answer',async({page},info)=>{
  await setup(page,reply);await ask(page);await expect(page.locator('#agentAsk')).toBeEnabled();
  const group=page.locator('.agent-activity');await expect(group).toHaveCount(1);await expect(group).not.toHaveAttribute('open');await expect(group).toHaveAttribute('data-state','done');
  await expect(page.locator('.agent-assistant:not(.agent-process-entry)')).toContainText('The bridge is connected.');
  await group.locator(':scope > summary').click();await expect(group).toContainText('I will check the connected device first.');
  const reasoning=group.locator('.agent-reasoning');await expect(reasoning).not.toHaveAttribute('open');
  await reasoning.locator('summary').click();await expect(reasoning.locator('.agent-message-text')).toHaveText(sampleReasoning);
  await page.screenshot({path:info.outputPath('activity-expanded.png')});
  expect(await page.evaluate(()=>window.sent)).toEqual([]);
});

test('manual disclosure expansion survives streaming and completion',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  await setup(page,async(request,round)=>{if(round===2)await gate;return reply(request,round)});await ask(page);
  const group=page.locator('.agent-activity');await expect(group).toHaveAttribute('data-state','running');await group.locator(':scope > summary').click();
  release();await expect(page.locator('#agentAsk')).toBeEnabled();await expect(group).toHaveAttribute('open','');
});

test('a tool error remains expanded and final answer text stays ordinary text',async({page})=>{
  await setup(page,(request,round)=>round===1?{tool:{name:'missing_tool'}}:{text:'Thinking about the issue is not a separate reasoning channel. The tool is unavailable.'});
  await ask(page);await expect(page.locator('#agentAsk')).toBeEnabled();
  await expect(page.locator('.agent-activity')).toHaveAttribute('data-state','error');await expect(page.locator('.agent-activity')).toHaveAttribute('open','');
  await expect(page.locator('.agent-reasoning')).toHaveCount(0);await expect(page.locator('.agent-assistant').last()).toContainText('Thinking about the issue');
});

test('manual serial approval automatically opens the activity without sending input',async({page})=>{
  await setup(page,(request,round)=>round===1?{tool:{name:'read_serial_log'}}:round===2?{tool:{name:'send_serial_input',args:{text:'uname -a',appendEnter:true}}}:{text:'Request rejected; no input was sent.'});
  await page.evaluate(()=>window.__activity.handleIncomingBytes(new TextEncoder().encode('root@board:~# ')));
  await page.locator('#agentModeButton').click();await page.locator('[name="agentMode"][value="manual"]').locator('..').click();
  await ask(page);const group=page.locator('.agent-activity');await expect(group).toHaveAttribute('open','');
  await expect(group.getByRole('button',{name:'Send',exact:true})).toBeVisible();expect(await page.evaluate(()=>window.sent)).toEqual([]);
  await group.getByRole('button',{name:'Reject',exact:true}).click();await expect(page.locator('#agentAsk')).toBeEnabled();expect(await page.evaluate(()=>window.sent)).toEqual([]);
});

test('stop settles the activity indicator and restored progress remains folded',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  await setup(page,async(request,round)=>{if(round===2)await gate;return reply(request,round)});await ask(page);
  await expect(page.locator('.agent-activity')).toHaveAttribute('data-state','running');await page.locator('#agentStop').click();release();
  await expect(page.locator('.agent-activity')).toHaveAttribute('data-state','interrupted');await expect(page.locator('#agentAsk')).toBeEnabled();
  await page.waitForTimeout(600);await page.reload();await page.waitForFunction(()=>window.__activity?.state.term);
  await page.evaluate(()=>{const c=window.__activity;c.state.mode='ws';c.state.wsHost='activity-board';c.state.ws={readyState:1,send:()=>{}};c.setConnected(true);c.setMobileSidebarOpen(false,{restoreFocus:false})});
  await page.locator('#agentButton').click();await expect(page.locator('.agent-activity')).toHaveCount(1);await expect(page.locator('.agent-activity')).not.toHaveAttribute('open');
});

test('Enter sends, Shift+Enter adds a line, and IME composition never sends',async({page})=>{
  const requests=await setup(page,()=>({text:'Received.'}));const input=page.locator('#agentQuestion');await input.fill('First line');await input.press('Shift+Enter');await expect(input).toHaveValue('First line\n');
  await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});await input.dispatchEvent('keydown',{key:'Enter',keyCode:229});expect(requests).toHaveLength(0);
  await input.press('Enter');await expect(page.locator('#agentAsk')).toBeEnabled();expect(requests).toHaveLength(1);expect(requests[0].messages.findLast(message=>message.role==='user').content).toEqual([{type:'text',text:'First line'}]);
  await input.fill('Second message');await input.press('Control+Enter');await expect(page.locator('#agentAsk')).toBeEnabled();expect(requests).toHaveLength(2);expect(await page.evaluate(()=>window.sent)).toEqual([]);
});

test('Enter while running queues a follow-up instead of writing to UART',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const requests=await setup(page,async(request,round)=>{if(round===1)await gate;return{text:round===1?'First result.':'Follow-up result.'}});await ask(page);
  await expect(page.locator('#agentFollowUp')).toBeEnabled();await page.locator('#agentQuestion').fill('Next task');await page.locator('#agentQuestion').press('Enter');
  await expect(page.locator('#agentQueue')).toContainText('Next task');release();await expect(page.locator('#agentAsk')).toBeEnabled();expect(requests).toHaveLength(2);expect(await page.evaluate(()=>window.sent)).toEqual([]);
});

for(const width of [338,390,834,1440])for(const lang of ['en','zh'])for(const theme of ['dark','light'])test(`polished assistant ${width}px ${lang} ${theme}`,async({page},info)=>{
  await page.setViewportSize({width,height:width<600?844:1000});await setup(page,lang==='zh'?((request,round)=>round===1?{thinking:'先对照串口证据与设备状态，再决定下一步排查范围。',text:'先读取当前设备状态。',tool:{name:'get_device_status'}}:{text:'## 检查结果\n桥接器已连接。\n\n本轮只查询状态，没有向串口发送命令。'}):reply,{lang,theme});await ask(page,lang==='zh'?'检查设备连接状态':'Check the device status');
  await expect(page.locator('#agentAsk')).toBeEnabled();await expect(page.locator('.agent-activity')).not.toHaveAttribute('open');
  expect(await page.locator('#agentPanel').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  expect(await page.locator('#agentForm').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
  await page.screenshot({path:info.outputPath(`assistant-${lang}-${theme}-${width}.png`)});
});

async function enableAgentLed(page) {
  await page.evaluate(() => {
    const app = window.__activity;
    window.ledFrames = [];
    app.state.serialControl = {self:1, owner:1, mode:"control", epoch:7, peers:1, capacity:2, agentLed:true};
    const original = app.state.ws.send;
    app.state.ws.send = bytes => typeof bytes === "string" ? window.ledFrames.push(bytes) : original(bytes);
    app.startSerialControlPoll();
  });
}

test('AI takeover LED notifies start and completion over the management channel', async ({page}) => {
  await setup(page, reply);
  await enableAgentLed(page);
  await ask(page);
  await expect(page.locator('#agentAsk')).toBeEnabled();
  const frames = await page.evaluate(() => window.ledFrames);
  expect(frames).toContain('@control ai on 7');
  expect(frames.at(-1)).toBe('@control ai off 7');
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});

test('AI LED heartbeat stops immediately on Stop while the model is still pending', async ({page}) => {
  let release; const gate = new Promise(resolve => release = resolve);
  await setup(page, async (request, round) => { if (round === 2) await gate; return reply(request, round); });
  await enableAgentLed(page);
  await ask(page);
  await expect.poll(() => page.evaluate(() => window.ledFrames.filter(f => f === '@control ai on 7').length)).toBeGreaterThan(1);
  await page.locator('#agentStop').click();
  await expect.poll(() => page.evaluate(() => window.ledFrames.at(-1))).toBe('@control ai off 7');
  release();
  await expect(page.locator('#agentAsk')).toBeEnabled();
});

test('ownership loss revokes AI takeover and never marks the new owner as AI', async ({page}) => {
  let release; const gate = new Promise(resolve => release = resolve);
  await setup(page, async (request, round) => { if (round === 2) await gate; return reply(request, round); });
  await enableAgentLed(page);
  await ask(page);
  await expect.poll(() => page.evaluate(() => window.ledFrames.includes('@control ai on 7'))).toBe(true);
  await page.evaluate(() => window.__activity.applySerialControl({self:1, owner:2, mode:"readonly", epoch:8, peers:2, capacity:2, agentLed:true}));
  release();
  await expect(page.locator('#agentAsk')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.ledFrames.at(-1))).toBe('@control ?');
  expect(await page.evaluate(() => window.ledFrames.some(f => f.startsWith('@control ai on 8')))).toBe(false);
});

test('resident AI tasks also notify takeover and completion', async ({page}) => {
  await setup(page, reply, {resident:true});
  await enableAgentLed(page);
  await page.evaluate(() => window.__activity.residentAgent.startTask({request:"Check the device status"}));
  await expect.poll(() => page.evaluate(() => window.ledFrames.includes('@control ai on 7'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.ledFrames.at(-1))).toBe('@control ai off 7');
});

for (const source of ['button', 'MCP']) test(`resident ${source} cancellation clears takeover before the pending model settles`, async ({page}) => {
  let release; const gate = new Promise(resolve => release = resolve);
  await setup(page, async (request, round) => { if (round === 2) await gate; return reply(request, round); }, {resident:true});
  await enableAgentLed(page);
  await page.evaluate(() => window.__activity.residentAgent.startTask({request:"Check the device status"}));
  await expect.poll(() => page.evaluate(() => window.ledFrames.includes('@control ai on 7'))).toBe(true);
  await expect(page.locator('#agentStop')).toBeEnabled();
  if (source === 'button') await page.locator('#agentStop').click();
  else await page.evaluate(() => window.__activity.residentAgent.cancelAll());
  await expect.poll(() => page.evaluate(() => window.ledFrames.at(-1))).toBe('@control ai off 7');
  await page.locator('#agentClose').click();
  expect(await page.evaluate(() => window.ledFrames.at(-1))).toBe('@control ai off 7');
  release();
  await expect(page.locator('#agentAsk')).toBeEnabled();
});

for (const error of ['not_owner', 'stale_epoch']) test(`rejected AI heartbeat (${error}) refreshes ownership instead of retrying forever`, async ({page}) => {
  let release; const gate = new Promise(resolve => release = resolve);
  await setup(page, async (request, round) => { if (round === 2) await gate; return reply(request, round); });
  await enableAgentLed(page);
  await ask(page);
  await expect.poll(() => page.evaluate(() => window.ledFrames.includes('@control ai on 7'))).toBe(true);
  await page.evaluate(error => window.__activity.consumeSerialControl(`ERR control=${error}\r\n`), error);
  release();
  await expect(page.locator('#agentAsk')).toBeEnabled();
  expect(await page.evaluate(() => window.__activity.state.serialControl.mode)).toBe('readonly');
  await expect.poll(() => page.evaluate(() => window.ledFrames.at(-1))).toBe('@control ?');
});

test('closing the assistant keeps the resident task takeover visible until completion', async ({page}) => {
  let release; const gate = new Promise(resolve => release = resolve);
  await setup(page, async (request, round) => { if (round === 2) await gate; return reply(request, round); }, {resident:true});
  await enableAgentLed(page);
  await page.evaluate(() => window.__activity.residentAgent.startTask({request:"Check the device status"}));
  await expect.poll(() => page.evaluate(() => window.ledFrames.includes('@control ai on 7'))).toBe(true);
  await page.locator('#agentClose').click();
  expect(await page.evaluate(() => window.__activity.residentAgent.isBusy())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.ledFrames.at(-1))).toBe('@control ai on 7');
  release();
  await expect.poll(() => page.evaluate(() => window.ledFrames.at(-1))).toBe('@control ai off 7');
});

test('reclaiming ownership cannot reactivate a retired resident task indication', async ({page}) => {
  let release; const gate = new Promise(resolve => release = resolve);
  await setup(page, async (request, round) => { if (round === 2) await gate; return reply(request, round); }, {resident:true});
  await enableAgentLed(page);
  await page.evaluate(() => window.__activity.residentAgent.startTask({request:"Check the device status"}));
  await expect.poll(() => page.evaluate(() => window.ledFrames.includes('@control ai on 7'))).toBe(true);
  await page.evaluate(() => {
    const app = window.__activity;
    app.applySerialControl({self:1, owner:2, mode:"readonly", epoch:8, peers:2, capacity:2, agentLed:true});
    app.applySerialControl({self:1, owner:1, mode:"control", epoch:9, peers:2, capacity:2, agentLed:true});
  });
  await expect.poll(() => page.evaluate(() => window.ledFrames.includes('@control ai off 9'))).toBe(true);
  expect(await page.evaluate(() => window.ledFrames.includes('@control ai on 9'))).toBe(false);
  release();
  await expect(page.locator('#agentAsk')).toBeEnabled();
});
