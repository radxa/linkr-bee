# Linkr Bee X1.0（MV013）硬件说明

> 依据 radxa **MV013 / Linkr Bee X1.0** 原理图（单页 A3，REV X1.00）整理，
> 并对照本仓库 `boards/radxa/linkr_bee_x1_0/` 的板级定义与固件实现。
> 本文只描述当前 PCB 上实际存在的器件与网络；任何改动都应以最新原理图和
> 实物为准。

## 1. 板卡概览

| 项 | 内容 |
|----|------|
| 主控 | **ESP32-C3FH4**（QFN32，封装内 4 MB flash，40 MHz 晶振） |
| 无线 | 2.4 GHz 单天线，芯片天线 J3 + π 匹配网络（L1 1 nH 等） |
| 主接口 | USB-C（原生 USB Serial/JTAG，烧录 + console + 供电） |
| 目标板接口 | J7（XH2.54 4P）：UART TX/RX、GND、5 V 输入 |
| 板载外设 | 单线 RGB 状态灯（U1）、BOOT 键（S1）、USER_KEY（SW1）、光耦干接点（Q1 + J5）、红外收发（D7 + IR1）、4 线 GPIO 扩展口（J6） |
| 供电 | USB 5 V 或 J7 外部 5 V 输入，理想二极管 OR、限流开关、5 F 超级电容、3.3 V LDO |
| 固件构建目标 | `west build -b linkr_bee_x1_0 linkr-bee` |

## 2. 电源树

```
USB-C VBUS ─FB1(120R 2A)─ USB_IN ─┐(D3 5.1V 稳压管)
                                  ├─ U9 LM66100 理想二极管 ─┐
J7.4 外部5V ─F1(PTC 1A)─ V5_IN ───┘(D8 5.1V 稳压管)        │
                                   U10 LM66100 理想二极管 ─┘→ 5V_OR
5V_OR ─ U5 WS4612EDA-5 限流负载开关(ISET=R23 6.8K, EN 由 R21 10K 上拉) → +5V
+5V ─ C24 5F/5.5V 超级电容 + TP8(VBAT) + C18 10uF/C19 100nF
    └─ U8 CJ6109B33M LDO(EN 由 R20 10K 上拉, BYPASS=C20 1nF) ─→ +3.3V
```

- **两路 5 V 输入**：USB 与 J7.4 经 U9/U10 做 OR；CE# 交叉互锁（U9.CE#
  接 V5_IN，U10.CE# 经 R34 10K 接 USB_IN），ST/NC 接地。
- **+5V 不是给目标板输出的**：J7.4 是输入，经 F1 后只进 OR 电路。
- **C24 是 5 F 超级电容**：目标板断电后仍可维持一段时间，但当前固件没有
  掉电检测，也没有利用它做“优雅退出”。
- 板上**没有电池与充电管理**，BOM 里也没有电池座。

## 3. ESP32-C3FH4 引脚与固件映射

| GPIO | 芯片脚 | 板上连接 | 固件用途 |
|------|--------|----------|----------|
| GPIO0 | 4 | Q2 栅极（IR 发射管驱动），LEDC CH0 载波 | **IR 发射**（`@r tx`，见第 5 节） |
| GPIO1 | 5 | IRM_V538M3 输出（空闲高、收到载波拉低） | **IR 接收**（NEC 解码，`@r?`） |
| GPIO2 | 6 | 仅 R6 10K 上拉到 3.3 V（strapping） | 不使用 |
| GPIO3 | 8 | SW1 按键到 GND，R5 10K 上拉，C6 100 nF | **USER_KEY**：配对授权 + 恢复出厂（见第 6 节） |
| GPIO4 | 9 | J6.1 + U6 ESD + R19/C29 100R/1µF | 未使用（扩展口） |
| GPIO5 | 10 | J6.2 + U6 ESD + R18/C28 100R/1µF | 未使用（扩展口，ADC 通道） |
| GPIO6 | 12 | J6.3 + U6 ESD + R16/C26 100R/1µF | 未使用（扩展口） |
| GPIO7 | 13 | J6.4 + U6 ESD + R17/C27 100R/1µF | 未使用（扩展口） |
| GPIO8 | 14 | U1 RGBIC 数据输入（R24 0R），R25 10K 上拉，C31 100 nF | **RGB 状态灯**（WS2812 协议）；注意 C31 问题 |
| GPIO9 | 15 | S1 BOOT 按键到 GND，C2 100 nF（R3 未贴） | ROM 下载 strapping；固件不占用 |
| GPIO10 | 16 | Q1 光耦 LED 阴极（阳极经 R13 510R 到 3.3 V） | **光耦干接点**：`@o` 命令控制 |
| GPIO12 | 19 | 网络 “LED”，经 R27 0R(NC) 到 U1 的 DO | 不使用（R27 未贴） |
| GPIO13 | 20 | 空脚 | 不使用 |
| GPIO14–17 | 21–24 | SPI_CSO/CLK/ID/IQ → U4 W25Q32（**NC**，未贴） | 不使用：FH4 内部 flash 占用这些脚 |
| GPIO18/19 | 25/26 | USB-C D−/D+（22R + 共模电感 + ESD） | USB Serial/JTAG console |
| GPIO20 | 27 | J7.1（串 1K + 4.7K 上拉 + TVS） | **桥接 UART0 RX** |
| GPIO21 | 28 | J7.2（串 499R + TVS） | **桥接 UART0 TX** |

其它关键点：

- CHIP_EN（脚 7）→ 网络 RESET，R22 10K 上拉 + C30 100 nF + TP4；**板上没有
  EN/RST 按键**，只能上电复位或用测试点。
- XTAL_P/N（脚 29/30）→ Y1 40 MHz（R1 33R、C1/C4 10 pF）。
- VDDA1/2、VDD3P3_1/2、VDD3P3_CPU、VDD3P3_RTC、VDD_SPI 全部接 +3.3 V。

## 4. 接插件与测试点

| 位号 | 型号 | 定义 |
|------|------|------|
| J4 | TYPE-C-16P | USB 2.0 从机口；CC1/CC2 各 5.1K 下拉；VBUS → FB1 → USB_IN |
| J7 | WAFER-XH254WZ-4A | **1=UART_RX（目标 TX）、2=UART_TX（目标 RX）、3=GND、4=5 V 输入** |
| J6 | SM04B-SRSS-TB | 1=GPIO4、2=GPIO5、3=GPIO6、4=GPIO7（U6 ESD 保护，100R/1µF RC） |
| J5 | 原理图标 SM02B-SRSS-TB | 1/2 = Q1 光敏三极管两端（隔离干接点）；3/4 = GND |
| J3 | KT-CAUT-WD077-A | 2.4 GHz 芯片天线 |
| S1 | TS-1186D-C-A | BOOT（GPIO9，ROM 下载） |
| SW1 | TS_013 | USER_KEY（GPIO3） |
| TP1–TP6 | — | TP1=UART_RX、TP2=UART_TX、TP3=GPIO_8、TP4=RESET、TP5=USB_D−、TP6=USB_D+ |
| TP8 | — | VBAT（+5 V，超级电容节点） |

## 5. 板载外设与固件命令

桥接本身不是本文重点：UART0（GPIO20/21）经 `zephyr,linkr-ble-uart` 作为
桥接串口，console 走 USB Serial/JTAG，与 DevKit 系列一致。X1.0 额外提供三个
板载外设，通过 Management Service 的 `@` 命令控制；网页端和手机端（同一套
Web 资源）都有 **Board / 板载** 页可以操作：

RGB 状态灯默认自动显示：蓝牙连接为蓝色、WiFi 关联为白色、AI 接管为蓝绿色，
优先级 AI > WiFi > 蓝牙。串口收发使当前状态色闪烁；持续流量下为 5 Hz，
RGB 写入总速率最多 25 帧/秒，不按 UART 数据块刷新。未连接时默认熄灭。
所有状态色、串口闪烁、手动预览和自检灯光的 RGB 输出统一按 30% 缩放；
协议中的逻辑颜色值不变。亮度由 `CONFIG_LINKR_BLE_BRIDGE_RGB_BRIGHTNESS` 配置。

| 命令 | 作用 |
|------|------|
| `@l?` | 查询 RGB 状态灯当前颜色 |
| `@l=<r>,<g>,<b>` | 预览颜色 5 秒（0–255 或 0x00–0xff），随后恢复自动状态 |
| `@l off` | 预览熄灭 5 秒，随后恢复自动状态（AI 状态优先） |
| `@o?` | 查询光耦干接点状态 |
| `@o on` / `@o off` | 闭合 / 断开 J5 干接点 |
| `@o pulse <ms>` | 闭合指定毫秒数后自动断开（1–60000） |
| `@r?` | 查询 IR 接收计数与最近一帧 NEC |
| `@r tx <addr>,<cmd>[,<repeats>]` | 发送 NEC 帧（addr 0–0xffff，可扩展地址） |
| `@r rx on\|off` | 使能/关闭 NEC 解码 |
| `@r clear` | 清空最近帧与计数 |
| `@r learn [<slot>]` | 开始学习原始红外帧（槽位 0–7，默认 0） |
| `@r learn stop` | 提前结束学习并保存 |
| `@r play [<slot>]` | 回放学习到的帧 |
| `@r slots` | 列出各槽位的边沿数与占用情况 |
| `@r delete <slot>` | 删除槽位（连同名字，清掉 NVS 里的副本） |
| `@r name <slot>` / `@r name <slot> <hex>` / `@r name <slot> clear` | 读取 / 写入（UTF-8 十六进制，≤32 B）/ 清除槽位名字，随波形存 NVS |
| `@p?` / `@p get [off]` / `@p set <hex>` / `@p clear` | 板载 AI 提示词：一条 ≤240 B，存 NVS；助手在对话开始时读取 |
| `@y?` / `@y begin` / `@y put <hex>` / `@y end` / `@y get [off]` / `@y clear` | 板载 AI 配置：一段 JSON（≤960 B）存 NVS，分块读写；API Key 仅在用户勾选时写入 |
| `@linkr led ...` 等 | 同样的长写法 |

实现要点：

- **RGB 状态灯**：U1 是 WS2812 兼容的单线器件，固件自己产生 1.25 µs 波形
  （`src/linkr_ws2812.c`，RISC-V cycle counter + 关中断 30 µs/像素）；UART
  收发活动使当前状态色闪烁；未连接时使用活动色
  （`CONFIG_LINKR_BLE_BRIDGE_RGB_ACTIVITY_COLOR`，默认暗蓝色）。
- **光耦开关**：GPIO10 拉低点亮 Q1 内部 LED，J5 的 1/2 脚导通，等价于按下
  目标板的复位/电源键。它是“干接点”，与目标板共地（J5 的 3/4 脚是 GND），
  不是电气隔离。
- **红外**：接收端是 38 kHz 解调模块（IRM_V538M3），固件在 GPIO1 边沿中断里
  解码 NEC；发送端用 LEDC CH0 产生 38 kHz 载波，GPIO0 只做载波门控
  （`src/linkr_ir.c` + `src/ir_nec.c`）。载波由硬件产生，软件只负责开关，
  因此发送时序不受 GPIO 抖动影响；整帧约 68 ms 在协作线程里完成。

- **红外学习**：`@r learn` 把接收到的原始 mark/space 时间记录下来（不要求是
  NEC），线路静默 60 ms 后自动收尾，序列化后存进 NVS 并可用 `@r play` 回放。
  波形和槽位名字都只存在 NVS（flash）里：RAM 只保留每个槽位 2 B 的边沿数，
  `@r play` 时才读一次该槽的完整波形到单帧回放缓冲，不再常驻 8 份波形缓存
  （`src/ir_learn.c`）。最多 192 段，NEC 一帧 67 段、RC5 不到 30 段，能覆盖
  常见遥控器；空调这类长帧会被拒绝而不是截断。共 8 个槽位，恢复出厂/擦除
  NVS 会一并清空。回放时较长的间隔用 `k_sleep` 等待，避免长时间占用线程；
  `@r?` 会返回 `learn=idle,slots=已用/总数` 或 `learn=active,slot=..,edges=..`。

固件的两个实时性代价（都不影响桥接主路径，但混用时要知道）：

- RGB 帧在关中断状态下产生（每像素 30 µs），因此 UART 活动闪烁会给中断
  延迟增加最多 30 µs；WS2812 协议本身必须这样做。
- IR 发射整帧约 68 ms 在协作线程里忙等（载波是硬件产生的），期间其它线程
  不运行。WiFi 活跃时发 IR 可能造成丢包，建议避免边传边发；BLE 连接由控制器
  中断维持，不受影响。

Kconfig（仅这些板子会开启）：

| 选项 | 默认 | 说明 |
|------|------|------|
| `CONFIG_LINKR_BLE_BRIDGE_RGB_STATUS_LED` | y（有节点时） | 用 RGB 灯替代普通 GPIO 状态灯 |
| `CONFIG_LINKR_BLE_BRIDGE_RGB_BRIGHTNESS` | 30 | RGB 输出亮度百分比（0–100） |
| `CONFIG_LINKR_BLE_BRIDGE_RGB_ACTIVITY_COLOR` | `0x001830` | 活动闪烁颜色 |
| `CONFIG_LINKR_BLE_BRIDGE_OPTO_SWITCH` | y（有节点时） | 光耦干接点 |
| `CONFIG_LINKR_BLE_BRIDGE_IR` / `_IR_TX` / `_IR_RX` | y（有节点时） | 红外收发 |
| `CONFIG_LINKR_BLE_BRIDGE_IR_LEARN` | y（有节点时） | 红外学习（原始波形捕获/回放 + NVS 持久化） |
| `CONFIG_LINKR_BLE_BRIDGE_IR_LEARN_SLOTS` | 8 | 学习槽位数（1–16，每槽约 400 B NVS + RAM） |
| `CONFIG_LINKR_BLE_BRIDGE_IR_LEARN_MAX_EDGES` | 192 | 单帧最多捕获的 mark/space 段数（16–512） |
| `CONFIG_LINKR_BLE_BRIDGE_IR_LEARN_NAME_MAX` | 32 | 槽位名字最大字节数（8–64，UTF-8，随波形存 NVS） |
| `CONFIG_LINKR_BLE_BRIDGE_IR_LEARN_IDLE_MS` | 60 | 判定一帧结束的静默时间 |
| `CONFIG_LINKR_BLE_BRIDGE_IR_LEARN_TIMEOUT_MS` | 15000 | 一次学习请求的超时 |

## 6. 按键语义

| 按键 | GPIO | 行为 |
|------|------|------|
| USER_KEY（SW1） | GPIO3 | ① 未绑定主机发起配对时按住 → 授权配对；② 上电/复位时按住 ≥2 s → 恢复出厂（清 NVS，不擦固件） |
| BOOT（S1） | GPIO9 | ROM 下载模式（上电时按住）；固件不使用该键做其它功能 |

注意 GPIO9 是 strapping：按住 BOOT 上电会直接进入下载模式，无法在应用里
检测“长按”，因此恢复出厂绑定在 USER_KEY 上，而不是 BOOT。

## 7. 已知硬件问题与注意事项

1. **C31（GPIO8 上 100 nF）会让 RGB 灯无法工作。** 该数据线还有 R25 10K
   上拉，RC 时间常数达毫秒级，而 WS2812 位宽只有 1.25 µs。必须把 C31 改为
   不贴（DNP）或去掉，否则状态灯只会乱闪/不亮。固件无法补偿。
2. **GPIO9 只有内部上拉，R3 未贴，且并联 C2 100 nF。** 上电时该脚上升较慢，
   有误入下载模式的风险；量产建议贴上 R3（10K）或减小 C2。
3. **ESP32-C3FH4 内部 4 MB flash 占用 GPIO12–17（SPI 脚）。** 原理图把
   U4（W25Q32）和 R26/R7/R9/C16 都标了 NC，*不要*在固件里使用这些脚；也
   不要为了“加 flash”去贴 U4，会和内部 flash 冲突。
4. **没有 RTS/CTS**，J7 只引出 TX/RX/GND/5 V，所以硬件流控在本板上不可用。
5. **没有 EN/RST 按键**，只有 TP4 测试点。
6. **J5 的器件型号需要核对**：原理图符号画了 4 个脚（3/4 接地），BOM 标
   SM02B（2 pin）。如果实物是 2 pin，则只有 1/2 脚可用。
7. **超级电容 +5 V 节点（TP8）**：固件目前没有掉电检测，掉电后能撑多久取决
   于负载，不要把它当作可靠的关机流程。
8. **J6 的 GPIO4–7 未使用**：若后续要接 I²C 之类的高速信号，注意板上已有
   100R + 1 µF 的 RC 和 ESD，只适合低速/模拟用途。
9. **GPIO2 只做 strapping 上拉**，没有引出任何网络。

## 8. 构建与烧录

```sh
# 板级定义在本仓库 boards/radxa/linkr_bee_x1_0，
# CMakeLists 已把应用根目录加入 BOARD_ROOT，因此不需要 -DBOARD_ROOT。
west build -b linkr_bee_x1_0 linkr-bee
west flash                      # 或按 tools/flash_firmware.sh 手动烧录
```

- 镜像格式与其他 C3 目标一致（`esp_simpleboot`，烧录地址 `0x0`）。
- CI/发布产物名为 `linkr-bee-linkr-bee-x1-0.bin`（slug `linkr-bee-x1-0`），
  固件包为 `linkr-bee-<tag>-firmware-linkr-bee-x1-0.zip`。
- Console 走 USB-C 的 USB Serial/JTAG；`tools/linkr_ble_terminal.py` 通过
  BLE 连接，桥接串口是 J7 上的 UART。
- CI（`.github/workflows/build.yml`）与 `tools/verify.sh` 已包含该板，并断言
  `SOC_ESP32C3_FH4`、RGB/光耦/IR 相关配置确实开启。
