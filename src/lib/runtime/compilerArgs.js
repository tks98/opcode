// Argument translation for the browser-hosted Clang. The compiler runs over
// a virtual filesystem rooted at "/" (with the project under /workspace)
// and has no notion of a working directory, so relative paths from the
// shell are rewritten to absolute ones.

const PLUS_TOOLS = new Set(['clang++', 'g++', 'c++'])
const SOURCE_FILE = /\.(c|cc|cpp|cxx|c\+\+|C)$/
const CXX_SOURCE_FILE = /\.(cc|cpp|cxx|c\+\+|C)$/

// WASI's C library cannot tell that stdout is a terminal, so it would fully
// buffer output and a prompt like printf("Name? ") would not appear before
// scanf() waits. Every program is compiled with this header force-included.
export const UNBUFFERED_HEADER = '/opcode/unbuffered_stdio.h'
export const COMPILER_SUPPORT_FILES = {
  opcode: {
    'unbuffered_stdio.h': new TextEncoder().encode(
      '/* Added by Opcode: show output immediately, like a native terminal. */\n' +
        '#include <stdio.h>\n' +
        '__attribute__((constructor)) static void __opcode_unbuffered_stdio(void) { setvbuf(stdout, NULL, _IONBF, 0); }\n',
    ),
  },
}

// Options whose following argument is a path.
const PATH_VALUE = new Set(['-o', '-I', '-L', '-include', '-imacros', '-isystem', '-iquote', '-idirafter', '-MF', '--sysroot'])
// Options whose following argument is a value that is not a path.
const PLAIN_VALUE = new Set(['-x', '-D', '-U', '-MT', '-MQ', '-target', '--target', '-Xlinker', '-Xclang', '-mllvm', '-arch', '-z'])
// Options with a path joined to the flag, e.g. -I../include.
const JOINED_PATH = ['-isystem', '-iquote', '-idirafter', '-include', '-I', '-L']

/** Resolve a POSIX path against a directory, collapsing . and .. segments. */
export function resolvePath(cwd, path) {
  const parts = path.startsWith('/') ? [] : cwd.split('/')
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.filter(Boolean).join('/')}`
}

/**
 * Map a shell invocation (`g++ -o app main.cpp`) to the YoWASP command and
 * absolute arguments. `cwd` is the shell's absolute working directory.
 */
export function mapCompilerArgs(tool, args, cwd) {
  const inputs = args.filter((arg) => !arg.startsWith('-'))
  // `gcc main.cpp` would compile but fail to link the C++ library; build
  // C++ sources as C++ whichever name was typed.
  const cxx = PLUS_TOOLS.has(tool) || inputs.some((arg) => CXX_SOURCE_FILE.test(arg))
  const mapped = ['-fcolor-diagnostics']
  if (inputs.some((arg) => SOURCE_FILE.test(arg)) && !args.includes('-E')) mapped.push('-include', UNBUFFERED_HEADER)
  // The bundled C++ runtime is built without exception support.
  if (cxx && !args.includes('-fexceptions')) mapped.push('-fno-exceptions')

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (PATH_VALUE.has(arg) && i + 1 < args.length) {
      mapped.push(arg, resolvePath(cwd, args[++i]))
    } else if (PLAIN_VALUE.has(arg) && i + 1 < args.length) {
      mapped.push(arg, args[++i])
    } else if (!arg.startsWith('-') || arg === '-') {
      mapped.push(arg === '-' ? arg : resolvePath(cwd, arg))
    } else {
      const prefix = JOINED_PATH.find((p) => arg.startsWith(p) && arg.length > p.length)
      mapped.push(prefix ? prefix + resolvePath(cwd, arg.slice(prefix.length)) : arg)
    }
  }
  return { tool: cxx ? 'clang++' : 'clang', args: mapped }
}

/** Show compiler paths relative to the shell's directory, as typed. */
export function prettifyOutput(text, cwd) {
  const here = cwd.endsWith('/') ? cwd : `${cwd}/`
  return text.replaceAll(here, '').replaceAll('/workspace/', '~/')
}
