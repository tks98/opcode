// Downloads and caches the packages behind each toolchain. Registry packages
// are cached by the Wasmer SDK in browser storage; Opcode's own toolchains
// (Go, Rust: public/toolchains/) are kept in the Cache API. Concurrent
// requests for the same toolchain share one download and all receive progress.

import { getWasmer } from './wasmer.js'
import { DOTNET_MANAGED, JAVA_HOME, RUST_SYSROOT, RUST_TARGET, SHELL_PACKAGES, TOOLCHAINS } from '../languages.js'

const CACHE_NAME = 'opcode-toolchains-v1'
const loads = new Map()

/**
 * Progress snapshots passed to callbacks:
 * { label, phase: 'downloading' | 'loading' | 'ready', percent: number | null,
 *   downloadedBytes, totalBytes: number | null }
 */
function shared(key, start) {
  let entry = loads.get(key)
  if (!entry) {
    entry = { listeners: new Set(), last: null }
    const emit = (progress) => {
      entry.last = progress
      for (const listener of entry.listeners) listener(progress)
    }
    entry.promise = start(emit).catch((error) => {
      loads.delete(key)
      throw error
    })
    loads.set(key, entry)
  }
  return entry
}

function subscribe(entry, onProgress) {
  if (!onProgress) return entry.promise
  entry.listeners.add(onProgress)
  if (entry.last) onProgress(entry.last)
  return entry.promise.finally(() => entry.listeners.delete(onProgress))
}

function fromSdkProgress(label, progress) {
  return {
    label,
    phase: progress.phase === 'ready' ? 'ready' : progress.phase === 'loading' ? 'loading' : 'downloading',
    percent: progress.download.percent,
    downloadedBytes: progress.download.downloadedBytes,
    totalBytes: progress.download.totalBytes,
  }
}

async function loadRegistryPackages(label, sources, emit) {
  const wasmer = await getWasmer()
  return wasmer.packages.loadMany(sources, {
    onProgress: (progress) => emit(fromSdkProgress(label, progress)),
  })
}

async function cachedFetch(url) {
  try {
    const cache = await caches.open(CACHE_NAME)
    const hit = await cache.match(url)
    if (hit) return { response: hit, cached: true }
    const response = await fetch(url)
    if (response.ok) await cache.put(url, response.clone())
    return { response, cached: false }
  } catch {
    // Cache API unavailable (e.g. some private modes): fetch directly.
    return { response: await fetch(url), cached: false }
  }
}

/**
 * Download a file with progress, keeping a copy in the Cache API so the
 * next visit loads it from disk. Resolves to its bytes.
 */
export async function downloadBytes(label, url, sizeHintMB, emit) {
  const { response, cached } = await cachedFetch(url)
  if (!response.ok) throw new Error(`Could not download ${label} (HTTP ${response.status})`)
  const total = Number(response.headers.get('content-length')) || (cached ? null : sizeHintMB * 1e6)
  const reader = response.body.getReader()
  const chunks = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (!cached) {
      emit({ label, phase: 'downloading', percent: total ? Math.min(99, (received / total) * 100) : null, downloadedBytes: received, totalBytes: total })
    }
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/**
 * Decompress gzip data. Hosts that serve .gz files with
 * Content-Encoding: gzip hand over already-decompressed bytes, which are
 * returned unchanged.
 */
export async function gunzipIfNeeded(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function loadLocalToolchain(toolchain, emit) {
  // Served from public/; relative to the page so subpath deployments work.
  const url = new URL(toolchain.wasm, document.baseURI).href
  const bytes = await gunzipIfNeeded(await downloadBytes(toolchain.name, url, toolchain.sizeMB, emit))
  emit({ label: toolchain.name, phase: 'loading', percent: 100, downloadedBytes: bytes.length, totalBytes: bytes.length })
  const wasmer = await getWasmer()
  const names = toolchain.commands ?? [toolchain.command]
  const pkg = await wasmer.packages.create({
    modules: { [toolchain.command]: bytes },
    commands: Object.fromEntries(names.map((name) => [name, { module: toolchain.command }])),
  })
  return [pkg]
}

/** The regular files in a tar archive: [{ path, bytes }] (views into `bytes`). */
export function untar(bytes) {
  const decoder = new TextDecoder()
  const text = (offset, length) => decoder.decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/s, '')
  const files = []
  let longName = null
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const name = text(offset, 100)
    if (!name) break // the end-of-archive blocks
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(bytes[offset + 156])
    const data = bytes.subarray(offset + 512, offset + 512 + size)
    const prefix = text(offset + 257, 6) === 'ustar' ? text(offset + 345, 155) : ''
    if (type === 'L') {
      longName = decoder.decode(data).replace(/\0.*$/s, '') // GNU long name for the next entry
    } else {
      if (type === '0' || type === '\0') files.push({ path: (longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, ''), bytes: data })
      longName = null
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

// Rust: rustc as a command, with the standard library bundled as files at
// RUST_SYSROOT (both downloads report progress together).
async function loadRustToolchain(toolchain, emit) {
  const parts = Object.entries(toolchain.rust)
  const received = {}
  const totals = {}
  const report = (key) => (progress) => {
    received[key] = progress.downloadedBytes
    totals[key] = progress.totalBytes
    const downloaded = Object.values(received).reduce((sum, n) => sum + n, 0)
    const known = parts.every(([part]) => totals[part])
    const total = known ? Object.values(totals).reduce((sum, n) => sum + n, 0) : toolchain.sizeMB * 1e6
    emit({ label: toolchain.name, phase: 'downloading', percent: Math.min(99, (downloaded / total) * 100), downloadedBytes: downloaded, totalBytes: total })
  }
  const [compiler, sysroot] = await Promise.all(
    parts.map(async ([part, path]) => {
      const url = new URL(path, document.baseURI).href
      return gunzipIfNeeded(await downloadBytes(toolchain.name, url, toolchain.sizeMB / parts.length, report(part)))
    }),
  )
  emit({ label: toolchain.name, phase: 'loading', percent: 100, downloadedBytes: compiler.length + sysroot.length, totalBytes: compiler.length + sysroot.length })
  const files = {}
  for (const file of untar(sysroot)) files[`${RUST_SYSROOT}/lib/rustlib/${RUST_TARGET}/lib/${file.path}`] = file.bytes
  const wasmer = await getWasmer()
  return [await wasmer.packages.create({ modules: { rustc: compiler }, commands: { rustc: { module: 'rustc' } }, files })]
}

// Java: Ristretto (a JVM written in Rust, built for WASI) as the `java`
// command, with a slim JDK home (java.base and its data files) at JAVA_HOME.
// A runtime that loads files installed with it: Java (its JDK home at
// JAVA_HOME) and C# (.NET's assemblies at DOTNET_MANAGED).
function loadJavaToolchain(toolchain, emit) {
  return loadRuntimeWithFiles(toolchain, emit, { runtime: toolchain.java.runtime, files: toolchain.java.jdk, at: JAVA_HOME, command: 'java' })
}

function loadDotnetToolchain(toolchain, emit) {
  return loadRuntimeWithFiles(toolchain, emit, { runtime: toolchain.dotnet.runtime, files: toolchain.dotnet.managed, at: DOTNET_MANAGED, command: 'dotnet-wasm' })
}

async function loadRuntimeWithFiles(toolchain, emit, { runtime: runtimePath, files: filesPath, at, command }) {
  const parts = Object.entries({ runtime: runtimePath, files: filesPath })
  const received = {}
  const report = (key) => (progress) => {
    received[key] = progress.downloadedBytes
    const downloaded = Object.values(received).reduce((sum, n) => sum + n, 0)
    emit({ label: toolchain.name, phase: 'downloading', percent: Math.min(99, (downloaded / (toolchain.sizeMB * 1e6)) * 100), downloadedBytes: downloaded, totalBytes: toolchain.sizeMB * 1e6 })
  }
  const [runtime, archive] = await Promise.all(
    parts.map(async ([part, path]) => gunzipIfNeeded(await downloadBytes(toolchain.name, new URL(path, document.baseURI).href, toolchain.sizeMB / parts.length, report(part)))),
  )
  emit({ label: toolchain.name, phase: 'loading', percent: 100, downloadedBytes: runtime.length + archive.length, totalBytes: runtime.length + archive.length })
  const files = {}
  for (const file of untar(archive)) files[`${at}/${file.path}`] = file.bytes
  const wasmer = await getWasmer()
  return [await wasmer.packages.create({ modules: { [command]: runtime }, commands: { [command]: { module: command } }, files })]
}

// Small commands Opcode builds itself (see toolchains/stty, toolchains/opcode-wait).
const SHELL_EXTRAS = [
  { command: 'stty', wasm: 'toolchains/stty.wasm' },
  { command: 'opcode-wait', wasm: 'toolchains/opcode-wait.wasm' },
]

async function loadShellExtras() {
  const wasmer = await getWasmer()
  return Promise.all(
    SHELL_EXTRAS.map(async ({ command, wasm }) => {
      const response = await fetch(new URL(wasm, document.baseURI))
      if (!response.ok) throw new Error(`Could not download ${wasm} (HTTP ${response.status})`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      return wasmer.packages.create({ modules: { [command]: bytes }, commands: { [command]: { module: command } } })
    }),
  )
}

/** The base system packages every terminal runs; bash is first. */
export function loadShellPackages(onProgress) {
  const entry = shared('shell', async (emit) => {
    const [packages, extras] = await Promise.all([loadRegistryPackages('terminal tools', SHELL_PACKAGES, emit), loadShellExtras()])
    return [...packages, ...extras]
  })
  return subscribe(entry, onProgress)
}

/** Resolve a toolchain id (see TOOLCHAINS) to its packages. */
export function loadToolchain(id, onProgress) {
  const toolchain = TOOLCHAINS[id]
  if (!toolchain) return Promise.reject(new Error(`Unknown toolchain "${id}"`))
  const entry = shared(id, (emit) => {
    if (toolchain.wasm) return loadLocalToolchain(toolchain, emit)
    if (toolchain.rust) return loadRustToolchain(toolchain, emit)
    if (toolchain.java) return loadJavaToolchain(toolchain, emit)
    if (toolchain.dotnet) return loadDotnetToolchain(toolchain, emit)
    return loadRegistryPackages(toolchain.name, toolchain.packages, emit)
  })
  return subscribe(entry, onProgress)
}

export function formatBytes(bytes) {
  if (!bytes) return '0 MB'
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`
}
