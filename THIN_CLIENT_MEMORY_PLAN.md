# Thin Client Memory Plan

## Implementation Status

Implemented:

- 100-character tail previews across receiver payloads and client display state
- full transcript/detail persistence on the receiver with compact live events
- newest-100 history on both sides with selected detail fetched on demand
- auth-safe history loading when Back is pressed, including requests that
  arrive before the thin client's user-authenticated `start` event
- a 64 KiB audio socket backlog circuit breaker
- one-in-flight/one-latest native render scheduling with a timeout
- active-only waveform timing and complete confirmed-exit cleanup
- suppression of SDK 0.0.10's full-object console log for every audio event
- cached history derivation and release of open detail on close
- lazy-loaded history navigation and font metrics

The production entry chunk is now 93.45 kB (36.71 kB gzip), down from
230.25 kB (70.71 kB gzip). The history/font chunk loads only when history is
opened.

Verification completed:

- `npm run check`
- `npm --prefix local-receiver run test:meemo-stream`
- a 100-entry/500-scroll post-GC stress run; retained heap increased by about
  152 kB
- a continuously active production-browser soak with 6,004 PCM events and
  2,388 transcript events; history remained at 100 entries, socket/render
  queues drained to zero, and post-GC heap was flat after warm-up (about 12 kB
  growth in the second half)

The active soak is intentionally independent of exit cleanup. Run
`ACTIVE_SOAK_SECONDS=600 npm run test:active-soak` for a longer accelerated
session, and use `window.__evenAudioPipeMemorySnapshot()` from a physical
device WebView inspector for on-device samples.

## Goal

Keep the Even Hub client small and stable during long audio sessions without
moving ASR, cleanup, persistence, routing, or secrets onto the client.

The client should display only a bounded preview of transient transcription
data. Complete raw and cleaned transcripts remain server-side and durable
history remains sourced from final transcript and agent summary events.

## Constraints

- Do not display unstable partial ASR text.
- Preserve authentication, transcript persistence, reconnect behavior, history
  navigation limits, and Even text-container limits.
- Prefer bounded state and deletion of redundant data over additional
  coordination flags.
- Keep full transcripts and agent details on the receiver.

## Verified Baseline

The following checks pass before implementation:

```text
npm --prefix app run build
npm --prefix app run test:endpoints
npm --prefix app run test:bundle-urls
npm --prefix app run test:speech-dispatch
npm --prefix app run test:startup-prompt
npm --prefix app run test:history
npm --prefix app run test:history:current
```

The current production bundle is 230.25 kB, or 70.71 kB gzip.

Current-day history reached 190 entries and 1,378 derived visual lines during
the audit. A heavier recorded day contains 750 entries and about 694,000 JSON
characters. A local Node stress proxy showed that repeated navigation through
that larger history creates substantial temporary allocation and leaves the
process RSS elevated after garbage collection. Absolute Node memory numbers do
not represent the Even WebView, but the allocation pattern is clear.

## Confirmed Risks

### 1. Outgoing audio has no backpressure

The client calls `WebSocket.send()` for every PCM chunk without checking
`bufferedAmount`. A slow or stalled connection can retain an unbounded amount
of stale audio in the WebView. The microphone watchdog counts calls to
`send()` rather than socket drainage, so it does not detect this condition.

### 2. Status rendering can create an unbounded promise chain

Each status update appends another closure to `statusRenderQueue`. If a native
`textContainerUpgrade` call never settles, waveform and status updates keep
extending that chain.

### 3. Transcription payloads contain redundant full strings

The receiver currently sends data the thin client does not need:

- final transcript: `text`, `cleanedText`, and `rawText`
- queued transcript: both `queuedText` and `text`
- agent summary: both `text` and `summary`, plus both `detail` and
  `detail_response`

The client briefly receives and parses every copy even when it only reads one.

### 4. Display-only transcript state is larger than necessary

The live display currently retains up to 364 characters. Other paths can
bypass that cap:

- a final transcript is briefly assigned to the DOM in full
- queued, sent, and saved text retain the full normalized value
- `lastTranscriptEventText` retains the latest full transcript indefinitely
- `deferredLiveTranscript` retains full agent detail even though only its text
  is later displayed

### 5. History is unbounded and repeatedly rebuilt

`MESSAGE_HISTORY_LIMIT` defaults to unlimited. The client also appends entries
without a local ceiling. `HistoryNavigator.currentItems()` repeatedly sorts,
normalizes, copies, and groups the complete history during navigation and some
closed-history state changes.

### 6. Normal exit does not run complete cleanup

`SYSTEM_EXIT_EVENT` currently returns without cleanup. The permanent waveform
interval runs even while speech processing is inactive, and cleanup does not
clear every timer.

### 7. Pixel-accurate text measurement raises baseline memory

`@evenrealities/pretext` embeds a large font metrics table. It is valuable for
safe glasses wrapping, so it should be optimized only after unbounded runtime
growth is removed.

## Implementation Plan

### P0: Bound live transcription display

Add a single display helper with a hard total limit:

```ts
const LIVE_TRANSCRIPT_PREVIEW_CHARS = 100

function transcriptPreview(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= LIVE_TRANSCRIPT_PREVIEW_CHARS
    ? normalized
    : `...${normalized.slice(-(LIVE_TRANSCRIPT_PREVIEW_CHARS - 3)).trimStart()}`
}
```

The leading ellipsis is included in the 100-character total. Apply the helper
before values enter any display-only client state:

- live transcript
- queued transcript
- sent or saved speech status
- `lastTranscriptEventText`
- deferred agent-summary display
- browser DOM transcript
- glasses live transcript

Remove the direct full-transcript DOM assignment. Reduce
`deferredLiveTranscript` to the preview text it actually uses, rather than
retaining unused label and detail fields. Clear `lastTranscriptEventText` once
the dispatch flow reaches a terminal state.

This is a display and client-retention rule only. It must not truncate
receiver-side persistence, ASR cleanup input, agent routing input, or saved
history.

### P0: Shrink receiver-to-client transcription messages

Keep raw and cleaned transcription data on the receiver. Send only the fields
used by the thin client:

```text
queued:       type, status, queuedTextPreview, job metadata
transcript:   type, textPreview, jobId, createdAt
agent status: type, status, agent, messagePreview
agent summary:type, agent, textPreview, phase/final metadata
```

Do not send `rawText`, duplicate cleaned text, or duplicate alias fields to the
thin client. Full transcript and agent detail remain in server persistence.
When full detail is required in history, retrieve it through the bounded
history path rather than carrying it in every live notification.

Add protocol tests asserting both the allowed keys and the 100-character
preview limit.

### P0: Bound audio socket backlog

Before sending PCM, inspect `WebSocket.bufferedAmount`. If it exceeds a small
stale-audio budget, do not enqueue another chunk. Close the socket and reuse
the existing reconnect flow.

Start with a 64 KiB threshold, which is approximately two seconds of
16 kHz/16-bit/mono audio. Confirm the threshold on the device rather than
adding a second buffer or client-side audio queue.

Track dropped chunks for diagnostics, but throttle DOM statistics updates so a
failed native microphone close does not create continuous UI allocation.

### P0: Make rendering bounded

Replace the promise chain with:

- at most one native render in flight
- at most one pending content string
- new updates replace the pending string
- a timeout around `textContainerUpgrade`

After the current render settles or times out, render the latest pending value
once. Cleanup clears pending render state. This preserves serialized bridge
writes without retaining one promise per waveform or status frame.

### P0: Complete lifecycle cleanup

- Run cleanup on confirmed `SYSTEM_EXIT_EVENT`.
- Keep abnormal-exit and `beforeunload` cleanup.
- Clear transcript, speech-dispatch, reconnect, watchdog, and waveform timers.
- Cancel pending render state.
- Disable audio, close the WebSocket, and unsubscribe from Even Hub events.
- Start waveform timing only while speech processing is active; stop it when
  processing ends.

Do not stop audio merely because the exit confirmation UI was opened. Cleanup
belongs on the confirmed system exit so canceling that UI leaves the session
active.

### P1: Bound and cache history

Use a distinct limit from the live character preview:

```text
RECENT_HISTORY_ENTRY_LIMIT = 100
```

- Make the receiver return at most the newest 100 entries by default.
- Request current-day history from the receiver whenever Back opens history.
- If that request arrives before Even user authentication, retain one pending
  request and fulfill it immediately after the allowed user is accepted.
- Defensively apply the same ceiling when the client replaces history.
- Trim client history after every append.
- Avoid building navigation items while history is closed.
- Cache derived entry items and invalidate the cache only when entries change.
- Do not repeatedly normalize and concatenate all details during one scroll.

If access to older same-day entries is required, add cursor-based receiver
paging. Do not restore full-day client loading.

For large agent output, send compact history-list data first and fetch the
selected detail on demand. Release selected detail when the view closes.

### P2: Reduce static baseline after runtime growth is bounded

- Split dependency-free text normalization from history layout.
- Lazy-load history navigation and `@evenrealities/pretext` when history first
  opens.
- If device measurements still require it, evaluate a smaller metrics export
  with a conservative fallback for unsupported characters.

Do not replace pixel-accurate wrapping until the physical-device history tests
show that the alternative preserves container safety.

## Verification

### Automated

- Run every baseline command listed above.
- Add tests for exactly 100 total preview characters, including the ellipsis.
- Cover live, queued, sent, saved, deferred, and final transcript paths.
- Assert thin-client payloads do not contain raw or duplicate transcript fields.
- Test history replacement and append behavior above 100 entries.
- Test that history requested before user authentication is withheld until the
  allowed user's `start` event and then returned on the same socket.
- Test render coalescing with a bridge promise that never resolves.
- Test socket backpressure at and above the configured threshold.
- Test cleanup idempotence for system, abnormal, and unload exits.

### Physical-device soak

Exercise:

1. normal streaming
2. slow or unavailable receiver
3. stalled native text rendering
4. repeated queued and final transcripts
5. heavy history scrolling
6. normal and abnormal exits

Acceptance criteria:

- WebSocket backlog never exceeds the configured budget for more than one
  event turn before reconnect begins.
- Render state never exceeds one in-flight and one pending value.
- No display-only transcript string exceeds 100 characters.
- Client history never exceeds 100 entries.
- Memory plateaus after warm-up rather than rising with each transcript or
  scroll.
- Confirmed exit leaves no microphone stream, socket, subscription, or active
  timer.
