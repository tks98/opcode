// Opcode's production server (scripts/server.mjs) and the files it compresses
// ahead of time (scripts/precompress.mjs), on a small stand-in build.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brotliDecompressSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { precompress } from '../scripts/precompress.mjs'
import { configFromEnv, createOpcodeServer } from '../scripts/server.mjs'

const WASM = Buffer.from('\0asm'.repeat(20_000)) // compresses well

function write(root, files) {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), data)
  }
}

/** A raw request (Node's fetch would decompress): { status, headers, body }. */
function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
      })
      .on('error', reject)
  })
}

/** A request sent byte for byte, for paths http.get would tidy up: { status, headers }. */
function raw(port, target, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
    let text = ''
    socket.on('data', (chunk) => (text += chunk.toString('latin1')))
    socket.on('close', () => {
      const [status, ...lines] = text.split('\r\n\r\n')[0].split('\r\n')
      resolve({ status: Number(status.split(' ')[1]), headers: Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()])) })
    })
    socket.on('error', reject)
  })
}

function connect(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/wisp/`, { headers })
    ws.once('message', () => resolve('open'))
    ws.once('unexpected-response', (_, response) => resolve(response.statusCode))
    ws.once('error', () => resolve('error'))
  })
}

describe('production server', () => {
  let root
  const servers = []

  async function start(env = {}) {
    const server = createOpcodeServer(configFromEnv(env), { dist: join(root, 'dist'), previewDist: join(root, 'preview'), compressed: join(root, 'compressed') })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    return server.address().port
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'opcode-server-'))
    write(join(root, 'dist'), {
      'index.html': '<!doctype html><title>Opcode</title>',
      'config.js': 'window.OPCODE_CONFIG = {}\n',
      'assets/app-1234abcd.js': 'console.log("app")\n'.repeat(200),
      'assets/llvm.core-abcd.wasm': WASM,
      'toolchains/go.wasm.gz': gzipSync(WASM),
      'linux/opcode-linux.state': gzipSync(Buffer.alloc(100_000)),
      'docs folder/index.html': 'docs',
    })
    write(join(root, 'preview'), { 'index.html': 'No server is being previewed.', '.wasmer/host.html': '<!doctype html><title>host</title>' })
    write(root, { 'secret.txt': 'outside the build' })
    await precompress(join(root, 'dist'), join(root, 'compressed'))
  })
  afterAll(() => {
    for (const server of servers) server.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('reads its settings from the environment', () => {
    expect(configFromEnv({})).toMatchObject({ port: 8080, relay: '', previewHost: '', relayOrigins: [] })
    expect(configFromEnv({ PORT: '3000', OPCODE_RELAY: 'on', OPCODE_RELAY_ARGS: '--max-streams 8 --allow-private', OPCODE_PREVIEW_HOST: 'https://*.preview.example.com' })).toMatchObject({
      port: 3000,
      relay: 'on',
      relayOptions: { maxStreams: 8, allowPrivate: true },
      previewHost: 'https://*.preview.example.com/',
    })
    expect(configFromEnv({ OPCODE_RELAY: 'off' }).relay).toBe('')
    expect(configFromEnv({ OPCODE_RELAY: 'wss://relay.example.com/' }).relay).toBe('wss://relay.example.com/')
    expect(() => configFromEnv({ OPCODE_RELAY: 'yes' })).toThrow(/OPCODE_RELAY/)
    expect(() => configFromEnv({ OPCODE_PREVIEW_HOST: 'preview.example.com' })).toThrow(/OPCODE_PREVIEW_HOST/)
    expect(() => configFromEnv({ OPCODE_RELAY_ARGS: '--unknown' })).toThrow(/Unknown option/)
    expect(configFromEnv({}).trustProxy).toBe(false)
    expect(configFromEnv({ OPCODE_TRUST_PROXY: 'on' }).trustProxy).toBe(true)
    expect(configFromEnv({ OPCODE_TRUST_PROXY: 'off' }).trustProxy).toBe(false)
    expect(() => configFromEnv({ OPCODE_TRUST_PROXY: 'yes' })).toThrow(/OPCODE_TRUST_PROXY/)
  })

  it('serves the app cross-origin isolated, with caching by kind of file', async () => {
    const port = await start()
    const index = await request(port, '/')
    expect(index.status).toBe(200)
    expect(index.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(index.headers['cross-origin-embedder-policy']).toBe('require-corp')
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(index.headers['cache-control']).toBe('no-cache')
    // Never framed.
    expect(index.headers['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(index.body.toString()).toContain('<title>Opcode</title>')
    expect((await request(port, '/', { 'If-None-Match': index.headers.etag })).status).toBe(304)

    const script = await request(port, '/assets/app-1234abcd.js')
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable')

    // Toolchains and machines go as they are (the app unpacks them).
    const toolchain = await request(port, '/toolchains/go.wasm.gz', { 'Accept-Encoding': 'br, gzip' })
    expect(toolchain.headers['content-type']).toBe('application/gzip')
    expect(toolchain.headers['content-encoding']).toBeUndefined()
    const state = await request(port, '/linux/opcode-linux.state', { 'Accept-Encoding': 'br, gzip' })
    expect(state.headers['content-encoding']).toBeUndefined()
  })

  it('sends compressed copies to browsers that accept them', async () => {
    const port = await start()
    const br = await request(port, '/assets/llvm.core-abcd.wasm', { 'Accept-Encoding': 'gzip, deflate, br' })
    expect(br.headers['content-type']).toBe('application/wasm')
    expect(br.headers['content-encoding']).toBe('br')
    expect(br.headers.vary).toBe('Accept-Encoding')
    expect(br.body.length).toBeLessThan(WASM.length / 10)
    expect(brotliDecompressSync(br.body).equals(WASM)).toBe(true)

    expect((await request(port, '/assets/llvm.core-abcd.wasm', { 'Accept-Encoding': 'gzip' })).headers['content-encoding']).toBe('gzip')
    expect((await request(port, '/assets/llvm.core-abcd.wasm', { 'Accept-Encoding': 'br;q=0, gzip' })).headers['content-encoding']).toBe('gzip')
    const plain = await request(port, '/assets/llvm.core-abcd.wasm')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.equals(WASM)).toBe(true)
    // Each copy has its own ETag.
    expect(plain.headers.etag).not.toBe(br.headers.etag)
  })

  it('ignores compressed copies older than their file (a later build)', async () => {
    const port = await start()
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(root, 'dist/assets/app-1234abcd.js'), later, later)
    const script = await request(port, '/assets/app-1234abcd.js', { 'Accept-Encoding': 'br, gzip' })
    expect(script.headers['content-encoding']).toBeUndefined()
    expect(script.body.toString()).toContain('console.log("app")')
  })

  it('serves nothing outside the build', async () => {
    const port = await start()
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/missing.js']) {
      expect((await request(port, path)).status).toBe(404)
    }
    expect((await request(port, '/assets')).status).toBe(301)
  })

  it('survives requests the file system rejects', async () => {
    const port = await start()
    // Too long for a file name: statSync throws ENAMETOOLONG.
    expect((await request(port, `/${'A'.repeat(300)}`)).status).toBe(404)
    expect((await request(port, `/assets/${'A'.repeat(300)}/x.js`)).status).toBe(404)
    expect((await request(port, `/${'A/'.repeat(3000)}`)).status).toBe(404)
    expect((await request(port, '/')).status).toBe(200)
  })

  it('redirects folders only to paths on this site', async () => {
    const port = await start()
    for (const target of ['/assets', '//x//evil.example/..%2fassets', '/.//evil.example/..%2fassets', '//x/\\evil.example/..%2fassets', '//evil.example/assets']) {
      const response = await raw(port, target)
      expect(response.status, target).toBe(301)
      expect(response.headers.location, target).toBe('/assets/')
    }
    // Names are sent encoded.
    expect((await raw(port, '/docs%20folder')).headers.location).toBe('/docs%20folder/')
    expect((await request(port, '/docs%20folder/')).body.toString()).toBe('docs')
  })

  it("gives the app the environment's settings, or the build's own", async () => {
    expect((await request(await start(), '/config.js')).body.toString()).toBe('window.OPCODE_CONFIG = {}\n')
    const port = await start({ OPCODE_RELAY: 'on', OPCODE_PREVIEW_HOST: 'https://*.preview.example.com/' })
    const config = await request(port, '/config.js')
    expect(config.headers['content-type']).toBe('text/javascript; charset=utf-8')
    const window = {}
    new Function('window', config.body.toString())(window)
    expect(window.OPCODE_CONFIG).toEqual({ relay: '/wisp/', previewHost: 'https://*.preview.example.com/' })
  })

  it('serves the preview host to requests for its addresses', async () => {
    const port = await start({ OPCODE_PREVIEW_HOST: 'https://*.preview.example.com/' })
    const host = await request(port, '/.wasmer/host.html', { Host: 'p12345.preview.example.com' })
    expect(host.status).toBe(200)
    expect(host.body.toString()).toContain('<title>host</title>')
    expect(host.headers['cross-origin-resource-policy']).toBe('cross-origin')
    // The app frames it; sandboxed, it can't navigate the app's tab.
    expect(host.headers['content-security-policy']).toBe('sandbox allow-scripts allow-same-origin')
    // Whatever the spelling of its path.
    expect((await request(port, '/.wasmer//x/../host.html', { Host: 'p12345.preview.example.com' })).headers['content-security-policy']).toBe('sandbox allow-scripts allow-same-origin')
    expect((await request(port, '/', { Host: 'p12345.preview.example.com' })).headers['content-security-policy']).toBeUndefined()
    // Only the app's pages may embed it, when the server is told which they are.
    const listed = await start({ OPCODE_PREVIEW_HOST: 'https://*.preview.example.com/', OPCODE_APP_ORIGINS: 'https://opcode.example.com/' })
    expect((await request(listed, '/.wasmer/host.html', { Host: 'p1.preview.example.com' })).headers['content-security-policy']).toBe('sandbox allow-scripts allow-same-origin; frame-ancestors https://opcode.example.com')
    expect(() => configFromEnv({ OPCODE_APP_ORIGINS: 'opcode.example.com' })).toThrow(/OPCODE_APP_ORIGINS/)
    // X-Forwarded-Host is the client's word unless a trusted proxy sets it.
    expect((await request(port, '/', { Host: 'opcode.example.com', 'X-Forwarded-Host': 'p1.preview.example.com' })).body.toString()).toContain('<title>Opcode</title>')
    expect((await request(port, '/', { Host: 'p1.preview.example.com', 'X-Forwarded-Host': 'opcode.example.com' })).body.toString()).toContain('No server')
    const proxied = await start({ OPCODE_PREVIEW_HOST: 'https://*.preview.example.com/', OPCODE_TRUST_PROXY: 'on' })
    expect((await request(proxied, '/', { Host: 'opcode:8080', 'X-Forwarded-Host': 'p1.preview.example.com' })).body.toString()).toContain('No server')
    expect((await request(proxied, '/', { Host: 'opcode:8080' })).body.toString()).toContain('<title>Opcode</title>')
    // The app's own address, and the bare domain, are the app.
    expect((await request(port, '/', { Host: 'opcode.example.com' })).body.toString()).toContain('<title>Opcode</title>')
    expect((await request(port, '/', { Host: 'preview.example.com' })).body.toString()).toContain('<title>Opcode</title>')

    // One origin, with a port: only that port.
    const local = await start({ OPCODE_PREVIEW_HOST: 'http://localhost:8081/' })
    expect((await request(local, '/', { Host: 'localhost:8081' })).body.toString()).toContain('No server')
    expect((await request(local, '/', { Host: 'localhost:8080' })).body.toString()).toContain('<title>Opcode</title>')
  })

  it('relays for pages of its own site when the relay is on', async () => {
    const off = await start()
    expect(await connect(off, { Origin: `http://127.0.0.1:${off}` })).toBe(404)
    expect((await request(off, '/dns-query')).status).toBe(404)

    const port = await start({ OPCODE_RELAY: 'on', OPCODE_RELAY_ORIGINS: 'https://other.example.com' })
    expect(await connect(port, { Origin: `http://127.0.0.1:${port}` })).toBe('open')
    expect(await connect(port, { Origin: 'https://other.example.com' })).toBe('open')
    expect(await connect(port, { Origin: 'https://evil.example.com' })).toBe(403)
    expect((await request(port, '/dns-query', { Origin: 'https://evil.example.com' })).status).toBe(403)
    // A forged X-Forwarded-Host doesn't make another site's page this site's.
    expect(await connect(port, { Origin: 'https://evil.example.com', 'X-Forwarded-Host': 'evil.example.com' })).toBe(403)
    const proxied = await start({ OPCODE_RELAY: 'on', OPCODE_TRUST_PROXY: 'on' })
    expect(await connect(proxied, { Origin: 'https://opcode.example.com', 'X-Forwarded-Host': 'opcode.example.com' })).toBe('open')
  })
})
