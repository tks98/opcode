<!--
  EditorColors.svelte - pick the colour theme for the editor and terminals.
-->

<script>
  import { AUTO_THEME, EDITOR_THEMES, resolveEditorTheme } from '../editorThemes.js'
  import { themeStore } from '../stores/theme.svelte.js'
  import { menuKeys } from '../actions.js'
  import Icon from './Icon.svelte'

  let { onClose = () => {} } = $props()

  let choices = $derived([
    { id: AUTO_THEME, name: 'Match the app', note: 'Notebook by day, Blueprint by night', preview: resolveEditorTheme(AUTO_THEME, themeStore.mode) },
    ...Object.entries(EDITOR_THEMES).map(([id, theme]) => ({ id, name: theme.name, note: theme.note, preview: id })),
  ])

  function pick(id) {
    themeStore.setEditorTheme(id)
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose({ restoreFocus: true })
    }
  }
</script>

<div class="popover editor-colors" role="dialog" aria-label="Editor colors" tabindex="-1" onkeydown={onKeydown}>
  <div class="head">
    <h2>Editor colors</h2>
    <button class="btn btn-quiet btn-small btn-icon" onclick={() => onClose({ restoreFocus: true })} aria-label="Close"><Icon name="close" size={16} /></button>
  </div>
  <div role="menu" aria-label="Color themes" use:menuKeys>
    {#each choices as choice (choice.id)}
      {@const s = EDITOR_THEMES[choice.preview].syntax}
      <button class="theme" role="menuitemradio" aria-checked={themeStore.editorChoice === choice.id} onclick={() => pick(choice.id)}>
        <span class="swatch" style="background: {s.bg}" aria-hidden="true">
          <span style="width: 70%; background: {s.kw}"></span>
          <span style="width: 90%; background: {s.str}"></span>
          <span style="width: 50%; background: {s.fn}"></span>
        </span>
        <span class="label">
          <span class="name">{choice.name}</span>
          <span class="note">{choice.note}</span>
        </span>
        {#if themeStore.editorChoice === choice.id}
          <Icon name="check" size={18} />
        {/if}
      </button>
    {/each}
  </div>
  <p class="foot">The terminal uses the same colors.</p>
</div>

<style>
  .editor-colors {
    top: calc(100% + 8px);
    right: 0;
    width: 320px;
    max-width: calc(100vw - 24px);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 4px 8px 8px;
  }

  h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 800;
    font-variation-settings: var(--casual);
  }

  .theme {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    margin-bottom: 4px;
    padding: 7px 10px 7px 7px;
    border: 2px solid transparent;
    border-radius: 11px;
    background: transparent;
    color: var(--ink);
    text-align: left;
  }

  .theme:hover {
    background: var(--hover);
  }

  .theme[aria-checked='true'] {
    border-color: var(--line-strong);
  }

  .swatch {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    width: 60px;
    height: 40px;
    flex-shrink: 0;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 7px;
  }

  .swatch span {
    display: block;
    height: 4px;
    border-radius: 2px;
  }

  .label {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .name {
    font-weight: 700;
  }

  .note {
    color: var(--muted);
    font-size: 13px;
  }

  .foot {
    margin: 6px 8px 4px;
    color: var(--muted);
    font-size: 13px;
  }
</style>
