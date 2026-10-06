// Draws the architecture diagram in the README, in Opcode's colours (see
// docs/design.md): architecture-light.svg and architecture-dark.svg, which
// GitHub shows to match its theme. Edit this file, then run:
//
//   node docs/images/architecture.mjs

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const THEMES = {
  light: { bg: '#f5f8fc', grid: '#e4ecf6', surface: '#ffffff', ink: '#1b2b4b', muted: '#56647c', line: '#d3deec', shadow: '#1b2b4b', highlight: '#ffd84d', onHighlight: '#1b2b4b', accent: '#2f6fb5' },
  dark: { bg: '#0e2440', grid: '#17345a', surface: '#13304f', ink: '#eaf2ff', muted: '#a9beda', line: '#2a4f78', shadow: '#06162a', highlight: '#ffd84d', onHighlight: '#1b2b4b', accent: '#8cc8ff' },
}

const W = 960
const H = 580
const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function draw(t) {
  const parts = []
  const text = (x, y, content, { size = 12.5, weight = 400, color = t.ink, anchor = 'start' } = {}) =>
    parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${content}</text>`)
  // A card: surface, 2px border and a solid offset shadow (no blur).
  const card = (x, y, w, h, { border = t.line, shadow = t.line, depth = 3, fill = t.surface } = {}) => {
    parts.push(`<rect x="${x}" y="${y + depth}" width="${w}" height="${h}" rx="8" fill="${shadow}"/>`)
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${border}" stroke-width="2"/>`)
  }
  const arrow = (x1, y1, x2, y2, { both = false } = {}) =>
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${t.accent}" stroke-width="2" marker-end="url(#head)"${both ? ' marker-start="url(#tail)"' : ''}/>`)
  const label = (x, y, content, anchor = 'start') => text(x, y, esc(content), { size: 11.5, color: t.muted, anchor })

  // Your browser: everything that runs code.
  parts.push(`<rect x="20" y="26" width="620" height="534" rx="12" fill="${t.shadow}"/>`)
  parts.push(`<rect x="20" y="20" width="620" height="534" rx="12" fill="${t.bg}"/>`)
  parts.push(`<rect x="20" y="20" width="620" height="534" rx="12" fill="url(#grid)" stroke="${t.ink}" stroke-width="2"/>`)
  parts.push(`<rect x="38" y="36" width="318" height="30" rx="6" fill="${t.highlight}"/>`)
  text(50, 56, 'Your browser: all the code runs here', { size: 14.5, weight: 700, color: t.onHighlight })

  const top = [
    [40, 'Editor', 'Monaco, from VS Code'],
    [244, 'Terminal', 'xterm.js, with Bash'],
    [448, 'Preview', 'web pages and plots'],
  ]
  for (const [x, title, sub] of top) {
    card(x, 92, 172, 64)
    text(x + 16, 119, title, { size: 14.5, weight: 700 })
    text(x + 16, 140, esc(sub), { size: 12, color: t.muted })
  }

  card(40, 212, 360, 156)
  text(56, 240, 'Project sandbox', { size: 14.5, weight: 700 })
  text(56, 260, 'WASIX programs on the Wasmer SDK, one per project', { size: 12, color: t.muted })
  text(56, 290, 'Bash · coreutils · nano · grep · sed · tar')
  text(56, 312, 'Python · Node.js · PHP · Go · Ruby · Lua')
  text(56, 334, 'SQLite · Java (Ristretto) · C# (.NET) · Rust')
  text(56, 356, 'Your files in ~, synced with the editor', { size: 12, color: t.muted })

  card(432, 212, 188, 156)
  text(448, 240, 'Web Workers', { size: 14.5, weight: 700 })
  text(448, 260, 'beside the sandbox', { size: 12, color: t.muted })
  text(448, 290, 'Clang: C and C++')
  text(448, 312, 'javac: Java')
  text(448, 334, 'tsc: TypeScript')
  text(448, 356, 'webR: R')

  card(40, 404, 580, 66)
  text(56, 430, 'Linux and Docker machines', { size: 14.5, weight: 700 })
  text(56, 452, 'A whole x86 PC in the v86 emulator, running Alpine Linux and Docker Engine', { size: 12.5, color: t.muted })

  card(40, 488, 580, 46)
  parts.push(`<text x="56" y="516" font-size="12.5" fill="${t.ink}"><tspan font-weight="700">Saved in this browser:</tspan> <tspan fill="${t.muted}">projects, machines and downloaded toolchains</tspan></text>`)

  arrow(126, 160, 126, 208, { both: true })
  label(134, 189, 'files, both ways')
  arrow(330, 160, 330, 208, { both: true })
  label(338, 189, 'keys and output')
  arrow(534, 212, 534, 164)
  label(542, 189, 'plots')
  arrow(404, 290, 428, 290, { both: true })

  // The network: files and connections, but no code runs there.
  text(680, 44, 'Over the network', { size: 14.5, weight: 700 })
  text(680, 64, 'Files and connections only', { size: 11.5, color: t.muted })
  const services = [
    ['Your Opcode site', ['The app, toolchains and machines,', 'as static files'], 'GitHub Pages, or the Docker image'],
    ['Wasmer registry', ['Python, Node.js, PHP and the', 'terminal’s tools, on first use'], 'Cached by the browser'],
    ['Internet relay (optional)', ['Wisp over a WebSocket, for', 'pip install, git clone and curl'], 'Turned off unless you set one up'],
    ['Preview host', ['A separate origin, so servers', 'in the sandbox open in the preview'], 'Wasmer’s, or served by the image'],
  ]
  services.forEach(([title, lines, note], i) => {
    const y = 84 + i * 118
    card(680, y, 260, 98)
    text(696, y + 26, esc(title), { size: 14, weight: 700 })
    lines.forEach((line, j) => text(696, y + 46 + j * 17, esc(line), { size: 12 }))
    text(696, y + 86, esc(note), { size: 11.5, color: t.muted })
    const mid = y + 49
    if (i < 2) arrow(676, mid, 646, mid) // downloads come into the browser
    else arrow(646, mid, 676, mid, { both: true })
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-labelledby="title">
<title id="title">How Opcode works: the editor, terminal and preview, the project sandbox, compilers in Web Workers and the Linux and Docker machines all run in your browser; over the network come only the app's files, the Wasmer registry's packages, an optional internet relay and the preview host.</title>
<defs>
  <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="${t.grid}" stroke-width="1"/></pattern>
  <marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${t.accent}"/></marker>
  <marker id="tail" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="${t.accent}"/></marker>
</defs>
<rect width="${W}" height="${H}" fill="${t.bg}"/>
${parts.join('\n')}
</svg>
`
}

const here = dirname(fileURLToPath(import.meta.url))
for (const [name, theme] of Object.entries(THEMES)) writeFileSync(join(here, `architecture-${name}.svg`), draw(theme))
