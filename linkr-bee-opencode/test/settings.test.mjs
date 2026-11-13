import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig } from '../src/config.js';
import {
  mergeSettings,
  publicSettings,
  readSettings,
  sanitizeSettings,
  settingsFilePath,
  writeSettings,
} from '../src/settings.js';

const dir = mkdtempSync(join(tmpdir(), 'linkr-bee-settings-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('settingsFilePath honours XDG_STATE_HOME and defaults to ~/.local/state', () => {
  assert.equal(
    settingsFilePath({ env: { XDG_STATE_HOME: '/tmp/state-xdg' }, home: '/home/person' }),
    '/tmp/state-xdg/opencode/linkr-bee.json',
  );
  assert.equal(
    settingsFilePath({ env: {}, home: '/home/person' }),
    '/home/person/.local/state/opencode/linkr-bee.json',
  );
});

test('a missing or corrupt settings file is tolerated', () => {
  const issues = [];
  assert.deepEqual(readSettings(join(dir, 'absent.json'), issues), {});
  const corrupt = join(dir, 'corrupt.json');
  writeFileSync(corrupt, '{nope');
  assert.deepEqual(readSettings(corrupt, issues), {});
  assert.equal(issues.length, 1);
});

test('sanitizeSettings keeps known keys and drops the rest', () => {
  const issues = [];
  const clean = sanitizeSettings(
    { transport: 'lan', lanHost: '10.0.0.2', bogus: 1, timeoutMs: 1234, webConsole: false },
    (message) => issues.push(message),
  );
  assert.deepEqual(clean, { transport: 'lan', lanHost: '10.0.0.2', timeoutMs: 1234, webConsole: false });
  assert.deepEqual(issues, []);
});

test('writeSettings persists atomically and owner-only', () => {
  const path = join(dir, 'nested', 'linkr-bee.json');
  writeSettings(path, { transport: 'ble', bleName: 'Bench' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { transport: 'ble', bleName: 'Bench' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('persisted settings outrank options, and options outrank the environment', () => {
  const env = { LINKR_BEE_TIMEOUT_MS: '5000', LINKR_BLE_NAME: 'env-bee' };
  const options = { timeoutMs: 9000, bleName: 'option-bee', transport: 'lan', lanHost: 'h' };
  const persisted = { timeoutMs: 12000 };

  const config = normalizeConfig({ options }, { env, persisted });
  assert.equal(config.timeoutMs, 12000);
  assert.equal(config.bleName, 'option-bee');
  assert.equal(config.transport, 'lan');

  const fallback = normalizeConfig({ options: {} }, { env });
  assert.equal(fallback.timeoutMs, 5000);
  assert.equal(fallback.bleName, 'env-bee');
});

test('mergeSettings keeps omitted values, sets strings and clears with null', () => {
  const current = { transport: 'ble', bleName: 'Bench', lanToken: 'secret' };
  assert.deepEqual(mergeSettings(current, { bleName: 'Other' }), {
    transport: 'ble', bleName: 'Other', lanToken: 'secret',
  });
  assert.deepEqual(mergeSettings(current, { lanToken: null }), { transport: 'ble', bleName: 'Bench' });
  assert.deepEqual(mergeSettings(current, { lanToken: 'next' }).lanToken, 'next');
  assert.throws(() => mergeSettings(current, { transport: 5 }), /transport must be a string/);
  assert.throws(() => mergeSettings(current, { webConsole: 'yes' }), /webConsole must be a boolean/);
});

test('publicSettings masks the LAN token and copies the stored UART spec', () => {
  const config = normalizeConfig(
    { options: { transport: 'lan', lanHost: 'h', lanToken: 'abc' } },
    { env: {} },
  );
  const settings = publicSettings(config, { uart: { baud: 115200, dataBits: 8, parity: 'n', stopBits: 1, flow: 'none' } });
  assert.equal(settings.lanTokenSet, true);
  assert.equal('lanToken' in settings, false);
  assert.equal(settings.uart.baud, 115200);
  const empty = publicSettings(normalizeConfig({ options: {} }, { env: {} }), {});
  assert.equal(empty.lanTokenSet, false);
});
