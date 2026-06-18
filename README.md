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
EVEN_AUDIO_PIPE_RECEIVER_PORT=8787 \
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
  "storage": {
    "audioDir": "data/audio",
    "transcriptDir": "data/transcripts",
    "transcriptsLog": "data/transcripts/transcripts.log"
  },
  "transcriptCleanup": {
    "enabled": false,
    "url": "http://127.0.0.1:8080/v1/chat/completions",
    "model": "gemma-4-e4b-it-q4_0",
    "temperature": 0,
    "timeoutMs": 15000,
    "prompt": "You clean short ASR transcript chunks from smart glasses. Fix obvious speech recognition errors, capitalization, punctuation, and light grammar only. Preserve the speaker's meaning and wording. Do not add facts, commands, explanations, or markdown. If uncertain, keep the original wording. Return only the cleaned transcript text.",
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
