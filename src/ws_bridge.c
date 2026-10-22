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
#include <zephyr/random/random.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/ring_buffer.h>

#define WS_MAX_CLIENTS CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_MAX_CLIENTS
#define WS_TX_BUF_SIZE CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_CLIENT_BUFFER_SIZE
#define WS_RX_BUF_SIZE 512
#define WS_TX_CHUNK 256
#define WS_AUTH_TIMEOUT_MS 3000
#define WS_POLL_MS 20
/* Bound a single TX send so a client that stops reading (full TCP window) is
 * dropped instead of blocking its handler thread forever. */
#define WS_TX_TIMEOUT_MS 3000
/* Upper bound on the post-poll recv under the shared RX lock. poll() already
 * saw data ready, so this only covers a frame split across TCP segments. */
#define WS_AUTH_RECV_TIMEOUT_MS 500

/* The per-client TX ring is a byte-oriented Zephyr ring buffer: ring_buf_*
 * accept arbitrary sizes and nothing here masks the size (there is no
 * "& (WS_TX_BUF_SIZE - 1)" arithmetic), so a power-of-two size is not an
 * invariant this code needs. The assert that used to demand one rejected most
 * of the Kconfig range for no functional reason and was dropped instead. */
BUILD_ASSERT(sizeof(CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN) <=
		     WS_RX_BUF_SIZE,
	     "WebSocket auth token must fit in one receive buffer");

/* CLAIMED means the socket is registered but not yet authenticated: UART
 * fan-out only targets ACTIVE clients, and the handshake frame is written
 * before a client is promoted from CLAIMED to ACTIVE. */
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
#define WS_SETTINGS_VERSION 2
/* v1 stored only {magic, version, enabled}: no token, LAN access unauthenticated. */
#define WS_SETTINGS_V1_VERSION 1

/* 128-bit token rendered as lowercase hex: short enough to type from a phone,
 * long enough that guessing it on a LAN is not practical. */
#define WS_TOKEN_HEX_LEN 32

struct ws_settings_v1 {
	uint32_t magic;
	uint8_t version;
	uint8_t enabled;
};

struct ws_settings {
	uint32_t magic;
	uint8_t version;
	uint8_t enabled;
	char token[WS_TOKEN_HEX_LEN + 1];
};

static char ws_token[WS_TOKEN_HEX_LEN + 1];
static bool ws_token_loaded;
/* Set when a token is required but could not be obtained. The bridge then
 * refuses to listen rather than exposing the target console unauthenticated. */
static atomic_t ws_auth_blocked;
K_MUTEX_DEFINE(ws_token_lock);

static bool ws_token_hex_ok(const char *token)
{
	for (size_t i = 0; i < WS_TOKEN_HEX_LEN; i++) {
		char ch = token[i];

		if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) {
			return false;
		}
	}
	return true;
}

/* Validate a NUL-terminated string: exactly WS_TOKEN_HEX_LEN lowercase hex. */
static bool ws_token_str_valid(const char *token)
{
	return strlen(token) == WS_TOKEN_HEX_LEN && ws_token_hex_ok(token);
}

/* Validate the fixed-size settings field, which may be empty (auth disabled)
 * and is not guaranteed to be terminated if the record was corrupted. */
static bool ws_token_field_valid(const char *field, size_t capacity)
{
	if (field[capacity - 1] != '\0') {
		return false;
	}
	if (!field[0]) {
		return true;
	}
	return ws_token_str_valid(field);
}

/* Copy the token out for comparison. Returns 0 when LAN access is
 * unauthenticated, otherwise the token length. */
static size_t ws_token_snapshot(char *dest, size_t capacity)
{
	size_t len;

	k_mutex_lock(&ws_token_lock, K_FOREVER);
	len = strlen(ws_token);
	if (len + 1 > capacity) {
		len = 0;
		dest[0] = '\0';
	} else {
		memcpy(dest, ws_token, len + 1);
	}
	k_mutex_unlock(&ws_token_lock);

	return len;
}

/* Caller must hold ws_token_lock. */
static int ws_token_generate_locked(void)
{
	uint8_t raw[WS_TOKEN_HEX_LEN / 2];
	int err = sys_csrand_get(raw, sizeof(raw));

	if (err) {
		LOG_ERR("WebSocket token generation failed: %d", err);
		return err;
	}
	for (size_t i = 0; i < sizeof(raw); i++) {
		snprintk(&ws_token[i * 2], 3, "%02x", raw[i]);
	}
	ws_token[WS_TOKEN_HEX_LEN] = '\0';

	return 0;
}

static int ws_settings_set(const char *name, size_t len,
			   settings_read_cb read_cb, void *cb_arg)
{
	struct ws_settings settings;
	struct ws_settings_v1 legacy;
	ssize_t r;

	if (!settings_name_steq(name, "en", NULL)) {
		return -ENOENT;
	}

	if (len == sizeof(settings)) {
		r = read_cb(cb_arg, &settings, sizeof(settings));
		if (r != sizeof(settings) || settings.magic != WS_SETTINGS_MAGIC ||
		    settings.version != WS_SETTINGS_VERSION ||
		    settings.enabled > 1 ||
		    !ws_token_field_valid(settings.token,
					  sizeof(settings.token))) {
			LOG_WRN("ignoring invalid saved WebSocket settings");
			return 0;
		}
		atomic_set(&ws_enabled, settings.enabled);
		k_mutex_lock(&ws_token_lock, K_FOREVER);
		memcpy(ws_token, settings.token, sizeof(ws_token));
		ws_token_loaded = true;
		k_mutex_unlock(&ws_token_lock);
		return 0;
	}

	if (len == sizeof(legacy)) {
		r = read_cb(cb_arg, &legacy, sizeof(legacy));
		if (r == sizeof(legacy) && legacy.magic == WS_SETTINGS_MAGIC &&
		    legacy.version == WS_SETTINGS_V1_VERSION &&
		    legacy.enabled <= 1) {
			/* Pre-token record: keep the flag and mint a token below. */
			atomic_set(&ws_enabled, legacy.enabled);
			ws_token_loaded = false;
		}
		return 0;
	}

	return -ENOENT;
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

	k_mutex_lock(&ws_token_lock, K_FOREVER);
	memcpy(settings.token, ws_token, sizeof(settings.token));
	k_mutex_unlock(&ws_token_lock);

	return settings_save_one("linkr/ws/en", &settings, sizeof(settings));
}

/* Adopt a usable token. A record persisted in settings wins over the build-time
 * pin, because it is what "@s token" and "@s token off" write (an empty
 * persisted token is a valid record meaning "LAN auth disabled"); letting the
 * pin win here would silently revert an explicit revocation at the next boot.
 * The pin is therefore only applied when no record exists yet. A malformed pin
 * still blocks the listener outright, even when a record exists: this build
 * cannot state a valid credential, and failing closed is the safe outcome. */
static int ws_token_resolve(void)
{
	static const char configured[] =
		CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN;
	int err;

	if (configured[0] && !ws_token_str_valid(configured)) {
		LOG_ERR("CONFIG_LINKR_BLE_BRIDGE_WS_BRIDGE_AUTH_TOKEN must be "
			"exactly %d lowercase hex characters",
			WS_TOKEN_HEX_LEN);
		atomic_set(&ws_auth_blocked, 1);
		return -EINVAL;
	}

	if (ws_token_loaded) {
		return 0;
	}

	if (configured[0]) {
		k_mutex_lock(&ws_token_lock, K_FOREVER);
		memcpy(ws_token, configured, WS_TOKEN_HEX_LEN + 1);
		k_mutex_unlock(&ws_token_lock);
		return 0;
	}

	k_mutex_lock(&ws_token_lock, K_FOREVER);
	err = ws_token_generate_locked();
	k_mutex_unlock(&ws_token_lock);
	if (err) {
		atomic_set(&ws_auth_blocked, 1);
		return err;
	}

	err = ws_settings_save(atomic_get(&ws_enabled) != 0);
	if (err) {
		/* The token works for this boot; only persistence failed. */
		LOG_WRN("persisting WebSocket token failed: %d", err);
	}
	ws_token_loaded = true;
	return 0;
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

/* LAN handshake. The bridge announces whether a token is needed, so a client
 * never has to guess: sending a stale token to a bridge that no longer requires
 * one would otherwise be forwarded to the target console as UART input.
 *
 *   bridge -> client  "@ws auth=none"      no token; UART streaming starts
 *   bridge -> client  "@ws auth=required"  send the token as one text frame
 *   client -> bridge  "<32 lowercase hex>"
 *   bridge -> client  "@ws auth=ok"        accepted; UART streaming starts
 *
 * A mismatch closes the connection without a reply. UART data is always sent as
 * binary frames, so these text frames are unambiguous. */
#define WS_AUTH_NONE_FRAME "@ws auth=none\r\n"
#define WS_AUTH_REQUIRED_FRAME "@ws auth=required\r\n"
#define WS_AUTH_OK_FRAME "@ws auth=ok\r\n"
#define WS_HANDSHAKE_TIMEOUT_MS 1000

static int ws_send_text(struct ws_client *client, const char *frame)
{
	return websocket_send_msg(client->sock, (const uint8_t *)frame,
				  strlen(frame), WEBSOCKET_OPCODE_DATA_TEXT,
				  false, true, WS_HANDSHAKE_TIMEOUT_MS);
}

/* Returns false when the client must be dropped. Promotes the client to
 * WS_CLIENT_ACTIVE only once it may receive UART bytes. */
static bool ws_client_auth(struct ws_client *client, int slot)
{
	char token[WS_TOKEN_HEX_LEN + 1];
	struct zsock_pollfd fds[1];
	uint32_t message_type;
	uint64_t remaining;
	size_t token_len;
	bool authenticated = false;
	int received;

	token_len = ws_token_snapshot(token, sizeof(token));

	if (token_len == 0) {
		/* No token configured: no first frame is consumed, so an ad-hoc
		 * client can still write UART as soon as it sees auth=none. */
		if (ws_send_text(client, WS_AUTH_NONE_FRAME) < 0) {
			return false;
		}
		atomic_set(&client->state, WS_CLIENT_ACTIVE);
		return true;
	}

	if (ws_send_text(client, WS_AUTH_REQUIRED_FRAME) < 0) {
		return false;
	}

	fds[0].fd = client->sock;
	fds[0].events = ZSOCK_POLLIN;

	/* Wait for the token frame *outside* the shared RX lock: holding it across
	 * the whole auth window would let one client that never sends a token
	 * stall every other client's UART path for up to WS_AUTH_TIMEOUT_MS. */
	if (zsock_poll(fds, 1, WS_AUTH_TIMEOUT_MS) <= 0) {
		return false;
	}
	if (!(fds[0].revents & ZSOCK_POLLIN) ||
	    (fds[0].revents &
	     (ZSOCK_POLLHUP | ZSOCK_POLLERR | ZSOCK_POLLNVAL))) {
		return false;
	}

	/* Only the recv that touches the shared scratch buffer needs the lock.
	 * poll() already reported data ready, so this stays short; the bounded
	 * timeout still lets recv finish a frame split across TCP packets. */
	k_mutex_lock(&ws_rx_lock, K_FOREVER);
	received = websocket_recv_msg(client->sock, ws_rx_buf,
				      sizeof(ws_rx_buf) - 1, &message_type,
				      &remaining, WS_AUTH_RECV_TIMEOUT_MS);
	authenticated = received > 0 && remaining == 0 &&
			(message_type & WEBSOCKET_FLAG_TEXT) &&
			(message_type & WEBSOCKET_FLAG_FINAL) &&
			received == (int)token_len &&
			!memcmp(ws_rx_buf, token, token_len);
	if (authenticated && ws_client_rx_drain_locked(client, slot) != 0) {
		authenticated = false;
	}
	k_mutex_unlock(&ws_rx_lock);

	if (!authenticated || ws_send_text(client, WS_AUTH_OK_FRAME) < 0) {
		return false;
	}

	/* Fan-out only starts here: an unauthenticated socket must never be
	 * eligible for UART bytes, and the handshake must stay the first frame. */
	atomic_set(&client->state, WS_CLIENT_ACTIVE);
	return true;
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
					 true, WS_TX_TIMEOUT_MS);
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
		if (atomic_get(&client->state) != WS_CLIENT_CLAIMED) {
			continue;
		}

		/* Publishes WS_CLIENT_ACTIVE only after the token is accepted and the
		 * handshake frame is out, so UART fan-out cannot precede either. */
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
	/* The slot stays CLAIMED until the client thread authenticates it; only
	 * ws_client_auth() publishes WS_CLIENT_ACTIVE. */
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
	int err;

	if (atomic_get(&ws_auth_blocked)) {
		/* Fail closed: without a token the LAN socket would expose the target
		 * console to anyone who can reach the port. */
		LOG_ERR("Refusing to start WS bridge: no auth token available");
		return -EACCES;
	}

	err = http_server_start();
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

	/* Settings are already loaded by main.c, so this either adopts the
	 * persisted token, adopts a build-time token, or mints one. */
	(void)ws_token_resolve();

	if (atomic_get(&ws_enabled) && linkr_wifi_has_ip()) {
		return ws_server_start();
	}
	return 0;
}

int linkr_ws_set_token(const char *token)
{
	int err;

	if (token && token[0] && !ws_token_str_valid(token)) {
		return -EINVAL;
	}

	k_mutex_lock(&ws_token_lock, K_FOREVER);
	if (token && token[0]) {
		memcpy(ws_token, token, WS_TOKEN_HEX_LEN + 1);
	} else {
		/* Empty token means "no LAN authentication" and is only reachable
		 * through an explicit command. */
		ws_token[0] = '\0';
	}
	k_mutex_unlock(&ws_token_lock);
	ws_token_loaded = true;
	atomic_clear(&ws_auth_blocked);

	err = ws_settings_save(atomic_get(&ws_enabled) != 0);
	if (err) {
		/* The credential is already live in RAM, so the change has taken
		 * effect; only its survival across a reboot is at risk. Reporting
		 * the failure would tell the caller to retry, and a retry replaces
		 * the token again — invalidating the one just handed out. */
		LOG_WRN("WebSocket token not persisted: %d (applies now, not after reboot)",
			err);
	}

	/* The token is the LAN credential, so a session that authenticated with the
	 * previous value must not outlive the change; without this, "@s token" and
	 * "@s token off" would not revoke an already-open client. */
	ws_close_all_clients();

	/* Mirror linkr_ws_rotate_token(): recovering from a blocked boot (or any
	 * enabled-but-not-listening state) must actually start the bridge. */
	if (atomic_get(&ws_enabled) && linkr_wifi_has_ip() &&
	    !ws_service_is_listening()) {
		(void)ws_server_start();
	}

	LOG_INF("WebSocket LAN auth %s", (token && token[0]) ? "token set" : "disabled");
	return 0;
}

int linkr_ws_rotate_token(void)
{
	int err;
	bool was_blocked = atomic_get(&ws_auth_blocked) != 0;

	k_mutex_lock(&ws_token_lock, K_FOREVER);
	err = ws_token_generate_locked();
	k_mutex_unlock(&ws_token_lock);
	if (err) {
		return err;
	}
	ws_token_loaded = true;
	atomic_clear(&ws_auth_blocked);

	err = ws_settings_save(atomic_get(&ws_enabled) != 0);
	if (err) {
		/* Same as linkr_ws_set_token(): the rotation is already live, so
		 * only persistence is at risk. A retry would generate yet another
		 * token and invalidate the one the caller was just given. */
		LOG_WRN("WebSocket token not persisted: %d (applies now, not after reboot)",
			err);
	}

	/* Revoke sessions that authenticated with the replaced token; see
	 * linkr_ws_set_token(). */
	ws_close_all_clients();

	/* Recover from a boot where entropy was unavailable: the bridge refused to
	 * listen, so start it now that a token exists. */
	if (was_blocked && atomic_get(&ws_enabled) && linkr_wifi_has_ip()) {
		(void)ws_server_start();
	}
	LOG_INF("WebSocket LAN auth token generated");
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
		/* Surface a fail-closed start (for example, no auth token) instead
		 * of reporting OK while nothing is actually listening. */
		err = ws_server_start();
		if (err) {
			return err;
		}
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
	char token[WS_TOKEN_HEX_LEN + 1];
	const char *state;
	size_t token_len;

	if (!atomic_get(&ws_enabled)) {
		state = "off";
	} else if (atomic_get(&ws_auth_blocked)) {
		state = "blocked";
	} else {
		state = ws_service_is_listening() ? "on" : "waiting";
	}

	/* The token is only reported here, never in linkr_ws_diagnostics(): "@s?"
	 * travels over the encrypted BLE management channel, while "@i?" output is
	 * routinely pasted into bug reports. */
	token_len = ws_token_snapshot(token, sizeof(token));

	return snprintk(buf, len, "ws=%s port=%u clients=%d token=%s", state,
			ws_service_port, (int)atomic_get(&active_clients),
			token_len ? token : "none");
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
