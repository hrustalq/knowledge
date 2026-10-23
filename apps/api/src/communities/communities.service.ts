import { Inject, Injectable } from '@nestjs/common';
import type { CommunitySummaryDto } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';

/**
 * Communities of pages (#81, phase 7), as readers get them: the Ask's
 * `global_overview` tool, the MCP tool and the graph's colouring all read
 * through here, under the reader's scope. A community whose pages are not
 * all open to the reader is withheld whole — its summary was written from
 * every one of them (#76), and at the levels above from summaries that were
 * (#475).
 */
@Injectable()
export class CommunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {}

  /**
   * The communities of one level (0 = finest, today's single level before
   * #475) closest to `query` — all of them, largest first, without one.
   */
  async overview(scope: AccessScope, query: string | undefined, limit: number, level = 0): Promise<CommunitySummaryDto[]> {
    const embedding = query?.trim() ? await this.embeddings.embed(query.trim()) : undefined;
    const { rows: all, visible } = await this.readable(scope, embedding);
    const rows = all.filter((r) => r.level === level);
    const ordered = embedding ? rows : [...rows].sort((a, b) => b.members.length - a.members.length);
    return ordered.slice(0, limit).map((r) => ({
      communityId: r.communityId,
      level: r.level,
      parentId: r.parentId,
      title: r.title,
      summary: r.summary,
      documents: r.members.map((id) => ({ documentId: id, title: visible.get(id)! })),
      builtAt: new Date(r.builtAt).toISOString(),
      score: Number(Math.max(0, r.score).toFixed(4)),
    }));
  }

  /** Page → level-0 community, for colouring the graph. Only communities the reader may see whole. */
  async membership(scope: AccessScope): Promise<Map<string, string>> {
    const { rows } = await this.readable(scope);
    return new Map(rows.filter((r) => r.level === 0).flatMap((r) => r.members.map((m) => [m, r.communityId] as const)));
  }

  /**
   * The stored communities the reader may see whole, and their pages' titles.
   * PG decides. `members` is every page beneath a community (#475), so an
   * ancestor of a withheld community is withheld by the same check.
   */
  private async readable(scope: AccessScope, embedding?: number[]) {
    const all = await this.graph.communities(scope.workspaceId, () => true, embedding);
    const ids = [...new Set(all.flatMap((r) => r.members))];
    const docs = ids.length
      ? await this.prisma.document.findMany({
          where: { id: { in: ids }, workspaceId: scope.workspaceId, AND: [visibilityWhere(scope)] },
          select: { id: true, title: true },
        })
      : [];
    const visible = new Map(docs.map((d) => [d.id, d.title]));
    return { rows: all.filter((r) => r.members.every((m) => visible.has(m))), visible };
  }
}
