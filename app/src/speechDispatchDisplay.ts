export type SpeechDispatchState = 'queued' | 'sent' | 'saved'

export type SpeechDispatchDisplay = {
  state: SpeechDispatchState
  text: string
  agent?: string
  message?: string
}

export const LIVE_TRANSCRIPT_PREVIEW_CHARS = 100

export function normalizeSpeechDispatchText(text: string) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

export function transcriptPreview(text: string, limit = LIVE_TRANSCRIPT_PREVIEW_CHARS) {
  const normalized = normalizeSpeechDispatchText(text)
  const safeLimit = Math.max(0, Math.floor(limit))
  if (normalized.length <= safeLimit) return normalized
  if (safeLimit <= 3) return '.'.repeat(safeLimit)
  return `...${normalized.slice(-(safeLimit - 3))}`
}

function prefixedPreview(prefix: string, text: string) {
  const normalized = normalizeSpeechDispatchText(text)
  if (!normalized) return prefix.replace(/:$/, '')
  return `${prefix} ${transcriptPreview(
    normalized,
    LIVE_TRANSCRIPT_PREVIEW_CHARS - prefix.length - 1,
  )}`
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function stripLeadingDispatchAgent(text: string, agent = '') {
  const normalized = normalizeSpeechDispatchText(text)
  const normalizedAgent = normalizeSpeechDispatchText(agent)
  if (!normalized || !normalizedAgent) return normalized

  const agentPattern = escapedRegExp(normalizedAgent)
  return normalized
    .replace(new RegExp(`^(?:hey|hi|ok|okay)?\\s*${agentPattern}\\s*[:,.\\-]?(?:\\s+|$)`, 'i'), '')
    .replace(new RegExp(`(?:^|\\s)${agentPattern}\\s*[,.;:!?-]?(?=\\s|$)`, 'gi'), ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatSpeechDispatchDisplay(display: SpeechDispatchDisplay) {
  const text = transcriptPreview(display.text)
  if (display.state === 'queued') return prefixedPreview('Queued:', text)
  if (display.state === 'saved') return prefixedPreview('Saved:', text)

  const agent = transcriptPreview(display.agent || '', 32)
  const message = stripLeadingDispatchAgent(display.message || text, agent)
  if (!agent) return prefixedPreview('Sent:', message || text)
  return prefixedPreview(`Sent: ${agent},`, message).replace(/,$/, '')
}
