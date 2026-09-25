import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests for the web app's plain modules — streams, storage, serializers.
// Components are exercised in the browser, not here, so no Vue plugin and no DOM.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
  },
})
