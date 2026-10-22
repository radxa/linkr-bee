/*
 * Hand a whole packet to the UART's FIFO instead of one byte at a time.
 *
 * This lives in its own translation unit on purpose, for the same reason
 * src/uart_autobaud.c does: src/main.c, Kconfig and CMakeLists.txt are
 * compiled by every board in the project (esp32, esp32c3, esp32c5), and the
 * register-level work this needs would be a standing merge conflict for
 * anything else that touches the bridge. Disable
 * CONFIG_LINKR_BLE_BRIDGE_UART_BULK_TX and this whole header collapses to
 * no-op inline stubs; the file compiles to nothing.
 */
#ifndef LINKR_UART_BULK_TX_H_
#define LINKR_UART_BULK_TX_H_

#include <stddef.h>
#include <stdint.h>

#include <zephyr/sys/util.h>

/*
 * The loopback test config drives the port from the loopback harness, which
 * reads the bytes back on the other side of the same wire and depends on the
 * per-byte path; a second writer into the FIFO would race it.
 */
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_UART_BULK_TX) && \
	!IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
#define LINKR_UART_BULK_TX 1
#else
#define LINKR_UART_BULK_TX 0
#endif

#if LINKR_UART_BULK_TX

/**
 * Write a buffer to the UART, filling the hardware FIFO rather than spinning
 * for one byte of space at a time.
 *
 * Byte order and framing are the same as writing each byte with
 * uart_poll_out(), and the function does not return until every byte has been
 * handed to the peripheral — a caller that relied on uart_poll_out's
 * completion guarantee still gets it.
 *
 * @param reg_addr MMIO base of the bridge UART, as DT_REG_ADDR().
 * @param baudrate Unused. The wait is driven by the FIFO's own occupancy
 *                 (uart_hal_get_txfifo_len) and k_yield(), so it is correct
 *                 at any line rate, including one autobaud switches to while
 *                 this call is in flight. Kept in the signature for symmetry
 *                 with the byte-at-a-time path, which reads it under
 *                 uart_config_lock.
 * @param data     Bytes to send. May be NULL only when len is 0.
 * @param len      Number of bytes to send.
 */
void linkr_uart_bulk_write(uintptr_t reg_addr, uint32_t baudrate,
			   const uint8_t *data, size_t len);

#else

static inline void linkr_uart_bulk_write(uintptr_t reg_addr, uint32_t baudrate,
					 const uint8_t *data, size_t len)
{
	(void)reg_addr;
	(void)baudrate;
	(void)data;
	(void)len;
}

#endif /* LINKR_UART_BULK_TX */

#endif /* LINKR_UART_BULK_TX_H_ */
