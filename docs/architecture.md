[← Documentation](README.md)

# How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/architecture-dark.svg">
  <img alt="How Opcode works: everything that runs code is in the browser" src="images/architecture-light.svg">
</picture>

Everything that runs code runs in the browser. The network only provides files (the app, toolchains, machine snapshots and the terminals' Wasmer packages, all from Opcode's own site) and, if set up, an internet relay and the web preview host ([Deploying](deploying.md)). The diagram is drawn by `docs/images/architecture.mjs`.

## Inside a project

```
 Editor (Monaco) ──edits──▶ project store ──IndexedDB
        ▲                        │ ▲
        │                 push   │ │ pull (after each command)
        │                        ▼ │
        │        ┌──── Wasmer sandbox (one per project) ─────┐
        │        │ /workspace  ◀── mirrors the project       │
 Terminal ◀────▶ │ bash, coreutils, grep, nano… (TTY)        │
 (xterm.js)      │ python3 · node · php · go (installed on   │
                 │ first use)                                │
                 └─────────▲─────────────────────────────────┘
                           │ clang/gcc/rustc request files
                 Clang 22 (YoWASP) in a Web Worker; rustc in the sandbox
```

- **Runtime**: [`@wasmer/sdk`](https://www.npmjs.com/package/@wasmer/sdk) runs WASIX packages from the Wasmer registry in Web Workers (`src/lib/runtime/ProjectSandbox.svelte.js`). Package versions are pinned in `src/lib/languages.js`.
- **Wasmer packages from Opcode's own site**: the SDK asks Wasmer's registry which version of a package (and of each package it depends on) to use, then downloads it from Wasmer's CDN. `src/lib/runtime/wasmerMirror.js` answers both requests from the site instead: `scripts/wasmer-packages.mjs` locks every package and dependency to one version and checksum in `wasmer-packages.lock.json`, and downloads them into `public/wasmer/` when the site is built. So the terminals keep working while wasmer.io is down, and a new release on Wasmer's side doesn't change what Opcode runs. `npm run lock:wasmer` updates the lock after changing `languages.js`.
- **Shell integration**: the shell's prompt emits OSC 133/7 escape sequences (like VS Code's terminal), so Opcode knows when a command starts and finishes and what the current directory is (`src/lib/runtime/shell.js`).
- **Ctrl+C**: under WASIX the terminal's SIGINT stops only some programs. Ctrl+C sends it first, so REPLs such as `python3` show `KeyboardInterrupt` and keep running, as natively. If the program ignores it, a watchdog started alongside each command (from `PS0`) kills the command's processes. In a loop, the stopped program fails and the shell's ERR trap signals bash itself (safe then, since bash isn't waiting for a process), so bash abandons the rest of the line as it does natively and keeps its variables. A small `stty` (`toolchains/stty`, built for WASIX's `tty_set`) restores echo if the stopped program had turned it off. Restarting the shell is left as a last resort. **Stop** kills right away.
- **No DEBUG trap**: commands are tracked from `PS0`, which bash expands once per command line. Under WASIX a DEBUG trap costs about 1 ms per command (loops ran ten times slower) and can crash bash.
- **C/C++**: the registry's Clang 16 hangs on libc++ headers, so C and C++ compile with [YoWASP Clang](https://github.com/YoWASP/clang) in a Web Worker instead. The shell's `clang`/`gcc` commands hand the job to it through files in `~/.opcode/host` (`src/lib/runtime/compilerArgs.js`, `clang.worker.js`).
- **Rust**: rustc 1.83 compiled to WebAssembly with LLVM and lld built in, so it links by itself, plus the standard library for `wasm32-wasip1`. The shell's `rustc` and `cargo` run `~/.opcode/tools.sh` (`src/lib/runtime/tools.bash`) as a bash process of their own, and it asks Opcode to start rustc in the sandbox through the same request files as Clang: bash starting this large multi-threaded program itself (fork, then exec) sometimes took the shell down under WASIX, and was three times slower. `cargo test` runs each test in its own process, from a shell Opcode starts, since test programs abort on panic.
- **Keeping the shell alive**: the interactive shell stays small: tools like `cargo` run as separate bash processes, and the shell waits for Opcode with one small helper (`toolchains/opcode-wait`) rather than loops around `sleep` (under WASIX each process has its own WebAssembly memory and Web Worker). WASIX reports any exit status above 78 as 79, so `tools.sh` hands its real one (cargo's 101) back through a file. If bash itself ends that way (a signal, say), the terminal starts a new shell in the same directory.
- **Sync**: `src/lib/runtime/workspaceSync.js` compares the editor, the sandbox and the last state both agreed on, so a change on one side is never overwritten by stale data from the other.
- **Ctrl+C at the prompt**: bash gets no SIGINT while it edits a line under WASIX, so Opcode does what a native terminal shows: it clears the line (Ctrl+E, Ctrl+U), prints `^C` and asks bash for a new prompt (`src/lib/runtime/Shell.svelte.js`).
- **Line editing**: the sandbox has no terminfo or termcap files, so the shell's environment carries a `TERMCAP` entry for xterm; with it, Bash's line editor wraps long commands instead of scrolling them sideways. Bracketed paste stays off, since Opcode sends a pasted block one line at a time.
- **less and more**: WASIX connects no `/dev/tty`, where `less` reads its keys, so `less` and `more` are a small pager in `tools.sh` that reads the terminal; programs that page get `PAGER=cat`.
- **Web preview**: the Wasmer SDK's `ports.expose()` routes requests from the preview frame through a service worker on a separate host origin into the sandbox (`src/lib/stores/preview.svelte.js`). A host origin routes one server at a time, so with a single host, connections take turns and each closes the last route first; a wildcard host gives every server its own origin. Linux and Docker machines answer the same requests through `src/lib/linux/httpBridge.js`.
- **Saving**: projects are saved to IndexedDB as you type. A write might not finish while the page closes, so the state is also written to `localStorage` then, and the newer copy wins on the next load (`src/lib/persistence.js`).
- **iPhone and iPad**: iOS lets a page reserve only a few GiB of shared WebAssembly memory in all, and the SDK reserves 4 GiB for itself and up to 2 GiB per process. On those devices only, `src/lib/runtime/appleMobile.js` caps the SDK's memory at 512 MiB and programs that don't set their own maximum at 64 MiB, and the SDK's workers start through `wasmerWorker.apple.js`, which applies the cap there and loads the SDK's worker script with `import()` (two workers loading it at once could fail). Details and measurements are in [the iPhone and iPad plan](plans/ios.md).
- **javac in Safari**: Safari can't list the imports of javac's WasmGC module, which TeaVM's loader asks for, so the javac worker reads them from the module's bytes (`src/lib/runtime/wasmImports.js`).
