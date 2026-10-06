// One interactive bash session in a project's sandbox, shown in one
// terminal tab. A project can have several; they share the sandbox (files,
// installed toolchains) but each has its own process, directory and
// Ctrl+C watchdog (see shell.js).

import { OSC_CWD, OSC_SHELL_INTEGRATION, interruptFile, sigintFile, stateFile } from './shell.js'
import { WORKSPACE_ROOT } from '../paths.js'

const crlf = (text) => text.replace(/\r?\n/g, '\r\n')
const dim = (text) => `\x1b[2m${text}\x1b[0m`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Ctrl+C timeline: how long a program gets to react to the terminal's
// SIGINT (longer once it prints something, e.g. a REPL's new prompt); when
// to press Enter for a program still blocked reading the terminal (a killed
// process only exits once its read returns); and when to replace the shell
// (e.g. a loop in the shell itself can't be signalled).
// Commands Opcode types wait this long after a prompt appears, until bash's
// line editor has taken the terminal over (otherwise it echoes them twice).
const PROMPT_SETTLE_MS = 150

// Under WASIX, keys sent while a command line starts (bash forks for PS0)
// or while a short program starts and exits are often lost: that program,
// not bash, receives them. So keys typed after Enter at a prompt wait for
// the prompt to come back, for output that stops mid-line (a program asking
// for input, like `Name: `, or bash's `> ` for the rest of a for loop), or
// until this long has passed (the program is then likely to want them
// itself, like python3 starting its REPL). Pasted lines run one after
// another, as in a native terminal.
const TYPEAHEAD_RELEASE_MS = 1500

// How long a replaced shell may take to show its prompt (slower while
// toolchains load) before keys typed meanwhile are passed on anyway.
const REPLACE_PROMPT_MS = 10_000

// A shell restarts by itself (after a toolchain install) only once nobody
// has used it for this long: no keys sent, the prompt showing.
const IDLE_RESTART_MS = 1500


// The exit status WASIX reports for bash when it ends with any status above
// 78 (its "unknown" error): a signal, or the runtime failing it. Not the
// student's doing, unless they typed `exit 100`; a new shell starts in its
// place, unless that keeps happening (more than RECOVERIES_PER_MINUTE).
export const RUNTIME_FAILURE = 79
const RECOVERIES_PER_MINUTE = 3

const SIGINT_GRACE_MS = 250
const SIGINT_OUTPUT_GRACE_MS = 500
const UNBLOCK_MS = 500
const FORCE_STOP_MS = 1500

// Output ending like a REPL prompt (Python, Node, PHP, a nested shell...),
// or Python's KeyboardInterrupt from a program that keeps running: it
// handled Ctrl+C itself and stays, as it would natively.
const REPL_PROMPT = /(>>>|\.\.\.|>|[$#%]|KeyboardInterrupt)$/
// Screen modes interactive programs (REPLs, editors) turn on, and how to
// turn each off again if the program is stopped before it does.
const APP_MODE = /\x1b\[\?(1|1049|2004)([hl])/g
const APP_MODE_RESET = { 1: '\x1b[?1l\x1b>', 1049: '\x1b[?1049l', 2004: '\x1b[?2004l' }
const ANSI = /\x1b(\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])/g

export class Shell {
  busy = $state(false) // a command is running
  cwd = $state(WORKSPACE_ROOT)
  exited = $state(false)

  #host
  #process = null
  #view = null
  #pending = []
  #cols = 80
  #rows = 24
  #ready = false // the first prompt has appeared
  #appliedSize = null
  #typedSincePrompt = false
  #typedAhead = false // input sent while a command ran (bash reads it next)
  #atPrompt = false // bash's line editor has the terminal, nothing submitted yet
  #lineEchoed = true // bash has moved past the last line sent (output a newline)
  #stale = false // started before a toolchain was installed
  #staleMessage = null // printed when the shell restarts
  #promptWaiters = []
  #refreshing = Promise.resolve()
  #closed = false
  #commands = 0 // counts finished commands
  #promptAt = 0
  #output = 0 // counts output chunks
  #outputTail = ''
  #appModes = new Set() // see APP_MODE
  #stopping = false // the watchdog was asked to stop the command
  #afterRefresh = null // command to run once the shell has restarted
  #heldInput = null // keys typed while the shell is being replaced
  #recoveries = [] // when the shell was restarted after runtime failures
  #typeahead = null // keys typed after Enter, held (see TYPEAHEAD_RELEASE_MS)
  #typeaheadTimer = null
  #sentAt = 0 // when keys were last sent to the shell
  #idleTimer = null

  /**
   * @param {number} id
   * @param {{ spawn: (shell, options) => Promise<object>, onBusyChange: () => void,
   *           onPrompt: (shell) => void, onInterrupt: (shell) => void,
   *           fs: () => object | null, fail: (error) => void }} host
   */
  constructor(id, host) {
    this.id = id
    this.#host = host
  }

  get running() {
    return Boolean(this.#process)
  }

  // ---------------------------------------------------------------------
  // Terminal view interface (TerminalView.svelte): the view calls attach,
  // detach, input, resize and handleOsc; the shell writes, focuses, clears.
  // ---------------------------------------------------------------------

  attach(view) {
    this.#view = view
    for (const chunk of this.#pending) view.write(chunk)
    this.#pending = []
  }

  detach(view) {
    if (this.#view === view) this.#view = null
  }

  write(data) {
    if (this.#view) this.#view.write(data)
    else this.#pending.push(data)
  }

  /** Print an informational line without disturbing the prompt. */
  notice(text) {
    this.write(`\r\x1b[2K${crlf(text)}\r\n`)
  }

  focus() {
    this.#view?.focus()
  }

  clear() {
    this.#view?.clear()
  }

  input(data) {
    if (this.#heldInput) {
      this.#heldInput.push(data)
      return
    }
    if (this.exited) {
      this.exited = false
      this.spawn().catch((error) => this.#host.fail(error))
      return
    }
    if (!this.#process) return
    if (data === '\x03') {
      // Ctrl+C is never held, and drops what was typed ahead (as a native
      // terminal flushes its input).
      this.#dropTypeahead()
      if (this.busy) {
        this.interrupt({ hard: false }).catch((error) => this.#host.fail(error))
        return
      }
      this.#typedSincePrompt = false
      this.#send(data)
      return
    }
    if (this.#typeahead !== null) {
      this.#typeahead += data
      return
    }
    if (this.busy) {
      this.#typedAhead = true
      this.#send(data)
      return
    }
    // Text inserted with line feeds (not a terminal paste, which uses
    // carriage returns): each line is a command, as when pasted.
    data = data.replace(/\r?\n/g, '\r')
    const enter = data.indexOf('\r')
    if (enter === -1) {
      this.#typedSincePrompt = true
      this.#send(data)
      return
    }
    // Send the line; hold what follows until the command is under way.
    if (enter > 0) this.#typedSincePrompt = true
    this.#atPrompt = false
    this.#lineEchoed = false
    this.#send(data.slice(0, enter + 1))
    this.#typeahead = data.slice(enter + 1)
    this.#scheduleTypeahead(TYPEAHEAD_RELEASE_MS)
  }

  #send(data) {
    this.#sentAt = performance.now()
    this.#process?.stdin?.write(data).catch(() => {})
  }

  #scheduleTypeahead(ms) {
    clearTimeout(this.#typeaheadTimer)
    if (this.#typeahead !== null) this.#typeaheadTimer = setTimeout(() => this.#releaseTypeahead(), ms)
  }

  #releaseTypeahead() {
    clearTimeout(this.#typeaheadTimer)
    const keys = this.#typeahead
    this.#typeahead = null
    if (!keys) return
    // Sent before the command started (no prompt, no C marker yet): bash
    // reads them only after that command, like keys typed while it runs.
    if (!this.busy && !this.#atPrompt) this.#typedAhead = true
    this.input(keys)
  }

  #dropTypeahead() {
    clearTimeout(this.#typeaheadTimer)
    this.#typeahead = null
  }

  /** The terminal's width in columns. */
  get cols() {
    return this.#cols
  }

  resize(cols, rows) {
    this.#cols = cols
    this.#rows = rows
    this.#applySize()
  }

  // A resize interrupts blocking reads (WASIX delivers it as EINTR), which
  // kills bash while it starts up and most programs waiting for input. So
  // the size is only passed on while the shell sits idle at its prompt.
  #applySize() {
    if (!this.#process || !this.#ready || this.busy) return
    const size = `${this.#cols}x${this.#rows}`
    if (this.#appliedSize === size) return
    try {
      this.#process.resizeTerminal(this.#cols, this.#rows)
      this.#appliedSize = size
    } catch {
      // The process may already have exited.
    }
  }

  /** Shell integration sequences parsed by the terminal (see shell.js). */
  handleOsc(code, data) {
    if (code === OSC_CWD) {
      if (data.startsWith('/')) this.cwd = data
      return
    }
    if (code !== OSC_SHELL_INTEGRATION) return
    if (data === 'C') {
      this.#appModes.clear()
      this.#atPrompt = false
      this.#setBusy(true)
      this.#scheduleTypeahead(TYPEAHEAD_RELEASE_MS)
    } else if (data.startsWith('D')) {
      this.#commands++
      this.#promptAt = performance.now()
      this.#setBusy(false)
      this.#atPrompt = true
      this.#scheduleTypeahead(PROMPT_SETTLE_MS) // once bash's line editor reads
      const typedAhead = this.#typedAhead
      this.#typedAhead = false
      // Keys typed while the command ran may now sit in bash's line editor
      // (or be a command about to start): treat them as typed at this prompt.
      this.#typedSincePrompt = typedAhead
      this.#ready = true
      this.#applySize()
      const waiters = this.#promptWaiters
      this.#promptWaiters = []
      for (const resolve of waiters) resolve()
      const fs = this.#host.fs()
      fs?.remove(interruptFile(this.id)).catch(() => {})
      fs?.remove(sigintFile(this.id)).catch(() => {})
      this.#host.onPrompt(this)
      if (this.#stopping) {
        // The shell ran `stty sane`; undo the screen modes the program set.
        this.#stopping = false
        this.write([...this.#appModes].map((mode) => APP_MODE_RESET[mode]).join(''))
        this.#appModes.clear()
      }
      if (this.#stale && !this.#afterRefresh && !typedAhead) {
        // Became stale while busy: restart now, unless keys are waiting.
        queueMicrotask(() => this.restartIfIdle())
      } else if (this.#afterRefresh) {
        if (typedAhead) {
          // Restarting would lose what bash reads next; the command can be
          // run again by hand (or Run), which restarts the shell then.
          this.#afterRefresh = null
          this.notice(dim('Ready. Run the command again to use it.'))
        } else if (this.#stale) {
          // The student is waiting for this command: restart now, then run it.
          this.refresh(null, { force: true }).catch((error) => this.#host.fail(error))
        } else {
          const command = this.#afterRefresh
          this.#afterRefresh = null
          Promise.resolve(typeof command === 'function' ? command() : command).then((text) => this.type(text))
        }
      }
    }
  }

  #setBusy(busy) {
    if (this.busy === busy) return
    this.busy = busy
    this.#host.onBusyChange()
  }

  waitForPrompt(timeoutMs = 5000) {
    return Promise.race([new Promise((resolve) => this.#promptWaiters.push(resolve)), sleep(timeoutMs)])
  }

  // ---------------------------------------------------------------------
  // Process lifecycle
  // ---------------------------------------------------------------------

  async spawn({ cwd = this.cwd } = {}) {
    if (this.#closed) return
    const process = await this.#host.spawn(this, { cwd, columns: this.#cols, rows: this.#rows })
    if (this.#closed) {
      await process.kill().catch(() => {})
      return
    }
    this.#process = process
    this.#ready = false
    this.#appliedSize = `${this.#cols}x${this.#rows}`
    this.#stale = false
    this.#stopping = false
    this.#appModes.clear()
    this.exited = false
    this.#typedSincePrompt = false
    this.#typedAhead = false
    this.#atPrompt = false
    this.#lineEchoed = true
    this.#dropTypeahead()
    this.#setBusy(false)

    const decoder = new TextDecoder()
    const pump = async (stream) => {
      for await (const chunk of stream) {
        if (this.#process !== process) continue
        this.write(chunk)
        this.#output++
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
        this.#outputTail = (this.#outputTail + text).slice(-256)
        if (this.#typeahead !== null) {
          const visible = text.replace(ANSI, '').replaceAll('\r', '')
          if (visible.includes('\n')) this.#lineEchoed = true
          // Output stopping mid-line after the line was taken: something asks for input.
          if (this.#lineEchoed && visible && !visible.endsWith('\n')) this.#scheduleTypeahead(PROMPT_SETTLE_MS)
        }
        for (const [, mode, state] of text.matchAll(APP_MODE)) {
          if (state === 'h') this.#appModes.add(mode)
          else this.#appModes.delete(mode)
        }
      }
    }
    pump(process.stdout).catch(() => {})
    pump(process.stderr).catch(() => {})
    process.wait().then((output) => {
      if (this.#process !== process || this.#closed) return
      this.#process = null
      this.#setBusy(false)
      const now = performance.now()
      this.#recoveries = this.#recoveries.filter((at) => now - at < 60_000)
      if (output.exitCode === RUNTIME_FAILURE && this.#recoveries.length < RECOVERIES_PER_MINUTE) {
        this.#recoveries.push(now)
        this.#host.onInterrupt(this) // its compiles and installs are gone too
        this.write(`\r\n${dim('[The shell stopped unexpectedly (exit status 79 or above). Starting a new one…]')}\r\n`)
        this.#replace(() => this.spawn()).catch((error) => this.#host.fail(error))
        return
      }
      this.exited = true
      this.write(`\r\n${dim(`[Shell exited with code ${output.exitCode}. Press any key to start a new one.]`)}\r\n`)
    }, () => {})
  }

  /**
   * Restart a stale shell now if nobody is using it: no command running,
   * nothing typed or waiting to be sent. Keys typed meanwhile are kept.
   */
  restartIfIdle() {
    clearTimeout(this.#idleTimer)
    if (!this.#stale || this.#closed) return
    const now = performance.now()
    const quietFor = Math.min(now - this.#sentAt, now - this.#promptAt)
    if (this.busy || this.#typedSincePrompt || this.#typeahead !== null || !this.#ready || quietFor < IDLE_RESTART_MS) {
      // Not now; look again later (a busy shell also checks at its prompt).
      if (!this.busy) this.#idleTimer = setTimeout(() => this.restartIfIdle(), IDLE_RESTART_MS)
      return
    }
    this.refresh().catch((error) => this.#host.fail(error))
  }

  /** Type a command (or what a function resolves to) once the shell has restarted (e.g. after an install). */
  runAfterRefresh(command) {
    this.#afterRefresh = command
  }

  /**
   * A toolchain was installed: the shell needs a restart to see it. That
   * happens when it is idle (restartIfIdle), when a command needs it (see
   * runAfterRefresh) or on Run, never while someone is typing.
   */
  markStale(message = null) {
    this.#stale = true
    this.#staleMessage = message ?? this.#staleMessage
  }

  get stale() {
    return this.#stale
  }

  /**
   * Replace an idle shell (keeping its directory and history). Deferred
   * while a command runs or the user is typing, unless forced.
   */
  refresh(message, { force = false } = {}) {
    this.#refreshing = this.#refreshing.then(async () => {
      if (this.#closed || !this.#stale || this.busy || !this.#process) return
      if (!force && (this.#typedSincePrompt || this.#typeahead !== null || performance.now() - this.#sentAt < 300)) return
      await this.#replace(async () => {
        const old = this.#process
        this.#process = null
        await old.kill().catch(() => {})
        message ??= this.#staleMessage
        this.#staleMessage = null
        this.write('\r\x1b[2K')
        if (message) this.write(`${message}\r\n`)
        await this.spawn()
      })
    })
    return this.#refreshing
  }

  // Swap in a new shell process, keeping what the user types meanwhile for
  // the new shell's first prompt.
  async #replace(swap) {
    this.#heldInput ??= []
    try {
      await swap()
      await this.waitForPrompt(REPLACE_PROMPT_MS)
    } finally {
      const held = this.#heldInput?.join('') ?? ''
      this.#heldInput = null
      if (held) {
        // Sent once bash's line editor has the terminal, like typeahead.
        this.#typeahead = (this.#typeahead ?? '') + held
        this.#scheduleTypeahead(PROMPT_SETTLE_MS)
      }
    }
  }

  /** Start a fresh shell (Restart button). */
  async restart() {
    const old = this.#process
    const wasBusy = this.busy
    await this.interrupt()
    // Give the watchdog time to stop the running command; killing the
    // shell alone would leave its children running.
    if (wasBusy) await this.waitForPrompt(1500)
    await this.#replace(async () => {
      this.#process = null
      await old?.kill().catch(() => {})
      this.write(`\r\n${dim('[Restarted shell]')}\r\n`)
      await this.spawn()
    })
  }

  /**
   * Stop the running command: Ctrl+C (soft) or the Stop button (hard).
   * Ctrl+C first sends the terminal's SIGINT, which some programs handle
   * (a REPL shows a new prompt and keeps running, as natively). Under WASIX
   * many programs ignore it, so the shell's watchdog then kills the
   * command's processes (see shell.js), and if the prompt still doesn't
   * return, the shell is replaced.
   */
  async interrupt({ hard = true } = {}) {
    const process = this.#process
    if (!process) return
    if (!this.busy) {
      process.stdin?.write('\x03').catch(() => {})
      return
    }
    const command = this.#commands
    const stillRunning = () => this.#process === process && this.#commands === command && this.busy && !this.#closed
    const fs = this.#host.fs()
    this.write('^C')
    this.#host.onInterrupt(this)
    if (!hard) {
      // Makes the prompt report 130 if SIGINT ends the command.
      await fs?.writeText(sigintFile(this.id), '').catch(() => {})
      const output = this.#output
      process.stdin?.write('\x03').catch(() => {})
      const replied = () => this.#output !== output
      for (let waited = 0; stillRunning(); waited += 50) {
        if (replied() && REPL_PROMPT.test(this.#outputTail.replace(ANSI, '').trimEnd())) {
          await fs?.remove(sigintFile(this.id)).catch(() => {})
          return
        }
        if (waited >= (replied() ? SIGINT_OUTPUT_GRACE_MS : SIGINT_GRACE_MS)) break
        await sleep(50)
      }
      if (!stillRunning()) return
    }
    this.#stopping = true
    await fs?.writeText(interruptFile(this.id), 'interrupt\n').catch(() => {})
    if (hard) process.stdin?.write('\x03').catch(() => {})
    setTimeout(() => stillRunning() && process.stdin?.write('\r').catch(() => {}), UNBLOCK_MS)
    setTimeout(() => stillRunning() && this.#forceStop().catch((error) => this.#host.fail(error)), FORCE_STOP_MS)
  }

  async #forceStop() {
    await this.#replace(async () => {
      const old = this.#process
      this.#process = null
      await old.kill().catch(() => {})
      // The watchdog outlives the shell: have it stop the processes the
      // shell left behind, then tell it to exit.
      const fs = this.#host.fs()
      await fs?.writeText(interruptFile(this.id), 'interrupt\n').catch(() => {})
      await sleep(500)
      await fs?.writeText(stateFile(this.id), 'idle').catch(() => {})
      this.#setBusy(false)
      this.write(`\r\n${dim("[Stopped by restarting the shell. Files and history are kept; shell variables are reset.]")}\r\n`)
      await this.spawn()
    })
  }

  /** Type a command at the prompt, replacing anything half-typed. */
  async type(command) {
    const settle = PROMPT_SETTLE_MS - (performance.now() - this.#promptAt)
    if (settle > 0) await sleep(settle)
    this.#sentAt = performance.now()
    this.#atPrompt = false
    await this.#process?.stdin?.write(`\x15${command}\r`)
    this.#view?.focus()
  }

  /** Get a fresh prompt below messages printed by the app. */
  async newPrompt() {
    this.#process?.stdin?.write('\x15\r').catch(() => {})
    await this.waitForPrompt(3000)
  }

  async close() {
    this.#closed = true
    clearTimeout(this.#idleTimer)
    // Stop a running command first; killing only the shell would leave it.
    if (this.busy) {
      await this.interrupt()
      await this.waitForPrompt(1000)
    }
    const process = this.#process
    this.#process = null
    await process?.kill().catch(() => {})
  }
}
