# Even Audio Pipe

Even Audio Pipe is a local captioning prototype for Even Realities G2 glasses.
It streams microphone PCM audio from an Even Hub WebView app to a local receiver,
transcribes utterance chunks with a local ASR worker, and sends the latest
transcript segment back to the glasses display.

```text
G2 mic
  -> Even phone app
  -> Even Hub WebView app
  -> local WebSocket receiver
  -> local ASR worker
  -> transcript WebSocket event
  -> glasses text container
```

The glasses display intentionally behaves like live captions:

- Shows only the most recent final transcript segment.
- Clears after 5 seconds without new transcript text.
- Shows a small idle dot animation (`.`, `..`, `...`, `..`) while waiting.

## Runtime Flow

The receiver has two separate queues that are easy to mix up:

- The STT batch queue combines raw transcript segments for cleanup, file
  writes, and glasses display.
- The workbench command queue decides when a command has been sent to
  `speech-agent-workbench` and can be consumed.

The current flow is:

```text
G2 mic audio
  -> WebSocket receiver
  -> VAD audio segment closes
  -> ASR worker returns final text for that segment
  -> non-empty STT text is appended to the STT batch queue
  -> 5 seconds with no newer STT text or VAD speech
  -> no active audio segment and no pending ASR job
  -> or transcriptQueue.maxHoldMs is reached
  -> queued raw text is combined
  -> transcript cleanup runs once for the combined text
  -> transcript files and transcripts.log are written
  -> cleaned text is sent to the glasses
  -> cleaned text is evaluated by the workbench command queue
```

The 5 second wait is based on the last non-empty STT result or later VAD speech
activity. VAD silence and background audio below the speech threshold do not
reset the timer. That wait only makes the queued text eligible to flush. The
receiver still holds the queue if the same glasses connection has an open audio
segment or an ASR job waiting/running, so a command is not sent while the user
is still speaking into a segment that has not produced its transcript yet. To
avoid getting stuck on noisy background audio, `transcriptQueue.maxHoldMs`
caps how long VAD speech, active audio, or pending ASR can hold already queued
transcript text.

Workbench routing then behaves like this when `requireAgentPrefix` is enabled:

```text
Cleaned transcript starts with agent + message
  -> POST /messages with { agent, message }
  -> when the POST succeeds, flush/consume the workbench command state

Cleaned transcript is exactly an agent name, for example "Pike"
  -> do not POST yet
  -> keep that agent armed in the workbench command queue

Next flushed transcript arrives while an agent is armed
  -> POST /messages with the armed agent and the new transcript as message
  -> when the POST succeeds, flush/consume the armed agent

Cleaned transcript has no agent and no armed agent
  -> save/display transcript only
  -> skip workbench POST

Armed agent expires before a command is sent
  -> clear the armed agent after agentArmTimeoutMs
```

This means `Pike update the heading` posts after the 5 second STT/VAD idle flush.
`Pike` followed by `update the heading` also posts, but only if the second
flushed transcript arrives before `agentArmTimeoutMs` expires. In both command
cases, the workbench command queue is flushed when `/messages` succeeds. Ambient
speech without an agent prefix is still saved and shown on the glasses, but it
is not sent to the workbench.

Workbench responses return on the separate summary webhook:

```text
speech-agent-workbench
  -> POST /workbench/summary
  -> receiver validates summaryToken when configured
  -> summary/text is sent to connected glasses
```

## Requirements

- Node.js 20 or newer.
- npm.
- Python 3.10 or newer with `venv`.
- `ffmpeg` available on `PATH`.
- Even app / Even Hub capable of loading a local development QR code.
- Phone and computer on the same LAN, VPN, or tunnel-reachable network.

The default ASR worker installs `onnx-asr[cpu,hub]`, `soundfile`, and `numpy`
into `asr-worker/.venv` on first run. Model files are downloaded by `onnx-asr`
according to its own cache behavior.

## Quick Start

From this folder:

```bash
npm start
```

The launcher will:

1. Detect a non-loopback IPv4 address for this computer.
2. Install app and receiver npm dependencies if missing.
3. Read local storage settings from `config.json` when present.
4. Generate `app/.env.local` with the WebSocket URL.
5. Generate `app/app.json` from `app/app.example.json` with the correct network whitelist.
6. Create/install the local ASR Python environment if needed.
7. Start the ASR worker, receiver, and Vite dev server.
8. Print an Even Hub QR code to scan in the Even app.

If auto-detection chooses the wrong interface:

```bash
EVEN_AUDIO_PIPE_HOST=192.168.1.100 npm start
```

Useful port overrides:

```bash
EVEN_AUDIO_PIPE_APP_PORT=5173 \
EVEN_AUDIO_PIPE_RECEIVER_PORT=8788 \
EVEN_AUDIO_PIPE_ASR_PORT=8790 \
npm start
```

## Storage Configuration

Local storage paths are configured in `config.json`. The file is ignored by git
so users can set machine-specific paths without committing private locations.

Create it from the tracked example:

```bash
cp config.example.json config.json
```

Default config:

```json
{
  "auth": {
    "enabled": true,
    "token": "",
    "tokenSecret": "",
    "tokenUserId": "",
    "allowedUserIds": [],
    "lastUser": null,
    "scannedUsers": []
  },
  "storage": {
    "audioDir": "data/audio",
    "transcriptDir": "data/transcripts",
    "transcriptsLog": "data/transcripts/transcripts.log"
  },
  "workbench": {
    "enabled": false,
    "url": "http://127.0.0.1:8787",
    "token": "",
    "agent": "",
    "agents": [
      "Flux",
      "Brock",
      "Pike",
      "Wolf"
    ],
    "requireAgentPrefix": true,
    "agentPrefixWordLimit": 3,
    "agentArmTimeoutMs": 30000,
    "timeoutMs": 15000,
    "summaryPath": "/workbench/summary",
    "summaryToken": ""
  },
  "transcriptQueue": {
    "idleMs": 5000,
    "maxHoldMs": 10000
  },
  "transcriptCleanup": {
    "enabled": false,
    "url": "http://127.0.0.1:8080/v1/chat/completions",
    "model": "gemma-4-e4b-it-q4_0",
    "temperature": 0,
    "timeoutMs": 15000,
    "required": false,
    "prompt": "You clean short ASR transcript chunks from smart glasses. Fix obvious speech recognition errors, capitalization, punctuation, and light grammar only. Always rewrite the misheard phrases \"ling few\", \"lane view\", and \"lanefuse\" as \"Langfuse\". Preserve the speaker's meaning and wording. Do not add facts, commands, explanations, or markdown. If uncertain, keep the original wording. Return only the cleaned transcript text.",
    "llamaCpp": {
      "autoStart": false,
      "repoUrl": "https://github.com/ggml-org/llama.cpp.git",
      "repoDir": "tools/llama.cpp",
      "buildDir": "build-rocm",
      "serverHost": "127.0.0.1",
      "serverPort": 8080,
      "hfModel": "google/gemma-4-E4B-it-qat-q4_0-gguf:Q4_0",
      "alias": "gemma-4-e4b-it-q4_0",
      "gpuLayers": 999,
      "contextSize": 8192,
      "parallel": 1,
      "rocmArch": "",
      "extraCmakeArgs": [],
      "extraServerArgs": [],
      "reuseUrls": []
    }
  }
}
```

Paths may be relative to the repo root or absolute. `audioDir` stores `.pcm` and
`.wav` files. `transcriptDir` stores per-segment `.txt` files. `transcriptsLog`
stores the append-only transcript log.

Use a different config file:

```bash
EVEN_AUDIO_PIPE_CONFIG=/path/to/config.json npm start
```

Environment variables override `config.json`:

```bash
AUDIO_DIR=/path/to/audio \
TRANSCRIPT_DIR=/path/to/transcripts \
TRANSCRIPTS_LOG=/path/to/transcripts/transcripts.log \
npm start
```

## Local QR Auth

The launcher enables local access-token auth by default. It puts a token in the
QR URL and passes the same token to the receiver. The app copies the launch
token into the WebSocket URL:

```text
QR URL:  http://YOUR_COMPUTER_IP:5173?t=TOKEN
Audio:   ws://YOUR_COMPUTER_IP:8788/audio?t=TOKEN
```

The receiver rejects `/audio` WebSocket connections without the matching token.
This is local LAN protection; anyone who can see the QR URL can use the token.

Use a local UID hash token:

```json
{
  "auth": {
    "enabled": true,
    "tokenSecret": "local-secret-value",
    "tokenUserId": "12345",
    "allowedUserIds": ["12345"]
  }
}
```

When `auth.tokenSecret` and a UID are configured, the launcher uses
`HMAC-SHA256(uid, tokenSecret)` as the QR/audio token. You can also pass the
secret with `EVEN_AUDIO_PIPE_TOKEN_SECRET`. The UID is read from
`EVEN_AUDIO_PIPE_AUTH_UID`, `auth.tokenUserId`, the first `auth.allowedUserIds`
entry, or `auth.lastUser.uid`. This hash token takes precedence over
`auth.token`.

Use a stable token:

```json
{
  "auth": {
    "enabled": true,
    "token": "change-me",
    "allowedUserIds": [],
    "lastUser": null,
    "scannedUsers": []
  }
}
```

Restrict to specific Even users:

```json
{
  "auth": {
    "enabled": true,
    "token": "change-me",
    "allowedUserIds": ["12345"]
  }
}
```

The app sends `bridge.getUserInfo()` in the initial WebSocket `start` message.
Even Hub currently documents `uid`, `name`, `avatar`, and `country`; it does
not document an email field or a signed user token for plugin apps. The receiver
logs the discovered user and saves it back into `config.json` as `auth.lastUser`
and `auth.scannedUsers` on each QR/WebSocket startup:

```text
[auth] even user received: uid=12345
[auth] accepted Even user: uid=12345
```

If `auth.allowedUserIds` is non-empty, the receiver closes the WebSocket unless
the reported Even user `uid` matches. Email is not used for Even user
authorization because the current SDK docs and observed runtime payload do not
provide it. User info is not a signed token, so for internet proxying keep QR
token auth enabled and use HTTPS/WSS at the proxy layer.

Disable local token auth:

```bash
EVEN_AUDIO_PIPE_AUTH=off npm start
```

## ASR Configuration

Disable local ASR and record audio only:

```bash
EVEN_AUDIO_PIPE_ASR=off npm start
```

Use an existing Python environment:

```bash
EVEN_AUDIO_PIPE_ASR_PYTHON=/path/to/python npm start
```

Use an external ASR worker:

```bash
ASR_WORKER_URL=http://127.0.0.1:8790 npm start
```

Change the Parakeet ONNX model settings:

```bash
PARAKEET_ONNX_MODEL=nemo-parakeet-tdt-0.6b-v3 \
PARAKEET_ONNX_QUANTIZATION=int8 \
npm start
```

## Transcript Cleanup

Final ASR chunks are queued as raw transcript text before cleanup. Each new
non-empty ASR result or later VAD speech activity resets `transcriptQueue.idleMs`;
when no new STT transcript text or VAD speech arrives for 5 seconds by default
and no audio segment or ASR job is still active, the queued raw text is
combined, sent through transcript cleanup once, then forwarded to the workbench.
If noisy background keeps VAD active, `transcriptQueue.maxHoldMs` defaults to
10000 milliseconds and forces the queued text to flush after that cap.

Transcript cleanup is an optional post-ASR stage. It sends each final ASR
segment to an OpenAI-compatible chat completions endpoint, writes both the raw
and cleaned transcript, and displays the cleaned text on the glasses.

Enable Gemma 4 E4B QAT GGUF through llama.cpp:

```json
{
  "transcriptCleanup": {
    "enabled": true,
    "prompt": "You clean short ASR transcript chunks from smart glasses...",
    "llamaCpp": {
      "autoStart": true,
      "hfModel": "google/gemma-4-E4B-it-qat-q4_0-gguf:Q4_0",
      "alias": "gemma-4-e4b-it-q4_0"
    }
  }
}
```

When `autoStart` is enabled, `npm start` will:

1. Reuse the configured cleanup endpoint when `/v1/models` is already reachable.
2. Probe any `llamaCpp.reuseUrls` endpoints and reuse the first reachable server.
3. Clone llama.cpp into `tools/llama.cpp` if no reusable server is found.
4. Build `llama-server` with ROCm using CMake and `-DGGML_HIP=ON`.
5. Start `llama-server` on the configured host and port.
6. Wait for `http://127.0.0.1:8080/v1/models`.
7. Send cleanup requests to `/v1/chat/completions`.

If cleanup cannot be reused or started, the app keeps running with raw ASR
transcripts unless `transcriptCleanup.required` is set to `true`.

Changes to `transcriptCleanup.prompt` in `config.json` are picked up by the
receiver on the next cleanup request. You do not need to restart for prompt-only
edits.

Prerequisites for the automatic llama.cpp path:

- ROCm HIP SDK installed and `hipconfig` on `PATH`.
- `cmake`, `git`, and a working C++ build toolchain.
- Network access to Hugging Face, and access to the configured Gemma model.

Set `llamaCpp.rocmArch` when auto-detection is wrong, for example:

```json
{
  "transcriptCleanup": {
    "llamaCpp": {
      "rocmArch": "gfx1100"
    }
  }
}
```

Use an existing cleanup server instead of the managed llama.cpp server:

```json
{
  "transcriptCleanup": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "gemma-4-e4b-it-q4_0",
    "llamaCpp": {
      "autoStart": false
    }
  }
}
```

Reuse one of several already-running llama.cpp servers before building:

```json
{
  "transcriptCleanup": {
    "enabled": true,
    "llamaCpp": {
      "autoStart": true,
      "reuseUrls": [
        "http://127.0.0.1:18087/v1",
        "http://127.0.0.1:18089/v1"
      ]
    }
  }
}
```

When a reusable server is found, the launcher uses the first model ID returned
from `/v1/models` for cleanup requests.

## Chunking

By default, the receiver uses simple energy-based VAD to close utterance chunks:

```bash
ASR_CHUNK_MODE=vad \
VAD_THRESHOLD=0.0018 \
VAD_SILENCE_MS=700 \
npm start
```

Use fixed rolling chunks instead:

```bash
ASR_CHUNK_MODE=fixed ASR_SEGMENT_SECONDS=10 npm start
```

## Output Files

Runtime artifacts are written to the configured storage paths:

```text
*.pcm              raw PCM s16le, 16 kHz, mono
*.wav              converted WAV sent to ASR
*.raw.txt          raw ASR transcript for that segment
*.clean.txt        cleaned transcript for that segment
*.txt              display transcript for that segment
*.json             metadata with raw text, cleaned text, and cleanup status
transcripts.log    append-only JSONL transcript log
```

These files can contain private audio and transcripts. They are ignored by
`.gitignore` and should not be committed.

## ASR Command Fallback

For a custom recognizer, set `ASR_COMMAND`. The receiver replaces these
placeholders:

```text
{pcm} raw PCM path
{wav} converted WAV path
{txt} transcript output path
{rawTxt} raw transcript output path
{cleanTxt} cleaned transcript output path
{json} optional JSON output path
```

Example:

```bash
ASR_COMMAND='your-asr --input {wav}' npm start
```

The command must print the final transcript to stdout.

## Speech Agent Workbench

Final transcripts can be routed into
[`speech-agent-workbench`](https://github.com/aaronrau/speech-agent-workbench)
through its local `POST /messages` API. Agent summaries can be posted back to
this receiver and displayed on the glasses.

Example `config.json`:

```json
{
  "workbench": {
    "enabled": true,
    "url": "http://127.0.0.1:8787",
    "token": "",
    "agents": ["Flux", "Brock", "Pike", "Wolf"],
    "requireAgentPrefix": true,
    "agentPrefixWordLimit": 3,
    "agentArmTimeoutMs": 30000,
    "summaryPath": "/workbench/summary",
    "summaryToken": "summary-secret"
  }
}
```

`npm start` prints the exact workbench values to use. With the default receiver
port, start the workbench with:

```bash
VOICE_API_ENABLED=1 \
VOICE_API_PORT=8787 \
VOICE_TMUX_SUMMARY_WEBHOOK_URL=http://127.0.0.1:8788/workbench/summary \
VOICE_TMUX_SUMMARY_WEBHOOK_TOKEN=summary-secret \
./run-auto.sh
```

The receiver saves every cleaned transcript, but sends a transcript to
`/messages` only when the cleaned text contains an exact configured agent name
in the first `agentPrefixWordLimit` words. With the default config,
`Flux pull latest`, `Hey Brock check status`, and `Pike push changes` route to
the workbench; ambient speech without an agent prefix is skipped. A transcript
that is exactly an agent name, such as `Pike`, arms the next flushed transcript
for `agentArmTimeoutMs` milliseconds. Aliases such as "flex" or "brook" should
be normalized by transcript cleanup before routing. The webhook body is expected
to include `summary` or `text`; the receiver forwards that content to connected
glasses as an agent summary.

## even-terminal Forwarding

Final transcripts can also be sent to even-terminal:

```bash
EVEN_TERMINAL_URL=http://127.0.0.1:3456 \
EVEN_TERMINAL_TOKEN=YOUR_TOKEN \
npm start
```

Only final utterances are sent. Interim tokens are not generated by the default
chunked ASR path.

## Manual App Development

The one-command launcher is preferred. For manual app work:

```bash
cd app
cp .env.example .env.local
cp app.example.json app.json
npm ci
npm run dev -- --host 0.0.0.0 --port 5173
```

Update `app/.env.local` and `app/app.json` to use the computer address reachable
from the phone, then run:

```bash
npx evenhub qr --url http://YOUR_COMPUTER_IP:5173
```

## Validation

Run:

```bash
npm run check
```

This checks the launcher syntax, receiver syntax, TypeScript, and Vite build.

## Public Repo Hygiene

The repository is intended to track source, lockfiles, and examples only.
Generated config, dependency folders, Python environments, build output, and
recordings are ignored:

- `app/app.json`
- `app/.env.local`
- `app/dist/`
- `config.json`
- `data/`
- `tools/`
- `models/`
- `node_modules/`
- `asr-worker/.venv/`
- `local-receiver/recordings/`
