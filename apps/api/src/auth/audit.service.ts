import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { auditActionsIn, type AuditAction, type AuditCategory, type AuditLogEntry } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { activeTransaction } from '../prisma/transaction.js';
import { findSecret } from '../common/secret-scan.js';

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
  /** Narrower than `action`'s list, derived (#1251): an `action IN (…)` of the category's actions. */
  category?: AuditCategory;
  actor?: string;
  target?: string;
  /** Inclusive bounds on `createdAt`. */
  from?: Date;
  to?: Date;
  ok?: boolean;
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

/** What one export may carry (#1251): the file says when it stopped short rather than paging silently. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

function cappedParams(params: Record<string, unknown>): object {
  const json = JSON.stringify(params);
  return json.length <= MAX_PARAMS_BYTES ? params : { truncated: true, bytes: json.length };
}

/** A key that names a credential: `password`, `apiKey`, `webhookSecret`, `clientSecret`, `token`… A boolean (`hasToken`) stays. */
const SECRET_KEY = /(password|secret|token|apikey|credential|privatekey)$/i;
const REDACTED = '[redacted]';

/**
 * Secrets never reach a row (#1251), enforced here rather than at ~100 call sites: a key that names a
 * credential, or a string shaped like one (`SECRET_PATTERNS`), is replaced. Exported for the spec.
 */
export function redactParams(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return findSecret([value]) ? REDACTED : value;
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactParams(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && v != null && typeof v !== 'boolean' ? REDACTED : redactParams(v, depth + 1)]),
  );
}

/**
 * The security audit trail (plan.md §11, #75): trusted-operator graph queries,
 * ACL bypasses and changes, and sign-ins, with actor, target and outcome.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Best-effort: an audit-write failure is logged loudly but never masks the result.
   * Inside a transaction the row waits for the commit (#816): a swallowed
   * Postgres error would otherwise abort the caller's transaction, and a row
   * about a write that then rolls back records something that never happened.
   */
  async record(entry: AuditEntryInput): Promise<void> {
    if (activeTransaction()) return this.prisma.onCommit(() => this.write(entry));
    await this.write(entry);
  }

  private async write(entry: AuditEntryInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          ...entry,
          error: entry.error?.slice(0, 2000),
          params: cappedParams(redactParams(entry.params) as Record<string, unknown>),
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

  /**
   * The filtered set for a download, newest first, the same `where` the listing pages through, so the
   * file is what the screen showed. `truncated` when the cap cut it.
   */
  async exportRows(
    workspaceId: string | null,
    filter: AuditListFilter,
  ): Promise<{ entries: AuditLogEntry[]; truncated: boolean }> {
    const rows = await this.prisma.auditLog.findMany({
      where: { ...(workspaceId ? { workspaceId } : {}), ...whereOf(filter) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_EXPORT_MAX_ROWS + 1,
    });
    return { entries: rows.slice(0, AUDIT_EXPORT_MAX_ROWS).map(toEntry), truncated: rows.length > AUDIT_EXPORT_MAX_ROWS };
  }

  private async page(scope: Prisma.AuditLogWhereInput, filter: AuditListFilter): Promise<AuditPage> {
    const take = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const rows = await this.prisma.auditLog.findMany({
      where: { ...scope, ...whereOf(filter) },
      // id breaks ties, so a page boundary inside one millisecond neither skips nor repeats.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      take: take + 1,
    });
    const entries = rows.slice(0, take).map(toEntry);
    return { entries, nextCursor: rows.length > take ? entries[entries.length - 1].id : null };
  }
}

function whereOf(f: AuditListFilter): Prisma.AuditLogWhereInput {
  const inCategory: string[] | null = f.category ? auditActionsIn(f.category) : null;
  // An action outside the chosen category matches nothing, rather than one filter silently winning.
  const action = f.action ? (inCategory && !inCategory.includes(f.action) ? { in: [] } : f.action) : inCategory ? { in: inCategory } : undefined;
  return {
    ...(action !== undefined ? { action } : {}),
    ...(f.actor ? { actor: f.actor } : {}),
    ...(f.target ? { target: f.target } : {}),
    ...(f.ok !== undefined ? { ok: f.ok } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
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
