import { test, expect } from '@playwright/test';
test.beforeEach(async ({page}) => {
  await page.route('**/app.js?*', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nwindow.bondTest={state,setConnected,setSettingsPage,renderSerialControl,onDisconnected,autoReconnect, query:()=>bondUi.query(),mock:fn=>{sendControl=fn}};'});
  });
  await page.goto('/');
  await page.waitForFunction(()=>window.bondTest?.state.term);
  await page.evaluate(()=>{
    const t=window.bondTest; window.commands=[]; window.bondsReply='OK bonds pending=0 result=0\nBOND 0/AA:BB:CC:DD:EE:01 self=1\nBOND 1/AA:BB:CC:DD:EE:02 self=0\n';
    window.bondLabels={'0/AA:BB:CC:DD:EE:01':'Web','1/AA:BB:CC:DD:EE:02':'Chrome · Linux'};
    window.toHex=s=>Array.from(new TextEncoder().encode(s),b=>b.toString(16).padStart(2,'0')).join('');
    window.fromHex=h=>new TextDecoder().decode(Uint8Array.from(h.match(/../g)||[],x=>parseInt(x,16)));
    t.mock(async cmd=>{window.commands.push(cmd); if(cmd==='@linkr bonds?')return window.bondsReply;
      if(cmd.startsWith('@linkr bonds label ')){
        const [id,value]=cmd.slice('@linkr bonds label '.length).split(' ');
        if(!value){const l=window.bondLabels[id]||'';return l?`OK bonds label=${id} hex=${window.toHex(l)}`:`OK bonds label=${id} none`;}
        if(value==='clear'){delete window.bondLabels[id];return `OK bonds label=${id} none`;}
        window.bondLabels[id]=window.fromHex(value);return `OK bonds label=${id} hex=${value}`;
      }
      if(cmd.startsWith('@linkr bonds name ')){
        const label=cmd.slice('@linkr bonds name '.length); window.bondLabels['0/AA:BB:CC:DD:EE:01']=label; return 'OK bonds name';
      }
      if(cmd==='@linkr bonds name'){delete window.bondLabels['0/AA:BB:CC:DD:EE:01'];return 'OK bonds name';}
      if(cmd.startsWith('@linkr bonds remove ')) {
        if(cmd.endsWith('01'))setTimeout(()=>t.onDisconnected({unexpected:true}),50);
        else window.bondsReply='OK bonds pending=0 result=0\nBOND 0/AA:BB:CC:DD:EE:01 self=1\n';
        return 'OK bonds queued';
      } return 'ERR unsupported';
    });
    t.state.mode='ble';t.state.mgmtReady=true;t.setConnected(true);t.setSettingsPage('connection');
  });
  await page.locator('#panelToggle').tap();
  await expect(page.locator('.bond-row')).toHaveCount(2);
});
test('lists identities, cancel is inert, removal is confirmed by refreshed list',async({page})=>{
  await expect(page.locator('.bond-row').first()).toContainText('This host');
  page.once('dialog',d=>d.dismiss());await page.locator('.bond-row').last().locator('[data-bond-action="remove"]').click();
  expect(await page.evaluate(()=>window.commands.filter(c=>c.includes('remove')))).toEqual([]);
  page.once('dialog',d=>d.accept());await page.locator('.bond-row').last().locator('[data-bond-action="remove"]').click();
  await expect(page.locator('.bond-row')).toHaveCount(1);
  expect(await page.evaluate(()=>window.commands)).toContain('@linkr bonds remove 1/AA:BB:CC:DD:EE:02');
});
test('deleting this host does not schedule automatic reconnect',async({page})=>{
  page.once('dialog',d=>d.accept());await page.locator('.bond-row').first().locator('[data-bond-action="remove"]').click();
  await expect.poll(()=>page.evaluate(()=>window.bondTest.state.connected)).toBe(false);
  expect(await page.evaluate(()=>window.bondTest.autoReconnect.active)).toBe(false);
  await expect(page.locator('.bond-row')).toHaveCount(0);
});
test('readonly host can rename itself but cannot delete or rename others',async({page})=>{
  await page.evaluate(()=>{const t=window.bondTest;t.state.serialControl={mode:'readonly',self:1,owner:2,peers:2};t.renderSerialControl()});
  await expect(page.locator('.bond-row').first().locator('[data-bond-action="rename"]')).toBeEnabled();
  await expect(page.locator('.bond-row').first().locator('[data-bond-action="remove"]')).toBeDisabled();
  await expect(page.locator('.bond-row').last().locator('[data-bond-action="rename"]')).toHaveCount(0);
  await expect(page.locator('[data-bonds-refresh]')).toBeEnabled();
});
test('renaming this host uses the self-only form',async({page})=>{
  const first=page.locator('.bond-row').first();
  await first.locator('[data-bond-action="rename"]').click();
  const input=first.locator('.bond-input');
  await input.fill('My Phone');
  await first.locator('[data-bond-action="save"]').click();
  await expect(first.locator('.bond-name')).toHaveText('My Phone');
  expect(await page.evaluate(()=>window.commands)).toContain('@linkr bonds name My Phone');
});
test('renaming another host uses the address form and needs control',async({page})=>{
  const last=page.locator('.bond-row').last();
  await last.locator('[data-bond-action="rename"]').click();
  const input=last.locator('.bond-input');
  await input.fill('Tablet');
  await last.locator('[data-bond-action="save"]').click();
  await expect(last.locator('.bond-name')).toHaveText('Tablet');
  expect(await page.evaluate(()=>window.commands)).toContain('@linkr bonds label 1/AA:BB:CC:DD:EE:02 5461626c6574');
});
test('unsupported firmware hides the paired-devices card',async({page})=>{
  await page.evaluate(async()=>{window.bondsReply='ERR unknown command';await window.bondTest.query()});
  await expect(page.locator('#boardBondsCard')).toBeHidden();
  await expect(page.locator('[data-settings-target="connection"]')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('[data-settings-target="board"]')).toBeVisible();
});

test('a late names response cannot overwrite a new connection', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {createBondUi} = await import('/bond_ui.js');
    const card = document.querySelector('#boardBondsCard').cloneNode(true);
    let generation = 1, release;
    const oldNames = new Promise(resolve => {release = resolve});
    const ui = createBondUi({card,
      context: () => ({ready:true, control:true, generation, lang:'en'}),
      supported: () => {}, beforeSelfDelete: () => {}, afterSelfDelete: () => {},
      send: async cmd => cmd === '@linkr bonds?' ? 'OK bonds pending=0 result=0\nBOND 0/AA:BB:CC:DD:EE:01 self=1\n'
        : cmd.startsWith('@linkr bonds label ') ? 'ERR unknown command'
        : cmd === '@linkr bonds names?' ? generation === 1 ? oldNames : 'OK bonds names\nNAME 0/AA:BB:CC:DD:EE:01 "New host"\n' : 'OK bonds name',
    });
    const oldQuery = ui.query();
    await Promise.resolve();await Promise.resolve();
    generation = 2;ui.render();await ui.query();
    release('OK bonds names\nNAME 0/AA:BB:CC:DD:EE:01 "Old host"\n');
    await oldQuery;ui.render();
    return card.querySelector('.bond-row').textContent;
  });
  expect(result).toContain('New host');expect(result).not.toContain('Old host');
});
test('named hosts keep their identity visible in delete confirmation', async ({page}) => {
  await page.evaluate(async () => {
    window.bondTest.mock(async cmd => {
      if (cmd === '@linkr bonds?') return window.bondsReply;
      if (cmd.startsWith('@linkr bonds label ')) {
        const id = cmd.slice('@linkr bonds label '.length);
        const label = window.bondLabels[id] || '';
        return label ? `OK bonds label=${id} hex=${window.toHex(label)}` : `OK bonds label=${id} none`;
      }
      return 'OK bonds name';
    });
    await window.bondTest.query();
  });
  let warning;
  page.once('dialog', async prompt => {warning = prompt.message(); await prompt.dismiss()});
  await page.locator('.bond-row').last().locator('[data-bond-action="remove"]').click();
  expect(warning).toContain('Chrome · Linux (1/AA:BB:CC:DD:EE:02)');
});
