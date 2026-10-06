import { expect, test } from '@playwright/test'

// Docker runs on an emulated PC, which needs the computer to itself: this
// file runs after the others (see playwright.config.js).

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

test('runs real Docker: containers, published ports, image builds and the tutorial', async ({ page }) => {
  test.setTimeout(480_000)
  await page.goto('/')
  await page.getByRole('button', { name: /Learn Docker/ }).click()
  await expect(page.getByRole('heading', { name: 'Learn Docker' })).toBeVisible()

  const term = terminal(page)
  await expect(term.rows).toContainText('student@opcode:~$', { timeout: 180_000 })
  await expect(page.locator('.linux-workspace .status')).toContainText('Docker')

  await term.type('tutorial')
  await expect(term.rows).toContainText('Lesson 1 of 11')
  await term.type('clear; docker run hello-world | head -2')
  await expect(term.rows).toContainText('Hello from Docker!', { timeout: 180_000 })
  await term.type('tutorial check')
  await expect(term.rows).toContainText('Correct!', { timeout: 60_000 })

  // Bridge networking: -p reaches a server inside a container, and the
  // preview shows it.
  await term.type('clear; docker run -d --name web -p 8080:80 nginx:alpine-slim > /dev/null && sleep 2 && curl -s localhost:8080 | grep -o "Welcome to nginx"')
  await expect(term.rows).toContainText('Welcome to nginx', { timeout: 180_000 })
  const preview = page.frameLocator('.preview-panel iframe')
  await expect(preview.locator('h1')).toHaveText('Welcome to nginx!', { timeout: 60_000 })

  await term.type('clear; cd ~/hello-web && docker build -q -t hello-web . > /dev/null && docker run --rm hello-web grep -o "Hello from a container" /usr/share/nginx/html/index.html')
  await expect(term.rows).toContainText('Hello from a container', { timeout: 180_000 })
})
