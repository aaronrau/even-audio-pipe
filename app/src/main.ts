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

const RECEIVER_ADDRESS_STORAGE_KEY = 'evenAudioPipe.receiverAddress'
const PRIVATE_ADDRESS_STORAGE_KEY = 'evenAudioPipe.privateAddress'
const PUBLIC_ADDRESS_STORAGE_KEY = 'evenAudioPipe.publicAddress'
const LAN_ENDPOINT_STORAGE_KEY = 'evenAudioPipe.lanAddress'
const WAN_ENDPOINT_STORAGE_KEY = 'evenAudioPipe.wanAddress'
const AUTH_TOKEN_STORAGE_KEY = 'evenAudioPipe.authToken'
const CONNECT_TIMEOUT_MS = 5000

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
let speechDetected = false
let backendIdleFrame = ''
let glassesMode: GlassesMode = 'live'
let historyTransitioning = false
let historyUpdateInFlight = false
let historyUpdatePending = false
let lastHistoryRequestedContent = ''
let lastHistoryRenderedContent = ''
let cleanedUp = false
let audioOpen = false
let ws: WebSocket | null = null
let audioStreamStarted = false
let receiverState = 'disconnected'
let lastReceiverClose = ''
let reconnectTimer: number | null = null
let audioEndpointSettings = blankAudioEndpointSettings()
let audioWsEndpoints = buildAudioWsEndpoints(audioEndpointSettings)
let audioEndpointIndex = 0
let clearTranscriptTimer: number | null = null
let spinnerTimer: number | null = null
let waveformFrameIndex = 0
let unsubscribe: (() => void) | null = null
let evenUserInfo: UserPayload | null = null
let startupPromptVisible = true
let backendStartupPrompt = ''

const GLASSES_LINE_WIDTH = 52
const GLASSES_MAX_LINES = 7
const GLASSES_TEXT_LIMIT = GLASSES_LINE_WIDTH * GLASSES_MAX_LINES
const TRANSCRIPT_CLEAR_MS = 12_000
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
}

function requestMessageHistory(reason: string) {
  if (ws?.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({
    type: 'get_message_history',
    reason,
  }))
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
  const revision = ++statusRenderRevision
  const safeContent = content.slice(0, TEXT_UPGRADE_LIMIT)

  statusRenderQueue = statusRenderQueue
    .catch(() => false)
    .then(async () => {
      if (revision !== statusRenderRevision) return true
      return bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: STATUS_CONTAINER_ID,
          containerName: STATUS_CONTAINER_NAME,
          contentOffset: 0,
          contentLength: 0,
          content: safeContent,
        }),
      )
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

function stopSpeechProcessingIndicator() {
  speechDetected = false
  waveformFrameIndex = 0
  historyNavigator.clearPendingTranscript()
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
  transcriptText = takeTail(normalized, GLASSES_TEXT_LIMIT)
  transcriptEl.textContent = transcriptText
  scheduleTranscriptClear()
  if (isHistoryMode()) {
    requestHistoryWindowUpdate()
  } else {
    void renderGlassesStatus()
  }
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

function handleReceiverMessage(raw: string) {
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }

  if (!message || typeof message !== 'object') return
  const payload = message as Record<string, unknown>

  if (payload.type === 'auth_challenge' && typeof payload.nonce === 'string') {
    void answerAuthChallenge(payload.nonce)
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
    stopSpeechProcessingIndicator()
    appendTranscript(payload.text, 'You', '', { clearProcessing: false })
    setUiStatus('Streaming G2 mic audio')
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
      clearLiveTranscriptDisplay()
      historyNavigator.clearPendingTranscript()
      pushHistory(agent, summary, detail)
      renderPeekProgressDetail(agent)
      statusEl.textContent = 'Agent summary received'
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
    if (!historyTransitioning && !isHistoryMode() && !startupPromptVisible && !speechDetected && !transcriptText) {
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
    stopSpeechProcessingIndicator()
    setUiStatus(payload.requestType === 'local'
      ? 'Waiting for progress summary...'
      : 'Waiting for agent summary...')
    return
  }

  if (payload.type === 'agent_status' && payload.status === 'agent_armed') {
    stopSpeechProcessingIndicator()
    const agent = typeof payload.agent === 'string' && payload.agent
      ? payload.agent
      : 'agent'
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
    stopSpeechProcessingIndicator()
    if (payload.requestType === 'local') pendingPeekAgent = ''
    setUiStatus('Listening for speech...')
    return
  }

  if (payload.type === 'agent_error') {
    clearSpeechProcessingState()
    const error = typeof payload.error === 'string' ? payload.error : 'Workbench error'
    if (
      payload.requestType === 'local' &&
      typeof payload.agent === 'string' &&
      sameAgentLabel(payload.agent, pendingPeekAgent)
    ) {
      pendingPeekAgent = ''
    }
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
    speechDetected = false
    historyNavigator.clearPendingTranscript()
    requestHistoryWindowUpdate()
    setUiStatus('Waiting for more speech...')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'cleaning') {
    speechDetected = false
    historyNavigator.clearPendingTranscript()
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
      void startAudioStream()
    } else if (payload.status === 'rejected') {
      setUiStatus('Authentication rejected')
    }
    return
  }
}

async function answerAuthChallenge(nonce: string) {
  const secret = currentSharedSecret()
  if (!secret) {
    setUiStatus('Missing shared secret')
    return
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) return

  try {
    const proof = await sharedSecretProof(secret, nonce)
    ws.send(JSON.stringify({
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

function shouldHandleHistoryToggle(event: EvenHubEvent) {
  if (!isHistoryToggleInput(event)) return false

  const now = Date.now()
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

async function startAudioStream() {
  if (!ws || ws.readyState !== WebSocket.OPEN || audioStreamStarted) return
  audioStreamStarted = true
  const endpoint = currentAudioEndpoint()
  const startMessage: Record<string, unknown> = {
    type: 'start',
    source: 'g2',
    encoding: 'pcm_s16le',
    sampleRate: 16000,
    channels: 1,
  }

  if (evenUserInfo) {
    startMessage.user = evenUserInfo
  }

  ws.send(JSON.stringify(startMessage))
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
    await bridge.audioControl(open)
  } catch (err) {
    audioOpen = !open
    setStats()
    setUiStatus(`audioControl(${String(open)}) failed`)
    console.error(err)
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
  audioStreamStarted = false
  ws = new WebSocket(endpoint.url)
  ws.binaryType = 'arraybuffer'
  let opened = false
  let connectTimedOut = false
  const connectTimeout = window.setTimeout(() => {
    if (opened || ws !== connectingSocket) return
    connectTimedOut = true
    setUiStatus(`${endpoint.label} receiver timed out`)
    ws.close()
  }, CONNECT_TIMEOUT_MS)
  const connectingSocket = ws

  ws.addEventListener('open', async () => {
    if (!ws) return
    window.clearTimeout(connectTimeout)
    opened = true
    receiverState = 'open'
    lastReceiverClose = ''
    setStats()
    if (currentSharedSecret()) {
      setUiStatus(`Authenticating ${endpoint.label} receiver...`)
      return
    }
    await startAudioStream()
  })

  ws.addEventListener('message', event => {
    if (typeof event.data === 'string') {
      handleReceiverMessage(event.data)
    }
  })

  ws.addEventListener('close', async event => {
    window.clearTimeout(connectTimeout)
    ws = null
    receiverState = 'closed'
    backendIdleFrame = ''
    lastReceiverClose = `${event.code}${event.reason ? ` ${event.reason}` : ''}${event.wasClean ? ' clean' : ' unclean'}`
    setStats()
    clearSpeechProcessingState()
    await setAudio(false)
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

  ws.addEventListener('error', () => {
    window.clearTimeout(connectTimeout)
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
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(pcm)
      sentChunks += 1
      sentBytes += pcm.byteLength
      if (sentChunks % 10 === 0) {
        setStats()
        void renderGlassesStatus()
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
