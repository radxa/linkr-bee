#!/usr/bin/env sh
# Build and package the host terminal as a Debian package for one target.
#
# One definition, two callers: a developer's shell and a release script. The
# control fields and the installed layout are part of the promise a package
# makes, so they are written here rather than in somebody's shell history.
#
# Usage:
#   dev/package-deb.sh <target> [outdir]
#   dev/package-deb.sh x86_64-unknown-linux-gnu
#   dev/package-deb.sh aarch64-unknown-linux-gnu dist
#
# Produces <outdir>/linkr-bee_<version>_<arch>.deb holding
#   usr/bin/bee                        the command
#   usr/share/doc/linkr-bee/README.md  what it is and how to run it
#   usr/share/doc/linkr-bee/LICENSE    the licence it ships under
#   usr/share/doc/linkr-bee/THIRD_PARTY_LICENSES.md  the components it links
#
# A cross target on a different host gets the matching linker, `CC_<target>`
# and the target's own pkg-config directory (where the cross `libdbus-1-dev`
# lives), so the same command works on any host with the toolchain installed.
# Set `PKG_CONFIG_LIBDIR` to override that directory.
set -eu

target=${1:?usage: package-deb.sh <target> [outdir]}
outdir=${2:-dist}

crate_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH='' cd -- "$crate_dir/../.." && pwd)
version=$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$crate_dir/Cargo.toml" | head -1)
if [ -z "$version" ]; then
  echo "error: no version in $crate_dir/Cargo.toml" >&2
  exit 1
fi

case "$target" in
  x86_64-unknown-linux-gnu)
    arch=amd64; cc=x86_64-linux-gnu-gcc; multiarch=x86_64-linux-gnu ;;
  aarch64-unknown-linux-gnu)
    arch=arm64; cc=aarch64-linux-gnu-gcc; multiarch=aarch64-linux-gnu ;;
  armv7-unknown-linux-gnueabihf)
    arch=armhf; cc=arm-linux-gnueabihf-gcc; multiarch=arm-linux-gnueabihf ;;
  i686-unknown-linux-gnu)
    arch=i386; cc=i686-linux-gnu-gcc; multiarch=i386-linux-gnu ;;
  *)
    echo "error: $target has no Debian architecture here" >&2
    exit 1 ;;
esac

host=$(rustc -vV | sed -n 's/^host: //p')
if [ "$target" != "$host" ]; then
  export "CARGO_TARGET_$(printf '%s' "$target" | tr 'a-z-' 'A-Z_')_LINKER=$cc"
  export "CC_$(printf '%s' "$target" | tr '-' '_')=$cc"
  export PKG_CONFIG_ALLOW_CROSS=1
  : "${PKG_CONFIG_LIBDIR:=/usr/lib/$multiarch/pkgconfig}"
  export PKG_CONFIG_LIBDIR
fi

# `--locked` because Cargo.lock is committed: a release must be the dependency
# set that was tested, not whatever the registry had that morning.
cargo build --release --locked --target "$target" --manifest-path "$crate_dir/Cargo.toml"

# The libc floor is read back from the ELF rather than guessed: the loader
# enforces every version reference the binary carries, weak ones included, so
# the highest `GLIBC_` version the symbol table asks for is what `Depends` must
# promise. A binary without such references keeps the plain dependency.
if [ "$target" = "$host" ]; then
  readelf=readelf
else
  readelf=$(printf '%s' "$cc" | sed 's/gcc$/readelf/')
fi
glibc=$("$readelf" --dyn-syms --wide "$crate_dir/target/$target/release/bee" |
  grep -o 'GLIBC_[0-9.]*' | sort -V | tail -1)
if [ -n "$glibc" ]; then
  libc="libc6 (>= ${glibc#GLIBC_})"
else
  libc=libc6
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# The archive's root entry should read like a root: `mktemp -d` makes it 0700.
chmod 755 "$stage"

install -D -m 755 "$crate_dir/target/$target/release/bee" "$stage/usr/bin/bee"
install -D -m 644 "$crate_dir/README.md" "$stage/usr/share/doc/linkr-bee/README.md"
if [ -f "$repo_dir/LICENSE" ]; then
  install -D -m 644 "$repo_dir/LICENSE" "$stage/usr/share/doc/linkr-bee/LICENSE"
fi
install -D -m 644 "$crate_dir/THIRD_PARTY_LICENSES.md" \
  "$stage/usr/share/doc/linkr-bee/THIRD_PARTY_LICENSES.md"

installed_size=$(du -sk "$stage" | cut -f1)
mkdir -p "$stage/DEBIAN"
cat > "$stage/DEBIAN/control" <<EOF
Package: linkr-bee
Version: $version
Section: comm
Priority: optional
Architecture: $arch
Depends: $libc, libgcc-s1, libdbus-1-3
Installed-Size: $installed_size
Maintainer: Novice-PG <1760745691@qq.com>
Homepage: https://github.com/radxa/linkr-bee
Description: Terminal console for Linkr Bee wireless serial bridges
 BLE, WiFi and LAN discovery, a serial session through the bridge, and the
 bridge's own diagnostics, in one keyboard-driven frame.
EOF

mkdir -p "$outdir"
deb=$(CDPATH='' cd -- "$outdir" && pwd)/"linkr-bee_${version}_${arch}.deb"
dpkg-deb --build --root-owner-group "$stage" "$deb"

echo "$deb"
