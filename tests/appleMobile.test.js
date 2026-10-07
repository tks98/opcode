import { describe, expect, it } from 'vitest'
import { APPLE_MOBILE_PROGRAM_PAGES, APPLE_MOBILE_RUNTIME_PAGES, capSharedMemories, isAppleMobile } from '../src/lib/runtime/appleMobile.js'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15'
const CHROME_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

describe('isAppleMobile', () => {
  it('recognizes iPhones and iPads, including iPads asking for desktop pages', () => {
    expect(isAppleMobile({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(true)
    expect(isAppleMobile({ userAgent: MAC, maxTouchPoints: 5 })).toBe(true)
  })

  it('leaves Macs and other computers alone', () => {
    expect(isAppleMobile({ userAgent: MAC, maxTouchPoints: 0 })).toBe(false)
    expect(isAppleMobile({ userAgent: CHROME_LINUX, maxTouchPoints: 0 })).toBe(false)
    expect(isAppleMobile(undefined)).toBe(false)
  })
})

// A stand-in for WebAssembly.Memory that records what it was asked for and
// fails above `limit` pages, like iOS once its address space is used up.
function fakeWebAssembly(limit = Infinity) {
  const requested = []
  function Memory(descriptor) {
    requested.push(descriptor.maximum)
    if (descriptor.shared && descriptor.maximum > limit) throw new RangeError('Out of memory')
    this.descriptor = descriptor
  }
  return { webAssembly: { Memory }, requested }
}

describe('capSharedMemories', () => {
  it('caps the maximum of shared memories only', () => {
    const { webAssembly } = fakeWebAssembly()
    capSharedMemories(webAssembly, APPLE_MOBILE_RUNTIME_PAGES)
    expect(new webAssembly.Memory({ initial: 25, maximum: 65536, shared: true }).descriptor.maximum).toBe(APPLE_MOBILE_RUNTIME_PAGES)
    expect(new webAssembly.Memory({ initial: 133, maximum: 2048, shared: true }).descriptor.maximum).toBe(2048)
    expect(new webAssembly.Memory({ initial: 1, maximum: 65536 }).descriptor.maximum).toBe(65536)
  })

  it('never asks for less than the initial size', () => {
    const { webAssembly } = fakeWebAssembly()
    capSharedMemories(webAssembly, APPLE_MOBILE_PROGRAM_PAGES)
    expect(new webAssembly.Memory({ initial: 2000, maximum: 32767, shared: true }).descriptor.maximum).toBe(2000)
  })

  it('retries with half the size when the browser is out of memory', () => {
    const { webAssembly, requested } = fakeWebAssembly(300)
    capSharedMemories(webAssembly, APPLE_MOBILE_PROGRAM_PAGES)
    expect(new webAssembly.Memory({ initial: 133, maximum: 32767, shared: true }).descriptor.maximum).toBe(256)
    expect(requested).toEqual([1024, 512, 256])
  })

  it('gives up below 16 MiB and keeps instanceof working', () => {
    const { webAssembly } = fakeWebAssembly(200)
    const NativeMemory = webAssembly.Memory
    capSharedMemories(webAssembly, APPLE_MOBILE_PROGRAM_PAGES)
    capSharedMemories(webAssembly, APPLE_MOBILE_PROGRAM_PAGES)
    expect(() => new webAssembly.Memory({ initial: 133, maximum: 32767, shared: true })).toThrow(RangeError)
    expect(new webAssembly.Memory({ initial: 1, maximum: 100, shared: true })).toBeInstanceOf(NativeMemory)
    expect(new webAssembly.Memory({ initial: 1, maximum: 100, shared: true })).toBeInstanceOf(webAssembly.Memory)
  })
})
