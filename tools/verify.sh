#!/usr/bin/env sh
# Build every supported firmware and check the public host client.
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
boards=${BOARD:-"esp32c3_supermini esp32c5_devkitc/esp32c5/hpcore"}

for board in $boards; do
  build_name=$(printf '%s' "$board" | tr '/_' '--')
  build_dir="$repo_dir/build-verify-$build_name"
  west build -p always -d "$build_dir" -b "$board" "$repo_dir"
  config="$build_dir/zephyr/.config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WIFI=y' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WIFI_OPERATION_TIMEOUT_MS=30000' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WEBDAV=y' "$config"
  grep -qx 'CONFIG_NETWORKING=y' "$config"
  grep -qx 'CONFIG_NET_TCP=y' "$config"
  grep -qx '# CONFIG_NET_IPV6 is not set' "$config"
  grep -qx 'CONFIG_HTTP_SERVER=y' "$config"
  grep -qx 'CONFIG_HTTP_SERVER_VERSION_1=y' "$config"
  grep -qx '# CONFIG_HTTP_SERVER_VERSION_2 is not set' "$config"
  grep -qx 'CONFIG_HTTP_SERVER_WEBSOCKET=y' "$config"
  grep -qx 'CONFIG_ZVFS_EVENTFD_MAX=2' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE=y' "$config"
  grep -qx '# CONFIG_BT_SMP is not set' "$config"
done

python3 -m compileall -q "$repo_dir/tools/linkr_ble_terminal.py"
sh -n "$repo_dir/tools/serve_web.sh"
sh -n "$repo_dir/tools/flash_firmware.sh"
