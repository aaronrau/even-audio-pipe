import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const receiverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootDir = resolve(receiverDir, '..')
const ownerUid = '1373602'
const ownerSample = join(
  rootDir,
  'data/diarization/speakers/enrollments/uid_1373602/g2-20260709-090211-906-001-01.wav',
)

test('streams enrolled voice and produces a Meemo Markdown memo', { timeout: 180_000 }, async t => {
  const tempDir = mkdtempSync(join(tmpdir(), 'meemo-stream-'))
  const transcriptDir = join(tempDir, 'transcripts')
  const audioDir = join(tempDir, 'audio')
  const configPath = join(tempDir, 'config.json')
  const asr = await startJsonServer(() => ({
    ok: true,
    text: 'Capture the architecture decision and assign Aaron to test it Friday. Mimo',
  }))
  let memoMaxTokens = 0
  const llm = await startJsonServer(request => {
    const systemPrompt = request.messages?.[0]?.content || ''
    if (systemPrompt.includes('distinct key-point bullets')) {
      memoMaxTokens = request.max_tokens
      return chatCompletion([
        '- The architecture decision was captured.',
        '- Preserve the architecture decision.',
        '- Aaron will test it Friday.',
      ].join('\n'))
    }
    return chatCompletion(
      'Capture the architecture decision and assign Aaron to test it Friday. Meemo',
    )
  })

  writeFileSync(configPath, `${JSON.stringify({
    customAgents: [{
      id: 'meemo',
      name: 'Meemo',
      aliases: ['Meamo', 'Me Mo', 'Mimo'],
      nameCorrectionPrompt: 'Normalize Meamo, Me Mo, and Mimo to Meemo.',
      processingPrompt: 'Return only distinct key-point bullets as a Markdown list.',
      matchAnywhere: true,
      processingTimeoutMs: 5_000,
      processingMaxTokens: 8_192,
      verificationTimeoutMs: 120_000,
      speakerMatchThreshold: 0.58,
    }],
  }, null, 2)}\n`)

  const port = await freePort()
  const receiver = spawn(process.execPath, ['--import', 'tsx', 'server.js'], {
    cwd: receiverDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PORT: String(port),
      AUDIO_DIR: audioDir,
      TRANSCRIPT_DIR: transcriptDir,
      TRANSCRIPTS_LOG: join(transcriptDir, 'transcripts.log'),
      EVEN_AUDIO_PIPE_CONFIG_PATH: configPath,
      EVEN_AUDIO_PIPE_TOKEN: '',
      EVEN_AUDIO_PIPE_TOKEN_SECRET: '',
      ASR_WORKER_URL: asr.url,
      ASR_CHUNK_MODE: 'vad',
      TRANSCRIPT_QUEUE_IDLE_MS: '50',
      TRANSCRIPT_QUEUE_MAX_HOLD_MS: '1000',
      TRANSCRIPT_CLEANUP_ENABLED: '1',
      TRANSCRIPT_CLEANUP_URL: `${llm.url}/v1/chat/completions`,
      TRANSCRIPT_CLEANUP_MODEL: 'test-model',
      TRANSCRIPT_CLEANUP_TIMEOUT_MS: '5000',
      SPEECH_WORKBENCH_ENABLED: '0',
      VAD_BACKEND: 'rms',
      VAD_START_THRESHOLD: '0.003',
      VAD_RELEASE_THRESHOLD: '0.0015',
      VAD_SILENCE_MS: '200',
      VAD_MIN_SPEECH_MS: '60',
      VAD_MIN_UTTERANCE_MS: '250',
      SPEAKER_DIARIZATION_ENABLED: '1',
      SPEAKER_DIARIZATION_DIR: join(rootDir, 'data/diarization'),
      SPEAKER_DIARIZATION_TRANSCRIPT_DIR: transcriptDir,
      SPEAKER_DIARIZATION_SEGMENTATION_MODEL: join(
        rootDir,
        'models/sherpa-onnx/sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
      ),
      SPEAKER_DIARIZATION_EMBEDDING_MODEL: join(
        rootDir,
        'models/sherpa-onnx/nemo_en_titanet_small.onnx',
      ),
      SPEAKER_DIARIZATION_ENROLLMENT_ENABLED: '0',
      SPEAKER_DIARIZATION_WORKER_PROCESS: '1',
      SPEAKER_DIARIZATION_WORKER_TIMEOUT_MS: '120000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  receiver.stdoutText = ''
  receiver.stderrText = ''
  receiver.stdout.on('data', chunk => { receiver.stdoutText += chunk.toString() })
  receiver.stderr.on('data', chunk => { receiver.stderrText += chunk.toString() })

  t.after(async () => {
    await stopProcess(receiver)
    await asr.close()
    await llm.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  await waitForHealth(port, receiver)
  const socket = await openSocket(port)
  t.after(() => socket.close())
  const receivedTypes = []
  socket.on('message', data => {
    try {
      receivedTypes.push(JSON.parse(data.toString()).type)
    } catch {
    }
  })
  const resultPromise = waitForJson(
    socket,
    message => message.type === 'agent_summary' && message.agent === '[Meemo Memo]',
    150_000,
    receiver,
  )

  socket.send(JSON.stringify({
    type: 'start',
    source: 'meemo-stream-test',
    encoding: 'pcm_s16le',
    sampleRate: 16_000,
    channels: 1,
    user: { uid: ownerUid },
  }))
  await streamPcm(socket, readWavPcm(ownerSample))
  await streamPcm(socket, Buffer.alloc(16_000 * 2), 3_200, 2)

  const result = await resultPromise
  assert.match(result.detail, /^- The architecture decision/)
  assert.match(result.detail, /Aaron will test it Friday/)
  assert.equal(result.summary, '[Meemo Memo]')
  assert.ok(
    receivedTypes.indexOf('transcript') < receivedTypes.indexOf('agent_summary'),
    `normal transcript was not delivered before Meemo: ${receivedTypes.join(', ')}`,
  )

  const transcriptFiles = readdirSync(transcriptDir)
  const customFile = transcriptFiles.find(name => name.endsWith('.meemo.custom.json'))
  assert.ok(customFile, `missing custom result file; receiver output:\n${receiver.stdoutText}\n${receiver.stderrText}`)
  assert.ok(transcriptFiles.some(name => name.endsWith('.raw.txt')), 'normal raw transcript was not saved')
  assert.ok(transcriptFiles.some(name => name.endsWith('.clean.txt')), 'normal cleaned transcript was not saved')
  const saved = JSON.parse(readFileSync(join(transcriptDir, customFile), 'utf8'))
  assert.equal(saved.status, 'processed')
  assert.equal(saved.verification.verified, true)
  assert.match(saved.processed, /^-/)
  assert.doesNotMatch(saved.processed, /^#/m)
  assert.equal(memoMaxTokens, 8_192)
})

function chatCompletion(content) {
  return { choices: [{ message: { content } }] }
}

async function startJsonServer(handler) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    const response = JSON.stringify(handler(request))
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(response),
    })
    res.end(response)
  })
  const port = await freePort()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolvePromise)
  })
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  }
}

async function freePort() {
  const { createServer: createNetServer } = await import('node:net')
  return new Promise((resolvePromise, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePromise(address.port))
    })
  })
}

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode, null, `receiver exited early:\n${child.stdoutText}\n${child.stderrText}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
    }
    await delay(50)
  }
  throw new Error(`receiver did not become healthy:\n${child.stdoutText}\n${child.stderrText}`)
}

function openSocket(port) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/audio`)
    socket.once('open', () => resolvePromise(socket))
    socket.once('error', reject)
  })
}

function waitForJson(socket, predicate, timeoutMs, child) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for Meemo result:\n${child.stdoutText}\n${child.stderrText}`))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }

    function onMessage(data) {
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!predicate(message)) return
      cleanup()
      resolvePromise(message)
    }

    function onError(err) {
      cleanup()
      reject(err)
    }

    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

async function streamPcm(socket, pcm, chunkBytes = 3_200, delayMs = 2) {
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    socket.send(pcm.subarray(offset, Math.min(pcm.length, offset + chunkBytes)))
    if (delayMs > 0) await delay(delayMs)
  }
}

function readWavPcm(path) {
  const wav = readFileSync(path)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')

  let offset = 12
  while (offset + 8 <= wav.length) {
    const type = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (type === 'data') return wav.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  throw new Error(`WAV data chunk not found: ${path}`)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    delay(2_000).then(() => child.kill('SIGKILL')),
  ])
}
