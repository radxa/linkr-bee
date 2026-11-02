import { test, expect } from '@playwright/test';

async function fixture(page) {
  await page.route('**/mcp-review-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><aside id="mount"></aside></body>' }));
  await page.goto('/mcp-review-fixture');
  await page.evaluate(async () => {
    const { createMcpUi } = await import('/mcp_ui.js');
    const state = { enabled: true, running: true, foreground: true, token: 'test-token', url: 'http://127.0.0.1:8712/mcp' };
    const config = { enabled: true, port: 8712, bind: 'loopback', access: 'confirm' };
    const listeners = {};
    window.__approvalResults = [];
    window.__notifications = [];
    window.__cancelledNotifications = [];
    const bridge = {
      async getState() { return { ...state }; },
      async showApproval(input) {
        window.__notifications.push(input);
        if (window.__approveImmediately) listeners.approvalAction?.({ id: input.id, approved: true });
        return true;
      },
      async cancelApproval(id) { window.__cancelledNotifications.push(id); },
      async addListener(event, callback) { listeners[event] = callback; return { async remove() { delete listeners[event]; } }; },
    };
    const host = { getConfig: () => ({ ...config }), getState: () => ({ ...state }), getAudit: () => [], async refreshState() { return { ...state }; } };
    window.__approvalState = state;
    window.__emitApprovalAction = (payload) => listeners.approvalAction?.(payload);
    window.__approvalUi = createMcpUi({ mount: document.querySelector('#mount'), getLang: () => 'en', host, getBridge: () => bridge });
    window.__askApproval = (name = 'request') => window.__approvalUi.requestApproval({ tool: 'wifi_scan', args: {}, summary: name, timeoutMs: 5000 }).then(result => { window.__approvalResults.push({ name, ...result }); return result; });
    window.__askCustom = (request) => window.__approvalUi.requestApproval(request).then(result => { window.__approvalResults.push(result); return result; });
  });
}

test('concurrent approvals reserve the slot before the first native await', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { void window.__askApproval('first'); void window.__askApproval('second'); });
  await page.waitForTimeout(100);
  const early = await page.evaluate(() => window.__approvalResults);
  expect(early).toHaveLength(1);
  expect(early[0]).toMatchObject({ name: 'second', approved: false });
  await page.locator('[data-mcp="approvalAllow"]').click();
  await expect.poll(() => page.evaluate(() => window.__approvalResults)).toHaveLength(2);
  expect(await page.evaluate(() => window.__approvalResults.find(r => r.name === 'first').approved)).toBe(true);
});

test('a native pause migrates the visible banner even when WebView visibility stays visible', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { void window.__askApproval(); });
  await expect(page.locator('[data-mcp="approvalAllow"]')).toBeVisible();
  await page.evaluate(async () => { window.__approvalState.foreground = false; await window.__approvalUi.refresh(); });
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(1);
});

test('an immediate notification action is not lost while showApproval resolves', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.__approvalState.foreground = false;
    window.__approveImmediately = true;
    void window.__askApproval();
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__approvalResults)).toMatchObject([{ approved: true }]);
});

test('aborting an approval dismisses its notification and never grants it', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.__approvalState.foreground = false;
    window.__approvalAbort = new AbortController();
    void window.__approvalUi.requestApproval({ tool: 'set_wifi', args: {}, signal: window.__approvalAbort.signal })
      .then(result => window.__approvalResults.push(result));
  });
  await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(1);
  await page.evaluate(() => window.__approvalAbort.abort(new Error('MCP stopped')));
  await expect.poll(() => page.evaluate(() => window.__approvalResults.length)).toBe(1);
  expect(await page.evaluate(() => window.__approvalResults[0].approved)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__cancelledNotifications.length)).toBe(1);
});

test('returning to the foreground re-surfaces a pending notification approval', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.__approvalState.foreground = false;
    void window.__askApproval('resume');
  });
  await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(1);
  const notification = await page.evaluate(() => window.__notifications[0]);
  // The absolute deadline lets the native side cancel a stale notification.
  expect(typeof notification.deadlineMs).toBe('number');
  expect(notification.deadlineMs).toBeGreaterThan(Date.now());
  expect(await page.evaluate(() => document.getElementById('mcpApproval').hidden)).toBe(true);

  await page.evaluate(() => {
    window.__approvalState.foreground = true;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('[data-mcp="approvalAllow"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__cancelledNotifications)).toContain(notification.id);
  await page.locator('[data-mcp="approvalAllow"]').click();
  await expect.poll(() => page.evaluate(() => window.__approvalResults.find(r => r.name === 'resume')?.approved)).toBe(true);
});

test('an expired native approval action fails closed with the timeout notice', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.__approvalState.foreground = false;
    void window.__askApproval('expired');
  });
  await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(1);
  const notification = await page.evaluate(() => window.__notifications[0]);
  await page.evaluate((id) => window.__emitApprovalAction({ id, approved: false, expired: true }), notification.id);
  await expect.poll(() => page.evaluate(() => window.__approvalResults.length)).toBe(1);
  const decision = await page.evaluate(() => window.__approvalResults[0]);
  expect(decision.approved).toBe(false);
  expect(decision.reason).toBe('Timed out; nothing was executed.');
  await expect.poll(() => page.evaluate(() => window.__cancelledNotifications)).toContain(notification.id);
});

test('a start_agent_task notification body carries the actual request, not policy text', async ({ page }) => {
  await fixture(page);
  const request = 'Check the target kernel version and report the boot errors from the last two minutes';
  await page.evaluate((text) => {
    window.__approvalState.foreground = false;
    void window.__askCustom({
      tool: 'start_agent_task',
      args: { request: text },
      summary: 'Let the resident assistant run this task? The approval covers its ORDINARY serial reads and writes; destructive commands and sensitive changes still ask on the phone',
      timeoutMs: 5000,
    });
  }, request);
  await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(1);
  const body = await page.evaluate(() => window.__notifications[0].body);
  expect(body).toContain('Check the target kernel version');
  expect(body.length).toBeGreaterThan(60);
});

for (const surface of ['banner', 'notification']) {
  test(`a late ${surface} Allow cannot approve an expired request`, async ({ page }) => {
    await fixture(page);
    await page.evaluate((surface) => {
      window.__approvalState.foreground = surface !== 'notification';
      void window.__askApproval('late');
    }, surface);
    if (surface === 'notification') {
      await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(1);
    } else await expect(page.locator('[data-mcp="approvalAllow"]')).toBeVisible();
    // Simulate a suspended renderer whose timer has not had a turn yet.
    await page.evaluate(() => {
      const now = Date.now();
      Date.now = () => now + 6000;
    });
    if (surface === 'notification') {
      await page.evaluate(() => window.__emitApprovalAction({
        id: window.__notifications[0].id, approved: true,
      }));
    } else await page.locator('[data-mcp="approvalAllow"]').click();
    await expect.poll(() => page.evaluate(() => window.__approvalResults.length)).toBe(1);
    expect(await page.evaluate(() => window.__approvalResults[0])).toMatchObject({ approved: false });
  });
}
