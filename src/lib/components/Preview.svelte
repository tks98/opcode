<!--
  Preview.svelte - shows a web server running in the project's sandbox, or
  R's plots (see stores/preview.svelte.js).
-->

<script>
  import { previewStore } from '../stores/preview.svelte.js'
  import Icon from './Icon.svelte'

  let { servers = [] } = $props()

  let path = $state('/')

  $effect(() => {
    path = previewStore.path
  })

  function go(event) {
    event.preventDefault()
    previewStore.navigate(path.trim() || '/')
  }

  function choosePort(event) {
    previewStore.show(previewStore.projectId, Number(event.currentTarget.value))
  }

  function openInTab() {
    if (previewStore.src) window.open(previewStore.src, '_blank', 'noopener')
  }

  let plots = $derived(previewStore.plots)
</script>

<div class="preview">
  {#if plots}
    <div class="bar">
      <span class="title">Plot</span>
      {#if plots.urls.length > 1}
        <button class="icon-button" onclick={() => previewStore.showPlot(plots.index - 1)} disabled={plots.index === 0} title="Previous plot" aria-label="Previous plot"><Icon name="chevronLeft" size={17} /></button>
        <span class="port">{plots.index + 1} of {plots.urls.length}</span>
        <button class="icon-button" onclick={() => previewStore.showPlot(plots.index + 1)} disabled={plots.index === plots.urls.length - 1} title="Next plot" aria-label="Next plot"><Icon name="chevronRight" size={17} /></button>
      {/if}
      <span class="spacer"></span>
      <a class="icon-button" href={plots.urls[plots.index]} download="plot-{plots.index + 1}.png" title="Download this plot (PNG)" aria-label="Download this plot"><Icon name="download" size={17} /></a>
      <button class="icon-button" onclick={() => previewStore.hide()} title="Close the preview" aria-label="Close preview"><Icon name="close" size={17} /></button>
    </div>
    <div class="frame plot">
      <img src={plots.urls[plots.index]} alt="Plot {plots.index + 1} of {plots.urls.length}" />
    </div>
  {:else}
  <div class="bar">
    <span class="title">Preview</span>
    {#if servers.length > 1}
      <select value={previewStore.port} onchange={choosePort} title="Server" aria-label="Server port">
        {#each servers as port (port)}
          <option value={port}>:{port}</option>
        {/each}
      </select>
    {:else if previewStore.port}
      <span class="port" title="The port the server listens on">:{previewStore.port}</span>
    {/if}
    <button class="icon-button" onclick={() => previewStore.reload()} disabled={previewStore.status !== 'ready'} title="Reload" aria-label="Reload preview"><Icon name="refresh" size={17} /></button>
    <form onsubmit={go}>
      <input bind:value={path} spellcheck="false" aria-label="Page path" title="Path on the server (press Enter to open)" />
    </form>
    <button class="icon-button" onclick={openInTab} disabled={previewStore.status !== 'ready'} title="Open in a new tab (works while Opcode stays open)" aria-label="Open preview in a new tab"><Icon name="external" size={17} /></button>
    <button class="icon-button" onclick={() => previewStore.hide()} title="Close the preview" aria-label="Close preview"><Icon name="close" size={17} /></button>
  </div>

  <div class="frame">
    {#if previewStore.status === 'ready' && previewStore.src}
      {#key previewStore.reloads}
        <iframe
          src={previewStore.src}
          title="Preview of the server on port {previewStore.port}"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
        ></iframe>
      {/key}
    {:else}
      <div class="message" class:error={previewStore.status === 'error'}>
        {#if previewStore.status === 'connecting'}
          <p>Connecting to the server on port {previewStore.port}…</p>
        {:else if previewStore.status === 'stopped'}
          <p>The server on port {previewStore.port} stopped.</p>
          <p class="hint">Start it again in the terminal and the preview comes back.</p>
        {:else if previewStore.status === 'error'}
          <p>Could not show the server on port {previewStore.port}.</p>
          <p class="hint">{previewStore.error}</p>
          <button class="btn" onclick={() => previewStore.retry()}>Retry</button>
        {:else}
          <p>No server is running.</p>
          <p class="hint">Start one in the terminal, for example <code>python3 -m http.server</code> or <code>php -S localhost:8000</code>.</p>
        {/if}
      </div>
    {/if}
  </div>
  {/if}
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--bar);
  }

  .bar {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 5px 8px 5px 14px;
    border-bottom: 2px solid var(--line);
    font-size: 14px;
  }

  .title {
    margin-right: 2px;
    font-weight: 700;
  }

  .port {
    color: var(--muted);
    font-family: var(--font-code);
    font-size: 13px;
  }

  select {
    padding: 4px 6px;
    border: 2px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    font-family: var(--font-code);
    font-size: 13px;
  }

  form {
    flex: 1;
    min-width: 0;
  }

  input {
    width: 100%;
    padding: 5px 9px;
    border: 2px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    font-family: var(--font-code);
    font-size: 13px;
  }

  input:focus {
    border-color: var(--focus);
    outline: none;
  }

  .icon-button {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
  }

  .icon-button:hover:not(:disabled) {
    background: var(--hover);
    color: var(--ink);
  }

  .icon-button:disabled {
    opacity: 0.4;
  }

  .frame {
    position: relative;
    flex: 1;
    min-height: 0;
    background: #fff;
  }

  .spacer {
    flex: 1;
  }

  .plot {
    display: grid;
    place-items: center;
    overflow: auto;
    padding: 12px;
  }

  .plot img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }

  .message {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 100%;
    padding: 16px;
    background: var(--bg);
    color: var(--ink);
    text-align: center;
  }

  .message p {
    margin: 0;
  }

  .message p:first-child {
    font-weight: 700;
  }

  .message .hint {
    max-width: 380px;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-line;
  }

  .message.error p:first-child {
    color: var(--danger);
  }

  code {
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--surface-2);
    font-size: 0.92em;
  }
</style>
