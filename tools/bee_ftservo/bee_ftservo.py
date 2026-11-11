#!/usr/bin/env python3
"""Use a Linkr Bee as a wireless FEETECH bus-servo adapter.

The Bee is a BLE serial bridge: bytes written to its Nordic UART Service
characteristic leave on the target UART, and bytes arriving on that UART come
back as notifications.  That is exactly the byte pipe the official
``ftservo-python-sdk`` (FTServo_Python) expects from a USB-TTL adapter, so a
servo bus wired to the Bee's J7 header can be driven from a laptop with no USB
cable to the robot.

Two things in the path are not plain serial, and this module handles both:

* **Latency.**  A BLE round trip costs one connection interval, while FTServo
  gives a reply 50 ms by default.  ``make_port_handler()`` raises the floor to
  250 ms (``--timeout``).
* **Half duplex.**  FEETECH servos share one signal wire between TX and RX, so
  a Bee with TX and RX tied to that wire hears its own transmission before the
  servo answers.  FTServo would parse that echo as the status packet.
  ``ServoSerial`` drops the echoed bytes it can prove are its own request, and
  works for direction-controlled adapters (no echo) too.

``--simulate`` replaces the Bee with an in-process servo bus, so the transport
and the whole CLI can be exercised without hardware.
"""

from __future__ import annotations

import argparse
import asyncio
import struct
import sys
import threading
import time
from collections import deque

# --- Linkr BLE interface ----------------------------------------------------

NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # host -> target
NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # target -> host
MGMT_SERVICE_UUID = "4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_PROTOCOL_UUID = "4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_DEVICE_ID_UUID = "4c4b0003-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_COMMAND_UUID = "4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_RESPONSE_UUID = "4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001"

MGMT_HEADER = struct.Struct("<2sBBIHH")
MGMT_API_MAJOR = 1
MGMT_CAP_MULTI_SESSION = 1 << 7
MGMT_TYPE_REQUEST = 1
MGMT_TYPE_RESPONSE = 2
MGMT_TYPE_EVENT = 3
MGMT_FLAG_ERROR = 1 << 1

DEFAULT_BAUD = 1000000  # FTServo's default; STS3215 ships at 1 Mbaud
DEFAULT_NAME = "Linkr Bee"
MAX_BAUD = 3000000  # src/main.c parse_uart_line() rejects more
MIN_BAUD = 300


class BeeError(RuntimeError):
    """A link, control-command or servo-bus error worth showing the user."""


# --- The serial facade FTServo talks to -------------------------------------


class ServoSerial:
    """A pyserial-like object over a byte link, with request-echo suppession.

    ``ftservo-python-sdk`` only needs ``read``, ``write``, ``in_waiting``,
    ``reset_input_buffer`` and ``close``.  With a half-duplex wiring the Bee's
    RX line sees every byte the Bee transmits, so the host receives its own
    request immediately before the servo's answer.  The SDK would treat that
    request as a status packet (its checksum is valid) and return nonsense.

    After each write the exact request bytes are remembered.  Incoming bytes
    are matched against that prefix: a full match is the echo and is dropped,
    a mismatch means there is no echo (a direction-controlled adapter) and the
    held bytes are released unchanged.  A response can share at most its first
    four bytes with a request (header, ID and length), so a no-echo answer is
    delayed by one BLE notification at worst.
    """

    def __init__(self, link, echo: bool = True, poll_timeout: float = 0.01):
        self.link = link
        self.echo = echo
        self.poll_timeout = poll_timeout
        self._rx = bytearray()
        self._echo_expected = None
        self._echo_seen = bytearray()
        self._closed = False
        self._lock = threading.RLock()

    # -- pyserial surface used by scservo_sdk.PortHandler --
    def write(self, packet) -> int:
        data = bytes(packet)
        if not data:
            return 0
        with self._lock:
            if self._closed:
                raise BeeError("servo serial port is closed")
            self._echo_expected = data if self.echo else None
            self._echo_seen = bytearray()
        self.link.write(data)
        return len(data)

    def read(self, length: int) -> bytes:
        if length <= 0:
            return b""
        with self._lock:
            while not self._rx:
                if self._closed:
                    return b""
                try:
                    chunk = self.link.read(4096, self.poll_timeout)
                except BeeError:
                    raise
                if not chunk:
                    return b""
                self._absorb(chunk)
            data = bytes(self._rx[:length])
            del self._rx[:length]
            return data

    @property
    def in_waiting(self) -> int:
        with self._lock:
            return len(self._rx)

    def reset_input_buffer(self) -> None:
        self.link.reset_input()
        with self._lock:
            self._rx.clear()
            self._echo_expected = None
            self._echo_seen = bytearray()

    def close(self) -> None:
        self._closed = True

    # -- echo filter --
    def _absorb(self, chunk: bytes) -> None:
        if self._echo_expected is None:
            self._rx += chunk
            return
        index = 0
        while index < len(chunk):
            expected = self._echo_expected
            if expected is None:
                self._rx += chunk[index:]
                return
            if chunk[index] == expected[len(self._echo_seen)]:
                self._echo_seen.append(chunk[index])
                index += 1
                if len(self._echo_seen) == len(expected):
                    self._echo_expected = None
                    self._echo_seen = bytearray()
            else:
                # Not our own transmission: release the held prefix and the
                # rest of this notification as data.
                self._rx += self._echo_seen
                self._rx += chunk[index:]
                self._echo_expected = None
                self._echo_seen = bytearray()
                return


# --- A simulated bus, for --simulate and the unit tests ---------------------


class _SimServo:
    """Register file of one emulated STS/SMS servo (subset the CLI touches)."""

    def __init__(self, scs_id: int, model: int = 777):
        self.scs_id = scs_id
        self.reg = bytearray(256)
        self.reg[3] = model & 0xFF
        self.reg[4] = (model >> 8) & 0xFF
        self.reg[5] = scs_id
        self.reg[6] = 0  # 1 Mbaud
        self.set_word(42, 2048)  # goal position
        self.set_word(56, 2048)  # present position
        self.reg[62] = 120  # 12.0 V
        self.reg[63] = 35  # 35 degC

    def set_word(self, address: int, value: int) -> None:
        self.reg[address] = value & 0xFF
        self.reg[address + 1] = (value >> 8) & 0xFF

    def get_word(self, address: int) -> int:
        return self.reg[address] | (self.reg[address + 1] << 8)

    def write(self, address: int, data: bytes) -> None:
        self.reg[address:address + len(data)] = data
        # The emulator snaps to the goal, so ReadPos reflects WritePosEx.
        if address <= 43 < address + len(data) or address <= 42 < address + len(data):
            self.set_word(56, self.get_word(42))
            self.reg[66] = 1


class _SimBus:
    """FEETECH packet parser/responder plus the half-duplex echo."""

    def __init__(self, ids=(1,), model=777, echo=True, chunk=0):
        self.servos = {scs_id: _SimServo(scs_id, model) for scs_id in ids}
        self.echo = echo
        self.chunk = max(0, chunk)
        self.partial = bytearray()
        self.out = deque()

    def receive(self, data: bytes) -> None:
        self._queue(bytes(data) if self.echo else b"")
        for response in self._handle(data):
            self._queue(response)

    def _queue(self, data: bytes) -> None:
        if not data:
            return
        if self.chunk:
            for start in range(0, len(data), self.chunk):
                self.out.append(data[start:start + self.chunk])
        else:
            self.out.append(data)

    def read(self, max_len: int) -> bytes:
        if not self.out:
            return b""
        data = self.out.popleft()
        return data[:max_len]

    def pending(self) -> int:
        return sum(len(item) for item in self.out)

    def _handle(self, data: bytes) -> list:
        self.partial += data
        responses = []
        while len(self.partial) >= 4:
            if self.partial[0] != 0xFF or self.partial[1] != 0xFF:
                del self.partial[0]
                continue
            total = self.partial[3] + 4
            if len(self.partial) < total:
                break
            frame = bytes(self.partial[:total])
            del self.partial[:total]
            if _checksum_ok(frame):
                responses.extend(self._dispatch(frame))
        return responses

    def _dispatch(self, frame: bytes) -> list:
        scs_id = frame[2]
        instruction = frame[4]
        params = frame[5:-1]
        if instruction == 1:  # PING
            return [self._status(scs_id)]
        if instruction == 2 and len(params) >= 2:  # READ
            servo = self.servos.get(scs_id)
            if servo is None:
                return []
            address, length = params[0], params[1]
            return [self._status(scs_id, data=bytes(servo.reg[address:address + length]))]
        if instruction == 3 and len(params) >= 1:  # WRITE
            servo = self.servos.get(scs_id)
            if servo is None:
                return []
            servo.write(params[0], bytes(params[1:]))
            return [self._status(scs_id)] if scs_id != 0xFE else []
        if instruction == 4 and len(params) >= 1:  # REG WRITE
            return [self._status(scs_id)] if scs_id in self.servos else []
        if instruction == 5:  # ACTION
            return []
        if instruction == 0x83 and len(params) >= 2:  # SYNC WRITE
            address, length = params[0], params[1]
            block = params[2:]
            for offset in range(0, len(block) - length - 1 + 1, length + 1):
                scs_id = block[offset]
                servo = self.servos.get(scs_id)
                if servo is not None:
                    servo.write(address, bytes(block[offset + 1:offset + 1 + length]))
            return []
        return []

    def _status(self, scs_id: int, error: int = 0, data: bytes = b"") -> bytes:
        if scs_id == 0xFE or scs_id not in self.servos:
            return b""
        body = bytes([scs_id, 2 + len(data), error]) + data
        checksum = ~sum(body) & 0xFF
        return b"\xff\xff" + body + bytes([checksum])


class SimulatedBee:
    """A BeeLink stand-in: the management commands the CLI needs plus a bus."""

    capabilities = MGMT_CAP_MULTI_SESSION
    api_version = (1, 0)

    def __init__(self, ids=(1,), model=777, echo=True, chunk=0, name="Bee sim"):
        self.bus = _SimBus(ids=ids, model=model, echo=echo, chunk=chunk)
        self.name = name
        self.address = "sim"
        self.uart_spec = f"{DEFAULT_BAUD},8,n,1,none"
        self._locked = threading.Lock()

    def open(self):
        return self

    def close(self):
        pass

    def write(self, data: bytes) -> None:
        with self._locked:
            self.bus.receive(bytes(data))

    def read(self, max_len: int = 4096, timeout: float = 0.01) -> bytes:
        return self.bus.read(max_len)

    def reset_input(self) -> None:
        with self._locked:
            self.bus.out.clear()
            self.bus.partial.clear()

    @property
    def in_waiting(self) -> int:
        return self.bus.pending()

    def command(self, text: str, timeout: float = 5.0) -> str:
        text = text.strip()
        if text.startswith("@u="):
            self.uart_spec = text[3:]
            return f"OK uart={self.uart_spec}\r\n"
        if text == "@u?":
            return f"OK uart={self.uart_spec}\r\n"
        if text == "@n?":
            return f"OK name={self.name}\r\n"
        if text == "@c?":
            return "OK control self=1 owner=0 mode=available epoch=1\r\n"
        if text in ("@c claim", "@linkr control claim"):
            return "OK control self=1 owner=1 mode=control epoch=2\r\n"
        if text in ("@c release", "@linkr control release"):
            return "OK control self=1 owner=0 mode=available epoch=3\r\n"
        if text in ("@i?", "@linkr info?"):
            return "OK info uart=0 dropped=0\r\n"
        raise BeeError(f"simulated bee does not implement {text!r}")


def _checksum_ok(frame: bytes) -> bool:
    checksum = ~sum(frame[2:-1]) & 0xFF
    return frame[-1] == checksum


# --- The real Bee: bleak transport plus the management channel --------------


class BeeLink:
    """Raw NUS byte pipe and Management v1 control channel to one Linkr Bee."""

    def __init__(self, address=None, name=DEFAULT_NAME, scan_timeout=6.0,
                 write_size=20, write_response=False, command_timeout=5.0):
        self.address = address
        self.name = name
        self.scan_timeout = scan_timeout
        self.write_size = max(20, min(int(write_size or 20), 244))
        self.write_response = write_response
        self.command_timeout = command_timeout
        self.api_version = (0, 0)
        self.capabilities = 0
        self.device_id = b""
        self.name_reported = None

        self._loop = None
        self._thread = None
        self._ready = threading.Event()
        self._connect_error = None
        self._client = None
        self._rx = bytearray()
        self._cond = threading.Condition()
        self._closed = False
        self._mgmt_pending = {}
        self._mgmt_partial = None
        self._request_id = 0

    # -- lifecycle --
    def open(self) -> "BeeLink":
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run, name="bee-ftservo-link", daemon=True
        )
        self._thread.start()
        if not self._ready.wait(self.scan_timeout + 15.0):
            # Do not leave the connect coroutine running in the background.
            self._closed = True
            try:
                self._loop.call_soon_threadsafe(self._loop.stop)
            except RuntimeError:
                pass
            raise BeeError("timed out connecting to the Bee")
        if self._connect_error is not None:
            raise BeeError(str(self._connect_error))
        return self

    def close(self) -> None:
        if self._loop is None or self._thread is None:
            return
        self._closed = True
        with self._cond:
            self._cond.notify_all()
        try:
            if self._client is not None:
                future = asyncio.run_coroutine_threadsafe(
                    self._client.disconnect(), self._loop
                )
                future.result(3.0)
        except Exception:
            pass
        try:
            self._loop.call_soon_threadsafe(self._loop.stop)
        except RuntimeError:
            pass
        self._thread.join(3.0)

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._connect())
        except Exception as exc:  # surfaced by open()
            self._connect_error = exc
            self._ready.set()
            return
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            self._loop.close()

    async def _connect(self) -> None:
        from bleak import BleakClient

        target = await self._resolve_target()
        self._client = BleakClient(
            target, disconnected_callback=self._on_disconnect
        )
        await self._client.connect()
        await self._client.start_notify(NUS_TX_UUID, self._on_uart_notify)
        await self._client.start_notify(MGMT_RESPONSE_UUID, self._on_mgmt_notify)
        protocol = bytes(await self._client.read_gatt_char(MGMT_PROTOCOL_UUID))
        if len(protocol) < 8 or protocol[0] != MGMT_API_MAJOR:
            raise BeeError("unsupported Linkr Management API")
        self.api_version = (protocol[0], protocol[1])
        self.capabilities = int.from_bytes(protocol[4:8], "little")
        self.device_id = bytes(
            await self._client.read_gatt_char(MGMT_DEVICE_ID_UUID)
        )
        self.address = getattr(target, "address", target)

    async def _resolve_target(self):
        if self.address:
            return self.address
        from bleak import BleakScanner

        devices = await BleakScanner.discover(timeout=self.scan_timeout)
        candidates = []
        for device in devices:
            name = device.name or ""
            if self.name and name.startswith(self.name):
                return device
            metadata = getattr(device, "metadata", None) or {}
            uuids = [str(uuid).lower() for uuid in metadata.get("uuids", [])]
            if MGMT_SERVICE_UUID in uuids:
                candidates.append(device)
        if candidates:
            return candidates[0]
        raise BeeError(
            "no Linkr Bee found; pass --address or --name "
            "(npx linkr-bee-cli --scan lists nearby boards)"
        )

    def _on_disconnect(self, _client) -> None:
        self._closed = True
        with self._cond:
            self._cond.notify_all()

    # -- raw UART byte pipe --
    def _on_uart_notify(self, _char, data: bytearray) -> None:
        with self._cond:
            self._rx += bytes(data)
            self._cond.notify_all()

    def read(self, max_len: int = 4096, timeout: float = 0.01) -> bytes:
        deadline = time.monotonic() + timeout
        with self._cond:
            while not self._rx:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(remaining)
            if not self._rx:
                if self._closed:
                    raise BeeError("the Bee disconnected")
                return b""
            data = bytes(self._rx[:max_len])
            del self._rx[:max_len]
            return data

    def reset_input(self) -> None:
        with self._cond:
            self._rx.clear()

    @property
    def in_waiting(self) -> int:
        with self._cond:
            return len(self._rx)

    def write(self, data: bytes) -> None:
        data = bytes(data)
        if not data:
            return
        if self._client is None:
            raise BeeError("the Bee is not connected")
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._write_chunks(data), self._loop
            )
        except RuntimeError as exc:
            raise BeeError(f"the Bee link is closed: {exc}") from exc
        future.result(self.command_timeout)

    async def _write_chunks(self, data: bytes) -> None:
        for start in range(0, len(data), self.write_size):
            chunk = data[start:start + self.write_size]
            await self._client.write_gatt_char(
                NUS_RX_UUID, chunk, response=self.write_response
            )

    # -- Management v1 --
    def command(self, text: str, timeout: float = None) -> str:
        return self.command_bytes(text.encode(), timeout)

    def command_bytes(self, payload: bytes, timeout: float = None) -> str:
        payload = bytes(payload)
        if not payload:
            raise ValueError("empty management command")
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._send_mgmt(payload), self._loop
            )
        except RuntimeError as exc:
            raise BeeError(f"the Bee link is closed: {exc}") from exc
        try:
            body = future.result(timeout or self.command_timeout)
        except asyncio.TimeoutError as exc:
            raise BeeError(
                "the Bee did not answer a management command"
            ) from exc
        return body.decode("utf-8", "replace")

    async def _send_mgmt(self, payload: bytes) -> bytes:
        self._request_id = (self._request_id % 0xFFFFFFFF) + 1
        request_id = self._request_id
        frame = MGMT_HEADER.pack(
            b"LK", MGMT_API_MAJOR, MGMT_TYPE_REQUEST, request_id,
            len(payload), 0
        ) + payload
        future = self._loop.create_future()
        self._mgmt_pending[request_id] = future
        try:
            for start in range(0, len(frame), max(20, self.write_size)):
                chunk = frame[start:start + max(20, self.write_size)]
                await self._client.write_gatt_char(
                    MGMT_COMMAND_UUID, chunk, response=True
                )
            return await asyncio.wait_for(future, self.command_timeout)
        finally:
            self._mgmt_pending.pop(request_id, None)

    def _on_mgmt_notify(self, _char, data: bytearray) -> None:
        fragment = bytes(data)
        message = self._mgmt_partial
        if message is None:
            if len(fragment) < MGMT_HEADER.size or fragment[:2] != b"LK":
                return
            magic, version, message_type, request_id, expected, flags = \
                MGMT_HEADER.unpack_from(fragment)
            if magic != b"LK" or version != MGMT_API_MAJOR:
                return
            if message_type not in (MGMT_TYPE_RESPONSE, MGMT_TYPE_EVENT):
                return
            if expected == 0 or expected > 0xFFFF:
                return
            message = {
                "request_id": request_id,
                "expected": expected,
                "flags": flags,
                "type": message_type,
                "payload": bytearray(),
            }
            fragment = fragment[MGMT_HEADER.size:]

        payload = message["payload"]
        if len(payload) + len(fragment) > message["expected"]:
            self._mgmt_partial = None
            return
        payload.extend(fragment)
        if len(payload) < message["expected"]:
            self._mgmt_partial = message
            return

        self._mgmt_partial = None
        body = bytes(payload)
        future = self._mgmt_pending.get(message["request_id"])
        if future is None or future.done():
            return
        if message["type"] == MGMT_TYPE_EVENT:
            return
        if message["flags"] & MGMT_FLAG_ERROR:
            future.set_exception(BeeError(body.decode("utf-8", "replace")))
        else:
            future.set_result(body)


# --- FTServo integration ----------------------------------------------------


def make_port_handler(link, baud=DEFAULT_BAUD, reply_timeout_ms=250.0,
                      echo=True):
    """Return a scservo_sdk PortHandler whose serial port is the Bee link.

    Usage matches the stock examples::

        handler = make_port_handler(link)
        handler.openPort()
        packet = sms_sts(handler)
    """
    try:
        from scservo_sdk.port_handler import PortHandler
    except ImportError as exc:  # pragma: no cover - dependency hint
        raise BeeError(
            "ftservo-python-sdk is required: "
            "python3 -m pip install ftservo-python-sdk"
        ) from exc

    class BeePortHandler(PortHandler):
        def __init__(self):
            super().__init__("bee")
            self.link = link
            self.baudrate = baud
            self.min_packet_timeout_ms = float(reply_timeout_ms)
            self.echo = echo
            self.ser = None

        def openPort(self):
            self.ser = ServoSerial(self.link, echo=self.echo)
            self.is_open = True
            self.tx_time_per_byte = (1000.0 / self.baudrate) * 10.0
            return True

        def closePort(self):
            if self.ser is not None:
                self.ser.close()
            self.ser = None
            self.is_open = False

        def setBaudRate(self, baudrate):
            # The Bee's UART is programmed through its management channel
            # (--baud); this only records the value FTServo uses for timing.
            self.baudrate = baudrate
            self.tx_time_per_byte = (1000.0 / baudrate) * 10.0
            return True

        def getCFlagBaud(self, baudrate):
            return baudrate

        def setPacketTimeout(self, packet_length):
            super().setPacketTimeout(packet_length)
            self.packet_timeout = max(
                self.packet_timeout, self.min_packet_timeout_ms
            )

        def setPacketTimeoutMillis(self, msec):
            super().setPacketTimeoutMillis(msec)
            self.packet_timeout = max(
                self.packet_timeout, self.min_packet_timeout_ms
            )

    return BeePortHandler()


def open_packet_handler(link, baud=DEFAULT_BAUD, reply_timeout_ms=250.0,
                        echo=True):
    """Open a Bee port handler and wrap it in the sms_sts packet handler."""
    from scservo_sdk import sms_sts

    handler = make_port_handler(
        link, baud=baud, reply_timeout_ms=reply_timeout_ms, echo=echo
    )
    handler.openPort()
    return handler, sms_sts(handler)


# --- Servo packet helpers (independent of the SDK, used by scan/raw) --------


def make_packet(scs_id: int, instruction: int, params=b"") -> bytes:
    params = bytes(params)
    body = bytes([scs_id, len(params) + 2, instruction]) + params
    return b"\xff\xff" + body + bytes([~sum(body) & 0xFF])


def find_status(buf: bytes, scs_id: int = None):
    """Return the first checksum-valid status frame, optionally for one ID."""
    index = 0
    while index + 4 <= len(buf):
        if buf[index] != 0xFF or buf[index + 1] != 0xFF:
            index += 1
            continue
        total = buf[index + 3] + 4
        if index + total > len(buf):
            return None
        frame = buf[index:index + total]
        if _checksum_ok(frame) and (scs_id is None or frame[2] == scs_id):
            return frame
        index += 1
    return None


def exchange(serial, packet: bytes, timeout: float, scs_id=None) -> bytes:
    """Send one packet and collect bytes until a status frame or timeout."""
    serial.reset_input_buffer()
    serial.write(packet)
    received = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        chunk = serial.read(4096)
        if chunk:
            received += chunk
            frame = find_status(received, scs_id)
            if frame is not None and scs_id is not None:
                return bytes(received)
        else:
            time.sleep(0.002)
    return bytes(received)


# --- CLI --------------------------------------------------------------------


def parse_ids(text: str) -> list:
    ids = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            low, high = part.split("-", 1)
            ids.extend(range(int(low, 0), int(high, 0) + 1))
        else:
            ids.append(int(part, 0))
    return [scs_id for scs_id in ids if 0 <= scs_id <= 253]


def parse_hex_bytes(texts) -> bytes:
    raw = "".join(texts).replace(" ", "").replace(":", "").replace("0x", "")
    if len(raw) % 2:
        raise BeeError("hex must have an even number of digits")
    try:
        return bytes.fromhex(raw)
    except ValueError as exc:
        raise BeeError(f"not hex: {raw!r}") from exc


def hexdump(data: bytes) -> str:
    text = " ".join(f"{byte:02x}" for byte in data)
    if any(32 <= byte < 127 for byte in data):
        printable = "".join(chr(byte) if 32 <= byte < 127 else "." for byte in data)
        return f"{text}  |{printable}|"
    return text


def result_text(packet, comm) -> str:
    return packet.getTxRxResult(comm)


class Session:
    """An open Bee link, optionally owning console control, plus the SDH."""

    def __init__(self, args, configure=True):
        self.args = args
        self.link = None
        self.real = not args.simulate
        self.configure = configure
        self.claimed = False
        self.previous_uart = None
        self.handler = None
        self.packet = None

    def __enter__(self):
        args = self.args
        if args.simulate:
            ids = parse_ids(args.sim_ids) or [1]
            self.link = SimulatedBee(
                ids=ids, echo=not args.sim_no_echo, chunk=args.sim_chunk
            )
        else:
            self.link = BeeLink(
                address=args.address,
                name=args.name,
                scan_timeout=args.scan_timeout,
                write_size=args.ble_write_size,
                write_response=args.write_response,
            ).open()
            try:
                if self.configure:
                    self._claim_control()
                    self._configure_uart()
            except Exception:
                self.link.close()
                self.link = None
                raise
        return self

    def __exit__(self, *_exc):
        if self.handler is not None:
            try:
                self.handler.closePort()
            except Exception:
                pass
        if self.link is not None:
            if self.real and self.args.restore_uart and self.previous_uart:
                try:
                    self.link.command(f"@u={self.previous_uart}")
                except Exception:
                    pass
            if self.real and self.claimed and not self.args.keep_control:
                try:
                    self.link.command("@c release")
                except Exception:
                    pass
            self.link.close()
        return False

    # -- control/console ownership --
    def _claim_control(self):
        if self.args.no_claim:
            return
        if not self.link.capabilities & MGMT_CAP_MULTI_SESSION:
            return
        try:
            status = self.link.command("@c?")
        except BeeError:
            return
        fields = dict(
            item.split("=", 1) for item in status.split() if "=" in item
        )
        self_id = fields.get("self", "")
        owner = fields.get("owner", "0")
        if owner not in ("0", self_id, ""):
            log(f"console is owned by session {owner}; claiming control")
            try:
                self.link.command("@c claim")
                self.claimed = True
            except BeeError as exc:
                log(f"could not claim console control: {exc}")
                return
        else:
            self.claimed = True
        try:
            status = self.link.command("@c?")
        except BeeError:
            return
        fields = dict(
            item.split("=", 1) for item in status.split() if "=" in item
        )
        if fields.get("owner") not in (fields.get("self"), "0", ""):
            raise BeeError(
                "another client owns the Bee console; close the web/mobile "
                "terminal input or pass --no-claim and wait for the idle "
                "hand-over"
            )
        log(f"control: {status.strip()}")

    def _configure_uart(self):
        baud = self.args.baud
        if not MIN_BAUD <= baud <= MAX_BAUD:
            raise BeeError(
                f"baud must be between {MIN_BAUD} and {MAX_BAUD}"
            )
        spec = f"{baud},8,n,1,none"
        try:
            previous = self.link.command("@u?").strip()
            if previous.startswith("OK uart="):
                self.previous_uart = previous[len("OK uart="):]
        except BeeError:
            pass
        reply = self.link.command(f"@u={spec}").strip()
        log(f"bee uart <- {reply}")
        try:
            current = self.link.command("@u?").strip()
        except BeeError:
            current = ""
        if spec.lower() not in current.lower():
            raise BeeError(
                f"the Bee did not accept the UART setting ({current!r}); "
                "check that this firmware supports @u="
            )
        # Let the new baud settle and drop bytes queued before the switch.
        time.sleep(0.15)
        self.link.reset_input()
        deadline = time.monotonic() + 0.15
        while time.monotonic() < deadline:
            if not self.link.read(4096, 0.02):
                break

    # -- servo handler --
    def servo(self):
        if self.packet is None:
            self.handler, self.packet = open_packet_handler(
                self.link,
                baud=self.args.baud,
                reply_timeout_ms=self.args.timeout,
                echo=self.args.echo != "off",
            )
        return self.handler, self.packet


def log(message: str) -> None:
    print(f"bee-ftservo: {message}", file=sys.stderr, flush=True)


# -- commands --


def cmd_info(args):
    with Session(args, configure=False) as session:
        link = session.link
        print(f"link:      {link.address if session.real else 'simulated'}")
        if session.real:
            major, minor = link.api_version
            print(f"management API: v{major}.{minor}")
            print(f"capabilities:   0x{link.capabilities:08x}")
            print(f"device ID:      {link.device_id.hex()}")
        print(f"uart:      {link.command('@u?').strip()}")
        if link.capabilities & MGMT_CAP_MULTI_SESSION:
            print(f"control:   {link.command('@c?').strip()}")
        try:
            for line in link.command("@i?").splitlines():
                if line.strip():
                    print(f"bee:       {line.strip()}")
        except BeeError as exc:
            print(f"bee:       {exc}")
    return 0


def cmd_scan(args):
    with Session(args) as session:
        handler, packet = session.servo()
        ids = parse_ids(args.ids)
        timeout = args.scan_timeout_ms / 1000.0
        found = []
        for scs_id in ids:
            response = exchange(
                handler.ser, make_packet(scs_id, 1), timeout, scs_id
            )
            frame = find_status(response, scs_id)
            if frame is None:
                if args.verbose:
                    log(f"id {scs_id:3d}: no answer")
                continue
            model, comm, error = packet.read2ByteTxRx(scs_id, 3)
            if comm != 0:
                model = -1
            found.append(scs_id)
            print(f"[ID:{scs_id:03d}] model={model} error={error}")
        print(f"scan: {len(found)} servo(s) on {len(ids)} id(s): "
              f"{', '.join(str(found) for found in found) or '-'}")
    return 0


def cmd_ping(args):
    with Session(args) as session:
        handler, packet = session.servo()
        model, comm, error = packet.ping(args.id)
        print(f"[ID:{args.id:03d}] {result_text(packet, comm)} "
              f"model={model} error={error}")
        return 0 if comm == 0 else 1


def cmd_status(args):
    with Session(args) as session:
        handler, packet = session.servo()
        position, comm, error = packet.ReadPos(args.id)
        if comm != 0:
            print(f"[ID:{args.id:03d}] {result_text(packet, comm)}")
            return 1
        speed, comm, _ = packet.ReadSpeed(args.id)
        load, comm_load, _ = packet.read2ByteTxRx(args.id, 60)
        voltage, comm_v, _ = packet.read1ByteTxRx(args.id, 62)
        temperature, comm_t, _ = packet.read1ByteTxRx(args.id, 63)
        moving, comm_m, _ = packet.ReadMoving(args.id)
        current, comm_c, _ = packet.read2ByteTxRx(args.id, 69)

        def show(value, comm):
            return value if comm == 0 else "?"

        print(f"[ID:{args.id:03d}] position={position} "
              f"speed={show(speed, comm)} load={show(load, comm_load)}")
        print(f"          voltage={voltage / 10.0 if comm_v == 0 else '?'} V "
              f"temperature={show(temperature, comm_t)} C "
              f"moving={show(moving, comm_m)} current={show(current, comm_c)}")
        return 0


def cmd_read(args):
    with Session(args) as session:
        handler, packet = session.servo()
        data, comm, error = packet.readTxRx(args.id, args.address, args.length)
        if comm != 0:
            print(f"[ID:{args.id:03d}] {result_text(packet, comm)}")
            return 1
        print(f"[ID:{args.id:03d}] addr={args.address} len={args.length} "
              f"error={error} data={hexdump(bytes(data))}")
        return 0


def cmd_write(args):
    data = parse_hex_bytes([args.data])
    with Session(args) as session:
        handler, packet = session.servo()
        comm, error = packet.writeTxRx(args.id, args.address, len(data), list(data))
        print(f"[ID:{args.id:03d}] {result_text(packet, comm)} error={error}")
        return 0 if comm == 0 else 1


def cmd_move(args):
    from scservo_sdk import SMS_STS_TORQUE_ENABLE

    with Session(args) as session:
        handler, packet = session.servo()
        comm, error = 0, 0
        if not args.no_torque:
            comm, error = packet.write1ByteTxRx(
                args.id, SMS_STS_TORQUE_ENABLE, 1
            )
        if comm == 0:
            comm, error = packet.WritePosEx(
                args.id, args.position, args.speed, args.acc
            )
        print(f"[ID:{args.id:03d}] -> position={args.position} "
              f"speed={args.speed} acc={args.acc}: "
              f"{result_text(packet, comm)} error={error}")
        return 0 if comm == 0 else 1


def cmd_torque(args):
    from scservo_sdk import SMS_STS_TORQUE_ENABLE

    with Session(args) as session:
        handler, packet = session.servo()
        value = 1 if args.state == "on" else 0
        comm, error = packet.write1ByteTxRx(
            args.id, SMS_STS_TORQUE_ENABLE, value
        )
        print(f"[ID:{args.id:03d}] torque={args.state}: "
              f"{result_text(packet, comm)} error={error}")
        return 0 if comm == 0 else 1


def cmd_wheel(args):
    with Session(args) as session:
        handler, packet = session.servo()
        comm, error = packet.WheelMode(args.id)
        if comm == 0:
            comm, error = packet.WriteSpec(args.id, args.speed, args.acc)
        print(f"[ID:{args.id:03d}] wheel speed={args.speed}: "
              f"{result_text(packet, comm)} error={error}")
        return 0 if comm == 0 else 1


def cmd_monitor(args):
    with Session(args) as session:
        handler, packet = session.servo()
        period = 1.0 / max(0.1, args.hz)
        deadline = time.monotonic() + args.seconds if args.seconds else None
        started = time.monotonic()
        print(f"[ID:{args.id:03d}] monitoring at {args.hz:g} Hz "
              f"(Ctrl-C stops)")
        try:
            while deadline is None or time.monotonic() < deadline:
                position, speed, comm, error = packet.ReadPosSpeed(args.id)
                now = time.monotonic() - started
                if comm == 0:
                    print(f"{now:8.3f}s pos={position:5d} speed={speed:5d} "
                          f"error={error}")
                else:
                    print(f"{now:8.3f}s {result_text(packet, comm)}")
                time.sleep(max(0.0, period - 0.01))
        except KeyboardInterrupt:
            print()
        return 0


def cmd_raw(args):
    data = parse_hex_bytes(args.hex)
    with Session(args) as session:
        serial = ServoSerial(session.link, echo=args.echo != "off")
        if not args.no_flush:
            serial.reset_input_buffer()
        serial.write(data)
        timeout = args.raw_timeout_ms / 1000.0
        received = bytearray()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            chunk = serial.read(4096)
            if chunk:
                received += chunk
            else:
                time.sleep(0.002)
        print(f"tx: {hexdump(data)}")
        print(f"rx: {hexdump(bytes(received)) if received else '(nothing)'}")
        return 0 if received else 1


def cmd_selftest(args):
    failures = []

    def check(name, ok, detail=""):
        print(f"{'PASS' if ok else 'FAIL'}  {name}{(' - ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    for echo in (True, False):
        label = "echo" if echo else "no-echo"
        sim = SimulatedBee(ids=(1, 2), echo=echo)
        handler, packet = open_packet_handler(
            sim, baud=DEFAULT_BAUD, reply_timeout_ms=120, echo=echo
        )
        model, comm, error = packet.ping(1)
        check(f"{label}: ping id 1", comm == 0 and model == 777,
              f"model={model} {result_text(packet, comm)}")
        position, comm, _ = packet.ReadPos(1)
        check(f"{label}: read position", comm == 0 and position == 2048,
              f"position={position}")
        comm, error = packet.WritePosEx(1, 1000, 1000, 50)
        check(f"{label}: write position", comm == 0, result_text(packet, comm))
        position, comm, _ = packet.ReadPos(1)
        check(f"{label}: position moved", comm == 0 and position == 1000,
              f"position={position}")
        packet.SyncWritePosEx(1, 2000, 1000, 50)
        packet.SyncWritePosEx(2, 500, 1000, 50)
        comm = packet.groupSyncWrite.txPacket()
        packet.groupSyncWrite.clearParam()
        check(f"{label}: sync write", comm == 0, result_text(packet, comm))
        pos1, _, _ = packet.ReadPos(1)
        pos2, _, _ = packet.ReadPos(2)
        check(f"{label}: sync applied", pos1 == 2000 and pos2 == 500,
              f"pos1={pos1} pos2={pos2}")
        handler.closePort()

    sim = SimulatedBee(ids=(1,), echo=True)
    handler, packet = open_packet_handler(
        sim, baud=DEFAULT_BAUD, reply_timeout_ms=80, echo=True
    )
    model, comm, _ = packet.ping(9)
    check("missing id reports timeout", comm != 0, result_text(packet, comm))
    handler.closePort()
    print()
    return 0 if not failures else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bee-ftservo",
        description="Drive a FEETECH bus servo through a Linkr Bee over BLE.",
    )
    link = parser.add_argument_group("link")
    link.add_argument("--address", help="BLE address/UUID of the Bee")
    link.add_argument("--name", default=DEFAULT_NAME,
                      help="BLE name prefix to connect to (default: %(default)s)")
    link.add_argument("--scan-timeout", type=float, default=6.0,
                      help="BLE scan timeout in seconds (default: %(default)s)")
    link.add_argument("--ble-write-size", type=int, default=20,
                      help="BLE write chunk size, 20-244 (default: %(default)s)")
    link.add_argument("--write-response", action="store_true",
                      help="use GATT write-with-response (slower, safer)")
    link.add_argument("--no-claim", action="store_true",
                      help="do not claim console control before writing")
    link.add_argument("--keep-control", action="store_true",
                      help="do not release console control on exit")
    link.add_argument("--restore-uart", action="store_true",
                      help="restore the Bee's previous UART setting on exit")
    link.add_argument("--echo", choices=["auto", "on", "off"], default="auto",
                      help="drop our own half-duplex echo (default: auto)")
    link.add_argument("--simulate", action="store_true",
                      help="use an in-process servo bus instead of the Bee")
    link.add_argument("--sim-ids", default="1",
                      help="IDs the simulated bus serves (default: %(default)s)")
    link.add_argument("--sim-chunk", type=int, default=0,
                      help="split simulated replies into N-byte notifications")
    link.add_argument("--sim-no-echo", action="store_true",
                      help="simulate a direction-controlled adapter (no echo)")

    servo = parser.add_argument_group("servo bus")
    servo.add_argument("--baud", type=int, default=DEFAULT_BAUD,
                       help="servo bus baud rate (default: %(default)s)")
    servo.add_argument("--timeout", type=float, default=250.0,
                       help="reply timeout floor in ms (default: %(default)s)")
    servo.add_argument("--verbose", action="store_true")

    sub = parser.add_subparsers(dest="command", required=True)

    info = sub.add_parser("info", help="show the Bee link and UART setting")
    info.set_defaults(func=cmd_info)

    scan = sub.add_parser("scan", help="ping a range of servo IDs")
    scan.add_argument("--ids", default="1-253",
                      help="ID range, e.g. 1-12 or 1,3,5 (default: 1-253)")
    scan.add_argument("--scan-timeout-ms", type=float, default=80.0,
                      help="per-ID reply window (default: %(default)s)")
    scan.set_defaults(func=cmd_scan)

    ping = sub.add_parser("ping", help="ping one servo")
    ping.add_argument("id", type=int)
    ping.set_defaults(func=cmd_ping)

    status = sub.add_parser("status", help="read one servo's telemetry")
    status.add_argument("id", type=int)
    status.set_defaults(func=cmd_status)

    read = sub.add_parser("read", help="read memory addresses")
    read.add_argument("id", type=int)
    read.add_argument("address", type=lambda text: int(text, 0))
    read.add_argument("length", type=int)
    read.set_defaults(func=cmd_read)

    write = sub.add_parser("write", help="write memory addresses")
    write.add_argument("id", type=int)
    write.add_argument("address", type=lambda text: int(text, 0))
    write.add_argument("data", help="hex bytes, e.g. 01 or '01 02'")
    write.set_defaults(func=cmd_write)

    move = sub.add_parser("move", help="move a servo to a position")
    move.add_argument("id", type=int)
    move.add_argument("position", type=lambda text: int(text, 0))
    move.add_argument("--speed", type=int, default=2400)
    move.add_argument("--acc", type=int, default=50)
    move.add_argument("--no-torque", action="store_true",
                      help="do not enable torque first")
    move.set_defaults(func=cmd_move)

    torque = sub.add_parser("torque", help="enable or disable torque")
    torque.add_argument("id", type=int)
    torque.add_argument("state", choices=["on", "off"])
    torque.set_defaults(func=cmd_torque)

    wheel = sub.add_parser("wheel", help="switch to wheel mode and spin")
    wheel.add_argument("id", type=int)
    wheel.add_argument("speed", type=int)
    wheel.add_argument("--acc", type=int, default=50)
    wheel.set_defaults(func=cmd_wheel)

    monitor = sub.add_parser("monitor", help="continuously read position")
    monitor.add_argument("id", type=int)
    monitor.add_argument("--hz", type=float, default=5.0)
    monitor.add_argument("--seconds", type=float, default=0.0)
    monitor.set_defaults(func=cmd_monitor)

    raw = sub.add_parser("raw", help="send hex bytes and print the reply")
    raw.add_argument("hex", nargs="+")
    raw.add_argument("--raw-timeout-ms", type=float, default=300.0)
    raw.add_argument("--no-flush", action="store_true")
    raw.set_defaults(func=cmd_raw)

    selftest = sub.add_parser("selftest",
                              help="run the simulated bus end to end")
    selftest.set_defaults(func=cmd_selftest)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except BeeError as exc:
        print(f"bee-ftservo: error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print()
        return 130


if __name__ == "__main__":
    sys.exit(main())
