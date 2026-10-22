"""Exercise the production consumer after bursts and transport stalls."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class UartRxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-uart-rx-")
        cls.addClassCleanup(cls.tmp.cleanup)
        directory = Path(cls.tmp.name)
        main = (ROOT / "src/main.c").read_text()
        start = main.index("static void uart_to_ble_thread(void)")
        end = main.index(
            "\n#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX)", start)
        (directory / "uart_rx_functions.inc").write_text(main[start:end])
        cls.binary = directory / "uart-rx-tests"
        subprocess.run([
            *shlex.split(os.environ.get("CC", "cc")), "-std=c11",
            "-Wall", "-Wextra", "-Werror", "-I", str(directory),
            str(ROOT / "tests/uart_rx_harness.c"), "-o", str(cls.binary),
        ], check=True)

    def assert_drained(self, initial, refill=0, retries=0):
        result = subprocess.run(
            [str(self.binary), str(initial), str(refill), str(retries)],
            capture_output=True, text=True, timeout=5, check=True)
        fields = dict(item.split("=", 1) for item in result.stdout.split())
        self.assertEqual(fields["buffered"], "0")
        self.assertEqual(int(fields["delivered"]), initial + refill)

    def test_ring_above_the_old_high_watermark_is_drained(self):
        self.assert_drained(14000)

    def test_a_completely_full_ring_is_drained(self):
        self.assert_drained(16384)

    def test_new_bytes_after_the_backlog_are_forwarded(self):
        self.assert_drained(14000, refill=700)

    def test_transient_forward_failures_preserve_the_backlog(self):
        self.assert_drained(14000, retries=3)
