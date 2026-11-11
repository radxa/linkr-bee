"""Unit tests for the Python host CLI (tools/linkr_ble_terminal.py).

Run with: python3 -m unittest discover -s tests -v

The module is loaded straight from disk. It must import without bleak
installed: --help/--version, the argument validators and the pure protocol
helpers never touch the radio.
"""

import argparse
import asyncio
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parents[1]
TERMINAL_PATH = ROOT / "tools/linkr_ble_terminal.py"


def load_terminal():
    spec = importlib.util.spec_from_file_location("linkr_terminal_cli", TERMINAL_PATH)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {spec.name: module}):
        spec.loader.exec_module(module)
    return module


terminal = load_terminal()


def cfg(**overrides):
    values = dict(escape=b"\x1d", enter="raw", local_echo=False, line_mode=False,
                  debug_io=False, write_size=20, write_response=False,
                  write_delay=0.0)
    values.update(overrides)
    return terminal.TerminalConfig(**values)


def mgmt_frame(message_type, request_id, payload, flags=0):
    return terminal.MGMT_HEADER.pack(
        b"LK", terminal.MGMT_API_MAJOR, message_type, request_id, len(payload), flags
    ) + payload


def uart_frame(sequence, payload):
    return terminal.RELIABLE_UART_HEADER.pack(
        b"LR", 1, 0, sequence, len(payload), 0
    ) + payload


class FakeDevice:
    def __init__(self, name, address, rssi=None, service_uuids=()):
        self.name = name
        self.address = address
        self.rssi = rssi
        self.service_uuids = service_uuids


class FakeWriteClient:
    def __init__(self):
        self.writes = []

    async def write_gatt_char(self, uuid, chunk, response=True):
        self.writes.append((uuid, bytes(chunk)))


class ParserTests(unittest.TestCase):
    """The CLI must be usable before bleak is installed."""

    def run_cli(self, *arguments, env=None):
        return subprocess.run(
            [sys.executable, str(TERMINAL_PATH), *arguments],
            capture_output=True, text=True, timeout=30,
            stdin=subprocess.DEVNULL, env=env,
        )

    def test_help_works_without_bleak(self):
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("usage:", result.stdout)
        self.assertIn("--wifi-key-file", result.stdout)
        self.assertIn("--rename-ble", result.stdout)
        self.assertNotIn("Traceback", result.stderr)

    def test_version_works_without_bleak(self):
        result = self.run_cli("--version")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(terminal.__version__, result.stdout)

    def test_bad_uart_spec_is_rejected_before_touching_the_radio(self):
        result = self.run_cli("--uart", "abc,8,n,1,n")
        self.assertEqual(result.returncode, 2)
        self.assertIn("baud", result.stderr)
        self.assertNotIn("bleak", result.stderr.lower())

    def test_missing_bleak_is_a_clean_error(self):
        module = load_terminal()
        with patch.dict(sys.modules, {"bleak": None}):
            with self.assertRaisesRegex(RuntimeError, "pip install bleak"):
                module.import_bleak()

    def test_missing_wifi_password_is_reported_before_the_radio_is_touched(self):
        env = {key: value for key, value in os.environ.items()
               if key != terminal.WIFI_PASSWORD_ENV}
        result = self.run_cli("--wifi", "MySSID", "--no-terminal",
                              "--address", "AA:BB", env=env)
        self.assertEqual(result.returncode, 2)
        self.assertIn("no WiFi password available", result.stderr)
        self.assertNotIn("bleak", result.stderr.lower())

    def test_uart_spec_accepts_spellings_the_firmware_accepts(self):
        parser = terminal.build_parser()
        args = parser.parse_args(["--uart", "115200, 8, none, 1, hw"])
        self.assertEqual(args.uart, "115200,8,n,1,rtscts")

    def test_ble_name_validation_matches_the_firmware(self):
        parser = terminal.build_parser()
        for name in ("Bench Bee", "测试😀", "😀" * 7):
            with self.subTest(name=name):
                self.assertEqual(
                    parser.parse_args(["--rename-ble", name]).rename_ble, name)
        # Surrounding ASCII whitespace is trimmed rather than stored; NBSP and
        # U+3000 are ordinary name bytes, exactly as the firmware sees them.
        self.assertEqual(
            parser.parse_args(["--rename-ble", "  Bee  "]).rename_ble, "Bee")
        self.assertEqual(
            parser.parse_args(["--rename-ble", "\u00a0Bee\u3000"]).rename_ble,
            "\u00a0Bee\u3000")
        for name in ("", "   ", "😀" * 8, "one\ntwo", "del\x7f",
                     "c1\u0085", "line\u2028sep", "para\u2029sep"):
            with self.subTest(name=name):
                with self.assertRaises(SystemExit):
                    parser.parse_args(["--rename-ble", name])

    def test_ble_name_reply_parsing_takes_customness_only_from_a_query(self):
        module = load_terminal()
        self.assertEqual(
            module.parse_ble_name("OK name=Bench Bee custom=yes", query=True),
            "Bench Bee")
        # A name that itself ends in the suffix text survives a query parse:
        # only the final field belongs to the reply.
        self.assertEqual(
            module.parse_ble_name("OK name=Bee custom=yes custom=no", query=True),
            "Bee custom=yes")
        # A write's reply has no custom field to peel.
        self.assertEqual(
            module.parse_ble_name("OK name=Bee custom=yes"),
            "Bee custom=yes")
        self.assertEqual(
            module.parse_ble_name("OK name=Bee\u3000 custom=no", query=True),
            "Bee\u3000")

    def test_device_names_from_the_air_cannot_drive_the_terminal(self):
        module = load_terminal()
        self.assertEqual(
            module.printable_device_name("Bee\x1b[2J\x85name"), "Bee[2Jname")
        self.assertEqual(module.printable_device_name(None), "(unknown)")
        self.assertEqual(module.printable_device_name("\x1b"), "(unknown)")

    def test_rename_and_reset_cannot_both_be_asked_for(self):
        result = self.run_cli("--rename-ble", "Bee", "--reset-ble-name")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--rename-ble and --reset-ble-name are mutually exclusive",
                      result.stderr)
        # The parser refuses before any radio work; bleak was never imported.
        self.assertNotIn("bleak", result.stderr.lower())


class BleNameVerifyTests(unittest.IsolatedAsyncioTestCase):
    """The write path must ask the board, not trust the write reply."""

    def management(self, answer):
        calls = []

        class FakeManagement:
            async def send(self, command):
                calls.append(command)
                return answer

        return FakeManagement(), calls

    async def test_a_rename_is_verified_with_a_query(self):
        module = load_terminal()
        management, calls = self.management(
            b"OK name=Bench Bee custom=yes\r\n")
        await module.verify_ble_name(management, "Bench Bee")
        self.assertEqual(calls, [b"@n?"])

    async def test_a_board_that_reports_another_name_fails_the_rename(self):
        module = load_terminal()
        management, calls = self.management(
            b"OK name=Old Name custom=yes\r\n")
        with self.assertRaisesRegex(RuntimeError, "reports"):
            await module.verify_ble_name(management, "Bench Bee")
        self.assertEqual(calls, [b"@n?"])

    async def test_a_reset_only_requires_a_readable_name(self):
        module = load_terminal()
        management, calls = self.management(
            b"OK name=Linkr Bee 078C custom=no\r\n")
        await module.verify_ble_name(management, None)
        self.assertEqual(calls, [b"@n?"])

    async def test_an_unreadable_answer_fails_even_a_reset(self):
        module = load_terminal()
        management, calls = self.management(b"ERR name=1\r\n")
        with self.assertRaisesRegex(RuntimeError, "did not report"):
            await module.verify_ble_name(management, None)
        self.assertEqual(calls, [b"@n?"])


class HelpCompletenessTests(unittest.TestCase):
    """--help is the reference: every flag, and the parts a reader needs."""

    def help_text(self):
        return terminal.build_parser().format_help()

    def test_every_option_appears_with_a_description(self):
        parser = terminal.build_parser()
        text = self.help_text()
        for action in parser._actions:
            if not action.option_strings:
                continue
            for flag in action.option_strings:
                self.assertIn(flag, text, flag)
            self.assertTrue(action.help, f"{action.option_strings} has no help")

    def test_the_usage_line_fits_an_eighty_column_terminal(self):
        for line in self.help_text().splitlines():
            self.assertLessEqual(len(line), 80, line)

    def test_exit_codes_and_examples_are_documented(self):
        text = self.help_text()
        self.assertIn("exit codes: 0 ok, 1 error, 2 bad arguments, 3 device",
                      text)
        # The firmware, not this CLI, owns the @-command list.
        self.assertIn("--cmd '@help'", text)
        self.assertIn("examples:", text)

    def test_flags_are_grouped_instead_of_one_flat_list(self):
        parser = terminal.build_parser()
        titles = [group.title for group in parser._action_groups]
        for expected in ("finding and connecting", "board settings and I/O",
                         "name, pairing and console control",
                         "any other management command", "terminal session",
                         "output and transport tuning"):
            self.assertIn(expected, titles)


class CompletionTests(unittest.TestCase):
    """--print-completion must stay in step with the parser it describes."""

    def script(self, shell):
        return terminal.completion_script(shell, terminal.build_parser())

    def parser_options(self):
        return {
            option
            for action in terminal.build_parser()._actions
            for option in action.option_strings
        }

    def bash_complete(self, *words):
        """Drive the generated function in a real bash, as completion would."""
        with tempfile.TemporaryDirectory(prefix="linkr-completion-") as directory:
            path = Path(directory) / "completion.bash"
            path.write_text(self.script("bash"))
            program = "\n".join([
                f"source {shlex.quote(str(path))}",
                "COMP_WORDS=(" + " ".join(shlex.quote(word) for word in words) + ")",
                "COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))",
                "COMPREPLY=()",
                "_linkr_ble_terminal",
                'printf "%s\\n" "${COMPREPLY[@]}"',
            ])
            result = subprocess.run(["bash", "-c", program],
                                    capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.split()

    @unittest.skipUnless(shutil.which("bash"), "bash is required")
    def test_bash_script_is_syntactically_valid(self):
        with tempfile.TemporaryDirectory(prefix="linkr-completion-") as directory:
            path = Path(directory) / "completion.bash"
            path.write_text(self.script("bash"))
            result = subprocess.run(["bash", "-n", str(path)],
                                    capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("zsh"), "zsh is required")
    def test_zsh_script_is_syntactically_valid(self):
        with tempfile.TemporaryDirectory(prefix="linkr-completion-") as directory:
            path = Path(directory) / "_linkr_ble_terminal"
            path.write_text(self.script("zsh"))
            result = subprocess.run(["zsh", "-n", str(path)],
                                    capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("fish"), "fish is required")
    def test_fish_script_is_syntactically_valid(self):
        with tempfile.TemporaryDirectory(prefix="linkr-completion-") as directory:
            path = Path(directory) / "linkr_ble_terminal.py.fish"
            path.write_text(self.script("fish"))
            result = subprocess.run(["fish", "--no-execute", str(path)],
                                    capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_fish_registers_every_option_for_every_command_name(self):
        lines = [line for line in self.script("fish").splitlines()
                 if line.startswith("complete ")]
        commands = terminal.COMPLETION_COMMANDS
        self.assertEqual(len(lines), len(self.parser_options()) * len(commands))

        for option in sorted(self.parser_options()):
            # fish spells the option without its dashes: --enter is -l enter.
            if option.startswith("--"):
                expected = f"-l {option[2:]}"
            else:
                expected = f"-s {option[1:]}"
            for command in commands:
                with self.subTest(option=option, command=command):
                    self.assertTrue(
                        any(line.startswith(f"complete -c {command} ") and
                            expected in line for line in lines),
                        f"{command} does not register {option}")

    def test_fish_marks_choices_files_and_plain_values(self):
        script = self.script("fish")
        # -x is fish's "requires a value, complete no files".
        self.assertIn("-l enter -x -a 'raw cr lf crlf'", script)
        self.assertIn("-l print-completion -x -a 'bash fish zsh'", script)
        self.assertIn("-l log-file -r -F", script)
        self.assertIn("-l wifi-key-file -r -F", script)
        self.assertIn("-l name -r -f", script)

    def test_fish_script_keeps_descriptions_quoted(self):
        for line in self.script("fish").splitlines():
            if not line.startswith("complete "):
                continue
            with self.subTest(line=line):
                # Exactly the opening and closing quote, once the choice list
                # and any escaped apostrophe (argparse's own --version text has
                # one) are set aside. A stray quote would end the string early.
                unescaped = re.sub(r"-a '[^']*'", "", line.replace("\\'", ""))
                self.assertEqual(unescaped.count("'"), 2)

    @unittest.skipUnless(shutil.which("fish"), "fish is required")
    def test_fish_completion_answers_the_way_a_shell_needs(self):
        """Drive fish's own completion engine, hermetically.

        fish only autoloads a completion file for a command it can find, so the
        probe puts a stub on PATH; XDG_CONFIG_HOME keeps it out of the real
        ~/.config/fish.
        """
        with tempfile.TemporaryDirectory(prefix="linkr-fish-") as directory:
            config = Path(directory) / "config"
            commands = config / "fish" / "completions"
            commands.mkdir(parents=True)
            script = self.script("fish")
            for name in terminal.COMPLETION_COMMANDS:
                (commands / f"{name}.fish").write_text(script)

            stub_dir = Path(directory) / "bin"
            stub_dir.mkdir()
            for name in terminal.COMPLETION_COMMANDS:
                stub = stub_dir / name
                stub.write_text("#!/bin/sh\nexit 0\n")
                stub.chmod(0o755)

            env = dict(os.environ,
                       XDG_CONFIG_HOME=str(config),
                       PATH=f"{stub_dir}{os.pathsep}{os.environ.get('PATH', '')}")

            def complete(line):
                result = subprocess.run(["fish", "-c", f'complete -C"{line}"'],
                                        capture_output=True, text=True,
                                        env=env, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                return sorted(entry.split("\t")[0]
                              for entry in result.stdout.splitlines())

            for command in terminal.COMPLETION_COMMANDS:
                with self.subTest(command=command):
                    self.assertEqual(
                        complete(f"{command} --enter "),
                        ["cr", "crlf", "lf", "raw"])
                    self.assertEqual(
                        complete(f"{command} --print-completion "),
                        ["bash", "fish", "zsh"])
                    # A free-form value is neither completed with files nor
                    # with anything else.
                    self.assertEqual(complete(f"{command} --name "), [])

    def test_every_parser_option_reaches_both_scripts(self):
        options = self.parser_options()
        self.assertTrue(options)
        for shell in terminal.COMPLETION_SHELLS:
            script = self.script(shell)
            for option in sorted(options):
                with self.subTest(shell=shell, option=option):
                    if shell == "fish":
                        # fish spells an option without its dashes.
                        expected = (f"-l {option[2:]}" if option.startswith("--")
                                    else f"-s {option[1:]}")
                    else:
                        expected = option
                    self.assertIn(expected, script)

    def test_option_choices_are_completed(self):
        for shell in terminal.COMPLETION_SHELLS:
            with self.subTest(shell=shell):
                script = self.script(shell)
                self.assertIn("raw cr lf crlf", script)
        # zsh needs the action list, bash the compgen word list.
        self.assertIn("(raw cr lf crlf)", self.script("zsh"))
        self.assertIn('--enter) COMPREPLY=( $(compgen -W "raw cr lf crlf"',
                      self.script("bash"))

    def test_path_options_complete_files(self):
        script = self.script("bash")
        self.assertIn("--wifi-key-file|--log-file) COMPREPLY=( $(compgen -f",
                      script)
        self.assertIn("--log-file=[append raw BLE RX bytes to a file]:file:_files",
                      self.script("zsh"))

    @unittest.skipUnless(shutil.which("bash"), "bash is required")
    def test_bash_completion_answers_the_way_a_shell_needs(self):
        self.assertEqual(self.bash_complete("linkr_ble_terminal.py", "--e"),
                         ["--enter", "--escape"])
        self.assertEqual(self.bash_complete("linkr_ble_terminal.py", "--enter", "c"),
                         ["cr", "crlf"])
        self.assertEqual(
            self.bash_complete("linkr_ble_terminal.py", "--print-completion", "z"),
            ["zsh"])
        # A prefix that several options share returns all of them.
        self.assertEqual(self.bash_complete("linkr_ble_terminal.py", "--json", "--q"),
                         ["--query-info", "--query-uart", "--query-wifi",
                          "--query-webdav", "--query-led", "--query-opto",
                          "--query-ble-name", "--quiet", "--query-control"])
        self.assertEqual(self.bash_complete("linkr_ble_terminal.py", "--quiet", "--j"),
                         ["--json"])
        # --flag=value is accepted by the parser, so the value completes too.
        self.assertEqual(self.bash_complete("linkr_ble_terminal.py", "--enter=c"),
                         ["--enter=cr", "--enter=crlf"])
        self.assertEqual(
            self.bash_complete("linkr_ble_terminal.py", "--print-completion=f"),
            ["--print-completion=fish"])

    def test_unsupported_shell_is_a_usage_error(self):
        with self.assertRaises(ValueError):
            self.script("ksh")

    def test_completion_prints_without_bleak_and_leaves_the_radio_alone(self):
        # This interpreter has no bleak installed: printing a script must not
        # need it, and must not be confused with a device operation.
        result = subprocess.run(
            [sys.executable, str(TERMINAL_PATH), "--print-completion", "bash"],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("complete -F _linkr_ble_terminal", result.stdout)

    def test_a_bad_shell_exits_two_from_the_command_line(self):
        result = subprocess.run(
            [sys.executable, str(TERMINAL_PATH), "--print-completion", "ksh"],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 2)
        # argparse changed the wording of this message across versions.
        self.assertIn("invalid choice", result.stderr)
        for shell in terminal.COMPLETION_SHELLS:
            self.assertIn(shell, result.stderr)


class BondAddressTests(unittest.TestCase):
    """`--bonds-remove` takes the pair the board prints, nothing looser."""

    def test_a_pair_is_normalised_to_upper_case(self):
        self.assertEqual(terminal.bond_address("0/aa:bb:cc:dd:ee:01"),
                         "0/AA:BB:CC:DD:EE:01")
        self.assertEqual(terminal.bond_address(" 1/AA:BB:CC:DD:EE:02 "),
                         "1/AA:BB:CC:DD:EE:02")

    def test_the_wrong_shape_is_refused_before_any_radio_work(self):
        for value in ("AA:BB:CC:DD:EE:01", "0/AA:BB", "9/AA:BB:CC:DD:EE:01",
                      "0/AA:BB:CC:DD:EE:0", "0/ZZ:BB:CC:DD:EE:01", ""):
            with self.assertRaises(argparse.ArgumentTypeError, msg=value):
                terminal.bond_address(value)


class ScanJsonTests(unittest.IsolatedAsyncioTestCase):
    """--scan --json is what a script parses; names can hold the tab."""

    def devices(self):
        return [
            terminal.DiscoveredDevice("Linkr Bee 1A2B", "AA:BB:CC:DD:EE:01", -52,
                                      (terminal.MGMT_SERVICE_UUID,)),
            terminal.DiscoveredDevice("tab\tinside", "AA:BB:CC:DD:EE:02", None, ()),
        ]

    async def scan(self, json_output):
        async def fake_discover(_timeout):
            return self.devices()
        stdout = io.StringIO()
        with patch.object(terminal, "discover_devices", fake_discover), \
                contextlib.redirect_stdout(stdout):
            await terminal.scan_devices(1.0, json_output=json_output)
        return stdout.getvalue()

    async def test_each_device_becomes_one_json_record(self):
        output = await self.scan(True)
        lines = [json.loads(line) for line in output.splitlines()]
        self.assertEqual(len(lines), 2)
        first = lines[0]
        self.assertEqual(first["type"], "device")
        self.assertEqual(first["address"], "AA:BB:CC:DD:EE:01")
        self.assertEqual(first["rssi"], -52)
        self.assertTrue(first["management"])
        self.assertFalse(lines[1]["management"])
        self.assertEqual(lines[1]["name"], "tab\tinside")

    async def test_the_plain_listing_is_unchanged(self):
        rows = (await self.scan(False)).splitlines()
        self.assertEqual(rows[0], "AA:BB:CC:DD:EE:01\tLinkr Bee 1A2B\t-52 dBm")
        # A name with a tab in it splits the plain listing -- which is exactly
        # why --json exists; the column count is the honest assertion here.
        self.assertEqual(len(rows[1].split("\t")), 3)


class RunCommandsTests(unittest.IsolatedAsyncioTestCase):
    """Every flag turns into the documented wire command, in --help order."""

    class Recorder:
        def __init__(self):
            self.sent = []
            self.written_name = None

        async def send(self, command, wait_final_timeout=0.0):
            self.sent.append((command, wait_final_timeout))
            if command.startswith(b"@n="):
                self.written_name = command[3:].decode()
            if command == b"@n?":
                name = self.written_name or "Linkr-Bee-1234"
                return f"OK name={name} custom=yes\r\n".encode()
            return b"OK\r\n"

    async def run_flags(self, *argv, wifi_command=None):
        args = terminal.build_parser().parse_args(list(argv))
        management = self.Recorder()
        with contextlib.redirect_stdout(io.StringIO()):
            await terminal.run_commands(args, management,
                                        wifi_command=wifi_command)
        return [command for command, _ in management.sent], management.sent

    async def test_board_io_flags_become_the_documented_commands(self):
        sent, _ = await self.run_flags("--led", "#1A2B3C", "--opto-pulse", "500",
                                       "--query-opto")
        self.assertEqual(sent, [b"@l=1a2b3c", b"@o pulse 500", b"@o?"])

    async def test_off_forms_are_spelled_out(self):
        sent, _ = await self.run_flags("--led", "off", "--opto", "on")
        self.assertEqual(sent, [b"@l off", b"@o on"])

    async def test_a_cmd_runs_after_the_flags_in_the_order_given(self):
        sent, _ = await self.run_flags("--query-info", "--cmd", "@r slots",
                                       "--cmd", " @linkr bonds? ")
        self.assertEqual(sent, [b"@i?", b"@r slots", b"@linkr bonds?"])

    async def test_the_wifi_pair_keeps_its_long_timeouts(self):
        sent, timed = await self.run_flags("--wifi-scan", "--query-wifi",
                                           wifi_command=b"@w=Lab,secret")
        self.assertEqual(sent, [b"@w=Lab,secret", b"@w?", b"@w scan"])
        self.assertEqual(timed[0][1], terminal.WIFI_OPERATION_TIMEOUT)
        self.assertEqual(timed[1][1], 0.0)
        self.assertEqual(timed[2][1], terminal.WIFI_SCAN_TIMEOUT)

    async def test_a_rename_is_read_back(self):
        sent, _ = await self.run_flags("--rename-ble", "测试😀")
        self.assertEqual(sent, ["@n=测试😀".encode(), b"@n?"])

    async def test_nothing_is_sent_when_no_command_flag_is_given(self):
        sent, _ = await self.run_flags()
        self.assertEqual(sent, [])

    async def test_control_is_claimed_first_and_released_last(self):
        sent, _ = await self.run_flags("--query-info", "--claim", "--led",
                                       "1a2b3c", "--query-control", "--release")
        self.assertEqual(sent[:2], [b"@c?", b"@c claim"])
        self.assertEqual(sent[-1], b"@c release")
        self.assertIn(b"@l=1a2b3c", sent)

    async def test_pairing_commands_use_the_long_form(self):
        sent, _ = await self.run_flags("--bonds", "--bonds-names",
                                       "--bonds-remove", "0/aa:bb:cc:dd:ee:01")
        self.assertEqual(sent, [b"@linkr bonds?", b"@linkr bonds names?",
                                b"@linkr bonds remove 0/AA:BB:CC:DD:EE:01"])


class SessionLoopTests(unittest.TestCase):
    """--reconnect retries a dropped link, and nothing else."""

    def run_loop(self, codes, attempts):
        calls = []
        sleeps = []
        code = terminal.session_loop(
            lambda: calls.append(1) or codes[len(calls) - 1],
            attempts,
            sleep=sleeps.append)
        return code, len(calls), sleeps

    def test_a_clean_session_runs_once(self):
        self.assertEqual(self.run_loop([terminal.EXIT_OK], 3), (terminal.EXIT_OK, 1, []))

    def test_a_dropped_link_is_retried_until_the_attempts_run_out(self):
        code, runs, sleeps = self.run_loop(
            [terminal.EXIT_DEVICE_DISCONNECTED] * 3, 2)
        self.assertEqual(code, terminal.EXIT_DEVICE_DISCONNECTED)
        self.assertEqual(runs, 3)
        self.assertEqual(sleeps, [terminal.RECONNECT_DELAY] * 2)

    def test_zero_attempts_keeps_exit_code_three(self):
        code, runs, sleeps = self.run_loop([terminal.EXIT_DEVICE_DISCONNECTED], 0)
        self.assertEqual((code, runs, sleeps),
                         (terminal.EXIT_DEVICE_DISCONNECTED, 1, []))

    def test_a_reconnected_session_returns_its_own_result(self):
        code, runs, _ = self.run_loop(
            [terminal.EXIT_DEVICE_DISCONNECTED, terminal.EXIT_OK], 5)
        self.assertEqual((code, runs), (terminal.EXIT_OK, 2))

    def test_other_failures_are_not_retried(self):
        code, runs, _ = self.run_loop([terminal.EXIT_ERROR], 5)
        self.assertEqual((code, runs), (terminal.EXIT_ERROR, 1))


class BoardIoFlagTests(unittest.TestCase):
    """--led / --opto / --cmd / --monitor / --reconnect reject bad input early."""

    def args(self, *argv):
        return terminal.build_parser().parse_args(list(argv))

    def test_led_colour_accepts_hex_with_or_without_hash(self):
        for value in ("1a2b3c", "#1A2B3C", " 1A2B3C "):
            self.assertEqual(terminal.led_colour(value), "1a2b3c")
        self.assertEqual(terminal.led_colour("off"), "off")
        self.assertEqual(terminal.led_colour("OFF"), "off")

    def test_led_colour_rejects_anything_else(self):
        for value in ("", "offf", "1a2b3", "1a2b3c4", "gggggg", "0x1a2b3c"):
            with self.assertRaises(argparse.ArgumentTypeError, msg=value):
                terminal.led_colour(value)

    def test_pulse_length_is_bounded_by_the_firmware_range(self):
        self.assertEqual(terminal.pulse_ms("1"), 1)
        self.assertEqual(terminal.pulse_ms("60000"), 60000)
        for value in ("0", "60001", "-5", "1.5", "abc"):
            with self.assertRaises(argparse.ArgumentTypeError, msg=value):
                terminal.pulse_ms(value)

    def test_reconnect_attempts_are_bounded(self):
        self.assertEqual(terminal.reconnect_attempts("0"), 0)
        self.assertEqual(terminal.reconnect_attempts("50"), 50)
        for value in ("-1", "51", "abc"):
            with self.assertRaises(argparse.ArgumentTypeError, msg=value):
                terminal.reconnect_attempts(value)

    def test_a_command_must_be_the_on_wire_form(self):
        self.assertEqual(terminal.management_command("  @l?  "), "@l?")
        self.assertEqual(terminal.management_command("@linkr bonds?"),
                         "@linkr bonds?")
        for value in ("l?", "@", "bonds"):
            with self.assertRaises(argparse.ArgumentTypeError, msg=value):
                terminal.management_command(value)

    def test_cmd_keeps_every_command_in_order(self):
        self.assertEqual(self.args("--cmd", "@l?", "--cmd", "@o?").cmd,
                         ["@l?", "@o?"])
        self.assertIsNone(self.args().cmd)

    def test_monitor_and_no_terminal_cannot_combine(self):
        result = subprocess.run(
            [sys.executable, str(TERMINAL_PATH), "--monitor", "--no-terminal"],
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
        self.assertEqual(result.returncode, 2)
        self.assertIn("mutually exclusive", result.stderr)

    def test_opto_and_opto_pulse_cannot_combine(self):
        result = subprocess.run(
            [sys.executable, str(TERMINAL_PATH), "--opto", "on",
             "--opto-pulse", "500"],
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
        self.assertEqual(result.returncode, 2)
        self.assertIn("mutually exclusive", result.stderr)


class ReplyFieldTests(unittest.TestCase):
    """What --json reports for a reply, without a radio."""

    def test_pairs_are_split_out_of_a_single_line(self):
        self.assertEqual(terminal.reply_fields("OK name=Linkr-Bee custom=yes"),
                         {"name": "Linkr-Bee", "custom": "yes"})
        self.assertEqual(
            terminal.reply_fields("OK wifi=connected,ssid=Lab,ip=10.0.0.5"),
            {"wifi": "connected", "ssid": "Lab", "ip": "10.0.0.5"})

    def test_multi_line_replies_are_merged(self):
        text = "OK led rgb=1a2b3c\nuptime=42"
        self.assertEqual(terminal.reply_fields(text),
                         {"rgb": "1a2b3c", "uptime": "42"})

    def test_a_reply_without_pairs_still_reports_its_text(self):
        record = terminal.result_record("@o?", b"OK opto=closed\r\n")
        self.assertEqual(record["type"], "result")
        self.assertEqual(record["command"], "@o?")
        self.assertTrue(record["ok"])
        self.assertEqual(record["text"], "OK opto=closed")
        self.assertEqual(record["fields"], {"opto": "closed"})


class SendReportedTests(unittest.IsolatedAsyncioTestCase):
    class FakeManagement:
        def __init__(self, reply=b"OK led rgb=00ff00\r\n"):
            self.sent = []
            self.reply = reply
            self.timeout = None

        async def send(self, command, wait_final_timeout=0.0):
            self.sent.append(command)
            self.timeout = wait_final_timeout
            return self.reply

    async def test_human_mode_stays_quiet_unless_the_body_is_wanted(self):
        management = self.FakeManagement()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            await terminal.send_reported(management, "@l?", json_output=False)
            self.assertEqual(stdout.getvalue(), "")
            await terminal.send_reported(management, "@l?", json_output=False,
                                         print_body=True)
        self.assertEqual(stdout.getvalue(), "OK led rgb=00ff00\n")
        self.assertEqual(management.sent, [b"@l?", b"@l?"])

    async def test_json_mode_prints_one_result_record(self):
        management = self.FakeManagement()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            await terminal.send_reported(
                management, "@o?", json_output=True, print_body=True)
        record = json.loads(stdout.getvalue())
        self.assertEqual(record["type"], "result")
        self.assertEqual(record["fields"], {"rgb": "00ff00"})

    async def test_a_final_timeout_is_forwarded(self):
        management = self.FakeManagement()
        with contextlib.redirect_stdout(io.StringIO()):
            await terminal.send_reported(management, "@w scan",
                                         json_output=False,
                                         wait_final_timeout=35.0)
        self.assertEqual(management.timeout, 35.0)


class HostNameTests(unittest.TestCase):
    """The name recorded next to this host's bond."""

    def args(self, *argv):
        return terminal.build_parser().parse_args(list(argv))

    def test_default_is_this_machines_hostname(self):
        with patch.object(terminal.socket, "gethostname", return_value=" mbp.local "):
            self.assertEqual(terminal.host_label(self.args()), "mbp.local")

    def test_an_explicit_name_wins(self):
        with patch.object(terminal.socket, "gethostname", return_value="ignored"):
            self.assertEqual(
                terminal.host_label(self.args("--host-name", "	longlong 的 MacBook ")),
                "	longlong 的 MacBook ".strip())

    def test_no_host_name_skips_the_report(self):
        self.assertIsNone(terminal.host_label(self.args("--no-host-name")))

    def test_an_empty_hostname_is_not_reported(self):
        with patch.object(terminal.socket, "gethostname", return_value="   "):
            self.assertIsNone(terminal.host_label(self.args()))

    def test_both_flags_are_a_usage_error(self):
        result = subprocess.run(
            [sys.executable, str(TERMINAL_PATH), "--host-name", "x",
             "--no-host-name", "--no-terminal"],
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not both", result.stderr)


class HostNameReportTests(unittest.IsolatedAsyncioTestCase):
    class FakeManagement:
        def __init__(self, error=None):
            self.sent = []
            self.error = error

        async def send(self, command):
            self.sent.append(command)
            if self.error is not None:
                raise self.error
            return b"OK bonds name"

    async def test_reports_the_exact_command(self):
        management = self.FakeManagement()
        await terminal.report_host_name(management, "longlong-mbp")
        self.assertEqual(management.sent, [b"@linkr bonds name longlong-mbp"])

    async def test_a_name_with_spaces_survives(self):
        management = self.FakeManagement()
        await terminal.report_host_name(management, "longlong 的 iPhone")
        self.assertEqual(management.sent,
                         ["@linkr bonds name longlong 的 iPhone".encode()])

    async def test_a_refusal_is_a_warning_not_a_failed_session(self):
        management = self.FakeManagement(error=RuntimeError("ERR bonds not found"))
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            await terminal.report_host_name(management, "mbp")
        self.assertIn("could not record this host's name", stderr.getvalue())
        self.assertIn("ERR bonds not found", stderr.getvalue())


class ScanRuleTests(unittest.TestCase):
    """--scan lists and exits unless the invocation asked for more."""

    def parse(self, *argv):
        return terminal.build_parser().parse_args(list(argv))

    def test_scan_alone_is_the_whole_job(self):
        args = self.parse("--scan")
        self.assertFalse(terminal.has_control_action(args))
        self.assertIsNone(args.address)

    def test_scan_with_a_control_action_continues(self):
        for extra in (["--query-info"], ["--pair"], ["--loopback-test"],
                      ["--wifi", "ssid,pass"], ["--uart", "115200,8,n,1,n"],
                      ["--wifi-scan"], ["--webdav", "http://host/dav/"],
                      ["--query-ble-name"], ["--rename-ble", "Bee"],
                      ["--reset-ble-name"]):
            with self.subTest(extra=extra):
                self.assertTrue(
                    terminal.has_control_action(self.parse("--scan", *extra)))

    def test_scan_with_an_explicit_address_continues(self):
        args = self.parse("--scan", "--address", "AA:BB:CC:DD:EE:FF")
        self.assertEqual(args.address, "AA:BB:CC:DD:EE:FF")

    def test_a_bare_terminal_invocation_has_no_control_action(self):
        args = self.parse()
        self.assertFalse(terminal.has_control_action(args))


class ValidatorTests(unittest.TestCase):
    def test_normalize_uart_spec_canonicalizes(self):
        self.assertEqual(
            terminal.normalize_uart_spec("9600,7,even,2,off"), "9600,7,e,2,n")

    def test_normalize_uart_spec_rejects_bad_fields(self):
        bad = [
            "115200,8,n,1",             # too few fields
            "299,8,n,1,n",              # baud below the firmware minimum
            "3000001,8,n,1,n",          # baud above the firmware maximum
            "115200,9,n,1,n",           # data bits
            "115200,8,n,3,n",           # stop bits
            "115200,8,mark,1,n",        # parity
            "115200,8,n,1,xonxoff",     # flow control
        ]
        for spec in bad:
            with self.subTest(spec=spec):
                with self.assertRaises(Exception):
                    terminal.normalize_uart_spec(spec)

    def test_parse_escape_forms(self):
        self.assertEqual(terminal.parse_escape("^]"), b"\x1d")
        self.assertEqual(terminal.parse_escape("0x1d"), b"\x1d")
        self.assertEqual(terminal.parse_escape("q"), b"q")
        for bad in ["^", "0x1ff", "ab", "0xzz"]:
            with self.subTest(value=bad):
                with self.assertRaises(Exception):
                    terminal.parse_escape(bad)

    def test_describe_escape_names_the_configured_byte(self):
        self.assertEqual(terminal.describe_escape(b"\x1d"), "Ctrl-]")
        self.assertEqual(terminal.describe_escape(b"\x03"), "Ctrl-C")
        self.assertEqual(terminal.describe_escape(b"q"), "'q'")

    def test_translate_enter_modes(self):
        self.assertEqual(terminal.translate_enter(b"a\r\nb\r", "raw"), b"a\r\nb\r")
        self.assertEqual(terminal.translate_enter(b"a\r\nb\r", "lf"), b"a\nb\n")
        self.assertEqual(terminal.translate_enter(b"a\n", "cr"), b"a\r")
        self.assertEqual(terminal.translate_enter(b"a\n", "crlf"), b"a\r\n")


class TerminalGeometryTests(unittest.TestCase):
    """The CLI mirrors web/terminal_geometry.js; these are the drift guards."""

    def test_geometry_is_clamped_like_the_web_client(self):
        self.assertEqual(terminal.terminal_geometry(0, 0)["key"], "2x2")
        self.assertEqual(terminal.terminal_geometry(5000, 5000)["key"], "1000x1000")
        self.assertEqual(terminal.terminal_geometry(None, None)["key"], "2x2")
        self.assertEqual(terminal.terminal_geometry(120, 30)["key"], "120x30")

    def test_geometry_command_is_byte_identical_to_the_web_client(self):
        self.assertEqual(
            terminal.terminal_geometry_command(80, 24),
            "stty rows 24 cols 80 >/dev/null 2>&1\r",
        )
        web = (ROOT / "web/terminal_geometry.js").read_text()
        self.assertIn(
            "stty rows ${geometry.rows} cols ${geometry.cols} >/dev/null 2>&1\\r",
            web,
        )

    def test_prompt_detection_matches_the_web_client_rules(self):
        for text in [
            "user@host:~$ ",
            "# ",
            "/srv/app$ ",
            "sh-5.1$ ",
            "[root@host]# ",
            # zsh and fish terminators, previously never recognised: a board
            # whose prompt ends this way never received the stty line.
            "user@host ~ % ",
            "user@host ~/src % ",
            "user@host ~> ",
            "user@host ~/src> ",
            "sh-5.1> ",
            # a host with no user@, the buildroot prompt
            "buildroot:~# ",
            "buildroot:/etc# ",
            # starship / powerline: the shape most development boards ship
            "08:57:55 radxa@radxa-cubie-a7z ~ → ",
            "bob@host /srv ❯ ",
            "❯ ",
            # an activated environment is part of the prompt
            "(venv) user@host:~# ",
        ]:
            with self.subTest(text=text):
                self.assertTrue(terminal.looks_like_shell_prompt(text))
        for text in [
            "",
            "$ x",
            "running",
            "Loading kernel...",
            # `>` appears in ordinary output, so the prefix must look like one.
            "=> ",
            "U-Boot> ",
            "echo hi > ",
            "100% ",
            "select> ",
            "> ",  # Default PS2: heredoc/quote continuation, not an idle shell.
            "   > ",
            "cost $ ",
        ]:
            with self.subTest(text=text):
                self.assertFalse(terminal.looks_like_shell_prompt(text))

        web = (ROOT / "web/terminal_geometry.js").read_text()
        self.assertIn('new Set(["$", "#", "%", ">", "→", "❯", "›"])', web)
        self.assertIn('line[line.length - 2]', web)

    def test_geometry_sync_waits_for_an_idle_prompt_and_dedupes(self):
        sync = terminal.TerminalGeometrySync(80, 24)
        sync.observe("booting the target\r\n")
        self.assertIsNone(sync.take_pending_command())

        sync.observe("root@target:~$ ")
        command = sync.take_pending_command()
        self.assertEqual(command, "stty rows 24 cols 80 >/dev/null 2>&1\r")
        # In flight: a second prompt must not queue a duplicate.
        self.assertIsNone(sync.take_pending_command())
        sync.confirm_sent()
        sync.observe("root@target:~$ ")
        self.assertIsNone(sync.take_pending_command())

    def test_geometry_resize_during_a_multiline_command_never_writes_into_it(self):
        sync = terminal.TerminalGeometrySync(80, 24)
        sync.observe("root@target:~$ ")
        sync.take_pending_command()
        sync.confirm_sent()
        sync.mark_busy()
        sync.set_size(120, 40)
        sync.observe("cat <<EOF\r\n> ")
        self.assertIsNone(sync.take_pending_command())
        sync.observe("PAYLOAD\r\n> ")
        self.assertIsNone(sync.take_pending_command())
        sync.observe("EOF\r\nroot@target:~$ ")
        self.assertEqual(sync.take_pending_command(), "stty rows 40 cols 120 >/dev/null 2>&1\r")

    def test_geometry_sync_resends_after_a_resize(self):
        sync = terminal.TerminalGeometrySync(80, 24)
        sync.observe("root@target:~$ ")
        sync.take_pending_command()
        sync.confirm_sent()

        sync.set_size(120, 40)
        self.assertIsNone(sync.take_pending_command())
        sync.observe("root@target:~$ ")
        self.assertEqual(
            sync.take_pending_command(),
            "stty rows 40 cols 120 >/dev/null 2>&1\r",
        )

    def test_geometry_sync_stops_at_a_prompt_that_is_not_idle(self):
        sync = terminal.TerminalGeometrySync(80, 24)
        sync.observe("root@target:~$ ")
        sync.mark_busy()
        self.assertIsNone(sync.take_pending_command())

    def test_geometry_sync_retries_after_a_failed_send(self):
        sync = terminal.TerminalGeometrySync(80, 24)
        sync.observe("root@target:~$ ")
        sync.take_pending_command()
        sync.abort_sent()
        sync.observe("root@target:~$ ")
        self.assertIsNotNone(sync.take_pending_command())


class WifiCredentialTests(unittest.TestCase):
    def test_inline_credentials_still_work(self):
        self.assertEqual(
            terminal.resolve_wifi_credentials("ssid,secret"), ("ssid", "secret"))

    def test_password_is_read_from_a_key_file(self):
        with contextlib.ExitStack() as stack:
            path = stack.enter_context(
                __import__("tempfile").TemporaryDirectory())
            key = Path(path) / "wifi.key"
            key.write_text("filesecret\nignored\n")
            self.assertEqual(
                terminal.resolve_wifi_credentials("ssid", str(key)),
                ("ssid", "filesecret"),
            )

    def test_password_can_come_from_the_environment(self):
        self.assertEqual(
            terminal.resolve_wifi_credentials("ssid", None,
                                              environ={"LINKR_WIFI_PASSWORD": "env"}),
            ("ssid", "env"),
        )

    def test_password_prompt_is_the_last_resort(self):
        self.assertEqual(
            terminal.resolve_wifi_credentials("ssid", None, environ={},
                                              prompt=lambda _: "typed"),
            ("ssid", "typed"),
        )

    def test_missing_password_is_an_error_not_an_empty_password(self):
        with self.assertRaises(ValueError):
            terminal.resolve_wifi_credentials("ssid", None, environ={}, prompt=None)

    def test_empty_ssid_and_empty_key_file_are_rejected(self):
        with self.assertRaises(ValueError):
            terminal.resolve_wifi_credentials(",secret")
        with contextlib.ExitStack() as stack:
            path = stack.enter_context(__import__("tempfile").TemporaryDirectory())
            key = Path(path) / "wifi.key"
            key.write_text("")
            with self.assertRaises(ValueError):
                terminal.resolve_wifi_credentials("ssid", str(key))


class BoardSelectionTests(unittest.TestCase):
    """A board is found by the service it speaks, not by the label it carries.

    The name is the owner's to change, so a host that looked for a board by
    its name would lose it the moment it was renamed.
    """

    def board(self, name, address="AA:BB:CC:DD:EE:FF", services=()):
        device = FakeDevice(name, address)
        device.service_uuids = tuple(services)
        return device

    def test_a_board_is_found_by_the_service_it_speaks(self):
        devices = [
            self.board("Linkr Bee 078C", "AA:1"),
            self.board("测试😀", "AA:2", services=[terminal.MGMT_SERVICE_UUID]),
        ]
        self.assertEqual(terminal.match_device(devices, None), "AA:2")

    def test_a_renamed_board_is_still_found(self):
        devices = [self.board("Bench Bee", "AA:3", services=[terminal.MGMT_SERVICE_UUID])]
        self.assertEqual(terminal.match_device(devices, None), "AA:3")

    def test_a_legacy_board_is_the_fallback(self):
        # The oldest NUS-only firmware has no service to be found by, so its
        # fixed name is the only thing that recognises it.
        devices = [self.board("Linkr BLE UART-3", "AA:4")]
        self.assertEqual(terminal.match_device(devices, None), "AA:4")

    def test_a_board_without_the_service_is_not_guessed_at(self):
        # A board that says nothing about the service and carries no legacy
        # name is not a board this client may talk to.
        self.assertIsNone(terminal.match_device([self.board("Other", "AA:5")], None))

    def test_a_name_the_user_gave_still_matches(self):
        devices = [self.board("测试😀", "AA:6")]
        self.assertEqual(terminal.match_device(devices, "测试😀"), "AA:6")
        self.assertEqual(terminal.match_device(devices, "测试*"), "AA:6")
        self.assertIsNone(terminal.match_device(devices, "Linkr Bee"))

    def test_a_name_is_compared_without_regard_to_its_case(self):
        devices = [self.board("Linkr Bee 078C", "AA:7")]
        self.assertEqual(terminal.match_device(devices, "linkr bee"), "AA:7")

    def test_the_failure_names_the_boards_that_were_there(self):
        devices = [self.board("测试😀", "AA:8"), self.board("Other", "BB:9")]
        with self.assertRaises(RuntimeError) as caught:
            asyncio.run(terminal.find_device("Linkr Bee", None, 0.1, devices=devices))
        message = str(caught.exception)
        self.assertIn("AA:8", message, "the address is what reaches the board")
        self.assertIn("测试😀", message, "and the name it answers to")
        self.assertIn("--address", message, "and the way to use it")

    def test_the_failure_without_a_name_says_the_same(self):
        devices = [self.board("测试😀", "AA:8")]
        with self.assertRaises(RuntimeError) as caught:
            asyncio.run(terminal.find_device(None, None, 0.1, devices=devices))
        message = str(caught.exception)
        self.assertIn("AA:8", message)
        self.assertIn("--address", message)

    def test_an_address_reaches_a_renamed_board(self):
        self.assertEqual(
            asyncio.run(terminal.find_device(None, "AA:8", 0.1, devices=[])),
            "AA:8",
        )

    def test_a_completed_scan_is_used_without_bleak(self):
        # The host that hands over a scan does not need the radio library to
        # pick an address from it, and a CI machine without bleak installed
        # must still be able to run these rules.
        devices = [self.board("测试😀", "AA:9", services=[terminal.MGMT_SERVICE_UUID])]
        # The module caches the imported names, so they are cleared here as
        # well: without that the guard would pass on a machine that had
        # already imported bleak and prove nothing.
        with patch.dict(sys.modules, {"bleak": None}), \
                patch.object(terminal, "BleakClient", None), \
                patch.object(terminal, "BleakScanner", None):
            self.assertEqual(
                asyncio.run(terminal.find_device(None, None, 0.1, devices=devices)),
                "AA:9",
            )


class DeviceIdTests(unittest.TestCase):
    """The Device ID is what makes the Management Service a filter."""

    def test_a_linkr_device_id_is_recognised(self):
        self.assertTrue(terminal.is_linkr_device_id(b"LINKRBLE\x01\x00" + bytes(6)))
        self.assertTrue(terminal.is_linkr_device_id(b"LINKRBLE\x01\x00\x01\x02\x03\x04\x05\x06"))

    def test_another_device_id_is_not(self):
        self.assertFalse(terminal.is_linkr_device_id(b"\x00" * 16))
        self.assertFalse(terminal.is_linkr_device_id(b"LINKRBLE\x01\x00"))
        self.assertFalse(terminal.is_linkr_device_id(b"LINKRBEE\x01\x00" + bytes(6)))


class DeviceMatchTests(unittest.TestCase):
    def test_automatic_discovery_accepts_renamed_and_unnamed_linkr_devices(self):
        self.assertIsNone(terminal.build_parser().parse_args([]).name)
        for name in ("Bench Bee", "测试设备", None):
            with self.subTest(name=name):
                device = FakeDevice(name, "AA:1", service_uuids=(terminal.MGMT_SERVICE_UUID,))
                self.assertEqual(terminal.match_device([device], None), "AA:1")

    def test_automatic_discovery_keeps_legacy_names_but_rejects_unrelated_nus(self):
        for name in ("Linkr BLE UART", "Linkr BLE UART-3", "linkr ble uart 7F2C"):
            self.assertEqual(terminal.match_device([FakeDevice(name, "AA:1")], None), "AA:1")
        for name in ("Linkr Bee 078C", "Other", "Linkr BLE UARTISH", None):
            device = FakeDevice(name, "BB:1", service_uuids=("6e400001-b5a3-f393-e0a9-e50e24dcca9e",))
            self.assertIsNone(terminal.match_device([device], None))

    def test_explicit_name_overrides_service_discovery(self):
        devices = [FakeDevice("Bench Bee", "AA:1", service_uuids=(terminal.MGMT_SERVICE_UUID,)),
                   FakeDevice("Other", "BB:1")]
        self.assertEqual(terminal.match_device(devices, "Other"), "BB:1")
        self.assertIsNone(terminal.match_device(devices, "Linkr Bee"))

    def test_exact_name_wins_over_prefix(self):
        devices = [FakeDevice("Linkr Bee 2", "AA:2"),
                   FakeDevice("Linkr Bee", "AA:1")]
        self.assertEqual(
            terminal.match_device(devices, "Linkr Bee"), "AA:1")

    def test_prefix_matches_the_default_name(self):
        devices = [FakeDevice("Other", "BB:1"),
                   FakeDevice("Linkr Bee 7F2C", "AA:7")]
        self.assertEqual(
            terminal.match_device(devices, "Linkr Bee*"), "AA:7")

    def test_no_match_returns_none(self):
        self.assertIsNone(terminal.match_device([FakeDevice("Other", "BB:1")], "x*"))

    def test_unnamed_devices_are_still_listed(self):
        devices = [FakeDevice(None, "AA:1", -70), FakeDevice("Named", "AA:2", None)]

        class FakeScanner:
            @staticmethod
            async def discover(timeout, return_adv):
                assert return_adv
                return {dev.address: (dev, types.SimpleNamespace(
                    local_name=dev.name, rssi=dev.rssi, service_uuids=[]))
                    for dev in devices}

        buffer = io.StringIO()
        with patch.object(terminal, "BleakClient", object), \
                patch.object(terminal, "BleakScanner", FakeScanner), \
                contextlib.redirect_stdout(buffer):
            asyncio.run(terminal.scan_devices(0.1))

        lines = buffer.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(any("(unknown)" in line for line in lines))
        self.assertTrue(any("-70 dBm" in line for line in lines))

    def test_find_device_reuses_a_completed_scan(self):
        class ExplodingScanner:
            @staticmethod
            async def discover(timeout):  # pragma: no cover - must not be called
                raise AssertionError("find_device scanned twice")

        devices = [FakeDevice("Linkr Bee 7F2C", "AA:7")]
        with patch.object(terminal, "BleakClient", object), \
                patch.object(terminal, "BleakScanner", ExplodingScanner):
            self.assertEqual(
                asyncio.run(terminal.find_device("Linkr Bee*", None, 0.1,
                                                 devices=devices)),
                "AA:7",
            )

    def test_scan_reuses_advertisement_services_for_default_selection(self):
        device = FakeDevice("Cached name", "AA:1")
        adv = types.SimpleNamespace(local_name="测试设备", rssi=-42,
                                    service_uuids=[terminal.MGMT_SERVICE_UUID.upper()])
        scanner = types.SimpleNamespace(discover=AsyncMock(
            return_value={device.address: (device, adv)}))
        async def run():
            scanned = await terminal.scan_devices(0.1)
            self.assertEqual(scanned[0].name, "测试设备")
            return await terminal.find_device(None, None, 0.1, devices=scanned)
        with patch.object(terminal, "BleakClient", object), \
                patch.object(terminal, "BleakScanner", scanner), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(asyncio.run(run()), "AA:1")
        scanner.discover.assert_awaited_once_with(timeout=0.1, return_adv=True)

    def test_explicit_address_skips_the_scan(self):
        self.assertEqual(
            asyncio.run(terminal.find_device("x", "AA:9", 0.1, devices=[])), "AA:9")


class ManagementChannelTests(unittest.IsolatedAsyncioTestCase):
    def quiet(self):
        """ManagementChannel narrates to stderr; keep test output readable."""
        return contextlib.redirect_stderr(io.StringIO())

    async def test_response_resolves_the_matching_future(self):
        channel = terminal.ManagementChannel(FakeWriteClient(), cfg(), 512)
        with self.quiet():
            task = asyncio.create_task(channel.send(b"@i?"))
            await asyncio.sleep(0)
            channel.on_indication(None, bytearray(mgmt_frame(2, 1, b"OK uptime=1\r\n")))
        self.assertEqual(await task, b"OK uptime=1\r\n")

    async def test_error_flag_raises(self):
        channel = terminal.ManagementChannel(FakeWriteClient(), cfg(), 512)
        with self.quiet():
            task = asyncio.create_task(channel.send(b"@u?"))
            await asyncio.sleep(0)
            channel.on_indication(None, bytearray(
                mgmt_frame(2, 1, b"ERR format\r\n", terminal.MGMT_FLAG_ERROR)))
        with self.assertRaises(RuntimeError):
            await task

    async def test_fragmented_response_is_reassembled(self):
        channel = terminal.ManagementChannel(FakeWriteClient(), cfg(), 512)
        with self.quiet():
            task = asyncio.create_task(channel.send(b"@i?"))
            await asyncio.sleep(0)
            frame = mgmt_frame(2, 1, b"OK a=1\r\nb=2\r\n")
            channel.on_indication(None, bytearray(frame[:16]))
            self.assertFalse(task.done())
            channel.on_indication(None, bytearray(frame[16:]))
        self.assertEqual(await task, b"OK a=1\r\nb=2\r\n")

    async def test_orphaned_response_header_is_ignored(self):
        channel = terminal.ManagementChannel(FakeWriteClient(), cfg(), 512)
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            channel.on_indication(None, bytearray(b"garbage"))
        self.assertIn("orphaned", errors.getvalue())

    async def test_json_output_is_one_object_per_message_and_redacts_secrets(self):
        channel = terminal.ManagementChannel(FakeWriteClient(), cfg(), 512,
                                             json_output=True)
        buffer = io.StringIO()
        with self.quiet(), contextlib.redirect_stdout(buffer):
            task = asyncio.create_task(channel.send(b"@w=ssid,secret"))
            await asyncio.sleep(0)
            channel.on_indication(None, bytearray(
                mgmt_frame(2, 1, b"OK wifi=accepted\r\n")))
            await task
            channel.on_indication(None, bytearray(
                mgmt_frame(3, 9, b"OK event wifi result=0\r\n",
                           terminal.MGMT_FLAG_FINAL)))

        records = [json.loads(line) for line in buffer.getvalue().splitlines()]
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["type"], "response")
        self.assertTrue(records[0]["ok"])
        self.assertEqual(records[0]["lines"], ["OK wifi=accepted"])
        self.assertEqual(records[0]["command"], "@w=<redacted>")
        self.assertEqual(records[1]["type"], "event")
        self.assertNotIn("secret", buffer.getvalue())

    async def test_oversized_command_is_rejected_before_any_write(self):
        client = FakeWriteClient()
        channel = terminal.ManagementChannel(client, cfg(), 8)
        with self.assertRaises(ValueError):
            await channel.send(b"@i?" + b"x" * 32)
        self.assertEqual(client.writes, [])


class ReliableUartTests(unittest.TestCase):
    def make(self, max_payload=232):
        received = []
        channel = terminal.ReliableUartChannel(
            FakeWriteClient(), cfg(), max_payload, 1, 1,
            lambda _c, data: received.append(bytes(data)),
        )
        return channel, received

    def test_frame_is_reassembled_and_delivered_once(self):
        channel, received = self.make()
        channel.on_indication(None, bytearray(uart_frame(1, b"hello")))
        self.assertEqual(received, [b"hello"])
        self.assertEqual(channel.rx_sequence, 2)

    def test_fragmented_frame_waits_for_the_rest(self):
        channel, received = self.make()
        frame = uart_frame(1, b"hello world")
        channel.on_indication(None, bytearray(frame[:14]))
        self.assertEqual(received, [])
        channel.on_indication(None, bytearray(frame[14:]))
        self.assertEqual(received, [b"hello world"])

    def test_duplicate_sequence_is_dropped_silently(self):
        channel, received = self.make()
        channel.on_indication(None, bytearray(uart_frame(1, b"one")))
        channel.on_indication(None, bytearray(uart_frame(1, b"one")))
        self.assertEqual(received, [b"one"])
        self.assertEqual(channel.rx_sequence, 2)

    def test_sequence_gap_is_reported_and_not_delivered(self):
        channel, received = self.make()
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            channel.on_indication(None, bytearray(uart_frame(5, b"skipped")))
        self.assertEqual(received, [])
        self.assertEqual(channel.rx_sequence, 1)
        self.assertIn("sequence gap", errors.getvalue())

    def test_write_uses_one_sequence_per_frame(self):
        client = FakeWriteClient()
        received = []
        channel = terminal.ReliableUartChannel(
            client, cfg(write_size=20), 8, 1, 1,
            lambda _c, data: received.append(bytes(data)),
        )
        asyncio.run(channel.write(b"abcdefghijklmnopqr"))

        frames = []
        buffer = b""
        for _uuid, chunk in client.writes:
            buffer += chunk
            while len(buffer) >= terminal.RELIABLE_UART_HEADER.size:
                _m, _v, _f, sequence, expected, _r = \
                    terminal.RELIABLE_UART_HEADER.unpack_from(buffer)
                if len(buffer) < terminal.RELIABLE_UART_HEADER.size + expected:
                    break
                frames.append((sequence, buffer[terminal.RELIABLE_UART_HEADER.size:
                                               terminal.RELIABLE_UART_HEADER.size
                                               + expected]))
                buffer = buffer[terminal.RELIABLE_UART_HEADER.size + expected:]

        self.assertEqual([sequence for sequence, _ in frames], [1, 2, 3])
        self.assertEqual(b"".join(payload for _s, payload in frames),
                         b"abcdefghijklmnopqr")
        self.assertEqual(channel.tx_sequence, 4)


class BleWriteSizeTests(unittest.TestCase):
    class Services:
        def __init__(self, size):
            self.size = size

        def get_characteristic(self, _uuid):
            return types.SimpleNamespace(max_write_without_response_size=self.size)

    def configure(self, client, requested=0):
        config = cfg()
        with contextlib.redirect_stderr(io.StringIO()):
            terminal.configure_ble_write_size(client, config, requested)
        return config.write_size

    def test_manual_size_is_clamped(self):
        client = types.SimpleNamespace(services=None)
        self.assertEqual(self.configure(client, 300), 244)
        self.assertEqual(self.configure(client, 20), 20)

    def test_advertised_characteristic_size_wins(self):
        client = types.SimpleNamespace(services=self.Services(185), mtu_size=247)
        self.assertEqual(self.configure(client), 185)

    def test_mtu_fallback_when_the_characteristic_is_silent(self):
        client = types.SimpleNamespace(services=self.Services(0), mtu_size=247)
        self.assertEqual(self.configure(client), 244)

    def test_unknown_client_falls_back_to_a_safe_chunk(self):
        client = types.SimpleNamespace()
        self.assertEqual(self.configure(client), 20)


if __name__ == "__main__":
    unittest.main()
