import assert from "node:assert/strict";
import test from "node:test";
import { createRadxaDocsSearch } from "../src/radxa-docs.mjs";

const site = "https://docs.radxa.com";
const revision = "a".repeat(40);
const products = { products: [
  { name: "Dragon Q8B", id: "dragon-q8b", public_urls: { zh: `${site}/dragon/q8b`, en: `${site}/en/dragon/q8b` },
    source_entries: { zh: "docs/dragon/q8b/README.md" } },
  { name: "Dragon Q6A", id: "dragon-q6a", public_urls: { zh: `${site}/dragon/q6a`, en: `${site}/en/dragon/q6a` } },
] };
const routes = ["/dragon/q8b", "/dragon/q8b/system-config/uart-debug", "/dragon/q8b/getting-started/edl-mode",
  "/dragon/q6a/system-config/uart-debug", "/dragon/q8b-other/system-config/uart-debug", "/en/dragon/q8b/system-config/uart-debug"];
const sitemap = urls => `<urlset>${urls.map(url => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
const tree = { sha: revision, truncated: false, tree: [
  { type: "blob", path: "docs/dragon/q8b/README.md" },
  { type: "blob", path: "docs/dragon/q8b/system-config/uart-debug.mdx" },
  { type: "blob", path: "i18n/en/docusaurus-plugin-content-docs/current/dragon/q8b/system-config/uart-debug.mdx" },
  { type: "blob", path: "docs/common/_partial/uart.md" },
  { type: "blob", path: "docs/../secret.md" },
  { type: "blob", path: "docs/dragon/q8b/passwords.txt" },
  { type: "tree", path: "docs/dragon/q8b/directory.md" },
] };

function fixture({ override = () => null, now } = {}) {
  const requests = [];
  const search = createRadxaDocsSearch({ now, fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, undefined);
    const replaced = await override(url, options);
    if (replaced) return replaced;
    const data = url.includes("products.json") ? JSON.stringify(products)
      : url.includes("sitemap.xml") ? sitemap(routes.map(route => site + route)) : JSON.stringify(tree);
    return new Response(data);
  } });
  return { search, requests };
}

test("Chinese UART queries match only the exact board and requested language", async () => {
  const { search, requests } = fixture();
  const result = await search({ query: "串口调试", board: "Dragon Q8B" });
  assert.deepEqual(result.results.map(r => r.url), [`${site}/dragon/q8b/system-config/uart-debug`]);
  assert.deepEqual(result.matchedBoards, ["Dragon Q8B"]);
  assert.equal(result.searchScope, "published-paths");
  assert.equal(result.untrusted, true);
  assert.match(result.note, /not full-text/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => !url.includes("串口")), "the question is never sent to a search service");
  const english = await search({ query: "UART", board: "Q8B", language: "en" });
  assert.deepEqual(english.results.map(r => r.url), [`${site}/en/dragon/q8b/system-config/uart-debug`]);
});

test("a board can be inferred from a query and firmware topics rank EDL documents", async () => {
  const { search } = fixture();
  const result = await search({ query: "Q8B EDL 刷机" });
  assert.match(result.results[0].url, /q8b\/getting-started\/edl-mode$/);
  assert.ok(result.results.every(r => !r.url.includes("q6a")));
  const board = await search({ query: "DragonQ8B 的文档" });
  assert.equal(board.results[0].url, `${site}/dragon/q8b`);
  assert.match(board.results[0].sourceUrl, /radxa-docs\/docs\/main\/docs\/dragon\/q8b\/README.md$/);
  const branded = await search({ query: "串口", board: "Radxa Dragon Q8B" });
  assert.equal(branded.results.length, 1);
});

test("board inference respects model boundaries and can retain two explicitly named boards", async () => {
  const catalog = { products: [...products.products,
    { name: "CM3", public_urls: { zh: `${site}/compute/cm3` } },
    { name: "CM3I", public_urls: { zh: `${site}/compute/cm3i` } },
  ] };
  const { search } = fixture({ override: url => url.includes("products.json") ? new Response(JSON.stringify(catalog))
    : url.includes("sitemap.xml") ? new Response(sitemap([...routes.map(route => site + route), `${site}/compute/cm3/uart`, `${site}/compute/cm3i/uart`])) : null });
  const result = await search({ query: "查 CM3I 串口" });
  assert.deepEqual(result.matchedBoards, ["CM3I"]);
  assert.deepEqual(result.results.map(r => r.url), [`${site}/compute/cm3i/uart`]);
  const comparison = await search({ query: "Q6A Q8B 串口" });
  assert.deepEqual(comparison.matchedBoards, ["Dragon Q8B", "Dragon Q6A"]);
});

test("unknown topics return no matches without claiming documentation is absent", async () => {
  const { search } = fixture();
  const result = await search({ query: "未知功能", board: "Q8B" });
  assert.deepEqual(result.results, []);
  assert.match(result.note, /no matches do not prove no documentation/);
});

test("unknown catalog boards can still match published routes", async () => {
  const { search } = fixture({ override: url => url.includes("sitemap.xml")
    ? new Response(sitemap([`${site}/future/f99/uart-debug`])) : null });
  const result = await search({ query: "串口", board: "F99" });
  assert.equal(result.results[0].url, `${site}/future/f99/uart-debug`);
  assert.deepEqual(result.matchedBoards, []);
});

test("blocked published discovery falls back to verified source files at a fixed revision", async () => {
  const { search } = fixture({ override: url => url.includes("sitemap.xml") ? new Response("blocked", { status: 403 }) : null });
  const result = await search({ query: "串口", board: "Q8B" });
  assert.equal(result.source, "repository");
  assert.equal(result.revision, revision);
  assert.equal(result.revisionKind, "git-tree");
  assert.deepEqual(result.results.map(r => r.sourcePath), ["docs/dragon/q8b/system-config/uart-debug.mdx"]);
  assert.equal(result.results[0].url, `https://raw.githubusercontent.com/radxa-docs/docs/${revision}/docs/dragon/q8b/system-config/uart-debug.mdx`);
  assert.match(result.warnings.join(" "), /403.*using official repository/s);
});

test("explicit repository search marks route hints and reads no published sitemap", async () => {
  const { search, requests } = fixture();
  const result = await search({ query: "uart", board: "Q8B", language: "en", source: "repository" });
  assert.match(result.results[0].sourcePath, /^i18n\/en\//);
  assert.equal(result.searchScope, "source-paths");
  assert.match(result.note, /inferred navigation hints/);
  assert.ok(!requests.some(url => url.includes("sitemap.xml")));
});

test("a blocked catalog uses the official raw catalog without blocking route discovery", async () => {
  const { search, requests } = fixture({ override: url => url === `${site}/agent/products.json` ? new Response("no", { status: 403 }) : null });
  const result = await search({ query: "uart", board: "Q8B" });
  assert.equal(result.results.length, 1);
  assert.ok(requests.includes("https://raw.githubusercontent.com/radxa-docs/docs/main/static/agent/products.json"));
});

test("a broken optional product catalog does not hide sitemap-only documentation", async () => {
  const { search } = fixture({ override: url => url.includes("products.json") ? new Response("bad JSON") : null });
  const result = await search({ query: "uart", board: "q6a" });
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].url, /q6a/);
  assert.equal(result.warnings.length, 1);
  const q8b = await search({ query: "uart", board: "Q8B" });
  assert.ok(q8b.results.every(r => !r.url.includes("q8b-other")), "fallback matching must not include a different board");
});

test("malicious sitemap links are filtered to canonical official URLs", async () => {
  const { search } = fixture({ override: url => url.includes("sitemap.xml") ? new Response(sitemap([
    `${site}/dragon/q8b/uart`, "https://docs.radxa.com.evil.test/dragon/q8b/uart", "javascript:alert(1)",
    "https://secret@docs.radxa.com/dragon/q8b/uart", `${site}/dragon/q8b/uart?token=secret`,
  ])) : null });
  const result = await search({ query: "uart", board: "Q8B" });
  assert.deepEqual(result.results.map(r => r.url), [`${site}/dragon/q8b/uart`]);
});

test("truncated repository indexes disclose incomplete coverage", async () => {
  const { search } = fixture({ override: url => url.includes("api.github.com") ? new Response(JSON.stringify({ ...tree, truncated: true })) : null });
  const result = await search({ query: "uart", source: "repository" });
  assert.match(result.warnings.join(" "), /truncated tree/);
});

test("index caching preserves fetchedAt and refreshes after fifteen minutes", async () => {
  let time = 1000;
  const { search, requests } = fixture({ now: () => time });
  const first = await search({ query: "uart", board: "Q8B" });
  time += 1000;
  const second = await search({ query: "EDL", board: "Q8B" });
  assert.equal(second.indexFetchedAt, first.indexFetchedAt);
  assert.equal(requests.length, 2);
  time += 15 * 60_000;
  const third = await search({ query: "uart", board: "Q8B" });
  assert.notEqual(third.indexFetchedAt, first.indexFetchedAt);
  assert.equal(requests.length, 4);
});

test("result limits disclose additional matches", async () => {
  const { search } = fixture();
  const result = await search({ query: "Q8B", limit: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.hasMore, true);
  assert.ok(result.totalMatches > 1);
});

test("cancelled search sends no requests or fallback fetches", async () => {
  const controller = new AbortController(); controller.abort(new Error("Stopped"));
  const { search, requests } = fixture();
  await assert.rejects(search({ query: "Q8B", signal: controller.signal }), /Stopped/);
  assert.equal(requests.length, 0);
});

test("stopping an active read prevents the repository fallback", async () => {
  const controller = new AbortController();
  const { search, requests } = fixture({ override: url => {
    if (url.includes("sitemap.xml")) { controller.abort(new Error("Stopped")); throw controller.signal.reason; }
    return null;
  } });
  await assert.rejects(search({ query: "Q8B", signal: controller.signal }), /Stopped/);
  assert.ok(!requests.some(url => url.includes("api.github.com")));
});

test("oversized and malformed indexes fail with the actual reason", async () => {
  const { search } = fixture({ override: url => url.includes("api.github.com") ? new Response("x", { headers: { "content-length": String(7 * 1024 * 1024) } })
    : url.includes("sitemap.xml") ? new Response("not an XML sitemap") : null });
  await assert.rejects(search({ query: "Q8B" }), /reading limit/);
});

for (const args of [{ query: "" }, { query: "x".repeat(161) }, { query: "uart", board: 1 },
  { query: "uart", language: "fr" }, { query: "uart", source: "evil" }, { query: "uart", limit: 13 }]) {
  test(`invalid search arguments cause no network request: ${JSON.stringify(args)}`, async () => {
    const { search, requests } = fixture();
    await assert.rejects(search(args), /focused query/);
    assert.equal(requests.length, 0);
  });
}
