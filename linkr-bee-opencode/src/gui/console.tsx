/**
 * The live Linkr Bee serial console panel for the OpenCode 2.x GUI.
 *
 * One xterm.js terminal per panel instance, fed by the plugin server's shared
 * console RPC (`linkr_bee.console`, defined in `src/rpc.js`):
 *
 * - on mount: `state({})` dials lazily, then `read({view})` draws the current
 *   ring and remembers that view's byte cursor; `output`/`state`/`request`
 *   events keep it live afterwards;
 * - typing goes through `write({data})` (raw keystrokes/escape sequences — the
 *   board's terminal is the thing interpreting them, so named-key mapping is
 *   not needed);
 * - FitAddon + ResizeObserver fit the terminal to the panel and forward the new
 *   size through `resize({cols,rows})`;
 * - Clear calls `clear({})`; Reconnect calls `reconnect({})` and re-syncs;
 * - a status bar shows transport/target/size and link state, and the whole
 *   component degrades to a visible error line when the RPC or the board is
 *   absent instead of crashing the window.
 *
 * Console bytes are untrusted device data and are only ever drawn, never
 * interpreted.
 */
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import { usePlugin } from '@opencode/plugin/gui';

import LinkrBeeConsole from '../rpc.js';
import { CONSOLE_TAB_ID, type definition } from './definition';
import { SETTINGS_PAGE_ID } from './settings';

/** The two read views the server exposes. Reading is the default. */
type View = 'reading' | 'raw';

interface LinkState {
  connected: boolean;
  transport: string;
  target: string;
  cols: number;
  rows: number;
  /** Bridge UART baud rate when the server knows it (0/undefined = unknown). */
  baud?: number;
}

interface LinkSnapshot extends LinkState {
  bytes?: number;
  readingBytes?: number;
  epoch?: string;
}

type Phase = 'starting' | 'ready' | 'error';

/** Panel view for a given xterm colours theme. */
const DARK_TERMINAL: ITheme = {
  background: '#14181f',
  foreground: '#d7dde5',
  cursor: '#7dd3fc',
  cursorAccent: '#14181f',
  selectionBackground: '#2b4c66',
  black: '#1b1f27',
  red: '#f07178',
  green: '#a5d6a7',
  yellow: '#e6c07b',
  blue: '#82aaff',
  magenta: '#c792ea',
  cyan: '#89ddff',
  white: '#cbd3df',
  brightBlack: '#5c6773',
  brightRed: '#ff8b92',
  brightGreen: '#b9f6ca',
  brightYellow: '#ffd580',
  brightBlue: '#9bb8ff',
  brightMagenta: '#d7a6f0',
  brightCyan: '#b3e5fc',
  brightWhite: '#eef3f9',
};

const LIGHT_TERMINAL: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: '#cfe3fb',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#7d4e00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#9a6700',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

/** Panel chrome for a given appearance mode. */
function chrome(mode: 'light' | 'dark') {
  return mode === 'dark'
    ? {
        bg: '#151a21',
        fg: '#d7dde5',
        muted: '#8b98a9',
        border: '#2a3341',
        button: '#1d2531',
        hover: '#26303e',
        selected: '#2a3546',
        hint: '#1a2029',
        terminal: DARK_TERMINAL.background,
      }
    : {
        bg: '#f6f8fa',
        fg: '#24292f',
        muted: '#6e7781',
        border: '#d0d7de',
        button: '#ffffff',
        hover: '#eaeef2',
        selected: '#e6ebf1',
        hint: '#f0f3f6',
        terminal: LIGHT_TERMINAL.background,
      };
}

/** A short description of a thrown RPC/transport error. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** The panel component. Uses the plugin context for theming, layout and copy. */
export function ConsolePanel() {
  const ctx = usePlugin<typeof definition>();

  const [state, setState] = createSignal<LinkSnapshot>({
    connected: false,
    transport: 'ble',
    target: '',
    cols: 80,
    rows: 24,
    baud: 0,
  });
  const [view, setView] = createSignal<View>('reading');
  const [phase, setPhase] = createSignal<Phase>('starting');
  const [error, setError] = createSignal('');

  const colors = () => chrome(ctx.appearance.mode());

  let host: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let observer: ResizeObserver | undefined;
  let rpc: any;
  let disposed = false;

  /** Byte cursor per view, from `read`'s `bytes` / `output`'s per-view counter. */
  const cursor: Record<View, number> = { reading: 0, raw: 0 };
  let epoch = '';
  let initializing = true;
  let pending: any[] = [];
  /** Off/cleanup callbacks from subscriptions and event registrations. */
  const teardown: Array<() => void> = [];
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeWarned = false;
  let inputWarned = false;

  /** Tracks a subscription cleanup, which may be sync or a promise. */
  function track(value: any) {
    if (typeof value === 'function') {
      teardown.push(value);
      return;
    }
    if (value && typeof value.then === 'function') {
      value
        .then((cleanup: unknown) => {
          if (typeof cleanup === 'function') {
            if (disposed) cleanup();
            else teardown.push(cleanup as () => void);
          }
        })
        .catch(() => {});
    }
  }

  /** Draws a synthetic notice, distinct from target output. */
  function say(text: string) {
    term?.write(`\r\n\x1b[90m[linkr-bee] ${text}\x1b[0m\r\n`);
  }

  /** Clears the xterm screen and scrollback without touching server state. */
  function clearTerminal() {
    term?.write('\x1b[2J\x1b[3J\x1b[H');
  }

  /** Pulls the panel's view tail from the ring and re-anchors the cursor. */
  async function resync(reset = true) {
    if (!rpc) return;
    const wanted = view();
    try {
      const result = await rpc.read({ view: wanted });
      if (disposed || !result) return;
      if (reset) clearTerminal();
      epoch = String(result.epoch ?? '');
      cursor[wanted] = Number(result.bytes ?? 0);
      if (result.text) term?.write(String(result.text));
      if (result.truncated) say(ctx.t('meta.truncated'));
    } catch (caught) {
      setPhase('error');
      setError(describe(caught));
      say(`${ctx.t('status.error')}: ${describe(caught)}`);
    }
  }

  /** Applies one `output` event to the terminal for the current view. */
  function applyOutput(event: any) {
    if (!event) return;
    if (initializing) {
      pending.push(event);
      return;
    }
    if (event.epoch !== undefined && epoch && event.epoch !== epoch) {
      void resync();
      return;
    }
    const wanted = view();
    // The raw event carries both views; draw the one this panel is showing.
    const text = wanted === 'reading' ? event.reading ?? event.text : event.text;
    const next = wanted === 'reading' ? event.readingBytes ?? event.bytes : event.bytes;
    const count = typeof next === 'number' ? next : undefined;
    // A data event whose counter was already covered by the read tail is a
    // duplicate; meta notices carry no ring bytes and are always shown.
    if (event.kind !== 'meta' && count !== undefined && count <= cursor[wanted]) return;
    if (typeof text === 'string' && text.length > 0) term?.write(text);
    if (count !== undefined && count > cursor[wanted]) cursor[wanted] = count;
  }

  /** Extracts the payload from an event listener argument. */
  function payload(event: any) {
    return event && typeof event === 'object' && 'data' in event && event.data ? event.data : event;
  }

  function onOutput(event: any) {
    applyOutput(payload(event));
  }

  function onStateEvent(event: any) {
    const next = payload(event);
    if (!next) return;
    setState((previous) => ({ ...previous, ...next }));
  }

  /** The agent's console tool asks panels to open/focus/clear themselves. */
  function onRequest(event: any) {
    const request = payload(event);
    const action = request?.action;
    if (action === 'clear') {
      void clearConsole();
      return;
    }
    if (action !== 'open' && action !== 'focus') return;
    try {
      const session = ctx.sessions.current();
      if (session) {
        const key = `${ctx.id}:${CONSOLE_TAB_ID}`;
        if (ctx.layout.state(key, session) !== 'visible') ctx.layout.open(key, session);
      }
    } catch {
      /* best effort: the panel is already mounted, only focus matters */
    }
    setTimeout(() => term?.focus(), 0);
  }

  async function start() {
    if (!ctx.client) {
      setPhase('error');
      setError(ctx.t('hint.rpc'));
      return;
    }
    try {
      rpc = ctx.client.rpc(LinkrBeeConsole);
    } catch (caught) {
      setPhase('error');
      setError(describe(caught));
      say(`${ctx.t('hint.noRpc')}: ${describe(caught)}`);
      return;
    }
    // Subscribe first so output produced while state() dials is not lost.
    try {
      track(rpc.events.on('output', onOutput));
      track(rpc.events.on('state', onStateEvent));
      track(rpc.events.on('request', onRequest));
    } catch (caught) {
      setPhase('error');
      setError(describe(caught));
      say(`${ctx.t('hint.noRpc')}: ${describe(caught)}`);
      return;
    }
    try {
      const snapshot = await rpc.state({});
      if (disposed) return;
      if (snapshot) setState((previous) => ({ ...previous, ...snapshot }));
      await resync(true);
      if (disposed) return;
      initializing = false;
      const buffered = pending;
      pending = [];
      for (const bufferedEvent of buffered) applyOutput(bufferedEvent);
      setPhase('ready');
    } catch (caught) {
      initializing = false;
      setPhase('error');
      setError(describe(caught));
      say(`${ctx.t('status.error')}: ${describe(caught)}`);
    }
  }

  /** Forwards a panel resize; debounced because fit() fires per frame. */
  function scheduleResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      void pushResize();
    }, 180);
  }

  async function pushResize() {
    if (!rpc || !term || disposed) return;
    const cols = Math.max(2, Math.min(500, term.cols));
    const rows = Math.max(1, Math.min(200, term.rows));
    setState((previous) => ({ ...previous, cols, rows }));
    try {
      const result = await rpc.resize({ cols, rows });
      if (result && result.applied === false && !resizeWarned) {
        resizeWarned = true;
        say(`resize not applied: ${result.reason ?? 'unknown reason'}`);
      }
    } catch (caught) {
      if (!resizeWarned) {
        resizeWarned = true;
        say(`resize not sent: ${describe(caught)}`);
      }
    }
  }

  async function sendInput(data: string) {
    if (!rpc) return;
    try {
      await rpc.write({ data });
    } catch (caught) {
      if (!inputWarned) {
        inputWarned = true;
        say(`input not sent: ${describe(caught)}`);
      }
    }
  }

  async function clearConsole() {
    clearTerminal();
    if (rpc) {
      try {
        await rpc.clear({});
      } catch (caught) {
        say(`clear failed: ${describe(caught)}`);
      }
    }
    say(ctx.t('meta.cleared'));
  }

  async function reconnect() {
    if (!rpc) {
      setPhase('error');
      setError(ctx.t('hint.rpc'));
      return;
    }
    setPhase('starting');
    setError('');
    say(ctx.t('meta.reconnected'));
    try {
      await rpc.reconnect({});
      const snapshot = await rpc.state({});
      if (disposed) return;
      if (snapshot) setState((previous) => ({ ...previous, ...snapshot }));
      await resync(true);
      if (!disposed) setPhase('ready');
    } catch (caught) {
      setPhase('error');
      setError(describe(caught));
      say(`${ctx.t('status.error')}: ${describe(caught)}`);
    }
  }

  function switchView(next: View) {
    if (view() === next) return;
    setView(next);
    void resync(true);
  }

  function fitNow() {
    try {
      fit?.fit();
    } catch {
      /* the panel may be laid out with zero size for one frame */
    }
  }

  onMount(() => {
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: ctx.appearance.font('mono'),
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: ctx.appearance.mode() === 'dark' ? DARK_TERMINAL : LIGHT_TERMINAL,
    });
    term = terminal;
    fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host!);
    terminal.onData((data) => {
      void sendInput(data);
    });
    terminal.onResize(() => scheduleResize());

    const focusTerminal = () => terminal.focus();
    host!.addEventListener('mousedown', focusTerminal);

    // The side panel may not have its final size on the first frame.
    requestAnimationFrame(() => {
      fitNow();
      scheduleResize();
      terminal.focus();
    });
    try {
      observer = new ResizeObserver(() => fitNow());
      observer.observe(host!);
    } catch {
      /* ResizeObserver is present in every Electron/Chromium window */
    }

    void start();

    onCleanup(() => {
      disposed = true;
      observer?.disconnect();
      observer = undefined;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = undefined;
      host?.removeEventListener('mousedown', focusTerminal);
      for (const off of teardown.splice(0)) {
        try {
          off();
        } catch {
          /* an already-withdrawn subscription is fine */
        }
      }
      terminal.dispose();
      term = undefined;
      fit = undefined;
    });
  });

  // Follow the app's appearance and terminal font without remounting xterm.
  createEffect(() => {
    const mode = ctx.appearance.mode();
    const font = ctx.appearance.font('mono');
    if (!term) return;
    term.options.theme = mode === 'dark' ? DARK_TERMINAL : LIGHT_TERMINAL;
    term.options.fontFamily = font;
    fitNow();
  });

  const style = () => {
    const palette = colors();
    return [
      `--lb-bg:${palette.bg}`,
      `--lb-fg:${palette.fg}`,
      `--lb-muted:${palette.muted}`,
      `--lb-border:${palette.border}`,
      `--lb-button:${palette.button}`,
      `--lb-button-hover:${palette.hover}`,
      `--lb-selected:${palette.selected}`,
      `--lb-hint:${palette.hint}`,
      `--lb-term-bg:${palette.terminal}`,
    ].join(';');
  };

  const connected = () => state().connected;
  const target = () => state().target || '—';

  return (
    <div class="lb-console" style={style()}>
      <div class="lb-console__bar">
        <span class="lb-console__dot" data-on={connected() ? 'true' : 'false'} aria-hidden="true" />
        <span class="lb-console__status" title={target()}>
          <strong>{connected() ? ctx.t('status.connected') : ctx.t('status.disconnected')}</strong>
          {' · '}
          {state().transport || '—'}
          {state().baud ? ` · ${state().baud}` : ''}
          {' · '}
          {state().cols}×{state().rows}
          <Show when={phase() === 'starting'}>
            {' · '}
            {ctx.t('status.connecting')}
          </Show>
        </span>
        <div class="lb-console__actions">
          <div class="lb-console__seg" role="group" aria-label={ctx.t('view.label')}>
            <button
              type="button"
              data-active={view() === 'reading' ? 'true' : 'false'}
              aria-pressed={view() === 'reading'}
              onClick={() => switchView('reading')}
            >
              {ctx.t('view.reading')}
            </button>
            <button
              type="button"
              data-active={view() === 'raw' ? 'true' : 'false'}
              aria-pressed={view() === 'raw'}
              onClick={() => switchView('raw')}
            >
              {ctx.t('view.raw')}
            </button>
          </div>
          <button type="button" onClick={() => void clearConsole()}>
            {ctx.t('clear')}
          </button>
          <button type="button" onClick={() => void reconnect()}>
            {ctx.t('reconnect')}
          </button>
          <button
            type="button"
            class="lb-console__settings"
            title={ctx.t('command.settings')}
            aria-label={ctx.t('command.settings')}
            onClick={() => ctx.layout.settings(SETTINGS_PAGE_ID)}
          >
            ⚙
          </button>
        </div>
      </div>
      <Show when={connected() && phase() !== 'error'}>
        <div class="lb-console__target" title={state().target}>
          {ctx.t('target')}: {target()}
        </div>
      </Show>
      <Show when={phase() === 'error' || !connected()}>
        <div class="lb-console__hint">
          <Show
            when={phase() === 'error'}
            fallback={
              <>
                <span class="lb-console__hint-copy">{ctx.t('hint.disconnected')}</span>
                <Show when={state().target}>
                  <span class="lb-console__hint-error" title={state().target}>
                    {ctx.t('hint.target')}: <strong>{state().target}</strong>
                  </span>
                </Show>
              </>
            }
          >
            <span>
              {ctx.t('hint.rpc')}
              <Show when={error()}>: {error()}</Show>
            </span>
          </Show>
        </div>
      </Show>
      <div class="lb-console__terminal" ref={host} />
    </div>
  );
}
