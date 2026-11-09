"use strict";

(function installLinkrBleTransport(root) {
  const browserDevices = new Map();
  let browserSession = null;

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

  function sessionChangedError() {
    const error = new Error("Bluetooth connection changed; GATT operation cancelled");
    error.code = "BLE_SESSION_CHANGED";
    return error;
  }

  function assertSession(session) {
    session?.controller.signal.throwIfAborted();
    if (!session || browserSession !== session) throw sessionChangedError();
  }

  function retireSession(session, { disconnect = false, notify = false, reason } = {}) {
    if (!session || session.controller.signal.aborted) return;
    if (browserSession === session) browserSession = null;
    session.controller.abort(reason || sessionChangedError());
    session.device.removeEventListener("gattserverdisconnected", session.onDisconnect);
    for (const { characteristic, listener } of session.subscriptions.values()) {
      characteristic.removeEventListener("characteristicvaluechanged", listener);
    }
    session.subscriptions.clear();
    session.characteristics.clear();
    if (disconnect && session.device.gatt.connected) session.device.gatt.disconnect();
    if (notify) session.notifyDisconnect?.(session.device.id);
  }

  // Browser GATT promises cannot be aborted directly. Reject their callers on
  // teardown without waiting for the browser, and still observe late results.
  function inSession(session, operation) {
    assertSession(session);
    return new Promise((resolve, reject) => {
      const signal = session.controller.signal;
      const finish = (callback, value) => {
        signal.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => finish(reject, signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => {
        assertSession(session);
        return operation();
      }).then((value) => {
        try {
          assertSession(session);
          finish(resolve, value);
        } catch (error) {
          finish(reject, error);
        }
      }, (error) => finish(reject, error));
    });
  }

  async function connectServer(session) {
    return inSession(session, async () => {
      const server = await session.device.gatt.connect();
      if (browserSession !== session || session.controller.signal.aborted) {
        // A late connect must not keep an abandoned device connected, or tear
        // down a newer connection that reused the same BluetoothDevice.
        if (browserSession?.device !== session.device && session.device.gatt.connected) {
          session.device.gatt.disconnect();
        }
        assertSession(session);
      }
      session.server = server;
    });
  }

  async function getBrowserCharacteristic(session, serviceUuid, characteristicUuid) {
    assertSession(session);
    if (!session.server?.connected) throw new Error("Bluetooth device is not connected");
    const key = characteristicKey(serviceUuid, characteristicUuid);
    let characteristic = session.characteristics.get(key);
    if (!characteristic) {
      const service = await session.server.getPrimaryService(serviceUuid);
      assertSession(session);
      characteristic = await service.getCharacteristic(characteristicUuid);
      assertSession(session);
      session.characteristics.set(key, characteristic);
    }
    return characteristic;
  }

  /* Web Bluetooth runs one GATT procedure at a time per device. Starting a
   * second read, write or subscribe before the previous promise settles
   * rejects with "GATT operation already in progress". The application keeps
   * independent queues for UART bytes and management frames, and connection
   * setup also subscribes, so every GATT call uses the connection's chain.
   * Capture the session when enqueuing: old work must never reach a new link,
   * even when reconnecting to the same device. Rejections release the chain. */
  function withGattLock(deviceId, operation) {
    const session = browserSession;
    assertSession(session);
    if (session.device.id !== deviceId) throw sessionChangedError();
    const run = session.chain.then(() => inSession(session, () => operation(session)));
    session.chain = run.then(
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
      retireSession(browserSession, { disconnect: true });
      const session = {
        device,
        server: null,
        controller: new AbortController(),
        chain: Promise.resolve(),
        characteristics: new Map(),
        subscriptions: new Map(),
        notifyDisconnect: onDisconnect,
        onDisconnect: () => {
          if (browserSession === session) retireSession(session, { notify: true });
        },
      };
      browserSession = session;
      device.addEventListener("gattserverdisconnected", session.onDisconnect);
      const onAbort = () => retireSession(session, { disconnect: true, reason: signal.reason });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        try {
          await connectServer(session);
        } catch (error) {
          assertSession(session);
          if (!needsRediscovery(error)) throw error;
          try {
            await rediscover(device, session.controller.signal);
            assertSession(session);
          } catch (_discoveryError) {
            assertSession(session);
            const unavailable = new Error(error.message);
            unavailable.code = "BLE_RESELECT_REQUIRED";
            throw unavailable;
          }
          try {
            await connectServer(session);
          } catch (retryError) {
            assertSession(session);
            if (needsRediscovery(retryError)) {
              const unavailable = new Error(retryError.message);
              unavailable.code = "BLE_RESELECT_REQUIRED";
              throw unavailable;
            }
            throw retryError;
          }
        }
        assertSession(session);
      } catch (error) {
        retireSession(session, { disconnect: true });
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    async disconnect(deviceId) {
      if (browserSession?.device.id === deviceId) {
        retireSession(browserSession, { disconnect: true, notify: true });
      }
    },

    isConnected() {
      return Boolean(browserSession?.device.gatt.connected && browserSession.server?.connected);
    },

    async read(deviceId, serviceUuid, characteristicUuid) {
      return withGattLock(deviceId, async (session) => {
        const characteristic = await getBrowserCharacteristic(
          session,
          serviceUuid,
          characteristicUuid,
        );
        assertSession(session);
        return copyDataView(await characteristic.readValue());
      });
    },

    async write(
      deviceId,
      serviceUuid,
      characteristicUuid,
      value,
      withResponse = true,
    ) {
      return withGattLock(deviceId, async (session) => {
        const characteristic = await getBrowserCharacteristic(
          session,
          serviceUuid,
          characteristicUuid,
        );
        assertSession(session);
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
      deviceId,
      serviceUuid,
      characteristicUuid,
      callback,
    ) {
      return withGattLock(deviceId, async (session) => {
        const characteristic = await getBrowserCharacteristic(
          session,
          serviceUuid,
          characteristicUuid,
        );
        assertSession(session);
        const key = characteristicKey(serviceUuid, characteristicUuid);
        const previous = session.subscriptions.get(key);
        if (previous) {
          previous.characteristic.removeEventListener(
            "characteristicvaluechanged",
            previous.listener,
          );
        }
        const listener = (event) => {
          if (browserSession === session && !session.controller.signal.aborted) {
            callback(copyBytes(event.target.value));
          }
        };
        session.subscriptions.set(key, { characteristic, listener });
        characteristic.addEventListener(
          "characteristicvaluechanged",
          listener,
        );
        try {
          await characteristic.startNotifications();
        } catch (error) {
          characteristic.removeEventListener("characteristicvaluechanged", listener);
          session.subscriptions.delete(key);
          throw error;
        }
      });
    },

    async stopNotifications(deviceId, serviceUuid, characteristicUuid) {
      return withGattLock(deviceId, async (session) => {
        const key = characteristicKey(serviceUuid, characteristicUuid);
        const characteristic = session.characteristics.get(key);
        if (!characteristic) {
          return;
        }
        const subscription = session.subscriptions.get(key);
        if (subscription) {
          characteristic.removeEventListener(
            "characteristicvaluechanged",
            subscription.listener,
          );
        }
        session.subscriptions.delete(key);
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
