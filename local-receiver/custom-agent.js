const DEFAULT_PREFIX_WORD_LIMIT = 3
const DEFAULT_PROCESSING_TIMEOUT_MS = 15_000
const DEFAULT_VERIFICATION_TIMEOUT_MS = 5_000

export function normalizeCustomAgents(value, workbenchAgents = []) {
  if (!Array.isArray(value)) return []

  const reserved = new Set(workbenchAgents.map(normalizeName).filter(Boolean))
  const seenIds = new Set()
  const seenNames = new Set()
  const agents = []

  for (const item of value) {
    if (!item || typeof item !== 'object') continue

    const id = String(item.id || '').trim().toLowerCase()
    const name = String(item.name || '').trim()
    const normalizedName = normalizeName(name)
    const processingPrompt = String(item.processingPrompt || '').trim()
    if (!/^[a-z0-9_-]+$/.test(id) || !normalizedName || !processingPrompt) continue
    if (seenIds.has(id) || seenNames.has(normalizedName) || reserved.has(normalizedName)) continue

    const aliases = uniqueStrings(item.aliases)
      .filter(alias => normalizeName(alias) && normalizeName(alias) !== normalizedName)
      .filter(alias => !reserved.has(normalizeName(alias)))

    seenIds.add(id)
    seenNames.add(normalizedName)
    agents.push({
      id,
      name,
      aliases,
      nameCorrectionPrompt: String(item.nameCorrectionPrompt || '').trim(),
      processingPrompt,
      processingTimeoutMs: positiveInteger(item.processingTimeoutMs, DEFAULT_PROCESSING_TIMEOUT_MS),
      processingMaxTokens: positiveInteger(item.processingMaxTokens, 2_048),
      verificationTimeoutMs: positiveInteger(item.verificationTimeoutMs, DEFAULT_VERIFICATION_TIMEOUT_MS),
      speakerMatchThreshold: score(item.speakerMatchThreshold),
      prefixWordLimit: positiveInteger(item.prefixWordLimit, DEFAULT_PREFIX_WORD_LIMIT),
      matchAnywhere: item.matchAnywhere === true,
    })
  }

  return agents
}

export function customAgentCleanupPrompt(basePrompt, agents) {
  const hints = agents.map(agent => agent.nameCorrectionPrompt).filter(Boolean)
  return [String(basePrompt || '').trim(), ...hints].filter(Boolean).join(' ')
}

export function findCustomAgentInvocation(cleanedText, rawText, agents) {
  for (const agent of agents) {
    const cleaned = matchInvocation(cleanedText, agent)
    if (!cleaned) continue

    const raw = matchInvocation(rawText, agent)
    if (!raw) continue

    return {
      agent,
      message: cleaned.message,
      cleanedInvocation: cleaned.invocation,
      rawInvocation: raw.invocation,
    }
  }

  return null
}

export function speakerBreakoutVerified(result, threshold = null) {
  if (!result || result.verificationFailed) return false
  const turns = result.breakout?.turns
  return Array.isArray(turns) && turns.length > 0 && turns.every(
    turn => {
      const speaker = turn?.speaker
      if (speaker?.matchedProfile === true) return true
      return threshold !== null &&
        Boolean(speaker?.profileId) &&
        Number.isFinite(Number(speaker?.profileSimilarity)) &&
        Number(speaker.profileSimilarity) >= threshold
    },
  )
}

export function customAgentInvokedInText(text, agent) {
  return Boolean(matchInvocation(text, agent))
}

export function verifyCustomAgentInvocation(rawSegments, diarizationResults, agent) {
  const invocationIndexes = rawSegments
    .map((text, index) => customAgentInvokedInText(text, agent) ? index : -1)
    .filter(index => index >= 0)
  return {
    invocationIndexes,
    verified: invocationIndexes.length > 0 && invocationIndexes.every(
      index => speakerBreakoutVerified(diarizationResults[index], agent.speakerMatchThreshold),
    ),
  }
}

export function customAgentDetail({ rawTranscript, cleanedTranscript, agentName, processedText }) {
  return [
    'Raw ASR',
    String(rawTranscript || '').trim(),
    '',
    'Cleaned transcript',
    String(cleanedTranscript || '').trim(),
    '',
    `${agentName} memo`,
    String(processedText || '').trim(),
  ].join('\n').trim()
}

function matchInvocation(text, agent) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return null

  const normalizedWords = words.map(normalizeName)
  const invocations = [agent.name, ...agent.aliases]
  const maxStart = agent.matchAnywhere
    ? words.length - 1
    : Math.min(agent.prefixWordLimit, words.length) - 1

  for (let start = 0; start <= maxStart; start += 1) {
    for (const invocation of invocations) {
      const invocationWords = normalizeName(invocation).split(' ').filter(Boolean)
      if (!invocationWords.length) continue
      const candidate = normalizedWords.slice(start, start + invocationWords.length)
      if (candidate.length !== invocationWords.length) continue
      if (candidate.join(' ') !== invocationWords.join(' ')) continue

      const before = agent.matchAnywhere && start >= agent.prefixWordLimit
        ? words.slice(0, start)
        : []
      const after = words.slice(start + invocationWords.length)
      return {
        invocation,
        message: [...before, ...after]
          .join(' ')
          .replace(/^[\s.,:;+\-]+/, '')
          .trim(),
      }
    }
  }

  return null
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqueStrings(value) {
  const items = Array.isArray(value) ? value : []
  return [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))]
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function score(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null
}
