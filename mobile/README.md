# Linkr Bee mobile app

This directory packages the shared `web/` terminal for Android and iOS. The UI,
Management v1 protocol, and Reliable UART v1 implementation remain shared; only
the BLE transport is native.

## Touch terminal keys

The terminal has a two-row accessory keyboard on phones and tablets. Keyboard,
Esc, Tab and Shift/Ctrl/Alt stay on the left; the right side scrolls through an
inverted-T arrow cluster, Home/End, Paste, Enter, Page Up/Down, Backspace, symbols
and common Ctrl shortcuts. Tap a modifier before the next key; tap again to
cancel. Modifiers reset after use or disconnect. For example, Ctrl then C sends
an interrupt, Shift + Tab sends reverse Tab, and Alt + B moves back a word in
shells that support it. Paste uses the clipboard when available and otherwise
prompts you to long-press the terminal. Both rows stay above the soft keyboard
and are shared with the Web and HarmonyOS clients.

## Build web assets

```sh
cd mobile
npm install
npm run build
```

The output is written to `mobile/dist/`. In a normal browser the build continues
to use Web Bluetooth. Inside Capacitor it uses
`@capacitor-community/bluetooth-le`.

## Generate native projects

```sh
npm run cap:add:android
npm run cap:add:ios
npm run cap:sync
```

Android requires Android Studio and a current Android SDK. iOS requires Xcode
and must be tested on a real device because the iOS simulator has no BLE support.

The generated projects already contain the required platform declarations:

- Android declares Bluetooth scan/connect permissions and limits legacy location
  permissions to Android 11 and earlier.
- iOS declares Bluetooth and local-network usage descriptions and permits local
  networking for the optional LAN terminal.

If either native project is regenerated, verify that
`android/app/src/main/AndroidManifest.xml` and `ios/App/App/Info.plist` still
contain these project-specific declarations before building.

The relevant iOS keys are:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Connect to Linkr Bee Bluetooth serial accessories.</string>
<key>NSLocalNetworkUsageDescription</key>
<string>Connect to a Linkr Bee terminal over the local network.</string>
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

The first release is intentionally foreground-only. Do not add iOS
`bluetooth-central` background mode until disconnect/reconnect and power behavior
have been tested on real hardware.

The current firmware intentionally permits open BLE access. Do not publish the
app as a remote-administration product until device ownership, pairing, or an
equivalent authorization policy has been defined and implemented.
