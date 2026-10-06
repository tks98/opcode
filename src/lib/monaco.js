// Monaco, bundled locally (no CDN) with the full set of editor features and
// syntax highlighting for every language (grammars load on demand). The
// heavyweight TypeScript/JSON/CSS/HTML language services are left out.

import 'monaco-editor/features/register.all.js'
import 'monaco-editor/languages/definitions/register.all.js'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { EDITOR_THEMES, monacoTheme, monacoThemeName } from './editorThemes.js'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

for (const id of Object.keys(EDITOR_THEMES)) monaco.editor.defineTheme(monacoThemeName(id), monacoTheme(id))

export { monaco }
