<!--
  StatusBar.svelte - runtime status, downloads, internet and save state
-->

<script>
  import { formatBytes } from '../runtime/toolchains.js'
  import { TOOLCHAINS } from '../languages.js'
  import { networkSettings } from '../stores/network.svelte.js'

  let { session = null, machine = null, saveError = null, onInternet = () => {} } = $props()

  let progress = $derived(session?.progress)
  let installing = $derived(
    session ? Object.entries(session.toolchains).filter(([, state]) => state === 'installing').map(([id]) => TOOLCHAINS[id]?.name) : [],
  )
  let ready = $derived(
    session ? Object.entries(session.toolchains).filter(([, state]) => state === 'ready').map(([id]) => TOOLCHAINS[id]?.name) : [],
  )

  function describe(p) {
    if (p.phase === 'loading') return `Preparing ${p.label}…`
    const amount = p.totalBytes ? `${Math.floor(p.percent ?? 0)}% (${formatBytes(p.downloadedBytes)} of ${formatBytes(p.totalBytes)})` : formatBytes(p.downloadedBytes)
    return `Downloading ${p.label}: ${amount}`
  }
</script>

<footer class="status-bar">
  <div class="left">
    {#if machine}
      {#if machine.status === 'running'}
        <span class="item"><span class="dot ok"></span>{machine.info.name} is running</span>
      {:else if machine.status === 'error'}
        <span class="item error" title={machine.error}><span class="dot error"></span>{machine.info.name} could not start</span>
      {:else if machine.status === 'stopped'}
        <span class="item"><span class="dot"></span>{machine.info.name} is powered off</span>
      {:else}
        <span class="item"><span class="dot pending"></span>Starting {machine.info.name}…</span>
      {/if}
    {:else if !session || session.status === 'idle' || session.status === 'starting'}
      <span class="item"><span class="dot pending"></span>Starting the terminal…</span>
    {:else if session.status === 'error'}
      <span class="item error" title={session.error}><span class="dot error"></span>The terminal could not start: {session.error}</span>
    {:else}
      <span class="item"><span class="dot ok"></span>Ready</span>
    {/if}

    {#if progress}
      <span class="item progress">
        <span class="bar"><span class="fill" style="width: {progress.percent ?? 30}%" class:indeterminate={progress.percent == null}></span></span>
        {describe(progress)}
      </span>
    {:else if installing.length}
      <span class="item">Setting up {installing.join(', ')}…</span>
    {:else if ready.length}
      <span class="item muted wide" title="Ready to use in this project's terminals">{ready.join(', ')}</span>
    {/if}
  </div>

  <div class="right">
    <button class="item internet" onclick={onInternet} title="Internet access for terminals and Linux machines">
      <span class="dot" class:ok={networkSettings.enabled}></span>Internet: {networkSettings.enabled ? 'on' : 'off'}
    </button>
    {#if saveError}
      <span class="item error" title={saveError}>Not saved: {saveError}</span>
    {:else}
      <span class="item" title="Projects are saved in this browser as you type">Saved</span>
    {/if}
    {#if session}
      <span class="item muted wide">Ctrl+Enter runs the file</span>
    {/if}
  </div>
</footer>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 32px;
    padding: 4px 16px;
    border-top: 2px solid var(--line);
    background: var(--bar);
    color: var(--muted);
    font-size: 13px;
  }

  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 16px;
    min-width: 0;
  }

  .right {
    flex-shrink: 0;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muted {
    opacity: 0.85;
  }

  .error {
    color: var(--danger);
  }

  .dot {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--line);
  }

  .dot.ok {
    background: var(--ok);
  }

  .dot.pending {
    background: var(--highlight);
    box-shadow: 0 0 0 1px var(--warn);
  }

  .dot.error {
    background: var(--danger);
  }

  .internet {
    margin: -2px -6px;
    padding: 2px 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
  }

  .internet:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .bar {
    position: relative;
    width: 90px;
    height: 6px;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: 3px;
    background: var(--line);
  }

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 3px;
    background: var(--focus);
    transition: width 0.2s;
  }

  .fill.indeterminate {
    animation: slide 1.2s ease-in-out infinite;
  }

  @keyframes slide {
    from {
      left: -30%;
    }
    to {
      left: 100%;
    }
  }

  @media (max-width: 760px) {
    .status-bar {
      gap: 10px;
      padding: 4px 10px;
    }

    .left,
    .right {
      gap: 10px;
    }

    .wide {
      display: none;
    }
  }
</style>
