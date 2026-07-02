import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
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
  child.stdout.on('data', () => {})
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
