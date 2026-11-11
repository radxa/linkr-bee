#!/usr/bin/env python3
"""Stage the newest released firmware for the static flasher page.

The GitHub Pages deployment downloads every ``*firmware-*.zip`` asset from the
latest release into a temporary directory and runs this script.  It extracts
only the files the browser flasher needs (the ``.bin`` image and the metadata)
under ``web/firmware/<board>/`` and writes a single ``manifest.json``.

The page therefore fetches same-origin files: release assets do not send the
CORS headers a cross-origin ``fetch`` would need.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ARCHIVE_RE = re.compile(r"^linkr-bee-(?P<version>[^-]+)-firmware-(?P<slug>.+)\.zip$")

BOARD_NAMES = {
    # Order is the order the page offers them; the Bee itself first, because
    # that is the board most people plug in.
    "linkr-bee-x1-0": "Linkr Bee X1.0 (MV013)",
    "esp32c3-supermini": "ESP32-C3 Super Mini",
    "esp32c3-devkitm": "ESP32-C3 DevKitM",
    "esp32c3-devkitc": "ESP32-C3 DevKitC",
    "esp32c5-devkitc": "ESP32-C5 DevKitC",
    "esp32-wroom-32": "ESP32-WROOM-32 DevKitC",
}

BOARD_ORDER = list(BOARD_NAMES)


def board_name(slug: str) -> str:
    return BOARD_NAMES.get(slug, slug)


def parse_archive(path: Path) -> dict | None:
    match = ARCHIVE_RE.match(path.name)
    if not match:
        return None

    with zipfile.ZipFile(path) as archive:
        metadata_name = next(
            (name for name in archive.namelist() if name.endswith("/firmware.json")),
            None,
        )
        if metadata_name is None:
            print(f"skip {path.name}: no firmware.json", file=sys.stderr)
            return None

        metadata = json.loads(archive.read(metadata_name))
        image_name = metadata.get("image")
        if not image_name:
            print(f"skip {path.name}: no image", file=sys.stderr)
            return None

        image_name = Path(image_name).name
        image_entry = next(
            (name for name in archive.namelist() if name.endswith("/" + image_name)),
            None,
        )
        if image_entry is None:
            print(f"skip {path.name}: no {image_name}", file=sys.stderr)
            return None

        image = archive.read(image_entry)

    slug = match.group("slug")
    return {
        "slug": slug,
        "name": board_name(slug),
        "board": metadata.get("board", slug),
        "chip": metadata.get("chip", ""),
        "flash_address": metadata.get("flash_address", "0x0"),
        "image": image_name,
        "size": len(image),
        "sha256": hashlib.sha256(image).hexdigest(),
        "version": metadata.get("version") or match.group("version"),
        "git_commit": metadata.get("git_commit", ""),
        "_bytes": image,
    }


def stage(source: Path, output: Path, tag: str = "", repo: str = "") -> dict:
    entries = [entry for path in sorted(source.glob("*.zip")) if (entry := parse_archive(path))]

    if not entries:
        raise SystemExit(f"no firmware archives found in {source}")

    # One release can only carry one version.  If a mixed directory is passed,
    # keep the highest version and drop the rest rather than publishing a
    # manifest whose boards disagree.
    versions = sorted({entry["version"] for entry in entries}, key=version_key, reverse=True)
    version = versions[0]
    entries = [entry for entry in entries if entry["version"] == version]

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    boards = []
    for entry in entries:
        slug = entry["slug"]
        board_dir = output / slug
        board_dir.mkdir()
        (board_dir / entry["image"]).write_bytes(entry.pop("_bytes"))
        entry["image_url"] = f"firmware/{slug}/{entry['image']}"
        boards.append(entry)

    boards.sort(key=lambda item: board_sort_key(item["slug"]))

    manifest = {
        "schema": 1,
        "project": "linkr-bee",
        "repo": repo,
        "version": version,
        "tag": tag or f"v{version}",
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "boards": boards,
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def version_key(value: str) -> tuple:
    parts = re.split(r"[.+-]", value)
    key = []
    for part in parts:
        key.append((0, int(part)) if part.isdigit() else (1, part))
    return tuple(key)


def board_sort_key(slug: str) -> tuple:
    try:
        return (BOARD_ORDER.index(slug), slug)
    except ValueError:
        return (len(BOARD_ORDER), slug)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="directory with firmware ZIPs")
    parser.add_argument("--output", type=Path, required=True, help="staging directory, e.g. web/firmware")
    parser.add_argument("--tag", default="", help="release tag, for the manifest")
    parser.add_argument("--repo", default="", help="owner/repository the release came from")
    args = parser.parse_args()

    manifest = stage(args.source, args.output, args.tag, args.repo)
    print(
        f"staged {len(manifest['boards'])} board(s), version {manifest['version']} -> {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
