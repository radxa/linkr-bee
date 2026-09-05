/*
 * Linkr Reliable UART Service v1.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>

#include "ble_uart_reliable.h"

LOG_MODULE_REGISTER(linkr_ble_uart_reliable, LOG_LEVEL_INF);

#define RX_TIMEOUT_MS 2000
#define INDICATE_TIMEOUT_MS 5000
#define FRAGMENT_MAX 244

struct reliable_header {
	uint8_t magic[2];
	uint8_t version;
	uint8_t flags;
	uint8_t sequence_le[4];
	uint8_t payload_len_le[2];
	uint8_t reserved[2];
} __packed;

struct reliable_state_value {
	uint8_t version;
	uint8_t flags;
	uint8_t max_payload_le[2];
	uint8_t rx_next_sequence_le[4];
	uint8_t tx_next_sequence_le[4];
	uint8_t tx_acked_sequence_le[4];
} __packed;

BUILD_ASSERT(sizeof(struct reliable_header) == LINKR_UART_RELIABLE_HEADER_SIZE);
BUILD_ASSERT(sizeof(struct reliable_state_value) == 16);

static linkr_uart_reliable_write_fn uart_write_fn;
static struct k_mutex rx_lock;
static struct {
	struct bt_conn *conn;
	uint32_t sequence;
	uint16_t expected;
	uint16_t received;
	int64_t started_at;
	uint8_t payload[LINKR_UART_RELIABLE_MAX_PAYLOAD];
} rx_state;
static uint32_t rx_next_sequence = 1;
static uint32_t tx_next_sequence = 1;
static uint32_t tx_acked_sequence;
static atomic_t reliable_mode;
static atomic_t indication_enabled;
static struct k_sem indication_done;
static struct bt_gatt_indicate_params indication_params;
static int indication_result;

static uint32_t sequence_next(uint32_t sequence)
{
	return sequence == UINT32_MAX ? 1 : sequence + 1;
}

static void rx_reset_locked(void)
{
	if (rx_state.conn) {
		bt_conn_unref(rx_state.conn);
	}
	memset(&rx_state, 0, sizeof(rx_state));
}

static ssize_t state_read(struct bt_conn *conn,
			  const struct bt_gatt_attr *attr, void *buf,
			  uint16_t len, uint16_t offset)
{
	struct reliable_state_value state = {
		.version = LINKR_UART_RELIABLE_API_MAJOR,
		.flags = atomic_get(&reliable_mode) ? 1 : 0,
		.max_payload_le = {
			LINKR_UART_RELIABLE_MAX_PAYLOAD & 0xff,
			LINKR_UART_RELIABLE_MAX_PAYLOAD >> 8,
		},
	};

	ARG_UNUSED(attr);
	sys_put_le32(rx_next_sequence, state.rx_next_sequence_le);
	sys_put_le32(tx_next_sequence, state.tx_next_sequence_le);
	sys_put_le32(tx_acked_sequence, state.tx_acked_sequence_le);
	return bt_gatt_attr_read(conn, attr, buf, len, offset, &state,
				 sizeof(state));
}

static ssize_t rx_write(struct bt_conn *conn,
			const struct bt_gatt_attr *attr, const void *buf,
			uint16_t len, uint16_t offset, uint8_t flags)
{
	const uint8_t *bytes = buf;
	const struct reliable_header *header;
	uint16_t fragment_len;
	uint32_t previous_sequence = rx_next_sequence == 1 ?
				     UINT32_MAX : rx_next_sequence - 1;
	int err = 0;

	ARG_UNUSED(attr);
	if (offset != 0 || (flags & BT_GATT_WRITE_FLAG_PREPARE)) {
		return BT_GATT_ERR(BT_ATT_ERR_NOT_SUPPORTED);
	}

	k_mutex_lock(&rx_lock, K_FOREVER);
	if (rx_state.expected &&
	    k_uptime_get() - rx_state.started_at > RX_TIMEOUT_MS) {
		rx_reset_locked();
	}

	if (!rx_state.expected) {
		if (len < sizeof(*header)) {
			err = BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
			goto out;
		}
		header = (const struct reliable_header *)bytes;
		fragment_len = len - sizeof(*header);
		if (header->magic[0] != 'L' || header->magic[1] != 'R' ||
		    header->version != LINKR_UART_RELIABLE_API_MAJOR ||
		    sys_get_le16(header->payload_len_le) == 0 ||
		    sys_get_le16(header->payload_len_le) >
			    LINKR_UART_RELIABLE_MAX_PAYLOAD ||
		    fragment_len > sys_get_le16(header->payload_len_le)) {
			err = BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
			goto out;
		}
		rx_state.conn = bt_conn_ref(conn);
		rx_state.sequence = sys_get_le32(header->sequence_le);
		rx_state.expected = sys_get_le16(header->payload_len_le);
		rx_state.received = fragment_len;
		rx_state.started_at = k_uptime_get();
		memcpy(rx_state.payload, bytes + sizeof(*header), fragment_len);
	} else {
		uint16_t remaining = rx_state.expected - rx_state.received;

		if (rx_state.conn != conn || len > remaining) {
			rx_reset_locked();
			err = BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
			goto out;
		}
		memcpy(rx_state.payload + rx_state.received, bytes, len);
		rx_state.received += len;
	}

	if (rx_state.received == rx_state.expected) {
		if (rx_state.sequence == rx_next_sequence) {
			err = uart_write_fn(rx_state.payload, rx_state.expected);
			if (!err) {
				rx_next_sequence = sequence_next(rx_next_sequence);
			}
		} else if (rx_state.sequence != previous_sequence) {
			err = -EILSEQ;
		}
		rx_reset_locked();
		if (err) {
			err = BT_GATT_ERR(err == -ENOMEM ?
					  BT_ATT_ERR_INSUFFICIENT_RESOURCES :
					  BT_ATT_ERR_VALUE_NOT_ALLOWED);
		}
	}

out:
	k_mutex_unlock(&rx_lock);
	return err ? err : len;
}

static void tx_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);
	atomic_set(&indication_enabled,
		   value == BT_GATT_CCC_INDICATE ? 1 : 0);
	if (atomic_get(&indication_enabled)) {
		atomic_set(&reliable_mode, 1);
	}
	LOG_INF("Reliable UART indications %s",
		 atomic_get(&indication_enabled) ? "enabled" : "disabled");
}

BT_GATT_SERVICE_DEFINE(linkr_uart_reliable_service,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_LINKR_UART_RELIABLE_SERVICE),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_UART_RELIABLE_RX,
			       BT_GATT_CHRC_WRITE, BT_GATT_PERM_WRITE,
			       NULL, rx_write, NULL),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_UART_RELIABLE_TX,
			       BT_GATT_CHRC_INDICATE, BT_GATT_PERM_NONE,
			       NULL, NULL, NULL),
	BT_GATT_CCC(tx_ccc_changed,
		    BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_UART_RELIABLE_STATE,
			       BT_GATT_CHRC_READ, BT_GATT_PERM_READ,
			       state_read, NULL, NULL));

static void indication_complete(struct bt_conn *conn,
				struct bt_gatt_indicate_params *params,
				uint8_t err)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);
	indication_result = err ? -EIO : 0;
	/* params remains owned by the GATT stack until the destroy callback. */
}

static void indication_destroy(struct bt_gatt_indicate_params *params)
{
	ARG_UNUSED(params);
	k_sem_give(&indication_done);
}

static int indicate_fragment(struct bt_conn *conn, const uint8_t *data,
			     uint16_t len)
{
	int err;

	if (!atomic_get(&indication_enabled) ||
	    !bt_gatt_is_subscribed(conn, &linkr_uart_reliable_service.attrs[4],
				   BT_GATT_CCC_INDICATE)) {
		return -ENOTCONN;
	}

	for (int retry = 0; retry < 20; retry++) {
		k_sem_reset(&indication_done);
		indication_result = -ETIMEDOUT;
		memset(&indication_params, 0, sizeof(indication_params));
		indication_params.attr = &linkr_uart_reliable_service.attrs[4];
		indication_params.func = indication_complete;
		indication_params.destroy = indication_destroy;
		indication_params.data = data;
		indication_params.len = len;
		err = bt_gatt_indicate(conn, &indication_params);
		if (err != -EBUSY && err != -ENOMEM) {
			break;
		}
		k_sleep(K_MSEC(25));
	}
	if (err) {
		return err;
	}
	if (k_sem_take(&indication_done, K_MSEC(INDICATE_TIMEOUT_MS))) {
		/* Do not return while Zephyr still owns indication_params. Force the
		 * connection down so GATT completes the request, then wait for destroy. */
		LOG_WRN("Reliable UART indication timed out; disconnecting peer");
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		(void)k_sem_take(&indication_done, K_FOREVER);
		return -ETIMEDOUT;
	}
	return indication_result;
}

int linkr_uart_reliable_init(linkr_uart_reliable_write_fn write_fn)
{
	if (!write_fn) {
		return -EINVAL;
	}
	uart_write_fn = write_fn;
	k_mutex_init(&rx_lock);
	k_sem_init(&indication_done, 0, 1);
	return 0;
}

void linkr_uart_reliable_disconnected(struct bt_conn *conn)
{
	k_mutex_lock(&rx_lock, K_FOREVER);
	if (rx_state.conn == conn) {
		rx_reset_locked();
	}
	k_mutex_unlock(&rx_lock);
	atomic_clear(&indication_enabled);
}

bool linkr_uart_reliable_mode(void)
{
	return atomic_get(&reliable_mode) != 0;
}

void linkr_uart_reliable_nus_selected(void)
{
	if (!atomic_get(&indication_enabled)) {
		atomic_clear(&reliable_mode);
	}
}

int linkr_uart_reliable_send(struct bt_conn *conn, const uint8_t *data,
			     uint16_t len)
{
	uint8_t fragment[FRAGMENT_MAX];
	struct reliable_header *header = (struct reliable_header *)fragment;
	uint16_t mtu_payload;
	uint16_t first_payload;
	uint16_t sent;
	int err;

	if (!conn || !data || !len || len > LINKR_UART_RELIABLE_MAX_PAYLOAD) {
		return -EINVAL;
	}
	mtu_payload = MIN((uint16_t)(bt_gatt_get_mtu(conn) - 3),
			  (uint16_t)sizeof(fragment));
	if (mtu_payload <= sizeof(*header)) {
		return -EMSGSIZE;
	}

	header->magic[0] = 'L';
	header->magic[1] = 'R';
	header->version = LINKR_UART_RELIABLE_API_MAJOR;
	header->flags = 0;
	sys_put_le32(tx_next_sequence, header->sequence_le);
	sys_put_le16(len, header->payload_len_le);
	header->reserved[0] = 0;
	header->reserved[1] = 0;
	first_payload = MIN(len, (uint16_t)(mtu_payload - sizeof(*header)));
	memcpy(fragment + sizeof(*header), data, first_payload);
	err = indicate_fragment(conn, fragment, sizeof(*header) + first_payload);
	if (err) {
		return err;
	}

	for (sent = first_payload; sent < len;) {
		uint16_t chunk = MIN((uint16_t)(len - sent), mtu_payload);

		err = indicate_fragment(conn, data + sent, chunk);
		if (err) {
			return err;
		}
		sent += chunk;
	}
	tx_acked_sequence = tx_next_sequence;
	tx_next_sequence = sequence_next(tx_next_sequence);
	return 0;
}
