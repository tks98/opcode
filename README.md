# Opcode

A browser IDE with a real terminal. Write and run **Python, web pages, JavaScript, TypeScript, Java, C#, C, C++, Rust, Go, Ruby, PHP, R, Lua, SQL and Bash** with nothing to install, or learn the Linux command line and Docker on a real Linux computer. Your code runs in the browser on WebAssembly, with no execution server.

Open it and pick a language: the starter program is one click on **Run** away. Every project gets its own Linux-like sandbox: a Bash shell with coreutils, your files in `~`, and real compilers and interpreters. Press **Run** and Opcode types the command for you (`python3 main.py`, `clang … && ./main`, `cargo run`, `dotnet run`), so you can see what happened, repeat it, or edit it yourself. Programs can read input (`input()`, `scanf`, `std::cin`, `Scanner`, `Console.ReadLine`, `gets`, `io.read`, `readline`, `fgets`), and **Stop** or **Ctrl+C** ends them.

## Features

- **Start screen**: pick a language (each card shows its starter program and how much it downloads), or carry on with a recent project. It opens on a first visit and from the logo; returning visitors go straight back to their last project
- **Real terminal**: Bash with pipes, redirection and history (↑), coreutils, `grep`, `sed`, `find`, `tar`, `less`, `stty`, and the `nano` editor, in [xterm.js](https://xtermjs.org/)
- **Run button**: runs the active file in the terminal; Ctrl/Cmd+Enter does the same
- **SQL**: `.sql` files run on SQLite and print their results as tables; `sqlite3` works in every terminal, for database files too
- **Web pages**: HTML, CSS and JavaScript projects. Run serves the folder (`serve` in the terminal) and opens the page in the preview, which updates as you type
- **`code <file>`** in the terminal opens (or creates) a file in the editor, like VS Code
- **Files stay in sync both ways**: edits go to the terminal immediately, and files the terminal creates, changes or deletes show up in the editor (compiled programs appear greyed out)
- **Folders**: nested folders, rename and move, drag-and-drop or upload files, ZIP import and export
- **Monaco editor**: VS Code's editor, with per-file undo history and syntax highlighting for dozens of languages
- **Internet access** (with a relay, see [Deploying](#internet-relay)): `pip install`, `git clone`, `curl` and API calls work from terminals and Linux machines. The status bar shows *Internet: on*/*off* and opens the settings.
- **Web preview**: start a server in the terminal (`python3 -m http.server`, `php -S localhost:8000`, a Node or Flask app, or `docker run -p 8080:80 nginx` on a Docker machine) and its page opens in a preview panel beside the editor. R's plots show there too. It follows the server as you stop and restart it, and `http://localhost:…` links in the terminal open there too. With a [wildcard preview host](#web-preview-host), every server gets its own address, so several can run and be previewed (or opened in their own tabs) at once.
- **Types like a native terminal**: type the next command while one runs, or paste several lines (even a `for` loop), and they run in order
- **Several terminals per project**: open more tabs with **+** (Ctrl+Shift+`); each has its own shell, directory and running program, and Run uses the active one
- **Multiple projects**: switch, rename and delete them from the project menu at the top; each keeps its own terminal sessions
- **Light and dark, and editor colours**: a notebook look by day and a blueprint by night (following your system until you choose), plus five colour themes for the editor and terminals, including two high-contrast ones. See [DESIGN.md](DESIGN.md)
- **Works on phones**: the files become a drawer, and Run stays in reach
- **Saved automatically**: projects and terminal history are stored in your browser (IndexedDB)

## Linux machines

Pick **Learn the Linux terminal** on the start screen to get a real Linux computer: Alpine Linux 3.24 with the Linux 6.18 kernel, running on the [v86](https://github.com/copy/v86) x86 emulator in your browser. It's made for learning the command line:

- **Real processes, users and permissions**: `ps`, `htop`, `kill`, signals and job control, `sudo`, `chmod`, `/proc`, `dmesg`
- **Familiar tools**: bash with tab completion, GNU coreutils, `grep`, `sed`, `awk`, `find`, `less`, `nano`, `vim`, `tmux`, `git`, `tar`, and man pages (`man ls`)
- **A built-in tutorial**: type `tutorial` for 12 hands-on lessons (navigation, hidden files, editing, permissions, pipes, processes, sudo, man pages). Each exercise is checked automatically.
- **Lessons panel**: a cheat sheet beside the terminal; click any command to type it
- **Starts in about 2 seconds**: the app ships a snapshot of the booted machine (~42 MB, downloaded once and cached)
- **Web preview**: a web server started in the machine (`python3 -m http.server` after `sudo apk add python3`, say) opens in the preview, as in other projects
- **Saved automatically**: the whole machine (files, history, even running programs) is stored in your browser and resumes where you left off. *Reset machine* starts fresh. Because the system runs from memory, `sudo reboot` also starts a fresh machine, as it would on a live USB stick.
- **Download and share machines**: *Download* saves the machine to an `.opcode-linux` file (a copy to keep, hand in, or share). *Open a file* (on the start screen, or in the *More* menu) opens one as a new project. A teacher can prepare a machine, put the file online, and share a link: `https://your-opcode-site/?machine=https://…/lab-1.opcode-linux` opens it for each student (the file's server must allow cross-origin requests; a file next to the app works with a relative path, `?machine=labs/lab-1.opcode-linux`). Files open in the same Opcode version's emulator they were saved with.

You log in as `student` (password `student`). With a relay set up (see [Deploying](#internet-relay)) the machine is online: `curl`, `git clone`, `ssh`, and `sudo apk add` for anything in Alpine's repositories. `ping` doesn't work (the relay carries TCP and UDP, not ICMP). The tutorial asks Opcode to save the machine after each lesson, and `opcode-save` does so from the command line.

## Docker

Pick **Learn Docker** on the start screen for a Linux machine with real Docker: Docker Engine 29 with its command line tools and Compose, on the same Alpine Linux system (with 1 GB of memory). It works like Docker on any Linux computer:

- **Containers and images**: `docker run`, `ps`, `logs`, `exec`, `stop`, `rm`, `images`, `pull`, `rmi`, volumes and networks. `hello-world`, `alpine`, `busybox` and `nginx:alpine-slim` come with the machine; online, `docker pull` gets more (32-bit x86, `linux/386`, images: most official images have them, Node.js's don't).
- **Building**: `docker build` with a Dockerfile (`~/hello-web` is an example), using Docker's classic builder. `sudo apk add docker-cli-buildx` adds BuildKit when online.
- **Networking**: containers get their own addresses on a bridge network, `-p 8080:80` publishes a port (`curl localhost:8080` reaches it), and containers reach the internet when the machine is online. The preview shows web servers in the machine, so `docker run -d -p 8080:80 nginx:alpine-slim` opens nginx's page next to the terminal.
- **Compose**: `docker compose up` (`~/compose-demo` has a two-service example).
- **A built-in tutorial**: `tutorial` teaches Docker in 11 checked lessons (running containers, images, ports, `exec`, building an image, volumes, Compose, cleaning up), and the lessons panel is a clickable cheat sheet.

The machine is saved, downloaded and shared like a Linux machine. Expect emulator speeds: starting a container takes about 10 seconds, and a Docker or Compose command a few. The first visit downloads about 140 MB (once, then cached).

## Languages

Toolchains download the first time a project needs them, then come from the browser's cache. Using a language's command in any project (say `node server.js` in a Python project) sets it up and then runs the command.

| Language | Run command | Toolchain | First download |
| --- | --- | --- | --- |
| Python | `python3 main.py` | CPython 3.13 ([`python/python`](https://wasmer.io/python/python)) | ~62 MB |
| C | `clang -std=c17 -Wall -o main main.c && ./main` | Clang 22 ([YoWASP](https://yowasp.org/)) | ~105 MB, shared with C++ |
| C++ | `clang++ -std=c++17 -Wall -o main main.cpp && ./main` | Clang 22 + libc++ | (shared) |
| Go | `go run main.go` | [Yaegi](https://github.com/traefik/yaegi) interpreter, built for WASI | ~8 MB |
| Rust | `rustc main.rs -o main && ./main`, or `cargo run` in a Cargo package | rustc 1.83 for WebAssembly ([`oligamiq/rust_wasm`](https://github.com/oligamiq/rust_wasm)), compiling to `wasm32-wasip1` | ~57 MB |
| JavaScript | `node main.js` | Node.js 24 API ([`wasmer/edgejs`](https://wasmer.io/wasmer/edgejs)) | ~93 MB |
| TypeScript | `tsc main.ts && node main.js` | TypeScript 6.0's `tsc` (in the browser) with Node's type definitions, then Node.js as above | ~3 MB, plus Node.js |
| Java | `javac Main.java && java Main` | javac 21 ([teavm-javac](https://github.com/konsoletyper/teavm-javac)) and the [Ristretto](https://github.com/theseus-rs/ristretto) JVM with Corretto 21's `java.base` ([`toolchains/java`](toolchains/java/README.md)) | ~17 MB |
| Ruby | `ruby main.rb` | Ruby 3.2 for WASI with its standard library ([VMware Wasm Labs](https://github.com/vmware-labs/webassembly-language-runtimes), via [`@antonz/ruby-wasi`](https://www.npmjs.com/package/@antonz/ruby-wasi)) | ~8 MB |
| C# | `dotnet run` (the folder's `.cs` files make one program) | C# 13: Roslyn 4.14 on .NET 8's runtime for WASI ([`toolchains/csharp`](toolchains/csharp/README.md)) | ~16 MB |
| PHP | `php main.php` | PHP 8.3 ([`php/php`](https://wasmer.io/php/php)) | ~86 MB |
| R | `Rscript main.R` (plots show in the preview); `R` starts the R console | R 4.6 on [webR](https://docs.r-wasm.org/webr/) (in the browser) | ~20 MB |
| Lua | `lua main.lua` | Lua 5.5, built for WASI from the official sources (`toolchains/lua`) | ~0.1 MB |
| SQL | `sqlite3 -box :memory: < main.sql` (a fresh database each run) | SQLite 3.53, built for WASI from the official amalgamation (`toolchains/sqlite`) | ~1 MB |
| Web page | `serve`, then the page opens in the preview | [static-web-server](https://static-web-server.net/) ([`wasmer/static-web-server`](https://wasmer.io/wasmer/static-web-server)) | ~5 MB |
| Bash | `bash main.sh` | Bash, coreutils, grep, sed, findutils, less, nano, tar ([`wasmer/*`](https://wasmer.io/wasmer)) | ~25 MB, always loaded |

**TypeScript**: `tsc` is the real TypeScript compiler, running in the browser on the project's files: its own options, `tsc --init`, `tsconfig.json` projects, error messages and exit codes. Without a `tsconfig.json`, files named on the command line compile with Node's settings (`--module nodenext --types node`), since programs run with `node`. Run uses `tsc main.ts && node main.js`, or `tsc -p` in a folder with a `tsconfig.json`.

**C#**: `dotnet run` compiles the folder's `.cs` files with Roslyn, the real C# compiler, as a `dotnet new console` project would (implicit usings, nullable reference types, top-level statements), prints errors as `dotnet build` does, and runs the program in the terminal, so `Console.ReadLine()` works. `dotnet build` only compiles, and `dotnet new console` starts a project.

**R**: `Rscript` runs a script in a fresh R with the project's files (so `read.csv("data.csv")` works and files it writes appear in the project), and its plots open in the preview. `R` starts R's console in the terminal, with line editing, history, `+` continuation lines and plots that update as you add to them; `q()` leaves it. `install.packages()` gets packages from the [webR repository](https://repo.r-wasm.org/) (the browser downloads them directly).

**Java**: `javac` compiles in the browser and writes real `.class` files (next to their sources, or under `-d`), with javac's own error messages; other sources in the folder that the given ones use are compiled too. `java` runs them on Ristretto, a JVM written in Rust, so programs read input with `Scanner`, use threads, records, streams and lambdas, and print the JDK's stack traces when they crash. Run uses `javac *.java` when a folder has several Java files.

In the terminal, `gcc`, `g++`, `cc` and `c++` work as aliases for Clang. C/C++ programs made of several files in one folder are compiled together.

**Rust**: `rustc` works as usual (it defaults to the 2021 edition and names the program after the source file), and a built-in `cargo` covers packages that use only the standard library: `cargo new`, `init`, `build`, `run`, `check`, `test` and `clean`, with `--release`, `--bin`, `src/lib.rs` + `src/main.rs` + `src/bin/*.rs`, Cargo's output and rebuilds only when sources change. Run uses `cargo run` for files in a Cargo package (`cargo test` for `src/lib.rs`) and `rustc` otherwise.

## Getting started

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm run preview` | Production build and local preview |
| `npm start` | Serve the production build as the Docker image does (see [Deploying](#deploying)) |
| `npm test` | Unit tests (Vitest) |
| `npm run check` | `svelte-check` |
| `npm run test:e2e` | End-to-end tests in Chromium (needs network; downloads real toolchains) |
| `npm run build:go` | Rebuild `public/toolchains/go.wasm.gz` (needs Go 1.22+) |
| `npm run fetch:rust` | Download the Rust toolchain again (`dev` and `build` fetch it when missing) |
| `npm run fetch:java` | Rebuild Java's runtime files from the pinned JDK (`dev` and `build` do it when missing) |
| `npm run build:ristretto` | Rebuild the `java` command (Ristretto for WASI; needs rustup) |
| `npm run build:linux` | Rebuild the Linux machine snapshot (needs root on Linux; see `toolchains/linux/`) |
| `npm run build:docker` | Rebuild the Docker machine snapshot (the same, with Docker) |

## How it works

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

## Deploying

### With Docker

The `Dockerfile` builds Opcode (downloading the toolchains the build needs) into an image whose server sends the headers Opcode needs, serves files compressed ahead of time (Clang's 76 MB compiler downloads as 17 MB), and can also be its internet relay and web preview host, all on one port:

```bash
docker build -t opcode .
docker run --rm -p 8080:8080 opcode
```

Then open http://localhost:8080. A first build takes a few minutes. The image is about 1.2 GB (a 500 MB download), mostly the toolchains and the Linux and Docker machines.

Browsers only run Opcode on secure pages. `http://localhost` counts, but other computers reaching the server at `http://` don't, so a server for others needs HTTPS in front of it. `compose.yaml` does that with [Caddy](https://caddyserver.com/), which gets certificates from Let's Encrypt. Point DNS for your domain and for `preview.` your domain at the server, open ports 80 and 443, then:

```bash
OPCODE_DOMAIN=opcode.example.com docker compose up -d
```

The image is configured with environment variables (`docker run -e`, or `environment:` in `compose.yaml`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | The port the server listens on |
| `OPCODE_RELAY` | `off` | `on` gives terminals and Linux machines internet access through a relay on this server, at `/wisp/` (read [Internet relay](#internet-relay) first). A `wss://` address uses that relay instead. With `off`, users can still pick a relay in the *Internet* settings. |
| `OPCODE_RELAY_ARGS` | | The built-in relay's options, as `scripts/wisp-server.mjs` takes them: `--max-streams 32 --via-proxy http://proxy:3128` |
| `OPCODE_RELAY_ORIGINS` | | Other sites whose pages may use the built-in relay (comma-separated). Pages of this site always may. |
| `OPCODE_PREVIEW_HOST` | Wasmer's host | Serve the [web preview host](#web-preview-host) here, to requests for that address: `https://preview.example.com/`, or `https://*.preview.example.com/` for one address per server (needs wildcard DNS and a wildcard certificate, which `compose.yaml`'s Caddy can't get by itself) |

Everything on one computer, with an address for each preview (Chrome and Firefox resolve every `*.localhost` name without DNS):

```bash
docker run --rm -p 8080:8080 -e OPCODE_RELAY=on -e OPCODE_PREVIEW_HOST='http://*.localhost:8080/' opcode
```

Behind a reverse proxy of your own, pass the `Host` header on (Caddy does; in nginx, `proxy_set_header Host $host`, plus the WebSocket upgrade headers for `/wisp/`), and serve Opcode at the root of its domain: the built-in relay answers DNS at `/dns-query`. The server is `scripts/server.mjs`; without Docker, `npm run build && npm run build:preview-host && node scripts/precompress.mjs && npm start` runs it the same way.

### Static hosting

`npm run build` produces a static site in `dist/` that works from any path. The runtime needs [cross-origin isolation](https://web.dev/articles/coop-coep) (`SharedArrayBuffer`), so the page must be served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- **Rust**: `npm run build` first downloads the Rust toolchain (`scripts/fetch-rust.mjs`: a pinned, checksummed release of [`oligamiq/rust_wasm`](https://github.com/oligamiq/rust_wasm), MIT OR Apache-2.0) into `public/toolchains/rust/` (not in git). It needs network access once; set up a cache of that folder for CI.
- **Java**: `npm run build` also builds Java's class library files (`scripts/fetch-java.mjs`) from a pinned, checksummed Amazon Corretto 21 JDK, downloaded once into `node_modules/.cache/opcode-java/` (about 210 MB; CI caches it).
- **Netlify / Cloudflare Pages**: `public/_headers` is included.
- **Vercel**: `vercel.json` is included.
- **GitHub Pages and other hosts without custom headers**: `coi-serviceworker.js` adds the headers on the first visit and reloads the page once.
- **Settings without rebuilding**: `dist/config.js` (from `public/config.js`) can set the internet relay and the web preview host, below, in place of the `VITE_*` variables the build reads.

### Internet relay

Browsers can't open network connections, so terminals and Linux machines tunnel theirs over a WebSocket to a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) relay, which makes the real connections and answers their DNS lookups (DNS-over-HTTPS at `/dns-query`). Without a relay, everything works except internet access. `scripts/wisp-server.mjs` is a small relay:

```bash
npm install
node scripts/wisp-server.mjs --port 8090 --origin https://your-opcode-site
# behind TLS (a reverse proxy, or a host such as Fly.io or Render), then build the app with:
VITE_WISP_URL=wss://relay.your-site/ npm run build
```

(or set `relay: 'wss://relay.your-site/'` in `config.js`; the Docker image can also run the relay itself, with `OPCODE_RELAY=on`).

It is an open relay for anyone who can reach it, so restrict `--origin` to your site and run it where outgoing traffic is acceptable. It refuses private and local addresses (your network, cloud metadata endpoints) and outgoing mail ports by default (`--allow-private`, `--block-ports 25,465,587`), and limits streams per connection (`--max-streams`). `--via-proxy http://proxy:3128` sends connections through an HTTP proxy. Students or teachers can also point a copy of Opcode at a relay in the *Internet* settings in the status bar (saved in their browser). `npm run relay` starts one locally on port 8090 for development (`VITE_WISP_URL=ws://localhost:8090/ npm run dev`).

The production build includes the Wasmer SDK's own dependency for this, the Wisp client [`@mercuryworkshop/wisp-js`](https://github.com/MercuryWorkshop/wisp-client-js) (AGPL-3.0 in the version the SDK uses), bundled as `wasmer-sdk/deps/wisp-client.js`.

### Web preview host

The preview reaches servers inside the sandbox through a service worker on a separate origin. A server owns that whole origin, so one origin can show one server at a time. By default Opcode uses Wasmer's `https://default.local.wasmer.site/`, which works like that.

To host your own, run `npm run build:preview-host` and deploy `dist-preview-host/` to an origin other than the app's (it includes `_headers`, and `.nojekyll` for GitHub Pages):

- **One origin** (one preview at a time): build the app with `VITE_PREVIEW_HOST=https://preview.example.com/ npm run build` (or set `previewHost` in `config.js`; the Docker image serves the host itself, with `OPCODE_PREVIEW_HOST`).
- **A wildcard origin** (one address per server, any number at once): serve the same files on every subdomain, with wildcard DNS and a wildcard certificate, and build with `VITE_PREVIEW_HOST=https://*.preview.example.com/ npm run build`. Each server gets a random name such as `https://p3k9x0q2m.preview.example.com/`. On Cloudflare, deploy `dist-preview-host/worker.js` as a Worker routed to `*.preview.example.com/*` (it holds the files itself).

`npm run preview-host` serves the host locally on port 5174, on `localhost` and every `*.localhost` subdomain, which Chrome resolves without DNS setup: `VITE_PREVIEW_HOST='http://*.localhost:5174/' npm run dev` gives per-server addresses in development (the Playwright tests use that).

Some files in the build are large: `llvm.core.wasm` (~76 MB), `linux-docker/opcode-docker.state.*` (three parts of up to 45 MB), `linux/opcode-linux.state` (~42 MB), `llvm-resources.tar` (~30 MB), `toolchains/rust/rustc.wasm.gz` (~30 MB) and `toolchains/rust/sysroot.tar.gz` (~27 MB). Hosts with a per-file size limit (Cloudflare Pages allows 25 MiB) can't serve them. Netlify, Vercel, GitHub Pages or your own server work. Enable compression for `.wasm` files.

## Limitations

- **Docker runs 32-bit x86 images** (`linux/386`), since the emulator is a 32-bit PC, and everything runs at emulator speed. Images are built with Docker's classic builder (also by `docker compose up --build`), so BuildKit features such as `RUN --mount` need `sudo apk add docker-cli-buildx` first.
- **Internet needs a relay**: without one (see [Internet relay](#internet-relay)), `pip install` and `git clone` can't reach the internet. Programs can still talk to each other over `localhost`, and the preview shows their web servers. Linux machines made before internet support keep working offline; *Reset machine* gives them a network card.
- **One web preview at a time without a wildcard host**: a preview origin serves one server at a time, shared by all tabs of the browser. The default (Wasmer's) host is a single origin; a self-hosted [wildcard host](#web-preview-host) lifts this.
- **Typing ahead is paced**: WASIX loses keys sent while a short command starts, so keys typed after Enter wait (up to 1.5 s) for the prompt, or for the program to ask for input, before they are sent.
- **Ctrl+C mostly stops programs rather than signalling them**: a Python script won't see `KeyboardInterrupt` (the REPL does), and `cleanup on SIGINT` handlers won't run.
- **C++ exceptions** aren't supported by the bundled C++ runtime; code is compiled with `-fno-exceptions`.
- **Go** runs on an interpreter. The standard library works, but third-party modules and `go build` don't.
- **Java** is Java 21 (javac is JDK 21's), and the JVM is Ristretto, not HotSpot: it interprets bytecode (a loop of 10 million steps takes about a second), and APIs that need native code it doesn't provide, such as Swing and other GUI classes, throw `UnsatisfiedLinkError`. Only `java.base` is included, so `java.sql`, `java.net.http` and other modules aren't available.
- **C#** runs .NET 8's class libraries on an interpreter (no JIT): no `Task.Run`, `Task.Delay` or other waiting (the runtime has no thread pool or timers), no NuGet packages or networking, and stack traces don't show line numbers.
- **R** scripts can't read keyboard input (`readline()` returns `""`, as in Rscript), and only packages built for webR install. Plots are PNG images (800×600).
- **Ruby** is 3.2, without `irb` (the build has no `io/console`); gems that need C extensions can't be installed.
- **Lua** has no `os.execute`, `io.popen` or temporary files (WASI doesn't provide them).
- **TypeScript**'s type errors show when `tsc` runs, not in the editor; the type definitions of packages in `node_modules` are used, but `npm install` itself depends on Node.js (Edge.js).
- **Rust** is 1.83 (no 2024 edition) and can't use crates from crates.io: the built-in `cargo` has no dependency resolution, and procedural macros can't be built. Programs abort on panic (no unwinding), so `cargo test` runs tests one at a time; its output arrives when the run ends.
- **WASIX quirks**: `rm -r` under WASIX skips some entries, so the shell's `rm` removes what it leaves one by one; appending with `>>` doesn't update a file's modification time. Exit statuses above 78 read as 79 (`(exit 101); echo $?` prints 79). If the shell itself ends that way, the terminal starts a new one in the same directory (what was running is lost).
- **Terminal size**: resizing interrupts programs waiting for input on WASIX, so a new size is applied when the shell returns to its prompt.
- **Web pages' console**: `console.log` and errors from a page show in the browser's developer tools (open the page in its own tab with ↗), not in Opcode's terminal.
- **Files the terminal creates that aren't text** (such as compiled programs) live only in the running session; they aren't saved or exported.
- **Browsers**: works in current Chrome, Edge and Firefox. Safari support depends on the Wasmer SDK (Safari 27+).

## Project structure

```
src/
├── App.svelte                  # Start screen ↔ coding screen, layout, shortcuts, import/export
├── app.css                     # Design tokens, buttons, menus (see DESIGN.md)
├── assets/fonts/               # Recursive Mono (built by scripts/make-mono-font.py), OFL
├── lib/
│   ├── languages.js            # Languages, toolchains, starters, run commands
│   ├── editorThemes.js         # Editor + terminal colour themes
│   ├── paths.js                # Project path helpers
│   ├── fileTree.js             # Sidebar tree builder
│   ├── persistence.js          # IndexedDB storage (+ localStorage migration)
│   ├── monaco.js               # Monaco setup
│   ├── stores/
│   │   ├── projects.svelte.js  # Projects, files, folders, tabs
│   │   ├── sessions.svelte.js  # Live terminal sessions (one per project)
│   │   ├── preview.svelte.js   # The web preview (one host origin per server)
│   │   ├── network.svelte.js   # Internet relay settings
│   │   └── theme.svelte.js     # Light/dark and the editor theme
│   ├── runtime/
│   │   ├── ProjectSandbox.svelte.js  # Sandbox, terminals, Run/Stop, sync, compiler bridge
│   │   ├── Shell.svelte.js     # One terminal tab's bash: input, Ctrl+C, restarts
│   │   ├── workspaceSync.js    # Two-way sync planning (pure)
│   │   ├── shell.js            # bashrc: prompt integration, watchdog, compiler commands
│   │   ├── tools.bash          # ~/.opcode/tools.sh: rustc, the built-in cargo, rm fixes
│   │   ├── toolchains.js       # Package downloads with progress
│   │   ├── compiler.js / clang.worker.js / compilerArgs.js  # C/C++ via YoWASP
│   │   ├── javac.js / javac.worker.js  # javac in the browser (TeaVM)
│   │   └── wasmer.js           # Wasmer client
│   └── components/             # StartScreen, TopBar, ProjectSwitcher, Sidebar, Editor, Terminal, …
│   ├── linux/                  # Linux and Docker machines: LinuxMachine (v86), saved snapshots, preview bridge
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
scripts/preview-host.mjs        # Builds/serves a self-hosted web preview host
scripts/wisp-server.mjs         # Internet relay (Wisp + DNS-over-HTTPS)
scripts/server.mjs              # Production server (the Docker image's): app, relay and preview host on one port
scripts/precompress.mjs         # Brotli and gzip copies of a build's files, for that server
Dockerfile, compose.yaml        # The deployment image, and a site with HTTPS (Caddy, deploy/Caddyfile)
LICENSE                         # Opcode's license: GNU AGPL-3.0 or later
THIRD_PARTY_NOTICES.md          # The other software Opcode includes and serves, its licenses and sources (texts in licenses/)
tests/                          # Vitest unit tests; tests/e2e: Playwright
```

## Keyboard shortcuts

- `Ctrl/Cmd + Enter`: run the active file
- `Ctrl + C` (in the terminal): stop the running program
- ``Ctrl + ` ``: show and focus the terminal
- ``Ctrl + Shift + ` ``: open another terminal
- `Ctrl/Cmd + S`: does nothing harmful (everything saves automatically)
- `Escape`: closes menus, dialogs and (on phones) the files drawer; arrow keys move through menus

## License

Copyright © 2026 tks98

Opcode is free software: you can use, study, change and share it under the terms of the [GNU Affero General Public License](LICENSE), version 3 or later. If you run a changed version of Opcode for other people, as a website for example, the license asks you to offer them its source code: the start screen links to it (`SOURCE_URL` in `src/lib/components/StartScreen.svelte`).

Opcode includes and serves other open source software, each under its own license: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
