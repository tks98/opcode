// ============================================
// PROJECT STORE
// ============================================
// Projects, their files (addressed by path, e.g. "src/main.c") and editor
// UI state. Svelte 5 deep state: mutations below are tracked automatically.
// State is persisted to IndexedDB (see persistence.js), debounced.

import { LoadError, loadState, saveState, saveStateNow } from '../persistence.js'
import { LANGUAGES, languageForFiles } from '../languages.js'
import { ancestors, dirname, extname, isWithin, joinPath, normalizePath, reparent, stem, tryNormalizePath } from '../paths.js'

const SAVE_DELAY_MS = 400

function generateId() {
  return Math.random().toString(36).slice(2, 10)
}

function newFile(path, content = '') {
  return { id: generateId(), path, content }
}

export function createProjectData(name, language = 'python') {
  // Linux projects are a whole machine ('linux', or 'docker' with Docker).
  if (language === 'linux' || language === 'docker') {
    const now = Date.now()
    return { id: generateId(), kind: 'linux', name, language, files: [], folders: [], openFileIds: [], activeFileId: null, history: '', createdAt: now, updatedAt: now }
  }
  const starter = LANGUAGES[language]?.starter ?? LANGUAGES.python.starter
  const file = newFile(starter.path, starter.content)
  const more = (starter.more ?? []).map(({ path, content }) => newFile(path, content))
  const now = Date.now()
  return {
    id: generateId(),
    kind: 'code',
    name,
    language,
    files: [file, ...more],
    folders: [],
    openFileIds: [file.id, ...more.map((f) => f.id)],
    activeFileId: file.id,
    history: '',
    createdAt: now,
    updatedAt: now,
  }
}

// Bring projects saved by older builds (flat `name` files, isDirty flags)
// up to the current shape.
export function migrateProject(project) {
  const seen = new Set()
  const files = []
  for (const file of project.files ?? []) {
    let path = tryNormalizePath(file.path ?? file.name) ?? `untitled-${file.id ?? generateId()}`
    while (seen.has(path)) path = `${stem(path)}-copy${extname(path)}`
    seen.add(path)
    files.push({ id: file.id ?? generateId(), path, content: String(file.content ?? '') })
  }
  const ids = new Set(files.map((f) => f.id))
  const openFileIds = (project.openFileIds ?? []).filter((id) => ids.has(id))
  const kind = project.kind === 'linux' ? 'linux' : 'code'
  return {
    id: project.id ?? generateId(),
    kind,
    name: project.name || 'My Project',
    language: kind === 'linux' ? (project.language === 'docker' ? 'docker' : 'linux') : LANGUAGES[project.language] ? project.language : 'python',
    files,
    folders: [...new Set((project.folders ?? []).map(tryNormalizePath).filter(Boolean))],
    openFileIds,
    activeFileId: ids.has(project.activeFileId) ? project.activeFileId : (openFileIds[0] ?? files[0]?.id ?? null),
    history: typeof project.history === 'string' ? project.history : '',
    createdAt: project.createdAt ?? Date.now(),
    updatedAt: project.updatedAt ?? project.createdAt ?? Date.now(),
  }
}

/** A project name like "Python project", "Python project 2" that is not taken. */
export function uniqueProjectName(projects, base) {
  const taken = new Set(projects.map((p) => p.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`
}

/** Pick a path like "untitled.py", "untitled-2.py" that is not taken. */
export function uniquePath(project, desired) {
  const taken = (path) => project.files.some((f) => f.path === path) || project.folders.includes(path)
  if (!taken(desired)) return desired
  const dir = dirname(desired)
  const ext = extname(desired)
  const base = stem(desired)
  for (let n = 2; ; n++) {
    const candidate = joinPath(dir, `${base}-${n}${ext}`)
    if (!taken(candidate)) return candidate
  }
}

// ============================================
// STATE
// ============================================

const state = $state({
  loaded: false,
  loadError: null, // saved projects couldn't be read: don't save over them
  projects: [],
  activeProjectId: null,
  saveError: null,
})

let saveTimer = null

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, SAVE_DELAY_MS)
}

const snapshot = () => ({ version: 2, projects: $state.snapshot(state.projects), activeProjectId: state.activeProjectId })

async function flushSave() {
  clearTimeout(saveTimer)
  saveTimer = null
  if (!state.loaded || state.loadError) return
  try {
    await saveState(snapshot())
    state.saveError = null
  } catch (error) {
    state.saveError = error.message || 'Could not save your projects'
  }
}

if (typeof document !== 'undefined') {
  // Persist promptly when the tab is hidden or closed. The IndexedDB write
  // may not finish before the page is gone, so also keep a copy written
  // synchronously (loadState takes the newer).
  const saveBeforeLeaving = () => {
    if (!saveTimer || !state.loaded || state.loadError) return
    saveStateNow(snapshot())
    flushSave()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveBeforeLeaving()
  })
  window.addEventListener('pagehide', saveBeforeLeaving)
}

// Remember when a project was last used (the start screen lists recent ones).
function touch(project) {
  project.updatedAt = Date.now()
}

function findProject(id) {
  return state.projects.find((p) => p.id === id) ?? null
}

function pathExists(project, path) {
  return project.files.some((f) => f.path === path) || project.folders.includes(path) || project.files.some((f) => isWithin(f.path, path) && f.path !== path)
}

function assertAvailable(project, path) {
  for (const dir of ancestors(path)) {
    if (project.files.some((f) => f.path === dir)) throw new Error(`"${dir}" is a file, not a folder`)
  }
  if (pathExists(project, path)) throw new Error(`"${path}" already exists`)
}

function removeFiles(project, predicate) {
  const removed = new Set(project.files.filter(predicate).map((f) => f.id))
  if (removed.size === 0) return
  project.files = project.files.filter((f) => !removed.has(f.id))
  project.openFileIds = project.openFileIds.filter((id) => !removed.has(id))
  if (removed.has(project.activeFileId)) {
    project.activeFileId = project.openFileIds.at(-1) ?? null
  }
}

// Deleting the last file in a folder keeps the folder, like a file manager.
function keepParentFolder(project, path) {
  const parent = dirname(path)
  if (parent && !project.folders.includes(parent) && !project.files.some((f) => isWithin(f.path, parent))) {
    project.folders.push(parent)
  }
}

// ============================================
// EXPORTED STORE
// ============================================

export const projectStore = {
  /** Load saved projects; resolves once the store is ready to render. */
  async load() {
    if (state.loaded) return
    let saved = null
    try {
      saved = await loadState()
    } catch (error) {
      console.warn('Could not load saved projects:', error)
      // Not "no projects": saving now would replace them.
      if (error instanceof LoadError) state.loadError = error.message
    }
    // No projects (a first visit) shows the start screen.
    const projects = (saved?.projects ?? []).map(migrateProject)
    state.projects = projects
    state.activeProjectId = projects.some((p) => p.id === saved?.activeProjectId) ? saved.activeProjectId : (projects[0]?.id ?? null)
    state.loaded = true
    if (saved && saved.version !== 2) scheduleSave()
  },

  get loaded() { return state.loaded },
  get loadError() { return state.loadError },
  get saveError() { return state.saveError ?? state.loadError },
  get projects() { return state.projects },
  get activeProjectId() { return state.activeProjectId },
  get activeProject() { return findProject(state.activeProjectId) ?? state.projects[0] ?? null },

  getProject(id) {
    return findProject(id)
  },

  // ---------- Projects ----------

  createProject(name, language = 'python', { activate = true } = {}) {
    const project = createProjectData(name.trim() || 'Untitled Project', language)
    state.projects.push(project)
    if (activate) state.activeProjectId = project.id
    scheduleSave()
    return project.id
  },

  /** Add a project with the given files (used by ZIP import). */
  importProject(name, files) {
    const project = createProjectData(uniqueProjectName(state.projects, name), 'python')
    project.files = []
    project.openFileIds = []
    for (const { path, content } of files) {
      const normalized = tryNormalizePath(path)
      if (normalized && !project.files.some((f) => f.path === normalized)) project.files.push(newFile(normalized, content))
    }
    if (project.files.length === 0) project.files.push(newFile('main.py', ''))
    const first = project.files.find((f) => !f.path.includes('/')) ?? project.files[0]
    project.openFileIds = [first.id]
    project.activeFileId = first.id
    project.language = languageForFiles(project.files)
    state.projects.push(project)
    state.activeProjectId = project.id
    scheduleSave()
    return project.id
  },

  /** Delete a project. Deleting the last one leads back to the start screen. */
  deleteProject(id) {
    const index = state.projects.findIndex((p) => p.id === id)
    if (index === -1) return false
    state.projects.splice(index, 1)
    if (state.activeProjectId === id) {
      state.activeProjectId = state.projects[Math.max(0, index - 1)]?.id ?? null
    }
    scheduleSave()
    return true
  },

  renameProject(id, name) {
    const project = findProject(id)
    if (project && name.trim()) {
      project.name = name.trim()
      scheduleSave()
    }
  },

  setActiveProject(id) {
    const project = findProject(id)
    if (project) {
      state.activeProjectId = id
      touch(project)
      scheduleSave()
    }
  },

  // ---------- Files (active project) ----------

  get files() { return this.activeProject?.files ?? [] },
  get folders() { return this.activeProject?.folders ?? [] },
  get activeFileId() { return this.activeProject?.activeFileId ?? null },

  get activeFile() {
    const project = this.activeProject
    return project?.files.find((f) => f.id === project.activeFileId) ?? null
  },

  get openFiles() {
    const project = this.activeProject
    if (!project) return []
    return project.openFileIds.map((id) => project.files.find((f) => f.id === id)).filter(Boolean)
  },

  /** Create a file and open it. Throws a user-facing Error on bad input. */
  createFile(path, content = '') {
    const project = this.activeProject
    const normalized = normalizePath(path)
    assertAvailable(project, normalized)
    const file = newFile(normalized, content)
    project.files.push(file)
    project.folders = project.folders.filter((dir) => !ancestors(normalized).includes(dir))
    project.openFileIds.push(file.id)
    project.activeFileId = file.id
    touch(project)
    scheduleSave()
    return file.id
  },

  /** Add uploaded files to the active project, renaming on conflicts. */
  addFiles(files) {
    const project = this.activeProject
    const added = []
    for (const { path, content } of files) {
      const normalized = tryNormalizePath(path)
      if (!normalized) continue
      const file = newFile(uniquePath(project, normalized), content)
      project.files.push(file)
      added.push(file)
    }
    if (added.length) {
      if (!project.openFileIds.includes(added[0].id)) project.openFileIds.push(added[0].id)
      project.activeFileId = added[0].id
      project.folders = project.folders.filter((dir) => !project.files.some((f) => isWithin(f.path, dir)))
      touch(project)
      scheduleSave()
    }
    return added.length
  },

  createFolder(path) {
    const project = this.activeProject
    const normalized = normalizePath(path)
    assertAvailable(project, normalized)
    project.folders.push(normalized)
    touch(project)
    scheduleSave()
    return normalized
  },

  /** Rename or move a file or folder. Throws a user-facing Error on conflict. */
  renamePath(from, to) {
    const project = this.activeProject
    const target = normalizePath(to)
    if (target === from) return
    if (isWithin(target, from)) throw new Error('A folder cannot be moved inside itself')
    assertAvailable(project, target)

    const file = project.files.find((f) => f.path === from)
    if (file) {
      file.path = target
    } else {
      for (const f of project.files) if (isWithin(f.path, from)) f.path = reparent(f.path, from, target)
      project.folders = project.folders.map((dir) => (isWithin(dir, from) ? reparent(dir, from, target) : dir))
    }
    keepParentFolder(project, from)
    project.folders = project.folders.filter((dir) => !ancestors(target).includes(dir) || dir === target)
    touch(project)
    scheduleSave()
  },

  /** Delete a file or a folder and everything in it. */
  deletePath(path) {
    const project = this.activeProject
    removeFiles(project, (f) => isWithin(f.path, path))
    project.folders = project.folders.filter((dir) => !isWithin(dir, path))
    keepParentFolder(project, path)
    touch(project)
    scheduleSave()
  },

  updateFile(id, content) {
    const project = this.activeProject
    const file = project?.files.find((f) => f.id === id)
    if (file && file.content !== content) {
      file.content = content
      touch(project)
      scheduleSave()
    }
  },

  openFile(id) {
    const project = this.activeProject
    if (!project?.files.some((f) => f.id === id)) return
    if (!project.openFileIds.includes(id)) project.openFileIds.push(id)
    project.activeFileId = id
    scheduleSave()
  },

  /** Open a file by path (e.g. from a terminal link). */
  openPath(path) {
    const file = this.activeProject?.files.find((f) => f.path === path)
    if (file) this.openFile(file.id)
    return Boolean(file)
  },

  setActiveFile(id) {
    this.openFile(id)
  },

  closeTab(id) {
    const project = this.activeProject
    const index = project.openFileIds.indexOf(id)
    if (index === -1) return
    project.openFileIds.splice(index, 1)
    if (project.activeFileId === id) {
      project.activeFileId = project.openFileIds[Math.min(index, project.openFileIds.length - 1)] ?? null
    }
    scheduleSave()
  },

  // ---------- Terminal sync (any project) ----------

  /** Apply changes the terminal made to a project's files. */
  applySandboxChanges(projectId, { upserts = [], deletes = [], addFolders = [], removeFolders = [] }) {
    const project = findProject(projectId)
    if (!project) return
    for (const { path, content } of upserts) {
      const file = project.files.find((f) => f.path === path)
      if (file) file.content = content
      else project.files.push(newFile(path, content))
    }
    if (deletes.length) {
      const gone = new Set(deletes)
      removeFiles(project, (f) => gone.has(f.path))
    }
    const removed = new Set(removeFolders)
    project.folders = project.folders.filter((dir) => !removed.has(dir))
    for (const dir of addFolders) if (!project.folders.includes(dir)) project.folders.push(dir)
    // Folders that now contain files no longer need an explicit entry.
    project.folders = project.folders.filter((dir) => !project.files.some((f) => isWithin(f.path, dir) && f.path !== dir))
    if (upserts.length || deletes.length) touch(project)
    scheduleSave()
  },

  /** Remember a project's shell history (restored when its terminal starts). */
  setHistory(projectId, text) {
    const project = findProject(projectId)
    if (project && project.history !== text) {
      project.history = text
      scheduleSave()
    }
  },

  /** Flush pending saves (used before export and in tests). */
  flush: flushSave,
}

