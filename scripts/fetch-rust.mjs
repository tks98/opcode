// Downloads the Rust toolchain Opcode runs in the browser: rustc compiled to
// WebAssembly (with LLVM and lld built in, so it links by itself) and Rust's
// standard library for wasm32-wasip1. Both come from a pinned release of
// https://github.com/oligamiq/rust_wasm (MIT OR Apache-2.0). They are too big
// to keep in git, so `npm run dev` and `npm run build` fetch them once and
// verify their checksums, writing (gitignored):
//
//   public/toolchains/rust/rustc.wasm.gz    (~30 MB)
//   public/toolchains/rust/sysroot.tar.gz   (~27 MB)
//
// Usage: node scripts/fetch-rust.mjs [--force]

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync, gzipSync } from 'node:zlib'

const RELEASE = 'v3.0.0' // rustc 1.83.0
const MIRRORS = [`https://oligamiq.github.io/rust_wasm/${RELEASE}/`, `https://rustwasm0.pages.dev/${RELEASE}/`]
const FILES = [
  { source: 'rustc_opt.wasm.br', sha256: '05b5f6da92ca33981371ea07f300ce927a688da719d9ef113931a2993e06bdd2', output: 'rustc.wasm.gz' },
  { source: 'wasm32-wasip1.tar.br', sha256: '56b0f06f21fbd30947e1378c6d412c8981f394afafba20635eb7ab605505ce5c', output: 'sysroot.tar.gz' },
]

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'toolchains', 'rust')
const stampFile = join(out, 'release.json')
const stamp = JSON.stringify({ release: RELEASE, files: FILES.map((file) => file.sha256) })

function upToDate() {
  try {
    return readFileSync(stampFile, 'utf8') === stamp && FILES.every((file) => existsSync(join(out, file.output)))
  } catch {
    return false
  }
}

async function download(file) {
  const errors = []
  for (const mirror of MIRRORS) {
    try {
      const response = await fetch(mirror + file.source)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (sha256 !== file.sha256) throw new Error(`checksum mismatch (got ${sha256})`)
      return bytes
    } catch (error) {
      errors.push(`${mirror}${file.source}: ${error.message}`)
    }
  }
  throw new Error(`Could not download ${file.source}:\n  ${errors.join('\n  ')}`)
}

if (!process.argv.includes('--force') && upToDate()) process.exit(0)

mkdirSync(out, { recursive: true })
console.log(`Fetching the Rust toolchain (${RELEASE}, about 40 MB)…`)
try {
  await Promise.all(
    FILES.map(async (file) => {
      const bytes = brotliDecompressSync(await download(file))
      // Browsers can decompress gzip themselves (DecompressionStream), not brotli.
      const target = join(out, file.output)
      writeFileSync(`${target}.tmp`, gzipSync(bytes, { level: 9 }))
      renameSync(`${target}.tmp`, target)
      console.log(`  ${file.output}: ${(bytes.length / 1e6).toFixed(1)} MB unpacked`)
    }),
  )
  writeFileSync(stampFile, stamp)
} catch (error) {
  console.error(`${error.message}\nRust projects won't work in this build until the download succeeds (rerun: node scripts/fetch-rust.mjs).`)
  process.exit(1)
}
