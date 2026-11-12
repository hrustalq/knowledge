import { Injectable } from '@nestjs/common';
import { Prisma, type MemoryBank } from '@prisma/client';
import { AuditService } from '../auth/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAccessService, type MemoryCaller } from './memory-access.service.js';
import type { BankBodyDto, DispositionDto } from './memory.dto.js';
import { DEFAULT_DISPOSITION, type BankListResponse, type BankProfileResponse, type DeleteResponse, type Disposition } from './memory-wire.js';

const dispositionOf = (row: Pick<MemoryBank, 'disposition'>): Disposition => ({ ...DEFAULT_DISPOSITION, ...(row.disposition as Partial<Disposition>) });

export function bankProfile(row: MemoryBank): BankProfileResponse {
  return { bank_id: row.bankId, name: row.name, disposition: dispositionOf(row), mission: row.mission, background: null };
}

/** What a bank body changes; a field the client left out is absent, so it is left as stored. */
function changesOf(dto: BankBodyDto, current: Disposition): Prisma.MemoryBankUpdateInput {
  const mission = dto.reflect_mission ?? dto.mission ?? dto.background;
  const disposition: Disposition = {
    skepticism: dto.disposition_skepticism ?? dto.disposition?.skepticism ?? current.skepticism,
    literalism: dto.disposition_literalism ?? dto.disposition?.literalism ?? current.literalism,
    empathy: dto.disposition_empathy ?? dto.disposition?.empathy ?? current.empathy,
  };
  return {
    ...(dto.name != null ? { name: dto.name } : {}),
    ...(mission != null ? { mission } : {}),
    disposition: disposition as unknown as Prisma.InputJsonObject,
  };
}

/** Banks (#986 phase 0). Every method takes the caller `MemoryAccessService` resolved. */
@Injectable()
export class MemoryBanksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MemoryAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(caller: MemoryCaller, query: { q?: string; limit?: number; offset?: number }): Promise<BankListResponse> {
    const q = query.q?.trim();
    const rows = await this.prisma.memoryBank.findMany({
      where: {
        workspaceId: caller.workspaceId,
        ...(q ? { OR: [{ bankId: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    // ponytail: filtered and paged in memory, a workspace holds a handful of banks; page in SQL if one holds thousands.
    const visible = await this.access.visible(caller.scope, rows);
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    return {
      banks: visible.slice(offset, offset + limit).map((b) => ({
        bank_id: b.bankId,
        name: b.name,
        disposition: dispositionOf(b),
        mission: b.mission,
        created_at: b.createdAt.toISOString(),
        updated_at: b.updatedAt.toISOString(),
        fact_count: 0,
      })),
      total: visible.length,
      limit,
      offset,
    };
  }

  /** The bank, created with defaults when the workspace has none by that id. A race on the unique key resolves to the row that won. */
  async ensure(caller: MemoryCaller, bankId: string): Promise<MemoryBank> {
    const existing = await this.access.find(caller, bankId);
    if (existing) return existing;
    try {
      const row = await this.prisma.memoryBank.create({
        data: { workspaceId: caller.workspaceId, bankId, name: bankId, createdBy: caller.principal.userId },
      });
      void this.audit.record({
        workspaceId: caller.workspaceId,
        actor: caller.principal.userId,
        action: 'memory.bank_created',
        params: {},
        target: bankId,
        ok: true,
      });
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return this.access.bank(caller, bankId);
      throw e;
    }
  }

  /** PUT: create or update. */
  async put(caller: MemoryCaller, bankId: string, dto: BankBodyDto): Promise<BankProfileResponse> {
    return this.update(await this.ensure(caller, bankId), dto);
  }

  /** PATCH: update a bank that exists. */
  async patch(caller: MemoryCaller, bankId: string, dto: BankBodyDto): Promise<BankProfileResponse> {
    return this.update(await this.access.bank(caller, bankId), dto);
  }

  async profile(caller: MemoryCaller, bankId: string): Promise<BankProfileResponse> {
    return bankProfile(await this.access.bank(caller, bankId));
  }

  async setDisposition(caller: MemoryCaller, bankId: string, disposition: DispositionDto): Promise<BankProfileResponse> {
    return this.update(await this.access.bank(caller, bankId), { disposition });
  }

  async delete(caller: MemoryCaller, bankId: string): Promise<DeleteResponse> {
    const bank = await this.access.bank(caller, bankId);
    await this.prisma.memoryBank.delete({ where: { id: bank.id } });
    void this.audit.record({
      workspaceId: caller.workspaceId,
      actor: caller.principal.userId,
      action: 'memory.bank_deleted',
      params: { name: bank.name },
      target: bankId,
      ok: true,
    });
    return { success: true, message: `Bank '${bankId}' deleted`, deleted_count: 0 };
  }

  private async update(bank: MemoryBank, dto: BankBodyDto): Promise<BankProfileResponse> {
    return bankProfile(await this.prisma.memoryBank.update({ where: { id: bank.id }, data: changesOf(dto, dispositionOf(bank)) }));
  }
}
