import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocket } from 'ws'

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

async function startReceiver(env = {}) {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'agent-audio-pipe-auth-'))
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
        EVEN_AUDIO_PIPE_CONFIG_PATH: '',
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
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function waitForJson(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for websocket message'))
    }, 2_000)

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
    first.send(Buffer.alloc(320))
    await waitForOutput(child, output => output.includes('[audio] stream started: receiving G2 mic chunks'))

    const second = await openSocket(port)
    const secondClose = waitForClose(second)
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))

    const close = await secondClose
    assert.equal(close.code, 4001)
    assert.equal(close.reason, 'active audio socket already connected')

    await delay(150)
    assert.equal(first.readyState, WebSocket.OPEN)
    assert.match(child.stdoutText, /\[audio\] keeping active socket for uid:same-user/)
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
    const firstClose = waitForClose(first)
    const secondPrompt = waitForJson(second, message => message.type === 'onboarding_prompt')
    second.send(JSON.stringify({
      type: 'start',
      source: 'g2',
      encoding: 'pcm_s16le',
      sampleRate: 16000,
      channels: 1,
      user: { id: 'same-user' },
    }))

    const close = await firstClose
    assert.equal(close.code, 4001)
    assert.equal(close.reason, 'newer audio socket active')
    await secondPrompt
    assert.match(child.stdoutText, /\[audio\] replacing active socket for uid:same-user/)
    second.close()
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

    const close = await waitForClose(ws)
    assert.equal(close.code, 4002)
    assert.equal(close.reason, 'audio stream stalled')
    assert.match(child.stderrText, /\[audio\] stalled: no chunks/)
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
    assert.equal(message.summary, 'Pike updated the paused voice session tips layout.')
    assert.equal(
      message.detail,
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
