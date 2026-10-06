// Runs the relay (scripts/wisp-server.mjs) against a local echo server.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

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
    for (const relay of relays) relay.child.kill()
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
})
