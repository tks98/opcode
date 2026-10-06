<!--
  TopBar.svelte - the coding screen's one bar: home, the project, Run and
  Stop, and the app's settings.

  Run types the file's command into the terminal (e.g. `python3 main.py`),
  so what happens is visible and can be repeated by hand.
-->

<script>
  import { runPlanFor } from '../languages.js'
  import { themeStore } from '../stores/theme.svelte.js'
  import { clickOutside, menuKeys } from '../actions.js'
  import EditorColors from './EditorColors.svelte'
  import Icon from './Icon.svelte'
  import ProjectSwitcher from './ProjectSwitcher.svelte'
  import ThemeToggle from './ThemeToggle.svelte'
  import Wordmark from './Wordmark.svelte'

  let {
    project = null,
    session = null,
    servers = [],
    file = null,
    filesOpen = true,
    terminalVisible = true,
    onHome = () => {},
    onRun = () => {},
    onStop = () => {},
    onPreview = null,
    onImport = () => {},
    onExport = () => {},
    onInternet = () => {},
    onToggleFiles = () => {},
    onToggleTerminal = () => {},
    onNewTerminal = () => {},
  } = $props()

  let showColors = $state(false)
  let showMore = $state(false)
  let colorsButton = $state(null)
  let moreButton = $state(null)

  let isLinux = $derived(project?.kind === 'linux')
  let plan = $derived(file ? runPlanFor(file.path, project?.files ?? [], project?.language) : null)
  let busy = $derived(session?.busy ?? false)
  let runTitle = $derived(
    session?.status === 'error'
      ? 'The terminal could not start'
      : plan?.preview
        ? 'Show the page in the preview (Ctrl+Enter)'
        : plan
        ? `Run: ${plan.command}  (Ctrl+Enter)`
        : file
          ? 'This kind of file cannot be run'
          : 'Open a file to run it',
  )
  let previewPort = $derived(servers[0])

  function closeColors({ restoreFocus = false } = {}) {
    showColors = false
    if (restoreFocus) (colorsButton?.offsetParent ? colorsButton : moreButton)?.focus()
  }

  function closeMore({ restoreFocus = false } = {}) {
    showMore = false
    if (restoreFocus) moreButton?.focus()
  }

  function menuAction(action) {
    closeMore()
    action()
  }

  function onMoreKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeMore({ restoreFocus: true })
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key !== 'Escape') return
    if (showMore) closeMore({ restoreFocus: true })
    if (showColors) closeColors({ restoreFocus: true })
  }}
/>

<header class="topbar">
  <button class="home" onclick={onHome} aria-label="Opcode home" title="Home: your projects and new ones">
    <Wordmark size={20} />
  </button>

  <ProjectSwitcher onNew={onHome} />

  <div class="actions">
    {#if !isLinux}
      <button class="btn btn-primary run-btn" onclick={onRun} disabled={!plan || (busy && !plan.preview) || session?.status === 'error'} title={runTitle}>
        <Icon name="play" size={16} />
        <span>Run</span>
      </button>
      <button class="btn stop-btn" onclick={onStop} disabled={!busy} aria-label="Stop" title="Stop the running program (Ctrl+C in the terminal)">
        <Icon name="stop" size={16} />
        <span class="label">Stop</span>
      </button>
    {/if}
    {#if onPreview && previewPort}
      <button class="btn preview-btn" onclick={onPreview} aria-label="Preview" title="Show the web page served on port {previewPort}">
        <Icon name="globe" size={18} />
        <span class="label">Preview</span>
      </button>
    {/if}

    <div class="colors" use:clickOutside={() => showColors && closeColors()}>
      <button
        bind:this={colorsButton}
        class="btn btn-icon wide-only"
        onclick={() => (showColors = !showColors)}
        aria-label="Editor colors"
        aria-expanded={showColors}
        title="Editor colors"
      >
        <Icon name="palette" size={20} />
      </button>
      {#if showColors}
        <EditorColors onClose={closeColors} />
      {/if}
    </div>

    <span class="wide-only"><ThemeToggle /></span>

    <div class="more" use:clickOutside={() => showMore && closeMore()}>
      <button
        bind:this={moreButton}
        class="btn btn-icon"
        onclick={() => (showMore = !showMore)}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={showMore}
        title="More"
      >
        <Icon name="more" size={20} />
      </button>
      {#if showMore}
        <div class="popover more-menu" role="menu" aria-label="More" tabindex="-1" use:menuKeys onkeydown={onMoreKeydown}>
          {#if !isLinux}
            <button class="menu-item" role="menuitemcheckbox" aria-checked={filesOpen} onclick={() => menuAction(onToggleFiles)}>
              <Icon name="sidebar" size={18} />
              <span>Files</span>
              {#if filesOpen}<span class="shortcut"><Icon name="check" size={16} /></span>{/if}
            </button>
            <button class="menu-item" role="menuitemcheckbox" aria-checked={terminalVisible} onclick={() => menuAction(onToggleTerminal)}>
              <Icon name="terminal" size={18} />
              <span>Terminal</span>
              <span class="shortcut">{#if terminalVisible}<Icon name="check" size={16} />{:else}Ctrl+`{/if}</span>
            </button>
            <button class="menu-item" role="menuitem" onclick={() => menuAction(onNewTerminal)} disabled={session?.status === 'error'}>
              <Icon name="plus" size={18} />
              <span>New terminal</span>
              <span class="shortcut">Ctrl+Shift+`</span>
            </button>
            <hr class="menu-separator" />
            <button class="menu-item" role="menuitem" onclick={() => menuAction(onExport)}>
              <Icon name="download" size={18} />
              <span>Download as ZIP</span>
            </button>
          {/if}
          <button class="menu-item" role="menuitem" onclick={() => menuAction(onImport)} title="Open a project (.zip) or a Linux machine (.opcode-linux)">
            <Icon name="upload" size={18} />
            <span>Open a file…</span>
          </button>
          <button class="menu-item" role="menuitem" onclick={() => menuAction(onInternet)}>
            <Icon name="wifi" size={18} />
            <span>Internet access…</span>
          </button>
          <div class="narrow-only">
            <hr class="menu-separator" />
            <button class="menu-item" role="menuitem" onclick={() => menuAction(() => (showColors = true))}>
              <Icon name="palette" size={18} />
              <span>Editor colors…</span>
            </button>
            <button class="menu-item" role="menuitem" onclick={() => menuAction(() => themeStore.toggle())}>
              <Icon name={themeStore.mode === 'dark' ? 'sun' : 'moon'} size={18} />
              <span>{themeStore.mode === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</header>

<style>
  .topbar {
    position: relative;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 60px;
    padding: 8px 16px;
    border-bottom: 2px solid var(--line);
    background: var(--bar);
  }

  .home {
    flex-shrink: 0;
    padding: 6px;
    margin: -6px 0 -6px -6px;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
  }

  .home:hover {
    background: var(--hover);
  }

  .actions {
    position: relative;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }

  .run-btn {
    padding: 0 20px;
    font-size: 17px;
  }

  .colors,
  .more {
    display: contents;
  }

  .more-menu {
    top: calc(100% + 8px);
    right: 0;
    min-width: 260px;
  }

  .narrow-only {
    display: none;
  }

  @media (max-width: 760px) {
    .topbar {
      gap: 8px;
      padding: 8px 10px;
    }

    .wide-only {
      display: none;
    }

    .narrow-only {
      display: block;
    }

    .actions {
      gap: 6px;
    }

    .run-btn {
      padding: 0 14px;
    }

    .stop-btn,
    .preview-btn {
      width: 40px;
      padding: 0;
    }

    .stop-btn .label,
    .preview-btn .label {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .home :global(.text) {
      display: none;
    }
  }
</style>
