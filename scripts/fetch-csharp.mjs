// Builds the C# toolchain Opcode serves, from pinned NuGet packages (all
// MIT): .NET 8's runtime for WASI (Mono, which runs .NET code through an
// interpreter) and its class libraries, and Roslyn, the C# compiler. They are
// too big to keep in git, so `npm run dev` and `npm run build` fetch them
// once (cached in node_modules/.cache), check their checksums and write
// (gitignored):
//
//   public/toolchains/csharp/dotnet.wasm.gz   the runtime (a WASI program)
//   public/toolchains/csharp/managed.tar.gz   the assemblies it loads from
//     /managed: the class libraries, Roslyn, and Opcode's `dotnet run`
//     (toolchains/csharp/csharp.dll, built from toolchains/csharp/runner)
//
// One library comes from .NET's browser build instead of the WASI one:
// System.Security.Cryptography, whose WASI build throws on any use (Roslyn
// needs its hash algorithm names; the browser build has managed hashing).
//
// Usage: node scripts/fetch-csharp.mjs [--force]

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import JSZip from 'jszip'

const RUNTIME = '8.0.31'
const PACKAGES = [
  { id: 'microsoft.netcore.app.runtime.mono.wasi-wasm', version: RUNTIME, sha256: 'c30b47db9014838ecb4f649239c0810d5d4ad2d5818dbc99decc212f5cafebb5' },
  { id: 'microsoft.netcore.app.runtime.mono.browser-wasm', version: RUNTIME, sha256: '249c920148ce81839d947175ad971fc944baf5a8cfba2061db0be6d8fc4ef616' },
  { id: 'microsoft.codeanalysis.common', version: '4.14.0', sha256: '9deff3c47dc6aa8181e0e7a69c4f28244946e666a2fbfebb01268aab098bd811' },
  { id: 'microsoft.codeanalysis.csharp', version: '4.14.0', sha256: 'e4cce3dd791860b9300d6875eebd4d11749b5f0c166103e23a6912325828d496' },
  { id: 'system.collections.immutable', version: '9.0.0', sha256: 'fbaab954c7a87396e6e1616ca15ea705703d755e696bf3b8c96fa039d8bcc9a7' },
  { id: 'system.reflection.metadata', version: '9.0.0', sha256: '6af1166dc0a1ed7829b127ac9d1dff4a0c568bfe82e4ec6347cf497ff49f4634' },
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'toolchains', 'csharp')
const cache = join(root, 'node_modules', '.cache', 'opcode-csharp')
const runner = join(root, 'toolchains', 'csharp', 'csharp.dll')
const stampFile = join(out, 'packages.json')
const stamp = JSON.stringify({ packages: PACKAGES.map((p) => `${p.id}@${p.version}:${p.sha256}`), runner: createHash('sha256').update(readFileSync(runner)).digest('hex') })
const OUTPUTS = ['dotnet.wasm.gz', 'managed.tar.gz']

function upToDate() {
  try {
    return readFileSync(stampFile, 'utf8') === stamp && OUTPUTS.every((file) => existsSync(join(out, file)))
  } catch {
    return false
  }
}

async function download({ id, version, sha256 }) {
  const file = join(cache, `${id}.${version}.nupkg`)
  const verify = (bytes) => createHash('sha256').update(bytes).digest('hex') === sha256
  if (existsSync(file) && verify(readFileSync(file))) return readFileSync(file)
  mkdirSync(cache, { recursive: true })
  const url = `https://api.nuget.org/v3-flatcontainer/${id}/${version}/${id}.${version}.nupkg`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!verify(bytes)) throw new Error(`Checksum mismatch for ${id} ${version} (got ${createHash('sha256').update(bytes).digest('hex')})`)
  writeFileSync(`${file}.part`, bytes)
  renameSync(`${file}.part`, file)
  return bytes
}

// A minimal ustar writer (regular files only).
function tar(entries) {
  const blocks = []
  for (const { path, data } of entries) {
    const header = Buffer.alloc(512)
    header.write(path, 0)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

if (!process.argv.includes('--force') && upToDate()) process.exit(0)

try {
  const zips = {}
  for (const pkg of PACKAGES) zips[pkg.id] = await JSZip.loadAsync(await download(pkg))
  const read = (id, path) => {
    const entry = zips[id].file(path)
    if (!entry) throw new Error(`${path} is missing from ${id}`)
    return entry.async('nodebuffer')
  }

  const wasi = 'microsoft.netcore.app.runtime.mono.wasi-wasm'
  const managed = new Map() // file name -> bytes
  for (const entry of zips[wasi].file(/^runtimes\/wasi-wasm\/lib\/net8\.0\/[^/]+\.dll$/)) managed.set(entry.name.split('/').pop(), await entry.async('nodebuffer'))
  managed.set('System.Private.CoreLib.dll', await read(wasi, 'runtimes/wasi-wasm/native/System.Private.CoreLib.dll'))
  managed.set('System.Security.Cryptography.dll', await read('microsoft.netcore.app.runtime.mono.browser-wasm', 'runtimes/browser-wasm/lib/net8.0/System.Security.Cryptography.dll'))
  managed.set('Microsoft.CodeAnalysis.dll', await read('microsoft.codeanalysis.common', 'lib/net8.0/Microsoft.CodeAnalysis.dll'))
  managed.set('Microsoft.CodeAnalysis.CSharp.dll', await read('microsoft.codeanalysis.csharp', 'lib/net8.0/Microsoft.CodeAnalysis.CSharp.dll'))
  managed.set('System.Collections.Immutable.dll', await read('system.collections.immutable', 'lib/net8.0/System.Collections.Immutable.dll'))
  managed.set('System.Reflection.Metadata.dll', await read('system.reflection.metadata', 'lib/net8.0/System.Reflection.Metadata.dll'))
  managed.set('csharp.dll', readFileSync(runner))

  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'dotnet.wasm.gz'), gzipSync(await read(wasi, 'runtimes/wasi-wasm/native/dotnet.wasm'), { level: 9 }))
  const entries = [...managed].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => ({ path: name, data }))
  writeFileSync(join(out, 'managed.tar.gz'), gzipSync(tar(entries), { level: 9 }))
  writeFileSync(stampFile, stamp)
  for (const file of OUTPUTS) console.log(`  csharp/${file}: ${(readFileSync(join(out, file)).length / 1e6).toFixed(1)} MB`)
} catch (error) {
  console.error(`\nCould not prepare C#: ${error.message}`)
  console.error('C# projects will not run until this succeeds (it needs network access once): node scripts/fetch-csharp.mjs\n')
  process.exit(process.env.CI ? 1 : 0)
}
