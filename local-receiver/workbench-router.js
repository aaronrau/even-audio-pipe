export function createWorkbenchRouter(config, options = {}) {
  const pendingAgents = options.pendingAgents || new WeakMap()
  const now = options.now || (() => Date.now())

  function routeTranscript(text, targetSocket, routeOptions = {}) {
    const cleaned = normalizeTranscript(text)
    if (!cleaned) return { skip: true, reason: 'empty_transcript' }

    const parsed = parseIntent(cleaned, {
      includeAliases: !config.requireAgentPrefix,
      rawText: routeOptions.rawText,
    })

    if (config.requireAgentPrefix) {
      if (parsed?.agent && parsed.message) {
        clearPendingAgent(targetSocket)
        return routeMessage(parsed.agent, parsed.message)
      }

      if (parsed?.agent && !parsed.message) {
        armPendingAgent(targetSocket, parsed.agent)
        return {
          skip: true,
          reason: 'agent_armed',
          agent: parsed.agent,
        }
      }

      const pendingAgent = getPendingAgent(targetSocket)
      if (pendingAgent) {
        return routeMessage(pendingAgent, cleaned, {
          agent: pendingAgent,
          clearPendingAgentOnSent: true,
        })
      }

      return {
        skip: true,
        reason: 'missing_agent_prefix',
      }
    }

    if (config.agent) {
      return routeMessage(config.agent, cleaned, {
        agent: config.agent,
      })
    }

    if (parsed?.agent && parsed.message) {
      clearPendingAgent(targetSocket)
      return routeMessage(parsed.agent, parsed.message)
    }

    if (parsed?.agent && !parsed.message) {
      armPendingAgent(targetSocket, parsed.agent)
      return {
        skip: true,
        reason: 'agent_armed',
        agent: parsed.agent,
      }
    }

    const pendingAgent = getPendingAgent(targetSocket)
    if (pendingAgent) {
      return routeMessage(pendingAgent, cleaned, {
        agent: pendingAgent,
        clearPendingAgentOnSent: true,
      })
    }

    return {
      skip: true,
      reason: 'missing_agent_prefix',
    }
  }

  function routeMessage(agent, message, extras = {}) {
    const cleanedMessage = stripRepeatedAgentFromMessage(agent, message)
    if (!cleanedMessage) {
      return {
        skip: true,
        reason: 'agent_armed',
        agent,
      }
    }

    return {
      ...extras,
      agent,
      message: cleanedMessage,
    }
  }

  function parseIntent(text, parseOptions = {}) {
    const parsed = parseAgentPrefix(text, {
      includeAliases: parseOptions.includeAliases,
    })

    if (!parseOptions.rawText) return parsed

    const rawText = normalizeTranscript(parseOptions.rawText)
    if (!rawText || rawText === text) return parsed

    const rawParsed = parseAgentPrefix(rawText, {
      includeAliases: parseOptions.includeAliases,
    })
    if (parsed?.agent && parsed.message) return parsed
    if (rawParsed?.agent && rawParsed.message) return rawParsed
    if (!parsed?.agent && rawParsed?.agent && !rawParsed.message) return rawParsed

    return parsed
  }

  function preserveCommand(rawText, cleanedText) {
    const cleaned = normalizeTranscript(cleanedText)
    if (!cleaned) return cleaned

    const cleanedParsed = parseAgentPrefix(cleaned, { includeAliases: true })
    if (!cleanedParsed?.agent || cleanedParsed.message) return cleaned

    const rawParsed = parseAgentPrefix(rawText, { includeAliases: true })
    if (!rawParsed?.agent || !rawParsed.message) return cleaned
    if (rawParsed.agent !== cleanedParsed.agent) return cleaned

    return `${rawParsed.agent} ${rawParsed.message}`.trim()
  }

  function armPendingAgent(targetSocket, agent) {
    if (!targetSocket || !agent) return

    const timeoutMs = agentArmTimeoutMs()
    pendingAgents.set(targetSocket, {
      agent,
      expiresAt: timeoutMs > 0 ? now() + timeoutMs : 0,
    })
  }

  function getPendingAgent(targetSocket) {
    if (!targetSocket) return ''

    const pending = pendingAgents.get(targetSocket)
    if (!pending) return ''

    const agent = typeof pending === 'string' ? pending : pending.agent
    const expiresAt = typeof pending === 'string' ? 0 : pending.expiresAt

    if (expiresAt > 0 && expiresAt <= now()) {
      pendingAgents.delete(targetSocket)
      return ''
    }

    return agent || ''
  }

  function clearPendingAgent(targetSocket, agent = '') {
    if (!targetSocket) return

    if (!agent) {
      pendingAgents.delete(targetSocket)
      return
    }

    const pendingAgent = getPendingAgent(targetSocket)
    if (pendingAgent === agent) pendingAgents.delete(targetSocket)
  }

  function routeDescription() {
    if (!config.enabled) return 'disabled'
    if (!config.requireAgentPrefix) return 'default/pending agent allowed'

    return `agent in first ${agentPrefixWordLimit()} words required; agent-only arms next transcript for ${(agentArmTimeoutMs() / 1000).toFixed(1)}s`
  }

  function parseAgentPrefix(text, parseOptions = {}) {
    const candidates = agentCandidates(parseOptions)
    if (!candidates.length) return null

    const originalWords = String(text || '').trim().split(/\s+/).filter(Boolean)
    if (!originalWords.length) return null

    const normalizedWords = originalWords.map(word => normalizeCommandText(word))
    if (!normalizedWords.some(Boolean)) return null

    let best = null
    const wordLimit = agentPrefixWordLimit()
    for (const candidate of candidates) {
      const normalizedAlias = normalizeCommandText(candidate.alias)
      if (!normalizedAlias) continue
      const aliasWords = normalizedAlias.split(' ').filter(Boolean)
      if (!aliasWords.length) continue

      const maxStartIndex = Math.min(wordLimit, normalizedWords.length) - 1
      for (let startIndex = 0; startIndex <= maxStartIndex; startIndex += 1) {
        const words = normalizedWords.slice(startIndex, startIndex + aliasWords.length)
        if (words.length !== aliasWords.length) continue
        if (words.join(' ') !== normalizedAlias) continue
        if (
          !best ||
          startIndex < best.startIndex ||
          (startIndex === best.startIndex && normalizedAlias.length > best.normalizedAlias.length)
        ) {
          best = { ...candidate, normalizedAlias, startIndex, aliasWordCount: aliasWords.length }
        }
      }
    }
    if (!best) return null

    const message = stripRepeatedAgentFromMessage(best.agent, originalWords
      .slice(best.startIndex + best.aliasWordCount)
      .join(' ')
      .replace(/^[\s.,:;+\-]+/, '')
      .trim())

    return {
      agent: best.agent,
      message,
    }
  }

  function agentPrefixWordLimit() {
    return Number.isFinite(config.agentPrefixWordLimit)
      ? Math.max(1, Math.floor(config.agentPrefixWordLimit))
      : 3
  }

  function agentArmTimeoutMs() {
    return Number.isFinite(config.agentArmTimeoutMs)
      ? Math.max(0, config.agentArmTimeoutMs)
      : 30_000
  }

  function agentCandidates(candidateOptions = {}) {
    const includeAliases = candidateOptions.includeAliases !== false
    const agents = config.agents.length
      ? config.agents
      : ['Flux', 'Brock', 'Pike', 'Wolf']
    const aliases = []
    for (const agent of agents) {
      aliases.push({ agent, alias: agent })
      if (!includeAliases) continue
      for (const alias of defaultAgentAliases(agent)) {
        aliases.push({ agent, alias })
      }
    }
    return aliases
  }

  return {
    routeTranscript,
    parseIntent,
    preserveCommand,
    clearPendingAgent,
    getPendingAgent,
    routeDescription,
  }
}

function stripRepeatedAgentFromMessage(agent, message) {
  const normalizedAgent = normalizeCommandText(agent)
  if (!normalizedAgent) return normalizeTranscript(message).replace(/\s+/g, ' ').trim()

  const aliasWords = normalizedAgent.split(' ').filter(Boolean)
  const words = String(message || '').trim().split(/\s+/).filter(Boolean)
  const kept = []

  for (let index = 0; index < words.length;) {
    const normalizedSlice = words
      .slice(index, index + aliasWords.length)
      .map(word => normalizeCommandText(word))
      .filter(Boolean)

    if (
      normalizedSlice.length === aliasWords.length &&
      normalizedSlice.join(' ') === normalizedAgent
    ) {
      index += aliasWords.length
      continue
    }

    kept.push(words[index])
    index += 1
  }

  return kept
    .join(' ')
    .replace(/^[\s.,:;+\-]+/, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeTranscript(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function normalizeCommandText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function defaultAgentAliases(agent) {
  const normalized = normalizeCommandText(agent)
  if (normalized === 'flux') return ['flex']
  if (normalized === 'brock') return ['brook', 'block', 'rock']
  if (normalized === 'pike') return ['pipe']
  if (normalized === 'wolf') return ['wolfe']
  return []
}
