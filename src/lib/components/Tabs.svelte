<!--
  Tabs.svelte - open files
-->

<script>
  import { projectStore } from '../stores/projects.svelte.js'
  import { colorFor } from '../languages.js'
  import { basename } from '../paths.js'
  import Icon from './Icon.svelte'

  let { filesOpen = true, onToggleFiles = null } = $props()

  function close(event, id) {
    event.stopPropagation()
    projectStore.closeTab(id)
  }

  function onAuxClick(event, id) {
    if (event.button === 1) close(event, id)
  }
</script>

<div class="tab-row">
  {#if onToggleFiles}
    <button
      class="files-toggle"
      onclick={onToggleFiles}
      aria-pressed={filesOpen}
      aria-label={filesOpen ? 'Hide files' : 'Show files'}
      title={filesOpen ? 'Hide files' : 'Show files'}
    >
      <Icon name="sidebar" size={18} />
    </button>
  {/if}
  <div class="tabs" role="tablist" aria-label="Open files">
    {#each projectStore.openFiles as file (file.id)}
      <div class="tab" class:active={projectStore.activeFileId === file.id} title={file.path}>
        <button
          class="tab-label"
          role="tab"
          aria-selected={projectStore.activeFileId === file.id}
          onclick={() => projectStore.setActiveFile(file.id)}
          onauxclick={(e) => onAuxClick(e, file.id)}
        >
          <span class="mark" style="--mark: {colorFor(file.path) ?? 'var(--line)'}"></span>
          <span class="name">{basename(file.path)}</span>
        </button>
        <button class="close" onclick={(e) => close(e, file.id)} title="Close" aria-label="Close {file.path}"><Icon name="close" size={14} /></button>
      </div>
    {/each}
  </div>
</div>

<style>
  .tab-row {
    display: flex;
    flex-shrink: 0;
    align-items: flex-end;
    gap: 4px;
    min-height: 44px;
    padding: 6px 8px 0;
    border-bottom: 2px solid var(--line);
    background: var(--bar);
  }

  .files-toggle {
    display: flex;
    align-self: center;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    margin-bottom: 4px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
  }

  .files-toggle:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .tabs {
    display: flex;
    gap: 4px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab {
    position: relative;
    top: 2px;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    border: 2px solid transparent;
    border-bottom: 0;
    border-radius: 10px 10px 0 0;
  }

  .tab:hover {
    background: var(--hover);
  }

  .tab.active {
    border-color: var(--line);
    background: var(--editor-bg, var(--surface));
  }

  .tab-label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 4px 9px 12px;
    border: none;
    background: none;
    color: var(--muted);
    font-size: 14px;
  }

  .tab.active .tab-label {
    color: var(--ink);
    font-weight: 700;
  }

  .tab-label:focus-visible {
    outline-offset: -3px;
  }

  .tab .mark {
    width: 8px;
    height: 8px;
  }

  .close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-right: 6px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    opacity: 0;
  }

  .tab:hover .close,
  .tab.active .close,
  .close:focus-visible {
    opacity: 1;
  }

  .close:hover {
    background: var(--hover);
    color: var(--ink);
  }

  @media (pointer: coarse) {
    .close {
      opacity: 1;
    }
  }
</style>
