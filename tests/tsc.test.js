import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTsc } from '../src/lib/runtime/tscRunner.js'
import { isTscInput } from '../src/lib/runtime/tsc.js'

// The compiler and type definitions the app ships (see copy-npm-toolchains.mjs).
const require = createRequire(import.meta.url)
const modules = join(import.meta.dirname, '..', 'node_modules')
function bundle() {
  const files = new Map()
  const lib = join(modules, 'typescript', 'lib')
  for (const name of readdirSync(lib)) if (/^lib\..*\.d\.ts$/.test(name)) files.set(`/opcode/typescript/lib/${name}`, readFileSync(join(lib, name), 'utf8'))
  const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]))
  for (const name of ['@types/node', 'undici-types']) {
    for (const path of walk(join(modules, name))) if (path.endsWith('.d.ts') || path.endsWith('/package.json')) files.set(`/node_modules/${name}/${relative(join(modules, name), path)}`, readFileSync(path, 'utf8'))
  }
  return files
}

const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '')
let tsc
beforeAll(() => {
  tsc = createTsc(require('typescript'), bundle())
})

// The first compile parses Node's type definitions (a few seconds on a busy
// machine); later ones reuse nothing either, but the code is warm by then.
describe('tsc', { timeout: 60_000 }, () => {
  it('compiles a Node program given on the command line, with Node types', () => {
    const files = { '/workspace/main.ts': 'import * as readline from "node:readline/promises";\nconst rl = readline.createInterface({ input: process.stdin });\nrl.close();\n' }
    const result = tsc.run({ cwd: '/workspace', args: ['main.ts'], files })
    expect(plain(result.output)).toBe('')
    expect(result.code).toBe(0)
    expect(result.outputs['/workspace/main.js']).toContain('require("node:readline/promises")')
  })

  it('reports type errors as tsc does, and still writes JavaScript', () => {
    const result = tsc.run({ cwd: '/workspace/src', args: ['bad.ts'], files: { '/workspace/src/bad.ts': 'let n: number = "no"\n' } })
    expect(result.code).toBe(2)
    expect(plain(result.output)).toContain("bad.ts:1:5 - error TS2322: Type 'string' is not assignable to type 'number'.")
    expect(plain(result.output)).toContain('Found 1 error in bad.ts:1')
    expect(Object.keys(result.outputs)).toEqual(['/workspace/src/bad.js'])
  })

  it('follows imports, and uses tsconfig.json when no files are given', () => {
    const files = {
      '/workspace/main.ts': 'import { twice } from "./util";\nconsole.log(twice(21));\n',
      '/workspace/util.ts': 'export const twice = (x: number) => 2 * x;\n',
    }
    expect(Object.keys(tsc.run({ cwd: '/workspace', args: ['main.ts'], files }).outputs).sort()).toEqual(['/workspace/main.js', '/workspace/util.js'])
    const config = { compilerOptions: { outDir: 'dist', module: 'commonjs', strict: true } }
    const result = tsc.run({ cwd: '/workspace', args: [], files: { ...files, '/workspace/tsconfig.json': JSON.stringify(config) } })
    expect(result.code).toBe(0)
    expect(Object.keys(result.outputs).sort()).toEqual(['/workspace/dist/main.js', '/workspace/dist/util.js'])
  })

  it('answers --version, and --init writes a tsconfig.json', () => {
    expect(tsc.run({ cwd: '/workspace', args: ['--version'], files: {} }).output).toBe(`Version ${tsc.version}\n`)
    const init = tsc.run({ cwd: '/workspace', args: ['--init'], files: {} })
    expect(init.code).toBe(0)
    expect(init.outputs['/workspace/tsconfig.json']).toContain('"compilerOptions"')
  })
})

describe('tsc inputs', () => {
  it('reads sources and JSON, and only type definitions from node_modules', () => {
    expect(isTscInput('src/main.ts')).toBe(true)
    expect(isTscInput('tsconfig.json')).toBe(true)
    expect(isTscInput('notes.md')).toBe(false)
    expect(isTscInput('node_modules/express/index.js')).toBe(false)
    expect(isTscInput('node_modules/@types/express/index.d.ts')).toBe(true)
    expect(isTscInput('node_modules/express/package.json')).toBe(true)
  })
})
