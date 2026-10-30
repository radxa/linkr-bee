/* SPDX-License-Identifier: Apache-2.0 */
#include <errno.h>
#include <stdint.h>
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

int linkr_bond_label_get(const bt_addr_le_t *addr, char *out, size_t out_len)
{
	char key[32];
	ssize_t length;

	if (addr == NULL || out == NULL || out_len < 2u) {
		return -EINVAL;
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
	label_key(addr, key, sizeof(key));
	(void)settings_delete(key);
	return 0;
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
