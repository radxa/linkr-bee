/* M7 — "capabilities decide the UI" for a board that says
 * "ERR <device> unsupported".
 *
 * The review's reproduction: `settle()` rejects the request with the raw reply
 * text, the panel's catch block used to only print a status line, so
 * `state.features.led` stayed null ("not probed") and the LED/opto/IR cards,
 * the Board settings tab and its rail entry all stayed on screen for a board
 * that cannot use them (AGENTS.md: never show a disabled ghost of an absent
 * feature).
 *
 * Two layers are covered here:
 *  1. the protocol chain — a board's ERR reply really is recognisable from the
 *     rejection (real modules, no stubs);
 *  2. the shipped handler — `hideUnsupportedFromError()` is lifted out of
 *     web/app.js text and executed against a fake state machine, so the code
 *     under test is the code that ships, not a copy of it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isUnsupportedReply } from "../../web/board_io.js";
import {
  MGMT_FLAG_ERROR,
  ManagementResponseTracker,
} from "../../web/management_protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "..", "web", "app.js"), "utf8");

/** Slice a top-level function declaration out of app.js by brace balance. */
function functionSource(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() is missing from web/app.js`);
  /* The parameter list may destructure ({ quiet = true }), so balance the
   * parentheses first and only then start counting braces. */
  let depth = 0;
  let index = appSource.indexOf("(", start);
  for (; index < appSource.length; index += 1) {
    if (appSource[index] === "(") depth += 1;
    else if (appSource[index] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  depth = 0;
  for (index = appSource.indexOf("{", index); index < appSource.length; index += 1) {
    const char = appSource[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return appSource.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

/** Evaluate one shipped function with its free variables injected. */
function loadFunction(name, parameters, args) {
  const build = new Function(...parameters, `${functionSource(name)}\nreturn ${name};`);
  return build(...args);
}

test("a board's ERR reply is recognisable from the tracker rejection", async () => {
  const tracker = new ManagementResponseTracker(200);
  const pending = tracker.wait(7);
  tracker.settle({
    type: 2,
    requestId: 7,
    flags: MGMT_FLAG_ERROR,
    text: "ERR led unsupported",
  });
  const error = await pending.then(
    () => assert.fail("an ERR reply must reject the request"),
    (rejection) => rejection,
  );
  assert.equal(error.message, "ERR led unsupported");
  assert.equal(isUnsupportedReply(error.message), true);
  /* A plain "unknown command" is not a capability answer and must not hide
   * anything, and neither must a transient timeout. */
  assert.equal(isUnsupportedReply("ERR unknown command"), false);
  assert.equal(isUnsupportedReply("Management response timed out (#7)"), false);
});

test("hideUnsupportedFromError hides the feature for ERR <device> unsupported", () => {
  const updates = [];
  const hideUnsupportedFromError = loadFunction(
    "hideUnsupportedFromError",
    ["isUnsupportedReply", "setFeature"],
    [isUnsupportedReply, (key, value) => updates.push([key, value])],
  );

  assert.equal(hideUnsupportedFromError("led", new Error("ERR led unsupported")), true);
  assert.deepEqual(updates, [["led", false]]);

  assert.equal(hideUnsupportedFromError("opto", new Error("ERR opto unsupported")), true);
  assert.equal(hideUnsupportedFromError("ir", { message: "ERR ir unsupported" }), true);
  assert.deepEqual(updates.slice(1), [["opto", false], ["ir", false]]);
});

test("hideUnsupportedFromError leaves real failures visible", () => {
  const updates = [];
  const hideUnsupportedFromError = loadFunction(
    "hideUnsupportedFromError",
    ["isUnsupportedReply", "setFeature"],
    [isUnsupportedReply, (key, value) => updates.push([key, value])],
  );

  for (const failure of [
    new Error("Management response timed out (#12)"),
    new Error("Management characteristic is not ready"),
    new Error("ERR unknown command"),
    new Error(""),
    undefined,
  ]) {
    assert.equal(hideUnsupportedFromError("led", failure), false);
  }
  assert.deepEqual(updates, []);
});

test("every board handler that can be rejected routes the rejection through the check", () => {
  /* Each of these awaits a control command; any of them can come back as
   * "ERR <device> unsupported" instead of "OK <device> unsupported". */
  for (const [name, key] of [
    ["refreshBoardLed", "led"],
    ["refreshBoardOpto", "opto"],
    ["refreshBoardIr", "ir"],
    ["refreshBoardSlots", "irLearn"],
    ["refreshBoardPromptStatus", "prompt"],
    ["applyBoardLedColor", "led"],
    ["boardOptoAction", "opto"],
    ["sendBoardIrFrame", "ir"],
  ]) {
    const source = functionSource(name);
    assert.match(
      source,
      new RegExp(`hideUnsupportedFromError\\("${key}", error\\)`),
      `${name}() must call hideUnsupportedFromError("${key}", error) in its catch`,
    );
    assert.match(source, /catch \(error\)/, `${name}() lost its catch block`);
  }
});

test("the WiFi config is hidden on a board that can be queried but not changed", () => {
  const WIFI = 1 << 0;
  const ASYNC = 1 << 4;
  const state = { connected: false, mode: "ble", mgmtReady: false, mgmtCapabilities: 0 };
  const hasManagementCapability = (bit) => (state.mgmtCapabilities & bit) === bit;
  const wifiMutationAllowed = loadFunction(
    "wifiMutationAllowed",
    ["state", "hasManagementCapability", "MGMT_CAP_WIFI", "MGMT_CAP_ASYNC_EVENTS"],
    [state, hasManagementCapability, WIFI, ASYNC],
  );

  /* Unknown: not connected, or the management handshake is still running. */
  state.connected = false;
  assert.equal(wifiMutationAllowed(), true);
  state.connected = true;
  assert.equal(wifiMutationAllowed(), true);

  /* Known and changeable. */
  state.mgmtReady = true;
  state.mgmtCapabilities = WIFI | ASYNC;
  assert.equal(wifiMutationAllowed(), true);

  /* Known and query-only: WiFi advertised, async events absent. */
  state.mgmtCapabilities = WIFI;
  assert.equal(wifiMutationAllowed(), false);

  /* LAN links never configure the board over management. */
  state.mode = "ws";
  state.mgmtCapabilities = 0;
  assert.equal(wifiMutationAllowed(), true);
});

test("legacy NUS firmware hides the management-driven features instead of leaving them unknown", () => {
  const unmanagedFeatureValue = loadFunction(
    "unmanagedFeatureValue",
    [],
    [],
  );
  /* Connected over BLE, handshake finished without a management service. */
  assert.equal(unmanagedFeatureValue(true, false, false), false);
  /* Handshake still running: keep the controls, the answer is unknown. */
  assert.equal(unmanagedFeatureValue(true, false, true), null);
  /* LAN link: no management channel by design, not a missing capability. */
  assert.equal(unmanagedFeatureValue(true, true, false), null);
  /* Disconnected. */
  assert.equal(unmanagedFeatureValue(false, false, false), null);
});

test("the undocumented bit-6 branch is gone and the documented map is followed", () => {
  assert.equal(appSource.includes("MGMT_CAP_PREFER_NUS"), false);
  assert.equal(appSource.includes("preferNus"), false);
  /* Reliable UART (bit 5) is the only advertised transport requirement. */
  const subscribe = appSource.indexOf("const available = hasManagementCapability(MGMT_CAP_RELIABLE_UART);");
  assert.notEqual(subscribe, -1);
  assert.match(
    appSource,
    /if \(!hasManagementCapability\(MGMT_CAP_RELIABLE_UART\)\) \{\n\s+throw new Error\("Device does not advertise a UART transport"\);/,
  );
});
