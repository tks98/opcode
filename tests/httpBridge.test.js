import { describe, expect, it } from 'vitest'
import { encodeRequest, fetchFromMachine, MAX_HEAD_BYTES, MAX_RESPONSE_BYTES, parseResponse, ResponseReader } from '../src/lib/linux/httpBridge.js'

const text = (bytes) => new TextDecoder().decode(bytes)
const bytes = (string) => new TextEncoder().encode(string)

describe('encodeRequest', () => {
  it('writes an HTTP/1.1 request that closes its connection', () => {
    const request = text(encodeRequest({ method: 'GET', path: '/style.css?v=2', headers: [['Accept', 'text/css'], ['Accept-Encoding', 'gzip'], ['Host', 'p1.localhost:5174']] }, 8080))
    expect(request).toBe('GET /style.css?v=2 HTTP/1.1\r\nHost: localhost:8080\r\nConnection: close\r\nAccept: text/css\r\n\r\n')
  })

  it('sends a body with its length', () => {
    const request = text(encodeRequest({ method: 'POST', path: '/form', headers: [['Content-Type', 'text/plain']], body: bytes('hi') }, 80))
    expect(request).toMatch(/Content-Length: 2\r\n\r\nhi$/)
    expect(text(encodeRequest({ method: 'POST', path: '/' }, 80))).toContain('Content-Length: 0')
  })
})

describe('parseResponse', () => {
  it('waits for the head, then for Content-Length bytes', () => {
    expect(parseResponse(bytes('HTTP/1.1 200 OK\r\nContent-Le'))).toBeNull()
    const partial = parseResponse(bytes('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhel'))
    expect(partial.complete).toBe(false)
    const done = parseResponse(bytes('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello'))
    expect(done).toMatchObject({ status: 200, statusText: 'OK', headers: [['Content-Type', 'text/plain']], complete: true })
    expect(text(done.body)).toBe('hello')
  })

  it('decodes chunked bodies', () => {
    const raw = 'HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nnot \r\n5;ext=1\r\nfound\r\n0\r\n\r\n'
    const response = parseResponse(bytes(raw))
    expect(response).toMatchObject({ status: 404, complete: true, headers: [] })
    expect(text(response.body)).toBe('not found')
    expect(parseResponse(bytes(raw.slice(0, -7))).complete).toBe(false)
  })

  it('takes only hex digits as a chunk size', () => {
    // Negative and non-hex sizes once looped forever (security-review-pocs/preview/chunk.mjs).
    for (const size of ['-2', '-1', '+4', '0x4', '4 4', '', ' ', 'g', '1z', '١']) {
      const started = Date.now()
      const response = parseResponse(bytes(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n${size}\r\nAAAA\r\n0\r\n\r\n`))
      expect(response.complete, size).toBe(true)
      expect(text(response.body), size).toBe('ok')
      expect(Date.now() - started).toBeLessThan(1000)
    }
    expect(text(parseResponse(bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nA\r\n0123456789\r\na;x=y\r\n0123456789\r\n0\r\n\r\n')).body)).toBe('01234567890123456789')
  })

  it('refuses answers past the size limits', () => {
    expect(() => parseResponse(bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${MAX_RESPONSE_BYTES + 1}\r\n\r\n`))).toThrow(/larger/)
    expect(() => parseResponse(bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nffffffff\r\n'))).toThrow(/larger/)
    expect(() => parseResponse(bytes(`HTTP/1.1 200 OK\r\nX: ${'a'.repeat(MAX_HEAD_BYTES)}`))).toThrow(/headers/)
    expect(() => parseResponse(bytes(`HTTP/1.1 200 OK\r\nX: ${'a'.repeat(MAX_HEAD_BYTES)}\r\n\r\n`))).toThrow(/headers/)
    expect(parseResponse(bytes('HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\n\r\nhello'), { ended: true }).complete).toBe(true)
  })

  it('reads to the end of the connection without a length, and knows bodiless answers', () => {
    const raw = bytes('HTTP/1.0 200 OK\r\nServer: SimpleHTTP\r\n\r\n<h1>hi</h1>')
    expect(parseResponse(raw).complete).toBe(false)
    expect(text(parseResponse(raw, { ended: true }).body)).toBe('<h1>hi</h1>')
    expect(parseResponse(bytes('HTTP/1.1 304 Not Modified\r\nETag: "x"\r\n\r\n')).complete).toBe(true)
    expect(parseResponse(bytes('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n'), { method: 'HEAD' }).complete).toBe(true)
  })

  it('rejects answers that are not HTTP', () => {
    expect(() => parseResponse(bytes('SSH-2.0-OpenSSH\r\n\r\n'))).toThrow(/HTTP/)
  })
})

describe('ResponseReader', () => {
  const feed = (raw, size) => {
    const reader = new ResponseReader('GET')
    const data = bytes(raw)
    for (let i = 0; i < data.length; i += size) {
      reader.push(data.subarray(i, i + size))
      const response = reader.read(false)
      if (response) return { response, at: Math.min(i + size, data.length), length: data.length }
    }
    return { response: null }
  }

  it('finds the end of the answer however the bytes arrive', () => {
    const chunked = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nnot \r\n5;ext=1\r\nfound\r\n0\r\n\r\n'
    const sized = 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'
    for (const size of [1, 2, 3, 7, 1000]) {
      const a = feed(chunked, size)
      expect(text(a.response.body)).toBe('not found')
      expect(a.at).toBeGreaterThanOrEqual(chunked.length - 4) // the trailer's last CRLF is optional
      const b = feed(sized, size)
      expect(text(b.response.body)).toBe('hello')
      expect(b.at).toBe(sized.length)
    }
    expect(feed('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel', 4).response).toBeNull()
  })

  it('ends at a malformed chunk size, and with the connection', () => {
    expect(text(feed('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n-1\r\nxx', 5).response.body)).toBe('ok')
    const reader = new ResponseReader('GET')
    reader.push(bytes('HTTP/1.0 200 OK\r\n\r\nall'))
    expect(reader.read(false)).toBeNull()
    expect(text(reader.read(true).body)).toBe('all')
  })

  it('takes a large answer in time proportional to its size', () => {
    const reader = new ResponseReader('GET')
    const chunk = new Uint8Array(1460).fill(97)
    const total = 20 * 1024 * 1024
    reader.push(bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${total}\r\n\r\n`))
    const started = Date.now()
    let response = null
    for (let sent = 0; sent < total; sent += chunk.length) {
      reader.push(chunk.subarray(0, Math.min(chunk.length, total - sent)))
      response = reader.read(false)
    }
    expect(response.body.length).toBe(total)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('refuses more than the limit', () => {
    const reader = new ResponseReader('GET')
    reader.push(bytes('HTTP/1.1 200 OK\r\n\r\n'))
    reader.read(false)
    const block = new Uint8Array(16 * 1024 * 1024)
    expect(() => {
      for (let i = 0; i < 6; i++) reader.push(block)
    }).toThrow(/larger/)
  })
})

// A stand-in for a v86 TCP connection.
function fakeConnect(script) {
  return () => {
    const handlers = {}
    const connection = {
      written: [],
      closed: false,
      on: (event, handler) => (handlers[event] = handler),
      write: (data) => connection.written.push(text(data)),
      close: () => (connection.closed = true),
    }
    queueMicrotask(() => script(handlers, connection))
    return connection
  }
}

describe('fetchFromMachine', () => {
  it('sends the request once connected and resolves with the answer', async () => {
    let sent
    const connect = fakeConnect((on, connection) => {
      on.connect()
      sent = connection.written.join('')
      on.data(bytes('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n'))
      on.data(bytes('ok'))
    })
    const response = await fetchFromMachine(connect, 8080, { method: 'GET', path: '/', headers: [] })
    expect(sent).toMatch(/^GET \/ HTTP\/1\.1\r\nHost: localhost:8080/)
    expect(response.status).toBe(200)
    expect(text(response.body)).toBe('ok')
  })

  it('retries a refused connection for a while, then explains it', async () => {
    const connect = fakeConnect((on) => on.close())
    await expect(fetchFromMachine(connect, 3000, { method: 'GET', path: '/', headers: [] }, { connectMs: 50, retryMs: 10 })).rejects.toThrow(/Nothing is listening on port 3000/)

    // A server that starts a moment after its port opened.
    let attempts = 0
    const late = fakeConnect((on) => {
      if (++attempts < 3) return on.close()
      on.connect()
      on.data(bytes('HTTP/1.1 204 No Content\r\n\r\n'))
    })
    const response = await fetchFromMachine(late, 80, { method: 'GET', path: '/', headers: [] }, { retryMs: 10 })
    expect(response.status).toBe(204)
    expect(attempts).toBe(3)
  })

  it('tries again when a connection request goes unanswered', async () => {
    let attempts = 0
    const connect = fakeConnect((on) => {
      if (++attempts < 2) return // lost: no answer at all
      on.connect()
      on.data(bytes('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
    })
    const response = await fetchFromMachine(connect, 80, { method: 'GET', path: '/', headers: [] }, { attemptMs: 30, retryMs: 10 })
    expect(response.status).toBe(200)
  })

  it('stops at a bad chunk size instead of hanging', async () => {
    const connect = fakeConnect((on) => {
      on.connect()
      on.data(bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n-2\r\n'))
    })
    const response = await fetchFromMachine(connect, 80, { method: 'GET', path: '/', headers: [] })
    expect(text(response.body)).toBe('ok')
  })

  it('gives up on an answer past the limit, and ignores data after that', async () => {
    let connection
    let after = 0
    const connect = fakeConnect((on, c) => {
      connection = c
      on.connect()
      on.data(bytes('HTTP/1.1 200 OK\r\n\r\n'))
      const block = new Uint8Array(16 * 1024 * 1024)
      for (let i = 0; i < 6; i++) on.data(block)
      after++
      on.data(block)
    })
    await expect(fetchFromMachine(connect, 80, { method: 'GET', path: '/', headers: [] })).rejects.toThrow(/larger/)
    expect(connection.closed).toBe(true)
    expect(after).toBe(1)
  })

  it('ends a body without a length when the server closes', async () => {
    const connect = fakeConnect((on) => {
      on.connect()
      on.data(bytes('HTTP/1.0 200 OK\r\n\r\nall of it'))
      on.shutdown()
    })
    const response = await fetchFromMachine(connect, 8000, { method: 'GET', path: '/', headers: [] })
    expect(text(response.body)).toBe('all of it')
  })
})
