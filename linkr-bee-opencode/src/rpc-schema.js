/**
 * The wire contract of the shared Linkr Bee console RPC, in plain JSON Schema.
 *
 * This module deliberately has no imports: the server part needs it to define
 * the RPC, and the unit tests (and either UI half) need the same schema without
 * `@opencode/plugin` being resolvable. `src/rpc.js` wraps this definition with
 * `Rpc.define` for the real server and is what the `./rpc` package export
 * points at; UI code imports the default export of the package's `./rpc`.
 *
 * Frozen surface — id `linkr_bee.console`:
 *
 *   methods (input -> output, every value an object):
 *     state     {}                                -> State
 *     read      { view?, since? }                 -> ReadResult (bytes = the cursor
 *                                                  for the chosen view: state.bytes
 *                                                  for raw, state.readingBytes for
 *                                                  reading)
 *     write     { data }                          -> Ok
 *     key       { key }                           -> Ok
 *     resize    { cols, rows }                    -> ResizeResult
 *     clear     {}                                -> Ok
 *     reconnect {}                                -> Ok
 *     webUrl    {}                                -> { url, enabled }  (local browser page)
 *     settings  {}                                -> { settings, defaults }
 *     updateSettings { ... }                      -> { settings }      (persisted)
 *     scan      {}                                -> { boards }
 *     applyUart { baud,dataBits,parity,stopBits,flow } -> { ok, result }
 *
 *   events:
 *     output  { seq, epoch, kind: data|meta|user, text, bytes }
 *     state   { connected, transport, target, cols, rows }
 *     request { action: open|focus|clear }        (the console tool asks the
 *                                                  panels to open/focus/clear)
 *
 * A panel starts by calling `state({})`; the server lazily dials the board on
 * that call. Then it calls `read({ view, since })` for the current ring and
 * subscribes to `output` events, using each event's `bytes` as the next
 * `since`. `read`/`state` never throw when no board or bee-cli exists: they
 * report `connected: false` and the last error in `state.target`/`state`.
 */

/** Named keys `key` accepts, as the bytes a terminal sends (dsh parity). */
export const NAMED_KEYS = Object.freeze([
  'enter', 'tab', 'esc', 'space', 'backspace',
  'up', 'down', 'right', 'left', 'home', 'end',
  'ctrl-c', 'ctrl-d', 'ctrl-z', 'ctrl-l',
]);

export const CONSOLE_RPC_ID = 'linkr_bee.console';

/** A JSON Schema object; every RPC value in this contract is one of these. */
function object(properties = {}, required = []) {
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

const integer = (minimum, maximum, description) => {
  const schema = { type: 'integer', description };
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
  return schema;
};

const string = (description) => ({ type: 'string', description });
const boolean = (description) => ({ type: 'boolean', description });

const EMPTY = object({});
const OK = object({ ok: boolean('The request was accepted.') }, ['ok']);

/** Live link state, also the shape panels render in their header. */
export const STATE_SCHEMA = object(
  {
    connected: boolean('A resident bee-cli session currently holds the board.'),
    transport: string('ble, lan or loopback.'),
    target: string('What the link is dialled to (board name, LAN host, loopback), or the last error.'),
    cols: integer(2, 500, 'Terminal columns last applied to the board.'),
    rows: integer(1, 200, 'Terminal rows last applied to the board.'),
    baud: integer(1, undefined, 'Bridge UART baud rate when known (absent while it is unknown).'),
    bytes: integer(0, undefined, 'Monotonic raw-console byte counter (the cursor unit for read/since).'),
    epoch: string('Ring generation; changes on clear/reconnect so stale cursors are detectable.'),
    readingBytes: integer(0, undefined, 'Monotonic reading-view byte counter.'),
    webUrl: string('Local browser console page URL when that page server is running ("" when disabled).'),
  },
  ['connected', 'transport', 'target', 'cols', 'rows', 'bytes', 'epoch', 'readingBytes'],
);

/** `read` input: which view, and the cursor from a previous read/output event. */
export const READ_INPUT_SCHEMA = object({
  view: { type: 'string', enum: ['reading', 'raw'], description: 'reading (default) hides agent probe echoes; raw is the byte stream.' },
  since: integer(0, undefined, 'Byte counter to read after; omit for the current tail.'),
});

/** `read` output: the text and the cursor the next call should pass. */
export const READ_OUTPUT_SCHEMA = object(
  {
    view: { type: 'string', enum: ['reading', 'raw'] },
    text: string('The console text after `since` (or the tail).'),
    bytes: integer(0, undefined, 'Byte counter after the returned text; pass as the next since.'),
    epoch: string('Ring generation of this answer.'),
    truncated: boolean('True when older text than requested was already dropped from the ring.'),
  },
  ['view', 'text', 'bytes', 'epoch'],
);

export const RESIZE_INPUT_SCHEMA = object(
  {
    cols: integer(2, 500, 'Terminal columns.'),
    rows: integer(1, 200, 'Terminal rows.'),
  },
  ['cols', 'rows'],
);

export const RESIZE_OUTPUT_SCHEMA = object(
  {
    applied: boolean('The session applied the size.'),
    cols: integer(2, 500, 'The size the board now has.'),
    rows: integer(1, 200, 'The size the board now has.'),
    reason: string('Why a resize was not applied (when applied is false).'),
  },
  ['applied', 'cols', 'rows'],
);

/** `webUrl` output: the local browser console page, or enabled:false. */
export const WEB_URL_OUTPUT_SCHEMA = object(
  {
    url: string('http://127.0.0.1:<port>/?t=<token>, or "" when the page server is disabled.'),
    enabled: boolean('Whether the local browser console page is enabled.'),
  },
  ['url', 'enabled'],
);

export const KEY_INPUT_SCHEMA = object(
  { key: { type: 'string', enum: NAMED_KEYS, description: 'Named key to press on the target console.' } },
  ['key'],
);

export const WRITE_INPUT_SCHEMA = object(
  { data: string('Raw bytes/keystrokes to write to the target console.') },
  ['data'],
);

/** Event schemas (all object-rooted, as the RPC event contract requires). */
export const OUTPUT_EVENT_SCHEMA = object(
  {
    seq: integer(0, undefined, 'Monotonic event sequence for this ring epoch.'),
    epoch: string('Ring generation.'),
    kind: { type: 'string', enum: ['data', 'meta', 'user'], description: 'data = target bytes, meta = notice, user = typed input.' },
    text: string('The raw text for the raw view (empty for a delayed reading-only flush).'),
    bytes: integer(0, undefined, 'Raw-console byte counter after this text; next raw read/since cursor.'),
    reading: string('The reading-view text when it differs from raw (probe echoes hidden, LINKR_RC markers collapsed). Draw reading ?? text in the reading view.'),
    readingBytes: integer(0, undefined, 'Reading-view byte counter after this text; next reading read/since cursor.'),
  },
  ['seq', 'epoch', 'kind', 'text', 'bytes'],
);

export const STATE_EVENT_SCHEMA = object(
  {
    connected: boolean('A resident session holds the board.'),
    transport: string('ble, lan or loopback.'),
    target: string('What the link is dialled to, or the last error.'),
    cols: integer(2, 500, 'Terminal columns.'),
    rows: integer(1, 200, 'Terminal rows.'),
    baud: integer(1, undefined, 'Bridge UART baud rate when known.'),
  },
  ['connected', 'transport', 'target', 'cols', 'rows'],
);

export const REQUEST_EVENT_SCHEMA = object(
  {
    action: {
      type: 'string',
      enum: ['open', 'focus', 'clear'],
      description: 'Panels listen for this and open/focus/clear themselves.',
    },
  },
  ['action'],
);


/** The persisted settings page's public shape (never includes the LAN token). */
export const SETTINGS_OUTPUT_SCHEMA = object(
  {
    settings: object(
      {
        transport: { type: 'string', enum: ['ble', 'lan', 'loopback'] },
        bleName: string('BLE name fragment to dial.'),
        bleAddress: string('BLE address to dial.'),
        lanHost: string('LAN bridge host, host:port or ws:// URL.'),
        cliPath: string('bee-cli executable; empty = auto-detect.'),
        timeoutMs: integer(1_000, 2_147_483_647, 'Per-call budget in milliseconds.'),
        sendCaptureMs: integer(0, 60_000, 'Reply window for linkr_bee_send in milliseconds.'),
        webConsole: boolean('Serve the local browser console page.'),
        lanTokenSet: boolean('A LAN token is configured (the token itself is never returned).'),
        uart: object(
          {
            baud: integer(1, undefined, 'Baud rate.'),
            dataBits: integer(5, 8, 'Data bits.'),
            parity: { type: 'string', enum: ['n', 'e', 'o'] },
            stopBits: integer(1, 2, 'Stop bits.'),
            flow: { type: 'string', enum: ['none', 'rtscts'] },
          },
          ['baud', 'dataBits', 'parity', 'stopBits', 'flow'],
        ),
      },
      ['transport', 'bleName', 'bleAddress', 'lanHost', 'cliPath', 'timeoutMs', 'sendCaptureMs', 'webConsole', 'lanTokenSet'],
    ),
    defaults: object(
      {
        transport: { type: 'string', enum: ['ble', 'lan', 'loopback'] },
        timeoutMs: integer(1_000, 2_147_483_647, 'Default per-call budget in milliseconds.'),
        sendCaptureMs: integer(0, 60_000, 'Default reply window for linkr_bee_send in milliseconds.'),
        webConsole: boolean('Default for serving the local browser console page.'),
      },
      ['transport', 'timeoutMs', 'sendCaptureMs', 'webConsole'],
    ),
  },
  ['settings'],
);

/** `updateSettings` input: omit a key to keep it, null to clear it. */
export const UPDATE_SETTINGS_INPUT_SCHEMA = object({
  transport: { type: 'string', enum: ['ble', 'lan', 'loopback'] },
  bleName: string('BLE name fragment to dial; "" clears it.'),
  bleAddress: string('BLE address to dial; "" clears it.'),
  lanHost: string('LAN bridge host; "" clears it.'),
  lanToken: {
    type: ['string', 'null'],
    description: 'New LAN token; null clears the stored token, omitted keeps the current one.',
  },
  cliPath: string('bee-cli executable; "" means auto-detect.'),
  timeoutMs: integer(1_000, 2_147_483_647, 'Per-call budget in milliseconds.'),
  sendCaptureMs: integer(0, 60_000, 'Reply window for linkr_bee_send in milliseconds.'),
  webConsole: boolean('Serve the local browser console page.'),
  uart: object(
    {
      baud: integer(1, undefined, 'Baud rate.'),
      dataBits: integer(5, 8, 'Data bits.'),
      parity: { type: 'string', enum: ['n', 'e', 'o'] },
      stopBits: integer(1, 2, 'Stop bits.'),
      flow: { type: 'string', enum: ['none', 'rtscts'] },
    },
    ['baud', 'dataBits', 'parity', 'stopBits', 'flow'],
  ),
});

/** `scan` output: nearby boards (name and RSSI), no dial. */
export const SCAN_OUTPUT_SCHEMA = object(
  {
    boards: {
      type: 'array',
      description: 'Linkr Bee boards heard during the scan.',
      items: object(
        {
          name: string('Board name.'),
          rssi: integer(undefined, undefined, 'RSSI in dBm.'),
        },
        ['name', 'rssi'],
      ),
    },
  },
  ['boards'],
);

/** `applyUart` input/output: change the bridge UART settings over BLE. */
export const APPLY_UART_INPUT_SCHEMA = object(
  {
    baud: integer(1, undefined, 'Baud rate.'),
    dataBits: integer(5, 8, 'Data bits.'),
    parity: { type: 'string', enum: ['n', 'e', 'o'], description: 'Parity: n, e or o.' },
    stopBits: integer(1, 2, 'Stop bits.'),
    flow: { type: 'string', enum: ['none', 'rtscts'], description: 'Flow control.' },
  },
  ['baud', 'dataBits', 'parity', 'stopBits', 'flow'],
);

export const APPLY_UART_OUTPUT_SCHEMA = object(
  {
    ok: boolean('The bridge accepted the new UART settings.'),
    result: string('What bee-cli answered (the read-back of the new settings).'),
  },
  ['ok', 'result'],
);

/** Shared JSON Schema for one settings answer. */
const SETTINGS_RESULT = SETTINGS_OUTPUT_SCHEMA;

/**
 * The portable definition object. `src/rpc.js` passes it through
 * `Rpc.define`, which is an identity helper; UI code only needs the object so
 * it can call `ctx.client.rpc(LinkrBeeConsole)`.
 */
export function consoleRpcDefinition() {
  return {
    id: CONSOLE_RPC_ID,
    methods: {
      state: { input: EMPTY, output: STATE_SCHEMA },
      read: { input: READ_INPUT_SCHEMA, output: READ_OUTPUT_SCHEMA },
      write: { input: WRITE_INPUT_SCHEMA, output: OK },
      key: { input: KEY_INPUT_SCHEMA, output: OK },
      resize: { input: RESIZE_INPUT_SCHEMA, output: RESIZE_OUTPUT_SCHEMA },
      clear: { input: EMPTY, output: OK },
      reconnect: { input: EMPTY, output: OK },
      webUrl: { input: EMPTY, output: WEB_URL_OUTPUT_SCHEMA },
      settings: { input: EMPTY, output: SETTINGS_RESULT },
      updateSettings: { input: UPDATE_SETTINGS_INPUT_SCHEMA, output: SETTINGS_OUTPUT_SCHEMA },
      scan: { input: EMPTY, output: SCAN_OUTPUT_SCHEMA },
      applyUart: { input: APPLY_UART_INPUT_SCHEMA, output: APPLY_UART_OUTPUT_SCHEMA },
    },
    events: {
      output: { schema: OUTPUT_EVENT_SCHEMA },
      state: { schema: STATE_EVENT_SCHEMA },
      request: { schema: REQUEST_EVENT_SCHEMA },
    },
  };
}
