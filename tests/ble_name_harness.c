/* Host-only harness around the production BLE-name logic in src/main.c.
 *
 * The two functions under test — the name check and the name install — are
 * sliced out of the firmware by tests/test_ble_name.py and compiled here
 * against fakes for the Bluetooth stack. What is exercised is the firmware's
 * own code: the byte and character rules, and the two pieces of state that
 * have to move together — the name buffer and the length the scan response
 * advertises with it.
 *
 * SPDX-License-Identifier: Apache-2.0 */

#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>

#define ARG_UNUSED(x) (void)(x)

/* The pieces of Zephyr's API that ble_name_make_default() touches. */
#define CONFIG_BT_ID_MAX 1
#define ARRAY_SIZE(array) (sizeof(array) / sizeof((array)[0]))
#define snprintk snprintf
#define LOG_WRN(...) do { } while (0)

typedef struct {
	uint8_t val[6];
} bt_addr_t;

typedef struct {
	uint8_t type;
	bt_addr_t a;
} bt_addr_le_t;

static const bt_addr_le_t bt_addr_le_any = { 0 };
#define BT_ADDR_LE_ANY (&bt_addr_le_any)

static uint8_t fake_hw_id[6];
static ssize_t fake_hw_id_len;
static bt_addr_le_t fake_identity;
static size_t fake_identity_count;

static ssize_t hwinfo_get_device_id(uint8_t *buffer, size_t length)
{
	if (fake_hw_id_len < 0 || (size_t)fake_hw_id_len > length) {
		return fake_hw_id_len < 0 ? fake_hw_id_len : -EINVAL;
	}
	memcpy(buffer, fake_hw_id, (size_t)fake_hw_id_len);
	return fake_hw_id_len;
}

static void bt_id_get(bt_addr_le_t *addrs, size_t *count)
{
	if (fake_identity_count == 0 || *count == 0) {
		*count = 0;
		return;
	}
	addrs[0] = fake_identity;
	*count = 1;
}

static bool bt_addr_le_eq(const bt_addr_le_t *a, const bt_addr_le_t *b)
{
	return a->type == b->type &&
	       memcmp(a->a.val, b->a.val, sizeof(a->a.val)) == 0;
}

/* BLE_NAME_MAX is compiled in from the firmware's own definition by
 * tests/test_ble_name.py; defining it here would let the two drift apart. */

/* Zephyr's advertising data entry, reduced to the three fields the name
 * touches. */
struct bt_data {
	uint8_t type;
	uint8_t data_len;
	uint8_t *data;
};

static char ble_name[BLE_NAME_MAX + 1];
static bool ble_name_custom;
static struct bt_data sd[] = {
	{ 0, 0, (uint8_t *)ble_name },
};

/* The stack refuses the name for one scenario: a board whose controller will
 * not take the name must not end up advertising half of it. */
static bool bt_set_name_fails;
static int bt_set_name_calls;
static char bt_set_name_last[BLE_NAME_MAX + 1];

static int bt_set_name(const char *name)
{
	bt_set_name_calls++;
	snprintf(bt_set_name_last, sizeof(bt_set_name_last), "%s", name);
	if (bt_set_name_fails) {
		return -EINVAL;
	}
	return 0;
}

/* The persistence side of the same operation. Both calls are counted so the
 * tests can prove install-failure never reaches the store, and that the
 * rollback happens after a store failure. */
#define BLE_NAME_SETTINGS_KEY "linkr/ble/name"

static int settings_save_err;
static int settings_delete_err;
static int settings_save_calls;
static int settings_delete_calls;
static char settings_saved_value[BLE_NAME_MAX + 1];
static size_t settings_saved_len;

static int settings_save_one(const char *name, const void *value, size_t len)
{
	ARG_UNUSED(name);
	settings_save_calls++;
	if (settings_save_err) {
		return settings_save_err;
	}
	if (len > BLE_NAME_MAX) {
		return -EINVAL;
	}
	memcpy(settings_saved_value, value, len);
	settings_saved_value[len] = '\0';
	settings_saved_len = len;
	return 0;
}

static int settings_delete(const char *name)
{
	ARG_UNUSED(name);
	settings_delete_calls++;
	return settings_delete_err;
}

#include "ble_name_production.inc"

static void reset_persistence_fakes(void)
{
	bt_set_name_fails = false;
	bt_set_name_calls = 0;
	bt_set_name_last[0] = '\0';
	settings_save_err = 0;
	settings_delete_err = 0;
	settings_save_calls = 0;
	settings_delete_calls = 0;
	settings_saved_value[0] = '\0';
	settings_saved_len = 0;
}

static void seed_old_name(void)
{
	memcpy(ble_name, "Old Name", 9);
	sd[0].data_len = (uint8_t)strlen(ble_name);
	ble_name_custom = true;
}

static void print_persistence(const char *label, int result, int err)
{
	printf("%s_result=%d\n", label, result);
	printf("%s_err=%d\n", label, err);
	printf("%s_buffer=%s\n", label, ble_name);
	printf("%s_length=%u\n", label, (unsigned int)sd[0].data_len);
	printf("%s_custom=%d\n", label, ble_name_custom ? 1 : 0);
	printf("%s_save_calls=%d\n", label, settings_save_calls);
	printf("%s_delete_calls=%d\n", label, settings_delete_calls);
	printf("%s_saved=%s\n", label, settings_saved_value);
	printf("%s_saved_len=%u\n", label, (unsigned int)settings_saved_len);
	printf("%s_bt_calls=%d\n", label, bt_set_name_calls);
	printf("%s_bt_last=%s\n", label, bt_set_name_last);
}

static void print_name(const char *label, const char *name)
{
	printf("%s=%s\n", label, name);
}

static void print_state(const char *label)
{
	printf("%s_buffer=%s\n", label, ble_name);
	printf("%s_length=%u\n", label, (unsigned int)sd[0].data_len);
}

static const char *command_name(enum ble_name_command command)
{
	switch (command) {
	case BLE_NAME_COMMAND_QUERY:
		return "query";
	case BLE_NAME_COMMAND_RESET:
		return "reset";
	case BLE_NAME_COMMAND_SET:
		return "set";
	default:
		return "none";
	}
}

static void print_command(const char *label, const char *body)
{
	const char *value = NULL;
	enum ble_name_command command = ble_name_parse_command(body, &value);

	printf("%s_cmd=%s\n", label, command_name(command));
	printf("%s_value=%s\n", label, value ? value : "");
}

int main(int argc, char **argv)
{
	const char *scenario = argc > 1 ? argv[1] : "validate";

	if (!strcmp(scenario, "commands")) {
		/* The spellings the API document promises.  `name default` is
		 * a reset; `name=default` and `name  default` are literal
		 * names that the handler trims. */
		print_command("query_name", "name");
		print_command("query_n", "n");
		print_command("query_name_q", "name?");
		print_command("query_n_q", "n?");
		print_command("reset_name", "name default");
		print_command("reset_n", "n default");
		print_command("set_eq", "name=default");
		print_command("set_n_eq", "n=default");
		print_command("set_two_spaces", "name  default");
		print_command("set_name", "name=Bench Bee");
		print_command("set_n_name", "n Bench Bee");
		print_command("none", "nomatch");
		print_command("null", NULL);
		return 0;
	}

	if (!strcmp(scenario, "validate")) {
		/* The rules the firmware applies to a name, as the firmware
		 * applies them. */
		printf("plain=%d\n", ble_name_valid("Bench Bee", 9) ? 1 : 0);
		printf("chinese=%d\n", ble_name_valid("测试", 6) ? 1 : 0);
		printf("emoji7=%d\n", ble_name_valid("😀😀😀😀😀😀😀", 28) ? 1 : 0);
		printf("emoji8=%d\n", ble_name_valid("😀😀😀😀😀😀😀😀", 32) ? 1 : 0);
		printf("bytes29=%d\n",
		       ble_name_valid("aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 29) ? 1 : 0);
		printf("bytes30=%d\n",
		       ble_name_valid("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 30) ? 1 : 0);
		printf("empty=%d\n", ble_name_valid("", 0) ? 1 : 0);
		printf("control=%d\n", ble_name_valid("one\ntwo", 7) ? 1 : 0);
		printf("del=%d\n", ble_name_valid("a\x7f" "b", 3) ? 1 : 0);
		printf("c1=%d\n", ble_name_valid("a\xc2\x85" "b", 4) ? 1 : 0);
		printf("line_separator=%d\n",
		       ble_name_valid("\xe2\x80\xa8", 3) ? 1 : 0);
		printf("paragraph_separator=%d\n",
		       ble_name_valid("\xe2\x80\xa9", 3) ? 1 : 0);
		printf("overlong=%d\n", ble_name_valid("\xc0\x80", 2) ? 1 : 0);
		printf("truncated=%d\n", ble_name_valid("\xe6\xb5", 2) ? 1 : 0);
		printf("surrogate=%d\n", ble_name_valid("\xed\xa0\x80", 3) ? 1 : 0);
		return 0;
	}

	if (!strcmp(scenario, "default")) {
		uint8_t hardware[6] = { 0x58, 0xbf, 0x25, 0x33, 0x07, 0x8c };
		uint8_t mac[6] = { 0x8c, 0x07, 0x33, 0x25, 0xbf, 0x58 };

		/* The factory hardware ID is the first choice, printed as the
		 * last two MAC octets in MAC order. */
		memcpy(fake_hw_id, hardware, sizeof(hardware));
		fake_hw_id_len = sizeof(hardware);
		fake_identity_count = 0;
		ble_name_custom = true;
		ble_name_make_default();
		print_name("hardware", ble_name);
		printf("hardware_custom=%d\n", ble_name_custom ? 1 : 0);

		/* A controller without a hardware ID falls back to the BLE
		 * identity, whose address bytes are little-endian. */
		fake_hw_id_len = -ENOSYS;
		fake_identity_count = 1;
		memset(&fake_identity, 0, sizeof(fake_identity));
		memcpy(fake_identity.a.val, mac, sizeof(mac));
		ble_name_custom = true;
		ble_name_make_default();
		print_name("identity", ble_name);
		printf("identity_custom=%d\n", ble_name_custom ? 1 : 0);

		/* Neither source: a recognisable name, not an empty one. */
		fake_identity_count = 0;
		memset(&fake_identity, 0, sizeof(fake_identity));
		ble_name_custom = true;
		ble_name_make_default();
		print_name("fallback", ble_name);
		printf("fallback_custom=%d\n", ble_name_custom ? 1 : 0);
		return 0;
	}

	if (!strcmp(scenario, "apply")) {
		int err = ble_name_apply("测试😀");

		printf("err=%d\n", err);
		print_state("applied");
		print_name("name", ble_name);
		return 0;
	}

	if (!strcmp(scenario, "apply_fail")) {
		int err;

		bt_set_name_fails = true;
		memcpy(ble_name, "Linkr Bee 078C", 15);
		sd[0].data_len = 15;
		err = ble_name_apply("测试😀");
		printf("err=%d\n", err);
		print_state("rejected");
		return 0;
	}

	if (!strcmp(scenario, "apply_same_length")) {
		int err = ble_name_apply("Bench Bee");

		printf("err=%d\n", err);
		print_state("applied");
		return 0;
	}

	if (!strcmp(scenario, "save_ok") || !strcmp(scenario, "save_fail") ||
	    !strcmp(scenario, "install_fail")) {
		enum ble_name_persist_result result;
		int err = 0;

		reset_persistence_fakes();
		seed_old_name();
		if (!strcmp(scenario, "save_fail")) {
			settings_save_err = -EIO;
		}
		if (!strcmp(scenario, "install_fail")) {
			bt_set_name_fails = true;
		}
		result = ble_name_install_and_save("New Name", 8, &err);
		print_persistence(scenario, result, err);
		return 0;
	}

	if (!strcmp(scenario, "reset_ok") ||
	    !strcmp(scenario, "reset_install_fail") ||
	    !strcmp(scenario, "reset_delete_fail")) {
		enum ble_name_persist_result result;
		uint8_t hardware[6] = { 0x58, 0xbf, 0x25, 0x33, 0x07, 0x8c };
		int err = 0;

		reset_persistence_fakes();
		seed_old_name();
		memcpy(fake_hw_id, hardware, sizeof(hardware));
		fake_hw_id_len = sizeof(hardware);
		fake_identity_count = 0;
		if (!strcmp(scenario, "reset_install_fail")) {
			bt_set_name_fails = true;
		}
		if (!strcmp(scenario, "reset_delete_fail")) {
			settings_delete_err = -EIO;
		}
		result = ble_name_reset_and_delete(&err);
		print_persistence(scenario, result, err);
		return 0;
	}

	fprintf(stderr, "unknown scenario: %s\n", scenario);
	return 2;
}
