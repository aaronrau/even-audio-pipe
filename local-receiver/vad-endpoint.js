const EMPTY_BUFFER = Buffer.alloc(0)

export class VadEndpoint {
  constructor(options = {}) {
    this.bytesPerSecond = positiveNumber(options.bytesPerSecond, 16_000 * 2)
    this.frameBytes = Math.max(2, Math.floor(positiveNumber(options.frameBytes, 960) / 2) * 2)
    this.preRollBytes = Math.max(0, Math.floor(options.preRollBytes || 0))
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes || 0))
    this.minSpeechMs = Math.max(0, positiveNumber(options.minSpeechMs, 60))
    this.silenceMs = Math.max(0, positiveNumber(options.silenceMs, 240))
    this.minUtteranceMs = Math.max(0, positiveNumber(options.minUtteranceMs, 250))
    this.analyzeFrame = options.analyzeFrame || (async () => ({ speech: false }))
    this.onSegmentStart = options.onSegmentStart || (() => {})
    this.onSegmentData = options.onSegmentData || (() => {})
    this.onSpeechDetected = options.onSpeechDetected || (() => {})
    this.onActivity = options.onActivity || (() => {})
    this.onSegmentEnd = options.onSegmentEnd || (() => {})

    this.remainder = EMPTY_BUFFER
    this.preRoll = []
    this.preRollSize = 0
    this.segment = null
    this.revision = 0
  }

  get active() {
    return Boolean(this.segment)
  }

  async processChunk(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || [])
    if (!input.byteLength) return

    const buffer = this.remainder.byteLength
      ? Buffer.concat([this.remainder, input])
      : input
    let offset = 0

    while (offset + this.frameBytes <= buffer.byteLength) {
      const frame = Buffer.from(buffer.subarray(offset, offset + this.frameBytes))
      offset += this.frameBytes
      await this.processFrame(frame)
    }

    this.remainder = offset < buffer.byteLength
      ? Buffer.from(buffer.subarray(offset))
      : EMPTY_BUFFER
  }

  async processFrame(frame) {
    const decision = normalizeVadDecision(await this.analyzeFrame(frame))

    if (!this.segment && !decision.speech) {
      this.pushPreRoll(frame)
      return
    }

    if (!this.segment) {
      this.startSegment(decision)
      for (const buffered of this.preRoll) {
        this.appendSegmentData(buffered, { countChunk: false, preRoll: true })
      }
      this.clearPreRoll()
    }

    const segment = this.segment
    this.appendSegmentData(frame)

    if (decision.speech) {
      this.markSpeechDetected(segment, decision)
      segment.hasSpeech = true
      segment.speechMs += this.bufferDurationMs(frame)
      segment.silenceMs = 0
      this.onActivity(segment, decision)
    } else {
      segment.silenceMs += this.bufferDurationMs(frame)
    }

    if (this.maxBytes > 0 && segment.bytes >= this.maxBytes) {
      this.endSegment('max utterance')
      return
    }

    if (
      segment.hasSpeech &&
      segment.speechMs >= this.minSpeechMs &&
      segment.durationMs >= this.minUtteranceMs &&
      segment.silenceMs >= this.silenceMs
    ) {
      this.endSegment('vad silence')
    }
  }

  flush(reason = 'flush') {
    if (this.remainder.byteLength && this.segment) {
      this.appendSegmentData(this.remainder, { partial: true })
    }
    this.remainder = EMPTY_BUFFER
    this.clearPreRoll()

    if (this.segment) {
      this.endSegment(reason)
    }
  }

  reset() {
    this.remainder = EMPTY_BUFFER
    this.clearPreRoll()
    this.segment = null
    this.revision += 1
  }

  startSegment(decision) {
    this.segment = {
      id: ++this.revision,
      bytes: 0,
      chunks: 0,
      speechMs: 0,
      silenceMs: 0,
      durationMs: 0,
      hasSpeech: false,
      vadDetectedSent: false,
      speechDetectedSent: false,
    }
    this.onSegmentStart(this.segment, decision)
    this.markSpeechDetected(this.segment, decision)
  }

  appendSegmentData(buffer, options = {}) {
    if (!this.segment || !buffer.byteLength) return

    const segment = this.segment
    segment.bytes += buffer.byteLength
    segment.durationMs += this.bufferDurationMs(buffer)
    if (options.countChunk !== false) segment.chunks += 1
    this.onSegmentData(segment, buffer, options)
  }

  markSpeechDetected(segment, decision = {}) {
    if (!segment || segment.speechDetectedSent) return

    segment.speechDetectedSent = true
    this.onSpeechDetected(segment, decision)
  }

  endSegment(reason) {
    if (!this.segment) return

    const segment = this.segment
    this.segment = null
    this.onSegmentEnd(segment, reason)
  }

  pushPreRoll(frame) {
    if (this.preRollBytes <= 0) return

    this.preRoll.push(Buffer.from(frame))
    this.preRollSize += frame.byteLength

    while (this.preRollSize > this.preRollBytes && this.preRoll.length) {
      const removed = this.preRoll.shift()
      this.preRollSize -= removed.byteLength
    }
  }

  clearPreRoll() {
    this.preRoll = []
    this.preRollSize = 0
  }

  bufferDurationMs(buffer) {
    return (buffer.byteLength / this.bytesPerSecond) * 1000
  }
}

export function normalizeVadDecision(value) {
  if (typeof value === 'boolean') return { speech: value }
  if (!value || typeof value !== 'object') return { speech: false }

  return {
    ...value,
    speech: Boolean(value.speech),
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}
