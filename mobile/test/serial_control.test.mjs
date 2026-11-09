import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSerialControl, isReadonlyManagementCommand, agentLedAction } from "../../web/serial_control.js";

test("control status is validated against its owner identity", () => {
  const status = "OK control self=2 owner=1 mode=readonly epoch=3 peers=2 ble_max=2 linkr_reserved=0\r\n";
  assert.deepEqual(parseSerialControl(status), { self: 2, owner: 1, mode: "readonly", epoch: 3, peers: 2, capacity: 2 });
  for (const text of [status.replace("mode=readonly", "mode=control"), status.replace("owner=1", "owner=nan"),
    status.replace("self=2", "self=0"), status.replace("epoch=3", "epoch=-1"), "ERR control=busy"]) {
    assert.equal(parseSerialControl(text), null);
  }
  assert.equal(parseSerialControl(status.replace("owner=1 mode=readonly", "owner=0 mode=available")).mode, "available");
});

test("readonly clients can query and negotiate but cannot mutate device settings", () => {
  for (const command of ["@c?", "@c claim", "@c claim idle", "@c release", "@c yield 2", "@i?", "@u?", "@linkr target?",
    "@l?", "@o?", "@r?", "@r slots", "@linkr led?", "@linkr ir?",
    "@p?", "@p get 0", "@p get 3 96", "@p active", "@linkr prompt?",
    "@linkr prompt get 1 0", "@linkr prompt active",
    "@y?", "@y get 0", "@y get 48", "@linkr aiconf?", "@linkr aiconf get 0"]) {
    assert.equal(isReadonlyManagementCommand(command), true, command);
  }
  for (const command of ["@u=115200,8,n,1,n", "@w=ssid,pass", "@s?", "@s token off", "@linkr target clear", "@c yield 0",
    "@l=1,2,3", "@l off", "@o on", "@o pulse 500", "@r learn", "@r play 0", "@r delete 0",
    "@r tx 0x0004,0x08", "@r rx on", "@r clear",
    "@p set 0 6869", "@p clear 0", "@p active 1", "@linkr prompt set 0 6869",
    "@y begin", "@y put 7b7d", "@y end", "@y clear", "@linkr aiconf begin"]) {
    assert.equal(isReadonlyManagementCommand(command), false, command);
  }
});


test("board prompt reads with implicit and explicit offsets are read-only", () => {
  for (const command of ["@p get", "@p get 0", "@p get 48", "@linkr prompt get", "@linkr prompt get 48"]) {
    assert.equal(isReadonlyManagementCommand(command), true, command);
  }
  for (const command of ["@p set 6162", "@p clear", "@p get -1", "@p get 0 clear"]) {
    assert.equal(isReadonlyManagementCommand(command), false, command);
  }
});

test("AI LED notifications require firmware support and current ownership", () => {
  const line = "OK control self=1 owner=1 mode=control epoch=7 peers=1 ble_max=2 linkr_reserved=0";
  const old = parseSerialControl(line);
  assert.equal(agentLedAction(old, true), "?");
  const control = parseSerialControl(line + " agent_led=1");
  assert.equal(agentLedAction(control, true), "ai on 7");
  assert.equal(agentLedAction(control, false), "ai off 7");
  assert.equal(agentLedAction({...control, mode:"readonly"}, true), "?");
  assert.equal(agentLedAction(null, true), "?");
  assert.equal(agentLedAction(parseSerialControl(line + " agent_led=0"), true), "?");
  for (const command of ["@c ai on 7", "@c ai off 7"]) {
    assert.equal(isReadonlyManagementCommand(command), false);
  }
});
