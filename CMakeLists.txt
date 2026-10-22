cmake_minimum_required(VERSION 3.20.0)

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
  src/target_binding.c
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
)

# HTTP service resources live in named iterable sections (WebSocket bridge).
zephyr_linker_sources(SECTIONS sections-rom.ld)
