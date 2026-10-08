import { expect, test } from '@playwright/test'

// Behind a TLS-intercepting proxy the browser may not trust, set
// E2E_FETCH_VIA_NODE=1 to fetch the Wasmer registry and CDN from Node.
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_FETCH_VIA_NODE) return
  // The guests' DNS-over-HTTPS goes to the relay, which then knows the names
  // to give its proxy.
  await context.route(/^https:\/\/cloudflare-dns\.com\/dns-query/, async (route) => {
    const response = await fetch(`http://127.0.0.1:8090/dns-query${new URL(route.request().url()).search}`, { method: route.request().method(), headers: { 'content-type': 'application/dns-message' }, body: route.request().postDataBuffer() ?? undefined })
    await route.fulfill({ status: response.status, headers: { 'content-type': 'application/dns-message', 'access-control-allow-origin': '*' }, body: Buffer.from(await response.arrayBuffer()) })
  })
  await context.route(/^https:\/\/(registry|cdn)\.wasmer\.io\//, async (route) => {
    const request = route.request()
    const headers = { ...request.headers() }
    delete headers.host
    const response = await fetch(request.url(), { method: request.method(), headers, body: request.postDataBuffer() ?? undefined })
    const out = {}
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key)) out[key] = value
    })
    await route.fulfill({ status: response.status, headers: out, body: Buffer.from(await response.arrayBuffer()) })
  })
})

// A first visit shows the start screen: pick a language, then start.
async function startProject(page, language = 'Python') {
  await page.goto('/')
  await page.locator('.language', { has: page.locator('.name', { hasText: new RegExp(`^${language.replace(/[+]/g, '\\+')}$`) }) }).click()
  await page.getByRole('button', { name: `Start coding in ${language}` }).click()
}

function terminal(page) {
  const rows = page.locator('.view.visible .xterm-rows')
  return {
    rows,
    async type(text) {
      await page.locator('.view.visible .xterm-helper-textarea').focus()
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
    },
  }
}

test('starts from the start screen, and remembers projects and colors', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'What will you make today?' })).toBeVisible()
  await startProject(page, 'Go')
  await expect(page.locator('.project-switcher')).toContainText('Go project')
  await expect(page.locator('.tab.active')).toContainText('main.go')

  // Projects are renamed in the project menu.
  await page.locator('.project-switcher').click()
  await page.getByRole('button', { name: 'Rename Go project' }).click()
  await page.getByLabel('Project name').fill('Gopher')
  await page.keyboard.press('Enter')
  await page.locator('.project-switcher').click()
  await expect(page.locator('.project-switcher')).toContainText('Gopher')

  // Dark mode and the editor colors stay after a reload, and so does the project.
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await page.getByRole('button', { name: 'Editor colors' }).click()
  await page.getByRole('menuitemradio', { name: /Highlighter/ }).click()
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.project-switcher')).toContainText('Gopher')
  await expect(page.locator('.monaco-editor-background')).toHaveCSS('background-color', 'rgb(255, 253, 243)')

  // Home lists the project to carry on with; a double click starts another.
  await page.getByRole('button', { name: 'Opcode home' }).click()
  await expect(page.locator('.recent')).toContainText('Gopher')
  await page.locator('.language', { has: page.locator('.name', { hasText: /^Bash$/ }) }).dblclick()
  await expect(page.locator('.project-switcher')).toContainText('Bash project')
  await expect(page.locator('.tab.active')).toContainText('main.sh')

  // Deleting every project leads back to the start screen.
  await page.locator('.project-switcher').click()
  await page.getByRole('button', { name: 'Delete Bash project' }).click()
  await expect(page.locator('.project-menu .project-item')).toHaveCount(1)
  await page.getByRole('button', { name: 'Delete Gopher' }).click()
  await expect(page.getByRole('heading', { name: 'What will you make today?' })).toBeVisible()
  await expect(page.locator('.recent')).toHaveCount(0)
})

test('runs Python interactively and syncs files both ways', async ({ page }) => {
  await startProject(page)
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(term.rows).toContainText("What's your name?", { timeout: 180_000 })
  await term.type('Ada')
  await expect(term.rows).toContainText('Hello, Ada!')

  // Terminal → editor
  await term.type('mkdir -p data && echo "42" > data/answer.txt')
  await expect(page.locator('.sidebar .tree')).toContainText('answer.txt')

  // Editor → terminal
  await page.locator('.sidebar .tree').getByText('answer.txt').click()
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('forty-two')
  await page.waitForTimeout(1000)
  await term.type('cat data/answer.txt')
  await expect(term.rows).toContainText('forty-two')

  // Stop a runaway program
  await term.type('python3 -c "while True: pass"')
  await expect(page.locator('.topbar .stop-btn')).toBeEnabled()
  await page.locator('.topbar .stop-btn').click()
  await expect(page.locator('.topbar .stop-btn')).toBeDisabled({ timeout: 10_000 })
  await term.type('echo still-$((40+2))')
  await expect(term.rows).toContainText('still-42')
})

test('runs the terminal and Python without Wasmer, from the packages the site serves', async ({ page, context }) => {
  const wasmer = []
  await context.route(/wasmer\.io/, (route) => {
    wasmer.push(route.request().url())
    return route.abort()
  })
  await startProject(page)
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await term.type('ls / | wc -l')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(term.rows).toContainText("What's your name?", { timeout: 180_000 })
  await term.type('Ada')
  await expect(term.rows).toContainText('Hello, Ada!')
  expect(wasmer).toEqual([])
})

test('compiles and runs C++ from a new project', async ({ page }) => {
  await startProject(page, 'C++')

  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(term.rows).toContainText("What's your name?", { timeout: 180_000 })
  await term.type('Grace')
  await expect(term.rows).toContainText('Hello, Grace!')
  await expect(term.rows).toContainText('The sum of 1..5 is 15')
})

test('runs several terminals side by side', async ({ page }) => {
  await startProject(page)
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })

  // A long command in the first terminal...
  await term.type('for i in $(seq 1 600); do echo tick-$i; sleep 0.1; done')
  await expect(term.rows).toContainText('tick-3')

  // ...keeps running while a second terminal is used and interrupted.
  await page.getByRole('button', { name: 'New terminal' }).click()
  await expect(page.locator('.shell-tab')).toHaveCount(2)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 30_000 })
  await term.type('cd /tmp && sleep 30')
  await expect(page.locator('.topbar .stop-btn')).toBeEnabled()
  await page.keyboard.press('Control+c')
  await expect(term.rows).toContainText('[130] student@opcode:/tmp$')
  await expect(page.locator('.panel-header .cwd')).toHaveText('/tmp')

  // Ctrl+C stops a loop without losing the shell's variables.
  await term.type('x=42; for i in $(seq 1 100); do sleep 1; done; echo not-$((1 + 1))-reached')
  await page.waitForTimeout(1500)
  await page.keyboard.press('Control+c')
  await expect(term.rows).toContainText('[130] student@opcode:/tmp$')
  await term.type('echo x=$x')
  await expect(term.rows).toContainText('x=42')
  await expect(term.rows).not.toContainText('not-2-reached')

  await page.locator('.shell-tab').first().click()
  await expect(page.locator('.panel-header .cwd')).toHaveText('~')
  const before = await term.rows.innerText()
  await page.waitForTimeout(1000)
  expect(await term.rows.innerText()).not.toEqual(before) // still ticking

  // The Python REPL keeps running on Ctrl+C, as in a native terminal.
  await page.locator('.shell-tab').nth(1).click()
  await term.type('python3')
  await expect(term.rows).toContainText('>>>', { timeout: 180_000 })
  await page.keyboard.press('Control+c')
  await expect(term.rows).toContainText('KeyboardInterrupt')
  await term.type('print(6 * 7)')
  await expect(term.rows).toContainText('42')

  await page.getByRole('button', { name: 'Close terminal 2' }).click()
  await expect(page.locator('.shell-tab')).toHaveCount(1)
})

test('previews a web server started in the terminal', async ({ page }) => {
  await startProject(page)
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })

  await term.type(`mkdir -p site && printf '<h1>Hello from the sandbox</h1><a href="about.html">About</a>' > site/index.html && printf '<p>About page</p>' > site/about.html`)
  await term.type('cd site && python3 -m http.server 8000')

  const preview = page.frameLocator('.preview-panel iframe')
  await expect(preview.locator('h1')).toHaveText('Hello from the sandbox', { timeout: 30_000 })
  await preview.getByText('About').click()
  await expect(preview.locator('p')).toHaveText('About page')

  // Stopping the server shows that; starting it again brings the page back.
  await page.locator('.view.visible .xterm-helper-textarea').focus()
  await page.keyboard.press('Control+c')
  await expect(page.locator('.preview-panel')).toContainText('stopped')
  await term.type('python3 -m http.server 8000')
  // Slow when a Docker machine is busy in the other test worker.
  await expect(preview.locator('h1')).toHaveText('Hello from the sandbox', { timeout: 60_000 })
})

test('makes a web page that updates as you type', async ({ page }) => {
  await startProject(page, 'Web page')
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await expect(page.locator('.tab .name')).toHaveText(['index.html', 'style.css', 'script.js'])

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  const preview = page.frameLocator('.preview-panel iframe')
  await expect(preview.locator('h1')).toHaveText('Hello, world!', { timeout: 60_000 })
  await preview.locator('#button').click()
  await expect(preview.locator('#message')).toHaveText('You clicked 1 time.')

  // Edits show up in the preview without pressing Run again.
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+f')
  await page.keyboard.type('Hello, world!')
  await page.keyboard.press('Escape')
  await page.keyboard.type('Made in Opcode')
  await expect(preview.locator('h1')).toHaveText('Made in Opcode', { timeout: 20_000 })

  // Pages in folders open at their own address; the server keeps running
  // (in the first terminal, so this uses another).
  await page.getByRole('button', { name: 'New terminal' }).click()
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 30_000 })
  await term.type('mkdir -p pages && echo "<h1>About me</h1>" > pages/about.html')
  await page.locator('.sidebar .tree').getByText('about.html').click()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(preview.locator('h1')).toHaveText('About me')
  await expect(page.locator('.preview-panel input')).toHaveValue('/pages/about.html')
})

test('runs SQL and opens databases in the terminal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('opcode-layout', JSON.stringify({ editorHeight: 30 })))
  await startProject(page, 'SQL')
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(term.rows).toContainText('how_many', { timeout: 60_000 })
  for (const text of ['Biscuit', 'Rex', 'fish']) await expect(term.rows).toContainText(text)

  // The sqlite3 shell, interactively, with a database file that persists.
  await term.type('clear; sqlite3 shop.db')
  await expect(term.rows).toContainText('sqlite>')
  await term.type('create table fruit(name text, price real);')
  await term.type("insert into fruit values ('apple', 0.5), ('fig', 1.25);")
  await term.type('.mode box')
  await term.type('select name, price * 2 as two from fruit order by name;')
  await expect(term.rows).toContainText('2.5')
  await term.type('.quit')
  await term.type(`echo "select count(*) || ' fruits' from fruit;" | sqlite3 shop.db`)
  await expect(term.rows).toContainText('2 fruits')
})

test('compiles and runs Java, with javac-style errors and stack traces', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('opcode-layout', JSON.stringify({ editorHeight: 30 })))
  await startProject(page, 'Java')
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(term.rows).toContainText("What's your name?", { timeout: 180_000 })
  await term.type('Duke')
  await expect(term.rows).toContainText('Hello, Duke!')
  await expect(term.rows).toContainText('The sum of 1..5 is 15')
  await expect(page.locator('.sidebar .tree')).toContainText('Main.class')

  const paste = (text) =>
    page.locator('.view.visible .xterm-helper-textarea').evaluate((textarea, value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)

  // Compile errors as javac prints them.
  await paste(`clear; printf 'public class Bad {\\n  public static void main(String[] args) {\\n    int x = "no";\\n  }\\n}\\n' > Bad.java; javac Bad.java; echo "javac-status-$?"\n`)
  await expect(term.rows).toContainText('javac-status-1', { timeout: 60_000 })
  await expect(term.rows).toContainText('Bad.java:3: error: incompatible types')
  await expect(term.rows).toContainText('1 error')

  // Two files, records and streams, and an uncaught exception's stack trace.
  await paste(
    `clear; mkdir -p zoo && printf 'public record Pet(String name, int age) {}\\n' > zoo/Pet.java && printf 'import java.util.*;\\npublic class App {\\n  public static void main(String[] args) {\\n    var pets = List.of(new Pet("Rex", 7), new Pet("Mia", 3));\\n    System.out.println(pets.stream().mapToInt(Pet::age).sum());\\n    System.out.println(pets.get(5));\\n  }\\n}\\n' > zoo/App.java && javac zoo/App.java && java -cp zoo App; echo "java-status-$?"\n`,
  )
  await expect(term.rows).toContainText('java-status-1', { timeout: 60_000 })
  await expect(term.rows).toContainText('10')
  await expect(term.rows).toContainText('Exception in thread "main" java.lang.IndexOutOfBoundsException')
  await expect(term.rows).toContainText('at App.main(App.java:6)')
})

// Run each starter, answer its question, and check an error message.
for (const { language, name, error, expected } of [
  { language: 'Ruby', name: 'Matz', error: ["printf 'puts 1 + nil\\n' > bad.rb; ruby bad.rb", 'nil can\'t be coerced into Integer (TypeError)'] },
  { language: 'Lua', name: 'Roberto', error: ["printf 'local t = nil\\nprint(t.x)\\n' > bad.lua; lua bad.lua", "attempt to index a nil value (local 't')"] },
  { language: 'C#', name: 'Ada', error: ["printf 'int x = \"no\";\\n' > Program.cs; dotnet run", "Program.cs(1,9): error CS0029: Cannot implicitly convert type 'string' to 'int'"] },
  { language: 'TypeScript', name: 'Anders', expected: '2 pets have 6 legs.', error: ["printf 'const n: number = \"no\"\\n' > bad.ts; tsc bad.ts", "error TS2322: Type 'string' is not assignable to type 'number'."] },
]) {
  test(`runs ${language}: the starter program and its errors`, async ({ page }) => {
    await startProject(page, language)
    const term = terminal(page)
    await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(term.rows).toContainText("What's your name?", { timeout: 180_000 })
    await term.type(name)
    await expect(term.rows).toContainText(`Hello, ${name}!`)
    await expect(term.rows).toContainText(expected ?? 'The sum of 1..5 is 15')
    await term.type(`clear; ${error[0]}; echo "status-$?"`)
    await expect(term.rows).toContainText(error[1], { timeout: 60_000 })
    await expect(term.rows).not.toContainText('status-0')
  })
}

test('runs R: scripts with plots in the preview, and the R console', async ({ page }) => {
  await startProject(page, 'R')
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(term.rows).toContainText('Average height: 167.6667 cm', { timeout: 180_000 })
  await expect(term.rows).toContainText('3 bird    2')
  await expect(page.locator('.preview-panel img')).toBeVisible()

  await term.type('clear; R')
  await expect(term.rows).toContainText('Type q() to quit', { timeout: 60_000 })
  await term.type('area <- function(r) {')
  await expect(term.rows).toContainText('+ ')
  await term.type('  pi * r^2')
  await term.type('}')
  await term.type('round(area(2), 2)')
  await expect(term.rows).toContainText('[1] 12.57')
  await term.type('log(-1)')
  await expect(term.rows).toContainText('NaNs produced')
  await term.type('q()')
  await term.type('echo "back-in-$((40 + 2))"')
  await expect(term.rows).toContainText('back-in-42')
})

test('installs a toolchain the first time its command is used', async ({ page }) => {
  await startProject(page)
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await term.type(`printf 'console.log("node ran: " + (6 * 7))' > hello.js`)
  await term.type('node hello.js')
  await expect(term.rows).toContainText('node ran: 42', { timeout: 240_000 })
})

test('reaches the internet through the relay', async ({ page }) => {
  await startProject(page)
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await expect(page.locator('.status-bar .internet')).toContainText('Internet: on')
  await term.type(`python3 -c "import urllib.request as u; print('status', u.urlopen('https://example.com').status)"`)
  await expect(term.rows).toContainText('status 200', { timeout: 180_000 })
})

test('previews several servers at once, each at its own address', async ({ page, context }) => {
  await startProject(page)
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await term.type(`mkdir -p a b && echo '<h1>Site A</h1>' > a/index.html && echo '<h1>Site B</h1>' > b/index.html`)
  await term.type('cd a && python3 -m http.server 8000')
  const preview = page.frameLocator('.preview-panel iframe')
  await expect(preview.locator('h1')).toHaveText('Site A', { timeout: 120_000 })
  const addressA = await page.locator('.preview-panel iframe').getAttribute('src')

  await page.getByRole('button', { name: 'New terminal' }).click()
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 30_000 })
  await term.type('cd b && python3 -m http.server 8001')
  await expect(page.locator('.preview-panel select option')).toHaveCount(2, { timeout: 30_000 })
  await page.locator('.preview-panel select').selectOption('8001')
  await expect(preview.locator('h1')).toHaveText('Site B')
  const addressB = await page.locator('.preview-panel iframe').getAttribute('src')
  expect(new URL(addressA).origin).not.toBe(new URL(addressB).origin)

  // Both stay reachable, e.g. in other tabs.
  for (const [address, title] of [[addressA, 'Site A'], [addressB, 'Site B']]) {
    const tab = await context.newPage()
    await tab.goto(address)
    await expect(tab.locator('h1')).toHaveText(title)
    await tab.close()
  }
})

test('keeps keys typed ahead and runs pasted commands in order', async ({ page }) => {
  await startProject(page)
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })

  // Typed while the previous (quick) command is still finishing.
  await term.type('ls > /dev/null')
  await term.type('echo ahead-$((40 + 2))')
  await expect(term.rows).toContainText('ahead-42')

  // A pasted block, as from a tutorial.
  await page.locator('.view.visible .xterm-helper-textarea').evaluate((textarea, text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, 'echo one-$((1))\nfor i in 2 3; do\n  echo loop-$i\ndone\necho last-$((4))\n')
  await expect(term.rows).toContainText('last-4')
  for (const text of ['one-1', 'loop-2', 'loop-3']) await expect(term.rows).toContainText(text)
})

test('compiles and runs Rust, with a built-in cargo', async ({ page }) => {
  // A tall terminal, so all of cargo test's output stays on screen.
  await page.addInitScript(() => localStorage.setItem('opcode-layout', JSON.stringify({ editorHeight: 30 })))
  await startProject(page, 'Rust')

  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(term.rows).toContainText("What's your name?", { timeout: 180_000 })
  await term.type('Ferris')
  await expect(term.rows).toContainText('Hello, Ferris!')
  await expect(term.rows).toContainText('The sum of [1, 2, 3, 4, 5] is 15')

  // Compile errors are reported, and cargo test shows a failing test's message.
  await term.type(`printf 'fn main() { let x: i32 = "no"; }\\n' > bad.rs && rustc bad.rs; echo "compile-status-$?"`)
  await expect(term.rows).toContainText('expected `i32`, found `&str`', { timeout: 60_000 })
  await expect(term.rows).toContainText('compile-status-1')
  await term.type(`cargo new --lib shapes && cd shapes && printf '%s\\n' '#[test]' 'fn broken() { assert_eq!(1 + 1, 3, "math is broken"); }' >> src/lib.rs && cargo test; echo "test-status-$?"`)
  await expect(term.rows).toContainText('test-status-101', { timeout: 120_000 })
  for (const text of ['test tests::it_works ... ok', 'test broken ... FAILED', 'math is broken', 'test result: FAILED. 1 passed; 1 failed']) {
    await expect(term.rows).toContainText(text)
  }
  await expect(term.rows).not.toContainText('stopped unexpectedly')
})

test('pages files with less, and quits it with q', async ({ page }) => {
  await startProject(page, 'Bash')
  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await term.type('seq 1 300 > nums.txt; echo made-$((1 + 1))')
  await expect(term.rows).toContainText('made-2')

  await term.type('less nums.txt')
  await expect(term.rows).toContainText('nums.txt  0%')
  await page.keyboard.press('Space')
  await expect(term.rows).not.toContainText(/^1$/m)
  await page.keyboard.press('G')
  await expect(term.rows).toContainText('nums.txt (END)')
  await expect(term.rows).toContainText('300')
  await page.keyboard.press('q')
  await term.type('echo after-$((40 + 2))')
  await expect(term.rows).toContainText('after-42')

  // Piped input can't be paged here: it is shown whole.
  await term.type('seq 1 3 | sed s/^/piped-/ | less')
  await expect(term.rows).toContainText('piped-3')
  await expect(term.rows).toContainText('student@opcode:~$')
})
