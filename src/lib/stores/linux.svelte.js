// The live Linux machine. Each emulated computer needs a lot of memory
// (256 MB for Linux, 1 GB for Docker), so only the active Linux project's
// machine runs; switching to another Linux project saves and closes the
// previous one.

import { LinuxMachine, loadManifest } from '../linux/LinuxMachine.svelte.js'
import { deleteMachine, saveMachine } from '../linux/machineStorage.js'
import { decodeMachineFile, incompatibility } from '../linux/machineFile.js'
import { recordedKind } from '../linux/machines.js'
import { projectStore } from './projects.svelte.js'

const state = $state({ machine: null })

export const linuxStore = {
  get machine() {
    return state.machine
  },

  get(projectId) {
    return state.machine?.projectId === projectId ? state.machine : null
  },

  /** Get or start the machine for a Linux project ('linux' or 'docker'). */
  open(projectId, kind = 'linux') {
    if (state.machine?.projectId === projectId) return state.machine
    const previous = state.machine
    const machine = new LinuxMachine(projectId, kind)
    state.machine = machine
    previous?.close()
    machine.start()
    return machine
  },

  /**
   * Open an .opcode-linux file (a downloaded or shared machine) as a new
   * Linux project, and switch to it.
   */
  async importFile(blob, fallbackName = 'Shared machine') {
    const { meta, state: snapshot } = await decodeMachineFile(blob)
    const kind = recordedKind(meta)
    const problem = incompatibility(meta, await loadManifest(kind))
    if (problem) throw new Error(`This machine can't be opened here. ${problem}`)
    const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : fallbackName
    const id = projectStore.createProject(name, kind, { activate: false })
    await saveMachine(id, { state: snapshot, savedAt: meta.savedAt ?? Date.now(), v86: meta.v86, memoryMB: meta.memoryMB, hardware: meta.hardware ?? 1, machine: kind })
    projectStore.setActiveProject(id)
    return name
  },

  /** Forget a deleted project's machine. */
  async remove(projectId) {
    if (state.machine?.projectId === projectId) {
      const machine = state.machine
      state.machine = null
      await machine.close({ save: false })
    }
    await deleteMachine(projectId)
  },
}
