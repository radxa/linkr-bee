"""Compile the actual ownership arbiter with recursive host mutexes."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SerialSessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-session-")
        cls.addClassCleanup(cls.tmp.cleanup)
        path = Path(cls.tmp.name)
        (path / "zephyr/sys").mkdir(parents=True)
        (path / "zephyr/kernel.h").write_text(r'''
#include <pthread.h>
#include <stdint.h>
#define K_FOREVER -1
extern uint32_t test_uptime_ms;
static inline uint32_t k_uptime_get_32(void) { return test_uptime_ms; }
struct k_mutex { pthread_mutex_t native; };
#define K_MUTEX_DEFINE(name) \
struct k_mutex name; \
__attribute__((constructor)) static void init_##name(void) { \
 pthread_mutexattr_t attr; pthread_mutexattr_init(&attr); \
 pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE); \
 pthread_mutex_init(&name.native, &attr); pthread_mutexattr_destroy(&attr); }
static inline void k_mutex_lock(struct k_mutex *m, int timeout) {
 (void)timeout; pthread_mutex_lock(&m->native);
}
static inline void k_mutex_unlock(struct k_mutex *m) { pthread_mutex_unlock(&m->native); }
''')
        (path / "zephyr/sys/printk.h").write_text("#include <stdio.h>\n#define snprintk snprintf\n")
        main = (ROOT / "src/main.c").read_text()
        start = main.index('\n\tLOG_INF("Control command received");')
        end = main.index('\n\tchar target_response[80];', start)
        dispatch = main[start:end]
        (path / "control_dispatch.inc").write_text("""
#define LOG_INF(...)
static struct { uint32_t epoch; } mgmt_capture;
static int aux_calls;
static int send_control_response(const void *peer, const char *format, ...) {
 (void)peer; (void)format; return 0;
}
static bool linkr_aux_is_readonly(const char *body) { return !strcmp(body, "p get"); }
static bool linkr_aux_command(const char *body, char *out, size_t n) {
 (void)body; (void)out; (void)n; aux_calls++; return true;
}
static bool linkr_bond_command(const void *conn, const char *body, char *out, size_t n) {
 (void)conn; (void)body; (void)out; (void)n; return false;
}
static bool linkr_bond_is_readonly(const char *body) {
 (void)body; return false;
}
static bool dispatch_aux(const void *conn, const char *body, uint32_t queued) {
 mgmt_capture.epoch = queued;
""" + dispatch + "\n return false;\n}\n")
        cls.binary = path / "session-test"
        subprocess.run([
            *shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-D_GNU_SOURCE",
            "-Wall", "-Wextra", "-Werror", "-pthread", "-DCONFIG_BT_MAX_CONN=2",
            "-DCONFIG_LINKR_BLE_BRIDGE_SESSION_IDLE_MS=3000",
            "-I", str(path), "-I", str(ROOT / "src"), str(ROOT / "src/serial_session.c"),
            str(ROOT / "tests/serial_session_harness.c"), "-o", str(cls.binary),
        ], check=True)

    def test_real_arbiter_scenarios(self):
        for scenario in ["single_writer", "managed_release", "handover", "reconnect",
                         "queued_command", "concurrent_claims", "disconnected",
                         "bad_handover", "legacy_lan", "aux_permissions",
                         "preempt_claim", "claim_idle", "claim_idle_active",
                         "auto_idle_takeover", "auto_idle_takeover_managed",
                         "command_idle_takeover", "auto_active_rejected"]:
            with self.subTest(scenario=scenario):
                result = subprocess.run([str(self.binary), scenario], capture_output=True,
                                        text=True, check=True, timeout=10)
                self.assertEqual(result.stdout.strip(), "ok")


if __name__ == "__main__":
    unittest.main()
