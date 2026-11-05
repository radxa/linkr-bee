---
name: Linkr Bee Terminal
description: 浏览器里零安装的串口终端——BLE / 局域网直连 ESP32-C3 桥接器
# 这些是 skin v2（web/skin-v2.css，在 style.css 之后加载）实际画到屏幕上的值；
# style.css 里的同名 token 是它的底层默认值，运行时会被覆盖。改动颜色时以这里为准。
colors:
  signal-green: "#3fc88a"
  signal-green-bright: "#5fe0a6"
  ink-on-green: "#04160e"
  focus-blue: "#6aa6f5"
  danger-red: "#ef6a68"
  rx-blue: "#6aa6f5"
  tx-amber: "#f0a868"
  warn-amber: "#f0b45e"
  bench-bg: "#05080d"
  panel: "#111822"
  panel-raised: "#18212e"
  panel-inset: "#1c2330"
  terminal-bg: "#05080d"
  input-bg: "#0e131c"
  text: "#e8eef6"
  text-muted: "#9aa7b8"
  text-placeholder: "#7c8a9e"
  border: "#242d3d"
  border-strong: "#33405a"
  btn-hover: "#232c3d"
typography:
  display:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.01em"
  title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "11.5px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.08em"
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.35
rounded:
  sm: "8px"
  md: "12px"
  lg: "18px"
  pill: "999px"
spacing:
  sm: "8px"
  md: "14px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.signal-green}"
    textColor: "{colors.ink-on-green}"
    rounded: "10px"
    height: "36px"
    padding: "0 13px"
  button-primary-hover:
    backgroundColor: "{colors.signal-green-bright}"
    textColor: "{colors.ink-on-green}"
    rounded: "10px"
  button-soft:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.text}"
    rounded: "10px"
    height: "36px"
    padding: "0 13px"
  input:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.text}"
    rounded: "10px"
    height: "36px"
    padding: "0 12px"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "16px"
  chip-preset:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "5px 13px"
  status-pill:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
---

# Design System: Linkr Bee Terminal

## 1. Overview

**Creative North Star: "工程师的工作台 (The Engineer's Workbench)"**

每件工具伸手可及，每个状态一瞥即得。这套系统服务三类用户——固件工程师、产线测试、Linkr 集成方——他们的共同点是要么在调试、要么在验证，没人来欣赏界面。因此密度优先于装饰，终端区永远占据视觉中心，控制面板退居侧栏，深色底色让串口输出成为屏幕上最亮的信息。

明确拒绝两种方向：PuTTY 时代的老旧桌面串口工具（灰底、拥挤、无层次），以及营销味 SaaS（大圆角卡片堆文案、hero 区、空洞渐变）。界面不说服任何人，它只回答问题。

**Key Characteristics:**
- 深色工作台底色 + 信号绿单一强调色，绿色只表示「连接/正常/可执行」
- 卡片即抽屉：侧栏面板是工具的收纳格，不是营销容器
- 触感明确：按钮有位移反馈，hover 提亮边框，状态切换即时可见
- 等宽字体用于一切数据（计数、诊断值、命令），衬线绝迹
- 动效短促（≤0.28s）且全部可被 `prefers-reduced-motion` 关闭

## 2. Colors

深色工作台上的一盏信号绿灯：背景与面板是低亮度的蓝黑阶梯，唯一的彩色是绿——它在 10% 以内的屏幕面积出现，永远携带语义。

### Primary
- **信号绿 Signal Green** (#3fc88a): 连接状态点、主按钮渐变起点、可点击命令、聚焦态边框。它只意味着「通」与「可执行」。
- **信号绿·亮 Signal Green Bright** (#5fe0a6): hover 态与深色底上的绿色文字（终端提示、RSSI 读数、预览 glyphs）。
- **绿底墨色 Ink on Green** (#04160e): 主按钮上的文字色，保证绿底对比度。

### Secondary
- **焦点蓝 Focus Blue** (#6aa6f5): 仅用于键盘焦点环与输入框 focus 描边，与绿色语义严格分离。

### Tertiary
- **警示红 Danger Red** (#ef6a68): 断连状态点、错误 toast 描边。不用于装饰。

### 传输方向 RX / TX / WARN
串口界面必须一眼分出「设备说的话」和「我们发出去的话」，还要能标注「降级但还在跑」，所以皮肤里有三个彩色语义 token。它们是**方向与降级**的标记，不是第二、第三强调色：

- **`--rx` 接收蓝**（深色 #6aa6f5 / 浅色 #2f6fd0）: 只给状态栏的 `#rxCount`（收到的字节数）。
- **`--tx` 发送橙**（深色 #f0a868 / 浅色 #b8671f）: 只给状态栏的 `#txCount`，以及「一键 Ctrl-C」`#breakButton` 的底色——那是一次向设备发送中断。
- **`--warn` 警示琥珀**（#f0b45e）: 只给「降级但仍在工作」的提示条（供应商脚本没加载出来的 boot notice）。成功用信号绿、失败用警示红，琥珀的含义是「能用，但有问题」。浅色主题下该提示条改用更深的琥珀字色 `#7a5210`；`--warn` 本身目前只有深色值，是已知缺口，不是新增颜色的许可。

三者都不得出现在插画、装饰背景、卡片描边或营销图形里；它们出现在别处就说明用错了 token。

### Neutral
- **工作台底 Bench Background** (#05080d): 页面底色，带两团极淡的绿/蓝径向辉光。
- **面板 Panel** (#111822, 72% 不透明玻璃) / **面板·浮 Panel Raised** (#18212e) / **面板·嵌 Panel Inset** (#1c2330): 三级面板阶梯，卡片用浮层渐变，输入框与芯片用嵌层。Glass 只给 chrome（顶栏、侧边栏、抽屉、键条、芯片），终端画布保持近实心。
- **终端底 Terminal Background** (#05080d): 全站最暗的表面，只属于串口输出区。
- **正文 Text** (#e8eef6) / **次要 Text Muted** (#9aa7b8) / **占位 Text Placeholder** (#7c8a9e): 三级文字阶梯，占位色对比度 ≥4.5:1。
- **描边 Border** (#242d3d) / **描边·强 Border Strong** (#33405a): 静态边框与 hover 加亮边框。

### Token 分层
- `web/style.css` 定义这套颜色的**默认值**，`web/skin-v2.css` 在其后加载并**整体重定义**同一组 token（上面列出的是皮肤实际生效值）。皮肤是 presentation layer，不改行为、不改 DOM 钩子。
- 新代码只消费 token，不写字面色值；要调色只改 `skin-v2.css`，并同步本文件的 frontmatter。
- 主题切换只靠 `[data-theme="light"]` 覆盖同一组 token；任何组件都不应出现 `[data-theme]` 分支里的第二次配色。

### Named Rules
**The One Voice Rule.** 信号绿在任意屏幕上的占比不超过 10%。它的稀缺就是它的语义——满屏绿色等于没有绿色。

**The Green Means Go Rule.** 绿色禁止用于纯装饰（插画、背景渐变主体、营销图形）。用户看到绿色就必须能回答：什么通了？

**The Two Directions Rule.** 有方向的彩色（RX 蓝 / TX 橙）只用来区分数据流向；一旦它开始表达「好看」，方向就失效了。

## 3. Typography

**Display Font:** 系统无衬线栈（ui-sans-serif / PingFang SC / Microsoft YaHei）
**Body Font:** 同一系统栈，单一字族多字重，不做字体配对游戏
**Label/Mono Font:** 系统等宽栈（ui-monospace / SF Mono / Menlo），终端可切换 Nerd Font

**Character:** 工具不报幕，它只标注。无衬线承担所有界面文字，等宽承担所有数据——两者边界即「人说的话」与「机器说的话」的边界。

### Hierarchy
- **Display** (700, 18px, 1.2): 顶栏产品名，全站唯一。
- **Title** (700, 11.5px, 大写, +0.08em 字距): 卡片分区标题，配信号绿小圆点。
- **Body** (400/600, 13.5px, 1.45): 按钮、表单、状态文字。600 字重用于按钮与状态强调。
- **Label** (400, 12.5px, 1.4): 字段标签、提示文字，一律次要色。
- **Mono** (400, 12–13px, 1.35, tabular-nums): RX/TX 计数、诊断值、命令、IP 地址。

### Named Rules
**The Machine Speaks Mono Rule.** 凡是设备产生的或发往设备的字符串（命令、计数、地址、版本号），必须用等宽字体；凡是界面自身的说明文字，禁止用等宽。

**The No Display Type Rule.** 不存在展示级标题。Display 止步于 18px——需要更大字号的场景说明做错了页面。

## 4. Elevation

环境分层：面板靠低透明度、大范围的深色投影浮于工作台底色之上，层级由「面板三级色阶 + 投影 + 1px 描边」共同表达，不堆叠多重阴影。

### Shadow Vocabulary
投影按**层级**分配，每一层一个 token，同层不并存第二种投影。三个 token 都定义在 `web/skin-v2.css`（`--shadow` / `--shadow-flat`）与 `web/window.css`（`--window-shadow` / `--overlay-shadow`），并且都有 `[data-theme="light"]` 变体：

- **`--shadow` 窗口投影**（skin v2：`0 40px 90px -46px rgba(0,0,0,0.95), inset 0 1px 0 rgba(255,255,255,0.06)`）: 浮在页面上、带自己标题栏的大窗口与卡片（终端窗口、Agent 窗口、设置抽屉）。
- **`--shadow-flat` 面板投影**（skin v2：`0 24px 50px -38px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.05)`）: 停在页面上的静态卡片（`.card`、面板内分区）。它比 `--shadow` 更贴地：同一屏幕里两者必须一眼看出是同一套光。
- **`--overlay-shadow` 浮层投影**（window.css：`0 12px 32px rgba(2,6,16,0.35), 0 2px 8px rgba(2,6,16,0.2)`）: 临时压在其他内容之上并脱离文档流的东西——下拉菜单、选择器弹层、复制气泡。
- **`--window-shadow` 贴地阴影**（window.css：`0 2px 8px rgba(2,6,16,0.2)`）: 与页面同层的窗壳，只用来把 1px 描边和底色分开，不表达「浮起」。
- **主按钮辉光 Primary Glow** (`0 6px 16px rgba(47,179,119,0.3), inset 0 1px 0 rgba(255,255,255,0.18)`): 仅主按钮与 logo，hover 时加深。它不是层级，是「这一个能按」的提示。
- **连接脉冲 Connected Pulse** (状态点 `::after` 环形扩散，transform/opacity): 仅已连接状态点，纯合成层动画。
- 内阴影 `inset 0 1px 0 rgba(255,255,255,…)` 属于表面高光（玻璃质感），不算独立投影层级。

### Named Rules
**The One Shadow Per Level Rule.** 一个层级只有一种投影，且必须来自上面列出的 token；需要「更高」时先换层级（`--shadow-flat` → `--shadow`），不发明新阴影。散落的字面量 `box-shadow` 只允许用于焦点环（`0 0 0 3px …`）与表面高光 `inset`。

## 5. Components

### Buttons
- **Shape:** 利落小圆角（10px），高度 36px，内边距 0 13px
- **Touch:** 36px 是硬下限；`@media (pointer: coarse)` 下一切手指按钮（含终端键条 `.terminal-key`、`#breakButton`、菜单项）升到 44px。宽屏平板也算粗指针——不要用「宽度 > 900px」推断有鼠标
- **Primary:** 信号绿渐变（135deg, #4dd596→#2fb377）+ 绿底墨色文字 + 辉光投影；仅用于每区一个的主动作（连接、连接 WiFi）
- **Hover / Focus:** hover 边框提亮为信号绿、背景升档；`:active` 下沉 1px 并微缩（translateY(1px) scale(0.99)）；焦点环为焦点蓝 3px 外发光
- **Secondary / Soft:** 面板·浮底色 + 描边，用于次要动作；disabled 统一 opacity 0.4
- **Loading:** 连接中隐藏图标、显示旋转 spinner，按钮文案切换为「连接中…」

**The Touch Target Rule.** 36px 是鼠标场景的硬下限，44px 是手指场景的硬下限；是否算手指只看 `@media (pointer: coarse)`，不看视口宽度。终端键条按这条规则执行——它是「不看也要按对」的那组控件。

### Chips (preset chips / network chips)
- **Style:** 胶囊形（999px），面板·浮底色，等宽 12px，次要色文字
- **State:** hover 边框变绿、文字转正、上浮 1px；disabled 降为 0.4 透明度

### Cards / Containers
- **Corner Style:** 大圆角（18px，`--radius-lg`）
- **Background:** 面板·浮→面板的纵向渐变 + 1px 描边
- **Shadow Strategy:** 停在页面上的卡片用 `--shadow-flat`（见 Elevation）
- **Internal Padding:** 16px；卡片间距 14px
- **Title:** Title 层级 + 信号绿 7px 圆点引导
- **Vertical rhythm:** 一张卡内部的竖向节奏只由**一种**机制决定。`display: grid; gap` 的卡片（`.board-card`、`.bond-card`）里，标题带和子项自带的上下外边距必须清零，否则 gap 会与它们叠加（14 + 14 + 8 = 36px，而 block 卡片是 14px）——同一列的卡片看起来就对不齐。

### Inputs / Fields
- **Style:** 输入底色（比面板更暗的嵌层）、1px 描边、圆角 10px、高 36px
- **Focus:** 边框转焦点蓝 + 3px 蓝色外发光，无 outline
- **Disabled:** 不单独置灰输入框；依赖所属按钮组的禁用态表达

### Selects and option menus

- Single-value settings use the shared `select_controls.js` enhancement. Keep the
  native `<select>` as the source of values, disabled state, form submission and
  `input`/`change` events; expose one themed combobox to assistive technology.
- Triggers share `--control-height`, `--control-radius`, `--control-fill` and
  `--control-edge` with form fields. Menus reuse the opaque `--sticky-surface` and
  `--overlay-shadow`; selected rows show a check, keyboard focus uses the focus
  token. No platform-blue option menu or extra accent colour.
- Menus open in the top layer where supported, fit the visual viewport, flip
  above a low trigger, and scroll internally. Options have 36 px minimum targets,
  raised to 44 px for coarse pointers. Long values wrap inside the menu.
- Editable model IDs and SSIDs retain free text. When suggestions are available,
  a companion arrow opens this same menu; ArrowDown also opens it from the input.
  Selecting a suggestion updates the real input and its events.
- Support arrows, Home/End, PageUp/PageDown, type-ahead, Enter/Space selection,
  Escape cancellation and Tab dismissal. Escape closes the menu before its
  parent drawer; outside clicks dismiss without changing the value.
- Dynamic options, programmatic values, translated labels and disabled states
  must stay in sync. `[hidden]` always removes a control or overlay from layout.

### Assistant transcript and composer

- Keep user input and final answers in the main conversation. Group tool calls
  and intermediate commentary in a per-task Activity disclosure, collapsed by
  default, with a live state, item count and elapsed time. Respect manual expansion.
- Render only reasoning supplied by the model protocol, in its own collapsed
  disclosure. Never invent reasoning or reinterpret ordinary answer text as thought.
- Approval requests, transfer progress, accessory confirmations and choice cards must be visible;
  an approval opens its Activity group, and errors remain inspectable.
- Enter sends; Shift+Enter inserts a newline. While running, Enter queues a
  follow-up and Ctrl/Cmd+Enter steers the current task. IME composition never sends.
- Use quiet conversation surfaces, an inset user bubble, existing focus tokens
  and a growing composer. Hide secondary queue guidance behind a disclosure.

### Assistant choices and terminal ownership

- Assistant questions use an inline fieldset in the tool message: a question,
  2–6 radio or checkbox options with short descriptions, optional free text,
  and an explicit Continue action. Nothing is preselected or sent on selection.
- Choices have 44 px minimum targets, wrap long text, and use existing form,
  focus and panel tokens. Stop, close, mode changes and reconnect retire the
  controls; restored history never reactivates a question.
- Keep terminal ownership status/action and utility actions as separate groups.
  Preserve the full action label; let the groups wrap when their combined width
  exceeds the header, including with the soft keyboard open.

### Inline disclosures
- **Usage:** 低频但相关的设置（高级参数、CLIProxy 导入）收进主卡片底部的
  `.agent-inline-disclosure`：1px 分隔线 + 12.5px 次要色摘要 + 右侧小箭头，默认收起。
- **Cards that are disclosures:** 整张卡片折叠时用 `<details class="card">` 和
  `summary.card-title`，或 `section.card` + `.card-toggle`；两种实现共用同一个
  7×7 / 2px CSS chevron：关闭指向右、展开指向下，24px 按钮，整条标题带可点击。
  两种实现的箭头都对齐到卡片内容区右缘内 8.5px（24px 按钮中心）；不能一左一右。
  关闭态只保留标题带，不留空白 padding。
- **AI settings scroll:** AI 页独占一个滚动区（`.agent-settings-scroll`），底部状态/兜底
  操作是固定 footer。一个页面只有一个滚动条，footer 不覆盖内容。

### Navigation
- 本系统无传统导航。顶栏 = 品牌区 + 状态药丸 + 全局动作（主题/语言/面板开关）；移动端侧栏降级为左滑抽屉（transform 滑入 + 半透明背板）。
- 设置分区名与顺序固定（Connect/Serial/Network/Board/AI/About），但导航组件互斥：≥1101px 显示左侧 rail 时隐藏设置 tab 行；没有 rail 的抽屉/窄屏才显示 tab 行。同一宽度不能同时出现 rail 和“第二条 titlebar”。
- 手机（≤600px）tab 单行显示，AI 不落到第二排；平板/窄桌面（601–1100px）用两行 auto-fit，六个分区全部可见；触屏 tab 高度 44px。
- AI 页（含 MCP 服务器卡）只有一个滚动区：MCP 作为最后一张 card 放在同一个 `.agent-settings-scroll`，固定 footer 不覆盖内容；不要再拆成第二个可滚动页面/并为每张卡单独裁高。
- 手机、平板、桌面使用同一分区名称和顺序，只在面板宽度、rail 是否出现上变化；不因宽度换一套导航模型。
- 桌面打开终端 AI 助手（agent-mode）时 rail 保持可见，不能把 rail 栏留成 56px 空白；移动端抽屉布局本来就没有 rail，行为不变。

### Status Pill (signature)
- 药丸形容器（999px），状态点 9px：红=断连、绿=已连接；已连接时环形脉冲扩散，药丸边框转 45% 绿；设备名以次要色尾随，超长省略。
- ≤600px 药丸只保留色点；设备名在品牌区第二行单独显示，断开时隐藏。601px 起药丸显示设备名。

### Toast
- 底部居中、最多同时 3 条；绿描边为常规，红描边为错误（toast-error）；毛玻璃底 + 上浮淡入，2.2s 自动退场。

### Web Bluetooth guidance
- 仅桌面 Linux 的 web 壳在 `navigator.bluetooth` 缺失或页面不是 secure context 时，
  在 Connection 卡内显示一条内联提示，不自动弹窗；按钮打开说明 dialog。
- dialog 给出可复制的 `chrome://flags/#enable-web-bluetooth`（及两个推荐项）、
  localhost/HTTPS 要求和 BlueZ 检查步骤；LAN 可用时提供“改用 LAN 模式”动作。
- 引导只在 BLE 模式显示，切到 LAN 后隐藏；原生 Android/HarmonyOS 传输不渲染。
- 弹窗沿用 panel/line/input token，移动端按钮不低于 44px，不新增颜色或阴影。

### Terminal
- 日志视图卡内提供可选的「本次 Shell 集成」：说明临时函数、无需 sudo/文件、子进程语义，以及连接/对话重置后需重新启用。显示握手中、已启用、普通跟踪或未确认状态；按钮使用已有 soft 控件，不再挤入终端工具栏。
- 集成只接受本会话 nonce 和顺序匹配的 OSC 开始/结束事件，退出码仍不等于任务验证。停用只切换后续跟踪，不发送清理命令；握手或边界丢失不重发输入。原始导出/WebDAV 继续保留完整 OSC 字节。
- 串口设置内提供「阅读 / 原始」日志视图及两种明确命名的导出按钮，不增加终端工具栏拥挤度。默认阅读视图隐藏当前连接已登记且完整匹配的应用内置探测、只读辅助工具与 Shell 初始化脚本回显；正常任务命令仍显示简化后的原命令，设备输出与错误继续显示。只读分类本身不能隐藏用户或模型直接发起的命令。执行卡片、原始视图与原始导出保留完整内容；不确定的内容按原文显示，禁止全局删除 `LINKR_*`。
- 视图切换只重绘本地缓存，不触发 UART 输入、VT 查询响应或窗口尺寸同步；重绘期间暂时暂停终端输入。显示缓存和接收日志各保留最近 4 MiB；执行证据与板端 WebDAV 保持原始数据。
- Agent 执行卡片优先呈现原始命令，完整发送载荷放入默认收起的「实际发送内容」，退出码和执行日志仍保留。
- 全站最暗表面（#05080d），xterm.js 渲染；头部工具条承载字号/全屏/滚动/复制；连接时标题旁 LED 点亮并泛绿光，输入提示条文字转信号绿。
- 手机键栏默认是 4 列 × 2 行的收藏键网格（48px 高），≤340px 改 3 列（不缩小 44px 触控目标）；平板是 8 键单行（每键 ≤64px），桌面是单行可滚动键带并常显细滚动条；不再用“半截键”当滚动提示。触屏的 More 展开全部键，桌面全部键已在带内。
- 滚动条、焦点环、状态文字和键栏都要在 phone/tablet/desktop 三个断点及 zh/en、light/dark 下验收；触控目标不低于 44px，桌面不低于 36px。

## 6. Do's and Don'ts

### Do:
- **Do** 让绿色只表达「连接/正常/可执行」（The Green Means Go Rule），主动作按钮每区至多一个。
- **Do** 用三级面板色阶 + 每层一个投影 token 表达层级（The One Shadow Per Level Rule）。
- **Do** 给一切数据用等宽字体 + tabular-nums（The Machine Speaks Mono Rule）。
- **Do** 保持按钮触感：hover 提亮边框、active 下沉 1px，过渡 ≤0.15s。
- **Do** 让按钮至少 36px 高，粗指针 44px（The Touch Target Rule）。
- **Do** 为所有动效提供 `prefers-reduced-motion` 降级。

### Don't:
- **Don't** 做成「PuTTY 时代的老旧桌面工具」：灰底、拥挤、无边框层次、系统默认控件外观。
- **Don't** 做成「营销味 SaaS」：hero 区、营销文案卡片、大面积渐变装饰、展示级大标题（The No Display Type Rule）。
- **Don't** 把信号绿当装饰色使用——背景、插画、非语义图形一律禁止（The One Voice Rule）。
- **Don't** 在同一层级发明第二种阴影，也不要写死投影字面量——用 token。
- **Don't** 发明第二套圆角阶梯。
- **Don't** 用 `transition: all`；只过渡明确列出的属性。
- **Don't** 用 box-shadow 做循环动画；脉冲类效果只用 transform/opacity。
