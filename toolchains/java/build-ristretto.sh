#!/usr/bin/env bash
# Builds public/toolchains/java/java.wasm.gz, the `java` command: Ristretto
# (https://github.com/theseus-rs/ristretto, Apache-2.0 OR MIT), a JVM written
# in Rust, built for WASI preview 1 with ristretto.patch:
#
#   - no HTTP JDK downloads on WASI preview 1 (Wasmer has no wasi:http; Opcode
#     supplies the JDK at $RISTRETTO_JDK_HOME)
#   - the class path defaults to $CLASSPATH, then the current directory, and
#     is split without std::env::split_paths (unsupported on WASI)
#   - start in $PWD, so relative paths work
#   - flush stdout after each write (prompts appear before input is read)
#   - FileInputStream.available() works on standard input
#   - uncaught exceptions print as the JDK prints them
#
# Needs rustup (the toolchain is pinned by Ristretto's rust-toolchain.toml).
set -euo pipefail
COMMIT=8448588ecfcedf79a59d697939493f289c1c6ad7
here=$(cd "$(dirname "$0")" && pwd)
work=${RISTRETTO_WORK:-$(mktemp -d)}
git -C "$work" rev-parse 2>/dev/null || git clone https://github.com/theseus-rs/ristretto.git "$work"
cd "$work"
git fetch --depth 1 origin "$COMMIT" 2>/dev/null || true
git checkout --force "$COMMIT"
git apply "$here/ristretto.patch"
rustup target add wasm32-wasip1
cargo build --release -p ristretto_java --target wasm32-wasip1
gzip -9 -c target/wasm32-wasip1/release/java.wasm > "$here/../../public/toolchains/java/java.wasm.gz"
ls -l "$here/../../public/toolchains/java/java.wasm.gz"
