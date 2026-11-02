# Bee 蓝牙配对与恢复

## 用户操作

配对授权输入因板而异，均内部上拉、低电平有效，引脚为 3.3 V 逻辑。C3/C5
默认要求物理授权；WROOM 默认关闭，GPIO4 仅作为可选输入保留：

| 板型 | 配对 GPIO | 当前 board conf |
|------|-----------|-----------------|
| ESP32-C3 DevKitC / DevKitM / Super Mini | GPIO1 | `PAIRING_GPIO_AUTH=y` |
| ESP32-C5 DevKitC | GPIO1 | `PAIRING_GPIO_AUTH=y` |
| **Linkr Bee X1.0（MV013）** | **GPIO3**（USER_KEY） | `PAIRING_GPIO_AUTH=y` |
| ESP32-WROOM-32 DevKitC | GPIO4（可选） | `PAIRING_GPIO_AUTH=n` |

C5 DevKitC 正式固件仍需在 GPIO1 外接按钮或跳线。受控台架测试可显式加载
`dev_c5_open_pairing.conf`，但该开发镜像允许附近任何主机配对，不适合正式使用；
构建命令和风险说明见[开发文档](DEVELOPMENT.zh-CN.md#配对-gpio持久化与恢复出厂)。

配对 GPIO 不被默认 UART、LED 或恢复出厂功能占用（WROOM 的 GPIO13 仅在启用
autobaud 时作按键，GPIO2 为活动 LED）。Linkr Bee X1.0 上 GPIO3 同时是恢复出厂
输入：上电时按住 ≥2 秒清设置，正常运行时按下则作为配对授权。用按钮或跳线将配对 GPIO 接到 Bee 的 GND。

以下步骤适用于启用授权检查的板型（C3/C5；WROOM 需先设置
`CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=y`）：

1. 新主机/App 首次连接前，按下配对 GPIO 后松开（X1.0 上就是 USER_KEY，按一下即可）。
2. **在 30 秒内**在客户端选择 Bee 并连接，接受操作系统配对提示。无屏设备使用
   LE Secure Connections Just Works，没有需要输入的固定 PIN。
3. 配对成功后双方保存密钥，之后重连通过加密认证，无需再按键。
4. 换一台主机，重复上述步骤；原主机绑定保留。默认最多保存 8 台主机，仍只允许
   一条 BLE 连接同时工作。

启用授权时，配对 GPIO 的按下会开启一个授权窗口：按键当前仍为低电平、或最近
`CONFIG_LINKR_BLE_BRIDGE_PAIRING_GRACE_MS`（默认 30000 ms）内按下过，收到的
配对请求都会被接受，因此用户不需要在整个扫描/连接/配对过程中一直按住按键。
窗口长度可用该 Kconfig 符号调整，设为 0 则恢复"配对请求到达时必须正按住"的旧
行为（`range 0 300000`）。每个新按键都会刷新窗口，窗口内附近其他主机也可申请
配对，因此按下按键后不要走开。请求被拒绝后按键不会让旧请求继续，需要重新发起
配对。新增绑定与替换旧密钥都受此门禁约束，引脚读取失败时拒绝配对。WROOM 默认
关闭授权，因此新主机可直接配对；GATT 仍要求加密和绑定。Just Works 不提供 MITM
身份核验。

## 客户端

- Web / iOS：读取加密的 Management Protocol 特征时由系统处理配对。
  浏览器选择设备的授权不等于蓝牙绑定。如果系统未弹出配对提示，可先在系统
  蓝牙界面配对，再重连；不同浏览器/操作系统组合需实机验证。
  Web 终端在配对被拒绝后会停止自动重连，并提示"再按一次配对键后重新连接"，
  不会用后台重试去撞一个必须物理授权才能通过的配对。
- Android App：连接后检查系统绑定状态；缺少绑定时调用 `createBond`，失败则
  断开连接，不继续读写串口或管理特征。
- Python CLI：`--pair` 在 Linux 等支持的平台主动调用系统配对；macOS 在读取
  加密特征时弹出系统配对。首次操作时，启用授权检查的板型先按下配对 GPIO
  （C3/C5 为 GPIO1，Linkr Bee X1.0 为 GPIO3/USER_KEY；WROOM 默认跳过），
  再在 30 秒授权窗口内重试，必要时增加 `--timeout`。
  连接或配对失败以退出码 `1` 结束（终端会话中设备断开是 `3`）；先 `--scan`
  可以确认设备是否在场（它会列出全部附近设备，包括未广播名字的）。
- Linux C CLI：`--pair` 调用 BlueZ `Device1.Pair`。系统需有可用的 Bluetooth
  agent；已有绑定不删除、不强制替换。也可先通过 `bluetoothctl` 配对。
  退出码与 Python 客户端一致：`1` 连接/配对失败，`2` 参数问题，`3` 终端会话中
  设备断开；`--scan` 可先确认设备是否在场（列出全部附近设备，含无名的）。
- HarmonyOS：建立 GATT 连接后检查系统绑定状态；未绑定时主动调用 `pairDevice`
  并等待绑定成功，再协商 MTU、发现服务及访问加密特征。正在系统配对时不重复
  发起请求。首次连接前先按下配对 GPIO（30 秒授权窗口内发起连接），并接受系统配对
  提示；失败或 60 秒内未完成则断开，不继续访问服务。已绑定主机跳过配对，不删除已有绑定。
  自动配对弹窗及恢复流程仍需真机验证。

## 绑定丢失、存储与恢复

- Bee 使用 Zephyr `BT_SETTINGS` 在 NVS 中保存绑定密钥，并在开始广播前恢复。
- 主机端“忽略设备”不会删除 Bee 端记录；主机密钥丢失后，启用授权检查的板型
  重新配对仍需按下配对 GPIO 并在这 30 秒窗口内发起配对，WROOM 默认不需要。
- 默认 `BT_MAX_PAIRED=8`，`BT_KEYS_OVERWRITE_OLDEST=n`，满时不自动移除旧主机。
- 恢复出厂会同时清除全部绑定、BLE identity 和其他保存的设置：C3 在上电时
  持续拉低 GPIO0 至少 2 秒；C5 为 GPIO28，WROOM 为 GPIO27。C3 Super Mini 的
  BOOT 引脚不是 GPIO0，请按板级接线操作。恢复出厂后主机也应忽略旧记录；
  启用授权检查的板型再按一下配对 GPIO 并在窗口内重新配对，WROOM 默认直接重连。
- 配对 GPIO 仅授权配对，长期拉低不会清空已有设置。本版不提供无线删除单个绑定接口。

## 固件保证与范围

Management、Reliable UART 和兼容 NUS 的特征值及 CCC 均要求加密访问；
未配对连接可以发现服务，但不能收发串口数据或修改管理配置。NUS 使用本项目
定义的加密实例，上游默认明文实例已禁用。新主机必须支持 LE Secure Connections
及 16 字节密钥；不允许不保存绑定的临时配对。

蓝牙门禁不改变局域网 WebSocket 的网络/token 策略，也不提供 Flash 静态数据加密。

实现使用 Zephyr 的同步 `pairing_accept` 回调在收到请求时决定是否继续，接口说明见
[Zephyr authentication callbacks](https://docs.zephyrproject.org/latest/doxygen/html/structbt__conn__auth__cb.html)。

## 实机验收（构建与主机测试不能替代）

下表针对启用配对授权的配置（C3/C5，或手工开启的 WROOM）。WROOM 默认
`PAIRING_GPIO_AUTH=n`，应预期任何新主机都不需要 GPIO4 即可配对。

| 步骤 | 预期 |
| --- | --- |
| 清空测试主机绑定，配对 GPIO 悬空/高，尝试配对及 GATT 读写/订阅 | 拒绝配对；三个服务不泄露数据 |
| 按下配对 GPIO 后松开，30 秒内主机 A 发起配对 | 成功并可使用 UART/管理服务 |
| 按下配对 GPIO 后超过窗口（默认 30 秒）才发起配对 | 拒绝配对 |
| 释放配对 GPIO，断开并重连 A | 复用密钥成功 |
| Bee 断电重启，再连接 A，配对 GPIO 高 | 绑定恢复，仍可使用 |
| 未按键且超过授权窗口，主机 B 申请配对 | 拒绝，A 绑定仍可用 |
| 按下配对 GPIO 后在窗口内让 B 配对 | A、B 均可分别重连 |
| A 忽略绑定，未按键/窗口内分别重配 | 拒绝；窗口内允许替换密钥 |
| 绑定表满后新增主机 | 拒绝，不淘汰原绑定 |
| 普通固件更新不擦设置区后重连 | 原绑定继续有效 |
| 执行板级恢复出厂 | 全部绑定清空，配对 GPIO 高时旧主机不能重新配对 |

表中“配对 GPIO”在 C3/C5 为 GPIO1；WROOM 默认关闭授权，手工启用时才是 GPIO4。
建议覆盖 C3/C5/WROOM、Android、iOS、桌面 Chrome 与 Linux BlueZ，并在配对
期间并发 UART 流量及 WiFi 活动验证栈和内存余量。

### Manage saved hosts

In **Settings → Connection → Paired devices**, refresh the list and remove an
individual pairing. The list uses Bluetooth identity addresses (public/random),
not host names or temporary scan addresses, and marks the current host.
Deletion requires the current control owner and confirmation. Removing a connected
host disconnects it; removing this host stops browser automatic reconnection.
Forget the old pairing in the host OS before pairing again under the board's
normal physical-authorization policy. Other hosts and target-machine bindings
are preserved. Older firmware without this command hides the card.

Each pairing can also carry a **display label** (for example "Alice's phone"),
stored on the board in NVS under the bond's identity address. The label is
display-only and is never authenticated. The web and phone editors report it once
from the browser's user agent when the board stores none (a native shell cannot read the phone's own
Bluetooth name; the connected accessory's name is the board's, not the host's),
and the TUI reports the local user name once for this host's own pairing. The
owner can always edit or clear it. Deleting a pairing deletes its label too.

The encrypted BLE management commands are `@linkr bonds?` (read-only),
`@linkr bonds remove <type>/<address>` (control owner only), for example
`@linkr bonds remove 0/AA:BB:CC:DD:EE:01`, and
`@linkr bonds label <type>/<address> [<hex>|clear]`. Type 0 is public, 1 is
random. A label travels hex-encoded because it is UTF-8 text; a bare address is
a read-only query (`OK bonds label=<address> none` or
`OK bonds label=<address> hex=<hex>`), while writing or clearing another host's
label needs the control owner.

The earlier self-only form is kept for existing clients:
`@linkr bonds name <label>` names the caller's own pairing and needs no console
ownership, and `@linkr bonds names?` returns every stored name as
`NAME <type>/<address> "<label>"` lines. The listing is capped at 32 bytes so
eight maximal lines still fit one reply; the per-address form above returns the
full label. A host can therefore rename itself without taking control, while an
owner can still rename or clear any pairing.

The firmware rejects labels that are not displayable UTF-8 (including C0/C1
controls) and stores at most 48 bytes by default. The list never carries labels,
because eight of them would overflow the reply: read one address at a time. The
web and TUI clients cap their own label input at 48 bytes; a build that changes
`LINKR_BLE_BRIDGE_BOND_LABEL_MAX` must change the clients too.
The removal acknowledgement `OK bonds queued` means accepted, not completed;
queries report `pending` and the last removal `result` (zero on success).
The firmware delays removal briefly so even the current host can receive the
acknowledgement before its encrypted connection is closed. A lost acknowledgement
does not prove failure; reconnect and refresh to verify.
