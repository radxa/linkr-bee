/*
 * Linkr BLE Terminal (C / Linux / BlueZ D-Bus)
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
#define BLE_MAX_NUS_PAYLOAD 244

struct options {
    const char *name;
    const char *address;
    bool scan;
    double timeout;
    bool query_uart;
    const char *uart;
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

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

static void msg(const char *fmt, ...)
{
    va_list ap;

    va_start(ap, fmt);
    fprintf(stderr, "linkr-ble-c: ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
}

static void fatal(const char *fmt, ...)
{
    va_list ap;

    va_start(ap, fmt);
    fprintf(stderr, "linkr-ble-c: fatal: ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
    exit(1);
}

static void hex_uuid_to_dbus(const char *uuid128, char *out, size_t out_len)
{
    /* BlueZ uses dashed lowercase 128-bit UUIDs in managed objects. */
    size_t i, o;

    if (out_len < 38) {
        *out = '\0';
        return;
    }

    o = 0;
    for (i = 0; uuid128[i] && o < 36; i++) {
        char c = uuid128[i];
        if (c == '-') {
            continue;
        }
        out[o++] = (char)tolower((unsigned char)c);
        if (o == 8 || o == 12 || o == 16 || o == 20) {
            out[o++] = '-';
        }
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

    /* First normalize all CR/LF/CRLF to a single placeholder LF. */
    for (i = 0; i < in_len && o + repl_len < out_cap; i++) {
        if (in[i] == '\r') {
            if (i + 1 < in_len && in[i + 1] == '\n') {
                i++;
            }
            for (size_t r = 0; r < repl_len && o < out_cap; r++) {
                out[o++] = repl[r];
            }
        } else if (in[i] == '\n') {
            for (size_t r = 0; r < repl_len && o < out_cap; r++) {
                out[o++] = repl[r];
            }
        } else {
            out[o++] = in[i];
        }
    }
    *out_len = o;
}

static const char *normalize_uart_spec(const char *spec)
{
    static char buf[64];
    char tmp[64];
    char *fields[5];
    int n = 0;

    strncpy(tmp, spec, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';

    char *save = NULL;
    for (char *p = strtok_r(tmp, ",", &save); p && n < 5; p = strtok_r(NULL, ",", &save)) {
        fields[n++] = p;
    }
    if (n != 5) {
        fatal("UART spec must be baud,data,parity,stop,flow");
    }

    const char *parity = fields[2];
    if (strcasecmp(parity, "none") == 0 || strcasecmp(parity, "n") == 0) {
        parity = "n";
    } else if (strcasecmp(parity, "odd") == 0 || strcasecmp(parity, "o") == 0) {
        parity = "o";
    } else if (strcasecmp(parity, "even") == 0 || strcasecmp(parity, "e") == 0) {
        parity = "e";
    }

    const char *flow = fields[4];
    if (strcasecmp(flow, "none") == 0 || strcasecmp(flow, "off") == 0 || strcasecmp(flow, "n") == 0) {
        flow = "n";
    } else if (strcasecmp(flow, "rtscts") == 0 || strcasecmp(flow, "hw") == 0) {
        flow = "rtscts";
    }

    snprintf(buf, sizeof(buf), "%s,%s,%s,%s,%s",
             fields[0], fields[1], parity, fields[3], flow);
    return buf;
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
        const char *path;

        dbus_message_iter_recurse(&arr, &entry);
        iter_get_basic(&entry, DBUS_TYPE_OBJECT_PATH, &path);
        dbus_message_iter_next(&entry);
        dbus_message_iter_recurse(&entry, &ifaces);

        while (dbus_message_iter_get_arg_type(&ifaces) == DBUS_TYPE_DICT_ENTRY) {
            DBusMessageIter iface_entry;
            const char *iface;

            dbus_message_iter_recurse(&ifaces, &iface_entry);
            iter_get_basic(&iface_entry, DBUS_TYPE_STRING, &iface);
            if (strcmp(iface, ADAPTER_IFACE) == 0) {
                strncpy(path_out, path, path_out_len - 1);
                path_out[path_out_len - 1] = '\0';
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
};

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
        const char *key;

        dbus_message_iter_recurse(&prop_entry, &kv);
        iter_get_basic(&kv, DBUS_TYPE_STRING, &key);
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
        const char *path;

        dbus_message_iter_recurse(&arr, &entry);
        iter_get_basic(&entry, DBUS_TYPE_OBJECT_PATH, &path);
        dbus_message_iter_next(&entry);
        dbus_message_iter_recurse(&entry, &ifaces);

        while (dbus_message_iter_get_arg_type(&ifaces) == DBUS_TYPE_DICT_ENTRY) {
            DBusMessageIter iface_entry, props;
            const char *iface;

            dbus_message_iter_recurse(&ifaces, &iface_entry);
            iter_get_basic(&iface_entry, DBUS_TYPE_STRING, &iface);
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
                    const char *key;

                    dbus_message_iter_recurse(&prop_entry, &kv);
                    iter_get_basic(&kv, DBUS_TYPE_STRING, &key);
                    dbus_message_iter_next(&kv);

                    if (strcmp(key, "Name") == 0) {
                        name = iter_get_string(&kv);
                    } else if (strcmp(key, "Address") == 0) {
                        addr = iter_get_string(&kv);
                    }
                    dbus_message_iter_next(&prop_entry);
                }

                has_nus = uuid_matches(&props, NUS_SERVICE);
                name_match = name && strncmp(name, match->name_prefix,
                                             strlen(match->name_prefix)) == 0;

                if (match->address && strcasecmp(match->address, addr) == 0) {
                    strncpy(match->path, path, sizeof(match->path) - 1);
                    strncpy(match->found_name, name ? name : "",
                            sizeof(match->found_name) - 1);
                    match->found = true;
                    match->found_has_nus = has_nus;
                    dbus_message_unref(reply);
                    return;
                }

                if (name_match &&
                    (!match->found || (has_nus && !match->found_has_nus))) {
                    strncpy(match->path, path, sizeof(match->path) - 1);
                    strncpy(match->found_name, name, sizeof(match->found_name) - 1);
                    match->found = true;
                    match->found_has_nus = has_nus;
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
    match->path[0] = '\0';
    match->found_name[0] = '\0';

    msg("Scanning for BLE device matching %s* ...", match->name_prefix);

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
        msg("device not found matching: %s*", match->name_prefix);
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
        const char *path;

        dbus_message_iter_recurse(&arr, &entry);
        iter_get_basic(&entry, DBUS_TYPE_OBJECT_PATH, &path);
        dbus_message_iter_next(&entry);
        dbus_message_iter_recurse(&entry, &ifaces);

        while (dbus_message_iter_get_arg_type(&ifaces) == DBUS_TYPE_DICT_ENTRY) {
            DBusMessageIter iface_entry, props;
            const char *iface;

            dbus_message_iter_recurse(&ifaces, &iface_entry);
            iter_get_basic(&iface_entry, DBUS_TYPE_STRING, &iface);
            dbus_message_iter_next(&iface_entry);
            dbus_message_iter_recurse(&iface_entry, &props);

            if (strcmp(iface, DEVICE_IFACE) == 0) {
                DBusMessageIter prop_entry;
                const char *name = NULL;
                const char *addr = NULL;

                dbus_message_iter_recurse(&props, &prop_entry);
                while (dbus_message_iter_get_arg_type(&prop_entry) == DBUS_TYPE_DICT_ENTRY) {
                    DBusMessageIter kv;
                    const char *key;

                    dbus_message_iter_recurse(&prop_entry, &kv);
                    iter_get_basic(&kv, DBUS_TYPE_STRING, &key);
                    dbus_message_iter_next(&kv);

                    if (strcmp(key, "Name") == 0) {
                        name = iter_get_string(&kv);
                    } else if (strcmp(key, "Address") == 0) {
                        addr = iter_get_string(&kv);
                    }
                    dbus_message_iter_next(&prop_entry);
                }
                if (name && addr) {
                    printf("%s\t%s\n", addr, name);
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
    strncpy(g_state.device_path, device_path, sizeof(g_state.device_path) - 1);
    msg("Connected: %s", device_path);
    return true;
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
                    const char *path;

                    dbus_message_iter_recurse(&arr, &entry);
                    iter_get_basic(&entry, DBUS_TYPE_OBJECT_PATH, &path);
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
                        const char *iface;

                        dbus_message_iter_recurse(&ifaces, &iface_entry);
                        iter_get_basic(&iface_entry, DBUS_TYPE_STRING, &iface);
                        dbus_message_iter_next(&iface_entry);
                        dbus_message_iter_recurse(&iface_entry, &props);

                        if (strcmp(iface, CHAR_IFACE) == 0) {
                            DBusMessageIter prop_entry;
                            const char *uuid = NULL;

                            dbus_message_iter_recurse(&props, &prop_entry);
                            while (dbus_message_iter_get_arg_type(&prop_entry) == DBUS_TYPE_DICT_ENTRY) {
                                DBusMessageIter kv;
                                const char *key;

                                dbus_message_iter_recurse(&prop_entry, &kv);
                                iter_get_basic(&kv, DBUS_TYPE_STRING, &key);
                                dbus_message_iter_next(&kv);

                                if (strcmp(key, "UUID") == 0) {
                                    uuid = iter_get_string(&kv);
                                }
                                dbus_message_iter_next(&prop_entry);
                            }

                            if (uuid) {
                                if (strcasecmp(uuid, rx_dbus_uuid) == 0) {
                                    strncpy(g_state.rx_path, path, sizeof(g_state.rx_path) - 1);
                                } else if (strcasecmp(uuid, tx_dbus_uuid) == 0) {
                                    strncpy(g_state.tx_path, path, sizeof(g_state.tx_path) - 1);
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

static int read_device_mtu(DBusConnection *conn)
{
    DBusMessage *msg, *reply;
    DBusMessageIter args, variant;
    DBusError err;
    const char *iface = DEVICE_IFACE;
    const char *prop = "MTU";
    dbus_uint16_t v = 0;

    dbus_error_init(&err);
    msg = dbus_message_new_method_call(BLUEZ_BUS, g_state.device_path,
                                       DBUS_PROP_IFACE, "Get");
    if (!msg) {
        return 0;
    }

    dbus_message_iter_init_append(msg, &args);
    dbus_message_iter_append_basic(&args, DBUS_TYPE_STRING, &iface);
    dbus_message_iter_append_basic(&args, DBUS_TYPE_STRING, &prop);

    reply = dbus_connection_send_with_reply_and_block(conn, msg, 3000, &err);
    dbus_message_unref(msg);

    if (dbus_error_is_set(&err)) {
        dbus_error_free(&err);
        return 0;
    }
    if (!reply) {
        return 0;
    }

    if (dbus_message_iter_init(reply, &args) &&
        dbus_message_iter_get_arg_type(&args) == DBUS_TYPE_VARIANT) {
        dbus_message_iter_recurse(&args, &variant);
        if (dbus_message_iter_get_arg_type(&variant) == DBUS_TYPE_UINT16) {
            dbus_message_iter_get_basic(&variant, &v);
        }
    }
    dbus_message_unref(reply);
    return (int)v;
}

static void configure_write_chunk(void)
{
    int mtu = read_device_mtu(g_state.conn);

    if (mtu >= 23) {
        g_state.mtu_write_size = mtu - 3;
        if (g_state.mtu_write_size > 244) {
            g_state.mtu_write_size = 244;
        }
        if (g_state.mtu_write_size < 20) {
            g_state.mtu_write_size = 20;
        }
        msg("Negotiated ATT MTU %d -> write chunk %d bytes",
            mtu, g_state.mtu_write_size);
    } else {
        g_state.mtu_write_size = 20;
        msg("ATT MTU unknown; using write chunk 20 bytes");
    }
}

/* ------------------------------------------------------------------------ */
/* Notifications                                                            */
/* ------------------------------------------------------------------------ */

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
        const char *key;

        dbus_message_iter_recurse(&changed, &kv);
        iter_get_basic(&kv, DBUS_TYPE_STRING, &key);
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
    if (chunk > 244) {
        chunk = 244;
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
/* Control commands & loopback test                                         */
/* ------------------------------------------------------------------------ */

static bool send_control(DBusConnection *conn, struct options *opt,
                         const char *cmd)
{
    msg("control -> %s", cmd);
    if (!write_with_mtu(conn, (const uint8_t *)cmd, strlen(cmd), opt)) {
        return false;
    }
    for (int i = 0; i < 12; i++) {
        dbus_connection_read_write_dispatch(conn, 50);
        process_queued_rx(opt);
    }
    return true;
}

static bool do_loopback_test(DBusConnection *conn, struct options *opt)
{
    const char *payload = opt->loopback_test;
    size_t payload_len = strlen(payload);
    struct timespec start, now;
    size_t acc_cap = payload_len * 4;
    uint8_t *acc;
    size_t acc_len = 0;

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
    while (acc_len < payload_len) {
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

        if (acc_len + len > acc_cap) {
            len = acc_cap - acc_len;
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

static void run_terminal(DBusConnection *conn, struct options *opt)
{
    pthread_t tid;

    msg("Terminal open. Press Ctrl-] to exit.");

    pthread_create(&tid, NULL, stdin_thread, opt);

    while (!g_state.tx_done) {
        uint8_t buf[TX_BUF_SIZE / 2];
        size_t n;

        dbus_connection_read_write_dispatch(conn, 20);
        process_queued_rx(opt);

        n = tx_dequeue(buf, sizeof(buf), 20);

        if (n > 0) {
            if (!write_with_mtu(conn, buf, n, opt)) {
                break;
            }
        }

        process_queued_rx(opt);
    }

    pthread_join(tid, NULL);
    msg("Terminal closed.");
}

/* ------------------------------------------------------------------------ */
/* Argument parsing                                                         */
/* ------------------------------------------------------------------------ */

static const char *parse_escape(const char *s)
{
    static char out[8];

    if (strlen(s) == 2 && s[0] == '^') {
        out[0] = (char)(toupper((unsigned char)s[1]) & 0x1f);
        out[1] = '\0';
        return out;
    }
    if (strncmp(s, "0x", 2) == 0) {
        unsigned int v;
        if (sscanf(s + 2, "%x", &v) == 1) {
            out[0] = (char)v;
            out[1] = '\0';
            return out;
        }
    }
    if (strlen(s) == 1) {
        out[0] = s[0];
        out[1] = '\0';
        return out;
    }
    fatal("escape must be one byte, like ^] or 0x1d");
    return NULL;
}

static void usage(const char *prog)
{
    fprintf(stderr,
            "Usage: %s [options]\n"
            "\n"
            "Options:\n"
            "  --name NAME           BLE device name or prefix (default: '%s')\n"
            "  --address ADDR        BLE address; skip name scan\n"
            "  --scan                list nearby BLE devices and exit\n"
            "  --timeout SEC         scan timeout (default: 8.0)\n"
            "  --query-uart          send @u? before terminal\n"
            "  --uart SPEC           set UART as baud,data,parity,stop,flow\n"
            "  --loopback-test PAYLOAD  send payload and require echo\n"
            "  --loopback-timeout SEC   loopback timeout (default: 3.0)\n"
            "  --no-terminal         connect, run commands, exit\n"
            "  --ble-write-size N    max bytes per BLE write (0=auto)\n"
            "  --write-response      use GATT write-with-response (default: without)\n"
            "  --enter MODE          raw|cr|lf|crlf (default: raw)\n"
            "  --local-echo          echo typed bytes locally\n"
            "  --line-mode           send one visible line at a time\n"
            "  --debug-io            print BLE TX/RX traces\n"
            "  --log-file PATH       append raw BLE RX bytes to file\n"
            "  --escape BYTE         terminal escape byte (default: ^])\n"
            "  -h, --help            show this help\n",
            prog, DEFAULT_NAME);
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

        if (strcmp(a, "-h") == 0 || strcmp(a, "--help") == 0) {
            usage(argv[0]);
            exit(0);
        } else if (strcmp(a, "--name") == 0 && i + 1 < argc) {
            opt->name = argv[++i];
        } else if (strcmp(a, "--address") == 0 && i + 1 < argc) {
            opt->address = argv[++i];
        } else if (strcmp(a, "--scan") == 0) {
            opt->scan = true;
        } else if (strcmp(a, "--timeout") == 0 && i + 1 < argc) {
            opt->timeout = atof(argv[++i]);
        } else if (strcmp(a, "--query-uart") == 0) {
            opt->query_uart = true;
        } else if (strcmp(a, "--uart") == 0 && i + 1 < argc) {
            opt->uart = argv[++i];
        } else if (strcmp(a, "--loopback-test") == 0 && i + 1 < argc) {
            opt->loopback_test = argv[++i];
        } else if (strcmp(a, "--loopback-timeout") == 0 && i + 1 < argc) {
            opt->loopback_timeout = atof(argv[++i]);
        } else if (strcmp(a, "--no-terminal") == 0) {
            opt->no_terminal = true;
        } else if (strcmp(a, "--ble-write-size") == 0 && i + 1 < argc) {
            opt->ble_write_size = atoi(argv[++i]);
        } else if (strcmp(a, "--write-response") == 0) {
            opt->write_response = true;
        } else if (strcmp(a, "--enter") == 0 && i + 1 < argc) {
            opt->enter = argv[++i];
        } else if (strcmp(a, "--local-echo") == 0) {
            opt->local_echo = true;
        } else if (strcmp(a, "--line-mode") == 0) {
            opt->line_mode = true;
        } else if (strcmp(a, "--debug-io") == 0) {
            opt->debug_io = true;
        } else if (strcmp(a, "--log-file") == 0 && i + 1 < argc) {
            opt->log_file = argv[++i];
        } else if (strcmp(a, "--escape") == 0 && i + 1 < argc) {
            opt->escape = argv[++i];
        } else {
            fatal("unknown option: %s", a);
        }
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

    memset(&g_state, 0, sizeof(g_state));
    /* Ensure the terminal is restored even on fatal()/early exit paths. */
    atexit(restore_terminal);
    pthread_mutex_init(&g_state.tx_lock, NULL);
    pthread_cond_init(&g_state.tx_cond, NULL);
    pthread_mutex_init(&g_state.rx_lock, NULL);
    pthread_cond_init(&g_state.rx_cond, NULL);
    pthread_mutex_init(&g_state.stdout_lock, NULL);

    parse_args(argc, argv, &opt);

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
        if (!opt.query_uart && !opt.uart && !opt.loopback_test) {
            return 0;
        }
    }

    if (!find_device(g_state.conn, &opt, &match)) {
        return 1;
    }

    if (!connect_device(g_state.conn, match.path)) {
        return 1;
    }

    if (!discover_characteristics(g_state.conn)) {
        disconnect_device(g_state.conn);
        return 1;
    }

    /* Start notifications first so MTU exchange can complete, then read the
     * negotiated ATT MTU from BlueZ to size BLE write chunks. Falls back to
     * 20 bytes if the MTU property is unavailable. */
    if (!start_notifications(g_state.conn)) {
        disconnect_device(g_state.conn);
        return 1;
    }

    /* Give BlueZ a moment to finish the LE Data Length / MTU exchange, then
     * size write chunks from the negotiated ATT MTU. */
    usleep(200000);
    configure_write_chunk();

    if (opt.log_file) {
        g_state.log_file = fopen(opt.log_file, "ab");
        if (!g_state.log_file) {
            msg("cannot open log file %s: %s", opt.log_file, strerror(errno));
        }
    }

    if (opt.uart) {
        char cmd[80];
        snprintf(cmd, sizeof(cmd), "@u=%s", normalize_uart_spec(opt.uart));
        send_control(g_state.conn, &opt, cmd);
    }

    if (opt.query_uart) {
        send_control(g_state.conn, &opt, "@u?");
    }

    if (opt.loopback_test) {
        bool ok = do_loopback_test(g_state.conn, &opt);
        stop_notifications(g_state.conn);
        disconnect_device(g_state.conn);
        restore_terminal();
        return ok ? 0 : 1;
    }

    if (opt.no_terminal) {
        stop_notifications(g_state.conn);
        disconnect_device(g_state.conn);
        return 0;
    }

    run_terminal(g_state.conn, &opt);

    stop_notifications(g_state.conn);
    disconnect_device(g_state.conn);
    restore_terminal();

    if (g_state.log_file) {
        fclose(g_state.log_file);
    }

    return 0;
}
