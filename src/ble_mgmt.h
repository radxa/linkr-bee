/*
 * Linkr BLE Management Service v1.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef LINKR_BLE_MGMT_H
#define LINKR_BLE_MGMT_H

#include <stddef.h>
#include <stdint.h>

#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/sys/util.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LINKR_MGMT_API_MAJOR 1
#define LINKR_MGMT_API_MINOR 0
#define LINKR_MGMT_HEADER_SIZE 12
#define LINKR_MGMT_MAX_PAYLOAD 512

#define LINKR_MGMT_CAP_WIFI BIT(0)
#define LINKR_MGMT_CAP_WEBDAV BIT(1)
#define LINKR_MGMT_CAP_WEBSOCKET BIT(2)
#define LINKR_MGMT_CAP_DEVICE_ID BIT(3)
#define LINKR_MGMT_CAP_ASYNC_EVENTS BIT(4)
#define LINKR_MGMT_CAP_RELIABLE_UART BIT(5)

#define LINKR_MGMT_FLAG_FINAL BIT(0)
#define LINKR_MGMT_FLAG_ERROR BIT(1)
#define LINKR_MGMT_FLAG_ASYNC BIT(2)

enum linkr_mgmt_message_type {
	LINKR_MGMT_MSG_REQUEST = 1,
	LINKR_MGMT_MSG_RESPONSE = 2,
	LINKR_MGMT_MSG_EVENT = 3,
};

/*
 * UUID namespace:
 *   4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001  service
 *   4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001  protocol info (read)
 *   4c4b0003-9a7e-4f4e-8b8a-3d6f12a0c001  device id (read)
 *   4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001  command (write)
 *   4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001  response/event (indicate)
 */
#define BT_UUID_LINKR_MGMT_SERVICE_VAL \
	BT_UUID_128_ENCODE(0x4c4b0001, 0x9a7e, 0x4f4e, 0x8b8a, 0x3d6f12a0c001)
#define BT_UUID_LINKR_MGMT_PROTOCOL_VAL \
	BT_UUID_128_ENCODE(0x4c4b0002, 0x9a7e, 0x4f4e, 0x8b8a, 0x3d6f12a0c001)
#define BT_UUID_LINKR_MGMT_DEVICE_ID_VAL \
	BT_UUID_128_ENCODE(0x4c4b0003, 0x9a7e, 0x4f4e, 0x8b8a, 0x3d6f12a0c001)
#define BT_UUID_LINKR_MGMT_COMMAND_VAL \
	BT_UUID_128_ENCODE(0x4c4b0004, 0x9a7e, 0x4f4e, 0x8b8a, 0x3d6f12a0c001)
#define BT_UUID_LINKR_MGMT_RESPONSE_VAL \
	BT_UUID_128_ENCODE(0x4c4b0005, 0x9a7e, 0x4f4e, 0x8b8a, 0x3d6f12a0c001)

#define BT_UUID_LINKR_MGMT_SERVICE \
	BT_UUID_DECLARE_128(BT_UUID_LINKR_MGMT_SERVICE_VAL)
#define BT_UUID_LINKR_MGMT_PROTOCOL \
	BT_UUID_DECLARE_128(BT_UUID_LINKR_MGMT_PROTOCOL_VAL)
#define BT_UUID_LINKR_MGMT_DEVICE_ID \
	BT_UUID_DECLARE_128(BT_UUID_LINKR_MGMT_DEVICE_ID_VAL)
#define BT_UUID_LINKR_MGMT_COMMAND \
	BT_UUID_DECLARE_128(BT_UUID_LINKR_MGMT_COMMAND_VAL)
#define BT_UUID_LINKR_MGMT_RESPONSE \
	BT_UUID_DECLARE_128(BT_UUID_LINKR_MGMT_RESPONSE_VAL)

typedef void (*linkr_mgmt_request_handler_t)(struct bt_conn *conn,
					      uint32_t request_id,
					      const uint8_t *payload,
					      uint16_t payload_len);

/* Load the stable hardware Device ID and install the request handler. */
int linkr_mgmt_init(linkr_mgmt_request_handler_t handler);

/* Release per-connection RX state and queued messages after disconnect. */
void linkr_mgmt_disconnected(struct bt_conn *conn);

/* Send one logical response or event. The transport fragments it into
 * confirmed GATT indications and preserves request_id across all fragments. */
int linkr_mgmt_send(struct bt_conn *conn, uint8_t type, uint32_t request_id,
		    uint16_t flags, const void *payload, uint16_t payload_len);

static inline int linkr_mgmt_respond(struct bt_conn *conn, uint32_t request_id,
				     uint16_t flags, const void *payload,
				     uint16_t payload_len)
{
	return linkr_mgmt_send(conn, LINKR_MGMT_MSG_RESPONSE, request_id,
			      flags, payload, payload_len);
}

static inline int linkr_mgmt_event(struct bt_conn *conn, uint32_t operation_id,
				   uint16_t flags, const void *payload,
				   uint16_t payload_len)
{
	return linkr_mgmt_send(conn, LINKR_MGMT_MSG_EVENT, operation_id,
			      flags | LINKR_MGMT_FLAG_ASYNC, payload, payload_len);
}

#ifdef __cplusplus
}
#endif

#endif /* LINKR_BLE_MGMT_H */
