/**
 * HTTP/SSE transport for the plugin-served local browser console page.
 *
 * The page is served by `src/web-console.js` on 127.0.0.1 and every request
 * carries the random token from `location.search` as `?t=<token>`. The JSON
 * shapes are the same as the `linkr_bee.console` RPC contract, so the page and
 * the Desktop/TUI panels see identical data.
 *
 * Keep this file free of DOM and xterm imports: it is the one place to adapt if
 * the server's endpoint paths or event names change.
 */
export type View = 'reading' | 'raw';

export interface LinkState {
  connected: boolean;
  transport: string;
  target: string;
  cols: number;
  rows: number;
}

export interface ReadResult {
  view: View;
  text: string;
  bytes: number;
  epoch: string;
  truncated?: boolean;
}

export interface OutputEvent {
  seq?: number;
  epoch?: string;
  kind?: 'data' | 'meta' | 'user';
  text?: string;
  bytes?: number;
  reading?: string;
  readingBytes?: number;
}

export interface RequestEvent {
  action?: 'open' | 'focus' | 'clear';
}

/** A mutating endpoint's JSON answer. */
export interface PostResult {
  ok: boolean;
  error?: string;
  applied?: boolean;
  cols?: number;
  rows?: number;
  reason?: string;
}

/** The query parameter that carries the server's random page token. */
const TOKEN_PARAM = 't';

/** Server endpoint paths, relative to the page origin. */
export const ENDPOINTS = Object.freeze({
  state: '/state',
  read: '/read',
  events: '/events',
  input: '/input',
  key: '/key',
  resize: '/resize',
  clear: '/clear',
  reconnect: '/reconnect',
});

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Reads the page token. The HTML shell injects it as a global; the query
 * parameter is the fallback for a hand-opened URL.
 */
export function readToken(search = location.search): string | null {
  const injected = (globalThis as any).__LINKR_BEE_TOKEN__;
  if (typeof injected === 'string' && injected.length > 0) return injected;
  const value = new URLSearchParams(search).get(TOKEN_PARAM);
  return value && value.length > 0 ? value : null;
}

function withToken(path: string, token: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(path, location.origin);
  url.searchParams.set(TOKEN_PARAM, token);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = '';
    try {
      const text = (await response.text()).slice(0, 800);
      try {
        const decoded = JSON.parse(text);
        detail = typeof decoded?.error === 'string' ? decoded.error : text;
      } catch {
        detail = text;
      }
    } catch {
      /* the body is best effort */
    }
    throw new HttpError(response.status, detail || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** The JSON API half of the console page. */
export class ConsoleClient {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async state(): Promise<LinkState> {
    const response = await fetch(withToken(ENDPOINTS.state, this.token), {
      cache: 'no-store',
      credentials: 'omit',
    });
    return readJson<LinkState>(response);
  }

  async read(view: View, since?: number): Promise<ReadResult> {
    const response = await fetch(withToken(ENDPOINTS.read, this.token, { view, since }), {
      cache: 'no-store',
      credentials: 'omit',
    });
    return readJson<ReadResult>(response);
  }

  async input(data: string): Promise<PostResult> {
    return this.post(ENDPOINTS.input, { data });
  }

  async key(key: string): Promise<PostResult> {
    return this.post(ENDPOINTS.key, { key });
  }

  async resize(cols: number, rows: number): Promise<PostResult> {
    return this.post(ENDPOINTS.resize, { cols, rows });
  }

  async clear(): Promise<PostResult> {
    return this.post(ENDPOINTS.clear, {});
  }

  async reconnect(): Promise<PostResult> {
    return this.post(ENDPOINTS.reconnect, {});
  }

  private async post(path: string, body: Record<string, unknown>): Promise<PostResult> {
    const response = await fetch(withToken(path, this.token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
    return readJson<PostResult>(response);
  }
}

export interface EventHandlers {
  onState(state: LinkState): void;
  onOutput(event: OutputEvent): void;
  onRequest(event: RequestEvent): void;
  /** The stream (re)connected; the caller should resync state and ring. */
  onOpen(): void;
  /** The stream dropped; EventSource keeps retrying by itself. */
  onError(): void;
}

export interface EventSubscription {
  close(): void;
}

/**
 * Opens the server-sent event stream and keeps retrying through the browser's
 * EventSource. Events are JSON payloads; an RPC-style `{type, location, data}`
 * envelope is unwrapped for robustness.
 */
export function openEvents(token: string, handlers: EventHandlers): EventSubscription {
  const url = withToken(ENDPOINTS.events, token);
  let source: EventSource | undefined;
  let closed = false;
  let opened = false;

  const unwrap = (event: MessageEvent): any => {
    if (!event.data) return undefined;
    let parsed: any;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return undefined;
    }
    if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object' && parsed.type) {
      return parsed.data;
    }
    return parsed;
  };

  const listen = (name: string, handler: (event: MessageEvent) => void) => {
    source?.addEventListener(name, handler as EventListener);
  };

  const connect = () => {
    source = new EventSource(url);
    source.addEventListener('open', () => {
      const first = !opened;
      opened = true;
      handlers.onOpen();
      if (!first) return;
    });
    listen('state', (event) => {
      const payload = unwrap(event);
      if (payload) handlers.onState(payload as LinkState);
    });
    listen('output', (event) => {
      const payload = unwrap(event);
      if (payload) handlers.onOutput(payload as OutputEvent);
    });
    listen('request', (event) => {
      const payload = unwrap(event);
      if (payload) handlers.onRequest(payload as RequestEvent);
    });
    source.addEventListener('error', () => {
      if (!closed) handlers.onError();
    });
  };

  connect();

  return {
    close() {
      closed = true;
      source?.close();
      source = undefined;
    },
  };
}
