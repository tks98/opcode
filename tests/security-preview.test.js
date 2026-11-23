import { describe, expect, it, vi } from 'vitest'

// A deployment whose preview host is the app's own origin.
globalThis.OPCODE_CONFIG = { previewHost: 'https://opcode.example/' }
vi.stubGlobal('location', { origin: 'https://opcode.example', href: 'https://opcode.example/' })

let exposures = 0
const sandbox = {
  async exposePort() {
    exposures++
    return { url: new URL('https://opcode.example/'), async close() {} }
  },
}
vi.mock('../src/lib/stores/sessions.svelte.js', () => ({ sessionStore: { get: () => sandbox } }))
vi.mock('../src/lib/stores/linux.svelte.js', () => ({ linuxStore: { get: () => undefined } }))

const { previewHostProblem, previewStore, PREVIEW_HOST } = await import('../src/lib/stores/preview.svelte.js')

describe('previewHostProblem', () => {
  it('refuses the page\'s own origin, wildcard filled in', () => {
    expect(previewHostProblem('https://opcode.example/', 'https://opcode.example')).toMatch(/own address/)
    expect(previewHostProblem('https://opcode.example/*', 'https://opcode.example')).toMatch(/own address/)
    expect(previewHostProblem('https://opcode.example:443/', 'https://opcode.example')).toMatch(/own address/)
  })

  it('takes a separate origin', () => {
    expect(previewHostProblem('https://preview.opcode.example/', 'https://opcode.example')).toBeNull()
    expect(previewHostProblem('https://*.preview.opcode.example/', 'https://opcode.example')).toBeNull()
    expect(previewHostProblem('http://opcode.example/', 'https://opcode.example')).toBeNull()
    expect(previewHostProblem('https://opcode.example:8443/', 'https://opcode.example')).toBeNull()
  })

  it('explains an address that is not one', () => {
    expect(previewHostProblem('not a url', 'https://opcode.example')).toMatch(/not a valid address/)
  })
})

describe('the preview with the app\'s own origin as its host', () => {
  it('stays off with an explanation, and never exposes a server', async () => {
    expect(PREVIEW_HOST).toBe('https://opcode.example/')
    await previewStore.show('p1', 8000)
    expect(previewStore.status).toBe('error')
    expect(previewStore.error).toMatch(/own address/)
    expect(previewStore.src).toBeNull()
    expect(exposures).toBe(0)
  })
})
