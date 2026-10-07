// Workarounds for WebKit on iPhone and iPad, where every browser uses it.
//
// Every shared WebAssembly memory reserves its maximum size up front, and
// iOS and iPadOS let a page reserve only about 4 to 6 GiB of them in all
// (three of 4 GiB, ten of 512 MiB or 34 of 128 MiB, against fifteen 4 GiB
// ones in Safari on a Mac). The Wasmer SDK reserves 4 GiB for itself and
// 2 GiB for every process, as their programs declare, and an exited
// process's memory is only released once the browser has garbage collected
// it, which can take many processes. So a fourth process failed with "Out of
// memory" in its worker and the terminal hung. See docs/plans/ios.md.

/** The SDK's own memory, reserved once by the page: 512 MiB. */
export const APPLE_MOBILE_RUNTIME_PAGES = 8192
/** Each program's memory, reserved in the SDK's workers: 64 MiB. */
export const APPLE_MOBILE_PROGRAM_PAGES = 1024
/** Don't shrink a reservation below this while retrying: 16 MiB. */
const MIN_PAGES = 256

/** True on an iPhone or iPad, including iPad Safari asking for desktop pages. */
export function isAppleMobile(navigator = globalThis.navigator) {
  if (!navigator) return false
  const agent = navigator.userAgent ?? ''
  return /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)
}

/**
 * Make `webAssembly.Memory` reserve at most `maxPages` (64 KiB each) for
 * shared memories, retrying with half the size while the browser is out of
 * address space: a program with less memory is better than one that never
 * starts. A program that needs more fails with its own out-of-memory error.
 */
export function capSharedMemories(webAssembly, maxPages) {
  const NativeMemory = webAssembly.Memory
  if (NativeMemory.opcodeCapped) return
  function Memory(descriptor) {
    if (!descriptor?.shared || !(descriptor.maximum > maxPages)) return new NativeMemory(descriptor)
    const floor = Math.max(descriptor.initial ?? 0, MIN_PAGES)
    let maximum = Math.max(maxPages, descriptor.initial ?? 0)
    for (;;) {
      try {
        return new NativeMemory({ ...descriptor, maximum })
      } catch (error) {
        if (!(error instanceof RangeError) || Math.floor(maximum / 2) < floor) throw error
        maximum = Math.floor(maximum / 2)
      }
    }
  }
  Memory.prototype = NativeMemory.prototype
  Memory.opcodeCapped = true
  webAssembly.Memory = Memory
}
