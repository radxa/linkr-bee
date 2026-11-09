/* SPDX-License-Identifier: Apache-2.0 */
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>
#include "serial_session.h"
#include "linkr_status_led.h"

#define SESSION_COUNT (CONFIG_BT_MAX_CONN + 4)

/* How long an owner may go without writing before another session may take the
 * console on its own. An explicit @c claim is always immediate; this window is
 * only for the seamless path (a keystroke on a read-only client). */
#ifndef CONFIG_LINKR_BLE_BRIDGE_SESSION_IDLE_MS
#define CONFIG_LINKR_BLE_BRIDGE_SESSION_IDLE_MS 3000
#endif

static struct {
	const void *peer;
	uint32_t id;
	enum linkr_session_transport transport;
	bool managed;
} sessions[SESSION_COUNT];
static uint32_t next_id;
static uint32_t owner;
static uint32_t epoch = 1;
static uint32_t owner_active_ms;
K_MUTEX_DEFINE(session_lock);

static void ownership_changed(void)
{
	linkr_status_led_ai(false);
	if (++epoch == 0) ++epoch;
}

static void owner_touch(uint32_t now)
{
	owner_active_ms = now;
}

/* Wrapping-safe: both values come from the same 32-bit uptime counter. */
static bool owner_is_idle(uint32_t now)
{
	return owner && (uint32_t)(now - owner_active_ms) >=
		(uint32_t)CONFIG_LINKR_BLE_BRIDGE_SESSION_IDLE_MS;
}

static void set_owner(uint32_t id, uint32_t now)
{
	owner = id;
	owner_touch(now);
	ownership_changed();
}

static uint32_t peer_id(const void *peer)
{
	for (size_t i = 0; i < SESSION_COUNT; i++) {
		if (sessions[i].peer == peer) return sessions[i].id;
	}
	return 0;
}

static bool peer_managed(const void *peer)
{
	for (size_t i = 0; i < SESSION_COUNT; i++) {
		if (sessions[i].peer == peer) return sessions[i].managed;
	}
	return true;
}

int linkr_session_open(const void *peer, enum linkr_session_transport transport)
{
	int result = -ENOMEM;
	if (!peer) return -EINVAL;
	k_mutex_lock(&session_lock, K_FOREVER);
	if (peer_id(peer)) { result = 0; goto out; }
	for (size_t i = 0; i < SESSION_COUNT; i++) {
		if (sessions[i].peer) continue;
		if (++next_id == 0) ++next_id;
		sessions[i].peer = peer;
		sessions[i].id = next_id;
		sessions[i].transport = transport;
		result = 0;
		break;
	}
out:
	k_mutex_unlock(&session_lock);
	return result;
}

void linkr_session_close(const void *peer)
{
	k_mutex_lock(&session_lock, K_FOREVER);
	for (size_t i = 0; i < SESSION_COUNT; i++) {
		if (sessions[i].peer != peer) continue;
		if (owner == sessions[i].id) { owner = 0; owner_active_ms = 0; ownership_changed(); }
		memset(&sessions[i], 0, sizeof(sessions[i]));
	}
	k_mutex_unlock(&session_lock);
}

uint32_t linkr_session_ticket(const void *peer, bool claim_if_idle)
{
	uint32_t ticket = 0;
	uint32_t now = k_uptime_get_32();
	k_mutex_lock(&session_lock, K_FOREVER);
	uint32_t id = peer_id(peer);
	/* A free console still needs an explicit claim from a client that has
	 * used the control API before (release means release). An owner that has
	 * stopped writing is different: the first keystroke from another session
	 * takes over, which is what makes hand-over feel seamless for a human. */
	if (id && claim_if_idle) {
		if (!owner) {
			if (!peer_managed(peer)) set_owner(id, now);
		} else if (owner != id && owner_is_idle(now)) {
			set_owner(id, now);
		}
	}
	if (id && owner == id) ticket = epoch;
	k_mutex_unlock(&session_lock);
	return ticket;
}

bool linkr_session_begin(uint32_t ticket)
{
	k_mutex_lock(&session_lock, K_FOREVER);
	if (ticket && owner && ticket == epoch) {
		owner_touch(k_uptime_get_32());
		return true;
	}
	k_mutex_unlock(&session_lock);
	return false;
}

void linkr_session_end(void)
{
	k_mutex_unlock(&session_lock);
}

uint32_t linkr_session_epoch(const void *peer)
{
	k_mutex_lock(&session_lock, K_FOREVER);
	uint32_t result = peer_id(peer) ? epoch : 0;
	k_mutex_unlock(&session_lock);
	return result;
}

bool linkr_session_command_begin(const void *peer, uint32_t queued_epoch)
{
	uint32_t now = k_uptime_get_32();
	k_mutex_lock(&session_lock, K_FOREVER);
	uint32_t self = peer_id(peer);
	if (!self || !queued_epoch || queued_epoch != epoch) {
		k_mutex_unlock(&session_lock);
		return false;
	}
	if (!owner) {
		if (peer_managed(peer)) {
			k_mutex_unlock(&session_lock);
			return false;
		}
		set_owner(self, now);
	} else if (owner != self) {
		if (!owner_is_idle(now)) {
			k_mutex_unlock(&session_lock);
			return false;
		}
		set_owner(self, now);
	} else {
		owner_touch(now);
	}
	return true;
}

static bool session_control(const void *peer, const char *command,
			    char *response, size_t capacity, bool managed)
{
	const char *action;
	if (!strcmp(command, "c?") || !strcmp(command, "control?")) action = "?";
	else if (!strncmp(command, "c ", 2)) action = command + 2;
	else if (!strncmp(command, "control ", 8)) action = command + 8;
	else return false;
	k_mutex_lock(&session_lock, K_FOREVER);
	uint32_t self = peer_id(peer);
	for (size_t i = 0; i < SESSION_COUNT; i++) {
		if (sessions[i].peer == peer && managed) sessions[i].managed = true;
	}
	const char *error = NULL;
	if (!self) error = "disconnected";
	else if (!strcmp(action, "claim")) {
		/* Explicit request: the user asked for the console, so take it even
		 * from a session that is currently typing. The old owner becomes
		 * read-only on its next status poll; its in-flight bytes still finish. */
		if (!self) error = "disconnected";
		else if (owner == self) owner_touch(k_uptime_get_32());
		else set_owner(self, k_uptime_get_32());
	} else if (!strcmp(action, "claim idle")) {
		/* Seamless path: steal only when the current owner has stopped
		 * writing. An active typist keeps the console. */
		uint32_t now = k_uptime_get_32();
		if (owner && owner != self && !owner_is_idle(now)) error = "busy";
		else if (owner != self) set_owner(self, now);
		else owner_touch(now);
	} else if (!strncmp(action, "ai on ", 6) || !strncmp(action, "ai off ", 7)) {
		/* An indication only: it never claims or extends console ownership.
		 * Disconnect, release and every hand-over revoke the old indication. */
		bool active = action[3] == 'o' && action[4] == 'n';
		const char *value = action + (active ? 6 : 7);
		char *end;
		errno = 0;
		unsigned long requested_epoch = strtoul(value, &end, 10);
		if (owner != self) error = "not_owner";
		else if (*value < '0' || *value > '9' || *end || errno ||
			 requested_epoch != epoch) error = "stale_epoch";
		else linkr_status_led_ai(active);
	} else if (!strcmp(action, "release")) {
		if (owner != self) error = "not_owner";
		else { owner = 0; owner_active_ms = 0; ownership_changed(); }
	} else if (!strncmp(action, "yield ", 6)) {
		char *end;
		unsigned long target = strtoul(action + 6, &end, 10);
		bool found = false;
		for (size_t i = 0; i < SESSION_COUNT; i++) {
			if (sessions[i].peer && sessions[i].id == target) found = true;
		}
		if (owner != self) error = "not_owner";
		else if (!target || target > UINT32_MAX || *end || !found) error = "bad_peer";
		else if (owner != target) set_owner(target, k_uptime_get_32());
	} else if (strcmp(action, "?")) error = "bad_action";
	unsigned int peers = 0;
	for (size_t i = 0; i < SESSION_COUNT; i++) peers += sessions[i].peer != NULL;
	if (error) snprintk(response, capacity, "ERR control=%s\r\n", error);
	else snprintk(response, capacity,
		"OK control self=%u owner=%u mode=%s epoch=%u peers=%u ble_max=%u linkr_reserved=0 agent_led=1\r\n",
		self, owner, owner == self ? "control" : owner ? "readonly" : "available",
		epoch, peers, CONFIG_BT_MAX_CONN);
	k_mutex_unlock(&session_lock);
	return true;
}

bool linkr_session_control(const void *peer, const char *command,
			  char *response, size_t capacity)
{
	return session_control(peer, command, response, capacity, true);
}

void linkr_session_status(const void *peer, char *response, size_t capacity)
{
	(void)session_control(peer, "control?", response, capacity, false);
}
