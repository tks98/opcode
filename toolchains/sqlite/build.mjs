// Builds public/toolchains/sqlite3.wasm.gz, the `sqlite3` command, from the
// official SQLite amalgamation with the bundled YoWASP Clang (WASI).
//   node toolchains/sqlite/build.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import JSZip from 'jszip'
import { commands } from '@yowasp/clang'

const VERSION = '3.53.4'
const URL_ = 'https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip'
// SHA3-256, as published on https://www.sqlite.org/download.html
const SHA3 = '628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e'

const here = dirname(new URL(import.meta.url).pathname)
const response = await fetch(URL_)
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
const zipBytes = Buffer.from(await response.arrayBuffer())
const digest = createHash('sha3-256').update(zipBytes).digest('hex')
if (digest !== SHA3) throw new Error(`Checksum mismatch: ${digest}`)

const zip = await JSZip.loadAsync(zipBytes)
const files = {}
for (const name of ['sqlite3.c', 'sqlite3.h', 'sqlite3ext.h', 'shell.c']) {
  const entry = Object.values(zip.files).find((file) => file.name.endsWith(`/${name}`))
  files[name] = await entry.async('string')
}

const flags = [
  '-O2',
  '-DSQLITE_THREADSAFE=0',
  '-DSQLITE_OMIT_LOAD_EXTENSION',
  '-DSQLITE_OMIT_SHARED_CACHE',
  '-DSQLITE_OMIT_DEPRECATED',
  '-DSQLITE_NOHAVE_SYSTEM', // no .system / .shell / .edit in the shell
  '-DSQLITE_DEFAULT_MEMSTATUS=0',
  '-DSQLITE_DQS=0', // "text" is an identifier, as in other databases
  '-DSQLITE_ENABLE_MATH_FUNCTIONS',
  '-DSQLITE_ENABLE_FTS5',
  '-DSQLITE_ENABLE_DBSTAT_VTAB',
  '-D_WASI_EMULATED_MMAN',
  '-D_WASI_EMULATED_SIGNAL',
  '-D_WASI_EMULATED_GETPID',
  '-D_WASI_EMULATED_PROCESS_CLOCKS',
  '-o', 'sqlite3.wasm',
  'shell.c', 'sqlite3.c',
  '-lwasi-emulated-mman', '-lwasi-emulated-signal', '-lwasi-emulated-getpid', '-lwasi-emulated-process-clocks',
  '-Wl,--strip-all',
]
console.log(`Compiling SQLite ${VERSION}…`)
const output = await commands.clang(flags, files, {
  stdout: (bytes) => bytes && process.stdout.write(bytes),
  stderr: (bytes) => bytes && process.stderr.write(bytes),
})
const wasm = output['sqlite3.wasm']
const out = join(here, '../../public/toolchains/sqlite3.wasm.gz')
writeFileSync(out, gzipSync(wasm, { level: 9 }))
console.log(`${out}: ${wasm.length} bytes (gzip ${gzipSync(wasm, { level: 9 }).length})`)
