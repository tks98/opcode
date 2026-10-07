[← Documentation](README.md)

# Development

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Node.js 20 or later.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm run preview` | Production build and local preview |
| `npm start` | Serve the production build as the Docker image does (see [Deploying](deploying.md)) |
| `npm test` | Unit tests (Vitest) |
| `npm run check` | `svelte-check` |
| `npm run test:e2e` | End-to-end tests in Chromium (needs network; downloads real toolchains) |
| `npm run relay` | The internet relay, locally on port 8090 (see [Deploying](deploying.md#internet-relay)) |
| `npm run preview-host` / `npm run build:preview-host` | Serve the web preview host locally on port 5174, or build it into `dist-preview-host/` (see [Deploying](deploying.md#web-preview-host)) |
| `npm run build:go` | Rebuild `public/toolchains/go.wasm.gz` (needs Go 1.22+) |
| `npm run fetch:rust` | Download the Rust toolchain again (`dev` and `build` fetch it when missing) |
| `npm run fetch:java` | Rebuild Java's runtime files from the pinned JDK (`dev` and `build` do it when missing) |
| `npm run build:ristretto` | Rebuild the `java` command (Ristretto for WASI; needs rustup) |
| `npm run build:stty`, `build:opcode-wait`, `build:sqlite`, `build:lua`, `build:csharp-runner` | Rebuild those commands from `toolchains/` (each needs its own tools; see the folder) |
| `npm run build:linux` | Rebuild the Linux machine snapshot (needs root on Linux; see `toolchains/linux/`) |
| `npm run build:docker` | Rebuild the Docker machine snapshot (the same, with Docker) |

Tests: `npm test` runs the unit tests (Vitest, `tests/`), and `npm run test:e2e` the end-to-end tests in Chromium (Playwright, `tests/e2e/`). CI (`.github/workflows/ci.yml`) runs both on every push to `main` and on pull requests, then builds the Docker image and publishes it once they pass; `.github/workflows/pages.yml` publishes the site. On macOS, *makes a web page that updates as you type* fails locally (Cmd+F doesn't open Monaco's find box in Playwright's Chrome there); it passes in CI.

## Testing on iPhone and iPad

Every browser on iPhone and iPad uses WebKit, with stricter memory limits than a computer (see [Limitations](limitations.md) and [the iPhone and iPad plan](plans/ios.md)), so check changes to the runtime, the terminal or the layout there too:

- **Safari 27 on a Mac** runs the same WebKit, without the memory limits.
- **The iOS and iPadOS Simulators** come with Xcode (add the iOS platform in *Xcode > Settings > Components*). Boot one with `xcrun simctl boot "iPhone 17"`, `open -a Simulator`, then `xcrun simctl openurl booted http://localhost:5173`: the Simulators' Safari treats `localhost` as secure, so the dev server works as it is. They have iOS's limits on WebAssembly memory, but not a device's total memory.
- **A real iPhone or iPad** needs an `https://` address: the dev server through a tunnel (`npm run dev -- --host`, then `cloudflared tunnel --url http://localhost:5173`), or a deployed copy. Settings > Apps > Safari > Advanced > *Web Inspector* lets Safari on a Mac inspect the page over a cable.

## Project structure

```
src/
├── App.svelte                  # Start screen ↔ coding screen, layout, shortcuts, import/export
├── main.js                     # Mounts the app; reloads once when a deploy replaced the page's files
├── app.css                     # Design tokens, buttons, menus (see docs/design.md)
├── assets/fonts/               # Recursive Mono (built by scripts/make-mono-font.py), OFL
└── lib/
    ├── languages.js            # Languages, toolchains, starters, run commands
    ├── editorThemes.js         # Editor + terminal colour themes
    ├── paths.js                # Project path helpers
    ├── fileTree.js             # Sidebar tree builder
    ├── persistence.js          # IndexedDB storage, plus a localStorage copy written as the page closes
    ├── siteConfig.js           # Settings from config.js (relay, preview host)
    ├── monaco.js               # Monaco setup
    ├── actions.js              # Svelte actions for popovers and menus
    ├── terminalTouch.js        # Finger scrolling and tap-to-type for the terminal
    ├── time.js                 # "5 minutes ago"
    ├── stores/
    │   ├── projects.svelte.js  # Projects, files, folders, tabs
    │   ├── sessions.svelte.js  # Live terminal sessions (one per project)
    │   ├── linux.svelte.js     # The running Linux or Docker machine
    │   ├── preview.svelte.js   # The web preview (one host origin per server, or one at a time)
    │   ├── network.svelte.js   # Internet relay settings
    │   ├── theme.svelte.js     # Light/dark and the editor theme
    │   ├── viewport.svelte.js  # The visible area above the on-screen keyboard
    │   └── keyBar.svelte.js    # The phone key bar's target terminal and sticky Ctrl
    ├── runtime/
    │   ├── ProjectSandbox.svelte.js  # Sandbox, terminals, Run/Stop, sync, compiler bridge
    │   ├── Shell.svelte.js     # One terminal tab's bash: input, Ctrl+C, restarts
    │   ├── workspaceSync.js    # Two-way sync planning (pure)
    │   ├── shell.js            # bashrc: prompt integration, watchdog, termcap, compiler commands
    │   ├── tools.bash          # ~/.opcode/tools.sh: rustc, the built-in cargo, the pager, rm fixes
    │   ├── toolchains.js       # Package downloads with progress
    │   ├── compiler.js / clang.worker.js / compilerArgs.js  # C/C++ via YoWASP
    │   ├── javac.js / javac.worker.js / wasmImports.js  # javac in the browser (TeaVM), and Safari's fix
    │   ├── tsc.js / tsc.worker.js / tscRunner.js  # TypeScript's tsc in the browser
    │   ├── r.js / rlang.js     # R on webR
    │   ├── wasmer.js           # Wasmer client
    │   └── appleMobile.js / wasmerWorker.apple.js  # iPhone and iPad: memory caps and the SDK worker wrapper
    ├── linux/                  # Linux and Docker machines: LinuxMachine (v86), saved snapshots, preview bridge
    └── components/             # StartScreen, TopBar, ProjectSwitcher, Sidebar, Editor, Terminal, KeyBar, …
toolchains/go/                  # Source of the `go` command (Yaegi, WASI)
toolchains/stty/                # Source of the `stty` command (C, WASIX tty calls)
toolchains/opcode-wait/         # Source of the shell's `opcode-wait` helper (C, WASI)
toolchains/sqlite/              # Builds the `sqlite3` command (SQLite amalgamation, WASI)
toolchains/lua/                 # Builds the `lua` command (official sources, WASI)
toolchains/csharp/              # C#: Opcode's `dotnet run` (Roslyn), see its README
toolchains/java/                # Java: the Ristretto patch and build, class file stripping (see its README)
toolchains/linux/               # Builds the Alpine images (Linux, Docker) and their booted snapshots
public/                         # Static files: go.wasm.gz, Linux and Docker snapshots, config.js, _headers, coi-serviceworker.js
scripts/fetch-rust.mjs          # Downloads the Rust toolchain (pinned, checksummed)
scripts/fetch-java.mjs          # Builds Java's runtime files from a pinned Corretto JDK
scripts/fetch-csharp.mjs        # Builds the C# toolchain from pinned NuGet packages
scripts/copy-npm-toolchains.mjs # Copies Ruby, TypeScript and webR (R) from their pinned npm packages
scripts/make-mono-font.py       # Builds the Recursive Mono code font
scripts/preview-host.mjs        # Builds/serves a self-hosted web preview host (and its Cloudflare Worker)
scripts/wisp-server.mjs         # Internet relay (Wisp + DNS-over-HTTPS)
scripts/server.mjs              # Production server (the Docker image's): app, relay and preview host on one port
scripts/precompress.mjs         # Brotli and gzip copies of a build's files, for that server
Dockerfile, compose.yaml        # The deployment image, and a site with HTTPS (Caddy, deploy/Caddyfile)
deploy/preview-host.wrangler.toml  # opcode-dev.com's preview host, a Cloudflare Worker
LICENSE                         # Opcode's license: GNU AGPL-3.0 or later
THIRD_PARTY_NOTICES.md          # The other software Opcode includes and serves, its licenses and sources (texts in licenses/)
tests/                          # Vitest unit tests; tests/e2e: Playwright
docs/                           # This documentation (docs/images/architecture.mjs draws the diagram); docs/plans: plans and findings
```
