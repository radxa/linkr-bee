"""Contract tests for the LAN WebSocket bridge and the documented command set.

Two kinds of drift are covered here, because neither is caught by compiling or
by running one side alone:

* The bridge (``src/ws_bridge.c``) and the browser client (``web/app.js``) agree
  on a small text handshake. They are different languages, so the literals are
  compared directly.
* The command tables in ``docs/DEVELOPMENT.md`` and
  ``docs/DEVELOPMENT.zh-CN.md`` must name long forms that the firmware actually
  matches, otherwise the docs advertise commands that answer
  ``ERR unknown command``.
"""
import codecs
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]

WS_BRIDGE = (ROOT / "src/ws_bridge.c").read_text()
APP = (ROOT / "web/app.js").read_text()
WS_BRIDGE_H = (ROOT / "src/ws_bridge.h").read_text()
MAIN = (ROOT / "src/main.c").read_text()
TARGET_BINDING = (ROOT / "src/target_binding.c").read_text()

FRAME_NAMES = ["WS_AUTH_NONE_FRAME", "WS_AUTH_REQUIRED_FRAME", "WS_AUTH_OK_FRAME"]


def c_define_string(name):
    match = re.search(rf'^#define\s+{name}\s+"([^"]*)"', WS_BRIDGE, re.MULTILINE)
    if not match:
        raise AssertionError(f"{name} is not defined in src/ws_bridge.c")
    return codecs.decode(match.group(1), "unicode_escape")


def js_const_string(name):
    match = re.search(rf'^const\s+{name}\s*=\s*"([^"]*)"', APP, re.MULTILINE)
    if not match:
        raise AssertionError(f"{name} is not defined in web/app.js")
    return match.group(1)


def function_body(source, signature):
    start = source.index(signature)
    return source[start:source.index("\n}\n", start)]


class LanHandshakeTests(unittest.TestCase):
    def test_frame_literals_match_the_browser_client(self):
        for name in FRAME_NAMES:
            # The C literals carry CRLF; the client compares trimmed text.
            self.assertEqual(c_define_string(name).rstrip("\r\n"),
                             js_const_string(name), name)

    def test_token_length_agrees_across_firmware_client_and_docs(self):
        length = int(re.search(r"#define WS_TOKEN_HEX_LEN (\d+)", WS_BRIDGE).group(1))
        self.assertEqual(length, 32)
        # The browser client validates the same width.
        self.assertTrue(
            f"[0-9a-f]{{{length}}}" in APP,
            f"web/app.js does not validate a {length}-character hex token",
        )
        # The docs tell users how many characters to type. Match the number as a
        # whole token: a bare substring test would also pass on "132" or a port.
        for doc in ["docs/DEVELOPMENT.md", "docs/DEVELOPMENT.zh-CN.md",
                    "docs/LINKR_BLE_API.zh-CN.md"]:
            self.assertRegex(
                (ROOT / doc).read_text(),
                rf"\b{length}\b",
                f"{doc} never mentions the {length}-character token",
            )

    def test_uart_fanout_waits_for_authentication(self):
        # The slot must stay CLAIMED until ws_client_auth() succeeds: an
        # unauthenticated socket must never be eligible for UART bytes.
        setup = function_body(WS_BRIDGE, "static int linkr_ws_setup(")
        self.assertIsNone(
            re.search(r"state,\s*WS_CLIENT_ACTIVE", setup),
            "linkr_ws_setup must not promote a slot to WS_CLIENT_ACTIVE",
        )
        self.assertIn("WS_CLIENT_CLAIMED", setup)

        self.assertIn("atomic_set(&client->state, WS_CLIENT_ACTIVE)",
                      function_body(WS_BRIDGE, "static bool ws_client_auth("))
        # Fan-out targets authenticated clients only.
        self.assertIn("WS_CLIENT_ACTIVE",
                      function_body(WS_BRIDGE, "void linkr_ws_feed("))

    def test_token_is_absent_from_diagnostics(self):
        # "@i?" output is pasted into bug reports; "@s?" is the delivery path.
        self.assertNotIn("token", function_body(WS_BRIDGE, "int linkr_ws_diagnostics("))
        self.assertIn("token", function_body(WS_BRIDGE, "int linkr_ws_status("))

    def test_bridge_fails_closed_without_a_token(self):
        # No token and no entropy => refuse to listen rather than expose the
        # target console to the whole network.
        self.assertIn("ws_auth_blocked", function_body(WS_BRIDGE, "static int ws_server_start("))
        self.assertIn("(void)ws_token_resolve();", WS_BRIDGE)


class DocumentedCommandTests(unittest.TestCase):
    """Every documented ``@linkr <long form>`` must exist in the firmware."""

    @classmethod
    def setUpClass(cls):
        literals = set(re.findall(r'"([a-z][a-z0-9 _?=,]*)"', MAIN + TARGET_BINDING))
        cls.literals = literals

    @staticmethod
    def documented_long_forms(path):
        rows = re.findall(r"^\|\s*`@[^`]+`\s*\|\s*`@linkr ([^`]+)`",
                          path.read_text(), re.MULTILINE)
        # Drop blank cells; the earlier `endswith(("",)) or row` was always true.
        return [row.strip() for row in rows if row.strip()]

    def matched(self, body):
        for literal in self.literals:
            if literal == body:
                return True
            # Value forms are matched by prefix ("wifi=" handles "wifi=SSID,pass").
            if literal.endswith(("=", "?")) and body.startswith(literal):
                return True
            if body.startswith(literal + " "):
                return True
        return False

    def test_documented_long_forms_exist(self):
        for name in ["docs/DEVELOPMENT.md", "docs/DEVELOPMENT.zh-CN.md"]:
            forms = self.documented_long_forms(ROOT / name)
            self.assertGreater(len(forms), 5, name)
            for body in forms:
                # Trim a documented value placeholder: "@linkr uart=baud,...".
                self.assertTrue(
                    self.matched(body),
                    f"{name} documents '@linkr {body}' but the firmware never matches it",
                )


if __name__ == "__main__":
    unittest.main()
