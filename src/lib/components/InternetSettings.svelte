<!--
  InternetSettings.svelte - the relay that gives terminals and Linux
  machines internet access (see stores/network.svelte.js).
-->

<script>
  import { DEFAULT_RELAY, networkSettings, normalizeRelay, testRelay } from '../stores/network.svelte.js'

  let { onClose = () => {} } = $props()

  let relay = $state(networkSettings.relay)
  let message = $state(null) // { text, kind }
  let testing = $state(false)
  let changed = $state(false)

  async function test() {
    testing = true
    message = null
    try {
      const ms = await testRelay(relay)
      message = { text: `The relay answered in ${ms} ms.`, kind: 'ok' }
    } catch (error) {
      message = { text: error.message, kind: 'error' }
    } finally {
      testing = false
    }
  }

  function save(value = relay) {
    try {
      normalizeRelay(value)
    } catch (error) {
      message = { text: error.message, kind: 'error' }
      return
    }
    networkSettings.setRelay(value)
    relay = networkSettings.relay
    changed = true
    message = null
  }

  // Focus the address field when the dialog opens.
  function focusDialog(node) {
    queueMicrotask(() => node.querySelector('input')?.focus())
  }

  function useDefault() {
    networkSettings.useDefault()
    relay = networkSettings.relay
    changed = true
  }
</script>

<div class="dialog-backdrop" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()} role="presentation">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="internet-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation() }} use:focusDialog>
    <h2 id="internet-title">Internet access</h2>
    <p>
      Browsers can't open network connections themselves, so terminals and Linux machines reach the internet through a <em>relay</em>
      server. With one, <code>pip install</code>, <code>git clone</code>, <code>curl</code> and <code>apk add</code> work.
    </p>
    <p class="status" class:on={networkSettings.enabled}>
      {#if networkSettings.enabled}
        <span class="dot"></span><span>On, through <code>{networkSettings.relay}</code></span>
      {:else}
        <span class="dot"></span><span>Off: no relay is set up. Everything else works without one.</span>
      {/if}
    </p>

    <label for="relay-url">Relay address</label>
    <input id="relay-url" bind:value={relay} placeholder="wss://relay.example.com/" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && save()} />
    <p class="hint">Anyone running Opcode can host one with <code>npm run relay</code> (see the README).</p>

    {#if message}
      <p class="message" class:error={message.kind === 'error'} role="status">{message.text}</p>
    {/if}
    {#if changed}
      <p class="message" role="status">Saved. Terminals and Linux machines started from now on use it; reload the page to apply it to the open ones.</p>
    {/if}

    <div class="actions">
      {#if DEFAULT_RELAY && networkSettings.relay !== DEFAULT_RELAY}
        <button class="btn" onclick={useDefault}>Use this site's relay</button>
      {/if}
      {#if networkSettings.enabled}
        <button class="btn" onclick={() => save('')}>Turn off</button>
      {/if}
      <button class="btn" onclick={test} disabled={testing || !relay.trim()}>{testing ? 'Testing…' : 'Test'}</button>
      {#if changed}
        <button class="btn btn-primary" onclick={() => location.reload()}>Reload now</button>
      {:else}
        <button class="btn btn-primary" onclick={() => save()} disabled={!relay.trim() || relay === networkSettings.relay}>Save</button>
      {/if}
      <button class="btn" onclick={onClose}>Close</button>
    </div>
  </div>
</div>

<style>
  p {
    margin: 0 0 12px;
    line-height: 1.5;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--surface-2);
    overflow-wrap: anywhere;
  }

  .dot {
    flex-shrink: 0;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--muted);
  }

  .status.on .dot {
    background: var(--ok);
  }

  label {
    display: block;
    margin-bottom: 6px;
    font-weight: 700;
  }

  input {
    width: 100%;
    padding: 10px 12px;
    border: 2px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    font-family: var(--font-code);
    font-size: 14px;
    font-variation-settings: var(--mono);
  }

  input:focus {
    border-color: var(--focus);
    outline: none;
  }

  .hint {
    margin-top: 8px;
    color: var(--muted);
    font-size: 14px;
  }

  .message {
    color: var(--ok);
    font-weight: 600;
  }

  .message.error {
    color: var(--danger);
  }

  code {
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--surface-2);
    font-size: 0.9em;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
</style>
