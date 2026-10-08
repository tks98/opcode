// The Wasmer packages Opcode's terminals run (bash and its tools, Python,
// Node.js, PHP, static-web-server), served by Opcode itself instead of
// Wasmer's registry, so the site keeps working when wasmer.io doesn't (see
// src/lib/runtime/wasmerMirror.js).
//
// wasmer-packages.lock.json (in git) pins the packages src/lib/languages.js
// names, and every package they depend on, to one version and checksum, with
// the registry's answer for each. Dependencies are version ranges in the
// packages themselves (bash uses wasmer/coreutils@^1.0.19), so without the
// lock a new release on Wasmer's side would change what Opcode runs.
//
//   node scripts/wasmer-packages.mjs          download what the lock lists into
//                                             public/wasmer/ (gitignored), and
//                                             check the checksums; `dev` and
//                                             `build` run this
//   node scripts/wasmer-packages.mjs --lock   resolve languages.js's packages
//                                             again and rewrite the lock

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lockFile = join(root, 'wasmer-packages.lock.json')
const out = join(root, 'public', 'wasmer')
const REGISTRY = 'https://registry.wasmer.io/graphql'

// The query @wasmer/sdk 0.19 sends for a package; the lock keeps the answer.
const query = (name) => `{
    getPackage(name: ${JSON.stringify(name)}) {
        packageName
        namespace
        versions {
          version
          isArchived
          v2: distribution(version: V2) {
            piritaDownloadUrl
            piritaSha256Hash
            webcManifest
            webcSize
          }
          v3: distribution(version: V3) {
            piritaDownloadUrl
            piritaSha256Hash
            webcManifest
            webcSize
          }
        }
    }
    info {
        defaultFrontend
    }
}`

async function ask(name) {
  const response = await fetch(REGISTRY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: query(name) }),
  })
  const body = await response.json()
  if (!response.ok || body.errors || !body.data?.getPackage) throw new Error(`The registry has no package ${name}: ${JSON.stringify(body.errors ?? body).slice(0, 200)}`)
  return body.data
}

// Version ranges as the packages write them: =1.2.3, 1.2.3, ^1.2.3, ~1.2.3, *.
const parse = (version) => version.split(/[.+-]/).slice(0, 3).map(Number)
const compare = (a, b) => {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
function satisfies(version, range) {
  if (range === '*' || range === '') return true
  const match = range.match(/^([=^~]?)(\d+(?:\.\d+){0,2})$/)
  if (!match) throw new Error(`Can't read the version range "${range}"`)
  const [, op, base] = match
  const [v, b] = [parse(version), parse(base)]
  if (op === '=' || (op === '' && base.split('.').length === 3)) return compare(version, base) === 0
  if (compare(version, base) < 0) return false
  if (op === '~') return v[0] === b[0] && v[1] === b[1]
  // ^: the same leftmost non-zero part.
  if (b[0] > 0 || op === '') return v[0] === b[0]
  if (b[1] > 0) return v[0] === 0 && v[1] === b[1]
  return v[0] === 0 && v[1] === 0 && v[2] === b[2]
}

const split = (spec) => {
  const at = spec.lastIndexOf('@')
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, '*']
}

async function lock() {
  const { SHELL_PACKAGES, TOOLCHAINS } = await import('../src/lib/languages.js')
  const wanted = [...new Set([...SHELL_PACKAGES, ...Object.values(TOOLCHAINS).flatMap((toolchain) => toolchain.packages ?? [])])]
  const ranges = new Map() // name -> every range asked for
  const answers = new Map()
  const queue = wanted.map(split)
  while (queue.length) {
    const [name, range] = queue.shift()
    if (!ranges.has(name)) ranges.set(name, new Set())
    if (ranges.get(name).has(range)) continue
    ranges.get(name).add(range)
    if (!answers.has(name)) answers.set(name, await ask(name))
    const version = pick(name, answers.get(name), ranges.get(name))
    const manifest = JSON.parse(version.v3?.webcManifest ?? version.v2?.webcManifest ?? '{}')
    for (const dependency of Object.values(manifest.use ?? {})) queue.push(split(dependency))
  }
  const packages = {}
  let info
  for (const [name, answer] of [...answers].sort(([a], [b]) => a.localeCompare(b))) {
    const version = pick(name, answer, ranges.get(name))
    const distribution = version.v3?.piritaDownloadUrl ? version.v3 : version.v2
    info = answer.info
    packages[name] = {
      version: version.version,
      url: distribution.piritaDownloadUrl,
      sha256: distribution.piritaSha256Hash,
      size: distribution.webcSize,
      // What the registry says about the package, with only this version.
      answer: { ...answer.getPackage, versions: [version] },
    }
  }
  writeFileSync(lockFile, `${JSON.stringify({ sdk: '@wasmer/sdk 0.19', info, packages }, null, 2)}\n`)
  const total = Object.values(packages).reduce((sum, item) => sum + item.size, 0)
  console.log(`Locked ${Object.keys(packages).length} Wasmer packages (${(total / 1e6).toFixed(0)} MB):`)
  for (const [name, item] of Object.entries(packages)) console.log(`  ${name}@${item.version}  ${(item.size / 1e6).toFixed(1)} MB`)
}

function pick(name, answer, ranges) {
  const candidates = answer.getPackage.versions
    .filter((version) => (version.v3?.piritaDownloadUrl || version.v2?.piritaDownloadUrl) && [...ranges].every((range) => satisfies(version.version, range)))
    .sort((a, b) => compare(b.version, a.version))
  const chosen = candidates.find((version) => !version.isArchived) ?? candidates[0]
  if (!chosen) throw new Error(`No version of ${name} satisfies ${[...ranges].join(', ')}`)
  return chosen
}

async function download() {
  const { info, packages } = JSON.parse(readFileSync(lockFile, 'utf8'))
  const registry = `${JSON.stringify({ info, packages: Object.fromEntries(Object.entries(packages).map(([name, item]) => [name, item.answer])) })}\n`
  const registryFile = join(out, 'registry.json')
  const file = (item) => join(out, `${item.sha256}.webc`)
  const missing = Object.entries(packages).filter(([, item]) => !existsSync(file(item)))
  if (!missing.length && existsSync(registryFile) && readFileSync(registryFile, 'utf8') === registry) return
  mkdirSync(out, { recursive: true })
  if (missing.length) {
    const total = missing.reduce((sum, [, item]) => sum + item.size, 0)
    console.log(`Fetching ${missing.length} Wasmer packages (${(total / 1e6).toFixed(0)} MB)…`)
  }
  for (const [name, item] of missing) {
    const response = await fetch(item.url)
    if (!response.ok) throw new Error(`Could not download ${name}@${item.version} (HTTP ${response.status} from ${item.url})`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== item.sha256) throw new Error(`${name}@${item.version}: checksum mismatch (got ${sha256})`)
    writeFileSync(`${file(item)}.tmp`, bytes)
    renameSync(`${file(item)}.tmp`, file(item))
    console.log(`  ${name}@${item.version}: ${(bytes.length / 1e6).toFixed(1)} MB`)
  }
  writeFileSync(registryFile, registry)
}

try {
  if (process.argv.includes('--lock')) await lock()
  else await download()
} catch (error) {
  console.error(`${error.message}\nThe terminals would download these packages from Wasmer instead (rerun: node scripts/wasmer-packages.mjs).`)
  process.exit(1)
}
