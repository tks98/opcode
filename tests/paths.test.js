import { describe, expect, it } from 'vitest'
import { ancestors, basename, dirname, extname, fromWorkspacePath, isIgnoredPath, isWithin, normalizePath, reparent, stem, toWorkspacePath, tryNormalizePath } from '../src/lib/paths.js'

describe('normalizePath', () => {
  it('cleans separators, dots and whitespace', () => {
    expect(normalizePath(' src//lib/./main.c ')).toBe('src/lib/main.c')
    expect(normalizePath('\\windows\\style.py')).toBe('windows/style.py')
    expect(normalizePath('/leading/slash.go')).toBe('leading/slash.go')
  })

  it('rejects empty names, parent segments and reserved characters', () => {
    expect(() => normalizePath('')).toThrow(/required/)
    expect(() => normalizePath('a/../b')).toThrow(/\.\./)
    expect(() => normalizePath('bad:name.txt')).toThrow(/not allowed/)
    expect(tryNormalizePath('../x')).toBeNull()
  })
})

describe('path helpers', () => {
  it('splits paths', () => {
    expect(basename('src/main.c')).toBe('main.c')
    expect(dirname('src/main.c')).toBe('src')
    expect(dirname('main.c')).toBe('')
    expect(extname('archive.tar.GZ')).toBe('.gz')
    expect(extname('.bashrc')).toBe('')
    expect(stem('src/main.cpp')).toBe('main')
    expect(ancestors('a/b/c.txt')).toEqual(['a', 'a/b'])
  })

  it('handles containment and re-rooting', () => {
    expect(isWithin('src/a.c', 'src')).toBe(true)
    expect(isWithin('src2/a.c', 'src')).toBe(false)
    expect(reparent('src/lib/a.c', 'src', 'app')).toBe('app/lib/a.c')
  })

  it('ignores tool and package directories', () => {
    expect(isIgnoredPath('.opcode/bashrc')).toBe(true)
    expect(isIgnoredPath('web/node_modules/x/index.js')).toBe(true)
    expect(isIgnoredPath('pkg/__pycache__/m.pyc')).toBe(true)
    expect(isIgnoredPath('src/main.py')).toBe(false)
  })

  it('maps to and from the sandbox workspace', () => {
    expect(toWorkspacePath('src/a.c')).toBe('/workspace/src/a.c')
    expect(toWorkspacePath('')).toBe('/workspace')
    expect(fromWorkspacePath('/workspace/src/a.c')).toBe('src/a.c')
    expect(fromWorkspacePath('/tmp/x')).toBeNull()
  })
})

describe('Opcode\'s own folder', () => {
  it('is reserved, whichever slashes a path uses', () => {
    expect(() => normalizePath('.opcode/bashrc')).toThrow(/reserved/)
    expect(() => normalizePath('.opcode\\bashrc')).toThrow(/reserved/)
    expect(tryNormalizePath('/.opcode/tools.sh')).toBeNull()
    expect(normalizePath('src/.opcode/notes.txt')).toBe('src/.opcode/notes.txt')
  })

  it('is ignored with backslashes too', () => {
    expect(isIgnoredPath('.opcode\\bashrc')).toBe(true)
    expect(isIgnoredPath('node_modules\\x\\index.js')).toBe(true)
    expect(isIgnoredPath('src\\main.py')).toBe(false)
  })
})
