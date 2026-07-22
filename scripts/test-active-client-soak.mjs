import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const rootDir = resolve(new URL('..', import.meta.url).pathname)
const appDist = join(rootDir, 'app', 'dist')
const requireFromReceiver = createRequire(join(rootDir, 'local-receiver', 'package.json'))
const { WebSocket, WebSocketServer } = requireFromReceiver('ws')
const soakSeconds = positiveNumber(process.env.ACTIVE_SOAK_SECONDS, 60)
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const chromeProfile = mkdtempSync(join(tmpdir(), 'even-audio-pipe-soak-'))
const cleanupTasks = []

try {
  assert.ok(statSync(join(appDist, 'index.html')).isFile(), 'build app/dist before running the soak')
  const [appPort, receiverPort, debugPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ])
  const appServer = await startStaticServer(appPort)
  cleanupTasks.push(() => closeServer(appServer))
  const receiver = await startFakeReceiver(receiverPort)
  cleanupTasks.push(() => receiver.close())

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeProfile}`,
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let chromeErrors = ''
  chrome.stderr.on('data', chunk => {
    chromeErrors += chunk.toString()
  })
  cleanupTasks.push(async () => {
    if (chrome.exitCode === null) {
      chrome.kill('SIGTERM')
      await Promise.race([
        new Promise(resolveExit => chrome.once('exit', resolveExit)),
        delay(2_000),
      ])
    }
  })

  const target = await waitForPageTarget(debugPort, chrome, () => chromeErrors)
  const cdp = await createCdpClient(target.webSocketDebuggerUrl)
  cleanupTasks.push(() => cdp.close())
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Performance.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__evenAudioPipeFailNextRender = false;
      window.__evenAudioPipeRenderedContents = [];
      window.flutter_inappwebview = {
        callHandler: async (_handler, rawRequest) => {
          const request = typeof rawRequest === 'string'
            ? JSON.parse(rawRequest)
            : rawRequest;
          if (request?.method === 'getUserInfo') return null;
          if (request?.method === 'getLocalStorage') return '';
          if (request?.method === 'createStartUpPageContainer') return 0;
          if (request?.method === 'textContainerUpgrade') {
            if (window.__evenAudioPipeFailNextRender) {
              window.__evenAudioPipeFailNextRender = false;
              return false;
            }
            window.__evenAudioPipeRenderedContents.push(JSON.stringify(request));
            window.__evenAudioPipeRenderedContents =
              window.__evenAudioPipeRenderedContents.slice(-100);
          }
          return true;
        },
      };
    `,
  })
  await cdp.send('Page.navigate', {
    url: `http://127.0.0.1:${appPort}/?address=127.0.0.1:${receiverPort}`,
  })
  await waitForRuntime(cdp, `
    Boolean(
      window.__evenAudioPipeMemorySnapshot &&
      document.getElementById('stats')?.textContent?.includes('chunks')
    )
  `)
  await waitForCondition(() => receiver.starts() >= 1, 'initial receiver start')

  await cdp.evaluate('window.__evenAudioPipeFailNextRender = true')
  receiver.broadcast({
    type: 'transcript',
    historyId: 'render-failure-probe',
    text: 'render failure recovery probe',
  })
  await waitForRuntime(cdp, 'window.__evenAudioPipeMemorySnapshot().renderUnavailable === true')

  receiver.disconnectClients()
  await waitForCondition(() => receiver.starts() >= 2, 'receiver restart after render failure')
  await waitForRuntime(cdp, `
    window.__evenAudioPipeMemorySnapshot().receiverState === 'open' &&
    window.__evenAudioPipeMemorySnapshot().renderUnavailable === false
  `)

  const recoveredResponse = 'Pike response rendered after reconnect'
  const renderCountBeforeResponse = await cdp.evaluate(
    'window.__evenAudioPipeRenderedContents.length',
  )
  receiver.broadcast({
    type: 'agent_summary',
    agent: 'Pike',
    text: recoveredResponse,
    is_final: true,
    phase: 'final',
  })
  await waitForRuntime(
    cdp,
    `document.getElementById('transcript')?.textContent === ${JSON.stringify(recoveredResponse)}`,
  )
  await waitForRuntime(
    cdp,
    `window.__evenAudioPipeRenderedContents.length > ${renderCountBeforeResponse}`,
  )
  receiver.startTranscripts()

  const pcmBase64 = Buffer.alloc(3_200).toString('base64')
  await cdp.evaluate(`
    window.__activeSoakAudioEvents = 0;
    window.__activeSoakTimer = window.setInterval(() => {
      window._listenEvenAppMessage({
        type: 'listen_even_app_data',
        method: 'evenHubEvent',
        data: {
          type: 'audioEvent',
          jsonData: { audioPcm: '${pcmBase64}' },
        },
      });
      window.__activeSoakAudioEvents += 1;
    }, 10);
  `)

  const warmSeconds = Math.min(10, soakSeconds / 3)
  const measuredSeconds = soakSeconds - warmSeconds
  await delay(warmSeconds * 1_000)
  const warm = await sampleClient(cdp)
  await delay(measuredSeconds * 500)
  const midpoint = await sampleClient(cdp)
  await delay(measuredSeconds * 500)
  const final = await sampleClient(cdp)
  await cdp.evaluate('window.clearInterval(window.__activeSoakTimer)')

  const heapDelta = final.heapUsed - warm.heapUsed
  const lateHeapDelta = final.heapUsed - midpoint.heapUsed
  assert.ok(final.snapshot.historyEntries <= 100, 'active client history exceeded 100 entries')
  assert.ok(
    final.snapshot.suppressedSdkEventLogs >= final.audioEvents,
    'SDK per-event logging was not suppressed during continuous audio',
  )
  assert.ok(final.snapshot.socketBufferedBytes <= 64 * 1024, 'audio socket backlog exceeded 64 KiB')
  assert.ok(final.snapshot.historyCharacters <= 100 * 100, 'compact history retained oversized text')
  assert.ok(
    Object.values(final.snapshot.textCharacters).every(length => length <= 2_000),
    'live client text state exceeded its bounded container',
  )
  assert.ok(heapDelta < 8 * 1024 * 1024, `post-GC heap grew by ${heapDelta} bytes`)
  assert.ok(
    lateHeapDelta < 4 * 1024 * 1024,
    `post-GC heap kept growing in the second half by ${lateHeapDelta} bytes`,
  )

  console.log(JSON.stringify({
    activeSeconds: soakSeconds,
    audioEvents: final.audioEvents,
    transcriptsSent: receiver.transcriptsSent(),
    warmHeapBytes: warm.heapUsed,
    midpointHeapBytes: midpoint.heapUsed,
    finalHeapBytes: final.heapUsed,
    heapDeltaBytes: heapDelta,
    lateHeapDeltaBytes: lateHeapDelta,
    finalSnapshot: final.snapshot,
  }, null, 2))
} finally {
  for (const task of cleanupTasks.reverse()) {
    await task()
  }
  await delay(1_000)
  rmSync(chromeProfile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 200,
  })
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePort(address.port))
    })
  })
}

function startStaticServer(port) {
  const server = createServer((req, res) => {
    const requestPath = new URL(req.url || '/', 'http://localhost').pathname
    const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '')
    const path = resolve(appDist, relativePath)
    if (!path.startsWith(`${appDist}/`) && path !== join(appDist, 'index.html')) {
      res.writeHead(403)
      res.end()
      return
    }
    try {
      const body = readFileSync(path)
      res.writeHead(200, {
        'content-type': contentType(path),
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolveServer(server))
  })
}

function contentType(path) {
  if (extname(path) === '.html') return 'text/html; charset=utf-8'
  if (extname(path) === '.js') return 'text/javascript; charset=utf-8'
  if (extname(path) === '.css') return 'text/css; charset=utf-8'
  return 'application/octet-stream'
}

function startFakeReceiver(port) {
  let transcriptId = 0
  let startedClients = 0
  let transcriptsEnabled = false
  const intervals = new Set()
  const sockets = new Set()
  const server = new WebSocketServer({ host: '127.0.0.1', port })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      let control
      try {
        control = JSON.parse(data.toString())
      } catch {
        return
      }
      if (control.type !== 'start') return
      socket.send(JSON.stringify({
        type: 'auth_status',
        status: 'accepted',
        standby: false,
      }))
      socket.send(JSON.stringify({
        type: 'onboarding_prompt',
        message: 'Active soak',
      }))
      startedClients += 1
      const interval = setInterval(() => {
        if (!transcriptsEnabled || socket.readyState !== WebSocket.OPEN) return
        transcriptId += 1
        socket.send(JSON.stringify({
          type: 'transcript',
          historyId: `soak-${transcriptId}`,
          hasDetail: true,
          text: `...active transcript ${transcriptId} ${'x'.repeat(70)}`.slice(-100),
          createdAt: new Date().toISOString(),
        }))
      }, 25)
      intervals.add(interval)
      socket.once('close', () => {
        sockets.delete(socket)
        clearInterval(interval)
        intervals.delete(interval)
      })
    })
  })
  return new Promise((resolveServer, reject) => {
    server.once('listening', () => resolveServer({
      close: async () => {
        for (const interval of intervals) clearInterval(interval)
        await new Promise(resolveClose => server.close(resolveClose))
      },
      broadcast: payload => {
        for (const socket of sockets) {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
        }
      },
      disconnectClients: () => {
        for (const socket of sockets) socket.close(1012, 'render recovery probe')
      },
      startTranscripts: () => {
        transcriptsEnabled = true
      },
      starts: () => startedClients,
      transcriptsSent: () => transcriptId,
    }))
    server.once('error', reject)
  })
}

async function waitForPageTarget(port, chrome, chromeErrors) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(chrome.exitCode, null, `Chrome exited early:\n${chromeErrors()}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find(target => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
    }
    await delay(50)
  }
  throw new Error(`Chrome debugging target did not start:\n${chromeErrors()}`)
}

function createCdpClient(url) {
  return new Promise((resolveClient, reject) => {
    const socket = new WebSocket(url)
    let nextId = 0
    const pending = new Map()
    socket.on('open', () => resolveClient({
      send(method, params = {}) {
        const id = ++nextId
        socket.send(JSON.stringify({ id, method, params }))
        return new Promise((resolveResult, rejectResult) => {
          pending.set(id, { resolve: resolveResult, reject: rejectResult })
        })
      },
      evaluate(expression) {
        return this.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }).then(result => result.result?.value)
      },
      close() {
        socket.close()
      },
    }))
    socket.on('message', data => {
      const message = JSON.parse(data.toString())
      if (!message.id) return
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    })
    socket.once('error', reject)
  })
}

async function waitForRuntime(cdp, expression) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (await cdp.evaluate(expression)) return
    } catch {
    }
    await delay(100)
  }
  throw new Error('thin client did not initialize in Chrome')
}

async function waitForCondition(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await delay(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function sampleClient(cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  const metrics = await cdp.send('Performance.getMetrics')
  const heapUsed = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value
  assert.ok(Number.isFinite(heapUsed), 'Chrome did not report JS heap usage')
  return {
    heapUsed,
    snapshot: await cdp.evaluate('window.__evenAudioPipeMemorySnapshot()'),
    audioEvents: await cdp.evaluate('window.__activeSoakAudioEvents'),
  }
}

function closeServer(server) {
  return new Promise(resolveClose => server.close(resolveClose))
}
