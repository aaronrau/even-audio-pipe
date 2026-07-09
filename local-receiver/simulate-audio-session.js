#!/usr/bin/env node
import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'

const options = parseArgs(process.argv.slice(2))

for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
  const url = withClientConnectionParams(options.url, options.clientSessionId, cycle)
  console.log(`[simulate] cycle ${cycle}/${options.cycles}: connecting ${url}`)
  const socket = await openSocket(url)
  let started = false
  let transcripts = 0

  socket.on('message', data => {
    if (typeof data !== 'string' && !Buffer.isBuffer(data)) return
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }

    if (message.type === 'auth_challenge') {
      if (!options.secret) {
        console.warn('[simulate] auth challenge received but --secret was not provided')
        return
      }
      socket.send(JSON.stringify({
        type: 'auth',
        nonce: message.nonce,
        proof: authProof(options.secret, message.nonce),
        algorithm: 'hmac-sha256',
      }))
      return
    }

    if (message.type === 'auth_status' && message.status === 'accepted' && !started) {
      if (options.earlyAudio) socket.send(makePcmChunk(0, options.chunkMs, options.amplitude))
      sendStart(socket, options, cycle)
      started = true
      return
    }

    if (message.type === 'transcript') {
      transcripts += 1
      console.log(`[simulate] transcript ${transcripts}: ${String(message.text || '').slice(0, 120)}`)
      return
    }

    if (message.type === 'asr_status') {
      console.log(`[simulate] asr_status=${message.status || 'unknown'} job=${message.jobId || ''}`)
    }
  })

  if (!options.secret) {
    sendStart(socket, options, cycle)
    started = true
  }

  await waitFor(() => started, options.startTimeoutMs, 'start handshake')

  for (let index = 0; index < options.speechChunks; index += 1) {
    socket.send(makePcmChunk(index, options.chunkMs, options.amplitude))
    await delay(options.chunkDelayMs)
  }

  for (let index = 0; index < options.silenceChunks; index += 1) {
    socket.send(Buffer.alloc(chunkBytes(options.chunkMs)))
    await delay(options.chunkDelayMs)
  }

  await delay(options.settleMs)
  socket.close(1000, 'simulation cycle complete')
  await waitForClose(socket)
}

console.log('[simulate] complete')

function sendStart(socket, opts, cycle) {
  socket.send(JSON.stringify({
    type: 'start',
    source: 'simulator',
    encoding: 'pcm_s16le',
    sampleRate: 16000,
    channels: 1,
    user: { id: opts.userId },
    clientSessionId: opts.clientSessionId,
    connectionAttempt: cycle,
  }))
  console.log(`[simulate] start sent user=${opts.userId}`)
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function withClientConnectionParams(url, clientSessionId, connectionAttempt) {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('clientSessionId', clientSessionId)
    parsed.searchParams.set('connectionAttempt', String(connectionAttempt))
    return parsed.toString()
  } catch {
    return url
  }
}

function waitForClose(socket) {
  return new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    socket.once('close', resolve)
  })
}

async function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await delay(25)
  }
}

function authProof(secret, nonce) {
  return createHmac('sha256', secret).update(nonce).digest('base64url')
}

function makePcmChunk(offset, chunkMs, amplitude) {
  const samples = Math.floor((16_000 * chunkMs) / 1000)
  const buffer = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.floor(Math.sin((offset * samples + index) / 8) * amplitude)
    buffer.writeInt16LE(sample, index * 2)
  }
  return buffer
}

function chunkBytes(chunkMs) {
  return Math.floor((16_000 * chunkMs) / 1000) * 2
}

function parseArgs(values) {
  const parsed = {
    url: process.env.SIM_AUDIO_WS_URL || 'ws://127.0.0.1:8788/audio',
    secret: process.env.EVEN_AUDIO_PIPE_TOKEN_SECRET || '',
    userId: process.env.SIM_AUDIO_USER_ID || 'simulated-user',
    cycles: Number(process.env.SIM_AUDIO_CYCLES || 2),
    speechChunks: Number(process.env.SIM_AUDIO_SPEECH_CHUNKS || 80),
    silenceChunks: Number(process.env.SIM_AUDIO_SILENCE_CHUNKS || 30),
    chunkMs: Number(process.env.SIM_AUDIO_CHUNK_MS || 20),
    chunkDelayMs: Number(process.env.SIM_AUDIO_CHUNK_DELAY_MS || 20),
    settleMs: Number(process.env.SIM_AUDIO_SETTLE_MS || 4_000),
    startTimeoutMs: Number(process.env.SIM_AUDIO_START_TIMEOUT_MS || 5_000),
    amplitude: Number(process.env.SIM_AUDIO_AMPLITUDE || 6000),
    earlyAudio: false,
    clientSessionId: `sim-${Date.now().toString(36)}`,
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--url') parsed.url = values[++index] || parsed.url
    else if (value === '--secret') parsed.secret = values[++index] || ''
    else if (value === '--user-id') parsed.userId = values[++index] || parsed.userId
    else if (value === '--cycles') parsed.cycles = Number(values[++index] || parsed.cycles)
    else if (value === '--speech-chunks') parsed.speechChunks = Number(values[++index] || parsed.speechChunks)
    else if (value === '--silence-chunks') parsed.silenceChunks = Number(values[++index] || parsed.silenceChunks)
    else if (value === '--chunk-ms') parsed.chunkMs = Number(values[++index] || parsed.chunkMs)
    else if (value === '--chunk-delay-ms') parsed.chunkDelayMs = Number(values[++index] || parsed.chunkDelayMs)
    else if (value === '--settle-ms') parsed.settleMs = Number(values[++index] || parsed.settleMs)
    else if (value === '--early-audio') parsed.earlyAudio = true
  }

  return parsed
}
