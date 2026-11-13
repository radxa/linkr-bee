/**
 * Entry point for the plugin-served standalone browser console page.
 *
 * This is a plain browser asset (built as one IIFE with xterm inlined): the
 * plugin's local HTTP server serves it, and it talks to that same server over
 * JSON + Server-Sent Events. There is no OpenCode/Solid runtime here, so the
 * page keeps all of its own state like the Desktop panel does:
 *
 * - one xterm terminal, fitted to the viewport, typing forwarded as raw input;
 * - an initial `state` + `read` backfill from one view, then `output` events
 *   streamed with per-view byte cursors (and an epoch-change resync);
 * - Reading/Raw, Clear, Reconnect, and a copy-URL button;
 * - visible disconnected / unauthorized / stream-lost states instead of a
 *   blank page, and automatic reconnect when the SSE stream drops.
 */
import xtermCss from '@xterm/xterm/css/xterm.css?inline';

import {
  ConsoleClient,
  HttpError,
  openEvents,
  readToken,
  type EventSubscription,
  type LinkState,
  type OutputEvent,
  type RequestEvent,
  type View,
} from './client';
import { createTerminal, applyTheme, resolveTheme, watchSystemTheme, type TerminalHandle } from './terminal';
import { createUi, type Phase } from './ui';
import pageCss from './web.css?inline';

const MISSING_TOKEN =
  'Invalid or missing token. Open the URL printed by the Linkr Bee Desktop panel (Copy URL) or ask the agent for linkr_bee_console "webUrl".';

function injectStyles() {
  const style = document.createElement('style');
  style.dataset.linkrBee = 'web-console';
  style.textContent = `${xtermCss}\n${pageCss}`;
  document.head.append(style);
}

function boot() {
  injectStyles();
  document.title = 'Linkr Bee console';

  let phase: Phase = 'connecting';
  let error: string | null = null;
  let state: LinkState | null = null;
  let streamOpen = false;
  let view: View = 'reading';
  let disposed = false;

  const cursor: Record<View, number> = { reading: 0, raw: 0 };
  let epoch = '';
  let initializing = true;
  let pending: OutputEvent[] = [];

  const ui = createUi({
    onView: (next) => switchView(next),
    onClear: () => void clearConsole(),
    onReconnect: () => void reconnect(),
    onCopy: () => void copyUrl(),
  });
  ui.mount(document.getElementById('linkr-console') ?? document.body);

  const theme = resolveTheme();
  ui.setTheme(theme);
  render();

  const token = readToken();
  if (!token) {
    phase = 'unauthorized';
    error = MISSING_TOKEN;
    render();
    return;
  }

  const client = new ConsoleClient(token);
  const terminal: TerminalHandle = createTerminal({
    theme,
    onData: (data) => void sendInput(data),
    onResize: (cols, rows) => scheduleResize(cols, rows),
  });
  ui.attachTerminal(terminal.element);

  let sse: EventSubscription | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeWarned = false;
  let inputWarned = false;

  const stopTheme = watchSystemTheme((mode) => {
    applyTheme(terminal, mode);
    ui.setTheme(mode);
  });

  function render() {
    ui.update({ phase, state, view, stream: streamOpen, error });
  }

  function describe(caught: unknown): string {
    if (caught instanceof HttpError) return caught.message || `HTTP ${caught.status}`;
    if (caught instanceof Error) return caught.message;
    return String(caught);
  }

  /** Applies one streamed output event to the terminal for the current view. */
  function applyOutput(event: OutputEvent | undefined) {
    if (!event) return;
    if (initializing) {
      pending.push(event);
      return;
    }
    if (event.epoch && epoch && event.epoch !== epoch) {
      void reloadView(false);
      return;
    }
    // Notices are chrome, not target bytes: print them as dim prefixed lines.
    if (event.kind === 'meta') {
      if (event.text) terminal.notice(event.text);
      return;
    }
    const wanted = view;
    const text = wanted === 'reading' ? event.reading ?? event.text : event.text;
    const next = wanted === 'reading' ? event.readingBytes ?? event.bytes : event.bytes;
    if (typeof next === 'number' && next <= cursor[wanted]) return;
    if (typeof text === 'string' && text.length > 0) terminal.terminal.write(text);
    if (typeof next === 'number' && next > cursor[wanted]) cursor[wanted] = next;
  }

  /** Reads one view's tail from the server and re-anchors its cursor. */
  async function reloadView(clear: boolean) {
    try {
      const result = await client.read(view);
      if (disposed) return;
      clearTransientError();
      if (clear) terminal.clear();
      epoch = result.epoch;
      cursor[view] = result.bytes;
      if (result.text) terminal.terminal.write(result.text);
      if (result.truncated) terminal.notice('older console bytes were already dropped (ring truncated)');
    } catch (caught) {
      handleError(caught);
    }
  }

  /** Fills the gap after a (re)connected stream without clearing scrollback. */
  async function catchUp() {
    try {
      const snapshot = await client.state();
      if (disposed) return;
      state = snapshot;
      clearTransientError();
      render();
      const result = await client.read(view, cursor[view]);
      if (disposed) return;
      if (result.epoch !== epoch || result.bytes < cursor[view]) {
        // A clear/reconnect moved the ring: start the visible buffer over.
        terminal.clear();
        epoch = result.epoch;
        cursor[view] = result.bytes;
        if (result.text) terminal.terminal.write(result.text);
        return;
      }
      cursor[view] = result.bytes;
      if (result.text) terminal.terminal.write(result.text);
    } catch (caught) {
      handleError(caught);
    }
  }

  /** Drops a transient transport error once a request succeeds again. */
  function clearTransientError() {
    if (phase === 'unauthorized') return;
    if (error !== null) error = null;
    if (phase !== 'ready') phase = 'ready';
  }

  function handleError(caught: unknown) {
    if (disposed) return;
    if (caught instanceof HttpError && (caught.status === 401 || caught.status === 403)) {
      phase = 'unauthorized';
      error = `${MISSING_TOKEN} (${caught.message || `HTTP ${caught.status}`})`;
    } else {
      error = `Console request failed: ${describe(caught)}`;
    }
    render();
  }

  function subscribe() {
    sse?.close();
    sse = openEvents(token, {
      onState: (next) => {
        if (disposed) return;
        state = { ...(state ?? ({} as LinkState)), ...next };
        render();
      },
      onOutput: applyOutput,
      onRequest: (request: RequestEvent) => {
        if (request.action === 'clear') {
          void clearConsole();
        } else if (request.action === 'open' || request.action === 'focus') {
          terminal.focus();
        }
      },
      onOpen: () => {
        if (disposed) return;
        streamOpen = true;
        stopStatePoll();
        render();
        if (!initializing && phase !== 'connecting') void catchUp();
      },
      onError: () => {
        if (disposed) return;
        streamOpen = false;
        render();
        startStatePoll();
      },
    });
  }

  function startStatePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const snapshot = await client.state();
        if (disposed) return;
        state = snapshot;
        error = null;
        render();
      } catch {
        /* the hint already says the stream is lost */
      }
    }, 2000);
  }

  function stopStatePoll() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function scheduleResize(cols: number, rows: number) {
    if (state) state = { ...state, cols, rows };
    render();
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      void pushResize(cols, rows);
    }, 180);
  }

  async function pushResize(cols: number, rows: number) {
    try {
      const result = await client.resize(cols, rows);
      if (!result.ok) {
        if (!resizeWarned) {
          resizeWarned = true;
          terminal.notice(`resize not applied: ${result.error ?? result.reason ?? 'unknown reason'}`);
        }
        return;
      }
      if (result.applied === false && !resizeWarned) {
        resizeWarned = true;
        terminal.notice(`resize not applied: ${result.reason ?? 'unknown reason'}`);
      }
    } catch (caught) {
      if (!resizeWarned) {
        resizeWarned = true;
        terminal.notice(`resize not sent: ${describe(caught)}`);
      }
    }
  }

  async function sendInput(data: string) {
    try {
      const result = await client.input(data);
      if (!result.ok && !inputWarned) {
        inputWarned = true;
        terminal.notice(`input not sent: ${result.error ?? 'unknown error'}`);
      }
    } catch (caught) {
      if (!inputWarned) {
        inputWarned = true;
        terminal.notice(`input not sent: ${describe(caught)}`);
      }
    }
  }

  async function clearConsole() {
    terminal.clear();
    if (phase === 'unauthorized') return;
    try {
      const result = await client.clear();
      if (!result.ok) terminal.notice(`clear failed: ${result.error ?? 'unknown error'}`);
    } catch (caught) {
      terminal.notice(`clear failed: ${describe(caught)}`);
    }
  }

  async function reconnect() {
    if (phase === 'unauthorized') return;
    phase = 'connecting';
    error = null;
    render();
    terminal.notice('reconnecting to the board…');
    try {
      const result = await client.reconnect();
      if (!result.ok) terminal.notice(`reconnect failed: ${result.error ?? 'unknown error'}`);
    } catch (caught) {
      handleError(caught);
    }
    await catchUp();
    if (disposed) return;
    if (phase !== 'unauthorized') phase = 'ready';
    render();
  }

  function switchView(next: View) {
    if (view === next) return;
    view = next;
    render();
    void reloadView(true);
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(location.href);
      return;
    } catch {
      /* clipboard access can be denied; fall through */
    }
    const area = document.createElement('textarea');
    area.value = location.href;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch {
      /* nothing else to try */
    }
    area.remove();
  }

  async function start() {
    phase = 'connecting';
    error = null;
    render();
    subscribe();
    try {
      const snapshot = await client.state();
      if (disposed) return;
      state = snapshot;
    } catch (caught) {
      if (disposed) return;
      if (caught instanceof HttpError && (caught.status === 401 || caught.status === 403)) {
        phase = 'unauthorized';
        error = `${MISSING_TOKEN} (${caught.message || `HTTP ${caught.status}`})`;
        render();
        return;
      }
      phase = 'error';
      error = `Cannot reach the console server: ${describe(caught)}`;
      render();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void start();
      }, 3000);
      return;
    }
    await reloadView(true);
    if (disposed) return;
    initializing = false;
    const buffered = pending;
    pending = [];
    for (const event of buffered) applyOutput(event);
    phase = 'ready';
    render();
  }

  const onUnload = () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (resizeTimer) clearTimeout(resizeTimer);
    stopStatePoll();
    sse?.close();
    stopTheme();
    terminal.dispose();
    ui.dispose();
  };
  window.addEventListener('pagehide', onUnload, { once: true });
  window.addEventListener('beforeunload', onUnload, { once: true });

  void start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
