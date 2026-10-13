import { OnApplicationBootstrap } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import type { Env } from '../config/env.js';
import { EXPORT_QUEUE, type ExportQueueJob } from './export.constants.js';
import { ExportBuildService } from './export-build.service.js';

/**
 * Worker half of exports (docs/features/45). EXPORT_CONCURRENCY builds run at
 * once: a PDF holds a Gotenberg Chromium for its whole render, and every
 * build holds its sources and attachments in memory.
 */
@Processor(EXPORT_QUEUE)
export class ExportProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly builds: ExportBuildService,
    private readonly config: ConfigService<Env, true>,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    // The decorator's options are static; the worker exists by now.
    this.worker.concurrency = this.config.get('EXPORT_CONCURRENCY', { infer: true });
  }

  async process(job: Job<ExportQueueJob>): Promise<void> {
    await this.builds.build(job.data.exportId);
  }
}
