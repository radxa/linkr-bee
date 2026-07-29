#!/usr/bin/env python3
"""BLE Nordic UART terminal for the Linkr ESP32-C3 bridge."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import struct
import sys
import termios
import threading
import tty
from dataclasses import dataclass

from bleak import BleakClient, BleakScanner


DEFAULT_NAME = "Linkr BLE UART"
NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
MGMT_PROTOCOL_UUID = "4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_DEVICE_ID_UUID = "4c4b0003-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_COMMAND_UUID = "4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_RESPONSE_UUID = "4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001"
RELIABLE_UART_RX_UUID = "4c4b0011-9a7e-4f4e-8b8a-3d6f12a0c001"
RELIABLE_UART_TX_UUID = "4c4b0012-9a7e-4f4e-8b8a-3d6f12a0c001"
RELIABLE_UART_STATE_UUID = "4c4b0013-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_HEADER = struct.Struct("<2sBBIHH")
RELIABLE_UART_HEADER = struct.Struct("<2sBBIHH")
MGMT_API_MAJOR = 1


@dataclass
class TerminalConfig:
    escape: bytes
    enter: str
    local_echo: bool
    line_mode: bool
    debug_io: bool
    write_size: int
    write_response: bool
    write_delay: float


class RawTerminal:
    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.saved = None

    def __enter__(self) -> None:
        if os.isatty(self.fd):
            self.saved = termios.tcgetattr(self.fd)
            tty.setraw(self.fd)

    def __exit__(self, *_exc: object) -> None:
        if self.saved is not None:
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)


def stderr(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_escape(value: str) -> bytes:
    if len(value) == 2 and value[0] == "^":
        return bytes([ord(value[1].upper()) & 0x1F])
    if value.startswith("0x"):
        return bytes([int(value, 16)])
    raw = value.encode()
    if len(raw) != 1:
        raise argparse.ArgumentTypeError("escape must be one byte, like ^] or 0x1d")
    return raw


def normalize_uart_spec(spec: str) -> str:
    fields = [part.strip() for part in spec.split(",")]
    if len(fields) != 5:
        raise argparse.ArgumentTypeError("UART spec must be baud,data,parity,stop,flow")

    baud, data_bits, parity, stop_bits, flow = fields
    parity = {"none": "n", "n": "n", "odd": "o", "o": "o",
              "even": "e", "e": "e"}.get(parity.lower(), parity.lower())
    flow = {"none": "n", "off": "n", "n": "n", "rtscts": "rtscts",
            "hw": "rtscts"}.get(flow.lower(), flow.lower())
    return ",".join([baud, data_bits, parity, stop_bits, flow])


def translate_enter(data: bytes, mode: str) -> bytes:
    if mode == "raw":
        return data

    data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    replacement = {
        "cr": b"\r",
        "lf": b"\n",
        "crlf": b"\r\n",
    }[mode]
    return data.replace(b"\n", replacement)


async def scan_devices(timeout: float) -> list:
    devices = await BleakScanner.discover(timeout=timeout)
    for dev in devices:
        name = dev.name or ""
        if name:
            print(f"{dev.address}\t{name}")
    return devices


def normalize_name_prefix(name: str) -> str:
    name = name.strip()
    if name.endswith("*"):
        return name[:-1].rstrip()
    return name


async def find_device(name: str, address: str | None, timeout: float):
    if address:
        return address

    prefix = normalize_name_prefix(name)
    stderr(f"Scanning for BLE device matching {prefix + '*'}...")
    devices = await BleakScanner.discover(timeout=timeout)
    exact = [dev for dev in devices if dev.name == name]
    if exact:
        return exact[0]

    prefixed = [
        dev for dev in devices
        if dev.name and dev.name.startswith(prefix)
    ]
    if prefixed:
        if len(prefixed) > 1:
            matches = ", ".join(
                f"{dev.name} ({dev.address})" for dev in prefixed[:4]
            )
            stderr(
                "warning: multiple Linkr BLE devices match; "
                f"using {prefixed[0].name} ({prefixed[0].address}); "
                f"matches: {matches}"
            )
        return prefixed[0]

    raise RuntimeError(f"device not found matching: {prefix + '*'}")


async def ble_write(client: BleakClient, data: bytes, cfg: TerminalConfig,
                    sensitive: bool = False,
                    reliable: "ReliableUartChannel | None" = None) -> None:
    if reliable:
        await reliable.write(data, sensitive=sensitive)
        return
    if cfg.write_size <= 0:
        cfg.write_size = 20

    for offset in range(0, len(data), cfg.write_size):
        chunk = data[offset:offset + cfg.write_size]
        if cfg.debug_io:
            stderr(f"TX <redacted {len(chunk)} bytes>" if sensitive else
                   f"TX {chunk!r}")
        await client.write_gatt_char(NUS_RX_UUID, chunk, response=cfg.write_response)
        if cfg.write_delay:
            await asyncio.sleep(cfg.write_delay)


class ManagementChannel:
    """Linkr Management Service v1 request/response channel."""

    def __init__(self, client: BleakClient, cfg: TerminalConfig) -> None:
        self.client = client
        self.cfg = cfg
        self.next_request_id = 1
        self.current: dict | None = None
        self.pending: dict[int, asyncio.Future[bytes]] = {}
        self.pending_final: dict[int, asyncio.Future[bytes]] = {}

    def on_indication(self, _char, data: bytearray) -> None:
        fragment = bytes(data)
        if self.current is None:
            if len(fragment) < MGMT_HEADER.size or fragment[:2] != b"LK":
                stderr("management <- orphaned response fragment")
                return
            magic, version, message_type, request_id, expected, flags = \
                MGMT_HEADER.unpack_from(fragment)
            if magic != b"LK" or version != MGMT_API_MAJOR or \
                    message_type not in (2, 3):
                stderr("management <- invalid response header")
                self.current = None
                return
            self.current = {
                "type": message_type,
                "request_id": request_id,
                "expected": expected,
                "flags": flags,
                "payload": bytearray(),
            }
            fragment = fragment[MGMT_HEADER.size:]

        message = self.current
        payload = message["payload"]
        if len(payload) + len(fragment) > message["expected"]:
            stderr("management <- oversized response")
            self.current = None
            return
        payload.extend(fragment)
        if len(payload) != message["expected"]:
            return

        self.current = None
        body = bytes(payload)
        kind = "event" if message["type"] == 3 else "response"
        text = body.decode(errors="replace").rstrip("\r\n")
        for line in text.splitlines() or [""]:
            stderr(f"{kind} #{message['request_id']} <- {line}")
        if message["type"] == 2:
            future = self.pending.pop(message["request_id"], None)
            if future and not future.done():
                future.set_result(body)
        elif message["flags"] & 1:
            future = self.pending_final.pop(message["request_id"], None)
            if future and not future.done():
                future.set_result(body)

    async def send(self, command: bytes, delay: float = 0.0,
                   wait_final_timeout: float = 0.0) -> bytes:
        sensitive = command.startswith((b"@w=", b"@d="))
        if sensitive:
            stderr(f"control -> {command[:2].decode()}=<redacted>")
        else:
            stderr(f"control -> {command.decode(errors='replace')}")

        request_id = self.next_request_id
        self.next_request_id = 1 if request_id == 0xFFFFFFFF else request_id + 1
        frame = MGMT_HEADER.pack(
            b"LK", MGMT_API_MAJOR, 1, request_id, len(command), 0
        ) + command
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        final_future = None
        if wait_final_timeout:
            final_future = asyncio.get_running_loop().create_future()
            self.pending_final[request_id] = final_future
        try:
            size = max(20, self.cfg.write_size)
            for offset in range(0, len(frame), size):
                chunk = frame[offset:offset + size]
                if self.cfg.debug_io:
                    stderr(
                        f"MGMT TX #{request_id} <redacted {len(chunk)} bytes>"
                        if sensitive else
                        f"MGMT TX #{request_id} {chunk!r}"
                    )
                await self.client.write_gatt_char(
                    MGMT_COMMAND_UUID, chunk, response=True
                )
            response = await asyncio.wait_for(future, timeout=5.0)
            if final_future:
                await asyncio.wait_for(final_future, timeout=wait_final_timeout)
            if delay:
                await asyncio.sleep(delay)
            return response
        finally:
            self.pending.pop(request_id, None)
            self.pending_final.pop(request_id, None)


class ReliableUartChannel:
    """Sequence-numbered UART data with GATT write/indication ACKs."""

    def __init__(self, client: BleakClient, cfg: TerminalConfig,
                 max_payload: int, tx_sequence: int, rx_sequence: int,
                 data_handler) -> None:
        self.client = client
        self.cfg = cfg
        self.max_payload = max(1, min(max_payload, 232))
        self.tx_sequence = tx_sequence or 1
        self.rx_sequence = rx_sequence or 1
        self.data_handler = data_handler
        self.current: dict | None = None

    @staticmethod
    def next_sequence(sequence: int) -> int:
        return 1 if sequence == 0xFFFFFFFF else sequence + 1

    def on_indication(self, _char, data: bytearray) -> None:
        fragment = bytes(data)
        if self.current is None:
            if len(fragment) < RELIABLE_UART_HEADER.size or fragment[:2] != b"LR":
                stderr("reliable UART <- orphaned fragment")
                return
            magic, version, _flags, sequence, expected, _reserved = \
                RELIABLE_UART_HEADER.unpack_from(fragment)
            if magic != b"LR" or version != 1 or expected == 0:
                stderr("reliable UART <- invalid frame header")
                self.current = None
                return
            self.current = {
                "sequence": sequence,
                "expected": expected,
                "payload": bytearray(),
            }
            fragment = fragment[RELIABLE_UART_HEADER.size:]

        message = self.current
        payload = message["payload"]
        if len(payload) + len(fragment) > message["expected"]:
            stderr("reliable UART <- oversized frame")
            self.current = None
            return
        payload.extend(fragment)
        if len(payload) != message["expected"]:
            return

        self.current = None
        previous = 0xFFFFFFFF if self.rx_sequence == 1 else self.rx_sequence - 1
        if message["sequence"] == previous:
            return
        if message["sequence"] != self.rx_sequence:
            stderr(
                "reliable UART sequence gap: "
                f"expected {self.rx_sequence}, got {message['sequence']}"
            )
            return
        self.rx_sequence = self.next_sequence(self.rx_sequence)
        self.data_handler(None, bytearray(payload))

    async def write(self, data: bytes, sensitive: bool = False) -> None:
        payload_size = self.max_payload
        for payload_offset in range(0, len(data), payload_size):
            payload = data[payload_offset:payload_offset + payload_size]
            sequence = self.tx_sequence
            frame = RELIABLE_UART_HEADER.pack(
                b"LR", 1, 0, sequence, len(payload), 0
            ) + payload
            att_size = max(20, min(self.cfg.write_size, 244))
            for offset in range(0, len(frame), att_size):
                chunk = frame[offset:offset + att_size]
                if self.cfg.debug_io:
                    stderr(
                        f"UART TX #{sequence} <redacted {len(chunk)} bytes>"
                        if sensitive else f"UART TX #{sequence} {chunk!r}"
                    )
                await self.client.write_gatt_char(
                    RELIABLE_UART_RX_UUID, chunk, response=True
                )
            self.tx_sequence = self.next_sequence(sequence)


def configure_ble_write_size(client: BleakClient, cfg: TerminalConfig,
                             requested_size: int) -> None:
    if requested_size > 0:
        cfg.write_size = min(requested_size, 244)
        stderr(f"BLE write chunk size: {cfg.write_size} bytes (manual)")
        return

    try:
        characteristic = client.services.get_characteristic(NUS_RX_UUID)
        reported = characteristic.max_write_without_response_size
        mtu_size = getattr(client, "mtu_size", 23)
        size = max(int(reported or 20), int(mtu_size or 23) - 3)
    except Exception:
        size = 20

    cfg.write_size = max(20, min(int(size or 20), 244))
    stderr(f"BLE write chunk size: {cfg.write_size} bytes")


async def loopback_test(client: BleakClient, payload: bytes, cfg: TerminalConfig,
                        notify_queue: asyncio.Queue[bytes],
                        timeout: float,
                        reliable: ReliableUartChannel | None = None) -> bool:
    while not notify_queue.empty():
        notify_queue.get_nowait()

    stderr(f"loopback -> {payload!r}")
    await ble_write(client, payload, cfg, reliable=reliable)

    received = bytearray()
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        remaining = max(0.1, deadline - asyncio.get_running_loop().time())
        try:
            received.extend(await asyncio.wait_for(notify_queue.get(), remaining))
        except asyncio.TimeoutError:
            break

        if payload in received:
            stderr(f"loopback PASS <- {bytes(received)!r}")
            return True

    stderr(f"loopback FAIL <- {bytes(received)!r}")
    return False


async def terminal_loop(client: BleakClient, cfg: TerminalConfig,
                        reliable: ReliableUartChannel | None = None) -> None:
    loop = asyncio.get_running_loop()
    done = asyncio.Event()
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    fd = sys.stdin.fileno()

    def stdin_reader() -> None:
        while not done.is_set():
            try:
                if cfg.line_mode:
                    data = sys.stdin.buffer.readline()
                else:
                    data = os.read(fd, 1024)
            except OSError:
                loop.call_soon_threadsafe(queue.put_nowait, None)
                return

            if not data:
                loop.call_soon_threadsafe(queue.put_nowait, None)
                return

            loop.call_soon_threadsafe(queue.put_nowait, data)

    async def sender() -> None:
        while not done.is_set():
            data = await queue.get()
            if data is None:
                await asyncio.sleep(0.2)
                done.set()
                break

            escape_at = data.find(cfg.escape)
            if escape_at >= 0:
                if escape_at:
                    await send_payload(data[:escape_at])
                done.set()
                break
            await send_payload(data)

    async def send_payload(data: bytes) -> None:
        data = translate_enter(data, cfg.enter)
        if cfg.local_echo:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        await ble_write(client, data, cfg, reliable=reliable)

    stderr("Terminal open. Press Ctrl-] to exit.")
    terminal_context = contextlib.nullcontext() if cfg.line_mode else RawTerminal(fd)
    with terminal_context:
        threading.Thread(target=stdin_reader, daemon=True).start()
        task = asyncio.create_task(sender())
        try:
            await done.wait()
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
    stderr("\nTerminal closed.")


async def run(args: argparse.Namespace) -> None:
    if args.scan:
        await scan_devices(args.timeout)
        has_control_action = any((
            args.query_info, args.query_uart, args.uart, args.wifi,
            args.wifi_scan, args.wifi_off,
            args.query_wifi, args.webdav, args.webdav_off,
            args.query_webdav, args.loopback_test is not None,
        ))
        if args.no_terminal and not has_control_action:
            return

    target = await find_device(args.name, args.address, args.timeout)
    cfg = TerminalConfig(
        escape=args.escape,
        enter=args.enter,
        local_echo=args.local_echo,
        line_mode=args.line_mode,
        debug_io=args.debug_io,
        write_size=0,
        write_response=args.write_response,
        write_delay=args.write_delay_ms / 1000.0,
    )

    disconnected = asyncio.Event()
    notify_queue: asyncio.Queue[bytes] = asyncio.Queue()

    def on_disconnect(_client: BleakClient) -> None:
        disconnected.set()

    stderr("Connecting...")
    log_file = open(args.log_file, "ab", buffering=0) if args.log_file else None

    try:
        async with BleakClient(target, disconnected_callback=on_disconnect,
                               timeout=args.timeout) as client:
            stderr(f"Connected: {client.address}")

            if args.pair:
                stderr("Pairing is disabled by this firmware; --pair is a no-op")

            def on_notify(_char, data: bytearray) -> None:
                payload = bytes(data)
                notify_queue.put_nowait(payload)
                if args.debug_io:
                    stderr(f"RX {payload!r}")
                if log_file:
                    log_file.write(payload)
                sys.stdout.buffer.write(payload)
                sys.stdout.buffer.flush()

            configure_ble_write_size(client, cfg, args.ble_write_size)
            protocol = bytes(await client.read_gatt_char(MGMT_PROTOCOL_UUID))
            if len(protocol) < 10 or protocol[0] != MGMT_API_MAJOR:
                raise RuntimeError("unsupported Linkr Management API version")
            device_id = bytes(await client.read_gatt_char(MGMT_DEVICE_ID_UUID))
            stderr(
                f"Management API v{protocol[0]}.{protocol[1]}, "
                f"device ID {device_id.hex()}"
            )
            management = ManagementChannel(client, cfg)
            await client.start_notify(
                MGMT_RESPONSE_UUID, management.on_indication
            )
            reliable_state = bytes(
                await client.read_gatt_char(RELIABLE_UART_STATE_UUID)
            )
            if len(reliable_state) < 16 or reliable_state[0] != 1:
                raise RuntimeError("unsupported Reliable UART version")
            reliable = ReliableUartChannel(
                client,
                cfg,
                int.from_bytes(reliable_state[2:4], "little"),
                int.from_bytes(reliable_state[4:8], "little"),
                int.from_bytes(reliable_state[8:12], "little"),
                on_notify,
            )
            await client.start_notify(
                RELIABLE_UART_TX_UUID, reliable.on_indication
            )

            if args.query_info:
                await management.send(b"@i?")

            if args.uart:
                spec = normalize_uart_spec(args.uart)
                await management.send(f"@u={spec}".encode())

            if args.query_uart:
                await management.send(b"@u?")

            if args.wifi:
                await management.send(
                    f"@w={args.wifi}".encode(), wait_final_timeout=30.0
                )

            if args.wifi_off:
                await management.send(b"@w off", wait_final_timeout=10.0)

            if args.query_wifi:
                await management.send(b"@w?")

            if args.wifi_scan:
                await management.send(b"@w scan", wait_final_timeout=25.0)

            if args.webdav:
                await management.send(f"@d={args.webdav}".encode())

            if args.webdav_off:
                await management.send(b"@d off")

            if args.query_webdav:
                await management.send(b"@d?")

            if args.loopback_test is not None:
                payload = args.loopback_test.encode()
                ok = await loopback_test(client, payload, cfg, notify_queue,
                                         args.loopback_timeout, reliable)
                if not ok:
                    raise RuntimeError("loopback test failed")

            if args.no_terminal:
                with contextlib.suppress(Exception):
                    await client.stop_notify(MGMT_RESPONSE_UUID)
                with contextlib.suppress(Exception):
                    await client.stop_notify(RELIABLE_UART_TX_UUID)
                return

            terminal = asyncio.create_task(terminal_loop(client, cfg, reliable))
            disconnect = asyncio.create_task(disconnected.wait())
            done, pending = await asyncio.wait(
                {terminal, disconnect}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            if disconnect in done:
                stderr("\nBLE disconnected.")
            with contextlib.suppress(Exception):
                await client.stop_notify(MGMT_RESPONSE_UUID)
            with contextlib.suppress(Exception):
                await client.stop_notify(RELIABLE_UART_TX_UUID)
    finally:
        if log_file:
            log_file.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Terminal over BLE Nordic UART Service for Linkr Bee bridge"
    )
    parser.add_argument(
        "--name",
        default=DEFAULT_NAME,
        help="BLE device name or prefix; default matches Linkr BLE UART*",
    )
    parser.add_argument("--address", help="BLE address/UUID; skips name scan")
    parser.add_argument("--scan", action="store_true", help="list nearby BLE devices")
    parser.add_argument("--timeout", type=float, default=8.0, help="scan timeout seconds")
    parser.add_argument("--query-info", action="store_true",
                        help="send @i? device diagnostics before terminal")
    parser.add_argument("--query-uart", action="store_true", help="send @u? before terminal")
    parser.add_argument("--uart", help="set UART as baud,data,parity,stop,flow")
    parser.add_argument("--wifi", help="connect ESP32 to WiFi as ssid,pass")
    parser.add_argument("--wifi-off", action="store_true", help="forget saved WiFi")
    parser.add_argument("--query-wifi", action="store_true", help="send @w? before terminal")
    parser.add_argument("--wifi-scan", action="store_true",
                        help="scan nearby 2.4 GHz WiFi networks")
    parser.add_argument("--webdav", help="set anonymous HTTP WebDAV upload URL")
    parser.add_argument("--webdav-off", action="store_true", help="disable WebDAV upload")
    parser.add_argument("--query-webdav", action="store_true", help="send @d? before terminal")
    parser.add_argument("--pair", action="store_true",
                        help="deprecated no-op; BLE pairing is disabled")
    parser.add_argument("--loopback-test", nargs="?", const="A",
                        help="send payload and require the same bytes back")
    parser.add_argument("--loopback-timeout", type=float, default=3.0,
                        help="seconds to wait for --loopback-test echo")
    parser.add_argument("--no-terminal", action="store_true", help="connect, run commands, exit")
    parser.add_argument("--ble-write-size", type=int, default=0,
                        help="max bytes per BLE RX write; default auto")
    parser.add_argument("--write-response", action="store_true",
                        help="use GATT write-with-response")
    parser.add_argument("--write-delay-ms", type=float, default=5.0,
                        help="delay between BLE write chunks")
    parser.add_argument("--enter", choices=["raw", "cr", "lf", "crlf"], default="raw",
                        help="translate Enter key bytes before BLE write")
    parser.add_argument("--local-echo", action="store_true", help="echo typed bytes locally")
    parser.add_argument("--line-mode", action="store_true",
                        help="do not use raw terminal; send one visible line at a time")
    parser.add_argument("--debug-io", action="store_true",
                        help="print BLE TX/RX byte traces to stderr")
    parser.add_argument("--log-file", help="append raw BLE RX bytes to a file")
    parser.add_argument("--escape", type=parse_escape, default=parse_escape("^]"),
                        help="terminal escape byte, default ^]")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        stderr(f"error: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
