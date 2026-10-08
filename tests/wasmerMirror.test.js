import { describe, expect, it } from 'vitest'
import { installWasmerMirror, packageAsked } from '../src/lib/runtime/wasmerMirror.js'

const query = (name) => JSON.stringify({ query: `{\n getPackage(name: "${name}") { packageName }\n info { defaultFrontend } }` })
const bash = {
  packageName: 'bash',
  namespace: 'wasmer',
  versions: [{ version: '1.0.25', isArchived: false, v2: null, v3: { piritaDownloadUrl: 'https://cdn.wasmer.io/webcimages/abc.webc' } }],
}

// A page whose own fetch knows the site's files and records what leaves it.
function page(files) {
  const outside = []
  const scope = {
    location: { href: 'https://opcode.example/app/' },
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url in files) return new Response(files[url])
      if (url.startsWith('https://opcode.example/')) return new Response('', { status: 404 })
      outside.push(url)
      return new Response('from wasmer')
    },
  }
  installWasmerMirror(scope)
  return { scope, outside }
}

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
})
