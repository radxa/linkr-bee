import {test,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
const question={question:'Where should the download be saved?',options:[{label:'Target machine',description:'Save on the connected board.'},{label:'This computer',description:'Save locally without changing the target.'}]};
function sse(tool){
  const chunk=(delta,finish_reason)=>JSON.stringify({id:'chatcmpl-choice',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]});
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'choice-1',type:'function',function:{name:'ask_user',arguments:JSON.stringify(tool)}}]}:{role:'assistant',content:'I received your answer.'};
  return `data: ${chunk(delta,null)}\n\ndata: ${chunk({},tool?'tool_calls':'stop')}\n\ndata: [DONE]\n\n`;
}
async function open(page,args=question,{lang='en',theme='dark',url='/'}={}){
  const requests=[];
  await page.addInitScript(({lang,theme})=>{
    localStorage.setItem('linkr-lang',lang);localStorage.setItem('linkr-theme',theme);localStorage.setItem('linkr-sidebar','closed');
    localStorage.setItem('linkr-agent-model',JSON.stringify({endpoint:'https://choice.test/v1',model:'fixture'}));
  },{lang,theme});
  await page.route('**/app.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nwindow.__choices={state,setConnected,setMobileSidebarOpen};'});});
  await page.route('https://choice.test/v1/chat/completions',async route=>{
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*'};
    if(route.request().method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
    requests.push(route.request().postDataJSON());await route.fulfill({status:200,headers,contentType:'text/event-stream',body:sse(requests.length===1?args:null)});
  });
  await page.goto(url);await page.waitForFunction(()=>window.__choices?.state.term);
  await page.evaluate(()=>{const c=window.__choices;c.state.mode='ws';window.serialSent=[];c.state.ws={readyState:1,send:bytes=>window.serialSent.push(bytes)};c.setConnected(true);c.setMobileSidebarOpen(false,{restoreFocus:false});});
  await page.locator('#agentButton').click();await page.locator('#agentQuestion').fill('Help me choose a destination');await page.locator('#agentAsk').click();
  await expect(page.locator('.agent-choice')).toBeVisible();return requests;
}
test('a single choice waits for explicit confirmation and returns the answer to Pi',async({page})=>{
  const requests=await open(page);const card=page.locator('.agent-choice');
  await expect(card.getByRole('button',{name:'Continue',exact:true})).toBeDisabled();
  await expect(card.locator('input:checked')).toHaveCount(0);expect(requests).toHaveLength(1);
  await card.getByRole('radio',{name:/This computer/}).check();expect(requests).toHaveLength(1);
  await card.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.locator('#agentAsk')).toBeEnabled();expect(requests).toHaveLength(2);
  const result=JSON.parse(requests[1].messages.findLast(message=>message.role==='tool').content);
  expect(result.selected).toEqual([{index:1,label:'This computer'}]);expect(result.grantsPermission).toBe(false);
  await expect(card.getByRole('radio',{name:/This computer/})).toBeDisabled();await expect(card).toContainText('Answered');
  expect(await page.evaluate(()=>window.serialSent)).toEqual([]);
});
test('multiple choices and custom details round-trip together',async({page})=>{
  const requests=await open(page,{...question,multiple:true});const card=page.locator('.agent-choice');
  await card.getByRole('checkbox',{name:/Target machine/}).check();await card.getByRole('checkbox',{name:/This computer/}).check();
  await card.getByRole('textbox').fill('Keep both copies.');await card.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.locator('#agentAsk')).toBeEnabled();
  const result=JSON.parse(requests[1].messages.findLast(message=>message.role==='tool').content);expect(result.selected).toHaveLength(2);expect(result.text).toBe('Keep both copies.');
});
test('a free-text-only answer is accepted without an invented selection',async({page})=>{
  const requests=await open(page);const card=page.locator('.agent-choice');await card.getByRole('textbox').fill('Use external storage');
  await card.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.locator('#agentAsk')).toBeEnabled();
  const result=JSON.parse(requests[1].messages.findLast(message=>message.role==='tool').content);expect(result.selected).toEqual([]);expect(result.text).toBe('Use external storage');
});
test('skipping tells the model that no choice was made',async({page})=>{
  const requests=await open(page);await page.locator('.agent-choice').getByRole('button',{name:'Skip',exact:true}).click();await expect(page.locator('#agentAsk')).toBeEnabled();
  expect(JSON.parse(requests[1].messages.findLast(message=>message.role==='tool').content)).toEqual({status:'cancelled',grantsPermission:false});
});
for(const action of ['stop','disconnect','close','mode'])test(`${action} cancels a pending choice and retires its controls`,async({page})=>{
  const requests=await open(page);
  if(action==='stop')await page.locator('#agentStop').click();
  if(action==='disconnect')await page.evaluate(()=>window.__choices.setConnected(false));
  if(action==='close')await page.locator('#agentClose').click();
  if(action==='mode'){await page.locator('#agentModeButton').click();await page.locator('[name="agentMode"][value="manual"]').locator('..').click();}
  await expect(page.locator('.agent-choice input').first()).toBeDisabled();
  await expect(page.locator('.agent-choice button[type="submit"]')).toBeDisabled();expect(requests).toHaveLength(1);
});
for(const width of [320,390,834,1440])for(const theme of ['dark','light'])for(const lang of ['zh','en'])test(`choice card fits ${width}px ${theme} ${lang}`,async({page},info)=>{
  await page.setViewportSize({width,height:width===320?640:900});
  await open(page,lang==='zh'?{question:'选择下一步处理方式',options:[{label:'先检查目标机的网络连接与下载工具',description:'仅查询相关能力，确认结果后再执行下一步。'},{label:'保持当前配置并提供手动操作说明',description:'保留当前设置，在此对话中展示完整说明。'}]}:question,{lang,theme});
  const card=page.locator('.agent-choice');await expect(card.getByRole('button',{name:lang==='zh'?'确认选择':'Continue',exact:true})).toBeDisabled();
  const metrics=await card.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,options:[...el.querySelectorAll('.agent-choice-option')].map(option=>option.getBoundingClientRect().height)}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.width+1);expect(Math.min(...metrics.options)).toBeGreaterThanOrEqual(44);
  await expect.poll(()=>page.locator('#agentMessages').evaluate(el=>el.clientHeight)).toBeGreaterThan(250);
  await expect(card.getByRole('radio').first()).toBeInViewport();
  await expect(card.locator('legend')).toBeInViewport();
  await page.screenshot({path:info.outputPath(`choice-${lang}-${theme}-${width}.png`)});
});

// The documented no-build static site ships the same interactive tool.
test('the static vendored Pi runtime exposes and completes a choice',async({page})=>{
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const server=spawn(process.execPath,[fileURLToPath(new URL('./static-server.mjs',import.meta.url)),String(port),fileURLToPath(new URL('../../web',import.meta.url))],{stdio:'ignore'});
  try {
  await expect.poll(async()=>{try{return (await fetch(`http://127.0.0.1:${port}/`)).ok}catch{return false}}).toBe(true);
  const requests=await open(page,question,{url:`http://127.0.0.1:${port}/`});
  await page.locator('.agent-choice').getByRole('radio',{name:/Target machine/}).check();
  await page.locator('.agent-choice').getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.locator('#agentAsk')).toBeEnabled();expect(requests).toHaveLength(2);
  } finally {server.kill();}
});

test('a pending phone question keeps the terminal accessible and restores the split after answering',async({page})=>{
  await open(page);
  // The assistant opens alone; the header toggle is what brings the terminal back.
  await expect(page.locator('#terminalCard')).toBeHidden();
  await expect(page.locator('#agentToggleTerminal')).toBeVisible();
  await page.locator('#agentToggleTerminal').click();
  await expect(page.locator('#terminalWorkspace')).toHaveAttribute('data-agent-layout','rows');
  // A required choice keeps the split for the question and leaves the log one tap away.
  await expect(page.locator('#agentShowTerminal')).toBeVisible();
  await page.locator('#agentShowTerminal').click();await expect(page.locator('#terminalCard')).toBeVisible();
  const card=page.locator('.agent-choice');await card.getByRole('radio',{name:/Target machine/}).check();
  await card.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.locator('#agentAsk')).toBeEnabled();
  await expect(page.locator('#terminalCard')).toBeVisible();
});
