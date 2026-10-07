import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadState, saveState, saveStateNow } from '../src/lib/persistence.js'

// localStorage as browsers have it.
const stored = new Map()
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
}

const workspace = (name) => ({ version: 2, projects: [{ id: 'p1', name, files: [] }], activeProjectId: 'p1' })

describe('saved state', () => {
  beforeEach(() => stored.clear())

  it('round-trips through IndexedDB', async () => {
    await saveState(workspace('First'))
    expect((await loadState()).projects[0].name).toBe('First')
  })

  it('takes the copy saved as the page closed when it is newer', async () => {
    await saveState(workspace('Saved'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(saveStateNow(workspace('Renamed just before closing'))).toBe(true)
    expect((await loadState()).projects[0].name).toBe('Renamed just before closing')
    // ...and moves it into IndexedDB.
    expect(stored.size).toBe(0)
    expect((await loadState()).projects[0].name).toBe('Renamed just before closing')
  })

  it('ignores an older copy left in localStorage', async () => {
    saveStateNow(workspace('Old'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await saveState(workspace('New'))
    expect((await loadState()).projects[0].name).toBe('New')
  })
})
