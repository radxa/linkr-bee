/**
 * OpenCode 2.x plugin entry for the Linkr Bee wireless serial bridge.
 *
 * The v2 API is `Plugin.define({ id, setup })` from `@opencode/plugin`:
 * OpenCode imports the package, calls `setup(ctx)` once with the plugin
 * context, and keeps the returned cleanup. Setup contributes:
 *
 *  - the shared console authority (`src/console.js`): one resident
 *    `bee-cli --serve` session, the raw/reading rings and the link lease the
 *    one-shot tools take;
 *  - the typed console RPC (`src/rpc.js`, id `linkr_bee.console`) that the TUI
 *    and Web UI panels call/subscribe to;
 *  - the board tools in a single `ctx.tool.transform()` call: the four
 *    one-shot tools plus `linkr_bee_console` driving the shared console.
 *
 * User configuration lives in `ctx.options` (the `options` object of a
 * `plugins` entry in opencode.json); environment variables fill in whatever is
 * absent. Loading must never touch the board: no process is spawned, no scan
 * is run and no bee-cli lookup happens until a panel calls `state`/`read` or a
 * tool executes. normalizeConfig never throws, so a mistyped option cannot
 * take the server down either.
 *
 * This is the only file that imports `@opencode/plugin`; the rest of the
 * package is plain Node so the unit tests run with no node_modules at all.
 */
import { writeFileSync } from 'node:fs';
import { Plugin } from '@opencode/plugin';
import {
  DEFAULT_SEND_CAPTURE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WEB_CONSOLE,
  TRANSPORTS,
  normalizeConfig,
  parseUartSpec,
} from './src/config.js';
import { createConsole, defineConsoleTool } from './src/console.js';
import LinkrBeeConsole from './src/rpc.js';
import {
  mergeSettings,
  publicSettings,
  readSettings,
  settingsFilePath,
  writeSettings,
} from './src/settings.js';
import { dialArgs, renderRun, requireSuccess, runBee } from './src/bee-cli.js';
import { createWebConsole } from './src/web-console.js';
import { defineTools } from './src/tools.js';

/** The tool names this plugin registers (`ctx.tool.list()` ids). */
export const TOOL_IDS = Object.freeze([
  'linkr_bee_exec',
  'linkr_bee_query',
  'linkr_bee_send',
  'linkr_bee_set',
  'linkr_bee_console',
]);

export const id = 'opencode-linkr-bee';

/** Validate one structured UART spec and return the CLI's `baud,data,parity,stop,flow`. */
function validateUartInput(uart) {
  if (!uart || typeof uart !== 'object') throw new Error('uart must be an object');
  const { baud, dataBits, parity, stopBits, flow } = uart;
  if (!Number.isInteger(baud) || baud < 1) throw new Error('uart.baud must be a positive integer');
  if (!Number.isInteger(dataBits) || dataBits < 5 || dataBits > 8) throw new Error('uart.dataBits must be 5-8');
  if (!['n', 'e', 'o'].includes(parity)) throw new Error('uart.parity must be n, e or o');
  if (stopBits !== 1 && stopBits !== 2) throw new Error('uart.stopBits must be 1 or 2');
  if (flow !== 'none' && flow !== 'rtscts') throw new Error('uart.flow must be none or rtscts');
  const fields = parseUartSpec(`${baud},${dataBits},${parity},${stopBits},${flow}`);
  return `${fields.baud},${fields.dataBits},${fields.parity},${fields.stopBits},${fields.flow}`;
}

export default Plugin.define({
  id,
  async setup(ctx) {
    // Saved settings (written by the Desktop settings page) outrank the
    // opencode.json options and the environment; load them without ever
    // failing the plugin when the file is missing or corrupt.
    const settingsPath = settingsFilePath();
    const configIssues = [];
    let persisted = readSettings(settingsPath, configIssues);
    let config = normalizeConfig(ctx?.options, { persisted, issues: configIssues });
    const defaults = Object.freeze({
      transport: 'ble',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      sendCaptureMs: DEFAULT_SEND_CAPTURE_MS,
      webConsole: DEFAULT_WEB_CONSOLE,
    });

    // The console authority publishes RPC events; the registration that owns
    // `events.emit` exists only after `ctx.rpc.register` below, so the emitter
    // is swapped in immediately afterwards. No event can be published before
    // that: setup has not touched the board yet.
    let emitEvent = () => {};
    let webRuntime = null;
    const consoleRuntime = createConsole({
      config,
      // Fan the console authority's events out to the RPC registration and to
      // the local browser page's SSE clients: one console, several listeners.
      emit: (name, data) => {
        emitEvent(name, data);
        webRuntime?.broadcast(name, data);
      },
    });
    const webConsoleRuntime = createWebConsole({ console: consoleRuntime, config });
    webRuntime = webConsoleRuntime;

    const rpcRegistration = await ctx.rpc.register(LinkrBeeConsole, {
      state: async () => {
        const state = await consoleRuntime.consoleState();
        const page = webConsoleRuntime.info();
        return { ...state, ...(page.url ? { webUrl: page.url } : {}) };
      },
      read: async (input) => consoleRuntime.readConsole(input ?? {}),
      write: async (input) => {
        await consoleRuntime.write(input?.data, undefined);
        return { ok: true };
      },
      key: async (input) => {
        await consoleRuntime.key(input?.key, undefined);
        return { ok: true };
      },
      resize: async (input) => consoleRuntime.resize(input?.cols, input?.rows, undefined),
      clear: async () => {
        consoleRuntime.clear();
        return { ok: true };
      },
      reconnect: async () => {
        const result = await consoleRuntime.reconnect();
        return { ok: result.ok };
      },
      webUrl: async () => webConsoleRuntime.webUrl(),
      settings: async () => ({ settings: publicSettings(config, persisted), defaults: { ...defaults } }),
      updateSettings: async (input) => {
        const patch = input && typeof input === 'object' ? input : {};
        if (patch.transport !== undefined && !TRANSPORTS.includes(patch.transport)) {
          throw new Error('transport must be ble, lan or loopback');
        }
        if (patch.uart !== undefined && patch.uart !== null) {
          validateUartInput(patch.uart);
        }
        const nextPersisted = mergeSettings(persisted, patch);
        // Normalise before persisting, so the file always holds valid values
        // (the settings page cannot write a budget the CLI would refuse).
        const nextConfig = normalizeConfig(ctx?.options, { persisted: nextPersisted });
        const saved = {
          ...nextPersisted,
          transport: nextConfig.transport,
          timeoutMs: nextConfig.timeoutMs,
          sendCaptureMs: nextConfig.sendCaptureMs,
          webConsole: nextConfig.webConsole,
        };
        writeSettings(settingsPath, saved);
        persisted = saved;
        // Mutate the one config object instead of replacing it: the tools and
        // the console authority captured this reference at setup.
        Object.assign(config, nextConfig);
        consoleRuntime.setConfig(config);
        if (nextConfig.uart) consoleRuntime.setBaud(nextConfig.uart.baud);
        await webConsoleRuntime.setEnabled(config.webConsole);
        const linkChanged = ['transport', 'bleName', 'bleAddress', 'lanHost', 'lanToken', 'cliPath']
          .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
        if (linkChanged) await consoleRuntime.reconnect();
        return { settings: publicSettings(config, persisted), defaults: { ...defaults } };
      },
      scan: async () => {
        const run = await consoleRuntime.linkLease({}, async ({ signal }) => runBee(config, ['--scan', '--json', '--timeout', '8'], { signal }));
        const failure = run.events.find((event) => event.event === 'error');
        if (run.code !== 0 || failure) {
          throw new Error(failure?.message || run.stderr.trim() || `scan failed (exit ${run.code})`);
        }
        const boards = run.events
          .filter((event) => event.event === 'device' && event.board && event.name)
          .map((event) => {
            const rssi = Number(event.rssi);
            return { name: String(event.name), rssi: Number.isFinite(rssi) ? rssi : 0 };
          });
        return { boards };
      },
      applyUart: async (input) => {
        try {
          if (config.transport !== 'ble') {
            throw new Error('UART settings need the Bluetooth LE transport; LAN and loopback links cannot configure the bridge');
          }
          const spec = validateUartInput(input);
          const run = await consoleRuntime.linkLease({}, async ({ signal }) => runBee(
            config,
            [...(await dialArgs(config, { signal })), '--json', '--uart', spec],
            { signal },
          ));
          requireSuccess(run, 'uart');
          const nextPersisted = mergeSettings(persisted, { uart: input });
          writeSettings(settingsPath, nextPersisted);
          persisted = nextPersisted;
          // Show the new baud rate at once, without waiting for the next dial.
          Object.assign(config, { uart: { ...input } });
          consoleRuntime.setBaud(input.baud);
          return { ok: true, result: renderRun(run) };
        } catch (error) {
          // Bridge management answers are shown in the settings page; a LAN
          // link or an absent board is a normal, reportable failure there.
          return { ok: false, result: error instanceof Error ? error.message : String(error) };
        }
      },
    });
    emitEvent = (name, data) => rpcRegistration.events.emit(name, data);

    // The local browser console page is enabled by default (config.webConsole,
    // env LINKR_BEE_WEB_CONSOLE) and starts with the plugin, so `state.webUrl`
    // is immediately usable by the panels and by a person copying the link.
    // Start failures are not fatal: webUrl() retries on demand.
    if (config.webConsole !== false) {
      await webConsoleRuntime.start();
    }

    // State-changing calls ask the host to evaluate the `linkr_bee` permission
    // action: `deny` already hides the tool (host auto-gate), while `ask` is a
    // real prompt only through this assert call. Without a matching rule the
    // built-in agents' default allow applies, so a normal setup is unchanged.
    const assertPermission = ({ context, action, resources, metadata }) => ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: 'tool', messageID: context.messageID, id: context.id },
      action,
      resources,
      metadata,
    });

    const registration = await ctx.tool.transform((editor) => {
      for (const info of defineTools({
        config,
        assertPermission,
        linkLease: consoleRuntime.linkLease,
      })) {
        editor.add(info);
      }
      editor.add(defineConsoleTool({ console: consoleRuntime }));
    });

    // Diagnostics hook used by the package's real-server smoke test: when the
    // environment names a file, record which board tools the host actually
    // accepted into the registry. Off by default; it never touches the board.
    const marker = process.env.LINKR_BEE_OPENCODE_MARKER;
    if (marker) {
      try {
        const registered = (await ctx.tool.list())
          .map((info) => info.id)
          .filter((toolId) => TOOL_IDS.includes(toolId));
        writeFileSync(marker, JSON.stringify({ plugin: id, version: ctx.app?.version ?? '', tools: registered }, null, 2));
      } catch {
        /* diagnostics are best effort */
      }
    }

    return async () => {
      await webConsoleRuntime.stop();
      consoleRuntime.dispose();
      await registration.dispose();
      await rpcRegistration.dispose();
    };
  },
});
