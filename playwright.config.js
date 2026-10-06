// End-to-end tests run the production build in Chromium. They download real
// toolchains (Python ~62 MB) from the Wasmer registry, so they need network
// access and take a few minutes. Run with: npm run test:e2e
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:4173/',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
  },
  // Docker's test runs on its own, last: an emulated PC running Docker is
  // slow when it shares the processor with other tests.
  projects: [
    { name: 'opcode', testIgnore: /docker\.spec\.js/ },
    { name: 'docker', testMatch: /docker\.spec\.js/, dependencies: ['opcode'] },
  ],
  webServer: [
    {
      // The web preview uses a self-hosted HTTP host (see scripts/preview-host.mjs),
      // and internet access a local relay (scripts/wisp-server.mjs).
      command: 'npm run build && npx vite preview --port 4173 --strictPort',
      // *.localhost: every server gets its own preview origin (no DNS needed).
      env: { VITE_PREVIEW_HOST: 'http://*.localhost:5174/', VITE_WISP_URL: 'ws://localhost:8090/' },
      url: 'http://localhost:4173/',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: 'npm run preview-host',
      url: 'http://localhost:5174/',
      reuseExistingServer: !process.env.CI,
    },
    {
      // E2E_RELAY_PROXY: for machines whose outgoing traffic must use an HTTP proxy.
      command: `node scripts/wisp-server.mjs --port 8090 --host 127.0.0.1${process.env.E2E_RELAY_PROXY ? ` --via-proxy ${process.env.E2E_RELAY_PROXY}` : ''}`,
      url: 'http://127.0.0.1:8090/',
      reuseExistingServer: !process.env.CI,
    },
  ],
})
