import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.js',import.meta.url),'utf8');
const start = source.indexOf('function makeSession(');
const code = source.slice(start,source.indexOf('/** Start the resident session',start));
const captureStart = source.indexOf('const MAX_CAPTURE_BYTES');
const captureCode = source.slice(captureStart, source.indexOf('/**\n * Run one bee-cli request.', captureStart));
for (const retry of [0,2]) {
  test(`exec guard honours a two minute timeout with ${retry} retries`, async () => {
    let now=0,killed=false,request;
    const timers=new Map();
    const pipe=()=>Object.assign(new EventEmitter(),{setEncoding(){}});
    const child=Object.assign(new EventEmitter(),{
      stdout:pipe(),stderr:pipe(),stdin:Object.assign(pipe(),{write(text){request=JSON.parse(text);}}),kill(){killed=true;}
    });
    const lifecycle=new AbortController();
    const make=vm.runInNewContext(captureCode+code+';makeSession',{
      Buffer,lifecycle,session:null,watchActive:null,watchWanted:false,operationSignal:s=>s??lifecycle.signal,SESSION_TIMEOUT_MS:60000,
      setTimeout(fn,ms){const key={};timers.set(key,{fn,at:now+ms});return key;},clearTimeout:key=>timers.delete(key)
    });
    const session=make(child,{ops:['exec','watch']},{});
    const result=session.request('exec',{cmd:'slow-task',timeout_ms:120000,retry}).catch(e=>e);
    await Promise.resolve();await Promise.resolve();
    now=60001;
    for(const timer of timers.values())if(timer.at<=now)timer.fn();
    assert.equal(killed,false);
    assert.equal(request.timeout_ms,120000);
    const deadline=[...timers.values()][0];
    assert.ok(deadline.at>120000*(retry+1));
    now=deadline.at;deadline.fn();
    assert.match((await result).message,/unknown/);
    assert.equal(killed,true);
  });
}
