/*
 * WiFi station + WebDAV serial log upload for the Linkr Bee bridge.
 *
 * Enabled by default through CONFIG_LINKR_BLE_BRIDGE_WIFI. When enabled, it:
 *   - loads persisted WebDAV config and, when explicitly enabled, WiFi
 *     credentials from Zephyr settings (NVS)
 *   - auto-connects to WiFi on boot only when credential persistence is on
 *   - exposes BLE control commands (@w/@webdav) via the handlers in main.c
 *   - feeds UART RX bytes into a ring buffer and periodically HTTP-PUTs them
 *     to <webdav_url>log-<boot>-<sequence>-<uptime>.txt batch files
 *
 * The WiFi stack uses the standard Zephyr net_mgmt / wifi_mgmt APIs; the
 * underlying SoC driver is selected by the board/workspace Kconfig.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include "wifi.h"

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WIFI)

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/dhcpv4.h>
#include <zephyr/net/dns_resolve.h>
#include <zephyr/net/http/client.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/socket.h>
#include <zephyr/net/wifi.h>
#include <zephyr/net/wifi_mgmt.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/ring_buffer.h>

LOG_MODULE_REGISTER(linkr_wifi, CONFIG_LOG_DEFAULT_LEVEL);

#define SSID_MAX   CONFIG_LINKR_BLE_BRIDGE_WIFI_SSID_MAX
#define PSK_MAX    CONFIG_LINKR_BLE_BRIDGE_WIFI_PSK_MAX
#define URL_MAX    CONFIG_LINKR_BLE_BRIDGE_WEBDAV_URL_MAX
#define CRED_MAX   CONFIG_LINKR_BLE_BRIDGE_WEBDAV_CRED_MAX
#define LOG_RING_SIZE 8192
#define SETTINGS_MAGIC 0x4c4e4b52u /* "LNKR" */
#define SETTINGS_VERSION 1u
/* Leaves room for the completion marker in the control-response queue. */
#define WIFI_SCAN_MAX_RESULTS 12

static char wifi_ssid[SSID_MAX + 1];
static char wifi_psk[PSK_MAX + 1];
static char webdav_url[URL_MAX + 1];
static char webdav_user[CRED_MAX + 1];
static char webdav_pass[CRED_MAX + 1];

static struct k_mutex cfg_lock;
static struct net_mgmt_event_callback wifi_mgmt_cb;
static struct net_mgmt_event_callback ip_mgmt_cb;
static struct net_mgmt_event_callback wifi_scan_cb;
static struct net_if *wifi_iface;

/* Asynchronous scan state. linkr_wifi_scan() references conn for the lifetime
 * of the scan; results are streamed through scan_respond and released on
 * NET_EVENT_WIFI_SCAN_DONE. */
static linkr_wifi_respond_fn scan_respond;
static struct bt_conn *scan_conn;
static atomic_t scan_in_progress;
static struct k_work wifi_scan_work;
static struct k_mutex scan_cache_lock;
static struct k_work_delayable wifi_retry_work;
static atomic_t wifi_connected;
static atomic_t wifi_ip_ready;
static atomic_t wifi_last_error;
static atomic_t wifi_reconnect_enabled;
static atomic_t wifi_state;
static atomic_t wifi_operation_id;
static linkr_wifi_event_fn wifi_event_sink;
static atomic_t webdav_configured;
static atomic_t webdav_generation;
static atomic_t log_dropped_bytes;
static atomic_t upload_pending_bytes;
static atomic_t upload_last_http_status;
static atomic_t upload_failures;
static atomic_t upload_successes;

struct wifi_scan_cache_entry {
    char ssid[WIFI_SSID_MAX_LEN + 1];
    uint8_t channel;
    int8_t rssi;
    enum wifi_security_type security;
};

static struct wifi_scan_cache_entry scan_cache[WIFI_SCAN_MAX_RESULTS];
static size_t scan_cache_count;

RING_BUF_DECLARE(log_ring, LOG_RING_SIZE);
static struct k_mutex log_lock;
/* Serializes a configuration change with an in-flight HTTP PUT. */
static struct k_mutex upload_lock;

#define UPLOAD_STACK  CONFIG_LINKR_BLE_BRIDGE_LOG_UPLOAD_STACK
#define UPLOAD_PRIO   6
static struct k_thread upload_thread_data;
static K_THREAD_STACK_DEFINE(upload_stack, UPLOAD_STACK);
static struct k_work_delayable wifi_retry_work;

struct linkr_wifi_settings {
    uint32_t magic;
    uint8_t version;
    uint8_t enabled;
    char ssid[SSID_MAX + 1];
    char psk[PSK_MAX + 1];
} __packed;

struct linkr_webdav_settings {
    uint32_t magic;
    uint8_t version;
    uint8_t enabled;
    char url[URL_MAX + 1];
    char user[CRED_MAX + 1];
    char pass[CRED_MAX + 1];
} __packed;

/* The old, per-field keys are only used once to migrate existing devices. */
static char legacy_wifi_ssid[SSID_MAX + 1];
static char legacy_wifi_psk[PSK_MAX + 1];
static char legacy_webdav_url[URL_MAX + 1];
static char legacy_webdav_user[CRED_MAX + 1];
static char legacy_webdav_pass[CRED_MAX + 1];
static struct linkr_wifi_settings loaded_wifi_settings;
static struct linkr_webdav_settings loaded_webdav_settings;
static bool wifi_settings_seen;
static bool wifi_settings_valid;
static bool webdav_settings_seen;
static bool webdav_settings_valid;
static uint64_t loaded_log_boot_id;
static bool log_boot_id_valid;
static uint64_t log_boot_id;
static bool log_boot_id_persisted;
static uint32_t log_sequence;

struct webdav_url {
    char host[64];
    uint16_t port;
    const char *path;   /* points into the source URL buffer */
};

static int parse_webdav_url(const char *url, struct webdav_url *out);

static void wifi_scan_cache_clear(void)
{
    k_mutex_lock(&scan_cache_lock, K_FOREVER);
    memset(scan_cache, 0, sizeof(scan_cache));
    scan_cache_count = 0;
    k_mutex_unlock(&scan_cache_lock);
}

static void wifi_scan_cache_update(const struct wifi_scan_result *result)
{
    struct wifi_scan_cache_entry *entry = NULL;
    char ssid[WIFI_SSID_MAX_LEN + 1];
    size_t weakest = 0;
    size_t ssid_len;

    if (!result || result->ssid_length == 0 || result->ssid[0] == '\0') {
        return;
    }

    ssid_len = MIN(result->ssid_length, WIFI_SSID_MAX_LEN);
    memcpy(ssid, result->ssid, ssid_len);
    for (size_t i = 0; i < ssid_len; i++) {
        if ((unsigned char)ssid[i] < 0x20 || ssid[i] == 0x7f) {
            ssid[i] = '?';
        }
    }
    ssid[ssid_len] = '\0';

    k_mutex_lock(&scan_cache_lock, K_FOREVER);
    for (size_t i = 0; i < scan_cache_count; i++) {
        if (strcmp(scan_cache[i].ssid, ssid) == 0) {
            entry = &scan_cache[i];
            break;
        }
    }

    if (!entry && scan_cache_count < ARRAY_SIZE(scan_cache)) {
        entry = &scan_cache[scan_cache_count++];
        entry->rssi = INT8_MIN;
    } else if (!entry) {
        for (size_t i = 1; i < scan_cache_count; i++) {
            if (scan_cache[i].rssi < scan_cache[weakest].rssi) {
                weakest = i;
            }
        }
        if (result->rssi > scan_cache[weakest].rssi) {
            entry = &scan_cache[weakest];
            entry->rssi = INT8_MIN;
        }
    }

    if (entry && result->rssi > entry->rssi) {
        memcpy(entry->ssid, ssid, ssid_len + 1);
        entry->channel = result->channel;
        entry->rssi = result->rssi;
        entry->security = result->security;
    }
    k_mutex_unlock(&scan_cache_lock);
}

static const char *wifi_security_name(enum wifi_security_type security)
{
    switch (security) {
    case WIFI_SECURITY_TYPE_NONE:
        return "open";
    case WIFI_SECURITY_TYPE_WEP:
        return "wep";
    case WIFI_SECURITY_TYPE_WPA_PSK:
        return "wpa";
    case WIFI_SECURITY_TYPE_PSK:
        return "wpa2";
    case WIFI_SECURITY_TYPE_PSK_SHA256:
        return "wpa2-sha256";
    case WIFI_SECURITY_TYPE_SAE:
    case WIFI_SECURITY_TYPE_SAE_H2E:
    case WIFI_SECURITY_TYPE_SAE_AUTO:
        return "wpa3";
    case WIFI_SECURITY_TYPE_EAP:
        return "eap";
    case WIFI_SECURITY_TYPE_WAPI:
        return "wapi";
    default:
        return "unknown";
    }
}

static void wifi_scan_cache_emit(void)
{
    char line[WIFI_SSID_MAX_LEN + 48];

    k_mutex_lock(&scan_cache_lock, K_FOREVER);
    for (size_t i = 1; i < scan_cache_count; i++) {
        struct wifi_scan_cache_entry entry = scan_cache[i];
        size_t j = i;

        while (j > 0 && scan_cache[j - 1].rssi < entry.rssi) {
            scan_cache[j] = scan_cache[j - 1];
            j--;
        }
        scan_cache[j] = entry;
    }

    for (size_t i = 0; i < scan_cache_count; i++) {
        snprintk(line, sizeof(line),
                 "@scan result %.*s %s ch=%u %ddBm",
                 WIFI_SSID_MAX_LEN, scan_cache[i].ssid,
                 wifi_security_name(scan_cache[i].security),
                 scan_cache[i].channel, scan_cache[i].rssi);
        scan_respond(scan_conn, line);
    }
    k_mutex_unlock(&scan_cache_lock);
}

/* ------------------------------------------------------------------------ */
/* Settings persistence                                                      */
/* ------------------------------------------------------------------------ */

static bool string_is_terminated(const char *value, size_t capacity)
{
    return memchr(value, '\0', capacity) != NULL;
}

static bool wifi_settings_are_valid(const struct linkr_wifi_settings *settings)
{
    if (settings->magic != SETTINGS_MAGIC ||
        settings->version != SETTINGS_VERSION || settings->enabled > 1) {
        return false;
    }
    if (!settings->enabled) {
        return true;
    }
    return settings->ssid[0] &&
           string_is_terminated(settings->ssid, sizeof(settings->ssid)) &&
           string_is_terminated(settings->psk, sizeof(settings->psk));
}

static bool webdav_settings_are_valid(const struct linkr_webdav_settings *settings)
{
    if (settings->magic != SETTINGS_MAGIC ||
        settings->version != SETTINGS_VERSION || settings->enabled > 1) {
        return false;
    }
    if (!settings->enabled) {
        return true;
    }
    return settings->url[0] &&
           string_is_terminated(settings->url, sizeof(settings->url)) &&
           string_is_terminated(settings->user, sizeof(settings->user)) &&
           string_is_terminated(settings->pass, sizeof(settings->pass));
}

static int linkr_settings_set(const char *name, size_t len,
                              settings_read_cb read_cb, void *cb_arg)
{
    ssize_t r;

    if (settings_name_steq(name, "wifi", NULL)) {
        wifi_settings_seen = true;
        if (!IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS) ||
            len != sizeof(loaded_wifi_settings)) {
            return 0;
        }
        r = read_cb(cb_arg, &loaded_wifi_settings,
                    sizeof(loaded_wifi_settings));
        wifi_settings_valid = r == sizeof(loaded_wifi_settings) &&
                              wifi_settings_are_valid(&loaded_wifi_settings);
        return 0;
    }
    if (settings_name_steq(name, "webdav", NULL)) {
        webdav_settings_seen = true;
        if (len != sizeof(loaded_webdav_settings)) {
            return 0;
        }
        r = read_cb(cb_arg, &loaded_webdav_settings,
                    sizeof(loaded_webdav_settings));
        webdav_settings_valid = r == sizeof(loaded_webdav_settings) &&
                                webdav_settings_are_valid(&loaded_webdav_settings);
        return 0;
    }
    if (settings_name_steq(name, "log_boot", NULL)) {
        if (len != sizeof(loaded_log_boot_id)) {
            return 0;
        }
        r = read_cb(cb_arg, &loaded_log_boot_id, sizeof(loaded_log_boot_id));
        log_boot_id_valid = r == sizeof(loaded_log_boot_id);
        return 0;
    }

    if (settings_name_steq(name, "ssid", NULL) && len <= SSID_MAX &&
        IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS)) {
        r = read_cb(cb_arg, legacy_wifi_ssid, len);
        if (r >= 0) {
            legacy_wifi_ssid[r] = '\0';
        }
        return 0;
    }
    if (settings_name_steq(name, "psk", NULL) && len <= PSK_MAX &&
        IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS)) {
        r = read_cb(cb_arg, legacy_wifi_psk, len);
        if (r >= 0) {
            legacy_wifi_psk[r] = '\0';
        }
        return 0;
    }
    if (settings_name_steq(name, "wurl", NULL) && len <= URL_MAX) {
        r = read_cb(cb_arg, legacy_webdav_url, len);
        if (r >= 0) {
            legacy_webdav_url[r] = '\0';
        }
        return 0;
    }
    if (settings_name_steq(name, "wuser", NULL) && len <= CRED_MAX) {
        r = read_cb(cb_arg, legacy_webdav_user, len);
        if (r >= 0) {
            legacy_webdav_user[r] = '\0';
        }
        return 0;
    }
    if (settings_name_steq(name, "wpass", NULL) && len <= CRED_MAX) {
        r = read_cb(cb_arg, legacy_webdav_pass, len);
        if (r >= 0) {
            legacy_webdav_pass[r] = '\0';
        }
        return 0;
    }
    return -ENOENT;
}

SETTINGS_STATIC_HANDLER_DEFINE(linkr, "linkr", NULL, linkr_settings_set,
                              NULL, NULL);

static int save_wifi_settings(const char *ssid, const char *psk)
{
    struct linkr_wifi_settings settings = {
        .magic = SETTINGS_MAGIC,
        .version = SETTINGS_VERSION,
        .enabled = ssid && ssid[0],
    };

    if (settings.enabled) {
        strncpy(settings.ssid, ssid, sizeof(settings.ssid) - 1);
        if (psk) {
            strncpy(settings.psk, psk, sizeof(settings.psk) - 1);
        }
    }
    return settings_save_one("linkr/wifi", &settings, sizeof(settings));
}

static int save_webdav_settings(const char *url, const char *user, const char *pass)
{
    struct linkr_webdav_settings settings = {
        .magic = SETTINGS_MAGIC,
        .version = SETTINGS_VERSION,
        .enabled = url && url[0],
    };

    if (settings.enabled) {
        strncpy(settings.url, url, sizeof(settings.url) - 1);
        if (user) {
            strncpy(settings.user, user, sizeof(settings.user) - 1);
        }
        if (pass) {
            strncpy(settings.pass, pass, sizeof(settings.pass) - 1);
        }
    }
    return settings_save_one("linkr/webdav", &settings, sizeof(settings));
}

static int advance_log_boot_id(void)
{
    uint64_t next = log_boot_id_valid ? loaded_log_boot_id + 1 : 1;
    int err;

    if (next == 0) {
        next = 1;
    }
    err = settings_save_one("linkr/log_boot", &next, sizeof(next));
    if (err) {
        /* Do not risk overwriting old WebDAV objects when settings is down. */
        LOG_WRN("could not reserve WebDAV boot id: %d", err);
        log_boot_id_persisted = false;
        return err;
    }

    log_boot_id = next;
    log_boot_id_persisted = true;
    return 0;
}

#define WIFI_CONNECT_STACK  8192
#define WIFI_CONNECT_PRIO   10

struct wifi_connect_msg {
	char ssid[SSID_MAX + 1];
	char psk[PSK_MAX + 1];
	uint32_t operation_id;
	bool wait_for_release;
};

K_MSGQ_DEFINE(wifi_connect_msgq, sizeof(struct wifi_connect_msg), 2, 4);
K_MSGQ_DEFINE(wifi_operation_release_queue, sizeof(uint32_t), 2, 4);
static struct k_thread wifi_connect_thread;
static K_THREAD_STACK_DEFINE(wifi_connect_stack, WIFI_CONNECT_STACK);

const char *linkr_wifi_state_name(enum linkr_wifi_state state)
{
	switch (state) {
	case LINKR_WIFI_STATE_OFF:
		return "off";
	case LINKR_WIFI_STATE_QUEUED:
		return "queued";
	case LINKR_WIFI_STATE_CONNECTING:
		return "connecting";
	case LINKR_WIFI_STATE_DHCP:
		return "dhcp";
	case LINKR_WIFI_STATE_READY:
		return "ready";
	case LINKR_WIFI_STATE_FAILED:
		return "failed";
	default:
		return "unknown";
	}
}

enum linkr_wifi_state linkr_wifi_get_state(void)
{
	return (enum linkr_wifi_state)atomic_get(&wifi_state);
}

void linkr_wifi_set_event_fn(linkr_wifi_event_fn fn)
{
	wifi_event_sink = fn;
}

static void wifi_publish_state(enum linkr_wifi_state state, int error)
{
	uint32_t operation_id = (uint32_t)atomic_get(&wifi_operation_id);

	atomic_set(&wifi_state, state);
	if (error) {
		atomic_set(&wifi_last_error, error);
	} else if (state != LINKR_WIFI_STATE_FAILED) {
		atomic_clear(&wifi_last_error);
	}
	if (wifi_event_sink) {
		wifi_event_sink(operation_id, state, error);
	}
}

/* ------------------------------------------------------------------------ */
/* WiFi management                                                          */
/* ------------------------------------------------------------------------ */

static void schedule_wifi_retry(void)
{
    if (atomic_get(&wifi_reconnect_enabled)) {
        (void)k_work_reschedule(&wifi_retry_work,
                                K_MSEC(CONFIG_LINKR_BLE_BRIDGE_WIFI_RETRY_MS));
    }
}

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-variable"
static void wifi_retry_work_handler(struct k_work *work)
{
	struct wifi_connect_msg msg;
	char ssid[sizeof(wifi_ssid)];
	char psk[sizeof(wifi_psk)];

	ARG_UNUSED(work);

	if (!atomic_get(&wifi_reconnect_enabled)) {
		return;
	}

	k_mutex_lock(&cfg_lock, K_FOREVER);
	strncpy(ssid, wifi_ssid, sizeof(ssid) - 1);
	ssid[sizeof(ssid) - 1] = '\0';
	strncpy(psk, wifi_psk, sizeof(psk) - 1);
	psk[sizeof(psk) - 1] = '\0';
	k_mutex_unlock(&cfg_lock);

	if (!ssid[0]) {
		schedule_wifi_retry();
		return;
	}

	memset(&msg, 0, sizeof(msg));
	strncpy(msg.ssid, ssid, sizeof(msg.ssid) - 1);
	msg.ssid[sizeof(msg.ssid) - 1] = '\0';
	strncpy(msg.psk, psk, sizeof(msg.psk) - 1);
	msg.psk[sizeof(msg.psk) - 1] = '\0';
	msg.operation_id = 0;
	if (k_msgq_put(&wifi_connect_msgq, &msg, K_NO_WAIT) != 0) {
		schedule_wifi_retry();
	}
}
#pragma GCC diagnostic pop

static void wifi_event_handler(struct net_mgmt_event_callback *cb,
                               unsigned long long mgmt_event,
                               struct net_if *iface)
{
    const struct wifi_status *status;

    ARG_UNUSED(cb);

    if (wifi_iface && iface != wifi_iface) {
        return;
    }

    if (mgmt_event == NET_EVENT_WIFI_CONNECT_RESULT) {
        status = (const struct wifi_status *)cb->info;
        if (status && status->status == 0) {
            atomic_set(&wifi_connected, 1);
            atomic_set(&wifi_ip_ready, 0);
            atomic_clear(&wifi_last_error);
            LOG_INF("WiFi connected to \"%s\"", wifi_ssid);
            /* Start DHCPv4 ourselves (no CONFIG_NET_CONFIG_AUTO_INIT). */
            if (iface) {
                net_dhcpv4_start(iface);
            }
			wifi_publish_state(LINKR_WIFI_STATE_DHCP, 0);
        } else {
            atomic_set(&wifi_connected, 0);
            atomic_set(&wifi_ip_ready, 0);
            atomic_set(&wifi_last_error, status ? status->status : -1);
            LOG_WRN("WiFi connect failed: %d",
                    status ? status->status : -1);
			wifi_publish_state(LINKR_WIFI_STATE_FAILED,
					   status ? status->status : -1);
			atomic_clear(&wifi_operation_id);
			schedule_wifi_retry();
        }
    } else if (mgmt_event == NET_EVENT_WIFI_DISCONNECT_RESULT) {
		enum linkr_wifi_state next_state;
        /* The application owns DHCP when ESP32 auto-DHCP is disabled. Stop
         * it here so a later reconnect starts a fresh lease transaction and
         * produces a new IPv4 address event. */
        if (iface) {
            net_dhcpv4_stop(iface);
        }
        atomic_set(&wifi_connected, 0);
        atomic_set(&wifi_ip_ready, 0);
        LOG_INF("WiFi disconnected");
		next_state = atomic_get(&wifi_reconnect_enabled) ?
			     LINKR_WIFI_STATE_FAILED : LINKR_WIFI_STATE_OFF;
		if (linkr_wifi_get_state() != next_state) {
			wifi_publish_state(next_state,
				atomic_get(&wifi_reconnect_enabled) ?
				(int)atomic_get(&wifi_last_error) : 0);
		}
		if (atomic_get(&wifi_reconnect_enabled)) {
			atomic_clear(&wifi_operation_id);
		}
		schedule_wifi_retry();
    } else if (mgmt_event == NET_EVENT_IPV4_ADDR_ADD) {
        atomic_set(&wifi_ip_ready, 1);
        LOG_INF("WiFi IPv4 address ready");
		wifi_publish_state(LINKR_WIFI_STATE_READY, 0);
		/* READY is the final event for the accepted management operation.
		 * Later lease or link changes are background events (operation 0). */
		atomic_clear(&wifi_operation_id);
    } else if (mgmt_event == NET_EVENT_IPV4_ADDR_DEL) {
        atomic_set(&wifi_ip_ready, 0);
        LOG_INF("WiFi IPv4 address removed");
		if (atomic_get(&wifi_connected)) {
			wifi_publish_state(LINKR_WIFI_STATE_DHCP, 0);
		}
    }
}

int linkr_wifi_connect(const char *ssid, const char *psk)
{
    struct wifi_connect_req_params params;
    struct wifi_ps_params ps_params = {
        .enabled = WIFI_PS_DISABLED,
        .type = WIFI_PS_PARAM_STATE,
    };
    int err;

    if (!ssid || !ssid[0] || !wifi_iface) {
        return -EINVAL;
    }

    memset(&params, 0, sizeof(params));
    params.ssid = (const uint8_t *)ssid;
    params.ssid_length = strlen(ssid);
    if (psk && psk[0]) {
        params.psk = (const uint8_t *)psk;
        params.psk_length = strlen(psk);
        params.security = WIFI_SECURITY_TYPE_PSK;
    } else {
        params.security = WIFI_SECURITY_TYPE_NONE;
    }
    params.channel = WIFI_CHANNEL_ANY;
    params.band = WIFI_FREQ_BAND_2_4_GHZ;

    LOG_INF("WiFi connect request: ssid=\"%s\" security=%s psk_len=%u",
            ssid, psk && psk[0] ? "psk" : "open",
            (unsigned int)params.psk_length);

    atomic_set(&wifi_connected, 0);
    atomic_set(&wifi_ip_ready, 0);
    err = net_mgmt(NET_REQUEST_WIFI_CONNECT, wifi_iface,
                   &params, sizeof(params));
    if (err) {
        atomic_set(&wifi_last_error, err);
        LOG_WRN("WiFi connect request failed: %d", err);
        schedule_wifi_retry();
        return err;
    }

    /* Keep authentication latency deterministic while BLE is active. Use the
     * public Zephyr API so local and CI builds do not depend on a patched
     * esp_wifi_drv.c. The ESP32 driver has already started WiFi by the time the
     * synchronous connect request returns. */
    err = net_mgmt(NET_REQUEST_WIFI_PS, wifi_iface,
                   &ps_params, sizeof(ps_params));
    if (err) {
        LOG_WRN("could not disable WiFi power save: %d", err);
    } else {
        LOG_INF("WiFi power save disabled");
    }

    return 0;
}

int linkr_wifi_disconnect(void)
{
    if (!wifi_iface) {
        return -EINVAL;
    }
    return net_mgmt(NET_REQUEST_WIFI_DISCONNECT, wifi_iface, NULL, 0);
}

/* ------------------------------------------------------------------------ */
/* WiFi scan (asynchronous, streamed over BLE)                              */
/* ------------------------------------------------------------------------ */

void linkr_wifi_set_respond_fn(linkr_wifi_respond_fn fn)
{
    scan_respond = fn;
}

static void wifi_scan_event_handler(struct net_mgmt_event_callback *cb,
                                    unsigned long long mgmt_event,
                                    struct net_if *iface)
{
    if (wifi_iface && iface != wifi_iface) {
        return;
    }
    if (!atomic_get(&scan_in_progress) || !scan_respond) {
        return;
    }

    if (mgmt_event == NET_EVENT_WIFI_SCAN_RESULT) {
        const struct wifi_scan_result *result =
            (const struct wifi_scan_result *)cb->info;

        if (!result) {
            return;
        }
        wifi_scan_cache_update(result);
    } else if (mgmt_event == NET_EVENT_WIFI_SCAN_DONE) {
        const struct wifi_status *status =
            (const struct wifi_status *)cb->info;
        bool ok = status ? (status->status == 0) : true;

        if (ok) {
            wifi_scan_cache_emit();
        }
        scan_respond(scan_conn, ok ? "@scan done" : "@scan error");
        if (scan_conn) {
            bt_conn_unref(scan_conn);
            scan_conn = NULL;
        }
        atomic_set(&scan_in_progress, 0);
    }
}

static void wifi_scan_release(void)
{
    if (scan_conn) {
        bt_conn_unref(scan_conn);
        scan_conn = NULL;
    }
    atomic_set(&scan_in_progress, 0);
}

static void wifi_scan_work_handler(struct k_work *work)
{
    struct wifi_scan_params params;
    int err;

    ARG_UNUSED(work);
    memset(&params, 0, sizeof(params));
    params.bands = BIT(WIFI_FREQ_BAND_2_4_GHZ);
    params.max_bss_cnt = 0;

    /* esp_wifi_start()/esp_wifi_scan_start() can consume more stack than the
     * Bluetooth RX workqueue owns. Start the scan on the 4 KiB system
     * workqueue; result callbacks remain asynchronous. */
    err = net_mgmt(NET_REQUEST_WIFI_SCAN, wifi_iface,
                   &params, sizeof(params));
    if (err) {
        LOG_WRN("WiFi scan request failed: %d", err);
        if (scan_respond) {
            scan_respond(scan_conn, "@scan error");
        }
        wifi_scan_release();
        return;
    }

    LOG_INF("WiFi scan started");
}

int linkr_wifi_scan(struct bt_conn *conn)
{
    if (!wifi_iface) {
        return -ENODEV;
    }
    if (!atomic_cas(&scan_in_progress, 0, 1)) {
        return -EBUSY;
    }
    if (!scan_respond) {
        LOG_WRN("scan requested but no response sink registered");
        atomic_clear(&scan_in_progress);
        return -ENOSYS;
    }

    scan_conn = conn ? bt_conn_ref(conn) : NULL;
    wifi_scan_cache_clear();

	return 0;
}

void linkr_wifi_release_scan(void)
{
	int err = k_work_submit(&wifi_scan_work);

	if (err < 0) {
		LOG_WRN("WiFi scan work submit failed: %d", err);
		if (scan_respond) {
			scan_respond(scan_conn, "@scan error");
		}
		wifi_scan_release();
	}
}

bool linkr_wifi_is_connected(void)
{
    return atomic_get(&wifi_connected) != 0;
}

bool linkr_wifi_has_ip(void)
{
    return atomic_get(&wifi_ip_ready) != 0;
}

static void wifi_connect_thread_fn(void *p1, void *p2, void *p3)
{
	struct wifi_connect_msg msg;

	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	for (;;) {
		if (k_msgq_get(&wifi_connect_msgq, &msg, K_FOREVER) != 0) {
			continue;
		}
		if (msg.wait_for_release) {
			uint32_t released_operation_id;

			k_msgq_get(&wifi_operation_release_queue,
				   &released_operation_id, K_FOREVER);
			if (released_operation_id != msg.operation_id) {
				LOG_ERR("WiFi operation order mismatch: %u != %u",
					released_operation_id, msg.operation_id);
				continue;
			}
		}
		atomic_set(&wifi_operation_id, msg.operation_id);
		wifi_publish_state(LINKR_WIFI_STATE_QUEUED, 0);

		if (msg.ssid[0]) {
			int err;

			wifi_publish_state(LINKR_WIFI_STATE_CONNECTING, 0);
			LOG_INF("WiFi connect thread: %s", msg.ssid);
			err = linkr_wifi_connect(msg.ssid, msg.psk);
			LOG_INF("WiFi connect thread result: %d", err);
			if (err) {
				wifi_publish_state(LINKR_WIFI_STATE_FAILED, err);
				atomic_clear(&wifi_operation_id);
			}
		} else {
			LOG_INF("WiFi disconnect thread");
			atomic_set(&wifi_reconnect_enabled, 0);
			(void)k_work_cancel_delayable(&wifi_retry_work);
			(void)linkr_wifi_disconnect();
			if (linkr_wifi_get_state() != LINKR_WIFI_STATE_OFF) {
				wifi_publish_state(LINKR_WIFI_STATE_OFF, 0);
			}
			/* OFF is final; do not reuse its request ID for a later
			 * unsolicited WiFi state change. */
			atomic_clear(&wifi_operation_id);
		}
	}
}

int linkr_wifi_set_config_op(const char *ssid, const char *psk,
			     uint32_t operation_id)
{
	struct wifi_connect_msg msg;
	int err;

	if (!ssid || !ssid[0] || strlen(ssid) > SSID_MAX) {
		return -EINVAL;
	}
	if (psk && strlen(psk) > PSK_MAX) {
		return -EINVAL;
	}

	if (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS)) {
		err = save_wifi_settings(ssid, psk ? psk : "");
		if (err) {
			LOG_WRN("save WiFi settings failed: %d", err);
			return err;
		}
	}

	k_mutex_lock(&cfg_lock, K_FOREVER);
	strncpy(wifi_ssid, ssid, sizeof(wifi_ssid) - 1);
	wifi_ssid[sizeof(wifi_ssid) - 1] = '\0';
	strncpy(wifi_psk, psk ? psk : "", sizeof(wifi_psk) - 1);
	wifi_psk[sizeof(wifi_psk) - 1] = '\0';
	k_mutex_unlock(&cfg_lock);

	memset(&msg, 0, sizeof(msg));
	strncpy(msg.ssid, ssid, sizeof(msg.ssid) - 1);
	msg.ssid[sizeof(msg.ssid) - 1] = '\0';
	strncpy(msg.psk, psk ? psk : "", sizeof(msg.psk) - 1);
	msg.psk[sizeof(msg.psk) - 1] = '\0';
	msg.operation_id = operation_id;
	msg.wait_for_release = operation_id != 0;

	atomic_set(&wifi_reconnect_enabled, 1);
	err = k_msgq_put(&wifi_connect_msgq, &msg, K_NO_WAIT);
	if (err) {
		LOG_WRN("WiFi connect msgq put failed: %d", err);
		return err;
	}
	return 0;
}

int linkr_wifi_set_config(const char *ssid, const char *psk)
{
	return linkr_wifi_set_config_op(ssid, psk, 0);
}

int linkr_wifi_clear_config_op(uint32_t operation_id)
{
	struct wifi_connect_msg msg = {
		.operation_id = operation_id,
		.wait_for_release = operation_id != 0,
	};
	int err = 0;

	if (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS)) {
		err = save_wifi_settings(NULL, NULL);
		if (err) {
			LOG_WRN("clear WiFi settings failed: %d", err);
			return err;
		}
	}

	k_mutex_lock(&cfg_lock, K_FOREVER);
	wifi_ssid[0] = '\0';
	wifi_psk[0] = '\0';
	k_mutex_unlock(&cfg_lock);

	/* Make "off" authoritative immediately. Remove pending connect/retry work
	 * before queuing the disconnect so an older request cannot reconnect after
	 * this command has reported success. */
	atomic_set(&wifi_reconnect_enabled, 0);
	(void)k_work_cancel_delayable(&wifi_retry_work);
	err = k_msgq_put(&wifi_connect_msgq, &msg, K_NO_WAIT);
	if (err) {
		LOG_WRN("WiFi disconnect msgq put failed: %d", err);
	}
	return err;
}

int linkr_wifi_clear_config(void)
{
	return linkr_wifi_clear_config_op(0);
}

void linkr_wifi_release_operation(uint32_t operation_id)
{
	int err = k_msgq_put(&wifi_operation_release_queue, &operation_id,
			     K_FOREVER);

	if (err) {
		LOG_ERR("WiFi operation release failed: %d", err);
	}
}

/* ------------------------------------------------------------------------ */
/* WebDAV config                                                            */
/* ------------------------------------------------------------------------ */

static void discard_log_buffer(void)
{
    k_mutex_lock(&log_lock, K_FOREVER);
    ring_buf_reset(&log_ring);
    k_mutex_unlock(&log_lock);
}

int linkr_webdav_set_config(const char *url, const char *user, const char *pass)
{
    struct webdav_url parsed;
    bool target_changed;
    int err;

    if (!url || !url[0] || strlen(url) > URL_MAX) {
        return -EINVAL;
    }
    if ((user && strlen(user) > CRED_MAX) || (pass && strlen(pass) > CRED_MAX)) {
        return -EINVAL;
    }

    /* Basic authentication over plain HTTP exposes credentials on the LAN.
     * HTTPS support needs a provisioned trust anchor, which this firmware does
     * not have yet, so only anonymous HTTP endpoints are accepted. */
    if ((user && user[0]) || (pass && pass[0])) {
        return -EPROTONOSUPPORT;
    }

    /* Reject malformed URLs before changing RAM or persistent state. */
    if (parse_webdav_url(url, &parsed) != 0) {
        return -EINVAL;
    }

    err = save_webdav_settings(url, user ? user : "", pass ? pass : "");
    if (err) {
        LOG_WRN("save WebDAV settings failed: %d", err);
        return err;
    }

    /* Complete any started PUT before swapping targets, then invalidate both
     * the ring and the upload thread's private retry buffer. */
    k_mutex_lock(&upload_lock, K_FOREVER);
    k_mutex_lock(&cfg_lock, K_FOREVER);
    target_changed = strcmp(webdav_url, url) != 0;
    strncpy(webdav_url, url, sizeof(webdav_url) - 1);
    webdav_url[sizeof(webdav_url) - 1] = '\0';
    webdav_user[0] = '\0';
    webdav_pass[0] = '\0';
    atomic_set(&webdav_configured, 1);
    if (target_changed) {
        atomic_inc(&webdav_generation);
    }
    k_mutex_unlock(&cfg_lock);

    if (target_changed) {
        discard_log_buffer();
        atomic_clear(&upload_pending_bytes);
    }
    k_mutex_unlock(&upload_lock);

    LOG_INF("WebDAV target set: %s", url);
    return 0;
}

int linkr_webdav_clear_config(void)
{
    int err;

    err = save_webdav_settings(NULL, NULL, NULL);
    if (err) {
        LOG_WRN("clear WebDAV settings failed: %d", err);
        return err;
    }

    k_mutex_lock(&upload_lock, K_FOREVER);
    k_mutex_lock(&cfg_lock, K_FOREVER);
    webdav_url[0] = '\0';
    webdav_user[0] = '\0';
    webdav_pass[0] = '\0';
    atomic_set(&webdav_configured, 0);
    atomic_inc(&webdav_generation);
    k_mutex_unlock(&cfg_lock);

    discard_log_buffer();
    atomic_clear(&upload_pending_bytes);
    k_mutex_unlock(&upload_lock);
    return 0;
}

/* ------------------------------------------------------------------------ */
/* Log ring buffer feed                                                     */
/* ------------------------------------------------------------------------ */

void linkr_log_feed(const uint8_t *data, size_t len)
{
    const uint8_t *src = data;
    size_t keep = len;

    if (!IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WEBDAV) || len == 0 ||
        !atomic_get(&webdav_configured)) {
        return;
    }

    /* Best-effort: preserve the newest bytes without blocking the UART path. */
    k_mutex_lock(&log_lock, K_FOREVER);
    if (keep > LOG_RING_SIZE) {
        atomic_add(&log_dropped_bytes,
                   (atomic_val_t)(keep - LOG_RING_SIZE));
        src += keep - LOG_RING_SIZE;
        keep = LOG_RING_SIZE;
    }
    size_t needed = keep - MIN(keep, ring_buf_space_get(&log_ring));
    while (needed > 0) {
        uint8_t tmp[64];
        uint32_t dropped = ring_buf_get(&log_ring, tmp,
                                        MIN(needed, sizeof(tmp)));

        if (dropped == 0) {
            break;
        }
        atomic_add(&log_dropped_bytes, (atomic_val_t)dropped);
        needed -= dropped;
    }
    (void)ring_buf_put(&log_ring, (uint8_t *)src, keep);
    k_mutex_unlock(&log_lock);
}

/* ------------------------------------------------------------------------ */
/* URL parsing + HTTP PUT                                                    */
/* ------------------------------------------------------------------------ */

/* Parse "http://host[:port]/path" into host/port/path. HTTP only. */
static int parse_webdav_url(const char *url, struct webdav_url *out)
{
    const char *p;
    size_t hostlen = 0;
    unsigned int port = 80;

    if (!url || !out || strncmp(url, "http://", 7) != 0) {
        return -EINVAL;
    }
    p = url + 7;

    while (p[hostlen] && p[hostlen] != ':' && p[hostlen] != '/') {
        char ch = p[hostlen];

        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
              (ch >= '0' && ch <= '9') || ch == '.' || ch == '-')) {
            return -EINVAL;
        }
        hostlen++;
    }
    if (hostlen == 0 || hostlen >= sizeof(out->host) || p[0] == '.' ||
        p[hostlen - 1] == '.' || p[hostlen - 1] == '-') {
        return -EINVAL;
    }
    memcpy(out->host, p, hostlen);
    out->host[hostlen] = '\0';
    p += hostlen;

    if (*p == ':') {
        p++;
        if (*p < '0' || *p > '9') {
            return -EINVAL;
        }
        port = 0;
        while (*p >= '0' && *p <= '9') {
            port = port * 10 + (unsigned int)(*p - '0');
            if (port > UINT16_MAX) {
                return -EINVAL;
            }
            p++;
        }
        if (*p != '\0' && *p != '/') {
            return -EINVAL;
        }
    }
    if (port == 0) {
        return -EINVAL;
    }
    out->port = (uint16_t)port;

    if (*p == '/') {
        const char *path = p;

        while (*path) {
            unsigned char ch = (unsigned char)*path++;

            /* The configured URL is a path prefix. Queries/fragments would
             * make the generated object path ambiguous, and controls could
             * turn into an HTTP request injection. */
            if (ch <= 0x20 || ch == 0x7f || ch == '?' || ch == '#') {
                return -EINVAL;
            }
        }
    } else if (*p != '\0') {
        return -EINVAL;
    }

    out->path = (*p == '/') ? p : "/";
    return 0;
}

struct http_result {
    uint16_t status_code;
};

static int http_response(struct http_response *rsp,
                         enum http_final_call final_data, void *user_data)
{
    struct http_result *result = user_data;

    ARG_UNUSED(final_data);
    result->status_code = rsp->http_status_code;
    return 0;
}

static int http_put(const struct webdav_url *u, const uint8_t *payload,
                    size_t payload_len)
{
    struct zsock_addrinfo hints;
    struct zsock_addrinfo *res = NULL;
    char port_str[8];
    struct http_result result = { 0 };
    int sock = -1;
    int ret = -EIO;

    atomic_clear(&upload_last_http_status);
    snprintk(port_str, sizeof(port_str), "%u", u->port);
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    if (zsock_getaddrinfo(u->host, port_str, &hints, &res) != 0 || !res) {
        LOG_WRN("DNS resolve failed for %s", u->host);
        return -EHOSTUNREACH;
    }

    sock = zsock_socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (sock < 0) {
        goto out;
    }

    if (zsock_connect(sock, res->ai_addr, res->ai_addrlen) < 0) {
        LOG_WRN("HTTP connect failed: errno=%d", errno);
        goto out;
    }

    static uint8_t recv_buf[512];
    struct http_request req = {
        .method = HTTP_PUT,
        .url = u->path,
        .host = u->host,
        .protocol = "HTTP/1.1",
        .port = u->port == 80 ? NULL : port_str,
        .payload = (const char *)payload,
        .payload_len = payload_len,
        .header_fields = NULL,
        .recv_buf = recv_buf,
        .recv_buf_len = sizeof(recv_buf),
        .content_type_value = "application/octet-stream",
        .response = http_response,
    };
    ret = http_client_req(sock, &req, 10000, &result);
    atomic_set(&upload_last_http_status, result.status_code);
    if (ret < 0) {
        LOG_WRN("HTTP PUT failed: %d", ret);
    } else if (result.status_code < 200 || result.status_code >= 300) {
        LOG_WRN("WebDAV PUT %s rejected: HTTP %u", u->path,
                result.status_code);
        ret = -EIO;
    } else {
        LOG_INF("WebDAV PUT %s (%zu bytes) -> HTTP %u", u->path,
                payload_len, result.status_code);
        ret = 0;
    }

out:
    if (sock >= 0) {
        zsock_close(sock);
    }
    zsock_freeaddrinfo(res);
    return ret;
}

/* ------------------------------------------------------------------------ */
/* Upload thread                                                            */
/* ------------------------------------------------------------------------ */

static void upload_thread(void *a, void *b, void *c)
{
    ARG_UNUSED(a);
    ARG_UNUSED(b);
    ARG_UNUSED(c);

    static uint8_t chunk[CONFIG_LINKR_BLE_BRIDGE_WEBDAV_UPLOAD_CHUNK];
    size_t pending_total = 0;
    uint32_t pending_sequence = 0;
    uint32_t pending_uptime = 0;

    for (;;) {
        k_sleep(K_MSEC(CONFIG_LINKR_BLE_BRIDGE_WEBDAV_UPLOAD_INTERVAL_MS));

        if (!atomic_get(&wifi_connected) || !atomic_get(&wifi_ip_ready) ||
            !atomic_get(&webdav_configured)) {
            continue;
        }
        if (!log_boot_id_persisted && advance_log_boot_id() != 0) {
            continue;
        }

        struct webdav_url u;
        char url_local[URL_MAX + 1];
        char full_path[URL_MAX + 64];
        atomic_val_t upload_generation;

        /* Snapshot the config under the lock to avoid racing with setters. */
        k_mutex_lock(&cfg_lock, K_FOREVER);
        strncpy(url_local, webdav_url, sizeof(url_local) - 1);
        url_local[sizeof(url_local) - 1] = '\0';
        upload_generation = atomic_get(&webdav_generation);
        k_mutex_unlock(&cfg_lock);

        if (parse_webdav_url(url_local, &u) != 0) {
            LOG_WRN("bad webdav url: %s", url_local);
            continue;
        }

        for (;;) {
            if (!atomic_get(&webdav_configured) ||
                atomic_get(&webdav_generation) != upload_generation) {
                /* A clear or retarget makes this private retry batch stale. */
                pending_total = 0;
                atomic_clear(&upload_pending_bytes);
                break;
            }

            if (pending_total == 0) {
                k_mutex_lock(&log_lock, K_FOREVER);
                while (pending_total < sizeof(chunk)) {
                    uint32_t n = ring_buf_get(&log_ring,
                                              chunk + pending_total,
                                              sizeof(chunk) - pending_total);
                    if (n == 0) {
                        break;
                    }
                    pending_total += n;
                }
                k_mutex_unlock(&log_lock);
                if (pending_total) {
                    atomic_set(&upload_pending_bytes,
                               (atomic_val_t)pending_total);
                    pending_sequence = ++log_sequence;
                    if (pending_sequence == 0) {
                        pending_sequence = ++log_sequence;
                    }
                    pending_uptime = k_uptime_get_32();
                }
            }

            if (pending_total == 0) {
                break;
            }

            /* The boot id is persisted once during init; the sequence makes
             * several batches in the same millisecond distinct. Retries keep
             * this exact name, so a lost response cannot create duplicates. */
            int path_len = snprintk(full_path, sizeof(full_path),
                                    "%s%slog-%016llx-%08x-%08x.txt", u.path,
                                    (u.path[strlen(u.path) - 1] == '/') ? "" : "/",
                                    (unsigned long long)log_boot_id,
                                    pending_sequence, pending_uptime);

            if (path_len < 0 || (size_t)path_len >= sizeof(full_path)) {
                LOG_WRN("WebDAV path too long");
                break;
            }
            struct webdav_url per = u;
            per.path = full_path;

            /* Setters take the same lock, so once they return no request can
             * still send a batch addressed to the previous target. */
            k_mutex_lock(&upload_lock, K_FOREVER);
            if (!atomic_get(&webdav_configured) ||
                atomic_get(&webdav_generation) != upload_generation) {
                k_mutex_unlock(&upload_lock);
                pending_total = 0;
                atomic_clear(&upload_pending_bytes);
                break;
            }
            int err = http_put(&per, chunk, pending_total);
            k_mutex_unlock(&upload_lock);
            if (err != 0) {
                atomic_inc(&upload_failures);
                /* Keep this batch in place so retries preserve byte order. */
                break;
            }
            atomic_inc(&upload_successes);
            pending_total = 0;
            atomic_clear(&upload_pending_bytes);
        }
    }
}

/* ------------------------------------------------------------------------ */
/* Status strings                                                           */
/* ------------------------------------------------------------------------ */

static const char *wifi_ip_status(char *buf, size_t len)
{
    struct net_in_addr *addr;

    if (!atomic_get(&wifi_ip_ready) || !wifi_iface) {
        return "down";
    }

    addr = net_if_ipv4_get_global_addr(wifi_iface, NET_ADDR_PREFERRED);
    if (!addr || !net_addr_ntop(AF_INET, addr, buf, len)) {
        return "ready";
    }

    return buf;
}

int linkr_wifi_status(char *buf, size_t len)
{
    char ip[NET_IPV4_ADDR_LEN];
    const char *ip_status = wifi_ip_status(ip, sizeof(ip));
    const char *ssid;
    int n;

    k_mutex_lock(&cfg_lock, K_FOREVER);
    ssid = wifi_ssid;
    n = snprintk(buf, len, "wifi=%s,ssid=%s,ip=%s",
                 atomic_get(&wifi_connected) ? "connected" : "off",
                 ssid[0] ? ssid : "-", ip_status);
    k_mutex_unlock(&cfg_lock);
    return n;
}

int linkr_webdav_status(char *buf, size_t len)
{
    const char *url;
    int n;

    k_mutex_lock(&cfg_lock, K_FOREVER);
    url = webdav_url;
    n = snprintk(buf, len, "webdav=%s,url=%s",
                 atomic_get(&webdav_configured) ? "on" : "off",
                 url[0] ? url : "-");
    k_mutex_unlock(&cfg_lock);
    return n;
}

int linkr_wifi_diagnostics(char *buf, size_t len)
{
    char ip[NET_IPV4_ADDR_LEN];

    return snprintk(buf, len, "state=%s ip=%s error=%d",
                    atomic_get(&wifi_connected) ? "connected" : "off",
                    wifi_ip_status(ip, sizeof(ip)),
                    (int)atomic_get(&wifi_last_error));
}

int linkr_upload_diagnostics(char *buf, size_t len)
{
    uint32_t queued;

    k_mutex_lock(&log_lock, K_FOREVER);
    queued = ring_buf_size_get(&log_ring);
    k_mutex_unlock(&log_lock);

    return snprintk(buf, len,
                    "state=%s queue=%u dropped=%u http=%u failures=%u successes=%u",
                    atomic_get(&webdav_configured) ? "on" : "off",
                    queued + (uint32_t)atomic_get(&upload_pending_bytes),
                    (uint32_t)atomic_get(&log_dropped_bytes),
                    (uint32_t)atomic_get(&upload_last_http_status),
                    (uint32_t)atomic_get(&upload_failures),
                    (uint32_t)atomic_get(&upload_successes));
}

/* ------------------------------------------------------------------------ */
/* Init                                                                     */
/* ------------------------------------------------------------------------ */

int linkr_wifi_init(void)
{
    struct webdav_url parsed;
    char ssid[sizeof(wifi_ssid)];
    char psk[sizeof(wifi_psk)];

    k_mutex_init(&cfg_lock);
    k_mutex_init(&log_lock);
    k_mutex_init(&upload_lock);
    k_mutex_init(&scan_cache_lock);
    k_work_init_delayable(&wifi_retry_work, wifi_retry_work_handler);
    k_work_init(&wifi_scan_work, wifi_scan_work_handler);
	atomic_set(&wifi_state, LINKR_WIFI_STATE_OFF);

    k_thread_create(&wifi_connect_thread, wifi_connect_stack,
                    K_THREAD_STACK_SIZEOF(wifi_connect_stack),
                    wifi_connect_thread_fn, NULL, NULL, NULL,
                    K_PRIO_PREEMPT(WIFI_CONNECT_PRIO), 0, K_NO_WAIT);
    if (IS_ENABLED(CONFIG_THREAD_NAME)) {
        k_thread_name_set(&wifi_connect_thread, "wifi_connect");
    }

    wifi_iface = net_if_get_default();
    if (!wifi_iface) {
        LOG_ERR("no network interface");
        return -ENODEV;
    }

    net_if_up(wifi_iface);

    net_mgmt_init_event_callback(&wifi_mgmt_cb, wifi_event_handler,
                                 NET_EVENT_WIFI_CONNECT_RESULT |
                                 NET_EVENT_WIFI_DISCONNECT_RESULT);
    net_mgmt_add_event_callback(&wifi_mgmt_cb);

    /* Event masks may combine commands only within the same net_mgmt layer.
     * Keep IPv4 events separate from WiFi events so neither layer identifier
     * is corrupted by the bitwise OR. */
    net_mgmt_init_event_callback(&ip_mgmt_cb, wifi_event_handler,
                                 NET_EVENT_IPV4_ADDR_ADD |
                                 NET_EVENT_IPV4_ADDR_DEL);
    net_mgmt_add_event_callback(&ip_mgmt_cb);

    net_mgmt_init_event_callback(&wifi_scan_cb, wifi_scan_event_handler,
                                 NET_EVENT_WIFI_SCAN_RESULT |
                                 NET_EVENT_WIFI_SCAN_DONE);
    net_mgmt_add_event_callback(&wifi_scan_cb);

    /* Settings are initialized and loaded by main.c, so pairing bonds and
     * this module share one settings lifecycle. */
    if (webdav_settings_seen) {
        if (webdav_settings_valid && loaded_webdav_settings.enabled &&
            !loaded_webdav_settings.user[0] && !loaded_webdav_settings.pass[0] &&
            parse_webdav_url(loaded_webdav_settings.url, &parsed) == 0) {
            strncpy(webdav_url, loaded_webdav_settings.url,
                    sizeof(webdav_url) - 1);
            webdav_url[sizeof(webdav_url) - 1] = '\0';
            atomic_set(&webdav_configured, 1);
        } else if (!webdav_settings_valid) {
            LOG_WRN("ignoring invalid saved WebDAV settings");
        } else if (loaded_webdav_settings.enabled) {
            LOG_WRN("ignoring unsafe saved WebDAV settings");
        }
    } else if (legacy_webdav_url[0]) {
        /* Migrate an anonymous legacy configuration into one atomic record. */
        if (!legacy_webdav_user[0] && !legacy_webdav_pass[0] &&
            parse_webdav_url(legacy_webdav_url, &parsed) == 0) {
            strncpy(webdav_url, legacy_webdav_url, sizeof(webdav_url) - 1);
            webdav_url[sizeof(webdav_url) - 1] = '\0';
            atomic_set(&webdav_configured, 1);
            if (save_webdav_settings(webdav_url, NULL, NULL) != 0) {
                LOG_WRN("could not migrate legacy WebDAV settings");
            }
        } else {
            LOG_WRN("ignoring unsafe legacy WebDAV settings");
        }
    }

    if (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS)) {
        if (wifi_settings_seen) {
            if (wifi_settings_valid && loaded_wifi_settings.enabled) {
                strncpy(wifi_ssid, loaded_wifi_settings.ssid,
                        sizeof(wifi_ssid) - 1);
                wifi_ssid[sizeof(wifi_ssid) - 1] = '\0';
                strncpy(wifi_psk, loaded_wifi_settings.psk,
                        sizeof(wifi_psk) - 1);
                wifi_psk[sizeof(wifi_psk) - 1] = '\0';
            } else if (!wifi_settings_valid) {
                LOG_WRN("ignoring invalid saved WiFi settings");
            }
        } else if (legacy_wifi_ssid[0]) {
            strncpy(wifi_ssid, legacy_wifi_ssid, sizeof(wifi_ssid) - 1);
            wifi_ssid[sizeof(wifi_ssid) - 1] = '\0';
            strncpy(wifi_psk, legacy_wifi_psk, sizeof(wifi_psk) - 1);
            wifi_psk[sizeof(wifi_psk) - 1] = '\0';
            if (save_wifi_settings(wifi_ssid, wifi_psk) != 0) {
                LOG_WRN("could not migrate legacy WiFi settings");
            }
        }
    }

    if (IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WEBDAV)) {
        k_thread_create(&upload_thread_data, upload_stack,
                        K_THREAD_STACK_SIZEOF(upload_stack),
                        upload_thread, NULL, NULL, NULL,
                        UPLOAD_PRIO, 0, K_NO_WAIT);
        k_thread_name_set(&upload_thread_data, "webdav_upload");
    }

    /* A saved credential is only restored with explicit persistence enabled. */
    if (wifi_ssid[0]) {
        strncpy(ssid, wifi_ssid, sizeof(ssid));
        strncpy(psk, wifi_psk, sizeof(psk));
        atomic_set(&wifi_reconnect_enabled, 1);
		wifi_publish_state(LINKR_WIFI_STATE_QUEUED, 0);
        LOG_INF("Auto-connecting to \"%s\"", wifi_ssid);
        (void)linkr_wifi_connect(ssid, psk);
    } else {
        LOG_INF("WiFi idle (no saved SSID); send @w=ssid,pass to connect");
    }

    return 0;
}

#endif /* CONFIG_LINKR_BLE_BRIDGE_WIFI */
