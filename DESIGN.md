# Opcode design

The ground truth for how Opcode looks and reads. Tokens live in `src/app.css`, editor and terminal themes in `src/lib/editorThemes.js`.

## Who it's for

Anyone, including people who have never written code. Their first five minutes should be: pick a language, press Run, see it work, change something. Everything else (terminals, files, previews, Linux) is there when they need it, and doesn't get in the way before.

## The idea: a notebook

Ink on graph paper by day, a blueprint by night, and one yellow highlighter. It's friendly and a little hand-made, but it's still a tool you can work in all day.

- **One loud thing.** The yellow highlighter is reserved for the main action on a screen: *Run*, *Start coding in…*, *Start the guided tutorial*. It also marks what's selected (a soft highlighter wash) and the cursor in the logo. Nothing else is yellow.
- **Hard edges, no blur.** 2px borders and solid offset shadows (`0 3px 0`, `0 6px 0`) instead of soft drop shadows or glass.
- **Plain words.** "Start coding in Python", "Internet: off", "First run downloads 62 MB". Sentence case everywhere. No jargon on the start screen.

## Type

One family, [Recursive](https://www.recursive.design/) (SIL OFL 1.1), self-hosted:

| Use | Font | Settings |
| --- | --- | --- |
| Interface | `Recursive Variable` (`@fontsource-variable/recursive`) | `--ui`: `'CASL' 0, 'MONO' 0`, weight 400–700 |
| Headings, primary buttons | `Recursive Variable` | `--casual`: `'CASL' 1`, weight 750–800 |
| Code, terminal, logo | `Recursive Mono` (`src/assets/fonts`) | Recursive's Mono Linear style as its own font |

`Recursive Mono` is baked by `scripts/make-mono-font.py` because xterm.js measures text on a canvas, which ignores `font-variation-settings`. Recursive has no box-drawing glyphs, so those fall back to the system monospace font.

Base size is 15px. Headings on the start screen use `clamp(36px, 5vw, 54px)`.

## Colour

| Token | Light | Dark (blueprint) | Use |
| --- | --- | --- | --- |
| `--bg` | `#f5f8fc` + grid | `#0e2440` + grid | Page background (the start screen shows the 24px grid) |
| `--bar` | `#ffffff` | `#0b1f38` | Top bar, side panels, status bar |
| `--surface` | `#ffffff` | `#13304f` | Cards, buttons, popovers |
| `--ink` | `#1b2b4b` | `#eaf2ff` | Text |
| `--muted` | `#56647c` | `#a9beda` | Secondary text, idle icons |
| `--line` | `#d3deec` | `#2a4f78` | Borders |
| `--line-strong` | ink | highlighter | The selected card's border |
| `--selected` | highlighter 45% | highlighter 16% | Selected file, tab, terminal |
| `--highlight` | `#ffd84d` | `#ffd84d` | The one main action |
| `--focus` | `#2f6fb5` | `#8cc8ff` | Focus rings, links, progress |
| `--ok` / `--danger` | `#2e7d32` / `#b42318` | `#7fe0a0` / `#ff8a80` | Status |

Light or dark follows the system until someone presses the sun/moon button; the choice is saved in `localStorage` and applied by `index.html` before the page paints.

### Languages

Each language has a colour, shown as a strip on its start-screen card and as a small square next to its files and projects. No emoji or logos.

| Python | JavaScript | C | C++ | Rust | Go | PHP | Bash | Linux |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `#2f6fb5` | `#d9a400` | `#6b7a99` | `#3e5fa8` | `#b7410e` | `#00897b` | `#5e6fa8` | `#3f7d3a` | ink, with a `$_` mark |

## Editor and terminal colours

The editor and the terminals share one theme, picked from the palette button. *Match the app* (the default) uses Notebook in light mode and Blueprint in dark mode.

| Theme | Feel | Background |
| --- | --- | --- |
| Notebook | Ink on paper | `#fbfcfe` |
| Blueprint | White lines on blue | `#0f2a4a` |
| Highlighter | Bright and cheerful | `#fffdf3` |
| High contrast | Easiest to read | `#ffffff` |
| High contrast dark | Bright on black | `#000000` |

Each theme defines its syntax colours and a 16-colour terminal palette chosen so every colour programs print (yellow warnings, grey hints) stays readable on its background. Text selections use the highlighter.

## Components

- **Buttons** (`.btn`): 40px tall (44px on touch screens), 12px radius, 2px border. `.btn-primary` is the yellow highlighter with an ink outline and a 3px ink shadow that presses down on click. `.btn-quiet` has no border. `.btn-icon` is square and always has an `aria-label`.
- **Popovers and menus** (`.popover`, `.menu-item`): 2px border, 14px radius, a 6px offset shadow. Arrow keys move through menu items, Escape closes and returns focus.
- **Dialogs** (`.dialog`): same as popovers with an 8px shadow, over a tinted backdrop.
- **Marks** (`.mark`): a 10px rounded square in a language's colour (`--mark`).

## Screens

**Start screen.** "What will you make today?", eight language cards (four across, two on phones), a dashed card for the Linux lessons, and on the right the selected language's starter program with its download size, the yellow *Start coding in …* button and *Continue where you left off*. On phones the start button stays pinned to the bottom. It's shown on a first visit, from the logo, and for *New project*. Returning visitors go straight back to their last project.

**Coding screen.** One top bar: logo (home), the project menu (switch, rename, delete, new), *Run*, *Stop*, *Preview* when a server is running, editor colours, light/dark, and a *More* menu (files, terminal, new terminal, download as ZIP, open a file, internet access). Files on the left (a drawer on phones), the editor, and the terminal below it; the terminal folds down to its header. The status bar says what's happening in plain words.

## Quality floor

- Every control works with the keyboard and shows a 3px focus ring.
- Text meets WCAG AA contrast (4.5:1) in both modes. In every editor theme, syntax colours and the terminal's palette reach 4.5:1 on their background too; line numbers reach 3:1.
- Icon-only buttons have names; labels hidden on phones stay readable by screen readers.
- `prefers-reduced-motion` turns animations off.
- Everything works at 390px wide.

## Avoid

Purple or blue-violet gradients, Inter/Roboto, glassmorphism, soft blurry shadows, emoji as icons, all-caps labels, "·"-separated metadata strings, and more than one yellow thing per screen.
