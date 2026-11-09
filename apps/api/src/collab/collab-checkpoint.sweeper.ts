import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { StorageService } from '../storage/storage.service.js';
import { CollabDraftsService } from './collab-drafts.service.js';
import { Ticker } from '../common/ticker.js';

/** Checkpoints are minutes apart; a minute of slack on when one is due costs nothing. */
const SWEEP_INTERVAL_MS = 60_000;
const BATCH = 50;

/** One key per draft: the versioned bucket keeps each checkpoint as a version of it, pruned to COLLAB_CHECKPOINT_KEEP. */
export function checkpointKey(workspaceId: string, documentId: string, branchId: string): string {
  return `workspaces/${workspaceId}/documents/${documentId}/drafts/${branchId}/checkpoint.ydoc`;
}

/**
 * Copies each shared draft edited since its last checkpoint to MinIO, at most
 * every COLLAB_CHECKPOINT_INTERVAL_MINUTES (#80). PG holds the hot state;
 * this is what a bad write is recovered from. Also drops drafts with nothing
 * unpublished after COLLAB_DRAFT_RETENTION_DAYS.
 *
 * API-side next to the gateway, a due check inside a fixed tick with no
 * second sweep while one runs (the repo has no cron). Each checkpoint is
 * claimed with one guarded statement, so several API instances sweeping at
 * once write it once. Off with COLLAB_ENABLED.
 */
@Injectable()
export class CollabCheckpointSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CollabCheckpointSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly drafts: CollabDraftsService,
    private readonly storage: StorageService,
    private readonly events: EventsPublisher,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('COLLAB_ENABLED', { infer: true })) return;
    this.ticker.every(SWEEP_INTERVAL_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      const due = await this.drafts.dueForCheckpoint(this.config.get('COLLAB_CHECKPOINT_INTERVAL_MINUTES', { infer: true }), BATCH);
      for (const draft of due) {
        const state = await this.drafts.claimCheckpoint(draft.id, draft.last_checkpoint_at);
        if (!state) continue;
        const key = checkpointKey(draft.workspace_id, draft.document_id, draft.branch_id);
        await this.storage.putObjectBytes(key, state, 'application/octet-stream');
        await this.storage.pruneObjectVersions(key, this.config.get('COLLAB_CHECKPOINT_KEEP', { infer: true }));
        // Contributors moved since the last one: the "unpublished by" badges re-ask.
        await this.events.publish({
          type: 'draft.changed',
          workspaceId: draft.workspace_id,
          documentId: draft.document_id,
          subjectId: draft.branch_id,
        });
      }
      const dropped = await this.drafts.dropIdle(this.config.get('COLLAB_DRAFT_RETENTION_DAYS', { infer: true }));
      if (dropped > 0) this.logger.log(`dropped ${dropped} idle shared drafts`);
    });
  }
}
