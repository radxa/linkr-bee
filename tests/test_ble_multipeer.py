"""Interleave actual GATT receive functions from two independent peers."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def block(source, start, end):
    at = source.index(start)
    return source[at:source.index(end, at)]


class BleMultipeerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-multipeer-")
        cls.addClassCleanup(cls.tmp.cleanup)
        path = Path(cls.tmp.name)
        (path / "zephyr/bluetooth").mkdir(parents=True)
        (path / "zephyr/sys").mkdir(parents=True)
        (path / "zephyr/bluetooth/conn.h").write_text(
            "#pragma once\n#include <stdint.h>\n#include <stdbool.h>\n#include <sys/types.h>\n"
            "struct bt_conn { unsigned int index; int refs; bool subscribed; };\n")
        (path / "zephyr/bluetooth/uuid.h").write_text("#pragma once\n")
        (path / "zephyr/sys/util.h").write_text("#pragma once\n#define BIT(x) (1u << (x))\n")
        cls.binaries = {}
        for reliable in [True, False]:
            source = (ROOT / ("src/ble_uart_reliable.c" if reliable else "src/ble_mgmt.c")).read_text()
            if reliable:
                production = block(source, "struct reliable_header {", "/*\n * Instrumentation")
                production += block(source, "static uint32_t sequence_next(", "BT_GATT_SERVICE_DEFINE(")
                production += block(source, "void linkr_uart_reliable_disconnected(", "int linkr_uart_reliable_send(")
            else:
                production = block(source, "struct linkr_mgmt_protocol_info {", "static const struct linkr_mgmt_protocol_info protocol_info")
                production += block(source, "static struct linkr_mgmt_rx_state rx_states", "K_MSGQ_DEFINE(request_queue")
                production += block(source, "static void tx_message_free(", "static void rx_reset_locked(")
                production += block(source, "static void rx_reset_locked(", "static ssize_t protocol_read(")
                production += block(source, "static int request_finish_locked(", "static void response_ccc_changed(")
                production += block(source, "void linkr_mgmt_connected(", "int linkr_mgmt_send(")
                production += source[source.index("int linkr_mgmt_send("):]
            (path / "multipeer_production.inc").write_text(production)
            binary = path / ("reliable" if reliable else "management")
            subprocess.run([
                *shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-Wno-unused-function", "-Wno-unused-variable", "-DCONFIG_BT_MAX_CONN=2",
                # The production blocks below carry the firmware's PSRAM placement
                # macro; on a host build there is no external RAM, so it expands to
                # nothing (src/ext_ram.h does the same when CONFIG_ESP_SPIRAM is off).
                "-DLINKR_EXT_RAM_BSS=",
                *(["-DTEST_RELIABLE"] if reliable else []), "-I", str(path), "-I", str(ROOT / "src"),
                str(ROOT / "tests/ble_multipeer_harness.c"), "-o", str(binary),
            ], check=True)
            cls.binaries[reliable] = binary

    def test_reliable_peer_isolation_and_delivery(self):
        for scenario in ["interleave", "retry", "binary", "transport", "handoff"]:
            with self.subTest(scenario=scenario):
                subprocess.run([str(self.binaries[True]), scenario], check=True, capture_output=True, timeout=5)

    def test_management_peer_isolation(self):
        for scenario in ["interleave", "disconnect", "queue_full", "late_response"]:
            with self.subTest(scenario=scenario):
                subprocess.run([str(self.binaries[False]), scenario], check=True, capture_output=True, timeout=5)
