// The `tsc` command: the shell forwards it to Opcode (like javac), which runs
// the TypeScript compiler in a Web Worker (tsc.worker.js) and writes the
// JavaScript it produces back into the sandbox, where node runs it.

import { downloadBytes, gunzipIfNeeded } from './toolchains.js'

const FILES = {
  compiler: 'toolchains/typescript/typescript.js.gz',
  types: 'toolchains/typescript/types.json.gz',
}

// Files tsc may read: TypeScript and JavaScript sources, JSON (tsconfig.json,
// package.json, imported data), and type definitions in node_modules.
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/
export function isTscInput(path) {
  if (path.split('/').includes('node_modules')) return path.endsWith('.d.ts') || path.endsWith('/package.json')
  return SOURCE.test(path)
}

let worker = null
let nextId = 1
const pending = new Map()
let prepared = null

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./tsc.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id)
      if (!request) return
      pending.delete(data.id)
      if (data.type === 'error') request.reject(new Error(data.message))
      else request.resolve(data)
    }
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The TypeScript compiler crashed')
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

export function isTscReady() {
  return prepared?.done === true
}

/** Download and start the compiler. Safe to call repeatedly. */
export function prepareTsc(label, sizeMB, onProgress) {
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
      downloadBytes(label, url(FILES.compiler), sizeMB * 0.6, report('compiler')).then(gunzipIfNeeded),
      downloadBytes(label, url(FILES.types), sizeMB * 0.4, report('types')).then(gunzipIfNeeded),
    ])
      .then(([compiler, types]) => {
        for (const listener of prepared.listeners) listener({ label, phase: 'loading', percent: 100 })
        return send({ type: 'init', compiler, types }, [compiler.buffer, types.buffer])
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
 * Run tsc with `args` in directory `cwd`, given the files it may read
 * ({ absolutePath: text }). Resolves to { code, output, outputs }, where
 * outputs are the files it wrote ({ absolutePath: text }).
 */
export function runTsc({ cwd, args, files, columns }) {
  return send({ type: 'run', cwd, args, files, columns })
}
