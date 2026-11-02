# A2A: the resident Linkr agent

The Android app can host a resident AI assistant and expose it to other agents
over the [Agent2Agent (A2A) protocol](https://a2a-protocol.org/). This is the
agent-to-agent half of the app's automation: an external agent delegates a task
instead of driving the serial console tool by tool. The MCP server covers the
tool half; both run on the same app, port and bearer token.

> Status: implemented and covered by host-JVM, JavaScript and browser tests. The
> 2026-11-02 review round re-ran them (host-JVM MCP transport 45/45, mobile
> `node --test` 642/642, MCP Playwright 32/32, full Playwright 460/460, web /
> HarmonyOS / Android builds green) and fixed the A2A conformance issues
> described below. The JS changes are covered by the node and browser suites;
> the review-round native changes (notification unlock requirement, native
> approval expiry, `autoStart` persistence, epoch guards, 20-second deadline) are
> host-JVM/build verified only and were **not** re-run on a phone. The 2026-10-29
> phone results describe the earlier build, and a real-phone re-check is pending.
>
> On a real phone (2026-10-29, Android 16, earlier build): the agent card was
> served over LAN, `SendMessage` showed the task-start approval card, the resident
> task ran against a mock OpenAI-compatible endpoint and returned
> `TASK_STATE_COMPLETED` with an artifact; `GetTask`/`ListTasks` and the MCP
> `start_agent_task` path were also exercised. The target board was not connected
> during that run (it advertised a new BLE address that needs GPIO1 pairing), so
> the resident agent's device tools were not exercised on hardware. One
> background-approval attempt let the task complete but the blocking HTTP response
> was lost; retrying with the same `messageId` now returns the existing task, and
> background callers should still prefer `returnImmediately:true` plus
> `GetTask`.

## Prerequisites

1. The Linkr Bee app is running with **Allow AI clients on this network**
   enabled (MCP server). The A2A endpoint shares that listener and token.
2. The app has usable AI settings. A board-stored configuration is **not** used
   automatically: the user must first load it into the app's AI settings
   (AI → board configuration → **Load from board**). Without saved settings the
   agent answers `get_agent_status` with `available:false` and refuses tasks.
3. The phone owner is reachable for the task-start approval unless the access
   mode runs `start_agent_task` directly (fully authorized). In every mode the
   resident task's sensitive calls still ask per call; see
   [Approval and task execution](#approval-and-task-execution).

## Discovery

| What | URL |
| --- | --- |
| Agent card | `http://<phone-ip>:8712/.well-known/agent-card.json` |
| JSON-RPC endpoint | `http://<phone-ip>:8712/a2a` |
| Status JSON | `http://<phone-ip>:8712/` |
| Auth | `Authorization: Bearer <the MCP token>` on `/a2a` |

The card and the status JSON are public (they carry no secret); the card is
served only while the server is enabled and answers `404` otherwise. Clients get
the token from the app's MCP settings card, exactly as for MCP.

The endpoint shares the MCP listener and its limits: HTTP/1.0 or HTTP/1.1, one
request per connection, a 20-second deadline for the request line, headers and
body (`408 Request Timeout` when exceeded), and `417` for `Expect: 100-continue`.
`POST /a2a` needs the bearer token; `GET /a2a` returns `405`.

## Supported methods

The endpoint implements the A2A v1.0 JSON-RPC binding:

| Method | Result |
| --- | --- |
| `SendMessage` | `{"task": Task}`; starts a resident task after the task-start approval when the access mode asks for one |
| `GetTask` | `Task`; poll while the task runs |
| `ListTasks` | `{"tasks": [...], "nextPageToken": "...", "pageSize": n, "totalSize": n}` |
| `CancelTask` | `Task`; stops a queued or running task |
| `GetExtendedAgentCard` | the same agent card |

`SendMessage` accepts one or more text parts. Other part kinds (files, URLs,
structured data) are refused rather than silently dropped: the target is a
serial console, not a document store. When the access mode asks for approval,
the task-start approval is part of the HTTP request:
`configuration.returnImmediately` defaults to **false** (blocking), but it never
skips that approval. A blocking `SendMessage` waits for the phone's answer when
there is one and then for at most 30 seconds of task progress; it returns the
working task for polling instead of holding a serial task past any sane HTTP
timeout. With `returnImmediately:true` the call still runs that approval when the
mode asks for it, then returns the queued task immediately.

`message.messageId` is deduplicated through a bounded cache: retrying a
`SendMessage` whose response was lost returns the task that already exists
instead of asking the phone again or repeating physical work. The cache is
cleared when the server stops, restarts or is disabled.

Task continuation from a new message is **not** supported: a request whose
`message.taskId` names an existing task is refused with `-32004` and guidance to
send a new message with the same `contextId`.

`ListTasks` reads the retained, in-memory task list (at most 20 tasks), newest
first. It reports the matched `totalSize`, accepts `pageSize`, and pages with
`pageToken` (or the response's `nextPageToken`). Only `contextId` filtering is
implemented; other filters are ignored rather than echoed back as applied.

`CancelTask` cancels a queued or running task. A task that is already terminal
(completed, failed, canceled or rejected) returns `-32002 TASK_NOT_CANCELABLE`
instead of pretending to cancel it.

`SendStreamingMessage` and `SubscribeToTask` return `-32004
UNSUPPORTED_OPERATION` because the native transport answers one POST with one
body and does not hold SSE connections. The push-notification configuration
methods return `-32003 PUSH_NOTIFICATION_NOT_SUPPORTED`. A compliant client reads
`capabilities.streaming:false`/`pushNotifications:false` from the card and polls
`GetTask`.

### Error codes

JSON-RPC errors are returned inside an HTTP `200` response (the A2A binding);
authentication and transport failures use the HTTP status (`401`, `403`, `404`,
`405`, `408`, `413`, `417`, `503`, `504`).

| Code | Meaning |
| --- | --- |
| `-32001` | `TASK_NOT_FOUND` — `GetTask`/`CancelTask` was given an unknown task id |
| `-32002` | `TASK_NOT_CANCELABLE` — `CancelTask` on a task that is already terminal |
| `-32003` | `PUSH_NOTIFICATION_NOT_SUPPORTED` — every push-config method |
| `-32004` | `UNSUPPORTED_OPERATION` — streaming, `SubscribeToTask`, or `message.taskId` continuation |
| `-32010` | `SERVER_DISABLED` — the server is stopped or disabled |
| `-32011` | `READ_ONLY` — the phone is in read-only mode |
| `-32012` | `AGENT_NOT_CONFIGURED` — no usable AI configuration |
| `-32013` | `TASK_BUSY` — the in-app assistant is busy or the queue is full |
| `-32014` | `DENIED` — the phone denied the task approval, or the task was otherwise refused |
| `-32600`/`-32601`/`-32602`/`-32603`/`-32700` | standard JSON-RPC invalid request, method not found, invalid params, internal error and parse error |

### Example: start and poll

```sh
TOKEN=<64-hex token from the app>

curl -s -X POST http://192.168.1.42:8712/a2a \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"ROLE_USER","parts":[{"text":"Check the target kernel version and report the uptime."}],"messageId":"msg-1","contextId":"bench-1"}}}'

curl -s -X POST http://192.168.1.42:8712/a2a \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"GetTask","params":{"id":"<task id>"}}'
```

A completed task carries the assistant's answer as an artifact:

```json
{"jsonrpc":"2.0","id":2,"result":{
  "id":"agent-…","contextId":"bench-1",
  "status":{"state":"TASK_STATE_COMPLETED"},
  "artifacts":[{"artifactId":"artifact-…","name":"Linkr Bee resident agent answer",
                "parts":[{"text":"Kernel 6.1.0 …"}]}]
}}
```

## Approval and task execution

- `start_agent_task` / `SendMessage` carries the task-start approval when the
  access mode asks for one. It covers the task's **ordinary serial reads and
  writes** only. In `confirm` mode every task start asks; in `guarded` mode
  starting the resident agent is treated as high risk and asks; `auto` mode
  starts without a prompt; `read` mode refuses tasks.
- Inside the approved task, destructive or irreversible shell commands, commands
  on the target's always-ask list, WiFi scans, and the accessory changes the
  resident agent can make (bridge UART, accessory WiFi, WebDAV) **still ask on
  the phone per call**, through the same in-app card or notification as MCP.
  This applies in every access mode, including fully authorized. The resident run
  is told this authority explicitly; a denial means the action was not executed.
- The assistant still uses the app's executors, evidence rules and
  one-write-at-a-time gate. A second external write tool call while a task is
  active or queued is refused with a clear error.
- One task runs at a time; up to 8 wait in the queue. There is **no hard
  wall-clock limit by default**: a slow model or a target that takes minutes to
  boot must not be killed by a timer while it is making progress. Callers that
  want a deadline can set `metadata.timeoutMs` (up to 24 hours; 0 means none);
  `CancelTask` (MCP: `cancel_agent_task`) is the normal way to stop a long task.
  The assistant panel's Stop button cancels the active task and all queued tasks.
  The panel shows when resident work owns the executor and blocks local questions
  until it settles.
- Token rotation, an access-mode change, a port/listen-address change, disabling
  the server in the card, or pressing **Stop** on the foreground-service
  notification cancels pending approval requests and running or queued resident
  tasks. A2A approval is revoked on server shutdown or native request
  cancellation too.
- Approval surface: while the app is visible the request uses the in-app card.
  While it is hidden the request becomes a high-priority notification whose body
  is PRIVATE on the lock screen; **Allow**/**Deny** require the device to be
  unlocked, dismissing the notification counts as a denial, and the notification
  expires with the approval deadline. Tapping the body opens the app and re-shows
  the in-app card while the request is still pending.
- Each queued task is bound to the device/session approved at submission. A
  target switch or reconnect before execution fails the old task; submit a new
  task for the current target.
- Sessions: `contextId` (A2A) or `sessionId` (MCP) continues the same
  conversation. Omit it for the default session; use `newSession` (MCP) or a new
  `contextId` for a fresh one. Board-stored instructions are read once when a
  session starts, like a new conversation in the app. Changing the target
  resets that session's history because the old transcript is not evidence
  about the new console.
- Tasks live in the app process. Sending the app to the background is supported
  by its foreground service; killing the process ends the server and loses
  running tasks. Persistent task history is not implemented yet.

## Limitations

- **No wall-clock limit and no watchdog.** A resident task has no default
  deadline (only `metadata.timeoutMs` when the caller sets one). If the model
  provider stream hangs without events, the task keeps the device gate busy
  until someone calls `CancelTask` (`cancel_agent_task` in MCP) or taps Stop in
  the app. Nothing aborts it automatically.
- **One task at a time, eight queued.** Additional tasks wait in the queue; a
  full queue is `TASK_BUSY`. There is no parallelism and no cross-task priority.
- **No streaming or push.** The card advertises `streaming:false` and
  `pushNotifications:false`; progress is observed by polling `GetTask`.
- **In-memory tasks only.** At most 20 tasks are retained for `ListTasks` and
  `GetTask`, and none survive an app restart or process death.

## Security notes

- Anyone with the MCP token can start a resident task and spend the configured
  model's tokens. Treat the token like an API key; rotate it in the app when in
  doubt.
- The approval card shows only a short request preview. Review it before
  approving. The task's ordinary serial reads and writes are then covered, but
  destructive commands, always-ask commands, WiFi scans and accessory/bridge
  changes still ask per call.
- Notification approvals are gated on the device being unlocked; a locked screen
  cannot answer them. Dismissing the notification denies the waiting request,
  and it expires with the deadline.
- Assistant output is model output, not device evidence. It never includes the
  API key or custom headers; it can still be wrong. Verify device changes with
  the MCP read tools or the serial log.
- The agent card is public by design. It contains only names, descriptions and
  the interface URL; the provider/model are visible through the authenticated
  `get_agent_status` tool.
- Board-stored AI configuration is plaintext on the board. This guide does not
  change that: the app only uses such a configuration after the user explicitly
  loads it locally.

## MCP equivalent

The same resident agent is available to MCP clients without A2A:

| MCP tool | Purpose |
| --- | --- |
| `get_agent_status` | configuration summary, busy state, queue, recent tasks |
| `start_agent_task` | approve and queue a task (ordinary serial reads/writes only) |
| `get_agent_task` | poll one task (optional `waitMs`) |
| `list_agent_tasks` | recent tasks, optionally for one session |
| `cancel_agent_task` | stop a task |

See the [MCP server guide](MCP.md) for access modes, approval notifications and
the device tools the resident agent can use.
