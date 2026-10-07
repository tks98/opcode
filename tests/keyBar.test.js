import { describe, expect, it } from 'vitest'
import { applyCtrl, clearKeyBarTarget, keyBar, sendArrow, sendKeys, setKeyBarTarget } from '../src/lib/stores/keyBar.svelte.js'

// A stand-in for an xterm.js Terminal.
function fakeTerminal(applicationCursorKeysMode = false) {
  const typed = []
  return { typed, modes: { applicationCursorKeysMode }, input: (data) => typed.push(data), focus() {} }
}

describe('applyCtrl', () => {
  it('passes keys through without Ctrl', () => {
    keyBar.ctrl = false
    expect(applyCtrl('c')).toBe('c')
  })

  it('turns the next letter into its control character, either case', () => {
    keyBar.ctrl = true
    expect(applyCtrl('c')).toBe('\x03')
    expect(keyBar.ctrl).toBe(false)
    keyBar.ctrl = true
    expect(applyCtrl('D')).toBe('\x04')
  })

  it('releases Ctrl on any key, leaving others alone', () => {
    keyBar.ctrl = true
    expect(applyCtrl('1')).toBe('1')
    expect(keyBar.ctrl).toBe(false)
    keyBar.ctrl = true
    expect(applyCtrl('\x1b[A')).toBe('\x1b[A')
    expect(keyBar.ctrl).toBe(false)
  })
})

describe('sending keys', () => {
  it('types into the terminal that last had the focus', () => {
    const first = fakeTerminal()
    const second = fakeTerminal()
    setKeyBarTarget(first)
    setKeyBarTarget(second)
    sendKeys('\t')
    expect(first.typed).toEqual([])
    expect(second.typed).toEqual(['\t'])
    clearKeyBarTarget(second)
    sendKeys('x')
    expect(second.typed).toEqual(['\t'])
  })

  it('sends arrows in the mode full-screen programs ask for', () => {
    const shell = fakeTerminal(false)
    setKeyBarTarget(shell)
    sendArrow('A')
    const nano = fakeTerminal(true)
    setKeyBarTarget(nano)
    sendArrow('A')
    expect(shell.typed).toEqual(['\x1b[A'])
    expect(nano.typed).toEqual(['\x1bOA'])
  })
})
