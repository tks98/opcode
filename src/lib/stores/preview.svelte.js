// The web preview: shows a server a program started in a project's sandbox
// (python3 -m http.server, php -S, a Node or Flask app...). Requests from the
// preview frame go through a service worker on a separate "HTTP host" origin
// into the sandbox (see the Wasmer SDK's ports.expose()). A host serves one
// server per origin (its service worker is shared by all tabs), so:
//
// - with one host origin (the default, Wasmer's), there is one preview at a
//   time;
// - with a wildcard host (https://*.preview.example.com/), every server gets
//   its own address and several can be previewed and opened at once.

import { sessionStore } from './sessions.svelte.js'
import { linuxStore } from './linux.svelte.js'
import { describeError } from '../runtime/wasmer.js'
import { siteConfig } from '../siteConfig.js'

/** The HTTP host origin(s), from config.js or the build. Self-hosting: see docs/deploying.md ("Web preview host"). */
export const PREVIEW_HOST = siteConfig.previewHost || import.meta.env.VITE_PREVIEW_HOST || 'https://default.local.wasmer.site/'
export const PER_SERVER_HOSTS = PREVIEW_HOST.includes('*')

/** A host origin for one server: the wildcard filled in with its name. */
export function previewHostFor(name, host = PREVIEW_HOST) {
  return host.replace('*', name)
}

// DNS-safe and hard to guess: a server's address works for whoever has it
// while its tab is open.
function newServerName() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `p${[...bytes].map((byte) => (byte % 36).toString(36)).join('')}`
}

const keyOf = (projectId, port) => `${projectId}:${port}`

class PreviewStore {
  visible = $state(false)
  projectId = $state(null)
  port = $state(null)
  path = $state('/')
  url = $state(null) // root URL of the exposed server
  status = $state('idle') // idle | connecting | ready | stopped | error
  error = $state(null)
  reloads = $state(0)
  plots = $state(null) // R's plots instead of a server: { urls (of PNG images), index }

  #attempt = 0
  #seen = new Map() // projectId -> ports already announced
  #routes = new Map() // `${projectId}:${port}` -> { server, url }: live routes into sandboxes
  #names = new Map() // same keys -> host name (per-server hosts), kept for the visit
  #queue = Promise.resolve() // a single host's connections, one at a time

  /** The page shown in the preview frame. */
  get src() {
    return this.status === 'ready' && this.url ? previewUrl(this.url, this.path) : null
  }

  /** Show a project's server (and optionally a page of it). */
  async show(projectId, port, path) {
    this.#clearPlots()
    this.visible = true
    if (path !== undefined) this.path = path
    if (this.projectId === projectId && this.port === port && (this.status === 'ready' || this.status === 'connecting')) {
      this.reload()
      return
    }
    this.projectId = projectId
    this.port = port
    if (path === undefined) this.path = '/'
    await this.#connect()
  }

  navigate(path) {
    this.path = path.startsWith('/') ? path : `/${path}`
    this.reload()
  }

  reload() {
    this.reloads++
  }

  /** Show plots (PNG images, the last one first) in place of a server. */
  showPlots(projectId, images) {
    this.#clearPlots()
    this.#attempt++
    this.projectId = projectId
    this.port = null
    this.status = 'idle'
    this.url = null
    const urls = images.map((bytes) => URL.createObjectURL(new Blob([bytes], { type: 'image/png' })))
    this.plots = { urls, index: urls.length - 1 }
    this.visible = true
  }

  showPlot(index) {
    if (this.plots) this.plots = { ...this.plots, index: Math.max(0, Math.min(this.plots.urls.length - 1, index)) }
  }

  #clearPlots() {
    for (const url of this.plots?.urls ?? []) URL.revokeObjectURL(url)
    this.plots = null
  }

  async hide() {
    this.#clearPlots()
    this.visible = false
    this.#attempt++
    this.status = 'idle'
    this.url = null
    // A single host can only route one server; per-server routes stay open
    // (their addresses keep working, e.g. in another tab).
    if (!PER_SERVER_HOSTS) await this.#closeRoutes(() => true)
  }

  /**
   * A project's listening ports changed: open the preview for a new server,
   * and follow the shown one as it stops and starts again.
   */
  serversChanged(projectId, ports, { announce = true } = {}) {
    let seen = this.#seen.get(projectId)
    if (!seen) this.#seen.set(projectId, (seen = new Set()))
    const added = ports.filter((port) => !seen.has(port))
    for (const port of seen) if (!ports.includes(port)) seen.delete(port)
    for (const port of added) seen.add(port)
    // Routes to servers that stopped are dead; a restarted server gets a new one.
    this.#closeRoutes((key) => key.startsWith(`${projectId}:`) && !ports.includes(Number(key.slice(projectId.length + 1))))

    if (projectId === this.projectId && this.visible) {
      if (ports.includes(this.port)) {
        if (this.status === 'stopped' || this.status === 'error') this.#connect()
        return
      }
      if (this.status === 'ready' || this.status === 'connecting') {
        this.#attempt++
        this.status = 'stopped'
        this.url = null
      }
    }
    // A server that just started is what the student wants to see, unless
    // the preview already shows a live one.
    if (announce && added.length && !(this.visible && this.status === 'ready')) this.show(projectId, added[0])
  }

  /** The project's terminal session went away. */
  sessionClosed(projectId) {
    this.#seen.delete(projectId)
    this.#closeRoutes((key) => key.startsWith(`${projectId}:`))
    if (projectId === this.projectId) this.hide()
  }

  async #connect() {
    const attempt = ++this.#attempt
    const { projectId, port } = this
    const key = keyOf(projectId, port)
    const route = this.#routes.get(key)
    if (route) {
      this.url = route.url
      this.status = 'ready'
      this.error = null
      this.reload()
      return
    }
    this.url = null
    // A terminal project's sandbox, or a Linux project's machine.
    const session = sessionStore.get(projectId) ?? linuxStore.get(projectId)
    if (!session) {
      this.status = 'stopped'
      return
    }
    // Before any wait: a show() of the same server meanwhile joins this one.
    this.status = 'connecting'
    this.error = null
    // A single host routes one server at a time, so connections take turns,
    // each closing the last route before exposing its server.
    const done = PER_SERVER_HOSTS ? null : await this.#turn()
    try {
      if (attempt !== this.#attempt) return
      let host = PREVIEW_HOST
      if (PER_SERVER_HOSTS) {
        if (!this.#names.has(key)) this.#names.set(key, newServerName())
        host = previewHostFor(this.#names.get(key))
      } else {
        await this.#closeRoutes(() => true)
      }
      const server = await session.exposePort(port, host)
      if (attempt !== this.#attempt && !PER_SERVER_HOSTS) {
        await server.close().catch(() => {})
        return
      }
      this.#routes.set(key, { server, url: server.url.href })
      if (attempt !== this.#attempt) return // shown later, if asked for
      this.url = server.url.href
      this.status = 'ready'
      this.reload()
    } catch (error) {
      if (attempt !== this.#attempt) return
      console.warn('Preview failed:', error)
      this.status = 'error'
      this.error = /already exposes another/.test(error?.message)
        ? 'Another Opcode tab is showing a preview. Close that preview (or tab), then press Retry.'
        : describeError(error)
    } finally {
      done?.()
    }
  }

  /** Waits for the single host to be free; returns the function that frees it. */
  async #turn() {
    const previous = this.#queue
    let done
    this.#queue = new Promise((resolve) => (done = resolve))
    await previous
    return done
  }

  async retry() {
    if (this.projectId !== null && this.port !== null) await this.#connect()
  }

  async #closeRoutes(match) {
    const closing = []
    for (const [key, route] of this.#routes) {
      if (!match(key)) continue
      this.#routes.delete(key)
      closing.push(route.server.close().catch(() => {}))
    }
    await Promise.all(closing)
  }
}

export const previewStore = new PreviewStore()

/**
 * A path of a previewed server as a URL on its origin, or null. The path can
 * come from a link a program printed, so it must never leave that origin:
 * resolved as a URL, `/javascript:…` or `/https://elsewhere` would replace it,
 * and the preview frame shares the app's origin until it navigates.
 */
export function previewUrl(serverUrl, path) {
  const base = new URL(serverUrl)
  try {
    const url = new URL(base.origin + base.pathname.replace(/\/*$/, '/') + path.replace(/^[/\\]+/, ''))
    return url.origin === base.origin ? url.href : null
  } catch {
    return null
  }
}

/** A link to a server on localhost, as programs print them. */
export function parseLocalUrl(text) {
  const match = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d+))?(\/[^\s]*)?$/i.exec(text)
  if (!match) return null
  return { port: Number(match[1] ?? 80), path: match[2] ?? '/' }
}
