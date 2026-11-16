import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditAction } from '@knowledge/contracts';
import { tap, type Observable } from 'rxjs';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAccessService } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';

const MEMORY_AUDIT = 'memory-audit';

interface MemoryAuditEntry {
  action: AuditAction;
  /** Which write of several sharing one action: `create`, `delete`, `config`… */
  op?: string;
}

/**
 * The audit row a memory REST write records once it has succeeded (#1168).
 * A write that MCP reaches too records at its shared door instead — retain in
 * `MemoryIntakeService.retain`, the memory tool in `MemoryFilesService.execute`,
 * the graph in `MemoryGraphService` — so a route there carries no decorator.
 */
export const MemoryAudit = (entry: MemoryAuditEntry) => SetMetadata(MEMORY_AUDIT, entry);

/**
 * Records `@MemoryAudit` routes after the handler resolved, so a refused or
 * failed write records nothing. The bank is named by `:bankId` (an id or an
 * alias, in the workspace the request resolved to) or by the bank page's
 * `:id`; the row is filed under its `bank_id`. The other route params are the
 * row's `params`: ids only, never a body.
 */
@Injectable()
export class MemoryAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly access: MemoryAccessService,
    private readonly banks: MemoryBanksService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const entry = this.reflector.get<MemoryAuditEntry | undefined>(MEMORY_AUDIT, ctx.getHandler());
    if (!entry) return next.handle();
    const req = ctx.switchToHttp().getRequest<{
      principal: Principal;
      params: Record<string, string>;
      headers: Record<string, string | string[] | undefined>;
    }>();
    return next.handle().pipe(tap(() => void this.record(req, entry).catch(() => undefined)));
  }

  private async record(
    req: { principal: Principal; params: Record<string, string>; headers: Record<string, string | string[] | undefined> },
    entry: MemoryAuditEntry,
  ): Promise<void> {
    const { bankId, id, ...named } = req.params;
    const header = req.headers['x-workspace-id'];
    const bank = id
      ? await this.prisma.memoryBank.findUnique({ where: { id }, select: { workspaceId: true, bankId: true } })
      : await this.access.named(this.access.workspaceOf(req.principal, typeof header === 'string' ? header : undefined), bankId!);
    if (!bank) return;
    this.banks.recordWrite(bank.workspaceId, req.principal.userId, bank.bankId, {
      action: entry.action,
      params: { ...named, ...(entry.op ? { op: entry.op } : {}) },
    });
  }
}
