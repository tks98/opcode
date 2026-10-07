// The part of the page the user can see.
//
// On iPhone and iPad the on-screen keyboard covers the page instead of
// making it shorter (100dvh ignores it), and Safari scrolls the page to keep
// the focused field in view. So the app is sized and placed to the visual
// viewport: --app-height and --app-top on <html>, used by .app in App.svelte.
// keyboardOpen tells the layout to give the screen to the panel being typed in.

export const viewport = $state({ keyboardOpen: false })

// Taller than any keyboard accessory bar, shorter than any keyboard.
const KEYBOARD_MIN_HEIGHT = 120

export function trackViewport(root = document.documentElement) {
  const visual = window.visualViewport
  if (!visual) return () => {}

  const update = () => {
    // Pinch zoom also shrinks the visual viewport: leave the layout alone.
    if (visual.scale > 1.01) return
    root.style.setProperty('--app-height', `${visual.height}px`)
    root.style.setProperty('--app-top', `${visual.offsetTop}px`)
    viewport.keyboardOpen = root.clientHeight - visual.height > KEYBOARD_MIN_HEIGHT
  }
  // The app already fits the visible area; undo Safari's scroll toward the field.
  const unscroll = () => {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
  }

  update()
  visual.addEventListener('resize', update)
  visual.addEventListener('scroll', update)
  window.addEventListener('scroll', unscroll)
  return () => {
    visual.removeEventListener('resize', update)
    visual.removeEventListener('scroll', update)
    window.removeEventListener('scroll', unscroll)
    root.style.removeProperty('--app-height')
    root.style.removeProperty('--app-top')
  }
}
