import { defineConfig } from '@playwright/test'

// Browser end-to-end tests (#80). They run against a stack that is already up
// — `make dev` locally, the `coedit-e2e` CI job — with COLLAB_ENABLED=true and
// AUTH_MODE=none. The installed Chrome is used, so nothing is downloaded.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:5173',
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
})
