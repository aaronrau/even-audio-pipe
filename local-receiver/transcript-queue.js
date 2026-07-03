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
