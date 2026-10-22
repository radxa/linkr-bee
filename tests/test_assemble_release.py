"""Exercise release assembly using tiny artifact fixtures, without publishing."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]

TARGETS = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
           "armv7-unknown-linux-gnueabihf", "i686-unknown-linux-gnu",
           "x86_64-pc-windows-gnu", "i686-pc-windows-gnu",
           "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc",
           "aarch64-apple-darwin", "x86_64-apple-darwin"]
BOARDS = ("esp32c3-supermini", "esp32c3-devkitm", "esp32c3-devkitc",
          "esp32c5-devkitc", "esp32-wroom-32")


def write_fixture(root: Path, *, firmware_version: str = "0.1.2",
                  web_version: str = "0.1.2", apk_version: str = "0.1.2") -> None:
    """Write one artifact of each kind, carrying the versions asked for."""
    for directory in ("desktop", "firmware", "web", "apk"):
        (root / directory).mkdir()
    for target in TARGETS:
        for prefix in ("linkr-bee", "linkr-bee-cli"):
            suffix = "zip" if "windows" in target else "tar.gz"
            (root / "desktop" / f"{prefix}-0.1.2-{target}.{suffix}").write_bytes(b"fixture")
            if "apple" in target:
                (root / "desktop" / f"{prefix}-0.1.2-{target}.dmg").write_bytes(b"fixture")
    for arch in ("amd64", "arm64", "armhf", "i386"):
        (root / "desktop" / f"linkr-bee_0.1.2_{arch}.deb").write_bytes(b"fixture")
    for board in BOARDS:
        bundle = root / "firmware" / f"linkr-bee-{board}"
        bundle.mkdir()
        (bundle / "firmware.bin").write_bytes(b"fixture")
        (bundle / "firmware.json").write_text(json.dumps({
            "project": "linkr-bee",
            "version": firmware_version,
            "board": board,
        }))
    (root / "apk" / f"linkr-bee-v{apk_version}-android-debug.apk").write_bytes(b"fixture")
    (root / "web/index.html").write_text("<title>fixture</title>")
    (root / "web/about-data.js").write_text(
        f'export const ABOUT_DATA = {{"app": {{"version": "{web_version}"}}}};')


def command_for(root: Path, repo: str | None = None,
                tag: str = "v0.1.2") -> list[str]:
    command = [sys.executable, str(ROOT / "tools/assemble_release.py"),
               "--tag", tag, "--commit", "a" * 40, "--run-id", "123",
               "--desktop-dir", str(root / "desktop"),
               "--firmware-dir", str(root / "firmware"),
               "--web-dir", str(root / "web"), "--apk-dir", str(root / "apk"),
               "--out-dir", str(root / "out"),
               "--notes-template", str(ROOT / f"docs/releases/{tag}.md"),
               "--notes-out", str(root / "notes.md"),
               "--web-version", "0.1.2", "--firmware-version", "0.1.2",
               "--apk-version", "0.1.2"]
    if repo:
        command.extend(["--repo", repo])
    return command


class ReleaseAssemblyTests(unittest.TestCase):
    def test_artifacts_and_notes_point_to_the_selected_repository(self):
        for repo in (None, "https://github.example/team/linkr-bee"):
            with self.subTest(repo=repo), tempfile.TemporaryDirectory(prefix="linkr-release-test-") as tmp:
                root = Path(tmp)
                write_fixture(root)
                result = subprocess.run(command_for(root, repo),
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = repo or "https://github.com/radxa/linkr-bee"
                notes = (root / "notes.md").read_text()
                self.assertIn(f"{expected}/actions/runs/123", notes)
                self.assertIn(f"{expected}/blob/v0.1.2/docs/DEVELOPMENT.zh-CN.md", notes)
                self.assertNotIn("{{", notes)
                self.assertNotIn("Novice-PG/linkr-bee", notes)
                with zipfile.ZipFile(root / "out/linkr-bee-v0.1.2-web.zip") as archive:
                    readme = archive.read("linkr-bee-v0.1.2-web/README.txt").decode()
                self.assertIn(f"Source: {expected}/tree/v0.1.2", readme)
                self.assertEqual(len(list((root / "out").iterdir())), 37)
                manifest = json.loads((root / "out/release-manifest.json").read_text())
                self.assertEqual(len(manifest["assets"]), 35)
                for asset in manifest["assets"]:
                    self.assertEqual(asset["sha256"], hashlib.sha256(
                        (root / "out" / asset["name"]).read_bytes()).hexdigest())

    def test_component_versions_come_from_the_artifacts(self):
        cases = [
            (dict(firmware_version="0.1.1"), "firmware"),
            (dict(web_version="0.1.1"), "Web"),
            (dict(apk_version="0.1.1"), "APK"),
        ]
        for overrides, what in cases:
            with self.subTest(overrides=overrides), tempfile.TemporaryDirectory(
                    prefix="linkr-release-version-") as tmp:
                root = Path(tmp)
                write_fixture(root, **overrides)
                result = subprocess.run(command_for(root),
                                        capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(what, result.stderr)
                self.assertIn("0.1.1", result.stderr)

    def test_versions_must_match_the_tag(self):
        with tempfile.TemporaryDirectory(prefix="linkr-release-tag-") as tmp:
            root = Path(tmp)
            write_fixture(root)
            result = subprocess.run(command_for(root, tag="v0.1.3"),
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("does not match tag", result.stderr)

    def test_malformed_artifacts_are_refused(self):
        cases = []

        def unknown_board(root):
            (root / "firmware/linkr-bee-riscv").mkdir()

        cases.append((unknown_board, "unknown firmware board slug"))

        def missing_firmware_json(root):
            (root / "firmware/linkr-bee-esp32c3-supermini/firmware.json").unlink()

        cases.append((missing_firmware_json, "firmware.json"))

        def unexpected_desktop(root):
            (root / "desktop/README.txt").write_text("not an artifact")

        cases.append((unexpected_desktop, "unexpected desktop artifact"))

        def unknown_deb_arch(root):
            (root / "desktop/linkr-bee_0.1.2_amd64.deb").rename(
                root / "desktop/linkr-bee_0.1.2_riscv64.deb")

        cases.append((unknown_deb_arch, "unknown Debian architecture"))

        def two_apks(root):
            (root / "apk/old.apk").write_bytes(b"fixture")

        cases.append((two_apks, "expected exactly one APK"))

        def missing_about(root):
            (root / "web/about-data.js").unlink()

        cases.append((missing_about, "about-data.js"))

        for mutate, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory(
                    prefix="linkr-release-bad-") as tmp:
                root = Path(tmp)
                write_fixture(root)
                mutate(root)
                result = subprocess.run(command_for(root),
                                        capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_desktop_versions_must_match_the_tag(self):
        with tempfile.TemporaryDirectory(prefix="linkr-release-desktop-") as tmp:
            root = Path(tmp)
            write_fixture(root)
            for path in (root / "desktop").iterdir():
                path.rename(path.with_name(path.name.replace("0.1.2", "0.1.1")))
            result = subprocess.run(command_for(root),
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("desktop version", result.stderr)

    def test_sha256sums_covers_every_asset(self):
        with tempfile.TemporaryDirectory(prefix="linkr-release-sums-") as tmp:
            root = Path(tmp)
            write_fixture(root)
            result = subprocess.run(command_for(root),
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            sums = {}
            for line in (root / "out/SHA256SUMS").read_text().splitlines():
                digest, name = line.split("  ", 1)
                sums[name] = digest
            assets = {
                path.name for path in (root / "out").iterdir()
                if path.name not in ("SHA256SUMS", "release-manifest.json")
            }
            self.assertEqual(set(sums), assets)
            for name, digest in sums.items():
                self.assertEqual(
                    digest,
                    hashlib.sha256((root / "out" / name).read_bytes()).hexdigest(),
                )

    def test_harmony_build_code_remains_above_the_pre_unification_version(self):
        app = json.loads((ROOT / "harmonyos/AppScope/app.json5").read_text())["app"]
        # Existing installations used 1000000 before display versions unified.
        self.assertGreater(app["versionCode"], 1000000)
