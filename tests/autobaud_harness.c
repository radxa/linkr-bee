/* Host-only fakes around the production autobaud block, sliced in by
 * tests/test_autobaud.py. No Zephyr workqueue, no Espressif silicon: the
 * scenario hands the follower the span a capture would have reported and the
 * divider is computed the way src/main.c programs it, so every number the
 * decision sees has been through the real arithmetic.
 *
 * Raw-capture scenarios run the production span classifier against fake
 * RMT memory; the older focused decision scenarios supply a span directly. */
#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ARG_UNUSED(x) (void)(x)
#define K_MSEC(x) (x)
#define K_NO_WAIT 0

/* Zephyr's LOG_WRN evaluates its arguments (it is a real logging macro); the
 * harness discards them, but still evaluates them so a helper used only
 * inside a log line is not an unused function under -Werror. */
static void log_discard(const char *fmt, ...)
{
	(void)fmt;
}
#define LOG_WRN(...) log_discard(__VA_ARGS__)
#define LOG_INF(...) log_discard(__VA_ARGS__)
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))

/*
 * 80 MHz — the source clock the divider arithmetic assumes. The clock
 * cancels out of the production formula, but a simulation still needs one to
 * turn a bit-time into cycles the way the receiver would count them.
 */
#define SOURCE_HZ 80000000ull
#define K_FOREVER -1

enum { UART_CFG_PARITY_NONE, UART_CFG_PARITY_ODD, UART_CFG_PARITY_EVEN };
enum { UART_CFG_STOP_BITS_0_5, UART_CFG_STOP_BITS_1,
       UART_CFG_STOP_BITS_1_5, UART_CFG_STOP_BITS_2 };
enum { UART_CFG_DATA_BITS_5, UART_CFG_DATA_BITS_6, UART_CFG_DATA_BITS_7,
       UART_CFG_DATA_BITS_8, UART_CFG_DATA_BITS_9 };
struct uart_config {
	uint32_t data_bits, parity, stop_bits;
};
static struct uart_config active_uart_config = {
	.data_bits = UART_CFG_DATA_BITS_8,
	.parity = UART_CFG_PARITY_NONE,
	.stop_bits = UART_CFG_STOP_BITS_1,
};
static int uart_config_lock;
static void k_mutex_lock(int *lock, int timeout) { (void)lock; (void)timeout; }
static void k_mutex_unlock(int *lock) { (void)lock; }
#include "uart_frame_functions.inc"

struct k_work {
	int unused;
};

struct k_work_delayable {
	int unused;
};

/* The span the follower reads, as the RMT receiver would have filled it. */
struct linkr_uart_span {
	uint32_t est_q8;
	uint32_t dmin;
	uint32_t runs;
	uint32_t bits;
	uint32_t misfits;
	uint32_t zeros;
	bool trustworthy;
};

typedef struct {
	struct {
		uint32_t div_int;
		uint32_t div_frag;
	} clk_div;
} uart_dev_t;

static uart_dev_t fake_uart;
static uint32_t fake_now_ms;
static uint32_t configured_baud = 115200;
static int reconfigure_calls;
static uint32_t reconfigured_to;

/* The faked capture and pin level for the window about to run. */
static struct linkr_uart_span fake_span;
static bool fake_captured = true;
static int fake_line_level = 1;

static void k_work_reschedule(struct k_work_delayable *work, int32_t ms)
{
	(void)work;
	(void)ms;
}

static void k_work_init_delayable(struct k_work_delayable *work,
				  void (*handler)(struct k_work *))
{
	(void)work;
	(void)handler;
}

static uint32_t k_uptime_get_32(void)
{
	return fake_now_ms;
}

/* The production block's request flags. A single-threaded harness needs no
 * real atomics, but it must preserve the compare-and-set contract. */
typedef int atomic_t;

static int atomic_get(atomic_t *target)
{
	return *target;
}

static void atomic_set(atomic_t *target, int value)
{
	*target = value;
}

static int atomic_cas(atomic_t *target, int old_value, int new_value)
{
	if (*target != old_value) {
		return 0;
	}
	*target = new_value;
	return 1;
}

/* From uart_autobaud.h; copied here because the harness does not build
 * against the Zephyr headers that header pulls in. */
enum linkr_uart_autobaud_result {
	LINKR_UART_AUTOBAUD_APPLIED,
	LINKR_UART_AUTOBAUD_UNCHANGED,
	LINKR_UART_AUTOBAUD_TIMEOUT,
	LINKR_UART_AUTOBAUD_STOPPED,
	LINKR_UART_AUTOBAUD_FAILED,
};

typedef void (*linkr_uart_autobaud_callback_t)(
	enum linkr_uart_autobaud_result result, uint32_t old_baud,
	uint32_t new_baud);

/* What src/main.c programs: cycles-per-bit x 16, split across the integer
 * and fractional halves of clk_div — 694 + 7/16 at 115200, the numbers the
 * tick's own comment quotes. */
static void set_divider(uint32_t baud)
{
	uint32_t div = (uint32_t)(SOURCE_HZ * 16u / baud);

	fake_uart.clk_div.div_int = div >> 4;
	fake_uart.clk_div.div_frag = div & 0xFu;
}

/* The span a line at `baud` reports: every run one bit time, on the grid,
 * enough of them to measure. est_q8 is the bit time in APB cycles, Q8. */
static struct linkr_uart_span span_line(uint32_t baud, uint32_t runs)
{
	struct linkr_uart_span s = {0};

	s.est_q8 = (uint32_t)(SOURCE_HZ * 256u / baud);
	s.dmin = (uint32_t)(SOURCE_HZ / baud);
	s.runs = runs;
	s.bits = runs;
	s.misfits = 0;
	s.zeros = 0;
	s.trustworthy = runs >= 4;
	return s;
}

/* A capture whose runs do not sit on whole multiples of their own estimate —
 * 0xCC, a rate that moved mid-capture, a torn edge. Not a measurement. */
static struct linkr_uart_span span_bad(uint32_t runs)
{
	struct linkr_uart_span s = {0};

	s.runs = runs;
	s.misfits = runs;
	s.trustworthy = false;
	return s;
}

/* A burst's own tail closed by the re-arm: too few runs to measure, and not
 * a refusal either — the line said something, just not enough. */
static struct linkr_uart_span span_tail(uint32_t runs)
{
	struct linkr_uart_span s = {0};

	s.runs = runs;
	s.trustworthy = false;
	return s;
}

uint32_t linkr_uart_config_current(void);
int linkr_uart_config_reconfigure(uint32_t baudrate);

/* The span module's interface, forward-declared so the extracted block below
 * sees them; the definitions follow the block. */
void linkr_uart_rmt_span_init(uintptr_t uart_reg_addr);
bool linkr_uart_rmt_span_poll(struct linkr_uart_span *span);
int linkr_uart_rmt_span_line_level(void);

/* Public follower predicates, normally declared by uart_autobaud.h. The
 * production stop() calls running(); the header supplies this in firmware. */
bool linkr_uart_autobaud_running(void);

/* From uart_rmt_span.h; the block's burst-tail test uses it. */
#define LINKR_UART_SPAN_MIN_RUNS 4u

#define SPAN_CH 0u
#define SPAN_MEM_WORDS 64u
#define SPAN_DIV 4u
static uint32_t span_memory[SPAN_MEM_WORDS];
#define SPAN_MEM span_memory
#include "span_functions.inc"

/* Quantize absolute edges at the receiver's APB/4 clock, then let the
 * production classifier interpret the resulting 128 run durations. */
static struct linkr_uart_span raw_span(uint32_t baud, const uint8_t *pattern,
				      size_t pattern_len, uint32_t phase)
{
	uint64_t bits = phase;
	struct linkr_uart_span span = {0};

	for (uint32_t w = 0; w < SPAN_MEM_WORDS; w++) {
		uint32_t pair[2];

		for (uint32_t j = 0; j < 2; j++) {
			uint64_t next = bits + pattern[(2u * w + j) % pattern_len];

			pair[j] = (uint32_t)((next * (SOURCE_HZ / SPAN_DIV) / baud) -
					    (bits * (SOURCE_HZ / SPAN_DIV) / baud));
			bits = next;
		}
		span_memory[w] = pair[0] | (pair[1] << 16);
	}
	span_measure(SPAN_MEM_WORDS, &span);
	return span;
}

#include "autobaud_functions.inc"

uint32_t linkr_uart_config_current(void)
{
	return configured_baud;
}

int linkr_uart_config_reconfigure(uint32_t baudrate)
{
	reconfigure_calls++;
	reconfigured_to = baudrate;
	configured_baud = baudrate;
	set_divider(baudrate);

	return 0;
}

void linkr_uart_rmt_span_init(uintptr_t uart_reg_addr)
{
	(void)uart_reg_addr;
}

bool linkr_uart_rmt_span_poll(struct linkr_uart_span *span)
{
	if (!fake_captured) {
		return false;
	}
	*span = fake_span;
	return true;
}

int linkr_uart_rmt_span_line_level(void)
{
	return fake_line_level;
}

/* One window: hand the follower the span a capture reported (or none, with
 * the pin's level as the witness) and let the real decision read them. */
static void window_span(struct linkr_uart_span s, int level)
{
	fake_now_ms += 400; /* one AUTOBAUD_WINDOW_MS */
	fake_span = s;
	fake_captured = true;
	fake_line_level = level;
	autobaud_tick(NULL);
}

static void window_quiet(int level)
{
	fake_now_ms += 400; /* one AUTOBAUD_WINDOW_MS */
	fake_captured = false;
	fake_line_level = level;
	autobaud_tick(NULL);
}

/*
 * Start a pass and consume the request at the current fake time, matching the
 * firmware's K_NO_WAIT start tick. The start tick must not steal the next
 * window's fake capture (the firmware's tick 400 ms later gets a fresh one).
 */
static void start_pass(void)
{
	fake_captured = false;
	fake_line_level = 1;
	if (linkr_uart_autobaud_request() != 0) {
		abort();
	}
	autobaud_tick(NULL);
}

static int result_count;
static enum linkr_uart_autobaud_result last_result;
static uint32_t result_old;
static uint32_t result_new;

static void autobaud_result(enum linkr_uart_autobaud_result result,
			    uint32_t old_baud, uint32_t new_baud)
{
	result_count++;
	last_result = result;
	result_old = old_baud;
	result_new = new_baud;
}

/* No request: this is the boot state the product must keep. A line that
 * would otherwise be followed must not move the port. */
static void scenario_idle(void)
{
	for (int i = 0; i < 20; i++) {
		window_span(span_line(9600, 8), 1);
	}
}

/* A pass with no traffic ends after the inactivity timeout; it must not
 * leave the RMT receiver or the work item running forever. */
static void scenario_timeout(void)
{
	for (int i = 0; i < 15; i++) {
		window_quiet(1);
	}
}

/* A user stop reports STOPPED and leaves the port alone. */
static void scenario_stop(void)
{
	window_quiet(1); /* one empty window, pass remains active */

	if (linkr_uart_autobaud_stop() != 0) {
		abort();
	}
	window_quiet(1); /* consume the stop request */
}

/* A link that has been measured against the port, followed by a stream with
 * no single-bit run in it anywhere — 0xCC carries runs of two and three bits,
 * which classify to a non-integer fit, so the capture is not a measurement
 * and the port must not move. */
static void scenario_verified_then_binary(void)
{
	window_span(span_line(115200, 8), 1); /* match: pass ends */
	start_pass();

	for (int i = 0; i < 6; i++) {
		window_span(span_bad(8), 1);
	}
}

/* Nothing has matched the port yet, so a peer that really is slower is still
 * followed — the reason the feature exists. */
static void scenario_startup_follows_a_slower_peer(void)
{
	window_span(span_line(9600, 8), 1);
	window_span(span_line(9600, 8), 1);
}

/* A verified link whose peer speeds up: no absent single-bit run can read
 * high, so this direction stays open — it is where the Kconfig's 1500000 /
 * 921600 / 1000000 consoles come from. */
static void scenario_verified_step_up(void)
{
	window_span(span_line(115200, 8), 1); /* match: pass ends */
	start_pass();
	window_span(span_line(921600, 8), 1);
	window_span(span_line(921600, 8), 1);
}

/* A second manual pass must be able to undo a divisor-shaped rate the first
 * pass applied. Starting a new pass is not evidence that the rate the last
 * pass chose is correct, so it must not re-trust it. */
static void scenario_second_pass_can_undo_applied_rate(void)
{
	window_span(span_line(921600, 8), 1);
	window_span(span_line(921600, 8), 1); /* apply 921600, ends pass */

	start_pass(); /* this is a new @a, not a continuation */
	window_span(span_line(115200, 8), 1);
	window_span(span_line(115200, 8), 1); /* 921600/8: apply 115200 */
}

/* Verified, then a peer that slowed to a rate our own is *not* divided by:
 * not the shape of a missing single-bit run, so it is still believed. */
static void scenario_verified_other_rate(void)
{
	configured_baud = 1500000;
	set_divider(configured_baud);

	window_span(span_line(1500000, 8), 1); /* match: pass ends */
	start_pass();
	window_span(span_line(115200, 8), 1);
	window_span(span_line(115200, 8), 1);
}

/* Straight out of reset, before the line has ever been measured: a stream with
 * no single-bit run arrives. 0xCC on a true 115200 line classifies to a
 * non-integer fit, which is refused. Moving there would be a guess, and the
 * same capture would then read as a match at the rate the port just moved to,
 * so no later window would ever disagree with it. The port has to hold. */
static void scenario_startup_binary(void)
{
	for (int i = 0; i < 20; i++) {
		window_span(span_bad(8), 1);
	}
}

/* One empty window between two bursts of the same link must not reopen the
 * refusal: a peer's bursts are ~200 ms apart and the window is 400 ms, so an
 * empty one arrives on timing alone. Followed by a stream with no single-bit
 * run, which still has to be refused. */
static void scenario_one_gap_does_not_reopen(void)
{
	window_span(span_line(115200, 8), 1); /* match: pass ends */
	start_pass();
	window_quiet(1);
	for (int i = 0; i < 6; i++) {
		window_span(span_bad(8), 1);
	}
}

/* The refusal must be a delay, not a lock. 921600 -> 115200 is a whole
 * divisor of our own (/8), which is exactly the shape of a missing single-bit
 * run and so refused while the link is busy — but after the line has been
 * quiet long enough that it is no longer the link we measured, it is
 * followed. */
static void scenario_quiet_then_an_integer_slowdown(void)
{
	configured_baud = 921600;
	set_divider(configured_baud);

	window_span(span_line(921600, 8), 1); /* match: pass ends */
	start_pass();

	for (int i = 0; i < 10; i++) {
		window_quiet(1);
	}
	for (int i = 0; i < 20; i++) {
		window_span(span_line(115200, 8), 1);
	}
}

/* The gap this closes: the line has been quiet long enough to hand the
 * evidence back, and *then* a stream with no single-bit run arrives — an idle
 * prompt followed by a binary file. 0xCC on a true 115200 line reads our own
 * rate over two bit-times in every window, which is inside the two-to-five a
 * byte stream can reach, so it is still refused after the silence. */
static void scenario_quiet_then_a_short_binary(void)
{
	window_span(span_line(115200, 8), 1); /* match: pass ends */
	start_pass();

	for (int i = 0; i < 10; i++) {
		window_quiet(1);
	}
	for (int i = 0; i < 20; i++) {
		window_span(span_bad(8), 1);
	}
}

/* The other side of the hold, and the reason it is a bound on the gap rather
 * than a list of blessed rates: a peer that really is at a rate the snap
 * table does not know must still be followed. 150000 is 30% above our
 * 115200 — a real move, far outside any band we hold — and it is not a
 * divisor of ours, so two agreeing windows take the port there exactly as
 * they always did. */
static void scenario_odd_rate_peer_is_followed(void)
{
	window_span(span_line(115200, 8), 1); /* match: pass ends */
	start_pass();

	for (int i = 0; i < 4; i++) {
		window_span(span_line(150000, 8), 1);
	}
}

/* The way out if a port is ever found at a wrong rate anyway — what the real
 * board looked like after the bug moved it: nothing has measured the port at
 * the wrong rate, so it keeps no claim to be trusted, the hold does not apply,
 * and the first clean windows read the true rate, which is neither within
 * the band of a trustworthy port nor a divisor shape, so two of them put the
 * port back. */
static void scenario_stuck_port_recovers(void)
{
	for (int i = 0; i < 10; i++) {
		window_quiet(1);
	}
	configured_baud = 118342;
	set_divider(configured_baud);

	for (int i = 0; i < 8; i++) {
		window_span(span_line(115200, 8), 1); /* clean */
	}

	/* The apply ended that pass. Confirm the restored rate with a fresh
	 * pass so this scenario still checks the re-armed verified state. */
	start_pass();
	window_span(span_line(115200, 8), 1); /* match: unchanged */
}

/* A burst's own tail closed by the re-arm is not a verdict: too few runs to
 * measure, and not a refusal either. The follower leaves the state alone —
 * no forget, no refusal count — so a candidate still waiting for its second
 * window is not lost. */
static void scenario_a_burst_tail_is_not_a_refusal(void)
{
	window_span(span_line(115200, 8), 1); /* match: pass ends */
	start_pass();
	window_span(span_line(9600, 8), 1);   /* candidate: 9600 */
	window_span(span_tail(2), 1);	   /* tail: not a verdict */
	window_span(span_line(9600, 8), 1);   /* confirmed, followed */
}

/* The shortest run is the second opinion the estimate cannot be trusted
 * alone. A byte-gapped stream stretches every run of one polarity, so the
 * fitted estimate walks outside its band while the shortest run — which a
 * gap between bytes does not touch — still sits on the grid and reports our
 * own rate over a run longer than one bit. The estimate alone would confirm
 * a move to a rate the line never carried; the shortest run refuses it. */
static void scenario_the_shortest_run_refuses_what_the_estimate_cannot(void)
{
	configured_baud = 1500000;
	set_divider(configured_baud);

	window_span(span_line(1500000, 8), 1); /* match: pass ends */
	start_pass();

	/* est_q8 reads 1500000/5.5 (off-band, not a divisor), but the shortest
	 * run still reads 1500000/2 — a missing single-bit run. */
	for (int i = 0; i < 6; i++) {
		struct linkr_uart_span s = {0};

		s.est_q8 = (uint32_t)(SOURCE_HZ * 256u / 272727);
		s.dmin = (uint32_t)(SOURCE_HZ / 750000);
		s.runs = 8;
		s.bits = 44;
		s.misfits = 0;
		s.zeros = 0;
		s.trustworthy = true;
		window_span(s, 1);
	}
}

/* A line in space (low) is proof of activity, so a gap-free stream can no
 * longer log "line silent" while it is talking: the pin sample is the witness
 * that tells a silent line from a busy one when no capture came back. */
static void scenario_a_busy_line_is_not_silent(void)
{
	window_span(span_line(115200, 8), 1); /* match: pass ends */
	start_pass();

	for (int i = 0; i < 10; i++) {
		window_quiet(0); /* line in space: busy, not silent */
	}
}

/* A busy line whose gaps are too short for the receiver never produces a
 * capture. The pin sample renews the inactivity clock, so twelve seconds of
 * traffic must not end the pass the way five seconds of genuine silence
 * does. */
static void scenario_a_busy_line_renews_the_timeout(void)
{
	for (int i = 0; i < 30; i++) {
		window_quiet(0);
	}
}

/* The renewal is not unbounded: a line that never goes quiet would otherwise
 * hold the port open forever. At sixty seconds the pass gives up and keeps
 * the configured rate. */
static void scenario_a_busy_line_hits_the_hard_deadline(void)
{
	for (int i = 0; i < 160; i++) { /* 64 s, past the 60 s cap */
		window_quiet(0);
	}
}

static void scenario_raw_rmt_jitter(bool disagrees)
{
	static const uint8_t runs[] = {1}; /* 8N1 0x55 */
	struct linkr_uart_span a = raw_span(150000, runs, ARRAY_SIZE(runs), 0);
	struct linkr_uart_span b = raw_span(disagrees ? 170000 : 150000,
					  runs, ARRAY_SIZE(runs), 1);

	if (!a.trustworthy || !b.trustworthy || a.est_q8 == b.est_q8) {
		abort();
	}
	for (int i = 0; i < 20; i++) {
		window_span(i % 2 ? b : a, 1);
	}
}

static void scenario_raw_binary(bool extended_frame)
{
	static const uint8_t cc[] = {3, 2, 2, 3};
	static const uint8_t e0[] = {6, 6};
	struct linkr_uart_span span;

	if (extended_frame) {
		active_uart_config.parity = UART_CFG_PARITY_EVEN;
		active_uart_config.stop_bits = UART_CFG_STOP_BITS_2;
		for (int i = 0; i < 10; i++) {
			window_quiet(1);
		}
		span = raw_span(115200, e0, ARRAY_SIZE(e0), 0);
		if (!span.trustworthy) {
			abort();
		}
	} else {
		span = raw_span(115200, cc, ARRAY_SIZE(cc), 0);
		if (span.trustworthy) {
			abort();
		}
	}
	for (int i = 0; i < 20; i++) {
		window_span(span, 1);
	}
}

static void scenario_frame_formats(void)
{
	printf("8n1=%u\n", linkr_uart_config_frame_half_bits());
	active_uart_config.parity = UART_CFG_PARITY_EVEN;
	active_uart_config.stop_bits = UART_CFG_STOP_BITS_2;
	printf("8e2=%u\n", linkr_uart_config_frame_half_bits());
	active_uart_config.data_bits = UART_CFG_DATA_BITS_7;
	printf("7e2=%u\n", linkr_uart_config_frame_half_bits());
	active_uart_config.data_bits = UART_CFG_DATA_BITS_8;
	active_uart_config.parity = UART_CFG_PARITY_NONE;
	active_uart_config.stop_bits = UART_CFG_STOP_BITS_1_5;
	printf("8n1_5=%u\n", linkr_uart_config_frame_half_bits());
	active_uart_config.data_bits = UART_CFG_DATA_BITS_5;
	active_uart_config.stop_bits = UART_CFG_STOP_BITS_0_5;
	printf("5n0_5=%u\n", linkr_uart_config_frame_half_bits());
	active_uart_config.data_bits = UART_CFG_DATA_BITS_9;
	active_uart_config.parity = UART_CFG_PARITY_ODD;
	active_uart_config.stop_bits = UART_CFG_STOP_BITS_2;
	printf("9o2=%u\n", linkr_uart_config_frame_half_bits());
}

int main(int argc, char **argv)
{
	const char *scenario = argc > 1 ? argv[1] : "";

	/* The production init itself, not a stand-in: it arms the follower,
	 * starts the window, and holds the cooldown and warning clocks. */
	set_divider(configured_baud);
	linkr_uart_autobaud_init((uintptr_t)&fake_uart);
	linkr_uart_autobaud_set_callback(autobaud_result);

	/* The detector is idle at boot. Every scenario except the idle one
	 * asks for the pass the way @a or the GPIO key would. */
	if (strcmp(scenario, "idle") != 0) {
		start_pass();
	}

	if (strcmp(scenario, "idle") == 0) {
		scenario_idle();
	} else if (strcmp(scenario, "timeout") == 0) {
		scenario_timeout();
	} else if (strcmp(scenario, "stop") == 0) {
		scenario_stop();
	} else if (strcmp(scenario, "raw_rmt_jitter") == 0) {
		scenario_raw_rmt_jitter(false);
	} else if (strcmp(scenario, "raw_rmt_disagrees") == 0) {
		scenario_raw_rmt_jitter(true);
	} else if (strcmp(scenario, "raw_8e2") == 0) {
		scenario_raw_binary(true);
	} else if (strcmp(scenario, "raw_cc") == 0) {
		scenario_raw_binary(false);
	} else if (strcmp(scenario, "frame_formats") == 0) {
		scenario_frame_formats();
	} else if (strcmp(scenario, "verified_then_binary") == 0) {
		scenario_verified_then_binary();
	} else if (strcmp(scenario, "startup_follows_a_slower_peer") == 0) {
		scenario_startup_follows_a_slower_peer();
	} else if (strcmp(scenario, "verified_step_up") == 0) {
		scenario_verified_step_up();
	} else if (strcmp(scenario, "second_pass_can_undo_applied_rate") == 0) {
		scenario_second_pass_can_undo_applied_rate();
	} else if (strcmp(scenario, "verified_other_rate") == 0) {
		scenario_verified_other_rate();
	} else if (strcmp(scenario, "startup_binary") == 0) {
		scenario_startup_binary();
	} else if (strcmp(scenario, "one_gap_does_not_reopen") == 0) {
		scenario_one_gap_does_not_reopen();
	} else if (strcmp(scenario, "quiet_then_an_integer_slowdown") == 0) {
		scenario_quiet_then_an_integer_slowdown();
	} else if (strcmp(scenario, "quiet_then_a_short_binary") == 0) {
		scenario_quiet_then_a_short_binary();
	} else if (strcmp(scenario, "odd_rate_peer_is_followed") == 0) {
		scenario_odd_rate_peer_is_followed();
	} else if (strcmp(scenario, "stuck_port_recovers") == 0) {
		scenario_stuck_port_recovers();
	} else if (strcmp(scenario, "a_burst_tail_is_not_a_refusal") == 0) {
		scenario_a_burst_tail_is_not_a_refusal();
	} else if (strcmp(scenario,
			  "the_shortest_run_refuses_what_the_estimate_cannot") == 0) {
		scenario_the_shortest_run_refuses_what_the_estimate_cannot();
	} else if (strcmp(scenario, "a_busy_line_is_not_silent") == 0) {
		scenario_a_busy_line_is_not_silent();
	} else if (strcmp(scenario, "a_busy_line_renews_the_timeout") == 0) {
		scenario_a_busy_line_renews_the_timeout();
	} else if (strcmp(scenario, "a_busy_line_hits_the_hard_deadline") == 0) {
		scenario_a_busy_line_hits_the_hard_deadline();
	} else {
		fprintf(stderr, "unknown scenario: %s\n", scenario);
		return 2;
	}

	printf("rate=%u\n", configured_baud);
	printf("reconfigs=%d\n", reconfigure_calls);
	printf("last=%u\n", reconfigured_to);
	printf("verified=%d\n", autobaud_verified ? 1 : 0);
	printf("results=%d\n", result_count);
	printf("result=%d\n", result_count ? (int)last_result : -1);
	printf("result_old=%u\n", result_old);
	printf("result_new=%u\n", result_new);

	return 0;
}
