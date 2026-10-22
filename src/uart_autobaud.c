/*
 * BACKLOG M5 — follow the peer's line rate instead of demanding it match us.
 *
 * The port is configured once from CONFIG_LINKR_BLE_BRIDGE_UART_BAUD_RATE and
 * never questioned, while that same Kconfig's help lists 1500000 / 921600 /
 * 1000000 as typical SBC console rates: swap the SBC and the bridge goes deaf
 * with nothing in the firmware noticing. "Linkr adapts to the host" is the
 * direction that has to hold — the SBC must not be asked to change a single
 * stty to suit this board.
 *
 * The number this file decides on comes from the RMT span measurement in
 * uart_rmt_span.c, not from the UART's own pulse detector any more. That
 * detector's latches read a constant ~1.3 source-clock cycles short at every
 * rate, and the low side latches glitch-short pulses while the divider is
 * being rewritten — both measured on real hardware (see uart_rmt_span.h for
 * the story and the numbers, and 改动/666666/autobaud-RMT探针-C方案-2026-10-17.md
 * for the probe run that replaced it). What any detector hands back is still
 * only a measurement: software has to turn it into a rate, decide whether to
 * believe it, and program the divider — that is what the rest of this file
 * does. The rules below outlived the latch; where a rule existed only for the
 * latch's own error the paragraph says so, and the one that no longer has a
 * reason to exist is gone.
 *
 * How it decides to look: it does not read the traffic at all. An earlier
 * version waited for a window of mostly non-printable bytes, because a rate
 * mismatch is supposed to turn a console into garbage. Measured on real
 * hardware, that assumption does not hold — the same 0x55 test stream decoded
 * as 0x21 ('!') with *zero* unprintable bytes at 19200 vs 115200, and as only
 * 21/96 at 115200 vs 921600, while 50-52% cases sat right on the threshold.
 * Those two links stayed broken and the firmware never noticed. Byte content
 * is a guess; the pulse width is a measurement, so a requested pass arms the
 * receiver and judges every window on what the line actually did.
 *
 * The window is 400 ms rather than a few tens: the peer's traffic is bursty
 * (measured: a burst about every 200 ms), a capture is only complete once a
 * burst ends (or fills its 128 runs), and the receiver only starts again from
 * the next burst's first edge — so a shorter window can come back empty and a
 * window shorter than the burst period would depend on luck. A window without
 * a capture is not a failure — it means the line produced no burst to
 * measure since the last visit, which says nothing about the rate — so it
 * costs nothing and never blocks a later answer. (A stream of 0x00 or 0xFF is not empty — the start
 * and stop bits keep toggling the line, so it also keeps resetting the silence
 * counter — and it measures cleanly, too: its lone bit is a one-bit run, so
 * the span estimate lands on the true rate. The latch used to throw these
 * windows out — its two polarities timed runs of nine and one — and no longer
 * being thrown out changes nothing: a match is a match.)
 *
 * Two windows must agree within 2% before the port is touched. Comparing
 * integer baud values exactly would reject ordinary edge quantisation at
 * rates outside the snap table. A single window can be
 * wrong: a glitch that survives the filter, or a byte with no single-bit run
 * (only bytes >= 0x80 with a zero LSB manage that, so it needs a whole window
 * of them), would report half or a third of the real rate. The line does not
 * change when we guess badly, so the next windows measure the true rate again
 * and put it back — the measurement depends only on RXD, never on what the
 * port is currently set to.
 *
 * It leaves everything alone when the measurement lands within 2% of what we
 * already have. UART is good for that much, so the bytes were not a rate
 * problem and reconfiguring would only reset the ring and throw away good
 * data.
 *
 * What 2% cannot catch is a line that reads *low* in every window forever.
 * Every capture is classified against its own shortest run, so a capture whose
 * runs never include a one-bit run reads as our own rate divided by whatever
 * multiple that shortest run is: a byte whose runs are all even multiples of a
 * bit time (0x9E leaves two, four, two, two) reads as current/2, and 0xF0 —
 * five low, five high — as current/5. Those fits are self-consistent and
 * stable across windows, so "two windows agree" proves only that the pattern
 * is stable, not that the rate moved; the shapes that fit no whole multiple at
 * all (0xCC is one: two and three disagree, and the span module rejects the
 * fit instead of rounding it) are already refused by the consistency check.
 * Following a stable one would reach a rate the line never carried — the run
 * lengths belong to RXD, not to our divisor, so the port would then measure
 * the same wrong number forever and stay wrong. That is a working link broken
 * by a binary file.
 *
 * So the port keeps a memory of having been measured against the line, and it
 * starts out remembering: the rate in Kconfig is what both ends were set to,
 * so a reading that disagrees from the very first window is the one that has
 * to explain itself. Every reading within 2% of our own marks the link as
 * verified again, and while it is marked a reading that is our own rate
 * divided by k (2..9) is refused and logged instead of obeyed — it is the one
 * shape a missing single-bit run can produce, and the one direction it can
 * produce it in. Readings at or above our rate still move the port, because no
 * absent single-bit run can ever read high: that is the direction the
 * Kconfig's 1500000 / 921600 / 1000000 SBC consoles come from, and it stays
 * open. Verification is dropped by every reconfiguration, so a guess that
 * turns out wrong can still be undone — the rollback the two-window rule
 * depends on.
 *
 * Measured on a real link, that rollback had one hole, and it was the small
 * delta: a 115200 line read 118342 — 2.7% high, because one window's shortest
 * pulse was cut a little short — in window after window, and the two-window
 * rule followed the port there; the move cost a ring reset (33 bytes gone
 * mid-transfer) and mis-sampling at the new rate kept re-measuring the port as
 * itself, so "the next windows measure the true rate again" never happened.
 * The pulse that read high belonged to the latch, and the span measurement no
 * longer makes it, but the lesson was never about that one pulse: a reading a
 * few percent off our own is a reading UART does not need fixed, a move costs
 * a ring reset, and only the divisor shape had been refused until then. A
 * reading within AUTOBAUD_HOLD_PCT of our own, taken while the port sits at a
 * rate worth trusting, is held instead of chased — one band, in percent,
 * because the span estimate's error scales with the span rather than being a
 * fixed number of cycles: ~0.1 cycle per 128-run capture, under 0.2% of a bit
 * time even at 1500000 where a bit is 53 cycles. (The latch needed a second,
 * cycle-counted band: its error was a fixed ~18 cycles — 2.7% of a bit at
 * 115200 but 21% at 921600 — so a percent-only hold lost its grip exactly
 * where rates climb. That band retired with the latch.)
 *
 * The hold is a bound on the *gap*, not a list of blessed rates: nothing a
 * peer does lands inside it. Every other rate a console boots to is at least
 * 20% away or a whole divisor — 115200 -> 230400 is +100%, 921600 -> 1000000
 * is +8.5% — and a rate that is odd but real, 150000 say, is far enough from
 * ours that it is followed exactly as it always was. Being a rate the snap
 * table knows is neither necessary nor sufficient for the port to move.
 *
 * What the hold does need is a port worth trusting: one the line has been
 * measured against, or the standard rate both ends were configured to. A port
 * at a rate some earlier decision moved to, with nothing measured since, gets
 * no hold — the first clean reading still names the real rate and puts it
 * back, which is the rollback the two-window rule always promised.
 *
 * Silence is how the refusal reopens — but only for the divisors a stream
 * cannot fake. A peer that really did slow to a whole divisor of our own and
 * a stream whose runs are all whole multiples of one bit time (a repeated
 * 0x9E leaves two, four, two, two) arrive as the same number — "current / k"
 * — so while the link is carrying traffic no reading tells them apart, and
 * holding the port that works is the cheaper of the mistakes. A line quiet
 * for long enough is a link we no longer hold any evidence about, and a
 * divisor beyond the current frame's artifact bound is then believed,
 * which makes 921600 -> 115200 reachable. The bound is at least five for
 * 8N1 and grows to six for 8E2: repeated 0xE0 in 8E2 has six low and six
 * high bit times and must not be followed as a real /6 slowdown.
 * Divisors inside that bound are refused in every state, silence or not:
 * that is exactly what
 * an idle line followed by a binary file reads as, and following it would take
 * the port to a rate the line never carried with no later window left to undo
 * it. The refusal is a delay for the divisors only the line can produce, and
 * a hold for the ones a stream produces too.
 */

#include "uart_autobaud.h"
#include "uart_rmt_span.h"

#if LINKR_UART_AUTOBAUD

#include <soc/uart_struct.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>

/* Shares main.c's log source: same prefix, no second source slot in RAM. */
LOG_MODULE_DECLARE(linkr_ble_bridge, LOG_LEVEL_INF);

#define AUTOBAUD_WINDOW_MS	400 /* >= one peer burst period (measured 200) */
/*
 * A pass is a bounded, user-requested operation, not a background follower.
 * Five seconds without a capture is long enough for a 400 ms window, the
 * two-window confirmation and a slow peer's burst gap, and short enough that
 * a button press or @a does not leave the port being rewritten minutes later.
 * A capture restarts the clock: a line that is still talking is evidence that
 * the pass is still worth running.
 */
#define AUTOBAUD_TIMEOUT_MS	5000
/*
 * A line that keeps talking without ever going idle long enough for the
 * receiver to begin a capture produces no measurements, but it is not silent
 * either. The pin sample keeps that pass alive; this cap is what stops a
 * permanently busy line from holding the port open forever.
 */
#define AUTOBAUD_HARD_TIMEOUT_MS 60000
#define AUTOBAUD_CONFIRM	2	  /* agreeing windows before touching it */
#define AUTOBAUD_COOLDOWN_MS	1000 /* after a change, let the line settle */
#define AUTOBAUD_REFUSED_MAX	6	  /* badly measured windows before saying so */
/*
 * Consecutive windows in which no capture came back and the line sampled idle
 * (high) whenever the follower looked, after which the port stops being
 * treated as measured against it: 8 x 400 ms = 3.2 s of silence. Not one
 * window — the peer's bursts are ~200 ms apart, so a single empty window can
 * come back empty on timing alone and would drop the protection between two
 * bursts of the same link. The pin sample is what keeps a *busy* line from
 * reading as silence: captures stop coming whenever the traffic has no gap
 * the receiver can begin from, and without the sample a working stream would
 * hand the port back after 3.2 s. Sustained quiet is the one thing that can
 * happen *before* a peer's rate changes, which is what makes it the right
 * signal to reopen on: long enough that a burst gap cannot reach it, short
 * enough to cover the gap a rate change on the other end leaves.
 */
#define AUTOBAUD_QUIET_UNVERIFY 8
/*
 * The refusal's bound while the link is trusted: every divisor from two to
 * nine is refused, whether or not a byte stream could have produced it. Only
 * the frame-dependent lower part is a stream's doing (see the file header);
 * the rest is refused because a busy line
 * that suddenly reads current/8 is a stutter, not a peer.
 */
#define AUTOBAUD_MAX_FACTOR	9
/*
 * Conservative minimum artifact bound. The active frame format can extend
 * it: a 12-bit 8E2 frame can leave six-bit low and high runs, unlike 8N1.
 */
#define AUTOBAUD_ARTIFACT_MAX_FACTOR 5
#define AUTOBAUD_TOLERANCE_PCT	2 /* UART itself is good for ~2-3% */
/*
 * How close to our own rate a reading may sit and still be treated as our own
 * rate measured badly rather than a rate worth chasing. Five percent: far
 * wider than any error the span measurement produces (0.54% was its worst on
 * the bench, at 1500000 with merged edges), narrow enough that every other
 * rate a console boots to stays out of it — the closest pair in the snap
 * table is 921600 -> 1000000 at 8.5%, and every divisor pair is further apart
 * still. See the file header: this is a bound on the gap, not a list of rates
 * the port is allowed to move to.
 */
#define AUTOBAUD_HOLD_PCT	5
#define AUTOBAUD_MIN_BAUD	300	   /* mirrors Kconfig's range */
#define AUTOBAUD_MAX_BAUD	3000000 /* mirrors Kconfig's range */
/* Implausible readings can repeat as fast as the windows do — a noise spike
 * that slips past the RMT filter lands above MAX_BAUD, an all-constant frame
 * below MIN_BAUD — so they are reported at most this often. */
#define AUTOBAUD_WARN_MS	5000

static struct k_work_delayable autobaud_work;
static uintptr_t autobaud_reg;
static uint32_t autobaud_candidate;	  /* rate seen, waiting for a repeat */
static uint32_t autobaud_cooldown_until;
static uint32_t autobaud_warned_at;
static uint8_t autobaud_confirm;		  /* windows agreeing on it */
static uint8_t autobaud_refused;
/* Windows in a row with nothing to time; see AUTOBAUD_QUIET_UNVERIFY. */
static uint8_t autobaud_quiet;
/*
 * The line has been read within 2% of what the port is set to, so we know the
 * two agree. Set by a match, dropped when this module reconfigures the port —
 * a rate we just programmed has not been measured yet, and a guess that came
 * out wrong has to stay correctable.
 */
static bool autobaud_verified;

/* A pass is started by a BLE command or the GPIO key, never by boot. The
 * request flags are the only state the starter writes; the tick owns
 * everything else, so an ISR never touches the decision variables. */
static atomic_t autobaud_start_req;
static atomic_t autobaud_stop_req;
static atomic_t autobaud_running;
static uint32_t autobaud_deadline;
static uint32_t autobaud_hard_deadline;
static bool autobaud_span_initialized;
static linkr_uart_autobaud_callback_t autobaud_callback;

static uart_dev_t *autobaud_hw(void)
{
	return (uart_dev_t *)autobaud_reg;
}

/*
 * Forget the pending candidate. Called whenever the line says something else:
 * a rate is only acted on after being read twice with nothing in between.
 */
static void autobaud_forget(void)
{
	autobaud_confirm = 0;
	autobaud_candidate = 0;
}

/*
 * Begin one bounded pass. Runs on the system workqueue, the only writer of
 * the decision state. The RMT receiver is armed lazily, so a board that never
 * asks for a pass does not capture bursts nobody will read.
 */
static void autobaud_begin(uint32_t now)
{
	struct linkr_uart_span discard;

	autobaud_forget();
	autobaud_refused = 0;
	autobaud_quiet = 0;
	/*
	 * Do not reset autobaud_verified here. init() trusts the rate the port
	 * was configured to, but a rate this code applied is deliberately left
	 * unverified until a later capture matches it. If every new pass
	 * re-trusted that rate, a peer that had since moved to one of our
	 * divisors (for example 921600 -> 115200) would be refused as a
	 * missing-bit artifact and the manual pass could never put it back.
	 */
	autobaud_cooldown_until = now;
	autobaud_warned_at = now - AUTOBAUD_WARN_MS;
	autobaud_deadline = now + AUTOBAUD_TIMEOUT_MS;
	autobaud_hard_deadline = now + AUTOBAUD_HARD_TIMEOUT_MS;

	if (!autobaud_span_initialized) {
		linkr_uart_rmt_span_init(autobaud_reg);
		autobaud_span_initialized = true;
	} else {
		/* A capture left over from the previous pass is not evidence
		 * about this one. */
		(void)linkr_uart_rmt_span_poll(&discard);
	}

	atomic_set(&autobaud_running, 1);
	LOG_INF("UART autobaud: pass started (%u ms inactivity timeout)",
		AUTOBAUD_TIMEOUT_MS);
}

/*
 * Stop the pass and publish its result. Keep autobaud_running set while the
 * callback runs: a new @a must not claim the previous pass's request ID
 * before the callback has read it. The tick returns immediately after this,
 * so the flag is cleared on the same system-workqueue visit.
 */
static void autobaud_finish(enum linkr_uart_autobaud_result result,
			    uint32_t old_baud, uint32_t new_baud)
{
	if (!atomic_get(&autobaud_running)) {
		return;
	}

	autobaud_forget();
	if (autobaud_callback) {
		autobaud_callback(result, old_baud, new_baud);
	}
	atomic_set(&autobaud_running, 0);
}

void linkr_uart_autobaud_set_callback(linkr_uart_autobaud_callback_t callback)
{
	autobaud_callback = callback;
}

int linkr_uart_autobaud_request(void)
{
	if (atomic_get(&autobaud_running) || atomic_get(&autobaud_start_req)) {
		return -EALREADY;
	}
	if (!atomic_cas(&autobaud_start_req, 0, 1)) {
		return -EALREADY;
	}

	/* A start supersedes a stop that has not been consumed yet. */
	atomic_set(&autobaud_stop_req, 0);
	k_work_reschedule(&autobaud_work, K_NO_WAIT);
	return 0;
}

int linkr_uart_autobaud_stop(void)
{
	if (!linkr_uart_autobaud_running()) {
		return -EALREADY;
	}

	atomic_set(&autobaud_stop_req, 1);
	k_work_reschedule(&autobaud_work, K_NO_WAIT);
	return 0;
}

bool linkr_uart_autobaud_running(void)
{
	/* A queued pass is already running from the caller's point of view:
	 * @a? and a second @a must not race the workqueue between the request
	 * and the first tick. */
	return atomic_get(&autobaud_running) != 0 ||
	       atomic_get(&autobaud_start_req) != 0;
}

uint32_t linkr_uart_autobaud_timeout_ms(void)
{
	return AUTOBAUD_TIMEOUT_MS;
}

/*
 * The standard rate `measured` sits within 1% of, or 0 when it sits within 1%
 * of none — which is a rate no peer can be set to.
 */
static uint32_t autobaud_standard_within_1pct(uint32_t measured)
{
	static const uint32_t standard[] = {
		9600,    14400,   19200,   38400,	 57600,  74880,
		115200,  230400,  460800,  921600,	1000000, 1500000,
	};

	for (size_t i = 0; i < ARRAY_SIZE(standard); i++) {
		uint32_t s = standard[i];
		uint32_t delta = measured > s ? measured - s : s - measured;

		if (delta * 100u <= s) { /* within 1% */
			return s;
		}
	}
	return 0;
}

/* Rounds to a rate worth reporting when the measurement is a whisker off. */
static uint32_t autobaud_snap(uint32_t measured)
{
	uint32_t s = autobaud_standard_within_1pct(measured);

	return s ? s : measured;
}

/*
 * True when `rate` sits within the snap margin (1%) of a rate a console can
 * actually be set to — this is about the *port's* rate being one worth
 * trusting, not about which readings may move it. The rate in Kconfig is a
 * standard console rate, so a port still at (or snapped to) one is a port
 * both ends were configured to; the hold in the tick leans on that, because
 * it is only safe to call a near-our-rate reading "our own rate, badly
 * measured" while our own rate is one the line could plausibly be at. See
 * the file header — no reading is refused for being non-standard.
 */
static bool autobaud_is_standard(uint32_t rate)
{
	return autobaud_standard_within_1pct(rate) != 0;
}

/* True when `rate` sits within `pct` of `base`, either side. */
static bool autobaud_within_pct(uint32_t rate, uint32_t base, uint32_t pct)
{
	uint32_t delta = rate > base ? rate - base : base - rate;

	return delta * 100u <= base * pct;
}

/*
 * True when `rate` is our own rate seen through a window whose shortest run
 * was not one bit long — that is, current / k for some k in 2..max_factor,
 * inside the tolerance the port itself is held to.
 *
 * A reading below ours *has* to come from a missing single-bit run: that is
 * the only thing that makes a matching line read low, and this is the shape it
 * reads low in. max_factor decides how far to disbelieve it — the whole range
 * while the link is trusted, only the frame-dependent artifact range once the
 * silence has handed the larger divisors back. A reading that is none of these
 * is not something a missing run can produce, so if it repeats the line really
 * did move.
 */
static bool autobaud_reads_like_a_missing_bit(uint32_t rate, uint32_t current,
					      uint32_t max_factor)
{
	for (uint32_t k = 2; k <= max_factor; k++) {
		uint32_t expect = current / k;
		uint32_t delta = rate > expect ? rate - expect : expect - rate;

		if (expect != 0 && delta * 100u <= expect * AUTOBAUD_TOLERANCE_PCT) {
			return true;
		}
	}
	return false;
}

/*
 * The fractional 256ths of a Q8 cycle count, in hundredths — for logs
 * ("694" printed beside ".44"). The span estimate is the only Q8 number this
 * file handles, and printing it as a bare integer would hide the sub-cycle
 * part that makes it worth printing at all.
 */
static uint32_t autobaud_hundredths(uint32_t q8)
{
	return ((q8 & 255u) * 100u + 128u) / 256u;
}

/*
 * Runs on the system workqueue but never blocks it: each visit reads the
 * window that just closed, re-arms for the next one, and either stops there
 * or reprograms the port. No sleeping, so the workqueue stays free for
 * everything else — and nothing here needs more than a handful of registers,
 * so dram1 does not grow by a thread.
 */
static void autobaud_tick(struct k_work *work)
{
	uart_dev_t *hw = autobaud_hw();
	uint32_t now = k_uptime_get_32();
	uint32_t old_baud, div_meas8, div_cur, next, lo, hi, dmin_rate;
	uint32_t artifact_max_factor, max_factor;
	struct linkr_uart_span span;
	bool captured;
	bool start_pass, stop_pass;
	int line_level;
	uint64_t measured;

	ARG_UNUSED(work);

	/*
	 * Consume the starter's flags on the system workqueue. A stop and a
	 * start can land in the same visit (a stop racing the first tick), so
	 * begin first and then stop: the session gets its one final event
	 * instead of the command's response waiting for a pass that never
	 * existed.
	 */
	start_pass = atomic_cas(&autobaud_start_req, 1, 0);
	stop_pass = atomic_cas(&autobaud_stop_req, 1, 0);

	if (start_pass) {
		autobaud_begin(now);
	}
	if (stop_pass) {
		if (atomic_get(&autobaud_running)) {
			uint32_t baud = linkr_uart_config_current();

			LOG_INF("UART autobaud: pass stopped");
			autobaud_finish(LINKR_UART_AUTOBAUD_STOPPED, baud, baud);
		}
		return;
	}

	if (!atomic_get(&autobaud_running)) {
		return; /* idle: no timer, no RMT receiver, no work */
	}

	/*
	 * Take the capture that completed since the last visit and recommit to
	 * listening. One burst per window is all the follower needs, and the
	 * receiver only starts from the next burst's first edge anyway (see
	 * uart_rmt_span.h), so a burst arriving while one is already being
	 * measured costs nothing. The pin sample is the witness that tells a
	 * silent line from a busy one when no capture came back.
	 */
	captured = linkr_uart_rmt_span_poll(&span);
	line_level = linkr_uart_rmt_span_line_level();

	/*
	 * A capture, or a pin sample that found the line in space, is proof
	 * that something is still talking. A busy line whose gaps are too
	 * short for the receiver never produces a capture, so without the
	 * sample its pass would time out even though it was never silent.
	 * The hard deadline below still bounds a line that never goes quiet.
	 */
	if (captured || line_level == 0) {
		autobaud_deadline = now + AUTOBAUD_TIMEOUT_MS;
	}

	if ((int32_t)(now - autobaud_hard_deadline) >= 0) {
		uint32_t baud = linkr_uart_config_current();

		LOG_WRN("UART autobaud: pass exceeded %u ms, keeping %u",
			AUTOBAUD_HARD_TIMEOUT_MS, baud);
		autobaud_finish(LINKR_UART_AUTOBAUD_TIMEOUT, baud, baud);
		return;
	}

	if (!captured && line_level != 0 &&
	    (int32_t)(now - autobaud_deadline) >= 0) {
		uint32_t baud = linkr_uart_config_current();

		LOG_WRN("UART autobaud: no measurable traffic for %u ms, "
			"keeping %u", AUTOBAUD_TIMEOUT_MS, baud);
		autobaud_finish(LINKR_UART_AUTOBAUD_TIMEOUT, baud, baud);
		return;
	}

	k_work_reschedule(&autobaud_work, K_MSEC(AUTOBAUD_WINDOW_MS));

	if ((int32_t)(now - autobaud_cooldown_until) < 0) {
		return; /* a change of ours is still settling */
	}

	if (!captured) {
		/* Nothing was captured. Two very different lines look like
		 * that: one that said nothing, and one busy without a gap
		 * the receiver could begin from — it only starts a capture
		 * once the line has been idle. The rate is owed nothing by
		 * either, but only the first is silence: a line in space is
		 * proof the line was active, so it neither ages the quiet
		 * count nor drops the port's claim of being measured against
		 * the line. (One sample can miss a busy line's level, but a
		 * false "silent" needs eight windows whose samples all came
		 * back high, and eight coin flips in a row do not happen.)
		 * See AUTOBAUD_QUIET_UNVERIFY. */
		if (line_level != 0) {
			if (++autobaud_quiet >= AUTOBAUD_QUIET_UNVERIFY) {
				autobaud_quiet = AUTOBAUD_QUIET_UNVERIFY;
				if (autobaud_verified) {
					autobaud_verified = false;
					LOG_WRN("UART autobaud: line silent "
						"for %u windows, no longer "
						"measured against the port",
						AUTOBAUD_QUIET_UNVERIFY);
				}
			}
		} else {
			autobaud_quiet = 0;
		}
		return;
	}
	autobaud_quiet = 0;

	if (!span.trustworthy) {
		if (span.runs < LINKR_UART_SPAN_MIN_RUNS) {
			/* Too short a train to measure — a burst's own tail
			 * closed by the arming, not the line saying
			 * something badly. Like an empty window for the
			 * rate: not a refusal, and not a reason to drop a
			 * candidate waiting for its second window. The
			 * activity itself is already counted: the capture
			 * reset the quiet count above. */
			return;
		}
		/* The line said something and it was captured, but the runs
		 * do not sit on whole multiples of their own estimate — a
		 * rate that moved mid-capture, a torn edge. Not a
		 * measurement: nothing here may move the port or count as
		 * evidence about the rate. The latch this replaced called
		 * the state "the two polarities disagreed" and refused it
		 * the same way. */
		autobaud_forget();
		if (++autobaud_refused >= AUTOBAUD_REFUSED_MAX) {
			autobaud_refused = 0;
			LOG_WRN("UART autobaud: %u windows in a row measured "
				"badly (runs=%u dmin=%u misfits=%u zeros=%u), "
				"not touching the rate",
				AUTOBAUD_REFUSED_MAX, span.runs, span.dmin,
				span.misfits, span.zeros);
		}
		return;
	}
	autobaud_refused = 0;

	div_meas8 = span.est_q8;
	old_baud = linkr_uart_config_current();

	/* Both numbers are APB cycles per bit: the estimator measured the
	 * line in APB ticks (in 256ths), and the divider register holds the
	 * port's own source clock over baud (in 16ths), the source clock
	 * being UART_SCLK_DEFAULT = APB on this chip (see uart_esp32.c). The
	 * clock cancels out of the ratio — no frequency constant is needed,
	 * and the bench's +42 ppm between the two crystals cancels with it,
	 * because this board programs its own divider from its own ticks. If
	 * the bridge UART is ever moved off APB, this ratio and the RMT
	 * source clock must move together. */
	div_cur = (hw->clk_div.div_int << 4) | hw->clk_div.div_frag;
	measured = ((uint64_t)old_baud * div_cur * 16u) / div_meas8;

	if (measured < AUTOBAUD_MIN_BAUD || measured > AUTOBAUD_MAX_BAUD) {
		autobaud_forget();
		if (now - autobaud_warned_at >= AUTOBAUD_WARN_MS) {
			autobaud_warned_at = now;
			LOG_WRN("UART autobaud: implausible %u.%02u cycles/bit "
				"over %u runs -> %u, keeping %u",
				div_meas8 >> 8, autobaud_hundredths(div_meas8),
				span.runs, (uint32_t)measured, old_baud);
		}
		return;
	}

	next = autobaud_snap((uint32_t)measured);
	/* Both a low and a high run must fit in one frame. 8N1 bounds the
	 * shorter run at five bits, but 8E2 can carry six (repeated 0xE0).
	 * Keep the existing conservative five-bit floor for shorter formats. */
	artifact_max_factor = MAX(AUTOBAUD_ARTIFACT_MAX_FACTOR,
				 linkr_uart_config_frame_half_bits() / 4u);
	max_factor = autobaud_verified ? AUTOBAUD_MAX_FACTOR : artifact_max_factor;
	lo = old_baud - old_baud / 100u * AUTOBAUD_TOLERANCE_PCT;
	hi = old_baud + old_baud / 100u * AUTOBAUD_TOLERANCE_PCT;

	if (measured >= lo && measured <= hi) {
		/*
		 * The line and the port agree. That is the reading a link which
		 * is working hands back, and it is the evidence that makes the
		 * readings *below* ours worth disbelieving afterwards.
		 */
		autobaud_verified = true;
		autobaud_forget(); /* we already match the line */
		LOG_INF("UART autobaud: line already matches %u, port unchanged",
			old_baud);
		autobaud_finish(LINKR_UART_AUTOBAUD_UNCHANGED, old_baud,
				old_baud);
		return;
	}

	/*
	 * Close to our own rate, and the port is one worth trusting: a rate
	 * that close is not worth a move. The rule came from a real incident —
	 * a 115200 port was moved 2.7% for a reading that said nothing, the
	 * move reset the ring (33 bytes gone mid-transfer), and mis-sampling
	 * at the new rate kept the port reading as itself. What made the
	 * incident possible was the latch's own error and it is gone with the
	 * latch, but the rule it taught stands on its own: below a few percent
	 * the two rates work identically, so the move buys nothing and can
	 * cost a ring. One band, in percent, because the span estimate's error
	 * scales with the span and carries no fixed cycle count that a second
	 * band would have to catch (the latch's ~18-cycle error needed one;
	 * see the file header).
	 *
	 * Note what this is *not*: a list of rates the port may move to. A
	 * peer set to an odd but real rate (150000, say) is outside the band
	 * and is followed as it always was; the hold is a bound on how small a
	 * move is worth making.
	 *
	 * The port has to be worth trusting for the hold to apply: measured
	 * against the line already, or the standard rate both ends were
	 * configured to. A port at a rate some earlier decision moved to, with
	 * nothing measured since, keeps no such claim — a clean reading of the
	 * real rate is then free to put it back.
	 */
	if ((autobaud_verified || autobaud_is_standard(old_baud)) &&
	    autobaud_within_pct(measured, old_baud, AUTOBAUD_HOLD_PCT)) {
		autobaud_forget();
		if (now - autobaud_warned_at >= AUTOBAUD_WARN_MS) {
			autobaud_warned_at = now;
			LOG_WRN("UART autobaud: line reads %u (%u.%02u "
				"cycles/bit over %u runs, port programmed for "
				"%u) — our own rate, not a move; holding %u",
				(uint32_t)measured, div_meas8 >> 8,
				autobaud_hundredths(div_meas8), span.runs,
				(uint32_t)((div_cur + 8u) >> 4), old_baud);
		}
		return;
	}

	/*
	 * Low by a whole factor of ourselves: the shape of a stream with no
	 * single-bit run in it, not of a peer that moved — see the file header
	 * for the measurement behind that. Every divisor a byte stream can
	 * reach is refused whatever the link's state, because
	 * following one would take the port to a rate the line never carried
	 * and it could not be put back: the pulse width that produced this
	 * number belongs to RXD rather than to our divisor, so the port would
	 * read the same wrong answer in every window after the change and
	 * nothing would ever disagree with it again. While the link is still
	 * trusted the larger divisors are refused too — a busy line that
	 * suddenly reads current/8 is a stutter, not a peer — and it is the
	 * silence that hands those back.
	 */
	if (autobaud_reads_like_a_missing_bit(next, old_baud, max_factor)) {
		autobaud_forget();
		if (now - autobaud_warned_at >= AUTOBAUD_WARN_MS) {
			autobaud_warned_at = now;
			LOG_WRN("UART autobaud: line reads %u every window while "
				"the port is %u — that is our own rate over a run "
				"longer than one bit, holding %u",
				next, old_baud, old_baud);
		}
		return;
	}

	/*
	 * The same question asked of the shortest run instead of the fitted
	 * estimate. The estimate divides a sum by a count, so a peer whose
	 * write() gaps land inside one polarity stretches every run of it and
	 * the reading can walk outside its ±2% band while the shortest run —
	 * which a gap between bytes does not touch — still sits on the grid.
	 * The bench caught this with 0xF0 written byte by byte at the port's
	 * own 1500000: the fit read 1.5/5.5, inside no band, and a repeat of
	 * the same stream could have confirmed a move to 271k on a live link.
	 * What the estimate misses this catches: a byte stream can only reach
	 * the divisors of the refusal, never a rate it never carried, so a
	 * shortest run that itself reports one of those divisors is refused
	 * with the same reasoning as above.
	 */
	if (span.dmin > 0u) {
		dmin_rate = (uint32_t)(((uint64_t)old_baud * div_cur) /
				       (16u * (uint64_t)span.dmin));
		if (autobaud_reads_like_a_missing_bit(dmin_rate, old_baud, max_factor)) {
			autobaud_forget();
			if (now - autobaud_warned_at >= AUTOBAUD_WARN_MS) {
				autobaud_warned_at = now;
				LOG_WRN("UART autobaud: shortest run reads %u "
					"every window while the port is %u — "
					"our own rate over a run longer than "
					"one bit, holding %u",
					dmin_rate, old_baud, old_baud);
			}
			return;
		}
	}

	if (autobaud_candidate == 0 ||
	    !autobaud_within_pct(next, autobaud_candidate, AUTOBAUD_TOLERANCE_PCT)) {
		autobaud_candidate = next;
		autobaud_confirm = 1;
		return;
	}

	if (++autobaud_confirm < AUTOBAUD_CONFIRM) {
		return;
	}

	if (linkr_uart_config_reconfigure(next)) {
		autobaud_forget();
		LOG_WRN("UART autobaud: uart_configure(%u) rejected", next);
		autobaud_finish(LINKR_UART_AUTOBAUD_FAILED, old_baud, next);
		return;
	}

	autobaud_forget();
	/* Nothing has measured the port at the rate it just moved to, so a
	 * wrong guess stays correctable — see autobaud_verified. */
	autobaud_verified = false;
	autobaud_cooldown_until = now + AUTOBAUD_COOLDOWN_MS;

	/* Reading the divider back is what proves the change reached the
	 * silicon: uart_configure() returning 0 only proves it was accepted.
	 * 694+7/16 = 115200, 8333+5/16 = 9600 at 80 MHz. */
	LOG_WRN("UART autobaud: line rate %u -> %u (%u.%02u cycles/bit over "
		"%u runs, dmin %u cycles), divider now %u + %u/16",
		old_baud, next, div_meas8 >> 8, autobaud_hundredths(div_meas8),
		span.runs, span.dmin, hw->clk_div.div_int,
		hw->clk_div.div_frag);
	autobaud_finish(LINKR_UART_AUTOBAUD_APPLIED, old_baud, next);
}

void linkr_uart_autobaud_init(uintptr_t reg_addr)
{
	autobaud_reg = reg_addr;
	autobaud_forget();
	/*
	 * The configured rate is the working assumption: both ends were set to
	 * it, so the first reading that disagrees has to explain itself. A rate
	 * this module applies is left unverified until a later capture matches
	 * it, and a new pass preserves that state (see autobaud_begin), so a
	 * divisor-shaped wrong guess stays correctable. The artifact bound in
	 * autobaud_reads_like_a_missing_bit() still refuses a busy line's
	 * current / 2..5 shapes even while the port is unverified.
	 */
	autobaud_verified = true;
	autobaud_quiet = 0;
	autobaud_refused = 0;
	/* Relative to now, so the wrap-safe comparison in the tick stays
	 * valid however long the board has already been up. */
	autobaud_cooldown_until = k_uptime_get_32();
	/* Backdate the first warning too, so an implausible reading in the
	 * first pass is reported rather than swallowed by the rate limit. */
	autobaud_warned_at = k_uptime_get_32() - AUTOBAUD_WARN_MS;
	autobaud_deadline = 0;
	autobaud_span_initialized = false;
	atomic_set(&autobaud_start_req, 0);
	atomic_set(&autobaud_stop_req, 0);
	atomic_set(&autobaud_running, 0);

	k_work_init_delayable(&autobaud_work, autobaud_tick);

	/* No RMT arming and no work item here: the detector is idle until the
	 * user asks for a pass with @a or the trigger input. The first pass
	 * arms the span module after the port has been configured. */
	LOG_INF("UART autobaud: idle (start with @a or the trigger input)");
}

#endif /* LINKR_UART_AUTOBAUD */
