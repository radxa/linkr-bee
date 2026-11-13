/**
 * The standalone, local-only browser console page for the Linkr Bee plugin.
 *
 * OpenCode 2.x's browser web UI cannot load GUI plugin parts (verified), so a
 * plugin-owned page is the browser-side console: this module serves it from a
 * loopback-only HTTP server on an ephemeral port. The page (`dist/web-console.js`,
 * built by the browser-console bundle) talks to these endpoints with the same
 * console authority the agent tools, the TUI and the desktop panel use — there
 * is no second `bee-cli` session.
 *
 * Security posture: bind 127.0.0.1 only, ephemeral port, a random 32-hex token
 * required on every request (`?t=` because EventSource cannot set headers, and
 * `Authorization: Bearer` also accepted), no CORS headers, a request-body cap,
 * no third-party origins, and the server is stopped on plugin unload. The
 * token appears only in the URL `webUrl`/`state.webUrl` returns.
 *
 * Frozen endpoint contract (gui-impl builds the page against this):
 *   GET  /?t=…                  HTML shell, loads /assets/web-console.js
 *   GET  /assets/web-console.js page bundle from dist/web-console.js
 *   GET  /state                 RPC state shape + webUrl
 *   GET  /read?view=&since=     { view, text, bytes, epoch, truncated? }
 *   GET  /events?t=…            SSE: retry, initial `state`, then
 *                               `output` / `state` / `request` events (RPC payloads)
 *   POST /input {data}          { ok:true } | { ok:false, error }
 *   POST /key {key}             same
 *   POST /resize {cols,rows}    { ok:true, applied, cols, rows, reason? }
 *   POST /clear {}              { ok:true }
 *   POST /reconnect {}          { ok:true } | { ok:false, error }
 * Missing/wrong token → 401; bad JSON/body → 400/413; wrong method → 405.
 *
 * Node built-ins only.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_CONSOLE_BODY_LIMIT = 64 * 1024;
const MAX_EVENT_CLIENTS = 16;
const MAX_EVENT_BACKLOG = 4 * 1024 * 1024;
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The package root, so the asset resolves relative to this file, never cwd. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ASSET_PATH = join(PACKAGE_ROOT, 'dist', 'web-console.js');

const SHELL_TITLE = 'Linkr Bee console';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the browser-page server for one plugin instance.
 *
 * `authority` is the shared console authority from `src/console.js`.
 * `config.webConsole` (default true) decides whether the page is available.
 * `assetPath` overrides the dist path (tests use a temp file).
 */
export function createWebConsole({ console: authority, config = {}, assetPath = DEFAULT_ASSET_PATH } = {}) {
  let enabled = config?.webConsole !== false;
  let server = null;
  let token = '';
  let url = '';
  let origin = '';
  let starting = null;
  let lastError = '';
  const clients = new Set();

  /* ------------------------------------------------------------- plumbing */

  const commonHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };

  function json(res, status, payload) {
    if (res.writableEnded) return;
    res.writeHead(status, { ...commonHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  function text(res, status, body, contentType) {
    if (res.writableEnded) return;
    res.writeHead(status, { ...commonHeaders, 'Content-Type': contentType });
    res.end(body);
  }

  /** Constant-time compare; a wrong-length token cannot be equal anyway. */
  function tokenMatches(req, parsedUrl) {
    if (token === '') return false;
    const supplied = parsedUrl.searchParams.get('t') ||
      (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1] ?? '');
    if (typeof supplied !== 'string' || supplied.length !== token.length) return false;
    try {
      return timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    } catch {
      return false;
    }
  }

  function isLoopback(req) {
    return LOCAL_ADDRESSES.has(req.socket.remoteAddress || '');
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let settled = false;
      let size = 0;
      const chunks = [];
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      req.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > WEB_CONSOLE_BODY_LIMIT) {
          // Answer 413 and keep draining (without buffering): destroying the
          // request here would close the socket before the response is read.
          settle({ tooLarge: true });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => settle({ body: Buffer.concat(chunks).toString('utf8') }));
      req.on('error', () => settle({ body: '' }));
      req.on('close', () => settle({ body: Buffer.concat(chunks).toString('utf8') }));
    });
  }

  function parseJsonBody(body) {
    if (typeof body !== 'string' || body.trim() === '') return { value: {} };
    try {
      const value = JSON.parse(body);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'request body must be a JSON object' };
      }
      return { value };
    } catch {
      return { error: 'request body is not valid JSON' };
    }
  }

  /* -------------------------------------------------------------- state */

  /** The RPC state shape without dialling the board (SSE initial frame). */
  function plainState() {
    try {
      const snapshot = authority.snapshot();
      const link = snapshot.link ?? {};
      return {
        connected: !!link.connected,
        transport: link.transport || config?.transport || 'ble',
        target: link.connected ? (link.target || '') : (link.lastError || link.target || ''),
        cols: snapshot.tty?.cols ?? 80,
        rows: snapshot.tty?.rows ?? 24,
        bytes: snapshot.bytes ?? 0,
        epoch: snapshot.epoch ?? '',
        readingBytes: snapshot.readingBytes ?? 0,
      };
    } catch {
      return {
        connected: false, transport: config?.transport || 'ble', target: lastError,
        cols: 80, rows: 24, bytes: 0, epoch: '', readingBytes: 0,
      };
    }
  }

  async function dialState() {
    const state = await authority.consoleState();
    return { ...state, ...(url ? { webUrl: url } : {}) };
  }

  /* ---------------------------------------------------------------- routes */

  function serveShell(res) {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SHELL_TITLE}</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#0f1115;color:#e6e6e6;font:13px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#linkr-console{position:fixed;inset:0}
</style>
<link rel="icon" href="data:,">
</head>
<body>
<div id="linkr-console"></div>
<script>window.__LINKR_BEE_TOKEN__=${JSON.stringify(token)};window.__LINKR_BEE_WEB_URL__=${JSON.stringify(origin)};</script>
<script src="/assets/web-console.js?t=${encodeURIComponent(token)}" defer></script>
</body>
</html>`;
    res.writeHead(200, {
      ...commonHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'",
    });
    res.end(html);
  }

  function serveAsset(res) {
    let bundle;
    try {
      bundle = readFileSync(assetPath);
    } catch {
      json(res, 404, { ok: false, error: 'web-console asset not built (dist/web-console.js)' });
      return;
    }
    res.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(bundle);
  }

  function openEvents(req, res) {
    if (clients.size >= MAX_EVENT_CLIENTS) {
      json(res, 429, { ok: false, error: 'too many console page connections' });
      return;
    }
    res.writeHead(200, {
      ...commonHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(plainState())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, 20_000);
    ping.unref?.();
    const cleanup = () => {
      clearInterval(ping);
      clients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
  }

  async function handlePost(pathname, req, res) {
    const read = await readBody(req);
    if (read?.tooLarge) {
      json(res, 413, { ok: false, error: 'request body too large' });
      return;
    }
    const parsed = parseJsonBody(read?.body);
    if (parsed.error) {
      json(res, 400, { ok: false, error: parsed.error });
      return;
    }
    const input = parsed.value;
    try {
      if (pathname === '/input') {
        if (typeof input.data !== 'string') {
          json(res, 400, { ok: false, error: 'input needs a string "data"' });
          return;
        }
        await authority.write(input.data);
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === '/key') {
        if (typeof input.key !== 'string') {
          json(res, 400, { ok: false, error: 'key needs a string "key"' });
          return;
        }
        await authority.key(input.key);
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === '/resize') {
        const cols = Number(input.cols);
        const rows = Number(input.rows);
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
          json(res, 400, { ok: false, error: 'resize needs numeric "cols" and "rows"' });
          return;
        }
        const result = await authority.resize(cols, rows);
        json(res, 200, { ok: true, ...result });
        return;
      }
      if (pathname === '/clear') {
        authority.clear();
        json(res, 200, { ok: true });
        return;
      }
      if (pathname === '/reconnect') {
        const result = await authority.reconnect();
        json(res, 200, result?.ok ? { ok: true } : { ok: false, error: 'reconnect failed' });
        return;
      }
    } catch (error) {
      // App-level failure: HTTP 200 with ok:false, as frozen with the page.
      json(res, 200, { ok: false, error: errorMessage(error) });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  }

  async function route(req, res) {
    if (!isLoopback(req)) {
      json(res, 403, { ok: false, error: 'loopback connections only' });
      return;
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      json(res, 400, { ok: false, error: 'bad request URL' });
      return;
    }
    if (!tokenMatches(req, parsedUrl)) {
      json(res, 401, { ok: false, error: 'invalid or missing token' });
      return;
    }
    const pathname = parsedUrl.pathname;
    const method = req.method || 'GET';

    if (method === 'GET' || method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') { serveShell(res); return; }
      if (pathname === '/assets/web-console.js') { serveAsset(res); return; }
      if (pathname === '/favicon.ico') { res.writeHead(204, commonHeaders); res.end(); return; }
      if (pathname === '/state') {
        try {
          json(res, 200, await dialState());
        } catch (error) {
          json(res, 200, { ...plainState(), error: errorMessage(error) });
        }
        return;
      }
      if (pathname === '/read') {
        const view = parsedUrl.searchParams.get('view') === 'raw' ? 'raw' : 'reading';
        const rawSince = parsedUrl.searchParams.get('since');
        const since = rawSince === null || rawSince === '' ? undefined : Number(rawSince);
        if (since !== undefined && !Number.isFinite(since)) {
          json(res, 400, { ok: false, error: 'since must be a byte counter' });
          return;
        }
        json(res, 200, authority.readConsole({ view, since }));
        return;
      }
      if (pathname === '/events') {
        openEvents(req, res);
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
      return;
    }

    if (method === 'POST') {
      if (['/input', '/key', '/resize', '/clear', '/reconnect'].includes(pathname)) {
        await handlePost(pathname, req, res);
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
      return;
    }

    if (['/', '/assets/web-console.js', '/state', '/read', '/events', '/favicon.ico',
      '/input', '/key', '/resize', '/clear', '/reconnect'].includes(pathname)) {
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  }

  function handleRequest(req, res) {
    void route(req, res).catch((error) => {
      json(res, 500, { ok: false, error: errorMessage(error) });
    });
  }

  /* ----------------------------------------------------------- lifecycle */

  function info() {
    return { url, enabled };
  }

  /** Start listening (idempotent); returns { url, enabled }. */
  async function start() {
    if (!enabled) return info();
    if (server !== null && url !== '') return info();
    if (starting !== null) return starting;
    starting = new Promise((resolve) => {
      const instance = createServer(handleRequest);
      const settle = (value) => {
        starting = null;
        resolve(value);
      };
      instance.once('error', (error) => {
        lastError = errorMessage(error);
        server = null;
        url = '';
        origin = '';
        try { instance.close(); } catch { /* never listened */ }
        settle(info());
      });
      instance.listen(0, '127.0.0.1', () => {
        server = instance;
        token = randomBytes(16).toString('hex');
        const address = instance.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        origin = `http://127.0.0.1:${port}`;
        url = `${origin}/?t=${token}`;
        lastError = '';
        settle(info());
      });
    });
    return starting;
  }

  /** Stop the page server and every open event stream. */
  async function stop() {
    const closing = server;
    server = null;
    url = '';
    origin = '';
    token = '';
    for (const client of [...clients]) {
      clients.delete(client);
      try { client.end(); } catch { /* already gone */ }
    }
    if (closing === null) {
      starting = null;
      return;
    }
    await new Promise((resolve) => {
      try {
        closing.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  /** Forward one console authority event to every open SSE client. */
  function broadcast(name, data) {
    if (clients.size === 0) return;
    if (name !== 'output' && name !== 'state' && name !== 'request') return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...clients]) {
      if (client.writableEnded) { clients.delete(client); continue; }
      // A backgrounded browser tab stops draining its socket; unbounded
      // buffering there is how a console stream turns into memory pressure.
      if (client.writableLength > MAX_EVENT_BACKLOG) {
        clients.delete(client);
        try { client.end(); } catch { /* already gone */ }
        continue;
      }
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  }

  /** The settings page can turn the page server on/off without a reload. */
  async function setEnabled(next) {
    enabled = next === true;
    if (enabled) await start();
    else await stop();
    return info();
  }

  return {
    get enabled() { return enabled; },
    setEnabled,
    start,
    stop,
    broadcast,
    info,
    /** `webUrl` RPC: start on demand, then report the page URL. */
    webUrl: async () => {
      await start();
      return info();
    },
    get lastError() { return lastError; },
    /** Test seam: the token currently in use ("" before start). */
    get token() { return token; },
  };
}
