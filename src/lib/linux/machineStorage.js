// Saved Linux machines (compressed v86 snapshots, ~30-40 MB each) live in
// their own IndexedDB database, separate from project files.

const DB_NAME = 'opcode-linux'
const STORE = 'machines'

let databasePromise = null

function database() {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch((error) => {
    databasePromise = null
    throw error
  })
  return databasePromise
}

async function run(mode, action) {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = action(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(request?.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** { state: Blob (gzip), savedAt: number, v86: string, memoryMB: number } or null */
export async function loadMachine(projectId) {
  try {
    return (await run('readonly', (store) => store.get(projectId))) ?? null
  } catch (error) {
    console.warn('Could not read the saved machine:', error)
    return null
  }
}

export function saveMachine(projectId, record) {
  return run('readwrite', (store) => store.put(record, projectId))
}

export async function deleteMachine(projectId) {
  try {
    await run('readwrite', (store) => store.delete(projectId))
  } catch (error) {
    console.warn('Could not delete the saved machine:', error)
  }
}

/** Remove saved machines whose project no longer exists. */
export async function pruneMachines(projectIds) {
  try {
    const keys = await run('readonly', (store) => store.getAllKeys())
    for (const key of keys ?? []) if (!projectIds.has(key)) await deleteMachine(key)
  } catch (error) {
    console.warn('Could not clean up saved machines:', error)
  }
}
