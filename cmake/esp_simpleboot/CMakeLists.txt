# SPDX-License-Identifier: Apache-2.0
if(NOT CONFIG_ESP_SIMPLE_BOOT OR CONFIG_MCUBOOT OR CONFIG_BOOTLOADER_MCUBOOT
   OR NOT CONFIG_BUILD_OUTPUT_BIN)
  return()
endif()

get_filename_component(linkr_root "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
set(formatter "${linkr_root}/tools/esp_simpleboot_image.py")
set(loader "${ZEPHYR_BASE}/soc/espressif/common/loader.c")
file(READ "${loader}" loader_source)
# v4.5.0 skips the RAM checksum but assumes no digest precedes the hidden
# segments. Fail closed if upstream changes that traversal.
set(needle "\t\t\toffset += (CHECKSUM_ALIGN - 1) - (offset % CHECKSUM_ALIGN) + 1;\n\t\t\tchecksum = true;")
string(FIND "${loader_source}" "${needle}" location)
if(location EQUAL -1 OR loader_source MATCHES "bootloader_image_hdr.hash_appended")
  message(FATAL_ERROR "Review Linkr simple-boot loader shim: upstream parsing changed")
endif()
string(REPLACE "${needle}"
  "\t\t\toffset += (CHECKSUM_ALIGN - 1) - (offset % CHECKSUM_ALIGN) + 1;\n\t\t\tif (bootloader_image_hdr.hash_appended) {\n\t\t\t\toffset += 32;\n\t\t\t}\n\t\t\tchecksum = true;"
  loader_source "${loader_source}")
# Retain the upstream object basename for early-boot/linker compatibility.
set(patched "${CMAKE_CURRENT_BINARY_DIR}/loader.c")
file(WRITE "${patched}" "${loader_source}")
get_target_property(zephyr_sources zephyr SOURCES)
set(loader_sources "${zephyr_sources}")
list(FILTER loader_sources INCLUDE REGEX "(^|/)loader\\.c$")
list(LENGTH loader_sources loader_count)
if(NOT loader_count EQUAL 1)
  message(FATAL_ERROR "Expected exactly one Espressif simple-boot loader")
endif()
list(FILTER zephyr_sources EXCLUDE REGEX "(^|/)loader\\.c$")
set_property(TARGET zephyr PROPERTY SOURCES "${zephyr_sources}")
target_sources(zephyr PRIVATE "${patched}")
set_source_files_properties("${patched}" TARGET_DIRECTORY zephyr
  PROPERTIES OBJECT_DEPENDS "${formatter}")

# The SoC has already registered elf2image; this runs immediately afterwards.
set_property(GLOBAL APPEND PROPERTY extra_post_build_commands
  COMMAND "${PYTHON_EXECUTABLE}" "${formatter}"
          "${CMAKE_BINARY_DIR}/zephyr/${KERNEL_BIN_NAME}")
