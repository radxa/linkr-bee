#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

/* settings_load_one returns ssize_t; the build is -std=c11 without POSIX, so
 * provide the typedef the real header would. */
typedef long ssize_t;

#define ARG_UNUSED(x) (void)(x)
#define K_MUTEX_DEFINE(x) int x
#define K_FOREVER 0
#define K_MSEC(x) (x)
#define BT_SECURITY_L2 2
#define BT_ADDR_STR_LEN 18
#define CONFIG_LINKR_BLE_BRIDGE_BOND_LABEL_MAX 48
#define CONFIG_SETTINGS 1
#define IS_ENABLED(x) ((x) != 0)
#define snprintk snprintf

struct k_work { int unused; };
struct k_work_delayable { void (*fn)(struct k_work *); };
#define K_WORK_DELAYABLE_DEFINE(n,f) struct k_work_delayable n = {f}
static int k_mutex_lock(int *m,int t){(void)m;(void)t;return 0;}
static void k_mutex_unlock(int *m){(void)m;}
static int k_work_reschedule(struct k_work_delayable *w,int t){(void)w;(void)t;return 0;}

/* An address carries both its wire bytes (for the NVS key) and its text form
 * (for replies), kept in sync. */
typedef struct { uint8_t val[6]; char text[18]; } bt_addr_t;
typedef struct { uint8_t type; bt_addr_t a; } bt_addr_le_t;
struct bt_bond_info { bt_addr_le_t addr; };
struct bt_conn { int unused; };
struct bt_conn_info { uint8_t id; };

static bt_addr_le_t self = { 0, { { 0x01, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA },
				  "AA:BB:CC:DD:EE:01" } };
static bool exists = true;
static int removals;
static int security = 2;

static int hexd(char c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}
static int parse_mac(const char *s, uint8_t val[6])
{
	size_t n = strlen(s);

	if (n != 17u) return -1;
	for (int i = 0; i < 6; i++) {
		int hi = hexd(s[i * 3]), lo = hexd(s[i * 3 + 1]);

		if (hi < 0 || lo < 0) return -1;
		if (i < 5 && s[i * 3 + 2] != ':') return -1;
		/* Zephyr keeps the address little-endian: val[0] is the last octet. */
		val[5 - i] = (uint8_t)((hi << 4) | lo);
	}
	return 0;
}

static bool bt_addr_le_eq(const bt_addr_le_t *a, const bt_addr_le_t *b)
{
	return a->type == b->type && !memcmp(a->a.val, b->a.val, 6);
}
static void bt_addr_le_copy(bt_addr_le_t *a, const bt_addr_le_t *b) { *a = *b; }
static int bt_addr_to_str(const bt_addr_t *a, char *b, size_t n)
{
	return snprintf(b, n, "%s", a->text);
}
static int bt_addr_le_from_str(const char *s, const char *t, bt_addr_le_t *out)
{
	if (parse_mac(s, out->a.val) != 0) return -EINVAL;
	out->type = !strcmp(t, "random");
	snprintf(out->a.text, sizeof(out->a.text), "%s", s);
	return 0;
}

static int bt_conn_get_info(struct bt_conn *c, struct bt_conn_info *i)
{
	(void)c; i->id = 0; return 0;
}
static int bt_conn_get_security(struct bt_conn *c) { (void)c; return security; }
static const bt_addr_le_t *bt_conn_get_dst(struct bt_conn *c)
{
	(void)c; return &self;
}
static bool bt_le_bond_exists(uint8_t id, const bt_addr_le_t *a)
{
	(void)id; return exists && bt_addr_le_eq(a, &self);
}
static int bt_unpair(uint8_t id, const bt_addr_le_t *a)
{
	(void)id; assert(bt_addr_le_eq(a, &self)); exists = false; removals++; return 0;
}
static void bt_foreach_bond(uint8_t id, void (*cb)(const struct bt_bond_info *, void *), void *data)
{
	(void)id;
	if (exists) { struct bt_bond_info b = { self }; cb(&b, data); }
}

/* Ten kilobytes of key/value memory is far more than eight labels need. */
struct entry { char key[40]; char val[96]; int len; bool used; };
static struct entry store[8];
static int store_find(const char *k)
{
	for (int i = 0; i < 8; i++) if (store[i].used && !strcmp(store[i].key, k)) return i;
	return -1;
}
static int store_free(void)
{
	for (int i = 0; i < 8; i++) if (!store[i].used) return i;
	return -1;
}
static int settings_save_one(const char *k, const void *v, size_t n)
{
	int i;

	if (n > sizeof store[0].val) return -EINVAL;
	i = store_find(k);
	if (i < 0) {
		i = store_free();
		if (i < 0) return -ENOMEM;
		store[i].used = true;
		snprintf(store[i].key, sizeof store[i].key, "%s", k);
	}
	memcpy(store[i].val, v, n);
	store[i].len = (int)n;
	return 0;
}
static ssize_t settings_load_one(const char *k, void *v, size_t n)
{
	int i = store_find(k);

	if (i < 0) return -ENOENT;
	if ((size_t)store[i].len > n) return -ENOSPC;
	memcpy(v, store[i].val, (size_t)store[i].len);
	return store[i].len;
}
static int settings_delete(const char *k)
{
	int i = store_find(k);

	if (i < 0) return -ENOENT;
	store[i].used = false;
	return 0;
}

#include "bond_label_production.inc"
#include "bond_production.inc"

int main(void)
{
	struct bt_conn conn = { 0 };
	char out[512];
	char label[64];
	char hex[99];
	char cmd[160];

	/* Storage: absent reads as empty, round-trips, and lands on the expected
	 * key (address bytes reversed, then the type). */
	assert(linkr_bond_label_get(&self, label, sizeof label) == 0 && label[0] == '\0');
	assert(linkr_bond_label_set(&self, "hello", 5) == 5);
	assert(linkr_bond_label_get(&self, label, sizeof label) == 5 && !strcmp(label, "hello"));
	assert(store_find("linkr/bond/aabbccddee010") >= 0);
	assert(linkr_bond_label_set(&self, "x", 49) < 0);
	assert(linkr_bond_label_clear(&self) == 0);
	assert(linkr_bond_label_get(&self, label, sizeof label) == 0 && label[0] == '\0');
	assert(linkr_bond_label_clear(&self) == 0);

	/* Command: read none, write, read back, clear. */
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01", out, sizeof out);
	assert(strstr(out, "OK bonds label=0/AA:BB:CC:DD:EE:01 none") != NULL);
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01 68656c6c6f", out, sizeof out);
	assert(strstr(out, "hex=68656c6c6f") != NULL);
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01", out, sizeof out);
	assert(strstr(out, "hex=68656c6c6f") != NULL);
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01 clear", out, sizeof out);
	assert(strstr(out, "none") != NULL);

	/* Malformed values. */
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01 123", out, sizeof out);
	assert(strstr(out, "ERR bonds label hex") != NULL);
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01 zz", out, sizeof out);
	assert(strstr(out, "ERR bonds label hex") != NULL);
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01 00", out, sizeof out);
	assert(strstr(out, "ERR bonds label utf8") != NULL);
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01 1b", out, sizeof out);
	assert(strstr(out, "ERR bonds label utf8") != NULL);
	memset(hex, 'a', 98);
	hex[98] = '\0';
	snprintf(cmd, sizeof cmd, "bonds label 0/AA:BB:CC:DD:EE:01 %s", hex);
	linkr_bond_command(&conn, cmd, out, sizeof out);
	assert(strstr(out, "ERR bonds label length") != NULL);

	/* Address and bond checks. */
	linkr_bond_command(&conn, "bonds label 2/AA:BB:CC:DD:EE:01", out, sizeof out);
	assert(strstr(out, "ERR bonds address") != NULL);
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01X", out, sizeof out);
	assert(strstr(out, "ERR bonds address") != NULL);
	linkr_bond_command(&conn, "bonds label 1/AA:BB:CC:DD:EE:01", out, sizeof out);
	assert(strstr(out, "not found") != NULL);

	/* Read-only classification. */
	assert(linkr_bond_is_readonly("bonds?"));
	assert(linkr_bond_is_readonly("bonds label 0/AA:BB:CC:DD:EE:01"));
	assert(!linkr_bond_is_readonly("bonds label 0/AA:BB:CC:DD:EE:01 clear"));
	assert(!linkr_bond_is_readonly("bonds label 0/AA:BB:CC:DD:EE:01 6869"));

	/* The upstream `bonds name` / `bonds names?` compatibility view uses the
	 * same per-bond storage. */
	linkr_bond_command(&conn, "bonds name Hello Bee", out, sizeof out);
	assert(strstr(out, "OK bonds name") != NULL);
	linkr_bond_command(&conn, "bonds names?", out, sizeof out);
	assert(strstr(out, "OK bonds names") != NULL);
	assert(strstr(out, "NAME 0/AA:BB:CC:DD:EE:01 \"Hello Bee\"") != NULL);
	linkr_bond_command(&conn, "bonds label 0/AA:BB:CC:DD:EE:01", out, sizeof out);
	assert(strstr(out, "hex=48656c6c6f20426565") != NULL);
	linkr_bond_command(&conn, "bonds name", out, sizeof out);
	assert(strstr(out, "OK bonds name") != NULL);
	linkr_bond_command(&conn, "bonds names?", out, sizeof out);
	assert(strstr(out, "NAME ") == NULL);

	/* Removing the pairing removes its label. */
	assert(linkr_bond_label_set(&self, "x", 1) == 1);
	linkr_bond_command(&conn, "bonds remove 0/AA:BB:CC:DD:EE:01", out, sizeof out);
	assert(strstr(out, "queued") != NULL);
	remove_work.fn(NULL);
	assert(!pending && removals == 1 && !exists);
	assert(linkr_bond_label_get(&self, label, sizeof label) == 0 && label[0] == '\0');
	assert(store_find("linkr/bond/aabbccddee010") < 0);

	/* A rejected removal keeps the bond and the label. */
	exists = true;
	assert(linkr_bond_label_set(&self, "keep", 4) == 4);
	security = 1;
	linkr_bond_command(&conn, "bonds remove 0/AA:BB:CC:DD:EE:01", out, sizeof out);
	assert(strstr(out, "ERR") != NULL);
	assert(linkr_bond_label_get(&self, label, sizeof label) == 4);

	return 0;
}
