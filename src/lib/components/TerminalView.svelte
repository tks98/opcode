<!--
  TerminalView.svelte - xterm.js bound to one project's session

  Keystrokes go to the session, output comes back from it. Shell
  integration sequences (OSC 133/7) are handled here and not displayed.
-->

<script>
  import { onMount } from 'svelte'
  import { OSC_CWD, OSC_SHELL_INTEGRATION } from '../runtime/shell.js'
  import { CODE_FONT, codeFontReady, xtermTheme } from '../editorThemes.js'
  import { themeStore } from '../stores/theme.svelte.js'
  import { mayTakeFocus } from '../actions.js'

  // onLink(uri) returns true when it handled a clicked link.
  let { session, visible = true, onLink = () => false } = $props()

  let container = $state(null)
  let terminal = null
  let fitAddon = null
  let themed = $state(false)

  // The terminal uses the editor's colour theme.
  $effect(() => {
    const theme = xtermTheme(themeStore.editorTheme)
    if (themed && terminal) terminal.options.theme = theme
  })

  onMount(() => {
    let disposed = false
    let resizeObserver = null
    let view = null

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/xterm/css/xterm.css'),
      // xterm measures its cells once, so wait for the real font.
      codeFontReady(14),
    ]).then(([{ Terminal }, { FitAddon }, { WebLinksAddon }]) => {
      if (disposed) return
      terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        convertEol: true,
        fontFamily: CODE_FONT,
        fontSize: 14,
        lineHeight: 1.2,
        scrollback: 10000,
        allowProposedApi: true,
        theme: xtermTheme(themeStore.editorTheme),
      })
      themed = true
      fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.loadAddon(new WebLinksAddon((event, uri) => onLink(uri) || window.open(uri, '_blank', 'noopener')))
      terminal.open(container)

      for (const code of [OSC_SHELL_INTEGRATION, OSC_CWD]) {
        terminal.parser.registerOscHandler(code, (data) => {
          session.handleOsc(code, code === OSC_CWD ? decodeCwd(data) : data)
          return true
        })
      }

      terminal.onData((data) => session.input(data))
      terminal.onResize(({ cols, rows }) => session.resize(cols, rows))

      view = {
        write: (data) => terminal.write(data),
        focus: () => terminal.focus(),
        clear: () => terminal.clear(),
      }
      session.attach(view)
      fit()
      session.resize(terminal.cols, terminal.rows)

      resizeObserver = new ResizeObserver(() => fit())
      resizeObserver.observe(container)
      if (visible && mayTakeFocus()) terminal.focus()
    })

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      if (view) session.detach(view)
      terminal?.dispose()
    }
  })

  // OSC 7 may carry a plain path or a file:// URL.
  function decodeCwd(data) {
    try {
      return data.startsWith('file://') ? decodeURIComponent(new URL(data).pathname) : data
    } catch {
      return data
    }
  }

  function fit() {
    if (!fitAddon || !container?.offsetWidth || !container?.offsetHeight) return
    try {
      fitAddon.fit()
    } catch {
      // Not laid out yet.
    }
  }

  $effect(() => {
    if (visible) {
      queueMicrotask(() => {
        fit()
        if (mayTakeFocus()) terminal?.focus()
      })
    }
  })

  export function focus() {
    terminal?.focus()
  }

  export function clear() {
    terminal?.clear()
  }
</script>

<div class="terminal-view" bind:this={container}></div>

<style>
  .terminal-view {
    width: 100%;
    height: 100%;
    padding: 10px 0 0 14px;
    overflow: hidden;
    background: var(--term-bg, transparent);
  }

  /* The container shows the theme's background below the last full row. */
  .terminal-view :global(.xterm-viewport) {
    background-color: transparent !important;
    scrollbar-width: thin;
  }

  .terminal-view :global(.xterm) {
    height: 100%;
  }
</style>
