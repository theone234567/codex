# Panasonic Wi-Fi Remote

A small, ad-free Android remote for compatible Panasonic VIERA televisions on the same local network.

## Use
1. Connect the Android phone and TV to the same Wi-Fi.
2. Install the APK from the GitHub Actions artifact.
3. Open **Panasonic Remote** and tap **FIND TV**.
4. If discovery fails but you know the TV IP, enter it manually.
5. Try **VOL +** first.

The app uses Panasonic classic VIERA NRC: SSDP discovery (`urn:panasonic-com:device:p00RemoteController:1`) and SOAP `X_SendKey` commands at port 55000 `/nrc/control_0`.

## Compatibility
Many older VIERA TVs support classic NRC. Some TVs require **VIERA remote / Network Remote Control** to already be enabled in the TV's Network settings. Newer models can require PIN pairing/encrypted NRC; version 1 does not implement that flow.

## Build
The included GitHub Actions workflow builds `app-debug.apk` and uploads it as the `Panasonic-Remote-APK` workflow artifact.

No ads, analytics, accounts, or Internet servers are used; commands are sent directly to the TV over the local network.
