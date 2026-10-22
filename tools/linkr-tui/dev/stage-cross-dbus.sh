#!/usr/bin/env sh
# Stage the target's libdbus for a Linux cross build, and print the environment
# a build of that target wants.
#
# A Linux target that is not the host cannot link against the host's libdbus:
# `libdbus-sys` asks pkg-config for the target's flags, the answer has to be
# the target's own `.pc` files, and they live in the dev package for that
# architecture — which the runner's sources carry for a few architectures and
# not the rest. The ARM packages are on the ports archive, the i386 ones on
# the main archive, and this is the one recipe that knows which is which.
#
# Usage:
#   dev/stage-cross-dbus.sh <target> [stage]
#   dev/stage-cross-dbus.sh aarch64-unknown-linux-gnu /tmp/arm64-dbus
#   dev/stage-cross-dbus.sh i686-unknown-linux-gnu >> "$GITHUB_ENV"
#
# The environment is printed rather than exported, because a shell script
# cannot export into the shell that called it. It is in `$GITHUB_ENV`'s shape —
# one `NAME=value` a line, spaces and all — so CI appends it and every later
# step sees it. By hand, read the three names off the output and set them in
# the shell that builds:
#
#   dev/stage-cross-dbus.sh aarch64-unknown-linux-gnu
#   PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_LIBDIR=... cargo build --target ...
#
# `--allow-shlib-undefined` is added for i386 only: its `.deb`s are built from
# a package set the main archive trims, and the i386 libdbus links libraries
# (systemd's, among them) that are not all present in the stage — the check
# the flag relaxes is about the shared library's own links, not this binary's,
# and without it the link fails on symbols nobody here calls.
set -eu

target=${1:?usage: stage-cross-dbus.sh <target> [stage]}
case "$target" in
  x86_64-unknown-linux-gnu)
    arch=amd64; multiarch=x86_64-linux-gnu; base=http://archive.ubuntu.com/ubuntu/pool/main ;;
  aarch64-unknown-linux-gnu)
    arch=arm64; multiarch=aarch64-linux-gnu; base=http://ports.ubuntu.com/ubuntu-ports/pool/main ;;
  armv7-unknown-linux-gnueabihf)
    arch=armhf; multiarch=arm-linux-gnueabihf; base=http://ports.ubuntu.com/ubuntu-ports/pool/main ;;
  i686-unknown-linux-gnu)
    arch=i386; multiarch=i386-linux-gnu; base=http://archive.ubuntu.com/ubuntu/pool/main ;;
  *)
    echo "error: $target has no staged DBus here" >&2
    exit 1 ;;
esac

stage=${2:-/tmp/linkr-cross-$arch}
mkdir -p "$stage"

# fetch() takes the package's directory on the archive and a pattern for its
# file name, and picks the newest match — the pool is flat and holds every
# version ever shipped, so "the last one in version order" is the release.
#
# A fetch that finds nothing *returns* rather than exits, because two of the
# four packages are optional: the callers that want one say so with `|| true`,
# which can catch a status but not a `exit`.
fetch() {
  dir=$1 pattern=$2
  deb=$(curl -fsSL "$base/$dir/" | grep -oE "$pattern" | sort -V | tail -1)
  if [ -z "$deb" ]; then
    echo "error: no $pattern in $base/$dir/" >&2
    return 1
  fi
  echo "fetching $deb" >&2
  curl -fsSL -o "/tmp/$deb" "$base/$dir/$deb"
  dpkg-deb -x "/tmp/$deb" "$stage"
}

# The dev package's `libdbus-1.so` points at the runtime library, which only
# the runtime package ships; with it missing the symlink dangles, `-ldbus-1`
# falls back to the static archive in the dev tree, and that archive wants
# systemd's `sd_listen_fds` at link time. The systemd packages are fetched for
# that reason, and are allowed to be missing: the flag above covers i386, and
# an ARM archive that has dropped them still links.
fetch d/dbus    "libdbus-1-dev_[^\"]*_${arch}\.deb"
fetch d/dbus    "libdbus-1-3_[^\"]*_${arch}\.deb"
fetch s/systemd "libsystemd-dev_[^\"]*_${arch}\.deb" || true
fetch s/systemd "libsystemd0_[^\"]*_${arch}\.deb" || true

pc="$stage/usr/lib/$multiarch/pkgconfig"
sed -i -E "s#^(prefix|exec_prefix|libdir|includedir)=/usr#\1=$stage/usr#" \
  "$pc/dbus-1.pc" "$pc/libsystemd.pc" 2>/dev/null || \
  sed -i -E "s#^(prefix|exec_prefix|libdir|includedir)=/usr#\1=$stage/usr#" \
    "$pc/dbus-1.pc"

# The env, in GITHUB_ENV's shape: one `NAME=value` per line.
echo "PKG_CONFIG_ALLOW_CROSS=1"
echo "PKG_CONFIG_LIBDIR=$pc"
flags="-C link-arg=-Wl,-rpath-link,$stage/usr/lib/$multiarch"
if [ "$arch" = i386 ]; then
  flags="$flags -C link-arg=-Wl,--allow-shlib-undefined"
fi
echo "CARGO_TARGET_$(printf '%s' "$target" | tr 'a-z-' 'A-Z_')_RUSTFLAGS=$flags"
