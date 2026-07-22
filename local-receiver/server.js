import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, createWriteStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { VadEndpoint } from './vad-endpoint.js'
import { createSileroFrameVad } from './silero-vad.ts'
import { createDiarizationSidecar } from './diarization-sidecar.js'
import {
  customAgentCleanupPrompt,
  customAgentDetail,
  findCustomAgentInvocation,
  normalizeCustomAgents,
  speakerBreakoutVerified,
  verifyCustomAgentInvocation,
} from './custom-agent.js'
import {
  combineQueuedTranscripts,
  markQueuedTranscriptActivity,
  queuedTranscriptActivityAt,
  transcriptQueueMaxHoldReached as transcriptQueueMaxHoldReachedSinceActivity,
} from './transcript-queue.js'
import { createWorkbenchRouter } from './workbench-router.js'
import {
  boundedThinClientDetail,
  THIN_CLIENT_DETAIL_TOTAL_CHARS,
  THIN_CLIENT_HISTORY_LIMIT,
  thinClientTextPreview,
} from './thin-client-text.js'
import {
  cleanupPromptForTranscript,
  defaultCleanupPrompt,
  defaultCodingAgentPrompt,
} from './transcript-cleanup-prompt.js'

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
const defaultWorkbenchAgents = ['Flux', 'Brock', 'Pike', 'Wolf']
const workbenchConfig = {
  enabled: !isDisabled(process.env.SPEECH_WORKBENCH_ENABLED || '0'),
  url: process.env.SPEECH_WORKBENCH_URL || 'http://127.0.0.1:8787',
  token: process.env.SPEECH_WORKBENCH_TOKEN || '',
  agent: displayWorkbenchAgentName(process.env.SPEECH_WORKBENCH_AGENT || ''),
  agents: uniqueAgentNames(stringList(process.env.SPEECH_WORKBENCH_AGENTS || '')),
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
const speakerDiarizationConfig = {
  enabled: !isDisabled(process.env.SPEAKER_DIARIZATION_ENABLED ?? '1'),
  rootDir: process.env.SPEAKER_DIARIZATION_DIR || 'data/diarization',
  speakerTranscriptDir: process.env.SPEAKER_DIARIZATION_TRANSCRIPT_DIR || transcriptDirPath,
  segmentationModel: process.env.SPEAKER_DIARIZATION_SEGMENTATION_MODEL || '',
  embeddingModel: process.env.SPEAKER_DIARIZATION_EMBEDDING_MODEL || '',
  numClusters: Number(process.env.SPEAKER_DIARIZATION_NUM_CLUSTERS || -1),
  clusterThreshold: Number(process.env.SPEAKER_DIARIZATION_CLUSTER_THRESHOLD || 0.5),
  minDurationOn: Number(process.env.SPEAKER_DIARIZATION_MIN_DURATION_ON || 0.2),
  minDurationOff: Number(process.env.SPEAKER_DIARIZATION_MIN_DURATION_OFF || 0.5),
  maxOpenSegments: Number(process.env.SPEAKER_DIARIZATION_MAX_OPEN_SEGMENTS || 4),
  maxPendingSegments: Number(process.env.SPEAKER_DIARIZATION_MAX_PENDING_SEGMENTS || 32),
  maxSegmentBytes: Number(process.env.SPEAKER_DIARIZATION_MAX_SEGMENT_BYTES || bytesPerSecond * 30),
  sampleRate: 16_000,
  bytesPerSecond,
  workerProcess: !isDisabled(process.env.SPEAKER_DIARIZATION_WORKER_PROCESS ?? '1'),
  workerTimeoutMs: Number(process.env.SPEAKER_DIARIZATION_WORKER_TIMEOUT_MS || 120_000),
  asrModel: process.env.PARAKEET_ONNX_MODEL || 'nemo-parakeet-tdt-0.6b-v3',
  asrWorkerUrl: process.env.SPEAKER_DIARIZATION_ASR_WORKER_URL || asrWorkerUrl,
  asrTimeoutMs: Number(process.env.SPEAKER_DIARIZATION_ASR_TIMEOUT_MS || 60_000),
  enrollmentEnabled: !isDisabled(process.env.SPEAKER_DIARIZATION_ENROLLMENT_ENABLED ?? '1'),
  enrollmentMinDurationSec: Number(process.env.SPEAKER_DIARIZATION_ENROLLMENT_MIN_DURATION_SEC || 1.5),
  profileMaxSamples: Number(process.env.SPEAKER_DIARIZATION_PROFILE_MAX_SAMPLES || 1),
  speakerMatchThreshold: Number(process.env.SPEAKER_DIARIZATION_MATCH_THRESHOLD || 0.6),
}
const diarizationSidecar = createDiarizationSidecar(speakerDiarizationConfig)
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
const receiverStalledAudioCloseMs = Number(process.env.RECEIVER_STALLED_AUDIO_CLOSE_MS || 12_000)
const receiverPreStartAudioBufferMs = Number(process.env.RECEIVER_PRE_START_AUDIO_BUFFER_MS || 1_000)
const activeAudioSocketProtectMs = Number(process.env.RECEIVER_ACTIVE_AUDIO_SOCKET_PROTECT_MS || 10_000)
const activeAudioSocketStartGraceMs = Number(process.env.RECEIVER_ACTIVE_AUDIO_SOCKET_START_GRACE_MS || 1_000)
const activeAudioSocketMinProtectChunks = Number(process.env.RECEIVER_ACTIVE_AUDIO_SOCKET_MIN_PROTECT_CHUNKS || 5)
const activeAudioSocketMinProtectBytes = Number(process.env.RECEIVER_ACTIVE_AUDIO_SOCKET_MIN_PROTECT_BYTES || 16_000)
const transcriptsLog = process.env.TRANSCRIPTS_LOG || join(transcriptDirPath, 'transcripts.log')
const messageHistoryDirPath = resolve(process.env.MESSAGE_HISTORY_DIR || join(transcriptDirPath, 'message-history'))
const configuredMessageHistoryLimit = Number(process.env.MESSAGE_HISTORY_LIMIT || THIN_CLIENT_HISTORY_LIMIT)
const messageHistoryLimit = Math.min(
  THIN_CLIENT_HISTORY_LIMIT,
  Number.isFinite(configuredMessageHistoryLimit) && configuredMessageHistoryLimit > 0
    ? Math.floor(configuredMessageHistoryLimit)
    : THIN_CLIENT_HISTORY_LIMIT,
)
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
  codingAgentPrompt: process.env.TRANSCRIPT_CLEANUP_CODING_AGENT_PROMPT || defaultCodingAgentPrompt(),
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
const activeAudioSocketsByUser = new Map()
const audioSocketActivity = new WeakMap()
const transcriptQueuesBySocket = new WeakMap()
const transcriptQueuesByUser = new Map()
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
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn(
      `[socket] skipped send ${payload?.type || 'message'}: ${socketDebugLabel(socket)}`,
    )
    return false
  }

  try {
    socket.send(JSON.stringify(payload))
    return true
  } catch (err) {
    console.error(`[socket] failed to send ${payload?.type || 'message'}: ${err.message}; ${socketDebugLabel(socket)}`)
    return false
  }
}

function socketDebugLabel(socket) {
  if (!socket) return 'socket=none readyState=none'
  const activity = audioSocketActivity.get(socket)
  return [
    `socket=${activity?.connectionStamp || 'unknown'}`,
    `attempt=${activity?.connectionAttempt || 'none'}`,
    `readyState=${socketReadyStateName(socket.readyState)}`,
  ].join(' ')
}

function socketReadyStateName(value) {
  if (value === WebSocket.CONNECTING) return 'CONNECTING'
  if (value === WebSocket.OPEN) return 'OPEN'
  if (value === WebSocket.CLOSING) return 'CLOSING'
  if (value === WebSocket.CLOSED) return 'CLOSED'
  return String(value)
}

function logThinClientSend(socket, payload, context = {}) {
  const sent = sendSocketJson(socket, payload)
  const details = Object.entries(compactObject(context))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  console.log(
    `[thin-client] send type=${payload?.type || 'message'} sent=${sent} ${socketDebugLabel(socket)}${details ? ` ${details}` : ''}`,
  )
  return sent
}

function logThinClientSendForUser(preferredSocket, user, payload, context = {}) {
  const socket = resolveThinClientSocket(preferredSocket, user)
  const rerouted = socket && socket !== preferredSocket
  return logThinClientSend(socket, payload, {
    ...context,
    rerouted,
    user: userLabel(user),
  })
}

function resolveThinClientSocket(preferredSocket, user) {
  if (preferredSocket?.readyState === WebSocket.OPEN) return preferredSocket

  const key = activeAudioSocketKey(user)
  const activeSocket = key ? activeAudioSocketsByUser.get(key) : null
  if (activeSocket?.readyState === WebSocket.OPEN) {
    console.log(
      `[thin-client] rerouting send from ${socketDebugLabel(preferredSocket)} to ${socketDebugLabel(activeSocket)} user=${userLabel(user)}`,
    )
    return activeSocket
  }

  return preferredSocket
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

  const normalizedTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now()
  const label = stringValue(value.label || value.agent || value.source || 'Message') || 'Message'
  const entry = {
    id: stringValue(value.id) || createHash('sha256')
      .update(JSON.stringify([normalizedTimestamp, label, text, detail]))
      .digest('base64url')
      .slice(0, 16),
    label,
    text,
    receivedAt: normalizedTimestamp,
    createdAt: new Date(normalizedTimestamp).toISOString(),
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
  if (!normalized) return null

  const path = messageHistoryPathForTimestamp(normalized.receivedAt)
  try {
    appendFileSync(path, `${JSON.stringify(normalized)}\n`)
  } catch (err) {
    console.warn(`[history] failed to append ${path}: ${err.message}`)
  }
  return normalized
}

function sendMessageHistory(socket) {
  const date = historyDateStamp()
  const entries = readMessageHistory(messageHistoryLimit, date)
    .map(entry => {
      const text = thinClientTextPreview(entry.text)
      return {
        id: entry.id,
        label: entry.label,
        text,
        receivedAt: entry.receivedAt,
        createdAt: entry.createdAt,
        hasDetail: Boolean(entry.detail || text !== entry.text),
      }
    })
  sendSocketJson(socket, {
    type: 'message_history',
    date,
    entries,
  })
}

function sendMessageHistoryDetails(socket, requestedIds) {
  const ids = Array.from(new Set(
    (Array.isArray(requestedIds) ? requestedIds : [])
      .map(stringValue)
      .filter(Boolean),
  )).slice(0, THIN_CLIENT_HISTORY_LIMIT)
  if (!ids.length) return

  const requested = new Set(ids)
  const entries = readMessageHistory(messageHistoryLimit)
    .filter(entry => requested.has(entry.id))
  const perEntryLimit = Math.min(
    8_000,
    Math.max(240, Math.floor(THIN_CLIENT_DETAIL_TOTAL_CHARS / Math.max(1, entries.length))),
  )

  sendSocketJson(socket, {
    type: 'message_history_detail',
    entries: entries.map(entry => ({
      id: entry.id,
      label: entry.label,
      text: thinClientTextPreview(entry.text),
      detail: boundedThinClientDetail(entry.detail || entry.text, perEntryLimit),
      receivedAt: entry.receivedAt,
      createdAt: entry.createdAt,
      hasDetail: false,
    })),
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

function displayWorkbenchAgentName(value) {
  const normalized = normalizeAgentName(value)
  if (!normalized) return ''

  const known = defaultWorkbenchAgents.find(agent => normalizeAgentName(agent) === normalized)
  if (known) return known

  return normalized
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function uniqueAgentNames(values) {
  const names = []
  const seen = new Set()
  for (const value of values) {
    const label = displayWorkbenchAgentName(value)
    const key = normalizeAgentName(label)
    if (!key || seen.has(key)) continue
    seen.add(key)
    names.push(label)
  }
  return names
}

function workbenchAgentNames() {
  return workbenchConfig.agents.length
    ? workbenchConfig.agents
    : defaultWorkbenchAgents
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
  const label = canonicalWorkbenchAgent(agent) || displayWorkbenchAgentName(agent)
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

  const rawAgent = stringValue(payload.agent)
  const agent = canonicalWorkbenchAgent(rawAgent) || displayWorkbenchAgentName(rawAgent)
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
  const historyEntry = appendMessageHistory({
    label: agent || 'Agent',
    text: summary,
    detail,
    createdAt,
  })
  const delivered = broadcastSocketJson({
    type: 'agent_summary',
    text: thinClientTextPreview(summary),
    historyId: historyEntry?.id,
    hasDetail: Boolean(detail || thinClientTextPreview(summary) !== summary),
    agent,
    command: thinClientTextPreview(command),
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
  const thinClientSocket = resolveThinClientSocket(targetSocket, context.user)

  if (!text) {
    console.log('[workbench] skipped transcript: empty_transcript')
    logThinClientSendForUser(thinClientSocket, context.user, {
      type: 'agent_status',
      status: 'empty_transcript',
      jobId: context.jobId,
    })
    return
  }

  if (!workbenchConfig.enabled) {
    console.log('[workbench] skipped transcript: workbench_disabled')
    logThinClientSendForUser(thinClientSocket, context.user, {
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
    logThinClientSendForUser(thinClientSocket, context.user, {
      type: 'agent_status',
      status: 'workbench_unconfigured',
      jobId: context.jobId,
    })
    return
  }

  const route = workbenchRouter.routeTranscript(text, thinClientSocket, {
    rawText: context.rawText,
  })
  if (route.skip) {
    console.log(`[workbench] skipped transcript: ${route.reason}`)
    logThinClientSendForUser(thinClientSocket, context.user, {
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

  logThinClientSendForUser(thinClientSocket, context.user, {
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
    if (route.clearPendingAgentOnSent) workbenchRouter.clearPendingAgent(thinClientSocket, route.agent)
    const rawSentAgent = responseBody.agent || route.agent || workbenchConfig.agent || ''
    const sentAgent = canonicalWorkbenchAgent(rawSentAgent) || displayWorkbenchAgentName(rawSentAgent)
    setWorkbenchAgentInProgress(sentAgent, true, {
      signature: route.message,
      forceActivity: true,
    })
    logThinClientSendForUser(thinClientSocket, context.user, {
      type: 'agent_status',
      status: 'sent',
      agent: sentAgent,
      message: thinClientTextPreview(responseBody.message || route.message),
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
    logThinClientSendForUser(thinClientSocket, context.user, {
      type: 'agent_error',
      error: thinClientTextPreview(error),
      agent: canonicalWorkbenchAgent(route.agent || workbenchConfig.agent) ||
        displayWorkbenchAgentName(route.agent || workbenchConfig.agent),
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
      error: thinClientTextPreview(error),
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

    const rawResponseAgent = responseBody.agent || requestedAgent
    const responseAgent = canonicalWorkbenchAgent(rawResponseAgent) || requestedAgent
    sendSocketJson(targetSocket, {
      type: 'agent_status',
      status: 'sent',
      agent: responseAgent,
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
        agent: responseAgent,
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
      error: thinClientTextPreview(error),
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
  const runtimePrompts = readRuntimeCleanupPrompts()
  const basePrompt = runtimePrompts.prompt || transcriptCleanupEnv.prompt || defaultCleanupPrompt()

  return {
    ...transcriptCleanupEnv,
    temperature: Number.isFinite(transcriptCleanupEnv.temperature) ? transcriptCleanupEnv.temperature : 0,
    timeoutMs: Number.isFinite(transcriptCleanupEnv.timeoutMs) ? transcriptCleanupEnv.timeoutMs : 15_000,
    prompt: customAgentCleanupPrompt(basePrompt, currentCustomAgents()),
    codingAgentPrompt: runtimePrompts.codingAgentPrompt ||
      transcriptCleanupEnv.codingAgentPrompt ||
      defaultCodingAgentPrompt(),
  }
}

function currentCustomAgents() {
  return normalizeCustomAgents(
    readRuntimeConfig()?.customAgents,
    workbenchAgentNames(),
  )
}

function readRuntimeCleanupPrompts() {
  const config = readRuntimeConfig()
  const cleanup = config?.transcriptCleanup
  return {
    prompt: typeof cleanup?.prompt === 'string' ? cleanup.prompt : '',
    codingAgentPrompt: typeof cleanup?.codingAgentPrompt === 'string'
      ? cleanup.codingAgentPrompt
      : '',
  }
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

function activeAudioSocketKey(user) {
  const uid = stringValue(user?.uid)
  return uid ? `uid:${uid}` : ''
}

function shouldKeepActiveAudioSocket(socket, now = Date.now()) {
  if (activeAudioSocketProtectMs <= 0) return false

  const activity = audioSocketActivity.get(socket)
  if (!activity) return false

  if (
    activity.lastAudioAt &&
    now - activity.lastAudioAt <= activeAudioSocketProtectMs &&
    hasProtectedAudioActivity(activity)
  ) {
    return true
  }

  return Boolean(
    activeAudioSocketStartGraceMs > 0 &&
    activity.startedAt &&
    now - activity.startedAt <= activeAudioSocketStartGraceMs &&
    hasProtectedAudioActivity(activity),
  )
}

function hasProtectedAudioActivity(activity) {
  const minChunks = Math.max(0, activeAudioSocketMinProtectChunks)
  const minBytes = Math.max(0, activeAudioSocketMinProtectBytes)
  if (minChunks <= 0 && minBytes <= 0) return true

  return Boolean(
    (minChunks > 0 && Number(activity.chunks || 0) >= minChunks) ||
    (minBytes > 0 && Number(activity.bytes || 0) >= minBytes),
  )
}

function promoteActiveAudioSocket(socket, key, context = {}) {
  if (!key) return { accepted: true, key: '', standby: false }

  const previous = activeAudioSocketsByUser.get(key)
  if (previous === socket) return { accepted: true, key, standby: false }

  if (previous && previous.readyState === WebSocket.OPEN && shouldKeepActiveAudioSocket(previous)) {
    console.log(
      `[audio] keeping active socket for ${key}${context.connectionStamp ? `; standby duplicate stamp=${context.connectionStamp}` : ''}; ${audioActivitySummary(previous)}`,
    )
    sendSocketJson(socket, {
      type: 'receiver_status',
      status: 'standby',
      reason: 'active_socket_has_audio',
    })
    return { accepted: true, key, standby: true }
  }

  activeAudioSocketsByUser.set(key, socket)

  if (previous && previous.readyState === WebSocket.OPEN) {
    console.log(
      `[audio] switching active socket for ${key}${context.connectionStamp ? ` to stamp=${context.connectionStamp}` : ''}; keeping previous open; ${audioActivitySummary(previous)}`,
    )
    sendSocketJson(previous, {
      type: 'receiver_status',
      status: 'standby',
      reason: 'newer_socket_active',
    })
  }

  return { accepted: true, key, standby: false }
}

function audioActivitySummary(socket) {
  const activity = audioSocketActivity.get(socket)
  if (!activity) return 'previousAudio=unknown'

  const startedAge = activity.startedAt ? `${Date.now() - activity.startedAt}ms` : 'none'
  const lastAudioAge = activity.lastAudioAt ? `${Date.now() - activity.lastAudioAt}ms` : 'none'
  return [
    `previousStamp=${activity.connectionStamp || 'unknown'}`,
    `previousBytes=${Number(activity.bytes || 0)}`,
    `previousChunks=${Number(activity.chunks || 0)}`,
    `previousStartedAge=${startedAge}`,
    `previousLastAudioAge=${lastAudioAge}`,
  ].join(' ')
}

function promoteAudioSocketForChunk(socket, user) {
  const key = activeAudioSocketKey(user)
  if (!key) return true

  const previous = activeAudioSocketsByUser.get(key)
  if (previous === socket) return true

  const previousActivity = previous ? audioSocketActivity.get(previous) : null
  const previousActivityAt = previousActivity?.lastAudioAt || previousActivity?.startedAt || 0
  const previousProtectMs = previousActivity?.lastAudioAt
    ? activeAudioSocketProtectMs
    : activeAudioSocketStartGraceMs
  if (
    previous &&
    previous.readyState === WebSocket.OPEN &&
    previousActivityAt &&
    Date.now() - previousActivityAt <= previousProtectMs
  ) {
    return false
  }

  activeAudioSocketsByUser.set(key, socket)
  if (previous && previous.readyState === WebSocket.OPEN) {
    console.log(
      `[audio] switching active socket for ${key} on audio chunk; keeping previous open; ${audioActivitySummary(previous)}`,
    )
    sendSocketJson(previous, {
      type: 'receiver_status',
      status: 'standby',
      reason: 'audio_received_on_another_socket',
    })
  } else {
    console.log(`[audio] active socket for ${key} selected on audio chunk; ${socketDebugLabel(socket)}`)
  }
  sendSocketJson(socket, {
    type: 'receiver_status',
    status: 'active',
    reason: 'audio_socket_takeover',
  })
  return true
}

function clearActiveAudioSocket(socket, key) {
  if (!key) return
  if (activeAudioSocketsByUser.get(key) === socket) {
    activeAudioSocketsByUser.delete(key)
  }
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

    const maxTokens = Number(cleanupConfig.maxTokens)
    const res = await fetch(cleanupConfig.url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: cleanupConfig.model,
        temperature: cleanupConfig.temperature,
        ...(Number.isFinite(maxTokens) && maxTokens > 0
          ? { max_tokens: Math.floor(maxTokens) }
          : {}),
        messages: [
          {
            role: 'system',
            content: cleanupPromptForTranscript(
              cleanupConfig.prompt,
              cleanupConfig.codingAgentPrompt,
              rawTranscript,
              workbenchRouter,
            ),
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
    const finishReason = stringValue(body?.choices?.[0]?.finish_reason)
    const cleaned = workbenchRouter.preserveCommand(rawTranscript, stripCleanupDecorations(content))

    if (!cleaned) {
      throw new Error('cleanup model returned empty text')
    }

    return {
      enabled: true,
      ok: true,
      model: cleanupConfig.model,
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : undefined,
      text: cleaned,
      finishReason,
      usage: body?.usage,
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
      maxTokens: Number.isFinite(Number(cleanupConfig.maxTokens))
        ? Number(cleanupConfig.maxTokens)
        : undefined,
      text: rawTranscript,
      error,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function processRecording(paths, bytes, targetSocket, jobId, user) {
  if (bytes < minAsrBytes) {
    console.log(
      `[asr] request skipped job=${jobId} reason=short_audio bytes=${bytes} minBytes=${minAsrBytes} pcm=${paths.pcm} ${socketDebugLabel(targetSocket)} user=${userLabel(user)}`,
    )
    return
  }

  console.log(
    `[asr] request received job=${jobId} bytes=${bytes} pcm=${paths.pcm} wav=${paths.wav} ${socketDebugLabel(targetSocket)} user=${userLabel(user)}`,
  )
  console.log(`[asr] converting PCM to WAV: ${paths.wav}`)
  await convertPcmToWav(paths.pcm, paths.wav)

  if (!asrWorkerUrl && !asrCommand) {
    console.log(`[asr] request skipped job=${jobId} reason=asr_unconfigured wav=${paths.wav}`)
    return
  }

  let rawTranscript = ''
  if (asrWorkerUrl) {
    console.log(`[asr] sending WAV to worker: ${asrWorkerUrl}`)
    logThinClientSendForUser(targetSocket, user, {
      type: 'asr_status',
      status: 'transcribing',
      jobId,
      file: basename(paths.wav),
    }, {
      job: jobId,
      status: 'transcribing',
      file: basename(paths.wav),
    })
    rawTranscript = await transcribeWithWorker(paths.wav)
  } else {
    const command = renderAsrCommand(asrCommand, paths)
    console.log(`[asr] running ASR command: ${command}`)
    logThinClientSendForUser(targetSocket, user, {
      type: 'asr_status',
      status: 'transcribing',
      jobId,
      file: basename(paths.wav),
    }, {
      job: jobId,
      status: 'transcribing',
      file: basename(paths.wav),
    })
    const result = await runShell(command, 'asr')
    rawTranscript = normalizeTranscript(result.stdout)
  }

  console.log(
    `[asr] transcript result job=${jobId} empty=${rawTranscript ? 'false' : 'true'} chars=${rawTranscript.length} wav=${paths.wav} ${socketDebugLabel(targetSocket)}`,
  )
  if (rawTranscript) {
    console.log(`[transcript:raw] ${rawTranscript}`)
    const diarizationPromise = startSavedAudioDiarization(paths, rawTranscript, jobId, user)
    enqueueRawTranscript({
      rawTranscript,
      paths,
      targetSocket,
      jobId,
      user,
      diarizationPromise,
    })
  } else {
    console.log(`[asr] no transcript returned job=${jobId} wav=${paths.wav} ${socketDebugLabel(targetSocket)}`)
    logThinClientSendForUser(targetSocket, user, {
      type: 'asr_status',
      status: 'no_transcript',
      jobId,
      file: basename(paths.wav),
    }, {
      job: jobId,
      status: 'no_transcript',
      file: basename(paths.wav),
    })
  }
}

function startSavedAudioDiarization(paths, rawTranscript, jobId, user) {
  if (!speakerDiarizationConfig.enabled) {
    return Promise.resolve({
      verificationFailed: true,
      reason: 'diarization_disabled',
    })
  }

  try {
    return diarizationSidecar
      .processExistingAudio(paths.wav, {
        transcriptText: rawTranscript,
        context: {
          jobId,
          user,
          source: 'main-asr',
        },
        metadata: {
          jobId,
          user,
          source: 'saved-audio',
        },
      })
      .catch(err => ({
        verificationFailed: true,
        reason: 'diarization_failed',
        error: err?.message || String(err),
      }))
  } catch (err) {
    return Promise.resolve({
      verificationFailed: true,
      reason: 'diarization_failed',
      error: err?.message || String(err),
    })
  }
}

function getTranscriptQueue(targetSocket, user = null) {
  const key = transcriptQueueKey(targetSocket, user)
  if (key) {
    let queue = transcriptQueuesByUser.get(key)
    if (!queue) {
      queue = createTranscriptQueue()
      transcriptQueuesByUser.set(key, queue)
    }
    return queue
  }

  if (!targetSocket || typeof targetSocket !== 'object') return null

  let queue = transcriptQueuesBySocket.get(targetSocket)
  if (!queue) {
    queue = createTranscriptQueue()
    transcriptQueuesBySocket.set(targetSocket, queue)
  }
  return queue
}

function createTranscriptQueue() {
  return {
    items: [],
    timer: null,
    flushPromise: Promise.resolve(),
    activeSegments: 0,
    pendingAsrJobs: 0,
    lastTranscriptAt: 0,
    lastActivityAt: 0,
  }
}

function transcriptQueueKey(targetSocket, user = null) {
  const activity = targetSocket ? audioSocketActivity.get(targetSocket) : null
  return activeAudioSocketKey(user || activity?.user)
}

function markTranscriptQueueActivity(targetSocket) {
  const queue = targetSocket ? getTranscriptQueue(targetSocket) : null
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

function markAsrJobQueued(targetSocket, user = null) {
  const queue = getTranscriptQueue(targetSocket, user)
  if (!queue) return

  queue.pendingAsrJobs += 1
  markTranscriptQueueActivity(targetSocket)
}

function markAsrJobFinished(targetSocket, user = null) {
  const queue = getTranscriptQueue(targetSocket, user)
  if (!queue) return

  queue.pendingAsrJobs = Math.max(0, queue.pendingAsrJobs - 1)
  markTranscriptQueueActivity(targetSocket)
  scheduleTranscriptQueueFlush(targetSocket, null, user)
}

function enqueueRawTranscript(item) {
  const queue = getTranscriptQueue(item.targetSocket, item.user)
  if (!queue) {
    flushRawTranscriptBatch([item]).catch(err => {
      console.error(`[transcript-queue] failed to flush fallback batch: ${err.message}`)
    })
    return
  }

  queue.items.push(item)
  queue.lastTranscriptAt = Date.now()
  queue.lastActivityAt = queue.lastTranscriptAt
  scheduleTranscriptQueueFlush(item.targetSocket, null, item.user)
  const queuedText = combineQueuedTranscripts(queue.items.map(queueItem => queueItem.rawTranscript))

  logThinClientSendForUser(item.targetSocket, item.user, {
    type: 'asr_status',
    status: 'queued',
    jobId: item.jobId,
    queuedSegments: queue.items.length,
    queuedText: thinClientTextPreview(queuedText),
    debounceMs: transcriptQueueIdleMs,
    activeSegments: queue.activeSegments,
    pendingAsrJobs: queue.pendingAsrJobs,
    file: basename(item.paths.wav),
  }, {
    job: item.jobId,
    status: 'queued',
    queuedSegments: queue.items.length,
    activeSegments: queue.activeSegments,
    pendingAsrJobs: queue.pendingAsrJobs,
  })
  console.log(
    `[transcript-queue] queued job ${item.jobId}; queuedSegments=${queue.items.length} chars=${queuedText.length} activeSegments=${queue.activeSegments} pendingAsrJobs=${queue.pendingAsrJobs}; waiting ${(transcriptQueueIdleMs / 1000).toFixed(1)}s after last translated text/VAD speech and audio idle`,
  )
}

function scheduleTranscriptQueueFlush(targetSocket, retryMs = null, user = null) {
  const queue = getTranscriptQueue(targetSocket, user)
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
      .then(() => flushTranscriptQueue(targetSocket, user))
  }, waitMs)
  queue.timer.unref?.()
}

async function flushTranscriptQueue(targetSocket, user = null, options = {}) {
  const queue = getTranscriptQueue(targetSocket, user)
  if (!queue || !queue.items.length) return

  const force = options.force === true
  const maxHoldReached = transcriptQueueMaxHoldReached(queue)
  const lastActivityAt = queuedTranscriptActivityAt(queue)
  const elapsedMs = Date.now() - lastActivityAt
  if (!force && !maxHoldReached && elapsedMs < transcriptQueueIdleMs) {
    scheduleTranscriptQueueFlush(targetSocket)
    return
  }

  if (!force && (queue.activeSegments > 0 || queue.pendingAsrJobs > 0) && !maxHoldReached) {
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

  if (force) {
    console.log(
      `[transcript-queue] flush requested by client; queuedSegments=${queue.items.length} activeSegments=${queue.activeSegments} pendingAsrJobs=${queue.pendingAsrJobs}`,
    )
  }

  const items = queue.items
  queue.items = []
  await flushRawTranscriptBatch(items)
}

function forceTranscriptQueueFlush(targetSocket, user = null) {
  const queue = getTranscriptQueue(targetSocket, user)
  if (!queue || !queue.items.length) return false

  if (queue.timer) {
    clearTimeout(queue.timer)
    queue.timer = null
  }
  queue.flushPromise = queue.flushPromise
    .catch(() => {})
    .then(() => flushTranscriptQueue(targetSocket, user, { force: true }))
  return true
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

  console.log(
    `[transcript-queue] flushing ${batch.length} segment(s): jobs=${jobIds.join(',')} rawChars=${rawTranscript.length} file=${basename(paths.wav)} ${socketDebugLabel(targetSocket)} user=${userLabel(user)}`,
  )
  if (cleanupConfig.enabled) {
    logThinClientSendForUser(targetSocket, user, {
      type: 'asr_status',
      status: 'cleaning',
      jobId: lastItem.jobId,
      jobIds,
      queuedSegments: batch.length,
    }, {
      job: lastItem.jobId,
      status: 'cleaning',
      queuedSegments: batch.length,
    })
  }

  const cleanup = await cleanTranscript(rawTranscript, cleanupConfig)
  const cleanedTranscript = cleanup.text
  console.log(
    `[transcript] cleaned job=${lastItem.jobId} jobs=${jobIds.join(',')} cleanupEnabled=${cleanup.enabled} cleanupOk=${cleanup.ok} rawChars=${rawTranscript.length} cleanChars=${cleanedTranscript.length}`,
  )

  writeTranscriptFiles(paths, rawTranscript, cleanedTranscript, cleanup, user, {
    queuedSegments: batch.map(batchItem => queuedSegmentMetadata(batchItem)),
  })
  appendTranscript(rawTranscript, cleanedTranscript, paths, cleanup, user, {
    queuedSegments: batch.map(batchItem => queuedSegmentMetadata(batchItem)),
  })
  const createdAt = new Date().toISOString()
  const historyEntry = appendMessageHistory({
    label: 'You',
    text: cleanedTranscript,
    createdAt,
  })
  console.log(`[transcript:clean] ${cleanedTranscript}`)
  console.log(
    `[transcript] saved job=${lastItem.jobId} txt=${paths.txt} raw=${paths.rawTxt} clean=${paths.cleanTxt} json=${paths.json}`,
  )
  const transcriptSent = logThinClientSendForUser(targetSocket, user, {
    type: 'transcript',
    text: thinClientTextPreview(cleanedTranscript),
    historyId: historyEntry?.id,
    hasDetail: thinClientTextPreview(cleanedTranscript) !== cleanedTranscript,
    user,
    jobId: lastItem.jobId,
    jobIds,
    queuedSegments: batch.length,
    createdAt,
  }, {
    job: lastItem.jobId,
    jobs: jobIds.join(','),
    queuedSegments: batch.length,
    cleanChars: cleanedTranscript.length,
    file: basename(paths.txt),
  })
  console.log(
    `[transcript] thin-client delivery job=${lastItem.jobId} sent=${transcriptSent} file=${basename(paths.txt)} ${socketDebugLabel(targetSocket)}`,
  )
  console.log(`[asr] queued transcript saved: ${paths.txt}`)
  const customRoute = findCustomAgentInvocation(
    cleanedTranscript,
    rawTranscript,
    currentCustomAgents(),
  )
  if (customRoute) {
    startCustomAgent(customRoute, {
      batch,
      rawTranscript,
      cleanedTranscript,
      paths,
      targetSocket,
      user,
      jobId: lastItem.jobId,
      jobIds,
    })
    return
  }

  await maybePostToWorkbench(cleanedTranscript, targetSocket, {
    jobId: lastItem.jobId,
    user,
    rawText: rawTranscript,
  })
  await maybePostToTerminal(cleanedTranscript)
}

function startCustomAgent(route, context) {
  try {
    void handleCustomAgent(route, context).catch(err => {
      handleCustomAgentFailure(route, context, err)
    })
  } catch (err) {
    handleCustomAgentFailure(route, context, err)
  }
}

async function handleCustomAgent(route, context) {
  console.log(`[custom-agent] ${route.agent.name} invoked job=${context.jobId}`)

  let diarizationResults
  try {
    diarizationResults = await withTimeout(
      Promise.all(context.batch.map(item => item.diarizationPromise)),
      route.agent.verificationTimeoutMs,
    )
  } catch (err) {
    writeCustomAgentRecordSafely(route, context, {
      status: 'speaker_verification_failed',
      error: err?.message || String(err),
    })
    sendCustomAgentSavedStatus(route, context, 'speaker_verification_failed')
    return
  }

  const invocationVerification = verifyCustomAgentInvocation(
    context.batch.map(item => item.rawTranscript),
    diarizationResults,
    route.agent,
  )
  const verification = customAgentVerificationSummary(
    diarizationResults,
    invocationVerification.verified,
    invocationVerification.invocationIndexes,
    route.agent.speakerMatchThreshold,
  )
  if (!invocationVerification.verified) {
    writeCustomAgentRecordSafely(route, context, {
      status: 'speaker_unverified',
      verification,
    })
    sendCustomAgentSavedStatus(route, context, 'speaker_unverified')
    return
  }

  logThinClientSendForUser(context.targetSocket, context.user, {
    type: 'agent_status',
    status: 'sending',
    agent: route.agent.name,
    jobId: context.jobId,
  })

  let processed
  try {
    processed = await cleanTranscript(route.message, {
      ...currentTranscriptCleanupConfig(),
      enabled: true,
      prompt: route.agent.processingPrompt,
      timeoutMs: route.agent.processingTimeoutMs,
      maxTokens: route.agent.processingMaxTokens,
    })
  } catch (err) {
    processed = {
      ok: false,
      text: '',
      error: err?.message || String(err),
    }
  }

  if (!processed.ok || !normalizeTranscript(processed.text || '')) {
    writeCustomAgentRecordSafely(route, context, {
      status: 'custom_processing_failed',
      verification,
      processing: customAgentProcessingSummary(processed),
    })
    sendCustomAgentSavedStatus(route, context, 'custom_processing_failed')
    return
  }

  const processedText = normalizeTranscript(processed.text)
  const detail = customAgentDetail({
    rawTranscript: context.rawTranscript,
    cleanedTranscript: context.cleanedTranscript,
    agentName: route.agent.name,
    processedText,
  })
  const historyLabel = `[${route.agent.name} Memo]`
  const createdAt = new Date().toISOString()

  writeCustomAgentRecordSafely(route, context, {
    status: 'processed',
    verification,
    processing: customAgentProcessingSummary(processed),
    processed: processedText,
    detail,
    createdAt,
  })
  const historyEntry = appendMessageHistory({
    label: historyLabel,
    text: historyLabel,
    detail: processedText,
    createdAt,
  })
  logThinClientSendForUser(context.targetSocket, context.user, {
    type: 'agent_status',
    status: 'sent',
    agent: route.agent.name,
    message: thinClientTextPreview(route.message),
    jobId: context.jobId,
  })
  logThinClientSendForUser(context.targetSocket, context.user, {
    type: 'agent_summary',
    agent: historyLabel,
    text: thinClientTextPreview(historyLabel),
    historyId: historyEntry?.id,
    hasDetail: true,
    phase: 'final',
    is_final: true,
    createdAt,
  })
  console.log(`[custom-agent] ${route.agent.name} memo saved job=${context.jobId}`)
}

function handleCustomAgentFailure(route, context, err) {
  const error = err?.message || String(err)
  console.error(`[custom-agent] ${route.agent.name} failed job=${context.jobId}: ${error}`)
  writeCustomAgentRecordSafely(route, context, {
    status: 'custom_agent_failed',
    error,
  })
  sendCustomAgentSavedStatus(route, context, 'custom_agent_failed')
}

function sendCustomAgentSavedStatus(route, context, reason) {
  logThinClientSendForUser(context.targetSocket, context.user, {
    type: 'agent_status',
    status: 'missing_agent_prefix',
    reason,
    agent: route.agent.name,
    jobId: context.jobId,
  })
}

function writeCustomAgentRecordSafely(route, context, result) {
  const id = basename(context.paths.json, '.json')
  const path = join(transcriptDirPath, `${id}.${route.agent.id}.custom.json`)
  try {
    writeJsonFile(path, {
      type: 'custom_agent_result',
      createdAt: result.createdAt || new Date().toISOString(),
      agentId: route.agent.id,
      agent: route.agent.name,
      rawInvocation: route.rawInvocation,
      cleanedInvocation: route.cleanedInvocation,
      raw: context.rawTranscript,
      cleaned: context.cleanedTranscript,
      message: route.message,
      processed: result.processed || '',
      status: result.status,
      verification: result.verification,
      processing: result.processing,
      detail: result.detail,
      error: result.error,
      jobId: context.jobId,
      jobIds: context.jobIds,
      files: {
        audio: context.paths.wav,
        rawTranscript: context.paths.rawTxt,
        cleanedTranscript: context.paths.cleanTxt,
        displayTranscript: context.paths.txt,
      },
    })
  } catch (err) {
    console.warn(`[custom-agent] failed to save ${path}: ${err.message}`)
  }
}

function customAgentVerificationSummary(results, verified, invocationIndexes, threshold) {
  const invocationSegments = new Set(invocationIndexes)
  return {
    verified,
    policy: 'verified_invocation_segments',
    speakerMatchThreshold: threshold,
    segments: results.map((result, index) => ({
      sourceSegmentId: result?.sourceSegmentId,
      invocation: invocationSegments.has(index),
      verified: speakerBreakoutVerified(result, threshold),
      reason: result?.reason || '',
      turns: (result?.breakout?.turns || []).map(turn => ({
        speaker: turn.speaker?.displayName || turn.speaker?.id || '',
        matchedProfile: turn.speaker?.matchedProfile === true,
        profileId: turn.speaker?.profileId,
        profileSimilarity: turn.speaker?.profileSimilarity,
      })),
    })),
  }
}

function customAgentProcessingSummary(processed) {
  return {
    ok: processed?.ok === true,
    model: processed?.model,
    maxTokens: processed?.maxTokens,
    finishReason: processed?.finishReason,
    completionTokens: processed?.usage?.completion_tokens,
    error: processed?.error,
  }
}

function withTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
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
  console.log(
    `[asr] request queued job=${jobId} reason=${reason} bytes=${bytes} pcm=${paths.pcm} ${socketDebugLabel(targetSocket)} user=${userLabel(user)}`,
  )
  markAsrJobQueued(targetSocket, user)

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
      markAsrJobFinished(targetSocket, user)
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
  const connectionUrl = new URL(req.url || '/', 'http://localhost')
  const clientSessionId = stringValue(connectionUrl.searchParams.get('clientSessionId'))
  const connectionAttempt = stringValue(connectionUrl.searchParams.get('connectionAttempt'))
  const socketActivity = {
    connectionStamp,
    clientSessionId,
    connectionAttempt,
    startedAt: 0,
    firstAudioAt: 0,
    lastAudioAt: 0,
    bytes: 0,
    chunks: 0,
    user: null,
  }
  audioSocketActivity.set(socket, socketActivity)
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
  let pendingMessageHistoryRequest = false
  let evenUser = null
  let activeAudioSocketKeyForConnection = ''
  let authTimer = null
  let onboardingPromptSent = false
  let firstAudioChunkLogged = false
  let lastAudioAt = 0
  let idleLogged = false
  let stalledAudioCloseRequested = false
  let idleIndicatorEnabled = false
  let idleIndicatorClearSent = true
  let idleIndicatorFrame = 0
  const preRollBytes = Math.floor((vadPreRollMs / 1000) * bytesPerSecond)
  const preStartAudioMaxBytes = Math.max(0, Math.floor((receiverPreStartAudioBufferMs / 1000) * bytesPerSecond))
  const preStartAudioChunks = []
  let preStartAudioBytes = 0
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

  console.log(
    `[audio] connected: stamp=${connectionStamp} remote=${req.socket.remoteAddress || 'unknown'} clientSessionId=${clientSessionId || 'none'} connectionAttempt=${connectionAttempt || 'none'}`,
  )
  const idleTimer = setInterval(() => {
    try {
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

      if (!lastAudioAt) return

      const idleMs = Date.now() - lastAudioAt
      if (
        receiverStalledAudioCloseMs > 0 &&
        idleMs >= receiverStalledAudioCloseMs &&
        !stalledAudioCloseRequested
      ) {
        stalledAudioCloseRequested = true
        if (isStandbyAudioSocket()) {
          console.log(
            `[audio] standby idle: no chunks for ${(idleMs / 1000).toFixed(1)}s, leaving socket open, stamp=${connectionStamp}, bytes=${bytes}, chunks=${chunks}, readyState=${socket.readyState}`,
          )
          return
        }
        requestRetryListen('audio_stream_stalled', 'audio stream stalled')
        return
      }

      if (idleLogged || idleMs < 5_000) return

      idleLogged = true
      console.log(
        `[audio] idle: no chunks for ${(idleMs / 1000).toFixed(1)}s, stamp=${connectionStamp}, bytes=${bytes}, chunks=${chunks}, readyState=${socket.readyState}`,
      )
    } catch (err) {
      handleAudioFailure('idle_watchdog_failed', err)
    }
  }, 1_000)
  idleTimer.unref?.()

  function requestRetryListen(reason, closeReason, err = null) {
    if (socket.readyState !== WebSocket.OPEN) return

    const errorText = err ? (err.message || String(err)) : ''
    console.warn(
      `[audio] retry listen: reason=${reason}${errorText ? ` error=${errorText}` : ''}, closing active socket, stamp=${connectionStamp}, bytes=${bytes}, chunks=${chunks}, readyState=${socket.readyState}`,
    )
    logThinClientSend(socket, {
      type: 'receiver_status',
      status: 'retry_listen',
      reason,
      retry: true,
      error: errorText || undefined,
    }, {
      retry: 'listen',
      reason,
    })
    clearActiveAudioSocket(socket, activeAudioSocketKeyForConnection)
    try {
      socket.close(4002, closeReason)
    } catch (closeErr) {
      console.error(`[audio] failed to close active socket for retry: ${closeErr.message}; ${socketDebugLabel(socket)}`)
      socket.terminate?.()
    }
  }

  function handleAudioFailure(reason, err) {
    const errorText = err?.message || String(err || 'unknown error')
    if (isStandbyAudioSocket()) {
      console.warn(
        `[audio] standby ${reason}: ${errorText}; leaving socket open, stamp=${connectionStamp}, bytes=${bytes}, chunks=${chunks}, readyState=${socket.readyState}`,
      )
      sendSocketJson(socket, {
        type: 'receiver_status',
        status: 'standby',
        reason,
        error: errorText,
      })
      return
    }

    requestRetryListen(reason, 'audio receiver error', err)
  }

  if (transportAuth.challenge) {
    const challengeSent = logThinClientSend(socket, {
      type: 'auth_challenge',
      mode: 'shared-secret',
      nonce: authNonce,
      algorithm: 'hmac-sha256',
    }, {
      auth: 'challenge',
    })
    console.log(`[auth] shared-secret challenge sent stamp=${connectionStamp} sent=${challengeSent}`)
    authTimer = setTimeout(() => {
      if (transportAuthenticated || socket.readyState !== WebSocket.OPEN) return
      console.warn(`[auth] shared-secret auth timed out stamp=${connectionStamp} ${socketDebugLabel(socket)}`)
      logThinClientSend(socket, {
        type: 'auth_status',
        status: 'rejected',
        reason: 'timeout',
      }, {
        auth: 'timeout',
      })
      socket.close(1008, 'shared-secret auth timed out')
    }, transportAuthTimeoutMs)
  } else if (transportAuthenticated) {
    logThinClientSend(socket, {
      type: 'auth_status',
      status: 'accepted',
      mode: transportAuth.mode,
      transport: true,
    }, {
      auth: 'transport_accepted',
    })
    console.log(`[auth] transport accepted stamp=${connectionStamp} mode=${transportAuth.mode}`)
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
    logThinClientSend(socket, {
      type: 'onboarding_prompt',
      message: 'Say something to get started.',
    }, {
      prompt: 'onboarding',
    })
  }

  function bufferPreStartAudio(chunk) {
    if (!chunk.byteLength) return
    if (preStartAudioMaxBytes <= 0) {
      console.warn(`[audio] dropping pre-start audio: buffer disabled stamp=${connectionStamp} bytes=${chunk.byteLength}`)
      return
    }

    if (preStartAudioBytes + chunk.byteLength > preStartAudioMaxBytes) {
      console.warn(
        `[audio] dropping pre-start audio: buffer full stamp=${connectionStamp} bytes=${chunk.byteLength} bufferedBytes=${preStartAudioBytes} maxBytes=${preStartAudioMaxBytes}`,
      )
      return
    }

    preStartAudioChunks.push(chunk)
    preStartAudioBytes += chunk.byteLength
    console.warn(
      `[audio] buffered pre-start audio stamp=${connectionStamp} chunkBytes=${chunk.byteLength} bufferedChunks=${preStartAudioChunks.length} bufferedBytes=${preStartAudioBytes}`,
    )
  }

  function flushPreStartAudio() {
    if (!preStartAudioChunks.length) return

    const bufferedChunks = preStartAudioChunks.splice(0)
    const bufferedBytes = preStartAudioBytes
    preStartAudioBytes = 0
    console.log(
      `[audio] replaying pre-start audio stamp=${connectionStamp} chunks=${bufferedChunks.length} bytes=${bufferedBytes}`,
    )
    for (const chunk of bufferedChunks) {
      handleAudioChunk(chunk, 'pre-start')
    }
  }

  function isStandbyAudioSocket() {
    return Boolean(
      activeAudioSocketKeyForConnection &&
      activeAudioSocketsByUser.get(activeAudioSocketKeyForConnection) !== socket,
    )
  }

  function handleAudioChunk(chunk, source = 'live') {
    chunks += 1
    bytes += chunk.byteLength
    lastAudioAt = Date.now()
    if (!socketActivity.firstAudioAt) socketActivity.firstAudioAt = lastAudioAt
    socketActivity.lastAudioAt = lastAudioAt
    socketActivity.bytes = bytes
    socketActivity.chunks = chunks
    idleLogged = false
    stalledAudioCloseRequested = false
    idleIndicatorEnabled = true
    if (!firstAudioChunkLogged) {
      firstAudioChunkLogged = true
      console.log(`[audio] stream started: receiving G2 mic chunks, stamp=${connectionStamp}`)
    }
    if (source !== 'live') {
      console.log(`[audio] accepted ${source} chunk stamp=${connectionStamp} bytes=${chunk.byteLength}`)
    }

    if (useVad) {
      audioQueue = audioQueue
        .catch(() => {})
        .then(() => endpoint.processChunk(chunk))
        .catch(err => {
          console.error(`[audio] VAD processing failed: ${err.message}`)
          closeCurrentSegment('vad error')
          handleAudioFailure('vad_processing_failed', err)
        })
    } else {
      const segment = getCurrentSegment()
      writeSegmentChunk(segment, chunk)

      if (segmentBytesLimit && segment.bytes >= segmentBytesLimit) {
        closeCurrentSegment('segment limit')
      }
    }
  }

  socket.on('message', (data, isBinary) => {
    try {
      handleSocketMessage(data, isBinary)
    } catch (err) {
      handleAudioFailure('message_handler_failed', err)
    }
  })

  function handleSocketMessage(data, isBinary) {
    if (!isBinary) {
      const text = data.toString()
      const control = parseControlMessage(text)

      if (control?.type === 'auth') {
        console.log(`[auth] proof received stamp=${connectionStamp} proofChars=${stringValue(control.proof).length}`)
        if (isValidAuthProof(accessTokenSecret, authNonce, control.proof)) {
          transportAuthenticated = true
          if (authTimer) clearTimeout(authTimer)
          authTimer = null
          logThinClientSend(socket, {
            type: 'auth_status',
            status: 'accepted',
            mode: 'shared-secret',
            transport: true,
          }, {
            auth: 'accepted',
          })
          console.log(`[auth] shared-secret accepted stamp=${connectionStamp}`)
        } else {
          console.warn(`[auth] rejected shared-secret proof stamp=${connectionStamp}`)
          logThinClientSend(socket, {
            type: 'auth_status',
            status: 'rejected',
            reason: 'bad_proof',
          }, {
            auth: 'bad_proof',
          })
          socket.close(1008, 'shared-secret auth failed')
        }
        return
      }

      if (!transportAuthenticated) {
        console.warn(`[auth] rejected control before transport auth stamp=${connectionStamp} type=${control?.type || 'unknown'}`)
        socket.close(1008, 'transport auth required')
        return
      }

      if (control?.type === 'start') {
        if (socket.readyState !== WebSocket.OPEN) {
          console.warn(`[audio] ignored start for non-open socket stamp=${connectionStamp} ${socketDebugLabel(socket)}`)
          return
        }
        evenUser = normalizeUser(control.user)
        socketActivity.user = evenUser
        console.log(
          `[audio] start received stamp=${connectionStamp} user=${userLabel(evenUser)} source=${stringValue(control.source) || 'unknown'} clientSessionId=${stringValue(control.clientSessionId) || clientSessionId || 'none'} connectionAttempt=${stringValue(control.connectionAttempt) || connectionAttempt || 'none'} ${socketDebugLabel(socket)}`,
        )
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
        socketActivity.startedAt = Date.now()
        const nextActiveAudioSocketKey = activeAudioSocketKey(evenUser)
        if (activeAudioSocketKeyForConnection !== nextActiveAudioSocketKey) {
          clearActiveAudioSocket(socket, activeAudioSocketKeyForConnection)
        }
        const activeAudioSocketPromotion = promoteActiveAudioSocket(
          socket,
          nextActiveAudioSocketKey,
          { connectionStamp },
        )
        if (!activeAudioSocketPromotion.accepted) return
        activeAudioSocketKeyForConnection = activeAudioSocketPromotion.key
        persistScannedUser(evenUser, 'accepted')
        logThinClientSend(socket, {
          type: 'auth_status',
          status: 'accepted',
          user: evenUser,
          restricted: auth.required,
          standby: activeAudioSocketPromotion.standby,
        }, {
          auth: 'user_accepted',
          activeKey: activeAudioSocketKeyForConnection,
          standby: activeAudioSocketPromotion.standby,
        })
        console.log(
          `[audio] start accepted stamp=${connectionStamp} activeKey=${activeAudioSocketKeyForConnection || 'none'} user=${userLabel(evenUser)} standby=${activeAudioSocketPromotion.standby}`,
        )
        if (pendingMessageHistoryRequest) {
          pendingMessageHistoryRequest = false
          sendMessageHistory(socket)
        }
        if (!activeAudioSocketPromotion.standby) {
          sendOnboardingPrompt()
          flushPreStartAudio()
        }
      }
      if (control?.type === 'get_message_history') {
        const auth = currentUserAuthConfig()
        if (auth.required && !userAuthenticated) {
          pendingMessageHistoryRequest = true
          console.log(`[history] queued request until Even user authentication stamp=${connectionStamp}`)
        } else {
          sendMessageHistory(socket)
        }
      }
      if (control?.type === 'get_message_history_detail') {
        const auth = currentUserAuthConfig()
        if (!auth.required || userAuthenticated) {
          sendMessageHistoryDetails(socket, control.ids)
        }
      }
      if (control?.type === 'flush_transcript_queue') {
        const auth = currentUserAuthConfig()
        if (auth.required && !userAuthenticated) {
          console.warn('[transcript-queue] rejected client flush before Even user authentication')
          return
        }
        forceTranscriptQueueFlush(socket, evenUser)
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

    const chunk = toBuffer(data)
    if (!userAuthenticated) {
      const auth = currentUserAuthConfig()
      if (auth.required) {
        bufferPreStartAudio(chunk)
        return
      }
      userAuthenticated = true
    }

    if (!promoteAudioSocketForChunk(socket, evenUser)) return
    handleAudioChunk(chunk)
  }

  socket.on('close', (code, reason) => {
    if (authTimer) clearTimeout(authTimer)
    clearInterval(idleTimer)
    audioSockets.delete(socket)
    clearActiveAudioSocket(socket, activeAudioSocketKeyForConnection)
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
          `[audio] closed: code=${code} reason=${reasonText || 'none'} stamp=${connectionStamp}, transportAuthenticated=${transportAuthenticated} userAuthenticated=${userAuthenticated} activeKey=${activeAudioSocketKeyForConnection || 'none'}, ${bytes} bytes total, ${chunks} chunks`,
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
  const startupCustomAgents = currentCustomAgents()
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
  console.log(
    `[server] Custom agents: ${startupCustomAgents.length
      ? startupCustomAgents.map(agent => `${agent.name} (${agent.aliases.join(', ')})`).join('; ')
      : 'none'}`,
  )
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
    `[server] Speaker diarization sidecar: ${speakerDiarizationConfig.enabled ? `${speakerDiarizationConfig.rootDir} (${speakerDiarizationConfig.segmentationModel && speakerDiarizationConfig.embeddingModel ? 'onnx models configured' : 'single-speaker fallback'})` : 'disabled'}`,
  )
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
