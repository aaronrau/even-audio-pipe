# Feature Roadmap

## Native Mentra Bluetooth Workbench Bridge

Status: proposed

The next major direction is to move from the current Even Hub WebView audio
pipe to a native phone host that connects to the glasses directly through the
Mentra Bluetooth SDK. The goal is reliable background operation, automatic
connection, and direct routing from glasses speech to `speech-agent-workbench`.

## Why This Path

The current web app depends on a foreground WebView launched from the Even app.
That is useful for prototyping, but it is not the right long-term host for
always-on speech routing because the browser/WebView lifecycle is fragile in
the background.

A MentraOS miniapp is also not enough for the full requirement. Miniapps can run
inside the Mentra host and can share the glasses connection with other apps, but
they cannot override the host app lifecycle or grant themselves iOS background
Bluetooth/audio execution.

The native-host approach gives us control over:

- Glasses Bluetooth connection and reconnect behavior.
- Background modes on iOS and Android.
- Continuous glasses microphone PCM streaming.
- Local or server-side STT selection.
- WebSocket transport to the local speech bridge.
- Display updates back to the G2.
- Agent routing rules and Workbench callback handling.

## Target Architecture

```text
Even Realities G2 mic
  -> Mentra Bluetooth SDK over BLE
  -> native iOS/Android host receives mic PCM
  -> WebSocket streams PCM to local bridge or cloud STT
  -> transcript queue batches by last translated text / VAD activity
  -> cleaned command is routed to speech-agent-workbench /messages
  -> Workbench summary callback returns text
  -> native host writes summary to G2 display over BLE
```

For iOS, the host should use both background modes when needed:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>bluetooth-central</string>
  <string>audio</string>
</array>
```

`bluetooth-central` keeps the BLE glasses link eligible for background events.
`audio` is only appropriate while the app is actively handling a user-visible
audio recording or live transcription workflow.

## Relevant Mentra SDK Capabilities

The Mentra Bluetooth SDK documents the core features we need:

- G2 microphone support.
- BLE command and microphone data channel.
- Continuous `mic_pcm` events while microphone capture is enabled.
- PCM metadata of 16 kHz, 16-bit, mono audio.
- LC3 microphone events when the pipeline wants compressed frames.
- Glasses-side VAD status events when supported.
- Local transcription events where available.
- Display control for writing summaries back to the glasses.

The SDK starter kit also includes an ElevenLabs audio repro that is close to
this bridge shape: it enables continuous glasses PCM, streams base64 PCM chunks
over WebSocket, and handles agent responses.

References:

- Mentra Bluetooth SDK starter kit: https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit
- Mentra iOS Bluetooth SDK: https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios
- Mentra audio guide: https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit/blob/main/docs/audio-guide.md
- Apple Core Bluetooth background processing: https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html
- Apple audio session background guidance: https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/AudioGuidelinesByAppType/AudioGuidelinesByAppType.html

## Milestone 1: Validate Direct Bluetooth Audio

Build a minimal native host using the Mentra Bluetooth SDK.

Acceptance criteria:

- Scan and connect to one G2 from the native host.
- Persist the selected/default glasses device.
- Reconnect to the saved device after app restart.
- Enable the glasses microphone with `setMicState`.
- Receive continuous PCM frames from the glasses.
- Log basic audio metadata: sample rate, bit depth, channel count, frame size.
- Stop microphone streaming cleanly from the app UI.

Implementation notes:

- Start with the iOS SDK package for iOS and the Android artifact for Android.
- Use a physical device; simulators are not enough for Bluetooth validation.
- Keep explicit microphone and Bluetooth permission copy in the UI.

## Milestone 2: WebSocket Audio Bridge

Replace the Even WebView audio source with a WebSocket stream from the native
host.

Acceptance criteria:

- Native host opens a WebSocket to a local bridge endpoint.
- Native host sends PCM frames as binary frames or compact base64 JSON.
- Local bridge accepts native-client sessions separately from the current
  WebView `/audio` sessions.
- Local bridge can identify the source device/user.
- Local bridge writes transcript and audio files using the existing storage
  paths.
- WebSocket reconnects without duplicating active streams.

Recommended endpoint shape:

```text
ws://HOST:8788/native/audio?t=TOKEN
```

Initial message:

```json
{
  "type": "start",
  "source": "mentra-native",
  "device": "g2",
  "encoding": "pcm_s16le",
  "sampleRate": 16000,
  "channels": 1
}
```

## Milestone 3: Reuse Existing STT And Workbench Routing

Feed the native audio stream into the current ASR, transcript queue, cleanup,
and Workbench routing path.

Acceptance criteria:

- Existing transcript queue behavior remains unchanged:
  - append raw transcript text;
  - wait for configured idle after last transcript/VAD activity;
  - flush after max hold;
  - skip Workbench unless agent prefix or armed agent is present.
- Agent names remain config-driven.
- Workbench `/messages` payload remains:

```json
{
  "agent": "Flux",
  "message": "pull the latest"
}
```

- Workbench summary callback still returns to connected glasses.
- Native display updates receive the same `agent_summary` payloads as the
  current WebView client.

## Milestone 4: Background Operation

Make the native host reliable when the phone is locked or the app is
backgrounded.

Acceptance criteria:

- iOS declares `bluetooth-central`.
- iOS declares `audio` only when the app is actively running the live audio
  workflow.
- iOS keeps the BLE mic stream and WebSocket alive during a lock-screen test.
- Android uses a foreground service with a persistent notification while live
  audio streaming is active.
- Route changes, Bluetooth disconnects, and network changes surface clear
  status to the user.
- The user can stop microphone streaming at any time.

Risks:

- iOS may still suspend or terminate under memory, thermal, battery, or policy
  pressure.
- App Store review can reject misuse of background audio if it is not clearly
  a user-facing audio or transcription feature.
- Long-running local STT/LLM on the phone may be constrained by battery and
  thermal behavior.

## Milestone 5: Direct Display Output

Write summaries and status messages back to the G2 through the native host
instead of the Even Hub text container.

Acceptance criteria:

- Show idle/listening state.
- Show live transcript or latest command state.
- Show Workbench sending/sent/error statuses.
- Show agent summaries.
- Avoid overwriting user-visible app content unless our bridge is the active
  display owner.

## Milestone 6: Local Models On Phone

Evaluate local phone models after the Bluetooth and Workbench path is stable.

Candidate use cases:

- Local VAD or endpointing.
- Local STT for short commands.
- Local cleanup/rephrase before Workbench routing.
- Local command classification to reduce unnecessary network calls.

Acceptance criteria:

- Model path works offline for at least short commands.
- Latency is acceptable for hands-free interaction.
- Battery and thermal impact are measured.
- Cloud/local mode is selectable in config.

## Milestone 7: Optional MentraOS Host Fork

Only fork the MentraOS host if the standalone Bluetooth SDK path cannot deliver
the lifecycle we need.

Fork goals:

- Auto-start the Workbench bridge when a configured G2 connects.
- Keep the bridge running as a built-in background app.
- Share glasses display ownership with other Mentra apps.
- Integrate app settings into the Mentra host.

Defer this until the direct SDK bridge proves the audio and Workbench flow,
because host forking adds ongoing merge and release overhead.

## Open Questions

- Does G2 expose PCM continuously on iOS through the current published SDK, or
  only in the latest beta?
- Do we want binary WebSocket frames or JSON/base64 frames for the native audio
  stream?
- Should display output be owned by the bridge full-time, or only when an agent
  summary arrives?
- Should STT run locally on the phone, on the current desktop bridge, or through
  a cloud STT service?
- How should the user explicitly arm/disable background listening?
- What privacy disclosure and retention settings are required before broader
  testing?

## Immediate Next Steps

1. Clone and run the Mentra Bluetooth SDK iOS example on a physical iPhone.
2. Confirm G2 scan/connect/mic PCM callbacks with the current beta SDK.
3. Add a small native WebSocket client that streams PCM to a local test server.
4. Add `/native/audio` to this repo's receiver and reuse the current ASR path.
5. Run a 30-minute lock-screen/background test with BLE, audio, and WebSocket
   enabled.
6. Decide whether native standalone app or Mentra host fork is the right
   production path.
