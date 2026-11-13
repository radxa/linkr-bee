/**
 * The xterm.js half of the standalone browser console page.
 *
 * The page is a plain browser document, not an OpenCode window: no Solid, no
 * app theme object. The terminal follows the system colour scheme (or an
 * explicit `?theme=light|dark`), uses a bundled monospace stack, and is fitted
 * to the viewport with `@xterm/addon-fit`.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';

const DARK_THEME: ITheme = {
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

const LIGHT_THEME: ITheme = {
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

/** `light`, `dark`, or whatever the system reports. */
export function resolveTheme(search = location.search): 'light' | 'dark' {
  const requested = new URLSearchParams(search).get('theme');
  if (requested === 'light' || requested === 'dark') return requested;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function themeFor(mode: 'light' | 'dark'): ITheme {
  return mode === 'light' ? LIGHT_THEME : DARK_THEME;
}

export interface TerminalOptions {
  /** Forwarded to the server as raw keystrokes. */
  onData(data: string): void;
  /** The fitted terminal size changed (debounced by the caller). */
  onResize(cols: number, rows: number): void;
  theme: 'light' | 'dark';
}

export interface TerminalHandle {
  readonly terminal: Terminal;
  /** The element the page should place in the layout. */
  readonly element: HTMLElement;
  fit(): void;
  focus(): void;
  clear(): void;
  /** Writes a synthetic notice line, dim and prefixed. */
  notice(text: string): void;
  dispose(): void;
}

const FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "IBM Plex Mono", monospace';

/** Creates the terminal and opens it into a fresh element. */
export function createTerminal(options: TerminalOptions): TerminalHandle {
  const element = document.createElement('div');
  element.className = 'lbw-term-host';

  const terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    fontFamily: FONT_STACK,
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: 5000,
    theme: themeFor(options.theme),
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(element);
  terminal.onData((data) => options.onData(data));
  terminal.onResize(({ cols, rows }) => options.onResize(cols, rows));

  let observer: ResizeObserver | undefined;
  try {
    observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        /* the host may have zero size for a frame */
      }
    });
    observer.observe(element);
  } catch {
    /* ResizeObserver exists in every supported browser */
  }

  const handle: TerminalHandle = {
    terminal,
    element,
    fit() {
      try {
        fitAddon.fit();
      } catch {
        /* zero-sized host */
      }
    },
    focus() {
      terminal.focus();
    },
    clear() {
      terminal.write('\x1b[2J\x1b[3J\x1b[H');
    },
    notice(text: string) {
      terminal.write(`\r\n\x1b[90m[linkr-bee] ${text}\x1b[0m\r\n`);
    },
    dispose() {
      observer?.disconnect();
      observer = undefined;
      terminal.dispose();
    },
  };
  return handle;
}

/** Applies a colour scheme to a live terminal. */
export function applyTheme(handle: TerminalHandle, mode: 'light' | 'dark'): void {
  handle.terminal.options.theme = themeFor(mode);
}

/** Follows the system colour scheme; returns a disposer. */
export function watchSystemTheme(onChange: (mode: 'light' | 'dark') => void): () => void {
  if (new URLSearchParams(location.search).get('theme') === 'light' || new URLSearchParams(location.search).get('theme') === 'dark') {
    return () => {};
  }
  const query = matchMedia('(prefers-color-scheme: light)');
  const listener = () => onChange(query.matches ? 'light' : 'dark');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
