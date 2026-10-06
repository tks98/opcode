import { describe, expect, it } from 'vitest'
import { decodeMachineFile, encodeMachineFile, incompatibility, machineFileName } from '../src/lib/linux/machineFile.js'

describe('machine files', () => {
  it('round-trips the metadata and the snapshot', async () => {
    const snapshot = new Uint8Array([0x1f, 0x8b, 1, 2, 3, 10, 0, 255])
    const meta = { name: 'Lab 1', v86: '0.5.470', memoryMB: 256, savedAt: 123 }
    const { meta: decoded, state } = await decodeMachineFile(encodeMachineFile(meta, new Blob([snapshot])))
    expect(decoded).toEqual(meta)
    expect(new Uint8Array(await state.arrayBuffer())).toEqual(snapshot)
  })

  it('rejects other files', async () => {
    await expect(decodeMachineFile(new Blob(['PK\x03\x04 a zip file']))).rejects.toThrow(/not an Opcode Linux machine/)
    await expect(decodeMachineFile(new Blob(['OPCODE-LINUX 1\n{broken']))).rejects.toThrow(/damaged/)
  })

  it('checks the emulator version and memory', () => {
    const manifest = { v86: '0.5.470', memoryMB: 256 }
    expect(incompatibility({ v86: '0.5.470', memoryMB: 256 }, manifest)).toBeNull()
    expect(incompatibility({ v86: '0.5.400', memoryMB: 256 }, manifest)).toMatch(/different version/)
    expect(incompatibility({ v86: '0.5.470', memoryMB: 512 }, manifest)).toMatch(/512 MB/)
  })

  it('names files after the project', () => {
    expect(machineFileName('Lab 1: Permissions')).toBe('lab-1-permissions.opcode-linux')
    expect(machineFileName('***')).toBe('linux-machine.opcode-linux')
  })
})
