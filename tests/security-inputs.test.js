// Files and links from elsewhere: shared machines (?machine=), machine
// files, and zips. Each must be refused cleanly, without unpacking or
// downloading without limit.

import { gzipSync } from 'node:zlib'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { checkMachineState, checkMeta, decodeMachineFile, encodeMachineFile, machineFileLimit, machineName, sharedMachineName, sharedMachineUrl, stateLimit, unpackMachineState } from '../src/lib/linux/machineFile.js'
import { gunzipIfNeeded, measureGunzip, readBody, readZip, readZipEntry, zipContents } from '../src/lib/runtime/toolchains.js'

const MB = 1024 * 1024
const MAGIC = 'OPCODE-LINUX 1\n'

// A v86 snapshot as v86 writes one: magic, version, total length, info length.
function v86State(size) {
  const state = new Uint8Array(size)
  const view = new DataView(state.buffer)
  view.setUint32(0, 0x86768676, true)
  view.setUint32(4, 6, true)
  view.setUint32(8, size, true)
  view.setUint32(12, 2, true)
  state.set(new TextEncoder().encode('{}'), 16)
  return state
}

describe('machine file headers', () => {
  const good = { name: 'Lab 1', v86: '0.5.470', memoryMB: 256, hardware: 2, savedAt: 5, machine: 'linux', alpine: '3.24.2' }

  it('keeps the fields Opcode uses', () => {
    expect(checkMeta({ ...good, extra: 'ignored' })).toEqual(good)
  })

  it('calls anything that is not an object damaged, not a crash', async () => {
    for (const raw of [null, 1, 'text', [], true]) expect(() => checkMeta(raw)).toThrow(/damaged/)
    await expect(decodeMachineFile(new Blob([MAGIC, 'null\n', 'S']))).rejects.toThrow(/damaged/)
    await expect(decodeMachineFile(new Blob([MAGIC, '[]\n', 'S']))).rejects.toThrow(/damaged/)
  })

  it('requires the emulator version and memory, with their types', () => {
    expect(() => checkMeta({ memoryMB: 256 })).toThrow(/damaged/)
    expect(() => checkMeta({ v86: '0.5.470' })).toThrow(/damaged/)
    expect(() => checkMeta({ v86: 470, memoryMB: 256 })).toThrow(/damaged/)
    expect(() => checkMeta({ v86: '0.5.470', memoryMB: '256' })).toThrow(/damaged/)
    expect(() => checkMeta({ v86: '0.5.470', memoryMB: -1 })).toThrow(/damaged/)
  })

  it('drops optional fields of the wrong type', () => {
    const meta = checkMeta({ v86: '0.5.470', memoryMB: 256, name: {}, hardware: '2', savedAt: -1, machine: 'windows', alpine: 3 })
    expect(meta).toEqual({ v86: '0.5.470', memoryMB: 256 })
  })

  it('ignores __proto__ in the file', async () => {
    const { meta } = await decodeMachineFile(new Blob([MAGIC, '{"__proto__":{"polluted":1},"v86":"0.5.470","memoryMB":256}\n', 'S']))
    expect(meta).toEqual({ v86: '0.5.470', memoryMB: 256 })
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype)
    expect({}.polluted).toBeUndefined()
  })

  it('cleans and shortens names', () => {
    expect(machineName('  Lab\n1\x1b[31m red‮  ')).toBe('Lab 1 [31m red')
    expect(machineName('x'.repeat(500))).toHaveLength(100)
    expect(checkMeta({ ...good, name: '\x00\x01' }).name).toBeUndefined()
  })
})

describe('unpacking machine states', () => {
  it('caps gzip output and stops reading there', async () => {
    // The bomb from the review, smaller: 64 MB of zeros in about 64 kB.
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * MB), { level: 9 }))
    expect(bomb.length).toBeLessThan(100_000)
    await expect(gunzipIfNeeded(bomb, { maxBytes: 8 * MB })).rejects.toMatchObject({ code: 'TOO_BIG' })
    await expect(measureGunzip(new Blob([bomb]), { maxBytes: 8 * MB })).rejects.toMatchObject({ code: 'TOO_BIG' })
    expect((await gunzipIfNeeded(bomb, { maxBytes: 64 * MB })).length).toBe(64 * MB)
  })

  it('does not trust the size gzip states', async () => {
    const gz = new Uint8Array(gzipSync(Buffer.alloc(4 * MB, 7)))
    new DataView(gz.buffer).setUint32(gz.length - 4, 10, true) // says 10 bytes
    await expect(gunzipIfNeeded(gz)).rejects.toThrow() // the gzip checksum catches the lie
    // Says it is over the cap: refused before unpacking.
    await expect(gunzipIfNeeded(new Uint8Array(gzipSync(Buffer.alloc(4 * MB, 7))), { maxBytes: MB })).rejects.toMatchObject({ code: 'TOO_BIG' })
    const honest = new Uint8Array(gzipSync(Buffer.alloc(4 * MB, 7)))
    new DataView(honest.buffer).setUint32(honest.length - 4, 0, true)
    await expect(gunzipIfNeeded(honest, { maxBytes: MB })).rejects.toMatchObject({ code: 'TOO_BIG' })
  })

  it('accepts a v86 snapshot within the machine memory limit', async () => {
    const state = v86State(3 * MB)
    const gz = new Uint8Array(gzipSync(state))
    const unpacked = await unpackMachineState(gz, 256)
    expect(unpacked).toBeInstanceOf(ArrayBuffer)
    expect(unpacked.byteLength).toBe(state.length)
    // Already unpacked by the server (Content-Encoding: gzip).
    expect((await unpackMachineState(state, 256)).byteLength).toBe(state.length)
    await expect(checkMachineState(new Blob([gz]), 256)).resolves.toBeUndefined()
  })

  it('refuses a decompression bomb as damaged', async () => {
    // The review's bomb unpacked to 512 MB; the limit for a 256 MB machine is 320 MB.
    expect(stateLimit(256)).toBe(320 * MB)
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(stateLimit(1) + 1), { level: 9 }))
    await expect(unpackMachineState(bomb, 1)).rejects.toThrow(/damaged/)
    await expect(checkMachineState(new Blob([bomb]), 1)).rejects.toThrow(/damaged/)
  })

  it('refuses states that are not v86 snapshots, including zstd ones', async () => {
    const zstd = new Uint8Array(64)
    new DataView(zstd.buffer).setUint32(0, 0xfd2fb528, true)
    await expect(unpackMachineState(zstd, 256)).rejects.toThrow(/damaged/)
    await expect(unpackMachineState(new Uint8Array(gzipSync(zstd)), 256)).rejects.toThrow(/damaged/)
    await expect(checkMachineState(new Blob([zstd]), 256)).rejects.toThrow(/damaged/)
    await expect(checkMachineState(new Blob([gzipSync(zstd)]), 256)).rejects.toThrow(/damaged/)
    // A length in the header that doesn't match.
    const wrong = v86State(1024)
    new DataView(wrong.buffer).setUint32(8, 4096, true)
    await expect(unpackMachineState(new Uint8Array(gzipSync(wrong)), 256)).rejects.toThrow(/damaged/)
    // Not gzip at all, or broken gzip.
    await expect(checkMachineState(new Blob([new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3])]), 256)).rejects.toThrow(/damaged/)
  })

  it('round-trips a machine file and checks it', async () => {
    const gz = gzipSync(v86State(MB))
    const file = encodeMachineFile({ name: 'Lab', v86: '0.5.470', memoryMB: 256 }, new Blob([gz]))
    const { meta, state } = await decodeMachineFile(file)
    await expect(checkMachineState(state, meta.memoryMB)).resolves.toBeUndefined()
    expect(machineFileLimit(256)).toBeGreaterThan(stateLimit(256))
  })
})

describe('shared machine links', () => {
  const base = 'https://opcode.example/app/?machine=x'

  it('opens only web addresses', () => {
    expect(sharedMachineUrl('https://labs.example/lab-1.opcode-linux', base).host).toBe('labs.example')
    expect(sharedMachineUrl('http://labs.example/a', base).protocol).toBe('http:')
    for (const bad of ['javascript:alert(1)', 'data:text/plain,hi', 'blob:https://opcode.example/1', 'file:///etc/passwd', 'ftp://x/y', 'http://[bad']) {
      expect(sharedMachineUrl(bad, base)).toBeNull()
    }
  })

  it('keeps relative paths on this site', () => {
    const url = sharedMachineUrl('labs/lab-1.opcode-linux', base)
    expect(url.href).toBe('https://opcode.example/app/labs/lab-1.opcode-linux')
    expect(sharedMachineUrl('//evil.example/x', base).host).toBe('evil.example') // a host, so the prompt names it
  })

  it('names the project after the file', () => {
    expect(sharedMachineName('https://labs.example/files/Lab%201.opcode-linux')).toBe('Lab 1')
    expect(sharedMachineName('https://labs.example/%E0%A4%A.opcode-linux')).toBe('%E0%A4%A')
    expect(sharedMachineName('https://labs.example/')).toBe('Shared machine')
    expect(sharedMachineName('https://labs.example/%0a%1b.opcode-linux')).toBe('Shared machine')
  })
})

describe('capped downloads', () => {
  const streamOf = (chunks) =>
    new ReadableStream({
      pull(controller) {
        const next = chunks.shift()
        if (next) controller.enqueue(next)
        else controller.close()
      },
    })

  it('reads a body with progress', async () => {
    const progress = []
    const bytes = await readBody(new Response(streamOf([new Uint8Array(10), new Uint8Array(5)])), { maxBytes: 100, emit: (p) => progress.push(p.downloadedBytes) })
    expect(bytes.length).toBe(15)
    expect(progress).toEqual([10, 15])
  })

  it('stops once the body passes the cap, whatever the server says', async () => {
    let pulled = 0
    const endless = new ReadableStream({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(MB))
      },
    })
    await expect(readBody(new Response(endless, { headers: { 'content-length': '10' } }), { maxBytes: 4 * MB })).rejects.toThrow(/larger than/)
    expect(pulled).toBeLessThan(10)
  })

  it('refuses a stated size over the cap before reading', async () => {
    const response = new Response(streamOf([new Uint8Array(1)]), { headers: { 'content-length': String(10 * MB) } })
    await expect(readBody(response, { maxBytes: MB })).rejects.toThrow(/larger than/)
  })
})

// A zip whose `lying` entries claim to be 10 bytes (as in the review's zipbomb.cjs).
async function lyingZip(entries, lying = Object.keys(entries)) {
  const zip = new JSZip()
  for (const [name, bytes] of Object.entries(entries)) zip.file(name, bytes)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  const nameAt = (offset, lengthAt) => buffer.toString('utf8', offset, offset + buffer.readUInt16LE(lengthAt))
  for (let i = 0; i < buffer.length - 4; i++) {
    const signature = buffer.readUInt32LE(i)
    if (signature === 0x04034b50 && lying.includes(nameAt(i + 30, i + 26))) buffer.writeUInt32LE(10, i + 22)
    if (signature === 0x02014b50 && lying.includes(nameAt(i + 46, i + 28))) buffer.writeUInt32LE(10, i + 24)
  }
  return JSZip.loadAsync(buffer)
}

// Entries that stream the given sizes in 64 kB pieces, whatever they claim.
function fakeZip(sizes) {
  const files = {}
  for (const [name, size] of Object.entries(sizes)) {
    files[name] = {
      name,
      dir: false,
      _data: { uncompressedSize: 10 },
      internalStream() {
        const handlers = {}
        let sent = 0
        let paused = false
        const pump = () => {
          while (!paused && sent < size) {
            const chunk = new Uint8Array(Math.min(65536, size - sent))
            sent += chunk.length
            handlers.data(chunk)
          }
          if (!paused) setTimeout(() => handlers.end())
        }
        const stream = {
          on: (event, fn) => ((handlers[event] = fn), stream),
          pause: () => ((paused = true), stream),
          resume: () => (setTimeout(pump), stream),
        }
        return stream
      },
    }
  }
  return { files }
}

describe('zip import', () => {
  const limits = { maxFiles: 2000, maxFileBytes: 2 * MB, maxTotalBytes: 5 * MB }

  it('stops unpacking an entry bigger than it says at the per-file limit', async () => {
    const zip = await lyingZip({ 'big.txt': Buffer.alloc(40 * MB, 0x61), 'small.txt': Buffer.from('hello') }, ['big.txt'])
    expect(zip.files['big.txt']._data.uncompressedSize).toBe(10)
    const before = process.memoryUsage().arrayBuffers
    expect(await readZipEntry(zip.files['big.txt'], 2 * MB)).toBeNull()
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(30 * MB)
    const { files, tooBig } = await readZip(zip, limits)
    expect(tooBig).toBe(1)
    expect(files.map((f) => f.path)).toEqual(['small.txt'])
  })

  it('calls a zip damaged when an entry under the limit lies about its size', async () => {
    const zip = await lyingZip({ 'a.txt': Buffer.alloc(MB, 0x61) })
    await expect(readZip(zip, limits)).rejects.toThrow(/damaged/)
  })

  it('fails once the real total passes the limit', async () => {
    let read = 0
    const zip = fakeZip({ 'a.txt': 1.5 * MB, 'b.txt': 1.5 * MB, 'c.txt': 1.5 * MB, 'd.txt': 1.5 * MB, 'e.txt': 1.5 * MB })
    for (const entry of Object.values(zip.files)) {
      const open = entry.internalStream
      entry.internalStream = () => (read++, open())
    }
    await expect(readZip(zip, limits)).rejects.toThrow(/unpacks to more than 5 MB/)
    expect(read).toBe(4)
  })

  it('keeps the stated-size checks, folder stripping and ignored paths', async () => {
    const zip = new JSZip()
    zip.file('project/main.py', 'print(1)')
    zip.file('project/src/a.py', 'x = 1')
    zip.file('project/node_modules/x/index.js', 'skip')
    zip.file('__MACOSX/project/._main.py', 'skip')
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }))
    const { files, tooBig } = await readZip(loaded, limits)
    expect(tooBig).toBe(0)
    expect(files.map((f) => f.path).sort()).toEqual(['main.py', 'src/a.py'])
    expect(new TextDecoder().decode(files.find((f) => f.path === 'main.py').bytes)).toBe('print(1)')
    await expect(readZip(loaded, { ...limits, maxFiles: 1 })).rejects.toThrow(/it has 2 files/)
  })
})

describe('zip export', () => {
  it('leaves out names that could escape the folder the zip is unpacked into', () => {
    const files = ['main.py', '..\\..\\x.bat', '../up.txt', 'a/../../b', '.opcode/bashrc', 'dir\\file.txt', 'bad|name'].map((path) => ({ path, content: path }))
    const { files: out, folders, skipped } = zipContents({ files, folders: ['src', '../outside'] })
    expect(out.map((f) => f.path)).toEqual(['main.py', 'dir/file.txt'])
    expect(folders).toEqual(['src'])
    expect(skipped).toBe(6)
  })
})
