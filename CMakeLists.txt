cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(linkr_ble_bridge)

target_sources(app PRIVATE
  src/main.c
  src/wifi.c
  src/ws_bridge.c
)

# HTTP service resources live in named iterable sections (WebSocket bridge).
zephyr_linker_sources(SECTIONS sections-rom.ld)
