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
window.LinkrHarmonyBle.notifyBatch(records);   // [{deviceId, serviceUuid, characteristicUuid, value}]
window.LinkrHarmonyBle.disconnected(deviceId);
```

`notify(deviceId, serviceUuid, characteristicUuid, bytes)` is the single-record
form that `notifyBatch` fans out to. The host coalesces every notification that
arrives while an evaluation is in flight into one `notifyBatch` call, because a
115200-baud console produces more callbacks per second than one IPC each can
retire. `value` and characteristic read results are arrays of unsigned 8-bit
integers.

The host must serialize GATT operations. A successful `write` response means the
corresponding HarmonyOS GATT write callback completed, not merely that the
operation was queued.

## Deadlines

The JavaScript side owns the request deadline, per method
([`harmonyos/src/native-bootstrap.js`](src/native-bootstrap.js) `REQUEST_TIMEOUT_MS`,
`INTERACTIVE_TIMEOUT_MS`, `METHOD_TIMEOUTS`):

| Methods | Deadline | Why |
| --- | --- | --- |
| `initialize`, `requestDevice` | 180 s | both wait for a human: the Bluetooth permission prompt and the "Select Linkr Bee" menu |
| `connect` | 120 s | above the host's worst case (scan 3 s + connect 15 s + system pairing 60 s + MTU 1.5 s + 5 s margin), so the page never abandons a connect the radio is still completing |
| everything else | 30 s | the host-only methods finish inside their own budget |

`METHOD_TIMEOUTS` overrides the 30 s default per method and is the only place to
change a deadline; adding a method without an entry inherits the default. A
deadline rejects the page-side promise and forgets the request id, so a late
ArkTS completion is ignored. A remote disconnect immediately rejects every
pending request for that device and removes its notification and disconnect
callbacks.

A connection generation guards the queue: notifications received on a connection
that has since closed are dropped by the host instead of being handed to the
next session, and the page clears that device's callbacks on `disconnected`.

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
| `startNotifications` | Enable the CCC the characteristic declares (notification or indication) and forward changes |
| `stopNotifications` | Disable forwarding and the remote subscription |

## Subscription type

The subscription is chosen from the characteristic's own declared properties,
never from the service it belongs to
([`LinkrBleHost.ets`](entry/src/main/ets/bridge/LinkrBleHost.ets) `subscriptionMode`):

| Characteristic | Properties | CCC enabled |
| --- | --- | --- |
| NUS TX | `NOTIFY` only | `setCharacteristicChangeNotification` |
| Management Response / Event | `INDICATE` | `setCharacteristicChangeIndication` |
| Reliable UART TX | `INDICATE` | `setCharacteristicChangeIndication` |
| declares both | `NOTIFY` + `INDICATE` | notification, the lower-latency path |
| declares neither | — | notification, the best-effort default |

Driving the wrong CCC subscribes to nothing (or is refused by the stack), which
is why the host does not hard-code one API. Real-device acceptance should cover
both a notify-only NUS subscription and an indicate-only management
subscription.
