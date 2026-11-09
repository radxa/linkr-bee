"use strict";

(function installLinkrBleTransport(root) {
  const browserDevices = new Map();
  const browserCharacteristics = new Map();
  const browserSubscriptions = new Map();
  let browserServer = null;
  let browserDevice = null;
  let browserDisconnectHandler = null;

  function copyDataView(value) {
    if (value instanceof DataView) {
      return new DataView(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      );
    }
    if (value instanceof Uint8Array) {
      return new DataView(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      );
    }
    if (value instanceof ArrayBuffer) {
      return new DataView(value.slice(0));
    }
    if (Array.isArray(value)) {
      return new DataView(Uint8Array.from(value).buffer);
    }
    throw new TypeError("BLE value must be binary data");
  }

  function copyBytes(value) {
    const view = copyDataView(value);
    return new Uint8Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    );
  }

  function describeBrowserDevice(device) {
    browserDevices.set(device.id, device);
    return { id: device.id, name: device.name || "" };
  }

  function needsRediscovery(error) {
    return /Bluetooth Device is no longer in range|Bluetooth device authorization is unavailable/i.test(error?.message || "");
  }

  // Refresh the OS discovery entry for this authorized device only. Watching
  // advertisements is optional in browsers, so keep a bounded chooser fallback.
  function rediscover(device, signal) {
    signal?.throwIfAborted();
    if (typeof device.watchAdvertisements !== "function") {
      return Promise.reject(new Error("Advertisement watching unavailable"));
    }
    return new Promise((resolve, reject) => {
      const watcher = new AbortController();
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        device.removeEventListener("advertisementreceived", onAdvertisement);
        signal?.removeEventListener("abort", onAbort);
        watcher.abort();
        if (error) reject(error);
        else resolve();
      };
      const onAdvertisement = (event) => {
        if (event.device?.id === device.id) finish();
      };
      const onAbort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(new Error("Advertisement discovery timed out")), 8000);
      device.addEventListener("advertisementreceived", onAdvertisement);
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => {
        if (!settled) return device.watchAdvertisements({ signal: watcher.signal });
      }).catch(finish);
    });
  }

  function characteristicKey(serviceUuid, characteristicUuid) {
    return `${serviceUuid.toLowerCase()}/${characteristicUuid.toLowerCase()}`;
  }

  async function getBrowserCharacteristic(serviceUuid, characteristicUuid) {
    if (!browserServer?.connected) {
      throw new Error("Bluetooth device is not connected");
    }
    const key = characteristicKey(serviceUuid, characteristicUuid);
    let characteristic = browserCharacteristics.get(key);
    if (!characteristic) {
      const service = await browserServer.getPrimaryService(serviceUuid);
      characteristic = await service.getCharacteristic(characteristicUuid);
      browserCharacteristics.set(key, characteristic);
    }
    return characteristic;
  }

  /* Web Bluetooth runs one GATT procedure at a time per device. Starting a
   * second read, write or subscribe before the previous promise settles
   * rejects with "GATT operation already in progress". The application keeps
   * independent queues for UART bytes and management frames, and connection
   * setup also subscribes, so every GATT call funnels through this single
   * chain instead of racing. A rejected operation still releases the chain so
   * one failed write cannot wedge the transport. */
  let browserGattChain = Promise.resolve();

  function withGattLock(operation) {
    const run = browserGattChain.then(operation, operation);
    browserGattChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const browserBackend = {
    platform: "web",

    isAvailable() {
      return Boolean(root.navigator?.bluetooth);
    },

    async initialize() {},

    async requestDevice(options) {
      if (!root.navigator?.bluetooth) {
        throw new Error("Web Bluetooth is not available in this browser");
      }
      const device = await root.navigator.bluetooth.requestDevice(options);
      return describeBrowserDevice(device);
    },

    async getDevices(deviceIds = []) {
      if (!root.navigator?.bluetooth?.getDevices) {
        return [];
      }
      const wanted = new Set(deviceIds);
      const devices = await root.navigator.bluetooth.getDevices();
      return devices
        .map(describeBrowserDevice)
        .filter((device) => wanted.size === 0 || wanted.has(device.id));
    },

    /* Web Bluetooth has no headless scan: requestLEScan only reports
     * advertisements for devices the user already picked, and a page cannot
     * list nearby devices without the browser's device chooser. */
    async scanDevices() {
      throw new Error("BLE scanning is not available on this platform");
    },

    async connect(deviceId, onDisconnect, { signal } = {}) {
      signal?.throwIfAborted();
      const device = browserDevices.get(deviceId);
      if (!device) {
        const error = new Error("Bluetooth device authorization is unavailable");
        error.code = "BLE_RESELECT_REQUIRED";
        throw error;
      }
      if (browserDevice && browserDisconnectHandler) {
        browserDevice.removeEventListener(
          "gattserverdisconnected",
          browserDisconnectHandler,
        );
      }
      browserDevice = device;
      browserDisconnectHandler = () => {
        browserServer = null;
        browserCharacteristics.clear();
        browserSubscriptions.clear();
        onDisconnect?.(device.id);
      };
      device.addEventListener(
        "gattserverdisconnected",
        browserDisconnectHandler,
      );
      /* A reconnect can reuse the same BluetoothDevice object. Any
       * characteristic cached from the previous GATT server is stale even
       * though this new server is connected; subscribing to it resolves but
       * never delivers values. Drop the caches before every connect so the
       * management and NUS characteristics both come from this server. */
      browserCharacteristics.clear();
      browserSubscriptions.clear();
      try {
        browserServer = await device.gatt.connect();
      } catch (error) {
        if (signal?.aborted || !needsRediscovery(error)) throw error;
        try {
          await rediscover(device, signal);
          signal?.throwIfAborted();
        } catch (discoveryError) {
          if (signal?.aborted) throw signal.reason;
          const unavailable = new Error(error.message);
          unavailable.code = "BLE_RESELECT_REQUIRED";
          throw unavailable;
        }
        try {
          browserServer = await device.gatt.connect();
        } catch (retryError) {
          if (needsRediscovery(retryError)) {
            const unavailable = new Error(retryError.message);
            unavailable.code = "BLE_RESELECT_REQUIRED";
            throw unavailable;
          }
          throw retryError;
        }
      }
    },

    async disconnect() {
      if (browserDevice?.gatt?.connected) {
        browserDevice.gatt.disconnect();
      }
    },

    isConnected() {
      return Boolean(browserDevice?.gatt?.connected && browserServer?.connected);
    },

    async read(_deviceId, serviceUuid, characteristicUuid) {
      return withGattLock(async () => {
        const characteristic = await getBrowserCharacteristic(
          serviceUuid,
          characteristicUuid,
        );
        return copyDataView(await characteristic.readValue());
      });
    },

    async write(
      _deviceId,
      serviceUuid,
      characteristicUuid,
      value,
      withResponse = true,
    ) {
      return withGattLock(async () => {
        const characteristic = await getBrowserCharacteristic(
          serviceUuid,
          characteristicUuid,
        );
        const bytes = copyBytes(value);
        if (!withResponse && characteristic.writeValueWithoutResponse) {
          await characteristic.writeValueWithoutResponse(bytes);
        } else if (characteristic.writeValueWithResponse) {
          await characteristic.writeValueWithResponse(bytes);
        } else {
          await characteristic.writeValue(bytes);
        }
      });
    },

    async startNotifications(
      _deviceId,
      serviceUuid,
      characteristicUuid,
      callback,
    ) {
      return withGattLock(async () => {
        const characteristic = await getBrowserCharacteristic(
          serviceUuid,
          characteristicUuid,
        );
        const key = characteristicKey(serviceUuid, characteristicUuid);
        const previous = browserSubscriptions.get(key);
        if (previous) {
          characteristic.removeEventListener(
            "characteristicvaluechanged",
            previous,
          );
        }
        const listener = (event) => callback(copyBytes(event.target.value));
        browserSubscriptions.set(key, listener);
        characteristic.addEventListener(
          "characteristicvaluechanged",
          listener,
        );
        await characteristic.startNotifications();
      });
    },

    async stopNotifications(_deviceId, serviceUuid, characteristicUuid) {
      return withGattLock(async () => {
        const key = characteristicKey(serviceUuid, characteristicUuid);
        const characteristic = browserCharacteristics.get(key);
        if (!characteristic) {
          return;
        }
        const listener = browserSubscriptions.get(key);
        if (listener) {
          characteristic.removeEventListener(
            "characteristicvaluechanged",
            listener,
          );
        }
        browserSubscriptions.delete(key);
        await characteristic.stopNotifications();
      });
    },
  };

  async function nativeBackend() {
    if (root.LinkrNativeBleReady) {
      await root.LinkrNativeBleReady;
    }
    return root.LinkrNativeBle || null;
  }

  async function backend() {
    return (await nativeBackend()) || browserBackend;
  }

  const transport = {
    platform() {
      return root.LinkrNativeBle?.platform || browserBackend.platform;
    },

    isAvailable() {
      return Boolean(
        root.LinkrNativeBle ||
          root.LinkrNativeBleReady ||
          browserBackend.isAvailable(),
      );
    },

    async initialize() {
      return (await backend()).initialize();
    },

    async requestDevice(options) {
      return (await backend()).requestDevice(options);
    },

    async getDevices(deviceIds = []) {
      return (await backend()).getDevices(deviceIds);
    },

    async scanDevices(options) {
      return (await backend()).scanDevices(options);
    },

    async connect(deviceId, onDisconnect, options) {
      return (await backend()).connect(deviceId, onDisconnect, options);
    },

    async disconnect(deviceId) {
      return (await backend()).disconnect(deviceId);
    },

    async isConnected() {
      return Boolean(await (await backend()).isConnected());
    },

    async read(deviceId, serviceUuid, characteristicUuid) {
      return copyDataView(
        await (await backend()).read(deviceId, serviceUuid, characteristicUuid),
      );
    },

    async write(
      deviceId,
      serviceUuid,
      characteristicUuid,
      value,
      withResponse = true,
    ) {
      return (await backend()).write(
        deviceId,
        serviceUuid,
        characteristicUuid,
        copyBytes(value),
        withResponse,
      );
    },

    async startNotifications(
      deviceId,
      serviceUuid,
      characteristicUuid,
      callback,
    ) {
      return (await backend()).startNotifications(
        deviceId,
        serviceUuid,
        characteristicUuid,
        (value) => callback(copyBytes(value)),
      );
    },

    async stopNotifications(deviceId, serviceUuid, characteristicUuid) {
      return (await backend()).stopNotifications(
        deviceId,
        serviceUuid,
        characteristicUuid,
      );
    },
  };

  root.LinkrBleTransport = transport;
})(window);
