import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { TraceContext, TraceSource } from '@knowledge/contracts/observability';

/**
 * The ambient correlation scope. Every log record picks this up through the
 * logger's `mixin`, so a service never passes ids down just to log them.
 *
 * Modelled on apps/api's i18n/t.ts, and it exists for the same reason it does
 * there: middleware covers HTTP and nothing else. A BullMQ processor, a
 * websocket upgrade and an MCP stdio tool call each have to open their own scope
 * explicitly.
 */
const store = new AsyncLocalStorage<TraceContext>();

export function withTrace<T>(ctx: TraceContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentTrace(): TraceContext | undefined {
  return store.getStore();
}

/**
 * Attach fields to the active scope.
 *
 * `workspaceId` and `userId` are not knowable when the scope opens — the guards
 * resolve them after middleware has run — so the scope is mutable rather than
 * frozen at entry, and every record emitted afterwards carries them.
 *
 * Outside a scope this is a no-op, deliberately unlike nestjs-pino's `assign`,
 * which throws: the same service code runs under HTTP, a job and an MCP tool,
 * and a logging call must never be the thing that fails a request.
 */
export function bindTrace(fields: Partial<TraceContext>): void {
  const scope = store.getStore();
  if (!scope) return;
  Object.assign(scope, fields);
}

export function newTraceId(): string {
  return randomUUID();
}

/**
 * A request URL with credential-bearing query values masked, for logs (#102).
 *
 * `?token=` is still how EventSource and `<img>` authenticate, so the value
 * reaches the access log unless it is taken out here. Only the value goes: the
 * key stays, so a log still shows that a query token was sent. Case-insensitive
 * on the key; a malformed URL comes back with the same regex applied rather
 * than throwing, because a logging path must never fail a request.
 *
 * `code` and `state` are the OAuth callback pair (#297): the SSO callback and
 * the GitHub App setup callback both arrive as `?code=…&state=…`, and a share
 * site's `?code=` and the chat link's are single-use credentials too. Nothing
 * uses either name for a value an operator needs to read. `jwt_token` is a
 * published site's visitor JWT, reusable until it expires (#1112).
 */
const SECRET_QUERY_KEYS = /([?&](?:token|access_token|api_key|jwt_token|code|state)=)[^&#]*/gi;

/**
 * A share link's `kp_` token is a bearer credential carried in the path, not the
 * query (#1112): the API's `/v1/public/shares/<token>/…` and the web's
 * `/s/<token>/…`. Any `kp_` segment after either prefix goes, well-formed or not.
 */
const SHARE_PATH_TOKEN = /(\/(?:shares|s)\/kp_)[^/?#]*/g;

export function redactUrl(url: string): string;
export function redactUrl(url: string | undefined): string | undefined;
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(SECRET_QUERY_KEYS, '$1[REDACTED]').replace(SHARE_PATH_TOKEN, '$1[REDACTED]');
}

/**
 * An inbound X-Request-Id is kept only when it looks like an id (#1112): a UUID
 * is one case of the pattern. Anything else (oversized, marked up, chosen text)
 * would be echoed and stamped on every record and `ops_events` row, so it is
 * replaced by a fresh one.
 */
const INBOUND_TRACE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function acceptTraceId(inbound: string | undefined): string | undefined {
  return inbound && INBOUND_TRACE_ID.test(inbound) ? inbound : undefined;
}

/** Build a context for a unit of work starting now. */
export function startTrace(source: TraceSource, init: Partial<TraceContext> = {}): TraceContext {
  return { ...init, traceId: init.traceId ?? newTraceId(), source };
}
