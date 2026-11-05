import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('linkr-lang', 'en'));
  await page.route('**/app.js?*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + '\nwindow.__logView = { state, setConnected, handleIncomingBytes, setLogView, flushTerminalWrites, setSettingsPage, setMobileSidebarOpen, getDevice: () => agentPanel.getDevice(), readRaw: () => agentJournal.read().text };' });
  });
  await page.goto('/'); await page.waitForFunction(() => window.__logView?.state.term);
  await page.evaluate(() => {
    const c = window.__logView; window.sent = []; c.state.mode = 'ws';
    c.state.ws = { readyState: 1, send: bytes => window.sent.push(new TextDecoder().decode(bytes)) };
    c.setConnected(true); document.querySelector('#clearButton').click();
    c.handleIncomingBytes(new TextEncoder().encode('root@bee:~# ')); c.flushTerminalWrites();
  });
  await page.waitForTimeout(450);
});
async function trackedCommand(page) {
  return page.evaluate(async () => {
    const c = window.__logView, device = c.getDevice(); device.setMode('full-auto');
    const record = await device.execute({ text: 'uname -a', appendEnter: true, trackExit: true });
    const raw = record.payload.replace(/\r\n|\r|\n/g, '\r\n') + '\r\nLinux bee 6.12\r\n' + record.completionToken + ':7\r\nroot@bee:~# ';
    const bytes = new TextEncoder().encode(raw);
    for (let i = 0; i < bytes.length; i += 7) c.handleIncomingBytes(bytes.subarray(i, i + 7));
    c.flushTerminalWrites();
    return { raw: 'root@bee:~# ' + raw, record: device.inspectExecution(record.id), journal: c.readRaw() };
  });
}
async function terminalText(page) {
  return page.evaluate(() => {
    const buffer = window.__logView.state.term.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString(true)).join('\n');
  });
}
async function settled(page) {
  await expect(page.locator('#terminalOutput')).not.toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => new Promise(resolve => window.__logView.state.term.write('', resolve)));
}
test('reading view simplifies echo but execution and raw journal retain evidence', async ({ page }) => {
  const result = await trackedCommand(page);
  await expect.poll(() => terminalText(page)).toContain('[Agent] exit=7');
  const shown = await terminalText(page);
  expect(shown).toContain('uname -a'); expect(shown).toContain('Linux bee 6.12');
  expect(shown).not.toContain('LINKR_EXIT_'); expect(shown).not.toContain('sh -c');
  expect(result.record.executionStatus).toBe('completed'); expect(result.record.exitCode).toBe(7);
  expect(result.journal).toContain(result.record.completionToken + ':7'); expect(result.record.command).toBe('uname -a');
  await expect(page.locator('.agent-wire-payload').first()).not.toHaveAttribute('open');
  expect(await page.locator('.agent-wire-payload pre').first().textContent()).toContain(result.record.completionToken);
});
test('switching retains output and preference without UART writes or historical VT replies', async ({ page }) => {
  await trackedCommand(page);
  await page.evaluate(() => { const c = window.__logView; c.handleIncomingBytes(new TextEncoder().encode('\x1b[6n')); c.flushTerminalWrites(); });
  await expect.poll(() => page.evaluate(() => window.sent.some(text => /^\x1b\[\d+;\d+R$/.test(text)))).toBe(true);
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.sent = []; window.__logView.setLogView('raw'); }); await settled(page);
  expect(await terminalText(page)).toContain('LINKR_EXIT_'); expect(await terminalText(page)).toContain('sh -c');
  await page.evaluate(() => window.__logView.setLogView('reading')); await settled(page);
  expect(await terminalText(page)).not.toContain('LINKR_EXIT_'); expect(await terminalText(page)).toContain('[Agent] exit=7');
  await page.waitForTimeout(500); expect(await page.evaluate(() => window.sent)).toEqual([]);
  await page.evaluate(() => window.__logView.setLogView('raw'));
  await page.reload(); await page.waitForFunction(() => window.__logView?.state.term);
  await expect(page.locator('#logViewSelect')).toHaveValue('raw');
});
test('both exports save their selected UART bytes and clearly named files', async ({ page }) => {
  const result = await trackedCommand(page);
  for (const [selector, label] of [['#saveRawLog', 'raw'], ['#saveReadingLog', 'reading']]) {
    const event = page.waitForEvent('download'); await page.locator(selector).evaluate(button => button.click());
    const download = await event;
    expect(download.suggestedFilename()).toMatch(new RegExp(`^linkr-ble-${label}-.*\\.log$`));
    const text = await readFile(await download.path(), 'utf8');
    if (label === 'raw') expect(text).toBe(result.raw);
    else expect(text).toBe('root@bee:~# uname -a\r\n\r\nLinux bee 6.12\r\n[Agent] exit=7\r\nroot@bee:~# ');
  }
});
test('rapid switches, live receive and clear during replay do not duplicate cached bytes', async ({ page }) => {
  await page.evaluate(() => {
    const c = window.__logView; c.handleIncomingBytes(new TextEncoder().encode('before-switch\r\n')); c.setLogView('raw');
    c.handleIncomingBytes(new TextEncoder().encode('LIVE_ONCE\r\n'));
    c.setLogView('reading'); c.setLogView('raw'); c.setLogView('reading'); c.handleIncomingBytes(new TextEncoder().encode('AFTER_ONCE\r\n'));
  });
  await settled(page); const shown = await terminalText(page);
  expect(shown.match(/LIVE_ONCE/g)).toHaveLength(1); expect(shown.match(/AFTER_ONCE/g)).toHaveLength(1);
  await page.evaluate(() => {
    const c = window.__logView; c.setLogView('raw'); document.querySelector('#clearButton').click();
    c.handleIncomingBytes(new TextEncoder().encode('ONLY_AFTER_CLEAR\r\n'));
  });
  await settled(page); const cleared = await terminalText(page);
  expect(cleared).not.toContain('LIVE_ONCE'); expect(cleared.match(/ONLY_AFTER_CLEAR/g)).toHaveLength(1);
});
test('a scheduled geometry sync is cancelled before historical redraw', async ({ page }) => {
  await page.evaluate(async () => {
    const c = window.__logView;
    c.state.terminalGeometrySynced = ""; window.sent = [];
    c.handleIncomingBytes(new TextEncoder().encode('\r\nroot@bee:~# ')); c.flushTerminalWrites();
    await new Promise(resolve => c.state.term.write('', resolve));
    c.setLogView('raw');
  });
  await settled(page); await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.sent)).toEqual([]);
});
test('a live burst beyond the replay queue limit rebuilds from bounded history', async ({ page }) => {
  await page.evaluate(() => {
    const c = window.__logView; c.setLogView('raw');
    c.handleIncomingBytes(new TextEncoder().encode('x'.repeat(600000) + '\r\nBURST_END_ONCE\r\n'));
    c.handleIncomingBytes(new TextEncoder().encode('TAIL_ONCE\r\n'));
  });
  await settled(page);
  const text = await terminalText(page);
  expect(text.match(/BURST_END_ONCE/g)).toHaveLength(1); expect(text.match(/TAIL_ONCE/g)).toHaveLength(1);
});

test('disconnect flushes partial candidates and retires session registrations', async ({ page }) => {
  const token = await page.evaluate(async () => {
    const c = window.__logView, device = c.getDevice(); device.setMode('full-auto');
    const record = await device.execute({ text: 'uname -a', appendEnter: true, trackExit: true });
    c.handleIncomingBytes(new TextEncoder().encode('sh -')); c.setConnected(false); c.setConnected(true);
    c.handleIncomingBytes(new TextEncoder().encode('\r\n' + record.completionToken + ':0\r\n')); c.flushTerminalWrites(); return record.completionToken;
  });
  // Long markers may wrap on narrow screens; join only for this raw-byte check.
  await expect.poll(async () => (await terminalText(page)).replaceAll('\n', '')).toContain(token + ':0');
  expect(await terminalText(page)).toContain('sh -');
});
for (const width of [338, 834, 1440]) {
  test(`log controls fit at ${width}px and the themed selector changes the view`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__logView.setSettingsPage('terminal'); window.__logView.setMobileSidebarOpen(true); });
    if (await page.locator('#panelToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#panelToggle').click();
    const card = page.locator('#logViewCard'); await card.scrollIntoViewIfNeeded();
    await card.getByRole('combobox').click(); await page.getByRole('option', { name: 'Raw', exact: true }).click();
    await expect(page.locator('#logViewSelect')).toHaveValue('raw'); await settled(page);
    const metrics = await card.evaluate(el => ({ overflow: el.scrollWidth - el.clientWidth, width: el.getBoundingClientRect().width }));
    expect(metrics.overflow).toBeLessThanOrEqual(1); expect(metrics.width).toBeGreaterThan(200);
  });
}


test('internal probe commands stay on the execution card and in Raw while Reading keeps device output', async ({ page }, testInfo) => {
  const record = await page.evaluate(async () => {
    const c = window.__logView, device = c.getDevice(); device.setMode('full-auto');
    const record = await device.execute({text:'command -v curl',appendEnter:true,trackExit:true,applicationReadOnly:true});
    const raw = record.payload.replace(/\r\n|\r|\n/g,'\r\n') + '\r\n/usr/bin/curl\r\n' + record.completionToken + ':0\r\nroot@bee:~# ';
    const bytes = new TextEncoder().encode(raw);
    for (let i=0;i<bytes.length;i+=7) c.handleIncomingBytes(bytes.subarray(i,i+7));
    c.flushTerminalWrites();
    return { ...device.inspectExecution(record.id), rawJournal:c.readRaw() };
  });
  await expect.poll(() => terminalText(page)).toContain('/usr/bin/curl');
  const reading = await terminalText(page);
  expect(reading).not.toContain('command -v'); expect(reading).not.toContain('sh -c');
  expect(record.executionStatus).toBe('completed'); expect(record.exitCode).toBe(0);
  expect(record.rawJournal).toContain(record.command); expect(record.rawJournal).toContain(record.completionToken);
  const card = page.locator(`[data-execution="${record.id}"]`);
  expect(await card.locator(':scope > pre').first().textContent()).toBe(record.command);
  expect(await card.locator('.agent-wire-payload pre').textContent()).toContain(record.completionToken);
  await page.screenshot({path:testInfo.outputPath('probe-reading.png')});
  await page.evaluate(() => window.__logView.setLogView('raw')); await settled(page);
  expect(await terminalText(page)).toContain('command -v curl');
  await page.evaluate(() => window.__logView.setLogView('reading')); await settled(page);
  expect(await terminalText(page)).not.toContain('command -v curl');
});
