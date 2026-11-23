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

// Limits on what a server in the machine can send back: a response is held
// in memory on the page's main thread. Generous for a preview (a page, its
// scripts, images, a dataset); past them the preview gets an error instead
// of a hung or exhausted tab.
export const MAX_HEAD_BYTES = 64 * 1024
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

const TOO_LARGE = "The server's answer is larger than the preview takes (64 MB)."
const HEAD_TOO_LARGE = 'The server sent more headers than the preview takes (64 KB).'

function indexOfBlankLine(bytes, from = 0) {
  for (let i = Math.max(0, from); i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i
  }
  return -1
}

/**
 * One step through a chunked body from `pos`: { need: true } until the next
 * chunk has fully arrived, then { size, start, next } (size 0: the last
 * chunk), or { malformed: true }. A chunk size is hex digits, optionally
 * followed by ";extensions".
 */
function chunkAt(bytes, pos) {
  let end = pos
  while (end + 1 < bytes.length && !(bytes[end] === 13 && bytes[end + 1] === 10)) {
    if (end - pos > 1024) return { malformed: true } // no size line is this long
    end++
  }
  if (end + 1 >= bytes.length) return { need: true }
  const digits = decoder.decode(bytes.subarray(pos, end)).split(';')[0].trim()
  if (!/^[0-9a-f]{1,8}$/i.test(digits)) return { malformed: true }
  const size = parseInt(digits, 16)
  if (size > MAX_RESPONSE_BYTES) throw new Error(TOO_LARGE)
  const start = end + 2
  if (size === 0) return { size, start, next: start }
  if (start + size + 2 > bytes.length) return { need: true }
  return { size, start, next: start + size + 2 }
}

// Decode a chunked body: { body, complete }.
function dechunk(bytes) {
  const parts = []
  for (let pos = 0; ; ) {
    const chunk = chunkAt(bytes, pos)
    if (chunk.need) return { body: concat(parts), complete: false }
    if (chunk.malformed || chunk.size === 0) return { body: concat(parts), complete: true } // malformed: keep what came
    parts.push(bytes.subarray(chunk.start, chunk.start + chunk.size))
    pos = chunk.next
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

// The head of a response, up to the blank line at `blank`.
function parseHead(bytes, blank) {
  if (blank > MAX_HEAD_BYTES) throw new Error(HEAD_TOO_LARGE)
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
    if (lower === 'content-length') length = /^\d+$/.test(value) ? Number(value) : null
    if (lower === 'transfer-encoding' && /chunked/i.test(value)) chunked = true
    if (!HOP_BY_HOP.has(lower)) headers.push([name, value])
  }
  if (length !== null && length > MAX_RESPONSE_BYTES) throw new Error(TOO_LARGE)
  return { status, statusText: match[2], headers, length, chunked }
}

const bodiless = (method, status) => method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200)

/**
 * Parse an HTTP response received so far: null until its head has arrived,
 * then { status, statusText, headers, body, complete }. `ended`: the server
 * closed the connection (the end of a body without a length).
 */
export function parseResponse(bytes, { method = 'GET', ended = false } = {}) {
  const blank = indexOfBlankLine(bytes)
  if (blank === -1) {
    if (bytes.length > MAX_HEAD_BYTES) throw new Error(HEAD_TOO_LARGE)
    return null
  }
  const { status, statusText, headers, length, chunked } = parseHead(bytes, blank)
  const rest = bytes.subarray(blank + 4)
  let body
  let complete
  if (bodiless(method, status)) {
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
  return { status, statusText, headers, body: body.slice(), complete }
}

/**
 * A response as it arrives over a connection. Bytes go into one growing
 * buffer, the head is looked for only in new bytes, and a chunked body is
 * walked chunk by chunk as they come, so a large answer costs time in
 * proportion to its size; it is parsed in full once, when complete.
 */
export class ResponseReader {
  #buffer = new Uint8Array(16 * 1024)
  #size = 0
  #method
  #scanned = 0 // bytes searched for the end of the head
  #head = null // { status, length, chunked, body (offset) }
  #next = 0 // chunked: where the next chunk starts
  #complete = false

  constructor(method = 'GET') {
    this.#method = method
  }

  get size() {
    return this.#size
  }

  /** Add received bytes; throws when the answer goes past the limits. */
  push(data) {
    if (this.#size + data.length > MAX_HEAD_BYTES + MAX_RESPONSE_BYTES) throw new Error(TOO_LARGE)
    if (this.#size + data.length > this.#buffer.length) {
      const grown = new Uint8Array(Math.max(this.#buffer.length * 2, this.#size + data.length))
      grown.set(this.#buffer.subarray(0, this.#size))
      this.#buffer = grown
    }
    this.#buffer.set(data, this.#size) // copied: v86 reuses its packet buffer
    this.#size += data.length
  }

  /** The response once complete (or the connection `ended`), else null. Throws for one that isn't HTTP. */
  read(ended = false) {
    const bytes = this.#buffer.subarray(0, this.#size)
    if (!this.#head) {
      // The blank line can straddle two packets: look back three bytes.
      const blank = indexOfBlankLine(bytes, this.#scanned - 3)
      this.#scanned = bytes.length
      if (blank === -1) {
        if (bytes.length > MAX_HEAD_BYTES) throw new Error(HEAD_TOO_LARGE)
        return null
      }
      const head = parseHead(bytes, blank)
      this.#head = { ...head, body: blank + 4 }
      this.#next = blank + 4
      this.#complete = bodiless(this.#method, head.status)
    }
    const head = this.#head
    if (!this.#complete) {
      if (head.chunked) {
        const body = bytes.subarray(head.body)
        for (;;) {
          const chunk = chunkAt(body, this.#next - head.body)
          if (chunk.need) break
          if (chunk.malformed || chunk.size === 0) {
            this.#complete = true
            break
          }
          this.#next = head.body + chunk.next
        }
      } else if (head.length !== null) {
        this.#complete = bytes.length - head.body >= head.length
      }
    }
    if (!this.#complete && !ended) return null
    return parseResponse(bytes, { method: this.#method, ended })
  }
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
    const reader = new ResponseReader(request.method)
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
      if (settled) return
      let response
      try {
        response = reader.read(ended)
      } catch (error) {
        finish(error)
        return
      }
      if (response?.complete) finish(null, response)
      else if (ended) finish(new Error(reader.size ? 'The server closed the connection before its answer was complete.' : 'The server closed the connection without answering.'))
    }
    timer = setTimeout(() => refused(`Nothing answered on port ${port}.`), attemptMs)
    try {
      connection = connect(port)
    } catch (error) {
      finish(error)
      return
    }
    connection.on('connect', () => {
      if (settled) return
      connected = true
      clearTimeout(timer)
      timer = setTimeout(() => finish(new Error('The server took too long to answer.')), timeoutMs)
      connection.write(encodeRequest(request, port))
    })
    connection.on('data', (data) => {
      if (settled) return
      try {
        reader.push(data)
      } catch (error) {
        finish(error)
        return
      }
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
//
// A hidden /.wasmer/host.html frame on the host's origin talks to its
// service worker for this page. Previewed pages share that origin, so their
// scripts can reach into the frame (parent.frames[i]) and run code there.
// Two things keep that from mattering:
//
// - The frame is sandboxed. It keeps its origin, which its service worker
//   needs, but can't navigate this tab or open windows, which a previewed
//   page could otherwise do through it (the preview frame's own sandbox
//   stops it doing so directly).
// - Each server gets a frame of its own, removed when the server's route
//   closes and before the next frame for that origin loads, so code a page
//   plants in one doesn't see the next server's requests. The Wasmer SDK
//   keeps one frame per origin for the page's life; installSdkHostBroker()
//   takes over its connection (hosts written by scripts/preview-host.mjs
//   hand it over) and routes the SDK's servers through frames made here.
//
// What this can't stop, with one host origin for every server: previewed
// pages share that origin's storage (cookies, localStorage, IndexedDB), and
// a page runs while it is shown. A wildcard host (one origin per server)
// avoids both.

/** The host frame's sandbox (see above). */
export const HOST_SANDBOX = 'allow-scripts allow-same-origin'
const HOST_PAGE = '/.wasmer/host.html'
// How long to wait for the host to confirm a route closed (it closes the
// route's port) before removing its frame.
const CLOSE_WAIT_MS = 500

// origin -> settles once the origin's current host frame is gone
const framesGone = new Map()

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}

async function connectHost(origin, timeoutMs) {
  const iframe = document.createElement('iframe')
  // Before src: sandbox flags apply when the frame navigates.
  iframe.setAttribute('sandbox', HOST_SANDBOX)
  const url = new URL(HOST_PAGE, origin)
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
    return { port: channel.port1, iframe }
  } catch (error) {
    iframe.remove()
    throw error
  }
}

/**
 * Register server `serverId` with the host at `origin`, in a host frame of
 * its own: frames for one origin come one at a time, each removed before
 * the next loads, so code a page planted in one is gone (with the page)
 * before another server's requests pass through. `onMessage(data, port)`
 * gets what the service worker sends for the server. Resolves with
 * { port, close() } once the service worker accepts it.
 */
async function openRoute(origin, serverId, onMessage, timeoutMs) {
  const previous = framesGone.get(origin) ?? Promise.resolve()
  let gone
  const thisGone = new Promise((resolve) => (gone = resolve))
  framesGone.set(origin, previous.then(() => thisGone))
  let host
  try {
    // One server per origin (as the host's service worker allows).
    await withTimeout(previous, timeoutMs, 'The preview host is still busy with the last server.')
    host = await connectHost(origin, timeoutMs)
  } catch (error) {
    gone()
    throw error
  }
  const remove = () => {
    host.port.close()
    host.iframe.remove()
    gone()
  }
  const route = new MessageChannel()
  const ready = new Promise((resolve, reject) => {
    route.port1.addEventListener('message', ({ data }) => {
      if (data?.serverId !== serverId) return
      if (data.type === 'wasmer-sdk:http-ready') resolve()
      else if (data.type === 'wasmer-sdk:http-error') reject(new Error(data.error))
      onMessage(data, route.port1)
    })
    route.port1.start()
  })
  host.port.postMessage({ type: 'wasmer-sdk:http-register', serverId }, [route.port2])
  try {
    await withTimeout(ready, timeoutMs, 'The preview host did not accept the server.')
  } catch (error) {
    route.port1.close()
    remove()
    throw error
  }
  let closing = null
  return {
    port: route.port1,
    close() {
      closing ??= (async () => {
        // The host passes this on to the service worker, then closes its end
        // of the port. Removing the frame before that would leave the
        // service worker holding a dead route (and refusing the next one).
        const closed = new Promise((resolve) => {
          route.port1.addEventListener('close', resolve, { once: true })
          setTimeout(resolve, CLOSE_WAIT_MS)
        })
        route.port1.postMessage({ type: 'wasmer-sdk:http-close', serverId })
        await closed
        route.port1.close()
        remove()
      })()
      return closing
    },
  }
}

/**
 * Serve requests to the preview host at `hostUrl` with `handle(request)`,
 * which resolves to { status, statusText, headers, body }. Resolves with
 * { url, close() }, like the SDK's ports.expose().
 */
export async function exposeOnHost(hostUrl, handle, { timeoutMs = 15_000 } = {}) {
  const { origin } = new URL(hostUrl, location.href)
  const serverId = crypto.randomUUID()
  const route = await openRoute(
    origin,
    serverId,
    async (data, port) => {
      if (data.type !== 'wasmer-sdk:http-request') return
      const reply = { type: 'wasmer-sdk:http-response', serverId, requestId: data.requestId }
      try {
        const response = await handle({ method: data.method, path: data.path, headers: data.headers ?? [], body: data.body?.length ? new Uint8Array(data.body) : undefined })
        const body = response.body ?? new Uint8Array(0)
        port.postMessage({ ...reply, status: response.status, statusText: response.statusText, headers: response.headers, body }, [body.buffer])
      } catch (error) {
        port.postMessage({ ...reply, error: error?.message ?? String(error) })
      }
    },
    timeoutMs,
  )
  return { url: new URL('/', origin), close: () => route.close() }
}

// ---------------------------------------------------------------------------
// The Wasmer SDK's host frames
// ---------------------------------------------------------------------------

const HANDOFF = 'opcode:wasmer-host-handoff'
let brokerInstalled = false

/**
 * Sandbox the host frames the Wasmer SDK makes (ports.expose()), and ask
 * the host to hand the SDK's connection to this page: hosts written by
 * scripts/preview-host.mjs then pass it up instead of starting there, and
 * the SDK's servers are routed through host frames made by openRoute(), one
 * per server. Other hosts ignore the request and work as before (sandboxed).
 * Call before the SDK makes a frame.
 */
export function installSdkHostBroker({ timeoutMs = 15_000 } = {}) {
  if (brokerInstalled || typeof HTMLIFrameElement === 'undefined') return
  brokerInstalled = true
  const sdkFrames = new Set()
  // The SDK sets src, then adds the frame to the page: the frame is
  // sandboxed before it loads anything.
  const src = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src')
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
    ...src,
    set(value) {
      let url = null
      try {
        url = new URL(value, document.baseURI)
      } catch {
        // Not a URL: not the SDK's.
      }
      if (url?.pathname === HOST_PAGE && url.searchParams.has('parentOrigin') && !this.hasAttribute('sandbox')) {
        this.setAttribute('sandbox', HOST_SANDBOX)
        url.searchParams.set('opcode', 'handoff')
        sdkFrames.add(this)
        value = url.href
      }
      src.set.call(this, value)
    },
  })
  addEventListener('message', (event) => {
    if (event.data?.type !== HANDOFF) return
    const iframe = [...sdkFrames].find((frame) => frame.contentWindow === event.source)
    const port = event.ports[0]
    if (!iframe || !port || event.origin !== new URL(iframe.src).origin) return
    sdkFrames.delete(iframe)
    brokerSdkConnection(event.origin, port, timeoutMs)
    // The SDK only talks to it through the port, which is now here.
    iframe.remove()
  })
}

// Act as the host for the SDK's connection `sdk`: each server it registers
// gets a route through a frame of its own.
function brokerSdkConnection(origin, sdk, timeoutMs) {
  sdk.addEventListener('message', async ({ data, ports }) => {
    const owner = ports[0]
    if (data?.type !== 'wasmer-sdk:http-register' || typeof data.serverId !== 'string' || !owner) return
    const { serverId } = data
    let route
    let closed = false
    owner.addEventListener('message', ({ data: message }) => {
      if (message?.type === 'wasmer-sdk:http-close') {
        closed = true
        route?.close()
        owner.close()
      } else {
        route?.port.postMessage(message)
      }
    })
    owner.start()
    try {
      route = await openRoute(origin, serverId, (message) => owner.postMessage(message), timeoutMs)
      if (closed) route.close() // closed while it opened
    } catch (error) {
      owner.postMessage({ type: 'wasmer-sdk:http-error', serverId, error: error?.message ?? String(error) })
      owner.close()
    }
  })
  sdk.start()
  sdk.postMessage({ type: 'wasmer-sdk:http-host-ready' })
}
