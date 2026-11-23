// Builds (and optionally serves) a self-hosted Wasmer HTTP host for Opcode's
// web preview. The preview loads servers from programs in the sandbox through
// a service worker on this host's origin, which must differ from the app's
// (the guest server owns the whole origin). By default Opcode uses Wasmer's
// https://default.local.wasmer.site/; deploy this folder to your own origin
// and build the app with VITE_PREVIEW_HOST=https://your-preview-origin/.
//
// Serve the same files on every subdomain of a domain (wildcard DNS and
// certificate) and use VITE_PREVIEW_HOST=https://*.preview.example.com/: each
// server then gets its own address, and several previews work at once.
// worker.js does that on Cloudflare (route *.preview.example.com/*).
//
//   node scripts/preview-host.mjs              -> dist-preview-host/
//   node scripts/preview-host.mjs --serve 5174 -> also serve it locally, on
//     http://localhost:5174/ and on every http://<name>.localhost:5174/
//   --out <folder> writes it elsewhere.
//
// OPCODE_APP_ORIGINS=https://opcode.example.com limits the host to that app
// (comma-separate several): see appOrigins below.
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const outIndex = process.argv.indexOf('--out')
const out = outIndex === -1 ? join(root, 'dist-preview-host') : resolve(process.argv[outIndex + 1])
const sdk = join(root, 'node_modules/@wasmer/sdk/dist')

// The host page is embedded by the cross-origin isolated app.
const HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

// OPCODE_APP_ORIGINS: the app origins that may use this host, comma-separated
// (https://opcode.example.com,http://localhost:5173). Set, host.html works
// only for them and only they may embed it. Unset, any site may.
const appOrigins = (process.env.OPCODE_APP_ORIGINS ?? '').split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean)
for (const origin of appOrigins) {
  let valid = false
  try {
    valid = new URL(origin).origin === origin
  } catch {
    // Not a URL.
  }
  if (!valid) throw new Error(`OPCODE_APP_ORIGINS: "${origin}" is not an origin such as https://opcode.example.com`)
}

// host.html's own headers. Pages a previewed server serves share its origin
// and can run code in it; sandboxed (keeping its origin, which the service
// worker needs), it can't navigate the app's tab or open windows for them.
// Opcode also sandboxes the frame itself (src/lib/linux/httpBridge.js); the
// header covers other embedders and hosts that can't take it from the frame.
const HOST_PAGE_HEADERS = {
  'Content-Security-Policy': ['sandbox allow-scripts allow-same-origin', ...(appOrigins.length ? [`frame-ancestors ${appOrigins.join(' ')}`] : [])].join('; '),
}

mkdirSync(join(out, '.wasmer'), { recursive: true })
copyFileSync(join(sdk, 'service-worker-host.js'), join(out, '.wasmer/host.js'))
copyFileSync(join(sdk, 'service-worker.js'), join(out, 'wasmer-service-worker.js'))
// host.html checks who embeds it before starting the SDK's host.js. With
// ?opcode=handoff (Opcode asks for it, see installSdkHostBroker() in
// src/lib/linux/httpBridge.js), it passes the SDK's connection to the app
// instead, which then runs the host in frames of its own.
const hostScript = `(() => {
  const allowed = ${JSON.stringify(appOrigins.length ? appOrigins : null)}
  const params = new URLSearchParams(location.search)
  const parentOrigin = params.get('parentOrigin')
  const connections = (handle) => addEventListener('message', (event) => {
    if (event.data?.type === 'wasmer-sdk:http-host-connect' && event.ports[0]) handle(event)
  })
  if (allowed && !allowed.includes(parentOrigin)) {
    connections(({ ports: [port] }) => {
      port.postMessage({ type: 'wasmer-sdk:http-host-error', error: 'This preview host does not serve ' + parentOrigin + '.' })
      port.close()
    })
  } else if (params.get('opcode') === 'handoff') {
    connections((event) => {
      if (event.origin === parentOrigin) parent.postMessage({ type: 'opcode:wasmer-host-handoff' }, parentOrigin, [event.ports[0]])
    })
  } else {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = '/.wasmer/host.js'
    document.head.append(script)
  }
})()`
writeFileSync(
  join(out, '.wasmer/host.html'),
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Opcode preview host</title>\n<script>\n${hostScript}\n</script></head><body></body></html>\n`,
)
writeFileSync(
  join(out, 'index.html'),
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Opcode preview</title></head>\n<body style="font-family:sans-serif;color:#555;padding:2rem">No server is being previewed. Start one in an Opcode terminal.</body></html>\n',
)
// Netlify / Cloudflare Pages headers; GitHub Pages must not skip .wasmer/.
const headerLines = (headers) => Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n')
writeFileSync(join(out, '_headers'), `/*\n${headerLines(HEADERS)}\n  Cache-Control: no-cache\n/.wasmer/host.html\n${headerLines(HOST_PAGE_HEADERS)}\n`)
writeFileSync(join(out, '.nojekyll'), '')

// The same files as a Cloudflare Worker, for wildcard hosts.
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/.wasmer/host.html': ['.wasmer/host.html', 'text/html; charset=utf-8', HOST_PAGE_HEADERS],
  '/.wasmer/host.js': ['.wasmer/host.js', 'text/javascript; charset=utf-8'],
  '/wasmer-service-worker.js': ['wasmer-service-worker.js', 'text/javascript; charset=utf-8'],
}
const embedded = Object.fromEntries(Object.entries(files).map(([path, [file, type, headers = {}]]) => [path, { body: readFileSync(join(out, file), 'utf8'), type, headers }]))
writeFileSync(
  join(out, 'worker.js'),
  `// Opcode's web preview host as a Cloudflare Worker (generated by
// scripts/preview-host.mjs). Route it to *.preview.example.com/* and build
// Opcode with VITE_PREVIEW_HOST=https://*.preview.example.com/.
const FILES = ${JSON.stringify(embedded)}
const HEADERS = ${JSON.stringify({ ...HEADERS, 'Cache-Control': 'no-cache' })}
export default {
  fetch(request) {
    const file = FILES[new URL(request.url).pathname]
    if (!file) return new Response('Not found', { status: 404, headers: HEADERS })
    return new Response(file.body, { headers: { ...HEADERS, ...file.headers, 'Content-Type': file.type } })
  },
}
`,
)
console.log(`Preview host written to ${out}`)

const serveIndex = process.argv.indexOf('--serve')
if (serveIndex !== -1) {
  const port = Number(process.argv[serveIndex + 1] || 5174)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
  createServer((request, response) => {
    let path
    try {
      path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
    } catch {
      return response.writeHead(400, HEADERS).end()
    }
    let file = join(out, path === '/' ? 'index.html' : path)
    try {
      if (!statSync(file).isFile()) throw new Error('not a file')
    } catch {
      response.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain' }).end('Not found')
      return
    }
    const own = path.split(sep).join('/') === '/.wasmer/host.html' ? HOST_PAGE_HEADERS : {}
    response.writeHead(200, { ...HEADERS, ...own, 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
    response.end(readFileSync(file))
  }).listen(port, () => console.log(`Preview host on http://localhost:${port}/ and http://*.localhost:${port}/ (build the app with VITE_PREVIEW_HOST=http://*.localhost:${port}/)`))
}
