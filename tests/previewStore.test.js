import { describe, expect, it, vi } from 'vitest'

// Sandboxes whose exposePort() behaves like a single preview host's service
// worker: it refuses a second server while one is exposed.
const sandboxes = new Map()
vi.mock('../src/lib/stores/sessions.svelte.js', () => ({ sessionStore: { get: (id) => sandboxes.get(id) } }))
vi.mock('../src/lib/stores/linux.svelte.js', () => ({ linuxStore: { get: () => undefined } }))

const { previewStore, PER_SERVER_HOSTS } = await import('../src/lib/stores/preview.svelte.js')

let exposed = null
let exposures = 0
function sandbox() {
  return {
    async exposePort(port) {
      exposures++
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (exposed !== null) throw new Error('this service worker already exposes another guest server')
      exposed = port
      return {
        url: new URL(`https://preview.example/p${port}/`),
        async close() {
          if (exposed === port) exposed = null
        },
      }
    },
  }
}

describe('the preview with a single host', () => {
  it('is what the tests run with', () => expect(PER_SERVER_HOSTS).toBe(false))

  it('connects once when a new server and Run both ask to show it', async () => {
    sandboxes.set('p1', sandbox())
    // As App does: the server is announced, and Run's page opens.
    previewStore.serversChanged('p1', [8080])
    await previewStore.show('p1', 8080, '/index.html')
    await vi.waitFor(() => expect(previewStore.status).toBe('ready'))
    expect(exposures).toBe(1)
    expect(previewStore.src).toBe('https://preview.example/p8080/index.html')
  })

  it('closes the last server before showing the next, when switching quickly', async () => {
    previewStore.serversChanged('p1', [8080, 8001, 8002], { announce: false })
    previewStore.show('p1', 8001)
    previewStore.show('p1', 8002)
    await vi.waitFor(() => expect(previewStore.status).toBe('ready'))
    expect(previewStore.error).toBe(null)
    expect(previewStore.url).toBe('https://preview.example/p8002/')
    expect(exposed).toBe(8002)
  })
})
