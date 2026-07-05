export function markQueuedTranscriptActivity(queue, now = Date.now()) {
  if (!queue?.items?.length) return false

  queue.lastActivityAt = now
  return true
}

export function queuedTranscriptActivityAt(queue) {
  return queue?.lastActivityAt || queue?.lastTranscriptAt || 0
}

export function transcriptQueueMaxHoldReached(queue, maxHoldMs, now = Date.now()) {
  if (!Number.isFinite(maxHoldMs) || maxHoldMs <= 0) return false

  const activityAt = queuedTranscriptActivityAt(queue)
  if (!activityAt) return false

  return now - activityAt >= maxHoldMs
}

export function normalizeQueuedTranscript(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function combineQueuedTranscripts(transcripts) {
  const segments = []

  for (const transcript of transcripts) {
    const current = normalizeQueuedTranscript(transcript)
    if (!current) continue

    const previous = segments.at(-1)
    if (!previous) {
      segments.push(current)
      continue
    }

    if (sameQueuedTranscript(previous, current)) continue

    if (startsWithQueuedSegment(current, previous)) {
      segments[segments.length - 1] = current
      continue
    }

    if (startsWithQueuedSegment(previous, current)) continue

    segments.push(current)
  }

  return segments.join(' ').replace(/\s+/g, ' ').trim()
}

function sameQueuedTranscript(a, b) {
  return normalizeQueuedTranscript(a).toLowerCase() === normalizeQueuedTranscript(b).toLowerCase()
}

function startsWithQueuedSegment(value, prefix) {
  const normalizedValue = normalizeQueuedTranscript(value).toLowerCase()
  const normalizedPrefix = normalizeQueuedTranscript(prefix).toLowerCase()
  return normalizedValue.length > normalizedPrefix.length &&
    normalizedValue.startsWith(`${normalizedPrefix} `)
}
