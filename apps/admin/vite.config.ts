import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// The platform admin console (#1236): a client-only SPA, served under /admin/
// on the app's own host so the member app's session cookie reaches it — there
// is no second sign-in. In production Caddy routes /admin/* to its container
// (Caddyfile); in dev it runs on :5174 and the member app's dev server also
// proxies /admin to it (apps/web/vite.config.ts), which is the URL to open: /login
// lives in the member app.
export default defineConfig({
  base: '/admin/',
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_URL_INTERNAL ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
