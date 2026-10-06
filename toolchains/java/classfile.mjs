// Strips method bodies from a Java class file, keeping everything javac
// needs to compile against it (signatures, generics, annotations, constants).

const CODE = 'Code'

export function stripClass(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  const u1 = () => view.getUint8(pos++)
  const u2 = () => {
    const value = view.getUint16(pos)
    pos += 2
    return value
  }
  const u4 = () => {
    const value = view.getUint32(pos)
    pos += 4
    return value
  }
  if (view.getUint32(0) !== 0xcafebabe) throw new Error('not a class file')

  // Constant pool: remember UTF-8 entries to recognise attribute names.
  const utf8 = new Map()
  const count = u2()
  for (let index = 1; index < count; index++) {
    const tag = u1()
    if (tag === 1) {
      const length = u2()
      utf8.set(index, new TextDecoder().decode(bytes.subarray(pos, pos + length)))
      pos += length
    } else if (tag === 5 || tag === 6) {
      pos += 8
      index++ // longs and doubles take two slots
    } else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) {
      pos += 4
    } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      pos += 2
    } else if (tag === 15) {
      pos += 3
    } else {
      throw new Error(`unknown constant pool tag ${tag}`)
    }
  }
  pos += 6 // access flags, this class, super class
  const interfaces = u2()
  pos += 2 * interfaces

  const out = []
  let copiedFrom = 0
  // Copy everything up to `pos`, then skip `length` bytes.
  const skip = (length) => {
    out.push(bytes.subarray(copiedFrom, pos))
    pos += length
    copiedFrom = pos
  }

  const members = (stripCode) => {
    const memberCount = u2()
    for (let i = 0; i < memberCount; i++) {
      pos += 6 // access, name, descriptor
      const countAt = pos
      const attributeCount = u2()
      let kept = attributeCount
      for (let j = 0; j < attributeCount; j++) {
        const name = utf8.get(u2())
        const length = u4()
        if (stripCode && name === CODE) {
          pos -= 6
          skip(6 + length)
          kept--
        } else {
          pos += length
        }
      }
      if (kept !== attributeCount) out.push({ patch: countAt, value: kept })
    }
  }
  members(false) // fields
  members(true) // methods
  out.push(bytes.subarray(copiedFrom))

  // Reassemble, fixing up the attribute counts of stripped methods.
  const patches = out.filter((part) => part.patch !== undefined)
  const parts = out.filter((part) => part.patch === undefined)
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  const shift = [] // [original position, bytes removed before it]
  let removed = 0
  let original = 0
  for (const part of parts) {
    result.set(part, offset)
    const start = part.byteOffset - bytes.byteOffset
    removed += start - original
    shift.push([start, removed])
    original = start + part.length
    offset += part.length
  }
  for (const { patch, value } of patches) {
    let before = 0
    for (const [start, gone] of shift) if (start <= patch) before = gone
    const at = patch - before
    result[at] = value >> 8
    result[at + 1] = value & 0xff
  }
  return result
}
