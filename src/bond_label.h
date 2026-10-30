/* SPDX-License-Identifier: Apache-2.0 */
#pragma once
#include <stddef.h>
#include <zephyr/bluetooth/addr.h>

/* Read the display label for a bonded identity address into out, which is
 * always NUL-terminated. Returns the label length in bytes, 0 when nothing is
 * stored, or a negative errno. */
int linkr_bond_label_get(const bt_addr_le_t *addr, char *out, size_t out_len);

/* Store a label of 1..CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX bytes. The caller
 * has already rejected control bytes. Returns the stored length or a negative
 * errno. */
int linkr_bond_label_set(const bt_addr_le_t *addr, const char *utf8, size_t len);

/* Remove the label. A missing key is not an error. */
int linkr_bond_label_clear(const bt_addr_le_t *addr);
