/* Host-only harness around the C client's Management v1 response
 * reassembler (tools/linkr_ble_terminal.c).
 *
 * tests/test_mgmt_feed.py slices mgmt_feed_response() out of the production
 * source and compiles it here against the smallest possible state. The test
 * is about the framing rules a split GATT indication has to obey: the first
 * indication carries the header, continuation indications carry payload, and
 * a malformed or oversized frame must not leave a half-filled buffer behind.
 *
 * SPDX-License-Identifier: Apache-2.0 */

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MGMT_HEADER_SIZE 12
#define MGMT_MAX_PAYLOAD 512
#define MGMT_MSG_RESPONSE 2

typedef struct {
	bool mgmt_ready;
	uint16_t mgmt_expected;
	uint16_t mgmt_flags;
	uint32_t mgmt_response_id;
	uint16_t mgmt_received;
	uint8_t mgmt_rx[MGMT_MAX_PAYLOAD];
} mgmt_state_t;

static mgmt_state_t g_state;
static int error_count;
static char last_error[128];

static void msg(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(last_error, sizeof(last_error), fmt, ap);
	va_end(ap);
	error_count++;
}

static uint16_t get_le16(const uint8_t *p)
{
	return (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
}

#include "mgmt_feed_production.inc"

static void reset_state(void)
{
	memset(&g_state, 0, sizeof(g_state));
	error_count = 0;
	last_error[0] = '\0';
}

static void put_le16(uint8_t *p, uint16_t value)
{
	p[0] = (uint8_t)(value & 0xff);
	p[1] = (uint8_t)(value >> 8);
}

static void put_le32(uint8_t *p, uint32_t value)
{
	p[0] = (uint8_t)(value & 0xff);
	p[1] = (uint8_t)(value >> 8);
	p[2] = (uint8_t)(value >> 16);
	p[3] = (uint8_t)(value >> 24);
}

static size_t make_frame(uint8_t *buffer, uint8_t type, uint32_t id,
			 const char *payload, uint16_t length, uint16_t flags)
{
	memset(buffer, 0, MGMT_HEADER_SIZE);
	buffer[0] = 'L';
	buffer[1] = 'K';
	buffer[2] = 1;
	buffer[3] = type;
	put_le32(buffer + 4, id);
	put_le16(buffer + 8, length);
	put_le16(buffer + 10, flags);
	if (payload && length) {
		memcpy(buffer + MGMT_HEADER_SIZE, payload, length);
	}
	return (size_t)MGMT_HEADER_SIZE + length;
}

static void print_state(const char *label)
{
	printf("%s_ready=%d\n", label, g_state.mgmt_ready ? 1 : 0);
	printf("%s_expected=%u\n", label, (unsigned int)g_state.mgmt_expected);
	printf("%s_flags=%u\n", label, (unsigned int)g_state.mgmt_flags);
	printf("%s_received=%u\n", label, (unsigned int)g_state.mgmt_received);
	printf("%s_id=%u\n", label, (unsigned int)g_state.mgmt_response_id);
	printf("%s_payload=", label);
	for (uint16_t i = 0; i < g_state.mgmt_received; i++) {
		printf("%02x", g_state.mgmt_rx[i]);
	}
	printf("\n");
	printf("%s_errors=%d\n", label, error_count);
	printf("%s_last_error=%s\n", label, last_error);
}

int main(int argc, char **argv)
{
	const char *scenario = argc > 1 ? argv[1] : "split";
	uint8_t frame[MGMT_HEADER_SIZE + MGMT_MAX_PAYLOAD];

	reset_state();

	if (!strcmp(scenario, "split")) {
		size_t length = make_frame(frame, MGMT_MSG_RESPONSE,
					   0x89abcdefU, "ABCDEFGHI", 9, 0x1234);

		mgmt_feed_response(frame, MGMT_HEADER_SIZE + 2);
		mgmt_feed_response(frame + MGMT_HEADER_SIZE + 2, 3);
		mgmt_feed_response(frame + MGMT_HEADER_SIZE + 5, 4);
		print_state(scenario);
		(void)length;
		return 0;
	}

	if (!strcmp(scenario, "header_only")) {
		make_frame(frame, MGMT_MSG_RESPONSE, 7, "", 4, 0);
		mgmt_feed_response(frame, MGMT_HEADER_SIZE);
		print_state(scenario);
		return 0;
	}

	if (!strcmp(scenario, "zero_length")) {
		make_frame(frame, MGMT_MSG_RESPONSE, 7, "", 0, 0);
		mgmt_feed_response(frame, MGMT_HEADER_SIZE);
		print_state(scenario);
		return 0;
	}

	if (!strcmp(scenario, "too_long")) {
		make_frame(frame, MGMT_MSG_RESPONSE, 7, "", 0, 0);
		put_le16(frame + 8, MGMT_MAX_PAYLOAD + 1);
		mgmt_feed_response(frame, MGMT_HEADER_SIZE);
		print_state(scenario);
		return 0;
	}

	if (!strcmp(scenario, "bad_magic")) {
		make_frame(frame, MGMT_MSG_RESPONSE, 7, "", 4, 0);
		frame[0] = 'X';
		mgmt_feed_response(frame, MGMT_HEADER_SIZE);
		print_state(scenario);
		return 0;
	}

	if (!strcmp(scenario, "bad_version")) {
		make_frame(frame, MGMT_MSG_RESPONSE, 7, "", 4, 0);
		frame[2] = 2;
		mgmt_feed_response(frame, MGMT_HEADER_SIZE);
		print_state(scenario);
		return 0;
	}

	if (!strcmp(scenario, "bad_type")) {
		make_frame(frame, 3, 7, "", 4, 0);
		mgmt_feed_response(frame, MGMT_HEADER_SIZE);
		print_state(scenario);
		return 0;
	}

	if (!strcmp(scenario, "overflow")) {
		make_frame(frame, MGMT_MSG_RESPONSE, 7, "ABCD", 4, 0);
		mgmt_feed_response(frame, MGMT_HEADER_SIZE + 3);
		mgmt_feed_response(frame + MGMT_HEADER_SIZE + 3, 2);
		print_state(scenario);
		return 0;
	}

	if (!strcmp(scenario, "ready_guard")) {
		make_frame(frame, MGMT_MSG_RESPONSE, 7, "WXYZ", 4, 0);
		mgmt_feed_response(frame, MGMT_HEADER_SIZE + 4);
		make_frame(frame, MGMT_MSG_RESPONSE, 8, "ABCD", 4, 0);
		mgmt_feed_response(frame, MGMT_HEADER_SIZE + 4);
		print_state(scenario);
		return 0;
	}

	if (!strcmp(scenario, "two_chunks")) {
		make_frame(frame, MGMT_MSG_RESPONSE, 7, "ABCDEFGH", 8, 0);
		mgmt_feed_response(frame, MGMT_HEADER_SIZE + 4);
		mgmt_feed_response(frame + MGMT_HEADER_SIZE + 4, 4);
		print_state(scenario);
		return 0;
	}

	fprintf(stderr, "unknown scenario: %s\n", scenario);
	return 2;
}
