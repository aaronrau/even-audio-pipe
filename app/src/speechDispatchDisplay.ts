export type SpeechDispatchState = 'queued' | 'sent' | 'saved'

export type SpeechDispatchDisplay = {
  state: SpeechDispatchState
  text: string
  agent?: string
  message?: string
}

export function normalizeSpeechDispatchText(text: string) {
  return String(text || '').replace(/\s+/g, ' ').trim()
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
  const text = normalizeSpeechDispatchText(display.text)
  if (display.state === 'queued') return text ? `Queued: ${text}` : 'Queued'
  if (display.state === 'saved') return text ? `Saved: ${text}` : 'Saved'

  const agent = normalizeSpeechDispatchText(display.agent || '')
  const message = stripLeadingDispatchAgent(display.message || text, agent)
  if (!agent) return message || text ? `Sent: ${message || text}` : 'Sent'
  return `Sent: ${agent}${message ? `, ${message}` : ''}`
}
