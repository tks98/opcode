// Svelte actions shared by popovers and menus.

/** Call `onOutside` when a pointer goes down outside `node`. */
export function clickOutside(node, onOutside) {
  let callback = onOutside
  const handle = (event) => {
    if (!node.contains(event.target)) callback(event)
  }
  window.addEventListener('pointerdown', handle, true)
  return {
    update(next) {
      callback = next
    },
    destroy() {
      window.removeEventListener('pointerdown', handle, true)
    },
  }
}

/**
 * Arrow keys move focus between a menu's items (role="menuitem…"), Home and
 * End jump to the ends. The first item is focused when the menu opens.
 */
export function menuKeys(node) {
  const items = () => [...node.querySelectorAll('[role^="menuitem"]:not([disabled])')]
  const handle = (event) => {
    const list = items()
    const index = list.indexOf(document.activeElement)
    let next = null
    if (event.key === 'ArrowDown') next = list[(index + 1) % list.length]
    else if (event.key === 'ArrowUp') next = list[(index - 1 + list.length) % list.length]
    else if (event.key === 'Home') next = list[0]
    else if (event.key === 'End') next = list.at(-1)
    if (next) {
      event.preventDefault()
      next.focus()
    }
  }
  node.addEventListener('keydown', handle)
  queueMicrotask(() => (node.querySelector('[aria-checked="true"]') ?? items()[0])?.focus())
  return {
    destroy() {
      node.removeEventListener('keydown', handle)
    },
  }
}

/**
 * Whether the editor or a terminal may take the keyboard focus on its own
 * (when it loads or shows a file): not while someone is in a menu or dialog,
 * or typing a name.
 */
export function mayTakeFocus() {
  const active = document.activeElement
  if (!active || active === document.body) return true
  if (active.closest('.popover, .dialog')) return false
  return !(active.tagName === 'INPUT' || active.tagName === 'SELECT')
}
