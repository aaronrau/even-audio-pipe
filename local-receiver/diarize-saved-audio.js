#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createDiarizationSidecar,
  readMatchingTranscript,
  segmentIdForAudioPath,
} from './diarization-sidecar.js'

const args = process.argv.slice(2)
const options = parseArgs(args)

if (!options.audioFiles.length) {
  console.error([
    'Usage: node local-receiver/diarize-saved-audio.js [options] <audio.wav> [...]',
    '',
    'Options:',
    '  --root <dir>                 Diarization output root (default: data/diarization)',
    '  --transcript-dir <dir>       Existing transcript directory for matching text',
    '  --speaker-transcript-dir <dir>  Breakout output dir (default: transcript dir)',
    '  --segmentation-model <file>  sherpa-onnx speaker segmentation ONNX model',
    '  --embedding-model <file>     sherpa-onnx speaker embedding ONNX model',
    '  --asr-worker-url <url>       Optional ASR worker for per-turn transcription',
    '  --num-clusters <n>           Known speaker count, or -1 to infer (default: -1)',
    '  --cluster-threshold <n>      Clustering threshold (default: 0.5)',
  ].join('\n'))
  process.exit(1)
}

const sidecar = createDiarizationSidecar({
  enabled: true,
  rootDir: options.root,
  speakerTranscriptDir: options.speakerTranscriptDir || options.transcriptDir,
  segmentationModel: options.segmentationModel,
  embeddingModel: options.embeddingModel,
  numClusters: options.numClusters,
  clusterThreshold: options.clusterThreshold,
  asrModel: process.env.PARAKEET_ONNX_MODEL || 'nemo-parakeet-tdt-0.6b-v3',
  asrWorkerUrl: options.asrWorkerUrl,
})

for (const file of options.audioFiles) {
  const audioPath = resolve(file)
  if (!existsSync(audioPath)) {
    console.warn(`[diarization] missing saved audio: ${audioPath}`)
    continue
  }

  const transcriptText = options.transcriptDir
    ? readMatchingTranscript(audioPath, resolve(options.transcriptDir))
    : ''

  const result = await sidecar.processExistingAudio(audioPath, {
    sourceSegmentId: segmentIdForAudioPath(audioPath),
    transcriptText,
    context: {
      source: 'saved-audio-cli',
      transcriptMatched: Boolean(transcriptText),
    },
  })

  console.log(JSON.stringify({
    audio: audioPath,
    outputAudio: result.audioFile,
    sourceSegmentId: result.sourceSegmentId,
    diarizationStatus: result.status,
    diarizationReason: result.reason,
    turns: result.turns.length,
    transcriptMatched: Boolean(transcriptText),
  }))
}

function parseArgs(values) {
  const parsed = {
    root: process.env.SPEAKER_DIARIZATION_DIR || 'data/diarization',
    transcriptDir: process.env.TRANSCRIPT_DIR || 'data/transcripts',
    speakerTranscriptDir: process.env.SPEAKER_DIARIZATION_TRANSCRIPT_DIR || '',
    segmentationModel: process.env.SPEAKER_DIARIZATION_SEGMENTATION_MODEL || '',
    embeddingModel: process.env.SPEAKER_DIARIZATION_EMBEDDING_MODEL || '',
    asrWorkerUrl: process.env.SPEAKER_DIARIZATION_ASR_WORKER_URL || '',
    numClusters: Number(process.env.SPEAKER_DIARIZATION_NUM_CLUSTERS || -1),
    clusterThreshold: Number(process.env.SPEAKER_DIARIZATION_CLUSTER_THRESHOLD || 0.5),
    audioFiles: [],
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--root') {
      parsed.root = values[++index] || parsed.root
    } else if (value === '--transcript-dir') {
      parsed.transcriptDir = values[++index] || parsed.transcriptDir
    } else if (value === '--speaker-transcript-dir') {
      parsed.speakerTranscriptDir = values[++index] || ''
    } else if (value === '--segmentation-model') {
      parsed.segmentationModel = values[++index] || ''
    } else if (value === '--embedding-model') {
      parsed.embeddingModel = values[++index] || ''
    } else if (value === '--asr-worker-url') {
      parsed.asrWorkerUrl = values[++index] || ''
    } else if (value === '--num-clusters') {
      parsed.numClusters = Number(values[++index] || -1)
    } else if (value === '--cluster-threshold') {
      parsed.clusterThreshold = Number(values[++index] || 0.5)
    } else {
      parsed.audioFiles.push(value)
    }
  }

  return parsed
}
