/*
 * WiFi station + WebDAV serial log upload for the Linkr BLE bridge.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef LINKR_BLE_WIFI_H
#define LINKR_BLE_WIFI_H

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <zephyr/sys/util.h>

struct bt_conn;

/* Sink used by linkr_wifi_scan() to stream each discovered SSID (and the
 * final "scan done" marker) back to the BLE client. main.c installs one that
 * writes into the NUS control-response queue. Defined here so it is available
 * in both the enabled and the no-op stub branches below. */
typedef void (*linkr_wifi_respond_fn)(struct bt_conn *conn, const char *line);

#ifdef __cplusplus
extern "C" {
#endif

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_WIFI)

/* Register WiFi management events, start the upload thread, and auto-connect
 * only when credential persistence restored a saved SSID/PSK. Returns 0 on
 * success. */
int linkr_wifi_init(void);

bool linkr_wifi_is_connected(void);

/* One-shot connect / disconnect (RAM only, not persisted). */
int linkr_wifi_connect(const char *ssid, const char *psk);
int linkr_wifi_disconnect(void);

/* Store SSID/PSK in RAM and connect. It is saved to flash only when
 * CONFIG_LINKR_BLE_BRIDGE_PERSIST_CREDENTIALS is explicitly enabled. */
int linkr_wifi_set_config(const char *ssid, const char *psk);
int linkr_wifi_clear_config(void);

/* Persist WebDAV target (url,user,pass); clear_config disables upload. */
int linkr_webdav_set_config(const char *url, const char *user, const char *pass);
int linkr_webdav_clear_config(void);

/* Feed UART RX bytes into the pending upload buffer. No-op when disabled. */
void linkr_log_feed(const uint8_t *data, size_t len);

/* Write a human-readable status line, returns length written. */
int linkr_wifi_status(char *buf, size_t len);
int linkr_webdav_status(char *buf, size_t len);

/* Register the response sink. Must be called before the first scan request. */
void linkr_wifi_set_respond_fn(linkr_wifi_respond_fn fn);

/* Trigger an asynchronous WiFi scan. Each discovered network is reported via
 * the registered sink as a single line ("<ssid> -<rssi>dBm"), followed by a
 * terminating "scan done" line. Returns 0 when the scan was accepted. */
int linkr_wifi_scan(struct bt_conn *conn);

#else /* WiFi compiled out: provide no-op stubs so main.c stays unchanged. */

static inline int  linkr_wifi_init(void) { return 0; }
static inline bool linkr_wifi_is_connected(void) { return false; }
static inline int  linkr_wifi_connect(const char *ssid, const char *psk) { (void)ssid; (void)psk; return -ENOTSUP; }
static inline int  linkr_wifi_disconnect(void) { return -ENOTSUP; }
static inline int  linkr_wifi_set_config(const char *ssid, const char *psk) { (void)ssid; (void)psk; return -ENOTSUP; }
static inline int  linkr_wifi_clear_config(void) { return -ENOTSUP; }
static inline int  linkr_webdav_set_config(const char *url, const char *user, const char *pass) { (void)url; (void)user; (void)pass; return -ENOTSUP; }
static inline int  linkr_webdav_clear_config(void) { return -ENOTSUP; }
static inline void linkr_log_feed(const uint8_t *data, size_t len) { (void)data; (void)len; }
static inline int  linkr_wifi_status(char *buf, size_t len) { (void)buf; (void)len; return 0; }
static inline int  linkr_webdav_status(char *buf, size_t len) { (void)buf; (void)len; return 0; }
static inline void linkr_wifi_set_respond_fn(linkr_wifi_respond_fn fn) { (void)fn; }
static inline int  linkr_wifi_scan(struct bt_conn *conn) { (void)conn; return -ENOTSUP; }

#endif

#ifdef __cplusplus
}
#endif

#endif /* LINKR_BLE_WIFI_H */
