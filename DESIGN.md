---
name: Linkr Bee Terminal
description: 浏览器里零安装的串口终端——BLE / 局域网直连 ESP32-C3 桥接器
colors:
  signal-green: "#3fc88a"
  signal-green-bright: "#6fe0ab"
  ink-on-green: "#052517"
  focus-blue: "#7aa8f8"
  danger-red: "#f2777c"
  bench-bg: "#090d14"
  panel: "#11161f"
  panel-raised: "#151b26"
  panel-inset: "#1c2330"
  terminal-bg: "#05080d"
  input-bg: "#0e131c"
  text: "#e8eef7"
  text-muted: "#8d9bb0"
  text-placeholder: "#7b8ba1"
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
  lg: "16px"
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
- **信号绿·亮 Signal Green Bright** (#6fe0ab): hover 态与深色底上的绿色文字（终端提示、RSSI 读数、预览 glyphs）。
- **绿底墨色 Ink on Green** (#052517): 主按钮上的文字色，保证绿底对比度。

### Secondary
- **焦点蓝 Focus Blue** (#7aa8f8): 仅用于键盘焦点环与输入框 focus 描边，与绿色语义严格分离。

### Tertiary
- **警示红 Danger Red** (#f2777c): 断连状态点、错误 toast 描边。不用于装饰。

### Neutral
- **工作台底 Bench Background** (#090d14): 页面底色，带两团极淡的绿/蓝径向辉光。
- **面板 Panel** (#11161f) / **面板·浮 Panel Raised** (#151b26) / **面板·嵌 Panel Inset** (#1c2330): 三级面板阶梯，卡片用浮层渐变，输入框与芯片用嵌层。
- **终端底 Terminal Background** (#05080d): 全站最暗的表面，只属于串口输出区。
- **正文 Text** (#e8eef7) / **次要 Text Muted** (#8d9bb0) / **占位 Text Placeholder** (#7b8ba1): 三级文字阶梯，占位色对比度 ≥4.5:1。
- **描边 Border** (#242d3d) / **描边·强 Border Strong** (#33405a): 静态边框与 hover 加亮边框。

### Named Rules
**The One Voice Rule.** 信号绿在任意屏幕上的占比不超过 10%。它的稀缺就是它的语义——满屏绿色等于没有绿色。

**The Green Means Go Rule.** 绿色禁止用于纯装饰（插画、背景渐变主体、营销图形）。用户看到绿色就必须能回答：什么通了？

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
- **面板投影 Panel Shadow** (`0 8px 24px rgba(2,6,16,0.42), 0 2px 6px rgba(2,6,16,0.28)`): 顶栏、卡片、状态栏、toast 共用的唯一投影。
- **主按钮辉光 Primary Glow** (`0 6px 16px rgba(47,179,119,0.3), inset 0 1px 0 rgba(255,255,255,0.18)`): 仅主按钮与 logo，hover 时加深。
- **连接脉冲 Connected Pulse** (状态点 `::after` 环形扩散，transform/opacity): 仅已连接状态点，纯合成层动画。

### Named Rules
**The One Shadow Rule.** 全站只有一种面板投影。需要「更高」的层级时，用色阶和描边解决，不发明新阴影。

## 5. Components

### Buttons
- **Shape:** 利落小圆角（10px），高度 36px，内边距 0 13px
- **Primary:** 信号绿渐变（135deg, #4dd596→#2fb377）+ 绿底墨色文字 + 辉光投影；仅用于每区一个的主动作（连接、连接 WiFi）
- **Hover / Focus:** hover 边框提亮为信号绿、背景升档；`:active` 下沉 1px 并微缩（translateY(1px) scale(0.99)）；焦点环为焦点蓝 3px 外发光
- **Secondary / Soft:** 面板·浮底色 + 描边，用于次要动作；disabled 统一 opacity 0.4
- **Loading:** 连接中隐藏图标、显示旋转 spinner，按钮文案切换为「连接中…」

### Chips (preset chips / network chips)
- **Style:** 胶囊形（999px），面板·浮底色，等宽 12px，次要色文字
- **State:** hover 边框变绿、文字转正、上浮 1px；disabled 降为 0.4 透明度

### Cards / Containers
- **Corner Style:** 大圆角（16px）
- **Background:** 面板·浮→面板的纵向渐变 + 1px 描边
- **Shadow Strategy:** 唯一的面板投影（见 Elevation）
- **Internal Padding:** 16px；卡片间距 14px
- **Title:** Title 层级 + 信号绿 7px 圆点引导

### Inputs / Fields
- **Style:** 输入底色（比面板更暗的嵌层）、1px 描边、圆角 10px、高 36px
- **Focus:** 边框转焦点蓝 + 3px 蓝色外发光，无 outline
- **Disabled:** 不单独置灰输入框；依赖所属按钮组的禁用态表达

### Navigation
- 本系统无传统导航。顶栏 = 品牌区 + 状态药丸 + 全局动作（主题/语言/面板开关）；移动端侧栏降级为左滑抽屉（transform 滑入 + 半透明背板）。

### Status Pill (signature)
- 药丸形容器（999px），状态点 9px：红=断连、绿=已连接；已连接时环形脉冲扩散，药丸边框转 45% 绿；设备名以次要色尾随，超长省略。

### Toast
- 底部居中、最多同时 3 条；绿描边为常规，红描边为错误（toast-error）；毛玻璃底 + 上浮淡入，2.2s 自动退场。

### Terminal
- 全站最暗表面（#05080d），xterm.js 渲染；头部工具条承载字号/全屏/滚动/复制；连接时标题旁 LED 点亮并泛绿光，输入提示条文字转信号绿。

## 6. Do's and Don'ts

### Do:
- **Do** 让绿色只表达「连接/正常/可执行」（The Green Means Go Rule），主动作按钮每区至多一个。
- **Do** 用三级面板色阶 + 唯一面板投影表达层级（The One Shadow Rule）。
- **Do** 给一切数据用等宽字体 + tabular-nums（The Machine Speaks Mono Rule）。
- **Do** 保持按钮触感：hover 提亮边框、active 下沉 1px，过渡 ≤0.15s。
- **Do** 为所有动效提供 `prefers-reduced-motion` 降级。

### Don't:
- **Don't** 做成「PuTTY 时代的老旧桌面工具」：灰底、拥挤、无边框层次、系统默认控件外观。
- **Don't** 做成「营销味 SaaS」：hero 区、营销文案卡片、大面积渐变装饰、展示级大标题（The No Display Type Rule）。
- **Don't** 把信号绿当装饰色使用——背景、插画、非语义图形一律禁止（The One Voice Rule）。
- **Don't** 发明第二种面板阴影或第二套圆角阶梯。
- **Don't** 用 `transition: all`；只过渡明确列出的属性。
- **Don't** 用 box-shadow 做循环动画；脉冲类效果只用 transform/opacity。
