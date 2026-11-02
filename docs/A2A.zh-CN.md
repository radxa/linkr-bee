# A2A：常驻 Linkr 助手

Android App 可以在本机托管一个常驻 AI 助手，并通过
[Agent2Agent（A2A）协议](https://a2a-protocol.org/) 把它开放给其他 agent。这是
agent-to-agent 的一半：外部 agent 委托任务，而不是逐个调用串口工具；另一半是现有
的 MCP 服务器。两者共用同一个 App、端口和 Bearer 令牌。

> 状态：协议、任务管理和传输已实现，并有主机 JVM、JavaScript 与浏览器测试覆盖。
> 2026-11-02 审阅轮重新运行了这些测试（主机 JVM MCP 传输 45/45、mobile
> `node --test` 642/642、MCP Playwright 32/32、完整 Playwright 460/460、
> Web / HarmonyOS / Android 构建全绿），并修复了下面列出的 A2A 一致性问题。JS 改动由
> node 与浏览器测试覆盖；本轮原生改动（通知解锁要求、原生确认过期、`autoStart`
> 持久化、epoch 守卫、20 秒期限）只有主机 JVM/构建验证，**未在真机上复跑**。
> 2026-10-29 的真机结果描述的是更早的构建，真机复测待完成。
>
> 真机验证（2026-10-29，Android 16，更早的构建）：局域网可拉取 agent card；
> `SendMessage` 弹出任务启动确认卡片后，常驻任务在手机上对 mock OpenAI 兼容端点执行并
> 返回 `TASK_STATE_COMPLETED` 与 artifact；`GetTask`/`ListTasks` 与 MCP
> `start_agent_task` 路径也验证过。该轮目标板未连接（板子广播了新地址，需要 GPIO1
> 配对），因此助手对目标串口的工具未在真机执行。一次后台确认尝试中任务完成但阻塞式
> HTTP 响应丢失；现在用相同 `messageId` 重试会返回既有任务，后台调用仍建议用
> `returnImmediately:true` + `GetTask` 轮询。

## 前提

1. Linkr Bee App 正在运行，且已开启 **允许局域网内的 AI 客户端连接**（MCP 服务）。
   A2A 端点共用同一个监听端口和令牌。
2. App 里有可用的 AI 配置。**板载 AI 配置不会自动使用**：用户必须先在 AI 设置里
   点 **从板载载入**，把配置写进本机设置。没有可用配置时，`get_agent_status` 返回
   `available:false`，任务会被拒绝。
3. 除非访问权限会直接执行 `start_agent_task`（完全授权），否则任务启动需要在手机上
   确认一次。无论哪种模式，常驻任务内的敏感调用仍会逐次确认；见
   [确认与任务执行](#确认与任务执行)。

## 发现

| 内容 | 地址 |
| --- | --- |
| Agent Card | `http://<手机 IP>:8712/.well-known/agent-card.json` |
| JSON-RPC 端点 | `http://<手机 IP>:8712/a2a` |
| 状态 JSON | `http://<手机 IP>:8712/` |
| 鉴权 | `/a2a` 请求带 `Authorization: Bearer <MCP 令牌>` |

Agent Card 与状态 JSON 是公开的（不含密钥）；card 只在服务器启用期间提供，否则返回
`404`。客户端从 App 的 MCP 设置卡片获取令牌，与 MCP 相同。

该端点共用 MCP 的监听器与限制：HTTP/1.0 或 HTTP/1.1、每个连接一个请求、请求行/头/体
共用 20 秒期限（超过返回 `408 Request Timeout`）、`Expect: 100-continue` 返回 `417`。
`POST /a2a` 需要 Bearer 令牌；`GET /a2a` 返回 `405`。

## 支持的方法

实现 A2A v1.0 JSON-RPC 绑定：

| 方法 | 结果 |
| --- | --- |
| `SendMessage` | `{"task": Task}`；在访问权限要求确认时，完成一次任务启动确认后启动常驻任务 |
| `GetTask` | `Task`；任务运行期间轮询 |
| `ListTasks` | `{"tasks": [...], "nextPageToken": "...", "pageSize": n, "totalSize": n}` |
| `CancelTask` | `Task`；取消排队或运行中的任务 |
| `GetExtendedAgentCard` | 与公开 card 相同 |

`SendMessage` 只接受文本 part；文件、URL、结构化数据会被明确拒绝而不是静默丢弃，
因为目标是串口控制台，不是文档仓库。访问权限要求确认时，任务启动确认是 HTTP 请求的
一部分：`configuration.returnImmediately` 默认为 **false**（阻塞），但不会跳过该确认。
阻塞式 `SendMessage` 先等待手机确认（如果有），再最多等待任务推进 30 秒；超时则返回
运行中的 task 让客户端继续轮询，而不是让串口任务拖过任何合理的 HTTP 超时。设
`returnImmediately:true` 时，调用仍会执行该确认（当模式要求时），然后立即返回排队中的
task。

`message.messageId` 通过有界缓存去重：响应丢失后重试 `SendMessage` 会返回已经存在的
任务，而不是再次询问手机或重复执行物理操作。服务器停止、重启或被关闭时清空该缓存。

**不支持**通过新消息续接旧任务：若 `message.taskId` 指向已有任务，请求会以 `-32004`
拒绝，并提示改用相同 `contextId` 发送新消息。

`ListTasks` 读取内存中保留的任务列表（最多 20 条，最新在前），返回匹配的 `totalSize`，
接受 `pageSize`，并可用 `pageToken`（或响应里的 `nextPageToken`）翻页。只实现了
`contextId` 过滤；其他过滤条件会被忽略，而不是假装已应用。

`CancelTask` 取消排队或运行中的任务。对已经处于终态（completed、failed、canceled 或
rejected）的任务返回 `-32002 TASK_NOT_CANCELABLE`，而不是假装取消成功。

`SendStreamingMessage` / `SubscribeToTask` 返回 `-32004 UNSUPPORTED_OPERATION`：
原生传输是“一个 POST 一个响应”，不保持 SSE 长连接。推送通知配置方法返回
`-32003 PUSH_NOTIFICATION_NOT_SUPPORTED`。符合规范的客户端会从 card 读到
`capabilities.streaming:false`/`pushNotifications:false`，改用 `GetTask` 轮询。

### 错误码

JSON-RPC 错误放在 HTTP `200` 响应内（A2A 绑定）；鉴权与传输失败使用 HTTP 状态码
（`401`、`403`、`404`、`405`、`408`、`413`、`417`、`503`、`504`）。

| 错误码 | 含义 |
| --- | --- |
| `-32001` | `TASK_NOT_FOUND`——`GetTask`/`CancelTask` 收到未知任务 id |
| `-32002` | `TASK_NOT_CANCELABLE`——对已处于终态的任务调用 `CancelTask` |
| `-32003` | `PUSH_NOTIFICATION_NOT_SUPPORTED`——所有推送配置方法 |
| `-32004` | `UNSUPPORTED_OPERATION`——流式、`SubscribeToTask` 或 `message.taskId` 续任务 |
| `-32010` | `SERVER_DISABLED`——服务器已停止或关闭 |
| `-32011` | `READ_ONLY`——手机处于只读模式 |
| `-32012` | `AGENT_NOT_CONFIGURED`——没有可用的 AI 配置 |
| `-32013` | `TASK_BUSY`——App 内助手忙碌或队列已满 |
| `-32014` | `DENIED`——手机拒绝了任务确认，或任务被其他原因拒绝 |
| `-32600`/`-32601`/`-32602`/`-32603`/`-32700` | JSON-RPC 标准的无效请求、方法不存在、参数无效、内部错误与解析错误 |

### 示例：启动并轮询

```sh
TOKEN=<App 里的 64 个十六进制字符令牌>

curl -s -X POST http://192.168.1.42:8712/a2a \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"ROLE_USER","parts":[{"text":"检查目标内核版本并报告 uptime。"}],"messageId":"msg-1","contextId":"bench-1"}}}'

curl -s -X POST http://192.168.1.42:8712/a2a \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"GetTask","params":{"id":"<task id>"}}'
```

完成的任务把助手答复放在 artifact 里：

```json
{"jsonrpc":"2.0","id":2,"result":{
  "id":"agent-…","contextId":"bench-1",
  "status":{"state":"TASK_STATE_COMPLETED"},
  "artifacts":[{"artifactId":"artifact-…","name":"Linkr Bee resident agent answer",
                "parts":[{"text":"Kernel 6.1.0 …"}]}]
}}
```

## 确认与任务执行

- `start_agent_task` / `SendMessage` 在访问权限要求确认时承载任务启动确认，只覆盖任务内
  **普通的串口读写**。`confirm` 模式下每次任务启动都会确认；`guarded` 模式把启动常驻
  agent 视为高危并确认；`auto` 模式不弹确认直接启动；`read` 模式拒绝任务。
- 任务内，破坏性或不可逆的 shell 命令、目标机 always-ask 命令、WiFi 扫描，以及常驻
  助手能做的配件变更（桥接 UART、配件 WiFi、WebDAV）**仍会逐次在手机上确认**，使用
  与 MCP 相同的应用内卡片或通知。这条规则适用于所有访问权限，包括完全授权。常驻运行
  会明确收到这一授权范围；拒绝即表示该操作未执行。
- 助手仍走 App 原有执行器、证据纪律和单写入闸门。任务运行中或有排队任务时，外部 MCP
  的写工具会被明确拒绝，避免争抢串口。
- 同时只运行一个任务，最多 8 个排队。默认**没有墙钟硬超时**：模型慢、目标启动要
  几分钟时，不应因为计时器到点而中断正在推进的任务。需要期限的调用方可在
  `metadata.timeoutMs` 里设置（最长 24 小时，0 表示不设）；停止长任务的正常方式是
  `CancelTask`（MCP：`cancel_agent_task`）。助手面板的“停止”会取消当前及所有排队
  任务。常驻任务执行时显示状态，并阻止页面助手同时提交；任务退出后恢复。
- 轮换令牌、修改访问权限、修改端口/监听地址、在卡片里关闭服务器，或按前台服务通知上的
  **Stop**，都会取消等待中的确认请求以及运行中/排队的常驻任务。服务器关闭或原生请求
  取消同样会撤销 A2A 确认。
- 确认界面：App 可见时使用应用内卡片；App 不可见时改为高优先级通知，锁屏上正文为
  私密显示。**允许**/**拒绝** 都要求设备已解锁，划掉通知视为拒绝，通知随确认期限到期
  而失效。点击通知正文会打开 App，并在请求仍等待时重新显示应用内卡片。
- 排队任务绑定提交时批准的设备与连接会话；执行前换机或重连会令旧任务失败，需要针对
  当前设备重新提交。
- 会话：A2A 的 `contextId`（MCP 的 `sessionId`）续聊同一会话；省略则用默认会话，
  MCP 的 `newSession:true` 或新的 `contextId` 开新会话。板载提示词在会话开始时读取一次，
  与 App 内新对话一致。切换目标会重置该会话历史，因为旧记录不能作为新控制台的证据。
- 任务只活在 App 进程内：退到后台由前台服务维持；进程被杀则服务停止、运行中的任务丢失。
  任务历史持久化尚未实现。

## 限制

- **没有墙钟上限，也没有看门狗。** 常驻任务默认没有期限（只有调用方设置
  `metadata.timeoutMs` 时才有）。如果模型提供方的流一直挂起、不产生任何事件，任务会
  持续占用设备闸门，直到有人调用 `CancelTask`（MCP 的 `cancel_agent_task`）或在 App
  里点停止。没有任何机制会自动中止它。
- **一次只运行一个任务，最多 8 个排队。** 其余任务在队列等待；队列满时返回
  `TASK_BUSY`。没有并行执行，也没有跨任务优先级。
- **不支持流式与推送。** card 声明 `streaming:false` 与 `pushNotifications:false`；
  进度通过轮询 `GetTask` 观察。
- **任务只在内存中。** `ListTasks` 与 `GetTask` 最多保留 20 条任务，App 重启或进程
  被杀后全部丢失。

## 安全说明

- 持有 MCP 令牌的人可以启动常驻任务并消耗所配置模型的 token。请像对待 API Key 一样
  保管令牌；有疑问时在 App 里轮换。
- 确认卡片只显示请求的简短预览。请先看清再批准。任务内普通的串口读写随后由该确认
  覆盖，但破坏性命令、always-ask 命令、WiFi 扫描与配件/桥接变更仍会逐次确认。
- 通知确认要求设备已解锁；锁屏不能回答。划掉通知会拒绝等待中的请求，通知也会随期限
  失效。
- 助手输出是模型输出，不是设备证据；不会包含 API Key 或自定义请求头，但可能出错。
  设备变更请用 MCP 读工具或串口日志复核。
- Agent Card 是公开的，但只含名称、描述和接口地址，不含 provider/model；这些信息通过
  鉴权的 `get_agent_status` 查看。
- 板载 AI 配置在板子上是明文，本功能不改变这一点；只有用户显式载入本机后才会被使用。

## MCP 等价入口

不接 A2A 的 MCP 客户端也能使用同一个常驻助手：

| MCP 工具 | 作用 |
| --- | --- |
| `get_agent_status` | 配置摘要、忙碌状态、队列、最近任务 |
| `start_agent_task` | 确认并排队一个任务（只覆盖普通串口读写） |
| `get_agent_task` | 轮询单个任务（可选 `waitMs`） |
| `list_agent_tasks` | 最近任务，可按会话过滤 |
| `cancel_agent_task` | 取消任务 |

访问模式、确认通知和设备工具见 [MCP 服务器指南](MCP.zh-CN.md)。
