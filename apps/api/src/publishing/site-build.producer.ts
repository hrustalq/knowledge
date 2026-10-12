import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Env } from '../config/env.js';
import { SITE_BUILD_QUEUE, type SiteBuildJob } from './site-build.constants.js';

/**
 * Enqueue side of site builds (docs/features/44), imported by the API (a
 * person asked) and the worker (a page changed under a live version).
 *
 * One flight per version, by BullMQ deduplication on the version id:
 * - a change waits SITE_BUILD_DEBOUNCE_MS, and every change inside that window
 *   rides along with the build already waiting rather than queueing its own;
 * - a change that lands while a build runs leaves exactly one more build
 *   behind it (`keepLastIfActive`), so the snapshot catches up with it instead
 *   of missing it until the next edit.
 *
 * A request from a person skips the wait: if a debounced build is already
 * waiting, it is promoted rather than queued twice.
 *
 * Never throws into its caller (the `MailProducer` contract). A version whose
 * build could not be queued says `building` until the worker's boot-time
 * requeue picks it up.
 */
@Injectable()
export class SiteBuildProducer {
  private readonly logger = new Logger(SiteBuildProducer.name);
  private readonly debounceMs: number;

  constructor(
    @InjectQueue(SITE_BUILD_QUEUE) private readonly queue: Queue<SiteBuildJob>,
    config: ConfigService<Env, true>,
  ) {
    this.debounceMs = config.get('SITE_BUILD_DEBOUNCE_MS', { infer: true });
  }

  /** `now` for a person's request; otherwise the debounce applies. */
  async enqueue(versionId: string, opts: { now?: boolean } = {}): Promise<void> {
    try {
      const job = await this.queue.add(
        'build',
        { versionId },
        {
          deduplication: { id: `site-build-${versionId}`, keepLastIfActive: true },
          delay: opts.now ? 0 : this.debounceMs,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: true,
          removeOnFail: { age: 7 * 86_400 },
        },
      );
      if (opts.now && job.id) {
        // Deduplicated into a build that is still sitting out its debounce:
        // run that one now instead.
        const existing = await this.queue.getJob(job.id);
        if (existing && (await existing.isDelayed())) await existing.promote();
      }
    } catch (e) {
      this.logger.warn(`Site build enqueue failed (non-fatal, version ${versionId}): ${(e as Error).message}`);
    }
  }
}
