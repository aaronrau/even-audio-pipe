# Agent Guidance

Use Ponytail-style engineering in this repo.

Source: https://github.com/DietrichGebert/ponytail

## Ponytail Ladder

Before changing code, choose the first rung that solves the problem:

1. Does this need to exist? If not, skip it.
2. Is the capability already in this codebase? Reuse it.
3. Does the standard library do it? Use it.
4. Does the platform provide it natively? Use it.
5. Is an installed dependency already suitable? Use it.
6. Can this be one clear line? Keep it one line.
7. Otherwise write the smallest implementation that works.

The ladder is not code golf. It runs after understanding the touched flow.

## Local Rules

- Keep the thin client thin. ASR, cleanup, persistence, and workbench secrets
  stay server-side.
- Prefer deleting redundant state over adding coordination logic.
- Do not display unstable partial ASR text. Server-confirmed queued transcript
  batches may render as transient `Queued:` live/history pending state. Durable
  history still comes from final transcript and agent summary events.
- Preserve safety: auth checks, transcript persistence, reconnect behavior,
  history paging limits, and Even text-container limits are not simplification
  targets.
- Add abstractions only when they remove real branching or duplicated behavior.
- When fixing UI state, trace the socket event sequence before adding timers or
  new flags.
- For app changes, run at least `npm --prefix app run build`. For history or
  glasses navigation changes, also run `npm --prefix app run test:history`.

## Speech Agent Workbench Integration

- Agent Audio Pipe does not start the workbench. When `workbench.enabled` is
  true, run `./run-auto.sh --disable-stt` separately from the
  `speech-agent-workbench` checkout. Do not use `linux-voice-codex`; it does not
  provide the required `POST /messages` API.
- Keep `workbench.url` aligned with the workbench API bind, normally
  `http://127.0.0.1:8787`, and keep `workbench.token` identical to the
  workbench `VOICE_API_TOKEN`/`api_token` value.
- Keep `workbench.agents` identical to the configured workbench pane names.
  The default integrated set is `Flux`, `Brock`, `Pike`, and `Wolf`.
- Keep the summary callback aligned in both processes: the workbench posts to
  the receiver's `workbench.summaryPath`, normally
  `http://127.0.0.1:8788/workbench/summary`, using the configured
  `workbench.summaryToken`.
- For a persistent Agent Audio Pipe API, keep the workbench's
  `auto_enable_terminate_commands` disabled. If enabled, a command such as
  `Wolf terminate session` kills the tmux session and its API on port `8787`,
  so subsequent receiver requests correctly fail until the workbench restarts.
- When changing this contract, update `README.md`, `config.example.json`, and
  the startup guidance in `scripts/start-local.mjs` together.
