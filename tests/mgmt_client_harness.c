/* Compile the production C management writer against a fake GATT peer. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MGMT_HEADER_SIZE 12
#define MGMT_MAX_PAYLOAD 512
#define MGMT_FLAG_ERROR 2
#define BLE_MAX_NUS_PAYLOAD 244
typedef int DBusConnection;
struct options {
    int ble_write_size;
    bool debug_io;
    bool write_response;
};
static struct {
    size_t mgmt_expected, mgmt_received;
    bool mgmt_ready;
    uint32_t mgmt_request_id, mgmt_response_id;
    uint16_t mgmt_flags;
    int mtu_write_size;
    char mgmt_command_path[16];
    uint8_t mgmt_rx[512];
} g_state;
#define msg(...) ((void)0)
#define err_msg(...) ((void)0)

static uint8_t received[524];
static size_t received_len, first_write, terminal_first_write;
static unsigned writes;

static bool write_char(DBusConnection *conn, const char *path,
                       const uint8_t *data, size_t len, bool response)
{
    (void)conn;
    (void)path;
    if (!response || received_len + len > sizeof(received)) {
        return false;
    }
    if (writes++ == 0) {
        first_write = len;
        /* Same minimum required by src/ble_mgmt.c's command_write(). */
        if (len < MGMT_HEADER_SIZE) {
            return false;
        }
    }
    memcpy(received + received_len, data, len);
    received_len += len;
    return true;
}

static bool write_chunk(DBusConnection *conn, const uint8_t *data,
                        size_t len, bool response)
{
    (void)conn;
    (void)data;
    (void)response;
    if (!terminal_first_write) {
        terminal_first_write = len;
    }
    return true;
}

static bool dbus_connection_read_write_dispatch(DBusConnection *conn, int timeout)
{
    const char *reply = "OK name=Bench Bee custom=yes";
    (void)conn;
    (void)timeout;
    g_state.mgmt_received = strlen(reply);
    memcpy(g_state.mgmt_rx, reply, strlen(reply));
    g_state.mgmt_response_id = g_state.mgmt_request_id;
    g_state.mgmt_ready = true;
    return true;
}

#include "production_mgmt.inc"

int main(void)
{
    const int sizes[] = {0, 1, 8, 11, 12, 19, 20, 244};
    const char *command = "@n=12345678901234567890123456789";
    for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
        struct options opt = {.ble_write_size = sizes[i]};
        char reply[513];
        memset(&g_state, 0, sizeof(g_state));
        g_state.mtu_write_size = 20;
        writes = 0;
        received_len = first_write = 0;
        if (!mgmt_send(NULL, command, &opt, reply, sizeof(reply)) ||
            first_write < MGMT_HEADER_SIZE ||
            received_len != MGMT_HEADER_SIZE + strlen(command) ||
            memcmp(received, "LK\1\1\1\0\0\0", 8) ||
            received[8] != strlen(command) ||
            memcmp(received + MGMT_HEADER_SIZE, command, strlen(command)) ||
            strcmp(reply, "OK name=Bench Bee custom=yes")) {
            fprintf(stderr, "management failed for write size %d\n", sizes[i]);
            return 1;
        }
    }
    /* The fix must not change explicit pacing on the terminal's NUS path. */
    struct options opt = {.ble_write_size = 8};
    if (!write_with_mtu(NULL, (const uint8_t *)command, strlen(command), &opt) ||
        terminal_first_write != 8) {
        return 1;
    }
    puts("management framing ok; terminal pacing preserved");
    return 0;
}
