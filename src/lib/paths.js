// Project paths are POSIX-style and relative to the project root, which the
// terminal sees as /workspace (e.g. "src/main.c" ↔ /workspace/src/main.c).

export const WORKSPACE_ROOT = '/workspace'

// Opcode's own shell configuration lives here; it is hidden from the editor.
export const INTERNAL_DIR = '.opcode'

// Directories that are never mirrored into the editor: tool caches, package
// installs and Opcode's own state. They still exist in the terminal.
const IGNORED_DIRS = new Set([INTERNAL_DIR, '.git', 'node_modules', '__pycache__', '.cache', '.npm', '.pnpm-store'])

/**
 * Normalize user input into a project path. Throws on empty paths, `..`
 * segments and characters that cannot appear in file names.
 */
export function normalizePath(input) {
  const raw = String(input ?? '').trim().replaceAll('\\', '/')
  const segments = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new Error('Paths cannot contain ".."')
    if (/[\0<>:"|?*]/.test(segment)) throw new Error(`"${segment}" contains characters that are not allowed in file names`)
    segments.push(segment)
  }
  if (segments.length === 0) throw new Error('A name is required')
  // The terminal reads its startup files from there: a project file there
  // would replace them.
  if (segments[0] === INTERNAL_DIR) throw new Error(`"${INTERNAL_DIR}" is reserved for Opcode's own files`)
  return segments.join('/')
}

/** Like normalizePath, but returns null instead of throwing. */
export function tryNormalizePath(input) {
  try {
    return normalizePath(input)
  } catch {
    return null
  }
}

export function basename(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

/** Parent directory of a project path; '' for top-level entries. */
export function dirname(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** Lower-case extension including the dot, or '' (".bashrc" has none). */
export function extname(path) {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index).toLowerCase() : ''
}

/** File name without its extension. */
export function stem(path) {
  const name = basename(path)
  const ext = extname(name)
  return ext ? name.slice(0, -ext.length) : name
}

export function joinPath(...parts) {
  return parts.filter(Boolean).join('/')
}

/** Every ancestor directory of a path, outermost first. */
export function ancestors(path) {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** True if `path` is `dir` itself or lies inside it. */
export function isWithin(path, dir) {
  return path === dir || path.startsWith(`${dir}/`)
}

/** Re-root `path` from directory `from` to `to` (used when renaming folders). */
export function reparent(path, from, to) {
  return path === from ? to : `${to}${path.slice(from.length)}`
}

/** True if a path should stay out of the editor (see IGNORED_DIRS). */
export function isIgnoredPath(path) {
  return path.split(/[/\\]/).some((segment) => IGNORED_DIRS.has(segment))
}

export function toWorkspacePath(path) {
  return path ? `${WORKSPACE_ROOT}/${path}` : WORKSPACE_ROOT
}

/** Convert an absolute guest path back to a project path (null if outside). */
export function fromWorkspacePath(absolute) {
  if (absolute === WORKSPACE_ROOT) return ''
  if (!absolute.startsWith(`${WORKSPACE_ROOT}/`)) return null
  return absolute.slice(WORKSPACE_ROOT.length + 1)
}

/** Sort comparator: folders first, then case-insensitive natural order. */
export function compareNames(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}
