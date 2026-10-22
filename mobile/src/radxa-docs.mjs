const SITE = "https://docs.radxa.com";
const RAW = "https://raw.githubusercontent.com/radxa-docs/docs/";
const TREE = "https://api.github.com/repos/radxa-docs/docs/git/trees/main?recursive=1";
const CATALOG = `${SITE}/agent/products.json`;
const SITEMAP = `${SITE}/sitemap.xml`;
const EN = "i18n/en/docusaurus-plugin-content-docs/current/";
const TTL = 15 * 60_000;
const normalize = value => value.toLowerCase().replace(/[^a-z0-9+\u4e00-\u9fff]/g, "");
const boardKey = value => normalize(value).replace(/^(?:radxa|瑞莎)/, "");
function mentionsBoard(query, alias) {
  const pattern = [...alias].map(char => char === "+" ? "\\+" : char).join("[\\s_-]*");
  return new RegExp(`(^|[^a-z0-9+])${pattern}(?![a-z0-9+])`, "i").test(query);
}
const topicAliases = [
  [/刷机|烧录|固件|镜像|安装系统|\b(?:flash|firmware|image|installation)\b/i, ["install-system", "download", "firmware", "getting-started"]],
  [/串口|调试口|波特率|\b(?:uart|serial|baud)\b/i, ["uart", "serial", "debug"]],
  [/启动|开机|引导|\bboot\b/i, ["boot", "getting-started", "faq", "troubleshoot"]],
  [/网络|联网|网卡|以太网|无线|\b(?:network|ethernet|wifi)\b/i, ["network", "ethernet", "wifi"]],
  [/供电|电源|电压|\b(?:power|voltage)\b/i, ["power", "hardware", "gpio"]],
  [/风扇|散热|温度|\b(?:fan|thermal|temperature)\b/i, ["fan", "thermal", "hardware"]],
  [/存储|硬盘|\bstorage\b/i, ["storage", "nvme", "ufs", "emmc"]],
];

function siteUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === SITE && !url.username && !url.password && !url.search && !url.hash && url.href.length <= 2048
      ? url.href.replace(/\/$/, "") : null;
  } catch { return null; }
}
function sourcePath(value) {
  return typeof value === "string" && value.length <= 1024 && !/[\\\x00-\x1f\x7f?#]/.test(value) &&
    !value.split("/").some(part => !part || part === "." || part === "..") &&
    (value.startsWith("docs/") || value.startsWith(EN)) && /\.mdx?$/i.test(value);
}
const rawUrl = (path, revision) => RAW + revision + "/" + path.split("/").map(encodeURIComponent).join("/");
const under = (url, root) => url === root || url.startsWith(root + "/");
const xmlText = value => value.replace(/&(amp|lt|gt|quot|apos);/g,
  (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]);

/* Discovery stays client-side: only fixed public index URLs are fetched, never
 * the question, serial logs or model credentials. No search/download proxy.
 * Cache completed reads only, so one cancelled request cannot poison another. */
export function createRadxaDocsSearch({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  async function read(url, signal, maxBytes = 1024 * 1024) {
    signal?.throwIfAborted();
    const previous = cache.get(url);
    if (previous && now() - previous.time < TTL) return previous;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Radxa index read timed out after 15 seconds.")), 15000);
    let reader;
    try {
      const response = await fetchImpl(url, { signal: controller.signal, credentials: "omit",
        referrerPolicy: "no-referrer", redirect: "error", headers: { Accept: "application/json,application/xml,text/xml" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Index exceeds the reading limit.");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "", bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error("Index exceeds the reading limit.");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      controller.signal.throwIfAborted();
      const item = { text, time: now(), fetchedAt: new Date(now()).toISOString() };
      cache.set(url, item);
      return item;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new Error(`Unable to read official Radxa index ${url}: ${error.message}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => {});
    }
  }

  async function catalog(signal) {
    let entry;
    try { entry = await read(CATALOG, signal); }
    catch (error) { signal?.throwIfAborted(); entry = await read(`${RAW}main/static/agent/products.json`, signal); }
    const data = JSON.parse(entry.text);
    if (!Array.isArray(data.products)) throw new Error("Invalid Radxa product catalog.");
    return data.products.filter(p => p && typeof p.name === "string" && p.name.length <= 160 && p.public_urls &&
      (p.id === undefined || (typeof p.id === "string" && p.id.length <= 160)));
  }
  async function published(signal) {
    const index = await read(SITEMAP, signal);
    if (!/<(?:\w+:)?urlset\b/.test(index.text)) throw new Error("Invalid published sitemap.");
    const urls = [...new Set([...index.text.matchAll(/<(?:\w+:)?loc>\s*([^<]+?)\s*<\/(?:\w+:)?loc>/g)]
      .map(match => siteUrl(xmlText(match[1]))).filter(Boolean))];
    if (!urls.length) throw new Error("Published sitemap contains no documentation routes.");
    return { ...index, indexUrl: SITEMAP, source: "published", entries: urls.map(url => ({ url, siteUrl: url })) };
  }
  async function repository(signal) {
    const index = await read(TREE, signal, 6 * 1024 * 1024);
    const tree = JSON.parse(index.text);
    if (!Array.isArray(tree.tree) || !/^[a-f0-9]{40,64}$/.test(tree.sha || "")) throw new Error("Invalid official source tree.");
    const entries = tree.tree.filter(item => item.type === "blob" && sourcePath(item.path) &&
      !item.path.split("/").some(part => part.startsWith("_"))).map(item => {
      const english = item.path.startsWith(EN);
      const relative = item.path.slice(english ? EN.length : 5).replace(/\/(?:README|index)\.mdx?$/i, "").replace(/\.mdx?$/i, "");
      return { url: rawUrl(item.path, tree.sha), sourcePath: item.path,
        siteUrl: `${SITE}/${english ? "en/" : ""}${relative}`, language: english ? "en" : "zh" };
    });
    return { ...index, indexUrl: TREE, source: "repository", revision: tree.sha, incomplete: tree.truncated === true, entries };
  }

  return async function searchRadxaDocs({ query, board = "", language = "zh", source = "published", limit = 8, signal }) {
    if (typeof query !== "string" || !query.trim() || query.length > 160 || typeof board !== "string" || board.length > 80 ||
        !["zh", "en"].includes(language) || !["published", "repository"].includes(source) || !Number.isInteger(limit) || limit < 1 || limit > 12) {
      throw new Error("Use a focused query (1-160 characters), optional exact board, zh/en language and 1-12 results.");
    }
    signal?.throwIfAborted();
    const warnings = [];
    const [productsResult, indexResult] = await Promise.allSettled([
      catalog(signal), source === "repository" ? repository(signal) : published(signal),
    ]);
    signal?.throwIfAborted();
    const products = productsResult.status === "fulfilled" ? productsResult.value : [];
    if (productsResult.status === "rejected") warnings.push(productsResult.reason.message);
    let index;
    if (indexResult.status === "fulfilled") index = indexResult.value;
    else if (source === "published") {
      warnings.push(indexResult.reason.message, "Published sitemap unavailable; using official repository source paths.");
      index = await repository(signal);
    } else throw indexResult.reason;
    signal?.throwIfAborted();
    if (index.incomplete) warnings.push("GitHub returned a truncated tree: missing results do not establish absent documentation.");

    const aliases = p => [p.name, p.id || "", p.name.split(/\s+/).at(-1)].map(boardKey).filter(v => v.length >= 3);
    const wanted = boardKey(board);
    const matched = products.filter(p => wanted ? aliases(p).includes(wanted)
      : aliases(p).some(alias => mentionsBoard(query, alias)));
    const roots = [...new Set(matched.map(p => siteUrl(p.public_urls[language])).filter(Boolean))];
    const productsByUrl = new Map();
    // Shared product pages should use the requested model's catalog label.
    for (const product of [...matched, ...products]) {
      const url = siteUrl(product.public_urls[language]);
      if (url && !productsByUrl.has(url)) productsByUrl.set(url, product);
    }
    const boardWords = new Set(matched.flatMap(p => (p.name + " " + (p.id || "")).toLowerCase().split(/[^a-z0-9+]+/)));
    const words = (query.toLowerCase().match(/[a-z0-9+][a-z0-9+-]*/g) || [])
      .filter(word => !boardWords.has(word) && !matched.some(p => aliases(p).includes(boardKey(word))) &&
        !["radxa", "docs", "documentation", "how", "to", "the", "for", "find", "and"].includes(word));
    const groups = [...new Set(words)].map(word => [word]);
    for (const [pattern, terms] of topicAliases) if (pattern.test(query)) groups.push(terms);
    const hasUnmappedTopic = !groups.length && /[\u4e00-\u9fff]/.test(query.replace(/瑞莎|文档|查询|查找|请|帮我|相关|官方|资料|如何|怎么|查看|的/g, ""));

    const matches = index.entries.flatMap(entry => {
      const english = new URL(entry.siteUrl).pathname.startsWith("/en/");
      if (english !== (language === "en")) return [];
      if (roots.length && !roots.some(root => under(entry.siteUrl, root))) return [];
      if (wanted && !roots.length) {
        const segments = new URL(entry.siteUrl).pathname.split("/").filter(Boolean).map(normalize);
        if (!segments.some((part, i) => part === wanted || part + (segments[i + 1] || "") === wanted)) return [];
      }
      let path = new URL(entry.siteUrl).pathname.toLowerCase();
      try { path = decodeURIComponent(path); } catch { /* A malformed escape is not a match for decoded terms. */ }
      const score = groups.reduce((sum, group) => sum + (group.some(term => path.includes(term)) ? 10 : 0), 0);
      if ((groups.length && !score) || hasUnmappedTopic) return [];
      const product = productsByUrl.get(entry.siteUrl);
      const sourceEntry = product?.source_entries?.[language];
      return [{ ...entry, score, title: product?.name || path.replace(/^\/en\//, "/").split("/").filter(Boolean).join(" / "),
        ...(sourcePath(sourceEntry) ? { sourceUrl: rawUrl(sourceEntry, "main") } : {}) }];
    }).sort((a, b) => b.score - a.score || a.siteUrl.length - b.siteUrl.length || a.url.localeCompare(b.url));
    return { query, board, language, source: index.source, searchScope: index.source === "published" ? "published-paths" : "source-paths",
      indexUrl: index.indexUrl, indexFetchedAt: index.fetchedAt, revision: index.revision,
      ...(index.revision ? { revisionKind: "git-tree" } : {}),
      matchedBoards: matched.slice(0, 8).map(p => p.name), totalMatches: matches.length, hasMore: matches.length > limit,
      results: matches.slice(0, limit).map(({ score, ...entry }) => entry), warnings, untrusted: true,
      note: "Navigation search, not full-text or specification evidence. Read result URLs before citing facts. Catalog coverage is incomplete; no matches do not prove no documentation. Try a model name, route keyword or repository source. Repository siteUrl values are inferred navigation hints, not verified published routes." };
  };
}
