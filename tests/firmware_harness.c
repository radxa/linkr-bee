/* Host-only fakes around the production functions included by the test runner.
 * No Zephyr scheduler, networking, or Bluetooth hardware is emulated here. */
#include <errno.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ARG_UNUSED(x) (void)(x)
#define WEBDAV_UPLOAD_CHUNK 512
#define WEBDAV_UPLOAD_INTERVAL_MS 1000
#define URL_MAX 192
#define K_MSEC(x) (x)
#define K_FOREVER 0
#define LOG_WRN(...) ((void)0)
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
struct webdav_url {
    char host[64];
    uint16_t port;
    const char *path;
};
static const char *scenario;
static const char *ring_data = "OLD_PRIVATE_LOG";
static unsigned int ticks, requests;
static jmp_buf finished;

static int atomic_get(int *p) { return *p; }
static void atomic_set(int *p, int x) { *p = x; }
static void atomic_clear(int *p) { *p = 0; }
static void atomic_inc(int *p) { ++*p; }
static void k_mutex_lock(int *p, int timeout) { (void)p; (void)timeout; }
static void k_mutex_unlock(int *p) { (void)p; }
static int advance_log_boot_id(void) { return 0; }
static uint32_t k_uptime_get_32(void) { return ticks * 1000; }

static void k_sleep(int ms)
{
    (void)ms;
    ++ticks;
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
    sscanf(url, "http://%63[^/]", out->host);
    out->path = "/logs/";
    return 0;
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

static int ws_feeds, log_feeds, uart_reliable_drop_no_conn;
static int ble_result = -ENOTCONN;
static bool reliable_mode = true;
static void linkr_log_feed(const uint8_t *data, uint16_t len)
{
    (void)data; (void)len; ++log_feeds;
}
static void linkr_ws_feed(const uint8_t *data, uint16_t len)
{
    (void)data; (void)len; ++ws_feeds;
}
static bool linkr_uart_reliable_mode(void) { return reliable_mode; }
static int nus_send_chunk(const uint8_t *data, uint16_t len)
{
    (void)data; (void)len; return 0;
}
static int reliable_send_chunk(const uint8_t *data, uint16_t len)
{
    (void)data; (void)len; return ble_result;
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
        /* A connected peer's transient failure must still be retried without
         * duplicating bytes in the LAN or log sinks. */
        bool accounted = false;
        ble_result = -EIO;
        if (uart_forward_chunk(data, sizeof(data), &accounted) != -EIO) {
            return 5;
        }
        ble_result = 0;
        if (uart_forward_chunk(data, sizeof(data), &accounted) != 0 ||
            ws_feeds != 101 || log_feeds != 101) {
            return 6;
        }
        return 0;
    }
    if (!setjmp(finished)) {
        upload_thread(NULL, NULL, NULL);
    }
    return 0;
}
