// Builds public/toolchains/opcode-wait.wasm with the bundled YoWASP Clang.
//   node toolchains/opcode-wait/build.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { commands } from '@yowasp/clang'

const here = dirname(new URL(import.meta.url).pathname)
const files = { 'opcode-wait.c': readFileSync(join(here, 'opcode-wait.c'), 'utf8') }
const output = await commands.clang(['-O2', '-Wall', '-o', 'opcode-wait.wasm', 'opcode-wait.c', '-Wl,--strip-all'], files, {
  stdout: (bytes) => bytes && process.stdout.write(bytes),
  stderr: (bytes) => bytes && process.stderr.write(bytes),
})
const out = join(here, '../../public/toolchains/opcode-wait.wasm')
writeFileSync(out, output['opcode-wait.wasm'])
console.log(`${out}: ${output['opcode-wait.wasm'].length} bytes`)
