import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EMBEDS_QUEUE, type EmbedSnapshotJob } from './embeds.constants.js';
import { EmbedSnapshotService } from './embed-snapshot.service.js';

/** Worker half of embeds (#470): one pinned item rendered per job. */
@Processor(EMBEDS_QUEUE)
export class EmbedsProcessor extends WorkerHost {
  constructor(private readonly snapshots: EmbedSnapshotService) {
    super();
  }

  async process(job: Job<EmbedSnapshotJob>): Promise<void> {
    await this.snapshots.render(job.data);
  }
}
