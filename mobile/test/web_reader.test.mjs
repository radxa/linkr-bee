import assert from "node:assert/strict";
import test from "node:test";
import { readWebPage } from "../src/web-reader.mjs";

test("web reader omits credentials, bounds text, and marks evidence untrusted", async () => {
  const page = await readWebPage({ url: "https://docs.example.org/board",
    fetchImpl: async (url, options) => {
      assert.equal(options.credentials, "omit");
      assert.equal(options.referrerPolicy, "no-referrer");
      assert.equal(options.headers.Authorization, undefined);
      return new Response("a".repeat(17000), { headers: { "Content-Type": "text/plain" } });
    } });
  assert.equal(page.text.length, 16000);
  assert.equal(page.truncated, true);
  assert.equal(page.untrusted, true);
});

test("web reader rejects credentials and non-HTTP URLs before fetching", async () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://secret@example.org"]) {
    await assert.rejects(readWebPage({ url, fetchImpl: () => assert.fail("must not fetch") }), /HTTP/);
  }
});

test("web reader reports CORS failures and rejects binaries and oversized pages", async () => {
  const run = fetchImpl => readWebPage({ url: "https://docs.example.org", fetchImpl });
  await assert.rejects(run(async () => { throw new TypeError("Failed to fetch"); }), /CORS.*curl\/wget/);
  await assert.rejects(run(async () => new Response("binary", { headers: { "Content-Type": "application/octet-stream" } })), /not a text page/);
  await assert.rejects(run(async () => new Response("x".repeat(524289))), /512 KiB/);
  await assert.rejects(run(async () => new Response("missing", { status: 404 })), /HTTP 404/);
  await assert.rejects(run(async () => new Response(null, { headers: { "Content-Type": "text/plain" } })), /no body/);
});

test("web reader propagates cancellation without starting a request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Stopped"));
  await assert.rejects(readWebPage({ url: "https://docs.example.org", signal: controller.signal,
    fetchImpl: () => assert.fail("must not fetch") }), /Stopped/);
});

test('web reader pages beyond the first excerpt and finds later sections', async () => {
 const source='x'.repeat(17000)+'Needle: board details\n'+'z'.repeat(2000);
 const fetchImpl=async()=>new Response(source,{headers:{'Content-Type':'text/plain'}});
 const first=await readWebPage({url:'https://docs.example.org',fetchImpl});
 const next=await readWebPage({url:'https://docs.example.org',fetchImpl,offset:first.nextOffset});
 assert.equal(first.hasMore,true);assert.equal(next.hasMore,false);
 assert.equal(first.text+next.text,source);
 const found=await readWebPage({url:'https://docs.example.org',fetchImpl,find:'NEEDLE'});
 assert.equal(found.matchFound,true);assert.equal(found.matchIndex,17000);assert.match(found.text,/board details/);
 const missing=await readWebPage({url:'https://docs.example.org',fetchImpl,find:'absent'});
 assert.equal(missing.matchFound,false);assert.equal(missing.text,'');
});

test('web reader rejects invalid paging without issuing requests', async () => {
 for(const args of [{offset:-1},{limit:16001},{offset:0.5},{find:' '},{find:'x'.repeat(201)}]) {
  await assert.rejects(readWebPage({url:'https://docs.example.org',...args,fetchImpl:()=>assert.fail('must not fetch')}),/Invalid/);
 }
});
