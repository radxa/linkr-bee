/**
 * DOM chrome for the standalone browser console page.
 *
 * Framework-free: the page is a plain browser document served by the plugin,
 * so this builds its own small DOM instead of relying on OpenCode's UI kit or
 * Solid. The terminal element arrives later from `terminal.ts`.
 */
import type { LinkState, View } from './client';

export type Phase = 'connecting' | 'ready' | 'error' | 'unauthorized';

export interface UiHandlers {
  onView(view: View): void;
  onClear(): void;
  onReconnect(): void;
  onCopy(): void;
}

export interface UiUpdate {
  phase: Phase;
  state: LinkState | null;
  view: View;
  /** The SSE stream is open. */
  stream: boolean;
  /** Persistent hint (authorization/transport error); null hides it. */
  error: string | null;
}

function button(label: string, action: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.dataset.action = action;
  element.textContent = label;
  return element;
}

export interface Ui {
  mount(container: HTMLElement): void;
  attachTerminal(element: HTMLElement): void;
  update(update: UiUpdate): void;
  setTheme(theme: 'light' | 'dark'): void;
  focus(): void;
  dispose(): void;
}

/** Builds the page chrome and reads the current terminal element state. */
export function createUi(handlers: UiHandlers): Ui {
  const root = document.createElement('div');
  root.className = 'lbw';
  root.innerHTML = `
    <header class="lbw-bar">
      <span class="lbw-dot" data-on="false" aria-hidden="true"></span>
      <span class="lbw-title">Linkr Bee console</span>
      <span class="lbw-status">connecting…</span>
      <span class="lbw-actions">
        <span class="lbw-seg" role="group" aria-label="Console view">
          <button type="button" data-view="reading" data-active="true" aria-pressed="true">Reading</button>
          <button type="button" data-view="raw" data-active="false" aria-pressed="false">Raw</button>
        </span>
        <button type="button" data-action="copy" title="Copy this console URL">Copy URL</button>
        <button type="button" data-action="clear">Clear</button>
        <button type="button" data-action="reconnect">Reconnect</button>
      </span>
    </header>
    <div class="lbw-target" hidden></div>
    <div class="lbw-hint" hidden></div>
    <div class="lbw-terminal"></div>
  `;

  const dot = root.querySelector<HTMLElement>('.lbw-dot')!;
  const status = root.querySelector<HTMLElement>('.lbw-status')!;
  const target = root.querySelector<HTMLElement>('.lbw-target')!;
  const hint = root.querySelector<HTMLElement>('.lbw-hint')!;
  const terminalHost = root.querySelector<HTMLElement>('.lbw-terminal')!;
  const viewButtons = [...root.querySelectorAll<HTMLButtonElement>('.lbw-seg button')];
  const clearButton = root.querySelector<HTMLButtonElement>('[data-action="clear"]')!;
  const reconnectButton = root.querySelector<HTMLButtonElement>('[data-action="reconnect"]')!;
  const copyButton = root.querySelector<HTMLButtonElement>('[data-action="copy"]')!;

  let current: UiUpdate = { phase: 'connecting', state: null, view: 'reading', stream: false, error: null };
  let copyLabel: ReturnType<typeof setTimeout> | undefined;

  for (const element of viewButtons) {
    element.addEventListener('click', () => {
      handlers.onView(element.dataset.view === 'raw' ? 'raw' : 'reading');
    });
  }
  clearButton.addEventListener('click', () => handlers.onClear());
  reconnectButton.addEventListener('click', () => handlers.onReconnect());
  copyButton.addEventListener('click', () => {
    handlers.onCopy();
    copyButton.textContent = 'Copied';
    if (copyLabel) clearTimeout(copyLabel);
    copyLabel = setTimeout(() => {
      copyButton.textContent = 'Copy URL';
      copyLabel = undefined;
    }, 1200);
  });

  function renderHint(update: UiUpdate) {
    let text = '';
    let tone: 'info' | 'warn' | 'error' = 'warn';
    let visible = true;
    if (update.error) {
      text = update.error;
      tone = 'error';
    } else if (update.phase === 'connecting') {
      text = 'Connecting to the console server…';
      tone = 'info';
    } else if (!update.stream) {
      text = 'Live update stream lost — retrying…';
      tone = 'warn';
    } else if (update.state && !update.state.connected) {
      text = update.state.target
        ? `No board connected. ${update.state.target}`
        : 'No board connected. Plug in a Linkr Bee board (or start bee-cli) and press Reconnect.';
      tone = 'warn';
    } else {
      visible = false;
    }
    hint.hidden = !visible;
    if (!visible) return;
    hint.dataset.tone = tone;
    hint.textContent = text;
  }

  function render() {
    const { state, view } = current;
    dot.dataset.on = state?.connected ? 'true' : 'false';
    const link = state?.connected ? 'connected' : 'disconnected';
    const transport = state?.transport || '—';
    const baud = state?.baud ? ` · ${state.baud}` : '';
    const size = state ? `${state.cols}×${state.rows}` : '—';
    status.textContent =
      current.phase === 'connecting' ? `connecting · ${transport}` : `${link} · ${transport}${baud} · ${size}`;
    status.title = state?.target ?? '';

    if (state?.connected && state.target) {
      target.hidden = false;
      target.textContent = `Target: ${state.target}`;
      target.title = state.target;
    } else {
      target.hidden = true;
      target.textContent = '';
    }

    for (const element of viewButtons) {
      const active = element.dataset.view === view;
      element.dataset.active = active ? 'true' : 'false';
      element.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    clearButton.disabled = current.phase === 'unauthorized';
    reconnectButton.disabled = current.phase === 'unauthorized';
    renderHint(current);
  }

  return {
    mount(container) {
      container.replaceChildren(root);
      render();
    },
    attachTerminal(element) {
      terminalHost.replaceChildren(element);
    },
    update(update) {
      current = update;
      render();
    },
    setTheme(theme) {
      document.documentElement.dataset.theme = theme;
    },
    focus() {
      terminalHost.querySelector<HTMLElement>('.xterm')?.focus();
    },
    dispose() {
      if (copyLabel) clearTimeout(copyLabel);
      root.remove();
    },
  };
}
