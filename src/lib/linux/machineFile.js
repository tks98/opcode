// .opcode-linux files: a saved Linux machine (its memory, files, installed
// software and running programs) to download, share and open again.
//
// Layout: a text header, then the gzip-compressed v86 snapshot.
//   OPCODE-LINUX 1\n
//   {"name": ..., "v86": ..., "memoryMB": ..., "hardware": ..., "savedAt": ...}\n
//   <gzip bytes>

const MAGIC = 'OPCODE-LINUX 1\n'
const MAX_HEADER_BYTES = 64 * 1024

export const MACHINE_FILE_EXTENSION = '.opcode-linux'

/** @returns {Blob} */
export function encodeMachineFile(meta, state) {
  return new Blob([MAGIC, JSON.stringify(meta), '\n', state], { type: 'application/octet-stream' })
}

/** @returns {Promise<{ meta: object, state: Blob }>} */
export async function decodeMachineFile(blob) {
  const head = new Uint8Array(await blob.slice(0, MAX_HEADER_BYTES).arrayBuffer())
  const magic = new TextEncoder().encode(MAGIC)
  if (head.length < magic.length || magic.some((byte, i) => head[i] !== byte)) {
    throw new Error('This is not an Opcode Linux machine file.')
  }
  const end = head.indexOf(0x0a, magic.length)
  if (end === -1) throw new Error('This Opcode Linux machine file is damaged.')
  let meta
  try {
    meta = JSON.parse(new TextDecoder().decode(head.subarray(magic.length, end)))
  } catch {
    throw new Error('This Opcode Linux machine file is damaged.')
  }
  return { meta, state: blob.slice(end + 1) }
}

/**
 * Why a saved machine can't run on this version of Opcode, or null.
 * `manifest` describes the shipped machine of the file's kind.
 */
export function incompatibility(meta, manifest) {
  if (meta.v86 !== manifest.v86 || meta.memoryMB !== manifest.memoryMB) {
    return `It was saved by a different version of Opcode (emulator ${meta.v86}, ${meta.memoryMB} MB), and this one runs emulator ${manifest.v86} with ${manifest.memoryMB} MB.`
  }
  return null
}

/** A file name for a project's machine. */
export function machineFileName(name) {
  const safe = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'linux-machine'
  return `${safe}${MACHINE_FILE_EXTENSION}`
}
