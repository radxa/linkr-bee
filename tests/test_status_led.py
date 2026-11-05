"""Verify activity flashes coalesce work and keep their last-activity deadline."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class StatusLedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-status-led-")
        cls.addClassCleanup(cls.tmp.cleanup)
        directory = Path(cls.tmp.name)
        source = (ROOT / "src/linkr_status_led.c").read_text()
        start = source.index("static struct linkr_rgb led_base;")
        end = source.index("#elif DT_HAS_ALIAS(led0)", start)
        (directory / "status_led_functions.inc").write_text(source[start:end])
        cls.binary = directory / "status-led-tests"
        subprocess.run([
            *shlex.split(os.environ.get("CC", "cc")), "-std=c11",
            "-Wall", "-Wextra", "-Werror", "-I", str(directory),
            str(ROOT / "tests/status_led_harness.c"), "-o", str(cls.binary),
        ], check=True)

    def check_scenario(self, scenario):
        subprocess.run([str(self.binary), str(scenario)], check=True, timeout=5)

    def test_activity_before_initialization_is_ignored(self):
        self.check_scenario(0)

    def test_continuous_traffic_requires_only_start_and_end_rgb_frames(self):
        self.check_scenario(1)

    def test_activity_extends_the_flash_past_the_old_expiry(self):
        self.check_scenario(2)

    def test_base_color_changed_during_activity_is_restored_afterward(self):
        self.check_scenario(3)

    def test_new_activity_before_a_pending_off_frame_stays_visible(self):
        self.check_scenario(4)
