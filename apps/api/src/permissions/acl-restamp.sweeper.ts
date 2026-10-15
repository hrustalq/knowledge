import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import { FULLTEXT_PROVIDER, type FulltextProvider } from '../fulltext/fulltext.provider.js';

/**
 * Copies a page's restrictions onto its search-store stamps (#76).
 *
 * Every write to `documents.restricted_by` bumps `acl_version`; this tick finds
 * the pages whose `acl_stamped_version` lags, rewrites `aclNodes` on their
 * ArcadeDB vertices and OpenSearch rows, and records the version it stamped.
 * Stamps only — nothing is re-chunked or re-embedded.
 *
 * Staleness is safe by construction: every read decides visibility from PG
 * (`DocumentAclFilter`, then the search post-filter), and the stamps are only
 * the prefilter OpenSearch falls back to past `ACL_DENY_LIST_MAX`. A lagging
 * stamp can cost recall for one tick; it cannot show a page.
 *
 * Worker-only, a fixed tick with back-pressure — there is no cron here.
 */
@Injectable()
export class AclRestampSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AclRestampSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Inject(FULLTEXT_PROVIDER) private readonly fulltext: FulltextProvider,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), this.config.get('ACL_RESTAMP_TICK_MS', { infer: true }));
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One tick. Returns how many pages it stamped. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let stamped = 0;
    try {
      const batch = this.config.get('ACL_RESTAMP_BATCH', { infer: true });
      const due = await this.prisma.$queryRaw<
        Array<{ id: string; workspace_id: string; restricted_by: string[]; acl_version: number }>
      >`SELECT "id", "workspace_id", "restricted_by", "acl_version" FROM "documents"
         WHERE "acl_stamped_version" < "acl_version"
         ORDER BY "acl_version" - "acl_stamped_version" DESC
         LIMIT ${batch}`;
      for (const doc of due) {
        try {
          await this.graph.restampDocument(doc.workspace_id, doc.id, doc.restricted_by);
          if (this.fulltext.enabled) await this.fulltext.restamp(doc.workspace_id, doc.id, doc.restricted_by);
          // Guarded on the version stamped: a change that landed meanwhile
          // keeps the page due, and the next tick stamps that one.
          const { count } = await this.prisma.document.updateMany({
            where: { id: doc.id, aclVersion: doc.acl_version },
            data: { aclStampedVersion: doc.acl_version },
          });
          stamped += count;
        } catch (e) {
          this.logger.warn(`ACL re-stamp failed for document ${doc.id}; retrying next tick: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.logger.warn(`ACL re-stamp sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return stamped;
  }
}
