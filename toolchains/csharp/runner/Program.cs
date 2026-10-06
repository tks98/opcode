// Opcode's `dotnet run` and `dotnet build` (see toolchains/csharp/README.md):
// compile the C# files of the current folder with Roslyn, the C# compiler,
// then run the program in this process. Runs on .NET 8's runtime for WASI,
// which loads assemblies from /managed.
//
//   csharp run [args...]   compile, then run with args
//   csharp build           compile only

using System.Reflection;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

const string Managed = "/managed";

// The runtime looks for assemblies in "managed", relative to the folder it
// started in (/); programs run in the shell's folder ($PWD).
AssemblyLoadContext.Default.Resolving += (context, name) =>
{
    var path = Path.Combine(Managed, $"{name.Name}.dll");
    return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
};
var pwd = Environment.GetEnvironmentVariable("PWD");
if (!string.IsNullOrEmpty(pwd)) Directory.SetCurrentDirectory(pwd);

var command = args.Length > 0 ? args[0] : "run";
var programArgs = args.Skip(1).SkipWhile((arg, i) => i == 0 && arg == "--").ToArray();

// The project's files, as an SDK-style project includes them.
var sources = Directory.EnumerateFiles(".", "*.cs", SearchOption.AllDirectories)
    .Select(path => Path.GetRelativePath(".", path))
    .Where(path => !path.Split(Path.DirectorySeparatorChar).Any(part => part is "bin" or "obj"))
    .OrderBy(path => path, StringComparer.Ordinal)
    .ToList();
if (sources.Count == 0)
{
    Console.Error.WriteLine("Couldn't find a project to run: there are no .cs files in this folder.");
    return 1;
}

// What `dotnet new console` projects use: implicit usings and nullable checks.
var options = new CSharpParseOptions(LanguageVersion.Latest);
var trees = sources.Select(path => CSharpSyntaxTree.ParseText(SourceText.From(File.ReadAllText(path), System.Text.Encoding.UTF8), options, path)).ToList();
trees.Add(CSharpSyntaxTree.ParseText(SourceText.From(
    "global using global::System; global using global::System.Collections.Generic; global using global::System.IO; global using global::System.Linq; global using global::System.Net.Http; global using global::System.Threading; global using global::System.Threading.Tasks;",
    System.Text.Encoding.UTF8), options, "ImplicitUsings.g.cs"));
var references = Directory.EnumerateFiles(Managed, "*.dll")
    .Where(path => !Path.GetFileName(path).StartsWith("Microsoft.CodeAnalysis") && Path.GetFileName(path) != "csharp.dll")
    .Select(path => MetadataReference.CreateFromFile(path));
var compilation = CSharpCompilation.Create(
    Path.GetFileName(Directory.GetCurrentDirectory()) is { Length: > 0 } name ? name : "program",
    trees, references,
    new CSharpCompilationOptions(OutputKind.ConsoleApplication, nullableContextOptions: NullableContextOptions.Enable, concurrentBuild: false, optimizationLevel: OptimizationLevel.Debug));

// (No debug information: Roslyn computes it on the thread pool, which .NET
// for WASI doesn't have. Stack traces name methods but not lines.)
using var image = new MemoryStream();
var result = compilation.Emit(image);
var shown = result.Diagnostics.Where(d => d.Severity >= DiagnosticSeverity.Warning && !d.IsSuppressed).ToList();
foreach (var diagnostic in shown)
{
    var color = diagnostic.Severity == DiagnosticSeverity.Error ? "\u001b[31m" : "\u001b[33m";
    Console.Error.WriteLine($"{color}{diagnostic}\u001b[0m");
}
if (!result.Success)
{
    var errors = shown.Count(d => d.Severity == DiagnosticSeverity.Error);
    Console.Error.WriteLine();
    Console.Error.WriteLine($"The build failed ({errors} error{(errors == 1 ? "" : "s")}). Fix the build errors and run again.");
    return 1;
}
if (command == "build")
{
    Console.WriteLine($"Build succeeded{(shown.Count > 0 ? $" with {shown.Count} warning{(shown.Count == 1 ? "" : "s")}" : "")}.");
    return 0;
}

var assembly = Assembly.Load(image.ToArray());
var entry = assembly.EntryPoint!;
try
{
    var value = entry.Invoke(null, entry.GetParameters().Length == 0 ? null : [programArgs]);
    Console.Out.Flush();
    return value is int code ? code : Environment.ExitCode;
}
catch (TargetInvocationException error) when (error.InnerException is not null)
{
    // As .NET reports it, without the frames of this runner's Invoke.
    Console.Out.Flush();
    var trace = error.InnerException.ToString().Split('\n').Where(line => !line.TrimStart().StartsWith("at System.Reflection."));
    Console.Error.WriteLine($"Unhandled exception. {string.Join('\n', trace)}");
    return 1;
}
