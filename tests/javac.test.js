import { describe, expect, it } from 'vitest'
import { classOutputPath, formatJavacDiagnostics, parseJavacArgs, sourceFileOf, withSourceFile } from '../src/lib/runtime/javac.js'
import { stripClass } from '../toolchains/java/classfile.mjs'

// public class Tiny { int x; void hi() { } }, compiled by javac 25 --release 21.
const TINY = Uint8Array.from(
  atob(
    'yv66vgAAAEEAEAoAAgADBwAEDAAFAAYBABBqYXZhL2xhbmcvT2JqZWN0AQAGPGluaXQ+AQADKClWBwAIAQAEVGlueQEAAXgBAAFJAQAEQ29kZQEAD0xpbmVOdW1iZXJUYWJsZQEAAmhpAQAKU291cmNlRmlsZQEACVRpbnkuamF2YQAhAAcAAgAAAAEAAAAJAAoAAAACAAEABQAGAAEACwAAAB0AAQABAAAABSq3AAGxAAAAAQAMAAAABgABAAAAAQAAAA0ABgABAAsAAAAZAAAAAQAAAAGxAAAAAQAMAAAABgABAAAAAwABAA4AAAACAA8=',
  ),
  (c) => c.charCodeAt(0),
)

describe('javac command line', () => {
  it('reads sources and options', () => {
    expect(parseJavacArgs(['Main.java'])).toEqual({ sources: ['Main.java'], outDir: null, classPath: null, warnings: [] })
    expect(parseJavacArgs(['-d', 'out', '-cp', 'lib:.', 'A.java', 'b/B.java'])).toMatchObject({ sources: ['A.java', 'b/B.java'], outDir: 'out', classPath: ['lib', '.'] })
    expect(parseJavacArgs(['-g', '-Xlint:all', '--release', '21', 'Main.java']).warnings).toEqual([])
    expect(parseJavacArgs(['--frobnicate', 'Main.java']).warnings).toEqual(['warning: ignoring option --frobnicate (not supported in Opcode)'])
  })

  it('reports usage problems like javac', () => {
    expect(parseJavacArgs([])).toEqual({ error: 'no source files' })
    expect(parseJavacArgs(['notes.txt'])).toEqual({ error: 'invalid flag: notes.txt' })
    expect(parseJavacArgs(['Main.java', '-d'])).toEqual({ error: '-d requires an argument' })
    expect(parseJavacArgs(['--version'])).toEqual({ version: true })
  })

  it('writes classes next to their sources, or under -d by package', () => {
    expect(classOutputPath('Main.class', 'Main.java', null)).toBe('Main.class')
    expect(classOutputPath('Main$Pet.class', 'src/Main.java', null)).toBe('src/Main$Pet.class')
    expect(classOutputPath('shapes/Circle.class', 'src/shapes/Circle.java', null)).toBe('src/shapes/Circle.class')
    expect(classOutputPath('shapes/Circle.class', 'Circle.java', 'out')).toBe('out/shapes/Circle.class')
    expect(classOutputPath('Main.class', 'src/Main.java', '.')).toBe('Main.class')
  })
})

describe('javac messages', () => {
  it('formats diagnostics as javac does, with the source line and a caret', () => {
    const source = 'public class Main {\n\tpublic static void main(String[] args) {\n\t\tSystem.out.println(y);\n\t}\n}\n'
    const text = formatJavacDiagnostics(
      [
        { severity: 'error', fileName: 'Main.java', lineNumber: 3, columnNumber: 22, message: 'cannot find symbol\n  symbol:   variable y\n  location: class Main' },
        { severity: 'warning', fileName: 'Main.java', lineNumber: 1, columnNumber: 8, message: 'something to note' },
      ],
      () => source,
    )
    expect(text).toBe(
      [
        'Main.java:3: error: cannot find symbol',
        '\t\tSystem.out.println(y);',
        '\t\t                   ^',
        '  symbol:   variable y',
        '  location: class Main',
        'Main.java:1: warning: something to note',
        'public class Main {',
        '       ^',
        '1 error',
        '1 warning',
        '',
      ].join('\n'),
    )
    expect(formatJavacDiagnostics([], () => '')).toBe('')
  })
})

describe('class files', () => {
  it('reads and rewrites the source file a class came from', () => {
    expect(sourceFileOf(TINY)).toBe('Tiny.java')
    const renamed = withSourceFile(TINY, ':Tiny.java')
    expect(sourceFileOf(renamed)).toBe(':Tiny.java')
    expect(renamed.length).toBe(TINY.length + 1)
    expect(withSourceFile(renamed, 'Tiny.java')).toEqual(TINY)
  })

  it('strips method bodies for the compiler SDK', () => {
    const stripped = stripClass(TINY)
    expect(stripped.length).toBeLessThan(TINY.length)
    expect(new TextDecoder().decode(stripped)).not.toContain('LineNumberTable\u0000')
    expect(sourceFileOf(stripped)).toBe('Tiny.java') // the rest of the class is intact
  })
})
