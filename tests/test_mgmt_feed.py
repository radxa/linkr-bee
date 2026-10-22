"""Host tests for the C client's Management v1 response reassembler.

A Management response arrives as a notification whose first indication carries
the 12-byte header and whose continuation indications carry only payload. The
reassembler is the one place that decides whether a split frame is complete,
whether a declared length is legal, and whether a late or oversized indication
must be dropped. It is sliced out of tools/linkr_ble_terminal.c and compiled
against a minimal state so those decisions run without D-Bus or a board.
"""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = ROOT / "tools/linkr_ble_terminal.c"
CC = os.environ.get("CC", "cc")


class MgmtFeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-mgmt-feed-")
        cls.addClassCleanup(cls.tmp.cleanup)
        directory = Path(cls.tmp.name)
        source = SOURCE_PATH.read_text()
        start = source.index("static void mgmt_feed_response(")
        end = source.index("static DBusHandlerResult filter_signals(", start)
        block = source[start:end]
        for required in ("mgmt_feed_response(", "MGMT_HEADER_SIZE",
                         "MGMT_MAX_PAYLOAD", "MGMT_MSG_RESPONSE"):
            if required not in block:
                raise AssertionError(f"{required} is missing from the slice")
        (directory / "mgmt_feed_production.inc").write_text(block)
        cls.binary = directory / "mgmt-feed-test"
        subprocess.run([
            *shlex.split(CC), "-std=c11", "-Wall", "-Wextra", "-Werror",
            "-I", str(directory),
            str(ROOT / "tests/mgmt_feed_harness.c"), "-o", str(cls.binary),
        ], check=True)

    def scenario(self, name):
        result = subprocess.run([str(self.binary), name], check=True,
                                capture_output=True, text=True, timeout=10)
        fields = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition("=")
            fields[key] = value
        return fields

    def test_a_header_and_payload_split_across_indications_reassemble(self):
        fields = self.scenario("split")
        self.assertEqual(fields["split_ready"], "1")
        self.assertEqual(fields["split_expected"], "9")
        self.assertEqual(fields["split_flags"], str(0x1234))
        self.assertEqual(fields["split_received"], "9")
        self.assertEqual(fields["split_id"], str(0x89ABCDEF))
        self.assertEqual(fields["split_payload"], "414243444546474849")
        self.assertEqual(fields["split_errors"], "0")

    def test_payload_can_arrive_in_two_indications(self):
        fields = self.scenario("two_chunks")
        self.assertEqual(fields["two_chunks_ready"], "1")
        self.assertEqual(fields["two_chunks_expected"], "8")
        self.assertEqual(fields["two_chunks_received"], "8")
        self.assertEqual(fields["two_chunks_payload"], "4142434445464748")
        self.assertEqual(fields["two_chunks_errors"], "0")

    def test_a_header_without_payload_is_not_ready(self):
        fields = self.scenario("header_only")
        self.assertEqual(fields["header_only_ready"], "0")
        self.assertEqual(fields["header_only_expected"], "4")
        self.assertEqual(fields["header_only_received"], "0")
        self.assertEqual(fields["header_only_errors"], "0")

    def test_zero_and_oversized_lengths_are_rejected(self):
        for scenario in ("zero_length", "too_long"):
            with self.subTest(scenario=scenario):
                fields = self.scenario(scenario)
                self.assertEqual(fields[f"{scenario}_ready"], "0")
                self.assertEqual(fields[f"{scenario}_expected"], "0")
                self.assertEqual(fields[f"{scenario}_errors"], "1")
                self.assertEqual(
                    fields[f"{scenario}_last_error"],
                    "Management response has an invalid length")

    def test_a_wrong_magic_version_or_type_is_ignored(self):
        for scenario in ("bad_magic", "bad_version", "bad_type"):
            with self.subTest(scenario=scenario):
                fields = self.scenario(scenario)
                self.assertEqual(fields[f"{scenario}_ready"], "0")
                self.assertEqual(fields[f"{scenario}_expected"], "0")
                self.assertEqual(fields[f"{scenario}_errors"], "0")

    def test_an_overflowing_continuation_discards_the_whole_frame(self):
        fields = self.scenario("overflow")
        self.assertEqual(fields["overflow_ready"], "0")
        self.assertEqual(fields["overflow_expected"], "0")
        self.assertEqual(fields["overflow_received"], "0")
        self.assertEqual(fields["overflow_errors"], "1")
        self.assertEqual(fields["overflow_last_error"],
                         "Management response exceeds its declared length")

    def test_a_late_indication_cannot_overwrite_a_complete_response(self):
        fields = self.scenario("ready_guard")
        self.assertEqual(fields["ready_guard_ready"], "1")
        self.assertEqual(fields["ready_guard_id"], "7")
        self.assertEqual(fields["ready_guard_payload"], "5758595a")
        self.assertEqual(fields["ready_guard_errors"], "0")


if __name__ == "__main__":
    unittest.main()
