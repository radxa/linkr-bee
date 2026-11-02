"""CLI session recovery: real orchestration over an in-memory BLE peripheral."""
import asyncio
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_terminal():
    spec = importlib.util.spec_from_file_location(
        'linkr_reconnect_test', ROOT / 'tools/linkr_ble_terminal.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {spec.name: module}):
        spec.loader.exec_module(module)
    return module


class JsonCredentialTests(unittest.IsolatedAsyncioTestCase):
    async def test_result_commands_share_transport_redaction(self):
        terminal = load_terminal()

        class Management:
            async def send(self, command, **_kwargs):
                sent.append(command)
                return b'OK\r\n'

        for command in ('@w=Lab,synthetic-secret',
                        '@d=http://example.test/?token=synthetic-secret'):
            with self.subTest(command=command[:2]):
                sent = []
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    await terminal.send_reported(
                        Management(), command, json_output=True)
                self.assertNotIn('synthetic-secret', output.getvalue())
                self.assertEqual(json.loads(output.getvalue())['command'],
                                 command[:2] + '=<redacted>')
                self.assertEqual(sent, [command.encode()],
                                 'only the displayed command is redacted')


class SessionRecoveryTests(unittest.TestCase):
    def exercise(self, argv, *, faults=None, changed_id=False, command_error=None):
        terminal = load_terminal()
        faults = faults or {}
        selected, sent, scans, sleeps, errors = [], [], [], [], []
        original_loop = terminal.session_loop

        class Client:
            def __init__(self, target, disconnected_callback, **_kwargs):
                self.address = target
                self.callback = disconnected_callback
                selected.append(target)
                self.number = len(selected)

            def fail(self, step):
                if (self.number, step) in faults:
                    raise faults[self.number, step]

            async def __aenter__(self):
                self.fail('connect')
                return self

            async def __aexit__(self, *_args):
                return False

            async def read_gatt_char(self, uuid):
                self.fail(uuid)
                if uuid == terminal.MGMT_PROTOCOL_UUID:
                    caps = (terminal.MGMT_CAP_DEVICE_ID | terminal.MGMT_CAP_RELIABLE_UART |
                            terminal.MGMT_CAP_WIFI | terminal.MGMT_CAP_ASYNC_EVENTS)
                    return (bytes([1, 0]) + (512).to_bytes(2, 'little') +
                            caps.to_bytes(4, 'little') + bytes(2))
                if uuid == terminal.MGMT_DEVICE_ID_UUID:
                    tail = 2 if changed_id and self.number > 1 else 1
                    return b'LINKRBLE\x01\x00' + bytes([tail]) * 6
                return (bytes([1, 0]) + (232).to_bytes(2, 'little') +
                        (1).to_bytes(4, 'little') * 2 + bytes(4))

            async def start_notify(self, uuid, _callback):
                self.fail(uuid)
                if uuid == terminal.RELIABLE_UART_TX_UUID:
                    asyncio.get_running_loop().call_later(.001, self.callback, self)

            async def stop_notify(self, _uuid):
                pass

        class Management:
            def __init__(self, client, *_args, **_kwargs):
                self.client = client

            def on_indication(self, *_args):
                pass

            async def send(self, command, **_kwargs):
                sent.append((self.client.number, command))
                if command.startswith(b'@o pulse') and command_error:
                    raise command_error
                return b'OK name=Bench custom=yes' if command == b'@n?' else b'OK'

        async def discover(_timeout):
            scans.append(True)
            address = 'AA:BB:CC:DD:EE:01' if len(scans) == 1 else 'AA:BB:CC:DD:EE:02'
            return [terminal.DiscoveredDevice(
                'Linkr Bee', address, -40, (terminal.MGMT_SERVICE_UUID,))]

        # Management output and UART bytes have distinct streams in the mock,
        # just as stdout's text wrapper and buffer do in a real process.
        output = io.StringIO()
        output.buffer = io.BytesIO()
        with patch.object(terminal, 'BleakClient', Client), \
                patch.object(terminal, 'ManagementChannel', Management), \
                patch.object(terminal, 'import_bleak'), \
                patch.object(terminal, 'discover_devices', discover), \
                patch.object(terminal, 'configure_ble_write_size'), \
                patch.object(terminal, 'session_loop',
                             lambda once, attempts: original_loop(once, attempts, sleep=sleeps.append)), \
                patch.object(terminal, 'info'), patch.object(terminal, 'stderr'), \
                patch.object(terminal, 'error', errors.append), \
                patch.object(terminal.sys, 'stdout', output), \
                patch.object(terminal.sys, 'argv', ['terminal', '--no-host-name', *argv]):
            code = terminal.main()
        return code, selected, sent, scans, sleeps, errors

    def test_reconnect_keeps_the_first_address_and_never_replays_commands(self):
        code, selected, sent, scans, sleeps, _ = self.exercise([
            '--monitor', '--reconnect', '1', '--opto-pulse', '500',
            '--bonds-remove', '0/AA:BB:CC:DD:EE:03', '--cmd', '@r send 1'])
        self.assertEqual(code, 3)
        self.assertEqual(selected, ['AA:BB:CC:DD:EE:01'] * 2)
        self.assertEqual(len(scans), 1)
        self.assertEqual(len(sleeps), 1)
        for command in (b'@o pulse 500', b'@linkr bonds remove 0/AA:BB:CC:DD:EE:03',
                        b'@r send 1'):
            self.assertEqual([number for number, cmd in sent if cmd == command], [1])

    def test_failed_redial_spends_the_remaining_budget(self):
        code, selected, sent, scans, sleeps, _ = self.exercise(
            ['--monitor', '--reconnect', '2', '--opto-pulse', '500'],
            faults={(2, 'connect'): OSError('adapter unavailable')})
        self.assertEqual(code, 3)
        self.assertEqual(selected, ['AA:BB:CC:DD:EE:01'] * 3)
        self.assertEqual(len(sleeps), 2)
        self.assertEqual(len(scans), 1)
        self.assertEqual([cmd for _, cmd in sent].count(b'@o pulse 500'), 1)

    def test_failed_gatt_setup_is_also_retried(self):
        terminal = load_terminal()
        for step in (terminal.MGMT_PROTOCOL_UUID, terminal.MGMT_DEVICE_ID_UUID,
                     terminal.MGMT_RESPONSE_UUID, terminal.RELIABLE_UART_STATE_UUID,
                     terminal.RELIABLE_UART_TX_UUID):
            with self.subTest(step=step):
                code, selected, sent, _, sleeps, _ = self.exercise(
                    ['--monitor', '--reconnect', '2', '--opto-pulse', '500'],
                    faults={(2, step): TimeoutError('GATT unavailable')})
                self.assertEqual(code, 3)
                self.assertEqual(len(selected), 3)
                self.assertEqual(len(sleeps), 2)
                self.assertEqual([cmd for _, cmd in sent].count(b'@o pulse 500'), 1)

    def test_changed_hardware_id_stops_before_any_commands_on_the_new_board(self):
        code, selected, sent, _, sleeps, errors = self.exercise(
            ['--monitor', '--reconnect', '3', '--opto-pulse', '500'], changed_id=True)
        self.assertEqual(code, 1)
        self.assertEqual(len(selected), 2)
        self.assertEqual(len(sleeps), 1)
        self.assertFalse(any(number > 1 for number, _ in sent))
        self.assertIn('device ID changed', errors[-1])

    def test_command_refusal_or_lost_ack_is_not_retried(self):
        for error in (RuntimeError('ERR control=readonly'), TimeoutError('ack lost')):
            with self.subTest(error=type(error).__name__):
                code, selected, sent, _, sleeps, _ = self.exercise(
                    ['--monitor', '--reconnect', '3', '--opto-pulse', '500'],
                    command_error=error)
                self.assertEqual(code, 1)
                self.assertEqual(len(selected), 1)
                self.assertEqual(sleeps, [])
                self.assertEqual([cmd for _, cmd in sent].count(b'@o pulse 500'), 1)

    def test_initial_connection_failure_remains_an_error(self):
        code, selected, _, _, sleeps, _ = self.exercise(
            ['--monitor', '--reconnect', '3'],
            faults={(1, 'connect'): OSError('adapter unavailable')})
        self.assertEqual(code, 1)
        self.assertEqual(len(selected), 1)
        self.assertEqual(sleeps, [])

    def test_scan_continues_for_new_commands_and_monitor(self):
        cases = [
            ['--bonds'], ['--bonds-names'], ['--query-control'], ['--claim'], ['--release'],
            ['--led', 'off'], ['--query-led'], ['--opto', 'on'], ['--opto-pulse', '500'],
            ['--query-opto'], ['--bonds-remove', '0/AA:BB:CC:DD:EE:03'], ['--cmd', '@l?'],
            ['--monitor'],
        ]
        for flags in cases:
            with self.subTest(flags=flags):
                ending = [] if '--monitor' in flags else ['--no-terminal']
                code, selected, sent, scans, _, _ = self.exercise(['--scan', *flags, *ending])
                self.assertEqual(code, 3 if '--monitor' in flags else 0)
                self.assertEqual(len(selected), 1)
                self.assertEqual(len(scans), 1)
                if '--monitor' not in flags:
                    self.assertGreater(len(sent), 1, 'the requested command must be sent')

    def test_scan_alone_does_not_connect(self):
        code, selected, sent, scans, _, _ = self.exercise(['--scan'])
        self.assertEqual(code, 0)
        self.assertEqual(len(scans), 1)
        self.assertEqual(selected, [])
        self.assertEqual(sent, [])


if __name__ == '__main__':
    unittest.main()
