/*
 * Linkr Bee UART bridge.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include "bond_manager.h"
#include <errno.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gap.h>
#include <zephyr/bluetooth/gatt.h>
#include "ble_nus.h"
#include "ble_security.h"
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/ring_buffer.h>
#if IS_ENABLED(CONFIG_SYS_HEAP_RUNTIME_STATS)
#include <zephyr/sys/sys_heap.h>
#endif
#include <zephyr/version.h>

#include "serial_session.h"
#include "ble_peers.h"
#include "target_binding.h"
#include "ble_mgmt.h"
#include "ble_uart_reliable.h"
#include "ext_ram.h"
#include "wifi.h"
#include "uart_autobaud.h"
#include "uart_bulk_tx.h"
#include "ws_bridge.h"
#include "watchdog.h"
#include "linkr_aux.h"
#include "linkr_status_led.h"

LOG_MODULE_REGISTER(linkr_ble_bridge, LOG_LEVEL_INF);

#if DT_HAS_CHOSEN(zephyr_linkr_ble_uart)
#define LINKR_UART_NODE DT_CHOSEN(zephyr_linkr_ble_uart)
#elif DT_HAS_CHOSEN(zephyr_shell_uart)
#define LINKR_UART_NODE DT_CHOSEN(zephyr_shell_uart)
#else
#define LINKR_UART_NODE DT_CHOSEN(zephyr_console)
#endif

#define DEVICE_NAME CONFIG_BT_DEVICE_NAME
#define DEVICE_NAME_LEN (sizeof(DEVICE_NAME) - 1)
#define BLE_TO_UART_MAX_LEN 244
#define UART_RX_CHUNK CONFIG_LINKR_BLE_BRIDGE_UART_RX_CHUNK
#define UART_RX_BUFFER_SIZE CONFIG_LINKR_BLE_BRIDGE_UART_RX_BUFFER_SIZE

#define CONTROL_CMD_PREFIX "@linkr "
#define CONTROL_CMD_MAX_LEN (LINKR_MGMT_MAX_PAYLOAD + 1)
#define FACTORY_RESET_CONFIRM_MS 2000
#define FACTORY_RESET_SAMPLE_MS 100

#if DT_HAS_ALIAS(linkr_factory_reset)
#define FACTORY_RESET_NODE DT_ALIAS(linkr_factory_reset)
#endif

BUILD_ASSERT(UART_RX_CHUNK <= BLE_TO_UART_MAX_LEN);
BUILD_ASSERT(UART_RX_CHUNK <= UART_RX_BUFFER_SIZE);
BUILD_ASSERT(CONFIG_BT_ID_MAX >= 2,
	     "Linkr requires a persistent non-default BLE identity");
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY) && \
	IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_ECHO)
#error "UART loopback verify must not be combined with UART echo test"
#endif

struct bridge_packet {
	uint32_t ticket;
	uint16_t len;
	uint8_t data[BLE_TO_UART_MAX_LEN];
};

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_UART_DATA_BITS_5)
#define DEFAULT_UART_DATA_BITS UART_CFG_DATA_BITS_5
#elif IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_UART_DATA_BITS_6)
#define DEFAULT_UART_DATA_BITS UART_CFG_DATA_BITS_6
#elif IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_UART_DATA_BITS_7)
#define DEFAULT_UART_DATA_BITS UART_CFG_DATA_BITS_7
#else
#define DEFAULT_UART_DATA_BITS UART_CFG_DATA_BITS_8
#endif

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_UART_PARITY_ODD)
#define DEFAULT_UART_PARITY UART_CFG_PARITY_ODD
#elif IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_UART_PARITY_EVEN)
#define DEFAULT_UART_PARITY UART_CFG_PARITY_EVEN
#else
#define DEFAULT_UART_PARITY UART_CFG_PARITY_NONE
#endif

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_UART_STOP_BITS_2)
#define DEFAULT_UART_STOP_BITS UART_CFG_STOP_BITS_2
#else
#define DEFAULT_UART_STOP_BITS UART_CFG_STOP_BITS_1
#endif

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_UART_FLOW_CONTROL_RTS_CTS)
#define DEFAULT_UART_FLOW_CONTROL UART_CFG_FLOW_CTRL_RTS_CTS
#else
#define DEFAULT_UART_FLOW_CONTROL UART_CFG_FLOW_CTRL_NONE
#endif

static const struct device *const bridge_uart = DEVICE_DT_GET(LINKR_UART_NODE);
#if defined(FACTORY_RESET_NODE)
static const struct gpio_dt_spec factory_reset_gpio =
	GPIO_DT_SPEC_GET(FACTORY_RESET_NODE, gpios);
#endif
#if LINKR_UART_AUTOBAUD && DT_HAS_ALIAS(linkr_autobaud)
static const struct gpio_dt_spec autobaud_button =
	GPIO_DT_SPEC_GET(DT_ALIAS(linkr_autobaud), gpios);
static struct gpio_callback autobaud_button_cb;
static uint32_t autobaud_button_last_ms;
#endif
static struct bt_conn *wifi_operation_conn;
static struct bt_conn *wifi_scan_conn;
#if LINKR_UART_AUTOBAUD
static struct bt_conn *autobaud_conn;
#endif
static atomic_t ble_connection_count;
static struct k_mutex conn_lock;
static struct k_mutex uart_config_lock;
static struct k_work_delayable advertise_work;
static atomic_t advertise_refresh_req;
static uint8_t linkr_identity = BT_ID_DEFAULT;
static atomic_t wifi_scan_request_id;
#if LINKR_UART_AUTOBAUD
/* Request ID of the Management command that started the current autobaud
 * pass, or 0 for a pass started by the GPIO key. */
static atomic_t autobaud_request_id;
#endif
/* NUS receive callbacks run serially on the Bluetooth workqueue.  Keep the
 * command scratch buffer out of that workqueue's small thread stack: placing
 * it in handle_control_command_complete() consumed more than half of the
 * stack on every terminal keystroke. Only thread context touches it, so it can
 * live in PSRAM. */
static char control_command_data[CONTROL_CMD_MAX_LEN] LINKR_EXT_RAM_BSS;
static struct {
	bool active;
	uint32_t epoch;
	bool overflow;
	struct bt_conn *conn;
	uint32_t request_id;
	size_t len;
	bool release_wifi_operation;
	bool start_wifi_scan;
	/* The immediate response is only an acknowledgement; a final
	 * Management event follows on the same request ID. */
	bool async_response;
	char data[LINKR_MGMT_MAX_PAYLOAD];
} mgmt_capture LINKR_EXT_RAM_BSS;
#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
static atomic_t uart_rx_dropped;
static atomic_t uart_reliable_drop_no_conn;
#endif
/* Bytes linkr_uart_write() refused because ble_to_uart_queue was full.
 * Reported as "@info queue dropped=": the third drop point in
 * docs/BRIDGE_QUEUE_FINDINGS.md had no counter at all, and its only report
 * was a LOG_WRN that the board's ERR-only log level swallowed, so upstream
 * loss was completely unobservable on this board. */
static atomic_t uart_queue_dropped;
static struct uart_config active_uart_config = {
	.baudrate = CONFIG_LINKR_BLE_BRIDGE_UART_BAUD_RATE,
	.parity = DEFAULT_UART_PARITY,
	.stop_bits = DEFAULT_UART_STOP_BITS,
	.data_bits = DEFAULT_UART_DATA_BITS,
	.flow_ctrl = DEFAULT_UART_FLOW_CONTROL,
};

/* Queue backing store in .bss instead of __noinit. K_MSGQ_DEFINE puts it in
 * __noinit, which the ESP32 linker script maps to dram1_0_seg — the output
 * section is *named* .dram0.noinit, but the map links it at 0x3ffe8000, i.e.
 * inside the 98304 B dram1_0_seg; .bss lands in dram0_0_seg
 * (0x3ffbdb5c/0x224a4), the roomier of the two at the time of the change
 * (27896 B free against 9252 B — both measured on the 90285d5 build of this
 * same board). This is an exact expansion of K_MSGQ_DEFINE (same
 * STRUCT_SECTION_ITERABLE entry, same static initializer, same alignment)
 * with only the buffer's placement changed: contents never need to survive
 * reset.
 *
 * On the PSRAM build the store moves out of DRAM entirely: both the producers
 * (GATT/WebSocket receive callbacks) and the single consumer (the UART worker
 * thread) run in thread context, and the kernel copies queue elements under
 * its own spinlock, so the slower memory costs nothing but bytes. */
static uint8_t __aligned(4)
	ble_to_uart_storage[sizeof(struct bridge_packet) *
			    CONFIG_LINKR_BLE_BRIDGE_BLE_TO_UART_QUEUE_DEPTH]
		LINKR_EXT_RAM_BSS;
STRUCT_SECTION_ITERABLE(k_msgq, ble_to_uart_queue) =
	Z_MSGQ_INITIALIZER(ble_to_uart_queue, ble_to_uart_storage,
			   sizeof(struct bridge_packet),
			   CONFIG_LINKR_BLE_BRIDGE_BLE_TO_UART_QUEUE_DEPTH);
K_MUTEX_DEFINE(ble_to_uart_queue_lock);
K_SEM_DEFINE(bridge_start_sem, 0, 5);
/* Same relocation as ble_to_uart_storage above: RING_BUF_DECLARE declares the
 * byte array as __noinit (dram1), this keeps every field of the initializer
 * but places the array in .bss (dram0).
 *
 * This one stays in DRAM even on the PSRAM build: it is written from the UART
 * interrupt handler, where a QSPI round trip per byte is unacceptable. */
static uint8_t uart_rx_storage[UART_RX_BUFFER_SIZE];
struct ring_buf uart_rx_ring =
	RING_BUF_INIT(uart_rx_storage, UART_RX_BUFFER_SIZE);
K_SEM_DEFINE(uart_rx_sem, 0, 1);

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY) || \
	IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
K_MUTEX_DEFINE(test_marker_lock);

static int write_test_marker(const void *data, size_t len, const char *name)
{
	const struct flash_area *area;
	int err;

	err = flash_area_open(PARTITION_ID(linkr_test_marker_partition), &area);
	if (err) {
		LOG_ERR("%s marker open failed: %d", name, err);
		return err;
	}

	if (!flash_area_device_is_ready(area)) {
		LOG_ERR("%s marker flash area is not ready", name);
		err = -ENODEV;
		goto close_area;
	}
	if (len > area->fa_size) {
		LOG_ERR("%s marker is too large: %u > %u", name,
			(unsigned int)len, (unsigned int)area->fa_size);
		err = -EFBIG;
		goto close_area;
	}

	k_mutex_lock(&test_marker_lock, K_FOREVER);
	err = flash_area_erase(area, 0, area->fa_size);
	if (err) {
		LOG_ERR("%s marker erase failed: %d", name, err);
	} else {
		err = flash_area_write(area, 0, data, len);
		if (err) {
			LOG_ERR("%s marker write failed: %d", name, err);
		}
	}
	k_mutex_unlock(&test_marker_lock);

close_area:
	flash_area_close(area);
	return err;
}
#endif

#if defined(FACTORY_RESET_NODE)
/* GPIO0 is held high by the internal pull-up. A physical short to GND is
 * sampled at boot and must remain low for the full confirmation window. */
static bool factory_reset_requested(void)
{
	int value;
	int err;
	uint32_t elapsed_ms;

	if (!device_is_ready(factory_reset_gpio.port)) {
		LOG_ERR("Factory-reset GPIO device is not ready");
		return false;
	}

	err = gpio_pin_configure_dt(&factory_reset_gpio, GPIO_INPUT);
	if (err) {
		LOG_ERR("Factory-reset GPIO configuration failed: %d", err);
		return false;
	}

	/* Read the physical level here. The devicetree marks this input active-low,
	 * so gpio_pin_get_dt() would translate a released, pulled-up pin to logical
	 * 0 and make it look grounded. Raw reads keep low == 0 as documented below. */
	value = gpio_pin_get_raw(factory_reset_gpio.port, factory_reset_gpio.pin);
	if (value < 0) {
		LOG_ERR("Factory-reset GPIO read failed: %d", value);
		return false;
	}
	if (value != 0) {
		return false;
	}

	printk("Factory-reset GPIO%u is low; hold GND short for %u ms\n",
	       factory_reset_gpio.pin, FACTORY_RESET_CONFIRM_MS);
	for (elapsed_ms = 0; elapsed_ms < FACTORY_RESET_CONFIRM_MS;
	     elapsed_ms += FACTORY_RESET_SAMPLE_MS) {
		k_sleep(K_MSEC(FACTORY_RESET_SAMPLE_MS));
		value = gpio_pin_get_raw(factory_reset_gpio.port,
					 factory_reset_gpio.pin);
		if (value < 0) {
			LOG_ERR("Factory-reset GPIO read failed: %d", value);
			return false;
		}
		if (value != 0) {
			printk("Factory reset cancelled: GPIO%u released\n",
			       factory_reset_gpio.pin);
			return false;
		}
	}

	return true;
}

static int erase_factory_settings(void)
{
	const struct flash_area *area;
	int err;

	/* storage_partition is the settings/NVS area. Erase it before Bluetooth
	 * starts so no previous identity or Linkr configuration is loaded. */
	err = flash_area_open(PARTITION_ID(storage_partition), &area);
	if (err) {
		LOG_ERR("Factory-reset storage open failed: %d", err);
		return err;
	}
	if (!flash_area_device_is_ready(area)) {
		LOG_ERR("Factory-reset storage is not ready");
		err = -ENODEV;
		goto close_area;
	}

	LOG_WRN("Factory reset requested: erasing %u-byte settings/NVS area",
		(unsigned int)area->fa_size);
	printk("Factory reset: erasing settings/NVS and saved configuration\n");
	err = flash_area_erase(area, 0, area->fa_size);
	if (err) {
		LOG_ERR("Factory-reset storage erase failed: %d", err);
	} else {
		printk("Factory reset complete; BLE identity will be regenerated\n");
	}

close_area:
	flash_area_close(area);
	return err;
}
#endif

#if LINKR_UART_AUTOBAUD && DT_HAS_ALIAS(linkr_autobaud)
static void autobaud_button_isr(const struct device *port,
				struct gpio_callback *cb,
				gpio_port_pins_t pins)
{
	uint32_t now = k_uptime_get_32();

	ARG_UNUSED(port);
	ARG_UNUSED(cb);
	ARG_UNUSED(pins);

	/* Human-scale debounce. A press is a falling edge into the active-low
	 * input; a held key produces no further edges. */
	if (autobaud_button_last_ms != 0 &&
	    (int32_t)(now - autobaud_button_last_ms) < 250) {
		return;
	}
	autobaud_button_last_ms = now;
	(void)linkr_uart_autobaud_request();
}
#endif

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
struct ble_diag_marker {
	char magic[8];
	uint32_t connected_count;
	uint32_t disconnected_count;
	uint32_t notify_enabled;
	uint32_t notify_events;
	uint32_t rx_count;
	uint32_t last_rx_len;
	uint32_t echo_ok_count;
	uint32_t echo_err_count;
	int32_t last_echo_err;
	uint32_t notify_ever_enabled;
	uint32_t active_notify_ok_count;
	uint32_t active_notify_err_count;
	int32_t last_active_notify_err;
};

static struct ble_diag_marker ble_diag = {
	.magic = "LBRDIAG",
};
K_SEM_DEFINE(ble_diag_write_sem, 0, 1);

static void schedule_ble_diag_marker_write(void)
{
	k_sem_give(&ble_diag_write_sem);
}

static void ble_diag_marker_thread(void)
{
	int err;

	for (;;) {
		k_sem_take(&ble_diag_write_sem, K_FOREVER);

		err = write_test_marker(&ble_diag, sizeof(ble_diag), "BLE diag");
		if (err) {
			LOG_WRN("BLE diag marker update failed: %d", err);
		}
	}
}
#endif

static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_LINKR_MGMT_SERVICE_VAL),
};

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_BLE_NAME_FROM_MAC)
/*
 * The advertised name is dynamic on every board. The default suffix is the
 * last four hex digits of the factory hardware MAC, while @n can replace the
 * whole string with a persisted custom name. The name is deliberately not
 * CONFIG_BT_DEVICE_NAME: that string is the same on every board built from
 * this tree, which makes two units side by side indistinguishable in a scan
 * list.
 *
 * A complete legacy-advertising name has at most 29 UTF-8 bytes: the scan
 * response payload is 31 bytes and the AD length/type octets take two.
 */
#define BLE_NAME_MAX 29
#define BLE_NAME_SETTINGS_KEY "linkr/ble/name"
BUILD_ASSERT(CONFIG_BT_DEVICE_NAME_MAX >= BLE_NAME_MAX,
	     "BT_DEVICE_NAME_MAX must fit a complete legacy advertised name");
static char ble_name[BLE_NAME_MAX + 1];
static bool ble_name_custom;
static struct bt_data sd[] = {
	BT_DATA(BT_DATA_NAME_COMPLETE, ble_name, 0),
};
#define ADVERTISED_NAME ble_name

static bool ble_name_valid(const char *name, size_t len)
{
	size_t i = 0;

	if (len == 0 || len > BLE_NAME_MAX) {
		return false;
	}

	while (i < len) {
		uint8_t c = (uint8_t)name[i];
		uint32_t cp;
		size_t extra;

		/* Reject C0/C1 controls, DEL, and embedded NUL bytes. */
		if (c < 0x20 || c == 0x7f) {
			return false;
		}
		if (c < 0x80) {
			i++;
			continue;
		}

		if ((c & 0xe0) == 0xc0) {
			extra = 1;
			cp = c & 0x1f;
		} else if ((c & 0xf0) == 0xe0) {
			extra = 2;
			cp = c & 0x0f;
		} else if ((c & 0xf8) == 0xf0) {
			extra = 3;
			cp = c & 0x07;
		} else {
			return false;
		}
		if (i + extra >= len) {
			return false;
		}
		for (size_t j = 1; j <= extra; j++) {
			uint8_t continuation = (uint8_t)name[i + j];

			if ((continuation & 0xc0) != 0x80) {
				return false;
			}
			cp = (cp << 6) | (continuation & 0x3f);
		}

		/* Overlongs, surrogates, out-of-range code points, and the
		 * UTF-8-encoded C1 controls are not displayable names. */
		if ((extra == 1 && cp < 0x80) ||
		    (extra == 2 && cp < 0x800) ||
		    (extra == 3 && (cp < 0x10000 || cp > 0x10ffff)) ||
		    (cp >= 0xd800 && cp <= 0xdfff) ||
		    (cp >= 0x80 && cp <= 0x9f) ||
		    cp == 0x2028 || cp == 0x2029) {
			return false;
		}
		i += extra + 1;
	}

	return true;
}

static void ble_name_make_default(void)
{
	uint8_t hardware_id[6];
	ssize_t len;

	/* The suffix comes from the factory hardware ID, not from the BLE
	 * identity: the latter is deliberately random and stored in settings,
	 * so using it would make the name change with a factory reset and would
	 * not match the MAC printed on the board. */
	len = hwinfo_get_device_id(hardware_id, sizeof(hardware_id));
	if (len == sizeof(hardware_id)) {
		snprintk(ble_name, sizeof(ble_name), "Linkr Bee %02X%02X",
			 hardware_id[4], hardware_id[5]);
	} else {
		bt_addr_le_t addrs[CONFIG_BT_ID_MAX];
		size_t count = ARRAY_SIZE(addrs);

		bt_id_get(addrs, &count);
		if (count > 0 && !bt_addr_le_eq(&addrs[0], BT_ADDR_LE_ANY)) {
			/* Last resort for a controller without a hardware ID.
			 * bt_addr_t is little-endian, so the last two octets
			 * are printed in MAC order. */
			const uint8_t *addr = addrs[0].a.val;

			snprintk(ble_name, sizeof(ble_name),
				 "Linkr Bee %02X%02X", addr[1], addr[0]);
		} else {
			snprintk(ble_name, sizeof(ble_name), "Linkr Bee");
			LOG_WRN("BLE name: hardware address unavailable");
		}
	}
	ble_name_custom = false;
}

static int ble_name_apply(const char *name)
{
	size_t len = strlen(name);
	int err;

	if (!ble_name_valid(name, len)) {
		return -EINVAL;
	}
	err = bt_set_name(name);
	if (err) {
		return err;
	}
	memcpy(ble_name, name, len + 1);
	sd[0].data_len = (uint8_t)len;
	return 0;
}

static int ble_name_settings_set(const char *name, size_t len,
				 settings_read_cb read_cb, void *cb_arg)
{
	const char *next;
	ssize_t read;

	if (!settings_name_steq(name, "name", &next) || (next && *next)) {
		return -ENOENT;
	}
	if (len == 0 || len > BLE_NAME_MAX) {
		LOG_WRN("Ignoring invalid stored BLE name length %u",
			(unsigned int)len);
		return 0;
	}
	read = read_cb(cb_arg, ble_name, len);
	if (read != (ssize_t)len) {
		LOG_WRN("Ignoring unreadable stored BLE name: %d", (int)read);
		return 0;
	}
	ble_name[len] = '\0';
	if (!ble_name_valid(ble_name, len)) {
		LOG_WRN("Ignoring invalid stored BLE name");
		return 0;
	}
	ble_name_custom = true;
	return 0;
}

enum ble_name_persist_result {
	BLE_NAME_PERSIST_OK = 0,
	BLE_NAME_PERSIST_INSTALL_FAILED,
	BLE_NAME_PERSIST_SAVE_FAILED,
};

static enum ble_name_persist_result
ble_name_install_and_save(const char *value, size_t len, int *err)
{
	char previous[BLE_NAME_MAX + 1];
	bool previous_custom = ble_name_custom;
	size_t previous_len = strlen(ble_name);
	int ret;

	memcpy(previous, ble_name, previous_len + 1);
	/* Install first, then persist. A stored name that the stack refused
	 * would answer @n? with the old one and come back as the new one after
	 * a reboot. */
	ret = ble_name_apply(value);
	if (ret) {
		*err = ret;
		return BLE_NAME_PERSIST_INSTALL_FAILED;
	}
	ret = settings_save_one(BLE_NAME_SETTINGS_KEY, value, len);
	if (ret) {
		(void)ble_name_apply(previous);
		ble_name_custom = previous_custom;
		*err = ret;
		return BLE_NAME_PERSIST_SAVE_FAILED;
	}
	ble_name_custom = true;
	return BLE_NAME_PERSIST_OK;
}

static enum ble_name_persist_result
ble_name_reset_and_delete(int *err)
{
	char previous[BLE_NAME_MAX + 1];
	bool previous_custom = ble_name_custom;
	uint8_t previous_sd_len = sd[0].data_len;
	size_t previous_len = strlen(ble_name);
	int ret;

	memcpy(previous, ble_name, previous_len + 1);
	ble_name_make_default();
	/* The scan response length follows the buffer here, before the name
	 * is handed to the stack: a failure below must not leave the old
	 * length beside the new bytes, which would advertise a truncated
	 * name. */
	sd[0].data_len = (uint8_t)strlen(ble_name);
	ret = bt_set_name(ble_name);
	if (ret) {
		memcpy(ble_name, previous, previous_len + 1);
		sd[0].data_len = previous_sd_len;
		ble_name_custom = previous_custom;
		*err = ret;
		return BLE_NAME_PERSIST_INSTALL_FAILED;
	}
	/* Persist only after the name is in effect: deleting the stored name
	 * while the install fails would make @n? report one name and the next
	 * boot another. */
	ret = settings_delete(BLE_NAME_SETTINGS_KEY);
	if (ret && ret != -ENOENT) {
		(void)bt_set_name(previous);
		memcpy(ble_name, previous, previous_len + 1);
		sd[0].data_len = previous_sd_len;
		ble_name_custom = previous_custom;
		*err = ret;
		return BLE_NAME_PERSIST_SAVE_FAILED;
	}
	return BLE_NAME_PERSIST_OK;
}

enum ble_name_command {
	BLE_NAME_COMMAND_NONE = 0,
	BLE_NAME_COMMAND_QUERY,
	BLE_NAME_COMMAND_RESET,
	BLE_NAME_COMMAND_SET,
};

/* Classify an @n / @linkr name request.  Kept separate from the handler so
 * the spelling rules (`@n default` vs `@n=default` vs `@n  default`) are
 * testable without a Bluetooth stack. */
static enum ble_name_command ble_name_parse_command(const char *body,
						    const char **value)
{
	if (!body) {
		return BLE_NAME_COMMAND_NONE;
	}
	if (!strcmp(body, "name?") || !strcmp(body, "n?") ||
	    !strcmp(body, "name") || !strcmp(body, "n")) {
		return BLE_NAME_COMMAND_QUERY;
	}
	if (!strcmp(body, "name default") || !strcmp(body, "n default")) {
		return BLE_NAME_COMMAND_RESET;
	}
	if (!value) {
		return BLE_NAME_COMMAND_NONE;
	}
	if (!strncmp(body, "name=", 5)) {
		*value = body + 5;
		return BLE_NAME_COMMAND_SET;
	}
	if (!strncmp(body, "n=", 2)) {
		*value = body + 2;
		return BLE_NAME_COMMAND_SET;
	}
	if (!strncmp(body, "name ", 5)) {
		*value = body + 5;
		return BLE_NAME_COMMAND_SET;
	}
	if (!strncmp(body, "n ", 2)) {
		*value = body + 2;
		return BLE_NAME_COMMAND_SET;
	}
	return BLE_NAME_COMMAND_NONE;
}

SETTINGS_STATIC_HANDLER_DEFINE(linkr_ble, "linkr/ble", NULL,
			       ble_name_settings_set, NULL, NULL);
#else
static const struct bt_data sd[] = {
	BT_DATA(BT_DATA_NAME_COMPLETE, DEVICE_NAME, DEVICE_NAME_LEN),
};
#define ADVERTISED_NAME DEVICE_NAME
#endif

/* Use a settings-backed random-static identity instead of the controller's
 * fixed public address. Erasing settings therefore gives a factory-reset unit
 * a new address, preventing hosts from reusing stale CoreBluetooth metadata. */
static int linkr_identity_init(void)
{
	bt_addr_le_t addrs[CONFIG_BT_ID_MAX];
	size_t count = ARRAY_SIZE(addrs);
	char addr_str[BT_ADDR_LE_STR_LEN];
	int id = -ENOENT;

	bt_id_get(addrs, &count);
	for (size_t i = 1; i < count; i++) {
		if (!bt_addr_le_eq(&addrs[i], BT_ADDR_LE_ANY)) {
			id = (int)i;
			break;
		}
	}

	if (id < 0) {
		if (count > 1 && bt_addr_le_eq(&addrs[1], BT_ADDR_LE_ANY)) {
			id = bt_id_reset(1, NULL, NULL);
		} else {
			id = bt_id_create(NULL, NULL);
		}
		if (id < 0) {
			LOG_ERR("Persistent BLE identity creation failed: %d", id);
			return id;
		}
	}

	linkr_identity = (uint8_t)id;
	count = ARRAY_SIZE(addrs);
	bt_id_get(addrs, &count);
	if (linkr_identity >= count ||
	    bt_addr_le_eq(&addrs[linkr_identity], BT_ADDR_LE_ANY)) {
		LOG_ERR("BLE identity %u is unavailable", linkr_identity);
		return -ENOENT;
	}

	bt_addr_le_to_str(&addrs[linkr_identity], addr_str, sizeof(addr_str));
	LOG_INF("BLE identity %u: %s", linkr_identity, addr_str);
	return 0;
}

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_BLE_NAME_FROM_MAC)
static int linkr_ble_name_init(void)
{
	int err;

	if (!ble_name_custom) {
		ble_name_make_default();
	}

	sd[0].data_len = (uint8_t)strlen(ble_name);
	err = bt_set_name(ble_name);
	if (err) {
		/* The scan response still carries the name; the GATT Device Name
		 * characteristic would just be stale. */
		LOG_WRN("BLE Device Name characteristic update failed: %d", err);
	}
	LOG_INF("BLE name: %s%s", ble_name, ble_name_custom ? " (custom)" : "");
	return 0;
}
#else
static int linkr_ble_name_init(void)
{
	return 0;
}
#endif

/*
 * The status LED moved into linkr_status_led.c so that boards with an
 * addressable RGB LED (Linkr Bee X1.0) and boards with a plain GPIO LED share
 * one call site. Activity stays a short flash; the RGB backend decides what
 * colour the flash uses.
 */
static void signal_uart_activity(void)
{
	linkr_status_led_activity();
}

#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
static void uart_rx_irq_callback(const struct device *dev, void *user_data)
{
	uint8_t buf[64];

	ARG_UNUSED(user_data);

	while (uart_irq_update(dev) && uart_irq_rx_ready(dev)) {
		int rx_len = uart_fifo_read(dev, buf, sizeof(buf));

		if (rx_len <= 0) {
			continue;
		}

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_ECHO)
		for (int i = 0; i < rx_len; i++) {
			uart_poll_out(dev, buf[i]);
		}
#endif

		uint32_t written = ring_buf_put(&uart_rx_ring, buf, rx_len);

		if (written < (uint32_t)rx_len) {
			atomic_add(&uart_rx_dropped, rx_len - written);
		}

		k_sem_give(&uart_rx_sem);
	}
}
#endif

static void uart_rx_irq_enable(void)
{
#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	uart_irq_rx_enable(bridge_uart);
#endif
}

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
static void indicate_loopback_result(bool ok)
{
	if (ok) {
		signal_uart_activity();
		return;
	}

	linkr_status_led_blink(3, 80);
}
#endif

static int advertise_start(void)
{
	struct bt_le_adv_param params = *BT_LE_ADV_CONN_FAST_1;
	int err;

	if (atomic_get(&ble_connection_count) >= CONFIG_BT_MAX_CONN) return 0;
	params.id = linkr_identity;
	params.options |= BT_LE_ADV_OPT_USE_IDENTITY;
	err = bt_le_adv_start(&params, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));

	if (err && err != -EALREADY) {
		LOG_ERR("BLE advertising failed: %d", err);
		return err;
	}

	LOG_INF("BLE advertising as \"%s\"", ADVERTISED_NAME);
	return 0;
}

static void advertise_retry(struct k_work *work)
{
	int err;

	ARG_UNUSED(work);

	if (atomic_cas(&advertise_refresh_req, 1, 0)) {
		err = bt_le_adv_stop();
		if (err && err != -EINVAL && err != -EALREADY) {
			LOG_WRN("BLE advertising stop failed: %d", err);
			/* The old scan response is still on the air.
			 * Leaving it there would advertise a name the board
			 * no longer answers to, so ask for another try. */
			atomic_set(&advertise_refresh_req, 1);
			k_work_reschedule(&advertise_work, K_MSEC(500));
			return;
		}
	}

	err = advertise_start();
	if (err && err != -EALREADY) {
		k_work_reschedule(&advertise_work, K_MSEC(500));
	}
}

static void advertise_schedule(k_timeout_t delay)
{
	k_work_reschedule(&advertise_work, delay);
}

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_BLE_NAME_FROM_MAC)
/* The scan response is copied into the controller when advertising starts, so
 * a board that was renamed keeps broadcasting its old name until the
 * advertising is started again. The name a scanner shows is the only place a
 * user can tell two boards apart at a glance, and a board that answers to one
 * name on the air and another over the management channel is worse than one
 * that was never renamed: the user cannot tell which board they are holding.
 *
 * Stopping and starting the advertising does not touch the connection — Zephyr
 * keeps a connected link up while the advertising is cycled — and the new
 * scan response carries the name the rename just installed.
 */
static void ble_name_advertise_refresh(void)
{
	/* Serialized with the advertising work. The refresh happens on the
	 * BT RX workqueue while advertise_work runs on the system one, and
	 * both touch the legacy advertising API; a request flag keeps the
	 * stop/start pair in one place. */
	atomic_set(&advertise_refresh_req, 1);
	advertise_schedule(K_NO_WAIT);
}
#endif

static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		LOG_WRN("BLE connection failed: 0x%02x", err);
		return;
	}

	linkr_uart_reliable_connected(conn);
	if (linkr_ble_peer_connected(conn)) {
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_CONN_LIMIT_EXCEEDED);
		return;
	}
	atomic_inc(&ble_connection_count);
	linkr_mgmt_connected(conn);
	advertise_schedule(K_MSEC(100));

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
	ble_diag.connected_count++;
	schedule_ble_diag_marker_write();
#endif
	LOG_INF("BLE connected; requesting encryption");
	linkr_ble_security_connected(conn);
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	if (linkr_ble_peer_disconnected(conn)) atomic_dec(&ble_connection_count);
	k_mutex_lock(&conn_lock, K_FOREVER);
	if (wifi_operation_conn == conn) {
		bt_conn_unref(wifi_operation_conn);
		wifi_operation_conn = NULL;
	}
	if (wifi_scan_conn == conn) {
		bt_conn_unref(wifi_scan_conn);
		wifi_scan_conn = NULL;
		atomic_clear(&wifi_scan_request_id);
		linkr_wifi_scan_abort();
	}
#if LINKR_UART_AUTOBAUD
	if (autobaud_conn == conn) {
		bt_conn_unref(autobaud_conn);
		autobaud_conn = NULL;
		atomic_clear(&autobaud_request_id);
	}
#endif
	k_mutex_unlock(&conn_lock);
	linkr_mgmt_disconnected(conn);
	linkr_uart_reliable_disconnected(conn);

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
	ble_diag.disconnected_count++;
	schedule_ble_diag_marker_write();
#endif
	LOG_INF("BLE disconnected: 0x%02x", reason);
	/* Persistent advertising normally resumes automatically. Scheduling an
	 * explicit start is harmless when it already resumed (-EALREADY), and also
	 * recovers from controller-side disconnect edge cases. */
	advertise_schedule(K_MSEC(100));
}

static void recycled(void)
{
	/* Also recover explicitly after failed-to-establish connections. */
	advertise_schedule(K_NO_WAIT);
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = connected,
	.disconnected = disconnected,
	.recycled = recycled,
};

static void att_mtu_updated(struct bt_conn *conn, uint16_t tx, uint16_t rx)
{
	ARG_UNUSED(conn);
	LOG_INF("BLE ATT MTU updated: tx=%u rx=%u", tx, rx);
}

static struct bt_gatt_cb gatt_callbacks = {
	.att_mtu_updated = att_mtu_updated,
};

static void nus_notif_enabled(bool enabled, void *ctx)
{
	ARG_UNUSED(ctx);

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
	ble_diag.notify_enabled = enabled ? 1 : 0;
	ble_diag.notify_events++;
	if (enabled) {
		ble_diag.notify_ever_enabled = 1;
	}
	schedule_ble_diag_marker_write();
#endif
	LOG_INF("BLE UART notifications %s", enabled ? "enabled" : "disabled");
}

static const char *uart_data_bits_name(enum uart_config_data_bits data_bits)
{
	switch (data_bits) {
	case UART_CFG_DATA_BITS_5:
		return "5";
	case UART_CFG_DATA_BITS_6:
		return "6";
	case UART_CFG_DATA_BITS_7:
		return "7";
	case UART_CFG_DATA_BITS_8:
		return "8";
	default:
		return "?";
	}
}

static const char *uart_parity_name(enum uart_config_parity parity)
{
	switch (parity) {
	case UART_CFG_PARITY_NONE:
		return "N";
	case UART_CFG_PARITY_ODD:
		return "O";
	case UART_CFG_PARITY_EVEN:
		return "E";
	default:
		return "?";
	}
}

static const char *uart_stop_bits_name(enum uart_config_stop_bits stop_bits)
{
	switch (stop_bits) {
	case UART_CFG_STOP_BITS_1:
		return "1";
	case UART_CFG_STOP_BITS_2:
		return "2";
	default:
		return "?";
	}
}

static const char *uart_flow_ctrl_name(enum uart_config_flow_control flow_ctrl)
{
	switch (flow_ctrl) {
	case UART_CFG_FLOW_CTRL_NONE:
		return "none";
	case UART_CFG_FLOW_CTRL_RTS_CTS:
		return "rtscts";
	default:
		return "?";
	}
}

static int send_control_response(struct bt_conn *conn, const char *fmt, ...)
{
	va_list args;
	int len;

	if (mgmt_capture.active && mgmt_capture.conn == conn) {
		size_t available = sizeof(mgmt_capture.data) - mgmt_capture.len;

		if (available == 0) {
			mgmt_capture.overflow = true;
			return -EMSGSIZE;
		}
		va_start(args, fmt);
		len = vsnprintk(mgmt_capture.data + mgmt_capture.len,
				available, fmt, args);
		va_end(args);
		if (len < 0) {
			return len;
		}
		if ((size_t)len >= available) {
			mgmt_capture.len = sizeof(mgmt_capture.data) - 1;
			mgmt_capture.overflow = true;
			return -EMSGSIZE;
		}
		mgmt_capture.len += (size_t)len;
		return 0;
	}

	return -ENOTCONN;
}

static int uart_status_response(struct bt_conn *conn, const char *prefix)
{
	struct uart_config cfg;

	k_mutex_lock(&uart_config_lock, K_FOREVER);
	cfg = active_uart_config;
	k_mutex_unlock(&uart_config_lock);

	return send_control_response(conn, "%s uart=%u,%s,%s,%s,%s\r\n",
				     prefix, cfg.baudrate,
				     uart_data_bits_name(cfg.data_bits),
				     uart_parity_name(cfg.parity),
				     uart_stop_bits_name(cfg.stop_bits),
				     uart_flow_ctrl_name(cfg.flow_ctrl));
}

/* WiFi scan results are asynchronous Management Service events. */
static int wifi_scan_respond(struct bt_conn *conn, const char *line)
{
	char payload[96];
	uint32_t request_id = (uint32_t)atomic_get(&wifi_scan_request_id);
	int len = snprintk(payload, sizeof(payload), "%s\r\n", line);
	bool failed = strcmp(line, "@scan error") == 0;
	uint16_t flags = failed || strcmp(line, "@scan done") == 0 ?
			 LINKR_MGMT_FLAG_FINAL : 0;
	int err;

	if (failed) {
		flags |= LINKR_MGMT_FLAG_ERROR;
	}

	if (len <= 0) {
		return -EINVAL;
	}
	err = linkr_mgmt_event(conn, request_id, flags, payload,
			       MIN(len, (int)sizeof(payload) - 1));
	if (err) {
		LOG_WRN("WiFi scan event queue failed: %d", err);
		return err;
	}
	if (flags & LINKR_MGMT_FLAG_FINAL) {
		atomic_clear(&wifi_scan_request_id);
	}
	return 0;
}

static void wifi_state_event(uint32_t operation_id,
			     enum linkr_wifi_state state, int error)
{
	struct bt_conn *conn;
	char status[96];
	char payload[144];
	uint16_t flags = 0;
	int err;
	int len;

	k_mutex_lock(&conn_lock, K_FOREVER);
	conn = wifi_operation_conn ? bt_conn_ref(wifi_operation_conn) : NULL;
	k_mutex_unlock(&conn_lock);
	if (!conn) {
		return;
	}

	(void)linkr_wifi_diagnostics(status, sizeof(status));
	len = snprintk(payload, sizeof(payload),
			"@event wifi operation=%u phase=%s result=%d %s\r\n",
			operation_id, linkr_wifi_state_name(state), error, status);
	if (len > 0) {
		if (state == LINKR_WIFI_STATE_READY ||
		    state == LINKR_WIFI_STATE_FAILED ||
		    state == LINKR_WIFI_STATE_OFF) {
			flags |= LINKR_MGMT_FLAG_FINAL;
		}
		if (state == LINKR_WIFI_STATE_FAILED) {
			flags |= LINKR_MGMT_FLAG_ERROR;
		}
		err = linkr_mgmt_event(conn, operation_id, flags,
				       payload,
				       MIN(len, (int)sizeof(payload) - 1));
		if (err) {
			LOG_WRN("WiFi state event queue failed: %d", err);
		}
	}
	bt_conn_unref(conn);
}

#if LINKR_UART_AUTOBAUD
/*
 * Runs on the system workqueue when a pass ends. A command-started pass gets
 * a FINAL event on the request ID that started it; a GPIO-started pass has no
 * client and is only logged.
 */
static void autobaud_result_event(enum linkr_uart_autobaud_result result,
				  uint32_t old_baud, uint32_t new_baud)
{
	struct bt_conn *conn;
	uint32_t request_id = (uint32_t)atomic_get(&autobaud_request_id);
	const char *state;
	char payload[128];
	uint16_t flags = LINKR_MGMT_FLAG_FINAL;
	int err;
	int len;

	switch (result) {
	case LINKR_UART_AUTOBAUD_APPLIED:
		state = "applied";
		break;
	case LINKR_UART_AUTOBAUD_UNCHANGED:
		state = "unchanged";
		break;
	case LINKR_UART_AUTOBAUD_TIMEOUT:
		state = "timeout";
		break;
	case LINKR_UART_AUTOBAUD_STOPPED:
		state = "stopped";
		break;
	case LINKR_UART_AUTOBAUD_FAILED:
		state = "error";
		flags |= LINKR_MGMT_FLAG_ERROR;
		break;
	default:
		state = "error";
		flags |= LINKR_MGMT_FLAG_ERROR;
		break;
	}

	LOG_INF("UART autobaud result: %s (%u -> %u)", state, old_baud,
		new_baud);

	if (request_id == 0) {
		return; /* GPIO-triggered; nothing is waiting for an event */
	}
	atomic_set(&autobaud_request_id, 0);

	k_mutex_lock(&conn_lock, K_FOREVER);
	conn = autobaud_conn ? bt_conn_ref(autobaud_conn) : NULL;
	k_mutex_unlock(&conn_lock);
	if (!conn) {
		return;
	}

	len = snprintk(payload, sizeof(payload),
		       "@event autobaud state=%s old=%u new=%u\r\n", state,
		       old_baud, new_baud);
	if (len > 0) {
		err = linkr_mgmt_event(conn, request_id, flags, payload,
				       MIN(len, (int)sizeof(payload) - 1));
		if (err) {
			LOG_WRN("Autobaud event queue failed: %d", err);
		}
	}
	bt_conn_unref(conn);
}
#endif /* LINKR_UART_AUTOBAUD */

static char *trim_spaces(char *s)
{
	char *end;

	while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') {
		s++;
	}

	end = s + strlen(s);
	while (end > s && (end[-1] == ' ' || end[-1] == '\t' ||
			   end[-1] == '\r' || end[-1] == '\n')) {
		*--end = '\0';
	}

	return s;
}

static bool string_equal_ignore_case(const char *value, const char *expected)
{
	size_t expected_len = strlen(expected);

	return strlen(value) == expected_len &&
	       strncasecmp(value, expected, expected_len) == 0;
}

static int parse_uart_line(char *value, struct uart_config *cfg)
{
	char *saveptr;
	char *baud;
	char *data;
	char *parity;
	char *stop;
	char *flow;
	char *endptr;
	long baudrate;

	baud = strtok_r(value, ",", &saveptr);
	data = strtok_r(NULL, ",", &saveptr);
	parity = strtok_r(NULL, ",", &saveptr);
	stop = strtok_r(NULL, ",", &saveptr);
	flow = strtok_r(NULL, ",", &saveptr);

	if (!baud || !data || !parity || !stop || !flow) {
		return -EINVAL;
	}

	baud = trim_spaces(baud);
	data = trim_spaces(data);
	parity = trim_spaces(parity);
	stop = trim_spaces(stop);
	flow = trim_spaces(flow);

	baudrate = strtol(baud, &endptr, 10);
	if (*endptr || baudrate < 300 || baudrate > 3000000) {
		return -EINVAL;
	}
	cfg->baudrate = (uint32_t)baudrate;

	if (!strcmp(data, "5")) {
		cfg->data_bits = UART_CFG_DATA_BITS_5;
	} else if (!strcmp(data, "6")) {
		cfg->data_bits = UART_CFG_DATA_BITS_6;
	} else if (!strcmp(data, "7")) {
		cfg->data_bits = UART_CFG_DATA_BITS_7;
	} else if (!strcmp(data, "8")) {
		cfg->data_bits = UART_CFG_DATA_BITS_8;
	} else {
		return -EINVAL;
	}

	if (string_equal_ignore_case(parity, "n") ||
	    string_equal_ignore_case(parity, "none")) {
		cfg->parity = UART_CFG_PARITY_NONE;
	} else if (string_equal_ignore_case(parity, "o") ||
		   string_equal_ignore_case(parity, "odd")) {
		cfg->parity = UART_CFG_PARITY_ODD;
	} else if (string_equal_ignore_case(parity, "e") ||
		   string_equal_ignore_case(parity, "even")) {
		cfg->parity = UART_CFG_PARITY_EVEN;
	} else {
		return -EINVAL;
	}

	if (!strcmp(stop, "1")) {
		cfg->stop_bits = UART_CFG_STOP_BITS_1;
	} else if (!strcmp(stop, "2")) {
		cfg->stop_bits = UART_CFG_STOP_BITS_2;
	} else {
		return -EINVAL;
	}

	if (string_equal_ignore_case(flow, "n") ||
	    string_equal_ignore_case(flow, "none") ||
	    string_equal_ignore_case(flow, "off")) {
		cfg->flow_ctrl = UART_CFG_FLOW_CTRL_NONE;
	} else if (string_equal_ignore_case(flow, "rtscts") ||
		   string_equal_ignore_case(flow, "hw")) {
		cfg->flow_ctrl = UART_CFG_FLOW_CTRL_RTS_CTS;
	} else {
		return -EINVAL;
	}

	return 0;
}

static int apply_uart_config(const struct uart_config *cfg)
{
	int err;

	k_mutex_lock(&uart_config_lock, K_FOREVER);
#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	uart_irq_rx_disable(bridge_uart);
#endif
	err = uart_configure(bridge_uart, cfg);
	if (!err) {
		unsigned int key = irq_lock();

		active_uart_config = *cfg;
		/* Serialize the reset against uart_to_ble_thread, which reads the
		 * same ring under irq_lock(). Sharing only uart_config_lock would
		 * let a concurrent consumer tear head/tail mid-reset. */
		ring_buf_reset(&uart_rx_ring);
		irq_unlock(key);
	}
	/* uart_configure() may fail after RX was disabled; always restore it. */
	uart_rx_irq_enable();
	k_mutex_unlock(&uart_config_lock);

	return err;
}

#if LINKR_UART_AUTOBAUD
/*
 * uart_autobaud.c is a separate translation unit and must not reach into this
 * file's state. The configuration readers and reconfigure path below keep
 * access to the active port configuration under its owning mutex.
 */
uint32_t linkr_uart_config_current(void)
{
	uint32_t baudrate;

	/*
	 * Under the same lock that guards every other reader and the one
	 * writer. The struct is assigned as a whole in apply_uart_config()
	 * while the lock is held, and the autobaud tick runs on the system
	 * workqueue, so an unlocked read can land between the assignment's
	 * members and report a rate the port was never set to.
	 */
	k_mutex_lock(&uart_config_lock, K_FOREVER);
	baudrate = active_uart_config.baudrate;
	k_mutex_unlock(&uart_config_lock);

	return baudrate;
}

uint32_t linkr_uart_config_frame_half_bits(void)
{
	struct uart_config cfg;
	uint32_t data_bits, stop_half_bits;

	k_mutex_lock(&uart_config_lock, K_FOREVER);
	cfg = active_uart_config;
	k_mutex_unlock(&uart_config_lock);

	switch (cfg.data_bits) {
	case UART_CFG_DATA_BITS_5:
		data_bits = 5;
		break;
	case UART_CFG_DATA_BITS_6:
		data_bits = 6;
		break;
	case UART_CFG_DATA_BITS_7:
		data_bits = 7;
		break;
	case UART_CFG_DATA_BITS_8:
		data_bits = 8;
		break;
	default:
		data_bits = 9;
		break;
	}
	switch (cfg.stop_bits) {
	case UART_CFG_STOP_BITS_0_5:
		stop_half_bits = 1;
		break;
	case UART_CFG_STOP_BITS_1:
		stop_half_bits = 2;
		break;
	case UART_CFG_STOP_BITS_1_5:
		stop_half_bits = 3;
		break;
	default:
		stop_half_bits = 4;
		break;
	}

	return 2u * (1u + data_bits + (cfg.parity != UART_CFG_PARITY_NONE)) +
	       stop_half_bits;
}

int linkr_uart_config_reconfigure(uint32_t baudrate)
{
	struct uart_config cfg;

	k_mutex_lock(&uart_config_lock, K_FOREVER);
	cfg = active_uart_config;
	k_mutex_unlock(&uart_config_lock);
	cfg.baudrate = baudrate;

	return apply_uart_config(&cfg);
}
#endif /* LINKR_UART_AUTOBAUD */

/* Heap headroom. The system heap is the largest single RAM allocation here and
 * nothing reported it before, so its size could not be justified from real
 * numbers: "peak" is what decides whether HEAP_MEM_POOL_SIZE should grow.
 * Compiled only where CONFIG_SYS_HEAP_RUNTIME_STATS is enabled (ESP32 board).
 */
#if IS_ENABLED(CONFIG_SYS_HEAP_RUNTIME_STATS)
static void heap_status_response(struct bt_conn *conn)
{
	struct k_heap *heaps = NULL;
	struct sys_memory_stats stats;

	if (k_heap_array_get(&heaps) < 1 ||
	    sys_heap_runtime_stats_get(&heaps[0].heap, &stats) != 0) {
		return;
	}
	(void)send_control_response(conn,
				    "@info heap free=%u used=%u peak=%u\r\n",
				    (unsigned int)stats.free_bytes,
				    (unsigned int)stats.allocated_bytes,
				    (unsigned int)stats.max_allocated_bytes);
}
#endif

static void diagnostics_response(struct bt_conn *conn)
{
	char status[192];
	uint32_t dropped = 0;
	uint32_t dropped_no_conn = 0;
	uint32_t buffered = ring_buf_size_get(&uart_rx_ring);
	bt_security_t security = bt_conn_get_security(conn);

#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	dropped = (uint32_t)atomic_get(&uart_rx_dropped);
	dropped_no_conn = (uint32_t)atomic_get(&uart_reliable_drop_no_conn);
#endif
	(void)send_control_response(conn, "@info fw version=%s zephyr=%s\r\n",
				    CONFIG_LINKR_BLE_BRIDGE_FIRMWARE_VERSION,
				    KERNEL_VERSION_STRING);
	(void)send_control_response(conn,
				    "@info sys uptime_ms=%lld owner=%u security=%u\r\n",
				    (long long)k_uptime_get(), 0U,
				    (unsigned int)security);
	(void)send_control_response(conn,
				    "@info uart dropped=%u dropped_no_conn=%u buffer=%u/%u\r\n",
				    dropped, dropped_no_conn, buffered, UART_RX_BUFFER_SIZE);

	(void)linkr_wifi_diagnostics(status, sizeof(status));
	(void)send_control_response(conn, "@info wifi %s\r\n", status);
	(void)linkr_upload_diagnostics(status, sizeof(status));
	(void)send_control_response(conn, "@info upload %s\r\n", status);
	(void)linkr_ws_diagnostics(status, sizeof(status));
	(void)send_control_response(conn, "@info ws %s\r\n", status);
	/* Third drop point: BLE/WS RX -> UART. Its own group so the six web
	 * rows stay untouched (extra groups are already tolerated by the TUI
	 * and the web parser, both key on the group name). */
	(void)send_control_response(conn, "@info queue dropped=%u\r\n",
				    (unsigned int)atomic_get(&uart_queue_dropped));
	/* Fourth drop point: UART -> BLE output queues. Counted instead of
	 * closing the peer, so a host slower than the SBC loses bytes and keeps
	 * its terminal. */
	(void)send_control_response(conn, "@info peer dropped=%u\r\n",
				    linkr_ble_peer_dropped());
	{
		/* Whether the 40-92 ms handoff stalls come from the -EBUSY/-ENOMEM
		 * retry backoff (slept_ms) or from waiting on the peer (wait_max_ms).
		 * Its own group, like `queue`, so existing parsers stay intact.
		 * See ble_uart_reliable.c for what each counter means. */
		uint32_t ind_total, ind_retry, ind_busy, ind_nomem;
		uint32_t ind_slept, ind_timeout, ind_wait_max;

		linkr_uart_reliable_diag(&ind_total, &ind_retry, &ind_busy,
					 &ind_nomem, &ind_slept, &ind_timeout,
					 &ind_wait_max);
		(void)send_control_response(conn,
					    "@info rel ind=%u retry=%u busy=%u nomem=%u slept_ms=%u timeout=%u wait_max_ms=%u\r\n",
					    ind_total, ind_retry, ind_busy,
					    ind_nomem, ind_slept, ind_timeout,
					    ind_wait_max);
	}
#if IS_ENABLED(CONFIG_SYS_HEAP_RUNTIME_STATS)
	heap_status_response(conn);
#endif
	(void)send_control_response(conn, "@info done\r\n");
}

static bool handle_control_command_complete(struct bt_conn *conn,
					    const uint8_t *data, uint16_t len)
{
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_CONTROL_COMMANDS)
	char *cmd = control_command_data;
	char *body;
	struct uart_config cfg;
	int err;
	bool is_long;
	char short_ch = 0;

	if (len >= sizeof(control_command_data)) {
		(void)send_control_response(conn, "ERR command too long\r\n");
		return true;
	}

	is_long = (len >= strlen(CONTROL_CMD_PREFIX) &&
		   memcmp(data, CONTROL_CMD_PREFIX,
			  strlen(CONTROL_CMD_PREFIX)) == 0);

	if (!is_long) {
		if (len == 2 && data[0] == '@' && data[1] == 'h') {
			short_ch = 'h';
		} else if (len >= 2 && data[0] == '@' &&
			   (data[1] == 'c' || data[1] == 'i' || data[1] == 'u' || data[1] == 'w' ||
			    data[1] == 'd' || data[1] == 's' ||
			    data[1] == 'a' || data[1] == 'n' ||
			    data[1] == 'l' || data[1] == 'o' || data[1] == 'r' ||
			    data[1] == 'p' || data[1] == 'y') &&
			   (len == 2 || data[2] == '?' ||
			    data[2] == '=' || data[2] == ' ')) {
			short_ch = data[1];
		} else {
			return false;
		}
	}

	memcpy(cmd, data, len);
	cmd[len] = '\0';

	if (is_long) {
		body = trim_spaces(cmd + strlen(CONTROL_CMD_PREFIX));
	} else if (short_ch == 'h') {
		body = "h";
	} else {
		/* Keep the leading keyword letter so @u?/@w?/@d? are distinct. */
		body = trim_spaces(cmd + 1);
	}

	LOG_INF("Control command received");
	char session_response[192];
	if (linkr_session_control(conn, body, session_response, sizeof(session_response))) {
		(void)send_control_response(conn, "%s", session_response);
		return true;
	}

	bool readonly = !strcmp(body, "h") || !strcmp(body, "help") ||
		!strcmp(body, "i?") || !strcmp(body, "info?") ||
		!strcmp(body, "u?") || !strcmp(body, "uart?") ||
		!strcmp(body, "n?") || !strcmp(body, "name?") ||
		!strcmp(body, "a?") || !strcmp(body, "autobaud?") ||
		!strcmp(body, "w?") || !strcmp(body, "wifi?") ||
		!strcmp(body, "d?") || !strcmp(body, "webdav?") ||
		!strcmp(body, "s?") || !strcmp(body, "socket?") ||
		!strcmp(body, "bonds?") || !strcmp(body, "bonds names?") ||
		!strcmp(body, "target?") || linkr_aux_is_readonly(body);
	/* bonds name only ever writes the caller's own bond label, so it does not
	 * need the console ownership the other mutations require. */
	bool own_bond = !strcmp(body, "bonds name") || !strncmp(body, "bonds name ", 11);
	if (!readonly && !own_bond) {
		if (!linkr_session_command_begin(conn, mgmt_capture.epoch)) {
			(void)send_control_response(conn, "ERR control=readonly\r\n");
			return true;
		}
		/* Accepted operations may finish after a handover. Never hold the
		 * ownership mutex while a device/network operation can block. */
		linkr_session_end();
	}
	/* ---- Auxiliary board I/O (@l / @o / @r) ---- */
	{
		char aux_response[192];

		if (linkr_aux_command(body, aux_response, sizeof(aux_response))) {
			(void)send_control_response(conn, "%s", aux_response);
			return true;
		}
	}

	/* Header + eight maximal NAME lines + NUL fit in 512 bytes. */
	char bond_response[512];
	if (linkr_bond_command(conn, body, bond_response, sizeof(bond_response))) {
		(void)send_control_response(conn, "%s", bond_response);
		return true;
	}

	char target_response[80];
	if (linkr_target_command(body, target_response, sizeof(target_response))) {
		(void)send_control_response(conn, "%s", target_response);
		return true;
	}

	if (!strcmp(body, "help") || !strcmp(body, "h")) {
		char aux_help_text[LINKR_AUX_HELP_MAX];

		linkr_aux_help(aux_help_text, sizeof(aux_help_text));
		(void)send_control_response(conn,
					     "OK cmds: @linkr bonds?|@linkr bonds names?|@linkr bonds name <label>|@linkr bonds remove <type>/<address> @c?|@c claim|@c release|@c yield <peer> @i? @u?|@u=baud,data,par,stop,flow "
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_BLE_NAME_FROM_MAC)
					    "@n?|@n=<name>|@n default "
#endif
#if LINKR_UART_AUTOBAUD
					    "@a?|@a|@a stop "
#endif
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WIFI)
					    "@w?|@w=ssid,pass|@w off|@w scan "
#endif
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WEBDAV)
					    "@d?|@d=http://host/path/|@d off "
#endif
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE)
					    "@s?|@s on|@s off|"
					    "@s token[=<32 hex>]|@s token off"
#endif
					    "%s\r\n", aux_help_text);
		return true;
	}

	if (!strcmp(body, "info?") || !strcmp(body, "i?")) {
		diagnostics_response(conn);
		return true;
	}

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_BLE_NAME_FROM_MAC)
	/* ---- BLE advertised name (@n / @linkr name) ---- */
	{
		const char *value = NULL;
		enum ble_name_command command =
			ble_name_parse_command(body, &value);

		if (command == BLE_NAME_COMMAND_QUERY) {
			(void)send_control_response(
				conn, "OK name=%s custom=%s\r\n", ble_name,
				ble_name_custom ? "yes" : "no");
			return true;
		}
		if (command == BLE_NAME_COMMAND_RESET) {
			enum ble_name_persist_result result;

			result = ble_name_reset_and_delete(&err);
			if (result != BLE_NAME_PERSIST_OK) {
				(void)send_control_response(
					conn,
					result == BLE_NAME_PERSIST_SAVE_FAILED ?
						"ERR name save=%d\r\n" :
						"ERR name=%d\r\n",
					err);
				return true;
			}
			ble_name_advertise_refresh();
			(void)send_control_response(conn, "OK name=%s\r\n",
						    ble_name);
			return true;
		}
		if (command == BLE_NAME_COMMAND_SET && value) {
			enum ble_name_persist_result result;
			size_t len;

			value = trim_spaces((char *)value);
			len = strlen(value);
			if (!ble_name_valid(value, len)) {
				(void)send_control_response(
					conn,
					"ERR name expected 1-%d UTF-8 bytes without controls\r\n",
					BLE_NAME_MAX);
				return true;
			}
			result = ble_name_install_and_save(value, len, &err);
			if (result != BLE_NAME_PERSIST_OK) {
				(void)send_control_response(
					conn,
					result == BLE_NAME_PERSIST_SAVE_FAILED ?
						"ERR name save=%d\r\n" :
						"ERR name=%d\r\n",
					err);
				return true;
			}
			ble_name_advertise_refresh();
			(void)send_control_response(conn, "OK name=%s\r\n",
						    ble_name);
			return true;
		}
	}
#endif /* CONFIG_LINKR_BLE_BRIDGE_BLE_NAME_FROM_MAC */

#if LINKR_UART_AUTOBAUD
	/* ---- Manual autobaud (@a / @linkr autobaud) ---- */
	if (!strcmp(body, "autobaud?") || !strcmp(body, "a?")) {
		(void)send_control_response(
			conn, "OK autobaud state=%s baud=%u timeout_ms=%u\r\n",
			linkr_uart_autobaud_running() ? "running" : "idle",
			linkr_uart_config_current(),
			linkr_uart_autobaud_timeout_ms());
		return true;
	}
	if (!strcmp(body, "autobaud") || !strcmp(body, "a") ||
	    !strcmp(body, "autobaud start") || !strcmp(body, "a start")) {
		uint32_t request_id = mgmt_capture.active ?
					      mgmt_capture.request_id : 0;
		int ret;

		if (linkr_uart_autobaud_running()) {
			(void)send_control_response(conn,
						    "ERR autobaud busy\r\n");
			return true;
		}
		/* Set the ID before the request: the workqueue may start the
		 * pass immediately. It is cleared again if the request loses a
		 * race with the GPIO key. */
		atomic_set(&autobaud_request_id, request_id);
		ret = linkr_uart_autobaud_request();
		if (ret) {
			atomic_set(&autobaud_request_id, 0);
			(void)send_control_response(conn,
						    "ERR autobaud busy\r\n");
			return true;
		}
		k_mutex_lock(&conn_lock, K_FOREVER);
		if (autobaud_conn) bt_conn_unref(autobaud_conn);
		autobaud_conn = linkr_session_epoch(conn) ? bt_conn_ref(conn) : NULL;
		k_mutex_unlock(&conn_lock);
		mgmt_capture.async_response = true;
		(void)send_control_response(
			conn,
			"OK autobaud state=running baud=%u timeout_ms=%u\r\n",
			linkr_uart_config_current(),
			linkr_uart_autobaud_timeout_ms());
		return true;
	}
	if (!strcmp(body, "autobaud stop") || !strcmp(body, "a stop")) {
		if (linkr_uart_autobaud_stop()) {
			(void)send_control_response(conn,
						    "ERR autobaud idle\r\n");
			return true;
		}
		/* The pass's own FINAL event follows on its request ID; this
		 * response only confirms the stop was accepted. */
		(void)send_control_response(conn,
					    "OK autobaud state=stopping\r\n");
		return true;
	}
#endif /* LINKR_UART_AUTOBAUD */

	/* ---- UART (@u / @linkr uart) ---- */
	if (!strcmp(body, "uart?") || !strcmp(body, "u?")) {
		(void)uart_status_response(conn, "OK");
		return true;
	}
	if (!strncmp(body, "uart=", 5) || !strncmp(body, "u=", 2)) {
		char *value = (body[0] == 'u' && body[1] == '=') ?
				      body + 2 : body + 5;

		k_mutex_lock(&uart_config_lock, K_FOREVER);
		cfg = active_uart_config;
		k_mutex_unlock(&uart_config_lock);

		err = parse_uart_line(value, &cfg);
		if (err) {
			(void)send_control_response(conn,
						    "ERR format: "
						    "@u=115200,8,n,1,n\r\n");
			return true;
		}

		err = apply_uart_config(&cfg);
		if (err) {
			(void)send_control_response(conn,
						    "ERR uart_configure=%d\r\n",
						    err);
			return true;
		}

		(void)uart_status_response(conn, "OK");
		return true;
	}

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WIFI)
	/* ---- WiFi (@w / @linkr wifi) ---- */
	if (!strcmp(body, "wifi?") || !strcmp(body, "w?")) {
		char status[80];

		linkr_wifi_status(status, sizeof(status));
		(void)send_control_response(conn, "OK %s\r\n", status);
		return true;
	}
	if (!strncmp(body, "wifi=", 5) || !strncmp(body, "w=", 2)) {
		char *value = (body[0] == 'w' && body[1] == '=') ?
				      body + 2 : body + 5;
		char *comma = strchr(value, ',');

		if (!comma) {
			(void)send_control_response(conn,
						    "ERR format: "
						    "@w=ssid,pass\r\n");
			return true;
		}
		*comma = '\0';
		err = linkr_wifi_set_config_op(value, comma + 1,
				mgmt_capture.active ?
				mgmt_capture.request_id : 0);
		if (err) {
			(void)send_control_response(conn,
						    "ERR wifi=%d\r\n", err);
		} else {
			mgmt_capture.release_wifi_operation = true;
			(void)send_control_response(conn,
						    "OK wifi=accepted,ssid=%s\r\n",
						    value);
		}
		return true;
	}
	if (!strcmp(body, "wifi off") || !strcmp(body, "w off")) {
		err = linkr_wifi_clear_config_op(mgmt_capture.active ?
						 mgmt_capture.request_id : 0);
		(void)send_control_response(conn,
					    err ? "ERR wifi=%d\r\n"
						: "OK wifi off\r\n",
					    err);
		if (!err) {
			mgmt_capture.release_wifi_operation = true;
		}
		return true;
	}
	if (!strcmp(body, "wifi scan") || !strcmp(body, "w scan")) {
		err = linkr_wifi_scan(conn);
		if (err) {
			(void)send_control_response(conn,
						    "ERR scan=%d\r\n", err);
		} else {
			atomic_set(&wifi_scan_request_id,
				   mgmt_capture.active ?
				   mgmt_capture.request_id : 0);
			mgmt_capture.start_wifi_scan = true;
		}
		/* On success the SSIDs stream in via the scan sink, terminated by
		 * a "scan done" line, so no immediate OK is echoed here. */
		return true;
	}

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WEBDAV)
	/* ---- WebDAV (@d / @linkr webdav) ---- */
	if (!strcmp(body, "webdav?") || !strcmp(body, "d?")) {
		char status[CONFIG_LINKR_BLE_BRIDGE_WEBDAV_URL_MAX + 32];

		linkr_webdav_status(status, sizeof(status));
		(void)send_control_response(conn, "OK %s\r\n", status);
		return true;
	}
	if (!strncmp(body, "webdav=", 7) || !strncmp(body, "d=", 2)) {
		char *value = (body[0] == 'd' && body[1] == '=') ?
				      body + 2 : body + 7;
		char *save = NULL;
		char *url = strtok_r(value, ",", &save);
		char *user = strtok_r(NULL, ",", &save);
		char *pass = strtok_r(NULL, ",", &save);

		if (!url) {
			(void)send_control_response(conn,
						    "ERR format: "
						    "@d=http://host/path/\r\n");
			return true;
		}
		err = linkr_webdav_set_config(url, user, pass);
		if (err) {
			(void)send_control_response(conn,
						    "ERR webdav=%d\r\n", err);
		} else {
			char status[CONFIG_LINKR_BLE_BRIDGE_WEBDAV_URL_MAX + 32];

			linkr_webdav_status(status, sizeof(status));
			(void)send_control_response(conn, "OK %s\r\n",
						    status);
		}
		return true;
	}
	if (!strcmp(body, "webdav off") || !strcmp(body, "d off")) {
		err = linkr_webdav_clear_config();
		(void)send_control_response(conn,
					    err ? "ERR webdav=%d\r\n"
						: "OK webdav off\r\n",
					    err);
		return true;
	}
#endif /* CONFIG_LINKR_BLE_BRIDGE_WEBDAV */

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE)
	/* ---- WebSocket bridge (@s / @linkr socket) ---- */
	if (!strcmp(body, "socket?") || !strcmp(body, "s?")) {
		char status[96];

		linkr_ws_status(status, sizeof(status));
		(void)send_control_response(conn, "OK %s\r\n", status);
		return true;
	}
	if (!strcmp(body, "socket on") || !strcmp(body, "s on")) {
		err = linkr_ws_set_enabled(true);
		(void)send_control_response(conn,
					    err ? "ERR ws=%d\r\n" : "OK ws on\r\n",
					    err);
		return true;
	}
	if (!strcmp(body, "socket off") || !strcmp(body, "s off")) {
		err = linkr_ws_set_enabled(false);
		(void)send_control_response(conn,
					    err ? "ERR ws=%d\r\n"
						: "OK ws off\r\n",
					    err);
		return true;
	}
	/* ---- LAN auth token (@s token...) ---- */
	if (!strcmp(body, "socket token") || !strcmp(body, "s token")) {
		char status[96];

		err = linkr_ws_rotate_token();
		if (err) {
			(void)send_control_response(conn, "ERR ws token=%d\r\n",
						    err);
		} else {
			linkr_ws_status(status, sizeof(status));
			(void)send_control_response(conn, "OK %s\r\n", status);
		}
		return true;
	}
	if (!strcmp(body, "socket token off") || !strcmp(body, "s token off")) {
		err = linkr_ws_set_token(NULL);
		if (err) {
			(void)send_control_response(conn, "ERR ws token=%d\r\n",
						    err);
		} else {
			(void)send_control_response(conn,
						    "OK ws token off "
						    "(LAN access is unauthenticated)\r\n");
		}
		return true;
	}
	{
		const char *token_value = NULL;

		if (!strncmp(body, "socket token=", 13)) {
			token_value = body + 13;
		} else if (!strncmp(body, "s token=", 8)) {
			token_value = body + 8;
		}
		if (token_value) {
			char status[96];

			err = linkr_ws_set_token(token_value);
			if (err) {
				(void)send_control_response(
					conn,
					"ERR ws token=%d (expected 32 lowercase hex)\r\n",
					err);
			} else {
				linkr_ws_status(status, sizeof(status));
				(void)send_control_response(conn, "OK %s\r\n",
							    status);
			}
			return true;
		}
	}
#endif /* CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE */
#endif /* CONFIG_LINKR_BLE_BRIDGE_WIFI */

	(void)send_control_response(conn, "ERR unknown command\r\n");
	return true;
#else
	ARG_UNUSED(conn);
	ARG_UNUSED(data);
	ARG_UNUSED(len);
	return false;
#endif
}

static void mgmt_request_received(struct bt_conn *conn, uint32_t request_id,
				  const uint8_t *payload,
				  uint16_t payload_len, uint32_t epoch)
{
	bool handled;
	int err;
	uint16_t flags = LINKR_MGMT_FLAG_FINAL;

	memset(&mgmt_capture, 0, sizeof(mgmt_capture));
	mgmt_capture.active = true;
	mgmt_capture.conn = conn;
	mgmt_capture.request_id = request_id;
	mgmt_capture.epoch = epoch;

	handled = handle_control_command_complete(conn, payload, payload_len);
	if (!handled) {
		(void)send_control_response(conn, "ERR unknown command\r\n");
	}
	if (mgmt_capture.overflow) {
		static const char too_large[] = "ERR response too large\r\n";

		memcpy(mgmt_capture.data, too_large, sizeof(too_large) - 1);
		mgmt_capture.len = sizeof(too_large) - 1;
	}
	if (mgmt_capture.len == 0) {
		static const char accepted[] = "OK accepted\r\n";

		memcpy(mgmt_capture.data, accepted, sizeof(accepted) - 1);
		mgmt_capture.len = sizeof(accepted) - 1;
	}
	if (!strncmp(mgmt_capture.data, "ERR ", 4)) {
		flags |= LINKR_MGMT_FLAG_ERROR;
	}
	if (mgmt_capture.async_response) {
		/* The command accepted work that will report its result as a
		 * separate FINAL event on the same operation ID. */
		flags &= ~LINKR_MGMT_FLAG_FINAL;
	}
	err = linkr_mgmt_respond(conn, request_id, flags, mgmt_capture.data,
				mgmt_capture.len);
	if (err) {
		LOG_WRN("Management response queue failed: %d", err);
	}
	if (mgmt_capture.release_wifi_operation) {
		k_mutex_lock(&conn_lock, K_FOREVER);
		if (wifi_operation_conn) bt_conn_unref(wifi_operation_conn);
		wifi_operation_conn = linkr_session_epoch(conn) ? bt_conn_ref(conn) : NULL;
		k_mutex_unlock(&conn_lock);
		linkr_wifi_release_operation(request_id);
	}
	if (mgmt_capture.start_wifi_scan) {
		k_mutex_lock(&conn_lock, K_FOREVER);
		if (wifi_scan_conn) bt_conn_unref(wifi_scan_conn);
		wifi_scan_conn = linkr_session_epoch(conn) ? bt_conn_ref(conn) : NULL;
		if (!wifi_scan_conn) linkr_wifi_scan_abort();
		k_mutex_unlock(&conn_lock);
		linkr_wifi_release_scan();
	}
	memset(&mgmt_capture, 0, sizeof(mgmt_capture));
}

static void nus_received(struct bt_conn *conn, const void *data, uint16_t len,
			 void *ctx)
{
	const uint8_t *bytes = data;

	ARG_UNUSED(ctx);

	LOG_DBG("BLE RX write: %u bytes", len);

#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_ECHO)
	if (linkr_uart_write_peer(conn, bytes, len) != 0) {
		LOG_WRN("Dropping BLE->UART write; queue full");
	}
	return;
#else
	struct bridge_packet packet = { 0 };

	while (len > 0) {
		packet.len = MIN(len, sizeof(packet.data));
		memcpy(packet.data, bytes, packet.len);

		int err = linkr_nus_send(conn, packet.data, packet.len);

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
		ble_diag.rx_count++;
		ble_diag.last_rx_len = packet.len;
		ble_diag.last_echo_err = err;
		if (err) {
			ble_diag.echo_err_count++;
		} else {
			ble_diag.echo_ok_count++;
		}
		schedule_ble_diag_marker_write();
#endif
		if (err) {
			LOG_WRN("BLE echo notify failed: %d", err);
		} else {
			signal_uart_activity();
		}

		bytes += packet.len;
		len -= packet.len;
	}
#endif
}

static struct bt_nus_cb nus_callbacks = {
	.notif_enabled = nus_notif_enabled,
	.received = nus_received,
};

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
struct loopback_marker {
	char magic[8];
	uint32_t status;
	uint32_t pass_count;
	uint32_t fail_count;
	uint32_t rx_len;
	uint32_t expected_len;
};

static void write_loopback_marker(bool ok, unsigned int pass_count,
				  unsigned int fail_count, size_t rx_len,
				  size_t expected_len)
{
	const struct loopback_marker marker = {
		.magic = "LBRLOOP",
		.status = ok ? 0x4f4b4f4b : 0x4641494c,
		.pass_count = pass_count,
		.fail_count = fail_count,
		.rx_len = rx_len,
		.expected_len = expected_len,
	};
	int err = write_test_marker(&marker, sizeof(marker), "Loopback");

	if (err) {
		LOG_WRN("Loopback marker update failed: %d", err);
	}
}
#endif

int linkr_uart_write_peer(const void *peer, const uint8_t *data, size_t len)
{
	struct bridge_packet packet;
	size_t packets_needed;
	int err = 0;

	if (!data && len) {
		return -EINVAL;
	}
	if (!len) {
		return 0;
	}

	packet.ticket = linkr_session_ticket(peer, true);
	if (!linkr_session_begin(packet.ticket)) return -EACCES;
	packets_needed = DIV_ROUND_UP(len, sizeof(packet.data));
	k_mutex_lock(&ble_to_uart_queue_lock, K_FOREVER);
	if (k_msgq_num_free_get(&ble_to_uart_queue) < packets_needed) {
		/* Nothing was enqueued: the whole write is lost. */
		atomic_add(&uart_queue_dropped, len);
		err = -ENOMEM;
		goto out;
	}

	while (len > 0) {
		packet.len = MIN(len, sizeof(packet.data));
		memcpy(packet.data, data, packet.len);

		err = k_msgq_put(&ble_to_uart_queue, &packet, K_NO_WAIT);
		if (err) {
			/* `len` still covers this packet plus everything after
			 * it, none of which reached the queue. */
			atomic_add(&uart_queue_dropped, len);
			break;
		}

		data += packet.len;
		len -= packet.len;
	}

out:
	k_mutex_unlock(&ble_to_uart_queue_lock);
	linkr_session_end();
	return err;
}

static int reliable_uart_write(struct bt_conn *conn, const uint8_t *data, size_t len)
{
	return linkr_uart_write_peer(conn, data, len);
}

static void ble_to_uart_thread(void)
{
	struct bridge_packet packet;

	k_sem_take(&bridge_start_sem, K_FOREVER);

	for (;;) {
		linkr_watchdog_feed(LINKR_WDT_UART_TX);
		if (k_msgq_get(&ble_to_uart_queue, &packet, K_SECONDS(1)) != 0) {
			continue;
		}

		if (!linkr_session_begin(packet.ticket)) continue;
		/* Commit this packet to the single UART worker. Already in-flight
		 * bytes cannot be recalled, but queued old-generation packets can.
		 * CTS backpressure must not block Bluetooth/session callbacks. */
		linkr_session_end();
#if LINKR_UART_BULK_TX
		/*
		 * Same bytes, same order, same completion guarantee as the
		 * uart_poll_out loop below — the difference is one write to
		 * the FIFO instead of 244 single-byte trips through the
		 * driver. The rate is read under the same lock every other
		 * reader uses, because autobaud can move the port underneath
		 * us. Boards with the option off compile the loop below
		 * unchanged.
		 */
		uint32_t baudrate;

		k_mutex_lock(&uart_config_lock, K_FOREVER);
		baudrate = active_uart_config.baudrate;
		k_mutex_unlock(&uart_config_lock);

		linkr_uart_bulk_write(DT_REG_ADDR(LINKR_UART_NODE), baudrate,
				      packet.data, packet.len);
#else
		for (uint16_t i = 0; i < packet.len; i++) {
			uart_poll_out(bridge_uart, packet.data[i]);
		}
#endif

		signal_uart_activity();
	}
}

#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
static int uart_forward_chunk(const uint8_t *data, uint16_t len, bool *accounted)
{
	if (!*accounted) {
		linkr_log_feed(data, len);
		linkr_ws_feed(data, len);
		linkr_ble_feed(data, len);
		*accounted = true;
	}
	return 0;
}
#endif

static void uart_to_ble_thread(void)
{
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	k_sem_take(&bridge_start_sem, K_FOREVER);
	LOG_INF("UART-to-BLE RX thread disabled during loopback verify");
	for (;;) {
		linkr_watchdog_feed(LINKR_WDT_UART_RX);
		k_sleep(K_SECONDS(1));
	}
#else
	uint8_t buf[UART_RX_CHUNK];
	size_t len = 0;
	int64_t last_rx = 0;
	bool accounted = false;

	k_sem_take(&bridge_start_sem, K_FOREVER);

	for (;;) {
		uint32_t dropped;
		uint32_t got;
		unsigned int key;

		linkr_watchdog_feed(LINKR_WDT_UART_RX);

		dropped = atomic_set(&uart_rx_dropped, 0);
		if (dropped) {
			LOG_WRN("Dropped %u UART RX bytes; BLE is slower than UART",
				dropped);
		}

		/* Keep the only consumer running even when the ring is full.
		 * Pausing it cannot backpressure the producer: the RX interrupt
		 * still drains the hardware FIFO into this ring. */
		if (len == sizeof(buf)) {
			if (!uart_forward_chunk(buf, len, &accounted)) {
				len = 0;
				accounted = false;
			} else {
				k_sleep(K_MSEC(10));
			}
			continue;
		}

		key = irq_lock();
		got = ring_buf_get(&uart_rx_ring, buf + len, sizeof(buf) - len);
		irq_unlock(key);

		if (got > 0) {
			signal_uart_activity();
			len += got;
			last_rx = k_uptime_get();

			continue;
		}

		if (len > 0 &&
		    k_uptime_get() - last_rx >= CONFIG_LINKR_BLE_BRIDGE_UART_IDLE_MS) {
			if (!uart_forward_chunk(buf, len, &accounted)) {
				len = 0;
				accounted = false;
			}
		}

		(void)k_sem_take(&uart_rx_sem, K_MSEC(1));
	}
#endif
}

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX)
static void uart_test_tx_thread(void)
{
	static const char payload[] = CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_PAYLOAD;

	k_sem_take(&bridge_start_sem, K_FOREVER);

	for (;;) {
		for (size_t i = 0; i < sizeof(payload) - 1; i++) {
			uart_poll_out(bridge_uart, payload[i]);
		}

		signal_uart_activity();
		k_sleep(K_MSEC(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX_INTERVAL_MS));
	}
}
#endif

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
static void ble_diag_active_notify_thread(void)
{
	char msg[24];
	unsigned int seq = 0;

	k_sem_take(&bridge_start_sem, K_FOREVER);

	for (;;) {
		int err;
		int len;
		k_sleep(K_SECONDS(2));
		len = snprintk(msg, sizeof(msg), "diag-ping:%u\n", seq++);
		err = linkr_ble_feed((const uint8_t *)msg, len);

		ble_diag.last_active_notify_err = err;
		if (err) {
			ble_diag.active_notify_err_count++;
		} else {
			ble_diag.active_notify_ok_count++;
			signal_uart_activity();
		}
		schedule_ble_diag_marker_write();
	}
}
#endif

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
static void uart_loopback_verify_thread(void)
{
	static const uint8_t payload[] =
		CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_PAYLOAD;
	uint8_t rx[sizeof(payload) - 1];
	unsigned int pass_count = 0;
	unsigned int fail_count = 0;

	k_sem_take(&bridge_start_sem, K_FOREVER);

	for (;;) {
		size_t rx_len = 0;
		int64_t deadline;
		unsigned char byte;

		while (uart_poll_in(bridge_uart, &byte) == 0) {
		}

		for (size_t i = 0; i < sizeof(payload) - 1; i++) {
			uart_poll_out(bridge_uart, payload[i]);
		}
		signal_uart_activity();

		deadline = k_uptime_get() +
			   CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_TIMEOUT_MS;

		while (rx_len < sizeof(rx) && k_uptime_get() < deadline) {
			if (uart_poll_in(bridge_uart, &byte) == 0) {
				rx[rx_len++] = byte;
				signal_uart_activity();
				continue;
			}

			k_sleep(K_MSEC(1));
		}

		if (rx_len == sizeof(rx) &&
		    memcmp(rx, payload, sizeof(rx)) == 0) {
			pass_count++;
			LOG_INF("UART loopback OK #%u: %u bytes",
				pass_count, (unsigned int)rx_len);
			printk("UART loopback OK #%u: %u bytes\n",
			       pass_count, (unsigned int)rx_len);
			indicate_loopback_result(true);
			write_loopback_marker(true, pass_count, fail_count,
					      rx_len, sizeof(rx));
		} else {
			fail_count++;
			LOG_ERR("UART loopback FAIL #%u: got %u/%u bytes",
				fail_count, (unsigned int)rx_len,
				(unsigned int)sizeof(rx));
			printk("UART loopback FAIL #%u: got %u/%u bytes\n",
			       fail_count, (unsigned int)rx_len,
			       (unsigned int)sizeof(rx));
			indicate_loopback_result(false);
			write_loopback_marker(false, pass_count, fail_count,
					      rx_len, sizeof(rx));
		}

		k_sleep(K_MSEC(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_INTERVAL_MS));
	}
}
#endif

K_THREAD_DEFINE(ble_to_uart_tid, 1024, ble_to_uart_thread, NULL, NULL, NULL,
		7, 0, 0);
K_THREAD_DEFINE(uart_to_ble_tid, 2048, uart_to_ble_thread, NULL, NULL, NULL,
		7, 0, 0);
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX)
K_THREAD_DEFINE(uart_test_tx_tid, 1024, uart_test_tx_thread, NULL, NULL, NULL,
		7, 0, 0);
#endif
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
K_THREAD_DEFINE(uart_loopback_verify_tid, 1024, uart_loopback_verify_thread,
		NULL, NULL, NULL, 7, 0, 0);
#endif
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
K_THREAD_DEFINE(ble_diag_marker_tid, 1024, ble_diag_marker_thread,
		NULL, NULL, NULL, 8, 0, 0);
K_THREAD_DEFINE(ble_diag_active_notify_tid, 1024, ble_diag_active_notify_thread,
		NULL, NULL, NULL, 7, 0, 0);
#endif

int main(void)
{
	int err;

	if (!device_is_ready(bridge_uart)) {
		LOG_ERR("Bridge UART device is not ready");
		return -ENODEV;
	}

	k_mutex_init(&uart_config_lock);
	linkr_ble_peers_init();
#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	uart_irq_callback_user_data_set(bridge_uart, uart_rx_irq_callback, NULL);
#endif
	err = apply_uart_config(&active_uart_config);
	if (err) {
		LOG_ERR("Bridge UART configuration failed: %d", err);
		return err;
	}

	/* After the port, as uart_autobaud.h's contract says ("Must be called
	 * once, after the port has been configured"). Initialising only
	 * records the UART base and leaves the detector idle: it does not arm
	 * the RMT receiver or schedule a window here. The first pass starts
	 * later, from @a or the trigger input, against a port that is already
	 * programmed. */
	linkr_uart_autobaud_init(DT_REG_ADDR(LINKR_UART_NODE));
#if LINKR_UART_AUTOBAUD
	linkr_uart_autobaud_set_callback(autobaud_result_event);
#endif

#if LINKR_UART_AUTOBAUD && DT_HAS_ALIAS(linkr_autobaud)
	if (!device_is_ready(autobaud_button.port)) {
		LOG_WRN("Autobaud trigger GPIO is not ready");
	} else {
		err = gpio_pin_configure_dt(&autobaud_button, GPIO_INPUT);
		if (err) {
			LOG_WRN("Autobaud trigger configuration failed: %d", err);
		} else {
			gpio_init_callback(&autobaud_button_cb,
					   autobaud_button_isr,
					   BIT(autobaud_button.pin));
			err = gpio_add_callback(autobaud_button.port,
						&autobaud_button_cb);
			if (err) {
				LOG_WRN("Autobaud trigger callback failed: %d",
					err);
			} else {
				err = gpio_pin_interrupt_configure_dt(
					&autobaud_button, GPIO_INT_EDGE_TO_ACTIVE);
				if (err) {
					LOG_WRN("Autobaud trigger interrupt "
						"failed: %d", err);
				} else {
					LOG_INF("UART autobaud trigger: GPIO%u "
						"(active low)", autobaud_button.pin);
				}
			}
		}
	}
#endif

	/*
	 * Status LED, optocoupler contact and IR transceiver. Each is optional
	 * per board; the helper initializes whatever the devicetree describes
	 * and reports the first failure without blocking the others.
	 */
	err = linkr_aux_init();
	if (err) {
		LOG_WRN("Auxiliary board I/O incomplete: %d", err);
	}

#if defined(FACTORY_RESET_NODE)
	if (factory_reset_requested()) {
		err = erase_factory_settings();
		if (err) {
			LOG_ERR("Factory reset failed: %d", err);
			return err;
		}
	}
#endif

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	k_sem_give(&bridge_start_sem);
	k_sem_give(&bridge_start_sem);
	k_sem_give(&bridge_start_sem);
	LOG_INF("Linkr UART loopback verify ready on %s", bridge_uart->name);
	printk("Linkr UART loopback verify ready on %s\n", bridge_uart->name);
	linkr_watchdog_boot_complete();
	return 0;
#endif

	k_mutex_init(&conn_lock);
	k_work_init_delayable(&advertise_work, advertise_retry);
	err = bt_nus_inst_cb_register(&linkr_nus, &nus_callbacks, NULL);
	if (err) {
		LOG_ERR("NUS callback registration failed: %d", err);
		return err;
	}

	err = linkr_ble_security_init();
	if (err) {
		LOG_ERR("BLE security init failed: %d", err);
		return err;
	}

	err = bt_enable(NULL);
	if (err) {
		LOG_ERR("Bluetooth init failed: %d", err);
		return err;
	}
	bt_gatt_cb_register(&gatt_callbacks);

#if IS_ENABLED(CONFIG_SETTINGS)
	err = settings_subsys_init();
	if (err) {
		LOG_ERR("Settings init failed: %d", err);
		return err;
	}
	err = settings_load();
	if (err) {
		LOG_ERR("Settings load failed: %d", err);
		return err;
	}
#endif

	err = linkr_identity_init();
	if (err) {
		LOG_ERR("BLE identity init failed: %d", err);
		return err;
	}

	(void)linkr_ble_name_init();

	err = linkr_mgmt_init(mgmt_request_received);
	if (err) {
		LOG_ERR("Management Service init failed: %d", err);
		return err;
	}
	err = linkr_uart_reliable_init(reliable_uart_write);
	if (err) {
		LOG_ERR("Reliable UART init failed: %d", err);
		return err;
	}

	/* Install sinks before init: saved credentials may complete quickly enough
	 * to publish state while linkr_wifi_init() is still running. */
	linkr_wifi_set_respond_fn(wifi_scan_respond);
	linkr_wifi_set_event_fn(wifi_state_event);
	err = linkr_wifi_init();
	if (err) {
		LOG_WRN("WiFi init failed: %d (WiFi disabled)", err);
	}

	err = linkr_ws_init();
	if (err) {
		LOG_WRN("WS bridge init failed: %d (WS bridge disabled)", err);
	}

	advertise_schedule(K_NO_WAIT);
	k_sem_give(&bridge_start_sem);
	k_sem_give(&bridge_start_sem);
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_TX)
	k_sem_give(&bridge_start_sem);
#endif
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
	k_sem_give(&bridge_start_sem);
#endif
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	k_sem_give(&bridge_start_sem);
#endif
	LOG_INF("Linkr Bee UART bridge ready on %s", bridge_uart->name);
	linkr_watchdog_boot_complete();

	return 0;
}
