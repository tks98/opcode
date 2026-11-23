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
//
// With --via-proxy, the proxy is given host names and looks them up again
// itself, so the relay's private-address check can't bind it: give the proxy
// its own rules against private and local destinations.

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
// Clients send each of a program's writes as one DATA packet, so allow big
// ones; memory is bounded by CLIENT_HIGH_WATER below, not by this.
const MAX_PAYLOAD = 16 << 20
// Stop reading a client's WebSocket while this much of what it sent is still
// waiting to go out (to peers that read slowly, or not yet connected).
const CLIENT_HIGH_WATER = 32 << 20
const UDP_MAX_PENDING = 1 << 20 // UDP bytes waiting to be sent; more are dropped
const CONNECT_TIMEOUT_MS = 15_000
const DNS_TIMEOUT_MS = 10_000
const MAX_PROXY_REPLY = 16 << 10

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

// Local and private networks: the relay must not become a way in. (Also the
// documentation ranges, which no real host uses.)
const PRIVATE = new net.BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  PRIVATE.addSubnet(address, prefix, 'ipv4')
}
// ::/96 holds :: and the old IPv4-compatible addresses; 64:ff9b:1::/48 is
// NAT64 for local use.
for (const [address, prefix] of [['::', 96], ['::1', 128], ['64:ff9b:1::', 48], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(address, prefix, 'ipv6')

/** An IPv6 address as its eight 16-bit groups. */
function ipv6Groups(address) {
  let text = address
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const left = head ? head.split(':') : []
  const right = tail === undefined ? [] : tail ? tail.split(':') : []
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return groups.map((group) => parseInt(group, 16))
}

const ipv4Of = (high, low) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`

function isPrivate(address) {
  if (!net.isIPv6(address)) return PRIVATE.check(address, 'ipv4')
  const g = ipv6Groups(address)
  // IPv6 addresses that carry an IPv4 one go where that one goes: IPv4-mapped
  // (::ffff:0:0/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16). Checking the
  // IPv4 address keeps NAT64 working for relays on IPv6-only hosts.
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) return PRIVATE.check(ipv4Of(g[6], g[7]), 'ipv4')
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0)) return PRIVATE.check(ipv4Of(g[6], g[7]), 'ipv4')
  if (g[0] === 0x2002) return PRIVATE.check(ipv4Of(g[1], g[2]), 'ipv4')
  return PRIVATE.check(address, 'ipv6')
}

// Host names as DNS has them: letters, digits, hyphens and underscores, in
// dot-separated labels. Nothing else may reach a proxy's CONNECT line, where
// a space or line break would let a client write its own request.
const LABEL = /^[a-z0-9_-]{1,63}$/i
function isHostname(name) {
  if (typeof name !== 'string' || !name || name.length > 254) return false
  const labels = name.replace(/\.$/, '').split('.')
  return labels.join('.').length <= 253 && labels.every((label) => LABEL.test(label))
}

/** One spelling per address, so names learned from DNS match what clients send. */
function normalAddress(address) {
  return net.isIPv6(address) ? new net.SocketAddress({ address, family: 'ipv6' }).address : address
}

// Resolve once and connect to that address, so a name can't be pointed at a
// private address between the check and the connection.
async function resolveTarget(host, options) {
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
  const allowed = addresses.filter(({ address }) => options.allowPrivate || !isPrivate(address))
  if (!allowed.length) {
    const error = new Error(`${host} is a private address`)
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
// Any client can add to this, so a name from it is only used once the relay
// has looked the name up itself (see proxyName below).
// ---------------------------------------------------------------------------

const namesByAddress = new Map()

function rememberName(address, name) {
  if (!net.isIP(address) || !isHostname(name)) return
  address = normalAddress(address)
  namesByAddress.delete(address)
  namesByAddress.set(address, name.toLowerCase().replace(/\.$/, ''))
  if (namesByAddress.size > 10_000) namesByAddress.delete(namesByAddress.keys().next().value)
}

function skipName(message, offset) {
  while (offset < message.length) {
    const length = message[offset]
    if (length === 0) return offset + 1
    if ((length & 0xc0) === 0xc0) return offset + 2
    offset += length + 1
  }
  return offset
}

/** A DNS answer's first question name ('' if none) and its A and AAAA addresses. */
function readAnswers(message) {
  const result = { name: '', addresses: [] }
  if (message.length < 12) return result
  const questions = message.readUInt16BE(4)
  const answers = message.readUInt16BE(6)
  let offset = 12
  const labels = []
  for (let i = 0; i < questions; i++) {
    if (i === 0) {
      for (let o = offset; o < message.length && message[o] !== 0 && (message[o] & 0xc0) !== 0xc0; o += message[o] + 1) {
        labels.push(message.subarray(o + 1, o + 1 + message[o]).toString('latin1'))
      }
    }
    offset = skipName(message, offset) + 4
  }
  // A label holding a dot would read as two; such names are not remembered.
  if (labels.every((label) => LABEL.test(label))) result.name = labels.join('.')
  for (let i = 0; i < answers; i++) {
    offset = skipName(message, offset)
    if (offset + 10 > message.length) break
    const type = message.readUInt16BE(offset)
    const length = message.readUInt16BE(offset + 8)
    const data = message.subarray(offset + 10, offset + 10 + length)
    offset += 10 + length
    if (data.length !== length) break
    if (type === 1 && length === 4) result.addresses.push([...data].join('.'))
    else if (type === 28 && length === 16) result.addresses.push(normalAddress([...Array(8)].map((_, j) => data.readUInt16BE(j * 2).toString(16)).join(':')))
  }
  return result
}

function rememberAnswers(message) {
  const { name, addresses } = readAnswers(message)
  for (const address of addresses) rememberName(address, name)
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
    const upstream = await fetch(options.dnsUpstream, { method: 'POST', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, body: query, signal: AbortSignal.timeout(DNS_TIMEOUT_MS) })
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
  const name = params.get('name')
  const type = params.get('type') ?? 'A'
  if (!isHostname(name) || !/^[a-z0-9]{1,16}$/i.test(type)) {
    response.writeHead(400, cors).end()
    return
  }
  const upstream = new URL(options.dnsUpstream)
  upstream.searchParams.set('name', name)
  upstream.searchParams.set('type', type)
  try {
    const answer = await fetch(upstream, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(DNS_TIMEOUT_MS) })
    const body = await answer.text()
    if (answer.ok) {
      try {
        for (const record of JSON.parse(body).Answer ?? []) {
          if (record.type === 1 || record.type === 28) rememberName(String(record.data), name)
        }
      } catch {
        // Not JSON; pass it on as it is.
      }
    }
    response.writeHead(answer.status, { ...cors, 'Content-Type': 'application/dns-json', 'Cache-Control': 'no-store' }).end(body)
  } catch {
    response.writeHead(502, cors).end()
  }
}

/**
 * The name to give the proxy for a connection to `host` (checked: `address`),
 * or null to give it the address. A name the client sent is used as it is;
 * for an address, a name learned from DNS answers, but only if the relay's
 * own lookup of that name gives this address now. Any client can teach the
 * relay names, and one client must not decide where another's connection
 * goes.
 */
async function proxyName(host, address) {
  if (!net.isIP(host)) return host
  const name = namesByAddress.get(normalAddress(address))
  if (!name) return null
  try {
    const found = await dns.lookup(name, { all: true })
    return found.some((entry) => normalAddress(entry.address) === normalAddress(address)) ? name : null
  } catch {
    return null
  }
}

// `track(socket)` is told about the socket at once, so that closing the
// stream can destroy it before it has connected.
function connectTcp(address, port, options, name, track) {
  return new Promise((resolve, reject) => {
    const proxy = options.viaProxy
    // A proxy gets the name (it may refuse bare addresses) when there is one;
    // direct connections use the checked address. A proxy looks the name up
    // again itself, so the relay's private-address check on it is only
    // advisory: the proxy needs its own rules (see the top of this file).
    const host = proxy && name ? name : address
    // Never write anything but a host name or an address into CONNECT.
    if (!net.isIP(host) && !isHostname(host)) return reject(Object.assign(new Error('bad host name'), { reason: REASON.INVALID }))
    const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`
    const socket = proxy ? net.connect(Number(proxy.port || 80), proxy.hostname) : net.connect(port, address)
    track(socket)
    let settled = false
    const timer = setTimeout(() => {
      socket.destroy()
      done(Object.assign(new Error('connection timed out'), { reason: REASON.TIMEOUT }))
    }, CONNECT_TIMEOUT_MS)
    const done = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    socket.once('error', (error) => done(Object.assign(error, { reason: error.code === 'ECONNREFUSED' ? REASON.REFUSED : REASON.UNREACHABLE })))
    socket.once('close', () => done(Object.assign(new Error('connection closed'), { reason: REASON.UNREACHABLE })))
    socket.once('connect', () => {
      if (!proxy) return done(null, socket)
      // Tunnel through an HTTP proxy (for hosts whose traffic must go through one).
      const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : ''
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
      let head = Buffer.alloc(0)
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end === -1) {
          if (head.length > MAX_PROXY_REPLY) {
            socket.destroy()
            done(Object.assign(new Error('proxy reply too long'), { reason: REASON.REFUSED }))
          }
          return
        }
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
    for (const socket of [stream.socket, stream.connecting]) {
      if (!(socket instanceof dgram.Socket)) socket?.destroy()
      else {
        try {
          socket.close()
        } catch {
          // Closed already (after an error).
        }
      }
    }
    pressure()
    if (notify) send(PACKET.CLOSE, streamId, Buffer.from([reason]))
  }

  // Stop reading the WebSocket while too much of what the client sent is
  // still waiting (the Wisp window limits packets, not bytes).
  let paused = false
  function pressure() {
    let waiting = 0
    for (const stream of streams.values()) waiting += stream.queued + (stream.type === STREAM.TCP && stream.socket ? stream.socket.writableLength : 0)
    if (!paused && waiting > CLIENT_HIGH_WATER) {
      paused = true
      ws.pause()
    } else if (paused && waiting <= CLIENT_HIGH_WATER / 2) {
      paused = false
      ws.resume()
    }
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
    const host = hostname.replace(/^\[|\]$/g, '')
    if ((type !== STREAM.TCP && type !== STREAM.UDP) || (!net.isIP(host) && !isHostname(host))) return send(PACKET.CLOSE, streamId, Buffer.from([REASON.INVALID]))
    // `allowed` is the most DATA packets the client may have sent so far
    // (see write below); `queued` is bytes waiting for the connection.
    const stream = { type, socket: null, connecting: null, queue: [], queued: 0, received: 0, allowed: BUFFER_PACKETS, inFlight: 0, udpPending: 0 }
    streams.set(streamId, stream)
    // The stream may have been closed, and its id reused, while waiting: each
    // step checks it is still this stream's, or drops what it made.
    const current = () => streams.get(streamId) === stream
    try {
      const address = await resolveTarget(host, options)
      if (!current()) return
      if (type === STREAM.UDP) {
        if (options.viaProxy) throw Object.assign(new Error('UDP is not available through a proxy'), { reason: REASON.INVALID })
        const socket = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4')
        socket.on('message', (message) => send(PACKET.DATA, streamId, message))
        socket.on('error', () => close(streamId, REASON.NETWORK_ERROR))
        socket.connect(port, address)
        stream.socket = socket
      } else {
        const name = options.viaProxy ? await proxyName(host, address) : null
        if (!current()) return
        const socket = await connectTcp(address, port, options, name, (pending) => (stream.connecting = pending))
        stream.connecting = null
        if (!current()) return socket.destroy()
        socket.setNoDelay(true)
        socket.on('data', (chunk) => send(PACKET.DATA, streamId, chunk))
        socket.on('drain', pressure)
        socket.on('end', () => close(streamId, REASON.VOLUNTARY))
        socket.on('error', () => close(streamId, REASON.NETWORK_ERROR))
        socket.on('close', () => close(streamId, REASON.VOLUNTARY))
        socket.resume()
        stream.socket = socket
      }
      const queue = stream.queue.splice(0)
      stream.queued = 0
      for (const data of queue) write(streamId, stream, data)
      pressure()
    } catch (error) {
      if (current()) close(streamId, error.reason ?? REASON.UNREACHABLE)
    }
  }

  function write(streamId, stream, data) {
    if (stream.type === STREAM.UDP) {
      // Datagrams may be lost anyway: drop them rather than queue without end.
      if (stream.udpPending + data.length > UDP_MAX_PENDING) return
      stream.udpPending += data.length
      return stream.socket.send(data, () => (stream.udpPending -= data.length))
    }
    stream.inFlight++
    stream.socket.write(data, () => {
      stream.inFlight--
      // Let the client send more once all it sent has been written out and
      // at most half its window is left. A client sets its window to the
      // CONTINUE's count when it gets one, so it may by then have sent up to
      // what `allowed` already counted: adding the full count keeps `allowed`
      // a true upper bound, and waiting for half keeps it at most half a
      // window above the client's, so a client that has used all of its
      // window always gets a CONTINUE.
      if (stream.inFlight === 0 && stream.allowed - stream.received <= BUFFER_PACKETS / 2 && streams.get(streamId) === stream) {
        stream.allowed += BUFFER_PACKETS
        sendContinue(streamId, BUFFER_PACKETS)
      }
    })
  }

  function receive(raw) {
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
      // Wisp v1 flow control: past its window the client isn't following it.
      if (stream.type === STREAM.TCP && ++stream.received > stream.allowed) return close(streamId, REASON.THROTTLED)
      const data = Buffer.from(payload)
      if (stream.socket) write(streamId, stream, data)
      else {
        stream.queue.push(data)
        stream.queued += data.length
      }
      pressure()
    } else if (type === PACKET.CLOSE) {
      close(streamId, REASON.VOLUNTARY, false)
    }
  }

  ws.on('message', (raw) => {
    try {
      receive(raw)
    } catch (error) {
      // One client's bad packet must not take the relay (and its other clients) down.
      console.error(`${new Date().toISOString()} client ${client}: ${error.stack ?? error}`)
      ws.terminate()
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
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD })
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
