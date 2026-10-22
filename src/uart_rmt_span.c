/*
 * BACKLOG M5 option C — RMT span measurement for the autobaud follower.
 *
 * Why this exists, in one paragraph: the UART's own pulse latches read a
 * constant ~1.3 source-clock cycles short of the true bit time at every rate
 * (692 against 693.3 at 115200, 52 against 53.3 at 1500000 — measured on
 * board -3, 2026-10-17/18), and the low side latches glitch-short pulses
 * while the follower reprograms its own divider (35 against a true 320 cycles
 * at 250000). The RMT receiver's run durations are grid aligned: a duration
 * is the distance between two edges and both edges are quantised the same
 * way, so edge quantisation telescopes out and only the two ends of a
 * captured span keep one tick of it. Sum a train of runs and divide by the
 * bit times they add up to, and the error shrinks with the span instead of
 * staying at "the minimum of many readings". The probe run behind this file
 * (branch probe/rmt-capture; analysis in
 * 改动/666666/autobaud-RMT探针-C方案-2026-10-17.md) measured 19 rates from
 * 2617 to 1500000 and the span estimate beat the latch at all of them; the
 * internals below — channel setup, filter, idle handling, classification
 * against the capture's own shortest run — are that probe's, with only the
 * divider and the packaging changed. Written 2026-10-18 for Novice-PG.
 *
 * Two hardware facts the bench run established, kept next to the code that
 * depends on them:
 *   - direct RMTMEM reads return garbage unless the memory is powered
 *     (rmt_ll_mem_power_by_pmu) and the APB side is switched to non-FIFO
 *     access (rmt_ll_enable_mem_access_nonfifo) — IDF's rmt_hal_init does both;
 *   - the receiver only (re)starts capturing once the line has been idle: a
 *     burst is caught from its first edge, but a re-arm during a running
 *     burst yields nothing further until the burst ends. The follower
 *     measures at the start of a burst, so that is exactly enough.
 *
 * The idle window doubles as an overflow guard and as the measurement floor:
 * a duration is only stored when an edge follows within 819 us, so no stored
 * run can reach the 15-bit limit (twice the window), and a line whose bit
 * time exceeds the window (below ~1.2 kHz) produces no captures at all — the
 * follower reads it as a line it cannot measure and holds its rate (the level
 * witness is what keeps it from calling such a line silent, see
 * uart_autobaud.c). The probe ladder started at 2617 baud; everything a
 * console realistically boots to is far above both floors.
 */
#include "uart_rmt_span.h"

#if LINKR_UART_AUTOBAUD

#include <soc.h>		/* esp_rom_gpio_matrix_in, soc caps */
#include <soc/clk_tree_defs.h>	/* RMT_CLK_SRC_APB (rmt_ll.h wants it) */
#include <soc/dport_reg.h>
#include <soc/gpio_sig_map.h>
#include <soc/gpio_struct.h>
#include <soc/reg_base.h>
#include <soc/rmt_struct.h>
#include <hal/rmt_ll.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/sys_io.h>
#include <zephyr/sys/util.h>

/* Shares main.c's log source: same prefix, no second source slot in RAM. */
LOG_MODULE_DECLARE(linkr_ble_bridge, LOG_LEVEL_INF);

#define SPAN_CH		0u
/*
 * Channel clock = APB / 4 (50 ns per count). The probe validated the
 * durations at APB/1; the divider buys the range the product needs without
 * costing precision that matters: an RMT duration is 15 bits, so at APB/1 the
 * shortest run of a line slower than ~2400 baud already overflows it, while
 * at APB/4 that floor drops to ~610 baud and runs of the whole 15-bit range
 * still fit, and the span quantisation this leaves behind (one 50 ns tick
 * over a >= 128-run span at 1500000, i.e. < 0.01%) is far inside the 2% the
 * decision logic trusts. The 42 ppm the probe reported between the two boards
 * is a crystal difference that cancels: this board programs its own divider
 * from its own ticks.
 */
#define SPAN_DIV	4u
#define SPAN_FILTER_TICKS 4u	/* 200 ns in channel ticks, like the UART's */
/*
 * 819 us, half the 15-bit duration limit (1.639 ms at 50 ns per tick): a run
 * long enough to overflow the field would have to go 819 us without an edge,
 * and the idle window closes the capture first, so no stored duration can
 * ever wrap. Rates whose bits are that long (below ~1.2 kHz) are simply not
 * captured — see the .c header.
 */
#define SPAN_IDLE_TICKS	16384u

#define SPAN_MEM_WORDS	SOC_RMT_MEM_WORDS_PER_CHANNEL
/* RMTMEM in the ROM linker script: 0x3ff56800 = RMT base + 0x800. */
#define SPAN_MEM	((volatile uint32_t *)(DR_REG_RMT_BASE + 0x800u))

static rmt_dev_t *span_rmt;
static bool span_ready;
static int span_rx_pin = -1;

/*
 * One capture, as the follower reads it: sum the runs, classify each against
 * the shortest run, and hand back the span estimate. Nothing here decides
 * anything — the thresholds that make a capture trustworthy are the module's,
 * the decisions are uart_autobaud.c's.
 *
 * The classification: any framed stream is built of runs that are whole
 * numbers of bit times, so every run is k bit times for some k >= 1, and the
 * shortest run present is the best candidate for one. (Merged edges, seen at
 * 1500000 as two bits arriving as one run, stay whole numbers and absorb into
 * their own k.) est = sum / sum(k) then converts every run to the same bit
 * time instead of trusting any single pulse.
 *
 * The trust check: if the shortest run was not one bit long but two or more
 * (a stream whose byte pattern never leaves a single-bit run), the fit comes
 * out self-consistent at the wrong multiple, and the follower's refusal logic
 * is what catches that shape. What this check adds is the opposite failure —
 * a capture whose runs are NOT consistent with integer multiples of their own
 * estimate (a rate that moved mid-capture, a torn edge, a stream like 0xCC
 * that classifies to a non-integer fit). Those are rejected here instead of
 * being dressed up as a rate.
 */
static void span_measure(uint32_t words, struct linkr_uart_span *span)
{
	uint32_t sum = 0, dmin = UINT32_MAX, runs = 0, zeros = 0;
	uint32_t bits = 0, misfits = 0, est_q8 = 0;

	for (uint32_t w = 0; w < words; w++) {
		uint32_t v = SPAN_MEM[SPAN_CH * SPAN_MEM_WORDS + w];
		uint16_t d[2] = { (uint16_t)(v & 0x7FFFu),
				  (uint16_t)((v >> 16) & 0x7FFFu) };

		for (uint32_t i = 0; i < 2u; i++) {
			if (d[i] == 0u) {
				zeros++;
				continue;
			}
			sum += d[i];
			runs++;
			dmin = MIN(dmin, d[i]);
		}
	}

	span->runs = runs;
	span->zeros = zeros;
	/* dmin leaves this module in the follower's units too, APB cycles. */
	span->dmin = (dmin != UINT32_MAX) ? dmin * SPAN_DIV : 0u;
	span->bits = 0u;
	span->misfits = 0u;
	span->est_q8 = 0u;
	span->trustworthy = false;

	if (runs == 0u) {
		return;
	}

	/* Bit times the capture adds up to, against its own shortest run. */
	for (uint32_t w = 0; w < words; w++) {
		uint32_t v = SPAN_MEM[SPAN_CH * SPAN_MEM_WORDS + w];
		uint16_t d[2] = { (uint16_t)(v & 0x7FFFu),
				  (uint16_t)((v >> 16) & 0x7FFFu) };

		for (uint32_t i = 0; i < 2u; i++) {
			uint32_t m;

			if (d[i] == 0u) {
				continue;
			}
			m = (d[i] + dmin / 2u) / dmin;
			bits += MAX(m, 1u);
		}
	}

	/* Q8 of a channel-clock tick; Q8 keeps the quantisation far below
	 * the span's own +/-1 tick even at the fastest rates. */
	est_q8 = (uint32_t)((((uint64_t)sum) << 8) / bits);

	/* Every run must sit within an eighth of a bit time of a multiple. */
	for (uint32_t w = 0; w < words; w++) {
		uint32_t v = SPAN_MEM[SPAN_CH * SPAN_MEM_WORDS + w];
		uint16_t d[2] = { (uint16_t)(v & 0x7FFFu),
				  (uint16_t)((v >> 16) & 0x7FFFu) };

		for (uint32_t i = 0; i < 2u; i++) {
			uint64_t delta;
			uint32_t m;

			if (d[i] == 0u) {
				continue;
			}
			m = (d[i] + dmin / 2u) / dmin;
			m = MAX(m, 1u);
			delta = (uint64_t)d[i] << 8;
			delta = delta > (uint64_t)m * est_q8 ?
				delta - (uint64_t)m * est_q8 :
				(uint64_t)m * est_q8 - delta;
			if (delta * 8u > est_q8) {
				misfits++;
			}
		}
	}

	span->bits = bits;
	span->misfits = misfits;
	/* The follower's units, not this module's: APB cycles in 256ths. */
	span->est_q8 = est_q8 * SPAN_DIV;
	span->trustworthy = runs >= LINKR_UART_SPAN_MIN_RUNS && misfits * 8u <= runs;
}

void linkr_uart_rmt_span_init(uintptr_t uart_reg_addr)
{
	gpio_dev_t *gpio = (gpio_dev_t *)DR_REG_GPIO_BASE;
	uint32_t en, rst, idx;
	int pin;

	span_rmt = (rmt_dev_t *)DR_REG_RMT_BASE;

	/*
	 * Which GPIO matrix input the bridge UART listens on. The instance is
	 * derived from the register base the follower was handed, and the pin
	 * is read back at run time rather than written down, so this watches
	 * exactly the line the port reads — no board constant anywhere.
	 */
	if (uart_reg_addr == DT_REG_ADDR(DT_NODELABEL(uart0))) {
		idx = U0RXD_IN_IDX;
	} else if (uart_reg_addr == DT_REG_ADDR(DT_NODELABEL(uart1))) {
		idx = U1RXD_IN_IDX;
	} else if (uart_reg_addr == DT_REG_ADDR(DT_NODELABEL(uart2))) {
		idx = U2RXD_IN_IDX;
	} else {
		LOG_WRN("rmt span: UART at 0x%lx has no RX matrix input, "
			"disabled", (unsigned long)uart_reg_addr);
		return;
	}

	pin = gpio->func_in_sel_cfg[idx].sig_in_sel ?
	      (int)gpio->func_in_sel_cfg[idx].func_sel : -1;
	if (pin < 0 || pin > 39) {
		/* sig_in_sel == 0 means the RX pin is direct-muxed, which this
		 * lookup cannot see; the bridge UART is matrix-routed on every
		 * board this firmware ships, so warn and stay out of the way. */
		LOG_WRN("rmt span: no GPIO via the matrix on RX in %u (sel=%d), "
			"disabled", idx, pin);
		return;
	}

	/* Clock on, module out of reset. The LL helpers for these two are
	 * wrapped macros wanting ESP-IDF's RCC atomicity context, so the two
	 * DPORT bits are written directly. */
	en = sys_read32(DPORT_PERIP_CLK_EN_REG);
	sys_write32(en | DPORT_RMT_CLK_EN, DPORT_PERIP_CLK_EN_REG);
	rst = sys_read32(DPORT_PERIP_RST_EN_REG);
	sys_write32(rst | DPORT_RMT_RST, DPORT_PERIP_RST_EN_REG);
	sys_write32(rst & ~DPORT_RMT_RST, DPORT_PERIP_RST_EN_REG);

	/* Exactly like IDF's rmt_hal_init: power the memory by PMU and put
	 * the APB side into direct-RMTMEM (non-FIFO) access. Without the
	 * latter the words read above are not the RAM at all. */
	rmt_ll_mem_power_by_pmu(span_rmt);
	rmt_ll_enable_mem_access_nonfifo(span_rmt, true);

	rmt_ll_set_group_clock_src(span_rmt, SPAN_CH, RMT_CLK_SRC_APB, 1u, 0u, 0u);
	rmt_ll_rx_set_channel_clock_div(span_rmt, SPAN_CH, SPAN_DIV);
	rmt_ll_rx_set_mem_blocks(span_rmt, SPAN_CH, 1u);
	rmt_ll_rx_set_idle_thres(span_rmt, SPAN_CH, SPAN_IDLE_TICKS);
	rmt_ll_rx_enable_filter(span_rmt, SPAN_CH, true);
	rmt_ll_rx_set_filter_thres(span_rmt, SPAN_CH, SPAN_FILTER_TICKS);

	/* One more listener on the same GPIO: the matrix input signal is
	 * duplicated into RMT, nothing about the UART's routing changes. */
	esp_rom_gpio_matrix_in((uint32_t)pin, RMT_SIG_IN0_IDX + SPAN_CH, false);

	rmt_ll_rx_reset_pointer(span_rmt, SPAN_CH);
	rmt_ll_rx_set_mem_owner(span_rmt, SPAN_CH, RMT_LL_MEM_OWNER_HW);
	rmt_ll_rx_enable(span_rmt, SPAN_CH, true);

	span_rx_pin = pin;
	span_ready = true;
	LOG_WRN("rmt span: armed on GPIO%d (UART RX), ch=%u div=%u filter=%u "
		"idle=%u", pin, SPAN_CH, SPAN_DIV, SPAN_FILTER_TICKS,
		SPAN_IDLE_TICKS);
}

bool linkr_uart_rmt_span_poll(struct linkr_uart_span *span)
{
	uint32_t ev, words;

	if (!span_ready) {
		return false;
	}

	ev = rmt_ll_rx_get_interrupt_status_raw(span_rmt, SPAN_CH);
	if (ev == 0u) {
		return false;
	}

	rmt_ll_rx_enable(span_rmt, SPAN_CH, false);
	words = MIN(rmt_ll_rx_get_memory_writer_offset(span_rmt, SPAN_CH),
		    SPAN_MEM_WORDS);
	span_measure(words, span);
	rmt_ll_clear_interrupt_status(span_rmt, ev);

	/* Teardown + re-arm, mirroring IDF's rmt_hal_rx_channel_reset
	 * (divider reset pulse, pointer reset, config re-applied, owner,
	 * enable). The next capture only begins once the line has gone idle
	 * again — a re-arm in the middle of a running burst is a no-op — so
	 * each window measures a burst from its first edge, which is exactly
	 * how the follower wants it. */
	rmt_ll_rx_reset_channels_clock_div(span_rmt, 1u << SPAN_CH);
	span_rmt->conf_ch[SPAN_CH].conf1.ref_cnt_rst = 0;
	rmt_ll_rx_reset_pointer(span_rmt, SPAN_CH);
	rmt_ll_rx_set_channel_clock_div(span_rmt, SPAN_CH, SPAN_DIV);
	rmt_ll_rx_set_mem_blocks(span_rmt, SPAN_CH, 1u);
	rmt_ll_rx_set_idle_thres(span_rmt, SPAN_CH, SPAN_IDLE_TICKS);
	rmt_ll_rx_enable_filter(span_rmt, SPAN_CH, true);
	rmt_ll_rx_set_filter_thres(span_rmt, SPAN_CH, SPAN_FILTER_TICKS);
	rmt_ll_rx_set_mem_owner(span_rmt, SPAN_CH, RMT_LL_MEM_OWNER_HW);
	rmt_ll_rx_enable(span_rmt, SPAN_CH, true);

	return words > 0u;
}

int linkr_uart_rmt_span_line_level(void)
{
	gpio_dev_t *gpio = (gpio_dev_t *)DR_REG_GPIO_BASE;

	if (!span_ready || span_rx_pin < 0) {
		return -1;
	}

	if (span_rx_pin < 32) {
		return (int)((gpio->in >> span_rx_pin) & 1u);
	}

	return (int)((gpio->in1.data >> (span_rx_pin - 32)) & 1u);
}

#endif /* LINKR_UART_AUTOBAUD */
