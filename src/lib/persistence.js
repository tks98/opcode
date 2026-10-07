// Project persistence. Projects live in IndexedDB, which (unlike
// localStorage's ~5 MB) comfortably holds multi-file projects. Older builds
// stored everything in localStorage; that data is migrated on first load.
//
// localStorage also holds a copy when IndexedDB can't be written, and the
// state saved synchronously as the page closes (an IndexedDB write started
// then may never finish). Each copy carries savedAt; loading takes the newer.

const DB_NAME = 'opcode'
const STORE = 'state'
const KEY = 'workspace'

const LEGACY_PROJECTS_KEY = 'opcode-projects'
const LEGACY_FILES_KEY = 'opcode-files'

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

let databasePromise = null
function database() {
  databasePromise ??= openDatabase().catch((error) => {
    databasePromise = null
    throw error
  })
  return databasePromise
}

function transact(mode, run) {
  return transactOnce(mode, run).catch((error) => {
    // A connection the browser closed (iOS does, in the background) stays
    // closed: open a new one for the next attempt.
    databasePromise = null
    throw error
  })
}

function transactOnce(mode, run) {
  return database().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const request = run(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(request?.result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** Read saved state written by an older, localStorage-based build. */
function readLegacyState() {
  try {
    const saved = localStorage.getItem(LEGACY_PROJECTS_KEY)
    if (saved) return JSON.parse(saved)

    const files = localStorage.getItem(LEGACY_FILES_KEY)
    if (files) {
      const parsed = JSON.parse(files)
      if (Array.isArray(parsed.files)) {
        const id = Math.random().toString(36).slice(2, 9)
        return {
          projects: [{ id, name: 'My Project', language: 'python', ...parsed }],
          activeProjectId: id,
        }
      }
    }
  } catch (error) {
    console.warn('Ignoring unreadable legacy project data:', error)
  }
  return null
}

function clearLegacyState() {
  try {
    localStorage.removeItem(LEGACY_PROJECTS_KEY)
    localStorage.removeItem(LEGACY_FILES_KEY)
  } catch {
    // Storage may be unavailable (private browsing); nothing to clean up.
  }
}

export class LoadError extends Error {}

/**
 * Load saved state, or null when there is none. Throws LoadError when saved
 * projects can't be read: that is not the same as having none.
 */
export async function loadState() {
  let stored
  try {
    stored = await transact('readonly', (store) => store.get(KEY))
  } catch (error) {
    const local = readLegacyState()
    if (local) return local
    throw new LoadError(`Could not read your saved projects (${error?.message || error})`)
  }
  const local = readLegacyState()
  if (local && (!stored || (local.savedAt ?? 0) > (stored.savedAt ?? 0))) {
    // Newer than IndexedDB's copy (or a first load after an older build).
    try {
      await transact('readwrite', (store) => store.put(local, KEY))
      clearLegacyState()
    } catch {
      // Keep the copy in localStorage; it's read again next time.
    }
    return local
  }
  return stored ?? null
}

/** Persist state. Falls back to localStorage if IndexedDB is unavailable. */
export async function saveState(state) {
  const plain = { ...JSON.parse(JSON.stringify(state)), savedAt: Date.now() }
  try {
    await transact('readwrite', (store) => store.put(plain, KEY))
    clearLegacyState() // an older copy saved while closing, now superseded
  } catch (error) {
    try {
      localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(plain))
    } catch {
      console.error('Could not save projects:', error)
      throw error
    }
  }
}

/**
 * Save synchronously, as the page closes, to localStorage (up to its ~5 MB).
 * Returns false if it didn't fit.
 */
export function saveStateNow(state) {
  try {
    localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify({ ...state, savedAt: Date.now() }))
    return true
  } catch {
    return false
  }
}
