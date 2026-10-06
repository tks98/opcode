// ============================================
// THEME STORE
// ============================================
// Light or dark for the app (following the system until someone picks one),
// and the colour theme for the editor and terminals. Both are per-browser
// preferences kept in localStorage. index.html applies the saved mode before
// the app loads, so the page never flashes the wrong colours.

import { AUTO_THEME, EDITOR_THEMES, resolveEditorTheme } from '../editorThemes.js'

const MODE_KEY = 'opcode-theme'
const EDITOR_KEY = 'opcode-editor-theme'

function read(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the choice lasts until the page is closed.
  }
}

const media = typeof matchMedia === 'undefined' ? null : matchMedia('(prefers-color-scheme: dark)')
const savedMode = read(MODE_KEY)
const savedEditor = read(EDITOR_KEY)

const state = $state({
  choice: savedMode === 'light' || savedMode === 'dark' ? savedMode : null,
  system: media?.matches ? 'dark' : 'light',
  editor: savedEditor && (savedEditor === AUTO_THEME || EDITOR_THEMES[savedEditor]) ? savedEditor : AUTO_THEME,
})

media?.addEventListener('change', (event) => {
  state.system = event.matches ? 'dark' : 'light'
  apply()
})

function apply() {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = themeStore.mode
}

export const themeStore = {
  /** 'light' or 'dark'. */
  get mode() {
    return state.choice ?? state.system
  },

  toggle() {
    state.choice = this.mode === 'dark' ? 'light' : 'dark'
    write(MODE_KEY, state.choice)
    apply()
  },

  /** The editor theme picked: a theme id, or 'auto' to follow the mode. */
  get editorChoice() {
    return state.editor
  },

  /** The editor theme in use. */
  get editorTheme() {
    return resolveEditorTheme(state.editor, this.mode)
  },

  setEditorTheme(id) {
    state.editor = id === AUTO_THEME || EDITOR_THEMES[id] ? id : AUTO_THEME
    write(EDITOR_KEY, state.editor === AUTO_THEME ? null : state.editor)
  },
}

apply()
