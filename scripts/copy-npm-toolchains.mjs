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
//     R.wasm, its worker and the R library it loads files of on demand. Its
//     scripts are patched: R can't run JavaScript (see patchWebrWorkerSource
//     and below), and the worker decompresses the library's .data.gz files
//     only if they are still compressed (hosts, Vite's dev server among them,
//     may serve them with Content-Encoding: gzip, which the browser undoes).
//
// Usage: node scripts/copy-npm-toolchains.mjs [--force]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

// Directories copied (their files load on demand), with patches.

// webR lets R code run JavaScript (webr::eval_js, and wasm modules it loads
// with dyn.load). Its worker and the page that starts it are on the app's
// origin, so that would give any program in any project the user's other
// projects. These patches close every way we found; each one fails the build
// if webR changes and its pattern no longer matches, and a final check fails
// it if any eval is left over.
const NO_JS = 'eval_js is not available in Opcode'
const throwNoJs = `throw new Error(${JSON.stringify(NO_JS)})`

// Replace exactly `count` matches of `pattern` in `source`, or throw.
function replaceExactly(source, pattern, replacement, count, what) {
  const all = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)
  const found = source.match(all)?.length ?? 0
  if (found !== count) throw new Error(`webR changed (${what}: ${found} matches, expected ${count}): update the patches in scripts/copy-npm-toolchains.mjs`)
  return source.replace(all, replacement)
}

// Every eval left in a patched file, outside the allowed ones.
const EVAL = /(?<![\w.$#])eval\((?!\)\{)|\(0,eval\)|(?<![\w.$])Function\(/g
function assertNoEval(source, what, allowed = 0) {
  const found = source.match(EVAL)?.length ?? 0
  if (found !== allowed) throw new Error(`webR changed (${what}: ${found} evals, expected ${allowed}): update the patches in scripts/copy-npm-toolchains.mjs`)
}

/** webr-worker.js, the worker R runs in. */
export function patchWebrWorkerSource(source) {
  // Decompress the library's .data.gz files only if they are still
  // compressed (a host may serve them with Content-Encoding: gzip).
  let out = replaceExactly(source, /(\w)\.gzip&&\((\w)=(\w+)\(\2\)\.buffer\)/, (_, metadata, data, inflate) => `${metadata}.gzip&&new Uint8Array(${data})[0]===31&&new Uint8Array(${data})[1]===139&&(${data}=${inflate}(${data}).buffer)`, 2, 'gzip check')
  // webr::eval_js: both the worker's own eval and the one it asks the page
  // for ("eval-await") raise an R error instead.
  out = replaceExactly(out, /(evalJs:\((\w+),\w+=!1\)=>\{try\{let (\w+)=null;)if\(\w+\)\{let \w+=\w+\?\.syncRequest\(\{type:"eval-await",data:\w+\.UTF8ToString\(\2\)\}\);[^]*?else \3=\(0,eval\)\(\w+\.UTF8ToString\(\2\)\);/, (_, head) => `${head}${throwNoJs};`, 1, 'evalJs')
  // Once R has started (and loaded webR's own module, the only one with
  // embedded JavaScript), before any of the program's code runs, modules
  // loaded later may not bring any: see patchRSource.
  out = replaceExactly(out, /(resolveInit:\(\)=>\{[^]*?)(\w+\?\.resolve\(\),\w+=!0\},setPrompt:)/, (_, head, tail) => `${head}globalThis.Module.opcodeSealed=!0,${tail}`, 1, 'resolveInit')
  // Nothing in R needs IndexedDB or the Cache API, and the app keeps its
  // projects and downloads there: take them out of the worker (R's IDBFS
  // mounts and emscripten_idb_* then fail).
  out = replaceExactly(out, /^"use strict";/, '"use strict";for(const k of["indexedDB","caches"])try{Object.defineProperty(globalThis,k,{value:void 0,configurable:!1})}catch{};', 1, 'prologue')
  assertNoEval(out, 'webr-worker.js')
  return out
}

/** webr.js (also .mjs/.cjs: the same code), the page's side of webR. */
export function patchWebrMainSource(source) {
  // "eval-await" (webr::eval_js(await = TRUE)) gets an error back.
  let out = replaceExactly(source, /(case"eval-await":\{let (\w+)=\w+\.data,(\w+)=\{\};try\{)\3\.result=await\(0,eval\)\(\2\),typeof \3\.result=="function"&&\(\3\.result=String\(\3\.result\)\)/, (_, head) => `${head}${throwNoJs}`, 1, 'eval-await')
  // The worker can ask the page to start a Worker from a URL of its choice
  // and message it (webR's WorkerProxy). R has no use for it: ignore it.
  out = replaceExactly(out, /case"proxyWorker":\{let \w+=\w+;this\.#\w+\.new\(\w+\.data\.uuid,\w+\.data\.url,\w+\.data\.options\);break\}/, 'case"proxyWorker":break;', 1, 'proxyWorker')
  assertNoEval(out, 'webr.js')
  return out
}

/** R.js, Emscripten's runtime for R.wasm (it runs in the worker). */
export function patchRSource(source) {
  const sealed = `if(globalThis.Module?.opcodeSealed)throw new Error("wasm modules with JavaScript can't be loaded in Opcode");`
  // A module loaded with dyn.load brings its JavaScript as strings, which
  // this evals. webR's own module does at startup; later ones may not.
  let out = replaceExactly(source, /function addEmAsm\(addr,body\)\{/, (m) => `${m}${sealed}`, 1, 'addEmAsm')
  out = replaceExactly(out, /function addEmJs\(name,cSig,body\)\{/, (m) => `${m}${sealed}`, 1, 'addEmJs')
  // Functions that run a string as script. webR's own eval_js calls
  // emscripten_run_script_int; a loaded module could import any of them.
  // They raise an R error instead.
  const rError = `globalThis.Module._Rf_error(globalThis.Module.allocateUTF8OnStack(${JSON.stringify(NO_JS)}))`
  out = replaceExactly(out, /var _emscripten_run_script=ptr=>\{eval\(UTF8ToString\(ptr\)\)\};/, `var _emscripten_run_script=ptr=>{${rError}};`, 1, 'emscripten_run_script')
  out = replaceExactly(out, /var _emscripten_run_script_int=ptr=>eval\(UTF8ToString\(ptr\)\)\|0;/, `var _emscripten_run_script_int=ptr=>{${rError};return 0};`, 1, 'emscripten_run_script_int')
  out = replaceExactly(out, /var _emscripten_run_script_string=ptr=>\{var s=eval\(UTF8ToString\(ptr\)\);/, `var _emscripten_run_script_string=ptr=>{${rError};var s;`, 1, 'emscripten_run_script_string')
  // And ones that run a script later, load one or start a worker from a URL.
  out = replaceExactly(out, /var _emscripten_async_run_script=\(script,millis\)=>\{/, (m) => `${m}${throwNoJs};`, 1, 'emscripten_async_run_script')
  out = replaceExactly(out, /var _emscripten_async_load_script=async\(url,onload,onerror\)=>\{/, (m) => `${m}${throwNoJs};`, 1, 'emscripten_async_load_script')
  out = replaceExactly(out, /var _emscripten_create_worker=url=>\{/, (m) => `${m}${throwNoJs};`, 1, 'emscripten_create_worker')
  // What's left: the two evals above, which refuse once R has started, and
  // the unreachable one in emscripten_async_load_script.
  assertNoEval(out, 'R.js', 3)
  return out
}

export function patchWebr(dir) {
  const patches = { 'webr-worker.js': patchWebrWorkerSource, 'webr.js': patchWebrMainSource, 'webr.mjs': patchWebrMainSource, 'webr.cjs': patchWebrMainSource, 'R.js': patchRSource }
  for (const [name, patch] of Object.entries(patches)) {
    const file = join(dir, name)
    if (!existsSync(file)) {
      if (['webr-worker.js', 'webr.js', 'R.js'].includes(name)) throw new Error(`webR changed (no ${name}): update the patches in scripts/copy-npm-toolchains.mjs`)
      continue
    }
    writeFileSync(file, patch(readFileSync(file, 'utf8')))
  }
}

/** webR as the app gets it, for tests: its scripts copied and patched, the rest linked. */
export function patchedWebrForTests(target) {
  const source = join(packageDir('webr'), 'dist')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    if (/\.(js|mjs|cjs)$/.test(name)) cpSync(join(source, name), join(target, name))
    else symlinkSync(join(source, name), join(target, name))
  }
  patchWebr(target)
  return target
}

// Bump when the patches change, so existing copies are redone.
const PATCH_VERSION = 'patched 2'
const TREES = [{ output: 'webr', package: 'webr', dir: 'dist', skip: /\.map$|^(tests|repl)$|^webr\.(mjs|cjs)$|esbuild\.d\.ts$/, patch: patchWebr }]

function main() {
  for (const tree of TREES) {
    const target = join(out, tree.output)
    const stampFile = `${target}.version`
    const stamp = versionOf(tree.package)
    if (!force && existsSync(target) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === `${stamp} ${PATCH_VERSION}`) continue
    rmSync(target, { recursive: true, force: true })
    cpSync(join(packageDir(tree.package), tree.dir), target, { recursive: true, filter: (path) => !tree.skip.test(path.split('/').pop()) })
    tree.patch?.(target)
    writeFileSync(stampFile, `${stamp} ${PATCH_VERSION}`)
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
}

// Tests import the patches; only running the script copies.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
