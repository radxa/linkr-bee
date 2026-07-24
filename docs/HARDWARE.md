# ESP32-C3 硬件需求规格（Linkr BLE UART Bridge）

> 基于 `boards/esp32c3_supermini.overlay`、`src/main.c`、`prj.conf`、`Kconfig` 整理。
> 作为交付硬件团队的基线规格，对应固件已验证烧录运行。

## 1. 角色

ESP32-C3 在系统中承担三重角色：

- **BLE 外设**：Nordic UART Service，与主机（手机/电脑/网关）双向串口
- **UART 桥**：把 BLE 数据透传到 SBC 串口，反之亦然
- **WiFi 上传节点**：连 WiFi 后把 SBC console 日志定期 PUT 到 WebDAV

## 2. SoC 选型

| 项 | 要求 |
|----|------|
| 芯片 | ESP32-C3（RISC-V 单核 160MHz） |
| BLE | BLE 5.0（内置） |
| WiFi | 2.4GHz b/g/n（内置） |
| USB | 内置 USB Serial JTAG（烧录 + console，免外部芯片） |
| Flash | ≥ 4MB（推荐 ESP32-C3FH4 / N4 封装） |
| PSRAM | 不需要 |

## 3. 引脚分配

| 功能 | GPIO | 方向 | 说明 |
|------|------|------|------|
| 桥接 UART0 RX | 20 | in | 接 SBC TX |
| 桥接 UART0 TX | 21 | out | 接 SBC RX |
| 活动 LED | 8 | out | 蓝色，收发活动闪烁（40ms 脉冲） |
| USB D- | 18 | — | 内置 USB Serial JTAG |
| USB D+ | 19 | — | 内置 USB Serial JTAG |
| RTS/CTS（可选） | 待定 | — | 流控，supermini 未接；量产可预留 2 个 GPIO |

> 桥接 UART 由 devicetree chosen 节点 `zephyr,linkr-ble-uart` 选定，量产可改 overlay 重映射。

## 4. 桥接 UART 电气

- **电平**：3.3V TTL（非 RS232；需接 RS232 电平请外挂收发器）
- 默认 `115200,8,N,1,none`
- 支持波特率范围：300 ~ 3,000,000
- 数据位 5/6/7/8，校验 None/Odd/Even，停止位 1/2，流控 None/RTS-CTS
- 若 SBC 为 5V TTL，需加电平转换

## 5. LED 指示

- GPIO8，固件用 `gpio_pin_set_dt` 驱动
- 极性由 devicetree `gpios` 属性 flag 决定（supermini 为低电平点亮）
- 行为：
  - UART RX/TX 每次活动亮 40ms
  - loopback 失败时连闪 3 次（仅测试构建）

## 5.1 GPIO0 恢复出厂

- GPIO0 配为输入并启用内部上拉；量产板应预留 GPIO0 与 GND 的焊盘或常开按键
- 在设备复位/上电时将 GPIO0 短接至 GND，并保持 **2 秒**，固件才执行恢复出厂，避免启动瞬态误触发
- 固件在 Bluetooth 与 settings 初始化前擦除 `storage_partition`（NVS），因此会解除 BLE owner/bond，并清除 Bluetooth identity、WiFi/WebDAV 配置和上传 boot 计数器
- 不会擦除固件、`linkr-test-marker` 或 coredump 分区；BLE identity 可能重新生成，原中心设备应忘记旧配对后再重新连接
- 该焊盘等同于物理恢复出厂权限，不应永久接地，也不应暴露给非授权人员

## 6. 控制台与烧录

- **Console**：USB Serial JTAG（`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG_ENABLED`），不占用桥接 UART0
- **烧录**：esptool 通过同一 USB，4MB flash，实测速率 ~2.3 Mbit/s
- 量产可选预留 SWD/调试点（ESP32-C3 调试通过 USB JTAG）

## 7. RF / 天线

- BLE + WiFi 共享 2.4GHz 单天线，SoC 内置 coex
- 需 PCB 天线或 IPEX 座
- 推荐留 π 网络（匹配 + 滤波）
- 功放：遵循 ESP32-C3 默认，无需外部 PA

## 8. 电源

| 项 | 要求 |
|----|------|
| 输入 | USB 5V 或 5V 主电源 |
| SoC 供电 | 3.3V LDO，纹波 < 50mV |
| 峰值电流 | ≥ 500mA（WiFi TX 瞬态） |
| LDO | 推荐 ≥ 600mA，如 AMS1117-3.3 / RT9013 |
| 去耦 | 每电源脚 0.1µF + 10µF |

## 9. 存储 / 分区

- 4MB flash，默认 `partitions_0x0_default` 分区表
- 含：bootloader + slot0 应用 + NVS（BLE bond、可选 WiFi 凭据和 WebDAV URL）+ coredump（可选）
- 诊断 marker 测试使用独立 `linkr-test-marker` 分区：`0x3df000`、4KiB；绝不写入 coredump 的 `0x3ff000`
- 量产若需 OTA，改用 OTA 分区表

## 10. 测试点

| 测试点 | 用途 |
|--------|------|
| UART0 TX/RX（GPIO20/21） | 串口抓取 / 环回短接测试 |
| GPIO8 LED | 状态观察 |
| GPIO0 + GND | 保持短接两秒后恢复出厂 / 解除 BLE owner |
| USB（GPIO18/19） | console + 烧录 |
| EN/RST 按钮 | 复位（建议保留） |
| BOOT 按钮 | 进下载模式（建议保留） |

## 11. 兼容参考板

- **esp32c3_supermini**（主目标，已验证）
- esp32c3_devkitm / esp32c3_devkitc（overlay 已提供，引脚同上）

## 12. 固件对外接口（供硬件/集成联调）

- BLE 广播名：`Linkr BLE UART-3`
- NUS UUID：`6e400001` / `-02` / `-03` - `b5a3-f393-e0a9-e50e24dcca9e`
  - 服务：`6e400001-b5a3-f393-e0a9-e50e24dcca9e`
  - RX 写特征：`6e400002-b5a3-f393-e0a9-e50e24dcca9e`
  - TX 通知特征：`6e400003-b5a3-f393-e0a9-e50e24dcca9e`
- 正式配置提供 ATT/L2CAP MTU 247 与 LE Data Length 251；Reliable UART 的
  12 字节帧头和最多 232 字节 payload 可在协商成功时单包传输，较小 MTU
  仍自动分片并保留 20 字节兼容路径
- 控制命令：
  - `@u?` / `@u=baud,data,parity,stop,flow`（UART）
  - `@w=ssid,pass` / `@w off` / `@w?`（WiFi）
  - `@d=http://host/path/` / `@d off` / `@d?`（匿名 HTTP WebDAV）
  - `@h`（help）
- WiFi 默认启用但无线电关闭，`@w=` 后开启；凭据默认只在 RAM，只有启用 `CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS=y` 才写入 NVS（要求 secure boot + flash encryption）
- WiFi/WebDAV 控制命令要求 BLE Level 3 配对。首次代码显示于 USB serial console，单个 bridge 仅接受一个 bonded owner；GPIO0 与 GND 在启动时保持短接两秒可恢复出厂并解除 owner

## 13. 量产要点

1. WiFi/BLE 共用天线，RF 走线需 50Ω 阻抗控制
2. flash 容量 ≥ 4MB，需保留 NVS 存储区
3. 桥接 UART 引脚若与 SBC 距离 > 30cm，建议加 RS485 或电平缓冲
4. GPIO8 LED 量产可改其他空闲 GPIO（改 overlay `led0` alias 即可）
5. 预留 RTS/CTS 两脚以备流控升级
6. 预留 EN/RST、BOOT 与 GPIO0-GND 恢复出厂焊盘/按键，便于量产烧录、维修和 owner 转移
7. USB D+/D- 走线差分 90Ω，ESD 保护器件靠近 USB 座

## 14. 构建 / 烧录命令（参考）

```sh
# 在含 hal_espressif 的 west workspace 内
west build -b esp32c3_supermini /path/to/linkr-ble
west flash --esp-device /dev/cu.usbmodemXXXX
```

前置条件：west manifest 含 `modules/hal_espressif`（提供 WiFi blobs）。

## 15. 变更记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-07 | v1.0 | 初版，对应已验证固件（含 WiFi/WebDAV） |
