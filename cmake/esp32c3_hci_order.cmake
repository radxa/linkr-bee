# Keep the external Zephyr checkout untouched. Replace only the C3 driver's
# common receive callback before the controller starts; fail configuration if
# upstream changes the open path.
set(driver "${ZEPHYR_BASE}/drivers/bluetooth/hci/hci_esp32.c")
file(READ "${driver}" driver_source)
set(needle "static int bt_esp32_open(const struct device *dev)\n{\n\tint err;")
string(FIND "${driver_source}" "${needle}" assignment)
if(assignment EQUAL -1)
  message(FATAL_ERROR "Review C3 HCI ordering shim: upstream callback changed")
endif()
string(REPLACE "${needle}"
  "${needle}\n\tstruct bt_hci_driver_data *hci = dev->data;\n\n\thci->recv = linkr_hci_order_init(hci->recv);"
  driver_source "${driver_source}")
set(patched "${CMAKE_CURRENT_BINARY_DIR}/hci_esp32_ordered.c")
file(WRITE "${patched}" "#include \"ble_hci_order.h\"\n${driver_source}")
get_target_property(driver_sources drivers__bluetooth SOURCES)
list(FILTER driver_sources EXCLUDE REGEX "(^|/)hci_esp32\\.c$")
set_property(TARGET drivers__bluetooth PROPERTY SOURCES "${driver_sources}")
target_sources(drivers__bluetooth PRIVATE "${patched}")
target_include_directories(drivers__bluetooth PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_sources(app PRIVATE src/ble_hci_order.c)
