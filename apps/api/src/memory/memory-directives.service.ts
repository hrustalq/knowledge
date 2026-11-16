import { Injectable, NotFoundException } from '@nestjs/common';
import type { MemoryBank, MemoryDirective, Prisma } from '@prisma/client';
import { UUID_RE } from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { cleanTags, type TagsMatch } from './memory-facts.js';
import type {
  CreateDirectiveDto,
  ListDirectivesQueryDto,
  UpdateDirectiveDto,
} from './memory.dto.js';
import type {
  DeleteResponse,
  DirectiveListResponse,
  DirectiveResponse,
} from './memory-wire.js';

/**
 * Directive tags select a reflect scope, matched as the reference server matches them (#1166,
 * `list_directives` in Hindsight's memory engine): an untagged directive always applies; a tagged
 * one never applies to an untagged reflect, and otherwise its tags are filtered by the request's
 * tags exactly as a memory's are — `all` wants the directive to carry every requested tag (`@>`),
 * `any` one of them (`&&`), `exact` the same set.
 */
export function directiveMatches(
  directiveTags: string[],
  reflectTags: string[] | undefined,
  match: TagsMatch = 'any',
): boolean {
  const own = cleanTags(directiveTags);
  if (!own.length) return true;
  const requested = cleanTags(reflectTags);
  if (!requested.length) return false;
  if (match === 'exact') return JSON.stringify(own) === JSON.stringify(requested);
  return match.startsWith('all')
    ? requested.every((tag) => own.includes(tag))
    : requested.some((tag) => own.includes(tag));
}

export function directiveResponse(
  bank: MemoryBank,
  row: MemoryDirective,
): DirectiveResponse {
  return {
    id: row.id,
    bank_id: bank.bankId,
    name: row.name,
    content: row.content,
    priority: row.priority,
    is_active: row.isActive,
    tags: row.tags,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Characters of directive name + content one reflect applies. One directive
 * (20 000 content + 200 name) always fits; past the budget, lower priorities drop.
 */
export const DIRECTIVE_CHAR_BUDGET = 24_000;

/** The highest-priority prefix of `rows` (already ordered) that fits the budget. */
export function withinDirectiveBudget<T extends Pick<MemoryDirective, 'name' | 'content'>>(rows: T[], budget = DIRECTIVE_CHAR_BUDGET): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const row of rows) {
    used += row.name.length + row.content.length;
    if (used > budget) break;
    kept.push(row);
  }
  return kept;
}

const ORDER: Prisma.MemoryDirectiveOrderByWithRelationInput[] = [
  { priority: 'desc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

@Injectable()
export class MemoryDirectivesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    bank: MemoryBank,
    dto: CreateDirectiveDto,
  ): Promise<DirectiveResponse> {
    const row = await this.prisma.memoryDirective.create({
      data: {
        workspaceId: bank.workspaceId,
        bankId: bank.id,
        name: dto.name.trim(),
        content: dto.content.trim(),
        priority: dto.priority ?? 0,
        isActive: dto.is_active ?? true,
        tags: cleanTags(dto.tags),
      },
    });
    return directiveResponse(bank, row);
  }

  async list(
    bank: MemoryBank,
    query: ListDirectivesQueryDto,
  ): Promise<DirectiveListResponse> {
    const rows = await this.prisma.memoryDirective.findMany({
      where: {
        workspaceId: bank.workspaceId,
        bankId: bank.id,
        ...(query.active_only ? { isActive: true } : {}),
      },
      orderBy: ORDER,
    });
    const matching = query.tags?.length
      ? rows.filter((row) =>
          directiveMatches(row.tags, query.tags, query.tags_match),
        )
      : rows;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    return {
      items: matching
        .slice(offset, offset + limit)
        .map((row) => directiveResponse(bank, row)),
      total: matching.length,
      limit,
      offset,
    };
  }

  async get(bank: MemoryBank, id: string): Promise<DirectiveResponse> {
    return directiveResponse(bank, await this.one(bank, id));
  }

  async update(
    bank: MemoryBank,
    id: string,
    dto: UpdateDirectiveDto,
  ): Promise<DirectiveResponse> {
    await this.one(bank, id);
    const row = await this.prisma.memoryDirective.update({
      where: { id, workspaceId: bank.workspaceId, bankId: bank.id },
      data: {
        ...(typeof dto.name === 'string' ? { name: dto.name.trim() } : {}),
        ...(typeof dto.content === 'string'
          ? { content: dto.content.trim() }
          : {}),
        ...(typeof dto.priority === 'number'
          ? { priority: dto.priority }
          : {}),
        ...(typeof dto.is_active === 'boolean'
          ? { isActive: dto.is_active }
          : {}),
        ...(Array.isArray(dto.tags) ? { tags: cleanTags(dto.tags) } : {}),
      },
    });
    return directiveResponse(bank, row);
  }

  async delete(bank: MemoryBank, id: string): Promise<DeleteResponse> {
    const deleted = UUID_RE.test(id)
      ? await this.prisma.memoryDirective.deleteMany({
          where: { id, workspaceId: bank.workspaceId, bankId: bank.id },
        })
      : { count: 0 };
    if (!deleted.count)
      throw new NotFoundException(t('error.memory.directiveNotFound', { id }));
    return { success: true, message: null, deleted_count: deleted.count };
  }

  /** Active rules in this already ACL-resolved bank, highest priority first, within `DIRECTIVE_CHAR_BUDGET`. */
  async forReflect(
    bank: MemoryBank,
    query: {
      tags?: string[];
      tagsMatch?: TagsMatch;
      applyAllDirectives?: boolean;
    },
  ): Promise<MemoryDirective[]> {
    const rows = await this.prisma.memoryDirective.findMany({
      where: {
        workspaceId: bank.workspaceId,
        bankId: bank.id,
        isActive: true,
      },
      orderBy: ORDER,
    });
    return withinDirectiveBudget(
      query.applyAllDirectives
        ? rows
        : rows.filter((row) =>
            directiveMatches(row.tags, query.tags, query.tagsMatch),
          ),
    );
  }

  private async one(bank: MemoryBank, id: string): Promise<MemoryDirective> {
    const row = UUID_RE.test(id)
      ? await this.prisma.memoryDirective.findFirst({
          where: { id, workspaceId: bank.workspaceId, bankId: bank.id },
        })
      : null;
    if (!row)
      throw new NotFoundException(t('error.memory.directiveNotFound', { id }));
    return row;
  }
}
