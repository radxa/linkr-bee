/* Host-only fakes around the production functions included by the test runner.
 * No Zephyr scheduler, networking, or Bluetooth hardware is emulated here. */
#include <errno.h>
#include <assert.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ARG_UNUSED(x) (void)(x)
/* src/ext_ram.h turns this into a section attribute only on PSRAM-capable
 * Zephyr targets; a host build has no external RAM, so it expands to nothing. */
#define LINKR_EXT_RAM_BSS
#define __aligned(x) __attribute__((aligned(x)))
#define WEBDAV_UPLOAD_CHUNK 512
#define WEBDAV_UPLOAD_INTERVAL_MS 1000
#define URL_MAX 192
#define CRED_MAX 64
#define K_MSEC(x) (x)
#define K_FOREVER 0
#define LOG_WRN(...) ((void)0)
#define LOG_INF(...) ((void)0)
#define snprintk snprintf
#define IS_ENABLED(x) (x)

typedef int atomic_val_t;
static int wifi_connected = 1, wifi_ip_ready = 1, webdav_configured = 1;
static int webdav_generation = 1, upload_pending_bytes;
static int upload_failures, upload_successes;
static int cfg_lock, log_lock, upload_lock, log_ring;
static bool log_boot_id_persisted = true;
static uint64_t log_boot_id = 1;
static uint32_t log_sequence;
static char webdav_url[URL_MAX + 1] = "http://old/logs/";
static char webdav_user[CRED_MAX + 1];
static char webdav_pass[CRED_MAX + 1];
struct webdav_url {
    char host[64];
    uint16_t port;
    const char *path;
};
static const char *scenario;
static const char *ring_data = "OLD_PRIVATE_LOG";
static unsigned int ticks, requests;
static bool retarget_clear_pending;
static jmp_buf finished;

static int atomic_get(int *p) { return *p; }
static void atomic_set(int *p, int x) { *p = x; }
static void atomic_clear(int *p) { *p = 0; }
static void atomic_inc(int *p) { ++*p; }
static void k_mutex_lock(int *p, int timeout)
{
    (void)timeout;
    if (p == &upload_lock && retarget_clear_pending) {
        /* Complete the paused setter before granting its upload lock: discard
         * the old ring, then allow fresh logs to arrive for the new target. */
        ring_data = "NEW_LOG";
        upload_pending_bytes = 0;
        retarget_clear_pending = false;
    }
    assert(*p == 0);
    *p = 1;
}
static void k_mutex_unlock(int *p)
{
    assert(*p == 1);
    *p = 0;
}
static int advance_log_boot_id(void) { return 0; }
static uint32_t k_uptime_get_32(void) { return ticks * 1000; }

static void k_sleep(int ms)
{
    (void)ms;
    assert(!upload_lock && !cfg_lock && !log_lock);
    ++ticks;
    if (ticks == 1 && !strcmp(scenario, "retarget_handoff")) {
        /* Pause the setter just after cfg_lock is released: new URL and
         * generation are visible, but its old ring has not been cleared. */
        strcpy(webdav_url, "http://new/logs/");
        ++webdav_generation;
        retarget_clear_pending = true;
    }
    if (!strcmp(scenario, "clear")) {
        if (ticks == 2) {
            webdav_configured = 0;
            ++webdav_generation;
            upload_pending_bytes = 0;
            ring_data = NULL;
        } else if (ticks == 3) {
            /* Re-enable even the same URL: the old private batch is stale. */
            webdav_configured = 1;
            ++webdav_generation;
            ring_data = "NEW_LOG";
        } else if (ticks == 4) {
            longjmp(finished, 1);
        }
    } else {
        if (ticks == 2 && !strcmp(scenario, "retarget")) {
            strcpy(webdav_url, "http://new/logs/");
            ++webdav_generation;
            upload_pending_bytes = 0;
            ring_data = "NEW_LOG";
        }
        if (ticks == 3) {
            longjmp(finished, 1);
        }
    }
}

static int parse_webdav_url(const char *url, struct webdav_url *out)
{
    if (strncmp(url, "http://", 7) != 0 || !strchr(url + 7, '/')) {
        return -EINVAL;
    }
    sscanf(url, "http://%63[^/]", out->host);
    out->path = "/logs/";
    return 0;
}

/* Records what the production setters would persist; a failure can be injected
 * to prove the setters validate before mutating RAM or flash. */
static char saved_url[URL_MAX + 1];
static char saved_user[CRED_MAX + 1];
static char saved_pass[CRED_MAX + 1];
static int save_calls;
static bool save_fails;
static int save_webdav_settings(const char *url, const char *user, const char *pass)
{
    ++save_calls;
    if (save_fails) {
        return -EIO;
    }
    snprintf(saved_url, sizeof(saved_url), "%s", url ? url : "");
    snprintf(saved_user, sizeof(saved_user), "%s", user ? user : "");
    snprintf(saved_pass, sizeof(saved_pass), "%s", pass ? pass : "");
    return 0;
}

static void ring_buf_reset(int *ring)
{
    (void)ring;
    ring_data = NULL;
}

static uint32_t ring_buf_get(int *ring, uint8_t *dst, size_t capacity)
{
    (void)ring;
    if (!ring_data) {
        return 0;
    }
    size_t len = strlen(ring_data);
    if (len > capacity) {
        abort();
    }
    memcpy(dst, ring_data, len);
    ring_data = NULL;
    return len;
}

static int http_put(const struct webdav_url *url, const uint8_t *data, size_t len)
{
    printf("%s|%.*s|%s\n", url->host, (int)len, data, url->path);
    /* The first request fails; the retry must keep its destination and name
     * unless configuration changed, in which case it must be discarded. */
    return ++requests == 1 ? -EIO : 0;
}

static int ws_feeds, log_feeds, ble_feeds;
static void linkr_log_feed(const uint8_t *data, uint16_t len)
{
    (void)data; (void)len; ++log_feeds;
}
static void linkr_ws_feed(const uint8_t *data, uint16_t len)
{
    (void)data; (void)len; ++ws_feeds;
}
static void linkr_ble_feed(const uint8_t *data, uint16_t len)
{
    (void)data; (void)len; ++ble_feeds;
}

#include "production_functions.inc"

int main(int argc, char **argv)
{
    if (argc != 2) {
        return 2;
    }
    scenario = argv[1];
    if (!strcmp(scenario, "forward")) {
        uint8_t data[232] = {0};
        for (int i = 0; i < 100; ++i) {
            bool accounted = false;
            if (uart_forward_chunk(data, sizeof(data), &accounted) != 0) {
                return 3;
            }
        }
        if (ws_feeds != 100 || log_feeds != 100) {
            return 4;
        }
        /* Re-entering for the same capture chunk must not duplicate any sink.
         * BLE now queues independently instead of stalling capture on retry. */
        bool accounted = false;
        if (uart_forward_chunk(data, sizeof(data), &accounted) != 0) {
            return 5;
        }
        if (uart_forward_chunk(data, sizeof(data), &accounted) != 0 ||
            ws_feeds != 101 || log_feeds != 101 || ble_feeds != 101) {
            return 6;
        }
        /* Each captured chunk reaches every fan-out sink exactly once. */
        printf("forward|%d|%d\n", ws_feeds, log_feeds);
        return 0;
    }
    if (!strcmp(scenario, "setters")) {
        /* Exercises the production WebDAV setters. The summary line is asserted
         * by tests/test_regressions.py so a failure names the property. */
        int creds_rejected = linkr_webdav_set_config("http://new/logs/", "user", "pass") == -EPROTONOSUPPORT;
        int url_rejected = linkr_webdav_set_config("ftp://new/logs/", NULL, NULL) == -EINVAL;
        /* A rejected request must not touch RAM, the ring or flash. */
        int untouched = save_calls == 0 && webdav_generation == 1 &&
                        strcmp(webdav_url, "http://old/logs/") == 0 &&
                        ring_data != NULL && webdav_configured == 1;
        int retarget = 0, noop = 0, save_failure = 0, cleared = 0;

        ring_data = "OLD_PRIVATE_LOG";
        if (linkr_webdav_set_config("http://new/logs/", NULL, NULL) == 0) {
            /* Publishes URL + generation and drops the old batch. */
            retarget = webdav_generation == 2 && webdav_configured == 1 &&
                       strcmp(webdav_url, "http://new/logs/") == 0 && ring_data == NULL &&
                       upload_pending_bytes == 0 &&
                       strcmp(saved_url, "http://new/logs/") == 0 &&
                       webdav_user[0] == '\0' && webdav_pass[0] == '\0';
        }

        /* Re-applying the same URL must not invalidate the current batch. */
        ring_data = "KEEP";
        noop = linkr_webdav_set_config("http://new/logs/", NULL, NULL) == 0 &&
               webdav_generation == 2 && ring_data != NULL;

        /* A failed persist must not leave the new URL half-applied. */
        save_fails = true;
        save_failure = linkr_webdav_set_config("http://third/logs/", NULL, NULL) == -EIO &&
                       webdav_generation == 2 && strcmp(webdav_url, "http://new/logs/") == 0;
        save_fails = false;

        ring_data = "OLD_PRIVATE_LOG";
        cleared = linkr_webdav_clear_config() == 0 && webdav_configured == 0 &&
                  webdav_generation == 3 && ring_data == NULL && saved_url[0] == '\0';

        printf("SETTERS|creds_rejected=%d|url_rejected=%d|untouched=%d|retarget=%d|"
               "noop=%d|save_failure=%d|cleared=%d\n",
               creds_rejected, url_rejected, untouched, retarget, noop, save_failure,
               cleared);
        return 0;
    }
    if (!setjmp(finished)) {
        upload_thread(NULL, NULL, NULL);
    }
    return 0;
}
