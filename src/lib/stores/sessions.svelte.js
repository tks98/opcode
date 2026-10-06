// Live terminal sessions, one per recently used project. Each session owns a
// sandbox (and its workers), so only a few are kept; the least recently used
// one is closed when another project starts its terminal.

import { ProjectSandbox } from '../runtime/ProjectSandbox.svelte.js'
import { projectStore } from './projects.svelte.js'

const MAX_LIVE_SESSIONS = 3

const state = $state({ sessions: [] })

function touch(session) {
  if (state.sessions[0] === session) return
  state.sessions = [session, ...state.sessions.filter((s) => s !== session)]
}

export const sessionStore = {
  /** Live sessions, most recently used first. */
  get sessions() {
    return state.sessions
  },

  /** The session for a project, if one is running. */
  get(projectId) {
    return state.sessions.find((s) => s.projectId === projectId) ?? null
  },

  /** Get or create (and start) the session for a project. */
  open(projectId) {
    let session = this.get(projectId)
    if (!session) {
      session = new ProjectSandbox(projectId, {
        getProject: () => projectStore.getProject(projectId),
        applyChanges: (changes) => projectStore.applySandboxChanges(projectId, changes),
        openFile: (path) => projectStore.getProject(projectId) === projectStore.activeProject && projectStore.openPath(path),
        saveHistory: (text) => projectStore.setHistory(projectId, text),
      })
      touch(session)
      const excess = state.sessions.slice(MAX_LIVE_SESSIONS)
      if (excess.length) {
        state.sessions = state.sessions.slice(0, MAX_LIVE_SESSIONS)
        for (const old of excess) old.close()
      }
      session.start()
    } else {
      touch(session)
    }
    return session
  },

  close(projectId) {
    const session = this.get(projectId)
    if (!session) return
    state.sessions = state.sessions.filter((s) => s !== session)
    session.close()
  },
}
