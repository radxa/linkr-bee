import { BleClient } from "@capacitor-community/bluetooth-le";
import { Capacitor } from "@capacitor/core";

type DeviceDescriptor = { id: string; name: string };
type RequestDeviceOptions = {
  filters?: Array<{ services?: string[] }>;
  optionalServices?: string[];
};

type NativeBleBackend = {
  platform: string;
  isAvailable(): boolean;
  initialize(): Promise<void>;
  requestDevice(options: RequestDeviceOptions): Promise<DeviceDescriptor>;
  getDevices(deviceIds: string[]): Promise<DeviceDescriptor[]>;
  connect(
    deviceId: string,
    onDisconnect?: (deviceId: string) => void,
  ): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  isConnected(): boolean;
  read(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<DataView>;
  write(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
    withResponse?: boolean,
  ): Promise<void>;
  startNotifications(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    callback: (value: Uint8Array) => void,
  ): Promise<void>;
  stopNotifications(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<void>;
};

declare global {
  interface Window {
    LinkrNativeBle?: NativeBleBackend;
    LinkrNativeBleReady?: Promise<void>;
  }
}

function copyBytes(value: DataView): Uint8Array {
  return new Uint8Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
}

function asDataView(value: Uint8Array): DataView {
  return new DataView(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
}

function deviceName(device: { name?: string; deviceId: string }): string {
  return device.name || device.deviceId;
}

function createNativeBleBackend(): NativeBleBackend {
  let initializePromise: Promise<void> | null = null;
  let connectedDeviceId: string | null = null;

  const ensureInitialized = () => {
    initializePromise ??= BleClient.initialize({
      androidNeverForLocation: true,
    });
    return initializePromise;
  };

  return {
    platform: Capacitor.getPlatform(),

    isAvailable() {
      return true;
    },

    initialize: ensureInitialized,

    async requestDevice(options) {
      await ensureInitialized();
      const services = Array.from(
        new Set(options.filters?.flatMap((filter) => filter.services || []) || []),
      );
      const device = await BleClient.requestDevice({
        services,
        optionalServices: options.optionalServices || [],
      });
      return { id: device.deviceId, name: deviceName(device) };
    },

    async getDevices(deviceIds) {
      if (!deviceIds.length) {
        return [];
      }
      await ensureInitialized();
      const devices = await BleClient.getDevices(deviceIds);
      return devices.map((device) => ({
        id: device.deviceId,
        name: deviceName(device),
      }));
    },

    async connect(deviceId, onDisconnect) {
      await ensureInitialized();
      await BleClient.connect(deviceId, (disconnectedId) => {
        if (connectedDeviceId === disconnectedId) {
          connectedDeviceId = null;
        }
        onDisconnect?.(disconnectedId);
      });
      connectedDeviceId = deviceId;
    },

    async disconnect(deviceId) {
      await BleClient.disconnect(deviceId);
      if (connectedDeviceId === deviceId) {
        connectedDeviceId = null;
      }
    },

    isConnected() {
      return connectedDeviceId !== null;
    },

    async read(deviceId, serviceUuid, characteristicUuid) {
      await ensureInitialized();
      return BleClient.read(deviceId, serviceUuid, characteristicUuid);
    },

    async write(
      deviceId,
      serviceUuid,
      characteristicUuid,
      value,
      withResponse = true,
    ) {
      await ensureInitialized();
      const data = asDataView(value);
      if (withResponse) {
        await BleClient.write(deviceId, serviceUuid, characteristicUuid, data);
      } else {
        await BleClient.writeWithoutResponse(
          deviceId,
          serviceUuid,
          characteristicUuid,
          data,
        );
      }
    },

    async startNotifications(
      deviceId,
      serviceUuid,
      characteristicUuid,
      callback,
    ) {
      await ensureInitialized();
      await BleClient.startNotifications(
        deviceId,
        serviceUuid,
        characteristicUuid,
        (value) => callback(copyBytes(value)),
      );
    },

    async stopNotifications(deviceId, serviceUuid, characteristicUuid) {
      await BleClient.stopNotifications(
        deviceId,
        serviceUuid,
        characteristicUuid,
      );
    },
  };
}

window.LinkrNativeBleReady = Promise.resolve().then(() => {
  if (Capacitor.isNativePlatform()) {
    window.LinkrNativeBle = createNativeBleBackend();
  }
});
