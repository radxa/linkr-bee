import assert from "node:assert/strict";
import test from "node:test";
import {
  accessoryChangeSummary,
  bleNameCommand,
  isDiagnosticsDone,
  parseBleName,
  parseInfoGroups,
  parseUartSettings,
  parseWebdavStatus,
  parseWifiStatus,
  redactCommand,
  replyStatus,
  setUartCommand,
  webdavCommand,
  wifiCommand,
} from "../../web/accessory_control.js";

test("UART commands are built from validated settings only", () => {
  assert.equal(setUartCommand({ baud: 115200 }), "@u=115200,8,n,1,none");
  assert.equal(setUartCommand({ baud: 9600, dataBits: 7, parity: "E", stopBits: 2, flow: "rtscts" }),
    "@u=9600,7,e,2,rtscts");
  for (const bad of [
    {}, { baud: 299 }, { baud: 3000001 }, { baud: 9600.5 }, { baud: "fast" },
    { baud: 9600, dataBits: 9 }, { baud: 9600, parity: "m" }, { baud: 9600, stopBits: 3 }, { baud: 9600, flow: "xon" },
  ]) {
    assert.throws(() => setUartCommand(bad), Error, JSON.stringify(bad));
  }
});

test("WiFi commands refuse anything the firmware parser would misread", () => {
  assert.equal(wifiCommand({ action: "connect", ssid: "Bench", password: "secret" }), "@w=Bench,secret");
  assert.equal(wifiCommand({ ssid: "Open" }), "@w=Open,");
  assert.equal(wifiCommand({ action: "off" }), "@w off");
  // A comma would move the rest of the SSID into the password field.
  assert.throws(() => wifiCommand({ ssid: "Bench,5G", password: "secret" }), /comma/);
  assert.throws(() => wifiCommand({ ssid: "x".repeat(33) }), /at most 32/);
  assert.throws(() => wifiCommand({ ssid: "Bench", password: "x".repeat(65) }), /at most 64/);
  assert.throws(() => wifiCommand({ ssid: "   " }), /required/);
  assert.throws(() => wifiCommand({ action: "reset", ssid: "Bench" }), /connect or off/);
});

test("WebDAV commands accept only plain HTTP endpoints", () => {
  assert.equal(webdavCommand({ url: "http://host/dav/" }), "@d=http://host/dav/");
  assert.equal(webdavCommand({ url: "https://host/dav/" }), "@d=https://host/dav/");
  assert.equal(webdavCommand({ action: "off" }), "@d off");
  assert.throws(() => webdavCommand({}), /required/);
  assert.throws(() => webdavCommand({ url: "ftp://host/dav/" }), /http/);
  assert.throws(() => webdavCommand({ url: `http://host/${"x".repeat(250)}` }), /at most 256/);
  assert.throws(() => webdavCommand({ url: "http://host/a b" }), /whitespace/);
});

test("BLE name commands use UTF-8 byte limits and can restore the MAC default", () => {
  assert.equal(bleNameCommand({ name: "Linkr Bee 078C" }), "@n=Linkr Bee 078C");
  assert.equal(bleNameCommand({ name: "  测试 Bee  " }), "@n=测试 Bee");
  assert.equal(bleNameCommand({ reset: true }), "@n default");
  // 9 Chinese characters are 27 bytes, 10 are 30.
  assert.equal(bleNameCommand({ name: "测试测试测试测试测" }), "@n=测试测试测试测试测");
  assert.throws(() => bleNameCommand({ name: "测试测试测试测试测试" }), /29 UTF-8 bytes/);
  assert.throws(() => bleNameCommand({ name: "   " }), /required/);
  assert.throws(() => bleNameCommand({ name: "Bee\nName" }), /control/);
  // The firmware's full reject set, not only C0/DEL: C1 and the Unicode line
  // separators are refused before the command would leave the browser.
  assert.throws(() => bleNameCommand({ name: "a\u0085b" }), /control/);
  assert.throws(() => bleNameCommand({ name: "a\u2028b" }), /control/);
  assert.throws(() => bleNameCommand({ name: "a\u2029b" }), /control/);
  // Trimming matches the firmware's four ASCII bytes; NBSP and U+3000 are
  // ordinary characters and must survive so every host stores the same name.
  assert.equal(bleNameCommand({ name: "\u00a0Bee\u3000" }), "@n=\u00a0Bee\u3000");
});

test("BLE names allow emoji and enforce the byte budget, not the character count", () => {
  // A four-byte emoji plus ASCII still fits; seven emoji are 28 bytes and one
  // more ASCII byte reaches the exact 29-byte advertisement limit.
  assert.equal(bleNameCommand({ name: "🐝 Linkr Bee" }), "@n=🐝 Linkr Bee");
  assert.equal(bleNameCommand({ name: `${"😀".repeat(7)}a` }), `@n=${"😀".repeat(7)}a`);
  assert.throws(() => bleNameCommand({ name: "😀".repeat(8) }), /29 UTF-8 bytes/);
  // Multi-code-point emoji sequences are ordinary valid UTF-8: family (ZWJ),
  // flag (regional indicators), heart (variation selector), and skin tone.
  for (const name of ["👨‍👩‍👧‍👦", "🇨🇳", "❤️", "👍🏽"]) {
    assert.equal(bleNameCommand({ name }), `@n=${name}`);
  }
  assert.equal(
    bleNameCommand({ name: "👨‍👩‍👧‍👦🐝" }),
    "@n=👨‍👩‍👧‍👦🐝",
    "a 25-byte family plus a 4-byte emoji is exactly 29 bytes",
  );
});

test("BLE name replies preserve spaces and report whether the name is custom", () => {
  assert.deepEqual(parseBleName("OK name=Linkr Bee 078C custom=no", { query: true }), { name: "Linkr Bee 078C", custom: false });
  assert.deepEqual(parseBleName("OK name=测试 Bee custom=yes", { query: true }), { name: "测试 Bee", custom: true });
  assert.deepEqual(parseBleName("OK name=🐝 Linkr Bee custom=yes", { query: true }), { name: "🐝 Linkr Bee", custom: true });
  assert.deepEqual(parseBleName("OK name=Linkr Bee 078C"), { name: "Linkr Bee 078C", custom: null });
  // A write reply carries no `custom=` field, so a name that itself ends in
  // " custom=yes" must survive a write parse intact; only a query strips the
  // final suffix.
  assert.deepEqual(parseBleName("OK name=Bee custom=yes"), { name: "Bee custom=yes", custom: null });
  assert.deepEqual(parseBleName("OK name=Bee custom=yes custom=no", { query: true }), { name: "Bee custom=yes", custom: false });
  // A trailing U+3000 belongs to the name; the parser strips only the line
  // ending, not Unicode whitespace the firmware would have stored.
  assert.deepEqual(parseBleName("OK name=Bee\u3000 custom=no", { query: true }), { name: "Bee\u3000", custom: false });
  assert.equal(parseBleName("ERR name expected 1-29 UTF-8 bytes"), null);
  assert.equal(parseBleName(""), null);
});

test("credentials never survive into a display or a tool result", () => {
  assert.equal(redactCommand("@w=Bench,secret"), "@w=Bench,<redacted>");
  assert.equal(redactCommand("@w=Open,"), "@w=Open,<redacted>");
  assert.equal(redactCommand("@w off"), "@w off");
  assert.equal(redactCommand("@d=http://user:pass@host/dav/"), "@d=http://<redacted>@host/dav/");
  assert.equal(redactCommand("@d=http://host/dav/"), "@d=http://host/dav/");
  assert.equal(redactCommand("@u=9600,8,n,1,none"), "@u=9600,8,n,1,none");

  const summary = accessoryChangeSummary("@w=Bench,secret", "en");
  assert.match(summary, /Bench/);
  assert.doesNotMatch(summary, /secret/);
  assert.match(accessoryChangeSummary("@w=Bench,secret", "zh-CN"), /Bench/);
  assert.doesNotMatch(accessoryChangeSummary("@w=Bench,secret", "zh-CN"), /secret/);
  assert.equal(accessoryChangeSummary("@u=9600,8,n,1,none", "en"), "Set the bridge UART to 9600,8,n,1,none");
  assert.equal(accessoryChangeSummary("@d off", "zh-CN"), "关闭 WebDAV 日志上传");
});

test("firmware replies are read as OK or as an error the model can act on", () => {
  assert.deepEqual(replyStatus("OK uart=115200,8,N,1,none"), { ok: true, error: "" });
  assert.deepEqual(replyStatus("ERR format: @u=115200,8,n,1,n\r\n"), { ok: false, error: "ERR format: @u=115200,8,n,1,n" });
  assert.equal(replyStatus("").ok, false);
  assert.equal(replyStatus(undefined).ok, false);
});

test("status replies are parsed into the fields a change is verified against", () => {
  assert.deepEqual(parseUartSettings("OK uart=115200,8,N,1,none"), { baud: 115200, dataBits: 8, parity: "n", stopBits: 1, flow: "none" });
  assert.deepEqual(parseWifiStatus("OK wifi=connected,ssid=MyNet,ip=192.168.1.5"), { state: "connected", ssid: "MyNet", ip: "192.168.1.5" });
  assert.deepEqual(parseWifiStatus("OK wifi off"), { state: "off", ssid: "", ip: "" });
  assert.deepEqual(parseWebdavStatus("OK webdav=on,url=http://host/dav/"), { state: "on", url: "http://host/dav/" });
  assert.equal(parseUartSettings("OK"), null);
  assert.equal(parseWifiStatus("garbage"), null);
  assert.equal(parseWebdavStatus(""), null);
});

test("the @i? stream is grouped until the device reports completion", () => {
  const lines = [
    "@info fw version=0.1.2 zephyr=4.4.1",
    "@info sys uptime_ms=123456 owner=0 security=2",
    "@info uart dropped=0 dropped_no_conn=0 buffer=12/4096",
  ];
  assert.deepEqual(parseInfoGroups(lines), {
    fw: { version: "0.1.2", zephyr: "4.4.1" },
    sys: { uptime_ms: "123456", owner: "0", security: "2" },
    uart: { dropped: "0", dropped_no_conn: "0", buffer: "12/4096" },
  });
  assert.equal(isDiagnosticsDone("@info done"), true);
  assert.equal(isDiagnosticsDone("@info fw version=0.1.2"), false);
  assert.equal(parseInfoGroups(["@info done"]).done, undefined);
});
