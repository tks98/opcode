// One project's execution environment: a Wasmer sandbox whose /workspace
// mirrors the project's files, interactive bash shells (one per terminal
// tab, see Shell.svelte.js), toolchains installed on demand, the bridge that
// lets the shell's clang/gcc commands use the browser-hosted compiler, and
// the web servers programs start (shown by the preview, see preview.svelte.js).

import { getWasmer, describeError } from './wasmer.js'
import { loadShellPackages, loadToolchain, formatBytes } from './toolchains.js'
import { prepareCompiler, compile, isCompilerReady } from './compiler.js'
import { classOutputPath, compileJava, formatJavacDiagnostics, isJavacReady, parseJavacArgs, prepareJavac, sourceFileOf, withSourceFile } from './javac.js'
import { isTscInput, isTscReady, prepareTsc, runTsc } from './tsc.js'
import { isRReady, prepareR } from './r.js'
import { R_VERSION, parseRscriptArgs } from './rlang.js'
import { mapCompilerArgs, prettifyOutput, COMPILER_SUPPORT_FILES } from './compilerArgs.js'
import { planPush, planPull, applyPushToBaseline, applyPullToBaseline, emptyBaseline, decodeText, impliedDirs } from './workspaceSync.js'
import { BASHRC, SANDBOX_ENV, SHELL_ARGS, HOST_DIR, HISTORY_FILE, HISTORY_PATH, TOOLS_PATH, TOOLS_SCRIPT } from './shell.js'
import { RUNTIME_FAILURE, Shell } from './Shell.svelte.js'
import { networkSettings, relayDnsUrl } from '../stores/network.svelte.js'
import { TOOLCHAINS, runPlanFor, shellQuote, toolchainsForFiles } from '../languages.js'
import { INTERNAL_DIR, WORKSPACE_ROOT, basename, dirname, fromWorkspacePath, isIgnoredPath, toWorkspacePath } from '../paths.js'

const MAX_SYNC_BYTES = 1024 * 1024
const MAX_COMPILER_INPUT_BYTES = 32 * 1024 * 1024
const PUSH_DELAY_MS = 250
const BUSY_PULL_MS = 2000
const HOST_POLL_MS = 120
const PORT_POLL_MS = 400

const style = {
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const crlf = (text) => text.replace(/\r?\n/g, '\r\n')

export class ProjectSandbox {
  // Reactive state shown by the UI.
  status = $state('idle') // idle | starting | ready | error | closed
  error = $state(null)
  progress = $state(null) // { label, percent, downloadedBytes, totalBytes }
  binaries = $state([]) // files the editor cannot show: [{ path, size }]
  toolchains = $state({}) // id -> 'installing' | 'ready' | 'error'
  pushes = $state(0) // editor changes written to the sandbox (web previews reload on it)
  shells = $state([]) // terminal tabs
  activeShellId = $state(null)
  servers = $state([]) // ports programs listen on, ascending
  plots = $state(null) // { images: [PNG bytes], at }: R's latest plots, for the preview
  internet = $state(false) // started with a relay (see stores/network.svelte.js)

  #projectId
  #getProject
  #applyChanges
  #openFile
  #saveHistory
  #historySavedAt = 0
  #sandbox = null
  #shellPackage = null
  #nextShellId = 1
  #startPromise = null
  #toolchainPromises = new Map()
  #toolchainReporters = new Map()
  #baseline = emptyBaseline()
  #syncChain = Promise.resolve()
  #pushTimer = null
  #busyTimer = null
  #hostTimer = null
  #hostRequests = new Map() // request id -> shell id
  #hostProcesses = new Map() // request id -> process started for it (rustc)
  #serving = false
  #stopWatchingPorts = null
  #closed = false

  /**
   * @param {string} projectId
   * @param {{ getProject: () => object | null, applyChanges: (changes: object) => void,
   *           openFile?: (path: string) => boolean, saveHistory?: (text: string) => void }} bindings
   */
  constructor(projectId, { getProject, applyChanges, openFile = () => false, saveHistory = () => {} }) {
    this.#projectId = projectId
    this.#getProject = getProject
    this.#applyChanges = applyChanges
    this.#openFile = openFile
    this.#saveHistory = saveHistory
    // The first terminal exists (and shows progress) before the sandbox starts.
    this.#addShell()
  }

  get projectId() {
    return this.#projectId
  }

  get activeShell() {
    return this.shells.find((shell) => shell.id === this.activeShellId) ?? this.shells[0] ?? null
  }

  /** True while a command runs in the active terminal. */
  get busy() {
    return this.activeShell?.busy ?? false
  }

  get cwd() {
    return this.activeShell?.cwd ?? WORKSPACE_ROOT
  }

  // ---------------------------------------------------------------------
  // Terminal tabs
  // ---------------------------------------------------------------------

  #addShell() {
    const shell = new Shell(this.#nextShellId++, {
      spawn: (target, options) => this.#spawnProcess(target, options),
      onBusyChange: () => this.#updateBusyTimers(),
      onPrompt: () => this.#onPrompt(),
      onInterrupt: (target) => this.#cancelHostRequests(target.id),
      fs: () => this.#sandbox?.fs ?? null,
      fail: (error) => this.#fail(error),
    })
    this.shells.push(shell)
    this.activeShellId = shell.id
    return shell
  }

  /** Open another terminal in this project. */
  async newShell() {
    const shell = this.#addShell()
    await this.start() // spawns it if the sandbox was still starting
    if (this.#sandbox && !shell.running && this.shells.includes(shell)) {
      await shell.spawn({ cwd: WORKSPACE_ROOT }).catch((error) => this.#fail(error))
    }
    return shell
  }

  async closeShell(id) {
    if (this.shells.length <= 1) return
    const index = this.shells.findIndex((shell) => shell.id === id)
    if (index === -1) return
    const [shell] = this.shells.splice(index, 1)
    if (this.activeShellId === id) this.activeShellId = this.shells[Math.max(0, index - 1)].id
    await shell.close()
    this.#updateBusyTimers()
  }

  setActiveShell(id) {
    if (this.shells.some((shell) => shell.id === id)) this.activeShellId = id
  }

  #shellById(id) {
    return this.shells.find((shell) => shell.id === Number(id)) ?? this.activeShell
  }

  #spawnProcess(shell, { cwd, columns, rows }) {
    return this.#sandbox
      .command(this.#shellPackage.command('bash'), SHELL_ARGS, { cwd, env: { OPCODE_SHELL: String(shell.id) } })
      .spawn({ terminal: { columns, rows } })
  }

  // Watch for file changes and compiler requests while any terminal is busy.
  #updateBusyTimers() {
    const busy = this.shells.some((shell) => shell.busy)
    if (busy && !this.#busyTimer) {
      this.#busyTimer = setInterval(() => this.syncNow({ quick: true }), BUSY_PULL_MS)
      this.#hostTimer = setInterval(() => this.#serveHostRequests(), HOST_POLL_MS)
    } else if (!busy && this.#busyTimer) {
      clearInterval(this.#busyTimer)
      clearInterval(this.#hostTimer)
      this.#busyTimer = null
      this.#hostTimer = null
    }
  }

  // A command finished in some terminal.
  #onPrompt() {
    this.syncNow()
    this.#serveHostRequests() // catch requests from quick commands (e.g. `code`)
    this.#persistHistory()
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  start() {
    this.#startPromise ??= this.#start()
    return this.#startPromise
  }

  async #start() {
    this.status = 'starting'
    const first = this.shells[0]
    first.write(style.dim('Starting terminal…') + '\r\n')
    try {
      const wasmer = await getWasmer()
      const basePackages = await loadShellPackages((progress) => this.#setProgress(progress))
      this.#shellPackage = basePackages[0]
      this.#setProgress(null)
      if (this.#closed) return

      const project = this.#getProject()
      const files = {
        [`${INTERNAL_DIR}/bashrc`]: BASHRC,
        [TOOLS_PATH]: TOOLS_SCRIPT,
        [`${INTERNAL_DIR}/host/.keep`]: '',
      }
      for (const file of project?.files ?? []) files[file.path] = file.content
      if (project?.history) files[HISTORY_PATH] = project.history

      // Virtual TCP for programs (servers, clients on localhost) and HTTP into
      // the sandbox for the preview, plus the internet through a relay if set.
      const relay = networkSettings.relay
      this.#sandbox = await wasmer.sandboxes.create({
        packages: basePackages,
        files,
        env: SANDBOX_ENV,
        network: relay ? { mode: 'wisp', url: relay, dnsUrl: relayDnsUrl(relay) } : { mode: 'http' },
      })
      this.internet = Boolean(relay)
      if (this.#closed) {
        await this.#sandbox.close().catch(() => {})
        return
      }

      this.#baseline = emptyBaseline()
      for (const file of project?.files ?? []) this.#baseline.files.set(file.path, file.content)
      this.#baseline.dirs = impliedDirs(this.#baseline.files.keys())
      await this.#push()

      this.#watchPorts()
      this.status = 'ready'
      first.write('\x1b[1A\x1b[2K\r')
      first.write(`${style.bold('Opcode terminal')} ${style.dim('— your project is in ~ (/workspace). Run ▶ types the command here for you.')}\r\n`)
      for (const shell of this.shells) await shell.spawn()
      this.#prepareProjectToolchains()
    } catch (error) {
      this.#fail(error)
    }
  }

  #fail(error) {
    console.error(error)
    if (this.status === 'starting') {
      this.status = 'error'
      this.#startPromise = null // Restart tries again
    }
    this.error = describeError(error)
    this.#setProgress(null)
    this.activeShell?.notice(style.red(this.error))
  }

  /** Restart the active terminal's shell (or retry a failed start). */
  async restartShell() {
    if (this.status === 'error' && !this.#sandbox) {
      this.error = null
      this.activeShell?.write(`\r\n${style.dim('[Retrying…]')}\r\n`)
      return this.start()
    }
    await this.start()
    if (this.#sandbox) await this.activeShell?.restart()
  }

  async close() {
    this.#closed = true
    this.status = 'closed'
    this.#cancelHostRequests()
    clearTimeout(this.#pushTimer)
    clearInterval(this.#busyTimer)
    clearInterval(this.#hostTimer)
    this.#stopWatchingPorts?.()
    for (const shell of this.shells) await shell.close()
    await this.#sandbox?.close().catch(() => {})
    this.#sandbox = null
  }

  // ---------------------------------------------------------------------
  // Running code
  // ---------------------------------------------------------------------

  /** Run a project file by typing its command into the active terminal. */
  async run(path) {
    await this.start()
    const shell = this.activeShell
    if (!this.#sandbox || !shell) return
    if (!shell.running) await shell.spawn()

    const project = this.#getProject()
    const plan = runPlanFor(path, project?.files ?? [], project?.language)
    if (!plan) {
      shell.notice(style.yellow(`Opcode doesn't know how to run "${path}". Use the terminal to run it yourself.`))
      return
    }

    if (shell.busy) {
      await shell.interrupt()
      await shell.waitForPrompt(3000)
    }

    // The command's toolchain, and the ones it uses (TypeScript's node).
    let printedSetup = false
    const needed = plan.toolchain ? [plan.toolchain, ...(TOOLCHAINS[plan.toolchain].requires ?? [])] : []
    for (const id of needed) {
      if (this.toolchains[id] === 'ready') continue
      try {
        await this.ensureToolchain(id, { verbose: true, shell })
      } catch {
        return
      }
      printedSetup = true
    }
    if (shell.stale) {
      // Run replaces whatever was half-typed anyway.
      await shell.refresh(null, { force: true })
    } else if (printedSetup) {
      await shell.newPrompt()
    }

    await this.syncNow({ pushOnly: true })
    await shell.type(shell.cwd === WORKSPACE_ROOT ? plan.command : `cd ~ && ${plan.command}`)
  }

  /** Stop the command running in the active terminal (Stop button). */
  async stop() {
    await this.activeShell?.interrupt()
  }

  // ---------------------------------------------------------------------
  // Web servers
  // ---------------------------------------------------------------------

  #watchPorts() {
    try {
      this.#stopWatchingPorts = this.#sandbox.ports.onListen(
        (port) => (this.servers = [...this.servers, port].sort((a, b) => a - b)),
        { intervalMs: PORT_POLL_MS, onClose: (port) => (this.servers = this.servers.filter((p) => p !== port)) },
      )
    } catch (error) {
      console.warn('Port watching is unavailable:', error)
    }
  }

  /**
   * Route HTTP requests from a browser origin (the preview host) to a server
   * listening in this sandbox. Returns the SDK's BrowserServer.
   */
  async exposePort(port, host) {
    if (!this.#sandbox) throw new Error('The terminal is not running.')
    return this.#sandbox.ports.expose(port, { serviceWorker: host, timeoutMs: 15_000 })
  }

  // ---------------------------------------------------------------------
  // Toolchains
  // ---------------------------------------------------------------------

  #setProgress(progress) {
    this.progress = progress && progress.phase !== 'ready' ? progress : null
  }

  #prepareProjectToolchains() {
    const project = this.#getProject()
    const ids = toolchainsForFiles(project?.files ?? [], project?.language)
    ;(async () => {
      for (const id of ids) {
        if (this.#closed) return
        await this.ensureToolchain(id).catch(() => {})
      }
    })()
  }

  /**
   * Make a toolchain available in this sandbox. With `verbose`, progress is
   * also printed in `shell` (used when the user pressed Run).
   */
  async ensureToolchain(id, { verbose = false, shell = this.activeShell } = {}) {
    await this.start()
    if (this.toolchains[id] === 'ready') return
    const toolchain = TOOLCHAINS[id]
    let lastLine = 0
    const report = (progress) => {
      this.#setProgress(progress)
      if (!verbose || !progress) return
      const now = Date.now()
      if (now - lastLine < 150 && progress.phase === 'downloading') return
      lastLine = now
      const amount = progress.totalBytes ? ` ${Math.floor(progress.percent ?? 0)}% (${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)})` : progress.downloadedBytes ? ` ${formatBytes(progress.downloadedBytes)}` : ''
      const verb = progress.phase === 'loading' ? 'Preparing' : 'Downloading'
      shell?.write(`\r\x1b[2K${style.dim(`${verb} ${toolchain.name}…${amount}`)}`)
    }
    if (verbose) shell?.notice(style.dim(`Setting up ${toolchain.name} (first use downloads about ${toolchain.sizeMB} MB, then it's cached)…`))
    // Companions (Java's javac) get ready in the background.
    for (const companion of toolchain.requires ?? []) this.ensureToolchain(companion).catch(() => {})

    let reporters = this.#toolchainReporters.get(id)
    if (!reporters) this.#toolchainReporters.set(id, (reporters = new Set()))
    reporters.add(report)
    let promise = this.#toolchainPromises.get(id)
    if (!promise) {
      promise = this.#installToolchain(id, (progress) => {
        for (const listener of reporters) listener(progress)
      })
      this.#toolchainPromises.set(id, promise)
    }
    try {
      await promise
      // Registry toolchains announce themselves when the shell restarts.
      if (verbose && toolchain.host) shell?.notice(style.green(`✓ ${toolchain.name} ready`))
    } catch (error) {
      this.#toolchainPromises.delete(id)
      if (verbose) shell?.notice(style.red(`Could not set up ${toolchain.name}: ${describeError(error)}`))
      throw error
    } finally {
      reporters.delete(report)
      this.#setProgress(null)
    }
  }

  async #installToolchain(id, report) {
    const toolchain = TOOLCHAINS[id]
    this.toolchains[id] = 'installing'
    try {
      if (toolchain.host === 'clang') {
        await prepareCompiler(toolchain.name, report)
      } else if (toolchain.host === 'javac') {
        await prepareJavac(toolchain.name, toolchain.sizeMB, report)
      } else if (toolchain.host === 'tsc') {
        await prepareTsc(toolchain.name, toolchain.sizeMB, report)
      } else if (toolchain.host === 'r') {
        await prepareR(toolchain.name, report)
      } else {
        const packages = await loadToolchain(id, report)
        for (const pkg of packages) await this.#sandbox.installPackage(pkg)
        // Running shells can't see the new commands until they restart:
        // now if idle, otherwise when a command needs it (or on Run).
        // (Opcode itself starts host toolchains' commands.)
        if (!toolchain.host) {
          for (const shell of this.shells) {
            shell.markStale(style.green(`✓ ${toolchain.name} ready`))
            shell.restartIfIdle()
          }
        }
      }
      this.toolchains[id] = 'ready'
    } catch (error) {
      this.toolchains[id] = 'error'
      throw error
    }
  }

  // ---------------------------------------------------------------------
  // File sync (see workspaceSync.js)
  // ---------------------------------------------------------------------

  /** Called whenever the project's files change in the editor. */
  scheduleSync() {
    if (!this.#sandbox) return
    clearTimeout(this.#pushTimer)
    this.#pushTimer = setTimeout(() => this.syncNow({ pushOnly: true }), PUSH_DELAY_MS)
  }

  /** Push editor changes, then (unless pushOnly) pull terminal changes. */
  syncNow({ pushOnly = false, quick = false } = {}) {
    clearTimeout(this.#pushTimer)
    const next = this.#syncChain.then(async () => {
      if (!this.#sandbox || this.#closed) return
      await this.#push()
      if (!pushOnly) await this.#pull({ quick })
    })
    this.#syncChain = next.catch((error) => console.warn('Sync failed:', error))
    return this.#syncChain
  }

  async #push() {
    const project = this.#getProject()
    if (!project) return
    const fs = this.#sandbox.fs
    const plan = planPush(project.files, project.folders, this.#baseline)
    if (!plan.writes.length && !plan.removes.length && !plan.mkdirs.length && !plan.rmdirs.length) return
    const made = new Set(this.#baseline.dirs)
    const mkdir = async (dir) => {
      if (!dir || made.has(dir)) return
      await fs.mkdir(toWorkspacePath(dir), { recursive: true })
      made.add(dir)
    }
    for (const dir of plan.mkdirs) await mkdir(dir)
    for (const file of plan.writes) {
      await mkdir(dirname(file.path))
      await fs.writeText(toWorkspacePath(file.path), file.content)
    }
    for (const path of plan.removes) await fs.remove(toWorkspacePath(path)).catch(() => {})
    for (const dir of plan.rmdirs) await fs.remove(toWorkspacePath(dir), { recursive: true }).catch(() => {})
    applyPushToBaseline(this.#baseline, plan)
    this.pushes++
  }

  async #pull({ quick }) {
    const project = this.#getProject()
    if (!project) return
    const sandbox = this.#sandbox
    const snapshot = await this.#scan({ quick })
    // Closed or restarted meanwhile: the snapshot may be of another sandbox.
    if (this.#closed || this.#sandbox !== sandbox) return
    const before = project.files.map((file) => ({ path: file.path, content: file.content }))
    const plan = planPull(snapshot, before, project.folders, this.#baseline)
    if (plan.upserts.length || plan.deletes.length || plan.addFolders.length || plan.removeFolders.length) {
      this.#applyChanges(plan)
    }
    applyPullToBaseline(this.#baseline, snapshot, plan, before)
    const binaries = plan.binaries.map(({ path, size }) => ({ path, size }))
    if (JSON.stringify(binaries) !== JSON.stringify(this.binaries)) this.binaries = binaries
  }

  // Read /workspace. A quick scan re-reads only files whose size changed.
  // A folder or file that can't be read fails the scan: a snapshot missing
  // files would make the pull delete them from the editor. (One removed while
  // scanning fails it too; the next sync reads it again.)
  async #scan({ quick = false } = {}) {
    const fs = this.#sandbox.fs
    const files = new Map()
    const dirs = new Set()
    const walk = async (dir) => {
      const entries = await fs.readDir(toWorkspacePath(dir))
      for (const entry of entries) {
        const path = dir ? `${dir}/${entry.name}` : entry.name
        if (isIgnoredPath(path)) continue
        if (entry.kind === 'directory') {
          dirs.add(path)
          await walk(path)
        } else if (entry.size > MAX_SYNC_BYTES) {
          files.set(path, { size: entry.size, text: null })
        } else {
          const known = this.#baseline.files.get(path)
          if (quick && known !== undefined && byteLength(known) === entry.size) {
            files.set(path, { size: entry.size, text: known })
            continue
          }
          files.set(path, { size: entry.size, text: decodeText(await fs.readFile(toWorkspacePath(path))) })
        }
      }
    }
    await walk('')
    return { files, dirs }
  }

  /** Delete a file the editor cannot show (e.g. a compiled program). */
  async removeBinary(path) {
    await this.#sandbox?.fs.remove(toWorkspacePath(path)).catch(() => {})
    await this.syncNow()
  }

  // ---------------------------------------------------------------------
  // C/C++ compiler bridge (see __opcode_cc in shell.js)
  // ---------------------------------------------------------------------

  async #serveHostRequests() {
    if (!this.#sandbox || this.#serving) return
    this.#serving = true
    try {
      const entries = await this.#sandbox.fs.readDir(HOST_DIR).catch(() => [])
      for (const entry of entries) {
        if (entry.name.endsWith('.open')) {
          await this.#handleOpenRequest(entry.name)
          continue
        }
        if (entry.name.endsWith('.install')) {
          const id = entry.name.slice(0, -'.install'.length)
          this.#hostRequests.set(id, null)
          this.#handleInstallRequest(id).catch((error) => this.#finishCompileRequest(id, 1, `opcode: ${describeError(error)}\n`))
          continue
        }
        if (!entry.name.endsWith('.ready')) continue
        const id = entry.name.slice(0, -'.ready'.length)
        await this.#sandbox.fs.remove(`${HOST_DIR}/${entry.name}`).catch(() => {})
        this.#hostRequests.set(id, null)
        this.#handleCompileRequest(id).catch((error) => this.#finishCompileRequest(id, 1, `opcode: ${describeError(error)}\n`))
      }
    } finally {
      this.#serving = false
    }
  }

  // `code <file>` in the terminal: open the file in the editor.
  async #handleOpenRequest(name) {
    const fs = this.#sandbox.fs
    const request = await fs.readText(`${HOST_DIR}/${name}`).catch(() => null)
    await fs.remove(`${HOST_DIR}/${name}`).catch(() => {})
    if (!request) return
    const [shellId, target] = request.split('\0')
    const shell = this.#shellById(shellId)
    const path = fromWorkspacePath((target ?? '').replace(/\/+$/, ''))
    if (!path || isIgnoredPath(path)) {
      shell?.notice(style.yellow(`Only files inside ~ can be opened in the editor (${target}).`))
      return
    }
    await this.syncNow()
    if (!this.#openFile(path)) shell?.notice(style.yellow(`${path} can't be opened in the editor (it isn't a text file).`))
  }

  // A toolchain command typed before its toolchain was installed (see
  // command_not_found_handle in shell.js): install it, then run the command
  // again once the shell has restarted and can see it.
  async #handleInstallRequest(id) {
    const fs = this.#sandbox.fs
    const raw = await fs.readText(`${HOST_DIR}/${id}.install`)
    await fs.remove(`${HOST_DIR}/${id}.install`).catch(() => {})
    const [shellId, toolchainId, ...command] = raw.split('\0').slice(0, -1)
    const shell = this.#shellById(shellId)
    if (this.#hostRequests.has(id)) this.#hostRequests.set(id, shell?.id ?? null)
    if (!TOOLCHAINS[toolchainId]) throw new Error(`unknown toolchain ${toolchainId}`)
    try {
      await this.ensureToolchain(toolchainId, { verbose: true, shell })
    } catch {
      await this.#finishCompileRequest(id, 1, '')
      return
    }
    if (!this.#hostRequests.has(id)) return // interrupted
    if (shell?.stale) {
      // Run it again as typed (from history) if the line was just this
      // command; otherwise only the command (the rest of the line ran).
      shell.runAfterRefresh(async () => {
        const history = await this.#sandbox?.fs.readText(HISTORY_FILE).catch(() => '')
        const line = history?.trimEnd().split('\n').pop() ?? ''
        const simple = !/[;&|\n]/.test(line) && (line === command[0] || line.startsWith(`${command[0]} `))
        return simple ? line : command.map(shellQuote).join(' ')
      })
      await this.#finishCompileRequest(id, 127, '')
    } else {
      // Installed already, so the command really doesn't exist.
      await this.#finishCompileRequest(id, 127, `bash: ${command[0]}: command not found (not part of ${TOOLCHAINS[toolchainId].name})\n`)
    }
  }

  // Keep shell history across page reloads (saved with the project).
  async #persistHistory() {
    if (!this.#sandbox || Date.now() - this.#historySavedAt < 2000) return
    this.#historySavedAt = Date.now()
    const text = await this.#sandbox.fs.readText(HISTORY_FILE).catch(() => null)
    if (text) this.#saveHistory(text.split('\n').slice(-1000).join('\n'))
  }

  async #handleCompileRequest(id) {
    const fs = this.#sandbox.fs
    const raw = new TextDecoder().decode(await fs.readFile(`${HOST_DIR}/${id}.args`))
    await fs.remove(`${HOST_DIR}/${id}.args`).catch(() => {})
    const [shellId, cwd, tool, ...args] = raw.split('\0').slice(0, -1)
    const shell = this.#shellById(shellId)
    if (this.#hostRequests.has(id)) this.#hostRequests.set(id, shell?.id ?? null)
    if (tool === 'rustc') return this.#runRustc(id, shell, args)
    if (tool === 'javac') return this.#runJavac(id, shell, cwd, args)
    if (tool === 'tsc') return this.#runTsc(id, shell, cwd, args)
    if (tool === 'Rscript' || tool === 'R') return this.#runR(id, shell, cwd, tool, args)
    if (tool === 'rust-tests') return this.#runRustTests(id, cwd, args)

    if (!isCompilerReady()) {
      await this.ensureToolchain('clang', { verbose: true, shell })
    }
    if (!this.#hostRequests.has(id)) return

    const tree = await this.#readWorkspaceTree()
    const request = mapCompilerArgs(tool, args, cwd)
    const result = await compile({ tool: request.tool, args: request.args, files: { workspace: tree, ...COMPILER_SUPPORT_FILES } })
    if (!this.#hostRequests.has(id)) return

    if (result.files) await this.#writeCompilerOutputs(result.files, tree, cwd)
    await this.#finishCompileRequest(id, result.code, prettifyOutput(result.output ?? '', cwd))
    this.syncNow({ quick: true })
  }

  // rustc (see rust.bash): started here rather than by bash, which under
  // WASIX sometimes doesn't survive starting it. Runtime failures (rather
  // than rustc reporting errors) are retried once.
  async #runRustc(id, shell, args) {
    if (this.toolchains.rust !== 'ready') {
      try {
        await this.ensureToolchain('rust', { verbose: true, shell })
      } catch {
        await this.#finishCompileRequest(id, 1, '')
        return
      }
    }
    let result
    for (let attempt = 0; attempt < 2 && this.#hostRequests.has(id); attempt++) {
      result = await this.#spawnRustc(id, args)
      if (!result.crashed) break
    }
    if (!this.#hostRequests.has(id)) return
    await this.#finishCompileRequest(id, result.code, result.stderr, result.stdout)
    this.syncNow({ quick: true })
  }

  async #spawnRustc(id, args) {
    const result = await this.#runHostProcess(id, this.#sandbox.command('rustc', args, { cwd: WORKSPACE_ROOT }))
    // This build of rustc reports its linker command on stdout.
    const stdout = result.stdout.replace(/^Linking using .*\n?/gm, '')
    if (!result.error) return { ...result, stdout }
    // It aborts after reporting errors (a trap here); with nothing printed,
    // the runtime failed instead.
    if (result.stderr.trim()) return { code: 1, stdout, stderr: result.stderr }
    return { code: 101, stdout, stderr: `rustc: ${describeError(result.error)}\n`, crashed: true }
  }

  // cargo test's test programs, run by tools.sh rust-tests in a shell of its
  // own (a failing test aborts its program, which can take the shell with it).
  async #runRustTests(id, cwd, args) {
    let result
    for (let attempt = 0; attempt < 2 && this.#hostRequests.has(id); attempt++) {
      const command = this.#sandbox.command(this.#shellPackage.command('bash'), [`${WORKSPACE_ROOT}/${TOOLS_PATH}`, 'rust-tests', ...args], { cwd })
      result = await this.#runHostProcess(id, command)
      if (!result.error && result.code !== RUNTIME_FAILURE) break
    }
    if (!this.#hostRequests.has(id)) return
    const failed = result.error || result.code === RUNTIME_FAILURE
    const stderr = failed ? `${result.stderr}opcode: the test run stopped unexpectedly (a WebAssembly runtime error). Run cargo test again.\n` : result.stderr
    await this.#finishCompileRequest(id, failed ? 101 : result.code, stderr, result.stdout)
  }

  // Run a process for a host request: its output and exit code, or the
  // error it failed with. Ctrl+C in the terminal kills it.
  async #runHostProcess(id, command) {
    let process
    try {
      process = await command.spawn({ stdin: 'closed', stdout: 'pipe', stderr: 'pipe' })
    } catch (error) {
      return { stdout: '', stderr: '', error }
    }
    this.#hostProcesses.set(id, process)
    const read = async (stream) => {
      const decoder = new TextDecoder()
      let text = ''
      try {
        for await (const chunk of stream) text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      } catch {
        // The process ended abruptly; keep what it printed.
      }
      return text
    }
    const [stdout, stderr, status] = await Promise.all([
      read(process.stdout),
      read(process.stderr),
      process.wait({ check: false }).then((output) => ({ code: output.exitCode }), (error) => ({ error })),
    ])
    this.#hostProcesses.delete(id)
    return { stdout, stderr, ...status }
  }

  // javac: compile in the browser (runtime/javac.js), then write the class
  // files where javac would: next to their sources, or under -d.
  // tsc (runtime/tsc.js): the TypeScript compiler's own command line, on the
  // project's sources; what it writes (JavaScript) comes back here.
  async #runTsc(id, shell, cwd, args) {
    if (!isTscReady()) {
      try {
        await this.ensureToolchain('typescript', { verbose: true, shell })
      } catch {
        return this.#finishCompileRequest(id, 1, '')
      }
    }
    if (!this.#hostRequests.has(id)) return
    const files = await this.#readTscInputs()
    const result = await runTsc({ cwd, args, files, columns: shell?.cols })
    if (!this.#hostRequests.has(id)) return
    const fs = this.#sandbox.fs
    for (const [path, text] of Object.entries(result.outputs)) {
      if (!path.startsWith(`${WORKSPACE_ROOT}/`)) continue
      await fs.mkdir(dirname(path), { recursive: true }).catch(() => {})
      await fs.writeText(path, text)
    }
    await this.#finishCompileRequest(id, result.code, '', result.output)
    this.syncNow({ quick: true })
  }

  // R (webR, see runtime/rlang.js): Rscript runs, and the R console's
  // requests (see R() in shell.js). Output comes back in order on stdout.
  async #runR(id, shell, cwd, tool, args) {
    const finish = (code, stdout) => this.#finishCompileRequest(id, code, '', stdout)
    const mode = args[0]?.startsWith('--console-') ? args[0].slice('--console-'.length) : null
    const key = `${this.projectId}:${shell?.id}`
    if (mode === 'end') {
      if (isRReady()) (await prepareR()).closeConsole(key)
      return finish(0, '')
    }
    const options = mode ? {} : parseRscriptArgs(args)
    if (options.version) return finish(0, `${tool === 'R' ? R_VERSION : `Rscript (R) version ${R_VERSION.slice('R version '.length)}`}, running on webR in your browser\n`)
    if (options.help) return finish(tool === 'Rscript' && args.length ? 0 : 1, 'Usage: Rscript [options] file [args]\n   or: Rscript [options] -e expr [-e expr2 ...] [args]\n(R on its own starts the R console.)\n')
    if (!isRReady()) {
      try {
        await this.ensureToolchain('r', { verbose: true, shell })
      } catch {
        return finish(1, '')
      }
    }
    if (!this.#hostRequests.has(id)) return
    const runner = await prepareR()

    if (mode === 'start') {
      runner.closeConsole(key)
      return finish(0, `${R_VERSION}, on webR in your browser. Type q() to quit.\n`)
    }
    if (mode === 'eval') {
      const result = await runner.consoleEval(key, cwd, args[1] ?? '')
      if (result.plot) this.plots = { images: [result.plot], at: Date.now() }
      return finish({ ok: 0, error: 1, incomplete: 3, quit: 4 }[result.status], result.output)
    }

    const files = {}
    const collect = (node, prefix) => {
      for (const [name, value] of Object.entries(node)) {
        if (value instanceof Uint8Array) files[`${prefix}/${name}`] = value
        else collect(value, `${prefix}/${name}`)
      }
    }
    collect(await this.#readWorkspaceTree(), WORKSPACE_ROOT)
    const result = await runner.runScript({ cwd, file: options.file, expression: options.expression, args: options.args, files })
    if (!this.#hostRequests.has(id)) return
    const fs = this.#sandbox.fs
    for (const [path, bytes] of Object.entries(result.written)) {
      if (!path.startsWith(`${WORKSPACE_ROOT}/`)) continue
      await fs.mkdir(dirname(path), { recursive: true }).catch(() => {})
      await fs.writeFile(path, bytes)
    }
    if (result.plots.length) this.plots = { images: result.plots, at: Date.now() }
    await finish(result.code, result.output)
    this.syncNow({ quick: true })
  }

  // The files tsc may read ({ absolutePath: text }), type definitions in
  // node_modules included (unlike #readWorkspaceTree).
  async #readTscInputs() {
    const fs = this.#sandbox.fs
    const decoder = new TextDecoder()
    const files = {}
    let total = 0
    const walk = async (dir) => {
      for (const entry of await fs.readDir(dir).catch(() => [])) {
        const path = `${dir}/${entry.name}`
        const relative = path.slice(WORKSPACE_ROOT.length + 1)
        if (entry.kind === 'directory') {
          if (entry.name !== 'node_modules' && isIgnoredPath(relative)) continue
          await walk(path)
        } else if (isTscInput(relative) && total + entry.size <= MAX_COMPILER_INPUT_BYTES) {
          files[path] = decoder.decode(await fs.readFile(path))
          total += entry.size
        }
      }
    }
    await walk(WORKSPACE_ROOT)
    return files
  }

  async #runJavac(id, shell, cwd, args) {
    const options = parseJavacArgs(args)
    if (options.version) return this.#finishCompileRequest(id, 0, '', 'javac 21 (OpenJDK javac built with TeaVM, running in your browser)\n')
    if (options.help) return this.#finishCompileRequest(id, 0, '', 'Usage: javac [-d <directory>] [-cp <path>] <source files>\n')
    if (options.error) return this.#finishCompileRequest(id, 2, `error: ${options.error}\nUsage: javac [-d <directory>] [-cp <path>] <source files>\n`)
    if (!isJavacReady()) {
      try {
        await this.ensureToolchain('javac', { verbose: true, shell })
      } catch {
        return this.#finishCompileRequest(id, 1, '')
      }
    }
    if (!this.#hostRequests.has(id)) return

    const fs = this.#sandbox.fs
    const resolve = (path) => (path.startsWith('/') ? path : `${cwd}/${path}`.replace(/\/\.\//g, '/'))
    const relativeToCwd = (path) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
    const sources = new Map() // absolute path -> text
    for (const path of options.sources) {
      const text = await fs.readText(resolve(path)).catch(() => null)
      if (text === null) return this.#finishCompileRequest(id, 2, `error: file not found: ${path}\n`)
      sources.set(resolve(path), text)
    }
    // Like javac, also compile the other sources in those folders that define
    // classes the given ones use.
    const siblings = new Map()
    for (const dir of new Set([...sources.keys()].map(dirname))) {
      for (const entry of await fs.readDir(dir).catch(() => [])) {
        const path = `${dir}/${entry.name}`
        if (entry.kind !== 'directory' && entry.name.endsWith('.java') && !sources.has(path)) siblings.set(path, entry.name.slice(0, -5))
      }
    }
    for (let added = true; added; ) {
      added = false
      const text = [...sources.values()].join('\n')
      for (const [path, name] of siblings) {
        if (!new RegExp(`\\b${name}\\b`).test(text)) continue
        const content = await fs.readText(path).catch(() => null)
        siblings.delete(path)
        if (content !== null) {
          sources.set(path, content)
          added = true
        }
      }
    }
    // Compiled classes on the class path (the current folder by default).
    const classFiles = []
    for (const entry of options.classPath ?? ['.']) {
      const root = resolve(entry).replace(/\/\.?$/, '')
      const walk = async (dir, prefix, depth) => {
        for (const item of await fs.readDir(dir).catch(() => [])) {
          if (item.kind === 'directory') {
            if (depth < 8 && !item.name.startsWith('.')) await walk(`${dir}/${item.name}`, `${prefix}${item.name}/`, depth + 1)
          } else if (item.name.endsWith('.class') && classFiles.length < 2000) {
            const bytes = await fs.readFile(`${dir}/${item.name}`).catch(() => null)
            if (bytes) classFiles.push({ path: `${prefix}${item.name}`, bytes })
          }
        }
      }
      await walk(root, '', 0)
    }

    // javac checks that a public class lives in a file of its name, so it gets
    // bare file names (unless two share one); messages name the real paths.
    const names = [...sources.keys()].map((path) => basename(path))
    const bare = new Set(names).size === names.length
    const shown = new Map([...sources.keys()].map((path) => [bare ? basename(path) : relativeToCwd(path), relativeToCwd(path)]))
    let result
    try {
      result = await compileJava({ sources: [...sources].map(([path, content]) => ({ path: bare ? basename(path) : relativeToCwd(path), content })), classFiles })
    } catch (error) {
      return this.#finishCompileRequest(id, 1, `error: the Java compiler failed: ${describeError(error)}\n`)
    }
    if (!this.#hostRequests.has(id)) return

    const byName = new Map([...sources.keys()].map((path) => [basename(path), path]))
    for (const output of result.outputs ?? []) {
      if (!output.name.endsWith('.class')) continue
      const name = output.name
      const recorded = basename((sourceFileOf(output.bytes) ?? '').replace(/^.*:/, ''))
      const source = byName.get(recorded) ?? [...sources.keys()][0]
      const bytes = withSourceFile(output.bytes, basename(source))
      const target = classOutputPath(name, relativeToCwd(source), options.outDir === null ? null : relativeToCwd(resolve(options.outDir)))
      const absolute = resolve(target)
      await fs.mkdir(dirname(absolute), { recursive: true }).catch(() => {})
      await fs.writeFile(absolute, bytes)
    }
    const diagnostics = (result.diagnostics ?? []).map((d) => ({ ...d, fileName: shown.get(String(d.fileName ?? '').replace(/^\/+/, '')) ?? d.fileName }))
    const text = (path) => sources.get(resolve(path))
    const output = options.warnings.map((warning) => `${warning}\n`).join('') + formatJavacDiagnostics(diagnostics, text)
    await this.#finishCompileRequest(id, result.ok ? 0 : 1, output)
    this.syncNow({ quick: true })
  }

  async #finishCompileRequest(id, code, output, stdout = '') {
    if (!this.#hostRequests.delete(id) || !this.#sandbox) return
    const fs = this.#sandbox.fs
    if (stdout) await fs.writeText(`${HOST_DIR}/${id}.stdout`, stdout)
    await fs.writeText(`${HOST_DIR}/${id}.out`, output)
    await fs.writeText(`${HOST_DIR}/${id}.done`, `${code}\n`)
    // The shell has read these files by the time the next request arrives.
    setTimeout(() => {
      for (const suffix of ['stdout', 'out', 'done']) fs.remove(`${HOST_DIR}/${id}.${suffix}`).catch(() => {})
    }, 10_000)
  }

  // Ctrl+C/Stop: give up on compiles and installs started from that terminal
  // (or all).
  #cancelHostRequests(shellId) {
    for (const [id, owner] of [...this.#hostRequests]) {
      if (shellId === undefined || owner === null || owner === shellId) {
        this.#hostProcesses.get(id)?.kill().catch(() => {})
        this.#finishCompileRequest(id, 130, '').catch(() => {})
      }
    }
  }

  // The compiler sees the project (sources, headers, object files) as a tree.
  async #readWorkspaceTree() {
    const fs = this.#sandbox.fs
    const tree = {}
    let total = 0
    const walk = async (dir, node) => {
      for (const entry of await fs.readDir(toWorkspacePath(dir)).catch(() => [])) {
        const path = dir ? `${dir}/${entry.name}` : entry.name
        if (isIgnoredPath(path)) continue
        if (entry.kind === 'directory') {
          node[entry.name] = {}
          await walk(path, node[entry.name])
        } else if (total + entry.size <= MAX_COMPILER_INPUT_BYTES) {
          node[entry.name] = await fs.readFile(toWorkspacePath(path))
          total += entry.size
        }
      }
    }
    await walk('', tree)
    return tree
  }

  async #writeCompilerOutputs(output, input, cwd) {
    const fs = this.#sandbox.fs
    const writes = []
    const collect = (node, before, prefix) => {
      for (const [name, value] of Object.entries(node ?? {})) {
        const path = prefix ? `${prefix}/${name}` : name
        if (value instanceof Uint8Array) {
          const old = before?.[name]
          if (!(old instanceof Uint8Array) || !sameBytes(old, value)) writes.push([path, value])
        } else if (value && typeof value === 'object') {
          collect(value, before?.[name], path)
        }
      }
    }
    collect(output.workspace, input, '')
    // Outputs Clang wrote relative to its own root (e.g. a.out) belong in
    // the shell's directory.
    const cwdPath = cwd.startsWith(`${WORKSPACE_ROOT}/`) ? cwd.slice(WORKSPACE_ROOT.length + 1) : ''
    for (const [name, value] of Object.entries(output)) {
      if (name === 'workspace' || !(value instanceof Uint8Array)) continue
      writes.push([cwdPath ? `${cwdPath}/${name}` : name, value])
    }
    for (const [path, bytes] of writes) {
      const parent = dirname(path)
      if (parent) await fs.mkdir(toWorkspacePath(parent), { recursive: true }).catch(() => {})
      await fs.writeFile(toWorkspacePath(path), bytes)
    }
  }
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const encoder = new TextEncoder()
function byteLength(text) {
  return encoder.encode(text).length
}
