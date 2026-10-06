<!--
  LinuxWorkspace.svelte - a Linux project: the machine's terminal, its
  controls, and the lessons panel.
-->

<script>
  import TerminalView from './TerminalView.svelte'
  import LinuxLessons from './LinuxLessons.svelte'
  import { describeProgress } from '../linux/LinuxMachine.svelte.js'
  import { machineFileName } from '../linux/machineFile.js'
  import { networkSettings } from '../stores/network.svelte.js'
  import Icon from './Icon.svelte'

  let { machine, name = 'Linux machine', onNotice = () => {} } = $props()

  let downloading = $state(false)

  let terminal = $state(null)
  let showLessons = $state(typeof matchMedia === 'undefined' || !matchMedia('(max-width: 900px)').matches)
  let now = $state(Date.now())

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 15_000)
    return () => clearInterval(timer)
  })

  function ago(timestamp) {
    const minutes = Math.round((now - timestamp) / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    return hours < 24 ? `${hours} h ago` : new Date(timestamp).toLocaleDateString()
  }

  function type(command, run = true) {
    if (machine?.status !== 'running') return
    machine.input(`\x15${command}${run ? '\r' : ''}`)
    terminal?.focus()
  }

  // Keep a copy of the machine, or share it: Import opens the file as a new
  // project, and so does a link to it (?machine=https://…/file.opcode-linux).
  async function download() {
    downloading = true
    try {
      const blob = await machine.exportFile(name)
      const fileName = machineFileName(name)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = fileName
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
      onNotice(`Downloaded ${fileName}. Open it with Import, or share it.`)
    } catch (error) {
      onNotice(`Could not download the machine: ${error.message}`, 'error')
    } finally {
      downloading = false
    }
  }

  function reset() {
    if (confirm('Reset this Linux machine? Everything you created or installed in it will be erased.')) {
      machine.reset()
    }
  }
</script>

<div class="linux-workspace">
  <div class="toolbar">
    <span class="prompt" aria-hidden="true">$_</span>
    <span class="status" class:error={machine?.status === 'error'}>
      {#if !machine || machine.status === 'idle' || machine.status === 'loading'}
        {machine?.progress ? describeProgress(machine.progress) : 'Starting…'}
      {:else if machine.status === 'running'}
        <span class="dot"></span>Running {machine.info.system}
      {:else if machine.status === 'stopped'}
        Powered off
      {:else}
        Could not start: {machine.error}
      {/if}
    </span>
    <span class="saved">
      {#if machine?.saving}
        Saving…
      {:else if machine?.savedAt}
        Saved {ago(machine.savedAt)}
      {/if}
    </span>
    <div class="actions">
      <button class="btn btn-small" onclick={() => machine?.save()} disabled={machine?.status !== 'running'} title="Save this machine in your browser (also happens automatically)">
        <Icon name="save" size={16} /><span class="label">Save</span>
      </button>
      <button class="btn btn-small" onclick={download} disabled={machine?.status !== 'running' || downloading} title="Download this machine as a file, to keep a copy or share it (Open a file opens it)">
        <Icon name="download" size={16} /><span class="label">{downloading ? 'Preparing…' : 'Download'}</span>
      </button>
      <button class="btn btn-small" onclick={reset} disabled={!machine || machine.status === 'loading'} title="Erase this machine and start a fresh one">
        <Icon name="restart" size={16} /><span class="label">Reset machine</span>
      </button>
      <button class="btn btn-small" onclick={() => (showLessons = !showLessons)} aria-pressed={showLessons} title="Show or hide the lessons">
        <Icon name="book" size={16} /><span class="label">Lessons</span>
      </button>
    </div>
  </div>

  {#if machine?.offlineHardware && networkSettings.enabled && machine.status === 'running'}
    <div class="banner">This machine was made before Opcode Linux could go online. <em>Download</em> it to keep a copy, then <em>Reset machine</em> for internet access.</div>
  {/if}

  <div class="body">
    <div class="terminal-area">
      {#if machine}
        {#key machine}
          <TerminalView bind:this={terminal} session={machine} />
        {/key}
      {/if}
      {#if machine?.progress}
        <div class="loading">
          <div class="bar"><div class="fill" style="width: {machine.progress.percent ?? 30}%" class:indeterminate={machine.progress.percent == null}></div></div>
          <p>{describeProgress(machine.progress)}</p>
          <p class="note">The first visit downloads the {machine.info.name === 'Linux' ? 'Linux system' : `${machine.info.name} machine`} (about {machine.info.downloadMB} MB). After that it starts from your browser's storage.</p>
        </div>
      {/if}
    </div>
    {#if showLessons}
      <LinuxLessons kind={machine?.kind} onType={type} online={networkSettings.enabled && !machine?.offlineHardware} onClose={() => (showLessons = false)} />
    {/if}
  </div>
</div>

<style>
  .linux-workspace {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 6px 10px 6px 14px;
    border-bottom: 2px solid var(--line);
    background: var(--bar);
    font-size: 14px;
  }

  .prompt {
    flex-shrink: 0;
    padding: 3px 7px;
    border-radius: 6px;
    background: var(--ink);
    color: var(--bar);
    font-family: var(--font-code);
    font-size: 14px;
    font-weight: 700;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    overflow: hidden;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status.error {
    color: var(--danger);
  }

  .dot {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--ok);
  }

  .saved {
    color: var(--muted);
    white-space: nowrap;
  }

  .actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }

  .actions .btn[aria-pressed='true'] {
    border-color: transparent;
    background: var(--selected);
  }

  .banner {
    padding: 8px 14px;
    background: var(--selected);
    font-size: 14px;
  }

  .body {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .terminal-area {
    position: relative;
    flex: 1;
    min-width: 0;
    background: var(--term-bg, var(--surface));
  }

  .loading {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    background: var(--bg);
    color: var(--ink);
    text-align: center;
  }

  .loading p {
    margin: 0;
    font-weight: 650;
  }

  .loading .note {
    max-width: 400px;
    color: var(--muted);
    font-size: 14px;
    font-weight: 400;
  }

  .bar {
    position: relative;
    width: 280px;
    max-width: 80%;
    height: 8px;
    overflow: hidden;
    border-radius: 4px;
    background: var(--line);
  }

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 4px;
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

  @media (max-width: 900px) {
    .saved {
      display: none;
    }
  }

  @media (max-width: 760px) {
    /* Icons only, but the buttons keep their names for screen readers. */
    .actions .label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    .actions .btn {
      width: 36px;
      padding: 0;
    }
  }
</style>
