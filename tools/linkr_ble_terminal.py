#!/usr/bin/env python3
"""BLE Nordic UART terminal for the Linkr ESP32-C3 bridge."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import sys
import termios
import threading
import tty
from dataclasses import dataclass

from bleak import BleakClient, BleakScanner


DEFAULT_NAME = "Linkr BLE UART"
NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"


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
                    sensitive: bool = False) -> None:
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


async def send_control(client: BleakClient, command: bytes, cfg: TerminalConfig,
                       delay: float = 0.8) -> None:
    if command.startswith((b"@w=", b"@d=")):
        stderr(f"control -> {command[:2].decode()}=<redacted>")
    else:
        stderr(f"control -> {command.decode(errors='replace')}")

    frame = f"@!{len(command)}:".encode() + command
    await ble_write(client, frame, cfg,
                    sensitive=command.startswith((b"@w=", b"@d=")))
    await asyncio.sleep(delay)


def configure_ble_write_size(client: BleakClient, cfg: TerminalConfig,
                             requested_size: int) -> None:
    if requested_size > 0:
        cfg.write_size = min(requested_size, 62)
        stderr(f"BLE write chunk size: {cfg.write_size} bytes (manual)")
        return

    try:
        characteristic = client.services.get_characteristic(NUS_RX_UUID)
        size = characteristic.max_write_without_response_size
    except Exception:
        size = 20

    # The default firmware negotiates ATT MTU 65, i.e. 62-byte NUS writes.
    cfg.write_size = max(20, min(int(size or 20), 62))
    stderr(f"BLE write chunk size: {cfg.write_size} bytes")


async def loopback_test(client: BleakClient, payload: bytes, cfg: TerminalConfig,
                        notify_queue: asyncio.Queue[bytes],
                        timeout: float) -> bool:
    while not notify_queue.empty():
        notify_queue.get_nowait()

    stderr(f"loopback -> {payload!r}")
    await ble_write(client, payload, cfg)

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


async def terminal_loop(client: BleakClient, cfg: TerminalConfig) -> None:
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
        await ble_write(client, data, cfg)

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

            await client.start_notify(NUS_TX_UUID, on_notify)
            await asyncio.sleep(0.3)
            configure_ble_write_size(client, cfg, args.ble_write_size)

            if args.query_info:
                await send_control(client, b"@i?", cfg, delay=1.5)

            if args.uart:
                spec = normalize_uart_spec(args.uart)
                await send_control(client, f"@u={spec}".encode(), cfg)

            if args.query_uart:
                await send_control(client, b"@u?", cfg)

            if args.wifi:
                await send_control(client, f"@w={args.wifi}".encode(), cfg)

            if args.wifi_off:
                await send_control(client, b"@w off", cfg)

            if args.query_wifi:
                await send_control(client, b"@w?", cfg)

            if args.wifi_scan:
                await send_control(client, b"@w scan", cfg, delay=5.0)

            if args.webdav:
                await send_control(client, f"@d={args.webdav}".encode(), cfg)

            if args.webdav_off:
                await send_control(client, b"@d off", cfg)

            if args.query_webdav:
                await send_control(client, b"@d?", cfg)

            if args.loopback_test is not None:
                payload = args.loopback_test.encode()
                ok = await loopback_test(client, payload, cfg, notify_queue,
                                         args.loopback_timeout)
                if not ok:
                    raise RuntimeError("loopback test failed")

            if args.no_terminal:
                with contextlib.suppress(Exception):
                    await client.stop_notify(NUS_TX_UUID)
                return

            terminal = asyncio.create_task(terminal_loop(client, cfg))
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
                await client.stop_notify(NUS_TX_UUID)
    finally:
        if log_file:
            log_file.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Terminal over BLE Nordic UART Service for Linkr BLE bridge"
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
