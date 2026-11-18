import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boardMenu,
  connectSaved,
  scanAndConnect,
  settingsMenu,
  showStatus,
} from '../src/tui/settings.js';

/** A scripted host: dialog answers come from a queue and every call is logged. */
function fakeHost(config = {}) {
  const script = config.script ?? [];
  const calls = [];
  const alerts = [];
  const toasts = [];
  let index = 0;
  const next = (kind, args) => {
    const answer = script[index];
    if (answer === undefined || answer.kind !== kind) {
      calls.push(`${kind} (script exhausted)`);
      return undefined;
    }
    index += 1;
    calls.push(`${kind} ${JSON.stringify(args)}`);
    return answer.value;
  };
  const dialog = {
    select: async (args) => next('select', args),
    prompt: async (args) => next('prompt', args),
    confirm: async (args) => next('confirm', args),
    alert: async (args) => {
      calls.push(`alert ${JSON.stringify(args)}`);
      alerts.push(args);
    },
  };
  const toast = {
    show: (args) => {
      calls.push(`toast ${JSON.stringify(args)}`);
      toasts.push(args);
    },
  };
  const live = { transport: 'ble', bleName: '', bleAddress: '', lanHost: '', cliPath: '', timeoutMs: 30000, sendCaptureMs: 1500, webConsole: true, lanTokenSet: false, ...(config.settings ?? {}) };
  const rpc = {
    settings: async (input) => {
      calls.push(`settings ${JSON.stringify(input)}`);
      return { settings: { ...live } };
    },
    updateSettings: async (input) => {
      calls.push(`updateSettings ${JSON.stringify(input)}`);
      Object.assign(live, input);
      return { settings: { ...live } };
    },
    scan: async (input) => {
      calls.push(`scan ${JSON.stringify(input)}`);
      return { boards: config.boards ?? [] };
    },
    reconnect: async () => {
      calls.push('reconnect');
      return { ok: true };
    },
    state: async () => {
      calls.push('state');
      return config.state ?? { connected: true, transport: 'ble', target: 'Linkr Bee 6B80', cols: 80, rows: 24, bytes: 0, readingBytes: 0, epoch: 'e', webUrl: '' };
    },
    applyUart: async (input) => {
      calls.push(`applyUart ${JSON.stringify(input)}`);
      return { ok: true, result: '115200,8,n,1,none' };
    },
    webUrl: async () => ({ url: 'http://127.0.0.1:1/?t=x', enabled: true }),
  };
  return { dialog, toast, rpc, calls, alerts, toasts };
}

const BLE_SETTINGS = {
  transport: 'ble',
  bleName: '6B80',
  bleAddress: '',
  lanHost: '',
  cliPath: '',
  timeoutMs: 30000,
  sendCaptureMs: 1500,
  webConsole: true,
  lanTokenSet: false,
  uart: { baud: 115200, dataBits: 8, parity: 'n', stopBits: 1, flow: 'none' },
};

test('scanAndConnect saves the picked board and reports the link', async () => {
  const host = fakeHost({
    boards: [{ name: 'Linkr Bee 6B80', rssi: -51 }],
    settings: BLE_SETTINGS,
    script: [
      { kind: 'select', args: { title: 'Linkr Bee: pick a board' }, value: { name: 'Linkr Bee 6B80', rssi: -51 } },
    ],
  });
  const ok = await scanAndConnect(host);
  assert.equal(ok, true);
  const log = host.calls.join('\n');
  assert.match(log, /^scan /m);
  assert.match(log, /updateSettings \{"transport":"ble","bleName":"Linkr Bee 6B80"\}/);
  assert.match(log, /reconnect/);
  assert.equal(host.alerts.at(-1).title, 'Linkr Bee: connected');
  assert.equal(host.toasts.at(-1).variant, undefined);
});

test('scanAndConnect explains an empty scan and does not dial', async () => {
  const host = fakeHost({ boards: [], script: [] });
  const ok = await scanAndConnect(host);
  assert.equal(ok, false);
  assert.match(host.calls.join('\n'), /^scan /m);
  assert.doesNotMatch(host.calls.join('\n'), /updateSettings|reconnect/);
  assert.match(host.alerts.at(-1).message, /powered|pairing key/);
});

test('scanAndConnect reports a cancelled picker without changes', async () => {
  const host = fakeHost({
    boards: [{ name: 'Linkr Bee 6B80', rssi: -51 }],
    script: [{ kind: 'select', args: {}, value: undefined }],
  });
  assert.equal(await scanAndConnect(host), false);
  assert.doesNotMatch(host.calls.join('\n'), /updateSettings|reconnect/);
});

test('connectSaved and showStatus report the current link', async () => {
  const host = fakeHost({
    script: [],
    state: { connected: false, transport: 'ble', target: 'No Linkr Bee board found', cols: 80, rows: 24, bytes: 0, readingBytes: 0, epoch: 'e', webUrl: '' },
  });
  assert.equal(await connectSaved(host), false);
  assert.match(host.calls.join('\n'), /reconnect/);
  assert.match(host.alerts.at(-1).message, /Disconnected/);
  await showStatus(host);
  assert.match(host.alerts.at(-1).message, /Disconnected/);
});

test('settingsMenu changes the transport, shows a summary, then closes', async () => {
  const host = fakeHost({
    settings: BLE_SETTINGS,
    script: [
      { kind: 'select', args: {}, value: 'transport' },
      { kind: 'select', args: { title: 'Linkr Bee: transport' }, value: 'lan' },
      { kind: 'select', args: {}, value: 'show' },
      { kind: 'select', args: {}, value: 'close' },
    ],
  });
  await settingsMenu(host);
  const log = host.calls.join('\n');
  assert.match(log, /updateSettings \{"transport":"lan"\}/);
  assert.match(host.alerts.at(-1).message, /transport: lan/);
  assert.match(host.alerts.at(-1).message, /linkr-bee\.json/);
});

test('settingsMenu toggles the browser console page and offers the URL', async () => {
  const host = fakeHost({
    settings: { ...BLE_SETTINGS, webConsole: false },
    script: [
      { kind: 'select', args: {}, value: 'webConsole' },
      { kind: 'confirm', args: {}, value: true },
      { kind: 'select', args: {}, value: 'close' },
    ],
  });
  await settingsMenu(host);
  const log = host.calls.join('\n');
  assert.match(log, /updateSettings \{"webConsole":true\}/);
  assert.match(host.alerts.at(-1).message, /127\.0\.0\.1/);
});

test('uartMenu applies the bridge UART and returns', async () => {
  const host = fakeHost({
    settings: BLE_SETTINGS,
    script: [
      { kind: 'select', args: {}, value: 'uart' },
      { kind: 'select', args: {}, value: 'apply' },
      { kind: 'select', args: {}, value: 'back' },
      { kind: 'select', args: {}, value: 'close' },
    ],
  });
  await settingsMenu(host);
  const log = host.calls.join('\n');
  assert.match(log, /applyUart \{"baud":115200,"dataBits":8,"parity":"n","stopBits":1,"flow":"none"\}/);
  assert.match(host.alerts.at(-1).message, /115200,8,n,1,none/);
});

test('boardMenu dispatches the scan flow and closes', async () => {
  const host = fakeHost({
    boards: [],
    settings: BLE_SETTINGS,
    script: [
      { kind: 'select', args: {}, value: 'scan' },
      { kind: 'select', args: {}, value: 'close' },
    ],
  });
  await boardMenu(host);
  assert.match(host.calls.join('\n'), /scan/);
});
