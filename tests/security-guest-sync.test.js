import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYNC_LIMITS, applyPullToBaseline, applyPushToBaseline, emptyBaseline, planPull, planPush, planScan } from '../src/lib/runtime/workspaceSync.js'
import { escapeRegExp, hasControlCharacters } from '../src/lib/runtime/ProjectSandbox.svelte.js'
import { limitHistory } from '../src/lib/runtime/shell.js'
import { isProjectPath, tryNormalizePath } from '../src/lib/paths.js'
import { migrateProject, projectStore } from '../src/lib/stores/projects.svelte.js'

// What a program in the sandbox can do to the project through the sync:
// make many or large files, or files with names the project can't hold.

const limits = { fileBytes: 100, files: 3, bytes: 250 }

// One sync as ProjectSandbox does it (#scan, then #pull, then #push): the
// terminal's files are { path: text }; the editor is { files, folders }.
function sync(terminal, terminalDirs, editor, baseline, limits) {
  const found = Object.entries(terminal).map(([path, text]) => ({ path, size: text.length }))
  const known = { files: new Set([...baseline.files.keys(), ...editor.files.map((f) => f.path)]), dirs: new Set([...baseline.dirs, ...editor.folders]) }
  const scan = planScan(found, terminalDirs, known, limits)
  const files = new Map(found.map(({ path, size }) => [path, scan.skipped.has(path) ? { size, text: null, skipped: true } : scan.large.has(path) ? { size, text: null } : { size, text: terminal[path] }]))
  const snapshot = { files, dirs: scan.dirs }
  const before = editor.files.map((f) => ({ ...f }))
  const pull = planPull(snapshot, before, editor.folders, baseline)
  // The store (applySandboxChanges, simplified).
  for (const { path, content } of pull.upserts) {
    const file = editor.files.find((f) => f.path === path)
    if (file) file.content = content
    else editor.files.push({ path, content })
  }
  editor.files = editor.files.filter((f) => !pull.deletes.includes(f.path))
  editor.folders = [...new Set([...editor.folders.filter((d) => !pull.removeFolders.includes(d)), ...pull.addFolders])]
  applyPullToBaseline(baseline, snapshot, pull, before)
  const push = planPush(editor.files, editor.folders, baseline)
  applyPushToBaseline(baseline, push)
  return { scan, pull, push }
}

describe('planScan', () => {
  it('leaves out names the project would rename, like after a reload', () => {
    const names = ['ok.txt', 'a\\b.txt', '..', 'x/../y', 'bell\x07.txt', 'esc\x1b[31m', 'c:d.txt', '.opcode/x', 'sp ace .txt ']
    const plan = planScan(names.map((path) => ({ path, size: 1 })), [], { files: new Set(), dirs: new Set() }, SYNC_LIMITS)
    expect([...plan.read]).toEqual(['ok.txt'])
    for (const name of names.slice(1)) {
      expect(plan.skipped.has(name)).toBe(true)
      // migrateProject (on reload) would not keep it as it is either.
      expect(tryNormalizePath(name)).not.toBe(name)
    }
    expect(planScan([], ['ok', 'bad\\dir', 'ok/..'], { files: new Set(), dirs: new Set() }, SYNC_LIMITS).dirs).toEqual(new Set(['ok']))
  })

  it('reads files the editor knows first, then new ones up to the limits', () => {
    const files = [{ path: 'a-new', size: 10 }, { path: 'b-new', size: 10 }, { path: 'z-known', size: 90 }, { path: 'big', size: 101 }]
    const plan = planScan(files, [], { files: new Set(['z-known']), dirs: new Set() }, limits)
    expect([...plan.read]).toEqual(['z-known', 'a-new', 'b-new'])
    expect([...plan.large]).toEqual(['big'])
    const crowded = planScan([...files, { path: 'c-new', size: 1 }], [], { files: new Set(['z-known']), dirs: new Set() }, limits)
    expect(crowded.skipped.has('c-new')).toBe(true) // the 4th file
    const heavy = planScan([{ path: 'a', size: 100 }, { path: 'b', size: 100 }, { path: 'c', size: 60 }], [], { files: new Set(), dirs: new Set() }, limits)
    expect([...heavy.skipped]).toEqual(['c']) // over 250 bytes in all
  })

  it('stays fast for a program that makes 200,000 files', () => {
    const files = Array.from({ length: 200_000 }, (_, i) => ({ path: `f${i}`, size: 0 }))
    const start = performance.now()
    const plan = planScan(files, [], { files: new Set(), dirs: new Set() })
    expect(plan.read.size).toBe(SYNC_LIMITS.files)
    expect(performance.now() - start).toBeLessThan(2000)
  })
})

describe('sync with the limits', () => {
  it("never deletes the editor's files, and settles", () => {
    const editor = { files: [{ path: 'main.py', content: 'x'.repeat(90) }, { path: 'notes.txt', content: 'n'.repeat(90) }], folders: [] }
    const baseline = emptyBaseline()
    for (const f of editor.files) baseline.files.set(f.path, f.content)
    // The program grows notes.txt past the total and floods ~ with files.
    const terminal = { 'main.py': 'x'.repeat(90), 'notes.txt': 'N'.repeat(99), 'flood/1': 'a', 'flood/2': 'b', 'flood/3': 'c', 'bad\\name': 'd' }
    for (let round = 0; round < 3; round++) {
      const { pull, push } = sync(terminal, ['flood'], editor, baseline, limits)
      expect(pull.deletes).toEqual([])
      expect(push.removes).toEqual([])
      expect(push.rmdirs).toEqual([])
      if (round > 0) expect(pull.upserts).toEqual([]) // settled: no flapping
    }
    expect(editor.files.map((f) => f.path).sort()).toEqual(['flood/1', 'main.py', 'notes.txt'])
    expect(editor.files.find((f) => f.path === 'notes.txt').content).toBe('N'.repeat(99))
    // What didn't fit is still the terminal's, listed as files the editor can't show.
    const { pull } = sync(terminal, ['flood'], editor, baseline, limits)
    expect(pull.binaries.map((b) => b.path).sort()).toEqual(['bad\\name', 'flood/2', 'flood/3'])
  })

  it('keeps editor files that no longer fit, and pushes their edits', () => {
    const editor = { files: [{ path: 'a', content: 'a'.repeat(100) }, { path: 'b', content: 'b'.repeat(100) }, { path: 'c', content: 'c' }], folders: [] }
    const baseline = emptyBaseline()
    for (const f of editor.files) baseline.files.set(f.path, f.content)
    // The terminal makes c large enough that the three pass 250 bytes.
    const terminal = { a: 'a'.repeat(100), b: 'b'.repeat(100), c: 'C'.repeat(60) }
    const { scan, pull, push } = sync(terminal, [], editor, baseline, limits)
    expect([...scan.skipped]).toEqual(['c'])
    expect(pull.deletes).toEqual([])
    expect(push.writes).toEqual([]) // the terminal's c stays
    expect(editor.files.find((f) => f.path === 'c').content).toBe('c')
    editor.files.find((f) => f.path === 'c').content = 'edited'
    expect(planPush(editor.files, editor.folders, baseline).writes).toEqual([{ path: 'c', content: 'edited' }])
  })

  it("doesn't mirror folders past the limit, nor remove them from the terminal", () => {
    const editor = { files: [], folders: [] }
    const baseline = emptyBaseline()
    const dirs = ['d1', 'd2', 'd3', 'd4', 'd5']
    for (let round = 0; round < 2; round++) {
      const { push } = sync({}, dirs, editor, baseline, limits)
      expect(push.rmdirs).toEqual([])
    }
    expect(editor.folders).toEqual(['d1', 'd2', 'd3'])
  })
})

describe('project store', () => {
  beforeAll(async () => {
    await projectStore.load()
    projectStore.createProject('Guest', 'python')
  })

  it('applies many files from the terminal in linear time', () => {
    const id = projectStore.activeProject.id
    const upserts = Array.from({ length: 20_000 }, (_, i) => ({ path: `out/f${i}.txt`, content: String(i) }))
    const start = performance.now()
    projectStore.applySandboxChanges(id, { upserts, addFolders: ['out', 'empty'] })
    expect(performance.now() - start).toBeLessThan(2000)
    expect(projectStore.files).toHaveLength(20_001)
    expect(projectStore.folders).toEqual(['empty']) // "out" holds files
    projectStore.applySandboxChanges(id, { upserts: [{ path: 'out/f7.txt', content: 'seven' }], deletes: upserts.slice(100).map((u) => u.path) })
    expect(projectStore.files).toHaveLength(101)
    expect(projectStore.files.find((f) => f.path === 'out/f7.txt').content).toBe('seven')
  })

  it("never takes in names it would rename on reload (as migrateProject does)", () => {
    const id = projectStore.activeProject.id
    const bad = ['..\\..\\Startup\\x.bat', 'a/../b', 'tab\there', '.opcode/bashrc']
    projectStore.applySandboxChanges(id, { upserts: bad.map((path) => ({ path, content: '@echo pwned' })), addFolders: ['..\\up', 'ctl\x01'] })
    for (const path of bad) expect(projectStore.files.some((f) => f.path === path)).toBe(false)
    expect(projectStore.folders.some((dir) => !isProjectPath(dir))).toBe(false)
    // After a reload such a name would not survive as it is either.
    const migrated = migrateProject({ files: bad.map((path, i) => ({ id: String(i), path, content: '' })) })
    for (const file of migrated.files) expect(bad).not.toContain(file.path)
  })
})

describe('other guest-supplied strings', () => {
  it('javac: a sibling file name is matched literally', () => {
    const name = '(x+x+)+y' // from "(x+x+)+y.java"; unescaped this takes seconds
    const start = performance.now()
    expect(new RegExp(`\\b${escapeRegExp(name)}\\b`).test('x'.repeat(29))).toBe(false)
    expect(performance.now() - start).toBeLessThan(100)
    expect(new RegExp(`\\b${escapeRegExp('Foo$Bar')}\\b`).test('new Foo$Bar()')).toBe(true)
  })

  it('a command replayed after an install has no control characters', () => {
    expect(hasControlCharacters('python3 main.py')).toBe(false)
    expect(hasControlCharacters('ls\rrm -rf ~')).toBe(true)
    expect(hasControlCharacters('x\x03')).toBe(true)
    expect(hasControlCharacters('x\x1b[200~')).toBe(true)
  })

  it('saved shell history is capped in lines, line length and size', () => {
    expect(limitHistory('a\nb\nc')).toBe('a\nb\nc')
    expect(limitHistory(Array.from({ length: 1500 }, (_, i) => `cmd ${i}`).join('\n')).split('\n')).toHaveLength(1000)
    expect(limitHistory(`ls\n${'x'.repeat(5000)}\npwd`)).toBe('ls\npwd')
    const big = limitHistory(Array.from({ length: 1000 }, () => 'y'.repeat(4000)).join('\n'))
    expect(big.length).toBeLessThanOrEqual(256 * 1024)
    expect(big.endsWith('y'.repeat(4000))).toBe(true)
  })
})
