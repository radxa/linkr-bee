"use strict";

export const MGMT_CAP_MULTI_SESSION = 1 << 7;

export function parseSerialControl(text) {
  const line = String(text).trim();
  if (!line.startsWith("OK control ")) return null;
  const fields = Object.fromEntries(line.slice(11).split(/\s+/).map(part => part.split("=")));
  const result = {
    self: Number(fields.self), owner: Number(fields.owner), mode: fields.mode,
    epoch: Number(fields.epoch), peers: Number(fields.peers), capacity: Number(fields.ble_max),
  };
  if (![result.self, result.owner, result.epoch, result.peers, result.capacity]
    .every(value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff)) return null;
  if (!result.self || !result.epoch || !result.peers || !result.capacity) return null;
  const expected = result.owner === result.self ? "control" : result.owner ? "readonly" : "available";
  return result.mode === expected ? result : null;
}

// Commands permitted without console ownership, including caller-only labels.
export function isReadonlyManagementCommand(command) {
  if (/^@linkr bonds name(?: [^\r\n]+)?$/.test(command)) return true;
  return /^@(?:c\?|c (?:claim|claim idle|release|yield [1-9]\d*)|h|i\?|u\?|n\?|a\?|w\?|l\?|o\?|r\?|r slots|p\?|p get(?: \d+(?: \d+)?)?|p active|y\?|y get \d+)$/.test(command) ||
    /^@linkr (?:control\?|control (?:claim|claim idle|release|yield [1-9]\d*)|help|info\?|uart\?|name\?|autobaud\?|wifi\?|bonds\?|bonds names\?|bonds label [01]\/[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}|target\?|led\?|opto\?|ir\?|ir slots|prompt\?|prompt get(?: \d+(?: \d+)?)?|prompt active|aiconf\?|aiconf get \d+)$/.test(command);
}
