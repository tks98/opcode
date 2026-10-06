// Downloads the container images Opcode Docker comes with (32-bit x86 builds,
// pinned by digest) from Docker Hub and writes them as one `docker load`
// archive. build.sh puts it in the image and the machine loads it on its
// first boot, so these work without internet:
//
//   docker run hello-world
//   docker run -it alpine sh
//
// Usage: node toolchains/linux/fetch-images.mjs <output.tar>
//        node toolchains/linux/fetch-images.mjs --latest   (prints current digests)
//
// The archive is cached in node_modules/.cache (Docker Hub limits how often
// anonymous users may download images).

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const IMAGES = [
  { name: 'hello-world', tag: 'latest', digest: 'sha256:09538a1f51d3ec5af0449a1640937dfdf79b0e9b8c4da5b8a883086d5c1492ef' },
  { name: 'alpine', tag: 'latest', digest: 'sha256:c54a80678a9e7a744b39d478329d5eb8e568c2e0321defd14cab57047557e202' },
  { name: 'busybox', tag: 'latest', digest: 'sha256:79b6957454b0506796c042e9e2dfedd996c7efc93e701166d2dc9569bc9cc096' },
  { name: 'nginx', tag: 'alpine-slim', digest: 'sha256:5e1e711ae10159520b9064e56c5251481eac2282bcbeb99dfd1fe8a414f454a4' },
]

const REGISTRY = 'https://registry-1.docker.io/v2'
const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

async function token(repository) {
  const response = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`)
  if (!response.ok) throw new Error(`Docker Hub login failed (HTTP ${response.status})`)
  return (await response.json()).token
}

async function get(repository, path, auth, accept = MANIFESTS) {
  const response = await fetch(`${REGISTRY}/${repository}/${path}`, { headers: { Authorization: `Bearer ${auth}`, Accept: accept } })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${repository}/${path}`)
  return Buffer.from(await response.arrayBuffer())
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

async function blob(repository, digest, auth) {
  const data = await get(repository, `blobs/${digest}`, auth, '*/*')
  if (`sha256:${sha256(data)}` !== digest) throw new Error(`Checksum mismatch for ${repository}@${digest}`)
  return data
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

if (process.argv[2] === '--latest') {
  for (const { name, tag } of IMAGES) {
    const repository = `library/${name}`
    const auth = await token(repository)
    const index = JSON.parse(await get(repository, `manifests/${tag}`, auth))
    const image = index.manifests?.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === '386')
    console.log(`${name}:${tag}`, image ? image.digest : 'no linux/386 image')
  }
  process.exit(0)
}

const output = process.argv[2]
if (!output) {
  console.error('Usage: node toolchains/linux/fetch-images.mjs <output.tar>')
  process.exit(1)
}

const cacheDir = join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.cache/opcode-docker-images')
const cached = join(cacheDir, `images-${sha256(JSON.stringify(IMAGES)).slice(0, 16)}.tar`)
if (existsSync(cached)) {
  copyFileSync(cached, output)
  console.log(`  ${output}: from the cache`)
  process.exit(0)
}

const files = new Map() // archive path -> data (layers shared between images are stored once)
const manifest = []
for (const { name, tag, digest } of IMAGES) {
  const repository = `library/${name}`
  const auth = await token(repository)
  const manifestBytes = await get(repository, `manifests/${digest}`, auth)
  if (`sha256:${sha256(manifestBytes)}` !== digest) throw new Error(`Checksum mismatch for ${name}@${digest}`)
  const image = JSON.parse(manifestBytes)
  const configBytes = await blob(repository, image.config.digest, auth)
  const config = JSON.parse(configBytes)
  if (config.architecture !== '386') throw new Error(`${name}@${digest} is ${config.architecture}, not 386`)
  const layers = []
  for (const [i, layer] of image.layers.entries()) {
    const diffId = config.rootfs.diff_ids[i]
    const path = `${diffId.slice('sha256:'.length)}.tar`
    if (!files.has(path)) {
      const data = gunzipSync(await blob(repository, layer.digest, auth))
      if (`sha256:${sha256(data)}` !== diffId) throw new Error(`Layer ${i} of ${name} does not match its config`)
      files.set(path, data)
    }
    layers.push(path)
  }
  const configPath = `${image.config.digest.slice('sha256:'.length)}.json`
  files.set(configPath, configBytes)
  manifest.push({ Config: configPath, RepoTags: [`${name}:${tag}`], Layers: layers })
  console.log(`  ${name}:${tag}`)
}
files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
const archive = tar([...files].map(([path, data]) => ({ path, data })))
writeFileSync(output, archive)
mkdirSync(cacheDir, { recursive: true })
writeFileSync(`${cached}.part`, archive)
renameSync(`${cached}.part`, cached)
console.log(`  ${output}: ${(archive.length / 1e6).toFixed(1)} MB`)
