# C# toolchain

C# projects run on .NET 8's runtime for WASI (Mono, interpreting .NET code)
inside the project's sandbox, so programs use the real terminal:
`Console.ReadLine()` reads what you type.

`dotnet run` in the shell (see `src/lib/runtime/shell.js`) runs
`dotnet-wasm csharp run`: `dotnet-wasm` is the runtime (`dotnet.wasm`) and
`csharp` is Opcode's runner (`runner/Program.cs`, built into `csharp.dll`):

1. It collects the folder's `.cs` files, as an SDK-style project does
   (`bin/` and `obj/` aside), and compiles them with Roslyn, the C#
   compiler, with what `dotnet new console` projects use: the latest C#
   version, implicit usings and nullable reference types.
2. It prints errors and warnings as `dotnet build` does
   (`Program.cs(3,9): error CS0029: …`).
3. It loads the program into its own process and runs it. Unhandled
   exceptions are reported as .NET reports them.

`dotnet build` stops after step 2; `dotnet new console` writes `Program.cs`
and a project file.

## Files

`scripts/fetch-csharp.mjs` (run by `npm run dev` and `npm run build`)
downloads pinned NuGet packages, checks their SHA-256, and writes
`public/toolchains/csharp/`:

- `dotnet.wasm.gz`: `runtimes/wasi-wasm/native/dotnet.wasm` from
  `Microsoft.NETCore.App.Runtime.Mono.wasi-wasm` 8.0.31 (.NET 8's WASI
  runtime is a WASI preview 1 program, which Wasmer runs; .NET 9 and later
  build WASI preview 2 components).
- `managed.tar.gz`, installed at `/managed` (the runtime looks for
  assemblies in `managed`, relative to the folder programs start in, which
  under WASIX is `/`): the class libraries from the same package, Roslyn
  (`Microsoft.CodeAnalysis.Common` and `.CSharp` 4.14.0 with
  `System.Collections.Immutable` and `System.Reflection.Metadata` 9.0.0),
  `System.Security.Cryptography.dll` from the browser-wasm runtime package
  (the WASI one throws on any use, and Roslyn needs hash algorithm names),
  and `csharp.dll`.

`csharp.dll` is committed; `./build-runner.sh` (or `npm run
build:csharp-runner`) rebuilds it with the .NET SDK.

## Limits

- The runtime has no thread pool or timers: `Task.Run`, `Task.Delay`,
  `Task.Yield` and other waits stop the program with an exception
  (`MissingMethodException`, `PlatformNotSupportedException`). Synchronous
  code works, and so does `await` on tasks that have already finished.
- No debug information (Roslyn computes it on the thread pool), so stack
  traces name methods but not lines.
- No networking and no NuGet packages: programs use the class libraries.
- Everything is interpreted: compiling takes a second or two, and loops
  run far slower than on .NET's JIT.

## Licenses

.NET (runtime and libraries) and Roslyn are MIT-licensed
(https://github.com/dotnet/runtime, https://github.com/dotnet/roslyn).
