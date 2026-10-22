#!/usr/bin/env python3
"""BLE Nordic UART terminal for the Linkr ESP32-C3 bridge."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import getpass
import json
import math
import os
import re
import signal
import struct
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

try:  # POSIX only. Without these the CLI still scans and runs control actions.
    import termios
    import tty
except ModuleNotFoundError:  # pragma: no cover - Windows hosts
    termios = None
    tty = None

__version__ = "0.1.2"
DEFAULT_NAME = None  # Discover by service; --name is an explicit override.
MGMT_SERVICE_UUID = "4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001"
NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
MGMT_SERVICE_UUID = "4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_PROTOCOL_UUID = "4c4b0002-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_DEVICE_ID_UUID = "4c4b0003-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_COMMAND_UUID = "4c4b0004-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_RESPONSE_UUID = "4c4b0005-9a7e-4f4e-8b8a-3d6f12a0c001"
RELIABLE_UART_RX_UUID = "4c4b0011-9a7e-4f4e-8b8a-3d6f12a0c001"
RELIABLE_UART_TX_UUID = "4c4b0012-9a7e-4f4e-8b8a-3d6f12a0c001"
RELIABLE_UART_STATE_UUID = "4c4b0013-9a7e-4f4e-8b8a-3d6f12a0c001"
MGMT_HEADER = struct.Struct("<2sBBIHH")
# The firmware's advertised-name limit, in UTF-8 bytes. The C client keeps the
# same constant; tests/test_terminal_cli_c.py checks the two strings agree.
BLE_NAME_MAX = 29
RELIABLE_UART_HEADER = struct.Struct("<2sBBIHH")
MGMT_API_MAJOR = 1
MGMT_CAP_WIFI = 1 << 0
MGMT_CAP_WEBDAV = 1 << 1
MGMT_CAP_DEVICE_ID = 1 << 3
MGMT_CAP_ASYNC_EVENTS = 1 << 4
MGMT_CAP_RELIABLE_UART = 1 << 5
MGMT_FLAG_FINAL = 1 << 0
MGMT_FLAG_ERROR = 1 << 1
WIFI_OPERATION_TIMEOUT = 35.0
WIFI_SCAN_TIMEOUT = 35.0

# The device rejects anything outside these ranges (src/main.c parse_uart_line),
# so the CLI validates the spec locally and fails before touching the link.
UART_BAUD_MIN = 300
UART_BAUD_MAX = 3_000_000
UART_DATA_BITS = ("5", "6", "7", "8")
UART_STOP_BITS = ("1", "2")
UART_PARITY = {"n": "n", "none": "n", "o": "o", "odd": "o", "e": "e", "even": "e"}
UART_FLOW_CONTROL = {
    "n": "n", "none": "n", "off": "n", "rtscts": "rtscts", "hw": "rtscts",
}
# Same clamp the web terminal applies in web/terminal_geometry.js.
MIN_TERMINAL_COLUMNS = 2
MIN_TERMINAL_ROWS = 2
MAX_TERMINAL_DIMENSION = 1000
WIFI_PASSWORD_ENV = "LINKR_WIFI_PASSWORD"
# Exit codes: 0 clean, 1 error, 2 usage/validation, 3 device vanished mid-session.
EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2
EXIT_DEVICE_DISCONNECTED = 3

# Imports on demand so --help/--version work on a host without bleak installed.
BleakClient = None
BleakScanner = None

_QUIET = False


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
    """Put the local tty in raw mode for the terminal session.

    POSIX only. The caller checks `available()` and falls back to line mode on
    hosts without termios instead of failing at import time.
    """

    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.saved = None

    @staticmethod
    def available() -> bool:
        return termios is not None and tty is not None

    def __enter__(self) -> None:
        if not self.available():
            raise RuntimeError(
                "raw terminal mode needs POSIX termios; use --line-mode instead"
            )
        if os.isatty(self.fd):
            self.saved = termios.tcgetattr(self.fd)
            tty.setraw(self.fd)

    def __exit__(self, *_exc: object) -> None:
        if self.saved is not None:
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)


def stderr(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def info(message: str) -> None:
    """Progress chatter; silenced by --quiet. Errors and results still print."""
    if not _QUIET:
        stderr(f"linkr: {message}")


def warn(message: str) -> None:
    stderr(f"linkr: warning: {message}")


def error(message: str) -> None:
    stderr(f"linkr: error: {message}")


def import_bleak() -> None:
    """Load bleak on demand so --help/--version need no dependencies."""
    global BleakClient, BleakScanner
    if BleakClient is not None:
        return
    try:
        from bleak import BleakClient as client_class
        from bleak import BleakScanner as scanner_class
    except ImportError as exc:
        # ImportError, not just ModuleNotFoundError: a bleak that is present but
        # fails to import its own backend should read the same way.
        raise RuntimeError(
            "the 'bleak' package is required to talk to the device; "
            "install it with 'python3 -m pip install bleak'"
        ) from exc
    BleakClient, BleakScanner = client_class, scanner_class


def parse_escape(value: str) -> bytes:
    if value == "^":
        # A lone caret is the start of the ^X form, never a literal byte.
        raise argparse.ArgumentTypeError("escape must be one byte, like ^] or 0x1d")
    if len(value) == 2 and value[0] == "^":
        return bytes([ord(value[1].upper()) & 0x1F])
    if value.startswith("0x"):
        try:
            parsed = int(value, 16)
        except ValueError as error:
            raise argparse.ArgumentTypeError(
                "escape must be one byte, like ^] or 0x1d"
            ) from error
        if not 0 <= parsed <= 0xFF:
            raise argparse.ArgumentTypeError("hex escape must be between 0x00 and 0xff")
        return bytes([parsed])
    raw = value.encode()
    if len(raw) != 1:
        raise argparse.ArgumentTypeError("escape must be one byte, like ^] or 0x1d")
    return raw


def positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("value must be greater than zero")
    return parsed


def nonnegative_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("value must not be negative")
    return parsed


def ble_write_size(value: str) -> int:
    parsed = int(value)
    if not 0 <= parsed <= 244:
        raise argparse.ArgumentTypeError("BLE write size must be between 0 and 244")
    return parsed


def normalize_ble_name(value: str) -> str:
    """Validate an advertised BLE name before touching the radio.

    The firmware stores the UTF-8 bytes verbatim and rejects C0/C1 controls,
    DEL, U+2028/U+2029, embedded NUL, invalid UTF-8, and anything over 29
    bytes. It trims only the four ASCII whitespace bytes; trimming Unicode
    whitespace here would make the same command store a different name
    depending on which host sent it.
    """
    name = value.strip(" \t\r\n")
    if not name:
        raise argparse.ArgumentTypeError(
            "BLE name must be 1-29 UTF-8 bytes")
    try:
        encoded = name.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise argparse.ArgumentTypeError(
            "BLE name must be valid UTF-8") from exc
    if len(encoded) > BLE_NAME_MAX:
        raise argparse.ArgumentTypeError(
            f"BLE name must be 1-{BLE_NAME_MAX} UTF-8 bytes; "
            f"this one is {len(encoded)}")
    if any(ord(char) < 0x20 or 0x7f <= ord(char) <= 0x9f or
           ord(char) in (0x2028, 0x2029) for char in name):
        raise argparse.ArgumentTypeError(
            "BLE name must not contain control characters")
    return name


def normalize_uart_spec(spec: str) -> str:
    """Validate and canonicalize a UART spec before it reaches the device.

    The firmware answers only "ERR format: @u=115200,8,n,1,n" for any bad field,
    so the CLI rejects the spec here and names the offending one.
    """
    fields = [part.strip() for part in spec.split(",")]
    if len(fields) != 5:
        raise argparse.ArgumentTypeError(
            "UART spec must be baud,data,parity,stop,flow, like 115200,8,n,1,n"
        )

    baud, data_bits, parity, stop_bits, flow = fields
    try:
        baud_rate = int(baud, 10)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid UART baud rate: {baud!r}") from exc
    if not UART_BAUD_MIN <= baud_rate <= UART_BAUD_MAX:
        raise argparse.ArgumentTypeError(
            f"UART baud rate must be between {UART_BAUD_MIN} and {UART_BAUD_MAX}"
        )
    if data_bits not in UART_DATA_BITS:
        raise argparse.ArgumentTypeError(
            "UART data bits must be one of " + ", ".join(UART_DATA_BITS)
        )
    if stop_bits not in UART_STOP_BITS:
        raise argparse.ArgumentTypeError("UART stop bits must be 1 or 2")
    if parity.lower() not in UART_PARITY:
        raise argparse.ArgumentTypeError(
            "UART parity must be none, odd or even (n/o/e)"
        )
    if flow.lower() not in UART_FLOW_CONTROL:
        raise argparse.ArgumentTypeError(
            "UART flow control must be none or rtscts"
        )

    return (
        f"{baud_rate},{data_bits},{UART_PARITY[parity.lower()]},"
        f"{stop_bits},{UART_FLOW_CONTROL[flow.lower()]}"
    )


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


def terminal_geometry(cols, rows) -> dict:
    """Clamp a terminal size the way web/terminal_geometry.js does."""
    def clamp(value, minimum: int) -> int:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return minimum
        if not math.isfinite(number):
            return minimum
        return max(minimum, min(MAX_TERMINAL_DIMENSION, int(number)))

    normalized_cols = clamp(cols, MIN_TERMINAL_COLUMNS)
    normalized_rows = clamp(rows, MIN_TERMINAL_ROWS)
    return {
        "cols": normalized_cols,
        "rows": normalized_rows,
        "key": f"{normalized_cols}x{normalized_rows}",
    }


def terminal_geometry_command(cols, rows) -> str:
    """The stty line the web client sends; keep the two byte-identical."""
    geometry = terminal_geometry(cols, rows)
    return (
        f"stty rows {geometry['rows']} cols {geometry['cols']} "
        ">/dev/null 2>&1\r"
    )


def looks_like_shell_prompt(text: str) -> bool:
    """Port of looksLikeShellPrompt() from web/terminal_geometry.js."""
    if not isinstance(text, str) or not re.search(r"[$#] $", text):
        return False

    prefix = text[:-2].strip()
    if not prefix:
        return True

    return bool(
        re.search(r"@\S+(?::\S*)?$", prefix)
        or re.match(r"^(?:ba|da|a|z)?sh(?:-[\d.]+)?$", prefix)
        or re.match(r"^(?:~|/\S*)$", prefix)
        or re.match(r"^\[[^\]]+\]$", prefix)
    )


class TerminalGeometrySync:
    """Tell the target its terminal size, but only at an idle shell prompt.

    The UART carries a live console, so an stty line sent while a command owns
    the line would be typed into that command. The web client gates on the same
    condition; this mirrors it for the CLI.
    """

    def __init__(self, cols, rows) -> None:
        self.geometry = terminal_geometry(cols, rows)
        self.synced = ""
        self.in_flight = ""
        self.prompt_visible = False
        self._line = ""

    def set_size(self, cols, rows) -> None:
        self.geometry = terminal_geometry(cols, rows)

    def mark_busy(self) -> None:
        """Local input invalidates the idle prompt until the target returns one."""
        self.prompt_visible = False
        self._line = ""

    def observe(self, text: str) -> None:
        """Track target output to know whether an idle prompt is on screen."""
        for char in text:
            if char in "\r\n":
                self._line = ""
                continue
            self._line = (self._line + char)[-1024:]
        self.prompt_visible = looks_like_shell_prompt(self._line)

    def take_pending_command(self) -> str | None:
        """Return the stty line to send now, or None when nothing is due."""
        key = self.geometry["key"]
        if not self.prompt_visible or key in (self.synced, self.in_flight):
            return None
        self.in_flight = key
        self.prompt_visible = False
        return terminal_geometry_command(self.geometry["cols"], self.geometry["rows"])

    def confirm_sent(self) -> None:
        self.synced = self.in_flight
        self.in_flight = ""

    def abort_sent(self) -> None:
        self.in_flight = ""


def describe_escape(escape: bytes) -> str:
    """Human name for the escape byte, so the hint follows --escape."""
    value = escape[0]
    if value == 0x1B:
        return "Esc"
    if 1 <= value <= 26:
        return f"Ctrl-{chr(ord('A') + value - 1)}"
    if 0x1C <= value <= 0x1F:
        return "Ctrl-" + "\\]^_"[value - 0x1C]
    if 0x20 <= value < 0x7F:
        return repr(chr(value))
    return f"0x{value:02x}"


def resolve_wifi_credentials(spec: str, key_file: str | None = None,
                             environ: dict | None = None,
                             prompt=None) -> tuple[str, str]:
    """Resolve (ssid, password) without forcing the password into argv.

    ``--wifi ssid,pass`` still works, but argv is world-readable through `ps`,
    so ``--wifi ssid`` with --wifi-key-file / $LINKR_WIFI_PASSWORD / a prompt is
    the documented form.
    """
    ssid, separator, inline = spec.partition(",")
    ssid = ssid.strip()
    if not ssid:
        raise ValueError("WiFi SSID must not be empty")
    if separator:
        return ssid, inline

    if key_file:
        try:
            text = Path(key_file).read_text(encoding="utf-8")
        except OSError as exc:
            raise ValueError(f"cannot read --wifi-key-file: {exc}") from exc
        lines = text.splitlines()
        if not lines:
            raise ValueError(f"--wifi-key-file {key_file} is empty")
        return ssid, lines[0]

    source = (environ if environ is not None else os.environ).get(WIFI_PASSWORD_ENV)
    if source:
        return ssid, source

    if prompt is not None:
        password = prompt(f"WiFi password for {ssid}: ")
        if not password:
            raise ValueError("WiFi password must not be empty")
        return ssid, password

    raise ValueError(
        "no WiFi password available: pass --wifi ssid,pass, or set "
        f"--wifi-key-file, or export {WIFI_PASSWORD_ENV}"
    )


@dataclass
class DiscoveredDevice:
    name: str | None
    address: str
    rssi: int | None
    service_uuids: tuple[str, ...]


async def discover_devices(timeout: float) -> list[DiscoveredDevice]:
    """Keep advertisement services alongside names, including for --scan reuse."""
    import_bleak()
    advertisements = await BleakScanner.discover(timeout=timeout, return_adv=True)
    return [
        DiscoveredDevice(adv.local_name or device.name, device.address, adv.rssi,
                         tuple(uuid.lower() for uuid in adv.service_uuids))
        for device, adv in advertisements.values()
    ]


async def scan_devices(timeout: float) -> list:
    """List every nearby BLE device, named or not.

    Unnamed peripherals are exactly the ones a user cannot identify by name, so
    silently dropping them made an empty --scan output misleading.
    """
    devices = await discover_devices(timeout)
    for dev in sorted(devices, key=device_sort_key):
        rssi = getattr(dev, "rssi", None)
        signal = f"{rssi} dBm" if isinstance(rssi, int) else "-"
        print(f"{dev.address}\t{printable_device_name(dev.name)}\t{signal}")
    return devices


def device_sort_key(device) -> tuple[str, str]:
    return ((device.name or "\uffff").lower(), device.address or "")


def printable_device_name(name: str | None) -> str:
    """A name heard over the air, safe to put on a terminal line.

    Anyone nearby can choose the name a scan reports, including ESC and C1
    bytes that a terminal would interpret. Drop them rather than let a
    stranger's advertisement drive the console.
    """
    if not name:
        return "(unknown)"
    return "".join(
        char for char in name
        if not (ord(char) < 0x20 or 0x7f <= ord(char) <= 0x9f)
    ) or "(unknown)"


def normalize_name_prefix(name: str) -> str:
    name = name.strip()
    if name.endswith("*"):
        return name[:-1].rstrip()
    return name


def is_legacy_name(name: str | None) -> bool:
    """Whether a name is one of the fixed legacy names.

    The oldest NUS-only firmware had no per-device name and no Management
    Service, so its fixed name is the only way to recognise it. A current
    board can carry the same name, which is why this is a narrow exception
    and not a rule.
    """
    return bool(re.match(r"^Linkr BLE UART(?:$|[- ])", (name or "").strip(), re.I))


def is_linkr_device_id(device_id: bytes) -> bool:
    """Whether a Device ID belongs to Linkr Bee.

    The first ten bytes are the fixed Linkr namespace (`LINKRBLE`, version 1)
    and the last six are the chip's hardware id. Checking the namespace is
    what makes the Management Service a filter rather than a promise: any
    device can advertise the same UUID.
    """
    return len(device_id) == 16 and device_id.startswith(b"LINKRBLE\x01\x00")


def advertises_management(device) -> bool:
    """Whether the advertisement carried the Linkr Management Service.

    This is how a board is found now that its name is a label the owner can
    change: the service is in the advertisement, the name is not an identity.
    """
    uuids = getattr(device, "service_uuids", None)
    if uuids is None:
        uuids = getattr(device, "services", None) or ()
    for service in uuids:
        if str(service).lower() == MGMT_SERVICE_UUID:
            return True
    return False


def match_device(devices, name: str | None) -> str | None:
    """Return the best match's address, or None. Split out for testing.

    With no name asked for, the board is the one that speaks the Management
    Service, and a legacy NUS-only board is the fallback. With a name, the
    name is what the caller asked for - compared without regard to its case,
    because a label is written by a person and the case in it is not a
    promise.
    """
    if name is None:
        managed = [dev for dev in devices if advertises_management(dev)]
        legacy = [dev for dev in devices if is_legacy_name(dev.name)]
        candidates = managed or legacy
        if len(candidates) > 1:
            warn("multiple Linkr devices found; use --address to select one")
        return candidates[0].address if candidates else None

    prefix = normalize_name_prefix(name).lower()
    for dev in devices:
        if dev.name and dev.name.lower() == prefix:
            return dev.address

    prefixed = [
        dev for dev in devices
        if dev.name and dev.name.lower().startswith(prefix)
    ]
    if not prefixed:
        return None
    if len(prefixed) > 1:
        matches = ", ".join(
            f"{printable_device_name(dev.name)} ({dev.address})"
            for dev in prefixed[:4]
        )
        warn(
            f"multiple devices match {prefix + '*'}; using "
            f"{printable_device_name(prefixed[0].name)} "
            f"({prefixed[0].address}); matches: {matches}"
        )
    return prefixed[0].address


def describe_devices(devices) -> str:
    """The nearby boards as `name (address)`, for a message that must say
    what to do next rather than only what did not happen."""
    rows = [
        f"  {printable_device_name(dev.name)} ({dev.address})"
        for dev in devices
    ]
    if not rows:
        return "  (nothing nearby was heard)"
    return "\n".join(rows[:6])


def parse_ble_name(text: str, *, query: bool = False) -> str | None:
    """The name out of `OK name=<name>`.

    A query reply appends ` custom=yes|no`; a set or reset reply does not.
    A name that itself ends in " custom=yes" must survive a write parse, so
    the suffix is peeled only when the caller knows it read a query. Nothing
    else is trimmed: the firmware stores trailing U+3000 and NBSP verbatim,
    and a host that strips them would report a name the board never had.
    """
    for line in text.splitlines():
        if not line.lower().startswith("ok name="):
            continue
        name = line[8:]
        if query:
            marker = name.rfind(" custom=")
            if marker >= 0 and name[marker + 8:].lower() in ("yes", "no"):
                name = name[:marker]
        return name
    return None


async def verify_ble_name(management, expected: str | None) -> None:
    """Read `@n?` after a rename and make sure the board agrees.

    A write's own reply can echo the command whether or not the stored name
    took effect; only the query reports the state the board will advertise.
    `expected=None` means the reset form, whose MAC suffix the host cannot
    predict, so only a readable answer is required.
    """
    answer = await management.send(b"@n?")
    reported = parse_ble_name(answer.decode(errors="replace"), query=True)
    if not reported:
        raise RuntimeError(
            "the board did not report its name after the change"
        )
    if expected is not None and reported != expected:
        raise RuntimeError(
            f"the board reports {reported!r} after writing {expected!r}"
        )


async def find_device(name: str | None, address: str | None, timeout: float,
                      devices=None) -> str:
    """Return the BLE address to connect to, reusing a completed scan.

    With no name asked for, the board is found by the service it speaks and
    not by the label it carries: the owner can change that at any time.
    """
    if address:
        return address

    criterion = (f"name {normalize_name_prefix(name)}*" if name is not None
                 else "Linkr Management Service or legacy Linkr BLE UART name")
    if devices is None:
        # bleak is only needed to listen. A caller that hands over a
        # completed scan - the tests, and a host that scanned for something
        # else - is answered without it.
        import_bleak()
        info(f"scanning for BLE device matching {criterion}")
        devices = await discover_devices(timeout)

    if name:
        match = match_device(devices, name)
        if match is None:
            prefix = normalize_name_prefix(name)
            raise RuntimeError(
                f"no board matched {prefix + '*'}. The advertised name is a "
                f"label the owner can change, so a renamed board is found by "
                f"its address instead: pass --address. Nearby devices:\n"
                f"{describe_devices(devices)}"
            )
        return match

    match = match_device(devices, None)
    if match is None:
        raise RuntimeError(
            "no Linkr Bee was found nearby. The advertised name is a label "
            "the owner can change, so a renamed board is found by its "
            "address instead: pass --address. Nearby devices:\n"
            f"{describe_devices(devices)}"
        )
    return match


async def ble_write(client: BleakClient, data: bytes, cfg: TerminalConfig,
                    sensitive: bool = False,
                    reliable: ReliableUartChannel | None = None) -> None:
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

    def __init__(self, client: BleakClient, cfg: TerminalConfig,
                 max_payload: int, json_output: bool = False) -> None:
        self.client = client
        self.cfg = cfg
        self.max_payload = max_payload
        self.json_output = json_output
        self.next_request_id = 1
        self.current: dict | None = None
        self.pending: dict[int, asyncio.Future[bytes]] = {}
        self.pending_final: dict[int, asyncio.Future[bytes]] = {}
        # Command text per in-flight request, so a JSON record can say what it
        # answers. Sensitive commands are stored already redacted.
        self.commands: dict[int, str] = {}

    def on_indication(self, _char, data: bytearray) -> None:
        fragment = bytes(data)
        if self.current is None:
            if len(fragment) < MGMT_HEADER.size or fragment[:2] != b"LK":
                warn("management <- orphaned response fragment")
                return
            magic, version, message_type, request_id, expected, flags = \
                MGMT_HEADER.unpack_from(fragment)
            if magic != b"LK" or version != MGMT_API_MAJOR or \
                    message_type not in (2, 3) or expected == 0 or \
                    expected > self.max_payload:
                warn("management <- invalid response header")
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
            warn("management <- oversized response")
            self.current = None
            return
        payload.extend(fragment)
        if len(payload) != message["expected"]:
            return

        self.current = None
        body = bytes(payload)
        kind = "event" if message["type"] == 3 else "response"
        text = body.decode(errors="replace").rstrip("\r\n")
        lines = text.splitlines() or [""]
        failed = bool(message["flags"] & MGMT_FLAG_ERROR)
        command = self.commands.pop(message["request_id"], None)
        if self.json_output:
            record = {
                "type": kind,
                "requestId": message["request_id"],
                "ok": not failed,
                "lines": lines,
            }
            if command is not None:
                record["command"] = command
            print(json.dumps(record, ensure_ascii=False), flush=True)
        else:
            for line in lines:
                stderr(f"{kind} #{message['request_id']} <- {line}")

        if message["type"] == 2:
            future = self.pending.pop(message["request_id"], None)
            if future and not future.done():
                if failed:
                    future.set_exception(
                        RuntimeError(text or "management request failed")
                    )
                else:
                    future.set_result(body)
        elif message["flags"] & MGMT_FLAG_FINAL:
            future = self.pending_final.pop(message["request_id"], None)
            if future and not future.done():
                if failed:
                    future.set_exception(
                        RuntimeError(text or "management operation failed")
                    )
                else:
                    future.set_result(body)

    async def send(self, command: bytes, delay: float = 0.0,
                   wait_final_timeout: float = 0.0) -> bytes:
        if not command or len(command) > self.max_payload:
            raise ValueError("management command is outside the advertised limit")
        sensitive = command.startswith((b"@w=", b"@d="))
        display = (f"{command[:2].decode()}=<redacted>" if sensitive
                   else command.decode(errors="replace"))
        info(f"control -> {display}")

        request_id = self.next_request_id
        self.next_request_id = 1 if request_id == 0xFFFFFFFF else request_id + 1
        self.commands[request_id] = display
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
            self.commands.pop(request_id, None)


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
                info("reliable UART <- orphaned fragment")
                return
            magic, version, _flags, sequence, expected, _reserved = \
                RELIABLE_UART_HEADER.unpack_from(fragment)
            if magic != b"LR" or version != 1 or sequence == 0 or \
                    expected == 0 or expected > self.max_payload:
                warn("reliable UART <- invalid frame header")
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
            warn("reliable UART <- oversized frame")
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
            warn(
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
        info(f"BLE write chunk size: {cfg.write_size} bytes (manual)")
        return

    # Prefer what the characteristic itself advertises; fall back to the
    # negotiated MTU minus the 3-byte ATT header when a platform (macOS) does
    # not report it. Never exceed a single ATT write.
    try:
        characteristic = client.services.get_characteristic(NUS_RX_UUID)
        reported = int(characteristic.max_write_without_response_size or 0)
    except Exception:
        reported = 0
    try:
        mtu_size = int(getattr(client, "mtu_size", 0) or 0)
    except (TypeError, ValueError):
        mtu_size = 0

    size = reported or (mtu_size - 3 if mtu_size > 3 else 0)
    cfg.write_size = max(20, min(size or 20, 244))
    info(f"BLE write chunk size: {cfg.write_size} bytes")


async def loopback_test(client: BleakClient, payload: bytes, cfg: TerminalConfig,
                        notify_queue: asyncio.Queue[bytes],
                        timeout: float,
                        reliable: ReliableUartChannel | None = None) -> bool:
    while not notify_queue.empty():
        notify_queue.get_nowait()

    info(f"loopback -> {payload!r}")
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
                        reliable: ReliableUartChannel | None = None,
                        geometry: TerminalGeometrySync | None = None) -> None:
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
        if geometry is not None:
            # Typed input invalidates the idle prompt we resize from.
            geometry.mark_busy()
        await ble_write(client, data, cfg, reliable=reliable)

    def on_resize(*_args: object) -> None:
        if geometry is None:
            return
        try:
            size = os.get_terminal_size(fd)
        except OSError:
            return
        geometry.set_size(size.columns, size.lines)

    signal_installed = False
    if geometry is not None and tty is not None and hasattr(signal, "SIGWINCH"):
        with contextlib.suppress(NotImplementedError, ValueError, OSError):
            loop.add_signal_handler(signal.SIGWINCH, on_resize)
            signal_installed = True
        on_resize()

    info(f"terminal open. press {describe_escape(cfg.escape)} to exit.")
    terminal_context = contextlib.nullcontext() if cfg.line_mode else RawTerminal(fd)
    try:
        with terminal_context:
            threading.Thread(target=stdin_reader, daemon=True).start()
            task = asyncio.create_task(sender())
            try:
                await done.wait()
            finally:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
    finally:
        if signal_installed:
            loop.remove_signal_handler(signal.SIGWINCH)
    info("terminal closed.")


def has_control_action(args: argparse.Namespace) -> bool:
    """True when the invocation asks for more than opening a terminal.

    --scan uses this to decide whether listing devices is the whole job. Both
    clients follow the same rule: --scan exits unless another action, or an
    explicit --address, was requested.
    """
    return any((
        args.query_info, args.query_uart, args.uart, args.wifi,
        args.wifi_scan, args.wifi_off, args.query_wifi, args.webdav,
        args.webdav_off, args.query_webdav, args.rename_ble,
        args.reset_ble_name, args.query_ble_name,
        args.loopback_test is not None, args.pair,
    ))


# Shell completions are generated from the parser instead of checked in, so a
# new option cannot be added without appearing in them. The C client ships the
# same flag and the options it shares are asserted to match.
COMPLETION_SHELLS = ("bash", "fish", "zsh")
# The names the client is invoked under: the script itself and the PyInstaller
# binary built by tools/build_terminal_binary.sh.
COMPLETION_COMMANDS = ("linkr_ble_terminal.py", "linkr-ble-terminal")
# argparse cannot say "this value is a path", so those options are listed here.
COMPLETION_FILE_OPTIONS = ("--log-file", "--wifi-key-file")


def completion_label(text: str) -> str:
    """Flatten help text for a completion spec.

    Every shell treats brackets, quotes and colons as syntax inside a spec, so
    the text is reduced to plain words. An option like `--wifi SSID[,PASSWORD]`
    would otherwise break the generated zsh script. Apostrophes survive and are
    escaped where the spec is written.
    """
    text = " ".join((text or "").split())
    for bad in "[](){}\"`:,*_":
        text = text.replace(bad, " ")
    return " ".join(text.split())


def completion_entries(parser: argparse.ArgumentParser) -> list[dict]:
    """One entry per option string the parser accepts, in --help order."""
    entries = []
    # parser._actions is private but is the only place argparse exposes the
    # option strings; a test asserts every one of them reaches the scripts.
    for action in parser._actions:
        if not action.option_strings:
            continue
        takes_value = action.nargs != 0
        choices = [str(value) for value in (action.choices or ())]
        for flag in action.option_strings:
            if not takes_value:
                kind, values = "flag", []
            elif flag in COMPLETION_FILE_OPTIONS:
                kind, values = "file", []
            elif choices:
                kind, values = "choices", choices
            else:
                kind, values = "value", []
            entries.append({
                "flag": flag,
                "kind": kind,
                "values": values,
                "help": completion_label(action.help or ""),
                # argparse only fills metavar when the author set one; the dest
                # reads better in a completion popup than a bare "value".
                "label": completion_label(action.metavar or action.dest) or "value",
            })
    return entries


def _bash_completion(entries: list[dict]) -> str:
    flags = " ".join(entry["flag"] for entry in entries)
    lines = [
        "# bash completion for the Linkr BLE host CLI.",
        "# Generated by --print-completion; do not edit by hand.",
        "#",
        "#   source <(linkr_ble_terminal.py --print-completion bash)",
        "# or install it once:",
        "#   linkr_ble_terminal.py --print-completion bash > \\",
        "#       ~/.local/share/bash-completion/completions/linkr_ble_terminal.py",
        "_linkr_ble_terminal() {",
        "    local cur prev",
        '    cur="${COMP_WORDS[COMP_CWORD]}"',
        '    prev="${COMP_WORDS[COMP_CWORD-1]}"',
        "",
        '    case "$prev" in',
    ]
    for entry in entries:
        if entry["kind"] == "choices":
            words = " ".join(entry["values"])
            lines.append(
                f"        {entry['flag']}) "
                f"COMPREPLY=( $(compgen -W \"{words}\" -- \"$cur\") ); return ;;")
    files = "|".join(e["flag"] for e in entries if e["kind"] == "file")
    if files:
        lines.append(
            f"        {files}) COMPREPLY=( $(compgen -f -- \"$cur\") ); return ;;")
    value_entries = [e for e in entries if e["kind"] in ("choices", "file")]
    lines += [
        "    esac",
        "",
    ]
    # The parser accepts --flag=value, so complete the value after the '=' too.
    # zsh gets this from the "=" in its specs and fish handles it for -l options;
    # bash has to be told, otherwise only the separate-value form completes.
    if value_entries:
        lines.append('    case "$cur" in')
        for entry in value_entries:
            if entry["kind"] != "choices":
                continue
            words = " ".join(entry["values"])
            lines.append(
                f"        {entry['flag']}=*) "
                f"COMPREPLY=( $(compgen -W \"{words}\" "
                f"-P \"${{cur%%=*}}=\" -- \"${{cur#*=}}\") ); return ;;")
        if files:
            lines.append(
                f"        {files}=*) COMPREPLY=( $(compgen -f "
                f"-P \"${{cur%%=*}}=\" -- \"${{cur#*=}}\") ); return ;;")
        lines += [
            "    esac",
            "",
        ]
    lines += [
        '    if [[ "$cur" == -* ]]; then',
        f'        COMPREPLY=( $(compgen -W "{flags}" -- "$cur") )',
        "    fi",
        "    return 0",
        "}",
        f"complete -F _linkr_ble_terminal {' '.join(COMPLETION_COMMANDS)}",
        "",
    ]
    return "\n".join(lines)


def _zsh_completion(entries: list[dict]) -> str:
    specs = []
    for entry in entries:
        flag = entry["flag"]
        if entry["kind"] == "choices":
            # zsh reads the action field `(...)` as a space-separated list.
            action = "(" + " ".join(entry["values"]) + ")"
            specs.append(f"{flag}=[{entry['help']}]:{entry['label']}:{action}")
        elif entry["kind"] == "file":
            specs.append(f"{flag}=[{entry['help']}]:file:_files")
        elif entry["kind"] == "value":
            specs.append(f"{flag}=[{entry['help']}]:{entry['label']}:")
        else:
            specs.append(f"{flag}[{entry['help']}]")
    # The spec is written inside single quotes, so an apostrophe in the help
    # text (argparse's own "--version" text has one) has to close and reopen it.
    indented = " \\\n".join(
        "        '" + spec.replace("'", "'\\''") + "'" for spec in specs)
    commands = " ".join(COMPLETION_COMMANDS)
    return "\n".join([
        f"#compdef {commands}",
        "# zsh completion for the Linkr BLE host CLI.",
        "# Generated by --print-completion; do not edit by hand.",
        "#",
        "#   source <(linkr_ble_terminal.py --print-completion zsh)",
        "# or install it once:",
        "#   linkr_ble_terminal.py --print-completion zsh > \\",
        "#       \"${fpath[1]}/_linkr_ble_terminal\"",
        "_linkr_ble_terminal() {",
        "    _arguments -s -S \\",
        indented,
        "}",
        "",
        'if [ "$funcstack[1]" = "_linkr_ble_terminal" ]; then',
        '    _linkr_ble_terminal "$@"',
        "else",
        f"    compdef _linkr_ble_terminal {commands}",
        "fi",
        "",
    ])


def _fish_escape(text: str) -> str:
    """fish reads the description as a single-quoted string."""
    return text.replace("\\", "\\\\").replace("'", "\\'")


def _fish_completion(entries: list[dict]) -> str:
    lines = [
        "# fish completion for the Linkr BLE host CLI.",
        "# Generated by --print-completion; do not edit by hand.",
        "#",
        "#   linkr_ble_terminal.py --print-completion fish > \\",
        "#       ~/.config/fish/completions/linkr_ble_terminal.py.fish",
    ]
    for command in COMPLETION_COMMANDS:
        for entry in entries:
            flag = entry["flag"]
            parts = [f"complete -c {command}"]
            if flag.startswith("--"):
                parts.append(f"-l {flag[2:]}")
            else:
                parts.append(f"-s {flag[1:]}")
            if entry["kind"] == "choices":
                # -x is "requires a value and complete no files".
                parts.append(f"-x -a '{' '.join(entry['values'])}'")
            elif entry["kind"] == "file":
                parts.append("-r -F")
            elif entry["kind"] == "value":
                parts.append("-r -f")
            parts.append(f"-d '{_fish_escape(entry['help'])}'")
            lines.append(" ".join(parts))
    lines.append("")
    return "\n".join(lines)


def completion_script(shell: str, parser: argparse.ArgumentParser) -> str:
    entries = completion_entries(parser)
    if shell == "bash":
        return _bash_completion(entries)
    if shell == "fish":
        return _fish_completion(entries)
    if shell == "zsh":
        return _zsh_completion(entries)
    raise ValueError(
        f"unsupported shell: {shell!r}; expected one of "
        + ", ".join(COMPLETION_SHELLS)
    )


async def run(args: argparse.Namespace) -> int:
    # Resolve WiFi credentials before anything radio related: a bad spec or a
    # missing password should fail fast, and the prompt must not fight the
    # terminal for the tty. Keeping the password out of argv is the point here.
    wifi_command: bytes | None = None
    if args.wifi:
        prompt = getpass.getpass if sys.stdin.isatty() else None
        try:
            ssid, password = resolve_wifi_credentials(
                args.wifi, args.wifi_key_file, prompt=prompt)
        except ValueError as exc:
            error(str(exc))
            return EXIT_USAGE
        wifi_command = f"@w={ssid},{password}".encode()

    import_bleak()

    scanned = None
    if args.scan:
        scanned = await scan_devices(args.timeout)
        if not args.address and not has_control_action(args):
            return EXIT_OK

    target = await find_device(args.name, args.address, args.timeout,
                               devices=scanned)
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
    notify_queue: asyncio.Queue[bytes] | None = None
    loop = asyncio.get_running_loop()
    reliable: ReliableUartChannel | None = None
    geometry: TerminalGeometrySync | None = None
    geometry_tasks: set[asyncio.Task] = set()
    try:
        fd: int | None = sys.stdin.fileno()
    except (AttributeError, OSError, ValueError):
        # Scripted use may run with no usable stdin at all.
        fd = None

    if not args.no_terminal and fd is not None and os.isatty(fd):
        try:
            size = os.get_terminal_size(fd)
        except OSError:
            size = None
        if size is not None:
            geometry = TerminalGeometrySync(size.columns, size.lines)

    def on_disconnect(_client: BleakClient) -> None:
        loop.call_soon_threadsafe(disconnected.set)

    async def send_geometry(command: str) -> None:
        try:
            await ble_write(client, command.encode(), cfg, reliable=reliable)
        except Exception as exc:
            assert geometry is not None
            geometry.abort_sent()
            warn(f"terminal size sync failed: {exc}")
        else:
            assert geometry is not None
            geometry.confirm_sent()

    def handle_geometry(payload: bytes) -> None:
        """Runs on the event loop: geometry state stays single-threaded."""
        if geometry is None:
            return
        geometry.observe(payload.decode("utf-8", "replace"))
        command = geometry.take_pending_command()
        if command is not None:
            task = asyncio.ensure_future(send_geometry(command))
            geometry_tasks.add(task)
            task.add_done_callback(geometry_tasks.discard)

    info("connecting...")
    info("new host: hold the Bee pairing GPIO to GND before pairing "
         "(GPIO1 C3/C5, GPIO4 WROOM). Bonded hosts reconnect without it.")
    log_file = open(args.log_file, "ab", buffering=0) if args.log_file else None

    try:
        async with BleakClient(target, disconnected_callback=on_disconnect,
                               timeout=args.timeout) as client:
            info(f"connected: {client.address}")

            if args.pair:
                if sys.platform == "darwin":
                    info("macOS requests pairing when the encrypted service is "
                         "read; accept the system dialog.")
                else:
                    await client.pair()

            def on_notify(_char, data: bytearray) -> None:
                payload = bytes(data)
                if notify_queue is not None:
                    notify_queue.put_nowait(payload)
                if args.debug_io:
                    stderr(f"RX {payload!r}")
                if log_file:
                    log_file.write(payload)
                if geometry is not None:
                    loop.call_soon_threadsafe(handle_geometry, payload)
                sys.stdout.buffer.write(payload)
                sys.stdout.buffer.flush()

            configure_ble_write_size(client, cfg, args.ble_write_size)
            protocol = bytes(await client.read_gatt_char(MGMT_PROTOCOL_UUID))
            if len(protocol) < 10 or protocol[0] != MGMT_API_MAJOR:
                raise RuntimeError("unsupported Linkr Management API version")
            capabilities = int.from_bytes(protocol[4:8], "little")
            management_max_payload = int.from_bytes(protocol[2:4], "little")
            if management_max_payload == 0:
                raise RuntimeError("invalid Linkr Management payload limit")
            if not capabilities & MGMT_CAP_DEVICE_ID:
                raise RuntimeError("device does not advertise Device ID support")
            if not capabilities & MGMT_CAP_RELIABLE_UART:
                raise RuntimeError("device does not advertise Reliable UART support")
            wifi_actions = any((
                args.wifi, args.wifi_scan, args.wifi_off, args.query_wifi,
            ))
            if wifi_actions and not capabilities & MGMT_CAP_WIFI:
                raise RuntimeError("device does not advertise WiFi support")
            async_wifi_actions = any((args.wifi, args.wifi_scan, args.wifi_off))
            if async_wifi_actions and not capabilities & MGMT_CAP_ASYNC_EVENTS:
                raise RuntimeError("device does not advertise async event support")
            webdav_actions = any((
                args.webdav, args.webdav_off, args.query_webdav,
            ))
            if webdav_actions and not capabilities & MGMT_CAP_WEBDAV:
                raise RuntimeError("device does not advertise WebDAV support")
            device_id = bytes(await client.read_gatt_char(MGMT_DEVICE_ID_UUID))
            if not is_linkr_device_id(device_id):
                raise RuntimeError("invalid Linkr Device ID")
            info(
                f"management API v{protocol[0]}.{protocol[1]}, "
                f"device ID {device_id.hex()}"
            )
            management = ManagementChannel(
                client, cfg, management_max_payload, json_output=args.json
            )
            await client.start_notify(
                MGMT_RESPONSE_UUID, management.on_indication
            )
            reliable_state = bytes(
                await client.read_gatt_char(RELIABLE_UART_STATE_UUID)
            )
            if len(reliable_state) != 16 or reliable_state[0] != 1:
                raise RuntimeError("unsupported Reliable UART version")
            reliable_max_payload = int.from_bytes(reliable_state[2:4], "little")
            reliable_tx_sequence = int.from_bytes(reliable_state[4:8], "little")
            reliable_rx_sequence = int.from_bytes(reliable_state[8:12], "little")
            if not reliable_max_payload or not reliable_tx_sequence or \
                    not reliable_rx_sequence:
                raise RuntimeError("invalid Reliable UART state")
            reliable = ReliableUartChannel(
                client,
                cfg,
                reliable_max_payload,
                reliable_tx_sequence,
                reliable_rx_sequence,
                on_notify,
            )
            await client.start_notify(
                RELIABLE_UART_TX_UUID, reliable.on_indication
            )

            # The board's own name, not the label the air carried: the owner
            # can change that label at any time, and a session that reported
            # the old one would be naming a board it is not talking to.
            try:
                answer = await management.send(b"@n?")
            except Exception as exc:  # a board that predates the command
                info(f"the board did not report its name: {exc}")
            else:
                name = parse_ble_name(
                    answer.decode(errors="replace"), query=True
                )
                if name:
                    info(f"board name: {name}")

            if args.query_info:
                await management.send(b"@i?")

            if args.uart:
                await management.send(f"@u={args.uart}".encode())

            if args.query_uart:
                await management.send(b"@u?")

            if wifi_command is not None:
                await management.send(
                    wifi_command,
                    wait_final_timeout=WIFI_OPERATION_TIMEOUT,
                )

            if args.wifi_off:
                await management.send(
                    b"@w off", wait_final_timeout=WIFI_OPERATION_TIMEOUT
                )

            if args.query_wifi:
                await management.send(b"@w?")

            if args.wifi_scan:
                await management.send(
                    b"@w scan", wait_final_timeout=WIFI_SCAN_TIMEOUT
                )

            if args.webdav:
                await management.send(f"@d={args.webdav}".encode())

            if args.webdav_off:
                await management.send(b"@d off")

            if args.query_webdav:
                await management.send(b"@d?")

            if args.rename_ble is not None:
                # A write's reply echoes the requested name, not the state
                # the board will advertise; read it back before saying it
                # worked.
                await management.send(f"@n={args.rename_ble}".encode())
                await verify_ble_name(management, args.rename_ble)

            if args.reset_ble_name:
                await management.send(b"@n default")
                await verify_ble_name(management, None)

            if args.query_ble_name:
                await management.send(b"@n?")

            if args.loopback_test is not None:
                payload = args.loopback_test.encode()
                notify_queue = asyncio.Queue()
                try:
                    ok = await loopback_test(client, payload, cfg, notify_queue,
                                             args.loopback_timeout, reliable)
                finally:
                    # Ordinary terminal output has no queue consumer.
                    notify_queue = None
                if not ok:
                    raise RuntimeError("loopback test failed")

            if args.no_terminal:
                await stop_channels(client)
                return EXIT_OK

            terminal = asyncio.create_task(
                terminal_loop(client, cfg, reliable, geometry)
            )
            disconnect = asyncio.create_task(disconnected.wait())
            done, pending = await asyncio.wait(
                {terminal, disconnect}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            if disconnect in done:
                # Raw mode leaves the cursor mid-line, so start a fresh one.
                stderr("")
                error("BLE disconnected during the terminal session")
                return EXIT_DEVICE_DISCONNECTED
            terminal.result()
            await stop_channels(client)
            return EXIT_OK
    finally:
        for task in list(geometry_tasks):
            task.cancel()
        # Settle the cancellations so the loop does not close over live tasks.
        with contextlib.suppress(Exception):
            await asyncio.gather(*geometry_tasks, return_exceptions=True)
        if log_file:
            log_file.close()


async def stop_channels(client: BleakClient) -> None:
    with contextlib.suppress(Exception):
        await client.stop_notify(MGMT_RESPONSE_UUID)
    with contextlib.suppress(Exception):
        await client.stop_notify(RELIABLE_UART_TX_UUID)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Terminal over BLE Nordic UART Service for Linkr Bee bridge"
    )
    parser.add_argument("--version", action="version",
                        version=f"%(prog)s {__version__}")
    parser.add_argument(
        "--name",
        default=None,
        help="explicit BLE name/prefix filter; by default the board is found "
             "by the Linkr Management Service, because the advertised name is "
             "a label the owner can change",
    )
    parser.add_argument("--address", help="BLE address/UUID; skips name scan")
    parser.add_argument("--scan", action="store_true",
                        help="list nearby BLE devices (all of them, named or not)")
    parser.add_argument("--timeout", type=positive_float, default=8.0,
                        help="scan timeout seconds")
    parser.add_argument("--query-info", action="store_true",
                        help="send @i? device diagnostics before terminal")
    parser.add_argument("--query-uart", action="store_true", help="send @u? before terminal")
    parser.add_argument("--uart", type=normalize_uart_spec,
                        help="set UART as baud,data,parity,stop,flow "
                             "(baud 300-3000000, data 5-8, parity n/o/e, "
                             "stop 1/2, flow n/rtscts)")
    parser.add_argument("--wifi", metavar="SSID[,PASSWORD]",
                        help="connect ESP32 to WiFi; prefer ssid alone with "
                             "--wifi-key-file so the password stays out of argv")
    parser.add_argument("--wifi-key-file", metavar="PATH",
                        help="read the WiFi password from the first line of PATH")
    parser.add_argument("--wifi-off", action="store_true", help="forget saved WiFi")
    parser.add_argument("--query-wifi", action="store_true", help="send @w? before terminal")
    parser.add_argument("--wifi-scan", action="store_true",
                        help="scan nearby 2.4 GHz WiFi networks")
    parser.add_argument("--webdav", help="set anonymous HTTP WebDAV upload URL")
    parser.add_argument("--webdav-off", action="store_true", help="disable WebDAV upload")
    parser.add_argument("--query-webdav", action="store_true", help="send @d? before terminal")
    parser.add_argument("--query-ble-name", action="store_true",
                        help="send @n? and print the advertised BLE name")
    parser.add_argument("--rename-ble", type=normalize_ble_name, metavar="NAME",
                        help="set a custom advertised BLE name (1-29 UTF-8 bytes)")
    parser.add_argument("--reset-ble-name", action="store_true",
                        help="restore the MAC-derived advertised BLE name")
    parser.add_argument("--pair", action="store_true",
                        help="request OS bonding (hold pairing GPIO low: GPIO1 C3/C5, "
                             "GPIO4 WROOM); macOS pairs on encrypted reads")
    parser.add_argument("--loopback-test", nargs="?", const="A",
                        help="send payload and require the same bytes back")
    parser.add_argument("--loopback-timeout", type=positive_float, default=3.0,
                        help="seconds to wait for --loopback-test echo")
    parser.add_argument("--no-terminal", action="store_true", help="connect, run commands, exit")
    parser.add_argument("--json", action="store_true",
                        help="write management responses/events to stdout as JSON "
                             "lines (sensitive command text stays redacted)")
    parser.add_argument("--quiet", action="store_true",
                        help="suppress progress messages; errors and results still print")
    # argparse renders the choices in --help on its own.
    parser.add_argument("--print-completion", choices=COMPLETION_SHELLS,
                        help="print a shell completion script and exit")
    parser.add_argument("--ble-write-size", type=ble_write_size, default=0,
                        help="terminal write size; default auto; management uses at least 20")
    parser.add_argument("--write-response", action="store_true",
                        help="use GATT write-with-response")
    parser.add_argument("--write-delay-ms", type=nonnegative_float, default=5.0,
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
    global _QUIET
    parser = build_parser()
    args = parser.parse_args()
    # Both flags used to send their command in turn, so the last one won and
    # the requested name could be stored or erased depending on argument
    # order. Reject the pair before any radio work; argparse exits 2.
    if args.rename_ble is not None and args.reset_ble_name:
        parser.error("--rename-ble and --reset-ble-name are mutually exclusive")
    _QUIET = args.quiet
    if args.print_completion:
        # Before any radio work: this must run on a host without bleak.
        print(completion_script(args.print_completion, parser))
        return EXIT_OK
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        error(str(exc))
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
