[← Documentation](README.md)

# Languages

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
| Java | `javac Main.java && java Main` | javac 21 ([teavm-javac](https://github.com/konsoletyper/teavm-javac)) and the [Ristretto](https://github.com/theseus-rs/ristretto) JVM with Corretto 21's `java.base` ([`toolchains/java`](../toolchains/java/README.md)) | ~17 MB |
| Ruby | `ruby main.rb` | Ruby 3.2 for WASI with its standard library ([VMware Wasm Labs](https://github.com/vmware-labs/webassembly-language-runtimes), via [`@antonz/ruby-wasi`](https://www.npmjs.com/package/@antonz/ruby-wasi)) | ~8 MB |
| C# | `dotnet run` (the folder's `.cs` files make one program) | C# 13: Roslyn 4.14 on .NET 8's runtime for WASI ([`toolchains/csharp`](../toolchains/csharp/README.md)) | ~16 MB |
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
