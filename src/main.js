// Entry point - mounts the App to the page
import '@fontsource-variable/recursive/full.css'
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')
})

export default app
