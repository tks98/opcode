# Java in Opcode

Java runs entirely in the browser, as two commands in each project's terminal:

| Command | What it is | Where it runs | Files |
| --- | --- | --- | --- |
| `javac` | OpenJDK's Java compiler (JDK 21) built with [TeaVM](https://teavm.org) by [teavm-javac](https://github.com/konsoletyper/teavm-javac) | A Web Worker (`src/lib/runtime/javac.worker.js`); the shell forwards the command to it, like `clang` | `public/toolchains/java/javac.wasm.gz`, `javac-runtime.js` (in git), `javac-sdk.bin` (built) |
| `java` | [Ristretto](https://github.com/theseus-rs/ristretto), a JVM written in Rust, built for WASI with `ristretto.patch` | The project's sandbox, as a regular WASI program, so input, output, Ctrl+C and exit codes behave as for any command | `public/toolchains/java/java.wasm.gz` (in git), `jdk.tar.gz` (built) |

`javac` compiles against the API of the same JDK `java` runs with (Amazon Corretto 21's `java.base`), so code that compiles finds those classes at run time. `javac` writes real `.class` files next to their sources (or under `-d`), and compiles other sources in the same folder that the given ones use.

## Building

- `scripts/fetch-java.mjs` (run by `npm run dev` and `npm run build`) downloads the pinned Corretto JDK once and builds `jdk.tar.gz` (a slim JDK home: `java.base`'s classes, time zone, security and configuration files) and `javac-sdk.bin` (the API of `java.base`'s exported packages with method bodies removed by `classfile.mjs`).
- `build-ristretto.sh` (`npm run build:ristretto`) rebuilds `java.wasm.gz` from a pinned Ristretto commit with `ristretto.patch` (see the script for what the patch changes). It needs rustup.
- `javac.wasm.gz` is teavm-javac's `compiler.wasm` (gzip), and `javac-runtime.js` its TeaVM runtime, from <https://teavm.org/playground/> (sha256 `a79245353ac623df4fde5740bb2bedacedc9c98544253f01aa4b63268f9cb8ba` and `75b2b94394f162c384d42d540836375cdbb0207e6e5605b92a18ce56eb158741`).

## Licenses

- Ristretto: Apache-2.0 or MIT.
- teavm-javac and TeaVM: Apache-2.0. The compiler inside is OpenJDK's javac: GPLv2 with the Classpath Exception (source: <https://github.com/openjdk/jdk>).
- Amazon Corretto (the class library in `jdk.tar.gz` and `javac-sdk.bin`): GPLv2 with the Classpath Exception (source: <https://github.com/corretto/corretto-21>).
