import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Headers every response of an HTTP entrypoint carries (#1114): no framework
 * banner, and `nosniff` so a browser never reads a JSON body or an error page as
 * something it could run. No helmet: its default CSP would break Swagger UI at
 * /docs, which stays public on purpose (the document is committed in this
 * public repository, and the release check reads its version), and the rest of
 * what it sets belongs to the HTML the web app serves, which sets its own.
 */
export function applySecurityHeaders(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.use((_req: unknown, res: { setHeader(name: string, value: string): unknown }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
}
