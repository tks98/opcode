// Colour themes for the code editor (Monaco) and the terminals (xterm.js).
// Both use the same theme, so code and its output look like one notebook.
// "auto" follows the app: Notebook in light mode, Blueprint in dark mode.

export const AUTO_THEME = 'auto'

/** The code font (see app.css), for Monaco and xterm.js. */
export const CODE_FONT = "'Recursive Mono', ui-monospace, 'DejaVu Sans Mono', Menlo, Consolas, monospace"

/** Resolves once the code font can be measured (or failed to load). */
export function codeFontReady(size = 15) {
  return typeof document === 'undefined' || !document.fonts ? Promise.resolve() : document.fonts.load(`${size}px 'Recursive Mono'`).catch(() => {})
}

/**
 * `syntax` colours code; `ansi` is the terminal's 16-colour palette, chosen
 * so every colour programs print (yellow warnings included) stays readable
 * on that theme's background.
 */
export const EDITOR_THEMES = {
  notebook: {
    name: 'Notebook',
    note: 'Ink on paper',
    dark: false,
    syntax: { bg: '#fbfcfe', text: '#1b2b4b', gutter: '#7f8ea7', kw: '#2f6fb5', str: '#b7410e', fn: '#00796b', num: '#8a5a00', com: '#5f6f88', line: '#eef3f9' },
    term: { bg: '#f2f6fb', cursor: '#1b2b4b', selection: 'rgba(255, 216, 77, 0.5)' },
    ansi: ['#1b2b4b', '#b42318', '#2e7d32', '#8a5a00', '#2f6fb5', '#9c3d8f', '#00796b', '#5f6f88', '#56647c', '#c8372a', '#2b7a2f', '#8f5f00', '#1f5fbf', '#a84399', '#00796b', '#1b2b4b'],
  },
  blueprint: {
    name: 'Blueprint',
    note: 'White lines on blue',
    dark: true,
    syntax: { bg: '#0f2a4a', text: '#eaf2ff', gutter: '#5f7fa6', kw: '#8cc8ff', str: '#ffd84d', fn: '#7fe0c2', num: '#ffb38a', com: '#8aa3c2', line: '#14335a' },
    term: { bg: '#0b213c', cursor: '#ffd84d', selection: 'rgba(255, 216, 77, 0.3)' },
    ansi: ['#5a80ad', '#ff8a80', '#7fe0a0', '#ffd84d', '#8cc8ff', '#e5a3ff', '#7fe0c2', '#d6e4f7', '#8aa3c2', '#ffb3ad', '#a8f0c0', '#ffe68a', '#b5dcff', '#f0c4ff', '#a8f0da', '#ffffff'],
  },
  highlighter: {
    name: 'Highlighter',
    note: 'Bright and cheerful',
    dark: false,
    syntax: { bg: '#fffdf3', text: '#2a2a33', gutter: '#938d74', kw: '#c22f69', str: '#187a41', fn: '#2563c9', num: '#b05400', com: '#706a54', line: '#f7f2dc' },
    term: { bg: '#fbf7e4', cursor: '#2a2a33', selection: 'rgba(210, 60, 119, 0.22)' },
    ansi: ['#2a2a33', '#c0262d', '#187a41', '#8f4a00', '#2563c9', '#c02f6b', '#0b7480', '#706a54', '#5f5a49', '#b8292e', '#17733e', '#9a5200', '#2a5fbd', '#b52a62', '#0a6e79', '#2a2a33'],
  },
  contrast: {
    name: 'High contrast',
    note: 'Easiest to read',
    dark: false,
    syntax: { bg: '#ffffff', text: '#000000', gutter: '#555555', kw: '#0033b3', str: '#8c1700', fn: '#005c40', num: '#6b3a00', com: '#4d4d4d', line: '#f0f0f0' },
    term: { bg: '#ffffff', cursor: '#000000', selection: 'rgba(0, 51, 179, 0.25)' },
    ansi: ['#000000', '#a50e0e', '#0b6b1f', '#6b4e00', '#0033b3', '#8b0a8b', '#005c5c', '#4d4d4d', '#333333', '#a50e0e', '#0b6b1f', '#6b4e00', '#0033b3', '#8b0a8b', '#005c5c', '#000000'],
  },
  midnight: {
    name: 'High contrast dark',
    note: 'Bright on black',
    dark: true,
    syntax: { bg: '#000000', text: '#ffffff', gutter: '#a0a0a0', kw: '#8cc8ff', str: '#ffd84d', fn: '#7fe0c2', num: '#ffb38a', com: '#c0c0c0', line: '#1a1a1a' },
    term: { bg: '#000000', cursor: '#ffd84d', selection: 'rgba(255, 216, 77, 0.35)' },
    ansi: ['#808080', '#ff8a80', '#7fe0a0', '#ffd84d', '#8cc8ff', '#f0a8ff', '#7fe0e0', '#ffffff', '#c0c0c0', '#ffb3ad', '#a8f0c0', '#ffe68a', '#b5dcff', '#f5c8ff', '#a8f0f0', '#ffffff'],
  },
}

/** The theme to show for a choice (a theme id or "auto") in a UI mode. */
export function resolveEditorTheme(choice, mode) {
  if (choice !== AUTO_THEME && EDITOR_THEMES[choice]) return choice
  return mode === 'dark' ? 'blueprint' : 'notebook'
}

/** Monaco's name for an editor theme. */
export function monacoThemeName(id) {
  return `opcode-${id}`
}

/** A Monaco theme definition (monaco.editor.defineTheme). */
export function monacoTheme(id) {
  const { dark, syntax: s } = EDITOR_THEMES[id]
  const hex = (color) => color.replace('#', '')
  const rule = (token, color, fontStyle) => ({ token, foreground: hex(color), ...(fontStyle ? { fontStyle } : {}) })
  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      rule('', s.text),
      rule('comment', s.com),
      rule('keyword', s.kw, 'bold'),
      rule('keyword.directive', s.kw),
      rule('keyword.flow', s.kw, 'bold'),
      rule('storage', s.kw, 'bold'),
      rule('string', s.str),
      rule('string.escape', s.num),
      rule('regexp', s.str),
      rule('number', s.num),
      rule('constant', s.num),
      rule('type', s.fn),
      rule('type.identifier', s.fn),
      rule('predefined', s.fn),
      rule('function', s.fn),
      rule('annotation', s.fn),
      rule('variable', s.fn),
      rule('variable.predefined', s.fn),
      rule('identifier', s.text),
      rule('delimiter', s.text),
      rule('operator', s.text),
      rule('tag', s.kw),
      rule('metatag', s.kw),
      rule('attribute.name', s.fn),
      rule('attribute.value', s.str),
    ],
    colors: {
      'editor.background': s.bg,
      'editor.foreground': s.text,
      'editorLineNumber.foreground': s.gutter,
      'editorLineNumber.activeForeground': s.text,
      'editorCursor.foreground': dark ? '#ffd84d' : s.text,
      'editor.selectionBackground': dark ? '#ffd84d40' : '#ffd84d80',
      'editor.inactiveSelectionBackground': dark ? '#ffd84d26' : '#ffd84d4d',
      'editor.selectionHighlightBackground': dark ? '#ffd84d1f' : '#ffd84d40',
      'editor.lineHighlightBackground': s.line,
      'editor.lineHighlightBorder': s.line,
      'editorIndentGuide.background1': `${s.gutter}40`,
      'editorIndentGuide.activeBackground1': `${s.gutter}99`,
      'editorWhitespace.foreground': `${s.gutter}80`,
      'editorBracketHighlight.foreground1': s.kw,
      'editorBracketHighlight.foreground2': s.fn,
      'editorBracketHighlight.foreground3': s.num,
      'editorBracketMatch.border': s.gutter,
      'editorBracketMatch.background': '#00000000',
      'editorGutter.background': s.bg,
      'editorWidget.background': s.bg,
      'editorSuggestWidget.background': s.bg,
      'editorHoverWidget.background': s.bg,
      'scrollbarSlider.background': `${s.gutter}40`,
      'scrollbarSlider.hoverBackground': `${s.gutter}66`,
      'scrollbarSlider.activeBackground': `${s.gutter}99`,
      'scrollbar.shadow': '#00000000',
    },
  }
}

/** An xterm.js theme (ITheme). */
export function xtermTheme(id) {
  const { syntax, term, ansi } = EDITOR_THEMES[id]
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
  const colors = {}
  names.forEach((name, i) => {
    colors[name] = ansi[i]
    colors[`bright${name[0].toUpperCase()}${name.slice(1)}`] = ansi[i + 8]
  })
  return {
    background: term.bg,
    foreground: syntax.text,
    cursor: term.cursor,
    cursorAccent: term.bg,
    selectionBackground: term.selection,
    ...colors,
  }
}
