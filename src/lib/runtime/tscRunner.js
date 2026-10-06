// tsc on a file system in memory: the TypeScript compiler's own command line
// (ts.executeCommandLine), given the project's files and the bundled type
// definitions (TypeScript's lib files, @types/node; see
// scripts/copy-npm-toolchains.mjs). It prints what tsc prints, colors and
// all, and returns the files it wrote. tsc.worker.js runs it.

// Where the compiler appears to run from: its lib files sit beside it.
const EXECUTABLE = '/opcode/typescript/lib/tsc.js'

class Exit {
  constructor(code) {
    this.code = code
  }
}

/**
 * @param ts the TypeScript compiler (typescript.js's `ts`)
 * @param bundled Map of path -> text: type definitions every run can see
 */
export function createTsc(ts, bundled) {
  /**
   * Without a tsconfig.json, real tsc 6 compiles files given on the command
   * line as ES modules and without Node's types. Here programs run with
   * node, so they get Node's settings unless the command line says otherwise.
   */
  function withNodeDefaults(args) {
    const parsed = ts.parseCommandLine(args)
    if (!parsed.fileNames.length || args.some((arg) => /^(-b|--build)$/.test(arg))) return args
    const extra = []
    if (parsed.options.module === undefined) extra.push('--module', 'nodenext')
    if (parsed.options.types === undefined) extra.push('--types', 'node')
    return [...extra, ...args]
  }

  /** Run tsc: { code, output, outputs } (outputs: the files it wrote). */
  function run({ cwd, args, files: projectFiles, columns }) {
    const files = new Map(bundled)
    for (const [path, text] of Object.entries(projectFiles)) files.set(path, text)
    const absolute = (path) => ts.getNormalizedAbsolutePath(path, cwd)
    const entries = (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const names = new Set()
      const dirs = new Set()
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash === -1) names.add(rest)
        else dirs.add(rest.slice(0, slash))
      }
      return { files: [...names].sort(), directories: [...dirs].sort() }
    }
    const isDirectory = (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      for (const path of files.keys()) if (path.startsWith(prefix)) return true
      return false
    }

    let output = ''
    const outputs = {}
    const system = {
      args,
      newLine: '\n',
      useCaseSensitiveFileNames: true,
      write: (text) => (output += text),
      writeOutputIsTTY: () => true,
      getWidthOfTerminal: () => columns || 80,
      readFile: (path) => files.get(absolute(path)),
      getFileSize: (path) => files.get(absolute(path))?.length ?? 0,
      writeFile: (path, text) => {
        files.set(absolute(path), text)
        outputs[absolute(path)] = text
      },
      deleteFile: (path) => files.delete(absolute(path)),
      resolvePath: absolute,
      realpath: absolute,
      fileExists: (path) => files.has(absolute(path)),
      directoryExists: (path) => absolute(path) === '/' || isDirectory(absolute(path)),
      createDirectory: () => {},
      getExecutingFilePath: () => EXECUTABLE,
      getCurrentDirectory: () => cwd,
      getDirectories: (path) => entries(absolute(path)).directories,
      readDirectory: (path, extensions, excludes, includes, depth) => ts.matchFiles(absolute(path), extensions, excludes, includes, true, cwd, depth, entries, absolute),
      getModifiedTime: () => new Date(0),
      getEnvironmentVariable: () => '',
      exit: (code) => {
        throw new Exit(code ?? 0)
      },
    }
    let code = 0
    try {
      ts.executeCommandLine(system, () => {}, withNodeDefaults(args))
    } catch (error) {
      if (!(error instanceof Exit)) throw error
      code = error.code
    }
    return { code, output, outputs }
  }

  return { run, version: ts.version }
}
