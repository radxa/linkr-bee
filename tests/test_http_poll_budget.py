"""Guard the HTTP poll capacity before concurrent handshakes can exhaust it."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

try:
    import kconfiglib
except ImportError:
    kconfiglib = None

ROOT = Path(__file__).resolve().parents[1]


class HttpPollCapacityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = (ROOT / "src/ws_bridge.c").read_text()
        start = source.index("#define WS_HTTP_SOCKETS_PER_SERVICE")
        end = source.index("enum ws_client_state", start)
        cls.guard = source[start:end]

    def check_capacity(self, budget, *, clients=2, services=1, h1=1, h2=0,
                       h3=0, streams=0, valid=True):
        definitions = {
            "CONFIG_ZVFS_POLL_MAX": budget,
            "CONFIG_HTTP_SERVER_MAX_CLIENTS": clients,
            "CONFIG_HTTP_SERVER_NUM_SERVICES": services,
            "CONFIG_HTTP_SERVER_VERSION_1": h1,
            "CONFIG_HTTP_SERVER_VERSION_2": h2,
            "CONFIG_HTTP_SERVER_VERSION_3": h3,
            "HTTP3_SERVER_MAX_STREAMS": streams,
        }
        source = "#define IS_ENABLED(x) (x)\n#define BUILD_ASSERT _Static_assert\n"
        source += "".join(f"#define {key} {value}\n" for key, value in definitions.items())
        result = subprocess.run([
            *shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-Wall",
            "-Wextra", "-Werror", "-fsyntax-only", "-x", "c", "-",
        ], input=source + self.guard, capture_output=True, text=True, timeout=5)
        if valid:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Increase CONFIG_ZVFS_POLL_MAX", result.stderr)

    def test_two_pending_clients_need_four_events(self):
        self.check_capacity(3, valid=False)
        self.check_capacity(4)
        self.check_capacity(5)
        self.check_capacity(3, clients=1)

    def test_larger_client_limit_requires_a_matching_budget(self):
        self.check_capacity(5, clients=4, valid=False)
        self.check_capacity(6, clients=4)

    def test_every_listener_is_counted(self):
        self.check_capacity(4, services=2, valid=False)
        self.check_capacity(5, services=2)

    def test_http3_adds_streams_and_a_listener_for_mixed_transports(self):
        self.check_capacity(6, h3=1, streams=2, valid=False)
        self.check_capacity(7, h3=1, streams=2)
        self.check_capacity(5, clients=1, h1=0, h3=1, streams=2)


@unittest.skipUnless(kconfiglib, "kconfiglib is required (installed in host CI)")
class HttpPollKconfigTests(unittest.TestCase):
    def configure(self, bridge, override=None, clients=2):
        with tempfile.TemporaryDirectory() as tmp:
            definitions = "".join(
                f'config {name}\n    bool "{name}"\n' for name in
                ["HTTP_SERVER", "HTTP_SERVER_WEBSOCKET"])
            definitions += ("config ZVFS_POLL_MAX\n"
                            '    int "poll slots"\n    default 3\n')
            (Path(tmp) / "Kconfig.zephyr").write_text(definitions)
            with patch.dict(os.environ, {"srctree": tmp}):
                config = kconfiglib.Kconfig(str(ROOT / "Kconfig"), warn=False)
                config.syms["LINKR_BLE_BRIDGE_WIFI"].set_value("y")
                config.syms["LINKR_BLE_BRIDGE_WS_BRIDGE"].set_value("y" if bridge else "n")
                self.assertTrue(config.syms["LINKR_BLE_BRIDGE_WS_BRIDGE_MAX_CLIENTS"].set_value(str(clients)))
                if override is not None:
                    self.assertTrue(config.syms["ZVFS_POLL_MAX"].set_value(str(override)))
                return config.syms["ZVFS_POLL_MAX"].str_value

    def test_only_enabled_bridges_raise_the_upstream_default(self):
        self.assertEqual(self.configure(False), "3")
        self.assertEqual(self.configure(True), "5")
        self.assertEqual(self.configure(True, clients=1), "5")

    def test_explicit_custom_budgets_are_preserved(self):
        self.assertEqual(self.configure(True, override=8), "8")
