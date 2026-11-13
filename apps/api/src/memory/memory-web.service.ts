import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type MemoryBank, type MemoryUnit } from '@prisma/client';
import {
  MEMORY_ORIGIN_PLATFORM,
  type CaptureResult,
  type MemoryBankListResponse,
  type MemoryBankSummary,
  type MemoryEntityListResponse,
  type MemoryFileContent,
  type MemoryFileListResponse,
  type MemoryFileSummary,
  type MemoryPromoteKind,
  type MemoryUnitListResponse,
  type MemoryUnitSummary,
  type MemoryUnitType,
} from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';
import { CaptureService } from '../captures/capture.service.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAccessService, type MemoryCaller } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';
import { MemoryConsolidationService } from './memory-consolidation.service.js';
import { MemoryFilesService } from './memory-files.service.js';
import { MemoryGraphService } from './memory-graph.service.js';
import { MemoryUnitsService } from './memory-units.service.js';

type Unit = MemoryUnit & { entities: Array<{ name: string; entityKey: string }>; _count: { evidence: number } };

function unitSummary(row: Unit): MemoryUnitSummary {
  return {
    id: row.id,
    type: row.factType as MemoryUnitType,
    text: row.text,
    context: row.context,
    tags: row.tags,
    entities: row.entities.map((e) => e.name),
    proofCount: row.factType === 'observation' ? row._count.evidence : 1,
    occurredAt: (row.occurredStart ?? row.mentionedAt)?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function fileSummary(row: { id: string; path: string; size: number; updatedAt: Date }): MemoryFileSummary {
  return { id: row.id, path: row.path, size: row.size, updatedAt: row.updatedAt.toISOString() };
}

/**
 * Memory banks on this platform's own web routes (#994): the settings
 * section's list, a bank's memories, delete, project binding and promote;
 * and (#1010) the entities and files the two other wires wrote, read-only
 * but for delete. API-only — promote reaches `CaptureService`, and the
 * graph and file deletes their API-only services.
 *
 * The route's `@Access` already resolved the bank row's workspace in PG; what
 * this adds is the bank's own rule (`MemoryAccessService.visible`): a bank
 * bound to a project the caller cannot see is a 404, as on the wire.
 */
@Injectable()
export class MemoryWebService {
  private readonly apiUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MemoryAccessService,
    private readonly banks: MemoryBanksService,
    private readonly unitStore: MemoryUnitsService,
    private readonly consolidation: MemoryConsolidationService,
    private readonly permissions: PermissionService,
    private readonly captures: CaptureService,
    private readonly graph: MemoryGraphService,
    private readonly files: MemoryFilesService,
    config: ConfigService<Env, true>,
  ) {
    this.apiUrl = config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
  }

  async list(principal: Principal, workspaceId: string): Promise<MemoryBankListResponse> {
    const caller = await this.callerFor(principal, workspaceId);
    const rows = await this.prisma.memoryBank.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    const visible = await this.access.visible(caller.scope, rows);
    const [summaries, blocked] = await Promise.all([this.summaries(visible), this.consolidation.blocker({ workspaceId, enableObservations: null })]);
    return { banks: summaries, apiUrl: this.apiUrl, consolidation: blocked === null };
  }

  async memories(principal: Principal, id: string, query: { type?: MemoryUnitType; q?: string; limit?: number; offset?: number }): Promise<MemoryUnitListResponse> {
    const { bank } = await this.bankFor(principal, id);
    const q = query.q?.trim();
    const where: Prisma.MemoryUnitWhereInput = {
      bankId: bank.id,
      ...(query.type ? { factType: query.type } : {}),
      ...(q ? { text: { contains: q, mode: 'insensitive' } } : {}),
    };
    const [rows, total, [summary]] = await Promise.all([
      this.prisma.memoryUnit.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: query.offset ?? 0,
        take: query.limit ?? 50,
        include: { entities: { select: { name: true, entityKey: true } }, _count: { select: { evidence: true } } },
      }),
      this.prisma.memoryUnit.count({ where }),
      this.summaries([bank]),
    ]);
    return { bank: summary!, items: rows.map(unitSummary), total };
  }

  async deleteUnit(principal: Principal, id: string, unitId: string): Promise<void> {
    const { bank } = await this.bankFor(principal, id);
    if (!(await this.unitStore.deleteOne(bank, unitId))) throw new NotFoundException(t('error.memory.memoryNotFound', { id: unitId }));
  }

  /** Deleting a bank asks for its name, typed: the server checks what the dialog asked for. */
  async deleteBank(principal: Principal, id: string, confirm: string | undefined): Promise<void> {
    const { bank, caller } = await this.bankFor(principal, id);
    if (confirm !== bank.bankId) throw new BadRequestException(t('error.memory.confirmBankId', { bankId: bank.bankId }));
    await this.banks.delete(caller, bank.bankId);
  }

  /**
   * Binds the bank to a project, or to the whole workspace (null). Moving a
   * bank changes who can read it, so the caller must be able to manage the
   * project it leaves and the one it joins (`requireProjectManage`), not just
   * hold the editor role.
   */
  async bind(principal: Principal, id: string, projectId: string | null): Promise<MemoryBankSummary> {
    const { bank } = await this.bankFor(principal, id);
    if (projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: projectId, workspaceId: bank.workspaceId }, select: { id: true } });
      if (!project) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    }
    for (const touched of new Set([bank.projectId, projectId])) if (touched) await this.permissions.requireProjectManage(principal, touched);
    const updated = await this.prisma.memoryBank.update({ where: { id: bank.id }, data: { projectId } });
    return (await this.summaries([updated]))[0]!;
  }

  /**
   * A memory becomes a capture, and so a merge request a person reviews
   * (`provenance: 'captured'`). The memory stays in the bank. The origin is
   * the server's — the bank and when the memory was written — never a field
   * the caller sends; capture's own checks (the switch, project, secrets,
   * rate) all apply.
   */
  async promote(principal: Principal, id: string, unitId: string, input: { projectId: string; title: string; kind: MemoryPromoteKind }): Promise<CaptureResult> {
    const { bank } = await this.bankFor(principal, id);
    const unit = await this.prisma.memoryUnit.findFirst({ where: { id: unitId, bankId: bank.id }, include: { entities: { select: { entityKey: true } } } });
    if (!unit) throw new NotFoundException(t('error.memory.memoryNotFound', { id: unitId }));
    return this.captures.capture(
      {
        workspaceId: bank.workspaceId,
        session: { client: 'other' },
        kind: input.kind,
        projectId: input.projectId,
        title: input.title,
        body: unit.text,
        ...(unit.entities.length ? { appliesTo: unit.entities.slice(0, 20).map((e) => e.entityKey) } : {}),
      },
      principal,
      {
        origin: {
          platform: MEMORY_ORIGIN_PLATFORM,
          chatTitle: bank.name === bank.bankId ? bank.bankId : `${bank.name} (${bank.bankId})`,
          from: unit.createdAt.toISOString(),
          to: unit.updatedAt.toISOString(),
        },
      },
    );
  }

  /**
   * The graph wire's entities (#1008), in creation order, each with its
   * observations, and every relation touching one of them. `q` matches a
   * name, a type or an observation's text, as the wire's `search_nodes` does.
   */
  async entities(principal: Principal, id: string, query: { q?: string; limit?: number; offset?: number }): Promise<MemoryEntityListResponse> {
    const { bank } = await this.bankFor(principal, id);
    const q = query.q?.trim() || null;
    const match = Prisma.sql`e.bank_id = ${bank.id}::uuid AND (${q}::text IS NULL
      OR strpos(lower(e.name), lower(${q})) > 0
      OR strpos(lower(e.entity_type), lower(${q})) > 0
      OR EXISTS (SELECT 1 FROM memory_units u
                  WHERE u.bank_id = e.bank_id AND u.fact_type <> 'observation'
                    AND u.document_id LIKE 'graph:' || e.id::text || ':%'
                    AND strpos(lower(u.text), lower(${q})) > 0))`;
    const [rows, [count], [summary]] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; name: string; entityType: string; createdAt: Date }>>`
        SELECT e.id, e.name, e.entity_type AS "entityType", e.created_at AS "createdAt"
          FROM memory_entities e WHERE ${match}
         ORDER BY e.position LIMIT ${query.limit ?? 50} OFFSET ${query.offset ?? 0}`,
      this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM memory_entities e WHERE ${match}`,
      this.summaries([bank]),
    ]);
    const ids = rows.map((r) => r.id);
    const [observed, relations] = ids.length
      ? await Promise.all([
          this.prisma.$queryRaw<Array<{ id: string; entityId: string; text: string }>>`
            SELECT id, split_part(document_id, ':', 2) AS "entityId", text FROM memory_units
             WHERE bank_id = ${bank.id}::uuid AND fact_type <> 'observation' AND document_id LIKE 'graph:%'
               AND split_part(document_id, ':', 2) = ANY(${ids}::text[])
             ORDER BY document_id, id`,
          this.prisma.$queryRaw<MemoryEntityListResponse['relations']>`
            SELECT r.id, r.from_id AS "fromId", f.name AS "from", r.to_id AS "toId", t.name AS "to", r.relation_type AS "relationType"
              FROM memory_relations r
              JOIN memory_entities f ON f.id = r.from_id
              JOIN memory_entities t ON t.id = r.to_id
             WHERE r.bank_id = ${bank.id}::uuid AND (r.from_id = ANY(${ids}::uuid[]) OR r.to_id = ANY(${ids}::uuid[]))
             ORDER BY r.position`,
        ])
      : [[], []];
    return {
      bank: summary!,
      entities: rows.map((r) => ({
        id: r.id,
        name: r.name,
        entityType: r.entityType,
        observations: observed.filter((o) => o.entityId === r.id).map((o) => ({ id: o.id, text: o.text })),
        createdAt: r.createdAt.toISOString(),
      })),
      relations,
      total: count?.n ?? 0,
    };
  }

  /** One entity, with its observations and every relation touching it. */
  async deleteEntity(principal: Principal, id: string, entityId: string): Promise<void> {
    const { bank } = await this.bankFor(principal, id);
    if (!(await this.graph.removeEntities(bank, [entityId]))) throw new NotFoundException(t('error.memory.entityNotFound', { id: entityId }));
  }

  /** One relation; both entities stay. */
  async deleteRelation(principal: Principal, id: string, relationId: string): Promise<void> {
    const { bank } = await this.bankFor(principal, id);
    const { count } = await this.prisma.memoryRelation.deleteMany({ where: { id: relationId, bankId: bank.id } });
    if (!count) throw new NotFoundException(t('error.memory.relationNotFound', { id: relationId }));
  }

  /** The memory tool's files (#1009), by path, without their text; `q` matches a path. */
  async fileList(principal: Principal, id: string, query: { q?: string; limit?: number; offset?: number }): Promise<MemoryFileListResponse> {
    const { bank } = await this.bankFor(principal, id);
    const q = query.q?.trim() || null;
    const match = Prisma.sql`bank_id = ${bank.id}::uuid AND (${q}::text IS NULL OR strpos(lower(path), lower(${q})) > 0)`;
    const [rows, [count], [summary]] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; path: string; size: number; updatedAt: Date }>>`
        SELECT id, path, octet_length(content)::int AS size, updated_at AS "updatedAt" FROM memory_files
         WHERE ${match} ORDER BY path LIMIT ${query.limit ?? 50} OFFSET ${query.offset ?? 0}`,
      this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM memory_files WHERE ${match}`,
      this.summaries([bank]),
    ]);
    return { bank: summary!, files: rows.map(fileSummary), total: count?.n ?? 0 };
  }

  /** One file's text, as stored. */
  async file(principal: Principal, id: string, fileId: string): Promise<MemoryFileContent> {
    const { bank } = await this.bankFor(principal, id);
    const row = await this.prisma.memoryFile.findFirst({ where: { id: fileId, bankId: bank.id }, select: { id: true, path: true, content: true, updatedAt: true } });
    if (!row) throw new NotFoundException(t('error.memory.fileNotFound', { id: fileId }));
    return { ...fileSummary({ ...row, size: Buffer.byteLength(row.content) }), content: row.content };
  }

  /** One file, with its recall chunks, through the memory tool's own delete. */
  async deleteFile(principal: Principal, id: string, fileId: string): Promise<void> {
    const { bank } = await this.bankFor(principal, id);
    if (!(await this.files.removeFile(bank, fileId))) throw new NotFoundException(t('error.memory.fileNotFound', { id: fileId }));
  }

  /** The bank row `@Access` resolved, held to the bank's own visibility rule. */
  private async bankFor(principal: Principal, id: string): Promise<{ bank: MemoryBank; caller: MemoryCaller }> {
    const bank = await this.prisma.memoryBank.findUnique({ where: { id } });
    if (!bank) throw new NotFoundException(t('error.memory.bankRowNotFound', { id }));
    const caller = await this.callerFor(principal, bank.workspaceId);
    if (!(await this.access.visible(caller.scope, [bank])).length) throw new NotFoundException(t('error.memory.bankRowNotFound', { id }));
    return { bank, caller };
  }

  private async callerFor(principal: Principal, workspaceId: string): Promise<MemoryCaller> {
    return { principal, workspaceId, scope: await this.permissions.scopeFor(principal, workspaceId) };
  }

  private async summaries(banks: MemoryBank[]): Promise<MemoryBankSummary[]> {
    const ids = banks.map((b) => b.id);
    const [byType, last, entities, files] = ids.length
      ? await Promise.all([
          this.prisma.memoryUnit.groupBy({ by: ['bankId', 'factType'], where: { bankId: { in: ids } }, _count: { _all: true } }),
          this.prisma.memoryUnit.groupBy({ by: ['bankId'], where: { bankId: { in: ids } }, _max: { updatedAt: true } }),
          this.prisma.memoryEntity.groupBy({ by: ['bankId'], where: { bankId: { in: ids } }, _count: { _all: true } }),
          this.prisma.memoryFile.groupBy({ by: ['bankId'], where: { bankId: { in: ids } }, _count: { _all: true } }),
        ])
      : [[], [], [], []];
    const entitiesOf = new Map(entities.map((r) => [r.bankId, r._count._all]));
    const filesOf = new Map(files.map((r) => [r.bankId, r._count._all]));
    const count = (bankId: string, observation: boolean) =>
      byType.filter((r) => r.bankId === bankId && (r.factType === 'observation') === observation).reduce((n, r) => n + r._count._all, 0);
    const lastOf = new Map(last.map((r) => [r.bankId, r._max.updatedAt]));
    return banks.map((b) => ({
      id: b.id,
      bankId: b.bankId,
      name: b.name,
      projectId: b.projectId,
      facts: count(b.id, false),
      observations: count(b.id, true),
      entities: entitiesOf.get(b.id) ?? 0,
      files: filesOf.get(b.id) ?? 0,
      lastWriteAt: lastOf.get(b.id)?.toISOString() ?? null,
      createdAt: b.createdAt.toISOString(),
    }));
  }
}
