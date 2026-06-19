import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'

const port = Number(process.env.PORT || 8787)
const audioDir = process.env.AUDIO_DIR || process.env.OUT_DIR || 'recordings'
const audioDirPath = resolve(audioDir)
const transcriptDir = process.env.TRANSCRIPT_DIR || audioDirPath
const transcriptDirPath = resolve(transcriptDir)
const asrCommand = process.env.ASR_COMMAND || ''
const asrWorkerUrl = process.env.ASR_WORKER_URL || ''
const terminalUrl = process.env.EVEN_TERMINAL_URL || ''
const terminalToken = process.env.EVEN_TERMINAL_TOKEN || ''
const terminalProvider = process.env.EVEN_TERMINAL_PROVIDER || 'codex'
const terminalSessionId = process.env.EVEN_TERMINAL_SESSION_ID || ''
const minAsrBytes = Number(process.env.MIN_ASR_BYTES || 6400)
const segmentSeconds = Number(process.env.ASR_SEGMENT_SECONDS || 20)
const bytesPerSecond = 16_000 * 2
const segmentBytesLimit = segmentSeconds > 0 ? Math.floor(segmentSeconds * bytesPerSecond) : 0
const chunkMode = (process.env.ASR_CHUNK_MODE || 'vad').toLowerCase()
const useVad = chunkMode !== 'fixed'
const vadThreshold = Number(process.env.VAD_THRESHOLD || 0.0018)
const vadSilenceMs = Number(process.env.VAD_SILENCE_MS || 700)
const vadMinSpeechMs = Number(process.env.VAD_MIN_SPEECH_MS || 250)
const vadPreRollMs = Number(process.env.VAD_PRE_ROLL_MS || 500)
const vadMinUtteranceMs = Number(process.env.VAD_MIN_UTTERANCE_MS || 700)
const transcriptsLog = process.env.TRANSCRIPTS_LOG || join(transcriptDirPath, 'transcripts.log')
const accessToken = process.env.EVEN_AUDIO_PIPE_TOKEN || ''
const runtimeConfigPath = process.env.EVEN_AUDIO_PIPE_CONFIG_PATH || ''
const transcriptCleanupEnv = {
  enabled: !isDisabled(process.env.TRANSCRIPT_CLEANUP_ENABLED || '0'),
  url: process.env.TRANSCRIPT_CLEANUP_URL || 'http://127.0.0.1:8080/v1/chat/completions',
  model: process.env.TRANSCRIPT_CLEANUP_MODEL || 'gemma-4-e4b-it-q4_0',
  temperature: Number(process.env.TRANSCRIPT_CLEANUP_TEMPERATURE || 0),
  timeoutMs: Number(process.env.TRANSCRIPT_CLEANUP_TIMEOUT_MS || 15_000),
  prompt: process.env.TRANSCRIPT_CLEANUP_PROMPT || defaultCleanupPrompt(),
  apiKey: process.env.TRANSCRIPT_CLEANUP_API_KEY || '',
}

mkdirSync(audioDirPath, { recursive: true })
mkdirSync(transcriptDirPath, { recursive: true })

let asrQueue = Promise.resolve()
let asrJobId = 0
let runtimeConfigCache = {
  mtimeMs: -1,
  config: {},
  warned: false,
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('Even Audio Pipe receiver. WebSocket path: /audio\n')
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost')

  if (url.pathname !== '/audio') {
    rejectUpgrade(socket, 404, 'Not Found')
    return
  }

  if (!isAuthorizedAudioRequest(url)) {
    console.warn(`[auth] rejected audio websocket from ${req.socket.remoteAddress}`)
    rejectUpgrade(socket, 401, 'Unauthorized')
    return
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req)
  })
})

function stamp() {
  const now = new Date()
  const pad = (value, length = 2) => String(value).padStart(length, '0')

  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    pad(now.getMilliseconds(), 3),
  ].join('-')
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer))
  return Buffer.from(data)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function renderAsrCommand(template, paths) {
  const replacements = {
    pcm: shellQuote(paths.pcm),
    wav: shellQuote(paths.wav),
    txt: shellQuote(paths.txt),
    rawTxt: shellQuote(paths.rawTxt),
    cleanTxt: shellQuote(paths.cleanTxt),
    json: shellQuote(paths.json),
  }

  return template.replace(/\{(pcm|wav|txt|rawTxt|cleanTxt|json)\}/g, (_match, key) => replacements[key])
}

function runShell(command, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(`[${label}] ${text}`)
    })

    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(`[${label}] ${text}`)
    })

    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`${label} exited with code ${code}: ${stderr || stdout}`))
      }
    })
  })
}

async function convertPcmToWav(pcmPath, wavPath) {
  const command = [
    'ffmpeg',
    '-hide_banner',
    '-loglevel error',
    '-y',
    '-f s16le',
    '-ar 16000',
    '-ac 1',
    `-i ${shellQuote(pcmPath)}`,
    shellQuote(wavPath),
  ].join(' ')

  await runShell(command, 'ffmpeg')
}

function sendSocketJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false

  try {
    socket.send(JSON.stringify(payload))
    return true
  } catch (err) {
    console.error(`[socket] failed to send ${payload?.type || 'message'}: ${err.message}`)
    return false
  }
}

function normalizeTranscript(text) {
  return text
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function stripCleanupDecorations(text) {
  return normalizeTranscript(text)
    .replace(/^```(?:text)?/i, '')
    .replace(/```$/i, '')
    .replace(/^cleaned transcript:\s*/i, '')
    .replace(/^cleaned:\s*/i, '')
    .replace(/^["“](.*)["”]$/s, '$1')
    .trim()
}

function defaultCleanupPrompt() {
  return [
    'You clean short ASR transcript chunks from smart glasses.',
    'Fix obvious speech recognition errors, capitalization, punctuation, and light grammar only.',
    'Always rewrite the misheard phrases "ling few", "lane view", and "lanefuse" as "Langfuse".',
    "Preserve the speaker's meaning and wording.",
    'Do not add facts, commands, explanations, or markdown.',
    'If uncertain, keep the original wording.',
    'Return only the cleaned transcript text.',
  ].join(' ')
}

function isDisabled(value) {
  return /^(|0|false|none|off|no)$/i.test(String(value).trim())
}

function isAuthorizedAudioRequest(url) {
  if (!accessToken) return true
  return url.searchParams.get('t') === accessToken || url.searchParams.get('token') === accessToken
}

function rejectUpgrade(socket, statusCode, statusText) {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

async function maybePostToTerminal(text) {
  if (!terminalUrl || !terminalToken || !text) return

  const body = {
    text,
    provider: terminalProvider,
  }

  if (terminalSessionId) body.sessionId = terminalSessionId

  const res = await fetch(`${terminalUrl.replace(/\/$/, '')}/api/prompt`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${terminalToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    throw new Error(`even-terminal POST failed: HTTP ${res.status} ${errorText.slice(0, 200)}`)
  }

  console.log(`[terminal] posted transcript to ${terminalUrl}`)
}

async function transcribeWithWorker(wavPath) {
  const res = await fetch(`${asrWorkerUrl.replace(/\/$/, '')}/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

  return normalizeTranscript(body?.text || '')
}

function currentTranscriptCleanupConfig() {
  const runtimePrompt = readRuntimeCleanupPrompt()

  return {
    ...transcriptCleanupEnv,
    temperature: Number.isFinite(transcriptCleanupEnv.temperature) ? transcriptCleanupEnv.temperature : 0,
    timeoutMs: Number.isFinite(transcriptCleanupEnv.timeoutMs) ? transcriptCleanupEnv.timeoutMs : 15_000,
    prompt: runtimePrompt || transcriptCleanupEnv.prompt || defaultCleanupPrompt(),
  }
}

function readRuntimeCleanupPrompt() {
  const config = readRuntimeConfig()
  const prompt = config?.transcriptCleanup?.prompt
  return typeof prompt === 'string' ? prompt : ''
}

function readRuntimeConfig() {
  if (!runtimeConfigPath) return runtimeConfigCache.config

  try {
    return loadRuntimeConfigFile()
  } catch (err) {
    if (err?.code !== 'ENOENT' && !runtimeConfigCache.warned) {
      console.warn(`[config] could not reload runtime config; keeping previous values: ${err.message}`)
      runtimeConfigCache.warned = true
    }
    return runtimeConfigCache.config
  }
}

function loadRuntimeConfigFile() {
  const stat = statSync(runtimeConfigPath)
  if (stat.mtimeMs === runtimeConfigCache.mtimeMs) return runtimeConfigCache.config

  runtimeConfigCache = {
    mtimeMs: stat.mtimeMs,
    config: JSON.parse(readFileSync(runtimeConfigPath, 'utf8')),
    warned: false,
  }
  return runtimeConfigCache.config
}

function currentUserAuthConfig() {
  const auth = readRuntimeConfig()?.auth || {}
  const allowedUserIds = stringSet(auth.allowedUserIds || auth.userIds || auth.uids)

  return {
    required: allowedUserIds.size > 0,
    allowedUserIds,
  }
}

function stringSet(value, options = {}) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/)
      : []
  const normalized = values
    .map(item => String(item).trim())
    .filter(Boolean)
    .map(item => options.lower ? item.toLowerCase() : item)

  return new Set(normalized)
}

function userLabel(user) {
  if (!user) return 'unknown'
  return [
    user.uid ? `uid=${user.uid}` : '',
    user.name ? `name=${user.name}` : '',
  ].filter(Boolean).join(' ') || 'unknown'
}

function normalizeUser(value) {
  if (!value || typeof value !== 'object') return null

  const user = {
    uid: stringValue(value.uid ?? value.userId ?? value.id),
    name: stringValue(value.name ?? value.userName),
    country: stringValue(value.country),
  }

  return user.uid || user.name || user.country ? user : null
}

function stringValue(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function isAllowedUser(user, auth) {
  if (!auth.required) return true
  if (!user) return false
  if (user.uid && auth.allowedUserIds.has(user.uid)) return true
  return false
}

function parseControlMessage(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function persistScannedUser(user, status) {
  if (!runtimeConfigPath || !user) return

  try {
    const config = loadRuntimeConfigFile()
    const auth = config.auth && typeof config.auth === 'object' ? config.auth : {}
    const seenAt = new Date().toISOString()
    const savedUser = compactObject({
      uid: user.uid,
      name: user.name,
      country: user.country,
      status,
      seenAt,
    })
    const scannedUsers = Array.isArray(auth.scannedUsers) ? auth.scannedUsers : []
    const nextScannedUsers = upsertScannedUser(scannedUsers, savedUser).slice(-25)

    config.auth = {
      ...auth,
      lastUser: savedUser,
      scannedUsers: nextScannedUsers,
    }

    writeFileSync(runtimeConfigPath, `${JSON.stringify(config, null, 2)}\n`)
    runtimeConfigCache = {
      mtimeMs: statSync(runtimeConfigPath).mtimeMs,
      config,
      warned: false,
    }
    console.log(`[auth] saved Even user to config: ${userLabel(user)} status=${status}`)
  } catch (err) {
    console.warn(`[auth] failed to save Even user to config: ${err.message}`)
  }
}

function upsertScannedUser(users, user) {
  const key = user.uid ? `uid:${user.uid}` : ''
  if (!key) return [...users, user]

  const filtered = users.filter(existing => {
    const existingKey = existing?.uid ? `uid:${String(existing.uid)}` : ''
    return existingKey !== key
  })
  return [...filtered, user]
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  )
}

async function cleanTranscript(rawTranscript, cleanupConfig = currentTranscriptCleanupConfig()) {
  if (!cleanupConfig.enabled) {
    return {
      enabled: false,
      ok: true,
      text: rawTranscript,
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cleanupConfig.timeoutMs)
  timeout.unref?.()

  try {
    const headers = { 'content-type': 'application/json' }
    if (cleanupConfig.apiKey) {
      headers.authorization = `Bearer ${cleanupConfig.apiKey}`
    }

    const res = await fetch(cleanupConfig.url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: cleanupConfig.model,
        temperature: cleanupConfig.temperature,
        messages: [
          {
            role: 'system',
            content: cleanupConfig.prompt,
          },
          {
            role: 'user',
            content: [
              'Raw ASR transcript:',
              rawTranscript,
              '',
              'Cleaned transcript:',
            ].join('\n'),
          },
        ],
      }),
    })

    const bodyText = await res.text()
    let body
    try {
      body = JSON.parse(bodyText)
    } catch {
      body = { error: bodyText }
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${body?.error?.message || body?.error || bodyText}`)
    }

    const content = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text ?? ''
    const cleaned = stripCleanupDecorations(content)

    if (!cleaned) {
      throw new Error('cleanup model returned empty text')
    }

    return {
      enabled: true,
      ok: true,
      model: cleanupConfig.model,
      text: cleaned,
    }
  } catch (err) {
    const error = err?.name === 'AbortError'
      ? `cleanup timed out after ${cleanupConfig.timeoutMs}ms`
      : err?.message || String(err)
    console.error(`[cleanup] failed; using raw transcript: ${error}`)
    return {
      enabled: true,
      ok: false,
      model: cleanupConfig.model,
      text: rawTranscript,
      error,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function processRecording(paths, bytes, targetSocket, jobId, user) {
  if (bytes < minAsrBytes) {
    console.log(`[asr] skipping short recording (${bytes} bytes < ${minAsrBytes})`)
    return
  }

  console.log(`[asr] converting PCM to WAV: ${paths.wav}`)
  await convertPcmToWav(paths.pcm, paths.wav)

  if (!asrWorkerUrl && !asrCommand) {
    console.log('[asr] ASR_WORKER_URL/ASR_COMMAND is not set; WAV saved but no transcription was run')
    return
  }

  let rawTranscript = ''
  if (asrWorkerUrl) {
    console.log(`[asr] sending WAV to worker: ${asrWorkerUrl}`)
    sendSocketJson(targetSocket, {
      type: 'asr_status',
      status: 'transcribing',
      jobId,
      file: basename(paths.wav),
    })
    rawTranscript = await transcribeWithWorker(paths.wav)
  } else {
    const command = renderAsrCommand(asrCommand, paths)
    console.log(`[asr] running ASR command: ${command}`)
    sendSocketJson(targetSocket, {
      type: 'asr_status',
      status: 'transcribing',
      jobId,
      file: basename(paths.wav),
    })
    const result = await runShell(command, 'asr')
    rawTranscript = normalizeTranscript(result.stdout)
  }

  if (rawTranscript) {
    const cleanupConfig = currentTranscriptCleanupConfig()
    if (cleanupConfig.enabled) {
      sendSocketJson(targetSocket, {
        type: 'asr_status',
        status: 'cleaning',
        jobId,
        file: basename(paths.wav),
      })
    }

    const cleanup = await cleanTranscript(rawTranscript, cleanupConfig)
    const cleanedTranscript = cleanup.text

    writeTranscriptFiles(paths, rawTranscript, cleanedTranscript, cleanup, user)
    appendTranscript(rawTranscript, cleanedTranscript, paths, cleanup, user)
    console.log(`[transcript:raw] ${rawTranscript}`)
    console.log(`[transcript:clean] ${cleanedTranscript}`)
    console.log(`[asr] transcript saved: ${paths.txt}`)
    sendSocketJson(targetSocket, {
      type: 'transcript',
      text: cleanedTranscript,
      rawText: rawTranscript,
      cleanedText: cleanedTranscript,
      cleanup: {
        enabled: cleanup.enabled,
        ok: cleanup.ok,
        model: cleanup.model,
        error: cleanup.error,
      },
      user,
      jobId,
      file: basename(paths.txt),
      rawFile: basename(paths.rawTxt),
      cleanFile: basename(paths.cleanTxt),
      createdAt: new Date().toISOString(),
    })
    await maybePostToTerminal(cleanedTranscript)
  } else {
    console.log('[asr] no transcript returned')
    sendSocketJson(targetSocket, {
      type: 'asr_status',
      status: 'no_transcript',
      jobId,
      file: basename(paths.wav),
    })
  }
}

function writeTextFile(path, content) {
  writeFileSync(path, content)
}

function writeJsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeTranscriptFiles(paths, rawTranscript, cleanedTranscript, cleanup, user) {
  writeTextFile(paths.rawTxt, `${rawTranscript}\n`)
  writeTextFile(paths.cleanTxt, `${cleanedTranscript}\n`)
  writeTextFile(paths.txt, `${cleanedTranscript}\n`)
  writeJsonFile(paths.json, {
    createdAt: new Date().toISOString(),
    raw: rawTranscript,
    cleaned: cleanedTranscript,
    cleanup,
    user,
    files: {
      audio: paths.wav,
      rawTranscript: paths.rawTxt,
      cleanedTranscript: paths.cleanTxt,
      displayTranscript: paths.txt,
    },
  })
}

function appendTranscript(rawTranscript, cleanedTranscript, paths, cleanup, user) {
  const line = JSON.stringify({
    createdAt: new Date().toISOString(),
    raw: rawTranscript,
    cleaned: cleanedTranscript,
    cleanup,
    user,
    files: {
      audio: paths.wav,
      rawTranscript: paths.rawTxt,
      cleanedTranscript: paths.cleanTxt,
      displayTranscript: paths.txt,
    },
  })
  appendFileSync(transcriptsLog, `${line}\n`)
}

function enqueueRecording(paths, bytes, reason, targetSocket, user) {
  const jobId = ++asrJobId

  asrQueue = asrQueue
    .catch(() => {})
    .then(async () => {
      console.log(`[asr] job ${jobId} started (${reason}): ${paths.pcm}`)
      await processRecording(paths, bytes, targetSocket, jobId, user)
      console.log(`[asr] job ${jobId} finished`)
    })
    .catch(err => {
      console.error(`[asr] job ${jobId} failed: ${err.message}`)
    })
}

function recordingPaths(connectionStamp, segmentIndex) {
  const id = `g2-${connectionStamp}-${String(segmentIndex).padStart(3, '0')}`

  return {
    pcm: join(audioDirPath, `${id}.pcm`),
    wav: join(audioDirPath, `${id}.wav`),
    txt: join(transcriptDirPath, `${id}.txt`),
    rawTxt: join(transcriptDirPath, `${id}.raw.txt`),
    cleanTxt: join(transcriptDirPath, `${id}.clean.txt`),
    json: join(transcriptDirPath, `${id}.json`),
  }
}

function bufferDurationMs(buffer) {
  return (buffer.byteLength / bytesPerSecond) * 1000
}

function pcmRms(buffer) {
  const samples = Math.floor(buffer.byteLength / 2)
  if (!samples) return 0

  let sumSquares = 0
  for (let offset = 0; offset + 1 < buffer.byteLength; offset += 2) {
    const value = buffer.readInt16LE(offset) / 32768
    sumSquares += value * value
  }
  return Math.sqrt(sumSquares / samples)
}

function pushPreRoll(preRoll, chunk, maxBytes) {
  if (maxBytes <= 0) return
  preRoll.buffers.push(chunk)
  preRoll.bytes += chunk.byteLength

  while (preRoll.bytes > maxBytes && preRoll.buffers.length) {
    const removed = preRoll.buffers.shift()
    preRoll.bytes -= removed.byteLength
  }
}

wss.on('connection', (socket, req) => {
  const connectionStamp = stamp()
  let currentSegment = null
  let segmentIndex = 0
  let bytes = 0
  let chunks = 0
  let lastBytes = 0
  let userAuthenticated = false
  let evenUser = null
  const preRoll = { buffers: [], bytes: 0 }
  const preRollBytes = Math.floor((vadPreRollMs / 1000) * bytesPerSecond)

  console.log(`[audio] connected from ${req.socket.remoteAddress}`)
  sendSocketJson(socket, {
    type: 'receiver_status',
    status: 'connected',
    asrConfigured: Boolean(asrWorkerUrl || asrCommand),
    chunkMode: useVad ? 'vad' : 'fixed',
  })

  if (useVad) {
    console.log(
      `[audio] VAD chunking threshold=${vadThreshold} silence=${vadSilenceMs}ms max=${segmentSeconds}s`,
    )
  } else if (segmentBytesLimit) {
    console.log(`[audio] fixed recordings every ${segmentSeconds}s (${segmentBytesLimit} bytes)`)
  } else {
    console.log('[audio] recording one file until the socket closes')
  }

  const meter = setInterval(() => {
    const delta = bytes - lastBytes
    lastBytes = bytes
    console.log(`[audio] ${chunks} chunks, ${bytes} bytes total, ${delta} B/s`)
  }, 1000)

  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString()
      console.log(`[audio] control ${text}`)
      const control = parseControlMessage(text)
      if (control?.type === 'start') {
        evenUser = normalizeUser(control.user)
        const auth = currentUserAuthConfig()

        console.log(`[auth] even user received: ${userLabel(evenUser)}`)
        if (auth.required && !isAllowedUser(evenUser, auth)) {
          console.warn(`[auth] rejected Even user: ${userLabel(evenUser)}`)
          persistScannedUser(evenUser, 'rejected')
          sendSocketJson(socket, {
            type: 'auth_status',
            status: 'rejected',
            user: evenUser,
          })
          socket.close(1008, 'Even user is not allowed')
          return
        }

        userAuthenticated = true
        console.log(`[auth] accepted Even user: ${userLabel(evenUser)}`)
        persistScannedUser(evenUser, 'accepted')
        if (!auth.required) {
          console.log('[auth] no user allowlist configured; add auth.allowedUserIds in config.json to restrict users')
        }
        sendSocketJson(socket, {
          type: 'auth_status',
          status: 'accepted',
          user: evenUser,
          restricted: auth.required,
        })
      }
      return
    }

    if (!userAuthenticated) {
      const auth = currentUserAuthConfig()
      if (auth.required) {
        console.warn('[auth] rejected audio before Even user start message')
        socket.close(1008, 'Even user is required')
        return
      }
      userAuthenticated = true
    }

    const chunk = toBuffer(data)
    chunks += 1
    bytes += chunk.byteLength

    if (useVad) {
      handleVadChunk(chunk)
    } else {
      const segment = getCurrentSegment()
      writeSegmentChunk(segment, chunk)

      if (segmentBytesLimit && segment.bytes >= segmentBytesLimit) {
        closeCurrentSegment('segment limit')
      }
    }
  })

  socket.on('close', () => {
    clearInterval(meter)
    closeCurrentSegment('socket close')
    console.log(`[audio] closed: ${chunks} chunks, ${bytes} bytes total`)
  })

  socket.on('error', err => {
    console.error(`[audio] socket error: ${err.message}`)
  })

  function getCurrentSegment() {
    if (currentSegment) return currentSegment

    segmentIndex += 1
    const paths = recordingPaths(connectionStamp, segmentIndex)
    currentSegment = {
      paths,
      stream: createWriteStream(paths.pcm),
      bytes: 0,
      chunks: 0,
      speechMs: 0,
      silenceMs: 0,
      durationMs: 0,
      hasSpeech: false,
    }
    console.log(`[audio] writing raw PCM to ${paths.pcm}`)
    return currentSegment
  }

  function handleVadChunk(chunk) {
    const rms = pcmRms(chunk)
    const durationMs = bufferDurationMs(chunk)
    const isSpeech = rms >= vadThreshold
    let wroteCurrentChunk = false

    if (!currentSegment) {
      if (!isSpeech) {
        pushPreRoll(preRoll, chunk, preRollBytes)
        return
      }

      const segment = getCurrentSegment()
      for (const buffered of preRoll.buffers) {
        writeSegmentChunk(segment, buffered, { countChunk: false })
      }
      preRoll.buffers = []
      preRoll.bytes = 0
    }

    const segment = getCurrentSegment()
    if (!wroteCurrentChunk) {
      writeSegmentChunk(segment, chunk)
    }

    if (isSpeech) {
      segment.speechMs += durationMs
      segment.silenceMs = 0
      segment.hasSpeech = true
    } else {
      segment.silenceMs += durationMs
    }

    if (segmentBytesLimit && segment.bytes >= segmentBytesLimit) {
      closeCurrentSegment('max utterance')
      return
    }

    if (
      segment.hasSpeech &&
      segment.speechMs >= vadMinSpeechMs &&
      segment.durationMs >= vadMinUtteranceMs &&
      segment.silenceMs >= vadSilenceMs
    ) {
      closeCurrentSegment('vad silence')
    }
  }

  function writeSegmentChunk(segment, chunk, options = {}) {
    const countChunk = options.countChunk !== false
    segment.bytes += chunk.byteLength
    segment.durationMs += bufferDurationMs(chunk)
    if (countChunk) segment.chunks += 1
    segment.stream.write(chunk)
  }

  function closeCurrentSegment(reason) {
    if (!currentSegment) return

    const segment = currentSegment
    currentSegment = null

    segment.stream.end(() => {
      console.log(
        `[audio] segment closed (${reason}): ${segment.chunks} chunks, ${segment.bytes} bytes, duration=${(segment.durationMs / 1000).toFixed(2)}s, file=${segment.paths.pcm}`,
      )
      enqueueRecording(segment.paths, segment.bytes, reason, socket, evenUser)
    })
  }
})

server.listen(port, '0.0.0.0', () => {
  const startupCleanupConfig = currentTranscriptCleanupConfig()
  const startupUserAuthConfig = currentUserAuthConfig()
  console.log(`[server] HTTP health: http://0.0.0.0:${port}/health`)
  console.log(`[server] WebSocket audio: ws://0.0.0.0:${port}/audio`)
  console.log('[server] Use your laptop LAN/Tailscale IP in the Even Hub app, not localhost.')
  console.log(`[server] Audio directory: ${audioDirPath}`)
  console.log(`[server] Transcript directory: ${transcriptDirPath}`)
  console.log(`[server] Transcript log: ${transcriptsLog}`)
  console.log(`[server] Audio auth: ${accessToken ? 'enabled' : 'disabled'}`)
  console.log(`[server] Even user allowlist: ${startupUserAuthConfig.required ? 'enabled' : 'disabled'}`)
  console.log(`[server] Chunk mode: ${useVad ? 'vad' : 'fixed'}`)
  console.log(`[server] ASR max segment seconds: ${segmentSeconds > 0 ? segmentSeconds : 'off'}`)
  console.log(`[server] ASR worker: ${asrWorkerUrl || 'not configured'}`)
  console.log(`[server] ASR command fallback: ${asrCommand ? 'configured' : 'not configured'}`)
  console.log(
    `[server] Transcript cleanup: ${startupCleanupConfig.enabled ? `${startupCleanupConfig.model} at ${startupCleanupConfig.url}` : 'disabled'}`,
  )
  if (runtimeConfigPath) {
    console.log(`[server] Cleanup prompt hot reload: ${runtimeConfigPath}`)
  }
})
