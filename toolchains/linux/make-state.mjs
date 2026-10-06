// Boots Opcode Linux (from build.sh's output) in headless Chromium on the
// v86 emulator and saves the booted machine. The app restores this snapshot,
// so students get a running system instantly instead of waiting for a cold
// boot. Writes the snapshot (gzip) and manifest.json to public/linux/, or
// public/linux-docker/ for Opcode Docker.
//
// Usage: node toolchains/linux/make-state.mjs [docker]   (after build.sh)
// The snapshot only works with the exact v86 version that produced it, so
// re-run this after upgrading v86.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const VARIANTS = {
  linux: { memoryMB: 256, inputs: 'out', outDir: 'public/linux', snapshot: 'opcode-linux.state' },
  // Docker Engine and its images live in memory too, and containers need room.
  docker: { memoryMB: 1024, inputs: 'out-docker', outDir: 'public/linux-docker', snapshot: 'opcode-docker.state' },
}
const variant = VARIANTS[process.argv[2] ?? 'linux']
if (!variant) throw new Error(`Unknown variant ${process.argv[2]} (expected linux or docker)`)
const MEMORY_MB = variant.memoryMB
// Emulated hardware the snapshot was made with; saved machines record it so
// the app recreates matching hardware (1: v86's default NE2000 card and no
// network setup; 2: a virtio network card configured by DHCP).
export const HARDWARE = 2
// Snapshots bigger than this are split into parts (GitHub refuses files over
// 100 MB and warns about ones over 50 MB); the app joins them.
const PART_BYTES = 45 * 1024 * 1024
// init_on_free zeroes freed pages, which keeps snapshots small. The root
// filesystem lives in RAM; by default the kernel caps it at 64 MB, less than
// the system itself, so initramfs_options raises the cap.
const CMDLINE = 'console=ttyS0 console=hvc0 quiet loglevel=3 tsc=reliable mitigations=off random.trust_cpu=on init_on_free=1 initramfs_options=size=85%'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const v86Dir = path.join(root, 'node_modules/v86/build')
const outDir = path.join(root, variant.outDir)
const biosDir = path.join(root, 'public/linux')
const inputs = path.join(here, variant.inputs)

const files = {
  '/libv86.mjs': path.join(v86Dir, 'libv86.mjs'),
  '/v86.wasm': path.join(v86Dir, 'v86.wasm'),
  '/seabios.bin': path.join(biosDir, 'seabios.bin'),
  '/vgabios.bin': path.join(biosDir, 'vgabios.bin'),
  '/vmlinuz.bin': path.join(inputs, 'vmlinuz'),
  '/initramfs.bin': path.join(inputs, 'initramfs.cpio.gz'),
}
for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file} (run build.sh first)`)
}

const page = `<!doctype html><meta charset="utf-8"><script type="module">
import { V86 } from '/libv86.mjs'
const decoder = new TextDecoder()
window.result = new Promise((resolve, reject) => {
  let screen = '', agent = ''
  const emulator = new V86({
    wasm_path: '/v86.wasm',
    memory_size: ${MEMORY_MB} * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: { url: '/seabios.bin' },
    vga_bios: { url: '/vgabios.bin' },
    bzimage: { url: '/vmlinuz.bin' },
    initrd: { url: '/initramfs.bin' },
    cmdline: ${JSON.stringify(CMDLINE)},
    virtio_console: true,
    // The emulator answers DHCP itself; the relay URL only matters for
    // connections, and there is none while the snapshot is made.
    net_device: { type: 'virtio', relay_url: 'wisp://127.0.0.1:9/' },
    preserve_mac_from_state_image: true,
    autostart: true,
    disable_speaker: true,
  })
  emulator.add_listener('virtio-console0-output-bytes', (b) => { screen += decoder.decode(b) })
  emulator.add_listener('virtio-console1-output-bytes', (b) => { agent += decoder.decode(b) })
  const started = performance.now()
  const timer = setInterval(async () => {
    if (performance.now() - started > 600000) { clearInterval(timer); reject(new Error('Boot timed out:\\n' + screen.slice(-2000))) }
    if (!agent.includes('ready') || !screen.includes('student@opcode')) return
    clearInterval(timer)
    // Clear the screen (Ctrl+L) so a restored machine starts tidy.
    emulator.bus.send('virtio-console0-input-bytes', new TextEncoder().encode('\\x0c'))
    await new Promise((r) => setTimeout(r, 1500))
    const state = await emulator.save_state()
    const gz = await new Response(new Blob([state]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    // In pieces: Playwright relays each request body as one string, and a
    // big machine's snapshot is too long for that.
    const piece = 8 * 1024 * 1024
    for (let offset = 0; offset < gz.byteLength; offset += piece) {
      await fetch('/upload', { method: 'PUT', body: gz.slice(offset, offset + piece) })
    }
    resolve({ bootMs: Math.round(performance.now() - started), rawBytes: state.byteLength })
  }, 200)
})
</script>`

const pieces = []
const server = http.createServer((req, res) => {
  if (req.method === 'PUT' && req.url === '/upload') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      pieces.push(Buffer.concat(chunks))
      res.end('ok')
    })
    return
  }
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(page)
  }
  const file = files[req.url]
  if (!file) {
    res.writeHead(404)
    return res.end()
  }
  const type = req.url.endsWith('.mjs') ? 'text/javascript' : req.url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
  res.writeHead(200, { 'content-type': type })
  fs.createReadStream(file).pipe(res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] })
try {
  const tab = await browser.newPage()
  tab.on('pageerror', (error) => console.error('[page]', error.message))
  await tab.goto(url)
  console.log('Booting Opcode Linux…')
  const result = await tab.evaluate(() => window.result)
  // Recompress harder than the browser's default level.
  const best = zlib.gzipSync(zlib.gunzipSync(Buffer.concat(pieces)), { level: 9 })
  fs.mkdirSync(outDir, { recursive: true })
  for (const name of fs.readdirSync(outDir)) {
    if (name.startsWith(variant.snapshot)) fs.rmSync(path.join(outDir, name))
  }
  // One file, or parts to download and join: name.1, name.2, …
  const parts = []
  if (best.length <= PART_BYTES) {
    fs.writeFileSync(path.join(outDir, variant.snapshot), best)
    parts.push(variant.snapshot)
  } else {
    for (let offset = 0; offset < best.length; offset += PART_BYTES) {
      const name = `${variant.snapshot}.${parts.length + 1}`
      fs.writeFileSync(path.join(outDir, name), best.subarray(offset, offset + PART_BYTES))
      parts.push(name)
    }
  }

  const v86Version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/v86/package.json'), 'utf8')).version.split('+')[0]
  // `snapshot` identifies this file (the app caches downloads by it).
  const snapshot = createHash('sha256').update(best).digest('hex').slice(0, 16)
  const manifest = { v86: v86Version, memoryMB: MEMORY_MB, hardware: HARDWARE, alpine: '3.24.2', created: new Date().toISOString().slice(0, 10), snapshot, files: parts, bytes: best.length }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Booted in ${(result.bootMs / 1000).toFixed(1)}s; snapshot ${(best.length / 1e6).toFixed(1)} MB (raw ${(result.rawBytes / 1e6).toFixed(0)} MB)`)
} finally {
  await browser.close()
  server.close()
}
