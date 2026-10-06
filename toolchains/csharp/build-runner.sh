#!/bin/bash
# Builds toolchains/csharp/csharp.dll (Opcode's `dotnet run`, see README.md)
# from runner/. Needs the .NET SDK (8 or later).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out" "$here/runner/bin" "$here/runner/obj"' EXIT
dotnet publish "$here/runner/csharp.csproj" -c Release -o "$out"
cp "$out/csharp.dll" "$here/csharp.dll"
echo "Wrote $here/csharp.dll; run node scripts/fetch-csharp.mjs to repack the toolchain."
