"""Validate release flashing arguments with a fake esptool; no device is accessed."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FlashFirmwareTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="linkr-flash-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bundle = self.root / "dist"
        self.bundle.mkdir()
        self.script = self.bundle / "flash_firmware.sh"
        shutil.copyfile(ROOT / "tools/flash_firmware.sh", self.script)
        self.log = self.root / "esptool-args"
        executable = self.root / "esptool"
        executable.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$LINKR_TEST_ARGS"\n')
        executable.chmod(0o755)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("LINKR_")}
        self.env.update(PATH=f"{self.root}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
                        LINKR_TEST_ARGS=str(self.log))

    def image(self, name):
        image = self.bundle / name
        image.write_bytes(b"test firmware, never flashed")
        checksum = hashlib.sha256(image.read_bytes()).hexdigest()
        (self.bundle / "SHA256SUMS").write_text(f"{checksum}  {name}\n")
        return image

    def run_script(self, *args):
        self.log.unlink(missing_ok=True)
        return subprocess.run(["sh", str(self.script), "--port", "/dev/linkr-test", *args],
                              cwd=self.bundle, env=self.env, text=True, capture_output=True)

    def assert_flash(self, result, image, chip, address):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text().splitlines(),
                         ["--chip", chip, "--port", "/dev/linkr-test", "--baud", "921600",
                          "write-flash", address, str(image)])
        self.assertIn("Checksum verified", result.stdout)

    def test_release_image_names_select_chip_and_address(self):
        for slug, chip, address in [
            ("esp32-wroom-32", "esp32", "0x1000"),
            ("esp32-cam", "esp32", "0x1000"),
            ("esp32c3-supermini", "esp32c3", "0x0"),
            ("esp32c3-devkitm", "esp32c3", "0x0"),
            ("esp32c3-devkitc", "esp32c3", "0x0"),
            ("esp32c5-devkitc", "esp32c5", "0x2000"),
        ]:
            with self.subTest(slug=slug):
                image = self.image(f"linkr-bee-{slug}.bin")
                self.assert_flash(self.run_script("--image", str(image)), image, chip, address)

    def test_wroom_bundle_discovers_single_image(self):
        image = self.image("linkr-bee-esp32-wroom-32.bin")
        self.assert_flash(self.run_script(), image, "esp32", "0x1000")

    def test_explicit_esp32_supports_custom_image_name(self):
        image = self.image("custom.bin")
        self.assert_flash(self.run_script("--image", str(image), "--chip", "esp32"),
                          image, "esp32", "0x1000")

    def test_explicit_address_is_preserved(self):
        image = self.image("linkr-bee-esp32-wroom-32.bin")
        self.assert_flash(self.run_script("--image", str(image), "--address", "0x20000"),
                          image, "esp32", "0x20000")

    def test_unsupported_chip_never_invokes_esptool(self):
        image = self.image("custom.bin")
        result = self.run_script("--image", str(image), "--chip", "esp32s3")
        self.assertEqual(result.returncode, 2)
        self.assertIn("Unsupported chip", result.stderr)
        self.assertFalse(self.log.exists())

    def test_corrupt_wroom_image_never_invokes_esptool(self):
        image = self.image("linkr-bee-esp32-wroom-32.bin")
        image.write_bytes(b"corrupt")
        result = self.run_script("--image", str(image))
        self.assertEqual(result.returncode, 1)
        self.assertIn("Checksum mismatch", result.stderr)
        self.assertFalse(self.log.exists())
