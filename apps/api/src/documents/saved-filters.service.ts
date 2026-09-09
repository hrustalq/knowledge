import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ListSavedFiltersResponse,
  SavedFilter,
  SavedFilterQuery,
} from '@knowledge/contracts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';
import type { Principal } from '../auth/principal.js';
import type { CreateSavedFilterDto, UpdateSavedFilterDto } from './dto/saved-filters.dto.js';

/**
 * Saved merge-request filters: a named narrowing of GET /v1/merge-requests,
 * stored so it outlives the session that built it.
 *
 * Views are private to their owner, which is why every read is scoped by
 * ownerId rather than by workspace alone, and why a view belonging to someone
 * else 404s rather than 403s — a private row should not confirm it exists.
 * The AclGuard has already checked that the caller is a viewer of the owning
 * workspace, so losing membership takes the view with it.
 */
@Injectable()
export class SavedFiltersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, principal: Principal): Promise<ListSavedFiltersResponse> {
    const rows = await this.prisma.savedFilter.findMany({
      where: { workspaceId, ownerId: principal.userId },
      orderBy: { name: 'asc' },
    });
    return { workspaceId, filters: rows.map(toSavedFilter) };
  }

  async get(id: number, principal: Principal): Promise<SavedFilter> {
    return toSavedFilter(await this.require(id, principal));
  }

  async create(dto: CreateSavedFilterDto, principal: Principal): Promise<SavedFilter> {
    try {
      const row = await this.prisma.savedFilter.create({
        data: {
          workspaceId: dto.workspaceId,
          ownerId: principal.userId,
          name: dto.name.trim(),
          query: normalizeQuery(dto.query) as unknown as Prisma.InputJsonValue,
        },
      });
      return toSavedFilter(row);
    } catch (err) {
      throw this.rethrowDuplicate(err, dto.name.trim());
    }
  }

  async update(id: number, dto: UpdateSavedFilterDto, principal: Principal): Promise<SavedFilter> {
    const existing = await this.require(id, principal);
    try {
      const row = await this.prisma.savedFilter.update({
        where: { id: existing.id },
        data: {
          ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
          ...(dto.query === undefined
            ? {}
            : { query: normalizeQuery(dto.query) as unknown as Prisma.InputJsonValue }),
        },
      });
      return toSavedFilter(row);
    } catch (err) {
      throw this.rethrowDuplicate(err, dto.name?.trim() ?? existing.name);
    }
  }

  async remove(id: number, principal: Principal): Promise<{ deleted: true }> {
    const existing = await this.require(id, principal);
    await this.prisma.savedFilter.delete({ where: { id: existing.id } });
    return { deleted: true };
  }

  /** Owner check lives here, not in the guard: the guard knows workspaces, not rows. */
  private async require(id: number, principal: Principal) {
    const row = await this.prisma.savedFilter.findUnique({ where: { id } });
    // The dev principal (AUTH_MODE=none) owns every row it can reach, the same
    // trust it gets everywhere else — otherwise nothing saved before a login
    // would ever be reachable again in dev.
    const mine = row && (principal.mode === 'dev' || row.ownerId === principal.userId);
    if (!mine) throw new NotFoundException(t('error.savedFilter.notFound', { id }));
    return row;
  }

  private rethrowDuplicate(err: unknown, name: string): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException(t('error.savedFilter.duplicate', { name }));
    }
    return err;
  }
}

/**
 * Stored shape is the wire shape, with one guard: the chip list is rebuilt
 * rather than trusted, so a row written by an older client (or by hand) cannot
 * put a non-array where the bar expects one.
 */
function normalizeQuery(query: SavedFilterQuery): SavedFilterQuery {
  const chips = Array.isArray(query?.chips) ? query.chips : [];
  return {
    ...(query?.status ? { status: query.status } : {}),
    ...(query?.search ? { search: query.search } : {}),
    chips: chips.map((chip) => ({
      key: String(chip.key),
      operator: String(chip.operator),
      values: (Array.isArray(chip.values) ? chip.values : []).map(String),
    })),
  };
}

function toSavedFilter(row: {
  id: number;
  workspaceId: string;
  ownerId: string;
  name: string;
  query: unknown;
  createdAt: Date;
  updatedAt: Date;
}): SavedFilter {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerId: row.ownerId,
    name: row.name,
    query: normalizeQuery((row.query ?? { chips: [] }) as SavedFilterQuery),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
