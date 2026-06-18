import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const AUDIO_WS_URL = import.meta.env.VITE_AUDIO_WS_URL as string | undefined

const statusEl = document.getElementById('status')!
const statsEl = document.getElementById('stats')!
const urlEl = document.getElementById('url')!
const transcriptEl = document.getElementById('transcript')!

let sentChunks = 0
let sentBytes = 0
let droppedChunks = 0
let transcriptText = ''
let cleanedUp = false
let audioOpen = false
let ws: WebSocket | null = null
let reconnectTimer: number | null = null
let clearTranscriptTimer: number | null = null
let spinnerTimer: number | null = null
let spinnerIndex = 0
let unsubscribe: (() => void) | null = null

const GLASSES_LINE_WIDTH = 52
const GLASSES_MAX_LINES = 7
const GLASSES_TEXT_LIMIT = GLASSES_LINE_WIDTH * GLASSES_MAX_LINES
const TRANSCRIPT_CLEAR_MS = 5_000
const SPINNER_FRAMES = ['.', '..', '...', '..']
const SPINNER_INTERVAL_MS = 650

function setUiStatus(text: string) {
  statusEl.textContent = text
  void renderGlassesStatus()
}

function setStats() {
  statsEl.textContent =
    `${sentChunks} chunks, ${sentBytes} bytes, ${droppedChunks} dropped`
}

function takeTail(text: string, limit: number) {
  if (text.length <= limit) return text
  return text.slice(-limit).replace(/^\S*\s?/, '').trimStart()
}

function appendTranscript(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return

  transcriptText = takeTail(normalized, GLASSES_TEXT_LIMIT)
  transcriptEl.textContent = transcriptText
  scheduleTranscriptClear()
  void renderGlassesStatus()
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

  if (payload.type === 'transcript' && typeof payload.text === 'string') {
    appendTranscript(payload.text)
    setUiStatus('Streaming G2 mic audio')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'transcribing') {
    setUiStatus('Transcribing speech...')
    return
  }

  if (payload.type === 'asr_status' && payload.status === 'no_transcript') {
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

const bridge = await waitForEvenAppBridge()

const statusContainer = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 15,
  paddingLength: 0,
  containerID: 1,
  containerName: 'audio_status',
  content: 'Starting audio pipe...',
  isEventCapture: 1,
})

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
  const content = transcriptText
    ? formatGlassesTranscript(transcriptText)
    : SPINNER_FRAMES[spinnerIndex]

  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'audio_status',
      content,
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

  urlEl.textContent = AUDIO_WS_URL
  setUiStatus('Connecting to receiver...')
  ws = new WebSocket(AUDIO_WS_URL)
  ws.binaryType = 'arraybuffer'

  ws.addEventListener('open', async () => {
    if (!ws) return
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
    }))
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

  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    void bridge.shutDownPageContainer(1)
    return
  }

  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)

setStats()
startIdleSpinner()
connect()
