#!/usr/bin/env python3
"""Assemble a project-level Linkr Bee release from CI artifacts.

The firmware/APK workflow and the desktop matrix deliberately publish separate
artifacts: each leg is useful on its own.  A project release is the other
shape, a single download page with one name for every component.  This script
performs that final, deterministic assembly and writes the manifest/checksum
pair the release page promises.

It is also runnable by hand.  Pass directories containing the artifacts that
GitHub Actions downloaded; the script never reaches the network.

Usage:
    tools/assemble_release.py \
        --tag v0.1.2 --commit <sha> --run-id 123 \
        --desktop-dir artifacts/desktop \
        --firmware-dir artifacts/firmware \
        --apk-dir artifacts/apk \
        --web-dir artifacts/web \
        --out-dir release \
        --notes-template docs/releases/v0.1.2.md \
        --notes-out release-notes.md \
        --web-version 0.1.2 --firmware-version 0.1.2 --apk-version 0.1.2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import zipfile
from pathlib import Path

FIRMWARE_BOARDS = {
    "esp32c3-supermini": ("esp32c3_supermini", "esp32c3"),
    "esp32c3-devkitm": ("esp32c3_devkitm", "esp32c3"),
    "esp32c3-devkitc": ("esp32c3_devkitc", "esp32c3"),
    "esp32c5-devkitc": ("esp32c5_devkitc/esp32c5/hpcore", "esp32c5"),
    "esp32-wroom-32": ("esp32_devkitc/esp32/procpu", "esp32"),
}

DEB_ARCH = {
    "amd64": "x86_64-unknown-linux-gnu",
    "arm64": "aarch64-unknown-linux-gnu",
    "armhf": "armv7-unknown-linux-gnueabihf",
    "i386": "i686-unknown-linux-gnu",
}

DESKTOP_RE = re.compile(r"^(linkr-bee(?:-cli)?)-([0-9]+\.[0-9]+\.[0-9]+)-(.+)\.(?:tar\.gz|zip|dmg)$")
DEB_RE = re.compile(r"^linkr-bee_([0-9]+\.[0-9]+\.[0-9]+)_([a-z0-9]+)\.deb$")
FIRMWARE_RE = re.compile(r"^linkr-bee-(.+)-firmware-([a-z0-9-]+)\.zip$")
WEB_RE = re.compile(r"^linkr-bee-(v[0-9]+\.[0-9]+\.[0-9]+)-web\.zip$")
APK_RE = re.compile(r"^linkr-bee-(v[0-9]+\.[0-9]+\.[0-9]+)-android-debug\.apk$")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_file(src: Path, dst: Path) -> None:
    """Copy and preserve the executable bit the archive/build produced."""
    shutil.copy2(src, dst)
    mode = src.stat().st_mode
    if mode & stat.S_IXUSR:
        dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def zip_tree(src: Path, dst: Path, arc_root: str) -> None:
    """Write a ZIP with a single top-level directory, preserving modes."""
    with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        entries = sorted(src.rglob("*"), key=lambda item: str(item.relative_to(src)))
        for path in entries:
            relative = path.relative_to(src)
            name = f"{arc_root}/{relative.as_posix()}"
            if path.is_dir():
                info = zipfile.ZipInfo(name.rstrip("/") + "/")
                info.external_attr = (stat.S_IFDIR | 0o755) << 16
                archive.writestr(info, b"")
                continue
            info = zipfile.ZipInfo.from_file(path, name)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (path.stat().st_mode & 0xFFFF) << 16
            with path.open("rb") as source, archive.open(info, "w") as target:
                shutil.copyfileobj(source, target)


def collect_desktop(source: Path, out: Path) -> list[Path]:
    files = []
    for path in sorted(source.iterdir()):
        if not path.is_file():
            continue
        if path.name == "SHA256SUMS":
            continue
        if DESKTOP_RE.match(path.name) or DEB_RE.match(path.name):
            destination = out / path.name
            copy_file(path, destination)
            files.append(destination)
        else:
            raise SystemExit(f"unexpected desktop artifact: {path}")
    return files


def collect_firmware(source: Path, out: Path, tag: str,
                     expected_version: str) -> list[Path]:
    files = []
    for directory in sorted(item for item in source.iterdir() if item.is_dir()):
        slug = directory.name
        if not slug.startswith("linkr-bee-"):
            raise SystemExit(f"unexpected firmware artifact directory: {directory}")
        slug = slug.removeprefix("linkr-bee-")
        if slug not in FIRMWARE_BOARDS:
            raise SystemExit(f"unknown firmware board slug: {slug}")
        manifest = directory / "firmware.json"
        if not manifest.is_file():
            raise SystemExit(f"firmware artifact {slug} has no firmware.json")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        version = data.get("version")
        if version != expected_version:
            raise SystemExit(
                f"firmware {slug} reports version {version!r}, "
                f"expected {expected_version!r}"
            )
        name = f"linkr-bee-{tag}-firmware-{slug}.zip"
        destination = out / name
        zip_tree(directory, destination, f"linkr-bee-{slug}")
        files.append(destination)
    return files


def collect_apk(source: Path, out: Path, tag: str,
                expected_version: str) -> list[Path]:
    apks = sorted(source.glob("*.apk"))
    if len(apks) != 1:
        raise SystemExit(f"expected exactly one APK, found {len(apks)}")
    match = APK_RE.match(apks[0].name)
    if not match:
        raise SystemExit(
            f"APK {apks[0].name} does not carry its version; name it "
            "linkr-bee-v<version>-android-debug.apk"
        )
    version = match.group(1).removeprefix("v")
    if version != expected_version:
        raise SystemExit(
            f"APK reports version {version!r}, expected {expected_version!r}"
        )
    destination = out / f"linkr-bee-{tag}-android-debug.apk"
    copy_file(apks[0], destination)
    return [destination]


def collect_web(source: Path, out: Path, tag: str, repo: str, commit: str,
                expected_version: str) -> list[Path]:
    about = source / "about-data.js"
    if not about.is_file():
        raise SystemExit("the Web artifact has no about-data.js")
    match = re.search(
        r'"app"\s*:\s*\{.*?"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+)"',
        about.read_text(encoding="utf-8"),
        re.DOTALL,
    )
    if not match:
        raise SystemExit("about-data.js does not name an application version")
    version = match.group(1)
    if version != expected_version:
        raise SystemExit(
            f"Web reports version {version!r}, expected {expected_version!r}"
        )
    package = out / "web-package" / f"linkr-bee-{tag}-web"
    if package.exists():
        shutil.rmtree(package)
    shutil.copytree(source, package)
    license_src = Path(__file__).resolve().parent.parent / "LICENSE"
    shutil.copy2(license_src, package / "LICENSE")
    (package / "README.txt").write_text(
        f"""Linkr Bee {tag} — Web terminal
Source: {repo}/tree/{tag}
Commit: {commit}

Extract this folder and serve it locally:
  cd linkr-bee-{tag}-web
  python3 -m http.server 8765 --bind 127.0.0.1
Then open http://127.0.0.1:8765/ in Chrome/Chromium.
For a remote deployment, use HTTPS for Web Bluetooth. Opening index.html as
file:// is not supported. No npm install or external download service is needed.
AI setup requires a compatible model endpoint and the user's own credentials.

解压后进入目录，运行上述 Python 静态服务器命令，用 Chrome/Chromium 访问。
远程部署请使用 HTTPS；不要直接以 file:// 打开页面。
使用说明：{repo}/blob/{tag}/docs/USAGE.zh-CN.md
""",
        encoding="utf-8",
    )
    destination = out / f"linkr-bee-{tag}-web.zip"
    zip_tree(package, destination, f"linkr-bee-{tag}-web")
    return [destination]


def asset_entry(path: Path, tag: str, run_id: int, web_version: str,
                firmware_version: str, apk_version: str) -> dict:
    name = path.name
    size = path.stat().st_size
    digest = sha256(path)
    match = DESKTOP_RE.match(name)
    if match:
        return {
            "name": name,
            "size": size,
            "sha256": digest,
            "kind": "desktop",
            "target": match.group(3),
            "component_version": match.group(2),
            "build_run": run_id,
        }
    match = DEB_RE.match(name)
    if match:
        arch = DEB_ARCH.get(match.group(2))
        if not arch:
            raise SystemExit(f"unknown Debian architecture: {match.group(2)}")
        return {
            "name": name,
            "size": size,
            "sha256": digest,
            "kind": "desktop",
            "target": arch,
            "component_version": match.group(1),
            "build_run": run_id,
        }
    match = FIRMWARE_RE.match(name)
    if match:
        board, chip = FIRMWARE_BOARDS[match.group(2)]
        return {
            "name": name,
            "size": size,
            "sha256": digest,
            "kind": "firmware",
            "board": board,
            "chip": chip,
            "component_version": firmware_version,
            "build_run": run_id,
        }
    if WEB_RE.match(name):
        return {
            "name": name,
            "size": size,
            "sha256": digest,
            "kind": "web",
            "component_version": web_version,
            "build": "npm ci and npm run build from a clean tagged checkout",
        }
    if APK_RE.match(name):
        return {
            "name": name,
            "size": size,
            "sha256": digest,
            "kind": "android-debug",
            "component_version": apk_version,
            "build_run": run_id,
        }
    raise SystemExit(f"cannot classify release asset: {name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--desktop-dir", type=Path, required=True)
    parser.add_argument("--firmware-dir", type=Path, required=True)
    parser.add_argument("--apk-dir", type=Path, required=True)
    parser.add_argument("--web-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--notes-template", type=Path, required=True)
    parser.add_argument("--notes-out", type=Path, required=True)
    parser.add_argument("--web-version", required=True)
    parser.add_argument("--firmware-version", required=True)
    parser.add_argument("--apk-version", required=True)
    parser.add_argument("--repo", default="https://github.com/radxa/linkr-bee")
    args = parser.parse_args()

    out = args.out_dir
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # The tag names the release; the artifacts name the components. A build
    # that says 0.1.3 under a v0.1.2 tag must fail here rather than ship a
    # manifest whose version only came from argv.
    tag_version = args.tag.removeprefix("v")
    for label, version in (
        ("Web", args.web_version),
        ("firmware", args.firmware_version),
        ("APK", args.apk_version),
    ):
        if version != tag_version:
            raise SystemExit(
                f"{label} version {version!r} does not match tag {args.tag!r}"
            )

    assets: list[Path] = []
    assets.extend(collect_desktop(args.desktop_dir, out))
    assets.extend(collect_firmware(
        args.firmware_dir, out, args.tag, args.firmware_version))
    assets.extend(collect_apk(args.apk_dir, out, args.tag, args.apk_version))
    assets.extend(collect_web(
        args.web_dir, out, args.tag, args.repo, args.commit, args.web_version))

    # The web staging directory is an input to the zip, not an asset.
    web_staging = out / "web-package"
    if web_staging.exists():
        shutil.rmtree(web_staging)

    expected_counts = {"desktop": 28, "firmware": 5, "web": 1, "apk": 1}
    counts = {key: 0 for key in expected_counts}
    for path in assets:
        if DESKTOP_RE.match(path.name) or DEB_RE.match(path.name):
            counts["desktop"] += 1
        elif FIRMWARE_RE.match(path.name):
            counts["firmware"] += 1
        elif WEB_RE.match(path.name):
            counts["web"] += 1
        elif APK_RE.match(path.name):
            counts["apk"] += 1
    if counts != expected_counts:
        raise SystemExit(f"release asset counts differ: {counts} != {expected_counts}")

    checksum_path = out / "SHA256SUMS"
    with checksum_path.open("w", encoding="utf-8") as handle:
        for path in sorted(assets, key=lambda item: item.name):
            handle.write(f"{sha256(path)}  {path.name}\n")

    manifest = {
        "schema_version": 1,
        "project": "linkr-bee",
        "tag": args.tag,
        "git_commit": args.commit,
        "ci_runs": {
            "build": args.run_id,
            "desktop": args.run_id,
            "tag_validation": args.run_id,
        },
        "assets": [
            asset_entry(path, args.tag, args.run_id, args.web_version,
                        args.firmware_version, args.apk_version)
            for path in sorted(assets, key=lambda item: item.name)
        ],
    }
    (out / "release-manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    tui_versions = {
        match.group(2)
        for path in assets
        if (match := DESKTOP_RE.match(path.name))
    }
    tui_versions |= {
        match.group(1)
        for path in assets
        if (match := DEB_RE.match(path.name))
    }
    if len(tui_versions) != 1:
        raise SystemExit(
            f"expected one desktop version, found {sorted(tui_versions)}"
        )
    tui_version = tui_versions.pop()
    if tui_version != tag_version:
        raise SystemExit(
            f"desktop version {tui_version!r} does not match tag {args.tag!r}"
        )

    substitutions = {
        "{{REPO}}": args.repo.rstrip("/"),
        "{{TAG}}": args.tag,
        "{{SHA}}": args.commit,
        "{{RUN_ID}}": str(args.run_id),
        "{{WEB_VERSION}}": args.web_version,
        "{{FIRMWARE_VERSION}}": args.firmware_version,
        "{{APK_VERSION}}": args.apk_version,
        "{{TUI_VERSION}}": tui_version,
    }
    notes = args.notes_template.read_text(encoding="utf-8")
    for needle, replacement in substitutions.items():
        notes = notes.replace(needle, replacement)
    args.notes_out.write_text(notes, encoding="utf-8")

    print(f"assembled {len(assets) + 2} release assets in {out}")
    print((out / "SHA256SUMS").read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
