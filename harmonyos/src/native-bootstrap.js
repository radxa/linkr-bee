"use strict";

if (typeof document !== "undefined") {
  document.documentElement.dataset.platform = "harmonyos";
}

/* Client-side deadlines, per method.
 *
 * Anything that waits on a human must outlast any plausible decision time: the
 * host only settles requestDevice after the user answers the "Select Linkr Bee"
 * menu, and initialize after the Bluetooth permission prompt. A single short
 * deadline for those made the page abandon a selection that was still open on
 * screen. Host-only methods just cover the host's own internal budget; keep the
 * connect value above HOST_CONNECT_WORST_CASE_MS in
 * harmonyos/entry/src/main/ets/bridge/LinkrBleHost.ets so the page never gives
 * up on a connect the radio is still completing. harmonyos/BRIDGE_PROTOCOL.md
 * documents the same table for host implementers; keep the two in step. */
const REQUEST_TIMEOUT_MS = 30000;
const INTERACTIVE_TIMEOUT_MS = 180000;
const METHOD_TIMEOUTS = {
  initialize: INTERACTIVE_TIMEOUT_MS,
  requestDevice: INTERACTIVE_TIMEOUT_MS,
  connect: 120000,
};
const timeoutFor = (method) =>
  METHOD_TIMEOUTS[method] || REQUEST_TIMEOUT_MS;
const pending = new Map();
const notificationCallbacks = new Map();
const disconnectCallbacks = new Map();
let nextRequestId = 1;
let connectedDeviceId = null;

function callbackKey(deviceId, serviceUuid, characteristicUuid) {
  return [deviceId, serviceUuid, characteristicUuid]
    .map((part) => String(part).toLowerCase())
    .join("/");
}

function clearDeviceCallbacks(deviceId) {
  const prefix = `${String(deviceId).toLowerCase()}/`;
  for (const key of notificationCallbacks.keys()) {
    if (key.startsWith(prefix)) {
      notificationCallbacks.delete(key);
    }
  }
  disconnectCallbacks.delete(deviceId);
}

function rejectDeviceRequests(deviceId) {
  for (const [id, request] of pending.entries()) {
    if (request.deviceId !== deviceId) {
      continue;
    }
    pending.delete(id);
    clearTimeout(request.timeoutId);
    request.reject(new Error("Bluetooth device disconnected"));
  }
}

function hostCall(method, args = {}) {
  const host = window.linkrBleHost;
  if (!host || typeof host.postMessage !== "function") {
    return Promise.reject(new Error("HarmonyOS BLE host is unavailable"));
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    // A host-side completion after this fires is still cleaned up by the
    // caller's disconnect path, so a timeout can never leave a stale link.
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`HarmonyOS BLE request timed out: ${method}`));
    }, timeoutFor(method));
    pending.set(id, {
      resolve,
      reject,
      timeoutId,
      deviceId: args.deviceId || null,
    });
    try {
      host.postMessage(JSON.stringify({ id, method, args }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

window.LinkrHarmonyBle = {
  resolve(id, result, error) {
    const request = pending.get(Number(id));
    if (!request) {
      return;
    }
    pending.delete(Number(id));
    clearTimeout(request.timeoutId);
    if (error) {
      request.reject(new Error(String(error)));
    } else {
      request.resolve(result);
    }
  },

  notify(deviceId, serviceUuid, characteristicUuid, value) {
    const callback = notificationCallbacks.get(
      callbackKey(deviceId, serviceUuid, characteristicUuid),
    );
    callback?.(Uint8Array.from(value || []));
  },

  notifyBatch(records) {
    for (const item of records || []) {
      window.LinkrHarmonyBle.notify(item.deviceId, item.serviceUuid, item.characteristicUuid, item.value);
    }
  },

  disconnected(deviceId) {
    const callback = disconnectCallbacks.get(deviceId);
    if (connectedDeviceId === deviceId) {
      connectedDeviceId = null;
    }
    rejectDeviceRequests(deviceId);
    clearDeviceCallbacks(deviceId);
    callback?.(deviceId);
  },
};

window.LinkrNativeBle = {
  platform: "harmonyos",

  isAvailable() {
    return Boolean(window.linkrBleHost?.postMessage);
  },

  initialize() {
    return hostCall("initialize");
  },

  requestDevice(options) {
    return hostCall("requestDevice", { options });
  },

  getDevices(deviceIds) {
    return hostCall("getDevices", { deviceIds });
  },

  async connect(deviceId, onDisconnect) {
    disconnectCallbacks.set(deviceId, onDisconnect);
    try {
      await hostCall("connect", { deviceId });
      connectedDeviceId = deviceId;
    } catch (error) {
      clearDeviceCallbacks(deviceId);
      throw error;
    }
  },

  async disconnect(deviceId) {
    await hostCall("disconnect", { deviceId });
    clearDeviceCallbacks(deviceId);
    if (connectedDeviceId === deviceId) {
      connectedDeviceId = null;
    }
  },

  isConnected() {
    return connectedDeviceId !== null;
  },

  async read(deviceId, serviceUuid, characteristicUuid) {
    const value = await hostCall("read", {
      deviceId,
      serviceUuid,
      characteristicUuid,
    });
    return new DataView(Uint8Array.from(value || []).buffer);
  },

  write(
    deviceId,
    serviceUuid,
    characteristicUuid,
    value,
    withResponse = true,
  ) {
    return hostCall("write", {
      deviceId,
      serviceUuid,
      characteristicUuid,
      value: Array.from(value),
      withResponse,
    });
  },

  async startNotifications(
    deviceId,
    serviceUuid,
    characteristicUuid,
    callback,
  ) {
    notificationCallbacks.set(
      callbackKey(deviceId, serviceUuid, characteristicUuid),
      callback,
    );
    try {
      await hostCall("startNotifications", {
        deviceId,
        serviceUuid,
        characteristicUuid,
      });
    } catch (error) {
      notificationCallbacks.delete(
        callbackKey(deviceId, serviceUuid, characteristicUuid),
      );
      throw error;
    }
  },

  async stopNotifications(deviceId, serviceUuid, characteristicUuid) {
    await hostCall("stopNotifications", {
      deviceId,
      serviceUuid,
      characteristicUuid,
    });
    notificationCallbacks.delete(
      callbackKey(deviceId, serviceUuid, characteristicUuid),
    );
  },
};

window.LinkrNativeUi = {
  setTheme(theme) {
    return hostCall("setSystemTheme", { theme });
  },
};

window.LinkrNativeBleReady = Promise.resolve();
