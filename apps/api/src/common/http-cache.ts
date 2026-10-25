import { createHash } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

/**
 * What a response may be kept as (#472, docs/architecture/10-caching.md):
 * - `revalidate` — the browser keeps it and asks again every time (an ETag
 *   makes that cheap); no shared cache stores it. Every authenticated GET.
 * - `immutable` — addressed by an id whose bytes never change.
 * - `no-store` — never written anywhere: writes, and anything that carries a
 *   credential or a session.
 */
export type CachePolicyName = 'revalidate' | 'immutable' | 'no-store';

const CACHE_CONTROL: Record<CachePolicyName, string> = {
  revalidate: 'private, no-cache',
  immutable: 'private, max-age=31536000, immutable',
  'no-store': 'no-store',
};

const CACHE_POLICY_META = 'knowledge:cache-policy';

/** Overrides the default for a route or a whole controller. */
export const CachePolicy = (policy: CachePolicyName) => SetMetadata(CACHE_POLICY_META, policy);

/** For a handler whose policy depends on the request (content at a named revision is immutable, the head is not). */
export function setCachePolicy(res: Response, policy: CachePolicyName): void {
  res.setHeader('Cache-Control', CACHE_CONTROL[policy]);
}

/**
 * Sets `Cache-Control` and `Vary` on every response before its handler runs, so
 * a handler that sets its own (the public routes, SSE, a file download) still
 * wins — the public routes that may be shared say `public` themselves. A GET
 * defaults to `revalidate` and anything else to `no-store`.
 *
 * The response varies on who asks and in which language: a browser must never
 * answer one session's request from another's cached copy.
 */
@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const declared = this.reflector.getAllAndOverride<CachePolicyName | undefined>(CACHE_POLICY_META, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const policy = declared ?? (req.method === 'GET' || req.method === 'HEAD' ? 'revalidate' : 'no-store');
    setCachePolicy(res, policy);
    if (policy !== 'no-store') res.vary('Authorization').vary('Cookie').vary('Accept-Language');
    return next.handle();
  }
}

/** RFC 9110 §13.1.2: a list, weak comparison, `*` matches any current representation. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = etag.replace(/^W\//, '');
  return ifNoneMatch
    .split(',')
    .map((v) => v.trim())
    .some((v) => v === '*' || v.replace(/^W\//, '') === bare);
}

/** A strong ETag over everything a representation depends on. */
export function etagOf(...parts: unknown[]): string {
  return `"${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}"`;
}

/**
 * The cheap half of a conditional GET (#472). The handler reads only what its
 * answer depends on from PG — never the graph or object storage — and passes
 * it here as the validator. A match answers 304 with no body, and the handler
 * returns without doing the expensive half; otherwise the ETag rides on the
 * full response.
 *
 * The locale is always part of it: messages in the body are translated. An
 * answer filtered by the caller's AccessScope does not use this — its ETag
 * stays Express's hash of the body, which two callers share only when they
 * were sent the same bytes.
 */
export function notModified(req: Request, res: Response, ...validator: unknown[]): boolean {
  const etag = etagOf(req.headers['accept-language'] ?? null, ...validator);
  res.setHeader('ETag', etag);
  if (!etagMatches(req.headers['if-none-match'], etag)) return false;
  res.status(304);
  return true;
}
