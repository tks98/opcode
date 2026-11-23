<!--
  ConfirmDialog.svelte - asks before doing something the user didn't start
  themselves (opening a shared machine from a link). Escape, the backdrop
  and Cancel all cancel.
-->

<script>
  let { title, message = '', detail = '', confirmLabel = 'OK', onConfirm = () => {}, onCancel = () => {} } = $props()

  // Focus Cancel, so pressing Enter by habit doesn't confirm.
  function focusDialog(node) {
    queueMicrotask(() => node.querySelector('.cancel')?.focus())
  }
</script>

<div class="dialog-backdrop" onclick={onCancel} onkeydown={(e) => e.key === 'Escape' && onCancel()} role="presentation">
  <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Escape') onCancel(); e.stopPropagation() }} use:focusDialog>
    <h2 id="confirm-title">{title}</h2>
    {#if message}
      <p id="confirm-message">{message}</p>
    {/if}
    {#if detail}
      <p class="detail">{detail}</p>
    {/if}
    <div class="actions">
      <button class="btn cancel" onclick={onCancel}>Cancel</button>
      <button class="btn btn-primary" onclick={onConfirm}>{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  p {
    margin: 0 0 12px;
    line-height: 1.5;
  }

  .detail {
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--surface-2);
    font-family: var(--font-code);
    font-variation-settings: var(--mono);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
</style>
