import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [
    {
      // A module's, an entity's or a widget's index.ts only re-exports (eslint.config.js holds it to that),
      // so it is side-effect free — and saying so lets the bundler bind an
      // importer straight to the files it uses. Without it, every page importing
      // an index pulled in every module that index re-exports: the bundler
      // assigns chunks by reachability, and a styled component cannot be
      // tree-shaken (docs/architecture/11).
      name: 'module-index-pure',
      transform(code, id) {
        if (/\/src\/(modules|entities|widgets)\/[^/]+\/index\.ts$/.test(id)) return { code, moduleSideEffects: false }
      },
    },
    vue(),
    tailwindcss(),
    // The member app's service worker (#472): src/sw.ts, given the client
    // build's precache list. Registered from shared/utils/pwa.ts; the manifest is a
    // static file in public/, linked from index.html only.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        // Code and the offline page, never an HTML shell: index.html and
        // reader.html are SSR templates, not pages.
        globPatterns: ['assets/**/*.{js,css,woff2,svg,png}', 'offline.html', 'favicon.svg'],
      },
    }),
  ],
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
      // The server bundle's chunks import each other in cycles (a component a
      // page imports and a `lazy.ts` also imports dynamically), and Rolldown
      // inlines its runtime helpers into whichever chunk first needs them — so a
      // chunk could evaluate before the helper it imports back was assigned, and
      // the route 500'd on a cold render (#630). This keeps source order across
      // chunks; scripts/check-ssr-chunks.mjs fails the build if it ever does not.
      // The client is spared: its runtime is shared by two entries and so gets a
      // chunk of its own.
      output: isSsrBuild ? { strictExecutionOrder: true } : {},
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
