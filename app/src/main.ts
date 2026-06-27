import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  RebuildPageContainer,
  EventSourceType,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

const BASE_AUDIO_WS_URL = import.meta.env.VITE_AUDIO_WS_URL as string | undefined
const AUDIO_WS_URL = withLaunchToken(BASE_AUDIO_WS_URL)

const statusEl = document.getElementById('status')!
const statsEl = document.getElementById('stats')!
const urlEl = document.getElementById('url')!
const transcriptEl = document.getElementById('transcript')!

type UserPayload = {
  uid?: string
  name?: string
  country?: string
}

type GlassesMode = 'live' | 'history'

type HistoryEntry = {
  label: string
  text: string
  detail?: string
  receivedAt: number
}

let sentChunks = 0
let sentBytes = 0
let droppedChunks = 0
let transcriptText = ''
let queuedTranscriptText = ''
let glassesMode: GlassesMode = 'live'
let historyTransitioning = false
let historyUpdateInFlight = false
let historyUpdatePending = false
let cleanedUp = false
let audioOpen = false
let ws: WebSocket | null = null
let reconnectTimer: number | null = null
let clearTranscriptTimer: number | null = null
let spinnerTimer: number | null = null
let spinnerIndex = 0
let unsubscribe: (() => void) | null = null
let evenUserInfo: UserPayload | null = null

const GLASSES_LINE_WIDTH = 52
const GLASSES_MAX_LINES = 7
const GLASSES_TEXT_LIMIT = GLASSES_LINE_WIDTH * GLASSES_MAX_LINES
const TRANSCRIPT_CLEAR_MS = 5_000
const SPINNER_FRAMES = ['.', '..', '...', '..']
const SPINNER_INTERVAL_MS = 650
const HISTORY_LIMIT = 24
const HISTORY_ENTRY_TEXT_LIMIT = 930
const HISTORY_TEXT_LIMIT = 1000
const HISTORY_TOGGLE_DEBOUNCE_MS = 700
// Some host builds normalize ring clicks into source-less text events.
const ALLOW_UNSOURCED_HISTORY_TOGGLE = true
const messageHistory: HistoryEntry[] = []
let lastHistoryToggleInputAt = 0

function setUiStatus(text: string) {
  statusEl.textContent = text
  void renderGlassesStatus()
}

function setStats() {
  statsEl.textContent =
    `${sentChunks} chunks, ${sentBytes} bytes, ${droppedChunks} dropped`
}

function launchToken() {
  const params = new URLSearchParams(window.location.search)
  return params.get('t') || params.get('token') || ''
}

function withLaunchToken(url: string | undefined) {
  const token = launchToken()
  if (!url || !token) return url

  try {
    const parsed = new URL(url)
    parsed.searchParams.set('t', token)
    return parsed.toString()
  } catch {
    return url
  }
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

function stringValue(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
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

function trimWithEllipsis(text: string, limit: number) {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

function sanitizeHistoryEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const detail = stringValue(record.detail).replace(/\s+/g, ' ').trim()
  const text = stringValue(record.text || record.summary || detail).replace(/\s+/g, ' ').trim()
  const receivedAt = Number(record.receivedAt)
  if (!text || !Number.isFinite(receivedAt)) return null

  const entry: HistoryEntry = {
    label: stringValue(record.label) || 'Message',
    text: trimWithEllipsis(text, HISTORY_ENTRY_TEXT_LIMIT),
    receivedAt,
  }
  if (detail) entry.detail = trimWithEllipsis(detail, HISTORY_ENTRY_TEXT_LIMIT)
  return entry
}

function replaceHistory(entries: HistoryEntry[]) {
  messageHistory.splice(
    0,
    messageHistory.length,
    ...entries.slice(-HISTORY_LIMIT),
  )
}

function pushHistory(label: string, text: string, detail = '') {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return

  const entry: HistoryEntry = {
    label,
    text: trimWithEllipsis(normalized, HISTORY_ENTRY_TEXT_LIMIT),
    receivedAt: Date.now(),
  }
  const normalizedDetail = detail.replace(/\s+/g, ' ').trim()
  if (normalizedDetail) {
    entry.detail = trimWithEllipsis(normalizedDetail, HISTORY_ENTRY_TEXT_LIMIT)
  }

  messageHistory.push(entry)

  if (messageHistory.length > HISTORY_LIMIT) {
    messageHistory.splice(0, messageHistory.length - HISTORY_LIMIT)
  }
}

function formatHistoryTime(receivedAt: number) {
  const date = new Date(receivedAt)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function formatHistoryContent() {
  const rows: string[] = []
  if (queuedTranscriptText) {
    rows.push(`Queued: ${trimWithEllipsis(queuedTranscriptText, HISTORY_ENTRY_TEXT_LIMIT)}`)
  }

  rows.push(...messageHistory
    .slice()
    .reverse()
    .map(entry => `${formatHistoryTime(entry.receivedAt)} ${entry.detail || entry.text}`)
  )

  return trimWithEllipsis(rows.join('\n'), HISTORY_TEXT_LIMIT)
}

function currentLiveGlassesContent() {
  return transcriptText
    ? formatGlassesTranscript(transcriptText)
    : SPINNER_FRAMES[spinnerIndex]
}

function makeStatusContainer(content: string, isHistory: boolean) {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: isHistory ? 1 : 0,
    borderColor: 15,
    borderRadius: 0,
    paddingLength: 0,
    containerID: 1,
    containerName: 'audio_status',
    content,
    isEventCapture: 1,
  })
}

function requestHistoryWindowUpdate() {
  if (glassesMode !== 'history') return
  historyUpdatePending = true
  void flushHistoryWindowUpdate()
}

async function flushHistoryWindowUpdate() {
  if (
    historyUpdateInFlight ||
    historyTransitioning ||
    !historyUpdatePending ||
    glassesMode !== 'history'
  ) {
    return
  }

  historyUpdateInFlight = true

  try {
    while (historyUpdatePending && glassesMode === 'history' && !historyTransitioning) {
      historyUpdatePending = false
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'audio_status',
          content: formatHistoryContent(),
        }),
      )
    }
  } finally {
    historyUpdateInFlight = false
    if (historyUpdatePending && glassesMode === 'history' && !historyTransitioning) {
      void flushHistoryWindowUpdate()
    }
  }
}

async function showHistoryWindow() {
  const previousMode = glassesMode
  glassesMode = 'history'

  const rebuilt = await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [makeStatusContainer(formatHistoryContent(), true)],
    }),
  )

  if (rebuilt) {
    requestHistoryWindowUpdate()
    return
  }

  glassesMode = previousMode
  setUiStatus('History view failed')
}

async function closeHistoryWindow() {
  const previousMode = glassesMode
  glassesMode = 'live'

  const rebuilt = await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [makeStatusContainer(currentLiveGlassesContent(), false)],
    }),
  )

  if (rebuilt) {
    return
  }

  glassesMode = previousMode
  requestHistoryWindowUpdate()
  console.warn('Failed to close history view')
}

async function toggleHistoryWindow() {
  if (historyTransitioning) return
  historyTransitioning = true

  try {
    if (glassesMode === 'history') {
      await closeHistoryWindow()
    } else {
      await showHistoryWindow()
    }
  } catch (err) {
    console.error('History view toggle failed', err)
    setUiStatus('History view failed')
  } finally {
    historyTransitioning = false
    if (glassesMode === 'history') {
      void flushHistoryWindowUpdate()
    }
  }
}

function appendTranscript(text: string, label = 'Message', detail = '') {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return

  queuedTranscriptText = ''
  pushHistory(label, normalized, detail)
  transcriptText = takeTail(normalized, GLASSES_TEXT_LIMIT)
  transcriptEl.textContent = transcriptText
  scheduleTranscriptClear()
  if (glassesMode === 'history') {
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
    if (transcriptText) return
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length
    void renderGlassesStatus()
  }, SPINNER_INTERVAL_MS)
}

function handleReceiverMessage(raw: string) {
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    console.log('receiver:', raw)
    return
  }

  if (!message || typeof message !== 'object') return
  const payload = message as Record<string, unknown>

  if (payload.type === 'message_history' && Array.isArray(payload.entries)) {
    const entries = payload.entries
      .map(sanitizeHistoryEntry)
      .filter((entry): entry is HistoryEntry => entry !== null)
    replaceHistory(entries)
    requestHistoryWindowUpdate()
    return
  }

  if (payload.type === 'transcript' && typeof payload.text === 'string') {
    appendTranscript(payload.text, 'You')
    setUiStatus('Streaming G2 mic audio')
    return
  }

  if (payload.type === 'agent_summary' && typeof payload.text === 'string') {
    const agent = typeof payload.agent === 'string' && payload.agent
      ? payload.agent
      : 'Agent'
    const detail = typeof payload.detail === 'string' ? payload.detail : ''
    appendTranscript(payload.text, agent, detail)
    setUiStatus('Agent summary received')
    return
  }

  if (payload.type === 'agent_status' && payload.status === 'sending') {
    setUiStatus('Sending to workbench...')
    return
  }

  if (payload.type === 'agent_status' && payload.status === 'sent') {
    setUiStatus('Waiting for agent summary...')
    return
  }

  if (payload.type === 'agent_status' && payload.status === 'agent_armed') {
    const agent = typeof payload.agent === 'string' && payload.agent
      ? payload.agent
      : 'agent'
    setUiStatus(`${agent} selected`)
    return
  }

  if (payload.type === 'agent_error') {
    const error = typeof payload.error === 'string' ? payload.error : 'Workbench error'
    appendTranscript(error, 'Error')
    setUiStatus('Workbench error')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'transcribing') {
    setUiStatus('Transcribing speech...')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'queued') {
    const queuedText = typeof payload.queuedText === 'string'
      ? payload.queuedText
      : typeof payload.text === 'string'
        ? payload.text
        : ''
    queuedTranscriptText = queuedText.replace(/\s+/g, ' ').trim()
    requestHistoryWindowUpdate()
    setUiStatus('Waiting for more speech...')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'cleaning') {
    const queuedText = typeof payload.queuedText === 'string'
      ? payload.queuedText
      : typeof payload.text === 'string'
        ? payload.text
        : queuedTranscriptText
    queuedTranscriptText = queuedText.replace(/\s+/g, ' ').trim()
    requestHistoryWindowUpdate()
    setUiStatus('Cleaning transcript...')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'no_transcript') {
    queuedTranscriptText = ''
    requestHistoryWindowUpdate()
    setUiStatus('Listening for speech...')
    return
  }

  if (payload.type === 'receiver_status') {
    setUiStatus('Receiver connected')
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
  if (now - lastHistoryToggleInputAt < HISTORY_TOGGLE_DEBOUNCE_MS) return false

  lastHistoryToggleInputAt = now
  return true
}

function osEventTypeName(type: OsEventTypeList | undefined) {
  if (type === undefined) return 'undefined'
  return OsEventTypeList[type] ?? String(type)
}

function eventSourceName(source: EventSourceType | null) {
  if (source === null) return 'unknown'
  return EventSourceType[source] ?? String(source)
}

function logInputEvent(event: EvenHubEvent) {
  if (!event.textEvent && !event.listEvent && !event.sysEvent) return

  const inputType = getEventType(event)
  const source = getEventSource(event)
  const summary = {
    type: 'input_debug',
    eventType: inputType ?? 'undefined',
    eventTypeName: osEventTypeName(inputType),
    eventSource: source ?? 'unknown',
    eventSourceName: eventSourceName(source),
    isSinglePress: isSinglePress(event),
    isHistoryToggle: isHistoryToggleInput(event),
    mode: glassesMode,
    textEvent: event.textEvent
      ? {
          containerID: event.textEvent.containerID,
          containerName: event.textEvent.containerName,
          eventType: event.textEvent.eventType ?? 'undefined',
          eventTypeName: osEventTypeName(event.textEvent.eventType),
        }
      : null,
    listEvent: event.listEvent
      ? {
          containerID: event.listEvent.containerID,
          containerName: event.listEvent.containerName,
          currentSelectItemIndex: event.listEvent.currentSelectItemIndex,
          currentSelectItemName: event.listEvent.currentSelectItemName,
          eventType: event.listEvent.eventType ?? 'undefined',
          eventTypeName: osEventTypeName(event.listEvent.eventType),
        }
      : null,
    sysEvent: event.sysEvent
      ? {
          eventType: event.sysEvent.eventType ?? 'undefined',
          eventTypeName: osEventTypeName(event.sysEvent.eventType),
          eventSource: event.sysEvent.eventSource ?? 'unknown',
          eventSourceName: eventSourceName(event.sysEvent.eventSource ?? null),
          systemExitReasonCode: event.sysEvent.systemExitReasonCode,
        }
      : null,
    jsonData: event.jsonData ?? null,
  }

  console.log('[even-input]', summary)

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(summary))
  }
}

const bridge = await waitForEvenAppBridge()
evenUserInfo = await loadUserInfo()

const statusContainer = makeStatusContainer('Starting audio pipe...', false)

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [statusContainer],
  }),
)

if (created !== 0) {
  setUiStatus(`Startup page failed: ${created}`)
  throw new Error(`createStartUpPageContainer failed: ${created}`)
}

async function renderGlassesStatus() {
  if (glassesMode !== 'live') return

  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'audio_status',
      content: currentLiveGlassesContent(),
    }),
  )
}

async function setAudio(open: boolean) {
  if (audioOpen === open) return
  audioOpen = open
  try {
    await bridge.audioControl(open)
  } catch (err) {
    audioOpen = !open
    setUiStatus(`audioControl(${String(open)}) failed`)
    console.error(err)
  }
}

function scheduleReconnect() {
  if (cleanedUp || reconnectTimer !== null || !AUDIO_WS_URL) return
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 1500)
}

function connect() {
  if (!AUDIO_WS_URL) {
    setUiStatus('Missing VITE_AUDIO_WS_URL')
    return
  }

  urlEl.textContent = displayWsUrl(AUDIO_WS_URL)
  setUiStatus('Connecting to receiver...')
  ws = new WebSocket(AUDIO_WS_URL)
  ws.binaryType = 'arraybuffer'

  ws.addEventListener('open', async () => {
    if (!ws) return
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
    setUiStatus('Streaming G2 mic audio')
  })

  ws.addEventListener('message', event => {
    if (typeof event.data === 'string') {
      handleReceiverMessage(event.data)
    }
  })

  ws.addEventListener('close', async () => {
    ws = null
    await setAudio(false)
    if (!cleanedUp) {
      setUiStatus('Receiver disconnected, retrying...')
      scheduleReconnect()
    }
  })

  ws.addEventListener('error', () => {
    setUiStatus('Receiver connection error')
  })
}

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
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
  logInputEvent(event)

  if (inputType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    void bridge.shutDownPageContainer(1)
    return
  }

  if (shouldHandleHistoryToggle(event)) {
    void toggleHistoryWindow()
    return
  }

  if (inputType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
    return
  }

  if (inputType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)

setStats()
startIdleSpinner()
connect()
