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
#include <zephyr/bluetooth/hci.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/util.h>

#include "ble_mgmt.h"
#include "ext_ram.h"
#include "serial_session.h"
#include "watchdog.h"

LOG_MODULE_REGISTER(linkr_ble_mgmt, LOG_LEVEL_INF);

#define LINKR_MGMT_RX_TIMEOUT_MS 2000
#define LINKR_MGMT_REQUEST_QUEUE_DEPTH 2
#define LINKR_MGMT_TX_QUEUE_DEPTH CONFIG_LINKR_BLE_BRIDGE_MGMT_TX_QUEUE_DEPTH
#define LINKR_MGMT_INDICATE_TIMEOUT_MS 5000
#define LINKR_MGMT_FRAGMENT_MAX 244

#define LINKR_MGMT_CAPABILITIES                                               \
	(LINKR_MGMT_CAP_DEVICE_ID | LINKR_MGMT_CAP_RELIABLE_UART |             \
	 LINKR_MGMT_CAP_MULTI_SESSION |                                      \
	 (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WIFI) ?                            \
		(LINKR_MGMT_CAP_WIFI | LINKR_MGMT_CAP_ASYNC_EVENTS) : 0) |      \
	 (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WEBDAV) ?                          \
		LINKR_MGMT_CAP_WEBDAV : 0) |                                    \
	 (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE) ?                       \
		LINKR_MGMT_CAP_WEBSOCKET : 0))

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
	uint32_t epoch;
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
	uint8_t payload[];
};

struct linkr_mgmt_rx_state {
	struct bt_conn *conn;
	uint32_t epoch;
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
		LINKR_MGMT_CAPABILITIES & 0xff,
		(LINKR_MGMT_CAPABILITIES >> 8) & 0xff,
		0,
		0,
	},
};

static uint8_t stable_device_id[16];
static linkr_mgmt_request_handler_t request_handler;
/* Per-connection reassembly state: 512 B of payload each, only ever touched
 * from thread context (GATT command callback, WebDAV/WebSocket control path
 * and the mgmt_request thread) under rx_lock. */
static struct linkr_mgmt_rx_state rx_states[CONFIG_BT_MAX_CONN]
	LINKR_EXT_RAM_BSS;
static struct k_mutex rx_lock;
struct mgmt_tx_peer {
	struct k_mutex lock;
	bool active;
	struct k_sem done;
	struct bt_gatt_indicate_params params;
	int result;
	struct k_msgq queue;
	char storage[LINKR_MGMT_TX_QUEUE_DEPTH * sizeof(struct linkr_mgmt_tx_message *)] __aligned(4);
};
static struct mgmt_tx_peer tx_peers[CONFIG_BT_MAX_CONN];

/* Kept in DRAM, unlike rx_states above: the queue holds at most
 * LINKR_MGMT_REQUEST_QUEUE_DEPTH (2) requests, so its payload is ~1 KB, and
 * tests/test_ble_multipeer.py compiles this section of the file into a host
 * harness that expects the stock K_MSGQ_DEFINE expansion. */
K_MSGQ_DEFINE(request_queue, sizeof(struct linkr_mgmt_request),
	      LINKR_MGMT_REQUEST_QUEUE_DEPTH, 4);

static void tx_message_free(struct linkr_mgmt_tx_message *message)
{
	if (!message) {
		return;
	}
	if (message->conn) {
		bt_conn_unref(message->conn);
	}
	k_free(message);
}

static void rx_reset_locked(struct bt_conn *conn)
{
	struct linkr_mgmt_rx_state *rx = &rx_states[bt_conn_index(conn)];
	if (rx->conn) {
		bt_conn_unref(rx->conn);
	}
	memset(rx, 0, sizeof(*rx));
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

static int request_finish_locked(struct bt_conn *conn)
{
	struct linkr_mgmt_rx_state *rx = &rx_states[bt_conn_index(conn)];
	struct linkr_mgmt_request request = {
		.conn = rx->conn,
		.epoch = rx->epoch,
		.request_id = rx->request_id,
		.payload_len = rx->expected,
	};
	int err;

	memcpy(request.payload, rx->payload, request.payload_len);
	rx->conn = NULL;
	memset(rx, 0, sizeof(*rx));

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
	struct linkr_mgmt_rx_state *rx = &rx_states[bt_conn_index(conn)];
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

	if (rx->expected > 0 &&
	    k_uptime_get() - rx->started_at > LINKR_MGMT_RX_TIMEOUT_MS) {
		rx_reset_locked(conn);
	}

	if (rx->expected == 0) {
		if (len < sizeof(*header)) {
			err = BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
			goto out;
		}

		header = (const struct linkr_mgmt_header *)bytes;
		if (header->magic[0] != 'L' || header->magic[1] != 'K' ||
		    header->version != LINKR_MGMT_API_MAJOR ||
		    header->type != LINKR_MGMT_MSG_REQUEST ||
		    sys_get_le32(header->request_id_le) == 0) {
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

		rx->conn = bt_conn_ref(conn);
		rx->epoch = linkr_session_epoch(conn);
		rx->request_id = sys_get_le32(header->request_id_le);
		rx->expected = payload_len;
		rx->received = fragment_len;
		rx->started_at = k_uptime_get();
		memcpy(rx->payload, bytes + sizeof(*header), fragment_len);
	} else {
		uint16_t remaining = rx->expected - rx->received;

		if (len > remaining || rx->conn != conn) {
			rx_reset_locked(conn);
			err = BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
			goto out;
		}
		memcpy(rx->payload + rx->received, bytes, len);
		rx->received += len;
	}

	if (rx->received == rx->expected &&
	    request_finish_locked(conn) != 0) {
		err = BT_GATT_ERR(BT_ATT_ERR_INSUFFICIENT_RESOURCES);
	}

out:
	k_mutex_unlock(&rx_lock);
	return err ? err : len;
}

static void response_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);

	LOG_INF("Management indications %s",
		value == BT_GATT_CCC_INDICATE ? "enabled" : "disabled");
}

BT_GATT_SERVICE_DEFINE(linkr_mgmt_service,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_LINKR_MGMT_SERVICE),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_MGMT_PROTOCOL,
			       BT_GATT_CHRC_READ, BT_GATT_PERM_READ_ENCRYPT,
			       protocol_read, NULL, NULL),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_MGMT_DEVICE_ID,
			       BT_GATT_CHRC_READ, BT_GATT_PERM_READ_ENCRYPT,
			       device_id_read, NULL, NULL),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_MGMT_COMMAND,
			       BT_GATT_CHRC_WRITE, BT_GATT_PERM_WRITE_ENCRYPT,
			       NULL, command_write, NULL),
	BT_GATT_CHARACTERISTIC(BT_UUID_LINKR_MGMT_RESPONSE,
			       BT_GATT_CHRC_INDICATE, BT_GATT_PERM_READ_ENCRYPT,
			       NULL, NULL, NULL),
	BT_GATT_CCC(response_ccc_changed,
		    BT_GATT_PERM_READ_ENCRYPT | BT_GATT_PERM_WRITE_ENCRYPT));

static void indication_complete(struct bt_conn *conn,
				struct bt_gatt_indicate_params *params,
				uint8_t err)
{
	ARG_UNUSED(params);

	tx_peers[bt_conn_index(conn)].result = err ? -EIO : 0;
	/* params remains owned by the GATT stack until the destroy callback. */
}

static void indication_destroy(struct bt_gatt_indicate_params *params)
{
	struct mgmt_tx_peer *peer = CONTAINER_OF(params, struct mgmt_tx_peer, params);
	k_sem_give(&peer->done);
}

static int indicate_fragment(struct bt_conn *conn, const uint8_t *data,
			     uint16_t len)
{
	struct mgmt_tx_peer *peer = &tx_peers[bt_conn_index(conn)];
	int err;

	if (!bt_gatt_is_subscribed(conn, &linkr_mgmt_service.attrs[8],
				   BT_GATT_CCC_INDICATE)) {
		return -EACCES;
	}

	k_sem_reset(&peer->done);
	peer->result = -ETIMEDOUT;
	memset(&peer->params, 0, sizeof(peer->params));
	peer->params.attr = &linkr_mgmt_service.attrs[8];
	peer->params.func = indication_complete;
	peer->params.destroy = indication_destroy;
	peer->params.data = data;
	peer->params.len = len;

	err = bt_gatt_indicate(conn, &peer->params);
	if (err) {
		return err;
	}
	if (k_sem_take(&peer->done,
		       K_MSEC(LINKR_MGMT_INDICATE_TIMEOUT_MS)) != 0) {
		/* The params object cannot be reused until destroy runs. Disconnect to
		 * complete the outstanding ATT procedure, then wait for its cleanup. */
		LOG_WRN("Management indication timed out; disconnecting peer");
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
		(void)k_sem_take(&peer->done, K_FOREVER);
		return -ETIMEDOUT;
	}
	return peer->result;
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

	uint16_t mtu = bt_gatt_get_mtu(message->conn);

	/* Clamp before subtracting: an unexchanged MTU reads back as 0 and
	 * `0 - 3` in uint16_t wraps to 65533, which the MIN below would then
	 * carry into the fragment size. */
	mtu_payload = MIN(mtu > 3 ? mtu - 3 : 1, (uint16_t)sizeof(fragment));
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
			/* The header already promised the peer payload_len bytes, so
			 * stopping here leaves its reassembler waiting for fragments
			 * that will never arrive. Fail the connection the way the
			 * indication timeout above does, so the peer reconnects. */
			(void)bt_conn_disconnect(message->conn,
						 BT_HCI_ERR_REMOTE_USER_TERM_CONN);
			return;
		}
		sent += chunk;
	}
}

static void request_thread(void)
{
	struct linkr_mgmt_request request;

	for (;;) {
		linkr_watchdog_feed(LINKR_WDT_MGMT_REQUEST);
		if (k_msgq_get(&request_queue, &request, K_SECONDS(1)) != 0) {
			continue;
		}
		struct bt_conn_info info;
		if (request_handler && !bt_conn_get_info(request.conn, &info) &&
		    info.state == BT_CONN_STATE_CONNECTED) {
			request_handler(request.conn, request.request_id,
					request.payload, request.payload_len, request.epoch);
		}
		if (request.conn) {
			bt_conn_unref(request.conn);
		}
	}
}

void linkr_mgmt_tx_poll(struct bt_conn *conn)
{
	struct linkr_mgmt_tx_message *message;
	if (k_msgq_get(&tx_peers[bt_conn_index(conn)].queue, &message, K_NO_WAIT)) return;
	if (message && message->conn) tx_message_send(message);
	tx_message_free(message);
}

/* On the C5 target the measured high-water mark is 2140 B, so the
 * board overlay trims the default; STACK_SENTINEL guards the margin. */
K_THREAD_DEFINE(linkr_mgmt_request_tid,
		CONFIG_LINKR_BLE_BRIDGE_MGMT_REQUEST_STACK, request_thread,
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
	for (size_t i = 0; i < ARRAY_SIZE(tx_peers); i++) {
		k_mutex_init(&tx_peers[i].lock);
		k_sem_init(&tx_peers[i].done, 0, 1);
		k_msgq_init(&tx_peers[i].queue, tx_peers[i].storage,
			    sizeof(struct linkr_mgmt_tx_message *), LINKR_MGMT_TX_QUEUE_DEPTH);
	}

	LOG_INF("Linkr Management API v%u.%u ready",
		LINKR_MGMT_API_MAJOR, LINKR_MGMT_API_MINOR);
	return 0;
}

void linkr_mgmt_connected(struct bt_conn *conn)
{
	struct mgmt_tx_peer *peer = &tx_peers[bt_conn_index(conn)];
	k_mutex_lock(&peer->lock, K_FOREVER);
	peer->active = true;
	k_mutex_unlock(&peer->lock);
}

void linkr_mgmt_disconnected(struct bt_conn *conn)
{
	struct linkr_mgmt_rx_state *rx = &rx_states[bt_conn_index(conn)];
	k_mutex_lock(&rx_lock, K_FOREVER);
	if (rx->conn == conn) {
		rx_reset_locked(conn);
	}
	k_mutex_unlock(&rx_lock);
	struct mgmt_tx_peer *peer = &tx_peers[bt_conn_index(conn)];
	k_mutex_lock(&peer->lock, K_FOREVER);
	peer->active = false;
	struct linkr_mgmt_tx_message *message;
	while (!k_msgq_get(&tx_peers[bt_conn_index(conn)].queue, &message, K_NO_WAIT)) {
		tx_message_free(message);
	}
	k_mutex_unlock(&peer->lock);
	/* The shared request worker rejects disconnected peers without discarding
	 * another client's commands. */
}

int linkr_mgmt_send(struct bt_conn *conn, uint8_t type, uint32_t request_id,
		    uint16_t flags, const void *payload, uint16_t payload_len)
{
	struct linkr_mgmt_tx_message *message;
	int err;

	if (!conn || !payload || payload_len == 0 ||
	    payload_len > LINKR_MGMT_MAX_PAYLOAD ||
	    (type != LINKR_MGMT_MSG_RESPONSE &&
	     type != LINKR_MGMT_MSG_EVENT)) {
		return -EINVAL;
	}

	message = k_malloc(sizeof(*message) + payload_len);
	if (!message) {
		return -ENOMEM;
	}
	message->conn = bt_conn_ref(conn);
	message->request_id = request_id;
	message->flags = flags;
	message->payload_len = payload_len;
	message->type = type;
	memcpy(message->payload, payload, payload_len);

	struct mgmt_tx_peer *peer = &tx_peers[bt_conn_index(conn)];
	k_mutex_lock(&peer->lock, K_FOREVER);
	err = peer->active ? k_msgq_put(&peer->queue, &message, K_NO_WAIT) : -ENOTCONN;
	k_mutex_unlock(&peer->lock);
	if (err) {
		tx_message_free(message);
	}
	return err;
}
