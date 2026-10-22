/* SPDX-License-Identifier: Apache-2.0 */
#include <zephyr/kernel.h>
#include <zephyr/net_buf.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/bluetooth/hci.h>
#include "ble_hci_order.h"

/* C3 controller callbacks are serialized in thread context. During LE
 * encryption startup it can deliver ACL before Encryption Change. Quarantine
 * those buffers until the matching successful event has entered the host FIFO.
 * Never synthesize encryption success or alter SMP's security checks.
 * Only one connection is supported by this application. */
#define PENDING_MAX 4
static bt_hci_recv_t host_receive;
static uint16_t pending_handle = UINT16_MAX;
static struct net_buf *pending[PENDING_MAX];
static size_t pending_count;

static void clear_pending(void)
{
	while (pending_count) net_buf_unref(pending[--pending_count]);
	pending_handle = UINT16_MAX;
}

static int ordered_receive(const struct device *dev, struct net_buf *buf)
{
	uint8_t *p = buf->data;
	bool complete = false, success = false;
	int result;

	if (buf->len >= 3 && p[0] == BT_HCI_H4_EVT) {
		if (p[1] == BT_HCI_EVT_LE_META_EVENT && buf->len >= 6 &&
		    p[3] == BT_HCI_EVT_LE_LTK_REQUEST) {
			clear_pending();
			pending_handle = sys_get_le16(p + 4);
		} else if (p[1] == BT_HCI_EVT_ENCRYPT_CHANGE && buf->len >= 7 &&
			   sys_get_le16(p + 4) == pending_handle) {
			complete = true;
			success = p[3] == 0 && p[6] != 0;
		} else if (p[1] == BT_HCI_EVT_DISCONN_COMPLETE && buf->len >= 7) {
			/* One connection only: a disconnect ends any quarantine,
			 * whatever handle it names. The link is gone, so the
			 * quarantined SMP distribution packets can never be used —
			 * and gating this on `pending_handle` left up to
			 * PENDING_MAX buffers out of the pool for the rest of the
			 * session whenever the handle did not match (a stale
			 * handle, a missed event, an abnormal disconnect). */
			clear_pending();
		}
	} else if (buf->len >= 5 && p[0] == BT_HCI_H4_ACL &&
		   (sys_get_le16(p + 1) & 0x0fff) == pending_handle) {
		/* Retain ownership, not a copy of keys. Overflow fails closed: the
		 * host cannot complete SMP with missing distribution packets. */
		if (pending_count < PENDING_MAX) pending[pending_count++] = buf;
		else net_buf_unref(buf);
		return 0;
	}

	result = host_receive(dev, buf);
	if (complete) {
		if (success && !result) {
			size_t count = pending_count;
			pending_count = 0;
			pending_handle = UINT16_MAX;
			for (size_t i = 0; i < count; i++) host_receive(dev, pending[i]);
		} else clear_pending();
	}
	return result;
}

bt_hci_recv_t linkr_hci_order_init(bt_hci_recv_t receive)
{
	clear_pending();
	host_receive = receive;
	return ordered_receive;
}
