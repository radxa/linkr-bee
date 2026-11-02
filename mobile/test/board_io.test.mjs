import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_LIMITS,
  BOARD_SLOT_NAME_MAX_BYTES,
  BOARD_SWATCHES,
  BOND_LABEL_MAX_BYTES,
  LED_OFF_COMMAND,
  LED_QUERY_COMMAND,
  OPTO_QUERY_COMMAND,
  IR_QUERY_COMMAND,
  IR_SLOTS_COMMAND,
  boardReply,
  bondLabelQueryCommand,
  bondLabelSetCommand,
  hexToUtf8,
  parseBondLabel,
  sanitizeBondLabel,
  irDeleteCommand,
  irLearnCommand,
  irNameQueryCommand,
  irNameSetCommand,
  irPlayCommand,
  irSendCommand,
  isBoardReplyLine,
  isUnsupportedReply,
  ledCommand,
  ledHex,
  optoCommand,
  parseIrName,
  parseIrSlots,
  parseIrStatus,
  parseLearnStarted,
  parseLedStatus,
  parseNumber,
  parseOptoStatus,
  rgbFromHex,
  sanitizeSlotName,
  utf8ToHex,
} from "../../web/board_io.js";

test("LED commands clamp to the firmware channel range", () => {
  assert.equal(ledCommand({ r: 0, g: 24, b: 48 }), "@l=0,24,48");
  assert.equal(ledHex({ r: 0, g: 24, b: 48 }), "001830");
  assert.equal(LED_QUERY_COMMAND, "@l?");
  assert.equal(LED_OFF_COMMAND, "@l off");
  assert.throws(() => ledCommand({ r: 256 }), /red must be an integer/);
  assert.throws(() => ledCommand({ g: -1 }), /green must be an integer/);
  assert.throws(() => ledCommand({ b: 1.5 }), /blue must be an integer/);

  assert.deepEqual(rgbFromHex("#FF8800"), { r: 255, g: 136, b: 0 });
  assert.deepEqual(rgbFromHex("f80"), { r: 255, g: 136, b: 0 });
  assert.throws(() => rgbFromHex("#12345"), /colour must be/);
});

test("optocoupler commands accept the aliases and bound the pulse", () => {
  assert.equal(optoCommand({ action: "on" }), "@o on");
  assert.equal(optoCommand({ action: "close" }), "@o on");
  assert.equal(optoCommand({ action: "off" }), "@o off");
  assert.equal(optoCommand({ action: "open" }), "@o off");
  assert.equal(optoCommand({ action: "pulse", ms: 250 }), "@o pulse 250");
  assert.equal(OPTO_QUERY_COMMAND, "@o?");
  assert.throws(() => optoCommand({ action: "pulse", ms: 0 }), /pulse must be/);
  assert.throws(() => optoCommand({ action: "pulse", ms: 60001 }), /pulse must be/);
  assert.throws(() => optoCommand({ action: "toggle" }), /action must be/);
});

test("numbers accept decimal and hexadecimal like the firmware parser", () => {
  assert.equal(parseNumber("4", { max: 0xffff, name: "address" }), 4);
  assert.equal(parseNumber("0x1234", { max: 0xffff, name: "address" }), 0x1234);
  assert.equal(parseNumber(" 0XFF ", { max: 0xff, name: "command" }), 255);
  assert.throws(() => parseNumber("0x10000", { max: 0xffff, name: "address" }), /address must be between/);
  assert.throws(() => parseNumber("0xZZ", { max: 0xff, name: "command" }), /command must be a number/);
  assert.throws(() => parseNumber("", { max: 0xff, name: "command" }), /command must be a number/);
});

test("NEC send commands match what the firmware parses", () => {
  assert.equal(irSendCommand({ address: 4, command: 8 }), "@r tx 0x0004,0x08");
  assert.equal(
    irSendCommand({ address: "0x1234", command: "0x56", repeats: 3 }),
    "@r tx 0x1234,0x56,3",
  );
  assert.throws(() => irSendCommand({ address: 4, command: 8, repeats: 17 }), /repeats must be/);
  assert.throws(() => irSendCommand({ address: 4, command: 8, repeats: -1 }), /repeats must be/);
});

test("learning slot commands stay inside the slot count", () => {
  assert.equal(irLearnCommand({ slot: 0 }), "@r learn");
  assert.equal(irLearnCommand({ slot: 3 }), "@r learn 3");
  assert.equal(irPlayCommand({ slot: 3 }), "@r play 3");
  assert.equal(irDeleteCommand({ slot: 0 }), "@r delete 0");
  assert.equal(IR_QUERY_COMMAND, "@r?");
  assert.equal(IR_SLOTS_COMMAND, "@r slots");
  assert.throws(() => irLearnCommand({ slot: 8 }), /slot must be between 0 and 7/);
  assert.throws(() => irPlayCommand({ slot: -1 }), /slot must be between 0 and 7/);
  assert.equal(irPlayCommand({ slot: 1 }), "@r play 1");
});

test("status replies are parsed into panel state", () => {
  assert.deepEqual(parseLedStatus("OK led rgb=001830\r\n"), { r: 0, g: 24, b: 48 });
  assert.equal(parseLedStatus("ERR led unsupported"), null);

  assert.deepEqual(parseOptoStatus("OK opto=closed"), { pulse: false, closed: true, ms: null });
  assert.deepEqual(parseOptoStatus("OK opto=open"), { pulse: false, closed: false, ms: null });
  assert.deepEqual(parseOptoStatus("OK opto=pulse ms=500"), { pulse: true, closed: true, ms: 500 });
  assert.equal(parseOptoStatus("ERR opto unsupported"), null);

  const idle = parseIrStatus(
    "OK ir rx=on frames=3 repeats=1 glitches=0 " +
      "last=addr=0x1234,cmd=0x56,ext=yes learn=idle,slots=1/8\r\n",
  );
  assert.deepEqual(idle, {
    rxOn: true,
    frames: 3,
    repeats: 1,
    glitches: 0,
    last: { address: 0x1234, command: 0x56, extended: true },
    learning: { active: false, slot: null, edges: 0 },
    learnSupported: true,
    slotsUsed: 1,
    slotsTotal: 8,
  });

  const active = parseIrStatus(
    "OK ir rx=off frames=0 repeats=0 glitches=0 last=none learn=active,slot=2,edges=12",
  );
  assert.equal(active.rxOn, false);
  assert.equal(active.last, null);
  assert.deepEqual(active.learning, { active: true, slot: 2, edges: 12 });
  assert.equal(active.learnSupported, true);

  // Firmware without the learning feature says learn=off.
  const noLearn = parseIrStatus(
    "OK ir rx=on frames=0 repeats=0 glitches=0 last=none learn=off",
  );
  assert.equal(noLearn.learnSupported, false);

  assert.equal(parseIrStatus("ERR ir unsupported"), null);
});

test("slot listing and learn acknowledgement are parsed", () => {
  assert.deepEqual(parseIrSlots("OK ir slots=0:67,1:0,2:0,3:33 used=2\r\n"), {
    slots: [
      { slot: 0, edges: 67 },
      { slot: 1, edges: 0 },
      { slot: 2, edges: 0 },
      { slot: 3, edges: 33 },
    ],
    used: 2,
  });
  assert.equal(parseIrSlots("ERR ir unsupported"), null);

  assert.deepEqual(parseLearnStarted("OK ir learn slot=2 timeout_ms=15000"), {
    slot: 2,
    timeoutMs: 15000,
  });
  assert.equal(parseLearnStarted("ERR ir learn=idle"), null);
});

test("unsupported boards and error replies are distinguishable", () => {
  assert.equal(isUnsupportedReply("ERR led unsupported\r\n"), true);
  assert.equal(isUnsupportedReply("ERR ir unsupported"), true);
  assert.equal(isUnsupportedReply("OK led rgb=000000"), false);
  assert.equal(isUnsupportedReply("ERR ir learn=idle"), false);

  assert.deepEqual(boardReply("OK led rgb=001830\r\n"), {
    ok: true,
    error: "",
    line: "OK led rgb=001830",
  });
  const failure = boardReply("ERR ir repeat\r\n");
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "ERR ir repeat");

  assert.equal(isBoardReplyLine("OK ir play slot=0 edges=67"), true);
  assert.equal(isBoardReplyLine("OK wifi=connected"), false);
  assert.equal(isBoardReplyLine("[control] @l?"), false);
});

test("colour swatches stay unique and inside the channel range", () => {
  const ids = new Set();
  for (const swatch of BOARD_SWATCHES) {
    assert.match(swatch.hex, /^[0-9a-f]{6}$/);
    assert.match(swatch.label, /^boardColor/);
    assert.equal(ids.has(swatch.hex), false);
    ids.add(swatch.hex);
  }
  assert.equal(BOARD_SWATCHES[0].hex, "000000");
  assert.ok(BOARD_LIMITS.slots >= 1);
});

test("saved-signal names are trimmed and capped to the board's byte budget", () => {
  assert.equal(sanitizeSlotName("  客厅   电源  "), "客厅 电源");
  assert.equal(sanitizeSlotName("Living room TV"), "Living room TV");
  assert.equal(sanitizeSlotName(""), "");
  assert.equal(sanitizeSlotName(null), "");
  // 32 bytes: 10 Chinese characters (3 bytes each) fit, the 11th does not.
  const chinese = sanitizeSlotName("电视".repeat(20));
  assert.equal(new TextEncoder().encode(chinese).length, 30);
  assert.equal(Array.from(chinese).length, 10);
  // Code points, not UTF-16 units: an emoji must not be cut in half.
  const emoji = sanitizeSlotName("🎮".repeat(30));
  assert.equal(new TextEncoder().encode(emoji).length, 32);
  assert.equal(Array.from(emoji).length, 8);
  assert.equal(Array.from(emoji).every((point) => point === "🎮"), true);
  assert.equal(sanitizeSlotName("abc", 3), "abc");
  assert.equal(sanitizeSlotName("abcd", 3), "abc");
  assert.equal(sanitizeSlotName("客厅", 4), "客");
  assert.equal(BOARD_SLOT_NAME_MAX_BYTES, 32);
});

test("slot names travel as UTF-8 hex and are parsed back", () => {
  assert.equal(utf8ToHex("客厅"), "e5aea2e58e85");
  assert.equal(hexToUtf8("e5aea2e58e85"), "客厅");
  assert.equal(hexToUtf8(""), "");
  assert.throws(() => hexToUtf8("abc"), /even-length hexadecimal/);
  assert.throws(() => hexToUtf8("zz"), /even-length hexadecimal/);

  assert.equal(irNameQueryCommand({ slot: 0 }), "@r name 0");
  assert.equal(irNameQueryCommand({ slot: 3 }), "@r name 3");
  assert.equal(irNameSetCommand({ slot: 0, name: "客厅 电源" }), "@r name 0 e5aea2e58e8520e794b5e6ba90");
  assert.equal(irNameSetCommand({ slot: 2, name: "  " }), "@r name 2 clear");
  assert.throws(() => irNameQueryCommand({ slot: 8 }), /slot must be between 0 and 7/);

  assert.deepEqual(parseIrName("OK ir name=0 none\r\n"), { slot: 0, name: "", empty: true });
  assert.deepEqual(parseIrName("OK ir name=1 hex=4c6976696e6720726f6f6d\r\n"),
    { slot: 1, name: "Living room", empty: false });
  assert.deepEqual(parseIrName("OK ir name=2 hex=e5aea2e58e85"), { slot: 2, name: "客厅", empty: false });
  assert.equal(parseIrName("ERR ir name=too-long"), null);
  assert.equal(parseIrName("OK ir slots=0:1"), null);
});

test("bond labels build, parse, and sanitize", () => {
  assert.equal(BOND_LABEL_MAX_BYTES, 48);
  const id = "1/AA:BB:CC:DD:EE:01";
  assert.equal(bondLabelQueryCommand({ id }), "@linkr bonds label 1/AA:BB:CC:DD:EE:01");
  assert.equal(bondLabelSetCommand({ id, label: "客厅" }), "@linkr bonds label 1/AA:BB:CC:DD:EE:01 e5aea2e58e85");
  assert.equal(bondLabelSetCommand({ id, label: "  " }), "@linkr bonds label 1/AA:BB:CC:DD:EE:01 clear");
  assert.throws(() => bondLabelQueryCommand({ id: "2/AA:BB:CC:DD:EE:01" }), /bond address/);
  assert.throws(() => bondLabelSetCommand({ id: "aa:bb" }), /bond address/);

  assert.deepEqual(parseBondLabel("OK bonds label=1/AA:BB:CC:DD:EE:01 none\r\n"),
    { id: "1/AA:BB:CC:DD:EE:01", label: "", empty: true });
  assert.deepEqual(parseBondLabel("OK bonds label=0/aa:bb:cc:dd:ee:02 hex=4c6976696e67"),
    { id: "0/AA:BB:CC:DD:EE:02", label: "Living", empty: false });
  assert.deepEqual(parseBondLabel("OK bonds label=0/AA:BB:CC:DD:EE:02 hex=e5aea2e58e85"),
    { id: "0/AA:BB:CC:DD:EE:02", label: "客厅", empty: false });
  assert.equal(parseBondLabel("ERR bonds label hex"), null);
  assert.equal(parseBondLabel("OK"), null);

  /* Control bytes are stripped (labels reach the terminal), whitespace is
   * collapsed, and truncation never splits a code point. */
  assert.equal(sanitizeBondLabel("a\u001b[2Jb"), "a[2Jb");
  assert.equal(sanitizeBondLabel("  a   b  "), "a b");
  assert.equal(sanitizeBondLabel("客".repeat(20), 4), "客");
});
