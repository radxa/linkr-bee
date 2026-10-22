/* Accessory management for the assistant.
 *
 * These commands configure Linkr Bee itself (UART format, WiFi, WebDAV) over
 * the encrypted Bluetooth LE management channel. They never touch the target
 * UART, so they cannot be confused with terminal input: the assistant must ask
 * the user before changing the bridge, and the credentials it carries must not
 * be echoed back into the conversation, the task store or an exported log.
 *
 * Builders and parsers are pure so the tool layer, the panel and the tests
 * share one definition of every command and reply.
 */

/* Mirrors the firmware limits: parse_uart_line()/linkr_wifi_set_config_op()
 * reject anything outside these, and the Kconfig maxima bound the strings. */
export const ACCESSORY_LIMITS = {
  minBaud: 300,
  maxBaud: 3000000,
  dataBits: [5, 6, 7, 8],
  parity: ["n", "e", "o"],
  stopBits: [1, 2],
  flow: ["none", "rtscts"],
  ssidMax: 32,
  passwordMax: 64,
  webdavUrlMax: 256,
  /* The firmware stores the advertised name in 29 UTF-8 bytes, not characters:
   * a Chinese name is three bytes per ideograph. */
  bleNameMaxBytes: 29,
};

export const DIAGNOSTICS_COMMAND = "@i?";
export const UART_QUERY_COMMAND = "@u?";
export const WIFI_QUERY_COMMAND = "@w?";
export const WEBDAV_QUERY_COMMAND = "@d?";
export const BLE_NAME_QUERY_COMMAND = "@n?";

function invalid(reason) {
  throw new Error(reason);
}

export function setUartCommand({ baud, dataBits = 8, parity = "n", stopBits = 1, flow = "none" } = {}) {
  const rate = Number(baud);
  if (!Number.isInteger(rate) || rate < ACCESSORY_LIMITS.minBaud || rate > ACCESSORY_LIMITS.maxBaud) {
    invalid(`baud must be an integer between ${ACCESSORY_LIMITS.minBaud} and ${ACCESSORY_LIMITS.maxBaud}`);
  }
  if (!ACCESSORY_LIMITS.dataBits.includes(Number(dataBits))) invalid("dataBits must be 5, 6, 7 or 8");
  const parityValue = String(parity).toLowerCase();
  if (!ACCESSORY_LIMITS.parity.includes(parityValue)) invalid("parity must be n, e or o");
  if (!ACCESSORY_LIMITS.stopBits.includes(Number(stopBits))) invalid("stopBits must be 1 or 2");
  const flowValue = String(flow).toLowerCase();
  if (!ACCESSORY_LIMITS.flow.includes(flowValue)) invalid("flow must be none or rtscts");
  return `@u=${rate},${Number(dataBits)},${parityValue},${Number(stopBits)},${flowValue}`;
}

/* A comma separates SSID from password in the firmware parser, so an SSID that
 * contains one would silently move the rest of the name into the password. */
export function wifiCommand({ action = "connect", ssid, password = "" } = {}) {
  const mode = String(action).toLowerCase();
  if (mode === "off") return "@w off";
  if (mode !== "connect") invalid("action must be connect or off");
  const name = String(ssid ?? "");
  if (!name.trim()) invalid("ssid is required");
  if (name.length > ACCESSORY_LIMITS.ssidMax) invalid(`ssid must be at most ${ACCESSORY_LIMITS.ssidMax} characters`);
  if (name.includes(",")) invalid("ssid must not contain a comma");
  if (/[\x00-\x1f\x7f]/.test(name)) invalid("ssid must not contain control characters");
  if (String(password).length > ACCESSORY_LIMITS.passwordMax) {
    invalid(`password must be at most ${ACCESSORY_LIMITS.passwordMax} characters`);
  }
  return `@w=${name},${password}`;
}

export function webdavCommand({ action = "on", url } = {}) {
  const mode = String(action).toLowerCase();
  if (mode === "off") return "@d off";
  if (mode !== "on") invalid("action must be on or off");
  const target = String(url ?? "").trim();
  if (!target) invalid("url is required when enabling WebDAV upload");
  if (target.length > ACCESSORY_LIMITS.webdavUrlMax) invalid(`url must be at most ${ACCESSORY_LIMITS.webdavUrlMax} characters`);
  if (!/^https?:\/\//i.test(target)) invalid("url must start with http:// or https://");
  if (/[\s\x00-\x1f\x7f]/.test(target)) invalid("url must not contain whitespace or control characters");
  return `@d=${target}`;
}

/* The advertised BLE name is display metadata, not an identity: the TUI and Web
 * clients still verify the Management Service and Device ID. Restoring the
 * default uses the dedicated command so the firmware regenerates the
 * hardware-MAC suffix instead of the UI trying to guess it. */
export function bleNameCommand({ name, reset = false } = {}) {
  if (reset) return "@n default";
  // Trim only the four ASCII bytes the firmware trims; String.trim() would
  // also remove NBSP and U+3000, making the same command store a different
  // name depending on which host sent it.
  const value = String(name ?? "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!value) invalid("name is required");
  // The firmware's reject set: C0, DEL, C1, and the two Unicode line
  // separators. Keeping it in step here means a name the board would refuse
  // is stopped before it leaves the browser.
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) {
    invalid("name must not contain control characters");
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > ACCESSORY_LIMITS.bleNameMaxBytes) {
    invalid(`name must be at most ${ACCESSORY_LIMITS.bleNameMaxBytes} UTF-8 bytes`);
  }
  return `@n=${value}`;
}

/* The WiFi password travels in the command, so anything shown to the user or
 * returned to the model is redacted. A WebDAV URL may embed credentials too. */
export function redactCommand(command) {
  const text = String(command ?? "");
  if (text.startsWith("@w=")) {
    const comma = text.indexOf(",");
    return comma === -1 ? text : `${text.slice(0, comma)},<redacted>`;
  }
  if (text.startsWith("@d=")) {
    return text.replace(/^(@d=[a-z]+:\/\/)[^/@\s]*@/i, "$1<redacted>@");
  }
  return text;
}

/* Firmware replies begin with OK or ERR; an ERR line carries the reason the
 * model needs in order to choose a different action. */
export function replyStatus(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const error = lines.find((line) => /^ERR\b/i.test(line));
  if (error) return { ok: false, error };
  return { ok: lines.some((line) => /^OK\b/i.test(line)), error: "" };
}

function fields(line) {
  const found = {};
  for (const token of String(line).split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator > 0) found[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return found;
}

/* "OK uart=115200,8,N,1,none" */
export function parseUartSettings(text) {
  const match = String(text ?? "").match(/\buart=([0-9]+),([0-9]+),([a-zA-Z]+),([0-9]+),([a-z]+)/);
  if (!match) return null;
  return {
    baud: Number(match[1]),
    dataBits: Number(match[2]),
    parity: match[3].toLowerCase(),
    stopBits: Number(match[4]),
    flow: match[5].toLowerCase(),
  };
}

/* "OK wifi=connected,ssid=MyNet,ip=192.168.1.5" or "OK wifi off". The address
 * is taken from the last ",ip=" because an SSID may itself contain a comma,
 * matching how web/app.js reads the same reply. */
export function parseWifiStatus(text) {
  const line = String(text ?? "").split(/\r?\n/).find((candidate) => /wifi[= ]/i.test(candidate)) || "";
  if (/\bwifi off\b/i.test(line)) return { state: "off", ssid: "", ip: "" };
  let payload = line.trim();
  const ipIndex = payload.lastIndexOf(",ip=");
  const ip = ipIndex >= 0 ? payload.slice(ipIndex + 4).trim() : "";
  if (ipIndex >= 0) payload = payload.slice(0, ipIndex);
  const match = payload.match(/wifi=([^,]+)(?:,ssid=(.*))?/i);
  if (!match) return null;
  const ssid = match[2] === undefined || match[2] === "-" ? "" : match[2];
  return { state: match[1].toLowerCase(), ssid, ip };
}

/* "OK webdav=on,url=http://host/dav/". Everything after "url=" is the target,
 * so a URL containing a comma or a query string survives the parse. */
export function parseWebdavStatus(text) {
  const line = String(text ?? "").split(/\r?\n/).find((candidate) => /webdav[= ]/i.test(candidate)) || "";
  if (/\bwebdav off\b/i.test(line)) return { state: "off", url: "" };
  const match = line.match(/webdav=([a-z_]+)(?:,url=(.*))?/i);
  if (!match) return null;
  return { state: match[1].toLowerCase(), url: (match[2] || "").trim() };
}

/* Query replies append "custom=yes|no"; set and reset replies do not. The name
 * itself may contain spaces, so only the fixed suffix is removed and the
 * remaining text is kept verbatim. A write's reply is parsed with
 * `query: false`: a name that itself ends in " custom=yes" must survive. */
export function parseBleName(text, { query = false } = {}) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .find((candidate) => /\bOK\s+name=/i.test(candidate)) || "";
  if (!line) return null;
  const prefix = line.match(/\bOK\s+name=/i);
  if (!prefix) return null;
  let value = line.slice(prefix.index + prefix[0].length).replace(/\r$/, "");
  let custom = null;
  if (query) {
    const suffix = value.match(/ custom=(yes|no)$/i);
    if (suffix) {
      custom = suffix[1].toLowerCase() === "yes";
      value = value.slice(0, suffix.index);
    }
  }
  if (!value) return null;
  return { name: value, custom };
}

/* A device name comes from the radio, not from us: strip control bytes before
 * it reaches a terminal line, so a nearby device cannot inject escape
 * sequences into the journal. */
export function printableDeviceName(name, fallback = "") {
  const text = String(name ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return text || String(fallback ?? "");
}

/* `@i?` answers with several "@info <group> key=value …" frames terminated by
 * "@info done"; the app accumulates them while this module only shapes them. */
export function parseInfoGroups(lines) {
  const groups = {};
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw).trim();
    if (!line.startsWith("@info ")) continue;
    const payload = line.slice("@info ".length).trim();
    if (!payload || payload === "done") continue;
    const parts = payload.split(/\s+/);
    const group = parts.shift();
    if (!group) continue;
    groups[group] = { ...(groups[group] || {}), ...fields(parts.join(" ")) };
  }
  return groups;
}

export function isDiagnosticsDone(line) {
  return String(line ?? "").trim() === "@info done";
}

/* One-line summary for the approval card. The command itself is shown redacted
 * so approving never displays a credential that the transcript may keep. */
export function accessoryChangeSummary(command, lang = "en") {
  const zh = String(lang).startsWith("zh");
  const text = String(command ?? "");
  if (text.startsWith("@u=")) {
    const settings = text.slice(3);
    return zh ? `把桥接串口改为 ${settings}` : `Set the bridge UART to ${settings}`;
  }
  if (text.startsWith("@w=")) {
    const ssid = text.slice(3, text.indexOf(",") === -1 ? undefined : text.indexOf(","));
    return zh ? `连接 WiFi「${ssid}」（密码不显示）` : `Join WiFi "${ssid}" (password hidden)`;
  }
  if (text === "@w off") return zh ? "断开 WiFi 并清除当前配置" : "Disconnect WiFi and clear the current configuration";
  if (text.startsWith("@d=")) return zh ? `启用日志上传到 ${text.slice(3)}` : `Enable log upload to ${text.slice(3)}`;
  if (text === "@d off") return zh ? "关闭 WebDAV 日志上传" : "Disable WebDAV log upload";
  if (text.startsWith("@n=")) return zh ? `把 BLE 名称改为「${text.slice(3)}」` : `Set the BLE name to "${text.slice(3)}"`;
  if (text === "@n default") return zh ? "恢复按 MAC 生成的默认 BLE 名称" : "Restore the hardware-MAC default BLE name";
  return text;
}

/* Approval card for one accessory change. Mirrors the computer-download card:
 * it renders into the tool row and settles when the user clicks, when the run
 * is aborted, or when the device session changes. */
export function requestAccessoryApproval({ container, command, lang = "en", signal }) {
  const zh = String(lang).startsWith("zh");
  const redacted = redactCommand(command);
  return new Promise((resolve, reject) => {
    const status = document.createElement("div");
    const note = document.createElement("p");
    note.className = "accessory-approval-note";
    const approveButton = document.createElement("button");
    const rejectButton = document.createElement("button");
    approveButton.type = "button"; approveButton.className = "btn btn-primary";
    rejectButton.type = "button"; rejectButton.className = "btn";
    approveButton.textContent = zh ? "允许修改" : "Allow change";
    rejectButton.textContent = zh ? "拒绝" : "Reject";
    note.textContent = zh
      ? "这会修改 Linkr Bee 自身（不是目标机），通过加密的蓝牙管理通道发送："
      : "This changes Linkr Bee itself (not the target), sent over the encrypted Bluetooth management channel:";
    status.textContent = accessoryChangeSummary(command, lang);
    container.append(status, note, approveButton, rejectButton);

    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      approveButton.disabled = rejectButton.disabled = true;
      error ? reject(error) : resolve({ approved: true, redacted });
    };
    const onAbort = () => {
      status.textContent += zh ? "\n已取消" : "\nCancelled";
      finish(signal.reason ?? new Error("Accessory change cancelled"));
    };
    approveButton.onclick = () => finish();
    rejectButton.onclick = () => {
      status.textContent += zh ? "\n已拒绝" : "\nRejected";
      finish(new Error(zh
        ? "用户拒绝了这个修改。不要重试，除非用户提出新的要求。"
        : "The user rejected this change. Do not retry unless the user asks again."));
    };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
