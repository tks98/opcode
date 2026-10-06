import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MACHINES } from '../src/lib/linux/machines.js'

const v86 = JSON.parse(readFileSync(new URL('../node_modules/v86/package.json', import.meta.url), 'utf8'))
const file = (path) => new URL(`../public/${path}`, import.meta.url)

describe.each(Object.values(MACHINES))('$name machine image', (machine) => {
  const manifest = JSON.parse(readFileSync(file(`${machine.dir}/manifest.json`), 'utf8'))
  const parts = manifest.files ?? [machine.snapshot]

  it('was made with the installed v86 (snapshots are version-specific)', () => {
    expect(manifest.v86).toBe(v86.version.split('+')[0])
    expect(manifest.memoryMB).toBeGreaterThanOrEqual(128)
    expect(manifest.hardware).toBeGreaterThanOrEqual(2)
  })

  it('ships its snapshot in files small enough for git hosting', () => {
    for (const part of parts) {
      expect(part.startsWith(machine.snapshot)).toBe(true)
      expect(statSync(file(`${machine.dir}/${part}`)).size).toBeLessThan(50 * 1024 * 1024)
    }
  })

  it('names the snapshot it describes (downloads are cached by that name)', () => {
    const snapshot = Buffer.concat(parts.map((part) => readFileSync(file(`${machine.dir}/${part}`))))
    expect(snapshot.length).toBeGreaterThan(10_000_000)
    if (manifest.bytes !== undefined) expect(snapshot.length).toBe(manifest.bytes)
    expect(manifest.snapshot).toBe(createHash('sha256').update(snapshot).digest('hex').slice(0, 16))
    // The app's progress bar estimates the download from this.
    expect(Math.abs(snapshot.length / 1e6 - machine.downloadMB)).toBeLessThan(machine.downloadMB * 0.15)
  })
})

describe('BIOS', () => {
  it('ships the BIOS files every machine boots with', () => {
    expect(statSync(file('linux/seabios.bin')).size).toBeGreaterThan(0)
    expect(statSync(file('linux/vgabios.bin')).size).toBeGreaterThan(0)
  })
})
