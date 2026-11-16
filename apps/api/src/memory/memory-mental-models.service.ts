import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type MemoryBank, type MemoryMentalModel, type MemoryOperation } from '@prisma/client';
import type { Locale } from '@knowledge/contracts';
import { randomUUID } from 'node:crypto';
import { AUTHOR_ID_STUB } from '../activity/actor.js';
import { withSubjectLock } from '../common/subject-lock.js';
import type { Env } from '../config/env.js';
import { FeaturesService } from '../auth/features.service.js';
import { asLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { cleanTags, tagsWhere } from './memory-facts.js';
import {
  applyMentalModelDelta,
  cronDue,
  mentalModelTrigger,
  mentalModelTriggerOutput,
  parseCron,
  parseMentalModelDocument,
  readDeltaOperations,
  readMentalModelDocument,
  renderMentalModelDocument,
  validMentalModelId,
  validResponseSchema,
  type MentalModelTrigger,
} from './memory-mental-models.js';
import { MemoryReflectService } from './memory-reflect.service.js';
import { MemoryProducer } from './memory.producer.js';
import type { CreateMentalModelDto, ListMentalModelsQueryDto, RefreshMentalModelDto, UpdateMentalModelDto } from './memory.dto.js';
import type { CreateMentalModelResponse, MentalModelHistoryResponse, MentalModelListResponse, MentalModelResponse, ReflectResponse } from './memory-wire.js';

const REFRESH_TYPES = ['create_mental_model', 'refresh_mental_model'] as const;
type RefreshOperation = MemoryOperation & { bank: MemoryBank };
type RefreshPayload = { mental_model_id: string; mode?: 'full' | null; automatic?: boolean };
type RefreshFailureReason = 'retrieval_failed' | 'no_answer' | 'unexpected_error' | 'empty_candidate' | 'structured_doc_unreadable' | 'delta_ops_failed' | 'delta_ops_all_skipped' | 'delta_not_applied' | 'structured_output_failed';

class RefreshFailure extends Error {
  constructor(
    readonly reason: RefreshFailureReason,
    readonly outcome: string,
    message: string,
  ) {
    super(message);
  }
}

const modelLock = (id: string) => `memory-mental-model:${id}`;
const payloadOf = (row: Pick<MemoryOperation, 'payload'>): RefreshPayload | null => {
  const payload = row.payload as unknown as Partial<RefreshPayload>;
  return typeof payload?.mental_model_id === 'string' ? payload as RefreshPayload : null;
};
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

@Injectable()
export class MemoryMentalModelsService {
  private readonly logger = new Logger(MemoryMentalModelsService.name);
  private readonly defaultInterval: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: MemoryReflectService,
    private readonly producer: MemoryProducer,
    private readonly features: FeaturesService,
    config: ConfigService<Env, true>,
  ) {
    this.defaultInterval = config.get('MEMORY_MENTAL_MODEL_MIN_REFRESH_INTERVAL_SECONDS', { infer: true });
  }

  validateDefinition(dto: CreateMentalModelDto): MentalModelTrigger {
    if (dto.id && !validMentalModelId(dto.id)) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'id', type: 'lowercase letters, numbers and hyphens, at most 192 UTF-8 bytes' }));
    return this.validatedTrigger(dto.trigger ?? {}, {});
  }

  async create(bank: MemoryBank, dto: CreateMentalModelDto, userId: string, locale: Locale): Promise<CreateMentalModelResponse> {
    const id = dto.id ?? randomUUID();
    const trigger = this.validateDefinition({ ...dto, id });
    const operationId = randomUUID();
    try {
      await withSubjectLock(this.prisma, modelLock(id), async () => {
        await this.prisma.memoryMentalModel.create({
          data: {
            id,
            workspaceId: bank.workspaceId,
            bankId: bank.id,
            name: dto.name.trim(),
            sourceQuery: dto.source_query.trim(),
            tags: cleanTags(dto.tags),
            maxTokens: dto.max_tokens ?? 4096,
            trigger: trigger as unknown as Prisma.InputJsonObject,
          },
        });
        await this.prisma.memoryOperation.create({
          data: {
            id: operationId,
            workspaceId: bank.workspaceId,
            bankId: bank.id,
            type: 'create_mental_model',
            payload: { mental_model_id: id },
            itemsCount: 0,
            createdBy: userId,
            locale,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException(t('error.memory.mentalModelIdTaken', { id }));
      throw error;
    }
    await this.enqueue(operationId);
    return { mental_model_id: id, operation_id: operationId };
  }

  async list(bank: MemoryBank, query: ListMentalModelsQueryDto): Promise<MentalModelListResponse> {
    const where: Prisma.MemoryMentalModelWhereInput = {
      workspaceId: bank.workspaceId,
      bankId: bank.id,
      ...(query.tags?.length ? tagsWhere(query.tags, query.tags_match) as Prisma.MemoryMentalModelWhereInput : {}),
    };
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      this.prisma.memoryMentalModel.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: offset, take: limit }),
      this.prisma.memoryMentalModel.count({ where }),
    ]);
    const stale = await this.staleness(rows);
    return { items: rows.map((row) => this.response(bank, row, query.detail ?? 'metadata', stale.get(row.id) ?? false)), total, limit, offset };
  }

  async get(bank: MemoryBank, id: string, detail: 'metadata' | 'content' | 'full' = 'full'): Promise<MentalModelResponse> {
    const row = await this.one(bank, id);
    const stale = await this.staleness([row]);
    return this.response(bank, row, detail, stale.get(row.id) ?? false);
  }

  async update(bank: MemoryBank, id: string, dto: UpdateMentalModelDto): Promise<MentalModelResponse> {
    const current = await this.one(bank, id);
    const trigger = dto.trigger === undefined ? mentalModelTrigger(current.trigger) : this.validatedTrigger(dto.trigger ?? {}, mentalModelTrigger(current.trigger));
    const row = await this.prisma.memoryMentalModel.update({
      where: { id: current.id, workspaceId: bank.workspaceId, bankId: bank.id },
      data: {
        ...(typeof dto.name === 'string' ? { name: dto.name.trim() } : {}),
        ...(typeof dto.source_query === 'string' ? { sourceQuery: dto.source_query.trim() } : {}),
        ...(dto.max_tokens != null ? { maxTokens: dto.max_tokens } : {}),
        ...(Array.isArray(dto.tags) ? { tags: cleanTags(dto.tags) } : {}),
        ...(dto.trigger !== undefined ? { trigger: trigger as unknown as Prisma.InputJsonObject } : {}),
      },
    });
    return this.response(bank, row, 'full', (await this.staleness([row])).get(row.id) ?? false);
  }

  async delete(bank: MemoryBank, id: string): Promise<void> {
    const row = await this.one(bank, id);
    await withSubjectLock(this.prisma, modelLock(row.id), async () => {
      const waiting = await this.prisma.memoryOperation.findMany({ where: { bankId: bank.id, type: { in: [...REFRESH_TYPES] }, status: 'queued' }, select: { id: true, payload: true } });
      const ids = waiting.filter((operation) => payloadOf(operation)?.mental_model_id === row.id).map((operation) => operation.id);
      if (ids.length) await this.prisma.memoryOperation.updateMany({ where: { id: { in: ids } }, data: { status: 'cancelled', completedAt: new Date(), payload: [] } });
      await this.prisma.memoryMentalModel.delete({ where: { id: row.id } });
    });
  }

  async clear(bank: MemoryBank, id: string): Promise<MentalModelResponse> {
    const current = await this.one(bank, id);
    const row = await withSubjectLock(this.prisma, modelLock(id), async () => {
      const updated = await this.prisma.memoryMentalModel.update({
        where: { id, workspaceId: bank.workspaceId, bankId: bank.id },
        data: {
          content: '',
          structuredDoc: Prisma.DbNull,
          reflectResponse: Prisma.DbNull,
          refreshedSourceQuery: null,
          lastRefreshFailedAt: null,
          lastRefreshedAt: new Date(),
        },
      });
      if (current.content) await this.history(current, current.content);
      return updated;
    });
    return this.response(bank, row, 'full', (await this.staleness([row])).get(row.id) ?? false);
  }

  async historyList(bank: MemoryBank, id: string): Promise<MentalModelHistoryResponse[]> {
    await this.one(bank, id);
    const rows = await this.prisma.memoryMentalModelHistory.findMany({ where: { bankId: bank.id, modelId: id }, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }] });
    return rows.map((row) => ({
      previous_content: row.previousContent,
      changed_at: row.changedAt.toISOString(),
      ...(row.kind ? { kind: row.kind } : {}),
      ...(row.outcome ? { outcome: row.outcome } : {}),
      ...(row.failureReason ? { failure_reason: row.failureReason } : {}),
      ...(row.errorMessage ? { error_message: row.errorMessage } : {}),
    }));
  }

  async refresh(bank: MemoryBank, id: string, dto: RefreshMentalModelDto, userId: string, locale: Locale): Promise<{ operation_id: string; status: string }> {
    const model = await this.one(bank, id);
    const operationId = await this.queue(model, { mode: dto.mode ?? null, automatic: false }, userId, locale);
    return { operation_id: operationId, status: 'pending' };
  }

  private async queue(model: MemoryMentalModel, refresh: { mode?: 'full' | null; automatic: boolean }, userId: string, locale: Locale): Promise<string> {
    const operationId = randomUUID();
    const trigger = mentalModelTriggerOutput(model.trigger);
    const interval = trigger.min_refresh_interval_seconds ?? this.defaultInterval;
    const notBefore = refresh.automatic && model.lastRefreshedAt && interval > 0 ? new Date(model.lastRefreshedAt.getTime() + interval * 1000) : null;
    const id = await withSubjectLock(this.prisma, modelLock(model.id), async () => {
      const waiting = await this.prisma.memoryOperation.findMany({ where: { bankId: model.bankId, type: { in: [...REFRESH_TYPES] }, status: 'queued' }, orderBy: { createdAt: 'asc' } });
      const held = waiting.find((operation) => payloadOf(operation)?.mental_model_id === model.id);
      if (held) {
        const previous = payloadOf(held)!;
        await this.prisma.memoryOperation.update({
          where: { id: held.id },
          data: {
            payload: { mental_model_id: model.id, mode: refresh.mode === 'full' ? 'full' : previous.mode ?? null, automatic: refresh.automatic && previous.automatic !== false },
            ...(refresh.automatic ? {} : { notBefore: null }),
          },
        });
        return held.id;
      }
      await this.prisma.memoryOperation.create({
        data: {
          id: operationId,
          workspaceId: model.workspaceId,
          bankId: model.bankId,
          type: 'refresh_mental_model',
          payload: { mental_model_id: model.id, ...refresh },
          itemsCount: 0,
          createdBy: userId,
          locale,
          notBefore,
        },
      });
      return operationId;
    });
    if (!notBefore || notBefore.getTime() <= Date.now()) await this.enqueue(id);
    return id;
  }

  async execute(operationId: string): Promise<void> {
    const operation = await this.prisma.memoryOperation.findUnique({ where: { id: operationId }, include: { bank: true } });
    if (!operation || !(REFRESH_TYPES as readonly string[]).includes(operation.type)) return;
    const payload = payloadOf(operation);
    if (!payload) return;
    let claimed = false;
    try {
      claimed = await withSubjectLock(this.prisma, modelLock(payload.mental_model_id), async () => {
        const running = await this.prisma.memoryOperation.findFirst({
          where: { bankId: operation.bankId, type: { in: [...REFRESH_TYPES] }, status: 'running', id: { not: operation.id } },
          select: { id: true, payload: true },
        });
        if (running && payloadOf(running)?.mental_model_id === payload.mental_model_id) return false;
        const result = await this.prisma.memoryOperation.updateMany({
          where: { id: operation.id, status: 'queued', OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }] },
          data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 }, notBefore: null },
        });
        return result.count === 1;
      });
      if (!claimed) return;
      const model = await this.prisma.memoryMentalModel.findFirst({ where: { id: payload.mental_model_id, bankId: operation.bankId } });
      if (!model) throw new RefreshFailure('unexpected_error', 'refresh_failed_error', 'The mental model no longer exists.');
      await this.runRefresh(operation, model, payload.mode);
      await this.prisma.memoryOperation.updateMany({ where: { id: operation.id, status: 'running' }, data: { status: 'completed', completedAt: new Date(), error: null, payload: [] } });
    } catch (error) {
      if (!claimed) throw error;
      const failure = error instanceof RefreshFailure ? error : new RefreshFailure('unexpected_error', 'refresh_failed_error', (error as Error).message);
      this.logger.warn(`Mental model operation ${operation.id} failed: ${failure.message}`);
      await this.recordFailure(operation.bankId, payload, failure);
      await this.prisma.memoryOperation.updateMany({ where: { id: operation.id, status: 'running' }, data: { status: 'failed', completedAt: new Date(), error: failure.message.slice(0, 1000), payload: [] } });
    } finally {
      if (claimed) await this.enqueueNext(operation.bankId, payload.mental_model_id);
    }
  }

  async failStale(where: Prisma.MemoryOperationWhereInput, row: Pick<MemoryOperation, 'bankId' | 'payload'>, message: string): Promise<{ count: number }> {
    const done = await this.prisma.memoryOperation.updateMany({ where, data: { status: 'failed', completedAt: new Date(), error: message, payload: [] } });
    if (done.count) await this.recordFailure(row.bankId, payloadOf(row)!, new RefreshFailure('unexpected_error', 'refresh_failed_error', message));
    return done;
  }

  private async recordFailure(bankId: string, payload: RefreshPayload, failure: RefreshFailure): Promise<void> {
    const model = await this.prisma.memoryMentalModel.findFirst({ where: { id: payload.mental_model_id, bankId } });
    if (!model) return;
    await this.prisma.memoryMentalModel.update({ where: { id: model.id }, data: { lastRefreshFailedAt: new Date() } });
    await this.prisma.memoryMentalModelHistory.create({
      data: {
        workspaceId: model.workspaceId,
        bankId: model.bankId,
        modelId: model.id,
        previousContent: null,
        kind: 'refresh_failed',
        outcome: failure.outcome,
        failureReason: failure.reason,
        errorMessage: failure.message.slice(0, 1000),
      },
    });
    await this.trimHistory(model.id, 'refresh_failed');
  }

  private async runRefresh(operation: RefreshOperation, model: MemoryMentalModel, requestedMode?: 'full' | null): Promise<void> {
    const trigger = mentalModelTriggerOutput(model.trigger);
    const mode = requestedMode ?? trigger.mode;
    const delta = mode === 'delta' && model.content && model.refreshedSourceQuery === model.sourceQuery;
    const structured = delta ? readMentalModelDocument(model.structuredDoc) : null;
    if (mode === 'delta' && model.content && model.refreshedSourceQuery === model.sourceQuery && !structured) {
      throw new RefreshFailure('structured_doc_unreadable', 'refresh_failed_delta_not_applied', 'The stored delta document cannot be read.');
    }
    const [snapshot] = await this.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    const before = snapshot?.now ?? new Date();
    const scope = this.scopeWhere(model, { before, after: delta ? model.lastMemorySeenAt : null });
    const latest = await this.prisma.memoryUnit.findFirst({ where: scope, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { updatedAt: true } });
    if (!latest) {
      await this.prisma.memoryMentalModel.update({
        where: { id: model.id },
        data: { lastRefreshedAt: new Date(), lastRefreshFailedAt: null, ...(mode === 'full' ? { lastFullRefreshedAt: new Date() } : {}) },
      });
      return;
    }
    const tagsMatch = trigger.tags_match ?? (model.tags.length ? 'all_strict' : 'any');
    const excluded = new Set([model.id, ...(trigger.exclude_mental_model_ids ?? [])]);
    const answer = await this.reflector.reflect(operation.bank, {
      query: model.sourceQuery,
      types: trigger.fact_types ?? undefined,
      tags: model.tags,
      tagsMatch,
      budget: trigger.budget ?? 'mid',
      maxTokens: trigger.recall_max_tokens ?? model.maxTokens,
      userId: operation.createdBy,
      locale: asLocale(operation.locale),
      facts: true,
      responseSchema: delta ? undefined : trigger.response_schema ?? undefined,
      excludeMentalModels: trigger.exclude_mental_models,
      excludeMentalModelIds: [...excluded],
      written: { before, after: delta ? model.lastMemorySeenAt ?? undefined : undefined },
      deltaDocument: delta ? structured! : undefined,
    });
    let content = answer.text;
    let response: ReflectResponse = answer;
    if (delta) {
      const operations = readDeltaOperations({ operations: answer.delta_operations });
      if (!operations) throw new RefreshFailure('delta_ops_failed', 'refresh_failed_delta_not_applied', 'The model returned no readable delta operations.');
      const applied = applyMentalModelDelta(structured!, operations);
      if (!applied.applied.length) throw new RefreshFailure('delta_ops_all_skipped', 'refresh_failed_delta_not_applied', 'Every delta operation was rejected.');
      content = renderMentalModelDocument(applied.document);
      if (model.content && !content.trim()) throw new RefreshFailure('empty_candidate', 'refresh_failed_empty_candidate', 'The delta refresh produced an empty document.');
      const previous = model.reflectResponse as ReflectResponse | null;
      const memories = new Map<string, NonNullable<ReflectResponse['based_on']>['memories'][number]>();
      for (const memory of [...(previous?.based_on?.memories ?? []), ...(answer.based_on?.memories ?? [])]) memories.set(memory.id, memory);
      response = {
        ...answer,
        text: content,
        based_on: {
          memories: [...memories.values()],
          mental_models: answer.based_on?.mental_models ?? [],
          directives: answer.based_on?.directives ?? [],
        },
      };
      delete response.delta_operations;
      if (trigger.response_schema) {
        const extracted = await this.reflector.structured(operation.bank, content, trigger.response_schema, operation.createdBy, asLocale(operation.locale));
        if (extracted.structured_output_error || !extracted.structured_output) throw new RefreshFailure('structured_output_failed', 'refresh_failed_structured_output', extracted.structured_output_error ?? 'Structured output extraction failed.');
        response.structured_output = extracted.structured_output;
        response.structured_output_error = null;
        if (response.usage && extracted.usage) response.usage = {
          input_tokens: response.usage.input_tokens + extracted.usage.input_tokens,
          output_tokens: response.usage.output_tokens + extracted.usage.output_tokens,
          total_tokens: response.usage.total_tokens + extracted.usage.total_tokens,
        };
      }
    } else {
      if (!content.trim()) throw new RefreshFailure('no_answer', 'refresh_failed_empty_candidate', 'The model returned an empty answer.');
      if (trigger.response_schema && (answer.structured_output_error || !answer.structured_output)) {
        throw new RefreshFailure('structured_output_failed', 'refresh_failed_structured_output', answer.structured_output_error ?? 'Structured output extraction failed.');
      }
    }
    if (!trigger.keep_trace) delete response.trace;
    const document = parseMentalModelDocument(content);
    await withSubjectLock(this.prisma, modelLock(model.id), async () => {
      const current = await this.prisma.memoryMentalModel.findUnique({ where: { id: model.id } });
      if (!current) throw new RefreshFailure('unexpected_error', 'refresh_failed_error', 'The mental model no longer exists.');
      if (current.content !== content) await this.history(current, current.content);
      await this.prisma.memoryMentalModel.update({
        where: { id: model.id },
        data: {
          content,
          structuredDoc: document as unknown as Prisma.InputJsonObject,
          reflectResponse: response as unknown as Prisma.InputJsonObject,
          refreshedSourceQuery: model.sourceQuery,
          lastRefreshedAt: new Date(),
          lastMemorySeenAt: latest.updatedAt,
          lastRefreshFailedAt: null,
          ...(mode === 'full' || !delta ? { lastFullRefreshedAt: new Date() } : {}),
        },
      });
    });
  }

  private scopeWhere(model: MemoryMentalModel, window?: { before: Date; after?: Date | null }): Prisma.MemoryUnitWhereInput {
    const trigger = mentalModelTriggerOutput(model.trigger);
    const match = trigger.tags_match ?? (model.tags.length ? 'all_strict' : 'any');
    return {
      workspaceId: model.workspaceId,
      bankId: model.bankId,
      ...(trigger.fact_types?.length ? { factType: { in: trigger.fact_types } } : {}),
      AND: [
        tagsWhere(model.tags, match),
        ...(window ? [{ updatedAt: { lte: window.before, ...(window.after ? { gt: window.after } : {}) } }] : []),
      ],
    };
  }

  private async staleness(models: MemoryMentalModel[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    for (const model of models) {
      const trigger = mentalModelTriggerOutput(model.trigger);
      const match = trigger.tags_match ?? (model.tags.length ? 'all_strict' : 'any');
      const scope = model.tags.length && !match.endsWith('_strict') && match !== 'exact'
        ? { tags: match.startsWith('all') ? { hasEvery: model.tags } : { hasSome: model.tags } }
        : tagsWhere(model.tags, match);
      const where: Prisma.MemoryUnitWhereInput = {
        bankId: model.bankId,
        ...(trigger.fact_types?.length ? { factType: { in: trigger.fact_types } } : {}),
        ...(model.lastMemorySeenAt ? { updatedAt: { gt: model.lastMemorySeenAt } } : {}),
        AND: [scope as Prisma.MemoryUnitWhereInput],
      };
      // ponytail: one EXISTS-equivalent read per listed model; batch these predicates if a bank gains hundreds of models
      out.set(model.id, Boolean(await this.prisma.memoryUnit.findFirst({ where, select: { id: true } })));
    }
    return out;
  }

  async afterConsolidation(bank: MemoryBank): Promise<void> {
    const models = await this.prisma.memoryMentalModel.findMany({ where: { bankId: bank.id, lastRefreshFailedAt: null } });
    const stale = await this.staleness(models);
    for (const model of models) {
      if (!mentalModelTriggerOutput(model.trigger).refresh_after_consolidation || !stale.get(model.id)) continue;
      await this.queue(model, { automatic: true }, AUTHOR_ID_STUB, 'en');
    }
  }

  async sweep(now = Date.now()): Promise<void> {
    if (this.features.unavailable().includes('memory')) return;
    const rows = await this.prisma.memoryMentalModel.findMany({ where: { lastRefreshFailedAt: null }, include: { bank: true } });
    const models = [];
    for (const model of rows) if (!(await this.features.disabled(model.workspaceId)).includes('memory')) models.push(model);
    const stale = await this.staleness(models);
    for (const model of models) {
      const trigger = mentalModelTriggerOutput(model.trigger);
      const full = trigger.mode === 'delta' && model.lastRefreshedAt && (!model.lastFullRefreshedAt || model.lastRefreshedAt > model.lastFullRefreshedAt) && cronDue(trigger.full_refresh_cron, now, model.lastFullRefreshedAt);
      const regular = cronDue(trigger.refresh_cron, now, model.lastRefreshedAt) && stale.get(model.id);
      if (full || regular) await this.queue(model, { mode: full ? 'full' : null, automatic: true }, AUTHOR_ID_STUB, 'en');
    }
    const due = await this.prisma.memoryOperation.findMany({ where: { status: 'queued', notBefore: { lte: new Date(now) }, type: { in: [...REFRESH_TYPES] } }, select: { id: true } });
    for (const operation of due) await this.enqueue(operation.id);
  }

  private response(bank: MemoryBank, row: MemoryMentalModel, detail: 'metadata' | 'content' | 'full', isStale: boolean): MentalModelResponse {
    const content = detail !== 'metadata';
    return {
      id: row.id,
      bank_id: bank.bankId,
      name: row.name,
      source_query: content ? row.sourceQuery : null,
      content: content ? row.content : null,
      tags: row.tags,
      max_tokens: content ? row.maxTokens : null,
      trigger: content ? mentalModelTriggerOutput(row.trigger) : null,
      last_refreshed_at: iso(row.lastRefreshedAt),
      last_memory_seen_at: iso(row.lastMemorySeenAt),
      last_refresh_failed_at: iso(row.lastRefreshFailedAt),
      last_full_refreshed_at: iso(row.lastFullRefreshedAt),
      created_at: row.createdAt.toISOString(),
      is_page: false,
      is_knowledge_page: false,
      reflect_response: detail === 'full' ? row.reflectResponse as Record<string, unknown> | null : null,
      is_stale: isStale,
    };
  }

  private async one(bank: MemoryBank, id: string): Promise<MemoryMentalModel> {
    const row = await this.prisma.memoryMentalModel.findFirst({ where: { id, workspaceId: bank.workspaceId, bankId: bank.id } });
    if (!row) throw new NotFoundException(t('error.memory.mentalModelNotFound', { id }));
    return row;
  }

  private validatedTrigger(patch: MentalModelTrigger, current: MentalModelTrigger): MentalModelTrigger {
    const merged = { ...current, ...patch };
    if (patch.refresh_after_consolidation === true && patch.refresh_cron === undefined) merged.refresh_cron = null;
    if (patch.refresh_cron && patch.refresh_after_consolidation === undefined) merged.refresh_after_consolidation = false;
    if (merged.refresh_after_consolidation && merged.refresh_cron) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'trigger', type: 'refresh_after_consolidation or refresh_cron, not both' }));
    for (const key of ['refresh_cron', 'full_refresh_cron'] as const) if (merged[key] && !parseCron(merged[key]!)) throw new BadRequestException(t('error.memory.configValueInvalid', { key: `trigger.${key}`, type: 'a valid five-field UTC cron expression' }));
    if (merged.response_schema && !validResponseSchema(merged.response_schema)) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'trigger.response_schema', type: 'an object schema with typed properties' }));
    if (merged.tag_groups?.length) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'trigger.tag_groups', type: 'null on this server; use tags and tags_match' }));
    return merged;
  }

  private async history(model: MemoryMentalModel, previousContent: string): Promise<void> {
    await this.prisma.memoryMentalModelHistory.create({ data: { workspaceId: model.workspaceId, bankId: model.bankId, modelId: model.id, previousContent } });
    await this.trimHistory(model.id, null);
  }

  private async trimHistory(modelId: string, kind: string | null): Promise<void> {
    const old = await this.prisma.memoryMentalModelHistory.findMany({ where: { modelId, kind }, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }], skip: 50, select: { id: true } });
    if (old.length) await this.prisma.memoryMentalModelHistory.deleteMany({ where: { id: { in: old.map((row) => row.id) } } });
  }

  private async enqueue(id: string): Promise<void> {
    await this.producer.enqueue(id).catch((error: Error) => this.logger.warn(`Memory operation ${id} not enqueued, the sweeper will: ${error.message}`));
  }

  private async enqueueNext(bankId: string, modelId: string): Promise<void> {
    const waiting = await this.prisma.memoryOperation.findMany({ where: { bankId, type: { in: [...REFRESH_TYPES] }, status: 'queued' }, orderBy: { createdAt: 'asc' } });
    const next = waiting.find((operation) => payloadOf(operation)?.mental_model_id === modelId && (!operation.notBefore || operation.notBefore <= new Date()));
    if (next) await this.enqueue(next.id);
  }
}
