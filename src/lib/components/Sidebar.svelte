<!--
  Sidebar.svelte - project file explorer

  A folder tree of the project. Files created in the terminal appear here
  automatically; compiled programs and other binary files are listed in
  grey (they can be run from the terminal but not edited).
-->

<script>
  import { SvelteSet } from 'svelte/reactivity'
  import { projectStore, uniquePath } from '../stores/projects.svelte.js'
  import { sessionStore } from '../stores/sessions.svelte.js'
  import { buildTree } from '../fileTree.js'
  import { colorFor, LANGUAGES } from '../languages.js'
  import { ancestors, joinPath, basename, dirname } from '../paths.js'
  import { formatBytes } from '../runtime/toolchains.js'
  import Icon from './Icon.svelte'

  let { onUpload = () => {}, onClose = null } = $props()

  const collapsed = new SvelteSet()

  // Inline editor: { mode: 'file' | 'folder' | 'rename', parent, path?, value }
  let draft = $state(null)
  let draftError = $state(null)
  let dropActive = $state(false)
  let fileInput = $state(null)

  let project = $derived(projectStore.activeProject)
  let session = $derived(project ? sessionStore.get(project.id) : null)
  let tree = $derived(project ? buildTree(project.files, project.folders, session?.binaries ?? []) : [])

  function defaultName() {
    const language = LANGUAGES[project?.language]
    const ext = language?.starter.path.slice(language.starter.path.lastIndexOf('.')) ?? '.txt'
    return `untitled${ext}`
  }

  function startCreate(mode, parent = '') {
    if (parent) collapsed.delete(parent)
    const suggestion = mode === 'file' ? defaultName() : 'folder'
    draft = { mode, parent, value: basename(uniquePath(project, joinPath(parent, suggestion))) }
    draftError = null
  }

  function startRename(node) {
    draft = { mode: 'rename', parent: dirname(node.path), path: node.path, value: node.name }
    draftError = null
  }

  function commit() {
    if (!draft) return
    const value = draft.value.trim()
    if (!value) return cancel()
    try {
      const target = joinPath(draft.parent, value)
      if (draft.mode === 'file') projectStore.createFile(target)
      else if (draft.mode === 'folder') projectStore.createFolder(target)
      else projectStore.renamePath(draft.path, target)
      draft = null
      draftError = null
    } catch (error) {
      draftError = error.message
    }
  }

  function cancel() {
    draft = null
    draftError = null
  }

  function onDraftKeydown(event) {
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') cancel()
  }

  function remove(node) {
    const what = node.kind === 'folder' ? `the folder "${node.path}" and everything in it` : `"${node.path}"`
    if (!confirm(`Delete ${what}?`)) return
    if (node.kind === 'binary') session?.removeBinary(node.path)
    else projectStore.deletePath(node.path)
  }

  function toggle(path) {
    if (collapsed.has(path)) collapsed.delete(path)
    else collapsed.add(path)
  }

  function collapseAll() {
    for (const folder of project?.folders ?? []) collapsed.add(folder)
    for (const file of project?.files ?? []) for (const dir of ancestors(file.path)) collapsed.add(dir)
  }

  function focusInput(node) {
    node.focus()
    const dot = node.value.lastIndexOf('.')
    node.setSelectionRange(0, dot > 0 ? dot : node.value.length)
  }

  function onDrop(event) {
    event.preventDefault()
    dropActive = false
    if (event.dataTransfer?.files?.length) onUpload(event.dataTransfer.files)
  }
</script>

{#snippet draftRow(depth)}
  <div class="row draft" style="--depth: {depth}">
    <span class="chevron"></span>
    {#if draft.mode === 'folder'}
      <span class="folder-icon"><Icon name="folder" size={16} /></span>
    {:else}
      <span class="mark" style="--mark: {colorFor(draft.value) ?? 'var(--line)'}"></span>
    {/if}
    <input
      type="text"
      bind:value={draft.value}
      onkeydown={onDraftKeydown}
      onblur={commit}
      use:focusInput
      aria-label={draft.mode === 'rename' ? 'New name' : `New ${draft.mode} name`}
    />
  </div>
  {#if draftError}
    <div class="draft-error" style="--depth: {depth}">{draftError}</div>
  {/if}
{/snippet}

{#snippet nodeRow(node, depth)}
  {#if draft?.mode === 'rename' && draft.path === node.path}
    {@render draftRow(depth)}
  {:else if node.kind === 'folder'}
    <div class="row folder" style="--depth: {depth}">
      <button class="label" onclick={() => toggle(node.path)} aria-expanded={!collapsed.has(node.path)}>
        <span class="chevron"><Icon name={collapsed.has(node.path) ? 'chevronRight' : 'chevronDown'} size={14} /></span>
        <span class="folder-icon"><Icon name="folder" size={16} /></span>
        <span class="name">{node.name}</span>
      </button>
      <div class="actions">
        <button onclick={() => startCreate('file', node.path)} title="New file in {node.name}" aria-label="New file in {node.name}"><Icon name="plus" size={15} /></button>
        <button onclick={() => startRename(node)} title="Rename" aria-label="Rename {node.name}"><Icon name="pencil" size={15} /></button>
        <button onclick={() => remove(node)} title="Delete" aria-label="Delete {node.name}"><Icon name="trash" size={15} /></button>
      </div>
    </div>
  {:else if node.kind === 'binary'}
    <div class="row binary" style="--depth: {depth}" title="Binary file ({formatBytes(node.size)}). Programs like this run from the terminal, e.g. ./{node.path}">
      <span class="label static">
        <span class="chevron"></span>
        <span class="folder-icon"><Icon name="gear" size={15} /></span>
        <span class="name">{node.name}</span>
      </span>
      <div class="actions">
        <button onclick={() => remove(node)} title="Delete" aria-label="Delete {node.name}"><Icon name="trash" size={15} /></button>
      </div>
    </div>
  {:else}
    <div class="row file" class:active={project.activeFileId === node.file.id} style="--depth: {depth}">
      <button class="label" onclick={() => { projectStore.openFile(node.file.id); onClose?.() }} aria-current={project.activeFileId === node.file.id ? 'true' : undefined}>
        <span class="chevron"></span>
        <span class="mark" style="--mark: {colorFor(node.path) ?? 'var(--line)'}"></span>
        <span class="name">{node.name}</span>
      </button>
      <div class="actions">
        <button onclick={() => startRename(node)} title="Rename" aria-label="Rename {node.name}"><Icon name="pencil" size={15} /></button>
        <button onclick={() => remove(node)} title="Delete" aria-label="Delete {node.name}"><Icon name="trash" size={15} /></button>
      </div>
    </div>
  {/if}

  {#if node.kind === 'folder' && !collapsed.has(node.path)}
    {#if draft && draft.mode !== 'rename' && draft.parent === node.path}
      {@render draftRow(depth + 1)}
    {/if}
    {#each node.children as child (child.kind + child.path)}
      {@render nodeRow(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

<aside
  class="sidebar"
  class:drop-active={dropActive}
  ondragover={(e) => { e.preventDefault(); dropActive = true }}
  ondragleave={() => (dropActive = false)}
  ondrop={onDrop}
  aria-label="Project files"
>
  <div class="header">
    <h2 class="title">Files</h2>
    <div class="header-actions">
      <button onclick={() => startCreate('file')} title="New file" aria-label="New file"><Icon name="filePlus" size={17} /></button>
      <button onclick={() => startCreate('folder')} title="New folder" aria-label="New folder"><Icon name="folderPlus" size={17} /></button>
      <button onclick={() => fileInput.click()} title="Upload files from your computer" aria-label="Upload files"><Icon name="upload" size={17} /></button>
      <button onclick={collapseAll} title="Collapse folders" aria-label="Collapse folders"><Icon name="collapse" size={17} /></button>
      {#if onClose}
        <button class="close-panel" onclick={onClose} title="Hide files" aria-label="Hide files"><Icon name="close" size={17} /></button>
      {/if}
    </div>
  </div>

  <div class="tree" role="tree">
    {#if draft && draft.mode !== 'rename' && draft.parent === ''}
      {@render draftRow(0)}
    {/if}
    {#each tree as node (node.kind + node.path)}
      {@render nodeRow(node, 0)}
    {/each}
    {#if tree.length === 0 && !draft}
      <p class="empty">No files yet. Make one with the new file button, or drop files here.</p>
    {/if}
  </div>

  <input
    bind:this={fileInput}
    class="hidden-input"
    type="file"
    multiple
    onchange={(e) => {
      if (e.currentTarget.files?.length) onUpload(e.currentTarget.files)
      e.currentTarget.value = ''
    }}
  />
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 220px;
    min-width: 180px;
    height: 100%;
    border-right: 2px solid var(--line);
    background: var(--bar);
  }

  .sidebar.drop-active {
    outline: 3px dashed var(--focus);
    outline-offset: -6px;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 12px 8px 6px 16px;
  }

  .title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
  }

  .header-actions {
    display: flex;
    flex-shrink: 0;
  }

  .header-actions button,
  .actions button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
  }

  .actions button {
    width: 26px;
    height: 26px;
  }

  .header-actions button:hover,
  .actions button:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .tree {
    flex: 1;
    overflow-y: auto;
    padding: 2px 8px 12px;
  }

  .row {
    display: flex;
    align-items: center;
    margin-bottom: 1px;
    padding-left: calc(var(--depth) * 14px);
    padding-right: 2px;
    border-radius: 9px;
  }

  .row:hover {
    background: var(--hover);
  }

  .row.active,
  .row.active:hover {
    background: var(--selected);
  }

  .label {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 7px;
    min-width: 0;
    min-height: 34px;
    padding: 4px 6px 4px 2px;
    border: none;
    border-radius: 9px;
    background: none;
    color: var(--ink);
    font-size: 14px;
    text-align: left;
  }

  .label:focus-visible {
    outline-offset: -2px;
  }

  .row.active .label {
    font-weight: 700;
  }

  .label.static {
    cursor: default;
  }

  .row.binary .label {
    color: var(--muted);
  }

  .chevron {
    display: flex;
    justify-content: center;
    width: 14px;
    flex-shrink: 0;
    color: var(--muted);
  }

  .folder-icon {
    display: flex;
    flex-shrink: 0;
    color: var(--muted);
  }

  .row .mark {
    width: 9px;
    height: 9px;
    margin: 0 3px 0 4px;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    display: none;
    flex-shrink: 0;
  }

  .row:hover .actions,
  .row:focus-within .actions {
    display: flex;
  }

  @media (pointer: coarse) {
    .row.active .actions {
      display: flex;
    }
  }

  .row.draft input {
    flex: 1;
    min-width: 0;
    margin: 3px 4px 3px 4px;
    padding: 4px 6px;
    border: 2px solid var(--focus);
    border-radius: 7px;
    outline: none;
    background: var(--surface);
    font-size: 14px;
  }

  .draft-error {
    margin: 2px 4px 6px calc(24px + var(--depth) * 14px);
    padding: 6px 8px;
    border-radius: 7px;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 13px;
  }

  .empty {
    padding: 8px;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.45;
  }

  .hidden-input {
    display: none;
  }
</style>
