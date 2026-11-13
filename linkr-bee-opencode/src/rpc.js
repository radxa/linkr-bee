/**
 * The console RPC contract exported by the package's `./rpc` entry point.
 *
 * Server half: index.js registers it with `ctx.rpc.register(LinkrBeeConsole,
 * handlers)`. UI halves (TUI panel and Web UI panel) import this default export
 * and call the server through the shared client:
 *
 *   import LinkrBeeConsole from "opencode-linkr-bee/rpc";
 *
 *   const console = ctx.client.rpc(LinkrBeeConsole);
 *   const state = await console.state({});              // lazily dials the board
 *   const first = await console.read({ view: "reading" });   // current ring
 *   const off = console.events.on("output", (event) => {
 *     // draw event.text; remember event.bytes as the next `since`
 *   });
 *   const stateOff = console.events.on("state", (state) => { ... });
 *   const requestOff = console.events.on("request", (request) => { ... });
 *   // or: for await (const event of console.events.subscribe("output")) { ... }
 *   await console.write({ data: "ls\r" });              // raw keystrokes
 *   await console.key({ key: "enter" });                // named key
 *   await console.resize({ cols: 120, rows: 40 });
 *   await console.clear({});
 *   await console.reconnect({});
 *
 * `state` and `read` are safe before any panel connects: they dial lazily and
 * report `connected: false` plus the last error instead of throwing when there
 * is no board or bee-cli. Every method's input/output is a plain object; see
 * `src/rpc-schema.js` for the frozen JSON Schema.
 */
import { Rpc } from '@opencode/plugin/rpc';

import { CONSOLE_RPC_ID, NAMED_KEYS, consoleRpcDefinition } from './rpc-schema.js';

export { CONSOLE_RPC_ID, NAMED_KEYS };

export default Rpc.define(consoleRpcDefinition());
