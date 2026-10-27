#!/usr/bin/env sh
# Build every supported firmware and check the public host client.
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
boards=${BOARD:-"esp32c3_supermini esp32c3_devkitm esp32c3_devkitc esp32c5_devkitc/esp32c5/hpcore esp32_cam/esp32/procpu"}

python3 -m unittest discover -s "$repo_dir/tests" -v

for board in $boards; do
  case "$board" in
    esp32_cam/*) cam=yes ;;
    *) cam=no ;;
  esac
  build_name=$(printf '%s' "$board" | tr '/_' '--')
  build_dir="$repo_dir/build-verify-$build_name"
  west build -p always -d "$build_dir" -b "$board" "$repo_dir"
  config="$build_dir/zephyr/.config"
  python3 "$repo_dir/tools/esp_simpleboot_image.py" --check "$build_dir/zephyr/zephyr.bin"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WIFI=y' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WIFI_OPERATION_TIMEOUT_MS=30000' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WATCHDOG=y' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WATCHDOG_TIMEOUT_MS=60000' "$config"
  grep -qx 'CONFIG_WATCHDOG=y' "$config"
  grep -qx 'CONFIG_WDT_ESP32=y' "$config"
  grep -qx 'CONFIG_TASK_WDT=y' "$config"
  grep -qx 'CONFIG_TASK_WDT_HW_FALLBACK=y' "$config"
  grep -qx 'CONFIG_TASK_WDT_CHANNELS=6' "$config"
  grep -qx 'CONFIG_TASK_WDT_MIN_TIMEOUT=5000' "$config"
  if [ "$cam" = yes ]; then
    grep -qx 'CONFIG_TASK_WDT_HW_FALLBACK_DELAY=10000' "$config"
    grep -qx 'CONFIG_RING_BUFFER_LARGE=y' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WEBDAV=y' "$config"
    grep -qx '# CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS is not set' "$config"
  else
    grep -qx 'CONFIG_TASK_WDT_HW_FALLBACK_DELAY=5000' "$config"
  fi
  grep -qx '# CONFIG_TASK_WDT_DUMMY is not set' "$config"
  if grep -qx 'CONFIG_SOC_SERIES_ESP32=y' "$config" && [ "$cam" = no ]; then
    grep -qx '# CONFIG_LINKR_BLE_BRIDGE_WEBDAV is not set' "$config"
  else
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WEBDAV=y' "$config"
  fi
  grep -qx 'CONFIG_NETWORKING=y' "$config"
  grep -qx 'CONFIG_NET_TCP=y' "$config"
  grep -qx '# CONFIG_NET_IPV6 is not set' "$config"
  grep -qx 'CONFIG_HTTP_SERVER=y' "$config"
  grep -qx 'CONFIG_HTTP_SERVER_VERSION_1=y' "$config"
  grep -qx '# CONFIG_HTTP_SERVER_VERSION_2 is not set' "$config"
  grep -qx 'CONFIG_HTTP_SERVER_WEBSOCKET=y' "$config"
  grep -qx 'CONFIG_ZVFS_EVENTFD_MAX=2' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE=y' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_UART_RX_DROP_NO_CONN=y' "$config"
  grep -qx 'CONFIG_BT_SMP=y' "$config"
  if grep -Eq '^CONFIG_SOC_SERIES_ESP32(C3|C5)=y$' "$config"; then
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=y' "$config"
  fi
  if grep -qx 'CONFIG_SOC_SERIES_ESP32C3=y' "$config"; then
    grep -qx 'CONFIG_ESP32_BT_CTLR_LE_SECURITY_ENABLE=y' "$config"
  fi
  if grep -qx 'CONFIG_SOC_SERIES_ESP32=y' "$config"; then
    grep -qx 'CONFIG_ESP32_BT_CTLR_LE_SECURITY_ENABLE=y' "$config"
  fi
  # The newer Espressif controller (C5 here) declares its own security symbols;
  # every Linkr GATT attribute is encryption-only, so all of them are required.
  if grep -qx 'CONFIG_SOC_SERIES_ESP32C5=y' "$config"; then
    grep -qx 'CONFIG_ESP32_BT_LE_SECURITY_ENABLE=y' "$config"
    grep -qx 'CONFIG_ESP32_BT_LE_SM_SC=y' "$config"
    grep -qx '# CONFIG_ESP32_BT_LE_SM_LEGACY is not set' "$config"
    grep -qx 'CONFIG_ESP32_BT_LE_LL_CFG_FEAT_LE_ENCRYPTION=y' "$config"
    grep -qx 'CONFIG_ESP32_BT_LE_CRYPTO_STACK_MBEDTLS=y' "$config"
  fi
  grep -qx 'CONFIG_BT_SMP_APP_PAIRING_ACCEPT=y' "$config"
  grep -qx 'CONFIG_BT_BONDING_REQUIRED=y' "$config"
  grep -qx 'CONFIG_BT_SETTINGS=y' "$config"
  grep -qx 'CONFIG_BT_SMP_SC_PAIR_ONLY=y' "$config"
  grep -qx 'CONFIG_BT_MAX_PAIRED=8' "$config"
  grep -qx '# CONFIG_BT_KEYS_OVERWRITE_OLDEST is not set' "$config"
  grep -qx '# CONFIG_BT_ZEPHYR_NUS_DEFAULT_INSTANCE is not set' "$config"
done

python3 -m compileall -q "$repo_dir/tools/linkr_ble_terminal.py"
sh -n "$repo_dir/tools/serve_web.sh"
sh -n "$repo_dir/tools/build_agent_bundle.sh"
sh -n "$repo_dir/tools/flash_firmware.sh"
sh -n "$repo_dir/tools/build_terminal_binary.sh"

# The C reference client is a shipped artifact with no other build path.
if pkg-config --exists dbus-1 2>/dev/null; then
  make -C "$repo_dir/tools" clean all
else
  echo "skipping the C reference terminal: dbus-1 development files not found" >&2
fi
