import assert from 'node:assert/strict'
import test from 'node:test'
import { VadEndpoint } from '../vad-endpoint.js'

const frameBytes = 30
const bytesPerSecond = 1000

function makeFrames(count) {
  return Buffer.alloc(frameBytes * count, 1)
}

function makeEndpoint(pattern, options = {}) {
  const events = []
  let index = 0
  const endpoint = new VadEndpoint({
    bytesPerSecond,
    frameBytes,
    preRollBytes: options.preRollBytes ?? frameBytes * 2,
    maxBytes: options.maxBytes ?? 0,
    minSpeechMs: options.minSpeechMs ?? 60,
    silenceMs: options.silenceMs ?? 90,
    minUtteranceMs: options.minUtteranceMs ?? 60,
    analyzeFrame: async () => ({
      backend: 'fake',
      speech: pattern[Math.min(index++, pattern.length - 1)] || false,
    }),
    onSegmentStart: segment => events.push({ type: 'start', id: segment.id }),
    onSegmentData: (segment, chunk, eventOptions) => {
      events.push({
        type: 'data',
        id: segment.id,
        bytes: chunk.byteLength,
        preRoll: Boolean(eventOptions.preRoll),
      })
    },
    onSpeechDetected: (segment, decision) => {
      events.push({ type: 'speech', id: segment.id, backend: decision.backend })
    },
    onActivity: segment => events.push({ type: 'activity', id: segment.id }),
    onSegmentEnd: (segment, reason) => {
      events.push({
        type: 'end',
        id: segment.id,
        reason,
        bytes: segment.bytes,
        speechMs: segment.speechMs,
        silenceMs: segment.silenceMs,
        durationMs: segment.durationMs,
      })
    },
  })

  return { endpoint, events }
}

test('starts on speech, includes pre-roll, and closes on VAD silence', async () => {
  const pattern = [false, false, true, true, true, false, false, false, false]
  const { endpoint, events } = makeEndpoint(pattern)

  await endpoint.processChunk(makeFrames(pattern.length))

  const end = events.find(event => event.type === 'end')
  assert.equal(events[0].type, 'start')
  assert.equal(events[1].type, 'speech')
  assert.equal(end.reason, 'vad silence')
  assert.equal(end.speechMs, 90)
  assert.equal(end.silenceMs, 90)
  assert.equal(end.bytes, 240)
  assert.equal(events.filter(event => event.type === 'data' && event.preRoll).length, 2)
})

test('keeps frame order when chunks arrive with partial frames', async () => {
  const pattern = [false, true, true, false, false, false]
  const { endpoint, events } = makeEndpoint(pattern, { preRollBytes: frameBytes })
  const input = makeFrames(pattern.length)

  for (let offset = 0; offset < input.byteLength; offset += 15) {
    await endpoint.processChunk(input.subarray(offset, offset + 15))
  }

  const end = events.find(event => event.type === 'end')
  assert.equal(end.reason, 'vad silence')
  assert.equal(end.bytes, 180)
  assert.equal(events.filter(event => event.type === 'data').length, 6)
})

test('closes on max utterance before silence when speech continues', async () => {
  const pattern = [true, true, true, true, true]
  const { endpoint, events } = makeEndpoint(pattern, { maxBytes: frameBytes * 3 })

  await endpoint.processChunk(makeFrames(pattern.length))

  const end = events.find(event => event.type === 'end')
  assert.equal(end.reason, 'max utterance')
  assert.equal(end.bytes, frameBytes * 3)
})

test('flush closes an active segment without waiting for silence', async () => {
  const pattern = [false, true, true]
  const { endpoint, events } = makeEndpoint(pattern)

  await endpoint.processChunk(makeFrames(pattern.length))
  endpoint.flush('socket close')

  const end = events.find(event => event.type === 'end')
  assert.equal(end.reason, 'socket close')
  assert.equal(end.speechMs, 60)
})
