[← Documentation](README.md)

# Limitations

- **Docker runs 32-bit x86 images** (`linux/386`), since the emulator is a 32-bit PC, and everything runs at emulator speed. Images are built with Docker's classic builder (also by `docker compose up --build`), so BuildKit features such as `RUN --mount` need `sudo apk add docker-cli-buildx` first.
- **Internet needs a relay**: without one (see [Internet relay](deploying.md#internet-relay)), `pip install` and `git clone` can't reach the internet. Programs can still talk to each other over `localhost`, and the preview shows their web servers. Linux machines made before internet support keep working offline; *Reset machine* gives them a network card.
- **One web preview at a time without a wildcard host**: a preview origin serves one server at a time, shared by all tabs of the browser. The default (Wasmer's) host is a single origin; a self-hosted [wildcard host](deploying.md#web-preview-host) lifts this.
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
- **less, more and editors**: WASIX connects no `/dev/tty`, where `less` reads its keys, so `less` and `more` are a small built-in pager (Space, b, j, k, g, G, `/` to find, q). Piped input (`seq 100 | less`) is printed whole instead, and programs that page (Python's `help()`) print too (`PAGER=cat`). The terminal has `nano`; there is no WebAssembly build of `vim` yet (the Linux machines have it).
- **Terminal size**: resizing interrupts programs waiting for input on WASIX, so a new size is applied when the shell returns to its prompt.
- **Web pages' console**: `console.log` and errors from a page show in the browser's developer tools (open the page in its own tab with ↗), not in Opcode's terminal.
- **Files the terminal creates that aren't text** (such as compiled programs) live only in the running session; they aren't saved or exported.
- **Browsers**: works in current Chrome, Edge, Firefox and Safari. Safari needs version 27 or later (iOS and iPadOS 27 on iPhone and iPad), for the Wasmer SDK.
- **iPhone and iPad** (every browser there uses Safari's engine): programs that don't set their own memory limit (most, including Bash and Python) can use up to 64 MiB, because iOS lets a page reserve only a few GiB of WebAssembly memory in all; a program that needs more stops with its own out-of-memory error. Rust's compiler sets its own (1 GiB) and keeps it. Python, Bash, Java and Rust are tested there; C and C++, Go and the others are not yet. See `docs/plans/ios.md`.
