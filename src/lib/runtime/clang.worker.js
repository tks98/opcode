// Runs YoWASP's Clang/LLD off the main thread. The first request downloads
// and compiles the toolchain (~105 MB, then served from the HTTP cache).

import { commands } from '@yowasp/clang'

const decoder = new TextDecoder()

function progressReporter(id) {
  return ({ totalLength, doneLength }) => {
    self.postMessage({ id, type: 'progress', doneLength, totalLength })
  }
}

self.onmessage = async ({ data }) => {
  const { id, type } = data

  if (type === 'prepare') {
    try {
      // Calling a command without arguments only fetches its resources.
      await commands.clang(null, {}, { fetchProgress: progressReporter(id) })
      self.postMessage({ id, type: 'done', code: 0 })
    } catch (error) {
      self.postMessage({ id, type: 'error', message: error?.message || String(error) })
    }
    return
  }

  let output = ''
  const sink = (bytes) => {
    if (bytes) output += decoder.decode(bytes, { stream: true })
  }
  try {
    const files = await commands[data.tool](data.args, data.files, {
      stdout: sink,
      stderr: sink,
      decodeASCII: false,
      fetchProgress: progressReporter(id),
    })
    self.postMessage({ id, type: 'done', code: 0, output, files })
  } catch (error) {
    if (typeof error?.code === 'number' && error.files) {
      self.postMessage({ id, type: 'done', code: error.code, output, files: error.files })
    } else {
      self.postMessage({ id, type: 'done', code: 1, output: `${output}${error?.message || error}\n` })
    }
  }
}
