import {
  abilityAccessCtrl,
  common,
  Permissions,
} from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { promptAction, UIContext, window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { access, ble, constant } from '@kit.ConnectivityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

/* Matches EntryAbility: the domain shared by all Linkr Bee hilog records. */
const DOMAIN = 0x4C42;

const BLUETOOTH_PERMISSION: Permissions = 'ohos.permission.ACCESS_BLUETOOTH';
const MANAGEMENT_SERVICE = '4c4b0001-9a7e-4f4e-8b8a-3d6f12a0c001';
const SCAN_DURATION_MS = 3000;
const CONNECT_TIMEOUT_MS = 15000;
const MTU_TIMEOUT_MS = 1500;
const REQUESTED_MTU = 247;
/* Each runJavaScript is an asynchronous IPC into the ArkWeb renderer. A
 * 115200-baud console produces well over a hundred notifications per second, so
 * firing one evaluation per notification queues them faster than they retire
 * and the page falls behind. Coalesce everything that arrives while a call is
 * in flight into one evaluation instead. */
const NOTIFICATION_BATCH_BYTES = 4096;
/* Safety valve, not the normal path: if the renderer is stalled for a long time
 * the buffer is trimmed from the oldest end so memory stays bounded. This
 * mirrors the firmware's own UART ring behaviour. */
const NOTIFICATION_BUFFER_LIMIT = 131072;
/* Must stay comfortably above the host's worst case (scan + connect + MTU +
 * service discovery) so the page never abandons a connect the host is still
 * completing. harmonyos/src/native-bootstrap.js keeps the client-side value. */
const HOST_CONNECT_WORST_CASE_MS =
  SCAN_DURATION_MS + CONNECT_TIMEOUT_MS + MTU_TIMEOUT_MS + 5000;

interface PendingNotification {
  deviceId: string;
  serviceUuid: string;
  characteristicUuid: string;
  value: number[];
}

interface BridgeArgs {
  deviceId?: string;
  deviceIds?: Array<string>;
  serviceUuid?: string;
  characteristicUuid?: string;
  value?: Array<number>;
  withResponse?: boolean;
  theme?: string;
}

interface BridgeRequest {
  id: number;
  method: string;
  args: BridgeArgs;
}

interface DeviceDescriptor {
  id: string;
  name: string;
}

interface ScannedDevice extends DeviceDescriptor {
  rssi: number;
}

export class LinkrBleHost {
  private readonly controller: webview.WebviewController;
  private context: common.UIAbilityContext | null = null;
  private uiContext: UIContext | null = null;
  private knownDevices: Map<string, DeviceDescriptor> = new Map();
  private characteristics: Map<string, ble.BLECharacteristic> = new Map();
  private client: ble.GattClientDevice | null = null;
  private connectedDeviceId: string = '';
  private suppressDisconnectEvent: boolean = false;
  private scanActive: boolean = false;
  private operationTail: Promise<void> = Promise.resolve();
  private connectionGeneration: number = 0;
  private pendingNotifications: Array<PendingNotification> = [];
  private pendingNotificationBytes: number = 0;
  private notificationFlushActive: boolean = false;
  private droppedNotificationBytes: number = 0;

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

  setContext(context: common.UIAbilityContext, uiContext: UIContext): void {
    this.context = context;
    this.uiContext = uiContext;
  }

  postMessage(message: string): void {
    this.handleRequest(message);
  }

  dispose(): void {
    this.stopScan();
    this.closeClient(true);
  }

  private async handleRequest(message: string): Promise<void> {
    let request: BridgeRequest;
    try {
      request = JSON.parse(message) as BridgeRequest;
      if (!Number.isInteger(request.id) || !request.method) {
        throw new Error('Invalid bridge request');
      }
    } catch (error) {
      return;
    }

    try {
      const result = await this.dispatch(request);
      await this.resolveRequest(request.id, result, null);
    } catch (error) {
      await this.resolveRequest(request.id, null, this.errorMessage(error));
    }
  }

  private async dispatch(request: BridgeRequest): Promise<Object | null> {
    const args = request.args || {};
    switch (request.method) {
      case 'initialize':
        await this.initialize();
        return null;
      case 'requestDevice':
        return await this.requestDevice();
      case 'getDevices':
        return this.getDevices(args.deviceIds || []);
      case 'connect':
        await this.connect(this.requireString(args.deviceId, 'deviceId'));
        return null;
      case 'disconnect':
        await this.disconnect(this.requireString(args.deviceId, 'deviceId'));
        return null;
      case 'read':
        return await this.read(
          this.requireString(args.deviceId, 'deviceId'),
          this.requireString(args.serviceUuid, 'serviceUuid'),
          this.requireString(args.characteristicUuid, 'characteristicUuid'),
        );
      case 'write':
        await this.write(
          this.requireString(args.deviceId, 'deviceId'),
          this.requireString(args.serviceUuid, 'serviceUuid'),
          this.requireString(args.characteristicUuid, 'characteristicUuid'),
          args.value || [],
          args.withResponse !== false,
        );
        return null;
      case 'startNotifications':
        await this.setIndications(
          this.requireString(args.deviceId, 'deviceId'),
          this.requireString(args.serviceUuid, 'serviceUuid'),
          this.requireString(args.characteristicUuid, 'characteristicUuid'),
          true,
        );
        return null;
      case 'stopNotifications':
        await this.setIndications(
          this.requireString(args.deviceId, 'deviceId'),
          this.requireString(args.serviceUuid, 'serviceUuid'),
          this.requireString(args.characteristicUuid, 'characteristicUuid'),
          false,
        );
        return null;
      case 'setSystemTheme':
        await this.setSystemTheme(this.requireString(args.theme, 'theme'));
        return null;
      default:
        throw new Error(`Unsupported bridge method: ${request.method}`);
    }
  }

  private async setSystemTheme(theme: string): Promise<void> {
    if (this.context === null) {
      throw new Error('UIAbility context is unavailable');
    }
    if (theme !== 'dark' && theme !== 'light') {
      throw new Error(`Unsupported system theme: ${theme}`);
    }
    const dark = theme === 'dark';
    try {
      const mainWindow = await window.getLastWindow(this.context);
      await mainWindow.setWindowSystemBarProperties({
        statusBarColor: '#00000000',
        navigationBarColor: '#00000000',
        statusBarContentColor: dark ? '#F8FAFC' : '#172033',
        navigationBarContentColor: dark ? '#94A3B8' : '#64748B',
      });
    } catch (error) {
      throw new Error(
        `Unable to update system theme: ${this.errorMessage(error)}`,
      );
    }
  }

  private async initialize(): Promise<void> {
    if (this.context === null) {
      throw new Error('UIAbility context is unavailable');
    }
    try {
      const result = await abilityAccessCtrl
        .createAtManager()
        .requestPermissionsFromUser(this.context, [BLUETOOTH_PERMISSION]);
      if (result.authResults.length !== 1 || result.authResults[0] !== 0) {
        throw new Error('Bluetooth permission was not granted');
      }
    } catch (error) {
      throw new Error(`Bluetooth permission request failed: ${this.errorMessage(error)}`);
    }
    try {
      if (access.getState() !== access.BluetoothState.STATE_ON) {
        throw new Error('Bluetooth is disabled');
      }
    } catch (error) {
      throw new Error(`Unable to query Bluetooth state: ${this.errorMessage(error)}`);
    }
  }

  private async requestDevice(): Promise<DeviceDescriptor> {
    const scanned = await this.scanDevices();
    if (scanned.length === 0) {
      throw new Error('No Linkr Bee device found');
    }
    if (scanned.length === 1) {
      return this.rememberDevice(scanned[0]);
    }

    const visible = scanned.slice(0, 6);
    if (this.uiContext === null) {
      throw new Error('ArkUI context is unavailable');
    }
    const buttons: [
      promptAction.Button,
      promptAction.Button?,
      promptAction.Button?,
      promptAction.Button?,
      promptAction.Button?,
      promptAction.Button?,
    ] = [this.deviceButton(visible[0])];
    for (let index = 1; index < visible.length; index += 1) {
      buttons[index] = this.deviceButton(visible[index]);
    }
    try {
      const response = await this.uiContext.getPromptAction().showActionMenu({
        title: 'Select Linkr Bee',
        buttons: buttons,
      });
      if (response.index < 0 || response.index >= visible.length) {
        throw new Error('Device selection was cancelled');
      }
      return this.rememberDevice(visible[response.index]);
    } catch (error) {
      throw new Error(`Device selection failed: ${this.errorMessage(error)}`);
    }
  }

  private async scanDevices(): Promise<Array<ScannedDevice>> {
    const found: Map<string, ScannedDevice> = new Map();
    const callback = (results: Array<ble.ScanResult>): void => {
      for (const result of results) {
        const name = result.deviceName || result.deviceId;
        found.set(result.deviceId, {
          id: result.deviceId,
          name: name,
          rssi: result.rssi,
        });
      }
    };

    let listenerRegistered = false;
    try {
      ble.on('BLEDeviceFind', callback);
      listenerRegistered = true;
      ble.startBLEScan(
        [{ serviceUuid: MANAGEMENT_SERVICE }],
        {
          dutyMode: ble.ScanDuty.SCAN_MODE_LOW_LATENCY,
          matchMode: ble.MatchMode.MATCH_MODE_AGGRESSIVE,
        },
      );
      this.scanActive = true;
      await this.delay(SCAN_DURATION_MS);
    } catch (error) {
      throw new Error(`Bluetooth scan failed: ${this.errorMessage(error)}`);
    } finally {
      this.stopScan();
      if (listenerRegistered) {
        try {
          ble.off('BLEDeviceFind', callback);
        } catch (_error) {
          // The Bluetooth service may already have removed the listener.
        }
      }
    }

    const devices = Array.from(found.values());
    devices.sort((left, right) => right.rssi - left.rssi);
    return devices;
  }

  private stopScan(): void {
    if (!this.scanActive) {
      return;
    }
    this.scanActive = false;
    try {
      ble.stopBLEScan();
    } catch (_error) {
      // Scanning may already have been stopped by the Bluetooth service.
    }
  }

  private getDevices(deviceIds: Array<string>): Array<DeviceDescriptor> {
    const devices: Array<DeviceDescriptor> = [];
    for (const id of deviceIds) {
      const known = this.knownDevices.get(id);
      devices.push(known || { id: id, name: id });
    }
    return devices;
  }

  private rememberDevice(device: DeviceDescriptor): DeviceDescriptor {
    const descriptor: DeviceDescriptor = {
      id: device.id,
      name: device.name,
    };
    this.knownDevices.set(descriptor.id, descriptor);
    return descriptor;
  }

  private async connect(deviceId: string): Promise<void> {
    if (this.client !== null) {
      this.closeClient(true);
    }

    let client: ble.GattClientDevice;
    try {
      client = ble.createGattClientDevice(deviceId);
    } catch (error) {
      throw new Error(`Unable to create GATT client: ${this.errorMessage(error)}`);
    }
    this.client = client;
    const generation = ++this.connectionGeneration;
    this.connectedDeviceId = deviceId;
    this.suppressDisconnectEvent = false;
    this.characteristics.clear();
    this.operationTail = Promise.resolve();

    try {
      await this.waitForConnection(client, deviceId);
      this.requireSession(client, generation);
      await this.negotiateMtu(client);
      this.requireSession(client, generation);
      const services = await client.getServices();
      this.requireSession(client, generation);
      for (const service of services) {
        for (const characteristic of service.characteristics) {
          this.characteristics.set(
            this.characteristicKey(
              service.serviceUuid,
              characteristic.characteristicUuid,
            ),
            characteristic,
          );
        }
      }
      if (!this.hasService(MANAGEMENT_SERVICE)) {
        throw new Error('Linkr Management service is unavailable');
      }
    } catch (error) {
      if (this.client === client && this.connectionGeneration === generation) {
        this.closeClient(true);
      }
      throw new Error(this.errorMessage(error));
    }
  }

  private waitForConnection(
    client: ble.GattClientDevice,
    deviceId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Bluetooth connection timed out'));
        }
      }, CONNECT_TIMEOUT_MS);

      const connectionCallback = (
        change: ble.BLEConnectionChangeState,
      ): void => {
        if (this.client !== client || change.deviceId !== deviceId) {
          return;
        }
        if (change.state === constant.ProfileConnectionState.STATE_CONNECTED) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (
          change.state === constant.ProfileConnectionState.STATE_DISCONNECTED
        ) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error('Bluetooth disconnected'));
          } else if (!this.suppressDisconnectEvent) {
            this.handleRemoteDisconnect(deviceId);
          }
        }
      };

      const characteristicCallback = (
        characteristic: ble.BLECharacteristic,
      ): void => {
        if (this.client !== client || this.connectedDeviceId !== deviceId) {
          return;
        }
        this.sendNotification(deviceId, characteristic);
      };

      client.on('BLEConnectionStateChange', connectionCallback);
      client.on('BLECharacteristicChange', characteristicCallback);
      try {
        client.connect();
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error as BusinessError);
      }
    });
  }

  private negotiateMtu(client: ble.GattClientDevice): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      const complete = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        client.off('BLEMtuChange', mtuCallback);
        resolve();
      };
      const mtuCallback = (_mtu: number): void => complete();
      client.on('BLEMtuChange', mtuCallback);
      timer = setTimeout(complete, MTU_TIMEOUT_MS);
      try {
        client.setBLEMtuSize(REQUESTED_MTU);
      } catch (_error) {
        complete();
      }
    });
  }

  private async disconnect(deviceId: string): Promise<void> {
    this.pendingNotifications = this.pendingNotifications.filter((item: PendingNotification) => item.deviceId !== deviceId);
    this.pendingNotificationBytes = this.pendingNotifications.reduce((sum: number, item: PendingNotification) => sum + item.value.length, 0);
    if (this.connectedDeviceId && this.connectedDeviceId !== deviceId) {
      throw new Error('Requested device is not connected');
    }
    this.closeClient(true);
  }

  private closeClient(suppressEvent: boolean): void {
    const client = this.client;
    this.connectionGeneration += 1;
    this.suppressDisconnectEvent = suppressEvent;
    this.client = null;
    this.connectedDeviceId = '';
    this.characteristics.clear();
    this.operationTail = Promise.resolve();
    if (client === null) {
      return;
    }
    try {
      client.disconnect();
    } catch (_error) {
      // The peer may already be disconnected.
    }
    try {
      client.close();
    } catch (_error) {
      // Closing an already released client is harmless here.
    }
  }

  private handleRemoteDisconnect(deviceId: string): void {
    if (this.connectedDeviceId !== deviceId) {
      return;
    }
    this.closeClient(true);
    this.runJavaScript(
      `window.LinkrHarmonyBle.disconnected(${JSON.stringify(deviceId)});`,
    );
  }

  private read(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<Array<number>> {
    return this.enqueue(async () => {
      const client = this.requireClient(deviceId);
      const characteristic = this.requireCharacteristic(
        serviceUuid,
        characteristicUuid,
      );
      const result = await client.readCharacteristicValue(characteristic);
      return Array.from(new Uint8Array(result.characteristicValue));
    });
  }

  private write(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    value: Array<number>,
    withResponse: boolean,
  ): Promise<void> {
    return this.enqueue(async () => {
      const client = this.requireClient(deviceId);
      const characteristic = this.requireCharacteristic(
        serviceUuid,
        characteristicUuid,
      );
      const bytes = new Uint8Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        bytes[index] = value[index];
      }
      characteristic.characteristicValue = bytes.buffer as ArrayBuffer;
      await client.writeCharacteristicValue(
        characteristic,
        withResponse
          ? ble.GattWriteType.WRITE
          : ble.GattWriteType.WRITE_NO_RESPONSE,
      );
    });
  }

  private setIndications(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    enabled: boolean,
  ): Promise<void> {
    return this.enqueue(async () => {
      const client = this.requireClient(deviceId);
      const characteristic = this.requireCharacteristic(
        serviceUuid,
        characteristicUuid,
      );
      await client.setCharacteristicChangeIndication(characteristic, enabled);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const client = this.client;
    const generation = this.connectionGeneration;
    const guarded = async (): Promise<T> => {
      this.requireSession(client, generation);
      const value = await operation();
      this.requireSession(client, generation);
      return value;
    };
    const result = this.operationTail.then(guarded, guarded);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireSession(client: ble.GattClientDevice | null, generation: number): void {
    if (client === null || this.client !== client || this.connectionGeneration !== generation) {
      throw new Error('Bluetooth device session changed');
    }
  }

  private requireClient(deviceId: string): ble.GattClientDevice {
    if (this.client === null || this.connectedDeviceId !== deviceId) {
      throw new Error('Bluetooth device is not connected');
    }
    return this.client;
  }

  private requireCharacteristic(
    serviceUuid: string,
    characteristicUuid: string,
  ): ble.BLECharacteristic {
    const characteristic = this.characteristics.get(
      this.characteristicKey(serviceUuid, characteristicUuid),
    );
    if (!characteristic) {
      throw new Error(
        `GATT characteristic unavailable: ${serviceUuid}/${characteristicUuid}`,
      );
    }
    return characteristic;
  }

  private hasService(serviceUuid: string): boolean {
    const prefix = `${serviceUuid.toLowerCase()}/`;
    for (const key of this.characteristics.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  private sendNotification(
    deviceId: string,
    characteristic: ble.BLECharacteristic,
  ): void {
    const value = new Uint8Array(characteristic.characteristicValue);
    this.pendingNotifications.push({ deviceId, serviceUuid: characteristic.serviceUuid,
      characteristicUuid: characteristic.characteristicUuid, value: Array.from(value) });
    this.pendingNotificationBytes += value.length;

    // Keep the newest bytes: the terminal is most useful near the live end of a
    // log, and an unbounded queue is what stalls the renderer.
    while (
      this.pendingNotificationBytes > NOTIFICATION_BUFFER_LIMIT &&
      this.pendingNotifications.length > 1
    ) {
      const dropped = this.pendingNotifications.shift();
      const droppedLength = dropped === undefined ? 0 : dropped.value.length;
      this.pendingNotificationBytes -= droppedLength;
      this.droppedNotificationBytes += droppedLength;
    }

    void this.flushNotifications();
  }

  private async flushNotifications(): Promise<void> {
    if (this.notificationFlushActive) {
      return; // The running flush delivers whatever was just appended.
    }
    this.notificationFlushActive = true;
    try {
      while (this.pendingNotificationBytes > 0) {
        let size = 0;
        let count = 0;
        while (
          count < this.pendingNotifications.length &&
          size < NOTIFICATION_BATCH_BYTES
        ) {
          size += this.pendingNotifications[count].value.length;
          count++;
        }

        // One IPC carries multiple records; never merge ATT payloads or routes.
        const batch = this.pendingNotifications.splice(0, count);
        this.pendingNotificationBytes -= size;

        const dropped = this.droppedNotificationBytes;
        this.droppedNotificationBytes = 0;
        if (dropped > 0) {
          // Reported out of band: injecting a marker into the byte stream would
          // corrupt the framed Management and Reliable UART characteristics,
          // which share this callback.
          hilog.warn(
            DOMAIN,
            'LinkrBee',
            'dropped %{public}d BLE notification bytes',
            dropped,
          );
        }
        await this.runJavaScript(
          `window.LinkrHarmonyBle.notifyBatch(${JSON.stringify(batch)});`,
        );
      }
    } finally {
      this.notificationFlushActive = false;
    }
  }

  private async resolveRequest(
    id: number,
    result: Object | null,
    error: string | null,
  ): Promise<void> {
    await this.runJavaScript(
      `window.LinkrHarmonyBle.resolve(` +
        `${id},${result === null ? 'null' : JSON.stringify(result)},` +
        `${error === null ? 'null' : JSON.stringify(error)});`,
    );
  }

  private async runJavaScript(script: string): Promise<void> {
    try {
      await this.controller.runJavaScript(script);
    } catch (_error) {
      // The page may have been destroyed while a BLE callback was in flight.
    }
  }

  private deviceButton(device: ScannedDevice): promptAction.Button {
    return {
      text: `${device.name} (${device.rssi} dBm)`,
      color: '#101722',
    };
  }

  private characteristicKey(
    serviceUuid: string,
    characteristicUuid: string,
  ): string {
    return `${serviceUuid.toLowerCase()}/${characteristicUuid.toLowerCase()}`;
  }

  private requireString(value: string | undefined, name: string): string {
    if (!value) {
      throw new Error(`Missing bridge argument: ${name}`);
    }
    return value;
  }

  private errorMessage(error: Object): string {
    const businessError = error as BusinessError;
    return businessError.message || String(error);
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
