"use strict";

/* FEETECH SCS/STS bus-servo protocol for the Bee servo bench.
 *
 * This module is deliberately free of DOM and Web Bluetooth dependencies: the
 * serial pipe is a `write` callback and `feed()` is called with received
 * bytes, so the same code runs against a Bee, the loopback simulator below,
 * and the Node tests in mobile/test/servo_protocol.test.mjs.
 *
 * Two transport facts shape the request path:
 *  - A BLE round trip costs a connection interval, so the default reply window
 *    is 250 ms rather than FTServo's 50 ms.
 *  - With TX and RX tied to the one-wire bus, our own request comes back before
 *    the servo's answer. That echo is a checksum-valid frame, so it is
 *    stripped before parsing; a direction-controlled adapter (no echo) simply
 *    fails the prefix match and its bytes are released unchanged.
 */

export const BROADCAST_ID = 0xfe;
export const MAX_ID = 0xfc;

export const INSTRUCTION = {
  ping: 0x01,
  read: 0x02,
  write: 0x03,
  regWrite: 0x04,
  action: 0x05,
  syncWrite: 0x83,
  syncRead: 0x82,
};

/* Register map for the STS/SMS family (the STS3215 is the common case).  The
 * address and length are what goes on the wire; `decode` turns the raw bytes
 * into the number shown in the table. */
export const REGISTERS = [
  { address: 3, name: "model", length: 2, area: "eeprom", writable: false },
  { address: 5, name: "id", length: 1, area: "eeprom", writable: true },
  { address: 6, name: "baud", length: 1, area: "eeprom", writable: true },
  { address: 9, name: "minAngle", length: 2, area: "eeprom", writable: true },
  { address: 11, name: "maxAngle", length: 2, area: "eeprom", writable: true },
  { address: 26, name: "cwDead", length: 1, area: "eeprom", writable: true },
  { address: 27, name: "ccwDead", length: 1, area: "eeprom", writable: true },
  { address: 31, name: "offset", length: 2, area: "eeprom", writable: true, signed: true, bits: 11 },
  { address: 33, name: "mode", length: 1, area: "eeprom", writable: true },
  { address: 40, name: "torque", length: 1, area: "sram", writable: true },
  { address: 41, name: "acc", length: 1, area: "sram", writable: true },
  { address: 42, name: "goalPosition", length: 2, area: "sram", writable: true },
  { address: 44, name: "goalTime", length: 2, area: "sram", writable: true },
  { address: 46, name: "goalSpeed", length: 2, area: "sram", writable: true },
  { address: 55, name: "lock", length: 1, area: "sram", writable: true },
  { address: 56, name: "position", length: 2, area: "sram", writable: false, signed: true, bits: 15 },
  { address: 58, name: "speed", length: 2, area: "sram", writable: false, signed: true, bits: 15 },
  { address: 60, name: "load", length: 2, area: "sram", writable: false, signed: true, bits: 10 },
  { address: 62, name: "voltage", length: 1, area: "sram", writable: false, scale: 0.1, unit: "V" },
  { address: 63, name: "temperature", length: 1, area: "sram", writable: false, unit: "°C" },
  { address: 66, name: "moving", length: 1, area: "sram", writable: false },
  { address: 69, name: "current", length: 2, area: "sram", writable: false, scale: 6.5, unit: "mA" },
];

export const MODEL_NAMES = {
  777: "STS3215",
};

/* Registers the servo UI reads for its telemetry, in one place so the page and
 * the tests agree on what a status refresh costs. */
export const TELEMETRY_WORDS = [
  { key: "position", address: 56, length: 2, signed: true, bits: 15 },
  { key: "speed", address: 58, length: 2, signed: true, bits: 15 },
  { key: "load", address: 60, length: 2, signed: true, bits: 10 },
  { key: "voltage", address: 62, length: 1, scale: 0.1 },
  { key: "temperature", address: 63, length: 1 },
  { key: "current", address: 69, length: 2, scale: 6.5 },
];

export function checksum(bytes) {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xff;
  return ~sum & 0xff;
}

export function encodeFrame(id, instruction, params = []) {
  const body = [id, params.length + 2, instruction, ...params];
  return Uint8Array.from([0xff, 0xff, ...body, checksum(body)]);
}

export function frameChecksumValid(frame) {
  return frame[frame.length - 1] === checksum(frame.slice(2, -1));
}

/* Split a byte stream into status frames.  A partial trailing frame is ignored
 * (it stays in the caller's buffer) and a bad byte is skipped, which also
 * resynchronises after line noise. */
export function parseStatusFrames(bytes, maxFrame = 260) {
  const frames = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || bytes[offset + 1] !== 0xff) {
      offset += 1;
      continue;
    }
    const length = bytes[offset + 3];
    const total = length + 4;
    if (length < 2 || total > maxFrame) {
      offset += 2;
      continue;
    }
    if (offset + total > bytes.length) break;
    const frame = bytes.slice(offset, offset + total);
    if (frameChecksumValid(frame)) {
      frames.push({
        id: frame[2],
        error: frame[4],
        data: frame.slice(5, total - 1),
        raw: frame,
      });
    }
    offset += total;
  }
  return { frames, rest: bytes.slice(offset) };
}

export function decodeWord(data) {
  return data.length >= 2 ? data[0] | (data[1] << 8) : data[0] || 0;
}

export function toHostWord(value, bits) {
  const word = value & ((1 << (bits + 1)) - 1);
  return word & (1 << bits) ? -(word & ~(1 << bits)) : word;
}

export function toServoWord(value, bits) {
  if (value < 0) return -value | (1 << bits);
  return value;
}

export function decodeRegister(register, data) {
  const raw = register.length === 1 ? (data[0] || 0) : decodeWord(data);
  if (register.signed) {
    return toHostWord(raw, register.bits || 15);
  }
  if (register.scale) {
    return Math.round(raw * register.scale * 10) / 10;
  }
  return raw;
}

export function encodeRegister(register, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("not a number");
  let raw = Math.round(number / (register.scale || 1));
  if (register.signed) raw = toServoWord(raw, register.bits || 15);
  if (register.length === 1) return [raw & 0xff];
  return [raw & 0xff, (raw >> 8) & 0xff];
}

export function parseIdRange(text) {
  const ids = [];
  for (const part of String(text).split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const low = Number(range[1]);
      const high = Number(range[2]);
      for (let id = low; id <= high; id += 1) ids.push(id);
    } else if (/^\d+$/.test(piece)) {
      ids.push(Number(piece));
    }
  }
  return [...new Set(ids)].filter((id) => id >= 0 && id <= MAX_ID);
}

/* A request/response session over one byte pipe. */
export class ServoLink {
  constructor({ write, echo = true, timeoutMs = 250 } = {}) {
    this.write = write || (async () => {});
    this.echo = echo;
    this.timeoutMs = timeoutMs;
    this.rx = new Uint8Array(0);
    this.echoExpected = null;
    this.echoSeen = 0;
    this.waiter = null;
    this.chain = Promise.resolve();
    this.closed = false;
  }

  clear() {
    this.rx = new Uint8Array(0);
    this.echoExpected = null;
    this.echoSeen = 0;
  }

  /* Serialize requests: the bus is half duplex, so two in flight would make the
   * echo and the answers indistinguishable. */
  request(id, instruction, params = [], { timeoutMs } = {}) {
    const run = () => this.#exchange(id, instruction, params, timeoutMs);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  /* Fire-and-forget packet (broadcast sync write, action). The echo is still
   * stripped so the next request starts on a clean stream. */
  send(id, instruction, params = []) {
    const run = async () => {
      if (this.closed) throw new Error("link closed");
      const frame = encodeFrame(id, instruction, params);
      this.rx = new Uint8Array(0);
      this.echoExpected = this.echo ? frame : null;
      this.echoSeen = 0;
      await this.write(frame);
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async #exchange(id, instruction, params, timeoutMs) {
    if (this.closed) throw new Error("link closed");
    const frame = encodeFrame(id, instruction, params);
    this.rx = new Uint8Array(0);
    this.echoExpected = this.echo ? frame : null;
    this.echoSeen = 0;
    const wait = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter && this.waiter.resolve === resolve) this.waiter = null;
        resolve(null);
      }, timeoutMs ?? this.timeoutMs);
      this.waiter = {
        id,
        resolve: (value) => {
          clearTimeout(timer);
          if (this.waiter && this.waiter.resolve === resolve) this.waiter = null;
          resolve(value);
        },
      };
    });
    try {
      await this.write(frame);
    } catch (error) {
      this.waiter = null;
      throw error;
    }
    return wait;
  }

  feed(chunk) {
    if (this.closed) return;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const data = this.#stripEcho(bytes);
    if (data.length === 0) return;
    this.rx = concat(this.rx, data);
    const { frames, rest } = parseStatusFrames(this.rx);
    this.rx = rest;
    for (const frame of frames) {
      const waiter = this.waiter;
      if (waiter && waiter.id === frame.id) {
        waitersResolve(waiter, frame);
      }
    }
  }

  #stripEcho(chunk) {
    if (!this.echoExpected) return chunk;
    const out = [];
    for (let index = 0; index < chunk.length; index += 1) {
      const expected = this.echoExpected;
      if (!expected) {
        out.push(chunk[index]);
        continue;
      }
      if (chunk[index] === expected[this.echoSeen]) {
        this.echoSeen += 1;
        if (this.echoSeen === expected.length) {
          this.echoExpected = null;
          this.echoSeen = 0;
        }
      } else {
        // Not our echo: release what we held and treat the rest as data.
        for (let held = 0; held < this.echoSeen; held += 1) out.push(expected[held]);
        this.echoExpected = null;
        this.echoSeen = 0;
        out.push(chunk[index]);
      }
    }
    return Uint8Array.from(out);
  }
}

function waitersResolve(waiter, frame) {
  waiter.resolve(frame);
}

function concat(left, right) {
  if (left.length === 0) return right;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

/* --- Simulator ------------------------------------------------------------ */

const DEFAULT_BAUD_TABLE = [
  1000000, 500000, 250000, 128000, 115200, 76800, 57600, 38400,
];

export class SimulatedBus {
  constructor({ ids = [1, 2, 3], echo = true, latencyMs = 4 } = {}) {
    this.echo = echo;
    this.latencyMs = latencyMs;
    this.servos = new Map();
    this.partial = new Uint8Array(0);
    this.onData = null;
    this.timer = null;
    for (const id of ids) this.servos.set(id, makeServo(id));
  }

  write(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const frames = [];
    if (this.echo) frames.push(data);
    this.partial = concat(this.partial, data);
    const parsed = this.#drainInstructions();
    frames.push(...parsed);
    if (this.onData) {
      const deliver = () => {
        for (const frame of frames) this.onData(frame);
      };
      if (this.latencyMs > 0) setTimeout(deliver, this.latencyMs);
      else deliver();
    }
    return Promise.resolve();
  }

  #drainInstructions() {
    const responses = [];
    while (this.partial.length >= 4) {
      if (this.partial[0] !== 0xff || this.partial[1] !== 0xff) {
        this.partial = this.partial.slice(1);
        continue;
      }
      const length = this.partial[3];
      const total = length + 4;
      if (this.partial.length < total) break;
      const frame = this.partial.slice(0, total);
      this.partial = this.partial.slice(total);
      if (frameChecksumValid(frame)) responses.push(...this.#dispatch(frame));
    }
    return responses;
  }

  #dispatch(frame) {
    const id = frame[2];
    const instruction = frame[4];
    const params = Array.from(frame.slice(5, -1));
    const servo = this.servos.get(id);
    if (instruction === INSTRUCTION.syncWrite) {
      const address = params[0];
      const length = params[1];
      for (let offset = 2; offset + 1 + length <= params.length; offset += 1 + length) {
        const target = this.servos.get(params[offset]);
        if (target) writeRegister(target, address, params.slice(offset + 1, offset + 1 + length));
      }
      return [];
    }
    if (!servo) return [];
    if (instruction === INSTRUCTION.ping) return [statusFrame(id, 0, [])];
    if (instruction === INSTRUCTION.read) {
      const address = params[0];
      const length = params[1];
      return [statusFrame(id, 0, readRegister(servo, address, length))];
    }
    if (instruction === INSTRUCTION.write) {
      writeRegister(servo, params[0], params.slice(1));
      return id === BROADCAST_ID ? [] : [statusFrame(id, 0, [])];
    }
    if (instruction === INSTRUCTION.regWrite || instruction === INSTRUCTION.action) {
      return [statusFrame(id, 0, [])];
    }
    return [];
  }
}

function makeServo(id) {
  const regs = new Uint8Array(256);
  regs[3] = 777 & 0xff;
  regs[4] = 777 >> 8;
  regs[5] = id;
  setWord(regs, 9, 0);
  setWord(regs, 11, 4095);
  setWord(regs, 42, 2048);
  setWord(regs, 56, 2048);
  regs[62] = 120;
  regs[63] = 33;
  return { id, regs };
}

function setWord(regs, address, value) {
  regs[address] = value & 0xff;
  regs[address + 1] = (value >> 8) & 0xff;
}

function getWord(regs, address) {
  return regs[address] | (regs[address + 1] << 8);
}

function readRegister(servo, address, length) {
  return Array.from(servo.regs.slice(address, address + length));
}

function writeRegister(servo, address, values) {
  const { regs } = servo;
  for (let index = 0; index < values.length; index += 1) {
    if (address + index < regs.length) regs[address + index] = values[index];
  }
  if (address <= 43 && address + values.length > 42) {
    setWord(regs, 56, getWord(regs, 42));
    regs[66] = 1;
  }
  if (address <= 40 && address + values.length > 40) {
    regs[66] = 0;
  }
}

function statusFrame(id, error, data) {
  const body = [id, data.length + 2, error, ...data];
  return Uint8Array.from([0xff, 0xff, ...body, checksum(body)]);
}

export const SIM_BAUD_TABLE = DEFAULT_BAUD_TABLE;
