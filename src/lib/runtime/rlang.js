// R, with webR (R compiled to WebAssembly, https://webr.r-wasm.org): the
// shell's Rscript and R commands forward to Opcode (like javac), which runs
// them here. Rscript gets a fresh R for each run, with the project's files
// mirrored in and the files it writes copied back; R (the console) keeps one
// R per terminal and evaluates what is typed there (see R() in shell.js).
// Plots go to PNG files, which Opcode shows in the preview.
//
// R prints its own messages, errors and warnings (the helpers below), so they
// read as in a real R.

// What every R session starts with: plots to PNG files in PLOTS, warnings
// printed when they happen, and a runner that evaluates expressions like the
// console (printing visible values) and reports errors like R.
const PLOTS = '/tmp/opcode-plots'
const SETUP = `
local({
  dir.create("${PLOTS}", showWarnings = FALSE, recursive = TRUE)
  dir.create("/tmp/opcode-screen", showWarnings = FALSE, recursive = TRUE)
})
.opcode <- new.env()
.opcode$quit <- function(...) stop(structure(class = c("opcode_quit", "condition"), list(message = "quit", call = NULL)))
.opcode$device <- function(file) function(...) {
  grDevices::png(file, width = 800, height = 600, res = 110)
  grDevices::dev.control("enable")
}
.opcode$describe <- function(call) {
  # Calls made by this runner itself mean "at the top level".
  if (is.null(call) || identical(call[[1]], quote(eval)) || identical(call[[1]], quote(withVisible))) return(NULL)
  paste(deparse(call, nlines = 1), collapse = "")
}
.opcode$run <- function(code, file, halt) {
  # Syntax errors as R reports them: Rscript names the file, the console
  # quotes the line.
  exprs <- tryCatch(parse(text = code), error = function(e) {
    lines <- strsplit(conditionMessage(e), "\n")[[1]]
    if (!nzchar(file)) {
      at <- regmatches(lines[1], regexec("^<text>:([0-9]+):[0-9]+: (.*)$", lines[1]))[[1]]
      source <- strsplit(code, "\n")[[1]][as.integer(at[2])]
      cat("Error: ", at[3], ' in "', source, '"', "\n", sep = "", file = stderr())
    } else {
      cat("Error: ", sub("^<text>", file, paste(lines, collapse = "\n")), "\n", sep = "", file = stderr())
      if (halt) cat("Execution halted\n", file = stderr())
    }
    NULL
  })
  if (is.null(exprs)) return(1L)
  tryCatch(withCallingHandlers({
    for (e in exprs) {
      r <- withVisible(eval(e, globalenv()))
      if (r$visible) print(r$value)
    }
    0L
  }, warning = function(w) {
    call <- .opcode$describe(conditionCall(w))
    cat(if (is.null(call)) "Warning message:\\n" else paste0("Warning message:\\nIn ", call, " :\\n  "), conditionMessage(w), "\\n", sep = "", file = stderr())
    invokeRestart("muffleWarning")
  }), opcode_quit = function(q) 2L, error = function(e) {
    call <- .opcode$describe(conditionCall(e))
    cat(if (is.null(call)) "Error: " else paste0("Error in ", call, " : "), conditionMessage(e), "\\n", sep = "", file = stderr())
    if (halt) cat("Execution halted\\n", file = stderr())
    1L
  })
}
.opcode$snapshot <- function(file) {
  if (grDevices::dev.cur() == 1) return(FALSE)
  plot <- tryCatch(grDevices::recordPlot(), error = function(e) NULL)
  if (is.null(plot)) return(FALSE)
  current <- grDevices::dev.cur()
  grDevices::png(file, width = 800, height = 600, res = 110)
  ok <- tryCatch({ grDevices::replayPlot(plot); TRUE }, error = function(e) FALSE)
  grDevices::dev.off()
  grDevices::dev.set(current)
  ok
}
q <- quit <- function(...) .opcode$quit()
`

const decoder = new TextDecoder()

/** Is this R code complete, or does it need more lines (like R's "+" prompt)? */
async function parseStatus(webR, code) {
  return webR.evalRString(
    `tryCatch({ parse(text = code); "complete" }, error = function(e) if (grepl("unexpected end of input|INCOMPLETE_STRING|unexpected INCOMPLETE", conditionMessage(e))) "incomplete" else "error")`,
    { env: { code } },
  )
}

/** Directory listing of the webR file system: [{ path, folder }] under `dir`. */
function walk(node, dir) {
  const entries = []
  for (const [name, child] of Object.entries(node?.contents ?? {})) {
    const path = `${dir}/${name}`
    entries.push({ path, folder: child.isFolder })
    if (child.isFolder) entries.push(...walk(child, path))
  }
  return entries
}

async function readPlots(webR, prefix) {
  const node = await webR.FS.lookupPath(PLOTS).catch(() => null)
  const plots = []
  for (const name of Object.keys(node?.contents ?? {}).sort()) {
    if (!name.startsWith(prefix)) continue
    plots.push(await webR.FS.readFile(`${PLOTS}/${name}`))
    await webR.FS.unlink(`${PLOTS}/${name}`)
  }
  return plots
}

/** Output of R code run with the helpers: { text, code } (code: 0 ok, 1 error, 2 quit). */
// (webR passes JavaScript values to R; null would arrive as NA, and empty
// arrays not at all, so strings stand in for them.)
async function evaluate(webR, code, { halt, file = '' }) {
  const shelter = await new webR.Shelter()
  try {
    const { result, output } = await shelter.captureR(`.opcode$run(code, file, halt)`, {
      env: { code, halt, file },
      captureStreams: true,
      captureConditions: false,
      // Plots go to PNG files (see SETUP), not webR's canvas.
      captureGraphics: false,
      withAutoprint: false,
    })
    const text = output.map((line) => `${line.data}\n`).join('')
    return { text, code: await result.toNumber() }
  } finally {
    await shelter.purge()
  }
}

export function createR(WebR, baseUrl) {
  async function start() {
    const webR = new WebR({ baseUrl, interactive: false })
    await webR.init()
    await webR.evalRVoid(SETUP)
    return webR
  }

  /**
   * Rscript: run a file (or -e code) in a fresh R. `files` is the project
   * ({ absolutePath: bytes }); resolves to { code, output, written, plots }:
   * the files it wrote ({ absolutePath: bytes }) and its plots (PNG bytes).
   */
  async function runScript({ cwd, file, expression, args = [], files = {} }) {
    const webR = await start()
    try {
      for (const [path, bytes] of Object.entries(files)) {
        const parts = path.split('/').filter(Boolean)
        for (let i = 1; i < parts.length; i++) await webR.FS.mkdir(`/${parts.slice(0, i).join('/')}`).catch(() => {})
        await webR.FS.writeFile(path, bytes)
      }
      for (const dir of ['/workspace', cwd]) await webR.FS.mkdir(dir).catch(() => {})
      const script = file ? (file.startsWith('/') ? file : `${cwd}/${file}`) : null
      let source = expression
      if (script) {
        const bytes = await webR.FS.readFile(script).catch(() => null)
        if (!bytes) return { code: 2, output: `Fatal error: cannot open file '${file}': No such file or directory\n`, written: {}, plots: [] }
        source = decoder.decode(bytes)
      }
      await webR.evalRVoid(
        `setwd(cwd)
        options(device = .opcode$device("${PLOTS}/page-%03d.png"))
        local({
          args <- if (nzchar(argv)) strsplit(argv, "\u0001", fixed = TRUE)[[1]] else character(0)
          script <- script
          assign("commandArgs", function(trailingOnly = FALSE) if (trailingOnly) args else c("Rscript", if (nzchar(script)) paste0("--file=", script), if (length(args)) "--args", args), envir = globalenv())
        })`,
        { env: { cwd, argv: args.join('\u0001'), script: script ?? '' } },
      )
      let { text, code } = await evaluate(webR, source, { halt: true, file: file ?? '' })
      if (code === 2) code = 0 // q() ends the script
      await webR.evalRVoid('grDevices::graphics.off()')
      const plots = await readPlots(webR, 'page-')

      // Files it created or changed.
      const written = {}
      const tree = await webR.FS.lookupPath('/workspace').catch(() => null)
      for (const { path, folder } of walk(tree, '/workspace')) {
        if (folder) continue
        const bytes = await webR.FS.readFile(path)
        const before = files[path]
        if (!before || before.length !== bytes.length || before.some((byte, i) => byte !== bytes[i])) written[path] = bytes
      }
      return { code, output: text, written, plots }
    } finally {
      webR.close()
    }
  }

  // The R console: one R per terminal.
  const consoles = new Map() // key -> Promise<{ webR, lastPlot }>

  async function consoleFor(key, cwd) {
    if (!consoles.has(key)) {
      const promise = start().then(async (webR) => {
        await webR.FS.mkdir('/workspace').catch(() => {})
        await webR.evalRVoid(`setwd(cwd); options(device = .opcode$device("/tmp/opcode-screen/page-%03d.png"))`, { env: { cwd } }).catch(() => {})
        return { webR, lastPlot: null }
      })
      consoles.set(key, promise)
      promise.catch(() => consoles.delete(key))
    }
    return consoles.get(key)
  }

  /**
   * Evaluate a line (or lines) typed in the R console. Resolves to
   * { status, output, plot }: status 'incomplete' (R wants more lines),
   * 'ok', 'error' or 'quit'; plot: the current plot (PNG) if it changed.
   */
  async function consoleEval(key, cwd, code) {
    const session = await consoleFor(key, cwd)
    const { webR } = session
    const parsed = await parseStatus(webR, code)
    if (parsed === 'incomplete') return { status: 'incomplete', output: '', plot: null }
    const { text, code: result } = await evaluate(webR, code, { halt: false })
    if (result === 2) {
      consoles.delete(key)
      webR.close()
      return { status: 'quit', output: text, plot: null }
    }
    let plot = null
    if (await webR.evalRBoolean(`.opcode$snapshot("${PLOTS}/snapshot.png")`)) {
      const [bytes] = await readPlots(webR, 'snapshot')
      if (bytes && !(session.lastPlot && session.lastPlot.length === bytes.length && session.lastPlot.every((byte, i) => byte === bytes[i]))) plot = bytes
      session.lastPlot = bytes ?? null
    }
    return { status: result === 0 ? 'ok' : 'error', output: text, plot }
  }

  function closeConsole(key) {
    const session = consoles.get(key)
    consoles.delete(key)
    session?.then(({ webR }) => webR.close()).catch(() => {})
  }

  return { runScript, consoleEval, closeConsole }
}

/** The R webR provides. */
export const R_VERSION = 'R version 4.6.0 (2026-04-24)'

/**
 * Rscript's command line: { file, expression, args }, or { version } or
 * { help }. `R -e`, `R -f file` and `R --file=file` mean the same.
 */
export function parseRscriptArgs(args) {
  const expressions = []
  const rest = []
  let file = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--args') {
      rest.push(...args.slice(i + 1))
      break
    }
    if (file !== null || (expressions.length && !arg.startsWith('-'))) rest.push(arg)
    else if (arg === '-e') expressions.push(args[++i] ?? '')
    else if (arg === '-f') file = args[++i] ?? ''
    else if (arg.startsWith('--file=')) file = arg.slice('--file='.length)
    else if (arg === '--version') return { version: true }
    else if (arg === '--help' || arg === '-h') return { help: true }
    else if (arg.startsWith('-')) continue // --vanilla, --quiet, --default-packages=…: nothing to do here
    else file = arg
  }
  if (!expressions.length && !file) return { help: true }
  return { file: expressions.length ? null : file, expression: expressions.length ? expressions.join('\n') : null, args: rest }
}
