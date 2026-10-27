/* Exercise production pairing callbacks against deterministic GPIO/BT fakes. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <errno.h>
#include <stdarg.h>
#include <string.h>

struct bt_conn { int unused; };
struct bt_conn_info { uint8_t id; };
static bool bonded_peer = true;
struct bt_conn_pairing_feat { int unused; };
struct gpio_dt_spec { int unused; };
typedef int bt_security_t;
enum bt_security_err { BT_SECURITY_ERR_SUCCESS, BT_SECURITY_ERR_PAIR_NOT_ALLOWED };
struct bt_conn_auth_cb {
    enum bt_security_err (*pairing_accept)(struct bt_conn *, const struct bt_conn_pairing_feat *const);
};
struct bt_conn_auth_info_cb {
    void (*pairing_complete)(struct bt_conn *, bool);
    void (*pairing_failed)(struct bt_conn *, enum bt_security_err);
};
struct bt_conn_cb {
    void (*security_changed)(struct bt_conn *, bt_security_t, enum bt_security_err);
};
#define BT_SECURITY_L2 2
#define BT_HCI_ERR_AUTH_FAIL 5
/* Both configurations are compiled; the default mirrors Kconfig's gate=y. */
#ifndef CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH
#define CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH 1
#endif
#define IS_ENABLED(option) (option)
#define GPIO_INPUT 1
#define GPIO_DT_SPEC_GET(...) { 0 }
#define BT_CONN_CB_DEFINE(name) struct bt_conn_cb name
#define ARG_UNUSED(x) (void)(x)
#define LOG_MODULE_REGISTER(...)
static void quiet_log(const char *fmt, ...) { (void)fmt; }
#define LOG_WRN(...) quiet_log(__VA_ARGS__)
#define LOG_INF(...) quiet_log(__VA_ARGS__)
#define LOG_ERR(...) quiet_log(__VA_ARGS__)
static int gpio_value, gpio_reads, configured_error, request_error, disconnects;
static int security_requested;
static bool gpio_ready = true;
static const struct bt_conn_auth_cb *registered_auth;
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH)
static inline bool gpio_is_ready_dt(const struct gpio_dt_spec *p) { (void)p; return gpio_ready; }
static inline int gpio_pin_configure_dt(const struct gpio_dt_spec *p, int mode)
{ (void)p; assert(mode == GPIO_INPUT); return configured_error; }
static inline int gpio_pin_get_dt(const struct gpio_dt_spec *p)
{ (void)p; gpio_reads++; return gpio_value; }
#endif
static int bt_conn_auth_cb_register(const struct bt_conn_auth_cb *cb)
{ registered_auth = cb; return 0; }
static int bt_conn_auth_info_cb_register(struct bt_conn_auth_info_cb *cb)
{ assert(cb->pairing_complete && cb->pairing_failed); return 0; }
static int bt_conn_disconnect(struct bt_conn *conn, int reason)
{ (void)conn; assert(reason == BT_HCI_ERR_AUTH_FAIL); disconnects++; return 0; }
static int bt_conn_set_security(struct bt_conn *conn, int security)
{ (void)conn; security_requested = security; return request_error; }
static int bt_conn_get_info(struct bt_conn *conn, struct bt_conn_info *info)
{ (void)conn; info->id = 1; return 0; }
static const void *bt_conn_get_dst(struct bt_conn *conn) { return conn; }
static bool bt_le_bond_exists(uint8_t id, const void *dst)
{ assert(id == 1 && dst); return bonded_peer; }

#include "security_production.inc"

int main(int argc, char **argv)
{
    struct bt_conn conn = { 0 };
    struct bt_conn_pairing_feat feat = { 0 };
    assert(argc == 2);
    assert(linkr_ble_security_init() == 0);
    if (!strcmp(argv[1], "gate")) {
        gpio_value = 0; /* GPIO1 high: inactive logical value. */
        assert(registered_auth->pairing_accept(&conn, &feat) == BT_SECURITY_ERR_PAIR_NOT_ALLOWED);
        gpio_value = -EIO;
        assert(registered_auth->pairing_accept(&conn, &feat) == BT_SECURITY_ERR_PAIR_NOT_ALLOWED);
        gpio_value = 1; /* GPIO1 low: active logical value. */
        assert(registered_auth->pairing_accept(&conn, &feat) == BT_SECURITY_ERR_SUCCESS);
        pairing_complete(&conn, true);
        gpio_value = 0;
        /* Successful bonding cannot grant blanket permission to replace keys. */
        assert(registered_auth->pairing_accept(&conn, &feat) == BT_SECURITY_ERR_PAIR_NOT_ALLOWED);
        gpio_value = 1;
        assert(registered_auth->pairing_accept(&conn, &feat) == BT_SECURITY_ERR_SUCCESS);
        assert(disconnects == 0);
    } else if (!strcmp(argv[1], "open_pairing")) {
        assert(!IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH));
        gpio_ready = false;
        configured_error = -EIO;
        assert(linkr_ble_security_init() == 0);
        for (int value = -1; value <= 1; value++) {
            gpio_value = value;
            assert(registered_auth->pairing_accept(&conn, &feat) == BT_SECURITY_ERR_SUCCESS);
        }
        assert(gpio_reads == 0);
        pairing_complete(&conn, true);
        assert(disconnects == 0);
    } else if (!strcmp(argv[1], "reconnect")) {
        gpio_value = 0;
        linkr_ble_security_connected(&conn);
        assert(security_requested == BT_SECURITY_L2); /* No FORCE_PAIR. */
        assert(gpio_reads == 0);
        security_changed(&conn, BT_SECURITY_L2, BT_SECURITY_ERR_SUCCESS);
        assert(disconnects == 0);
        request_error = -EIO;
        linkr_ble_security_connected(&conn);
        assert(disconnects == 1);
        bonded_peer = false;
        security_requested = 0;
        linkr_ble_security_connected(&conn);
        assert(security_requested == 0 && gpio_reads == 0);
    } else if (!strcmp(argv[1], "fail_closed")) {
        security_changed(&conn, 1, BT_SECURITY_ERR_SUCCESS);
        security_changed(&conn, 2, BT_SECURITY_ERR_PAIR_NOT_ALLOWED);
        pairing_complete(&conn, false);
        pairing_failed(&conn, BT_SECURITY_ERR_PAIR_NOT_ALLOWED);
        assert(disconnects == 4);
        gpio_ready = false;
        assert(linkr_ble_security_init() == (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH) ? -ENODEV : 0));
        gpio_ready = true;
        configured_error = -EIO;
        assert(linkr_ble_security_init() == (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH) ? -EIO : 0));
    } else return 1;
    return 0;
}
