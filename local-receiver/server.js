import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, createWriteStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { VadEndpoint } from './vad-endpoint.js'
import { createSileroFrameVad } from './silero-vad.ts'
import {
  markQueuedTranscriptActivity,
  queuedTranscriptActivityAt,
  transcriptQueueMaxHoldReached as transcriptQueueMaxHoldReachedSinceActivity,
} from './transcript-queue.js'
import { createWorkbenchRouter } from './workbench-router.js'

const port = Number(process.env.PORT || 8788)
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
const workbenchConfig = {
  enabled: !isDisabled(process.env.SPEECH_WORKBENCH_ENABLED || '0'),
  url: process.env.SPEECH_WORKBENCH_URL || 'http://127.0.0.1:8787',
  token: process.env.SPEECH_WORKBENCH_TOKEN || '',
  agent: process.env.SPEECH_WORKBENCH_AGENT || '',
  agents: stringList(process.env.SPEECH_WORKBENCH_AGENTS || ''),
  requireAgentPrefix: !isDisabled(process.env.SPEECH_WORKBENCH_REQUIRE_AGENT_PREFIX || '1'),
  agentPrefixWordLimit: Number(process.env.SPEECH_WORKBENCH_AGENT_PREFIX_WORD_LIMIT || 3),
  agentArmTimeoutMs: Number(process.env.SPEECH_WORKBENCH_AGENT_ARM_TIMEOUT_MS || 30_000),
  timeoutMs: Number(process.env.SPEECH_WORKBENCH_TIMEOUT_MS || 15_000),
  summaryToken: process.env.SPEECH_WORKBENCH_SUMMARY_TOKEN || '',
  summaryPath: normalizeHttpPath(process.env.SPEECH_WORKBENCH_SUMMARY_PATH || '/workbench/summary'),
  progressStaleMs: Number(process.env.SPEECH_WORKBENCH_PROGRESS_STALE_MS || 180_000),
}
const workbenchRouter = createWorkbenchRouter(workbenchConfig)
const minAsrBytes = Number(process.env.MIN_ASR_BYTES || 6400)
const segmentSeconds = Number(process.env.ASR_SEGMENT_SECONDS || 20)
const bytesPerSecond = 16_000 * 2
const segmentBytesLimit = segmentSeconds > 0 ? Math.floor(segmentSeconds * bytesPerSecond) : 0
const chunkMode = (process.env.ASR_CHUNK_MODE || 'vad').toLowerCase()
const useVad = chunkMode !== 'fixed'
const vadBackend = String(process.env.VAD_BACKEND || 'silero').trim().toLowerCase()
const vadFrameMs = Number(process.env.VAD_FRAME_MS || 30)
const sileroVadFrameSamples = normalizeSileroFrameSamples(process.env.SILERO_VAD_FRAME_SAMPLES || 512)
const vadFrameSamples = vadBackend === 'silero'
  ? sileroVadFrameSamples
  : Math.max(1, Math.floor((vadFrameMs / 1000) * 16_000))
const vadFrameBytes = Math.max(2, vadFrameSamples * 2)
const vadStartThreshold = Number(process.env.VAD_START_THRESHOLD || process.env.VAD_THRESHOLD || 0.006)
const vadReleaseThreshold = Number(
  process.env.VAD_RELEASE_THRESHOLD ||
  Math.max(0.0025, vadStartThreshold * 0.55),
)
const vadSilenceMs = Number(process.env.VAD_SILENCE_MS || (vadBackend === 'silero' ? 240 : 700))
const vadMinSpeechMs = Number(process.env.VAD_MIN_SPEECH_MS || (vadBackend === 'silero' ? 60 : 250))
const vadPreRollMs = Number(process.env.VAD_PRE_ROLL_MS || 500)
const vadMinUtteranceMs = Number(process.env.VAD_MIN_UTTERANCE_MS || (vadBackend === 'silero' ? 250 : 700))
const sileroVadModel = process.env.SILERO_VAD_MODEL || ''
const sileroVadThreshold = Number(process.env.SILERO_VAD_THRESHOLD || 0.5)
const transcriptQueueIdleMs = Number(process.env.TRANSCRIPT_QUEUE_IDLE_MS || 3_000)
const transcriptQueueMaxHoldMs = Number(process.env.TRANSCRIPT_QUEUE_MAX_HOLD_MS || 10_000)
const receiverIdleAudioFreshMs = Number(process.env.RECEIVER_IDLE_AUDIO_FRESH_MS || 2_500)
const transcriptsLog = process.env.TRANSCRIPTS_LOG || join(transcriptDirPath, 'transcripts.log')
const messageHistoryDirPath = resolve(process.env.MESSAGE_HISTORY_DIR || join(transcriptDirPath, 'message-history'))
const messageHistoryLimit = Number(process.env.MESSAGE_HISTORY_LIMIT || 0)
const summaryTextFields = ['text', 'summary', 'message', 'response']
const detailTextFields = [
  'detail',
  'details',
  'detail_response',
  'detailResponse',
  'detailed_response',
  'detailedResponse',
  'response_detail',
  'responseDetail',
  'detail response',
  'detailed response',
]
const accessToken = process.env.EVEN_AUDIO_PIPE_TOKEN || ''
const accessTokenSecret = process.env.EVEN_AUDIO_PIPE_TOKEN_SECRET || ''
const transportAuthTimeoutMs = Number(process.env.EVEN_AUDIO_PIPE_AUTH_TIMEOUT_MS || 8_000)
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
mkdirSync(messageHistoryDirPath, { recursive: true })

let asrQueue = Promise.resolve()
let asrJobId = 0
let runtimeConfigCache = {
  mtimeMs: -1,
  config: {},
  warned: false,
}
const audioSockets = new Set()
const transcriptQueues = new WeakMap()
const activeWorkbenchAgents = new Map()
const recentWorkbenchSummaries = new Map()
let sileroVad = null
let sileroVadStartPromise = null
let sileroVadUnavailable = false
let sileroVadFallbackLogged = false

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (req.method === 'POST' && url.pathname === workbenchConfig.summaryPath) {
    handleWorkbenchSummary(req, res).catch(err => {
      console.error(`[workbench] summary webhook failed: ${err.message}`)
      if (!res.headersSent) {
        sendHttpJson(res, err.statusCode || 500, { ok: false, error: err.code || 'summary_failed' })
      } else {
        res.end()
      }
    })
    return
  }

  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end(`Agent Audio Pipe receiver. WebSocket path: /audio. Workbench summary path: ${workbenchConfig.summaryPath}\n`)
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost')

  if (url.pathname !== '/audio') {
    rejectUpgrade(socket, 404, 'Not Found')
    return
  }

  const transportAuth = audioTransportAuthForRequest(url)
  if (transportAuth.rejected) {
    console.warn(`[auth] rejected audio websocket from ${req.socket.remoteAddress}`)
    rejectUpgrade(socket, 401, 'Unauthorized')
    return
  }

  req.audioTransportAuth = transportAuth
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

function broadcastSocketJson(payload) {
  let sent = 0
  for (const socket of audioSockets) {
    if (sendSocketJson(socket, payload)) sent += 1
  }
  return sent
}

function sanitizeMessageHistoryEntry(value) {
  if (!value || typeof value !== 'object') return null

  const detail = normalizeTranscript(textFromFields(value, detailTextFields))
  const text = normalizeTranscript(textFromFields(value, summaryTextFields) || detail)
  if (!text) return null

  const receivedAt = Number(value.receivedAt)
  const createdAt = stringValue(value.createdAt)
  const timestamp = Number.isFinite(receivedAt)
    ? receivedAt
    : createdAt
      ? Date.parse(createdAt)
      : Date.now()

  const entry = {
    label: stringValue(value.label || value.agent || value.source || 'Message') || 'Message',
    text,
    receivedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
    createdAt: new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString(),
  }
  if (detail) entry.detail = detail
  return entry
}

function historyDateStamp(value = Date.now()) {
  const date = new Date(value)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function messageHistoryPathForTimestamp(timestamp) {
  return join(messageHistoryDirPath, `${historyDateStamp(timestamp)}.jsonl`)
}

function messageHistoryFiles() {
  try {
    return readdirSync(messageHistoryDirPath)
      .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[history] failed to list ${messageHistoryDirPath}: ${err.message}`)
    }
    return []
  }
}

function readMessageHistoryFile(fileName) {
  const path = join(messageHistoryDirPath, fileName)

  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try {
          return sanitizeMessageHistoryEntry(JSON.parse(line))
        } catch (err) {
          console.warn(`[history] failed to parse ${fileName}: ${err.message}`)
          return null
        }
      })
      .filter(Boolean)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[history] failed to read ${path}: ${err.message}`)
    }
    return []
  }
}

function readMessageHistory(limit = messageHistoryLimit, dateStamp = historyDateStamp()) {
  const fileName = `${dateStamp}.jsonl`
  const entries = messageHistoryFiles().includes(fileName)
    ? readMessageHistoryFile(fileName)
    : []

  return entries
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .slice(limit > 0 ? -limit : 0)
}

function appendMessageHistory(entry) {
  const normalized = sanitizeMessageHistoryEntry(entry)
  if (!normalized) return

  const path = messageHistoryPathForTimestamp(normalized.receivedAt)
  try {
    appendFileSync(path, `${JSON.stringify(normalized)}\n`)
  } catch (err) {
    console.warn(`[history] failed to append ${path}: ${err.message}`)
  }
}

function sendMessageHistory(socket) {
  const date = historyDateStamp()
  const entries = readMessageHistory(messageHistoryLimit, date)
  sendSocketJson(socket, {
    type: 'message_history',
    date,
    entries,
  })
}

function sendHttpJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
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

function textFromFields(record, fields) {
  for (const field of fields) {
    const text = stringValue(record?.[field])
    if (text) return text
  }
  return ''
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
    'Do not remove command words after a routing target; keep "Wolf terminate session" as "Wolf terminate session", not "Wolf".',
    'Do not add facts, commands, explanations, or markdown.',
    'If uncertain, keep the original wording.',
    'Return only the cleaned transcript text.',
  ].join(' ')
}

function isDisabled(value) {
  return /^(|0|false|none|off|no)$/i.test(String(value).trim())
}

function normalizeHttpPath(value) {
  const path = String(value || '').trim() || '/'
  return path.startsWith('/') ? path : `/${path}`
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  return String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean)
}

function normalizeAgentName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function workbenchAgentNames() {
  return workbenchConfig.agents.length
    ? workbenchConfig.agents
    : ['Flux', 'Brock', 'Pike', 'Wolf']
}

function canonicalWorkbenchAgent(agent) {
  const requested = normalizeAgentName(agent)
  if (!requested) return ''

  return workbenchAgentNames()
    .find(candidate => normalizeAgentName(candidate) === requested) || ''
}

function activeWorkbenchAgentNames() {
  return Array.from(activeWorkbenchAgents.values()).map(state => state.label)
}

function workbenchStatus() {
  return {
    enabled: workbenchConfig.enabled,
    agents: workbenchAgentNames(),
    activeAgents: activeWorkbenchAgentNames(),
  }
}

function broadcastWorkbenchStatus() {
  broadcastSocketJson({
    type: 'workbench_status',
    workbench: workbenchStatus(),
  })
}

function configuredWorkbenchProgressStaleMs() {
  const staleMs = Number(workbenchConfig.progressStaleMs)
  return Number.isFinite(staleMs) ? Math.max(0, Math.floor(staleMs)) : 180_000
}

function clearWorkbenchProgressTimer(state) {
  if (!state?.timer) return
  clearTimeout(state.timer)
  delete state.timer
}

function scheduleWorkbenchProgressExpiry(key) {
  const state = activeWorkbenchAgents.get(key)
  if (!state) return

  clearWorkbenchProgressTimer(state)

  const staleMs = configuredWorkbenchProgressStaleMs()
  if (staleMs <= 0) return

  const delayMs = Math.max(1, state.updatedAt + staleMs - Date.now())
  state.timer = setTimeout(() => {
    const current = activeWorkbenchAgents.get(key)
    if (!current) return

    const elapsedMs = Date.now() - current.updatedAt
    if (elapsedMs < configuredWorkbenchProgressStaleMs()) {
      scheduleWorkbenchProgressExpiry(key)
      return
    }

    clearWorkbenchProgressTimer(current)
    activeWorkbenchAgents.delete(key)
    console.log(
      `[workbench] cleared stale progress for ${current.label}: no new content for ${(elapsedMs / 1000).toFixed(1)}s`,
    )
    broadcastWorkbenchStatus()
  }, delayMs)
  state.timer.unref?.()
}

function setWorkbenchAgentInProgress(agent, inProgress, options = {}) {
  const label = canonicalWorkbenchAgent(agent) || stringValue(agent)
  const key = normalizeAgentName(label)
  if (!key) return false

  const previous = activeWorkbenchAgents.get(key)
  if (inProgress) {
    const signature = stringValue(options.signature)
    const activityChanged = !previous ||
      options.forceActivity === true ||
      !signature ||
      previous.signature !== signature
    if (!activityChanged && previous.label === label) return false

    clearWorkbenchProgressTimer(previous)
    const state = {
      label,
      signature: signature || previous?.signature || '',
      updatedAt: Number.isFinite(options.updatedAt) ? options.updatedAt : Date.now(),
    }
    activeWorkbenchAgents.set(key, state)
    scheduleWorkbenchProgressExpiry(key)
    if (previous?.label === label) return true
  } else if (previous) {
    clearWorkbenchProgressTimer(previous)
    activeWorkbenchAgents.delete(key)
  } else {
    return false
  }

  broadcastWorkbenchStatus()
  return true
}

function isAuthorizedAudioRequest(url) {
  if (!accessToken) return true
  return url.searchParams.get('t') === accessToken || url.searchParams.get('token') === accessToken
}

function audioTransportAuthForRequest(url) {
  if (accessToken && isAuthorizedAudioRequest(url)) {
    return {
      accepted: true,
      mode: 'url-token',
      rejected: false,
      challenge: false,
    }
  }

  if (!accessToken && !accessTokenSecret) {
    return {
      accepted: true,
      mode: 'disabled',
      rejected: false,
      challenge: false,
    }
  }

  if (accessTokenSecret) {
    return {
      accepted: false,
      mode: 'shared-secret',
      rejected: false,
      challenge: true,
    }
  }

  return {
    accepted: false,
    mode: 'url-token',
    rejected: true,
    challenge: false,
  }
}

function authProof(secret, nonce) {
  return createHmac('sha256', secret).update(nonce).digest('base64url')
}

function isValidAuthProof(secret, nonce, proof) {
  if (!secret || !nonce || !proof) return false
  const expected = Buffer.from(authProof(secret, nonce))
  const received = Buffer.from(String(proof))
  return expected.length === received.length && timingSafeEqual(expected, received)
}

function isAuthorizedBearerRequest(req, token) {
  if (!token) return true
  const auth = req.headers.authorization || ''
  return auth === `Bearer ${token}` || req.headers['x-workbench-summary-token'] === token
}

function rejectUpgrade(socket, statusCode, statusText) {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

async function readJsonRequest(req, limitBytes = 65_536) {
  const chunks = []
  let bytes = 0

  for await (const chunk of req) {
    const buffer = toBuffer(chunk)
    bytes += buffer.byteLength
    if (bytes > limitBytes) {
      const err = new Error('request body too large')
      err.statusCode = 413
      err.code = 'invalid_body_size'
      throw err
    }
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) {
    const err = new Error('empty request body')
    err.statusCode = 400
    err.code = 'empty_body'
    throw err
  }

  try {
    return JSON.parse(text)
  } catch (parseErr) {
    const err = new Error(`invalid JSON: ${parseErr.message}`)
    err.statusCode = 400
    err.code = 'invalid_json'
    throw err
  }
}

function detailTextFromWorkbenchPayload(payload) {
  const detail = normalizeTranscript(textFromFields(payload, detailTextFields))
  if (detail) return detail

  const detailLines = payload?.detail_lines || payload?.detailLines
  if (!Array.isArray(detailLines)) return ''

  return normalizeTranscript(detailLines.map(stringValue).join('\n'))
}

function pruneRecentWorkbenchSummaries(now = Date.now()) {
  const windowMs = 5_000
  for (const [key, receivedAt] of recentWorkbenchSummaries) {
    if (now - receivedAt > windowMs) recentWorkbenchSummaries.delete(key)
  }
}

function workbenchSummaryDuplicateKey(agent, summary, detail, phase, isFinal) {
  return JSON.stringify({
    agent: normalizeAgentName(agent),
    summary,
    detail,
    phase,
    isFinal,
  })
}

function publishWorkbenchSummary(payload, options = {}) {
  const detail = options.detail !== undefined
    ? normalizeTranscript(options.detail)
    : detailTextFromWorkbenchPayload(payload)
  const summary = normalizeTranscript(textFromFields(payload, summaryTextFields) || detail)
  if (!summary) return null

  const agent = stringValue(payload.agent)
  const command = stringValue(payload.command)
  const phase = stringValue(payload.phase || (payload.is_final ? 'final' : 'in_progress'))
  const isFinal = payload.is_final === true || phase === 'final'
  const timestamp = payload.timestamp ?? Date.now() / 1000
  const createdAt = new Date().toISOString()
  const now = Date.now()
  pruneRecentWorkbenchSummaries(now)
  const duplicateKey = workbenchSummaryDuplicateKey(agent, summary, detail, phase, isFinal)
  if (recentWorkbenchSummaries.has(duplicateKey)) {
    console.log(`[workbench] duplicate summary ignored${agent ? ` from ${agent}` : ''}: ${summary}`)
    return {
      delivered: 0,
      duplicate: true,
      summary,
      detail,
      agent,
      command,
      phase,
      isFinal,
    }
  }
  recentWorkbenchSummaries.set(duplicateKey, now)
  setWorkbenchAgentInProgress(agent, !isFinal, {
    signature: detail || summary,
  })
  appendMessageHistory({
    label: agent || 'Agent',
    text: summary,
    detail,
    createdAt,
  })
  const delivered = broadcastSocketJson({
    type: 'agent_summary',
    text: summary,
    summary,
    detail,
    detail_response: detail,
    agent,
    command,
    is_final: isFinal,
    phase,
    timestamp,
    createdAt,
  })

  console.log(`[workbench] summary received${agent ? ` from ${agent}` : ''}: ${summary}`)
  return { delivered, summary, detail, agent, command, phase, isFinal }
}

async function handleWorkbenchSummary(req, res) {
  if (!isAuthorizedBearerRequest(req, workbenchConfig.summaryToken)) {
    sendHttpJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }

  const payload = await readJsonRequest(req)
  const published = publishWorkbenchSummary(payload)
  if (!published) {
    sendHttpJson(res, 400, { ok: false, error: 'missing_summary' })
    return
  }

  sendHttpJson(res, 200, { ok: true, delivered: published.delivered })
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

async function maybePostToWorkbench(text, targetSocket, context = {}) {
  if (!text) {
    console.log('[workbench] skipped transcript: empty_transcript')
    sendSocketJson(targetSocket, {
      type: 'agent_status',
      status: 'empty_transcript',
      jobId: context.jobId,
    })
    return
  }

  if (!workbenchConfig.enabled) {
    console.log('[workbench] skipped transcript: workbench_disabled')
    sendSocketJson(targetSocket, {
      type: 'agent_status',
      status: 'workbench_disabled',
      jobId: context.jobId,
    })
    return
  }

  const baseUrl = workbenchConfig.url.replace(/\/$/, '')
  if (!baseUrl) {
    console.warn('[workbench] enabled but SPEECH_WORKBENCH_URL is empty')
    console.log('[workbench] skipped transcript: workbench_unconfigured')
    sendSocketJson(targetSocket, {
      type: 'agent_status',
      status: 'workbench_unconfigured',
      jobId: context.jobId,
    })
    return
  }

  const route = workbenchRouter.routeTranscript(text, targetSocket, {
    rawText: context.rawText,
  })
  if (route.skip) {
    console.log(`[workbench] skipped transcript: ${route.reason}`)
    sendSocketJson(targetSocket, {
      type: 'agent_status',
      status: route.reason,
      agent: route.agent || '',
      jobId: context.jobId,
    })
    return
  }

  const body = route.agent
    ? { agent: route.agent, message: route.message }
    : { message: route.message }

  const headers = { 'content-type': 'application/json' }
  if (workbenchConfig.token) headers.authorization = `Bearer ${workbenchConfig.token}`

  sendSocketJson(targetSocket, {
    type: 'agent_status',
    status: 'sending',
    agent: route.agent || workbenchConfig.agent,
    jobId: context.jobId,
  })
  console.log(`[workbench] sending transcript to ${baseUrl}/messages`)

  const controller = new AbortController()
  const timeoutMs = Number.isFinite(workbenchConfig.timeoutMs) ? workbenchConfig.timeoutMs : 15_000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()

  try {
    const res = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    })
    const bodyText = await res.text()
    let responseBody = {}
    try {
      responseBody = bodyText ? JSON.parse(bodyText) : {}
    } catch {
      responseBody = { error: bodyText }
    }

    if (!res.ok || responseBody?.ok === false) {
      const detail = responseBody?.error || bodyText || `HTTP ${res.status}`
      throw new Error(`workbench POST failed: ${detail}`)
    }

    console.log(`[workbench] posted transcript to ${baseUrl}/messages`)
    if (route.clearPendingAgentOnSent) workbenchRouter.clearPendingAgent(targetSocket, route.agent)
    const sentAgent = responseBody.agent || route.agent || workbenchConfig.agent || ''
    setWorkbenchAgentInProgress(sentAgent, true, {
      signature: route.message,
      forceActivity: true,
    })
    sendSocketJson(targetSocket, {
      type: 'agent_status',
      status: 'sent',
      agent: sentAgent,
      message: responseBody.message || route.message,
      jobId: context.jobId,
    })
  } catch (err) {
    const error = err?.name === 'AbortError'
      ? `workbench POST timed out after ${timeoutMs}ms`
      : err?.message || String(err)
    console.error(`[workbench] ${error}`)
    appendMessageHistory({
      label: 'Error',
      text: error,
      createdAt: new Date().toISOString(),
    })
    sendSocketJson(targetSocket, {
      type: 'agent_error',
      error,
      agent: route.agent || workbenchConfig.agent,
      jobId: context.jobId,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function postWorkbenchLocalSummary(agent, targetSocket, context = {}) {
  const requestedAgent = canonicalWorkbenchAgent(agent)
  if (!requestedAgent) {
    const error = `unknown workbench agent: ${stringValue(agent) || 'none'}`
    console.warn(`[workbench] ${error}`)
    sendSocketJson(targetSocket, {
      type: 'agent_error',
      error,
      agent: stringValue(agent),
      availableAgents: workbenchAgentNames(),
      jobId: context.jobId,
    })
    return
  }

  if (!workbenchConfig.enabled) {
    console.log('[workbench] skipped local summary: workbench_disabled')
    sendSocketJson(targetSocket, {
      type: 'agent_status',
      status: 'workbench_disabled',
      agent: requestedAgent,
      jobId: context.jobId,
      requestType: 'local',
    })
    return
  }

  const baseUrl = workbenchConfig.url.replace(/\/$/, '')
  if (!baseUrl) {
    console.warn('[workbench] enabled but SPEECH_WORKBENCH_URL is empty')
    sendSocketJson(targetSocket, {
      type: 'agent_status',
      status: 'workbench_unconfigured',
      agent: requestedAgent,
      jobId: context.jobId,
      requestType: 'local',
    })
    return
  }

  const headers = { 'content-type': 'application/json' }
  if (workbenchConfig.token) headers.authorization = `Bearer ${workbenchConfig.token}`

  sendSocketJson(targetSocket, {
    type: 'agent_status',
    status: 'sending',
    agent: requestedAgent,
    jobId: context.jobId,
    requestType: 'local',
  })
  console.log(`[workbench] requesting local progress summary for ${requestedAgent}`)

  const controller = new AbortController()
  const timeoutMs = Number.isFinite(workbenchConfig.timeoutMs) ? workbenchConfig.timeoutMs : 15_000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()

  try {
    const res = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        type: 'local',
        agent: requestedAgent,
        message: 'progress_summary',
      }),
    })
    const bodyText = await res.text()
    let responseBody = {}
    try {
      responseBody = bodyText ? JSON.parse(bodyText) : {}
    } catch {
      responseBody = { error: bodyText }
    }

    if (!res.ok || responseBody?.ok === false) {
      const detail = responseBody?.error || bodyText || `HTTP ${res.status}`
      throw new Error(`workbench local summary failed: ${detail}`)
    }

    sendSocketJson(targetSocket, {
      type: 'agent_status',
      status: 'sent',
      agent: responseBody.agent || requestedAgent,
      message: responseBody.message || 'progress_summary',
      jobId: context.jobId,
      requestType: 'local',
    })

    const responseDetail = detailTextFromWorkbenchPayload(responseBody)
    const responseSummary = normalizeTranscript(
      stringValue(responseBody.summary) ||
      stringValue(responseBody.text) ||
      stringValue(responseBody.response) ||
      responseDetail,
    )
    if (responseSummary) {
      publishWorkbenchSummary({
        agent: responseBody.agent || requestedAgent,
        command: responseBody.command,
        detail: responseDetail,
        is_final: responseBody.is_final === true,
        phase: responseBody.phase || 'in_progress',
        response: responseSummary,
        timestamp: responseBody.timestamp,
      })
    }
  } catch (err) {
    const error = err?.name === 'AbortError'
      ? `workbench local summary timed out after ${timeoutMs}ms`
      : err?.message || String(err)
    console.error(`[workbench] ${error}`)
    appendMessageHistory({
      label: 'Error',
      text: error,
      createdAt: new Date().toISOString(),
    })
    sendSocketJson(targetSocket, {
      type: 'agent_error',
      error,
      agent: requestedAgent,
      jobId: context.jobId,
      requestType: 'local',
    })
  } finally {
    clearTimeout(timeout)
  }
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
    const cleaned = workbenchRouter.preserveCommand(rawTranscript, stripCleanupDecorations(content))

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
    console.log(`[transcript:raw] ${rawTranscript}`)
    enqueueRawTranscript({
      rawTranscript,
      paths,
      targetSocket,
      jobId,
      user,
    })
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

function getTranscriptQueue(targetSocket) {
  if (!targetSocket || typeof targetSocket !== 'object') return null

  let queue = transcriptQueues.get(targetSocket)
  if (!queue) {
    queue = {
      items: [],
      timer: null,
      flushPromise: Promise.resolve(),
      activeSegments: 0,
      pendingAsrJobs: 0,
      lastTranscriptAt: 0,
      lastActivityAt: 0,
    }
    transcriptQueues.set(targetSocket, queue)
  }
  return queue
}

function markTranscriptQueueActivity(targetSocket) {
  const queue = targetSocket ? transcriptQueues.get(targetSocket) : null
  if (!markQueuedTranscriptActivity(queue)) return
  if (!transcriptQueueMaxHoldReached(queue)) scheduleTranscriptQueueFlush(targetSocket)
}

function markAudioSegmentStarted(targetSocket) {
  const queue = getTranscriptQueue(targetSocket)
  if (!queue) return

  queue.activeSegments += 1
  markTranscriptQueueActivity(targetSocket)
}

function markAudioSegmentFinished(targetSocket) {
  const queue = getTranscriptQueue(targetSocket)
  if (!queue) return

  queue.activeSegments = Math.max(0, queue.activeSegments - 1)
  markTranscriptQueueActivity(targetSocket)
  scheduleTranscriptQueueFlush(targetSocket)
}

function markAsrJobQueued(targetSocket) {
  const queue = getTranscriptQueue(targetSocket)
  if (!queue) return

  queue.pendingAsrJobs += 1
  markTranscriptQueueActivity(targetSocket)
}

function markAsrJobFinished(targetSocket) {
  const queue = getTranscriptQueue(targetSocket)
  if (!queue) return

  queue.pendingAsrJobs = Math.max(0, queue.pendingAsrJobs - 1)
  markTranscriptQueueActivity(targetSocket)
  scheduleTranscriptQueueFlush(targetSocket)
}

function enqueueRawTranscript(item) {
  const queue = getTranscriptQueue(item.targetSocket)
  if (!queue) {
    flushRawTranscriptBatch([item]).catch(err => {
      console.error(`[transcript-queue] failed to flush fallback batch: ${err.message}`)
    })
    return
  }

  queue.items.push(item)
  queue.lastTranscriptAt = Date.now()
  queue.lastActivityAt = queue.lastTranscriptAt
  scheduleTranscriptQueueFlush(item.targetSocket)
  const queuedText = combineQueuedTranscripts(queue.items.map(queueItem => queueItem.rawTranscript))

  sendSocketJson(item.targetSocket, {
    type: 'asr_status',
    status: 'queued',
    jobId: item.jobId,
    queuedSegments: queue.items.length,
    queuedText,
    text: queuedText,
    debounceMs: transcriptQueueIdleMs,
    activeSegments: queue.activeSegments,
    pendingAsrJobs: queue.pendingAsrJobs,
    file: basename(item.paths.wav),
  })
  console.log(
    `[transcript-queue] queued job ${item.jobId}; waiting ${(transcriptQueueIdleMs / 1000).toFixed(1)}s after last translated text/VAD speech and audio idle`,
  )
}

function scheduleTranscriptQueueFlush(targetSocket, retryMs = null) {
  const queue = getTranscriptQueue(targetSocket)
  if (!queue || !queue.items.length) return

  if (queue.timer) clearTimeout(queue.timer)
  const lastActivityAt = queuedTranscriptActivityAt(queue)
  const elapsedMs = lastActivityAt ? Date.now() - lastActivityAt : transcriptQueueIdleMs
  const waitMs = retryMs === null
    ? Math.max(0, transcriptQueueIdleMs - elapsedMs)
    : retryMs
  queue.timer = setTimeout(() => {
    queue.timer = null
    queue.flushPromise = queue.flushPromise
      .catch(() => {})
      .then(() => flushTranscriptQueue(targetSocket))
  }, waitMs)
  queue.timer.unref?.()
}

async function flushTranscriptQueue(targetSocket) {
  const queue = getTranscriptQueue(targetSocket)
  if (!queue || !queue.items.length) return

  const maxHoldReached = transcriptQueueMaxHoldReached(queue)
  const lastActivityAt = queuedTranscriptActivityAt(queue)
  const elapsedMs = Date.now() - lastActivityAt
  if (!maxHoldReached && elapsedMs < transcriptQueueIdleMs) {
    scheduleTranscriptQueueFlush(targetSocket)
    return
  }

  if ((queue.activeSegments > 0 || queue.pendingAsrJobs > 0) && !maxHoldReached) {
    console.log(
      `[transcript-queue] flush delayed; activeSegments=${queue.activeSegments} pendingAsrJobs=${queue.pendingAsrJobs}`,
    )
    scheduleTranscriptQueueFlush(targetSocket, Math.min(1_000, transcriptQueueIdleMs))
    return
  }

  if (maxHoldReached && (queue.activeSegments > 0 || queue.pendingAsrJobs > 0)) {
    console.log(
      `[transcript-queue] max hold reached; flushing despite activeSegments=${queue.activeSegments} pendingAsrJobs=${queue.pendingAsrJobs}`,
    )
  }

  const items = queue.items
  queue.items = []
  await flushRawTranscriptBatch(items)
}

function transcriptQueueMaxHoldReached(queue) {
  return transcriptQueueMaxHoldReachedSinceActivity(queue, transcriptQueueMaxHoldMs)
}

async function flushRawTranscriptBatch(items) {
  const batch = items.filter(item => normalizeTranscript(item.rawTranscript))
  if (!batch.length) return

  const lastItem = batch[batch.length - 1]
  const targetSocket = lastItem.targetSocket
  const user = lastItem.user
  const jobIds = batch.map(item => item.jobId)
  const paths = lastItem.paths
  const rawTranscript = combineQueuedTranscripts(batch.map(item => item.rawTranscript))
  const cleanupConfig = currentTranscriptCleanupConfig()

  console.log(`[transcript-queue] flushing ${batch.length} segment(s): jobs=${jobIds.join(',')}`)
  if (cleanupConfig.enabled) {
    sendSocketJson(targetSocket, {
      type: 'asr_status',
      status: 'cleaning',
      jobId: lastItem.jobId,
      jobIds,
      queuedSegments: batch.length,
      queuedText: rawTranscript,
      text: rawTranscript,
      file: basename(paths.wav),
    })
  }

  const cleanup = await cleanTranscript(rawTranscript, cleanupConfig)
  const cleanedTranscript = cleanup.text

  writeTranscriptFiles(paths, rawTranscript, cleanedTranscript, cleanup, user, {
    queuedSegments: batch.map(batchItem => queuedSegmentMetadata(batchItem)),
  })
  appendTranscript(rawTranscript, cleanedTranscript, paths, cleanup, user, {
    queuedSegments: batch.map(batchItem => queuedSegmentMetadata(batchItem)),
  })
  const createdAt = new Date().toISOString()
  appendMessageHistory({
    label: 'You',
    text: cleanedTranscript,
    createdAt,
  })
  console.log(`[transcript:clean] ${cleanedTranscript}`)
  console.log(`[asr] queued transcript saved: ${paths.txt}`)
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
    jobId: lastItem.jobId,
    jobIds,
    queuedSegments: batch.length,
    file: basename(paths.txt),
    rawFile: basename(paths.rawTxt),
    cleanFile: basename(paths.cleanTxt),
    createdAt,
  })
  await maybePostToWorkbench(cleanedTranscript, targetSocket, {
    jobId: lastItem.jobId,
    user,
    rawText: rawTranscript,
  })
  await maybePostToTerminal(cleanedTranscript)
}

function combineQueuedTranscripts(transcripts) {
  return normalizeTranscript(transcripts.join('\n'))
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function queuedSegmentMetadata(item) {
  return {
    jobId: item.jobId,
    raw: item.rawTranscript,
    files: {
      audio: item.paths.wav,
      rawTranscript: item.paths.rawTxt,
      cleanedTranscript: item.paths.cleanTxt,
      displayTranscript: item.paths.txt,
    },
  }
}

function writeTextFile(path, content) {
  writeFileSync(path, content)
}

function writeJsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeTranscriptFiles(paths, rawTranscript, cleanedTranscript, cleanup, user, extra = {}) {
  writeTextFile(paths.rawTxt, `${rawTranscript}\n`)
  writeTextFile(paths.cleanTxt, `${cleanedTranscript}\n`)
  writeTextFile(paths.txt, `${cleanedTranscript}\n`)
  writeJsonFile(paths.json, {
    createdAt: new Date().toISOString(),
    raw: rawTranscript,
    cleaned: cleanedTranscript,
    cleanup,
    user,
    ...extra,
    files: {
      audio: paths.wav,
      rawTranscript: paths.rawTxt,
      cleanedTranscript: paths.cleanTxt,
      displayTranscript: paths.txt,
    },
  })
}

function appendTranscript(rawTranscript, cleanedTranscript, paths, cleanup, user, extra = {}) {
  const line = JSON.stringify({
    createdAt: new Date().toISOString(),
    raw: rawTranscript,
    cleaned: cleanedTranscript,
    cleanup,
    user,
    ...extra,
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
  markAsrJobQueued(targetSocket)

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
    .finally(() => {
      markAsrJobFinished(targetSocket)
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

function normalizeSileroFrameSamples(value) {
  const frameSamples = Number(value)
  return [512, 1024, 1536].includes(frameSamples) ? frameSamples : 512
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

function rmsVadDecision(frame, endpoint = null) {
  const rms = pcmRms(frame)
  const threshold = endpoint?.active ? vadReleaseThreshold : vadStartThreshold

  return {
    speech: rms >= threshold,
    backend: 'rms',
    rms,
  }
}

async function sileroVadDecision(frame, endpoint = null) {
  if (vadBackend !== 'silero') {
    return rmsVadDecision(frame, endpoint)
  }

  const vad = await getSileroVad()
  if (!vad) {
    return rmsVadDecision(frame, endpoint)
  }

  try {
    return await vad.analyzeFrame(frame)
  } catch (err) {
    sileroVadUnavailable = true
    if (!sileroVadFallbackLogged) {
      sileroVadFallbackLogged = true
      console.warn(`[audio] Silero VAD failed; falling back to RMS VAD: ${err.message}`)
    }
    return rmsVadDecision(frame, endpoint)
  }
}

async function getSileroVad() {
  if (sileroVadUnavailable) return null
  if (sileroVad) return sileroVad
  if (sileroVadStartPromise) return sileroVadStartPromise

  sileroVadStartPromise = (async () => {
    const nextVad = await createSileroFrameVad({
      modelPath: sileroVadModel || undefined,
      positiveSpeechThreshold: sileroVadThreshold,
      negativeSpeechThreshold: sileroVadThreshold - 0.15,
    })
    sileroVad = nextVad
    return nextVad
  })().catch(err => {
    sileroVadUnavailable = true
    console.warn(`[audio] Silero VAD unavailable; falling back to RMS VAD: ${err.message}`)
    return null
  }).finally(() => {
    sileroVadStartPromise = null
  })

  return sileroVadStartPromise
}

async function resetSileroVadState() {
  const vad = await getSileroVad()
  if (!vad) return

  try {
    vad.reset()
  } catch (err) {
    console.warn(`[audio] failed to reset Silero VAD state: ${err.message}`)
  }
}

wss.on('connection', (socket, req) => {
  audioSockets.add(socket)
  const connectionStamp = stamp()
  const transportAuth = req.audioTransportAuth || {
    accepted: !accessToken && !accessTokenSecret,
    challenge: false,
    mode: 'disabled',
  }
  const authNonce = transportAuth.challenge ? randomBytes(18).toString('base64url') : ''
  let transportAuthenticated = Boolean(transportAuth.accepted)
  let currentSegment = null
  let segmentIndex = 0
  let bytes = 0
  let chunks = 0
  let userAuthenticated = false
  let evenUser = null
  let authTimer = null
  let onboardingPromptSent = false
  let firstAudioChunkLogged = false
  let lastAudioAt = 0
  let idleLogged = false
  let idleIndicatorEnabled = false
  let idleIndicatorClearSent = true
  let idleIndicatorFrame = 0
  const preRollBytes = Math.floor((vadPreRollMs / 1000) * bytesPerSecond)
  let audioQueue = Promise.resolve()
  const endpoint = useVad
    ? new VadEndpoint({
      bytesPerSecond,
      frameBytes: vadFrameBytes,
      preRollBytes,
      maxBytes: segmentBytesLimit,
      minSpeechMs: vadMinSpeechMs,
      silenceMs: vadSilenceMs,
      minUtteranceMs: vadMinUtteranceMs,
      analyzeFrame: frame => sileroVadDecision(frame, endpoint),
      onSegmentStart: openVadSegment,
      onSegmentData: writeVadSegmentChunk,
      onSpeechDetected: markVadDetected,
      onActivity: () => markTranscriptQueueActivity(socket),
      onSegmentEnd: finishVadSegment,
    })
    : null

  console.log(`[audio] connected: stamp=${connectionStamp} remote=${req.socket.remoteAddress || 'unknown'}`)
  const idleTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return

    const audioFresh = lastAudioAt && Date.now() - lastAudioAt <= receiverIdleAudioFreshMs
    if (idleIndicatorEnabled && audioFresh) {
      sendSocketJson(socket, {
        type: 'receiver_idle',
        frame: idleIndicatorFrame % 2 === 0 ? ' - ' : '- -',
      })
      idleIndicatorFrame += 1
      idleIndicatorClearSent = false
    } else if (idleIndicatorEnabled && !idleIndicatorClearSent) {
      sendSocketJson(socket, {
        type: 'receiver_idle',
        frame: '',
      })
      idleIndicatorClearSent = true
    }

    if (!lastAudioAt || idleLogged) return

    const idleMs = Date.now() - lastAudioAt
    if (idleMs < 5_000) return

    idleLogged = true
    console.log(
      `[audio] idle: no chunks for ${(idleMs / 1000).toFixed(1)}s, stamp=${connectionStamp}, bytes=${bytes}, chunks=${chunks}, readyState=${socket.readyState}`,
    )
  }, 1_000)
  idleTimer.unref?.()

  if (transportAuth.challenge) {
    sendSocketJson(socket, {
      type: 'auth_challenge',
      mode: 'shared-secret',
      nonce: authNonce,
      algorithm: 'hmac-sha256',
    })
    authTimer = setTimeout(() => {
      if (transportAuthenticated || socket.readyState !== WebSocket.OPEN) return
      console.warn('[auth] shared-secret auth timed out')
      sendSocketJson(socket, {
        type: 'auth_status',
        status: 'rejected',
        reason: 'timeout',
      })
      socket.close(1008, 'shared-secret auth timed out')
    }, transportAuthTimeoutMs)
  } else if (transportAuthenticated) {
    sendSocketJson(socket, {
      type: 'auth_status',
      status: 'accepted',
      mode: transportAuth.mode,
      transport: true,
    })
  }

  sendSocketJson(socket, {
    type: 'receiver_status',
    status: transportAuthenticated ? 'connected' : 'auth_required',
    asrConfigured: Boolean(asrWorkerUrl || asrCommand),
    chunkMode: useVad ? 'vad' : 'fixed',
    vadBackend: useVad ? vadBackend : 'off',
    workbench: workbenchStatus(),
  })

  if (useVad) {
    if (vadBackend === 'silero') {
      audioQueue = audioQueue.then(() => resetSileroVadState())
    }
  } else if (segmentBytesLimit) {
    console.log(`[audio] fixed recordings every ${segmentSeconds}s (${segmentBytesLimit} bytes)`)
  } else {
    console.log('[audio] recording one file until the socket closes')
  }

  function sendOnboardingPrompt() {
    if (onboardingPromptSent || !transportAuthenticated || !userAuthenticated) return
    onboardingPromptSent = true
    sendSocketJson(socket, {
      type: 'onboarding_prompt',
      message: 'Say something to get started.',
    })
  }

  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString()
      const control = parseControlMessage(text)

      if (control?.type === 'auth') {
        if (isValidAuthProof(accessTokenSecret, authNonce, control.proof)) {
          transportAuthenticated = true
          if (authTimer) clearTimeout(authTimer)
          authTimer = null
          sendSocketJson(socket, {
            type: 'auth_status',
            status: 'accepted',
            mode: 'shared-secret',
            transport: true,
          })
        } else {
          console.warn('[auth] rejected shared-secret proof')
          sendSocketJson(socket, {
            type: 'auth_status',
            status: 'rejected',
            reason: 'bad_proof',
          })
          socket.close(1008, 'shared-secret auth failed')
        }
        return
      }

      if (!transportAuthenticated) {
        console.warn('[auth] rejected control before transport auth')
        socket.close(1008, 'transport auth required')
        return
      }

      if (control?.type === 'start') {
        evenUser = normalizeUser(control.user)
        const auth = currentUserAuthConfig()

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
        persistScannedUser(evenUser, 'accepted')
        sendSocketJson(socket, {
          type: 'auth_status',
          status: 'accepted',
          user: evenUser,
          restricted: auth.required,
        })
        sendOnboardingPrompt()
      }
      if (control?.type === 'get_message_history') {
        sendMessageHistory(socket)
      }
      if (control?.type === 'peek_progress') {
        const auth = currentUserAuthConfig()
        if (auth.required && !userAuthenticated) {
          sendSocketJson(socket, {
            type: 'agent_error',
            error: 'Even user is required',
            agent: stringValue(control.agent),
            requestType: 'local',
          })
          return
        }
        postWorkbenchLocalSummary(control.agent, socket, {
          user: evenUser,
        }).catch(err => {
          console.error(`[workbench] local summary request failed: ${err.message}`)
        })
      }
      return
    }

    if (!transportAuthenticated) {
      console.warn('[auth] rejected audio before transport auth')
      socket.close(1008, 'transport auth required')
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
    lastAudioAt = Date.now()
    idleLogged = false
    idleIndicatorEnabled = true
    if (!firstAudioChunkLogged) {
      firstAudioChunkLogged = true
      console.log(`[audio] stream started: receiving G2 mic chunks, stamp=${connectionStamp}`)
    }

    if (useVad) {
      audioQueue = audioQueue
        .catch(() => {})
        .then(() => endpoint.processChunk(chunk))
        .catch(err => {
          console.error(`[audio] VAD processing failed: ${err.message}`)
          closeCurrentSegment('vad error')
        })
    } else {
      const segment = getCurrentSegment()
      writeSegmentChunk(segment, chunk)

      if (segmentBytesLimit && segment.bytes >= segmentBytesLimit) {
        closeCurrentSegment('segment limit')
      }
    }
  })

  socket.on('close', (code, reason) => {
    if (authTimer) clearTimeout(authTimer)
    clearInterval(idleTimer)
    audioSockets.delete(socket)
    audioQueue = audioQueue
      .catch(() => {})
      .then(() => {
        if (endpoint) {
          endpoint.flush('socket close')
        } else {
          closeCurrentSegment('socket close')
        }
        const reasonText = reason?.toString() || ''
        console.log(
          `[audio] closed: code=${code} reason=${reasonText || 'none'} stamp=${connectionStamp}, ${bytes} bytes total, ${chunks} chunks`,
        )
      })
  })

  socket.on('error', err => {
    console.error(`[audio] socket error: ${err.message}`)
  })

  function getCurrentSegment(options = {}) {
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
      vadDetectedSent: false,
    }
    markAudioSegmentStarted(socket)
    if (useVad) {
      markVadDetected(currentSegment, options.rms)
    }
    console.log(`[audio] writing raw PCM to ${paths.pcm}`)
    return currentSegment
  }

  function openVadSegment(segment) {
    segmentIndex += 1
    const paths = recordingPaths(connectionStamp, segmentIndex)
    segment.paths = paths
    segment.stream = createWriteStream(paths.pcm)
    currentSegment = segment
    markAudioSegmentStarted(socket)
    console.log(`[audio] writing raw PCM to ${paths.pcm}`)
  }

  function writeVadSegmentChunk(segment, chunk) {
    segment.stream.write(chunk)
  }

  function finishVadSegment(segment, reason) {
    if (currentSegment === segment) {
      currentSegment = null
    }

    segment.stream.end(() => {
      console.log(
        `[audio] segment closed (${reason}): ${segment.bytes} bytes, duration=${(segment.durationMs / 1000).toFixed(2)}s, speech=${segment.speechMs.toFixed(0)}ms silence=${segment.silenceMs.toFixed(0)}ms, file=${segment.paths.pcm}`,
      )
      enqueueRecording(segment.paths, segment.bytes, reason, socket, evenUser)
      markAudioSegmentFinished(socket)
    })
  }

  function markVadDetected(segment, decision = {}) {
    if (!segment || segment.vadDetectedSent) return

    segment.vadDetectedSent = true
    const rmsText = Number.isFinite(decision.rms) ? ` rms=${decision.rms.toFixed(4)}` : ''
    const backendText = decision.backend ? ` backend=${decision.backend}` : ''
    console.log(`[audio] VAD detected speech${backendText}${rmsText}`)
    sendSocketJson(socket, {
      type: 'asr_status',
      status: 'vad_detected',
      backend: decision.backend || vadBackend,
    })
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
        `[audio] segment closed (${reason}): ${segment.bytes} bytes, duration=${(segment.durationMs / 1000).toFixed(2)}s, speech=${segment.speechMs.toFixed(0)}ms silence=${segment.silenceMs.toFixed(0)}ms, file=${segment.paths.pcm}`,
      )
      enqueueRecording(segment.paths, segment.bytes, reason, socket, evenUser)
      markAudioSegmentFinished(socket)
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
  console.log(`[server] Message history directory: ${messageHistoryDirPath}`)
  console.log(`[server] Audio auth: ${audioAuthDescription()}`)
  console.log(
    `[server] Workbench forwarding: ${workbenchConfig.enabled ? `${workbenchConfig.url.replace(/\/$/, '')}/messages` : 'disabled'}`,
  )
  console.log(`[server] Workbench route: ${workbenchRouter.routeDescription()}`)
  console.log(`[server] Workbench summary webhook: http://0.0.0.0:${port}${workbenchConfig.summaryPath}`)
  console.log(`[server] Workbench summary auth: ${workbenchConfig.summaryToken ? 'enabled' : 'disabled'}`)
  console.log(`[server] Even user allowlist: ${startupUserAuthConfig.required ? 'enabled' : 'disabled'}`)
  console.log(`[server] Chunk mode: ${useVad ? 'vad' : 'fixed'}`)
  console.log(`[server] VAD backend: ${useVad ? vadBackend : 'off'}`)
  if (useVad) {
    console.log(`[server] VAD frame: ${vadFrameSamples} samples (${vadFrameBytes} bytes), silence=${vadSilenceMs}ms, minSpeech=${vadMinSpeechMs}ms`)
  }
  console.log(`[server] ASR max segment seconds: ${segmentSeconds > 0 ? segmentSeconds : 'off'}`)
  console.log(`[server] Transcript queue idle: ${(transcriptQueueIdleMs / 1000).toFixed(1)}s`)
  console.log(`[server] Transcript queue max hold: ${transcriptQueueMaxHoldMs > 0 ? `${(transcriptQueueMaxHoldMs / 1000).toFixed(1)}s` : 'disabled'}`)
  console.log(`[server] ASR worker: ${asrWorkerUrl || 'not configured'}`)
  console.log(`[server] ASR command fallback: ${asrCommand ? 'configured' : 'not configured'}`)
  console.log(
    `[server] Transcript cleanup: ${startupCleanupConfig.enabled ? `${startupCleanupConfig.model} at ${startupCleanupConfig.url}` : 'disabled'}`,
  )
  if (runtimeConfigPath) {
    console.log(`[server] Cleanup prompt hot reload: ${runtimeConfigPath}`)
  }
})

function audioAuthDescription() {
  if (accessTokenSecret && accessToken) return 'shared-secret challenge + legacy URL token'
  if (accessTokenSecret) return 'shared-secret challenge'
  if (accessToken) return 'legacy URL token'
  return 'disabled'
}
