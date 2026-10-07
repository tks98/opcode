<!--
  Editor.svelte - Monaco code editor

  One Monaco model per file keeps undo history and cursor position when
  switching tabs. Changes made outside the editor (for example by a command
  in the terminal) are applied to the model as undoable edits.
-->

<script>
  import { onMount } from 'svelte'
  import { projectStore } from '../stores/projects.svelte.js'
  import { monacoLanguageFor } from '../languages.js'
  import { themeStore } from '../stores/theme.svelte.js'
  import { CODE_FONT, codeFontReady, monacoThemeName } from '../editorThemes.js'
  import { mayTakeFocus } from '../actions.js'

  let { onRun = () => {} } = $props()

  let container = $state(null)
  let editor = $state(null)
  let loadError = $state(null)
  let monaco = null

  const models = new Map() // file id -> model
  const viewStates = new Map() // file id -> saved cursor/scroll
  let currentFileId = null
  let applyingExternalChange = false

  // Phones wrap long lines instead of scrolling sideways, and give the code
  // the width the line numbers and folding arrows would take.
  const narrowQuery = typeof matchMedia === 'undefined' ? null : matchMedia('(max-width: 760px)')
  let narrow = $state(narrowQuery?.matches ?? false)
  const widthOptions = (narrow) =>
    narrow ? { wordWrap: 'on', wrappingIndent: 'indent', lineNumbersMinChars: 2, folding: false } : { wordWrap: 'off', lineNumbersMinChars: 5, folding: true }

  $effect(() => {
    const onChange = (event) => (narrow = event.matches)
    narrowQuery?.addEventListener('change', onChange)
    return () => narrowQuery?.removeEventListener('change', onChange)
  })

  $effect(() => {
    editor?.updateOptions(widthOptions(narrow))
  })

  // Follow the editor colour theme (Monaco themes are global).
  $effect(() => {
    const name = monacoThemeName(themeStore.editorTheme)
    if (editor) monaco.editor.setTheme(name)
  })

  onMount(() => {
    let disposed = false
    // Measure text with the real font, not a fallback.
    Promise.all([import('../monaco.js'), codeFontReady()])
      .then(([module]) => {
        if (disposed) return
        monaco = module.monaco
        editor = monaco.editor.create(container, {
          model: null,
          theme: monacoThemeName(themeStore.editorTheme),
          fontSize: 15,
          lineHeight: 24,
          fontFamily: CODE_FONT,
          fontLigatures: false,
          lineNumbers: 'on',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 4,
          insertSpaces: true,
          renderWhitespace: 'selection',
          bracketPairColorization: { enabled: true },
          padding: { top: 14 },
          roundedSelection: true,
          cursorBlinking: 'smooth',
          cursorWidth: 2,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
          ...widthOptions(narrow),
        })

        editor.onDidChangeModelContent(() => {
          if (applyingExternalChange || !currentFileId) return
          projectStore.updateFile(currentFileId, editor.getValue())
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRun())
        // Files save automatically; swallow the browser's "Save page" dialog.
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {})
      })
      .catch((error) => {
        console.error(error)
        loadError = 'The editor failed to load. Check your connection and reload the page.'
      })

    return () => {
      disposed = true
      for (const model of models.values()) model.dispose()
      models.clear()
      editor?.dispose()
    }
  })

  function modelFor(file) {
    let model = models.get(file.id)
    const language = monacoLanguageFor(file.path)
    if (!model || model.isDisposed()) {
      model = monaco.editor.createModel(file.content, language)
      // Go and Makefiles are indented with tabs by convention.
      model.updateOptions({ insertSpaces: !/(\.go|Makefile)$/.test(file.path) })
      models.set(file.id, model)
    } else if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language)
    }
    return model
  }

  // Bring a model in line with the store without losing undo history.
  function syncModel(model, content) {
    if (model.getValue() === content) return
    applyingExternalChange = true
    try {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
    } finally {
      applyingExternalChange = false
    }
  }

  // Show the active file.
  $effect(() => {
    const file = projectStore.activeFile
    const content = file?.content
    const path = file?.path
    if (!editor) return

    if (!file) {
      if (currentFileId) viewStates.set(currentFileId, editor.saveViewState())
      currentFileId = null
      editor.setModel(null)
      return
    }

    const model = modelFor({ id: file.id, path, content })
    if (currentFileId !== file.id) {
      if (currentFileId) viewStates.set(currentFileId, editor.saveViewState())
      currentFileId = file.id
      syncModel(model, content)
      editor.setModel(model)
      const viewState = viewStates.get(file.id)
      if (viewState) editor.restoreViewState(viewState)
      // Not while someone is in a menu or typing a name (the editor may
      // finish loading just then).
      if (mayTakeFocus()) editor.focus()
    } else {
      syncModel(model, content)
    }
  })

  // Dispose models of files that no longer exist (in any project).
  $effect(() => {
    const ids = new Set(projectStore.projects.flatMap((p) => p.files.map((f) => f.id)))
    for (const [id, model] of models) {
      if (!ids.has(id)) {
        model.dispose()
        models.delete(id)
        viewStates.delete(id)
      }
    }
  })

  export function focus() {
    editor?.focus()
  }
</script>

<div class="editor-wrapper">
  <div class="editor-container" bind:this={container}></div>
  {#if loadError}
    <div class="placeholder error">{loadError}</div>
  {:else if !editor}
    <div class="placeholder">Loading editor…</div>
  {:else if !projectStore.activeFile}
    <div class="placeholder">
      <p>No file open</p>
      <p class="hint">Pick a file from the list, or make a new one.</p>
    </div>
  {/if}
</div>

<style>
  .editor-wrapper {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .editor-container {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    background: var(--editor-bg, var(--surface));
    color: var(--muted);
    pointer-events: none;
  }

  .placeholder p {
    margin: 0;
    font-weight: 700;
  }

  .placeholder .hint {
    font-size: 14px;
    font-weight: 400;
  }

  .placeholder.error {
    color: var(--danger);
  }
</style>
