<!--
  ProjectSwitcher.svelte - the current project's name, and a menu to switch
  to another project, rename or delete one, or start a new one.
-->

<script>
  import { tick } from 'svelte'
  import { projectAppearance } from '../languages.js'
  import { projectStore } from '../stores/projects.svelte.js'
  import { clickOutside } from '../actions.js'
  import Icon from './Icon.svelte'

  let { onNew = () => {} } = $props()

  let open = $state(false)
  let renaming = $state(null) // project id
  let draft = $state('')
  let button = $state(null)

  let project = $derived(projectStore.activeProject)

  function toggle() {
    open = !open
    renaming = null
  }

  function close({ restoreFocus = false } = {}) {
    open = false
    renaming = null
    if (restoreFocus) button?.focus()
  }

  function choose(id) {
    projectStore.setActiveProject(id)
    close({ restoreFocus: true })
  }

  async function startRename(target) {
    renaming = target.id
    draft = target.name
    await tick()
  }

  function commitRename() {
    if (renaming && draft.trim()) projectStore.renameProject(renaming, draft)
    renaming = null
  }

  function remove(target) {
    const what = target.kind === 'linux' ? 'Its machine and everything in it will be erased.' : 'Its files will be gone for good.'
    if (!confirm(`Delete "${target.name}"? ${what}`)) return
    projectStore.deleteProject(target.id)
    if (!projectStore.projects.length) close()
  }

  function focusInput(node) {
    node.focus()
    node.select()
  }

  function onRenameKeydown(event) {
    event.stopPropagation()
    if (event.key === 'Enter') commitRename()
    if (event.key === 'Escape') renaming = null
  }

  function onMenuKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close({ restoreFocus: true })
    }
  }

  function focusFirst(node) {
    queueMicrotask(() => node.querySelector('.project-item[aria-current="true"] .project-open, .project-open')?.focus())
  }
</script>

<svelte:window onkeydown={(event) => open && event.key === 'Escape' && close({ restoreFocus: true })} />

<div class="switcher" use:clickOutside={() => open && close()}>
  <button
    bind:this={button}
    class="btn project-switcher"
    onclick={toggle}
    aria-expanded={open}
    aria-haspopup="dialog"
    title="Switch, rename or delete projects"
    style="--mark: {projectAppearance(project).color}"
  >
    <span class="mark" aria-hidden="true"></span>
    <span class="current">{project?.name}</span>
    <Icon name="chevronDown" size={16} />
  </button>

  {#if open}
    <div class="popover project-menu" role="dialog" aria-label="Projects" tabindex="-1" onkeydown={onMenuKeydown} use:focusFirst>
      <ul>
        {#each projectStore.projects as item (item.id)}
          <li class="project-item" aria-current={item.id === project?.id} style="--mark: {projectAppearance(item).color}">
            {#if renaming === item.id}
              <span class="mark" aria-hidden="true"></span>
              <input bind:value={draft} onkeydown={onRenameKeydown} onblur={commitRename} use:focusInput aria-label="Project name" />
            {:else}
              <button class="project-open" onclick={() => choose(item.id)}>
                <span class="mark" aria-hidden="true"></span>
                <span class="name">{item.name}</span>
                <span class="kind">{projectAppearance(item).name}</span>
              </button>
              <button class="btn btn-quiet btn-small btn-icon" onclick={() => startRename(item)} aria-label="Rename {item.name}" title="Rename">
                <Icon name="pencil" size={16} />
              </button>
              <button class="btn btn-quiet btn-small btn-icon" onclick={() => remove(item)} aria-label="Delete {item.name}" title="Delete">
                <Icon name="trash" size={16} />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      <hr class="menu-separator" />
      <button class="menu-item" onclick={() => { close(); onNew() }}>
        <Icon name="plus" size={18} />
        <span>New project</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .switcher {
    position: relative;
    min-width: 0;
  }

  .project-switcher {
    max-width: 100%;
    font-weight: 700;
  }

  .current {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .project-menu {
    top: calc(100% + 8px);
    left: 0;
    width: 340px;
    max-width: calc(100vw - 24px);
  }

  ul {
    max-height: min(60vh, 420px);
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  .project-item {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: 2px;
    border-radius: 9px;
  }

  .project-item[aria-current='true'] {
    background: var(--selected);
  }

  .project-item:not([aria-current='true']):hover {
    background: var(--hover);
  }

  .project-item > .mark {
    margin-left: 10px;
  }

  .project-open {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 38px;
    padding: 8px 10px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    text-align: left;
  }

  .project-open:focus-visible {
    outline-offset: -2px;
  }

  .name {
    overflow: hidden;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kind {
    margin-left: auto;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
  }

  input {
    flex: 1;
    min-width: 0;
    margin: 4px 4px 4px 8px;
    padding: 6px 8px;
    border: 2px solid var(--focus);
    border-radius: var(--radius-s);
    outline: none;
    background: var(--surface);
  }
</style>
