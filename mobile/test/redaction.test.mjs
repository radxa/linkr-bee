import assert from "node:assert/strict";
import test from "node:test";
import { redactSecretText, redactTaskText, secretValuesIn } from "../../web/agent_tasks.js";
import { buildTaskReport } from "../../web/agent_report.js";
import { createMcpHost, redactToolArguments } from "../../web/mcp_server.js";

/* The review's M8 finding: a credential can reach a task summary, the exported
 * Markdown report or the MCP audit list in shapes the old `key=value` pattern
 * did not cover — a JSON pair, a curl credential flag, an Authorization header.
 * Redaction is pattern-based and therefore best effort; these cases pin the
 * shapes that must never survive. */

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

test("the review's reproduction cases are redacted", () => {
  const json = redactTaskText('{"apiKey":"秘密"}');
  assert.doesNotMatch(json, /秘密/);
  assert.match(json, /"apiKey":"\[redacted\]"/);

  const curl = redactTaskText("curl -u alice:hunter2 https://h/p");
  assert.doesNotMatch(curl, /hunter2/);
  assert.match(curl, /-u \[redacted\]/);

  assert.equal(redactTaskText("password=abc123"), "password=[redacted]");
  /* The behaviour that already worked stays byte-identical for callers. */
  assert.equal(redactTaskText("token=secret-value"), "token=[redacted]");
});

test("structured shapes are covered: JSON keys, key: value, key=value and Authorization", () => {
  for (const [input, secret] of [
    ['{"password": "hunter2", "user": "radxa"}', "hunter2"],
    ["{'token': 'abc123'}", "abc123"],
    ["password: hunter2", "hunter2"],
    ["api_key=abcdef", "abcdef"],
    ["Authorization: Bearer abc.def-123", "abc.def-123"],
    ['{"secret": "s3cr3t-value"}', "s3cr3t-value"],
  ]) {
    const redacted = redactTaskText(input);
    assert.ok(!redacted.includes(secret), `${input} -> ${redacted}`);
    assert.match(redacted, /redacted/);
  }
  /* curl and wget accept the credential flag with either separator. */
  for (const input of ["curl -u alice:hunter2 https://h/p", "wget --user=alice:hunter2 https://h/p"]) {
    assert.doesNotMatch(redactTaskText(input), /hunter2/, input);
  }
  /* Unrelated text keeps its shape. */
  assert.equal(redactTaskText("The password prompt appeared at 115200 baud.").includes("password prompt"), true);
});

test("URLs lose userinfo, query and fragment", () => {
  const redacted = redactTaskText("fetch http://user:pw@host/x?token=abc#frag failed");
  assert.doesNotMatch(redacted, /pw/);
  assert.doesNotMatch(redacted, /token=abc/);
  assert.match(redacted, /http:\/\/host\/x/);
});

test("known secret values are removed wherever they appear", () => {
  assert.equal(secretValuesIn("curl -u alice:hunter2 https://h/p token=abc123 Bearer xyz").length >= 3, true);
  assert.equal(redactTaskText("console said s3cr3t twice s3cr3t", ["s3cr3t"]), "console said [redacted] twice [redacted]");
  /* A too-short value would destroy unrelated text without protecting it. */
  assert.equal(redactTaskText("a short value stays", ["a"]), "a short value stays");
  assert.equal(redactSecretText("Bearer abcdef"), "Bearer [redacted]");
});

test("the exported report never carries a credential", () => {
  const report = buildTaskReport({
    lang: "en",
    device: "target:abc",
    task: {
      goal: 'read {"apiKey":"秘密"} from the notes',
      summary: "curl -u alice:hunter2 https://h/p returned 401",
      plan: [{ title: "Check password=hunter2", status: "pending" }],
    },
    records: [{ id: "serial-1", payload: "curl -u alice:hunter2 https://h/p\r", evidence: "password: hunter2\r\n" }],
    notes: [{ text: "api_key=abcdef" }],
    secrets: ["known-token-12345"],
  });
  for (const secret of ["秘密", "hunter2", "abcdef", "known-token-12345"]) {
    assert.ok(!report.includes(secret), secret);
  }
  assert.match(report, /# Linkr Bee diagnostic report/);
  assert.match(report, /redacted/);
});

test("MCP tool arguments are redacted by key and by value without mutating the caller's object", () => {
  const wifi = { action: "connect", ssid: "Bench", password: "secret" };
  assert.equal(redactToolArguments("set_wifi", wifi).password, "<redacted>");
  assert.equal(redactToolArguments("set_wifi", wifi).ssid, "Bench");
  assert.equal(wifi.password, "secret");

  assert.equal(
    redactToolArguments("set_webdav", { action: "on", url: "http://user:pass@host/dav/" }).url,
    "http://<redacted>@host/dav/",
  );

  /* A credential inside ordinary text is not named by its key: the value pass
   * has to recognise the shape. */
  assert.equal(
    redactToolArguments("send_serial_input", { text: "curl -u alice:hunter2 https://h/p", appendEnter: true }).text,
    "curl -u [redacted] https://h/p",
  );
  assert.equal(
    redactToolArguments("send_serial_input", { text: '{"apiKey":"秘密"}', appendEnter: true }).text,
    '{"apiKey":"[redacted]"}',
  );
  assert.deepEqual(redactToolArguments("x", null), {});
});

test("a credential that arrived in an argument does not come back through the audit list or a tool result", async () => {
  const device = {
    getStatus: () => ({ connected: true, sessionId: "s1", transport: "ble", device: "Bee", deviceId: "id" }),
    async execute() {
      /* The console may echo the command back as ordinary output. */
      return { id: "serial-1", delivery: "sent", executionStatus: "unknown",
        evidence: "echo: curl -u alice:hunter2 https://h/p" };
    },
    inspectExecution: () => null,
    observe() {},
  };
  const host = createMcpHost({
    getBridge: () => null,
    storage: memoryStorage(),
    getDevice: () => device,
    readLog: () => ({ text: "", start: 0, cursor: 0, latestCursor: 0, truncated: false }),
    requestApproval: async () => ({ approved: true }),
    getLang: () => "en",
    onChange: () => {},
  });
  const response = await host.handleRpc(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "send_serial_input", arguments: { text: "curl -u alice:hunter2 https://h/p", appendEnter: true } },
  }));
  const payload = JSON.parse(JSON.parse(response.body).result.content[0].text);
  assert.doesNotMatch(payload.evidence, /hunter2/);
  assert.doesNotMatch(JSON.stringify(host.getAudit()), /hunter2/);
});
