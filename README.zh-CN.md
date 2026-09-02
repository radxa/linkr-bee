<p align="center">
  <img src="assets/linkr-bee-logo.svg" alt="Linkr Bee" width="520">
</p>

<p align="center">
  面向 Linkr 的终端优先 Bluetooth LE 与局域网串口桥。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="docs/README.md">文档索引</a> ·
  <a href="docs/DEVELOPMENT.zh-CN.md">开发指南</a>
</p>

Linkr Bee 将 SBC 或嵌入式设备的 UART 控制台转换为可通过浏览器、电脑、
移动设备或 Linkr 访问的终端。配件固件基于 Zephyr，支持 ESP32-C3 和
ESP32-C5，广播名称统一匹配 `Linkr BLE UART-*`。

## 为什么需要 Linkr Bee

在开发板启动、Bootloader 调试、网络异常和系统恢复阶段，UART 往往是最后一个
可靠入口。Linkr Bee 让这条控制台不再依赖固定连接在目标设备旁的 USB 转串口线
和电脑。

| 场景 | Linkr Bee 提供的能力 |
| --- | --- |
| 新板启动调试 | 无线查看启动日志并进入第一个交互式 Shell |
| 无头 SBC 运维 | SSH 或网络不可用时仍能进入本地控制台 |
| 现场诊断 | 使用手机、平板、浏览器或 Linkr 访问终端 |
| 桌面开发 | 在一个界面中查看串口、调整 UART、诊断设备并保存日志 |
| 多配件部署 | 按 `Linkr BLE UART-*` 名称前缀发现不同设备 |

Linkr Bee 负责传输目标 UART，不替代目标系统的 Shell，也不会额外注入命令环境。
终端中显示和发送的仍是原本会经过有线串口适配器的字节流。

## 界面总览

![终端优先的 Linkr Bee 桌面界面](assets/screenshots/linkr-bee-terminal-desktop.jpg)

界面以串口终端为视觉和交互核心。终端尺寸不会因为连接状态或日志内容变化而
频繁跳动，便于阅读长启动日志和使用交互式程序。

### 连接与设置

![展开连接与设置面板的 Linkr Bee 桌面终端](assets/screenshots/linkr-bee-terminal-controls.jpg)

连接与设备设置在不使用时可以收起，让串口输出获得尽可能大的显示空间。

- **顶部栏**：连接状态、快速连接、面板开关、主题和语言。
- **终端区域**：基于 xterm.js，支持 ANSI 彩色、选择复制、自动滚动、
  字号调整、全屏和键盘直接输入。
- **控制面板**：BLE/局域网切换、UART 参数、回车格式、设备诊断、WiFi、
  WebDAV 和日志操作。
- **快捷命令与状态栏**：常用 Linux 命令、收发计数、波特率和实时连接状态。

### 手机与平板

<p align="center">
  <img src="assets/screenshots/linkr-bee-terminal-mobile.jpg" alt="Linkr Bee 手机终端界面" width="360">
</p>

在手机和平板上，终端会优先占用可用空间，低频设置收进抽屉；软键盘弹出时，
终端和核心操作仍保持可用。

## 工作方式

```text
浏览器 / 电脑 / 手机 / Linkr
              │
        Bluetooth LE 或局域网
              │
       Linkr Bee 串口配件
        ESP32-C3 / ESP32-C5
              │
          3.3 V UART
              │
        SBC 或嵌入式设备
```

终端数据与管理数据使用独立的 GATT 服务。UART 字节保持透明传输，UART 配置、
WiFi 配网、设备诊断等操作通过带版本的请求/响应通道执行，因此管理命令不会
混入目标设备控制台。

Reliable UART 为 BLE 串口增加序号、确认 indication 和重连状态；同时保留
Nordic UART Service，兼容只需要基础无帧转发的已有客户端。

## 连接方式

| 模式 | 适用场景 | 使用条件 | 可用控制 |
| --- | --- | --- | --- |
| Bluetooth LE | 直接访问、首次配置和故障恢复 | 主机支持 BLE；Web Bluetooth 需要 Chrome/Chromium 和 HTTPS 或 localhost | 终端、UART、WiFi、WebDAV 和诊断 |
| 局域网 WebSocket | 已接入本地网络后的再次连接 | Linkr Bee 已连接 2.4 GHz WiFi | 终端数据通道 |

BLE 是主要配置和恢复入口，因为它不依赖目标系统或本地网络。局域网模式是设备
配置完成后的额外选择，并不替代 BLE。

## 功能

- BLE 到 UART、UART 到 BLE 双向转发，并提供可检测丢包的 Reliable UART 服务。
- UART 参数可配置，适配 SBC 启动日志和交互式 Linux Shell。
- Chrome/Chromium 可通过 HTTPS 或 localhost 使用 Web Bluetooth 终端。
- 提供 Android、iOS 和 HarmonyOS NEXT 原生传输项目。
- 可选 WiFi Station 控制和局域网 UART-over-WebSocket 访问。
- 设备诊断和可选 WebDAV 日志上传。
- 保留 Nordic UART Service 兼容接口，支持已有客户端。

### 终端能力

- 基于 xterm.js 的 ANSI/VT 终端渲染，包括 256 色输出。
- 支持原始、CR、LF 和 CRLF 回车格式，适配不同 Bootloader 和 Shell。
- 可调整终端字体、字号、本地回显、传输分片和 I/O 调试显示。
- 支持选择复制、日志保存、自动滚动、全屏和 `Ctrl-C`。
- 提供常用 Linux 检查命令的快捷发送入口。

### 配件管理

- 查询和修改波特率、数据位、校验位、停止位和流控制。
- 扫描并连接附近的 2.4 GHz WiFi，凭据不会发送到目标 UART。
- 查询固件、UART 缓冲区、WiFi、上传队列和桥接状态。
- 将捕获的日志上传到明确配置的 WebDAV 端点。
- 正常重启后保留配件设置，并提供硬件恢复出厂入口。

## 支持硬件

| 目标 | 定位 | 说明 |
| --- | --- | --- |
| ESP32-C3 Super Mini | 主要小型参考板 | UART 使用 GPIO20/GPIO21，板载蓝色 LED 指示 UART 活动 |
| ESP32-C3 DevKitM / DevKitC | 开发与集成参考板 | Zephyr 应用和板级 overlay 已支持 |
| ESP32-C5 DevKitC | 支持 WiFi 6 的开发目标 | 已包含构建目标，最终内存和无线并发行为需在硬件上验收 |

UART 一侧使用 3.3 V 逻辑电平。必须与目标设备共地，并交叉连接 TX 和 RX；
不能直接连接 RS-232 电平接口。设计自定义硬件前请阅读
[硬件需求](docs/HARDWARE.md)。

## 客户端

| 客户端 | 使用场景 | 当前状态 |
| --- | --- | --- |
| Web 终端 | Chrome/Chromium 桌面访问 | 可用 |
| Python 终端 | macOS、Linux 命令行访问 | 可用 |
| C 终端 | 最小依赖的 Linkr/Buildroot 集成 | 可用 |
| Android 与 iOS | 原生 BLE 传输和共享终端界面 | 已包含工程，仍需真机验收 |
| HarmonyOS NEXT | ArkUI/ArkWeb 宿主和共享终端界面 | 模拟器界面已验证，BLE 需真机验收 |

所有图形客户端共用相同的终端与管理逻辑；在 Web Bluetooth 不可用的平台上，
由对应平台工程提供原生 BLE 传输层。

## 典型使用流程

1. 为 Linkr Bee 和目标设备供电，交叉连接 UART TX/RX，并连接 GND。
2. 打开客户端，选择名称以 `Linkr BLE UART` 开头的设备。
3. 确认 UART 格式与目标一致；默认值为 `115200,8,n,1,n`。
4. 复位或启动目标设备，在终端中查看控制台输出。
5. 目标出现 Bootloader、登录或 Shell 提示符后，直接在终端中输入。
6. 可选配置 WiFi，后续通过局域网模式访问。

串口有数据通过时，活动 LED 会闪烁。如果能看到输出但无法输入，应检查目标 RX
是否连接到 Linkr Bee TX；除非 CTS 和 RTS 均已接线，否则应关闭硬件流控制。

## 开始使用

1. 为支持的 ESP32-C3 或 ESP32-C5 开发板刷入 Linkr Bee 固件。
2. 将目标设备 UART 的 TX、RX 和 GND 接到配件。
3. 打开任一终端客户端，选择名称匹配 `Linkr BLE UART-*` 的设备。
4. 设置与目标一致的 UART 格式，常用值为 `115200,8,n,1,n`。

源码构建、刷写、打包、接线和客户端配置集中放在
[开发指南](docs/DEVELOPMENT.zh-CN.md)中。

## 兼容性说明

- 设备选择按 `Linkr BLE UART` 前缀匹配，因此允许数字或部署专用后缀。
- 默认 UART 格式 `115200,8,n,1,n` 表示 115200 波特率、8 数据位、无校验、1 停止位、无流控。
- Web Bluetooth 面向 Chrome 和 Chromium；Safari 与 Firefox 不提供所需浏览器接口。
- iOS 模拟器无法验证 BLE，Android、iOS 与 HarmonyOS 的 BLE 行为必须使用真机验收。
- 当前固件只支持 2.4 GHz WiFi 配网。
- WebDAV 上传为可选功能，只应连接可信网络中的可信端点。

## 项目状态

- ESP32-C3 与 ESP32-C5 固件目标可在 Zephyr 4.4.1 下完成构建。
- 已包含桌面 Web Bluetooth、Python 与 C 终端路径。
- 共享响应式界面覆盖桌面、手机和平板布局。
- Android 与 iOS 工程已与共享终端界面同步，仍需真机验收。
- HarmonyOS API 26 HAP、ArkWeb 界面和桥接已在模拟器运行，BLE 仍是真机测试边界。

固件构建成功、模拟器启动和主机单元测试都不能替代目标硬件上的端到端 UART
与 BLE 验收。

## 文档

| 主题 | 文档 |
| --- | --- |
| 文档总览 | [docs/README.md](docs/README.md) |
| 构建、刷写、集成与配置 | [开发指南](docs/DEVELOPMENT.zh-CN.md) |
| GATT 与 Reliable UART 协议 | [BLE 配件 API v1](docs/LINKR_BLE_API.zh-CN.md) |
| 开发板接线与电气要求 | [硬件需求](docs/HARDWARE.md) |
| Android 与 iOS 客户端 | [mobile/README.md](mobile/README.md) |
| HarmonyOS NEXT 客户端 | [harmonyos/README.md](harmonyos/README.md) |

## 安全说明

当前固件按设计开放 BLE 访问，不要求配对或绑定。应将 Linkr Bee 视为本地、
需要物理接触的控制台配件；在实现设备归属和授权机制前，不应把它作为远程
管理接口暴露。

## 许可证

许可证条款见 [LICENSE](LICENSE)。
