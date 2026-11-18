import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Exercise the committed browser bundle, as served by the plugin. Only its
// local HTTP/SSE peer is faked; xterm and the client lifecycle are real.
async function consolePage(page) {
  const server = { epoch: 'first', text: 'FIRST UART\r\n', reads: 0, waitForRead: null };
  await page.addInitScript(() => {
    window.consoleSources = [];
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        window.consoleSources.push(this);
        setTimeout(() => this.dispatchEvent(new Event('open')), 0);
      }
      close() {}
    };
  });
  await page.route('**/opencode-console-test*', route => route.fulfill({
    contentType: 'text/html',
    body: '<meta charset="utf-8"><div id="linkr-console"></div><script src="/opencode-console-bundle.js"></script>',
  }));
  await page.route('**/opencode-console-bundle.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: readFileSync(new URL('../../linkr-bee-opencode/dist/web-console.js', import.meta.url), 'utf8'),
  }));
  await page.route('**/state?*', route => route.fulfill({ json: {
    connected: true, transport: 'loopback', target: 'test', cols: 80, rows: 24,
  } }));
  await page.route('**/read?*', async route => {
    server.reads++;
    const response = {
      view: new URL(route.request().url()).searchParams.get('view'),
      text: server.text, bytes: Buffer.byteLength(server.text), epoch: server.epoch,
    };
    if (server.waitForRead) await server.waitForRead;
    await route.fulfill({ json: response });
  });
  await page.route('**/resize?*', route => route.fulfill({ json: { ok: true, applied: true } }));
  await page.goto('/opencode-console-test?t=test');
  await expect(page.locator('.xterm-screen')).toContainText('FIRST UART');
  return server;
}

async function output(page, data) {
  await page.evaluate(data => {
    for (const source of window.consoleSources) {
      source.dispatchEvent(new MessageEvent('output', { data: JSON.stringify(data) }));
    }
  }, data);
}

test('plugin Log receives notices after a shared clear and resyncs UART on return', async ({ page }) => {
  const server = await consolePage(page);
  await page.locator('[data-view="log"]').click();
  await output(page, { kind: 'meta', epoch: 'first', text: 'BEFORE CLEAR' });
  await expect(page.locator('.lbw-log')).toContainText('BEFORE CLEAR');
  server.epoch = 'second';
  server.text = 'AFTER CLEAR UART\r\n';
  await output(page, { kind: 'meta', epoch: 'second', text: 'AFTER CLEAR NOTICE' });
  await output(page, { kind: 'data', epoch: 'second', text: server.text, bytes: 18 });
  await output(page, { kind: 'meta', epoch: 'second', text: 'SECOND NOTICE' });
  await expect(page.locator('.lbw-log')).toContainText('AFTER CLEAR NOTICE');
  await expect(page.locator('.lbw-log')).toContainText('SECOND NOTICE');
  await expect(page.locator('.lbw-log')).not.toContainText('AFTER CLEAR UART');
  expect(server.reads).toBe(1);

  await page.locator('[data-view="raw"]').click();
  await expect(page.locator('.xterm-screen')).toContainText('AFTER CLEAR UART');
  await expect(page.locator('.xterm-screen')).not.toContainText('FIRST UART');
  await output(page, { kind: 'meta', epoch: 'third', text: 'NOTICE IN RAW' });
  await expect(page.locator('.xterm-screen')).not.toContainText('NOTICE IN RAW');
  await page.locator('[data-view="log"]').click();
  await expect(page.locator('.lbw-log')).toContainText('NOTICE IN RAW');
  expect(server.reads).toBe(2);
});

test('a late UART snapshot cannot redraw the terminal after switching to Log', async ({ page }) => {
  const server = await consolePage(page);
  let release;
  server.text = 'STALE SNAPSHOT\r\n';
  server.waitForRead = new Promise(resolve => { release = resolve; });
  await page.locator('[data-view="raw"]').click();
  await expect.poll(() => server.reads).toBe(2);
  await page.locator('[data-view="log"]').click();
  const settled = page.waitForResponse(response => response.url().includes('/read?'));
  release();
  await settled;
  await output(page, { kind: 'meta', epoch: 'second', text: 'LIVE NOTICE' });
  await expect(page.locator('.lbw-log')).toContainText('LIVE NOTICE');
  await expect(page.locator('.xterm-screen')).not.toContainText('STALE SNAPSHOT');
  server.waitForRead = null;
  server.epoch = 'second';
  server.text = 'CURRENT UART\r\n';
  await page.locator('[data-view="reading"]').click();
  await expect(page.locator('.xterm-screen')).toContainText('CURRENT UART');
  await expect(page.locator('.xterm-screen')).not.toContainText('STALE SNAPSHOT');
});
