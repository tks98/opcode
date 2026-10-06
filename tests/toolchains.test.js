import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { gunzipIfNeeded, untar } from '../src/lib/runtime/toolchains.js'

describe('gunzipIfNeeded', () => {
  it('decompresses gzip data', async () => {
    const original = new TextEncoder().encode('\0asm hello wasm')
    expect(await gunzipIfNeeded(new Uint8Array(gzipSync(original)))).toEqual(original)
  })

  it('passes through data a server already decompressed', async () => {
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
    expect(await gunzipIfNeeded(wasm)).toBe(wasm)
  })
})

// A ustar header and the file's contents (padded to 512-byte blocks).
function tarEntry(name, text, { type = '0', prefix = '' } = {}) {
  const header = new Uint8Array(512)
  const put = (offset, value) => header.set(new TextEncoder().encode(value), offset)
  const data = new TextEncoder().encode(text)
  put(0, name)
  put(100, '0000644\0')
  put(124, `${data.length.toString(8).padStart(11, '0')}\0`)
  put(148, '        ')
  header[156] = type.charCodeAt(0)
  put(257, 'ustar\0')
  put(345, prefix)
  let sum = 0
  for (const byte of header) sum += byte
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `)
  const body = new Uint8Array(Math.ceil(data.length / 512) * 512)
  body.set(data)
  return [header, body]
}

describe('untar', () => {
  it('reads regular files, skipping directories, with long names', () => {
    const parts = [
      ...tarEntry('self-contained/', '', { type: '5' }),
      ...tarEntry('./libstd.rlib', 'std bytes'),
      ...tarEntry('crt1-command.o', 'crt', { prefix: 'self-contained' }),
      ...tarEntry('././@LongLink', 'a/very/long/name.rlib\0', { type: 'L' }),
      ...tarEntry('truncated', 'long'),
      new Uint8Array(1024),
    ]
    const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    const files = untar(bytes).map((file) => [file.path, new TextDecoder().decode(file.bytes)])
    expect(files).toEqual([
      ['libstd.rlib', 'std bytes'],
      ['self-contained/crt1-command.o', 'crt'],
      ['a/very/long/name.rlib', 'long'],
    ])
  })
})
