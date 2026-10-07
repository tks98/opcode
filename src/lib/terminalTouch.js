// Touch scrolling for xterm.js, which (in version 6) scrolls with the mouse
// wheel only. A finger drag scrolls the terminal's scrollback, keeps going
// after a flick, and leaves the page still; a tap still focuses the terminal
// (which opens the on-screen keyboard).

const DRAG_THRESHOLD = 8 // pixels a finger moves before a touch is a drag
const FRICTION = 0.95 // momentum kept per frame after a flick
const STOP_SPEED = 0.5 // pixels per frame below which momentum stops

export function enableTouchScroll(terminal, element) {
  let startY = 0
  let lastY = 0
  let lastTime = 0
  let velocity = 0 // pixels per millisecond
  let pending = 0 // pixels not yet scrolled as a whole line
  let dragging = false
  let frame = 0

  const rowHeight = () => {
    const screen = element.querySelector('.xterm-screen')
    return (screen?.clientHeight || element.clientHeight) / Math.max(1, terminal.rows)
  }

  const scrollBy = (pixels) => {
    pending += pixels
    const height = rowHeight()
    const lines = Math.trunc(pending / height)
    if (lines) {
      terminal.scrollLines(lines)
      pending -= lines * height
    }
  }

  const stopMomentum = () => {
    cancelAnimationFrame(frame)
    frame = 0
  }

  const onStart = (event) => {
    if (event.touches.length !== 1) return
    stopMomentum()
    startY = lastY = event.touches[0].clientY
    lastTime = event.timeStamp
    velocity = 0
    pending = 0
    dragging = false
  }

  const onMove = (event) => {
    if (event.touches.length !== 1) return
    const y = event.touches[0].clientY
    if (!dragging && Math.abs(y - startY) < DRAG_THRESHOLD) return
    dragging = true
    event.preventDefault()
    // Finger up: later lines, like any scrolling list.
    const delta = lastY - y
    const elapsed = Math.max(1, event.timeStamp - lastTime)
    velocity = 0.8 * (delta / elapsed) + 0.2 * velocity
    lastY = y
    lastTime = event.timeStamp
    scrollBy(delta)
  }

  const onEnd = (event) => {
    if (!dragging) {
      terminal.focus()
      return
    }
    // A drag isn't a tap: don't focus the terminal or open the keyboard.
    event.preventDefault()
    // A finger that stopped before lifting doesn't flick.
    let speed = event.timeStamp - lastTime > 100 ? 0 : velocity * 16
    const step = () => {
      if (Math.abs(speed) < STOP_SPEED) {
        frame = 0
        return
      }
      scrollBy(speed)
      speed *= FRICTION
      frame = requestAnimationFrame(step)
    }
    if (speed) frame = requestAnimationFrame(step)
  }

  element.addEventListener('touchstart', onStart, { passive: true })
  element.addEventListener('touchmove', onMove, { passive: false })
  element.addEventListener('touchend', onEnd, { passive: false })
  element.addEventListener('touchcancel', stopMomentum)
  return () => {
    stopMomentum()
    element.removeEventListener('touchstart', onStart)
    element.removeEventListener('touchmove', onMove)
    element.removeEventListener('touchend', onEnd)
    element.removeEventListener('touchcancel', stopMomentum)
  }
}
