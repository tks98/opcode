<!--
  ThemeToggle.svelte - switch the app between light and dark.
-->

<script>
  import { themeStore } from '../stores/theme.svelte.js'
  import Icon from './Icon.svelte'

  let label = $derived(themeStore.mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode')
</script>

<button class="btn btn-icon" onclick={() => themeStore.toggle()} aria-label={label} title={label}>
  <Icon name={themeStore.mode === 'dark' ? 'sun' : 'moon'} size={20} />
</button>
