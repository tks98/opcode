#!/usr/bin/env node
// A small Wisp relay that gives Opcode's terminals and Linux machines
// internet access. Browsers can't open TCP connections, so the Wasmer
// sandbox and the v86 emulator tunnel them over one WebSocket to this
// server, which makes the real connections (Wisp protocol v1:
// https://github.com/MercuryWorkshop/wisp-protocol).
//
//   node scripts/wisp-server.mjs [--port 8090] [--host 127.0.0.1 (0.0.0.0 for every interface)]
//        [--origin https://your-opcode-site] ... [--allow-private]
//        [--block-ports 25,465,587] [--max-streams 64] [--via-proxy URL]
//        [--dns-upstream https://cloudflare-dns.com/dns-query]
//
// Then build the app with VITE_WISP_URL=wss://your-relay/ (or set the relay
// in Opcode's Internet settings). The relay also answers DNS-over-HTTPS at
// /dns-query, which Opcode uses for the guests' DNS, so lookups go through
// the relay too.
//
// It is an open TCP relay for whoever can reach it: restrict --origin to
// your Opcode site, and run it where outgoing traffic is acceptable. It
// refuses private and local addresses (your network, cloud metadata
// services) unless --allow-private, and outgoing mail ports by default.

import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import http from 'node:http'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'

const PACKET = { CONNECT: 0x01, DATA: 0x02, CONTINUE: 0x03, CLOSE: 0x04 }
const STREAM = { TCP: 0x01, UDP: 0x02 }
const REASON = { VOLUNTARY: 0x02, NETWORK_ERROR: 0x03, INVALID: 0x41, UNREACHABLE: 0x42, TIMEOUT: 0x43, REFUSED: 0x44, BLOCKED: 0x48, THROTTLED: 0x49 }
const BUFFER_PACKETS = 128 // DATA packets a client may send before a CONTINUE
const WS_HIGH_WATER = 1 << 20 // pause sockets while the WebSocket is this far behind
const CONNECT_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { port: 8090, host: '127.0.0.1', origins: [], allowPrivate: false, blockPorts: [25, 465, 587], maxStreams: 64, viaProxy: null, dnsUpstream: 'https://cloudflare-dns.com/dns-query' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i]
    if (arg === '--port') options.port = Number(value())
    else if (arg === '--host') options.host = value()
    else if (arg === '--origin') options.origins.push(value().replace(/\/+$/, ''))
    else if (arg === '--allow-private') options.allowPrivate = true
    else if (arg === '--block-ports') options.blockPorts = value().split(',').filter(Boolean).map(Number)
    else if (arg === '--max-streams') options.maxStreams = Number(value())
    else if (arg === '--via-proxy') options.viaProxy = new URL(value())
    else if (arg === '--dns-upstream') options.dnsUpstream = value()
    else if (arg === '--help') {
      console.log('See the comment at the top of scripts/wisp-server.mjs')
      process.exit(0)
    } else throw new Error(`Unknown option ${arg}`)
  }
  return options
}

// Local and private networks: the relay must not become a way in.
const PRIVATE = new net.BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  PRIVATE.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(address, prefix, 'ipv6')

function isPrivate(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return PRIVATE.check(mapped[1], 'ipv4')
  return PRIVATE.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4')
}

// Resolve once and connect to that address, so a name can't be pointed at a
// private address between the check and the connection.
async function resolveTarget(hostname, options) {
  const host = hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
  const allowed = addresses.filter(({ address }) => options.allowPrivate || !isPrivate(address))
  if (!allowed.length) {
    const error = new Error(`${hostname} is a private address`)
    error.reason = REASON.BLOCKED
    throw error
  }
  return allowed[0].address
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DNS-over-HTTPS (RFC 8484), forwarded upstream. Remembers which name each
// address belongs to: an HTTP proxy may only accept names (--via-proxy).
// ---------------------------------------------------------------------------

const namesByAddress = new Map()

function skipName(message, offset) {
  while (offset < message.length) {
    const length = message[offset]
    if (length === 0) return offset + 1
    if ((length & 0xc0) === 0xc0) return offset + 2
    offset += length + 1
  }
  return offset
}

function rememberAnswers(message) {
  if (message.length < 12) return
  const questions = message.readUInt16BE(4)
  const answers = message.readUInt16BE(6)
  let offset = 12
  const labels = []
  for (let i = 0; i < questions; i++) {
    if (i === 0) {
      for (let o = offset; o < message.length && message[o] !== 0 && (message[o] & 0xc0) !== 0xc0; o += message[o] + 1) {
        labels.push(message.subarray(o + 1, o + 1 + message[o]).toString())
      }
    }
    offset = skipName(message, offset) + 4
  }
  const name = labels.join('.')
  for (let i = 0; i < answers && offset + 10 <= message.length; i++) {
    offset = skipName(message, offset)
    const type = message.readUInt16BE(offset)
    const length = message.readUInt16BE(offset + 8)
    const data = message.subarray(offset + 10, offset + 10 + length)
    offset += 10 + length
    let address = null
    if (type === 1 && length === 4) address = [...data].join('.')
    else if (type === 28 && length === 16) address = net.SocketAddress ? new net.SocketAddress({ address: [...Array(8)].map((_, j) => data.readUInt16BE(j * 2).toString(16)).join(':'), family: 'ipv6' }).address : null
    if (!address || !name) continue
    namesByAddress.delete(address)
    namesByAddress.set(address, name)
    if (namesByAddress.size > 10_000) namesByAddress.delete(namesByAddress.keys().next().value)
  }
}

async function serveDns(request, response, options, cors) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type, accept', 'Access-Control-Max-Age': '86400' }).end()
    return
  }
  let params
  try {
    params = new URL(request.url, 'http://relay').searchParams
  } catch {
    response.writeHead(400, cors).end()
    return
  }
  if (request.method === 'GET' && params.has('name')) return serveDnsJson(params, response, options, cors)
  try {
    let query
    if (request.method === 'GET') {
      const encoded = params.get('dns') ?? ''
      query = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    } else {
      // Read at most a little over a DNS message: a client could send gigabytes.
      const chunks = []
      let length = 0
      for await (const chunk of request) {
        length += chunk.length
        if (length > MAX_DNS_MESSAGE) break
        chunks.push(chunk)
      }
      query = Buffer.concat(chunks)
      if (length > MAX_DNS_MESSAGE) query = Buffer.alloc(MAX_DNS_MESSAGE + 1)
    }
    if (query.length < 12 || query.length > MAX_DNS_MESSAGE) {
      response.writeHead(400, cors).end()
      request.destroy()
      return
    }
    const upstream = await fetch(options.dnsUpstream, { method: 'POST', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, body: query, signal: AbortSignal.timeout(10_000) })
    const answer = Buffer.from(await upstream.arrayBuffer())
    if (upstream.ok) rememberAnswers(answer)
    response.writeHead(upstream.status, { ...cors, 'Content-Type': 'application/dns-message', 'Cache-Control': 'no-store' }).end(answer)
  } catch {
    // The client went away, or the upstream resolver failed.
    if (!response.headersSent) response.writeHead(502, cors)
    response.end()
  }
}

const MAX_DNS_MESSAGE = 4096

// The JSON flavour (?name=&type=, application/dns-json), which some clients
// use instead of DNS messages.
async function serveDnsJson(params, response, options, cors) {
  const upstream = new URL(options.dnsUpstream)
  upstream.searchParams.set('name', params.get('name'))
  upstream.searchParams.set('type', params.get('type') ?? 'A')
  try {
    const answer = await fetch(upstream, { headers: { accept: 'application/dns-json' } })
    const body = await answer.text()
    if (answer.ok) {
      try {
        for (const record of JSON.parse(body).Answer ?? []) {
          if ((record.type === 1 || record.type === 28) && net.isIP(record.data)) {
            namesByAddress.delete(record.data)
            namesByAddress.set(record.data, String(params.get('name')).replace(/\.$/, ''))
          }
        }
        if (namesByAddress.size > 10_000) namesByAddress.delete(namesByAddress.keys().next().value)
      } catch {
        // Not JSON; pass it on as it is.
      }
    }
    response.writeHead(answer.status, { ...cors, 'Content-Type': 'application/dns-json', 'Cache-Control': 'no-store' }).end(body)
  } catch {
    response.writeHead(502, cors).end()
  }
}

function connectTcp(address, port, options, hostname) {
  return new Promise((resolve, reject) => {
    const proxy = options.viaProxy
    // A proxy gets the name (it may refuse bare addresses), learned from the
    // client or from DNS answers; direct connections use the checked address.
    const name = net.isIP(hostname) ? namesByAddress.get(hostname) : hostname
    const host = proxy && name ? name : address
    const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`
    const socket = proxy ? net.connect(Number(proxy.port || 80), proxy.hostname) : net.connect(port, address)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Object.assign(new Error('connection timed out'), { reason: REASON.TIMEOUT }))
    }, CONNECT_TIMEOUT_MS)
    const done = (error, result) => {
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    socket.once('error', (error) => done(Object.assign(error, { reason: error.code === 'ECONNREFUSED' ? REASON.REFUSED : REASON.UNREACHABLE })))
    socket.once('connect', () => {
      if (!proxy) return done(null, socket)
      // Tunnel through an HTTP proxy (for hosts whose traffic must go through one).
      const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : ''
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
      let head = Buffer.alloc(0)
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.pause() // until the stream's handlers are attached
        socket.off('data', onData)
        const status = head.subarray(0, head.indexOf('\r\n')).toString()
        if (!/^HTTP\/1\.[01] 200/.test(status)) {
          socket.destroy()
          return done(Object.assign(new Error(`proxy refused: ${status}`), { reason: REASON.REFUSED }))
        }
        const rest = head.subarray(end + 4)
        if (rest.length) socket.unshift(rest)
        done(null, socket)
      }
      socket.on('data', onData)
    })
  })
}

function serveClient(ws, request, options) {
  const streams = new Map()
  const client = request.headers['x-forwarded-for']?.split(',')[0].trim() || request.socket.remoteAddress

  const send = (type, streamId, payload = Buffer.alloc(0)) => {
    if (ws.readyState !== ws.OPEN) return
    const packet = Buffer.allocUnsafe(5 + payload.length)
    packet.writeUInt8(type, 0)
    packet.writeUInt32LE(streamId, 1)
    payload.copy(packet, 5)
    ws.send(packet)
  }
  const sendContinue = (streamId, packets) => {
    const payload = Buffer.allocUnsafe(4)
    payload.writeUInt32LE(packets, 0)
    send(PACKET.CONTINUE, streamId, payload)
  }
  const close = (streamId, reason, notify = true) => {
    const stream = streams.get(streamId)
    if (!stream) return
    streams.delete(streamId)
    stream.socket?.destroy?.()
    stream.socket?.close?.()
    if (notify) send(PACKET.CLOSE, streamId, Buffer.from([reason]))
  }

  // Keep up with a slow WebSocket by pausing the TCP sockets feeding it.
  const drain = setInterval(() => {
    const behind = ws.bufferedAmount > WS_HIGH_WATER
    for (const stream of streams.values()) {
      if (stream.type !== STREAM.TCP || !stream.socket) continue
      if (behind) stream.socket.pause()
      else stream.socket.resume()
    }
  }, 50)

  async function open(streamId, type, port, hostname) {
    if (streams.size >= options.maxStreams) return send(PACKET.CLOSE, streamId, Buffer.from([REASON.THROTTLED]))
    if (!port || options.blockPorts.includes(port)) return send(PACKET.CLOSE, streamId, Buffer.from([REASON.BLOCKED]))
    const stream = { type, socket: null, queue: [], inFlight: 0, processed: 0 }
    streams.set(streamId, stream)
    try {
      const address = await resolveTarget(hostname, options)
      if (!streams.has(streamId)) return
      if (type === STREAM.UDP) {
        if (options.viaProxy) throw Object.assign(new Error('UDP is not available through a proxy'), { reason: REASON.INVALID })
        const socket = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4')
        socket.on('message', (message) => send(PACKET.DATA, streamId, message))
        socket.on('error', () => close(streamId, REASON.NETWORK_ERROR))
        socket.connect(port, address)
        stream.socket = socket
      } else {
        const socket = await connectTcp(address, port, options, hostname.replace(/^\[|\]$/g, ''))
        if (!streams.has(streamId)) return socket.destroy()
        socket.setNoDelay(true)
        socket.on('data', (chunk) => send(PACKET.DATA, streamId, chunk))
        socket.on('end', () => close(streamId, REASON.VOLUNTARY))
        socket.on('error', () => close(streamId, REASON.NETWORK_ERROR))
        socket.on('close', () => close(streamId, REASON.VOLUNTARY))
        socket.resume()
        stream.socket = socket
      }
      for (const data of stream.queue.splice(0)) write(streamId, stream, data)
    } catch (error) {
      close(streamId, error.reason ?? REASON.UNREACHABLE)
    }
  }

  function write(streamId, stream, data) {
    if (stream.type === STREAM.UDP) return stream.socket.send(data)
    stream.inFlight++
    stream.socket.write(data, () => {
      stream.inFlight--
      stream.processed++
      // Let the client send more once half its buffer has been written out.
      if (stream.processed >= BUFFER_PACKETS / 2 && stream.inFlight === 0 && streams.has(streamId)) {
        stream.processed = 0
        sendContinue(streamId, BUFFER_PACKETS)
      }
    })
  }

  ws.on('message', (raw) => {
    const packet = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    if (packet.length < 5) return
    const type = packet.readUInt8(0)
    const streamId = packet.readUInt32LE(1)
    const payload = packet.subarray(5)
    if (type === PACKET.CONNECT && payload.length >= 3) {
      if (streams.has(streamId)) return
      open(streamId, payload.readUInt8(0), payload.readUInt16LE(1), payload.subarray(3).toString())
    } else if (type === PACKET.DATA) {
      const stream = streams.get(streamId)
      if (!stream) return
      if (stream.socket) write(streamId, stream, Buffer.from(payload))
      else stream.queue.push(Buffer.from(payload))
    } else if (type === PACKET.CLOSE) {
      close(streamId, REASON.VOLUNTARY, false)
    }
  })
  ws.on('close', () => {
    clearInterval(drain)
    for (const streamId of [...streams.keys()]) close(streamId, REASON.VOLUNTARY, false)
  })
  ws.on('error', () => ws.terminate())

  // Wisp v1 handshake: the buffer size every new TCP stream starts with.
  sendContinue(0, BUFFER_PACKETS)
  console.log(`${new Date().toISOString()} client ${client} connected`)
}

// ---------------------------------------------------------------------------
// The relay itself: its DNS-over-HTTPS endpoint and its WebSocket. This file's
// server below uses it, and so does scripts/server.mjs, which serves it beside
// Opcode. `isAllowed(request)` decides which pages may use it.
// ---------------------------------------------------------------------------

export function createRelay(options, isAllowed) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  return {
    serveDns(request, response) {
      if (!isAllowed(request)) return response.writeHead(403).end()
      const origin = request.headers.origin?.replace(/\/+$/, '')
      const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { 'Access-Control-Allow-Origin': '*' }
      serveDns(request, response, options, cors)
    },
    upgrade(request, socket, head) {
      if (!isAllowed(request)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => serveClient(ws, request, options))
    },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2))
  const relay = createRelay(options, (request) => !options.origins.length || options.origins.includes(request.headers.origin?.replace(/\/+$/, '')))
  const server = http.createServer((request, response) => {
    if (/^\/dns-query(\?|$)/.test(request.url)) return relay.serveDns(request, response)
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Opcode Wisp relay. Connect with a WebSocket; DNS-over-HTTPS at /dns-query.\n')
  })
  server.on('upgrade', relay.upgrade)
  server.listen(options.port, options.host, () => {
    console.log(`Wisp relay on ws://${options.host}:${server.address().port}/${options.origins.length ? ` for ${options.origins.join(', ')}` : ' (any origin; use --origin to restrict)'}`)
    if (options.viaProxy) console.log(`Connecting through ${options.viaProxy.host}`)
  })
}
