#!/usr/bin/env sh
# Build every supported firmware and check the public host client.
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
boards=${BOARD:-"esp32c3_supermini esp32c3_devkitm esp32c3_devkitc esp32c5_devkitc/esp32c5/hpcore linkr_bee_x1_0 esp32_devkitc/esp32/procpu esp32s3_devkitc/esp32s3/procpu"}

python3 -m unittest discover -s "$repo_dir/tests" -v

for board in $boards; do
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
  grep -qx 'CONFIG_TASK_WDT_HW_FALLBACK_DELAY=5000' "$config"
  grep -qx '# CONFIG_TASK_WDT_DUMMY is not set' "$config"
  if grep -qx 'CONFIG_SOC_SERIES_ESP32=y' "$config"; then
    grep -qx '# CONFIG_LINKR_BLE_BRIDGE_WEBDAV is not set' "$config"
  else
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WEBDAV=y' "$config"
  fi
  grep -qx 'CONFIG_NETWORKING=y' "$config"
  grep -qx '# CONFIG_WIFI_STA_AUTO_DHCPV4 is not set' "$config"
  grep -qx 'CONFIG_NET_TCP=y' "$config"
  grep -qx '# CONFIG_NET_IPV6 is not set' "$config"
  grep -qx 'CONFIG_HTTP_SERVER=y' "$config"
  grep -qx 'CONFIG_HTTP_SERVER_VERSION_1=y' "$config"
  grep -qx '# CONFIG_HTTP_SERVER_VERSION_2 is not set' "$config"
  grep -qx 'CONFIG_HTTP_SERVER_WEBSOCKET=y' "$config"
  grep -qx 'CONFIG_ZVFS_EVENTFD_MAX=2' "$config"
  grep -qx 'CONFIG_ZVFS_POLL_MAX=5' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE=y' "$config"
  grep -qx 'CONFIG_LINKR_BLE_BRIDGE_UART_RX_DROP_NO_CONN=y' "$config"
  grep -qx 'CONFIG_BT_SMP=y' "$config"
  grep -qx 'CONFIG_BT_MAX_CONN=2' "$config"
  # The air link: every board asks for 7.5-15 ms and (where the controller has
  # it) 2M PHY. A board conf that drops either silently returns the link to the
  # central's default interval, which is what made full-screen programs crawl.
  grep -qx 'CONFIG_BT_GAP_AUTO_UPDATE_CONN_PARAMS=y' "$config"
  grep -qx 'CONFIG_BT_PERIPHERAL_PREF_MIN_INT=6' "$config"
  grep -qx 'CONFIG_BT_PERIPHERAL_PREF_MAX_INT=12' "$config"
  if grep -Eq '^CONFIG_SOC_SERIES_ESP32(C3|C5)=y$' "$config"; then
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=y' "$config"
  fi
  if grep -Eq '^CONFIG_SOC_SERIES_ESP32(C3|S3)=y$' "$config"; then
    grep -qx 'CONFIG_ESP32_BT_CTLR_LE_SECURITY_ENABLE=y' "$config"
  fi
  if [ "$board" = "linkr_bee_x1_0" ]; then
    # The board support has to describe the bare ESP32-C3FH4 and enable the
    # auxiliary hardware the firmware drives on this PCB.
    grep -qx 'CONFIG_SOC_ESP32C3=y' "$config"
    grep -qx 'CONFIG_FLASH_SIZE=4096' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_RGB_STATUS_LED=y' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_OPTO_SWITCH=y' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_IR=y' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_IR_TX=y' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_IR_RX=y' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_IR_LEARN=y' "$config"
    grep -qx 'CONFIG_PWM=y' "$config"
    grep -qx 'CONFIG_MAIN_STACK_SIZE=2048' "$config"
    grep -qx 'CONFIG_LOG_PROCESS_THREAD_STACK_SIZE=1024' "$config"
    grep -qx 'CONFIG_ENTROPY_ESP32_RNG=y' "$config"
    grep -qx 'CONFIG_HARDWARE_DEVICE_CS_GENERATOR=y' "$config"
    grep -qx '# CONFIG_TEST_RANDOM_GENERATOR is not set' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_UART_RX_BUFFER_SIZE=16384' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_PEER_TX_QUEUE_DEPTH=8' "$config"
  fi
  # The newer Espressif controller (C5 here) declares its own security symbols;
  # every Linkr GATT attribute is encryption-only, so all of them are required.
  if grep -qx 'CONFIG_SOC_SERIES_ESP32C5=y' "$config"; then
    grep -qx 'CONFIG_ESP32_BT_LE_SECURITY_ENABLE=y' "$config"
    grep -qx 'CONFIG_ESP32_BT_LE_SM_SC=y' "$config"
    grep -qx '# CONFIG_ESP32_BT_LE_SM_LEGACY is not set' "$config"
    grep -qx 'CONFIG_ESP32_BT_LE_LL_CFG_FEAT_LE_ENCRYPTION=y' "$config"
    grep -qx 'CONFIG_ESP32_BT_LE_CRYPTO_STACK_MBEDTLS=y' "$config"
    # The released C5 image runs from the module's 8 MB PSRAM. Assert the
    # layout, never the byte counts: sizes move with every feature, but an
    # image that silently loses PSRAM, or starts serving the WiFi adapter heap
    # from it, is a regression either way. docs/C5_PSRAM.md records why.
    grep -qx 'CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y' "${config}"
    grep -qx 'CONFIG_ESP_SPIRAM=y' "$config"
    grep -qx 'CONFIG_ESP_SPIRAM_SIZE=8388608' "$config"
    grep -qx 'CONFIG_SPIRAM_TYPE_ESPPSRAM64=y' "$config"
    grep -qx 'CONFIG_SPIRAM_MODE_QUAD=y' "$config"
    grep -qx 'CONFIG_SPIRAM_SPEED_80M=y' "$config"
    grep -qx '# CONFIG_ESP_SPIRAM_MEMTEST is not set' "$config"
    grep -qx 'CONFIG_ESP_WIFI_HEAP_SYSTEM=y' "$config"
    grep -qx '# CONFIG_ESP_WIFI_HEAP_SPIRAM is not set' "$config"
    grep -qx '# CONFIG_ESP32_WIFI_NET_ALLOC_SPIRAM is not set' "$config"
    # The migrated buffers have to actually land in external RAM:
    # .ext_ram.bss is mapped into the 0x42xxxxxx region on this SoC, while
    # internal SRAM sits at 0x408xxxxx. A missing symbol means nothing was
    # migrated at all.
    ext_ram_start=$(awk '/_ext_ram_bss_start = ABSOLUTE/ {print $1; exit}' \
      "$build_dir/zephyr/zephyr.map")
    case "$ext_ram_start" in
      0x42*) ;;
      *)
        echo "PSRAM buffers are not in external RAM (got '${ext_ram_start:-nothing}')" >&2
        exit 1
        ;;
    esac
    # The release overlay leaves the RGB driver inactive. Also compile it
    # against the C5 register definitions with a pixel on the first GPIO bank.
    west build -p always -d "$build_dir-rgb" -b "$board" "$repo_dir" -t app -- \
      -DEXTRA_DTC_OVERLAY_FILE="$repo_dir/tests/esp32c5_rgb.overlay"
  fi
  # The S3 target has two variants: the default build makes no PSRAM
  # assumption (so it runs on 8 MB-flash modules with or without a 2 MB part),
  # and an N16R8 build adds the 16 MB flash / 8 MB octal PSRAM sizes plus the
  # enlarged buffers. Check both so neither silently drifts.
  if grep -qx 'CONFIG_SOC_SERIES_ESP32S3=y' "$config"; then
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_RGB_STATUS_LED=y' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_RGB_MANUAL_ONLY=y' "$config"
    # Default variant: no external RAM, data buffers back in internal SRAM.
    grep -qx '# CONFIG_ESP_SPIRAM is not set' "$config"
    grep -qx '# CONFIG_RING_BUFFER_LARGE is not set' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_UART_RX_BUFFER_SIZE=8192' "$config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_LOG_RING_SIZE=8192' "$config"

    # N16R8 variant: the extra fragments must produce the 8 MB octal part and
    # the enlarged PSRAM-resident buffers.
    n16r8_dir="$repo_dir/build-verify-$build_name-n16r8"
    west build -p always -d "$n16r8_dir" -b "$board" "$repo_dir" -- \
      -DEXTRA_CONF_FILE="$repo_dir/boards/esp32s3_devkitc_esp32s3_procpu_n16r8.conf" \
      -DEXTRA_DTC_OVERLAY_FILE="$repo_dir/boards/esp32s3_devkitc_esp32s3_procpu_n16r8.overlay"
    n16r8_config="$n16r8_dir/zephyr/.config"
    python3 "$repo_dir/tools/esp_simpleboot_image.py" --check "$n16r8_dir/zephyr/zephyr.bin"
    for variant in "$build_dir" "$n16r8_dir"; do
      dts="$variant/zephyr/zephyr.dts"
      grep -Fq 'zephyr,linkr-ble-uart = &uart1;' "$dts"
      grep -Fq 'zephyr,console = &usb_serial;' "$dts"
      sed -n '/linkr_rgb: linkr-rgb {/,/};/p' "$dts" | grep -Fq 'channel-count = < 0x3 >;'
    done
    grep -qx 'CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y' "$n16r8_config"
    grep -qx 'CONFIG_ESP_SPIRAM=y' "$n16r8_config"
    grep -qx 'CONFIG_ESP_SPIRAM_SIZE=8388608' "$n16r8_config"
    grep -qx 'CONFIG_SPIRAM_TYPE_ESPPSRAM64=y' "$n16r8_config"
    grep -qx 'CONFIG_SPIRAM_MODE_OCT=y' "$n16r8_config"
    grep -qx 'CONFIG_SPIRAM_SPEED_80M=y' "$n16r8_config"
    grep -qx '# CONFIG_ESP_SPIRAM_MEMTEST is not set' "$n16r8_config"
    grep -qx 'CONFIG_ESP_WIFI_HEAP_SYSTEM=y' "$n16r8_config"
    grep -qx '# CONFIG_ESP_WIFI_HEAP_SPIRAM is not set' "$n16r8_config"
    grep -qx '# CONFIG_ESP32_WIFI_NET_ALLOC_SPIRAM is not set' "$n16r8_config"
    # .ext_ram.bss sits at 0x3Cxxxxxx on this SoC, not in internal SRAM.
    ext_ram_start=$(awk '/_ext_ram_bss_start = ABSOLUTE/ {print $1; exit}' \
      "$n16r8_dir/zephyr/zephyr.map")
    case "$ext_ram_start" in
      0x3c*) ;;
      *)
        echo "S3 PSRAM buffers are not in external RAM (got '${ext_ram_start:-nothing}')" >&2
        exit 1
        ;;
    esac
    # The point of this variant is to spend the extra PSRAM on buffers that
    # make the bridge feel better, not to match the C3 defaults. Keep the
    # enlarged settings from silently regressing, and keep the external heap
    # big enough to fill the part.
    grep -qx 'CONFIG_RING_BUFFER_LARGE=y' "$n16r8_config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_LOG_RING_SIZE=131072' "$n16r8_config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WEBDAV_UPLOAD_CHUNK=65536' "$n16r8_config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_CLIENT_BUFFER_SIZE=32768' "$n16r8_config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_PEER_TX_QUEUE_DEPTH=64' "$n16r8_config"
    grep -qx 'CONFIG_LINKR_BLE_BRIDGE_UART_RX_BUFFER_SIZE=24576' "$n16r8_config"
    grep -qx 'CONFIG_ESP_SPIRAM_HEAP_SIZE=8049120' "$n16r8_config"
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
