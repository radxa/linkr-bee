"""Run with python3 -m unittest discover -s tests -v (Python + host C compiler).

The harness runs the production classifier against quantized RMT words and
the production follower against those captures. Hardware register access is
faked; classification, confirmation and the configured frame-length reader
are the actual production functions.
"""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def extract(source, start_marker, end_marker, required):
    """Slice a production block by literal anchors.

    A moved anchor should fail loudly rather than quietly compile a different
    function, so the intended definitions are asserted to be inside the block.
    Truncation itself cannot pass unnoticed: the harness compiles with -Werror.
    """
    start = source.index(start_marker)
    block = source[start:source.index(end_marker, start)]
    for name in required:
        if f"{name}(" not in block:
            raise AssertionError(f"{name} is missing from the extracted block")
    return block


class AutobaudTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-autobaud-")
        cls.addClassCleanup(cls.tmp.cleanup)
        directory = Path(cls.tmp.name)
        production = (ROOT / "src/uart_autobaud.c").read_text()
        block = extract(
            production,
            "#define AUTOBAUD_WINDOW_MS",
            "\n#endif /* LINKR_UART_AUTOBAUD */",
            ["autobaud_tick", "autobaud_reads_like_a_missing_bit",
             "autobaud_snap", "autobaud_forget", "autobaud_within_pct",
             "linkr_uart_autobaud_init", "linkr_uart_autobaud_request",
             "linkr_uart_autobaud_stop"],
        )
        (directory / "autobaud_functions.inc").write_text(block)
        main = (ROOT / "src/main.c").read_text()
        frame = extract(main, "uint32_t linkr_uart_config_frame_half_bits(void)",
                        "\nint linkr_uart_config_reconfigure(",
                        ["linkr_uart_config_frame_half_bits"])
        (directory / "uart_frame_functions.inc").write_text(frame)
        rmt = (ROOT / "src/uart_rmt_span.c").read_text()
        span = extract(rmt, "static void span_measure(",
                       "\nvoid linkr_uart_rmt_span_init(", ["span_measure"])
        (directory / "span_functions.inc").write_text(span)
        cls.binary = directory / "autobaud-tests"
        subprocess.run([
            *shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-Wall",
            "-Wextra", "-Werror", "-I", str(directory),
            str(ROOT / "tests/autobaud_harness.c"), "-o", str(cls.binary),
        ], check=True)

    def run_scenario(self, scenario):
        result = subprocess.run([str(self.binary), scenario], check=True,
                                capture_output=True, text=True, timeout=5)
        return dict(line.split("=", 1)
                    for line in result.stdout.splitlines() if "=" in line)

    def test_autobaud_stays_idle_until_a_pass_is_requested(self):
        """The product default: booting must not follow anything.

        A line that the automatic follower would have moved to 9600 is
        presented for twenty windows. Without a request the tick must not
        even poll the span, and the port must stay where it was configured.
        """
        result = self.run_scenario("idle")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["results"], "0")

    def test_a_pass_times_out_without_traffic(self):
        """One-shot means it ends: no capture for five seconds is a timeout.

        The harness consumes the request at time zero, as the firmware's
        K_NO_WAIT start tick does. The fake clock then advances one 400 ms
        window at a time; fifteen empty windows cross the 5 s inactivity
        deadline and report TIMEOUT once.
        """
        result = self.run_scenario("timeout")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["results"], "1")
        self.assertEqual(result["result"], "2")  # TIMEOUT
        self.assertEqual(result["result_old"], "115200")
        self.assertEqual(result["result_new"], "115200")

    def test_a_stopped_pass_reports_stopped(self):
        result = self.run_scenario("stop")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["results"], "1")
        self.assertEqual(result["result"], "3")  # STOPPED

    def test_raw_captures_with_one_tick_jitter_confirm_an_odd_rate(self):
        result = self.run_scenario("raw_rmt_jitter")
        self.assertEqual(result["reconfigs"], "1")
        self.assertLess(abs(int(result["rate"]) - 150000), 1500)

    def test_captures_outside_the_confirmation_tolerance_do_not_confirm(self):
        result = self.run_scenario("raw_rmt_disagrees")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["rate"], "115200")

    def test_raw_8e2_six_bit_runs_do_not_move_a_quiet_port(self):
        result = self.run_scenario("raw_8e2")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["rate"], "115200")

    def test_raw_8n1_binary_from_reset_is_rejected_by_the_classifier(self):
        result = self.run_scenario("raw_cc")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["rate"], "115200")

    def test_frame_bound_reads_data_parity_and_fractional_stop_bits(self):
        result = self.run_scenario("frame_formats")
        self.assertEqual(result["8n1"], "20")
        self.assertEqual(result["8e2"], "24")
        self.assertEqual(result["7e2"], "22")
        self.assertEqual(result["8n1_5"], "21")
        self.assertEqual(result["5n0_5"], "13")
        self.assertEqual(result["9o2"], "26")

    def test_a_verified_link_is_not_moved_by_a_stream_without_single_bit_runs(self):
        """The one this exists for: 0xCC must not reach 57600.

        The link has been measured against the port at 115200, then a stream
        whose shortest runs are two bit-times arrives in every window. That
        classifies to a non-integer fit, so the capture is not a measurement
        and the port must not move. Reaching 57600 would be a guess, and the
        line never said it. Six such windows: the port must not move.
        """
        result = self.run_scenario("verified_then_binary")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")

    def test_before_anything_has_matched_a_slower_peer_is_still_followed(self):
        """A slower peer is still followed, which is the reason autobaud exists.

        The link starts out verified — Kconfig's rate is what both ends were
        set to — but verification only refuses readings *below* ours that are
        our own rate over 2..5 bit-times, the shape a missing single-bit run
        leaves. 9600 against a 115200 port is not that shape (/12), so two
        agreeing windows move the port. Refusing *this* would have meant
        refusing the reason autobaud exists.
        """
        result = self.run_scenario("startup_follows_a_slower_peer")
        self.assertEqual(result["rate"], "9600")
        self.assertEqual(result["reconfigs"], "1")
        self.assertEqual(result["last"], "9600")
        self.assertEqual(result["results"], "1")
        self.assertEqual(result["result"], "0")  # APPLIED
        self.assertEqual(result["result_old"], "115200")
        self.assertEqual(result["result_new"], "9600")

    def test_a_verified_link_still_follows_a_peer_that_speeds_up(self):
        """A missing single-bit run can only ever read low, never high.

        So the upward direction — where the Kconfig's 1500000 / 921600 /
        1000000 console rates come from — is left exactly as it was.
        """
        result = self.run_scenario("verified_step_up")
        self.assertEqual(result["rate"], "921600")
        self.assertEqual(result["reconfigs"], "1")
        self.assertEqual(result["last"], "921600")

    def test_a_second_pass_can_undo_an_applied_divisor_rate(self):
        """A new @a must not re-trust the rate the previous pass applied.

        921600 -> 115200 is our own rate divided by eight. The first pass
        applies 921600; the line then moves to 115200 on a busy link. A new
        manual pass has to be allowed to follow the divisor, otherwise the
        only way back is to wait for silence the peer may never leave.
        """
        result = self.run_scenario("second_pass_can_undo_applied_rate")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "2")
        self.assertEqual(result["last"], "115200")
        self.assertEqual(result["results"], "2")
        self.assertEqual(result["result"], "0")  # APPLIED
        self.assertEqual(result["result_old"], "921600")
        self.assertEqual(result["result_new"], "115200")
        self.assertEqual(result["verified"], "0")

    def test_a_verified_link_still_follows_a_slowdown_it_cannot_be_an_artifact_of(self):
        """The refusal is the shape of a missing run, not "slower" in general.

        1500000 down to 115200 is not our own rate divided by anything from 2
        to 5, so nothing about it is explainable by the longest run a framed
        byte can leave, and the reading is believed.
        """
        result = self.run_scenario("verified_other_rate")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "1")
        self.assertEqual(result["last"], "115200")


    def test_a_binary_stream_from_reset_does_not_move_the_port(self):
        """The entry the existing tests never covered: nothing matched yet.

        0xCC arriving on a line that really is 115200 classifies to a
        non-integer fit, which is refused. Moving there would be a guess — and
        the same capture would then read as a match at the rate the port just
        moved to, so no later window would ever disagree with it and the link
        stays broken. The configured rate is the working assumption until the
        line says otherwise, so the port holds and `verified` stays set (which
        is what keeps the refusal armed for every one of those windows).
        """
        result = self.run_scenario("startup_binary")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["verified"], "1")

    def test_one_empty_window_does_not_reopen_a_refused_reading(self):
        """A gap is not a rate change: the peer's bursts are 200 ms apart.

        A single empty window can arrive on timing alone, so reopening on one
        would drop the protection between two bursts of the very same link —
        which is the next line in this scenario, a stream with no single-bit
        run that still has to be refused.
        """
        result = self.run_scenario("one_gap_does_not_reopen")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")

    def test_a_refused_slowdown_is_followed_once_the_line_has_been_quiet(self):
        """The refusal is a delay, not a lock.

        921600 -> 115200 is a whole divisor of our own (/8), which is exactly
        the shape of a missing single-bit run, so while the link is busy there
        is no reading that tells it apart from one and it is refused. After
        the line has been quiet for longer than a burst gap it is no longer
        the link that was measured, and the next reading is believed: the
        silence, not the capture, is what reopens it. Without that this
        direction was unreachable — 921600 and 115200 stayed as they were
        forever.
        """
        result = self.run_scenario("quiet_then_an_integer_slowdown")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "1")
        self.assertEqual(result["last"], "115200")

    def test_a_quiet_line_does_not_let_a_short_binary_move_the_port(self):
        """The silence hands back only the divisors a stream cannot fake.

        An idle prompt is quiet for far longer than a burst gap, so it drops
        the link's measured state exactly as a peer's rate change does. What
        must not follow is a stream with no single-bit run in it: 0xCC on a
        true 115200 line reads our own rate over two bit-times, and two is
        inside the two-to-five a byte stream can leave, so it is refused even
        here. Following it would take the port to 57600, and the same capture
        would then read as a match at the rate it just moved to, so nothing
        later could ever put it back. This is the case an idle line followed
        by a file dump produces.
        """
        result = self.run_scenario("quiet_then_a_short_binary")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")

    def test_a_peer_at_an_odd_rate_is_still_followed(self):
        """The hold is a bound on the gap, not a list of blessed rates.

        If the peer really is at a rate the snap table does not know — 150000,
        say, 30% above our own — the bridge must follow it exactly as it
        always did, or swapping to that peer leaves it deaf, which is the
        failure autobaud exists to prevent. Nothing about being "non-standard"
        refuses a reading.
        """
        result = self.run_scenario("odd_rate_peer_is_followed")
        # span_line() truncates 80e6/150000 to 533 cycles, so the harness
        # computes 150092 from it — a tenth of a percent off in the harness's
        # own arithmetic. What matters here is the property, not the digit.
        self.assertEqual(result["reconfigs"], "1")
        self.assertNotEqual(result["rate"], "115200")
        self.assertEqual(result["rate"], result["last"])
        self.assertGreater(int(result["rate"]), 115200 * 11 // 10)

    def test_a_port_found_at_a_wrong_rate_is_put_back(self):
        """What the real board looked like, and the way out.

        A port at 118342 that nothing has measured keeps no claim to be
        trusted, so the hold does not protect it: the first clean windows read
        the true rate, which two agreeing windows follow, and the port comes
        back with `verified` re-armed. This is the rollback the two-window
        rule always promised, and the reason the hold is conditioned on a
        trustworthy port rather than applied blindly.
        """
        result = self.run_scenario("stuck_port_recovers")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "1")
        self.assertEqual(result["last"], "115200")
        self.assertEqual(result["verified"], "1")

    def test_a_burst_tail_is_not_a_refusal(self):
        """A capture with too few runs is a burst's tail, not a verdict.

        The re-arm closes a burst's own tail, which reads as one or two runs.
        That is not a measurement, but it is not a refusal either: the
        follower leaves the state alone, so a candidate still waiting for its
        second window is not lost to it. Without this the tail would forget
        the candidate and the next burst would have to start the two-window
        confirm over.
        """
        result = self.run_scenario("a_burst_tail_is_not_a_refusal")
        self.assertEqual(result["rate"], "9600")
        self.assertEqual(result["reconfigs"], "1")
        self.assertEqual(result["last"], "9600")

    def test_the_shortest_run_refuses_what_the_estimate_cannot(self):
        """The second opinion the bench asked for, on a shape it caught.

        A byte-gapped stream stretches every run of one polarity, so the
        fitted estimate walks outside its band while the shortest run — which
        a gap between bytes does not touch — still sits on the grid. The
        estimate alone would confirm a move to a rate the line never carried
        (the bench's 0xF0 at 1500000 read 1.5/5.5); the shortest run reports
        our own rate over a run longer than one bit and refuses it. The port
        must hold.
        """
        result = self.run_scenario("the_shortest_run_refuses_what_the_estimate_cannot")
        self.assertEqual(result["rate"], "1500000")
        self.assertEqual(result["reconfigs"], "0")

    def test_a_busy_line_is_not_silent(self):
        """A line in space is proof of activity, not silence.

        With no capture to read, the pin sample is the witness: a line caught
        mid-bit (low) is busy, so it neither ages the quiet count nor drops the
        port's claim of being measured against the line. A gap-free stream can
        therefore not log "line silent" while it is talking — the failure the
        latch era had, where a stream that never idled kept the port claiming
        a measurement it did not have.
        """
        result = self.run_scenario("a_busy_line_is_not_silent")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["verified"], "1")

    def test_a_busy_line_renews_the_inactivity_timeout(self):
        """A capture or a low pin sample restarts the five-second clock.

        The old code renewed only on a capture, so a line that never idled
        long enough for the receiver to begin was treated as silent and the
        pass timed out while the peer was still talking. Thirty windows are
        twelve seconds: past the inactivity limit, but this line is not
        inactive.
        """
        result = self.run_scenario("a_busy_line_renews_the_timeout")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["results"], "0")

    def test_a_busy_line_is_still_bounded_by_the_hard_deadline(self):
        """Renewal must not let a permanently busy line hold the port open.

        At sixty seconds the pass reports TIMEOUT and keeps the configured
        rate; the fake clock runs to sixty-four seconds, so the deadline is
        crossed and later ticks see an idle follower.
        """
        result = self.run_scenario("a_busy_line_hits_the_hard_deadline")
        self.assertEqual(result["rate"], "115200")
        self.assertEqual(result["reconfigs"], "0")
        self.assertEqual(result["results"], "1")
        self.assertEqual(result["result"], "2")  # TIMEOUT


if __name__ == "__main__":
    unittest.main()
