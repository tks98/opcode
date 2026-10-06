// tsc in a Web Worker: the TypeScript compiler (typescript.js) runs the
// project's tsc commands (see tscRunner.js and tsc.js).

import { createTsc } from './tscRunner.js'

let tsc = null

self.onmessage = ({ data }) => {
  const { id, type } = data
  try {
    if (type === 'init') {
      const decoder = new TextDecoder()
      // typescript.js defines `ts` (and exports it when there is a module).
      const ts = new Function(`${decoder.decode(data.compiler)}\nreturn ts`)()
      tsc = createTsc(ts, new Map(Object.entries(JSON.parse(decoder.decode(data.types)))))
      self.postMessage({ id, type: 'done', version: tsc.version })
    } else if (type === 'run') {
      self.postMessage({ id, type: 'done', ...tsc.run(data) })
    }
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error?.message ?? String(error) })
  }
}
