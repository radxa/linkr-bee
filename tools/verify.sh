#!/usr/bin/env sh
# Build the single supported firmware and check its public host client.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
board=${BOARD:-esp32c3_supermini}

west build -p always -d "$repo_dir/build-verify-wifi" -b "$board" "$repo_dir"
grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WIFI=y' \
  "$repo_dir/build-verify-wifi/zephyr/.config"
grep -qx 'CONFIG_NETWORKING=y' "$repo_dir/build-verify-wifi/zephyr/.config"
grep -qx 'CONFIG_NET_TCP=y' "$repo_dir/build-verify-wifi/zephyr/.config"
grep -qx 'CONFIG_HTTP_SERVER=y' "$repo_dir/build-verify-wifi/zephyr/.config"
grep -qx 'CONFIG_HTTP_SERVER_WEBSOCKET=y' \
  "$repo_dir/build-verify-wifi/zephyr/.config"
grep -qx 'CONFIG_ZVFS_EVENTFD_MAX=2' \
  "$repo_dir/build-verify-wifi/zephyr/.config"
grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE=y' \
  "$repo_dir/build-verify-wifi/zephyr/.config"

python3 -m compileall -q "$repo_dir/tools/linkr_ble_terminal.py"
sh -n "$repo_dir/tools/serve_web.sh"
sh -n "$repo_dir/tools/flash_firmware.sh"
