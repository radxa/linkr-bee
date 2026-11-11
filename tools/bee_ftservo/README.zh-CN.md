# Linkr Bee 调试飞特舵机（FTServo_Python 桥接）

用 Linkr Bee 当无线串口适配器，把 [FTServo_Python](https://github.com/ftservo/FTServo_Python)
（`ftservo-python-sdk`）的协议层直接跑到飞特总线舵机（STS/SMS/SCS，例如 STS3215）上：
电脑只连蓝牙，不插 USB-TTL，也不用把线拉到机器人旁边。

English: [README.md](README.md)

浏览器里还有一个同源实现：[web/servo.html](../../web/servo.html)。它在 JS 里实现了
同一套飞特协议并用 Web Bluetooth 直接连 Bee，不需要 Python 或主机进程。页面按官方
调试工具分成两个页签：调试（普通/同步/异步写、实时反馈、可导出 CSV 的实时曲线、
步进/连续扫描自动测试）和编程（参数表、JSON 参数备份/载入/恢复、中位校准）。
适合临时调试，脚本和 Agent 场景仍用下面的 Python 工具。

## 拓扑

```text
电脑：bee_ftservo.py + ftservo-python-sdk
        │  BLE：Nordic UART 原始字节 + Management v1 控制命令
        ▼
Linkr Bee ── J7 UART ──► 飞特半双工总线 ──► 舵机
   │
   └─ @u=1000000,8,n,1,none 在运行时改总线波特率
```

Bee 的 NUS 特征本来就是双向原始字节管道，Management 服务可以随时改 UART
参数，所以“舵机总线”就是一条 15–40 ms 之外、可以改波特率的串口。

## 接线（Linkr Bee X1.0，J7）

| J7 | 信号 | 接到哪里 |
| --- | --- | --- |
| 1 | UART RX（GPIO20） | 舵机信号线，和 J7.2 短接 |
| 2 | UART TX（GPIO21） | 舵机信号线，和 J7.1 短接 |
| 3 | GND | 舵机 GND **和** 舵机电源 GND |
| 4 | 5 V **输入** | 悬空。这是给 Bee 供电的，不会给舵机供电 |

飞特总线舵机只有一根信号线，所以把 **J7.1 和 J7.2 短接**后接舵机信号脚即可。
X1.0 的板级设计正好让这个接法安全：J7.1 有 4.7 kΩ 上拉和 1 kΩ 串阻，J7.2 有
499 Ω 串阻，Bee 空闲时舵机驱动这根线只会和 499 Ω 对抗（约 6.6 mA）。这和
[ESP32 直连 ST3215](https://github.com/sepastian/ESP32_ST3215) 用 10 kΩ 把
TX/RX 短接是同一个思路。

- 舵机**单独供电**（按型号 6–12 V），电源地必须和 J7.3 共地；不要从 Bee 取电。
- 总线是 3.3 V TTL。STS3215 是 3.3 V 器件；老的 SCS 系列可能 5 V 空闲，需要
  先加电平转换再进 J7。
- 信号线尽量短（几十厘米内）。**不要**让 J7 同时接着目标板的 console——舵机
  总线和 console 不能共用同一个 UART。
- 如果用的是带方向控制的半双工转接板（TX 控制收发器 OE），就没有回显，工具同样
  支持，见 `--echo`。

## 安装

```sh
python3 -m pip install bleak ftservo-python-sdk
```

`bleak` 是主机 BLE 栈，`ftservo-python-sdk` 提供 `sms_sts` 和协议 packet
handler。

## 快速开始

```sh
# 看连接、管理协议、当前 UART 参数
python3 tools/bee_ftservo/bee_ftservo.py info

# 扫描 1–12 号舵机；结束后把 Bee 的 UART 参数恢复原样（继续当 console 用）
python3 tools/bee_ftservo/bee_ftservo.py --restore-uart scan --ids 1-12

# 读状态、动一下、盯着看
python3 tools/bee_ftservo/bee_ftservo.py status 1
python3 tools/bee_ftservo/bee_ftservo.py move 1 2048 --speed 2400 --acc 50
python3 tools/bee_ftservo/bee_ftservo.py monitor 1 --hz 5

# 排线用：直接发一个 ID 1 的 PING 包
python3 tools/bee_ftservo/bee_ftservo.py raw ff ff 01 02 01 fb

# 没有硬件也能跑：内置一个模拟舵机总线
python3 tools/bee_ftservo/bee_ftservo.py --simulate selftest
python3 tools/bee_ftservo/bee_ftservo.py --simulate scan --ids 1-4
```

模拟总线默认按“TX/RX 短接”建模（有回显）；`--sim-no-echo` 则模拟带方向控制
的转接板（没有回显）。

当作库用（和原始示例一样，只是把 `PortHandler` 换成 Bee 版）：

```python
from bee_ftservo import BeeLink, open_packet_handler
from scservo_sdk import SMS_STS_TORQUE_ENABLE

link = BeeLink(name="Linkr Bee").open()
handler, packet = open_packet_handler(link, baud=1000000)
packet.write1ByteTxRx(1, SMS_STS_TORQUE_ENABLE, 1)
packet.WritePosEx(1, 2048, 2400, 50)
print(packet.ReadPos(1))
handler.closePort()
link.close()
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `info` | BLE 链路、管理协议版本、当前 UART 参数、控制权归属 |
| `scan --ids 1-253` | 逐个 ping，读回应答舵机的型号 |
| `ping ID` | 单次 ping |
| `status ID` | 位置、速度、负载、电压、温度、运动标志、电流 |
| `read ID ADDR LEN` | 直接读内存表 |
| `write ID ADDR HEX` | 直接写内存表 |
| `move ID POS [--speed S --acc A]` | 开力矩 + `WritePosEx` |
| `torque ID on\|off` | 力矩开关 |
| `wheel ID SPEED` | 轮模式 + 速度 |
| `monitor ID --hz 5` | 连续读位置/速度 |
| `raw HEX...` | 发原始字节并打印回包（排线用） |
| `selftest` | 模拟总线上的 ping/读/写/同步写/超时自查 |

常用参数：

- `--address` / `--name`：连哪块 Bee（默认 BLE 名字前缀 `Linkr Bee`）。
- `--baud`：舵机总线波特率，默认 `1000000`；飞特常用的 `500000`、`250000`、
  `115200`、`76800` 都行，Bee 本身支持 300–3 M。
- `--timeout`：应答超时下限（ms，默认 250）。总线舵机多、BLE 慢时调大。
- `--restore-uart`：命令结束后把 UART 参数改回命令前的值，方便同一块 Bee
  平时继续当 console 用。
- `--no-claim` / `--keep-control`：多客户端固件下的控制权处理。
- `--echo auto|on|off`：半双工回显过滤，默认 `auto`；`off` 表示原样收发。

## 为什么不能直接转发

原版 FTServo 库假设两条前提，在 BLE + 半双工总线上都不成立，工具里分别处理：

1. **应答超时太短。** 库默认给状态包 50 ms（`LATENCY_TIMER` + 字节时间），而
   BLE 一个来回就是一个连接间隔（桌面主机通常 15–40 ms）。`make_port_handler()`
   把超时下限抬到 `--timeout` ms，不改动库本身。
2. **自己听到自己。** TX/RX 短接到同一根舵机线后，Bee 会先收到自己刚发的请求，
   再收到舵机应答；这个“回显”也是校验和合法的飞特帧，原版库会把它当成状态包，
   读回的数据就是错的。`ServoSerial` 记下每次请求的完整字节，只有完整匹配时才
   丢弃；一旦不匹配（说明用了带方向控制的转接板、没有回显），就把暂存的字节
   原样放回。两种接法都能用。

## 限制

- 每次舵机事务大约是一个 BLE 连接间隔 + 舵机应答，所以 `monitor` 几 Hz 很轻松，
  到 ~10 Hz 左右还能用。这是调试/联调工具，不是实时运动控制。
- Bee 会把 UART 输出广播给所有已连接客户端，舵机流量在网页终端里是二进制乱码。
  干净的用法是给舵机单独一块 Bee。
- 一次同步写覆盖很多舵机时会被拆成多个 BLE 写；飞特协议一般能容忍字节间隙，
  如果大组表现异常，拆小批。
- 工具运行期间会接管 console 控制权（否则写不进去），退出时释放；`--no-claim`
  可以跳过。

## 排错

| 现象 | 先查什么 |
| --- | --- |
| `scan` 一个都扫不到 | 舵机供电和共地；信号线是否接在 J7.1+J7.2；波特率（`--baud`）；先 `raw ff ff 01 02 01 fb` 看有没有回包 |
| 只短接了 TX/RX，`raw` 什么也没看到 | 正常：回显被过滤了。加 `--echo off` 就能看到自己发的字节 |
| 每次都超时 | `--timeout 400`；确认没有被别的 Bee/主机占用；`info` 看链路 |
| 提示 `not_owner` 或写入没反应 | 网页/手机终端正持有 console。让它空闲，或 `--no-claim` 且不要在网页端输入 |
| 有回包但数据是乱的 | 型号族选错（SCS 与 STS 的字节序不同），或总线被 console 共用；正常 PING 回包应是 `ff ff <id> 02 00 <chk>` |

## 验证状态

- 主机测试：`python3 -m unittest tests.test_bee_ftservo -v` —— 帧格式、回显过滤
  （完整/分段/无回显三种）、SDK 的 ping/读/写/同步写、超时下限、CLI 全部覆盖。
- 真机链路（固件 1.1.5 / macOS）：连接、Management v1、claim/release、
  `@u=1000000,8,n,1,none` 设置与恢复、原始包写入 J7 均验证通过。
- **尚未接实体舵机验收。** 协议路径靠模拟总线验证；接上舵机后先跑 `scan` 和
  `status`，把型号和波特率补进记录。

运行时依赖 `ftservo-python-sdk`（MIT）和 `bleak`（MIT），工具本身不携带它们的
代码；其余代码遵循仓库许可证。
