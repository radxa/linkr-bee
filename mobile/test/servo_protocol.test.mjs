import assert from "node:assert/strict";
import test from "node:test";
import {
  FAMILIES,
  INSTRUCTION,
  MODELS,
  REGISTERS,
  SCS_REGISTERS,
  ServoLink,
  SimulatedBus,
  checksum,
  decodeRegister,
  encodeFrame,
  encodeRegister,
  frameChecksumValid,
  bytesFromWord,
  modelInfoFromBytes,
  parseIdRange,
  parseStatusFrames,
  registersFor,
  toBytes,
  wordFromBytes,
} from "../../web/servo_protocol.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function connected({ echo = true, ids = [1, 2] } = {}) {
  const bus = new SimulatedBus({ ids, echo, latencyMs: 0 });
  const link = new ServoLink({
    write: (bytes) => bus.write(bytes),
    echo,
    timeoutMs: 120,
  });
  bus.onData = (bytes) => link.feed(bytes);
  return { bus, link };
}

test("a ping frame is the byte string the servo expects", () => {
  assert.deepEqual(
    Array.from(encodeFrame(1, INSTRUCTION.ping)),
    [0xff, 0xff, 0x01, 0x02, 0x01, 0xfb],
  );
  assert.equal(frameChecksumValid(encodeFrame(1, INSTRUCTION.ping)), true);
  assert.equal(
    frameChecksumValid(Uint8Array.from([0xff, 0xff, 0x01, 0x02, 0x01, 0xfc])),
    false,
  );
});

test("status frames are split out of a noisy stream", () => {
  const frame = Uint8Array.from([0xff, 0xff, 0x01, 0x04, 0x00, 0x00, 0x08, 0xee]);
  // checksum over id/len/error/data
  frame[7] = checksum(frame.slice(2, 7));
  const { frames, rest } = parseStatusFrames(
    Uint8Array.from([0x41, 0x42, ...frame, 0xff, 0xff]),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 1);
  assert.deepEqual(Array.from(frames[0].data), [0x00, 0x08]);
  assert.equal(rest.length, 2);
});

test("a register maps to and from the wire", () => {
  const position = REGISTERS.find((register) => register.name === "position");
  assert.equal(decodeRegister(position, Uint8Array.from([0x00, 0x08])), 2048);
  const load = REGISTERS.find((register) => register.name === "load");
  assert.equal(decodeRegister(load, Uint8Array.from([0x00, 0x05])), -256);
  const voltage = REGISTERS.find((register) => register.name === "voltage");
  assert.equal(decodeRegister(voltage, Uint8Array.from([0x78])), 12);
  assert.deepEqual(encodeRegister(position, 2048), [0x00, 0x08]);
  assert.deepEqual(encodeRegister(voltage, 12), [120]);
});

test("parseIdRange accepts ranges, lists and ignores junk", () => {
  assert.deepEqual(parseIdRange("1-3,5"), [1, 2, 3, 5]);
  assert.deepEqual(parseIdRange("3, 3, 4"), [3, 4]);
  assert.deepEqual(parseIdRange(""), []);
});

test("echo and answer are untangled on a half-duplex bus", async () => {
  const { link } = connected({ echo: true });
  const pong = await link.request(1, INSTRUCTION.ping);
  assert.ok(pong);
  assert.equal(pong.id, 1);
  assert.equal(pong.error, 0);
});

test("a direction-controlled adapter without echo also works", async () => {
  const { link } = connected({ echo: false });
  const pong = await link.request(1, INSTRUCTION.ping);
  assert.ok(pong);
  assert.equal(pong.id, 1);
});

test("echo split across notifications is still removed", async () => {
  const written = [];
  const link = new ServoLink({ write: async (bytes) => written.push(bytes), echo: true, timeoutMs: 200 });
  const ping = encodeFrame(1, INSTRUCTION.ping);
  const response = Uint8Array.from([0xff, 0xff, 0x01, 0x02, 0x00, 0xfc]);
  const pending = link.request(1, INSTRUCTION.ping);
  await tick();
  link.feed(ping.slice(0, 3));
  link.feed(ping.slice(3));
  link.feed(response.slice(0, 2));
  link.feed(response.slice(2));
  const pong = await pending;
  assert.equal(pong?.id, 1);
  assert.equal(written.length, 1);
  assert.deepEqual(Array.from(written[0]), Array.from(ping));
});

test("a missing servo ends the request with null", async () => {
  const { link } = connected();
  const pong = await link.request(9, INSTRUCTION.ping, [], { timeoutMs: 20 });
  assert.equal(pong, null);
});

test("read, write and telemetry work through the simulator", async () => {
  const { link } = connected({ echo: true });
  const model = await link.request(1, INSTRUCTION.read, [3, 2]);
  assert.equal(model.data[0] | (model.data[1] << 8), 777);

  await link.request(1, INSTRUCTION.write, [42, 0x00, 0x0b]);
  const position = await link.request(1, INSTRUCTION.read, [56, 2]);
  assert.equal(position.data[0] | (position.data[1] << 8), 0x0b00);
  assert.equal(position.error, 0);
});

test("sync write reaches every servo without expecting a reply", async () => {
  const { link } = connected({ echo: true, ids: [1, 2] });
  await link.send(0xfe, INSTRUCTION.syncWrite, [
    42, 2,
    1, 0x00, 0x08,
    2, 0x00, 0x04,
  ]);
  const first = await link.request(1, INSTRUCTION.read, [56, 2]);
  const second = await link.request(2, INSTRUCTION.read, [56, 2]);
  assert.equal(first.data[0] | (first.data[1] << 8), 2048);
  assert.equal(second.data[0] | (second.data[1] << 8), 1024);
});


test("model bytes identify the family and its register map", () => {
  const sts = modelInfoFromBytes(Uint8Array.from([9, 3]));
  assert.equal(sts.name, "STS3215");
  assert.equal(sts.family, "sts");
  assert.equal(sts.positionMax, 4095);
  assert.equal(sts.lock, 55);
  assert.equal(registersFor(sts), REGISTERS);

  const scs = modelInfoFromBytes(Uint8Array.from([5, 4]));
  assert.equal(scs.name, "SCS0009");
  assert.equal(scs.family, "scs");
  assert.equal(scs.endian, "big");
  assert.equal(scs.positionMax, 1023);
  assert.equal(scs.lock, 48);
  assert.equal(registersFor(scs), SCS_REGISTERS);

  const hd = modelInfoFromBytes(Uint8Array.from([10, 31]));
  assert.equal(hd.family, "hd");
  assert.equal(modelInfoFromBytes(Uint8Array.from([0xee, 0xee])).known, false);
  assert.equal(FAMILIES.hd.factory, 0x06);
  assert.equal(MODELS.length, 3);
});

test("byte order helpers round-trip both families", () => {
  assert.deepEqual(bytesFromWord(0x0309, "big"), [0x03, 0x09]);
  assert.deepEqual(bytesFromWord(0x0309, "little"), [0x09, 0x03]);
  assert.equal(wordFromBytes(Uint8Array.from([0x03, 0x09]), "big"), 0x0309);
  assert.equal(wordFromBytes(Uint8Array.from([0x09, 0x03]), "little"), 0x0309);
});

test("the SCS family moves with big-endian goal and time fields", async () => {
  const bus = new SimulatedBus({ ids: [1], models: { 1: 1029 }, latencyMs: 0 });
  const link = new ServoLink({ write: (bytes) => bus.write(bytes), echo: true, timeoutMs: 120 });
  bus.onData = (bytes) => link.feed(bytes);
  const model = await link.request(1, INSTRUCTION.read, [3, 2]);
  assert.deepEqual(Array.from(model.data), [5, 4]);
  const info = modelInfoFromBytes(model.data);
  assert.equal(info.family, "scs");
  await link.request(1, INSTRUCTION.write, [info.motion.start, 0x02, 0xbc, 0x00, 0x00, 0x00, 0x64]);
  const position = await link.request(1, INSTRUCTION.read, [56, 2]);
  assert.equal(wordFromBytes(position.data, "big"), 0x02bc);
});

test("the SCS model has no offset register and uses its own lock", () => {
  const info = modelInfoFromBytes(Uint8Array.from([5, 4]));
  assert.equal(info.offset, null);
  assert.equal(info.lock, 48);
  assert.equal(info.motion.length, 6);
  assert.equal(info.motion.start, 42);
});


test("DataView reads are converted, not silently emptied", () => {
  const view = new DataView(Uint8Array.from([1, 0, 0, 2, 0xbf, 0, 0, 0]).buffer);
  // This is the shape Web Bluetooth returns for a characteristic read; the
  // page used to do `new Uint8Array(view)`, which is empty and read as an
  // unsupported management protocol.
  assert.equal(new Uint8Array(view).length, 0);
  assert.deepEqual(Array.from(toBytes(view)), [1, 0, 0, 2, 0xbf, 0, 0, 0]);
  assert.deepEqual(Array.from(toBytes(new Uint8Array([5, 6]))), [5, 6]);
  assert.deepEqual(Array.from(toBytes(view.buffer)), [1, 0, 0, 2, 0xbf, 0, 0, 0]);
});
