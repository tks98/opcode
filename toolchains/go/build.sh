#!/bin/bash
# Builds the `go` command used in Opcode's terminal: a Yaegi-based Go
# interpreter compiled to WASI. Output: public/toolchains/go.wasm.gz
# (gzip: 39 MB -> 8 MB; the app decompresses it in the browser).
set -euo pipefail

cd "$(dirname "$0")"

echo "Building go.wasm (GOOS=wasip1)..."
GOOS=wasip1 GOARCH=wasm go build -trimpath -ldflags="-s -w" -o go.wasm .

mkdir -p ../../public/toolchains
gzip -9 -n -c go.wasm > ../../public/toolchains/go.wasm.gz
rm go.wasm
ls -lh ../../public/toolchains/go.wasm.gz
