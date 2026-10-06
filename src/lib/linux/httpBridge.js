// The web preview for servers running inside a Linux machine (python3 -m
// http.server, nginx in a container behind docker run -p, ...).
//
// The preview frame's requests reach a service worker on the preview host
// (the same host and protocol the Wasmer SDK uses for terminal projects, see
// stores/preview.svelte.js), which hands them to this page. Here each one
// becomes an HTTP/1.1 request over a TCP connection into the emulated
// machine, made by v86's network stack.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Headers that describe one connection rather than the message.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length', 'accept-encoding'])

/** An HTTP/1.1 request for a server on `port`, as bytes. */
export function encodeRequest({ method = 'GET', path = '/', headers = [], body }, port) {
  const lines = [`${method} ${path || '/'} HTTP/1.1`, `Host: localhost:${port}`, 'Connection: close']
  // No Accept-Encoding: responses are handed to the browser as they are,
  // so they must not be compressed.
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) lines.push(`${name}: ${value}`)
  }
  const length = body?.length ?? 0
  if (length || !['GET', 'HEAD'].includes(method)) lines.push(`Content-Length: ${length}`)
  const head = encoder.encode(`${lines.join('\r\n')}\r\n\r\n`)
  if (!length) return head
  const bytes = new Uint8Array(head.length + length)
  bytes.set(head)
  bytes.set(body, head.length)
  return bytes
}

function indexOfBlankLine(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i
  }
  return -1
}

// Decode a chunked body: { body, complete }.
function dechunk(bytes) {
  const parts = []
  let pos = 0
  for (;;) {
    let end = pos
    while (end + 1 < bytes.length && !(bytes[end] === 13 && bytes[end + 1] === 10)) end++
    if (end + 1 >= bytes.length) return { body: concat(parts), complete: false }
    const size = parseInt(decoder.decode(bytes.subarray(pos, end)).split(';')[0].trim(), 16)
    if (Number.isNaN(size)) return { body: concat(parts), complete: true } // malformed: keep what came
    pos = end + 2
    if (size === 0) return { body: concat(parts), complete: true }
    if (pos + size + 2 > bytes.length) return { body: concat(parts), complete: false }
    parts.push(bytes.subarray(pos, pos + size))
    pos += size + 2
  }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * Parse an HTTP response received so far: null until its head has arrived,
 * then { status, statusText, headers, body, complete }. `ended`: the server
 * closed the connection (the end of a body without a length).
 */
export function parseResponse(bytes, { method = 'GET', ended = false } = {}) {
  const blank = indexOfBlankLine(bytes)
  if (blank === -1) return null
  const [statusLine, ...headerLines] = decoder.decode(bytes.subarray(0, blank)).split('\r\n')
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(statusLine)
  if (!match) throw new Error('The server did not answer with HTTP.')
  const status = Number(match[1])
  const headers = []
  let length = null
  let chunked = false
  for (const line of headerLines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    const lower = name.toLowerCase()
    if (lower === 'content-length') length = Number(value)
    if (lower === 'transfer-encoding' && /chunked/i.test(value)) chunked = true
    if (!HOP_BY_HOP.has(lower)) headers.push([name, value])
  }
  const rest = bytes.subarray(blank + 4)
  const noBody = method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200)
  let body
  let complete
  if (noBody) {
    body = new Uint8Array(0)
    complete = true
  } else if (chunked) {
    ;({ body, complete } = dechunk(rest))
    complete ||= ended
  } else if (length !== null) {
    body = rest.subarray(0, length)
    complete = rest.length >= length || ended
  } else {
    body = rest
    complete = ended
  }
  return { status, statusText: match[2], headers, body: body.slice(), complete }
}

/**
 * Send one HTTP request to `port` in the machine, over a connection from
 * `connect(port)` (a v86 TCP connection), and resolve with the response.
 *
 * Connecting is retried for a while: a port can be open well before its
 * server answers (Docker opens a published port before the container's
 * server starts, which can take half a minute on a busy computer), and v86
 * doesn't resend a connection request that was lost.
 */
export async function fetchFromMachine(connect, port, request, { timeoutMs = 30_000, connectMs = 45_000, attemptMs = 3000, retryMs = 500 } = {}) {
  const deadline = Date.now() + connectMs
  for (;;) {
    try {
      return await attempt(connect, port, request, { timeoutMs, attemptMs })
    } catch (error) {
      if (!error.retry || Date.now() + retryMs >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  }
}

function attempt(connect, port, request, { timeoutMs, attemptMs }) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let connected = false
    let settled = false
    let connection
    let timer
    const finish = (error, response) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        connection?.close()
      } catch {
        // Already gone.
      }
      if (error) reject(error)
      else resolve(response)
    }
    // Not connected (yet): worth trying again.
    const refused = (message) => finish(Object.assign(new Error(message), { retry: true }))
    const received = (ended) => {
      let response
      try {
        response = parseResponse(concat(chunks), { method: request.method, ended })
      } catch (error) {
        finish(error)
        return
      }
      if (response?.complete) finish(null, response)
      else if (ended) finish(new Error(size ? 'The server closed the connection before its answer was complete.' : 'The server closed the connection without answering.'))
    }
    timer = setTimeout(() => refused(`Nothing answered on port ${port}.`), attemptMs)
    try {
      connection = connect(port)
    } catch (error) {
      finish(error)
      return
    }
    connection.on('connect', () => {
      connected = true
      clearTimeout(timer)
      timer = setTimeout(() => finish(new Error('The server took too long to answer.')), timeoutMs)
      connection.write(encodeRequest(request, port))
    })
    connection.on('data', (data) => {
      chunks.push(data.slice()) // v86 reuses its packet buffer
      size += data.length
      received(false)
    })
    connection.on('shutdown', () => received(true))
    connection.on('close', () => {
      if (!connected) refused(`Nothing is listening on port ${port} in the machine.`)
      else received(true)
    })
  })
}

// ---------------------------------------------------------------------------
// The preview host (Wasmer SDK protocol; see @wasmer/sdk dist/service-worker.js)
// ---------------------------------------------------------------------------

const hosts = new Map() // origin -> Promise<MessagePort>

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}

async function connectHost(origin, timeoutMs) {
  const iframe = document.createElement('iframe')
  const url = new URL('/.wasmer/host.html', origin)
  url.searchParams.set('parentOrigin', location.origin)
  iframe.src = url.href
  iframe.hidden = true
  iframe.tabIndex = -1
  iframe.setAttribute('aria-hidden', 'true')
  const loaded = new Promise((resolve, reject) => {
    iframe.addEventListener('load', resolve, { once: true })
    iframe.addEventListener('error', () => reject(new Error(`Could not load the preview host at ${origin}`)), { once: true })
  })
  document.body.append(iframe)
  try {
    await withTimeout(loaded, timeoutMs, `The preview host at ${origin} did not load.`)
    const channel = new MessageChannel()
    const ready = new Promise((resolve, reject) => {
      channel.port1.addEventListener('message', ({ data }) => {
        if (data?.type === 'wasmer-sdk:http-host-ready') resolve()
        else if (data?.type === 'wasmer-sdk:http-host-error') reject(new Error(data.error || 'The preview host failed to start.'))
      })
      channel.port1.start()
    })
    iframe.contentWindow.postMessage({ type: 'wasmer-sdk:http-host-connect' }, origin, [channel.port2])
    await withTimeout(ready, timeoutMs, `The preview host at ${origin} did not connect.`)
    return channel.port1
  } catch (error) {
    iframe.remove()
    throw error
  }
}

/**
 * Serve requests to the preview host at `hostUrl` with `handle(request)`,
 * which resolves to { status, statusText, headers, body }. Resolves with
 * { url, close() }, like the SDK's ports.expose().
 */
export async function exposeOnHost(hostUrl, handle, { timeoutMs = 15_000 } = {}) {
  const { origin } = new URL(hostUrl, location.href)
  if (!hosts.has(origin)) {
    const connection = connectHost(origin, timeoutMs)
    hosts.set(origin, connection)
    connection.catch(() => hosts.delete(origin))
  }
  const host = await hosts.get(origin)
  const serverId = crypto.randomUUID()
  const route = new MessageChannel()
  const ready = new Promise((resolve, reject) => {
    route.port1.addEventListener('message', async ({ data }) => {
      if (data?.serverId !== serverId) return
      if (data.type === 'wasmer-sdk:http-ready') return resolve()
      if (data.type === 'wasmer-sdk:http-error') return reject(new Error(data.error))
      if (data.type !== 'wasmer-sdk:http-request') return
      const reply = { type: 'wasmer-sdk:http-response', serverId, requestId: data.requestId }
      try {
        const response = await handle({ method: data.method, path: data.path, headers: data.headers ?? [], body: data.body?.length ? new Uint8Array(data.body) : undefined })
        const body = response.body ?? new Uint8Array(0)
        route.port1.postMessage({ ...reply, status: response.status, statusText: response.statusText, headers: response.headers, body }, [body.buffer])
      } catch (error) {
        route.port1.postMessage({ ...reply, error: error?.message ?? String(error) })
      }
    })
    route.port1.start()
  })
  host.postMessage({ type: 'wasmer-sdk:http-register', serverId }, [route.port2])
  try {
    await withTimeout(ready, timeoutMs, 'The preview host did not accept the server.')
  } catch (error) {
    route.port1.close()
    throw error
  }
  return {
    url: new URL('/', origin),
    async close() {
      route.port1.postMessage({ type: 'wasmer-sdk:http-close', serverId })
      await new Promise((resolve) => setTimeout(resolve, 0))
      route.port1.close()
    },
  }
}
