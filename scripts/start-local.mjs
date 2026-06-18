import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, networkInterfaces } from 'node:os'
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
const transcriptCleanupConfig = resolveTranscriptCleanupConfig(config.transcriptCleanup)

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

if (transcriptCleanupConfig.enabled && transcriptCleanupConfig.llamaCpp.autoStart) {
  await startLlamaCpp(transcriptCleanupConfig.llamaCpp)
  await waitForHttp(llamaCppModelsUrl(transcriptCleanupConfig.url), 'llama.cpp', 900_000)
} else if (transcriptCleanupConfig.enabled) {
  console.log(`Using external transcript cleanup endpoint: ${transcriptCleanupConfig.url}`)
}

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
console.log(`  Cleanup:        ${transcriptCleanupConfig.enabled ? `${transcriptCleanupConfig.model} at ${transcriptCleanupConfig.url}` : 'disabled'}`)
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
    TRANSCRIPT_CLEANUP_ENABLED: transcriptCleanupConfig.enabled ? '1' : '0',
    TRANSCRIPT_CLEANUP_URL: transcriptCleanupConfig.url,
    TRANSCRIPT_CLEANUP_MODEL: transcriptCleanupConfig.model,
    TRANSCRIPT_CLEANUP_TEMPERATURE: String(transcriptCleanupConfig.temperature),
    TRANSCRIPT_CLEANUP_TIMEOUT_MS: String(transcriptCleanupConfig.timeoutMs),
    TRANSCRIPT_CLEANUP_PROMPT: transcriptCleanupConfig.prompt,
    TRANSCRIPT_CLEANUP_API_KEY: transcriptCleanupConfig.apiKey,
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

function resolveTranscriptCleanupConfig(cleanup = {}) {
  const llamaCpp = resolveLlamaCppConfig(cleanup.llamaCpp || {})
  const baseUrl = String(
    process.env.TRANSCRIPT_CLEANUP_BASE_URL ||
    cleanup.baseUrl ||
    '',
  ).trim()
  let url = String(
    process.env.TRANSCRIPT_CLEANUP_URL ||
    cleanup.url ||
    (baseUrl ? chatCompletionsUrl(baseUrl) : 'http://127.0.0.1:8080/v1/chat/completions'),
  ).trim()
  let model = String(
    process.env.TRANSCRIPT_CLEANUP_MODEL ||
    cleanup.model ||
    'gemma-4-e4b-it-q4_0',
  ).trim()
  const temperature = Number(
    process.env.TRANSCRIPT_CLEANUP_TEMPERATURE ??
    cleanup.temperature ??
    0,
  )
  const timeoutMs = Number(
    process.env.TRANSCRIPT_CLEANUP_TIMEOUT_MS ??
    cleanup.timeoutMs ??
    15_000,
  )
  const prompt = String(
    process.env.TRANSCRIPT_CLEANUP_PROMPT ||
    cleanup.prompt ||
    defaultCleanupPrompt(),
  )
  const apiKey = String(
    process.env.TRANSCRIPT_CLEANUP_API_KEY ||
    cleanup.apiKey ||
    '',
  )
  const enabled = !isDisabled(
    process.env.TRANSCRIPT_CLEANUP_ENABLED ??
    cleanup.enabled ??
    '0',
  )

  if (llamaCpp.autoStart && !process.env.TRANSCRIPT_CLEANUP_URL) {
    url = chatCompletionsUrl(`http://${llamaCpp.serverHost}:${llamaCpp.serverPort}/v1`)
  }
  if (llamaCpp.autoStart && !process.env.TRANSCRIPT_CLEANUP_MODEL) {
    model = llamaCpp.alias || llamaCpp.hfModel
  }

  return {
    enabled,
    url,
    model,
    temperature: Number.isFinite(temperature) ? temperature : 0,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15_000,
    prompt,
    apiKey,
    llamaCpp,
  }
}

function resolveLlamaCppConfig(config = {}) {
  const serverPort = Number(
    process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_PORT ??
    config.serverPort ??
    8080,
  )
  const gpuLayers = Number(
    process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_GPU_LAYERS ??
    config.gpuLayers ??
    999,
  )
  const contextSize = Number(
    process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_CONTEXT_SIZE ??
    config.contextSize ??
    8192,
  )
  const parallel = Number(
    process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_PARALLEL ??
    config.parallel ??
    1,
  )

  return {
    autoStart: !isDisabled(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_AUTO_START ??
      config.autoStart ??
      '0',
    ),
    repoUrl: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_REPO_URL ||
      config.repoUrl ||
      'https://github.com/ggml-org/llama.cpp.git',
    ),
    repoDir: resolveConfigPath(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_REPO_DIR ||
      config.repoDir ||
      'tools/llama.cpp',
    ),
    buildDir: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_BUILD_DIR ||
      config.buildDir ||
      'build-rocm',
    ),
    serverHost: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_HOST ||
      config.serverHost ||
      '127.0.0.1',
    ),
    serverPort: Number.isFinite(serverPort) ? serverPort : 8080,
    hfModel: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_HF_MODEL ||
      config.hfModel ||
      'google/gemma-4-E4B-it-qat-q4_0-gguf:Q4_0',
    ),
    alias: String(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_ALIAS ||
      config.alias ||
      'gemma-4-e4b-it-q4_0',
    ),
    gpuLayers: Number.isFinite(gpuLayers) ? gpuLayers : 999,
    contextSize: Number.isFinite(contextSize) ? contextSize : 8192,
    parallel: Number.isFinite(parallel) ? parallel : 1,
    rocmArch: String(
      process.env.LLAMACPP_ROCM_ARCH ||
      process.env.AMDGPU_TARGETS ||
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_ROCM_ARCH ||
      config.rocmArch ||
      '',
    ),
    extraCmakeArgs: stringArray(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_EXTRA_CMAKE_ARGS,
      config.extraCmakeArgs,
    ),
    extraServerArgs: stringArray(
      process.env.TRANSCRIPT_CLEANUP_LLAMA_CPP_EXTRA_SERVER_ARGS,
      config.extraServerArgs,
    ),
  }
}

function chatCompletionsUrl(baseUrl) {
  const cleaned = baseUrl.replace(/\/$/, '')
  if (cleaned.endsWith('/chat/completions')) return cleaned
  if (cleaned.endsWith('/v1')) return `${cleaned}/chat/completions`
  return `${cleaned}/v1/chat/completions`
}

function defaultCleanupPrompt() {
  return [
    'You clean short ASR transcript chunks from smart glasses.',
    'Fix obvious speech recognition errors, capitalization, punctuation, and light grammar only.',
    "Preserve the speaker's meaning and wording.",
    'Do not add facts, commands, explanations, or markdown.',
    'If uncertain, keep the original wording.',
    'Return only the cleaned transcript text.',
  ].join(' ')
}

function resolveConfigPath(value) {
  return resolve(rootDir, String(value))
}

function stringArray(envValue, configValue) {
  if (envValue) return String(envValue).split(/\s+/).map(value => value.trim()).filter(Boolean)
  if (Array.isArray(configValue)) return configValue.map(value => String(value)).filter(Boolean)
  if (typeof configValue === 'string') return configValue.split(/\s+/).map(value => value.trim()).filter(Boolean)
  return []
}

async function startLlamaCpp(config) {
  const modelsUrl = llamaCppModelsUrl(chatCompletionsUrl(`http://${config.serverHost}:${config.serverPort}/v1`))
  if (await httpReady(modelsUrl)) {
    console.log(`Using existing llama.cpp server: ${modelsUrl}`)
    return
  }

  const serverBinary = await ensureLlamaCpp(config)
  const args = llamaCppServerArgs(config)

  console.log(`Starting llama.cpp transcript cleanup: ${config.hfModel}`)
  spawnManaged('llama.cpp', serverBinary, args, {
    cwd: config.repoDir,
    env: process.env,
  })
}

async function ensureLlamaCpp(config) {
  if (!existsSync(config.repoDir)) {
    ensureCommandAvailable('git', 'Install git or set transcriptCleanup.llamaCpp.repoDir to an existing llama.cpp checkout.')
    mkdirSync(dirname(config.repoDir), { recursive: true })
    console.log(`Cloning llama.cpp into ${displayPath(config.repoDir)}...`)
    await runCommand('git', ['clone', '--depth', '1', config.repoUrl, config.repoDir], { cwd: rootDir })
  }

  const existingBinary = findLlamaServerBinary(config)
  if (existingBinary) return existingBinary

  ensureCommandAvailable('cmake', 'Install cmake to build llama.cpp with ROCm.')
  ensureCommandAvailable('hipconfig', 'Install the ROCm HIP SDK so hipconfig is available on PATH.')

  const rocmArch = config.rocmArch || detectRocmTargets() || defaultRocmTargets()
  const buildEnv = {
    ...process.env,
    ...hipBuildEnv(),
    LLAMACPP_ROCM_ARCH: rocmArch,
  }
  const cmakeArgs = [
    '-S',
    '.',
    '-B',
    config.buildDir,
    '-DGGML_HIP=ON',
    `-DAMDGPU_TARGETS=${rocmArch}`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DLLAMA_CURL=ON',
    ...config.extraCmakeArgs,
  ]

  console.log(`Building llama.cpp with ROCm targets: ${rocmArch}`)
  await runCommand('cmake', cmakeArgs, { cwd: config.repoDir, env: buildEnv })
  await runCommand(
    'cmake',
    [
      '--build',
      config.buildDir,
      '--config',
      'Release',
      '--target',
      'llama-server',
      `-j${Math.max(1, cpus().length)}`,
    ],
    { cwd: config.repoDir, env: buildEnv },
  )

  const builtBinary = findLlamaServerBinary(config)
  if (!builtBinary) {
    throw new Error(`llama-server was not found after build in ${displayPath(resolve(config.repoDir, config.buildDir))}`)
  }

  return builtBinary
}

function llamaCppServerArgs(config) {
  const args = [
    '--host',
    config.serverHost,
    '--port',
    String(config.serverPort),
    '-hf',
    config.hfModel,
    '-ngl',
    String(config.gpuLayers),
    '-c',
    String(config.contextSize),
    '-np',
    String(config.parallel),
  ]

  if (config.alias) {
    args.push('--alias', config.alias)
  }

  return [...args, ...config.extraServerArgs]
}

function llamaCppModelsUrl(chatCompletionsUrlValue) {
  return chatCompletionsUrlValue
    .replace(/\/chat\/completions\/?$/i, '/models')
    .replace(/\/+$/, '')
}

function findLlamaServerBinary(config) {
  return llamaServerBinaryCandidates(config).find(candidate => existsSync(candidate)) || ''
}

function llamaServerBinaryCandidates(config) {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const buildDir = resolve(config.repoDir, config.buildDir)

  return [
    join(buildDir, 'bin', `llama-server${exe}`),
    join(buildDir, 'tools', 'server', `llama-server${exe}`),
    join(buildDir, `llama-server${exe}`),
  ]
}

function hipBuildEnv() {
  const clangDir = commandOutput('hipconfig', ['-l'])
  const hipPath = commandOutput('hipconfig', ['-R'])
  const env = {}

  if (clangDir) env.HIPCXX = join(clangDir, 'clang')
  if (hipPath) env.HIP_PATH = hipPath

  return env
}

function detectRocmTargets() {
  const result = spawnSync('rocminfo', [], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error) return ''

  const targets = new Set()
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  for (const match of output.matchAll(/\bName:\s+(gfx[0-9a-f]+)/gi)) {
    targets.add(match[1])
  }

  return [...targets].join(',')
}

function defaultRocmTargets() {
  return 'gfx803,gfx900,gfx906,gfx908,gfx90a,gfx942,gfx1010,gfx1030,gfx1032,gfx1100,gfx1101,gfx1102'
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0 || result.error) return ''
  return String(result.stdout || '').trim()
}

function ensureCommandAvailable(command, message) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
  if (!result.error) return
  throw new Error(message || `${command} is required but was not found on PATH.`)
}

async function httpReady(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1000)
  timeout.unref?.()

  try {
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
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
