import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createR } from '../src/lib/runtime/rlang.js'
import { patchRSource, patchWebrMainSource, patchWebrWorkerSource, patchedWebrForTests } from '../scripts/copy-npm-toolchains.mjs'

// R code must not be able to run JavaScript: webR's worker and the page that
// starts it are on the app's origin (see scripts/copy-npm-toolchains.mjs).

const NO_JS = 'eval_js is not available in Opcode'
const original = fileURLToPath(new URL('../node_modules/webr/dist/', import.meta.url))
const read = (name) => readFileSync(`${original}${name}`, 'utf8')

// Minimal Emscripten side modules (what dyn.load loads), written by hand.
const leb = (n) => {
  const out = []
  do {
    let byte = n & 127
    n >>>= 7
    if (n) byte |= 128
    out.push(byte)
  } while (n)
  return out
}
const str = (text) => {
  const bytes = [...new TextEncoder().encode(text)]
  return [...leb(bytes.length), ...bytes]
}
const vec = (items) => [...leb(items.length), ...items.flat()]
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes]
const wasm = (sections) => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()])
const dylink = (memorySize) => section(0, [...str('dylink.0'), 1, ...leb(leb(memorySize).length + 3), ...leb(memorySize), 0, 0, 0])
const data = (bytes) => section(11, vec([[0, 0x23, 0, 0x0b, ...leb(bytes.length), ...bytes]]))
const memoryImports = [[...str('env'), ...str('memory'), 2, 0, 0], [...str('env'), ...str('__memory_base'), 3, 0x7f, 0]]
const cString = (text) => [...new TextEncoder().encode(text), 0]

// Its constructor calls the imported JavaScript function `name` with `script`.
function callingImport(name, script) {
  const bytes = cString(script)
  return wasm([
    dylink(bytes.length),
    section(1, vec([[0x60, 0, 0], [0x60, 1, 0x7f, 0]])),
    section(2, vec([...memoryImports, [...str('env'), ...str(name), 0, 1]])),
    section(3, vec([[0]])),
    section(7, vec([[...str('__wasm_call_ctors'), 0, 1]])),
    section(10, vec([[...leb(6), 0, 0x23, 0, 0x10, 0, 0x0b]])),
    data(bytes),
  ])
}

// It carries `body` as EM_ASM JavaScript, which the loader evals.
function withEmAsm(body) {
  const bytes = cString(body)
  const i32 = (n) => [0x7f, 0, 0x41, ...leb(n), 0x0b]
  return wasm([
    dylink(bytes.length),
    section(2, vec(memoryImports)),
    section(6, vec([i32(0), i32(bytes.length)])),
    section(7, vec([[...str('__start_em_asm'), 3, 1], [...str('__stop_em_asm'), 3, 2]])),
    data(bytes),
  ])
}

// Each writes a marker file in R's file system if its JavaScript runs.
const MODULES = {
  run: callingImport('emscripten_run_script', 'globalThis.Module.FS.writeFile("/tmp/ran-run", "1")'),
  int: callingImport('emscripten_run_script_int', 'globalThis.Module.FS.writeFile("/tmp/ran-int", "1")'),
  string: callingImport('emscripten_run_script_string', 'globalThis.Module.FS.writeFile("/tmp/ran-string", "1")'),
  asm: withEmAsm('}; globalThis.Module.FS.writeFile("/tmp/ran-asm", "1"); {'),
}

async function loadModules(webR) {
  const ran = {}
  for (const [name, bytes] of Object.entries(MODULES)) {
    await webR.FS.writeFile(`/tmp/${name}.so`, bytes)
    await webR.evalRVoid(`try(dyn.load("/tmp/${name}.so"), silent = TRUE)`).catch(() => {})
    ran[name] = await webR.evalRBoolean(`file.exists("/tmp/ran-${name}")`)
  }
  return ran
}

describe('webR as Opcode ships it', () => {
  let dir
  let WebR
  let webR
  beforeAll(async () => {
    dir = patchedWebrForTests(fileURLToPath(new URL('../node_modules/.cache/webr-security-test/', import.meta.url)))
    ;({ WebR } = await import(pathToFileURL(`${dir}webr.mjs`).href))
    webR = new WebR({ baseUrl: dir, interactive: false })
    await webR.init()
  }, 60_000)
  afterAll(() => {
    webR?.close()
    delete globalThis.opcodeMarker
  })

  it('raises an R error for webr::eval_js, in the worker or on the page', async () => {
    const message = (code) => webR.evalRString(`tryCatch({ ${code}; "ran" }, error = function(e) conditionMessage(e))`)
    expect(await message('webr::eval_js("1")')).toBe(NO_JS)
    expect(await message('webr::eval_js("globalThis.opcodeMarker = 1", await = TRUE)')).toBe(NO_JS)
    expect(await message('.Call(webr:::ffi_eval_js, "globalThis.opcodeMarker = 1", TRUE)')).toBe(NO_JS)
    expect(globalThis.opcodeMarker).toBeUndefined()
    expect(await webR.evalRString('as.character(6 * 7)')).toBe('42')
  }, 60_000)

  it("doesn't run JavaScript from modules R loads, and still loads R's own", async () => {
    expect(await loadModules(webR)).toEqual({ run: false, int: false, string: false, asm: false })
    expect(await webR.evalRString('{ library(grid); library(splines); library(tools); "loaded" }')).toBe('loaded')
  }, 60_000)

  it("through Opcode's R runner (what a guest's Rscript request reaches)", async () => {
    const R = createR(WebR, dir)
    const result = await R.runScript({ cwd: '/workspace', expression: 'cat(webr::eval_js("globalThis.opcodeMarker = 1; 2", await = TRUE), "\\n")' })
    expect(result.code).toBe(1)
    expect(result.output).toContain(NO_JS)
    expect(globalThis.opcodeMarker).toBeUndefined()
  }, 60_000)
})

describe('webR as published (why the patches exist)', () => {
  it('runs JavaScript from a module R loads, and the R runner refuses it', async () => {
    const { WebR } = await import('webr')
    const webR = new WebR({ baseUrl: original, interactive: false })
    await webR.init()
    try {
      expect(await loadModules(webR)).toMatchObject({ run: true, int: true, asm: true })
    } finally {
      webR.close()
    }
    await expect(createR(WebR, original).runScript({ cwd: '/workspace', expression: '1' })).rejects.toThrow(/lets R run JavaScript/)
  }, 60_000)
})

describe('webR patches', () => {
  it('fail when webR changed and a pattern no longer matches', () => {
    expect(() => patchWebrWorkerSource(read('webr-worker.js').replace('evalJs:', 'evalJS:'))).toThrow(/webR changed \(evalJs/)
    expect(() => patchWebrWorkerSource('"use strict";')).toThrow(/webR changed/)
    expect(() => patchWebrMainSource(read('webr.js').replaceAll('eval-await', 'evalAwait'))).toThrow(/webR changed \(eval-await/)
    expect(() => patchRSource(read('R.js').replace('var _emscripten_run_script=', 'var _emscripten_run_script2='))).toThrow(/webR changed \(emscripten_run_script/)
  })

  it('fail when an eval is left over', () => {
    expect(() => patchWebrMainSource(`${read('webr.js')};(0,eval)("1")`)).toThrow(/evals, expected 0/)
    expect(() => patchWebrWorkerSource(`${read('webr-worker.js')};eval("1")`)).toThrow(/evals, expected 0/)
    expect(() => patchRSource(`${read('R.js')};new Function("1")`)).toThrow(/evals, expected 3/)
  })

  it('leave no eval in the scripts the page and worker run', () => {
    for (const source of [patchWebrWorkerSource(read('webr-worker.js')), patchWebrMainSource(read('webr.js')), patchWebrMainSource(read('webr.mjs'))]) {
      expect(source).not.toMatch(/\(0,eval\)|(?<![\w.$#])eval\((?!\)\{)/)
    }
  })
})
