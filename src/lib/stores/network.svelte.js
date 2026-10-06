// Internet access for terminals and Linux machines. Browsers can't open TCP
// connections, so both tunnel them over a WebSocket to a Wisp relay
// (scripts/wisp-server.mjs), which also answers their DNS lookups. The relay
// comes from the site's settings (config.js), the build (VITE_WISP_URL) or the
// Internet settings, saved in this browser; without one there is no internet
// access.

import { siteConfig } from '../siteConfig.js'

const STORAGE_KEY = 'opcode-relay'

/**
 * The relay config.js gives (an address, or a path on this site such as
 * `/wisp/`) as a ws(s):// address; undefined if it gives none (or a bad one).
 */
export function siteRelay(value, base = globalThis.document?.baseURI) {
  if (typeof value !== 'string') return undefined
  try {
    if (!value.startsWith('/')) return normalizeRelay(value)
    const url = new URL(value, base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.href
  } catch (error) {
    console.warn(`Ignoring the relay in config.js: ${error.message}`)
    return undefined
  }
}

export const DEFAULT_RELAY = siteRelay(siteConfig.relay) ?? (import.meta.env.VITE_WISP_URL || '')

function readSetting() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (saved && typeof saved.relay === 'string') return saved.relay
  } catch {
    // No saved setting.
  }
  return null
}

/** A relay address as entered: ws(s)://host[:port][/path]. Throws if invalid. */
export function normalizeRelay(text) {
  const value = text.trim()
  if (!value) return ''
  let url
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `wss://${value}`)
  } catch {
    throw new Error('Enter a relay address such as wss://relay.example.com/')
  }
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('The relay address must start with wss:// (or ws:// for a local relay).')
  return url.href
}

/** The relay's DNS-over-HTTPS endpoint (see scripts/wisp-server.mjs). */
export function relayDnsUrl(relay) {
  const url = new URL(relay)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/dns-query'
  url.search = ''
  return url.href
}

/** v86 names relays wisp:// and wisps://. */
export function v86RelayUrl(relay) {
  return relay.replace(/^ws(s?):\/\//, 'wisp$1://')
}

/** v86 asks https://<server>/dns-query, so only a wss:// relay can answer. */
export function v86DohServer(relay) {
  const url = new URL(relay)
  return url.protocol === 'wss:' ? url.host : undefined
}

class NetworkSettings {
  #saved = $state(readSetting()) // null: use the default

  /** The relay in use, or '' for no internet access. */
  get relay() {
    return this.#saved ?? DEFAULT_RELAY
  }

  get enabled() {
    return Boolean(this.relay)
  }

  /** Use a relay ('' turns internet access off). Applies to terminals and machines started afterwards. */
  setRelay(text) {
    const relay = normalizeRelay(text)
    this.#saved = relay
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ relay }))
    } catch {
      // Not remembered, but used for this visit.
    }
  }

  /** Go back to the site's default relay. */
  useDefault() {
    this.#saved = null
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Nothing saved.
    }
  }
}

export const networkSettings = new NetworkSettings()

/** Check that a relay answers the Wisp handshake. Resolves with the time taken (ms). */
export function testRelay(relay, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    let socket
    try {
      socket = new WebSocket(normalizeRelay(relay))
    } catch (error) {
      reject(error)
      return
    }
    socket.binaryType = 'arraybuffer'
    const timer = setTimeout(() => finish(new Error('The relay did not answer.')), timeoutMs)
    const finish = (error) => {
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else resolve(Math.round(performance.now() - started))
    }
    // A Wisp server greets with CONTINUE (type 3) for stream 0, or INFO (5).
    socket.onmessage = (event) => {
      const type = new Uint8Array(event.data)[0]
      finish(type === 3 || type === 5 ? null : new Error('That address is not a Wisp relay.'))
    }
    socket.onerror = () => finish(new Error('Could not connect to the relay.'))
  })
}
