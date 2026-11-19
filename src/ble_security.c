/* SPDX-License-Identifier: Apache-2.0 */
#include <errno.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "ble_security.h"

LOG_MODULE_REGISTER(linkr_ble_security, LOG_LEVEL_INF);

/* Every Linkr GATT attribute is encryption-only, so pairing must never run on a
 * controller whose Security Manager was compiled out. The symbol differs by
 * controller generation: C3 uses the legacy ESP32_BT_CTLR_* menu, while
 * C2/C5/C6/H2 use the newer ESP32_BT_LE_* menu (see the matching overrides in
 * Kconfig). Both paths default off because BT_CTLR_LE_ENC is unset when the
 * Espressif controller is used instead of Zephyr's own BT_CTLR. */
#if (defined(CONFIG_SOC_SERIES_ESP32C3) || defined(CONFIG_SOC_SERIES_ESP32S3) || \
     defined(CONFIG_SOC_SERIES_ESP32)) &&                                      \
	!defined(CONFIG_ESP32_BT_CTLR_LE_SECURITY_ENABLE)
#error "ESP32/ESP32-C3/S3 pairing requires controller link encryption support"
#endif

#if (defined(CONFIG_SOC_SERIES_ESP32C2) || defined(CONFIG_SOC_SERIES_ESP32C5) || \
     defined(CONFIG_SOC_SERIES_ESP32C6) || defined(CONFIG_SOC_SERIES_ESP32H2)) && \
	(!defined(CONFIG_ESP32_BT_LE_SECURITY_ENABLE) ||                    \
	 !defined(CONFIG_ESP32_BT_LE_SM_SC) ||                              \
	 !defined(CONFIG_ESP32_BT_LE_LL_CFG_FEAT_LE_ENCRYPTION) ||          \
	 !defined(CONFIG_ESP32_BT_LE_CRYPTO_STACK_MBEDTLS))
#error "ESP32-C2/C5/C6/H2 pairing requires controller security and encryption support"
#endif

static const struct gpio_dt_spec pairing_gpio =
	GPIO_DT_SPEC_GET(DT_ALIAS(linkr_pairing), gpios);

/* The host almost never starts pairing while the user is still holding the key:
 * scanning, choosing the device and the browser's own connect happen first, and
 * the pairing request follows later. Latch the press and accept pairing for a
 * short window afterwards. The security property stays "a person touched the
 * board before this host could pair", without asking the user to guess when the
 * host will ask for keys. */
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH)
#define PAIRING_GRACE_MS CONFIG_LINKR_BLE_BRIDGE_PAIRING_GRACE_MS
#else
#define PAIRING_GRACE_MS 0
#endif

static struct gpio_callback pairing_press_callback;
/* A 32-bit millisecond timestamp would reopen an old authorization every
 * 49.7 days. Keep the full uptime and protect the shared 64-bit value from
 * torn reads between the GPIO ISR and the Bluetooth thread on 32-bit MCUs. */
static struct k_spinlock pairing_press_lock;
static int64_t pairing_pressed_at;
static bool pairing_press_seen;

static void pairing_press_latch(void)
{
	k_spinlock_key_t key = k_spin_lock(&pairing_press_lock);

	pairing_pressed_at = k_uptime_get();
	pairing_press_seen = true;
	k_spin_unlock(&pairing_press_lock, key);
}

static void pairing_pressed(const struct device *port,
			    struct gpio_callback *callback, gpio_port_pins_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(callback);
	ARG_UNUSED(pins);

	/* Interrupt context: only record when the press happened. */
	pairing_press_latch();
}

/* True while the pairing GPIO is held active, or within PAIRING_GRACE_MS of
 * the last press. A failed read fails closed rather than authorizing pairing. */
static bool pairing_gpio_authorizes(void)
{
	int pressed;
	int64_t age;
	bool authorized;
	k_spinlock_key_t key;

	if (!IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH)) {
		return true;
	}
	pressed = gpio_pin_get_dt(&pairing_gpio);
	if (pressed < 0) {
		return false;
	}
	if (pressed == 1) {
		return true;
	}
	if (PAIRING_GRACE_MS <= 0) {
		return false;
	}
	key = k_spin_lock(&pairing_press_lock);
	age = k_uptime_get() - pairing_pressed_at;
	authorized = pairing_press_seen && age >= 0 && age <= PAIRING_GRACE_MS;
	k_spin_unlock(&pairing_press_lock, key);
	return authorized;
}

static enum bt_security_err pairing_accept(
	struct bt_conn *conn, const struct bt_conn_pairing_feat *const feat)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(feat);
	/* Applies to every new key exchange, including replacement of a bond.
	 * Existing LTK encryption does not invoke this callback. */
	if (!pairing_gpio_authorizes()) {
		LOG_WRN("Pairing denied: press the pairing GPIO, then request pairing again");
		return BT_SECURITY_ERR_PAIR_NOT_ALLOWED;
	}
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

	if (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH)) {
		if (!gpio_is_ready_dt(&pairing_gpio)) return -ENODEV;
		err = gpio_pin_configure_dt(&pairing_gpio, GPIO_INPUT);
		if (err) return err;
		/* Register the callback before enabling the edge, so a press that
		 * lands while the interrupt is being configured is still latched by
		 * the initial level read below instead of being lost. */
		gpio_init_callback(&pairing_press_callback, pairing_pressed,
				   BIT(pairing_gpio.pin));
		err = gpio_add_callback_dt(&pairing_gpio, &pairing_press_callback);
		if (err) return err;
		err = gpio_pin_interrupt_configure_dt(&pairing_gpio,
						     GPIO_INT_EDGE_TO_ACTIVE);
		if (err) return err;
		/* A key already held at init produces no edge; latch it here. */
		if (gpio_pin_get_dt(&pairing_gpio) == 1) {
			pairing_press_latch();
		}
	}
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
