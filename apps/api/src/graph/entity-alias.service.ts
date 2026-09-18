import { Injectable } from '@nestjs/common';
import { normalizeEntityKey } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';

/** How long a workspace's alias table is trusted without re-reading it. */
const TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  aliases: Map<string, string>;
}

/**
 * A workspace's canonical spelling for an entity key (docs/features/28).
 *
 * `normalizeEntityKey` folds case and Unicode, so `Сервис:Биллинг` and
 * `сервис:биллинг` were already one vertex before this existed. What folding
 * cannot do is know that `сервис:биллинг` and `service:billing` name the same
 * service — that is the workspace's own vocabulary, and in a ru + en corpus it
 * is the difference between one graph and two disconnected halves.
 *
 * Lives in GraphModule rather than EntitiesModule on purpose: EntitiesModule
 * carries a controller, so it pulls AccessService and the global AuthModule and
 * must never load in the worker — and the worker is exactly where ingestion
 * resolves keys. It needs only PrismaService, which is @Global.
 *
 * Resolution is one hop by construction (see `create`), so there is no loop and
 * no cycle guard here.
 */
@Injectable()
export class EntityAliasService {
  /**
   * The whole alias table per workspace, not per key.
   *
   * Ingestion resolves once per fact and a revision carries many, so a
   * per-key query would be N round trips for a table of a few rows. Same
   * scale assumption the tree layer already makes. A second API instance can
   * serve a stale table for up to the TTL; that is the deliberate cost, as it
   * is in AiConfigService.
   */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /** The canonical key for `raw`, or its folded self when nothing claims it. */
  async resolve(workspaceId: string, raw: string): Promise<string> {
    const key = normalizeEntityKey(raw);
    const aliases = await this.aliasesFor(workspaceId);
    return aliases.get(key) ?? key;
  }

  /** Resolve a batch against one cache read. */
  async resolveAll(workspaceId: string, raw: string[]): Promise<string[]> {
    const aliases = await this.aliasesFor(workspaceId);
    return raw.map((r) => {
      const key = normalizeEntityKey(r);
      return aliases.get(key) ?? key;
    });
  }

  async list(workspaceId: string): Promise<Array<{ alias: string; canonicalKey: string; source: string }>> {
    return this.prisma.entityAlias.findMany({
      where: { workspaceId },
      select: { alias: true, canonicalKey: true, source: true },
      orderBy: [{ canonicalKey: 'asc' }, { alias: 'asc' }],
    });
  }

  /**
   * Declare `alias` to mean `canonicalKey`, if that keeps resolution one hop.
   *
   * A single guarded INSERT, per the house idempotency rule. The first
   * disjunct refuses `a → b` where `b` is itself somebody's alias; the second
   * refuses it where `a` is already somebody's canonical, which would strand
   * that entry's aliases. With chains impossible, `resolve` needs no loop.
   *
   * Returns false when the guard refused, so the caller can say why rather
   * than reporting a silent success.
   */
  async create(input: {
    workspaceId: string;
    alias: string;
    canonicalKey: string;
    source?: string;
    createdBy?: string | null;
  }): Promise<boolean> {
    const alias = normalizeEntityKey(input.alias);
    const canonicalKey = normalizeEntityKey(input.canonicalKey);
    if (!alias || !canonicalKey || alias === canonicalKey) return false;

    const written = await this.prisma.$executeRaw`
      INSERT INTO "entity_aliases" ("id", "workspace_id", "alias", "canonical_key", "source", "created_by")
      SELECT gen_random_uuid(), ${input.workspaceId}::uuid, ${alias}, ${canonicalKey},
             ${input.source ?? 'manual'}, ${input.createdBy ?? null}::uuid
       WHERE NOT EXISTS (
         SELECT 1 FROM "entity_aliases"
          WHERE "workspace_id" = ${input.workspaceId}::uuid
            AND ("alias" = ${canonicalKey} OR "canonical_key" = ${alias})
       )
       ON CONFLICT ("workspace_id", "alias") DO NOTHING`;


    this.cache.delete(input.workspaceId);
    return written > 0;
  }

  async remove(workspaceId: string, alias: string): Promise<void> {
    await this.prisma.entityAlias.deleteMany({
      where: { workspaceId, alias: normalizeEntityKey(alias) },
    });
    this.cache.delete(workspaceId);
  }

  private async aliasesFor(workspaceId: string): Promise<Map<string, string>> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.aliases;

    const rows = await this.prisma.entityAlias.findMany({
      where: { workspaceId },
      select: { alias: true, canonicalKey: true },
    });
    const aliases = new Map(rows.map((r) => [r.alias, r.canonicalKey]));
    this.cache.set(workspaceId, { at: Date.now(), aliases });
    return aliases;
  }
}
