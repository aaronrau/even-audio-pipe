export type AudioEndpoint = {
  label: string
  url: string
}

export type AudioEndpointSettings = {
  privateAddress: string
  publicAddress: string
  token: string
}

const AUDIO_WS_PATH = '/audio'
const DEFAULT_RECEIVER_PORT = '8788'
const DEFAULT_APP_PORTS = new Set(['5173'])

export function blankAudioEndpointSettings(): AudioEndpointSettings {
  return {
    privateAddress: '',
    publicAddress: '',
    token: '',
  }
}

export function splitAddress(value: string) {
  const input = value.trim()
  if (!input) return { host: '', port: '' }

  const parsed = parseEndpointInput(input)
  if (parsed) {
    return {
      host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: parsed.port || DEFAULT_RECEIVER_PORT,
    }
  }

  const match = input.match(/^(.+):(\d+)$/)
  if (!match) return { host: input, port: '' }
  return { host: match[1], port: match[2] }
}

export function joinAddress(hostValue: string, portValue: string) {
  const host = hostValue.trim()
  const port = portValue.trim()
  if (!host) return ''
  if (!port) return host
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${normalizedHost}:${port}`
}

export function buildAudioWsEndpoints(
  settings: AudioEndpointSettings,
  launchToken = '',
): AudioEndpoint[] {
  const endpoints: AudioEndpoint[] = []
  const seen = new Set<string>()

  const addEndpoint = (label: string, url: string | undefined, protocol: 'ws:' | 'wss:') => {
    const normalized = withLaunchToken(normalizeWsEndpoint(url, protocol), launchToken)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    endpoints.push({ label, url: normalized })
  }

  addEndpoint('Private', settings.privateAddress, 'ws:')
  addEndpoint('Public', settings.publicAddress, 'wss:')
  return endpoints
}

function parseEndpointInput(value: string) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : withProtocolPrefix('ws:', value)

  try {
    const parsed = new URL(withScheme)
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol)) return null
    if (!parsed.port || DEFAULT_APP_PORTS.has(parsed.port)) parsed.port = DEFAULT_RECEIVER_PORT
    if (parsed.pathname === '/' || !parsed.pathname) parsed.pathname = AUDIO_WS_PATH
    return parsed
  } catch {
    return null
  }
}

function withProtocolPrefix(protocol: 'ws:', value: string) {
  return protocol.concat('/', '/', value)
}

function endpointWithProtocol(endpoint: URL, protocol: 'ws:' | 'wss:') {
  const next = new URL(endpoint.toString())
  next.protocol = protocol
  return next.toString()
}

function normalizeWsEndpoint(value: string | undefined, protocol: 'ws:' | 'wss:') {
  const input = (value || '').trim()
  if (!input) return ''

  const parsed = parseEndpointInput(input)
  return parsed ? endpointWithProtocol(parsed, protocol) : input
}

function withLaunchToken(url: string | undefined, token: string) {
  if (!url || !token) return url

  try {
    const parsed = new URL(url)
    parsed.searchParams.set('t', token)
    return parsed.toString()
  } catch {
    return url
  }
}
