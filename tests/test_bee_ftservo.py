"""Host tests for tools/bee_ftservo (the Bee <-> FEETECH servo bridge).

Run with: python3 -m unittest discover -s tests -v

The transport tests need nothing but the standard library.  The FTServo
integration tests use the official ``ftservo-python-sdk``; they skip when it is
not installed, so a normal checkout still passes without network access.
"""

import contextlib
import importlib.util
import io
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL_DIR = ROOT / "tools" / "bee_ftservo"
sys.path.insert(0, str(TOOL_DIR))

import bee_ftservo as bee  # noqa: E402

HAVE_SDK = importlib.util.find_spec("scservo_sdk") is not None
needs_sdk = unittest.skipUnless(HAVE_SDK, "ftservo-python-sdk is not installed")


def open_sim(echo=True, ids=(1,), chunk=0, timeout_ms=120):
    sim = bee.SimulatedBee(ids=ids, echo=echo, chunk=chunk)
    handler, packet = bee.open_packet_handler(
        sim, baud=bee.DEFAULT_BAUD, reply_timeout_ms=timeout_ms, echo=True
    )
    return sim, handler, packet


class PacketHelperTests(unittest.TestCase):
    def test_ping_packet_matches_the_protocol(self):
        self.assertEqual(bee.make_packet(1, 1), b"\xff\xff\x01\x02\x01\xfb")

    def test_find_status_ignores_bad_checksums(self):
        good = b"\xff\xff\x01\x02\x00\xfc"
        broken = b"\xff\xff\x01\x02\x00\xfd"
        self.assertIsNotNone(bee.find_status(good))
        self.assertIsNone(bee.find_status(broken))

    def test_find_status_filters_by_id(self):
        frame = b"\xff\xff\x02\x02\x00\xfb"
        self.assertIsNone(bee.find_status(frame, 1))
        self.assertIsNotNone(bee.find_status(frame, 2))

    def test_parse_ids_accepts_ranges_and_lists(self):
        self.assertEqual(bee.parse_ids("1-3,5"), [1, 2, 3, 5])


def drain(serial, wanted, timeout=2.0):
    """Read until `wanted` bytes arrived (the SDK reads incrementally, so a
    single read may return only part of one BLE notification)."""
    deadline = time.monotonic() + timeout
    data = bytearray()
    while len(data) < wanted and time.monotonic() < deadline:
        chunk = serial.read(64)
        if chunk:
            data += chunk
    return bytes(data)


class EchoFilterTests(unittest.TestCase):
    def test_drops_echo_and_keeps_the_status_packet(self):
        response = b"\xff\xff\x01\x02\x00\xfc"
        sim, handler, _packet = open_sim(echo=True)
        serial = handler.ser
        serial.reset_input_buffer()
        serial.write(bee.make_packet(1, 1))
        self.assertEqual(drain(serial, len(response)), response)
        handler.closePort()

    def test_drops_echo_split_across_notifications(self):
        response = b"\xff\xff\x01\x02\x00\xfc"
        sim, handler, _packet = open_sim(echo=True, chunk=3)
        serial = handler.ser
        serial.reset_input_buffer()
        serial.write(bee.make_packet(1, 1))
        self.assertEqual(drain(serial, len(response)), response)
        handler.closePort()

    def test_direction_controlled_adapter_keeps_every_byte(self):
        # No echo: the first status bytes equal the request's, so the filter
        # must release its held prefix instead of eating the answer.
        response = b"\xff\xff\x01\x02\x00\xfc"
        sim, handler, _packet = open_sim(echo=False)
        serial = handler.ser
        serial.reset_input_buffer()
        serial.write(bee.make_packet(1, 1))
        self.assertEqual(drain(serial, len(response)), response)
        handler.closePort()

    def test_mismatch_releases_held_prefix(self):
        link = _ScriptedLink()
        serial = bee.ServoSerial(link, echo=True)
        serial.write(b"\xff\x00\x01\x02")
        link.queue(b"\xff\xaa\xbb")
        self.assertEqual(serial.read(64), b"\xff\xaa\xbb")

    def test_reset_drops_a_pending_echo(self):
        link = _ScriptedLink()
        serial = bee.ServoSerial(link, echo=True)
        serial.write(b"\xff\xff\x01\x02")
        link.queue(b"\xff\xff\x01")
        self.assertEqual(serial.read(8), b"")
        serial.reset_input_buffer()
        link.queue(b"\xff\xff\x02\x02\x00\xfb")
        self.assertEqual(serial.read(8), b"\xff\xff\x02\x02\x00\xfb")


class _ScriptedLink:
    """Minimal byte link: queued inputs, writes are recorded."""

    def __init__(self):
        self.written = bytearray()
        self.queued = []

    def queue(self, data):
        self.queued.append(data)

    def write(self, data):
        self.written += data

    def read(self, max_len=4096, timeout=0.01):
        if not self.queued:
            return b""
        return self.queued.pop(0)

    def reset_input(self):
        self.queued.clear()

    def in_waiting(self):
        return len(self.queued)


@needs_sdk
class SdkIntegrationTests(unittest.TestCase):
    def test_ping_and_model(self):
        sim, handler, packet = open_sim(echo=True)
        model, comm, error = packet.ping(1)
        handler.closePort()
        self.assertEqual(comm, 0)
        self.assertEqual(model, 777)

    def test_read_and_write_position(self):
        sim, handler, packet = open_sim(echo=True)
        packet.WritePosEx(1, 1500, 1000, 30)
        position, comm, _error = packet.ReadPos(1)
        handler.closePort()
        self.assertEqual(comm, 0)
        self.assertEqual(position, 1500)

    def test_sync_write_two_servos(self):
        sim, handler, packet = open_sim(echo=True, ids=(1, 2))
        packet.SyncWritePosEx(1, 2000, 1000, 50)
        packet.SyncWritePosEx(2, 500, 1000, 50)
        self.assertEqual(packet.groupSyncWrite.txPacket(), 0)
        packet.groupSyncWrite.clearParam()
        pos1, comm1, _ = packet.ReadPos(1)
        pos2, comm2, _ = packet.ReadPos(2)
        handler.closePort()
        self.assertEqual((comm1, comm2), (0, 0))
        self.assertEqual((pos1, pos2), (2000, 500))

    def test_reply_timeout_floor_beats_the_sdk_default(self):
        sim, handler, packet = open_sim(echo=True, timeout_ms=250)
        handler.setPacketTimeout(6)
        timeout = handler.packet_timeout
        handler.closePort()
        self.assertGreaterEqual(timeout, 250.0)

    def test_missing_servo_times_out(self):
        sim, handler, packet = open_sim(echo=True, timeout_ms=60)
        _model, comm, _error = packet.ping(9)
        handler.closePort()
        self.assertNotEqual(comm, 0)


class CliTests(unittest.TestCase):
    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = bee.main(list(argv))
        return code, out.getvalue()

    def test_scan_finds_the_simulated_ids(self):
        code, output = self.run_cli(
            "--simulate", "--sim-ids", "1,2", "scan", "--ids", "1-3"
        )
        self.assertEqual(code, 0)
        self.assertIn("[ID:001]", output)
        self.assertIn("[ID:002]", output)
        self.assertNotIn("[ID:003]", output)

    def test_move_reports_success(self):
        code, output = self.run_cli(
            "--simulate", "move", "1", "1234", "--speed", "800"
        )
        self.assertEqual(code, 0, output)
        self.assertIn("Communication success", output)

    def test_status_reports_telemetry(self):
        code, output = self.run_cli("--simulate", "status", "1")
        self.assertEqual(code, 0, output)
        self.assertIn("position=2048", output)
        self.assertIn("voltage=12.0", output)

    def test_raw_sends_and_prints_the_reply(self):
        code, output = self.run_cli(
            "--simulate", "raw", "ff", "ff", "01", "02", "01", "fb"
        )
        self.assertEqual(code, 0, output)
        self.assertIn("rx: ff ff 01 02 00 fc", output)

    def test_raw_echo_off_shows_the_wire_echo(self):
        code, output = self.run_cli(
            "--simulate", "--echo", "off", "raw",
            "ff", "ff", "01", "02", "01", "fb",
        )
        self.assertEqual(code, 0, output)
        self.assertIn(
            "rx: ff ff 01 02 01 fb ff ff 01 02 00 fc", output
        )

    def test_sim_no_echo_adapter_is_also_supported(self):
        code, output = self.run_cli(
            "--simulate", "--sim-no-echo", "raw",
            "ff", "ff", "01", "02", "01", "fb",
        )
        self.assertEqual(code, 0, output)
        self.assertIn("rx: ff ff 01 02 00 fc", output)

    def test_selftest_passes(self):
        code, output = self.run_cli("--simulate", "selftest")
        self.assertEqual(code, 0, output)
        self.assertNotIn("FAIL", output)


if __name__ == "__main__":
    unittest.main()
