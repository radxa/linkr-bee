import { validateDownload } from "./download_plan.js";

// Bounded browser download; larger images should use the target download path.
export async function fetchDownload({ url, sha256, signal, onProgress = () => {}, fetchImpl = fetch, maxBytes = 128 * 1024 * 1024 }) {
  ({ url, sha256 } = validateDownload({ url, sha256 }));
  const response = await fetchImpl(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  const total = declared > 0 ? declared : null;
  if (total > maxBytes) {
    // A null body (HEAD-like or opaque responses) must not mask the real error.
    try { await response.body?.cancel(); } catch { /* nothing to release */ }
    throw new Error("Browser download limit is 128 MiB; use target download for larger files.");
  }
  if (!response.body) {
    throw new Error("The download response has no body.");
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error("Browser download exceeds 128 MiB; use target download.");
      chunks.push(value);
      onProgress({ bytes, total });
    }
  } finally { await reader.cancel().catch(() => {}); }
  signal?.throwIfAborted();
  const content = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
  const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", content))].map(b => b.toString(16).padStart(2, "0")).join("");
  signal?.throwIfAborted();
  if (sha256 && actual !== sha256) throw new Error(`SHA-256 mismatch. Expected ${sha256}; actual ${actual}. File was not offered for saving.`);
  return { content, bytes, sha256: actual, checksumStatus: sha256 ? "matched" : "computed-only" };
}

export function requestComputerDownload({ container, args, signal, lang = "en" }) {
  const zh = lang.startsWith("zh");
  const fileName = args.fileName;
  if (!fileName || /[\\/\x00-\x1f\x7f]/.test(fileName) || [".", ".."].includes(fileName)) return Promise.reject(new Error("Specify a plain file name for the computer download."));
  validateDownload(args);
  return new Promise((resolve, reject) => {
    const status = document.createElement("div"), progress = document.createElement("progress"), button = document.createElement("button");
    button.type = "button"; button.className = "btn btn-primary";
    button.textContent = zh ? "选择保存位置并下载" : "Choose location and download";
    status.textContent = `${zh ? "保存到：当前电脑 / 手机" : "Destination: this computer / phone"}\n${fileName}\n${args.url}\n${zh ? "该网络请求由本机浏览器发起" : "This browser makes the network request above"}\nSHA-256: ${args.sha256 || (zh ? "未提供预期值，将计算校验值" : "No expected hash; compute only")}`;
    progress.hidden = true;
    container.append(status, progress, button);
    let handle, objectUrl;
    const abort = () => { button.disabled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); status.textContent += zh ? "\n已取消" : "\nCancelled"; reject(signal.reason); };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, {once:true});
    button.onclick = async () => {
      button.disabled = true;
      try {
        signal?.throwIfAborted();
        if (window.showSaveFilePicker) handle = await window.showSaveFilePicker({ suggestedName: fileName });
        signal?.throwIfAborted();
        progress.hidden = false;
        const data = await fetchDownload({ ...args, signal, onProgress: ({bytes,total}) => {
          progress.value = bytes; if (total) progress.max = total; else progress.removeAttribute("value");
          status.textContent = `${zh ? "当前电脑 / 手机" : "This computer / phone"} · ${handle?.name || fileName}\n${bytes} / ${total ?? "?"} bytes`;
        } });
        let saveStatus;
        if (handle) {
          const writer = await handle.createWritable();
          try { await writer.write(data.content); signal?.throwIfAborted(); await writer.close(); }
          catch (error) { await writer.abort().catch(() => {}); throw error; }
          saveStatus = "saved";
        } else {
          objectUrl = URL.createObjectURL(new Blob([data.content]));
          const link = document.createElement("a");
          link.href = objectUrl; link.download = fileName;
          link.textContent = zh ? "点击保存已校验的文件" : "Save checked file";
          container.append(link);
          await new Promise((done, fail) => {
            const stop = () => { link.remove(); fail(signal.reason); };
            signal?.addEventListener("abort", stop, {once:true});
            link.onclick = () => { signal?.removeEventListener("abort", stop); setTimeout(() => URL.revokeObjectURL(objectUrl), 60000); done(); };
            status.textContent = `${fileName}\n${data.bytes} bytes\nSHA-256: ${data.sha256}\n${zh ? "文件已就绪，请点击保存" : "Ready; click Save"}`;
          });
          saveStatus = "browser-save-requested";
        }
        const result = { destination:"computer", fileName:handle?.name || fileName, bytes:data.bytes, sha256:data.sha256,
          checksumStatus:data.checksumStatus, saveStatus, path:handle ? "User-selected location; browser does not expose the absolute path" : "Browser-managed download location; disk write is not observable",
          next:"Download stage finished. Report the result and wait for the user's next instruction; do not install or flash." };
        status.textContent = `${zh ? "当前电脑 / 手机" : "This computer / phone"} · ${result.fileName}\n${data.bytes} bytes\nSHA-256: ${data.sha256}\n${data.checksumStatus === "matched" ? (zh ? "与预期校验值一致" : "Matches expected checksum") : (zh ? "仅计算校验值，未提供预期值" : "Computed only; no expected hash provided")}\n${zh ? (handle ? "已保存到所选位置（浏览器不提供绝对路径）" : "已请求浏览器保存（无法确认磁盘写入）") : result.path}`;
        signal?.removeEventListener("abort", abort); resolve(result);
      } catch (error) { status.textContent += `\n${error.message}`; signal?.removeEventListener("abort", abort); reject(error); }
    };
  });
}
