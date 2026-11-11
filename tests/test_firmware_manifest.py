"""Exercise the static flasher's firmware staging without GitHub."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "build_firmware_manifest", ROOT / "tools/build_firmware_manifest.py"
)
MANIFEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MANIFEST)


def write_bundle(root: Path, slug: str, version: str = "0.1.3",
                 chip: str = "esp32", address: str = "0x1000") -> Path:
    image = f"linkr-bee-{slug}.bin"
    payload = f"firmware-{slug}-{version}".encode()
    path = root / f"linkr-bee-v{version}-firmware-{slug}.zip"
    with zipfile.ZipFile(path, "w") as archive:
        prefix = f"linkr-bee-v{version}-firmware-{slug}"
        archive.writestr(f"{prefix}/firmware.json", json.dumps({
            "project": "linkr-bee",
            "version": version,
            "board": slug,
            "chip": chip,
            "flash_address": address,
            "image": image,
            "git_commit": "a" * 40,
        }))
        archive.writestr(f"{prefix}/{image}", payload)
    return path, payload


class FirmwareManifestTests(unittest.TestCase):
    def test_stages_images_and_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "zips"
            output = Path(tmp) / "web" / "firmware"
            source.mkdir()
            _, wroom = write_bundle(source, "esp32-wroom-32")
            _, devkitc = write_bundle(
                source, "esp32c3-devkitc", chip="esp32c3", address="0x0"
            )

            manifest = MANIFEST.stage(
                source, output, "v0.1.3", "radxa/linkr-bee"
            )

            self.assertEqual(manifest["repo"], "radxa/linkr-bee")
            self.assertEqual(manifest["version"], "0.1.3")
            self.assertEqual(manifest["tag"], "v0.1.3")
            # BOARD_NAMES order, not archive order: DevKitC is listed above
            # WROOM there, so the page offers it first.
            self.assertEqual([b["slug"] for b in manifest["boards"]],
                             ["esp32c3-devkitc", "esp32-wroom-32"])
            stored = json.loads((output / "manifest.json").read_text())
            self.assertEqual(stored, manifest)
            for board, payload in zip(stored["boards"], (devkitc, wroom)):
                image = output.parent / board["image_url"]
                self.assertEqual(image.read_bytes(), payload)
                self.assertEqual(board["sha256"], hashlib.sha256(payload).hexdigest())
                self.assertEqual(board["size"], len(payload))
            self.assertEqual(stored["boards"][0]["flash_address"], "0x0")
            self.assertEqual(stored["boards"][1]["flash_address"], "0x1000")

    def test_keeps_only_the_newest_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "zips"
            output = Path(tmp) / "web" / "firmware"
            source.mkdir()
            write_bundle(source, "esp32-wroom-32", version="0.1.2")
            write_bundle(source, "esp32c3-devkitc", version="0.1.10",
                         chip="esp32c3", address="0x0")

            manifest = MANIFEST.stage(source, output, "v0.1.10")

            self.assertEqual(manifest["version"], "0.1.10")
            self.assertEqual([b["slug"] for b in manifest["boards"]],
                             ["esp32c3-devkitc"])

    def test_ignores_archives_without_a_firmware_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "zips"
            source.mkdir()
            write_bundle(source, "esp32-wroom-32")
            with zipfile.ZipFile(
                source / "linkr-bee-v0.1.3-firmware-broken.zip", "w"
            ) as archive:
                archive.writestr("broken/firmware.json", "{}")

            manifest = MANIFEST.stage(source, Path(tmp) / "out", "v0.1.3")

            self.assertEqual([b["slug"] for b in manifest["boards"]],
                             ["esp32-wroom-32"])


if __name__ == "__main__":
    unittest.main()
