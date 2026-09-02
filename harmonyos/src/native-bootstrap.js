"use strict";

if (typeof document !== "undefined") {
  document.documentElement.dataset.platform = "harmonyos";
}

const REQUEST_TIMEOUT_MS = 30000;
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
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`HarmonyOS BLE request timed out: ${method}`));
    }, REQUEST_TIMEOUT_MS);
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
