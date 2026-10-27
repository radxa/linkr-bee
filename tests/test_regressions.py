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


def extract(source, start_marker, end_marker, required, include_end=False):
    """Slice a production block by literal anchors.

    A moved anchor should fail loudly rather than quietly compile a different
    function, so the intended definitions are asserted to be inside the block.
    Truncation itself cannot pass unnoticed: the harness compiles with -Werror.
    Set include_end when the end anchor is a preprocessor line that balances a
    conditional opened inside the block.
    """
    start = source.index(start_marker)
    stop = source.index(end_marker, start)
    if include_end:
        stop += len(end_marker)
    block = source[start:stop]
    for name in required:
        if f"{name}(" not in block:
            raise AssertionError(f"{name} is missing from the extracted block")
    return block


class FirmwareTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-regressions-")
        cls.addClassCleanup(cls.tmp.cleanup)
        directory = Path(cls.tmp.name)
        # Compile the actual production function bodies against deterministic
        # host fakes, so the tests exercise retry control flow without a board.
        wifi = (ROOT / "src/wifi.c").read_text()
        # The WebDAV setters are what publish a new URL + generation and clear
        # the ring. Without them compiled in, the retarget scenarios could only
        # simulate that transition and would pass with a broken setter.
        setters = extract(wifi, "static void discard_log_buffer(void)", "\n/* ---",
                          ["discard_log_buffer", "linkr_webdav_set_config",
                           "linkr_webdav_clear_config"])
        upload = extract(wifi, "static void upload_thread(void *a", "\n/* ---",
                         ["upload_thread"])
        main = (ROOT / "src/main.c").read_text()
        forward = extract(main, "static int uart_forward_chunk(",
                          "\n#endif /* CONFIG_LINKR_BLE_BRIDGE_BLE_TX_DECOUPLE */\n}",
                          ["uart_forward_chunk"], include_end=True)
        (directory / "production_functions.inc").write_text(setters + upload + forward)
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

    def test_retarget_published_before_ring_clear_never_uploads_old_logs(self):
        first, retry = self.run_scenario("retarget_handoff")
        self.assertEqual(first[:2], ["new", "NEW_LOG"])
        self.assertEqual(first, retry)

    def test_default_firmware_keeps_lan_and_logs_flowing_after_ble_disconnect(self):
        # The exit code alone would pass even if a chunk were dropped from, or
        # duplicated into, the LAN or log sink, so assert the counts the
        # firmware reports: 100 idle chunks reach both, a connected peer's
        # transient failure feeds neither, and the retry feeds both once more.
        (summary,) = self.run_scenario("forward")
        self.assertEqual(summary, ["forward", "101", "101"])

    def test_webdav_setters_reject_before_mutating_and_publish_atomically(self):
        """The production setters, not a simulation of them."""
        (summary,) = self.run_scenario("setters")
        self.assertEqual(summary[0], "SETTERS")
        checks = dict(field.split("=", 1) for field in summary[1:])
        for name in ["creds_rejected", "url_rejected", "untouched", "retarget",
                     "noop", "save_failure", "cleared"]:
            self.assertEqual(checks.get(name), "1", f"{name} failed: {checks}")


class TerminalTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def load_terminal():
        """Import the real CLI with only its hardware dependency replaced."""
        spec = importlib.util.spec_from_file_location(
            "linkr_terminal_test", ROOT / "tools/linkr_ble_terminal.py")
        terminal = importlib.util.module_from_spec(spec)
        bleak = types.ModuleType("bleak")
        bleak.BleakClient = bleak.BleakScanner = object
        with patch.dict(sys.modules, {"bleak": bleak, spec.name: terminal}):
            spec.loader.exec_module(terminal)
        return terminal

    async def test_real_loopback_test_verifies_the_echoed_payload(self):
        """The production loopback_test, not the stub the other tests install."""
        terminal = self.load_terminal()
        cfg = terminal.TerminalConfig(
            escape=b"\x1d", enter="cr", local_echo=False, line_mode=False,
            debug_io=False, write_size=20, write_response=True, write_delay=0.0)
        payload = b"linkr-loopback-test"

        async def run(echo, stale=(), split=False):
            queue: asyncio.Queue = asyncio.Queue()
            for item in stale:
                queue.put_nowait(item)

            class Client:
                def __init__(self):
                    self.chunks = []

                async def write_gatt_char(self, uuid, chunk, response=True):
                    self.chunks.append(bytes(chunk))
                    if echo is None:
                        return
                    if split:
                        queue.put_nowait(echo[:4])
                        queue.put_nowait(echo[4:])
                    else:
                        queue.put_nowait(echo)

            client = Client()
            with patch.object(terminal, "stderr"):
                result = await terminal.loopback_test(
                    client, payload, cfg, queue, timeout=0.25)
            return result, client, queue

        # Stale bytes left over from boot output are drained, then the echo matches.
        ok, client, _ = await run(payload, stale=(b"stale", b"boot log"))
        self.assertTrue(ok)
        # The payload is written in write_size chunks.
        self.assertTrue(client.chunks)
        self.assertTrue(all(len(chunk) <= cfg.write_size for chunk in client.chunks))
        self.assertEqual(b"".join(client.chunks), payload)

        # An echo split across notifications still matches.
        ok, _, _ = await run(payload, split=True)
        self.assertTrue(ok)

        # Silence, and an echo that never contains the payload, must both fail.
        ok, _, _ = await run(None)
        self.assertFalse(ok)
        ok, _, _ = await run(b"unrelated output")
        self.assertFalse(ok)

    async def exercise_terminal(self, loopback=False, fail_loopback=False):
        terminal = self.load_terminal()

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
                    # A Device ID as a Linkr board reports it: the fixed
                    # namespace, then the chip's hardware id.
                    return b"LINKRBLE\x01\x00" + bytes(6)
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

        async def fake_terminal(client, cfg, reliable=None, geometry=None):
            # Signature tracks terminal_loop(); geometry stays None here because
            # these tests do not run on a tty.
            self.assertIsNone(geometry)
            for _ in range(1000):
                client.notify(b"output")

        client = Client()
        args = terminal.build_parser().parse_args(
            ["--loopback-test", "echo"] if loopback else [])
        output = io.BytesIO()
        # terminal_loop() reads the process stdin, which needs a pty to drive, so
        # it is stubbed here; these tests are about run()'s notify-queue
        # lifecycle. loopback_test() is covered for real by
        # test_real_loopback_test_verifies_the_echoed_payload.
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
