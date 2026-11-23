// Opcode's production server, which the Docker image runs. It serves a build
// (dist/) with the cross-origin isolation headers the app needs, files
// compressed ahead of time (scripts/precompress.mjs), and optionally the
// internet relay and the web preview host, all on one port. It is configured
// from the environment:
//
//   PORT                  the port to listen on (8080)
//   OPCODE_RELAY          internet access for terminals and Linux machines:
//                         "on" serves a relay (scripts/wisp-server.mjs) at
//                         /wisp/; a wss:// address uses that relay; "off"
//                         (the default) leaves it to each user's Internet
//                         settings
//   OPCODE_RELAY_ARGS     the built-in relay's options, as
//                         scripts/wisp-server.mjs takes them, e.g.
//                         "--max-streams 32 --via-proxy http://proxy:3128"
//   OPCODE_RELAY_ORIGINS  other sites whose pages may use the built-in relay
//                         (comma-separated; this site always may)
//   OPCODE_PREVIEW_HOST   the web preview's origin, served here from
//                         dist-preview-host/ to requests for that host name:
//                         https://preview.example.com/, or
//                         https://*.preview.example.com/ for one address per
//                         server. By default the preview uses Wasmer's host.
//   OPCODE_APP_ORIGINS    the app's own origin (https://opcode.example.com;
//                         comma-separate several): only its pages may then
//                         embed the preview host served here
//   OPCODE_TRUST_PROXY    "on" when a proxy in front of this server sets
//                         X-Forwarded-Host (replacing any the client sent):
//                         the host name is then read from it. "off" (the
//                         default) uses the Host header, which Caddy (as in
//                         compose.yaml) passes on unchanged, and ignores
//                         X-Forwarded-Host, since any client can send one.
//
// With any of these set, /config.js tells the app about them (it would
// otherwise come from the build: public/config.js).
//
//   npm run build && npm run build:preview-host && node scripts/precompress.mjs
//   npm start

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import http from 'node:http'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRelay, parseArgs } from './wisp-server.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELAY_PATH = '/wisp/'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.tar': 'application/x-tar',
  // Toolchains and machines the app unpacks itself: sent as they are.
  '.gz': 'application/gzip',
}

// The app needs cross-origin isolation (SharedArrayBuffer).
// It is never meant to be framed, by other sites or by itself.
const APP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
}
// The preview host is embedded by the app (as scripts/preview-host.mjs serves it).
const PREVIEW_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
}

/** The server's settings from environment variables (see the top of this file). */
export function configFromEnv(env = process.env) {
  const relay = (env.OPCODE_RELAY ?? '').trim()
  if (relay && !['on', 'off'].includes(relay) && !/^wss?:\/\//.test(relay)) {
    throw new Error(`OPCODE_RELAY must be "on", "off" or a ws:// or wss:// address, not "${relay}"`)
  }
  const appOrigins = (env.OPCODE_APP_ORIGINS ?? '').split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean)
  for (const origin of appOrigins) {
    let valid = false
    try {
      valid = new URL(origin).origin === origin
    } catch {
      // Not a URL.
    }
    if (!valid) throw new Error(`OPCODE_APP_ORIGINS: "${origin}" is not an origin such as https://opcode.example.com`)
  }
  const trustProxy = (env.OPCODE_TRUST_PROXY ?? '').trim()
  if (trustProxy && !['on', 'off'].includes(trustProxy)) {
    throw new Error(`OPCODE_TRUST_PROXY must be "on" or "off", not "${trustProxy}"`)
  }
  const previewHost = (env.OPCODE_PREVIEW_HOST ?? '').trim()
  if (previewHost && !/^https?:\/\/[^/]+\/?$/.test(previewHost)) {
    throw new Error(`OPCODE_PREVIEW_HOST must be an origin such as https://preview.example.com/, not "${previewHost}"`)
  }
  return {
    port: Number(env.PORT || 8080),
    relay: relay === 'off' ? '' : relay,
    relayOptions: parseArgs((env.OPCODE_RELAY_ARGS ?? '').split(/\s+/).filter(Boolean)),
    relayOrigins: (env.OPCODE_RELAY_ORIGINS ?? '').split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean),
    previewHost: previewHost && !previewHost.endsWith('/') ? `${previewHost}/` : previewHost,
    trustProxy: trustProxy === 'on',
    appOrigins,
  }
}

/**
 * The host a request was made to, as the browser saw it. X-Forwarded-Host
 * only counts behind a proxy the operator trusts (OPCODE_TRUST_PROXY): anyone
 * can send one, and a cache in front could then keep the wrong site's page.
 */
function publicHost(request, trustProxy) {
  const forwarded = trustProxy ? request.headers['x-forwarded-host']?.split(',')[0] : undefined
  return (forwarded ?? request.headers.host ?? '').trim().toLowerCase()
}

function splitHost(host) {
  try {
    const url = new URL(`http://${host}`)
    return { hostname: url.hostname, port: url.port }
  } catch {
    return { hostname: '', port: '' }
  }
}

/** Does a request go to the preview host (`https://*.preview.example.com/` or one origin)? */
function previewMatcher(previewHost, trustProxy) {
  if (!previewHost) return () => false
  const wildcard = previewHost.includes('*.')
  const { hostname, port } = new URL(previewHost.replace('*.', 'any.'))
  const suffix = hostname.slice('any'.length) // ".preview.example.com"
  return (request) => {
    const host = splitHost(publicHost(request, trustProxy))
    // The address names a port when the browser uses one, as in development
    // (http://*.localhost:8080/); behind a proxy on 443 it doesn't.
    if (port && host.port !== port) return false
    return wildcard ? host.hostname.endsWith(suffix) && host.hostname.length > suffix.length : host.hostname === hostname
  }
}

/** Precompressed copies: relative path -> encodings available. */
function indexCompressed(dir) {
  const index = new Map()
  if (!dir || !existsSync(dir)) return index
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(br|gz)$/.test(entry.name)) {
        const original = relative(dir, path).slice(0, -3).split(sep).join('/')
        if (!index.has(original)) index.set(original, new Set())
        index.get(original).add(entry.name.endsWith('.br') ? 'br' : 'gzip')
      }
    }
  }
  walk(dir)
  return index
}

function acceptedEncodings(request) {
  const accepted = new Set()
  for (const part of (request.headers['accept-encoding'] ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='))
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name)
  }
  return accepted
}

// A file's details, or undefined. statSync throws for some names even with
// throwIfNoEntry: false (ENAMETOOLONG for a long one), and a request must
// never take the server down.
function stat(path) {
  try {
    return statSync(path, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

/** A static site: `root`, with copies compressed ahead of time in `compressed`. */
function staticSite(root, compressed, headers, { immutable = () => false, own = () => ({}) } = {}) {
  root = resolve(root)
  const encodings = indexCompressed(compressed)
  return (request, response, pathname) => {
    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return notFound(response, headers)
    }
    let path = resolve(root, `.${decoded}`)
    if (decoded.includes('\0') || (path !== root && !path.startsWith(root + sep))) return notFound(response, headers)
    let stats = stat(path)
    if (stats?.isDirectory()) {
      if (!pathname.endsWith('/')) {
        // Built from the folder found, not from the request: "//evil.example/.."
        // must not become a redirect to another site.
        const folder = relative(root, path).split(sep).filter(Boolean).map(encodeURIComponent)
        response.writeHead(301, { ...headers, Location: `/${folder.map((part) => `${part}/`).join('')}` }).end()
        return
      }
      path = join(path, 'index.html')
      stats = stat(path)
    }
    if (!stats?.isFile()) return notFound(response, headers)

    const name = relative(root, path).split(sep).join('/')
    const available = encodings.get(name)
    const accepted = available && acceptedEncodings(request)
    let encoding = available && ['br', 'gzip'].find((candidate) => available.has(candidate) && accepted.has(candidate))
    let file = path
    if (encoding) {
      const copy = join(compressed, `${name}.${encoding === 'br' ? 'br' : 'gz'}`)
      const copyStats = stat(copy)
      // A copy older than the file is from an earlier build.
      if (copyStats && copyStats.mtimeMs >= stats.mtimeMs) {
        file = copy
        stats = copyStats
      } else encoding = undefined
    }
    const etag = `"${stats.size.toString(36)}-${Math.floor(stats.mtimeMs).toString(36)}${encoding ? `-${encoding}` : ''}"`
    const head = {
      ...headers,
      ...own(name),
      'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': immutable(name) ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
      'Last-Modified': stats.mtime.toUTCString(),
      ...(available ? { Vary: 'Accept-Encoding' } : {}),
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
    }
    if (request.headers['if-none-match']?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
      response.writeHead(304, head).end()
      return
    }
    response.writeHead(200, { ...head, 'Content-Length': stats.size })
    if (request.method === 'HEAD') return response.end()
    pipeline(createReadStream(file), response, () => {})
  }
}

function notFound(response, headers) {
  response.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n')
}

/**
 * Opcode's server (an http.Server, not yet listening). `config` is
 * configFromEnv()'s; `dist`, `previewDist` and `compressed` are folders.
 */
export function createOpcodeServer(config, { dist = join(ROOT, 'dist'), previewDist = join(ROOT, 'dist-preview-host'), compressed = join(ROOT, 'dist-compressed') } = {}) {
  const app = staticSite(dist, compressed, APP_HEADERS, { immutable: (name) => name.startsWith('assets/') })
  // The preview host's page is sandboxed: pages a previewed server serves
  // share its origin and can run code in it, and sandboxed it can't navigate
  // the app's tab for them. Only the app's own pages may embed it, when the
  // server knows which they are (OPCODE_APP_ORIGINS). The header goes by the
  // file, so no other spelling of its path gets the page without it.
  const hostPolicy = ['sandbox allow-scripts allow-same-origin', ...(config.appOrigins?.length ? [`frame-ancestors ${config.appOrigins.join(' ')}`] : [])].join('; ')
  const preview = staticSite(previewDist, null, { ...PREVIEW_HEADERS, 'Cache-Control': 'no-cache' }, { own: (name) => (name === '.wasmer/host.html' ? { 'Content-Security-Policy': hostPolicy } : {}) })
  const isPreview = previewMatcher(config.previewHost, config.trustProxy)

  let relay = null
  if (config.relay === 'on') {
    const origins = [...config.relayOptions.origins, ...config.relayOrigins]
    relay = createRelay(config.relayOptions, (request) => {
      const origin = request.headers.origin?.replace(/\/+$/, '')
      // Same-origin fetches may send no Origin; programs outside a browser
      // could send any, so its absence gives them nothing.
      if (!origin) return true
      if (origins.includes(origin)) return true
      try {
        return new URL(origin).host.toLowerCase() === publicHost(request, config.trustProxy)
      } catch {
        return false
      }
    })
  }

  // The app's settings, when the environment gives any (see public/config.js).
  const settings = {}
  if (config.relay) settings.relay = config.relay === 'on' ? RELAY_PATH : config.relay
  if (config.previewHost) settings.previewHost = config.previewHost
  const configScript = Object.keys(settings).length
    ? `// Written by scripts/server.mjs from its environment (see public/config.js).\nwindow.OPCODE_CONFIG = ${JSON.stringify(settings, null, 2)}\n`
    : null

  const handle = (request, response) => {
    const pathname = pathOf(request.url)
    if (pathname === null) return response.writeHead(400).end()
    if (isPreview(request)) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(405, { ...PREVIEW_HEADERS, Allow: 'GET, HEAD' }).end()
      return preview(request, response, pathname)
    }
    if (relay && pathname === '/dns-query') return relay.serveDns(request, response)
    if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(405, { ...APP_HEADERS, Allow: 'GET, HEAD' }).end()
    if (configScript && pathname === '/config.js') {
      response.writeHead(200, { ...APP_HEADERS, 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-cache' })
      return response.end(request.method === 'HEAD' ? undefined : configScript)
    }
    app(request, response, pathname)
  }
  // Whatever goes wrong with one request, keep serving the others (and the
  // relay's WebSockets, which share the process).
  const server = http.createServer((request, response) => {
    try {
      handle(request, response)
    } catch (error) {
      console.error(`${request.method} ${request.url}: ${error.stack ?? error}`)
      if (response.headersSent) response.destroy()
      else response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Server error\n')
    }
  })
  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = pathOf(request.url)
      if (relay && !isPreview(request) && (pathname === RELAY_PATH || pathname === RELAY_PATH.slice(0, -1))) return relay.upgrade(request, socket, head)
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    } catch (error) {
      console.error(`upgrade ${request.url}: ${error.stack ?? error}`)
      socket.destroy()
    }
  })
  return server
}

// A request's path, or null when the URL can't be parsed ("//[", "//h:99999/"):
// a bad request must not take the server down.
function pathOf(url) {
  try {
    return new URL(url, 'http://opcode').pathname
  } catch {
    return null
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let config
  try {
    config = configFromEnv()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    console.error('No build to serve: run npm run build first.')
    process.exit(1)
  }
  const server = createOpcodeServer(config)
  server.listen(config.port, () => {
    console.log(`Opcode on http://localhost:${server.address().port}/`)
    console.log(
      `  Internet access: ${config.relay === 'on' ? `relay at ${RELAY_PATH}` : config.relay ? `relay ${config.relay}` : 'off (set OPCODE_RELAY=on to turn it on; users can also choose a relay in the Internet settings)'}`,
    )
    console.log(`  Web preview: ${config.previewHost ? `${config.previewHost} (served here)` : "Wasmer's host (set OPCODE_PREVIEW_HOST to host it here)"}`)
  })
  // `docker stop` sends SIGTERM; open WebSockets would keep server.close() waiting.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))
}
