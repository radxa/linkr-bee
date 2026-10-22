#!/usr/bin/env python3
"""Generate the third-party component page for the host terminal.

The About window shows the direct Rust dependencies and the contributors. The
full closure of crates used by a release is too long for that window, so it
lives in THIRD_PARTY_LICENSES.md, which is shipped beside the binary and is what
`bee --licenses` prints. Both artefacts are generated from one `cargo tree`
run (with `cargo metadata` supplying the licence fields), and CI runs this
script with `--check`, so a dependency bump cannot leave the shipped notice
naming an old crate or omitting a licence text.

Why Python: this is a development-time generator, not a runtime dependency.
The crate already keeps its release tooling in `dev/` in Python and POSIX shell;
this follows that convention. `cargo tree` is the source of truth for the
feature-resolved normal-dependency closure, exactly as `cargo metadata` is for
the package metadata; `node tools/gen_about.mjs` is the web equivalent.

Usage:
    python3 dev/gen-licenses.py
    python3 dev/gen-licenses.py --check
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

CRATE_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = CRATE_DIR / "src" / "licenses_data.rs"
NOTICE_FILE = CRATE_DIR / "THIRD_PARTY_LICENSES.md"
LICENSE_TEXT_DIR = Path(__file__).resolve().parent / "license-texts"

PROJECT_NAME = "Linkr Bee Terminal"
# Kept in step with tools/gen_about.mjs. The real source is `git shortlog`, but
# CI checks out with depth 1, so a generated-from-history list would be empty
# there. Add a name when a new author lands their first commit.
CONTRIBUTORS = [
    "Novice-PG",
    "xzl",
    "HarryLoong",
    "dfsjklw",
    "Anupam Mediratta",
    "rock",
]

# A published crate should carry its licence file, but a few registry packages
# do not. For those, reproduce the standard text of a permissive alternative
# named in the package metadata, with the crate's own authors. This is still a
# complete licence text rather than a link to one; `collect_license_texts`
# refuses to finish if a package names no text we can reproduce.
LICENSE_FILE_PREFIXES = (
    "LICENSE",
    "LICENCE",
    "COPYING",
    "NOTICE",
    "UNLICENSE",
    "COPYRIGHT",
)

MIT_TEMPLATE = """MIT License

Copyright (c) {authors}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

ZLIB_TEMPLATE = """zlib License

Copyright (c) {authors}

This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
"""


def run_cargo(args: list[str], what: str) -> str:
    # CI sets CARGO_TERM_COLOR=always for its log, but this parser needs the
    # package lines rather than the escape sequences around them.
    environment = os.environ.copy()
    environment["CARGO_TERM_COLOR"] = "never"
    try:
        result = subprocess.run(
            args,
            cwd=CRATE_DIR,
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
    except FileNotFoundError:
        sys.exit("error: cargo was not found on PATH")
    except subprocess.CalledProcessError as error:
        if error.stderr:
            sys.stderr.write(error.stderr)
        sys.exit(f"error: {what} failed")
    return result.stdout


def cargo_metadata() -> dict:
    # `cargo metadata` resolves the graph but does not necessarily unpack the
    # registry sources. Reading licence files needs those sources, so fetch
    # them first; the release build needs them anyway.
    run_cargo(["cargo", "fetch", "--locked"], "cargo fetch")
    stdout = run_cargo(
        ["cargo", "metadata", "--locked", "--format-version", "1"],
        "cargo metadata",
    )
    return json.loads(stdout)


def cargo_tree() -> str:
    # `cargo tree` is the feature-aware view: unlike the raw `resolve` graph in
    # cargo metadata, it omits optional dependencies whose features are off.
    return run_cargo(
        [
            "cargo",
            "tree",
            "-e",
            "normal",
            "--target",
            "all",
            "--prefix",
            "none",
            "--format",
            "{p}",
        ],
        "cargo tree",
    )


def normalize_url(value: str | None, name: str) -> str:
    """A source URL a person can read, rather than Cargo's git spelling."""
    url = (value or "").strip()
    if not url:
        return f"https://crates.io/crates/{name}"
    if url.startswith("git+"):
        url = url[4:]
    if url.startswith("git://"):
        url = "https://" + url[6:]
    if url.endswith(".git"):
        url = url[:-4]
    return url.rstrip("/")


def package_component(package: dict, direct: bool) -> dict:
    license_id = (package.get("license") or "").strip()
    if not license_id:
        license_id = "see licence file" if package.get("license_file") else "unknown"
    return {
        "name": package["name"],
        "version": package["version"],
        "license": license_id,
        "url": normalize_url(package.get("repository"), package["name"]),
        "direct": direct,
    }


def normal_closure(meta: dict, tree_output: str) -> tuple[dict, list[dict]]:
    """The feature-resolved normal-dependency closure, across all targets.

    `cargo metadata`'s resolve graph retains optional dependency edges even
    when their feature is disabled. `cargo tree -e normal` applies features
    and is therefore the list of crates Cargo would actually build for a
    normal dependency; the metadata is still used for licence and source
    fields that tree does not print.

    `--target all` deliberately takes the union of every target Cargo can
    resolve, not just the release matrix. Over-inclusion is the safe direction
    for an attribution notice: a crate that is only used on another platform
    is still named rather than silently omitted.
    """
    packages = {package["id"]: package for package in meta["packages"]}
    by_key: dict[tuple[str, str], dict] = {}
    for package in meta["packages"]:
        by_key.setdefault((package["name"], package["version"]), package)

    root_id = meta["resolve"]["root"]
    if not root_id:
        sys.exit("error: cargo metadata named no workspace root")
    root = packages[root_id]
    direct_names = {
        dependency["name"]
        for dependency in root.get("dependencies", [])
        if dependency.get("kind") in (None, "normal")
    }

    seen: set[tuple[str, str]] = set()
    for line in tree_output.splitlines():
        line = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
        if not line:
            continue
        line = re.sub(r" \(\*\)$", "", line)
        match = re.match(r"^(.+) v([^ ]+)(?: \(.*\))?$", line)
        if not match:
            sys.exit(f"error: cargo tree printed an unrecognised package: {line!r}")
        key = (match.group(1), match.group(2))
        if key == (root["name"], root["version"]):
            continue
        if key not in by_key:
            sys.exit(
                "error: cargo tree named a package absent from cargo metadata: "
                f"{key[0]} {key[1]}"
            )
        seen.add(key)

    components = [
        package_component(by_key[key], key[0] in direct_names)
        for key in sorted(seen, key=lambda item: (item[0].lower(), item[1]))
    ]
    return root, components


def license_ids(expression: str) -> set[str]:
    """The SPDX identifiers in an expression, including slash spellings."""
    normalized = expression.replace("/", " OR ")
    identifiers: set[str] = set()
    for part in re.split(r"\s+(?:OR|AND)\s+|[()]", normalized):
        for identifier in part.split(" WITH "):
            identifier = identifier.strip()
            if identifier:
                identifiers.add(identifier)
    return identifiers


def authors_for(package: dict) -> str:
    authors = ", ".join(package.get("authors") or [])
    return authors or f"the {package['name']} authors"


def license_file_paths(package: dict) -> list[Path]:
    root = Path(package["manifest_path"]).parent
    paths: list[Path] = []
    license_file = package.get("license_file")
    if license_file:
        path = root / license_file
        if path.is_file():
            paths.append(path)
    if root.is_dir():
        for path in sorted(root.iterdir()):
            if (
                path.is_file()
                and path.name.upper().startswith(LICENSE_FILE_PREFIXES)
                and path not in paths
            ):
                paths.append(path)
    return paths


def synthesized_texts(package: dict) -> list[tuple[str, str]]:
    """Complete texts for packages that omitted their licence file.

    Only permissive alternatives are synthesised. A package that offers no
    alternative we can reproduce is an error rather than a notice that names a
    licence without carrying its text.
    """
    identifiers = license_ids(package.get("license") or "")
    authors = authors_for(package)
    texts: list[tuple[str, str]] = []
    if "MIT" in identifiers:
        texts.append(
            ("MIT (generated from package metadata)", MIT_TEMPLATE.replace("{authors}", authors))
        )
    if "Apache-2.0" in identifiers:
        apache = (LICENSE_TEXT_DIR / "Apache-2.0.txt").read_text(encoding="utf-8")
        texts.append(("Apache-2.0 (standard text)", apache))
    if "Zlib" in identifiers:
        texts.append(
            ("Zlib (generated from package metadata)", ZLIB_TEMPLATE.replace("{authors}", authors))
        )
    if not texts:
        raise ValueError(
            f"{package['name']} {package['version']} has no licence file and "
            f"no reproducible permissive licence in {package.get('license')!r}"
        )
    return texts


def collect_license_texts(
    components: list[dict], meta: dict
) -> list[dict[str, object]]:
    """Group licence texts by exact content so Apache is not repeated 150 times."""
    by_key = {
        (package["name"], package["version"]): package for package in meta["packages"]
    }
    groups: dict[str, dict[str, object]] = {}
    missing: list[str] = []

    for component in components:
        package = by_key[(component["name"], component["version"])]
        files = license_file_paths(package)
        entries: list[tuple[str, str]] = []
        for path in files:
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError as error:
                sys.exit(f"error: cannot read {path}: {error}")
            if text.strip():
                entries.append((path.name, text.replace("\r\n", "\n")))
        if not entries:
            try:
                entries = synthesized_texts(package)
            except ValueError as error:
                missing.append(str(error))
                continue

        label = f"{component['name']} {component['version']}"
        for source, text in entries:
            group = groups.setdefault(
                text,
                {"sources": set(), "components": set(), "text": text},
            )
            group["sources"].add(source)
            group["components"].add(label)

    if missing:
        sys.exit(
            "error: no licence text for:\n  " + "\n  ".join(missing)
        )

    covered = {
        component
        for group in groups.values()
        for component in group["components"]
    }
    expected = {
        f"{component['name']} {component['version']}" for component in components
    }
    if covered != expected:
        sys.exit(
            "error: licence text coverage does not match the component list:\n"
            f"  missing: {sorted(expected - covered)}\n"
            f"  extra: {sorted(covered - expected)}"
        )

    return sorted(
        groups.values(),
        key=lambda group: (
            sorted(group["sources"])[0].lower(),
            group["text"][:80],
        ),
    )


def rust_string(value: str) -> str:
    return '"' + (
        str(value)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    ) + '"'


def render_data(direct: list[dict], total: int) -> str:
    lines = [
        "// Generated by dev/gen-licenses.py — edit the generator, not this file.",
        "//",
        "// This is the direct-dependency half of THIRD_PARTY_LICENSES.md: the",
        "// components the About window shows. The full transitive list lives in",
        "// that file and is what `bee --licenses` prints.",
        "",
        "pub const COMPONENTS: &[Component] = &[",
    ]
    for component in direct:
        lines.extend(
            [
                "    Component {",
                f"        name: {rust_string(component['name'])},",
                f"        version: {rust_string(component['version'])},",
                f"        license: {rust_string(component['license'])},",
                f"        url: {rust_string(component['url'])},",
                "    },",
            ]
        )
    lines.extend(
        [
            "];",
            "",
            "pub const CONTRIBUTORS: &[&str] = &[",
        ]
    )
    lines.extend(f"    {rust_string(name)}," for name in CONTRIBUTORS)
    lines.extend(
        [
            "];",
            "",
            "/// The number of Rust crates in the full closure, direct included.",
            f"pub const TOTAL: usize = {total};",
            "",
        ]
    )
    return "\n".join(lines)


def markdown_cell(value: str) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ").strip()


def render_notice(
    root: dict,
    components: list[dict],
    contributors: list[str],
    license_groups: list[dict[str, object]],
) -> str:
    direct = [component for component in components if component["direct"]]
    transitive = [component for component in components if not component["direct"]]
    repository = (root.get("repository") or "https://github.com/radxa/linkr-bee").rstrip("/")
    license_id = root.get("license") or "Apache-2.0"
    lines = [
        "# Third-party components",
        "",
        f"{PROJECT_NAME} {root['version']} is licensed under {license_id}.",
        "",
        "This file is generated from the crate's `Cargo.lock`, `cargo metadata` and",
        "`cargo tree`. It lists the normal-dependency closure across all targets",
        "Cargo resolves; optional dependencies whose features are disabled, and",
        "build and development dependencies, are not part of that closure.",
        "",
        f"Project repository: {repository}",
        f"Project licence: {repository}/blob/main/LICENSE",
        "",
        "## Direct dependencies",
        "",
        "| Component | Version | Licence | Source |",
        "| --- | --- | --- | --- |",
    ]
    for component in direct:
        lines.append(
            "| {name} | {version} | {license} | {url} |".format(
                name=markdown_cell(component["name"]),
                version=markdown_cell(component["version"]),
                license=markdown_cell(component["license"]),
                url=markdown_cell(component["url"]),
            )
        )
    lines.extend(
        [
            "",
            f"## Transitive dependencies ({len(transitive)})",
            "",
            "| Component | Version | Licence | Source |",
            "| --- | --- | --- | --- |",
        ]
    )
    for component in transitive:
        lines.append(
            "| {name} | {version} | {license} | {url} |".format(
                name=markdown_cell(component["name"]),
                version=markdown_cell(component["version"]),
                license=markdown_cell(component["license"]),
                url=markdown_cell(component["url"]),
            )
        )
    lines.extend(["", "## Contributors", ""])
    lines.extend(f"- {name}" for name in contributors)
    lines.extend(
        [
            "",
            "## Licence texts",
            "",
            "Each component remains the property of its authors and is distributed under",
            "the licence named above. The complete text follows for every licence file",
            "shipped in a component's published package; where a package omitted its",
            "licence file, the standard text for a permissive licence named in its",
            "metadata is reproduced with that package's authors.",
            "",
        ]
    )
    for group in license_groups:
        sources = ", ".join(sorted(group["sources"]))
        applies_to = ", ".join(sorted(group["components"]))
        # Trailing spaces in an upstream licence file are not meaningful, and
        # `git diff --check` treats them as an error in a generated file.
        text = "\n".join(
            line.rstrip() for line in str(group["text"]).strip().splitlines()
        )
        lines.extend(
            [
                f"### {sources}",
                "",
                f"Applies to: {applies_to}",
                "",
                text,
                "",
            ]
        )
    return "\n".join(lines)


def write_or_check(data: str, notice: str, check: bool) -> int:
    if check:
        stale = []
        for path, expected in ((DATA_FILE, data), (NOTICE_FILE, notice)):
            try:
                current = path.read_text(encoding="utf-8")
            except FileNotFoundError:
                current = None
            if current != expected:
                stale.append(path)
        if stale:
            for path in stale:
                print(f"stale: {path.relative_to(CRATE_DIR)}", file=sys.stderr)
            print(
                "run `python3 dev/gen-licenses.py` and commit the result",
                file=sys.stderr,
            )
            return 1
        print("licence data is current")
        return 0

    DATA_FILE.write_text(data, encoding="utf-8")
    NOTICE_FILE.write_text(notice, encoding="utf-8")
    print(f"wrote {DATA_FILE.relative_to(CRATE_DIR)}")
    print(f"wrote {NOTICE_FILE.relative_to(CRATE_DIR)}")
    return 0


def main(argv: list[str]) -> int:
    if argv not in ([], ["--check"]):
        print("usage: dev/gen-licenses.py [--check]", file=sys.stderr)
        return 2
    meta = cargo_metadata()
    tree = cargo_tree()
    root, components = normal_closure(meta, tree)
    license_groups = collect_license_texts(components, meta)
    direct = [component for component in components if component["direct"]]
    data = render_data(direct, len(components))
    notice = render_notice(root, components, CONTRIBUTORS, license_groups)
    return write_or_check(data, notice, argv == ["--check"])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
