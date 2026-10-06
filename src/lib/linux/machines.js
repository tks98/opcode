// The kinds of Linux machine a project can be. Each is a snapshot built by
// toolchains/linux (build.sh, then make-state.mjs) in its own folder of
// public/, described by that folder's manifest.json.

export const MACHINES = {
  linux: {
    id: 'linux',
    name: 'Linux',
    system: 'Alpine Linux 3.24',
    dir: 'linux',
    snapshot: 'opcode-linux.state',
    downloadMB: 43,
    color: 'var(--ink)',
    hint: 'A real Linux computer, with lessons',
    newProjectName: 'Linux lab',
  },
  docker: {
    id: 'docker',
    name: 'Docker',
    system: 'Docker 29 on Alpine Linux',
    dir: 'linux-docker',
    snapshot: 'opcode-docker.state',
    downloadMB: 139,
    color: '#1d63ed',
    hint: 'Real containers on a Linux computer',
    newProjectName: 'Docker lab',
  },
}

/** The machine kind of a Linux project (older projects are all 'linux'). */
export function machineKindOf(project) {
  return project?.language === 'docker' ? 'docker' : 'linux'
}

/** The kind recorded in a saved machine or machine file (older ones: 'linux'). */
export function recordedKind(record) {
  return record?.machine === 'docker' ? 'docker' : 'linux'
}
