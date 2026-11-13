# Linkr Bee 用户说明书

Linkr Bee 将目标设备的 UART 串口控制台通过蓝牙或局域网连接到电脑。你可以使用命令行、终端界面、网页，或在 DeepSeek Harness、OpenCode 中使用 Bee 插件操作同一台设备。

本文以 **Linkr Bee X1.0（MV013）** 为例。其他支持的开发板在引脚、配对方式和可用功能上可能不同，接线前请查阅[硬件需求](HARDWARE.md)。

## 1. 硬件说明

### 1.1 接口和按键

| 部件 | 用途 |
| --- | --- |
| USB-C | 5 V 供电、固件刷写及 USB 调试接口。 |
| J7 | 连接目标设备的 UART 和可选的 5 V 输入，见下表。 |
| USER_KEY | 正常运行时按一下，打开新主机的蓝牙配对授权窗口。 |
| BOOT | 上电时用于进入芯片下载模式。 |
| RGB 状态灯 | 显示连接、助手与串口活动状态。 |
| J5 | 光耦开关接点，可用于连接目标的复位或电源按键电路；请先核对目标电路与实物接口。 |
| 红外收发 | 支持 NEC 收发及红外信号学习、保存和回放，具体功能取决于固件。 |
| J6 | GPIO 扩展口，默认固件未用于通用扩展功能。 |

**J7 引脚按板上标号辨认：**

| J7 引脚 | Bee 信号 | 连接目标设备 |
| --- | --- | --- |
| 1 | UART RX | 目标 TX |
| 2 | UART TX | 目标 RX |
| 3 | GND | 目标 GND |
| 4 | 5 V 输入 | 可选的外部 5 V 电源输入；不是给目标供电的输出 |

接线前先关闭电源，确认目标串口使用 **3.3 V 逻辑电平**，不要直接连接 RS-232 电平或 5 V 逻辑串口。TX、RX 交叉连接并共地；目标设备仍需自己的电源。Bee 可由 USB-C 或 J7 的 5 V 输入供电。J7 未引出 RTS/CTS，串口硬件流控应关闭。

X1.0 的原理图、J5 实物接口及已知 PCB 注意事项见 [X1.0 硬件说明](BEE_X1.0_HARDWARE.md)。例如，原理图中 RGB 数据线的 C31 可能导致灯不工作；实际板卡请以版本和实物为准。J5 电路与目标共地，不应将整套接线视为完全电气隔离。

### 1.2 首次连接

1. 确认 Bee 已刷入适合板型的固件；将目标 TX、RX 和 GND 按上表接好，然后给两侧上电。
2. 在主机上启用蓝牙。X1.0 首次连接新主机时，短按 **USER_KEY**，在默认 30 秒内发起连接并接受系统配对提示。已绑定的主机重连通常不需要再次按键。
3. 默认广播名为 `Linkr Bee XXXX`，其中 `XXXX` 是硬件 MAC 的后四位；名称也可能已被修改。多台设备附近时，请核对设备标识。
4. 在所选客户端中连接，并把 UART 设置为目标设备的串口格式。Bee 默认是 **115200、8 数据位、无校验、1 停止位、无流控（115200 8N1）**。
5. 在终端按回车，或复位目标设备，查看输出和登录提示。Bee 只转发串口字节，目标系统是否需要登录取决于目标设备。

普通 C3/C5 开发板默认用 GPIO1 对地授权配对；WROOM 默认关闭物理配对授权。具体板型、绑定恢复和授权窗口见[蓝牙配对说明](BLE_PAIRING.md)。

## 2. 安装与使用

### 2.1 刷入固件

固件在 **Zephyr v4.5.0** 工作区中构建，使用 Zephyr SDK 1.0.1。首次搭环境和工具链安装见[开发指南](DEVELOPMENT.md)。以 X1.0 为例：

```sh
cd linkr-bee
west build -p always -b linkr_bee_x1_0 .
west flash
```

`west flash` 使用板级 esp32 runner，从 `0x0` 写入，只覆盖镜像扇区，因此正常升级会保留 NVS 中的配置和配对记录。连接了多块板时显式指定端口：

```sh
west flash --esp-device /dev/cu.usbmodemXXXX
```

X1.0 的 USB-C 同时是供电、烧录和调试口。烧录完成后如果电脑能看到 USB 串口但搜不到蓝牙，先检查烧录结果和 USB 调试日志；仅凭串口枚举不能判断芯片是否停在 ROM 下载模式。若日志确认仍在 ROM 下载模式，可拔插一次 USB，或执行 `esptool --port <端口> --after watchdog-reset read-mac` 让应用重新启动。

如果使用 GitHub Releases 中的预编译镜像，解压后进入目录运行 `flash_firmware.sh`。脚本按镜像文件名推断芯片和写入地址，不做全片擦除：

```sh
./flash_firmware.sh --port /dev/cu.usbmodemXXXX
```

刷写前先确认镜像与板型匹配。需要清除配置或从绑定异常中恢复时，使用[配对与恢复说明](BLE_PAIRING.md)中的恢复流程，而不是全片擦除。其他板型的构建命令和排障细节见[开发指南](DEVELOPMENT.md)。

### 2.2 CLI：命令行客户端

`bee-cli` 适合扫描设备、查询或修改 Bee 设置，以及在目标 Shell 上执行单条命令。它不包含交互式 TUI。

#### 安装

需要 Node.js **18 或以上**、npm 和可用的蓝牙适配器。Linux 使用蓝牙时还需要运行 BlueZ 蓝牙服务；系统需有相应的 D-Bus 运行库。安装：

```sh
npm install -g linkr-bee-cli
bee-cli --version
bee-cli --help
```

npm 包首次运行时会从项目发行版下载对应平台的 CLI 二进制、校验 SHA256 并缓存，需要网络连接。若全局安装后找不到 `bee-cli`，检查 npm 全局可执行文件目录是否在 `PATH` 中。也可不做全局安装，使用 `npx linkr-bee-cli --help`。

预编译包支持 macOS、Windows 和 glibc Linux 的常见架构；具体架构及其他安装方法见 [CLI npm 说明](../tools/linkr-tui/npm/README.md)。

#### 常用命令

首次连接前按第 1.2 节授权配对。以下命令中的设备名仅为例子，请替换为扫描结果中的实际名称；名称可能不唯一。

```sh
bee-cli --help                                 # 所有参数
bee-cli --version                              # 版本
bee-cli --scan                                 # 扫描附近设备
bee-cli --ble-name "Linkr Bee 078C" --query-info  # 查询 Bee 诊断信息
bee-cli --ble-name "Linkr Bee 078C" --query-uart  # 查询串口设置
bee-cli --ble-name "Linkr Bee 078C" --uart 115200,8,n,1,none
bee-cli --ble-name "Linkr Bee 078C" --query-wifi  # 查询 WiFi 状态
bee-cli --ble-name "Linkr Bee 078C" --exec "uname -a"
```

`--uart` 会修改 **Bee 的串口配置**，应先确认与目标一致。`--exec` 则将命令发到**目标设备的串口 Shell**；先确保目标已登录并停在空闲的 POSIX Shell，执行前检查命令内容。它在子 Shell 中运行，`cd` 等修改不会保留到交互 Shell。查询和配置 Bee 的管理命令需要 BLE；LAN 链路用于串口数据，不能代替 BLE 管理通道。

多台设备同名时，可用 `--ble-address <设备标识>` 指定扫描结果：Linux / Windows 通常使用蓝牙地址，macOS 使用系统提供的 CoreBluetooth UUID。脚本可用 `--json` 输出 JSON Lines，`--capabilities` 查看能力；完整参数以 `bee-cli --help` 和 [CLI 手册](../tools/linkr-tui/README-cli.md)为准。

### 2.3 TUI：终端界面

`bee` 是带交互界面的桌面终端程序，也包含 CLI 能力。前面 npm 安装的 `bee-cli` 不会安装 TUI。

#### 安装

从 [Linkr Bee Releases](https://github.com/radxa/linkr-bee/releases) 选择 `linkr-tui-v...` 发行版，下载与系统及 CPU 架构匹配的 **`linkr-bee-...` 界面版**，不要选 `linkr-bee-cli-...`。使用发行版中的 `SHA256SUMS` 校验下载文件。

- **macOS**：选择 Apple Silicon（`aarch64`）或 Intel（`x86_64`）的 `.dmg` / `.tar.gz`，取出 `bee`。
- **Linux**：选择对应架构的 `.tar.gz` 并解压；Debian / Ubuntu 也可选择对应架构的 `.deb` 安装包。蓝牙连接需要运行 BlueZ 和 D-Bus；压缩包运行环境还需系统的 `libdbus-1` 运行库。
- **Windows**：选择对应架构的 `.zip`，解压后运行 `bee.exe`。

在解压目录中打开终端，macOS / Linux 运行 `./bee`，Windows PowerShell 运行 `.\bee.exe`。也可以将程序放入系统的 `PATH`，之后直接运行 `bee`。以实际发行版文件名和支持平台为准。

```sh
./bee --version
./bee --help
./bee
```

无需硬件可用 `./bee --bridge -` 打开离线回环演示；它不代表真实蓝牙或目标设备连接。

#### 使用

1. 按第 1.2 节接线、供电和授权配对。
2. 启动 `bee`，按 **Ctrl+↑** 聚焦导航，选择 **连接** 并按 Enter；首次蓝牙连接时选择设备并完成系统配对。
3. 打开串口设置，确认波特率及其他格式与目标一致。进入终端后按回车，查看目标提示符。
4. 在终端直接输入；需要退出 Bee 时按 **Ctrl+Q**。终端聚焦时，Ctrl+C 发送给目标以中断目标程序。

| 按键 | 功能 |
| --- | --- |
| F1 | 帮助 |
| F2 / F4 / F5 | 终端 / 网络 / 助手工作区 |
| F3 | 设备信息 |
| F6 / F7 / F8 | 助手面板 / 导航栏 / 聚焦与恢复布局 |
| Ctrl+P | 搜索命令面板 |
| Ctrl+S | 助手模型设置 |
| Ctrl+Q | 退出 |

网络页面可管理 WiFi 等设置；助手需要配置自己的模型端点和凭据。完整快捷键以界面中的 F1 帮助及 [TUI 说明](../tools/linkr-tui/README.md)为准。

### 2.4 Web UI：网页终端

#### 启动与连接

Web 蓝牙需要支持 Web Bluetooth 的浏览器，例如桌面 Chrome / Chromium；在本机 `localhost` 或其他安全上下文中打开页面。用仓库源码启动本地页面：

```sh
# 在 linkr-bee 仓库根目录运行
sh tools/serve_web.sh
```

浏览器打开 `http://127.0.0.1:8765/`，并保持服务运行。然后：

1. 按第 1.2 节接线、供电和授权配对。
2. 在网页点击**连接**，从浏览器设备列表选择 Bee，并按系统提示完成配对。
3. 在**设置 → 串口**中检查 UART 格式，回到终端按回车或复位目标查看输出。
4. 在终端直接输入；工具栏提供复制、字号、全屏和助手入口。设置面板还可查看设备信息、网络和日志。

X1.0 支持的固件会显示**板载**功能，可操作状态灯、J5 接点和红外；界面会根据设备能力显示可用功能。没有硬件时，可打开 `http://127.0.0.1:8765/?demo=board` 预览模拟设备。

#### 局域网与助手

先通过 BLE 在**网络**中配置 Bee 加入 2.4 GHz WiFi，再在连接设置中选择局域网并填写地址和令牌。局域网 WebSocket 用于串口数据，管理配置仍需 BLE；`ws://` 流量未加密，请在可信网络中使用。

打开终端的 **AI** 入口，可在助手设置中配置模型服务、端点及 API Key。发送日志或让助手操作目标前，检查将要发送的数据和命令；连接成功或输入已发送不代表目标操作成功。更多界面操作、日志和助手设置见[网页使用指南](USAGE.zh-CN.md)。

### 2.5 DeepSeek Harness：安装并使用 Bee 插件

[dsh-linkr-bee](../linkr-bee-dsh/README.md) 为 DeepSeek Harness（`dsh`）增加串口面板和 Agent 工具。需要 Node.js **22 或以上**及兼容的 Harness：本仓库插件声明 `>=0.2.0-rc.1 <0.3.0`，并标记 `0.2.1-rc.5` 兼容。Harness 的安装与启动方式见 [DeepSeek Harness 官方项目](https://github.com/deepseek-ai/deepseek-harness)，使用前请核对版本。

1. 启动兼容版本的 Harness，在界面的 **Plugins → install** 输入 `dsh-linkr-bee` 并安装。也可在已安装 `dsh` 命令的环境中，为相应 profile 安装：

   ```sh
   dsh plugin --profile <profile> add dsh-linkr-bee
   ```

2. 重启应用或重新加载页面，使插件加载。插件依赖 `linkr-bee-cli`；首次使用启动器时可能需要联网下载并校验对应平台的二进制。若自动查找失败，可单独执行 `npm install -g linkr-bee-cli`，或者在插件设置中填写 `cliPath`。
3. 按第 1.2 节准备 Bee；在 Harness 首页选择 **Serial monitor**，或打开右侧栏并选择该面板。
4. 点面板的齿轮，选择 `ble`，按需要填写设备名称或设备标识，连接后完成系统配对。也可选择 `lan` 并填写地址与令牌，或选择 `loopback` 进行离线体验。
5. 在串口面板输入、登录目标并查看输出。可向 Agent 请求读取控制台、查询 Bee 状态或执行明确的目标命令；Agent 和用户共用同一串口会话，操作时避免同时输入未完成的命令。

面板提供 Reading / Raw 视图；两者切换只改变本地显示。BLE 管理查询和设置需要 BLE 连接，LAN 只传输串口数据。连接断开时可使用面板中的 **Reconnect**，配置项和故障排查见[插件说明](../linkr-bee-dsh/README.md)。

### 2.6 OpenCode：安装并使用 Bee 插件

[opencode-linkr-bee](../linkr-bee-opencode/README.md) 为 [OpenCode](https://opencode.ai) 2.x 编程 Agent 提供五个板卡工具和一条共享的实时串口控制台。需要 OpenCode **2.x**（已在 2.2.7 验证）、Node.js **22 或以上**，以及 `bee-cli` **1.2.0 或以上**；控制台还要求 `bee-cli` 带 `watch`（或 `monitor`）与 `resize` 操作，版本过旧时面板会给出提示。

1. 执行 `opencode plugin add opencode-linkr-bee` 安装插件，OpenCode 2.x 会把它写入全局配置。可用 `opencode plugin list` 确认已加载；`opencode plugin update opencode-linkr-bee` 与 `opencode plugin remove opencode-linkr-bee` 用于更新和卸载。
2. 也可以在任意生效的 `opencode.json` 中手工配置（项目根目录、`.opencode/opencode.json` 或 `~/.config/opencode/opencode.json`）。2.x 的配置键是 `"plugins"`，带选项的条目是对象：

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       { "package": "opencode-linkr-bee", "options": { "transport": "ble" } }
     ]
   }
   ```

   本地开发时把 `package` 指向插件目录的路径即可（必须是含 `package.json` 的目录，单个文件会被跳过）。
3. 重启 OpenCode 会话或服务使插件加载。插件把 `linkr-bee-cli` 声明为依赖，正常安装会一并带上；首次调用仍可能需要联网下载并校验对应平台的二进制。若自动查找失败，可单独执行 `npm install -g linkr-bee-cli`，或在插件选项中填写 `cliPath`。
4. 按第 1.2 节准备 Bee 并完成配对，然后打开共享控制台——Agent 工具和所有面板看到的是同一条会话和同一批字节：
   - **TUI 面板**：在 OpenCode 终端界面按 Ctrl+Shift+L（终端无法发送 Ctrl+Shift 时用 Ctrl+L），或在命令面板选择 **Linkr Bee: open console**，或输入 `/linkr-bee`。`/linkr-bee` 还接受 `send <文本>`、`ctrl-c`、`clear`、`raw`（切换 Reading/Raw）和 `reconnect`。配对与设置同样在 TUI 里完成：命令面板 **Linkr Bee: board / pair…** 可扫描并连接板子、重连已保存板子或查看状态；**Linkr Bee: settings…** 可改传输方式、LAN 令牌、`bee-cli` 路径、超时、桥接 UART 和浏览器页开关；也可直接输入 `/linkr-bee scan`、`/linkr-bee settings`、`/linkr-bee status`。Reading 视图是过滤后的文本日志，底部有一行输入框；Raw 视图在支持内嵌终端的宿主上是真正的 VT100 终端，全屏程序、方向键菜单和 curses 界面可用（宿主较旧时回退为文本日志）。
   - **桌面应用面板**：在 OpenCode 桌面应用窗口中使用命令 **Linkr Bee: toggle console**（默认快捷键 Ctrl+\`），或会话侧栏 **+** 菜单中的 **Linkr Bee console**。该面板只在桌面应用窗口中加载；`opencode serve` 的浏览器 Web UI 不加载 GUI 插件，浏览器标签页看不到它。桌面版在 **设置 → Linkr Bee** 提供同一套配置页（扫描/连接/传输/UART/浏览器页），面板头部的 ⚙ 也直达该页。
   - **浏览器控制台页面**：插件启动一个仅限本机的页面，地址形如 `http://127.0.0.1:<port>/?t=<token>`，由控制台的 `webUrl`（或 `state.webUrl`）给出；页面提供 Reading/Raw、Clear、Reconnect 和 Copy URL。配置项 `webConsole`（环境变量 `LINKR_BEE_WEB_CONSOLE`，默认开启）可关闭。该地址包含访问令牌，只在本机使用，不要发给他人。
5. 让 Agent 调用工具：`linkr_bee_exec` 在目标 UART 控制台执行命令并返回输出，`linkr_bee_query` 读取桥接与链路状态，`linkr_bee_send` 发送输入并捕获回复窗口，`linkr_bee_set` 修改桥接设置，`linkr_bee_console` 驱动共享控制台（`open`/`focus`/`clear`/`type`/`key`/`read`/`state`/`resize`）。传输方式（`ble` / `lan` / `loopback`）和其余配置项见[插件说明](../linkr-bee-opencode/README.md)。

面板和工具共用同一条串口会话与同一条 BLE 链路，一次只有一个连接；Agent 调用一次性工具时会短暂接管链路。没有板子或 `bee-cli` 时面板仍会打开并显示离线提示。三个面板的状态栏都会显示桥接实际上报的 UART 波特率（未知时不显示）。设置页/TUI 菜单保存的值写在插件自己的 `$XDG_STATE_HOME/opencode/linkr-bee.json`（默认 `~/.local/state/opencode/linkr-bee.json`），优先级为设置文件 > `opencode.json` 的 `options` > 环境变量 > 默认值。

## 3. 常见问题

| 现象 | 检查 |
| --- | --- |
| 搜不到 Bee | 确认 Bee 供电、蓝牙已打开且距离合适；先用 `bee-cli --scan` 检查。 |
| 首次配对失败 | X1.0 短按 USER_KEY 后在 30 秒内重新发起连接，并接受系统提示；其他板型核对其配对引脚。 |
| 有乱码 | 检查共地、目标与 Bee 的波特率和串口格式是否一致，以及目标输出编码。 |
| 有输出但无法输入 | 检查目标 RX 是否接 Bee TX、流控是否关闭，并确认目标是否等待登录或其他输入。 |
| 没有输出 | 检查供电、目标 TX 到 Bee RX、共地和波特率；按回车或复位目标。 |
| CLI 或插件首次运行下载失败 | 检查网络、发行版是否提供当前平台的二进制；查看 [CLI 安装说明](../tools/linkr-tui/npm/README.md)。 |
| 配对记录异常 | 按[配对与恢复说明](BLE_PAIRING.md)检查主机和 Bee 的绑定；恢复出厂会清除 Bee 保存的配置与绑定。 |

更多问题见[项目常见问题](../README.zh-CN.md#常见问题)。
