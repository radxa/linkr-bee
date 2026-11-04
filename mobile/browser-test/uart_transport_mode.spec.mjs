import { test, expect } from '@playwright/test';

async function open(page, preference) {
  if (preference) await page.addInitScript(value => localStorage.setItem('linkr-uart-mode', value), preference);
  await page.route('**/app.js?*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + '\nwindow.__uartMode = { state, connect, disconnect, onDisconnected, bleTransport, enqueueBytes, agentJournal, setSettingsPage, setMobileSidebarOpen, setTransportMode, renderUartMode, setControl: fn => { sendControl = fn; } };' });
  });
  await page.goto('/');
  await page.waitForFunction(() => window.__uartMode?.state.term);
  await page.evaluate(() => {
    window.__uartMode.setSettingsPage('terminal');
    window.__uartMode.setMobileSidebarOpen(true);
  });
}

async function board(page, { caps = 40, failReliable = false, failNus = false, delayNus = false, initialNus = "" } = {}) {
  await page.evaluate(options => {
    const c = window.__uartMode;
    window.uartWrites = []; window.uartSubscriptions = []; window.uartStopped = [];
    window.uartCallbacks = {}; window.uartReads = [];
    Object.assign(c.bleTransport, {
      isAvailable: () => true, initialize: async () => {},
      requestDevice: async () => ({ id: 'test-uart', name: 'Linkr Bee UART test' }),
      connect: async () => {}, disconnect: async () => {}, isConnected: () => true,
      read: async (_id, _service, characteristic) => {
        window.uartReads.push(characteristic);
        if (characteristic.startsWith('4c4b0002')) return new DataView(new Uint8Array([1,0,0,2,options.caps,0,0,0,0,0]).buffer);
        if (characteristic.startsWith('4c4b0003')) return new DataView(new Uint8Array([0x4c,0x49,0x4e,0x4b,0x52,0x42,0x4c,0x45,1,0,0,0,0,0,0,1]).buffer);
        if (characteristic.startsWith('4c4b0013')) return new DataView(new Uint8Array([1,0,232,0,1,0,0,0,1,0,0,0,0,0,0,0]).buffer);
        throw new Error('Unexpected read: ' + characteristic);
      },
      write: async (_id, service, characteristic, bytes, withResponse) => window.uartWrites.push({ service, bytes: [...bytes], withResponse }),
      startNotifications: async (_id, service, characteristic, callback) => {
        window.uartSubscriptions.push(characteristic); window.uartCallbacks[characteristic] = callback;
        if (characteristic.startsWith('4c4b0012') && options.failReliable) throw new Error('Reliable subscription unavailable');
        if (characteristic.startsWith('6e400003')) {
          if (options.failNus) throw new Error('NUS subscription unavailable');
          if (options.initialNus) callback(new TextEncoder().encode(options.initialNus));
          if (options.delayNus) await new Promise(resolve => { window.releaseUart = resolve; });
        }
      },
      stopNotifications: async (_id, _service, characteristic) => window.uartStopped.push(characteristic),
    });
    c.setControl(async () => 'OK');
  }, { caps, failReliable, failNus, delayNus, initialNus });
}

async function connect(page) {
  await page.evaluate(() => window.__uartMode.connect());
  expect(await page.evaluate(() => window.__uartMode.state.connected)).toBe(true);
}

test('default interactive mode subscribes only to NUS and writes without responses', async ({ page }) => {
  await open(page); await board(page); await connect(page);
  const result = await page.evaluate(async () => {
    const c=window.__uartMode; await c.enqueueBytes(new Uint8Array(232).fill(65));
    return { mode:c.state.uartMode, active:c.state.nusReady, reliable:c.state.reliableReady,
      subscriptions:window.uartSubscriptions, writes:window.uartWrites };
  });
  expect(result.mode).toBe('interactive'); expect(result.active).toBe(true); expect(result.reliable).toBe(false);
  expect(result.subscriptions.filter(x=>x.startsWith('4c4b0012'))).toHaveLength(0);
  expect(result.writes).toHaveLength(12);
  expect(result.writes.every(x=>!x.withResponse && x.service.startsWith('6e400001'))).toBe(true);
  await expect(page.locator('#uartTransportStatus')).toContainText('NUS');
});

test('saved reliable preference subscribes only to reliable and uses confirmed frames', async ({ page }) => {
  await open(page,'reliable'); await board(page); await connect(page);
  const result=await page.evaluate(async()=>{
    const c=window.__uartMode; await c.enqueueBytes(new Uint8Array(232).fill(65));
    return { subscriptions:window.uartSubscriptions, writes:window.uartWrites, sequence:c.state.reliableTxSequence };
  });
  expect(result.subscriptions.some(x=>x.startsWith('6e400003'))).toBe(false);
  expect(result.writes).toHaveLength(13); expect(result.writes.every(x=>x.withResponse)).toBe(true);
  expect(result.sequence).toBe(2);
  await expect(page.locator('#uartModeSelect')).toHaveValue('reliable');
  await expect(page.locator('#uartTransportStatus')).toContainText('Reliable UART');
});

test('changing a connected mode preserves the stream and applies after reconnect', async ({ page }) => {
  await open(page); await board(page); await connect(page);
  await page.evaluate(()=>{ window.oldUartCallback=Object.entries(window.uartCallbacks).find(([k])=>k.startsWith('6e400003'))[1]; });
  await page.locator('#uartModeSelect').selectOption('reliable');
  await expect(page.locator('#uartTransportStatus')).toContainText(/next BLE|下次 BLE/);
  const first=await page.evaluate(async()=>{
    const c=window.__uartMode;await c.enqueueBytes(new Uint8Array([65]));
    return { active:c.state.nusReady,saved:localStorage.getItem('linkr-uart-mode'),writes:window.uartWrites };
  });
  expect(first.active).toBe(true); expect(first.saved).toBe('reliable'); expect(first.writes[0].withResponse).toBe(false);
  await page.evaluate(async()=>{await window.__uartMode.disconnect();await window.__uartMode.connect();});
  expect(await page.evaluate(()=>window.__uartMode.state.reliableReady)).toBe(true);
  expect(await page.evaluate(()=>{const c=window.__uartMode;const before=c.state.rxBytes;window.oldUartCallback(new Uint8Array([65]));return c.state.rxBytes-before;})).toBe(0);
  await expect(page.locator('#uartTransportStatus')).not.toContainText(/next BLE|下次 BLE/);
});

test('failed reliable subscription falls back to NUS and retires its callback', async ({ page }) => {
  await open(page,'reliable'); await board(page,{failReliable:true}); await connect(page);
  const result=await page.evaluate(()=>{
    const c=window.__uartMode; const before=c.state.rxBytes;
    const key=Object.keys(window.uartCallbacks).find(k=>k.startsWith('4c4b0012'));
    window.uartCallbacks[key](new Uint8Array([0x4c,0x52,1,0,1,0,0,0,1,0,0,0,65]));
    return { fallback:c.state.uartFallback,nus:c.state.nusReady,received:c.state.rxBytes-before,stopped:window.uartStopped };
  });
  expect(result.fallback).toBe(true); expect(result.nus).toBe(true);expect(result.received).toBe(0);
  expect(result.stopped.some(x=>x.startsWith('4c4b0012'))).toBe(true);
  await expect(page.locator('#uartTransportStatus')).toContainText(/unavailable|不可用/);
});

test('failed NUS subscription can use a supported reliable channel', async ({ page }) => {
  await open(page); await board(page,{failNus:true}); await connect(page);
  expect(await page.evaluate(()=>window.__uartMode.state.reliableReady)).toBe(true);
  await expect(page.locator('#uartTransportStatus')).toContainText('Reliable UART');
  await expect(page.locator('#uartTransportStatus')).toContainText(/unavailable|不可用/);
});

test('unknown capability bits cannot grant a UART transport',async({page})=>{
  // Bit 6 was never assigned by the firmware. A Management-capable board
  // must advertise Device ID and Reliable UART; an unknown bit cannot stand
  // in for either. Legacy NUS without Management is tested separately below.
  await open(page,'reliable');await board(page,{caps:8|64});
  await page.evaluate(()=>window.__uartMode.connect());
  expect(await page.evaluate(()=>window.__uartMode.state.connected)).toBe(false);
  await expect(page.locator('#uartTransportStatus')).toBeHidden();
  expect(await page.evaluate(()=>window.uartSubscriptions.some(x=>x.startsWith('6e400003')))).toBe(false);
  expect(await page.evaluate(()=>localStorage.getItem('linkr-uart-mode'))).toBe('reliable');
});

test('unknown capability bits do not override the supported reliable preference',async({page})=>{
  await open(page,'reliable');await board(page,{caps:8|32|64});await connect(page);
  await expect(page.locator('#uartModeField')).toBeVisible();
  await expect(page.locator('#uartModeSelect')).toHaveValue('reliable');
  await expect(page.locator('#uartTransportStatus')).toContainText('Reliable UART');
  expect(await page.evaluate(()=>window.uartReads.some(x=>x.startsWith('4c4b0013')))).toBe(true);
  expect(await page.evaluate(()=>window.uartSubscriptions.some(x=>x.startsWith('6e400003')))).toBe(false);
});

test('mode changes during handshake are deferred to the next session',async({page})=>{
  await open(page);await board(page,{delayNus:true});
  await page.evaluate(()=>{window.connectingUart=window.__uartMode.connect();});
  await page.waitForFunction(()=>typeof window.releaseUart==='function');
  await page.locator('#uartModeSelect').selectOption('reliable');
  await page.evaluate(async()=>{window.releaseUart();await window.connectingUart;});
  expect(await page.evaluate(()=>window.__uartMode.state.nusReady)).toBe(true);
  await expect(page.locator('#uartTransportStatus')).toContainText(/next BLE|下次 BLE/);
});

test('failure of both channels leaves UART disconnected',async({page})=>{
  await open(page);await board(page,{failNus:true,failReliable:true});
  await page.evaluate(()=>window.__uartMode.connect());
  const state=await page.evaluate(()=>({connected:window.__uartMode.state.connected,nus:window.__uartMode.state.nusReady,reliable:window.__uartMode.state.reliableReady}));
  expect(state).toEqual({connected:false,nus:false,reliable:false});
  await expect(page.locator('#uartTransportStatus')).toBeHidden();
});

test('LAN hides BLE-only settings while retaining the preference',async({page})=>{
  await open(page,'reliable');
  await page.evaluate(()=>window.__uartMode.setTransportMode('ws'));
  await expect(page.locator('#uartModeField')).toBeHidden();
  expect(await page.evaluate(()=>localStorage.getItem('linkr-uart-mode'))).toBe('reliable');
});


test('legacy NUS firmware retains terminal access and hides unsupported mode choice',async({page})=>{
  await open(page,'reliable');await board(page);
  await page.evaluate(()=>{window.__uartMode.bleTransport.read=async()=>{
    const error=new Error('No Services matching UUID found');error.name='NotFoundError';throw error;
  };});
  await connect(page);
  expect(await page.evaluate(()=>window.__uartMode.state.legacy)).toBe(true);
  await expect(page.locator('#uartModeField')).toBeHidden();
  await expect(page.locator('#uartTransportStatus')).toContainText('NUS');
});


test('NUS output received before subscription resolves survives the handshake',async({page})=>{
  await open(page);await board(page,{initialNus:'early boot\r\n'});await connect(page);
  expect(await page.evaluate(()=>window.__uartMode.agentJournal.read().text)).toBe('early boot\r\n');
  expect(await page.evaluate(()=>window.__uartMode.state.rxBytes)).toBe(12);
});

test('a saved mode survives page reload without a live device',async({page})=>{
  await open(page);
  await page.locator('#uartModeSelect').selectOption('reliable');
  await page.reload();await page.waitForFunction(()=>window.__uartMode?.state.term);
  expect(await page.evaluate(()=>window.__uartMode.state.uartMode)).toBe('reliable');
});


test('a retired subscription failure neither cleans up nor falls back on the next session',async({page})=>{
  await open(page);await board(page);
  const result=await page.evaluate(async()=>{
    const c=window.__uartMode,start=c.bleTransport.startNotifications;
    c.bleTransport.startNotifications=async(...args)=>{
      await start(...args);
      if(args[2].startsWith('6e400003')){
        c.onDisconnected();throw new Error('Retired subscription failed late');
      }
    };
    await c.connect();
    return { stopped:window.uartStopped,subscriptions:window.uartSubscriptions,connected:c.state.connected };
  });
  expect(result.connected).toBe(false);expect(result.stopped).toEqual([]);
  expect(result.subscriptions.some(x=>x.startsWith('4c4b0012'))).toBe(false);
});
