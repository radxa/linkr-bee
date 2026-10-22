import { BleClient } from "@capacitor-community/bluetooth-le";
import { Capacitor } from "@capacitor/core";

type DeviceDescriptor = { id: string; name: string };
type RequestDeviceOptions = {
  filters?: Array<{ services?: string[]; namePrefix?: string }>;
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

  /* Only a successful initialization may stay cached. Caching a rejected
   * promise would poison every later BLE call: one transient failure (adapter
   * off, a permission race) would leave the app unable to connect until it is
   * killed. */
  const ensureInitialized = (): Promise<void> => {
    if (initializePromise) {
      return initializePromise;
    }
    let guarded: Promise<void>;
    const attempt: Promise<void> = BleClient.initialize({
      androidNeverForLocation: true,
    });
    guarded = attempt.catch((error: unknown) => {
      if (initializePromise === guarded) {
        initializePromise = null;
      }
      throw error;
    });
    initializePromise = guarded;
    return guarded;
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
      const namePrefixes = Array.from(
        new Set(options.filters?.flatMap((filter) => filter.namePrefix || []) || []),
      );
      /* The plugin takes one filter shape, while Web Bluetooth takes an OR of
       * several. Prefer the service filter when the caller supplied one: it
       * finds every current board regardless of how the owner renamed it,
       * including Chinese and emoji names. The name prefixes remain a fallback
       * for callers that only have names (the oldest NUS-only firmware is
       * discoverable through the Web/TUI clients, which can scan both). */
      const filter = services.length
        ? { services }
        : { namePrefix: namePrefixes[0] || "Linkr BLE UART" };
      const device = await BleClient.requestDevice({
        ...filter,
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
      try {
        // Android exposes explicit bonding; iOS negotiates it when the first
        // encrypted characteristic is read. Never remove an existing bond.
        if (Capacitor.getPlatform() === "android" && !(await BleClient.isBonded(deviceId))) {
          await BleClient.createBond(deviceId, { timeout: 60000 });
        }
        if (connectedDeviceId !== deviceId) throw new Error("Bluetooth disconnected during pairing");
      } catch (error) {
        await BleClient.disconnect(deviceId).catch(() => {});
        connectedDeviceId = null;
        throw error;
      }
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
      return BleClient.read(deviceId, serviceUuid, characteristicUuid, { timeout: 60000 });
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

// Install the native backend synchronously. app.js reads window.LinkrNativeBle
// while its module body runs (platform detection, support text), and that runs
// before any microtask. Deferring the assignment to a promise callback made
// those reads fall back to the web backend and misreport the platform.
if (Capacitor.isNativePlatform()) {
  window.LinkrNativeBle = createNativeBleBackend();
}
window.LinkrNativeBleReady = Promise.resolve();
