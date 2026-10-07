// What WebAssembly.Module.imports() returns, read from a module's bytes.
//
// Safari can't describe the imports of modules that use WebAssembly GC types
// ("WebAssembly.Module.imports unable to produce import descriptors for the
// given module"), and TeaVM's loader (javac) asks for them. The import
// section is simple enough to read directly.

const KINDS = ['function', 'table', 'memory', 'global', 'tag']

/** The imports of a WebAssembly binary: [{ module, name, kind }]. */
export function listImports(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source.buffer ?? source, source.byteOffset ?? 0, source.byteLength)
  let at = 8 // magic and version
  const byte = () => {
    if (at >= bytes.length) throw new Error('truncated WebAssembly module')
    return bytes[at++]
  }
  const leb = () => {
    let value = 0
    let shift = 0
    for (;;) {
      const b = byte()
      if (shift < 32) value |= (b & 0x7f) << shift
      shift += 7
      if (!(b & 0x80)) return value >>> 0
    }
  }
  const name = () => {
    const length = leb()
    const text = new TextDecoder().decode(bytes.subarray(at, at + length))
    at += length
    return text
  }
  // A value or reference type: one byte, or (ref [null] heaptype).
  const valueType = () => {
    const b = byte()
    if (b === 0x63 || b === 0x64) leb()
  }
  const limits = () => {
    const flags = byte()
    leb()
    if (flags & 1) leb()
  }

  while (at < bytes.length) {
    const id = byte()
    const size = leb()
    if (id !== 2) {
      at += size
      continue
    }
    const imports = []
    for (let count = leb(); count > 0; count--) {
      const module = name()
      const field = name()
      const kind = byte()
      if (kind === 0) leb()
      else if (kind === 1) (valueType(), limits())
      else if (kind === 2) limits()
      else if (kind === 3) (valueType(), byte())
      else if (kind === 4) (byte(), leb())
      else throw new Error(`unknown import kind ${kind}`)
      imports.push({ module, name: field, kind: KINDS[kind] })
    }
    return imports
  }
  return []
}

/**
 * Make WebAssembly.Module.imports() work for modules this engine can't
 * describe, by reading them from the bytes they were compiled from.
 */
export function patchModuleImports(webAssembly = WebAssembly) {
  const sources = new WeakMap()
  const compile = webAssembly.compile
  webAssembly.compile = async function (bytes, ...rest) {
    const module = await compile.call(this, bytes, ...rest)
    sources.set(module, bytes)
    return module
  }
  const imports = webAssembly.Module.imports
  webAssembly.Module.imports = function (module) {
    try {
      return imports.call(this, module)
    } catch (error) {
      const bytes = sources.get(module)
      if (!bytes) throw error
      return listImports(bytes)
    }
  }
}
