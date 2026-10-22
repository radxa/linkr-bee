/* Host-only harness for the C client's pure BLE-name text helpers.
 *
 * tests/test_ble_name_client.py slices printable_ble_name(),
 * ble_name_query_value() and ble_name_readback_matches() out of
 * tools/linkr_ble_terminal.c and compiles them here.  These are the decisions
 * that sanitise a name heard over the air and that decide whether a write
 * really took effect; exercising them directly is less brittle than checking
 * source order in the D-Bus client.
 *
 * SPDX-License-Identifier: Apache-2.0 */

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "ble_name_client_production.inc"

static void print_printable(const char *label, const char *input)
{
	char out[64];

	printable_ble_name(input, out, sizeof(out));
	printf("%s=%s\n", label, out);
}

static void print_query(const char *label, const char *reply)
{
	char out[64];
	bool ok = ble_name_query_value(reply, out, sizeof(out));

	printf("%s_ok=%d\n", label, ok ? 1 : 0);
	printf("%s_value=%s\n", label, ok ? out : "");
}

int main(void)
{
	char reported[64];

	print_printable("plain", "Bench Bee");
	print_printable("controls", "Bee\x1b[2J\xc2\x85name");
	print_printable("only_controls", "\x1b");
	print_printable("null", NULL);
	print_printable("empty", "");

	print_query("plain", "OK name=Bench Bee custom=yes");
	print_query("suffix_in_name", "OK name=Bee custom=yes custom=no");
	print_query("bad_suffix", "OK name=Bee custom=maybe");
	print_query("error", "ERR name=1");
	print_query("crlf", "OK name=Bee custom=no\r\n");
	print_query("no_suffix", "OK name=Bee");
	print_query("empty_name", "OK name= custom=no");

	printf("match_rename=%d\n",
	       ble_name_readback_matches("OK name=Bee custom=yes", "Bee",
					 reported, sizeof(reported)));
	printf("mismatch_rename=%d\n",
	       ble_name_readback_matches("OK name=Other custom=yes", "Bee",
					 reported, sizeof(reported)));
	printf("match_reset=%d\n",
	       ble_name_readback_matches("OK name=Linkr Bee 078C custom=no",
					 NULL, reported, sizeof(reported)));
	printf("unreadable=%d\n",
	       ble_name_readback_matches("ERR name=1", "Bee", reported,
					 sizeof(reported)));
	return 0;
}
