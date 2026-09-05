/*
 * UART-over-WebSocket LAN bridge for the Linkr Bee bridge.
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
BUILD_ASSERT(sizeof(CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN) <=
		     WS_RX_BUF_SIZE,
	     "WebSocket auth token must fit in one receive buffer");

enum ws_client_state {
	WS_CLIENT_FREE,
	WS_CLIENT_CLAIMED,
	WS_CLIENT_ACTIVE,
	WS_CLIENT_CLOSING,
};

struct ws_client {
	atomic_t state;
	int sock;
	struct k_sem start_sem;
	struct k_sem tx_sem;
	struct k_mutex tx_lock;
	struct ring_buf tx_ring;
	uint8_t tx_buf[WS_TX_BUF_SIZE];
	atomic_t tx_bytes;
	atomic_t rx_bytes;
	atomic_t tx_dropped;
	bool rx_fragmented;
};

static struct ws_client clients[WS_MAX_CLIENTS];
static struct k_thread ws_handler_threads[WS_MAX_CLIENTS];
K_THREAD_STACK_ARRAY_DEFINE(ws_client_stacks, WS_MAX_CLIENTS,
			    CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_STACK);

/* All upgraded-socket receive calls are serialized by ws_rx_lock, so one
 * scratch buffer is sufficient regardless of the configured client count. */
static uint8_t ws_rx_buf[WS_RX_BUF_SIZE];
static uint8_t ws_handshake_buf[1024];
/* Zephyr's HTTP resource API supplies one receive scratch buffer per resource,
 * not per upgraded socket. Drain it to EAGAIN under this lock so two client
 * parsers never retain or overwrite each other's buffered bytes. */
K_MUTEX_DEFINE(ws_rx_lock);

static struct net_mgmt_event_callback ws_net_cb;
static atomic_t server_running;
static atomic_t active_clients;
static atomic_t ws_enabled = ATOMIC_INIT(1);

static int ws_client_rx_drain_locked(struct ws_client *client, int slot);

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
	int sock;

	atomic_set(&client->state, WS_CLIENT_CLOSING);

	k_mutex_lock(&client->tx_lock, K_FOREVER);
	sock = client->sock;
	client->sock = -1;
	client->rx_fragmented = false;
	ring_buf_reset(&client->tx_ring);
	while (k_sem_take(&client->tx_sem, K_NO_WAIT) == 0) {
	}
	k_mutex_unlock(&client->tx_lock);
	if (sock >= 0) {
		(void)websocket_unregister(sock);
	}

	atomic_dec(&active_clients);
	/* Publishing FREE is the final teardown action. The persistent handler
	 * thread loops back to start_sem, so neither its stack nor sync objects are
	 * reinitialized while another context may still reference them. */
	atomic_set(&client->state, WS_CLIENT_FREE);
}

static bool ws_client_auth(struct ws_client *client, int slot)
{
	static const char token[] = CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN;
	struct zsock_pollfd fds[1];
	uint32_t message_type;
	uint64_t remaining;
	int64_t deadline;
	bool authenticated;
	int received;

	if (!token[0]) {
		return true;
	}

	fds[0].fd = client->sock;
	fds[0].events = ZSOCK_POLLIN;
	deadline = k_uptime_get() + WS_AUTH_TIMEOUT_MS;
	if (zsock_poll(fds, 1, WS_AUTH_TIMEOUT_MS) <= 0) {
		return false;
	}
	if (!(fds[0].revents & ZSOCK_POLLIN) ||
	    (fds[0].revents &
	     (ZSOCK_POLLHUP | ZSOCK_POLLERR | ZSOCK_POLLNVAL))) {
		return false;
	}
	k_mutex_lock(&ws_rx_lock, K_FOREVER);
	/* poll() only proves that some bytes are ready. Let recv finish a frame
	 * split across TCP packets, while keeping the original auth deadline. */
	int32_t timeout_ms = (int32_t)MAX(deadline - k_uptime_get(), 0);

	received = websocket_recv_msg(client->sock, ws_rx_buf,
				      sizeof(ws_rx_buf) - 1, &message_type,
				      &remaining, timeout_ms);
	authenticated = received > 0 && remaining == 0 &&
			(message_type & WEBSOCKET_FLAG_TEXT) &&
			(message_type & WEBSOCKET_FLAG_FINAL) &&
			received == (int)strlen(token) &&
			!memcmp(ws_rx_buf, token, received);
	if (authenticated && ws_client_rx_drain_locked(client, slot) != 0) {
		authenticated = false;
	}
	k_mutex_unlock(&ws_rx_lock);
	return authenticated;
}

static bool ws_client_is_data_fragment(struct ws_client *client,
				       uint32_t message_type,
				       uint64_t remaining)
{
	bool starts_data = (message_type & (WEBSOCKET_FLAG_BINARY |
					   WEBSOCKET_FLAG_TEXT)) != 0;
	bool control = (message_type & (WEBSOCKET_FLAG_CLOSE |
					WEBSOCKET_FLAG_PING |
					WEBSOCKET_FLAG_PONG)) != 0;
	bool continuation = !starts_data && !control && client->rx_fragmented;

	if (remaining == 0) {
		if (starts_data) {
			client->rx_fragmented =
				(message_type & WEBSOCKET_FLAG_FINAL) == 0;
		} else if (continuation &&
			   (message_type & WEBSOCKET_FLAG_FINAL)) {
			client->rx_fragmented = false;
		}
	}
	return starts_data || continuation;
}

static int ws_client_rx_drain_locked(struct ws_client *client, int slot)
{
	for (;;) {
		uint32_t message_type;
		uint64_t remaining;
		int received = websocket_recv_msg(
			client->sock, ws_rx_buf, sizeof(ws_rx_buf),
			&message_type, &remaining, 0);

		if (received == -EAGAIN) {
			return 0;
		}
		if (received < 0 || (message_type & WEBSOCKET_FLAG_CLOSE)) {
			return received < 0 ? received : -ENOTCONN;
		}
		if (message_type & WEBSOCKET_FLAG_PING) {
			(void)websocket_send_msg(client->sock, ws_rx_buf,
					 received, WEBSOCKET_OPCODE_PONG, false,
					 true, 100);
		} else if (ws_client_is_data_fragment(client, message_type,
						   remaining) &&
			   received > 0) {
			if (linkr_uart_write(ws_rx_buf, received) != 0) {
				LOG_WRN("[%d] UART queue full; dropping %d WS RX bytes",
					slot, received);
			} else {
				atomic_add(&client->rx_bytes, received);
			}
		}
	}
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
		atomic_add(&client->tx_bytes, got);
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

	for (;;) {
		k_sem_take(&client->start_sem, K_FOREVER);
		if (atomic_get(&client->state) != WS_CLIENT_ACTIVE) {
			continue;
		}

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
			if (fds[0].revents &
			    (ZSOCK_POLLHUP | ZSOCK_POLLERR | ZSOCK_POLLNVAL)) {
				break;
			}
			if (fds[0].revents & ZSOCK_POLLIN) {
				int err;

				k_mutex_lock(&ws_rx_lock, K_FOREVER);
				err = ws_client_rx_drain_locked(client, slot);
				k_mutex_unlock(&ws_rx_lock);
				if (err) {
					break;
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
}

static int linkr_ws_setup(int ws_socket, struct http_request_ctx *request_ctx,
			  void *user_data)
{
	int slot = -1;

	ARG_UNUSED(request_ctx);
	ARG_UNUSED(user_data);

	for (int i = 0; i < WS_MAX_CLIENTS; i++) {
		if (atomic_cas(&clients[i].state, WS_CLIENT_FREE,
			       WS_CLIENT_CLAIMED)) {
			slot = i;
			break;
		}
	}
	if (slot < 0) {
		LOG_WRN("Rejecting WS client; all %d slots busy", WS_MAX_CLIENTS);
		return -ENOENT;
	}

	struct ws_client *client = &clients[slot];

	k_mutex_lock(&client->tx_lock, K_FOREVER);
	client->sock = ws_socket;
	client->rx_fragmented = false;
	atomic_clear(&client->tx_bytes);
	atomic_clear(&client->rx_bytes);
	atomic_clear(&client->tx_dropped);
	ring_buf_reset(&client->tx_ring);
	while (k_sem_take(&client->tx_sem, K_NO_WAIT) == 0) {
	}
	k_mutex_unlock(&client->tx_lock);

	atomic_inc(&active_clients);
	atomic_set(&client->state, WS_CLIENT_ACTIVE);
	k_sem_give(&client->start_sem);
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
		k_mutex_lock(&clients[i].tx_lock, K_FOREVER);
		if (atomic_get(&clients[i].state) != WS_CLIENT_FREE &&
		    clients[i].sock >= 0) {
			(void)zsock_shutdown(clients[i].sock, ZSOCK_SHUT_RDWR);
		}
		k_mutex_unlock(&clients[i].tx_lock);
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
	for (int i = 0; i < WS_MAX_CLIENTS; i++) {
		struct ws_client *client = &clients[i];

		client->sock = -1;
		atomic_set(&client->state, WS_CLIENT_FREE);
		k_sem_init(&client->start_sem, 0, 1);
		k_sem_init(&client->tx_sem, 0, 1);
		k_mutex_init(&client->tx_lock);
		ring_buf_init(&client->tx_ring, sizeof(client->tx_buf),
			      client->tx_buf);
		k_thread_create(&ws_handler_threads[i], ws_client_stacks[i],
				K_THREAD_STACK_SIZEOF(ws_client_stacks[i]),
				ws_client_thread, INT_TO_POINTER(i), NULL, NULL,
				K_PRIO_PREEMPT(8), 0, K_NO_WAIT);
		if (IS_ENABLED(CONFIG_THREAD_NAME)) {
			char name[sizeof("ws[0]")];

			snprintk(name, sizeof(name), "ws[%d]", i);
			k_thread_name_set(&ws_handler_threads[i], name);
		}
	}

	net_mgmt_init_event_callback(&ws_net_cb, ws_net_event_handler,
				     NET_EVENT_IPV4_ADDR_ADD |
					     NET_EVENT_IPV4_ADDR_DEL);
	net_mgmt_add_event_callback(&ws_net_cb);
	if (atomic_get(&ws_enabled) && linkr_wifi_has_ip()) {
		return ws_server_start();
	}
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

		if (atomic_get(&client->state) != WS_CLIENT_ACTIVE) {
			continue;
		}
		k_mutex_lock(&client->tx_lock, K_FOREVER);
		if (atomic_get(&client->state) != WS_CLIENT_ACTIVE) {
			k_mutex_unlock(&client->tx_lock);
			continue;
		}
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
		atomic_add(&client->tx_dropped, discarded + keep - written);
		if (written) {
			k_sem_give(&client->tx_sem);
		}
		k_mutex_unlock(&client->tx_lock);
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
		tx += (uint32_t)atomic_get(&clients[i].tx_bytes);
		rx += (uint32_t)atomic_get(&clients[i].rx_bytes);
		dropped += (uint32_t)atomic_get(&clients[i].tx_dropped);
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
