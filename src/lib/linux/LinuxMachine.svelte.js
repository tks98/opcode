// A real Linux computer for one project: Alpine Linux on the v86 x86
// emulator (see toolchains/linux). Machines start from a snapshot taken
// right after boot, so they are ready in a second or two, and each student's
// machine is saved in the browser and resumed where they left off.
//
// Implements the same terminal interface as ProjectSandbox (attach, detach,
// input, resize), so TerminalView works with either.

import { downloadBytes, formatBytes, gunzipIfNeeded } from '../runtime/toolchains.js'
import { deleteMachine, loadMachine, saveMachine } from './machineStorage.js'
import { encodeMachineFile } from './machineFile.js'
import { networkSettings, v86DohServer, v86RelayUrl } from '../stores/network.svelte.js'
import { MACHINES, recordedKind } from './machines.js'
import { exposeOnHost, fetchFromMachine } from './httpBridge.js'

const AUTOSAVE_MS = 2 * 60 * 1000
const SIGNAL_AFTER_ENTER_MS = 300 // see #pumpInput
const BIOS = 'linux/seabios.bin'
const VGA_BIOS = 'linux/vgabios.bin'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const style = {
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
}

export function welcome({ internet = false, kind = 'linux' } = {}) {
  if (kind === 'docker') {
    return (
      '\r\n  Welcome to Opcode Docker: a Linux computer with Docker, in your browser.\r\n\r\n' +
      '  * Run your first container:  docker run hello-world\r\n' +
      '  * New to Docker? Type  tutorial  for a guided introduction.\r\n' +
      '  * hello-world, alpine, busybox and nginx:alpine-slim are ready to use.\r\n' +
      (internet ? '  * It is online, so  docker pull  gets more images (32-bit x86 ones).\r\n' : '') +
      '  * You are "student" (password: student). This machine is saved in your browser.\r\n\r\n'
    )
  }
  return (
    '\r\n  Welcome to Opcode Linux: a real Linux system running in your browser.\r\n\r\n' +
    '  * You are "student" (password: student). Use sudo for admin tasks.\r\n' +
    '  * New to the terminal? Type  tutorial  for a guided introduction.\r\n' +
    '  * Read any command\'s manual with  man <command>  (for example:  man ls)\r\n' +
    (internet ? '  * It is online: try  curl -I https://example.com  or  sudo apk add python3\r\n' : '') +
    '  * This machine is saved in your browser; it stays as you leave it.\r\n\r\n'
  )
}

// The prompt a fresh machine is waiting at (PS1 in /etc/profile.d/opcode.sh).
const FRESH_PROMPT = '\x1b[1;32mstudent@opcode\x1b[0m:\x1b[1;34m~\x1b[0m$ '

const url = (path) => new URL(path, document.baseURI).href

async function gunzip(bytes) {
  const data = await gunzipIfNeeded(new Uint8Array(bytes))
  return data.buffer.byteLength === data.byteLength ? data.buffer : data.slice().buffer
}

async function gzip(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).blob()
}

const manifests = new Map() // kind -> Promise
/**
 * Describes a shipped machine: { v86, memoryMB, hardware, alpine, created,
 * snapshot, files, bytes } (older manifests have no files or bytes).
 */
export function loadManifest(kind = 'linux') {
  const path = `${MACHINES[kind].dir}/manifest.json`
  if (!manifests.has(kind)) {
    const promise = fetch(url(path))
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status})`)
        return response.json()
      })
      .catch((error) => {
        manifests.delete(kind)
        throw error
      })
    manifests.set(kind, promise)
  }
  return manifests.get(kind)
}

const pristines = new Map() // kind -> Promise, while downloading
/**
 * A freshly booted machine (gzip bytes). Downloads are kept in the browser's
 * cache (see downloadBytes), not in memory: they are big. Big snapshots come
 * in parts, joined here.
 */
function loadPristine(kind, onProgress) {
  if (!pristines.has(kind)) {
    const { dir, snapshot, downloadMB } = MACHINES[kind]
    const label = `Opcode ${MACHINES[kind].name}`
    const promise = loadManifest(kind)
      .then(async (manifest) => {
        const files = manifest.files ?? [snapshot]
        const total = manifest.bytes ?? downloadMB * 1e6
        const received = new Array(files.length).fill(0)
        const report = (index) => (progress) => {
          received[index] = progress.downloadedBytes
          const downloaded = received.reduce((sum, n) => sum + n, 0)
          onProgress?.({ label, phase: 'downloading', percent: Math.min(99, (downloaded / total) * 100), downloadedBytes: downloaded, totalBytes: total })
        }
        const parts = await Promise.all(files.map((file, index) => downloadBytes(label, `${url(`${dir}/${file}`)}?v=${manifest.snapshot ?? manifest.created}`, downloadMB / files.length, report(index))))
        if (parts.length === 1) return parts[0]
        const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
        let offset = 0
        for (const part of parts) {
          joined.set(part, offset)
          offset += part.length
        }
        return joined
      })
      .finally(() => pristines.delete(kind))
    pristines.set(kind, promise)
  }
  return pristines.get(kind)
}

export class LinuxMachine {
  status = $state('idle') // idle | loading | running | stopped | error
  progress = $state(null)
  error = $state(null)
  savedAt = $state(null) // ms timestamp of the last save
  saving = $state(false)
  offlineHardware = $state(false) // made before machines had a network card
  servers = $state([]) // ports with a server listening on every address (for the preview)

  #projectId
  #kind
  #emulator = null
  #tcpConnect = null // v86's TCP client (see vite.config.js), for the preview
  #manifest = null
  #view = null
  #pending = []
  #cols = 80
  #rows = 24
  #agentBuffer = ''
  #dirty = false
  #booting = null // a fresh boot started by a key after poweroff
  #autosaveTimer = null
  #startPromise = null
  #saveChain = Promise.resolve()
  #closed = false
  #hardware = 1 // see HARDWARE in toolchains/linux/make-state.mjs
  #onVisibility = () => {
    if (document.visibilityState === 'hidden') this.save()
  }

  constructor(projectId, kind = 'linux') {
    this.#projectId = projectId
    this.#kind = kind
  }

  get projectId() {
    return this.#projectId
  }

  /** 'linux' or 'docker' (see machines.js). */
  get kind() {
    return this.#kind
  }

  get info() {
    return MACHINES[this.#kind]
  }

  // --------------------------------------------------------------------
  // Terminal view interface
  // --------------------------------------------------------------------

  attach(view) {
    this.#view = view
    for (const chunk of this.#pending) view.write(chunk)
    this.#pending = []
  }

  detach(view) {
    if (this.#view === view) this.#view = null
  }

  #write(data) {
    if (this.#view) this.#view.write(data)
    else this.#pending.push(data)
  }

  input(data) {
    if (this.status === 'stopped') {
      // Once, however many keys arrive while it starts (each restore holds the
      // whole machine's memory).
      this.#booting ??= this.#bootFresh()
        .catch((error) => this.#fail(error))
        .finally(() => (this.#booting = null))
      return
    }
    if (this.status !== 'running') return
    this.#dirty = true
    this.#inputQueue.push(encoder.encode(data))
    this.#pumpInput()
  }

  // v86 drops console input when the guest has no receive buffer posted,
  // which loses keystrokes when typing fast or pasting. Queue input and
  // hand it over only when the guest is ready for it.
  //
  // Keys typed while the machine is busy arrive together, so Ctrl+C typed
  // just after Enter could reach the shell before it started the command
  // and miss it. Signal keys (Ctrl+C, Ctrl+Z, Ctrl+\) therefore go on their
  // own, a moment after an Enter.
  #inputQueue = []
  #pumpTimer = null
  #enterSentAt = -Infinity

  #pumpInput() {
    clearTimeout(this.#pumpTimer)
    const queue = this.#emulator?.v86?.cpu?.devices?.virtio_console?.virtio?.queues?.[0]
    const isSignal = (part) => part[0] === 3 || part[0] === 26 || part[0] === 28
    let wait = 4
    while (this.#inputQueue.length && (!queue || queue.has_request())) {
      if (isSignal(this.#inputQueue[0])) {
        const early = SIGNAL_AFTER_ENTER_MS - (performance.now() - this.#enterSentAt)
        if (early > 0) {
          wait = early
          break
        }
      }
      let size = 0
      let count = 0
      while (count < this.#inputQueue.length && size + this.#inputQueue[count].length <= 4096 && !(count > 0 && isSignal(this.#inputQueue[count]))) size += this.#inputQueue[count++].length
      count = Math.max(count, 1)
      const chunk = new Uint8Array(this.#inputQueue.slice(0, count).reduce((n, c) => n + c.length, 0))
      let offset = 0
      for (const part of this.#inputQueue.splice(0, count)) {
        chunk.set(part, offset)
        offset += part.length
      }
      this.#emulator.bus.send('virtio-console0-input-bytes', chunk)
      if (chunk.includes(13)) this.#enterSentAt = performance.now()
    }
    if (this.#inputQueue.length) this.#pumpTimer = setTimeout(() => this.#pumpInput(), wait)
  }

  resize(cols, rows) {
    this.#cols = cols
    this.#rows = rows
    // Linux learns the size through the virtio console, so full-screen
    // programs (nano, vim, htop, less) fit the terminal and get SIGWINCH.
    if (this.status === 'running') this.#emulator.bus.send('virtio-console0-resize', [cols, rows])
  }

  handleOsc() {}

  // --------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------

  start() {
    this.#startPromise ??= this.#start()
    return this.#startPromise
  }

  async #start() {
    this.status = 'loading'
    this.error = null
    try {
      this.#manifest = await loadManifest(this.#kind)
      const saved = await loadMachine(this.#projectId)
      const compatible = saved && recordedKind(saved) === this.#kind && saved.v86 === this.#manifest.v86 && saved.memoryMB === this.#manifest.memoryMB
      let state
      let hardware
      if (compatible) {
        this.progress = { label: 'your saved machine', phase: 'loading', percent: null }
        state = await gunzip(await saved.state.arrayBuffer())
        hardware = saved.hardware ?? 1
        this.savedAt = saved.savedAt
      } else {
        if (saved) this.#write(style.dim('Your saved machine was made by an older version of Opcode, so this is a fresh one.\r\n'))
        state = await gunzip(await loadPristine(this.#kind, (progress) => (this.progress = progress)))
        hardware = this.#manifest.hardware ?? 1
      }
      if (this.#closed) return
      this.progress = { label: this.info.name, phase: 'loading', percent: null }
      await this.#createEmulator(state, hardware)
      this.#resume({ fresh: !compatible })
      this.#autosaveTimer = setInterval(() => this.#dirty && this.save(), AUTOSAVE_MS)
      document.addEventListener('visibilitychange', this.#onVisibility)
    } catch (error) {
      this.#fail(error)
    } finally {
      this.progress = null
    }
  }

  // The emulated hardware must match the snapshot's (see make-state.mjs).
  // Offline, v86's fetch adapter stands in for the relay, with its fetching
  // turned off (see #createEmulator): it gives nothing internet access, but
  // the preview can still open connections into the machine.
  #networkDevice(hardware) {
    if (hardware < 2) return undefined // v86's default NE2000 card
    const relay = networkSettings.relay
    return relay ? { type: 'virtio', relay_url: v86RelayUrl(relay), doh_server: v86DohServer(relay) } : { type: 'virtio', relay_url: 'fetch' }
  }

  async #createEmulator(state, hardware) {
    const [{ V86, opcodeTcpConnect }, { default: wasmUrl }] = await Promise.all([import('v86'), import('v86/build/v86.wasm?url')])
    this.#tcpConnect = opcodeTcpConnect ?? null
    this.#hardware = hardware
    this.offlineHardware = hardware < 2
    await new Promise((resolve, reject) => {
      const emulator = new V86({
        wasm_path: wasmUrl,
        memory_size: this.#manifest.memoryMB * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        bios: { url: url(BIOS) },
        vga_bios: { url: url(VGA_BIOS) },
        initial_state: { buffer: state },
        virtio_console: true,
        net_device: this.#networkDevice(hardware),
        preserve_mac_from_state_image: true,
        autostart: true,
        disable_speaker: true,
        disable_keyboard: true,
        disable_mouse: true,
      })
      const timeout = setTimeout(() => reject(new Error('The Linux machine did not start')), 60_000)
      emulator.add_listener('emulator-started', () => {
        clearTimeout(timeout)
        // Offline: the fetch adapter must not fetch (see #networkDevice).
        if (emulator.network_adapter?.fetch && !networkSettings.relay) {
          emulator.network_adapter.fetch = () => Promise.reject(new TypeError('This machine is offline.'))
        }
        resolve()
      })
      emulator.add_listener('virtio-console0-output-bytes', (bytes) => this.#write(bytes))
      emulator.add_listener('virtio-console1-output-bytes', (bytes) => this.#onAgentOutput(bytes))
      this.#emulator = emulator
    })
    this.status = 'running'
  }

  // After restoring a snapshot: fix the clock (it froze when the snapshot
  // was taken), pass the terminal size, and redraw the screen.
  #resume({ fresh }) {
    this.servers = []
    this.#syncClock()
    this.#emulator.bus.send('virtio-console0-resize', [this.#cols, this.#rows])
    if (fresh) {
      // A fresh machine sits at an empty prompt (the snapshot was taken
      // there with a cleared screen), so drawing that prompt matches it.
      this.#write(welcome({ kind: this.#kind, internet: this.#hardware >= 2 && networkSettings.enabled }) + FRESH_PROMPT)
    } else {
      // A saved machine may be inside nano, less or htop: Ctrl+L redraws.
      this.#inputQueue.push(encoder.encode('\x0c'))
      this.#pumpInput()
    }
    this.#view?.focus()
  }

  // The guest may not be listening the instant it resumes, so repeat until
  // the agent confirms.
  #syncClock() {
    clearInterval(this.#clockTimer)
    this.#clockSynced = false
    let attempts = 0
    const send = () => {
      if (this.#clockSynced || attempts++ >= 20 || !this.#emulator) return clearInterval(this.#clockTimer)
      this.#sendAgent(`time ${Math.floor(Date.now() / 1000)}`)
      this.#sendAgent('ports') // and which servers are running
    }
    send()
    this.#clockTimer = setInterval(send, 500)
  }

  #clockTimer = null
  #clockSynced = false

  #sendAgent(line) {
    this.#emulator?.bus.send('virtio-console1-input-bytes', encoder.encode(`${line}\n`))
  }

  #onAgentOutput(bytes) {
    this.#agentBuffer += decoder.decode(bytes)
    let newline
    while ((newline = this.#agentBuffer.search(/\r?\n/)) !== -1) {
      const line = this.#agentBuffer.slice(0, newline).trim()
      this.#agentBuffer = this.#agentBuffer.slice(newline + 1).replace(/^\n/, '')
      if (line === 'ok time') this.#clockSynced = true
      else if (line === 'ports' || line.startsWith('ports ')) this.#setServers(line.slice(6))
      else if (line === 'reboot') this.#bootFresh({ message: 'Rebooting…' }).catch((error) => this.#fail(error))
      else if (line === 'poweroff') this.#powerOff()
      else if (line === 'save') this.save() // e.g. the tutorial after a lesson
    }
  }

  #setServers(list) {
    const ports = [...new Set(list.split(/\s+/).filter(Boolean).map(Number))].filter((port) => port > 0 && port < 65536).sort((a, b) => a - b)
    if (ports.join() !== this.servers.join()) this.servers = ports
  }

  /**
   * Show the server on `port` in the machine at a preview host (see
   * httpBridge.js). Resolves with { url, close() }.
   */
  async exposePort(port, host) {
    await this.start()
    const adapter = this.#emulator?.network_adapter
    if (!this.#tcpConnect || !adapter) throw new Error(this.#hardware < 2 ? 'This machine was made before Opcode Linux had a network card, so its servers can\'t be previewed. Reset machine gives it one.' : 'Previews of servers in Linux machines are not available in this version of Opcode.')
    const connect = (target) => this.#tcpConnect(target, adapter)
    return exposeOnHost(host, (request) => fetchFromMachine(connect, port, request))
  }

  // The machine runs from memory, so rebooting it means starting fresh.
  async #bootFresh({ message } = {}) {
    if (!this.#emulator) return
    if (message) this.#write(`\r\n${style.dim(message)}\r\n`)
    const state = await gunzip(await loadPristine(this.#kind, (progress) => (this.progress = progress)))
    this.progress = null
    const hardware = this.#manifest.hardware ?? 1
    if (hardware === this.#hardware) {
      await this.#emulator.restore_state(state)
      if (this.status === 'stopped') this.#emulator.run()
    } else {
      // An older machine with different hardware: build a new computer.
      await this.#emulator.destroy().catch(() => {})
      this.#emulator = null
      await this.#createEmulator(state, hardware)
    }
    this.status = 'running'
    this.#write('\x1b[H\x1b[2J\x1b[3J') // a new screen, as after a real reboot
    this.#resume({ fresh: true })
    this.#dirty = true
    this.save()
  }

  #powerOff() {
    this.#emulator?.stop()
    this.status = 'stopped'
    this.servers = []
    this.#write(`\r\n${style.dim('[The machine is powered off. Press any key to start it again.]')}\r\n`)
  }

  /** Throw away this machine and start a fresh one. */
  async reset() {
    await this.start()
    await deleteMachine(this.#projectId)
    this.savedAt = null
    await this.#bootFresh()
  }

  /**
   * The machine as an .opcode-linux file (see machineFile.js), to keep a
   * copy or share it. Saves it first.
   */
  async exportFile(name) {
    await this.start()
    if (!this.#emulator) throw new Error('The machine is not running.')
    await this.save()
    const record = await loadMachine(this.#projectId)
    if (!record) throw new Error('The machine could not be saved.')
    const { state, ...meta } = record
    return encodeMachineFile({ name, alpine: this.#manifest.alpine, ...meta, machine: this.#kind }, state)
  }

  /** Save the machine (memory, files and running programs) in the browser. */
  save() {
    if (!this.#emulator || this.status === 'error') return this.#saveChain
    this.#saveChain = this.#saveChain.then(async () => {
      if (!this.#emulator) return
      this.saving = true
      try {
        this.#dirty = false
        const state = await this.#emulator.save_state()
        const blob = await gzip(state)
        await saveMachine(this.#projectId, { state: blob, savedAt: Date.now(), v86: this.#manifest.v86, memoryMB: this.#manifest.memoryMB, hardware: this.#hardware, machine: this.#kind })
        this.savedAt = Date.now()
        keepStorage()
      } catch (error) {
        console.error('Could not save the Linux machine:', error)
        this.#dirty = true
      } finally {
        this.saving = false
      }
    })
    return this.#saveChain
  }

  async close({ save = true } = {}) {
    this.#closed = true
    clearInterval(this.#autosaveTimer)
    clearInterval(this.#clockTimer)
    clearTimeout(this.#pumpTimer)
    document.removeEventListener('visibilitychange', this.#onVisibility)
    if (save && this.#dirty) await this.save()
    try {
      await this.#emulator?.destroy()
    } catch {
      // Already stopped.
    }
    this.#emulator = null
  }

  #fail(error) {
    console.error(error)
    this.status = 'error'
    this.error = error?.message || String(error)
    this.progress = null
    this.#startPromise = null
    this.#write(`\r\n${style.red(`Could not start the ${this.info.name} machine: ${this.error}`)}\r\n`)
  }
}

// Ask the browser not to clear saved machines when space runs low (it may
// ask the user, or decide from how the site is used).
let persistRequested = false
function keepStorage() {
  if (persistRequested || !navigator.storage?.persist) return
  persistRequested = true
  navigator.storage.persist().catch(() => {})
}

export function describeProgress(progress) {
  if (!progress) return ''
  if (progress.phase === 'loading') return `Starting ${progress.label}…`
  const amount = progress.totalBytes ? `${Math.floor(progress.percent ?? 0)}% · ${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}` : formatBytes(progress.downloadedBytes)
  return `Downloading ${progress.label} · ${amount}`
}
