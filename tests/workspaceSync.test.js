import { describe, expect, it } from 'vitest'
import { applyPullToBaseline, applyPushToBaseline, decodeText, emptyBaseline, planPull, planPush } from '../src/lib/runtime/workspaceSync.js'

const text = (value) => ({ size: value.length, text: value })
const binary = (size) => ({ size, text: null })
const snapshot = (files, dirs = []) => ({ files: new Map(Object.entries(files)), dirs: new Set(dirs) })
const baselineOf = (files, dirs = []) => ({ files: new Map(Object.entries(files)), dirs: new Set(dirs) })

describe('planPush (editor → terminal)', () => {
  it('writes new and changed files and removes deleted ones', () => {
    const baseline = baselineOf({ 'a.py': 'old', 'gone.py': 'x' })
    const plan = planPush([{ path: 'a.py', content: 'new' }, { path: 'src/b.py', content: 'b' }], [], baseline)
    expect(plan.writes.map((f) => f.path)).toEqual(['a.py', 'src/b.py'])
    expect(plan.removes).toEqual(['gone.py'])
  })

  it('creates explicit folders and removes only the outermost deleted folder', () => {
    const baseline = baselineOf({}, ['old', 'old/inner', 'keep'])
    const plan = planPush([{ path: 'keep/x.txt', content: '' }], ['empty/nested'], baseline)
    expect(plan.mkdirs).toEqual(['empty/nested'])
    expect(plan.rmdirs).toEqual(['old'])
  })

  it('is a no-op once the baseline matches', () => {
    const baseline = emptyBaseline()
    const files = [{ path: 'src/a.c', content: 'int x;' }]
    applyPushToBaseline(baseline, planPush(files, ['docs'], baseline))
    const again = planPush(files, ['docs'], baseline)
    expect(again).toEqual({ writes: [], removes: [], mkdirs: [], rmdirs: [] })
  })
})

describe('planPull (terminal → editor)', () => {
  it('adds files created in the terminal', () => {
    const plan = planPull(snapshot({ 'main.py': text('p'), 'out.txt': text('hello') }), [{ path: 'main.py', content: 'p' }], [], baselineOf({ 'main.py': 'p' }))
    expect(plan.upserts).toEqual([{ path: 'out.txt', content: 'hello' }])
  })

  it('applies terminal edits when the editor has not changed the file', () => {
    const plan = planPull(snapshot({ 'a.py': text('from terminal') }), [{ path: 'a.py', content: 'base' }], [], baselineOf({ 'a.py': 'base' }))
    expect(plan.upserts).toEqual([{ path: 'a.py', content: 'from terminal' }])
  })

  it('keeps unsynced editor edits over terminal edits', () => {
    const plan = planPull(snapshot({ 'a.py': text('from terminal') }), [{ path: 'a.py', content: 'typing...' }], [], baselineOf({ 'a.py': 'base' }))
    expect(plan.upserts).toEqual([])
    expect(plan.deletes).toEqual([])
  })

  it('removes files deleted in the terminal unless edited in the editor', () => {
    const editor = [{ path: 'gone.py', content: 'base' }, { path: 'edited.py', content: 'changed' }]
    const plan = planPull(snapshot({}), editor, [], baselineOf({ 'gone.py': 'base', 'edited.py': 'base' }))
    expect(plan.deletes).toEqual(['gone.py'])
  })

  it('does not resurrect files the editor deleted before pushing', () => {
    const plan = planPull(snapshot({ 'old.py': text('x') }), [], [], baselineOf({ 'old.py': 'x' }))
    expect(plan.upserts).toEqual([])
  })

  it('reports binaries and empty folders', () => {
    const plan = planPull(snapshot({ 'main': binary(4096), 'src/a.c': text('') }, ['src', 'build']), [{ path: 'src/a.c', content: '' }], [], baselineOf({ 'src/a.c': '' }, ['src']))
    expect(plan.binaries).toEqual([{ path: 'main', size: 4096 }])
    expect(plan.addFolders).toEqual(['build'])
  })

  it('forgets folders removed in the terminal', () => {
    const plan = planPull(snapshot({}, []), [], ['tmp'], baselineOf({}, ['tmp']))
    expect(plan.removeFolders).toEqual(['tmp'])
  })

  it('keeps a baseline entry for editor deletions so the next push removes them', () => {
    const baseline = baselineOf({ 'old.py': 'x' })
    const snap = snapshot({ 'old.py': text('x'), 'new.txt': text('n') })
    const plan = planPull(snap, [], [], baseline)
    applyPullToBaseline(baseline, snap, plan, [])
    expect(planPush([{ path: 'new.txt', content: 'n' }], [], baseline).removes).toEqual(['old.py'])
  })
})

describe('decodeText', () => {
  it('accepts UTF-8 text and rejects binary data', () => {
    expect(decodeText(new TextEncoder().encode('héllo'))).toBe('héllo')
    expect(decodeText(new Uint8Array([0x00, 0x61, 0x73, 0x6d]))).toBeNull()
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull()
  })
})
