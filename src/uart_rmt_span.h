/*
 * BACKLOG M5 option C — the span measurement behind the autobaud follower.
 *
 * This is the file that replaced the UART's own pulse detector
 * (UART_LOWPULSE/UART_HIGHPULSE) as the follower's source of numbers. The
 * detector's two flaws were measured on a real link before this was written:
 * the latch reads a constant ~1.3 source-clock cycles short at every rate
 * (692 against 693.3 at 115200, 52 against 53.3 at 1500000 — so the error is a
 * fixed number of cycles, seven times heavier at 1500000 than at 115200), and
 * the low side latches glitch-short pulses while the follower reprograms its
 * own divider (35 against a true 320 cycles at 250000). The RMT receiver has
 * neither flaw: its run durations are grid aligned, so summing a whole train
 * of runs and dividing by the number of bit times those runs add up to leaves
 * quantisation only at the two ends of the span. 19 rates, 2617..1500000,
 * measured with that rule before a line of decision logic was touched — see
 * 改动/666666/autobaud-RMT探针-C方案-2026-10-17.md and branch
 * probe/rmt-capture for the experiment, its raw logs and the numbers.
 *
 * The module is a separate translation unit for the same reason
 * uart_autobaud.c is: src/main.c, Kconfig and CMakeLists.txt are compiled by
 * every board (esp32, esp32c3, esp32c5), and this file's Espressif register
 * work has no business sitting in any of them. The gate is the follower's own
 * LINKR_UART_AUTOBAUD, so with CONFIG_LINKR_BLE_BRIDGE_UART_AUTOBAUD off this
 * header collapses to no-op stubs and the .c compiles to nothing.
 *
 * Written 2026-10-18 for Novice-PG (linkr-bee), built on the probe run of the
 * same date. Contract: linkr_uart_rmt_span_init() once, after the port has
 * been configured; then linkr_uart_rmt_span_poll() once per autobaud window
 * (400 ms), from the system workqueue. It reads whatever one capture
 * completed and re-arms for the next one — a burst between two polls may be
 * missed, and that costs nothing: one good capture is all the follower needs
 * to know the rate, and the next window brings another.
 */
#ifndef LINKR_UART_RMT_SPAN_H_
#define LINKR_UART_RMT_SPAN_H_

#include <stdbool.h>
#include <stdint.h>

#include "uart_autobaud.h" /* the follower's gate, and only that */

/* Also visible to the disabled-feature inline stubs below. */
struct linkr_uart_span;

#if LINKR_UART_AUTOBAUD

/**
 * The fewest runs a capture can be measured from. Below this there is not
 * enough of a train to tell a single-bit run from a wider one, and the
 * capture is not a measurement at all — on the bench, a burst's own tail
 * closed by the re-arm reads as two runs. The follower uses the same number
 * to tell those arming tails from real misfits (see uart_autobaud.c).
 */
#define LINKR_UART_SPAN_MIN_RUNS 4u

/**
 * One capture's worth of measurement, as handed to the decision logic.
 *
 * All cycle counts are APB cycles (12.5 ns at the default 80 MHz), the unit
 * the follower and its logs have always used.
 */
struct linkr_uart_span {
	/**
	 * Bit time as (sum of run durations) / (bit times they add up to),
	 * in 256ths of an APB cycle — the span estimate the probe run
	 * validated. Q8 rather than a coarser fraction because the fastest
	 * lines make a bit only ~13 channel ticks long, where sixteenths
	 * alone would quantise the estimate by up to 0.5%; Q8 puts the same
	 * error 16x below the span's own +/-1 tick. 0 when runs == 0.
	 */
	uint32_t est_q8;
	uint32_t dmin;	  /* shortest run, APB cycles */
	uint32_t runs;	  /* nonzero runs the estimate was built from */
	uint32_t bits;	  /* bit times those runs add up to */
	uint32_t misfits; /* runs further than est/8 from an est multiple */
	uint32_t zeros;	  /* zero-length entries, skipped */
	/**
	 * True when the capture can carry the estimate: enough runs for a
	 * span, and a self-consistent fit (see the .c header). A capture
	 * that is not trustworthy is still a capture — the line did
	 * something — but it is no measurement.
	 */
	bool trustworthy;
};

/**
 * Start listening on the bridge UART's RX pin. Call once, after the port has
 * been configured. Logs and disables itself when it cannot find the pin.
 *
 * @param uart_reg_addr MMIO base of the bridge UART, as DT_REG_ADDR().
 */
void linkr_uart_rmt_span_init(uintptr_t uart_reg_addr);

/**
 * Read one completed capture, if there is one, and re-arm.
 *
 * @param span Filled only when the return value is true.
 *
 * @return true when a capture completed since the last poll; false when the
 *         line produced nothing to measure (or the module is disabled). When
 *         true, all span fields are valid; span.runs == 0 means an empty
 *         capture and span.trustworthy is false.
 */
bool linkr_uart_rmt_span_poll(struct linkr_uart_span *span);

/**
 * The RX pin's level right now, as a witness that does not go through the
 * receiver: 1 an idle (high) line, 0 a line in space. A low sample is proof
 * the line has been active; a high one is only a line not caught mid-bit.
 * This is what tells a silent line (nothing to capture because nothing was
 * said) apart from a busy one (nothing to capture because the receiver, which
 * only begins once the line has been idle, found no idle to begin from).
 *
 * @return 0 or 1, or -1 while the module is not armed.
 */
int linkr_uart_rmt_span_line_level(void);

#else

static inline void linkr_uart_rmt_span_init(uintptr_t uart_reg_addr)
{
	(void)uart_reg_addr;
}

static inline bool linkr_uart_rmt_span_poll(struct linkr_uart_span *span)
{
	(void)span;

	return false;
}

static inline int linkr_uart_rmt_span_line_level(void)
{
	return -1;
}

#endif /* LINKR_UART_AUTOBAUD */

#endif /* LINKR_UART_RMT_SPAN_H_ */
