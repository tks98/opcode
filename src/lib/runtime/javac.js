// The `javac` command: the shell forwards it to Opcode (like clang), which
// compiles in a Web Worker (javac.worker.js) and writes real .class files
// back into the sandbox, where `java` (Ristretto) runs them.

import { downloadBytes, gunzipIfNeeded } from './toolchains.js'
import { basename, dirname, joinPath, normalizePath } from '../paths.js'

const FILES = {
  wasm: 'toolchains/java/javac.wasm.gz',
  runtime: 'toolchains/java/javac-runtime.js',
  sdk: 'toolchains/java/javac-sdk.bin',
}

let worker = null
let nextId = 1
const pending = new Map()
let prepared = null

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./javac.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id)
      if (!request) return
      pending.delete(data.id)
      if (data.type === 'error') request.reject(new Error(data.message))
      else request.resolve(data)
    }
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The Java compiler crashed')
      for (const request of pending.values()) request.reject(error)
      pending.clear()
      worker = null
      prepared = null
    }
  }
  return worker
}

function send(message, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ ...message, id }, transfer)
  })
}

export function isJavacReady() {
  return prepared?.done === true
}

/** Download and start the compiler. Safe to call repeatedly. */
export function prepareJavac(label, sizeMB, onProgress) {
  if (!prepared) {
    const received = {}
    const report = (key) => (progress) => {
      received[key] = progress.downloadedBytes
      const downloaded = Object.values(received).reduce((sum, n) => sum + n, 0)
      for (const listener of prepared.listeners) {
        listener({ label, phase: 'downloading', percent: Math.min(99, (downloaded / (sizeMB * 1e6)) * 100), downloadedBytes: downloaded, totalBytes: sizeMB * 1e6 })
      }
    }
    const url = (path) => new URL(path, document.baseURI).href
    const promise = Promise.all([
      downloadBytes(label, url(FILES.wasm), sizeMB * 0.45, report('wasm')).then(gunzipIfNeeded),
      downloadBytes(label, url(FILES.sdk), sizeMB * 0.55, report('sdk')),
    ])
      .then(([wasm, sdk]) => {
        for (const listener of prepared.listeners) listener({ label, phase: 'loading', percent: 100 })
        return send({ type: 'init', wasm, sdk, runtimeUrl: url(FILES.runtime) }, [wasm.buffer, sdk.buffer])
      })
      .then(
        () => {
          prepared.done = true
        },
        (error) => {
          prepared = null
          throw error
        },
      )
    prepared = { promise, listeners: new Set(), done: false }
  }
  if (onProgress) prepared.listeners.add(onProgress)
  const { promise, listeners } = prepared
  return promise.finally(() => listeners.delete(onProgress))
}

/**
 * Compile Java sources ({ path, content }) against class files ({ path, bytes },
 * paths like "pkg/Util.class"). Resolves to { ok, diagnostics, outputs }.
 */
export function compileJava({ sources, classFiles = [] }) {
  return send({ type: 'compile', sources, classFiles })
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

// Options that take a value, and ones Opcode accepts but has no use for.
const VALUE_OPTIONS = new Set(['-d', '-cp', '-classpath', '--class-path', '-sourcepath', '--source-path', '-encoding', '--release', '-source', '--source', '-target', '--target', '-s', '-h'])
const IGNORED = /^(-g(:.*)?|-nowarn|-verbose|-deprecation|-Xlint(:.*)?|-Werror|-parameters|-Xdiags:.*|-XDrawDiagnostics|--enable-preview|-implicit:.*|-proc:.*)$/

/**
 * Parse javac's arguments: { sources, outDir, classPath, warnings } or
 * { error } for a usage problem.
 */
export function parseJavacArgs(args) {
  const result = { sources: [], outDir: null, classPath: null, warnings: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--version' || arg === '-version') return { version: true }
    if (arg === '--help' || arg === '-help' || arg === '-?') return { help: true }
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[++i]
      if (value === undefined) return { error: `${arg} requires an argument` }
      if (arg === '-d') result.outDir = value
      else if (arg === '-cp' || arg === '-classpath' || arg === '--class-path') result.classPath = value.split(':').filter(Boolean)
      continue
    }
    if (arg.startsWith('-')) {
      if (!IGNORED.test(arg)) result.warnings.push(`warning: ignoring option ${arg} (not supported in Opcode)`)
      continue
    }
    if (!arg.endsWith('.java')) return { error: `invalid flag: ${arg}` }
    result.sources.push(arg)
  }
  if (!result.sources.length && !result.error) return { error: 'no source files' }
  return result
}

/** Where javac writes a class: in -d (by package), or next to its source file. */
export function classOutputPath(className, sourcePath, outDir) {
  if (outDir !== null && outDir !== undefined) return normalizePath(joinPath(outDir, className))
  return joinPath(dirname(sourcePath), basename(className))
}

/**
 * Diagnostics in javac's own format:
 *
 *   Main.java:5: error: ';' expected
 *           System.out.println("hi")
 *                                   ^
 *   1 error
 */
export function formatJavacDiagnostics(diagnostics, sourceText) {
  const lines = []
  let errors = 0
  let warnings = 0
  for (const diagnostic of diagnostics) {
    const kind = diagnostic.severity === 'error' ? 'error' : diagnostic.severity === 'warning' ? 'warning' : 'note'
    if (kind === 'error') errors++
    if (kind === 'warning') warnings++
    const [first, ...rest] = String(diagnostic.message ?? '').split('\n')
    const file = String(diagnostic.fileName ?? '').replace(/^\/+/, '')
    lines.push(file && diagnostic.lineNumber > 0 ? `${file}:${diagnostic.lineNumber}: ${kind}: ${first}` : `${kind}: ${first}`)
    const source = file && diagnostic.lineNumber > 0 ? sourceText(file)?.split('\n')[diagnostic.lineNumber - 1] : undefined
    if (source !== undefined) {
      lines.push(source.replace(/\r$/, ''))
      if (diagnostic.columnNumber > 0) {
        // Keep tabs so the caret lines up under the same characters.
        const indent = source.slice(0, diagnostic.columnNumber - 1).replace(/[^\t]/g, ' ')
        lines.push(`${indent}^`)
      }
    }
    lines.push(...rest)
  }
  if (errors) lines.push(`${errors} error${errors === 1 ? '' : 's'}`)
  if (warnings) lines.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  return lines.length ? `${lines.join('\n')}\n` : ''
}

// Where a class file's SourceFile attribute points: { index, start, end, name }
// for its UTF-8 constant (start/end: the constant's bytes), or null.
function findSourceFile(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  const u2 = () => {
    const value = view.getUint16(pos)
    pos += 2
    return value
  }
  const utf8 = new Map() // index -> { text, start, end }
  const count = u2()
  for (let index = 1; index < count; index++) {
    const start = pos
    const tag = view.getUint8(pos++)
    if (tag === 1) {
      const length = u2()
      utf8.set(index, { text: new TextDecoder().decode(bytes.subarray(pos, pos + length)), start, end: pos + length })
      pos += length
    } else if (tag === 5 || tag === 6) {
      pos += 8
      index++
    } else if ([3, 4, 9, 10, 11, 12, 17, 18].includes(tag)) pos += 4
    else if ([7, 8, 16, 19, 20].includes(tag)) pos += 2
    else if (tag === 15) pos += 3
    else return null
  }
  pos += 6
  const interfaces = u2()
  pos += 2 * interfaces
  for (let section = 0; section < 2; section++) {
    const members = u2()
    for (let i = 0; i < members; i++) {
      pos += 6
      const attributes = u2()
      for (let j = 0; j < attributes; j++) {
        pos += 2
        pos += 4 + view.getUint32(pos)
      }
    }
  }
  const attributes = u2()
  for (let i = 0; i < attributes; i++) {
    const name = utf8.get(u2())?.text
    const length = view.getUint32(pos)
    pos += 4
    if (name === 'SourceFile') {
      const index = view.getUint16(pos)
      const entry = utf8.get(index)
      return entry ? { index, start: entry.start, end: entry.end, name: entry.text } : null
    }
    pos += length
  }
  return null
}

/**
 * The SourceFile attribute of a class file ("Main.java"), which tells which
 * source a compiled class came from.
 */
export function sourceFileOf(bytes) {
  return findSourceFile(bytes)?.name ?? null
}

/**
 * The class file with its SourceFile set to `name`. (TeaVM's javac records
 * ":Main.java", which shows up in stack traces as "(:Main.java:3)".)
 */
export function withSourceFile(bytes, name) {
  const found = findSourceFile(bytes)
  if (!found || found.name === name) return bytes
  const text = new TextEncoder().encode(name)
  const entry = new Uint8Array(3 + text.length)
  entry[0] = 1
  entry[1] = text.length >> 8
  entry[2] = text.length & 0xff
  entry.set(text, 3)
  const result = new Uint8Array(bytes.length - (found.end - found.start) + entry.length)
  result.set(bytes.subarray(0, found.start))
  result.set(entry, found.start)
  result.set(bytes.subarray(found.end), found.start + entry.length)
  return result
}
