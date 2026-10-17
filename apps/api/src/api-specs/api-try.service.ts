import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  API_TRY_MAX_REQUEST_BYTES,
  apiServerOptions,
  normalizeEntityKey,
  type ApiTryHeader,
  type ApiTryRequest,
  type ApiTryResponse,
} from '@knowledge/contracts';
import { AuditService } from '../auth/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { SourcePolicyService } from '../ai/source-policy.service.js';
import { safeFetch } from '../common/safe-fetch.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublicRateLimiter, RateLimitedException } from '../public/public-rate-limit.js';
import { ApiSettingsService } from './api-settings.service.js';
import { ApiSpecReadService } from './api-spec-read.service.js';

/** A substitute for `safeFetch` (specs); production dials through the guarded agent. */
export const API_TRY_FETCH = Symbol('API_TRY_FETCH');
export type ApiTryFetch = (url: string, init: RequestInit, allowPrivate: boolean) => Promise<Response>;

/**
 * Request headers the proxy never forwards. `Host` and `Cookie` would let a
 * request pose as something it is not; the rest belong to the connection
 * between us and the target, which undici owns.
 */
const REQUEST_HEADER_DENY = new Set([
  'host',
  'cookie',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
  'forwarded',
  'x-real-ip',
]);

/**
 * Response headers dropped on the way back. `Set-Cookie` above all: the target
 * must not be able to set state through our origin. The length and encoding
 * describe bytes undici already decoded, so they would misdescribe the body.
 */
const RESPONSE_HEADER_DENY = new Set([
  'set-cookie',
  'set-cookie2',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'transfer-encoding',
  'trailer',
  'upgrade',
  'content-encoding',
  'content-length',
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const TEXTUAL = /^(text\/|application\/([\w.+-]*\+)?(json|xml|yaml|x-yaml|javascript|x-www-form-urlencoded|graphql))/iu;

/**
 * The try-it proxy (#78): one request, from a person, to a server their spec
 * names — for an API that refuses CORS, which the browser-direct console
 * cannot reach.
 *
 * Every guard is at the point of action, none in the client:
 *
 *  - the mode is the workspace's, clamped to API_TRY_PROXY_MODE, and `off`
 *    refuses before anything else is read;
 *  - the target is a server of **the revision being viewed** and the path is
 *    the operation's own, so a spec cannot be used to reach anything it does
 *    not describe — and a server variable is only ever one of its enum values;
 *  - the host passes the workspace's source policies (feature 25), and the
 *    connection goes through `safeFetch`, which refuses a private address in
 *    the connection's own DNS lookup, so a rebinding name cannot slip past;
 *  - redirects are returned, not followed; bodies are capped both ways;
 *  - it is counted per user in Redis and audited as method, host and path
 *    template — never headers, never a body, so a credential is never kept.
 *
 * Not an MCP tool: an agent must not be able to send arbitrary HTTP through us.
 */
@Injectable()
export class ApiTryService {
  private readonly fetcher: ApiTryFetch;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly settings: ApiSettingsService,
    private readonly reads: ApiSpecReadService,
    private readonly sourcePolicies: SourcePolicyService,
    private readonly audit: AuditService,
    private readonly limiter: PublicRateLimiter,
    @Optional() @Inject(API_TRY_FETCH) fetcher?: ApiTryFetch,
  ) {
    this.fetcher = fetcher ?? ((url, init, allowPrivate) => safeFetch(url, init, allowPrivate));
  }

  async send(principal: Principal, documentId: string, req: ApiTryRequest): Promise<ApiTryResponse> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId }, select: { workspaceId: true } });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    const workspaceId = doc.workspaceId;

    const mode = await this.settings.effectiveTryMode(workspaceId);
    if (mode === 'off') {
      throw new ForbiddenException({ statusCode: 403, message: t('error.apiTry.disabled'), reason: 'proxy-off' });
    }
    const perMinute = this.config.get('API_TRY_RATE_PER_MINUTE', { infer: true });
    // Fails closed: an outage must not mean an unmetered proxy.
    if (!(await this.limiter.hit(`api-try:${principal.userId}`, perMinute, 60_000, false))) {
      throw new RateLimitedException(t('error.apiTry.rateLimited'), 60, 'api-try');
    }

    const body = req.body ?? null;
    const bytes = body === null ? 0 : Buffer.byteLength(body, 'utf8');
    if (bytes > API_TRY_MAX_REQUEST_BYTES) {
      throw new PayloadTooLargeException(t('error.apiTry.tooLarge', { bytes, limit: API_TRY_MAX_REQUEST_BYTES }));
    }

    const { target, method, pathTemplate } = await this.resolveTarget(documentId, req);
    const allowPrivate = this.config.get('API_TRY_ALLOW_PRIVATE_URLS', { infer: true });
    const decision = await this.sourcePolicies.decide(workspaceId, target.href, mode, { allowPrivate });
    if (!decision.ok) {
      if (decision.reason === 'unsafe') {
        // The policy check refuses a name that does not resolve as unsafe (deny
        // by default); say which, since "private address" would send a reader
        // looking for the wrong problem.
        const host = target.hostname.replace(/^\[|\]$/gu, '');
        if (!isIP(host) && !(await lookup(host).then(() => true, () => false))) {
          throw new BadGatewayException(t('error.apiTry.unresolved', { host }));
        }
        throw new BadRequestException({ statusCode: 400, message: t('error.apiTry.privateAddress', { host: target.hostname }), reason: 'unsafe' });
      }
      throw new ForbiddenException({ statusCode: 403, message: t('error.apiTry.notAllowed', { host: target.hostname }), reason: decision.reason });
    }

    const { headers, dropped } = forwardable(req.headers ?? []);
    const timeoutMs = this.config.get('API_TRY_TIMEOUT_MS', { infer: true });
    const maxBytes = this.config.get('API_TRY_MAX_RESPONSE_BYTES', { infer: true });
    const auditBase = {
      workspaceId,
      actor: principal.userId,
      action: 'api.try',
      // What was tried, never with what: no header, no query, no body.
      params: { documentId, revisionId: req.revisionId, entityKey: normalizeEntityKey(req.entityKey), method, host: target.host, path: pathTemplate },
    };

    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetcher(
        target.href,
        {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : (body ?? undefined),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        },
        allowPrivate,
      );
    } catch (e) {
      const durationMs = Date.now() - started;
      const err = failure(e, target.hostname, timeoutMs);
      void this.audit.record({ ...auditBase, durationMs, ok: false, error: err.message });
      throw err;
    }
    const read = await readCapped(res, maxBytes);
    const durationMs = Date.now() - started;
    void this.audit.record({ ...auditBase, params: { ...auditBase.params, status: res.status }, durationMs, ok: true });

    const contentType = res.headers.get('content-type') ?? '';
    const asText = read.bytes.length === 0 || TEXTUAL.test(contentType);
    return {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()]
        .filter(([name]) => !RESPONSE_HEADER_DENY.has(name.toLowerCase()))
        .map(([name, value]) => ({ name, value })),
      body: asText ? new TextDecoder().decode(read.bytes) : Buffer.from(read.bytes).toString('base64'),
      encoding: asText ? 'utf8' : 'base64',
      bytes: read.bytes.length,
      truncated: read.truncated,
      durationMs,
      droppedHeaders: dropped,
    };
  }

  /**
   * The URL, only if it is this operation on a server of this revision: same
   * origin as one of the spec's concrete server URLs, under its path, and the
   * rest of the path shaped like the operation's template.
   */
  private async resolveTarget(
    documentId: string,
    req: ApiTryRequest,
  ): Promise<{ target: URL; method: string; pathTemplate: string }> {
    const revision = await this.prisma.documentRevision.findUnique({ where: { id: req.revisionId } });
    if (!revision || revision.documentId !== documentId) {
      throw new NotFoundException(t('error.revision.notFoundOnDocument', { revisionId: req.revisionId, documentId }));
    }
    if (revision.status === 'draft') throw new BadRequestException(t('error.apiTry.revisionDraft', { id: revision.id }));

    const method = req.method.toUpperCase();
    const entityKey = normalizeEntityKey(req.entityKey);
    const op = await this.prisma.apiOperation.findFirst({
      where: { revisionId: revision.id, entityKey, method, protocol: 'http' },
    });
    if (!op) throw new BadRequestException(t('error.apiTry.operationNotInSpec', { method, entityKey }));

    const { document } = await this.reads.spec(documentId, revision.id);
    const servers = apiServerOptions(document)
      .map((s) => {
        try {
          const u = new URL(s.url);
          return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
        } catch {
          return null; // A relative server URL has no origin to send to.
        }
      })
      .filter((u): u is URL => u !== null);
    if (servers.length === 0) throw new BadRequestException(t('error.apiTry.relativeServer'));

    const refuse = () =>
      new BadRequestException({
        statusCode: 400,
        message: t('error.apiTry.targetNotInSpec', { url: req.url, method, path: op.path }),
        reason: 'target-not-in-spec',
      });
    let target: URL;
    try {
      target = new URL(req.url);
    } catch {
      throw refuse();
    }
    if (target.username || target.password) throw refuse();
    target.hash = '';

    const shape = templatePattern(op.path);
    const matches = servers.some((server) => {
      if (server.origin !== target.origin) return false;
      const base = server.pathname.replace(/\/+$/u, '');
      if (base && target.pathname !== base && !target.pathname.startsWith(`${base}/`)) return false;
      return shape.test(target.pathname.slice(base.length) || '/');
    });
    if (!matches) throw refuse();
    return { target, method, pathTemplate: op.path };
  }
}

/** `/users/{id}/posts` → a pattern where each `{param}` is one non-empty segment. */
export function templatePattern(path: string): RegExp {
  const source = path
    .replace(/\/+$/u, '')
    .split(/(\{[^}]*\})/u)
    .map((part) => (part.startsWith('{') && part.endsWith('}') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
    .join('');
  return new RegExp(`^${source || ''}/?$`, 'u');
}

/** The headers that may be forwarded, and the names of those that may not. */
export function forwardable(list: ApiTryHeader[]): { headers: Record<string, string>; dropped: string[] } {
  const headers: Record<string, string> = {};
  const dropped: string[] = [];
  for (const { name, value } of list) {
    const lower = name.trim().toLowerCase();
    if (!lower) continue;
    if (
      REQUEST_HEADER_DENY.has(lower) ||
      lower.startsWith('x-forwarded-') ||
      lower.startsWith('proxy-') ||
      !HEADER_NAME.test(lower) ||
      /[\r\n\0]/u.test(value)
    ) {
      dropped.push(name.trim());
      continue;
    }
    headers[lower] = value;
  }
  return { headers, dropped };
}

/** Read at most `max` bytes; the rest of the stream is cancelled, not drained. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { bytes, truncated };
}

/** A failed dial, in words: a timeout, a refused private address, or anything else. */
function failure(e: unknown, host: string, timeoutMs: number): Error {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return new GatewayTimeoutException(t('error.apiTry.timeout', { host, seconds: Math.round(timeoutMs / 1000) }));
  }
  if (err.cause?.code === 'EBLOCKEDADDRESS') {
    return new BadRequestException({ statusCode: 400, message: t('error.apiTry.privateAddress', { host }), reason: 'unsafe' });
  }
  return new BadGatewayException(t('error.apiTry.unreachable', { host, reason: err.cause?.message ?? err.message }));
}
