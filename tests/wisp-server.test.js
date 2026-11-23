// Runs the relay (scripts/wisp-server.mjs) against a local echo server.
import { client as wisp } from '@mercuryworkshop/wisp-js/client'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createRelay, parseArgs } from '../scripts/wisp-server.mjs'

const packet = (type, stream, payload = Buffer.alloc(0)) => {
  const bytes = Buffer.alloc(5 + payload.length)
  bytes[0] = type
  bytes.writeUInt32LE(stream, 1)
  payload.copy(bytes, 5)
  return bytes
}
const connectPacket = (stream, host, port) => {
  const payload = Buffer.alloc(3 + Buffer.byteLength(host))
  payload[0] = 0x01 // TCP
  payload.writeUInt16LE(port, 1)
  payload.write(host, 3)
  return packet(0x01, stream, payload)
}

async function startRelay(args) {
  const child = spawn(process.execPath, ['scripts/wisp-server.mjs', '--port', '0', '--host', '127.0.0.1', ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  let output = ''
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk
      const match = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)
      if (match) resolve(match[1])
    })
    child.once('exit', () => reject(new Error(`relay exited: ${output}`)))
  })
  return { child, url: `ws://127.0.0.1:${port}/` }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The relay in this process, as scripts/server.mjs runs it. */
async function startInProcess(args) {
  const relay = createRelay(parseArgs(args), () => true)
  const server = http.createServer((request, response) => (request.url.startsWith('/dns-query') ? relay.serveDns(request, response) : response.end()))
  server.on('upgrade', relay.upgrade)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, url: `ws://127.0.0.1:${port}/`, http: `http://127.0.0.1:${port}` }
}

/** A DNS query message for one name (labels as raw bytes, as a client could send). */
function dnsQuery(labels, type = 1) {
  const parts = [Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0])]
  for (const label of labels) {
    const bytes = Buffer.from(label, 'latin1')
    parts.push(Buffer.from([bytes.length]), bytes)
  }
  parts.push(Buffer.from([0, 0, type, 0, 1]))
  return Buffer.concat(parts)
}

/** A DNS-over-HTTPS upstream that answers every name with 127.0.0.1. */
async function fakeUpstream() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://upstream')
    if (url.searchParams.has('name')) {
      return response.writeHead(200, { 'content-type': 'application/dns-json' }).end(JSON.stringify({ Status: 0, Answer: [{ name: url.searchParams.get('name'), type: 1, TTL: 60, data: '127.0.0.1' }] }))
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const query = Buffer.concat(chunks)
    const header = Buffer.from(query.subarray(0, 12))
    header.writeUInt16BE(0x8180, 2)
    header.writeUInt16BE(1, 6)
    const record = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1])
    response.writeHead(200, { 'content-type': 'application/dns-message' }).end(Buffer.concat([header, query.subarray(12), record]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}/` }
}

/** An HTTP CONNECT proxy that tunnels for real and keeps each request's head. */
async function fakeProxy() {
  const heads = []
  const server = net.createServer((socket) => {
    let head = Buffer.alloc(0)
    socket.on('error', () => {})
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      heads.push(head.subarray(0, end).toString('latin1'))
      const [, host, port] = /^CONNECT (\S+):(\d+) /.exec(heads.at(-1)) ?? []
      if (!host) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      const upstream = net.connect(Number(port), host.replace(/^\[|\]$/g, ''), () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
        const rest = head.subarray(end + 4)
        if (rest.length) upstream.write(rest)
        socket.pipe(upstream).pipe(socket)
      })
      upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
    }
    socket.on('data', onData)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, heads, url: `http://127.0.0.1:${server.address().port}` }
}

/** Opens a wisp-js client connection (the client Opcode's Wasmer sandbox uses). */
function wispClient(url) {
  return new Promise((resolve, reject) => {
    const connection = new wisp.ClientConnection(url)
    connection.onopen = () => resolve(connection)
    connection.onerror = reject
  })
}

/** Sends `total` bytes over a wisp-js stream to an echo server; resolves with what came back. */
function echoThrough(connection, host, port, total, chunk = 64 << 10) {
  const sent = Buffer.alloc(total)
  for (let i = 0; i < total; i++) sent[i] = i % 251
  return new Promise((resolve, reject) => {
    const stream = connection.create_stream(host, port)
    const received = []
    let length = 0
    stream.onmessage = (data) => {
      received.push(Buffer.from(data))
      length += data.length
      if (length >= total) {
        stream.close()
        resolve({ sent, received: Buffer.concat(received) })
      }
    }
    stream.onclose = (reason) => reject(new Error(`stream closed (reason ${reason}) after ${length} bytes`))
    for (let offset = 0; offset < total; offset += chunk) stream.send(sent.subarray(offset, offset + chunk))
  })
}

function open(url) {
  const ws = new WebSocket(url)
  const messages = []
  const waiters = []
  ws.on('message', (raw) => {
    const bytes = Buffer.from(raw)
    messages.push({ type: bytes[0], stream: bytes.readUInt32LE(1), payload: bytes.subarray(5) })
    for (const waiter of waiters.splice(0)) waiter()
  })
  const next = async (match) => {
    for (;;) {
      const index = messages.findIndex(match)
      if (index !== -1) return messages.splice(index, 1)[0]
      await new Promise((resolve) => waiters.push(resolve))
    }
  }
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, next })))
}

describe('wisp relay', () => {
  let echo
  let echoPort
  const relays = []

  beforeAll(async () => {
    echo = net.createServer((socket) => socket.pipe(socket))
    await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
    echoPort = echo.address().port
  })
  afterAll(() => {
    echo.close()
    for (const relay of relays) {
      relay.child?.kill()
      relay.server?.close()
    }
  })

  it('relays TCP streams', async () => {
    const relay = await startRelay(['--allow-private'])
    relays.push(relay)
    const { ws, next } = await open(relay.url)
    const hello = await next((m) => m.type === 0x03 && m.stream === 0)
    expect(hello.payload.readUInt32LE(0)).toBeGreaterThan(0)
    ws.send(connectPacket(1, '127.0.0.1', echoPort))
    ws.send(packet(0x02, 1, Buffer.from('hello through the relay')))
    const data = await next((m) => m.type === 0x02 && m.stream === 1)
    expect(data.payload.toString()).toBe('hello through the relay')
    ws.close()
  })

  it('refuses private addresses and mail ports', async () => {
    const relay = await startRelay([])
    relays.push(relay)
    const { ws, next } = await open(relay.url)
    ws.send(connectPacket(1, '127.0.0.1', echoPort))
    expect((await next((m) => m.type === 0x04 && m.stream === 1)).payload[0]).toBe(0x48)
    ws.send(connectPacket(3, 'example.com', 25))
    expect((await next((m) => m.type === 0x04 && m.stream === 3)).payload[0]).toBe(0x48)
    ws.close()
  })

  it('only accepts the configured origins', async () => {
    const relay = await startRelay(['--origin', 'https://opcode.example'])
    relays.push(relay)
    const refused = new WebSocket(relay.url, { headers: { origin: 'https://elsewhere.example' } })
    const status = await new Promise((resolve) => {
      refused.on('unexpected-response', (request, response) => resolve(response.statusCode))
      refused.on('open', () => resolve('opened'))
      refused.on('error', () => {})
    })
    expect(status).toBe(403)
  })

  it('carries a few MB each way for a client that follows the Wisp window', async () => {
    const relay = await startInProcess(['--allow-private'])
    relays.push(relay)
    const connection = await wispClient(relay.url)
    const { sent, received } = await echoThrough(connection, '127.0.0.1', echoPort, 6 << 20)
    expect(received.equals(sent)).toBe(true)
    // Small packets too, as v86 sends (one per TCP segment).
    const small = await echoThrough(connection, '127.0.0.1', echoPort, 1 << 20, 1460)
    expect(small.received.equals(small.sent)).toBe(true)
    connection.close()
  })

  it('waits, without cutting it off, for a peer that stops reading', async () => {
    let peer
    let length = 0
    const sink = net.createServer((socket) => {
      peer = socket
      socket.pause()
      socket.on('data', (chunk) => (length += chunk.length))
    })
    await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve))
    const relay = await startInProcess(['--allow-private'])
    relays.push(relay)
    const connection = await wispClient(relay.url)
    const stream = connection.create_stream('127.0.0.1', sink.address().port)
    let closed = null
    stream.onclose = (reason) => (closed = reason)
    const total = 40 << 20 // more than the relay buffers for a client
    for (let offset = 0; offset < total; offset += 64 << 10) stream.send(Buffer.alloc(64 << 10, 1))
    await sleep(1000)
    expect(closed).toBe(null)
    expect(length).toBeLessThan(total)
    peer.resume()
    for (let i = 0; i < 100 && length < total; i++) await sleep(100)
    expect(length).toBe(total)
    expect(closed).toBe(null)
    connection.close()
    sink.close()
  })

  it('closes a stream whose client sends past its window', async () => {
    const relay = await startInProcess(['--allow-private'])
    relays.push(relay)
    const { ws, next } = await open(relay.url)
    ws.send(connectPacket(1, '127.0.0.1', echoPort))
    for (let i = 0; i < 200; i++) ws.send(packet(0x02, 1, Buffer.alloc(1024)))
    expect((await next((m) => m.type === 0x04 && m.stream === 1)).payload[0]).toBe(0x49)
    ws.close()
  })

  it('refuses host names that are not host names', async () => {
    const relay = await startInProcess(['--allow-private'])
    relays.push(relay)
    const { ws, next } = await open(relay.url)
    for (const [stream, host] of [[1, 'example.com:80 HTTP/1.1\r\nX-Injected: yes'], [3, 'a b.example'], [5, `${'a'.repeat(64)}.example`], [7, 'x'.repeat(300)]]) {
      ws.send(connectPacket(stream, host, 80))
      expect((await next((m) => m.type === 0x04 && m.stream === stream)).payload[0]).toBe(0x41)
    }
    ws.close()
  })

  it('leaves no sockets behind when a client reuses stream ids', async () => {
    const connections = new Set()
    const listener = net.createServer((socket) => {
      connections.add(socket)
      socket.on('close', () => connections.delete(socket))
      socket.on('error', () => {})
    })
    // Every address: "localhost" may be 127.0.0.1 or ::1.
    await new Promise((resolve) => listener.listen(0, resolve))
    const udp = dgram.createSocket('udp4')
    await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve))
    const udpSockets = () => process.getActiveResourcesInfo().filter((name) => name === 'UDPWrap').length
    const before = udpSockets()

    const relay = await startInProcess(['--allow-private', '--max-streams', '4'])
    relays.push(relay)
    const { ws, next } = await open(relay.url)
    await next((m) => m.type === 0x03 && m.stream === 0)
    // A name, so each lookup takes a moment and the next CONNECT lands meanwhile.
    const udpConnect = (stream) => {
      const bytes = connectPacket(stream, 'localhost', udp.address().port)
      bytes[5] = 0x02
      return bytes
    }
    for (let i = 0; i < 50; i++) {
      ws.send(connectPacket(7, 'localhost', listener.address().port))
      ws.send(packet(0x04, 7, Buffer.from([0x02])))
      ws.send(udpConnect(8))
      ws.send(packet(0x04, 8, Buffer.from([0x02])))
    }
    ws.send(connectPacket(7, 'localhost', listener.address().port))
    ws.send(udpConnect(8))
    await sleep(1000)
    expect(connections.size).toBe(1)
    expect(udpSockets() - before).toBe(1)
    ws.close()
    await sleep(500)
    expect(connections.size).toBe(0)
    expect(udpSockets() - before).toBe(0)
    listener.close()
    udp.close()
  })

  describe('through an HTTP proxy (--via-proxy)', () => {
    let upstream
    let proxy
    let relay

    beforeAll(async () => {
      upstream = await fakeUpstream()
      proxy = await fakeProxy()
      relay = await startInProcess(['--allow-private', '--via-proxy', proxy.url, '--dns-upstream', upstream.url])
      relays.push(relay)
    })
    afterAll(() => {
      upstream.server.close()
      proxy.server.close()
    })

    it('carries data both ways, by name and by address', async () => {
      const connection = await wispClient(relay.url)
      const byName = await echoThrough(connection, 'localhost', echoPort, 3 << 20)
      expect(byName.received.equals(byName.sent)).toBe(true)
      expect(proxy.heads.at(-1)).toMatch(new RegExp(`^CONNECT localhost:${echoPort} HTTP/1.1\r\n`))
      // A client that looked the name up through the relay, then connects by
      // address: the proxy gets the name, which the relay's own lookup confirms.
      expect((await fetch(`${relay.http}/dns-query`, { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: dnsQuery(['localhost']) })).status).toBe(200)
      const byAddress = await echoThrough(connection, '127.0.0.1', echoPort, 3 << 20)
      expect(byAddress.received.equals(byAddress.sent)).toBe(true)
      expect(proxy.heads.at(-1)).toMatch(new RegExp(`^CONNECT localhost:${echoPort} HTTP/1.1\r\n`))
      connection.close()
    })

    it('never lets a client write into the CONNECT request', async () => {
      const evil = '169.254.169.254:80 HTTP/1.1\r\nX-Injected: yes\r\nX: '
      expect((await fetch(`${relay.http}/dns-query`, { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: dnsQuery([evil, 'attacker', 'test']) })).status).toBe(200)
      expect((await fetch(`${relay.http}/dns-query?name=${encodeURIComponent(`${evil}.attacker.test`)}`)).status).toBe(400)
      expect((await fetch(`${relay.http}/dns-query?name=example.com&type=${encodeURIComponent('A\r\nX: y')}`)).status).toBe(400)
      const { ws, next } = await open(relay.url)
      ws.send(connectPacket(1, evil, 80))
      expect((await next((m) => m.type === 0x04 && m.stream === 1)).payload[0]).toBe(0x41)
      ws.send(connectPacket(3, '127.0.0.1', echoPort))
      ws.send(packet(0x02, 3, Buffer.from('ping')))
      expect((await next((m) => m.type === 0x02 && m.stream === 3)).payload.toString()).toBe('ping')
      ws.close()
      expect(proxy.heads.length).toBeGreaterThan(0)
      for (const head of proxy.heads) {
        expect(head).not.toContain('X-Injected')
        expect(head.split('\r\n')[0]).toMatch(/^CONNECT [\w.:[\]-]+ HTTP\/1\.1$/)
      }
    })

    it("doesn't let one client choose the name another client's connection goes by", async () => {
      // The attacker teaches the relay a name for 127.0.0.1 (the upstream
      // answers every name with it) that the relay's own lookup doesn't give.
      expect((await fetch(`${relay.http}/dns-query?name=hijack.attacker.test`)).status).toBe(200)
      const { ws, next } = await open(relay.url)
      ws.send(connectPacket(1, '127.0.0.1', echoPort))
      ws.send(packet(0x02, 1, Buffer.from('ping')))
      expect((await next((m) => m.type === 0x02 && m.stream === 1)).payload.toString()).toBe('ping')
      expect(proxy.heads.at(-1)).toMatch(new RegExp(`^CONNECT 127\\.0\\.0\\.1:${echoPort} HTTP/1.1\r\n`))
      ws.close()
    })
  })
})
