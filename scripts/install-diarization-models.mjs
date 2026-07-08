#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modelRoot = resolve(rootDir, process.env.SPEAKER_DIARIZATION_MODEL_DIR || 'models/sherpa-onnx')
const configPath = resolve(rootDir, process.env.EVEN_AUDIO_PIPE_CONFIG || 'config.json')

const segmentationArchive = {
  name: 'sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
}
const embeddingModel = {
  name: 'nemo_en_titanet_small.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx',
}

mkdirSync(modelRoot, { recursive: true })

const archivePath = join(modelRoot, segmentationArchive.name)
await downloadIfMissing(segmentationArchive.url, archivePath)
await extractTarBz2(archivePath, modelRoot)

const segmentationModel = findFirstFile(modelRoot, file => (
  file.endsWith('/model.onnx') &&
  file.includes('pyannote-segmentation-3-0')
))
if (!segmentationModel) {
  throw new Error(`Could not find extracted pyannote segmentation model under ${modelRoot}`)
}

const embeddingPath = join(modelRoot, embeddingModel.name)
await downloadIfMissing(embeddingModel.url, embeddingPath)

const config = loadConfig(configPath)
config.speakerDiarization = {
  rootDir: config.speakerDiarization?.rootDir || 'data/diarization',
  speakerTranscriptDir: config.speakerDiarization?.speakerTranscriptDir || 'data/transcripts',
  ...config.speakerDiarization,
  enabled: true,
  segmentationModel: relativeConfigPath(segmentationModel),
  embeddingModel: relativeConfigPath(embeddingPath),
  workerProcess: true,
  enrollmentEnabled: config.speakerDiarization?.enrollmentEnabled ?? true,
  enrollmentMinDurationSec: config.speakerDiarization?.enrollmentMinDurationSec ?? 1.5,
  profileMaxSamples: config.speakerDiarization?.profileMaxSamples ?? 1,
  speakerMatchThreshold: config.speakerDiarization?.speakerMatchThreshold ?? 0.6,
}
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

console.log('Diarization models installed:')
console.log(`  segmentation: ${relativeConfigPath(segmentationModel)}`)
console.log(`  embedding:    ${relativeConfigPath(embeddingPath)}`)
console.log(`  config:       ${relativeConfigPath(configPath)}`)

async function downloadIfMissing(url, destination) {
  if (existsSync(destination) && statSync(destination).size > 0) {
    console.log(`Using existing ${relativeConfigPath(destination)}`)
    return
  }

  mkdirSync(dirname(destination), { recursive: true })
  const tempPath = `${destination}.tmp`
  console.log(`Downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath))
  renameSync(tempPath, destination)
}

async function extractTarBz2(archive, outputDir) {
  const expectedDir = join(outputDir, 'sherpa-onnx-pyannote-segmentation-3-0')
  if (existsSync(expectedDir)) {
    console.log(`Using existing ${relativeConfigPath(expectedDir)}`)
    return
  }

  console.log(`Extracting ${relativeConfigPath(archive)}`)
  await run('tar', ['-xjf', archive, '-C', outputDir])
}

function loadConfig(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${err.message}`)
  }
}

function findFirstFile(root, predicate) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = findFirstFile(path, predicate)
      if (nested) return nested
    } else if (entry.isFile() && predicate(path.replace(/\\/g, '/'))) {
      return path
    }
  }
  return ''
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) {
        resolvePromise()
      } else {
        reject(new Error(`${command} exited with code ${code}`))
      }
    })
  })
}

function relativeConfigPath(path) {
  return relative(rootDir, path).replace(/\\/g, '/')
}
