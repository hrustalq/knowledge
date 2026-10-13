import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isInternalAddress } from './site-files.js'

/**
 * `POST /_internal/export/render` (docs/features/45): the worker sends an
 * export's pages, this renders them with the reader's own parser
 * (src/export-render.ts) and answers with the files to package.
 *
 * Who may call it: a peer on the internal network that came through no proxy.
 * The front proxy (Caddy) is itself an internal peer, and it always adds
 * `X-Forwarded-For` — so a request from the internet, which can only arrive
 * through it, never passes. The route reads nothing either way: it renders
 * what it is sent and holds no credential, so the check bounds who can spend
 * this process's CPU, not who can see data.
 */
export const EXPORT_RENDER_PATH = '/_internal/export/render'

/** @param {import('express').Request} req */
export function isDirectInternalCall(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded) return false
  return isInternalAddress(req.socket.remoteAddress)
}

const require = createRequire(import.meta.url)
let mermaid = null

/** mermaid.min.js, read once and only when an export first needs it (3 MB). */
export function mermaidScript() {
  mermaid ??= readFileSync(require.resolve('mermaid/dist/mermaid.min.js'), 'utf8')
  return mermaid
}

/**
 * @param {{ express: typeof import('express'), loadRenderer: () => Promise<(req: unknown, deps: unknown) => unknown>, logger: { warn: (o: object, m: string) => void } }} deps
 */
export function exportRenderRoute({ express, loadRenderer, logger }) {
  const router = express.Router()
  router.post(
    EXPORT_RENDER_PATH,
    (req, res, next) => (isDirectInternalCall(req) ? next() : res.status(404).end()),
    // A project of long pages is tens of megabytes of markdown.
    express.json({ limit: '128mb' }),
    async (req, res) => {
      try {
        const render = await loadRenderer()
        res.json(render(req.body, { mermaidScript }))
      } catch (e) {
        logger.warn({ err: e }, 'export render failed')
        res.status(500).type('text/plain').send(String(e?.message ?? e).slice(0, 500))
      }
    },
  )
  return router
}
