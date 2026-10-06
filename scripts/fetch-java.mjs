// Builds the Java runtime files Opcode serves, from a pinned Amazon Corretto
// 21 JDK (GPLv2 with the Classpath Exception). Java 21 because javac (built
// with TeaVM from JDK 21's sources) reads class files up to Java 21's. The JDK is too big to keep in
// git, so `npm run dev` and `npm run build` fetch it once (about 230 MB,
// cached in node_modules/.cache), verify its checksum and write (gitignored):
//
//   public/toolchains/java/jdk.tar.gz     (~11 MB) a slim JDK home for the
//     `java` command (Ristretto): java.base's classes, time zones, security
//     and configuration files, without native libraries
//   public/toolchains/java/javac-sdk.bin  (~2 MB) the API of java.base's
//     exported packages, method bodies removed, for javac to compile against
//
// The `java` and `javac` programs themselves are small and kept in git (see
// toolchains/java/README.md).
//
// Usage: node scripts/fetch-java.mjs [--force]

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import JSZip from 'jszip'
import { stripClass } from '../toolchains/java/classfile.mjs'

const VERSION = '21.0.12.12.1'
const URL_ = `https://corretto.aws/downloads/resources/${VERSION}/amazon-corretto-${VERSION}-linux-x64.tar.gz`
const SHA256 = '8785082c2fb999c024c8821e4a7c5391bda28f1667cceadafd78e2965b7669d2'
const TOP = `amazon-corretto-${VERSION}-linux-x64`
// Internal annotation types java.base's public classes are annotated with.
const SDK_EXTRAS = /^jdk\/internal\/(javac|vm\/annotation)\/|^jdk\/internal\/ValueBased\.class$/

// What the slim JDK home keeps besides java.base's classes.
const DATA = ['version.txt', 'release', 'lib/tzdb.dat', 'lib/security', 'conf']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'toolchains', 'java')
const cache = join(root, 'node_modules', '.cache', 'opcode-java')
const stampFile = join(out, 'jdk.json')
const stamp = JSON.stringify({ version: VERSION, sha256: SHA256, format: 1 })
const OUTPUTS = ['jdk.tar.gz', 'javac-sdk.bin']

function upToDate() {
  try {
    return readFileSync(stampFile, 'utf8') === stamp && OUTPUTS.every((file) => existsSync(join(out, file)))
  } catch {
    return false
  }
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadJdk() {
  const archive = join(cache, `${TOP}.tar.gz`)
  if (existsSync(archive) && (await sha256(archive)) === SHA256) return archive
  mkdirSync(cache, { recursive: true })
  console.log(`Downloading Amazon Corretto ${VERSION} (about 210 MB, once)…`)
  const response = await fetch(URL_)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${URL_}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${archive}.part`))
  const got = await sha256(`${archive}.part`)
  if (got !== SHA256) throw new Error(`Checksum mismatch for ${URL_} (got ${got})`)
  renameSync(`${archive}.part`, archive)
  return archive
}

// A minimal ustar writer (regular files only).
function tar(entries) {
  const blocks = []
  for (const { path, data } of entries) {
    const header = Buffer.alloc(512)
    const name = Buffer.from(path)
    if (name.length > 100) throw new Error(`path too long for tar: ${path}`)
    name.copy(header, 0)
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

// The SDK format teavm-javac reads: gzip of [u16 name length][name][u32 size][bytes]...
function teavmArchive(entries) {
  const parts = []
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name)
    const head = Buffer.alloc(6 + nameBytes.length)
    head.writeUInt16BE(nameBytes.length, 0)
    nameBytes.copy(head, 2)
    head.writeUInt32BE(data.length, 2 + nameBytes.length)
    parts.push(head, data)
  }
  return gzipSync(Buffer.concat(parts), { level: 9 })
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

if (!process.argv.includes('--force') && upToDate()) process.exit(0)

try {
  const archive = await downloadJdk()
  const extracted = join(cache, 'extracted')
  mkdirSync(extracted, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', extracted, ...[...DATA, 'jmods/java.base.jmod'].map((path) => `${TOP}/${path}`)])
  const home = join(extracted, TOP)

  // jmods are zip files after a 4-byte "JM" header.
  const jmod = readFileSync(join(home, 'jmods', 'java.base.jmod'))
  const zip = await JSZip.loadAsync(jmod.subarray(4))
  const slim = new JSZip()
  const sdk = []
  for (const file of Object.values(zip.files)) {
    if (file.dir || !file.name.startsWith('classes/')) continue
    const data = await file.async('nodebuffer')
    slim.file(file.name, data)
    const name = file.name.slice('classes/'.length)
    // javac only needs what programs can use: the exported java.* and javax.*
    // packages, plus the internal annotations their classes carry.
    if (name.endsWith('.class') && (/^javax?\//.test(name) || SDK_EXTRAS.test(name) || name === 'module-info.class')) {
      sdk.push({ name, data: Buffer.from(stripClass(data)) })
    }
  }
  // Stored (uncompressed) inside, so the whole download compresses well.
  const slimJmod = Buffer.concat([Buffer.from('JM\x01\x00', 'latin1'), await slim.generateAsync({ type: 'nodebuffer', compression: 'STORE' })])

  const entries = [{ path: 'jmods/java.base.jmod', data: slimJmod }]
  for (const path of DATA) {
    const full = join(home, path)
    for (const file of statSync(full).isDirectory() ? walk(full) : [full]) entries.push({ path: relative(home, file), data: readFileSync(file) })
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'jdk.tar.gz'), gzipSync(tar(entries), { level: 9 }))
  writeFileSync(join(out, 'javac-sdk.bin'), teavmArchive(sdk))
  writeFileSync(stampFile, stamp)
  for (const file of OUTPUTS) console.log(`  ${file}: ${(statSync(join(out, file)).size / 1e6).toFixed(1)} MB`)
} catch (error) {
  console.error(`\nCould not prepare Java: ${error.message}`)
  console.error('Java projects will not run until this succeeds (it needs network access once): node scripts/fetch-java.mjs\n')
  process.exit(process.env.CI ? 1 : 0)
}
