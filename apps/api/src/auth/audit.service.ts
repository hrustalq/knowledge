import { Injectable, Logger } from '@nestjs/common';
import type { AuditLogEntry } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntryInput {
  workspaceId: string;
  actor: string;
  action: string;
  params: Record<string, unknown>;
  rowCount?: number;
  durationMs?: number;
  ok: boolean;
  error?: string;
}

/**
 * Phase 5 audit trail (plan.md §11): all trusted-operator graph queries —
 * REST and MCP — are recorded with actor, query, row count and duration.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Best-effort: an audit-write failure is logged loudly but never masks the result. */
  async record(entry: AuditEntryInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: { ...entry, error: entry.error?.slice(0, 2000), params: entry.params as object },
      });
    } catch (e) {
      this.logger.error(`AUDIT WRITE FAILED (${entry.action} by ${entry.actor}): ${(e as Error).message}`);
    }
  }

  async list(workspaceId: string, limit = 50): Promise<AuditLogEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      actor: r.actor,
      action: r.action,
      params: r.params as Record<string, unknown>,
      rowCount: r.rowCount,
      durationMs: r.durationMs,
      ok: r.ok,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
