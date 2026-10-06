// javac in a Web Worker: OpenJDK's Java compiler built with TeaVM
// (https://github.com/konsoletyper/teavm-javac), compiling against the API
// of the JDK that runs programs (java.base, see scripts/fetch-java.mjs).
// One compiler instance is kept warm between compilations.

let compiler = null
let diagnostics = [] // of the compilation in progress

self.onmessage = async ({ data }) => {
  const { id, type } = data
  try {
    if (type === 'init') {
      const runtime = await import(/* @vite-ignore */ data.runtimeUrl)
      const teavm = await runtime.load(data.wasm)
      compiler = teavm.exports.createCompiler()
      compiler.setSdk(new Int8Array(data.sdk.buffer, data.sdk.byteOffset, data.sdk.byteLength))
      compiler.onDiagnostic((diagnostic) => {
        diagnostics.push({
          severity: diagnostic.severity,
          fileName: diagnostic.fileName,
          lineNumber: diagnostic.lineNumber,
          columnNumber: diagnostic.columnNumber,
          message: diagnostic.message,
        })
      })
      self.postMessage({ id, type: 'done' })
    } else if (type === 'compile') {
      compiler.clearSourceFiles()
      compiler.clearInputClassFiles()
      compiler.clearOutputFiles()
      for (const { path, content } of data.sources) compiler.addSourceFile(path, content)
      for (const { path, bytes } of data.classFiles) compiler.addClassFile(path, new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      diagnostics = []
      const ok = compiler.compile()
      const names = typeof compiler.listOutputFiles === 'function' ? compiler.listOutputFiles() : compiler.listOutputFiles
      const outputs = [...names].map((name) => {
        const bytes = compiler.getOutputFile(name)
        return { name, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice() }
      })
      self.postMessage({ id, type: 'done', ok, diagnostics, outputs }, outputs.map((output) => output.bytes.buffer))
    }
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error?.message ?? String(error) })
  }
}
