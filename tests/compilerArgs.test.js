import { describe, expect, it } from 'vitest'
import { UNBUFFERED_HEADER, mapCompilerArgs, prettifyOutput, resolvePath } from '../src/lib/runtime/compilerArgs.js'

describe('resolvePath', () => {
  it('resolves relative to the shell directory', () => {
    expect(resolvePath('/workspace/src', 'main.c')).toBe('/workspace/src/main.c')
    expect(resolvePath('/workspace/src', '../inc/a.h')).toBe('/workspace/inc/a.h')
    expect(resolvePath('/workspace/src', '/abs/file')).toBe('/abs/file')
  })
})

describe('mapCompilerArgs', () => {
  it('rewrites inputs, outputs and include paths', () => {
    const { tool, args } = mapCompilerArgs('gcc', ['-Wall', '-I', 'include', '-L../lib', '-o', 'app', 'main.c', '-lm'], '/workspace/src')
    expect(tool).toBe('clang')
    expect(args).toEqual(['-fcolor-diagnostics', '-include', UNBUFFERED_HEADER, '-Wall', '-I', '/workspace/src/include', '-L/workspace/lib', '-o', '/workspace/src/app', '/workspace/src/main.c', '-lm'])
  })

  it('leaves option values that are not paths alone', () => {
    const { args } = mapCompilerArgs('clang', ['-x', 'c', '-D', 'DEBUG=1', 'prog.txt'], '/workspace')
    expect(args).toContain('c')
    expect(args).toContain('DEBUG=1')
    expect(args).toContain('/workspace/prog.txt')
  })

  it('builds C++ without exceptions, whichever compiler name was typed', () => {
    expect(mapCompilerArgs('g++', ['main.cpp'], '/workspace').args).toContain('-fno-exceptions')
    const viaGcc = mapCompilerArgs('gcc', ['main.cpp'], '/workspace')
    expect(viaGcc.tool).toBe('clang++')
    expect(mapCompilerArgs('clang', ['main.c'], '/workspace').args).not.toContain('-fno-exceptions')
  })

  it('only injects the stdio header when compiling sources', () => {
    expect(mapCompilerArgs('clang', ['a.o', 'b.o', '-o', 'app'], '/workspace').args).not.toContain('-include')
    expect(mapCompilerArgs('clang', ['--version'], '/workspace').args).toEqual(['-fcolor-diagnostics', '--version'])
  })
})

describe('prettifyOutput', () => {
  it('shows paths as the user typed them', () => {
    expect(prettifyOutput('/workspace/src/main.c:3:5: error', '/workspace/src')).toBe('main.c:3:5: error')
    expect(prettifyOutput('/workspace/inc/a.h:1:1: note', '/workspace/src')).toBe('~/inc/a.h:1:1: note')
  })
})
