/* SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "serial_session.h"

static bool ai_active;
static unsigned int ai_updates;
void linkr_status_led_ai(bool active) { ai_active = active; ++ai_updates; }
static void ai_command(const void *peer, bool active, uint32_t epoch);
static char a, b, c;
static char response[256];
/* The fake Zephyr clock used by serial_session.c on the host. */
uint32_t test_uptime_ms;
static void command(const void *peer, const char *text)
{
	assert(linkr_session_control(peer, text, response, sizeof(response)));
}
static void ai_command(const void *peer, bool active, uint32_t epoch)
{
	char text[64];
	snprintf(text, sizeof(text), "c ai %s %u", active ? "on" : "off", epoch);
	command(peer, text);
}
static unsigned int id(const void *peer)
{
	unsigned int result = 0;
	linkr_session_status(peer, response, sizeof(response));
	assert(sscanf(response, "OK control self=%u", &result) == 1);
	return result;
}
#include "control_dispatch.inc"

static atomic_int start;
static void *claim(void *peer)
{
	char reply[256];
	while (!atomic_load(&start)) { }
	assert(linkr_session_control(peer, "c claim", reply, sizeof(reply)));
	return NULL;
}

int main(int argc, char **argv)
{
	assert(argc == 2);
	assert(!linkr_session_open(&a, LINKR_SESSION_BLE));
	assert(!linkr_session_open(&b, LINKR_SESSION_BLE));
	assert(!linkr_session_open(&c, LINKR_SESSION_LAN));
	if (!strcmp(argv[1], "ai_indicator")) {
		command(&a, "c claim");
		uint32_t first = linkr_session_epoch(&a);
		assert(strstr(response, "agent_led=1"));
		ai_command(&a, true, first); assert(ai_active);
		ai_command(&b, false, first); assert(ai_active && strstr(response, "not_owner"));
		ai_command(&a, false, first + 1); assert(ai_active && strstr(response, "stale_epoch"));
		for (size_t i = 0; i < 4; ++i) {
			const char *bad[] = {"c ai off -1", "c ai off +2", "c ai off 2x", "c ai off 999999999999999999999999999999"};
			command(&a, bad[i]); assert(ai_active && strstr(response, "stale_epoch"));
		}
		ai_command(&a, false, first); assert(!ai_active);
		ai_command(&a, true, first); assert(ai_active);
		command(&b, "c claim"); assert(!ai_active);
		command(&a, "c claim");
		ai_command(&a, true, first); assert(!ai_active && strstr(response, "stale_epoch"));
		ai_command(&a, true, linkr_session_epoch(&a)); assert(ai_active);
		command(&a, "c release"); assert(!ai_active);
		command(&a, "c claim");
		ai_command(&a, true, linkr_session_epoch(&a)); assert(ai_active);
		linkr_session_close(&a); assert(!ai_active && ai_updates > 0);
	} else if (!strcmp(argv[1], "ai_does_not_extend_ownership")) {
		command(&a, "c claim");
		test_uptime_ms = 3001;
		ai_command(&a, true, linkr_session_epoch(&a)); assert(ai_active);
		command(&b, "c claim idle"); assert(!ai_active && strstr(response, "mode=control"));
	} else if (!strcmp(argv[1], "single_writer")) {
		uint32_t ticket = linkr_session_ticket(&a, true);
		assert(ticket && !linkr_session_ticket(&b, true) && !linkr_session_ticket(&c, true));
		linkr_session_close(&b);
		assert(linkr_session_begin(ticket));
		linkr_session_end();
	} else if (!strcmp(argv[1], "managed_release")) {
		command(&a, "c?");
		assert(strstr(response, "mode=available"));
		assert(!linkr_session_ticket(&a, true));
		command(&a, "c claim");
		uint32_t ticket = linkr_session_ticket(&a, false);
		assert(ticket);
		command(&a, "c release");
		assert(!linkr_session_ticket(&a, true));
		assert(!linkr_session_begin(ticket));
	} else if (!strcmp(argv[1], "handover")) {
		unsigned int target = id(&b);
		command(&a, "c claim");
		uint32_t old = linkr_session_ticket(&a, false);
		char text[64];
		snprintf(text, sizeof(text), "c yield %u", target);
		command(&c, text);
		assert(strstr(response, "not_owner"));
		command(&a, text);
		assert(strstr(response, "mode=readonly"));
		assert(!linkr_session_begin(old));
		assert(!linkr_session_ticket(&a, true));
		assert(linkr_session_ticket(&b, false));
	} else if (!strcmp(argv[1], "reconnect")) {
		uint32_t old = linkr_session_ticket(&a, true);
		unsigned int old_id = id(&a);
		linkr_session_close(&a);
		assert(!linkr_session_open(&a, LINKR_SESSION_BLE));
		assert(id(&a) != old_id);
		assert(linkr_session_ticket(&a, true));
		assert(!linkr_session_begin(old));
	} else if (!strcmp(argv[1], "queued_command")) {
		uint32_t queued = linkr_session_epoch(&a);
		command(&b, "c claim");
		command(&b, "c release");
		assert(!linkr_session_command_begin(&a, queued));
		assert(linkr_session_command_begin(&a, linkr_session_epoch(&a)));
		linkr_session_end();
	} else if (!strcmp(argv[1], "concurrent_claims")) {
		pthread_t first, second;
		assert(!pthread_create(&first, NULL, claim, &a));
		assert(!pthread_create(&second, NULL, claim, &c));
		atomic_store(&start, 1);
		pthread_join(first, NULL);
		pthread_join(second, NULL);
		assert((linkr_session_ticket(&a, false) != 0) != (linkr_session_ticket(&c, false) != 0));
	} else if (!strcmp(argv[1], "preempt_claim")) {
		command(&a, "c claim");
		uint32_t old = linkr_session_ticket(&a, false);
		assert(old);
		command(&b, "c claim");
		assert(strstr(response, "owner=") && strstr(response, "mode=control"));
		assert(!linkr_session_begin(old));
		assert(linkr_session_ticket(&b, false));
	} else if (!strcmp(argv[1], "claim_idle")) {
		command(&a, "c claim");
		uint32_t old = linkr_session_ticket(&a, false);
		test_uptime_ms += CONFIG_LINKR_BLE_BRIDGE_SESSION_IDLE_MS;
		command(&b, "c claim idle");
		assert(strstr(response, "mode=control"));
		assert(!linkr_session_begin(old));
		assert(linkr_session_ticket(&b, false));
	} else if (!strcmp(argv[1], "claim_idle_active")) {
		command(&a, "c claim");
		uint32_t active = linkr_session_ticket(&a, false);
		command(&b, "c claim idle");
		assert(strstr(response, "control=busy"));
		assert(linkr_session_begin(active));
		linkr_session_end();
	} else if (!strcmp(argv[1], "auto_idle_takeover")) {
		command(&a, "c claim");
		uint32_t old = linkr_session_ticket(&a, false);
		test_uptime_ms += CONFIG_LINKR_BLE_BRIDGE_SESSION_IDLE_MS;
		uint32_t next = linkr_session_ticket(&b, true);
		assert(next);
		assert(!linkr_session_begin(old));
		assert(linkr_session_begin(next));
		linkr_session_end();
	} else if (!strcmp(argv[1], "auto_idle_takeover_managed")) {
		command(&a, "c claim");
		uint32_t old = linkr_session_ticket(&a, false);
		command(&b, "c?");
		test_uptime_ms += CONFIG_LINKR_BLE_BRIDGE_SESSION_IDLE_MS;
		uint32_t next = linkr_session_ticket(&b, true);
		assert(next);
		assert(!linkr_session_begin(old));
		assert(linkr_session_begin(next));
		linkr_session_end();
	} else if (!strcmp(argv[1], "command_idle_takeover")) {
		command(&a, "c claim");
		uint32_t old = linkr_session_ticket(&a, false);
		uint32_t queued = linkr_session_epoch(&b);
		test_uptime_ms += CONFIG_LINKR_BLE_BRIDGE_SESSION_IDLE_MS;
		assert(linkr_session_command_begin(&b, queued));
		linkr_session_end();
		assert(!linkr_session_begin(old));
		assert(linkr_session_ticket(&b, false));
	} else if (!strcmp(argv[1], "auto_active_rejected")) {
		command(&a, "c claim");
		uint32_t active = linkr_session_ticket(&a, false);
		assert(!linkr_session_ticket(&b, true));
		assert(!linkr_session_command_begin(&b, linkr_session_epoch(&b)));
		assert(linkr_session_begin(active));
		linkr_session_end();
	} else if (!strcmp(argv[1], "disconnected")) {
		linkr_session_close(&a);
		assert(!linkr_session_ticket(&a, true));
		assert(!linkr_session_command_begin(&a, 1));
		command(&a, "c claim");
		assert(strstr(response, "disconnected"));
	} else if (!strcmp(argv[1], "bad_handover")) {
		command(&a, "c claim");
		uint32_t before = linkr_session_ticket(&a, false);
		command(&a, "c yield 9999999999999999999");
		assert(strstr(response, "bad_peer"));
		assert(before == linkr_session_ticket(&a, false));
	} else if (!strcmp(argv[1], "legacy_lan")) {
		linkr_session_status(&c, response, sizeof(response));
		assert(linkr_session_ticket(&c, true));
		assert(!linkr_session_ticket(&a, true));
	} else if (!strcmp(argv[1], "aux_permissions")) {
		command(&a, "c claim");
		uint32_t current = linkr_session_epoch(&a);
		const char *mutations[] = {"o on", "r tx 1,2", "p clear", "y begin"};
		for (size_t i = 0; i < sizeof(mutations)/sizeof(mutations[0]); i++) {
			int before = aux_calls;
			assert(dispatch_aux(&b, mutations[i], current));
			assert(aux_calls == before);
			assert(dispatch_aux(&a, mutations[i], current));
			assert(aux_calls == before + 1);
		}
		assert(dispatch_aux(&b, "p get", current));
		int before = aux_calls;
		command(&a, "c release");
		assert(dispatch_aux(&a, "o on", current));
		assert(aux_calls == before);
	} else abort();
	puts("ok");
	return 0;
}
