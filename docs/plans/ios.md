# Plan: Opcode on iPhone and iPad

A plan for finding out why Opcode hangs on iPhones and making it work there, to be carried out on a Mac (Safari, the iOS Simulator and a real iPhone). Every browser on iPhone and iPad uses WebKit, Safari's engine, so "iOS support" means "WebKit support, within iOS's memory limits".

## Goals

1. **Never hang.** If something can't run on a device, Opcode says so, in plain words, instead of freezing.
2. **The core works on a recent iPhone**: the start screen, the editor, the terminal (Bash and its tools), Python, JavaScript, web pages with the preview, SQL, Lua and Bash projects, and a Linux machine.
3. **As much of the rest as the device allows** (C and C++, Java, C#, Go, Ruby, PHP, R, TypeScript, Rust, Docker), and the start screen shows which ones won't fit before anyone tries.
4. **Usable with the on-screen keyboard**: Ctrl+C, arrows and Tab without a hardware keyboard, and long commands that wrap.

## What we know so far

- **On an iPhone** (iOS version and browser still to note), the live site loads, the terminal starts and shows Bash's prompt, but Run hangs: `python3 main.py` and `rustc main.rs -o main && ./main` print nothing, and the page stops responding. The site was served over plain HTTP at the time (its certificate was still being issued; it has one now), so retest on HTTPS first.
- **It isn't the screen size or touch input.** The same Python and Rust projects work in Chromium emulating an iPhone (390×844, touch, mobile mode) against the production build.
- **A separate bug, on every platform:** a command wider than the terminal shows up as `<ustc main.rs -o main && ./main`, printed twice. Bash's line editor scrolls the line sideways because it can't find a description of the terminal (`TERM=xterm-256color`, but the sandbox has no terminfo or termcap entry for it), and `bind 'set horizontal-scroll-mode off'` doesn't help. It shows on phones because their terminals are about 40 columns wide.
- **The Wasmer SDK** (the runtime behind the sandbox) is tested in Playwright's WebKit, and its README mentions Safari 27 and later. It uses WebAssembly JSPI (`WebAssembly.Suspending`, `WebAssembly.promising`), `Atomics.waitAsync`, `SharedArrayBuffer` and a Web Worker per process.
- **Sizes**, which matter for iOS's memory limits:

  | Toolchain | WebAssembly, unpacked | Memory it declares |
  | --- | --- | --- |
  | Rust (`rustc`) | 95 MB | shared, up to 1 GiB |
  | Clang (C, C++) | 76 MB | |
  | Go | 39 MB | no maximum |
  | Ruby | 25 MB | no maximum |
  | C# (.NET) | 11 MB | |
  | Java (Ristretto) | 8 MB | no maximum |
  | SQLite, Lua | 1.7 MB, 0.3 MB | no maximum |
  | Python, Node.js, PHP, Bash and tools | 62, 93, 86 and 25 MB downloads, from the Wasmer registry | |
  | Linux machine, Docker machine | 42 MB and 139 MB snapshots | 256 MB and 1 GB of guest memory |

## Suspects, and how to tell them apart

| | Suspect | Points to it | How to check |
| --- | --- | --- | --- |
| H1 | Starting any second program fails (a new worker, its shared memory, or JSPI) | Bash itself runs; the programs it starts don't | In the iPhone's terminal: `ls`, `cat /etc/os-release`, `lua -v`. If even `ls` hangs, it's H1. |
| H2 | Big programs exceed iOS's limits (memory for compiling, executable memory, or the tab's memory budget) | Python and Rust are large | Small programs work and big ones hang; Web Inspector's memory timeline climbs; Safari reloads the page ("using significant memory") |
| H3 | A WebAssembly or JavaScript feature behaves differently in that WebKit (JSPI, `Atomics.waitAsync`, exceptions, shared memory) | The SDK relies on newer features | The capability probe below; errors in a worker's console in Web Inspector |
| H4 | Something blocks the page's main thread | "Everything freezes" | Web Inspector → Timelines: long tasks on the main thread while Run hangs |
| H5 | Cross-origin isolation from the service worker (how GitHub Pages gets it) behaves differently in Safari, for workers in particular | GitHub Pages can't send the headers; `coi-serviceworker.js` adds them. A related first-visit bug is already fixed on `main` (f43cd38): the page reloaded before the service worker was active, so first-time visitors could stay unisolated until they refreshed. | Compare one iPhone on GitHub Pages with a server that sends real headers (the Docker image behind a tunnel); check `crossOriginIsolated` in the page and in its workers |
| H6 | The page was on plain HTTP | ⓘ in the address bar | Retest on `https://opcode-dev.com` |

## Setting up the Mac

- **Safari:** Settings → Advanced → *Show features for web developers*. The Develop menu then lists the Mac, the Simulator and a connected iPhone, and Web Inspector shows each page's console, network, timelines and memory, and its workers (pick one in the console's context menu).
- **iOS Simulator:** install it from Xcode (Settings → Components → iOS). `xcrun simctl boot "iPhone 16"`, `open -a Simulator`, then `xcrun simctl openurl booted http://localhost:5173`. The Simulator's Safari treats `localhost` as secure, so the dev server works as is. It runs iOS's WebKit but not an iPhone's memory limits, so it finds engine bugs, not memory ones.
- **iPhone:** Settings → Apps → Safari → Advanced → *Web Inspector* on; connect it by cable and trust the Mac. Note the model and the iOS version.
- **Serving to the iPhone over HTTPS** (Opcode needs a secure page):
  - The dev server through a tunnel: `npm run dev -- --host`, then `cloudflared tunnel --url http://localhost:5173` prints an `https://…trycloudflare.com` address. The headers Opcode needs pass through.
  - The production server, which also tests H5: `npm run build && npm run build:preview-host && node scripts/precompress.mjs && npm start`, then the tunnel to port 8080.
  - Or a local certificate (mkcert) trusted on the iPhone.
- **Playwright's WebKit**, for automated runs: `npx playwright install webkit`, then a `webkit` project in `playwright.config.js` using `devices['iPhone 15']` (WebKit with an iPhone's screen, touch and user agent, but not its memory limits).

## Phase 1: make failures visible

Before guessing, give every device a way to say what went wrong.

- **A diagnostics log**, turned on with `?debug` in the address: runtime events with times, shown on the page with a *Copy* button, so an iPhone can report without a Mac attached:
  - workers created and their errors;
  - toolchain downloads and WebAssembly compiles, with sizes and durations;
  - programs started and exited;
  - unhandled errors and failed memory allocations.

  The places to hook in are `src/lib/runtime/ProjectSandbox.svelte.js`, `Shell.svelte.js`, `toolchains.js` and `wasmer.js`.
- **A capability probe**, on the debug page or as `public/diagnostics.html`:
  - browser and iOS version, `crossOriginIsolated`, `SharedArrayBuffer`, `Atomics.waitAsync`;
  - JSPI (`WebAssembly.Suspending`, `WebAssembly.promising`);
  - WebAssembly threads, SIMD, exceptions and tail calls, each tested with a tiny module;
  - how many shared memories of 256 MB, 1 GiB and 4 GiB it can create;
  - how long a mid-sized module (Go's 39 MB) takes to compile;
  - `navigator.hardwareConcurrency` and `navigator.storage.estimate()`.
- **No silent hangs**: when a program can't start (a worker error, a failed compile, out of memory), print the error in the terminal and go back to the prompt. This helps every browser, not only Safari.

Done when an iPhone shows, on screen, why Run hangs.

## Phase 2: reproduce and find the cause

Work from the fastest loop to the slowest, running the checks for H1 to H6 on each and recording the results in this file:

1. Safari on the Mac.
2. Safari in the iOS Simulator.
3. A real iPhone, with Web Inspector.
4. Playwright's WebKit, locally and then in CI.

Then follow the result:

- **Fails in Safari on the Mac too:** an engine difference. Find the failing call (JSPI, `Atomics.waitAsync`, worker startup, shared memory). Check the Wasmer SDK's issues and newer versions. Work around it in Opcode: the SDK's build is already adjusted in `vite.config.js` (`copyWasmerSdk`), so a small patch or polyfill can go there too. Report it upstream with a minimal reproduction.
- **Fails only on the iPhone:** a limit. Measure each toolchain's peak memory, then reduce it where possible:
  - ask for smaller memory maximums;
  - drop downloaded bytes and compiled modules once they're used;
  - compile while streaming instead of buffering.

  Mark what still doesn't fit as unavailable on that device.
- **Fails only on GitHub Pages (H5):** fix the service worker's isolation for workers. Failing that, recommend a host that sends real headers to iPhone users (Netlify or Cloudflare with `_headers`, or the Docker image).

## Phase 3: fix, and fill in the support matrix

| | Safari (Mac) | iOS Simulator | iPhone (model, iOS) | Notes |
| --- | --- | --- | --- | --- |
| Start screen, editor, terminal (Bash) | | | | |
| Python | | | | |
| JavaScript (Node.js), TypeScript | | | | |
| Web page and preview | | | | |
| SQL, Lua, Bash | | | | |
| C and C++ | | | | Clang is 76 MB |
| Java, C#, Go, Ruby, PHP, R | | | | |
| Rust | | | | 95 MB, up to 1 GiB of memory |
| Linux machine | | | | 256 MB guest |
| Docker machine | | | | 1 GB guest: likely too big |

Whatever can't run on a device shows a clear message on its start-screen card and in the terminal ("needs more memory than this device allows") instead of Run hanging.

## Phase 4: make it pleasant on a phone

These help Android phones too.

- **Wrap long commands**: give Bash a terminal description so its line editor wraps instead of scrolling sideways. For example, a `TERMCAP` entry for xterm in the shell's environment (`src/lib/runtime/shell.js`), if the sandbox's Bash reads termcap, or a terminfo entry in the sandbox. Check it on a 40-column terminal.
- **A key bar above the on-screen keyboard**: Esc, Tab, Ctrl (sticky, for Ctrl+C), the arrows, `|`, `~` and `/`.
- **The keyboard and the layout**: use `visualViewport` to keep the terminal's input line visible when the keyboard opens. Don't resize the terminal while a program waits for input: on WASIX, a resize interrupts the read.
- **Typing**: no autocorrect, autocapitalization or smart punctuation in the terminal or the editor (check xterm.js's input element and Monaco on iOS).
- **Memory**: keep one project's sandbox alive at a time on phones, and release it when switching projects.

## Phase 5: keep it working

- A `webkit` project in `playwright.config.js`, with a quick subset of the end-to-end tests: the start screen, Python, Bash and a Linux machine booting. Add a CI job for it next to the Chromium one.
- A checklist for testing on a real iPhone, in `docs/development.md`.
- The support matrix in `docs/limitations.md`, replacing the current "Browsers" line.

## Before the Mac session: quick checks on the iPhone

On `https://opcode-dev.com`, which now has its certificate:

1. Note the iPhone model, its iOS version (Settings → General → About) and the browser.
2. Open a Bash project and type, one at a time: `echo hi`, `ls`, `cat /etc/os-release`. Note which ones answer.
3. Open a Lua project and press Run: Lua is tiny.
4. Open a Python project, press Run and wait two minutes. Does it answer, stay frozen, or does Safari reload the page?
5. Start *Learn the Linux terminal*. Does the machine boot?

If `echo` and `ls` work and Python doesn't, it's probably size (H2). If `ls` hangs too, it's starting programs (H1). Either way, the Mac session starts with a direction.
