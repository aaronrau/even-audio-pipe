import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(rootDir, 'app')
const receiverDir = join(rootDir, 'local-receiver')
const asrWorkerDir = join(rootDir, 'asr-worker')
const localAsrPython = process.platform === 'win32'
  ? join(asrWorkerDir, '.venv', 'Scripts', 'python.exe')
  : join(asrWorkerDir, '.venv', 'bin', 'python')
const config = loadConfig()
const storageConfig = resolveStorageConfig(config.storage)

const hostIp = process.env.EVEN_AUDIO_PIPE_HOST || detectHostIp()
const appPort = Number(process.env.EVEN_AUDIO_PIPE_APP_PORT || 5173)
const receiverPort = Number(process.env.EVEN_AUDIO_PIPE_RECEIVER_PORT || 8787)
const asrPort = Number(process.env.EVEN_AUDIO_PIPE_ASR_PORT || 8790)
const asrEnabled = !isDisabled(process.env.EVEN_AUDIO_PIPE_ASR ?? '1')
const asrWorkerUrl = process.env.ASR_WORKER_URL || `http://127.0.0.1:${asrPort}`

const appUrl = `http://${hostIp}:${appPort}`
const wsUrl = `ws://${hostIp}:${receiverPort}/audio`
const receiverHttpOrigin = `http://${hostIp}:${receiverPort}`
const receiverWsOrigin = `ws://${hostIp}:${receiverPort}`

const children = new Set()
let shuttingDown = false

if (!hostIp) {
  console.error('Could not detect a non-internal IPv4 address.')
  console.error('Set EVEN_AUDIO_PIPE_HOST manually, e.g. EVEN_AUDIO_PIPE_HOST=100.x.y.z npm start')
  process.exit(1)
}

await ensureDependencies(receiverDir)
await ensureDependencies(appDir)
writeLocalEnv()
updateAppManifest()

if (asrEnabled && !process.env.ASR_WORKER_URL) {
  const python = await ensureAsrPython()
  spawnManaged('asr-worker', python, ['server.py'], {
    cwd: asrWorkerDir,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(asrPort) },
  })
} else if (asrEnabled) {
  console.log(`Using external ASR worker: ${asrWorkerUrl}`)
}

console.log('')
console.log('Even Audio Pipe')
console.log(`  App URL:        ${appUrl}`)
console.log(`  Audio WS URL:   ${wsUrl}`)
console.log(`  Receiver health http://127.0.0.1:${receiverPort}/health`)
console.log(`  ASR:            ${asrEnabled ? asrWorkerUrl : 'disabled'}`)
console.log(`  Audio dir:      ${displayPath(storageConfig.audioDir)}`)
console.log(`  Transcript dir: ${displayPath(storageConfig.transcriptDir)}`)
console.log(`  Transcript log: ${displayPath(storageConfig.transcriptsLog)}`)
console.log('')

spawnManaged('receiver', 'npm', ['start'], {
  cwd: receiverDir,
  env: {
    ...process.env,
    PORT: String(receiverPort),
    ASR_WORKER_URL: asrEnabled ? asrWorkerUrl : '',
    AUDIO_DIR: storageConfig.audioDir,
    TRANSCRIPT_DIR: storageConfig.transcriptDir,
    TRANSCRIPTS_LOG: storageConfig.transcriptsLog,
  },
})

spawnManaged('vite', 'npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(appPort)], {
  cwd: appDir,
  env: process.env,
})

await waitForHttp(`http://127.0.0.1:${receiverPort}/health`, 'receiver')
await waitForHttp(`http://127.0.0.1:${appPort}`, 'vite')
if (asrEnabled) {
  await waitForHttp(`${asrWorkerUrl}/health`, 'asr-worker', 300_000)
}

console.log('')
console.log('Scan this QR with the Even app:')
console.log('')

await runQr()

console.log('')
console.log('Receiver and Vite are still running. Press Ctrl+C to stop both.')
process.stdin.resume()

function detectHostIp() {
  const candidates = []
  const nets = networkInterfaces()

  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      const score = interfaceScore(name, addr.address)
      candidates.push({ name, address: addr.address, score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.address || ''
}

function interfaceScore(name, address) {
  let score = 0
  if (/^(en|eth|wl|wlan|tailscale|utun|tun)/i.test(name)) score += 20
  if (/docker|br-|veth|virbr|vmnet/i.test(name)) score -= 50
  if (/^192\.168\./.test(address)) score += 30
  if (/^10\./.test(address)) score += 25
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) score += 10
  if (/^100\./.test(address)) score += 20
  return score
}

function loadConfig() {
  const configPath = resolve(rootDir, process.env.EVEN_AUDIO_PIPE_CONFIG || 'config.json')
  if (!existsSync(configPath)) return {}

  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (err) {
    console.error(`Failed to read config JSON at ${configPath}: ${err.message}`)
    process.exit(1)
  }
}

function resolveStorageConfig(storage = {}) {
  const audioDir = resolveConfigPath(
    process.env.AUDIO_DIR ||
    process.env.OUT_DIR ||
    storage.audioDir ||
    storage.recordingsDir ||
    'data/audio',
  )
  const transcriptDir = resolveConfigPath(
    process.env.TRANSCRIPT_DIR ||
    storage.transcriptDir ||
    storage.transcriptsDir ||
    'data/transcripts',
  )
  const transcriptsLog = resolveConfigPath(
    process.env.TRANSCRIPTS_LOG ||
    storage.transcriptsLog ||
    join(transcriptDir, 'transcripts.log'),
  )

  return { audioDir, transcriptDir, transcriptsLog }
}

function resolveConfigPath(value) {
  return resolve(rootDir, String(value))
}

async function ensureDependencies(dir) {
  if (existsSync(join(dir, 'node_modules'))) return
  console.log(`Installing dependencies in ${relative(dir)}...`)
  const command = existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install'
  await runCommand('npm', [command], { cwd: dir })
}

async function ensureAsrPython() {
  const configuredPython = process.env.EVEN_AUDIO_PIPE_ASR_PYTHON

  if (configuredPython) {
    if (!existsSync(configuredPython)) {
      console.error(`Configured ASR Python does not exist: ${configuredPython}`)
      process.exit(1)
    }
    if (pythonHasAsrDeps(configuredPython)) return configuredPython

    console.error(`Configured ASR Python is missing required packages: ${configuredPython}`)
    console.error(`Install: ${configuredPython} -m pip install -r ${join(asrWorkerDir, 'requirements.txt')}`)
    process.exit(1)
  }

  if (existsSync(localAsrPython) && pythonHasAsrDeps(localAsrPython)) {
    return localAsrPython
  }

  for (const python of systemPythonCandidates()) {
    if (pythonHasAsrDeps(python)) return python
  }

  if (!existsSync(localAsrPython)) {
    console.log('Creating ASR worker Python environment...')
    await runCommand(findPythonForVenv(), ['-m', 'venv', join(asrWorkerDir, '.venv')], { cwd: asrWorkerDir })
  }

  console.log('Installing ASR worker Python dependencies...')
  await runCommand(localAsrPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: asrWorkerDir })
  await runCommand(localAsrPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: asrWorkerDir })

  if (!pythonHasAsrDeps(localAsrPython)) {
    console.error('ASR worker Python environment is still missing required packages after install.')
    process.exit(1)
  }

  return localAsrPython
}

function pythonHasAsrDeps(python) {
  const result = spawnSync(
    python,
    ['-c', 'import onnx_asr, soundfile, numpy'],
    { stdio: 'ignore' },
  )
  return result.status === 0
}

function systemPythonCandidates() {
  return process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']
}

function findPythonForVenv() {
  for (const python of systemPythonCandidates()) {
    const result = spawnSync(python, ['--version'], { stdio: 'ignore' })
    if (result.status === 0) return python
  }

  console.error('Could not find Python. Install Python 3.10+ or set EVEN_AUDIO_PIPE_ASR_PYTHON.')
  process.exit(1)
}

function writeLocalEnv() {
  writeFileSync(join(appDir, '.env.local'), `VITE_AUDIO_WS_URL=${wsUrl}\n`)
}

function updateAppManifest() {
  const manifestPath = join(appDir, 'app.json')
  const manifestSourcePath = existsSync(manifestPath)
    ? manifestPath
    : join(appDir, 'app.example.json')
  const manifest = JSON.parse(readFileSync(manifestSourcePath, 'utf8'))
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : []
  const network = permissions.find((permission) => permission?.name === 'network')

  if (network) {
    network.whitelist = [receiverWsOrigin, receiverHttpOrigin]
  } else {
    permissions.push({
      name: 'network',
      desc: 'Stream microphone PCM audio to your local receiver.',
      whitelist: [receiverWsOrigin, receiverHttpOrigin],
    })
  }

  manifest.permissions = permissions
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function spawnManaged(label, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  children.add(child)

  child.on('exit', (code, signal) => {
    children.delete(child)
    if (!shuttingDown && code !== 0 && signal !== 'SIGINT') {
      console.error(`${label} exited unexpectedly: code=${code} signal=${signal || ''}`)
      shutdown(1)
    }
  })

  return child
}

function runCommand(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

async function waitForHttp(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err?.message || String(err)
    }
    await delay(250)
  }

  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastError}`)
}

function isDisabled(value) {
  return /^(|0|false|none|off|no)$/i.test(String(value).trim())
}

async function runQr() {
  try {
    await runCommand('npx', ['evenhub', 'qr', '--url', appUrl], { cwd: appDir })
  } catch (err) {
    console.error('')
    console.error(`Failed to run evenhub qr: ${err.message}`)
    console.error(`Manual command: cd ${appDir} && npx evenhub qr --url ${appUrl}`)
  }
}

function relative(dir) {
  return dir.replace(`${rootDir}/`, '')
}

function displayPath(path) {
  const rel = relative(path)
  return rel === path ? path : rel
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    child.kill('SIGINT')
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGTERM')
    }
    process.exit(code)
  }, 800).unref()
}

process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))
process.on('uncaughtException', (err) => {
  console.error(err)
  shutdown(1)
})
process.on('unhandledRejection', (err) => {
  console.error(err)
  shutdown(1)
})
