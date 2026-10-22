/*
 * Linkr Bee UART bridge — bulk TX into the hardware FIFO.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include "uart_bulk_tx.h"

#if LINKR_UART_BULK_TX

#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>

#include <hal/uart_hal.h>

/*
 * The bridge's upstream thread used to hand the UART one byte per call:
 *
 *     for (uint16_t i = 0; i < packet.len; i++) {
 *             uart_poll_out(bridge_uart, packet.data[i]);
 *     }
 *
 * uart_poll_out() is documented as "expected to be called from the UART
 * interrupt handler"; from a thread it still works, but it writes the byte one
 * at a time and waits for room with a bare spin. Measured on this build its
 * whole body is 0x32 = 50 bytes of code, and the spin is inside it:
 *
 *      c: l32i.n  a8, a9, 28     ; read UART status
 *     1b: extui   a8, a8, 16, 8  ; txfifo_cnt
 *     1e: beqi    a8, 128, c     ; FIFO full -> re-read, forever
 *
 * The FIFO holds SOC_UART_FIFO_LEN = 128 bytes and a packet is up to 244
 * (BLE_TO_UART_MAX_LEN), so a full packet is 244 trips through that 50-byte
 * function plus ~8 instructions of loop scaffolding in the caller: 244 calls
 * through the device api's function pointer, 244 status reads, 244 single-byte
 * writes — of which the last 116 re-enter the spin because the FIFO is full.
 *
 * This file does not try to make the line faster, because it cannot: a 244-byte
 * packet at 115200 baud is 21.2 ms of serialisation no matter what the firmware
 * does, and that is the 11520 B/s ceiling on the whole link. What it changes is
 * the width of the write — one call per FIFO fill instead of one per byte — so
 * the per-packet driver overhead falls from 244 round trips to a handful. The
 * CPU time that frees is real (the difference between ~1950 instructions of
 * scaffolding and a few dozen) but it is a CPU saving, not a throughput saving,
 * and it is worth stating that plainly rather than as a speed-up.
 *
 * Note on priority: the bridge thread runs at priority 7 (preemptive) while
 * the BLE stack's threads run at -1 (cooperative), and in Zephyr the negative
 * range is the HIGHER priority. The cooperative threads therefore preempt this
 * one, not the other way round, so nothing here is needed to keep them fed —
 * the argument for this change is the redundant driver work, not starvation.
 *
 * Two things this deliberately does not do:
 *
 *  - It does not sleep a computed byte time. K_USEC() is tick-based, and this
 *    build runs at CONFIG_SYS_CLOCK_TICKS_PER_SEC=10000, so the shortest real
 *    sleep is one tick = 100 us. That clears 115200's 86.8 us by a hair, but
 *    it would throttle the rates the Kconfig help itself calls typical for an
 *    SBC console — 921600 is 10.9 us a byte and 1500000 is 6.7 us — by an
 *    order of magnitude, and autobaud can move the port to either at runtime.
 *    A wait whose correctness depends on which rate happens to be programmed
 *    is not worth having here.
 *  - It does not use the driver's interrupt-driven TX path. That path exists
 *    only under CONFIG_UART_INTERRUPT_DRIVEN, and uart_fifo_fill() carries the
 *    same ISR-only warning as uart_poll_out(). Driving it from this thread
 *    would mean changing the driver's contract for a throughput win, which is
 *    exactly the kind of shared-code change this option exists to avoid.
 */

/*
 * While the FIFO is full there is nothing to do but wait for line time, and
 * unlike a byte-time sleep this is correct at every rate: the FIFO's own
 * occupancy says when there is room. k_yield() does not wait for a tick, so it
 * costs no more than the spin it replaces.
 */
static inline void wait_for_fifo_space(void)
{
	k_yield();
}

void linkr_uart_bulk_write(uintptr_t reg_addr, uint32_t baudrate,
			   const uint8_t *data, size_t len)
{
	uart_hal_context_t hal = {
		.dev = (uart_dev_t *)reg_addr,
	};

	/*
	 * Unused; kept in the signature so the bulk path and the
	 * byte-at-a-time path share one call shape at the call site. This
	 * writer does not need the rate: the FIFO's own occupancy is a
	 * better clock than any computed byte time, and it stays correct
	 * when autobaud changes the rate underneath us.
	 */
	(void)baudrate;

	if (data == NULL || len == 0) {
		return;
	}

	while (len > 0) {
		uint32_t free_slots = uart_hal_get_txfifo_len(&hal);
		uint32_t written = 0;

		if (free_slots == 0) {
			wait_for_fifo_space();
			continue;
		}

		/*
		 * Never offer more than the free space, so `written` is always
		 * > 0 and the loop cannot stall on a clamped write.
		 */
		uint32_t chunk = (uint32_t)MIN((size_t)free_slots, len);

		uart_hal_write_txfifo(&hal, data, chunk, &written);
		if (written == 0) {
			/* Only if the FIFO filled between the length read and
			 * the write. Same yield; the loop retries. */
			wait_for_fifo_space();
			continue;
		}

		data += written;
		len -= written;
	}
}

#endif /* LINKR_UART_BULK_TX */
