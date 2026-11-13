/**
 * The package's `./tui` part: a live Linkr Bee serial-console panel in
 * OpenCode's terminal UI.
 *
 * OpenCode 2.x loads this file when the server part loads (the TUI loads the
 * TUI parts of the plugins its server loads) and calls `setup(context)` once.
 * The setup contributes:
 *
 * - a `session.panel` slot that renders `ConsolePanel` when the selected panel
 *   name is `linkr-bee.console`;
 * - a palette command, `ctrl+shift+l` binding and `/linkr-bee` slash command
 *   that open that panel (`context.ui.panel.open`), plus palette commands for
 *   the panel actions (send line, send Ctrl-C, clear, toggle view, reconnect).
 *   These dispatch to the mounted panel, because the host owns panel focus and
 *   the component owns the RPC subscription;
 * - one `sidebar.content` line with the last known link state, only after the
 *   panel has reported state (so a project with no board shows nothing).
 *
 * The panel is fed by the plugin server's shared console RPC
 * (`linkr_bee.console`, defined in `src/rpc.js`): it calls `state({})` (which
 * dials lazily), backfills with `read({view})`, then subscribes to `output`,
 * `state` and `request` events. Typed input goes through `write({data})`, the
 * named Ctrl-C through `key({key:"ctrl-c"})`, Clear through `clear({})` and
 * Reconnect through `reconnect({})`.
 *
 * Two views, two renderers:
 *
 * - **raw** is a true VT100 terminal: OpenTUI's `EmbeddedTerminalRenderable`
 *   (registered with `extend`), fed the raw byte text, with every keystroke the
 *   user types going straight back to the board through `write`. Full-screen
 *   programs work here because the terminal emulator is the board's peer.
 * - **reading** (the default) is the filtered view from the server — agent
 *   probe echoes hidden, `LINKR_RC_*` markers collapsed — drawn by
 *   `./tui/render.js` as a plain-text log with a bounded scrollback, ANSI
 *   stripping, CR progress-overwrite and backspace handling, plus a one-line
 *   editor that sends a line plus `\r` on Enter.
 *
 * The reading log is also the fallback when the host's OpenTUI does not expose
 * the embedded terminal: raw then renders through the same text renderer, so
 * the panel still works, just without per-keystroke VT100 input.
 *
 * Console bytes are untrusted device data: they are only ever drawn, never
 * interpreted, and the plugin never reads them as instructions.
 *
 * Everything here is defensive: a missing RPC part, a disconnected server, no
 * board and no bee-cli all produce visible text in the panel (or a warning
 * toast), never an exception in the TUI process.
 */
import { appendFileSync } from 'node:fs';
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Plugin, usePlugin } from '@opencode/plugin/tui';
import { extend } from '@opentui/solid';
import { EmbeddedTerminalRenderable } from '@opentui/core';

import LinkrBeeConsole from './rpc.js';
import { boardMenu, scanAndConnect, settingsMenu, showStatus } from './tui/settings.js';
import {
  applyBytes,
  createState,
  normalizeView,
  pickCursor,
  pickOutput,
  renderText,
  resetState,
  singleLine,
} from './tui/render.js';

/** The selected panel name; the slash/palette commands open exactly this. */
export const CONSOLE_PANEL = 'linkr-bee.console';

/** Command ids (also the stable keybind identifiers users can configure). */
export const CONSOLE_COMMANDS = Object.freeze({
  open: 'linkr-bee.console',
  send: 'linkr-bee.console.send',
  ctrlC: 'linkr-bee.console.ctrl-c',
  clear: 'linkr-bee.console.clear',
  view: 'linkr-bee.console.view',
  reconnect: 'linkr-bee.console.reconnect',
});

/** Rows forwarded to the board from the reading log (a slot exposes width only). */
const RESIZE_ROWS = 24;

/** Palette group label. */
const GROUP = 'Linkr Bee';

/**
 * Whether this host's OpenTUI offers the embedded terminal renderable. The
 * class is registered as a JSX element at module scope, which is the only place
 * `extend` may run; when the host predates it, the panel renders raw output
 * through the text log instead.
 */
const HAS_TERMINAL = (() => {
  try {
    if (!EmbeddedTerminalRenderable) return false;
    extend({ embedded_terminal: EmbeddedTerminalRenderable });
    return true;
  } catch {
    return false;
  }
})();

/**
 * The `session.panel` slot input, mirrored locally so this file needs no
 * subpath type import. It is structurally the host's `PanelInput`
 * (`@opencode/plugin/tui/context`).
 */
interface PanelInput {
  readonly name: string;
  readonly sessionID: string;
  readonly width: number;
  readonly presentation: 'panel' | 'fullscreen';
  readonly focused: boolean;
  readonly focus: () => void;
  readonly close: () => void;
  readonly toggleFullscreen: () => void;
}

/** A header/status snapshot from `state({})` or a `state` event. */
interface LinkState {
  readonly connected: boolean;
  readonly transport: string;
  readonly target: string;
  readonly cols: number;
  readonly rows: number;
  /** Bridge UART baud rate when known (0 = unknown). */
  readonly baud?: number;
}

/** The slice of the console RPC this panel uses (see `src/rpc-schema.js`). */
interface OutputEvent {
  readonly seq?: number;
  readonly epoch?: string;
  readonly kind?: string;
  readonly text?: string;
  readonly bytes?: number;
  readonly reading?: string;
  readonly readingBytes?: number;
}
interface ConsoleRpc {
  state(input: Record<string, never>): Promise<LinkState & { bytes?: number; epoch?: string; readingBytes?: number }>;
  read(input: { view?: 'reading' | 'raw'; since?: number }): Promise<{
    view?: string;
    text?: string;
    bytes?: number;
    epoch?: string;
    truncated?: boolean;
  }>;
  write(input: { data: string }): Promise<{ ok?: boolean }>;
  key(input: { key: string }): Promise<{ ok?: boolean }>;
  resize(input: { cols: number; rows: number }): Promise<{ applied?: boolean; cols?: number; rows?: number; reason?: string }>;
  clear(input: Record<string, never>): Promise<{ ok?: boolean }>;
  reconnect(input: Record<string, never>): Promise<{ ok?: boolean }>;
  events: {
    on(name: string, handler: (event: unknown) => void): () => void;
  };
}

/** Actions the global commands dispatch into the mounted panel. */
type PanelAction = 'send' | 'ctrl-c' | 'clear' | 'view' | 'reconnect';
interface PanelControl {
  sendLine(prefill?: string): void;
  ctrlC(): void;
  clear(): void;
  toggleView(): void;
  reconnect(): void;
}

/** Diagnostics hook, same pattern as the server part's marker: opt-in only. */
function mark(stage: string, extra?: Record<string, unknown>): void {
  const file = typeof process !== 'undefined' ? process.env?.LINKR_BEE_TUI_MARKER : undefined;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ stage, at: Date.now(), ...(extra ?? {}) })}\n`);
  } catch {
    /* diagnostics are best effort and never break the panel */
  }
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string' && cause !== '') return cause;
  return 'unexpected error';
}

/** One-line sidebar summary for the last known link state. */
function sidebarLine(state: LinkState): string {
  const link = state.connected ? 'connected' : 'offline';
  const where = singleLine(state.target, 32) || state.transport;
  const baud = state.baud ? ` · ${state.baud}` : '';
  return `Linkr Bee · ${state.transport}${baud} · ${where} · ${link}`;
}

/** Decode the bytes an OpenTUI terminal hands us for one key chord. */
function decodeBytes(data: unknown): string {
  try {
    if (typeof data === 'string') return data;
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    if (Array.isArray(data)) return new TextDecoder().decode(Uint8Array.from(data as number[]));
    if (data && typeof data === 'object' && 'length' in (data as any)) {
      return new TextDecoder().decode(Uint8Array.from(data as ArrayLike<number>));
    }
  } catch {
    /* fall through: an unknown byte payload is simply dropped */
  }
  return '';
}

/** Sidebar status, shared by the panel (writer) and the slot (reader). */
const [lastLink, setLastLink] = createSignal<LinkState | null>(null);

/** The actions of the currently mounted panel, if any. */
let panelControl: PanelControl | null = null;

/**
 * The live console panel body. It is a session.panel contribution: the host
 * sizes and focuses it, and the component owns the RPC subscription.
 */
function ConsolePanel(props: { panel: PanelInput }) {
  const context = usePlugin();
  const theme = context.theme;

  // Reading log first (filtered, bounded), raw VT100 terminal one key away.
  // The chosen view is remembered with the host's durable storage (synced across
  // TUI instances); storage is optional, so a host that refuses it falls back to
  // the reading log.
  let viewStore: { readonly view?: unknown } | undefined;
  let persistView: ((mutation: (draft: { view: string }) => void) => Promise<void>) | undefined;
  const storedView = (() => {
    try {
      const [store, update] = context.storage.store('linkr-bee.view', { initial: { view: 'reading' } });
      viewStore = store as unknown as { readonly view?: unknown };
      persistView = update as unknown as (mutation: (draft: { view: string }) => void) => Promise<void>;
      return normalizeView(viewStore?.view);
    } catch {
      return 'reading';
    }
  })();
  const [view, setView] = createSignal<'reading' | 'raw'>(storedView);
  // The last value this panel wrote/read from storage; only a *different* stored
  // value (another TUI instance) should move the view out from under the user.
  let lastStoredView: 'reading' | 'raw' = storedView;
  const [link, setLink] = createSignal<LinkState | null>(null);
  const [cursorBytes, setCursorBytes] = createSignal(0);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  // The text renderer state is mutable (by design, to keep chunks
  // allocation-free); this signal is the reactive pulse that redraws after each
  // applied chunk.
  const [revision, setRevision] = createSignal(0);
  const consoleState = createState();

  const cursors = { reading: 0, raw: 0 };
  let epoch = '';
  let disposed = false;
  let reloadToken = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let firstViewRun = true;
  let inputRef: { value: string } | undefined;
  let term: any = null;
  let outputMarked = false;

  const bump = () => setRevision((n) => n + 1);
  const showTerminal = () => HAS_TERMINAL && view() === 'raw';
  const setCursor = (value: number, wanted = view()) => {
    cursors[wanted] = value;
    setCursorBytes(value);
  };

  const rpc = (): ConsoleRpc | undefined => {
    try {
      const client = context.client as unknown as { rpc(definition: unknown): ConsoleRpc };
      return client.rpc(LinkrBeeConsole);
    } catch (cause) {
      if (!disposed) setError(`console RPC unavailable: ${messageOf(cause)}`);
      return undefined;
    }
  };

  async function call<T>(label: string, work: (api: ConsoleRpc) => Promise<T>): Promise<T | undefined> {
    const api = rpc();
    if (!api) return undefined;
    try {
      const result = await work(api);
      if (!disposed) setError('');
      return result;
    } catch (cause) {
      if (!disposed) setError(`${label}: ${messageOf(cause)}`);
      return undefined;
    }
  }

  function applyLink(next: LinkState): void {
    if (disposed) return;
    setLink(next);
    setLastLink(next);
    mark('link', { connected: next.connected, transport: next.transport, target: next.target });
  }

  async function refreshState(): Promise<void> {
    const snapshot = await call('state', (api) => api.state({}));
    if (!snapshot || disposed) return;
    applyLink({
      connected: snapshot.connected === true,
      transport: typeof snapshot.transport === 'string' ? snapshot.transport : '-',
      target: typeof snapshot.target === 'string' ? snapshot.target : '',
      cols: typeof snapshot.cols === 'number' ? snapshot.cols : 0,
      rows: typeof snapshot.rows === 'number' ? snapshot.rows : 0,
      baud: typeof snapshot.baud === 'number' ? snapshot.baud : 0,
    });
  }

  /** Feed the embedded terminal, if it is mounted. */
  function writeTerminal(text: string): void {
    if (!term || typeof term.write !== 'function' || text === '') return;
    try {
      term.write(text);
    } catch {
      /* a torn-down terminal must not take the TUI down */
    }
  }

  function focusTerminal(): void {
    if (!term || typeof term.focus !== 'function') return;
    try {
      term.focus();
      mark('term-focus');
    } catch (cause) {
      mark('term-focus-error', { error: messageOf(cause) });
    }
  }

  /** Re-read the whole current view into a fresh screen/log state. */
  async function backfill(reason = 'reload'): Promise<void> {
    const token = ++reloadToken;
    const wanted = view();
    const result = await call('read', (api) => api.read({ view: wanted }));
    if (!result || disposed || token !== reloadToken) return;
    epoch = typeof result.epoch === 'string' ? result.epoch : epoch;
    const text = typeof result.text === 'string' ? result.text : '';
    const bytes = typeof result.bytes === 'number' ? result.bytes : cursors[wanted];
    if (wanted === 'raw' && term) {
      writeTerminal('\x1b[2J\x1b[H');
      writeTerminal(text);
      cursors.raw = bytes;
      setCursorBytes(bytes);
      const terminal = term;
      setTimeout(() => {
        try {
          const screen = terminal?.screen?.();
          if (!screen) return;
          mark('term-screen', { text: screen.text ?? null, columns: screen.columns, rows: screen.rows });
          // The embedded terminal fits itself to the panel; give the board the
          // same geometry instead of the reading log's width estimate.
          if (Number.isInteger(screen.columns) && Number.isInteger(screen.rows)) {
            const current = link();
            if (current) applyLink({ ...current, cols: screen.columns, rows: screen.rows });
            void call('resize', (api) => api.resize({ cols: screen.columns, rows: screen.rows }));
          }
        } catch {
          /* geometry reporting is best effort */
        }
      }, 400);
    } else {
      resetState(consoleState);
      cursors[wanted] = bytes;
      setCursorBytes(bytes);
      if (text !== '') applyBytes(consoleState, text);
      bump();
    }
    mark('reload', { view: wanted, bytes, epoch, reason, drawn: text !== '' });
  }

  function onOutput(event: OutputEvent): void {
    if (disposed || !event || typeof event !== 'object') return;
    if (typeof event.epoch === 'string' && event.epoch !== '' && epoch !== '' && event.epoch !== epoch) {
      // Clear or reconnect changed the ring generation: cursors are stale.
      epoch = event.epoch;
      void backfill('epoch');
      return;
    }
    const wanted = view();
    const text = pickOutput(event as Record<string, unknown>, wanted);
    const next = pickCursor(event as Record<string, unknown>, wanted);
    // A ring event that ends at or before our cursor was already drawn by the
    // backfill (or a previous event): do not draw it twice.
    if (typeof next === 'number' && next <= cursors[wanted]) return;
    if (typeof next === 'number') setCursor(next, wanted);
    if (typeof text !== 'string' || text === '') return;
    if (wanted === 'raw' && term) {
      writeTerminal(text);
    } else {
      applyBytes(consoleState, text);
      bump();
    }
    if (!outputMarked) {
      outputMarked = true;
      mark('output', { kind: event.kind ?? 'data', view: wanted });
    }
  }

  function onRequest(action: unknown): void {
    if (disposed) return;
    if (action === 'open') {
      context.ui.panel.open(CONSOLE_PANEL);
    } else if (action === 'focus') {
      props.panel.focus();
    } else if (action === 'clear') {
      void clearConsole();
    }
  }

  /* --------------------------------------------------------------- actions */

  function flash(text: string): void {
    setNotice(text);
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      if (!disposed) setNotice('');
    }, 2500);
  }

  async function sendLine(prefill?: string): Promise<void> {
    const line =
      prefill !== undefined
        ? prefill
        : await context.ui.dialog
            .prompt({
              title: 'Send to Linkr Bee console',
              description: 'The text is written to the board UART console followed by Enter (\\r).',
              placeholder: 'e.g. help',
            })
            .catch(() => undefined);
    if (line === undefined) return;
    const ok = await call('write', (api) => api.write({ data: `${line}\r` }));
    if (ok) flash(`sent: ${singleLine(line, 60) || '(enter)'}`);
  }

  async function sendCtrlC(): Promise<void> {
    const ok = await call('key', (api) => api.key({ key: 'ctrl-c' }));
    if (ok) flash('sent Ctrl-C');
  }

  async function clearConsole(): Promise<void> {
    const ok = await call('clear', (api) => api.clear({}));
    if (!ok) return;
    resetState(consoleState);
    cursors.reading = 0;
    cursors.raw = 0;
    setCursorBytes(0);
    bump();
    writeTerminal('\x1b[2J\x1b[H');
    await backfill('clear');
    flash('console cleared');
  }

  async function rememberView(next: 'reading' | 'raw'): Promise<void> {
    if (!persistView) return;
    lastStoredView = next;
    try {
      await persistView((draft) => {
        draft.view = next;
      });
      mark('view-persist', { view: next });
    } catch {
      /* a host that cannot persist preferences must not break the panel */
    }
  }

  async function toggleView(): Promise<void> {
    const next = normalizeView(view()) === 'raw' ? 'reading' : 'raw';
    setView(next);
    flash(next === 'raw' ? 'raw terminal' : 'reading log');
    await rememberView(next);
    // The effect below focuses the new body and backfills it.
  }

  async function reconnect(): Promise<void> {
    const ok = await call('reconnect', (api) => api.reconnect({}));
    if (!ok) return;
    await refreshState();
    await backfill('reconnect');
    flash('reconnecting');
  }

  const control: PanelControl = {
    sendLine: (prefill) => void sendLine(prefill),
    ctrlC: () => void sendCtrlC(),
    clear: () => void clearConsole(),
    toggleView: () => void toggleView(),
    reconnect: () => void reconnect(),
  };

  /** A key chord typed into the embedded terminal goes to the board verbatim. */
  function onTerminalData(data: unknown, source: string): void {
    const text = decodeBytes(data);
    mark('term-data', { source, text: singleLine(text, 40) });
    if (text === '') return;
    void call('write', (api) => api.write({ data: text }));
  }

  function onTerminalResize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    const current = link();
    if (current) {
      applyLink({ ...current, cols, rows });
    }
    mark('term-resize', { cols, rows });
    void call('resize', (api) => api.resize({ cols, rows }));
  }

  /* -------------------------------------------------------------- lifecycle */

  const offs: Array<() => void> = [];

  onMount(() => {
    mark('panel-mount', {
      sessionID: props.panel.sessionID,
      width: props.panel.width,
      terminal: HAS_TERMINAL,
      view: view(),
    });
    panelControl = control;
    let cancelled = false;
    const subscribe = async () => {
      const api = rpc();
      if (!api || cancelled) return;
      try {
        offs.push(api.events.on('output', (event) => onOutput((event as { data?: OutputEvent })?.data ?? (event as OutputEvent))));
        offs.push(
          api.events.on('state', (event) => {
            const data = ((event as { data?: Partial<LinkState> })?.data ?? event) as Partial<LinkState>;
            if (!data || disposed) return;
            applyLink({
              connected: data.connected === true,
              transport: typeof data.transport === 'string' ? data.transport : '-',
              target: typeof data.target === 'string' ? data.target : '',
              cols: typeof data.cols === 'number' ? data.cols : 0,
              rows: typeof data.rows === 'number' ? data.rows : 0,
              baud: typeof data.baud === 'number' ? data.baud : 0,
            });
          }),
        );
        offs.push(
          api.events.on('request', (event) => {
            const data = ((event as { data?: { action?: unknown } })?.data ?? event) as { action?: unknown };
            onRequest(data?.action);
          }),
        );
      } catch (cause) {
        if (!disposed) setError(`console events unavailable: ${messageOf(cause)}`);
        return;
      }
      await refreshState();
      await backfill('mount');
    };
    void subscribe();
  });

  // Another TUI instance may change the remembered view: follow the store, but
  // ignore echoes of this panel's own write (it is already showing that view).
  createEffect(() => {
    if (disposed || !viewStore) return;
    const stored = normalizeView(viewStore.view);
    if (stored === lastStoredView) return;
    lastStoredView = stored;
    if (stored !== view()) setView(stored);
  });

  // View switches re-read from the ring and move focus to the active body.
  createEffect(() => {
    const wanted = view();
    if (firstViewRun) {
      firstViewRun = false;
      return;
    }
    if (disposed) return;
    mark('view', { view: wanted });
    // The terminal element mounts during this render; focus it on the next tick.
    setTimeout(() => {
      if (disposed) return;
      if (wanted === 'raw' && HAS_TERMINAL) focusTerminal();
      void backfill('view');
    }, 0);
  });

  // The host owns panel focus: keep the embedded terminal focused with it.
  createEffect(() => {
    const focused = props.panel.focused;
    const wanted = view();
    if (!focused || wanted !== 'raw' || !HAS_TERMINAL) return;
    setTimeout(() => {
      if (!disposed && props.panel.focused) focusTerminal();
    }, 0);
  });

  // In the reading log (and the no-terminal fallback) forward an approximate
  // size: the slot API exposes width, not height. The raw terminal reports its
  // own fitted size through onTerminalResize instead.
  createEffect(() => {
    const width = props.panel.width;
    if (view() !== 'reading' || !Number.isInteger(width) || width < 2) return;
    const cols = Math.max(2, Math.min(500, width - 2));
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (disposed) return;
      void call('resize', (api) => api.resize({ cols, rows: RESIZE_ROWS }));
    }, 250);
  });

  onCleanup(() => {
    disposed = true;
    mark('panel-unmount', { sessionID: props.panel.sessionID });
    for (const off of offs) {
      try {
        off();
      } catch {
        /* the host may already have closed the subscription */
      }
    }
    offs.length = 0;
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    if (panelControl === control) {
      panelControl = null;
      setLastLink(null);
    }
  });

  /* ---------------------------------------------------------------- render */

  const bodyText = createMemo(() => {
    revision();
    const width = Math.max(20, (Number.isInteger(props.panel.width) ? props.panel.width : 80) - 2);
    return renderText(consoleState, { width, maxLines: consoleState.maxLines });
  });

  const hint = createMemo(() => {
    const current = link();
    if (error()) return '';
    if (!current) return 'Connecting to the Linkr Bee console…';
    if (!current.connected) {
      const detail = singleLine(current.target, 120);
      return [
        'No board — the console is offline.',
        detail ? `Last link error: ${detail}` : '',
        'Check the board is powered and reachable, then run Reconnect (palette: Linkr Bee: reconnect), or `/linkr-bee reconnect`.',
        'Tip: `linkr_bee_query` with action "info" in the agent reports the same link state.',
      ]
        .filter(Boolean)
        .join('\n');
    }
    return 'Connected — waiting for console output…';
  });

  const headerText = createMemo(() => {
    const current = link();
    const size = current ? `${current.cols || '?'}×${current.rows || '?'}` : '?×?';
    const target = current ? singleLine(current.target, 48) : '';
    const mode = view() === 'raw' ? (HAS_TERMINAL ? 'raw terminal' : 'raw log') : 'reading log';
    const baud = current?.baud ? ` · ${current.baud} baud` : '';
    return `${mode}${baud} · ${size} · ${cursorBytes()} B${target ? ` · ${target}` : ''}`;
  });

  const footer = createMemo(() => {
    if (view() === 'raw' && HAS_TERMINAL) {
      return 'terminal: every key goes to the board · palette: Linkr Bee (send line / Ctrl-C / clear / reading log / reconnect) · Ctrl+Shift+L reopens';
    }
    return 'Enter sends a line · palette: Linkr Bee (send line / Ctrl-C / clear / raw terminal / reconnect) · /linkr-bee send <text>';
  });

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.background.base}>
      <box
        flexDirection="row"
        height={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.background.raised.base}
      >
        <text fg={theme.text.base}>Linkr Bee console</text>
        <text fg={theme.text.faint}>{'  '}</text>
        <text fg={link()?.connected ? theme.text.feedback.success.base : theme.text.feedback.warning.base}>
          {link() ? (link()!.connected ? '● connected' : '○ offline') : '◌ connecting'}
        </text>
        <text fg={theme.text.muted}>{`  ${headerText()}`}</text>
      </box>
      <Show when={error()}>
        <text fg={theme.text.feedback.error.base}>{` ! ${error()}`}</text>
      </Show>
      <Show when={notice()}>
        <text fg={theme.text.muted}>{` · ${notice()}`}</text>
      </Show>
      <Show when={showTerminal()}>
        <Show when={link() && !link()!.connected}>
          <text fg={theme.text.feedback.warning.base}>
            {` offline — ${singleLine(link()!.target, 100) || 'no board or no bee-cli'}; run Reconnect from the palette`}
          </text>
        </Show>
        <embedded_terminal
          ref={(r: any) => {
            term = r;
            mark('term-mounted', { hasTerm: Boolean(r) });
            if (r && props.panel.focused) setTimeout(() => focusTerminal(), 0);
          }}
          flexGrow={1}
          cols={80}
          rows={24}
          onData={(data: unknown, source: string) => onTerminalData(data, source)}
          onTerminalResize={(cols: number, rows: number) => onTerminalResize(cols, rows)}
        />
      </Show>
      <Show when={!showTerminal()}>
        <scrollbox flexGrow={1} stickyScroll={true} stickyStart="bottom">
          <text fg={theme.text.base}>{bodyText() || hint()}</text>
        </scrollbox>
        <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
          <text fg={theme.text.faint}>{'send ▸ '}</text>
          <input
            flexGrow={1}
            focused={props.panel.focused}
            placeholder="type a line and press Enter (empty line sends Enter)"
            onSubmit={(value?: string) => {
              void sendLine(typeof value === 'string' ? value : '');
              if (inputRef) inputRef.value = '';
            }}
          />
        </box>
      </Show>
      <text fg={theme.text.faint}>{` ${footer()}`}</text>
    </box>
  );
}

/**
 * Open the console panel, with a toast when there is no session to open it in
 * (the host's `ui.panel.open` returns false on home/plugin routes).
 */
function openConsole(context: ReturnType<typeof usePlugin>): boolean {
  try {
    const opened = context.ui.panel.open(CONSOLE_PANEL);
    if (!opened) {
      context.ui.toast.show({
        title: 'Linkr Bee',
        message: 'Open a session first — the Linkr Bee console lives in the session panel.',
        variant: 'warning',
      });
    }
    return opened;
  } catch (cause) {
    context.ui.toast.show({ title: 'Linkr Bee', message: `Cannot open console: ${messageOf(cause)}`, variant: 'error' });
    return false;
  }
}

/** Dispatch a panel action from a global command. */
function dispatch(context: ReturnType<typeof usePlugin>, action: PanelAction, argument?: string): void {
  const control = panelControl;
  if (!control) {
    // No panel mounted: opening it is the useful first step. The action is not
    // replayed silently; the user sees the panel and can repeat it there.
    openConsole(context);
    context.ui.toast.show({
      title: 'Linkr Bee',
      message: 'Console panel opened; run the command again to act on it.',
      variant: 'info',
    });
    return;
  }
  switch (action) {
    case 'send':
      control.sendLine(argument);
      break;
    case 'ctrl-c':
      control.ctrlC();
      break;
    case 'clear':
      control.clear();
      break;
    case 'view':
      control.toggleView();
      break;
    case 'reconnect':
      control.reconnect();
      break;
  }
}

/** The console RPC, or undefined when the server half is unavailable. */
function consoleRpc(context: ReturnType<typeof usePlugin>): any {
  try {
    const client = context.client as unknown as { rpc(definition: unknown): unknown };
    return client.rpc(LinkrBeeConsole);
  } catch {
    return undefined;
  }
}

/** Run a dialog flow with a toast instead of an exception on an old server. */
function runFlow(context: ReturnType<typeof usePlugin>, flow: (deps: { dialog: any; rpc: any }) => Promise<unknown>): void {
  const rpc = consoleRpc(context);
  if (!rpc) {
    context.ui.toast.show({ title: 'Linkr Bee', message: 'The console RPC is not available on this server.', variant: 'error' });
    return;
  }
  void flow({ dialog: context.ui.dialog, rpc }).catch((cause) => {
    context.ui.toast.show({ title: 'Linkr Bee', message: `Failed: ${messageOf(cause)}`, variant: 'error' });
  });
}

/** Parse the text after `/linkr-bee`: `send <text>`, `raw`, `clear`, … */
function runSlash(context: ReturnType<typeof usePlugin>, input?: string): void {
  let text = typeof input === 'string' ? input.trim() : '';
  // The host may pass the raw line including the command name.
  text = text.replace(/^\/(?:linkr-bee|bee)\b/i, '').trim();
  if (text === '') {
    openConsole(context);
    return;
  }
  const [sub, ...rest] = text.split(/\s+/);
  const argument = rest.join(' ');
  switch (sub.toLowerCase()) {
    case 'send':
      dispatch(context, 'send', argument === '' ? undefined : argument);
      break;
    case 'ctrl-c':
    case 'ctrlc':
      dispatch(context, 'ctrl-c');
      break;
    case 'clear':
      dispatch(context, 'clear');
      break;
    case 'raw':
    case 'reading':
    case 'view':
      dispatch(context, 'view');
      break;
    case 'reconnect':
      dispatch(context, 'reconnect');
      break;
    case 'open':
      openConsole(context);
      break;
    case 'scan':
    case 'pair':
    case 'connect':
      runFlow(context, (deps) => scanAndConnect({ ...deps, toast: context.ui.toast }));
      break;
    case 'settings':
    case 'config':
      runFlow(context, (deps) => settingsMenu({ ...deps, toast: context.ui.toast }));
      break;
    case 'status':
      runFlow(context, (deps) => showStatus({ ...deps }));
      break;
    case 'board':
      runFlow(context, (deps) => boardMenu({ ...deps, toast: context.ui.toast }));
      break;
    default:
      // Any other text is treated as a line for the board.
      dispatch(context, 'send', text);
      break;
  }
}

export default Plugin.define({
  id: 'opencode-linkr-bee.tui',
  setup(context) {
    mark('setup', { version: context.app?.version ?? '', channel: context.app?.channel ?? '', terminal: HAS_TERMINAL, options: context.options ?? null });

    // The console panel itself. Whether it draws is decided by the selected
    // panel name, so several plugins can append to session.panel and coexist.
    const stopPanel = context.ui.slot({
      append: 'session.panel',
      render: (panel) => (
        <Show when={panel.name === CONSOLE_PANEL}>
          <ConsolePanel panel={panel} />
        </Show>
      ),
    });

    // One line of link state in the session sidebar, but only after the panel
    // has actually talked to the server (no board = no noise).
    const stopSidebar = context.ui.slot({
      append: 'sidebar.content',
      render: () => (
        <Show when={lastLink()}>
          {(state) => <text fg={context.theme.text.muted}>{sidebarLine(state())}</text>}
        </Show>
      ),
    });

    // Commands live in a reactive global layer. The panel and its input own
    // the keys while it is focused, so these are palette/slash commands plus
    // one easy-to-remember open binding rather than single-letter bindings.
    context.keymap.layer(() => ({
      mode: 'global',
      priority: 10,
      commands: [
        {
          id: CONSOLE_COMMANDS.open,
          title: 'Linkr Bee: open console',
          description: 'Open the live serial console for the Linkr Bee board',
          group: GROUP,
          bind: 'ctrl+shift+l',
          palette: true,
          suggested: true,
          slash: { name: 'linkr-bee', aliases: ['bee'], arguments: true },
          run: (input) => runSlash(context, input),
        },
        {
          id: 'linkr-bee.console.open',
          title: 'Linkr Bee: open console (Ctrl+L)',
          description: 'Open the live serial console (simple-key alias for Ctrl+Shift+L)',
          group: GROUP,
          bind: 'ctrl+l',
          run: () => openConsole(context),
        },
        {
          id: CONSOLE_COMMANDS.send,
          title: 'Linkr Bee: send line to console…',
          description: 'Prompt for a line and write it to the board UART console',
          group: GROUP,
          palette: true,
          run: () => dispatch(context, 'send'),
        },
        {
          id: CONSOLE_COMMANDS.ctrlC,
          title: 'Linkr Bee: send Ctrl-C',
          description: 'Press Ctrl-C on the board console',
          group: GROUP,
          palette: true,
          run: () => dispatch(context, 'ctrl-c'),
        },
        {
          id: CONSOLE_COMMANDS.clear,
          title: 'Linkr Bee: clear console',
          description: 'Clear the shared console scrollback',
          group: GROUP,
          palette: true,
          run: () => dispatch(context, 'clear'),
        },
        {
          id: CONSOLE_COMMANDS.view,
          title: 'Linkr Bee: toggle raw terminal / reading log',
          description: 'Raw is a true VT100 terminal; reading is the filtered text log',
          group: GROUP,
          bind: 'ctrl+y',
          palette: true,
          run: () => dispatch(context, 'view'),
        },
        {
          id: 'linkr-bee.board',
          title: 'Linkr Bee: board / pair…',
          description: 'Scan for nearby boards and connect, or dial the saved board',
          group: GROUP,
          palette: true,
          suggested: true,
          run: () => runFlow(context, (deps) => boardMenu({ ...deps, toast: context.ui.toast })),
        },
        {
          id: 'linkr-bee.settings',
          title: 'Linkr Bee: settings…',
          description: 'Transport, LAN token, bee-cli path, timeouts, bridge UART and the browser page',
          group: GROUP,
          palette: true,
          run: () => runFlow(context, (deps) => settingsMenu({ ...deps, toast: context.ui.toast })),
        },
        {
          id: CONSOLE_COMMANDS.reconnect,
          title: 'Linkr Bee: reconnect console',
          description: 'Redial the board and resync the console',
          group: GROUP,
          palette: true,
          run: () => dispatch(context, 'reconnect'),
        },
      ],
      bindings: [CONSOLE_COMMANDS.open, 'linkr-bee.console.open', CONSOLE_COMMANDS.view],
    }));

    return () => {
      mark('cleanup');
      stopPanel();
      stopSidebar();
    };
  },
});
