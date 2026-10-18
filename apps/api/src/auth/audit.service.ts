import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditAction, AuditLogEntry } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntryInput {
  /** Null for a platform event that belongs to no workspace — a sign-in (#75). */
  workspaceId: string | null;
  actor: string;
  action: AuditAction;
  params: Record<string, unknown>;
  rowCount?: number;
  durationMs?: number;
  ok: boolean;
  error?: string;
  ip?: string | null;
  /** Who or what the action was done to: a user id, a provider id. */
  target?: string | null;
}

export interface AuditListFilter {
  action?: string;
  /** An entry id from a previous page: list what is older than it. */
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  entries: AuditLogEntry[];
  nextCursor: string | null;
}

/** `params` is free-form and written from request input; a cap keeps one row from being a dump. */
const MAX_PARAMS_BYTES = 8_192;

function cappedParams(params: Record<string, unknown>): object {
  const json = JSON.stringify(params);
  return json.length <= MAX_PARAMS_BYTES ? params : { truncated: true, bytes: json.length };
}

/**
 * The security audit trail (plan.md §11, #75): trusted-operator graph queries,
 * ACL bypasses and changes, and sign-ins, with actor, target and outcome.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Best-effort: an audit-write failure is logged loudly but never masks the result. */
  async record(entry: AuditEntryInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          ...entry,
          error: entry.error?.slice(0, 2000),
          params: cappedParams(entry.params),
          ip: entry.ip ?? null,
          target: entry.target ?? null,
        },
      });
    } catch (e) {
      this.logger.error(`AUDIT WRITE FAILED (${entry.action} by ${entry.actor}): ${(e as Error).message}`);
    }
  }

  /** One workspace's trail, newest first. */
  list(workspaceId: string, filter: AuditListFilter = {}): Promise<AuditPage> {
    return this.page({ workspaceId }, filter);
  }

  /** Every workspace's trail plus platform events (workspace_id null) — platform admins only. */
  listPlatform(filter: AuditListFilter = {}): Promise<AuditPage> {
    return this.page({}, filter);
  }

  private async page(scope: Prisma.AuditLogWhereInput, filter: AuditListFilter): Promise<AuditPage> {
    const take = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = await this.prisma.auditLog.findMany({
      where: { ...scope, ...(filter.action ? { action: filter.action } : {}) },
      // id breaks ties, so a page boundary inside one millisecond neither skips nor repeats.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      take: take + 1,
    });
    const entries = rows.slice(0, take).map(toEntry);
    return { entries, nextCursor: rows.length > take ? entries[entries.length - 1].id : null };
  }
}

function toEntry(r: Prisma.AuditLogGetPayload<object>): AuditLogEntry {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    actor: r.actor,
    action: r.action,
    params: r.params as Record<string, unknown>,
    rowCount: r.rowCount,
    durationMs: r.durationMs,
    ok: r.ok,
    error: r.error,
    ip: r.ip,
    target: r.target,
    createdAt: r.createdAt.toISOString(),
  };
}
