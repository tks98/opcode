// Project persistence. Projects live in IndexedDB, which (unlike
// localStorage's ~5 MB) comfortably holds multi-file projects. Older builds
// stored everything in localStorage; that data is migrated on first load.

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

/** Load saved state, or null when there is none. */
export async function loadState() {
  try {
    const state = await transact('readonly', (store) => store.get(KEY))
    if (state) return state
  } catch (error) {
    console.warn('IndexedDB unavailable, falling back to localStorage:', error)
    return readLegacyState()
  }

  const legacy = readLegacyState()
  if (legacy) {
    await saveState(legacy)
    clearLegacyState()
  }
  return legacy
}

/** Persist state. Falls back to localStorage if IndexedDB is unavailable. */
export async function saveState(state) {
  const plain = JSON.parse(JSON.stringify(state))
  try {
    await transact('readwrite', (store) => store.put(plain, KEY))
  } catch (error) {
    try {
      localStorage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(plain))
    } catch {
      console.error('Could not save projects:', error)
      throw error
    }
  }
}
