// R in the browser: webR, served from public/toolchains/webr/ (copied there
// by scripts/copy-npm-toolchains.mjs), driven by rlang.js.

import { createR } from './rlang.js'

const BASE = 'toolchains/webr/'

let prepared = null

function baseUrl() {
  return new URL(BASE, document.baseURI).href
}

export function isRReady() {
  return prepared?.done === true
}

/**
 * Load webR and start one R, which fetches and compiles R itself (~20 MB the
 * first time). Resolves to the runner (see rlang.js). Safe to call repeatedly.
 */
export function prepareR(label, onProgress) {
  if (!prepared) {
    onProgress?.({ label, phase: 'loading', percent: null })
    const promise = import(/* @vite-ignore */ `${baseUrl()}webr.js`)
      .then(async ({ WebR }) => {
        const runner = createR(WebR, baseUrl())
        // A first run downloads and compiles R; later ones come from the cache.
        await runner.runScript({ cwd: '/workspace', expression: 'invisible(NULL)' })
        prepared.done = true
        return runner
      })
      .catch((error) => {
        prepared = null
        throw error
      })
    prepared = { promise, done: false }
  }
  return prepared.promise
}
