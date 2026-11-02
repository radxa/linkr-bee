/* SPDX-License-Identifier: Apache-2.0 */
#pragma once
#include <zephyr/bluetooth/conn.h>
#include <stdbool.h>
#include <stddef.h>
bool linkr_bond_command(struct bt_conn *conn, const char *command, char *reply, size_t size);

/* True for commands that only read: `bonds?` and a bare-address label query.
 * Setters and removal need the control owner. */
bool linkr_bond_is_readonly(const char *command);
