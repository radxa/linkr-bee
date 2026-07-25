/*
 * UART-over-WebSocket LAN bridge for the Linkr BMC Lite bridge.
 *
 * Exposes the bridge UART as a binary WebSocket endpoint (ws://<ip>/ws)
 * while WiFi has an IP address. UART RX bytes are fanned out to every
 * connected client from the uart_to_ble thread via per-client ring
 * buffers; bytes received from clients are queued into the shared
 * BLE-to-UART path in main.c via linkr_uart_write().
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include "ws_bridge.h"
#include "wifi.h"

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(linkr_ws, LOG_LEVEL_INF);

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE)

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/net/http/server.h>
#include <zephyr/net/http/service.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/socket.h>
#include <zephyr/net/websocket.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/ring_buffer.h>

#define WS_MAX_CLIENTS CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_MAX_CLIENTS
#define WS_TX_BUF_SIZE CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_CLIENT_BUFFER_SIZE
#define WS_RX_BUF_SIZE 512
#define WS_TX_CHUNK 256
#define WS_AUTH_TIMEOUT_MS 3000
#define WS_POLL_MS 20

BUILD_ASSERT((WS_TX_BUF_SIZE & (WS_TX_BUF_SIZE - 1)) == 0,
	     "LINKR_BLE_BRIDGE_WS_BRIDGE_CLIENT_BUFFER_SIZE must be a power of two");

struct ws_client {
	atomic_t in_use;
	int sock;
	struct k_sem tx_sem;
	struct k_mutex tx_lock;
	struct ring_buf tx_ring;
	uint8_t tx_buf[WS_TX_BUF_SIZE];
	uint32_t tx_bytes;
	uint32_t rx_bytes;
	uint32_t tx_dropped;
};

static struct ws_client clients[WS_MAX_CLIENTS];
static struct k_thread ws_handler_threads[WS_MAX_CLIENTS];
K_THREAD_STACK_ARRAY_DEFINE(ws_client_stacks, WS_MAX_CLIENTS,
			    CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_STACK);

static uint8_t ws_rx_buf[WS_MAX_CLIENTS][WS_RX_BUF_SIZE];
static uint8_t ws_handshake_buf[1024];

static struct net_mgmt_event_callback ws_net_cb;
static atomic_t server_running;
static atomic_t active_clients;
static atomic_t ws_enabled = ATOMIC_INIT(1);

/* ------------------------------------------------------------------------ */
/* Settings persistence ("linkr/ws/en")                                      */
/* ------------------------------------------------------------------------ */

#define WS_SETTINGS_MAGIC 0x4C575320 /* "LWS " */
#define WS_SETTINGS_VERSION 1

struct ws_settings {
	uint32_t magic;
	uint8_t version;
	uint8_t enabled;
};

static int ws_settings_set(const char *name, size_t len,
			   settings_read_cb read_cb, void *cb_arg)
{
	struct ws_settings settings;
	ssize_t r;

	if (!settings_name_steq(name, "en", NULL) ||
	    len != sizeof(settings)) {
		return -ENOENT;
	}
	r = read_cb(cb_arg, &settings, sizeof(settings));
	if (r == sizeof(settings) && settings.magic == WS_SETTINGS_MAGIC &&
	    settings.version == WS_SETTINGS_VERSION && settings.enabled <= 1) {
		atomic_set(&ws_enabled, settings.enabled);
	}
	return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(linkr_ws, "linkr/ws", NULL, ws_settings_set,
			       NULL, NULL);

static int ws_settings_save(bool enabled)
{
	struct ws_settings settings = {
		.magic = WS_SETTINGS_MAGIC,
		.version = WS_SETTINGS_VERSION,
		.enabled = enabled ? 1 : 0,
	};

	return settings_save_one("linkr/ws/en", &settings, sizeof(settings));
}

/* ------------------------------------------------------------------------ */
/* Client handling                                                           */
/* ------------------------------------------------------------------------ */

static void ws_client_cleanup(struct ws_client *client)
{
	(void)websocket_unregister(client->sock);
	client->sock = -1;
	atomic_set(&client->in_use, 0);
	atomic_dec(&active_clients);
}

static bool ws_client_auth(struct ws_client *client, int slot)
{
	static const char token[] = CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN;
	struct zsock_pollfd fds[1];
	uint32_t message_type;
	uint64_t remaining;
	int received;

	if (!token[0]) {
		return true;
	}

	fds[0].fd = client->sock;
	fds[0].events = ZSOCK_POLLIN;
	if (zsock_poll(fds, 1, WS_AUTH_TIMEOUT_MS) <= 0) {
		return false;
	}
	received = websocket_recv_msg(client->sock, ws_rx_buf[slot],
				      sizeof(ws_rx_buf[slot]) - 1, &message_type,
				      &remaining, 0);
	if (received <= 0 || !(message_type & WEBSOCKET_FLAG_TEXT)) {
		return false;
	}
	return received == (int)strlen(token) &&
	       !memcmp(ws_rx_buf[slot], token, received);
}

static int ws_client_tx_drain(struct ws_client *client)
{
	uint8_t buf[WS_TX_CHUNK];

	if (k_sem_take(&client->tx_sem, K_NO_WAIT) != 0) {
		return 0;
	}
	for (;;) {
		uint32_t got;
		int err;

		k_mutex_lock(&client->tx_lock, K_FOREVER);
		got = ring_buf_get(&client->tx_ring, buf, sizeof(buf));
		k_mutex_unlock(&client->tx_lock);
		if (!got) {
			break;
		}
		err = websocket_send_msg(client->sock, buf, got,
					 WEBSOCKET_OPCODE_DATA_BINARY, false,
					 true, SYS_FOREVER_MS);
		if (err < 0) {
			return err;
		}
		client->tx_bytes += got;
	}
	return 0;
}

static void ws_client_thread(void *p1, void *p2, void *p3)
{
	int slot = POINTER_TO_INT(p1);
	struct ws_client *client = &clients[slot];
	struct zsock_pollfd fds[1];

	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	if (!ws_client_auth(client, slot)) {
		LOG_WRN("[%d] WS auth failed", slot);
		goto out;
	}
	LOG_INF("[%d] WS client connected", slot);

	fds[0].fd = client->sock;
	fds[0].events = ZSOCK_POLLIN;

	for (;;) {
		int ret = zsock_poll(fds, 1, WS_POLL_MS);

		if (ret < 0) {
			LOG_WRN("[%d] WS poll error: %d", slot, errno);
			break;
		}
		if (fds[0].revents & (ZSOCK_POLLHUP | ZSOCK_POLLERR | ZSOCK_POLLNVAL)) {
			break;
		}
		if (fds[0].revents & ZSOCK_POLLIN) {
			uint32_t message_type;
			uint64_t remaining;
			int received = websocket_recv_msg(
				client->sock, ws_rx_buf[slot],
				sizeof(ws_rx_buf[slot]), &message_type,
				&remaining, 0);

			if (received < 0 || (message_type & WEBSOCKET_FLAG_CLOSE)) {
				break;
			}
			if (message_type & WEBSOCKET_FLAG_PING) {
				(void)websocket_send_msg(client->sock,
							 ws_rx_buf[slot], received,
							 WEBSOCKET_OPCODE_PONG,
							 false, true, 100);
			} else if (received > 0 &&
				   (message_type & (WEBSOCKET_FLAG_BINARY |
						    WEBSOCKET_FLAG_TEXT))) {
				if (linkr_uart_write(ws_rx_buf[slot],
						     received) != 0) {
					LOG_WRN("[%d] UART queue full; "
						"dropping %d WS RX bytes",
						slot, received);
				} else {
					client->rx_bytes += received;
				}
			}
		}
		if (ws_client_tx_drain(client) != 0) {
			LOG_WRN("[%d] WS send failed; closing", slot);
			break;
		}
	}

out:
	LOG_INF("[%d] WS client disconnected", slot);
	ws_client_cleanup(client);
}

static int linkr_ws_setup(int ws_socket, struct http_request_ctx *request_ctx,
			  void *user_data)
{
	int slot = -1;

	ARG_UNUSED(request_ctx);
	ARG_UNUSED(user_data);

	for (int i = 0; i < WS_MAX_CLIENTS; i++) {
		if (!atomic_get(&clients[i].in_use)) {
			slot = i;
			break;
		}
	}
	if (slot < 0) {
		LOG_WRN("Rejecting WS client; all %d slots busy", WS_MAX_CLIENTS);
		return -ENOENT;
	}

	struct ws_client *client = &clients[slot];

	atomic_set(&client->in_use, 1);
	client->sock = ws_socket;
	client->tx_bytes = 0;
	client->rx_bytes = 0;
	client->tx_dropped = 0;
	k_sem_init(&client->tx_sem, 0, 1);
	k_mutex_init(&client->tx_lock);
	ring_buf_init(&client->tx_ring, sizeof(client->tx_buf), client->tx_buf);
	atomic_inc(&active_clients);

	k_thread_create(&ws_handler_threads[slot], ws_client_stacks[slot],
			K_THREAD_STACK_SIZEOF(ws_client_stacks[slot]),
			ws_client_thread, INT_TO_POINTER(slot), NULL, NULL,
			K_PRIO_PREEMPT(8), 0, K_NO_WAIT);
	if (IS_ENABLED(CONFIG_THREAD_NAME)) {
		char name[sizeof("ws[0]")];

		snprintk(name, sizeof(name), "ws[%d]", slot);
		k_thread_name_set(&ws_handler_threads[slot], name);
	}
	return 0;
}

/* ------------------------------------------------------------------------ */
/* HTTP/WebSocket service                                                    */
/* ------------------------------------------------------------------------ */

static uint16_t ws_service_port = CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_PORT;

/*
 * Bind explicitly to IPv4.  With a NULL host Zephyr prefers an IPv6 socket
 * when both address families are enabled.  IPv4-mapped connections are not
 * accepted reliably by the ESP32-C3 socket backend, leaving port 80
 * unreachable even though http_server_start() succeeds.
 */
HTTP_SERVICE_DEFINE(linkr_ws_service, "0.0.0.0", &ws_service_port,
		    CONFIG_HTTP_SERVER_MAX_CLIENTS, 10, NULL, NULL, NULL);

static struct http_resource_detail_websocket linkr_ws_resource_detail = {
	.common = {
		.type = HTTP_RESOURCE_TYPE_WEBSOCKET,
		.bitmask_of_supported_http_methods = BIT(HTTP_GET),
	},
	.cb = linkr_ws_setup,
	.data_buffer = ws_handshake_buf,
	.data_buffer_len = sizeof(ws_handshake_buf),
	.user_data = NULL,
};

HTTP_RESOURCE_DEFINE(linkr_ws_resource, linkr_ws_service, "/ws",
		     &linkr_ws_resource_detail);

/* ------------------------------------------------------------------------ */
/* Server lifecycle                                                          */
/* ------------------------------------------------------------------------ */

static void ws_close_all_clients(void)
{
	for (int i = 0; i < WS_MAX_CLIENTS; i++) {
		if (atomic_get(&clients[i].in_use)) {
			(void)zsock_shutdown(clients[i].sock, ZSOCK_SHUT_RDWR);
		}
	}
}

static bool ws_service_is_listening(void)
{
	return atomic_get(&server_running) && *linkr_ws_service.fd >= 0;
}

static int ws_server_start(void)
{
	int err = http_server_start();

	if (err && err != -EALREADY) {
		LOG_ERR("HTTP server start failed: %d", err);
		return err;
	}
	atomic_set(&server_running, 1);
	LOG_INF("WS bridge start requested on port %u", ws_service_port);
	return 0;
}

static void ws_server_stop(void)
{
	if (!atomic_cas(&server_running, 1, 0)) {
		return;
	}
	ws_close_all_clients();
	(void)http_server_stop();
	LOG_INF("WS bridge stopped");
}

static void ws_net_event_handler(struct net_mgmt_event_callback *cb,
				 uint64_t mgmt_event, struct net_if *iface)
{
	ARG_UNUSED(cb);
	ARG_UNUSED(iface);

	if (mgmt_event == NET_EVENT_IPV4_ADDR_ADD) {
		if (atomic_get(&ws_enabled)) {
			(void)ws_server_start();
		}
	} else if (mgmt_event == NET_EVENT_IPV4_ADDR_DEL) {
		ws_server_stop();
	}
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

int linkr_ws_init(void)
{
	net_mgmt_init_event_callback(&ws_net_cb, ws_net_event_handler,
				     NET_EVENT_IPV4_ADDR_ADD |
					     NET_EVENT_IPV4_ADDR_DEL);
	net_mgmt_add_event_callback(&ws_net_cb);
	return 0;
}

int linkr_ws_set_enabled(bool enabled)
{
	int err = ws_settings_save(enabled);

	if (err) {
		LOG_WRN("Persisting WS enabled flag failed: %d", err);
		return err;
	}
	atomic_set(&ws_enabled, enabled ? 1 : 0);
	if (!enabled) {
		ws_server_stop();
	} else if (linkr_wifi_has_ip()) {
		(void)ws_server_start();
	}
	return 0;
}

bool linkr_ws_is_enabled(void)
{
	return atomic_get(&ws_enabled);
}

void linkr_ws_feed(const uint8_t *data, size_t len)
{
	if (!atomic_get(&server_running) || !atomic_get(&active_clients)) {
		return;
	}
	for (int i = 0; i < WS_MAX_CLIENTS; i++) {
		struct ws_client *client = &clients[i];
		const uint8_t *src = data;
		size_t keep = len;
		uint32_t discarded = 0;
		uint32_t written;

		if (!atomic_get(&client->in_use)) {
			continue;
		}
		k_mutex_lock(&client->tx_lock, K_FOREVER);
		if (keep > WS_TX_BUF_SIZE) {
			discarded += keep - WS_TX_BUF_SIZE;
			src += keep - WS_TX_BUF_SIZE;
			keep = WS_TX_BUF_SIZE;
		}
		if (ring_buf_space_get(&client->tx_ring) < keep) {
			uint32_t oldest = keep - ring_buf_space_get(&client->tx_ring);

			discarded += ring_buf_get(&client->tx_ring, NULL, oldest);
		}
		written = ring_buf_put(&client->tx_ring, src, keep);
		k_mutex_unlock(&client->tx_lock);
		client->tx_dropped += discarded + keep - written;
		if (written) {
			k_sem_give(&client->tx_sem);
		}
	}
}

int linkr_ws_status(char *buf, size_t len)
{
	const char *state = !atomic_get(&ws_enabled) ? "off"
			    : ws_service_is_listening() ? "on"
							: "waiting";

	return snprintk(buf, len, "ws=%s port=%u clients=%d", state,
			ws_service_port, (int)atomic_get(&active_clients));
}

int linkr_ws_diagnostics(char *buf, size_t len)
{
	uint32_t tx = 0;
	uint32_t rx = 0;
	uint32_t dropped = 0;

	for (int i = 0; i < WS_MAX_CLIENTS; i++) {
		tx += clients[i].tx_bytes;
		rx += clients[i].rx_bytes;
		dropped += clients[i].tx_dropped;
	}
	return snprintk(buf, len,
			"state=%s port=%u clients=%d tx=%u rx=%u dropped=%u",
			!atomic_get(&ws_enabled) ? "off"
			: ws_service_is_listening() ? "up"
						: "down",
			ws_service_port, (int)atomic_get(&active_clients), tx,
			rx, dropped);
}

#endif /* CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE */
