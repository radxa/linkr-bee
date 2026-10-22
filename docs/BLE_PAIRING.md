# Bee 蓝牙配对与恢复

## 用户操作

配对授权输入因板而异，均内部上拉、低电平有效，引脚为 3.3 V 逻辑。C3/C5
默认要求物理授权；WROOM 默认关闭，GPIO4 仅作为可选输入保留：

| 板型 | 配对 GPIO | 当前 board conf |
|------|-----------|-----------------|
| ESP32-C3 DevKitC / DevKitM / Super Mini | GPIO1 | `PAIRING_GPIO_AUTH=y` |
| ESP32-C5 DevKitC | GPIO1 | `PAIRING_GPIO_AUTH=y` |
| ESP32-WROOM-32 DevKitC | GPIO4（可选） | `PAIRING_GPIO_AUTH=n` |

配对 GPIO 不被默认 UART、LED 或恢复出厂功能占用（WROOM 的 GPIO13 仅在启用
autobaud 时作按键，GPIO2 为活动 LED）。用按钮或跳线将配对 GPIO 接到 Bee 的 GND。

以下步骤适用于启用授权检查的板型（C3/C5；WROOM 需先设置
`CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=y`）：

1. 新主机/App 首次连接前，将配对 GPIO 接地。
2. 在客户端选择 Bee 并连接，接受操作系统配对提示。无屏设备使用
   LE Secure Connections Just Works，没有需要输入的固定 PIN。
3. 配对成功后释放配对 GPIO。双方保存密钥，之后重连通过加密认证，无需操作引脚。
4. 换一台主机，重复上述步骤；原主机绑定保留。默认最多保存 8 台主机，仍只允许
   一条 BLE 连接同时工作。

启用授权时，配对 GPIO 在收到配对请求时采样；请求被拒绝后再接地不会让旧请求
继续，需要重新发起。新增绑定与替换旧密钥都受此门禁约束。引脚读取失败时拒绝
配对。低电平期间附近其他主机也可申请配对，完成后及时释放。WROOM 默认关闭
授权，因此新主机可直接配对；GATT 仍要求加密和绑定。Just Works 不提供 MITM
身份核验。

## 客户端

- Web / iOS：读取加密的 Management Protocol 特征时由系统处理配对。
  浏览器选择设备的授权不等于蓝牙绑定。如果系统未弹出配对提示，可先在系统
  蓝牙界面配对，再重连；不同浏览器/操作系统组合需实机验证。
- Android App：连接后检查系统绑定状态；缺少绑定时调用 `createBond`，失败则
  断开连接，不继续读写串口或管理特征。
- Python CLI：`--pair` 在 Linux 等支持的平台主动调用系统配对；macOS 在读取
  加密特征时弹出系统配对。首次操作时，启用授权检查的板型先拉低配对 GPIO
  （C3/C5 为 GPIO1；WROOM 默认跳过），必要时增加 `--timeout`。
  连接或配对失败以退出码 `1` 结束（终端会话中设备断开是 `3`）；先 `--scan`
  可以确认设备是否在场（它会列出全部附近设备，包括未广播名字的）。
- Linux C CLI：`--pair` 调用 BlueZ `Device1.Pair`。系统需有可用的 Bluetooth
  agent；已有绑定不删除、不强制替换。也可先通过 `bluetoothctl` 配对。
  退出码与 Python 客户端一致：`1` 连接/配对失败，`2` 参数问题，`3` 终端会话中
  设备断开；`--scan` 可先确认设备是否在场（列出全部附近设备，含无名的）。
- HarmonyOS：使用相同加密 GATT 服务。先在系统蓝牙界面配对后连接；自动配对
  弹窗及恢复流程仍需真机验证。

## 绑定丢失、存储与恢复

- Bee 使用 Zephyr `BT_SETTINGS` 在 NVS 中保存绑定密钥，并在开始广播前恢复。
- 主机端“忽略设备”不会删除 Bee 端记录；主机密钥丢失后，启用授权检查的板型
  重新配对仍需拉低配对 GPIO，WROOM 默认不需要。
- 默认 `BT_MAX_PAIRED=8`，`BT_KEYS_OVERWRITE_OLDEST=n`，满时不自动移除旧主机。
- 恢复出厂会同时清除全部绑定、BLE identity 和其他保存的设置：C3 在上电时
  持续拉低 GPIO0 至少 2 秒；C5 为 GPIO28，WROOM 为 GPIO27。C3 Super Mini 的
  BOOT 引脚不是 GPIO0，请按板级接线操作。恢复出厂后主机也应忽略旧记录；
  启用授权检查的板型再拉低配对 GPIO 重新配对，WROOM 默认直接重连。
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
| 配对 GPIO 拉低，主机 A 配对 | 成功并可使用 UART/管理服务 |
| 释放配对 GPIO，断开并重连 A | 复用密钥成功 |
| Bee 断电重启，再连接 A，配对 GPIO 高 | 绑定恢复，仍可使用 |
| 配对 GPIO 高，主机 B 申请配对 | 拒绝，A 绑定仍可用 |
| 配对 GPIO 低，B 配对，然后释放 | A、B 均可分别重连 |
| A 忽略绑定，配对 GPIO 高/低分别重配 | 高拒绝、低允许替换密钥 |
| 绑定表满后新增主机 | 拒绝，不淘汰原绑定 |
| 普通固件更新不擦设置区后重连 | 原绑定继续有效 |
| 执行板级恢复出厂 | 全部绑定清空，配对 GPIO 高时旧主机不能重新配对 |

表中“配对 GPIO”在 C3/C5 为 GPIO1；WROOM 默认关闭授权，手工启用时才是 GPIO4。
建议覆盖 C3/C5/WROOM、Android、iOS、桌面 Chrome 与 Linux BlueZ，并在配对
期间并发 UART 流量及 WiFi 活动验证栈和内存余量。
