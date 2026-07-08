#!/usr/bin/env node
import { runSherpaDiarization, runSherpaEmbedding } from './diarization-sidecar.js'

const input = await readStdin()

try {
  const job = JSON.parse(input || '{}')
  if (job.type === 'embedding') {
    const embedding = runSherpaEmbedding(job)
    process.stdout.write(`${JSON.stringify({ ok: true, embedding })}\n`)
  } else {
    const turns = runSherpaDiarization(job)
    process.stdout.write(`${JSON.stringify({ ok: true, turns })}\n`)
  }
} catch (err) {
  process.stderr.write(`[diarization-worker] ${err?.message || String(err)}\n`)
  process.stdout.write(`${JSON.stringify({ ok: false, error: err?.message || String(err) })}\n`)
  process.exitCode = 1
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
