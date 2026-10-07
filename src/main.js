// Entry point - mounts the App to the page
import '@fontsource-variable/recursive/full.css'
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'

// After a new version is deployed, a page loaded before it asks for code
// files that no longer exist ("Importing a module script failed" when
// starting a Linux machine, the editor...). Load the new version instead:
// once a minute at most, so a real outage shows its error instead of looping.
// Projects are saved as you type, so nothing is lost but running programs.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'opcode-reloaded-for-update'
  try {
    if (Date.now() - Number(sessionStorage.getItem(key)) < 60_000) return
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    return
  }
  event.preventDefault()
  location.reload()
})

const app = mount(App, {
  target: document.getElementById('app')
})

export default app
