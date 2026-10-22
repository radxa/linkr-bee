#!/usr/bin/env sh
# Read one release archive back and say whether it is the archive it claims to
# be: a folder named after the archive holding the binary and the three
# documents it ships with, and nothing else.
#
# Usage:
#   dev/check-archive.sh <archive>
#   dev/check-archive.sh dist/*
#
# One definition, every caller: all ten packaging legs run this over their own
# `dist`, whichever runner they are on, so no leg can pass by being checked less
# than the others. The listing tool is the platform's own — `unzip` where it
# exists, bsdtar (`tar`) where it does not, `dpkg-deb` for a package — and a
# format the host cannot read is reported as skipped rather than passed, which
# is why a `.dmg` is left to the smoke step that mounts it.
set -eu

archive=${1:?usage: check-archive.sh <archive>}
[ -f "$archive" ] || {
  echo "error: no $archive" >&2
  exit 1
}
stem=$(basename "$archive")

case "$stem" in
  *.deb)
    # `dpkg-deb -c` prints a long listing, and the obvious `| grep -q` would
    # end the reader the moment it matched, killing the writer with SIGPIPE.
    # Capture first, match on the string.
    fields=$(dpkg-deb -f "$archive" Package Architecture)
    echo "$fields"
    printf '%s\n' "$fields" | grep -qx 'Package: linkr-bee' || {
      echo "unexpected package name" >&2
      exit 1
    }
    contents=$(dpkg-deb -c "$archive")
    printf '%s\n' "$contents" | grep -E ' \./usr/bin/bee$' >/dev/null || {
      echo "the package holds no binary" >&2
      exit 1
    }
    echo "$archive: ok (deb)"
    exit 0
    ;;
  *.tar.gz) listing=$(tar -tzf "$archive") ;;
  *.zip)
    # A zip is checked by extracting it rather than by listing it: on Windows
    # the listing needs a tool Git Bash does not have — its `tar` is GNU tar
    # and cannot read a zip, and there is no `unzip` — while PowerShell is
    # always there and reads one. The tree that comes out is what the user
    # will have, which is what the rest of this script is about.
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        # `cygpath` is what turns the shell's `/tmp/...` into the path
        # PowerShell will actually open.
        powershell -NoProfile -Command \
          "Expand-Archive -LiteralPath '$(cygpath -w "$archive")' \
             -DestinationPath '$(cygpath -w "$work")' -Force" >/dev/null
        ;;
      *)
        unzip -q "$archive" -d "$work" 2>/dev/null ||
          tar -xf "$archive" -C "$work" 2>/dev/null || {
            echo "no tool here can read a zip" >&2
            exit 1
          }
        ;;
    esac
    # The paths are taken relative to the extraction root, which is the shape
    # the rule below is written in.
    listing=$(cd "$work" && find . -mindepth 1 | sed 's|^\./||')
    ;;
  *.dmg)
    if [ "$(uname -s)" = Darwin ]; then
      echo "$archive: a volume image — proved by mounting it, which the smoke step does where this target can run"
    else
      echo "$archive: a volume image — skipped, only macOS can mount it"
    fi
    exit 0
    ;;
  *)
    echo "$archive: not a format this checks"
    exit 0
    ;;
esac

echo "$listing"
name=${stem%.tar.gz}
name=${name%.zip}
bin=bee
case "$name" in linkr-bee-cli-*) bin=bee-cli ;; esac
# Nothing may be in here that the script did not put there: a stray file in a
# release is uploaded before anyone reads the diff. The folder is spelled both
# ways because `tar` lists a directory with its trailing slash and a `find`
# over an extracted zip does not.
allowed=$(printf '%s\n' "$name" "$name/" "$name/$bin" "$name/$bin.exe" \
                        "$name/README.md" "$name/LICENSE" \
                        "$name/THIRD_PARTY_LICENSES.md")
for entry in $listing; do
  printf '%s\n' "$allowed" | grep -qx "$entry" || {
    echo "unexpected entry in the archive: $entry" >&2
    exit 1
  }
done
# And the binary and the three documents it promises must all be present.
printf '%s\n' "$listing" | grep -E "^$name/$bin(\.exe)?$" >/dev/null || {
  echo "the archive holds no binary" >&2
  exit 1
}
for required in README.md LICENSE THIRD_PARTY_LICENSES.md; do
  printf '%s\n' "$listing" | grep -qx "$name/$required" || {
    echo "the archive holds no $required" >&2
    exit 1
  }
done
echo "$archive: ok"
