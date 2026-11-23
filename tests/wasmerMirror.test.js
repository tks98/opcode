import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIRROR_RETRY_MS, installWasmerMirror, packageAsked } from '../src/lib/runtime/wasmerMirror.js'

const query = (name) => JSON.stringify({ query: `{\n getPackage(name: "${name}") { packageName }\n info { defaultFrontend } }` })
const bash = {
  packageName: 'bash',
  namespace: 'wasmer',
  versions: [{ version: '1.0.25', isArchived: false, v2: null, v3: { piritaDownloadUrl: 'https://cdn.wasmer.io/webcimages/abc.webc' } }],
}

// A page whose own fetch knows the site's files and records what leaves it.
// A file can be a function, called for each request, to fail some of them.
function page(files) {
  const outside = []
  const site = []
  const scope = {
    location: { href: 'https://opcode.example/app/' },
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('https://opcode.example/')) site.push(url)
      if (url in files) return typeof files[url] === 'function' ? files[url]() : new Response(files[url])
      if (url.startsWith('https://opcode.example/')) return new Response('', { status: 404 })
      outside.push(url)
      return new Response('from wasmer')
    },
  }
  installWasmerMirror(scope)
  return { scope, outside, site }
}

const askBash = (scope) => scope.fetch('https://registry.wasmer.io/graphql', { method: 'POST', body: query('wasmer/bash') })
const REGISTRY_JSON = 'https://opcode.example/app/wasmer/registry.json'

const mirror = {
  'https://opcode.example/app/wasmer/registry.json': JSON.stringify({ info: { defaultFrontend: 'x' }, packages: { 'wasmer/bash': bash } }),
  'https://opcode.example/app/wasmer/abc.webc': 'local bytes',
}

describe('packageAsked', () => {
  it('reads the package from a registry query', () => {
    expect(packageAsked(query('wasmer/coreutils'))).toBe('wasmer/coreutils')
    expect(packageAsked('not json')).toBe(null)
  })
})

describe('the Wasmer mirror', () => {
  it('answers registry queries and downloads from the site', async () => {
    const { scope, outside } = page(mirror)
    const answer = await (await scope.fetch('https://registry.wasmer.io/graphql', { method: 'POST', body: query('wasmer/bash') })).json()
    expect(answer).toEqual({ data: { getPackage: bash, info: { defaultFrontend: 'x' } } })
    expect(await (await scope.fetch('https://cdn.wasmer.io/webcimages/abc.webc')).text()).toBe('local bytes')
    expect(outside).toEqual([])
  })

  it('leaves packages it does not have to Wasmer', async () => {
    const { scope, outside } = page(mirror)
    await scope.fetch(new Request('https://registry.wasmer.io/graphql', { method: 'POST', body: query('wasmer/vim') }))
    await scope.fetch('https://cdn.wasmer.io/webcimages/other.webc')
    expect(outside).toEqual(['https://registry.wasmer.io/graphql', 'https://cdn.wasmer.io/webcimages/other.webc'])
  })

  it('goes to Wasmer when the build has no mirror', async () => {
    const { scope, outside } = page({})
    await scope.fetch('https://registry.wasmer.io/graphql', { method: 'POST', body: query('wasmer/bash') })
    await scope.fetch('https://cdn.wasmer.io/webcimages/abc.webc')
    expect(outside).toHaveLength(2)
  })

  it('asks for a missing mirror only once', async () => {
    const { scope, site } = page({})
    for (let i = 0; i < 3; i++) await askBash(scope)
    expect(site.filter((url) => url === REGISTRY_JSON)).toHaveLength(1)
  })

  it('takes a page served in place of registry.json as no mirror', async () => {
    const { scope, site, outside } = page({ [REGISTRY_JSON]: '<!doctype html><title>Opcode</title>' })
    for (let i = 0; i < 3; i++) await askBash(scope)
    expect(site.filter((url) => url === REGISTRY_JSON)).toHaveLength(1)
    expect(outside).toHaveLength(3)
  })

  describe('after a failed load', () => {
    afterEach(() => vi.useRealTimers())

    for (const [failure, fail] of [
      ['a server error', () => new Response('', { status: 503 })],
      ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ]) {
      it(`tries the mirror again after ${failure}`, async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        let failing = true
        const { scope, outside, site } = page({ ...mirror, [REGISTRY_JSON]: () => (failing ? fail() : new Response(mirror[REGISTRY_JSON])) })
        await askBash(scope)
        expect(outside).toEqual(['https://registry.wasmer.io/graphql'])
        // Within the backoff, Wasmer answers without another try.
        failing = false
        await askBash(scope)
        expect(site.filter((url) => url === REGISTRY_JSON)).toHaveLength(1)
        expect(outside).toHaveLength(2)
        // Then the mirror is tried again, and kept.
        vi.setSystemTime(Date.now() + MIRROR_RETRY_MS)
        expect(await (await askBash(scope)).json()).toEqual({ data: { getPackage: bash, info: { defaultFrontend: 'x' } } })
        await askBash(scope)
        expect(site.filter((url) => url === REGISTRY_JSON)).toHaveLength(2)
        expect(outside).toHaveLength(2)
      })
    }
  })
})
