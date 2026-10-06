// Language and toolchain registry. Everything Opcode knows about a language
// (how to recognise it, highlight it, start a project with it, and run a
// file from the terminal) lives here so the rest of the app stays generic.

import { basename, dirname, extname, joinPath, stem } from './paths.js'
import { MACHINES, machineKindOf } from './linux/machines.js'

/**
 * Toolchains are WASIX packages installed into a project's sandbox on first
 * use. Versions are pinned so a registry update cannot change behaviour.
 */
export const TOOLCHAINS = {
  python: { name: 'Python 3.13', packages: ['python/python@=3.13.20'], commands: ['python', 'python3'], sizeMB: 62 },
  // C/C++ compile in a Web Worker with YoWASP's Clang (see runtime/compiler.js);
  // the shell's clang/gcc commands forward to it.
  clang: { name: 'Clang 22 (C/C++)', host: 'clang', sizeMB: 105 },
  node: { name: 'Node.js 24 (Edge.js)', packages: ['wasmer/edgejs@=0.2.5'], commands: ['node', 'npm', 'npx'], sizeMB: 93 },
  php: { name: 'PHP 8.3', packages: ['php/php@=8.3.403'], commands: ['php'], sizeMB: 86 },
  // A small static file server for web pages (the shell's `serve` command).
  web: { name: 'Web server', packages: ['wasmer/static-web-server@=2.44.0'], commands: ['static-web-server', 'webserver'], sizeMB: 5 },
  // The sqlite3 shell, built from the official amalgamation for WASI
  // (toolchains/sqlite/build.mjs).
  sqlite: { name: 'SQLite 3.53', wasm: 'toolchains/sqlite3.wasm.gz', command: 'sqlite3', commands: ['sqlite3', 'sqlite'], sizeMB: 1 },
  // Java 21: Ristretto, a JVM written in Rust, built for WASI, runs programs
  // with a slim Corretto java.base (toolchains/java). javac is the OpenJDK
  // compiler built with TeaVM, running in a Web Worker (runtime/javac.js).
  java: {
    name: 'Java 21',
    java: { runtime: 'toolchains/java/java.wasm.gz', jdk: 'toolchains/java/jdk.tar.gz' },
    commands: ['java'],
    sizeMB: 13,
    requires: ['javac'],
  },
  javac: { name: 'javac', host: 'javac', sizeMB: 4 },
  // C# 13: Roslyn (the C# compiler) on .NET 8's runtime for WASI, with the
  // class libraries (fetched by scripts/fetch-csharp.mjs). The shell's dotnet
  // command compiles the folder's .cs files and runs the program in one go
  // (toolchains/csharp).
  csharp: {
    name: 'C# 13 (.NET 8)',
    dotnet: { runtime: 'toolchains/csharp/dotnet.wasm.gz', managed: 'toolchains/csharp/managed.tar.gz' },
    commands: ['dotnet-wasm'],
    sizeMB: 16,
  },
  // TypeScript 6.0's tsc in a Web Worker (runtime/tsc.js), with Node's type
  // definitions; node runs what it writes.
  typescript: { name: 'TypeScript 6.0', host: 'tsc', sizeMB: 3, requires: ['node'] },
  go: { name: 'Go (Yaegi interpreter)', wasm: 'toolchains/go.wasm.gz', command: 'go', commands: ['go'], sizeMB: 8 },
  // Ruby 3.2 for WASI, standard library included (VMware Wasm Labs' build,
  // copied from npm by scripts/copy-npm-toolchains.mjs).
  ruby: { name: 'Ruby 3.2', wasm: 'toolchains/ruby.wasm.gz', command: 'ruby', commands: ['ruby'], sizeMB: 8 },
  // R 4.6 with webR (R compiled to WebAssembly) in the browser
  // (runtime/rlang.js); the shell's Rscript and R forward to it.
  r: { name: 'R 4.6 (webR)', host: 'r', sizeMB: 20 },
  // Lua, built from the official sources for WASI (toolchains/lua/build.mjs).
  lua: { name: 'Lua 5.5', wasm: 'toolchains/lua.wasm.gz', command: 'lua', commands: ['lua'], sizeMB: 1 },
  // rustc compiled to WebAssembly with LLVM and lld built in, plus the
  // standard library for wasm32-wasip1 (fetched by scripts/fetch-rust.mjs).
  // It runs in the sandbox, started by Opcode when the shell's rustc and
  // cargo functions ask (see runtime/rust.bash), so shells needn't restart.
  rust: {
    name: 'Rust 1.83',
    host: 'rust',
    rust: { compiler: 'toolchains/rust/rustc.wasm.gz', sysroot: 'toolchains/rust/sysroot.tar.gz' },
    sizeMB: 57,
  },
}

/** Where Java's runtime (a slim JDK home) is installed in sandboxes. */
export const JAVA_HOME = '/opt/java'

/** Where .NET's assemblies are installed: its runtime looks in "managed" of
 * the folder programs start in, which under WASIX is /. */
export const DOTNET_MANAGED = '/managed'

/** Where the Rust standard library is installed in sandboxes (rustc --sysroot). */
export const RUST_SYSROOT = '/opt/rust'
export const RUST_TARGET = 'wasm32-wasip1'

/**
 * The base system every sandbox starts with (~25 MB): bash with coreutils,
 * plus the everyday tools learners expect in a terminal. bash comes first.
 */
export const SHELL_PACKAGES = [
  'wasmer/bash@=1.0.25',
  'wasmer/grep@=3.12.0',
  'wasmer/sed@=4.9.0',
  'wasmer/findutils@=0.10.1',
  'wasmer/less@=685.0.1',
  'wasmer/nano@=8.7.1',
  'wasmer/tar@=1.35.0',
]

const PYTHON_STARTER = `# Welcome to Opcode! Press Run (or Ctrl+Enter) to try this program.

name = input("What's your name? ")
print(f"Hello, {name}!")

numbers = [1, 2, 3, 4, 5]
print("The sum of", numbers, "is", sum(numbers))
`

const C_STARTER = `// Welcome to Opcode! Press Run (or Ctrl+Enter) to compile and run.
#include <stdio.h>

int main(void) {
    char name[64];
    printf("What's your name? ");
    if (scanf("%63s", name) == 1) {
        printf("Hello, %s!\\n", name);
    }

    int sum = 0;
    for (int i = 1; i <= 5; i++) sum += i;
    printf("The sum of 1..5 is %d\\n", sum);
    return 0;
}
`

const CPP_STARTER = `// Welcome to Opcode! Press Run (or Ctrl+Enter) to compile and run.
#include <iostream>
#include <string>
#include <vector>

int main() {
    std::string name;
    std::cout << "What's your name? ";
    std::cin >> name;
    std::cout << "Hello, " << name << "!" << std::endl;

    std::vector<int> numbers{1, 2, 3, 4, 5};
    int sum = 0;
    for (int n : numbers) sum += n;
    std::cout << "The sum of 1..5 is " << sum << std::endl;
    return 0;
}
`

const GO_STARTER = `// Welcome to Opcode! Press Run (or Ctrl+Enter) to try this program.
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func main() {
	fmt.Print("What's your name? ")
	reader := bufio.NewReader(os.Stdin)
	name, _ := reader.ReadString('\\n')
	fmt.Printf("Hello, %s!\\n", strings.TrimSpace(name))

	sum := 0
	for _, n := range []int{1, 2, 3, 4, 5} {
		sum += n
	}
	fmt.Println("The sum of 1..5 is", sum)
}
`

const RUST_STARTER = `// Welcome to Opcode! Press Run (or Ctrl+Enter) to compile and run.
use std::io::{self, Write};

fn main() {
    print!("What's your name? ");
    io::stdout().flush().unwrap();
    let mut name = String::new();
    io::stdin().read_line(&mut name).unwrap();
    println!("Hello, {}!", name.trim());

    let numbers = vec![1, 2, 3, 4, 5];
    let sum: i32 = numbers.iter().sum();
    println!("The sum of {:?} is {}", numbers, sum);
}
`

const JS_STARTER = `// Welcome to Opcode! Press Run (or Ctrl+Enter) to try this program.
const readline = require("node:readline/promises");

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const name = await rl.question("What's your name? ");
  rl.close();
  console.log(\`Hello, \${name}!\`);

  const numbers = [1, 2, 3, 4, 5];
  console.log("The sum of", numbers, "is", numbers.reduce((a, b) => a + b, 0));
}

main();
`

const TS_STARTER = `// Welcome to Opcode! Press Run (or Ctrl+Enter) to compile and run.
// tsc checks the types and writes main.js, which node runs.
import * as readline from "node:readline/promises";

interface Pet {
  name: string;
  legs: number;
}

const pets: Pet[] = [
  { name: "cat", legs: 4 },
  { name: "bird", legs: 2 },
];

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const name = await rl.question("What's your name? ");
  rl.close();
  console.log(\`Hello, \${name}!\`);

  const legs = pets.reduce((sum, pet) => sum + pet.legs, 0);
  console.log(\`\${pets.length} pets have \${legs} legs.\`);
}

main();
`

const WEB_HTML_STARTER = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My web page</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <!-- Press Run to see this page. The preview updates as you type. -->
  <h1>Hello, world!</h1>
  <p>This page is made of three files: index.html, style.css and script.js.</p>
  <button id="button">Click me</button>
  <p id="message"></p>
  <script src="script.js"></script>
</body>
</html>
`

const WEB_CSS_STARTER = `/* Styles: how the page looks. Try another color! */
body {
  max-width: 40rem;
  margin: 3rem auto;
  padding: 0 1rem;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
  color: #1b2b4b;
  background: #f5f8fc;
}

h1 {
  color: #2f6fb5;
}

button {
  padding: 0.6rem 1.2rem;
  border: 2px solid #1b2b4b;
  border-radius: 10px;
  background: #ffd84d;
  font: inherit;
  font-weight: bold;
  cursor: pointer;
}
`

const WEB_JS_STARTER = `// Scripts: what the page does. This one counts clicks.
const button = document.getElementById("button");
const message = document.getElementById("message");
let clicks = 0;

button.addEventListener("click", () => {
  clicks += 1;
  message.textContent = "You clicked " + clicks + (clicks === 1 ? " time." : " times.");
});
`

const SQL_STARTER = `-- Welcome to Opcode! Press Run (or Ctrl+Enter) to run these statements.
-- Each run starts with an empty database, so you can run it again any time.

CREATE TABLE pets (
  name TEXT,
  kind TEXT,
  age INTEGER
);

INSERT INTO pets VALUES
  ('Biscuit', 'dog', 3),
  ('Mittens', 'cat', 5),
  ('Bubbles', 'fish', 1),
  ('Rex', 'dog', 7);

-- Which dogs do we have, youngest first?
SELECT name, age FROM pets WHERE kind = 'dog' ORDER BY age;

-- How many pets of each kind, and how old are they on average?
SELECT kind, COUNT(*) AS how_many, AVG(age) AS average_age
FROM pets
GROUP BY kind;
`

const JAVA_STARTER = `// Welcome to Opcode! Press Run (or Ctrl+Enter) to compile and run.
import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);
        System.out.print("What's your name? ");
        String name = input.nextLine();
        System.out.println("Hello, " + name + "!");

        int[] numbers = {1, 2, 3, 4, 5};
        int sum = 0;
        for (int n : numbers) sum += n;
        System.out.println("The sum of 1..5 is " + sum);
    }
}
`

const PHP_STARTER = `<?php
// Welcome to Opcode! Press Run (or Ctrl+Enter) to try this program.

echo "What's your name? ";
$name = trim(fgets(STDIN));
echo "Hello, $name!\\n";

$numbers = [1, 2, 3, 4, 5];
echo "The sum of 1..5 is " . array_sum($numbers) . "\\n";
`

const CSHARP_STARTER = `// Welcome to Opcode! Press Run (or Ctrl+Enter) to compile and run.
// dotnet run compiles the .cs files in this folder, then runs the program.

Console.Write("What's your name? ");
string name = Console.ReadLine() ?? "friend";
Console.WriteLine($"Hello, {name}!");

int[] numbers = [1, 2, 3, 4, 5];
Console.WriteLine($"The sum of 1..5 is {numbers.Sum()}");
`

const RUBY_STARTER = `# Welcome to Opcode! Press Run (or Ctrl+Enter) to try this program.

print "What's your name? "
name = gets&.chomp || "friend"
puts "Hello, #{name}!"

numbers = [1, 2, 3, 4, 5]
puts "The sum of 1..5 is #{numbers.sum}"
`

const R_STARTER = `# Welcome to Opcode! Press Run (or Ctrl+Enter) to try this program.
# Plots show up in the preview.

heights <- c(150, 162, 171, 168, 180, 175)
cat("Average height:", mean(heights), "cm\\n")
print(summary(heights))

pets <- data.frame(name = c("cat", "dog", "bird"), legs = c(4, 4, 2))
print(pets)

barplot(pets$legs, names.arg = pets$name, main = "Legs per pet", col = "#276dc3")
`

const LUA_STARTER = `-- Welcome to Opcode! Press Run (or Ctrl+Enter) to try this program.

io.write("What's your name? ")
local name = io.read("l") or "friend"
print("Hello, " .. name .. "!")

local numbers = {1, 2, 3, 4, 5}
local sum = 0
for _, n in ipairs(numbers) do
  sum = sum + n
end
print("The sum of 1..5 is " .. sum)
`

const SHELL_STARTER = `#!/bin/bash
# Welcome to Opcode! Press Run (or Ctrl+Enter) to try this script.

read -r -p "What's your name? " name
echo "Hello, $name!"

for file in *; do
  echo "Found: $file"
done
`

/**
 * Languages Opcode can run. `run` builds the shell command for a file; it
 * receives the file's path and every project file so compiled languages can
 * build multi-file programs.
 */
export const LANGUAGES = {
  python: {
    name: 'Python',
    color: '#2f6fb5',
    hint: 'A great first language',
    extensions: ['.py'],
    monaco: 'python',
    toolchain: 'python',
    starter: { path: 'main.py', content: PYTHON_STARTER },
    run: (path) => `python3 ${shellQuote(path)}`,
  },
  c: {
    name: 'C',
    color: '#6b7a99',
    hint: 'Close to the machine',
    extensions: ['.c', '.h'],
    monaco: 'c',
    toolchain: 'clang',
    starter: { path: 'main.c', content: C_STARTER },
    run: (path, files) => compileAndRun(path, files, ['.c'], 'clang -std=c17 -Wall'),
  },
  cpp: {
    name: 'C++',
    color: '#3e5fa8',
    hint: 'Fast, and used in games',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    monaco: 'cpp',
    toolchain: 'clang',
    starter: { path: 'main.cpp', content: CPP_STARTER },
    run: (path, files) => compileAndRun(path, files, ['.cpp', '.cc', '.cxx'], 'clang++ -std=c++17 -Wall'),
  },
  go: {
    name: 'Go',
    color: '#00897b',
    hint: 'Simple and easy to read',
    extensions: ['.go'],
    monaco: 'go',
    toolchain: 'go',
    starter: { path: 'main.go', content: GO_STARTER },
    run: (path, files) => {
      const dir = dirname(path)
      const siblings = files.filter((f) => f.path !== path && dirname(f.path) === dir && extname(f.path) === '.go' && !f.path.endsWith('_test.go'))
      return siblings.length > 0 ? `go run ${shellQuote(dir ? `./${dir}` : '.')}` : `go run ${shellQuote(path)}`
    },
  },
  rust: {
    name: 'Rust',
    color: '#b7410e',
    hint: 'Safe and fast, with cargo',
    extensions: ['.rs'],
    monaco: 'rust',
    toolchain: 'rust',
    starter: { path: 'main.rs', content: RUST_STARTER },
    run: rustRun,
  },
  javascript: {
    name: 'JavaScript',
    color: '#d9a400',
    hint: 'The language of the web',
    extensions: ['.js', '.mjs', '.cjs'],
    monaco: 'javascript',
    toolchain: 'node',
    starter: { path: 'main.js', content: JS_STARTER },
    run: (path) => `node ${shellQuote(path)}`,
  },
  typescript: {
    name: 'TypeScript',
    color: '#3178c6',
    hint: 'JavaScript, with types',
    extensions: ['.ts', '.mts', '.cts'],
    monaco: 'typescript',
    toolchain: 'typescript',
    starter: { path: 'main.ts', content: TS_STARTER },
    run: typescriptRun,
  },
  csharp: {
    name: 'C#',
    color: '#7a3e9d',
    hint: 'Apps, and games with Unity',
    extensions: ['.cs'],
    monaco: 'csharp',
    toolchain: 'csharp',
    starter: { path: 'Program.cs', content: CSHARP_STARTER },
    // Like a .NET project, the folder's .cs files make one program.
    run: (path) => (dirname(path) ? `(cd ${shellQuote(dirname(path))} && dotnet run)` : 'dotnet run'),
  },
  java: {
    name: 'Java',
    color: '#e76f00',
    hint: 'Used in schools and Android apps',
    extensions: ['.java'],
    monaco: 'java',
    toolchain: 'java',
    starter: { path: 'Main.java', content: JAVA_STARTER },
    run: javaRun,
  },
  web: {
    name: 'Web page',
    color: '#c2255c',
    hint: 'Make your own website',
    extensions: ['.html', '.htm'],
    monaco: 'html',
    toolchain: 'web',
    starter: {
      path: 'index.html',
      content: WEB_HTML_STARTER,
      more: [
        { path: 'style.css', content: WEB_CSS_STARTER },
        { path: 'script.js', content: WEB_JS_STARTER },
      ],
    },
    // Run serves the project folder and opens the page in the preview.
    run: () => 'serve',
    preview: (path) => (basename(path) === 'index.html' && !path.includes('/') ? '/' : `/${path}`),
  },
  php: {
    name: 'PHP',
    color: '#5e6fa8',
    hint: 'Makes web pages',
    extensions: ['.php'],
    monaco: 'php',
    toolchain: 'php',
    starter: { path: 'main.php', content: PHP_STARTER },
    run: (path) => `php ${shellQuote(path)}`,
  },
  sql: {
    name: 'SQL',
    color: '#0e7490',
    hint: 'Ask questions of data',
    extensions: ['.sql'],
    monaco: 'sql',
    toolchain: 'sqlite',
    starter: { path: 'main.sql', content: SQL_STARTER },
    // A fresh in-memory database each run; results as tables.
    run: (path) => `sqlite3 -box :memory: < ${shellQuote(path)}`,
  },
  ruby: {
    name: 'Ruby',
    color: '#cc342d',
    hint: 'Friendly, made for programmers',
    extensions: ['.rb'],
    monaco: 'ruby',
    toolchain: 'ruby',
    starter: { path: 'main.rb', content: RUBY_STARTER },
    run: (path) => `ruby ${shellQuote(path)}`,
  },
  r: {
    name: 'R',
    color: '#276dc3',
    hint: 'Statistics and charts',
    extensions: ['.r'],
    monaco: 'r',
    toolchain: 'r',
    starter: { path: 'main.R', content: R_STARTER },
    run: (path) => `Rscript ${shellQuote(path)}`,
  },
  lua: {
    name: 'Lua',
    color: '#3949ab',
    hint: 'Small, and used in games',
    extensions: ['.lua'],
    monaco: 'lua',
    toolchain: 'lua',
    starter: { path: 'main.lua', content: LUA_STARTER },
    run: (path) => `lua ${shellQuote(path)}`,
  },
  shell: {
    name: 'Bash',
    color: '#3f7d3a',
    hint: 'Automate the command line',
    extensions: ['.sh', '.bash'],
    monaco: 'shell',
    toolchain: null,
    starter: { path: 'main.sh', content: SHELL_STARTER },
    run: (path) => `bash ${shellQuote(path)}`,
  },
}

/** Languages offered when creating a project, in display order. */
export const PROJECT_LANGUAGES = ['python', 'web', 'javascript', 'typescript', 'java', 'csharp', 'c', 'cpp', 'rust', 'go', 'ruby', 'php', 'r', 'lua', 'sql', 'shell']

/** The port `serve` (and so Run, for web pages) uses. */
export const WEB_PORT = 8080

/** Colour and name to show for a project. */
export function projectAppearance(project) {
  // A Linux project is a whole emulated computer rather than a code folder.
  if (project?.kind === 'linux') return MACHINES[machineKindOf(project)]
  return LANGUAGES[project?.language] ?? LANGUAGES.python
}

// Highlighting-only file types (not runnable).
const EDITOR_ONLY = {
  '.md': 'markdown',
  '.json': 'json',
  '.css': 'css',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.txt': 'plaintext',
  '.toml': 'ini',
}

const BY_EXTENSION = new Map(
  Object.entries(LANGUAGES).flatMap(([id, language]) => language.extensions.map((ext) => [ext, id])),
)

/** Language id for a path, or null if Opcode cannot run it. */
export function languageForPath(path) {
  if (basename(path) === 'Makefile') return null
  return BY_EXTENSION.get(extname(path)) ?? null
}

/** Monaco language id used for syntax highlighting. */
export function monacoLanguageFor(path) {
  const id = languageForPath(path)
  if (id) return LANGUAGES[id].monaco
  if (basename(path) === 'Makefile') return 'shell'
  return EDITOR_ONLY[extname(path)] ?? 'plaintext'
}

/** The colour mark for a file: its language's colour, or null. */
export function colorFor(path) {
  const id = languageForPath(path)
  return id ? LANGUAGES[id].color : null
}

/**
 * The language a set of files is mostly written in (for imported projects):
 * the one with the most runnable files, preferring files at the top level.
 */
export function languageForFiles(files) {
  const score = new Map()
  for (const { path } of files) {
    const id = languageForPath(path)
    if (id) score.set(id, (score.get(id) ?? 0) + (path.includes('/') ? 1 : 2))
  }
  let best = 'python'
  for (const id of PROJECT_LANGUAGES) if ((score.get(id) ?? 0) > (score.get(best) ?? 0)) best = id
  return best
}

const HEADERS = new Set(['.h', '.hh', '.hpp', '.hxx'])

/**
 * The command Run uses for `path`, or null when the file cannot be run
 * (headers, unknown types). In a web page project, Run on a stylesheet or
 * script shows the page too. Web plans carry `preview`, the page to show.
 */
export function runPlanFor(path, files = [], projectLanguage = null) {
  let id = languageForPath(path)
  const ext = extname(path)
  if (projectLanguage === 'web' && (ext === '.css' || id === 'javascript')) {
    return { language: 'web', toolchain: 'web', command: LANGUAGES.web.run(), preview: '/' }
  }
  if (!id || HEADERS.has(ext)) return null
  const language = LANGUAGES[id]
  const plan = { language: id, toolchain: language.toolchain, command: language.run(path, files) }
  if (language.preview) plan.preview = language.preview(path)
  return plan
}

/** Toolchains needed to run every runnable file in a project (scripts in a web page project are the page's). */
export function toolchainsForFiles(files, projectLanguage = null) {
  const needed = new Set()
  for (const file of files) {
    const toolchain = runPlanFor(file.path, files, projectLanguage)?.toolchain
    if (toolchain) needed.add(toolchain)
  }
  return [...needed]
}

/** Quote a word for bash, leaving simple paths readable. */
export function shellQuote(word) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

const MAIN_FUNCTION = /\bmain\s*\(/

// Compile every source next to `path` (a typical multi-file C/C++ exercise)
// unless several of them define main(), in which case only `path` is built.
function compileAndRun(path, files, sourceExtensions, compiler) {
  const dir = dirname(path)
  let sources = files
    .filter((f) => dirname(f.path) === dir && sourceExtensions.includes(extname(f.path)))
    .map((f) => f)
  const withMain = sources.filter((f) => MAIN_FUNCTION.test(f.content ?? ''))
  if (withMain.length > 1 || !sources.some((f) => f.path === path)) {
    sources = [{ path }]
  }
  const output = joinPath(dir, stem(path))
  const inputs = sources.map((f) => shellQuote(f.path)).sort().join(' ')
  const executable = output.includes('/') ? output : `./${output}`
  return `${compiler} -o ${shellQuote(output)} ${inputs} && ${shellQuote(executable)}`
}
// tsc writes main.js beside main.ts (or in the outDir of a tsconfig.json,
// which tsc uses instead of command-line files); node runs it.
function typescriptRun(path, files) {
  const dir = dirname(path)
  const js = (file) => file.replace(/\.ts$/, '.js').replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs')
  const config = files.find((f) => f.path === joinPath(dir, 'tsconfig.json'))
  if (!config) return `tsc ${shellQuote(path)} && node ${shellQuote(js(path))}`
  let outDir = ''
  try {
    // tsconfig.json allows comments and trailing commas.
    const json = JSON.parse(config.content.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))
    outDir = typeof json?.compilerOptions?.outDir === 'string' ? json.compilerOptions.outDir.replace(/^\.\/?/, '').replace(/\/$/, '') : ''
  } catch {
    // Unreadable: tsc will say what is wrong with it.
  }
  const relative = dir ? path.slice(dir.length + 1) : path
  const output = joinPath(dir, outDir ? `${outDir}/${js(relative)}` : js(relative))
  return `tsc${dir ? ` -p ${shellQuote(dir)}` : ''} && node ${shellQuote(output)}`
}

// javac Main.java && java Main. Other Java files in the folder are compiled
// with it (as javac would find the classes they define), and a file in a
// folder runs with that folder as its class path.
function javaRun(path, files) {
  const dir = dirname(path)
  const siblings = files.some((f) => f.path !== path && dirname(f.path) === dir && extname(f.path) === '.java')
  const compile = siblings ? `javac ${dir ? `${shellQuote(dir)}/` : ''}*.java` : `javac ${shellQuote(path)}`
  return `${compile} && java ${dir ? `-cp ${shellQuote(dir)} ` : ''}${stem(path)}`
}

// A file in a Cargo package (the nearest Cargo.toml above it) runs with
// cargo; any other .rs file is compiled on its own with rustc.
function rustRun(path, files) {
  const paths = new Set(files.map((f) => f.path))
  let dir = dirname(path)
  for (;;) {
    if (paths.has(joinPath(dir, 'Cargo.toml'))) {
      const inPackage = dir ? path.slice(dir.length + 1) : path
      const bin = /^src\/bin\/([^/]+)\.rs$/.exec(inPackage)?.[1]
      const command = inPackage === 'src/lib.rs' ? 'cargo test' : bin ? `cargo run --bin ${shellQuote(bin)}` : 'cargo run'
      return dir ? `cd ${shellQuote(dir)} && ${command}` : command
    }
    if (!dir) break
    dir = dirname(dir)
  }
  const output = joinPath(dirname(path), stem(path))
  const executable = output.includes('/') ? output : `./${output}`
  return `rustc ${shellQuote(path)} -o ${shellQuote(output)} && ${shellQuote(executable)}`
}
