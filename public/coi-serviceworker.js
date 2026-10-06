// Fallback for static hosts that cannot send custom headers (e.g. GitHub
// Pages). Opcode's WebAssembly runtime needs SharedArrayBuffer, which
// browsers only enable on cross-origin isolated pages. This service worker
// adds the isolation headers to every response; index.html registers it
// only when the page is not already isolated.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const request = event.request
  // Only the app's own responses need the headers; cross-origin downloads
  // (Wasmer registry and CDN) are CORS requests the browser handles itself.
  if (new URL(request.url).origin !== self.location.origin) return
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return

  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response
      const headers = new Headers(response.headers)
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }),
  )
})
