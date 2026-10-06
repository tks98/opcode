import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it } from 'vitest'
import { createProjectData, migrateProject, projectStore, uniquePath, uniqueProjectName } from '../src/lib/stores/projects.svelte.js'
import { loadState } from '../src/lib/persistence.js'

beforeAll(async () => {
  await projectStore.load()
})

describe('project store', () => {
  it('starts empty, then creates a project with a starter file', () => {
    expect(projectStore.projects).toHaveLength(0)
    expect(projectStore.activeProject).toBeNull()
    projectStore.createProject('Python project', 'python')
    expect(projectStore.projects).toHaveLength(1)
    expect(projectStore.activeFile.path).toBe('main.py')
  })

  it('creates nested files and rejects duplicates', () => {
    projectStore.createFile('src/util.py', 'x = 1')
    expect(projectStore.files.map((f) => f.path)).toContain('src/util.py')
    expect(projectStore.activeFile.path).toBe('src/util.py')
    expect(() => projectStore.createFile('src/util.py')).toThrow(/already exists/)
    expect(() => projectStore.createFile('main.py/inner.py')).toThrow(/is a file/)
  })

  it('renames folders together with their contents', () => {
    projectStore.renamePath('src', 'lib')
    expect(projectStore.files.map((f) => f.path)).toContain('lib/util.py')
    expect(() => projectStore.renamePath('lib', 'lib/inner')).toThrow(/inside itself/)
  })

  it('keeps a folder when its last file is deleted, and deletes folders recursively', () => {
    projectStore.deletePath('lib/util.py')
    expect(projectStore.folders).toContain('lib')
    projectStore.createFile('lib/a.py')
    projectStore.deletePath('lib')
    expect(projectStore.files.some((f) => f.path.startsWith('lib/'))).toBe(false)
    expect(projectStore.folders).not.toContain('lib')
  })

  it('applies changes made in the terminal', () => {
    const id = projectStore.activeProjectId
    projectStore.applySandboxChanges(id, { upserts: [{ path: 'out/result.txt', content: '42' }, { path: 'main.py', content: 'print(1)' }], addFolders: ['build'] })
    expect(projectStore.files.find((f) => f.path === 'out/result.txt').content).toBe('42')
    expect(projectStore.files.find((f) => f.path === 'main.py').content).toBe('print(1)')
    expect(projectStore.folders).toContain('build')
    projectStore.applySandboxChanges(id, { deletes: ['out/result.txt'], removeFolders: ['build'] })
    expect(projectStore.files.some((f) => f.path === 'out/result.txt')).toBe(false)
    expect(projectStore.folders).not.toContain('build')
  })

  it('persists to IndexedDB', async () => {
    await projectStore.flush()
    const saved = await loadState()
    expect(saved.version).toBe(2)
    expect(saved.projects[0].files.find((f) => f.path === 'main.py').content).toBe('print(1)')
  })

  it('creates and deletes projects, down to none', () => {
    const id = projectStore.createProject('Go Lab', 'go')
    expect(projectStore.activeProject.files[0].path).toBe('main.go')
    expect(projectStore.deleteProject(id)).toBe(true)
    expect(projectStore.projects).toHaveLength(1)
    expect(projectStore.activeProject.name).toBe('Python project')
    expect(projectStore.deleteProject(projectStore.activeProjectId)).toBe(true)
    expect(projectStore.projects).toHaveLength(0)
    expect(projectStore.activeProject).toBeNull()
  })

  it('imports a project in the language of its files', () => {
    projectStore.importProject('Shapes', [{ path: 'src/main.rs', content: 'fn main() {}' }, { path: 'Cargo.toml', content: '' }])
    expect(projectStore.activeProject.language).toBe('rust')
    projectStore.importProject('Shapes', [{ path: 'notes.txt', content: '' }])
    expect(projectStore.activeProject.name).toBe('Shapes 2')
    expect(projectStore.activeProject.language).toBe('python')
  })

  it('remembers when a project was last used', async () => {
    const first = projectStore.createProject('First', 'c')
    const before = projectStore.getProject(first).updatedAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    projectStore.createProject('Second', 'go')
    projectStore.setActiveProject(first)
    expect(projectStore.getProject(first).updatedAt).toBeGreaterThan(before)
  })
})

describe('helpers', () => {
  it('numbers project names that are taken', () => {
    const projects = [{ name: 'Python project' }, { name: 'Python project 2' }]
    expect(uniqueProjectName(projects, 'Python project')).toBe('Python project 3')
    expect(uniqueProjectName(projects, 'Rust project')).toBe('Rust project')
  })

  it('migrates projects saved by older versions', () => {
    const project = migrateProject({ id: 'p', name: 'Old', language: 'cpp', files: [{ id: 'f', name: 'main.cpp', content: 'x', isDirty: true, language: 'cpp' }], activeFileId: 'f', openFileIds: ['f', 'missing'] })
    expect(project.files).toEqual([{ id: 'f', path: 'main.cpp', content: 'x' }])
    expect(project.openFileIds).toEqual(['f'])
    expect(project.folders).toEqual([])
  })

  it('makes Linux and Docker projects as whole machines, and keeps them that way', () => {
    for (const language of ['linux', 'docker']) {
      const project = createProjectData('Lab', language)
      expect(project).toMatchObject({ kind: 'linux', language, files: [] })
      expect(migrateProject(project)).toMatchObject({ kind: 'linux', language })
    }
    // Saved before Docker existed: plain Linux.
    expect(migrateProject({ kind: 'linux', name: 'Old lab' }).language).toBe('linux')
  })

  it('suggests unused paths', () => {
    const project = createProjectData('P', 'python')
    expect(uniquePath(project, 'main.py')).toBe('main-2.py')
    expect(uniquePath(project, 'other.py')).toBe('other.py')
  })
})
