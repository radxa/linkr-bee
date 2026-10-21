/*
 * Linkr Bee Terminal (C / Linux / BlueZ D-Bus)
 *
 * A Linux-only reference implementation of the host-side BLE Nordic UART
 * Service terminal. It talks to BlueZ over the system D-Bus and is intended
 * to coexist with the cross-platform Python tool linkr_ble_terminal.py.
 *
 * Build:
 *     cd tools && make
 *     ./linkr_ble_terminal_c --help
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include <dbus/dbus.h>

#define DEFAULT_NAME    "Linkr BLE UART"
#define NUS_SERVICE     "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_RX_UUID     "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_TX_UUID     "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
#define BLUEZ_PATH      "/org/bluez"
#define BLUEZ_BUS       "org.bluez"
#define DBUS_OM_IFACE   "org.freedesktop.DBus.ObjectManager"
#define DBUS_PROP_IFACE "org.freedesktop.DBus.Properties"
#define ADAPTER_IFACE   "org.bluez.Adapter1"
#define DEVICE_IFACE    "org.bluez.Device1"
#define CHAR_IFACE      "org.bluez.GattCharacteristic1"

#define TX_BUF_SIZE     8192
#define MAX_PATH_LEN    256
#define MAX_UUID_LEN    40
#define MAX_NAME_LEN    128
/* ATT MTU 247 leaves up to 244 bytes for a GATT value. */
#define BLE_MAX_NUS_PAYLOAD 244

/* Keep in sync with __version__ in linkr_ble_terminal.py: both clients speak to
 * the same device and are released together. tests/test_terminal_cli_c.py
 * asserts the two strings match. */
#define CLI_VERSION     "1.0.0"

/* Exit codes mirror the Python client so scripts can treat them alike. */
enum {
    EXIT_OK = 0,
    EXIT_ERROR = 1,
    EXIT_USAGE = 2,
    EXIT_DEVICE_DISCONNECTED = 3,
};

struct options {
    const char *name;
    const char *address;
    bool scan;
    double timeout;
    bool pair;
    const char *loopback_test;
    double loopback_timeout;
    bool no_terminal;
    int ble_write_size;
    bool write_response;
    const char *enter;
    bool local_echo;
    bool line_mode;
    bool debug_io;
    const char *log_file;
    const char *escape;
};

struct app_state {
    DBusConnection *conn;
    char adapter_path[MAX_PATH_LEN];
    char device_path[MAX_PATH_LEN];
    char rx_path[MAX_PATH_LEN];
    char tx_path[MAX_PATH_LEN];
    int mtu_write_size;
    bool connected;
    bool notifications_started;
    /* Set from the D-Bus filter when org.bluez.Device1.Connected drops. The
     * terminal loop polls it so a lost link is reported instead of blocking. */
    _Atomic bool link_lost;

    /* stdin -> ble write queue */
    pthread_mutex_t tx_lock;
    pthread_cond_t tx_cond;
    uint8_t tx_buf[TX_BUF_SIZE];
    size_t tx_head;
    size_t tx_count;
    _Atomic bool tx_done;

    /* notification -> stdout/log queue */
    pthread_mutex_t rx_lock;
    pthread_cond_t rx_cond;
    uint8_t *rx_packets[64];
    size_t rx_lengths[64];
    size_t rx_count;

    FILE *log_file;
    struct termios saved_tio;
    bool tio_saved;
    pthread_mutex_t stdout_lock;
};

static struct app_state g_state;

/* Set by --quiet. Progress chatter goes through msg() and is dropped; errors
 * (fatal/usage_fatal) and protocol traces always print. */
static bool g_quiet;

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

static void msg(const char *fmt, ...)
{
    va_list ap;

    if (g_quiet) {
        return;
    }
    va_start(ap, fmt);
    fprintf(stderr, "linkr-ble-c: ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
}

/* Every failure goes out through here so the prefix stays uniform. */
static void emit_error(const char *fmt, va_list ap)
{
    fputs("linkr-ble-c: error: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
}

/* A failure that is reported but does not end the process by itself. */
static void err_msg(const char *fmt, ...)
{
    va_list ap;

    va_start(ap, fmt);
    emit_error(fmt, ap);
    va_end(ap);
}

/* Runtime failure: the adapter, the D-Bus connection or the peer device. */
static void fatal(const char *fmt, ...)
{
    va_list ap;

    va_start(ap, fmt);
    emit_error(fmt, ap);
    va_end(ap);
    exit(EXIT_ERROR);
}

/* Bad command line: same shape as the Python client's argparse failures.
 * The parse helpers used to report these as fatal() and exit 1, which made an
 * unparsable argument indistinguishable from a device that failed to connect. */
static void usage_fatal(const char *fmt, ...)
{
    va_list ap;

    va_start(ap, fmt);
    emit_error(fmt, ap);
    va_end(ap);
    fputs("linkr-ble-c: try '--help' for the accepted options\n", stderr);
    exit(EXIT_USAGE);
}

static void hex_uuid_to_dbus(const char *uuid128, char *out, size_t out_len)
{
    /* BlueZ uses dashed lowercase 128-bit UUIDs in managed objects. */
    size_t hex = 0;
    size_t o = 0;

    if (out_len < 37) {
        *out = '\0';
        return;
    }

    for (size_t i = 0; uuid128[i]; i++) {
        char c = uuid128[i];

        if (c == '-') {
            continue;
        }
        if (!isxdigit((unsigned char)c) || hex >= 32) {
            out[0] = '\0';
            return;
        }
        if (hex == 8 || hex == 12 || hex == 16 || hex == 20) {
            out[o++] = '-';
        }
        out[o++] = (char)tolower((unsigned char)c);
        hex++;
    }
    if (hex != 32) {
        out[0] = '\0';
        return;
    }
    out[o] = '\0';
}

static void normalize_enter(const uint8_t *in, size_t in_len,
                            const char *mode,
                            uint8_t *out, size_t *out_len,
                            size_t out_cap)
{
    size_t i, o = 0;
    uint8_t repl[2];
    size_t repl_len = 0;

    if (strcmp(mode, "raw") == 0) {
        repl_len = 0;
    } else if (strcmp(mode, "cr") == 0) {
        repl[0] = '\r';
        repl_len = 1;
    } else if (strcmp(mode, "lf") == 0) {
        repl[0] = '\n';
        repl_len = 1;
    } else if (strcmp(mode, "crlf") == 0) {
        repl[0] = '\r';
        repl[1] = '\n';
        repl_len = 2;
    } else {
        repl_len = 0;
    }

    if (repl_len == 0) {
        *out_len = in_len < out_cap ? in_len : out_cap;
        memcpy(out, in, *out_len);
        return;
    }

    /* Normalize CR/LF/CRLF without emitting half of a replacement sequence. */
    for (i = 0; i < in_len && o < out_cap; i++) {
        if (in[i] == '\r') {
            if (i + 1 < in_len && in[i + 1] == '\n') {
                i++;
            }
            if (out_cap - o < repl_len) {
                break;
            }
            for (size_t r = 0; r < repl_len; r++) {
                out[o++] = repl[r];
            }
        } else if (in[i] == '\n') {
            if (out_cap - o < repl_len) {
                break;
            }
            for (size_t r = 0; r < repl_len; r++) {
                out[o++] = repl[r];
            }
        } else {
            out[o++] = in[i];
        }
    }
    *out_len = o;
}

/* Human name for the configured escape byte, so the terminal hint follows
 * --escape instead of always claiming Ctrl-]. Mirrors describe_escape() in
 * linkr_ble_terminal.py. */
static void describe_escape(const char *escape, char *out, size_t out_len)
{
    unsigned char byte = (unsigned char)escape[0];

    if (byte == 0x1b) {
        snprintf(out, out_len, "Esc");
    } else if (byte >= 1 && byte <= 26) {
        snprintf(out, out_len, "Ctrl-%c", 'A' + byte - 1);
    } else if (byte >= 0x1c && byte <= 0x1f) {
        snprintf(out, out_len, "Ctrl-%c", "\\]^_"[byte - 0x1c]);
    } else if (byte >= 0x20 && byte < 0x7f) {
        snprintf(out, out_len, "'%c'", byte);
    } else {
        snprintf(out, out_len, "0x%02x", byte);
    }
}

/* ------------------------------------------------------------------------ */
/* D-Bus helpers                                                            */
/* ------------------------------------------------------------------------ */

static DBusMessage *call_sync(DBusConnection *conn, const char *dest,
                              const char *path, const char *iface,
                              const char *method, DBusMessageIter *args_in)
{
    DBusMessage *message, *reply;
    DBusError err;

    dbus_error_init(&err);
    message = dbus_message_new_method_call(dest, path, iface, method);
    if (!message) {
        fatal("out of memory creating D-Bus message");
    }

    if (args_in) {
        dbus_message_iter_init_append(message, args_in);
    }

    reply = dbus_connection_send_with_reply_and_block(conn, message, 15000, &err);
    dbus_message_unref(message);

    if (dbus_error_is_set(&err)) {
        msg("D-Bus error %s.%s on %s: %s", iface, method, path, err.message);
        dbus_error_free(&err);
        return NULL;
    }
    if (!reply) {
        msg("no reply for %s.%s on %s", iface, method, path);
        return NULL;
    }

    return reply;
}

static int iter_get_basic(DBusMessageIter *iter, int type, void *val)
{
    if (dbus_message_iter_get_arg_type(iter) != type) {
        return -1;
    }
    dbus_message_iter_get_basic(iter, val);
    return 0;
}

/* True when the iterator holds a variant boolean set to false. Property values
 * in a PropertiesChanged dict are always wrapped in a variant. */
static bool variant_is_false(DBusMessageIter *iter)
{
    DBusMessageIter value;
    dbus_bool_t boolean = TRUE;

    if (dbus_message_iter_get_arg_type(iter) != DBUS_TYPE_VARIANT) {
        return false;
    }
    dbus_message_iter_recurse(iter, &value);
    if (iter_get_basic(&value, DBUS_TYPE_BOOLEAN, &boolean) != 0) {
        return false;
    }
    return !boolean;
}

static const char *iter_get_string(DBusMessageIter *iter)
{
    DBusMessageIter value;
    const char *s = NULL;

    if (dbus_message_iter_get_arg_type(iter) == DBUS_TYPE_VARIANT) {
        dbus_message_iter_recurse(iter, &value);
        iter = &value;
    }

    if (dbus_message_iter_get_arg_type(iter) == DBUS_TYPE_STRING ||
        dbus_message_iter_get_arg_type(iter) == DBUS_TYPE_OBJECT_PATH) {
        dbus_message_iter_get_basic(iter, &s);
        return s;
    }
    return NULL;
}

/* ------------------------------------------------------------------------ */
/* Object discovery                                                         */
/* ------------------------------------------------------------------------ */

static bool find_adapter(DBusConnection *conn, char *path_out, size_t path_out_len)
{
    DBusMessage *reply;
    DBusMessageIter iter, arr;

    reply = call_sync(conn, BLUEZ_BUS, "/", DBUS_OM_IFACE, "GetManagedObjects", NULL);
    if (!reply) {
        return false;
    }

    dbus_message_iter_init(reply, &iter);
    if (dbus_message_iter_get_arg_type(&iter) != DBUS_TYPE_ARRAY) {
        dbus_message_unref(reply);
        return false;
    }

    dbus_message_iter_recurse(&iter, &arr);
    while (dbus_message_iter_get_arg_type(&arr) == DBUS_TYPE_DICT_ENTRY) {
        DBusMessageIter entry, ifaces;
        const char *path = NULL;

        dbus_message_iter_recurse(&arr, &entry);
        if (iter_get_basic(&entry, DBUS_TYPE_OBJECT_PATH, &path) != 0 || !path) {
            dbus_message_iter_next(&arr);
            continue;
        }
        dbus_message_iter_next(&entry);
        dbus_message_iter_recurse(&entry, &ifaces);

        while (dbus_message_iter_get_arg_type(&ifaces) == DBUS_TYPE_DICT_ENTRY) {
            DBusMessageIter iface_entry;
            const char *iface = NULL;

            dbus_message_iter_recurse(&ifaces, &iface_entry);
            if (iter_get_basic(&iface_entry, DBUS_TYPE_STRING, &iface) != 0 ||
                !iface) {
                dbus_message_iter_next(&ifaces);
                continue;
            }
            if (strcmp(iface, ADAPTER_IFACE) == 0) {
                /* snprintf over strncpy: always NUL-terminated, and gcc's
                 * -Wstringop-truncation stays quiet. */
                snprintf(path_out, path_out_len, "%s", path);
                dbus_message_unref(reply);
                return true;
            }
            dbus_message_iter_next(&ifaces);
        }
        dbus_message_iter_next(&arr);
    }

    dbus_message_unref(reply);
    return false;
}

struct device_match {
    char name_prefix[MAX_NAME_LEN];
    const char *address;
    char path[MAX_PATH_LEN];
    char found_name[MAX_NAME_LEN];
    bool found;
    bool found_has_nus;
    /* Best rank seen so far; -1 means "nothing matched yet". */
    int best_rank;
};

/* Pick between candidate devices: an exact name beats a prefix match, and
 * either beats a device that does not advertise the NUS service, which the
 * legacy NUS client cannot use. */
static int device_rank(bool exact_name, bool has_nus)
{
    return (exact_name ? 2 : 0) + (has_nus ? 1 : 0);
}

static void strip_dashes(const char *in, char *out, size_t out_len)
{
    size_t o = 0;
    for (size_t i = 0; in[i] && o + 1 < out_len; i++) {
        if (in[i] != '-') {
            out[o++] = (char)tolower((unsigned char)in[i]);
        }
    }
    out[o] = '\0';
}

static void normalize_name_prefix(const char *name, char *out, size_t out_len)
{
    size_t len;

    if (!name || out_len == 0) {
        return;
    }

    while (isspace((unsigned char)*name)) {
        name++;
    }

    len = strlen(name);
    while (len > 0 && isspace((unsigned char)name[len - 1])) {
        len--;
    }
    if (len > 0 && name[len - 1] == '*') {
        len--;
    }
    while (len > 0 && isspace((unsigned char)name[len - 1])) {
        len--;
    }
    if (len >= out_len) {
        len = out_len - 1;
    }

    memcpy(out, name, len);
    out[len] = '\0';
}

static bool iter_uuid_array_contains(DBusMessageIter *iter, const char *uuid)
{
    DBusMessageIter value, uuids;
    char want[MAX_UUID_LEN];

    strip_dashes(uuid, want, sizeof(want));

    if (dbus_message_iter_get_arg_type(iter) == DBUS_TYPE_VARIANT) {
        dbus_message_iter_recurse(iter, &value);
        iter = &value;
    }

    if (dbus_message_iter_get_arg_type(iter) != DBUS_TYPE_ARRAY) {
        return false;
    }

    dbus_message_iter_recurse(iter, &uuids);
    while (dbus_message_iter_get_arg_type(&uuids) == DBUS_TYPE_STRING) {
        const char *u;
        char got[MAX_UUID_LEN];

        dbus_message_iter_get_basic(&uuids, &u);
        strip_dashes(u, got, sizeof(got));
        if (strcmp(got, want) == 0) {
            return true;
        }
        dbus_message_iter_next(&uuids);
    }

    return false;
}

static size_t iter_copy_byte_array(DBusMessageIter *iter, uint8_t *out,
                                   size_t out_cap)
{
    DBusMessageIter value, bytes;
    size_t len = 0;

    if (dbus_message_iter_get_arg_type(iter) == DBUS_TYPE_VARIANT) {
        dbus_message_iter_recurse(iter, &value);
        iter = &value;
    }

    if (dbus_message_iter_get_arg_type(iter) != DBUS_TYPE_ARRAY) {
        return 0;
    }

    dbus_message_iter_recurse(iter, &bytes);
    while (dbus_message_iter_get_arg_type(&bytes) == DBUS_TYPE_BYTE &&
           len < out_cap) {
        dbus_message_iter_get_basic(&bytes, &out[len++]);
        dbus_message_iter_next(&bytes);
    }

    return len;
}

static void timespec_add_ms(struct timespec *ts, long ms)
{
    ts->tv_sec += ms / 1000;
    ts->tv_nsec += (ms % 1000) * 1000000L;
    while (ts->tv_nsec >= 1000000000L) {
        ts->tv_sec++;
        ts->tv_nsec -= 1000000000L;
    }
}

static bool uuid_matches(DBusMessageIter *props, const char *uuid)
{
    DBusMessageIter prop_entry;

    dbus_message_iter_recurse(props, &prop_entry);
    while (dbus_message_iter_get_arg_type(&prop_entry) == DBUS_TYPE_DICT_ENTRY) {
        DBusMessageIter kv;
        const char *key = NULL;

        dbus_message_iter_recurse(&prop_entry, &kv);
        if (iter_get_basic(&kv, DBUS_TYPE_STRING, &key) != 0 || !key) {
            dbus_message_iter_next(&prop_entry);
            continue;
        }
        dbus_message_iter_next(&kv);

        if (strcmp(key, "UUIDs") == 0 && iter_uuid_array_contains(&kv, uuid)) {
            return true;
        }
        dbus_message_iter_next(&prop_entry);
    }
    return false;
}

static void scan_managed_objects(DBusConnection *conn, struct device_match *match)
{
    DBusMessage *reply;
    DBusMessageIter iter, arr;

    reply = call_sync(conn, BLUEZ_BUS, "/", DBUS_OM_IFACE, "GetManagedObjects", NULL);
    if (!reply) {
        return;
    }

    dbus_message_iter_init(reply, &iter);
    dbus_message_iter_recurse(&iter, &arr);
    while (dbus_message_iter_get_arg_type(&arr) == DBUS_TYPE_DICT_ENTRY) {
        DBusMessageIter entry, ifaces;
        const char *path = NULL;

        dbus_message_iter_recurse(&arr, &entry);
        if (iter_get_basic(&entry, DBUS_TYPE_OBJECT_PATH, &path) != 0 || !path) {
            dbus_message_iter_next(&arr);
            continue;
        }
        dbus_message_iter_next(&entry);
        dbus_message_iter_recurse(&entry, &ifaces);

        while (dbus_message_iter_get_arg_type(&ifaces) == DBUS_TYPE_DICT_ENTRY) {
            DBusMessageIter iface_entry, props;
            const char *iface = NULL;

            dbus_message_iter_recurse(&ifaces, &iface_entry);
            if (iter_get_basic(&iface_entry, DBUS_TYPE_STRING, &iface) != 0 ||
                !iface) {
                dbus_message_iter_next(&ifaces);
                continue;
            }
            dbus_message_iter_next(&iface_entry);
            dbus_message_iter_recurse(&iface_entry, &props);

            if (strcmp(iface, DEVICE_IFACE) == 0) {
                DBusMessageIter prop_entry;
                const char *name = "";
                const char *addr = "";
                bool has_nus;
                bool name_match;

                dbus_message_iter_recurse(&props, &prop_entry);
                while (dbus_message_iter_get_arg_type(&prop_entry) == DBUS_TYPE_DICT_ENTRY) {
                    DBusMessageIter kv;
                    const char *key = NULL;

                    dbus_message_iter_recurse(&prop_entry, &kv);
                    if (iter_get_basic(&kv, DBUS_TYPE_STRING, &key) != 0 ||
                        !key) {
                        dbus_message_iter_next(&prop_entry);
                        continue;
                    }
                    dbus_message_iter_next(&kv);

                    if (strcmp(key, "Name") == 0) {
                        name = iter_get_string(&kv);
                    } else if (strcmp(key, "Address") == 0) {
                        addr = iter_get_string(&kv);
                    }
                    dbus_message_iter_next(&prop_entry);
                }

                has_nus = uuid_matches(&props, NUS_SERVICE);
                if (match->address && strcasecmp(match->address, addr) == 0) {
                    /* snprintf, not strncpy: a shorter name after a longer one
                     * would otherwise keep the previous tail. */
                    snprintf(match->path, sizeof(match->path), "%s", path);
                    snprintf(match->found_name, sizeof(match->found_name), "%s",
                             name ? name : "");
                    match->found = true;
                    match->found_has_nus = has_nus;
                    dbus_message_unref(reply);
                    return;
                }

                name_match = name && name[0] &&
                             strncmp(name, match->name_prefix,
                                     strlen(match->name_prefix)) == 0;
                if (name_match) {
                    int rank = device_rank(strcmp(name, match->name_prefix) == 0,
                                           has_nus);

                    if (rank > match->best_rank) {
                        match->best_rank = rank;
                        snprintf(match->path, sizeof(match->path), "%s", path);
                        snprintf(match->found_name, sizeof(match->found_name),
                                 "%s", name);
                        match->found = true;
                        match->found_has_nus = has_nus;
                    }
                }
            }
            dbus_message_iter_next(&ifaces);
        }
        dbus_message_iter_next(&arr);
    }

    dbus_message_unref(reply);
}

static bool find_device(DBusConnection *conn, struct options *opt,
                        struct device_match *match)
{
    struct timespec start, now;
    bool started = false;
    double elapsed;

    normalize_name_prefix(opt->name, match->name_prefix,
                          sizeof(match->name_prefix));
    match->address = opt->address;
    match->found = false;
    match->found_has_nus = false;
    match->best_rank = -1;
    match->path[0] = '\0';
    match->found_name[0] = '\0';

    if (opt->address) {
        msg("Looking for BLE device at %s ...", opt->address);
    } else {
        msg("Scanning for BLE device matching %s* ...", match->name_prefix);
    }

    /* Start discovery. */
    {
        DBusMessage *reply = call_sync(conn, BLUEZ_BUS, g_state.adapter_path,
                                       ADAPTER_IFACE, "StartDiscovery", NULL);
        if (reply) {
            started = true;
            dbus_message_unref(reply);
        }
    }

    clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;) {
        scan_managed_objects(conn, match);
        if (match->found) {
            break;
        }
        /* Pump D-Bus so BlueZ InterfacesAdded/PropertiesChanged signals are
         * dispatched, keeping the managed-objects cache fresh. */
        dbus_connection_read_write_dispatch(conn, 0);
        usleep(200000);
        clock_gettime(CLOCK_MONOTONIC, &now);
        elapsed = (now.tv_sec - start.tv_sec) +
                  (now.tv_nsec - start.tv_nsec) / 1e9;
        if (elapsed >= opt->timeout) {
            break;
        }
    }

    if (started) {
        DBusMessage *reply = call_sync(conn, BLUEZ_BUS, g_state.adapter_path,
                                       ADAPTER_IFACE, "StopDiscovery", NULL);
        if (reply) {
            dbus_message_unref(reply);
        }
    }

    if (!match->found) {
        /* Name the criterion that actually failed: an address search reported
         * as "matching Linkr BLE UART*" sent people looking for the wrong fix. */
        if (opt->address) {
            err_msg("no BLE device found at address %s", opt->address);
        } else {
            err_msg("device not found matching: %s*", match->name_prefix);
        }
        return false;
    }

    msg("Found %s (%s)", match->found_name, match->path);
    return true;
}

static void list_devices(DBusConnection *conn)
{
    DBusMessage *reply;
    DBusMessageIter iter, arr;

    reply = call_sync(conn, BLUEZ_BUS, "/", DBUS_OM_IFACE, "GetManagedObjects", NULL);
    if (!reply) {
        return;
    }

    dbus_message_iter_init(reply, &iter);
    dbus_message_iter_recurse(&iter, &arr);
    while (dbus_message_iter_get_arg_type(&arr) == DBUS_TYPE_DICT_ENTRY) {
        DBusMessageIter entry, ifaces;
        const char *path = NULL;

        dbus_message_iter_recurse(&arr, &entry);
        if (iter_get_basic(&entry, DBUS_TYPE_OBJECT_PATH, &path) != 0 || !path) {
            dbus_message_iter_next(&arr);
            continue;
        }
        dbus_message_iter_next(&entry);
        dbus_message_iter_recurse(&entry, &ifaces);

        while (dbus_message_iter_get_arg_type(&ifaces) == DBUS_TYPE_DICT_ENTRY) {
            DBusMessageIter iface_entry, props;
            const char *iface = NULL;

            dbus_message_iter_recurse(&ifaces, &iface_entry);
            if (iter_get_basic(&iface_entry, DBUS_TYPE_STRING, &iface) != 0 ||
                !iface) {
                dbus_message_iter_next(&ifaces);
                continue;
            }
            dbus_message_iter_next(&iface_entry);
            dbus_message_iter_recurse(&iface_entry, &props);

            if (strcmp(iface, DEVICE_IFACE) == 0) {
                DBusMessageIter prop_entry;
                const char *name = NULL;
                const char *addr = NULL;

                dbus_message_iter_recurse(&props, &prop_entry);
                while (dbus_message_iter_get_arg_type(&prop_entry) == DBUS_TYPE_DICT_ENTRY) {
                    DBusMessageIter kv;
                    const char *key = NULL;

                    dbus_message_iter_recurse(&prop_entry, &kv);
                    if (iter_get_basic(&kv, DBUS_TYPE_STRING, &key) != 0 ||
                        !key) {
                        dbus_message_iter_next(&prop_entry);
                        continue;
                    }
                    dbus_message_iter_next(&kv);

                    if (strcmp(key, "Name") == 0) {
                        name = iter_get_string(&kv);
                    } else if (strcmp(key, "Address") == 0) {
                        addr = iter_get_string(&kv);
                    }
                    dbus_message_iter_next(&prop_entry);
                }
                if (addr) {
                    /* Unnamed peripherals used to be dropped here, which made an
                     * empty list look like "nothing is nearby". They are exactly
                     * the devices a user cannot identify by looking at names. */
                    printf("%s\t%s\n", addr, (name && name[0]) ? name : "(unknown)");
                }
            }
            dbus_message_iter_next(&ifaces);
        }
        dbus_message_iter_next(&arr);
    }

    dbus_message_unref(reply);
}

static void scan_and_list_devices(DBusConnection *conn, double timeout_sec)
{
    DBusMessage *reply;
    struct timespec start, now;
    double elapsed;
    bool started = false;

    reply = call_sync(conn, BLUEZ_BUS, g_state.adapter_path,
                      ADAPTER_IFACE, "StartDiscovery", NULL);
    if (reply) {
        started = true;
        dbus_message_unref(reply);
    }

    clock_gettime(CLOCK_MONOTONIC, &start);
    do {
        dbus_connection_read_write_dispatch(conn, 100);
        clock_gettime(CLOCK_MONOTONIC, &now);
        elapsed = (now.tv_sec - start.tv_sec) +
                  (now.tv_nsec - start.tv_nsec) / 1e9;
    } while (elapsed < timeout_sec);

    list_devices(conn);

    if (started) {
        reply = call_sync(conn, BLUEZ_BUS, g_state.adapter_path,
                          ADAPTER_IFACE, "StopDiscovery", NULL);
        if (reply) {
            dbus_message_unref(reply);
        }
    }
}

/* ------------------------------------------------------------------------ */
/* Connection & GATT discovery                                              */
/* ------------------------------------------------------------------------ */

static bool connect_device(DBusConnection *conn, const char *device_path)
{
    DBusMessage *reply;

    msg("Connecting...");
    reply = call_sync(conn, BLUEZ_BUS, device_path, DEVICE_IFACE, "Connect", NULL);
    if (!reply) {
        return false;
    }
    dbus_message_unref(reply);
    g_state.connected = true;
    snprintf(g_state.device_path, sizeof(g_state.device_path), "%s",
             device_path);
    msg("Connected: %s", device_path);
    return true;
}

static bool pair_device(DBusConnection *conn, const char *device_path)
{
    DBusError err;
    DBusMessage *request, *reply;
    bool success;

    msg("Hold Bee GPIO1 to GND; accept pairing in the system Bluetooth agent.");
    dbus_error_init(&err);
    request = dbus_message_new_method_call(BLUEZ_BUS, device_path, DEVICE_IFACE, "Pair");
    if (!request) return false;
    reply = dbus_connection_send_with_reply_and_block(conn, request, 60000, &err);
    dbus_message_unref(request);
    success = reply != NULL || dbus_error_has_name(&err, "org.bluez.Error.AlreadyExists");
    if (!success) msg("Pairing failed: %s", err.message ? err.message : "no reply");
    if (reply) dbus_message_unref(reply);
    dbus_error_free(&err);
    return success;
}

static void disconnect_device(DBusConnection *conn)
{
    DBusMessage *reply;

    if (!g_state.connected || !g_state.device_path[0]) {
        return;
    }

    reply = call_sync(conn, BLUEZ_BUS, g_state.device_path,
                      DEVICE_IFACE, "Disconnect", NULL);
    if (reply) {
        dbus_message_unref(reply);
    }
    g_state.connected = false;
}

static bool discover_characteristics(DBusConnection *conn)
{
    DBusMessage *reply;
    DBusMessageIter iter, arr;
    char nus_dbus_uuid[MAX_UUID_LEN];
    char rx_dbus_uuid[MAX_UUID_LEN];
    char tx_dbus_uuid[MAX_UUID_LEN];

    hex_uuid_to_dbus(NUS_SERVICE, nus_dbus_uuid, sizeof(nus_dbus_uuid));
    hex_uuid_to_dbus(NUS_RX_UUID, rx_dbus_uuid, sizeof(rx_dbus_uuid));
    hex_uuid_to_dbus(NUS_TX_UUID, tx_dbus_uuid, sizeof(tx_dbus_uuid));

    g_state.rx_path[0] = '\0';
    g_state.tx_path[0] = '\0';

    /* BlueZ discovers GATT services asynchronously after Connect; retry until
     * the NUS characteristics appear or we time out (5s). */
    {
        struct timespec dstart, dnow;
        double delapsed = 0;

        clock_gettime(CLOCK_MONOTONIC, &dstart);
        while (!(g_state.rx_path[0] && g_state.tx_path[0]) && delapsed < 5.0) {
            reply = call_sync(conn, BLUEZ_BUS, "/", DBUS_OM_IFACE,
                              "GetManagedObjects", NULL);
            if (reply) {
                dbus_message_iter_init(reply, &iter);
                dbus_message_iter_recurse(&iter, &arr);
                while (dbus_message_iter_get_arg_type(&arr) == DBUS_TYPE_DICT_ENTRY) {
                    DBusMessageIter entry, ifaces;
                    const char *path = NULL;

                    dbus_message_iter_recurse(&arr, &entry);
                    if (iter_get_basic(&entry, DBUS_TYPE_OBJECT_PATH, &path) != 0 ||
                        !path) {
                        dbus_message_iter_next(&arr);
                        continue;
                    }
                    dbus_message_iter_next(&entry);
                    if (strncmp(path, g_state.device_path, strlen(g_state.device_path)) != 0 ||
                        (path[strlen(g_state.device_path)] != '/' &&
                         path[strlen(g_state.device_path)] != '\0')) {
                        dbus_message_iter_next(&arr);
                        continue;
                    }
                    dbus_message_iter_recurse(&entry, &ifaces);

                    while (dbus_message_iter_get_arg_type(&ifaces) == DBUS_TYPE_DICT_ENTRY) {
                        DBusMessageIter iface_entry, props;
                        const char *iface = NULL;

                        dbus_message_iter_recurse(&ifaces, &iface_entry);
                        if (iter_get_basic(&iface_entry, DBUS_TYPE_STRING, &iface) != 0 ||
                            !iface) {
                            dbus_message_iter_next(&ifaces);
                            continue;
                        }
                        dbus_message_iter_next(&iface_entry);
                        dbus_message_iter_recurse(&iface_entry, &props);

                        if (strcmp(iface, CHAR_IFACE) == 0) {
                            DBusMessageIter prop_entry;
                            const char *uuid = NULL;

                            dbus_message_iter_recurse(&props, &prop_entry);
                            while (dbus_message_iter_get_arg_type(&prop_entry) == DBUS_TYPE_DICT_ENTRY) {
                                DBusMessageIter kv;
                                const char *key = NULL;

                                dbus_message_iter_recurse(&prop_entry, &kv);
                                if (iter_get_basic(&kv, DBUS_TYPE_STRING, &key) != 0 ||
                                    !key) {
                                    dbus_message_iter_next(&prop_entry);
                                    continue;
                                }
                                dbus_message_iter_next(&kv);

                                if (strcmp(key, "UUID") == 0) {
                                    uuid = iter_get_string(&kv);
                                }
                                dbus_message_iter_next(&prop_entry);
                            }

                            if (uuid) {
                                if (strcasecmp(uuid, rx_dbus_uuid) == 0) {
                                    snprintf(g_state.rx_path,
                                             sizeof(g_state.rx_path), "%s",
                                             path);
                                } else if (strcasecmp(uuid, tx_dbus_uuid) == 0) {
                                    snprintf(g_state.tx_path,
                                             sizeof(g_state.tx_path), "%s",
                                             path);
                                }
                            }
                        }
                        dbus_message_iter_next(&ifaces);
                    }
                    dbus_message_iter_next(&arr);
                }

                dbus_message_unref(reply);
            }

            if (g_state.rx_path[0] && g_state.tx_path[0]) {
                break;
            }

            usleep(300000);
            clock_gettime(CLOCK_MONOTONIC, &dnow);
            delapsed = (dnow.tv_sec - dstart.tv_sec) +
                       (dnow.tv_nsec - dstart.tv_nsec) / 1e9;
        }
    }

    if (!g_state.rx_path[0] || !g_state.tx_path[0]) {
        msg("NUS RX/TX characteristics not found");
        return false;
    }

    msg("NUS RX: %s", g_state.rx_path);
    msg("NUS TX: %s", g_state.tx_path);
    return true;
}

static void configure_write_chunk(void)
{
    /* Device1 has no portable MTU property. The BlueZ AcquireWrite API can
     * return an MTU with a dedicated file descriptor, but this small
     * WriteValue-based reference client deliberately uses the baseline ATT
     * payload unless the user supplies --ble-write-size. */
    g_state.mtu_write_size = 20;
    msg("using safe BLE write chunk 20 bytes (override with --ble-write-size)");
}

/* ------------------------------------------------------------------------ */
/* Notifications                                                            */
/* ------------------------------------------------------------------------ */

/* Watch org.bluez.Device1.Connected. BlueZ clears it when the link drops, and
 * without this the terminal keeps waiting for a peer that is already gone. */
static void handle_device_properties(DBusMessage *msg, DBusMessageIter *iter)
{
    const char *path = dbus_message_get_path(msg);
    DBusMessageIter changed;

    if (!path || !g_state.device_path[0] ||
        strcmp(path, g_state.device_path) != 0) {
        return;
    }
    /* iter sits on the interface name; the changed-properties dict follows. */
    dbus_message_iter_next(iter);
    if (dbus_message_iter_get_arg_type(iter) != DBUS_TYPE_ARRAY) {
        return;
    }
    dbus_message_iter_recurse(iter, &changed);
    while (dbus_message_iter_get_arg_type(&changed) == DBUS_TYPE_DICT_ENTRY) {
        DBusMessageIter kv;
        const char *key;

        dbus_message_iter_recurse(&changed, &kv);
        if (iter_get_basic(&kv, DBUS_TYPE_STRING, &key) != 0) {
            return;
        }
        dbus_message_iter_next(&kv);
        if (strcmp(key, "Connected") == 0 && variant_is_false(&kv)) {
            g_state.connected = false;
            atomic_store(&g_state.link_lost, true);
            return;
        }
        dbus_message_iter_next(&changed);
    }
}

static DBusHandlerResult filter_signals(DBusConnection *conn,
                                        DBusMessage *msg, void *user_data)
{
    (void)conn;
    (void)user_data;

    if (!dbus_message_is_signal(msg, DBUS_PROP_IFACE, "PropertiesChanged")) {
        return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    }

    const char *iface;
    DBusMessageIter iter, changed;

    if (!dbus_message_iter_init(msg, &iter)) {
        return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    }
    if (dbus_message_iter_get_arg_type(&iter) != DBUS_TYPE_STRING) {
        return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    }
    dbus_message_iter_get_basic(&iter, &iface);

    /* The link state lives on Device1, not on the characteristic. */
    if (strcmp(iface, DEVICE_IFACE) == 0) {
        handle_device_properties(msg, &iter);
        return DBUS_HANDLER_RESULT_HANDLED;
    }
    if (strcmp(iface, CHAR_IFACE) != 0) {
        return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    }

    const char *path = dbus_message_get_path(msg);
    if (!path || strcmp(path, g_state.tx_path) != 0) {
        return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    }

    dbus_message_iter_next(&iter);
    if (dbus_message_iter_get_arg_type(&iter) != DBUS_TYPE_ARRAY) {
        return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
    }
    dbus_message_iter_recurse(&iter, &changed);
    while (dbus_message_iter_get_arg_type(&changed) == DBUS_TYPE_DICT_ENTRY) {
        DBusMessageIter kv;
        const char *key = NULL;

        dbus_message_iter_recurse(&changed, &kv);
        if (iter_get_basic(&kv, DBUS_TYPE_STRING, &key) != 0 || !key) {
            dbus_message_iter_next(&changed);
            continue;
        }
        dbus_message_iter_next(&kv);

        if (strcmp(key, "Value") == 0) {
            uint8_t data[BLE_MAX_NUS_PAYLOAD];
            size_t len = iter_copy_byte_array(&kv, data, sizeof(data));

            if (len > 0) {
                pthread_mutex_lock(&g_state.rx_lock);
                if (g_state.rx_count < sizeof(g_state.rx_packets) / sizeof(g_state.rx_packets[0])) {
                    uint8_t *copy = malloc(len);
                    if (copy) {
                        memcpy(copy, data, len);
                        g_state.rx_packets[g_state.rx_count] = copy;
                        g_state.rx_lengths[g_state.rx_count] = len;
                        g_state.rx_count++;
                        pthread_cond_signal(&g_state.rx_cond);
                    }
                }
                pthread_mutex_unlock(&g_state.rx_lock);
            }
        }
        dbus_message_iter_next(&changed);
    }

    return DBUS_HANDLER_RESULT_HANDLED;
}

static bool start_notifications(DBusConnection *conn)
{
    DBusMessage *reply;

    dbus_bus_add_match(conn,
                       "type='signal',interface='org.freedesktop.DBus.Properties',"
                       "member='PropertiesChanged',path_namespace='/org/bluez'",
                       NULL);
    dbus_connection_add_filter(conn, filter_signals, NULL, NULL);

    reply = call_sync(conn, BLUEZ_BUS, g_state.tx_path, CHAR_IFACE,
                      "StartNotify", NULL);
    if (!reply) {
        return false;
    }
    dbus_message_unref(reply);

    g_state.notifications_started = true;
    msg("Notifications started on TX characteristic");
    return true;
}

static void stop_notifications(DBusConnection *conn)
{
    DBusMessage *reply;

    if (!g_state.notifications_started) {
        return;
    }

    reply = call_sync(conn, BLUEZ_BUS, g_state.tx_path, CHAR_IFACE,
                      "StopNotify", NULL);
    if (reply) {
        dbus_message_unref(reply);
    }
    g_state.notifications_started = false;
}

/* ------------------------------------------------------------------------ */
/* Write helpers                                                            */
/* ------------------------------------------------------------------------ */

static bool write_chunk(DBusConnection *conn, const uint8_t *data, size_t len,
                        bool with_response)
{
    DBusMessage *msg_call, *reply;
    DBusMessageIter iter, arr;

    msg_call = dbus_message_new_method_call(BLUEZ_BUS, g_state.rx_path,
                                            CHAR_IFACE, "WriteValue");
    if (!msg_call) {
        return false;
    }

    dbus_message_iter_init_append(msg_call, &iter);
    dbus_message_iter_open_container(&iter, DBUS_TYPE_ARRAY, "y", &arr);
    for (size_t i = 0; i < len; i++) {
        dbus_message_iter_append_basic(&arr, DBUS_TYPE_BYTE, &data[i]);
    }
    dbus_message_iter_close_container(&iter, &arr);

    {
        DBusMessageIter dict, dict_entry, val_iter;
        dbus_message_iter_open_container(&iter, DBUS_TYPE_ARRAY, "{sv}", &dict);
        dbus_message_iter_open_container(&dict, DBUS_TYPE_DICT_ENTRY, NULL, &dict_entry);
        const char *type_key = "type";
        dbus_message_iter_append_basic(&dict_entry, DBUS_TYPE_STRING, &type_key);
        const char *type_val = with_response ? "request" : "command";
        dbus_message_iter_open_container(&dict_entry, DBUS_TYPE_VARIANT, "s", &val_iter);
        dbus_message_iter_append_basic(&val_iter, DBUS_TYPE_STRING, &type_val);
        dbus_message_iter_close_container(&dict_entry, &val_iter);
        dbus_message_iter_close_container(&dict, &dict_entry);
        dbus_message_iter_close_container(&iter, &dict);
    }

    reply = dbus_connection_send_with_reply_and_block(conn, msg_call, 5000, NULL);
    dbus_message_unref(msg_call);

    if (!reply) {
        return false;
    }
    dbus_message_unref(reply);
    return true;
}

static bool write_with_mtu(DBusConnection *conn, const uint8_t *data, size_t len,
                           struct options *opt)
{
    int chunk = opt->ble_write_size > 0 ? opt->ble_write_size : g_state.mtu_write_size;
    if (chunk <= 0) {
        chunk = 20;
    }
    if (chunk > BLE_MAX_NUS_PAYLOAD) {
        chunk = BLE_MAX_NUS_PAYLOAD;
    }

    for (size_t offset = 0; offset < len; offset += (size_t)chunk) {
        size_t n = len - offset;
        if (n > (size_t)chunk) {
            n = (size_t)chunk;
        }
        if (opt->debug_io) {
            msg("TX %zu bytes", n);
        }
        if (!write_chunk(conn, data + offset, n, opt->write_response)) {
            msg("BLE write failed at offset %zu", offset);
            return false;
        }
        /* Small inter-chunk pacing similar to the Python tool. */
        if (offset + n < len) {
            usleep(5000);
        }
    }
    return true;
}

/* ------------------------------------------------------------------------ */
/* stdin / terminal handling                                                */
/* ------------------------------------------------------------------------ */

static void set_raw_mode(int fd)
{
    struct termios tio;

    if (!isatty(fd)) {
        return;
    }

    tcgetattr(fd, &g_state.saved_tio);
    g_state.tio_saved = true;

    tio = g_state.saved_tio;
    cfmakeraw(&tio);
    tio.c_cc[VMIN] = 1;
    tio.c_cc[VTIME] = 0;
    tcsetattr(fd, TCSADRAIN, &tio);
}

static void restore_terminal(void)
{
    if (g_state.tio_saved) {
        tcsetattr(STDIN_FILENO, TCSADRAIN, &g_state.saved_tio);
        g_state.tio_saved = false;
    }
}

static void tx_enqueue(const uint8_t *data, size_t len)
{
    size_t cap = sizeof(g_state.tx_buf);

    pthread_mutex_lock(&g_state.tx_lock);
    size_t i = 0;
    while (i < len && !g_state.tx_done) {
        /* Block instead of dropping bytes when the ring buffer is full. */
        while (g_state.tx_count >= cap && !g_state.tx_done) {
            pthread_cond_wait(&g_state.tx_cond, &g_state.tx_lock);
        }
        if (g_state.tx_done) {
            break;
        }
        while (i < len && g_state.tx_count < cap) {
            g_state.tx_buf[(g_state.tx_head + g_state.tx_count) % cap] = data[i];
            g_state.tx_count++;
            i++;
        }
    }
    pthread_cond_signal(&g_state.tx_cond);
    pthread_mutex_unlock(&g_state.tx_lock);
}

static void *stdin_thread(void *arg)
{
    struct options *opt = arg;
    int fd = STDIN_FILENO;
    uint8_t buf[1024];
    const uint8_t *escape = (const uint8_t *)opt->escape;
    size_t escape_len = strlen(opt->escape);

    if (escape_len > 1) {
        msg("warning: multi-byte escape may be missed across read boundaries");
    }

    if (!opt->line_mode) {
        set_raw_mode(fd);
    }

    while (!g_state.tx_done) {
        ssize_t n;
        uint8_t translated[2048];
        size_t tlen;

        if (opt->line_mode) {
            if (fgets((char *)buf, sizeof(buf), stdin) == NULL) {
                break;
            }
            n = (ssize_t)strlen((char *)buf);
        } else {
            n = read(fd, buf, sizeof(buf));
            if (n <= 0) {
                break;
            }
        }

        normalize_enter(buf, (size_t)n, opt->enter, translated, &tlen,
                        sizeof(translated));

        if (opt->local_echo) {
            pthread_mutex_lock(&g_state.stdout_lock);
            fwrite(translated, 1, tlen, stdout);
            fflush(stdout);
            pthread_mutex_unlock(&g_state.stdout_lock);
        }

        /* Check for escape sequence. */
        if (!opt->line_mode && escape_len > 0) {
            for (size_t i = 0; i + escape_len <= tlen; i++) {
                if (memcmp(translated + i, escape, escape_len) == 0) {
                    if (i > 0) {
                        tx_enqueue(translated, i);
                    }
                    g_state.tx_done = true;
                    pthread_cond_signal(&g_state.tx_cond);
                    goto done;
                }
            }
        }

        tx_enqueue(translated, tlen);
    }

done:
    g_state.tx_done = true;
    pthread_cond_signal(&g_state.tx_cond);
    return NULL;
}

static size_t tx_dequeue(uint8_t *out, size_t max, long timeout_ms)
{
    struct timespec ts;
    size_t n;

    pthread_mutex_lock(&g_state.tx_lock);
    if (g_state.tx_count == 0 && !g_state.tx_done) {
        clock_gettime(CLOCK_REALTIME, &ts);
        timespec_add_ms(&ts, timeout_ms);
        pthread_cond_timedwait(&g_state.tx_cond, &g_state.tx_lock, &ts);
    }

    n = g_state.tx_count;
    if (n > max) {
        n = max;
    }
    for (size_t i = 0; i < n; i++) {
        out[i] = g_state.tx_buf[g_state.tx_head];
        g_state.tx_head = (g_state.tx_head + 1) % sizeof(g_state.tx_buf);
        g_state.tx_count--;
    }
    if (n > 0) {
        /* Wake the producer if it was blocked waiting for space. */
        pthread_cond_signal(&g_state.tx_cond);
    }
    pthread_mutex_unlock(&g_state.tx_lock);
    return n;
}

static bool tx_finished(void)
{
    bool finished;

    pthread_mutex_lock(&g_state.tx_lock);
    finished = g_state.tx_done && g_state.tx_count == 0;
    pthread_mutex_unlock(&g_state.tx_lock);
    return finished;
}

/* ------------------------------------------------------------------------ */
/* Output / notification handling                                           */
/* ------------------------------------------------------------------------ */

static void drain_notifications(struct options *opt)
{
    (void)opt;
    pthread_mutex_lock(&g_state.rx_lock);
    for (size_t i = 0; i < g_state.rx_count; i++) {
        free(g_state.rx_packets[i]);
        g_state.rx_packets[i] = NULL;
    }
    g_state.rx_count = 0;
    pthread_mutex_unlock(&g_state.rx_lock);
}

static bool pop_notification(uint8_t *out, size_t *out_len, size_t max_len)
{
    bool got = false;

    pthread_mutex_lock(&g_state.rx_lock);
    if (g_state.rx_count > 0) {
        size_t len = g_state.rx_lengths[0];
        if (len > max_len) {
            len = max_len;
        }
        memcpy(out, g_state.rx_packets[0], len);
        *out_len = len;
        free(g_state.rx_packets[0]);
        g_state.rx_count--;
        for (size_t i = 0; i < g_state.rx_count; i++) {
            g_state.rx_packets[i] = g_state.rx_packets[i + 1];
            g_state.rx_lengths[i] = g_state.rx_lengths[i + 1];
        }
        got = true;
    }
    pthread_mutex_unlock(&g_state.rx_lock);
    return got;
}

static bool wait_for_notification(DBusConnection *conn, uint8_t *out,
                                  size_t *out_len, size_t max_len,
                                  double timeout_sec)
{
    struct timespec start, now;
    double elapsed;

    clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;) {
        if (pop_notification(out, out_len, max_len)) {
            return true;
        }

        dbus_connection_read_write_dispatch(conn, 50);

        if (pop_notification(out, out_len, max_len)) {
            return true;
        }

        clock_gettime(CLOCK_MONOTONIC, &now);
        elapsed = (now.tv_sec - start.tv_sec) +
                  (now.tv_nsec - start.tv_nsec) / 1e9;
        if (elapsed >= timeout_sec) {
            return false;
        }
    }
}

static void emit_rx(const uint8_t *data, size_t len, struct options *opt)
{
    if (opt->debug_io) {
        msg("RX %zu bytes", len);
    }

    pthread_mutex_lock(&g_state.stdout_lock);
    fwrite(data, 1, len, stdout);
    fflush(stdout);
    pthread_mutex_unlock(&g_state.stdout_lock);

    if (g_state.log_file) {
        fwrite(data, 1, len, g_state.log_file);
        fflush(g_state.log_file);
    }
}

static void process_queued_rx(struct options *opt)
{
    pthread_mutex_lock(&g_state.rx_lock);
    while (g_state.rx_count > 0) {
        uint8_t *pkt = g_state.rx_packets[0];
        size_t len = g_state.rx_lengths[0];
        g_state.rx_count--;
        for (size_t i = 0; i < g_state.rx_count; i++) {
            g_state.rx_packets[i] = g_state.rx_packets[i + 1];
            g_state.rx_lengths[i] = g_state.rx_lengths[i + 1];
        }
        pthread_mutex_unlock(&g_state.rx_lock);
        emit_rx(pkt, len, opt);
        free(pkt);
        pthread_mutex_lock(&g_state.rx_lock);
    }
    pthread_mutex_unlock(&g_state.rx_lock);
}

/* ------------------------------------------------------------------------ */
/* Loopback test                                                            */
/* ------------------------------------------------------------------------ */

static bool do_loopback_test(DBusConnection *conn, struct options *opt)
{
    const char *payload = opt->loopback_test;
    size_t payload_len = strlen(payload);
    struct timespec start, now;
    size_t acc_cap;
    uint8_t *acc;
    size_t acc_len = 0;

    if (payload_len == 0 || payload_len > SIZE_MAX - BLE_MAX_NUS_PAYLOAD) {
        msg("loopback payload must not be empty or oversized");
        return false;
    }
    acc_cap = payload_len + BLE_MAX_NUS_PAYLOAD;
    if (acc_cap < 512) {
        acc_cap = 512;
    }
    acc = malloc(acc_cap);
    if (!acc) {
        msg("loopback: out of memory");
        return false;
    }

    drain_notifications(opt);
    msg("loopback -> %s", payload);

    if (!write_with_mtu(conn, (const uint8_t *)payload, payload_len, opt)) {
        free(acc);
        return false;
    }

    clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;) {
        uint8_t buf[BLE_MAX_NUS_PAYLOAD];
        size_t len;
        double elapsed;

        clock_gettime(CLOCK_MONOTONIC, &now);
        elapsed = (now.tv_sec - start.tv_sec) +
                  (now.tv_nsec - start.tv_nsec) / 1e9;
        if (elapsed >= opt->loopback_timeout) {
            break;
        }

        if (!wait_for_notification(conn, buf, &len, sizeof(buf),
                                   opt->loopback_timeout - elapsed)) {
            continue;
        }

        if (len > acc_cap - acc_len) {
            size_t discard = len - (acc_cap - acc_len);

            if (discard >= acc_len) {
                acc_len = 0;
            } else {
                memmove(acc, acc + discard, acc_len - discard);
                acc_len -= discard;
            }
        }
        memcpy(acc + acc_len, buf, len);
        acc_len += len;

        if (memmem(acc, acc_len, payload, payload_len) != NULL) {
            msg("loopback PASS");
            free(acc);
            return true;
        }
    }

    msg("loopback FAIL");
    free(acc);
    return false;
}

/* ------------------------------------------------------------------------ */
/* Main event loop                                                          */
/* ------------------------------------------------------------------------ */

static int run_terminal(DBusConnection *conn, struct options *opt)
{
    pthread_t tid;
    int err;
    bool lost = false;
    bool write_failed = false;
    char escape_name[32];

    describe_escape(opt->escape, escape_name, sizeof(escape_name));
    msg("Terminal open. Press %s to exit.", escape_name);

    err = pthread_create(&tid, NULL, stdin_thread, opt);
    if (err) {
        err_msg("could not start stdin thread: %s", strerror(err));
        return EXIT_ERROR;
    }

    for (;;) {
        uint8_t buf[TX_BUF_SIZE / 2];
        size_t n;

        dbus_connection_read_write_dispatch(conn, 20);
        process_queued_rx(opt);

        if (atomic_load(&g_state.link_lost)) {
            lost = true;
            break;
        }

        n = tx_dequeue(buf, sizeof(buf), 20);

        if (n > 0) {
            if (!write_with_mtu(conn, buf, n, opt)) {
                write_failed = true;
                break;
            }
        }

        process_queued_rx(opt);
        if (tx_finished()) {
            break;
        }
    }

    if (lost || write_failed) {
        /* Raw mode leaves the cursor mid-line, so start on a fresh one. */
        fputs("\n", stderr);
        /* The reader thread is blocked in read()/fgets() and only returns on the
         * next keystroke, so joining it here would hang the client. Let process
         * exit reclaim it after the terminal is restored. */
        atomic_store(&g_state.tx_done, true);
        if (lost) {
            err_msg("BLE disconnected during the terminal session");
            return EXIT_DEVICE_DISCONNECTED;
        }
        err_msg("BLE write failed; closing the terminal");
        return EXIT_ERROR;
    }

    pthread_join(tid, NULL);
    msg("Terminal closed.");
    return EXIT_OK;
}

/* ------------------------------------------------------------------------ */
/* Argument parsing                                                         */
/* ------------------------------------------------------------------------ */

static const char *parse_escape(const char *s)
{
    static char out[8];

    if (s[0] == '^' && s[1] == '\0') {
        /* A lone caret starts the ^X form; it is not the literal byte '^'.
         * This used to be accepted silently. */
        usage_fatal("escape must be one byte, like ^] or 0x1d");
    }
    if (strlen(s) == 2 && s[0] == '^') {
        out[0] = (char)(toupper((unsigned char)s[1]) & 0x1f);
        out[1] = '\0';
        return out;
    }
    if (strncmp(s, "0x", 2) == 0) {
        char *end = NULL;
        unsigned long v;

        errno = 0;
        v = strtoul(s + 2, &end, 16);
        /* 0x00 is allowed here to match the Python client's validator. */
        if (errno == 0 && end != s + 2 && *end == '\0' && v <= 0xff) {
            out[0] = (char)v;
            out[1] = '\0';
            return out;
        }
        usage_fatal("hex escape must be between 0x00 and 0xff");
    }
    if (strlen(s) == 1) {
        out[0] = s[0];
        out[1] = '\0';
        return out;
    }
    usage_fatal("escape must be one byte, like ^] or 0x1d");
    return NULL;
}

static double parse_positive_double(const char *option, const char *value)
{
    char *end = NULL;
    double parsed;

    errno = 0;
    parsed = strtod(value, &end);
    if (errno != 0 || end == value || *end != '\0' ||
        !isfinite(parsed) || parsed <= 0.0) {
        usage_fatal("%s must be a number greater than zero", option);
    }
    return parsed;
}

static int parse_ble_write_size(const char *value)
{
    char *end = NULL;
    long parsed;

    errno = 0;
    parsed = strtol(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' ||
        parsed < 0 || parsed > BLE_MAX_NUS_PAYLOAD) {
        usage_fatal("--ble-write-size must be between 0 and %d",
                    BLE_MAX_NUS_PAYLOAD);
    }
    return (int)parsed;
}

static void usage(FILE *out, const char *prog)
{
    fprintf(out,
            "Usage: %s [options]\n"
            "\n"
            "Options:\n"
            "  --name NAME           BLE device name or prefix (default: '%s')\n"
            "  --address ADDR        BLE address; skip name scan\n"
            "  --scan                list nearby BLE devices; exits unless another\n"
            "                        action or --address is also given\n"
            "  --timeout SEC         scan timeout (default: 8.0)\n"
            "  --pair                request OS bonding; hold Bee GPIO1 low\n"
            "  --loopback-test PAYLOAD  send payload and require echo\n"
            "  --loopback-timeout SEC   loopback timeout (default: 3.0)\n"
            "  --no-terminal         connect, run commands, exit\n"
            "  --ble-write-size N    max bytes per BLE write (0=20-byte safe default)\n"
            "  --write-response      use GATT write-with-response (default: without)\n"
            "  --enter MODE          raw|cr|lf|crlf (default: raw)\n"
            "  --local-echo          echo typed bytes locally\n"
            "  --line-mode           send one visible line at a time\n"
            "  --debug-io            print BLE TX/RX traces\n"
            "  --log-file PATH       append raw BLE RX bytes to file\n"
            "  --escape BYTE         terminal escape byte (default: ^])\n"
            "  --quiet               suppress progress messages on stderr\n"
            "  --version             print the client version and exit\n"
            "  --print-completion SHELL  print a bash fish or zsh completion script and exit\n"
            "  -h, --help            show this help\n"
            "\n"
            "Long options also accept the --option=value form.\n"
            "Exit codes: 0 ok, 1 error, 2 bad arguments, 3 device disconnected.\n"
            "\n"
            "This is the Linux/BlueZ reference client and it speaks legacy NUS\n"
            "only. Use linkr_ble_terminal.py for Management v1, Reliable UART,\n"
            "WiFi and WebDAV control.\n",
            prog, DEFAULT_NAME);
}

/* ------------------------------------------------------------------------ */
/* Shell completion                                                         */
/* ------------------------------------------------------------------------ */

/* The option list only exists here because this client parses argv by hand;
 * the Python client generates its completions from argparse. A test asserts
 * that every flag parse_args() matches on appears in these scripts and that
 * nothing else does, so the two cannot drift apart silently. */
struct completion_option {
    const char *name;
    bool takes_value;
    bool is_file;
    const char *choices; /* space separated; "" when the value is free-form */
    const char *help;
};

static const struct completion_option k_completion_options[] = {
    { "-h", false, false, "", "show this help" },
    { "--help", false, false, "", "show this help" },
    { "--version", false, false, "", "print the client version and exit" },
    { "--name", true, false, "", "BLE device name or prefix" },
    { "--address", true, false, "", "BLE address; skip name scan" },
    { "--scan", false, false, "", "list nearby BLE devices" },
    { "--timeout", true, false, "", "scan timeout seconds" },
    { "--pair", false, false, "", "request OS bonding; hold Bee GPIO1 low" },
    { "--loopback-test", true, false, "", "send payload and require echo" },
    { "--loopback-timeout", true, false, "", "loopback timeout seconds" },
    { "--no-terminal", false, false, "", "connect, run commands, exit" },
    { "--ble-write-size", true, false, "", "max bytes per BLE write" },
    { "--write-response", false, false, "", "use GATT write-with-response" },
    { "--enter", true, false, "raw cr lf crlf", "translate Enter key bytes" },
    { "--local-echo", false, false, "", "echo typed bytes locally" },
    { "--line-mode", false, false, "", "send one visible line at a time" },
    { "--debug-io", false, false, "", "print BLE TX/RX byte traces" },
    { "--log-file", true, true, "", "append raw BLE RX bytes to file" },
    { "--escape", true, false, "", "terminal escape byte" },
    { "--quiet", false, false, "", "suppress progress messages" },
    { "--print-completion", true, false, "bash fish zsh",
      "print a bash fish or zsh completion script and exit" },
};

#define COMPLETION_COUNT \
    (sizeof(k_completion_options) / sizeof(k_completion_options[0]))

/* The name this client is installed under, and the completion function that
 * serves it. The Python client keeps the same pair in COMPLETION_COMMANDS. */
#define COMPLETION_COMMAND  "linkr_ble_terminal_c"
#define COMPLETION_FUNCTION "_linkr_ble_terminal_c"

/* "--ble-write-size" -> "ble write size", for the zsh value label. */
static void completion_label(const char *name, char *out, size_t out_len)
{
    size_t o = 0;

    while (*name == '-') {
        name++;
    }
    for (; *name && o + 1 < out_len; name++) {
        out[o++] = (*name == '-') ? ' ' : *name;
    }
    out[o] = '\0';
}

static void print_completion_bash(void)
{
    size_t i;
    bool first_file = true;

    printf("# bash completion for the Linkr BLE host CLI (C client).\n"
           "# Generated by --print-completion; do not edit by hand.\n"
           "#\n"
           "#   source <(%s --print-completion bash)\n"
           "%s() {\n"
           "    local cur prev\n"
           "    cur=\"${COMP_WORDS[COMP_CWORD]}\"\n"
           "    prev=\"${COMP_WORDS[COMP_CWORD-1]}\"\n"
           "\n"
           "    case \"$prev\" in\n",
           COMPLETION_COMMAND, COMPLETION_FUNCTION);

    for (i = 0; i < COMPLETION_COUNT; i++) {
        const struct completion_option *opt = &k_completion_options[i];

        if (opt->takes_value && opt->choices[0] != '\0') {
            printf("        %s) COMPREPLY=( $(compgen -W \"%s\" -- \"$cur\") );"
                   " return ;;\n", opt->name, opt->choices);
        }
    }
    for (i = 0; i < COMPLETION_COUNT; i++) {
        if (k_completion_options[i].is_file) {
            printf("%s%s", first_file ? "        " : "|",
                   k_completion_options[i].name);
            first_file = false;
        }
    }
    if (!first_file) {
        printf(") COMPREPLY=( $(compgen -f -- \"$cur\") ); return ;;\n");
    }

    printf("    esac\n"
           "\n"
           "    case \"$cur\" in\n");
    /* --flag=value is accepted, so complete the value after the '=' as well:
     * zsh gets this from the '=' in its specs, bash has to be told. */
    for (i = 0; i < COMPLETION_COUNT; i++) {
        const struct completion_option *opt = &k_completion_options[i];

        if (opt->takes_value && opt->choices[0] != '\0') {
            printf("        %s=*) COMPREPLY=( $(compgen -W \"%s\" "
                   "-P \"${cur%%%%=*}=\" -- \"${cur#*=}\") ); return ;;\n",
                   opt->name, opt->choices);
        }
    }
    first_file = true;
    for (i = 0; i < COMPLETION_COUNT; i++) {
        if (k_completion_options[i].is_file) {
            printf("%s%s", first_file ? "        " : "|",
                   k_completion_options[i].name);
            first_file = false;
        }
    }
    if (!first_file) {
        printf("=*) COMPREPLY=( $(compgen -f -P \"${cur%%%%=*}=\" "
               "-- \"${cur#*=}\") ); return ;;\n");
    }
    printf("    esac\n"
           "\n"
           "    if [[ \"$cur\" == -* ]]; then\n"
           "        COMPREPLY=( $(compgen -W \"");
    for (i = 0; i < COMPLETION_COUNT; i++) {
        printf("%s ", k_completion_options[i].name);
    }
    printf("\" -- \"$cur\") )\n"
           "    fi\n"
           "    return 0\n"
           "}\n"
           "complete -F %s %s\n", COMPLETION_FUNCTION, COMPLETION_COMMAND);
}

static void print_completion_zsh(void)
{
    size_t i;
    char label[64];

    printf("#compdef %s\n"
           "# zsh completion for the Linkr BLE host CLI (C client).\n"
           "# Generated by --print-completion; do not edit by hand.\n"
           "#\n"
           "#   source <(%s --print-completion zsh)\n"
           "%s() {\n"
           "    _arguments -s -S \\\n",
           COMPLETION_COMMAND, COMPLETION_COMMAND, COMPLETION_FUNCTION);

    for (i = 0; i < COMPLETION_COUNT; i++) {
        const struct completion_option *opt = &k_completion_options[i];
        const char *tail = (i + 1 == COMPLETION_COUNT) ? "" : " \\";

        completion_label(opt->name, label, sizeof(label));
        if (!opt->takes_value) {
            printf("        '%s[%s]'%s\n", opt->name, opt->help, tail);
        } else if (opt->is_file) {
            printf("        '%s=[%s]:file:_files'%s\n", opt->name, opt->help,
                   tail);
        } else if (opt->choices[0] != '\0') {
            printf("        '%s=[%s]:%s:(%s)'%s\n", opt->name, opt->help, label,
                   opt->choices, tail);
        } else {
            printf("        '%s=[%s]:%s:'%s\n", opt->name, opt->help, label,
                   tail);
        }
    }

    printf("}\n"
           "\n"
           "if [ \"$funcstack[1]\" = \"%s\" ]; then\n"
           "    %s \"$@\"\n"
           "else\n"
           "    compdef %s %s\n"
           "fi\n",
           COMPLETION_FUNCTION, COMPLETION_FUNCTION, COMPLETION_FUNCTION,
           COMPLETION_COMMAND);
}

static void print_completion_fish(void)
{
    size_t i;

    printf("# fish completion for the Linkr BLE host CLI (C client).\n"
           "# Generated by --print-completion; do not edit by hand.\n"
           "#\n"
           "#   %s --print-completion fish > \\\n"
           "#       ~/.config/fish/completions/%s.fish\n",
           COMPLETION_COMMAND, COMPLETION_COMMAND);

    for (i = 0; i < COMPLETION_COUNT; i++) {
        const struct completion_option *opt = &k_completion_options[i];

        printf("complete -c %s", COMPLETION_COMMAND);
        if (opt->name[1] == '-') {
            printf(" -l %s", opt->name + 2);
        } else {
            printf(" -s %s", opt->name + 1);
        }
        if (opt->takes_value && opt->choices[0] != '\0') {
            /* -x is "requires a value, complete no files". */
            printf(" -x -a '%s'", opt->choices);
        } else if (opt->is_file) {
            printf(" -r -F");
        } else if (opt->takes_value) {
            printf(" -r -f");
        }
        printf(" -d '%s'\n", opt->help);
    }
}

/* --flag value and --flag=value are both accepted, like the Python client. */
static const char *flag_takes_value(int argc, char **argv, int *index,
                                    const char *flag, const char *inline_value)
{
    if (inline_value) {
        return inline_value;
    }
    if (*index + 1 >= argc) {
        usage_fatal("%s requires a value", flag);
    }
    return argv[++(*index)];
}

static void flag_takes_none(const char *flag, const char *inline_value)
{
    if (inline_value) {
        usage_fatal("%s does not take a value", flag);
    }
}

static void parse_args(int argc, char **argv, struct options *opt)
{
    *opt = (struct options){
        .name = DEFAULT_NAME,
        .timeout = 8.0,
        .loopback_timeout = 3.0,
        .enter = "raw",
        .escape = "^]",
    };

    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        const char *inline_value = NULL;
        const char *eq;
        char flag[64];

        eq = (a[0] == '-' && a[1] == '-') ? strchr(a, '=') : NULL;
        if (eq) {
            size_t n = (size_t)(eq - a);

            if (n >= sizeof(flag)) {
                n = sizeof(flag) - 1;
            }
            memcpy(flag, a, n);
            flag[n] = '\0';
            inline_value = eq + 1;
        } else {
            snprintf(flag, sizeof(flag), "%s", a);
        }

        if (strcmp(flag, "-h") == 0 || strcmp(flag, "--help") == 0) {
            flag_takes_none(flag, inline_value);
            usage(stdout, argv[0]);
            exit(EXIT_OK);
        } else if (strcmp(flag, "--version") == 0) {
            flag_takes_none(flag, inline_value);
            printf("linkr_ble_terminal_c %s\n", CLI_VERSION);
            exit(EXIT_OK);
        } else if (strcmp(flag, "--quiet") == 0) {
            flag_takes_none(flag, inline_value);
            g_quiet = true;
        } else if (strcmp(flag, "--print-completion") == 0) {
            const char *shell =
                flag_takes_value(argc, argv, &i, flag, inline_value);

            if (strcmp(shell, "bash") == 0) {
                print_completion_bash();
            } else if (strcmp(shell, "fish") == 0) {
                print_completion_fish();
            } else if (strcmp(shell, "zsh") == 0) {
                print_completion_zsh();
            } else {
                usage_fatal("--print-completion must be bash, fish or zsh");
            }
            exit(EXIT_OK);
        } else if (strcmp(flag, "--name") == 0) {
            opt->name = flag_takes_value(argc, argv, &i, flag, inline_value);
        } else if (strcmp(flag, "--address") == 0) {
            opt->address = flag_takes_value(argc, argv, &i, flag, inline_value);
        } else if (strcmp(flag, "--scan") == 0) {
            flag_takes_none(flag, inline_value);
            opt->scan = true;
        } else if (strcmp(flag, "--timeout") == 0) {
            opt->timeout = parse_positive_double(
                flag, flag_takes_value(argc, argv, &i, flag, inline_value));
        } else if (strcmp(flag, "--pair") == 0) {
            flag_takes_none(flag, inline_value);
            opt->pair = true;
        } else if (strcmp(flag, "--loopback-test") == 0) {
            opt->loopback_test =
                flag_takes_value(argc, argv, &i, flag, inline_value);
        } else if (strcmp(flag, "--loopback-timeout") == 0) {
            opt->loopback_timeout = parse_positive_double(
                flag, flag_takes_value(argc, argv, &i, flag, inline_value));
        } else if (strcmp(flag, "--no-terminal") == 0) {
            flag_takes_none(flag, inline_value);
            opt->no_terminal = true;
        } else if (strcmp(flag, "--ble-write-size") == 0) {
            opt->ble_write_size = parse_ble_write_size(
                flag_takes_value(argc, argv, &i, flag, inline_value));
        } else if (strcmp(flag, "--write-response") == 0) {
            flag_takes_none(flag, inline_value);
            opt->write_response = true;
        } else if (strcmp(flag, "--enter") == 0) {
            opt->enter = flag_takes_value(argc, argv, &i, flag, inline_value);
        } else if (strcmp(flag, "--local-echo") == 0) {
            flag_takes_none(flag, inline_value);
            opt->local_echo = true;
        } else if (strcmp(flag, "--line-mode") == 0) {
            flag_takes_none(flag, inline_value);
            opt->line_mode = true;
        } else if (strcmp(flag, "--debug-io") == 0) {
            flag_takes_none(flag, inline_value);
            opt->debug_io = true;
        } else if (strcmp(flag, "--log-file") == 0) {
            opt->log_file = flag_takes_value(argc, argv, &i, flag, inline_value);
        } else if (strcmp(flag, "--escape") == 0) {
            opt->escape = flag_takes_value(argc, argv, &i, flag, inline_value);
        } else {
            usage_fatal("unknown option: %s", a);
        }
    }

    if (strcmp(opt->enter, "raw") != 0 && strcmp(opt->enter, "cr") != 0 &&
        strcmp(opt->enter, "lf") != 0 && strcmp(opt->enter, "crlf") != 0) {
        usage_fatal("--enter must be raw, cr, lf, or crlf");
    }
    opt->escape = parse_escape(opt->escape);
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                              */
/* ------------------------------------------------------------------------ */

int main(int argc, char **argv)
{
    struct options opt;
    DBusError err;
    struct device_match match;
    int status;

    memset(&g_state, 0, sizeof(g_state));
    /* Ensure the terminal is restored even on fatal()/early exit paths. */
    atexit(restore_terminal);
    pthread_mutex_init(&g_state.tx_lock, NULL);
    pthread_cond_init(&g_state.tx_cond, NULL);
    pthread_mutex_init(&g_state.rx_lock, NULL);
    pthread_cond_init(&g_state.rx_cond, NULL);
    pthread_mutex_init(&g_state.stdout_lock, NULL);

    parse_args(argc, argv, &opt);

    /* Open the log before touching Bluetooth: a bad path should not cost a
     * pairing round trip, and a silently missing log is worse than a failure. */
    if (opt.log_file) {
        g_state.log_file = fopen(opt.log_file, "ab");
        if (!g_state.log_file) {
            fatal("cannot open log file %s: %s", opt.log_file, strerror(errno));
        }
    }

    dbus_error_init(&err);
    g_state.conn = dbus_bus_get(DBUS_BUS_SYSTEM, &err);
    if (!g_state.conn) {
        fatal("cannot connect to system D-Bus: %s", err.message);
    }

    if (!find_adapter(g_state.conn, g_state.adapter_path,
                      sizeof(g_state.adapter_path))) {
        fatal("no BlueZ adapter found");
    }
    msg("Using adapter %s", g_state.adapter_path);

    if (opt.scan) {
        scan_and_list_devices(g_state.conn, opt.timeout);
        /* Listing is the whole job unless another action was requested. The
         * Python client follows the same rule. */
        if (!opt.loopback_test && !opt.pair && !opt.address) {
            return EXIT_OK;
        }
    }

    if (!find_device(g_state.conn, &opt, &match)) {
        return EXIT_ERROR;
    }

    msg("New host: hold Bee GPIO1 to GND before pairing. Bonded hosts reconnect without GPIO1.");
    if (!connect_device(g_state.conn, match.path)) {
        return EXIT_ERROR;
    }

    if (opt.pair && !pair_device(g_state.conn, match.path)) {
        disconnect_device(g_state.conn);
        return EXIT_ERROR;
    }

    if (!discover_characteristics(g_state.conn)) {
        disconnect_device(g_state.conn);
        return EXIT_ERROR;
    }

    if (!start_notifications(g_state.conn)) {
        disconnect_device(g_state.conn);
        return EXIT_ERROR;
    }

    configure_write_chunk();

    if (opt.loopback_test) {
        bool ok = do_loopback_test(g_state.conn, &opt);

        stop_notifications(g_state.conn);
        disconnect_device(g_state.conn);
        restore_terminal();
        if (g_state.log_file) {
            fclose(g_state.log_file);
        }
        return ok ? EXIT_OK : EXIT_ERROR;
    }

    if (opt.no_terminal) {
        stop_notifications(g_state.conn);
        disconnect_device(g_state.conn);
        if (g_state.log_file) {
            fclose(g_state.log_file);
        }
        return EXIT_OK;
    }

    status = run_terminal(g_state.conn, &opt);

    stop_notifications(g_state.conn);
    disconnect_device(g_state.conn);
    restore_terminal();

    if (g_state.log_file) {
        fclose(g_state.log_file);
    }

    return status;
}
