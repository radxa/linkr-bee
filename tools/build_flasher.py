#!/usr/bin/env python3
"""Build the data behind web/flash/: one binary + esp-web-tools manifest per board.

The flashing page is a static site; the firmware is not checked in. The Pages
workflow downloads the release's firmware zips, runs this script, and publishes
the result under /flash/. The same script builds a page from local build
directories so the surface can be reviewed without a release:

    python3 tools/build_flasher.py --release-dir artifacts --version 1.2.0
    python3 tools/build_flasher.py \
        --image esp32c3-supermini=build-x/zephyr/zephyr.bin \
        --image linkr-bee-x1-0=build-y/zephyr/zephyr.bin \
        --version 1.2.0 --out web/flash

Output, under ``--out``:

    firmware/index.json          the version and the board list the page renders
    firmware/<slug>.bin          the image, offset 0 (simpleboot layout)
    firmware/<slug>.json         the esp-web-tools manifest for that board

Everything the page shows about a board is in BOARDS below; a board the release
carries but this table does not name is an error rather than a silent omission,
because a flasher that quietly drops a board is worse than one that fails.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "web" / "flash"

# slug -> what the page shows. `chip` is the esp-web-tools chipFamily, and the
# hint is the one thing a person needs to know before plugging that board in.
BOARDS = {
    "linkr-bee-x1-0": {
        "name": "Linkr Bee X1.0",
        "chip": "ESP32-C3",
        "hint": "Bee 本体。USB-C 直连，带 RGB 灯、光耦与红外。",
    },
    "esp32c3-supermini": {
        "name": "ESP32-C3 Super Mini",
        "chip": "ESP32-C3",
        "hint": "小板，USB-C 直连（芯片自带 USB-Serial/JTAG）。",
    },
    "esp32c3-devkitm": {
        "name": "ESP32-C3 DevKitM",
        "chip": "ESP32-C3",
        "hint": "官方开发板，USB 直连。",
    },
    "esp32c3-devkitc": {
        "name": "ESP32-C3 DevKitC",
        "chip": "ESP32-C3",
        "hint": "官方开发板，USB 直连。",
    },
    "esp32c5-devkitc": {
        "name": "ESP32-C5 DevKitC",
        "chip": "ESP32-C5",
        "hint": "5 GHz / 2.4 GHz 双频板，USB 直连。",
    },
    "esp32-wroom-32": {
        "name": "ESP32-WROOM-32 DevKitC",
        "chip": "ESP32",
        "hint": "经板载 USB-UART 芯片连接；需要能传数据的线。",
    },
}

# Chips the bundled esptool-js knows. A mismatch here would produce a manifest
# the page cannot flash, so it is checked at generation time.
CHIP_FAMILIES = {"ESP32", "ESP32-C2", "ESP32-C3", "ESP32-C5", "ESP32-C6", "ESP32-H2",
                 "ESP32-S2", "ESP32-S3"}


def version_from_about(path: Path) -> str:
    """The app version web/about-data.js ships, so the page never guesses it."""
    match = re.search(r'"app"\s*:\s*\{.*?"version"\s*:\s*"([^"]+)"',
                      path.read_text(encoding="utf-8"), re.S)
    if not match:
        raise SystemExit(f"{path}: no app.version")
    return match.group(1)


def image_from_zip(path: Path) -> tuple[str, bytes, str | None]:
    """Return (slug, image bytes, version) from one release firmware zip."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        bins = [name for name in names if name.endswith(".bin") and "bootloader" not in name]
        if len(bins) != 1:
            raise SystemExit(f"{path}: expected one .bin, found {bins}")
        slug = Path(bins[0]).parent.name.removeprefix("linkr-bee-")
        version = None
        manifest = next((name for name in names if name.endswith("firmware.json")), None)
        if manifest:
            version = json.loads(archive.read(manifest)).get("version")
        return slug, archive.read(bins[0]), version


def write_board(out: Path, slug: str, image: bytes, version: str) -> dict:
    board = BOARDS.get(slug)
    if board is None:
        raise SystemExit(
            f"board {slug!r} is in the release but not in BOARDS; add it to "
            "tools/build_flasher.py so the flashing page can offer it"
        )
    if board["chip"] not in CHIP_FAMILIES:
        raise SystemExit(f"{slug}: unknown chipFamily {board['chip']!r}")

    firmware = out / "firmware"
    firmware.mkdir(parents=True, exist_ok=True)
    binary = f"{slug}.bin"
    (firmware / binary).write_bytes(image)
    manifest = {
        "name": board["name"],
        "version": version,
        "builds": [{
            "chipFamily": board["chip"],
            "parts": [{"path": binary, "offset": 0}],
        }],
    }
    (firmware / f"{slug}.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return {
        "id": slug,
        "name": board["name"],
        "chip": board["chip"],
        "hint": board["hint"],
        "manifest": f"./firmware/{slug}.json",
        "bytes": len(image),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--release-dir", type=Path,
                        help="directory holding the release's *.zip firmware bundles")
    parser.add_argument("--image", action="append", default=[], metavar="SLUG=PATH",
                        help="a locally built zephyr.bin, for reviewing the page without a release")
    parser.add_argument("--version", help="version the page reports, e.g. 1.2.0")
    parser.add_argument("--version-from", type=Path,
                        help="take the version from a file that carries it (web/about-data.js)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    if not args.release_dir and not args.image:
        parser.error("pass --release-dir or at least one --image")
    if bool(args.version) == bool(args.version_from):
        parser.error("pass exactly one of --version or --version-from")
    version = args.version or version_from_about(args.version_from)

    images: dict[str, bytes] = {}
    versions: set[str] = set()

    if args.release_dir:
        zips = sorted(args.release_dir.glob("*firmware*.zip"))
        if not zips:
            raise SystemExit(f"no firmware zips in {args.release_dir}")
        for path in zips:
            # `image_version`, not `version`: the expected version above must
            # not be overwritten by the loop or the mismatch check goes blind.
            slug, image, image_version = image_from_zip(path)
            images[slug] = image
            if image_version:
                versions.add(image_version)

    for spec in args.image:
        slug, _, path = spec.partition("=")
        if not slug or not path:
            parser.error(f"--image wants SLUG=PATH, got {spec!r}")
        images[slug] = Path(path).read_bytes()

    if versions and versions != {version}:
        raise SystemExit(f"release images report {sorted(versions)}, but the page reports {version}")

    # A stale build from a previous run would leave boards the release dropped.
    firmware = args.out / "firmware"
    if firmware.exists():
        shutil.rmtree(firmware)
    args.out.mkdir(parents=True, exist_ok=True)

    # BOARDS order, not slug order: the Bee itself is the board most people
    # plug in, and alphabetical put it last on a phone.
    ordered = [slug for slug in BOARDS if slug in images]
    missing = sorted(set(images) - set(ordered))
    if missing:
        raise SystemExit(f"no page entry for {missing}")
    boards = [write_board(args.out, slug, images[slug], version) for slug in ordered]
    if not boards:
        raise SystemExit("nothing to write")
    index = {"version": version, "boards": boards}
    (firmware / "index.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"wrote {len(boards)} boards for {version} into {firmware}")
    for board in boards:
        print(f"  {board['id']:22} {board['chip']:10} {board['bytes']:>8} B")
    return 0


if __name__ == "__main__":
    sys.exit(main())
