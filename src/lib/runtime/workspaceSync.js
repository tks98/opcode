// Two-way sync planning between the editor's project state and the
// sandbox's /workspace directory. These functions are pure: they compare
// state against the last content both sides agreed on (the baseline) and
// return the operations to apply. ProjectSandbox performs the I/O.
//
// Baseline: { files: Map<path, string>, dirs: Set<path> }
// Snapshot (from the sandbox): { files: Map<path, {size, text, skipped?}>, dirs: Set<path> }
//   where `text` is the file contents, or null for binary or oversized files.
//   `skipped` files (see planScan) are left out of the editor: it keeps its
//   own copy, if it has one, and nothing is deleted on either side.

import { ancestors, isProjectPath, isWithin } from '../paths.js'

// How much of /workspace the editor mirrors, so a program can't grow a
// project until it can't be saved or shown. Generous: imports allow 2,000
// files and 50 MB (see App.svelte).
export const SYNC_LIMITS = { fileBytes: 1024 * 1024, files: 5000, bytes: 50 * 1000 * 1000 }

/**
 * Which of the files a scan found to read into the editor. `files`:
 * [{ path, size }]; `dirs`: [path]; `known`: { files, dirs }, paths the
 * editor or the baseline already has, which go first so new files can't
 * push them out. Returns { read, large, skipped, dirs } (Sets): large files
 * are shown as binaries (as before); skipped ones stay in the terminal only:
 * names the project can't hold as they are, and anything past the limits.
 * `dirs` are the folders to mirror.
 */
export function planScan(files, dirs, known, limits = SYNC_LIMITS) {
  const read = new Set()
  const large = new Set()
  const skipped = new Set()
  let count = 0
  let bytes = 0
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const knownFirst = [...files.filter((f) => known.files.has(f.path)).sort(byPath), ...files.filter((f) => !known.files.has(f.path)).sort(byPath)]
  for (const { path, size } of knownFirst) {
    if (!isProjectPath(path)) skipped.add(path)
    else if (size > limits.fileBytes) large.add(path)
    else if (bytes + size > limits.bytes || (!known.files.has(path) && count >= limits.files)) skipped.add(path)
    else {
      read.add(path)
      count++
      bytes += size
    }
  }
  // Folders: the ones the editor knows, those of files it shows, then new
  // ones up to the limit. (A folder left out is also left out of the
  // baseline, so a push never removes it from the terminal.)
  const shown = new Set()
  for (const path of read) for (const dir of ancestors(path)) shown.add(dir)
  const valid = [...dirs].filter(isProjectPath).sort()
  const mirrored = new Set(valid.filter((dir) => known.dirs.has(dir) || shown.has(dir)))
  for (const dir of valid) if (mirrored.size < limits.files) mirrored.add(dir)
  return { read, large, skipped, dirs: mirrored }
}

export function emptyBaseline() {
  return { files: new Map(), dirs: new Set() }
}

/** Directories implied by a list of file paths. */
export function impliedDirs(paths) {
  const dirs = new Set()
  for (const path of paths) for (const dir of ancestors(path)) dirs.add(dir)
  return dirs
}

/**
 * Editor → sandbox. Returns files to write or remove and folders to create
 * or remove so /workspace matches the editor.
 */
export function planPush(editorFiles, editorFolders, baseline) {
  const writes = []
  const removes = []
  const mkdirs = []
  const rmdirs = []

  const editorPaths = new Set()
  for (const file of editorFiles) {
    editorPaths.add(file.path)
    // A copy: the editor's file can change while the write is under way, and
    // the baseline must record what was written.
    if (baseline.files.get(file.path) !== file.content) writes.push({ path: file.path, content: file.content })
  }
  for (const path of baseline.files.keys()) {
    if (!editorPaths.has(path)) removes.push(path)
  }

  const wanted = new Set([...editorFolders, ...impliedDirs(editorPaths)])
  for (const dir of editorFolders) {
    if (!baseline.dirs.has(dir)) mkdirs.push(dir)
  }
  for (const dir of baseline.dirs) {
    // Remove only the outermost folder that disappeared from the editor.
    if (wanted.has(dir)) continue
    if (ancestors(dir).some((parent) => baseline.dirs.has(parent) && !wanted.has(parent))) continue
    rmdirs.push(dir)
  }

  mkdirs.sort((a, b) => a.length - b.length)
  return { writes, removes, mkdirs, rmdirs }
}

/** Record that a push succeeded, so the baseline reflects the editor. */
export function applyPushToBaseline(baseline, plan) {
  for (const path of plan.removes) baseline.files.delete(path)
  for (const dir of plan.rmdirs) {
    for (const path of [...baseline.files.keys()]) if (isWithin(path, dir)) baseline.files.delete(path)
    for (const other of [...baseline.dirs]) if (isWithin(other, dir)) baseline.dirs.delete(other)
  }
  for (const file of plan.writes) {
    baseline.files.set(file.path, file.content)
    for (const dir of ancestors(file.path)) baseline.dirs.add(dir)
  }
  for (const dir of plan.mkdirs) {
    baseline.dirs.add(dir)
    for (const parent of ancestors(dir)) baseline.dirs.add(parent)
  }
}

/**
 * Sandbox → editor. Changes made in the terminal win unless the editor
 * changed the same file since the baseline; the editor's version is then
 * kept and pushed on the next sync.
 */
export function planPull(snapshot, editorFiles, editorFolders, baseline) {
  const upserts = []
  const deletes = []
  const binaries = []
  const addFolders = []
  const removeFolders = []

  const editorByPath = new Map(editorFiles.map((file) => [file.path, file]))

  for (const [path, entry] of snapshot.files) {
    const editor = editorByPath.get(path)
    const base = baseline.files.get(path)
    if (entry.skipped) {
      // Not mirrored (see planScan): the editor keeps its copy, if any.
      if (!editor && binaries.length < SYNC_LIMITS.files) binaries.push({ path, size: entry.size })
      continue
    }
    if (entry.text === null) {
      if (binaries.length < SYNC_LIMITS.files) binaries.push({ path, size: entry.size })
      // A text file the terminal overwrote with binary data (e.g. a compiler
      // output) leaves the editor unless it has unsynced edits.
      if (editor && editor.content === base) deletes.push(path)
      continue
    }
    if (!editor) {
      // New in the terminal, or deleted in the editor after the last push.
      if (base === undefined) upserts.push({ path, content: entry.text })
      continue
    }
    if (entry.text === editor.content) continue
    const editorChanged = base !== undefined && editor.content !== base
    if (!editorChanged) upserts.push({ path, content: entry.text })
  }

  for (const [path, base] of baseline.files) {
    if (snapshot.files.has(path)) continue
    const editor = editorByPath.get(path)
    // Deleted in the terminal; keep it if the editor has unsynced edits.
    if (editor && editor.content === base) deletes.push(path)
  }

  // Folders: show directories that hold no editor-visible text files, and
  // forget explicit folders the terminal removed.
  const textPaths = [...snapshot.files].filter(([, entry]) => entry.text !== null).map(([path]) => path)
  const implied = impliedDirs(textPaths)
  const folders = new Set(editorFolders)
  for (const dir of snapshot.dirs) {
    if (!implied.has(dir) && !folders.has(dir)) addFolders.push(dir)
  }
  for (const dir of editorFolders) {
    if (!snapshot.dirs.has(dir) && baseline.dirs.has(dir)) removeFolders.push(dir)
  }

  return { upserts, deletes, binaries, addFolders, removeFolders }
}

/** Make the baseline match a snapshot after its pull plan was applied. */
export function applyPullToBaseline(baseline, snapshot, plan, editorFiles) {
  const editorPaths = new Set(editorFiles.map((file) => file.path))
  for (const { path } of plan.upserts) editorPaths.add(path)
  for (const path of plan.deletes) editorPaths.delete(path)

  // The baseline becomes what /workspace holds now. Files the editor edited
  // (or deleted) since the last push keep a baseline entry, so the next push
  // writes (or removes) them.
  const files = new Map()
  for (const [path, entry] of snapshot.files) {
    // A skipped file keeps what the baseline had (the editor didn't change).
    if (entry.skipped && baseline.files.has(path)) files.set(path, baseline.files.get(path))
    if (entry.text === null) continue
    if (editorPaths.has(path) || baseline.files.has(path)) files.set(path, entry.text)
  }
  baseline.files = files
  baseline.dirs = new Set(snapshot.dirs)
}

/** Heuristic text detection: valid UTF-8 without NUL bytes. */
export function decodeText(bytes) {
  const probe = bytes.subarray(0, 8192)
  if (probe.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
