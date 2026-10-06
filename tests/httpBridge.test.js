import { describe, expect, it } from 'vitest'
import { encodeRequest, fetchFromMachine, parseResponse } from '../src/lib/linux/httpBridge.js'

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
