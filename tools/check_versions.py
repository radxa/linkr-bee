#!/usr/bin/env python3
"""Fail when this tree's components disagree about the version they ship.

A project release names every component with one version: the tag, the
firmware's Kconfig default, the Web About page, the mobile package and native
Android/iOS/HarmonyOS apps, the Python reference client and the Rust CLI. The
release assembler enforces that the
*artifacts* match the tag (``tools/assemble_release.py``); this checks the
*tree* agrees with itself before anything is built, which is where a botched
version bump is cheapest to catch.

    python3 tools/check_versions.py            # the tree is consistent
    python3 tools/check_versions.py v1.1.5     # ...and matches this tag
    python3 tools/check_versions.py --ref "$GITHUB_REF" # compare only project tags

Exit status is 0 when consistent, 1 with one line per disagreement.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def kconfig_version() -> str | None:
    match = re.search(
        r"config\s+LINKR_BLE_BRIDGE_FIRMWARE_VERSION\b.*?default\s+\"([^\"]+)\"",
        read(ROOT / "Kconfig"),
        re.S,
    )
    return match.group(1) if match else None


def about_version() -> str | None:
    match = re.search(r'"app"\s*:\s*\{.*?"version"\s*:\s*"([^"]+)"', read(ROOT / "web/about-data.js"), re.S)
    return match.group(1) if match else None


def python_client_version() -> str | None:
    match = re.search(r'^__version__\s*=\s*"([^"]+)"', read(ROOT / "tools/linkr_ble_terminal.py"), re.M)
    return match.group(1) if match else None


def cargo_version() -> str | None:
    match = re.search(r'^version\s*=\s*"([^"]+)"', read(ROOT / "tools/linkr-tui/Cargo.toml"), re.M)
    return match.group(1) if match else None


def json_version(path: Path) -> str | None:
    try:
        return json.loads(read(path)).get("version")
    except (OSError, json.JSONDecodeError):
        return None


def android_version() -> str | None:
    match = re.search(r'^\s*versionName\s+["\']([^"\']+)["\']',
                      read(ROOT / "mobile/android/app/build.gradle"), re.M)
    return match.group(1) if match else None


def harmony_version() -> str | None:
    match = re.search(r'"versionName"\s*:\s*"([^"]+)"',
                      read(ROOT / "harmonyos/AppScope/app.json5"))
    return match.group(1) if match else None


def ios_versions() -> dict[str, str | None]:
    path = "mobile/ios/App/App.xcodeproj/project.pbxproj"
    values = re.findall(r'^\s*MARKETING_VERSION\s*=\s*"?([^";\s]+)"?\s*;',
                        read(ROOT / path), re.M)
    return {f"{path} MARKETING_VERSION[{index + 1}]": value
            for index, value in enumerate(values)} or {f"{path} MARKETING_VERSION": None}


def mobile_lock_root_version() -> str | None:
    try:
        return json.loads(read(ROOT / "mobile/package-lock.json")).get("packages", {}).get("", {}).get("version")
    except (OSError, json.JSONDecodeError):
        return None


def project_tag_for_ref(ref: str | None) -> str | None:
    """Branches and PR refs are not versions; only project v* tags are."""
    prefix = "refs/tags/"
    return ref[len(prefix):] if ref and ref.startswith(prefix + "v") else None


def collect() -> dict[str, str | None]:
    return {
        "Kconfig LINKR_BLE_BRIDGE_FIRMWARE_VERSION": kconfig_version(),
        "web/about-data.js app.version": about_version(),
        "mobile/package.json": json_version(ROOT / "mobile/package.json"),
        "mobile/package-lock.json": json_version(ROOT / "mobile/package-lock.json"),
        "mobile/package-lock.json root package": mobile_lock_root_version(),
        "mobile/android/app/build.gradle versionName": android_version(),
        "harmonyos/AppScope/app.json5 versionName": harmony_version(),
        **ios_versions(),
        "tools/linkr_ble_terminal.py __version__": python_client_version(),
        "tools/linkr-tui/Cargo.toml": cargo_version(),
        "tools/linkr-tui/npm/package.json": json_version(ROOT / "tools/linkr-tui/npm/package.json"),
        "linkr-bee-dsh/package.json": json_version(ROOT / "linkr-bee-dsh/package.json"),
        "linkr-bee-opencode/package.json": json_version(ROOT / "linkr-bee-opencode/package.json"),
    }


def problems(tag: str | None = None) -> list[str]:
    found = collect()
    missing = [name for name, value in found.items() if not value]
    out = [f"{name}: no version found" for name in missing]
    versions = {value for value in found.values() if value}
    if len(versions) > 1:
        out.append(
            "components disagree: "
            + ", ".join(f"{name}={value}" for name, value in sorted(found.items()) if value)
        )
    if tag is not None:
        wanted = tag.removeprefix("v")
        for name, value in sorted(found.items()):
            if value and value != wanted:
                out.append(f"{name}={value} but the tag says {wanted}")
        notes = ROOT / "docs" / "releases" / f"{tag}.md"
        if not notes.exists():
            out.append(f"docs/releases/{tag}.md is missing (the release notes template)")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tag", nargs="?", help="release tag to compare against, e.g. v1.1.5")
    parser.add_argument("--ref", dest="git_ref", help="CI Git ref; compare versions only for refs/tags/v* project tags")
    args = parser.parse_args(argv)
    if args.tag is not None and args.git_ref is not None:
        parser.error("tag and --ref are mutually exclusive")
    issues = problems(args.tag if args.tag is not None else project_tag_for_ref(args.git_ref))
    if issues:
        print("version check failed:", file=sys.stderr)
        for issue in issues:
            print(f"  - {issue}", file=sys.stderr)
        return 1
    found = collect()
    print(f"version check passed: {sorted(set(v for v in found.values() if v))[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
