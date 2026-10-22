# HarmonyOS NEXT client

[User guide](../docs/USAGE.md) | [Project overview](../README.md) | [Documentation](../docs/README.md)

This directory contains a HarmonyOS Stage application for the Linkr Bee BLE
terminal. ArkWeb renders the shared terminal UI, while the ArkTS host implements
BLE access and exposes it through the JSON-RPC contract in
[`BRIDGE_PROTOCOL.md`](BRIDGE_PROTOCOL.md).

## Current implementation

- HarmonyOS Stage project for phone and tablet: minimum API 12
  (`compatibleSdkVersion` `5.0.0(12)`), target API 26 (`targetSdkVersion` `26.0.0`);
- declares `ohos.permission.INTERNET` and `ohos.permission.ACCESS_BLUETOOTH`, and
  requests `ohos.permission.ACCESS_BLUETOOTH` at runtime;
- Management Service-filtered scan and native device picker;
- GATT connect, service discovery, MTU 247 request, serialized reads/writes, and
  indication subscriptions;
- ArkWeb-to-ArkTS request dispatch plus notification and disconnect events;
- shared web resource build and automatic copy into `resources/rawfile/`.

The native host is implemented in
[`LinkrBleHost.ets`](entry/src/main/ets/bridge/LinkrBleHost.ets), and the ArkWeb
container is in [`Index.ets`](entry/src/main/ets/pages/Index.ets).

## Build

DevEco Studio must be installed in `/Applications/DevEco-Studio.app`, or its
location supplied through `DEVECO_STUDIO_HOME`. Install the mobile web
dependencies once, then build the shared UI and HAP:

```sh
cd mobile
npm install
npm run build:harmony:hap
```

The build helper uses DevEco Studio's bundled Node.js, JBR, HarmonyOS SDK, and
hvigor. To rebuild only the HAP after an ArkTS change:

```sh
harmonyos/tools/build.sh --skip-web
```

The unsigned output is written to:

```text
harmonyos/entry/build/default/outputs/default/entry-default-unsigned.hap
```

## Configure a debug signature

Signing is account-bound and is intentionally not stored in this repository.
Open the `harmonyos/` directory as a project in DevEco Studio, then select:

```text
File > Project Structure... > Project > Signing Configs
```

Enable **Support HarmonyOS** and **Automatically generate signature**, sign in
with the project owner's HUAWEI ID, and wait for DevEco Studio to populate the
debug signing configuration. The resulting certificates, keystore, and profile
files are ignored by Git and must not be committed.

After signing is configured, use DevEco Studio's **Run** action for a simulator
or device. The command-line build continues to produce an unsigned HAP unless
the generated `signingConfigs` entry is available to hvigor.

## Host-side verification

The JavaScript bridge can be exercised without a phone or simulator:

```sh
cd mobile
npm test
```

These tests cover request/result correlation, binary read/write conversion,
indication forwarding, host errors, remote disconnect cleanup, and the 30-second
native request timeout.

## Validation boundary

Firmware now requires encrypted, bonded BLE access. On C3/C5, hold GPIO1 to GND
and pair in the system Bluetooth UI before connecting a new host. WROOM ships
with pairing authorization disabled, so no GPIO4 press is needed there; GPIO4 is
used only when `CONFIG_LINKR_BLE_BRIDGE_PAIRING_GPIO_AUTH=y`. Existing bonded
hosts do not need the pairing GPIO.
Automatic pairing dialogs and lost-bond recovery still
require a physical HarmonyOS device; see [pairing and recovery](../docs/BLE_PAIRING.md).

The shared terminal now includes the Pi serial assistant. Its setup and tool
behavior are documented in the [Built-in serial assistant (Pi)](../mobile/README.md#built-in-serial-assistant-pi)
section of the mobile guide.
The Pi runtime is included in the single inlined ArkWeb entry; no Node.js process
runs on the phone. Model endpoint/CORS behavior and agent cancellation across
real-device lifecycle transitions still require hardware validation.

The project currently passes ArkTS type checking and builds an unsigned API 26
HAP. The HAP, ArkWeb UI, responsive phone/tablet layout, and JavaScript bridge
have been exercised in the API 26 emulator. BLE permission behavior, scanning,
GATT data transfer, and disconnect recovery still require a real HarmonyOS
device. The first version is foreground-only; background BLE and ArkWeb lifecycle
recovery require a separate hardware acceptance pass.
