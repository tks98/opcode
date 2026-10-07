<!--
  KeyBar.svelte - keys a phone keyboard lacks, above the on-screen keyboard

  Shown while a terminal has the focus and the on-screen keyboard is up
  (App.svelte). A tap must not take the focus from the terminal, or iOS
  closes the keyboard: taps are handled on touchend, whose default (iOS's
  mouse events, which move the focus) is cancelled. A swipe scrolls the bar.
-->

<script>
  import { keyBar, sendArrow, sendKeys } from '../stores/keyBar.svelte.js'

  const KEYS = [
    { label: 'Esc', title: 'Escape', send: () => sendKeys('\x1b') },
    { label: 'Tab', title: 'Tab (completes names)', send: () => sendKeys('\t') },
    { label: 'Ctrl', title: 'Ctrl: tap, then a letter', ctrl: true },
    { label: '^C', title: 'Ctrl+C (stop the running program)', send: () => sendKeys('\x03') },
    { label: '↑', title: 'Up (previous command)', send: () => sendArrow('A') },
    { label: '↓', title: 'Down (next command)', send: () => sendArrow('B') },
    { label: '←', title: 'Left', send: () => sendArrow('D') },
    { label: '→', title: 'Right', send: () => sendArrow('C') },
    { label: '|', send: () => sendKeys('|') },
    { label: '~', send: () => sendKeys('~') },
    { label: '/', send: () => sendKeys('/') },
    { label: '-', send: () => sendKeys('-') },
  ]

  const MOVE_LIMIT = 10 // pixels a finger may move and still tap

  function press(index) {
    const key = KEYS[index]
    if (!key) return
    if (key.ctrl) keyBar.ctrl = !keyBar.ctrl
    else {
      keyBar.ctrl = false
      key.send()
    }
  }

  const keyIndex = (target) => Number(target?.closest?.('button[data-key]')?.dataset.key ?? -1)

  function taps(node) {
    let start = null
    const onStart = (event) => {
      const touch = event.touches[0]
      start = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY, key: keyIndex(event.target) } : null
    }
    const onMove = (event) => {
      const touch = event.touches[0]
      if (start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > MOVE_LIMIT) start = null
    }
    const onEnd = (event) => {
      event.preventDefault()
      if (start) press(start.key)
      start = null
    }
    // A mouse or trackpad (an iPad with one): keep the focus, press on click.
    const onMouseDown = (event) => event.preventDefault()
    const onClick = (event) => press(keyIndex(event.target))
    node.addEventListener('touchstart', onStart, { passive: true })
    node.addEventListener('touchmove', onMove, { passive: true })
    node.addEventListener('touchend', onEnd, { passive: false })
    node.addEventListener('mousedown', onMouseDown)
    node.addEventListener('click', onClick)
    return {
      destroy() {
        node.removeEventListener('touchstart', onStart)
        node.removeEventListener('touchmove', onMove)
        node.removeEventListener('touchend', onEnd)
        node.removeEventListener('mousedown', onMouseDown)
        node.removeEventListener('click', onClick)
      },
    }
  }
</script>

<div class="key-bar" role="toolbar" aria-label="Terminal keys" use:taps>
  {#each KEYS as key, index (key.label)}
    <button
      type="button"
      tabindex="-1"
      data-key={index}
      class:on={key.ctrl && keyBar.ctrl}
      aria-pressed={key.ctrl ? keyBar.ctrl : undefined}
      title={key.title ?? key.label}>{key.label}</button
    >
  {/each}
</div>

<style>
  .key-bar {
    display: flex;
    flex-shrink: 0;
    gap: 6px;
    padding: 6px 8px;
    overflow-x: auto;
    border-top: 2px solid var(--line);
    background: var(--bar);
    scrollbar-width: none;
  }

  .key-bar::-webkit-scrollbar {
    display: none;
  }

  button {
    flex: 1 0 auto;
    min-width: 40px;
    height: 36px;
    padding: 0 8px;
    border: 2px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    font-family: var(--font-code);
    font-size: 15px;
    font-weight: 600;
    touch-action: pan-x;
    -webkit-user-select: none;
    user-select: none;
  }

  button:active {
    background: var(--hover);
  }

  button.on {
    border-color: var(--focus);
    background: var(--focus);
    color: var(--bg);
  }
</style>
