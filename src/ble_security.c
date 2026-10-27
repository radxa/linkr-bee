/* SPDX-License-Identifier: Apache-2.0 */
#include <errno.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/logging/log.h>
#include "ble_security.h"

LOG_MODULE_REGISTER(linkr_ble_security, LOG_LEVEL_INF);

/* Every Linkr GATT attribute is encryption-only, so pairing must never run on a
 * controller whose Security Manager was compiled out. The symbol differs by
 * controller generation: C3 uses the legacy ESP32_BT_CTLR_* menu, while
 * C2/C5/C6/H2 use the newer ESP32_BT_LE_* menu (see the matching overrides in
 * Kconfig). Both paths default off because BT_CTLR_LE_ENC is unset when the
 * Espressif controller is used instead of Zephyr's own BT_CTLR. */
#if (defined(CONFIG_SOC_SERIES_ESP32C3) || defined(CONFIG_SOC_SERIES_ESP32)) && \
	!defined(CONFIG_ESP32_BT_CTLR_LE_SECURITY_ENABLE)
#error "ESP32/ESP32-C3 pairing requires controller link encryption support"
#endif

#if (defined(CONFIG_SOC_SERIES_ESP32C2) || defined(CONFIG_SOC_SERIES_ESP32C5) || \
     defined(CONFIG_SOC_SERIES_ESP32C6) || defined(CONFIG_SOC_SERIES_ESP32H2)) && \
	(!defined(CONFIG_ESP32_BT_LE_SECURITY_ENABLE) ||                    \
	 !defined(CONFIG_ESP32_BT_LE_SM_SC) ||                              \
	 !defined(CONFIG_ESP32_BT_LE_LL_CFG_FEAT_LE_ENCRYPTION) ||          \
	 !defined(CONFIG_ESP32_BT_LE_CRYPTO_STACK_MBEDTLS))
#error "ESP32-C2/C5/C6/H2 pairing requires controller security and encryption support"
#endif

/* Boards without a pairing key leave linkr-pairing undefined. Keep the GPIO
 * out of the image entirely when the authorization gate is disabled, so a new
 * board only has to describe the hardware it actually has. */
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH)
static const struct gpio_dt_spec pairing_gpio =
	GPIO_DT_SPEC_GET(DT_ALIAS(linkr_pairing), gpios);
#endif

static enum bt_security_err pairing_accept(
	struct bt_conn *conn, const struct bt_conn_pairing_feat *const feat)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(feat);
	/* Applies to every new key exchange, including replacement of a bond.
	 * Existing LTK encryption does not invoke this callback. A GPIO read
	 * failure must fail closed, not be mistaken for an active-low input. */
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH)
	if (gpio_pin_get_dt(&pairing_gpio) != 1) {
		LOG_WRN("Pairing denied: hold the pairing GPIO low before requesting pairing");
		return BT_SECURITY_ERR_PAIR_NOT_ALLOWED;
	}
#endif
	LOG_INF("Pairing authorized");
	return BT_SECURITY_ERR_SUCCESS;
}

static void pairing_complete(struct bt_conn *conn, bool bonded)
{
	if (!bonded) {
		LOG_ERR("Pairing completed without a bond; disconnecting");
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
		return;
	}
	/* Zephyr BT_SETTINGS persists the negotiated keys; never log them. */
	LOG_INF("BLE pairing complete (bonded)");
}

static void pairing_failed(struct bt_conn *conn, enum bt_security_err reason)
{
	LOG_WRN("BLE pairing failed: %u", reason);
	(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
}

static void security_changed(struct bt_conn *conn, bt_security_t level,
			     enum bt_security_err err)
{
	if (err || level < BT_SECURITY_L2) {
		LOG_WRN("BLE encryption failed: %u", err);
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
		return;
	}
	LOG_INF("BLE encrypted link ready (level %u)", level);
}

static const struct bt_conn_auth_cb auth_callbacks = {
	.pairing_accept = pairing_accept,
};

static struct bt_conn_auth_info_cb auth_info_callbacks = {
	.pairing_complete = pairing_complete,
	.pairing_failed = pairing_failed,
};

BT_CONN_CB_DEFINE(linkr_security_callbacks) = {
	.security_changed = security_changed,
};

int linkr_ble_security_init(void)
{
	int err;

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH)
	if (!gpio_is_ready_dt(&pairing_gpio)) return -ENODEV;
	err = gpio_pin_configure_dt(&pairing_gpio, GPIO_INPUT);
	if (err) return err;
#endif
	err = bt_conn_auth_cb_register(&auth_callbacks);
	if (err) return err;
	return bt_conn_auth_info_cb_register(&auth_info_callbacks);
}

void linkr_ble_security_connected(struct bt_conn *conn)
{
	struct bt_conn_info info;
	int err = bt_conn_get_info(conn, &info);

	if (!err && !bt_le_bond_exists(info.id, bt_conn_get_dst(conn))) {
		/* The host initiates its first pairing explicitly or in response to
		 * an encrypted GATT access. Avoid racing Android createBond(). */
		if (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH)) {
			LOG_INF("Unbonded host: waiting for GPIO-authorized pairing");
		} else {
			LOG_INF("Unbonded host: pairing allowed without GPIO check");
		}
		return;
	}
	/* Restore encryption using the saved LTK without forcing a new pairing. */
	if (!err) err = bt_conn_set_security(conn, BT_SECURITY_L2);

	if (err) {
		LOG_WRN("Cannot request BLE encryption: %d", err);
		(void)bt_conn_disconnect(conn, BT_HCI_ERR_AUTH_FAIL);
	}
}
