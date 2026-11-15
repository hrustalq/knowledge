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

/** Directive tags select a reflect scope. Untagged directives are global. */
export function directiveMatches(
  directiveTags: string[],
  reflectTags: string[] | undefined,
  match: TagsMatch = 'any',
): boolean {
  const wanted = cleanTags(directiveTags);
  if (!wanted.length) return true;
  const scope = cleanTags(reflectTags);
  if (match === 'exact') return JSON.stringify(wanted) === JSON.stringify(scope);
  return match.startsWith('all')
    ? wanted.every((tag) => scope.includes(tag))
    : wanted.some((tag) => scope.includes(tag));
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

  /** Active rules in this already ACL-resolved bank, highest priority first. */
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
    return query.applyAllDirectives
      ? rows
      : rows.filter((row) =>
          directiveMatches(row.tags, query.tags, query.tagsMatch),
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
