// Serves the Wasmer packages Opcode runs from this site instead of Wasmer's
// registry. To load `wasmer/bash@=1.0.25`, the SDK asks registry.wasmer.io
// which versions exist (and, for each package it depends on, which version
// to use), then downloads the chosen one from cdn.wasmer.io. Both requests
// are answered here from public/wasmer/ (scripts/wasmer-packages.mjs): the
// registry's answers as they were locked, and the packages themselves. So the
// terminals work while wasmer.io is down, and run exactly the locked
// versions. Packages not in the lock, and builds without the mirror, go to
// Wasmer as before.

const REGISTRY = 'https://registry.wasmer.io/graphql'
const CDN_FILES = 'https://cdn.wasmer.io/webcimages/'
// After a failed load of the mirror (offline, a 5xx), how long requests go to
// Wasmer before it is tried again.
export const MIRROR_RETRY_MS = 5000

/** Answer the SDK's registry and package requests from `wasmer/` under `base`. */
export function installWasmerMirror(scope = globalThis, base = scope.document?.baseURI ?? scope.location.href) {
  if (scope.fetch.opcodeMirror) return
  const realFetch = scope.fetch.bind(scope)
  // The registry, or null for a build without the mirror. Only a definite
  // answer is kept: a failure is tried again later, so one dropped request
  // doesn't send the rest of the session to Wasmer unpinned.
  let mirror = null
  let failedAt = -Infinity
  const loadMirror = () => {
    if (mirror) return mirror
    if (Date.now() - failedAt < MIRROR_RETRY_MS) return Promise.resolve(null)
    return (mirror = realFetch(new URL('wasmer/registry.json', base))
      .then(async (response) => {
        // Not there: this build has no mirror (supported), so don't ask again.
        if (response.status === 404 || response.status === 410) return null
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        // Something other than JSON is a host's fallback page: no mirror either.
        const registry = await response.json().catch(() => null)
        return registry?.packages ? { ...registry, files: new Set(Object.values(registry.packages).flatMap(fileNames)) } : null
      })
      .catch(() => {
        mirror = null
        failedAt = Date.now()
        return null
      }))
  }

  async function mirroredFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    if (url === REGISTRY) {
      const request = new Request(input, init)
      const name = packageAsked(await request.clone().text())
      const registry = await loadMirror()
      const answer = name && registry?.packages[name]
      if (answer) return Response.json({ data: { getPackage: answer, info: registry.info } })
      return realFetch(request)
    }
    if (url?.startsWith(CDN_FILES)) {
      const file = url.slice(CDN_FILES.length).split(/[?#]/)[0]
      if ((await loadMirror())?.files.has(file)) {
        const local = await realFetch(new URL(`wasmer/${file}`, base)).catch(() => null)
        if (local?.ok) return local
      }
    }
    return realFetch(input, init)
  }
  mirroredFetch.opcodeMirror = true
  scope.fetch = mirroredFetch
}

/** The package a registry query asks for: getPackage(name: "wasmer/bash"). */
export function packageAsked(body) {
  try {
    return JSON.parse(body).query?.match(/getPackage\s*\(\s*name\s*:\s*"([^"]+)"/)?.[1] ?? null
  } catch {
    return null
  }
}

// The file names a registry answer points at (the CDN names files by checksum).
function fileNames(answer) {
  return answer.versions.flatMap((version) =>
    [version.v2, version.v3].map((distribution) => distribution?.piritaDownloadUrl?.split('/').pop()).filter(Boolean),
  )
}
