import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rolldownOptions: {
      // Two apps from one build (docs/features/43): the member app and the
      // public reader, each with its own HTML shell and SSR entry, so nothing
      // of the app shell ships to an anonymous reader.
      input: (isSsrBuild
        ? {
            'entry-server': 'src/entry-server.ts',
            'entry-public': 'src/entry-public.ts',
            // The worker's export renderer (docs/features/45), called by server.js.
            'export-render': 'src/export-render.ts',
          }
        : { main: 'index.html', reader: 'reader.html' }) as Record<string, string>,
    },
  },
  server: {
    // A published site's own host in dev (docs/features/44), e.g.
    // PUBLISH_BASE_DOMAIN=docs.localhost → <slug>.docs.localhost:5173.
    ...(process.env.PUBLISH_BASE_DOMAIN ? { allowedHosts: [`.${process.env.PUBLISH_BASE_DOMAIN}`] } : {}),
    proxy: {
      '/api': {
        target: process.env.API_URL_INTERNAL ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
}))
