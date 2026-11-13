/**
 * The Linkr Bee plugin's own persisted settings, written by the Desktop
 * settings page (and any future UI) through the `updateSettings` RPC.
 *
 * The file lives in OpenCode's state directory, not in opencode.json: the
 * plugin must not rewrite a person's configuration file, and the settings page
 * has to work in a project that never had an explicit plugin entry. A settings
 * file outranks the entry's `options` and the environment when the plugin
 * normalises its configuration (see `normalizeConfig` in config.js).
 *
 *   $XDG_STATE_HOME/opencode/linkr-bee.json      (default ~/.local/state/opencode/linkr-bee.json)
 *
 * Only the keys listed in SETTINGS_KEYS are read or written. Everything is
 * best effort: a missing, unreadable or corrupt file is reported through the
 * returned `issues` and the plugin keeps working with the lower layers.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Fields the settings page may change; everything else stays options/env. */
export const SETTINGS_KEYS = Object.freeze([
  'transport',
  'bleName',
  'bleAddress',
  'lanHost',
  'lanToken',
  'cliPath',
  'timeoutMs',
  'sendCaptureMs',
  'webConsole',
]);

export const UART_KEYS = Object.freeze(['baud', 'dataBits', 'parity', 'stopBits', 'flow']);

/** The settings file for this process; honours XDG_STATE_HOME. */
export function settingsFilePath({ env = process.env, home = homedir() } = {}) {
  const stateRoot = env?.XDG_STATE_HOME && env.XDG_STATE_HOME !== ''
    ? env.XDG_STATE_HOME
    : join(home, '.local', 'state');
  return join(stateRoot, 'opencode', 'linkr-bee.json');
}

/** Read persisted settings; never throws. */
export function readSettings(path, issues) {
  const report = (message) => {
    if (Array.isArray(issues)) issues.push({ message });
  };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') report(`settings file is unreadable: ${error?.message ?? error}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    report('settings file is not valid JSON; ignoring it');
    return {};
  }
  return sanitizeSettings(parsed, report);
}

/** Keep only the known keys with the right primitive types. */
export function sanitizeSettings(raw, report = () => {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) report('settings file must contain a JSON object');
    return {};
  }
  const out = {};
  for (const key of SETTINGS_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (key === 'timeoutMs' || key === 'sendCaptureMs') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      else report(`${key} must be a number`);
    } else if (key === 'webConsole') {
      if (typeof value === 'boolean') out[key] = value;
      else report('webConsole must be a boolean');
    } else if (typeof value === 'string') {
      out[key] = value;
    } else {
      report(`${key} must be a string`);
    }
  }
  const uart = raw.uart;
  if (uart && typeof uart === 'object' && !Array.isArray(uart)) {
    const spec = {};
    for (const key of UART_KEYS) {
      if (uart[key] === undefined) continue;
      if (key === 'parity' || key === 'flow') {
        if (typeof uart[key] === 'string') spec[key] = uart[key];
        else report(`uart.${key} must be a string`);
      } else if (typeof uart[key] === 'number' && Number.isFinite(uart[key])) {
        spec[key] = uart[key];
      } else {
        report(`uart.${key} must be a number`);
      }
    }
    if (UART_KEYS.every((key) => spec[key] !== undefined)) out.uart = spec;
  }
  return out;
}

/**
 * Merge one settings patch onto the persisted values. `undefined` keeps the
 * current value, a string sets it, and `null` clears it (used for lanToken).
 */
export function mergeSettings(current, patch, report = () => {}) {
  const base = sanitizeSettings(current ?? {}, report);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('settings patch must be an object');
  }
  const next = { ...base };
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];
    if (value === null) {
      delete next[key];
      continue;
    }
    if (key === 'timeoutMs' || key === 'sendCaptureMs') {
      if (typeof value === 'number' && Number.isFinite(value)) next[key] = value;
      else throw new Error(`${key} must be a number`);
    } else if (key === 'webConsole') {
      if (typeof value === 'boolean') next[key] = value;
      else throw new Error('webConsole must be a boolean');
    } else if (typeof value === 'string') {
      next[key] = value;
    } else if (key === 'lanToken' && value === undefined) {
      continue;
    } else {
      throw new Error(`${key} must be a string`);
    }
  }
  if (patch.uart !== undefined) {
    if (patch.uart === null) {
      delete next.uart;
    } else if (patch.uart && typeof patch.uart === 'object' && !Array.isArray(patch.uart)) {
      const spec = {};
      for (const key of UART_KEYS) {
        if (patch.uart[key] !== undefined) spec[key] = patch.uart[key];
      }
      const merged = sanitizeSettings({ uart: spec });
      if (!merged.uart) throw new Error('uart needs baud,dataBits,parity,stopBits,flow');
      next.uart = merged.uart;
    } else {
      throw new Error('uart must be an object or null');
    }
  }
  return next;
}

/** Atomically write the settings file (temp + rename, owner-only). */
export function writeSettings(path, settings) {
  const body = `${JSON.stringify(settings, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
  // rename keeps the temp file's mode on POSIX; make sure a pre-existing file
  // with a loose mode converges even if the process umask differs.
  try { writeFileSync(path, body, { mode: 0o600 }); } catch { /* best effort */ }
  return settings;
}

/** The settings-shape answer shared by `settings` and `updateSettings`. */
export function publicSettings(config, persisted) {
  const uart = persisted?.uart;
  return {
    transport: config.transport,
    bleName: config.bleName,
    bleAddress: config.bleAddress,
    lanHost: config.lanHost,
    cliPath: config.cliPath,
    timeoutMs: config.timeoutMs,
    sendCaptureMs: config.sendCaptureMs,
    webConsole: config.webConsole,
    lanTokenSet: typeof config.lanToken === 'string' && config.lanToken !== '',
    ...(uart ? { uart: { ...uart } } : {}),
  };
}

/** Test seam: remove a settings file if it exists. */
export function removeSettingsFile(path) {
  try { rmSync(path); } catch { /* absent */ }
}
