import { describe, expect, it } from 'vitest'
import { buildTree } from '../src/lib/fileTree.js'

describe('buildTree', () => {
  it('nests files in folders, folders first, natural order', () => {
    const tree = buildTree(
      [{ id: '1', path: 'main.py' }, { id: '2', path: 'src/util10.py' }, { id: '3', path: 'src/util2.py' }],
      ['empty'],
      [{ path: 'src/a.out', size: 10 }],
    )
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(['folder:empty', 'folder:src', 'file:main.py'])
    const src = tree.find((n) => n.name === 'src')
    expect(src.children.map((n) => n.name)).toEqual(['a.out', 'util2.py', 'util10.py'])
    expect(src.children[0].kind).toBe('binary')
  })

  it('creates intermediate folders for deep paths', () => {
    const [a] = buildTree([{ id: '1', path: 'a/b/c.txt' }])
    expect(a.path).toBe('a')
    expect(a.children[0].path).toBe('a/b')
    expect(a.children[0].children[0].path).toBe('a/b/c.txt')
  })
})
