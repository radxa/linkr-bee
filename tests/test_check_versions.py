"""The version-consistency guard: it must pass on this tree and catch a split."""
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools/check_versions.py"
spec = importlib.util.spec_from_file_location("check_versions", SCRIPT)
versions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(versions)


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

    def test_branch_and_pull_request_refs_do_not_become_release_tags(self):
        for ref in ("refs/heads/main", "refs/heads/v9.9.9", "refs/pull/26/merge",
                    "refs/tags/linkr-tui-v9.9.9"):
            with self.subTest(ref=ref):
                result = subprocess.run([sys.executable, str(SCRIPT), "--ref", ref],
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_project_tag_ref_checks_its_actual_version(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--ref", "refs/tags/v9.9.9"],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn("but the tag says 9.9.9", result.stderr)

    def test_a_mismatched_tag_fails(self):
        result = self.run_check("v0.0.1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("but the tag says 0.0.1", result.stderr)

    def test_a_tag_without_release_notes_fails(self):
        result = self.run_check("v9.9.9")
        self.assertEqual(result.returncode, 1)
        self.assertIn("docs/releases/v9.9.9.md is missing", result.stderr)


class SyntheticVersionConsistencyTests(unittest.TestCase):
    """Independent fixtures prove a drift fails, rather than trusting this checkout."""

    def setUp(self):
        self.directory = TemporaryDirectory(prefix="linkr-version-check-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        files = {
            "Kconfig": 'config LINKR_BLE_BRIDGE_FIRMWARE_VERSION\n    default "2.3.4"\n',
            "web/about-data.js": 'export const ABOUT_DATA = {"app":{"version":"2.3.4"}};',
            "mobile/package.json": '{"version":"2.3.4"}',
            "mobile/package-lock.json": '{"version":"2.3.4","packages":{"":{"version":"2.3.4"}}}',
            "mobile/android/app/build.gradle": 'android {\n defaultConfig {\n  versionName "2.3.4"\n }\n}',
            "mobile/ios/App/App.xcodeproj/project.pbxproj": 'MARKETING_VERSION = 2.3.4;\nMARKETING_VERSION = 2.3.4;\n',
            "harmonyos/AppScope/app.json5": '{"app":{"versionName":"2.3.4"}}',
            "tools/linkr_ble_terminal.py": '__version__ = "2.3.4"\n',
            "tools/linkr-tui/Cargo.toml": '[package]\nversion = "2.3.4"\n',
            "tools/linkr-tui/npm/package.json": '{"version":"2.3.4"}',
            "linkr-bee-dsh/package.json": '{"version":"2.3.4"}',
            "docs/releases/v2.3.4.md": 'Release notes',
        }
        for name, content in files.items():
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content, encoding="utf-8")
        self.patch = patch.object(versions, "ROOT", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_a_consistent_synthetic_release_passes(self):
        self.assertEqual(versions.problems("v2.3.4"), [])

    def test_native_version_drift_fails_for_each_platform(self):
        for name in ("mobile/android/app/build.gradle", "harmonyos/AppScope/app.json5",
                     "mobile/ios/App/App.xcodeproj/project.pbxproj"):
            with self.subTest(path=name):
                path = self.root / name
                original = path.read_text()
                path.write_text(original.replace("2.3.4", "2.3.3", 1))
                issues = versions.problems("v2.3.4")
                self.assertTrue(any(name in issue and "2.3.3" in issue for issue in issues), issues)
                path.write_text(original)

    def test_both_lockfile_version_fields_are_checked(self):
        path = self.root / "mobile/package-lock.json"
        for field in ("top", "package-root"):
            with self.subTest(field=field):
                lock = {"version": "2.3.4", "packages": {"": {"version": "2.3.4"}}}
                if field == "top":
                    lock["version"] = "2.3.3"
                else:
                    lock["packages"][""]["version"] = "2.3.3"
                path.write_text(json.dumps(lock))
                issues = versions.problems()
                self.assertTrue(any("mobile/package-lock.json" in issue and "2.3.3" in issue
                                    for issue in issues), issues)


if __name__ == "__main__":
    unittest.main()
