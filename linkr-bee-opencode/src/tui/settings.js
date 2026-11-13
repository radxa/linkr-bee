/**
 * TUI settings and pairing flows, as plain functions over the host's dialog,
 * toast and console RPC. Keeping them out of the component tree means they are
 * testable with a fake dialog/RPC and shared by the palette commands and the
 * `/linkr-bee scan|settings|status` subcommands.
 *
 * The flow mirrors the desktop settings page: connect first (scan → pick a
 * board → save → dial), then the less frequent fields behind a settings menu,
 * with only the active transport's fields asked for.
 */

const TRANSPORTS = [
  { value: 'ble', label: 'Bluetooth LE' },
  { value: 'lan', label: 'LAN (WiFi bridge)' },
  { value: 'loopback', label: 'Loopback (no hardware)' },
];

const SCAN_HINT =
  'No Linkr Bee board was heard. Check that the board is powered (its LED is on) and close by; ' +
  'a board already connected to a phone or another computer stops advertising, so disconnect it there first. ' +
  'For a first connection from a new host, press the board pairing key once (C3/C5: GPIO1, Linkr Bee X1: GPIO3/USER_KEY) ' +
  'and connect within 30 seconds.';

function messageOf(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function alert(dialog, title, message) {
  await dialog.alert({ title, message }).catch(() => {});
}

function toastShow(toast, title, message, variant) {
  try {
    toast?.show({ title, message, ...(variant ? { variant } : {}) });
  } catch {
    /* a host without toasts still gets the alert */
  }
}

async function call(rpc, label, work) {
  try {
    return { value: await work(rpc), error: undefined };
  } catch (cause) {
    return { value: undefined, error: `${label}: ${messageOf(cause)}` };
  }
}

function statusLine(state) {
  if (!state || typeof state !== 'object') return 'Unknown';
  if (state.connected) return `Connected · ${state.transport || '—'} · ${state.target || '—'}`;
  return `Disconnected · ${state.transport || '—'} · ${state.target || 'no target yet'}`;
}

/** Settings shape from `settings`, or undefined when the server is old. */
export async function fetchSettings(rpc) {
  const answer = await call(rpc, 'settings', (api) => api.settings({}));
  if (answer.error) throw new Error(answer.error);
  return answer.value?.settings ?? answer.value;
}

/** One settings patch, applied and persisted by the server. */
export async function patchSettings(rpc, patch) {
  const answer = await call(rpc, 'updateSettings', (api) => api.updateSettings(patch));
  if (answer.error) throw new Error(answer.error);
  return answer.value?.settings ?? answer.value;
}

/** Scan, let the person pick a board, save its name and dial it. */
export async function scanAndConnect({ dialog, toast, rpc }) {
  const scan = await call(rpc, 'scan', (api) => api.scan({}));
  if (scan.error) {
    await alert(dialog, 'Linkr Bee: scan failed', scan.error);
    toastShow(toast, 'Linkr Bee', scan.error, 'error');
    return false;
  }
  const boards = scan.value?.boards ?? [];
  if (!Array.isArray(boards) || boards.length === 0) {
    await alert(dialog, 'Linkr Bee: no boards found', SCAN_HINT);
    return false;
  }
  const picked = await dialog
    .select({
      title: 'Linkr Bee: pick a board',
      placeholder: 'Filter boards…',
      options: boards.map((board) => ({
        title: board.name,
        value: board,
        description: `RSSI ${board.rssi} dBm`,
      })),
    })
    .catch(() => undefined);
  if (!picked) return false;

  const saved = await call(rpc, 'save board', () => patchSettings(rpc, { transport: 'ble', bleName: picked.name }));
  if (saved.error) {
    await alert(dialog, 'Linkr Bee: cannot save the board', saved.error);
    return false;
  }
  const linked = await call(rpc, 'connect', (api) => api.reconnect({}));
  if (linked.error) {
    await alert(dialog, 'Linkr Bee: connect failed', linked.error);
    return false;
  }
  const stateAnswer = await call(rpc, 'state', (api) => api.state({}));
  const state = stateAnswer.value;
  if (state?.connected) {
    await alert(dialog, 'Linkr Bee: connected', `Connected to ${state.target || picked.name}.`);
    toastShow(toast, 'Linkr Bee', `Connected to ${state.target || picked.name}.`);
    return true;
  }
  await alert(
    dialog,
    'Linkr Bee: paired, not connected',
    `${picked.name} was saved, but the link did not come up${state?.target ? `: ${state.target}` : ''}.\n\n${SCAN_HINT}`,
  );
  return false;
}

/** Dial the saved board and report the result. */
export async function connectSaved({ dialog, toast, rpc }) {
  const linked = await call(rpc, 'connect', (api) => api.reconnect({}));
  if (linked.error) {
    await alert(dialog, 'Linkr Bee: connect failed', linked.error);
    return false;
  }
  const stateAnswer = await call(rpc, 'state', (api) => api.state({}));
  const state = stateAnswer.value;
  const line = statusLine(state);
  await alert(dialog, 'Linkr Bee: link', line);
  toastShow(toast, 'Linkr Bee', line, state?.connected ? undefined : 'error');
  return !!state?.connected;
}

/** Show the current link state. */
export async function showStatus({ dialog, rpc }) {
  const stateAnswer = await call(rpc, 'state', (api) => api.state({}));
  if (stateAnswer.error) {
    await alert(dialog, 'Linkr Bee: status', stateAnswer.error);
    return;
  }
  const state = stateAnswer.value;
  await alert(
    dialog,
    'Linkr Bee: status',
    `${statusLine(state)}\n${state?.webUrl ? `Browser console page: ${state.webUrl}` : 'Browser console page: off'}`,
  );
}

/** Ask for a value, return undefined when the dialog is cancelled. */
async function promptFor(dialog, options) {
  return dialog.prompt(options).catch(() => undefined);
}

async function saveAndReport({ dialog, toast, rpc }, patch, what) {
  const result = await call(rpc, 'save', () => patchSettings(rpc, patch));
  if (result.error) {
    await alert(dialog, 'Linkr Bee: settings failed', result.error);
    toastShow(toast, 'Linkr Bee', result.error, 'error');
    return undefined;
  }
  toastShow(toast, 'Linkr Bee', `${what} saved.`);
  return result.value;
}

/** The board submenu: the connect-first, most frequent flow. */
export async function boardMenu({ dialog, toast, rpc }) {
  for (;;) {
    const choice = await dialog
      .select({
        title: 'Linkr Bee: board',
        options: [
          { title: 'Scan and connect…', value: 'scan', description: 'Find nearby boards with Bluetooth LE (about 8 s)' },
          { title: 'Connect saved board', value: 'connect', description: 'Dial the board already named in the settings' },
          { title: 'Show status', value: 'status', description: 'Link state, target and browser page URL' },
          { title: 'Set BLE name…', value: 'ble-name', description: 'Name fragment to dial' },
          { title: 'Set BLE address…', value: 'ble-address', description: 'Address overrides name discovery' },
          { title: 'Close', value: 'close' },
        ],
      })
      .catch(() => undefined);
    if (!choice || choice === 'close') return;
    if (choice === 'scan') {
      await scanAndConnect({ dialog, toast, rpc });
      continue;
    }
    if (choice === 'connect') {
      await connectSaved({ dialog, toast, rpc });
      continue;
    }
    if (choice === 'status') {
      await showStatus({ dialog, rpc });
      continue;
    }
    if (choice === 'ble-name' || choice === 'ble-address') {
      const key = choice === 'ble-name' ? 'bleName' : 'bleAddress';
      const current = await call(rpc, 'settings', (api) => api.settings({})).then((answer) => answer.value?.settings ?? {});
      const value = await promptFor(dialog, {
        title: choice === 'ble-name' ? 'Linkr Bee: BLE name' : 'Linkr Bee: BLE address',
        description: 'Leave empty to clear the saved value; Esc cancels.',
        placeholder: choice === 'ble-name' ? 'e.g. 6B80' : 'EE:C7:42:34:48:CF',
        value: current?.[key] ?? '',
      });
      if (value === undefined) continue;
      await saveAndReport({ dialog, toast, rpc }, { transport: 'ble', [key]: value }, choice === 'ble-name' ? 'BLE name' : 'BLE address');
    }
  }
}

/** The settings submenu: transport-specific fields, UART, browser page. */
export async function settingsMenu({ dialog, toast, rpc }) {
  for (;;) {
    const settings = await fetchSettings(rpc).catch(() => undefined);
    if (!settings) {
      await alert(dialog, 'Linkr Bee: settings', 'The settings RPC is not available on this server.');
      return;
    }
    const choice = await dialog
      .select({
        title: 'Linkr Bee: settings',
        options: [
          { title: `Transport: ${settings.transport}`, value: 'transport', description: 'Bluetooth LE, LAN or loopback' },
          ...(settings.transport === 'ble'
            ? [{ title: `BLE name: ${settings.bleName || '(discover)'}`, value: 'bleName', description: 'Name fragment to dial' }]
            : []),
          ...(settings.transport === 'lan'
            ? [{ title: `LAN host: ${settings.lanHost || '(unset)'}`, value: 'lanHost', description: 'host, host:port or ws:// URL' }]
            : []),
          ...(settings.transport === 'lan'
            ? [{ title: `LAN token: ${settings.lanTokenSet ? 'stored' : '(unset)'}`, value: 'lanToken', description: 'Write-only; empty clears it' }]
            : []),
          { title: `bee-cli: ${settings.cliPath || '(auto)'}`, value: 'cliPath', description: 'Executable path' },
          { title: `Timeout: ${settings.timeoutMs} ms`, value: 'timeoutMs' },
          { title: `Send capture: ${settings.sendCaptureMs} ms`, value: 'sendCaptureMs' },
          {
            title: `Browser console page: ${settings.webConsole ? 'on' : 'off'}`,
            value: 'webConsole',
            description: 'Local page at a 127.0.0.1 URL with a token',
          },
          {
            title: 'Bridge UART…',
            value: 'uart',
            description: settings.transport === 'ble' ? 'Baud, data bits, parity, stop bits, flow' : 'Only available with Bluetooth LE',
            disabled: settings.transport !== 'ble',
          },
          { title: 'Show all settings', value: 'show' },
          { title: 'Close', value: 'close' },
        ],
      })
      .catch(() => undefined);
    if (!choice || choice === 'close') return;

    if (choice === 'show') {
      await alert(
        dialog,
        'Linkr Bee: current settings',
        [
          `transport: ${settings.transport}`,
          ...(settings.transport === 'ble' ? [`BLE name: ${settings.bleName || '(discover)'}`, `BLE address: ${settings.bleAddress || '(discover)'}`] : []),
          ...(settings.transport === 'lan' ? [`LAN host: ${settings.lanHost || '(unset)'}`, `LAN token: ${settings.lanTokenSet ? 'stored' : '(unset)'}`] : []),
          `bee-cli: ${settings.cliPath || '(auto)'}`,
          `timeout: ${settings.timeoutMs} ms`,
          `send capture: ${settings.sendCaptureMs} ms`,
          `browser console page: ${settings.webConsole ? 'on' : 'off'}`,
          ...(settings.uart ? [`UART: ${settings.uart.baud},${settings.uart.dataBits},${settings.uart.parity},${settings.uart.stopBits},${settings.uart.flow}`] : []),
          `file: $XDG_STATE_HOME/opencode/linkr-bee.json`,
        ].join('\n'),
      );
      continue;
    }

    if (choice === 'transport') {
      const value = await dialog
        .select({
          title: 'Linkr Bee: transport',
          current: settings.transport,
          options: TRANSPORTS.map((transport) => ({
            title: transport.label,
            value: transport.value,
            description: settings.transport === transport.value ? 'current' : undefined,
          })),
        })
        .catch(() => undefined);
      if (!value) continue;
      await saveAndReport({ dialog, toast, rpc }, { transport: value }, 'Transport');
      continue;
    }

    if (choice === 'webConsole') {
      const enabled = await dialog
        .confirm({
          title: 'Linkr Bee: browser console page',
          message: settings.webConsole
            ? 'Turn the local browser console page off?'
            : 'Serve the local browser console page? It listens on 127.0.0.1 with a token in its URL.',
          label: { confirm: settings.webConsole ? 'Turn off' : 'Turn on' },
        })
        .catch(() => undefined);
      if (enabled === undefined) continue;
      const saved = await saveAndReport({ dialog, toast, rpc }, { webConsole: enabled }, 'Browser console page');
      if (saved?.webConsole) {
        const url = await call(rpc, 'webUrl', (api) => api.webUrl({})).then((answer) => answer.value?.url ?? '');
        if (url) await alert(dialog, 'Linkr Bee: browser console page', url);
      }
      continue;
    }

    if (choice === 'uart') {
      await uartMenu({ dialog, toast, rpc });
      continue;
    }

    // Text/number fields: ask for a value and save it.
    const currentValue =
      choice === 'bleName' ? settings.bleName
        : choice === 'lanHost' ? settings.lanHost
          : choice === 'cliPath' ? settings.cliPath
            : choice === 'timeoutMs' ? String(settings.timeoutMs)
              : choice === 'sendCaptureMs' ? String(settings.sendCaptureMs)
                : '';
    const value = await promptFor(dialog, {
      title: `Linkr Bee: ${choice}`,
      description:
        choice === 'lanToken' ? 'Write-only: type a new token. Leave empty to clear it; Esc cancels.'
          : choice === 'cliPath' ? 'Leave empty to auto-detect bee-cli.'
            : 'Leave empty to clear; Esc cancels.',
      value: currentValue,
      placeholder: choice === 'timeoutMs' ? '30000' : choice === 'sendCaptureMs' ? '1500' : '',
    });
    if (value === undefined) continue;
    if (choice === 'timeoutMs' || choice === 'sendCaptureMs') {
      const parsed = Number(value.trim() === '' ? 'NaN' : value.trim());
      if (!Number.isFinite(parsed)) {
        await alert(dialog, 'Linkr Bee: settings', 'Enter a number of milliseconds.');
        continue;
      }
      await saveAndReport({ dialog, toast, rpc }, { [choice]: Math.round(parsed) }, choice === 'timeoutMs' ? 'Timeout' : 'Send capture window');
    } else {
      await saveAndReport({ dialog, toast, rpc }, { [choice]: value }, choice);
    }
  }
}

const PARITY = [
  { value: 'n', label: 'None' },
  { value: 'e', label: 'Even' },
  { value: 'o', label: 'Odd' },
];

/** The bridge UART submenu (Bluetooth LE links only). */
export async function uartMenu({ dialog, toast, rpc }) {
  for (;;) {
    const settings = await fetchSettings(rpc).catch(() => undefined);
    if (!settings) return;
    if (settings.transport !== 'ble') {
      await alert(dialog, 'Linkr Bee: bridge UART', 'UART settings need the Bluetooth LE transport; LAN and loopback cannot configure the bridge.');
      return;
    }
    const uart = settings.uart ?? { baud: 115200, dataBits: 8, parity: 'n', stopBits: 1, flow: 'none' };
    const choice = await dialog
      .select({
        title: 'Linkr Bee: bridge UART',
        options: [
          { title: `Baud rate: ${uart.baud}`, value: 'baud', description: 'Common rates, or type a number' },
          { title: `Data bits: ${uart.dataBits}`, value: 'dataBits' },
          { title: `Parity: ${uart.parity}`, value: 'parity' },
          { title: `Stop bits: ${uart.stopBits}`, value: 'stopBits' },
          { title: `Flow control: ${uart.flow}`, value: 'flow' },
          { title: 'Apply UART to the bridge', value: 'apply', description: 'Writes the format over BLE and reads it back' },
          { title: 'Back', value: 'back' },
        ],
      })
      .catch(() => undefined);
    if (!choice || choice === 'back') return;

    if (choice === 'baud') {
      const value = await dialog
        .select({
          title: 'Linkr Bee: baud rate',
          current: String(uart.baud),
          options: ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600', 'Custom…'].map((rate) => ({
            title: rate,
            value: rate,
          })),
        })
        .catch(() => undefined);
      if (!value) continue;
      let baud = Number(value);
      if (value === 'Custom…') {
        const text = await promptFor(dialog, { title: 'Linkr Bee: custom baud rate', placeholder: 'e.g. 250000' });
        if (text === undefined) continue;
        baud = Number(text.trim());
      }
      if (!Number.isInteger(baud) || baud <= 0) {
        await alert(dialog, 'Linkr Bee: bridge UART', 'Enter a positive baud rate.');
        continue;
      }
      await patchSettings(rpc, { uart: { ...uart, baud } }).catch(() => {});
      continue;
    }
    if (choice === 'dataBits') {
      const value = await dialog
        .select({ title: 'Linkr Bee: data bits', current: String(uart.dataBits), options: ['5', '6', '7', '8'].map((bits) => ({ title: bits, value: bits })) })
        .catch(() => undefined);
      if (!value) continue;
      await patchSettings(rpc, { uart: { ...uart, dataBits: Number(value) } }).catch(() => {});
      continue;
    }
    if (choice === 'parity') {
      const value = await dialog
        .select({ title: 'Linkr Bee: parity', current: uart.parity, options: PARITY.map((item) => ({ title: item.label, value: item.value })) })
        .catch(() => undefined);
      if (!value) continue;
      await patchSettings(rpc, { uart: { ...uart, parity: value } }).catch(() => {});
      continue;
    }
    if (choice === 'stopBits') {
      const value = await dialog
        .select({ title: 'Linkr Bee: stop bits', current: String(uart.stopBits), options: ['1', '2'].map((bits) => ({ title: bits, value: bits })) })
        .catch(() => undefined);
      if (!value) continue;
      await patchSettings(rpc, { uart: { ...uart, stopBits: Number(value) } }).catch(() => {});
      continue;
    }
    if (choice === 'flow') {
      const value = await dialog
        .select({
          title: 'Linkr Bee: flow control',
          current: uart.flow,
          options: [
            { title: 'None', value: 'none' },
            { title: 'RTS/CTS', value: 'rtscts' },
          ],
        })
        .catch(() => undefined);
      if (!value) continue;
      await patchSettings(rpc, { uart: { ...uart, flow: value } }).catch(() => {});
      continue;
    }
    if (choice === 'apply') {
      const answer = await call(rpc, 'applyUart', (api) => api.applyUart(uart));
      if (answer.error) {
        await alert(dialog, 'Linkr Bee: bridge UART', answer.error);
        toastShow(toast, 'Linkr Bee', answer.error, 'error');
        continue;
      }
      const result = answer.value?.result ?? '';
      await alert(dialog, 'Linkr Bee: bridge UART', result || 'Bridge UART applied.');
      toastShow(toast, 'Linkr Bee', 'Bridge UART applied.');
    }
  }
}
