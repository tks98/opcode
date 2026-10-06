// Main-thread client for the Clang worker (clang.worker.js).

let worker = null
let nextId = 1
const pending = new Map()
let prepared = null

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./clang.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id)
      if (!request) return
      if (data.type === 'progress') {
        request.onProgress?.(data)
        return
      }
      pending.delete(data.id)
      if (data.type === 'error') request.reject(new Error(data.message))
      else request.resolve(data)
    }
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The C/C++ compiler crashed')
      for (const request of pending.values()) request.reject(error)
      pending.clear()
      worker = null
      prepared = null
    }
  }
  return worker
}

function send(message, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, onProgress })
    getWorker().postMessage({ ...message, id })
  })
}

function toProgress(label, { doneLength, totalLength }) {
  return {
    label,
    phase: doneLength >= totalLength ? 'loading' : 'downloading',
    percent: totalLength ? (100 * doneLength) / totalLength : null,
    downloadedBytes: doneLength,
    totalBytes: totalLength,
  }
}

export function isCompilerReady() {
  return prepared !== null && prepared.done === true
}

/** Download and initialise Clang. Safe to call repeatedly. */
export function prepareCompiler(label, onProgress) {
  if (!prepared) {
    const listeners = new Set()
    const promise = send({ type: 'prepare' }, (event) => {
      for (const listener of listeners) listener(toProgress(label, event))
    }).then(
      () => {
        prepared.done = true
      },
      (error) => {
        prepared = null
        throw error
      },
    )
    prepared = { promise, listeners, done: false }
  }
  if (onProgress) prepared.listeners.add(onProgress)
  const { promise, listeners } = prepared
  return promise.finally(() => listeners.delete(onProgress))
}

/**
 * Compile with YoWASP Clang. `files` is a nested tree of Uint8Array file
 * contents. Resolves to { code, output, files } where `files` is the tree
 * after the compiler ran (outputs included).
 */
export function compile({ tool, args, files }) {
  return send({ type: 'compile', tool, args, files })
}
