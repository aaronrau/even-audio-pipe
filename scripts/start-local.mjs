import { spawn, spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, networkInterfaces } from 'node:os'
import { createServer as createNetServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  defaultCleanupPrompt,
  defaultCodingAgentPrompt,
} from '../local-receiver/transcript-cleanup-prompt.js'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(rootDir, 'app')
const receiverDir = join(rootDir, 'local-receiver')
const asrWorkerDir = join(rootDir, 'asr-worker')
const localAsrPython = process.platform === 'win32'
  ? join(asrWorkerDir, '.venv', 'Scripts', 'python.exe')
  : join(asrWorkerDir, '.venv', 'bin', 'python')
const configPath = resolve(rootDir, process.env.EVEN_AUDIO_PIPE_CONFIG || 'config.json')
const config = loadConfig(configPath)
const storageConfig = resolveStorageConfig(config.storage)
const transcriptQueueConfig = resolveTranscriptQueueConfig(config.transcriptQueue)
const transcriptCleanupConfig = resolveTranscriptCleanupConfig(config.transcriptCleanup)
const workbenchConfig = resolveWorkbenchConfig(config.workbench)
const vadConfig = resolveVadConfig(config.vad)
const speakerDiarizationConfig = resolveSpeakerDiarizationConfig(config.speakerDiarization)
const networkConfig = resolveNetworkConfig(config.network)

const configuredLanHost = process.env.EVEN_AUDIO_PIPE_HOST || networkConfig.lanHost
const hostIp = configuredLanHost && configuredLanHost !== 'auto' ? configuredLanHost : detectHostIp()
const appPort = Number(process.env.EVEN_AUDIO_PIPE_APP_PORT || 5173)
const receiverPort = Number(process.env.EVEN_AUDIO_PIPE_RECEIVER_PORT || 8788)
const asrPort = Number(process.env.EVEN_AUDIO_PIPE_ASR_PORT || 8790)
const asrEnabled = !isDisabled(process.env.EVEN_AUDIO_PIPE_ASR ?? '1')
const asrWorkerUrl = process.env.ASR_WORKER_URL || `http://127.0.0.1:${asrPort}`
const authConfig = resolveAuthConfig(config.auth)

const appUrl = `http://${hostIp}:${appPort}`
const wsUrl = `ws://${hostIp}:${receiverPort}/audio`
const publicWsUrl = resolvePublicWsUrl(networkConfig)
const receiverAddress = `${hostIp}:${receiverPort}`
const publicReceiverAddress = publicWsUrl ? receiverAddressFromUrl(publicWsUrl) : ''
const qrUrl = withEndpointQueryParams(
  authConfig.enabled ? withQueryParam(appUrl, 't', authConfig.token) : appUrl,
)
const receiverHttpOrigin = `http://${hostIp}:${receiverPort}`
const receiverWsOrigin = `ws://${hostIp}:${receiverPort}`
const receiverHttpsOrigin = `https://${hostIp}:${receiverPort}`
const receiverWssOrigin = `wss://${hostIp}:${receiverPort}`
const receiverWsAudioUrl = `${receiverWsOrigin}/audio`
const receiverWssAudioUrl = `${receiverWssOrigin}/audio`
const publicWhitelist = publicWsUrl ? publicNetworkWhitelist(publicWsUrl) : []
const workbenchSummaryWebhookUrl = `${receiverHttpOrigin}${workbenchConfig.summaryPath}`
const workbenchSummaryWebhookLocalUrl = `http://127.0.0.1:${receiverPort}${workbenchConfig.summaryPath}`

const children = new Set()
let shuttingDown = false

if (!hostIp) {
  console.error('Could not detect a non-internal IPv4 address.')
  console.error('Set EVEN_AUDIO_PIPE_HOST manually, e.g. EVEN_AUDIO_PIPE_HOST=100.x.y.z npm start')
  process.exit(1)
}

await ensureRequiredPortsAvailable()
await ensureDependencies(receiverDir)
await ensureDependencies(appDir)
updateAppManifest()

if (transcriptCleanupConfig.enabled && transcriptCleanupConfig.llamaCpp.autoStart) {
  try {
    const reusedCleanupServer = await findReusableLlamaCppServer(transcriptCleanupConfig)
    if (reusedCleanupServer) {
      transcriptCleanupConfig.url = reusedCleanupServer.url
      transcriptCleanupConfig.model = reusedCleanupServer.model
      console.log(`Using existing llama.cpp cleanup server: ${reusedCleanupServer.baseUrl} (${reusedCleanupServer.model})`)
    } else {
      await startLlamaCpp(transcriptCleanupConfig.llamaCpp)
      await waitForHttp(llamaCppModelsUrl(transcriptCleanupConfig.url), 'llama.cpp', 900_000)
    }
  } catch (err) {
    if (transcriptCleanupConfig.required) throw err
    console.warn(`Transcript cleanup unavailable; continuing without cleanup: ${err.message}`)
    transcriptCleanupConfig.enabled = false
  }
} else if (transcriptCleanupConfig.enabled) {
  console.log(`Using external transcript cleanup endpoint: ${transcriptCleanupConfig.url}`)
}

if (asrEnabled && !process.env.ASR_WORKER_URL) {
  const python = await ensureAsrPython()
  spawnManaged('asr-worker', python, ['server.py'], {
    cwd: asrWorkerDir,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(asrPort) },
  })
} else if (asrEnabled) {
  console.log(`Using external ASR worker: ${asrWorkerUrl}`)
}

console.log('')
console.log('Agent Audio Pipe')
console.log(`  App URL:        ${appUrl}`)
console.log(`  QR auth:        ${authConfig.enabled ? 'enabled' : 'disabled'}`)
if (authConfig.enabled) {
  console.log(`  QR auth mode:   ${authConfig.source}`)
}
console.log(`  LAN Audio WS:   ${wsUrl}`)
console.log(`  WAN Audio WS:   ${publicWsUrl || 'not configured'}`)
console.log(`  Receiver health http://127.0.0.1:${receiverPort}/health`)
printClientAppSettings()
console.log(`  ASR:            ${asrEnabled ? asrWorkerUrl : 'disabled'}`)
console.log(`  VAD:            ${vadConfig.backend}`)
console.log(`  Audio dir:      ${displayPath(storageConfig.audioDir)}`)
console.log(`  Transcript dir: ${displayPath(storageConfig.transcriptDir)}`)
console.log(`  Transcript log: ${displayPath(storageConfig.transcriptsLog)}`)
console.log(`  Transcript wait: ${(transcriptQueueConfig.idleMs / 1000).toFixed(1)}s`)
console.log(`  Transcript max hold: ${transcriptQueueConfig.maxHoldMs > 0 ? `${(transcriptQueueConfig.maxHoldMs / 1000).toFixed(1)}s` : 'disabled'}`)
console.log(`  Cleanup:        ${transcriptCleanupConfig.enabled ? `${transcriptCleanupConfig.model} at ${transcriptCleanupConfig.url}` : 'disabled'}`)
console.log(`  Diarization:    ${speakerDiarizationConfig.enabled ? speakerDiarizationConfig.rootDir : 'disabled'}`)
console.log(`  Workbench API:  ${workbenchConfig.enabled ? `${workbenchConfig.url}/messages` : 'disabled'}`)
console.log(`  Workbench agents: ${workbenchConfig.agents.join(', ') || 'none configured'}`)
console.log(`  Workbench route: ${workbenchRouteDescription(workbenchConfig)}`)
console.log(`  Workbench hook: ${workbenchSummaryWebhookLocalUrl}`)
console.log(`  LAN hook:       ${workbenchSummaryWebhookUrl}`)
console.log('')
console.log('Speech Agent Workbench settings (run from the speech-agent-workbench checkout):')
console.log('  Do not use linux-voice-codex/run-auto.sh; it does not provide /messages.')
console.log(`  VOICE_API_ENABLED=1`)
console.log(`  VOICE_API_PORT=${portFromUrl(workbenchConfig.url) || 8787}`)
console.log(`  VOICE_API_TOKEN=${workbenchConfig.token ? '<same as workbench.token>' : ''}`)
console.log(`  VOICE_TMUX_SUMMARY_WEBHOOK_URL=${workbenchSummaryWebhookLocalUrl}`)
console.log(`  VOICE_TMUX_SUMMARY_WEBHOOK_TOKEN=${workbenchConfig.summaryToken ? '<same as workbench.summaryToken>' : ''}`)
console.log('  ./run-auto.sh --disable-stt')
console.log('  Keep auto_enable_terminate_commands=false for a persistent API on port 8787.')
console.log('')

spawnManaged('receiver', 'npm', ['start'], {
  cwd: receiverDir,
  env: {
    ...process.env,
    PORT: String(receiverPort),
    ASR_WORKER_URL: asrEnabled ? asrWorkerUrl : '',
    AUDIO_DIR: storageConfig.audioDir,
    TRANSCRIPT_DIR: storageConfig.transcriptDir,
    TRANSCRIPTS_LOG: storageConfig.transcriptsLog,
    TRANSCRIPT_QUEUE_IDLE_MS: String(transcriptQueueConfig.idleMs),
    TRANSCRIPT_QUEUE_MAX_HOLD_MS: String(transcriptQueueConfig.maxHoldMs),
    TRANSCRIPT_CLEANUP_ENABLED: transcriptCleanupConfig.enabled ? '1' : '0',
    TRANSCRIPT_CLEANUP_URL: transcriptCleanupConfig.url,
    TRANSCRIPT_CLEANUP_MODEL: transcriptCleanupConfig.model,
    TRANSCRIPT_CLEANUP_TEMPERATURE: String(transcriptCleanupConfig.temperature),
    TRANSCRIPT_CLEANUP_TIMEOUT_MS: String(transcriptCleanupConfig.timeoutMs),
    TRANSCRIPT_CLEANUP_PROMPT: transcriptCleanupConfig.prompt,
    TRANSCRIPT_CLEANUP_CODING_AGENT_PROMPT: transcriptCleanupConfig.codingAgentPrompt,
    TRANSCRIPT_CLEANUP_API_KEY: transcriptCleanupConfig.apiKey,
    SPEECH_WORKBENCH_ENABLED: workbenchConfig.enabled ? '1' : '0',
    SPEECH_WORKBENCH_URL: workbenchConfig.url,
    SPEECH_WORKBENCH_TOKEN: workbenchConfig.token,
    SPEECH_WORKBENCH_AGENT: workbenchConfig.agent,
    SPEECH_WORKBENCH_AGENTS: workbenchConfig.agents.join(','),
    SPEECH_WORKBENCH_REQUIRE_AGENT_PREFIX: workbenchConfig.requireAgentPrefix ? '1' : '0',
    SPEECH_WORKBENCH_AGENT_PREFIX_WORD_LIMIT: String(workbenchConfig.agentPrefixWordLimit),
    SPEECH_WORKBENCH_AGENT_ARM_TIMEOUT_MS: String(workbenchConfig.agentArmTimeoutMs),
    SPEECH_WORKBENCH_TIMEOUT_MS: String(workbenchConfig.timeoutMs),
    SPEECH_WORKBENCH_SUMMARY_TOKEN: workbenchConfig.summaryToken,
    SPEECH_WORKBENCH_SUMMARY_PATH: workbenchConfig.summaryPath,
    SPEECH_WORKBENCH_PROGRESS_STALE_MS: String(workbenchConfig.progressStaleMs),
    EVEN_AUDIO_PIPE_CONFIG_PATH: configPath,
    EVEN_AUDIO_PIPE_TOKEN: authConfig.enabled ? authConfig.token : '',
    EVEN_AUDIO_PIPE_TOKEN_SECRET: authConfig.enabled ? authConfig.tokenSecret : '',
    VAD_BACKEND: vadConfig.backend,
    VAD_FRAME_MS: String(vadConfig.frameMs),
    VAD_SILENCE_MS: String(vadConfig.silenceMs),
    VAD_MIN_SPEECH_MS: String(vadConfig.speechMs),
    VAD_PRE_ROLL_MS: String(vadConfig.preRollMs),
    VAD_MIN_UTTERANCE_MS: String(vadConfig.minUtteranceMs),
    SILERO_VAD_THRESHOLD: String(vadConfig.threshold),
    SILERO_VAD_FRAME_SAMPLES: String(vadConfig.frameSamples),
    SILERO_VAD_MODEL: vadConfig.model,
    SPEAKER_DIARIZATION_ENABLED: speakerDiarizationConfig.enabled ? '1' : '0',
    SPEAKER_DIARIZATION_DIR: speakerDiarizationConfig.rootDir,
    SPEAKER_DIARIZATION_TRANSCRIPT_DIR: speakerDiarizationConfig.speakerTranscriptDir,
    SPEAKER_DIARIZATION_SEGMENTATION_MODEL: speakerDiarizationConfig.segmentationModel,
    SPEAKER_DIARIZATION_EMBEDDING_MODEL: speakerDiarizationConfig.embeddingModel,
    SPEAKER_DIARIZATION_NUM_CLUSTERS: String(speakerDiarizationConfig.numClusters),
    SPEAKER_DIARIZATION_CLUSTER_THRESHOLD: String(speakerDiarizationConfig.clusterThreshold),
    SPEAKER_DIARIZATION_MIN_DURATION_ON: String(speakerDiarizationConfig.minDurationOn),
    SPEAKER_DIARIZATION_MIN_DURATION_OFF: String(speakerDiarizationConfig.minDurationOff),
    SPEAKER_DIARIZATION_MAX_OPEN_SEGMENTS: String(speakerDiarizationConfig.maxOpenSegments),
    SPEAKER_DIARIZATION_MAX_PENDING_SEGMENTS: String(speakerDiarizationConfig.maxPendingSegments),
    SPEAKER_DIARIZATION_MAX_SEGMENT_BYTES: String(speakerDiarizationConfig.maxSegmentBytes),
    SPEAKER_DIARIZATION_WORKER_PROCESS: speakerDiarizationConfig.workerProcess ? '1' : '0',
    SPEAKER_DIARIZATION_WORKER_TIMEOUT_MS: String(speakerDiarizationConfig.workerTimeoutMs),
    SPEAKER_DIARIZATION_ASR_WORKER_URL: speakerDiarizationConfig.asrWorkerUrl || (asrEnabled ? asrWorkerUrl : ''),
    SPEAKER_DIARIZATION_ASR_TIMEOUT_MS: String(speakerDiarizationConfig.asrTimeoutMs),
    SPEAKER_DIARIZATION_ENROLLMENT_ENABLED: speakerDiarizationConfig.enrollmentEnabled ? '1' : '0',
    SPEAKER_DIARIZATION_ENROLLMENT_MIN_DURATION_SEC: String(speakerDiarizationConfig.enrollmentMinDurationSec),
    SPEAKER_DIARIZATION_PROFILE_MAX_SAMPLES: String(speakerDiarizationConfig.profileMaxSamples),
    SPEAKER_DIARIZATION_MATCH_THRESHOLD: String(speakerDiarizationConfig.speakerMatchThreshold),
  },
})

spawnManaged('vite', 'npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(appPort), '--strictPort'], {
  cwd: appDir,
  env: process.env,
})

await waitForHttp(`http://127.0.0.1:${receiverPort}/health`, 'receiver')
await waitForHttp(`http://127.0.0.1:${appPort}`, 'vite')
if (asrEnabled) {
  await waitForHttp(`${asrWorkerUrl}/health`, 'asr-worker', 300_000)
}

console.log('')
printClientAppSettings()
console.log('')
console.log('Scan this QR with the Even app:')
console.log('')

await runQr()

console.log('')
process.stdin.resume()

function detectHostIp() {
  const candidates = []
  const nets = networkInterfaces()

  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      const score = interfaceScore(name, addr.address)
      candidates.push({ name, address: addr.address, score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.address || ''
}

function interfaceScore(name, address) {
  let score = 0
  if (/^(en|eth|wl|wlan|tailscale|utun|tun)/i.test(name)) score += 20
  if (/docker|br-|veth|virbr|vmnet/i.test(name)) score -= 50
  if (/^192\.168\./.test(address)) score += 30
  if (/^10\./.test(address)) score += 25
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) score += 10
  if (/^100\./.test(address)) score += 20
  return score
}

function loadConfig(configPath) {
  if (!existsSync(configPath)) return {}

  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (err) {
    console.error(`Failed to read config JSON at ${configPath}: ${err.message}`)
    process.exit(1)
  }
}

function resolveStorageConfig(storage = {}) {
  const audioDir = resolveConfigPath(
    process.env.AUDIO_DIR ||
    process.env.OUT_DIR ||
    storage.audioDir ||
    storage.recordingsDir ||
    'data/audio',
  )
  const transcriptDir = resolveConfigPath(
    process.env.TRANSCRIPT_DIR ||
    storage.transcriptDir ||
    storage.transcriptsDir ||
    'data/transcripts',
  )
  const transcriptsLog = resolveConfigPath(
    process.env.TRANSCRIPTS_LOG ||
    storage.transcriptsLog ||
    join(transcriptDir, 'transcripts.log'),
  )

  return { audioDir, transcriptDir, transcriptsLog }
}

function resolveAuthConfig(auth = {}) {
  const enabled = !isDisabled(
    process.env.EVEN_AUDIO_PIPE_AUTH ??
    auth.enabled ??
    '1',
  )
  const configuredToken = String(
    process.env.EVEN_AUDIO_PIPE_TOKEN ||
    auth.token ||
    '',
  ).trim()
  const tokenSecret = String(
    process.env.EVEN_AUDIO_PIPE_TOKEN_SECRET ||
    auth.tokenSecret ||
    auth.secret ||
    '',
  ).trim()
  const tokenUserId = resolveAuthTokenUserId(auth)
  const derivedToken = tokenSecret && tokenUserId
    ? createHmac('sha256', tokenSecret).update(tokenUserId).digest('base64url')
    : ''
  const randomToken = () => randomBytes(18).toString('base64url')

  return {
    enabled,
    token: enabled ? derivedToken || configuredToken || randomToken() : '',
    tokenSecret,
    source: authTokenSource({ derivedToken, configuredToken, tokenSecret, tokenUserId }),
    tokenUserId,
  }
}

function resolveAuthTokenUserId(auth = {}) {
  const allowedUserIds = stringArray('', auth.allowedUserIds || auth.userIds || auth.uids)
  const candidates = [
    process.env.EVEN_AUDIO_PIPE_AUTH_UID,
    process.env.EVEN_AUDIO_PIPE_TOKEN_USER_ID,
    auth.tokenUserId,
    auth.uid,
    allowedUserIds[0],
    auth.lastUser?.uid,
    auth.lastUser?.userId,
    auth.lastUser?.id,
  ]

  return candidates.map(value => String(value || '').trim()).find(Boolean) || ''
}

function authTokenSource({ derivedToken, configuredToken, tokenSecret, tokenUserId }) {
  if (derivedToken) return `uid-hmac (${tokenUserId})`
  if (tokenSecret) return 'uid-hmac unavailable: missing uid'
  if (configuredToken) return 'configured token'
  return 'random token'
}

function resolveNetworkConfig(network = {}) {
  return {
    lanHost: String(
      process.env.EVEN_AUDIO_PIPE_LAN_HOST ||
      network.lanHost ||
      'auto',
    ).trim(),
    publicUrl: String(
      process.env.EVEN_AUDIO_PIPE_PUBLIC_URL ||
      process.env.EVEN_AUDIO_PUBLIC_URL ||
      network.publicUrl ||
      '',
    ).trim(),
    publicWsUrl: String(
      process.env.EVEN_AUDIO_PIPE_PUBLIC_WS_URL ||
      process.env.EVEN_AUDIO_PUBLIC_WS_URL ||
      network.publicWsUrl ||
      network.wanWsUrl ||
      '',
    ).trim(),
  }
}

function resolvePublicWsUrl(networkConfig) {
  const source = networkConfig.publicWsUrl || networkConfig.publicUrl
  if (!source) return ''

  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(source)
      ? source
      : `wss://${source}`
    const parsed = new URL(withScheme)
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
    if (parsed.pathname === '/' || !parsed.pathname) parsed.pathname = '/audio'
    return parsed.toString()
  } catch {
    return ''
  }
}

function publicNetworkWhitelist(publicWsUrl) {
  try {
    const parsed = new URL(publicWsUrl)
    const webProtocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    const wsOrigin = `${parsed.protocol}//${parsed.host}`
    return uniqueStrings([
      wsOrigin,
      `${wsOrigin}/audio`,
      publicWsUrl,
      `${webProtocol}//${parsed.host}`,
    ])
  } catch {
    return []
  }
}

function receiverAddressFromUrl(value) {
  try {
    return new URL(value).host
  } catch {
    return String(value || '')
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/\/.*$/, '')
  }
}

function printClientAppSettings() {
  console.log('')
  console.log('CLIENT APP SETTINGS - enter these in the packaged app')
  console.log('  Private IP:')
  console.log(`    ${hostIp}`)
  console.log('  Private Port:')
  console.log(`    ${receiverPort}`)
  console.log('  Public IP:')
  console.log(`    ${publicReceiverAddress ? publicReceiverAddressHost(publicReceiverAddress) : '(leave blank)'}`)
  console.log('  Public Port:')
  console.log(`    ${publicReceiverAddress ? publicReceiverAddressPort(publicReceiverAddress) || receiverPort : '(leave blank)'}`)
  console.log('  Secret:')
  console.log(`    ${clientAppSecretValue()}`)
  console.log('  Do not enter:')
  console.log(`    ${appUrl}  (this is the app page, not the receiver)`)
  console.log('')
}

function clientAppSecretValue() {
  if (!authConfig.enabled) return '(leave blank; auth disabled)'
  return authConfig.tokenSecret || '(set config.auth.tokenSecret)'
}

function publicReceiverAddressHost(value) {
  const parsed = splitHostPort(value)
  return parsed.host
}

function publicReceiverAddressPort(value) {
  const parsed = splitHostPort(value)
  return parsed.port
}

function splitHostPort(value) {
  try {
    const parsed = new URL(`wss://${value}`)
    return { host: parsed.hostname, port: parsed.port }
  } catch {
    const match = String(value || '').match(/^(.+):(\d+)$/)
    if (match) return { host: match[1], port: match[2] }
    return { host: String(value || ''), port: '' }
  }
}

function withEndpointQueryParams(url) {
  const parsed = new URL(url)
  parsed.searchParams.set('private', receiverAddress)
  if (publicReceiverAddress) parsed.searchParams.set('public', publicReceiverAddress)
  return parsed.toString()
}

function resolveTranscriptQueueConfig(queue = {}) {
  const idleMs = Number(
    process.env.TRANSCRIPT_QUEUE_IDLE_MS ??
    queue.idleMs ??
    3_000,
  )
  const maxHoldMs = Number(
    process.env.TRANSCRIPT_QUEUE_MAX_HOLD_MS ??
    queue.maxHoldMs ??
    10_000,
  )

  return {
    idleMs: Number.isFinite(idleMs) ? idleMs : 3_000,
    maxHoldMs: Number.isFinite(maxHoldMs) ? Math.max(0, maxHoldMs) : 10_000,
  }
}

function resolveVadConfig(vad = {}) {
  const backend = String(
    process.env.VAD_BACKEND ||
    vad.backend ||
    'silero',
  ).trim().toLowerCase()
  const frameMs = Number(process.env.VAD_FRAME_MS ?? vad.frameMs ?? 30)
  const frameSamples = Number(process.env.SILERO_VAD_FRAME_SAMPLES ?? vad.frameSamples ?? 512)
  const silenceMs = Number(process.env.VAD_SILENCE_MS ?? vad.silenceMs ?? 240)
  const speechMs = Number(process.env.VAD_MIN_SPEECH_MS ?? vad.speechMs ?? 60)
  const preRollMs = Number(process.env.VAD_PRE_ROLL_MS ?? vad.preRollMs ?? 500)
  const minUtteranceMs = Number(process.env.VAD_MIN_UTTERANCE_MS ?? vad.minUtteranceMs ?? 250)
  const threshold = Number(process.env.SILERO_VAD_THRESHOLD ?? vad.threshold ?? 0.5)

  return {
    backend: backend === 'rms' ? 'rms' : 'silero',
    model: process.env.SILERO_VAD_MODEL || vad.model ? resolveConfigPath(process.env.SILERO_VAD_MODEL || vad.model) : '',
    frameMs: Number.isFinite(frameMs) ? Math.max(10, Math.floor(frameMs)) : 30,
    frameSamples: normalizeSileroFrameSamples(frameSamples),
    silenceMs: Number.isFinite(silenceMs) ? Math.max(0, Math.floor(silenceMs)) : 240,
    speechMs: Number.isFinite(speechMs) ? Math.max(0, Math.floor(speechMs)) : 60,
    preRollMs: Number.isFinite(preRollMs) ? Math.max(0, Math.floor(preRollMs)) : 500,
    minUtteranceMs: Number.isFinite(minUtteranceMs) ? Math.max(0, Math.floor(minUtteranceMs)) : 250,
    threshold: Number.isFinite(threshold) ? threshold : 0.5,
  }
}

function normalizeSileroFrameSamples(value) {
  const frameSamples = Number(value)
  return [512, 1024, 1536].includes(frameSamples) ? frameSamples : 512
}

function resolveSpeakerDiarizationConfig(config = {}) {
  const enabled = !isDisabled(
    process.env.SPEAKER_DIARIZATION_ENABLED ??
    config.enabled ??
    '1',
  )
  const rootDir = resolveConfigPath(
    process.env.SPEAKER_DIARIZATION_DIR ||
    config.rootDir ||
    config.dir ||
    'data/diarization',
  )
  const speakerTranscriptDir = resolveConfigPath(
    process.env.SPEAKER_DIARIZATION_TRANSCRIPT_DIR ||
    config.speakerTranscriptDir ||
    storageConfig.transcriptDir,
  )
  const segmentationModel = String(
    process.env.SPEAKER_DIARIZATION_SEGMENTATION_MODEL ||
    config.segmentationModel ||
    '',
  ).trim()
  const embeddingModel = String(
    process.env.SPEAKER_DIARIZATION_EMBEDDING_MODEL ||
    config.embeddingModel ||
    '',
  ).trim()
  const numClusters = Number(
    process.env.SPEAKER_DIARIZATION_NUM_CLUSTERS ??
    config.numClusters ??
    -1,
  )
  const clusterThreshold = Number(
    process.env.SPEAKER_DIARIZATION_CLUSTER_THRESHOLD ??
    config.clusterThreshold ??
    0.5,
  )
  const minDurationOn = Number(
    process.env.SPEAKER_DIARIZATION_MIN_DURATION_ON ??
    config.minDurationOn ??
    0.2,
  )
  const minDurationOff = Number(
    process.env.SPEAKER_DIARIZATION_MIN_DURATION_OFF ??
    config.minDurationOff ??
    0.5,
  )
  const maxOpenSegments = Number(
    process.env.SPEAKER_DIARIZATION_MAX_OPEN_SEGMENTS ??
    config.maxOpenSegments ??
    4,
  )
  const maxPendingSegments = Number(
    process.env.SPEAKER_DIARIZATION_MAX_PENDING_SEGMENTS ??
    config.maxPendingSegments ??
    32,
  )
  const maxSegmentBytes = Number(
    process.env.SPEAKER_DIARIZATION_MAX_SEGMENT_BYTES ??
    config.maxSegmentBytes ??
    16_000 * 2 * 30,
  )
  const workerProcess = !isDisabled(
    process.env.SPEAKER_DIARIZATION_WORKER_PROCESS ??
    config.workerProcess ??
    '1',
  )
  const workerTimeoutMs = Number(
    process.env.SPEAKER_DIARIZATION_WORKER_TIMEOUT_MS ??
    config.workerTimeoutMs ??
    120_000,
  )
  const asrWorkerUrl = String(
    process.env.SPEAKER_DIARIZATION_ASR_WORKER_URL ||
    config.asrWorkerUrl ||
    '',
  ).trim()
  const asrTimeoutMs = Number(
    process.env.SPEAKER_DIARIZATION_ASR_TIMEOUT_MS ??
    config.asrTimeoutMs ??
    60_000,
  )
  const enrollmentEnabled = !isDisabled(
    process.env.SPEAKER_DIARIZATION_ENROLLMENT_ENABLED ??
    config.enrollmentEnabled ??
    '1',
  )
  const enrollmentMinDurationSec = Number(
    process.env.SPEAKER_DIARIZATION_ENROLLMENT_MIN_DURATION_SEC ??
    config.enrollmentMinDurationSec ??
    1.5,
  )
  const profileMaxSamples = Number(
    process.env.SPEAKER_DIARIZATION_PROFILE_MAX_SAMPLES ??
    config.profileMaxSamples ??
    1,
  )
  const speakerMatchThreshold = Number(
    process.env.SPEAKER_DIARIZATION_MATCH_THRESHOLD ??
    config.speakerMatchThreshold ??
    0.6,
  )

  return {
    enabled,
    rootDir,
    speakerTranscriptDir,
    segmentationModel: segmentationModel ? resolveConfigPath(segmentationModel) : '',
    embeddingModel: embeddingModel ? resolveConfigPath(embeddingModel) : '',
    numClusters: Number.isFinite(numClusters) ? Math.floor(numClusters) : -1,
    clusterThreshold: Number.isFinite(clusterThreshold) ? clusterThreshold : 0.5,
    minDurationOn: Number.isFinite(minDurationOn) ? Math.max(0, minDurationOn) : 0.2,
    minDurationOff: Number.isFinite(minDurationOff) ? Math.max(0, minDurationOff) : 0.5,
    maxOpenSegments: Number.isFinite(maxOpenSegments) ? Math.max(1, Math.floor(maxOpenSegments)) : 4,
    maxPendingSegments: Number.isFinite(maxPendingSegments) ? Math.max(1, Math.floor(maxPendingSegments)) : 32,
    maxSegmentBytes: Number.isFinite(maxSegmentBytes) ? Math.max(16_000 * 2, Math.floor(maxSegmentBytes)) : 16_000 * 2 * 30,
    workerProcess,
    workerTimeoutMs: Number.isFinite(workerTimeoutMs) ? Math.max(1_000, Math.floor(workerTimeoutMs)) : 120_000,
    asrWorkerUrl,
    asrTimeoutMs: Number.isFinite(asrTimeoutMs) ? Math.max(1_000, Math.floor(asrTimeoutMs)) : 60_000,
    enrollmentEnabled,
    enrollmentMinDurationSec: Number.isFinite(enrollmentMinDurationSec) ? Math.max(0, enrollmentMinDurationSec) : 1.5,
    profileMaxSamples: Number.isFinite(profileMaxSamples) ? Math.max(1, Math.floor(profileMaxSamples)) : 1,
    speakerMatchThreshold: Number.isFinite(speakerMatchThreshold) ? speakerMatchThreshold : 0.6,
  }
}

function resolveWorkbenchConfig(workbench = {}) {
  const enabled = !isDisabled(
    process.env.SPEECH_WORKBENCH_ENABLED ??
    workbench.enabled ??
    '0',
  )
  const url = String(
    process.env.SPEECH_WORKBENCH_URL ||
    workbench.url ||
    'http://127.0.0.1:8787',
  ).trim().replace(/\/+$/, '')
  const token = String(
    process.env.SPEECH_WORKBENCH_TOKEN ||
    workbench.token ||
    '',
  )
  const agent = String(
    process.env.SPEECH_WORKBENCH_AGENT ||
    workbench.agent ||
    '',
  ).trim()
  const agents = stringArray(
    process.env.SPEECH_WORKBENCH_AGENTS,
    workbench.agents || ['Flux', 'Brock', 'Pike', 'Wolf'],
  )
  const requireAgentPrefix = !isDisabled(
    process.env.SPEECH_WORKBENCH_REQUIRE_AGENT_PREFIX ??
    workbench.requireAgentPrefix ??
    '1',
  )
  const agentPrefixWordLimit = Number(
    process.env.SPEECH_WORKBENCH_AGENT_PREFIX_WORD_LIMIT ??
    workbench.agentPrefixWordLimit ??
    3,
  )
  const agentArmTimeoutMs = Number(
    process.env.SPEECH_WORKBENCH_AGENT_ARM_TIMEOUT_MS ??
    workbench.agentArmTimeoutMs ??
    30_000,
  )
  const timeoutMs = Number(
    process.env.SPEECH_WORKBENCH_TIMEOUT_MS ??
    workbench.timeoutMs ??
    15_000,
  )
  const summaryToken = String(
    process.env.SPEECH_WORKBENCH_SUMMARY_TOKEN ||
    workbench.summaryToken ||
    '',
  )
  const summaryPath = normalizeHttpPath(
    process.env.SPEECH_WORKBENCH_SUMMARY_PATH ||
    workbench.summaryPath ||
    '/workbench/summary',
  )
  const progressStaleMs = Number(
    process.env.SPEECH_WORKBENCH_PROGRESS_STALE_MS ??
    workbench.progressStaleMs ??
    180_000,
  )

  return {
    enabled,
    url,
    token,
    agent,
    agents,
    requireAgentPrefix,
    agentPrefixWordLimit: Number.isFinite(agentPrefixWordLimit) ? Math.max(1, Math.floor(agentPrefixWordLimit)) : 3,
    agentArmTimeoutMs: Number.isFinite(agentArmTimeoutMs) ? Math.max(0, Math.floor(agentArmTimeoutMs)) : 30_000,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15_000,
    summaryToken,
    summaryPath,
    progressStaleMs: Number.isFinite(progressStaleMs) ? Math.max(0, Math.floor(progressStaleMs)) : 180_000,
  }
}

function workbenchRouteDescription(workbenchConfig) {
  if (!workbenchConfig.requireAgentPrefix) return 'default/pending agent allowed'

  const armSeconds = (workbenchConfig.agentArmTimeoutMs / 1000).toFixed(1)
  return `agent in first ${workbenchConfig.agentPrefixWordLimit} words required; agent-only arms next transcript for ${armSeconds}s`
}

function normalizeHttpPath(value) {
  const path = String(value || '').trim() || '/'
  return path.startsWith('/') ? path : `/${path}`
}

function portFromUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  } catch {
    return ''
  }
}

function withQueryParam(url, key, value) {
  const parsed = new URL(url)
  parsed.searchParams.set(key, value)
  return parsed.toString()
}

function resolveTranscriptCleanupConfig(cleanup = {}) {
  const llamaCpp = resolveLlamaCppConfig(cleanup.llamaCpp || {})
  const baseUrl = String(
    process.env.TRANSCRIPT_CLEANUP_BASE_URL ||
    cleanup.baseUrl ||
    '',
  ).trim()
  let url = String(
    process.env.TRANSCRIPT_CLEANUP_URL ||
    cleanup.url ||
    (baseUrl ? chatCompletionsUrl(baseUrl) : 'http://127.0.0.1:8080/v1/chat/completions'),
  ).trim()
  let model = String(
    process.env.TRANSCRIPT_CLEANUP_MODEL ||
    cleanup.model ||
    'gemma-4-e4b-it-q4_0',
  ).trim()
  const temperature = Number(
    process.env.TRANSCRIPT_CLEANUP_TEMPERATURE ??
    cleanup.temperature ??
    0,
  )
  const timeoutMs = Number(
    process.env.TRANSCRIPT_CLEANUP_TIMEOUT_MS ??
    cleanup.timeoutMs ??
    15_000,
  )
  const prompt = String(
    process.env.TRANSCRIPT_CLEANUP_PROMPT ||
    cleanup.prompt ||
    defaultCleanupPrompt(),
  )
  const codingAgentPrompt = String(
    process.env.TRANSCRIPT_CLEANUP_CODING_AGENT_PROMPT ||
    cleanup.codingAgentPrompt ||
    defaultCodingAgentPrompt(),
  )
  const apiKey = String(
    process.env.TRANSCRIPT_CLEANUP_API_KEY ||
    cleanup.apiKey ||
    '',
  )
  const enabled = !isDisabled(
    process.env.TRANSCRIPT_CLEANUP_ENABLED ??
    cleanup.enabled ??
    '0',
  )
  const required = !isDisabled(
    process.env.TRANSCRIPT_CLEANUP_REQUIRED ??
    cleanup.required ??
    '0',
  )

  if (llamaCpp.autoStart && !process.env.TRANSCRIPT_CLEANUP_URL) {
    url = chatCompletionsUrl(`http://${llamaCpp.serverHost}:${llamaCpp.serverPort}/v1`)
  }
  if (llamaCpp.autoStart && !process.env.TRANSCRIPT_CLEANUP_MODEL) {
    model = llamaCpp.alias || llamaCpp.hfModel
  }

  return {
    enabled,
    url,
    model,
    temperature: Number.isFinite(temperature) ? temperature : 0,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15_000,
    prompt,
    codingAgentPrompt,
    apiKey,
    required,
    llamaCpp,
  }
}

function resolveLlamaCppConfig(config = {}) {
  const serverPort = Number(
    process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_PORT ??
    config.serverPort ??
    8080,
  )
  const gpuLayers = Number(
    process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_GPU_LAYERS ??
    config.gpuLayers ??
    999,
  )
  const contextSize = Number(
    process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_CONTEXT_SIZE ??
    config.contextSize ??
    8192,
  )
  const parallel = Number(
    process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_PARALLEL ??
    config.parallel ??
    1,
  )

  return {
    autoStart: !isDisabled(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_AUTO_START ??
      config.autoStart ??
      '0',
    ),
    repoUrl: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_REPO_URL ||
      config.repoUrl ||
      'https://github.com/ggml-org/llama.cpp.git',
    ),
    repoDir: resolveConfigPath(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_REPO_DIR ||
      config.repoDir ||
      'tools/llama.cpp',
    ),
    buildDir: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_BUILD_DIR ||
      config.buildDir ||
      'build-rocm',
    ),
    serverHost: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_HOST ||
      config.serverHost ||
      '127.0.0.1',
    ),
    serverPort: Number.isFinite(serverPort) ? serverPort : 8080,
    hfModel: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_HF_MODEL ||
      config.hfModel ||
      'google/gemma-4-E4B-it-qat-q4_0-gguf:Q4_0',
    ),
    alias: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_ALIAS ||
      config.alias ||
      'gemma-4-e4b-it-q4_0',
    ),
    gpuLayers: Number.isFinite(gpuLayers) ? gpuLayers : 999,
    contextSize: Number.isFinite(contextSize) ? contextSize : 8192,
    parallel: Number.isFinite(parallel) ? parallel : 1,
    rocmArch: String(
      process.env.LLAMACPP_ROCM_ARCH ||
      process.env.AMDGPU_TARGETS ||
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_ROCM_ARCH ||
      config.rocmArch ||
      '',
    ),
    extraCmakeArgs: stringArray(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_EXTRA_CMAKE_ARGS,
      config.extraCmakeArgs,
    ),
    extraServerArgs: stringArray(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_EXTRA_SERVER_ARGS,
      config.extraServerArgs,
    ),
    reuseUrls: stringArray(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_REUSE_URLS,
      config.reuseUrls,
    ),
  }
}

function chatCompletionsUrl(baseUrl) {
  const cleaned = baseUrl.replace(/\/$/, '')
  if (cleaned.endsWith('/chat/completions')) return cleaned
  if (cleaned.endsWith('/v1')) return `${cleaned}/chat/completions`
  return `${cleaned}/v1/chat/completions`
}

function resolveConfigPath(value) {
  return resolve(rootDir, String(value))
}

function stringArray(envValue, configValue) {
  if (envValue) return splitStringArray(envValue)
  if (Array.isArray(configValue)) return configValue.map(value => String(value)).filter(Boolean)
  if (typeof configValue === 'string') return splitStringArray(configValue)
  return []
}

function splitStringArray(value) {
  return String(value).split(/[,\s]+/).map(item => item.trim()).filter(Boolean)
}

async function findReusableLlamaCppServer(cleanupConfig) {
  const candidates = uniqueStrings([
    cleanupConfig.url,
    ...cleanupConfig.llamaCpp.reuseUrls,
  ])

  for (const candidate of candidates) {
    const server = await probeLlamaCppServer(candidate)
    if (server) return server
  }

  return null
}

async function probeLlamaCppServer(candidateUrl) {
  const baseUrl = openAiBaseUrl(candidateUrl)
  const modelsUrl = `${baseUrl}/models`

  try {
    const body = await fetchJsonWithTimeout(modelsUrl, 1000)
    const model = firstModelId(body)
    if (!model) return null

    return {
      baseUrl,
      url: chatCompletionsUrl(baseUrl),
      model,
    }
  } catch {
    return null
  }
}

function openAiBaseUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '')

  if (url.endsWith('/chat/completions')) {
    return url.replace(/\/chat\/completions$/i, '')
  }
  if (url.endsWith('/models')) {
    return url.replace(/\/models$/i, '')
  }
  if (url.endsWith('/v1')) return url

  return `${url}/v1`
}

function firstModelId(body) {
  return String(
    body?.data?.[0]?.id ||
    body?.models?.[0]?.model ||
    body?.models?.[0]?.name ||
    '',
  ).trim()
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

async function startLlamaCpp(config) {
  const modelsUrl = llamaCppModelsUrl(chatCompletionsUrl(`http://${config.serverHost}:${config.serverPort}/v1`))
  if (await httpReady(modelsUrl)) {
    console.log(`Using existing llama.cpp server: ${modelsUrl}`)
    return
  }

  const serverBinary = await ensureLlamaCpp(config)
  const args = llamaCppServerArgs(config)

  console.log(`Starting llama.cpp transcript cleanup: ${config.hfModel}`)
  spawnManaged('llama.cpp', serverBinary, args, {
    cwd: config.repoDir,
    env: process.env,
  })
}

async function ensureLlamaCpp(config) {
  if (!existsSync(config.repoDir)) {
    ensureCommandAvailable('git', 'Install git or set transcriptCleanup.llamaCpp.repoDir to an existing llama.cpp checkout.')
    mkdirSync(dirname(config.repoDir), { recursive: true })
    console.log(`Cloning llama.cpp into ${displayPath(config.repoDir)}...`)
    await runCommand('git', ['clone', '--depth', '1', config.repoUrl, config.repoDir], { cwd: rootDir })
  }

  const existingBinary = findLlamaServerBinary(config)
  if (existingBinary) return existingBinary

  ensureCommandAvailable('cmake', 'Install cmake to build llama.cpp with ROCm.')
  ensureCommandAvailable('hipconfig', 'Install the ROCm HIP SDK so hipconfig is available on PATH.')

  const rocmArch = config.rocmArch || detectRocmTargets() || defaultRocmTargets()
  const buildEnv = {
    ...process.env,
    ...hipBuildEnv(),
    LLAMACPP_ROCM_ARCH: rocmArch,
  }
  const cmakeArgs = [
    '-S',
    '.',
    '-B',
    config.buildDir,
    '-DGGML_HIP=ON',
    `-DAMDGPU_TARGETS=${rocmArch}`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DLLAMA_CURL=ON',
    ...config.extraCmakeArgs,
  ]

  console.log(`Building llama.cpp with ROCm targets: ${rocmArch}`)
  await runCommand('cmake', cmakeArgs, { cwd: config.repoDir, env: buildEnv })
  await runCommand(
    'cmake',
    [
      '--build',
      config.buildDir,
      '--config',
      'Release',
      '--target',
      'llama-server',
      `-j${Math.max(1, cpus().length)}`,
    ],
    { cwd: config.repoDir, env: buildEnv },
  )

  const builtBinary = findLlamaServerBinary(config)
  if (!builtBinary) {
    throw new Error(`llama-server was not found after build in ${displayPath(resolve(config.repoDir, config.buildDir))}`)
  }

  return builtBinary
}

function llamaCppServerArgs(config) {
  const args = [
    '--host',
    config.serverHost,
    '--port',
    String(config.serverPort),
    '-hf',
    config.hfModel,
    '-ngl',
    String(config.gpuLayers),
    '-c',
    String(config.contextSize),
    '-np',
    String(config.parallel),
  ]

  if (config.alias) {
    args.push('--alias', config.alias)
  }

  return [...args, ...config.extraServerArgs]
}

function llamaCppModelsUrl(chatCompletionsUrlValue) {
  return chatCompletionsUrlValue
    .replace(/\/chat\/completions\/?$/i, '/models')
    .replace(/\/+$/, '')
}

function findLlamaServerBinary(config) {
  return llamaServerBinaryCandidates(config).find(candidate => existsSync(candidate)) || ''
}

function llamaServerBinaryCandidates(config) {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const buildDir = resolve(config.repoDir, config.buildDir)

  return [
    join(buildDir, 'bin', `llama-server${exe}`),
    join(buildDir, 'tools', 'server', `llama-server${exe}`),
    join(buildDir, `llama-server${exe}`),
  ]
}

function hipBuildEnv() {
  const clangDir = commandOutput('hipconfig', ['-l'])
  const hipPath = commandOutput('hipconfig', ['-R'])
  const env = {}

  if (clangDir) env.HIPCXX = join(clangDir, 'clang')
  if (hipPath) env.HIP_PATH = hipPath

  return env
}

function detectRocmTargets() {
  const result = spawnSync('rocminfo', [], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error) return ''

  const targets = new Set()
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  for (const match of output.matchAll(/\bName:\s+(gfx[0-9a-f]+)/gi)) {
    targets.add(match[1])
  }

  return [...targets].join(',')
}

function defaultRocmTargets() {
  return 'gfx803,gfx900,gfx906,gfx908,gfx90a,gfx942,gfx1010,gfx1030,gfx1032,gfx1100,gfx1101,gfx1102'
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0 || result.error) return ''
  return String(result.stdout || '').trim()
}

function ensureCommandAvailable(command, message) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
  if (!result.error) return
  throw new Error(message || `${command} is required but was not found on PATH.`)
}

async function httpReady(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1000)
  timeout.unref?.()

  try {
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function ensureDependencies(dir) {
  if (existsSync(join(dir, 'node_modules'))) return
  console.log(`Installing dependencies in ${relative(dir)}...`)
  const command = existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install'
  await runCommand('npm', [command], { cwd: dir })
}

async function ensureAsrPython() {
  const configuredPython = process.env.EVEN_AUDIO_PIPE_ASR_PYTHON

  if (configuredPython) {
    if (!existsSync(configuredPython)) {
      console.error(`Configured ASR Python does not exist: ${configuredPython}`)
      process.exit(1)
    }
    if (pythonHasAsrDeps(configuredPython)) return configuredPython

    console.error(`Configured ASR Python is missing required packages: ${configuredPython}`)
    console.error(`Install: ${configuredPython} -m pip install -r ${join(asrWorkerDir, 'requirements.txt')}`)
    process.exit(1)
  }

  if (existsSync(localAsrPython) && pythonHasAsrDeps(localAsrPython)) {
    return localAsrPython
  }

  for (const python of systemPythonCandidates()) {
    if (pythonHasAsrDeps(python)) return python
  }

  if (!existsSync(localAsrPython)) {
    console.log('Creating ASR worker Python environment...')
    await runCommand(findPythonForVenv(), ['-m', 'venv', join(asrWorkerDir, '.venv')], { cwd: asrWorkerDir })
  }

  console.log('Installing ASR worker Python dependencies...')
  await runCommand(localAsrPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: asrWorkerDir })
  await runCommand(localAsrPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: asrWorkerDir })

  if (!pythonHasAsrDeps(localAsrPython)) {
    console.error('ASR worker Python environment is still missing required packages after install.')
    process.exit(1)
  }

  return localAsrPython
}

function pythonHasAsrDeps(python) {
  const result = spawnSync(
    python,
    ['-c', 'import onnx_asr, soundfile, numpy'],
    { stdio: 'ignore' },
  )
  return result.status === 0
}

function systemPythonCandidates() {
  return process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']
}

function findPythonForVenv() {
  for (const python of systemPythonCandidates()) {
    const result = spawnSync(python, ['--version'], { stdio: 'ignore' })
    if (result.status === 0) return python
  }

  console.error('Could not find Python. Install Python 3.10+ or set EVEN_AUDIO_PIPE_ASR_PYTHON.')
  process.exit(1)
}

function updateAppManifest() {
  const manifestPath = join(appDir, 'app.json')
  const manifestSourcePath = existsSync(manifestPath)
    ? manifestPath
    : join(appDir, 'app.example.json')
  const manifest = JSON.parse(readFileSync(manifestSourcePath, 'utf8'))
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : []
  const network = permissions.find((permission) => permission?.name === 'network')
  const networkWhitelist = uniqueStrings([
    receiverWsOrigin,
    receiverWsAudioUrl,
    receiverHttpOrigin,
    receiverWssOrigin,
    receiverWssAudioUrl,
    receiverHttpsOrigin,
    ...publicWhitelist,
  ])

  if (network) {
    network.whitelist = networkWhitelist
  } else {
    permissions.push({
      name: 'network',
      desc: 'Stream microphone PCM audio to your local receiver.',
      whitelist: networkWhitelist,
    })
  }

  manifest.permissions = permissions
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function ensureRequiredPortsAvailable() {
  const checks = [
    {
      label: 'Vite app',
      port: appPort,
      host: '0.0.0.0',
      env: 'EVEN_AUDIO_PIPE_APP_PORT',
    },
    {
      label: 'receiver',
      port: receiverPort,
      host: '0.0.0.0',
      env: 'EVEN_AUDIO_PIPE_RECEIVER_PORT',
    },
  ]

  if (asrEnabled && !process.env.ASR_WORKER_URL) {
    checks.push({
      label: 'ASR worker',
      port: asrPort,
      host: '127.0.0.1',
      env: 'EVEN_AUDIO_PIPE_ASR_PORT',
    })
  }

  const seenPorts = new Map()
  const duplicatePorts = []
  for (const check of checks) {
    const key = `${check.host}:${check.port}`
    const previous = seenPorts.get(key)
    if (previous) {
      duplicatePorts.push(`${previous.label} and ${check.label} both use ${key}`)
    }
    seenPorts.set(key, check)
  }

  if (duplicatePorts.length) {
    console.error('Cannot start Agent Audio Pipe because required ports overlap:')
    for (const duplicate of duplicatePorts) console.error(`  ${duplicate}`)
    process.exit(1)
  }

  const unavailable = []
  for (const check of checks) {
    const available = await isPortAvailable(check.port, check.host)
    if (!available) unavailable.push(check)
  }

  if (!unavailable.length) return

  console.error('Cannot start Agent Audio Pipe because required port(s) are already in use:')
  for (const check of unavailable) {
    console.error(`  ${check.label}: ${check.host}:${check.port}`)
  }
  console.error('')
  console.error('Stop the existing Agent Audio Pipe process, or use alternate ports, for example:')
  console.error(`  ${unavailable.map(check => `${check.env}=<free-port>`).join(' ')} npm start`)
  console.error('')
  console.error('To inspect current owners:')
  console.error(`  ss -ltnp | rg ':(${unavailable.map(check => check.port).join('|')})\\\\b'`)
  process.exit(1)
}

function isPortAvailable(port, host) {
  return new Promise((resolvePromise) => {
    const server = createNetServer()
    server.once('error', () => {
      resolvePromise(false)
    })
    server.once('listening', () => {
      server.close(() => resolvePromise(true))
    })
    server.listen(port, host)
  })
}

function spawnManaged(label, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  })
  children.add(child)

  child.on('exit', (code, signal) => {
    children.delete(child)
    if (!shuttingDown && code !== 0 && signal !== 'SIGINT') {
      console.error(`${label} exited unexpectedly: code=${code} signal=${signal || ''}`)
      shutdown(1)
    }
  })

  return child
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

async function waitForHttp(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err?.message || String(err)
    }
    await delay(250)
  }

  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastError}`)
}

function isDisabled(value) {
  return /^(|0|false|none|off|no)$/i.test(String(value).trim())
}

async function runQr() {
  try {
    await runCommand('npx', ['evenhub', 'qr', '--url', qrUrl], { cwd: appDir })
  } catch (err) {
    console.error('')
    console.error(`Failed to run evenhub qr: ${err.message}`)
    console.error(`Manual command: cd ${appDir} && npx evenhub qr --url ${qrUrl}`)
  }
}

function relative(dir) {
  return dir.replace(`${rootDir}/`, '')
}

function displayPath(path) {
  const rel = relative(path)
  return rel === path ? path : rel
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    signalChildTree(child, 'SIGINT')
  }

  setTimeout(() => {
    for (const child of children) {
      signalChildTree(child, 'SIGTERM')
    }
  }, 1_500).unref()

  setTimeout(() => {
    for (const child of children) {
      signalChildTree(child, 'SIGKILL')
    }
    process.exit(code)
  }, 3_000).unref()
}

function signalChildTree(child, signal) {
  if (!child?.pid) return

  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal)
    } else {
      child.kill(signal)
    }
  } catch (err) {
    if (err?.code === 'ESRCH') return

    try {
      child.kill(signal)
    } catch (fallbackErr) {
      if (fallbackErr?.code !== 'ESRCH') {
        console.warn(`Failed to send ${signal} to child ${child.pid}: ${fallbackErr.message}`)
      }
    }
  }
}

process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))
process.on('uncaughtException', (err) => {
  console.error(err)
  shutdown(1)
})
process.on('unhandledRejection', (err) => {
  console.error(err)
  shutdown(1)
})
