// Copies toolchains that come from npm packages (pinned in package.json, so
// npm checks their integrity) into public/toolchains/, gzipped, for the app
// to download. `npm run dev` and `npm run build` run this; the outputs are
// gitignored.
//
//   public/toolchains/ruby.wasm.gz   Ruby 3.2 for WASI (VMware Wasm Labs'
//     build, with the standard library inside), from @antonz/ruby-wasi
//   public/toolchains/typescript/typescript.js.gz   the TypeScript compiler
//   public/toolchains/typescript/types.json.gz   the type definitions tsc
//     compiles against: TypeScript's lib files, @types/node and undici-types
//     (which it uses), as { path: text } at the paths runtime/tscRunner.js
//     gives them
//   public/toolchains/webr/   webR (R compiled to WebAssembly) as published:
//     R.wasm, its worker and the R library it loads files of on demand. One
//     change: its worker decompresses the library's .data.gz files only if
//     they are still compressed (hosts, Vite's dev server among them, may
//     serve them with Content-Encoding: gzip, which the browser undoes).
//
// Usage: node scripts/copy-npm-toolchains.mjs [--force]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'toolchains')
const force = process.argv.includes('--force')
const packageDir = (name) => join(root, 'node_modules', name)
const versionOf = (name) => `${name}@${JSON.parse(readFileSync(join(packageDir(name), 'package.json'), 'utf8')).version}`

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

// Type definitions, keyed by the path the compiler sees them at.
function typesBundle() {
  const files = {}
  const lib = join(packageDir('typescript'), 'lib')
  for (const name of readdirSync(lib)) if (/^lib\..*\.d\.ts$/.test(name)) files[`/opcode/typescript/lib/${name}`] = readFileSync(join(lib, name), 'utf8')
  for (const name of ['@types/node', 'undici-types']) {
    for (const path of walk(packageDir(name))) {
      if (path.endsWith('.d.ts') || path.endsWith('/package.json')) files[`/node_modules/${name}/${relative(packageDir(name), path)}`] = readFileSync(path, 'utf8')
    }
  }
  return Buffer.from(JSON.stringify(files))
}

const COPIES = [
  { output: 'ruby.wasm.gz', packages: ['@antonz/ruby-wasi'], bytes: () => readFileSync(join(packageDir('@antonz/ruby-wasi'), 'dist/ruby.wasm')) },
  { output: 'typescript/typescript.js.gz', packages: ['typescript'], bytes: () => readFileSync(join(packageDir('typescript'), 'lib/typescript.js')) },
  { output: 'typescript/types.json.gz', packages: ['typescript', '@types/node', 'undici-types'], bytes: typesBundle },
]

// Directories copied (their files load on demand), with small patches.
const GZIP_CHECK = /(\w)\.gzip&&\((\w)=(\w+)\(\2\)\.buffer\)/g
function patchWebrWorker(dir) {
  const file = join(dir, 'webr-worker.js')
  const source = readFileSync(file, 'utf8')
  const patched = source.replace(GZIP_CHECK, (_, metadata, data, inflate) => `${metadata}.gzip&&new Uint8Array(${data})[0]===31&&new Uint8Array(${data})[1]===139&&(${data}=${inflate}(${data}).buffer)`)
  if (patched === source) throw new Error('webr-worker.js changed: update patchWebrWorker()')
  writeFileSync(file, patched)
}
const TREES = [{ output: 'webr', package: 'webr', dir: 'dist', skip: /\.map$|^(tests|repl)$|^webr\.(mjs|cjs)$|esbuild\.d\.ts$/, patch: patchWebrWorker }]

for (const tree of TREES) {
  const target = join(out, tree.output)
  const stampFile = `${target}.version`
  const stamp = versionOf(tree.package)
  if (!force && existsSync(target) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === `${stamp} patched`) continue
  rmSync(target, { recursive: true, force: true })
  cpSync(join(packageDir(tree.package), tree.dir), target, { recursive: true, filter: (path) => !tree.skip.test(path.split('/').pop()) })
  tree.patch?.(target)
  writeFileSync(stampFile, `${stamp} patched`)
  console.log(`  ${tree.output}/: from ${stamp}`)
}

for (const copy of COPIES) {
  const target = join(out, copy.output)
  const stampFile = `${target}.version`
  const stamp = copy.packages.map(versionOf).join(' ')
  if (!force && existsSync(target) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) continue
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, gzipSync(copy.bytes(), { level: 9 }))
  writeFileSync(stampFile, stamp)
  console.log(`  ${copy.output}: from ${stamp} (${(statSync(target).size / 1e6).toFixed(1)} MB)`)
}
