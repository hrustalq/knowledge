import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { KnowledgeEvent } from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import { EventsSubscriber } from '../../events/events.subscriber.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RepoGuidanceService } from './repo-guidance.service.js';

/**
 * Re-reads a repository's guidance files after each successful sync (#70).
 *
 * API-side — `ConnectorsModule` is never loaded by the worker — because the
 * import writes configuration attributed to a person. Redis pub/sub is lossy:
 * a sync that finishes while the API is down is not re-read until the next
 * one, or until an admin presses Import on the connector page. Nothing is lost
 * by that but freshness; the import is idempotent and keeps no cursor.
 */
@Injectable()
export class RepoGuidanceListener implements OnModuleInit {
  private readonly logger = new Logger(RepoGuidanceListener.name);
  private readonly enabled: boolean;

  constructor(
    private readonly events: EventsSubscriber,
    private readonly prisma: PrismaService,
    private readonly guidance: RepoGuidanceService,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('REPO_GUIDANCE_IMPORT_ENABLED', { infer: true });
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.events.all().subscribe((event) => {
      void this.handle(event).catch((e: Error) => this.logger.warn(`Guidance import failed (non-fatal): ${e.message}`));
    });
  }

  async handle(event: KnowledgeEvent): Promise<void> {
    if (event.type !== 'connector.run.succeeded' || !event.subjectId) return;
    // The kind first, from PG: every connector sync announces itself here, and
    // only a repository's is worth an archive download.
    const row = await this.prisma.connector.findUnique({
      where: { id: event.subjectId },
      select: { kind: true, enabled: true, workspaceId: true },
    });
    if (!row || !row.enabled || row.workspaceId !== event.workspaceId || !this.guidance.isRepository(row)) return;
    await this.guidance.importFrom(event.subjectId);
  }
}
