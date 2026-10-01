import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { formatDialogueWithOpenAI } from './dialogue_format.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const isDev = process.argv.includes('--dev')
if (!isDev && existsSync(join(root, '.env')) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(join(root, '.env'))
}
const viteModule = isDev ? await import('vite') : null
const loadedEnv = viteModule?.loadEnv('development', root, '') || {}
const env = { ...loadedEnv, ...process.env }
const port = Number(env.PORT || 5173)
const transcriptApiUrl = new URL(env.TRANSCRIPT_API_URL?.trim() || 'https://transcription-api.5.189.188.129.sslip.io')
if (transcriptApiUrl.hostname === 'localhost') transcriptApiUrl.hostname = '127.0.0.1'
const appDatesUrl = 'https://api.ivaraconnect.com/api/app-dates/'
const appId = 'mabab'

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

let vite = null
let asrWorker = null
let asrRequestId = 0
let asrWorkerLog = ''
const asrRequests = new Map()
let apiProcess = null

async function apiHealthy() {
  try {
    const response = await fetch(new URL('/health', transcriptApiUrl), { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    const body = await response.json()
    return body?.status === 'ok'
  } catch {
    return false
  }
}

async function startLocalApiIfNeeded() {
  if (await apiHealthy()) return
  if (transcriptApiUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(transcriptApiUrl.hostname)) return

  const apiRoot = join(root, '..', 'transcript-API')
  if (!existsSync(join(apiRoot, 'main.py'))) return
  const windowsPython = join(apiRoot, '.venv', 'Scripts', 'python.exe')
  const unixPython = join(apiRoot, '.venv', 'bin', 'python')
  const python = existsSync(windowsPython) ? windowsPython : existsSync(unixPython) ? unixPython : process.platform === 'win32' ? 'python' : 'python3'
  const apiPort = transcriptApiUrl.port || '8000'

  apiProcess = spawn(python, ['-m', 'uvicorn', 'accounts_app:app', '--host', '127.0.0.1', '--port', apiPort], {
    cwd: apiRoot,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  apiProcess.stdout.on('data', (message) => process.stdout.write(`[API] ${message}`))
  apiProcess.stderr.on('data', (message) => process.stderr.write(`[API] ${message}`))
  apiProcess.on('error', (error) => console.error('Could not start the Python API:', error))
  apiProcess.on('exit', (code) => {
    if (!isShuttingDown && code !== 0) console.error(`Python API stopped with exit code ${code}.`)
    apiProcess = null
  })

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await apiHealthy()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  console.error('Python API did not become ready. Sign-in will be unavailable until the API starts.')
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function sendApiResult(response, result) {
  if (result.status === 204) {
    response.writeHead(204)
    response.end()
    return
  }
  sendJson(response, result.status, result.body)
}

function bearerHeader(request) {
  const value = request.headers.authorization
  return typeof value === 'string' && /^Bearer\s+\S+$/i.test(value) ? value : null
}

async function apiRequest(path, { method = 'GET', authorization, body } = {}) {
  const headers = { Accept: 'application/json' }
  if (authorization) headers.Authorization = authorization
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  try {
    const upstream = await fetch(new URL(path, transcriptApiUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const responseText = await upstream.text()
    let responseBody = {}
    try {
      responseBody = responseText ? JSON.parse(responseText) : {}
    } catch {
      return { status: 502, body: { error: 'The account service returned an unreadable response.' } }
    }
    return { status: upstream.status, body: responseBody }
  } catch (error) {
    console.error('Transcription API request failed:', error)
    return { status: 503, body: { error: 'The account service is unavailable. Check the Python API and PostgreSQL connection.' } }
  }
}

async function proxyApiJson(request, response, path, { needsBody = false } = {}) {
  try {
    const body = needsBody ? await readJson(request) : undefined
    const result = await apiRequest(path, {
      method: request.method,
      authorization: bearerHeader(request),
      body,
    })
    sendApiResult(response, result)
  } catch (error) {
    const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
    sendJson(response, status, { error: error instanceof Error ? error.message : 'Invalid request.' })
  }
}

function readAudio(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false

    request.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > 200 * 1024 * 1024) {
        tooLarge = true
        const error = new Error('The audio file is over the 200 MB upload limit.')
        error.code = 'AUDIO_TOO_LARGE'
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks))
    })
    request.on('error', reject)
  })
}

function readJson(request, maximumBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > maximumBytes) {
        tooLarge = true
        const error = new Error('The request body is too large.')
        error.code = 'BODY_TOO_LARGE'
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Invalid JSON request.'))
      }
    })
    request.on('error', reject)
  })
}

async function formatDialogue(request, response) {
  try {
    const authorization = bearerHeader(request)
    if (!authorization) {
      sendJson(response, 401, { error: 'Sign in to format a transcript.' })
      return
    }
    const access = await apiRequest('/me', { authorization })
    if (access.status !== 200) {
      sendApiResult(response, access)
      return
    }
    const body = await readJson(request, 2 * 1024 * 1024)
    const formatted = await formatDialogueWithOpenAI(body?.turns, {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_DIALOGUE_MODEL?.trim() || 'gpt-5-mini',
    })
    sendJson(response, 200, { text: formatted })
  } catch (error) {
    console.error('Dialogue formatting failed:', error)
    const status = error?.code === 'INVALID_TURNS'
      ? 400
      : ['BODY_TOO_LARGE', 'TRANSCRIPT_TOO_LONG'].includes(error?.code)
      ? 413
      : !env.OPENAI_API_KEY?.trim() ? 503 : 502
    sendJson(response, status, {
      error: error instanceof Error ? error.message : 'Could not format the transcript.',
    })
  }
}

function pythonExecutable() {
  if (env.LOCAL_ASR_PYTHON?.trim()) return env.LOCAL_ASR_PYTHON.trim()
  const windowsPython = join(root, '.venv', 'Scripts', 'python.exe')
  const unixPython = join(root, '.venv', 'bin', 'python')
  if (existsSync(windowsPython)) return windowsPython
  if (existsSync(unixPython)) return unixPython
  return process.platform === 'win32' ? 'python' : 'python3'
}

function asrWorkerCommand() {
  if (env.LOCAL_ASR_EXECUTABLE?.trim()) {
    return { executable: env.LOCAL_ASR_EXECUTABLE.trim(), arguments: [] }
  }
  return { executable: pythonExecutable(), arguments: [join(root, 'local_asr_worker.py')] }
}

function rejectAsrRequests(error) {
  for (const pending of asrRequests.values()) {
    clearTimeout(pending.timeout)
    pending.reject(error)
  }
  asrRequests.clear()
}

function startAsrWorker() {
  if (asrWorker) return asrWorker

  asrWorkerLog = ''
  const command = asrWorkerCommand()
  const worker = spawn(command.executable, command.arguments, {
    cwd: root,
    env: {
      ...process.env,
      HF_HOME: env.HF_HOME?.trim() || join(root, '.models'),
      HF_TOKEN: env.HF_TOKEN?.trim() || '',
      LOCAL_ASR_MODEL: env.LOCAL_ASR_MODEL?.trim() || 'OpenVoiceOS/w2v-bert-2.0-kinyarwanda-onnx',
      LOCAL_ASR_MODEL_PATH: env.LOCAL_ASR_MODEL_PATH?.trim() || '',
      LOCAL_VAD_MODEL_PATH: env.LOCAL_VAD_MODEL_PATH?.trim() || '',
      LOCAL_SPEAKER_MODEL_PATH: env.LOCAL_SPEAKER_MODEL_PATH?.trim() || '',
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  asrWorker = worker

  const lines = createInterface({ input: worker.stdout })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      console.log(`Local ASR: ${line}`)
      return
    }
    const pending = asrRequests.get(message.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    asrRequests.delete(message.id)
    if (message.error) pending.reject(new Error(message.error))
    else pending.resolve(message)
  })
  worker.stderr.setEncoding('utf8')
  worker.stderr.on('data', (message) => {
    asrWorkerLog = `${asrWorkerLog}${message}`.slice(-4000)
    process.stderr.write(`[Local ASR] ${message}`)
  })
  worker.stdin.on('error', (error) => {
    const failure = new Error(`The local transcription worker closed its input: ${error.message}`)
    failure.code = 'ASR_WORKER_EXIT'
    if (asrWorker === worker) asrWorker = null
    rejectAsrRequests(failure)
    worker.kill()
  })
  worker.on('error', (error) => {
    rejectAsrRequests(error)
    asrWorker = null
  })
  worker.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
    const finalLogLine = asrWorkerLog.trim().split(/\r?\n/).at(-1)
    const usefulDetail = /error|failed|traceback|exception/i.test(finalLogLine || '') ? finalLogLine : ''
    const error = new Error(
      `The local model stopped unexpectedly (${reason}).${usefulDetail ? ` ${usefulDetail}` : ''}`,
    )
    error.code = 'ASR_WORKER_EXIT'
    rejectAsrRequests(error)
    if (asrWorker === worker) asrWorker = null
  })
  return worker
}

function sendToAsrWorker(payload, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const worker = startAsrWorker()
    const id = ++asrRequestId
    const timeout = setTimeout(() => {
      asrRequests.delete(id)
      reject(new Error('Local processing took too long to respond.'))
    }, timeoutMs)
    asrRequests.set(id, { resolve, reject, timeout })
    worker.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
      if (!error) return
      clearTimeout(timeout)
      asrRequests.delete(id)
      reject(error)
    })
  })
}

async function runWorkerTask(payload, timeoutMs) {
  try {
    return await sendToAsrWorker(payload, timeoutMs)
  } catch (error) {
    if (error?.code !== 'ASR_WORKER_EXIT') throw error
    console.warn('Restarting the local ASR worker once after an unexpected stop.')
    return sendToAsrWorker(payload, timeoutMs)
  }
}

async function transcribeLocally(audio) {
  return runWorkerTask({ task: 'transcribe', audio: audio.toString('base64') }, 15 * 60 * 1000)
}

async function transcribe(request, response) {
  try {
    const authorization = bearerHeader(request)
    if (!authorization) {
      sendJson(response, 401, { error: 'Sign in to transcribe audio.' })
      return
    }
    const rawRequestId = request.headers['x-transcription-request-id']
    if (typeof rawRequestId !== 'string' || !/^[1-9][0-9]*$/.test(rawRequestId)) {
      sendJson(response, 400, { error: 'Start a transcription request before sending audio.' })
      return
    }
    const access = await apiRequest(`/transcription-requests/${rawRequestId}`, { authorization })
    if (access.status !== 200) {
      sendApiResult(response, access)
      return
    }
    if (access.body.status !== 'started') {
      sendJson(response, 409, { error: 'This transcription request has already finished.' })
      return
    }
    const audio = await readAudio(request)
    if (audio.length === 0) {
      sendJson(response, 400, { error: 'No audio data was received.' })
      return
    }

    const transcript = await transcribeLocally(audio)
    sendJson(response, 200, { text: transcript.text, segments: transcript.segments })
  } catch (error) {
    console.error('Local transcription request failed:', error)
    const status = error?.code === 'AUDIO_TOO_LARGE' ? 413 : 502
    const message = error instanceof Error
      ? error.message
      : 'The local Kinyarwanda model could not transcribe this audio.'
    sendJson(response, status, { error: message })
  }
}

async function getAppDate(response) {
  try {
    const upstream = await fetch(appDatesUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!upstream.ok) throw new Error(`App date service returned ${upstream.status}.`)

    const dates = await upstream.json()
    const app = Array.isArray(dates) ? dates.find((entry) => entry?.app_id === appId) : null
    if (!app || typeof app.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(app.date)) {
      throw new Error(`No valid date was returned for ${appId}.`)
    }
    sendJson(response, 200, { date: app.date })
  } catch (error) {
    console.error('App date check failed:', error)
    sendJson(response, 502, { error: 'The app date could not be verified.' })
  }
}

function serveProduction(request, response) {
  const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname)
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1)
  const safePath = normalize(relativePath).replace(/^(\.\.(\\|\/|$))+/, '')
  let filePath = join(root, 'dist', safePath)

  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(root, 'dist', 'index.html')
  if (!existsSync(filePath)) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Build not found. Run npm run build first.')
    return
  }

  response.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' })
  createReadStream(filePath).pipe(response)
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://localhost')
  const pathname = requestUrl.pathname
  if ((pathname === '/api/signup' || pathname === '/api/login') && request.method === 'POST') {
    await proxyApiJson(request, response, pathname.slice(4), { needsBody: true })
    return
  }
  if (pathname === '/api/me' && request.method === 'GET') {
    await proxyApiJson(request, response, '/me')
    return
  }
  if (pathname === '/api/me/usage' && request.method === 'GET') {
    await proxyApiJson(request, response, `/me/usage${requestUrl.search}`)
    return
  }
  if (pathname === '/api/logout' && request.method === 'POST') {
    await proxyApiJson(request, response, '/logout')
    return
  }
  if (pathname === '/api/transcription-requests' && request.method === 'POST') {
    await proxyApiJson(request, response, '/transcription-requests')
    return
  }
  const finishMatch = /^\/api\/transcription-requests\/([1-9][0-9]*)\/finish$/.exec(pathname)
  if (finishMatch && request.method === 'POST') {
    await proxyApiJson(request, response, `/transcription-requests/${finishMatch[1]}/finish`, { needsBody: true })
    return
  }
  if (pathname === '/api/transcribe' && request.method === 'POST') {
    await transcribe(request, response)
    return
  }
  if ((pathname === '/api/format-dialogue' || pathname === '/api/clean-transcript') && request.method === 'POST') {
    await formatDialogue(request, response)
    return
  }
  if (pathname === '/api/app-date' && request.method === 'GET') {
    await getAppDate(response)
    return
  }
  if (vite) vite.middlewares(request, response, () => {})
  else serveProduction(request, response)
})

if (isDev) {
  vite = await viteModule.createServer({
    root,
    server: {
      middlewareMode: true,
      ws: { server },
    },
    appType: 'spa',
  })
}

let isShuttingDown = false
let parentCheck

async function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  if (parentCheck) clearInterval(parentCheck)
  if (asrWorker) {
    asrWorker.kill()
    asrWorker = null
  }
  if (apiProcess) {
    apiProcess.kill()
    apiProcess = null
  }

  await vite?.close()
  server.close(() => process.exit(0))
  server.closeIdleConnections()

  const forceClose = setTimeout(() => {
    server.closeAllConnections()
    process.exit(0)
  }, 2000)
  forceClose.unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (input) => {
    if (input.includes('\u0003')) void shutdown()
  })
}

const parentProcessId = process.ppid
parentCheck = setInterval(() => {
  try {
    process.kill(parentProcessId, 0)
  } catch (error) {
    if (error.code === 'ESRCH') void shutdown()
  }
}, 1000)
parentCheck.unref()

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. The app is probably already running; stop it before starting another copy.`)
  } else {
    console.error('Scribe server failed:', error)
  }
  await vite?.close()
  process.exitCode = 1
})

await startLocalApiIfNeeded()

server.listen(port, () => {
  console.log(`Scribe is running at http://localhost:${port}`)
  console.log('Using the free local Kinyarwanda CPU model. No ZeroGPU quota is used.')
})
