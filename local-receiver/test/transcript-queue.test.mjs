import assert from 'node:assert/strict'
import test from 'node:test'
import {
  markQueuedTranscriptActivity,
  queuedTranscriptActivityAt,
  transcriptQueueMaxHoldReached,
} from '../transcript-queue.js'

test('queued transcript activity moves the idle and max-hold clock forward', () => {
  const queue = {
    items: [{ rawTranscript: 'Flux start the summary' }],
    lastTranscriptAt: 1_000,
    lastActivityAt: 1_000,
  }

  assert.equal(markQueuedTranscriptActivity(queue, 3_500), true)
  assert.equal(queuedTranscriptActivityAt(queue), 3_500)
  assert.equal(transcriptQueueMaxHoldReached(queue, 10_000, 10_999), false)
  assert.equal(transcriptQueueMaxHoldReached(queue, 10_000, 13_500), true)
})

test('empty queues do not update activity', () => {
  const queue = {
    items: [],
    lastTranscriptAt: 1_000,
    lastActivityAt: 1_000,
  }

  assert.equal(markQueuedTranscriptActivity(queue, 3_500), false)
  assert.equal(queuedTranscriptActivityAt(queue), 1_000)
})
