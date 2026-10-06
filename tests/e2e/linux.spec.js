import { expect, test } from '@playwright/test'

// Behind a TLS-intercepting proxy (E2E_FETCH_VIA_NODE=1), the machine's
// DNS-over-HTTPS goes to the relay instead, which also learns the names.
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_FETCH_VIA_NODE) return
  await context.route(/^https:\/\/cloudflare-dns\.com\/dns-query/, async (route) => {
    const response = await fetch(`http://127.0.0.1:8090/dns-query${new URL(route.request().url()).search}`, { method: route.request().method(), headers: { 'content-type': 'application/dns-message' }, body: route.request().postDataBuffer() ?? undefined })
    await route.fulfill({ status: response.status, headers: { 'content-type': 'application/dns-message', 'access-control-allow-origin': '*' }, body: Buffer.from(await response.arrayBuffer()) })
  })
})

// Count projects with a name in the project menu.
async function expectProjects(page, name, count) {
  await expect(page.locator('.project-switcher')).toContainText(name, { timeout: 60_000 })
  await page.locator('.project-switcher').click()
  await expect(page.locator('.project-menu .project-item', { hasText: name })).toHaveCount(count)
  // Close it with a click: a machine's terminal may have taken the keyboard.
  await page.locator('.project-switcher').click()
  await expect(page.locator('.project-menu')).toHaveCount(0)
}

async function startLinux(page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Learn the Linux terminal/ }).click()
}

function terminal(page) {
  const rows = page.locator('.terminal-area .xterm-rows')
  return {
    rows,
    async type(text) {
      await page.locator('.terminal-area .xterm-helper-textarea').focus()
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
    },
  }
}

test('boots a Linux machine, teaches, and remembers it', async ({ page }) => {
  await startLinux(page)

  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })

  await term.type('uname -sr; id -un')
  await expect(term.rows).toContainText(/Linux 6\.\d+/)
  await expect(term.rows).toContainText('student')

  await term.type('tutorial')
  await expect(term.rows).toContainText('Lesson 1 of 12')
  await term.type('tutorial answer /home/student')
  await expect(term.rows).toContainText('Lesson 2 of 12')

  // Real signals: Ctrl+C interrupts a foreground program.
  await term.type('sleep 100')
  await page.waitForTimeout(1000) // let sleep start, as a person would
  await page.keyboard.press('Control+c')
  await term.type('echo interrupted-$((40+2))')
  await expect(term.rows).toContainText('interrupted-42')

  await term.type('echo "kept across reloads" > memo.txt')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.linux-workspace .saved')).toContainText('Saved', { timeout: 30_000 })

  await page.reload()
  const after = terminal(page)
  await expect(page.locator('.linux-workspace .status')).toContainText('Running', { timeout: 60_000 })
  await after.type('cat memo.txt')
  await expect(after.rows).toContainText('kept across reloads')
})

test('downloads a machine and opens it from a file and from a link', async ({ page }) => {
  await startLinux(page)
  await page.locator('.project-switcher').click()
  await page.getByRole('button', { name: 'Rename Linux lab' }).click()
  await page.getByLabel('Project name').fill('Lab Template')
  await page.keyboard.press('Enter')
  await page.locator('.project-switcher').click()

  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 120_000 })
  await term.type('mkdir -p lab && echo "prepared by the teacher" > lab/README')

  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('lab-template.opcode-linux')
  const file = await download.path()

  // Import opens it as a new project.
  await page.locator('input[type=file][accept*=".opcode-linux"]').setInputFiles({ name: 'lab-template.opcode-linux', mimeType: 'application/octet-stream', buffer: (await import('node:fs')).readFileSync(file) })
  await expectProjects(page, 'Lab Template', 2)
  await expect(page.locator('.linux-workspace .status')).toContainText('Running', { timeout: 60_000 })
  await term.type('cat lab/README')
  await expect(term.rows).toContainText('prepared by the teacher')

  // So does a link to the file.
  await page.route('**/shared/lab.opcode-linux', (route) => route.fulfill({ path: file, contentType: 'application/octet-stream' }))
  await page.goto('/?machine=shared/lab.opcode-linux')
  await expectProjects(page, 'Lab Template', 3)
  await expect(page).not.toHaveURL(/machine=/)
  await expect(page.locator('.linux-workspace .status')).toContainText('Running', { timeout: 60_000 })
  await term.type('cat lab/README')
  await expect(term.rows).toContainText('prepared by the teacher')
})

test('goes online and installs packages', async ({ page }) => {
  await startLinux(page)

  const term = terminal(page)
  await expect(term.rows).toContainText('It is online', { timeout: 120_000 })
  await term.type('curl -sS -o /dev/null -w "https=%{http_code}\\n" https://example.com')
  await expect(term.rows).toContainText('https=200', { timeout: 60_000 })
  await term.type('sudo apk add -q jq && echo installed-$((6 * 7))')
  await expect(term.rows).toContainText('password for student')
  await term.type('student')
  await expect(term.rows).toContainText('installed-42', { timeout: 120_000 })
  await term.type(`echo '{"answer": 42}' | jq -r '"answer-" + (.answer | tostring)'`)
  await expect(term.rows).toContainText('answer-42', { timeout: 120_000 })
})
