// SPIKE #80: runs against an already-running `make dev` (web :5173, api :3000).
import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: 'e2e', use: { baseURL: 'http://localhost:5173', channel: 'chrome' }, reporter: 'list' })
