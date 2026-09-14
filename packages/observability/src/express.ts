import type { HttpRequestEvent } from '@knowledge/contracts/observability';
import { startTrace, withTrace } from '@knowledge/observability/trace';
import { emitBacktest } from '@knowledge/observability/backtest';

/**
 * Structural request/response types rather than an `express` dependency.
 *
 * Both consumers bring their own Express (apps/api on @nestjs/platform-express,
 * apps/web directly), and a buildless package taking a framework dep to name two
 * argument types would make every consumer resolve it. These are the fields the
 * middleware actually touches.
 */
interface TracedRequest {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface TracedResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  getHeader(name: string): number | string | string[] | undefined;
  on(event: 'finish', listener: () => void): unknown;
}

/**
 * Opens the correlation scope for an HTTP request and records that the request
 * happened.
 *
 * A plain middleware function, not a Nest NestMiddleware: that sidesteps
 * MiddlewareConsumer.forRoutes, whose wildcard spelling changed under Express 5,
 * it runs ahead of the router so an unmatched path is traced too, and it is what
 * lets apps/web's server.js use the identical middleware.
 *
 * Two things were broken before this existed. The id was minted inside the API's
 * exception filter at error time, so a successful request carried no id and an
 * error's id correlated to nothing earlier. And nothing recorded a request that
 * did not throw — no access log, no 4xx, no latency.
 *
 * The finish listener is the metadata-only replay axis: method, route, status,
 * duration, sizes. No bodies, deliberately — nothing to redact, and no new
 * retention surface over document content or prompts.
 */
export function traceMiddleware(req: TracedRequest, res: TracedResponse, next: () => void): void {
  const header = req.headers['x-request-id'];
  const inbound = Array.isArray(header) ? header[0] : header;
  const ctx = startTrace('http', {
    traceId: inbound,
    method: req.method,
    route: req.originalUrl ?? req.url,
  });

  // Set immediately, not on finish: a client that never gets a response still
  // needs the id it should quote, and the API's exception filter echoes this one.
  res.setHeader('x-request-id', ctx.traceId);

  const startedAt = process.hrtime.bigint();

  withTrace(ctx, () => {
    res.on('finish', () => {
      const event: HttpRequestEvent = {
        ...ctx,
        kind: 'http.request',
        ts: new Date().toISOString(),
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        method: req.method,
        status: res.statusCode,
        requestBytes: Number(req.headers['content-length'] ?? 0) || undefined,
        responseBytes: Number(res.getHeader('content-length') ?? 0) || undefined,
      };
      emitBacktest(event);
    });
    next();
  });
}
