# Echo Panel Android Wake Wrapper

`android/echo-panel` is a native Android wrapper for the Echo Show LineageOS build. It keeps
the panel in a full-screen WebView and runs wake-word detection locally through
ONNX Runtime and the original openWakeWord models.

## Flow

1. `MainActivity` loads the dashboard URL with `nativeWake=1`.
2. `WakeWordService` runs as a foreground microphone service.
3. `openWakeWord` detects the configured ONNX wake model locally.
4. The service broadcasts `OPENWAKEWORD_DETECTED` inside the app.
5. `MainActivity` calls `window.CiscoNavigatorNativeWake()` in the WebView.
6. The panel opens Assist on any route and requests PCM from the already-open native microphone.
7. The native client plays a listening chime through the media stream.
8. After two seconds of silence following speech, and never before two seconds of capture,
   the panel sends PCM to Home Assistant. Capture starts immediately; the delay does not discard audio.
9. Wake inference resumes after the request and TTS playback finish, or immediately after cancellation.

`nativeWake=1` disables the web-based wake listener so the Echo does not run two microphone loops.
The service keeps one 16 kHz PCM16 microphone stream open. Wake detection and command capture
share that stream, so there is no WebView microphone handoff. The three ONNX sessions stay loaded.
Audio remains in memory on the device during wake monitoring; only command recordings are uploaded.
No-speech recordings wait up to eight seconds, then time out locally without sending silence to Assist.
Quiet native command recordings receive bounded gain before upload; endpoint detection uses
the unamplified signal and an adaptive noise floor.

The Android APK includes the matching panel client. Only the HTML shell and its hashed `/a/`
assets are served from the APK, at the configured HTTPS origin. API requests, authentication,
photos, and WebSockets still use the configured server. Updating the Android APK therefore
updates its client even when Unraid is running an older compatible server.

## Cancellation And Timers (2.1)

Deploy the matching backend before installing APK 2.1. Panel command handling requires both
updates: the old server ignores the opt-in `panelCommands` field. Existing 2.0 clients continue
using their original pipeline when connected to the new backend.

New clients request STT first. The backend intercepts exact panel commands before starting any
HA intent or TTS stage. Ordinary requests reuse that transcript in the configured HA pipeline,
including its existing TTS provider and conversation context. No new HA entities or integrations
are required. Local timer actions are acknowledged by the countdown popup, not a synthesized reply.

- While Assist is listening, say `stop`, `cancel`, or `never mind` to dismiss an accidental wake.
  Cancellation is recognized after STT; this is not a separate always-on stop-word model or
  interruption during TTS. Outside a listening session, use the wake word or microphone first.
- `stop the music` still goes to Home Assistant. Bare `stop` does not cancel a running timer,
  but it does dismiss any timer alerts that are currently ringing.
- `start timer for five minutes` or `set a five-minute timer` opens a live countdown.
- `start a timer for ten minutes called pasta` creates a named timer. `pause the pasta timer`,
  `resume the pasta timer`, and `cancel the pasta timer` target it. `cancel all timers` is explicit;
  an ambiguous singular command asks the user to choose in the popup instead of guessing.
- The timer popup offers touch presets, a duration/name form, pause/resume, add one minute,
  restart, removal, and a repeating end alert. It does not add a navigation tab or change the
  underlying page. Close it without canceling the countdown; `show my timers` reopens it.
  Expiration opens the popup over any page; alerts pause during Assist recording/TTS.
  Closing a ringing popup dismisses its alerts. Active countdowns hold off the screensaver
  only while the popup is open.

Timers belong to the initiating panel, not to HA. Absolute deadlines are cached in local storage
under its `panel` id, so navigation and reloads do not reset a countdown. Overdue timers alert
when the app starts again. The app must be running to sound at the deadline; this is not an
Android system alarm that runs while the app/device is off. Clearing browser data (including
RoomOS's periodic storage clearing) removes timers. The UI warns when storage cannot be written.


## Required Model Assets

The native engine expects these files in:

`android/echo-panel/app/src/main/assets/`

```text
embedding_model.onnx
melspectrogram.onnx
hey_jarvis_v0.1.onnx
```

The default wake model path is `hey_jarvis_v0.1.onnx`, but any compatible openWakeWord ONNX
classifier can be used. Keep the shared preprocessing files named exactly as shown above because
the engine looks them up by those names.

CI downloads the default `hey jarvis` assets from the openWakeWord v0.5.1 GitHub release and
verifies SHA-256 before building the APK. The source is Apache-2.0; the bundled pretrained models
have separate upstream license terms. See `android/echo-panel/THIRD_PARTY_NOTICES.md`.

## Runtime Defaults

The APK defaults to:

```text
panel_url=https://assistant.ts.blasters.app/?panel=echo-show&nativeWake=1
wake_model_name=Hey Jarvis
wake_model_path=hey_jarvis_v0.1.onnx
wake_threshold=0.15
```

Those are stored in Android shared preferences under `echo-panel`. Version 2.0 migrates the
old threshold once: it fixes the PCM scale supplied to openWakeWord, so the old thresholds
are not comparable. Lower values increase sensitivity and false activations.
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
  --ef wake_threshold 0.15
```

`wake_model_path` must point to an ONNX file that was packaged in the APK assets directory.
Changing the wake settings reloads the model without restarting the microphone.

## Build

GitHub Actions builds this module on PRs. To build locally, install a JDK and Android SDK, then run:

```bash
npm ci
npm run build --workspace panel
gradle -p android/echo-panel assembleDebug
```

The ONNX assets listed above must also be downloaded before a local build.
CI contains their pinned URLs and SHA-256 hashes.

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
the service. Hardware volume buttons control media volume, including the chime and replies.

## Verification

`npm test` includes command endpoint and native bridge cancellation tests.
The Android instrumentation test checks silence, reset, and a synthesized "Hey Jarvis" fixture
against the actual ONNX models. Run `connectedDebugAndroidTest` on a test device only: Gradle
installs and removes the app as part of that task. The fixture was synthesized with macOS
Samantha at 16 kHz, not recorded from a person.

Use `adb logcat -s WakeWordService MainActivity` for microphone RMS, inference timing,
queue backlog, wake scores, and chime events. Inference must remain below the 80 ms frame
interval after warmup. An empty capture queue during ordinary wake monitoring is normal.
