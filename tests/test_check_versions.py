"""The version-consistency guard: it must pass on this tree and catch a split."""
import re
import subprocess
import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools/check_versions.py"


class VersionConsistencyTests(unittest.TestCase):
    def run_check(self, tag: str | None = None) -> subprocess.CompletedProcess:
        command = [sys.executable, str(SCRIPT)]
        if tag:
            command.append(tag)
        return subprocess.run(command, capture_output=True, text=True, timeout=30)

    def test_this_tree_is_consistent(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("version check passed", result.stdout)

    def test_it_reads_every_component(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        version = re.search(r"version check passed: (\S+)", result.stdout)
        self.assertIsNotNone(version, result.stdout)

    def test_a_mismatched_tag_fails(self):
        result = self.run_check("v0.0.1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("but the tag says 0.0.1", result.stderr)

    def test_a_tag_without_release_notes_fails(self):
        result = self.run_check("v9.9.9")
        self.assertEqual(result.returncode, 1)
        self.assertIn("docs/releases/v9.9.9.md is missing", result.stderr)


if __name__ == "__main__":
    unittest.main()
