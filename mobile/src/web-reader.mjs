const MAX_BYTES = 512 * 1024;

function webUrl(value, base) {
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP(S) URL without embedded credentials.");
  }
  return url.href;
}

export function extractWebPage(source, url, contentType) {
  if (!contentType.includes("html")) return { title: "", text: source, links: [] };
  const doc = new DOMParser().parseFromString(source, "text/html");
  doc.querySelectorAll("script,style,noscript,iframe,template,svg").forEach(node => node.remove());
  const links = [];
  const seen = new Set();
  const primary = doc.querySelector("main,article") || doc.body;
  // Large documentation menus must not consume the link budget before the
  // page's own references and next chapter are reached.
  for (const anchor of [...primary.querySelectorAll("a[href]"), ...doc.querySelectorAll("a[href]")]) {
    try {
      const href = webUrl(anchor.getAttribute("href"), url);
      if (!seen.has(href)) {
        links.push({ text: anchor.textContent.trim().slice(0, 120), url: href });
        seen.add(href);
      }
    } catch { /* Ignore non-web links. */ }
    if (links.length >= 40) break;
  }
  doc.querySelectorAll("br,p,div,li,pre,h1,h2,h3,h4,tr,section").forEach(node => node.append("\n"));
  return { title: doc.title, text: (doc.querySelector("main,article") || doc.body).textContent,
    links };
}

export async function readWebPage({ url, offset = 0, limit = 16000, find, signal, fetchImpl = fetch, extract = extractWebPage }) {
  url = webUrl(url);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000 ||
      (find !== undefined && (typeof find !== 'string' || !find.trim() || find.length > 200))) {
    throw new Error('Invalid page offset, limit or search text.');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Web read timed out after 15 seconds.")), 15000);
  let reader;
  try {
    const response = await fetchImpl(url, { signal: controller.signal, credentials: "omit",
      referrerPolicy: "no-referrer", headers: { Accept: "text/html,text/plain,application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!/^(text\/|application\/(json|xhtml\+xml))/.test(contentType)) {
      throw new Error("This URL is not a text page. Use the download tool for the destination chosen by the user.");
    }
    if (!response.body) {
      throw new Error("The page response has no body.");
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let source = "", bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Page exceeds the 512 KiB reading limit. Use a smaller document or the target shell.");
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
    const finalUrl = webUrl(response.url || url);
    const page = extract(source, finalUrl, contentType);
    // Raw Markdown/MDX and config examples need their original indentation.
    const text = contentType.includes("html")
      ? page.text.replace(/[\t ]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim() : page.text;
    const matchIndex = find === undefined ? null : text.toLowerCase().indexOf(find.toLowerCase(), offset);
    const start = Math.min(text.length, find === undefined ? offset : matchIndex < 0 ? text.length : Math.max(offset,matchIndex-200));
    const nextOffset = Math.min(text.length,start+limit);
    return { url: finalUrl, title: page.title, text: text.slice(start,nextOffset), links: page.links,
      offset:start,nextOffset,totalCharacters:text.length,hasMore:nextOffset<text.length,
      matchIndex,matchFound:find === undefined ? null : matchIndex >= 0,
      fetchedAt:new Date().toISOString(),
      truncated: start>0 || nextOffset<text.length, untrusted: true };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw new Error(`Unable to read ${url}: ${error.message}. Browser CORS or network policy may block access. If a target shell is available, consider curl/wget under the current execution mode.`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
  }
}
