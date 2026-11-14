import { ESPLoader, Transport } from "./vendor/esptool-js/bundle.js";

const DEFAULT_REPO = "radxa/linkr-bee";
const BOARD_NAMES = {
  "esp32-wroom-32": "ESP32-WROOM-32 DevKitC",
  "esp32c3-devkitc": "ESP32-C3 DevKitC",
  "linkr-bee-x1-0": "Linkr Bee X1.0 (MV013)",
  "esp32c3-devkitm": "ESP32-C3 DevKitM",
  "esp32c3-supermini": "ESP32-C3 Super Mini",
  "esp32c5-devkitc": "ESP32-C5 DevKitC",
};

const $ = (id) => document.getElementById(id);
const boardSelect = $("boardSelect");
const baudSelect = $("baudSelect");
const retryButton = $("retryButton");
const camPrep = $("camPrep");
const portSelect = $("portSelect");
const pickPortButton = $("pickPortButton");
const refreshPortsButton = $("refreshPortsButton");
const portHint = $("portHint");
const connectButton = $("connectButton");
const downloadButton = $("downloadButton");
const resetButton = $("resetButton");
const watchdogButton = $("watchdogButton");
const statusLine = $("status");
const progressBar = $("progressBar");
const progressTrack = progressBar.parentElement;
const logView = $("log");

const state = {
  manifest: null,
  board: null,
  port: null,
  ports: [],
  transport: null,
  loader: null,
  image: null,
  flashing: false,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USB_SERIAL_NAMES = {
  "0403": "FTDI",
  "10c4": "CP210x",
  "1a86": "CH340/CH341",
  "303a": "Espressif USB Serial/JTAG",
  "2341": "Arduino",
};

function portInfo(port) {
  const info = port?.getInfo?.() || {};
  const vid = info.usbVendorId?.toString(16).padStart(4, "0");
  const pid = info.usbProductId?.toString(16).padStart(4, "0");
  const name = vid ? USB_SERIAL_NAMES[vid] || "USB 串口" : "串口";
  return {
    vid: vid ? vid.toUpperCase() : "",
    pid: pid ? pid.toUpperCase() : "",
    name,
  };
}

function portLabel(port, index) {
  const { vid, pid, name } = portInfo(port);
  const ids = vid ? ` · ${vid}:${pid || "????"}` : "";
  return `串口 ${index + 1} · ${name}${ids}`;
}

function setPortHint(text, isError = false) {
  portHint.textContent = text;
  portHint.classList.toggle("error", isError);
}

function rebuildPortSelect(preferred) {
  const selected = preferred || state.port;
  portSelect.replaceChildren();
  if (!state.ports.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "尚未选择串口";
    portSelect.append(option);
    portSelect.value = "";
    return;
  }
  state.ports.forEach((port, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = portLabel(port, index);
    portSelect.append(option);
  });
  let index = state.ports.indexOf(selected);
  if (index < 0) index = 0;
  portSelect.value = String(index);
}

// Granted ports survive a reload. Ask for one only when the list is empty or
// the user explicitly picks another device.
async function refreshPorts({ request = false } = {}) {
  if (!navigator.serial) return;
  try {
    if (request) {
      const picked = await navigator.serial.requestPort();
      await releaseConnection();
      state.port = picked;
    }
    state.ports = await navigator.serial.getPorts();
    if (state.port && !state.ports.includes(state.port)) {
      state.ports.push(state.port);
    }
    if (!state.port && state.ports.length) state.port = state.ports[0];
    rebuildPortSelect(state.port);
    if (state.port) {
      const { vid, pid, name } = portInfo(state.port);
      setPortHint(
        `已选择 ${name}${vid ? `（VID ${vid} / PID ${pid}）` : ""}。` +
          `如果打开失败，请关闭 Arduino IDE、minicom、ModemManager 或占用该串口的其他页面。`,
      );
    } else {
      setPortHint("点击“选择串口”，在浏览器弹窗里选中开发板的 USB 串口。");
    }
  } catch (error) {
    if (error?.name !== "NotFoundError") {
      setPortHint(`读取串口失败：${error?.message || error}`, true);
    }
  }
  updateResetAvailability();
}

function serialErrorHint(message) {
  if (/failed to open|access denied|busy|resource busy|in use/i.test(message)) {
    return (
      "无法打开串口。请确认：1) 没有其他程序占用（Arduino IDE、minicom、ModemManager、另一个浏览器标签）；" +
      "2) Linux 下当前用户在 dialout 组；3) 不使用 Snap/Flatpak 版浏览器；4) 换一根能传数据的 USB 线。"
    );
  }
  return "";
}

// esptool-js' disconnect waits for the reader lock without a timeout. A failed
// handshake can leave the read loop pending, which used to freeze the page
// until reload. Bound every cleanup step and always release the OS port.
async function releaseConnection() {
  const transport = state.transport;
  const port = state.port;
  state.transport = null;
  state.loader = null;
  if (transport?.reader) {
    try {
      await Promise.race([transport.reader.cancel(), sleep(400)]);
    } catch {
      // Already cancelled.
    }
  }
  if (transport) {
    try {
      await Promise.race([transport.disconnect(), sleep(1200)]);
    } catch {
      // Already closed.
    }
  }
  try {
    await Promise.race([port?.close?.(), sleep(600)]);
  } catch {
    // The port was not open or is already closed.
  }
}

// The flasher is deployed from the fork's Pages site while the PR is open and
// from origin after the merge. Prefer the repository the manifest was built
// from; on a github.io site the owner/repository are in the URL; every other
// host (including localhost) uses the upstream project.
function detectRepo() {
  const meta = document.querySelector('meta[name="linkr-repo"]')?.content?.trim();
  if (meta) return meta;
  const pages = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (pages) {
    const repository = location.pathname.split("/").filter(Boolean)[0];
    if (repository) return `${pages[1]}/${repository}`;
  }
  return DEFAULT_REPO;
}

function repo() {
  return state.manifest?.repo || detectRepo();
}

function logLine(text) {
  logView.textContent += `${text}\n`;
  logView.scrollTop = logView.scrollHeight;
}

function setStatus(text, kind = "") {
  statusLine.textContent = text;
  statusLine.className = `status ${kind}`;
}

function setProgress(fraction) {
  const value = Math.max(0, Math.min(1, fraction));
  progressBar.style.width = `${value * 100}%`;
  progressTrack.classList.toggle("active", value > 0);
}

function updateResetAvailability() {
  resetButton.disabled = state.flashing || !navigator.serial || !state.port;
  // The watchdog reset writes ESP32-C3 RTC registers through the stub, so it
  // only makes sense on the X1.0's own USB port. Other boards keep the plain
  // EN restart above. The X1.0 entry still shows the button before a port is
  // picked, disabled, so the fallback is discoverable instead of appearing
  // only after the reset it is meant to rescue has failed.
  const onX1 = state.board?.slug === "linkr-bee-x1-0";
  const offered = onX1 && !!navigator.serial;
  const nativeUsb = onX1 && isNativeUsb();
  watchdogButton.hidden = !offered;
  watchdogButton.disabled = !offered || !nativeUsb || state.flashing || !state.port;
  watchdogButton.title = !offered
    ? ""
    : !state.port
      ? "先选择 X1.0 的原生 USB 串口（VID 303A / PID 1001）"
      : !nativeUsb
        ? "看门狗重启需要 X1.0 的原生 USB 串口（VID 303A / PID 1001）"
        : "通过 ESP32-C3 的 RTC 看门狗复位，不依赖 EN 引脚";
}

// Chips that expose their own USB Serial/JTAG peripheral (ESP32-C3/S3/C6/P4)
// rather than a separate USB-UART bridge. They need the extra reset edge below.
function isNativeUsb(port = state.port) {
  const { vid, pid } = portInfo(port);
  return vid === "303A" && pid === "1001";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function shortHash(hash) {
  if (!hash) return "—";
  return `${hash.slice(0, 16)}…`;
}

function boardLabel(slug, fallback) {
  return BOARD_NAMES[slug] || fallback || slug;
}

function releaseAssetUrl(board) {
  const tag = state.manifest?.tag || `v${state.manifest?.version}`;
  return `https://github.com/${repo()}/releases/download/${tag}/linkr-bee-${tag}-firmware-${board.slug}.zip`;
}

async function loadManifest() {
  try {
    const response = await fetch(`./firmware/manifest.json?cb=${Date.now()}`, {
      cache: "no-store",
    });
    if (response.ok) {
      const manifest = await response.json();
      manifest.source = "pages";
      return manifest;
    }
  } catch {
    // Local development, or a deployment made before the first release.
  }
  return loadLatestRelease();
}

async function loadLatestRelease() {
  const repository = repo();
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub Releases 返回 ${response.status}`);
  }
  const release = await response.json();
  const boards = release.assets
    .filter((asset) => /^linkr-bee-.+-firmware-(.+)\.zip$/.test(asset.name))
    .map((asset) => {
      const slug = asset.name.replace(/^linkr-bee-.+-firmware-(.+)\.zip$/, "$1");
      return {
        slug,
        name: boardLabel(slug),
        chip: "",
        flash_address: "",
        image: "",
        size: asset.size,
        version: release.tag_name.replace(/^v/, ""),
        zip_url: asset.browser_download_url,
        image_url: "",
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (!boards.length) {
    throw new Error("最新发布里没有固件 ZIP");
  }
  return {
    schema: 1,
    version: release.tag_name.replace(/^v/, ""),
    tag: release.tag_name,
    generated_at: release.published_at,
    source: "api",
    repo: repository,
    boards,
  };
}

function parseChip(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function selectBoard(slug) {
  const board = state.manifest.boards.find((item) => item.slug === slug);
  state.board = board || null;
  state.loader = null;
  state.image = null;
  $("factChip").textContent = board?.chip || "读取中…";
  $("factAddress").textContent = board?.flash_address || "读取中…";
  $("factSize").textContent = board ? formatBytes(board.size) : "—";
  $("factHash").textContent = board ? shortHash(board.sha256) : "—";
  $("factHash").title = board?.sha256 || "";
  connectButton.disabled = !board;
  downloadButton.disabled = !board;
  camPrep.hidden = true;
  setProgress(0);
  if (board) setStatus(`已选择 ${board.name}。点击“连接串口并烧录”开始。`);
  updateResetAvailability();
}

function populateBoards(manifest) {
  state.manifest = manifest;
  boardSelect.replaceChildren();
  for (const board of manifest.boards) {
    const option = document.createElement("option");
    option.value = board.slug;
    option.textContent = board.name || boardLabel(board.slug);
    boardSelect.append(option);
  }
  boardSelect.disabled = false;
  const releasePill = $("releasePill");
  releasePill.classList.toggle("stale", manifest.source === "api");
  releasePill.textContent =
    manifest.source === "api"
      ? `最新发布 v${manifest.version}（在线）`
      : `最新编译固件 v${manifest.version}`;
  releasePill.title = manifest.generated_at
    ? `staged ${manifest.generated_at}`
    : "";
  $("heroVersion").textContent = `v${manifest.version}`;
  $("heroBoards").textContent = `${manifest.boards.length} 款`;
  $("releaseVersion").textContent = `v${manifest.version}`;
  $("releaseTag").textContent = manifest.tag || "—";
  $("releaseRepo").textContent = repo();
  const link = $("releaseLink");
  if (manifest.tag) {
    link.href = `https://github.com/${repo()}/releases/tag/${manifest.tag}`;
  }
  selectBoard(manifest.boards[0].slug);
}

async function fetchBytes(url, label, expectedSize = 0) {
  logLine(`下载 ${label} …`);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || expectedSize || 0;
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    setProgress(1);
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let read = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    read += value.length;
    if (total) setProgress(read / total);
  }
  const image = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    image.set(chunk, offset);
    offset += chunk.length;
  }
  setProgress(1);
  logLine(`下载完成：${formatBytes(read)}`);
  return image;
}

async function ensureImage(board) {
  if (state.image) return state.image;
  if (board.image_url) {
    state.image = await fetchBytes(board.image_url, board.image || board.slug, board.size);
    return state.image;
  }

  const zipUrl = board.zip_url || releaseAssetUrl(board);
  const zip = await fetchBytes(zipUrl, `${board.slug}.zip`, board.size);
  logLine("解压固件包 …");
  const archive = await JSZip.loadAsync(zip);
  const metadataEntry = Object.keys(archive.files).find((name) => name.endsWith("firmware.json"));
  if (!metadataEntry) throw new Error("固件包里没有 firmware.json");
  const metadata = JSON.parse(await archive.file(metadataEntry).async("string"));
  const imageName = String(metadata.image || "").split("/").pop();
  const imageEntry = Object.keys(archive.files).find((name) => name.endsWith(`/${imageName}`));
  if (!imageEntry) throw new Error(`固件包里没有 ${imageName}`);
  const image = await archive.file(imageEntry).async("uint8array");

  board.chip = metadata.chip || board.chip;
  board.flash_address = metadata.flash_address || board.flash_address;
  board.image = imageName;
  board.size = image.length;
  board.sha256 = "";
  state.image = image;
  $("factChip").textContent = board.chip || "—";
  $("factAddress").textContent = board.flash_address || "—";
  $("factSize").textContent = formatBytes(image.length);
  $("factHash").textContent = "在线 ZIP";
  $("factHash").title = "";
  return image;
}

// esptool-js 0.5.x takes a binary string, not a Uint8Array (newer releases
// accept the typed array). Build it in slices so a ~1 MiB image does not
// overflow String.fromCharCode's argument limit.
function toBinaryString(bytes) {
  let text = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return text;
}

function terminal() {
  return {
    clean() {
      logView.textContent = "";
    },
    writeLine(text) {
      logLine(text);
    },
    write(text) {
      logView.textContent += text;
      logView.scrollTop = logView.scrollHeight;
    },
  };
}

async function flash({ noReset = false } = {}) {
  if (!state.board) return;
  state.flashing = true;
  connectButton.disabled = true;
  retryButton.hidden = true;
  resetButton.disabled = true;
  watchdogButton.disabled = true;
  portSelect.disabled = true;
  pickPortButton.disabled = true;
  refreshPortsButton.disabled = true;
  setProgress(0);
  setStatus("正在准备固件…");
  try {
    if (!navigator.serial) {
      throw new Error("当前浏览器不支持 Web Serial");
    }
    // requestPort() needs the click's transient user activation. Ask for the
    // port before downloading the image; a slow 5 MB fetch can consume the
    // activation window and make the chooser fail with a SecurityError.
    if (!state.port) {
      setStatus("请选择开发板串口…");
      await refreshPorts({ request: true });
    }
    if (!state.port) {
      throw new Error("尚未选择串口");
    }
    {
      const { vid, pid, name } = portInfo(state.port);
      logLine(
        `串口：${name}${vid ? `（VID ${vid} / PID ${pid}）` : ""}` +
          ` · 板型：${state.board.slug} · 固件：${state.manifest?.tag || state.manifest?.version || "?"}` +
          ` · 来源：${state.manifest?.source || "?"}`,
      );
    }
    setStatus("正在准备固件…");
    const image = await ensureImage(state.board);

    // A previous attempt can leave the Web Serial port open (or its reader
    // lock pending). Bounded cleanup lets the user retry without reloading.
    await releaseConnection();
    state.transport = new Transport(state.port, false);

    setStatus(noReset ? "正在连接（跳过自动复位）…" : "正在连接引导程序…");
    const loader = new ESPLoader({
      transport: state.transport,
      baudrate: Number(baudSelect.value),
      terminal: terminal(),
      debugLogging: false,
    });
    state.loader = loader;
    const chip = await loader.main(noReset ? "no_reset" : "default_reset");
    logLine(`检测到芯片：${chip}`);

    const expected = parseChip(state.board.chip);
    if (expected && !parseChip(chip).includes(expected)) {
      throw new Error(`板型不匹配：选择的是 ${state.board.name}（${state.board.chip}），实际是 ${chip}`);
    }

    const address = Number.parseInt(state.board.flash_address || "0x0", 16);
    if (!Number.isFinite(address)) {
      throw new Error(`无效的烧录地址：${state.board.flash_address}`);
    }

    setStatus("正在写入固件，请勿断开 USB…");
    logLine(`写入 ${state.board.image || "firmware"} 到 0x${address.toString(16)} …`);
    await loader.writeFlash({
      fileArray: [{ data: toBinaryString(image), address }],
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex, written, total) => {
        setProgress(total ? written / total : 0);
        if (total) {
          setStatus(`正在写入固件… ${Math.round((written / total) * 100)}%`);
        }
      },
    });

    setStatus("正在重启开发板…");
    logLine("正在重启开发板…");
    // The write already succeeded. A restart that cannot get the port back
    // (USB re-enumeration, a cable pulled at the wrong moment) is not a failed
    // flash, and saying so would invite the user to erase and write again.
    // `sent` is the honest middle: the edge went out but no boot was read back.
    let restart = "confirmed";
    try {
      restart = await restartBoard();
    } catch (error) {
      restart = "failed";
      logLine(`自动重启失败：${error?.message || error}`);
    }
    // The board is booting; hand the port back so the terminal can open it.
    await releaseConnection();
    setProgress(1);
    resetButton.disabled = false;
    if (restart === "confirmed") {
      setStatus("烧录完成。设备已重启，可以打开终端连接。", "ok");
      logLine("烧录完成，设备已重启。");
    } else if (restart === "sent") {
      setStatus("烧录完成，已发送重启命令；如果设备没有启动，请点“重启设备”。");
      logLine("烧录完成，已发送重启命令（未读回启动信息）。");
    } else {
      setStatus("烧录完成，但自动重启失败；请点“重启设备”后再打开终端。");
      logLine("烧录完成；自动重启失败，请点“重启设备”。");
    }
  } catch (error) {
    console.error(error);
    let message = String(error?.message || error).replace(/[。.\s]+$/, "");
    const openHint = serialErrorHint(message);
    if (openHint) {
      message = `${message}。${openHint}`;
    } else if (/fail|connect|timeout|sync|boot|serial/i.test(message)) {
      retryButton.hidden = false;
      if (state.board?.slug === "esp32-cam") {
        message +=
          "。请确认 GPIO0 已接 GND，断开再重新上电，然后点“已进入下载模式，重试连接”。";
      } else {
        message +=
          "。如果开发板没有自动复位，请按住 BOOT/IO0，再点一下 RST，然后点“已进入下载模式，重试连接”。";
      }
    }
    setStatus(`烧录失败：${message}`, "error");
    logLine(`错误：${message}`);
    // Release the failed session without waiting on a stuck reader lock.
    await releaseConnection();
    resetButton.disabled = true;
  } finally {
    state.flashing = false;
    connectButton.disabled = !state.board;
    portSelect.disabled = false;
    pickPortButton.disabled = !navigator.serial;
    refreshPortsButton.disabled = !navigator.serial;
    updateResetAvailability();
  }
}

// esptool-js' `after("hard_reset")` only drops RTS. When the line is already
// idle that is no edge at all, so the chip keeps running the flasher stub: the
// WROOM-32 shows only its power LED, and the X1.0 stays in USB download mode
// with no console and no BLE. Pulse EN ourselves and leave IO0/BOOT high, so
// the release starts the firmware instead of the ROM loader.
async function pulseEn(transport, { hold = 120, settle = 300 } = {}) {
  await transport.setDTR(false); // IO0/BOOT high: boot the firmware, not the loader
  await transport.setRTS(true); // EN low: hold the chip in reset
  await sleep(hold);
  await transport.setRTS(false); // EN high: start
  await sleep(settle);
}

async function ensureTransport() {
  if (!state.transport) {
    // Bounded cleanup first: a session left over from a failed flash may still
    // hold the reader lock.
    await releaseConnection();
    state.transport = new Transport(state.port, false);
    await state.transport.connect(115200);
  }
  return state.transport;
}

async function openTransport() {
  try {
    return await ensureTransport();
  } catch {
    // The session may have been left closed by a failed flash.
    await releaseConnection();
    return ensureTransport();
  }
}

async function pulseEnOnly() {
  const transport = await openTransport();
  await pulseEn(transport);
  // EN and IO0 are idle again; hand the port back before the USB re-enumerates.
  await releaseConnection();
}

// Read whatever the chip prints after a reset, long enough to tell a real boot
// (`boot:0xf`, Zephyr banner) from a chip that fell back into USB download mode
// (`boot:0x0`, "wait usb download").
async function readBootOutput(port, timeout = 1600) {
  const decoder = new TextDecoder();
  let reader;
  const deadline = Date.now() + timeout;
  try {
    await port.open({ baudRate: 115200 });
    reader = port.readable.getReader();
    let text = "";
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        sleep(Math.max(0, deadline - Date.now())).then(() => null),
      ]);
      if (!result || result.done) break;
      if (result.value) {
        text += decoder.decode(result.value, { stream: true });
        if (/wait usb download|boot:0x0|Booting Zephyr/i.test(text)) break;
      }
    }
    return text;
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // Already cancelled.
    }
    try {
      reader?.releaseLock?.();
    } catch {
      // Nothing holds the lock.
    }
    try {
      await port?.close?.();
    } catch {
      // Already closed.
    }
  }
}

async function restartBoard() {
  await releaseConnection();
  try {
    await pulseEnOnly();
  } catch {
    await pulseEnOnly();
  }
  if (!isNativeUsb()) {
    // A USB-UART bridge has no console of its own to read back here; the
    // pulse is the whole answer, and it is the same one esptool sends.
    return "sent";
  }

  // The X1.0 only has the ESP32-C3's internal pull-up on GPIO9 (R3 is DNP and
  // C2 is 100 nF), so the first edge can still be sampled low and drop the chip
  // back into USB download mode. Watch the reset banner and pulse again only
  // while the chip is still sitting in the loader; a second blind pulse would
  // reset a board that already started.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(200);
    let banner = "";
    try {
      banner = await readBootOutput(state.port, 1600);
    } catch {
      // The port can still be enumerating; retry on the next pass.
    }
    if (banner && !/wait usb download|boot:0x0/i.test(banner)) return "confirmed";
    if (!banner && attempt > 0) return "sent";
    try {
      await pulseEnOnly();
    } catch {
      return "sent";
    }
  }
  return "sent";
}

// The ESP32-C3 RTC watchdog reset, the same sequence `esptool --after
// watchdog-reset` uses: unlock the RTC WDT, set its timeout, enable it, lock.
// The chip resets from inside, so this path does not reproduce the EN/GPIO9
// edge that a native-USB reset has to get right.
async function watchdogReset(loader) {
  const RTC_CNTL = 0x60008000;
  const WDT_WKEY = 0x50d83aa1;
  const WDTCONFIG0 = RTC_CNTL + 0x0090;
  const WDTCONFIG1 = RTC_CNTL + 0x0094;
  const WDTWPROTECT = RTC_CNTL + 0x00a8;
  await loader.writeReg(WDTWPROTECT, WDT_WKEY);
  await loader.writeReg(WDTCONFIG1, 2000);
  await loader.writeReg(WDTCONFIG0, (1 << 31) | (5 << 28) | (1 << 8) | 2);
  await loader.writeReg(WDTWPROTECT, 0);
  await sleep(600);
}

// Re-enter the bootloader (the stub is where the registers can be written),
// arm the watchdog and read whatever the boot prints. An empty read is the
// normal case on the X1.0: its Zephyr console does not come up on USB CDC.
async function watchdogRestartBoard() {
  await releaseConnection();
  const transport = new Transport(state.port, false);
  state.transport = transport;
  const loader = new ESPLoader({
    transport,
    baudrate: Number(baudSelect.value),
    terminal: terminal(),
    debugLogging: false,
  });
  state.loader = loader;
  const chip = await loader.main("default_reset");
  if (!/ESP32-C3/i.test(chip)) {
    throw new Error(`看门狗重启只适用于 ESP32-C3，当前芯片是 ${chip}`);
  }
  logLine("已进入引导程序，正在触发看门狗…");
  await watchdogReset(loader);
  await releaseConnection();
  // The USB device re-enumerates; give it a moment before reading the banner.
  await sleep(300);
  let banner = "";
  try {
    banner = await readBootOutput(state.port, 1000);
  } catch {
    // The port can still be enumerating.
  }
  if (banner && /wait usb download|boot:0x0/i.test(banner)) {
    throw new Error("看门狗复位后设备仍停在下载模式，请拔插一次 USB");
  }
  return banner ? "confirmed" : "sent";
}

async function watchdogRestartDevice() {
  if (state.flashing) return;
  if (!navigator.serial || !state.port) {
    setStatus("请先选择开发板串口。", "error");
    return;
  }
  watchdogButton.disabled = true;
  resetButton.disabled = true;
  setStatus("正在通过看门狗重启 X1.0…");
  logLine("正在通过看门狗重启 X1.0…");
  try {
    const restart = await watchdogRestartBoard();
    if (restart === "confirmed") {
      setStatus("X1.0 已通过看门狗重启。", "ok");
      logLine("X1.0 已通过看门狗重启。");
    } else {
      setStatus("已通过看门狗发送重启命令；X1.0 的控制台不走 USB，请在终端里确认。", "ok");
      logLine("已通过看门狗发送重启命令；X1.0 的控制台不走 USB，请在终端里确认。");
    }
  } catch (error) {
    setStatus(`看门狗重启失败：${error?.message || error}`, "error");
    logLine(`看门狗重启失败：${error?.message || error}`);
  } finally {
    // The board is booting; free the port for the terminal or the next flash.
    await releaseConnection();
    updateResetAvailability();
  }
}

async function resetDevice() {
  if (state.flashing) return;
  if (!navigator.serial || !state.port) {
    setStatus("请先选择开发板串口。", "error");
    return;
  }
  resetButton.disabled = true;
  watchdogButton.disabled = true;
  try {
    const restart = await restartBoard();
    if (restart === "confirmed") {
      setStatus("设备已重启。", "ok");
      logLine("设备已重启。");
    } else {
      // The edge was sent; on a bridge with no readable console there is
      // nothing to confirm it against, so the sentence must not claim one.
      setStatus("已发送重启命令。", "ok");
      logLine("已发送重启命令（未读回启动信息）。");
    }
  } catch (error) {
    setStatus(`重启失败：${error?.message || error}`, "error");
  } finally {
    // The board is booting; free the port for the terminal or the next flash.
    await releaseConnection();
    updateResetAvailability();
  }
}

const THEME_KEY = "linkr-theme";

function applyTheme(next) {
  document.documentElement.dataset.theme = next;
  const meta = $("themeColorMeta");
  if (meta) meta.content = next === "dark" ? "#05080D" : "#E2E9F4";
  const label = $("themeLabel");
  if (label) label.textContent = next === "dark" ? "浅色" : "深色";
}

function initTheme() {
  const theme =
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  applyTheme(theme);
  $("themeButton").addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private/embedded storage can reject writes; the theme still applies.
    }
    applyTheme(next);
  });
}

async function init() {
  initTheme();
  const secure = window.isSecureContext && location.protocol !== "file:";
  logLine(
    `页面 ${location.origin} · secure=${secure} · serial=${navigator.serial ? "yes" : "no"}`,
  );
  if (!secure) {
    $("insecure").hidden = false;
    connectButton.disabled = true;
    pickPortButton.disabled = true;
    refreshPortsButton.disabled = true;
  } else if (!navigator.serial) {
    $("unsupported").hidden = false;
    connectButton.disabled = true;
    pickPortButton.disabled = true;
    refreshPortsButton.disabled = true;
  }
  boardSelect.addEventListener("change", () => selectBoard(boardSelect.value));
  portSelect.addEventListener("change", async () => {
    const index = Number.parseInt(portSelect.value, 10);
    state.port = Number.isInteger(index) ? state.ports[index] || null : null;
    await releaseConnection();
    if (state.port) {
      const { vid, pid, name } = portInfo(state.port);
      setPortHint(
        `已选择 ${name}${vid ? `（VID ${vid} / PID ${pid}）` : ""}。` +
          "如果打开失败，请关闭占用该串口的其他程序。",
      );
    } else {
      setPortHint("点击“选择串口”，在浏览器弹窗里选中开发板的 USB 串口。");
    }
    updateResetAvailability();
  });
  pickPortButton.addEventListener("click", () => refreshPorts({ request: true }));
  refreshPortsButton.addEventListener("click", () => refreshPorts());
  navigator.serial?.addEventListener?.("connect", () => refreshPorts());
  navigator.serial?.addEventListener?.("disconnect", () => refreshPorts());
  // Best effort: release the OS port when the tab is closed or reloaded, so a
  // refresh does not leave the previous page holding the serial handle.
  window.addEventListener("pagehide", () => {
    try {
      state.transport?.disconnect?.();
    } catch {
      // Page is going away.
    }
    try {
      state.port?.close?.();
    } catch {
      // Already closed.
    }
  });
  connectButton.addEventListener("click", () => flash());
  retryButton.addEventListener("click", () => flash({ noReset: true }));
  resetButton.addEventListener("click", resetDevice);
  watchdogButton.addEventListener("click", watchdogRestartDevice);
  downloadButton.addEventListener("click", () => {
    if (!state.board) return;
    const url = state.board.zip_url || releaseAssetUrl(state.board);
    window.open(url, "_blank", "noopener");
  });
  $("clearLog").addEventListener("click", () => {
    logView.textContent = "";
  });
  $("copyLog").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(logView.textContent);
      setStatus("烧录日志已复制。", "ok");
    } catch {
      setStatus("复制失败，请手动选中日志复制。", "error");
    }
  });

  logLine("读取最新固件清单…");
  try {
    populateBoards(await loadManifest());
    logLine(`已加载 v${state.manifest.version}，${state.manifest.boards.length} 个板型。`);
    await refreshPorts();
  } catch (error) {
    console.error(error);
    $("releasePill").classList.add("stale");
    $("releasePill").textContent = "无法读取最新固件";
    setStatus(`无法读取固件清单：${error?.message || error}`, "error");
    logLine(`错误：${error?.message || error}`);
    logLine("请从 GitHub Releases 下载固件 ZIP，或稍后刷新页面。");
  }
}

init();
