# Echo Panel Android Wake Wrapper

`android/echo-panel` is a native Android wrapper for the Echo Show LineageOS build. It keeps
the panel in a full-screen WebView and runs wake-word detection locally through
`xyz.rementia:openwakeword`.

## Flow

1. `MainActivity` loads the dashboard URL with `nativeWake=1`.
2. `WakeWordService` runs as a foreground microphone service.
3. `openWakeWord` detects the configured ONNX wake model locally.
4. The service broadcasts `OPENWAKEWORD_DETECTED` inside the app.
5. `MainActivity` calls `window.CiscoNavigatorNativeWake()` in the WebView.
6. The panel opens Assist and starts the existing push-to-talk capture path.

`nativeWake=1` disables the web-based wake listener so the Echo does not run two microphone loops.
The native service also pauses wake listening for 15 seconds after a detection so the WebView can
use the microphone for the command.

## Required Model Assets

The openWakeWord Android library expects these files in:

`android/echo-panel/app/src/main/assets/`

```text
embedding_model.onnx
melspectrogram.onnx
hey_jarvis_v0.1.onnx
```

The default wake model path is `hey_jarvis_v0.1.onnx`, but any compatible openWakeWord ONNX
classifier can be used. Keep the shared preprocessing files named exactly as shown above because
the library looks them up by those names.

CI downloads the default `hey jarvis` assets from the Apache-2.0 licensed openWakeWord v0.5.1
GitHub release and verifies SHA-256 before building the APK. Pre-trained wake classifiers may carry
different dataset/license terms if you switch models; check the model license before committing or
downloading a different classifier.

## Runtime Defaults

The APK defaults to:

```text
panel_url=https://assistant.ts.blasters.app/?panel=echo-show&nativeWake=1
wake_model_name=Hey Jarvis
wake_model_path=hey_jarvis_v0.1.onnx
wake_threshold=0.02
```

Those are stored in Android shared preferences under `echo-panel`.
`WakeWordService` logs the configured model, threshold, detections, and periodic score peaks under
the `WakeWordService` tag so missed detections can be diagnosed with `adb logcat`.

## Configure With ADB

Runtime settings can be updated without rebuilding the APK:

```bash
adb shell am start -n com.spencer.echopanel/.MainActivity \
  --es panel_url 'https://assistant.ts.blasters.app/?panel=echo-show&nativeWake=1'
```

```bash
adb shell am start -n com.spencer.echopanel/.MainActivity \
  --es wake_model_name 'Hey Jarvis' \
  --es wake_model_path 'hey_jarvis_v0.1.onnx' \
  --ef wake_threshold 0.02
```

`wake_model_path` must point to an ONNX file that was packaged in the APK assets directory.
Changing the wake settings restarts the foreground wake service.

## Build

GitHub Actions builds this module on PRs. To build locally, install a JDK and Android SDK, then run:

```bash
gradle -p android/echo-panel assembleDebug
```

The debug APK lands at:

```text
android/echo-panel/app/build/outputs/apk/debug/app-debug.apk
```

## Install

```bash
adb install -r android/echo-panel/app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.spencer.echopanel 1
```

The first launch requests microphone permission. After permission is granted, the foreground
service starts and stays running across app restarts. `BOOT_COMPLETED` and app updates also restart
the service.
