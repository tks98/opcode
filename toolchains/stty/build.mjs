// Builds public/toolchains/stty.wasm with the bundled YoWASP Clang.
//   node toolchains/stty/build.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { commands } from '@yowasp/clang'

const here = dirname(new URL(import.meta.url).pathname)
const files = { 'stty.c': readFileSync(join(here, 'stty.c'), 'utf8') }
const output = await commands.clang(['-O2', '-Wall', '-o', 'stty.wasm', 'stty.c', '-Wl,--strip-all'], files, {
  stdout: (bytes) => bytes && process.stdout.write(bytes),
  stderr: (bytes) => bytes && process.stderr.write(bytes),
})
const out = join(here, '../../public/toolchains/stty.wasm')
writeFileSync(out, output['stty.wasm'])
console.log(`${out}: ${output['stty.wasm'].length} bytes`)
