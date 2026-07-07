import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const workerPath = fileURLToPath(new URL('./diarization-worker.js', import.meta.url))
const DEFAULT_SAMPLE_RATE = 16_000
const DEFAULT_BYTES_PER_SECOND = DEFAULT_SAMPLE_RATE * 2
const DEFAULT_MAX_OPEN_SEGMENTS = 4
const DEFAULT_MAX_PENDING_SEGMENTS = 32
const DEFAULT_MAX_SEGMENT_BYTES = DEFAULT_BYTES_PER_SECOND * 30
const RESULT_CACHE_LIMIT = 100

const noopSidecar = {
  enabled: false,
  openSegment() {},
  appendAudio() {},
  closeSegment() {},
  attachTranscript() {},
  processExistingAudio() {
    return Promise.resolve(null)
  },
}

export function createDiarizationSidecar(options = {}) {
  if (!options.enabled) return noopSidecar
  return new DiarizationSidecar(options)
}

export class DiarizationSidecar {
  constructor(options = {}) {
    this.enabled = true
    this.rootDir = resolve(options.rootDir || 'data/diarization')
    this.queueDir = join(this.rootDir, 'queue')
    this.audioDir = join(this.rootDir, 'audio')
    this.segmentDir = join(this.rootDir, 'segments')
    this.transcriptDir = join(this.rootDir, 'transcripts')
    this.speakerTranscriptDir = resolve(options.speakerTranscriptDir || join(this.rootDir, 'speaker-transcripts'))
    this.sampleRate = positiveNumber(options.sampleRate, DEFAULT_SAMPLE_RATE)
    this.bytesPerSecond = positiveNumber(options.bytesPerSecond, this.sampleRate * 2)
    this.maxOpenSegments = positiveInteger(options.maxOpenSegments, DEFAULT_MAX_OPEN_SEGMENTS)
    this.maxPendingSegments = positiveInteger(options.maxPendingSegments, DEFAULT_MAX_PENDING_SEGMENTS)
    this.maxSegmentBytes = positiveInteger(options.maxSegmentBytes, DEFAULT_MAX_SEGMENT_BYTES)
    this.segmentationModel = stringValue(options.segmentationModel)
    this.embeddingModel = stringValue(options.embeddingModel)
    this.numClusters = integerValue(options.numClusters, -1)
    this.clusterThreshold = finiteNumber(options.clusterThreshold, 0.5)
    this.minDurationOn = finiteNumber(options.minDurationOn, 0.2)
    this.minDurationOff = finiteNumber(options.minDurationOff, 0.5)
    this.numThreads = positiveInteger(options.numThreads, 1)
    this.workerProcess = options.workerProcess !== false
    this.workerTimeoutMs = positiveInteger(options.workerTimeoutMs, 120_000)
    this.debug = Boolean(options.debug)
    this.asrModel = stringValue(options.asrModel)
    this.asrWorkerUrl = stringValue(options.asrWorkerUrl)
    this.asrTimeoutMs = positiveInteger(options.asrTimeoutMs, 60_000)

    this.openSegments = new Map()
    this.pendingTranscripts = new Map()
    this.finishedSegments = new Map()
    this.writtenTranscriptRecords = new Set()
    this.writtenSpeakerBreakouts = new Set()
    this.queuedJobs = 0
    this.processing = Promise.resolve()
    this.sherpa = null
    this.diarizer = null

    mkdirSync(this.queueDir, { recursive: true })
    mkdirSync(this.audioDir, { recursive: true })
    mkdirSync(this.segmentDir, { recursive: true })
    mkdirSync(this.transcriptDir, { recursive: true })
    mkdirSync(this.speakerTranscriptDir, { recursive: true })
  }

  openSegment(paths, metadata = {}) {
    const id = segmentIdForPaths(paths)
    if (!id || this.openSegments.has(id)) return

    if (this.openSegments.size >= this.maxOpenSegments) {
      this.writeSegmentEvent('sidecar_segment_skipped', {
        sourceSegmentId: id,
        reason: 'too_many_open_segments',
        metadata: compactMetadata(metadata),
      })
      console.warn(`[diarization] skipped ${id}: too many open sidecar segments`)
      return
    }

    const tempPcm = join(this.queueDir, `${id}.pcm.tmp`)
    const stream = createWriteStream(tempPcm)
    const state = {
      id,
      tempPcm,
      stream,
      bytes: 0,
      chunks: 0,
      openedAt: new Date().toISOString(),
      metadata: compactMetadata(metadata),
      abandoned: false,
      failed: false,
    }

    stream.on('error', err => {
      state.failed = true
      console.warn(`[diarization] queue write failed for ${id}: ${err.message}`)
    })

    this.openSegments.set(id, state)
  }

  appendAudio(paths, chunk) {
    const id = segmentIdForPaths(paths)
    const state = this.openSegments.get(id)
    if (!state || state.abandoned || state.failed) return

    const copy = Buffer.from(chunk || [])
    if (!copy.byteLength) return

    state.bytes += copy.byteLength
    state.chunks += 1

    if (state.bytes > this.maxSegmentBytes) {
      this.abandonOpenSegment(state, 'segment_too_large')
      return
    }

    state.stream.write(copy)
  }

  closeSegment(paths, metadata = {}) {
    const id = segmentIdForPaths(paths)
    const state = this.openSegments.get(id)
    if (!state) return

    this.openSegments.delete(id)
    if (state.abandoned || state.failed) return

    state.metadata = {
      ...state.metadata,
      ...compactMetadata(metadata),
    }
    state.closedAt = new Date().toISOString()

    state.stream.end(() => {
      this.enqueueCompletedSegment(state)
    })
  }

  attachTranscript(paths, transcript, context = {}) {
    const id = segmentIdForPaths(paths)
    const text = normalizeText(
      typeof transcript === 'object' && transcript !== null
        ? transcript.text || transcript.rawTranscript || transcript.cleanedTranscript
        : transcript,
    )
    if (!id || !text) return

    const payload = {
      text,
      context: compactMetadata(context),
      attachedAt: new Date().toISOString(),
    }
    this.pendingTranscripts.set(id, payload)

    const finished = this.finishedSegments.get(id)
    if (finished) {
      this.writeTranscriptForResult(finished, payload)
      this.writeSpeakerBreakoutForResult(finished, payload).catch(err => {
        console.warn(`[diarization] speaker breakout failed for ${id}: ${err.message}`)
      })
    }
  }

  processExistingAudio(wavPath, options = {}) {
    this.processing = this.processing
      .catch(() => {})
      .then(async () => {
        const sourceAudioPath = resolve(wavPath)
        const id = options.sourceSegmentId || segmentIdForAudioPath(sourceAudioPath)
        const now = new Date()
        const audioPath = this.audioPathFor(id, now)

        mkdirSync(join(this.audioDir, dateStamp(now)), { recursive: true })
        copyFileSync(sourceAudioPath, audioPath)

        const result = await this.processAudioFile({
          sourceSegmentId: id,
          audioPath,
          sourceAudioPath,
          metadata: compactMetadata(options.metadata),
        })

        const text = normalizeText(options.transcriptText)
        if (text) {
          const transcript = {
            text,
            context: compactMetadata(options.context),
            attachedAt: new Date().toISOString(),
          }
          this.writeTranscriptForResult(result, transcript)
          await this.writeSpeakerBreakoutForResult(result, transcript)
        }

        return result
      })

    return this.processing
  }

  enqueueCompletedSegment(state) {
    if (this.queuedJobs >= this.maxPendingSegments) {
      this.writeSegmentEvent('sidecar_segment_skipped', {
        sourceSegmentId: state.id,
        reason: 'too_many_pending_segments',
        bytes: state.bytes,
        chunks: state.chunks,
        metadata: state.metadata,
      })
      console.warn(`[diarization] skipped ${state.id}: too many pending sidecar segments`)
      removeQuietly(state.tempPcm)
      return
    }

    this.queuedJobs += 1
    this.processing = this.processing
      .catch(() => {})
      .then(() => this.processQueuedSegment(state))
      .catch(err => {
        console.warn(`[diarization] sidecar job failed for ${state.id}: ${err.message}`)
        this.writeSegmentEvent('sidecar_segment_failed', {
          sourceSegmentId: state.id,
          error: err.message,
          bytes: state.bytes,
          chunks: state.chunks,
          metadata: state.metadata,
        })
      })
      .finally(() => {
        this.queuedJobs = Math.max(0, this.queuedJobs - 1)
      })
  }

  async processQueuedSegment(state) {
    const createdAt = state.closedAt ? new Date(state.closedAt) : new Date()
    const audioPath = this.audioPathFor(state.id, createdAt)

    await convertPcmToWav({
      pcmPath: state.tempPcm,
      wavPath: audioPath,
      sampleRate: this.sampleRate,
    })
    removeQuietly(state.tempPcm)

    const result = await this.processAudioFile({
      sourceSegmentId: state.id,
      audioPath,
      metadata: {
        ...state.metadata,
        bytes: state.bytes,
        chunks: state.chunks,
        openedAt: state.openedAt,
        closedAt: state.closedAt,
      },
    })

    const transcript = this.pendingTranscripts.get(state.id)
    if (transcript) {
      this.writeTranscriptForResult(result, transcript)
      await this.writeSpeakerBreakoutForResult(result, transcript)
    }
  }

  async processAudioFile(job) {
    const durationSec = await audioDurationSec(job.audioPath).catch(() => 0)
    const diarization = await this.runDiarization(job.audioPath, durationSec)
    const result = {
      sourceSegmentId: job.sourceSegmentId,
      createdAt: new Date().toISOString(),
      audioFile: this.relativePath(job.audioPath),
      sourceAudioFile: job.sourceAudioPath ? job.sourceAudioPath : undefined,
      durationSec,
      turns: diarization.turns,
      status: diarization.status,
      reason: diarization.reason,
      models: diarization.models,
      metadata: compactMetadata(job.metadata),
    }

    this.writeSegmentResult(result)
    this.cacheFinishedResult(result)
    return result
  }

  async runDiarization(wavPath, durationSec) {
    const models = {
      diarization: this.segmentationModel ? basename(this.segmentationModel) : '',
      embedding: this.embeddingModel ? basename(this.embeddingModel) : '',
      asr: this.asrModel,
    }

    const fallback = reason => ({
      status: 'fallback',
      reason,
      models,
      turns: [fallbackTurn(durationSec)],
    })

    if (!this.segmentationModel || !this.embeddingModel) {
      return fallback('models_unconfigured')
    }
    if (!existsSync(this.segmentationModel)) {
      return fallback(`missing_segmentation_model:${this.segmentationModel}`)
    }
    if (!existsSync(this.embeddingModel)) {
      return fallback(`missing_embedding_model:${this.embeddingModel}`)
    }

    if (this.workerProcess) {
      try {
        const turns = await runDiarizationWorker({
          wavPath,
          durationSec,
          segmentationModel: this.segmentationModel,
          embeddingModel: this.embeddingModel,
          numClusters: this.numClusters,
          clusterThreshold: this.clusterThreshold,
          minDurationOn: this.minDurationOn,
          minDurationOff: this.minDurationOff,
          timeoutMs: this.workerTimeoutMs,
        })
        return {
          status: turns.length ? 'ok' : 'fallback',
          reason: turns.length ? '' : 'empty_diarization_result',
          models,
          turns: turns.length ? turns : [fallbackTurn(durationSec)],
        }
      } catch (err) {
        return fallback(`diarization_worker_failed:${err.message}`)
      }
    }

    try {
      const sherpa = this.loadSherpa()
      if (!this.diarizer) {
        this.diarizer = new sherpa.OfflineSpeakerDiarization({
          segmentation: {
            pyannote: {
              model: this.segmentationModel,
            },
          },
          embedding: {
            model: this.embeddingModel,
          },
          clustering: {
            numClusters: this.numClusters,
            threshold: this.clusterThreshold,
          },
          minDurationOn: this.minDurationOn,
          minDurationOff: this.minDurationOff,
        })
      }

      const wave = sherpa.readWave(wavPath)
      if (this.diarizer.sampleRate && wave.sampleRate !== this.diarizer.sampleRate) {
        return fallback(`unexpected_sample_rate:${wave.sampleRate}`)
      }

      const rawTurns = this.diarizer.process(wave.samples)
      const turns = normalizeTurns(rawTurns, durationSec)
      return {
        status: turns.length ? 'ok' : 'fallback',
        reason: turns.length ? '' : 'empty_diarization_result',
        models,
        turns: turns.length ? turns : [fallbackTurn(durationSec)],
      }
    } catch (err) {
      return fallback(`diarization_failed:${err.message}`)
    }
  }

  loadSherpa() {
    if (this.sherpa) return this.sherpa
    this.sherpa = require('sherpa-onnx-node')
    return this.sherpa
  }

  writeSegmentResult(result) {
    this.appendJsonl(this.segmentPathForDate(new Date(result.createdAt)), {
      type: 'diarization_segment',
      ...compactObject(result),
    })
  }

  writeSegmentEvent(type, payload = {}) {
    this.appendJsonl(this.segmentPathForDate(new Date()), {
      type,
      createdAt: new Date().toISOString(),
      ...compactObject(payload),
    })
  }

  writeTranscriptForResult(result, transcript) {
    const text = normalizeText(transcript?.text)
    if (!result?.sourceSegmentId || !text) return

    const recordKey = `${result.sourceSegmentId}:${text}`
    if (this.writtenTranscriptRecords.has(recordKey)) return
    this.writtenTranscriptRecords.add(recordKey)

    const speakerTurn = dominantTurn(result.turns)
    const createdAt = new Date().toISOString()
    this.appendJsonl(this.transcriptPathForDate(new Date(createdAt)), {
      type: 'diarized_transcript',
      sourceSegmentId: result.sourceSegmentId,
      createdAt,
      audioFile: result.audioFile,
      speaker: {
        id: speakerTurn.speaker,
        displayName: displaySpeakerName(speakerTurn.speaker),
        confidence: speakerTurn.confidence,
        matchedProfile: false,
      },
      text,
      turn: {
        startSec: speakerTurn.startSec,
        endSec: speakerTurn.endSec,
      },
      diarizationTurns: result.turns,
      alignment: result.turns.length > 1
        ? 'segment_transcript_dominant_speaker'
        : 'segment_transcript_single_speaker',
      diarizationStatus: result.status,
      diarizationReason: result.reason,
      models: result.models,
      context: compactMetadata(transcript.context),
    })
  }

  async writeSpeakerBreakoutForResult(result, transcript) {
    const fullText = normalizeText(transcript?.text)
    if (!result?.sourceSegmentId || !fullText) return null

    const recordKey = `${result.sourceSegmentId}:${fullText}`
    if (this.writtenSpeakerBreakouts.has(recordKey)) return null
    this.writtenSpeakerBreakouts.add(recordKey)

    const createdAt = new Date().toISOString()
    const sourceAudioPath = join(this.rootDir, result.audioFile)
    const turns = result.turns?.length ? result.turns : [fallbackTurn(result.durationSec)]
    const breakoutTurns = []

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]
      const isSingleTurn = turns.length === 1
      const turnAudioPath = isSingleTurn
        ? sourceAudioPath
        : this.turnAudioPathFor(result.sourceSegmentId, turn, index, new Date(createdAt))
      let turnText = ''
      let asr = { enabled: Boolean(this.asrWorkerUrl), ok: false }

      if (isSingleTurn) {
        turnText = fullText
        asr = {
          enabled: Boolean(this.asrWorkerUrl),
          ok: true,
          source: 'single_speaker_full_segment_transcript',
        }
      } else {
        try {
          await cutWavTurn({
            sourcePath: sourceAudioPath,
            outputPath: turnAudioPath,
            startSec: turn.startSec,
            endSec: turn.endSec,
          })
        } catch (err) {
          asr = {
            ...asr,
            error: `turn_audio_failed:${err.message}`,
          }
        }

        if (this.asrWorkerUrl && existsSync(turnAudioPath)) {
          try {
            turnText = await transcribeWithWorker({
              workerUrl: this.asrWorkerUrl,
              wavPath: turnAudioPath,
              timeoutMs: this.asrTimeoutMs,
            })
            asr = {
              enabled: true,
              ok: Boolean(turnText),
              source: 'sidecar_turn_asr',
              error: turnText ? '' : 'empty_turn_transcript',
            }
          } catch (err) {
            asr = {
              enabled: true,
              ok: false,
              source: 'sidecar_turn_asr',
              error: err.message,
            }
          }
        } else {
          asr = {
            enabled: false,
            ok: false,
            source: 'diarization_turn_audio_only',
            error: 'sidecar_turn_asr_unconfigured',
          }
        }
      }

      breakoutTurns.push({
        index,
        speaker: {
          id: turn.speaker,
          displayName: displaySpeakerName(turn.speaker),
          confidence: turn.confidence,
          matchedProfile: false,
        },
        startSec: turn.startSec,
        endSec: turn.endSec,
        audioFile: this.relativePath(turnAudioPath),
        text: turnText,
        asr: compactObject(asr),
      })
    }

    const alignment = breakoutTurns.every(turn => turn.asr?.source === 'sidecar_turn_asr' && turn.text)
      ? 'turn_asr'
      : turns.length === 1
        ? 'single_speaker_full_segment_transcript'
        : 'speaker_turns_without_text'
    const txtPath = this.speakerBreakoutTextPath(result.sourceSegmentId)
    const jsonPath = this.speakerBreakoutJsonPath(result.sourceSegmentId)
    const record = {
      type: 'speaker_breakout_transcript',
      sourceSegmentId: result.sourceSegmentId,
      createdAt,
      audioFile: result.audioFile,
      textFile: txtPath,
      jsonFile: jsonPath,
      alignment,
      fullSegmentText: alignment === 'speaker_turns_without_text' ? fullText : undefined,
      turns: breakoutTurns,
      diarizationStatus: result.status,
      diarizationReason: result.reason,
      models: result.models,
      context: compactMetadata(transcript.context),
    }

    writeTextFile(txtPath, formatSpeakerBreakoutText(record))
    writeJsonFile(jsonPath, record)
    return record
  }

  appendJsonl(path, value) {
    mkdirSync(resolve(path, '..'), { recursive: true })
    appendFileSync(path, `${JSON.stringify(compactObject(value))}\n`)
  }

  audioPathFor(id, date = new Date()) {
    const dir = join(this.audioDir, dateStamp(date))
    mkdirSync(dir, { recursive: true })
    return join(dir, `${id}.wav`)
  }

  segmentPathForDate(date) {
    return join(this.segmentDir, `${dateStamp(date)}.jsonl`)
  }

  transcriptPathForDate(date) {
    return join(this.transcriptDir, `${dateStamp(date)}.jsonl`)
  }

  speakerBreakoutTextPath(id) {
    mkdirSync(this.speakerTranscriptDir, { recursive: true })
    return join(this.speakerTranscriptDir, `${id}.diarization.txt`)
  }

  speakerBreakoutJsonPath(id) {
    mkdirSync(this.speakerTranscriptDir, { recursive: true })
    return join(this.speakerTranscriptDir, `${id}.diarization.json`)
  }

  turnAudioPathFor(id, turn, index, date = new Date()) {
    const dir = join(this.audioDir, dateStamp(date))
    mkdirSync(dir, { recursive: true })
    const speaker = String(turn.speaker || 'speaker_00').replace(/[^a-z0-9_-]/gi, '_')
    return join(dir, `${id}.${speaker}.${String(index + 1).padStart(3, '0')}.wav`)
  }

  relativePath(path) {
    return relative(this.rootDir, path).replace(/\\/g, '/')
  }

  cacheFinishedResult(result) {
    this.finishedSegments.set(result.sourceSegmentId, result)
    while (this.finishedSegments.size > RESULT_CACHE_LIMIT) {
      const firstKey = this.finishedSegments.keys().next().value
      this.finishedSegments.delete(firstKey)
    }
  }

  abandonOpenSegment(state, reason) {
    state.abandoned = true
    this.openSegments.delete(state.id)
    state.stream.destroy()
    removeQuietly(state.tempPcm)
    this.writeSegmentEvent('sidecar_segment_skipped', {
      sourceSegmentId: state.id,
      reason,
      bytes: state.bytes,
      chunks: state.chunks,
      metadata: state.metadata,
    })
    console.warn(`[diarization] skipped ${state.id}: ${reason}`)
  }
}

export function readMatchingTranscript(audioPath, transcriptDir) {
  if (!transcriptDir) return ''

  const id = segmentIdForAudioPath(audioPath)
  const candidates = [
    join(transcriptDir, `${id}.clean.txt`),
    join(transcriptDir, `${id}.txt`),
    join(transcriptDir, `${id}.raw.txt`),
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    return normalizeText(readFileSync(candidate, 'utf8'))
  }
  return ''
}

export function segmentIdForAudioPath(path) {
  return basename(path, extname(path))
}

export function segmentIdForPaths(paths) {
  if (typeof paths === 'string') return segmentIdForAudioPath(paths)
  return segmentIdForAudioPath(paths?.wav || paths?.pcm || paths?.txt || '')
}

function normalizeTurns(rawTurns, durationSec) {
  if (!Array.isArray(rawTurns)) return []

  return rawTurns
    .map((turn, index) => normalizeTurn(turn, index, durationSec))
    .filter(turn => turn.endSec > turn.startSec)
}

function normalizeTurn(turn, index, durationSec) {
  const startSec = clampSeconds(
    numberFromFields(turn, ['start', 'startSec', 'begin', 'beginSec', 'startTime']),
    0,
    durationSec,
  )
  const endSec = clampSeconds(
    numberFromFields(turn, ['end', 'endSec', 'stop', 'stopSec', 'endTime']),
    startSec,
    durationSec,
  )
  const rawSpeaker = turn?.speaker ?? turn?.label ?? turn?.speakerId ?? turn?.id ?? index

  return {
    speaker: speakerLabel(rawSpeaker),
    startSec,
    endSec,
    confidence: finiteNumber(turn?.confidence ?? turn?.score, null),
  }
}

function fallbackTurn(durationSec) {
  const endSec = Number.isFinite(durationSec) && durationSec > 0 ? roundSeconds(durationSec) : 0
  return {
    speaker: 'speaker_00',
    startSec: 0,
    endSec,
    confidence: null,
  }
}

function dominantTurn(turns = []) {
  return turns.reduce((best, current) => {
    const bestDuration = best.endSec - best.startSec
    const currentDuration = current.endSec - current.startSec
    return currentDuration > bestDuration ? current : best
  }, turns[0] || fallbackTurn(0))
}

function speakerLabel(value) {
  const text = String(value ?? '').trim()
  if (/^speaker_\d+$/i.test(text)) return text.toLowerCase()

  const number = Number(text)
  if (Number.isInteger(number) && number >= 0) {
    return `speaker_${String(number).padStart(2, '0')}`
  }

  const suffix = text.match(/\d+/)?.[0]
  if (suffix) return `speaker_${String(Number(suffix)).padStart(2, '0')}`

  return text
    ? text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'speaker_00'
    : 'speaker_00'
}

function displaySpeakerName(speaker) {
  return speaker
    .replace(/^speaker_0*/, 'Unknown speaker ')
    .replace(/^Unknown speaker $/, 'Unknown speaker 0')
}

export function runSherpaDiarization(job = {}) {
  const sherpa = require('sherpa-onnx-node')
  const diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: {
      pyannote: {
        model: job.segmentationModel,
      },
    },
    embedding: {
      model: job.embeddingModel,
    },
    clustering: {
      numClusters: integerValue(job.numClusters, -1),
      threshold: finiteNumber(job.clusterThreshold, 0.5),
    },
    minDurationOn: finiteNumber(job.minDurationOn, 0.2),
    minDurationOff: finiteNumber(job.minDurationOff, 0.5),
  })

  const wave = sherpa.readWave(job.wavPath)
  if (diarizer.sampleRate && wave.sampleRate !== diarizer.sampleRate) {
    throw new Error(`unexpected_sample_rate:${wave.sampleRate}`)
  }

  return normalizeTurns(diarizer.process(wave.samples), finiteNumber(job.durationSec, 0))
}

function runDiarizationWorker(job = {}) {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = positiveInteger(job.timeoutMs, 120_000)
    const child = spawn(process.execPath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      settle(new Error(`worker timed out after ${timeoutMs}ms`))
      child.kill('SIGTERM')
    }, timeoutMs)
    timeout.unref?.()

    function settle(err, value) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (err) {
        reject(err)
      } else {
        resolvePromise(value)
      }
    }

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', settle)
    child.on('exit', code => {
      if (settled) return

      if (code !== 0) {
        settle(new Error((stderr || stdout || `worker exited with code ${code}`).trim()))
        return
      }

      let payload
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
        payload = JSON.parse(lines.at(-1) || '')
      } catch (err) {
        settle(new Error(`invalid worker response: ${err.message}`))
        return
      }

      if (!payload?.ok) {
        settle(new Error(payload?.error || 'worker failed'))
        return
      }

      settle(null, Array.isArray(payload.turns) ? payload.turns : [])
    })

    child.stdin.end(JSON.stringify(compactObject(job)))
  })
}

async function convertPcmToWav({ pcmPath, wavPath, sampleRate }) {
  mkdirSync(resolve(wavPath, '..'), { recursive: true })
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', '1',
    '-i', pcmPath,
    wavPath,
  ])
}

async function cutWavTurn({ sourcePath, outputPath, startSec, endSec }) {
  mkdirSync(resolve(outputPath, '..'), { recursive: true })
  const durationSec = Math.max(0, finiteNumber(endSec, 0) - finiteNumber(startSec, 0))
  if (durationSec <= 0) {
    copyFileSync(sourcePath, outputPath)
    return
  }

  await runCommand('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', String(Math.max(0, startSec)),
    '-t', String(durationSec),
    '-i', sourcePath,
    '-ar', String(DEFAULT_SAMPLE_RATE),
    '-ac', '1',
    outputPath,
  ])
}

async function transcribeWithWorker({ workerUrl, wavPath, timeoutMs }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()

  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ wavPath }),
    })
    const bodyText = await res.text()
    let body
    try {
      body = JSON.parse(bodyText)
    } catch {
      body = { ok: false, error: bodyText }
    }

    if (!res.ok || body?.ok === false) {
      throw new Error(`ASR worker failed: HTTP ${res.status} ${body?.error || bodyText}`)
    }

    return normalizeText(body?.text || '')
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`ASR worker timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

async function audioDurationSec(wavPath) {
  const result = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    wavPath,
  ])
  return finiteNumber(result.stdout, 0)
}

function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`))
      }
    })
  })
}

function writeTextFile(path, content) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function writeJsonFile(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(compactObject(value), null, 2)}\n`)
}

function formatSpeakerBreakoutText(record) {
  const lines = [
    `Diarization transcript: ${record.sourceSegmentId}`,
    `Created: ${record.createdAt}`,
    `Alignment: ${record.alignment}`,
    '',
  ]

  for (const turn of record.turns || []) {
    const speaker = turn.speaker?.displayName || turn.speaker?.id || 'Unknown speaker'
    const time = `${formatSeconds(turn.startSec)}-${formatSeconds(turn.endSec)}`
    const text = normalizeText(turn.text) || '[turn transcript unavailable]'
    lines.push(`${speaker} [${time}]: ${text}`)
  }

  if (record.fullSegmentText) {
    lines.push('')
    lines.push('Full segment transcript:')
    lines.push(record.fullSegmentText)
  }

  return `${lines.join('\n')}\n`
}

function formatSeconds(value) {
  return `${finiteNumber(value, 0).toFixed(2)}s`
}

function dateStamp(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date)
  const pad = number => String(number).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function numberFromFields(record, fields) {
  for (const field of fields) {
    const value = finiteNumber(record?.[field], null)
    if (value !== null) return value
  }
  return 0
}

function clampSeconds(value, min, max) {
  const number = finiteNumber(value, min)
  const upper = Number.isFinite(max) && max > 0 ? max : number
  return roundSeconds(Math.min(Math.max(number, min), upper))
}

function roundSeconds(value) {
  return Math.round(value * 1000) / 1000
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function compactMetadata(value) {
  if (!value || typeof value !== 'object') return {}
  return compactObject(value)
}

function compactObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== ''),
  )
}

function stringValue(value) {
  return String(value || '').trim()
}

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function integerValue(value, fallback) {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) ? number : fallback
}

function removeQuietly(path) {
  try {
    if (path && existsSync(path)) rmSync(path, { force: true })
  } catch {
    // Best-effort cleanup for sidecar temp files.
  }
}
