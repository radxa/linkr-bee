import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SEND_CAPTURE_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_SEND_CAPTURE_MS,
  MAX_TIMEOUT_MS,
  MIN_SEND_CAPTURE_MS,
  MIN_TIMEOUT_MS,
  normalizeConfig,
  parseUartSpec,
} from '../src/config.js';

const ENV = {
  LINKR_BEE_CLI: '/env/bee-cli',
  LINKR_BEE_TRANSPORT: 'lan',
  LINKR_LAN_HOST: '192.168.0.102',
  LINKR_LAN_TOKEN: 'a'.repeat(32),
  LINKR_BLE_ADDRESS: 'EE:C7:42:34:48:CF',
  LINKR_BLE_NAME: 'Env Bee',
  LINKR_BEE_TIMEOUT_MS: '45000',
  LINKR_BEE_SEND_CAPTURE_MS: '2500',
};

test('defaults match the documented configuration', () => {
  const config = normalizeConfig(undefined, { env: {} });
  assert.deepEqual(config, {
    cliPath: '',
    transport: 'ble',
    lanHost: '',
    lanToken: '',
    bleAddress: '',
    bleName: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sendCaptureMs: DEFAULT_SEND_CAPTURE_MS,
    webConsole: true,
    uart: null,
  });
});

test('every option has an environment fallback', () => {
  const config = normalizeConfig({}, { env: ENV });
  assert.equal(config.cliPath, '/env/bee-cli');
  assert.equal(config.transport, 'lan');
  assert.equal(config.lanHost, '192.168.0.102');
  assert.equal(config.lanToken, 'a'.repeat(32));
  assert.equal(config.bleAddress, 'EE:C7:42:34:48:CF');
  assert.equal(config.bleName, 'Env Bee');
  assert.equal(config.timeoutMs, 45000);
  assert.equal(config.sendCaptureMs, 2500);
  assert.equal(config.webConsole, true);
});

test('webConsole is a boolean option with an environment fallback', () => {
  assert.equal(normalizeConfig({ webConsole: false }, { env: {} }).webConsole, false);
  assert.equal(normalizeConfig({ webConsole: 'off' }, { env: {} }).webConsole, false);
  assert.equal(normalizeConfig({ webConsole: 'yes' }, { env: {} }).webConsole, true);
  assert.equal(normalizeConfig({}, { env: { LINKR_BEE_WEB_CONSOLE: '0' } }).webConsole, false);
  assert.equal(normalizeConfig({}, { env: { LINKR_BEE_WEB_CONSOLE: 'true' } }).webConsole, true);
  // An option wins over the environment.
  assert.equal(
    normalizeConfig({ webConsole: true }, { env: { LINKR_BEE_WEB_CONSOLE: 'false' } }).webConsole,
    true,
  );
  const issues = [];
  const config = normalizeConfig({ webConsole: 'maybe' }, { env: {}, issues });
  assert.equal(config.webConsole, true);
  assert.match(issues[0].message, /webConsole must be a boolean/);
});

test('options win over the environment', () => {
  const config = normalizeConfig(
    { cliPath: '/opt/bee-cli', transport: 'loopback', timeoutMs: 12000, sendCaptureMs: 0 },
    { env: ENV },
  );
  assert.equal(config.cliPath, '/opt/bee-cli');
  assert.equal(config.transport, 'loopback');
  assert.equal(config.timeoutMs, 12000);
  assert.equal(config.sendCaptureMs, 0);
  // Not overridden: still from the environment.
  assert.equal(config.lanHost, '192.168.0.102');
});

test('accepts settings nested under an options key', () => {
  const config = normalizeConfig({ options: { transport: 'loopback', bleName: 'Nested Bee' } }, { env: {} });
  assert.equal(config.transport, 'loopback');
  assert.equal(config.bleName, 'Nested Bee');
});

test('unknown transport falls back to ble and is reported', () => {
  const issues = [];
  const config = normalizeConfig({ transport: 'bluetooth' }, { env: {}, issues });
  assert.equal(config.transport, 'ble');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /transport must be ble, lan or loopback/);
});

test('non-string and non-numeric values fall back and are reported', () => {
  const issues = [];
  const config = normalizeConfig(
    { cliPath: 42, bleName: false, timeoutMs: 'soon', sendCaptureMs: Number.NaN },
    { env: {}, issues },
  );
  assert.equal(config.cliPath, '');
  assert.equal(config.bleName, '');
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(config.sendCaptureMs, DEFAULT_SEND_CAPTURE_MS);
  assert.deepEqual(issues.map((issue) => issue.message).sort(), [
    'bleName must be a string',
    'cliPath must be a string',
    'sendCaptureMs must be a number',
    'timeoutMs must be a number',
  ]);
});

test('numeric strings are coerced and budgets are clamped', () => {
  assert.equal(normalizeConfig({ timeoutMs: '9000' }, { env: {} }).timeoutMs, 9000);
  assert.equal(normalizeConfig({ timeoutMs: 10 }, { env: {} }).timeoutMs, MIN_TIMEOUT_MS);
  assert.equal(normalizeConfig({ timeoutMs: 9e12 }, { env: {} }).timeoutMs, MAX_TIMEOUT_MS);
  assert.equal(normalizeConfig({ sendCaptureMs: -50 }, { env: {} }).sendCaptureMs, MIN_SEND_CAPTURE_MS);
  assert.equal(normalizeConfig({ sendCaptureMs: 9e9 }, { env: {} }).sendCaptureMs, MAX_SEND_CAPTURE_MS);
});

test('invalid environment values are reported too', () => {
  const issues = [];
  const config = normalizeConfig({}, {
    env: { LINKR_BEE_TRANSPORT: 'carrier-pigeon', LINKR_BEE_TIMEOUT_MS: 'never' },
    issues,
  });
  assert.equal(config.transport, 'ble');
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(issues.length, 2);
});

test('parseUartSpec normalises a valid spec', () => {
  assert.deepEqual(parseUartSpec(' 115200 , 8 , N , 1 , rtscts '), {
    baud: 115200,
    dataBits: 8,
    parity: 'n',
    stopBits: 1,
    flow: 'rtscts',
  });
  assert.deepEqual(parseUartSpec('9600,7,e,2,none'), {
    baud: 9600,
    dataBits: 7,
    parity: 'e',
    stopBits: 2,
    flow: 'none',
  });
});

test('parseUartSpec rejects malformed specs with an actionable message', () => {
  for (const value of ['115200', '115200,8,x,1,none', '115200,8,n,3,none', '', undefined, 42]) {
    assert.throws(() => parseUartSpec(value), /UART format must be baud,data,parity,stop,flow/);
  }
});
