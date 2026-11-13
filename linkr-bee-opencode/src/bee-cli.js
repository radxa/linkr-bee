/**
 * The bee-cli side of the OpenCode Linkr Bee plugin: find the client, work out
 * how to dial the board, run one request, and render what came back.
 *
 * Node built-ins only, no package imports. That keeps the module loadable in a
 * project where neither the plugin's dependencies nor bee-cli are installed
 * yet, and it keeps the unit tests dependency-free.
 *
 * Unlike the DSH plugin there is no resident `--serve` session and no console
 * pane: OpenCode has no right-column terminal, so every tool call is one
 * `bee-cli` request (one dial, one answer, one exit code). An optional `--json`
 * gives JSON Lines; the run may emit output frames while it executes.
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_TIMEOUT_MS } from './config.js';

/** Actionable text for the one failure every install eventually hits. */
export const BUILD_HINT =
  'bee-cli was not found. Install the Linkr Bee client — `npm install -g linkr-bee-cli`, which fetches ' +
  'the binary for this platform and verifies it — or point the plugin\'s cliPath at a bee-cli you built ' +
  'yourself, or set LINKR_BEE_CLI, or put bee-cli on PATH.';

/** Every bee-cli this plugin spawned and has not yet seen exit (for diagnostics). */
const liveChildren = new Set();

/** Per-run JSON capture budget: enough for a command log, never unbounded. */
export const MAX_CAPTURE_BYTES = 1024 * 1024;
export const MAX_CAPTURE_EVENTS = 4096;
export const CAPTURE_NOTICE =
  '(captured output truncated; only the most recent events were kept)';

/* ---------------------------------------------------------------- bee-cli */

/**
 * What to run, and how, to talk to the board. First win:
 *
 * 1. `cliPath` — the path the user configured;
 * 2. `$LINKR_BEE_CLI` — a shell's own choice;
 * 3. the `linkr-bee-cli` npm launcher this plugin depends on: it downloads the
 *    platform binary on first use, checks it against the release's SHA256SUMS
 *    and caches it, so installing the plugin is the whole install;
 * 4. a `bee-cli` built in this checkout (`tools/linkr-tui/target/release`) —
 *    the developer case, where the plugin is linked from the source tree and a
 *    package manager does not install a linked package's own dependencies;
 * 5. `bee-cli` on `PATH` — where a binary someone built themselves ends up.
 *
 * `runtime` is an injection point for tests: it lets a caller stub the file
 * system, the environment and the previous-launcher lookup without spawning.
 */
export function resolveCli(config, runtime = {}) {
  const env = runtime.env ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const exists = runtime.exists ?? existsSync;

  for (const candidate of [config?.cliPath, env.LINKR_BEE_CLI]) {
    if (!candidate || !exists(candidate)) continue;
    // Windows ships the npm launcher as a .cmd shim, which Node refuses to
    // spawn without a shell (and a shell would re-parse the target command).
    // Say what to point at instead of failing later with a bare EINVAL.
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) {
      throw new Error(
        'cliPath points at a Windows .cmd shim; point it at bee-cli.exe instead ' +
        '(the linkr-bee-cli launcher caches one under %LOCALAPPDATA%\\bee-cli), ' +
        'or leave cliPath empty to use the bundled launcher.',
      );
    }
    return { command: candidate, args: [] };
  }

  // A launcher is JavaScript: it forwards its arguments and stdio to the real
  // binary, so the request speaks to the same pipes either way. A package
  // manager may hand the plugin over through a symlink (pnpm does), so the
  // launcher is looked up from both this file's URL and its real path.
  const launchers = runtime.launchers ?? launcherCandidates();
  for (const launcher of launchers) {
    if (typeof launcher === 'string' && launcher !== '') {
      return { command: runtime.execPath ?? process.execPath, args: [launcher] };
    }
  }

  const built = runtime.workspaceBuild === undefined ? workspaceBuild() : runtime.workspaceBuild;
  if (built) return { command: built, args: [] };

  // libuv does not resolve `.cmd` without a shell, so name the executable
  // explicitly on Windows; the bundled launcher above is the normal path.
  return { command: platform === 'win32' ? 'bee-cli.exe' : 'bee-cli', args: [] };
}

/**
 * The installed `linkr-bee-cli` launcher, as one candidate per resolution
 * base (`null` when that base has no such package). The default bases are this
 * file and its real path, so linked and symlinked installs both work.
 */
export function launcherCandidates(bases = defaultLauncherBases()) {
  return bases.map((base) => {
    try {
      return createRequire(base).resolve('linkr-bee-cli/bin/bee-cli.js');
    } catch {
      return null;
    }
  });
}

function defaultLauncherBases() {
  const here = fileURLToPath(import.meta.url);
  const bases = [here];
  try {
    const real = realpathSync(here);
    if (real !== here) bases.push(real);
  } catch {
    /* a broken link is the same as no link */
  }
  return bases;
}

/**
 * A `bee-cli` built beside this checkout's `linkr-bee-opencode` directory, or
 * null when the plugin was installed rather than linked. This is what keeps a
 * source checkout working when its `node_modules` is pruned: the dependency's
 * launcher disappears, but the build the person just made is still there.
 */
export function workspaceBuild() {
  // This file is <checkout>/linkr-bee-opencode/src/bee-cli.js, so the package
  // root is one directory up and the repository root is two.
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const checkoutRoot = dirname(packageRoot);
  const exe = process.platform === 'win32' ? 'bee-cli.exe' : 'bee-cli';
  const candidate = join(checkoutRoot, 'tools', 'linkr-tui', 'target', 'release', exe);
  return existsSync(candidate) ? candidate : null;
}

/* ------------------------------------------------------------- connection */

/**
 * Connection flags from the effective config. BLE auto-discovery (scan, then
 * dial by name) is resolved later by `dialArgs()`, so an empty array here means
 * "a nearby board, found by scanning".
 */
export function connectionArgs(config) {
  const transport = config?.transport || 'ble';
  if (transport === 'loopback') return ['--bridge', '-'];
  if (transport === 'lan') {
    // Falling through to BLE (the CLI's default when no transport flag is
    // given) would silently drive a nearby board over Bluetooth for a user who
    // asked for the network.
    if (!config?.lanHost) {
      throw new Error('LAN transport needs lanHost; set it in the plugin config (or switch transport to ble/loopback).');
    }
    return ['--lan-host', config.lanHost];
  }
  if (config?.bleAddress) return ['--ble-address', config.bleAddress];
  if (config?.bleName) return ['--ble-name', config.bleName];
  return []; // BLE auto-discovery is resolved by dialArgs() below.
}

/**
 * BLE auto-discovery cannot just dial the scanned board: on macOS CoreBluetooth
 * hides real MACs (scans report a placeholder address) and the redial comes up
 * with no session. Discover the board's name first, then dial by name.
 *
 * The name is a hint, not a binding. It is only reused while the connection
 * settings it was found under are unchanged and it is younger than
 * DISCOVERY_TTL_MS, so renaming a board, swapping in another one or walking
 * back into range all recover by scanning again. A failed dial forgets it
 * immediately (see runBee's close handler).
 */
export const DISCOVERY_TTL_MS = 5 * 60_000;
let discovered = null; // { name, key, at }

/** The settings a discovered name belongs to; change one and it is stale. */
export function discoveryKey(config) {
  return [
    config?.transport || 'ble',
    config?.bleName || '',
    config?.bleAddress || '',
    config?.lanHost || '',
    config?.lanToken || '',
  ].join('\u0000');
}

/** Forget the discovered board: the next dial scans again. */
export function forgetDiscoveredName() {
  discovered = null;
}

/** The board name to dial, or '' when discovery has not settled on one. */
export function discoveredBleName() {
  return discovered === null ? '' : discovered.name;
}

/**
 * Connection arguments for this call, scanning first when the config asks for
 * BLE auto-discovery. `options` is forwarded to runBee (signal, timeout
 * override) so cancelling a dial also cancels the scan that led to it.
 */
export async function dialArgs(config, options = {}) {
  const args = connectionArgs(config);
  if (args.length > 0 || (config?.transport || 'ble') !== 'ble') return args;
  const key = discoveryKey(config);
  if (discovered !== null && discovered.key === key &&
      Date.now() - discovered.at < DISCOVERY_TTL_MS) {
    return ['--ble-name', discovered.name];
  }
  discovered = null;
  const run = await runBee(config, ['--scan', '--json'], options);
  const device = run.events.find((event) => event.event === 'device' && event.board && event.name);
  if (!device) {
    // A dial with no name would make bee-cli fall back to its own "any board"
    // dial. Say what is actually missing instead.
    throw new Error(
      'No Linkr Bee board found: power it on and keep it in range, or set bleName/bleAddress in the plugin configuration.',
    );
  }
  discovered = { name: device.name, key, at: Date.now() };
  return ['--ble-name', discovered.name];
}

/* ------------------------------------------------------------------ runs */

export function newCapture() {
  return { events: [], sizes: [], bytes: 0, truncated: false };
}

/** Bound retained JSON frames while keeping the latest result/error frames. */
export function captureEvent(capture, event) {
  const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
  if (bytes > MAX_CAPTURE_BYTES || (event.event === 'output' &&
      (capture.bytes + bytes > MAX_CAPTURE_BYTES || capture.events.length >= MAX_CAPTURE_EVENTS))) {
    capture.truncated = true;
    return;
  }
  // Output is expendable; a completion or failure must remain observable even
  // after the output budget fills up. Metadata also has a bounded total size.
  while (capture.bytes + bytes > MAX_CAPTURE_BYTES || capture.events.length >= MAX_CAPTURE_EVENTS) {
    capture.bytes -= capture.sizes.shift();
    capture.events.shift();
    capture.truncated = true;
  }
  capture.events.push(event);
  capture.sizes.push(bytes);
  capture.bytes += bytes;
}

function aborted(signal, delivery = 'not-sent') {
  const error = new Error(delivery === 'unknown'
    ? 'Operation cancelled after dispatch; delivery or completion is unknown. Do not resend automatically.'
    : 'Operation cancelled before dispatch; input was not sent.');
  error.name = 'AbortError';
  error.delivery = delivery;
  error.cause = signal?.reason;
  return error;
}

/** Cancel a caller's wait without cancelling work another caller owns. */
function waitWithSignal(promise, signal) {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(aborted(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', abort);
      signal.aborted ? reject(aborted(signal)) : resolve(value);
    }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw aborted(signal);
}

/**
 * One board serves one connection, so one-shot requests are serialized: two
 * tools called at the same moment must not race each other for the radio and
 * leave both failing. `release` is returned instead of a lock object so every
 * exit path releases exactly once.
 */
let linkTail = Promise.resolve();

async function acquireLink(signal) {
  const previous = linkTail;
  let release;
  linkTail = new Promise((resolve) => { release = resolve; });
  try {
    await waitWithSignal(previous, signal);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

/**
 * Run one bee-cli request. Resolves with the parsed JSON Lines events plus the
 * raw streams so callers can still show output when the CLI printed no events.
 *
 * `timeoutMs` overrides the computed wall-clock deadline; normally the budget
 * is derived from the config plus the CLI's own retries (a retried exec can
 * legitimately take several times one timeout).
 */
export async function runBee(config, args, options = {}) {
  const { stdinText, keepStdinOpenMs = 0, signal, onEvent, timeoutMs: timeoutOverride } = options;
  throwIfAborted(signal);
  const release = await acquireLink(signal);

  let child;
  try {
    const cli = resolveCli(config);
    const env = { ...process.env };
    if (config?.lanToken) env.LINKR_LAN_TOKEN = config.lanToken;
    // windowsHide: a one-shot run must not flash a console window under the
    // desktop app once per command.
    child = spawn(cli.command, [...cli.args, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true,
    });
    liveChildren.add(child);
  } catch (error) {
    release();
    throw error;
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let pending = '';
    let settled = false;
    let captureTimer;
    let timer;
    let abort;
    let inputWritten = false;
    // Parsed once, as lines arrive: the answer is this list, not a copy of the
    // whole stream, so a runaway command cannot grow the heap without bound.
    const capture = newCapture();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(captureTimer);
      signal?.removeEventListener('abort', abort);
      liveChildren.delete(child);
      release();
      fn(value);
    };
    const fail = (error) => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(reject, signal?.aborted
        ? aborted(signal, inputWritten ? 'unknown' : 'not-sent')
        : error);
    };

    // Setup must not throw out of the executor: a child already exists, and
    // the promise would reject without `finish` releasing the link or reaping it.
    try {
      const retryAt = args.indexOf('--retry');
      const attempts = retryAt < 0 ? 1 : 1 + Math.max(0, Number(args[retryAt + 1]) || 0);
      const computed = Math.min(MAX_TIMEOUT_MS, Math.max(5000,
        ((config?.timeoutMs || 30_000) + (args.includes('--exec') ? 3000 : 0)) * attempts + 15_000));
      const deadline = timeoutOverride === undefined
        ? computed
        : Math.max(50, Math.round(Number(timeoutOverride) || 0));
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new Error(`bee-cli timed out after ${deadline} ms`));
      }, deadline);
      abort = () => {
        child.kill('SIGKILL');
        finish(reject, aborted(signal, 'unknown'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', (error) => finish(reject, error));

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        // Bounded diagnostic tail only; the events are collected separately.
        stdout = (stdout + chunk).slice(-MAX_CAPTURE_BYTES);
        pending += chunk;
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event && typeof event === 'object') {
              captureEvent(capture, event);
              onEvent?.(event);
            }
          } catch {
            /* a non-JSON progress line stays in stdout only */
          }
        }
        if (pending.length > MAX_CAPTURE_BYTES) pending = pending.slice(-MAX_CAPTURE_BYTES);
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-MAX_CAPTURE_BYTES);
      });
      child.on('error', (error) => {
        // A discovered name that cannot even be spawned is stale too.
        if (args.includes('--ble-name')) forgetDiscoveredName();
        finish(reject, error.code === 'ENOENT' ? new Error(BUILD_HINT) : error);
      });
      child.on('close', (code, signalName) => {
        // A dial by a discovered name that failed means the hint is stale:
        // forget it so the next call scans again instead of redialling the
        // same missing board forever. A successful run keeps the name.
        if (code !== 0 && args.includes('--ble-name')) forgetDiscoveredName();
        finish(resolve, { code, signalName, events: capture.events, truncated: capture.truncated, stdout, stderr });
      });

      if (stdinText !== undefined) {
        throwIfAborted(signal);
        // Line mode reads until LF or EOF. Frame the final line now so the
        // capture budget begins after delivery, rather than delaying delivery.
        const sendAt = args.indexOf('--send');
        const input = sendAt >= 0 && args[sendAt + 1] === 'line' && stdinText && !stdinText.endsWith('\n')
          ? stdinText + '\n' : stdinText;
        child.stdin.write(input);
        inputWritten = true;
        if (keepStdinOpenMs > 0) {
          captureTimer = setTimeout(() => {
            try {
              child.stdin.end();
            } catch {
              /* the pipe may already be gone */
            }
          }, keepStdinOpenMs);
        } else {
          child.stdin.end();
        }
      } else {
        child.stdin.end();
      }
    } catch (error) {
      fail(error);
    }
  });
}

/** Kill stray children (diagnostics and a future dispose hook). */
export function killStrayChildren() {
  for (const child of liveChildren) {
    try {
      child.stdin?.end();
    } catch {
      /* the pipe may already be gone */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  liveChildren.clear();
}

/* -------------------------------------------------------------- rendering */

/**
 * Turn one settled run into the text a tool returns: result/metadata frames as
 * JSON Lines, the target's own words under their own heading, stderr and the
 * truncation notice at the end.
 */
export function renderRun(run) {
  const resultLines = [];
  const outputParts = [];
  for (const event of run.events ?? []) {
    if (event.event === 'output') outputParts.push(event.data ?? event.text ?? '');
    else resultLines.push(JSON.stringify(event));
  }
  const sections = [];
  if (resultLines.length) sections.push(resultLines.join('\n'));
  const output = outputParts.join('');
  if (output) sections.push(`--- target output ---\n${output}`);
  if (!sections.length) sections.push(run.stdout?.trim() || run.stderr?.trim() || '(no output)');
  if (run.stderr?.trim()) sections.push(`--- stderr ---\n${run.stderr.trim()}`);
  if (run.truncated) sections.push(CAPTURE_NOTICE);
  return sections.join('\n');
}

/** Every settled run with events is an answer; only tooling failures throw. */
export function report(run) {
  if (run.events.length > 0) return renderRun(run);
  if (run.code === 0) return renderRun(run);
  const detail = run.stderr?.trim() || run.stdout?.trim();
  throw new Error(
    `bee-cli failed (exit ${run.code}${run.signalName ? `, signal ${run.signalName}` : ''})` +
      `${detail ? `:\n${detail}` : ''}`,
  );
}

/** Console output events of one bee-cli run, as one string. */
export function consoleOutputOf(run) {
  return run.events
    .filter((event) => event.event === 'output')
    .map((event) => event.data ?? event.text ?? '')
    .join('');
}

/** A completed frame is not necessarily a successful operation. */
export function requireSuccess(answer, op) {
  if (answer.code !== 0 || answer.events.some((event) => event.event === 'result' && event.ok === false)) {
    throw new Error(
      `bee-cli ${op} failed (exit ${answer.code}); input was not confirmed delivered. Do not resend automatically.`,
    );
  }
  return answer;
}

/* ------------------------------------------------------- query/set tables */

export const QUERY_FLAGS = Object.freeze({
  info: '--query-info',
  uart: '--query-uart',
  wifi: '--query-wifi',
  webdav: '--query-webdav',
  'ble-name': '--query-ble-name',
  lan: '--query-lan',
  state: '--link-state',
  doctor: '--doctor',
  scan: '--scan',
  'wifi-scan': '--wifi-scan',
});

export const SET_FLAGS = Object.freeze({
  uart: '--uart',
  wifi: '--wifi',
  'wifi-off': '--wifi-off',
  webdav: '--webdav',
  'webdav-off': '--webdav-off',
  'rename-ble': '--rename-ble',
  'reset-ble-name': '--reset-ble-name',
});
