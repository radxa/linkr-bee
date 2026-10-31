# ESP32-C5 PSRAM 与内部 SRAM 布局

> 依据 ESP32-C5 DevKitC（**WROOM-1-N8R4** 模块，8 MB QSPI PSRAM）的实机测量，并对照
> `boards/esp32c5_devkitc_esp32c5_hpcore.{conf,overlay}` 与 `src/ext_ram.h` 的实现整理。
> 本文只描述 **C5 目标**：C3 与 ESP32-WROOM-32 没有 PSRAM，`src/ext_ram.h` 的宏在这些
> 板子上展开为空，全部缓冲留在内部 RAM。
>
> 本文**不记录具体的字节数与占用百分比**，那些数字随功能增减而变，写在这里只会过时。
> 需要时按下文第 7 节自己量，或用 `tools/verify.sh` 断言。

## 1. 硬边界：ROM 区间不可占

C5 镜像里 Zephyr 能链接的一切都必须落在 `DRAM_SHARED_BUFFERS_END = 0x4085C610` 以下。
这个地址之上的 12.8 KB **不属于 Zephyr**：

| 区间 | 大小 | 归属 |
|---|---|---|
| `0x4085C610` – `0x4085E610` | 8 KB | ROM 的 PRO CPU 栈（`SOC_ROM_STACK_START`） |
| `0x4085E610` – `0x4085F800` | 4.5 KB | ROM 的 `.bss`/`.data` 尾部 |

WiFi/PHY 代码运行在这两段里。把它划给 Zephyr 会让关联挂死，或直接锁死芯片
（`rst:0x1a CPU_LOCKUP`），因此 `soc/espressif/esp32c5/memory.h` 必须保持上游原值。
这也是纯 SRAM 镜像曾卡在 `sram0_0_seg` 99 % 以上、缓冲被一路压缩的原因。

## 2. 放置规则

`src/ext_ram.h` 的 `LINKR_EXT_RAM_BSS` 把对象放进 `.ext_ram.bss`，仅在
`CONFIG_ESP_SPIRAM && CONFIG_SOC_SERIES_ESP32C5` 下生效，其余板子展开为空。
该段由 Espressif 链接脚本提供，位于 `.ext_ram.data` 内、`_ext_ram_heap_start` 之前，
不会与 shared multi-heap 重叠，并由 `soc/espressif/common/esp_psram.c` 在 PSRAM
初始化时清零 —— 所以放在这里的对象**不能**携带需要跨越热复位的状态（若确实需要，
用 `.ext_ram_noinit.*`）。

能搬的判据是三条，缺一不可：

1. **纯数据** —— 不含内核对象本体（`k_mutex`/`k_sem`/`k_msgq`/`ring_buf` 结构）。
2. **无 ISR 访问** —— 中断上下文里走一次 QSPI 往返不可接受，`uart_rx_storage` 就因此
   留在 DRAM。
3. **允许在 PSRAM 初始化时被清零**，而不是在加载时。

线程栈**永远不能**放进来：Zephyr 不支持把栈放在外部 RAM（异常与上下文切换路径会访问它）。

C5 上已搬进去的对象集中在五处：`main.c` 的 BLE→UART 队列与命令缓冲、`ble_peers.c`
的每 peer 队列 payload、`ws_bridge.c` 的每客户端 ring 与握手缓冲、`wifi.c` 的日志环/
扫描缓存/WiFi 与 WebDAV 凭据/上传暂存、`ble_mgmt.c` 的 `rx_states`。
逐项字节数与生产者/消费者见各文件定义处的注释。

> GCC 不允许对结构体成员加 `section` 属性，所以原本作为成员的 payload 必须提成顶层数组
> （`peer_storage`、`ws_tx_bufs`），结构体里只留指针/索引。

## 3. 共享堆与外部 BSS：为什么需要给模块打一个补丁

这是本页最容易踩错的一处，放在默认配置之前说。

`.ext_ram.bss` 与共享堆**在链接期是不重叠的**：链接脚本里 `_ext_ram_bss_end` 之后才是
`_ext_ram_heap_start`。但运行时并不看这个符号 —— `esp_psram_smh_init()` 用的是
`esp_psram_get_mapped_region()` 返回的 `regions_to_heap[].vaddr_start`，默认是**映射区
起点**，与 `.ext_ram.bss` 的起点同一个地址。

正常情况下这不成问题，因为 `esp_psram.c` 会在
`CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` 时把 bss 段长度从堆里扣掉
（`vaddr_start += ext_section_size`）。而 `hal_espressif` 模块只给 ESP32 / S2 / S3 打开了
这个开关，**C5 没有**：

```kconfig
config SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY
	bool
	default y if SOC_SERIES_ESP32
	default y if SOC_SERIES_ESP32S2
	default y if SOC_SERIES_ESP32S3
```

于是 `sys_heap_init()` 会在启动时把它的头部写到 `.ext_ram.bss` 的第一个对象上，而且是
双向的：堆初始化覆盖我们的缓冲，我们的缓冲清零也破坏堆元数据。

本仓库通过 `patches/zephyr/0001-esp32c5-allow-bss-seg-external-memory.patch` 给这个
Kconfig 补一行 `default y if SOC_SERIES_ESP32C5`，由 `CMakeLists.txt` 在
`find_package(Zephyr)` 之后幂等应用（`west update` 冲掉也会自动打回来）。补丁只影响
C5：其它 SoC 的 `SOC_SERIES_*` 条件不成立，`CONFIG_ESP_SPIRAM=n` 时该符号也不生效。

补齐后运行时堆起点正好落在 `_ext_ram_bss_end`，零重叠。

> **这个选择是有代价的**：它是本仓库唯一修改外部树的补丁。选它的理由是「这属于 Zephyr
> 的 C5 支持缺口，不是本项目的设计选择」，一行配置即可根治。
>
> **曾试过的替代方案**：在 `.ext_ram.bss` 最前面放一个 256 B 的 padding 数组吸收
> `sys_heap_init()` 的头部（`src/a_ext_ram_guard.c`）。它能工作，实测三条收尾路径无异常，
> 但只是规避而非修复：
>
> - 依赖链接顺序（该段按 `SORT_BY_ALIGNMENT` 解析）、依赖 GCC 不重排同一编译单元的顶层
>   变量（`-ftoplevel-reorder` 在 `-Os` 下默认开启，所以它必须独立成一个文件）、
>   `used` 与 `retain` 缺一个就会被编译器或 `--gc-sections` 丢掉。
> - 只在该池**永不分配**的前提下安全；一旦启用 `ESP_WIFI_HEAP_SPIRAM`，padding 之外
>   就是真实数据。
> - 多占 256 B PSRAM、43 行代码和一节文档。
>
> 两方案实测差异：Kconfig 方案 `ext_dram_seg` 5197216 B、运行时堆起点 `0x420f4da0`；
> barrier 方案 5197472 B、堆起点 `0x420f0000`。

## 4. 默认配置与 WiFi 的取舍

`boards/esp32c5_devkitc_esp32c5_hpcore.overlay` 把 `psram0` 修正为 8 MB（上游
`esp32c5_wroom_n8r4.dtsi` 只声明 4 MB）；`CONFIG_ESP_SPIRAM_SIZE` 由该节点推导，
且只有 8 MB 才会选中 `SPIRAM_TYPE_ESPPSRAM64`，所以这个 overlay 不能省。

`CONFIG_ESP_SPIRAM_HEAP_SIZE=4194304` 供 shared multi-heap 使用，8 MB 的其余部分留作
备用。板级 conf 里还有两条与 PSRAM 直接相关的约束（详见该文件注释）：

- `CONFIG_SPIRAM_SPEED_80M=y` —— 40 MHz 会进入 `rst:0x1a CPU_LOCKUP` 复位循环。
- `CONFIG_ESP_WIFI_HEAP_SYSTEM=y`，且 `ESP_WIFI_HEAP_SPIRAM` 与
  `ESP32_WIFI_NET_ALLOC_SPIRAM` 必须为 `n` —— 任一项打开后 2.4 GHz 扫描永不完成
  （40 s 无结果，正常约 19.7 s）。

`CONFIG_ESP_SPIRAM_MEMTEST=n`：每 MB 约 100 ms 启动开销，运行时证明不了什么。

> **`shared_multi_heap` 目前没有锁，这是安全的但边界明确。** Zephyr 的该分配器自身
> 不做并发保护；本配置之所以不需要，是因为 `ESP_WIFI_HEAP_SYSTEM=y` 让
> `esp_wifi_malloc_func` 展开为 `k_malloc`，而本分支迁移的缓冲是静态放置、不经过分配器，
> 运行时无人从该池分配，只在启动早期单线程注册一次。
> **一旦启用 `ESP_WIFI_HEAP_SPIRAM` 或 video 驱动，必须先加回一把全局 ISR-safe
> `k_spinlock`。**

## 5. 负面知识：别再试

以下路径都已实测排除，改动前先读这一节：

| 尝试 | 结果 |
|---|---|
| 把 `DRAM_USER_END` 提到 `0x4085F800`（占 ROM 栈 + `.bss` 尾） | WiFi 关联约 20 s 后 `rst:0x1a CPU_LOCKUP` |
| 只占 `.bss` 尾 4.5 KB（`0x4085E610`） | 关联 30 s 超时并无限重试 |
| `CONFIG_SPIRAM_SPEED_40M` | 启动即进 `CPU_LOCKUP` 复位循环，只能 80 MHz |
| `ESP_WIFI_HEAP_SPIRAM` 或 `ESP32_WIFI_NET_ALLOC_SPIRAM` | 2.4 GHz 扫描 40 s 无结果，且超时看门狗也不触发 |

> **别把这个症状当作单一证据。** `@w scan` 卡死（`WiFi scan started` 之后再无输出，
> 连超时告警都没有）在**配置正确**的镜像上也会出现：只要 BLE 处于连接状态，扫描在共存
> 调度下会比空闲时慢得多。判断「WiFi 堆是否被放进 PSRAM」要看 `.config` 里的
> `CONFIG_ESP_WIFI_HEAP_SYSTEM=y`，不要看扫描快慢。
>
> 这条共存慢路径本身已经处理过，`src/wifi.c` 里有两处配套改动：扫描期间把射频仲裁
> 偏向 WiFi（`coex_preference_set(ESP_COEX_PREFER_WIFI)`，结束恢复 `BALANCE`），
> 以及把 30 s 看门狗从 system workqueue 挪到内核时钟定时器 + 独立队列 —— 原先那个
> 看门狗和被它看守的扫描排在同一条队列上，扫描卡住时它自己也被卡住，永远不会触发。
> 修复后实测：BLE 连接下扫描 22–27 s 完成（空闲时 19.7 s，修复前 60–75 s 且常常不完成），
> 5 s 超时配置下 `@scan error` 精确在 5.0 s 送达主机。
>
> **两处改动都只在 C5 上编译**（`#if defined(CONFIG_SOC_SERIES_ESP32C5)`）：C3 与
> ESP32-WROOM-32 没有观察到这种行为，它们保留原来的 delayable-work 看门狗，也不为
> 此各付一个 768 B 栈 + 独立队列。若其他板子上出现同样的「扫描卡住而看门狗不响」，
> 把同一个 `LINKR_SCAN_WD_OWN_QUEUE` 开关放开即可。
| `ESP_SPIRAM_HEAP_SIZE` 配满而 `psram0` 仍声明 4 MB | `ext_dram_seg` 溢出（该段在链接脚本里断言 `<= CONFIG_ESP_SPIRAM_SIZE`） |

## 6. 构建

```sh
west build -b esp32c5_devkitc/esp32c5/hpcore -d build/c5-psram linkr-bee
```

`build.yml` 断言 PSRAM 配置项，因此“悄悄丢掉 PSRAM”或“镜像开始使用
WiFi-in-PSRAM 选项”都会在打包前失败。

改过板级 `*.conf`、`*.overlay` 或 `CMakeLists.txt` 后必须从零配置
（`rm -rf build/<dir>`）：缓存的配置曾在一次全新检出上掩盖过一个构建中断的缺陷。

### 内部 SRAM only 变体：保留文件，但不再维护

`c5_pure_sram.conf` 仍然留在仓库里，但**不在 CI 构建、不保证能链接**。
需要时手工指定：

```sh
west build -b esp32c5_devkitc/esp32c5/hpcore -d build/c5-sram linkr-bee -- \
  -DEXTRA_CONF_FILE=c5_pure_sram.conf
```

停止维护的原因：

- **本项目只支持 `esp32c5_devkitc/esp32c5/hpcore`**（WROOM-1-N8R4，带 PSRAM）。
  存在无 PSRAM 的 C5 模块（Zephyr 的 `esp32c5_lpcore_wroom_n8.dtsi` 就没有
  `psram0` 节点），但它从未进入本项目的支持矩阵，没有对应的板级配置与实测。
- **余量已经不够了。** 该变体在 99.67 %（余 1264 B），每加一个功能就要重新平衡
  两套配置的裁剪表；而它的收益只剩「配置集能链接」这一条。
- **它独占的验证价值有限。** `src/ext_ram.h` 的宏在无 PSRAM 时展开为空 —— 这条路径
  仍被 C3 supermini / devkitm / devkitc 与 Linkr Bee X1.0 四个 CI job 覆盖（它们都
  不启用 `CONFIG_ESP_SPIRAM`）。

保留 `c5_pure_sram.conf` 而不删除，是因为它记录了把每个尺寸压回 DRAM 预算的完整
映射，紧急排查或需要纯 SRAM 实验时是现成的起点。**它是一份参考，不是受支持的配置。**

## 7. 怎么量，怎么自检

**启动日志**是 overlay 是否生效的第一道检查。PSRAM 初始化会在
`*** Booting Zephyr OS ***` 之前打印：

```
I (esp_psram): Found 8MB PSRAM device
I (esp_psram): Speed: 80MHz
```

若第一行缺失，说明 overlay 没生效，`.ext_ram.bss` 的写入正落在未映射内存上。

**放置情况**只能从链接产物核对，`@i?` 里没有 PSRAM 计数器：

```sh
# 该段总大小与起止地址（应落在外部 RAM 段，形如 0x42xxxxxx）
riscv64-zephyr-elf-nm -S build/c5-psram/zephyr/zephyr.elf | grep _ext_ram_bss

# 某个缓冲到底在不在 PSRAM 里
riscv64-zephyr-elf-nm -S build/c5-psram/zephyr/zephyr.elf | grep uart_rx_storage
```

内存占用看构建日志末尾的 `sram0_0_seg` 与 `ext_dram_seg` 两行；链接期常量，反映的是
预留，不是运行时压力。

`tools/verify.sh` 已把默认构建可断言的部分固化：构建 C5 后检查 PSRAM 配置项是否
全部生效，并确认 `_ext_ram_bss` 真的落在外部 RAM 段（而不是静默退回内部 SRAM）。
加缓冲或改板级配置后跑一次即可。

> 纯 SRAM 变体不在 CI、也不在 `tools/verify.sh` 里，见第 6 节最后一段。
