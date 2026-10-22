# Linkr CLI —— 给脚本与 Agent 的命令行

本目录是 **CLI 构建** 的 bee：同一份源码、关掉界面特性编出来的小程序（压缩包约为界面版的四成），
专门给脚本与 agent 调用——不带交互界面，把一件事发到设备、拿回确定的结果、用确定的退出码说话。

程序名是 `bee-cli`（`--help` 的 Usage 行也这么印）。它和上一级 `linux/`、`macos/`、`windows/`
里的界面版是**同一份实现**：界面版也包含这里全部的命令行能力（程序名 `bee`）；本包的差别只是
没有那个交互界面——裸跑 `bee-cli` 会说明本构建没有界面并以 2 退出（先说要做什么），除此之外只有配置
界面的那几个 flag 会被明确拒绝（第二节），其余动作参数与输出格式与界面版完全一致。
完整教程（含界面用法）见上一级《使用教程.md》，校验和见 `../SHA256SUMS`。

> 给 Agent 的契约：确定的输入、确定的输出（`--json` 的 JSON Lines）、确定的退出码、失败可分类。
> 模型调用、审批、任务计划仍在调用方，CLI 只做“发出去、拿回来、说清楚”。

---

## 一、快速开始

```sh
# Linux / macOS：解压后运行（按机器架构选包；macOS 另有 .dmg：本目录的是这份 CLI，上一级 macos/ 的是界面版）
tar xzf linkr-bee-cli-0.1.2-x86_64-unknown-linux-gnu.tar.gz
./linkr-bee-cli-0.1.2-x86_64-unknown-linux-gnu/bee-cli --version
./linkr-bee-cli-0.1.2-x86_64-unknown-linux-gnu/bee-cli --scan        # 附近有哪些设备
```

```powershell
# Windows：解压 .zip（右键「全部解压缩」或 7-Zip）
.\bee-cli.exe --version
.\bee-cli.exe --scan
```

Linux 上也可以直接用 `../linux/` 里的 `.deb` 安装包：它装的是界面版 `bee`，命令行能力一样。

## 二、怎么连

| 连接方式 | 参数 |
|---|---|
| 蓝牙地址（最稳） | `--ble-address EE:C7:42:34:48:CF` |
| 按名字片段找（名字是标签，可被改名） | `--ble-name "UART-3"`；板子改过名就用 `--ble-address` |
| 局域网 WebSocket | `--lan-host 192.168.0.102`（也可给完整 `ws://` 地址） |
| 该桥要求的 token | `--lan-token <TOKEN>`；或 `--lan-token-file <文件>`；或环境变量 `$LINKR_LAN_TOKEN` |
| 锁定传输方式 | `--transport ble\|lan\|stdio` |
| 离线回环（试手） | `--bridge -` |
| 连接超时 | `--connect-timeout <秒>`（默认 20；蓝牙链路最多再等 30） |

不给 `--name` 时，板子按它广播的 Management Service 找、按蓝牙地址连：名字随时可以改，
所以名字只用来筛选，不用来认板子；名字没匹配上时程序会列出听到的板子并提示用 `--address`。
连上之后 `bee-cli` 会向板子问一次名字（`@n?`），所以 `--query-ble-name` 与界面里显示的
名字都是板子自己的回答。

只跑一个动作时：连上 → 动作 → 打印 → 退出。本 CLI 构建没有界面，因此配置界面的那几个
flag——`--cli-then-tui`、`--enter`、`--local-echo`、`--line-mode`、`--escape`——会在参数阶段
被**拒绝**（退出码 2，文案说明本构建无界面），不会被静默接受然后什么都不做；
`--cli-then-tui` 的提示会建议改用 `--no-terminal`。

## 三、常用动作（一次一个）

| 目的 | 命令 |
|---|---|
| 列出附近的蓝牙设备 | `bee-cli --scan`（唯一不用 `--json`、直接印表的动作：`bee` 列 = 本程序能直连的板子） |
| 读板子诊断 `@i?` | `bee-cli --query-info` |
| 读串口参数 `@u?` | `bee-cli --query-uart` |
| 读 WiFi 状态 `@w?` | `bee-cli --query-wifi` |
| 读 WebDAV 状态 `@d?` | `bee-cli --query-webdav` |
| 读广播名 `@n?` | `bee-cli --query-ble-name` |
| 改广播名 `@n=<名称>` | `bee-cli --rename-ble "测试😀"`（1–29 个 UTF-8 字节，中文和 emoji 可用） |
| 恢复默认广播名 `@n default` | `bee-cli --reset-ble-name` |
| 读桥的 LAN 状态 `@s?` | `bee-cli --query-lan`（`ws=` 与 token 是否已捕获） |
| 设置串口 | `bee-cli --uart 115200,8,n,1,none`　`baud,data,parity,stop,flow` |
| 连 WiFi | `bee-cli --wifi "MySSID,MyPassword"` |
| 连 WiFi（密码不进参数） | `bee-cli --wifi "MySSID" --wifi-key-file pw.txt`（读文件第一行） |
| 扫描 WiFi | `bee-cli --wifi-scan` |
| 忘记 WiFi | `bee-cli --wifi-off` |
| 设置 WebDAV 上传 | `bee-cli --webdav http://dav.example/logs/` |
| 关闭 WebDAV 上传 | `bee-cli --webdav-off` |
| 回环自测（发什么收什么） | `bee-cli --loopback-test 414243`（发的是字面字节 `4 1 4 2 4 3`） |
| 看这条链路的状态与计数 | `bee-cli --link-state`（与 `--serve` 的 `state` 同构；不问板子任何问题） |
| 一次体检（链路 + 诊断 + 串口 + 回环 + 目标 shell） | `bee-cli --doctor`（四个词给出结论，见第九节） |
| 把手头的东西发过去，不等结束 | `bee-cli --send line`（把 stdin 逐行送出）或 `bee-cli --send raw`（原样送出） |
| 在板子的目标上跑 shell 命令 | `bee-cli --exec "uname -a"`，见下节 |

> WebDAV 当前只支持匿名 `http://host[:port]/path/`，不支持 HTTPS、认证、查询参数或片段。
> 空地址会被拒绝；关闭上传请显式使用 `--webdav-off`。
>
> WebDAV 属于设备协议；ESP32-WROOM 构建因 DRAM 关闭了该功能，查询或设置会显示板子自己的
> `ERR unknown command`，程序不会把命令藏起来。

> 读诊断（`@i?` 等管理命令）仅限 BLE：LAN / stdio 下会返回一行说明并以 1 退出，这不是故障。
>
> 扫描遇到板子忙（另一个 WiFi 操作还没结束，板子此时对 `@w scan` 要么不应答、要么回
> `ERR scan=-16`）会自动重试 4 次，停顿 2/4/6/8 秒；板子报"操作结束"时还会提前重试。
> 4 次都没成才报错，报的话会说重试次数。TUI 里每次等待都有一条"最多 N 秒后自动重试…"提示。

## 四、`--exec`：把命令送到板子的目标 shell

默认用 **rc-marker** 判定结束：先把你的命令改写成

```sh
sh -c '你的命令'; printf '\n%s:%s\n' 'LINKR_RC_<随机标识>' "$?"
```

CLI 会自动处理命令中的单引号，并在每次执行或重试时生成不同的标识。
再追一个回车发出，只有读到本次标识对应的完整 `LINKR_RC_<随机标识>:<状态>` 行，
才确认命令自身的退出码。命令输出中的旧标记不会被当作完成。
也可用 `--idle <秒>`：输出安静这么久就结束等待，但不会报告已验证的退出码。

| 参数 | 作用 |
|---|---|
| `--timeout <秒>` | 整条命令的最长运行时间（默认 30） |
| `--idle <秒>` | 换成“安静即结束”的判定方式 |
| `--rc-marker` | 显式指定 rc-marker 判定（默认） |
| `--retry <n>` | 超时后先探一次状态，必要时最多重发 n 次 |
| `--dry-run` | 只打印将要发出的字节，不连接、不发送 |

```sh
bee-cli --ble-address EE:C7:42:34:48:CF --exec "uname -a"
bee-cli --bridge - --no-terminal --exec "echo hi" --json --quiet   # 离线试跑
```

提示：`--exec` 需要目标提供 POSIX `sh` 和 `printf`。命令在子 Shell 中执行，
其中的 `cd`、变量赋值等不会改变串口控制台父 Shell 的状态。
若目标把光标控制序列混进完成标记行，可用 `--idle` 获取未验证的输出。

`--link-state` 可以和别的动作放在同一批里：状态在它们之后印出，计数就是这一批动作搬过的
字节（管理问答不计入，那部分记的是"目标说了多少"，见第八节）。

回环设备的边界：`--bridge -` 里那个假 shell 只跑**简单命令**——`echo`/`printf`/`true`/
`false`/`exit`、`;` 列表、引号成组，以及 `$?`。管道、重定向、替换、通配
（`|`、`>`、`<`、`&&`、`` ` ``、`$`、`*`、`~`、`()`）一律**拒绝**并给出状态 2：旧版把
`echo x | tr a-z A-Z` 当字面参数回一个 rc 0，那是**假成功**——离线彩排放过板子会拒绝的命令，
比彩排不上更糟。`sleep` 与 `sudo` 仍故意挂起（用来试 `--idle` 与 `needs_input`）。

## 五、`--json`：给程序读的输出

`--json` 时每行一个 JSON 事件（JSON Lines）：

| 事件 | 字段 | 含义 |
|---|---|---|
| 启动横幅 | `{"event":"output","text":"…"}` | 连接建立后设备先说的话 |
| 运行中输出 | `{"event":"output","t":毫秒,"data":"…"}` | 设备实时输出，按到达分段 |
| `--exec` 开始 | `{"event":"start","execution_id":"…","link":"…","mode":"rc-marker","cmd":"…"}` | 一次 exec 的标识与判据 |
| 结果 | `{"event":"result","what":"uart","ok":true,"reply":"uart=115200"}` | 查询成功；`ok:false` 时看 `detail` |
| exec 结束 | `{"event":"result","ok":true,"rc":0,"elapsed_ms":5,"bytes":58,…}` | 带目标退出码 |
| 出错 | `{"event":"error","code":"timeout","message":"…","still_running":true,…}` | 失败可分类的依据 |

`code` 的稳定取值：`needs_input`（命令在等人输入）、`timeout`、`link_lost`、`not_connected`。
`--quiet` 只关掉 stderr 上的进度行，JSON 照常。连接失败时 stderr 会有一行 `error: …`，
退出码见下节。

## 六、退出码

| 退出码 | 含义 |
|---|---|
| 0–125 | `--exec` 目标命令自身的状态，原样透传——**仅当它是这一轮唯一的动作**；混批时见下面的口径 |
| 126 · 127 | 保留 shell 含义（127 = 命令没找到） |
| 1 | 做了但结果不对：需要人工输入、超时、被拒绝；管理命令在 LAN / stdio 上也走它（那里没有管理通道）；混批时**任一动作失败**也走它 |
| 2 | 用法错误：参数拼错、缺失、互斥冲突（普通启动且链路打不开也是它） |
| 255 | 发不出去或保不住链路：连接失败、断链（带动作的调用在连接失败时走它，不是 2） |

口径：一条命令里出现**多个动作**（例如 `--exec … --query-info`）时，退出码只回答"这一批活儿
成没成"——任一动作失败即 1。目标命令自己的状态仍在它的结果事件里（`{"event":"result",…
"rc":5}`），不会被丢掉；这样 `if bee-cli --exec 'exit 5' --query-info; then` 读到的是"查询失败"
而不是"命令说了 5"。只有一个 `--exec` 时才是透传：那是脚本包一条命令最常用的形状。

`--capabilities --json` 自描述本版本：支持的动作用、默认超时与退出码表，一项不落
（本 CLI 构建的 `operations` 和 `subcommands` 里都没有 `tui`——这里没有界面可开；`bee-cli tui`
仍会被认出，报"本构建没有界面"而不是被当成未知参数）。

## 七、许可证与第三方组件

`bee-cli --licenses` 打印完整的第三方组件清单和许可证正文。每个归档里也带有
`THIRD_PARTY_LICENSES.md`；界面版的 About 卡片可用 `L` 打开组件页。

## 八、常驻会话：`--serve`

一次一个动作要**每次重新拨号**（蓝牙尤其慢）。`--serve` 只拨一次、一直用，从 stdin 逐行读
JSON 请求，适合脚本与 Agent 连续问很多件事：

```sh
bee-cli --ble-address EE:C7:42:34:48:CF --serve
{"event":"ready","program":"bee-cli","version":"0.1.2","link":"ble:EE:…","ops":[…]}
{"id":1,"op":"state"}
{"event":"begin","id":1,"op":"state"}
{"event":"result","what":"state","live":false,…}
{"event":"end","id":1,"code":0}
{"id":2,"op":"exec","cmd":"uname -a"}
{"event":"begin","id":2,"op":"exec"}
…（与一次性 `--json` 相同的事件）…
{"event":"end","id":2,"code":0}
{"id":3,"op":"quit"}
{"event":"end","id":3,"code":0}
```

框架行（`ready` / `begin` / `end`）之外的字段：

| 行 | 字段 | 说明 |
|---|---|---|
| `ready` | `program` `version` `link` `ops` | 启动横幅；`ops` 是这个会话当下能服务的请求（随传输变化：LAN / stdio 下不含 `info`/`uart`/`wifi`/`wifi-off`/`wifi-scan`/`webdav`/`webdav-off`/`ble-name`/`lan` 这些仅限 BLE 的项；`--capabilities` 才是本构建的全表） |
| `begin` | `id` `op` | 每个请求的开口；`id` 是可选数字，原样回显（不给就是 `null`） |
| `end` | `id` `code` | 每个请求的收口；`code` 就是一次性命令行的退出码（第六节） |

请求就是「动作的参数换成 JSON」，`op` 名与 `--` 参数一一对应：

| `op` | 字段 | 对应命令行 |
|---|---|---|
| `info` | —— | `--query-info` |
| `uart` | 给 `value`：写；不给：读 | `--uart 921600,8,n,1,none` / `--query-uart` |
| `wifi` | 给 `ssid`（+可选 `pass`）：连；不给：读 | `--wifi` / `--query-wifi` |
| `wifi-off` | —— | `--wifi-off` |
| `wifi-scan` | —— | `--wifi-scan` |
| `webdav` | 给 `url`：设置并开启；不给：读 | `--webdav` / `--query-webdav` |
| `webdav-off` | —— | `--webdav-off` |
| `ble-name` | 给 `name`：改名；给 `default: true`：恢复默认；都不给：读 | `--rename-ble` / `--reset-ble-name` / `--query-ble-name` |
| `lan` | —— | 读桥的局域网状态（`@s?`）：`ws=` 与 token 是否已捕获；界面里是连接区的一行 |
| `exec` | `cmd`（必填）、`timeout_ms`、`idle_ms`、`retry` | `--exec` 全部参数 |
| `loopback-test` | `data`（字面字节，非十六进制）、`timeout_ms`（默认 3000） | `--loopback-test` |
| `state` | —— | 本地状态：链路是否活着、已连、计数（一次性命令行是 `--link-state`） |
| `quit` | —— | 结束会话（会话也随 stdin 关闭而结束） |

行为约定：

- **懒拨号**：`state`、`quit`、格式错误的行都不需要链路；第一个需要链路的请求才真正连接。
  拨号失败回 `{"event":"error","code":"not_connected","message":…}`（`code` 255，会话不死），
  等板子就绪再发一次即可。
- **坏请求不致命**：不是合法 JSON、或 `op` 不认识 → `{"event":"error","code":"bad_request"}`（`code` 2）；
  参数缺失（如 `exec` 没给 `cmd`）同理；**未知字段也拒绝**，文案会点名并给出近似字段的建议
  （`unknown field "timeout" for op "exec"; did you mean "timeout_ms"?`）——不会静默回落默认值。
  会话继续读下一行。
- **请求内格式**：请求里加 `"format":"text"`，该请求内部的事件按文本输出（框架两行仍是 JSON）。
- **结束**：`quit` 或 stdin 关闭 → 退出码 0。启动时若已给 `--ble-address` 等连接参数，
  会话只记住它、不提前拨号。

## 九、安全与留档

- **token 永不回显**：桥自述里带 token 的字段上屏前一律打码；记住的 token 存在
  `~/.config/linkr/lan-tokens`（0600），不进日志、不进通知（日志里的管理回复同样打码）。
  键按**归一化后的桥地址**存放：`ws://host:80/ws`、`host:80`、`host` 是同一条；格式不合的行
  读取时丢弃并把文件重写干净。
- **密码尽量不进命令行**：`--wifi "SSID" --wifi-key-file pw.txt` 只读文件第一行。
- **留档**：`--log-file <文件>` 追加记录设备发出的每个字节；管理通道的问答也进同一份档，
  带标签以示区分——`tx command: @i?` / `rx reply: @info …`（token/密码打码后）。
  `--debug-io` 在标准错误上跟踪双向字节（管理问答同样是 `tx command:` / `rx reply:` 两行）；
  终端里运行时 trace 写在 `$TMPDIR/linkr-trace-<进程号>.log`（0600，启动时有通知告知路径）。
- 一次性试完所有查询又不想碰真机：`--bridge -` 是本程序内置的回环设备（离线跑通全流程；
  能力边界——它支持哪些 shell 语法——见第四节）。

## 十、子命令：同样的命令，写成词

动作也能写成子命令，对人和对模型都更好念。**子命令与 flag 是同一件事**：程序在解析前把
`bee-cli scan` 改写成 `bee-cli --scan`，所以两者永远同义，帮助与补全也出自同一张表。

| 子命令 | 等于 |
|---|---|
| `bee-cli scan` | `--scan` |
| `bee-cli doctor` | `--doctor` |
| `bee-cli query info\|uart\|wifi\|webdav\|ble-name\|lan` | `--query-info` / `--query-uart` / `--query-wifi` / `--query-webdav` / `--query-ble-name` / `--query-lan` |
| `bee-cli set uart "115200,8,n,1,none"` | `--uart "115200,8,n,1,none"` |
| `bee-cli set wifi "MySSID,MyPassword"` | `--wifi "MySSID,MyPassword"` |
| `bee-cli set webdav http://dav.example/logs/` | `--webdav http://dav.example/logs/` |
| `bee-cli set webdav off` | `--webdav-off` |
| `bee-cli set ble-name "测试😀"` | `--rename-ble "测试😀"` |
| `bee-cli set ble-name default` | `--reset-ble-name` |
| `bee-cli exec -- df -h` | `--exec "df -h"`（`--` 之后全是命令本身，`-h` 之类不会被当 flag） |
| `bee-cli send --line` / `--raw` | `--send line` / `--send raw` |
| `bee-cli loopback AB` | `--loopback-test AB` |
| `bee-cli capabilities` | `--capabilities` |

全局 flag（`--ble-name`、`--json` 等）写在子命令**前或后**都行：`bee-cli --json scan`、
`bee-cli scan --json`、`bee-cli --ble-name UART-1 exec --json -- uname -a` 都可以；老脚本一个都不用改。
一次命令行写一个子命令（`exec` 的命令部分除外）；写错时程序会点名它要的词，例如
`query reads one of info, uart, wifi, webdav or lan; 'nope' is not one`。

### `doctor`：一次体检，四个词

```sh
bee-cli doctor --ble-name "Linkr Bee 078C" --json
```

依次跑五项、各给一个结论：

| 检查 | 做什么 | 结论从哪来 |
|---|---|---|
| `link` | 拨号打开了没有 | 会话是否还在 |
| `bridge` | `@i?` | 答的是不是桥自己的 `@info` 块 |
| `uart` | `@u?` | 报了串口参数；若同批给了 `--uart`，则和它比对（对不上就是 `mismatch`） |
| `loopback` | 发 `LINKR-DOC` 等回声 | 收到回声 = `match`；没回声 = `indeterminate`（目标接着串口时本就不该有回声） |
| `target` | 目标 shell 上跑 `echo LINKR-DOC` | 状态 0 = `match`；等输入/超时 = `indeterminate`；别的状态 = `mismatch` |

四个词：`match`（比对过、对上了）、`mismatch`（比对过、对不上）、`observed`（读到的事实，
没东西可比）、`indeterminate`（这条链路答不了这个问题，或没能跑完——例如 LAN/stdio 没有
管理通道、目标控制台停在密码提示）。**退出码只说有没有 `mismatch`**：0 = 没有矛盾，
1 = 有；`indeterminate` 不是失败，它是"没证明"。

### `send`：只发不收，给人在环

`bee-cli --send line` 把标准输入**逐行**送出去（每行补一个换行，`\r\n` 的文件不会送成两个），
`--send raw` 一个字节不动地送。收到什么就印什么，但**没有结束判定、没有 marker、也不重发**：
要"送一条、等结束、拿回退出码"就用 `--exec`。标准输入直接结束（一个字节都没有）算失败，
以免"什么都没做"看起来像成功；中途断链会报还有多少字节没送出去。
留给人在键盘前用的写法：`bee-cli send --line` 然后逐行输入，`Ctrl-D` 结束。

---

整理：Novice-PG · 2026-10-21
