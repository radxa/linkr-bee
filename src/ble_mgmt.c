/*
 * Linkr Bee Management Service v1.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/bluetooth/gatt.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/util.h>

#include "ble_mgmt.h"

LOG_MODULE_REGISTER(linkr_ble_mgmt, LOG_LEVEL_INF);

#define LINKR_MGMT_RX_TIMEOUT_MS 2000
#define LINKR_MGMT_REQUEST_QUEUE_DEPTH 2
/* A WiFi scan burst enqueues at most WIFI_SCAN_MAX_RESULTS results plus
 * the "done" line back to back (13 messages); the measured high-water mark
 * on the C5 target was 12, so the board overlay trims the default to just
 * enough for the full burst. */
#define LINKR_MGMT_TX_QUEUE_DEPTH CONFIG_LINKR_BLE_BRIDGE_MGMT_TX_QUEUE_DEPTH
#define LINKR_MGMT_INDICATE_TIMEOUT_MS 5000
#define LINKR_MGMT_FRAGMENT_MAX 244

struct linkr_mgmt_protocol_info {
	uint8_t major;
	uint8_t minor;
	uint8_t max_payload_le[2];
	uint8_t capabilities_le[4];
	uint8_t reserved[2];
} __packed;

struct linkr_mgmt_header {
	uint8_t magic[2];
	uint8_t version;
	uint8_t type;
	uint8_t request_id_le[4];
	uint8_t payload_len_le[2];
	uint8_t flags_le[2];
} __packed;

BUILD_ASSERT(sizeof(struct linkr_mgmt_header) == LINKR_MGMT_HEADER_SIZE);

struct linkr_mgmt_request {
	struct bt_conn *conn;
	uint32_t request_id;
	uint16_t payload_len;
	uint8_t payload[LINKR_MGMT_MAX_PAYLOAD];
};

struct linkr_mgmt_tx_message {
	struct bt_conn *conn;
	uint32_t request_id;
	uint16_t flags;
	uint16_t payload_len;
	uint8_t type;
	uint8_t payload[LINKR_MGMT_MAX_PAYLOAD];
};

struct linkr_mgmt_rx_state {
	struct bt_conn *conn;
	uint32_t request_id;
	uint16_t expected;
	uint16_t received;
	int64_t started_at;
	uint8_t payload[LINKR_MGMT_MAX_PAYLOAD];
};

static const struct linkr_mgmt_protocol_info protocol_info = {
	.major = LINKR_MGMT_API_MAJOR,
	.minor = LINKR_MGMT_API_MINOR,
	.max_payload_le = {
		LINKR_MGMT_MAX_PAYLOAD & 0xff,
		(LINKR_MGMT_MAX_PAYLOAD >> 8) & 0xff,
	},
	.capabilities_le = {
		(LINKR_MGMT_CAP_WIFI | LINKR_MGMT_CAP_WEBDAV |
		 LINKR_MGMT_CAP_WEBSOCKET | LINKR_MGMT_CAP_DEVICE_ID |
		 LINKR_MGMT_CAP_ASYNC_EVENTS |
		 LINKR_MGMT_CAP_RELIABLE_UART) & 0xff,
		((LINKR_MGMT_CAP_WIFI | LINKR_MGMT_CAP_WEBDAV |
		  LINKR_MGMT_CAP_WEBSOCKET | LINKR_MGMT_CAP_DEVICE_ID |
		  LINKR_MGMT_CAP_ASYNC_EVENTS |
		  LINKR_MGMT_CAP_RELIABLE_UART) >> 8) & 0xff,
		0,
		0,
	},
};

static uint8_t stable_device_id[16];
static linkr_mgmt_request_handler_t request_handler;
static struct linkr_mgmt_rx_state rx_state;
static struct k_mutex rx_lock;
static atomic_t indication_enabled;
static struct k_sem indication_done;
static struct bt_gatt_indicate_params indication_params;
static int indication_result;

K_MSGQ_DEFINE(request_queue, sizeof(struct linkr_mgmt_request),
	      LINKR_MGMT_REQUEST_QUEUE_DEPTH, 4);
K_MSGQ_DEFINE(tx_queue, sizeof(struct linkr_mgmt_tx_message),
	      LINKR_MGMT_TX_QUEUE_DEPTH, 4);

static void rx_reset_locked(void)
{
	if (rx_state.conn) {
		bt_conn_unref(rx_state.conn);
	}
	memset(&rx_state, 0, sizeof(rx_state));
}

static ssize_t protocol_read(struct bt_conn *conn,
			     const struct bt_gatt_attr *attr, void *buf,
			     uint16_t len, uint16_t offset)
{
	ARG_UNUSED(attr);

	return bt_gatt_attr_read(conn, attr, buf, len, offset, &protocol_info,
				 sizeof(protocol_info));
}

static ssize_t device_id_read(struct bt_conn *conn,
			      const struct bt_gatt_attr *attr, void *buf,
			      uint16_t len, uint16_t offset)
{
	ARG_UNUSED(attr);

	return bt_gatt_attr_read(conn, attr, buf, len, offset, stable_device_id,
				 sizeof(stable_device_id));
}

static int request_finish_locked(void)
{
	struct linkr_mgmt_request request = {
		.conn = rx_state.conn,
		.request_id = rx_state.request_id,
		.payload_len = rx_state.expected,
	};
	int err;

	memcpy(request.payload, rx_state.payload, request.payload_len);
	rx_state.conn = NULL;
	memset(&rx_state, 0, sizeof(rx_state));

	err = k_msgq_put(&request_queue, &request, K_NO_WAIT);
	if (err && request.conn) {
		bt_conn_unref(request.conn);
	}
	return err;
}

static ssize_t command_write(struct bt_conn *conn,
			     const struct bt_gatt_attr *attr, const void *buf,
			     uint16_t len, uint16_t offset, uint8_t flags)
{
	const uint8_t *bytes = buf;
	const struct linkr_mgmt_header *header;
	uint16_t payload_len;
	uint16_t fragment_len;
	int err = 0;

	ARG_UNUSED(attr);

	if (offset != 0 || (flags & BT_GATT_WRITE_FLAG_PREPARE)) {
		return BT_GATT_ERR(BT_ATT_ERR_NOT_SUPPORTED);
	}

	k_mutex_lock(&rx_lock, K_FOREVER);

	if (rx_state.expected > 0 &&
	    k_uptime_get() - rx_state.started_at > LINKR_MGMT_RX_TIMEOUT_MS) {
		rx_reset_locked();
	}

	if (rx_state.expected == 0) {
		if (len < sizeof(*header)) {
			err = BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
			goto out;
		}

		header = (const struct linkr_mgmt_header *)bytes;
		if (header->magic[0] != 'L' || header->magic[1] != 'K' ||
		    header->version != LINKR_MGMT_API_MAJOR ||
		    header->type != LINKR_MGMT_MSG_REQUEST) {
			err = BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
			goto out;
		}

		payload_len = sys_get_le16(header->payload_len_le);
		fragment_len = len - sizeof(*header);
		if (payload_len == 0 || payload_len > LINKR_MGMT_MAX_PAYLOAD ||
		    fragment_len > payload_len) {
			err = BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
			goto out;
		}

		rx_state.conn = bt_conn_ref(conn);
		rx_state.request_id = sys_get_le32(header->request_id_le);
		rx_state.expected = payload_len;
		rx_state.received = fragment_len;
		rx_state.started_at = k_uptime_get();
		memcpy(rx_state.payload, bytes + sizeof(*header), fragment_len);
	} else {
		uint16_t remaining = rx_state.expected - rx_state.received;

		if (len > remaining || rx_state.conn != conn) {
			rx_reset_locked();
			err = BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
			goto out;
		}
		memcpy(rx_state.payload + rx_state.received, bytes, len);
		rx_state.received += len;
	}

	if (rx_state.received == rx_state.expected &&
	    request_finish_locked() != 0) {
		err = BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
	}

out:
	k_mutex_unlock(&rx_lock);
	return err ? err : len;
}

static void response_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);

	atomic_set(&indication_enabled,
		   value == BT_GATT_CCC_INDICATE ? 1 : 0);
	LOG_INF("Management indications %s",
		atomic_get(&indication_enabled) ? "enabled" : "disabled");
}

BT_GATT_SERVICE_DEFINE(linkr_mgmt_service,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_LINKR_MGMT_SERVICE),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_MGMT_PROTOCOL,
			       BT_GATT_CHRC_READ, BT_GATT_PERM_READ,
			       protocol_read, NULL, NULL),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_MGMT_DEVICE_ID,
			       BT_GATT_CHRC_READ, BT_GATT_PERM_READ,
			       device_id_read, NULL, NULL),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_MGMT_COMMAND,
			       BT_GATT_CHRC_WRITE, BT_GATT_PERM_WRITE,
			       NULL, command_write, NULL),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_MGMT_RESPONSE,
			       BT_GATT_CHRC_INDICATE, BT_GATT_PERM_NONE,
			       NULL, NULL, NULL),
	BT_GATT_CCC(response_ccc_changed,
		    BT_GATT_PERM_READ | BT_GATT_PERM_WRITE));

static void indication_complete(struct bt_conn *conn,
				struct bt_gatt_indicate_params *params,
				uint8_t err)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(params);

	indication_result = err ? -EIO : 0;
	k_sem_give(&indication_done);
}

static int indicate_fragment(struct bt_conn *conn, const uint8_t *data,
			     uint16_t len)
{
	int err;

	if (!atomic_get(&indication_enabled) ||
	    !bt_gatt_is_subscribed(conn, &linkr_mgmt_service.attrs[8],
				   BT_GATT_CCC_INDICATE)) {
		return -EACCES;
	}

	k_sem_reset(&indication_done);
	indication_result = -ETIMEDOUT;
	memset(&indication_params, 0, sizeof(indication_params));
	indication_params.attr = &linkr_mgmt_service.attrs[8];
	indication_params.func = indication_complete;
	indication_params.data = data;
	indication_params.len = len;

	err = bt_gatt_indicate(conn, &indication_params);
	if (err) {
		return err;
	}
	if (k_sem_take(&indication_done,
		       K_MSEC(LINKR_MGMT_INDICATE_TIMEOUT_MS)) != 0) {
		return -ETIMEDOUT;
	}
	return indication_result;
}

static void tx_message_send(struct linkr_mgmt_tx_message *message)
{
	uint8_t fragment[LINKR_MGMT_FRAGMENT_MAX];
	struct linkr_mgmt_header *header =
		(struct linkr_mgmt_header *)fragment;
	uint16_t mtu_payload;
	uint16_t first_payload;
	uint16_t sent;
	int err;

	mtu_payload = MIN((uint16_t)(bt_gatt_get_mtu(message->conn) - 3),
			  (uint16_t)sizeof(fragment));
	if (mtu_payload < sizeof(*header)) {
		LOG_WRN("Management ATT payload too small: %u", mtu_payload);
		return;
	}

	header->magic[0] = 'L';
	header->magic[1] = 'K';
	header->version = LINKR_MGMT_API_MAJOR;
	header->type = message->type;
	sys_put_le32(message->request_id, header->request_id_le);
	sys_put_le16(message->payload_len, header->payload_len_le);
	sys_put_le16(message->flags, header->flags_le);

	first_payload = MIN(message->payload_len,
			    (uint16_t)(mtu_payload - sizeof(*header)));
	memcpy(fragment + sizeof(*header), message->payload, first_payload);
	err = indicate_fragment(message->conn, fragment,
				sizeof(*header) + first_payload);
	if (err) {
		LOG_WRN("Management indication start failed: %d", err);
		return;
	}

	sent = first_payload;
	while (sent < message->payload_len) {
		uint16_t chunk = MIN((uint16_t)(message->payload_len - sent),
				     mtu_payload);

		err = indicate_fragment(message->conn, message->payload + sent,
					chunk);
		if (err) {
			LOG_WRN("Management indication continuation failed: %d",
				err);
			return;
		}
		sent += chunk;
	}
}

static void request_thread(void)
{
	struct linkr_mgmt_request request;

	for (;;) {
		k_msgq_get(&request_queue, &request, K_FOREVER);
		if (request_handler) {
			request_handler(request.conn, request.request_id,
					request.payload, request.payload_len);
		}
		if (request.conn) {
			bt_conn_unref(request.conn);
		}
	}
}

static void tx_thread(void)
{
	struct linkr_mgmt_tx_message message;

	for (;;) {
		k_msgq_get(&tx_queue, &message, K_FOREVER);
		if (message.conn) {
			tx_message_send(&message);
			bt_conn_unref(message.conn);
		}
	}
}

/* On the C5 target the measured high-water mark is 2140 B, so the
 * board overlay trims the default; STACK_SENTINEL guards the margin. */
K_THREAD_DEFINE(linkr_mgmt_request_tid,
		CONFIG_LINKR_BLE_BRIDGE_MGMT_REQUEST_STACK, request_thread,
		NULL, NULL, NULL, 7, 0, 0);
K_THREAD_DEFINE(linkr_mgmt_tx_tid, 2048, tx_thread,
		NULL, NULL, NULL, 7, 0, 0);

int linkr_mgmt_init(linkr_mgmt_request_handler_t handler)
{
	static const uint8_t namespace_prefix[10] = {
		'L', 'I', 'N', 'K', 'R', 'B', 'L', 'E', 1, 0,
	};
	uint8_t hardware_id[6];
	ssize_t len;

	if (!handler) {
		return -EINVAL;
	}

	len = hwinfo_get_device_id(hardware_id, sizeof(hardware_id));
	if (len != sizeof(hardware_id)) {
		LOG_ERR("Hardware Device ID unavailable: %d", (int)len);
		return len < 0 ? (int)len : -ENODATA;
	}

	memcpy(stable_device_id, namespace_prefix, sizeof(namespace_prefix));
	memcpy(stable_device_id + sizeof(namespace_prefix), hardware_id,
	       sizeof(hardware_id));
	request_handler = handler;
	k_mutex_init(&rx_lock);
	k_sem_init(&indication_done, 0, 1);

	LOG_INF("Linkr Management API v%u.%u ready",
		LINKR_MGMT_API_MAJOR, LINKR_MGMT_API_MINOR);
	return 0;
}

void linkr_mgmt_disconnected(struct bt_conn *conn)
{
	struct linkr_mgmt_request request;
	struct linkr_mgmt_tx_message message;

	k_mutex_lock(&rx_lock, K_FOREVER);
	if (rx_state.conn == conn) {
		rx_reset_locked();
	}
	k_mutex_unlock(&rx_lock);
	atomic_clear(&indication_enabled);

	while (k_msgq_get(&request_queue, &request, K_NO_WAIT) == 0) {
		if (request.conn) {
			bt_conn_unref(request.conn);
		}
	}
	while (k_msgq_get(&tx_queue, &message, K_NO_WAIT) == 0) {
		if (message.conn) {
			bt_conn_unref(message.conn);
		}
	}
	k_sem_give(&indication_done);
}

int linkr_mgmt_send(struct bt_conn *conn, uint8_t type, uint32_t request_id,
		    uint16_t flags, const void *payload, uint16_t payload_len)
{
	struct linkr_mgmt_tx_message message = {
		.conn = conn ? bt_conn_ref(conn) : NULL,
		.request_id = request_id,
		.flags = flags,
		.payload_len = payload_len,
		.type = type,
	};
	int err;

	if (!conn || !payload || payload_len == 0 ||
	    payload_len > LINKR_MGMT_MAX_PAYLOAD ||
	    (type != LINKR_MGMT_MSG_RESPONSE &&
	     type != LINKR_MGMT_MSG_EVENT)) {
		if (message.conn) {
			bt_conn_unref(message.conn);
		}
		return -EINVAL;
	}

	memcpy(message.payload, payload, payload_len);
	err = k_msgq_put(&tx_queue, &message, K_NO_WAIT);
	if (err && message.conn) {
		bt_conn_unref(message.conn);
	}
	return err;
}
