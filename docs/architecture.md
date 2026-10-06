[← Documentation](README.md)

# How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/architecture-dark.svg">
  <img alt="How Opcode works: everything that runs code is in the browser" src="images/architecture-light.svg">
</picture>

Everything that runs code runs in the browser. The network only provides files (the app, toolchains and machine snapshots, and packages from the Wasmer registry) and, if set up, an internet relay and the web preview host ([Deploying](deploying.md)). The diagram is drawn by `docs/images/architecture.mjs`.

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
- **Shell integration**: the shell's prompt emits OSC 133/7 escape sequences (like VS Code's terminal), so Opcode knows when a command starts and finishes and what the current directory is (`src/lib/runtime/shell.js`).
- **Ctrl+C**: under WASIX the terminal's SIGINT stops only some programs. Ctrl+C sends it first, so REPLs such as `python3` show `KeyboardInterrupt` and keep running, as natively. If the program ignores it, a watchdog started alongside each command (from `PS0`) kills the command's processes. In a loop, the stopped program fails and the shell's ERR trap signals bash itself (safe then, since bash isn't waiting for a process), so bash abandons the rest of the line as it does natively and keeps its variables. A small `stty` (`toolchains/stty`, built for WASIX's `tty_set`) restores echo if the stopped program had turned it off. Restarting the shell is left as a last resort. **Stop** kills right away.
- **No DEBUG trap**: commands are tracked from `PS0`, which bash expands once per command line. Under WASIX a DEBUG trap costs about 1 ms per command (loops ran ten times slower) and can crash bash.
- **C/C++**: the registry's Clang 16 hangs on libc++ headers, so C and C++ compile with [YoWASP Clang](https://github.com/YoWASP/clang) in a Web Worker instead. The shell's `clang`/`gcc` commands hand the job to it through files in `~/.opcode/host` (`src/lib/runtime/compilerArgs.js`, `clang.worker.js`).
- **Rust**: rustc 1.83 compiled to WebAssembly with LLVM and lld built in, so it links by itself, plus the standard library for `wasm32-wasip1`. The shell's `rustc` and `cargo` run `~/.opcode/tools.sh` (`src/lib/runtime/tools.bash`) as a bash process of their own, and it asks Opcode to start rustc in the sandbox through the same request files as Clang: bash starting this large multi-threaded program itself (fork, then exec) sometimes took the shell down under WASIX, and was three times slower. `cargo test` runs each test in its own process, from a shell Opcode starts, since test programs abort on panic.
- **Keeping the shell alive**: the interactive shell stays small: tools like `cargo` run as separate bash processes, and the shell waits for Opcode with one small helper (`toolchains/opcode-wait`) rather than loops around `sleep` (under WASIX each process has its own WebAssembly memory and Web Worker). WASIX reports any exit status above 78 as 79, so `tools.sh` hands its real one (cargo's 101) back through a file. If bash itself ends that way (a signal, say), the terminal starts a new shell in the same directory.
- **Sync**: `src/lib/runtime/workspaceSync.js` compares the editor, the sandbox and the last state both agreed on, so a change on one side is never overwritten by stale data from the other.
