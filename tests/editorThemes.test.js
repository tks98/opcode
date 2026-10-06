import { describe, expect, it } from 'vitest'
import { AUTO_THEME, EDITOR_THEMES, monacoTheme, resolveEditorTheme, xtermTheme } from '../src/lib/editorThemes.js'

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

describe('editor themes', () => {
  it('follows the app until a theme is picked', () => {
    expect(resolveEditorTheme(AUTO_THEME, 'light')).toBe('notebook')
    expect(resolveEditorTheme(AUTO_THEME, 'dark')).toBe('blueprint')
    expect(resolveEditorTheme('highlighter', 'dark')).toBe('highlighter')
    expect(resolveEditorTheme('missing', 'dark')).toBe('blueprint')
  })

  it('keeps code and terminal colors readable (4.5:1) in every theme', () => {
    for (const [id, theme] of Object.entries(EDITOR_THEMES)) {
      for (const key of ['text', 'kw', 'str', 'fn', 'num', 'com']) {
        expect(contrast(theme.syntax[key], theme.syntax.bg), `${id} ${key}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(theme.syntax.gutter, theme.syntax.bg), `${id} line numbers`).toBeGreaterThanOrEqual(3)
      // ANSI black is meant to sit near a dark background; every other colour must read.
      theme.ansi.slice(1).forEach((color, i) => {
        expect(contrast(color, theme.term.bg), `${id} ansi ${i + 1}`).toBeGreaterThanOrEqual(4.5)
      })
    }
  })

  it('builds Monaco and xterm.js themes', () => {
    const monaco = monacoTheme('blueprint')
    expect(monaco.base).toBe('vs-dark')
    expect(monaco.colors['editor.background']).toBe('#0f2a4a')
    expect(monaco.rules.find((rule) => rule.token === 'keyword').foreground).toBe('8cc8ff')
    const xterm = xtermTheme('notebook')
    expect(xterm.background).toBe('#f2f6fb')
    expect(xterm.yellow).toBe('#8a5a00')
    expect(xterm.brightWhite).toBe('#1b2b4b')
  })
})
