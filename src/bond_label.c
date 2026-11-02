/* SPDX-License-Identifier: Apache-2.0 */
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/util.h>
#include <zephyr/bluetooth/addr.h>
#include "bond_label.h"

#if IS_ENABLED(CONFIG_SETTINGS)
/* A label lives in its own NVS key, joined to the bond table by identity
 * address: the Bluetooth stack owns bt/keys/<addr> and cannot carry extra
 * fields. Like the IR slot names, a label is only touched by the command
 * layer, so there is no boot-time load and no RAM copy. The key is all
 * lowercase hex with no separators because '/' is the settings hierarchy
 * separator. */
static void label_key(const bt_addr_le_t *addr, char *out, size_t out_len)
{
	const uint8_t *v = addr->a.val;

	snprintk(out, out_len, "linkr/bond/%02x%02x%02x%02x%02x%02x%u",
		 v[5], v[4], v[3], v[2], v[1], v[0], addr->type);
}

/* The previous firmware stored eight fixed-size records in one blob. Migrate
 * lazily, without a permanent RAM copy. Keep the source until every write has
 * succeeded; retries preserve keys already written by this or newer firmware.
 * All callers hold bond_lock, including writes and clears, so an old name
 * cannot reappear after a clear or overwrite. */
#define LEGACY_SLOTS 8u
#define LEGACY_NAME_MAX 32u
#define LEGACY_SLOT (1u + BT_ADDR_STR_LEN + 1u + LEGACY_NAME_MAX + 1u)
#define LEGACY_SIZE (2u + LEGACY_SLOTS * LEGACY_SLOT)
#define LEGACY_KEY "linkr_bond/labels"

static int migrate_legacy(void)
{
	uint8_t blob[LEGACY_SIZE];
	ssize_t size = settings_load_one(LEGACY_KEY, blob, sizeof(blob));

	if (size == -ENOENT || size == 0) {
		return 0;
	}
	/* Ignore an incompatible/torn record, as the old loader did. */
	if (size == -ENOSPC || (size >= 0 && ((size_t)size != sizeof(blob) ||
	    blob[0] != 2u || blob[1] > LEGACY_SLOTS))) {
		return 0;
	}
	if (size < 0) {
		return (int)size;
	}
	/* Validate every record before making any persistent changes. */
	for (size_t i = 0; i < blob[1]; i++) {
		const uint8_t *slot = blob + 2u + i * LEGACY_SLOT;
		size_t len = slot[1u + BT_ADDR_STR_LEN];
		const char *name = (const char *)(slot + 2u + BT_ADDR_STR_LEN);
		bt_addr_le_t addr;

		if (slot[0] > 1u || slot[BT_ADDR_STR_LEN] != 0u ||
		    len == 0u || len > LEGACY_NAME_MAX || name[len] != '\0' ||
		    memchr(name, '\0', len) != NULL ||
		    bt_addr_le_from_str((const char *)(slot + 1u),
				    slot[0] == 0u ? "public" : "random", &addr)) {
			return 0;
		}
	}
	for (size_t i = 0; i < blob[1]; i++) {
		const uint8_t *slot = blob + 2u + i * LEGACY_SLOT;
		size_t len = slot[1u + BT_ADDR_STR_LEN];
		const char *name = (const char *)(slot + 2u + BT_ADDR_STR_LEN);
		bt_addr_le_t addr;
		char key[32];
		char existing[CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX];
		int err;

		bt_addr_le_from_str((const char *)(slot + 1u),
				    slot[0] == 0u ? "public" : "random", &addr);
		label_key(&addr, key, sizeof(key));
		size = settings_load_one(key, existing, sizeof(existing));
		if (size >= 0 || size == -ENOSPC) {
			continue;
		}
		if (size != -ENOENT) {
			return (int)size;
		}
		/* A smaller configured limit keeps the longest complete UTF-8 prefix. */
		if (len > CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX) {
			len = CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX;
			while (len > 0u && ((uint8_t)name[len] & 0xc0u) == 0x80u) {
				len--;
			}
		}
		err = settings_save_one(key, name, len);
		if (err) {
			return err;
		}
	}
	int err = settings_delete(LEGACY_KEY);

	return err == -ENOENT ? 0 : err;
}

int linkr_bond_label_get(const bt_addr_le_t *addr, char *out, size_t out_len)
{
	char key[32];
	ssize_t length;

	if (addr == NULL || out == NULL || out_len < 2u) {
		return -EINVAL;
	}
	int err = migrate_legacy();

	if (err) {
		out[0] = '\0';
		return err;
	}
	label_key(addr, key, sizeof(key));

	length = settings_load_one(key, out, out_len - 1u);
	if (length == -ENOENT) {
		out[0] = '\0';
		return 0;
	}
	if (length < 0) {
		out[0] = '\0';
		return (int)length;
	}
	if ((size_t)length >= out_len) {
		out[0] = '\0';
		return -ENOSPC;
	}
	out[length] = '\0';
	return (int)length;
}

int linkr_bond_label_set(const bt_addr_le_t *addr, const char *utf8, size_t len)
{
	char key[32];
	int err;

	if (addr == NULL || utf8 == NULL || len == 0u ||
	    len > CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX) {
		return -EINVAL;
	}
	err = migrate_legacy();
	if (err) {
		return err;
	}
	label_key(addr, key, sizeof(key));

	err = settings_save_one(key, utf8, len);
	if (err) {
		return -EIO;
	}
	return (int)len;
}

int linkr_bond_label_clear(const bt_addr_le_t *addr)
{
	char key[32];

	if (addr == NULL) {
		return -EINVAL;
	}
	int err = migrate_legacy();

	if (err) {
		return err;
	}
	label_key(addr, key, sizeof(key));
	err = settings_delete(key);
	return err == -ENOENT ? 0 : err;
}
#else
/* Settings off: the label commands answer `ERR bonds unsupported` and the
 * bond manager never calls these. The stubs keep the unconditional
 * CMakeLists entry linkable on a minimal build. */
int linkr_bond_label_get(const bt_addr_le_t *addr, char *out, size_t out_len)
{
	ARG_UNUSED(addr);
	ARG_UNUSED(out);
	ARG_UNUSED(out_len);
	return 0;
}

int linkr_bond_label_set(const bt_addr_le_t *addr, const char *utf8, size_t len)
{
	ARG_UNUSED(addr);
	ARG_UNUSED(utf8);
	ARG_UNUSED(len);
	return -ENOTSUP;
}

int linkr_bond_label_clear(const bt_addr_le_t *addr)
{
	ARG_UNUSED(addr);
	return 0;
}
#endif /* CONFIG_SETTINGS */
