# Plan: Opcode on iPhone and iPad

A plan for finding out why Opcode hangs on iPhones and making it work on iPhone and iPad, to be carried out on a Mac (Safari, the iOS and iPadOS Simulators, and real devices). Every browser on iPhone and iPad uses WebKit, Safari's engine, so "iOS support" means "WebKit support, within the device's memory limits". Safari on macOS uses the same WebKit as Safari on iOS and iPadOS of the same version (Safari 27 ships with macOS, iOS and iPadOS 27).

## Goals

1. **Never hang.** If something can't run on a device, Opcode says so, in plain words, instead of freezing.
2. **The core works on a recent iPhone**: the start screen, the editor, the terminal (Bash and its tools), Python, JavaScript, web pages with the preview, SQL, Lua and Bash projects, and a Linux machine.
3. **More works on a recent iPad**, which has more memory than an iPhone: the core, plus as many of the larger toolchains as fit.
4. **As much of the rest as the device allows** (C and C++, Java, C#, Go, Ruby, PHP, R, TypeScript, Rust, Docker), and the start screen shows which ones won't fit before anyone tries.
5. **Usable with the on-screen keyboard**: Ctrl+C, arrows and Tab without a hardware keyboard, and long commands that wrap.
6. **On an iPad with a hardware keyboard, it feels like a Mac**: Ctrl+C, Esc, Tab and the arrows reach the terminal, and the layout follows Split View, Slide Over and Stage Manager as the window changes size.

## First: quick checks on the iPhone and iPad

The cheapest step, and the one that decides where to look. On `https://opcode-dev.com`, on each device:

1. Note the model, the iOS or iPadOS version (Settings → General → About) and the browser. **Below 27, stop here**: the Wasmer SDK needs Safari 27 or later (H3), so the answer is to update, and Opcode should say so (Phase 1).
2. Open a Bash project and type, one at a time: `echo hi`, `ls`, `cat /etc/os-release`. `echo` is part of Bash; `ls` and `cat` are separate programs. Note which ones answer.
3. Open a Lua project and press Run: Lua is tiny.
4. Open a Python project, press Run and wait two minutes. Does it answer, stay frozen, or does Safari reload the page?
5. Start *Learn the Linux terminal*. Does the machine boot?
6. On the iPad: repeat 2 and 4 in Split View (Opcode in a narrow window), and with a hardware keyboard if there is one: does Ctrl+C stop `sleep 100`?

If `echo` and `ls` work and Python doesn't, it's probably size (H2). If `ls` hangs too, it's starting programs (H1). If the iPad runs what the iPhone can't, that points to memory (H2) as well. Either way, the Mac session starts with a direction.

## What we know so far

- **On an iPhone** (iOS version and browser still to note), the live site loads, the terminal starts and shows Bash's prompt, but Run hangs: `python3 main.py` and `rustc main.rs -o main && ./main` print nothing, and the page stops responding. The site was served over plain HTTP at the time (its certificate was still being issued; it has one now), so retest on HTTPS first. **Not yet tried on an iPad.**
- **It isn't the screen size or touch input.** The same Python and Rust projects work in Chromium emulating an iPhone (390×844, touch, mobile mode) against the production build.
- **Reproduced in the iOS and iPadOS 27.0 Simulators** (iPhone 17 and iPad Pro 13-inch (M5), Safari, `https://opcode-dev.com`, 6 Oct 2026):
  - the first visit is cross-origin isolated (the service worker's reload works, so H5 is unlikely), and the start screen, editor and terminal load; the iPad gets the desktop layout;
  - the Linux machine boots on the iPhone and runs `uname -a` and `echo hi` (it runs on its own emulator, not the WASIX sandbox);
  - **the first Bash starts and shows its prompt, but no later process does**: Run types `bash main.sh` and nothing comes out, not even the script's first `echo`; after Stop, the restarted shell never shows a prompt or echoes typing. Same on both devices.
  - **Mac Safari 27 runs it all** (same page, same WebKit version): `echo`, `ls` and `bash main.sh` work, with 8 SDK workers. So it's iOS, not the engine version.
- **Cause, found in the iPadOS Simulator with a logging copy of the page (7 Oct 2026): two iOS limits, both in how the Wasmer SDK starts workers.**
  1. **Shared WebAssembly memories.** iOS lets a page reserve far fewer of them than macOS. Measured with `new WebAssembly.Memory({ shared: true, maximum })` until it throws `RangeError: Out of memory`:

     | Maximum | iOS / iPadOS 27 Simulators | Mac Safari 27 |
     | --- | --- | --- |
     | 4 GiB | 3 | 15 |
     | 2 GiB, with one 4 GiB already held | 3 | 22 |
     | 1 GiB | 6 | 38 |
     | 512 MiB | 10 | |
     | 256 MiB | 18 | 64+ |

     The SDK reserves one of 4 GiB (its own, `maximum: 65536` in `pkg/wasmer_sdk_js.js`) and one of 2 GiB (`maximum: 32767`, what the programs declare) per process, so the fourth process memory fails with `RangeError: Out of memory` inside a worker, and the program never starts. Simulators share the Mac's memory, so a real device may allow even fewer.
  2. **Two SDK workers created in the same instant.** When the pool grows by two at once, one of them fails while loading its modules (its `error` event has no message, and none of its code runs). Loading the worker's code with `import()` from a small wrapper avoided it every time.
- **First workaround, tested in the iPadOS Simulator:** cap every shared memory at 512 MiB (`maximum: 8192`, by wrapping `WebAssembly.Memory` in the page and in the SDK's worker) **and** load the SDK worker through an `import()` wrapper. With both, Run works: `bash main.sh` asks for a name, greets, lists files and returns to the prompt, with 7 SDK workers. Either change alone still hangs.
- **But an exited process's memory is only released once the browser garbage collects it**, and the shell's worker holds the references while it runs. A loop that starts processes quickly (`for i in 1 2 3 4 5; do cat main.sh | head -1; done`) used up the budget at 512 MiB and at 256 MiB per process (failing after 26 and 34 reservations), and allocating garbage in the workers to prompt a collection didn't help. A 128 MiB reservation fits 34 times, so the total is about 4.3 GiB.
- **The fix (in `src/lib/runtime/appleMobile.js`, `wasmerWorker.apple.js` and `wasmer.js`, only on iPhone and iPad):**
  - the SDK's own memory, which the page creates, reserves at most 512 MiB;
  - each program's memory, which the SDK's workers create, reserves at most 64 MiB (programs start at 5 to 20 MB: Bash 8.5, `cat` 4.7, Python 20); if iOS still refuses, it retries with half, down to 16 MiB;
  - the SDK's workers load its script through `wasmerWorker.apple.js` (with `import()`), which also applies the 64 MiB cap there.

  Tested with the production build (`vite preview`) in the iOS and iPadOS 27.0 Simulators (7 Oct 2026): the Python project's Run (input, output, back to the prompt), Bash's `ls`, pipes, four rounds of the loop above (40 processes) followed by Python, and Python downloading on first use. A program that needs more than 64 MiB stops with its own error (`MemoryError` in Python, exit status 1) instead of hanging. Desktop browsers don't load any of it. On a real iPhone, Python worked, but Rust failed: rustc declares its own 1 GiB maximum, and in 64 MiB it couldn't load the standard library ("can't find crate for `std`"). So only memories that declare the default maximum (2 GiB or more, from programs built without a limit) are capped at 64 MiB; one that chose a smaller maximum keeps it, retrying with half only if iOS refuses. With that, rustc compiled and ran a program four times in a row in the iOS Simulator, followed by `ls` and Python. Not yet tried: C and C++, Go and the other toolchains.
- **Phone and tablet problems seen in the Simulators** (Phase 4):
  - iPhone: with the keyboard open, the terminal's last lines are hidden behind the keyboard's toolbar and Safari's address bar;
  - iPhone: tapping the terminal leaves the focus in the editor, so typing goes into `main.sh`, and the keyboard's Done button doesn't close the keyboard (the editor takes the focus back);
  - iPad: when the on-screen keyboard opens, the whole page scrolls up, and the toolbar (Run, Stop) and the editor go off screen;
  - the Linux terminal shows the wrapping bug below on the iPhone: part of a typed command lands on its own line.
- **Fixed (7 Oct 2026), tested in the iOS and iPadOS 27.0 Simulators:**
  - the app is sized and placed to the visual viewport (`lib/stores/viewport.svelte.js`), so the keyboard no longer covers it and the page doesn't scroll away; on a phone with the keyboard up, only the panel being typed in shows (and no status bar), so the terminal gets the whole space above the keyboard;
  - a finger drag scrolls the terminal (`lib/terminalTouch.js`; xterm.js 6 scrolls with the mouse wheel only), with momentum, and a tap focuses it; the page itself no longer bounces (`overscroll-behavior: none`);
  - iOS no longer zooms in when the editor or terminal gets the focus (their hidden inputs are 16px);
  - Run scrolls the terminal to its end, and on a phone typing in the editor, moves the keyboard to the terminal.

- **Also fixed (7 Oct 2026):**
  - long commands wrap: the shell's environment has a termcap entry for xterm (`TERMCAP` in `runtime/shell.js`), so Bash's line editor can move the cursor up instead of scrolling the line sideways;
  - the editor wraps long lines on phones (and drops the folding arrows and narrows the line numbers);
  - a key bar (`components/KeyBar.svelte`) above the on-screen keyboard while a terminal has the focus: Esc, Tab, a sticky Ctrl (then a letter), Ctrl+C, the arrows, `|`, `~`, `/` and `-`. Its taps keep the focus in the terminal, so the keyboard stays up;
  - Ctrl+C at the prompt drops the half-typed line and shows a new prompt, as in a native terminal (Bash at its prompt doesn't get SIGINT under WASIX). This was broken on every platform.

  Still open: `less` (and so `man` and `git log`) doesn't return to the prompt after `q`, on every platform, with or without the termcap entry.
- **Safari 27 or later is required** (`docs/limitations.md`), because of the Wasmer SDK. A device on iOS or iPadOS 26 or earlier is expected to fail, whatever else is true.
- **A separate bug, on every platform (fixed 7 Oct 2026, see above):** a command wider than the terminal shows up as `<ustc main.rs -o main && ./main`, printed twice. Bash's line editor scrolls the line sideways because it can't find a description of the terminal (`TERM=xterm-256color`, but the sandbox has no terminfo or termcap entry for it), and `bind 'set horizontal-scroll-mode off'` doesn't help. It shows on phones because their terminals are about 40 columns wide. It doesn't depend on the rest of this plan, so it can be fixed now (see Phase 4).
- **The Wasmer SDK** (the runtime behind the sandbox) is tested in Playwright's WebKit, and its README mentions Safari 27 and later. It uses WebAssembly JSPI (`WebAssembly.Suspending`, `WebAssembly.promising`), `Atomics.waitAsync`, `SharedArrayBuffer` and a Web Worker per process.
- **The layout follows the window's width**, not the device: breakpoints at 760 px (`App.svelte`, `TopBar.svelte`, `StatusBar.svelte`) and 900 px (`LinuxWorkspace.svelte`), and larger touch targets under `pointer: coarse`. Nothing reads the user agent, so iPad Safari identifying itself as a Mac ("desktop-class browsing") doesn't change what Opcode does. A full-screen iPad gets the desktop layout; an iPad in Split View or Slide Over gets the phone layout.
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
| H1 | Starting any second program fails (a new worker, its shared memory, or JSPI) | Bash itself runs; the programs it starts don't | In the terminal: `ls`, `cat /etc/os-release`, `lua -v`. If even `ls` hangs, it's H1. |
| H2 | Big programs exceed the device's limits (memory for compiling, executable memory, or the tab's memory budget) | Python and Rust are large | Small programs work and big ones hang; Web Inspector's memory timeline climbs; Safari reloads the page ("using significant memory"); an iPad with more memory gets further than an iPhone |
| H3 | A WebAssembly or JavaScript feature is missing or behaves differently in that WebKit (JSPI, `Atomics.waitAsync`, exceptions, shared memory) | The SDK needs Safari 27 or later and relies on newer features | The iOS or iPadOS version first: below 27, this is the answer. Then the capability probe below, and errors in a worker's console in Web Inspector. |
| H4 | Something blocks the page's main thread | "Everything freezes" | Web Inspector → Timelines: long tasks on the main thread while Run hangs |
| H5 | Cross-origin isolation from the service worker (how GitHub Pages gets it) behaves differently in Safari, for workers in particular | GitHub Pages can't send the headers; `coi-serviceworker.js` adds them. `f43cd38` (on `main`) makes the page wait until the service worker is active before its one reload. In Chrome, first visits were isolated with and without that change (8 of 8 each, also on a throttled connection), so whether Safari needed it is part of this check. | Compare one device on GitHub Pages with a server that sends real headers (the Docker image behind a tunnel, or Cloudflare's proxy in front of GitHub Pages, see Phase 2); check `crossOriginIsolated` in the page and in its workers |
| H6 | The page was on plain HTTP | ⓘ in the address bar | Retest on `https://opcode-dev.com` |

## Setting up the Mac

- **Safari:** Settings → Advanced → *Show features for web developers*. The Develop menu then lists the Mac, the Simulators and connected devices, and Web Inspector shows each page's console, network, timelines and memory, and its workers (pick one in the console's context menu).
- **Automating Safari on the Mac:** `safaridriver --enable` once (it asks for an administrator's password), then any WebDriver client can drive Safari in a separate automation window. This runs the checks above in Safari 27 without a device.
- **iOS and iPadOS Simulators:** they come with Xcode (from the App Store), plus the iOS platform (Xcode → Settings → Components → iOS, which covers iPadOS too). If `xcode-select -p` prints `/Library/Developer/CommandLineTools`, point it at Xcode with `sudo xcode-select -s /Applications/Xcode.app`. Then:
  - `xcrun simctl list devices available` shows the iPhones and iPads installed; boot one of each with `xcrun simctl boot "<name>"`;
  - `open -a Simulator`, then `xcrun simctl openurl booted https://opcode-dev.com` (or `http://localhost:5173`: the Simulators' Safari treats `localhost` as secure, so the dev server works as is).

  They run iOS's and iPadOS's WebKit but not a device's memory limits, so they find engine bugs, not memory ones. The iPad Simulator also tests the layout in Split View and Stage Manager, and a hardware keyboard (the Mac's, through I/O → Keyboard → Connect Hardware Keyboard).
- **iPhone and iPad:** Settings → Apps → Safari → Advanced → *Web Inspector* on; connect by cable and trust the Mac. Note the model and the iOS or iPadOS version.
- **Serving to a device over HTTPS** (Opcode needs a secure page):
  - The dev server through a tunnel: `npm run dev -- --host`, then `cloudflared tunnel --url http://localhost:5173` prints an `https://…trycloudflare.com` address. The headers Opcode needs pass through.
  - The production server, which also tests H5: `npm run build && npm run build:preview-host && node scripts/precompress.mjs && npm start`, then the tunnel to port 8080.
  - Or a local certificate (mkcert) trusted on the device.
- **Playwright's WebKit**, for automated runs: `npx playwright install webkit`, then `webkit` projects in `playwright.config.js` using `devices['iPhone 15']` and `devices['iPad Pro 11']` (WebKit with the device's screen, touch and user agent, but not its memory limits, and a newer WebKit than the one on any given device).

## Phase 1: make failures visible

Before guessing, give every device a way to say what went wrong.

- **A diagnostics log**, turned on with `?debug` in the address: runtime events with times, shown on the page with a *Copy* button, so a phone or tablet can report without a Mac attached:
  - workers created and their errors;
  - toolchain downloads and WebAssembly compiles, with sizes and durations;
  - programs started and exited;
  - unhandled errors and failed memory allocations.

  The places to hook in are `src/lib/runtime/ProjectSandbox.svelte.js`, `Shell.svelte.js`, `toolchains.js` and `wasmer.js`.
- **A capability probe**, on the debug page or as `public/diagnostics.html`:
  - browser and iOS or iPadOS version, `crossOriginIsolated`, `SharedArrayBuffer`, `Atomics.waitAsync`;
  - JSPI (`WebAssembly.Suspending`, `WebAssembly.promising`);
  - WebAssembly threads, SIMD, exceptions and tail calls, each tested with a tiny module;
  - how many shared memories of 256 MB, 1 GiB and 4 GiB it can create;
  - how long a mid-sized module (Go's 39 MB) takes to compile;
  - `navigator.hardwareConcurrency` and `navigator.storage.estimate()`.
- **An unsupported-browser message**: when the probe finds a feature the runtime needs missing (on a Safari older than 27, for example), say so on the start screen ("Opcode needs iOS 27 or later; update in Settings → General → Software Update") instead of starting a terminal that will hang.
- **No silent hangs**: when a program can't start (a worker error, a failed compile, out of memory), print the error in the terminal and go back to the prompt. This helps every browser, not only Safari.

Done when an iPhone and an iPad show, on screen, why Run hangs.

## Phase 2: reproduce and find the cause

Work from the fastest loop to the slowest, running the checks for H1 to H6 on each and recording the results in this file:

1. Safari on the Mac.
2. Safari in the iOS Simulator, then the iPadOS Simulator.
3. A real iPhone and a real iPad, with Web Inspector.
4. Playwright's WebKit, locally and then in CI.

Then follow the result:

- **Fails in Safari on the Mac too:** an engine difference. Find the failing call (JSPI, `Atomics.waitAsync`, worker startup, shared memory). Check the Wasmer SDK's issues and newer versions. Work around it in Opcode: the SDK's build is already adjusted in `vite.config.js` (`copyWasmerSdk`), so a small patch or polyfill can go there too. Report it upstream with a minimal reproduction.
- **Fails only on devices:** a limit. Compare iPhone and iPad: what runs on one and not the other is memory. Measure each toolchain's peak memory, then reduce it where possible:
  - ask for smaller memory maximums;
  - drop downloaded bytes and compiled modules once they're used;
  - compile while streaming instead of buffering.

  Mark what still doesn't fit as unavailable on that device.
- **Fails only on GitHub Pages (H5):** fix the service worker's isolation for workers. Failing that, serve the site with real headers so no service worker is needed:
  - put Cloudflare's proxy in front of GitHub Pages (move `opcode-dev.com`'s DNS to Cloudflare and add a response-header rule for the two headers); GitHub keeps building and hosting the site, and Cloudflare also caches the large files;
  - or host on Netlify (which reads `public/_headers`) or Vercel (`vercel.json`), or run the Docker image.

  Not Cloudflare Pages: it limits files to 25 MiB, and several of Opcode's are larger (`docs/deploying.md`).

## Phase 3: fix, and fill in the support matrix

| | Safari (Mac) | iOS Simulator | iPadOS Simulator | iPhone (model, iOS) | iPad (model, iPadOS) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Start screen, editor, terminal (Bash) | Works | Works with the fix (before it, later processes never started) | Same as iOS | | | 27.0 Simulators, 7 Oct 2026 |
| Python | | Works with the fix (up to 64 MiB) | Works with the fix | | | |
| JavaScript (Node.js), TypeScript | | | | | | |
| Web page and preview | | | | | | |
| SQL, Lua, Bash | | | | | | |
| C and C++ | | | | | | Clang is 76 MB |
| Java, C#, Go, Ruby, PHP, R | | | | | | |
| Rust | | | | | | 95 MB, up to 1 GiB of memory |
| Linux machine | | Boots, runs commands | | | | 256 MB guest |
| Docker machine | | | | | | 1 GB guest: likely too big for a phone |
| Split View and Stage Manager | — | — | | — | | iPad only |
| Hardware keyboard (Ctrl+C, Esc, arrows) | | | | | | |

Whatever can't run on a device shows a clear message on its start-screen card and in the terminal ("needs more memory than this device allows") instead of Run hanging.

## Phase 4: make it pleasant on a phone and a tablet

These help Android phones and tablets too.

- **Wrap long commands** (doesn't depend on the rest; can be done now): give Bash a terminal description so its line editor wraps instead of scrolling sideways. For example, a `TERMCAP` entry for xterm in the shell's environment (`src/lib/runtime/shell.js`), if the sandbox's Bash reads termcap, or a terminfo entry in the sandbox. Check it on a 40-column terminal.
- **A key bar above the on-screen keyboard**: Esc, Tab, Ctrl (sticky, for Ctrl+C), the arrows, `|`, `~` and `/`. Hide it while a hardware keyboard is in use (an iPad with a Magic Keyboard), and show it again when the on-screen keyboard comes back.
- **Hardware keyboards on iPad**: check that Ctrl+C, Ctrl+D, Esc, Tab and the arrows reach xterm.js and Monaco rather than iPadOS, and which Cmd shortcuts iPadOS keeps for itself. Keyboards without an Esc key need another way to send it (the key bar, or Cmd+.).
- **The keyboard and the layout**: use `visualViewport` to keep the terminal's input line visible when the keyboard opens (including iPad's floating keyboard). Don't resize the terminal while a program waits for input: on WASIX, a resize interrupts the read.
- **Window size changes on iPad**: Split View, Slide Over and Stage Manager move the window across the 760 px breakpoint. Check that switching between the desktop and phone layouts keeps the open project, the terminal and its running program.
- **Typing**: no autocorrect, autocapitalization or smart punctuation in the terminal or the editor (check xterm.js's input element and Monaco on iOS and iPadOS).
- **Memory**: keep one project's sandbox alive at a time on phones, and release it when switching projects. iPads may afford more; decide from Phase 2's measurements.

## Phase 5: keep it working

- `webkit-iphone` and `webkit-ipad` projects in `playwright.config.js`, with a quick subset of the end-to-end tests: the start screen, Python, Bash and a Linux machine booting. Add a CI job for them next to the Chromium one.
- A checklist for testing on a real iPhone and iPad, in `docs/development.md`.
- The support matrix in `docs/limitations.md`, replacing the current "Browsers" line.
