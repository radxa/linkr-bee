/* SPDX-License-Identifier: Apache-2.0 */
#ifndef LINKR_EXT_RAM_H
#define LINKR_EXT_RAM_H

/*
 * Placement helper for data that may live in external PSRAM.
 *
 * The C5 image is bound by internal SRAM: everything Zephyr links has to stay
 * below DRAM_SHARED_BUFFERS_END (0x4085C610), because the 12.8 KB above it is
 * the ROM stack/bss used by the WiFi/PHY code. Buffers that are pure data and
 * only ever touched from thread context can be moved to PSRAM instead, where
 * they cost nothing that matters.
 *
 * `.ext_ram.bss` comes from the Espressif SoC linker script: it sits inside
 * `.ext_ram.data`, before the shared multi-heap region, and is zeroed by
 * soc/espressif/common/esp_psram.c during PSRAM init (so it must never be
 * used for data expected to survive a warm reset -- use `.ext_ram_noinit.*`
 * for that, which nothing here needs).
 *
 * Only valid on SoCs whose linker script defines the section: the ESP32-C3
 * has no PSRAM support at all, so the attribute expands to nothing there and
 * the buffer stays in DRAM.
 *
 * Rules for what belongs here:
 *  - Data only: no kernel objects (k_mutex/k_sem/k_msgq/ring_buf structures
 *    themselves), no thread stacks (Zephyr does not support stacks in external
 *    RAM), nothing written from an ISR (the UART RX ring, for example: a QSPI
 *    round trip inside an interrupt handler is not acceptable).
 *  - Safe for the object to be zeroed at PSRAM init instead of at load.
 */
#if defined(CONFIG_ESP_SPIRAM) && defined(CONFIG_SOC_SERIES_ESP32C5)
#define LINKR_EXT_RAM_BSS __attribute__((section(".ext_ram.bss")))
#else
#define LINKR_EXT_RAM_BSS
#endif

#endif /* LINKR_EXT_RAM_H */
