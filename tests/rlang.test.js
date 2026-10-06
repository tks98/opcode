import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createR, parseRscriptArgs } from '../src/lib/runtime/rlang.js'

describe('Rscript command line', () => {
  it('reads a file and its arguments, or expressions', () => {
    expect(parseRscriptArgs(['main.R'])).toEqual({ file: 'main.R', expression: null, args: [] })
    expect(parseRscriptArgs(['--vanilla', 'stats.R', 'data.csv', '-v'])).toEqual({ file: 'stats.R', expression: null, args: ['data.csv', '-v'] })
    expect(parseRscriptArgs(['-e', 'x <- 1', '-e', 'print(x)', 'extra'])).toEqual({ file: null, expression: 'x <- 1\nprint(x)', args: ['extra'] })
    expect(parseRscriptArgs(['--file=a.R', '--args', 'b'])).toEqual({ file: 'a.R', expression: null, args: ['b'] })
    expect(parseRscriptArgs(['--version'])).toEqual({ version: true })
    expect(parseRscriptArgs([])).toEqual({ help: true })
  })
})

// webR itself, as in the browser (its Node build).
describe('R', () => {
  const encode = (text) => new TextEncoder().encode(text)
  let R
  beforeAll(async () => {
    const { WebR } = await import('webr')
    R = createR(WebR, fileURLToPath(new URL('../node_modules/webr/dist/', import.meta.url)))
  })
  afterAll(() => R?.closeConsole('test'))

  it('runs a script like Rscript: output, files, plots, and errors that halt it', async () => {
    const files = {
      '/workspace/main.R': encode('x <- c(2, 4, 6)\nx\ncat("args:", commandArgs(TRUE), "\\n")\nwarning("careful")\nd <- read.csv("data/pets.csv")\nwrite.csv(d[d$legs > 2, ], "four.csv", row.names = FALSE)\nplot(x)\nf <- function() stop("deep")\nf()\ncat("not reached\\n")\n'),
      '/workspace/data/pets.csv': encode('name,legs\ncat,4\nbird,2\n'),
    }
    const result = await R.runScript({ cwd: '/workspace', file: 'main.R', args: ['one', 'two'], files })
    expect(result.code).toBe(1)
    expect(result.output).toBe('[1] 2 4 6\nargs: one two \nWarning message:\ncareful\nError in f() : deep\nExecution halted\n')
    expect(Object.keys(result.written)).toEqual(['/workspace/four.csv'])
    expect(new TextDecoder().decode(result.written['/workspace/four.csv'])).toBe('"name","legs"\n"cat",4\n')
    expect(result.plots).toHaveLength(1)
    expect([...result.plots[0].subarray(1, 4)]).toEqual([80, 78, 71]) // PNG
  }, 60_000)

  it('reports syntax errors with the file name, and runs -e expressions', async () => {
    const bad = await R.runScript({ cwd: '/workspace', file: 'bad.R', files: { '/workspace/bad.R': encode('x <- (1 +\n}\n') } })
    expect(bad.output).toBe("Error: bad.R:2:1: unexpected '}'\n1: x <- (1 +\n2: }\n   ^\nExecution halted\n")
    expect((await R.runScript({ cwd: '/workspace', expression: 'cat(6 * 7, "\\n")' })).output).toBe('42 \n')
  }, 60_000)

  it('keeps one R per console, asks for more lines, and quits', async () => {
    expect(await R.consoleEval('test', '/workspace', 'f <- function(n) {\n')).toMatchObject({ status: 'incomplete' })
    expect(await R.consoleEval('test', '/workspace', 'f <- function(n) {\n  n * 2\n}\n')).toMatchObject({ status: 'ok', output: '' })
    expect(await R.consoleEval('test', '/workspace', 'f(21)\n')).toMatchObject({ status: 'ok', output: '[1] 42\n' })
    expect(await R.consoleEval('test', '/workspace', '}\n')).toMatchObject({ status: 'error', output: 'Error: unexpected \'}\' in "}"\n' })
    const plotted = await R.consoleEval('test', '/workspace', 'plot(1:3)\n')
    expect(plotted.plot).toBeInstanceOf(Uint8Array)
    expect((await R.consoleEval('test', '/workspace', 'x <- 1\n')).plot).toBeNull() // unchanged
    expect(await R.consoleEval('test', '/workspace', 'q()\n')).toMatchObject({ status: 'quit' })
  }, 60_000)
})
