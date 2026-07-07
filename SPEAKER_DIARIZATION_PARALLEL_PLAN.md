# Speaker Diarization Parallel Plan

## Goal

Add speaker-labelled transcript capture without changing the current glasses,
history, transcript queue, cleanup, or workbench behavior.

The first implementation is a parallel, observe-only path:

```text
Existing path:
Even PCM -> VAD segment -> WAV -> ASR -> cleanup -> transcript queue
  -> transcripts.log / message history / socket events / workbench

New parallel path:
completed main segment WAV + main ASR transcript -> diarization worker
  -> speaker ID -> optional sidecar turn ASR
  -> separate diarized transcript store only
```

The existing path remains the product path. The diarization path runs beside the
current app stack and only writes separate files for later inspection and tuning.

## Non-Goals

- Do not change current `transcript`, `asr_status`, `agent_status`, or history
  socket event payloads.
- Do not change how queued text renders on the glasses.
- Do not change workbench routing or agent-prefix behavior.
- Do not write speaker-labelled text to the existing durable history yet.
- Do not merge diarized output into `transcripts.log` yet.
- The only normal transcript-folder artifact is a separate
  `<segment-id>.diarization.txt` / `<segment-id>.diarization.json` pair.
- Do not block the existing ASR queue on diarization work.

## Runtime Parallelism

The current app should continue to run exactly as it does today:

```text
npm start
  -> Even WebView app
  -> local receiver
  -> existing VAD/ASR/cleanup/transcript/workbench flow
```

Diarization is an additional sidecar path attached to the receiver, not a
replacement flow:

```text
local receiver
  -> existing app/product pipeline, awaited as today
  -> completed WAV/transcript handoff to diarization sidecar, fire-and-forget
```

Rules:

- The Even WebView app does not import diarization code.
- The current receiver request/audio handling does not mirror live audio into
  diarization. It only hands the completed saved WAV and main ASR transcript to
  the sidecar after the existing ASR path has produced them.
- The current ASR queue does not wait for diarization.
- Diarization failures are logged under a diarization prefix and do not surface
  as app errors.
- The sidecar can be disabled without changing the app or existing receiver
  behavior.
- If CPU pressure becomes visible, run diarization in a separate Node process
  instead of the receiver event loop.
- The sidecar queue is bounded. If it falls behind, it may spill sidecar audio
  to disk or skip diarization jobs, but it must not slow or fail the current app
  path.

## Sidecar Saved-Segment Queue

Fire-and-forget does not mean dropping the completed segment. It means the
receiver hands the already-saved segment WAV and main ASR transcript to a
separate queue and returns to the existing app flow.

Queue shape:

```text
existing VAD segment closes
  -> existing receiver converts PCM to WAV
  -> existing ASR returns segment transcript
  -> sidecarQueue.processExistingAudio(wavPath, transcript, metadata)
```

Processing shape:

```text
sidecar queue
  -> sidecar-owned copy of the completed WAV file
  -> diarization worker
  -> speaker turn audio files
  -> optional sidecar ASR jobs only for multi-turn speaker splits
  -> diarized transcript JSONL
```

Queue rules:

- Audio enters the sidecar only as a completed WAV that already exists on disk.
- The queue owns its copied WAV files under `data/diarization/`.
- The live WebSocket/audio chunk path must not call sidecar open/append/close
  methods.
- Completed segment jobs process sequentially by default. Parallelism can be
  added later with a low concurrency cap.
- Queue state is local to diarization. It does not affect transcript queue
  timers, VAD state, socket state, or workbench state.
- On shutdown, incomplete sidecar segments may be marked abandoned in the
  diarization metadata; the current app does not need recovery semantics for
  those sidecar records.

## Data Separation

Use a dedicated root, defaulting to:

```text
data/diarization/
```

Suggested layout:

```text
data/diarization/
  audio/
    2026-07-05/
      <segment-id>.wav
      <segment-id>.speaker-00.wav
      <segment-id>.speaker-01.wav
  queue/
    <segment-id>.pcm.tmp
  transcripts/
    2026-07-05.jsonl
  segments/
    2026-07-05.jsonl
  speakers/
    profiles.json
    enrollments/
      <speaker-id>/
        <sample-id>.wav
```

Rules:

- Existing `AUDIO_DIR`, `TRANSCRIPT_DIR`, `TRANSCRIPTS_LOG`, and
  `MESSAGE_HISTORY_DIR` are not used by the sidecar internals.
- Speaker-breakout transcript files are saved in the normal transcript folder
  with `diarization` in the filename, for example
  `g2-...-001.diarization.txt`, so they sit next to the standard
  `g2-...-001.txt` transcript without changing it.
- The sidecar store references existing segment ids but owns its own audio
  copies and JSONL files.
- Speaker embeddings are stored only under `data/diarization/speakers`.
- Raw embedding vectors are not logged to stdout.
- Generated `*.diarization.txt`, `*.diarization.json`, and
  `*.diarization.jsonl` files are ignored by git.

## MVP Behavior

For each closed VAD segment, the existing path continues unchanged.

The parallel path should receive the same completed segment WAV and transcript
that the existing receiver/ASR flow already produces. It should not create a
second capture pipeline, reopen the microphone, ask the client for another
stream, or mirror live PCM chunks.

In parallel:

1. Wait for the existing receiver to close a VAD/fixed segment.
2. Let the existing path convert PCM to WAV and run ASR as it already does.
3. Fire-and-forget enqueue the completed WAV plus main ASR transcript.
4. Copy the completed WAV into `data/diarization/audio/<date>/`.
5. Run ONNX speaker diarization on the diarization-owned WAV copy.
6. If the segment has one dominant speaker, assign one speaker label and reuse
   the main ASR transcript.
7. If the segment has multiple speaker turns, cut turn WAVs into the
   diarization audio folder.
8. Run sidecar ASR on speaker turns only when needed for multi-turn breakout.
9. Write sidecar JSONL records to `data/diarization/transcripts/<date>.jsonl`.
10. Write the speaker-breakout transcript version to the normal transcript
    folder as `<segment-id>.diarization.txt` and
    `<segment-id>.diarization.json`.

Initial JSONL shape:

```json
{
  "type": "diarized_transcript",
  "sourceSegmentId": "20260705-120102-123-0007",
  "createdAt": "2026-07-05T19:01:05.123Z",
  "audioFile": "audio/2026-07-05/20260705-120102-123-0007.wav",
  "speaker": {
    "id": "speaker_00",
    "displayName": "Unknown speaker 00",
    "confidence": 0.72,
    "matchedProfile": false
  },
  "text": "transcribed text for this speaker turn",
  "turn": {
    "startSec": 0.31,
    "endSec": 3.82
  },
  "models": {
    "diarization": "sherpa-onnx-pyannote-segmentation-3-0",
    "embedding": "nemo_en_titanet_small",
    "asr": "nemo-parakeet-tdt-0.6b-v3"
  }
}
```

## ONNX Model Path

Use `sherpa-onnx-node` for the first pass because it already has Node APIs for
speaker diarization and speaker identification.

Recommended starting models:

- segmentation: `sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx`
- embedding: `nemo_en_titanet_small.onnx`

Later model comparisons can include 3D-Speaker and WeSpeaker embeddings, but
the first implementation should keep one model pair until thresholds are tuned.

## Speaker Fingerprints

A speaker fingerprint is an embedding profile, not a cryptographic signature.

Enrollment flow:

1. Save enrollment clips under `data/diarization/speakers/enrollments/`.
2. Extract one embedding per clean clip.
3. L2-normalize each vector.
4. Store an averaged centroid in `profiles.json`.
5. Match runtime embeddings by cosine similarity.
6. Require both a minimum threshold and a margin over the second-best speaker.

Profile shape:

```json
{
  "speakerId": "aaron",
  "displayName": "Aaron",
  "model": "nemo_en_titanet_small",
  "embeddingDim": 192,
  "sampleCount": 4,
  "centroid": [0.0123, -0.0456],
  "createdAt": "2026-07-05T19:00:00.000Z",
  "updatedAt": "2026-07-05T19:00:00.000Z"
}
```

## Integration Points

Add narrow hooks at the existing `VadEndpoint`/receiver segment boundary. The
hooks should receive copied current segment audio as it streams through the
class, append it to the sidecar queue, and return immediately.

The hooks can run either:

- on segment start/data/end, using copied PCM frames; or
- as a simpler fallback, when the segment closes, using the complete PCM/WAV
  bytes.

Prefer the start/data/end queue first if the existing class exposes those events
cleanly. It proves the sidecar can queue the audio stream without changing the
current app path. If that creates too much risk, begin with closed-segment
enqueue and move to streaming queue ingestion in the next phase.

The sidecar job receives:

- source segment id
- copied segment audio frames or a sidecar-owned copied WAV path
- source WAV path
- source PCM path if available
- VAD close reason
- socket/user metadata allowed by existing auth rules
- raw ASR text when available, only for optional dominant-speaker MVP mode

The sidecar job must not:

- mutate transcript queue state
- send socket messages
- append normal message history
- post to workbench
- throw errors into the existing ASR path

## Phases

### Phase 1: File-Only Sidecar

- Add config/env with diarization enabled by default and explicit opt-out via
  `speakerDiarization.enabled=false` or `SPEAKER_DIARIZATION_ENABLED=0`.
- Add sidecar queue module.
- Tap segment start/data/end from the existing receiver/VAD class when
  available.
- Queue copied PCM frames into sidecar-owned temp files under
  `data/diarization/queue/`.
- On segment close, finalize the queued audio into the diarization folder.
- Write one metadata JSONL record per segment.
- No model inference yet.

### Phase 2: Speaker Labels

- Add `sherpa-onnx-node` wrapper.
- Run diarization on copied WAVs.
- Save speaker turns and speaker labels in `segments/<date>.jsonl`.
- Do not transcribe per turn yet.

### Phase 3: Diarized Transcripts

- Cut each diarized speaker turn to its own WAV.
- Send those turn WAVs through a sidecar ASR path.
- Save speaker-labelled transcript records to
  `transcripts/<date>.jsonl`.
- Keep existing ASR output unchanged.

### Phase 4: Enrollment And Known Speakers

- Add CLI enrollment command.
- Store profiles in `speakers/profiles.json`.
- Match speaker embeddings against known profiles.
- Save `matchedProfile`, `speakerId`, `displayName`, and confidence.

### Phase 5: Review Before Product Wiring

Only after the sidecar data is reliable:

- consider optional glasses/history display of speaker labels;
- consider using speaker labels in workbench routing;
- consider merging speaker-labelled transcripts into normal history.

Those are explicit future decisions, not part of the parallel MVP.

## Verification

For code changes touching only `local-receiver`, run:

```bash
npm --prefix local-receiver run check
```

For any future app/history display changes, also run:

```bash
npm --prefix app run build
npm --prefix app run test:history
```

The first acceptance test is simple: with diarization enabled, normal glasses
behavior and normal transcript logs stay byte-for-byte equivalent for the same
audio input, while new speaker-labelled records appear only under
`data/diarization/`.
