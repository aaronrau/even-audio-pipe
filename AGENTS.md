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
- Do not display queued ASR text; only final transcript events should render as
  transcript history/live text.
- Preserve safety: auth checks, transcript persistence, reconnect behavior,
  history paging limits, and Even text-container limits are not simplification
  targets.
- Add abstractions only when they remove real branching or duplicated behavior.
- When fixing UI state, trace the socket event sequence before adding timers or
  new flags.
- For app changes, run at least `npm --prefix app run build`. For history or
  glasses navigation changes, also run `npm --prefix app run test:history`.

