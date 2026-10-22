# Agent 能力边界与演进计划

本文记录 AI（Agent）功能当前的能力边界、已确认的缺口和排期。实机验收记录见
[AGENT_VALIDATION.zh-CN.md](AGENT_VALIDATION.zh-CN.md)。

## 初始能力基线（后续变更见各期记录）

- **工具**：17 个，全部面向目标机与证据——计划（`update_task_plan`）、探测
  （`probe_tools` / `probe_device_profile` / `probe_download_tools`）、执行
  （`run_shell_command` / `send_serial_input`）、观察（`inspect_serial_execution` /
  `monitor_serial_execution` / `wait_for_serial_output`）、证据
  （`read_serial_log` / `search_serial_log` / `get_device_status`）、下载
  （`download_to_target` / `download_to_computer`）、校验
  （`verify_target_file` / `verify_target_service`）、网页（`read_web_page`）。
  定义见 `mobile/src/pi-agent.mjs`。校验工具是唯一由应用而非模型下结论的一组，
  见第五期。
- **执行策略**：手动 / 自动 / Full Auto 三档，破坏性命令在任何档位都要人工确认；
  精确白名单加位置感知的命令边界匹配，见 `web/agent_execution_policy.js`。
- **证据纪律**：工具描述与系统提示反复要求"发送成功不等于命令完成"、退出码不等于
  目标达成、恢复后先读状态再行动、不重放历史命令。
- **记忆**：任务摘要最多 20 条（按设备隔离、脱敏后存 localStorage，见
  `web/agent_tasks.js`）；设备档案与工具可用性只在本次连接内有效，重连即清。
- **模型**：单一 OpenAI 兼容 chat completions；上下文窗口、输出上限、推理档位、
  成本费率均写死（`mobile/src/pi-agent.mjs`）。预算为每问 32 轮、96 次工具调用、
  15 分钟。

## 初期的三个结构性缺口

1. **桌面 Web 用不上**：`web/agent_runtime.js` 原本是硬关闭的桩，只有 Vite /
   Capacitor / ArkWeb 构建会替换它。而桌面 Chrome 是主要使用场景。
2. **工具够不到配件自身**：没有工具能改 UART 参数、扫/连 WiFi、配 WebDAV、读
   `@i?` 诊断、轮换 LAN 令牌或重启配件。这类诉求目前只能由用户操作面板。
3. **记忆与成本不可见**：档案不跨连接、对话不跨刷新、执行记录仅内存且上限 50；
   token 用量没有展示，成本费率恒为 0。

## 第一期：桌面 Web 可用（已完成）

- 用 esbuild 把 `mobile/src/agent-runtime.mjs` 打成浏览器可加载的 ESM 包，提交到
  `web/vendor/agent/`，与 xterm、marked、DOMPurify 的 vendor 方式一致；
  `web/agent_runtime.js` 改为按需动态加载该 bundle。
- 静态入口不需要 npm、不需要构建即可使用助手；Vite / Capacitor / ArkWeb 构建仍走
  原有别名，行为不变。
- 浏览器直连模型端点需要端点接受页面来源。2026-09 用 `OPTIONS` 预检从
  `http://127.0.0.1:8765` 实测：DeepSeek、OpenAI、Moonshot、智谱、SiliconFlow、
  Gemini、OpenRouter 都返回 `access-control-allow-origin`，可直接使用；Anthropic
  需要附加请求头 `anthropic-dangerous-direct-browser-access: true`；Groq 拒绝浏览器
  来源，这类端点才需要代理。端点拒绝时给出可读的浏览器侧原因。
- 验收：静态入口（`tools/serve_web.sh`）出现助手入口并能完成一次"提问 → 工具调用
  → 回答"；vendor 包与依赖版本一致，且有测试覆盖；纯 Web 路径不再零测试。

实现说明（2026-09-12）：

- `tools/build_agent_bundle.sh` 生成 `web/vendor/agent/{agent-runtime.js,
  LICENSES.txt,BUILD.json}`；`web/agent_runtime.js` 改为按需加载该 bundle。
- `mobile/test/agent_bundle.test.mjs` 校验摘要、浏览器可加载性、依赖版本一致性和
  导出符号；`mobile/browser-test/static_agent.spec.mjs` 在静态服务上验证助手入口、
  一次完整的模拟模型问答，以及端点不可达时的浏览器侧提示。
- `mobile/browser-test/static-server.mjs` 为静态路径提供无日志的测试服务器。
- 仍未覆盖：真实模型端点的 CORS 行为、云端厂商需要代理这一前提，只能由用户环境
  验证；`read_web_page` 的浏览器跨域限制同样如此。

## 第二期：配件管理工具组（已完成）

复用已有的管理通道（面板向 Agent 注入的 `sendControl`，与目标绑定同一条路径），
新增受审批约束的工具：

| 工具 | 作用 | 审批 |
| --- | --- | --- |
| `get_accessory_diagnostics` | 读 `@i?`：固件、UART 缓冲、WiFi、上传队列、桥接状态 | 只读，免审批 |
| `set_uart_config` | 改波特率 / 数据位 / 校验 / 停止位 / 流控 | 需审批 |
| `wifi_scan` / `wifi_connect` | 扫描并连接 2.4 GHz 网络 | 需审批，凭据只走 BLE |
| `set_webdav_target` | 配置或关闭 WebDAV 上传目标 | 需审批 |
| `reboot_accessory` | 重启配件 | 需审批，列入破坏性命令 |

验收：每个工具都要有单元测试（含被拒绝的路径），并证明工具结果可被模型引用为证据
（不是"已设置"这类无证据回执）。

实现说明（2026-09-12）：

- 实际交付 5 个工具：`get_accessory_diagnostics`、`set_uart_config`、`wifi_scan`、
  `set_wifi`（`action=connect|off`）、`set_webdav`（`action=on|off`）。协议、校验与
  回复解析在 `web/accessory_control.js`；命令发送与回读在 `web/app.js`；审批卡片
  在面板里，复用工具行。
- **`reboot_accessory` 取消**：固件没有配件重启命令（面板里的 `reboot` 预设是发给
  目标机 Shell 的）。要做需要先加 `@linkr reboot` 一类的命令。
- 除诊断外每个动作在每个执行档位都需要一次人工批准；结果由"命令回复 + 随后回读"
  组成，`applied=false` 表示配件没有报告目标值。
- WiFi 密码只经蓝牙管理通道发送，不进入工具结果、任务记录或审批卡片（用户自己
  输入的问题文本仍按原样保留）。
- AI 设置新增"附加请求头"字段（每行一个 `名称: 值`，最多 8 条），用于 Anthropic
  这类需要特殊请求头的端点；名称与值都做了校验，存储记录无法借此注入新请求行。
  相关测试：`mobile/test/agent_config.test.mjs`、
  `mobile/test/serial_agent.test.mjs`（请求头确实发给 provider）、
  `mobile/browser-test/agent_settings.spec.mjs`（保存、非法输入、实际请求携带）。
- 测试：`mobile/test/accessory_control.test.mjs`（协议与校验）、
  `mobile/test/accessory_tools.test.mjs`（工具注入与拒绝路径）、
  `mobile/browser-test/accessory.spec.mjs`（审批、拒绝、密码不外泄）。
- 仍未覆盖：真机上的 WiFi 连接与 WebDAV 上传（沿用固件侧的实机验收清单），以及
  非 BLE 传输下的行为（局域网模式下工具会明确拒绝）。

## 第三期：记忆与成本可见（已完成）

- 按目标 UUID 持久化"设备笔记"：已知怪癖、正确 UART 参数、启动行为、已装工具，
  与当前仅在内存中的档案区分（观测值仍要标时间与新鲜度）。
- 展示 token 用量与估算成本：SDK 在每条 assistant 消息上返回 `Usage`，需要按端点
  配置费率或允许用户留空。
- 执行记录导出：把命令、退出码、证据片段导出为报告，供现场排障留档。

实现说明（2026-09-12）：

- **设备笔记**（`web/agent_notes.js`）：按 `deviceIdentity` 归档，每台最多 12 条、每条
  600 字符，与任务摘要用同一套脱敏；重复内容不重复写入，超出上限淘汰最旧的一条。
  模型通过 `remember_target_note` 写入，必须附一条支撑它的观察；笔记经
  `get_device_status.notes` 回到模型，并在面板历史区列出，用户可逐条删除。
- **token 与费用**（`web/agent_usage.js`）：累计每条 assistant 消息的 `Usage`
  （含缓存命中），会话内显示输入/输出/缓存与总量；AI 设置里的单价（每 100 万
  token，可选）**单独存储**，因此改价格不会重启正在进行的对话，未填单价时只显示
  token 数。
- **报告导出**（`web/agent_report.js`）：把目标、计划、串口执行记录（命令、投递、
  退出码、证据片段）与设备笔记导出为 Markdown，同样脱敏并限长，结尾明确"退出码与
  助手结论不等于目标达成"。
- 测试：`mobile/test/agent_notes.test.mjs`、`agent_usage.test.mjs`、
  `agent_report.test.mjs`，以及 `mobile/browser-test/agent_memory.spec.mjs`（笔记写入
  → 回到模型 → 列表 → 删除；用量与费用显示；单价校验与保存；导出文件内容）。

## 治理（已完成）

- **Full Auto 时间盒**：切换到 Full Auto 后 15 分钟自动回退到 Auto，倒计时显示在档位
  标签上（`Full Auto · 12:34`），再次选择 Full Auto 即为延长；到时会取消尚未确认的
  输入，并在状态行说明"后续命令需要确认"。时限判定放在 `web/device_executor.js`
  而不是界面里，任何界面路径都无法让该档位一直挂着手动放行。
- **按目标机的命令策略**（`web/command_policy.js`，面板历史区可编辑）：
  - *总是询问*：命中即要求确认，**包括 Full Auto**；按线缆文本做不区分大小写的子串
    匹配，因此被改写成 `sh -c '…'` 的追踪命令也逃不掉。
  - *已预先批准*：只有与条目**完全相同**的命令、且 Auto 档、且输入行为空、且以单个
    回车结尾时才免确认——与内置低风险查询列表同一套条件；无法绕过破坏性命令守卫。
  - 策略只存在本机，不进入模型请求，也不会写进导出的报告；`get_device_status.commandPolicy`
    只把"已预先批准列表 + 总是询问条数"给模型，便于它选择合适的命令形式并提前说明
    需要确认。
- 测试：`mobile/test/command_policy.test.mjs`（匹配与存储）、
  `device_executor.test.mjs` 新增的时限用例（到时回退、取消待确认、重新选择延长）、
  `mobile/browser-test/agent_governance.spec.mjs`（倒计时与延长、总是询问在 Full Auto
  下仍要确认、预先批准在 Auto 下免确认）。

## 第四期：候选池（已完成）

- **多 provider 与采样参数**：AI 设置里可选 `openai-completions` / `anthropic-messages`
  / `google-generative-ai`，并可直接填 `contextWindow`、`maxTokens`、推理档位
  （`off`/`low`/`medium`/`high`）；档位由 SDK 适配器翻译成各家的请求字段（OpenAI 系
  `reasoning_effort`、Anthropic 的 thinking 预算、Gemini 的 `thinking.level` 或
  `budgetTokens`），`off` 完全不发该字段。适配器随打包一起进 bundle，代价是体积从
  488 KB 涨到 979 KB（min，gzip 252 KB）；bundle 仍是按需加载，不影响终端首屏。
  留空即为各 provider 的默认值，服务端不接受某个字段时把该字段留空即可。
- **工具执行语义**：`toolExecution: "parallel"` 让只读工具并行发请求，17 个会改变设备
  状态或占用控制台的工具都单独标了 `executionMode: "sequential"`——并行的收益不该换来
  两条命令交错写进同一个串口。`afterToolCall` 把超过 16000 字符的文本结果截断并注明，
  避免一次 `cat` 把上下文冲掉。
- **动态工具**：`read_target_file` 在探测到目标机具备 `dd` 或 `base64` 之前不暴露给
  模型（`unlockTools` + `prepareNextTurnWithContext`，同一轮内解锁即可用），省掉反复
  调用不存在工具的死循环。
- **目标机文件读取**（`web/target_files.js`）：按行分页读取，默认一次 1 KB、用
  `LINKR_FILE:begin/end` 整行标记包裹，因此不会被 shell 提示符或回显污染；缺失、是目录、
  非绝对路径、无权限、非普通文件分别给出不同的错误标记，让模型能区分"文件不存在"和
  "命令没跑完"。上传方向的命令构造与进度解析已经写好（`uploadPlan` /
  `uploadChunkCommand` / `parseUploadResult`），但面板还没有选择文件与按计划一次审批的
  交互，因此**尚未接入工具**。
- **串口观察**（`web/serial_watch.js`）：`watch_serial_output` 在等待窗口里按行匹配崩溃
  与启动循环特征，返回带偏移的证据行而不是整段日志。它只在模型主动调用时运行，即
  "这一轮里多看一会儿"，不是无人值守的后台监控。
- **会话持久化**（`web/agent_session.js`）：按目标机保存最近 40 条消息与 60 条显示记录
  （96 KB 上限），刷新后恢复并明确标注"历史未经核实"，恢复的内容会作为上下文重新发给
  模型，但刷新本身不会向设备重放任何命令。注意这是本机的快照，不是 SDK 的 harness
  session 层（entry tree、fork、usage rows 仍未使用）。
- 测试：`agent_config` / `target_files` / `target_tools` / `serial_watch` /
  `agent_session` 等单测，以及 `mobile/browser-test/agent_session.spec.mjs`
  （恢复、标注、续聊、新对话清空）与 `agent_settings.spec.mjs`（provider 与参数存取）。

仍未做：

- 目标机**小文件注入**（≤64 KiB）：原"通用上传"计划已按第六期缩小范围，理由与范围见该节。
- 无人值守的后台/触发式观察：需要一种不依赖提问的常驻运行模式，目前刻意没有。
- 移动端密钥存入系统凭据库：需要 Kotlin / Swift / ArkTS 侧实现，本机无法验证。

## 第五期：可机器判定的验证（已完成）

补的是整套 Agent 最根本的一个弱点：**"是否达成"原本由模型读日志下结论**。退出码 0
只说明 shell 跑完；`mv … && echo ok` 的回显说明不了文件真落到了目标机。让模型从散文里
判"已验证"，这个结论的可靠性就等于它读日志的可靠性。

实现（2026-09-18）：

- **协议层**（`web/target_verify.js`，纯函数、无 DOM、无 import 副作用）：生成一条只读
  shell 命令，输出整行 `LINKR_VERIFY:*` 标记；解析器把目标机的回答与调用方给的预期做
  比较，返回 `match` / `mismatch` / `indeterminate` / `observed`。裁决由应用给出，
  因此**不可能由模型措辞或命令回显伪造**。
- 四种状态的语义写在文件头：`observed` 专指"没有给预期值，这只是测量，不是校验"，
  用来堵住"把测量当验证"这条路；`indeterminate` 专指目标机答不了或回答不可用，
  两种情况都不许当成任一结果。
- **`verify_target_file`**：存在性、类型、字节数、sha256。只依赖 POSIX `wc`；
  sha256sum / shasum 缺失时按 `indeterminate` 上报而不是报错。摘要要读整个文件，
  所以只在给出预期哈希或显式 `hash=true` 时才计算。
- **`verify_target_service`**：systemd 单元状态（`active` / `inactive` / `failed`）、
  匹配扩展正则的进程（`running` / `absent`）、TCP 端口监听（`listening` / `closed`），
  三个参数恰选其一。目标机没有 systemctl / pgrep / ss 时输出 `unsupported` 标记并给
  `indeterminate`，不伪装成失败。
- **归因**：每条命令先打印被校验对象（路径或 subject），解析器比对后才认账。控制台证据
  只是共享日志的一个窗口，先前一次校验别的路径的输出可能还在里面，不能替这次作答。
- **两处刻意不误判**：单元不存在（`LoadState=not-found`）报 `indeterminate` 而非
  "已停止"——否则打错一个字就变成一句笃定的"一切正常"；`denied` / `unreadable` 只说
  "内容没看到"，不声称字节不符。
- 两个工具都是只读但仍走 UART，因此沿用现有审批策略；刻意**不**进 `GATED_TOOLS`，
  因为"目标机答不了"本身就是要让模型看到的结果，而不是让它看不见这个工具。
- **刻意不进 `beforeToolCall` 的两个发送拦截名单**（`recovering` 与 `pendingExecution`）：
  与 `read_target_file` 保持一致。理由有两个——一是它们自己会监控并标记本次执行已复核，
  二是恢复会话后"上一步到底成没成"正是最该校验的时刻，把校验拦掉只会让模型退回读日志猜。
  控制台忙闲由 `device_executor` 的提示符等待负责，不靠这张名单。
- 面板给这两行加了以裁决打头的预览（一致 / 不一致 / 无法判定 / 仅测量）并附判定依据
  的标记行，标签进 i18n 表；两行都不接管 `activeInputRow`，避免执行渲染盖掉裁决。
- 系统提示词新增一段：点明这是唯一不由模型下结论的工具，`match` 只证明给定预期成立、
  不等于用户目标达成，`observed` 不是校验，`indeterminate` 要照实说不许猜。

测试：

- `mobile/test/target_verify.test.mjs`（12 项）：命令形状与参数校验之外，重点是**真实
  执行**——把生成的命令交给 `/bin/sh` 跑真文件系统；服务路径用放进 `PATH` 的
  `systemctl` / `pgrep` / `ss` 桩固定输出，所以"目标机没有该工具"也是确定性验证。
  覆盖 CRLF、`wc` 前导空格、命令回显不构成输出、跨请求归因、摘要工具缺失、
  `not-found` 不算"已停止"。
- `mobile/test/verify_tools.test.mjs`（5 项）：工具层契约——裁决以
  `source: "application-verification"` 返回、`mismatch` 不被洗成成功、答不了时给
  `indeterminate` 与原因、`note` 明确否定过度解读、无法处理的请求以
  `tool_execution_end.isError` 报错。假目标机把命令回显也写进日志，因此每个用例同时
  证明回显骗不过解析器。
- 主机回归 270 项通过；`npm run build`（含 `tsc --noEmit`）通过；
  `web/vendor/agent/` bundle 已按新源重新生成，bundle 摘要测试通过。

仍未覆盖：

- 校验的是**目标机当前状态**，不是"某个操作成功"。`match` 只说明给定的哈希 / 字节数 /
  服务状态成立；文件放错位置、服务跑着但是旧版本，仍要靠用户目标本身判断。
- 摘要校验要读完整个文件，大文件在目标机上的耗时可能超出 30 秒监控窗口，此时是
  `indeterminate`，需要再调一次 `monitor_serial_execution`，目前没有自动续等。
- `verify_target_service` 的进程匹配是扩展正则（`pgrep -f`），过宽的模式会命中大量
  进程，结果按 50 条截断并在 `observed.truncated` 标注。
- 端口校验按 `ss` / `netstat` 的 `-ltn` 输出解析，无法归因到具体进程，也不覆盖 UDP。
- 仍然只在模型主动调用时运行，没有无人值守的校验。

补充（2026-09-18 复查，四项）：

- **修掉一处自己写出的过度断言**：监听表被上限截断时，"没有匹配行"被当成了"没有在听"。表是截断的，
  那一行可能压根没被打印出来——这恰恰是本模块要防的"笃定的错误答案"。现在**截断且未命中**返回
  `indeterminate`；**截断但命中**仍是 `match`（存在性不受截断影响）。进程列表是镜像情形，不需要
  同样的保护：它的上限只有在已有条目时才会触及，而那正是"在运行"所主张的——这条理由写进了代码注释。
- **监听表上限 200 → 60 行**：响应必须和命令回显、下一个提示符一起装进 8192 字节环形区，否则会被从
  中间切断。按 `ss -ltn` 每行约 65 字符算，60 行是环形区预算而不是口味，并有单测锁住这个换算。
- **已知没有哈希工具就不再白跑**：`probe_tools` 已观测到目标机既无 `sha256sum` 也无 `shasum`、且
  摘要**是唯一**的预期值时，`verify_target_file` 直接给出 `indeterminate` 并附上那条观测，不发命令
  ——省下一次往返（最长一个监控窗口）。两个工具都必须由**本次会话**观测为缺失且未过期：一个名字缺失
  推不出另一个，过期观测什么都证明不了。若同时给了期望字节数则照常发送，尺寸仍可校验、摘要标为不可校验。
- **区分"监控窗口到期"与"命令没输出完成标记"**：结果新增 `timedOut`，并在到期时说明目标机可能仍在
  运行、应继续监控同一个执行而不是重发。这两件事原先在模型眼里没有区别。

## 第六期：目标机小文件注入（已定范围，未实现）

原计划是通用的 `upload_to_target`——把任意文件推到目标机。2026-09-18 核算链路后**缩小范围**：

- **UART 是硬瓶颈**：默认 115200（`boards/*.overlay` 的 `current-speed`）≈ 11.5 KB/s 上限。
  一块 `DEFAULT_CHUNK_BYTES = 720` 的命令是 1133 字符（base64 960 + 框架 173，框架数字取自
  `target_files.js` 注释里的实测），加上目标机回显与完成标记，搬 720 字节有效内容过桥约
  2.3 KB，放大约 3.2 倍；仅 UART 串行化每块就约 200 ms。据此：64 KiB 需 92 块 ≈ 45 秒，
  1 MB ≈ 11 分钟，而现有 `MAX_UPLOAD_CHUNKS` 允许的 13.7 MiB（20000 × 720 B）≈ 2.7 小时。
- **换局域网救不了**：瓶颈在 Bee↔目标机那段 UART，不在 BLE。WebSocket 只让前一段变快。
- **提波特率不现实**：目标机那侧必须同步改，而被调试对象往往就是该控制台，改了控制台就废了。
- **与证据纪律冲突**：要接近 3.6 KB/s 的理论上限必须连续流水线灌命令，而项目要求"发一条 →
  等提示符 → 看结果 → 才发下一条"（`pendingExecution` 拦截 + 系统提示词）。通用上传等于给
  这条纪律开一条旁路。
- **产品规划里没有这个场景**：`PRODUCT.md` 的三类用户与共同场景都不含"往目标机推文件"。往目标机
  放文件的正解是 `download_to_target`（目标机自己 curl/wget，走它自己的网络，带探针与哈希校验），
  从目标机取东西是 `read_target_file` 分页与 WebDAV 日志上传——两者都已存在。

缩小后的范围：

- **只用于"目标机没网 + 要塞个配置 / 脚本 / 密钥"**，硬上限 **64 KiB**，超过直接拒绝并在界面说明原因。
- 分块改用 `MAX_CHUNK_BYTES`（2048）而非默认 720：64 KiB 只需 32 块而不是 92 块（实测
  `uploadPlan` 的结果），约 30 秒；2048 字节块的真实命令行长度为 2916 字符，仍在
  `MAX_UPLOAD_COMMAND_BYTES`（4096）以内，也不超过 8192 字节环形区的一半。
- 界面必须**先给预期耗时**再让用户确认，传输中显示进度与已用时间，不做静默等待。
- 命令构造、进度解析、结果校验**已经写好且有测试**（`uploadPlan` / `uploadChunkCommand` /
  `parseUploadProgress` / `parseUploadResult`），不需要新协议。

一个被迫的设计结论：**它不能做成 Agent 工具，只能做成面板功能。** 应用刻意不让模型接触本机文件系统
（`download_to_computer` 的说明即为证），所以"选文件"只能由用户完成。模型能做的是**建议**这件事，
以及事后用 `verify_target_file` 校验落地结果（哈希与字节数）——这是第五期与本期的衔接点。

缺的交互是"选文件 → 一次审批整份计划 → 分块发送 + 进度"，且必须在发起前告知预期耗时。

## 上下文预算与固定开销（已完成）

2026-09-18 测量后发现并修掉一个配置缺陷。

**固定开销是可测的**：系统提示词加全部工具描述，每一次请求都要发一遍。实测 13,661 字符 +
24 个工具 8,983 字符 = 22,644 字符 ≈ 6,290 token（按 3.6 字符/token）≈ 默认 32K 窗口的 19%。

**缺陷**：历史压缩上限是写死的 24000 字符（`mobile/src/agent-context.mjs`），而 `contextWindow`
是用户可配、范围低到 1000 token 的字段，两者毫无关系。用户填 8192 时，固定开销加历史可达约
13K token，**每次请求都超出窗口**，而报错来自 provider 的 context-length，完全指不回是这个字段。

修法：

- 新增 `contextBudgetChars({contextWindow, fixedChars, outputTokens})`：预算 = 窗口 − 固定开销 −
  输出预留 − 帧开销，再按保守比例折成字符。**上限仍是 24000，因此大窗口行为完全不变**，
  只有小窗口会收缩。固定部分按 3 字符/token、历史按 2 字符/token：提示词是英文，对话可能是
  中文，两头都取悲观值（应用里没有分词器可用）。
- `pi-agent.mjs` 的每一处压缩都改用该预算；工具解锁会改变固定开销，所以预算按**每次压缩时**
  生效的工具列表计算，而不是启动时的那个列表。顺带把 `prompt()` 里"压缩"与"刷新系统提示词"
  的顺序理正——原先压缩用的是上一轮的提示词。
- `AGENT_FIXED_CONTEXT_TOKENS`（8000）与 `minimumUsefulContextWindow()` 放在 `agent_config.js`；
  设置界面据此在窗口过小时给出**带具体数字的警告**（模板里 `{fixed}` / `{min}` 两个占位符），
  而不是等 provider 抛一句看不懂的错。
- 大窗口无回归：`contextBudgetChars(32768, 实测固定开销, 4096)` 仍返回 24000，与改动前一致。

防漂移：`mobile/test/serial_agent.test.mjs` 里有一项测试**重新测量**真实的提示词与工具描述，
一旦超过 `AGENT_FIXED_CONTEXT_TOKENS` 就失败——否则加一个长工具描述会让那句警告悄悄变成假话。
`agent_config.test.mjs` 另外断言新文案的两个占位符与 HTML 的 `data-ai-setting` 键都在（缺键会把
裸键名显示给用户）。

同时把 `verify_target_file` / `verify_target_service` 的描述压紧（9402 → 8,983 字符，约 −120
token）：保留四态语义与证据纪律，删掉模型可自行推断的重复说明。**收益不大**，留着的价值是那项
防漂移测试。

仍未覆盖：历史里没有任何 assistant 消息时，`compactAgentContext` 没有可承载摘要的消息，会原样
返回（即使超预算）。实际场景下这种历史只是零星几条用户消息，远小于固定开销，边界很窄；不修是
因为造一条假的 assistant 消息等于替模型说话，而摘录用户自己的文字等于改问题。

## 模型请求恢复与预算修正（2026-10-20）

- `mobile/src/model-stream.mjs` 只重试尚未产生任何内容的临时模型错误，每次提问共用
  2 次重试额度，依次等待 1 秒、2 秒。正文、思考或工具调用已经开始后不会重试；
  认证、额度和上下文过长等错误直接结束。底层 SDK 重试关闭，避免叠加请求。
- 重试沿用当前模型请求的上下文，不重启 Agent 执行循环，不重放已经执行的串口命令。
  每次尝试前重新检查设备连接与执行档位；等待可立即取消，界面显示次数与等待状态。
  用户停止后任务保留为“已中断”，不会被取消异常改成“失败”。
- 历史预算纳入工具 JSON 参数结构，动态解锁工具后也重新计算。设置页按包含可选工具
  的约 12000 token 固定开销给出保守建议，明确这不是精确 token 计数。
- 回归覆盖：瞬时错误恢复、总重试额度、取消等待、切换设备、部分响应中断、已发送命令
  不重放；浏览器使用模拟模型端点验证状态显示和输入恢复，不代表真实设备实测。

## 内置工作流技能（2026-10-20）

- 新增按需读取的 `load_skill`，内置 Radxa 文档、启动诊断、网络排查、下载校验四个
  流程，默认只把技能目录加入上下文，不携带全部正文。
- `search_radxa_docs` 检索官方产品目录与站点路径，支持板型筛选、中英文主题别名和
  官方仓库源码后备路径；查到入口后仍需 `read_web_page` 读取正文并引用来源。
- 技能不增加执行权限，不自动刷机或安装。源码 MDX 的引用解析是阅读步骤，不执行代码。
  使用、来源、限制与扩展方式见 [AGENT_SKILLS.zh-CN.md](AGENT_SKILLS.zh-CN.md)。

## 任务证据与恢复检查点（2026-10-20）

- 完成步骤关联应用生成的证据 ID；操作步骤要求已完成的应用校验匹配，诊断步骤仅表示
  观察已记录。保留比较条件和执行来源，不把匹配扩大为整个用户目标已经达成。
- 按设备保存有限的结构化检查点；恢复时检查实例 ID、连接和执行编号，不借用刷新后的
  同名编号，不重发结果未知的相同请求。记录不可用明确返回未知。
- 新增 6 个场景的模拟回归与显式配置的真实模型评测入口。详见
  [AGENT_TASKS.zh-CN.md](AGENT_TASKS.zh-CN.md)；真实模型结果和实机验收另记。

## 边界

- 扩工具时必须保持现有证据纪律：工具返回可引用证据、走审批、不自动重放、不确定就
  明说。破坏这条链的扩展会让功能看起来更强、可信度更低。
- 凡是由应用（而非模型）下结论的校验，一律沿用 `web/target_verify.js` 的四态语义
  `match` / `mismatch` / `indeterminate` / `observed`，并守住两条区别：`observed`
  （没给预期，只是测量）不等于 `match`，`indeterminate`（答不了 / 回答不可用）不等于
  任一结果。不要另造一套说法，也不要把"退出码 0"或某一行的出现升级成"已验证"。
- 当前应用未接入 MCP、子代理和向量记忆，不要按“现成可用”的应用能力排期。
- 助手不应越过"下载后等用户指示"的界线，自动安装、刷写不在计划内。
