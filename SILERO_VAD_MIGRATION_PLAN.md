# Silero VAD Implementation Note

## Goal

Replace RMS-only endpointing with Silero VAD while keeping the existing local
ASR worker and transcript queue:

- idle dots before speech;
- pipe indicator as soon as speech is detected;
- pre-roll before speech so the first word is not clipped;
- close chunks on VAD silence;
- keep `ASR_SEGMENT_SECONDS` as the hard max;
- fall back to RMS if the Node ONNX runtime cannot load.

## Current Architecture

VAD runs inside `local-receiver` with TypeScript/Node:

```text
Even glasses PCM
  -> local-receiver/server.js
  -> VadEndpoint frame slicer/state machine
  -> silero-vad.ts using onnxruntime-node
  -> existing PCM writer
  -> existing Python Parakeet ASR worker
  -> existing transcript queue/workbench send
```

This avoids a Python VAD sidecar. Python is still used only for the existing ASR
worker.

## Key Files

- `local-receiver/silero-vad.ts`: loads the bundled Silero ONNX model from
  `@ricky0123/vad-node` and returns per-frame speech decisions.
- `local-receiver/vad-endpoint.js`: owns frame slicing, pre-roll, speech/silence
  timing, and max-utterance closure.
- `local-receiver/server.js`: wires VAD events to PCM files, ASR jobs, and
  glasses status messages.
- `local-receiver/test/vad-endpoint.test.mjs`: deterministic endpointing tests
  with fake speech decisions.
- `local-receiver/test/silero-vad.test.mts`: TypeScript utility coverage.

## Defaults

- `VAD_BACKEND=silero`
- `SILERO_VAD_FRAME_SAMPLES=512`
- `SILERO_VAD_THRESHOLD=0.5`
- `VAD_MIN_SPEECH_MS=60`
- `VAD_SILENCE_MS=240`
- `VAD_PRE_ROLL_MS=500`
- `VAD_MIN_UTTERANCE_MS=250`

RMS fallback remains available with `VAD_BACKEND=rms`.

## Expected Logs

Good endpointing:

```text
[audio] VAD chunking backend=silero frameSamples=512 silence=240ms minSpeech=60ms max=20s
[audio] Silero VAD ready
[audio] VAD detected speech backend=silero
[audio] segment closed (vad silence): ... duration=...
[asr] job 1 started (vad silence): ...
```

Old/bad endpointing:

```text
[audio] segment closed (max utterance): ... duration=20.00s ...
```

`max utterance` should only happen during continuous speech/noise longer than
the configured cap.

## Uploadability Note

This TypeScript implementation is local receiver code. It is not automatically
part of the uploaded Even WebView app because `onnxruntime-node` is a Node native
runtime. Moving VAD into the uploaded app would require a separate browser build
using `onnxruntime-web` or an Even-supported equivalent.
