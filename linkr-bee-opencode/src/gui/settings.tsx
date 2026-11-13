/**
 * The Linkr Bee settings page in OpenCode's Settings, backed by the console
 * RPC (`settings` / `updateSettings` / `scan` / `applyUart`).
 *
 * The page is laid out around the task a person actually came for — getting a
 * board connected:
 *
 *  1. **Board** — current link state, Scan, the boards found (one Connect per
 *     board) and a plain Connect. This is the primary flow.
 *  2. **Connection** — only the fields of the chosen transport (BLE name/
 *     address, or LAN host/token), plus the shared bee-cli path and budgets.
 *  3. **Bridge UART** — shows only for Bluetooth LE, because LAN and loopback
 *     links cannot configure the bridge.
 *  4. **Browser console page** — the local page switch and its URL.
 *
 * Saving persists the values in the plugin's own settings file on the server
 * (`$XDG_STATE_HOME/opencode/linkr-bee.json`) and applies at once; the
 * opencode.json `options` and the environment stay the lower-precedence
 * defaults. The page uses the app's settings components and degrades to a
 * readable notice instead of throwing when the server half is unavailable.
 */
import { createSignal, For, onMount, Show } from 'solid-js';
import { SettingsPage, usePlugin } from '@opencode/plugin/gui';

import LinkrBeeConsole from '../rpc.js';
import type { definition } from './definition';

/** The page's id: `/settings?tab=linkr-bee`. */
export const SETTINGS_PAGE_ID = 'linkr-bee';

interface SettingsState {
  transport: 'ble' | 'lan' | 'loopback';
  bleName: string;
  bleAddress: string;
  lanHost: string;
  cliPath: string;
  timeoutMs: number;
  sendCaptureMs: number;
  webConsole: boolean;
  lanTokenSet: boolean;
  uart?: { baud: number; dataBits: number; parity: string; stopBits: number; flow: string };
}

interface Board {
  name: string;
  rssi: number;
}

interface LiveState {
  connected: boolean;
  transport: string;
  target: string;
}

const EMPTY: SettingsState = {
  transport: 'ble',
  bleName: '',
  bleAddress: '',
  lanHost: '',
  cliPath: '',
  timeoutMs: 30000,
  sendCaptureMs: 1500,
  webConsole: true,
  lanTokenSet: false,
};

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const SCAN_HINT =
  'No Linkr Bee board was heard. Check that the board is powered (its LED is on) and close by; ' +
  'a board already connected to a phone or another computer stops advertising, so disconnect it there first. ' +
  'For a first connection from a new host, press the board pairing key once (C3/C5: GPIO1, Linkr Bee X1: GPIO3/USER_KEY) ' +
  'and connect within 30 seconds.';

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** One setting row in the app's settings style. */
function Row(props: { title: string; description?: string; id?: string; children?: any }) {
  const ctx = usePlugin<typeof definition>();
  return (
    <ctx.ui.SettingsRow id={props.id} title={props.title} description={props.description}>
      {props.children}
    </ctx.ui.SettingsRow>
  );
}

/** The page itself. */
export function LinkrBeeSettings() {
  const ctx = usePlugin<typeof definition>();
  const rpc = ctx.client.rpc(LinkrBeeConsole);

  const [settings, setSettings] = createSignal<SettingsState>({ ...EMPTY });
  const [loaded, setLoaded] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal('');
  const [error, setError] = createSignal('');
  const [boards, setBoards] = createSignal<Board[]>([]);
  const [scanning, setScanning] = createSignal(false);
  const [scanned, setScanned] = createSignal(false);
  const [tokenDraft, setTokenDraft] = createSignal('');
  const [clearToken, setClearToken] = createSignal(false);
  const [webUrl, setWebUrl] = createSignal('');
  const [live, setLive] = createSignal<LiveState | null>(null);

  function update<K extends keyof SettingsState>(key: K, value: SettingsState[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  /* ------------------------------------------------------------- loading */

  async function load() {
    try {
      const response: any = await rpc.settings({});
      const payload = response?.settings ?? response;
      if (payload && typeof payload === 'object') {
        setSettings({ ...EMPTY, ...payload });
        setLoaded(true);
      }
      setTokenDraft('');
      setClearToken(false);
      setError('');
      void loadLive();
    } catch (err) {
      setError(describe(err));
    }
  }

  async function loadLive() {
    try {
      const state: any = await rpc.state({});
      const next: LiveState = {
        connected: !!state?.connected,
        transport: String(state?.transport ?? ''),
        target: String(state?.target ?? ''),
      };
      setLive(next);
      const url = String(state?.webUrl ?? '');
      if (url) setWebUrl(url);
      return next;
    } catch {
      setLive(null);
      return null;
    }
  }

  async function loadWebUrl() {
    try {
      const answer: any = await rpc.webUrl({});
      const url = String(answer?.url ?? answer?.state?.webUrl ?? '');
      if (url) setWebUrl(url);
    } catch {
      /* the page server may be off; the state call reports it */
    }
  }

  onMount(() => {
    void load();
    void loadWebUrl();
  });

  /* --------------------------------------------------------- save & dial */

  function payload(): Record<string, unknown> {
    const current = settings();
    const out: Record<string, unknown> = {
      transport: current.transport,
      bleName: current.bleName,
      bleAddress: current.bleAddress,
      lanHost: current.lanHost,
      cliPath: current.cliPath,
      timeoutMs: current.timeoutMs,
      sendCaptureMs: current.sendCaptureMs,
      webConsole: current.webConsole,
    };
    if (clearToken()) out.lanToken = null;
    else if (tokenDraft() !== '') out.lanToken = tokenDraft();
    return out;
  }

  async function save(): Promise<boolean> {
    if (busy()) return false;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const answer: any = await rpc.updateSettings(payload() as any);
      const saved = answer?.settings ?? answer?.updateSettings?.settings;
      if (saved && typeof saved === 'object') setSettings({ ...EMPTY, ...saved });
      setTokenDraft('');
      setClearToken(false);
      setNotice('Saved. Applied immediately.');
      void loadLive();
      if (settings().webConsole) void loadWebUrl();
      else setWebUrl('');
      return true;
    } catch (err) {
      setError(describe(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Dial the board with the current saved settings and say what happened. */
  async function connect() {
    if (busy()) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await rpc.reconnect({});
      const state = await loadLive();
      if (state?.connected) setNotice(`Connected to ${state.target || 'the board'}.`);
      else setNotice(`Not connected: ${state?.target || 'no board found'}`);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  /** Save this board's name, then dial it — the one-click pairing flow. */
  async function connectBoard(board: Board) {
    if (busy()) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const answer: any = await rpc.updateSettings({ transport: 'ble', bleName: board.name } as any);
      const saved = answer?.settings ?? answer?.updateSettings?.settings;
      if (saved && typeof saved === 'object') setSettings({ ...EMPTY, ...saved });
      await rpc.reconnect({});
      const state = await loadLive();
      if (state?.connected) setNotice(`Connected to ${state.target || board.name}.`);
      else setNotice(`Paired with ${board.name} but not connected yet: ${state?.target || 'no link'}`);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    if (scanning()) return;
    setScanning(true);
    setError('');
    setScanned(true);
    try {
      const answer: any = await rpc.scan({});
      const list = answer?.boards ?? answer?.scan?.boards ?? [];
      setBoards(Array.isArray(list) ? list : []);
      if (Array.isArray(list) && list.length > 0) {
        setNotice(`Found ${list.length} board${list.length === 1 ? '' : 's'}. Pick one to connect.`);
        void loadLive();
      } else {
        setNotice(SCAN_HINT);
      }
    } catch (err) {
      setError(describe(err));
    } finally {
      setScanning(false);
    }
  }

  /* --------------------------------------------------------- bridge UART */

  async function applyUart() {
    if (busy()) return;
    setBusy(true);
    setNotice('');
    setError('');
    const uart = settings().uart ?? { baud: 115200, dataBits: 8, parity: 'n', stopBits: 1, flow: 'none' };
    try {
      const answer: any = await rpc.applyUart(uart as any);
      const result = answer?.result ?? answer?.applyUart?.result ?? '';
      setNotice(result ? `Bridge UART: ${result}` : 'Bridge UART applied.');
      void load();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  function setUart(key: string, value: unknown) {
    const current = settings().uart ?? { baud: 115200, dataBits: 8, parity: 'n', stopBits: 1, flow: 'none' };
    update('uart', { ...current, [key]: value } as any);
  }

  async function copyUrl() {
    try {
      await ctx.system.copy(webUrl());
      setNotice('Copied the browser console URL.');
    } catch {
      setNotice(webUrl());
    }
  }

  /* --------------------------------------------------------------- view */

  const statusText = () => {
    const state = live();
    if (!state) return 'Unknown — press Refresh.';
    if (state.connected) return `Connected · ${state.transport || '—'} · ${state.target || '—'}`;
    return `Disconnected · ${state.transport || '—'} · ${state.target || 'no target yet'}`;
  };

  return (
    <ctx.ui.SettingsLayout
      title="Linkr Bee"
      description="Connect a board, then tune the bridge and the console page. Changes apply immediately."
    >
      <Show when={error()}>
        <ctx.ui.SettingsSection footer={<span class="lb-settings__error">{error()}</span>}>
          <Row
            title="The settings server is not available"
            description="The Linkr Bee plugin's server half is not reachable in this window. Restart OpenCode after installing the plugin."
          />
        </ctx.ui.SettingsSection>
      </Show>

      <Show when={!loaded() && !error()}>
        <ctx.ui.SettingsSection>
          <Row title="Loading settings…" />
        </ctx.ui.SettingsSection>
      </Show>

      <Show when={loaded()}>
        {/* 1. The task most people came for: get a board connected. */}
        <ctx.ui.SettingsSection title="Board">
          <Row id="linkr-bee-connection" title="Status" description={statusText()}>
            <ctx.ui.Button size="small" variant="ghost" onClick={() => void loadLive()}>
              Refresh
            </ctx.ui.Button>
            <ctx.ui.Button size="small" busy={busy()} onClick={() => void connect()}>
              Connect
            </ctx.ui.Button>
          </Row>
          <Row
            title="Find nearby boards"
            description={`Scan with Bluetooth LE for ${settings().transport === 'ble' ? 'boards that are advertising' : 'boards'} (about 8 seconds, does not connect by itself).`}
          >
            <ctx.ui.Button size="small" busy={scanning()} onClick={() => void scan()}>
              Scan
            </ctx.ui.Button>
          </Row>
          <For each={boards()}>
            {(board: Board) => (
              <Row title={board.name} description={`RSSI ${board.rssi} dBm`}>
                <ctx.ui.Button size="small" variant="contrast" busy={busy()} onClick={() => void connectBoard(board)}>
                  Connect
                </ctx.ui.Button>
              </Row>
            )}
          </For>
          <Show when={scanned() && boards().length === 0}>
            <Row title="Nothing heard" description={SCAN_HINT} />
          </Show>
          <Row
            title="Connected without scanning"
            description="Dial the board already named below (useful once it is paired and no longer advertising under a new name)."
          >
            <ctx.ui.Button size="small" variant="ghost" busy={busy()} onClick={() => void connect()}>
              Connect saved board
            </ctx.ui.Button>
          </Row>
        </ctx.ui.SettingsSection>

        {/* 2. Only the fields of the chosen transport, then the shared bits. */}
        <ctx.ui.SettingsSection title="Connection">
          <Row
            title="Transport"
            description="How OpenCode reaches the bridge. Bluetooth LE is the usual choice; LAN needs the bridge on WiFi; loopback needs no hardware."
          >
            <ctx.ui.Select
              label="Transport"
              value={settings().transport}
              options={[
                { value: 'ble', label: 'Bluetooth LE' },
                { value: 'lan', label: 'LAN (WiFi bridge)' },
                { value: 'loopback', label: 'Loopback (no hardware)' },
              ]}
              onChange={(value: 'ble' | 'lan' | 'loopback') => update('transport', value)}
            />
          </Row>
          <Show when={settings().transport === 'ble'}>
            <Row title="BLE name" description="Name fragment to dial; empty discovers the board by scanning.">
              <ctx.ui.TextInput
                label="BLE name"
                value={settings().bleName}
                placeholder="e.g. 6B80"
                onInput={(value: string) => update('bleName', value)}
              />
            </Row>
            <Row title="BLE address" description="Board address (EE:C7:…); overrides name discovery when set.">
              <ctx.ui.TextInput
                label="BLE address"
                value={settings().bleAddress}
                placeholder="EE:C7:42:34:48:CF"
                onInput={(value: string) => update('bleAddress', value)}
              />
            </Row>
          </Show>
          <Show when={settings().transport === 'lan'}>
            <Row title="LAN host" description="Bridge address: host, host:port or ws:// URL.">
              <ctx.ui.TextInput
                label="LAN host"
                value={settings().lanHost}
                placeholder="192.168.1.20:8710"
                onInput={(value: string) => update('lanHost', value)}
              />
            </Row>
            <Row
              title="LAN token"
              description={settings().lanTokenSet ? 'A token is stored. Type a new one to replace it, or Clear it.' : 'Access token from the bridge LAN page.'}
            >
              <ctx.ui.TextInput
                type="password"
                label="LAN token"
                value={tokenDraft()}
                placeholder={clearToken() ? 'Will be cleared on save' : '32 hex characters'}
                onInput={(value: string) => {
                  setTokenDraft(value);
                  if (value !== '') setClearToken(false);
                }}
              />
              <ctx.ui.Button size="small" variant="ghost" onClick={() => { setClearToken(true); setTokenDraft(''); }}>
                Clear
              </ctx.ui.Button>
            </Row>
          </Show>
          <Row title="bee-cli path" description="Executable to run; empty auto-detects (env, installed launcher, checkout build, PATH).">
            <ctx.ui.TextInput
              label="bee-cli path"
              value={settings().cliPath}
              placeholder="auto"
              onInput={(value: string) => update('cliPath', value)}
            />
          </Row>
          <Row title="Request timeout" description="Per-call budget in milliseconds (1000 or more).">
            <ctx.ui.TextInput
              label="Request timeout"
              value={String(settings().timeoutMs)}
              onInput={(value: string) => {
                const parsed = Number(value);
                if (Number.isFinite(parsed) && parsed > 0) update('timeoutMs', Math.round(parsed));
              }}
            />
          </Row>
          <Row title="Send capture window" description="How long linkr_bee_send keeps the link open for the reply, in milliseconds.">
            <ctx.ui.TextInput
              label="Send capture window"
              value={String(settings().sendCaptureMs)}
              onInput={(value: string) => {
                const parsed = Number(value);
                if (Number.isFinite(parsed) && parsed >= 0) update('sendCaptureMs', Math.round(parsed));
              }}
            />
          </Row>
          <Row title="Save connection settings" description="Applies at once and persists for every OpenCode window.">
            <ctx.ui.Button variant="contrast" busy={busy()} onClick={() => void save()}>
              Save
            </ctx.ui.Button>
          </Row>
        </ctx.ui.SettingsSection>

        {/* 3. UART only makes sense on a Bluetooth LE link. */}
        <Show when={settings().transport === 'ble'}>
          <ctx.ui.SettingsSection title="Bridge UART (Bluetooth LE only)">
            <Row title="Baud rate" description="Applied to the bridge, not the target board.">
              <ctx.ui.Select
                label="Baud rate"
                value={String(settings().uart?.baud ?? 115200)}
                options={BAUD_RATES.map((rate) => ({ value: String(rate), label: String(rate) }))}
                onChange={(value: string) => setUart('baud', Number(value))}
              />
            </Row>
            <Row title="Data bits">
              <ctx.ui.Select
                label="Data bits"
                value={String(settings().uart?.dataBits ?? 8)}
                options={['5', '6', '7', '8'].map((bits) => ({ value: bits, label: bits }))}
                onChange={(value: string) => setUart('dataBits', Number(value))}
              />
            </Row>
            <Row title="Parity">
              <ctx.ui.Select
                label="Parity"
                value={String(settings().uart?.parity ?? 'n')}
                options={[
                  { value: 'n', label: 'None' },
                  { value: 'e', label: 'Even' },
                  { value: 'o', label: 'Odd' },
                ]}
                onChange={(value: string) => setUart('parity', value)}
              />
            </Row>
            <Row title="Stop bits">
              <ctx.ui.Select
                label="Stop bits"
                value={String(settings().uart?.stopBits ?? 1)}
                options={['1', '2'].map((bits) => ({ value: bits, label: bits }))}
                onChange={(value: string) => setUart('stopBits', Number(value))}
              />
            </Row>
            <Row title="Flow control">
              <ctx.ui.Select
                label="Flow control"
                value={String(settings().uart?.flow ?? 'none')}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'rtscts', label: 'RTS/CTS' },
                ]}
                onChange={(value: string) => setUart('flow', value)}
              />
            </Row>
            <Row title="Apply UART to the bridge" description="Writes the format over Bluetooth LE and reads it back.">
              <ctx.ui.Button size="small" busy={busy()} onClick={() => void applyUart()}>
                Apply
              </ctx.ui.Button>
            </Row>
          </ctx.ui.SettingsSection>
        </Show>

        {/* 4. The optional browser page. */}
        <ctx.ui.SettingsSection title="Browser console page">
          <Row
            title="Serve the local browser console page"
            description="Loopback-only page with a token in its URL; useful when OpenCode's browser web UI cannot host plugin panels."
          >
            <ctx.ui.Switch
              label="Serve the local browser console page"
              checked={settings().webConsole}
              onChange={(value: boolean) => {
                update('webConsole', value);
                void save().then(() => (value ? loadWebUrl() : setWebUrl('')));
              }}
            />
          </Row>
          <Show when={webUrl()}>
            <Row title="Page URL" description="Anyone on this machine who has the URL can open it; the token rotates when the page server restarts.">
              <span class="lb-settings__url" title={webUrl()}>
                {webUrl()}
              </span>
              <ctx.ui.Button size="small" variant="ghost" onClick={() => void copyUrl()}>
                Copy
              </ctx.ui.Button>
            </Row>
          </Show>
        </ctx.ui.SettingsSection>

        <Show when={notice()}>
          <ctx.ui.SettingsSection footer={<span class="lb-settings__notice">{notice()}</span>}>
            <Row title="Last action" description={notice()} />
          </ctx.ui.SettingsSection>
        </Show>
      </Show>
    </ctx.ui.SettingsLayout>
  );
}

/** Register the page in the window setup. */
export function registerSettings(ctx: any): void {
  ctx.add(SettingsPage, {
    id: SETTINGS_PAGE_ID,
    title: 'Linkr Bee',
    icon: 'console',
    entries: [
      { id: 'linkr-bee-connection', title: 'Linkr Bee board', description: 'Scan, pair and connect a board; link status', keywords: 'linkr bee scan pair connect board ble rssi' },
      { id: 'linkr-bee-transport', title: 'Linkr Bee connection', description: 'Transport, BLE name/address, LAN host/token, bee-cli path and timeouts', keywords: 'linkr bee transport ble lan loopback token timeout' },
      { id: 'linkr-bee-uart', title: 'Linkr Bee bridge UART', description: 'Baud rate, data bits, parity, stop bits, flow control', keywords: 'uart baud parity stop flow bridge' },
      { id: 'linkr-bee-browser', title: 'Linkr Bee browser console page', description: 'Serve and copy the local browser console URL', keywords: 'browser console page web url token' },
    ],
    render: () => <LinkrBeeSettings />,
  });
}
