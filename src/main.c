/*
 * Linkr BLE UART bridge.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

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
#include <zephyr/bluetooth/services/nus.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/ring_buffer.h>
#include <zephyr/version.h>

#include "ble_mgmt.h"
#include "ble_uart_reliable.h"
#include "wifi.h"
#include "ws_bridge.h"

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
#define CONTROL_CMD_MAX_LEN 416
#define FACTORY_RESET_CONFIRM_MS 2000
#define FACTORY_RESET_SAMPLE_MS 100
#if DT_NODE_HAS_STATUS(DT_ALIAS(led0), okay)
#define ACTIVITY_LED_NODE DT_ALIAS(led0)
#endif

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
#if defined(ACTIVITY_LED_NODE)
static const struct gpio_dt_spec activity_led =
	GPIO_DT_SPEC_GET(ACTIVITY_LED_NODE, gpios);
static struct k_work_delayable led_off_work;
#endif
#if defined(FACTORY_RESET_NODE)
static const struct gpio_dt_spec factory_reset_gpio =
	GPIO_DT_SPEC_GET(FACTORY_RESET_NODE, gpios);
#endif
static struct bt_conn *current_conn;
static struct k_mutex conn_lock;
static struct k_mutex uart_config_lock;
static struct k_work_delayable advertise_work;
static atomic_t nus_notify_enabled;
static uint8_t linkr_identity = BT_ID_DEFAULT;
static atomic_t wifi_scan_request_id;
/* NUS receive callbacks run serially on the Bluetooth workqueue.  Keep the
 * command scratch buffer out of that workqueue's small thread stack: placing
 * it in handle_control_command_complete() consumed more than half of the
 * stack on every terminal keystroke. */
static char control_command_data[CONTROL_CMD_MAX_LEN];
static struct {
	bool active;
	bool overflow;
	struct bt_conn *conn;
	uint32_t request_id;
	size_t len;
	bool release_wifi_operation;
	bool start_wifi_scan;
	char data[LINKR_MGMT_MAX_PAYLOAD];
} mgmt_capture;
#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
static atomic_t uart_rx_dropped;
#endif
static struct uart_config active_uart_config = {
	.baudrate = CONFIG_LINKR_BLE_BRIDGE_UART_BAUD_RATE,
	.parity = DEFAULT_UART_PARITY,
	.stop_bits = DEFAULT_UART_STOP_BITS,
	.data_bits = DEFAULT_UART_DATA_BITS,
	.flow_ctrl = DEFAULT_UART_FLOW_CONTROL,
};

K_MSGQ_DEFINE(ble_to_uart_queue, sizeof(struct bridge_packet),
		      CONFIG_LINKR_BLE_BRIDGE_BLE_TO_UART_QUEUE_DEPTH, 4);
K_MUTEX_DEFINE(ble_to_uart_queue_lock);
K_SEM_DEFINE(bridge_start_sem, 0, 5);
RING_BUF_DECLARE(uart_rx_ring, UART_RX_BUFFER_SIZE);
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

	printk("GPIO0 is low; hold GND short for %u ms to factory reset\n",
	       FACTORY_RESET_CONFIRM_MS);
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
			printk("Factory reset cancelled: GPIO0 released\n");
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

static const struct bt_data sd[] = {
	BT_DATA(BT_DATA_NAME_COMPLETE, DEVICE_NAME, DEVICE_NAME_LEN),
};

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

#if defined(ACTIVITY_LED_NODE)
static void led_off(struct k_work *work)
{
	ARG_UNUSED(work);

	gpio_pin_set_dt(&activity_led, 0);
}

static void signal_uart_activity(void)
{
	if (!device_is_ready(activity_led.port)) {
		return;
	}

	gpio_pin_set_dt(&activity_led, 1);
	k_work_reschedule(&led_off_work, K_MSEC(40));
}
#else
static void signal_uart_activity(void)
{
}
#endif

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

#if defined(ACTIVITY_LED_NODE) && \
	IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
static void blink_activity_led(int count, int delay_ms)
{
	if (!device_is_ready(activity_led.port)) {
		return;
	}

	for (int i = 0; i < count; i++) {
		gpio_pin_set_dt(&activity_led, 1);
		k_sleep(K_MSEC(delay_ms));
		gpio_pin_set_dt(&activity_led, 0);
		k_sleep(K_MSEC(delay_ms));
	}
}
#endif

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
static void indicate_loopback_result(bool ok)
{
	if (ok) {
		signal_uart_activity();
		return;
	}

#if defined(ACTIVITY_LED_NODE)
	blink_activity_led(3, 80);
#endif
}
#endif

static int advertise_start(void)
{
	struct bt_le_adv_param params = *BT_LE_ADV_CONN_FAST_1;
	int err;

	params.id = linkr_identity;
	params.options |= BT_LE_ADV_OPT_USE_IDENTITY;
	err = bt_le_adv_start(&params, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));

	if (err && err != -EALREADY) {
		LOG_ERR("BLE advertising failed: %d", err);
		return err;
	}

	LOG_INF("BLE advertising as \"%s\"", DEVICE_NAME);
	return 0;
}

static void advertise_retry(struct k_work *work)
{
	int err;

	ARG_UNUSED(work);

	err = advertise_start();
	if (err && err != -EALREADY) {
		k_work_reschedule(&advertise_work, K_MSEC(500));
	}
}

static void advertise_schedule(k_timeout_t delay)
{
	k_work_reschedule(&advertise_work, delay);
}

static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		LOG_WRN("BLE connection failed: 0x%02x", err);
		return;
	}

	k_mutex_lock(&conn_lock, K_FOREVER);
	if (current_conn) {
		bt_conn_unref(current_conn);
	}
	current_conn = bt_conn_ref(conn);
	k_mutex_unlock(&conn_lock);

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
	ble_diag.connected_count++;
	schedule_ble_diag_marker_write();
#endif
	LOG_INF("BLE connected");
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	k_mutex_lock(&conn_lock, K_FOREVER);
	if (current_conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
	}
	k_mutex_unlock(&conn_lock);

	atomic_clear(&nus_notify_enabled);
	linkr_mgmt_disconnected(conn);
	linkr_uart_reliable_disconnected(conn);
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
	ble_diag.disconnected_count++;
	ble_diag.notify_enabled = 0;
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

	atomic_set(&nus_notify_enabled, enabled);
	if (enabled) {
		linkr_uart_reliable_nus_selected();
	}
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
static void wifi_scan_respond(struct bt_conn *conn, const char *line)
{
	char payload[96];
	uint32_t request_id = (uint32_t)atomic_get(&wifi_scan_request_id);
	int len = snprintk(payload, sizeof(payload), "%s\r\n", line);
	uint16_t flags = strstr(line, "done") || strstr(line, "error") ?
			 LINKR_MGMT_FLAG_FINAL : 0;

	if (len > 0) {
		(void)linkr_mgmt_event(conn, request_id, flags, payload,
				       MIN(len, (int)sizeof(payload) - 1));
	}
	if (flags & LINKR_MGMT_FLAG_FINAL) {
		atomic_clear(&wifi_scan_request_id);
	}
}

static void wifi_state_event(uint32_t operation_id,
			     enum linkr_wifi_state state, int error)
{
	struct bt_conn *conn;
	char status[96];
	char payload[144];
	int len;

	k_mutex_lock(&conn_lock, K_FOREVER);
	conn = current_conn ? bt_conn_ref(current_conn) : NULL;
	k_mutex_unlock(&conn_lock);
	if (!conn) {
		return;
	}

	(void)linkr_wifi_diagnostics(status, sizeof(status));
	len = snprintk(payload, sizeof(payload),
			"@event wifi operation=%u phase=%s result=%d %s\r\n",
			operation_id, linkr_wifi_state_name(state), error, status);
	if (len > 0) {
		(void)linkr_mgmt_event(conn, operation_id,
				       state == LINKR_WIFI_STATE_READY ||
				       state == LINKR_WIFI_STATE_FAILED ||
				       state == LINKR_WIFI_STATE_OFF ?
				       LINKR_MGMT_FLAG_FINAL : 0,
				       payload,
				       MIN(len, (int)sizeof(payload) - 1));
	}
	bt_conn_unref(conn);
}

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

	if (!strcasecmp(parity, "n") || !strcasecmp(parity, "none")) {
		cfg->parity = UART_CFG_PARITY_NONE;
	} else if (!strcasecmp(parity, "o") || !strcasecmp(parity, "odd")) {
		cfg->parity = UART_CFG_PARITY_ODD;
	} else if (!strcasecmp(parity, "e") || !strcasecmp(parity, "even")) {
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

	if (!strcasecmp(flow, "n") || !strcasecmp(flow, "none") ||
	    !strcasecmp(flow, "off")) {
		cfg->flow_ctrl = UART_CFG_FLOW_CTRL_NONE;
	} else if (!strcasecmp(flow, "rtscts") || !strcasecmp(flow, "hw")) {
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
		active_uart_config = *cfg;
		ring_buf_reset(&uart_rx_ring);
	}
	/* uart_configure() may fail after RX was disabled; always restore it. */
	uart_rx_irq_enable();
	k_mutex_unlock(&uart_config_lock);

	return err;
}

static void diagnostics_response(struct bt_conn *conn)
{
	char status[192];
	uint32_t dropped = 0;
	uint32_t buffered = ring_buf_size_get(&uart_rx_ring);
	bt_security_t security = bt_conn_get_security(conn);

#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	dropped = (uint32_t)atomic_get(&uart_rx_dropped);
#endif
	(void)send_control_response(conn, "@info fw version=%s zephyr=%s\r\n",
				    CONFIG_LINKR_BLE_BRIDGE_FIRMWARE_VERSION,
				    KERNEL_VERSION_STRING);
	(void)send_control_response(conn,
				    "@info sys uptime_ms=%lld owner=%u security=%u\r\n",
				    (long long)k_uptime_get(), 0U,
				    (unsigned int)security);
	(void)send_control_response(conn,
				    "@info uart dropped=%u buffer=%u/%u\r\n",
				    dropped, buffered, UART_RX_BUFFER_SIZE);

	(void)linkr_wifi_diagnostics(status, sizeof(status));
	(void)send_control_response(conn, "@info wifi %s\r\n", status);
	(void)linkr_upload_diagnostics(status, sizeof(status));
	(void)send_control_response(conn, "@info upload %s\r\n", status);
	(void)linkr_ws_diagnostics(status, sizeof(status));
	(void)send_control_response(conn, "@info ws %s\r\n", status);
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
			   (data[1] == 'i' || data[1] == 'u' || data[1] == 'w' ||
			    data[1] == 'd' || data[1] == 's') &&
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

	if (!strcmp(body, "help") || !strcmp(body, "h")) {
		(void)send_control_response(conn,
					    "OK cmds: @i? @u?|@u=baud,data,par,stop,flow "
					    "@w?|@w=ssid,pass|@w off|@w scan "
					    "@d?|@d=http://host/path/|@d off "
					    "@s?|@s on|@s off\r\n");
		return true;
	}

	if (!strcmp(body, "info?") || !strcmp(body, "i?")) {
		diagnostics_response(conn);
		return true;
	}

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

	/* ---- WebSocket bridge (@s / @linkr socket) ---- */
	if (!strcmp(body, "socket?") || !strcmp(body, "s?")) {
		char status[64];

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
				  uint16_t payload_len)
{
	bool handled;
	uint16_t flags = LINKR_MGMT_FLAG_FINAL;

	memset(&mgmt_capture, 0, sizeof(mgmt_capture));
	mgmt_capture.active = true;
	mgmt_capture.conn = conn;
	mgmt_capture.request_id = request_id;

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
	(void)linkr_mgmt_respond(conn, request_id, flags, mgmt_capture.data,
				 mgmt_capture.len);
	if (mgmt_capture.release_wifi_operation) {
		linkr_wifi_release_operation(request_id);
	}
	if (mgmt_capture.start_wifi_scan) {
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
	if (linkr_uart_write(bytes, len) != 0) {
		LOG_WRN("Dropping BLE->UART write; queue full");
	}
	return;
#else
	struct bridge_packet packet = { 0 };

	while (len > 0) {
		packet.len = MIN(len, sizeof(packet.data));
		memcpy(packet.data, bytes, packet.len);

		int err = bt_nus_send(conn, packet.data, packet.len);

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

int linkr_uart_write(const uint8_t *data, size_t len)
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

	packets_needed = DIV_ROUND_UP(len, sizeof(packet.data));
	k_mutex_lock(&ble_to_uart_queue_lock, K_FOREVER);
	if (k_msgq_num_free_get(&ble_to_uart_queue) < packets_needed) {
		err = -ENOMEM;
		goto out;
	}

	while (len > 0) {
		packet.len = MIN(len, sizeof(packet.data));
		memcpy(packet.data, data, packet.len);

		err = k_msgq_put(&ble_to_uart_queue, &packet, K_NO_WAIT);
		if (err) {
			break;
		}

		data += packet.len;
		len -= packet.len;
	}

out:
	k_mutex_unlock(&ble_to_uart_queue_lock);
	return err;
}

static void ble_to_uart_thread(void)
{
	struct bridge_packet packet;

	k_sem_take(&bridge_start_sem, K_FOREVER);

	for (;;) {
		k_msgq_get(&ble_to_uart_queue, &packet, K_FOREVER);

		for (uint16_t i = 0; i < packet.len; i++) {
			uart_poll_out(bridge_uart, packet.data[i]);
		}

		signal_uart_activity();
	}
}

static int nus_send_conn(struct bt_conn *conn, const uint8_t *data, uint16_t len)
{
	uint16_t mtu_payload = bt_gatt_get_mtu(conn) - 3;
	uint16_t acl_payload = CONFIG_BT_BUF_ACL_TX_SIZE > 7 ?
			       CONFIG_BT_BUF_ACL_TX_SIZE - 7 : 1;

	mtu_payload = MIN(MAX(mtu_payload, 1), acl_payload);

	while (len > 0) {
		uint16_t chunk_len = MIN(len, mtu_payload);
		int err = bt_nus_send(conn, data, chunk_len);

		if (err == -ENOMEM || err == -EAGAIN) {
			k_sleep(K_MSEC(10));
			err = bt_nus_send(conn, data, chunk_len);
		}

		if (err) {
			return err;
		}

		data += chunk_len;
		len -= chunk_len;
	}

	return 0;
}

#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
static int nus_send_chunk(const uint8_t *data, uint16_t len)
{
	struct bt_conn *conn;
	int err;

	if (!atomic_get(&nus_notify_enabled)) {
		return -ENOTCONN;
	}

	k_mutex_lock(&conn_lock, K_FOREVER);
	conn = current_conn ? bt_conn_ref(current_conn) : NULL;
	k_mutex_unlock(&conn_lock);

	if (!conn) {
		return -ENOTCONN;
	}

	err = nus_send_conn(conn, data, len);
	bt_conn_unref(conn);
	return err;
}

static int reliable_send_chunk(const uint8_t *data, uint16_t len)
{
	struct bt_conn *conn;
	int err;

	k_mutex_lock(&conn_lock, K_FOREVER);
	conn = current_conn ? bt_conn_ref(current_conn) : NULL;
	k_mutex_unlock(&conn_lock);
	if (!conn) {
		return -ENOTCONN;
	}
	err = linkr_uart_reliable_send(conn, data, len);
	bt_conn_unref(conn);
	return err;
}

static int uart_forward_chunk(const uint8_t *data, uint16_t len,
			      bool *accounted)
{
	int err;

	if (!*accounted) {
		linkr_log_feed(data, len);
		linkr_ws_feed(data, len);
		*accounted = true;
	}
	if (!linkr_uart_reliable_mode()) {
		/* NUS is the compatibility, best-effort path. Preserve its previous
		 * behavior: UART capture must not stall when no NUS central exists. */
		(void)nus_send_chunk(data, len);
		return 0;
	}

	err = reliable_send_chunk(data, len);
	if (err && err != -ENOTCONN) {
		LOG_WRN("Reliable UART delivery retry: %d", err);
	}
	return err;
}
#endif

static void uart_to_ble_thread(void)
{
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	k_sem_take(&bridge_start_sem, K_FOREVER);
	LOG_INF("UART-to-BLE RX thread disabled during loopback verify");
	for (;;) {
		k_sleep(K_SECONDS(60));
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

		dropped = atomic_set(&uart_rx_dropped, 0);
		if (dropped) {
			LOG_WRN("Dropped %u UART RX bytes; BLE is slower than UART",
				dropped);
		}

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
		struct bt_conn *conn;
		int err;
		int len;

		k_sleep(K_SECONDS(2));

		if (!atomic_get(&nus_notify_enabled)) {
			continue;
		}

		k_mutex_lock(&conn_lock, K_FOREVER);
		conn = current_conn ? bt_conn_ref(current_conn) : NULL;
		k_mutex_unlock(&conn_lock);
		if (!conn) {
			continue;
		}

		len = snprintk(msg, sizeof(msg), "diag-ping:%u\n", seq++);
		err = bt_nus_send(conn, msg, len);
		bt_conn_unref(conn);

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
#if !IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
	uart_irq_callback_user_data_set(bridge_uart, uart_rx_irq_callback, NULL);
#endif
	err = apply_uart_config(&active_uart_config);
	if (err) {
		LOG_ERR("Bridge UART configuration failed: %d", err);
		return err;
	}

#if defined(ACTIVITY_LED_NODE)
	if (!device_is_ready(activity_led.port)) {
		LOG_ERR("Activity LED device is not ready");
		return -ENODEV;
	}

	gpio_pin_configure_dt(&activity_led, GPIO_OUTPUT_INACTIVE);
	k_work_init_delayable(&led_off_work, led_off);
#endif

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
	return 0;
#endif

	k_mutex_init(&conn_lock);
	k_work_init_delayable(&advertise_work, advertise_retry);
	err = bt_nus_cb_register(&nus_callbacks, NULL);
	if (err) {
		LOG_ERR("NUS callback registration failed: %d", err);
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

	err = linkr_mgmt_init(mgmt_request_received);
	if (err) {
		LOG_ERR("Management Service init failed: %d", err);
		return err;
	}
	err = linkr_uart_reliable_init(linkr_uart_write);
	if (err) {
		LOG_ERR("Reliable UART init failed: %d", err);
		return err;
	}

	err = linkr_wifi_init();
	if (err) {
		LOG_WRN("WiFi init failed: %d (WiFi disabled)", err);
	} else {
		linkr_wifi_set_respond_fn(wifi_scan_respond);
		linkr_wifi_set_event_fn(wifi_state_event);
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
	LOG_INF("Linkr BLE UART bridge ready on %s", bridge_uart->name);

	return 0;
}
