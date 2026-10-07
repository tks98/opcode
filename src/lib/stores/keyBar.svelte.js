// The key bar above the on-screen keyboard (components/KeyBar.svelte) types
// into the terminal that last had the focus. Ctrl is sticky: tap it, then a
// letter on the keyboard.

export const keyBar = $state({ ctrl: false })

let target = null // the xterm.js Terminal the bar types into

/** Called by a terminal view when it gets the focus. */
export function setKeyBarTarget(terminal) {
  target = terminal
}

/** Forget a terminal view that is going away. */
export function clearKeyBarTarget(terminal) {
  if (target === terminal) target = null
}

/** Type `data` into the terminal, as if from its keyboard. */
export function sendKeys(data) {
  if (!target) return
  target.input(data, true)
  target.focus()
}

/** An arrow key: A, B, C or D (up, down, right, left). */
export function sendArrow(direction) {
  // Full-screen programs (nano, less) switch arrows to application mode.
  sendKeys(`\x1b${target?.modes.applicationCursorKeysMode ? 'O' : '['}${direction}`)
}

/**
 * Apply a pending Ctrl to what the terminal is about to send: a letter (or
 * @ [ \ ] ^ _) becomes its control character. Any key releases Ctrl.
 */
export function applyCtrl(data) {
  if (!keyBar.ctrl) return data
  keyBar.ctrl = false
  if (data.length !== 1) return data
  const code = data.toUpperCase().charCodeAt(0)
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data
}
