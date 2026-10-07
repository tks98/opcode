import { describe, expect, it } from 'vitest'
import { listImports, patchModuleImports } from '../src/lib/runtime/wasmImports.js'

const text = (s) => [s.length, ...new TextEncoder().encode(s)]
const section = (id, body) => [id, body.length, ...body]

// A module importing one of each kind, with WasmGC reference types:
// a function, a table of (ref null 0), a shared memory with a maximum, an
// immutable (ref null extern) global, a mutable i32 global and a tag.
const IMPORTS = [
  ...text('env'), ...text('f'), 0x00, 0,
  ...text('env'), ...text('t'), 0x01, 0x63, 0x00, 0x01, 1, 10,
  ...text('env'), ...text('m'), 0x02, 0x03, 1, 0x80, 0x80, 0x04,
  ...text('strings'), ...text('hello'), 0x03, 0x63, 0x6f, 0x00,
  ...text('env'), ...text('g'), 0x03, 0x7f, 0x01,
  ...text('env'), ...text('e'), 0x04, 0x00, 0,
]
const MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, [1, 0x60, 0, 0]), // type section: () -> ()
  ...section(2, [6, ...IMPORTS]),
])

describe('listImports', () => {
  it('lists every import with its kind, past GC reference types', () => {
    expect(listImports(MODULE)).toEqual([
      { module: 'env', name: 'f', kind: 'function' },
      { module: 'env', name: 't', kind: 'table' },
      { module: 'env', name: 'm', kind: 'memory' },
      { module: 'strings', name: 'hello', kind: 'global' },
      { module: 'env', name: 'g', kind: 'global' },
      { module: 'env', name: 'e', kind: 'tag' },
    ])
  })

  it('accepts an ArrayBuffer and a module without imports', () => {
    expect(listImports(MODULE.slice().buffer)).toHaveLength(6)
    expect(listImports(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))).toEqual([])
  })
})

describe('patchModuleImports', () => {
  it('falls back to the bytes when the engine cannot describe a module', async () => {
    const fake = {
      compile: async () => ({}),
      Module: {
        imports() {
          throw new TypeError('WebAssembly.Module.imports unable to produce import descriptors for the given module')
        },
      },
    }
    patchModuleImports(fake)
    const module = await fake.compile(MODULE)
    expect(fake.Module.imports(module).map((i) => i.name)).toEqual(['f', 't', 'm', 'hello', 'g', 'e'])
    expect(() => fake.Module.imports({})).toThrow(TypeError)
  })
})
