<!--
  App.svelte - application shell

  The start screen (pick a language, or carry on with a project), then the
  coding screen: files, editor and a real terminal per project. Each project
  runs in its own WebAssembly sandbox (see lib/runtime/ProjectSandbox.svelte.js);
  files are mirrored both ways between the editor and the terminal's ~/
  (/workspace). The coding screen stays mounted behind the start screen, so
  terminals keep their scrollback and running programs.
-->

<script>
  import { onMount, untrack } from 'svelte'
  import { projectStore, uniqueProjectName } from './lib/stores/projects.svelte.js'
  import { sessionStore } from './lib/stores/sessions.svelte.js'
  import { linuxStore } from './lib/stores/linux.svelte.js'
  import { pruneMachines } from './lib/linux/machineStorage.js'
  import { MACHINE_FILE_EXTENSION, sharedMachineName, sharedMachineUrl } from './lib/linux/machineFile.js'
  import { MACHINES, machineKindOf } from './lib/linux/machines.js'
  import { readZip, zipContents } from './lib/runtime/toolchains.js'
  import { environmentProblem } from './lib/runtime/wasmer.js'
  import { decodeText } from './lib/runtime/workspaceSync.js'
  import { LANGUAGES, WEB_PORT, runPlanFor } from './lib/languages.js'
  import { EDITOR_THEMES } from './lib/editorThemes.js'
  import { themeStore } from './lib/stores/theme.svelte.js'
  import StartScreen from './lib/components/StartScreen.svelte'
  import TopBar from './lib/components/TopBar.svelte'
  import Sidebar from './lib/components/Sidebar.svelte'
  import Tabs from './lib/components/Tabs.svelte'
  import Editor from './lib/components/Editor.svelte'
  import Terminal from './lib/components/Terminal.svelte'
  import StatusBar from './lib/components/StatusBar.svelte'
  import KeyBar from './lib/components/KeyBar.svelte'
  import LinuxWorkspace from './lib/components/LinuxWorkspace.svelte'
  import Preview from './lib/components/Preview.svelte'
  import InternetSettings from './lib/components/InternetSettings.svelte'
  import ConfirmDialog from './lib/components/ConfirmDialog.svelte'
  import { isIgnoredPath } from './lib/paths.js'
  import { previewStore } from './lib/stores/preview.svelte.js'
  import { trackViewport, viewport } from './lib/stores/viewport.svelte.js'

  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
  const MAX_IMPORT_FILES = 2000
  const MAX_IMPORT_BYTES = 50 * 1000 * 1000
  // JSZip reads a whole zip into memory. Big ones are mostly files the import
  // skips anyway (binaries, node_modules), so allow some room over the 50 MB.
  const MAX_ZIP_BYTES = 200 * 1000 * 1000

  const layout = readLayout()
  const narrowQuery = typeof matchMedia === 'undefined' ? null : matchMedia('(max-width: 760px)')
  let editorHeight = $state(layout.editorHeight ?? 60) // percent of the editor area
  let previewWidth = $state(layout.previewWidth ?? 42) // percent of the workspace
  let terminalVisible = $state(layout.terminalVisible ?? true)
  // Phones show the files as a drawer over the editor.
  let narrow = $state(narrowQuery?.matches ?? false)
  let sidebarOpen = $state(!narrowQuery?.matches)
  let home = $state(false)
  let ideMounted = $state(false)
  let showInternet = $state(false)
  let resizing = $state(false)
  let resizingPreview = $state(false)
  let notice = $state(null)
  let noticeTimer = null
  let terminal = $state(null)
  let importInput = $state(null)
  let environmentIssue = $state(null)
  // A ?machine= link waiting for the user to agree: { url, host }.
  let sharedMachine = $state(null)
  // Where the last text input focus went: 'editor', 'terminal' or null.
  let typingIn = $state(null)

  let project = $derived(projectStore.activeProject)
  let activeFile = $derived(projectStore.activeFile)
  let isLinux = $derived(project?.kind === 'linux')
  let session = $derived(project && !isLinux ? sessionStore.get(project.id) : null)
  let machine = $derived(project && isLinux ? linuxStore.get(project.id) : null)
  let showPreview = $derived(previewStore.visible && previewStore.projectId === project?.id)
  // Ports with a web server the preview can show, in the terminal or the machine.
  let servers = $derived((isLinux ? machine?.servers : session?.servers) ?? [])
  let showStart = $derived(home || !project)
  let editorTheme = $derived(EDITOR_THEMES[themeStore.editorTheme])
  // Phones with the on-screen keyboard up show only the panel being typed in.
  let keyboardFor = $derived(narrow && viewport.keyboardOpen ? typingIn : null)
  // Keys the on-screen keyboard lacks, while typing in a terminal.
  let showKeyBar = $derived(viewport.keyboardOpen && typingIn === 'terminal')

  onMount(() => {
    environmentIssue = environmentProblem()
    const onNarrowChange = (event) => {
      narrow = event.matches
      sidebarOpen = !event.matches
    }
    narrowQuery?.addEventListener('change', onNarrowChange)
    const onFocusIn = (event) => {
      const target = event.target
      typingIn = target.closest?.('.bottom-panel, .terminal-view') ? 'terminal' : target.closest?.('.editor-panel') ? 'editor' : null
    }
    document.addEventListener('focusin', onFocusIn)
    const stopTrackingViewport = trackViewport()
    projectStore.load().then(async () => {
      // Unless the saved projects couldn't be read, when every machine would look unused.
      if (!projectStore.loadError) await pruneMachines(new Set(projectStore.projects.filter((p) => p.kind === 'linux').map((p) => p.id)))
      openSharedMachine()
    })
    return () => {
      narrowQuery?.removeEventListener('change', onNarrowChange)
      document.removeEventListener('focusin', onFocusIn)
      stopTrackingViewport()
    }
  })

  // Opening, creating or importing a project goes to the coding screen.
  $effect(() => {
    if (projectStore.activeProjectId) untrack(() => (home = false))
  })

  // Mount the coding screen the first time it is needed, then keep it.
  $effect(() => {
    if (!showStart) ideMounted = true
  })

  // Per-browser layout preferences (not part of any project).
  function readLayout() {
    try {
      return JSON.parse(localStorage.getItem('opcode-layout')) ?? {}
    } catch {
      return {}
    }
  }

  $effect(() => {
    const value = JSON.stringify({ editorHeight: Math.round(editorHeight), previewWidth: Math.round(previewWidth), terminalVisible })
    try {
      localStorage.setItem('opcode-layout', value)
    } catch {
      // Storage unavailable; the layout just isn't remembered.
    }
  })

  $effect(() => {
    document.title = project && !showStart ? `${project.name} · Opcode` : 'Opcode'
  })

  // Start (or resume) the active project's terminal or Linux machine.
  $effect(() => {
    const current = projectStore.loaded ? projectStore.activeProject : null
    if (!current) return
    const { id, kind } = current
    untrack(() => {
      if (kind === 'linux') linuxStore.open(id, machineKindOf(current))
      else if (!environmentIssue) sessionStore.open(id)
    })
  })

  // Mirror editor changes into the active project's sandbox.
  $effect(() => {
    const current = project
    if (!current) return
    for (const file of current.files) {
      file.path
      file.content
    }
    current.folders.length
    const session = sessionStore.get(current.id)
    untrack(() => session?.scheduleSync())
  })

  // Follow web servers programs start: the preview opens for a new one (in
  // the active project) and follows the one it shows as it stops and starts.
  $effect(() => {
    const live = sessionStore.sessions.map((s) => ({ id: s.projectId, ports: [...s.servers] }))
    const running = linuxStore.machine
    if (running) live.push({ id: running.projectId, ports: [...running.servers] })
    const activeId = project?.id
    untrack(() => {
      for (const { id, ports } of live) previewStore.serversChanged(id, ports, { announce: id === activeId })
      if (previewStore.projectId !== null && !live.some((s) => s.id === previewStore.projectId)) {
        previewStore.sessionClosed(previewStore.projectId)
      }
    })
  })

  // R's plots (from Rscript or the R console) show in the preview.
  $effect(() => {
    const plots = session?.plots
    if (!plots) return
    untrack(() => previewStore.showPlots(session.projectId, plots.images))
  })

  // Close terminals of deleted projects.
  $effect(() => {
    const ids = new Set(projectStore.projects.map((p) => p.id))
    const stale = sessionStore.sessions.filter((s) => !ids.has(s.projectId))
    const machine = linuxStore.machine
    untrack(() => {
      stale.forEach((s) => sessionStore.close(s.projectId))
      if (machine && !ids.has(machine.projectId)) linuxStore.remove(machine.projectId)
    })
  })

  // ============================================
  // START SCREEN
  // ============================================

  function createProject(language) {
    const base = MACHINES[language]?.newProjectName ?? `${LANGUAGES[language].name} project`
    projectStore.createProject(uniqueProjectName(projectStore.projects, base), language)
    home = false
  }

  function openProject(id) {
    projectStore.setActiveProject(id)
    home = false
  }

  function showNotice(text, kind = 'info') {
    notice = { text, kind }
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => (notice = null), 5000)
  }

  // ============================================
  // RUN / STOP
  // ============================================

  // A web page waiting for its server to start: { projectId, path }.
  let pendingPage = $state(null)

  function runActiveFile() {
    if (showStart || !activeFile || !session) return
    const plan = runPlanFor(activeFile.path, project.files, project.language)
    if (plan?.preview) {
      // Web pages: show the page, starting the server if it isn't running.
      if (session.servers.includes(WEB_PORT)) {
        previewStore.show(project.id, WEB_PORT, plan.preview)
        return
      }
      pendingPage = { projectId: project.id, path: plan.preview }
    } else if (session.busy) {
      return
    }
    terminalVisible = true
    // Phones typing with the on-screen keyboard carry on in the terminal.
    // iOS keeps the keyboard up only for a focus made during the tap itself.
    if (narrow && viewport.keyboardOpen) terminal?.focus()
    session.run(activeFile.path)
  }

  // Open the page Run asked for once its server is up.
  $effect(() => {
    const pending = pendingPage
    const servers = sessionStore.get(pending?.projectId)?.servers
    if (!pending || !servers?.includes(WEB_PORT)) return
    untrack(() => {
      pendingPage = null
      previewStore.show(pending.projectId, WEB_PORT, pending.path)
    })
  })

  // Web pages update as you type: reload the preview after each edit reaches
  // the sandbox.
  $effect(() => {
    const pushes = session?.pushes
    if (!pushes || project?.language !== 'web') return
    untrack(() => {
      if (previewStore.visible && previewStore.projectId === project.id && previewStore.status === 'ready') previewStore.reload()
    })
  })

  function stop() {
    session?.stop()
  }

  // ============================================
  // IMPORT / EXPORT
  // ============================================

  async function exportToZip() {
    if (!project) return
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    // Programs can create files with any name; leave out those that could
    // land outside the folder the zip is unpacked into.
    const { files, folders, skipped } = zipContents(project)
    for (const folder of folders) zip.folder(folder)
    for (const file of files) zip.file(file.path, file.content)
    const blob = await zip.generateAsync({ type: 'blob' })
    const safeName = project.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'project'
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${safeName}.zip`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    showNotice(`Exported "${project.name}" as ${safeName}.zip${skipped ? ` (left out ${skipped} file${skipped === 1 ? '' : 's'} with names a zip can't hold safely)` : ''}`)
  }

  async function importFile(file) {
    if (file.name.toLowerCase().endsWith(MACHINE_FILE_EXTENSION)) return importMachine(file, file.name.slice(0, -MACHINE_FILE_EXTENSION.length))
    return importZip(file)
  }

  async function importMachine(blob, fallbackName) {
    try {
      const name = await linuxStore.importFile(blob, fallbackName)
      showNotice(`Opened the machine "${name}"`)
    } catch (error) {
      showNotice(error.message, 'error')
    }
  }

  // A shared machine: ?machine=https://…/lab.opcode-linux opens it as a new
  // project (the server must allow cross-origin requests), once the user
  // agrees: any page can link here, and the machine runs as soon as it opens.
  function openSharedMachine() {
    const params = new URLSearchParams(location.search)
    const source = params.get('machine')
    if (!source) return
    params.delete('machine')
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`)
    const url = sharedMachineUrl(source, location.href)
    if (!url) {
      showNotice('Could not open the shared machine: the link is not a web address.', 'error')
      return
    }
    sharedMachine = { url: url.href, host: url.host }
  }

  async function confirmSharedMachine() {
    const { url } = sharedMachine
    sharedMachine = null
    try {
      const blob = await linuxStore.downloadShared(url, (progress) => {
        if (progress?.phase === 'downloading') showNotice(`Downloading the shared machine… ${progress.percent == null ? '' : `${Math.floor(progress.percent)}%`}`)
      })
      await importMachine(blob, sharedMachineName(url))
    } catch (error) {
      showNotice(`Could not open the shared machine: ${error.message}`, 'error')
    }
  }

  async function importZip(file) {
    try {
      if (file.size > MAX_ZIP_BYTES) throw new Error(`it is ${Math.round(file.size / 1e6)} MB; Opcode can import zips up to ${MAX_ZIP_BYTES / 1e6} MB`)
      const { default: JSZip } = await import('jszip')
      const zip = await JSZip.loadAsync(file)
      // Unpacked in pieces, to the real sizes (see readZip): a small zip can
      // expand to gigabytes, and the whole workspace is saved as one record.
      const { files: entries, tooBig } = await readZip(zip, { maxFiles: MAX_IMPORT_FILES, maxFileBytes: MAX_UPLOAD_BYTES, maxTotalBytes: MAX_IMPORT_BYTES })
      const files = []
      let skipped = tooBig
      for (const { path, bytes } of entries) {
        const text = decodeText(bytes)
        if (text === null) skipped++
        else files.push({ path, content: text })
      }
      const name = file.name.replace(/\.zip$/i, '') || 'Imported Project'
      projectStore.importProject(name, files)
      showNotice(`Imported ${files.length} file${files.length === 1 ? '' : 's'}${skipped ? ` (skipped ${skipped} binary or large file${skipped === 1 ? '' : 's'})` : ''}`)
    } catch (error) {
      showNotice(`Could not import ${file.name}: ${error.message}`, 'error')
    }
  }

  async function uploadFiles(fileList) {
    // The same limits as importing a zip, which also leaves out folders the
    // editor never shows (node_modules, .git): a folder that has them would
    // otherwise always be over the limit.
    const all = [...fileList].filter((file) => !isIgnoredPath(file.webkitRelativePath || file.name))
    const total = all.reduce((sum, file) => sum + (file.size > MAX_UPLOAD_BYTES ? 0 : file.size), 0)
    if (all.length > MAX_IMPORT_FILES || total > MAX_IMPORT_BYTES) {
      showNotice(`Could not add ${all.length} files (${Math.round(total / 1e6)} MB): you can add up to ${MAX_IMPORT_FILES} files and ${MAX_IMPORT_BYTES / 1e6} MB at a time.`, 'error')
      return
    }
    const files = []
    let skipped = 0
    for (const file of all) {
      if (file.size > MAX_UPLOAD_BYTES) {
        skipped++
        continue
      }
      const text = decodeText(new Uint8Array(await file.arrayBuffer()))
      if (text === null) skipped++
      else files.push({ path: file.webkitRelativePath || file.name, content: text })
    }
    const added = projectStore.addFiles(files)
    if (added || skipped) {
      showNotice(`Added ${added} file${added === 1 ? '' : 's'}${skipped ? `; skipped ${skipped} (binary or over 2 MB)` : ''}`, skipped && !added ? 'error' : 'info')
    }
  }

  // ============================================
  // KEYBOARD SHORTCUTS & LAYOUT
  // ============================================

  function onKeydown(event) {
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 's') {
      // Everything saves automatically.
      event.preventDefault()
      return
    }
    if (showStart) return
    if (event.key === 'Escape' && narrow && sidebarOpen) {
      sidebarOpen = false
    } else if (mod && event.key === 'Enter') {
      event.preventDefault()
      runActiveFile()
    } else if (event.ctrlKey && event.shiftKey && event.code === 'Backquote') {
      event.preventDefault()
      if (isLinux) return
      terminalVisible = true
      queueMicrotask(() => terminal?.newTerminal())
    } else if (event.ctrlKey && event.key === '`') {
      event.preventDefault()
      terminalVisible = true
      queueMicrotask(() => terminal?.focus())
    }
  }

  function toggleTerminal() {
    terminalVisible = !terminalVisible
    if (terminalVisible) queueMicrotask(() => terminal?.focus())
  }

  function newTerminal() {
    terminalVisible = true
    queueMicrotask(() => terminal?.newTerminal())
  }

  function startResize(event) {
    resizing = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onResize(event) {
    if (!resizing) return
    const area = event.currentTarget.parentElement.getBoundingClientRect()
    editorHeight = Math.max(15, Math.min(85, ((event.clientY - area.top) / area.height) * 100))
  }

  function stopResize() {
    resizing = false
  }

  function startPreviewResize(event) {
    resizingPreview = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPreviewResize(event) {
    if (!resizingPreview) return
    const area = event.currentTarget.parentElement.getBoundingClientRect()
    previewWidth = Math.max(20, Math.min(75, ((area.right - event.clientX) / area.width) * 100))
  }

  function openPreview() {
    if (!project || !servers.length) return
    const port = servers.includes(previewStore.port) ? previewStore.port : servers[0]
    previewStore.show(project.id, port)
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  {#if !projectStore.loaded}
    <div class="loading">Loading your projects…</div>
  {:else}
    {#if showStart}
      <StartScreen
        onCreate={createProject}
        onOpen={openProject}
        onImport={() => importInput.click()}
        onBack={project ? () => (home = false) : null}
        {environmentIssue}
      />
    {/if}

    {#if ideMounted && project}
      <div class="ide" class:typing={keyboardFor} hidden={showStart} style="--editor-bg: {editorTheme.syntax.bg}; --term-bg: {editorTheme.term.bg}">
        <TopBar
          {project}
          {session}
          file={activeFile}
          filesOpen={sidebarOpen}
          {terminalVisible}
          onHome={() => (home = true)}
          onRun={runActiveFile}
          onStop={stop}
          onPreview={showPreview ? null : openPreview}
          {servers}
          onImport={() => importInput.click()}
          onExport={exportToZip}
          onInternet={() => (showInternet = true)}
          onToggleFiles={() => (sidebarOpen = !sidebarOpen)}
          onToggleTerminal={toggleTerminal}
          onNewTerminal={newTerminal}
        />

        {#if environmentIssue && !isLinux}
          <div class="banner" role="alert">{environmentIssue}</div>
        {/if}

        <div class="main">
          {#if isLinux}
            <LinuxWorkspace {machine} name={project.name} onNotice={showNotice} />
          {:else}
            {#if sidebarOpen}
              {#if narrow}
                <div class="drawer-backdrop" onclick={() => (sidebarOpen = false)} role="presentation"></div>
              {/if}
              <div class="sidebar-slot" class:drawer={narrow}>
                <Sidebar onUpload={uploadFiles} onClose={narrow ? () => (sidebarOpen = false) : null} />
              </div>
            {/if}

            <div class="editor-area" class:resizing>
              <div
                class="editor-panel"
                class:grow={!terminalVisible || keyboardFor === 'editor'}
                class:away={keyboardFor === 'terminal'}
                style:height={terminalVisible && !keyboardFor ? `${editorHeight}%` : null}
              >
                <Tabs filesOpen={sidebarOpen} onToggleFiles={() => (sidebarOpen = !sidebarOpen)} />
                <Editor onRun={runActiveFile} />
              </div>

              {#if terminalVisible && !keyboardFor}
                <div
                  class="resize-handle"
                  class:active={resizing}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize terminal"
                  onpointerdown={startResize}
                  onpointermove={onResize}
                  onpointerup={stopResize}
                  onpointercancel={stopResize}
                ></div>
              {/if}

              <div class="bottom-panel" class:collapsed={!terminalVisible} class:away={keyboardFor === 'editor'}>
                <Terminal bind:this={terminal} activeProjectId={project?.id} collapsed={!terminalVisible} onToggle={toggleTerminal} />
              </div>
            </div>
          {/if}

          {#if showPreview}
            <div
              class="preview-handle"
              class:active={resizingPreview}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize preview"
              onpointerdown={startPreviewResize}
              onpointermove={onPreviewResize}
              onpointerup={() => (resizingPreview = false)}
              onpointercancel={() => (resizingPreview = false)}
            ></div>
            <div class="preview-panel" class:resizing={resizingPreview} style="width: {previewWidth}%">
              <Preview {servers} />
            </div>
          {/if}
        </div>

        <StatusBar {session} {machine} saveError={projectStore.saveError} onInternet={() => (showInternet = true)} />
        {#if showKeyBar}
          <KeyBar />
        {/if}
      </div>
    {/if}
  {/if}

  <input
    bind:this={importInput}
    type="file"
    accept=".zip,application/zip,.opcode-linux"
    hidden
    onchange={(e) => {
      const file = e.currentTarget.files?.[0]
      if (file) importFile(file)
      e.currentTarget.value = ''
    }}
  />

  {#if showInternet}
    <InternetSettings onClose={() => (showInternet = false)} />
  {/if}

  {#if sharedMachine}
    <ConfirmDialog
      title="Open a shared machine from {sharedMachine.host}?"
      message="It's a saved Linux computer made by someone else; it starts running as soon as it opens. Open it only if you trust where the link came from."
      detail={sharedMachine.url}
      confirmLabel="Open"
      onConfirm={confirmSharedMachine}
      onCancel={() => (sharedMachine = null)}
    />
  {/if}

  {#if notice}
    <div class="notice" class:error={notice.kind === 'error'} role="status">{notice.text}</div>
  {/if}
</div>

<style>
  /* Sized and placed to what's visible: on iPhone and iPad the on-screen
     keyboard covers the page instead of shortening it (lib/stores/viewport). */
  .app {
    position: fixed;
    top: var(--app-top, 0px);
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: var(--app-height, 100dvh);
  }

  .loading {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    color: var(--muted);
  }

  .ide {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .ide[hidden] {
    display: none;
  }

  .banner {
    padding: 8px 16px;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 14px;
    font-weight: 600;
  }

  .main {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .sidebar-slot {
    display: flex;
    flex-shrink: 0;
  }

  /* Phones: the files slide over the editor. */
  .sidebar-slot.drawer {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 15;
    box-shadow: 6px 0 0 var(--overlay);
  }

  .drawer-backdrop {
    position: absolute;
    inset: 0;
    z-index: 14;
    background: var(--overlay);
  }

  .editor-area {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    background: var(--editor-bg);
  }

  .editor-area.resizing {
    cursor: ns-resize;
    user-select: none;
  }

  .editor-panel {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    min-height: 0;
  }

  .editor-panel.grow {
    flex: 1 1 auto;
  }

  .resize-handle {
    position: relative;
    z-index: 2;
    flex-shrink: 0;
    height: 8px;
    margin: -4px 0 -4px;
    cursor: ns-resize;
    touch-action: none;
  }

  .resize-handle::after {
    position: absolute;
    top: 3px;
    left: 50%;
    width: 48px;
    height: 4px;
    margin-left: -24px;
    border-radius: 2px;
    background: transparent;
    content: '';
  }

  .resize-handle:hover::after,
  .resize-handle.active::after {
    background: var(--focus);
  }

  .bottom-panel {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }

  .bottom-panel.collapsed {
    flex: 0 0 auto;
  }

  /* Phones typing with the on-screen keyboard: only the panel being typed
     in, and no status bar. Hidden, not removed, so nothing restarts. */
  .editor-panel.away,
  .bottom-panel.away,
  .ide.typing :global(.status-bar) {
    display: none;
  }

  /* Keep the last line clear of Safari's blur above its toolbar. */
  .ide.typing :global(.terminal-view) {
    padding-bottom: 12px;
  }

  .preview-handle {
    flex-shrink: 0;
    width: 6px;
    margin: 0 -3px;
    position: relative;
    z-index: 2;
    cursor: ew-resize;
    touch-action: none;
  }

  .preview-handle:hover,
  .preview-handle.active {
    background: var(--focus);
  }

  .preview-panel {
    flex-shrink: 0;
    min-width: 0;
    border-left: 2px solid var(--line);
  }

  /* Keep pointer events away from the frame while resizing. */
  .preview-panel.resizing {
    pointer-events: none;
    user-select: none;
  }

  /* Phones: the preview covers the editor. */
  @media (max-width: 760px) {
    .preview-handle {
      display: none;
    }

    .preview-panel {
      position: absolute;
      inset: 0;
      z-index: 5;
      width: auto !important;
      border-left: 0;
    }
  }

  .notice {
    position: fixed;
    right: 16px;
    bottom: 48px;
    z-index: 120;
    max-width: min(440px, calc(100vw - 32px));
    padding: 12px 16px;
    border: 2px solid var(--pop-border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 4px 0 var(--pop-shadow);
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
  }

  .notice.error {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
