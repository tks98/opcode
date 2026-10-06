<!--
  Terminal.svelte - bottom panel terminal

  Each project can have several terminal tabs (shells). One view is kept
  per shell of every live session, so switching tabs or projects preserves
  scrollback and running programs.
-->

<script>
  import { sessionStore } from '../stores/sessions.svelte.js'
  import { previewStore, parseLocalUrl } from '../stores/preview.svelte.js'
  import TerminalView from './TerminalView.svelte'
  import Icon from './Icon.svelte'

  let { activeProjectId, collapsed = false, onToggle = () => {} } = $props()

  let active = $derived(sessionStore.get(activeProjectId))
  let activeShell = $derived(active?.activeShell ?? null)

  export function focus() {
    activeShell?.focus()
  }

  /** Open another terminal tab in the active project. */
  export function newTerminal() {
    if (!active || active.status === 'error') return
    active.newShell()
  }

  function selectShell(shell) {
    active?.setActiveShell(shell.id)
    queueMicrotask(focus)
  }

  function closeShell(event, shell) {
    event.stopPropagation()
    active?.closeShell(shell.id)
    queueMicrotask(focus)
  }

  // http://localhost:8000/ printed by a server: open it in the preview (the
  // browser can't reach the sandbox's localhost).
  function openLink(session, uri) {
    const target = parseLocalUrl(uri)
    if (!target) return false
    previewStore.show(session.projectId, target.port, target.path)
    return true
  }

  function clear() {
    activeShell?.clear()
    focus()
  }
</script>

<div class="terminal-panel" class:collapsed>
  <div class="panel-header">
    {#if active}
      <div class="shell-tabs" role="tablist" aria-label="Terminals">
        {#each active.shells as shell, index (shell.id)}
          <div
            class="shell-tab"
            class:active={shell.id === activeShell?.id}
            role="tab"
            tabindex="0"
            aria-selected={shell.id === activeShell?.id}
            title={shell.cwd.replace(/^\/workspace/, '~')}
            onclick={() => selectShell(shell)}
            onkeydown={(event) => (event.key === 'Enter' || event.key === ' ') && selectShell(shell)}
          >
            <span class="state" class:busy={shell.busy} class:exited={shell.exited} aria-hidden="true"></span>
            Terminal {index + 1}
            {#if active.shells.length > 1}
              <button class="close" onclick={(event) => closeShell(event, shell)} title="Close this terminal" aria-label="Close terminal {index + 1}"><Icon name="close" size={13} /></button>
            {/if}
          </div>
        {/each}
        <button class="icon-button" onclick={newTerminal} disabled={active.status === 'error'} title="New terminal (Ctrl+Shift+`)" aria-label="New terminal"><Icon name="plus" size={17} /></button>
      </div>
      {#if activeShell}
        <span class="cwd" title="Current folder">{activeShell.cwd.replace(/^\/workspace/, '~')}</span>
      {/if}
    {:else}
      <span class="title">Terminal</span>
    {/if}
    <div class="actions">
      {#if activeShell?.busy}
        <button class="text-button" onclick={() => active.stop()} title="Stop the running command (Ctrl+C)"><Icon name="stop" size={14} /><span>Stop</span></button>
      {/if}
      <button class="icon-button" onclick={clear} title="Clear the terminal" aria-label="Clear the terminal"><Icon name="eraser" size={17} /></button>
      <button class="icon-button" onclick={() => active?.restartShell()} disabled={!active || active.status === 'starting' || active.status === 'idle'} title={active?.status === 'error' ? 'Try starting the terminal again' : 'Start a fresh shell in this tab'} aria-label={active?.status === 'error' ? 'Retry' : 'Restart'}>
        <Icon name="restart" size={17} />
      </button>
      <button class="icon-button" onclick={onToggle} aria-expanded={!collapsed} title={collapsed ? 'Show the terminal (Ctrl+`)' : 'Hide the terminal'} aria-label={collapsed ? 'Show the terminal' : 'Hide the terminal'}>
        <Icon name={collapsed ? 'chevronUp' : 'chevronDown'} size={18} />
      </button>
    </div>
  </div>
  <div class="views" hidden={collapsed}>
    {#each sessionStore.sessions as session (session.projectId)}
      {#each session.shells as shell (shell.id)}
        {@const visible = session.projectId === activeProjectId && shell.id === session.activeShell?.id}
        <div class="view" class:visible>
          <TerminalView session={shell} {visible} onLink={(uri) => openLink(session, uri)} />
        </div>
      {/each}
    {/each}
  </div>
</div>

<style>
  .terminal-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    border-top: 2px solid var(--line);
    background: var(--term-bg, var(--surface));
  }

  .panel-header {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 12px;
    min-width: 0;
    min-height: 44px;
    padding: 5px 8px 5px 10px;
    border-bottom: 1px solid var(--line);
    background: var(--bar);
    font-size: 14px;
  }

  .collapsed .panel-header {
    border-bottom: 0;
  }

  .title {
    padding-left: 4px;
    font-weight: 700;
  }

  .shell-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .shell-tab {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 6px 0 10px;
    border-radius: 8px;
    color: var(--muted);
    cursor: pointer;
    font-weight: 650;
    white-space: nowrap;
  }

  .shell-tab:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .shell-tab.active {
    background: var(--selected);
    color: var(--ink);
  }

  .shell-tab:focus-visible {
    outline-offset: -2px;
  }

  .shell-tab:not(:has(.close)) {
    padding-right: 10px;
  }

  .state {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--line);
  }

  .state.busy {
    background: var(--focus);
  }

  .state.exited {
    background: var(--danger);
  }

  .close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    visibility: hidden;
  }

  .close:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .shell-tab:hover .close,
  .shell-tab.active .close,
  .close:focus-visible {
    visibility: visible;
  }

  .cwd {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-family: var(--font-code);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actions {
    display: flex;
    flex-shrink: 0;
    gap: 2px;
    margin-left: auto;
  }

  .icon-button,
  .text-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
  }

  .icon-button {
    width: 32px;
    flex-shrink: 0;
  }

  .text-button {
    padding: 0 10px;
    color: var(--danger);
    font-weight: 700;
  }

  .icon-button:hover:not(:disabled),
  .text-button:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .icon-button:disabled {
    opacity: 0.4;
  }

  .views {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .views[hidden] {
    display: none;
  }

  .view {
    position: absolute;
    inset: 0;
    visibility: hidden;
  }

  .view.visible {
    visibility: visible;
  }

  @media (max-width: 700px) {
    .cwd {
      display: none;
    }
  }
</style>
