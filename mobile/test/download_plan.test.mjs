import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { targetDownloadPlan } from '../../web/download_plan.js';
import { fetchDownload, requestComputerDownload } from '../../web/local_download.js';
const probe={executionStatus:'completed',exitCode:0,evidence:'LINKR_TOOL:curl\nLINKR_TOOL:sha256sum\n'};

test('target plans require completed probes and absolute destinations',()=>{
 for(const p of [null,{...probe,executionStatus:'unknown'},{...probe,evidenceTruncated:true},{...probe,evidence:''}]) assert.throws(()=>targetDownloadPlan({url:'https://example.org/a',path:'/tmp/a'},p));
 assert.throws(()=>targetDownloadPlan({url:'https://example.org/a',path:'relative'},probe));
 assert.throws(()=>targetDownloadPlan({url:'file:///a',path:'/tmp/a'},probe));
});

test('target downloads verify hashes and never overwrite destinations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'linkr-download-test-'));
 try {
  // Offline tool fixture: no external network or target hardware.
  writeFileSync(join(dir,'curl'), '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nprintf payload > "$2"\n',{mode:0o755});
  writeFileSync(join(dir,'sha256sum'), '#!/bin/sh\nshasum -a 256 "$1"\n',{mode:0o755});
  const path=join(dir,"file's name.bin");
  const sha256=createHash('sha256').update('payload').digest('hex');
  const run=(args)=>spawnSync('sh',['-c',targetDownloadPlan({url:'https://example.org/a',path,...args},probe).command],{env:{...process.env,PATH:dir+':'+process.env.PATH},encoding:'utf8'});
  assert.equal(run({sha256:'0'.repeat(64)}).status,65);
  assert.equal(existsSync(path),false);
  const good=run({sha256});
  assert.equal(good.status,0,good.stderr);
  assert.match(good.stdout,new RegExp('LINKR_SHA256:'+sha256));
  assert.equal(readFileSync(path,'utf8'),'payload');
  assert.equal(run({sha256}).status,73);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('computer downloads report progress and checksum without UART',async()=>{
 const events=[];
 const sha256=createHash('sha256').update('payload').digest('hex');
 const fetchImpl=async(_url,options)=>{assert.equal(options.credentials,'omit');return new Response('payload',{headers:{'content-length':'7'}});};
 const result=await fetchDownload({url:'https://example.org/a',sha256,fetchImpl,onProgress:p=>events.push(p)});
 assert.equal(result.sha256,sha256);assert.equal(result.checksumStatus,'matched');assert.deepEqual(events,[{bytes:7,total:7}]);
 await assert.rejects(fetchDownload({url:'https://example.org/a',sha256:'0'.repeat(64),fetchImpl}),/mismatch/);
 await assert.rejects(fetchDownload({url:'https://example.org/a',fetchImpl,maxBytes:2}),/limit/);
 await assert.rejects(fetchDownload({url:'https://example.org/a',fetchImpl:async()=>new Response(null,{status:204})}),/no body/);
});

// A model-proposed download must never reach the network on its own: the card is
// rendered first, and only a user gesture starts the fetch. This property is what
// keeps `download_to_computer` safe without routing it through the execution-mode
// gate, so it is pinned here rather than inferred from reading the code.
function stubDownloadDom() {
  const created = [];
  const make = (tag) => {
    const node = { tag, children: [], textContent: '', className: '', type: '', hidden: false,
      disabled: false, href: '', download: '', value: 0, max: 0, onclick: null,
      append(...kids) { node.children.push(...kids); }, remove() {},
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
    created.push(node);
    return node;
  };
  const previous = { document: globalThis.document, window: globalThis.window,
    fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  globalThis.document = { createElement: make };
  globalThis.window = {}; // No showSaveFilePicker: the Firefox/Safari save path.
  // The success path schedules a 60 s objectURL revoke. Under `node --test` that
  // keeps the process alive long past the assertions, so clamp long delays.
  globalThis.setTimeout = (fn, delay, ...rest) =>
    previous.setTimeout(fn, delay > 1000 ? 0 : delay, ...rest);
  return { created, restore() { Object.assign(globalThis, previous); } };
}

const settle = async (condition, ticks = 200) => {
  for (let i = 0; i < ticks; i += 1) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return null;
};

test('a computer download fetches only after the user clicks', async () => {
  const dom = stubDownloadDom();
  const controller = new AbortController();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    const chunk = new TextEncoder().encode('firmware');
    let sent = false;
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(chunk.length) },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { value: chunk, done: false };
          },
          cancel: async () => {},
        }),
      },
    };
  };

  const host = { children: [], append(...kids) { host.children.push(...kids); } };
  const pending = requestComputerDownload({
    container: host,
    args: { url: 'https://example.org/fw.bin', fileName: 'fw.bin' },
    signal: controller.signal,
  });
  let click = null;
  try {
    const button = dom.created.find((el) => el.tag === 'button');
    const status = dom.created.find((el) => el.tag === 'div');
    assert.ok(button && status, 'the card must render a status line and a button');
    assert.match(status.textContent, /https:\/\/example\.org\/fw\.bin/);
    assert.equal(host.children.length, 3, 'status, progress and button appear before any request');
    assert.equal(fetches, 0, 'no request may be made before the click');

    click = button.onclick();
    const link = await settle(() => dom.created.find((el) => el.tag === 'a'));
    assert.ok(link, 'the no-picker path must offer an explicit save link');
    assert.equal(fetches, 1, 'the click starts exactly one request');
    link.onclick();

    // The result is delivered on the outer promise; the click handler returns void.
    const result = await pending;
    assert.equal(result.destination, 'computer');
    assert.equal(result.saveStatus, 'browser-save-requested');
    assert.equal(result.bytes, 8);
  } finally {
    controller.abort();
    if (click) await click.catch(() => {});
    await pending.catch(() => {});
    dom.restore();
  }
});
