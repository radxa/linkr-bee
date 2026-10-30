cmake_minimum_required(VERSION 3.20.0)

# The Linkr Bee X1.0 board definition lives in boards/radxa/linkr_bee_x1_0, so
# the application root has to be searched as a board root for
# `west build -b linkr_bee_x1_0`. This has to happen before find_package(),
# which is where Zephyr resolves the board.
list(APPEND BOARD_ROOT "${CMAKE_CURRENT_SOURCE_DIR}")

# The module runs after the SoC is configured, before Zephyr collects its
# post-build commands. Keep the pinned Zephyr checkout unmodified.
list(APPEND EXTRA_ZEPHYR_MODULES "${CMAKE_CURRENT_SOURCE_DIR}/cmake/esp_simpleboot")
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(linkr_ble_bridge)

if(CONFIG_SOC_SERIES_ESP32C3)
  include(cmake/esp32c3_hci_order.cmake)
endif()

# ESP32 (Xtensa) uses the same HCI driver; apply the same ordering fix.
if(CONFIG_SOC_SERIES_ESP32 AND NOT CONFIG_SOC_SERIES_ESP32C3)
  include(cmake/esp32c3_hci_order.cmake)
endif()

target_sources(app PRIVATE
  src/serial_session.c
  src/ble_peers.c
  src/target_binding.c
  src/bond_manager.c
  src/bond_label.c
  src/ble_security.c
  src/ble_nus.c
  src/ble_mgmt.c
  src/ble_uart_reliable.c
  src/main.c
  src/uart_autobaud.c
  src/uart_rmt_span.c
  src/uart_bulk_tx.c
  src/wifi.c
  src/ws_bridge.c
  # Board status LED, optocoupler switch and IR remote. Every file compiles to
  # stubs on boards whose devicetree does not describe the hardware, so the
  # command group exists everywhere and reports "unsupported" instead of the
  # firmware silently dropping the feature.
  src/ir_learn.c
  src/ir_nec.c
  src/linkr_aux.c
  src/linkr_ir.c
  src/linkr_opto.c
  src/linkr_prompt.c
  src/linkr_aiconf.c
  src/linkr_status_led.c
  src/linkr_ws2812.c
)
target_sources_ifdef(CONFIG_LINKR_BLE_BRIDGE_WATCHDOG app PRIVATE src/watchdog.c)

# HTTP service resources live in named iterable sections (WebSocket bridge).
zephyr_linker_sources(SECTIONS sections-rom.ld)
