// Builds public/toolchains/lua.wasm.gz, the `lua` command, from the official
// Lua sources with the bundled YoWASP Clang (WASI).
//   node toolchains/lua/build.mjs
//
// Lua reports errors with setjmp/longjmp, which WebAssembly provides through
// exception handling (-mllvm -wasm-enable-sjlj, libsetjmp). WASI has no
// system() or popen(), so os.execute() reports failure and io.popen() says
// it isn't supported, as in Lua's portable (C89) build; temporary files are
// missing too. Two patches: lua.c starts in the shell's directory ($PWD),
// and io.read() flushes output first, so prompts show.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { commands } from '@yowasp/clang'

const VERSION = '5.5.1'
const URL_ = `https://www.lua.org/ftp/lua-${VERSION}.tar.gz`
// As published on https://www.lua.org/ftp/
const SHA256 = '1c4b4068d67061f2a2231ad2b5422e77acea1487ea9890f6320af614f4373dce'

const here = dirname(new URL(import.meta.url).pathname)
const response = await fetch(URL_)
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
const archive = Buffer.from(await response.arrayBuffer())
const digest = createHash('sha256').update(archive).digest('hex')
if (digest !== SHA256) throw new Error(`Checksum mismatch: ${digest}`)

// The C files of src/ (a minimal ustar reader).
const files = {}
const tar = gunzipSync(archive)
for (let pos = 0; pos + 512 <= tar.length; ) {
  const header = tar.subarray(pos, pos + 512)
  const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '')
  if (!name) break
  const prefix = header.subarray(345, 500).toString().replace(/\0.*$/s, '')
  const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0', 8)
  const path = prefix ? `${prefix}/${name}` : name
  const match = /\/src\/([^/]+\.[ch])$/.exec(path)
  if (match && header[156] !== 53) files[match[1]] = tar.subarray(pos + 512, pos + 512 + size).toString()
  pos += 512 + Math.ceil(size / 512) * 512
}
// WASI's C library declares tmpfile() but has none.
files['wasi-tmpfile.c'] = '#include <errno.h>\n#include <stdio.h>\nFILE *tmpfile(void) { errno = ENOTSUP; return NULL; }\n'
// WASIX starts programs in /, with the shell's directory in $PWD.
const MAIN = 'int main (int argc, char **argv) {'
if (!files['lua.c'].includes(MAIN)) throw new Error('lua.c changed: update the $PWD patch')
files['lua.c'] = `#include <unistd.h>\n${files['lua.c'].replace(MAIN, `${MAIN}\n  if (getenv("PWD") != NULL) chdir(getenv("PWD"));`)}`
// Show a prompt written with io.write before reading the answer (C libraries
// do this for terminals; WASI's doesn't know it has one).
const READ = 'static int g_read (lua_State *L, FILE *f, int first) {'
if (!files['liolib.c'].includes(READ)) throw new Error('liolib.c changed: update the flush patch')
files['liolib.c'] = files['liolib.c'].replace(READ, `${READ}\n  if (f == stdin) fflush(stdout);`)
// The interpreter: everything but the separate compiler (luac).
const sources = Object.keys(files).filter((name) => name.endsWith('.c') && name !== 'luac.c').sort()

const flags = [
  '-O2',
  '-std=gnu99',
  '-DLUA_COMPAT_5_3',
  "-Dl_system(cmd)=((cmd) == NULL ? 0 : -1)",
  // No temporary file names or files on WASI: os.tmpname() and io.tmpfile() fail.
  '-DLUA_TMPNAMBUFSIZE=32',
  '-Dlua_tmpnam(b,e)=((e) = 1)',
  '-Wno-deprecated-declarations',
  '-D_WASI_EMULATED_SIGNAL',
  '-D_WASI_EMULATED_PROCESS_CLOCKS',
  '-mllvm', '-wasm-enable-sjlj',
  '-o', 'lua.wasm',
  ...sources,
  '-lsetjmp', '-lwasi-emulated-signal', '-lwasi-emulated-process-clocks', '-lm',
  '-Wl,--strip-all',
]
console.log(`Compiling Lua ${VERSION}…`)
const output = await commands.clang(flags, files, {
  stdout: (bytes) => bytes && process.stdout.write(bytes),
  stderr: (bytes) => bytes && process.stderr.write(bytes),
})
const wasm = output['lua.wasm']
if (!wasm) throw new Error('clang produced no lua.wasm')
const out = join(here, '../../public/toolchains/lua.wasm.gz')
const gz = gzipSync(wasm, { level: 9 })
writeFileSync(out, gz)
console.log(`${out}: ${wasm.length} bytes (gzip ${gz.length})`)
