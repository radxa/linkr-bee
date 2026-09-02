import assert from "node:assert/strict";
import test from "node:test";

import {
  MGMT_FLAG_ERROR,
  ManagementResponseTracker,
} from "../../web/management_protocol.js";

test("management request resolves only for its matching response", async () => {
  const tracker = new ManagementResponseTracker(100);
  const response = tracker.wait(42);

  assert.equal(
    tracker.settle({ type: 3, requestId: 42, flags: 0, text: "event" }),
    false,
  );
  assert.equal(
    tracker.settle({ type: 2, requestId: 7, flags: 0, text: "OK other" }),
    false,
  );
  assert.equal(
    tracker.settle({ type: 2, requestId: 42, flags: 1, text: "OK uart" }),
    true,
  );
  assert.equal((await response).requestId, 42);
});

test("management error response rejects the request", async () => {
  const tracker = new ManagementResponseTracker(100);
  const response = tracker.wait(3);

  tracker.settle({
    type: 2,
    requestId: 3,
    flags: MGMT_FLAG_ERROR,
    text: "ERR invalid UART",
  });

  await assert.rejects(response, /ERR invalid UART/);
});

test("management requests reject on timeout and disconnect", async () => {
  const tracker = new ManagementResponseTracker(5);
  await assert.rejects(tracker.wait(9), /timed out/);

  const disconnected = tracker.wait(10);
  tracker.rejectAll(new Error("Disconnected"));
  await assert.rejects(disconnected, /Disconnected/);
});
