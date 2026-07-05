# Thin Client Audio Relay Plan

## Goal

Turn the Even Hub app into a thin, reliable, bidirectional client:

```text
Even G2 microphone
  -> uploaded Even Hub WebView app
  -> one authenticated WebSocket
  -> audio relay server
  -> server-side VAD / ASR / cleanup / routing
  -> speech-agent-workbench
  -> same WebSocket sends display/history/detail events back
  -> Even Hub app writes updates to the G2 display
```

The uploaded app should only capture audio, send it to a configured server, keep
the connection alive, recover from disconnects, and render server events to the
glasses. The server owns all durable session state and all intelligence.

## Current Local Implementation

From the repository root, `npm run start` currently runs the local version of
both sides:

```text
npm run start
  -> starts the local receiver/audio relay backend
  -> starts the ASR worker unless disabled
  -> starts the Vite thin-client app
  -> prints an Even Hub QR code
  -> QR bootstraps private=LAN_IP:8788
  -> QR bootstraps public=PUBLIC:PORT when configured
  -> QR includes a legacy dev token when local auth is enabled
```

The thin client stores private IP, private port, public IP, public port, and the
shared secret in Even/browser local storage. It attempts the private `ws://`
receiver first and then the public `wss://` receiver if private cannot open.
Users can also edit both endpoints in the client page and save them without
rebuilding the app. Endpoint parsing/building is isolated in
`app/src/audioEndpoints.ts`; the client still only handles endpoint setup, auth,
audio streaming, and display/history rendering.

`speech-agent-workbench` is not started by this repo. It still runs separately,
and the receiver talks to it through the configured local workbench URL.
Workbench command parsing/routing is server-side in
`local-receiver/workbench-router.js`.

## Intent

- Make the uploaded Even app simple enough to package and maintain.
- Keep all secrets for ASR, cleanup models, and `speech-agent-workbench` on the
  server side.
- Use one WebSocket for audio upload, status, summaries, history, and details.
- Support both local LAN development and a WAN/public endpoint.
- Recover after phone sleep, WebView reload, Wi-Fi changes, server restarts, and
  temporary network failures.
- Let the glasses show the latest summary and fetch detail/history after
  reconnect.

## Non-Goals

- The client does not run VAD, ASR, transcript cleanup, command routing, or
  workbench calls.
- The server does not connect directly to the glasses. It only talks to the
  Even WebView client.
- The system does not recover audio spoken while the WebView was suspended and
  not capturing microphone data.
- The uploaded app does not expose `speech-agent-workbench` directly.
- The shared secret is not placed in the WebSocket URL.

## High-Level Components

### Thin Even Client

Responsibilities:

- Stores endpoint URL, client id, session id, last received server sequence, and
  optionally the shared secret.
- Connects to `ws://LAN:8788/audio` for local development or
  `wss://PUBLIC_DOMAIN/audio` for uploaded/private builds.
- Authenticates after socket open when shared-secret auth is configured.
- Sends audio frames with sequence numbers.
- Sends heartbeat pings and detects stale sockets.
- Reconnects automatically with capped exponential backoff.
- Sends `resume` after reconnect.
- Dedupe/replays server events by `serverSeq` or `eventId`.
- Renders summaries, statuses, history, and detail pages to the glasses display
  using the Even Hub SDK.

### Audio Relay Server

Responsibilities:

- Binds locally, usually `0.0.0.0:8788`.
- Advertises both LAN and public endpoints.
- Loads a token and/or shared secret from config/env.
- Authenticates the WebSocket before accepting audio.
- Tracks sessions, sequence numbers, display state, and replayable events.
- Runs VAD / ASR / cleanup / workbench routing.
- Stores summaries and details.
- Replays missed server events on resume.
- Answers history/detail queries over the same socket.

### Speech Workbench

Responsibilities:

- Stays behind the relay server.
- Receives server-side `POST /messages`.
- Posts summary/detail back to the relay server or returns it through the server
  integration path.

## Configuration

Use runtime endpoint configuration. The thin client stores two addresses:

- `lanAddress`: local IP/host plus port, tried first.
- `wanAddress`: public/WAN domain or IP plus port, tried second.

The app should not require a build-time `.env` value to know where to connect.
The launcher can bootstrap the two addresses through QR query parameters, and
the client persists them in browser storage. Users can also edit the two
addresses from the app setup screen.

Accepted client input examples:

```text
LAN: 192.168.1.50:8788
WAN: even-audio.example.com
WAN: wss://even-audio.example.com/audio
```

Normalization rules:

- LAN `host:port` becomes `ws://host:port/audio`.
- WAN `host:port` becomes `wss://host:port/audio`.
- Full `ws://` or `wss://` URLs are used as-is, with `/audio` added when no
  path is present.
- `http://` and `https://` are converted to `ws://` and `wss://`.

Server config still advertises the addresses and controls the defaults:

```json
{
  "server": {
    "bindHost": "0.0.0.0",
    "port": 8788,
    "audioPath": "/audio",
    "healthPath": "/health"
  },
  "network": {
    "lanHost": "auto",
    "publicUrl": "",
    "publicWsUrl": ""
  },
  "client": {
    "tryOrder": ["lan", "wan"],
    "rememberAddresses": true,
    "heartbeatMs": 10000,
    "staleSocketMs": 30000,
    "audioBufferMs": 5000,
    "maxBufferedSocketBytes": 524288
  },
  "auth": {
    "mode": "shared_secret",
    "promptForSecret": true,
    "secretHash": "",
    "kdf": "pbkdf2_sha256",
    "iterations": 210000,
    "salt": ""
  },
  "workbench": {
    "enabled": true,
    "url": "http://127.0.0.1:8787",
    "agents": ["Flux", "Brock", "Pike", "Wolf"],
    "requireAgentPrefix": true,
    "summaryPath": "/workbench/summary"
  }
}
```

Environment overrides are for server startup and QR bootstrap, not the primary
client source of truth:

```bash
EVEN_AUDIO_PIPE_LAN_HOST=192.168.1.50 \
EVEN_AUDIO_PIPE_PUBLIC_URL=https://even-audio.example.com \
EVEN_AUDIO_SECRET_PROMPT=1 \
npm start
```

The generated QR should include runtime endpoint hints:

```text
http://192.168.1.50:5173?t=TOKEN
  &lan=ws%3A%2F%2F192.168.1.50%3A8788%2Faudio
  &wan=wss%3A%2F%2Feven-audio.example.com%2Faudio
```

On first launch, the client stores:

```json
{
  "lanAddress": "ws://192.168.1.50:8788/audio",
  "wanAddress": "wss://even-audio.example.com/audio"
}
```

Startup output should make both endpoint choices obvious:

```text
Even Audio Relay

LAN:
  Audio WS:  ws://192.168.1.50:8788/audio
  App URL:   http://192.168.1.50:5173

Public:
  Audio WSS: wss://even-audio.example.com/audio
  App URL:   https://even-audio.example.com

Auth:
  Shared secret: prompted at server startup
  Client must enter the same secret

Workbench:
  API:       http://127.0.0.1:8787/messages
```

## Shared Secret Auth

The client should not send the raw secret. It also should not send a reusable
plain hash as the only credential because that hash becomes the password.

Implemented shared-secret flow:

1. Client opens the socket.
2. Server sends a random nonce.
3. Client signs the nonce with `HMAC-SHA256` using the typed shared secret.
4. Client sends the nonce and HMAC proof.
5. Server verifies the proof.
6. Server accepts audio only after `auth_status` reports `accepted`.

Server challenge:

```json
{
  "type": "auth_challenge",
  "mode": "shared-secret",
  "nonce": "server-random-base64url",
  "algorithm": "hmac-sha256"
}
```

Client auth:

```json
{
  "type": "auth",
  "nonce": "server-random-base64url",
  "proof": "base64url(hmac_sha256(shared_secret, nonce))",
  "algorithm": "hmac-sha256"
}
```

Server accept:

```json
{
  "type": "auth_status",
  "status": "accepted",
  "mode": "shared-secret",
  "transport": true
}
```

Rules:

- Server rejects all messages except `auth` before authentication.
- Server closes unauthenticated sockets after a short timeout.
- Legacy QR/dev URLs may still authenticate with `?t=TOKEN`.
- Server should use `wss://` for public/WAN use.
- Local `ws://` is acceptable only for trusted LAN development.
- Server can prompt for the secret at startup and keep it only in memory.
- Hosted deployments should use an environment variable or secret manager.

## WebSocket Protocol

One socket handles everything.

Client to server:

- `auth`
- `start`
- `audio`
- `ping`
- `resume`
- `get_latest_summary`
- `get_history`
- `get_detail`
- `stop`

Server to client:

- `auth_challenge`
- `auth_status`
- `receiver_status`
- `status`
- `transcript`
- `agent_summary`
- `asr_status`
- `agent_status`
- `display`
- `message_history`
- `detail`
- `resume_ack`
- `pong`
- `error`

Current speech status display uses existing events rather than another client
routing path:

```text
asr_status: queued
  -> Queued: combined transcript
transcript
  -> durable history append, queued live text remains
agent_status: sent
  -> Sent: Agent, message for 2s
agent_status: missing_agent_prefix/workbench_disabled/workbench_unconfigured
  -> Saved: transcript for 2s
agent_summary
  -> durable response history and live response after any active terminal hold
```

The full flow is documented in
[`INTERACTION_FLOW_AND_STATUS.md`](INTERACTION_FLOW_AND_STATUS.md).

### Start

```json
{
  "type": "start",
  "sessionId": "sess_abc",
  "clientId": "client_7f6c4f",
  "appVersion": "0.1.0",
  "device": "g2",
  "encoding": "pcm_s16le",
  "sampleRate": 16000,
  "channels": 1
}
```

### Audio Frame

MVP JSON form:

```json
{
  "type": "audio",
  "seq": 42,
  "timestampMs": 1782686726557,
  "pcmBase64": "..."
}
```

Production binary form:

```text
byte 0      frame type: 0x01 audio
bytes 1-8   uint64 clientSeq
bytes 9-16  uint64 timestampMs
bytes 17..  PCM s16le payload
```

Design decision:

- JSON audio is easier to debug and good for early development.
- Binary audio is more efficient and should be used for production or long
  sessions.

### Server Events

All replayable server events carry ordering:

```json
{
  "type": "agent_summary",
  "serverSeq": 18,
  "eventId": "evt_123",
  "sessionId": "sess_abc",
  "agent": "Flux",
  "summaryId": "sum_456",
  "summary": "Created SIM-317 and removed the Markdown file.",
  "detailAvailable": true
}
```

The client stores `lastServerSeq = 18` after rendering or caching the event.

## Auto Reconnect

The client needs a dedicated connection manager with a state machine:

```text
idle
  -> connecting
  -> authenticating
  -> connected
  -> streaming
  -> reconnecting
  -> authenticating
  -> resuming
  -> streaming
  -> closed
```

Reconnect triggers:

- WebSocket close without intentional `stop`.
- Heartbeat timeout.
- Browser online/offline event.
- WebView resume after pause.
- Server sends `reconnect_required`.

Endpoint order:

```text
attempt 1: LAN address
attempt 2: WAN address
attempt 3: LAN address
attempt 4: WAN address
...
```

If a socket opens and later drops, the next recovery cycle starts from LAN
again. That keeps same-Wi-Fi/local use fast while still allowing the uploaded
app to escape to the WAN endpoint when LAN is unreachable.

Backoff:

```text
250ms -> 500ms -> 1s -> 2s -> 5s -> 10s -> 10s...
```

Reset the backoff after 30 seconds of stable connection.

Heartbeat:

```json
{
  "type": "ping",
  "clientTimeMs": 1782686726557
}
```

```json
{
  "type": "pong",
  "serverTimeMs": 1782686727000
}
```

If no server message or pong arrives within `staleSocketMs`, close and reconnect.

## Resume And Recovery

The server is authoritative. The client can rebuild display state after a reload
or reconnect.

Client resume:

```json
{
  "type": "resume",
  "sessionId": "sess_abc",
  "clientId": "client_7f6c4f",
  "lastClientSeq": 1220,
  "lastServerSeq": 18
}
```

Server resume response:

```json
{
  "type": "resume_ack",
  "sessionId": "sess_abc",
  "serverSeq": 24,
  "accepted": true,
  "currentDisplay": {
    "mode": "summary",
    "text": "Flux created SIM-317 and removed the Markdown file.",
    "summaryId": "sum_456"
  },
  "missedEvents": [
    {
      "type": "agent_summary",
      "serverSeq": 22,
      "eventId": "evt_123",
      "summaryId": "sum_456",
      "agent": "Flux",
      "summary": "Flux created SIM-317 and removed the Markdown file."
    }
  ]
}
```

Recovery behavior:

- Client renders `currentDisplay` immediately.
- Client applies `missedEvents` in `serverSeq` order.
- Client dedupes events already seen.
- If resume is rejected, client starts a new session but can still request
  latest summary/history by `clientId` or user identity.

Recoverable:

- Missed summaries.
- Missed final transcripts.
- Latest display state.
- History list.
- Detail pages.
- Workbench results that completed while disconnected.

Not recoverable:

- Audio spoken while the WebView was not running.
- Audio frames dropped because the network was down and the client buffer
  overflowed.
- Real-time display updates while the client is suspended.

## Sending Data Back To The Glasses

The server cannot update the glasses directly. The server sends display events
to the client, and the client writes to the G2 display through the Even Hub SDK.

Server display event:

```json
{
  "type": "display",
  "serverSeq": 25,
  "eventId": "evt_display_25",
  "mode": "summary",
  "text": "Flux created SIM-317 and removed the Markdown file.",
  "summaryId": "sum_456"
}
```

Client display modes:

- `idle`: dots.
- `listening`: connected and waiting for speech.
- `speech_detected`: waiting spinner.
- `transcribing`: ASR in progress.
- `sending`: workbench request in progress.
- `transcript`: cleaned user text.
- `summary`: agent summary.
- `error`: short actionable error.

Design decision:

- The glasses display should show short text only.
- Long details are fetched on demand when the user opens detail view.
- Client caches recently fetched summaries/details for fast navigation, but the
  server remains source of truth.

## History And Detail Queries

The client can query the same socket after reconnect.

Latest summary:

```json
{
  "type": "get_latest_summary",
  "sessionId": "sess_abc"
}
```

History:

```json
{
  "type": "get_history",
  "sessionId": "sess_abc",
  "limit": 20
}
```

Detail:

```json
{
  "type": "get_detail",
  "summaryId": "sum_456"
}
```

Paged detail response:

```json
{
  "type": "detail_page",
  "serverSeq": 28,
  "summaryId": "sum_456",
  "page": 0,
  "hasMore": true,
  "text": "Created Linear ticket SIM-317...\n..."
}
```

Design decision:

- Summary events are pushed automatically.
- Details are pulled on demand.
- History can be replayed from server state rather than relying on client local
  storage.

## Backpressure And Audio Buffering

Client-side rules:

- Keep a small PCM ring buffer, for example 3-5 seconds.
- If socket is connected but `bufferedAmount` exceeds
  `maxBufferedSocketBytes`, drop oldest unsent audio frames and increment a
  dropped-frame counter.
- If disconnected, buffer only up to `audioBufferMs`.
- On reconnect, optionally send buffered frames only if they are recent enough
  to still be useful.
- Never freeze the display or UI trying to send stale audio.

Server-side rules:

- Detect missing client audio sequence numbers.
- Record gaps for debugging.
- Continue VAD/ASR through small gaps.
- Close or throttle clients that consistently exceed server limits.

Design decision:

- Audio delivery is best effort.
- Server event delivery is replayable.
- Workbench command delivery must be idempotent.

## Idempotency

Server creates a command id before posting to workbench:

```json
{
  "commandId": "cmd_789",
  "agent": "Flux",
  "message": "create the Linear ticket"
}
```

Rules:

- A command id can be posted to workbench once.
- If server retries, it uses the same `commandId`.
- If reconnect causes transcript replay, the server must not create a duplicate
  workbench command for the same transcript batch.
- Summary records link back to `commandId`.

## Security Decisions

- Use `wss://` for public/WAN.
- Do not put secrets in URLs.
- Do not expose workbench to the client.
- Authenticate before accepting audio.
- Keep server-side secrets in memory, environment variables, or a secret
  manager.
- Persist only derived secret hashes if storing credentials.
- Add rate limits per client id and IP.
- Consider rotating the shared secret if a device is lost.

## Gotchas And Limitations

- A WebView cannot receive server pushes while fully suspended.
- The glasses cannot query the server without the Even app running.
- Resume can show missed summaries after reconnect, but cannot show them during
  suspension.
- Local LAN `ws://` may fail if the phone is on cellular, guest Wi-Fi, VPN, or
  a network with client isolation.
- Public upload should use a domain and `wss://`; raw WAN IP with `ws://` is
  fragile and insecure.
- If the server process restarts without persisted session/event state, resume
  can only return data that was written to disk/database.
- If the client sends a reusable hash instead of a nonce proof, that hash is
  effectively the password.
- Long detail output must be paged or wrapped carefully to fit the glasses text
  limits.
- Audio generated while disconnected is only recoverable if the client captured
  and buffered it.

## Example End-To-End Flow

1. Server starts and prompts:

```text
Enter Even Audio shared secret:
```

2. Server prints:

```text
LAN Audio WS:  ws://192.168.1.50:8788/audio
Public WSS:    wss://even-audio.example.com/audio
```

3. Client connects to selected endpoint.
4. Server sends `auth_challenge`.
5. Client sends `auth`.
6. Server sends `auth_ok`.
7. Client sends `start`.
8. Client streams audio frames.
9. Server detects speech, transcribes, and routes:

```text
"Flux create the Linear ticket"
```

10. Server sends:

```json
{
  "type": "display",
  "serverSeq": 14,
  "mode": "sending",
  "text": "Sending to Flux..."
}
```

11. Workbench completes.
12. Server stores summary/detail and sends:

```json
{
  "type": "agent_summary",
  "serverSeq": 15,
  "summaryId": "sum_456",
  "agent": "Flux",
  "summary": "Created SIM-317 and deleted the Markdown source file.",
  "detailAvailable": true
}
```

13. Client renders the summary to the G2.
14. Client disconnects because the phone sleeps.
15. Workbench sends a late detail update, and server stores it.
16. Client resumes, reconnects, authenticates, and sends:

```json
{
  "type": "resume",
  "sessionId": "sess_abc",
  "lastServerSeq": 15
}
```

17. Server responds with current display and missed events.
18. User opens detail view on glasses.
19. Client sends `get_detail`.
20. Server sends paged detail text.

## Implementation Milestones

### Milestone 1: Protocol Skeleton

- Define TypeScript message schemas for client/server events.
- Add `serverSeq`, `eventId`, `sessionId`, and `clientSeq`.
- Keep current local receiver behavior behind the same `/audio` path.

Acceptance criteria:

- Client can authenticate.
- Server rejects unauthenticated audio.
- Server sends accepted `auth_status`.

### Milestone 2: Thin Client Split

- Create `ConnectionManager`.
- Create `AudioStreamer`.
- Create `DisplayController`.
- Remove direct workbench assumptions from client code.

Acceptance criteria:

- Client only knows endpoint, auth, audio streaming, and display rendering.

### Milestone 3: Reconnect And Heartbeat

- Add ping/pong.
- Add stale-socket detection.
- Add capped backoff reconnect.
- Persist `clientId`, `sessionId`, and `lastServerSeq`.

Acceptance criteria:

- Killing the receiver and restarting it causes the client to reconnect without
  app reload.

### Milestone 4: Server Session Manager

- Track sessions by `sessionId`.
- Store outbound event log.
- Store latest display state.
- Track last received `clientSeq`.

Acceptance criteria:

- Client can reconnect and receive a `resume_ack`.

### Milestone 5: Replayable Summaries And Detail Pull

- Store summaries and details on server.
- Add `get_latest_summary`, `get_history`, and `get_detail`.
- Page long details.

Acceptance criteria:

- Client can recover latest summary after reconnect and fetch detail on demand.

### Milestone 6: Workbench Idempotency

- Add `commandId`.
- Prevent duplicate workbench POSTs for the same transcript batch.
- Link summaries to command ids.

Acceptance criteria:

- Reconnect during command send does not duplicate a workbench action.

### Milestone 7: LAN/Public Packaging

- Print LAN and public endpoints.
- Bootstrap LAN/WAN addresses into the client through QR query params.
- Store editable LAN/WAN addresses in browser storage.
- Generate matching `app.json` network whitelist.

Acceptance criteria:

- Local QR stores LAN first and WAN second when both are configured.
- Client attempts LAN before WAN on reconnect.
- Uploaded private build works after the user enters or bootstraps the public
  WSS endpoint.

### Milestone 8: Failure Testing

Test cases:

- Wrong secret.
- Server unavailable at startup.
- Server restart during audio.
- Server restart after workbench command, before summary delivery.
- Client sleep and reconnect.
- Detail query after reconnect.
- Network change from Wi-Fi to cellular.
- Socket backpressure.
- Long detail paging.

Acceptance criteria:

- Client shows a clear reconnecting state.
- Client recovers latest display state after reconnect.
- Server does not duplicate workbench commands.
- Long details remain readable on the glasses.
