import { describe, expect, it } from 'vitest'
import { LANGUAGES, PROJECT_LANGUAGES, languageForPath, monacoLanguageFor, runPlanFor, shellQuote, toolchainsForFiles } from '../src/lib/languages.js'

const file = (path, content = '') => ({ path, content })

describe('language detection', () => {
  it('recognises runnable files by extension', () => {
    expect(languageForPath('main.py')).toBe('python')
    expect(languageForPath('src/app.CPP')).toBe('cpp')
    expect(languageForPath('lib.h')).toBe('c')
    expect(languageForPath('server.mjs')).toBe('javascript')
    expect(languageForPath('notes.md')).toBeNull()
  })

  it('picks Monaco languages for highlighting-only files', () => {
    expect(monacoLanguageFor('README.md')).toBe('markdown')
    expect(monacoLanguageFor('main.go')).toBe('go')
    expect(monacoLanguageFor('Makefile')).toBe('shell')
    expect(monacoLanguageFor('data.bin')).toBe('plaintext')
  })

  it('has a starter file that runs for every project language', () => {
    for (const id of PROJECT_LANGUAGES) {
      const { path } = LANGUAGES[id].starter
      expect(runPlanFor(path, [file(path)])?.language).toBe(id)
    }
  })
})

describe('run commands', () => {
  it('runs interpreted languages directly', () => {
    expect(runPlanFor('main.py').command).toBe('python3 main.py')
    expect(runPlanFor('app.js').command).toBe('node app.js')
    expect(runPlanFor('index.php').command).toBe('php index.php')
    expect(runPlanFor('build.sh').command).toBe('bash build.sh')
    expect(runPlanFor('main.rb').command).toBe('ruby main.rb')
    expect(runPlanFor('game/main.lua').command).toBe('lua game/main.lua')
  })

  it('runs C# folders as projects with dotnet run', () => {
    expect(runPlanFor('Program.cs', [file('Program.cs')])).toMatchObject({ command: 'dotnet run', toolchain: 'csharp' })
    expect(runPlanFor('games/snake/Game.cs', [file('games/snake/Game.cs')]).command).toBe('(cd games/snake && dotnet run)')
  })

  it('compiles TypeScript with tsc, then runs the JavaScript with node', () => {
    expect(runPlanFor('main.ts', [file('main.ts')])).toMatchObject({ command: 'tsc main.ts && node main.js', toolchain: 'typescript' })
    expect(runPlanFor('src/tool.mts', [file('src/tool.mts')]).command).toBe('tsc src/tool.mts && node src/tool.mjs')
    // A tsconfig.json makes it a project: tsc -p, and its outDir.
    expect(runPlanFor('main.ts', [file('main.ts'), file('tsconfig.json', '{ "compilerOptions": { "strict": true } }')]).command).toBe('tsc && node main.js')
    const config = file('app/tsconfig.json', '{\n  // Where JavaScript goes\n  "compilerOptions": { "outDir": "./dist/", },\n}')
    expect(runPlanFor('app/main.ts', [file('app/main.ts'), config]).command).toBe('tsc -p app && node app/dist/main.js')
    expect(LANGUAGES.typescript.extensions).toContain('.ts')
  })

  it('quotes paths with spaces', () => {
    expect(runPlanFor('my program.py').command).toBe("python3 'my program.py'")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })

  it('compiles every C source in the folder for multi-file programs', () => {
    const files = [file('main.c', 'int main(void){return helper();}'), file('helper.c', 'int helper(void){return 0;}'), file('helper.h')]
    expect(runPlanFor('main.c', files).command).toBe('clang -std=c17 -Wall -o main helper.c main.c && ./main')
  })

  it('builds only the active file when several files define main()', () => {
    const files = [file('a.cpp', 'int main(){}'), file('b.cpp', 'int main(){}')]
    expect(runPlanFor('b.cpp', files).command).toBe('clang++ -std=c++17 -Wall -o b b.cpp && ./b')
  })

  it('runs programs in subfolders by path', () => {
    const files = [file('ex1/main.c', 'int main(void){}')]
    expect(runPlanFor('ex1/main.c', files).command).toBe('clang -std=c17 -Wall -o ex1/main ex1/main.c && ex1/main')
  })

  it('compiles a Rust file on its own with rustc', () => {
    expect(runPlanFor('main.rs', [file('main.rs')]).command).toBe('rustc main.rs -o main && ./main')
    expect(runPlanFor('ex/hello.rs', [file('ex/hello.rs')]).command).toBe('rustc ex/hello.rs -o ex/hello && ex/hello')
  })

  it('runs files in a Cargo package with cargo', () => {
    const files = [file('hello/Cargo.toml'), file('hello/src/main.rs'), file('hello/src/lib.rs'), file('hello/src/bin/tool.rs'), file('Cargo.toml'), file('src/main.rs')]
    expect(runPlanFor('hello/src/main.rs', files).command).toBe('cd hello && cargo run')
    expect(runPlanFor('hello/src/lib.rs', files).command).toBe('cd hello && cargo test')
    expect(runPlanFor('hello/src/bin/tool.rs', files).command).toBe('cd hello && cargo run --bin tool')
    expect(runPlanFor('src/main.rs', files).command).toBe('cargo run')
    expect(runPlanFor('main.rs', files).command).toBe('cargo run')
    expect(runPlanFor('main.rs', files).toolchain).toBe('rust')
  })

  it('runs a Go package when the folder has several files', () => {
    expect(runPlanFor('main.go', [file('main.go')]).command).toBe('go run main.go')
    expect(runPlanFor('main.go', [file('main.go'), file('util.go'), file('util_test.go')]).command).toBe('go run .')
    expect(runPlanFor('cmd/main.go', [file('cmd/main.go'), file('cmd/x.go')]).command).toBe('go run ./cmd')
  })

  it('does not run headers or unknown files', () => {
    expect(runPlanFor('util.h')).toBeNull()
    expect(runPlanFor('vec.hpp')).toBeNull()
    expect(runPlanFor('README.md')).toBeNull()
  })

  it('lists the toolchains a project needs', () => {
    expect(toolchainsForFiles([file('a.py'), file('b.c'), file('c.cpp'), file('run.sh')]).sort()).toEqual(['clang', 'python'])
  })

  it('compiles and runs Java, with the other files in its folder', () => {
    expect(runPlanFor('Main.java', [file('Main.java')]).command).toBe('javac Main.java && java Main')
    expect(runPlanFor('Main.java', [file('Main.java'), file('Pet.java')]).command).toBe('javac *.java && java Main')
    expect(runPlanFor('lab 2/App.java', [file('lab 2/App.java'), file('lab 2/Shape.java')]).command).toBe("javac 'lab 2'/*.java && java -cp 'lab 2' App")
    expect(runPlanFor('ex/Hello.java', [file('ex/Hello.java'), file('Main.java')]).command).toBe('javac ex/Hello.java && java -cp ex Hello')
    expect(runPlanFor('Main.java').toolchain).toBe('java')
  })

  it('runs SQL on a fresh database and prints tables', () => {
    expect(runPlanFor('main.sql')).toEqual({ language: 'sql', toolchain: 'sqlite', command: 'sqlite3 -box :memory: < main.sql' })
    expect(runPlanFor('queries/top 10.sql').command).toBe("sqlite3 -box :memory: < 'queries/top 10.sql'")
  })

  it('serves web pages and opens them in the preview', () => {
    expect(runPlanFor('index.html')).toEqual({ language: 'web', toolchain: 'web', command: 'serve', preview: '/' })
    expect(runPlanFor('pages/about.html').preview).toBe('/pages/about.html')
    expect(runPlanFor('docs/index.html').preview).toBe('/docs/index.html')
    // In a web page project, scripts and styles belong to the page.
    expect(runPlanFor('script.js', [], 'web')).toMatchObject({ language: 'web', preview: '/' })
    expect(runPlanFor('style.css', [], 'web')).toMatchObject({ language: 'web', preview: '/' })
    expect(runPlanFor('script.js').command).toBe('node script.js')
    expect(runPlanFor('style.css')).toBeNull()
    const site = [file('index.html'), file('style.css'), file('script.js')]
    expect(toolchainsForFiles(site, 'web')).toEqual(['web'])
    expect(toolchainsForFiles(site).sort()).toEqual(['node', 'web'])
  })
})
