#!/usr/bin/env sh
# Build and package the host terminal for one target, in either of its faces.
#
# One definition, two callers: the CI matrix and a developer's shell. The layout
# of an archive is part of the promise a release makes, so it is written here
# rather than in the workflow *and* in somebody's shell history.
#
# Usage:
#   dev/package.sh [--cli] <target> [outdir]
#   dev/package.sh x86_64-unknown-linux-gnu
#   dev/package.sh --cli x86_64-pc-windows-gnu dist
#
# Without `--cli` the archive is the whole program:
#   linkr-bee-<version>-<target>/bee[.exe]    the binary
#   linkr-bee-<version>-<target>/README.md    what it is and how to run it
#   linkr-bee-<version>-<target>/LICENSE      the licence it ships under
#   linkr-bee-<version>-<target>/THIRD_PARTY_LICENSES.md  the components it links
# With `--cli` it is the same program built without the interface — the build
# an agent harness wants, and a smaller one:
#   linkr-bee-cli-<version>-<target>/bee-cli[.exe]
#   linkr-bee-cli-<version>-<target>/README.md    the CLI-specific guide
#   linkr-bee-cli-<version>-<target>/LICENSE      as above
#   linkr-bee-cli-<version>-<target>/THIRD_PARTY_LICENSES.md  as above
#
# The archive format is the one the platform's own users reach for: a `.zip` on
# Windows, a `.dmg` on macOS, a `.tar.gz` on Linux — and a `.tar.gz` beside the
# `.dmg` as well, because a volume image is a heavy thing to mount on a machine
# that only wants the binary. Linux also ships `.deb`s, built by
# `dev/package-deb.sh` from the same target and the same source. Every path
# this script writes is printed, one per line, so a caller can pick them up
# without knowing the rule.
set -eu

variant=
case "${1:-}" in
  --cli) variant=cli; shift ;;
esac

target=${1:?usage: package.sh [--cli] <target> [outdir]}
outdir=${2:-dist}

crate_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH='' cd -- "$crate_dir/../.." && pwd)
version=$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$crate_dir/Cargo.toml" | head -1)
if [ -z "$version" ]; then
  echo "error: no version in $crate_dir/Cargo.toml" >&2
  exit 1
fi

exe=
case "$target" in
  *windows*) exe=.exe ;;
esac

# The archive still carries the Linkr Bee name, but the executable inside it is
# `bee`: `linkr` is a separate Radxa project, and two programs must not fight
# over one command name. A CLI build is asked for its help as `bee-cli`.
tag=linkr-bee
bin=bee
if [ "$variant" = cli ]; then
  tag=linkr-bee-cli
  bin=bee-cli
fi
name="$tag-$version-$target"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# `--locked` because Cargo.lock is committed: a release must be the dependency
# set that was tested, not whatever the registry had that morning. The CLI
# build asks for the `cli` feature alone, which leaves the interface — and the
# crossterm event loop with it — out of the binary.
if [ "$variant" = cli ]; then
  cargo build --release --locked --no-default-features --features cli \
    --target "$target" --manifest-path "$crate_dir/Cargo.toml"
else
  cargo build --release --locked --target "$target" --manifest-path "$crate_dir/Cargo.toml"
fi

mkdir -p "$stage/$name"
cp "$crate_dir/target/$target/release/bee$exe" "$stage/$name/$bin$exe"
if [ "$variant" = cli ]; then
  # The two faces are invoked by different names, so they get guides written
  # for the binary in the archive: the CLI archive must not tell a reader to
  # open a terminal that this build does not contain.
  cp "$crate_dir/README-cli.md" "$stage/$name/README.md"
else
  cp "$crate_dir/README.md" "$stage/$name/README.md"
fi
if [ -f "$repo_dir/LICENSE" ]; then
  cp "$repo_dir/LICENSE" "$stage/$name/LICENSE"
fi
# The generated notice names every crate in the binary. It is committed and
# checked by the gates, so a missing file here is a broken tree, not a reason
# to ship an archive that says less.
cp "$crate_dir/THIRD_PARTY_LICENSES.md" "$stage/$name/THIRD_PARTY_LICENSES.md"

mkdir -p "$outdir"
outdir=$(CDPATH='' cd -- "$outdir" && pwd)

# tarball() is the fallback and the Linux format both; the two platform cases
# below are additions to it, not replacements.
tarball() {
  archive="$outdir/$name.tar.gz"
  (umask 022 && cd "$stage" && tar -czf "$archive" "$name")
  echo "$archive"
}

case "$target" in
  *windows*)
    # `zip` is the tool on a Linux host, `7z` is on the Windows runners, and
    # bsdtar — what Windows and Git Bash ship — writes a zip when the name
    # ends in `.zip`. The version is asked first because GNU tar accepts `-a`
    # with any name and quietly writes a *tar*: an archive called `.zip` that
    # is not one is worse than no archive at all.
    archive="$outdir/$name.zip"
    if command -v zip >/dev/null 2>&1; then
      (umask 022 && cd "$stage" && zip -q -r "$archive" "$name")
    elif command -v 7z >/dev/null 2>&1; then
      (umask 022 && cd "$stage" && 7z a -bd -y "$archive" "$name" >/dev/null)
    elif tar --version 2>/dev/null | grep -qi bsdtar &&
         tar -a -c -f "$archive" -C "$stage" "$name" 2>/dev/null; then
      : # written by bsdtar
    else
      echo "error: no zip writer here: install zip(1) or 7z(1)" >&2
      exit 1
    fi
    echo "$archive"
    ;;
  *apple-darwin*)
    # The volume holds the files themselves — no top folder — so the window it
    # opens in shows `bee` to drag wherever the user keeps tools. The
    # tarball is written first because it is the format the smoke test reads
    # on a machine that cannot mount images.
    tarball
    archive="$outdir/$name.dmg"
    rm -f "$archive"
    hdiutil create -quiet -volname "$name" -srcfolder "$stage/$name" \
      -ov -format UDZO "$archive"
    echo "$archive"
    ;;
  *)
    tarball
    ;;
esac
