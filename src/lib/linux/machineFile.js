// .opcode-linux files: a saved Linux machine (its memory, files, installed
// software and running programs) to download, share and open again.
//
// Layout: a text header, then the gzip-compressed v86 snapshot.
//   OPCODE-LINUX 1\n
//   {"name": ..., "v86": ..., "memoryMB": ..., "hardware": ..., "savedAt": ...}\n
//   <gzip bytes>

import { gunzipIfNeeded, measureGunzip } from '../runtime/toolchains.js'

const MAGIC = 'OPCODE-LINUX 1\n'
const MAX_HEADER_BYTES = 64 * 1024
const MAX_NAME_LENGTH = 100
const MB = 1024 * 1024
const DAMAGED = 'This Opcode Linux machine file is damaged.'

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
  if (end === -1) throw new Error(DAMAGED)
  let meta
  try {
    meta = JSON.parse(new TextDecoder().decode(head.subarray(magic.length, end)))
  } catch {
    throw new Error(DAMAGED)
  }
  return { meta: checkMeta(meta), state: blob.slice(end + 1) }
}

/**
 * A machine file's header with only the fields Opcode uses, each of the
 * expected type (the file may come from anyone). Throws if the required
 * ones are missing.
 */
export function checkMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(DAMAGED)
  const { v86, memoryMB, name, hardware, savedAt, machine, alpine } = raw
  if (typeof v86 !== 'string' || !v86 || v86.length > 40) throw new Error(DAMAGED)
  if (!Number.isInteger(memoryMB) || memoryMB <= 0 || memoryMB > 64 * 1024) throw new Error(DAMAGED)
  const meta = { v86, memoryMB }
  const cleanName = typeof name === 'string' ? machineName(name) : ''
  if (cleanName) meta.name = cleanName
  if (Number.isInteger(hardware) && hardware >= 1 && hardware <= 100) meta.hardware = hardware
  if (Number.isFinite(savedAt) && savedAt >= 0) meta.savedAt = savedAt
  if (machine === 'linux' || machine === 'docker') meta.machine = machine
  if (typeof alpine === 'string' && alpine.length <= 40) meta.alpine = alpine
  return meta
}

/** A machine's name as shown in Opcode: one line, without control or text-direction characters, at most 100 characters. */
export function machineName(text) {
  const clean = String(text).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim()
  return [...clean].slice(0, MAX_NAME_LENGTH).join('').trim()
}

/**
 * The most a machine's unpacked state can be. v86 saves only the memory
 * pages in use, plus the video memory and the devices (a few MB), so
 * memory plus 64 MB is generous. The shipped snapshots unpack to about
 * 120 MB (Linux, 256 MB of memory) and 395 MB (Docker, 1 GB).
 */
export function stateLimit(memoryMB) {
  return (memoryMB + 64) * MB
}

/** The most a machine file can be (gzip makes no state bigger by more than a fraction of a percent). */
export function machineFileLimit(memoryMB) {
  return Math.ceil(stateLimit(memoryMB) * 1.01) + MAX_HEADER_BYTES
}

// v86's own snapshot format: a header (magic, version, total length, info
// length), then the device state. The other format v86 accepts, zstd, sizes
// its buffers from the file itself, so only this one is let through.
const V86_STATE_MAGIC = 0x86768676

function checkStateHeader(head, size) {
  if (head.length < 16) return false
  const view = new DataView(head.buffer, head.byteOffset, 16)
  return view.getUint32(0, true) === V86_STATE_MAGIC && view.getUint32(8, true) === size
}

/**
 * Check a machine file's state (gzip) before saving it: it must unpack to
 * a v86 snapshot no bigger than the machine's memory allows. Only measures
 * it; nothing unpacked is kept.
 */
export async function checkMachineState(state, memoryMB) {
  const maxBytes = stateLimit(memoryMB)
  const start = new Uint8Array(await state.slice(0, 2).arrayBuffer())
  if (start[0] !== 0x1f || start[1] !== 0x8b) throw new Error(DAMAGED)
  let measured
  try {
    measured = await measureGunzip(state, { maxBytes })
  } catch {
    throw new Error(DAMAGED)
  }
  if (!checkStateHeader(measured.head, measured.size)) throw new Error(DAMAGED)
}

/**
 * Unpack a machine's state (gzip, or already unpacked by the server) for
 * v86, refusing anything that unpacks past the limit for `memoryMB` or is
 * not a v86 snapshot. Resolves to an ArrayBuffer.
 */
export async function unpackMachineState(bytes, memoryMB) {
  let data
  try {
    data = await gunzipIfNeeded(bytes, { maxBytes: stateLimit(memoryMB) })
  } catch {
    throw new Error(DAMAGED)
  }
  if (!checkStateHeader(data.subarray(0, 16), data.length)) throw new Error(DAMAGED)
  return data.buffer.byteLength === data.byteLength ? data.buffer : data.slice().buffer
}

/**
 * The address of a shared machine (?machine=…), or null unless it is a web
 * address: http: or https:, or a path on this site.
 */
export function sharedMachineUrl(source, base) {
  let url
  try {
    url = new URL(String(source ?? '').trim(), base)
  } catch {
    return null
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
}

/** A name for a shared machine from its address (lab-1.opcode-linux → lab-1). */
export function sharedMachineName(url, fallback = 'Shared machine') {
  const last = new URL(url).pathname.split('/').pop() ?? ''
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    // Not valid percent-encoding: use it as it is.
  }
  return machineName(decoded.replace(/\.opcode-linux$/i, '')) || fallback
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
