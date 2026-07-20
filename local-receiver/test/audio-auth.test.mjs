import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocket } from 'ws'

const queuedSocketMessages = new WeakMap()

function authProof(secret, nonce) {
  return createHmac('sha256', secret).update(nonce).digest('base64url')
}

async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

async function startFakeWorkbench(responseForRequest = null) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    requests.push({
      method: req.method,
      path: req.url,
      body: text ? JSON.parse(text) : {},
    })
    const latest = requests.at(-1)
    const body = responseForRequest
      ? responseForRequest(latest)
      : {
        ok: true,
        agent: latest?.body?.agent || '',
        message: latest?.body?.message || '',
      }
    const response = JSON.stringify(body)
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(response),
    })
    res.end(response)
  })
  const port = await freePort()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function waitForHealth(port, child) {
  const url = `http://127.0.0.1:${port}/health`
  let lastError = ''
  for (let attempt = 0; attempt < 80; attempt += 1) {
    assert.equal(child.exitCode, null, `receiver exited early: ${child.stderrText}`)
    try {
      const res = await fetch(url)
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err.message
    }
    await delay(50)
  }
  throw new Error(`receiver did not become healthy: ${lastError}`)
}

async function startReceiver(env = {}, options = {}) {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'agent-audio-pipe-auth-'))
  const runtimeConfigPath = options.runtimeConfig ? join(dir, 'config.json') : ''
  if (options.runtimeConfig) {
    writeFileSync(runtimeConfigPath, `${JSON.stringify(options.runtimeConfig, null, 2)}\n`)
  }
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server.js'],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        PORT: String(port),
        AUDIO_DIR: join(dir, 'audio'),
        TRANSCRIPT_DIR: join(dir, 'transcripts'),
        TRANSCRIPTS_LOG: join(dir, 'transcripts', 'transcripts.log'),
        ASR_WORKER_URL: '',
        ASR_COMMAND: '',
        EVEN_AUDIO_PIPE_CONFIG_PATH: runtimeConfigPath,
        EVEN_AUDIO_PIPE_TOKEN: '',
        EVEN_AUDIO_PIPE_TOKEN_SECRET: '',
        SPEECH_WORKBENCH_ENABLED: '0',
        SPEECH_WORKBENCH_TOKEN: '',
        SPEECH_WORKBENCH_SUMMARY_TOKEN: '',
        TRANSCRIPT_CLEANUP_ENABLED: '0',
        TRANSCRIPT_CLEANUP_API_KEY: '',
        VAD_BACKEND: 'rms',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stderrText = ''
  child.stdoutText = ''
  child.stdout.on('data', chunk => {
    child.stdoutText += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    child.stderrText += chunk.toString()
  })
  await waitForHealth(port, child)
  return { child, dir, port }
}

async function stopReceiver(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/audio`)
    const queued = []
    queuedSocketMessages.set(ws, queued)
    ws.on('message', data => {
      try {
        queued.push(JSON.parse(data.toString()))
        if (queued.length > 200) queued.shift()
      } catch {
      }
    })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function waitForJson(ws, predicate, timeoutMs = 5_000) {
  const queued = queuedSocketMessages.get(ws) || []
  const queuedIndex = queued.findIndex(predicate)
  if (queuedIndex >= 0) {
    return Promise.resolve(queued.splice(queuedIndex, 1)[0])
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for websocket message'))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      ws.off('error', onError)
    }

    function onMessage(data) {
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!predicate(message)) return
      const bufferedIndex = queued.findIndex(predicate)
      if (bufferedIndex >= 0) message = queued.splice(bufferedIndex, 1)[0]
      cleanup()
      resolve(message)
    }

    function onClose(code, reason) {
      cleanup()
      reject(new Error(`socket closed before message: ${code} ${reason}`))
    }

    function onError(err) {
      cleanup()
      reject(err)
    }

    ws.on('message', onMessage)
    ws.on('close', onClose)
    ws.on('error', onError)
  })
}

function collectJson(ws, durationMs) {
  const messages = []

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve(messages)
    }, durationMs)

    function cleanup() {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('error', onError)
    }

    function onMessage(data) {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch {
      }
    }

    function onError(err) {
      cleanup()
      reject(err)
    }

    ws.on('message', onMessage)
    ws.on('error', onError)
  })
}

function waitForClose(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for websocket close'))
    }, 2_000)

    function cleanup() {
      clearTimeout(timeout)
      ws.off('close', onClose)
      ws.off('error', onError)
    }

    function onClose(code, reason) {
      cleanup()
      resolve({ code, reason: reason.toString() })
    }

    function onError(err) {
      cleanup()
      reject(err)
    }

    ws.on('close', onClose)
    ws.on('error', onError)
  })
}

async function waitForOutput(child, predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate(child.stdoutText)) return
    await delay(50)
  }
  throw new Error(`timed out waiting for receiver output: ${child.stdoutText}`)
}

function countOccurrences(value, pattern) {
  return (value.match(pattern) || []).length
}

function sendAudioChunks(ws, count, bytes = 3200) {
  for (let index = 0; index < count; index += 1) {
    ws.send(Buffer.alloc(bytes, 1))
  }
}

async function authenticateSharedSecretSocket(ws, secret) {
  const challenge = await waitForJson(ws, message => message.type === 'auth_challenge')
  ws.send(JSON.stringify({
    type: 'auth',
    nonce: challenge.nonce,
    proof: authProof(secret, challenge.nonce),
    algorithm: 'hmac-sha256',
  }))
  await waitForJson(ws, message => (
    message.type === 'auth_status' &&
    message.status === 'accepted' &&
    message.transport === true
  ))
}

test('receiver sends onboarding prompt after app start and logs audio stream', async () => {
  const { child, dir, port } = await startReceiver()

  try {
    const ws = await openSocket(port)
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'mock-user' },
    }))

    const prompt = await waitForJson(ws, message => message.type === 'onboarding_prompt')
    assert.equal(prompt.message, 'Say something to get started.')

    const duplicateMessages = collectJson(ws, 150)
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'mock-user' },
    }))
    assert.equal(
      (await duplicateMessages).some(message => message.type === 'onboarding_prompt'),
      false,
    )

    ws.send(Buffer.alloc(320))
    await waitForOutput(child, output => output.includes('[audio] stream started: receiving G2 mic chunks'))
    ws.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver fulfills a history request made before Even user authentication', async () => {
  const { child, dir, port } = await startReceiver({}, {
    runtimeConfig: {
      auth: {
        allowedUserIds: ['history-user'],
      },
    },
  })

  try {
    const now = new Date()
    const dateStamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-')
    writeFileSync(
      join(dir, 'transcripts', 'message-history', `${dateStamp}.jsonl`),
      `${JSON.stringify({
        id: 'today-history-entry',
        label: 'You',
        text: 'Today history reaches the thin client.',
        receivedAt: now.getTime(),
        createdAt: now.toISOString(),
      })}\n`,
    )

    const ws = await openSocket(port)
    const beforeAuth = collectJson(ws, 150)
    ws.send(JSON.stringify({ type: 'get_message_history' }))
    assert.equal(
      (await beforeAuth).some(message => message.type === 'message_history'),
      false,
    )

    const historyResponse = waitForJson(ws, message => message.type === 'message_history')
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'history-user' },
    }))

    const history = await historyResponse
    assert.equal(history.date, dateStamp)
    assert.deepEqual(history.entries.map(entry => entry.text), [
      'Today history reaches the thin client.',
    ])
    assert.match(child.stdoutText, /\[history\] queued request until Even user authentication/)
    ws.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver keeps current audio socket active for the same Even user', async () => {
  const { child, dir, port } = await startReceiver()

  try {
    const first = await openSocket(port)
    first.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await waitForJson(first, message => message.type === 'onboarding_prompt')
    sendAudioChunks(first, 6)
    await waitForOutput(child, output => output.includes('[audio] stream started: receiving G2 mic chunks'))

    const second = await openSocket(port)
    const standbyStatus = waitForJson(second, message => (
      message.type === 'receiver_status' &&
      message.status === 'standby' &&
      message.reason === 'active_socket_has_audio'
    ))
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))

    await standbyStatus
    await delay(150)
    assert.equal(first.readyState, WebSocket.OPEN)
    assert.equal(second.readyState, WebSocket.OPEN)
    assert.match(child.stdoutText, /\[audio\] keeping active socket for uid:same-user/)
    assert.doesNotMatch(child.stdoutText, /active audio socket already connected/)
    first.close()
    second.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver ignores simultaneous standby audio without switching active sockets', async () => {
  const { child, dir, port } = await startReceiver()

  try {
    const first = await openSocket(port)
    first.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await waitForJson(first, message => message.type === 'onboarding_prompt')
    sendAudioChunks(first, 6)
    await waitForOutput(child, output => output.includes('[audio] stream started: receiving G2 mic chunks'))

    const second = await openSocket(port)
    const standbyStatus = waitForJson(second, message => (
      message.type === 'receiver_status' &&
      message.status === 'standby' &&
      message.reason === 'active_socket_has_audio'
    ))
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await standbyStatus

    for (let index = 0; index < 12; index += 1) {
      first.send(Buffer.alloc(3200, 1))
      second.send(Buffer.alloc(3200, 1))
      await delay(10)
    }
    await delay(100)

    assert.equal(first.readyState, WebSocket.OPEN)
    assert.equal(second.readyState, WebSocket.OPEN)
    assert.equal(
      countOccurrences(child.stdoutText, /\[audio\] stream started: receiving G2 mic chunks/g),
      1,
    )
    assert.doesNotMatch(child.stdoutText, /switching active socket for uid:same-user on audio chunk/)
    first.close()
    second.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver emits one queued transcript when duplicate sockets send the same audio', async () => {
  const { child, dir, port } = await startReceiver({
    ASR_COMMAND: "printf 'single queued transcript'",
    ASR_CHUNK_MODE: 'fixed',
    ASR_SEGMENT_SECONDS: '0.01',
    MIN_ASR_BYTES: '1',
    TRANSCRIPT_QUEUE_IDLE_MS: '60000',
  })

  try {
    const first = await openSocket(port)
    first.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await waitForJson(first, message => message.type === 'onboarding_prompt')

    const second = await openSocket(port)
    const secondPrompt = waitForJson(second, message => message.type === 'onboarding_prompt')
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await secondPrompt

    const firstMessages = collectJson(first, 500)
    const secondMessages = collectJson(second, 500)
    first.send(Buffer.alloc(320, 1))
    second.send(Buffer.alloc(320, 1))
    const messages = [...await firstMessages, ...await secondMessages]
    const queued = messages.filter(message => (
      message.type === 'asr_status' && message.status === 'queued'
    ))

    assert.equal(queued.length, 1)
    assert.equal(queued[0].queuedText, 'single queued transcript')
    assert.equal(countOccurrences(child.stdoutText, /\[asr\] request queued job=/g), 1)
    assert.doesNotMatch(child.stdoutText, /switching active socket for uid:same-user on audio chunk/)
    first.close()
    second.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver lets newer socket replace zero-audio same-user socket inside start grace', async () => {
  const secret = 'local-test-secret'
  const { child, dir, port } = await startReceiver({
    EVEN_AUDIO_PIPE_TOKEN_SECRET: secret,
  })

  try {
    const first = await openSocket(port)
    await authenticateSharedSecretSocket(first, secret)
    const firstPrompt = waitForJson(first, message => message.type === 'onboarding_prompt')
    first.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await firstPrompt.catch(err => {
      throw new Error(`original socket did not start: ${err.message}\n${child.stdoutText}\n${child.stderrText}`)
    })

    const second = await openSocket(port)
    await authenticateSharedSecretSocket(second, secret)
    const secondPrompt = waitForJson(second, message => message.type === 'onboarding_prompt')
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))

    await secondPrompt
    await delay(150)
    assert.equal(first.readyState, WebSocket.OPEN)
    assert.equal(second.readyState, WebSocket.OPEN)
    assert.match(child.stdoutText, /\[audio\] switching active socket for uid:same-user/)
    assert.match(child.stdoutText, /previousBytes=0 previousChunks=0/)
    assert.doesNotMatch(child.stdoutText, /newer audio socket active/)
    first.close()
    second.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver lets newer socket replace weak one-chunk same-user socket', async () => {
  const { child, dir, port } = await startReceiver({
    RECEIVER_ACTIVE_AUDIO_SOCKET_START_GRACE_MS: '1',
  })

  try {
    const first = await openSocket(port)
    first.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await waitForJson(first, message => message.type === 'onboarding_prompt')
    first.send(Buffer.alloc(1600, 1))
    await waitForOutput(child, output => output.includes('[audio] stream started: receiving G2 mic chunks'))
    await delay(20)

    const second = await openSocket(port)
    const secondPrompt = waitForJson(second, message => message.type === 'onboarding_prompt')
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))

    await secondPrompt
    await delay(150)
    assert.equal(first.readyState, WebSocket.OPEN)
    assert.equal(second.readyState, WebSocket.OPEN)
    assert.match(child.stdoutText, /\[audio\] switching active socket for uid:same-user/)
    second.close()
    first.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver lets newer socket replace a stale same-user socket before audio starts', async () => {
  const { child, dir, port } = await startReceiver({
    RECEIVER_ACTIVE_AUDIO_SOCKET_START_GRACE_MS: '1',
  })

  try {
    const first = await openSocket(port)
    first.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await waitForJson(first, message => message.type === 'onboarding_prompt')
    await delay(20)

    const second = await openSocket(port)
    const secondPrompt = waitForJson(second, message => message.type === 'onboarding_prompt')
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))

    await secondPrompt
    await delay(150)
    assert.equal(first.readyState, WebSocket.OPEN)
    assert.equal(second.readyState, WebSocket.OPEN)
    assert.match(child.stdoutText, /\[audio\] switching active socket for uid:same-user/)
    second.close()
    first.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver closes an open socket when audio chunks stall', async () => {
  const { child, dir, port } = await startReceiver({
    RECEIVER_STALLED_AUDIO_CLOSE_MS: '250',
  })

  try {
    const ws = await openSocket(port)
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'stalled-user' },
    }))
    await waitForJson(ws, message => message.type === 'onboarding_prompt')
    ws.send(Buffer.alloc(320))
    await waitForOutput(child, output => output.includes('[audio] stream started: receiving G2 mic chunks'))

    const retryStatus = waitForJson(ws, message => (
      message.type === 'receiver_status' &&
      message.status === 'retry_listen' &&
      message.reason === 'audio_stream_stalled'
    ))
    const close = await waitForClose(ws)
    await retryStatus
    assert.equal(close.code, 4002)
    assert.equal(close.reason, 'audio stream stalled')
    assert.match(child.stderrText, /\[audio\] retry listen: reason=audio_stream_stalled/)
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver keeps an ignored standby socket open while active audio continues', async () => {
  const { child, dir, port } = await startReceiver({
    RECEIVER_STALLED_AUDIO_CLOSE_MS: '1000',
  })

  try {
    const first = await openSocket(port)
    first.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await waitForJson(first, message => message.type === 'onboarding_prompt')
    sendAudioChunks(first, 6)
    await waitForOutput(child, output => output.includes('[audio] stream started: receiving G2 mic chunks'))

    const second = await openSocket(port)
    const standbyStatus = waitForJson(second, message => (
      message.type === 'receiver_status' &&
      message.status === 'standby' &&
      message.reason === 'active_socket_has_audio'
    ))
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))
    await standbyStatus

    for (let index = 0; index < 15; index += 1) {
      first.send(Buffer.alloc(3200, 1))
      second.send(Buffer.alloc(3200, 1))
      await delay(100)
    }

    assert.equal(first.readyState, WebSocket.OPEN)
    assert.equal(second.readyState, WebSocket.OPEN)
    assert.equal(
      countOccurrences(child.stdoutText, /\[audio\] stream started: receiving G2 mic chunks/g),
      1,
    )
    assert.doesNotMatch(child.stdoutText, /switching active socket for uid:same-user on audio chunk/)
    assert.doesNotMatch(child.stdoutText, /retry listen: reason=audio_stream_stalled/)
    assert.doesNotMatch(child.stdoutText, /closed: code=4002/)
    first.close()
    second.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver forwards peek progress as a local workbench message', async () => {
  const workbench = await startFakeWorkbench()
  const { child, dir, port } = await startReceiver({
    SPEECH_WORKBENCH_ENABLED: '1',
    SPEECH_WORKBENCH_URL: workbench.url,
    SPEECH_WORKBENCH_AGENTS: 'flux,pike',
  })

  try {
    const ws = await openSocket(port)
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'mock-user' },
    }))
    await waitForJson(ws, message => message.type === 'onboarding_prompt')

    const sent = waitForJson(ws, message => (
      message.type === 'agent_status' &&
      message.status === 'sent' &&
      message.requestType === 'local'
    ))
    ws.send(JSON.stringify({
      type: 'peek_progress',
      agent: 'flux',
    }))

    const message = await sent
    assert.equal(message.agent, 'Flux')
    assert.equal(workbench.requests.length, 1)
    assert.equal(workbench.requests[0].method, 'POST')
    assert.equal(workbench.requests[0].path, '/messages')
    assert.deepEqual(workbench.requests[0].body, {
      type: 'local',
      agent: 'Flux',
      message: 'progress_summary',
    })
    ws.close()
  } finally {
    await stopReceiver(child)
    await workbench.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver sends local progress summary response back to glasses', async () => {
  const workbench = await startFakeWorkbench(request => ({
    ok: true,
    type: 'local',
    sent: false,
    agent: request.body.agent.toLowerCase(),
    message: request.body.message,
    summary: 'Pike updated the paused voice session tips layout.',
    detail: 'removed Sim show logo\nmoved tips to bottom\nremoved Session in progress',
    detail_lines: [
      'removed Sim show logo',
      'moved tips to bottom',
      'removed Session in progress',
    ],
    phase: 'in_progress',
  }))
  const { child, dir, port } = await startReceiver({
    SPEECH_WORKBENCH_ENABLED: '1',
    SPEECH_WORKBENCH_URL: workbench.url,
    SPEECH_WORKBENCH_AGENTS: 'flux,pike',
  })

  try {
    const ws = await openSocket(port)
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'mock-user' },
    }))
    await waitForJson(ws, message => message.type === 'onboarding_prompt')

    const summary = waitForJson(ws, message => (
      message.type === 'agent_summary' &&
      message.agent === 'Pike'
    ))
    ws.send(JSON.stringify({
      type: 'peek_progress',
      agent: 'pike',
    }))

    const message = await summary
    assert.equal(message.agent, 'Pike')
    assert.equal(workbench.requests[0].body.agent, 'Pike')
    assert.equal(message.text, 'Pike updated the paused voice session tips layout.')
    assert.equal(message.summary, undefined)
    assert.equal(message.detail, undefined)
    assert.equal(message.hasDetail, true)
    assert.ok(message.historyId)
    const detailResponse = waitForJson(ws, response => response.type === 'message_history_detail')
    ws.send(JSON.stringify({
      type: 'get_message_history_detail',
      ids: [message.historyId],
    }))
    assert.equal(
      (await detailResponse).entries[0].detail,
      'removed Sim show logo\nmoved tips to bottom\nremoved Session in progress',
    )
    assert.equal(message.phase, 'in_progress')
    assert.equal(message.is_final, false)

    const duplicateMessages = collectJson(ws, 150)
    const duplicateWebhook = await fetch(`http://127.0.0.1:${port}/workbench/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'Pike',
        summary: 'Pike updated the paused voice session tips layout.',
        detail: 'removed Sim show logo\nmoved tips to bottom\nremoved Session in progress',
        phase: 'in_progress',
      }),
    })
    assert.equal(duplicateWebhook.ok, true)
    assert.equal(
      (await duplicateMessages).filter(item => item.type === 'agent_summary' && item.agent === 'Pike').length,
      0,
    )
    ws.close()
  } finally {
    await stopReceiver(child)
    await workbench.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver reports only in-progress workbench agents as active', async () => {
  const { child, dir, port } = await startReceiver({
    SPEECH_WORKBENCH_ENABLED: '1',
    SPEECH_WORKBENCH_AGENTS: 'flux,pike',
  })

  try {
    const ws = await openSocket(port)
    const status = await waitForJson(ws, message => message.type === 'receiver_status')
    assert.deepEqual(status.workbench.activeAgents, [])

    const active = waitForJson(ws, message => (
      message.type === 'workbench_status' &&
      message.workbench?.activeAgents?.includes('Flux')
    ))
    const inProgress = await fetch(`http://127.0.0.1:${port}/workbench/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'flux',
        summary: 'Flux is running tests.',
        phase: 'in_progress',
      }),
    })
    assert.equal(inProgress.ok, true)
    assert.deepEqual((await active).workbench.activeAgents, ['Flux'])

    const inactive = waitForJson(ws, message => (
      message.type === 'workbench_status' &&
      Array.isArray(message.workbench?.activeAgents) &&
      message.workbench.activeAgents.length === 0
    ))
    const final = await fetch(`http://127.0.0.1:${port}/workbench/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'FLUX',
        summary: 'Flux finished the tests.',
        phase: 'final',
        is_final: true,
      }),
    })
    assert.equal(final.ok, true)
    assert.deepEqual((await inactive).workbench.activeAgents, [])
    ws.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver clears stale in-progress workbench agents with no new content', async () => {
  const { child, dir, port } = await startReceiver({
    SPEECH_WORKBENCH_ENABLED: '1',
    SPEECH_WORKBENCH_AGENTS: 'Flux,Pike',
    SPEECH_WORKBENCH_PROGRESS_STALE_MS: '80',
  })

  try {
    const ws = await openSocket(port)
    const active = waitForJson(ws, message => (
      message.type === 'workbench_status' &&
      message.workbench?.activeAgents?.includes('Flux')
    ))
    const inProgress = await fetch(`http://127.0.0.1:${port}/workbench/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'Flux',
        summary: 'Flux is running tests.',
        detail: 'npm test\n72 passed',
        phase: 'in_progress',
      }),
    })
    assert.equal(inProgress.ok, true)
    assert.deepEqual((await active).workbench.activeAgents, ['Flux'])

    const inactive = await waitForJson(ws, message => (
      message.type === 'workbench_status' &&
      Array.isArray(message.workbench?.activeAgents) &&
      message.workbench.activeAgents.length === 0
    ))
    assert.deepEqual(inactive.workbench.activeAgents, [])
    ws.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shared-secret websocket auth accepts a valid HMAC proof', async () => {
  const secret = 'local-test-secret'
  const { child, dir, port } = await startReceiver({
    EVEN_AUDIO_PIPE_TOKEN: '',
    EVEN_AUDIO_PIPE_TOKEN_SECRET: secret,
  })

  try {
    const ws = await openSocket(port)
    const challenge = await waitForJson(ws, message => message.type === 'auth_challenge')
    assert.equal(challenge.mode, 'shared-secret')
    assert.equal(challenge.algorithm, 'hmac-sha256')

    ws.send(JSON.stringify({
      type: 'auth',
      nonce: challenge.nonce,
      proof: authProof(secret, challenge.nonce),
      algorithm: 'hmac-sha256',
    }))

    const accepted = await waitForJson(ws, message => (
      message.type === 'auth_status' &&
      message.status === 'accepted' &&
      message.transport === true
    ))
    assert.equal(accepted.mode, 'shared-secret')
    ws.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver handles repeated authenticated audio reconnect cycles', async () => {
  const secret = 'local-test-secret'
  const { child, dir, port } = await startReceiver({
    EVEN_AUDIO_PIPE_TOKEN: '',
    EVEN_AUDIO_PIPE_TOKEN_SECRET: secret,
  })

  try {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const ws = await openSocket(port)
      const challenge = await waitForJson(ws, message => message.type === 'auth_challenge')
      ws.send(JSON.stringify({
        type: 'auth',
        nonce: challenge.nonce,
        proof: authProof(secret, challenge.nonce),
        algorithm: 'hmac-sha256',
      }))
      await waitForJson(ws, message => (
        message.type === 'auth_status' &&
        message.status === 'accepted' &&
        message.transport === true
      ))
      ws.send(JSON.stringify({
        type: 'start',
        source: 'g2',
        encoding: 'pcm_s16le',
        sampleRate: 16000,
        channels: 1,
        user: { id: 'cycle-user' },
      }))
      await waitForJson(ws, message => message.type === 'onboarding_prompt')
      ws.send(Buffer.alloc(320))
      await waitForOutput(child, output => (
        countOccurrences(output, /\[audio\] stream started: receiving G2 mic chunks/g) >= cycle + 1
      ))
      const closed = waitForClose(ws)
      ws.close()
      await closed
      await delay(25)
    }

    assert.doesNotMatch(child.stderrText, /shared-secret auth timed out/)
    assert.doesNotMatch(child.stdoutText, /active audio socket already connected|newer audio socket active/)
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver buffers audio that arrives after auth before start', async () => {
  const secret = 'local-test-secret'
  const { child, dir, port } = await startReceiver({
    EVEN_AUDIO_PIPE_TOKEN: '',
    EVEN_AUDIO_PIPE_TOKEN_SECRET: secret,
  })

  try {
    const ws = await openSocket(port)
    const challenge = await waitForJson(ws, message => message.type === 'auth_challenge')
    ws.send(JSON.stringify({
      type: 'auth',
      nonce: challenge.nonce,
      proof: authProof(secret, challenge.nonce),
      algorithm: 'hmac-sha256',
    }))
    await waitForJson(ws, message => (
      message.type === 'auth_status' &&
      message.status === 'accepted' &&
      message.transport === true
    ))
    ws.send(Buffer.alloc(320))
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'early-audio-user' },
    }))

    await waitForJson(ws, message => message.type === 'onboarding_prompt')
    await waitForOutput(child, output => output.includes('[audio] stream started: receiving G2 mic chunks'))
    assert.doesNotMatch(child.stderrText, /rejected audio before Even user start message/)
    assert.equal(ws.readyState, WebSocket.OPEN)
    ws.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver delivers transcript from closed socket audio to current user socket', async () => {
  const secret = 'local-test-secret'
  const { child, dir, port } = await startReceiver({
    ASR_COMMAND: "printf 'simulated transcript'",
    ASR_CHUNK_MODE: 'fixed',
    MIN_ASR_BYTES: '1',
    TRANSCRIPT_QUEUE_IDLE_MS: '500',
    TRANSCRIPT_CLEANUP_ENABLED: '0',
    EVEN_AUDIO_PIPE_TOKEN: '',
    EVEN_AUDIO_PIPE_TOKEN_SECRET: secret,
  })

  try {
    const first = await openSocket(port)
    await authenticateSharedSecretSocket(first, secret)
    const firstPrompt = waitForJson(first, message => message.type === 'onboarding_prompt')
    first.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'reroute-user' },
    }))
    await firstPrompt.catch(err => {
      throw new Error(`original reroute socket did not start: ${err.message}\n${child.stdoutText}\n${child.stderrText}`)
    })
    sendAudioChunks(first, 3)
    await waitForOutput(child, output => output.includes('[audio] stream started: receiving G2 mic chunks'))
    const firstClosed = waitForClose(first)
    first.close()
    await firstClosed

    const second = await openSocket(port)
    await authenticateSharedSecretSocket(second, secret)
    const secondStarted = waitForJson(second, message => (
      message.type === 'onboarding_prompt' ||
      (message.type === 'receiver_status' && message.status === 'standby')
    ))
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'reroute-user' },
    }))
    await secondStarted.catch(err => {
      throw new Error(`replacement socket did not start: ${err.message}\n${child.stdoutText}`)
    })

    const transcript = await waitForJson(second, message => message.type === 'transcript', 10_000)
      .catch(err => {
        throw new Error(`replacement socket did not receive transcript: ${err.message}\n${child.stdoutText}\n${child.stderrText}`)
      })
    assert.equal(transcript.text, 'simulated transcript')
    assert.match(child.stdoutText, /\[thin-client\] rerouting send/)
    second.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver flushes a queued transcript immediately when the client taps', async () => {
  const { child, dir, port } = await startReceiver({
    ASR_COMMAND: "printf 'tap flushed transcript'",
    ASR_CHUNK_MODE: 'fixed',
    ASR_SEGMENT_SECONDS: '0.01',
    MIN_ASR_BYTES: '1',
    TRANSCRIPT_QUEUE_IDLE_MS: '60000',
    TRANSCRIPT_QUEUE_MAX_HOLD_MS: '60000',
    TRANSCRIPT_CLEANUP_ENABLED: '0',
  })

  try {
    const ws = await openSocket(port)
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'tap-user' },
    }))
    await waitForJson(ws, message => message.type === 'onboarding_prompt')

    const queued = waitForJson(ws, message => (
      message.type === 'asr_status' && message.status === 'queued'
    ))
    ws.send(Buffer.alloc(320, 1))
    const queuedMessage = await queued
    assert.equal(queuedMessage.queuedText, 'tap flushed transcript')
    assert.equal(queuedMessage.text, undefined)

    const transcript = waitForJson(ws, message => message.type === 'transcript')
    ws.send(JSON.stringify({ type: 'flush_transcript_queue' }))
    const transcriptMessage = await transcript
    assert.equal(transcriptMessage.text, 'tap flushed transcript')
    assert.equal(transcriptMessage.rawText, undefined)
    assert.equal(transcriptMessage.cleanedText, undefined)
    assert.equal(transcriptMessage.cleanup, undefined)
    assert.ok(transcriptMessage.historyId)
    assert.match(child.stdoutText, /\[transcript-queue\] flush requested by client/)
    ws.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('receiver asks cleanup to normalize contextual N to N variants as end-to-end', async () => {
  const cleanup = await startFakeWorkbench(() => ({
    choices: [{
      finish_reason: 'stop',
      message: {
        content: 'Verify the end-to-end workflow.',
      },
    }],
  }))
  const { child, dir, port } = await startReceiver({
    ASR_COMMAND: "printf 'Verify the N to N workflow.'",
    ASR_CHUNK_MODE: 'fixed',
    ASR_SEGMENT_SECONDS: '0.01',
    MIN_ASR_BYTES: '1',
    TRANSCRIPT_QUEUE_IDLE_MS: '10',
    TRANSCRIPT_QUEUE_MAX_HOLD_MS: '1000',
    TRANSCRIPT_CLEANUP_ENABLED: '1',
    TRANSCRIPT_CLEANUP_URL: cleanup.url,
    TRANSCRIPT_CLEANUP_MODEL: 'test-model',
  })

  try {
    const ws = await openSocket(port)
    ws.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'cleanup-user' },
    }))
    await waitForJson(ws, message => message.type === 'onboarding_prompt')

    const transcript = waitForJson(ws, message => message.type === 'transcript')
    ws.send(Buffer.alloc(320, 1))
    assert.equal((await transcript).text, 'Verify the end-to-end workflow.')

    const systemPrompt = cleanup.requests[0]?.body?.messages?.[0]?.content || ''
    assert.match(systemPrompt, /"N to N".*"end-to-end"/s)
    assert.match(systemPrompt, /Do not rewrite literal letters, ranges, or unrelated uses/)
    ws.close()
  } finally {
    await stopReceiver(child)
    await cleanup.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shared-secret websocket auth rejects a bad HMAC proof', async () => {
  const { child, dir, port } = await startReceiver({
    EVEN_AUDIO_PIPE_TOKEN: '',
    EVEN_AUDIO_PIPE_TOKEN_SECRET: 'local-test-secret',
  })

  try {
    const ws = await openSocket(port)
    const challenge = await waitForJson(ws, message => message.type === 'auth_challenge')
    ws.send(JSON.stringify({
      type: 'auth',
      nonce: challenge.nonce,
      proof: 'bad-proof',
      algorithm: 'hmac-sha256',
    }))
    const rejected = await waitForJson(ws, message => (
      message.type === 'auth_status' &&
      message.status === 'rejected'
    ))
    assert.equal(rejected.reason, 'bad_proof')
    ws.close()
  } finally {
    await stopReceiver(child)
    rmSync(dir, { recursive: true, force: true })
  }
})
