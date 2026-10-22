"""Host tests for the firmware's advertised-name logic (src/main.c).

The name rules and the two pieces of state that must move together — the
name buffer and the length the scan response advertises with it — are the
firmware's own code, sliced out and compiled against host fakes. What a board
does with the name over the air is hardware behaviour and stays on the bench.
"""

import errno
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def slice_between(source: str, start: str, end: str, required: list[str]) -> str:
    """Cut a production block out by literal anchors.

    A moved anchor must fail loudly rather than quietly compile a different
    function, so the names the test depends on are asserted to be inside the
    block, and the harness compiles with -Werror so a truncated slice cannot
    pass unnoticed.
    """
    begin = source.index(start)
    block = source[begin:source.index(end, begin)]
    for name in required:
        if f"{name}(" not in block:
            raise AssertionError(f"{name} is missing from the extracted block")
    return block


class BleNameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="linkr-ble-name-")
        cls.addClassCleanup(cls.tmp.cleanup)
        directory = Path(cls.tmp.name)
        main = (ROOT / "src/main.c").read_text()
        block = (
            slice_between(main, "static bool ble_name_valid(",
                          "static void ble_name_make_default(",
                          ["ble_name_valid"])
            + slice_between(main, "static void ble_name_make_default(",
                            "static int ble_name_apply(",
                            ["ble_name_make_default"])
            + slice_between(main, "static int ble_name_apply(",
                            "static int ble_name_settings_set(",
                            ["ble_name_apply"])
            + slice_between(main, "enum ble_name_persist_result {",
                            "SETTINGS_STATIC_HANDLER_DEFINE(",
                            ["ble_name_install_and_save",
                             "ble_name_reset_and_delete",
                             "ble_name_parse_command"])
        )
        (directory / "ble_name_production.inc").write_text(block)
        # Compile the harness with the firmware's own limit. The harness no
        # longer defines its own 29, so a changed limit reaches the vectors
        # below and trips the 29/30-byte cases instead of going unnoticed.
        limit = re.search(r"^#define BLE_NAME_MAX (\d+)$", main, re.MULTILINE)
        if not limit:
            raise AssertionError("src/main.c has no BLE_NAME_MAX definition")
        cls.binary = directory / "ble-name-test"
        subprocess.run([
            *shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-Wall",
            "-Wextra", "-Werror", f"-DBLE_NAME_MAX={limit.group(1)}",
            "-I", str(directory),
            str(ROOT / "tests/ble_name_harness.c"), "-o", str(cls.binary),
        ], check=True)

    def scenario(self, name: str) -> dict[str, str]:
        result = subprocess.run([str(self.binary), name], check=True,
                                capture_output=True, text=True, timeout=10)
        fields = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition("=")
            fields[key] = value
        return fields

    def test_the_name_command_spellings_are_the_documented_ones(self):
        """`@n default` resets; `@n=default` and `@n  default` set a literal
        name.  Lock the parser branch, not a source-order coincidence."""
        fields = self.scenario("commands")
        self.assertEqual(fields["query_name_cmd"], "query")
        self.assertEqual(fields["query_n_cmd"], "query")
        self.assertEqual(fields["query_name_q_cmd"], "query")
        self.assertEqual(fields["query_n_q_cmd"], "query")
        self.assertEqual(fields["reset_name_cmd"], "reset")
        self.assertEqual(fields["reset_n_cmd"], "reset")
        self.assertEqual(fields["set_eq_cmd"], "set")
        self.assertEqual(fields["set_eq_value"], "default")
        self.assertEqual(fields["set_n_eq_cmd"], "set")
        self.assertEqual(fields["set_n_eq_value"], "default")
        self.assertEqual(fields["set_two_spaces_cmd"], "set")
        self.assertEqual(fields["set_two_spaces_value"], " default")
        self.assertEqual(fields["set_name_cmd"], "set")
        self.assertEqual(fields["set_name_value"], "Bench Bee")
        self.assertEqual(fields["set_n_name_cmd"], "set")
        self.assertEqual(fields["set_n_name_value"], "Bench Bee")
        self.assertEqual(fields["none_cmd"], "none")
        self.assertEqual(fields["null_cmd"], "none")

    def test_the_name_rules_are_the_firmware_ones(self):
        """One to 29 UTF-8 bytes, valid encoding, no controls."""
        fields = self.scenario("validate")
        self.assertEqual(fields["plain"], "1")
        self.assertEqual(fields["chinese"], "1")
        # The limit is bytes, not characters: seven four-byte emoji fit.
        self.assertEqual(fields["emoji7"], "1")
        self.assertEqual(fields["emoji8"], "0")
        # Pin the exact boundary the host clients mirror.
        self.assertEqual(fields["bytes29"], "1")
        self.assertEqual(fields["bytes30"], "0")
        self.assertEqual(fields["empty"], "0")
        self.assertEqual(fields["control"], "0")
        self.assertEqual(fields["del"], "0")
        self.assertEqual(fields["c1"], "0")
        # U+2028/U+2029 are line breaks to some terminals and logs even
        # though they are not C0/C1; the firmware refuses them everywhere.
        self.assertEqual(fields["line_separator"], "0")
        self.assertEqual(fields["paragraph_separator"], "0")
        self.assertEqual(fields["overlong"], "0")
        self.assertEqual(fields["truncated"], "0")
        self.assertEqual(fields["surrogate"], "0")

    def test_installing_a_name_moves_the_buffer_and_the_length_together(self):
        fields = self.scenario("apply")
        self.assertEqual(fields["err"], "0")
        self.assertEqual(fields["applied_buffer"], "测试😀")
        # Six bytes of Chinese plus a four-byte emoji.
        self.assertEqual(fields["applied_length"], "10")
        self.assertEqual(fields["name"], "测试😀")

    def test_a_refused_name_leaves_the_advertised_name_untouched(self):
        """A controller that will not take the name must not leave the scan
        response advertising half of it."""
        fields = self.scenario("apply_fail")
        self.assertNotEqual(fields["err"], "0")
        self.assertEqual(fields["rejected_buffer"], "Linkr Bee 078C")
        self.assertEqual(fields["rejected_length"], "15")

    def test_the_rename_paths_restart_the_advertising(self):
        """The scan response is copied into the controller when advertising
        starts, so a renamed board keeps broadcasting the old name until the
        advertising is cycled. Both rename paths must cycle it, through the
        one work item that owns the stop/start pair."""
        main = (ROOT / "src/main.c").read_text()
        self.assertIn("static void ble_name_advertise_refresh(void)",
                      main)
        refresh = main[main.index("static void ble_name_advertise_refresh("):
                       main.index("#endif", main.index(
                           "static void ble_name_advertise_refresh("))]
        # The request is handed to the advertising work, not acted on from
        # the BT RX workqueue: both threads touch the legacy advertising API.
        self.assertIn("atomic_set(&advertise_refresh_req, 1)", refresh)
        self.assertIn("advertise_schedule(K_NO_WAIT)", refresh)
        self.assertNotIn("bt_le_adv_stop()", refresh)

        work = main[main.index("static void advertise_retry("):
                    main.index("static void advertise_schedule(")]
        stop_at = work.index("bt_le_adv_stop()")
        start_at = work.index("advertise_start()")
        self.assertLess(stop_at, start_at,
                        "the scan response is only refreshed by a new start")
        # A failed stop leaves the old response on the air: ask for another
        # pass instead of starting a second advertising set beside it.
        self.assertIn("atomic_set(&advertise_refresh_req, 1)", work)
        self.assertIn("k_work_reschedule(&advertise_work, K_MSEC(500))", work)

        # Both the set path and the reset path call it: two call sites, and
        # the definition itself is the third mention of the name.
        self.assertEqual(main.count("ble_name_advertise_refresh();"), 2)

    def test_the_default_name_comes_from_the_hardware_id(self):
        """The fallback chain must produce a displayable name, not empty
        bytes: factory hardware ID first, then the BLE identity's address,
        then the bare prefix."""
        fields = self.scenario("default")
        self.assertEqual(fields["hardware"], "Linkr Bee 078C")
        self.assertEqual(fields["identity"], "Linkr Bee 078C")
        self.assertEqual(fields["fallback"], "Linkr Bee")
        for key in ("hardware_custom", "identity_custom", "fallback_custom"):
            self.assertEqual(fields[key], "0", key)

    def test_a_successful_save_installs_before_persisting(self):
        fields = self.scenario("save_ok")
        self.assertEqual(fields["save_ok_result"], "0")
        self.assertEqual(fields["save_ok_buffer"], "New Name")
        self.assertEqual(fields["save_ok_length"], "8")
        self.assertEqual(fields["save_ok_custom"], "1")
        self.assertEqual(fields["save_ok_save_calls"], "1")
        self.assertEqual(fields["save_ok_saved"], "New Name")
        self.assertEqual(fields["save_ok_saved_len"], "8")

    def test_a_failed_save_rolls_the_runtime_name_back(self):
        """Persist second, and undo the runtime change if persisting fails.

        The old order wrote settings first: a stack refusal then left the
        stored name and the advertised name disagreeing until reboot.
        """
        fields = self.scenario("save_fail")
        self.assertEqual(fields["save_fail_result"], "2")
        self.assertEqual(fields["save_fail_err"], str(-errno.EIO))
        self.assertEqual(fields["save_fail_buffer"], "Old Name")
        self.assertEqual(fields["save_fail_length"], "8")
        self.assertEqual(fields["save_fail_custom"], "1")
        self.assertEqual(fields["save_fail_save_calls"], "1")
        self.assertEqual(fields["save_fail_bt_last"], "Old Name")

    def test_a_refused_install_does_not_touch_the_store(self):
        fields = self.scenario("install_fail")
        self.assertEqual(fields["install_fail_result"], "1")
        self.assertEqual(fields["install_fail_err"], str(-errno.EINVAL))
        self.assertEqual(fields["install_fail_buffer"], "Old Name")
        self.assertEqual(fields["install_fail_length"], "8")
        self.assertEqual(fields["install_fail_custom"], "1")
        self.assertEqual(fields["install_fail_save_calls"], "0")

    def test_reset_installs_then_deletes_the_stored_name(self):
        fields = self.scenario("reset_ok")
        self.assertEqual(fields["reset_ok_result"], "0")
        self.assertEqual(fields["reset_ok_buffer"], "Linkr Bee 078C")
        self.assertEqual(fields["reset_ok_length"], "14")
        self.assertEqual(fields["reset_ok_custom"], "0")
        self.assertEqual(fields["reset_ok_delete_calls"], "1")
        self.assertEqual(fields["reset_ok_bt_last"], "Linkr Bee 078C")

    def test_a_refused_reset_restores_the_name_and_the_length(self):
        """A failure to hand the default name to the stack must not leave the
        old length beside the new bytes."""
        fields = self.scenario("reset_install_fail")
        self.assertEqual(fields["reset_install_fail_result"], "1")
        self.assertEqual(fields["reset_install_fail_err"], str(-errno.EINVAL))
        self.assertEqual(fields["reset_install_fail_buffer"], "Old Name")
        self.assertEqual(fields["reset_install_fail_length"], "8")
        self.assertEqual(fields["reset_install_fail_custom"], "1")
        self.assertEqual(fields["reset_install_fail_delete_calls"], "0")

    def test_a_failed_delete_restores_the_name_and_the_length(self):
        fields = self.scenario("reset_delete_fail")
        self.assertEqual(fields["reset_delete_fail_result"], "2")
        self.assertEqual(fields["reset_delete_fail_err"], str(-errno.EIO))
        self.assertEqual(fields["reset_delete_fail_buffer"], "Old Name")
        self.assertEqual(fields["reset_delete_fail_length"], "8")
        self.assertEqual(fields["reset_delete_fail_custom"], "1")
        self.assertEqual(fields["reset_delete_fail_delete_calls"], "1")
        self.assertEqual(fields["reset_delete_fail_bt_last"], "Old Name")


if __name__ == "__main__":
    unittest.main()
