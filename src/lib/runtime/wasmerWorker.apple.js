// Starts one of the Wasmer SDK's workers on an iPhone or iPad (see
// appleMobile.js and installAppleMobileWorkarounds in wasmer.js). The SDK's
// own worker script is in this URL's fragment.
//
// Programs' memories are created here, so they get the smaller cap. And two
// workers that load the SDK's script directly at the same instant can fail
// on iOS before running any of it, so it is loaded with import() instead.
// Messages that arrive while it loads are replayed afterwards.

import { APPLE_MOBILE_PROGRAM_PAGES, capSharedMemories } from './appleMobile.js'

capSharedMemories(WebAssembly, APPLE_MOBILE_PROGRAM_PAGES)

const early = []
self.onmessage = (event) => early.push(event)
try {
  await import(/* @vite-ignore */ decodeURIComponent(self.location.hash.slice(1)))
} catch (error) {
  console.error('Could not load the Wasmer SDK worker:', error)
  throw error
}
// The SDK's script has replaced onmessage with its own handler.
for (const event of early) self.dispatchEvent(new MessageEvent('message', { data: event.data }))
