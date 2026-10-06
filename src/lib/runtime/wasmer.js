// The single Wasmer client shared by every project sandbox. The SDK (and its
// ~6 MB runtime) is imported lazily so the editor loads without it.

let clientPromise = null

function importSdk() {
  if (import.meta.env.DEV) return import('@wasmer/sdk')
  // Production builds ship the SDK unbundled (see vite.config.js).
  return import(/* @vite-ignore */ new URL('wasmer-sdk/dist/index.js', document.baseURI).href)
}

export class EnvironmentError extends Error {}

/** Explain why this browser cannot run the WASIX runtime, or null. */
export function environmentProblem() {
  if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
    return 'This page is not cross-origin isolated, so the terminal cannot start. ' +
      'Serve Opcode with the Cross-Origin-Opener-Policy: same-origin and ' +
      'Cross-Origin-Embedder-Policy: require-corp headers (see docs/deploying.md), or reload the page.'
  }
  if (typeof WebAssembly === 'undefined') return 'This browser does not support WebAssembly.'
  return null
}

export function getWasmer() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const problem = environmentProblem()
      if (problem) throw new EnvironmentError(problem)
      const { Wasmer } = await importSdk()
      const client = new Wasmer()
      await client.ready()
      return client
    })().catch((error) => {
      clientPromise = null
      throw error
    })
  }
  return clientPromise
}

/** Turn SDK and network failures into messages a learner can act on. */
export function describeError(error) {
  const message = error?.message || String(error)
  if (error instanceof EnvironmentError) return message
  if (/fetch|network|Failed to load|NetworkError|ERR_/i.test(message) || error?.code === 'PACKAGE_LOAD_FAILED') {
    return `${message}\nCheck your internet connection (and any ad or script blockers), then try again.`
  }
  return message
}
