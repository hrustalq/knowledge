// SPIKE #80: stub SFCs so the editor's extensions load headless.
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: {
    alias: [
      { find: /^.*\.vue$/, replacement: fileURLToPath(new URL('./spike/vue-stub.ts', import.meta.url)) },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  test: { include: ['src/**/spike-*.spec.ts'] },
})
