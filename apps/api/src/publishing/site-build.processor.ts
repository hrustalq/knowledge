import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SITE_BUILD_QUEUE, type SiteBuildJob } from './site-build.constants.js';
import { SiteBuildService } from './site-build.service.js';

/** Worker half of site builds (docs/features/44). One build at a time: they are short and write in bulk. */
@Processor(SITE_BUILD_QUEUE)
export class SiteBuildProcessor extends WorkerHost {
  constructor(private readonly builds: SiteBuildService) {
    super();
  }

  async process(job: Job<SiteBuildJob>): Promise<void> {
    await this.builds.build(job.data.versionId);
  }
}
