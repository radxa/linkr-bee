#!/usr/bin/env sh
# Build the supported feature variants and check their public host client.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
board=${BOARD:-esp32c3_supermini}

west build -p always -d "$repo_dir/build-verify-wifi" -b "$board" "$repo_dir"
grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WIFI=y' \
  "$repo_dir/build-verify-wifi/zephyr/.config"
grep -qx 'CONFIG_NETWORKING=y' "$repo_dir/build-verify-wifi/zephyr/.config"

west build -p always -d "$repo_dir/build-verify-ble" -b "$board" "$repo_dir" -- \
  -DCONFIG_LINKR_BLE_BRIDGE_WIFI=n
grep -qx '# CONFIG_LINKR_BLE_BRIDGE_WIFI is not set' \
  "$repo_dir/build-verify-ble/zephyr/.config"
grep -qx '# CONFIG_NETWORKING is not set' \
  "$repo_dir/build-verify-ble/zephyr/.config"
grep -qx '# CONFIG_WIFI is not set' "$repo_dir/build-verify-ble/zephyr/.config"

python3 -m compileall -q "$repo_dir/tools/linkr_ble_terminal.py"
sh -n "$repo_dir/tools/serve_web.sh"
