import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { currentTrace } from '@knowledge/observability';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLUSH_MS = 2_000;
const MAX_BUFFER = 500;

export interface OpsEventInput {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
  durationMs?: number;
}

interface OpsEventRow {
  traceId: string;
  source: string;
  level: string;
  code: string | null;
  message: string;
  workspaceId: string | null;
  userId: string | null;
  route: string | null;
  durationMs: number | null;
  fields: Record<string, unknown>;
}

/** Errors serialize to {} under JSON.stringify, which is how a stack gets silently lost. */
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

let registered: OpsSinkService | undefined;

/** The sink, once DI has built it. Undefined before boot completes, by design. */
export function opsSink(): OpsSinkService | undefined {
  return registered;
}

/**
 * Parks the DI-resolved instance where the free function above can reach it —
 * the I18nRegistry pattern, so the logger adapter needs no injection.
 *
 * A function rather than assigning `this` to the module variable directly:
 * same effect, and it keeps the aliasing lint rule honest instead of suppressed.
 */
function register(sink: OpsSinkService | undefined): void {
  registered = sink;
}

/**
 * Persists error-level records to ops_events.
 *
 * Buffered and batched: a failing request should not also wait on an INSERT,
 * and a burst of errors is exactly when the database is least able to take one
 * write per record.
 *
 * Two disciplines this class must keep:
 *
 *  1. **It never logs through the logger.** A sink that logs its own failure
 *     through the thing that feeds it is a loop, and it would be a loop only
 *     under the conditions that already broke — writes to stderr directly,
 *     once per flush at most.
 *  2. **It never lets a bad value fail a batch.** workspace_id and user_id are
 *     UUID columns, and the values reaching them are not all trustworthy: under
 *     AUTH_MODE=none the workspace id is read straight off the request body.
 *     One non-uuid would reject the whole createMany, losing every other record
 *     in the batch — so they are validated here and demoted into `fields`.
 */
@Injectable()
export class OpsSinkService implements OnModuleInit, OnModuleDestroy {
  private buffer: OpsEventRow[] = [];
  private timer?: NodeJS.Timeout;
  private dropped = 0;
  private enabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.enabled = this.config.get('OPS_SINK_ENABLED', { infer: true });
    register(this);
  }

  record(entry: OpsEventInput): void {
    if (!this.enabled) return;
    if (this.buffer.length >= MAX_BUFFER) {
      this.dropped += 1;
      return;
    }

    const trace = currentTrace();
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry.fields ?? {})) {
      fields[key] = serialize(value);
    }

    const workspaceId = trace?.workspaceId;
    const userId = trace?.userId;
    // Demoted rather than dropped: an id that is not a uuid is itself a finding.
    if (workspaceId && !UUID_RE.test(workspaceId)) fields.rawWorkspaceId = workspaceId;
    if (userId && !UUID_RE.test(userId)) fields.rawUserId = userId;

    const code = fields.code;
    this.buffer.push({
      traceId: trace?.traceId ?? 'unscoped',
      source: trace?.source ?? 'cli',
      level: entry.level,
      code: typeof code === 'string' ? code : null,
      message: entry.message.slice(0, 2_000),
      workspaceId: workspaceId && UUID_RE.test(workspaceId) ? workspaceId : null,
      userId: userId && UUID_RE.test(userId) ? userId : null,
      route: trace?.route ?? null,
      durationMs: entry.durationMs ?? null,
      fields,
    });

    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];
    const dropped = this.dropped;
    this.dropped = 0;

    try {
      await this.prisma.opsEvent.createMany({
        data: batch.map((row) => ({ ...row, fields: row.fields as never })),
      });
      if (dropped > 0) {
        process.stderr.write(`{"level":"warn","msg":"ops sink dropped ${dropped} record(s) — buffer full"}\n`);
      }
    } catch (e) {
      // Direct to stderr: see the class docstring. One line, not a stack — this
      // path runs when the database is already unhappy.
      process.stderr.write(
        `{"level":"error","msg":"ops sink flush failed","count":${batch.length},"error":${JSON.stringify(
          (e as Error).message,
        )}}\n`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    register(undefined);
    await this.flush();
  }
}
