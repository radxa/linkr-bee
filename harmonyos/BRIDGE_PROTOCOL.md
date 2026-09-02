# HarmonyOS ArkWeb BLE bridge

The ArkWeb page exposes the same `window.LinkrNativeBle` interface used by the
Capacitor client. [`web/native-bootstrap.js`](../web/native-bootstrap.js)
translates it into JSON requests for the ArkTS `LinkrBleHost` object registered
as `linkrBleHost` through `javaScriptProxy`.

Each call invokes:

```text
linkrBleHost.postMessage(JSON.stringify({ id, method, args }))
```

The ArkTS host completes the request by evaluating one of these calls in the
page:

```js
window.LinkrHarmonyBle.resolve(id, result, null);
window.LinkrHarmonyBle.resolve(id, null, "error message");
```

Asynchronous GATT events use:

```js
window.LinkrHarmonyBle.notify(deviceId, serviceUuid, characteristicUuid, bytes);
window.LinkrHarmonyBle.disconnected(deviceId);
```

`bytes` and characteristic read results are arrays of unsigned 8-bit integers.
The host must serialize GATT operations. A successful `write` response means the
corresponding HarmonyOS GATT write callback completed, not merely that the
operation was queued.

The JavaScript side expires a request after 30 seconds. A remote disconnect
immediately rejects pending requests for that device and removes its indication
callbacks; late ArkTS responses are ignored.

## Methods

| Method | Required result |
| --- | --- |
| `initialize` | Request `ohos.permission.ACCESS_BLUETOOTH` and verify Bluetooth is enabled |
| `requestDevice` | Scan by Management Service UUID, show a user chooser, return `{id,name}` |
| `getDevices` | Resolve known IDs, return an array of `{id,name}` |
| `connect` | Create a GATT client, connect, discover services, and negotiate MTU 247 |
| `disconnect` | Disconnect and close the GATT client |
| `read` | Return characteristic bytes |
| `write` | Write characteristic bytes using the requested response mode |
| `startNotifications` | Enable notification or indication and forward changes |
| `stopNotifications` | Disable forwarding and the remote subscription |

For Linkr Management and Reliable UART TX, the host must enable **indications**,
not only notifications.
