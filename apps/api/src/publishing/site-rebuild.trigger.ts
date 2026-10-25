import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import type { KnowledgeEvent } from '@knowledge/contracts';
import { EventsSubscriber } from '../events/events.subscriber.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SiteAudienceStamper } from './site-audience.stamper.js';
import { SiteBuildProducer } from './site-build.producer.js';

/**
 * Events that can change what a live site version should show
 * (docs/features/44): a revision becoming publishable (an edit, a merge, a
 * reindex), and a page being renamed, moved, reordered, archived or brought
 * back. Merges need no event of their own: the merge revision reaches
 * `indexed` like any other.
 */
export const SITE_REBUILD_EVENTS: ReadonlySet<string> = new Set([
  'revision.indexed',
  'document.updated',
  'document.archived',
  'document.unarchived',
  // A private draft opened to the workspace (#474) enters the project's sites.
  'document.published',
]);

/**
 * Keeps `live` versions following their branch (docs/features/44). Runs in
 * the worker beside the processor: it only reads and enqueues, and the
 * producer's debounce turns a burst of edits into one build.
 *
 * A page's versions are found two ways, because each alone misses a case:
 * the live versions of its project's site (a page that is new, or was moved
 * in), and the live versions that already publish it (a page moved out to
 * another project must leave the old site too). Frozen versions are never
 * touched — that is what frozen means.
 *
 * Who may read a page is another matter (issue #77 phase 3): audience rules
 * fold down `documents.path`, so a page that moved may have moved under a
 * rule, or out from under one. Every site that publishes it, frozen versions
 * included, is restamped at once rather than at its next build.
 */
@Injectable()
export class SiteRebuildTrigger implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(SiteRebuildTrigger.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsSubscriber,
    private readonly producer: SiteBuildProducer,
    private readonly audiences: SiteAudienceStamper,
  ) {}

  onModuleInit(): void {
    this.events.all().subscribe((event) => {
      void this.handle(event).catch((e: Error) => this.logger.warn(`Site rebuild trigger failed (non-fatal): ${e.message}`));
    });
  }

  /**
   * Crash recovery: a version that says `building` when the worker starts has
   * a build that was lost with Redis, or was never queued. Deduplication makes
   * a requeue of one that is still queued a no-op.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const stuck = await this.prisma.siteVersion.findMany({ where: { status: 'building' }, select: { id: true } });
      for (const { id } of stuck) await this.producer.enqueue(id, { now: true });
    } catch (e) {
      this.logger.warn(`Site build requeue failed (non-fatal): ${(e as Error).message}`);
    }
  }

  async handle(event: KnowledgeEvent): Promise<void> {
    if (!event.documentId || !SITE_REBUILD_EVENTS.has(event.type)) return;
    const document = await this.prisma.document.findUnique({
      where: { id: event.documentId },
      select: { workspaceId: true, projectId: true },
    });
    const live = { kind: 'live' };
    const [byProject, byPage] = await Promise.all([
      document && document.workspaceId === event.workspaceId
        ? this.prisma.siteVersion.findMany({
            where: { ...live, site: { projectId: document.projectId } },
            select: { id: true },
          })
        : Promise.resolve([]),
      this.prisma.siteVersion.findMany({
        where: { ...live, pages: { some: { documentId: event.documentId } } },
        select: { id: true },
      }),
    ]);
    const ids = new Set([...byProject, ...byPage].map((v) => v.id));
    for (const id of ids) await this.producer.enqueue(id);
    if (event.type === 'document.updated') await this.restamp(event.documentId);
  }

  /** Restamp the sites that publish this page and have any audience rule; a site without rules has nothing to move under. */
  private async restamp(documentId: string): Promise<void> {
    const sites = await this.prisma.publishedSite.findMany({
      where: { audienceRules: { some: {} }, versions: { some: { pages: { some: { documentId } } } } },
      select: { id: true },
    });
    for (const site of sites) await this.audiences.restamp(site.id);
  }
}
