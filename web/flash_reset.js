import { Transport } from "./vendor/esptool-js/bundle.js";

// A stalled driver must not keep the page busy indefinitely. Start close only
// after releasing our reader, so a timeout cannot leave a delayed disconnect
// waiting to close a later session on the same SerialPort.
async function bounded(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("等待串口关闭超时")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// esptool also disconnects internally to change baud after starting its stub.
// Release Web Serial's reader before close on both that path and final cleanup.
export class FlasherTransport extends Transport {
  async disconnect() {
    const opened = this.reader || this.device.readable || this.device.writable;
    if (this.reader) {
      const reader = this.reader;
      try {
        await bounded(reader.cancel(), 400);
      } catch {
        // Unplugging a USB device can error the readable stream.
      } finally {
        reader.releaseLock();
        this.reader = undefined;
      }
    }
    if (opened) await closeResetPort(this.device);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bootStatus(text) {
  const failure = text.match(/invalid header|invalid magic (?:byte|number)|flash read err|no bootable app partitions/i);
  if (failure) throw new Error(`固件启动失败（${failure[0]}）`);
  if (/wait(?:ing)? (?:for |usb )?download|\bboot:\s*0x0+(?=[\s(,])|\bDOWNLOAD\s*\(/i.test(text)) return "download";
  if (/\bBooting Zephyr OS\b/i.test(text)) return "confirmed";
  return "sent";
}

async function readBootStatus(port, timeout) {
  if (!port.readable) return "sent";
  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeout);
  });
  try {
    let text = "";
    while (true) {
      // A native USB reset can disconnect the reader before the first byte.
      const packet = await Promise.race([reader.read().catch(() => null), expired]);
      if (!packet || packet.done) return "sent";
      text += decoder.decode(packet.value, { stream: true });
      const status = bootStatus(text);
      if (status !== "sent") return status;
      text = text.slice(-128);
    }
  } finally {
    clearTimeout(timer);
    try {
      await bounded(reader.cancel(), 400);
    } catch {
      // The USB device may have disconnected.
    } finally {
      reader.releaseLock();
    }
  }
}

// On re-enumeration, try the same selected port again without toggling EN.
export async function observeBoot(port) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(200);
    try {
      await port.open({ baudRate: 115200 });
    } catch {
      continue;
    }
    try {
      return await readBootStatus(port, 1000);
    } finally {
      await closeResetPort(port);
    }
  }
  return "sent";
}

async function closeResetPort(port) {
  try {
    await bounded(port.close(), 1200);
  } catch (error) {
    if (error?.name !== "InvalidStateError" || port.readable || port.writable) throw error;
  }
}

export async function restartBoard(port, nativeUsb) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await port.open({ baudRate: 115200 });
    let status;
    try {
      await port.setSignals({ dataTerminalReady: false });
      await port.setSignals({ requestToSend: true });
      await sleep(120);
      await port.setSignals({ requestToSend: false });
      if (!nativeUsb) return "sent";
      // Read immediately from the same handle so a short ROM banner is retained.
      status = await readBootStatus(port, 1600);
    } finally {
      await closeResetPort(port);
    }
    if (status === "sent") status = await observeBoot(port);
    if (status !== "download") return status;
  }
  throw new Error("设备仍停在下载模式");
}
