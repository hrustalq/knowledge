import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type MemoryBank } from '@prisma/client';
import { AuditService } from '../auth/audit.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAccessService, type MemoryCaller } from './memory-access.service.js';
import { MemoryUnitsService } from './memory-units.service.js';
import type { BankBodyDto, DispositionDto } from './memory.dto.js';
import { DEFAULT_DISPOSITION, type BankConfigResponse, type BankListResponse, type BankProfileResponse, type DeleteResponse, type Disposition } from './memory-wire.js';

const dispositionOf = (row: Pick<MemoryBank, 'disposition'>): Disposition => ({ ...DEFAULT_DISPOSITION, ...(row.disposition as Partial<Disposition>) });

export function bankProfile(row: MemoryBank): BankProfileResponse {
  return { bank_id: row.bankId, name: row.name, disposition: dispositionOf(row), mission: row.mission, background: null };
}

/** The Hindsight bank config keys this server keeps per bank (#993); any other is a 400 that names these. */
export const BANK_CONFIG_KEYS = ['enable_observations', 'reflect_mission', 'disposition_skepticism', 'disposition_literalism', 'disposition_empathy'] as const;
type BankConfigKey = (typeof BANK_CONFIG_KEYS)[number];
const TRAIT_OF = { disposition_skepticism: 'skepticism', disposition_literalism: 'literalism', disposition_empathy: 'empathy' } as const;

export function bankConfig(row: MemoryBank): BankConfigResponse {
  const d = dispositionOf(row);
  const traits = Object.fromEntries(Object.entries(TRAIT_OF).map(([key, trait]) => [key, d[trait]]));
  return {
    bank_id: row.bankId,
    config: { enable_observations: row.enableObservations ?? true, reflect_mission: row.mission, ...traits },
    overrides: {
      ...(row.enableObservations !== null ? { enable_observations: row.enableObservations } : {}),
      ...(row.mission ? { reflect_mission: row.mission } : {}),
      ...Object.fromEntries(Object.entries(traits).filter(([key, v]) => v !== DEFAULT_DISPOSITION[TRAIT_OF[key as keyof typeof TRAIT_OF]])),
    },
  };
}

/**
 * A config PATCH's `updates`, read: keys in Hindsight's field form or its env
 * form (`HINDSIGHT_API_ENABLE_OBSERVATIONS`), each checked. `null` on
 * `enable_observations` returns it to the default. A key this server does not
 * keep is refused by name, rather than accepted and ignored.
 */
export function readConfigUpdates(updates: Record<string, unknown>, current: MemoryBank): Prisma.MemoryBankUpdateInput {
  const named = Object.entries(updates).map(([k, v]) => [k.replace(/^HINDSIGHT_API_/i, '').toLowerCase(), v] as const);
  const unknown = named.filter(([k]) => !(BANK_CONFIG_KEYS as readonly string[]).includes(k)).map(([k]) => k);
  if (unknown.length) throw new BadRequestException(t('error.memory.configKeyUnknown', { keys: unknown.join(', '), allowed: BANK_CONFIG_KEYS.join(', ') }));
  const data: Prisma.MemoryBankUpdateInput = {};
  const disposition = dispositionOf(current);
  for (const [key, value] of named as Array<readonly [BankConfigKey, unknown]>) {
    if (key === 'enable_observations') {
      if (value !== null && typeof value !== 'boolean') throw new BadRequestException(t('error.memory.configValueInvalid', { key, type: 'true, false or null' }));
      data.enableObservations = value;
    } else if (key === 'reflect_mission') {
      if (typeof value !== 'string' || value.length > 4000) throw new BadRequestException(t('error.memory.configValueInvalid', { key, type: 'a string of at most 4000 characters' }));
      data.mission = value;
    } else {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw new BadRequestException(t('error.memory.configValueInvalid', { key, type: 'an integer from 1 to 5' }));
      disposition[TRAIT_OF[key]] = value;
      data.disposition = disposition as unknown as Prisma.InputJsonObject;
    }
  }
  return data;
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
    private readonly units: MemoryUnitsService,
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
    const page = visible.slice(offset, offset + limit);
    const counts = await this.units.counts(page.map((b) => b.id));
    return {
      banks: page.map((b) => ({
        bank_id: b.bankId,
        name: b.name,
        disposition: dispositionOf(b),
        mission: b.mission,
        created_at: b.createdAt.toISOString(),
        updated_at: b.updatedAt.toISOString(),
        fact_count: counts.get(b.id) ?? 0,
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

  async config(caller: MemoryCaller, bankId: string): Promise<BankConfigResponse> {
    return bankConfig(await this.access.bank(caller, bankId));
  }

  async updateConfig(caller: MemoryCaller, bankId: string, updates: Record<string, unknown>): Promise<BankConfigResponse> {
    const bank = await this.access.bank(caller, bankId);
    return bankConfig(await this.prisma.memoryBank.update({ where: { id: bank.id }, data: readConfigUpdates(updates, bank) }));
  }

  async delete(caller: MemoryCaller, bankId: string): Promise<DeleteResponse> {
    const bank = await this.access.bank(caller, bankId);
    // Its memories cascade with the row; their vectors are dropped right after.
    const unitIds = (await this.prisma.memoryUnit.findMany({ where: { bankId: bank.id }, select: { id: true } })).map((u) => u.id);
    await this.prisma.memoryBank.delete({ where: { id: bank.id } });
    await this.units.dropVectors(bank.workspaceId, unitIds);
    void this.audit.record({
      workspaceId: caller.workspaceId,
      actor: caller.principal.userId,
      action: 'memory.bank_deleted',
      params: { name: bank.name, memories: unitIds.length },
      target: bankId,
      ok: true,
    });
    return { success: true, message: `Bank '${bankId}' deleted`, deleted_count: unitIds.length };
  }

  private async update(bank: MemoryBank, dto: BankBodyDto): Promise<BankProfileResponse> {
    return bankProfile(await this.prisma.memoryBank.update({ where: { id: bank.id }, data: changesOf(dto, dispositionOf(bank)) }));
  }
}
