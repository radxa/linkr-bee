cmake_minimum_required(VERSION 3.20.0)

# The Linkr Bee X1.0 board definition lives in boards/radxa/linkr_bee_x1_0, so
# the application root has to be searched as a board root for
# `west build -b linkr_bee_x1_0`. This has to happen before find_package(),
# which is where Zephyr resolves the board.
list(APPEND BOARD_ROOT "${CMAKE_CURRENT_SOURCE_DIR}")

# ---------------------------------------------------------------------------
# Local patches applied to west-managed trees.
#
# They live here rather than in the checkout so that `west update` cannot drop
# them silently and so that everyone building this repository gets the same
# image. Each patch is applied once and only if it is not already present,
# which keeps repeat builds and in-place checkouts idempotent.
#
# Applied BEFORE find_package(Zephyr): that call parses Kconfig, so a patch that
# edits a Kconfig file and is applied afterwards will not reach the .config of
# the current build -- the first configure on a clean tree silently produced an
# image without it, and only the second one picked it up. Deriving the module
# path here is the price: ZEPHYR_HAL_ESPRESSIF_MODULE_DIR only exists after the
# module system has run, so the path is resolved the way a west workspace lays
# it out (modules next to the zephyr checkout) with `west list` as a fallback.
# ---------------------------------------------------------------------------
function(linkr_apply_patch tree_dir patch_rel)
  if(NOT EXISTS "${tree_dir}/.git")
    message(WARNING "Tree at ${tree_dir} is not a git checkout; "
                    "cannot verify ${patch_rel}. Applying unconditionally.")
    execute_process(
      COMMAND git -C "${tree_dir}" apply "${CMAKE_CURRENT_SOURCE_DIR}/${patch_rel}"
      RESULT_VARIABLE rc OUTPUT_VARIABLE out ERROR_VARIABLE out)
    if(NOT rc EQUAL 0)
      message(FATAL_ERROR "Failed to apply ${patch_rel}: ${out}")
    endif()
    return()
  endif()

  execute_process(
    COMMAND git -C "${tree_dir}" apply --reverse --check
            "${CMAKE_CURRENT_SOURCE_DIR}/${patch_rel}"
    RESULT_VARIABLE already OUTPUT_QUIET ERROR_QUIET)
  if(already EQUAL 0)
    message(STATUS "Patch already applied: ${patch_rel}")
    return()
  endif()

  execute_process(
    COMMAND git -C "${tree_dir}" apply "${CMAKE_CURRENT_SOURCE_DIR}/${patch_rel}"
    RESULT_VARIABLE rc OUTPUT_VARIABLE out ERROR_VARIABLE out)
  if(NOT rc EQUAL 0)
    message(FATAL_ERROR
      "Failed to apply ${patch_rel} to ${tree_dir}: ${out}\n"
      "Restore the tree (git -C <tree> checkout .) and rebuild.")
  endif()
  message(STATUS "Applied patch: ${patch_rel}")
endfunction()

function(linkr_locate_hal_espressif out_var)
  set(found "")
  if(DEFINED ENV{ZEPHYR_BASE})
    get_filename_component(ws "$ENV{ZEPHYR_BASE}/.." ABSOLUTE)
    if(EXISTS "${ws}/modules/hal/espressif/zephyr/Kconfig")
      set(found "${ws}/modules/hal/espressif")
    endif()
  endif()
  if(NOT found)
    find_program(LINKR_WEST west)
    if(LINKR_WEST)
      execute_process(COMMAND "${LINKR_WEST}" list -f "{abspath}" hal_espressif
                      OUTPUT_VARIABLE dir OUTPUT_STRIP_TRAILING_WHITESPACE
                      RESULT_VARIABLE rc ERROR_QUIET)
      if(rc EQUAL 0 AND EXISTS "${dir}/zephyr/Kconfig")
        set(found "${dir}")
      endif()
    endif()
  endif()
  set(${out_var} "${found}" PARENT_SCOPE)
endfunction()

# Let the C5 place its own .ext_ram.bss. Zephyr's esp_psram.c subtracts
# _ext_ram_bss_start.._ext_ram_bss_end from the shared-heap region only when
# CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY is set, and the hal_espressif
# module defaults that to y for ESP32/S2/S3 but not for the C5. Without it
# esp_psram_smh_init() registers the pool at the mapped region start, which is
# the same address .ext_ram.bss begins at, and sys_heap_init() writes its header
# onto the first migrated buffer. docs/C5_PSRAM.md section 3 has the details.
linkr_locate_hal_espressif(LINKR_HAL_ESPRESSIF_DIR)
if(NOT LINKR_HAL_ESPRESSIF_DIR)
  message(FATAL_ERROR
    "Cannot locate the hal_espressif module, so the C5 PSRAM fix cannot be "
    "applied. Set ZEPHYR_BASE to the zephyr checkout inside your west "
    "workspace, or make sure `west` is on PATH.")
endif()
linkr_apply_patch("${LINKR_HAL_ESPRESSIF_DIR}"
  patches/zephyr/0001-esp32c5-allow-bss-seg-external-memory.patch)

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
  src/ext_ram.c
  src/serial_session.c
  src/ble_peers.c
  src/target_binding.c
  src/bond_manager.c
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
