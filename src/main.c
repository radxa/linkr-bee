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
#include <zephyr/drivers/flash.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/ring_buffer.h>

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

#define LOOPBACK_MARKER_OFFSET 0x3ff000
#define LOOPBACK_MARKER_SECTOR_SIZE 4096
#define CONTROL_CMD_PREFIX "@linkr "
#define CONTROL_CMD_SHORT_PREFIX "@u"
#define CONTROL_CMD_MAX_LEN 96

#if DT_NODE_HAS_STATUS(DT_ALIAS(led0), okay)
#define ACTIVITY_LED_NODE DT_ALIAS(led0)
#endif

BUILD_ASSERT(UART_RX_CHUNK <= BLE_TO_UART_MAX_LEN);
BUILD_ASSERT(UART_RX_CHUNK <= UART_RX_BUFFER_SIZE);
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
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY) || \
	IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
static const struct device *const flash_dev =
	DEVICE_DT_GET(DT_CHOSEN(zephyr_flash_controller));
#endif
#if defined(ACTIVITY_LED_NODE)
static const struct gpio_dt_spec activity_led =
	GPIO_DT_SPEC_GET(ACTIVITY_LED_NODE, gpios);
static struct k_work_delayable led_off_work;
#endif
static struct bt_conn *current_conn;
static struct k_mutex conn_lock;
static struct k_mutex uart_config_lock;
static struct k_mutex control_response_lock;
static struct k_work_delayable advertise_work;
static atomic_t nus_notify_enabled;
static uint16_t control_response_len;
static uint8_t control_response_data[96];
static struct bt_conn *control_response_conn;
static atomic_t uart_rx_dropped;
static struct uart_config active_uart_config = {
	.baudrate = CONFIG_LINKR_BLE_BRIDGE_UART_BAUD_RATE,
	.parity = DEFAULT_UART_PARITY,
	.stop_bits = DEFAULT_UART_STOP_BITS,
	.data_bits = DEFAULT_UART_DATA_BITS,
	.flow_ctrl = DEFAULT_UART_FLOW_CONTROL,
};

K_MSGQ_DEFINE(ble_to_uart_queue, sizeof(struct bridge_packet),
	      CONFIG_LINKR_BLE_BRIDGE_BLE_TO_UART_QUEUE_DEPTH, 4);
K_SEM_DEFINE(bridge_start_sem, 0, 5);
RING_BUF_DECLARE(uart_rx_ring, UART_RX_BUFFER_SIZE);
K_SEM_DEFINE(uart_rx_sem, 0, 1);

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

		if (!device_is_ready(flash_dev)) {
			continue;
		}

		err = flash_erase(flash_dev, LOOPBACK_MARKER_OFFSET,
				  LOOPBACK_MARKER_SECTOR_SIZE);
		if (err) {
			LOG_ERR("BLE diag marker erase failed: %d", err);
			continue;
		}

		err = flash_write(flash_dev, LOOPBACK_MARKER_OFFSET, &ble_diag,
				  sizeof(ble_diag));
		if (err) {
			LOG_ERR("BLE diag marker write failed: %d", err);
		}
	}
}
#endif

static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA(BT_DATA_NAME_COMPLETE, DEVICE_NAME, DEVICE_NAME_LEN),
};

static const struct bt_data sd[] = {
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_NUS_SRV_VAL),
};

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
	int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad),
				  sd, ARRAY_SIZE(sd));

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
	ARG_UNUSED(conn);

	k_mutex_lock(&conn_lock, K_FOREVER);
	if (current_conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
	}
	k_mutex_unlock(&conn_lock);

	atomic_clear(&nus_notify_enabled);
	k_msgq_purge(&ble_to_uart_queue);
	k_mutex_lock(&control_response_lock, K_FOREVER);
	if (control_response_conn) {
		bt_conn_unref(control_response_conn);
		control_response_conn = NULL;
	}
	control_response_len = 0;
	k_mutex_unlock(&control_response_lock);
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_DIAG_MARKER)
	ble_diag.disconnected_count++;
	ble_diag.notify_enabled = 0;
	schedule_ble_diag_marker_write();
#endif
	LOG_INF("BLE disconnected: 0x%02x", reason);
	advertise_schedule(K_MSEC(200));
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = connected,
	.disconnected = disconnected,
};

static void nus_notif_enabled(bool enabled, void *ctx)
{
	ARG_UNUSED(ctx);

	atomic_set(&nus_notify_enabled, enabled);
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

static bool control_response_peek(uint8_t *data, uint16_t *len,
				  struct bt_conn **conn)
{
	bool has_data;

	k_mutex_lock(&control_response_lock, K_FOREVER);
	*len = control_response_len;
	has_data = *len > 0;
	if (has_data) {
		memcpy(data, control_response_data, *len);
		*conn = control_response_conn ?
			bt_conn_ref(control_response_conn) : NULL;
	}
	k_mutex_unlock(&control_response_lock);

	return has_data;
}

static void control_response_clear(void)
{
	k_mutex_lock(&control_response_lock, K_FOREVER);
	control_response_len = 0;
	if (control_response_conn) {
		bt_conn_unref(control_response_conn);
		control_response_conn = NULL;
	}
	k_mutex_unlock(&control_response_lock);
}

static int send_control_response(struct bt_conn *conn, const char *fmt, ...)
{
	va_list args;
	int len;

	k_mutex_lock(&control_response_lock, K_FOREVER);
	va_start(args, fmt);
	len = vsnprintk(control_response_data, sizeof(control_response_data),
			fmt, args);
	va_end(args);

	if (len < 0) {
		k_mutex_unlock(&control_response_lock);
		return len;
	}

	if (control_response_conn) {
		bt_conn_unref(control_response_conn);
	}
	control_response_conn = conn ? bt_conn_ref(conn) : NULL;
	control_response_len = MIN(len, (int)sizeof(control_response_data));
	k_mutex_unlock(&control_response_lock);

	return 0;
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
		uart_rx_irq_enable();
	}
	k_mutex_unlock(&uart_config_lock);

	return err;
}

static bool handle_control_command(struct bt_conn *conn, const uint8_t *data,
				   uint16_t len)
{
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_CONTROL_COMMANDS)
	char cmd[CONTROL_CMD_MAX_LEN];
	char *body;
	struct uart_config cfg;
	int err;
	bool short_cmd = false;

	if (len == 2 && memcmp(data, "@h", 2) == 0) {
		short_cmd = true;
	} else if (len >= strlen(CONTROL_CMD_SHORT_PREFIX) &&
		   memcmp(data, CONTROL_CMD_SHORT_PREFIX,
			  strlen(CONTROL_CMD_SHORT_PREFIX)) == 0 &&
		   (len == strlen(CONTROL_CMD_SHORT_PREFIX) ||
		    data[strlen(CONTROL_CMD_SHORT_PREFIX)] == '?' ||
		    data[strlen(CONTROL_CMD_SHORT_PREFIX)] == '=')) {
		short_cmd = true;
	} else if (len < strlen(CONTROL_CMD_PREFIX) ||
		   memcmp(data, CONTROL_CMD_PREFIX,
			  strlen(CONTROL_CMD_PREFIX)) != 0) {
		return false;
	}

	if (len >= sizeof(cmd)) {
		(void)send_control_response(conn, "ERR command too long\r\n");
		return true;
	}

	memcpy(cmd, data, len);
	cmd[len] = '\0';
	if (len == 2 && !strcmp(cmd, "@h")) {
		body = "h";
	} else {
		body = trim_spaces(cmd +
				   (short_cmd ?
				    strlen(CONTROL_CMD_SHORT_PREFIX) :
				    strlen(CONTROL_CMD_PREFIX)));
	}
	LOG_INF("Control command: %s", body);

	if (!strcmp(body, "help") || !strcmp(body, "h")) {
		(void)send_control_response(conn,
					    "OK cmds: @u? | "
					    "@u=<baud>,<data>,<parity>,<stop>,<flow>\r\n");
		return true;
	}

	if (!strcmp(body, "uart?") || !strcmp(body, "?")) {
		(void)uart_status_response(conn, "OK");
		return true;
	}

	if (!strncmp(body, "uart=", 5) || body[0] == '=') {
		char *value = body[0] == '=' ? body + 1 : body + 5;

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

	(void)send_control_response(conn, "ERR unknown command\r\n");
	return true;
#else
	ARG_UNUSED(conn);
	ARG_UNUSED(data);
	ARG_UNUSED(len);
	return false;
#endif
}

static void nus_received(struct bt_conn *conn, const void *data, uint16_t len,
			 void *ctx)
{
	struct bridge_packet packet = { 0 };
	const uint8_t *bytes = data;

	ARG_UNUSED(ctx);

	LOG_INF("BLE RX write: %u bytes", len);

	if (handle_control_command(conn, bytes, len)) {
		return;
	}

	while (len > 0) {
		packet.len = MIN(len, sizeof(packet.data));
		memcpy(packet.data, bytes, packet.len);

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_BLE_ECHO)
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
#else
		if (k_msgq_put(&ble_to_uart_queue, &packet, K_NO_WAIT) != 0) {
			LOG_WRN("Dropping BLE->UART packet; queue full");
			return;
		}
#endif

		bytes += packet.len;
		len -= packet.len;
	}
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
	int err;

	if (!device_is_ready(flash_dev)) {
		LOG_ERR("Flash device is not ready");
		return;
	}

	err = flash_erase(flash_dev, LOOPBACK_MARKER_OFFSET,
			  LOOPBACK_MARKER_SECTOR_SIZE);
	if (err) {
		LOG_ERR("Loopback marker erase failed: %d", err);
		return;
	}

	err = flash_write(flash_dev, LOOPBACK_MARKER_OFFSET, &marker,
			  sizeof(marker));
	if (err) {
		LOG_ERR("Loopback marker write failed: %d", err);
	}
}
#endif

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

	if (mtu_payload == 0) {
		mtu_payload = 20;
	}

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

static bool control_response_flush(uint8_t *data)
{
	struct bt_conn *conn = NULL;
	uint16_t len;
	int err;

	if (!control_response_peek(data, &len, &conn)) {
		return false;
	}
	if (conn) {
		bt_conn_unref(conn);
		conn = NULL;
	}

	k_sleep(K_MSEC(200));
	if (!control_response_peek(data, &len, &conn)) {
		return false;
	}
	if (!conn) {
		LOG_WRN("Control notify skipped; no command connection");
		return true;
	}

	for (int retry = 0; retry < 5; retry++) {
		err = nus_send_conn(conn, data, len);
		if (err == 0) {
			control_response_clear();
			bt_conn_unref(conn);
			return true;
		}

		LOG_WRN("Control notify failed: %d", err);
		k_sleep(K_MSEC(100));
	}

	bt_conn_unref(conn);
	return true;
}

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
	uint8_t control_buf[sizeof(control_response_data)];
	size_t len = 0;
	int64_t last_rx = 0;

	k_sem_take(&bridge_start_sem, K_FOREVER);

	for (;;) {
		uint32_t dropped;
		uint32_t got;
		unsigned int key;

		if (control_response_flush(control_buf)) {
			len = 0;
			continue;
		}

		dropped = atomic_set(&uart_rx_dropped, 0);
		if (dropped) {
			LOG_WRN("Dropped %u UART RX bytes; BLE is slower than UART",
				dropped);
		}

		key = irq_lock();
		got = ring_buf_get(&uart_rx_ring, buf + len, sizeof(buf) - len);
		irq_unlock(key);

		if (got > 0) {
			signal_uart_activity();
			len += got;
			last_rx = k_uptime_get();

			if (len == sizeof(buf)) {
				(void)nus_send_chunk(buf, len);
				len = 0;
			}

			continue;
		}

		if (len > 0 &&
		    k_uptime_get() - last_rx >= CONFIG_LINKR_BLE_BRIDGE_UART_IDLE_MS) {
			(void)nus_send_chunk(buf, len);
			len = 0;
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
	k_mutex_init(&control_response_lock);
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
