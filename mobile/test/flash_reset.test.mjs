import test from "node:test";
import assert from "node:assert/strict";
import { FlasherTransport, restartBoard, observeBoot } from "../../web/flash_reset.js";

class SerialPort {
  constructor(...sessions) {
    this.sessions = sessions;
    this.pulses = 0;
  }
  async open() {
    assert.ok(!this.readable, "cannot reopen a busy port");
    const chunks = this.sessions.shift();
    if (chunks instanceof Error) throw chunks;
    this.readable = new ReadableStream({
      start(controller) {
        for (const text of chunks || []) controller.enqueue(new TextEncoder().encode(text));
        if (chunks) controller.close();
      },
    });
    this.writable = new WritableStream();
  }
  async close() {
    assert.equal(this.readable.locked, false);
    assert.equal(this.writable.locked, false);
    this.readable = this.writable = null;
  }
  async setSignals({ requestToSend }) {
    if (requestToSend === false) this.pulses++;
  }
}

test("a loader session and an EN pulse leave a USB-UART port reusable", async () => {
  const port = new SerialPort();
  const transport = new FlasherTransport(port);
  await transport.connect();
  const pending = transport.reader.read();
  await transport.disconnect();
  await transport.connect(460800);
  await transport.disconnect();
  assert.equal((await pending).done, true);
  assert.equal(await restartBoard(port, false), "sent");
  await port.open();
  await port.close();
  assert.equal(port.pulses, 1);
});

test("ROM output and a silent timeout never confirm boot or issue a second EN pulse", async () => {
  const port = new SerialPort(["ESP-ROM:esp32c3\r\nboot:0x0", "f (SPI_FAST_FLASH_BOOT)\r\n"]);
  assert.equal(await restartBoard(port, true), "sent");
  assert.equal(port.pulses, 1);
  await port.open();
  await port.close();
});

test("retry a known download boot, then confirm a split Zephyr banner", async () => {
  const port = new SerialPort(["boot:0x5 (DOWNLOAD(USB/UART0))"], ["*** Booting Ze", "phyr OS build v4.5"]);
  assert.equal(await restartBoard(port, true), "confirmed");
  assert.equal(port.pulses, 2);
});

test("report persistent download mode after the final observed attempt", async () => {
  const port = new SerialPort(...Array.from({ length: 3 }, () => ["wait usb download\r\n"]));
  await assert.rejects(restartBoard(port, true), /下载模式/);
  assert.equal(port.pulses, 3);
});

test("watchdog observation retries opening the selected port and surfaces ROM errors", async () => {
  const port = new SerialPort(new Error("re-enumerating"), ["invalid hea", "der: 0xffffffff"]);
  await assert.rejects(observeBoot(port), /invalid header/);
  assert.equal(port.pulses, 0);
  await port.open();
  await port.close();
});
