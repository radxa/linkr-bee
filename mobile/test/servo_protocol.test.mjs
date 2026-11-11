import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTRUCTION,
  REGISTERS,
  ServoLink,
  SimulatedBus,
  checksum,
  decodeRegister,
  encodeFrame,
  encodeRegister,
  frameChecksumValid,
  parseIdRange,
  parseStatusFrames,
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
