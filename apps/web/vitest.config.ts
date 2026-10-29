import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests for the web app's plain modules — streams, storage, serializers.
// Components are exercised in the browser, not here, so no Vue plugin and no DOM.
export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // The editor's extensions import their node views; a spec only needs the schema.
      { find: /^.*\.vue$/, replacement: fileURLToPath(new URL('./test/sfc-stub.ts', import.meta.url)) },
      // vite-plugin-pwa's module exists only in a Vite build (shared/utils/pwa.ts).
      { find: 'virtual:pwa-register', replacement: fileURLToPath(new URL('./test/pwa-register-stub.ts', import.meta.url)) },
    ],
  },
  test: {
    // server/ is server.js's unbundled Node helpers (plain JS).
    include: ['src/**/*.spec.ts', 'server/**/*.spec.js'],
  },
})
