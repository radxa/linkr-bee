/**
 * Configuration for the OpenCode Linkr Bee plugin.
 *
 * OpenCode 2.x passes a `plugins` entry's `options` object to the plugin as
 * `ctx.options` (a plain object, `{}` when the entry carries none), so this
 * module turns whatever the user (or the environment) supplied into the shape
 * the rest of the plugin expects. It never throws: a mistyped option must not
 * stop the plugin from loading, because loading also happens in projects with
 * no board and no bee-cli at all. Bad values are recorded in `issues` and fall
 * back to the documented default; the tools report what is actually wrong when
 * they run.
 *
 * Options win over environment variables, environment variables win over the
 * defaults. Every setting that can be configured also has an environment
 * fallback so `opencode.json` can stay untouched in a shell that already
 * exports LINKR_*.
 */

export const TRANSPORTS = Object.freeze(['ble', 'lan', 'loopback']);

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_SEND_CAPTURE_MS = 1_500;

/** Serve the standalone browser console page unless a project opts out. */
export const DEFAULT_WEB_CONSOLE = true;

/** Bounds applied after coercion, so a tool never asks for a nonsense budget. */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 2_147_483_647;
export const MIN_SEND_CAPTURE_MS = 0;
export const MAX_SEND_CAPTURE_MS = 60_000;

/**
 * Same spec the bridge's own UART control accepts:
 * `baud,dataBits,parity,stopBits,flow`, e.g. `115200,8,n,1,none`.
 */
const UART_SPEC = /^\s*(\d{3,7})\s*,\s*([5-8])\s*,\s*([nNeEoO])\s*,\s*([12])\s*,\s*(none|rtscts)\s*$/;

/**
 * Parse and normalise a UART spec. Validation happens on the host so the tool
 * cannot hand bee-cli a shape the CLI (or the board) would only reject later.
 */
export function parseUartSpec(value) {
  const match = typeof value === 'string' ? UART_SPEC.exec(value) : null;
  if (!match) {
    throw new Error('UART format must be baud,data,parity,stop,flow — e.g. 115200,8,n,1,none');
  }
  return {
    baud: Number(match[1]),
    dataBits: Number(match[2]),
    parity: match[3].toLowerCase(),
    stopBits: Number(match[4]),
    flow: match[5].toLowerCase(),
  };
}

/** config key → environment variable used when the option is absent. */
export const ENV_FALLBACKS = Object.freeze({
  cliPath: 'LINKR_BEE_CLI',
  transport: 'LINKR_BEE_TRANSPORT',
  lanHost: 'LINKR_LAN_HOST',
  lanToken: 'LINKR_LAN_TOKEN',
  bleAddress: 'LINKR_BLE_ADDRESS',
  bleName: 'LINKR_BLE_NAME',
  timeoutMs: 'LINKR_BEE_TIMEOUT_MS',
  sendCaptureMs: 'LINKR_BEE_SEND_CAPTURE_MS',
  webConsole: 'LINKR_BEE_WEB_CONSOLE',
});

function envValue(env, key) {
  const value = env?.[ENV_FALLBACKS[key]];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * `raw` is the plugin options object from OpenCode. Some configurations nest
 * settings under an `options` key; accept that too rather than silently
 * ignoring the user's values.
 *
 * Returns the effective config; validation problems are appended to `issues`
 * (if the caller passed an array) and resolved to the documented default.
 */
export function normalizeConfig(raw, { env = process.env, persisted, issues } = {}) {
  const outer = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const config = outer.options && typeof outer.options === 'object' && !Array.isArray(outer.options)
    ? outer.options
    : outer;
  // A settings file written by the Desktop settings page outranks both the
  // opencode.json options and the environment; it is the person's latest word.
  const saved = persisted && typeof persisted === 'object' && !Array.isArray(persisted) ? persisted : {};

  const report = (message) => {
    if (Array.isArray(issues)) issues.push({ message });
  };

  /** The raw value for a key: saved settings, then options, else undefined. */
  const layerValue = (key) => {
    const fromFile = saved[key];
    if (fromFile !== undefined && fromFile !== null && fromFile !== '') return fromFile;
    const fromOptions = config[key];
    if (fromOptions !== undefined && fromOptions !== null && fromOptions !== '') return fromOptions;
    return undefined;
  };

  const string = (key, fallback) => {
    const value = layerValue(key);
    if (value === undefined) return envValue(env, key) ?? fallback;
    if (typeof value !== 'string') {
      report(`${key} must be a string`);
      return fallback;
    }
    return value;
  };

  const boolean = (key, fallback) => {
    let value = layerValue(key);
    if (value === undefined) value = envValue(env, key);
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const flat = value.trim().toLowerCase();
      if (['1', 'true', 'on', 'yes', 'enabled'].includes(flat)) return true;
      if (['0', 'false', 'off', 'no', 'disabled'].includes(flat)) return false;
    }
    report(`${key} must be a boolean`);
    return fallback;
  };

  const number = (key, fallback, min, max) => {
    let value = layerValue(key);
    if (value === undefined) value = envValue(env, key);
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      report(`${key} must be a number`);
      return fallback;
    }
    const rounded = Math.round(parsed);
    if (rounded < min || rounded > max) {
      report(`${key} must be between ${min} and ${max}`);
    }
    return Math.min(max, Math.max(min, rounded));
  };

  let transport = string('transport', 'ble');
  if (!TRANSPORTS.includes(transport)) {
    report('transport must be ble, lan or loopback');
    transport = 'ble';
  }

  // The bridge UART is stored by the settings file (and may be set directly in
  // options); it is not an environment setting. Keep only a complete spec.
  const uartSource = saved.uart && typeof saved.uart === 'object'
    ? saved.uart
    : (config.uart && typeof config.uart === 'object' && !Array.isArray(config.uart) ? config.uart : undefined);
  let uart = null;
  if (uartSource) {
    const baud = Number(uartSource.baud);
    const dataBits = Number(uartSource.dataBits);
    const stopBits = Number(uartSource.stopBits);
    const parity = String(uartSource.parity ?? '').toLowerCase();
    const flow = String(uartSource.flow ?? '').toLowerCase();
    if (Number.isFinite(baud) && baud > 0 && [5, 6, 7, 8].includes(dataBits) &&
        ['n', 'e', 'o'].includes(parity) && [1, 2].includes(stopBits) && ['none', 'rtscts'].includes(flow)) {
      uart = { baud, dataBits, parity, stopBits, flow };
    } else {
      report('uart must be { baud, dataBits: 5-8, parity: n|e|o, stopBits: 1|2, flow: none|rtscts }');
    }
  }

  return {
    cliPath: string('cliPath', ''),
    transport,
    lanHost: string('lanHost', ''),
    lanToken: string('lanToken', ''),
    bleAddress: string('bleAddress', ''),
    bleName: string('bleName', ''),
    timeoutMs: number('timeoutMs', DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    sendCaptureMs: number('sendCaptureMs', DEFAULT_SEND_CAPTURE_MS, MIN_SEND_CAPTURE_MS, MAX_SEND_CAPTURE_MS),
    webConsole: boolean('webConsole', DEFAULT_WEB_CONSOLE),
    uart,
  };
}
