// Compresses a production build ahead of time for scripts/server.mjs: for
// each file that compresses well, writes <out>/<path>.br and <out>/<path>.gz,
// which the server sends to browsers that accept them. Compressing Clang's
// 75 MB llvm.core.wasm takes seconds, too long to do for every request; it
// downloads as 17 MB.
//
// The copies live in their own folder, so none can be mistaken for a file of
// the build (which has its own .gz files: toolchains the app unpacks itself).
//
//   node scripts/precompress.mjs [dist] [dist-compressed]

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

const brotli = promisify(zlib.brotliCompress)
const gzip = promisify(zlib.gzip)

// Already compressed: archives, images, fonts.
const SKIP = new Set(['.gz', '.br', '.zst', '.xz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2', '.ico', '.mp3', '.mp4'])
const MIN_BYTES = 1024
const MIN_SAVING = 0.1 // keep a copy only if it is at least 10% smaller

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}

/** Compress the files under `root` into `out`; resolves to { files, bytes, compressed } (brotli). */
export async function precompress(root, out) {
  rmSync(out, { recursive: true, force: true })
  const queue = [...files(root)].filter((path) => !SKIP.has(extname(path).toLowerCase()))
  const totals = { files: 0, bytes: 0, compressed: 0 }
  async function work() {
    for (let path = queue.shift(); path; path = queue.shift()) {
      const data = readFileSync(path)
      // Gzip streams with another name (Linux machine snapshots).
      if (data.length < MIN_BYTES || (data[0] === 0x1f && data[1] === 0x8b)) continue
      const target = join(out, relative(root, path))
      const quality = data.length < 1e6 ? 11 : 9 // 11 is several times slower
      const [br, gz] = await Promise.all([
        brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
        gzip(data, { level: 9 }),
      ])
      if (br.length > data.length * (1 - MIN_SAVING)) continue
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(`${target}.br`, br)
      if (gz.length <= data.length * (1 - MIN_SAVING)) writeFileSync(`${target}.gz`, gz)
      totals.files++
      totals.bytes += data.length
      totals.compressed += br.length
    }
  }
  await Promise.all(Array.from({ length: Math.max(2, availableParallelism()) }, work))
  return totals
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root = 'dist', out = 'dist-compressed'] = process.argv.slice(2)
  const started = Date.now()
  const { files: count, bytes, compressed } = await precompress(resolve(root), resolve(out))
  console.log(`Compressed ${count} files from ${(bytes / 1e6).toFixed(1)} MB to ${(compressed / 1e6).toFixed(1)} MB (brotli) in ${((Date.now() - started) / 1000).toFixed(0)} s: ${out}/`)
}
