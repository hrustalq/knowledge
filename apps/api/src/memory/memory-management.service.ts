import { BadRequestException, ConflictException, Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type MemoryBank, type MemoryOperation } from '@prisma/client';
import { UUID_RE, type Locale } from '@knowledge/contracts';
import { randomUUID } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import { unzipBounded } from '../common/unzip-bounded.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { ParserRegistry } from '../import/parsers/parser.registry.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAccessService, type MemoryCaller } from './memory-access.service.js';
import { bankConfig, MemoryBanksService, readConfigUpdates } from './memory-banks.service.js';
import { MemoryDirectivesService } from './memory-directives.service.js';
import { cleanTags, readRetainItems } from './memory-facts.js';
import { MemoryMentalModelsService } from './memory-mental-models.service.js';
import { MemoryRateService } from './memory-rate.service.js';
import { MemoryRetainService } from './memory-retain.service.js';
import { MemoryUnitsService } from './memory-units.service.js';
import type { CreateBankAliasDto, ImportBankTemplateDto, ListAuditLogsQueryDto, SetBankAliasPrimaryDto, TransferQueryDto } from './memory.dto.js';
import { DEFAULT_DISPOSITION } from './memory-wire.js';
import { MemoryProducer } from './memory.producer.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const TRANSFER_FORMAT = 'knowledge-hindsight-transfer';

const templateSchema = z.object({
  version: z.literal('1'),
  bank: z.record(z.string(), z.unknown()).nullish(),
  mental_models: z.array(z.object({
    id: z.string().min(1).max(192),
    name: z.string().trim().min(1).max(200),
    source_query: z.string().trim().min(1).max(4000),
    tags: z.array(z.string()).max(50).optional(),
    max_tokens: z.number().int().min(1).max(200_000).optional(),
    trigger: z.record(z.string(), z.unknown()).optional(),
  }).strict()).nullish(),
  directives: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(20_000),
    priority: z.number().int().optional(),
    is_active: z.boolean().optional(),
    tags: z.array(z.string()).max(50).optional(),
  }).strict()).nullish(),
}).strict();

const transferSchema = z.object({
  format: z.literal(TRANSFER_FORMAT),
  version: z.literal('1'),
  bank: z.object({ name: z.string(), mission: z.string(), config: z.record(z.string(), z.unknown()) }),
  documents: z.array(z.object({
    id: z.string(),
    items: z.array(z.object({
      content: z.string().min(1),
      context: z.string().nullable(),
      timestamp: z.string().nullable(),
      metadata: z.record(z.string(), z.string()),
      tags: z.array(z.string()),
      observation_scopes: z.unknown().optional(),
      entities: z.array(z.object({ text: z.string(), type: z.string().optional() })),
    })),
  })),
  directives: z.array(z.record(z.string(), z.unknown())),
  mental_models: z.array(z.record(z.string(), z.unknown())),
});

export const BANK_TEMPLATE_JSON_SCHEMA = {
  type: 'object',
  required: ['version'],
  properties: {
    version: { const: '1' },
    bank: { type: ['object', 'null'] },
    mental_models: { type: ['array', 'null'], items: { type: 'object', required: ['id', 'name', 'source_query'] } },
    directives: { type: ['array', 'null'], items: { type: 'object', required: ['name', 'content'] } },
  },
} as const;

type ManagementOperation = MemoryOperation & { bank: MemoryBank };
type ResultMetadata = Prisma.InputJsonObject;

/** The phase-6 Hindsight management surface. Every public method receives an ACL-resolved caller or bank. */
@Injectable()
export class MemoryManagementService {
  private readonly limits: { maxItems: number; maxChars: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MemoryAccessService,
    private readonly banks: MemoryBanksService,
    private readonly directives: MemoryDirectivesService,
    private readonly mentalModels: MemoryMentalModelsService,
    private readonly retainer: MemoryRetainService,
    private readonly units: MemoryUnitsService,
    private readonly parsers: ParserRegistry,
    private readonly producer: MemoryProducer,
    private readonly rate: MemoryRateService,
    config: ConfigService<Env, true>,
  ) {
    this.limits = { maxItems: config.get('MEMORY_RETAIN_MAX_ITEMS', { infer: true }), maxChars: config.get('MEMORY_RETAIN_MAX_CHARS', { infer: true }) };
  }

  async aliases(bank: MemoryBank) {
    const rows = await this.prisma.memoryBankAlias.findMany({ where: { bankId: bank.id }, orderBy: [{ primary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] });
    return { bank_id: bank.bankId, aliases: rows.map((row) => ({ alias: row.alias, primary: row.primary })) };
  }

  async createAlias(caller: MemoryCaller, bankId: string, dto: CreateBankAliasDto) {
    const bank = await this.access.bank(caller, bankId);
    if (new TextEncoder().encode(dto.alias).length > 192) throw new BadRequestException(t('error.memory.bankIdInvalid'));
    const [bankHeld, aliasHeld] = await Promise.all([
      this.prisma.memoryBank.findUnique({ where: { workspaceId_bankId: { workspaceId: caller.workspaceId, bankId: dto.alias } }, select: { id: true } }),
      this.prisma.memoryBankAlias.findUnique({ where: { workspaceId_alias: { workspaceId: caller.workspaceId, alias: dto.alias } }, select: { id: true } }),
    ]);
    if (bankHeld || aliasHeld) throw new ConflictException(t('error.memory.aliasTaken', { alias: dto.alias }));
    try {
      await this.prisma.$transaction(async (tx) => {
        if (dto.primary) await tx.memoryBankAlias.updateMany({ where: { bankId: bank.id }, data: { primary: false } });
        await tx.memoryBankAlias.create({ data: { workspaceId: caller.workspaceId, bankId: bank.id, alias: dto.alias, primary: dto.primary ?? false } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException(t('error.memory.aliasTaken', { alias: dto.alias }));
      throw error;
    }
    return this.aliases(bank);
  }

  async deleteAlias(bank: MemoryBank, alias: string) {
    const deleted = await this.prisma.memoryBankAlias.deleteMany({ where: { bankId: bank.id, alias } });
    if (!deleted.count) throw new NotFoundException(t('error.memory.aliasNotFound', { alias }));
    return this.aliases(bank);
  }

  async setAliasPrimary(bank: MemoryBank, alias: string, dto: SetBankAliasPrimaryDto) {
    const held = await this.prisma.memoryBankAlias.findFirst({ where: { bankId: bank.id, alias } });
    if (!held) throw new NotFoundException(t('error.memory.aliasNotFound', { alias }));
    await this.prisma.$transaction([
      this.prisma.memoryBankAlias.updateMany({ where: { bankId: bank.id }, data: { primary: false } }),
      this.prisma.memoryBankAlias.update({ where: { id: held.id }, data: { primary: dto.primary } }),
    ]);
    return this.aliases(bank);
  }

  async exportTemplate(bank: MemoryBank) {
    const [models, directives] = await Promise.all([
      this.mentalModels.list(bank, { detail: 'full', limit: 1000 }),
      this.directives.list(bank, { limit: 1000 }),
    ]);
    return {
      version: '1',
      bank: bankConfig(bank).overrides,
      mental_models: models.items.map((row) => ({ id: row.id, name: row.name, source_query: row.source_query!, tags: row.tags, max_tokens: row.max_tokens ?? undefined, trigger: row.trigger ?? undefined })),
      directives: directives.items.map((row) => ({ name: row.name, content: row.content, priority: row.priority, is_active: row.is_active, tags: row.tags })),
    };
  }

  async importTemplate(caller: MemoryCaller, bankId: string, input: ImportBankTemplateDto, dryRun: boolean) {
    let manifest: z.infer<typeof templateSchema>;
    try {
      manifest = templateSchema.parse(input);
    } catch (error) {
      if (error instanceof z.ZodError) throw new BadRequestException(error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
      throw error;
    }
    const existing = await this.access.find(caller, bankId);
    if (manifest.bank) readConfigUpdates(manifest.bank, existing ?? { disposition: DEFAULT_DISPOSITION } as unknown as MemoryBank);
    for (const model of manifest.mental_models ?? []) this.mentalModels.validateDefinition(model);
    if (dryRun) return { bank_id: bankId, config_applied: false, mental_models_created: [], mental_models_updated: [], directives_created: [], directives_updated: [], operation_ids: [], dry_run: true };
    const bank = existing ?? await this.banks.ensure(caller, bankId);
    if (manifest.bank && Object.keys(manifest.bank).length) await this.prisma.memoryBank.update({ where: { id: bank.id }, data: readConfigUpdates(manifest.bank, bank) });
    const operationIds: string[] = [];
    const modelsCreated: string[] = [];
    const modelsUpdated: string[] = [];
    for (const model of manifest.mental_models ?? []) {
      const current = await this.prisma.memoryMentalModel.findFirst({ where: { bankId: bank.id, id: model.id }, select: { id: true } });
      if (current) {
        await this.mentalModels.update(bank, model.id, model);
        modelsUpdated.push(model.id);
      } else {
        const created = await this.mentalModels.create(bank, model, caller.principal.userId, caller.principal.locale);
        operationIds.push(created.operation_id);
        modelsCreated.push(model.id);
      }
    }
    const directivesCreated: string[] = [];
    const directivesUpdated: string[] = [];
    const existingDirectives = await this.prisma.memoryDirective.findMany({ where: { bankId: bank.id } });
    for (const directive of manifest.directives ?? []) {
      const current = existingDirectives.find((row) => row.name === directive.name);
      if (current) {
        await this.directives.update(bank, current.id, directive);
        directivesUpdated.push(directive.name);
      } else {
        await this.directives.create(bank, directive);
        directivesCreated.push(directive.name);
      }
    }
    return { bank_id: bank.bankId, config_applied: Boolean(manifest.bank && Object.keys(manifest.bank).length), mental_models_created: modelsCreated, mental_models_updated: modelsUpdated, directives_created: directivesCreated, directives_updated: directivesUpdated, operation_ids: operationIds, dry_run: false };
  }

  async auditLogs(bank: MemoryBank, query: ListAuditLogsQueryDto) {
    const where = this.auditWhere(bank, query);
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const [rows, total] = query.transport && query.transport !== 'http' ? [[], 0] : await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: limit }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { bank_id: bank.bankId, total, limit, offset, items: rows.map((row) => this.auditResponse(bank, row)) };
  }

  async auditLog(bank: MemoryBank, id: string) {
    const row = UUID_RE.test(id) ? await this.prisma.auditLog.findFirst({ where: { id, ...this.auditWhere(bank, {}) } }) : null;
    if (!row) throw new NotFoundException(t('error.memory.auditLogNotFound', { id }));
    return { ...this.auditResponse(bank, row), request: null, response: null };
  }

  async auditStats(bank: MemoryBank, query: { action?: string; period?: '1d' | '7d' | '30d' }) {
    const period = query.period ?? '7d';
    const days = Number(period.slice(0, -1));
    const start = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.auditLog.findMany({ where: { ...this.auditWhere(bank, query), createdAt: { gte: start } } });
    const buckets = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const key = row.createdAt.toISOString().slice(0, 10);
      const actions = buckets.get(key) ?? new Map<string, number>();
      actions.set(row.action, (actions.get(row.action) ?? 0) + 1);
      buckets.set(key, actions);
    }
    return { bank_id: bank.bankId, period, trunc: 'day', start: start.toISOString(), buckets: [...buckets].map(([time, actions]) => ({ time: `${time}T00:00:00.000Z`, actions: Object.fromEntries(actions), total: [...actions.values()].reduce((a, b) => a + b, 0) })) };
  }

  async submitFiles(caller: MemoryCaller, bankId: string, files: Array<{ originalname: string; mimetype: string; buffer: Buffer; size: number }>, rawRequest: string) {
    await this.rate.check('retain', caller.principal);
    if (!files.length || files.length > this.limits.maxItems || files.some((file) => file.size > MAX_FILE_BYTES)) throw new BadRequestException(t('error.memory.fileUploadInvalid', { maxItems: this.limits.maxItems, maxBytes: MAX_FILE_BYTES }));
    let request: { files_metadata?: Array<{ context?: string; document_id?: string; tags?: string[]; metadata?: Record<string, string> }> };
    try {
      request = z.object({ files_metadata: z.array(z.object({ context: z.string().optional(), document_id: z.string().optional(), tags: z.array(z.string()).optional(), metadata: z.record(z.string(), z.string()).optional() })).optional() }).parse(JSON.parse(rawRequest));
    } catch {
      throw new BadRequestException(t('error.memory.fileUploadRequestInvalid'));
    }
    const bank = await this.banks.ensure(caller, bankId);
    const ids: string[] = [];
    for (const [index, file] of files.entries()) {
      const metadata = request.files_metadata?.[index] ?? {};
      ids.push(await this.submit(bank, 'file_convert_retain', { filename: file.originalname, content_type: file.mimetype, data_base64: file.buffer.toString('base64'), metadata }, caller.principal.userId, caller.principal.locale));
    }
    return { operation_ids: ids };
  }

  async submitExport(bank: MemoryBank, query: TransferQueryDto, wholeBank: boolean, userId: string, locale: Locale) {
    this.checkTransferFlags(query);
    return this.submitResult(bank, wholeBank ? 'bank_export' : 'document_export', { document_ids: query.document_id ?? null, include_data: query.include_data ?? true, include_bank_config: wholeBank && (query.include_bank_config ?? true), include_knowledge_base: query.include_knowledge_base ?? false }, userId, locale);
  }

  async submitImport(caller: MemoryCaller, bankId: string, file: { buffer: Buffer; size: number } | undefined, query: TransferQueryDto, documentsOnly: boolean) {
    if (!file || file.size > MAX_ARCHIVE_BYTES) throw new BadRequestException(t('error.memory.fileUploadInvalid', { maxItems: 1, maxBytes: MAX_ARCHIVE_BYTES }));
    this.checkTransferFlags(query);
    const bank = await this.access.bank(caller, bankId);
    const targetBankId = documentsOnly ? bank.bankId : query.target_bank_id ?? `${bank.bankId}-restored`;
    if (!documentsOnly) await this.requireFreshTarget(caller, targetBankId);
    return this.submitResult(bank, documentsOnly ? 'document_import' : 'bank_import', { data_base64: file.buffer.toString('base64'), target_bank_id: targetBankId, mode: documentsOnly ? 'merge' : 'restore', conflict: query.on_conflict ?? query.document_conflict ?? 'skip', include_data: query.include_data ?? true, include_bank_config: query.include_bank_config ?? true }, caller.principal.userId, caller.principal.locale);
  }

  async submitClone(caller: MemoryCaller, bankId: string, query: TransferQueryDto) {
    this.checkTransferFlags(query);
    const bank = await this.access.bank(caller, bankId);
    if (!query.target_bank_id || query.target_bank_id === bank.bankId) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'target_bank_id', type: 'a new bank id' }));
    await this.requireFreshTarget(caller, query.target_bank_id);
    return this.submitResult(bank, 'bank_clone', { target_bank_id: query.target_bank_id, include_data: query.include_data ?? true, include_bank_config: query.include_bank_config ?? true }, caller.principal.userId, caller.principal.locale);
  }

  async execute(row: ManagementOperation): Promise<ResultMetadata | null> {
    if (row.type === 'file_convert_retain') return this.executeFile(row);
    if (row.type === 'document_export' || row.type === 'bank_export') return this.executeExport(row);
    if (row.type === 'document_import' || row.type === 'bank_import') return this.executeImport(row);
    if (row.type === 'bank_clone') return this.executeClone(row);
    return null;
  }

  async chunk(caller: MemoryCaller, key: string) {
    const row = UUID_RE.test(key) ? await this.prisma.memoryUnit.findFirst({ where: { id: key, workspaceId: caller.workspaceId }, include: { bank: true } }) : null;
    if (!row || !(await this.access.visible(caller.scope, [row.bank])).length) throw new NotFoundException(t('error.memory.memoryNotFound', { id: key }));
    return this.units.chunk(row.bank, key);
  }

  async archive(caller: MemoryCaller, key: string): Promise<{ filename: string; data: Buffer }> {
    const row = UUID_RE.test(key) ? await this.prisma.memoryTransferArchive.findUnique({ where: { id: key }, include: { bank: true } }) : null;
    if (!row || !(await this.access.visible(caller.scope, [row.bank])).length) throw new NotFoundException(t('error.memory.archiveNotFound'));
    return { filename: row.filename, data: Buffer.from(row.data) };
  }

  async deleteArchives(operationIds: string[]): Promise<void> {
    if (operationIds.length) await this.prisma.memoryTransferArchive.deleteMany({ where: { operationId: { in: operationIds } } });
  }

  private async executeFile(row: ManagementOperation): Promise<ResultMetadata> {
    const payload = row.payload as unknown as { filename: string; content_type: string; data_base64: string; metadata: { context?: string; document_id?: string; tags?: string[]; metadata?: Record<string, string> } };
    const bytes = Buffer.from(payload.data_base64, 'base64');
    const parser = this.parsers.resolve(payload.filename, payload.content_type);
    if (!parser) throw new UnsupportedMediaTypeException(t('error.memory.fileTypeUnsupported'));
    const parsed = await parser.parse(bytes, { workspaceId: row.workspaceId, importId: row.id, userId: row.createdBy, filename: payload.filename, contentType: payload.content_type, onStage: async () => undefined });
    if (!parsed.markdown.trim()) throw new BadRequestException(t('error.memory.fileEmpty'));
    const [item] = readRetainItems([{ content: parsed.markdown, context: payload.metadata.context, document_id: payload.metadata.document_id ?? payload.filename, tags: payload.metadata.tags, metadata: { ...payload.metadata.metadata, filename: payload.filename } }], undefined, this.limits);
    const retained = await this.retainer.retain({ workspaceId: row.workspaceId, bank: row.bank, userId: row.createdBy, locale: row.locale as Locale, items: [item!], operationId: row.id });
    return { documents_imported: retained.units ? 1 : 0, facts_imported: retained.units, warnings: parsed.warnings };
  }

  private async executeExport(row: ManagementOperation): Promise<ResultMetadata> {
    const payload = row.payload as unknown as { document_ids: string[] | null; include_data: boolean; include_bank_config: boolean; include_knowledge_base: boolean };
    const units = payload.include_data ? await this.prisma.memoryUnit.findMany({ where: { bankId: row.bankId, factType: { not: 'observation' }, ...(payload.document_ids?.length ? { documentId: { in: payload.document_ids } } : {}) }, include: { entities: true }, orderBy: [{ documentId: 'asc' }, { position: 'asc' }] }) : [];
    const grouped = new Map<string, typeof units>();
    for (const unit of units) {
      const rows = grouped.get(unit.documentId) ?? [];
      rows.push(unit);
      grouped.set(unit.documentId, rows);
    }
    const includeConfig = payload.include_bank_config || payload.include_knowledge_base;
    const transfer = {
      format: TRANSFER_FORMAT,
      version: '1',
      bank: { name: row.bank.name, mission: row.bank.mission, config: includeConfig ? bankConfig(row.bank).overrides : {} },
      documents: [...grouped].map(([id, rows]) => ({ id, items: rows.map((unit) => ({ content: unit.text, context: unit.context, timestamp: unit.mentionedAt?.toISOString() ?? null, metadata: unit.metadata, tags: unit.tags, observation_scopes: unit.observationScopes ?? undefined, entities: unit.entities.map((entity) => ({ text: entity.name })) })) })),
      directives: includeConfig ? (await this.prisma.memoryDirective.findMany({ where: { bankId: row.bankId } })).map((row) => ({ name: row.name, content: row.content, priority: row.priority, is_active: row.isActive, tags: row.tags })) : [],
      mental_models: includeConfig ? (await this.prisma.memoryMentalModel.findMany({ where: { bankId: row.bankId } })).map((row) => ({ id: row.id, name: row.name, source_query: row.sourceQuery, content: row.content, tags: row.tags, max_tokens: row.maxTokens, trigger: row.trigger, reflect_response: row.reflectResponse, structured_doc: row.structuredDoc })) : [],
    };
    const data = Buffer.from(zipSync({ 'transfer.json': strToU8(JSON.stringify(transfer)) }));
    if (data.byteLength > MAX_ARCHIVE_BYTES) throw new BadRequestException(t('error.memory.archiveTooLarge', { maxBytes: MAX_ARCHIVE_BYTES }));
    const id = randomUUID();
    const filename = `${row.bank.bankId}-transfer.zip`;
    await this.prisma.memoryTransferArchive.create({ data: { id, workspaceId: row.workspaceId, bankId: row.bankId, operationId: row.id, filename, data } });
    return { download_url: `/v1/default/files/download/${id}`, storage_key: id, byte_size: data.byteLength, filename, documents_exported: grouped.size, facts_exported: units.length };
  }

  private async executeImport(row: ManagementOperation): Promise<ResultMetadata> {
    const payload = row.payload as unknown as { data_base64: string; target_bank_id: string; mode: 'merge' | 'restore'; conflict: 'skip' | 'replace' | 'new-id'; include_data: boolean; include_bank_config: boolean };
    const files = unzipBounded(Buffer.from(payload.data_base64, 'base64'), MAX_ARCHIVE_BYTES, (file) => file.name === 'transfer.json');
    if (!files['transfer.json']) throw new BadRequestException(t('error.memory.transferInvalid'));
    let transfer: z.infer<typeof transferSchema>;
    try {
      transfer = transferSchema.parse(JSON.parse(Buffer.from(files['transfer.json']).toString('utf8')));
    } catch {
      throw new BadRequestException(t('error.memory.transferInvalid'));
    }
    const target = payload.mode === 'restore' ? await this.createTarget(row, payload.target_bank_id, transfer) : row.bank;
    if (payload.include_bank_config && Object.keys(transfer.bank.config).length) await this.prisma.memoryBank.update({ where: { id: target.id }, data: readConfigUpdates(transfer.bank.config, target) });
    if (payload.include_bank_config) await this.importConfiguration(target, transfer);
    let documentsImported = 0;
    let documentsSkipped = 0;
    let factsImported = 0;
    if (payload.include_data) for (const document of transfer.documents) {
      const exists = await this.prisma.memoryUnit.findFirst({ where: { bankId: target.id, documentId: document.id }, select: { id: true } });
      if (exists && payload.conflict === 'skip') {
        documentsSkipped++;
        continue;
      }
      const documentId = exists && payload.conflict === 'new-id' ? `${document.id}-${randomUUID().slice(0, 8)}` : document.id;
      const items = readRetainItems(document.items.map((item) => ({ ...item, document_id: documentId })), undefined, this.limits);
      const retained = await this.retainer.retain({ workspaceId: target.workspaceId, bank: target, userId: row.createdBy, locale: row.locale as Locale, items, verbatim: true });
      factsImported += retained.units;
      documentsImported++;
    }
    return { documents_imported: documentsImported, documents_skipped: documentsSkipped, facts_imported: factsImported, observations_imported: 0 };
  }

  private async executeClone(row: ManagementOperation): Promise<ResultMetadata> {
    const payload = row.payload as unknown as { target_bank_id: string; include_data: boolean; include_bank_config: boolean };
    const exported = await this.executeExport({ ...row, payload: { document_ids: null, include_data: payload.include_data, include_bank_config: payload.include_bank_config, include_knowledge_base: false } });
    const archive = await this.prisma.memoryTransferArchive.findUnique({ where: { operationId: row.id } });
    if (!archive) throw new NotFoundException(t('error.memory.archiveNotFound'));
    const result = await this.executeImport({ ...row, payload: { data_base64: Buffer.from(archive.data).toString('base64'), target_bank_id: payload.target_bank_id, mode: 'restore', conflict: 'skip', include_data: payload.include_data, include_bank_config: payload.include_bank_config } });
    await this.prisma.memoryTransferArchive.delete({ where: { id: archive.id } });
    return { ...exported, ...result, target_bank_id: payload.target_bank_id, download_url: undefined, storage_key: undefined };
  }

  private async createTarget(row: ManagementOperation, bankId: string, transfer: z.infer<typeof transferSchema>): Promise<MemoryBank> {
    try {
      return await this.prisma.memoryBank.create({ data: { workspaceId: row.workspaceId, bankId, name: transfer.bank.name || bankId, mission: transfer.bank.mission, projectId: row.bank.projectId, agentKey: row.bank.agentKey, ownerId: row.bank.ownerId, createdBy: row.createdBy } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException(t('error.memory.bankIdInvalid'));
      throw error;
    }
  }

  private async importConfiguration(bank: MemoryBank, transfer: z.infer<typeof transferSchema>): Promise<void> {
    for (const directive of transfer.directives) {
      const parsed = templateSchema.shape.directives.unwrap().unwrap().element.parse(directive);
      const current = await this.prisma.memoryDirective.findFirst({ where: { bankId: bank.id, name: parsed.name } });
      if (current) await this.directives.update(bank, current.id, parsed);
      else await this.directives.create(bank, parsed);
    }
    for (const model of transfer.mental_models) {
      const id = typeof model.id === 'string' ? model.id : randomUUID();
      const current = await this.prisma.memoryMentalModel.findUnique({ where: { id } });
      const modelId = current && current.bankId !== bank.id ? randomUUID() : id;
      const data = {
        workspaceId: bank.workspaceId,
        bankId: bank.id,
        name: String(model.name ?? modelId),
        sourceQuery: String(model.source_query ?? ''),
        content: typeof model.content === 'string' ? model.content : '',
        tags: cleanTags(model.tags),
        maxTokens: typeof model.max_tokens === 'number' ? model.max_tokens : 4096,
        trigger: (model.trigger ?? {}) as Prisma.InputJsonObject,
        reflectResponse: (model.reflect_response ?? Prisma.DbNull) as Prisma.InputJsonObject,
        structuredDoc: (model.structured_doc ?? Prisma.DbNull) as Prisma.InputJsonObject,
      };
      if (current) await this.prisma.memoryMentalModel.update({ where: { id: current.id }, data });
      else await this.prisma.memoryMentalModel.create({ data: { id: modelId, ...data } });
    }
  }

  private async submit(bank: MemoryBank, type: string, payload: Prisma.InputJsonObject, userId: string, locale: Locale): Promise<string> {
    const id = randomUUID();
    await this.prisma.memoryOperation.create({ data: { id, workspaceId: bank.workspaceId, bankId: bank.id, type, payload, itemsCount: 0, createdBy: userId, locale } });
    await this.producer.enqueue(id);
    return id;
  }

  private async submitResult(bank: MemoryBank, type: string, payload: Prisma.InputJsonObject, userId: string, locale: Locale) {
    return { operation_id: await this.submit(bank, type, payload, userId, locale), status: 'pending' };
  }

  private async requireFreshTarget(caller: MemoryCaller, bankId: string): Promise<void> {
    if (await this.access.find(caller, bankId)) throw new ConflictException(t('error.memory.aliasTaken', { alias: bankId }));
  }

  private checkTransferFlags(query: TransferQueryDto): void {
    if (query.include_history || query.include_observations) throw new BadRequestException(t('error.memory.configValueInvalid', { key: query.include_history ? 'include_history' : 'include_observations', type: 'false on this server; history is not transferred and observations are rebuilt from source facts' }));
  }

  private auditWhere(bank: MemoryBank, query: { action?: string; start_date?: string; end_date?: string }): Prisma.AuditLogWhereInput {
    return { workspaceId: bank.workspaceId, target: bank.bankId, action: { startsWith: 'memory.', ...(query.action ? { equals: query.action } : {}) }, ...(query.start_date || query.end_date ? { createdAt: { ...(query.start_date ? { gte: new Date(query.start_date) } : {}), ...(query.end_date ? { lt: new Date(query.end_date) } : {}) } } : {}) };
  }

  private auditResponse(bank: MemoryBank, row: Prisma.AuditLogGetPayload<object>) {
    return { id: row.id, action: row.action, transport: 'http', bank_id: bank.bankId, started_at: row.createdAt.toISOString(), ended_at: row.createdAt.toISOString(), duration_ms: row.durationMs, metadata: { actor: row.actor, params: row.params, ok: row.ok, error: row.error, ip: row.ip, target: row.target } };
  }
}
