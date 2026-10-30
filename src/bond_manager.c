/* SPDX-License-Identifier: Apache-2.0 */
#include <errno.h>
#include <string.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>
#include "bond_manager.h"
#include "bond_label.h"

/* Serialize the short delayed removal with queries and other deletion requests.
 * The delay lets the requester receive the acknowledgement before bt_unpair()
 * disconnects a currently connected peer. OK queued is not a completion report. */
K_MUTEX_DEFINE(bond_lock);
static bool pending;
static int last_result;
static uint8_t pending_id;
static bt_addr_le_t pending_addr;
static void remove_bond(struct k_work *work)
{
	ARG_UNUSED(work);
	k_mutex_lock(&bond_lock, K_FOREVER);
	last_result = bt_unpair(pending_id, &pending_addr);
	/* A successful unpair (or a bond that is already gone) leaves the label
	 * orphaned, so drop it too. A transient failure keeps the bond, and with
	 * it the label. */
	if ((last_result == 0 || last_result == -ENOENT) &&
	    IS_ENABLED(CONFIG_SETTINGS)) {
		(void)linkr_bond_label_clear(&pending_addr);
	}
	pending = false;
	k_mutex_unlock(&bond_lock);
}
K_WORK_DELAYABLE_DEFINE(remove_work, remove_bond);

struct listing {
	char *reply;
	size_t size, used;
	const bt_addr_le_t *self;
	bool overflow;
};
static void list_bond(const struct bt_bond_info *bond, void *data)
{
	struct listing *list = data;
	char address[BT_ADDR_STR_LEN];
	bt_addr_to_str(&bond->addr.a, address, sizeof(address));
	int n = snprintk(list->reply + list->used, list->size - list->used,
		"BOND %u/%s self=%u\n", bond->addr.type, address,
		bt_addr_le_eq(&bond->addr, list->self) ? 1U : 0U);
	if (n < 0 || (size_t)n >= list->size - list->used) {
		list->overflow = true;
		return;
	}
	list->used += n;
}

/* Parse "<0|1>/AA:BB:CC:DD:EE:FF" (exactly 19 bytes) into an identity
 * address. The token is copied first so a following command argument cannot
 * bleed into the address parser. */
static bool parse_address(const char *value, bt_addr_le_t *out)
{
	char text[BT_ADDR_STR_LEN];

	if (strlen(value) != 19u) {
		return false;
	}
	if (value[0] != '0' && value[0] != '1') {
		return false;
	}
	if (value[1] != '/') {
		return false;
	}
	memcpy(text, value + 2, 17u);
	text[17] = '\0';
	return bt_addr_le_from_str(text, value[0] == '0' ? "public" : "random",
				   out) == 0;
}

#if IS_ENABLED(CONFIG_SETTINGS)
static int hex_value(char digit)
{
	if (digit >= '0' && digit <= '9') {
		return digit - '0';
	}
	if (digit >= 'a' && digit <= 'f') {
		return digit - 'a' + 10;
	}
	if (digit >= 'A' && digit <= 'F') {
		return digit - 'A' + 10;
	}
	return -1;
}

/* Encode bytes as lowercase hex, NUL-terminated. Returns the character count
 * written, or 0 when out is too small. */
static size_t hex_encode(const uint8_t *data, size_t length, char *out,
			 size_t out_size)
{
	static const char digits[] = "0123456789abcdef";

	if (length * 2u + 1u > out_size) {
		return 0;
	}
	for (size_t i = 0; i < length; i++) {
		out[i * 2u] = digits[data[i] >> 4];
		out[i * 2u + 1u] = digits[data[i] & 0x0fu];
	}
	out[length * 2u] = '\0';
	return length * 2u;
}

/* Decode an even-length hex string. Returns the byte count, or -1 when the
 * text is not valid hex or does not fit out. */
static int hex_decode(const char *text, uint8_t *out, size_t out_size)
{
	size_t length = strlen(text);
	size_t bytes = length / 2u;

	if (length == 0u || (length % 2u) != 0u || bytes > out_size) {
		return -1;
	}
	for (size_t i = 0; i < bytes; i++) {
		int high = hex_value(text[i * 2u]);
		int low = hex_value(text[i * 2u + 1u]);

		if (high < 0 || low < 0) {
			return -1;
		}
		out[i] = (uint8_t)((high << 4) | low);
	}
	return (int)bytes;
}

/* A label is free text that ends up on a terminal, so it follows the same
 * displayable-UTF-8 rules as the advertised name: no C0/C1 controls, DEL,
 * embedded NUL, overlong forms, surrogates, or out-of-range code points. The
 * C1 rule matters here too: U+009B is a one-byte CSI and a terminal may obey
 * it even though the board never sends an ESC. */
static bool label_valid(const char *label, size_t len)
{
	size_t i = 0;

	if (len == 0u || len > CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX) {
		return false;
	}

	while (i < len) {
		uint8_t c = (uint8_t)label[i];
		uint32_t cp;
		size_t extra;

		if (c < 0x20 || c == 0x7f) {
			return false;
		}
		if (c < 0x80) {
			i++;
			continue;
		}

		if ((c & 0xe0) == 0xc0) {
			extra = 1;
			cp = c & 0x1f;
		} else if ((c & 0xf0) == 0xe0) {
			extra = 2;
			cp = c & 0x0f;
		} else if ((c & 0xf8) == 0xf0) {
			extra = 3;
			cp = c & 0x07;
		} else {
			return false;
		}
		if (i + extra >= len) {
			return false;
		}
		for (size_t j = 1; j <= extra; j++) {
			uint8_t continuation = (uint8_t)label[i + j];

			if ((continuation & 0xc0) != 0x80) {
				return false;
			}
			cp = (cp << 6) | (continuation & 0x3f);
		}

		if ((extra == 1 && cp < 0x80) ||
		    (extra == 2 && cp < 0x800) ||
		    (extra == 3 && (cp < 0x10000 || cp > 0x10ffff)) ||
		    (cp >= 0xd800 && cp <= 0xdfff) ||
		    (cp >= 0x80 && cp <= 0x9f) ||
		    cp == 0x2028 || cp == 0x2029) {
			return false;
		}
		i += extra + 1;
	}

	return true;
}

/* "bonds label <type>/<addr> [<hex>|clear]". args points just past the
 * "bonds label" prefix. Labels are asked for one address at a time so the
 * fixed reply buffer never has to hold all of them. */
static void bond_label_command(uint8_t id, const char *args, char *reply,
			       size_t size)
{
	char address_token[BT_ADDR_STR_LEN + 2];
	bt_addr_le_t address;
	char address_text[BT_ADDR_STR_LEN];
	const char *value;
	size_t args_len;

	while (*args == ' ') {
		args++;
	}
	args_len = strlen(args);

	if (args_len < 19u) {
		snprintk(reply, size, "ERR bonds address\n");
		return;
	}
	memcpy(address_token, args, 19u);
	address_token[19] = '\0';
	if (!parse_address(address_token, &address)) {
		snprintk(reply, size, "ERR bonds address\n");
		return;
	}
	if (args[19] != '\0' && args[19] != ' ') {
		snprintk(reply, size, "ERR bonds address\n");
		return;
	}
	if (!bt_le_bond_exists(id, &address)) {
		snprintk(reply, size, "ERR bonds not found\n");
		return;
	}
	bt_addr_to_str(&address.a, address_text, sizeof(address_text));

	value = args + 19;
	while (*value == ' ') {
		value++;
	}

	if (*value == '\0') {
		char out[CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX + 1];
		int n = linkr_bond_label_get(&address, out, sizeof(out));

		if (n < 0) {
			snprintk(reply, size, "ERR bonds save=%d\n", n);
			return;
		}
		if (n == 0) {
			snprintk(reply, size, "OK bonds label=%u/%s none\n",
				 (unsigned int)address.type, address_text);
		} else {
			char hex[CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX * 2 + 1];

			hex_encode((const uint8_t *)out, (size_t)n, hex,
				   sizeof(hex));
			snprintk(reply, size,
				 "OK bonds label=%u/%s hex=%s\n",
				 (unsigned int)address.type, address_text, hex);
		}
		return;
	}

	if (!strcmp(value, "clear")) {
		(void)linkr_bond_label_clear(&address);
		snprintk(reply, size, "OK bonds label=%u/%s none\n",
			 (unsigned int)address.type, address_text);
		return;
	}

	/* Hex-encoded UTF-8 write. */
	{
		size_t value_len = strlen(value);
		uint8_t bytes[CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX];
		char hex[CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX * 2 + 1];
		int n;

		if (value_len == 0u || (value_len % 2u) != 0u) {
			snprintk(reply, size, "ERR bonds label hex\n");
			return;
		}
		if (value_len / 2u > CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX) {
			snprintk(reply, size, "ERR bonds label length\n");
			return;
		}
		n = hex_decode(value, bytes, sizeof(bytes));
		if (n < 0) {
			snprintk(reply, size, "ERR bonds label hex\n");
			return;
		}
		if (!label_valid((const char *)bytes, (size_t)n)) {
			snprintk(reply, size, "ERR bonds label utf8\n");
			return;
		}
		if (linkr_bond_label_set(&address, (const char *)bytes,
					 (size_t)n) < 0) {
			snprintk(reply, size, "ERR bonds save\n");
			return;
		}
		hex_encode(bytes, (size_t)n, hex, sizeof(hex));
		snprintk(reply, size, "OK bonds label=%u/%s hex=%s\n",
			 (unsigned int)address.type, address_text, hex);
	}
}

/* ---- upstream `bonds name` / `bonds names?` compatibility ----------------
 *
 * The first version of this feature let a host name only its own pairing with
 * `@linkr bonds name <label>` and listed every name with `@linkr bonds names?`.
 * Keep both on top of the per-bond label store: existing Web/Python clients
 * keep working, while `bonds label <type>/<address>` adds management of any
 * bond. The listing is capped at the old 32-byte width so eight maximal NAME
 * lines still fit the 512-byte reply; the per-address read returns the full
 * configured label. */
#define BONDS_NAME_MAX 32u
struct names_listing {
	char *reply;
	size_t size, used;
	bool overflow;
};

static size_t utf8_char_len(uint8_t c)
{
	if ((c & 0x80u) == 0u) {
		return 1u;
	}
	if ((c & 0xe0u) == 0xc0u) {
		return 2u;
	}
	if ((c & 0xf0u) == 0xe0u) {
		return 3u;
	}
	if ((c & 0xf8u) == 0xf0u) {
		return 4u;
	}
	return 1u;
}

static void list_bond_name(const struct bt_bond_info *bond, void *data)
{
	struct names_listing *list = data;
	char address[BT_ADDR_STR_LEN];
	char label[CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX + 1u];
	char safe[BONDS_NAME_MAX + 1u];
	size_t used = 0u;
	int length;

	length = linkr_bond_label_get(&bond->addr, label, sizeof(label));
	if (length <= 0) {
		return;
	}
	/* Quotes and backslashes would end the quoted NAME field early. The
	 * per-address command returns the stored bytes exactly; this listing is
	 * the compatibility view, so it substitutes rather than escapes. */
	for (size_t i = 0; i < (size_t)length && used < BONDS_NAME_MAX;) {
		size_t width = utf8_char_len((uint8_t)label[i]);

		if (used + width > BONDS_NAME_MAX) {
			break;
		}
		char c = label[i];

		safe[used++] = (c == '"' || c == '\\') ? '\'' : c;
		for (size_t j = 1; j < width; j++) {
			safe[used++] = label[i + j];
		}
		i += width;
	}
	safe[used] = '\0';
	if (used == 0u) {
		return;
	}
	bt_addr_to_str(&bond->addr.a, address, sizeof(address));
	int written = snprintk(list->reply + list->used, list->size - list->used,
			       "NAME %u/%s \"%s\"\n", bond->addr.type, address,
			       safe);
	if (written < 0 || (size_t)written >= list->size - list->used) {
		list->overflow = true;
		return;
	}
	list->used += (size_t)written;
}

static void bond_names_command(uint8_t id, char *reply, size_t size)
{
	struct names_listing list = { .reply = reply, .size = size };
	int n = snprintk(reply, size, "OK bonds names\n");

	if (n < 0 || (size_t)n >= size) {
		snprintk(reply, size, "ERR bonds buffer\n");
		return;
	}
	list.used = (size_t)n;
	bt_foreach_bond(id, list_bond_name, &list);
	if (list.overflow) {
		snprintk(reply, size, "ERR bonds buffer\n");
	}
}

static void bond_name_command(struct bt_conn *conn, uint8_t id,
			      const char *value, char *reply, size_t size)
{
	const bt_addr_le_t *self = bt_conn_get_dst(conn);
	size_t length;

	if (value == NULL) {
		value = "";
	}
	if (*value == ' ') {
		value++;
	}
	length = strlen(value);
	if (!bt_le_bond_exists(id, self)) {
		snprintk(reply, size, "ERR bonds not found\n");
		return;
	}
	if (length == 0u) {
		(void)linkr_bond_label_clear(self);
		snprintk(reply, size, "OK bonds name\n");
		return;
	}
	if (length > CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX) {
		snprintk(reply, size, "ERR bonds name length\n");
		return;
	}
	if (!label_valid(value, length)) {
		snprintk(reply, size, "ERR bonds name utf8\n");
		return;
	}
	if (linkr_bond_label_set(self, value, length) < 0) {
		snprintk(reply, size, "ERR bonds name save\n");
		return;
	}
	snprintk(reply, size, "OK bonds name\n");
}

#else
static void bond_label_command(uint8_t id, const char *args, char *reply,
			       size_t size)
{
	ARG_UNUSED(id);
	ARG_UNUSED(args);
	snprintk(reply, size, "ERR bonds unsupported\n");
}

static void bond_names_command(uint8_t id, char *reply, size_t size)
{
	ARG_UNUSED(id);
	snprintk(reply, size, "OK bonds names\n");
}

static void bond_name_command(struct bt_conn *conn, uint8_t id,
			      const char *value, char *reply, size_t size)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(id);
	ARG_UNUSED(value);
	snprintk(reply, size, "ERR bonds unsupported\n");
}
#endif /* CONFIG_SETTINGS */


bool linkr_bond_command(struct bt_conn *conn, const char *command, char *reply, size_t size)
{
	bool query = !strcmp(command, "bonds?");
	bool names = !strcmp(command, "bonds names?");
	bool name = !strcmp(command, "bonds name") ||
		    !strncmp(command, "bonds name ", 11);
	bool label = !strncmp(command, "bonds label", 11) &&
		     (command[11] == '\0' || command[11] == ' ');
	bool remove = !strncmp(command, "bonds remove ", 13);

	if (!query && !names && !name && !label && !remove) return false;
	struct bt_conn_info info;
	if (!conn || bt_conn_get_info(conn, &info) || bt_conn_get_security(conn) < BT_SECURITY_L2) {
		snprintk(reply, size, "ERR bonds encrypted BLE required\n");
		return true;
	}
	/* Labels are stored through the same lock as removal: a write that ran
	 * beside the delayed bt_unpair() could recreate a label for a bond that
	 * has just been deleted. The write is short; correctness wins. */
	k_mutex_lock(&bond_lock, K_FOREVER);
	if (names) {
		bond_names_command(info.id, reply, size);
		k_mutex_unlock(&bond_lock);
		return true;
	}
	if (name) {
		const char *value = command[10] == ' ' ? command + 11 : "";
		bond_name_command(conn, info.id, value, reply, size);
		k_mutex_unlock(&bond_lock);
		return true;
	}
	if (label) {
		bond_label_command(info.id, command + 11, reply, size);
		k_mutex_unlock(&bond_lock);
		return true;
	}
	if (query) {
		struct listing list = { .reply = reply, .size = size, .self = bt_conn_get_dst(conn) };
		int n = snprintk(reply, size, "OK bonds pending=%u result=%d\n", pending ? 1U : 0U, last_result);
		if (n < 0 || (size_t)n >= size) {
			snprintk(reply, size, "ERR bonds buffer\n");
		} else {
			list.used = n;
			bt_foreach_bond(info.id, list_bond, &list);
			if (list.overflow) snprintk(reply, size, "ERR bonds buffer\n");
		}
	} else {
		const char *value = command + 13;
		bt_addr_le_t address;
		/* Exact identity address, never a shifting list index or wildcard. */
		if (!parse_address(value, &address)) {
			snprintk(reply, size, "ERR bonds address\n");
		} else if (pending) {
			snprintk(reply, size, "ERR bonds busy\n");
		} else if (!bt_le_bond_exists(info.id, &address)) {
			snprintk(reply, size, "ERR bonds not found\n");
		} else {
			pending_id = info.id;
			bt_addr_le_copy(&pending_addr, &address);
			pending = true;
			int err = k_work_reschedule(&remove_work, K_MSEC(500));
			if (err < 0) {
				pending = false;
				snprintk(reply, size, "ERR bonds schedule=%d\n", err);
			} else {
				snprintk(reply, size, "OK bonds queued\n");
			}
		}
	}
	k_mutex_unlock(&bond_lock);
	return true;
}

bool linkr_bond_is_readonly(const char *command)
{
	if (!strcmp(command, "bonds?")) {
		return true;
	}
	if (strncmp(command, "bonds label", 11) != 0) {
		return false;
	}
	/* A bare address is a read. So is the malformed prefix with no address:
	 * it can only answer `ERR bonds address`, and refusing it at the control
	 * gate would report a permission error for a syntax mistake. */
	const char *rest = command + 11;
	while (*rest == ' ') {
		rest++;
	}
	return *rest == '\0' || strlen(rest) == 19u;
}
