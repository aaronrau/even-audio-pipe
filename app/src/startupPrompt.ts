type EndpointSettings = {
  privateAddress?: string
  publicAddress?: string
}

export const STARTUP_SETUP_CONTENT = [
  ' ||| ',
  'Open the phone app.',
  'Set receiver IP.',
  'Follow the checklist.',
].join('\n')

export const STARTUP_READY_CONTENT = [
  ' ||| ',
  'Receiver IP saved.',
  'Say something to start.',
  'Tap R1 for history.',
].join('\n')

export function hasReceiverAddress(settings: EndpointSettings) {
  return Boolean(settings.privateAddress?.trim() || settings.publicAddress?.trim())
}

export function startupLiveContent(settings: EndpointSettings) {
  return hasReceiverAddress(settings) ? STARTUP_READY_CONTENT : STARTUP_SETUP_CONTENT
}

export function nextStartupPromptVisible(current: boolean, payload: unknown) {
  if (!payload || typeof payload !== 'object') return current

  const message = payload as Record<string, unknown>
  if (message.type === 'asr_status' && message.status === 'vad_detected') {
    return false
  }

  return current
}
