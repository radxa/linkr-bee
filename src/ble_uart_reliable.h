/*
 * Linkr Reliable UART Service v1.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef LINKR_BLE_UART_RELIABLE_H
#define LINKR_BLE_UART_RELIABLE_H

#include <stddef.h>
#include <stdint.h>

#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>

#define LINKR_UART_RELIABLE_API_MAJOR 1
#define LINKR_UART_RELIABLE_HEADER_SIZE 12
/* ATT MTU 247 leaves 244 value bytes. Keep one Reliable frame in one ATT
 * value so the common path needs one confirmed transaction per UART chunk. */
#define LINKR_UART_RELIABLE_MAX_PAYLOAD 232

#define BT_UUID_LINKR_UART_RELIABLE_SERVICE_VAL \
	BT_UUID_128_ENCODE(0x4c4b0010, 0x9a7e, 0x4f4e, 0x8b8a, 0x3d6f12a0c001)
#define BT_UUID_LINKR_UART_RELIABLE_RX_VAL \
	BT_UUID_128_ENCODE(0x4c4b0011, 0x9a7e, 0x4f4e, 0x8b8a, 0x3d6f12a0c001)
#define BT_UUID_LINKR_UART_RELIABLE_TX_VAL \
	BT_UUID_128_ENCODE(0x4c4b0012, 0x9a7e, 0x4f4e, 0x8b8a, 0x3d6f12a0c001)
#define BT_UUID_LINKR_UART_RELIABLE_STATE_VAL \
	BT_UUID_128_ENCODE(0x4c4b0013, 0x9a7e, 0x4f4e, 0x8b8a, 0x3d6f12a0c001)

#define BT_UUID_LINKR_UART_RELIABLE_SERVICE \
	BT_UUID_DECLARE_128(BT_UUID_LINKR_UART_RELIABLE_SERVICE_VAL)
#define BT_UUID_LINKR_UART_RELIABLE_RX \
	BT_UUID_DECLARE_128(BT_UUID_LINKR_UART_RELIABLE_RX_VAL)
#define BT_UUID_LINKR_UART_RELIABLE_TX \
	BT_UUID_DECLARE_128(BT_UUID_LINKR_UART_RELIABLE_TX_VAL)
#define BT_UUID_LINKR_UART_RELIABLE_STATE \
	BT_UUID_DECLARE_128(BT_UUID_LINKR_UART_RELIABLE_STATE_VAL)

typedef int (*linkr_uart_reliable_write_fn)(const uint8_t *data, size_t len);

int linkr_uart_reliable_init(linkr_uart_reliable_write_fn write_fn);
void linkr_uart_reliable_disconnected(struct bt_conn *conn);

/* True while reliable mode owns UART-to-BLE delivery. It intentionally stays
 * true across a disconnect so an unconfirmed chunk can be retried after the
 * same client reconnects. A later NUS-only subscription selects raw mode. */
bool linkr_uart_reliable_mode(void);
void linkr_uart_reliable_nus_selected(void);

/* Send one UART chunk using a sequence-numbered confirmed indication. The
 * sequence advances only after the central confirms the indication. */
int linkr_uart_reliable_send(struct bt_conn *conn, const uint8_t *data,
			     uint16_t len);

/* Instrumentation for the confirmed-indication handoff, reported through the
 * `@i?` diagnostics path. Any pointer may be NULL. `slept_ms` is the wall time
 * this module spent in the -EBUSY/-ENOMEM retry backoff; `wait_max_ms` is the
 * longest single submit-to-confirmation wait observed. They answer whether the
 * measured 40-92 ms handoff stalls come from the backoff or from elsewhere. */
void linkr_uart_reliable_diag(uint32_t *total, uint32_t *retry, uint32_t *busy,
			      uint32_t *nomem, uint32_t *slept_ms,
			      uint32_t *timeout, uint32_t *wait_max_ms);

#endif /* LINKR_BLE_UART_RELIABLE_H */
