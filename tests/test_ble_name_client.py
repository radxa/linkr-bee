"""Host tests for the C client's pure BLE-name text helpers.

The name sanitiser and the write-readback decision are sliced out of
tools/linkr_ble_terminal.c and compiled against no D-Bus state.  The tests
cover the two things a source-order assertion cannot: an advertisement is
attacker-controlled text, and a write is only successful when the board's
@n? answer matches the request.
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


class BleNameClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-ble-name-client-")
        cls.addClassCleanup(cls.tmp.cleanup)
        directory = Path(cls.tmp.name)
        source = SOURCE_PATH.read_text()
        start = source.index("static void printable_ble_name(")
        end = source.index("static void timespec_add_ms(", start)
        block = source[start:end]
        for required in ("printable_ble_name(", "ble_name_query_value(",
                         "ble_name_readback_matches("):
            if required not in block:
                raise AssertionError(f"{required} is missing from the slice")
        (directory / "ble_name_client_production.inc").write_text(block)
        cls.binary = directory / "ble-name-client-test"
        subprocess.run([
            *shlex.split(CC), "-std=c11", "-D_GNU_SOURCE", "-Wall",
            "-Wextra", "-Werror", "-I", str(directory),
            str(ROOT / "tests/ble_name_client_harness.c"),
            "-o", str(cls.binary),
        ], check=True)

    def scenario(self):
        result = subprocess.run([str(self.binary)], check=True,
                                capture_output=True, text=True, timeout=10)
        fields = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition("=")
            fields[key] = value
        return fields

    def test_names_heard_over_the_air_cannot_drive_the_terminal(self):
        fields = self.scenario()
        self.assertEqual(fields["plain"], "Bench Bee")
        # ESC (C0), DEL/C1 (C2 85) and the rest of the CSI sequence are
        # dropped rather than printed.
        self.assertEqual(fields["controls"], "Bee[2Jname")
        self.assertEqual(fields["only_controls"], "(unknown)")
        self.assertEqual(fields["null"], "(unknown)")
        self.assertEqual(fields["empty"], "(unknown)")

    def test_a_query_reply_peels_only_its_final_well_formed_suffix(self):
        fields = self.scenario()
        self.assertEqual(fields["plain_ok"], "1")
        self.assertEqual(fields["plain_value"], "Bench Bee")
        # A name that itself ends in the suffix text survives: only the final
        # field belongs to the reply.
        self.assertEqual(fields["suffix_in_name_value"],
                         "Bee custom=yes")
        # A malformed suffix is part of the name, not something to peel.
        self.assertEqual(fields["bad_suffix_value"], "Bee custom=maybe")
        self.assertEqual(fields["crlf_value"], "Bee")
        self.assertEqual(fields["no_suffix_value"], "Bee")
        self.assertEqual(fields["error_ok"], "0")
        # The firmware never advertises an empty name; a reset must not treat
        # one as a successful readback.
        self.assertEqual(fields["empty_name_ok"], "0")

    def test_a_rename_must_be_read_back_but_a_reset_only_needs_an_answer(self):
        fields = self.scenario()
        self.assertEqual(fields["match_rename"], "1")
        self.assertEqual(fields["mismatch_rename"], "0")
        # The reset name carries a MAC suffix the host cannot predict, so a
        # readable answer is enough.
        self.assertEqual(fields["match_reset"], "1")
        self.assertEqual(fields["unreadable"], "0")


if __name__ == "__main__":
    unittest.main()
