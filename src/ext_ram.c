/*
 * Runtime check for the PSRAM shared heap placement.
 *
 * .ext_ram.bss and the shared heap do not overlap at link time:
 * _ext_ram_heap_start follows _ext_ram_bss_end. But esp_psram_smh_init() does
 * not use that symbol -- it registers the pool at whatever
 * esp_psram_get_mapped_region() reports, which is the mapped region start
 * unless CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY made esp_psram.c subtract
 * the bss section from it. When that subtraction is missing, sys_heap_init()
 * writes its header onto the first object in .ext_ram.bss, at boot, before
 * anything else can notice.
 *
 * The link-time assertions in tools/verify.sh only prove the section landed in
 * external RAM; they cannot see this. This file closes that gap by asking the
 * runtime where the pool actually starts and comparing it against the end of
 * the section. One log line on success, an error and a non-zero return when it
 * overlaps -- callers decide whether that is fatal.
 *
 * Cost: a few lines, one call from main(), and one log line at boot.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "ext_ram.h"

LOG_MODULE_REGISTER(linkr_ext_ram, LOG_LEVEL_INF);

#if defined(CONFIG_ESP_SPIRAM) && defined(CONFIG_SOC_SERIES_ESP32C5)

#include <esp_psram.h>

extern uint8_t _ext_ram_bss_start;
extern uint8_t _ext_ram_bss_end;

int linkr_ext_ram_verify_heap(void)
{
	intptr_t vaddr = 0;
	size_t size = 0;
	esp_err_t err = esp_psram_get_mapped_region(&vaddr, &size);

	if (err != ESP_OK) {
		LOG_ERR("PSRAM mapped region unavailable (%d); cannot verify that "
			"the shared heap clears .ext_ram.bss", err);
		return -EIO;
	}

	if ((uintptr_t)vaddr < (uintptr_t)&_ext_ram_bss_end) {
		LOG_ERR("PSRAM shared heap starts at 0x%08lx, inside .ext_ram.bss "
			"(0x%08lx-0x%08lx): sys_heap_init() overwrites migrated "
			"buffers. Apply "
			"patches/zephyr/0001-esp32c5-allow-bss-seg-external-memory.patch.",
			(unsigned long)(uintptr_t)vaddr,
			(unsigned long)(uintptr_t)&_ext_ram_bss_start,
			(unsigned long)(uintptr_t)&_ext_ram_bss_end);
		return -EFAULT;
	}

	LOG_INF("PSRAM shared heap 0x%08lx+0x%lx clears .ext_ram.bss "
		"(ends 0x%08lx)",
		(unsigned long)(uintptr_t)vaddr, (unsigned long)size,
		(unsigned long)(uintptr_t)&_ext_ram_bss_end);
	return 0;
}

#else

/*
 * Other targets have no PSRAM, so .ext_ram.bss expands to nothing and there is
 * no pool to check. Keep the symbol so main() has one call site.
 */
int linkr_ext_ram_verify_heap(void)
{
	return 0;
}

#endif
