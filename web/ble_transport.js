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

    async getDevices() {
      if (!root.navigator?.bluetooth?.getDevices) {
        return [];
      }
      const devices = await root.navigator.bluetooth.getDevices();
      return devices.map(describeBrowserDevice);
    },

    async connect(deviceId, onDisconnect) {
      const device = browserDevices.get(deviceId);
      if (!device) {
        throw new Error("Bluetooth device authorization is unavailable");
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
      browserServer = await device.gatt.connect();
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
      const characteristic = await getBrowserCharacteristic(
        serviceUuid,
        characteristicUuid,
      );
      return copyDataView(await characteristic.readValue());
    },

    async write(
      _deviceId,
      serviceUuid,
      characteristicUuid,
      value,
      withResponse = true,
    ) {
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
    },

    async startNotifications(
      _deviceId,
      serviceUuid,
      characteristicUuid,
      callback,
    ) {
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
      characteristic.addEventListener("characteristicvaluechanged", listener);
      await characteristic.startNotifications();
    },

    async stopNotifications(_deviceId, serviceUuid, characteristicUuid) {
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

    async connect(deviceId, onDisconnect) {
      return (await backend()).connect(deviceId, onDisconnect);
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
