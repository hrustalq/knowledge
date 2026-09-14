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

/** Build a context for a unit of work starting now. */
export function startTrace(source: TraceSource, init: Partial<TraceContext> = {}): TraceContext {
  return { ...init, traceId: init.traceId ?? newTraceId(), source };
}
