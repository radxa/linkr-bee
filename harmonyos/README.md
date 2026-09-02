# HarmonyOS NEXT client

This directory contains a HarmonyOS Stage application for the Linkr Bee BLE
terminal. ArkWeb renders the shared terminal UI, while the ArkTS host implements
BLE access and exposes it through the JSON-RPC contract in
[`BRIDGE_PROTOCOL.md`](BRIDGE_PROTOCOL.md).

## Current implementation

- HarmonyOS API 26 Stage project with phone and tablet support;
- runtime `ohos.permission.ACCESS_BLUETOOTH` handling and local-network access;
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

The project currently passes ArkTS type checking and builds an unsigned API 26
HAP. The HAP, ArkWeb UI, responsive phone/tablet layout, and JavaScript bridge
have been exercised in the API 26 emulator. BLE permission behavior, scanning,
GATT data transfer, and disconnect recovery still require a real HarmonyOS
device. The first version is foreground-only; background BLE and ArkWeb lifecycle
recovery require a separate hardware acceptance pass.
