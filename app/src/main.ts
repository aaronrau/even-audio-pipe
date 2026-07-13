import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  EventSourceType,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import {
  normalizeHistoryBlock,
  normalizeInlineText,
  type HistoryEntry,
  type HistoryScrollDirection,
} from './historyCanvas'
import {
  blankAudioEndpointSettings,
  buildAudioWsEndpoints,
  joinAddress,
  splitAddress,
  type AudioEndpointSettings,
} from './audioEndpoints'
import { historyScrollDirectionFromEventType } from './historyInput'
import { HistoryNavigator } from './historyNavigator'
import { backendStartupPromptContent, nextStartupPromptVisible, startupLiveContent } from './startupPrompt'
import {
  formatSpeechDispatchDisplay,
  normalizeSpeechDispatchText,
  type SpeechDispatchDisplay,
} from './speechDispatchDisplay'

const RECEIVER_ADDRESS_STORAGE_KEY = 'evenAudioPipe.receiverAddress'
const PRIVATE_ADDRESS_STORAGE_KEY = 'evenAudioPipe.privateAddress'
const PUBLIC_ADDRESS_STORAGE_KEY = 'evenAudioPipe.publicAddress'
const LAN_ENDPOINT_STORAGE_KEY = 'evenAudioPipe.lanAddress'
const WAN_ENDPOINT_STORAGE_KEY = 'evenAudioPipe.wanAddress'
const AUTH_TOKEN_STORAGE_KEY = 'evenAudioPipe.authToken'
const CONNECT_TIMEOUT_MS = 5000
const AUDIO_CONTROL_TIMEOUT_MS = 1500

const statusEl = document.getElementById('status')!
const statsEl = document.getElementById('stats')!
const urlEl = document.getElementById('url')!
const transcriptEl = document.getElementById('transcript')!
const privateIpEl = document.getElementById('private-ip') as HTMLInputElement | null
const privatePortEl = document.getElementById('private-port') as HTMLInputElement | null
const publicIpEl = document.getElementById('public-ip') as HTMLInputElement | null
const publicPortEl = document.getElementById('public-port') as HTMLInputElement | null
const authTokenEl = document.getElementById('auth-token') as HTMLInputElement | null
const toggleAuthTokenEl = document.getElementById('toggle-auth-token') as HTMLButtonElement | null
const saveEndpointsEl = document.getElementById('save-endpoints') as HTMLButtonElement | null
const setupReceiverEl = document.getElementById('setup-receiver') as HTMLElement | null
const setupRepoLinkEl = document.getElementById('setup-repo-link') as HTMLAnchorElement | null
const setupCommandEl = document.getElementById('setup-command') as HTMLElement | null

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

type UserPayload = {
  uid?: string
  name?: string
  country?: string
}

type GlassesMode = 'live' | 'history_list' | 'history_detail'

let sentChunks = 0
let sentBytes = 0
let droppedChunks = 0
let transcriptText = ''
let lastTranscriptEventText = ''
let speechDetected = false
let backendIdleFrame = ''
let glassesMode: GlassesMode = 'live'
let historyTransitioning = false
let historyUpdateInFlight = false
let historyUpdatePending = false
let lastHistoryRequestedContent = ''
let lastHistoryRenderedContent = ''
let lastStatusContainerUpgradeAt = 0
let lastStatusContainerContent = ''
let pendingStatusContainerContent = ''
let cleanedUp = false
let audioOpen = false
let ws: WebSocket | null = null
const startedAudioSockets = new WeakSet<WebSocket>()
const socketConnectionAttempts = new WeakMap<WebSocket, number>()
const micWatchdogState = new WeakMap<WebSocket, {
  baselineChunks: number
  restarted: boolean
}>()
let micWatchdogTimer: number | null = null
let micWatchdogSocket: WebSocket | null = null
let receiverState = 'disconnected'
let receiverStandby = false
let lastReceiverClose = ''
let reconnectTimer: number | null = null
let connectionAttempt = 0
let audioEndpointSettings = blankAudioEndpointSettings()
let audioWsEndpoints = buildAudioWsEndpoints(audioEndpointSettings)
let audioEndpointIndex = 0
let clearTranscriptTimer: number | null = null
let clearSpeechDispatchTimer: number | null = null
let spinnerTimer: number | null = null
let waveformFrameIndex = 0
let unsubscribe: (() => void) | null = null
let evenUserInfo: UserPayload | null = null
let startupPromptVisible = true
let backendStartupPrompt = ''
let speechDispatchDisplay: SpeechDispatchDisplay | null = null
let deferredLiveTranscript: { text: string; label: string; detail: string } | null = null
let queuedTranscriptFlushRequested = false
let openFlushedTranscriptDetail = false

const GLASSES_LINE_WIDTH = 52
const GLASSES_MAX_LINES = 7
const GLASSES_TEXT_LIMIT = GLASSES_LINE_WIDTH * GLASSES_MAX_LINES
const TRANSCRIPT_CLEAR_MS = 12_000
const SPEECH_DISPATCH_CLEAR_MS = 2_000
const MIC_WATCHDOG_MS = 3_000
const MIC_WATCHDOG_RESTART_DELAY_MS = 250
const MIC_WATCHDOG_MIN_CHUNKS = 3
const clientSessionId = createClientSessionId()
const SPEECH_WAVEFORM_FRAMES = [
  '  |  ',
  ' ||| ',
  '|||||',
  ' ||| ',
]
const BLANK_LIVE_CONTENT = ' '
const SPINNER_INTERVAL_MS = 650
const HISTORY_TOGGLE_DEBOUNCE_MS = 700
const HISTORY_SCROLL_DEBOUNCE_MS = 350
const SYNTHETIC_TEXT_EVENT_GUARD_MS = 1500
const STATUS_CONTAINER_ID = 1
const STATUS_CONTAINER_NAME = 'audio_status'
const EVENT_CAPTURE_CONTAINER_ID = 2
const EVENT_CAPTURE_CONTAINER_NAME = 'audio_capture'
const CANVAS_WIDTH = 576
const CANVAS_HEIGHT = 288
const CANVAS_PADDING = 0
const CANVAS_BORDER_WIDTH = 0
const HISTORY_VISIBLE_LINES = positiveNumber(import.meta.env.VITE_HISTORY_VISIBLE_LINES, 9)
const HISTORY_WRAP_WIDTH = positiveNumber(import.meta.env.VITE_HISTORY_WRAP_WIDTH, CANVAS_WIDTH)
const TEXT_UPGRADE_LIMIT = 2000
const HISTORY_DUPLICATE_WINDOW_MS = 10_000
// Some host builds normalize ring clicks into source-less text events.
const ALLOW_UNSOURCED_HISTORY_TOGGLE = true
const SUMMARY_TEXT_FIELDS = ['text', 'summary', 'message', 'response'] as const
const DETAIL_TEXT_FIELDS = [
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
] as const
const messageHistory: HistoryEntry[] = []
let lastHistoryToggleInputAt = 0
let lastHistoryScrollInputAt = 0
let statusRenderRevision = 0
let statusRenderQueue: Promise<boolean> = Promise.resolve(true)
const historyNavigator = new HistoryNavigator({
  width: HISTORY_WRAP_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: HISTORY_VISIBLE_LINES,
  scrollOverlapLines: 1,
  maxContentLength: TEXT_UPGRADE_LIMIT,
})
let pendingPeekAgent = ''

function isHistoryMode() {
  return glassesMode !== 'live'
}

function syncHistoryMode() {
  const mode = historyNavigator.currentMode()
  glassesMode = mode === 'detail'
    ? 'history_detail'
    : mode === 'list'
      ? 'history_list'
      : 'live'
}

function setUiStatus(text: string) {
  statusEl.textContent = text
  void renderGlassesStatus()
}

function setStats() {
  statsEl.textContent =
    `${receiverState}, audio ${audioOpen ? 'on' : 'off'}, ${sentChunks} chunks, ${sentBytes} bytes, ${droppedChunks} dropped${lastReceiverClose ? `, last close: ${lastReceiverClose}` : ''}`
}

function launchToken() {
  const params = new URLSearchParams(window.location.search)
  return params.get('t') || params.get('token') || ''
}

function createClientSessionId() {
  if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function withClientConnectionParams(url: string, attempt: number) {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('clientSessionId', clientSessionId)
    parsed.searchParams.set('connectionAttempt', String(attempt))
    return parsed.toString()
  } catch {
    return url
  }
}

function currentSharedSecret() {
  return audioEndpointSettings.token
}

function launchEndpointParam(keys: string[]) {
  const params = new URLSearchParams(window.location.search)
  for (const key of keys) {
    const value = params.get(key)
    if (value) return value.trim()
  }
  return ''
}

function storedValue(key: string) {
  try {
    return window.localStorage.getItem(key)?.trim() || ''
  } catch {
    return ''
  }
}

function storeValue(key: string, value: string) {
  try {
    if (value) {
      window.localStorage.setItem(key, value)
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Ignore storage failures in constrained WebView contexts.
  }
}

async function bridgeStoredValue(key: string) {
  try {
    return (await bridge.getLocalStorage(key))?.trim() || storedValue(key)
  } catch {
    return storedValue(key)
  }
}

async function storeBridgeValue(key: string, value: string) {
  try {
    await bridge.setLocalStorage(key, value)
  } catch {
    // Browser localStorage remains useful in simulator/dev contexts.
  }
  storeValue(key, value)
}

async function readAudioEndpointSettings(): Promise<AudioEndpointSettings> {
  const queryPrivateAddress = launchEndpointParam(['private', 'privateAddress', 'privateIp'])
  const queryPublicAddress = launchEndpointParam(['public', 'publicAddress', 'publicIp'])
  const queryAddress = launchEndpointParam(['address', 'receiver', 'endpoint', 'host'])
  const queryLanAddress = launchEndpointParam(['lan', 'lanAddress', 'lanWs', 'local', 'localWs'])
  const queryWanAddress = launchEndpointParam(['wan', 'wanAddress', 'wanWs', 'public', 'publicWs'])
  const queryToken = launchToken()
  const privateAddress = queryPrivateAddress ||
    queryLanAddress ||
    queryAddress ||
    await bridgeStoredValue(PRIVATE_ADDRESS_STORAGE_KEY) ||
    await bridgeStoredValue(LAN_ENDPOINT_STORAGE_KEY) ||
    await bridgeStoredValue(RECEIVER_ADDRESS_STORAGE_KEY)
  const publicAddress = queryPublicAddress ||
    queryWanAddress ||
    await bridgeStoredValue(PUBLIC_ADDRESS_STORAGE_KEY) ||
    await bridgeStoredValue(WAN_ENDPOINT_STORAGE_KEY)
  const token = await bridgeStoredValue(AUTH_TOKEN_STORAGE_KEY)

  if (queryPrivateAddress || queryPublicAddress || queryAddress || queryLanAddress || queryWanAddress || queryToken) {
    await saveAudioEndpointSettings({ privateAddress, publicAddress, token })
  }

  return { privateAddress, publicAddress, token }
}

async function saveAudioEndpointSettings(settings: AudioEndpointSettings) {
  await Promise.all([
    storeBridgeValue(PRIVATE_ADDRESS_STORAGE_KEY, settings.privateAddress.trim()),
    storeBridgeValue(PUBLIC_ADDRESS_STORAGE_KEY, settings.publicAddress.trim()),
    storeBridgeValue(RECEIVER_ADDRESS_STORAGE_KEY, ''),
    storeBridgeValue(LAN_ENDPOINT_STORAGE_KEY, ''),
    storeBridgeValue(WAN_ENDPOINT_STORAGE_KEY, ''),
    storeBridgeValue(AUTH_TOKEN_STORAGE_KEY, settings.token.trim()),
  ])
}

function setupEndpointForm() {
  const privateParts = splitAddress(audioEndpointSettings.privateAddress)
  const publicParts = splitAddress(audioEndpointSettings.publicAddress)
  if (privateIpEl) privateIpEl.value = privateParts.host
  if (privatePortEl) privatePortEl.value = privateParts.port
  if (publicIpEl) publicIpEl.value = publicParts.host
  if (publicPortEl) publicPortEl.value = publicParts.port
  if (authTokenEl) authTokenEl.value = audioEndpointSettings.token
  updateSetupChecklist()

  for (const input of [privateIpEl, privatePortEl, publicIpEl, publicPortEl]) {
    input?.addEventListener('input', updateSetupChecklist)
  }

  toggleAuthTokenEl?.addEventListener('click', () => {
    if (!authTokenEl) return
    const showing = authTokenEl.type === 'text'
    authTokenEl.type = showing ? 'password' : 'text'
    toggleAuthTokenEl.setAttribute('aria-pressed', String(!showing))
    toggleAuthTokenEl.setAttribute('aria-label', showing ? 'Show secret' : 'Hide secret')
    toggleAuthTokenEl.title = showing ? 'Show secret' : 'Hide secret'
  })

  saveEndpointsEl?.addEventListener('click', () => {
    void saveEndpointForm()
  })
}

async function saveEndpointForm() {
  try {
    audioEndpointSettings = {
      privateAddress: joinAddress(privateIpEl?.value || '', privatePortEl?.value || ''),
      publicAddress: joinAddress(publicIpEl?.value || '', publicPortEl?.value || ''),
      token: authTokenEl?.value.trim() || '',
    }
    setUiStatus('Saving connection settings...')
    await saveAudioEndpointSettings(audioEndpointSettings)
    audioWsEndpoints = buildAudioWsEndpoints(audioEndpointSettings, launchToken())
    audioEndpointIndex = 0
    updateSetupChecklist()
    setUiStatus('Connection settings saved, reconnecting...')
    ws?.close()
    if (!ws) connect()
  } catch (err) {
    console.error(err)
    setUiStatus('Could not save connection settings')
  }
}

async function sharedSecretProof(secret: string, nonce: string) {
  const key = await window.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await window.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(nonce),
  )
  return base64Url(new Uint8Array(signature))
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function displayWsUrl(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has('t')) parsed.searchParams.set('t', '...')
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '...')
    return parsed.toString()
  } catch {
    return url
  }
}

function repoUrl() {
  return ['https:', '', 'github.com', 'aaronrau', 'agent-audio-pipe'].join('/')
}

function repoDisplayUrl() {
  return ['github.com', 'aaronrau', 'agent-audio-pipe'].join('/')
}

function cloneCommand() {
  return ['git clone', repoUrl(), '&& cd agent-audio-pipe && npm start'].join(' ')
}

function formReceiverAddress() {
  return joinAddress(privateIpEl?.value || '', privatePortEl?.value || '') ||
    joinAddress(publicIpEl?.value || '', publicPortEl?.value || '')
}

function updateSetupChecklist() {
  const receiverAddress = formReceiverAddress()
  if (setupReceiverEl) {
    setupReceiverEl.textContent = receiverAddress
      ? `✅ ${receiverAddress}`
      : 'No receiver IP set.'
  }
  if (setupRepoLinkEl) {
    setupRepoLinkEl.href = repoUrl()
    setupRepoLinkEl.textContent = repoDisplayUrl()
  }
  if (setupCommandEl) setupCommandEl.textContent = cloneCommand()

  if (startupPromptVisible) void renderGlassesStatus()
}

function currentAudioEndpoint() {
  return audioWsEndpoints[audioEndpointIndex] ?? null
}

function advanceAudioEndpoint() {
  if (audioWsEndpoints.length <= 1) return
  audioEndpointIndex = (audioEndpointIndex + 1) % audioWsEndpoints.length
}

function stringValue(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeAgentLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function sameAgentLabel(a: string, b: string) {
  return normalizeAgentLabel(a) === normalizeAgentLabel(b)
}

function sanitizeAgentList(value: unknown) {
  if (!Array.isArray(value)) return []
  const agents: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const agent = stringValue(item)
    const key = normalizeAgentLabel(agent)
    if (!agent || seen.has(key)) continue
    seen.add(key)
    agents.push(agent)
  }
  return agents
}

function textFromFields(record: Record<string, unknown>, fields: readonly string[]) {
  for (const field of fields) {
    const text = stringValue(record[field])
    if (text) return text
  }
  return ''
}

function sanitizeUserInfo(value: unknown): UserPayload | null {
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const user: UserPayload = {
    uid: stringValue(record.uid ?? record.userId ?? record.id),
    name: stringValue(record.name ?? record.userName),
    country: stringValue(record.country),
  }

  for (const key of Object.keys(user) as Array<keyof UserPayload>) {
    if (!user[key]) delete user[key]
  }

  return Object.keys(user).length ? user : null
}

async function loadUserInfo() {
  try {
    return sanitizeUserInfo(await bridge.getUserInfo())
  } catch (err) {
    console.warn('getUserInfo failed', err)
    return null
  }
}

function takeTail(text: string, limit: number) {
  if (text.length <= limit) return text
  return text.slice(-limit).replace(/^\S*\s?/, '').trimStart()
}

function sanitizeHistoryEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const detail = normalizeHistoryBlock(textFromFields(record, DETAIL_TEXT_FIELDS))
  const text = normalizeInlineText(textFromFields(record, SUMMARY_TEXT_FIELDS) || detail)
  const receivedAt = Number(record.receivedAt)
  if (!text || !Number.isFinite(receivedAt)) return null

  const entry: HistoryEntry = {
    label: stringValue(record.label) || 'Message',
    text,
    receivedAt,
  }
  if (detail) entry.detail = detail
  return entry
}

function replaceHistory(entries: HistoryEntry[]) {
  messageHistory.splice(
    0,
    messageHistory.length,
    ...entries,
  )
  historyNavigator.replaceEntries(messageHistory)
}

function pushHistory(label: string, text: string, detail = '') {
  const normalized = normalizeInlineText(text)
  if (!normalized) return null
  const now = Date.now()
  let duplicate: HistoryEntry | undefined
  for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
    const entry = messageHistory[index]
    if (now - entry.receivedAt > HISTORY_DUPLICATE_WINDOW_MS) break
    if (entry.label === label && entry.text === normalized) {
      duplicate = entry
      break
    }
  }
  if (duplicate) {
    if (detail && !duplicate.detail) {
      const normalizedDetail = normalizeHistoryBlock(detail)
      if (normalizedDetail) duplicate.detail = normalizedDetail
    }
    return duplicate
  }

  const entry: HistoryEntry = {
    label,
    text: normalized,
    receivedAt: now,
  }
  const normalizedDetail = normalizeHistoryBlock(detail)
  if (normalizedDetail) {
    entry.detail = normalizedDetail
  }

  messageHistory.push(entry)
  historyNavigator.appendEntry(entry)
  return entry
}

async function scrollHistoryWindow(direction: HistoryScrollDirection) {
  const result = historyNavigator.scroll(direction)
  syncHistoryMode()
  const displayContent = historyDisplayContent(result.content)
  const skippedSameFrame = displayContent === lastHistoryRenderedContent
  const rendered = skippedSameFrame
    ? true
    : await renderHistoryContent(result.content)

  sendControlDebug({
    type: 'history_debug',
    action: result.action,
    mode: glassesMode,
    direction: direction > 0 ? 'newer' : 'older',
    skippedSameFrame,
    rendered,
    ...navigatorDebugPayload(result.debug),
  })

  if (!rendered) {
    requestHistoryWindowUpdate()
  }
}

function currentLiveGlassesContent() {
  if (startupPromptVisible && backendStartupPrompt) {
    return backendStartupPromptContent(backendStartupPrompt)
  }
  if (startupPromptVisible) return startupLiveContent(audioEndpointSettings)
  if (speechDispatchDisplay) {
    return formatGlassesTranscript(formatSpeechDispatchDisplay(speechDispatchDisplay))
  }
  if (speechDetected) return currentSpeechWaveformFrame()
  if (transcriptText) return formatGlassesTranscript(transcriptText)
  if (backendIdleFrame) return backendIdleFrame
  return BLANK_LIVE_CONTENT
}

function currentSpeechWaveformFrame() {
  return SPEECH_WAVEFORM_FRAMES[waveformFrameIndex % SPEECH_WAVEFORM_FRAMES.length]
}

function isSpeechProcessingActive() {
  return speechDetected
}

function makeStatusContainer(content: string, _isHistory: boolean) {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    borderWidth: CANVAS_BORDER_WIDTH,
    borderColor: 15,
    borderRadius: 0,
    paddingLength: CANVAS_PADDING,
    containerID: STATUS_CONTAINER_ID,
    containerName: STATUS_CONTAINER_NAME,
    content,
    isEventCapture: 0,
  })
}

function makeEventCaptureContainer() {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 1,
    height: 1,
    borderWidth: 0,
    borderColor: 15,
    borderRadius: 0,
    paddingLength: 0,
    containerID: EVENT_CAPTURE_CONTAINER_ID,
    containerName: EVENT_CAPTURE_CONTAINER_NAME,
    content: '',
    isEventCapture: 1,
  })
}

function requestHistoryWindowUpdate() {
  if (!isHistoryMode()) return
  historyUpdatePending = true
  void flushHistoryWindowUpdate()
}

function cancelPendingStatusRender() {
  statusRenderRevision += 1
  pendingStatusContainerContent = ''
}

function requestMessageHistory(reason: string) {
  if (ws?.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({
    type: 'get_message_history',
    reason,
  }))
}

function requestQueuedTranscriptFlush() {
  if (queuedTranscriptFlushRequested) return true
  if (ws?.readyState !== WebSocket.OPEN) {
    setUiStatus('Receiver disconnected')
    return false
  }

  queuedTranscriptFlushRequested = true
  ws.send(JSON.stringify({ type: 'flush_transcript_queue' }))
  setUiStatus('Saving queued transcript...')
  return true
}

function requestPeekProgress(agent: string) {
  if (ws?.readyState !== WebSocket.OPEN) {
    setUiStatus('Receiver disconnected')
    return
  }

  pendingPeekAgent = agent
  ws.send(JSON.stringify({
    type: 'peek_progress',
    agent,
  }))
  setUiStatus(`Checking ${agent} progress...`)
}

function updateWorkbenchProgressAgents(payload: Record<string, unknown>) {
  const workbench = payload.workbench
  if (!workbench || typeof workbench !== 'object') return

  const record = workbench as Record<string, unknown>
  const agents = record.enabled === false ? [] : sanitizeAgentList(record.activeAgents)
  historyNavigator.replaceProgressAgents(agents)
  requestHistoryWindowUpdate()
}

function renderPeekProgressDetail(agent: string) {
  if (!isHistoryMode()) return

  const result = historyNavigator.openLatestDetailForAgent(agent)
  syncHistoryMode()
  const content = result.action === 'opened_detail'
    ? result.content
    : historyNavigator.content()

  void renderHistoryContent(content).then(rendered => {
    if (!rendered) {
      requestHistoryWindowUpdate()
      return
    }

    sendControlDebug({
      type: 'history_debug',
      action: result.action === 'opened_detail' ? result.action : 'opened_detail',
      mode: glassesMode,
      ...navigatorDebugPayload(historyNavigator.debug(content)),
    })
  })
}

function sendControlDebug(payload: Record<string, unknown>) {
  void payload
}

function navigatorDebugPayload(debug: ReturnType<HistoryNavigator['debug']>) {
  const { mode, ...rest } = debug
  return {
    navigatorMode: mode,
    ...rest,
  }
}

function historyDisplayContent(content = historyNavigator.content()) {
  const lines = content ? content.split('\n') : ['']
  while (lines.length < HISTORY_VISIBLE_LINES) {
    lines.push('')
  }
  return lines.slice(0, HISTORY_VISIBLE_LINES).join('\n')
}

async function renderHistoryContent(content = historyNavigator.content()) {
  const displayContent = historyDisplayContent(content)
  lastHistoryRequestedContent = displayContent

  const rendered = await upgradeStatusContainer(displayContent)
  if (rendered && lastHistoryRequestedContent === displayContent) {
    lastHistoryRenderedContent = displayContent
  }

  return rendered
}

function upgradeStatusContainer(content: string) {
  if (receiverStandby) return Promise.resolve(true)

  const safeContent = content.slice(0, TEXT_UPGRADE_LIMIT)
  if (safeContent === pendingStatusContainerContent) return statusRenderQueue
  if (!pendingStatusContainerContent && safeContent === lastStatusContainerContent) {
    return Promise.resolve(true)
  }

  const revision = ++statusRenderRevision
  pendingStatusContainerContent = safeContent

  statusRenderQueue = statusRenderQueue
    .catch(() => false)
    .then(async () => {
      if (revision !== statusRenderRevision) {
        if (pendingStatusContainerContent === safeContent) pendingStatusContainerContent = ''
        return true
      }
      lastStatusContainerUpgradeAt = Date.now()
      const rendered = await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: STATUS_CONTAINER_ID,
          containerName: STATUS_CONTAINER_NAME,
          contentOffset: 0,
          contentLength: 0,
          content: safeContent,
        }),
      )
      if (rendered) lastStatusContainerContent = safeContent
      if (pendingStatusContainerContent === safeContent) pendingStatusContainerContent = ''
      return rendered
    })

  return statusRenderQueue
}

async function flushHistoryWindowUpdate() {
  if (
    historyUpdateInFlight ||
    historyTransitioning ||
    !historyUpdatePending ||
    !isHistoryMode()
  ) {
    return
  }

  historyUpdateInFlight = true

  try {
    while (historyUpdatePending && isHistoryMode() && !historyTransitioning) {
      historyUpdatePending = false
      await renderHistoryContent()
    }
  } finally {
    historyUpdateInFlight = false
    if (historyUpdatePending && isHistoryMode() && !historyTransitioning) {
      void flushHistoryWindowUpdate()
    }
  }
}

async function showHistoryWindow() {
  cancelPendingStatusRender()
  clearLiveTranscriptDisplay()
  const previousMode = glassesMode
  const result = historyNavigator.open()
  syncHistoryMode()
  requestMessageHistory('open_history')
  const rendered = await renderHistoryContent(result.content)

  if (rendered) {
    sendControlDebug({
      type: 'history_debug',
      action: result.action,
      mode: glassesMode,
      ...navigatorDebugPayload(result.debug),
    })
    return
  }

  glassesMode = previousMode
  historyNavigator.close()
  sendControlDebug({
    type: 'history_debug',
    action: 'open_failed',
    mode: glassesMode,
  })
  setUiStatus('History view failed')
}

async function closeHistoryWindow() {
  const previousMode = glassesMode
  historyNavigator.close()
  glassesMode = 'live'

  const rendered = await upgradeStatusContainer(currentLiveGlassesContent())

  if (rendered) {
    sendControlDebug({
      type: 'history_debug',
      action: 'closed',
      mode: glassesMode,
    })
    lastHistoryRequestedContent = ''
    lastHistoryRenderedContent = ''
    return
  }

  glassesMode = previousMode
  syncHistoryMode()
  requestHistoryWindowUpdate()
  sendControlDebug({
    type: 'history_debug',
    action: 'close_failed',
    mode: glassesMode,
  })
  console.warn('Failed to close history view')
}

async function handleHistoryTap() {
  if (historyTransitioning) return
  historyTransitioning = true

  try {
    const queuedBackSelected = speechDispatchDisplay?.state === 'queued' && (
      !isHistoryMode() || historyNavigator.debug().selectedRow === 0
    )
    if (queuedBackSelected) {
      if (!requestQueuedTranscriptFlush()) return
      openFlushedTranscriptDetail = true
      if (!isHistoryMode()) await showHistoryWindow()
      return
    }

    if (!isHistoryMode()) {
      await showHistoryWindow()
      return
    }

    const result = historyNavigator.tap()
    syncHistoryMode()
    const content = isHistoryMode()
      ? result.content
      : currentLiveGlassesContent()
    const rendered = isHistoryMode()
      ? await renderHistoryContent(content)
      : await upgradeStatusContainer(content)

    if (rendered) {
      if (!isHistoryMode()) {
        lastHistoryRequestedContent = ''
        lastHistoryRenderedContent = ''
      }
      sendControlDebug({
        type: 'history_debug',
        action: result.action,
        mode: glassesMode,
        ...navigatorDebugPayload(result.debug),
      })
      if (result.action === 'peek_progress' && result.agent) {
        requestPeekProgress(result.agent)
      }
    } else {
      sendControlDebug({
        type: 'history_debug',
        action: 'tap_render_failed',
        mode: glassesMode,
        ...navigatorDebugPayload(result.debug),
      })
      setUiStatus('History view failed')
    }
  } catch (err) {
    console.error('History view tap failed', err)
    setUiStatus('History view failed')
  } finally {
    historyTransitioning = false
    if (isHistoryMode()) {
      void flushHistoryWindowUpdate()
    }
  }
}

function clearSpeechProcessingState() {
  speechDetected = false
  waveformFrameIndex = 0
  clearSpeechDispatchDisplay()
  queuedTranscriptFlushRequested = false
  openFlushedTranscriptDetail = false
  clearLiveTranscriptDisplay()
  historyNavigator.clearPendingTranscript()
  requestHistoryWindowUpdate()
}

function clearLiveTranscriptDisplay() {
  transcriptText = ''
  transcriptEl.textContent = 'Listening...'
  if (clearTranscriptTimer !== null) {
    window.clearTimeout(clearTranscriptTimer)
    clearTranscriptTimer = null
  }
}

function clearSpeechDispatchDisplay() {
  speechDispatchDisplay = null
  deferredLiveTranscript = null
  if (clearSpeechDispatchTimer !== null) {
    window.clearTimeout(clearSpeechDispatchTimer)
    clearSpeechDispatchTimer = null
  }
}

function stopSpeechProcessingIndicator(options: { clearPending?: boolean } = {}) {
  speechDetected = false
  waveformFrameIndex = 0
  if (options.clearPending !== false) {
    historyNavigator.clearPendingTranscript()
  }
  requestHistoryWindowUpdate()
}

function startSpeechProcessingState() {
  if (!isSpeechProcessingActive()) waveformFrameIndex = 0
  speechDetected = true
}

function dismissStartupPrompt() {
  startupPromptVisible = nextStartupPromptVisible(startupPromptVisible, {
    type: 'asr_status',
    status: 'vad_detected',
  })
}

function appendTranscript(
  text: string,
  label = 'Message',
  detail = '',
  options: { clearProcessing?: boolean } = {},
) {
  const normalized = normalizeInlineText(text)
  if (!normalized) return

  if (options.clearProcessing !== false) {
    clearSpeechProcessingState()
  }
  pushHistory(label, normalized, detail)
  showLiveTranscript(normalized)
}

function showLiveTranscript(text: string) {
  const normalized = normalizeInlineText(text)
  if (!normalized) return

  transcriptText = takeTail(normalized, GLASSES_TEXT_LIMIT)
  transcriptEl.textContent = transcriptText
  scheduleTranscriptClear()
  if (isHistoryMode()) {
    requestHistoryWindowUpdate()
  } else {
    void renderGlassesStatus()
  }
}

function setQueuedSpeechDisplay(text: string) {
  const queuedText = normalizeSpeechDispatchText(text)
  if (!queuedText) return
  if (speechDispatchDisplay?.state === 'queued' && speechDispatchDisplay.text === queuedText) return

  speechDetected = false
  waveformFrameIndex = 0
  deferredLiveTranscript = null
  clearLiveTranscriptDisplay()
  if (clearSpeechDispatchTimer !== null) {
    window.clearTimeout(clearSpeechDispatchTimer)
    clearSpeechDispatchTimer = null
  }
  speechDispatchDisplay = {
    state: 'queued',
    text: queuedText,
  }
  queuedTranscriptFlushRequested = false
  historyNavigator.setPendingTranscript(queuedText)
  transcriptEl.textContent = formatSpeechDispatchDisplay(speechDispatchDisplay)
  requestHistoryWindowUpdate()
  if (!isHistoryMode()) void renderGlassesStatus()
}

function setTerminalSpeechDisplay(display: SpeechDispatchDisplay) {
  const normalizedText = normalizeSpeechDispatchText(display.text)
  const normalizedMessage = normalizeSpeechDispatchText(display.message || '')
  const normalizedAgent = normalizeSpeechDispatchText(display.agent || '')
  speechDetected = false
  waveformFrameIndex = 0
  speechDispatchDisplay = {
    ...display,
    text: normalizedText,
    message: normalizedMessage,
    agent: normalizedAgent,
  }
  queuedTranscriptFlushRequested = false
  clearLiveTranscriptDisplay()
  historyNavigator.clearPendingTranscript()
  transcriptEl.textContent = formatSpeechDispatchDisplay(speechDispatchDisplay)
  requestHistoryWindowUpdate()
  if (!isHistoryMode()) void renderGlassesStatus()

  if (clearSpeechDispatchTimer !== null) {
    window.clearTimeout(clearSpeechDispatchTimer)
  }

  clearSpeechDispatchTimer = window.setTimeout(() => {
    clearSpeechDispatchTimer = null
    speechDispatchDisplay = null
    transcriptEl.textContent = 'Listening...'
    const deferred = deferredLiveTranscript
    deferredLiveTranscript = null

    if (deferred) {
      showLiveTranscript(deferred.text)
      return
    }

    void renderGlassesStatus()
  }, SPEECH_DISPATCH_CLEAR_MS)
}

function isTerminalSpeechDisplayActive() {
  return clearSpeechDispatchTimer !== null && speechDispatchDisplay !== null
}

function currentSpeechDispatchText() {
  return speechDispatchDisplay?.text || lastTranscriptEventText || transcriptText
}

function formatGlassesTranscript(text: string) {
  const words = takeTail(text.replace(/\s+/g, ' ').trim(), GLASSES_TEXT_LIMIT)
    .split(' ')
    .filter(Boolean)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const nextLine = line ? `${line} ${word}` : word
    if (nextLine.length <= GLASSES_LINE_WIDTH) {
      line = nextLine
      continue
    }

    if (line) lines.push(line)
    line = word
  }

  if (line) lines.push(line)
  return lines.slice(-GLASSES_MAX_LINES).join('\n')
}

function scheduleTranscriptClear() {
  if (clearTranscriptTimer !== null) {
    window.clearTimeout(clearTranscriptTimer)
  }

  clearTranscriptTimer = window.setTimeout(() => {
    clearTranscriptTimer = null
    transcriptText = ''
    transcriptEl.textContent = 'Listening...'
    void renderGlassesStatus()
  }, TRANSCRIPT_CLEAR_MS)
}

function startIdleSpinner() {
  if (spinnerTimer !== null) return

  spinnerTimer = window.setInterval(() => {
    if (!speechDetected) return

    waveformFrameIndex = (waveformFrameIndex + 1) % SPEECH_WAVEFORM_FRAMES.length
    void renderGlassesStatus()
  }, SPINNER_INTERVAL_MS)
}

function handleReceiverMessage(socket: WebSocket, raw: string) {
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }

  if (!message || typeof message !== 'object') return
  const payload = message as Record<string, unknown>

  if (payload.type === 'auth_challenge' && typeof payload.nonce === 'string') {
    void answerAuthChallenge(socket, payload.nonce)
    return
  }

  if (payload.type === 'message_history' && Array.isArray(payload.entries)) {
    const entries = payload.entries
      .map(sanitizeHistoryEntry)
      .filter((entry): entry is HistoryEntry => entry !== null)
    replaceHistory(entries)
    sendControlDebug({
      type: 'history_debug',
      action: 'loaded_history',
      count: entries.length,
      mode: glassesMode,
    })
    requestHistoryWindowUpdate()
    return
  }

  if (payload.type === 'onboarding_prompt' && typeof payload.message === 'string') {
    backendStartupPrompt = payload.message
    setUiStatus(payload.message)
    void renderGlassesStatus()
    return
  }

  if (payload.type === 'transcript' && typeof payload.text === 'string') {
    stopSpeechProcessingIndicator({ clearPending: false })
    const normalized = normalizeInlineText(payload.text)
    if (normalized) {
      lastTranscriptEventText = normalized
      pushHistory('You', normalized)
      transcriptEl.textContent = speechDispatchDisplay
        ? formatSpeechDispatchDisplay(speechDispatchDisplay)
        : normalized
      if (!speechDispatchDisplay) showLiveTranscript(normalized)
    }
    queuedTranscriptFlushRequested = false
    if (openFlushedTranscriptDetail && isHistoryMode()) {
      openFlushedTranscriptDetail = false
      const result = historyNavigator.openLatestTranscriptDetail()
      syncHistoryMode()
      void renderHistoryContent(result.content)
    } else {
      requestHistoryWindowUpdate()
    }
    setUiStatus('Transcript saved')
    return
  }

  if (payload.type === 'agent_summary') {
    const detail = normalizeHistoryBlock(textFromFields(payload, DETAIL_TEXT_FIELDS))
    const summary = normalizeInlineText(textFromFields(payload, SUMMARY_TEXT_FIELDS) || detail)
    if (!summary) return

    const agent = typeof payload.agent === 'string' && payload.agent
      ? payload.agent
      : 'Agent'
    const shouldOpenPeekDetail = Boolean(
      pendingPeekAgent && sameAgentLabel(agent, pendingPeekAgent),
    )
    if (pendingPeekAgent && sameAgentLabel(agent, pendingPeekAgent)) {
      pendingPeekAgent = ''
    }
    if (shouldOpenPeekDetail) {
      speechDetected = false
      waveformFrameIndex = 0
      clearSpeechDispatchDisplay()
      clearLiveTranscriptDisplay()
      historyNavigator.clearPendingTranscript()
      pushHistory(agent, summary, detail)
      renderPeekProgressDetail(agent)
      statusEl.textContent = 'Agent summary received'
      return
    }
    if (isTerminalSpeechDisplayActive()) {
      pushHistory(agent, summary, detail)
      deferredLiveTranscript = { text: summary, label: agent, detail }
      requestHistoryWindowUpdate()
      setUiStatus('Agent summary received')
      return
    }
    appendTranscript(summary, agent, detail)
    setUiStatus('Agent summary received')
    return
  }

  if (payload.type === 'receiver_idle' && typeof payload.frame === 'string') {
    backendIdleFrame = payload.frame
    if (historyTransitioning || isHistoryMode()) {
      requestHistoryWindowUpdate()
      return
    }
    if (!historyTransitioning && !isHistoryMode() && !startupPromptVisible && !speechDetected && !speechDispatchDisplay && !transcriptText) {
      void renderGlassesStatus()
    }
    return
  }

  if (payload.type === 'agent_status' && payload.status === 'sending') {
    setUiStatus(payload.requestType === 'local'
      ? 'Checking agent progress...'
      : 'Sending to workbench...')
    return
  }

  if (payload.type === 'agent_status' && payload.status === 'sent') {
    if (payload.requestType !== 'local') {
      const message = stringValue(payload.message) || currentSpeechDispatchText()
      setTerminalSpeechDisplay({
        state: 'sent',
        text: message,
        message,
        agent: stringValue(payload.agent),
      })
    }
    setUiStatus(payload.requestType === 'local'
      ? 'Waiting for progress summary...'
      : 'Waiting for agent summary...')
    return
  }

  if (payload.type === 'agent_status' && payload.status === 'agent_armed') {
    const agent = typeof payload.agent === 'string' && payload.agent
      ? payload.agent
      : 'agent'
    setTerminalSpeechDisplay({
      state: 'saved',
      text: currentSpeechDispatchText() || `${agent} selected`,
    })
    setUiStatus(`${agent} selected`)
    return
  }

  if (
    payload.type === 'agent_status' &&
    (
      payload.status === 'missing_agent_prefix' ||
      payload.status === 'empty_transcript' ||
      payload.status === 'workbench_disabled' ||
      payload.status === 'workbench_unconfigured'
    )
  ) {
    if (payload.requestType === 'local') {
      pendingPeekAgent = ''
      setUiStatus('Listening for speech...')
    } else if (payload.status !== 'empty_transcript') {
      setTerminalSpeechDisplay({
        state: 'saved',
        text: currentSpeechDispatchText(),
      })
      setUiStatus('Transcript saved')
    } else {
      stopSpeechProcessingIndicator()
      setUiStatus('Listening for speech...')
    }
    return
  }

  if (payload.type === 'agent_error') {
    const error = typeof payload.error === 'string' ? payload.error : 'Workbench error'
    if (
      payload.requestType === 'local' &&
      typeof payload.agent === 'string' &&
      sameAgentLabel(payload.agent, pendingPeekAgent)
    ) {
      pendingPeekAgent = ''
      pushHistory('Error', error)
      requestHistoryWindowUpdate()
      setUiStatus('Workbench error')
      return
    }
    clearSpeechProcessingState()
    appendTranscript(error, 'Error')
    setUiStatus('Workbench error')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'transcribing') {
    startSpeechProcessingState()
    setUiStatus('Transcribing speech...')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'vad_detected') {
    dismissStartupPrompt()
    startSpeechProcessingState()
    void renderGlassesStatus()
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'queued') {
    setQueuedSpeechDisplay(stringValue(payload.queuedText || payload.text))
    setUiStatus('Waiting for more speech...')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'cleaning') {
    speechDetected = false
    waveformFrameIndex = 0
    requestHistoryWindowUpdate()
    setUiStatus('Cleaning transcript...')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'no_transcript') {
    clearSpeechProcessingState()
    setUiStatus('Listening for speech...')
    return
  }

  if (payload.type === 'receiver_status') {
    updateWorkbenchProgressAgents(payload)
    if (payload.status === 'standby') {
      receiverStandby = true
      cancelPendingStatusRender()
      statusEl.textContent = 'Receiver standby'
      return
    }
    if (payload.status === 'active') {
      const wasStandby = receiverStandby
      receiverStandby = false
      if (wasStandby) lastStatusContainerContent = ''
      if (isHistoryMode()) requestHistoryWindowUpdate()
      else void renderGlassesStatus()
      setUiStatus('Receiver connected')
      return
    }
    if (payload.status === 'retry_listen') {
      clearSpeechProcessingState()
      setUiStatus('Retrying audio listener...')
      if (socket === ws && socket.readyState === WebSocket.OPEN) {
        socket.close(4004, 'receiver requested retry listen')
      }
      return
    }
    setUiStatus(payload.status === 'auth_required'
      ? 'Authenticating receiver...'
      : 'Receiver connected')
    return
  }

  if (payload.type === 'workbench_status') {
    updateWorkbenchProgressAgents(payload)
    return
  }

  if (payload.type === 'auth_status') {
    if (payload.status === 'accepted') {
      if (typeof payload.standby === 'boolean') {
        const wasStandby = receiverStandby
        receiverStandby = payload.standby
        if (receiverStandby) cancelPendingStatusRender()
        else if (wasStandby) {
          lastStatusContainerContent = ''
          if (isHistoryMode()) requestHistoryWindowUpdate()
          else void renderGlassesStatus()
        }
      }
      void startAudioStream(socket)
    } else if (payload.status === 'rejected') {
      setUiStatus('Authentication rejected')
    }
    return
  }
}

async function answerAuthChallenge(socket: WebSocket, nonce: string) {
  const secret = currentSharedSecret()
  if (!secret) {
    setUiStatus('Missing shared secret')
    return
  }

  if (socket !== ws || socket.readyState !== WebSocket.OPEN) return

  try {
    const proof = await sharedSecretProof(secret, nonce)
    if (socket !== ws || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({
      type: 'auth',
      nonce,
      proof,
      algorithm: 'hmac-sha256',
    }))
  } catch (err) {
    setUiStatus('Could not hash shared secret')
    console.error(err)
  }
}

function normalizePcm(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return new Uint8Array(value)
  return null
}

function getEventType(event: EvenHubEvent) {
  return event.sysEvent?.eventType
    ?? event.textEvent?.eventType
    ?? event.listEvent?.eventType
}

function eventSourceFromValue(value: unknown): EventSourceType | null {
  if (value === null || value === undefined) return null

  const parsed = EventSourceType.fromJson(value)
  if (parsed !== undefined) return parsed

  if (typeof value !== 'string') return null

  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === '2' || normalized.includes('ring')) {
    return EventSourceType.TOUCH_EVENT_FROM_RING
  }

  return null
}

function rawEventSource(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  return record.eventSource
    ?? record.EventSource
    ?? record.Event_Source
    ?? record.source
    ?? record.Source
}

function getEventSource(event: EvenHubEvent): EventSourceType | null {
  const jsonData = event.jsonData as Record<string, unknown> | undefined
  const nestedData = jsonData?.data ?? jsonData?.jsonData
  const candidates = [
    event.sysEvent?.eventSource,
    rawEventSource(jsonData),
    rawEventSource(nestedData),
  ]

  for (const candidate of candidates) {
    const source = eventSourceFromValue(candidate)
    if (source !== null) return source
  }

  return null
}

function isSinglePress(event: EvenHubEvent) {
  const type = getEventType(event)
  if (type === OsEventTypeList.CLICK_EVENT) return true

  if (type !== undefined) return false

  const source = getEventSource(event)
  if (source === EventSourceType.TOUCH_EVENT_FROM_RING) return true

  return !!event.textEvent
}

function isHistoryToggleInput(event: EvenHubEvent) {
  if (!isSinglePress(event)) return false

  const source = getEventSource(event)
  if (source === EventSourceType.TOUCH_EVENT_FROM_RING) return true

  return source === null && ALLOW_UNSOURCED_HISTORY_TOGGLE
}

function isSourceLessTextToggle(event: EvenHubEvent) {
  return !!event.textEvent && getEventSource(event) === null
}

function shouldHandleHistoryToggle(event: EvenHubEvent) {
  if (!isHistoryToggleInput(event)) return false

  const now = Date.now()
  if (
    glassesMode === 'history_detail' &&
    isSourceLessTextToggle(event) &&
    now - lastStatusContainerUpgradeAt < SYNTHETIC_TEXT_EVENT_GUARD_MS
  ) {
    sendControlDebug({
      type: 'history_debug',
      action: 'ignored_synthetic_detail_toggle',
      mode: glassesMode,
    })
    return false
  }

  const sinceLastToggle = now - lastHistoryToggleInputAt
  if (sinceLastToggle < HISTORY_TOGGLE_DEBOUNCE_MS) {
    sendControlDebug({
      type: 'history_debug',
      action: 'ignored_duplicate',
      mode: glassesMode,
      sinceLastToggle,
    })
    return false
  }

  lastHistoryToggleInputAt = now
  sendControlDebug({
    type: 'history_debug',
    action: 'accepted_toggle',
    fromMode: glassesMode,
  })
  return true
}

function historyScrollDirection(event: EvenHubEvent): HistoryScrollDirection | null {
  if (!isHistoryMode()) return null
  if (isHistoryToggleInput(event)) return null

  return historyScrollDirectionFromEventType(getEventType(event))
}

function shouldHandleHistoryScroll(event: EvenHubEvent): HistoryScrollDirection | null {
  const direction = historyScrollDirection(event)
  if (direction === null) return null

  const now = Date.now()
  const sinceLastScroll = now - lastHistoryScrollInputAt
  if (sinceLastScroll < HISTORY_SCROLL_DEBOUNCE_MS) {
    sendControlDebug({
      type: 'history_debug',
      action: 'ignored_scroll_duplicate',
      mode: glassesMode,
      sinceLastScroll,
    })
    return null
  }

  lastHistoryScrollInputAt = now
  return direction
}

function logInputEvent(event: EvenHubEvent) {
  void event
}

const bridge = await waitForEvenAppBridge()
audioEndpointSettings = await readAudioEndpointSettings()
audioWsEndpoints = buildAudioWsEndpoints(audioEndpointSettings, launchToken())
evenUserInfo = await loadUserInfo()

const statusContainer = makeStatusContainer(currentLiveGlassesContent(), false)
const eventCaptureContainer = makeEventCaptureContainer()

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [statusContainer, eventCaptureContainer],
  }),
)

if (created !== 0) {
  setUiStatus(`Startup page failed: ${created}`)
  throw new Error(`createStartUpPageContainer failed: ${created}`)
}
lastStatusContainerContent = currentLiveGlassesContent().slice(0, TEXT_UPGRADE_LIMIT)

async function startAudioStream(socket: WebSocket) {
  if (socket !== ws || socket.readyState !== WebSocket.OPEN || startedAudioSockets.has(socket)) return
  startedAudioSockets.add(socket)
  const endpoint = currentAudioEndpoint()
  const attempt = socketConnectionAttempts.get(socket) || 0
  const startMessage: Record<string, unknown> = {
    type: 'start',
    source: 'g2',
    encoding: 'pcm_s16le',
    sampleRate: 16000,
    channels: 1,
    clientSessionId,
    connectionAttempt: attempt,
  }

  if (evenUserInfo) {
    startMessage.user = evenUserInfo
  }

  socket.send(JSON.stringify(startMessage))
  scheduleMicWatchdog(socket, { baselineChunks: sentChunks, restarted: false })
  await setAudio(true)
  if (!backendStartupPrompt) {
    setUiStatus(`Streaming G2 mic audio${endpoint ? ` via ${endpoint.label}` : ''}`)
  }
}

async function renderGlassesStatus() {
  if (historyTransitioning || glassesMode !== 'live') return

  await upgradeStatusContainer(currentLiveGlassesContent())
}

async function setAudio(open: boolean) {
  if (audioOpen === open) return
  audioOpen = open
  setStats()
  try {
    await audioControlWithTimeout(open)
  } catch (err) {
    audioOpen = !open
    setStats()
    setUiStatus(`audioControl(${String(open)}) failed`)
    console.error(err)
  }
}

function stopAudioForReconnect() {
  audioOpen = false
  setStats()
  void audioControlWithTimeout(false).catch(err => {
    console.warn('audioControl(false) during reconnect failed')
    console.error(err)
  })
}

function audioControlWithTimeout(open: boolean) {
  return withTimeout(
    bridge.audioControl(open),
    AUDIO_CONTROL_TIMEOUT_MS,
    `audioControl(${String(open)})`,
  )
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timer: number | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) window.clearTimeout(timer)
  })
}

function delayMs(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

async function restartAudioControl(reason: string) {
  console.warn(`Restarting G2 audio: ${reason}`)
  setUiStatus('Restarting mic audio...')
  try {
    audioOpen = false
    setStats()
    await audioControlWithTimeout(false)
    await delayMs(MIC_WATCHDOG_RESTART_DELAY_MS)
    audioOpen = true
    setStats()
    await audioControlWithTimeout(true)
  } catch (err) {
    audioOpen = false
    setStats()
    setUiStatus('Mic restart failed')
    console.error(err)
  }
}

function clearMicWatchdog(socket?: WebSocket) {
  if (socket && micWatchdogSocket && socket !== micWatchdogSocket) return
  if (micWatchdogTimer !== null) window.clearTimeout(micWatchdogTimer)
  micWatchdogTimer = null
  micWatchdogSocket = null
}

function scheduleMicWatchdog(socket: WebSocket, state: { baselineChunks: number; restarted: boolean }) {
  if (socket !== ws || socket.readyState !== WebSocket.OPEN) return
  micWatchdogState.set(socket, state)
  clearMicWatchdog()
  micWatchdogSocket = socket
  micWatchdogTimer = window.setTimeout(() => {
    micWatchdogTimer = null
    micWatchdogSocket = null
    void checkMicWatchdog(socket)
  }, MIC_WATCHDOG_MS)
}

async function checkMicWatchdog(socket: WebSocket) {
  const state = micWatchdogState.get(socket)
  if (!state || socket !== ws || socket.readyState !== WebSocket.OPEN) return

  const newChunks = sentChunks - state.baselineChunks
  if (newChunks >= MIC_WATCHDOG_MIN_CHUNKS) return

  if (!state.restarted) {
    await restartAudioControl(`only ${newChunks} chunk(s) after websocket start`)
    if (socket === ws && socket.readyState === WebSocket.OPEN) {
      scheduleMicWatchdog(socket, { baselineChunks: sentChunks, restarted: true })
    }
    return
  }

  setUiStatus('Mic audio stalled, reconnecting...')
  socket.close(4003, 'mic audio not flowing')
}

function markAudioChunkSent(socket: WebSocket, byteLength: number) {
  sentChunks += 1
  sentBytes += byteLength
  const state = micWatchdogState.get(socket)
  if (state && sentChunks - state.baselineChunks >= MIC_WATCHDOG_MIN_CHUNKS) {
    clearMicWatchdog(socket)
  }
}

function scheduleReconnect() {
  if (cleanedUp || reconnectTimer !== null || audioWsEndpoints.length === 0) return
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 1500)
}

function connect() {
  const endpoint = currentAudioEndpoint()
  if (!endpoint) {
    setUiStatus('Missing audio WebSocket URL')
    return
  }

  urlEl.textContent = `${endpoint.label}: ${displayWsUrl(endpoint.url)}`
  setUiStatus(`Connecting to ${endpoint.label} receiver...`)
  receiverState = 'connecting'
  backendIdleFrame = ''
  setStats()
  const attempt = connectionAttempt + 1
  connectionAttempt = attempt
  const socketUrl = withClientConnectionParams(endpoint.url, attempt)
  const connectingSocket = new WebSocket(socketUrl)
  ws = connectingSocket
  socketConnectionAttempts.set(connectingSocket, attempt)
  connectingSocket.binaryType = 'arraybuffer'
  let opened = false
  let connectTimedOut = false
  const connectTimeout = window.setTimeout(() => {
    if (opened || ws !== connectingSocket) return
    connectTimedOut = true
    setUiStatus(`${endpoint.label} receiver timed out`)
    connectingSocket.close()
  }, CONNECT_TIMEOUT_MS)

  connectingSocket.addEventListener('open', async () => {
    window.clearTimeout(connectTimeout)
    if (ws !== connectingSocket) {
      connectingSocket.close()
      return
    }
    opened = true
    receiverState = 'open'
    lastReceiverClose = ''
    setStats()
    if (currentSharedSecret()) {
      setUiStatus(`Authenticating ${endpoint.label} receiver...`)
      return
    }
    await startAudioStream(connectingSocket)
  })

  connectingSocket.addEventListener('message', event => {
    if (ws !== connectingSocket) return
    if (typeof event.data === 'string') {
      handleReceiverMessage(connectingSocket, event.data)
    }
  })

  connectingSocket.addEventListener('close', async event => {
    window.clearTimeout(connectTimeout)
    if (ws !== connectingSocket) return
    ws = null
    clearMicWatchdog(connectingSocket)
    receiverState = 'closed'
    backendIdleFrame = ''
    lastReceiverClose = `${event.code}${event.reason ? ` ${event.reason}` : ''}${event.wasClean ? ' clean' : ' unclean'}`
    setStats()
    clearSpeechProcessingState()
    stopAudioForReconnect()
    if (!cleanedUp) {
      if (opened) {
        audioEndpointIndex = 0
      } else {
        advanceAudioEndpoint()
      }
      const nextEndpoint = currentAudioEndpoint()
      setUiStatus(nextEndpoint
        ? `${connectTimedOut ? 'Receiver timed out' : 'Receiver disconnected'}, trying ${nextEndpoint.label}...`
        : 'Receiver disconnected, retrying...')
      scheduleReconnect()
    }
  })

  connectingSocket.addEventListener('error', () => {
    window.clearTimeout(connectTimeout)
    if (ws !== connectingSocket) return
    receiverState = 'error'
    backendIdleFrame = ''
    setStats()
    speechDetected = false
    setUiStatus(`${endpoint.label} receiver connection error`)
  })
}

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  backendIdleFrame = ''
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
  if (clearTranscriptTimer !== null) window.clearTimeout(clearTranscriptTimer)
  if (spinnerTimer !== null) window.clearInterval(spinnerTimer)
  clearMicWatchdog()
  reconnectTimer = null
  clearTranscriptTimer = null
  spinnerTimer = null
  void setAudio(false)
  ws?.close()
  ws = null
  unsubscribe?.()
  unsubscribe = null
}

unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = normalizePcm(event.audioEvent?.audioPcm)
  if (pcm) {
    const currentSocket = ws
    if (currentSocket?.readyState === WebSocket.OPEN && startedAudioSockets.has(currentSocket)) {
      currentSocket.send(pcm)
      markAudioChunkSent(currentSocket, pcm.byteLength)
      if (sentChunks % 10 === 0) {
        setStats()
      }
    } else {
      droppedChunks += 1
      setStats()
    }
  }

  const inputType = getEventType(event)
  if (inputType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
    return
  }

  logInputEvent(event)

  if (inputType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (isHistoryMode()) {
      void closeHistoryWindow()
      return
    }

    void bridge.shutDownPageContainer(1)
    return
  }

  if (shouldHandleHistoryToggle(event)) {
    void handleHistoryTap()
    return
  }

  const historyScroll = shouldHandleHistoryScroll(event)
  if (historyScroll !== null) {
    void scrollHistoryWindow(historyScroll)
    return
  }

  if (inputType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)

setStats()
setupEndpointForm()
startIdleSpinner()
connect()
