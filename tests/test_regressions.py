"""Run with python3 -m unittest discover -s tests -v (Python + host C compiler)."""

import asyncio
import importlib.util
import io
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parents[1]


class FirmwareTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-regressions-")
        cls.addClassCleanup(cls.tmp.cleanup)
        directory = Path(cls.tmp.name)
        # Compile the actual production function bodies against deterministic
        # host fakes, so the tests exercise retry control flow without a board.
        wifi = (ROOT / "src/wifi.c").read_text()
        upload = wifi[wifi.index("static void upload_thread(void *a"):]
        upload = upload[:upload.index("\n/* ---")]
        main = (ROOT / "src/main.c").read_text()
        forward = main[main.index("static int uart_forward_chunk("):]
        forward = forward[:forward.index("\n#endif")]
        (directory / "production_functions.inc").write_text(upload + forward)
        config = dict(
            line.split("=", 1) for line in (ROOT / "prj.conf").read_text().splitlines()
            if line.startswith("CONFIG_")
        )
        drop = int(config.get("CONFIG_LINKR_BLE_BRIDGE_UART_RX_DROP_NO_CONN") == "y")
        cls.binary = directory / "firmware-tests"
        subprocess.run([
            *shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-Wall", "-Wextra",
            "-Werror", f"-DCONFIG_LINKR_BLE_BRIDGE_UART_RX_DROP_NO_CONN={drop}",
            "-I", str(directory), str(ROOT / "tests/firmware_harness.c"),
            "-o", str(cls.binary),
        ], check=True)

    def run_scenario(self, scenario):
        result = subprocess.run([str(self.binary), scenario], check=True,
                                capture_output=True, text=True, timeout=5)
        return [line.split("|") for line in result.stdout.splitlines()]

    def test_retry_keeps_target_payload_and_filename(self):
        first, retry = self.run_scenario("retry")
        self.assertEqual(first, retry)

    def test_retarget_discards_failed_batch(self):
        first, second = self.run_scenario("retarget")
        self.assertEqual(first[:2], ["old", "OLD_PRIVATE_LOG"])
        self.assertEqual(second[:2], ["new", "NEW_LOG"])
        self.assertNotEqual(first[2], second[2])

    def test_clear_and_reenable_same_url_discards_failed_batch(self):
        first, second = self.run_scenario("clear")
        self.assertEqual(first[:2], ["old", "OLD_PRIVATE_LOG"])
        self.assertEqual(second[:2], ["old", "NEW_LOG"])

    def test_default_firmware_keeps_lan_and_logs_flowing_after_ble_disconnect(self):
        self.run_scenario("forward")


class TerminalTests(unittest.IsolatedAsyncioTestCase):
    async def exercise_terminal(self, loopback=False, fail_loopback=False):
        # Import the real CLI with only its hardware dependency replaced.
        spec = importlib.util.spec_from_file_location(
            "linkr_terminal_test", ROOT / "tools/linkr_ble_terminal.py")
        terminal = importlib.util.module_from_spec(spec)
        bleak = types.ModuleType("bleak")
        bleak.BleakClient = bleak.BleakScanner = object
        with patch.dict(sys.modules, {"bleak": bleak, spec.name: terminal}):
            spec.loader.exec_module(terminal)

        queued = []
        original_put = asyncio.Queue.put_nowait

        def record_put(queue, item):
            queued.append(item)
            original_put(queue, item)

        class Client:
            address = "test-device"

            def __init__(self, *args, **kwargs):
                self.sequence = 1
                self.callback = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def read_gatt_char(self, uuid):
                if uuid == terminal.MGMT_PROTOCOL_UUID:
                    caps = terminal.MGMT_CAP_DEVICE_ID | terminal.MGMT_CAP_RELIABLE_UART
                    return bytes([1, 0]) + (512).to_bytes(2, "little") + caps.to_bytes(4, "little") + b"\0\0"
                if uuid == terminal.MGMT_DEVICE_ID_UUID:
                    return bytes(16)
                return bytes([1, 0]) + (232).to_bytes(2, "little") + (1).to_bytes(4, "little") * 2 + bytes(4)

            def notify(self, data):
                frame = terminal.RELIABLE_UART_HEADER.pack(
                    b"LR", 1, 0, self.sequence, len(data), 0) + data
                self.sequence += 1
                self.callback(None, bytearray(frame))

            async def start_notify(self, uuid, callback):
                if uuid == terminal.RELIABLE_UART_TX_UUID:
                    self.callback = callback
                    self.notify(b"boot")

            async def stop_notify(self, uuid):
                pass

        async def fake_loopback(client, payload, cfg, queue, timeout, reliable):
            client.notify(payload)
            self.assertEqual(await queue.get(), payload)
            client.notify(b"leftover")
            if fail_loopback:
                raise RuntimeError("injected loopback failure")
            return True

        async def fake_terminal(client, cfg, reliable):
            for _ in range(1000):
                client.notify(b"output")

        client = Client()
        args = terminal.build_parser().parse_args(
            ["--loopback-test", "echo"] if loopback else [])
        output = io.BytesIO()
        with patch.object(terminal, "BleakClient", return_value=client), \
             patch.object(terminal, "find_device", AsyncMock(return_value="device")), \
             patch.object(terminal, "configure_ble_write_size"), \
             patch.object(terminal, "loopback_test", fake_loopback), \
             patch.object(terminal, "terminal_loop", fake_terminal), \
             patch.object(terminal, "stderr"), \
             patch.object(terminal.sys, "stdout", types.SimpleNamespace(buffer=output)), \
             patch.object(asyncio.Queue, "put_nowait", record_put):
            if fail_loopback:
                with self.assertRaisesRegex(RuntimeError, "injected"):
                    await terminal.run(args)
                # Callback still exists: even error cleanup must stop queuing.
                client.notify(b"after failure")
            else:
                await terminal.run(args)

        self.assertEqual(queued, [b"echo", b"leftover"] if loopback else [])
        if not fail_loopback:
            self.assertTrue(output.getvalue().endswith(b"output" * 1000))

    async def test_normal_terminal_does_not_queue_received_bytes(self):
        await self.exercise_terminal()

    async def test_loopback_queue_is_disabled_before_terminal_starts(self):
        await self.exercise_terminal(loopback=True)

    async def test_loopback_queue_is_disabled_on_failure(self):
        await self.exercise_terminal(loopback=True, fail_loopback=True)


if __name__ == "__main__":
    unittest.main()
